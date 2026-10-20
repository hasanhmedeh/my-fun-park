// The A320's moving parts as bones: where each one hinges (its pivot, in the body frame) and about
// which axis it turns. The geometry binds every vertex to one of these, and the model's setVisual
// turns and slides them (rotation about the hinge axis, plus a translation for Fowler flaps,
// slats, reverser sleeves, doors and oleos).
//
// All bones have an identity rest rotation, so a bone's frame is the body frame moved to its
// pivot: the motion code can work in body axes directly. Children (oleo → wheel) hang off their
// parent so they follow its retraction.

import * as THREE from 'three';
import type { Vec } from './mesh';
import {
  CARGO,
  DOOR,
  DOORS,
  ENGINE,
  FIN,
  FLAPS,
  HSTAB,
  MAIN_GEAR,
  NOSE_BAY,
  NOSE_GEAR,
  SLATS,
  SPLIT,
  SPOILERS,
  airfoil,
  finAt,
  fuselage,
  hstabChord,
  hstabLe,
  hstabY,
  skinAt,
  sAtHeight,
  wingPoint,
  wingTc,
} from './shape';

export const BONE = {
  root: 0,
  slatL: 1,
  slatR: 2,
  flapInL: 3,
  flapInR: 4,
  flapOutL: 5,
  flapOutR: 6,
  ailL: 7,
  ailR: 8,
  /** Five spoiler panels per side, inboard first. */
  spoilerL: 9,
  spoilerR: 14,
  elevL: 19,
  elevR: 20,
  rudder: 21,
  mlgL: 22,
  oleoL: 23,
  wheelL: 24,
  mlgR: 25,
  oleoR: 26,
  wheelR: 27,
  nlg: 28,
  nOleo: 29,
  nSteer: 30,
  nWheel: 31,
  nDoorL: 32,
  nDoorR: 33,
  revL: 34,
  revR: 35,
  fanL: 36,
  fanR: 37,
  doorL1: 38,
  doorL2: 39,
  cargoF: 40,
  cargoA: 41,
} as const;
export const BONE_COUNT = 42;

export type Side = -1 | 1;
/** Per-side bone ids (side −1 = left). */
export const sideBones = (s: Side) =>
  s < 0
    ? { slat: BONE.slatL, flapIn: BONE.flapInL, flapOut: BONE.flapOutL, ail: BONE.ailL, spoiler: BONE.spoilerL, elev: BONE.elevL, mlg: BONE.mlgL, oleo: BONE.oleoL, wheel: BONE.wheelL, rev: BONE.revL, fan: BONE.fanL }
    : { slat: BONE.slatR, flapIn: BONE.flapInR, flapOut: BONE.flapOutR, ail: BONE.ailR, spoiler: BONE.spoilerR, elev: BONE.elevR, mlg: BONE.mlgR, oleo: BONE.oleoR, wheel: BONE.wheelR, rev: BONE.revR, fan: BONE.fanR };

export interface BoneDef {
  parent: number;
  /** Pivot in the body frame. */
  pivot: Vec;
  /** Hinge axis (unit, body frame), for parts that turn. */
  axis: Vec;
  /** Direction a part slides along (unit, body frame), for parts that translate. */
  slide: Vec;
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a: Vec, b: Vec): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const unit = (a: Vec): Vec => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A point on the wing's camber line (h = camber) or skin, at span x on side s. */
export function wingPt(s: Side, x: number, c: number, surface: 'camber' | 'up' | 'lo' = 'camber'): Vec {
  const f = airfoil(c, wingTc(x));
  const p = wingPoint(x, c, surface === 'camber' ? f.camber : surface === 'up' ? f.up : f.lo, { y: 0, z: 0 });
  return [s * x, p.y, p.z];
}

/** A hinge line on the wing from span x0 to x1 at chord fraction c. */
function wingHinge(s: Side, x0: number, x1: number, c: number, surface: 'camber' | 'up' = 'camber') {
  const a = wingPt(s, x0, c, surface);
  const b = wingPt(s, x1, c, surface);
  return { pivot: mid(a, b), axis: unit(sub(b, a)) };
}

/** Forward, perpendicular to a hinge line, in the plane of the wing (for the slats' travel). */
function forwardOf(axis: Vec): Vec {
  const back: Vec = [0, 0, 1];
  const d = back[0] * axis[0] + back[1] * axis[1] + back[2] * axis[2];
  return unit([-(back[0] - d * axis[0]), -(back[1] - d * axis[1]), -(back[2] - d * axis[2])]);
}

export function rigDefs(): BoneDef[] {
  const none: Vec = [0, 0, 0];
  const defs: BoneDef[] = Array.from({ length: BONE_COUNT }, () => ({ parent: BONE.root, pivot: [0, 0, 0] as Vec, axis: [1, 0, 0] as Vec, slide: none }));
  defs[BONE.root].parent = -1;
  const set = (i: number, d: Partial<BoneDef>) => Object.assign(defs[i], d);

  for (const s of [-1, 1] as Side[]) {
    const b = sideBones(s);
    // slats: one leading-edge line for all panels (the A320's leading edge is straight)
    const slat = wingHinge(s, SLATS[0].x0, SLATS[1].x1, 0.02);
    set(b.slat, { ...slat, slide: forwardOf(slat.axis) });
    set(b.flapIn, { ...wingHinge(s, FLAPS.inner.x0, FLAPS.inner.x1, SPLIT.flap), slide: [0, 0, 1] });
    set(b.flapOut, { ...wingHinge(s, FLAPS.outer.x0, FLAPS.outer.x1, SPLIT.flap), slide: [0, 0, 1] });
    set(b.ail, wingHinge(s, FLAPS.aileron.x0, FLAPS.aileron.x1, SPLIT.flap));
    SPOILERS.forEach((p, i) => set(b.spoiler + i, wingHinge(s, p.x0, p.x1, SPLIT.spoiler, 'up')));

    // elevator hinge along 70 % of the stabiliser's chord
    const e0: Vec = [s * HSTAB.elevX0, hstabY(HSTAB.elevX0), hstabLe(HSTAB.elevX0) + HSTAB.elev * hstabChord(HSTAB.elevX0)];
    const e1: Vec = [s * HSTAB.elevX1, hstabY(HSTAB.elevX1), hstabLe(HSTAB.elevX1) + HSTAB.elev * hstabChord(HSTAB.elevX1)];
    set(b.elev, { pivot: mid(e0, e1), axis: unit(sub(e1, e0)) });

    // main gear: the leg turns inboard about a fore-aft axis at its trunnion; the oleo slides up the leg; the wheels spin on the axle
    set(b.mlg, { pivot: [s * MAIN_GEAR.x, MAIN_GEAR.trunnionY, MAIN_GEAR.z], axis: [0, 0, 1] });
    set(b.oleo, { parent: b.mlg, pivot: [s * MAIN_GEAR.x, MAIN_GEAR.wheelR, MAIN_GEAR.z], slide: [0, 1, 0] });
    set(b.wheel, { parent: b.oleo, pivot: [s * MAIN_GEAR.x, MAIN_GEAR.wheelR, MAIN_GEAR.z], axis: [1, 0, 0] });

    set(b.rev, { pivot: [s * ENGINE.x, ENGINE.y, -6.6], slide: [0, 0, 1] });
    set(b.fan, { pivot: [s * ENGINE.x, ENGINE.y, ENGINE.fanZ], axis: [0, 0, 1] });
  }
  const r0: Vec = [0, FIN.rudderY0, finAt(FIN.rudderY0).le + FIN.rudder * (finAt(FIN.rudderY0).te - finAt(FIN.rudderY0).le)];
  const r1: Vec = [0, FIN.rudderY1, finAt(FIN.rudderY1).le + FIN.rudder * (finAt(FIN.rudderY1).te - finAt(FIN.rudderY1).le)];
  set(BONE.rudder, { pivot: mid(r0, r1), axis: unit(sub(r1, r0)) });

  // nose gear: leg turns forward about a lateral axis; oleo slides; steering turns about the leg; wheels spin
  set(BONE.nlg, { pivot: [0, NOSE_GEAR.trunnionY, NOSE_GEAR.z], axis: [1, 0, 0] });
  set(BONE.nOleo, { parent: BONE.nlg, pivot: [0, NOSE_GEAR.wheelR, NOSE_GEAR.z], slide: [0, 1, 0] });
  set(BONE.nSteer, { parent: BONE.nOleo, pivot: [0, NOSE_GEAR.wheelR, NOSE_GEAR.z], axis: [0, 1, 0] });
  set(BONE.nWheel, { parent: BONE.nSteer, pivot: [0, NOSE_GEAR.wheelR, NOSE_GEAR.z], axis: [1, 0, 0] });
  const bayZ = (NOSE_BAY.z0 + NOSE_BAY.zSplit) / 2;
  const by = fuselage.bot(bayZ) + 0.03;
  set(BONE.nDoorL, { pivot: [-NOSE_BAY.halfW, by, bayZ], axis: [0, 0, 1] });
  set(BONE.nDoorR, { pivot: [NOSE_BAY.halfW, by, bayZ], axis: [0, 0, 1] });

  // passenger doors: pivot at the door's centre on the skin; cargo doors hinge along their top edge
  for (const [bone, d] of [[BONE.doorL1, DOORS.L1], [BONE.doorL2, DOORS.L2]] as const) {
    const s = sAtHeight(d.z, 'L', DOOR.sill + DOOR.h / 2);
    const p = skinAt(d.z, s, { x: 0, y: 0 });
    set(bone, { pivot: [p.x, p.y, d.z] });
  }
  for (const [bone, d] of [[BONE.cargoF, CARGO.fwd], [BONE.cargoA, CARGO.aft]] as const) {
    const z = (d.z0 + d.z1) / 2;
    const p = skinAt(z, sAtHeight(z, 'R', CARGO.y1), { x: 0, y: 0 });
    set(bone, { pivot: [p.x, p.y, z], axis: [0, 0, 1] });
  }
  return defs;
}

/** Retraction: the nose leg swings forward through this angle (rad) about its trunnion's lateral axis. */
export const NOSE_RETRACT = Math.PI / 2 + 0.03;
/** Retraction: each main leg swings inboard through this angle (rad). */
export const MAIN_RETRACT = Math.PI / 2;

/** The nose leg's motion when fully up, as a matrix in the body frame (the aft bay door is built through its inverse). */
export function noseRetracted() {
  const p = new THREE.Vector3(0, NOSE_GEAR.trunnionY, NOSE_GEAR.z);
  return new THREE.Matrix4()
    .makeTranslation(p.x, p.y, p.z)
    .multiply(new THREE.Matrix4().makeRotationX(NOSE_RETRACT))
    .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}

/** A main leg's motion when fully up (side −1 left: it turns inboard, i.e. towards +x). */
export function mainRetracted(s: Side) {
  const p = new THREE.Vector3(s * MAIN_GEAR.x, MAIN_GEAR.trunnionY, MAIN_GEAR.z);
  return new THREE.Matrix4()
    .makeTranslation(p.x, p.y, p.z)
    .multiply(new THREE.Matrix4().makeRotationZ(-s * MAIN_RETRACT))
    .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}

/** The main gear's angle sign: rotating the leg by `-s * angle` about +z swings its foot inboard. */
export const mainRetractSign = (s: Side) => -s;

