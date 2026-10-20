// Drives the A320's bones from a PlaneVisual: every moving part turns about its hinge (rig.ts) and
// slides where it really travels. Slats run out along their tracks and droop; the Fowler flaps
// roll aft first and then turn down; ailerons droop with the flaps; the spoilers rise; the gear
// legs swing inboard / forward in sequence with their doors; the oleos compress; the nosewheel
// steers; the reverser sleeves translate aft; the doors open outwards and swing forward flat
// against the fuselage; the cargo doors lift on their top hinges.

import * as THREE from 'three';
import { A320_POINTS } from '../../../aviation/a320';
import type { PlaneVisual } from '../../../aviation/types';
import { MAIN_GEAR, NOSE_GEAR, DOOR, DOORS, ENGINE } from './shape';
import { BONE, BONE_COUNT, MAIN_RETRACT, NOSE_RETRACT, mainRetractSign, rigDefs, sideBones, type BoneDef, type Side } from './rig';

const DEG = Math.PI / 180;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const DEFS = rigDefs();

/** The skeleton's inverse bind matrices: every bone's rest frame is the body frame moved to its pivot. */
const INVERSES = DEFS.map((d) => new THREE.Matrix4().makeTranslation(-d.pivot[0], -d.pivot[1], -d.pivot[2]));

const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _v = new THREE.Vector3();

export class Pose {
  readonly bones: THREE.Bone[];
  readonly root: THREE.Bone;
  readonly skeleton: THREE.Skeleton;
  private fan: [number, number] = [0, 0];
  private wheel = 0;
  private noseWheel = 0;

  constructor() {
    this.bones = DEFS.map(() => new THREE.Bone());
    DEFS.forEach((d, i) => {
      const b = this.bones[i];
      b.name = `a320-${i}`;
      const pp = d.parent >= 0 ? DEFS[d.parent].pivot : [0, 0, 0];
      b.position.set(d.pivot[0] - pp[0], d.pivot[1] - pp[1], d.pivot[2] - pp[2]);
      if (d.parent >= 0) this.bones[d.parent].add(b);
    });
    this.root = this.bones[BONE.root];
    this.skeleton = new THREE.Skeleton(this.bones, INVERSES.map((m) => m.clone()));
    if (this.bones.length !== BONE_COUNT) throw new Error('A320 rig: bone count mismatch');
  }

  private rest(i: number) {
    const d = DEFS[i];
    const pp = d.parent >= 0 ? DEFS[d.parent].pivot : [0, 0, 0];
    return this.bones[i].position.set(d.pivot[0] - pp[0], d.pivot[1] - pp[1], d.pivot[2] - pp[2]);
  }

  /** Turn bone i about its own hinge axis by `angle`, and slide it `slide` metres along its travel. */
  private hinge(i: number, angle: number, slide = 0, drop = 0) {
    const d: BoneDef = DEFS[i];
    const b = this.bones[i];
    b.quaternion.setFromAxisAngle(_ax.set(d.axis[0], d.axis[1], d.axis[2]), angle);
    const p = this.rest(i);
    if (slide) p.addScaledVector(_v.set(d.slide[0], d.slide[1], d.slide[2]), slide);
    if (drop) p.y -= drop;
  }

  /** Turn bone i (a root child) about an axis through `h` (body frame), after moving it by `out`. */
  private swing(i: number, h: THREE.Vector3, axis: THREE.Vector3, angle: number, out: THREE.Vector3) {
    const d = DEFS[i];
    _q.setFromAxisAngle(axis, angle);
    const b = this.bones[i];
    b.quaternion.copy(_q);
    // the bone's origin (its pivot), moved out, then turned about h
    b.position.set(d.pivot[0], d.pivot[1], d.pivot[2]).add(out).sub(h).applyQuaternion(_q).add(h);
  }

  apply(v: PlaneVisual, dt: number) {
    // ---- wing: slats, flaps, ailerons, spoilers
    const slatK = clamp01(v.slatsDeg / 27);
    const flapK = clamp01(v.flapsDeg / 40);
    const fowler = smooth(0, 0.55, flapK) * 0.62 + flapK * 0.28; // aft travel (m)
    const flapAngle = v.flapsDeg * DEG * (0.35 + 0.65 * smooth(0.12, 1, flapK)) * 1.05;
    for (const s of [-1, 1] as Side[]) {
      const bn = sideBones(s);
      // the tracks swing the slat about a centre below and behind the leading edge: it runs forward, droops
      // nose-down and drops, leaving the slot open between its trailing edge and the wing's nose
      this.hinge(bn.slat, -s * v.slatsDeg * DEG * 0.75, 0.42 * smooth(0, 0.7, slatK) + 0.12 * slatK, 0.24 * smooth(0, 0.8, slatK));
      this.hinge(bn.flapIn, s * flapAngle, fowler, 0.1 * flapK);
      this.hinge(bn.flapOut, s * flapAngle * 0.92, fowler * 0.9, 0.08 * flapK);
      // aileron +1 rolls right: the right one rises, the left one drops; both droop 5° with the flaps out
      const ail = (s > 0 ? -v.aileron : v.aileron) * 25 + (v.flapsDeg > 0.5 ? 5 * smooth(0, 10, v.flapsDeg) : 0);
      this.hinge(bn.ail, s * ail * DEG);
      const sp = s < 0 ? v.spoilerL : v.spoilerR;
      for (let k = 0; k < 5; k++) this.hinge(bn.spoiler + k, -s * sp * 50 * DEG);
      // elevator +1 = trailing edge up (nose up), 30° up / 17° down
      const el = v.elevator >= 0 ? v.elevator * 30 : v.elevator * 17;
      this.hinge(bn.elev, -s * el * DEG);
    }
    this.hinge(BONE.rudder, v.rudder * 30 * DEG);

    // ---- landing gear: the legs travel through the middle of the cycle, the doors open around it
    const g = clamp01(v.gear);
    const legK = smooth(0.12, 0.92, g);
    for (const s of [-1, 1] as Side[]) {
      const bn = sideBones(s);
      this.hinge(bn.mlg, mainRetractSign(s) * (1 - legK) * MAIN_RETRACT);
      this.hinge(bn.oleo, 0, Math.min(A320_POINTS.gearStroke, v.compression[s < 0 ? 1 : 2]));
      this.hinge(bn.wheel, -this.wheel);
    }
    this.hinge(BONE.nlg, (1 - smooth(0.06, 0.85, g)) * NOSE_RETRACT);
    this.hinge(BONE.nOleo, 0, Math.min(A320_POINTS.gearStroke, v.compression[0]));
    this.hinge(BONE.nSteer, -v.nosewheel * DEG);
    this.hinge(BONE.nWheel, -this.noseWheel);
    // the nose bay's forward doors open only while the leg is moving, shut when it's down or up
    const bay = clamp01(Math.min(g, 1 - g) * 9);
    this.hinge(BONE.nDoorL, -bay * 92 * DEG);
    this.hinge(BONE.nDoorR, bay * 92 * DEG);

    // ---- engines: reverser sleeves, fans
    for (const s of [-1, 1] as Side[]) {
      const bn = sideBones(s);
      this.hinge(bn.rev, 0, v.reverser * ENGINE.sleeve);
      this.hinge(bn.fan, this.fan[s < 0 ? 0 : 1]);
    }

    // ---- doors
    this.door(BONE.doorL1, DOORS.L1.z, v.doorL1);
    this.door(BONE.doorL2, DOORS.L2.z, v.doorL2);
    const cargo = smooth(0, 1, v.cargo) * 105 * DEG;
    this.hinge(BONE.cargoF, cargo);
    this.hinge(BONE.cargoA, cargo);

    // ---- spin
    for (const i of [0, 1]) this.fan[i] = (this.fan[i] + dt * (0.6 + 8.5 * v.n1[i]) * (v.n1[i] > 0.01 ? 1 : 0)) % (Math.PI * 2);
    this.wheel = (this.wheel + v.wheelSpin * dt) % (Math.PI * 2);
    this.noseWheel = (this.noseWheel + v.wheelSpin * dt * (MAIN_GEAR.wheelR / NOSE_GEAR.wheelR)) % (Math.PI * 2);
  }

  private readonly hingePt = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly out = new THREE.Vector3();

  /**
   * A passenger door (left side): it lifts and pushes out of its frame, then swings forward on its
   * arm about a vertical hinge ahead of the opening and outboard, ending flat against the skin.
   */
  private door(i: number, z: number, k: number) {
    const lift = smooth(0, 0.18, k);
    const turn = smooth(0.15, 1, k);
    this.out.set(-0.09 * lift, 0.05 * lift, 0);
    this.hingePt.set(DEFS[i].pivot[0] - 0.2, DOOR.sill, z - DOOR.w / 2 - 0.08);
    this.swing(i, this.hingePt, this.up, -turn * 176 * DEG, this.out);
  }
}
