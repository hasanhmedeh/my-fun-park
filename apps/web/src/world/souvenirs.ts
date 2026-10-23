// Souvenirs from the booth's shop, worn in the fair: a cap or a top hat, star shades, a balloon on a
// string, a foam finger. Head pieces ride on the head bone, so they nod and turn with the head and
// grow with the wearer's height and build just as the head does; the balloon and the foam finger
// are placed each frame from the hands' bones.
//
// Head pieces are fitted to the wearer's own head: once per avatar, its head and hair meshes are
// measured in the bind pose in the head bone's frame (the top of the skull and of the hair, the
// head's width and its front and back at the brow), and the eyes are read from the eye bones. Each
// piece is sized and placed from that, in a frame on the head: x to the wearer's right, y up
// through the crown, -z forward.
import * as THREE from 'three';
import { std } from './context';
import type { HatClip, PersonRig } from './crowd/person-rig';
import { PALETTE } from './textures';

type Holder = 'head' | 'leftHand' | 'rightHand';

/** The wearer's head, in the head frame (x right, y up through the crown, -z forward; origin at the head bone). */
interface Head {
  /** Top of the skull (under the hair) and of the hair. */
  skull: number;
  hair: number;
  /** Half the head's width above the eyes, and where its front and back are at the forehead. */
  half: number;
  front: number;
  back: number;
  /** The same, taking the hair cards in. */
  hairHalf: number;
  hairFront: number;
  hairBack: number;
  /** The eyes: their height, the front of the eyeballs, and the distance between them. */
  eyeY: number;
  eyeFront: number;
  eyeGap: number;
  /** Half the head's width at the temples, just behind the eyes (where the shades' arms go). */
  temple: number;
  /**
   * The head mesh above the brow (x, y, z in turn): where a few avatars' hair is modelled into it,
   * it bulges out above the brow, and a cap's crown has to go round that too (crownFit).
   */
  dome: Float32Array;
}

/** A head measured for one avatar, and the head frame's turn within its head bone. */
interface Fit {
  head: Head;
  frame: THREE.Matrix4;
}

/** A hat's opening, where it meets the head (head frame): its height, half its width, its front and back. */
interface Brim {
  y: number;
  half: number;
  front: number;
  back: number;
}

interface Piece {
  id: string;
  holder: Holder;
  object: THREE.Object3D;
  /**
   * Head pieces: sizes the piece to the head and says where it goes (in the head frame), and for a
   * hat where its opening is (the hair above that is tucked away under it).
   */
  fit?: (head: Head) => { at: THREE.Vector3; brim?: Brim };
  /** A hat as worn now: the hair it tucks away (PersonRig.setHatClip). */
  clip?: HatClip;
  dispose: () => void;
}
/** An eyeball's radius: the shades sit in front of the eyeballs, whose bones are at their centres. */
const EYEBALL = 0.012;
/**
 * How far past the head a cap reaches for the hair cards. Cards beyond that are tucked away by the
 * hat clip, so a cap fits the head as a real one does rather than ballooning round loose hair; hair
 * modelled into the head mesh itself (a few avatars' curls) can't be clipped, so the cap goes round it.
 */
const HAIR_ROOM = 0.008;
/** How far a hat's hair clip reaches past the hair (and the hat) at its widest. */
const CLIP_ROOM = 0.02;

/** Every avatar's head, measured once (the hero file and the crowd file share their proportions). */
const fits = new Map<string, Fit | null>();

const UP = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3();
const hand = new THREE.Vector3();
const elbow = new THREE.Vector3();
const along = new THREE.Vector3();
const face = new THREE.Vector3();
const across = new THREE.Vector3();
const rest = new THREE.Vector3();
const pull = new THREE.Vector3();
const knot = new THREE.Vector3();
const yaw = new THREE.Quaternion();
const basis = new THREE.Matrix4();

/** Everything one person wears from the shop. */
export class Wardrobe {
  private pieces = new Map<string, Piece>();
  private shown = true;
  private balloon: { pos: THREE.Vector3; vel: THREE.Vector3 } | null = null;

  constructor(
    private rig: PersonRig,
    private scene: THREE.Scene,
  ) {}

  /** Wear exactly these (catalog ids); anything else comes off. */
  set(items: readonly string[]) {
    for (const [id, p] of this.pieces)
      if (!items.includes(id)) {
        p.object.removeFromParent();
        p.dispose();
        this.pieces.delete(id);
      }
    for (const id of items) {
      if (this.pieces.has(id)) continue;
      const piece = build(id);
      if (!piece) continue;
      this.pieces.set(id, piece);
      this.put(piece);
      if (id === 'balloon') this.balloon = null;
    }
    this.clipHair();
  }

  /**
   * The wearer became someone else (Player.setRig): everything worn moves over to the new person,
   * refitted to their head. The old rig is left as it is (it's about to be disposed of).
   */
  setRig(rig: PersonRig) {
    if (rig === this.rig) return;
    for (const p of this.pieces.values()) p.object.removeFromParent();
    this.rig = rig;
    for (const p of this.pieces.values()) this.put(p);
    this.balloon = null;
    this.clipHair();
  }

  /** Show or hide everything (e.g. while the wearer is out of sight on a ride). */
  setVisible(on: boolean) {
    this.shown = on;
    for (const p of this.pieces.values()) p.object.visible = on && (p.holder !== 'head' || !!p.object.parent);
  }

  update(dt: number) {
    if (!this.pieces.size) return;
    // the hand pieces live in the scene: they go when the wearer does (on a ride, say)
    const seen = this.shown && visibleInWorld(this.rig.root);
    let measured = false;
    for (const p of this.pieces.values()) {
      if (p.holder === 'head') continue;
      p.object.visible = seen;
      if (!seen) continue;
      if (!measured) {
        this.rig.root.updateWorldMatrix(true, false);
        this.rig.root.getWorldQuaternion(yaw);
        measured = true;
      }
      if (p.id === 'balloon') this.updateBalloon(p, dt);
      else this.wearOnHand(p);
    }
    if (!seen) this.balloon = null;
  }

  /** Puts a piece on the wearer: a head piece on the head bone (fitted), the others in the scene. */
  private put(p: Piece) {
    if (p.holder !== 'head') {
      this.scene.add(p.object);
      p.object.visible = this.shown;
      return;
    }
    p.clip = undefined;
    const fit = fitFor(this.rig);
    if (!fit || !p.fit) return;
    const { at, brim } = p.fit(fit.head);
    if (brim) p.clip = hatClip(fit, brim);
    p.object.position.copy(at.applyMatrix4(fit.frame));
    p.object.quaternion.setFromRotationMatrix(fit.frame);
    p.object.visible = this.shown;
    this.rig.bone('Head').add(p.object);
  }

  /** A hat tucks the hair under it (and hides the avatar's own hat); without one it's all back. */
  private clipHair() {
    let clip: HatClip | null = null;
    for (const p of this.pieces.values()) clip ??= p.clip ?? null;
    this.rig.setHatClip(clip);
  }

  /** Worn on the right hand like a glove: along the forearm, palm out of the fist. */
  private wearOnHand(p: Piece) {
    this.rig.bone('hand_r').getWorldPosition(hand);
    this.rig.bone('lowerarm_r').getWorldPosition(elbow);
    along.subVectors(hand, elbow).normalize();
    // the wearer's forward, square to the forearm
    face.set(0, 0, -1).applyQuaternion(yaw);
    face.addScaledVector(along, -face.dot(along));
    if (face.lengthSq() < 1e-4) face.set(1, 0, 0).applyQuaternion(yaw);
    face.normalize();
    across.crossVectors(along, face).normalize();
    basis.makeBasis(across, along, face);
    p.object.quaternion.setFromRotationMatrix(basis);
    p.object.position.copy(hand).addScaledVector(along, 0.02);
  }

  /** The balloon floats a string's length above the left hand, lagging behind and bobbing. */
  private updateBalloon(p: Piece, dt: number) {
    this.rig.bone('hand_l').getWorldPosition(hand);
    this.rig.bone('lowerarm_l').getWorldPosition(elbow);
    // the string comes out of the fist
    along.subVectors(hand, elbow).normalize();
    hand.addScaledVector(along, 0.07);
    face.set(0, 0, 1).applyQuaternion(yaw);
    rest.copy(hand).addScaledVector(UP, 1.05).addScaledVector(face, 0.18);
    if (!this.balloon) this.balloon = { pos: rest.clone(), vel: new THREE.Vector3() };
    const b = this.balloon;
    const k = Math.min(dt, 1 / 20);
    // a soft spring towards its spot, with drag: it trails when you run
    pull.subVectors(rest, b.pos).multiplyScalar(12);
    b.vel.addScaledVector(pull, k).multiplyScalar(Math.exp(-k * 3.2));
    b.pos.addScaledVector(b.vel, k);
    // never further than the string allows
    const d = b.pos.distanceTo(hand);
    if (d > 1.12) b.pos.sub(hand).multiplyScalar(1.12 / d).add(hand);
    const group = p.object as THREE.Group;
    const ball = group.children[0];
    const line = group.children[1] as THREE.Line;
    ball.position.copy(b.pos);
    // it leans the way it's pulled
    pull.subVectors(b.pos, hand).normalize();
    ball.quaternion.setFromUnitVectors(UP, pull);
    const pts = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    knot.copy(b.pos).addScaledVector(pull, -0.2);
    pts.setXYZ(0, hand.x, hand.y, hand.z);
    pts.setXYZ(1, knot.x, knot.y, knot.z);
    pts.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  dispose() {
    this.set([]);
  }
}

/** Whether `o` is drawn: it and everything above it visible, all the way up to the scene. */
function visibleInWorld(o: THREE.Object3D) {
  let n: THREE.Object3D | null = o;
  for (; n; n = n.parent) {
    if (!n.visible) return false;
    if ((n as THREE.Scene).isScene) return true;
  }
  return false;
}

// ---------- Measuring the head ----------

/** The rig's avatar's head (measured the first time it's asked for), or null if it can't be. */
function fitFor(rig: PersonRig): Fit | null {
  const id = rig.spec.id;
  if (!fits.has(id)) fits.set(id, measure(rig));
  return fits.get(id)!;
}

/**
 * The head frame within the head bone, and the head measured in it. The head bone's own axes
 * (Rocketbox's Bip01 Head) run x up the neck to the crown, y forward and z to the left; the head
 * frame is turned to stand along the avatar's headTop anchor, so a piece stands straight up from
 * the crown however the bone leans. Vertices are taken in the bind pose (each skinned vertex's place
 * in the bone's frame is boneInverse × bindMatrix × position), so the measure doesn't depend on the
 * pose the wearer is in when it's taken.
 */
function measure(rig: PersonRig): Fit | null {
  const headBone = rig.bone('Head');
  const skeleton = rig.parts.head.skeleton;
  const hi = skeleton.bones.indexOf(headBone as THREE.Bone);
  if (hi < 0) return null;
  const top = rig.spec.anchors.headTop.at;
  const up = new THREE.Vector3(top[0], top[1], top[2]).normalize();
  const fwd = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up);
  const rear = fwd.clone().negate();
  const frame = new THREE.Matrix4().makeBasis(right, up, rear);
  const toFrame = frame.clone().transpose();

  // the eyes, from their bones (at the eyeballs' centres)
  const eyes: THREE.Vector3[] = [];
  for (const name of ['eye_l', 'eye_r'] as const) {
    let bone: THREE.Object3D;
    try {
      bone = rig.bone(name);
    } catch {
      continue;
    }
    const i = skeleton.bones.indexOf(bone as THREE.Bone);
    if (i < 0) continue;
    const m = new THREE.Matrix4().copy(skeleton.boneInverses[i]).invert().premultiply(skeleton.boneInverses[hi]).premultiply(toFrame);
    eyes.push(new THREE.Vector3().setFromMatrixPosition(m));
  }
  if (eyes.length < 2) return null;
  const eyeY = (eyes[0].y + eyes[1].y) / 2;
  const eyeGap = Math.abs(eyes[0].x - eyes[1].x);
  const eyeFront = Math.min(eyes[0].z, eyes[1].z) - EYEBALL;

  // one pass over a mesh's vertices near the head, in the head frame
  const each = (mesh: THREE.SkinnedMesh | null, fn: (p: THREE.Vector3) => void) => {
    if (!mesh) return;
    const m = new THREE.Matrix4().multiplyMatrices(skeleton.boneInverses[hi], mesh.bindMatrix).premultiply(toFrame);
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.y < -0.12 || v.y > 0.4 || Math.abs(v.x) > 0.2 || Math.abs(v.z) > 0.2) continue;
      fn(v);
    }
  };
  let skull = -Infinity;
  let n = 0;
  // the brow: just above the eyes (or, if nothing's there, the whole head)
  const brow = { front: Infinity, back: -Infinity, half: 0, n: 0 };
  const all = { front: Infinity, back: -Infinity, half: 0 };
  let temple = 0;
  const dome: number[] = [];
  each(rig.parts.head, (p) => {
    if (p.y > eyeY + 0.02) dome.push(p.x, p.y, p.z);
    n++;
    if (Math.abs(p.y - eyeY) < 0.015 && p.z > eyeFront && p.z < eyeFront + 0.035) temple = Math.max(temple, Math.abs(p.x));
    skull = Math.max(skull, p.y);
    all.front = Math.min(all.front, p.z);
    all.back = Math.max(all.back, p.z);
    all.half = Math.max(all.half, Math.abs(p.x));
    if (p.y > eyeY + 0.02 && p.y < eyeY + 0.07) {
      brow.n++;
      brow.front = Math.min(brow.front, p.z);
      brow.back = Math.max(brow.back, p.z);
      brow.half = Math.max(brow.half, Math.abs(p.x));
    }
  });
  if (n < 50) return null;
  const band = brow.n ? brow : all;
  const { front, back, half } = band;
  // the hair cards above the brow: how far they stand out round the head
  let hairTop = skull;
  let hairHalf = half;
  let hairFront = front;
  let hairBack = back;
  const hair = rig.parts.hair;
  if (hair && hair !== rig.parts.head)
    each(hair, (p) => {
      hairTop = Math.max(hairTop, p.y);
      if (p.y <= eyeY + 0.03) return;
      hairHalf = Math.max(hairHalf, Math.abs(p.x));
      hairBack = Math.max(hairBack, p.z);
      if (p.y > eyeY + 0.06) hairFront = Math.min(hairFront, p.z);
    });
  return { head: { skull, hair: Math.max(skull, hairTop), half, front, back, hairHalf, hairFront, hairBack, eyeY, eyeFront, eyeGap, temple, dome: new Float32Array(dome) }, frame };
}

/**
 * What a hat has to go round at the brow, and to clear on top: the head (with any hair modelled into
 * it), and the hair cards only as far as HAIR_ROOM past it.
 */
function covered(h: Head) {
  return {
    half: Math.max(h.half, Math.min(h.hairHalf, h.half + HAIR_ROOM)),
    front: Math.min(h.front, Math.max(h.hairFront, h.front - HAIR_ROOM)),
    back: Math.max(h.back, Math.min(h.hairBack, h.back + HAIR_ROOM)),
    top: Math.max(h.skull, Math.min(h.hair, h.skull + HAIR_ROOM)),
  };
}

/**
 * The hair a hat tucks away: an ellipsoid round everything above the hat's opening, as wide as the
 * hair stands out there (plus CLIP_ROOM, so no curl pokes through the crown), narrowing to the hat's
 * own size at the opening, so the hair hanging below it (a fringe, sideburns, the back of long hair,
 * a bun) still shows. An ellipsoid is widest at its middle: it's centred above the opening, at the
 * height where its cross-section has narrowed to the hat's, and reaches over the top of the hair.
 * Built in the head frame and given in the head bone's (the clip is axis-aligned there): the frame's
 * up, forward and side are the bone's x, y and z, near enough (they're a few degrees apart).
 */
function hatClip({ head: h, frame }: Fit, b: Brim): HatClip {
  const mid = (b.front + b.back) / 2;
  const hatX = b.half;
  const hatZ = (b.back - b.front) / 2;
  const rx = Math.max(hatX, h.hairHalf) + CLIP_ROOM;
  const rz = Math.max(hatZ, mid - h.hairFront, h.hairBack - mid) + CLIP_ROOM;
  // at the opening the cross-section is k of the widest (the smaller of the two, so the clip never
  // reaches past the hat there), which it is t of the vertical radius below the middle
  const k = THREE.MathUtils.clamp(Math.min(hatX / rx, hatZ / rz), 0.3, 0.95);
  const t = Math.sqrt(1 - k * k);
  const ry = Math.max(0.06, (h.hair + CLIP_ROOM - b.y) / (1 + t));
  const c = new THREE.Vector3(0, b.y + t * ry, mid).applyMatrix4(frame);
  return { centre: [c.x, c.y, c.z], radii: [ry, rz, rx] };
}

/**
 * How much a cap's crown (the unit crown scaled to rx, ry, rz, its base at `base` and centred at
 * `mid` front to back) has to grow, in all three directions, to go round the head mesh above
 * `rim`: 1 if it already does. Below the base the band, straight down to the rim, has to.
 */
function crownFit(h: Head, rim: number, base: number, mid: number, rx: number, ry: number, rz: number) {
  let grow = 1;
  const d = h.dome;
  for (let i = 0; i < d.length; i += 3) {
    const y = d[i + 1];
    if (y < rim) continue;
    const q = Math.hypot(d[i] / rx, (d[i + 2] - mid) / rz);
    const u = Math.max(0, y - base) / ry;
    grow = Math.max(grow, (q ** 2.4 + u ** 2.4) ** (1 / 2.4));
  }
  return grow;
}

// ---------- The pieces ----------

function build(id: string): Piece | null {
  const parts: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
    parts.push(g);
    if (!mats.includes(m)) mats.push(m);
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    return x;
  };
  const dispose = () => {
    parts.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  };
  const g = new THREE.Group();

  switch (id) {
    case 'cap': {
      // a baseball cap: six-panel crown, a curved brim out over the face, a button on top
      const red = std('#c8302a', { roughness: 0.82 });
      const cream = std(PALETTE.cream, { roughness: 0.8 });
      const crown = mesh(crownGeometry(), red);
      const band = mesh(new THREE.CylinderGeometry(1, 1, 0.12, 32, 1, true), red);
      band.position.y = -0.06;
      const brim = mesh(brimGeometry(), cream);
      const button = mesh(new THREE.SphereGeometry(0.09, 12, 8), red);
      g.add(crown, band, brim, button);
      return {
        id,
        holder: 'head',
        object: g,
        dispose,
        fit: (h) => {
          // snug round the head at the brow, the band just above the eyebrows, the crown's top
          // just over the head's (the crown starts a tenth of its height above the rim)
          const c = covered(h);
          const rim = h.eyeY + 0.038;
          const mid = (c.front + c.back) / 2;
          let rx = c.half + 0.007;
          let rz = (c.back - c.front) / 2 + 0.007;
          let ry = Math.max(0.07, (c.top + 0.006 - rim) / 1.1);
          // (and round hair modelled into the head that bulges out above the brow, with the same room)
          const grow = crownFit(h, rim, rim + ry * 0.1, mid, rx - 0.003, ry - 0.003, rz - 0.003);
          rx *= grow;
          ry *= grow;
          rz *= grow;
          const front = mid - rz;
          const back = mid + rz;
          crown.scale.set(rx, ry, rz);
          // the sweatband: from the crown's edge down to the brow
          band.scale.set(rx, ry, rz);
          band.position.y = -0.06 * ry;
          // the brim: thin, out over the face, tipped down a touch
          brim.scale.set(rx, rx, rz);
          brim.position.set(0, -ry * 0.06, -rz * 0.55);
          brim.rotation.x = 0.16;
          button.position.set(0, ry, 0);
          button.scale.setScalar(Math.max(rx, rz) * 0.9);
          return { at: new THREE.Vector3(0, rim + ry * 0.1, (front + back) / 2), brim: { y: rim, half: rx, front, back } };
        },
      };
    }
    case 'top-hat': {
      const silk = std('#141018', { roughness: 0.32, metalness: 0.08 });
      const ribbon = std('#b3122a', { roughness: 0.55 });
      const brim = mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.09, 40), silk);
      const crown = mesh(new THREE.CylinderGeometry(0.98, 1, 1.75, 40), silk);
      crown.position.y = 0.9;
      const top = mesh(new THREE.CircleGeometry(0.98, 40).rotateX(-Math.PI / 2), silk);
      top.position.y = 1.775;
      const band = mesh(new THREE.CylinderGeometry(1.01, 1.01, 0.3, 40, 1, true), ribbon);
      band.position.y = 0.2;
      g.add(brim, crown, top, band);
      return {
        id,
        holder: 'head',
        object: g,
        dispose,
        fit: (h) => {
          // the crown's opening fits round the head; it sits down on the hair, level
          const c = covered(h);
          const r = Math.max(c.half, (c.back - c.front) / 2) * 0.97 + 0.004;
          const rz = (c.back - c.front) / 2 + 0.008;
          g.scale.set(r, r * 0.98, rz);
          const y = c.top - 0.045;
          const mid = (c.front + c.back) / 2;
          return { at: new THREE.Vector3(0, y, mid), brim: { y, half: r, front: mid - rz, back: mid + rz } };
        },
      };
    }
    case 'shades': {
      const gold = std(PALETTE.mustard, { roughness: 0.28, metalness: 0.75 });
      const glass = new THREE.MeshPhysicalMaterial({ color: '#2a1a40', roughness: 0.05, metalness: 0.1, clearcoat: 1, transparent: true, opacity: 0.92 });
      const lenses: THREE.Object3D[] = [];
      for (const side of [-1, 1]) {
        const lens = new THREE.Group();
        const frame = mesh(new THREE.ExtrudeGeometry(star(1, 0.48), { depth: 0.12, bevelEnabled: false }), gold);
        frame.position.z = -0.06;
        const pane = mesh(new THREE.ShapeGeometry(star(0.8, 0.38)), glass);
        pane.position.z = 0.07;
        lens.add(frame, pane);
        lens.userData.side = side;
        lenses.push(lens);
        g.add(lens);
      }
      const bridge = mesh(new THREE.BoxGeometry(1, 0.12, 0.12), gold);
      const arms = [-1, 1].map((side) => {
        // (a unit length running back from its hinge, so it can be stretched and swung from there)
        const arm = mesh(new THREE.BoxGeometry(0.1, 0.1, 1).translate(0, 0, 0.5), gold);
        arm.userData.side = side;
        g.add(arm);
        return arm;
      });
      g.add(bridge);
      return {
        id,
        holder: 'head',
        object: g,
        dispose,
        fit: (h) => {
          // one star over each eye, just in front of them, with arms back to the ears
          const r = h.eyeGap * 0.62;
          for (const lens of lenses) {
            lens.scale.setScalar(r);
            lens.position.set((lens.userData.side * h.eyeGap) / 2, 0, 0);
            // the stars face out of the face: the wearer's -z
            lens.rotation.y = Math.PI;
          }
          bridge.scale.set(h.eyeGap * 0.3, r * 0.9, r * 0.9);
          // the arms hinge on the stars' outer points (or the temples, if they're wider) and run
          // back to the ears, splaying a little to clear the side of the head
          const tip = h.eyeGap / 2 + r * 0.9;
          const hinge = THREE.MathUtils.clamp(h.temple + 0.003, tip, tip + 0.015);
          const depth = h.eyeGap * 1.6;
          const splay = Math.max(0, Math.min(h.half, hinge + 0.02) + 0.004 - hinge);
          for (const arm of arms) {
            const side = arm.userData.side;
            arm.scale.set(r * 0.9, r * 0.9, Math.hypot(depth, splay));
            arm.position.set(side * hinge, r * 0.15, 0.004);
            arm.rotation.y = side * Math.atan2(splay, depth);
          }
          return { at: new THREE.Vector3(0, h.eyeY + 0.002, h.eyeFront - 0.016) };
        },
      };
    }
    case 'balloon': {
      const latex = new THREE.MeshPhysicalMaterial({ color: '#d81e34', roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.12, sheen: 0.4, sheenColor: new THREE.Color('#ff8a9a') });
      // a real balloon: rounder at the top, narrowing to the knot
      const ball = mesh(balloonGeometry(0.15), latex);
      ball.name = 'ball';
      const stringGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const stringMat = new THREE.LineBasicMaterial({ color: '#efe9de' });
      parts.push(stringGeo);
      mats.push(stringMat);
      const string = new THREE.Line(stringGeo, stringMat);
      string.name = 'string';
      string.frustumCulled = false;
      // (the ball first, then the string: updateBalloon reads them in that order)
      g.add(ball, string);
      return { id, holder: 'leftHand', object: g, dispose };
    }
    case 'foam-finger': {
      // a foam hand worn over the fist: the cuff round the wrist, the finger pointing on along the arm
      const foam = std('#f2b51f', { roughness: 0.92 });
      const cuffMat = std('#c9302c', { roughness: 0.85 });
      const cuff = mesh(new THREE.CylinderGeometry(0.052, 0.058, 0.07, 20), cuffMat);
      cuff.position.y = -0.005;
      const palm = mesh(new THREE.CapsuleGeometry(0.055, 0.07, 6, 16), foam);
      palm.scale.set(1.15, 1, 0.62);
      palm.position.y = 0.09;
      const finger = mesh(new THREE.CapsuleGeometry(0.026, 0.15, 6, 12), foam);
      finger.position.set(0.025, 0.24, 0);
      const knuckles = mesh(new THREE.CapsuleGeometry(0.03, 0.06, 6, 12), foam);
      knuckles.rotation.z = Math.PI / 2;
      knuckles.position.set(-0.012, 0.155, 0.006);
      const thumb = mesh(new THREE.CapsuleGeometry(0.022, 0.05, 6, 10), foam);
      thumb.position.set(-0.07, 0.11, 0);
      thumb.rotation.z = 0.7;
      g.add(cuff, palm, finger, knuckles, thumb);
      return { id, holder: 'rightHand', object: g, dispose };
    }
  }
  return null;
}

/** A cap's crown, unit size: full at the sides and gently domed on top (not a hemisphere), so it covers hair. */
function crownGeometry() {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const y = i / 16;
    // a superellipse profile (x^2.4 + y^2.4 = 1): a rounded dome, fuller than a half-ellipsoid
    pts.push(new THREE.Vector2(Math.max(0.0001, (1 - y ** 2.4) ** (1 / 2.4)), y));
  }
  return new THREE.LatheGeometry(pts, 32);
}

/** A cap's brim: a flat, slightly curved half-disc reaching out over the face (-z), unit radius. */
function brimGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.95, 0.45);
  shape.quadraticCurveTo(-0.98, -0.55, 0, -1.05);
  shape.quadraticCurveTo(0.98, -0.55, 0.95, 0.45);
  shape.quadraticCurveTo(0, -0.1, -0.95, 0.45);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 16 });
  // lie it flat (the shape was drawn in x/y), then curve it down at the sides
  geo.rotateX(Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) - 0.18 * pos.getX(i) ** 2);
  geo.computeVertexNormals();
  return geo;
}

/** A balloon of radius `r`: a sphere pulled into a teardrop at the bottom, with a little knot. */
function balloonGeometry(r: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI;
    // wider and rounder at the top, tapering smoothly towards the neck (no crease at the middle)
    const taper = ((1 + Math.cos(a)) / 2) ** 2;
    const w = Math.sin(a) * (1 - 0.2 * taper);
    pts.push(new THREE.Vector2(Math.max(0.0001, w * r), -Math.cos(a) * r * 1.18));
  }
  pts.push(new THREE.Vector2(r * 0.12, -r * 1.3), new THREE.Vector2(r * 0.16, -r * 1.36), new THREE.Vector2(0.0001, -r * 1.38));
  return new THREE.LatheGeometry(pts, 28);
}

/** A five-pointed star, flat in x/y, with outer radius `outer`. */
function star(outer: number, inner: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return s;
}
