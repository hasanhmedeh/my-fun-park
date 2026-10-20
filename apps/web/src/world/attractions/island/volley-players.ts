// Beach Volley's people: the four players on the sand (the visitor and their partner against the
// two locals), the umpire on the stand, and a few fans on the bleachers. Each is a crowd rig
// (crowd/people.ts) living in the court's frame (see volley-ball.ts), moved by the game: they run
// to where the ball will come down, jump to serve, spike and block, dive for a dig, and the arm
// poses the guest animations don't have (the forearm platform of a dig, the hands of a set, the
// cocked arm and whip of a spike) are layered on top procedurally.

import * as THREE from 'three';
import { randomLook, type Look, type PeopleFactory, type PersonRig } from '../../crowd/people';
import { mulberry } from '../../random';
import { SAND_Y } from './volley-ball';

/** What a player's arms are doing. */
export type Arms = 'loose' | 'ready' | 'dig' | 'set' | 'cock' | 'swing' | 'block' | 'cheer';

const V = new THREE.Vector3();
const W = new THREE.Vector3();
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

/**
 * One player on the sand. Positions are in the court's frame; `goTo` sets where to run, `face`
 * which way to look, `jump` and `arms` what to do there.
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
  private bones: Record<string, THREE.Object3D> = {};
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

  constructor(
    readonly look: Look,
    x: number,
    z: number,
    facing: number,
  ) {
    this.pos.set(x, 0, z);
    this.goal.copy(this.pos);
    this.facing = this.faceGoal = facing;
  }

  /** Gives the player a body (once the people models have loaded). */
  attach(rig: PersonRig, parent: THREE.Object3D, shadows: boolean) {
    this.rig = rig;
    rig.setShadows(shadows);
    for (const n of ['upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r'] as const) {
      const b = rig.root.getObjectByName(n);
      if (b) this.bones[n] = b;
    }
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

  /** A dive along (dx, dz): the roll clip, and a lunge along the sand. */
  dive(dx: number, dz: number) {
    const l = Math.hypot(dx, dz) || 1;
    this.diveDir.set(dx / l, 0, dz / l);
    this.diveT = 0;
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
   */
  update(dt: number, camDist: number) {
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
    this.lod = camDist < 35 ? 1 : camDist < 80 ? 2 : 4;
    this.skip += dt;
    if (++this.armsSkip % this.lod !== 0) return;
    const step = this.skip;
    this.skip = 0;
    this.rig.setDetail(camDist < 22);
    this.rig.update(step, this.airborne ? 0 : ground);
    this.poseArms(step);
  }

  private place() {
    if (!this.rig) return;
    this.rig.root.position.set(this.pos.x, SAND_Y + this.pos.y, this.pos.z);
    this.rig.root.rotation.y = this.facing;
  }

  /** The arm poses on top of the clips: blended in quickly, out a little slower. */
  private poseArms(dt: number) {
    const rig = this.rig!;
    const b = this.bones;
    if (!b.upperarm_l || !b.upperarm_r) return;
    this.armsK = Math.min(1, this.armsK + dt * (this.armsNow === 'swing' ? 30 : 9));
    this.armsPrevK = Math.max(0, this.armsPrevK - dt * 6);
    if (this.armsNow === 'swing') this.swingT = Math.min(1, this.swingT + dt / 0.24);
    rig.armsUp = this.armsNow === 'block' || this.armsNow === 'cheer' ? this.armsK : this.armsPrev === 'block' || this.armsPrev === 'cheer' ? this.armsPrevK : 0;
    rig.root.updateWorldMatrix(true, false);
    rig.root.getWorldQuaternion(RQ);
    if (this.armsPrevK > 0.01) this.pose(this.armsPrev, this.armsPrevK * (1 - this.armsK));
    this.pose(this.armsNow, this.armsK);
  }

  /** One pose at weight k. Directions are in the player's own frame (forward −z, left −x), turned to the world. */
  private pose(a: Arms, k: number) {
    if (k < 0.01 || a === 'loose' || a === 'block' || a === 'cheer') return;
    const b = this.bones;
    const dir = (x: number, y: number, z: number) => W.set(x, y, z).normalize().applyQuaternion(RQ).clone();
    const both = (ul: THREE.Vector3, ll: THREE.Vector3, ur: THREE.Vector3, lr: THREE.Vector3) => {
      aim(b.upperarm_l, b.lowerarm_l, ul, k);
      aim(b.lowerarm_l, b.hand_l, ll, k);
      aim(b.upperarm_r, b.lowerarm_r, ur, k);
      aim(b.lowerarm_r, b.hand_r, lr, k);
    };
    if (a === 'ready') both(dir(-0.35, -0.75, -0.55), dir(-0.1, -0.1, -1), dir(0.35, -0.75, -0.55), dir(0.1, -0.1, -1));
    else if (a === 'dig') both(dir(0.12, -0.62, -1), dir(0.2, -0.55, -1), dir(-0.12, -0.62, -1), dir(-0.2, -0.55, -1));
    else if (a === 'set') both(dir(-0.55, 0.8, -0.45), dir(0.25, 1, -0.2), dir(0.55, 0.8, -0.45), dir(-0.25, 1, -0.2));
    else if (a === 'cock') {
      // the hitting arm drawn back behind the head, the other reaching up at the ball
      aim(b.upperarm_r, b.lowerarm_r, dir(0.45, 0.85, 0.45), k);
      aim(b.lowerarm_r, b.hand_r, dir(-0.1, 0.55, 0.85), k);
      aim(b.upperarm_l, b.lowerarm_l, dir(-0.25, 0.95, -0.35), k);
      aim(b.lowerarm_l, b.hand_l, dir(-0.1, 1, -0.3), k);
    } else if (a === 'swing') {
      // the whip: from overhead to down past the hip, over a quarter of a second
      const s = this.swingT;
      const up = Math.cos(s * Math.PI * 0.8);
      const fw = Math.sin(s * Math.PI * 0.8);
      aim(b.upperarm_r, b.lowerarm_r, dir(0.3, up, -fw - 0.2), k);
      aim(b.lowerarm_r, b.hand_r, dir(0.15, up * 0.9, -fw - 0.4), k);
      aim(b.upperarm_l, b.lowerarm_l, dir(-0.4, -0.3, -0.6), k);
      aim(b.lowerarm_l, b.hand_l, dir(-0.1, -0.5, -0.8), k);
    }
  }

  dispose() {
    this.rig?.dispose();
    this.rig = null;
  }
}

/** The painted skin's own tone, which the look's skin colour multiplies: a 'shoe' this colour is a bare foot. */
const BARE_FOOT = new THREE.Color('#c8916f');

/** Beachwear for a player: sleeveless or a vest, shorts, bare feet (shoes the colour of the skin). */
export function beachLook(r: () => number, top: string, gender?: 'm' | 'f'): Look {
  const l = randomLook(r, { gender, age: 'young' });
  l.top.set(top);
  l.sleeve = -0.1;
  l.legEnd = 0.31;
  l.pants.set(r() < 0.5 ? '#1d2230' : '#2a3a5c');
  l.shoe.copy(BARE_FOOT).multiply(l.skin);
  l.build = 0.98 + r() * 0.1;
  l.height = l.gender === 'm' ? 1.84 + r() * 0.12 : 1.74 + r() * 0.1;
  return l;
}

/** The visitor as a beach player: their own look, barefoot, in shorts. */
export function visitorBeachLook(look: Look): Look {
  return { ...look, skin: look.skin.clone(), hair: look.hair.clone(), top: look.top.clone(), pants: look.pants.clone(), shoe: BARE_FOOT.clone().multiply(look.skin), legEnd: 0.31 };
}

/**
 * The fans on the bleachers and the umpire: rigs that sit (or stand on the stand) and cheer when
 * the visitor wins a point. They only animate while the camera is near.
 */
export class Fans {
  private rigs: { rig: PersonRig; seated: boolean; cheer: number; phase: number }[] = [];

  constructor(
    factory: PeopleFactory,
    parent: THREE.Object3D,
    seats: { x: number; y: number; z: number; yaw: number }[],
    umpire: { x: number; y: number; z: number; yaw: number } | null,
    shadows: boolean,
  ) {
    const r = mulberry(404);
    for (const s of seats) {
      const look = randomLook(r);
      // summer at the beach: short sleeves or none, shorts more often than not
      look.sleeve = r() < 0.4 ? -0.1 : 0.25;
      if (r() < 0.7) look.legEnd = 0.31;
      const rig = factory.create(look);
      rig.setBase('sit');
      rig.setShadows(shadows);
      rig.root.position.set(s.x, s.y - rig.seatDrop, s.z);
      rig.root.rotation.y = s.yaw;
      parent.add(rig.root);
      this.rigs.push({ rig, seated: true, cheer: 0, phase: r() * 0.6 });
    }
    if (umpire) {
      const look = randomLook(r, { gender: 'm', age: 'old' });
      look.top.set('#f4f4f2');
      look.pants.set('#1d2230');
      look.sleeve = 0.3;
      look.legEnd = 0.31;
      const rig = factory.create(look);
      rig.setShadows(shadows);
      rig.root.position.set(umpire.x, umpire.y, umpire.z);
      rig.root.rotation.y = umpire.yaw;
      parent.add(rig.root);
      this.rigs.push({ rig, seated: false, cheer: 0, phase: 0 });
    }
  }

  /** The fans jump up and cheer (`k` 0..1 how many of them). */
  cheer(k: number) {
    for (const f of this.rigs) if (f.seated && Math.random() < 0.35 + k * 0.6) f.cheer = 1.4 + f.phase + Math.random() * 0.6;
  }

  update(dt: number, camDist: number) {
    const near = camDist < 70;
    for (const f of this.rigs) {
      f.rig.root.visible = camDist < 160;
      if (!near) continue;
      if (f.cheer > 0) {
        f.cheer -= dt;
        f.rig.armsUp = Math.min(1, f.rig.armsUp + dt * 6);
      } else f.rig.armsUp = Math.max(0, f.rig.armsUp - dt * 3);
      f.rig.setDetail(camDist < 22);
      f.rig.update(dt, 0);
    }
  }

  setGlow(k: number) {
    for (const f of this.rigs) f.rig.setGlow(k);
  }

  setVisible(on: boolean) {
    for (const f of this.rigs) f.rig.root.visible = on;
  }
}
