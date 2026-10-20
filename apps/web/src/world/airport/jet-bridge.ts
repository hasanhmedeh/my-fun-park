// Apron-drive passenger boarding bridges ("jet bridges"): a rotunda on a column by the terminal,
// three telescoping tunnel sections, an elevating drive column on a steerable wheel bogie, and a
// rotating cab with a folding canopy (the bellows) that closes round the aircraft's door.
//
// Every bridge at an airport shares one set of instanced meshes, one per moving part (rotunda,
// tunnels, cab, bellows, legs, bogie): six bridges cost six draw calls. A bridge only rewrites its
// instances while it's moving.
//
// Docking follows the real sequence: from the parked position the operator drives the bridge
// round and out (swinging, telescoping and lifting at once), squares the cab up to the door,
// creeps the last metre, then extends the canopy. Retracting is the same in reverse.

import * as THREE from 'three';
import type { Ctx } from '../context';
import { headingVec, vecHeading } from '../geo';
import { Kit, kitMaterials, type V2, type V3 } from './terminal-kit';

/** The rotunda's floor height: the tunnel's root, level with the terminal's fixed link. */
export const ROTUNDA_FLOOR = 3.6;
export const ROTUNDA_R = 2.1;
/** From the cab's pivot (where tunnel C meets it) to the front edge of its floor. */
const CAB_DEPTH = 2.5;
/** The gap left between the cab's floor edge and the fuselage when docked. */
const STANDOFF = 0.12;
/** Tunnel sections, rotunda end first: length, and how much bigger each is than the one it slides over. */
const SECTIONS = [
  { len: 9.5, sx: 1, sy: 1, dy: 0 },
  { len: 9.0, sx: 1.07, sy: 1.05, dy: -0.07 },
  { len: 8.5, sx: 1.14, sy: 1.1, dy: -0.14 },
];
/** Where tunnel A starts, inside the rotunda. */
const A0 = 1.2;
/** The drive column stands this far back from the cab's pivot, under tunnel C. */
const WHEELS_BACK = 3.8;
/** How long a full dock (or retraction) takes, in seconds. */
const DOCK_TIME = 24;
/** The parked bridge is swung this far off its docked line, and this much shorter. */
const PARK_SWING = 22;
const PARK_SHORTEN = 5.5;
const PARK_CAB_Y = 3.25;

const PAINT = '#e8ebee';
const PAINT_DARK = '#c9ced4';
const GLASS = '#33495c';
const STEEL = '#7d858d';
const RUBBER = '#1d1f22';
const STRIPE = '#ff4d6d';
const BELLOWS = '#2e3136';

// ------------------------------------------------------------------------------------------------
// Part geometry (built once, shared by every bridge)
// ------------------------------------------------------------------------------------------------

/** A tunnel section of unit length (z −0.5..0.5, forward −z), floor top at y = 0, 2.6 m wide and 2.9 m tall inside. */
function tunnelGeometry() {
  const k = new Kit();
  const W = 2.6;
  const H = 2.9;
  const t = 0.08;
  // floor and its underside
  k.box(0, -0.13, 0, W + 0.12, 0.26, 1, PAINT_DARK);
  for (const s of [-1, 1]) {
    const x = s * (W / 2 + t / 2);
    k.box(x, 0.45, 0, t, 0.9, 1, PAINT);
    // the glazed band: lamplit inside at night
    k.glow = 0.75;
    k.box(x, 1.65, 0, t * 0.6, 1.5, 1, GLASS);
    k.glow = 0;
    k.box(x, 2.65, 0, t, 0.5, 1, PAINT);
    // the airline's stripe low on the side
    k.box(s * (W / 2 + t + 0.005), 0.28, 0, 0.012, 0.16, 1, STRIPE);
    // frame ribs every quarter of the section
    for (const z of [-0.5, -0.25, 0, 0.25, 0.5]) k.box(s * (W / 2 + t + 0.02), H / 2 - 0.07, z, 0.06, H + 0.12, 0.012, PAINT_DARK);
  }
  // the roof, slightly crowned
  k.box(0, H + 0.05, 0, W + 0.3, 0.12, 1, PAINT);
  k.box(0, H + 0.14, 0, W * 0.6, 0.08, 1, PAINT_DARK);
  // collars round both mouths
  for (const z of [-0.5, 0.5]) {
    k.box(0, H + 0.02, z, W + 0.36, 0.2, 0.01, STEEL);
    for (const s of [-1, 1]) k.box(s * (W / 2 + 0.12), H / 2 - 0.1, z, 0.12, H + 0.3, 0.01, STEEL);
  }
  return k.build();
}

/** The rotunda on its column, origin on the ground under its centre. */
function rotundaGeometry() {
  const k = new Kit();
  const R = ROTUNDA_R;
  k.cyl(0, 0, 0, 0.45, 0.45, ROTUNDA_FLOOR - 0.4, STEEL, 14);
  k.cyl(0, 0, 0, 0.75, 0.75, 0.25, '#9aa0a6', 14);
  // the turntable skirt and floor
  k.cyl(0, ROTUNDA_FLOOR - 0.45, 0, R * 0.7, R + 0.05, 0.45, PAINT_DARK, 24);
  k.cyl(0, ROTUNDA_FLOOR, 0, R, R, 0.7, PAINT, 24);
  k.glow = 0.7;
  k.cyl(0, ROTUNDA_FLOOR + 0.7, 0, R - 0.03, R - 0.03, 1.5, GLASS, 24);
  k.glow = 0;
  k.cyl(0, ROTUNDA_FLOOR + 2.2, 0, R, R, 0.55, PAINT, 24);
  k.cyl(0, ROTUNDA_FLOOR + 2.75, 0, R + 0.12, R + 0.12, 0.14, STEEL, 24);
  k.cyl(0, ROTUNDA_FLOOR + 2.89, 0, R * 0.8, R * 0.4, 0.3, PAINT_DARK, 24);
  // window mullions
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.box(Math.cos(a) * R, ROTUNDA_FLOOR + 1.45, Math.sin(a) * R, 0.07, 1.5, 0.07, PAINT_DARK, -a);
  }
  k.box(0, ROTUNDA_FLOOR + 0.42, 0, R * 2.02, 0.12, 0.012, STRIPE);
  return k.build();
}

/** The cab, origin at its pivot on the floor, facing −z: drum at the back, glazed box in front, service stair on the right. */
function cabGeometry() {
  const k = new Kit();
  const W = 3.4;
  const front = -2.1;
  // the drum it turns on, where tunnel C enters
  k.cyl(0, -0.3, 0, 1.75, 1.75, 0.3, PAINT_DARK, 20);
  k.cyl(0, 0, 0, 1.7, 1.7, 0.9, PAINT, 20);
  k.glow = 0.6;
  k.cyl(0, 0.9, 0, 1.68, 1.68, 1.4, GLASS, 20);
  k.glow = 0;
  k.cyl(0, 2.3, 0, 1.72, 1.72, 0.75, PAINT, 20);
  // the front box
  k.span(-W / 2, -0.3, front, W / 2, 0, 0, PAINT_DARK);
  k.span(-W / 2, 0, front, W / 2, 0.9, -0.6, PAINT);
  k.glow = 0.8;
  k.span(-W / 2 + 0.03, 0.9, front + 0.03, W / 2 - 0.03, 2.35, -0.6, GLASS);
  k.glow = 0;
  k.span(-W / 2, 2.35, front, W / 2, 3.05, -0.6, PAINT);
  k.span(-W / 2 - 0.1, 3.05, front - 0.12, W / 2 + 0.1, 3.18, 0.2, STEEL);
  for (const x of [-W / 2, -0.55, 0.55, W / 2]) k.box(x, 1.62, front, 0.08, 1.46, 0.08, PAINT_DARK);
  // the floor platform with its yellow and black safety edge
  k.span(-W / 2 + 0.1, -0.12, front - 0.4, W / 2 - 0.1, 0.02, front, '#5c6168');
  for (let i = 0; i < 8; i++) {
    const x = -W / 2 + 0.1 + ((W - 0.2) * (i + 0.5)) / 8;
    k.box(x, -0.04, front - 0.38, (W - 0.2) / 16, 0.13, 0.05, i % 2 ? '#1b1b1b' : '#f2c21a');
  }
  // the auto-leveller arm under the floor
  k.box(-1.25, -0.42, front - 0.25, 0.1, 0.25, 0.5, STEEL);
  k.cyl(-1.25, -0.62, front - 0.45, 0.1, 0.1, 0.12, RUBBER, 8);
  // operator's console behind the left front window
  k.span(-W / 2 + 0.2, 0, front + 0.15, -0.4, 1.05, front + 0.7, '#3d434a');
  // the service door and stair down to the apron, on the right
  k.span(W / 2, 0, -0.9, W / 2 + 0.02, 2.1, -0.1, PAINT_DARK);
  k.span(W / 2, -0.12, -1.2, W / 2 + 1.2, -0.02, 0.2, STEEL);
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const a = i / steps;
    k.box(W / 2 + 0.75, -0.25 - a * 2.95, 0.4 + a * 2.6, 1.0, 0.05, 0.28, STEEL);
  }
  for (const x of [W / 2 + 0.22, W / 2 + 1.28]) {
    k.bar({ x, y: -0.1, z: 0.25 }, { x, y: -3.3, z: 3.1 }, 0.04, STEEL);
    k.bar({ x, y: 0.9, z: 0.25 }, { x, y: -2.3, z: 3.1 }, 0.025, '#d8dadc');
  }
  k.bar({ x: W / 2 + 1.28, y: -3.3, z: 3.1 }, { x: W / 2 + 1.28, y: -3.1, z: 3.1 }, 0.05, STEEL);
  return k.build();
}

/** The canopy's folds, origin at the cab's front wall, unit depth along −z (scaled to its extension). */
function bellowsGeometry() {
  const k = new Kit();
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const z = -i / n;
    const grow = 0.06 * (i / n);
    const w = 3.3 + grow;
    // each fold's hoop: top and sides
    k.box(0, 2.42 + grow / 2, z, w, 0.12, 0.03, i === n ? RUBBER : BELLOWS);
    for (const s of [-1, 1]) k.box((s * w) / 2, 1.18, z, 0.12, 2.6, 0.03, i === n ? RUBBER : BELLOWS);
  }
  // the folded cover between the hoops
  k.box(0, 2.4, -0.5, 3.28, 0.06, 1, '#3a3e44');
  for (const s of [-1, 1]) k.box(s * 1.63, 1.18, -0.5, 0.05, 2.5, 1, '#3a3e44');
  return k.build();
}

/** The drive column's two telescopic legs and the yoke under tunnel C, unit height (scaled to fit). */
function legsGeometry() {
  const k = new Kit();
  for (const s of [-1, 1]) {
    k.box(s * 1.0, 0.28, 0, 0.32, 0.56, 0.32, PAINT_DARK);
    k.box(s * 1.0, 0.74, 0, 0.24, 0.5, 0.24, '#b4bac1');
  }
  k.box(0, 0.965, 0, 2.6, 0.07, 0.36, PAINT_DARK);
  return k.build();
}

/** The wheel bogie: axle beam, two pairs of twin wheels, the drive motors. Origin on the ground, rolling along −z. */
function bogieGeometry() {
  const k = new Kit();
  k.box(0, 0.62, 0, 2.7, 0.36, 0.7, PAINT_DARK);
  k.box(0, 0.85, 0, 0.9, 0.2, 0.9, STEEL);
  const wheel = new THREE.CylinderGeometry(0.38, 0.38, 0.26, 14);
  const hub = new THREE.CylinderGeometry(0.16, 0.16, 0.28, 10);
  const m = new THREE.Matrix4();
  for (const x of [-1.32, -1.02, 1.02, 1.32]) {
    m.makeRotationZ(Math.PI / 2).setPosition(x, 0.38, 0);
    k.add(wheel, m, RUBBER);
    k.add(hub, m, '#9aa0a6');
  }
  for (const s of [-1, 1]) k.box(s * 0.62, 0.55, -0.45, 0.4, 0.4, 0.3, '#4a5058');
  return k.build();
}

// ------------------------------------------------------------------------------------------------
// The shared instanced meshes
// ------------------------------------------------------------------------------------------------

const CAPACITY = 12;
type Part = 'rotunda' | 'tunnel' | 'cab' | 'bellows' | 'legs' | 'bogie';

class Fleet {
  readonly group = new THREE.Group();
  readonly meshes: Record<Part, THREE.InstancedMesh>;
  count = 0;
  private dirty = false;

  constructor(ctx: Ctx) {
    this.group.name = 'jet-bridges';
    const mat = kitMaterials(ctx).metal;
    const make = (geo: THREE.BufferGeometry, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.count = 0;
      m.castShadow = ctx.quality.shadows;
      m.receiveShadow = ctx.quality.shadows;
      this.group.add(m);
      return m;
    };
    this.meshes = {
      rotunda: make(rotundaGeometry(), CAPACITY),
      tunnel: make(tunnelGeometry(), CAPACITY * 3),
      cab: make(cabGeometry(), CAPACITY),
      bellows: make(bellowsGeometry(), CAPACITY),
      legs: make(legsGeometry(), CAPACITY),
      bogie: make(bogieGeometry(), CAPACITY),
    };
    this.meshes.bellows.castShadow = false;
  }

  add() {
    if (this.count >= CAPACITY) throw new Error('too many jet bridges');
    const i = this.count++;
    for (const [part, mesh] of Object.entries(this.meshes) as [Part, THREE.InstancedMesh][]) mesh.count = this.count * (part === 'tunnel' ? 3 : 1);
    return i;
  }

  set(part: Part, i: number, m: THREE.Matrix4) {
    this.meshes[part].setMatrixAt(i, m);
    this.dirty = true;
  }

  /** Uploads what moved this frame (and refits the culling spheres round all the bridges). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const mesh of Object.values(this.meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}

const fleets = new WeakMap<THREE.Scene, Fleet>();
function fleet(ctx: Ctx) {
  let f = fleets.get(ctx.scene);
  if (!f) fleets.set(ctx.scene, (f = new Fleet(ctx)));
  return f;
}

/** The group holding every jet bridge's meshes: add it to the scene once (HomeTerminal does). */
export function jetBridgeGroup(ctx: Ctx) {
  return fleet(ctx).group;
}

// ------------------------------------------------------------------------------------------------
// One bridge
// ------------------------------------------------------------------------------------------------

export interface JetBridgeOptions {
  /** The rotunda's centre on the ground. */
  rotunda: V2;
  /** The aircraft door's sill (the cab's floor docks level with it). */
  door: V3;
  /** Heading the cab faces when docked (degrees): square to the fuselage. Default: the nearest right angle to the rotunda → door line. */
  facing?: number;
  /** The walkway from the terminal to the rotunda's doorway (escalator, fixed link…), prepended to `walkPath`. */
  entry?: V3[];
}

interface Pose {
  /** Tunnel heading (deg) and length from the rotunda's centre to the cab's pivot (m). */
  heading: number;
  length: number;
  /** Cab floor height, and the cab's yaw relative to the tunnel (deg). */
  cabY: number;
  cabYaw: number;
  /** The canopy's extension in front of the cab's wall (m). */
  bellows: number;
}

const smooth = (a: number, b: number, t: number) => THREE.MathUtils.smoothstep(t, a, b);
const lerp = THREE.MathUtils.lerp;
const angleDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

export class JetBridge {
  /** Where passengers walk, terminal to door sill (for the crowd's glide; nothing here is physics). */
  readonly walkPath: V3[];
  private readonly fleet: Fleet;
  private readonly index: number;
  private readonly docked: Pose;
  private readonly parked: Pose;
  private readonly approach: Pose;
  private readonly rotunda: V2;
  private progress = 0;
  private target = 0;
  private drawn = -1;
  private steer = 0;
  private readonly wheels = { x: 0, z: 0, set: false };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(ctx: Ctx, opts: JetBridgeOptions) {
    this.fleet = fleet(ctx);
    this.index = this.fleet.add();
    this.rotunda = { x: opts.rotunda.x, z: opts.rotunda.z };
    const r = opts.rotunda;
    const door = opts.door;
    const facing = opts.facing ?? Math.round(vecHeading(door.x - r.x, door.z - r.z) / 90) * 90;
    const f = headingVec(facing);
    // the cab's floor edge stops just short of the skin; its pivot is behind that
    const px = door.x - f.x * (STANDOFF + CAB_DEPTH);
    const pz = door.z - f.z * (STANDOFF + CAB_DEPTH);
    const heading = vecHeading(px - r.x, pz - r.z);
    const length = Math.hypot(px - r.x, pz - r.z);
    this.docked = { heading, length, cabY: door.y, cabYaw: angleDiff(heading, facing), bellows: 0.52 };
    this.approach = { ...this.docked, length: length - 1.2, cabY: door.y + 0.05, bellows: 0.25 };
    // parked: swung away from the aircraft (whichever way takes the cab further back from the door) and drawn in
    const back = (swing: number) => {
      const h = headingVec(heading + swing);
      return h.x * f.x + h.z * f.z;
    };
    const swing = back(PARK_SWING) < back(-PARK_SWING) ? PARK_SWING : -PARK_SWING;
    const minLen = A0 + SECTIONS[2].len + 0.6;
    this.parked = { heading: heading + swing, length: Math.max(minLen, length - PARK_SHORTEN), cabY: PARK_CAB_Y, cabYaw: 0, bellows: 0.25 };

    // the passengers' way: in through the rotunda, down the tunnel, across the cab, onto the sill
    const t = headingVec(heading);
    const entry = opts.entry ?? [];
    const last = entry[entry.length - 1];
    const fromX = last ? last.x - r.x : -t.x;
    const fromZ = last ? last.z - r.z : -t.z;
    const fl = Math.hypot(fromX, fromZ) || 1;
    this.walkPath = [
      ...entry.map((p) => ({ ...p })),
      { x: r.x + (fromX / fl) * (ROTUNDA_R - 0.4), y: ROTUNDA_FLOOR, z: r.z + (fromZ / fl) * (ROTUNDA_R - 0.4) },
      { x: r.x, y: ROTUNDA_FLOOR, z: r.z },
      { x: r.x + t.x * (length * 0.5), y: lerp(ROTUNDA_FLOOR, door.y, 0.5), z: r.z + t.z * (length * 0.5) },
      { x: px, y: door.y, z: pz },
      { x: door.x - f.x * (STANDOFF + 0.5), y: door.y, z: door.z - f.z * (STANDOFF + 0.5) },
      { x: door.x, y: door.y, z: door.z },
    ];

    this.m.makeTranslation(r.x, 0, r.z);
    this.fleet.set('rotunda', this.index, this.m);
    this.draw();
    this.fleet.flush();
  }

  /** 0 parked .. 1 docked at the door. */
  get k() {
    return this.progress;
  }

  /** Drive up to the aircraft (or be there at once, for a plane already parked when the scene starts). */
  dock(instant = false) {
    this.target = 1;
    if (instant) this.progress = 1;
  }

  /** Pull back to the parked position, clear of the aircraft. */
  retract(instant = false) {
    this.target = 0;
    if (instant) this.progress = 0;
  }

  update(dt: number) {
    const step = dt / DOCK_TIME;
    if (this.progress < this.target) this.progress = Math.min(this.target, this.progress + step);
    else if (this.progress > this.target) this.progress = Math.max(this.target, this.progress - step);
    if (this.progress !== this.drawn) this.draw(dt);
    this.fleet.flush();
  }

  /** The pose at progress k: the drive out (to 85 %), the last metre's creep, then the canopy. */
  private pose(k: number): Pose {
    const a = this.parked;
    const b = this.approach;
    const c = this.docked;
    if (k <= 0.85) {
      const u = smooth(0, 0.85, k);
      // the cab squares up to the door during the second half of the drive
      const v = smooth(0.35, 0.85, k);
      return {
        heading: a.heading + angleDiff(a.heading, b.heading) * u,
        length: lerp(a.length, b.length, u),
        cabY: lerp(a.cabY, b.cabY, smooth(0.1, 0.7, k)),
        cabYaw: lerp(a.cabYaw, b.cabYaw, v),
        bellows: a.bellows,
      };
    }
    const u = smooth(0.85, 0.94, k);
    return {
      heading: b.heading + angleDiff(b.heading, c.heading) * u,
      length: lerp(b.length, c.length, u),
      cabY: lerp(b.cabY, c.cabY, u),
      cabYaw: lerp(b.cabYaw, c.cabYaw, u),
      bellows: lerp(b.bellows, c.bellows, smooth(0.94, 1, k)),
    };
  }

  private draw(dt = 0) {
    this.drawn = this.progress;
    const P = this.pose(this.progress);
    const r = this.rotunda;
    const f = headingVec(P.heading);
    const hr = (-P.heading * Math.PI) / 180;
    const rise = P.cabY - ROTUNDA_FLOOR;
    const pitch = Math.atan2(rise, P.length);
    const along = (d: number, out: THREE.Vector3) => out.set(r.x + f.x * d, ROTUNDA_FLOOR + (rise * d) / P.length, r.z + f.z * d);

    // tunnels: A from inside the rotunda, C ending at the cab's pivot, B centred between them
    const aStart = A0;
    const cStart = P.length - SECTIONS[2].len;
    const bStart = (aStart + SECTIONS[0].len + cStart - SECTIONS[1].len) / 2;
    const starts = [aStart, bStart, cStart];
    this.e.set(pitch, hr, 0);
    this.q.setFromEuler(this.e);
    SECTIONS.forEach((sec, i) => {
      along(starts[i] + sec.len / 2, this.p);
      this.p.y += sec.dy;
      this.m.compose(this.p, this.q, this.s.set(sec.sx, sec.sy, sec.len));
      this.fleet.set('tunnel', this.index * 3 + i, this.m);
    });

    // the cab turns about its pivot; the canopy rides on its front
    this.p.set(r.x + f.x * P.length, P.cabY, r.z + f.z * P.length);
    this.e.set(0, hr - (P.cabYaw * Math.PI) / 180, 0);
    this.q.setFromEuler(this.e);
    this.m.compose(this.p, this.q, this.s.set(1, 1, 1));
    this.fleet.set('cab', this.index, this.m);
    const cf = headingVec(P.heading + P.cabYaw);
    this.p.x += cf.x * 2.1;
    this.p.z += cf.z * 2.1;
    this.m.compose(this.p, this.q, this.s.set(1, 1, P.bellows));
    this.fleet.set('bellows', this.index, this.m);

    // the drive column under tunnel C, its legs reaching up to the tunnel's underside
    const dw = P.length - WHEELS_BACK;
    along(dw, this.p);
    const wx = this.p.x;
    const wz = this.p.z;
    const legTop = this.p.y - 0.42;
    if (this.wheels.set && dt > 0) {
      const mx = wx - this.wheels.x;
      const mz = wz - this.wheels.z;
      // the wheels steer into the way they're rolling (reversing counts the other way round)
      if (Math.hypot(mx, mz) > 1e-4) {
        let h = vecHeading(mx, mz);
        if (Math.abs(angleDiff(this.steer, h)) > 90) h = (h + 180) % 360;
        this.steer += angleDiff(this.steer, h) * Math.min(1, dt * 4);
      }
    } else this.steer = P.heading;
    this.wheels.x = wx;
    this.wheels.z = wz;
    this.wheels.set = true;
    this.e.set(0, hr, 0);
    this.q.setFromEuler(this.e);
    this.m.compose(this.p.set(wx, 0.9, wz), this.q, this.s.set(1, Math.max(0.2, legTop - 0.9), 1));
    this.fleet.set('legs', this.index, this.m);
    this.e.set(0, (-this.steer * Math.PI) / 180, 0);
    this.q.setFromEuler(this.e);
    this.m.compose(this.p.set(wx, 0, wz), this.q, this.s.set(1, 1, 1));
    this.fleet.set('bogie', this.index, this.m);
  }
}
