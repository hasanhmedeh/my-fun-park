import * as THREE from 'three';
import type { Attraction, Ctx } from '../../context';
import type { Input } from '../../input';
import { SEA_Y } from '../../geo';
import { waveY } from '../../sea';
import { canvasTex } from '../../textures';
import { escapeHtml } from '../../ui';
import { mulberry } from '../../random';
import { Fort, FORT_VIEWS } from './cannons-fort';
import { Fx } from './cannons-fx';
import { buildShipModel, HIT_POINTS, setFleetTime, Ship, SHIP_KINDS, type ShipKind, type ShipModel } from './cannons-ships';
import {
  AIM,
  angleDiff,
  bearing,
  DRAG,
  ELEV_MAX,
  ELEV_MIN,
  FORT,
  fortToWorld,
  GRAVITY,
  GUNS,
  lanePoint,
  laneLength,
  LANES,
  lay,
  multiplier,
  muzzle,
  MUZZLE_V,
  segmentHitsBox,
  shotAt,
  TRAVERSE,
  type Shot,
} from './cannons-sim';
import './cannons.css';

/** A round (one ticket) lasts this long. */
export const CANNONS_ROUND = 60;
/** Each gun takes this long to sponge, load and run out again after it fires. */
const RELOAD = 2.8;
/** How fast the crews can train (turn) and elevate a gun, radians a second. */
const TRAIN_RATE = THREE.MathUtils.degToRad(48);
const ELEV_RATE = THREE.MathUtils.degToRad(16);
/** How fast the keys or the joystick move the aim: radians a second across, and metres a second out (at 400 m). */
const AIM_TURN = 0.5;
const AIM_RUN = 340;
/** A fired gun's scatter (radians): the powder and the ball are never quite the same twice. */
const SCATTER = THREE.MathUtils.degToRad(0.14);
/** How long the last balls' flight and splashes show before the round wraps up on its own. */
const LAST_LOOK = 2.4;
/** A sunk ship's replacement sails in out of the haze after this long. */
const RESPAWN = [3, 6] as const;
/** The powder kegs' blast sinks or holes every ship this close. */
const BLAST = 70;
const SPEED_OF_SOUND = 343;
/** The least angle the aiming mark is seen at (radians), however flat the view across the sea. */
const MARK_TILT = THREE.MathUtils.degToRad(32);
const FORT_HEADING = THREE.MathUtils.degToRad(FORT.heading);

const $ = (id: string) => document.getElementById(id)!;

type Cam = 'battery' | 'lookout';
const CAM_LABEL: Record<Cam, string> = { battery: 'Battery', lookout: 'Lookout' };

/** Which ships sail which lane, spaced evenly round it. */
const FLEET: { lane: number; kinds: ShipKind[] }[] = [
  { lane: 0, kinds: ['sloop', 'brig', 'sloop'] },
  { lane: 1, kinds: ['brig', 'keg'] },
  { lane: 2, kinds: ['galleon', 'sloop'] },
];

interface Ball {
  shot: Shot;
  t: number;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  trail: number;
  live: boolean;
}

/** A round's numbers. */
interface Tally {
  score: number;
  shots: number;
  hits: number;
  streak: number;
  bestStreak: number;
  sunk: number;
}

const BEST_KEY = 'fair-cannons';

/** The visitor's best round so far, from this browser (null when none or storage is off). */
function loadBest(): { score: number; sunk: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) ?? 'null') as { score?: unknown; sunk?: unknown } | null;
    return v && typeof v.score === 'number' && typeof v.sunk === 'number' ? { score: v.score, sunk: v.sunk } : null;
  } catch {
    return null;
  }
}

function saveBest(b: { score: number; sunk: number }) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable */
  }
}

/** The aiming mark: a ring with four ticks, painted once. */
function markTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  // drawn twice: a dark edge first, so the mark reads against bright water as well as dark
  for (const [colour, extra] of [['rgba(29, 18, 56, 0.6)', 4], ['#ffffff', 0]] as const) {
    g.strokeStyle = colour;
    g.lineWidth = 7 + extra;
    g.beginPath();
    g.arc(64, 64, 44, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 5 + extra;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      g.beginPath();
      g.moveTo(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30);
      g.lineTo(64 + Math.cos(a) * 58, 64 + Math.sin(a) * 58);
      g.stroke();
    }
  }
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(64, 64, 5, 0, Math.PI * 2);
  g.fill();
  return canvasTex(c);
}

/**
 * Pirate Cannons: Fort Cutlass's battery on Palm Cay's south-west beach. The visitor mans three
 * old long guns for 60 seconds while a pirate fleet (sloops, brigs, a galleon and a sloop loaded
 * with powder kegs) sails the lagoon at 250 to 650 m. Point at the sea (mouse, keys or joystick)
 * and fire (click, E, Space or a tap): the next loaded gun trains and elevates on the spot, and
 * its ball flies a real arc (gravity, a little drag, and the breeze pushing it), so leading a
 * moving ship and allowing for the wind is the game. Hits splinter and set ships smoking; enough
 * of them and a ship lists, settles and goes down; the powder-keg sloop goes up in one shot and
 * takes its neighbours with it. Hits in a row raise a streak multiplier.
 */
export class Cannons implements Attraction {
  private fort: Fort;
  private fx: Fx;
  readonly ships: Ship[] = [];
  private respawnAt = new Map<Ship, number>();
  private balls: Ball[] = [];
  private ballMesh: THREE.InstancedMesh;
  private mark: THREE.Mesh;
  private markMat: THREE.MeshBasicMaterial;
  private dots: THREE.InstancedMesh;
  private tag: HTMLDivElement;
  /** The aim: a bearing (radians from north) and range (m) from the middle gun. */
  private aim = { brg: FORT_HEADING, range: 330 };
  private readonly battery = new THREE.Vector3();
  private readonly focusAt = new THREE.Vector3(FORT.x, 0, FORT.z);
  private reloadT = GUNS.map(() => 0);
  private laid = GUNS.map(() => ({ yaw: 0, elev: 0, ok: true }));
  private tally: Tally = { score: 0, shots: 0, hits: 0, streak: 0, bestStreak: 0, sunk: 0 };
  private final: Record<string, number> | null = null;
  private timeLeft = 0;
  private elapsed = 0;
  private overT = -1;
  private done = false;
  private best = loadBest();
  private wind = { fromDeg: 120, kt: 10 };
  private windSet = false;
  private readonly windVec = new THREE.Vector3();
  private awake = true;
  private cam: Cam = 'battery';
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private hudT = 0;
  private toastT = 0;
  private calls: { at: number; fn: () => void }[] = [];
  private t = 0;
  private rnd = mulberry(1701);
  private sparkT = 0;
  private ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEA_Y);
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly la = new THREE.Vector3();
  private readonly lb = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p2 = { x: 0, z: 0 };
  private readonly lp = { x: 0, z: 0, tx: 0, tz: 0 };
  active = false;
  input: Input | null = null;
  onFinish: (() => void) | null = null;
  /** The clock ran out and the last shot has landed: the round is over. Fired once. */
  onComplete: (() => void) | null = null;
  /** A shot landed: its points (0 for a miss), and the round's score so far. */
  onShot: ((points: number, score: number) => void) | null = null;

  constructor(private ctx: Ctx) {
    this.fort = new Fort(ctx);
    ctx.scene.add(this.fort.group);
    this.fx = new Fx(ctx);
    ctx.scene.add(this.fx.group);
    fortToWorld(GUNS[1].lx, GUNS[1].lz, this.p2);
    this.battery.set(this.p2.x, GUNS[1].y, this.p2.z);
    // the fleet: one model per kind, shared by every ship of that kind
    const models = new Map<ShipKind, ShipModel>();
    const rigging = ctx.quality.tier === 'high' || ctx.quality.tier === 'medium';
    let seed = 11;
    for (const f of FLEET)
      for (const kind of f.kinds) {
        if (!models.has(kind)) models.set(kind, buildShipModel(kind));
        const ship = new Ship(kind, models.get(kind)!, LANES[f.lane], seed++ * 97, rigging);
        ctx.scene.add(ship.group);
        this.ships.push(ship);
      }
    this.layFleet();
    // the balls in flight (drawn bigger with distance, so the eye can follow one)
    this.ballMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ color: '#1c1b1b', roughness: 0.4, metalness: 0.6 }), 8);
    this.ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ballMesh.frustumCulled = false;
    this.ballMesh.count = 0;
    ctx.scene.add(this.ballMesh);
    // the aiming mark on the water, and the arc the next gun's ball would fly (no wind); both
    // unfogged, since at 300 m and more the haze would wash them out against the pale lagoon
    this.markMat = new THREE.MeshBasicMaterial({ map: markTexture(), color: '#fff5e3', transparent: true, opacity: 0.9, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.mark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.markMat);
    this.mark.renderOrder = 6;
    this.mark.visible = false;
    ctx.scene.add(this.mark);
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ color: '#fff5e3', transparent: true, opacity: 0.75, depthWrite: false, fog: false }), 40);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 6;
    this.dots.visible = false;
    ctx.scene.add(this.dots);
    // the HUD, and the range tag that follows the mark
    this.buildHud();
    this.tag = document.createElement('div');
    this.tag.className = 'cn-tag';
    this.tag.hidden = true;
    document.body.appendChild(this.tag);
    const canvas = ctx.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (this.active && !this.done) this.pointAt(e);
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active || this.done || (e.pointerType === 'mouse' && e.button !== 0)) return;
      this.pointAt(e);
      this.fire();
    });
    this.setNight(0);
  }

  private buildHud() {
    const hud = document.createElement('div');
    hud.id = 'cn-hud';
    hud.className = 'ride-hud cn-hud';
    hud.hidden = true;
    hud.innerHTML = `
      <div class="rh-top">
        <p class="cn-clock"><b id="cn-time">60</b><span>s</span></p>
        <p class="cn-points"><b id="cn-score">0</b><span>pts</span></p>
      </div>
      <div class="cn-streak"><span class="cn-mult" id="cn-mult">×1</span><span id="cn-streak">Streak 0</span><span class="cn-best" id="cn-best"></span></div>
      <div class="cn-guns" id="cn-guns" aria-label="Guns">${GUNS.map((_, i) => `<i><b></b><span>${i + 1}</span></i>`).join('')}</div>
      <dl class="rh-stats">
        <div><dt>Sunk</dt><dd id="cn-sunk">0</dd></div>
        <div><dt>Hits</dt><dd id="cn-hits">0 / 0</dd></div>
        <div><dt>Wind</dt><dd><i class="cn-wind" id="cn-wind" aria-hidden="true">➤</i> <span id="cn-windkt">10 kt</span></dd></div>
      </dl>
      <p class="rh-keys"><span id="cn-keys"></span> · Cam: <span id="cn-cam">Battery</span></p>
      <p class="rh-toast" id="cn-toast" hidden></p>`;
    const root = document.getElementById('hud') ?? document.body;
    root.insertBefore(hud, document.getElementById('panel'));
  }

  /** Puts the whole fleet back on station: spaced evenly round their lanes, sailing (a fresh round). */
  private layFleet() {
    for (const f of FLEET) {
      const lane = LANES[f.lane];
      const L = laneLength(lane);
      const mine = this.ships.filter((s) => s.lane === lane);
      const off = this.rnd() * L;
      mine.forEach((s, i) => s.respawn(off + (i * L) / mine.length, true));
    }
    this.respawnAt.clear();
  }

  /** A replacement ship sails in where it is furthest from the fort and from the others on its lane. */
  private bringIn(ship: Ship) {
    const L = laneLength(ship.lane);
    let bestS = 0;
    let bestScore = -1e9;
    for (let i = 0; i < 24; i++) {
      const s = (i / 24) * L;
      lanePoint(ship.lane, s, this.lp);
      const far = Math.hypot(this.lp.x - this.battery.x, this.lp.z - this.battery.z);
      let gap = 1e9;
      for (const o of this.ships)
        if (o !== ship && o.lane === ship.lane && o.state !== 'gone') {
          const d = Math.abs((((o.s - s) % L) + L * 1.5) % L - L / 2);
          gap = Math.min(gap, L / 2 - d);
        }
      const score = far + Math.min(gap, 250) * 2;
      if (score > bestScore) {
        bestScore = score;
        bestS = s;
      }
    }
    ship.respawn(bestS);
  }

  /** The breeze over the lagoon (from `fromDeg`, in knots): the ball drifts with it, the smoke and flags stream. */
  setWind(fromDeg: number, kt: number) {
    this.wind = { fromDeg, kt };
    this.windSet = true;
    this.applyWind();
  }

  private applyWind() {
    const to = THREE.MathUtils.degToRad(this.wind.fromDeg + 180);
    const ms = this.wind.kt * 0.514444;
    this.windVec.set(Math.sin(to) * ms, 0, -Math.cos(to) * ms);
    this.fx.setWind(this.windVec.x * 0.8, this.windVec.z * 0.8);
  }

  /** Only while the visitor is on Palm Cay: elsewhere the fleet and the fort's effects sleep. */
  setAwake(on: boolean) {
    this.awake = on;
  }

  setNight(k: number) {
    this.fort.setNight(k);
    this.fx.setNight(k);
    for (const s of this.ships) s.setNight(k);
  }

  /** Where to stand to play: outside the fort's gate, facing it (the zone ring). */
  get standSpot() {
    const p = fortToWorld(FORT_VIEWS.gate.x, FORT_VIEWS.gate.z);
    // facing the gate: the fort's +x, i.e. compass FORT.heading + 90°; yaw is −heading in the park's convention
    const yaw = -THREE.MathUtils.degToRad(FORT.heading + 90);
    return { x: p.x, z: p.z, heading: Math.atan2(Math.sin(yaw), Math.cos(yaw)) };
  }

  /** A ground point for the shadows and the environment: the battery. */
  get focus() {
    return this.focusAt;
  }

  /** The clock ran out (the last look at the sea, or done): leaving now is no early exit. */
  get finished(): boolean {
    return this.active && (this.done || this.overT >= 0);
  }

  get secondsLeft() {
    return Math.max(0, this.timeLeft);
  }

  get score() {
    return this.tally.score;
  }

  get sunk() {
    return this.tally.sunk;
  }

  /** The fleet for the minimap: each ship afloat and where it is. */
  get markers() {
    return this.ships.filter((s) => s.state !== 'gone').map((s) => ({ x: s.group.position.x, z: s.group.position.z, heading: s.heading, label: s.name }));
  }

  start() {
    this.active = true;
    this.done = false;
    this.timeLeft = CANNONS_ROUND;
    this.elapsed = 0;
    this.overT = -1;
    this.final = null;
    this.tally = { score: 0, shots: 0, hits: 0, streak: 0, bestStreak: 0, sunk: 0 };
    this.reloadT = GUNS.map(() => 0);
    this.aim = { brg: FORT_HEADING, range: 330 };
    this.best = loadBest();
    // a fresh breeze for each round (unless the weather has set one), mostly the trade wind off the east
    if (!this.windSet) this.wind = { fromDeg: 85 + this.rnd() * 90, kt: 6 + Math.round(this.rnd() * 10) };
    this.applyWind();
    this.layFleet();
    this.cam = 'battery';
    this.camPos.copy(this.ctx.camera.position);
    this.camLook.copy(this.aimPoint(this.v1));
    $('cn-hud').hidden = false;
    $('cn-toast').hidden = true;
    $('cn-keys').innerHTML = this.ctx.mobile ? 'Tap the sea to fire · stick aims' : '<kbd>Mouse</kbd> aim · <kbd>Click</kbd> / <kbd>E</kbd> fire · <kbd>WASD</kbd> nudge';
    $('cn-cam').textContent = CAM_LABEL[this.cam];
    document.body.classList.add('is-cannons');
    this.mark.visible = true;
    this.dots.visible = true;
    this.tag.hidden = false;
    this.hudT = 0;
    this.updateHud();
    this.ctx.sfx.chime();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.final = this.measure();
    this.recordBest();
    $('cn-hud').hidden = true;
    document.body.classList.remove('is-cannons');
    this.mark.visible = false;
    this.dots.visible = false;
    this.tag.hidden = true;
    this.ctx.ui.countdown(null);
    const cam = this.ctx.camera;
    cam.fov = cam.aspect < 0.8 ? 58 : 42;
    cam.updateProjectionMatrix();
    this.onFinish?.();
  }

  private recordBest() {
    const t = this.tally;
    if (!t.shots) return;
    const b = this.best;
    if (!b || t.score > b.score || t.sunk > b.sunk) {
      this.best = { score: Math.max(t.score, b?.score ?? 0), sunk: Math.max(t.sunk, b?.sunk ?? 0) };
      saveBest(this.best);
    }
  }

  /** This round's numbers (see account/stats.ts); valid mid-round too. */
  roundStats(): Record<string, number> {
    return this.final ?? this.measure();
  }

  private measure(): Record<string, number> {
    const t = this.tally;
    const durationS = Math.round(this.elapsed * 10) / 10;
    if (!t.shots) return { score: 0, shots: 0, durationS };
    return { score: t.score, shipsSunk: t.sunk, accuracy: Math.round((t.hits / t.shots) * 100), bestStreak: t.bestStreak, shots: t.shots, durationS };
  }

  /** E, Space or the touch button: fire the next loaded gun at the mark. */
  action() {
    this.fire();
  }

  cycleCamera() {
    this.cam = this.cam === 'battery' ? 'lookout' : 'battery';
    $('cn-cam').textContent = CAM_LABEL[this.cam];
    this.ctx.sfx.pop();
  }

  /** The card Game shows while playing (hidden at the first shot): how to aim and what each ship is worth. */
  panelHtml(touch: boolean) {
    const controls = touch
      ? 'Tap the sea where you want the ball to land (or aim with the joystick and press <kbd>E</kbd>).'
      : 'Point at the sea with the <strong>mouse</strong> (or <kbd>WASD</kbd> / arrows) and click (or <kbd>E</kbd> / <kbd>Space</kbd>) to fire.';
    const k = SHIP_KINDS;
    return `<p class="eyebrow">Pirate Cannons · ${CANNONS_ROUND} seconds</p><h2>Sink the fleet! 🏴‍☠️</h2><p>${controls} The ball takes a few seconds to get there: <strong>lead</strong> the ships, and allow for the wind. Three guns, each ${RELOAD.toFixed(1)} s to reload; hits in a row raise your multiplier.</p><ul class="tags"><li>${escapeHtml(k.sloop.name)} · ${k.sloop.hp} hits · ${k.sloop.sinkBonus} pts</li><li>${escapeHtml(k.brig.name)} · ${k.brig.hp} hits · ${k.brig.sinkBonus} pts</li><li>${escapeHtml(k.galleon.name)} · ${k.galleon.hp} hits · ${k.galleon.sinkBonus} pts</li><li>💥 Powder kegs · 1 hit · boom</li></ul>`;
  }

  // ----------------------------------------------------------------------------------------------
  // Aiming and firing
  // ----------------------------------------------------------------------------------------------

  private aimPoint(out: THREE.Vector3) {
    return out.set(this.battery.x + Math.sin(this.aim.brg) * this.aim.range, SEA_Y, this.battery.z - Math.cos(this.aim.brg) * this.aim.range);
  }

  private clampAim() {
    const d = THREE.MathUtils.clamp(angleDiff(this.aim.brg, FORT_HEADING), -AIM.arc, AIM.arc);
    this.aim.brg = FORT_HEADING + d;
    this.aim.range = THREE.MathUtils.clamp(this.aim.range, AIM.minRange, AIM.maxRange);
  }

  /** The aim follows the pointer: wherever it points on the sea (or out towards the horizon, at full range). */
  private pointAt(e: PointerEvent) {
    const r = this.ctx.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.ctx.camera);
    const dir = this.ray.ray.direction;
    const hit = dir.y < -0.002 ? this.ray.ray.intersectPlane(this.plane, this.v1) : null;
    if (hit) {
      this.aim.brg = bearing(this.battery.x, this.battery.z, hit.x, hit.z);
      this.aim.range = Math.hypot(hit.x - this.battery.x, hit.z - this.battery.z);
    } else {
      this.aim.brg = Math.atan2(dir.x, -dir.z);
      this.aim.range = AIM.maxRange;
    }
    this.clampAim();
  }

  /** Each gun's lay for the mark: where its crew will train and elevate it to. */
  private layGuns() {
    const target = this.aimPoint(this.v1);
    GUNS.forEach((g, i) => {
      fortToWorld(g.lx, g.lz, this.p2);
      const l = lay(this.p2.x, g.y, this.p2.z, target.x, target.z);
      const yaw = angleDiff(l.bearing, FORT_HEADING);
      const L = this.laid[i];
      L.ok = Math.abs(yaw) <= TRAVERSE && l.elev > ELEV_MIN && l.elev < ELEV_MAX;
      L.yaw = THREE.MathUtils.clamp(yaw, -TRAVERSE, TRAVERSE);
      L.elev = l.elev;
    });
  }

  /** The gun that will fire next: loaded, able to bear on the mark, and the nearest to laid. */
  private nextGun() {
    let best = -1;
    let err = 1e9;
    GUNS.forEach((_, i) => {
      if (this.reloadT[i] > 0 || !this.laid[i].ok) return;
      const p = this.fort.poses[i];
      const e = Math.abs(p.yaw - this.laid[i].yaw) + Math.abs(p.elev - this.laid[i].elev);
      if (e < err) {
        err = e;
        best = i;
      }
    });
    return best;
  }

  /** The muzzle of gun i as it points now, and its ball's launch. */
  private launch(i: number, scatter: boolean, out: Shot) {
    const g = GUNS[i];
    const p = this.fort.poses[i];
    fortToWorld(g.lx, g.lz, this.p2);
    const brg = FORT_HEADING + p.yaw + (scatter ? (this.rnd() - 0.5) * 2 * SCATTER : 0);
    const elev = p.elev + (scatter ? (this.rnd() - 0.5) * 2 * SCATTER : 0);
    const m = muzzle(this.p2.x, g.y, this.p2.z, brg, elev, this.v2);
    const ch = Math.cos(elev) * MUZZLE_V;
    out.x0 = m.x;
    out.y0 = m.y;
    out.z0 = m.z;
    out.vx = Math.sin(brg) * ch;
    out.vy = Math.sin(elev) * MUZZLE_V;
    out.vz = -Math.cos(brg) * ch;
    out.wx = scatter ? this.windVec.x : 0;
    out.wz = scatter ? this.windVec.z : 0;
    return out;
  }

  private fire() {
    if (!this.active || this.done || this.timeLeft <= 0) return;
    const i = this.nextGun();
    if (i < 0) {
      // nothing loaded (or nothing that bears): the crews are still at it
      this.ctx.sfx.clack();
      $('cn-guns').classList.remove('cn-nudge');
      void $('cn-guns').offsetWidth;
      $('cn-guns').classList.add('cn-nudge');
      return;
    }
    this.reloadT[i] = RELOAD;
    this.tally.shots++;
    const shot = this.launch(i, true, { x0: 0, y0: 0, z0: 0, vx: 0, vy: 0, vz: 0, wx: 0, wz: 0 });
    const ball = this.balls.find((b) => !b.live) ?? (this.balls.length < 8 ? this.pushBall() : null);
    if (ball) {
      ball.shot = shot;
      ball.t = 0;
      ball.pos.set(shot.x0, shot.y0, shot.z0);
      ball.prev.copy(ball.pos);
      ball.trail = 0;
      ball.live = true;
    }
    this.fx.muzzle(this.v1.set(shot.x0, shot.y0, shot.z0), this.v2.set(shot.vx, shot.vy, shot.vz).normalize());
    this.ctx.sfx.cannonBoom();
  }

  private pushBall() {
    const b: Ball = { shot: { x0: 0, y0: 0, z0: 0, vx: 0, vy: 0, vz: 0, wx: 0, wz: 0 }, t: 0, pos: new THREE.Vector3(), prev: new THREE.Vector3(), trail: 0, live: false };
    this.balls.push(b);
    return b;
  }

  /** Runs `fn` when the sound of something `dist` metres away reaches the fort. */
  private later(dist: number, fn: () => void) {
    this.calls.push({ at: this.t + dist / SPEED_OF_SOUND, fn });
  }

  private toast(text: string, big = false) {
    const el = $('cn-toast');
    el.textContent = text;
    el.classList.toggle('cn-big', big);
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.toastT = big ? 2.4 : 1.5;
  }

  /** A ball comes down in the water: a splash, and the spotter's call (short, over, astern…). */
  private splash(p: THREE.Vector3) {
    const dist = p.distanceTo(this.battery);
    this.fx.splash(p, 1);
    this.later(dist, () => this.ctx.sfx.splash(THREE.MathUtils.clamp(1.15 - dist / 900, 0.25, 1)));
    if (!this.active || this.done) return;
    this.tally.streak = 0;
    this.onShot?.(0, this.tally.score);
    // the nearest ship afloat, if the splash was near enough to call
    let near: Ship | null = null;
    let nd = 90;
    for (const s of this.ships) {
      if (!s.alive) continue;
      const d = Math.hypot(s.group.position.x - p.x, s.group.position.z - p.z);
      if (d < nd) {
        nd = d;
        near = s;
      }
    }
    if (!near) return this.toast('Splash!');
    const sp = near.group.position;
    const fx = Math.sin(near.heading);
    const fz = -Math.cos(near.heading);
    const along = (p.x - sp.x) * fx + (p.z - sp.z) * fz;
    const half = near.spec.length / 2 + 2;
    if (along < -half) this.toast('Astern! Lead her more');
    else if (along > half) this.toast('Ahead of her bow!');
    else this.toast(Math.hypot(p.x - this.battery.x, p.z - this.battery.z) < Math.hypot(sp.x - this.battery.x, sp.z - this.battery.z) ? 'Short!' : 'Over!');
  }

  /** A ball strikes a ship at `p` (world) / `local` (its frame). */
  private strike(ship: Ship, p: THREE.Vector3, local: THREE.Vector3, dir: THREE.Vector3) {
    const dist = p.distanceTo(this.battery);
    this.fx.hit(p, dir, ship.spec.hull === '#1f1b1a' ? '#3a2e26' : '#6b4a2c');
    this.later(dist, () => this.ctx.sfx.whack());
    const t = this.tally;
    const scoring = this.active && !this.done;
    if (scoring) {
      t.hits++;
      t.streak++;
      t.bestStreak = Math.max(t.bestStreak, t.streak);
    }
    const mult = multiplier(t.streak);
    let points = scoring ? HIT_POINTS * mult : 0;
    const sank = ship.hit(local);
    if (sank) {
      if (scoring) {
        t.sunk++;
        points += ship.spec.sinkBonus * mult;
      }
      if (ship.kind === 'keg') points += this.blowUp(ship, mult, scoring);
      else {
        this.later(dist, () => this.ctx.sfx.cheer(0.5));
        if (scoring) this.toast(`${ship.name} is going down! +${points}`, true);
      }
    } else if (scoring) this.toast(`Hit! +${points}${mult > 1 ? `  (×${mult})` : ''}`);
    if (!scoring) return;
    t.score += points;
    this.onShot?.(points, t.score);
  }

  /** The powder kegs go up: the blast holes (or sinks) every ship within BLAST metres. Returns the extra points. */
  private blowUp(keg: Ship, mult: number, scoring: boolean) {
    const p = keg.group.position.clone();
    const dist = p.distanceTo(this.battery);
    this.fx.explosion(p.clone().setY(waveY(p.x, p.z, this.t)));
    this.fx.shake = Math.min(2.5, this.fx.shake + THREE.MathUtils.clamp(500 / dist, 0.4, 2));
    this.later(dist, () => {
      this.ctx.sfx.cannonBoom();
      this.ctx.sfx.rumble(1.6);
      this.ctx.sfx.splash(2);
      this.ctx.sfx.cheer(1);
    });
    let extra = 0;
    let chain = 0;
    for (const s of this.ships) {
      if (s === keg || !s.alive) continue;
      const d = s.group.position.distanceTo(p);
      if (d > BLAST) continue;
      s.toLocal(p, this.la);
      this.la.set(Math.sign(this.la.x || 1) * s.spec.beam * 0.5, s.spec.freeboard, THREE.MathUtils.clamp(this.la.z, -s.spec.length / 2, s.spec.length / 2));
      // one hit for the near ones, two for any right alongside
      for (let k = d < BLAST * 0.45 ? 2 : 1; k > 0 && s.alive; k--) {
        if (s.hit(this.la)) {
          chain++;
          if (scoring) {
            this.tally.sunk++;
            extra += s.spec.sinkBonus * mult;
          }
        }
      }
    }
    if (scoring) this.toast(chain ? `KABOOM! ${chain} more sunk with her! +${keg.spec.sinkBonus * mult + extra + HIT_POINTS * mult}` : `KABOOM! +${keg.spec.sinkBonus * mult + HIT_POINTS * mult}`, true);
    return extra;
  }

  // ----------------------------------------------------------------------------------------------
  // The frame
  // ----------------------------------------------------------------------------------------------

  update(dt: number, t: number) {
    this.t = t;
    if (!this.awake) return;
    // far away (from the air on the way in), only the ships' sailing is worth doing
    const far = this.ctx.camera.position.distanceTo(this.focus) > 2500;
    setFleetTime(t, 0.4 + this.wind.kt / 16);
    const windFrom = THREE.MathUtils.degToRad(this.wind.fromDeg);
    for (const s of this.ships) {
      if (s.state === 'gone') {
        const at = this.respawnAt.get(s);
        if (at === undefined) this.respawnAt.set(s, t + RESPAWN[0] + this.rnd() * (RESPAWN[1] - RESPAWN[0]));
        else if (t >= at) {
          this.respawnAt.delete(s);
          this.bringIn(s);
        }
        continue;
      }
      // heeling away from the breeze on the beam
      const heel = -Math.sin(windFrom - s.heading) * THREE.MathUtils.degToRad(4.5) * Math.min(1.5, this.wind.kt / 14);
      s.update(dt, t, heel);
      if (far) continue;
      for (const w of s.wounds) {
        if ((w.next -= dt) > 0) continue;
        w.next = w.fire ? 0.12 : 0.2;
        this.fx.wound(s.toWorld(w.p, this.v1), w.fire);
      }
      if (s.state === 'sinking') {
        const k = Math.min(3, Math.round(dt * 14 + this.rnd()));
        for (let i = 0; i < k; i++) this.fx.bubbles(this.v1.copy(s.group.position).setY(waveY(s.group.position.x, s.group.position.z, t)), s.spec.length * 0.45);
      }
      if (s.kind === 'keg' && s.alive && s.model.fuse && (this.sparkT -= dt) <= 0) {
        this.sparkT = 0.05;
        this.fx.spark(s.toWorld(s.model.fuse, this.v1));
      }
    }
    if (!far) this.fx.update(dt, t, this.ctx.camera);
    this.fort.update(t);
    this.updateBalls(dt, t);
    for (let i = this.calls.length - 1; i >= 0; i--)
      if (this.calls[i].at <= t) {
        const c = this.calls[i];
        this.calls.splice(i, 1);
        c.fn();
      }
    this.updateGuns(dt);
    if (!this.active) return;
    // the keys or the joystick move the mark (steer is positive to the left)
    if (this.input && !this.done) {
      this.aim.brg -= this.input.steer * AIM_TURN * dt;
      this.aim.range += this.input.throttle * AIM_RUN * dt * (0.4 + this.aim.range / 700);
      this.clampAim();
    }
    if (this.toastT > 0 && (this.toastT -= dt) <= 0) $('cn-toast').hidden = true;
    if ((this.hudT -= dt) <= 0) {
      this.hudT = 0.1;
      this.updateHud();
    }
    if (this.done) return;
    if (this.overT >= 0) {
      this.overT += dt;
      if (this.overT > LAST_LOOK && !this.balls.some((b) => b.live)) {
        this.done = true;
        this.recordBest();
        this.onComplete?.();
      }
      return;
    }
    this.elapsed += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.overT = 0;
      this.ctx.ui.countdown('🏴‍☠️ Cease fire!');
    }
  }

  /** The crews train and elevate each gun on its lay, and run it out again after it has fired. */
  private updateGuns(dt: number) {
    if (this.active) this.layGuns();
    GUNS.forEach((_, i) => {
      const p = this.fort.poses[i];
      const L = this.laid[i];
      const busy = this.reloadT[i] > RELOAD - 1.6;
      // idle (between rounds) the guns rest straight out, a touch of elevation
      const ty = this.active ? L.yaw : 0;
      const te = this.active ? L.elev : THREE.MathUtils.degToRad(2);
      if (!busy) {
        p.yaw += THREE.MathUtils.clamp(ty - p.yaw, -TRAIN_RATE * dt, TRAIN_RATE * dt);
        p.elev += THREE.MathUtils.clamp(te - p.elev, -ELEV_RATE * dt, ELEV_RATE * dt);
      }
      this.reloadT[i] = Math.max(0, this.reloadT[i] - dt);
      // recoil: thrown back at once, held while the crew sponges and loads, then run out
      const since = RELOAD - this.reloadT[i];
      p.recoil = this.reloadT[i] <= 0 ? 0 : since < 0.1 ? since / 0.1 : since < 1.6 ? 1 : Math.max(0, 1 - (since - 1.6) / 1.0);
    });
    this.fort.pose();
  }

  private updateBalls(dt: number, t: number) {
    let n = 0;
    const cam = this.ctx.camera.position;
    for (const b of this.balls) {
      if (!b.live) continue;
      b.t += dt;
      b.prev.copy(b.pos);
      shotAt(b.shot, b.t, b.pos);
      // the trail, so the eye can follow it
      if ((b.trail -= dt) <= 0) {
        b.trail = 0.035;
        this.fx.trail(b.pos);
      }
      // did it pass through a ship's hull on the way?
      let hitShip: Ship | null = null;
      let hitF = 2;
      for (const s of this.ships) {
        if (!s.alive) continue;
        const dx = s.group.position.x - b.pos.x;
        const dz = s.group.position.z - b.pos.z;
        if (dx * dx + dz * dz > (s.spec.length + 20) ** 2) continue;
        s.toLocal(b.prev, this.la);
        s.toLocal(b.pos, this.lb);
        const box = s.model.box;
        const f = segmentHitsBox(this.la, this.lb, box.hx, box.y0, box.y1, box.hz);
        if (f >= 0 && f < hitF) {
          hitF = f;
          hitShip = s;
        }
      }
      if (hitShip) {
        b.live = false;
        const p = this.v1.copy(b.prev).lerp(b.pos, hitF);
        const local = hitShip.toLocal(p, this.v2).clone();
        this.strike(hitShip, p.clone(), local, this.v3.copy(b.pos).sub(b.prev).normalize());
        continue;
      }
      const sea = waveY(b.pos.x, b.pos.z, t);
      if (b.pos.y < sea || b.t > 14) {
        b.live = false;
        // where it actually met the water, between the last two points
        const k = THREE.MathUtils.clamp((b.prev.y - sea) / Math.max(1e-3, b.prev.y - b.pos.y), 0, 1);
        this.splash(this.v1.copy(b.prev).lerp(b.pos, k).setY(sea));
        continue;
      }
      const size = Math.max(0.12, cam.distanceTo(b.pos) * 0.0024);
      this.ballMesh.setMatrixAt(n++, this.m.compose(b.pos, this.q.identity(), this.s.set(size, size, size)));
    }
    this.ballMesh.count = n;
    this.ballMesh.instanceMatrix.needsUpdate = true;
  }

  private updateHud() {
    const t = this.tally;
    const left = Math.ceil(this.secondsLeft);
    $('cn-time').textContent = String(left);
    $('cn-hud').classList.toggle('cn-hurry', left <= 10 && this.overT < 0);
    $('cn-score').textContent = t.score.toLocaleString('en-GB');
    const mult = multiplier(t.streak);
    $('cn-mult').textContent = `×${mult}`;
    $('cn-mult').classList.toggle('on', mult > 1);
    $('cn-streak').textContent = `Streak ${t.streak}`;
    $('cn-best').textContent = this.best ? `Best ${this.best.score.toLocaleString('en-GB')}` : '';
    $('cn-sunk').textContent = String(t.sunk);
    $('cn-hits').textContent = `${t.hits} / ${t.shots}`;
    $('cn-windkt').textContent = `${this.wind.kt} kt`;
    // the arrow points the way the wind blows, as seen from the battery (its "up" is out to sea)
    const rel = this.wind.fromDeg + 180 - FORT.heading;
    $('cn-wind').style.transform = `rotate(${rel - 90}deg)`;
    const guns = $('cn-guns').children;
    for (let i = 0; i < guns.length; i++) {
      const k = 1 - this.reloadT[i] / RELOAD;
      const el = guns[i] as HTMLElement;
      (el.firstElementChild as HTMLElement).style.height = `${Math.round(k * 100)}%`;
      el.classList.toggle('ready', this.reloadT[i] <= 0);
    }
  }

  // ----------------------------------------------------------------------------------------------
  // The camera, the mark and the arc
  // ----------------------------------------------------------------------------------------------

  updateCamera(cam: THREE.PerspectiveCamera, dt: number) {
    cam.up.set(0, 1, 0);
    const fov = this.cam === 'battery' ? (cam.aspect < 0.8 ? 64 : 50) : cam.aspect < 0.8 ? 60 : 46;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    // on narrow screens the view turns with the aim, since it can't take in the whole arc of sea
    const hfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * cam.aspect));
    const pan = this.cam === 'lookout' ? 0.5 : THREE.MathUtils.clamp((75 - hfov) / 45, 0, 0.85);
    const v = FORT_VIEWS[this.cam];
    fortToWorld(v.x, v.z, this.p2);
    const want = this.v1.set(this.p2.x, v.y, this.p2.z);
    const centre = this.v2.set(this.battery.x + Math.sin(FORT_HEADING) * 340, SEA_Y + 4, this.battery.z - Math.cos(FORT_HEADING) * 340);
    const aim = this.aimPoint(this.v3).setY(SEA_Y + 4);
    const look = centre.lerp(aim, pan);
    if (this.cam === 'lookout') look.y = SEA_Y;
    const k = 1 - Math.exp(-dt * 5);
    this.camPos.lerp(want, k);
    this.camLook.lerp(look, k);
    cam.position.copy(this.camPos);
    // the ground shakes when the guns fire (and when the powder goes up)
    const sh = this.fx.shake * (this.cam === 'battery' ? 0.07 : 0.03);
    if (sh > 0) cam.position.add(this.la.set((this.rnd() - 0.5) * sh, (this.rnd() - 0.5) * sh, (this.rnd() - 0.5) * sh));
    cam.lookAt(this.camLook);
    cam.updateMatrixWorld();
    this.drawAim(cam);
  }

  /** The mark on the water, the dotted arc of the next gun's ball, and the range tag. */
  private drawAim(cam: THREE.PerspectiveCamera) {
    if (!this.active) return;
    const p = this.aimPoint(this.v1);
    p.y = waveY(p.x, p.z, this.t) + 0.12;
    const d = cam.position.distanceTo(p);
    const size = THREE.MathUtils.clamp(d * 0.075, 5, 60);
    // seen from the fort the sea is nearly edge-on, so a flat ring would be a sliver: it tilts up
    // towards the camera until it is seen at MARK_TILT or more, its near edge resting on the water
    const graze = Math.atan2(cam.position.y - p.y, Math.hypot(cam.position.x - p.x, cam.position.z - p.z));
    const tilt = Math.max(0, MARK_TILT - graze);
    this.mark.rotation.set(tilt, Math.atan2(cam.position.x - p.x, cam.position.z - p.z), 0, 'YXZ');
    this.mark.position.copy(p).setY(p.y + (size / 2) * Math.sin(tilt));
    this.mark.scale.set(size, 1, size);
    const gun = this.nextGun();
    const ready = gun >= 0;
    this.markMat.color.set(ready ? '#fff5e3' : '#ff8a7a');
    this.markMat.opacity = this.done ? 0 : ready ? 0.92 : 0.55;
    // the arc: from the gun that would fire (or the middle one), as it points now, without the wind
    const g = ready ? gun : 1;
    const shot = this.launch(g, false, { x0: 0, y0: 0, z0: 0, vx: 0, vy: 0, vz: 0, wx: 0, wz: 0 });
    // the dots stop a little short of the mark, where they would bunch up into a smear
    const flight = Math.max(0.5, this.flightTime() * 0.86);
    const n = this.dots.count;
    let used = 0;
    for (let i = 0; i < n; i++) {
      const tt = 0.05 + ((i + 0.5) / n) * flight;
      const q = shotAt(shot, tt, this.v2);
      if (q.y < SEA_Y) break;
      const sz = Math.max(0.05, cam.position.distanceTo(q) * 0.0024);
      this.dots.setMatrixAt(used++, this.m.compose(q, this.q.identity(), this.s.set(sz, sz, sz)));
    }
    for (let i = used; i < n; i++) this.dots.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    this.dots.instanceMatrix.needsUpdate = true;
    (this.dots.material as THREE.MeshBasicMaterial).opacity = this.done ? 0 : ready ? 0.7 : 0.3;
    // the tag beside the mark: the range and how long the ball will fly
    const sp = this.v2.copy(p).project(cam);
    const el = this.ctx.renderer.domElement;
    const visible = sp.z < 1 && Math.abs(sp.x) < 1.1 && Math.abs(sp.y) < 1.1 && !this.done;
    this.tag.hidden = !visible;
    this.tag.classList.toggle('cn-wait', !ready);
    if (visible) {
      this.tag.style.transform = `translate(${((sp.x + 1) / 2) * el.clientWidth}px, ${((1 - sp.y) / 2) * el.clientHeight}px)`;
      const fl = this.flightTime();
      this.tag.textContent = `${Math.round(this.aim.range)} m · ${fl.toFixed(1)} s`;
    }
  }

  /** How long a ball fired at the mark now would take to get there. */
  private flightTime() {
    const L = this.laid[1];
    const vy = Math.sin(L.elev) * MUZZLE_V;
    const vh = Math.cos(L.elev) * MUZZLE_V;
    // range = vh (1 − e^(−kt)) / k  ⇒  t = −ln(1 − kR / vh) / k
    const x = 1 - (DRAG * this.aim.range) / vh;
    return x > 0 ? -Math.log(x) / DRAG : (2 * vy) / GRAVITY;
  }
}
