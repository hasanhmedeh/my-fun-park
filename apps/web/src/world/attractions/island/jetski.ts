import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shadowed, std, type Attraction, type Ctx } from '../../context';
import { SEA_Y } from '../../geo';
import type { Input } from '../../input';
import { waveY } from '../../sea';
import { canvasTex, hdr, PALETTE, signTexture } from '../../textures';
import { COURSE, coursePoint, GATE_HALF, GATES, headingOf, LAPS, RAMPS, START_S, WALL } from './jetski-course';
import { Dock, HEAD, MOORINGS, SPECTATOR_SPOTS } from './jetski-dock';
import { Spray, Wakes } from './jetski-fx';
import { archGeometry, BUOY_H, buoyBody, buoyTrim, rampGeometry, rampTexture, riderGeometry, SADDLE, skiGeometry, spectatorBody, spectatorHead } from './jetski-models';
import { forwardSpeed, VMAX, type Craft } from './jetski-physics';
import { aiControls, collideRacers, MISS_PENALTY, newRacer, standings, stepRacer, toGhost, toGrid, VTOP, type RaceEvents, type Racer } from './jetski-race';
import { rivalRiderLooks, Rider, riderColours, visitorRiderLook, type RiderColours } from './jetski-riders';
import type { PeopleFactory } from '../../crowd/people-factory';
import { lookKey, type Look } from '../../crowd/looks';
import './jetski.css';

/** The T-head's middle, where the dock's crowd stands: for their cheering and the idle focus. */
const DOCK_X = (HEAD.x0 + HEAD.x1) / 2;
const DOCK_Z = (HEAD.z0 + HEAD.z1) / 2;

// The Jet-Ski Race on Palm Cay: three laps of a buoy course in the lagoon off the south beach
// against four rivals, from a standing start under the inflatable arch in front of the dock.
// Ride between each pair of buoys (red to your left, yellow to your right; miss one and it's three
// seconds on your time), take the two floating kickers for air, and land flat (off the throttle)
// to fill the surf meter that feeds the boost. Wakes are real: cross one at speed and it bounces
// you up. The skis ride the sea surface itself (waveY) on arcade-but-boaty physics
// (jetski-physics.ts); the race's rules and the rivals' riding are pure maths too
// (jetski-race.ts), so the whole race also runs in node (scripts/jetski-check.mjs). While nobody's
// racing, the rivals lap the course for the beach to watch.

const GRID_TIME = 3.6; // lights out after this long on the grid
const COOLDOWN = 6; // seconds after the line before you're back on the beach
const BURST = 1.3; // seconds of boost a tap of the action button burns
const STORAGE_KEY = 'fair-jetski';
const ROPE = '#d9cfb4';
const LAMP_OFF = hdr('#3a1418', 1);
const LAMP_RED = hdr('#ff2a2a', 6);
const LAMP_GO = hdr('#39ff7a', 6);

type Cam = 'chase' | 'pov' | 'high';
const CAM_LABEL: Record<Cam, string> = { chase: 'Chase', pov: 'Rider', high: 'High' };
export type Phase = 'idle' | 'grid' | 'race' | 'done';

const RIVALS = [
  { name: 'Coral Kai', color: PALETTE.teal, helmet: '#ffffff', skill: 0.97, jumper: true },
  { name: 'Reef Rosa', color: PALETTE.mustard, helmet: '#1d1238', skill: 0.94, jumper: false },
  { name: 'Splash Sami', color: PALETTE.violet, helmet: '#ffd23f', skill: 0.91, jumper: true },
  { name: 'Tidal Theo', color: PALETTE.orange, helmet: '#2ec4b6', skill: 0.88, jumper: true },
];
const YOU = { color: PALETTE.candy, helmet: '#ffffff' };

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};
const ordinal = (n: number) => (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

/** A racer's model: the ski (hull and rider) and what animates on it. */
interface Rig {
  root: THREE.Group;
  /** The seat frame on the saddle (leaned and bobbed by the race): the rider sits in it. */
  rider: THREE.Group;
  /** The merged stand-in figure: the rider until the people have loaded, and far away after. */
  far: THREE.Mesh;
  /** The rider as a real person (once `setPeople` has run). */
  body: Rider | null;
  /** Spray to emit (fractional drops carried over between frames). */
  tail: number;
  bow: number;
  /** The rider's lean, eased (they hang off the inside more than the hull leans). */
  lean: number;
}

/**
 * The race's own HUD (inside #hud, before the cards), built in the race HUD's shape and classes so
 * it sits and scales like the Turbo Speedway's: place, lap, the surf meter, time / best / speed,
 * the standings and the keys.
 */
function buildHud(hud: HTMLElement) {
  const el = document.createElement('div');
  el.id = 'js-hud';
  el.className = 'ride-hud race-hud js-hud';
  el.hidden = true;
  el.innerHTML = `
    <div class="rc-top">
      <p class="rc-pos"><b id="js-pos">5</b><sup id="js-pos-suf">th</sup><span>/ 5</span></p>
      <p class="rc-lap"><span>Lap</span><b id="js-lap">1/${LAPS}</b></p>
    </div>
    <div class="rc-nitro js-surf">
      <span>Surf</span>
      <div class="dh-bar" id="js-surf" aria-hidden="true"><i></i></div>
    </div>
    <dl class="rh-stats">
      <div><dt>Time</dt><dd id="js-time">0:00.0</dd></div>
      <div><dt>Best lap</dt><dd id="js-best">—</dd></div>
      <div><dt>Speed</dt><dd id="js-speed">0 km/h</dd></div>
    </dl>
    <p class="js-pen" id="js-pen" hidden></p>
    <ol class="rc-board" id="js-board" aria-label="Standings"></ol>
    <p class="rh-keys"><span id="js-keys"></span> · Cam: <span id="js-cam">Chase</span></p>
    <p class="rh-toast" id="js-toast" hidden></p>`;
  hud.insertBefore(el, hud.querySelector('#panel'));
  return el;
}

export class JetSki implements Attraction {
  private racers: Racer[] = [];
  /** The HUD, held on to (its parts are looked up inside it, not in the document). */
  private hudEl: HTMLElement;
  private rigs: Rig[] = [];
  /** The four rivals (everyone but you): who's on the water while nobody races. */
  private rivals: Racer[] = [];
  private dock: Dock;
  private wakes: Wakes;
  private spray: Spray;
  /** Everything built in the lagoon is stored relative to this (41 km out, float32 precision matters). */
  private origin = new THREE.Vector3(0, SEA_Y, 41800);
  private buoys!: { body: THREE.InstancedMesh; trim: THREE.InstancedMesh; lamps: THREE.InstancedMesh; lampMat: THREE.MeshBasicMaterial };
  private buoySpots: { x: number; z: number; ph: number; left: boolean }[] = [];
  private moored!: THREE.InstancedMesh;
  private navLights!: THREE.InstancedMesh;
  private marker!: THREE.Mesh;
  private fans!: { body: THREE.InstancedMesh; head: THREE.InstancedMesh };
  private lamps!: THREE.InstancedMesh;
  private archSign!: THREE.MeshStandardMaterial;
  /** The edge ropes are unlit lines: dimmed by hand at night. */
  private ropeMat = new THREE.LineBasicMaterial({ color: ROPE });
  private awake = true;
  private night = 0;
  private people: { factory: PeopleFactory; visitor: () => Look } | null = null;
  /**
   * How many riders have their people (the visitor's first). Once the island set arrives mid-game
   * (the visitor in the air) they're dressed one a frame: each is a body and a vest fitted to it,
   * 10 to 20 ms, which all five at once would turn into a visible stall.
   */
  private dressed = 0;
  /** The rivals' looks, cast when the visitor's rider is dressed. */
  private rivalLooks: Look[] = [];
  private visitorKey = '';
  private vestMat: THREE.MeshStandardMaterial | null = null;
  private phase: Phase = 'idle';
  private phaseT = 0;
  private raceT = 0;
  /** After the line: whether the place is final yet (see onFlag). */
  private settled = false;
  private beat = -1;
  private cam: Cam = 'chase';
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private shake = 0;
  /** How far the chase camera has climbed to see over a rival sat between it and you (eased). */
  private lift = 0;
  private hudTimer = 0;
  private toastTimer = 0;
  private introTimer = 0;
  private rescueT = 0;
  private boostWas = false;
  private record = { race: 0, lap: 0, wins: 0 };
  private place = 0;
  private topSpeed = 0;
  private final: Record<string, number> | null = null;
  private t = 0;
  private readonly water = (x: number, z: number) => waveY(x, z, this.t);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  active = false;
  input: Input | null = null;
  onFinish: (() => void) | null = null;
  /** The race is over and the cool-down is done: time to go back to the beach. */
  onComplete: (() => void) | null = null;

  constructor(private ctx: Ctx) {
    try {
      Object.assign(this.record, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
    } catch {
      /* storage unavailable */
    }
    this.dock = new Dock(ctx);
    ctx.scene.add(this.dock.group);
    const low = ctx.quality.tier === 'low' || ctx.quality.tier === 'lowest';
    this.wakes = new Wakes(5, this.origin, ctx.renderer);
    this.spray = new Spray(low ? 450 : 900, this.origin, ctx.renderer);
    ctx.scene.add(this.wakes.mesh, this.spray.points);
    this.buildBuoys(low);
    this.buildRamps();
    this.buildArch();
    this.buildMoored();
    this.buildFans(low);
    this.buildMarker();
    this.racers.push(newRacer('You', YOU.color, 0.9, true));
    this.rigs.push(this.makeRig(YOU.color, YOU.helmet, PALETTE.cream));
    for (const r of RIVALS) {
      this.racers.push(newRacer(r.name, r.color, r.skill, r.jumper));
      this.rigs.push(this.makeRig(r.color, r.helmet, '#1d1238'));
    }
    this.rivals = this.racers.slice(1);
    this.buildNavLights();
    this.hudEl = buildHud(ctx.ui.hud);
    // ghost laps: the rivals spread round the course, already up to speed
    this.racers.forEach((r, i) => {
      if (i) toGhost(r, START_S + 40 + i * 190, (i % 2 ? 1 : -1) * 2.5, this.water);
    });
    this.park();
    this.setNight(0);
  }

  // ------------------------------------------------------------------ building

  /** The gate buoys (bodies, white trim, lamps) and the edge ropes' floats. */
  private buildBuoys(low: boolean) {
    const o = this.origin;
    for (const g of GATES)
      for (const side of [1, -1]) {
        const p = coursePoint(g.s, side * (GATE_HALF + 0.6));
        this.buoySpots.push({ x: p.x, z: p.z, ph: p.x * 0.13 + p.z * 0.07, left: side > 0 });
      }
    const n = this.buoySpots.length;
    const bodyMat = std('#ffffff', { vertexColors: true, roughness: 0.42 });
    const body = new THREE.InstancedMesh(buoyBody(), bodyMat, n);
    const trim = new THREE.InstancedMesh(buoyTrim(), std('#ffffff', { vertexColors: true, roughness: 0.5 }), n);
    const lampMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6), lampMat, n);
    const col = new THREE.Color();
    this.buoySpots.forEach((b, i) => {
      body.setColorAt(i, col.set(b.left ? '#e8372c' : '#ffc21a'));
      lamps.setColorAt(i, col.set(b.left ? '#ff5a4a' : '#ffd05a'));
    });
    for (const im of [body, trim, lamps]) {
      im.position.copy(o);
      im.frustumCulled = false;
      this.ctx.scene.add(im);
    }
    body.castShadow = trim.castShadow = this.ctx.quality.shadows;
    this.buoys = { body, trim, lamps, lampMat };
    this.bobBuoys(0);

    // the edge ropes: white floats, every fifth one red, strung along both edges, and the
    // chequered floats across the start line
    const floats: { x: number; z: number; c: string }[] = [];
    const every = low ? 6 : 4;
    for (const side of [1, -1])
      for (let s = 0, k = 0; s < COURSE.length; s += every, k++) {
        const p = coursePoint(s, side * (WALL - 1));
        floats.push({ x: p.x, z: p.z, c: k % 5 ? '#f4f1ea' : '#e8372c' });
      }
    for (let k = 0; k <= 12; k++) {
      const p = coursePoint(START_S, -GATE_HALF + (k / 12) * GATE_HALF * 2);
      floats.push({ x: p.x, z: p.z, c: k % 2 ? '#16161a' : '#f6f6f6' });
    }
    const fm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 10, 6).scale(1, 0.8, 1), std('#ffffff', { roughness: 0.4 }), floats.length);
    floats.forEach((f, i) => {
      fm.setMatrixAt(i, this.m.makeTranslation(f.x - o.x, 0.05, f.z - o.z));
      fm.setColorAt(i, col.set(f.c));
    });
    fm.position.copy(o);
    fm.computeBoundingSphere();
    this.ctx.scene.add(fm);
    if (!low) {
      // the rope itself, a hand's breadth above the water between the floats
      const pos: number[] = [];
      for (const side of [1, -1])
        for (let s = 0; s < COURSE.length; s += every) {
          const a = coursePoint(s, side * (WALL - 1));
          const b = coursePoint(s + every, side * (WALL - 1));
          pos.push(a.x - o.x, 0.12, a.z - o.z, b.x - o.x, 0.12, b.z - o.z);
        }
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const rope = new THREE.LineSegments(g, this.ropeMat);
      rope.position.copy(o);
      this.ctx.scene.add(rope);
    }
  }

  /** The buoys bob on the water and nod a little (cheap: thirty matrices). */
  private bobBuoys(t: number) {
    const { body, trim, lamps } = this.buoys;
    const o = this.origin;
    this.buoySpots.forEach((b, i) => {
      const y = waveY(b.x, b.z, t) - o.y + Math.sin(t * 1.7 + b.ph) * 0.05;
      this.e.set(Math.sin(t * 1.3 + b.ph) * 0.05, b.ph, Math.cos(t * 1.1 + b.ph) * 0.05);
      this.m.compose(this.v1.set(b.x - o.x, y, b.z - o.z), this.q.setFromEuler(this.e), this.one);
      body.setMatrixAt(i, this.m);
      trim.setMatrixAt(i, this.m);
      this.v2.set(0, BUOY_H + 0.17, 0).applyQuaternion(this.q).add(this.v1);
      lamps.setMatrixAt(i, this.m.makeTranslation(this.v2.x, this.v2.y, this.v2.z));
    });
    body.instanceMatrix.needsUpdate = true;
    trim.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
  }

  /** The two floating kickers, in one mesh for their decks and one for the rest. */
  private buildRamps() {
    const o = this.origin;
    const tops: THREE.BufferGeometry[] = [];
    const sides: THREE.BufferGeometry[] = [];
    for (const r of RAMPS) {
      const g = rampGeometry(r);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(r.x - o.x, 0, r.z - o.z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r.yaw), this.one);
      tops.push(g.top.applyMatrix4(m));
      sides.push(g.sides.applyMatrix4(m));
    }
    const tex = canvasTex(rampTexture(), this.ctx.renderer);
    const top = new THREE.Mesh(mergeGeometries(tops)!, std('#ffffff', { map: tex, roughness: 0.7 }));
    const side = new THREE.Mesh(mergeGeometries(sides)!, std('#ffffff', { vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
    for (const mesh of [top, side]) {
      mesh.position.copy(o);
      mesh.castShadow = this.ctx.quality.shadows;
      mesh.receiveShadow = this.ctx.quality.shadows;
      this.ctx.scene.add(mesh);
    }
  }

  /** The inflatable arch over the start / finish line, its banner and the start lights. */
  private buildArch() {
    const p = coursePoint(START_S, 0);
    const g = new THREE.Group();
    g.position.set(p.x, SEA_Y, p.z);
    g.rotation.y = headingOf(p.tx, p.tz); // local x across the course (to the right), −z down it
    const span = GATE_HALF * 2 + 5;
    const rise = 8.5;
    const arch = new THREE.Mesh(archGeometry(span, rise, [PALETTE.candy, '#ffffff', '#2ec4b6', '#ffffff']), std('#ffffff', { vertexColors: true, roughness: 0.38 }));
    const tex = signTexture('PALM CAY JET-SKI RACE', { sub: `start · finish · ${LAPS} laps`, border: '#2ec4b6', width: 1536, height: 256 });
    this.archSign = new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.3, roughness: 0.6 });
    // the banner, both faces in one mesh
    const face = new THREE.PlaneGeometry(12.6, 2.1);
    const sign = new THREE.Mesh(mergeGeometries([face.clone().translate(0, 0, 0.04), face.rotateY(Math.PI).translate(0, 0, -0.04)])!, this.archSign);
    sign.position.y = rise - 2.15;
    // the banner's backing board, the lights' housings and their rail: one dark mesh
    const dark: THREE.BufferGeometry[] = [new THREE.BoxGeometry(12.8, 2.3, 0.06).translate(0, rise - 2.15, 0), new THREE.BoxGeometry(6.4, 0.1, 0.1).translate(0, rise - 3.3, 0)];
    // three start lights either side of the middle, under the banner, facing the grid (local +z):
    // one instance each, coloured per column as they come on
    this.lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.28, 18), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 6);
    for (let j = 0; j < 3; j++)
      for (const sx of [-1, 1]) {
        const x = sx * (0.8 + j * 1.0);
        dark.push(new THREE.BoxGeometry(0.8, 0.8, 0.25).translate(x, rise - 3.75, 0.1));
        this.lamps.setMatrixAt(j * 2 + (sx > 0 ? 1 : 0), this.m.makeTranslation(x, rise - 3.75, 0.24));
      }
    this.setLamps(3, LAMP_OFF);
    const board = new THREE.Mesh(mergeGeometries(dark)!, std('#141218', { roughness: 0.5 }));
    g.add(arch, sign, board, this.lamps);
    shadowed(g);
    this.lamps.castShadow = false;
    this.ctx.scene.add(g);
  }

  /** The first `n` columns of start lights to `color` (an HDR colour, for the bloom). */
  private setLamps(n: number, color: THREE.Color) {
    for (let k = 0; k < n * 2; k++) this.lamps.setColorAt(k, color);
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  /** The rental fleet moored along the pontoon, white with the island's teal. */
  private buildMoored() {
    const geo = skiGeometry('#2ec4b6', '#ffffff');
    this.moored = new THREE.InstancedMesh(geo, std('#ffffff', { vertexColors: true, roughness: 0.3, metalness: 0.05 }), MOORINGS.length);
    this.moored.position.copy(this.origin);
    this.moored.frustumCulled = false;
    this.moored.castShadow = this.ctx.quality.shadows;
    this.ctx.scene.add(this.moored);
    this.bobMoored(0);
  }

  private bobMoored(t: number) {
    const o = this.origin;
    MOORINGS.forEach((mo, i) => {
      const y = waveY(mo.x, mo.z, t) - 0.22 - o.y + Math.sin(t * 1.5 + i) * 0.03;
      this.e.set(Math.sin(t * 1.1 + i * 1.7) * 0.025, mo.h, Math.sin(t * 1.4 + i) * 0.035);
      this.moored.setMatrixAt(i, this.m.compose(this.v1.set(mo.x - o.x, y, mo.z - o.z), this.q.setFromEuler(this.e), this.one));
    });
    this.moored.instanceMatrix.needsUpdate = true;
  }

  /** Spectators along the T-head's rail and on the pontoon (bodies in their shirts, heads apart). */
  private buildFans(low: boolean) {
    const spots = low ? SPECTATOR_SPOTS.filter((_, i) => i % 2 === 0) : SPECTATOR_SPOTS;
    const body = new THREE.InstancedMesh(spectatorBody(), std('#ffffff', { vertexColors: true, roughness: 0.8 }), spots.length);
    const head = new THREE.InstancedMesh(spectatorHead(), std('#ffffff', { vertexColors: true, roughness: 0.7 }), spots.length);
    const col = new THREE.Color();
    const shirts = ['#ff4d6d', '#ffd23f', '#2ec4b6', '#3a86ff', '#ffffff', '#ff8a3d', '#7b5cd6', '#7ee2b8'];
    const skins = ['#f1c7a5', '#d9a07a', '#a8714c', '#7a4b2e', '#e8b48e'];
    spots.forEach((_, i) => {
      body.setColorAt(i, col.set(shirts[(i * 5) % shirts.length]));
      head.setColorAt(i, col.set(skins[(i * 3) % skins.length]));
    });
    body.userData.spots = spots;
    for (const im of [body, head]) {
      im.position.copy(this.origin);
      im.frustumCulled = false;
      im.castShadow = this.ctx.quality.shadows;
      this.ctx.scene.add(im);
    }
    this.fans = { body, head };
    this.cheer(0, 0);
  }

  /** The floating chevron over the next gate you have to ride through. */
  private buildMarker() {
    const s = new THREE.Shape();
    s.moveTo(-0.9, 0.7);
    s.lineTo(0, -0.5);
    s.lineTo(0.9, 0.7);
    s.lineTo(0.5, 0.7);
    s.lineTo(0, 0.05);
    s.lineTo(-0.5, 0.7);
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.18, bevelEnabled: false }).translate(0, 0, -0.09);
    this.marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: hdr('#7dffb0', 2.2), transparent: true, opacity: 0.92 }));
    this.marker.visible = false;
    this.ctx.scene.add(this.marker);
  }

  /** Bow lights (red to port, green to starboard) and a white stern light on every ski, for the night. */
  private buildNavLights() {
    const n = this.racers.length * 3;
    this.navLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: '#ffffff' }), n);
    const col = new THREE.Color();
    for (let i = 0; i < this.racers.length; i++) {
      this.navLights.setColorAt(i * 3, hdr('#ff2a2a', 6));
      this.navLights.setColorAt(i * 3 + 1, hdr('#2aff6a', 6));
      this.navLights.setColorAt(i * 3 + 2, col.set(hdr('#ffffff', 2.5)));
    }
    this.navLights.frustumCulled = false;
    this.navLights.position.copy(this.origin);
    this.ctx.scene.add(this.navLights);
  }

  private makeRig(color: string, helmet: string, accent: string): Rig {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const hullMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12 });
    const hull = new THREE.Mesh(skiGeometry(color, accent), hullMat);
    const far = new THREE.Mesh(riderGeometry(color, helmet), std('#ffffff', { vertexColors: true, roughness: 0.7 }));
    const rider = new THREE.Group();
    rider.position.copy(SADDLE);
    rider.rotation.order = 'YXZ';
    rider.add(far);
    root.add(hull, rider);
    shadowed(root);
    this.ctx.scene.add(root);
    return { root, rider, far, body: null, tail: 0, bow: 0, lean: 0 };
  }

  /**
   * Gives the riders their bodies: the visitor in their own look (and a life vest in their ski's
   * colour), the rivals in theirs. `visitor` is read again at each `start()` (the visitor's rider is
   * rebuilt if their look has changed since), so a getter or a Look kept up to date both do.
   *
   * The rivals are the island set's people, which download on the first trip out, not with the
   * fair's: until they're in, the merged stand-in figures ride. Waking the race (the visitor on
   * Palm Cay) asks for the set if nobody has yet; the riders are dressed as it arrives (see dressed).
   */
  setPeople(factory: PeopleFactory, visitor: Look | (() => Look)) {
    this.people = { factory, visitor: typeof visitor === 'function' ? visitor : () => visitor };
    this.dressed = 0;
    if (factory.isSetLoaded('island')) this.dressRest();
    else if (this.awake) this.askForPeople();
  }

  private askForPeople() {
    this.people?.factory.loadSet('island').catch((e: unknown) => console.warn('jet-ski: the island people failed to load', e));
  }

  /** Dresses the next rider: the visitor first (casting the rivals, who must not be their double), then Kai, Rosa, Sami and Theo. */
  private dressNext() {
    const people = this.people!;
    const i = this.dressed++;
    if (i === 0) {
      const visitor = people.visitor();
      this.visitorKey = lookKey(visitor);
      this.rivalLooks = rivalRiderLooks(people.factory, visitor.avatar);
      this.dress(0, visitorRiderLook(visitor));
    } else this.dress(i, this.rivalLooks[i - 1]);
  }

  private dressRest() {
    while (this.dressed < this.rigs.length) this.dressNext();
  }

  private dress(i: number, look: Look) {
    const people = this.people;
    if (!people) return;
    const rig = this.rigs[i];
    const vest = this.racers[i].color;
    rig.body?.dispose();
    const q = this.ctx.quality;
    this.vestMat ??= std('#ffffff', { vertexColors: true, roughness: 0.62 });
    rig.body = new Rider(people.factory.create(look), rig.rider, rig.far, vest, this.vestMat, q.shadows && q.tier !== 'low' && q.tier !== 'lowest');
    rig.body.setGlow(this.night);
    // the far figure in the same colours: vest, hair for the helmet, skin for the suit
    const col: RiderColours = riderColours(people.factory, look, vest);
    rig.far.geometry.dispose();
    rig.far.geometry = riderGeometry(col.vest, col.hair, col.skin);
  }

  /** Your ski waits on its mooring while nobody's racing. */
  private park() {
    const r = this.me;
    r.prog = -1e9;
    this.rigs[0].root.visible = false;
  }

  private get me() {
    return this.racers[0];
  }

  // ------------------------------------------------------------------ the round

  /** The visitor is on Palm Cay (or not): asleep, the race neither simulates nor sounds. */
  setAwake(on: boolean) {
    if (this.awake === on) return;
    this.awake = on;
    if (!on) this.ctx.sfx.boatEngine(false);
    else if (this.people && this.dressed < this.rigs.length) this.askForPeople();
  }

  /** 0 by day .. 1 at night: the dock's lanterns, the buoys' lamps, the skis' navigation lights. */
  setNight(k: number) {
    this.night = k;
    for (const r of this.rigs) r.body?.setGlow(k);
    this.vestMat?.emissive.setScalar(0.025 * k);
    this.dock.setNight(k);
    this.wakes.setNight(k);
    this.spray.setNight(k);
    this.buoys.lampMat.color.setScalar(0.25 + 4 * k);
    this.navLights.visible = k > 0.08;
    this.ropeMat.color.set(ROPE).multiplyScalar(1 - 0.8 * k);
    this.archSign.emissiveIntensity = 0.25 + 0.75 * k;
  }

  start() {
    this.active = true;
    // the visitor may have changed their look since the people loaded (a hat, a new top)
    if (this.people?.factory.isSetLoaded('island')) {
      // (a race straight off the plane may come before the last rival is dressed)
      this.dressRest();
      const visitor = this.people.visitor();
      const key = lookKey(visitor);
      if (key !== this.visitorKey) {
        this.visitorKey = key;
        this.dress(0, visitorRiderLook(visitor));
      }
    }
    this.phase = 'grid';
    this.phaseT = 0;
    this.raceT = 0;
    this.beat = -1;
    this.place = 0;
    this.settled = false;
    this.topSpeed = 0;
    this.final = null;
    this.boostWas = false;
    this.setLamps(3, LAMP_OFF);
    // you start nearest the dock, on the left of the line; the rivals fill the rest, fastest outside
    const slots = [0, 4, 1, 3, 2];
    this.racers.forEach((r, i) => toGrid(r, slots[i], this.water));
    this.rigs[0].root.visible = true;
    this.cam = 'chase';
    const c = this.me.c;
    const fx = -Math.sin(c.h);
    const fz = -Math.cos(c.h);
    this.camPos.set(c.x - fx * 8.2, SEA_Y + 2.7, c.z - fz * 8.2);
    this.camLook.set(c.x, SEA_Y + 1, c.z);
    this.hudEl.hidden = false;
    this.$('js-toast').hidden = true;
    this.$('js-pen').hidden = true;
    this.$('js-cam').textContent = CAM_LABEL[this.cam];
    this.$('js-best').textContent = this.record.lap ? fmt(this.record.lap) : '—';
    this.$('js-keys').innerHTML = this.ctx.mobile
      ? 'Stick ride · push all the way to boost · <kbd>E</kbd> surf burst'
      : '<kbd>W</kbd>/<kbd>S</kbd> throttle · brake, <kbd>A</kbd>/<kbd>D</kbd> steer, <kbd>Shift</kbd> boost, <kbd>E</kbd> surf burst, <kbd>Space</kbd> hop, <kbd>C</kbd> camera, <kbd>R</kbd> back on course';
    document.body.classList.add('is-racing', 'is-jetski');
    this.hudTimer = 0;
    this.updateHud(0);
    const shown = this.ctx.ui.setIntro('jetski-intro', 'Jet-Ski Race', this.introHtml(), { accent: PALETTE.teal });
    this.introTimer = shown ? 9 : 0;
    this.ctx.sfx.chime();
  }

  private introHtml() {
    const controls = this.ctx.mobile
      ? 'Push the joystick <strong>up</strong> for throttle, <strong>down</strong> to brake, sideways to steer (the nozzle only steers while it pushes). Push it all the way to <strong>boost</strong>; <kbd>E</kbd> fires a surf burst.'
      : '<kbd>W</kbd> throttle · <kbd>S</kbd> brake / reverse · <kbd>A</kbd> <kbd>D</kbd> steer (only under power!) · <kbd>Shift</kbd> boost · <kbd>E</kbd> surf burst · <kbd>Space</kbd> hop · <kbd>C</kbd> camera · <kbd>R</kbd> back on course.';
    return `<p class="eyebrow">Jet-Ski Race · ${LAPS} laps · 5 skis</p><h2>Win the lagoon! 🚤</h2><p>Ride between every pair of buoys: 🔴 <strong>red</strong> to your left, 🟡 <strong>yellow</strong> to your right. Miss a gate and it's <strong>+${MISS_PENALTY} s</strong>.</p><p>Hit the <strong>ramps</strong> and wakes for air, and let go of the throttle in the air to land flat: clean landings fill the 🌊 <strong>surf meter</strong> that powers your boost.</p><p>${controls}</p>`;
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.phase = 'idle';
    this.hudEl.hidden = true;
    document.body.classList.remove('is-racing', 'is-jetski');
    this.ctx.ui.countdown(null);
    this.ctx.sfx.boatEngine(false);
    this.marker.visible = false;
    this.rigs[0].rider.visible = true;
    const cam = this.ctx.camera;
    cam.fov = cam.aspect < 0.8 ? 58 : 42;
    cam.updateProjectionMatrix();
    cam.up.set(0, 1, 0);
    this.final = this.measure();
    this.paintGates(-1);
    // back to ghost laps; your ski goes back to its mooring
    for (const r of this.racers) Object.assign(r, { prog: -1e9, finished: null });
    this.park();
    this.onFinish?.();
  }

  /** This race's numbers (see account/stats.ts): the place and race time only if you finished. */
  roundStats(): Record<string, number> {
    return this.final ?? this.measure();
  }

  private measure() {
    const me = this.me;
    const stats: Record<string, number> = { topSpeedKmh: this.topSpeed * 3.6, buoysMissed: me.missed, jumps: me.jumps };
    if (me.bestLap) stats.bestLapTimeS = me.bestLap;
    if (me.finished !== null && this.place && this.settled) {
      stats.position = this.place;
      stats.raceTimeS = me.finished;
    }
    return stats;
  }

  /** E / Space on touch: a burst of surf boost (if there's surf in the meter). */
  action() {
    if (!this.active || this.phase !== 'race') return;
    const c = this.me.c;
    if (c.surf < 0.12) {
      this.toast('No surf yet: jump the ramps and wakes 🌊');
      return;
    }
    c.burst = BURST;
  }

  cycleCamera() {
    const order: Cam[] = ['chase', 'pov', 'high'];
    this.cam = order[(order.indexOf(this.cam) + 1) % order.length];
    this.$('js-cam').textContent = CAM_LABEL[this.cam];
    this.ctx.sfx.pop();
  }

  /** R: back onto the course where you are, pointing the right way, at rest. */
  rescue() {
    if (!this.active || this.phase !== 'race' || this.rescueT > 0) return;
    const r = this.me;
    const p = coursePoint(r.s, THREE.MathUtils.clamp(r.d, -4, 4));
    const c = r.c;
    Object.assign(c, { x: p.x, z: p.z, h: headingOf(p.tx, p.tz), vx: 0, vz: 0, vy: 0, yawRate: 0, stunT: 0, ramp: -1, air: false, pitch: 0, roll: 0 });
    c.y = this.water(p.x, p.z) - 0.2;
    r.wrongT = 0;
    this.rescueT = 2;
    this.toast('Back on course 🔧');
    this.ctx.sfx.pop();
  }

  // ------------------------------------------------------------------ the loop

  update(dt: number, t: number) {
    // (the island set may arrive while the race sleeps: the visitor still in the air)
    if (this.people && this.dressed < this.rigs.length && this.people.factory.isSetLoaded('island')) this.dressNext();
    if (!this.awake) return;
    this.t = t;
    if (this.rescueT > 0) this.rescueT -= dt;
    this.bobBuoys(t);
    this.bobMoored(t);
    this.dock.update(t);

    if (this.active) this.raceControl(dt);
    const racing = this.active && this.phase !== 'grid';
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (i === 0 && !this.active) continue;
      if (i === 0 && this.phase === 'race') this.riderControls(r);
      else {
        let rubber = 1;
        if (this.active && this.phase === 'race' && i > 0) rubber = THREE.MathUtils.clamp(1 - (r.prog - this.me.prog) / 900, 0.93, 1.05);
        aiControls(r, this.racers, dt, rubber);
      }
      if (this.active && this.phase === 'grid') {
        // on the grid: blipping the throttle in neutral, held on the line
        r.c.throttle = 0;
        r.c.steerIn = 0;
      }
    }
    // two physics substeps a frame
    const h = dt / 2;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < this.racers.length; i++) {
        const r = this.racers[i];
        if (i === 0 && !this.active) continue;
        if (this.active && this.phase === 'grid') {
          this.floatOnGrid(r, h);
          continue;
        }
        const ev = stepRacer(r, this.racers, h, t + h * j, this.raceT, racing && r.prog > -1e8, this.water);
        this.onEvents(i, r, ev);
      }
      const hit = collideRacers(this.active ? this.racers : this.rivals, this.active ? this.me : null);
      if (hit > 3 && this.active) {
        this.ctx.sfx.thunk(hit);
        this.shake = Math.max(this.shake, Math.min(0.5, 0.1 + hit * 0.04));
      }
    }
    for (let i = 0; i < this.racers.length; i++) {
      if (i === 0 && !this.active) continue;
      this.emitSpray(i, dt);
      this.pose(i, dt);
    }
    this.wakes.update(
      this.racers.map((r) => r.wake),
      t,
      this.water,
    );
    this.spray.update(dt);
    this.poseNavLights();
    this.cheer(t, dt);
    this.engineSound();
    if (this.active) {
      if (this.phase === 'race') this.topSpeed = Math.max(this.topSpeed, forwardSpeed(this.me.c));
      this.updateMarker(t);
      this.updateHud(dt);
      if (this.introTimer > 0) {
        this.introTimer -= dt;
        if (this.introTimer <= 0 && this.ctx.ui.panelOpenKey === 'jetski-intro') this.ctx.ui.hidePanel();
      }
    }
  }

  /** Held on the line before the lights: floating, the riders blipping their throttles. */
  private floatOnGrid(r: Racer, dt: number) {
    const c = r.c;
    const w = this.water(c.x, c.z);
    c.vy += (70 * (w - 0.24 - c.y) - 9 * c.vy) * dt;
    c.y += c.vy * dt;
    c.pitch += (0 - c.pitch) * Math.min(1, dt * 4);
    c.roll = Math.sin(this.t * 2.1 + c.x) * 0.02;
  }

  /** The start lights, the countdown, the cool-down after the line. */
  private raceControl(dt: number) {
    this.phaseT += dt;
    if (this.phase === 'grid') {
      const beat = Math.floor((this.phaseT - 0.6) / 1);
      if (beat !== this.beat && beat >= 0) {
        this.beat = beat;
        if (beat < 3) {
          this.ctx.ui.countdown(String(3 - beat));
          this.lamps.setColorAt(beat * 2, LAMP_RED);
          this.lamps.setColorAt(beat * 2 + 1, LAMP_RED);
          if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
          this.ctx.sfx.beep(false);
        }
      }
      if (this.phaseT >= GRID_TIME) {
        this.phase = 'race';
        this.phaseT = 0;
        this.ctx.ui.countdown('GO!');
        this.setLamps(3, LAMP_GO);
        this.ctx.sfx.beep(true);
        this.ctx.sfx.whoosh(1.4);
        this.paintGates(this.me.gate);
      }
      return;
    }
    if (this.phase === 'race' || this.phase === 'done') this.raceT += dt;
    if (this.phase === 'race' && this.phaseT > 1.2 && this.phaseT - dt <= 1.2) this.ctx.ui.countdown(null);
    if (this.phase === 'race' && this.phaseT > 4 && this.phaseT - dt <= 4) this.setLamps(3, LAMP_OFF);
    if (this.phase === 'done' && !this.settled) this.settle();
    if (this.phase === 'done' && this.settled && this.phaseT > COOLDOWN) {
      this.phase = 'idle'; // fire once
      this.onComplete?.();
    }
  }

  private riderControls(r: Racer) {
    const inp = this.input;
    const c = r.c;
    if (!inp) return aiControls(r, this.racers, 1 / 60);
    c.throttle = inp.throttle;
    c.steerIn = inp.steer;
    c.wantBoost = inp.boost && inp.throttle > 0;
    c.wantHop = inp.lift > 0;
  }

  /** What a physics step did: toasts and sounds for you, splashes for everyone. */
  private onEvents(i: number, r: Racer, ev: RaceEvents) {
    const mine = i === 0 && this.active;
    const c = r.c;
    const near = this.hearing(c.x, c.z);
    const landed = ev.physics.landed;
    if (landed) {
      const size = Math.min(1.6, 0.3 + Math.max(0, landed.impact) * 0.12 + landed.airT * 0.3);
      this.spray.splash(c.x, this.water(c.x, c.z), c.z, c.vx, c.vz, size);
      if (mine || near > 0.2) this.ctx.sfx.splash(Math.min(2, size) * (mine ? 1 : near));
      if (mine && landed.airT > 0.35) {
        this.shake = Math.max(this.shake, Math.min(0.5, 0.08 + landed.impact * 0.03));
        if (landed.result === 'clean') this.toast(landed.spin ? '360! Clean landing 🌀 +surf' : landed.airT > 0.9 ? `Big air! ${landed.airT.toFixed(1)} s 🌊 +surf` : 'Clean landing 🌊 +surf');
        else if (landed.result === 'rough') this.toast('Rough landing: ease off the throttle in the air');
        else if (landed.result === 'stuffed') this.toast('Nose-dive! 💦 Lift the nose next time');
        else this.toast('Sideways! 💦 Straighten up before you land');
      }
    }
    if (ev.physics.launched > 3 && (mine || near > 0.3)) this.ctx.sfx.whoosh(0.6 + ev.physics.launched * 0.08);
    if (mine && ev.wakeKick) this.toast('Wave jump! 🌊');
    if (mine && ev.bump > 4) {
      this.ctx.sfx.whack();
      this.shake = Math.max(this.shake, Math.min(0.5, 0.1 + ev.bump * 0.04));
    }
    if (!mine) {
      if (ev.finished && this.active) this.ctx.sfx.cheer(0.25);
      return;
    }
    if (ev.gate) {
      if (!ev.gate.ok) {
        this.toast(`Missed the buoys! +${MISS_PENALTY} s ⏱️`);
        this.ctx.sfx.beep(false);
        this.$('js-pen').hidden = false;
        this.$('js-pen').textContent = `+${r.penalty} s penalty`;
      } else if (ev.gate.j !== 0) this.ctx.sfx.ting(false);
      this.paintGates(r.gate);
    }
    if (ev.lap !== null) this.onMyLap(ev.lap);
    if (ev.finished) this.onFlag();
    if (r.wrongT > 1.2) {
      r.wrongT = -3; // nag every few seconds at most
      this.toast(this.ctx.mobile ? 'Wrong way! ↩️' : 'Wrong way! ↩️ Press R to turn round');
    }
  }

  private onMyLap(lap: number) {
    const me = this.me;
    if (me.laps >= LAPS) return;
    let msg = `Lap ${me.laps} · ${fmt(lap)}`;
    if (!this.record.lap || lap < this.record.lap) {
      this.record.lap = lap;
      msg = `Best lap ever! ${fmt(lap)} 🏆`;
      this.save();
    }
    if (me.laps === LAPS - 1) msg += ' · Final lap! 🏁';
    this.toast(msg);
    this.ctx.sfx.chime();
    this.$('js-best').textContent = fmt(this.record.lap);
  }

  /**
   * Over the line. Times count with their penalties, so a rival crossing just after you with fewer
   * penalty seconds can still beat you: the place is provisional until the race clock reaches your
   * time (from then on nobody still out there can finish ahead) or everyone's home, then `settle`
   * makes it final (the win, the countdown, the cheer) and the cool-down starts.
   */
  private onFlag() {
    const me = this.me;
    const time = me.finished ?? this.raceT;
    if (me.bestLap && (!this.record.lap || me.bestLap < this.record.lap)) this.record.lap = me.bestLap;
    if (!this.record.race || time < this.record.race) this.record.race = time;
    this.save();
    this.phase = 'done';
    this.phaseT = 0;
    this.settled = false;
    this.marker.visible = false;
    this.paintGates(-1);
    this.ctx.sfx.ding();
    this.settle();
    if (!this.settled) {
      this.place = this.racers.filter((o) => o.finished !== null && o.finished <= time).length;
      this.ctx.ui.countdown('🏁 Finished!');
      this.toast(`Finished · ${fmt(time)} (incl. +${me.penalty} s) · waiting for the times…`);
    }
  }

  /** The place once it can't change any more (see onFlag): the result, and the cool-down from here. */
  private settle() {
    const me = this.me;
    const time = me.finished ?? this.raceT;
    this.place = this.racers.filter((o) => o.finished !== null && o.finished <= time).length;
    if (this.raceT < time && this.racers.some((o) => o.finished === null)) return;
    this.settled = true;
    this.phaseT = 0;
    if (this.place === 1) this.record.wins++;
    this.save();
    this.ctx.ui.countdown(this.place === 1 ? '🏁 WINNER!' : `🏁 ${this.place}${ordinal(this.place)}`);
    this.toast(`Finished ${this.place}${ordinal(this.place)} · ${fmt(time)}${me.penalty ? ` (incl. +${me.penalty} s)` : ''}`);
    this.ctx.sfx.cheer(this.place === 1 ? 1 : 0.5);
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.record));
    } catch {
      /* storage unavailable */
    }
  }

  /** The next gate's buoys light up green-white (and the rest go back to red and yellow). */
  private paintGates(next: number) {
    const { body, lamps } = this.buoys;
    const col = new THREE.Color();
    this.buoySpots.forEach((b, i) => {
      const hot = Math.floor(i / 2) === next;
      body.setColorAt(i, col.set(hot ? (b.left ? '#ff6a4a' : '#ffe14a') : b.left ? '#e8372c' : '#ffc21a'));
      lamps.setColorAt(i, hot ? hdr('#9dffc4', 5) : col.set(b.left ? '#ff5a4a' : '#ffd05a'));
    });
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  }

  /** The chevron hovers over the middle of the next gate, bobbing and turning to face you. */
  private updateMarker(t: number) {
    const on = this.phase === 'race';
    this.marker.visible = on;
    if (!on) return;
    const g = GATES[this.me.gate];
    const p = coursePoint(g.s, 0);
    const c = this.me.c;
    this.marker.position.set(p.x, SEA_Y + 4.2 + Math.sin(t * 3) * 0.25, p.z);
    this.marker.rotation.y = Math.atan2(c.x - p.x, c.z - p.z);
    const mat = this.marker.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.65 + 0.3 * Math.sin(t * 6);
  }

  // ------------------------------------------------------------------ effects, poses, sound

  /** The rooster tail off the jet, sheets of spray off the bow in a carve. */
  private emitSpray(i: number, dt: number) {
    const r = this.racers[i];
    const rig = this.rigs[i];
    const c = r.c;
    if (c.air) return;
    const v = forwardSpeed(c);
    if (v < 3) return;
    const fx = -Math.sin(c.h);
    const fz = -Math.cos(c.h);
    const lx = fz;
    const lz = -fx;
    const w = this.water(c.x, c.z);
    const thrust = Math.max(0.25, c.throttle) * (c.boosting ? 1.5 : 1);
    rig.tail += dt * v * 2.6 * thrust;
    while (rig.tail >= 1) {
      rig.tail -= 1;
      const sx = (Math.random() - 0.5) * 0.5;
      const back = 1.7 + Math.random() * 0.3;
      const up = 2.2 + v * 0.22 * thrust + Math.random() * 1.6;
      const out = v * 0.12 + Math.random() * 1.5;
      this.spray.emit(c.x - fx * back + lx * sx, w + 0.25, c.z - fz * back + lz * sx, c.vx * 0.55 - fx * out + lx * sx * 2, up, c.vz * 0.55 - fz * out + lz * sx * 2, 0.6 + Math.random() * 0.5);
    }
    // carving: the outside of the turn throws a sheet off the bow
    const lat = v * c.yawRate;
    if (Math.abs(lat) > 2.5) {
      rig.bow += dt * Math.min(60, Math.abs(lat) * 5);
      const side = -Math.sign(lat); // the outside
      while (rig.bow >= 1) {
        rig.bow -= 1;
        const along = 0.3 - Math.random() * 1.2;
        this.spray.emit(
          c.x + fx * along + lx * side * 0.6,
          w + 0.15,
          c.z + fz * along + lz * side * 0.6,
          c.vx * 0.6 + lx * side * (2.5 + Math.random() * 2.5),
          1.4 + Math.random() * 1.8,
          c.vz * 0.6 + lz * side * (2.5 + Math.random() * 2.5),
          0.5 + Math.random() * 0.4,
        );
      }
    }
  }

  /** The model where the physics says: pitched, leaning, the rider hanging off the inside. */
  private pose(i: number, dt: number) {
    const r = this.racers[i];
    const rig = this.rigs[i];
    const c = r.c;
    rig.root.position.set(c.x, c.y, c.z);
    rig.root.rotation.set(c.pitch, c.h, c.roll, 'YXZ');
    // the rider leans further in than the hull, crouches on landings and stands into the bumps
    rig.lean += (c.roll * 0.7 - rig.lean) * Math.min(1, dt * 6);
    rig.rider.rotation.set(-0.08 - Math.min(0.2, Math.max(0, c.vy) * 0.03) + (c.air ? -0.1 : 0), c.steer * 0.12, rig.lean);
    rig.rider.position.y = SADDLE.y + (c.stunT > 0 ? -0.05 : 0) + (c.air ? 0.04 : 0);
    const pov = i === 0 && this.cam === 'pov' && this.active;
    if (rig.body) {
      // (in the rider's-eye view your own body is out of shot below the camera: not drawn at all)
      rig.rider.visible = true;
      const cam = this.ctx.camera.position;
      const dist = Math.hypot(cam.x - c.x, cam.y - c.y, cam.z - c.z);
      rig.body.update(dt, { steer: c.steer, throttle: Math.max(0, c.throttle), air: c.air, dist }, rig.root.visible && !pov);
    } else rig.rider.visible = !pov;
  }

  /** The navigation lights follow their skis (bow pair, stern light). */
  private poseNavLights() {
    if (!this.navLights.visible) return;
    const o = this.origin;
    for (let i = 0; i < this.racers.length; i++) {
      const rig = this.rigs[i];
      const show = rig.root.visible;
      rig.root.updateMatrixWorld();
      const pts: [number, number, number][] = [
        [-0.17, 0.7, -1.25],
        [0.17, 0.7, -1.25],
        [0, 1.02, 1.1],
      ];
      pts.forEach(([x, y, z], k) => {
        this.v1.set(x, y, z).applyMatrix4(rig.root.matrixWorld).sub(o);
        this.m.makeTranslation(this.v1.x, this.v1.y, this.v1.z);
        if (!show) this.m.makeScale(0, 0, 0);
        this.navLights.setMatrixAt(i * 3 + k, this.m);
      });
    }
    this.navLights.instanceMatrix.needsUpdate = true;
  }

  /** How loud something at (x, z) is where the camera is (0 out of earshot .. 1 right there). */
  private hearing(x: number, z: number) {
    const cam = this.ctx.camera.position;
    const d = Math.hypot(x - cam.x, z - cam.z, cam.y - SEA_Y);
    return Math.max(0, 1 - d / 80);
  }

  private engineSound() {
    const sfx = this.ctx.sfx;
    if (this.active) {
      const c = this.me.c;
      const v = Math.abs(forwardSpeed(c));
      const rev = this.phase === 'grid' ? Math.max(0, this.input?.throttle ?? 0) * 0.6 : 0;
      // the engine screams as the jet comes out of the water in the air
      const rpm = Math.max(rev, Math.min(1, (v / VMAX) * 0.75 + Math.max(0, c.throttle) * 0.3 + (c.air && c.throttle > 0 ? 0.25 : 0)));
      sfx.boatEngine(true, rpm);
      if (c.boosting && !this.boostWas) sfx.whoosh(1.6);
      this.boostWas = c.boosting;
      return;
    }
    // heard from the beach or the dock: the nearest rival
    let near = 0;
    let rpm = 0;
    for (let i = 1; i < this.racers.length; i++) {
      const c = this.racers[i].c;
      const k = this.hearing(c.x, c.z);
      if (k > near) {
        near = k;
        rpm = Math.min(1, forwardSpeed(c) / VMAX);
      }
    }
    sfx.boatEngine(near > 0.05, rpm * (0.35 + 0.65 * near) * near);
  }

  /** The dock's spectators bounce and wave when skis come past. */
  private cheer(t: number, dt: number) {
    const { body, head } = this.fans;
    const spots = body.userData.spots as { x: number; y: number; z: number }[];
    let near = 0;
    for (const r of this.racers) {
      if (r === this.me && !this.active) continue;
      near = Math.max(near, 1 - Math.hypot(r.c.x - DOCK_X, r.c.z - DOCK_Z) / 70);
    }
    const k = (body.userData.k ?? 0) + (Math.max(0, near) - (body.userData.k ?? 0)) * Math.min(1, dt * 3);
    if (k < 0.01 && body.userData.k !== undefined && body.userData.k < 0.01) return;
    body.userData.k = k;
    const o = this.origin;
    spots.forEach((s, i) => {
      const jump = Math.max(0, Math.sin(t * 9 + i * 1.7)) * 0.18 * k;
      const sway = Math.sin(t * 2 + i) * 0.04;
      this.e.set(0, Math.PI + Math.sin(i * 2.3) * 0.5, sway);
      this.m.compose(this.v1.set(s.x - o.x, s.y - o.y + jump, s.z - o.z), this.q.setFromEuler(this.e), this.one);
      body.setMatrixAt(i, this.m);
      head.setMatrixAt(i, this.m);
    });
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ HUD and camera

  private $(id: string) {
    return this.hudEl.querySelector<HTMLElement>(`#${id}`)!;
  }

  private toast(text: string) {
    const el = this.$('js-toast');
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.toastTimer = 2.6;
  }

  private updateHud(dt: number) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.$('js-toast').hidden = true;
    }
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    const me = this.me;
    const order = standings(this.racers);
    const pos = this.place || order.indexOf(me) + 1;
    this.$('js-pos').textContent = String(pos);
    this.$('js-pos-suf').textContent = ordinal(pos);
    this.$('js-lap').textContent = `${Math.min(LAPS, Math.max(1, me.laps + 1))}/${LAPS}`;
    this.$('js-time').textContent = fmt(me.finished ?? this.raceT + me.penalty);
    this.$('js-speed').textContent = `${Math.round(Math.max(0, forwardSpeed(me.c)) * 3.6)} km/h`;
    const bar = this.$('js-surf');
    (bar.firstElementChild as HTMLElement).style.width = `${me.c.surf * 100}%`;
    bar.classList.toggle('is-on', me.c.boosting);
    this.$('js-board').innerHTML = order
      .map((r, i) => `<li class="${r === me ? 'is-me' : ''}"><i style="background:${r.color}"></i>${i + 1}. ${r === me ? 'You' : r.name}</li>`)
      .join('');
  }

  /** What the camera follows (for shadows and grass LOD): your ski, or the dock while nobody races. */
  get focus() {
    const c = this.me.c;
    return this.active ? new THREE.Vector3(c.x, 0, c.z) : new THREE.Vector3(DOCK_X, 0, DOCK_Z);
  }

  /** Your ski, for the minimap. */
  get position() {
    return this.rigs[0].root.position;
  }

  /** Your ski's state (read-only use: the preview and anything that wants to know you're airborne). */
  get ski(): Readonly<Craft> {
    return this.me.c;
  }

  /** Where the round is: idle (ghost laps), on the grid, racing, or past the flag. */
  get stage(): Phase {
    return this.phase;
  }

  /** Past the flag: the race ran to its end, and leaving now (Esc) is no early exit. */
  get finished(): boolean {
    return this.active && this.phase === 'done';
  }

  get yaw() {
    return this.me.c.h;
  }

  /** Every ski on the water (yours first, while racing), for the minimap. */
  get markers() {
    return this.racers.filter((_, i) => i > 0 || this.active).map((r) => ({ x: r.c.x, z: r.c.z, color: r.color }));
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const r = this.me;
    const c = r.c;
    const fx = -Math.sin(c.h);
    const fz = -Math.cos(c.h);
    const v = forwardSpeed(c);
    const w = this.water(c.x, c.z);
    if (this.cam === 'pov') {
      // the rider's eyes, over the bars
      const rig = this.rigs[0].root;
      rig.updateMatrixWorld();
      const eye = this.v1.set(0, SADDLE.y + 0.82, SADDLE.z - 0.42).applyMatrix4(rig.matrixWorld);
      camera.position.copy(eye);
      // the view pitches and banks with the hull, but only partly: a full lean would tip the
      // horizon over in every carve; tipped down a touch so the bars sit at the bottom of the view
      camera.up.set(0, 1, 0);
      camera.quaternion.setFromEuler(this.e.set(c.pitch * 0.6 - 0.1, c.h, c.roll * 0.2, 'YXZ'));
      const ahead = this.v2.set(0, 0, -12).applyQuaternion(camera.quaternion).add(eye);
      this.camPos.copy(eye);
      this.camLook.copy(ahead);
    } else {
      camera.up.set(0, 1, 0);
      // behind the direction of travel when moving (so a slide or a spin doesn't whip it round)
      const sp = Math.hypot(c.vx, c.vz);
      const dx = sp > 4 && v > 0 ? c.vx / sp : fx;
      const dz = sp > 4 && v > 0 ? c.vz / sp : fz;
      const high = this.cam === 'high';
      const back = high ? 18 : 8.2 + Math.max(0, v) * 0.07;
      // a rival tucked in behind you, between you and the camera: climb to see over them
      let blocked = 0;
      if (!high)
        for (const o of this.rivals) {
          const ox = o.c.x - c.x;
          const oz = o.c.z - c.z;
          const behind = -(ox * dx + oz * dz);
          if (behind > 1 && behind < back && Math.abs(ox * dz - oz * dx) < 2.2) blocked = 1;
        }
      this.lift += (blocked * 2.6 - this.lift) * Math.min(1, dt * 2);
      const up = high ? 10 : 2.5 + this.lift;
      // over the water, rising with the ski off a jump (but less than it, so the air shows)
      const want = this.v1.set(c.x - dx * back, Math.max(w, w + (c.y - w) * 0.35) + up, c.z - dz * back);
      const look = this.v2.set(c.x + fx * 4, c.y + 0.9, c.z + fz * 4);
      // past the flag the camera swings round in front, looking back at you with the arch behind
      const lap = this.phase === 'done' && !high;
      if (lap) {
        const k = Math.min(1, this.phaseT / 1.5);
        want.set(c.x + fx * 9 * k - dx * back * (1 - k) + fz * 3.5 * k, w + 2 + k * 0.4, c.z + fz * 9 * k - dz * back * (1 - k) - fx * 3.5 * k);
        look.set(c.x, c.y + 1, c.z);
      }
      want.y = Math.max(want.y, this.water(want.x, want.z) + 0.8);
      this.camPos.lerp(want, 1 - Math.exp(-dt * (high ? 3 : lap ? 3 : 5)));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 9));
      camera.position.copy(this.camPos);
      camera.lookAt(this.camLook);
    }
    if (this.shake > 0) {
      camera.position.x += (Math.random() - 0.5) * this.shake;
      camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }
    // a wider view at speed, wider still on the boost
    const base = camera.aspect < 0.8 ? 58 : 42;
    const fov = base + Math.min(1, Math.max(0, v) / VTOP) * 8 + (c.boosting ? 6 : 0);
    const next = camera.fov + (fov - camera.fov) * Math.min(1, dt * 4);
    if (Math.abs(next - camera.fov) > 0.01) {
      camera.fov = next;
      camera.updateProjectionMatrix();
    }
  }
}

