import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PersonRig } from './people';

// What travellers and beachgoers carry: rolling suitcases (and the crew's smaller roll-aboards,
// the same mesh scaled), backpacks, beach totes, straw sun hats and pilots' caps. Each kind is one
// instanced draw for everyone in both places; every frame the owners' poses write the matrices.
// Hats and backpacks follow the head and spine bones; a pulled case hangs off the hand, which
// is posed on top of the walk so the arm really reaches back for the handle.

export type PropKind = 'suitcase' | 'backpack' | 'tote' | 'strawHat' | 'pilotCap';
export const PROP_KINDS: PropKind[] = ['suitcase', 'backpack', 'tote', 'strawHat', 'pilotCap'];

export interface PropItem {
  readonly kind: PropKind;
  readonly index: number;
  /** Size multiplier (a cabin roll-aboard is a smaller suitcase). */
  scale: number;
}

/** The suitcase's frame: wheels on the ground at its rear-bottom edge, body above, the handle's grip this high fully out. */
export const CASE = { w: 0.42, h: 0.64, d: 0.26, grip: 1.02 };

/** Vertex colours: 1 is tinted by the instance's colour; the dark parts stay dark whatever it is. */
function painted(g: THREE.BufferGeometry, c: THREE.ColorRepresentation) {
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g.index ? g.toNonIndexed() : g;
}

const DARK = '#1c1d20';
const WHITE = '#ffffff';

function caseGeometry() {
  const { w, h, d } = CASE;
  const parts = [
    // the shell, with two raised ribs down its face and a rim round its middle
    painted(new THREE.BoxGeometry(w, h, d).translate(0, 0.035 + h / 2, -d / 2), WHITE),
    painted(new THREE.BoxGeometry(0.035, h - 0.06, 0.012).translate(-w / 4, 0.035 + h / 2, -d - 0.006), WHITE),
    painted(new THREE.BoxGeometry(0.035, h - 0.06, 0.012).translate(w / 4, 0.035 + h / 2, -d - 0.006), WHITE),
    painted(new THREE.BoxGeometry(w + 0.01, h + 0.01, 0.02).translate(0, 0.035 + h / 2, -d / 2), DARK),
    // the wheels at the back corners, the feet at the front
    painted(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10).rotateZ(Math.PI / 2).translate(-w / 2 + 0.04, 0.035, -0.035), DARK),
    painted(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10).rotateZ(Math.PI / 2).translate(w / 2 - 0.04, 0.035, -0.035), DARK),
    painted(new THREE.BoxGeometry(0.05, 0.03, 0.04).translate(-w / 2 + 0.05, 0.02, -d + 0.03), DARK),
    painted(new THREE.BoxGeometry(0.05, 0.03, 0.04).translate(w / 2 - 0.05, 0.02, -d + 0.03), DARK),
    // the telescopic handle: two rods out of the top at the back, and the grip
    painted(new THREE.BoxGeometry(0.018, CASE.grip - h - 0.035, 0.018).translate(-0.11, h + 0.035 + (CASE.grip - h - 0.035) / 2, -0.03), '#8d949b'),
    painted(new THREE.BoxGeometry(0.018, CASE.grip - h - 0.035, 0.018).translate(0.11, h + 0.035 + (CASE.grip - h - 0.035) / 2, -0.03), '#8d949b'),
    painted(new THREE.BoxGeometry(0.26, 0.035, 0.035).translate(0, CASE.grip, -0.03), DARK),
    // the carry handle on top
    painted(new THREE.BoxGeometry(0.14, 0.02, 0.03).translate(0, h + 0.045, -d / 2 - 0.03), DARK),
  ];
  return mergeGeometries(parts)!;
}

function backpackGeometry() {
  // origin at the wearer's back between the shoulder blades; the pack hangs behind (+z)
  return mergeGeometries([
    painted(new THREE.BoxGeometry(0.3, 0.42, 0.15).translate(0, -0.12, 0.09), WHITE),
    painted(new THREE.BoxGeometry(0.26, 0.07, 0.13).translate(0, 0.12, 0.09), WHITE),
    painted(new THREE.BoxGeometry(0.22, 0.17, 0.06).translate(0, -0.22, 0.19), WHITE),
    painted(new THREE.BoxGeometry(0.31, 0.03, 0.16).translate(0, -0.09, 0.09), DARK),
    // the shoulder straps over the front of the shoulders
    painted(new THREE.BoxGeometry(0.045, 0.06, 0.2).translate(-0.09, 0.15, -0.02), DARK),
    painted(new THREE.BoxGeometry(0.045, 0.06, 0.2).translate(0.09, 0.15, -0.02), DARK),
  ])!;
}

function toteGeometry() {
  // origin at the top of the strap on the shoulder; the bag rides at the hip below it
  const strap = 0.48;
  return mergeGeometries([
    painted(new THREE.BoxGeometry(0.36, 0.3, 0.12).translate(0, -strap - 0.15, 0), WHITE),
    painted(new THREE.BoxGeometry(0.37, 0.05, 0.125).translate(0, -strap - 0.02, 0), '#f4ead2'),
    painted(new THREE.BoxGeometry(0.03, strap, 0.012).translate(-0.12, -strap / 2, 0.055), '#f4ead2'),
    painted(new THREE.BoxGeometry(0.03, strap, 0.012).translate(0.12, -strap / 2, -0.055), '#f4ead2'),
  ])!;
}

function strawHatGeometry() {
  // origin on the crown of the head
  return mergeGeometries([
    painted(new THREE.CylinderGeometry(0.25, 0.26, 0.012, 24).translate(0, -0.035, 0), WHITE),
    painted(new THREE.CylinderGeometry(0.105, 0.12, 0.11, 18).translate(0, 0.015, 0), WHITE),
    painted(new THREE.CylinderGeometry(0.121, 0.122, 0.03, 18).translate(0, -0.022, 0), '#7a3a2a'),
  ])!;
}

function pilotCapGeometry() {
  // origin on the crown: a flat top over a black band, the peak, the gold badge
  const peak = new THREE.CylinderGeometry(0.11, 0.115, 0.012, 16, 1, false, -Math.PI / 2, Math.PI).rotateX(-0.25).translate(0, -0.045, -0.06);
  return mergeGeometries([
    painted(new THREE.CylinderGeometry(0.135, 0.105, 0.045, 18).translate(0, 0.03, 0), WHITE),
    painted(new THREE.CylinderGeometry(0.105, 0.105, 0.055, 18).translate(0, -0.015, 0), DARK),
    painted(peak, DARK),
    painted(new THREE.BoxGeometry(0.05, 0.035, 0.01).translate(0, 0.0, -0.108), '#d9a62e'),
  ])!;
}

const GEOMETRY: Record<PropKind, () => THREE.BufferGeometry> = {
  suitcase: caseGeometry,
  backpack: backpackGeometry,
  tote: toteGeometry,
  strawHat: strawHatGeometry,
  pilotCap: pilotCapGeometry,
};

const ROUGH: Record<PropKind, number> = { suitcase: 0.45, backpack: 0.85, tote: 0.9, strawHat: 0.95, pilotCap: 0.6 };

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class Luggage {
  readonly group = new THREE.Group();
  private meshes = {} as Record<PropKind, THREE.InstancedMesh>;
  private used = {} as Record<PropKind, number>;
  private dirty = new Set<PropKind>();

  constructor(counts: Record<PropKind, number>, shadows: boolean) {
    this.group.name = 'luggage';
    for (const kind of PROP_KINDS) {
      const n = Math.max(1, counts[kind]);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: ROUGH[kind], metalness: kind === 'suitcase' ? 0.15 : 0 });
      const mesh = new THREE.InstancedMesh(GEOMETRY[kind](), mat, n);
      mesh.name = `luggage-${kind}`;
      mesh.castShadow = shadows;
      // the owners are spread over two places 40 km apart: no useful bounds
      mesh.frustumCulled = false;
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, HIDDEN);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes[kind] = mesh;
      this.used[kind] = 0;
      this.group.add(mesh);
    }
  }

  /** Reserve one instance of a kind, in a colour. */
  add(kind: PropKind, colour: THREE.ColorRepresentation, scale = 1): PropItem {
    const mesh = this.meshes[kind];
    const index = this.used[kind]++;
    if (index >= mesh.count) throw new Error(`luggage: no room for another ${kind}`);
    mesh.setColorAt(index, new THREE.Color(colour));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return { kind, index, scale };
  }

  set(item: PropItem, m: THREE.Matrix4) {
    this.meshes[item.kind].setMatrixAt(item.index, m);
    this.dirty.add(item.kind);
  }

  hide(item: PropItem) {
    this.set(item, HIDDEN);
  }

  /** Upload what changed this frame. */
  flush() {
    for (const k of this.dirty) this.meshes[k].instanceMatrix.needsUpdate = true;
    this.dirty.clear();
  }

  /** Hide or show the lot (the region the visitor isn't in). */
  setVisible(on: boolean) {
    this.group.visible = on;
  }
}

// ------------------------------------------------------------------------------------ poses

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const s1 = new THREE.Vector3();

/** Turn a bone (in world space) so the direction to its child bone becomes `dir`, by amount k. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3, k: number) {
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(false, false);
  const from = v1.setFromMatrixPosition(child.matrixWorld).sub(v2.setFromMatrixPosition(bone.matrixWorld)).normalize();
  q1.setFromUnitVectors(from, dir);
  if (k < 1) q1.slerp(q2.identity(), 1 - k);
  bone.getWorldQuaternion(q2);
  q2.premultiply(q1);
  bone.parent!.getWorldQuaternion(q1).invert();
  bone.quaternion.copy(q1.multiply(q2));
}

/** A rig's right arm (cached bones and its length, shoulder to the middle of the grip). */
interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  length: number;
}
const arms = new WeakMap<PersonRig, Arm>();

function rightArm(rig: PersonRig): Arm {
  let a = arms.get(rig);
  if (!a) {
    const upper = rig.root.getObjectByName('upperarm_r')!;
    const lower = rig.root.getObjectByName('lowerarm_r')!;
    const hand = rig.root.getObjectByName('hand_r')!;
    rig.root.updateMatrixWorld(true);
    const p = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    // bone to bone, plus the palm to the grip
    const length = p(upper).distanceTo(p(lower)) + p(lower).distanceTo(p(hand)) + 0.07 * (rig.height / 1.8);
    a = { upper, lower, hand, length };
    arms.set(rig, a);
  }
  return a;
}

/** How a pulled case hangs: 0 standing beside its owner, 1 trailing behind at full tilt. */
export interface CaseState {
  pull: number;
}

/**
 * The matrix for a suitcase pulled by `rig` (whose root is already placed and facing `heading`),
 * and, while it's pulled, the right arm posed reaching back for its handle. `floorY` is the
 * ground under the owner; `posed` says whether the rig's animation just ran this frame (the
 * arm is only re-posed then, as the clip overwrote it).
 */
export function pulledCase(rig: PersonRig, heading: number, floorY: number, st: CaseState, scale: number, posed: boolean, out: THREE.Matrix4) {
  const root = rig.root.position;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // the person's forward (−z turned by heading) and right
  const fx = -s;
  const fz = -c;
  const rx = c;
  const rz = -s;
  const arm = rightArm(rig);
  const grip = CASE.grip * scale;
  if (st.pull > 0.02) {
    arm.upper.updateWorldMatrix(true, false);
    const sh = v3.setFromMatrixPosition(arm.upper.matrixWorld);
    // the arm hangs down and back, a little out from the side
    const dir = v1.set(rx * 0.14 - fx * 0.34, -0.93, rz * 0.14 - fz * 0.34).normalize();
    const hx = sh.x + dir.x * arm.length;
    const hy = sh.y + dir.y * arm.length;
    const hz = sh.z + dir.z * arm.length;
    if (posed) {
      const d = v2.copy(dir);
      aim(arm.upper, arm.lower, d, st.pull);
      aim(arm.lower, arm.hand, d, st.pull);
    }
    // the case tilts until its grip meets the hand, its wheels trailing on the floor
    const k = THREE.MathUtils.clamp((hy - floorY) / grip, 0.3, 1);
    const tilt = Math.acos(k) * st.pull;
    const back = Math.sin(tilt) * grip;
    // (the grip is 3 cm in front of the wheels' line, along the case)
    const wx = hx - fx * back;
    const wz = hz - fz * back;
    // standing beside its owner when not being pulled
    const bx = root.x + rx * 0.34 - fx * 0.05;
    const bz = root.z + rz * 0.34 - fz * 0.05;
    const p = v2.set(THREE.MathUtils.lerp(bx, wx, st.pull), floorY, THREE.MathUtils.lerp(bz, wz, st.pull));
    e1.set(-tilt, heading, 0);
    q1.setFromEuler(e1);
    return out.compose(p, q1, s1.setScalar(scale));
  }
  e1.set(0, heading, 0);
  q1.setFromEuler(e1);
  return out.compose(v2.set(root.x + rx * 0.34 - fx * 0.05, floorY, root.z + rz * 0.34 - fz * 0.05), q1, s1.setScalar(scale));
}

/** A case (or bag) standing on its own: at (x, y, z), turned to `yaw`, optionally laid on its back. */
export function standingCase(x: number, y: number, z: number, yaw: number, flat: boolean, scale: number, out: THREE.Matrix4) {
  e1.set(flat ? -Math.PI / 2 : 0, yaw, 0);
  q1.setFromEuler(e1);
  return out.compose(v1.set(x, y, z), q1, s1.setScalar(scale));
}

/** Where the top of the head is, from the head bone (it sits at the skull's base): world space. */
export function headTop(rig: PersonRig, heading: number, out: THREE.Vector3) {
  const head = rig.bone('Head');
  head.updateWorldMatrix(true, false);
  out.setFromMatrixPosition(head.matrixWorld);
  const k = rig.height / 1.8;
  // up the skull, and a touch forward (the face side) to sit over the brow
  out.y += 0.165 * k;
  out.x += -Math.sin(heading) * 0.012 * k;
  out.z += -Math.cos(heading) * 0.012 * k;
  return out;
}

/** A hat on the head (turning with the body; heads barely tilt in the clips). */
export function hatOnHead(rig: PersonRig, heading: number, scale: number, out: THREE.Matrix4) {
  headTop(rig, heading, v3);
  e1.set(-0.06, heading, 0);
  q1.setFromEuler(e1);
  return out.compose(v3, q1, s1.setScalar(scale * (rig.height / 1.8) * (rig.look.child ? 1.08 : 1)));
}

/** A backpack between the shoulder blades, following the upper spine. */
export function backpackOn(rig: PersonRig, heading: number, out: THREE.Matrix4) {
  const spine = rig.bone('spine_03');
  spine.updateWorldMatrix(true, false);
  v3.setFromMatrixPosition(spine.matrixWorld);
  const k = rig.height / 1.8;
  // from the spine bone out to the back's surface (the back is +z in the wearer's frame)
  v3.x += Math.sin(heading) * 0.11 * k;
  v3.z += Math.cos(heading) * 0.11 * k;
  v3.y += 0.02 * k;
  e1.set(0.08, heading, 0);
  q1.setFromEuler(e1);
  return out.compose(v3, q1, s1.set(k * rig.look.build, k, k));
}

/** A tote's strap over the left shoulder, the bag at the hip. */
export function toteOn(rig: PersonRig, heading: number, out: THREE.Matrix4) {
  const spine = rig.bone('spine_03');
  spine.updateWorldMatrix(true, false);
  v3.setFromMatrixPosition(spine.matrixWorld);
  const k = rig.height / 1.8;
  // the left shoulder: the wearer's left is −x in their own frame
  const lx = -Math.cos(heading);
  const lz = Math.sin(heading);
  v3.x += lx * 0.2 * k * rig.look.build;
  v3.z += lz * 0.2 * k * rig.look.build;
  v3.y += 0.1 * k;
  e1.set(0, heading + Math.PI / 2, -0.06);
  q1.setFromEuler(e1);
  return out.compose(v3, q1, s1.setScalar(k));
}

/** Something put down: a bag or hat on the ground (or a seat) beside its owner. */
export function putDown(x: number, y: number, z: number, yaw: number, scale: number, out: THREE.Matrix4) {
  e1.set(0, yaw, 0);
  q1.setFromEuler(e1);
  return out.compose(v1.set(x, y, z), q1, s1.setScalar(scale));
}
