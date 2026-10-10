import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shadowed, staticBox, staticCylinder, std, type Attraction, type Ctx } from '../context';
import type { Input } from '../input';
import { inPark } from '../layout';
import { hdr, PALETTE, signMaterial, signTexture, stripeTexture } from '../textures';
import { boreAxis, DS, sampleTrack, stepRide, TUNNEL_BORE, zoneAt, type Phys, type RideState, type TrackData, type Zone } from './track';

/** Riders' hearts sit this far above the rails. */
const HEART = 1.0;
const CAR_GAP = 2.75;
const START_S = 3;
/** How long the ghost train waits in the station while guests get off and on. */
const DWELL = 16;
/** Gentlest stop the ghost train makes when pulling into the station (m/s²). */
const STATION_DECEL = 3;
/** How long your train stands in the station after your lap before you climb out. */
const UNLOAD = 1.5;

/** A seat on the train, in its car's local frame. */
export interface Seat {
  car: THREE.Group;
  local: THREE.Vector3;
  /** Simple stand-in rider, shown when no crowd model sits here. */
  puppet: THREE.Object3D;
}

/** Where guests queue, board and leave a coaster (world space, at platform height). */
export interface StationInfo {
  /** Station straight: from the platform's start, along the track. */
  origin: THREE.Vector3;
  along: THREE.Vector3;
  /** Points from the track toward the platform. */
  out: THREE.Vector3;
  length: number;
  platformY: number;
  /** Foot and head of the entrance stairs, and of the exit stairs further along. */
  entryFoot: THREE.Vector3;
  entryTop: THREE.Vector3;
  exitFoot: THREE.Vector3;
  exitTop: THREE.Vector3;
}

const STAIR_RUN = 2.6;

export interface CoasterConfig {
  /** Short id, also used for the best-lap storage key. */
  id: string;
  name: string;
  track: TrackData;
  phys: Phys;
  station: { title: string; sub: string; side: 1 | -1 };
  colors: { rail: string; spine: string; cars: string[] };
  cars: number;
  /** Seat rows in the lead car (default 2; Intamin's Exa trains have a single-row lead car). */
  leadRows?: number;
  trackside: THREE.Vector3[];
  intro: (touch: boolean) => string;
  /** Toasts shown when the train enters a zone (overrides the default launch toast). A list gives
   *  one toast per visit, in track order, for zones the layout passes through more than once. */
  beats?: Partial<Record<Zone, string | string[]>>;
  /** Terrain height under the track (supports start here). */
  ground?: (x: number, z: number) => number;
  /** Tunnel look: neon tube (default) or a dark rock bore with warm lamps. */
  tunnel?: 'neon' | 'rock';
  /** Portal facades the tunnel shell ends flush with: each plane keeps its positive side. */
  tunnelClip?: THREE.Plane[];
  /** Places where a support column may not land (attractions, other tracks). */
  keepOut?: (x: number, z: number) => boolean;
}
const STRIP_BASE = new THREE.Color('#5ce1d6');

type CamMode = 'driver' | 'chase' | 'trackside';
const CAM_LABEL: Record<CamMode, string> = { driver: 'Driver', chase: 'Chase', trackside: 'Trackside' };

interface Frame {
  p: THREE.Vector3;
  t: THREE.Vector3;
  u: THREE.Vector3;
  r: THREE.Vector3;
}
const frame = (): Frame => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3() });

const $ = (id: string) => document.getElementById(id)!;

/**
 * A launched steel coaster you drive yourself. Hold the throttle to power the linear motors,
 * brake, hit turbo — or coast and let gravity do it. A ride is one lap: back in the station the
 * train brakes to a stop and you get off. When nobody is riding, a ghost train keeps running laps
 * so the park feels alive.
 */
export class Coaster implements Attraction {
  private d: TrackData;
  private state: RideState = { s: START_S, v: 0, launching: false };
  private cars: THREE.Group[] = [];
  private armsUp: THREE.Object3D[] = [];
  private launchStrips: THREE.MeshBasicMaterial;
  private stripLevel = 1.5;
  private f = frame();
  private f2 = frame();
  private camMode: CamMode = 'driver';
  private camUp = new THREE.Vector3(0, 1, 0);
  private camLook = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private trackside: THREE.Vector3[] = [];
  private prevVel = new THREE.Vector3();
  private gSmooth = 1;
  private lapStart = 0;
  private best = 0;
  private toastTimer = 0;
  private hudTimer = 0;
  private wasLaunching = false;
  private lastZone: Zone | null = null;
  private zoneVisits = new Map<Zone, number>();
  private introTimer = 0;
  private maxSpeed = 0;
  /** This round: where it started, how far the train has gone, its G extremes and its lap. */
  private roundStart = 0;
  private progress = 0;
  private maxG = 1;
  private minG = 1;
  private lapTime = 0;
  private lapDone = false;
  private parkedT = -1;
  private stopS = START_S;
  private dwellLeft = 0;
  private dwelled = false;
  readonly seats: Seat[] = [];
  station!: StationInfo;
  /** Fired when the ghost train stops in the station and when it leaves again. */
  onDwell: ((dwelling: boolean) => void) | null = null;
  input: Input | null = null;
  active = false;
  onFinish: (() => void) | null = null;
  /** The lap is done and the train has stopped in the station: the round is over. */
  onComplete: (() => void) | null = null;

  constructor(private ctx: Ctx, private cfg: CoasterConfig) {
    this.d = cfg.track;
    try {
      this.best = Number(localStorage.getItem(this.bestKey)) || 0;
    } catch {
      /* storage unavailable */
    }
    this.launchStrips = new THREE.MeshBasicMaterial({ color: hdr(STRIP_BASE, this.stripLevel) });
    this.buildTrackMeshes();
    this.buildStation();
    this.buildTunnel();
    this.buildTrain();
    this.trackside = cfg.trackside;
    this.placeTrain();
  }

  private get bestKey() {
    return this.cfg.id === 'stack' ? 'coaster-best' : `coaster-best-${this.cfg.id}`;
  }

  private ground(x: number, z: number) {
    return this.cfg.ground?.(x, z) ?? 0;
  }

  // ------------------------------------------------------------------ geometry

  private railCenter(i: number, out: THREE.Vector3) {
    return out.copy(this.d.pos[i]).addScaledVector(this.d.up[i], -HEART);
  }

  private buildTrackMeshes() {
    const d = this.d;
    const n = d.pos.length;
    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];
    const spine: THREE.Vector3[] = [];
    const c = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      this.railCenter(i, c);
      left.push(c.clone().addScaledVector(d.right[i], -0.55));
      right.push(c.clone().addScaledVector(d.right[i], 0.55));
      spine.push(c.clone().addScaledVector(d.up[i], -0.48));
    }
    const railMat = std(this.cfg.colors.rail, { roughness: 0.28, metalness: 0.65 });
    const spineMat = std(this.cfg.colors.spine, { roughness: 0.35, metalness: 0.55 });
    for (const [pts, r, mat] of [
      [left, 0.075, railMat],
      [right, 0.075, railMat],
      [spine, 0.2, spineMat],
    ] as const) {
      const curve = new THREE.CatmullRomCurve3(pts as THREE.Vector3[], true, 'catmullrom', 0.0);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, n, r, 8, true), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.ctx.scene.add(mesh);
    }

    // cross-ties with a web down to the spine (one merged geometry, instanced)
    const tieGeo = mergeGeometries([
      new THREE.BoxGeometry(1.3, 0.08, 0.16).translate(0, -0.05, 0),
      new THREE.BoxGeometry(0.1, 0.4, 0.1).translate(0, -0.27, 0),
      new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(-0.55, -0.1, 0),
      new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(0.55, -0.1, 0),
    ])!;
    const every = Math.round(1.2 / DS);
    const tieCount = Math.floor(n / every);
    const ties = new THREE.InstancedMesh(tieGeo, std('#3a2f4a', { metalness: 0.5, roughness: 0.45 }), tieCount);
    const m = new THREE.Matrix4();
    const back = new THREE.Vector3();
    for (let k = 0; k < tieCount; k++) {
      const i = k * every;
      this.railCenter(i, c);
      back.copy(d.tan[i]).negate();
      m.makeBasis(d.right[i], d.up[i], back).setPosition(c);
      ties.setMatrixAt(k, m);
    }
    ties.castShadow = true;
    this.ctx.scene.add(ties);

    // linear motors on the launch, copper fins on the brake run, glow strips beside the launch
    const finGeo = new THREE.BoxGeometry(0.05, 0.22, 0.8);
    const lsm: THREE.Matrix4[] = [];
    const brake: THREE.Matrix4[] = [];
    const strips: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i += 2) {
      const z = d.zone[i];
      if (z !== 'launch' && z !== 'boost' && z !== 'hyper' && z !== 'brake' && z !== 'trim') continue;
      this.railCenter(i, c);
      back.copy(d.tan[i]).negate();
      m.makeBasis(d.right[i], d.up[i], back).setPosition(c.clone().addScaledVector(d.up[i], 0.02));
      (z === 'brake' || z === 'trim' ? brake : lsm).push(m.clone());
      if (z !== 'brake' && z !== 'trim')
        for (const side of [-0.85, 0.85]) {
          m.makeBasis(d.right[i], d.up[i], back).setPosition(c.clone().addScaledVector(d.right[i], side).addScaledVector(d.up[i], -0.2));
          strips.push(m.clone());
        }
    }
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[]) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      list.forEach((mm, k) => im.setMatrixAt(k, mm));
      im.count = list.length;
      this.ctx.scene.add(im);
    };
    add(finGeo, std('#7f8794', { metalness: 0.9, roughness: 0.3 }), lsm);
    add(finGeo, std('#c46a2e', { metalness: 1, roughness: 0.3 }), brake);
    add(new THREE.BoxGeometry(0.08, 0.06, 0.9), this.launchStrips, strips);

    // supports: only under upright track with nothing else in the way
    const supports: { x: number; z: number; h: number; foot: number; m: THREE.Matrix4 }[] = [];
    const stepS = Math.round(5.5 / DS);
    const worldUp = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i += stepS) {
      if (d.up[i].y < 0.75 || d.zone[i] === 'station') continue;
      this.railCenter(i, c);
      const bottom = c.y - 0.75;
      const foot = this.ground(c.x, c.z);
      if (bottom - foot < 1.2) continue; // resting on the ground / the mountain
      if (this.cfg.keepOut?.(c.x, c.z)) continue;
      let blocked = false;
      for (let j = 0; j < n && !blocked; j += 2) {
        if (Math.abs(j - i) < 20 || Math.abs(j - i) > n - 20) continue;
        const pj = d.pos[j];
        if (Math.hypot(pj.x - c.x, pj.z - c.z) < 2.2 && pj.y < c.y) blocked = true;
      }
      if (blocked) continue;
      const across = new THREE.Vector3(d.right[i].x, 0, d.right[i].z).normalize();
      const head = new THREE.Matrix4().makeBasis(across, worldUp, new THREE.Vector3().crossVectors(across, worldUp));
      head.setPosition(c.x, bottom, c.z);
      supports.push({ x: c.x, z: c.z, h: bottom, foot, m: head });
    }
    const colGeo = new THREE.CylinderGeometry(0.16, 0.22, 1, 10).translate(0, 0.5, 0);
    const steel = std(PALETTE.cream, { metalness: 0.4, roughness: 0.45 });
    const cols = new THREE.InstancedMesh(colGeo, steel, supports.length);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.22, 0.3), steel, supports.length);
    const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.62, 0.35, 12), std('#8d8a99', { roughness: 0.9 }), supports.length);
    supports.forEach((s, k) => {
      // tall columns get thicker
      const w = 1 + Math.max(0, s.h - s.foot - 12) * 0.03;
      cols.setMatrixAt(k, m.makeScale(w, s.h - s.foot, w).setPosition(s.x, s.foot, s.z));
      heads.setMatrixAt(k, s.m);
      feet.setMatrixAt(k, m.makeScale(w, 1, w).setPosition(s.x, s.foot + 0.17, s.z));
      if (inPark(s.x, s.z, 1.5)) staticCylinder(this.ctx, s.x, s.z, 0.35 * w, 3);
    });
    cols.castShadow = heads.castShadow = true;
    feet.receiveShadow = true;
    this.ctx.scene.add(cols, heads, feet);

    // low track is solid for the bumper car
    for (let i = 0; i < n; i += 4) {
      this.railCenter(i, c);
      if (c.y < 4.6 && d.up[i].y > 0.5 && d.zone[i] !== 'station' && inPark(c.x, c.z, 1.5))
        staticBox(this.ctx, c.x, c.y / 2, c.z, 0.9, c.y / 2, 0.9);
    }
  }

  /** Platform, striped roof and marquee sign, laid out along the station zone. */
  private buildStation() {
    const d = this.d;
    let count = 0;
    while (d.zone[count] === 'station') count++;
    const L = count * DS;
    const P0 = this.railCenter(0, new THREE.Vector3());
    // lay the station out along its straight (not the tangent at one sample, which the
    // closing connector can bend slightly)
    const T = this.railCenter(count - 1, new THREE.Vector3()).sub(P0).setY(0).normalize();
    const R = new THREE.Vector3(-T.z, 0, T.x);
    const side = this.cfg.station.side;
    const out = R.clone().multiplyScalar(side); // toward the platform
    const rotY = Math.atan2(T.x, T.z);
    const along = (t: number, o: number, y: number) => P0.clone().addScaledVector(T, t).addScaledVector(out, o).setY(y);
    // the platform is level with the car floors, so guests step straight in
    const deckY = P0.y + 0.12;
    const entryT = L * 0.28;
    const exitT = L * 0.8;
    this.station = {
      origin: P0.clone().setY(0),
      along: T.clone(),
      out: out.clone(),
      length: L,
      platformY: deckY,
      entryFoot: along(entryT, 3.5 + STAIR_RUN + 0.4, 0),
      entryTop: along(entryT, 3.1, deckY),
      exitFoot: along(exitT, 3.5 + STAIR_RUN + 0.4, 0),
      exitTop: along(exitT, 3.1, deckY),
    };
    // the ghost train stops with its whole length inside the station
    this.stopS = Math.max(START_S, L - 3);

    const g = new THREE.Group();
    const add = (mesh: THREE.Mesh, at: THREE.Vector3) => {
      mesh.position.copy(at);
      mesh.rotation.y = rotY;
      g.add(mesh);
      return mesh;
    };
    const pc = along(L / 2, 2.4, deckY / 2);
    const deckMat = std('#b98a5a');
    add(new THREE.Mesh(new THREE.BoxGeometry(2.2, deckY, L), deckMat), pc).receiveShadow = true;
    staticBox(this.ctx, pc.x, deckY / 2, pc.z, 1.1, deckY / 2, L / 2, rotY);
    // entrance and exit stairs down to the queue line (solid, so you can't walk through them)
    const steps = Math.ceil(deckY / 0.18);
    const stepMat = std('#9c7048');
    const railMat = std(PALETTE.cream, { roughness: 0.5 });
    for (const t of [entryT, exitT]) {
      for (let i = 0; i < steps; i++) {
        const h = deckY * ((i + 1) / steps);
        const o = 3.5 + STAIR_RUN * (1 - (i + 0.5) / steps);
        const step = add(new THREE.Mesh(new THREE.BoxGeometry(1.4, h, STAIR_RUN / steps), stepMat), along(t, o, h / 2));
        step.rotation.y = rotY + Math.PI / 2;
        step.receiveShadow = true;
      }
      for (const side of [-0.75, 0.75]) {
        // handrails following the slope
        const a = along(t + side, 3.5, deckY + 0.9);
        const b = along(t + side, 3.5 + STAIR_RUN, 0.9);
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, a.distanceTo(b)), railMat);
        rail.position.copy(a).add(b).multiplyScalar(0.5);
        rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        g.add(rail);
        for (const [o, y] of [[3.5, deckY], [3.5 + STAIR_RUN, 0]]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9), railMat), along(t + side, o, y + 0.45));
      }
      const sc = along(t, 3.5 + STAIR_RUN / 2, deckY / 4);
      staticBox(this.ctx, sc.x, deckY / 4, sc.z, 0.75, deckY / 4, STAIR_RUN / 2, rotY + Math.PI / 2);
    }
    const tc = along(L / 2, 0, 1);
    staticBox(this.ctx, tc.x, 1, tc.z, 1.1, 1, L / 2 + 0.5, rotY);

    const roofTex = stripeTexture(PALETTE.candy, PALETTE.cream, 10);
    roofTex.repeat.set(4, 1);
    add(new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.3, L + 1), std('#ffffff', { map: roofTex })), along(L / 2, 1.2, 5.6));
    for (const t of [0.5, L / 2, L - 0.5])
      for (const o of [-1.8, 3.4]) {
        const at = along(t, o, 2.75);
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 5.5), std(PALETTE.cream)), at);
        if (o > 0) staticCylinder(this.ctx, at.x, at.z, 0.25, 5);
      }
    const sign = add(new THREE.Mesh(new THREE.PlaneGeometry(9, 2.6), signMaterial(signTexture(this.cfg.station.title, { sub: this.cfg.station.sub }))), along(L / 2, 3.6, 7.2));
    sign.rotation.y = Math.atan2(out.x, out.z); // face away from the track
    const back = add(new THREE.Mesh(new THREE.BoxGeometry(9.2, 2.8, 0.2), std(PALETTE.candyDark)), along(L / 2, 3.45, 7.2));
    back.rotation.y = sign.rotation.y;
    const bulbsN = Math.floor(L / 0.5);
    const roofBulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: hdr('#ffe2a0', 6) }), bulbsN);
    for (let i = 0; i < bulbsN; i++) roofBulbs.setMatrixAt(i, new THREE.Matrix4().setPosition(along(i * 0.5, 4.45, 5.4)));
    g.add(roofBulbs);
    shadowed(g, true);
    roofBulbs.castShadow = false;
    this.ctx.scene.add(g);
  }

  /**
   * A lit tunnel shell swept along the tunnel zone. The neon tube is an open arch over the track;
   * the rock bore is a closed tube (a floor too, so nothing outside the hill shows below the
   * track), trimmed flush with the portal facades given as `tunnelClip`.
   */
  private buildTunnel() {
    const d = this.d;
    const idx: number[] = [];
    for (let i = 0; i < d.pos.length; i++) if (d.zone[i] === 'tunnel') idx.push(i);
    if (idx.length < 4) return;
    const rock = this.cfg.tunnel === 'rock';
    const clip = this.cfg.tunnelClip ?? [];
    const R = TUNNEL_BORE.radius;
    const segs = rock ? 32 : 16;
    // the closed tube's seam runs along the floor, under the track
    const a0 = rock ? -Math.PI / 2 : -0.2;
    const span = rock ? Math.PI * 2 : Math.PI + 0.4;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const ind: number[] = [];
    const cut: boolean[] = [];
    const c = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const p = new THREE.Vector3();
    idx.forEach((i, row) => {
      boreAxis(d, i, c);
      for (let k = 0; k <= segs; k++) {
        const a = a0 + (k / segs) * span;
        radial.copy(d.right[i]).multiplyScalar(Math.cos(a)).addScaledVector(d.up[i], Math.sin(a));
        p.copy(c).addScaledVector(radial, R);
        // a portal facade stands across the bore here: slide the vertex along the track onto it
        let clipped = false;
        for (const pl of clip) {
          const s = pl.distanceToPoint(p);
          const along = pl.normal.dot(d.tan[i]);
          if (s < 0 && along > 0.05) {
            p.addScaledVector(d.tan[i], -s / along);
            clipped = true;
          }
        }
        pos.push(p.x, p.y, p.z);
        cut.push(clipped);
        // (the shell's front faces look outward; DoubleSide flips the normal for the inside)
        nrm.push(radial.x, radial.y, radial.z);
        uv.push(k / segs, row * 0.25);
      }
    });
    // (triangles flattened onto a facade entirely would only leave slivers in its plane)
    const tri = (u: number, v: number, w: number) => {
      if (!(cut[u] && cut[v] && cut[w])) ind.push(u, v, w);
    };
    for (let r = 0; r < idx.length - 1; r++)
      for (let k = 0; k < segs; k++) {
        const a = r * (segs + 1) + k;
        const b = a + segs + 1;
        tri(a, b, a + 1);
        tri(a + 1, b, b + 1);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(ind);
    const shellMat = rock
      ? std('#5a4636', { side: THREE.DoubleSide, roughness: 0.95 })
      : std('#ffffff', { map: stripeTexture(PALETTE.violet, '#2a1f45', 8, true), side: THREE.DoubleSide, roughness: 0.8 });
    const shell = new THREE.Mesh(geo, shellMat);
    shell.castShadow = shell.receiveShadow = true;
    this.ctx.scene.add(shell);

    // glowing rings every few metres
    const ringGeo = new THREE.TorusGeometry(R - 0.12, 0.05, 6, 32, Math.PI + 0.4);
    const ringMat = new THREE.MeshBasicMaterial({ color: rock ? hdr('#ffb46b', 2.2) : hdr('#ff7ad9', 5) });
    const back = new THREE.Vector3();
    for (let k = 0; k < idx.length; k += rock ? 24 : 8) {
      const i = idx[k];
      boreAxis(d, i, c);
      // (none where a ring would poke out through a portal)
      if (clip.some((pl) => pl.distanceToPoint(c) < R + 0.3)) continue;
      const ring = new THREE.Mesh(ringGeo, ringMat);
      back.copy(d.tan[i]).negate();
      ring.matrix.makeBasis(d.right[i], d.up[i], back).setPosition(c);
      ring.matrix.multiply(new THREE.Matrix4().makeRotationZ(-0.2));
      ring.matrixAutoUpdate = false;
      this.ctx.scene.add(ring);
    }
  }

  private buildTrain() {
    const paint = this.cfg.colors.cars;
    const seatMat = std(PALETTE.ink, { roughness: 0.7 });
    const chrome = std('#e6e2f0', { roughness: 0.12, metalness: 1 });
    const wheelMat = std('#2a2238', { roughness: 0.6 });
    const shirts = ['#5ce1d6', '#ff8a3d', '#a98bff', '#ffd23d', '#7ee2b8', '#ff5d7a'];
    const skins = ['#e8b48a', '#c98e62', '#8d5a3b', '#f1c9a5'];
    const wheelGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.12, 12).rotateZ(Math.PI / 2);
    let rider = 0;
    for (let k = 0; k < this.cfg.cars; k++) {
      const car = new THREE.Group();
      const body = new THREE.MeshPhysicalMaterial({ color: paint[k % paint.length], roughness: 0.35, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 });
      const shell = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 2.3), body);
      shell.position.y = 0.42;
      car.add(shell);
      if (k === 0) {
        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), body);
        nose.rotation.x = -Math.PI / 2;
        nose.scale.set(1, 1.1, 0.55);
        nose.position.set(0, 0.42, -1.15);
        car.add(nose);
        for (const x of [-0.42, 0.42]) {
          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: hdr('#fff3d0', 8) }));
          lamp.position.set(x, 0.5, -1.62);
          car.add(lamp);
        }
      }
      for (const z of k === 0 && this.cfg.leadRows === 1 ? [-0.45] : [-0.45, 0.6]) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.2, 0.7), seatMat);
        seat.position.set(0, 0.75, z);
        const back = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.8, 0.14), seatMat);
        back.position.set(0, 1.15, z + 0.36);
        car.add(seat, back);
        for (const x of [-0.36, 0.36]) {
          // the front-left seat of the lead car is yours (the driver camera sits there)
          const mine = k === 0 && z < 0 && x < 0;
          if (!mine) {
            // over-the-shoulder restraint
            const bar = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.045, 6, 12, Math.PI), chrome);
            bar.position.set(x, 1.32, z + 0.05);
            bar.rotation.y = Math.PI / 2;
            car.add(bar);
          }
          if (mine) continue;
          const person = new THREE.Group();
          this.seats.push({ car, local: new THREE.Vector3(x, 0.85, z), puppet: person });
          const skin = std(skins[rider % skins.length]);
          const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 4, 8), std(shirts[rider % shirts.length]));
          torso.position.y = 1.08;
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), skin);
          head.position.y = 1.5;
          person.add(torso, head);
          const arms = new THREE.Group();
          for (const ax of [-0.2, 0.2]) {
            const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.42, 3, 6), skin);
            arm.position.set(ax, 0.28, 0);
            arms.add(arm);
          }
          arms.position.y = 1.22;
          person.add(arms);
          this.armsUp.push(arms);
          person.position.set(x, 0, z);
          car.add(person);
          rider++;
        }
      }
      for (const x of [-0.62, 0.62])
        for (const z of [-0.8, 0.8]) {
          const w = new THREE.Mesh(wheelGeo, wheelMat);
          w.position.set(x, 0.05, z);
          car.add(w);
        }
      shadowed(car);
      car.matrixAutoUpdate = false;
      car.traverse((o) => o !== car && o.updateMatrix());
      this.ctx.scene.add(car);
      this.cars.push(car);
    }
  }

  // ------------------------------------------------------------------ ride

  private placeTrain() {
    const back = new THREE.Vector3();
    const c = new THREE.Vector3();
    this.cars.forEach((car, k) => {
      sampleTrack(this.d, this.state.s - k * CAR_GAP, this.f2);
      c.copy(this.f2.p).addScaledVector(this.f2.u, -HEART);
      back.copy(this.f2.t).negate();
      car.matrix.makeBasis(this.f2.r, this.f2.u, back).setPosition(c);
      car.matrixWorldNeedsUpdate = true;
    });
  }

  start() {
    this.active = true;
    if (this.dwellLeft > 0) {
      this.dwellLeft = 0;
      this.onDwell?.(false);
    }
    this.state = { s: START_S, v: 0, launching: false };
    this.lapStart = this.ctx.time.t;
    this.camMode = 'driver';
    this.prevVel.set(0, 0, 0);
    this.gSmooth = 1;
    this.maxSpeed = 0;
    this.roundStart = this.ctx.time.t;
    this.progress = 0;
    this.maxG = this.minG = 1;
    this.lapTime = 0;
    this.lapDone = false;
    this.parkedT = -1;
    sampleTrack(this.d, this.state.s, this.f);
    this.camUp.copy(this.f.u);
    this.camLook.copy(this.f.p).addScaledVector(this.f.t, 10);
    this.camDir.set(0, 0, 0);
    this.camPos.copy(this.f.p);
    this.placeTrain();
    $('ride-hud').hidden = false;
    $('rh-toast').hidden = true;
    document.body.classList.add('is-riding-coaster');
    this.updateHudStatic();
    // the intro opens by itself the first time (then steps aside after a few seconds); after that it's behind the ℹ️
    const shown = this.ctx.ui.setIntro(`${this.cfg.id}-intro`, this.cfg.name, this.cfg.intro(this.ctx.mobile), { accent: PALETTE.mustard });
    this.introTimer = shown ? 9 : 0;
    this.lastZone = null;
    this.zoneVisits.clear();
    this.ctx.sfx.chime();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    // the ghost train carries on from here, and waits in the station for the next guests
    this.dwelled = false;
    $('ride-hud').hidden = true;
    $('gloc').style.opacity = '0';
    document.body.classList.remove('is-riding-coaster');
    this.onFinish?.();
  }

  /** This round's numbers (see account/stats.ts); the lap time only once the lap is done. */
  roundStats(): Record<string, number> {
    const stats: Record<string, number> = {
      durationS: this.ctx.time.t - this.roundStart,
      topSpeedKmh: this.maxSpeed * 3.6,
      maxG: this.maxG,
      minG: this.minG,
    };
    if (this.lapDone) stats.lapTimeS = this.lapTime;
    return stats;
  }

  cycleCamera() {
    const order: CamMode[] = ['driver', 'chase', 'trackside'];
    this.camMode = order[(order.indexOf(this.camMode) + 1) % order.length];
    if (this.camMode === 'chase') this.camPos.copy(this.f.p).add(new THREE.Vector3(0, 6, 0)).addScaledVector(this.f.t, -13);
    $('rh-cam').textContent = CAM_LABEL[this.camMode];
    this.ctx.sfx.pop();
  }

  update(dt: number) {
    const L = this.d.length;
    // once your lap is done the station takes over: no more power or brakes
    const inp = this.active && this.input && !this.lapDone ? { throttle: this.input.throttle, turbo: this.input.boost } : { throttle: 0, turbo: false };
    const s0 = this.state.s;

    // two physics substeps per frame for stability at high speed
    const h = dt / 2;
    if (this.dwellLeft > 0 && !this.active) {
      // parked in the station while guests change over
      this.dwellLeft -= dt;
      this.state.v = 0;
      if (this.dwellLeft <= 0) this.onDwell?.(false);
    } else if (this.active && this.parkedT >= 0) {
      // your lap is over: parked in the station while you climb out
      this.state.v = 0;
      const was = this.parkedT;
      this.parkedT += dt;
      if (was <= UNLOAD && this.parkedT > UNLOAD) this.onComplete?.();
    } else
      for (let i = 0; i < 2; i++) {
        sampleTrack(this.d, this.state.s, this.f);
        stepRide(this.d, this.state, inp, h, this.f.t, this.cfg.phys);
        if (!this.active) this.ghostStation();
        else if (this.lapDone) this.stationStop();
      }
    // distance covered this round (a train that rolls back over the line hasn't done a lap)
    if (this.active) this.progress += this.state.s - s0;
    if (this.state.s >= L) {
      this.state.s -= L;
      if (this.active) this.onLap();
    } else if (this.state.s < 0) this.state.s += L;

    sampleTrack(this.d, this.state.s, this.f);
    this.placeTrain();

    // felt G-force from the finite-difference acceleration
    const vel = this.f.t.clone().multiplyScalar(this.state.v);
    if (dt > 0) {
      const acc = vel.clone().sub(this.prevVel).divideScalar(dt);
      acc.y += 9.81;
      const g = acc.dot(this.f.u) / 9.81;
      if (Number.isFinite(g)) this.gSmooth += (THREE.MathUtils.clamp(g, -8, 16) - this.gSmooth) * Math.min(1, dt * 6);
    }
    this.prevVel.copy(vel);

    // riders throw their hands up on airtime and at big speed
    const hands = this.gSmooth < 0.4 || this.state.v > 22 ? -2.6 : -0.2;
    for (const a of this.armsUp) {
      a.rotation.x += (hands - a.rotation.x) * Math.min(1, dt * 6);
      a.updateMatrix();
    }

    // launch strips glow while the motors fire
    this.stripLevel += ((this.state.launching ? 14 : 1.5) - this.stripLevel) * Math.min(1, dt * 8);
    this.launchStrips.color.copy(STRIP_BASE).multiplyScalar(this.stripLevel);

    if (!this.active) return;
    this.maxSpeed = Math.max(this.maxSpeed, Math.abs(this.state.v));
    // the station's stop isn't part of the ride's forces
    if (!this.lapDone) {
      this.maxG = Math.max(this.maxG, this.gSmooth);
      this.minG = Math.min(this.minG, this.gSmooth);
    }

    const zone = zoneAt(this.d, this.state.s);
    // (lastZone is null right after boarding, so the station beat only plays on arrival)
    if (zone !== this.lastZone && zone && this.lastZone !== null && this.cfg.beats?.[zone] && this.state.v > 0) {
      const beat = this.cfg.beats[zone]!;
      const visit = this.zoneVisits.get(zone) ?? 0;
      this.zoneVisits.set(zone, visit + 1);
      this.toast(Array.isArray(beat) ? beat[Math.min(visit, beat.length - 1)] : beat);
    }
    else if (!this.cfg.beats && this.state.launching && !this.wasLaunching) this.toast('LAUNCH! 🚀');
    this.lastZone = zone;
    this.wasLaunching = this.state.launching;
    if (this.introTimer > 0) {
      this.introTimer -= dt;
      if (this.introTimer <= 0 && this.ctx.ui.panelOpenKey === `${this.cfg.id}-intro`) this.ctx.ui.hidePanel();
    }
    if (zoneAt(this.d, this.state.s) === 'launch' && this.state.v < -0.5) this.toast('Rolled back! Hold W for power');

    this.updateHud(dt);
  }

  /** The ghost train eases to a stop in the station once a lap, then the tyres pull it out. */
  private ghostStation() {
    const st = this.state;
    if (st.s > this.stopS + 4 && st.s < this.d.length - 30) this.dwelled = false;
    if (this.dwelled || zoneAt(this.d, st.s) !== 'station' || st.s > this.stopS) return;
    const left = this.stopS - st.s;
    st.v = Math.max(0.35, Math.min(st.v, Math.sqrt(2 * STATION_DECEL * left)));
    if (left < 0.05) {
      st.s = this.stopS;
      st.v = 0;
      this.dwelled = true;
      this.dwellLeft = DWELL;
      this.onDwell?.(true);
    }
  }

  /** After your lap: brakes the train to a stop where the ghost train stops, then parks it. */
  private stationStop() {
    const st = this.state;
    if (this.parkedT >= 0 || zoneAt(this.d, st.s) !== 'station') return;
    const left = this.stopS - st.s;
    if (left < 0.05) {
      st.v = 0;
      this.parkedT = 0;
      return;
    }
    st.v = Math.max(0.35, Math.min(st.v, Math.sqrt(2 * STATION_DECEL * left)));
  }

  /** Keep the parked ghost train waiting at least this much longer (guests still boarding). */
  holdDwell(seconds: number) {
    if (this.dwelling) this.dwellLeft = Math.max(this.dwellLeft, seconds);
  }

  /** How excited the riders are: hands go up on airtime and at speed. */
  get thrill() {
    return this.gSmooth < 0.4 || this.state.v > 22 ? 1 : 0;
  }

  /** True while the ghost train stands in the station with its gates open. */
  get dwelling() {
    return !this.active && this.dwellLeft > 0;
  }

  /** Seconds until the parked ghost train leaves. */
  get dwellRemaining() {
    return this.dwelling ? this.dwellLeft : 0;
  }

  /** World position of a seat (where a rider's hips go). */
  seatWorld(i: number, out = new THREE.Vector3()) {
    const seat = this.seats[i];
    return out.copy(seat.local).applyMatrix4(seat.car.matrix);
  }

  /** Back over the line: the lap is done (if the train really went round), and the round with it. */
  private onLap() {
    const t = this.ctx.time.t - this.lapStart;
    if (this.lapDone || t < 6 || this.progress < this.d.length * 0.9) return;
    this.lapDone = true;
    this.lapTime = t;
    const record = !this.best || t < this.best;
    if (record) {
      this.best = t;
      try {
        localStorage.setItem(this.bestKey, String(t));
      } catch {
        /* storage unavailable */
      }
    }
    this.toast(record ? `New best lap ${fmt(t)} 🏆` : `Lap ${fmt(t)}`);
    this.ctx.sfx.chime();
    this.updateHudStatic();
  }

  private toast(text: string) {
    const el = $('rh-toast');
    if (!el.hidden && el.textContent === text) return;
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.toastTimer = 2.8;
  }

  private updateHudStatic() {
    $('rh-best').textContent = this.best ? fmt(this.best) : '—';
    $('rh-cam').textContent = CAM_LABEL[this.camMode];
  }

  private updateHud(dt: number) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) $('rh-toast').hidden = true;
    }
    // grey-out under heavy positive G, red-out under strong negative G
    const gl = $('gloc');
    const over = Math.max(0, (this.gSmooth - 5.5) / 4);
    const under = Math.max(0, (-this.gSmooth - 1) / 2);
    gl.classList.toggle('grey', over >= under);
    gl.style.opacity = String(Math.min(0.9, Math.max(over, under)));

    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.08;
    $('rh-speed').textContent = String(Math.round(Math.abs(this.state.v) * 3.6));
    const gEl = $('rh-g');
    gEl.textContent = this.gSmooth.toFixed(1);
    gEl.parentElement!.classList.toggle('hot', this.gSmooth > 4);
    gEl.parentElement!.classList.toggle('float', this.gSmooth < 0.3);
    $('rh-lap').textContent = fmt(this.lapDone ? this.lapTime : this.ctx.time.t - this.lapStart);
    const thr = this.input?.throttle ?? 0;
    const bar = $('rh-throttle');
    bar.style.left = thr >= 0 ? '50%' : `${50 + thr * 50}%`;
    bar.style.width = `${Math.abs(thr) * 50}%`;
    bar.className = thr < 0 ? 'brake' : this.input?.boost && thr > 0 ? 'turbo' : '';
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const f = this.f;
    if (this.camMode === 'driver') {
      // front-left seat of the lead car; the horizon rolls with the track
      sampleTrack(this.d, this.state.s + 0.4, this.f2);
      const eye = this.f2.p.clone().addScaledVector(this.f2.u, 0.62).addScaledVector(this.f2.r, -0.36);
      sampleTrack(this.d, this.state.s + 9, this.f2);
      const look = this.f2.p.clone().addScaledVector(this.f2.u, 0.4);
      this.camUp.lerp(f.u, 1 - Math.exp(-dt * 10)).normalize();
      // smooth the look *direction* (a lagging world point ends up behind you at 250 km/h)
      const wantDir = look.sub(eye).normalize();
      if (this.camDir.lengthSq() < 0.5) this.camDir.copy(wantDir);
      this.camDir.lerp(wantDir, 1 - Math.exp(-dt * 12)).normalize();
      this.camLook.copy(eye).add(this.camDir);
      camera.position.copy(eye);
      camera.up.copy(this.camUp);
      camera.lookAt(this.camLook);
    } else if (this.camMode === 'chase') {
      // behind and above, always world-up so loops stay readable
      const flat = new THREE.Vector3(f.t.x, 0, f.t.z);
      if (flat.lengthSq() < 0.01) flat.copy(f.p).sub(this.camPos).setY(0);
      flat.normalize();
      const want = f.p.clone().addScaledVector(flat, -13).add(new THREE.Vector3(0, 6, 0));
      want.y = Math.max(want.y, 2.5);
      this.camPos.lerp(want, 1 - Math.exp(-dt * 3));
      this.camLook.lerp(f.p, 1 - Math.exp(-dt * 8));
      camera.up.set(0, 1, 0);
      camera.position.copy(this.camPos);
      camera.lookAt(this.camLook);
    } else {
      let best = this.trackside[0];
      for (const p of this.trackside) if (p.distanceToSquared(f.p) < best.distanceToSquared(f.p)) best = p;
      camera.up.set(0, 1, 0);
      camera.position.copy(best);
      this.camLook.lerp(f.p, 1 - Math.exp(-dt * 10));
      camera.lookAt(this.camLook);
      this.camPos.copy(best);
    }
  }

  get speed() {
    return Math.abs(this.state.v);
  }

  get launching() {
    return this.state.launching;
  }

  /** Where the lead car is (for shadows / grass LOD while riding). */
  get trainPosition() {
    return this.f.p;
  }
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
