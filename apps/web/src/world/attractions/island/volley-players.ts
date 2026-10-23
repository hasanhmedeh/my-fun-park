// Beach Volley's people: the four players on the sand (the visitor and their partner against the
// two locals), the umpire on the stand, and a few fans on the bleachers. Each is a real person
// (crowd/person-rig.ts) living in the court's frame (see volley-ball.ts), moved by the game: they
// run to where the ball will come down, jump to serve, spike and block, dive for a dig, and the arm
// poses the clips don't have (the forearm platform of a dig, the hands of a set, the cocked arm and
// whip of a spike) are layered on top procedurally.
//
// The island's players are its regulars, the same people every day: each is cast from a short list
// of avatars (castLook: the island set's swimmers and beachgoers, barefoot where it matters on the
// sand), dyed in their team's colours.

import * as THREE from 'three';
import type { LookRole, PeopleFactory } from '../../crowd/people-factory';
import type { PersonRig } from '../../crowd/person-rig';
import { dyeLook, plainLook, type Gender, type Look } from '../../crowd/looks';
import { mulberry } from '../../random';
import { SAND_Y } from './volley-ball';

/** What a player's arms are doing. */
export type Arms = 'loose' | 'ready' | 'dig' | 'set' | 'cock' | 'swing' | 'block' | 'cheer';

const V = new THREE.Vector3();
const W = new THREE.Vector3();
const D = new THREE.Vector3();
/** A pose's direction (aim() uses V and W itself). */
const DIR = new THREE.Vector3();
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const RQ = new THREE.Quaternion();

/** Turns a bone (in world space) so the direction to its child becomes `dir`, by amount k. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3, k: number) {
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(false, false);
  const from = V.setFromMatrixPosition(child.matrixWorld).sub(W.setFromMatrixPosition(bone.matrixWorld)).normalize();
  Q1.setFromUnitVectors(from, dir);
  if (k < 1) Q1.slerp(Q2.identity(), 1 - k);
  bone.getWorldQuaternion(Q2);
  Q2.premultiply(Q1);
  bone.parent!.getWorldQuaternion(Q1).invert();
  bone.quaternion.copy(Q1.multiply(Q2));
}

/** The arm bones the poses turn: the upper arm and the forearm on each side (the hands only give the forearms their direction). */
const ARM_BONES = ['upperarm_l', 'lowerarm_l', 'upperarm_r', 'lowerarm_r'] as const;
/** Where each arm starts in Athlete.bones (upper arm, forearm, hand). */
const LEFT = 0;
const RIGHT = 3;

/**
 * One player on the sand. Positions are in the court's frame; `goTo` sets where to run, `face`
 * which way to look, `jump` and `arms` what to do there. The game plays without a body: `attach`
 * gives it one once the people have loaded.
 */
export class Athlete {
  /** Where the player stands (court frame; y is the jump's height above the sand). */
  readonly pos = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private vel = new THREE.Vector3();
  /** Top running speed (m/s): beach players are slowed by the sand. */
  speed = 5.2;
  private facing = 0;
  private faceGoal = 0;
  private faceLock = false;
  rig: PersonRig | null = null;
  /** upperarm_l, lowerarm_l, hand_l, upperarm_r, lowerarm_r, hand_r. */
  private bones: THREE.Object3D[] = [];
  /** The rotation the clips gave the arm bones the pose turned last frame (put back before the next update). */
  private clipRot = ARM_BONES.map(() => new THREE.Quaternion());
  private bent = false;
  private armsNow: Arms = 'loose';
  private armsK = 0;
  private armsPrev: Arms = 'loose';
  private armsPrevK = 0;
  /** The swing's progress, 0 (cocked) → 1 (followed through). */
  private swingT = 1;
  private jumpT = -1;
  private jumpDur = 0.62;
  private jumpH = 0;
  private diveT = -1;
  private diveDir = new THREE.Vector3();
  private lod = 0;
  private armsSkip = 0;
  private skip = 0;

  constructor(x: number, z: number, facing: number) {
    this.pos.set(x, 0, z);
    this.goal.copy(this.pos);
    this.facing = this.faceGoal = facing;
  }

  /** Gives the player a body (once the people have loaded), or a new one (the visitor changed their look): the old one is disposed. */
  attach(rig: PersonRig, parent: THREE.Object3D, shadows: boolean) {
    this.rig?.dispose();
    this.rig = rig;
    this.bent = false;
    rig.setShadows(shadows);
    this.bones = (['upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r'] as const).map((n) => rig.bone(n));
    parent.add(rig.root);
    this.place();
  }

  /** Puts the player straight at (x, z), standing still. */
  warp(x: number, z: number, facing?: number) {
    this.pos.set(x, 0, z);
    this.goal.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.jumpT = -1;
    this.diveT = -1;
    if (facing !== undefined) this.facing = this.faceGoal = facing;
    this.place();
  }

  /** Run to (x, z). */
  goTo(x: number, z: number) {
    this.goal.set(x, 0, z);
  }

  /** How long it would take to get to (x, z) from here, at full speed after `react` seconds. */
  timeTo(x: number, z: number, react = 0) {
    return react + Math.hypot(x - this.pos.x, z - this.pos.z) / this.speed;
  }

  get goalX() {
    return this.goal.x;
  }

  get goalZ() {
    return this.goal.z;
  }

  /** Turn to face the point (x, z) (and keep facing it while running, if `lock`). */
  faceTo(x: number, z: number, lock = true) {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    if (dx * dx + dz * dz > 1e-4) this.faceGoal = Math.atan2(-dx, -dz);
    this.faceLock = lock;
  }

  /** Jump: leave the sand in `delay` seconds, `h` metres high at the top. */
  jump(delay: number, h = 0.55) {
    this.jumpT = -delay;
    this.jumpH = h;
    this.jumpDur = 0.32 + Math.sqrt(h) * 0.42;
  }

  /** The jump's top comes this long after take-off. */
  get jumpPeak() {
    return this.jumpDur / 2;
  }

  get airborne() {
    return this.jumpT >= 0 && this.jumpT < this.jumpDur;
  }

  /** How far into a dive (seconds), or −1. */
  get diving() {
    return this.diveT;
  }

  /** A dive along (dx, dz): the roll clip, and a lunge along the sand. */
  dive(dx: number, dz: number) {
    const l = Math.hypot(dx, dz) || 1;
    this.diveDir.set(dx / l, 0, dz / l);
    this.diveT = 0;
    // (the roll faces where it's going: the lunge is along the body, not sideways)
    this.faceGoal = this.facing = Math.atan2(-this.diveDir.x, -this.diveDir.z);
    this.rig?.play('Roll', 1.3);
  }

  /** What the arms do now ('swing' plays the spike's whip from wherever the arm is). */
  arms(a: Arms) {
    if (a === this.armsNow) return;
    this.armsPrev = this.armsNow;
    this.armsPrevK = this.armsK;
    this.armsNow = a;
    this.armsK = 0;
    if (a === 'swing') this.swingT = 0;
  }

  /** A flourish: wave or punch the air. */
  celebrate() {
    this.rig?.wave(1.6);
  }

  /** Where the player's hands meet the ball for this kind of touch (court frame). */
  contactPoint(kind: 'dig' | 'set' | 'spike', out: THREE.Vector3) {
    const fx = -Math.sin(this.facing);
    const fz = -Math.cos(this.facing);
    const h = this.rig?.height ?? 1.85;
    if (kind === 'dig') return out.set(this.pos.x + fx * 0.45, SAND_Y + h * 0.42, this.pos.z + fz * 0.45);
    if (kind === 'set') return out.set(this.pos.x + fx * 0.2, SAND_Y + h * 1.12, this.pos.z + fz * 0.2);
    return out.set(this.pos.x + fx * 0.35 + Math.cos(this.facing) * 0.25, SAND_Y + h * 1.18 + 0.55, this.pos.z + fz * 0.35 - Math.sin(this.facing) * 0.25);
  }

  /**
   * Advances the player: steering to the goal (the sand slows the start), the jump and the dive,
   * the rig's animation (skipped on far frames when `lod` says so), then the arm poses on top.
   * `cam` is the camera in the court's frame (for the detail and the skipped frames).
   */
  update(dt: number, cam: THREE.Vector3) {
    // running: accelerate towards the goal, ease in to stop on it
    const dx = this.goal.x - this.pos.x;
    const dz = this.goal.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const want = d > 0.04 ? Math.min(this.speed, d * 4) : 0;
    const tx = d > 0.04 ? (dx / d) * want : 0;
    const tz = d > 0.04 ? (dz / d) * want : 0;
    const acc = 1 - Math.exp(-dt * (this.airborne ? 0.8 : 7));
    this.vel.x += (tx - this.vel.x) * acc;
    this.vel.z += (tz - this.vel.z) * acc;
    if (this.diveT >= 0) {
      this.diveT += dt;
      const k = Math.max(0, 1 - this.diveT / 0.7);
      this.vel.set(this.diveDir.x * 4 * k, 0, this.diveDir.z * 4 * k);
      if (this.diveT > 0.9) this.diveT = -1;
    }
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const ground = Math.hypot(this.vel.x, this.vel.z);
    if (!this.faceLock && ground > 1.2 && this.diveT < 0) this.faceGoal = Math.atan2(-this.vel.x, -this.vel.z);
    const turn = Math.atan2(Math.sin(this.faceGoal - this.facing), Math.cos(this.faceGoal - this.facing));
    this.facing += turn * (1 - Math.exp(-dt * 9));
    // the jump: a ballistic hop
    let lift = 0;
    if (this.jumpT > -10) {
      const before = this.jumpT;
      this.jumpT += dt;
      if (before < 0 && this.jumpT >= 0) this.rig?.play('Jump_Loop', 1.4);
      if (this.jumpT >= 0 && this.jumpT < this.jumpDur) {
        const u = this.jumpT / this.jumpDur;
        lift = this.jumpH * 4 * u * (1 - u);
      } else if (this.jumpT >= this.jumpDur) {
        this.jumpT = -100;
        this.rig?.play('Jump_Land', 1.6);
      }
    }
    this.pos.y = lift;
    this.place();
    if (!this.rig) return;
    // far away: animate every other or every fourth frame (with the time they skipped)
    const camDist = D.set(this.pos.x, SAND_Y + 1, this.pos.z).distanceTo(cam);
    this.lod = camDist < 35 ? 1 : camDist < 80 ? 2 : 4;
    this.skip += dt;
    if (++this.armsSkip % this.lod !== 0) return;
    const step = this.skip;
    this.skip = 0;
    this.rig.setDistance(camDist);
    // the clips only write a bone whose value changes: give the arms back what they had before the pose
    if (this.bent) for (let i = 0; i < ARM_BONES.length; i++) this.armBone(i).quaternion.copy(this.clipRot[i]);
    this.bent = false;
    this.rig.update(step, this.airborne ? 0 : ground);
    this.poseArms(step);
  }

  /** The i-th of ARM_BONES. */
  private armBone(i: number) {
    // (bones holds the hands too: upper arm, forearm, hand on each side)
    return this.bones[i < 2 ? i : i + 1];
  }

  private place() {
    if (!this.rig) return;
    this.rig.root.position.set(this.pos.x, SAND_Y + this.pos.y, this.pos.z);
    this.rig.root.rotation.y = this.facing;
  }

  /** The arm poses on top of the clips: blended in quickly, out a little slower. */
  private poseArms(dt: number) {
    const rig = this.rig!;
    this.armsK = Math.min(1, this.armsK + dt * (this.armsNow === 'swing' ? 30 : 9));
    this.armsPrevK = Math.max(0, this.armsPrevK - dt * 6);
    if (this.armsNow === 'swing') this.swingT = Math.min(1, this.swingT + dt / 0.24);
    rig.armsUp = this.armsNow === 'block' || this.armsNow === 'cheer' ? this.armsK : this.armsPrev === 'block' || this.armsPrev === 'cheer' ? this.armsPrevK : 0;
    const prev = this.armsPrevK > 0.01 && this.posed(this.armsPrev);
    const now = this.armsK > 0.01 && this.posed(this.armsNow);
    if (!prev && !now) return;
    for (let i = 0; i < ARM_BONES.length; i++) this.clipRot[i].copy(this.armBone(i).quaternion);
    this.bent = true;
    rig.root.updateWorldMatrix(true, false);
    rig.root.getWorldQuaternion(RQ);
    if (prev) this.pose(this.armsPrev, this.armsPrevK * (1 - this.armsK));
    if (now) this.pose(this.armsNow, this.armsK);
  }

  /** Whether the arms take a pose of their own (block and cheer are the rig's armsUp). */
  private posed(a: Arms) {
    return a !== 'loose' && a !== 'block' && a !== 'cheer';
  }

  /** One pose at weight k. Directions are in the player's own frame (forward −z, left −x), turned to the world. */
  private pose(a: Arms, k: number) {
    if (k < 0.01) return;
    if (a === 'ready') {
      this.arm(LEFT, -0.35, -0.75, -0.55, -0.1, -0.1, -1, k);
      this.arm(RIGHT, 0.35, -0.75, -0.55, 0.1, -0.1, -1, k);
    } else if (a === 'dig') {
      this.arm(LEFT, 0.12, -0.62, -1, 0.2, -0.55, -1, k);
      this.arm(RIGHT, -0.12, -0.62, -1, -0.2, -0.55, -1, k);
    } else if (a === 'set') {
      this.arm(LEFT, -0.55, 0.8, -0.45, 0.25, 1, -0.2, k);
      this.arm(RIGHT, 0.55, 0.8, -0.45, -0.25, 1, -0.2, k);
    } else if (a === 'cock') {
      // the hitting arm drawn back behind the head, the other reaching up at the ball
      this.arm(RIGHT, 0.45, 0.85, 0.45, -0.1, 0.55, 0.85, k);
      this.arm(LEFT, -0.25, 0.95, -0.35, -0.1, 1, -0.3, k);
    } else if (a === 'swing') {
      // the whip: from overhead to down past the hip, over a quarter of a second
      const s = this.swingT;
      const up = Math.cos(s * Math.PI * 0.8);
      const fw = Math.sin(s * Math.PI * 0.8);
      this.arm(RIGHT, 0.3, up, -fw - 0.2, 0.15, up * 0.9, -fw - 0.4, k);
      this.arm(LEFT, -0.4, -0.3, -0.6, -0.1, -0.5, -0.8, k);
    }
  }

  /** Aims one arm (`side` LEFT or RIGHT into bones): the upper arm along (ux, uy, uz), the forearm along (lx, ly, lz), by k. */
  private arm(side: number, ux: number, uy: number, uz: number, lx: number, ly: number, lz: number, k: number) {
    const b = this.bones;
    aim(b[side], b[side + 1], DIR.set(ux, uy, uz).normalize().applyQuaternion(RQ), k);
    aim(b[side + 1], b[side + 2], DIR.set(lx, ly, lz).normalize().applyQuaternion(RQ), k);
  }

  dispose() {
    this.rig?.dispose();
    this.rig = null;
  }
}

// ------------------------------------------------------------------------------------ looks

/** Rosa's own avatar at the booth on the mainland: she isn't one of the island's regulars. */
const ROSA = 'Female_Adult_09';

/**
 * A look for one of the island's people, never one in `exclude` (nobody is someone else's double):
 * the first avatar of `prefer` that's loaded (so the island's regulars are the same people every
 * day), at its own size times `height`; else whoever roleLook finds for `role`; and once everyone of
 * that role is taken (the island has only a few swimmers and beachgoers), a park guest in holiday
 * colours.
 */
export function castLook(people: PeopleFactory, prefer: readonly string[], role: LookRole, r: () => number, gender: Gender, exclude: ReadonlySet<string>, height = 1): Look {
  const free = (id: string) => !exclude.has(id) && id !== ROSA;
  for (const id of prefer) {
    const spec = people.spec(id);
    if (spec && people.has(id) && free(id)) return plainLook(spec, height);
  }
  for (let k = 0; k < 6; k++) {
    const look = people.roleLook(role, r, { gender });
    if (free(look.avatar)) return look;
  }
  const look = people.randomLook(r, { gender, exclude: [...exclude, ROSA] });
  const spec = people.spec(look.avatar);
  if (spec) dyeLook(look, spec, r, 0.8, true);
  return look;
}

/**
 * A team kit dyed onto a look: the shirt (or the swimsuit, when that's all there is) in the team's
 * colour, the shorts dark. Swim trunks with no top take the team's colour themselves.
 */
export function kit(people: PeopleFactory, look: Look, colour: string, shorts = '#1d2230'): Look {
  const regions = people.spec(look.avatar)?.outfit?.regions ?? {};
  look.top = regions.top ? colour : null;
  look.bottom = regions.bottom ? (regions.top ? shorts : colour) : null;
  return look;
}

/** Who plays: the partner and the regular on the visitor's side (teal), the two locals (mustard). */
export const TEAM = { home: '#2ec4b6', away: '#f2b632' };

/**
 * The island's four players, the same people every day: the partner a swimmer (barefoot on the
 * sand), the regular who keeps the visitor's place warm in a polo and shorts, the locals in swim
 * shorts and in a vest. Never the visitor's own avatar (`visitor`), so nobody plays their double.
 */
export function playerLooks(people: PeopleFactory, visitor: string) {
  const r = mulberry(2207);
  const used = new Set([visitor]);
  const cast = (prefer: string[], role: LookRole, gender: Gender, colour: string) => {
    const look = kit(people, castLook(people, prefer, role, r, gender, used, 1.02 + r() * 0.04), colour);
    used.add(look.avatar);
    return look;
  };
  const partner = cast(['Sports_Female_01'], 'swim', 'f', TEAM.home);
  const locals = [cast(['Sports_Male_01'], 'swim', 'm', TEAM.away), cast(['Sports_Male_04'], 'beach', 'm', TEAM.away)];
  const stand = cast(['Male_Adult_01', 'Sports_Male_04'], 'beach', 'm', TEAM.home);
  return { partner, stand, locals, used };
}

/** The visitor as a beach player: their own look (no bought hat out on the sand, so their own cap shows again). */
export function visitorBeachLook(look: Look): Look {
  return { ...look, hide: undefined };
}

/**
 * The fans on the bleachers and the umpire: people who sit (or stand on the stand) and cheer when
 * the visitor wins a point. They only animate while the camera is near.
 */
export class Fans {
  private rigs: { rig: PersonRig; seated: boolean; cheer: number; phase: number }[] = [];

  /** `exclude`: avatars already on the court (and the visitor's), so no fan is a player's double. */
  constructor(
    people: PeopleFactory,
    parent: THREE.Object3D,
    seats: { x: number; y: number; z: number; yaw: number }[],
    umpire: { x: number; y: number; z: number; yaw: number } | null,
    shadows: boolean,
    exclude: ReadonlySet<string> = new Set(),
  ) {
    const r = mulberry(404);
    const used = new Set(exclude);
    if (umpire) {
      // (first, so the park's older man is free for it) an older man in the umpire's white shirt and navy trousers
      const look = people.randomLook(r, { gender: 'm', age: 'old', dye: 0, exclude: [...used, ROSA] });
      used.add(look.avatar);
      const regions = people.spec(look.avatar)?.outfit?.regions ?? {};
      if (regions.top) look.top = '#f4f4f2';
      if (regions.bottom) look.bottom = '#1d2230';
      const rig = people.create(look);
      rig.setShadows(shadows);
      rig.root.position.set(umpire.x, umpire.y, umpire.z);
      rig.root.rotation.y = umpire.yaw;
      parent.add(rig.root);
      this.rigs.push({ rig, seated: false, cheer: 0, phase: 0 });
    }
    seats.forEach((s, i) => {
      // summer at the beach: holidaymakers in tees, vests and shorts, women and men in turn (the
      // island's few men in summer clothes are mostly on the court already)
      const look = castLook(people, [], 'beach', r, i % 2 ? 'm' : 'f', used);
      used.add(look.avatar);
      const rig = people.create(look);
      rig.setBase('sit');
      rig.setShadows(shadows);
      rig.root.position.set(s.x, s.y - rig.seatDrop, s.z);
      rig.root.rotation.y = s.yaw;
      parent.add(rig.root);
      this.rigs.push({ rig, seated: true, cheer: 0, phase: r() * 0.6 });
    });
  }

  /** The fans jump up and cheer (`k` 0..1 how many of them). */
  cheer(k: number) {
    for (const f of this.rigs) if (f.seated && Math.random() < 0.35 + k * 0.6) f.cheer = 1.4 + f.phase + Math.random() * 0.6;
  }

  /** `camDist`: the camera's distance from the court (they rest beyond 70 m); `cam` the camera in the court's frame. */
  update(dt: number, camDist: number, cam: THREE.Vector3) {
    const near = camDist < 70;
    for (const f of this.rigs) {
      f.rig.root.visible = camDist < 160;
      if (!near) continue;
      if (f.cheer > 0) {
        f.cheer -= dt;
        f.rig.armsUp = Math.min(1, f.rig.armsUp + dt * 6);
      } else f.rig.armsUp = Math.max(0, f.rig.armsUp - dt * 3);
      f.rig.setDistance(D.copy(f.rig.root.position).setY(f.rig.root.position.y + 1).distanceTo(cam));
      f.rig.update(dt, 0);
    }
  }

  setGlow(k: number) {
    for (const f of this.rigs) f.rig.setGlow(k);
  }

  setVisible(on: boolean) {
    for (const f of this.rigs) f.rig.root.visible = on;
  }

  dispose() {
    for (const f of this.rigs) f.rig.dispose();
    this.rigs = [];
  }
}
