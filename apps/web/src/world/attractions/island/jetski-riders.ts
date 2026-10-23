// The Jet-Ski Race's riders as real people (crowd/person-rig.ts) sat astride the saddle in their
// own clothes and a life vest. The riding clip (Driving_Loop: seated, fists closed on a wheel)
// carries the breathing and the grip; on top of it the pose a rider holds is laid procedurally
// every frame: the back bent forward over the bars, both hands on the grips and both feet in the
// footwells (two-bone IK, so they stay put however the rider leans), the head turned into the
// corner. The vest is a foam shell fitted to the body's own torso once (from its skinned
// vertices) and carried by the upper spine.
//
// Every rider lives in its ski's "seat" frame (the saddle's top, which the race leans and bobs),
// nose to −z. Far away a rider swaps to the old merged figure (one draw call) in matching colours.

import * as THREE from 'three';
import type { PeopleFactory } from '../../crowd/people-factory';
import type { PersonRig } from '../../crowd/person-rig';
import type { CanonicalBone } from '../../crowd/people-manifest';
import { dyeLook, pickFrom, SWIM, type Look } from '../../crowd/looks';
import { mulberry } from '../../random';
import { FOOTWELL, GRIP, SADDLE } from './jetski-models';
import { castLook } from './volley-players';

const V = new THREE.Vector3();
const W = new THREE.Vector3();
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const PA = new THREE.Vector3();
const PB = new THREE.Vector3();
const PC = new THREE.Vector3();
const D = new THREE.Vector3();
const P = new THREE.Vector3();
const E = new THREE.Vector3();
const T = new THREE.Vector3();
const T2 = new THREE.Vector3();
const TGT = new THREE.Vector3();
const POLE = new THREE.Vector3();
const DIR = new THREE.Vector3();
const M = new THREE.Matrix4();

/** Turns a bone (in world space) so the direction to `child` (any descendant) becomes `dir`, by k. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3, k = 1) {
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

/** Rotates a bone by `angle` about a world-space axis. */
function turn(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  bone.updateWorldMatrix(true, false);
  Q1.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(Q2);
  Q2.premultiply(Q1);
  bone.parent!.getWorldQuaternion(Q1).invert();
  bone.quaternion.copy(Q1.multiply(Q2));
}

/**
 * Two-bone IK: bends a → b → c (shoulder, elbow, wrist; or hip, knee, ankle) so c reaches the
 * world point `target` (or as near as the limb's length allows), the middle joint pushed towards
 * the world direction `pole`.
 */
function twoBone(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  c.updateWorldMatrix(true, false);
  PA.setFromMatrixPosition(a.matrixWorld);
  PB.setFromMatrixPosition(b.matrixWorld);
  PC.setFromMatrixPosition(c.matrixWorld);
  const l1 = PA.distanceTo(PB);
  const l2 = PB.distanceTo(PC);
  D.subVectors(target, PA);
  let d = D.length();
  D.divideScalar(d || 1);
  d = THREE.MathUtils.clamp(d, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.998);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  P.copy(pole).addScaledVector(D, -pole.dot(D));
  if (P.lengthSq() < 1e-8) P.set(0, 1, 0);
  P.normalize();
  E.copy(PA).addScaledVector(D, x).addScaledVector(P, h);
  aim(a, b, T.subVectors(E, PA).normalize());
  T2.copy(PA).addScaledVector(D, d);
  aim(b, c, T.subVectors(T2, E).normalize());
}

// ------------------------------------------------------------------------------------ looks

/** A rider's colours, for the far figure that stands in for the rig. */
export interface RiderColours {
  vest: string;
  hair: string;
  skin: string;
}

/** The visitor on the water: themselves as they are (no bought hat out there, so their own cap shows again). */
export function visitorRiderLook(v: Look): Look {
  return { ...v, hide: undefined };
}

/**
 * The four rivals, by name order: Kai, Rosa, Sami and Theo, always the same people. They're the
 * island set's four (Kai and Rosa its swimmers, barefoot in their swimwear; Sami and Theo in shorts),
 * dyed from a fixed seed; another avatar stands in only where one of them is the visitor's own.
 * (Reef Rosa isn't the mainland booth's Rosa: castLook never picks her avatar.)
 */
export function rivalRiderLooks(people: PeopleFactory, visitor: string): Look[] {
  const r = mulberry(7311);
  const used = new Set([visitor]);
  const cast = (prefer: string, role: 'swim' | 'beach', gender: 'm' | 'f') => {
    const look = castLook(people, [prefer], role, r, gender, used);
    used.add(look.avatar);
    const spec = people.spec(look.avatar);
    const regions = spec?.outfit?.regions ?? {};
    if (role === 'swim') {
      // swimwear in a colour of its own
      const c = pickFrom(r, SWIM);
      if (regions.top) look.top = c;
      if (regions.bottom) look.bottom = c;
    } else if (spec) dyeLook(look, spec, r, 1, true);
    // dark water shoes (boots and trainers out on the water read as neoprene)
    if (regions.shoes && !spec?.tags.includes('barefoot')) look.shoes = '#23262d';
    return look;
  };
  return [cast('Sports_Male_01', 'swim', 'm'), cast('Sports_Female_01', 'swim', 'f'), cast('Female_Party_01', 'beach', 'f'), cast('Sports_Male_04', 'beach', 'm')];
}

/** The colours of a rider's far stand-in: the vest, the hair for the helmet, the skin for the suit. */
export function riderColours(people: PeopleFactory, look: Look, vest: string): RiderColours {
  const c = people.coloursOf(look);
  return { vest, hair: c.hair, skin: c.skin };
}

// ------------------------------------------------------------------------------------ the vest

/**
 * Normals for a triangle soup, averaged over the corners that share a position (smooth foam), but
 * only among triangles of the same `side` (one per triangle): the two faces of a strap share their
 * corners, and averaged together their normals cancel to rounding noise, which the lighting
 * interpolates through zero into NaN pixels (and the bloom spreads those over the whole screen).
 */
function smoothNormals(pos: number[], side: number[]) {
  const acc = new Map<string, THREE.Vector3>();
  const key = (i: number) => `${side[Math.floor(i / 9)]}:${Math.round(pos[i] * 2000)},${Math.round(pos[i + 1] * 2000)},${Math.round(pos[i + 2] * 2000)}`;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 9) {
    a.fromArray(pos, i);
    b.fromArray(pos, i + 3);
    c.fromArray(pos, i + 6);
    n.subVectors(c, b).cross(a.sub(b)); // area-weighted
    for (let k = 0; k < 3; k++) {
      const id = key(i + k * 3);
      const v = acc.get(id);
      if (v) v.add(n);
      else acc.set(id, n.clone());
    }
  }
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const v = acc.get(key(i))!;
    const l = v.length() || 1;
    out[i] = v.x / l;
    out[i + 1] = v.y / l;
    out[i + 2] = v.z / l;
  }
  return out;
}

const TORSO_BONES: readonly CanonicalBone[] = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'clavicle_l', 'clavicle_r'];

/**
 * A life vest fitted round the body as it sits now: horizontal slices of the torso's skinned
 * vertices (arms and head left out) give each ring of the shell its centre and half-widths, a
 * little foam added all round. Two buckled belts, a zip, shoulder straps and a collar pad.
 * Built in `frame`'s coordinates (the seat frame).
 */
function fitVest(rig: PersonRig, frame: THREE.Object3D, colour: string) {
  const body = rig.parts.body;
  const bones = body.skeleton.bones;
  const torso = new Set<THREE.Object3D>(TORSO_BONES.map((n) => rig.bone(n)));
  rig.root.updateMatrixWorld(true);
  frame.updateWorldMatrix(true, false);
  const inv = M.copy(frame.matrixWorld).invert();
  const at = (name: CanonicalBone) => rig.bone(name).getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const o = at('spine_01');
  const neck = at('neck_01');
  const Y = neck.clone().sub(o);
  const H = Y.length();
  Y.normalize();
  const X = new THREE.Vector3(1, 0, 0).addScaledVector(Y, -Y.x).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y).normalize(); // +z: the back

  // the torso's vertices in the (x across, y up the spine, z to the back) torso frame
  const pos = body.geometry.attributes.position;
  const si = body.geometry.attributes.skinIndex;
  const sw = body.geometry.attributes.skinWeight;
  const pts: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let best = 0;
    let bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    if (!torso.has(bones[best])) continue;
    body.getVertexPosition(i, p);
    p.applyMatrix4(body.matrixWorld).applyMatrix4(inv).sub(o);
    pts.push(p.dot(X), p.dot(Y), p.dot(Z));
  }
  const N = 9;
  const y0 = -0.06 * H;
  const y1 = 0.74 * H;
  const slab = ((y1 - y0) / (N - 1)) * 0.7;
  type Slice = { y: number; cx: number; cz: number; rx: number; rz: number };
  const slices: (Slice | null)[] = [];
  for (let j = 0; j < N; j++) {
    const y = y0 + ((y1 - y0) * j) / (N - 1);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      if (Math.abs(pts[i + 1] - y) > slab) continue;
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      z0 = Math.min(z0, pts[i + 2]);
      z1 = Math.max(z1, pts[i + 2]);
    }
    slices.push(x1 > x0 ? { y, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2, rz: (z1 - z0) / 2 } : null);
  }
  // gaps (shouldn't happen) borrow a neighbour; then smooth the widths a touch
  for (let j = 0; j < N; j++) if (!slices[j]) slices[j] = { ...(slices[j - 1] ?? slices.find((s) => s) ?? { cx: 0, cz: 0, rx: 0.16, rz: 0.11 }), y: y0 + ((y1 - y0) * j) / (N - 1) } as Slice;
  const S = slices as Slice[];
  // the top ring takes its width from just below (the shoulders' clavicle vertices widen it)
  S[N - 1].rx = Math.min(S[N - 1].rx, S[N - 2].rx);
  const foam = 0.028;

  const toFrame = (x: number, y: number, z: number) => new THREE.Vector3().copy(o).addScaledVector(X, x).addScaledVector(Y, y).addScaledVector(Z, z);
  const SEG = 18;
  const ringPt = (s: Slice, a: number, extra = 0) => {
    // a superellipse (boxier than an ellipse, like a foam vest's panels)
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const e = 0.8;
    const x = s.cx + Math.sign(c) * Math.pow(Math.abs(c), e) * (s.rx + foam + extra);
    const z = s.cz + Math.sign(sn) * Math.pow(Math.abs(sn), e) * (s.rz + foam + extra);
    return toFrame(x, s.y, z);
  };
  const positions: number[] = [];
  const colours: number[] = [];
  /** Which surface each triangle belongs to, for the smoothing: the shell 0, a strap's outer face 1, its inner face 2. */
  const sides: number[] = [];
  const C = new THREE.Color();
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.ColorRepresentation, side = 0) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    sides.push(side);
    C.set(col);
    for (let k = 0; k < 3; k++) colours.push(C.r, C.g, C.b);
  };
  const dark = '#23262d';
  // a = 0 at +x (the rider's right), π/2 at the back, −π/2 (3π/2) at the front
  for (let j = 0; j < N - 1; j++) {
    const belt = j === 2 || j === 5;
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * Math.PI * 2;
      const a1 = ((i + 1) / SEG) * Math.PI * 2;
      const lift = belt ? 0.006 : 0;
      const p00 = ringPt(S[j], a0, lift);
      const p01 = ringPt(S[j], a1, lift);
      const p10 = ringPt(S[j + 1], a0, lift);
      const p11 = ringPt(S[j + 1], a1, lift);
      const front = Math.abs(((a0 + a1) / 2) - Math.PI * 1.5) < 0.2;
      // two buckled belts across the foam, the zip down the front
      const col = belt ? (front ? '#ffd23f' : dark) : front ? dark : colour;
      // wound to face outward
      push(p00, p10, p01, col);
      push(p01, p10, p11, col);
    }
  }
  // the top and bottom rims rolled in a little (closes the shell edge from below and above)
  for (const [j, sgn] of [
    [0, -1],
    [N - 1, 1],
  ] as const) {
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * Math.PI * 2;
      const a1 = ((i + 1) / SEG) * Math.PI * 2;
      const outer0 = ringPt(S[j], a0);
      const outer1 = ringPt(S[j], a1);
      const inner0 = ringPt(S[j], a0, -foam).addScaledVector(Y, sgn * 0.004);
      const inner1 = ringPt(S[j], a1, -foam).addScaledVector(Y, sgn * 0.004);
      if (sgn > 0) {
        push(outer0, inner0, outer1, dark);
        push(outer1, inner0, inner1, dark);
      } else {
        push(outer0, outer1, inner0, dark);
        push(outer1, inner1, inner0, dark);
      }
    }
  }
  // shoulder straps: over each shoulder from the front rim to the back rim
  const top = S[N - 1];
  const sh = 1.02 * H; // the shoulders' top, near the neck's base
  for (const sx of [-1, 1]) {
    const x = top.cx + sx * top.rx * 0.55;
    const arc: THREE.Vector3[] = [];
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI * (k / 6); // front (0) → over the top → back (π)
      const z = top.cz - Math.cos(a) * (top.rz + foam);
      const y = top.y + Math.sin(a) * (sh - top.y);
      arc.push(toFrame(x, y, z));
    }
    const half = 0.035;
    for (let k = 0; k < arc.length - 1; k++) {
      const a = arc[k];
      const b = arc[k + 1];
      const l0 = a.clone().addScaledVector(X, -half);
      const r0 = a.clone().addScaledVector(X, half);
      const l1 = b.clone().addScaledVector(X, -half);
      const r1 = b.clone().addScaledVector(X, half);
      push(l0, l1, r0, colour, 1);
      push(r0, l1, r1, colour, 1);
      push(l0, r0, l1, colour, 2);
      push(r0, r1, l1, colour, 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(smoothNormals(positions, sides), 3));
  // the collar pad behind the neck
  const collar = new THREE.CapsuleGeometry(0.045, top.rx * 0.9, 3, 8).rotateZ(Math.PI / 2).toNonIndexed();
  collar.deleteAttribute('uv');
  const cp = toFrame(top.cx, top.y + 0.035, top.cz + top.rz * 0.8 + foam);
  M.makeBasis(X, Y, Z).setPosition(cp);
  collar.applyMatrix4(M);
  C.set(colour);
  const cc = new Float32Array(collar.attributes.position.count * 3);
  for (let i = 0; i < cc.length; i += 3) cc.set([C.r, C.g, C.b], i);
  collar.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  const merged = new THREE.BufferGeometry();
  const all = [g, collar];
  const n = all.reduce((s, x) => s + x.attributes.position.count, 0);
  const mp = new Float32Array(n * 3);
  const mn = new Float32Array(n * 3);
  const mc = new Float32Array(n * 3);
  let off = 0;
  for (const x of all) {
    mp.set(x.attributes.position.array as Float32Array, off * 3);
    mn.set(x.attributes.normal.array as Float32Array, off * 3);
    mc.set(x.attributes.color.array as Float32Array, off * 3);
    off += x.attributes.position.count;
    x.dispose();
  }
  merged.setAttribute('position', new THREE.BufferAttribute(mp, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(mn, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(mc, 3));
  merged.computeBoundingSphere();
  return merged;
}

// ------------------------------------------------------------------------------------ the rider

/** What the race tells a rider each frame. */
export interface RiderState {
  /** The bars, −1..1 (left +). */
  steer: number;
  /** 0..1: how hard on the gas (leans further over the bars). */
  throttle: number;
  air: boolean;
  /** The camera's distance (m), for the detail and the far figure. */
  dist: number;
}

const FAR = 75;
/** How far the hips sink into the saddle's foam. */
const SINK = 0.02;

/** The bones the riding pose turns (put back to the clip's before each update: see Rider.update). */
const BENT: readonly CanonicalBone[] = [
  'spine_01', 'neck_01', 'Head',
  'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r',
];
/** …and the ones it only reads. */
const READ: readonly CanonicalBone[] = ['pelvis', 'spine_03', 'middle_01_l', 'middle_01_r', 'ball_l', 'ball_r'];

export class Rider {
  readonly rig: PersonRig;
  private vest: THREE.Mesh;
  private b = {} as Record<CanonicalBone, THREE.Object3D>;
  private bent: THREE.Object3D[];
  /** The bent bones' rotations as the clip left them this frame. */
  private clipRot: THREE.Quaternion[];
  private posed = false;
  private shadowsOk: boolean;
  private shadowsOn: boolean | null = null;
  private bend = 0.55;
  private look = 0;
  private skip = 0;

  /**
   * @param seat the ski's seat frame (the saddle's top, leaned by the race); the rider sits in it
   * @param far  the merged stand-in figure, shown instead of the rig far away
   */
  constructor(
    rig: PersonRig,
    private seat: THREE.Object3D,
    private far: THREE.Object3D,
    vestColour: string,
    vestMat: THREE.Material,
    shadows: boolean,
  ) {
    this.rig = rig;
    this.shadowsOk = shadows;
    for (const n of BENT) this.b[n] = rig.bone(n);
    for (const n of READ) this.b[n] = rig.bone(n);
    this.bent = BENT.map((n) => this.b[n]);
    this.clipRot = BENT.map(() => new THREE.Quaternion());
    seat.add(rig.root);
    const pelvis = new THREE.Vector3();
    const hips = () => {
      for (let k = 0; k < 4; k++) rig.update(1, 0);
      rig.root.updateMatrixWorld(true);
      return rig.root.worldToLocal(this.b.pelvis.getWorldPosition(pelvis));
    };
    // How high the hips ride over a seat: the seated pose's, which the avatar's seatDrop is measured
    // for. The riding clip (Driving_Loop: in a car seat, fists closed on the wheel) then sits them at
    // that height on the saddle, sunk a couple of centimetres into the foam and a little forward.
    rig.setBase('sit');
    const lift = hips().y - rig.seatDrop;
    if (rig.has('Driving_Loop')) rig.setBase('drive');
    hips();
    rig.root.position.set(-pelvis.x, lift - SINK - pelvis.y, 0.04 - pelvis.z);
    this.keepClip();
    this.pose({ steer: 0, throttle: 0.5, air: false, dist: 0 }, 0);
    // the vest, fitted to this body as it sits, carried by the upper back
    this.vest = new THREE.Mesh(fitVest(rig, seat, vestColour), vestMat);
    this.vest.matrixAutoUpdate = false;
    const spine = this.b.spine_03;
    spine.updateWorldMatrix(true, false);
    seat.updateWorldMatrix(true, false);
    this.vest.matrix.copy(spine.matrixWorld).invert().multiply(seat.matrixWorld);
    spine.add(this.vest);
    this.setShadows(shadows);
  }

  private setShadows(on: boolean) {
    if (on === this.shadowsOn) return;
    this.shadowsOn = on;
    this.rig.setShadows(on);
    this.vest.castShadow = on;
  }

  /** After dark: the crowd's glow, but only a third of it (out on the water there's no park light to explain more). */
  setGlow(k: number) {
    this.rig.setGlow(k * 0.35);
  }

  dispose() {
    this.vest.geometry.dispose();
    this.rig.dispose();
  }

  /** Animate and pose for this frame (after the race has placed the ski and the seat). */
  update(dt: number, st: RiderState, visible: boolean) {
    const far = st.dist > FAR;
    this.rig.root.visible = visible && !far;
    this.far.visible = visible && far;
    if (!visible || far) return;
    this.rig.setDistance(st.dist);
    this.setShadows(this.shadowsOk && st.dist < 22);
    // middle distance: the pose every other frame is plenty
    if (st.dist > 60 && (this.skip = (this.skip + 1) % 2)) return;
    // the clip only writes a bone whose value it changes: the pose's turns would pile up on the
    // bones it holds still, so they go back to the clip's first
    if (this.posed) for (let i = 0; i < this.bent.length; i++) this.bent[i].quaternion.copy(this.clipRot[i]);
    this.rig.update(st.dist > 60 ? dt * 2 : dt, 0);
    this.keepClip();
    this.pose(st, dt);
  }

  private keepClip() {
    for (let i = 0; i < this.bent.length; i++) this.clipRot[i].copy(this.bent[i].quaternion);
    this.posed = true;
  }

  private dir(x: number, y: number, z: number, frame: THREE.Object3D) {
    return DIR.set(x, y, z).transformDirection(frame.matrixWorld);
  }

  /** The riding pose over the clip: back bent over the bars, hands on the grips, feet in the wells. */
  private pose(st: RiderState, dt: number) {
    const b = this.b;
    const ski = this.seat.parent ?? this.seat;
    ski.updateWorldMatrix(true, false);
    this.seat.updateWorldMatrix(false, false);
    // the whole skeleton where the clip and this frame's ski put it (the aims read world positions
    // of bones further down the chain; stale ones would be a frame's travel behind at speed)
    this.rig.root.updateMatrixWorld(true);
    const k = Math.min(1, dt * 5);
    // tucked down on the gas, sat up in the air and when cruising
    const bendGoal = st.air ? 0.15 : 0.22 + 0.22 * st.throttle;
    this.bend += (bendGoal - this.bend) * (dt > 0 ? k : 1);
    this.look += (st.steer - this.look) * (dt > 0 ? k : 1);
    const seat = this.seat;
    // the back, then the neck holding the head up to look ahead
    aim(b.spine_01, b.neck_01, this.dir(-this.look * 0.12, 1, -Math.tan(this.bend), seat));
    aim(b.neck_01, b.Head, this.dir(0, 1, -0.05, seat), 0.8);
    turn(b.Head, this.dir(0, 1, 0, seat), this.look * 0.45);
    // arms to the grips (elbows out and a little down), legs along the hull to the footwells
    this.arm(b.upperarm_l, b.lowerarm_l, b.hand_l, b.middle_01_l, -1, ski);
    this.arm(b.upperarm_r, b.lowerarm_r, b.hand_r, b.middle_01_r, 1, ski);
    this.leg(b.thigh_l, b.calf_l, b.foot_l, b.ball_l, -1, ski);
    this.leg(b.thigh_r, b.calf_r, b.foot_r, b.ball_r, 1, ski);
  }

  private arm(upper: THREE.Object3D, lower: THREE.Object3D, hand: THREE.Object3D, finger: THREE.Object3D, sx: number, ski: THREE.Object3D) {
    TGT.set(sx * GRIP.x, GRIP.y, GRIP.z).applyMatrix4(ski.matrixWorld);
    POLE.set(sx, -0.7, 0.4).transformDirection(ski.matrixWorld);
    twoBone(upper, lower, hand, TGT, POLE);
    aim(hand, finger, this.dir(sx * 0.2, -0.45, -0.85, ski), 0.9);
  }

  /** Knees up and forward along the hull, feet flat in the footwells. */
  private leg(thigh: THREE.Object3D, calf: THREE.Object3D, foot: THREE.Object3D, ball: THREE.Object3D, sx: number, ski: THREE.Object3D) {
    const s = this.rig.height / 1.8;
    TGT.set(sx * (FOOTWELL.x - 0.02), FOOTWELL.y + 0.075 * s, SADDLE.z - 0.5).applyMatrix4(ski.matrixWorld);
    POLE.set(sx * 0.7, 0.3, -1).transformDirection(ski.matrixWorld);
    twoBone(thigh, calf, foot, TGT, POLE);
    aim(foot, ball, this.dir(sx * 0.08, -0.3, -1, ski));
  }
}
