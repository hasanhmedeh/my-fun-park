// Self-propelled passenger stairs for Palm Cay's walk-out stands: a compact stair truck (a low
// cab up front, under the platform) whose stairway overhangs its tail down to the apron, with a
// canopied top platform, aluminium handrails and side panels in the airport's white and teal.
//
// Docking follows the real thing: the driver comes in square to the fuselage with the stairs
// lowered, creeps the last metre to the door, then the stairway's front end rises on its rams
// until the platform's rubber bumper sits level with the door sill. Retracting is the reverse.
//
// Every set of stairs in a scene shares two instanced meshes (the truck, and the stairway that
// pivots on it), so four sets cost two draw calls; a set only rewrites its instances while moving.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from '../context';
import { headingVec } from '../geo';
import { islandMaterials } from './kit';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** The platform's deck: level with an A320's door sills (A320_POINTS.doorL1.y). */
const DECK_Y = 3.38;
/** 16 treads of 0.2 m rise and 0.25 m going (about 39°, like the real ones), from the platform's back edge down to the apron. */
const RISE = 0.2;
const GOING = 0.25;
const TREADS = 16;
const TOP_Z = 1.75;
/** The stairway pivots at its foot; lowered, its front end is this much down (rad). */
const LOWERED = -0.1;
const PIVOT = { y: 0.05, z: TOP_Z + GOING * TREADS + 0.3 };
/** Parked this far back from the door, square to the fuselage (m). */
const PARK_BACK = 11;
/** A full dock (or retraction): the drive in, then the lift (s). */
const DOCK_TIME = 22;
const DRIVE_PART = 0.72;

const WHITE = '#f4f1ea';
const TEAL = '#1d8a99';
const GREY = '#8b949b';
const DARK = '#2a2f33';
const RUBBER = '#1c1c1c';

// ------------------------------------------------------------------------------------------------
// Geometry (truck frame: forward −Z towards the aircraft; the origin on the ground under the
// platform's front lip)
// ------------------------------------------------------------------------------------------------

class Parts {
  private list: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();

  add(g: THREE.BufferGeometry, colour: string, m?: THREE.Matrix4) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    geo.deleteAttribute('uv');
    if (m) geo.applyMatrix4(m);
    const c = new THREE.Color(colour);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.list.push(geo);
  }

  box(w: number, h: number, d: number, colour: string, x: number, y: number, z: number, rx = 0) {
    this.m.makeRotationX(rx).setPosition(x, y, z);
    this.add(new THREE.BoxGeometry(w, h, d), colour, this.m);
  }

  /** A round bar from a to b. */
  tube(a: THREE.Vector3, b: THREE.Vector3, r: number, colour: string) {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, 6);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.add(g, colour, new THREE.Matrix4().compose(a.clone().lerp(b, 0.5), q, new THREE.Vector3(1, 1, 1)));
  }

  merge() {
    const g = mergeGeometries(this.list, false)!;
    g.computeBoundingSphere();
    return g;
  }
}

/** The truck: frame, the low cab under the platform, wheels, the beacon. */
function truckGeometry() {
  const p = new Parts();
  // frame and bumper (hazard-striped)
  p.box(1.9, 0.3, 4.3, DARK, 0, 0.62, 2.45);
  p.box(2.3, 0.28, 0.16, RUBBER, 0, 0.55, 0.22);
  for (let i = 0; i < 6; i++) p.box(0.19, 0.2, 0.02, i % 2 ? RUBBER : '#f5c400', -0.95 + i * 0.38, 0.55, 0.13);
  // the cab: white with a teal band, dark glass all round
  p.box(2.2, 1.45, 1.9, WHITE, 0, 1.52, 1.35);
  p.box(2.22, 0.22, 1.92, TEAL, 0, 1.0, 1.35);
  p.box(2.0, 0.62, 0.03, DARK, 0, 1.85, 0.39);
  for (const s of [-1, 1]) p.box(0.03, 0.62, 1.3, DARK, s * 1.11, 1.85, 1.4);
  p.box(2.24, 0.06, 1.94, '#dcdcd6', 0, 2.27, 1.35);
  // the engine bay behind the cab, under the stairway
  p.box(1.8, 0.5, 1.8, WHITE, 0, 1.0, 3.35);
  p.box(1.82, 0.12, 1.82, TEAL, 0, 0.8, 3.35);
  // wheels and wheel arches
  for (const z of [1.15, 3.85])
    for (const s of [-1, 1]) {
      p.add(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 16).rotateZ(Math.PI / 2), RUBBER, new THREE.Matrix4().makeTranslation(s * 1.0, 0.42, z));
      p.add(new THREE.CylinderGeometry(0.22, 0.22, 0.32, 10).rotateZ(Math.PI / 2), '#c8ccd0', new THREE.Matrix4().makeTranslation(s * 1.0, 0.42, z));
      p.box(0.36, 0.06, 1.05, DARK, s * 1.0, 0.9, z);
    }
  // an amber beacon on the cab roof and the rear lamps
  p.add(new THREE.CylinderGeometry(0.08, 0.09, 0.14, 10), '#ff9a1a', new THREE.Matrix4().makeTranslation(-0.75, 2.37, 0.7));
  for (const s of [-1, 1]) p.box(0.16, 0.1, 0.03, '#c0201c', s * 0.8, 0.85, 4.3);
  return p.merge();
}

/** The stairway: platform with its bumper, rails and canopy, the treads, closed side panels, handrails, the rams. */
function stairsGeometry() {
  const p = new Parts();
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const hw = 0.82;
  // the platform and its bumper
  p.box(1.75, 0.1, 1.85, GREY, 0, DECK_Y - 0.05, 0.85);
  p.box(1.6, 0.012, 1.7, '#3d4347', 0, DECK_Y + 0.006, 0.85);
  p.box(1.75, 0.16, 0.12, RUBBER, 0, DECK_Y - 0.04, -0.06);
  p.box(1.75, 0.3, 0.06, WHITE, 0, DECK_Y - 0.25, 1.75);
  // treads (dark anti-slip) on two closed side panels
  for (let i = 1; i <= TREADS; i++) {
    const y = DECK_Y - RISE * i;
    const z = TOP_Z + GOING * (i - 0.5);
    p.box(1.5, 0.045, GOING + 0.03, '#3d4347', 0, y, z);
    p.box(1.5, 0.02, 0.05, '#f5c400', 0, y + 0.03, z - GOING / 2 + 0.03);
  }
  const slope = Math.atan2(RISE, GOING);
  const runLen = Math.hypot(RISE * TREADS, GOING * TREADS) + 0.35;
  const mid = v(0, DECK_Y - (RISE * TREADS) / 2 - 0.12, TOP_Z + (GOING * TREADS) / 2);
  for (const s of [-1, 1]) {
    p.box(0.06, 0.62, runLen, WHITE, s * hw, mid.y, mid.z, slope);
    p.box(0.065, 0.14, runLen, TEAL, s * hw, mid.y - 0.12, mid.z, slope);
    p.box(0.06, 0.62, 1.85, WHITE, s * (hw + 0.05), DECK_Y - 0.25, 0.85);
    p.box(0.065, 0.14, 1.85, TEAL, s * (hw + 0.05), DECK_Y - 0.37, 0.85);
    // handrails: a top rail and a knee rail down the flight, on posts
    const top = v(s * hw, DECK_Y + 0.95, TOP_Z);
    const foot = v(s * hw, DECK_Y - RISE * TREADS + 0.95, TOP_Z + GOING * TREADS);
    p.tube(top, foot, 0.03, '#cfd5da');
    p.tube(top.clone().setY(top.y - 0.5), foot.clone().setY(foot.y - 0.5), 0.02, '#cfd5da');
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const b = v(s * hw, DECK_Y - RISE * TREADS * t + 0.05, TOP_Z + GOING * TREADS * t);
      p.tube(b, b.clone().setY(b.y + 0.95), 0.025, '#cfd5da');
    }
    // the platform's side rail (open at the front, where the door is)
    p.tube(v(s * (hw + 0.05), DECK_Y + 1.05, 0.05), v(s * (hw + 0.05), DECK_Y + 1.05, TOP_Z), 0.03, '#cfd5da');
    p.tube(v(s * (hw + 0.05), DECK_Y + 0.55, 0.05), v(s * (hw + 0.05), DECK_Y + 0.55, TOP_Z), 0.02, '#cfd5da');
    // canopy posts
    p.tube(v(s * (hw + 0.05), DECK_Y, 0.05), v(s * (hw + 0.05), DECK_Y + 2.15, 0.05), 0.035, GREY);
    p.tube(v(s * (hw + 0.05), DECK_Y - 0.6, TOP_Z + 0.4), v(s * (hw + 0.05), DECK_Y + 2.05, TOP_Z + 0.4), 0.035, GREY);
    // the rams under the platform (they slide into the cab's roof as the stairs come down)
    p.tube(v(s * 0.6, 1.9, 0.85), v(s * 0.6, DECK_Y - 0.1, 0.85), 0.07, '#9aa3aa');
    p.tube(v(s * 0.6, 1.9, 0.85), v(s * 0.6, 2.6, 0.85), 0.1, DARK);
  }
  // the canopy: a shallow white roof over the platform, its front clear of the fuselage's curve
  p.box(1.95, 0.07, 2.1, WHITE, 0, DECK_Y + 2.2, 0.95, 0.06);
  p.box(1.97, 0.12, 0.06, TEAL, 0, DECK_Y + 2.16, -0.1);
  // the foot: a bottom step and two castors on the apron
  p.box(1.5, 0.05, 0.3, '#3d4347', 0, 0.18, TOP_Z + GOING * TREADS + 0.15);
  for (const s of [-1, 1]) p.add(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10).rotateZ(Math.PI / 2), RUBBER, new THREE.Matrix4().makeTranslation(s * 0.7, 0.1, PIVOT.z));
  const g = p.merge();
  // stored relative to the pivot, so a rotation about it is the instance's own
  g.translate(0, -PIVOT.y, -PIVOT.z);
  return g;
}

// ------------------------------------------------------------------------------------------------
// The fleet: every set's instances
// ------------------------------------------------------------------------------------------------

const CAPACITY = 12;

class Fleet {
  readonly group = new THREE.Group();
  readonly truck: THREE.InstancedMesh;
  readonly stairs: THREE.InstancedMesh;
  private origin: THREE.Vector3 | null = null;
  private dirty = false;
  private n = 0;

  constructor(ctx: Ctx) {
    const mat = islandMaterials(ctx.renderer).paint;
    this.truck = new THREE.InstancedMesh(truckGeometry(), mat, CAPACITY);
    this.stairs = new THREE.InstancedMesh(stairsGeometry(), mat, CAPACITY);
    for (const m of [this.truck, this.stairs]) {
      m.count = 0;
      m.castShadow = ctx.quality.shadows;
      m.receiveShadow = ctx.quality.shadows;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** Registers a set; the fleet's meshes stand at the first one's door (instances relative to it, for precision far out). */
  add(at: V3) {
    if (this.n >= CAPACITY) throw new Error('airstairs: too many sets in one scene');
    if (!this.origin) {
      this.origin = new THREE.Vector3(at.x, 0, at.z);
      this.group.position.copy(this.origin);
    }
    this.truck.count = this.stairs.count = this.n + 1;
    return this.n++;
  }

  local(p: THREE.Vector3) {
    return p.sub(this.origin!);
  }

  set(i: number, truck: THREE.Matrix4, stairs: THREE.Matrix4) {
    this.truck.setMatrixAt(i, truck);
    this.stairs.setMatrixAt(i, stairs);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.truck.instanceMatrix.needsUpdate = true;
    this.stairs.instanceMatrix.needsUpdate = true;
  }
}

const fleets = new WeakMap<THREE.Scene, Fleet>();
function fleet(ctx: Ctx) {
  let f = fleets.get(ctx.scene);
  if (!f) fleets.set(ctx.scene, (f = new Fleet(ctx)));
  return f;
}

/** The group holding every set of stairs' meshes in this scene: add it once (IslandTerminal does). */
export function airstairsGroup(ctx: Ctx) {
  return fleet(ctx).group;
}

// ------------------------------------------------------------------------------------------------
// One set of stairs
// ------------------------------------------------------------------------------------------------

const ease = (t: number) => t * t * (3 - 2 * t);

export class Airstairs {
  /**
   * Where passengers walk, apron to door sill (boarding order; reverse it to get off): the foot on
   * the apron, the bottom tread, the top tread, the platform and the door's sill. World metres.
   */
  readonly path: V3[];
  private readonly fleet: Fleet;
  private readonly index: number;
  /** The truck's yaw (park convention) and the docked position of its origin, relative to the fleet. */
  private readonly yaw: number;
  private readonly docked: THREE.Vector3;
  private readonly back: THREE.Vector3;
  private progress = 0;
  private target = 0;
  private drawn = -1;
  private readonly mt = new THREE.Matrix4();
  private readonly ms = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly foot = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  /**
   * @param door    the aircraft door's sill (world metres; y is its height, the platform docks level with it)
   * @param heading the AIRCRAFT's heading (degrees): the stairs serve a left-hand door, so they stand on
   *                its left, square to the fuselage, and their foot points away from it.
   */
  constructor(ctx: Ctx, door: V3, heading: number) {
    this.fleet = fleet(ctx);
    this.index = this.fleet.add(door);
    // the truck faces the aircraft's right (into the fuselage), its foot out to the aircraft's left
    const f = headingVec(heading + 90);
    this.yaw = -((heading + 90) * Math.PI) / 180;
    this.docked = this.fleet.local(new THREE.Vector3(door.x - f.x * 0.04, 0, door.z - f.z * 0.04));
    this.back = this.docked.clone().add(new THREE.Vector3(-f.x * PARK_BACK, 0, -f.z * PARK_BACK));
    const w = (along: number, y: number) => ({ x: door.x - f.x * along, y, z: door.z - f.z * along });
    this.path = [w(TOP_Z + GOING * TREADS + 0.75, 0), w(TOP_Z + GOING * (TREADS - 0.5), DECK_Y - RISE * (TREADS - 1)), w(TOP_Z + GOING * 0.5, DECK_Y), w(0.5, DECK_Y), { x: door.x, y: door.y, z: door.z }];
    this.draw();
    this.fleet.flush();
  }

  /** 0 parked .. 1 docked at the door. */
  get k() {
    return this.progress;
  }

  /** Drive up to the door (or be there at once, for an aircraft already parked when the scene starts). */
  dock(instant = false) {
    this.target = 1;
    if (instant) this.progress = 1;
  }

  /** Lower the stairs and back away to the parked spot. */
  retract(instant = false) {
    this.target = 0;
    if (instant) this.progress = 0;
  }

  update(dt: number) {
    const step = dt / DOCK_TIME;
    if (this.progress < this.target) this.progress = Math.min(this.target, this.progress + step);
    else if (this.progress > this.target) this.progress = Math.max(this.target, this.progress - step);
    if (this.progress !== this.drawn) this.draw();
    this.fleet.flush();
  }

  private draw() {
    this.drawn = this.progress;
    const drive = ease(Math.min(1, this.progress / DRIVE_PART));
    const lift = ease(Math.max(0, (this.progress - DRIVE_PART) / (1 - DRIVE_PART)));
    // the last metre is a creep: most of the distance is covered early in the drive
    const along = 1 - Math.pow(1 - drive, 1.6);
    this.p.lerpVectors(this.back, this.docked, along);
    this.q.setFromEuler(this.e.set(0, this.yaw, 0));
    this.mt.compose(this.p, this.q, this.one);
    // the stairway pivots about its foot
    this.q.setFromEuler(this.e.set(THREE.MathUtils.lerp(LOWERED, 0, lift), this.yaw, 0));
    const foot = this.foot.set(0, PIVOT.y, PIVOT.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw).add(this.p);
    this.ms.compose(foot, this.q, this.one);
    this.fleet.set(this.index, this.mt, this.ms);
  }
}
