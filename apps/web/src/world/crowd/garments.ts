// Real cloth over a person's own clothes, made to fit that particular body: Rosa's bib apron and the
// cabin crew's silk scarf. The people GLBs (Rocketbox, MakeHuman) come dressed; these are the extra
// pieces a role needs, built when the person loads and skinned to their skeleton, so they move with
// every clip.
//
//   const apron = buildGarment('apron', body, { colour: PALETTE.teal, spec });
//   body.parent!.add(apron);   // beside the body: same parent, same local transform
//   …
//   disposeGarment(apron);
//
// The game doesn't call these itself: PersonRig builds, recolours (recolourGarment) and disposes them
// from Look.wear ({ apron: '#rrggbb', scarf: … }), so `people.create({ ...look, wear: { apron } })`
// is all a role needs.
//
// `body` is the avatar's body primitive at LOD0 (its material is spec.parts.body); the head primitive
// beside it (spec.parts.head) is used too, for the neck. The garment is one mesh for every LOD.
//
// How it fits. Everything is measured in the bind pose, from the skeleton's inverse bind matrices,
// so it doesn't matter what the person is doing when it's built. Through the pelvis they give a
// metric frame for the mesh (the GLBs' positions are quantised, so the geometry's own units aren't
// metres): x the person's left, y up from the floor, z forward. In that frame the body's outer
// surface (body and head, arms left out) is rasterised into cylindrical height fields: for each angle
// round a vertical axis and each height, how far out the outermost surface is and which triangle it's
// on. The cloth is shaped on those fields the way cloth behaves:
//   - the skirt hangs from the waist: going down a column it never comes back in, so it falls
//     straight from the widest point (belly, hips, thighs) and bridges the gap between the legs;
//   - the bib is the upper convex hull of the chest from the waist to the bib's top, so it spans the
//     bust like taut cloth instead of following it in and out;
//   - every row is made convex in plan (fills the cleavage, the gap between the thighs);
//   - then a light smoothing that may never take it below the body plus its clearance.
// The neck strap and the scarf's ends are projected onto the nearest surface (and pushed off it by
// their clearance); the waistband, the ties and the scarf's band are laid round the fields.
//
// Skinning. Each cloth vertex takes the skin weights of the body surface under it (the triangle's
// barycentric mix, averaged over a few centimetres so creases don't crumple it), with arm, face and
// foot bones folded into the clavicle, the head and the calf. The skirt is the exception: cloth isn't
// skin. A knee swinging forward pushes it, a knee going back leaves it, so standing and walking its
// lower part swings about the line through the hip joints, as far forward as the leading thigh (a
// soft max of the two thighs' swing), without the thigh's twist or sideways lift, which would carry
// the whole skirt into the other leg. Where the skirt hangs clear of the thighs (from a full bust or
// belly), a thigh has to cross that gap before it reaches the cloth: each column knows its room, and
// leans from that swing towards a second one that starts only once the thigh is past the room. The
// swings are matrices the apron's material gets as uniforms, worked out from the thighs just before
// it's drawn (and before its shadow is), so no geometry is uploaded per frame and nothing lags a
// frame. Seated, both thighs are forward: the skirt takes the
// body's own share of thigh and pelvis, with the swing for the thighs, so it lies in the lap.

import * as THREE from 'three';
import type { AvatarSpec } from './people-manifest';

export type GarmentKind = 'apron' | 'scarf';

export interface GarmentOptions {
  /** The cloth, '#rrggbb': the apron in the fair's teal (PALETTE.teal), the scarf gold. */
  colour: string;
  spec: AvatarSpec;
  /** The apron's stitching (default: a light shade of the cloth); the scarf's thin red lines (default '#c8233f'). */
  accent?: string;
}

/** What buildGarment measured and made, kept on the mesh's userData.garment for tools and tests. */
export interface GarmentInfo {
  kind: GarmentKind;
  triangles: number;
  /** Time to build it, milliseconds (the first garment of a colour also draws its texture). */
  ms: number;
  /** Where the time went: measuring the body, shaping the cloth, its texture, the mesh (ms). */
  steps: Record<string, number>;
  /**
   * What it was fitted to, in the bind pose: heights in metres from the floor (thigh, knee, waist,
   * bust, hem, bibTop, neck, scarf), neckRadius (m) and the apron's swingGap (radians, see Dynamic).
   */
  marks: Record<string, number>;
  /** The cloth's colour and accent now (recolourGarment changes them). */
  colour: string;
  accent?: string;
}

// ── bones ────────────────────────────────────────────────────────────────────────────────────────

/** The Biped bones the garments use (the manifest's `rocketbox` rig; the MakeHuman avatars share it). */
const BIP = {
  pelvis: 'Bip01_Pelvis', spine: 'Bip01_Spine', spine1: 'Bip01_Spine1', spine2: 'Bip01_Spine2',
  neck: 'Bip01_Neck', head: 'Bip01_Head', clavL: 'Bip01_L_Clavicle', clavR: 'Bip01_R_Clavicle',
  thighL: 'Bip01_L_Thigh', thighR: 'Bip01_R_Thigh', calfL: 'Bip01_L_Calf', calfR: 'Bip01_R_Calf',
  footL: 'Bip01_L_Foot', footR: 'Bip01_R_Foot',
} as const;
type Bone = keyof typeof BIP;

/** The bones cloth may follow, in this order (dense weight vectors index them). */
const CLOTH: Bone[] = ['pelvis', 'spine', 'spine1', 'spine2', 'neck', 'head', 'clavL', 'clavR', 'thighL', 'thighR', 'calfL', 'calfR'];
const NB = CLOTH.length;
const S_PELVIS = 0, S_SPINE = 1, S_THIGH_L = 8, S_THIGH_R = 9, S_CALF_L = 10, S_CALF_R = 11;
const ARM = /_[LR]_(UpperArm|Forearm|Hand|Finger)/;

/** The person, measured: the fit frame and their outer surface in it. */
interface Fit {
  skeleton: THREE.Skeleton;
  /** Skeleton index of each CLOTH bone. */
  index: number[];
  /** Fit space → the body geometry's own (bind) space, for positions and normals. */
  fromFit: THREE.Matrix4;
  normalFromFit: THREE.Matrix3;
  /** A bone's rest position in fit space. */
  at(b: Bone): THREE.Vector3;
  /** A bone's rest position in the pelvis bone's own space. */
  restPelvis(b: Bone): THREE.Vector3;
  /** The fit frame's up and forward as seen from the pelvis bone (the skirt measures the thighs' swing there). */
  pelvisUp: THREE.Vector3;
  pelvisFwd: THREE.Vector3;
  /** Surface (body + head): positions in fit space, dense CLOTH weights per vertex, triangles, and the arm triangles to leave out. */
  pos: Float32Array;
  w: Float32Array;
  tri: Uint32Array;
  skip: Uint8Array;
  nt: number;
}

function fitBody(body: THREE.SkinnedMesh, spec: AvatarSpec): Fit {
  const skeleton = body.skeleton;
  const byName = new Map(skeleton.bones.map((b, i) => [b.name, i] as const));
  const find = (b: Bone) => {
    const i = byName.get(BIP[b]);
    if (i === undefined) throw new Error(`garments: ${spec.id} has no ${BIP[b]}`);
    return i;
  };
  // inverse bind matrices map bind space to each bone's own space; the pelvis's, times another
  // bone's inverse, is that bone's rest position relative to the pelvis, in metres
  const pelvisInv = skeleton.boneInverses[find('pelvis')];
  const m = new THREE.Matrix4();
  const restPelvis = (b: Bone) => new THREE.Vector3().setFromMatrixPosition(m.copy(skeleton.boneInverses[find(b)]).invert().premultiply(pelvisInv));
  const up = restPelvis('head').sub(restPelvis('footL').add(restPelvis('footR')).multiplyScalar(0.5)).normalize();
  const left = restPelvis('thighL').sub(restPelvis('thighR'));
  left.addScaledVector(up, -left.dot(up)).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up);
  const rot = new THREE.Matrix4().makeBasis(left, up, fwd).transpose();

  // the body and, for the neck, the head primitive beside it (a clone's primitives have skeletons of their own over the same bones)
  const meshes = [body];
  if (spec.parts.head !== spec.parts.body)
    for (const o of body.parent?.children ?? []) {
      const s = o as THREE.SkinnedMesh;
      if (s !== body && s.isSkinnedMesh && s.skeleton?.bones[0] === skeleton.bones[0] && (s.material as THREE.Material).name === spec.parts.head) meshes.push(s);
    }

  const slotOf = new Map(CLOTH.map((b, i) => [BIP[b] as string, i] as const));
  const fold = skeleton.bones.map((bone) => {
    let o: THREE.Object3D | null = bone;
    while (o && !slotOf.has(o.name)) o = o.parent;
    return o ? slotOf.get(o.name)! : S_PELVIS;
  });
  const isArm = skeleton.bones.map((b) => ARM.test(b.name));

  let nv = 0;
  let nt = 0;
  for (const s of meshes) {
    nv += s.geometry.attributes.position.count;
    nt += (s.geometry.index?.count ?? s.geometry.attributes.position.count) / 3;
  }
  const pos = new Float32Array(nv * 3);
  const w = new Float32Array(nv * NB);
  const arm = new Float32Array(nv);
  const tri = new Uint32Array(nt * 3);
  const skip = new Uint8Array(nt);
  let v = 0;
  let t = 0;
  for (const s of meshes) {
    m.copy(rot).multiply(pelvisInv).multiply(s.bindMatrix);
    const g = s.geometry;
    const count = g.attributes.position.count;
    const P = floats(g.attributes.position);
    const SI = floats(g.attributes.skinIndex);
    const SW = floats(g.attributes.skinWeight);
    const e = m.elements;
    const base = v;
    for (let i = 0; i < count; i++, v++) {
      const x = P.data[i * P.size];
      const y = P.data[i * P.size + 1];
      const z = P.data[i * P.size + 2];
      pos[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      pos[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      pos[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      for (let k = 0; k < 4; k++) {
        const wt = SW.data[i * SW.size + k];
        if (wt <= 0) continue;
        const bi = SI.data[i * SI.size + k];
        w[v * NB + fold[bi]] += wt;
        if (isArm[bi]) arm[v] += wt;
      }
    }
    const I = g.index;
    const n = (I?.count ?? count) / 3;
    for (let i = 0; i < n; i++, t++) {
      for (let k = 0; k < 3; k++) tri[t * 3 + k] = base + (I ? I.getX(i * 3 + k) : i * 3 + k);
      skip[t] = arm[tri[t * 3]] + arm[tri[t * 3 + 1]] + arm[tri[t * 3 + 2]] > 1.5 ? 1 : 0;
    }
  }
  // stand it on the floor: the lowest point of the body is y = 0
  let floor = Infinity;
  for (let i = 1; i < pos.length; i += 3) floor = Math.min(floor, pos[i]);
  for (let i = 1; i < pos.length; i += 3) pos[i] -= floor;

  const toFit = new THREE.Matrix4().makeTranslation(0, -floor, 0).multiply(rot).multiply(pelvisInv).multiply(body.bindMatrix);
  const fromFit = toFit.clone().invert();
  const at = (b: Bone) => {
    const v = restPelvis(b).applyMatrix4(rot);
    v.y -= floor;
    return v;
  };
  return {
    skeleton,
    index: CLOTH.map(find),
    fromFit,
    normalFromFit: new THREE.Matrix3().getNormalMatrix(fromFit),
    at,
    restPelvis,
    pelvisUp: up,
    pelvisFwd: fwd,
    pos,
    w,
    tri,
    skip,
    nt,
  };
}

/** An attribute's values as plain (de-normalised) numbers, item by item, however it's stored. */
function floats(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): { data: ArrayLike<number>; size: number } {
  const size = a.itemSize;
  if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    const arr = (a as THREE.BufferAttribute).array;
    if (!a.normalized) return { data: arr, size };
    const signed = arr instanceof Int16Array || arr instanceof Int8Array;
    const scale = arr instanceof Int16Array ? 1 / 32767 : arr instanceof Uint16Array ? 1 / 65535 : arr instanceof Int8Array ? 1 / 127 : arr instanceof Uint8Array ? 1 / 255 : 1;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = signed ? Math.max(arr[i] * scale, -1) : arr[i] * scale;
    return { data: out, size };
  }
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k);
  return { data: out, size };
}

// ── the body's surface as cylindrical height fields ─────────────────────────────────────────────

/**
 * The body's outermost surface round a vertical axis (in a frame of its own: `local` maps fit space
 * into it): for each angle (column; 0 is forward, positive towards the person's left) and height
 * (row), how far out it is, and the triangle and barycentric point it's on. Empty cells are 0.
 */
class Field {
  readonly dth: number;
  readonly r: Float32Array;
  readonly tri: Int32Array;
  readonly bu: Float32Array;
  readonly bv: Float32Array;

  constructor(
    readonly nth: number,
    readonly y0: number,
    readonly dy: number,
    readonly ny: number,
  ) {
    this.dth = (2 * Math.PI) / nth;
    const n = nth * ny;
    this.r = new Float32Array(n);
    this.tri = new Int32Array(n).fill(-1);
    this.bu = new Float32Array(n);
    this.bv = new Float32Array(n);
  }

  k(i: number, j: number) {
    return j * this.nth + (((i % this.nth) + this.nth) % this.nth);
  }
  angle(i: number) {
    return i * this.dth - Math.PI;
  }
  col(th: number) {
    return (th + Math.PI) / this.dth;
  }
  row(y: number) {
    return (y - this.y0) / this.dy;
  }
  y(j: number) {
    return this.y0 + j * this.dy;
  }

  /** Rasterises the surface's triangles whose corners lie between rMin and rMax from the axis. */
  raster(f: Fit, rMin: number, rMax: number, local?: THREE.Matrix4) {
    const n = f.pos.length / 3;
    const th = new Float32Array(n);
    const yy = new Float32Array(n);
    const rr = new Float32Array(n);
    const e = local?.elements;
    const lo = this.y0 - this.dy;
    const hi = this.y0 + this.ny * this.dy;
    for (let i = 0; i < n; i++) {
      let x = f.pos[i * 3];
      let y = f.pos[i * 3 + 1];
      let z = f.pos[i * 3 + 2];
      if (e) {
        const X = e[0] * x + e[4] * y + e[8] * z + e[12];
        const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
        z = e[2] * x + e[6] * y + e[10] * z + e[14];
        x = X;
        y = Y;
      }
      yy[i] = y;
      // (most of the body is well above or below a field: its triangles are skipped by height, or
      // by radius if one reaches in from more than 10 cm away, so it needs no angle)
      if (y < lo - 0.1 || y > hi + 0.1) {
        rr[i] = Infinity;
        continue;
      }
      th[i] = Math.atan2(x, z);
      rr[i] = Math.hypot(x, z);
    }
    const { dth, dy, y0, nth, ny } = this;
    for (let t = 0; t < f.nt; t++) {
      if (f.skip[t]) continue;
      const a = f.tri[t * 3];
      const b = f.tri[t * 3 + 1];
      const c = f.tri[t * 3 + 2];
      const ya = yy[a];
      const yb = yy[b];
      const yc = yy[c];
      if (Math.max(ya, yb, yc) < lo || Math.min(ya, yb, yc) > hi) continue;
      const ra = rr[a];
      const rb = rr[b];
      const rc = rr[c];
      if (Math.min(ra, rb, rc) < rMin || Math.max(ra, rb, rc) > rMax) continue;
      let ta = th[a];
      let tb = th[b];
      let tc = th[c];
      if (Math.max(ta, tb, tc) - Math.min(ta, tb, tc) > Math.PI) {
        if (ta < 0) ta += 2 * Math.PI;
        if (tb < 0) tb += 2 * Math.PI;
        if (tc < 0) tc += 2 * Math.PI;
      }
      const den = (yb - yc) * (ta - tc) + (tc - tb) * (ya - yc);
      if (Math.abs(den) < 1e-12) continue;
      const i0 = Math.ceil((Math.min(ta, tb, tc) + Math.PI) / dth);
      const i1 = Math.floor((Math.max(ta, tb, tc) + Math.PI) / dth);
      const j0 = Math.max(0, Math.ceil((Math.min(ya, yb, yc) - y0) / dy));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ya, yb, yc) - y0) / dy));
      for (let j = j0; j <= j1; j++) {
        const yj = y0 + j * dy - yc;
        for (let i = i0; i <= i1; i++) {
          const ti = i * dth - Math.PI - tc;
          const l1 = ((yb - yc) * ti + (tc - tb) * yj) / den;
          if (l1 < -1e-4) continue;
          const l2 = ((yc - ya) * ti + (ta - tc) * yj) / den;
          if (l2 < -1e-4 || l1 + l2 > 1 + 1e-4) continue;
          const r = l1 * ra + l2 * rb + (1 - l1 - l2) * rc;
          const k = j * nth + (((i % nth) + nth) % nth);
          if (r > this.r[k]) {
            this.r[k] = r;
            this.tri[k] = t;
            this.bu[k] = l1;
            this.bv[k] = l2;
          }
        }
      }
    }
    // pinholes where a seam slipped between cell centres: borrow from the neighbours
    for (let j = 1; j < ny - 1; j++)
      for (let i = 0; i < nth; i++) {
        const k = this.k(i, j);
        if (this.r[k] > 0) continue;
        let sum = 0;
        let cnt = 0;
        let best = -1;
        for (const [di, dj] of NEIGHBOURS) {
          const q = this.k(i + di, j + dj);
          if (this.r[q] <= 0) continue;
          sum += this.r[q];
          cnt++;
          if (best < 0 || this.r[q] > this.r[best]) best = q;
        }
        if (cnt >= 5) {
          this.r[k] = sum / cnt;
          this.tri[k] = this.tri[best];
          this.bu[k] = this.bu[best];
          this.bv[k] = this.bv[best];
        }
      }
  }

  /**
   * The surface's skin weights round (θ, y), a tent window ±di columns and ±dj rows wide, into `out`
   * (dense, normalised). False when the window holds no surface (`out` is then all spine).
   */
  weights(f: Fit, th: number, y: number, di: number, dj: number, out: Float32Array): boolean {
    out.fill(0);
    const ci = this.col(th);
    const cj = this.row(y);
    let total = 0;
    for (let j = Math.ceil(cj - dj); j <= Math.floor(cj + dj); j++) {
      if (j < 0 || j >= this.ny) continue;
      for (let i = Math.ceil(ci - di); i <= Math.floor(ci + di); i++) {
        const k = this.k(i, j);
        const t = this.tri[k];
        if (t < 0) continue;
        const g = (1 - Math.abs(i - ci) / (di + 1)) * (1 - Math.abs(j - cj) / (dj + 1));
        addTriWeights(f, t, this.bu[k], this.bv[k], g, out);
        total += g;
      }
    }
    if (total > 0) for (let s = 0; s < NB; s++) out[s] /= total;
    else out[S_SPINE] = 1;
    return total > 0;
  }
}
const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;

function addTriWeights(f: Fit, t: number, u: number, v: number, g: number, out: Float32Array) {
  const a = f.tri[t * 3] * NB;
  const b = f.tri[t * 3 + 1] * NB;
  const c = f.tri[t * 3 + 2] * NB;
  const wv = 1 - u - v;
  for (let s = 0; s < NB; s++) out[s] += g * (u * f.w[a + s] + v * f.w[b + s] + wv * f.w[c + s]);
}

/** Bilinear sample of a field-shaped array at (θ, y). */
function sample(F: Field, a: Float32Array, th: number, y: number) {
  const c = F.col(th);
  const r = THREE.MathUtils.clamp(F.row(y), 0, F.ny - 1.0001);
  const i = Math.floor(c);
  const j = Math.floor(r);
  const fx = c - i;
  const fy = r - j;
  const a0 = a[F.k(i, j)] + (a[F.k(i + 1, j)] - a[F.k(i, j)]) * fx;
  const a1 = a[F.k(i, j + 1)] + (a[F.k(i + 1, j + 1)] - a[F.k(i, j + 1)]) * fx;
  return a0 + (a1 - a0) * fy;
}

/** Lifts row j's radii between columns i0 and i1 (going round the axis) onto their outer convex chain in plan. */
function convexRow(F: Field, C: Float32Array, j: number, i0: number, i1: number) {
  const n = i1 - i0 + 1;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let m = 0; m < n; m++) {
    const th = F.angle(i0 + m);
    const r = C[F.k(i0 + m, j)];
    xs[m] = r * Math.sin(th);
    zs[m] = r * Math.cos(th);
  }
  const hull: number[] = [];
  // b is dropped when it's on the axis's side of the line from a to c (a dent)
  const side = (a: number, c: number, px: number, pz: number) => (xs[c] - xs[a]) * (pz - zs[a]) - (zs[c] - zs[a]) * (px - xs[a]);
  for (let m = 0; m < n; m++) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      const sb = side(a, m, xs[b], zs[b]);
      const so = side(a, m, 0, 0);
      if (sb * so >= 0) hull.pop();
      else break;
    }
    hull.push(m);
  }
  for (let h = 0; h + 1 < hull.length; h++) {
    const a = hull[h];
    const b = hull[h + 1];
    const ex = xs[b] - xs[a];
    const ez = zs[b] - zs[a];
    for (let m = a + 1; m < b; m++) {
      const th = F.angle(i0 + m);
      const dx = Math.sin(th);
      const dz = Math.cos(th);
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const r = (xs[a] * ez - zs[a] * ex) / den;
      const k = F.k(i0 + m, j);
      if (r > C[k]) C[k] = r;
    }
  }
}

/** Nearest points on the surface's triangles (those `keep` allows), through a uniform grid. */
class Nearest {
  private cells = new Map<number, number[]>();
  private stamp: Int32Array;
  private query = 0;
  readonly point = new THREE.Vector3();
  readonly normal = new THREE.Vector3();
  tri = -1;
  u = 0;
  v = 0;

  constructor(
    private f: Fit,
    private size: number,
    keep: (ax: number, ay: number, az: number) => boolean,
  ) {
    this.stamp = new Int32Array(f.nt);
    const P = f.pos;
    for (let t = 0; t < f.nt; t++) {
      if (f.skip[t]) continue;
      const a = f.tri[t * 3] * 3;
      const b = f.tri[t * 3 + 1] * 3;
      const c = f.tri[t * 3 + 2] * 3;
      if (!keep(P[a], P[a + 1], P[a + 2])) continue;
      const x0 = Math.floor(Math.min(P[a], P[b], P[c]) / size);
      const x1 = Math.floor(Math.max(P[a], P[b], P[c]) / size);
      const y0 = Math.floor(Math.min(P[a + 1], P[b + 1], P[c + 1]) / size);
      const y1 = Math.floor(Math.max(P[a + 1], P[b + 1], P[c + 1]) / size);
      const z0 = Math.floor(Math.min(P[a + 2], P[b + 2], P[c + 2]) / size);
      const z1 = Math.floor(Math.max(P[a + 2], P[b + 2], P[c + 2]) / size);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const key = this.key(x, y, z);
            const list = this.cells.get(key);
            if (list) list.push(t);
            else this.cells.set(key, [t]);
          }
    }
  }

  private key(x: number, y: number, z: number) {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  }

  /** Finds the nearest surface point to p (within two cells); its outward normal points away from `inside`. */
  find(p: THREE.Vector3, inside: THREE.Vector3): boolean {
    const P = this.f.pos;
    const cx = Math.floor(p.x / this.size);
    const cy = Math.floor(p.y / this.size);
    const cz = Math.floor(p.z / this.size);
    let best = Infinity;
    for (let reach = 1; reach <= 2 && best === Infinity; reach++) {
      const q = ++this.query;
      for (let x = cx - reach; x <= cx + reach; x++)
        for (let y = cy - reach; y <= cy + reach; y++)
          for (let z = cz - reach; z <= cz + reach; z++) {
            const list = this.cells.get(this.key(x, y, z));
            if (!list) continue;
            for (const t of list) {
              if (this.stamp[t] === q) continue;
              this.stamp[t] = q;
              const a = this.f.tri[t * 3] * 3;
              const b = this.f.tri[t * 3 + 1] * 3;
              const c = this.f.tri[t * 3 + 2] * 3;
              const d = closestOnTriangle(p, P, a, b, c, scratch);
              if (d < best) {
                best = d;
                this.tri = t;
                this.point.set(scratch[0], scratch[1], scratch[2]);
                this.u = scratch[3];
                this.v = scratch[4];
                const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
                const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
                this.normal.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
              }
            }
          }
    }
    if (best === Infinity) return false;
    if (this.normal.dot(tmpV.subVectors(this.point, inside)) < 0) this.normal.negate();
    return true;
  }
}
const scratch = new Float64Array(5);
const tmpV = new THREE.Vector3();

/** Closest point to p on triangle (a, b, c) (offsets into P): writes x, y, z and the barycentric weights of a and b to out; returns the squared distance. */
function closestOnTriangle(p: THREE.Vector3, P: Float32Array, a: number, b: number, c: number, out: Float64Array) {
  const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
  const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
  const apx = p.x - P[a], apy = p.y - P[a + 1], apz = p.z - P[a + 2];
  let u: number; // weight of a
  let v: number; // weight of b
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const bpx = p.x - P[b], bpy = p.y - P[b + 1], bpz = p.z - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = p.x - P[c], cpy = p.y - P[c + 1], cpz = p.z - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2;
  const vb = d5 * d2 - d1 * d6;
  const va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) [u, v] = [1, 0];
  else if (d3 >= 0 && d4 <= d3) [u, v] = [0, 1];
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const s = d1 / (d1 - d3);
    [u, v] = [1 - s, s];
  } else if (d6 >= 0 && d5 <= d6) [u, v] = [0, 0];
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) [u, v] = [1 - d2 / (d2 - d6), 0];
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const s = (d4 - d3) / (d4 - d3 + (d5 - d6));
    [u, v] = [0, 1 - s];
  } else {
    const den = 1 / (va + vb + vc);
    v = vb * den;
    const wv = vc * den;
    u = 1 - v - wv;
  }
  const wv = 1 - u - v;
  out[0] = u * P[a] + v * P[b] + wv * P[c];
  out[1] = u * P[a + 1] + v * P[b + 1] + wv * P[c + 1];
  out[2] = u * P[a + 2] + v * P[b + 2] + wv * P[c + 2];
  out[3] = u;
  out[4] = v;
  return (out[0] - p.x) ** 2 + (out[1] - p.y) ** 2 + (out[2] - p.z) ** 2;
}

// ── building cloth ───────────────────────────────────────────────────────────────────────────────

/** Vertices (fit space), UVs and dense weights as they're made, then the skinned geometry. */
class Cloth {
  pos: number[] = [];
  uv: number[] = [];
  w: number[] = [];
  index: number[] = [];

  get count() {
    return this.pos.length / 3;
  }
  vert(p: THREE.Vector3Like, u: number, v: number, w: ArrayLike<number>) {
    this.pos.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    for (let s = 0; s < NB; s++) this.w.push(w[s]);
    return this.count - 1;
  }
  p(i: number, out = new THREE.Vector3()) {
    return out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }
  /** Two triangles for a quad, wound so its front faces away from `inside`. */
  quad(a: number, b: number, c: number, d: number, inside: THREE.Vector3Like) {
    const pa = this.p(a, qa);
    const n = qn.subVectors(this.p(b, qb), pa).cross(qc.subVectors(this.p(d, qc), pa));
    const centre = qb.addVectors(this.p(a, qb), this.p(c, qd)).multiplyScalar(0.5);
    if (n.lengthSq() === 0) n.subVectors(this.p(c, qd), pa).cross(qc.subVectors(this.p(d, qc), pa));
    if (n.dot(centre.sub(inside)) >= 0) this.index.push(a, b, d, b, c, d);
    else this.index.push(a, d, b, b, d, c);
  }
}
const qa = new THREE.Vector3();
const qb = new THREE.Vector3();
const qc = new THREE.Vector3();
const qd = new THREE.Vector3();
const qn = new THREE.Vector3();

/** The four strongest of a dense weight vector, as skeleton indices and normalised weights. */
function top4(f: Fit, w: ArrayLike<number>, from: number, si: Uint16Array, sw: Float32Array, o: number) {
  const slot = [0, 0, 0, 0];
  const val = [-1, -1, -1, -1];
  for (let s = 0; s < NB; s++) {
    const x = w[from + s];
    if (x <= val[3]) continue;
    let k = 3;
    while (k > 0 && x > val[k - 1]) {
      val[k] = val[k - 1];
      slot[k] = slot[k - 1];
      k--;
    }
    val[k] = x;
    slot[k] = s;
  }
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += Math.max(0, val[k]);
  for (let k = 0; k < 4; k++) {
    si[o + k] = f.index[slot[k]];
    sw[o + k] = sum > 0 ? Math.max(0, val[k]) / sum : k === 0 ? 1 : 0;
  }
}

/** Folds the legs' weights into the pelvis (ties, the band: they shouldn't follow a thigh). */
function legsToPelvis(w: Float32Array) {
  w[S_PELVIS] += w[S_THIGH_L] + w[S_THIGH_R] + w[S_CALF_L] + w[S_CALF_R];
  w[S_THIGH_L] = w[S_THIGH_R] = w[S_CALF_L] = w[S_CALF_R] = 0;
  return w;
}

const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ── the apron ────────────────────────────────────────────────────────────────────────────────────

/**
 * The apron's layout in its texture, in metres of cloth (the canvas is APRON_TEX metres a side). The
 * pieces keep these proportions on every body: a person's own skirt length or bib height stretches
 * its piece a few per cent, so one texture serves everyone in that colour.
 */
const APRON_TEX = 1.0;
const AP = {
  skirt: { u: 0.01, v: 0.01, w: 0.52, h: 0.56, top: 0.235, hem: 0.255 },
  bib: { u: 0.56, v: 0.01, w: 0.36, h: 0.3, bottom: 0.165, top: 0.125 },
  pocket: { u: 0.56, v: 0.36, w: 0.28, h: 0.16 },
  band: { u: 0.01, v: 0.62, w: 0.98, h: 0.034 },
  strap: { u: 0.01, v: 0.68, w: 0.98, h: 0.024 },
  tie: { u: 0.01, v: 0.73, w: 0.2, h: 0.03 },
  knot: { u: 0.56, v: 0.73, w: 0.1, h: 0.07 },
};
const POCKET = { half: 0.13, top: 0.1, height: 0.15 };

interface Dynamic {
  /** The vertices that swing (the skirt and its pocket): first index and count. */
  start: number;
  count: number;
  /** Per vertex: how much its height swings with the leading thigh standing (0 at the waist, 1 low down). */
  k: Float32Array;
  /** Per vertex, standing: [pelvis, spine] without the legs. Seated: [thighL, thighR, pelvis, spine], the body's own. */
  stand: Float32Array;
  seat: Float32Array;
  /**
   * How far (radians) a thigh swings forward from the bind pose before it reaches the skirt where
   * the skirt hangs furthest clear of it, and per vertex the share of that its column has (0 where
   * the skirt lies against the thighs and goes with the leading one at once, 1 the clearest).
   */
  gap: number;
  clear: Float32Array;
}

function buildApron(f: Fit, marks: Record<string, number>, lap: (step: string) => void): { cloth: Cloth; dyn: Dynamic } {
  const at = (b: Bone) => f.at(b);
  const thighY = (at('thighL').y + at('thighR').y) / 2;
  const kneeY = (at('calfL').y + at('calfR').y) / 2;
  const neck = at('neck');

  // the body round the pelvis's vertical axis, 2.5° by 1.25 cm, from the knees to the neck; nothing
  // further out than 30 cm (a loose sleeve hanging beside the hips in the bind pose isn't the body)
  const F = new Field(144, kneeY - 0.04, 0.0125, Math.ceil((neck.y + 0.03 - kneeY + 0.04) / 0.0125));
  F.raster(f, 0.02, 0.3);
  lap('raster');
  const front = (j: number, lim: number) => {
    let s = 0;
    let n = 0;
    for (let i = Math.round(F.col(-lim)); i <= Math.round(F.col(lim)); i++) {
      const r = F.r[F.k(i, j)];
      if (r > 0) (s += r), n++;
    }
    return n ? s / n : 0;
  };
  // the apron ties at the natural waist, a few centimetres above the Biped's first spine joint
  // (clothes hide where the body is narrowest, so it's taken from the skeleton); the bust is where
  // the front is fullest below the neck
  const waistY = THREE.MathUtils.clamp(at('spine').y + 0.035, thighY + 0.12, thighY + 0.2);
  let bustY = waistY + 0.2;
  let best = 0;
  for (let j = Math.ceil(F.row(waistY + 0.1)); j <= Math.floor(F.row(neck.y - 0.06)); j++) {
    const r = front(j, 0.45);
    if (r > best) (best = r), (bustY = F.y(j));
  }
  const hemY = kneeY + 0.07;
  const topY = Math.min(Math.max(bustY + 0.09, waistY + 0.24), neck.y - 0.085);
  Object.assign(marks, { thigh: thighY, knee: kneeY, waist: waistY, bust: bustY, hem: hemY, bibTop: topY, neck: neck.y });

  // the cloth's radius: never closer to the body than its clearance (1.2 cm on the bib and waist,
  // opening to 2 cm at the hem, where a stride or a sit needs the room)
  const clear = (y: number) => (y >= waistY ? 0.012 : 0.012 + 0.008 * smooth(waistY, hemY, y));
  const O = new Float32Array(F.r.length);
  for (let j = 0; j < F.ny; j++) for (let i = 0; i < F.nth; i++) {
    const k = F.k(i, j);
    if (F.r[k] > 0) O[k] = F.r[k] + clear(F.y(j));
  }
  const C = O.slice();
  const jw = Math.round(F.row(waistY));
  const jh = Math.max(0, Math.floor(F.row(hemY)) - 1);
  const jt = Math.min(F.ny - 1, Math.ceil(F.row(topY)) + 1);
  const LIM_SKIRT = Math.round((150 / 180) * (F.nth / 2));
  const LIM_BIB = Math.round((100 / 180) * (F.nth / 2));
  const mid = F.nth / 2; // column of θ = 0
  // (the columns used never wrap round, so they're indexed directly: row j, column i is j·nth + i)
  const W = F.nth;
  const hull: number[] = [];
  for (let i = mid - LIM_SKIRT; i <= mid + LIM_SKIRT; i++) {
    // the skirt falls from the waist and never comes back in
    for (let j = jw - 1; j >= 0; j--) C[j * W + i] = Math.max(C[j * W + i], C[(j + 1) * W + i]);
    // the bib is taut from the waist to its top: the column's upper convex hull
    if (Math.abs(i - mid) > LIM_BIB) continue;
    hull.length = 0;
    for (let j = jw; j <= jt; j++) {
      if (O[j * W + i] <= 0) continue;
      while (hull.length >= 2) {
        const a = hull[hull.length - 2];
        const b = hull[hull.length - 1];
        const ra = O[a * W + i];
        const lift = ra + ((O[j * W + i] - ra) * (b - a)) / (j - a);
        if (O[b * W + i] <= lift) hull.pop();
        else break;
      }
      hull.push(j);
    }
    for (let h = 0; h + 1 < hull.length; h++) {
      const a = hull[h];
      const b = hull[h + 1];
      for (let j = a + 1; j < b; j++) {
        const r = O[a * W + i] + ((O[b * W + i] - O[a * W + i]) * (j - a)) / (b - a);
        C[j * W + i] = Math.max(C[j * W + i], r);
      }
    }
  }
  for (let j = jh; j <= jt; j++) {
    const lim = j <= jw ? LIM_SKIRT : LIM_BIB;
    convexRow(F, C, j, mid - lim, mid + lim);
  }
  // smooth it, never below the body plus clearance
  const T = new Float32Array(C.length);
  for (let pass = 0; pass < 3; pass++) {
    T.set(C);
    for (let j = jh + 1; j < jt; j++) {
      const lim = j <= jw ? LIM_SKIRT : LIM_BIB;
      for (let i = mid - lim + 1; i < mid + lim; i++) {
        const k = j * W + i;
        const s =
          T[k - W - 1] + 2 * T[k - W] + T[k - W + 1] +
          2 * T[k - 1] + 4 * T[k] + 2 * T[k + 1] +
          T[k + W - 1] + 2 * T[k + W] + T[k + W + 1];
        C[k] = Math.max(s / 16, O[k]);
      }
    }
  }

  lap('envelope');
  // a row's profile round the axis at height y, and the angle at arc length s from the front
  const profile = (y: number) => {
    const r = new Float32Array(F.nth);
    for (let i = 0; i < F.nth; i++) r[i] = sample(F, C, F.angle(i), y);
    const arc = new Float32Array(F.nth); // signed arc length from θ = 0
    for (let dir = -1; dir <= 1; dir += 2)
      for (let m = 1; m < F.nth / 2; m++) {
        const i = mid + dir * m;
        const pi = mid + dir * (m - 1);
        const t0 = F.angle(pi);
        const t1 = F.angle(i);
        const dx = r[i] * Math.sin(t1) - r[pi] * Math.sin(t0);
        const dz = r[i] * Math.cos(t1) - r[pi] * Math.cos(t0);
        arc[i] = arc[pi] + dir * Math.hypot(dx, dz);
      }
    return { r, arc };
  };
  const point = (prof: ReturnType<typeof profile>, s: number, y: number, out: THREE.Vector3) => {
    const dir = s < 0 ? -1 : 1;
    let m = 1;
    while (m < F.nth / 2 - 1 && Math.abs(prof.arc[mid + dir * m]) < Math.abs(s)) m++;
    const i1 = mid + dir * m;
    const i0 = mid + dir * (m - 1);
    const a0 = Math.abs(prof.arc[i0]);
    const a1 = Math.abs(prof.arc[i1]);
    const t = a1 > a0 ? THREE.MathUtils.clamp((Math.abs(s) - a0) / (a1 - a0), 0, 1) : 0;
    const th = F.angle(i0) + (F.angle(i1) - F.angle(i0)) * t;
    const r = prof.r[i0] + (prof.r[i1] - prof.r[i0]) * t;
    out.set(r * Math.sin(th), y, r * Math.cos(th));
    return th;
  };

  const cloth = new Cloth();
  const wv = new Float32Array(NB);
  const axisPt = new THREE.Vector3();
  const axis = (y: number) => axisPt.set(0, y, 0);
  const tex = (u: number, v: number): [number, number] => [u / APRON_TEX, v / APRON_TEX];

  // skirt and pocket first: their weights move (see Dynamic)
  const SK = AP.skirt;
  const NC = 14;
  const NR = 14;
  const skirtLen = waistY - hemY;
  const skirtRows: { y: number; prof: ReturnType<typeof profile>; half: number }[] = [];
  for (let j = 0; j <= NR; j++) {
    const y = hemY + (skirtLen * j) / NR;
    skirtRows.push({ y, prof: profile(y), half: SK.hem + ((SK.top - SK.hem) * j) / NR });
  }
  // The skirt's weights by height, the same all the way across: the body's own, averaged over the
  // front (the thighs and the crease of the hip, where a seated lap folds), so a seated lap is one
  // sheet, and a column that looks between the legs at nothing doesn't fall back to the spine.
  const byHeight = new Map<number, Float32Array>();
  const rowWeights = (y: number) => {
    let w = byHeight.get(y);
    if (w) return w;
    w = new Float32Array(NB);
    let n = 0;
    for (let a = -4; a <= 4; a++) {
      if (!F.weights(f, a * 0.15, y, 2, 2, wv)) continue;
      for (let s = 0; s < NB; s++) w[s] += wv[s];
      n++;
    }
    if (n) for (let s = 0; s < NB; s++) w[s] /= n;
    else w[S_PELVIS] = 1;
    byHeight.set(y, w);
    return w;
  };
  const dynK: number[] = [];
  const stand: number[] = [];
  const seat: number[] = [];
  const across: number[] = [];
  const kOf = (y: number) => smooth(thighY + 0.06, thighY - 0.12, y);
  /** A swinging vertex at height y with weights w, `a` across the skirt (−1 at its right edge, 1 at its left). */
  const pushDyn = (y: number, w: Float32Array, a: number) => {
    across.push(a);
    dynK.push(kOf(y));
    const legsL = w[S_THIGH_L] + w[S_CALF_L];
    const legsR = w[S_THIGH_R] + w[S_CALF_R];
    const pelvis = w[S_PELVIS];
    const rest = Math.max(0, 1 - legsL - legsR - pelvis);
    seat.push(legsL, legsR, pelvis, rest);
    const sp = pelvis + legsL + legsR;
    stand.push(sp / (sp + rest || 1), rest / (sp + rest || 1));
  };
  const v0 = cloth.count;
  const grid: number[][] = [];
  const pt = new THREE.Vector3();
  for (let j = 0; j <= NR; j++) {
    const row = skirtRows[j];
    const ids: number[] = [];
    const rw = rowWeights(row.y);
    for (let i = 0; i <= NC; i++) {
      const s = (2 * i / NC - 1) * row.half;
      point(row.prof, s, row.y, pt);
      const u = SK.u + SK.w / 2 + (s / row.half) * (SK.hem + ((SK.top - SK.hem) * j) / NR);
      ids.push(cloth.vert(pt, ...tex(u, SK.v + (SK.h * j) / NR), rw));
      pushDyn(row.y, rw, s / row.half);
    }
    grid.push(ids);
  }
  for (let j = 0; j < NR; j++) for (let i = 0; i < NC; i++) cloth.quad(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i], axis(skirtRows[j].y));

  // a wide front pocket with a seam down its middle, a few millimetres proud of the skirt and a little full
  const PK = AP.pocket;
  const PC = 6;
  const PR = 3;
  const pocket: number[][] = [];
  const nrm = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  for (let j = 0; j <= PR; j++) {
    const y = waistY - POCKET.top - POCKET.height + (POCKET.height * j) / PR;
    const prof = profile(y);
    const profUp = profile(y + 0.01);
    const rw = rowWeights(y);
    const half = SK.hem + ((SK.top - SK.hem) * (y - hemY)) / skirtLen;
    const ids: number[] = [];
    for (let i = 0; i <= PC; i++) {
      const s = (2 * i / PC - 1) * POCKET.half;
      point(prof, s, y, pt);
      // the skirt's normal there, from its neighbours across and up
      point(prof, s + 0.01, y, pa);
      point(profUp, s, y + 0.01, pb);
      pa.sub(pt);
      pb.sub(pt);
      nrm.crossVectors(pb, pa).normalize();
      if (nrm.x * pt.x + nrm.z * pt.z < 0) nrm.negate();
      const full = Math.sin((Math.PI * i) / PC) * Math.sin((Math.PI * Math.min(j, PR - 0.6)) / PR);
      pt.addScaledVector(nrm, 0.0035 + 0.004 * Math.max(0, full));
      ids.push(cloth.vert(pt, ...tex(PK.u + (PK.w * i) / PC, PK.v + (PK.h * j) / PR), rw));
      pushDyn(y, rw, s / half);
    }
    pocket.push(ids);
  }
  for (let j = 0; j < PR; j++) for (let i = 0; i < PC; i++) cloth.quad(pocket[j][i], pocket[j][i + 1], pocket[j + 1][i + 1], pocket[j + 1][i], axis(waistY));

  // How far a thigh can swing forward before it reaches the skirt, column by column. A skirt that
  // falls from a full bust or belly hangs well clear of the thighs in front, and a knee only pushes
  // it once it gets there (without this, a stout figure's skirt stands out like a board whenever a
  // knee bends a little); at the sides it lies against them and goes with them at once. A turn
  // about the hip line keeps a point's sideways x and its distance from that line, so the thighs'
  // points are binned by those two, keeping the furthest-forward angle in each bin; a cloth vertex
  // has the room between its own angle and the furthest one behind it.
  const hipZ = (at('thighL').z + at('thighR').z) / 2;
  const CELL = 0.015;
  const ahead = new Map<number, number>();
  for (let v = 0, nv = f.pos.length / 3; v < nv; v++) {
    const y = f.pos[v * 3 + 1];
    if (y > thighY || y < hemY - 0.15) continue;
    const o = v * NB;
    if (f.w[o + S_THIGH_L] + f.w[o + S_THIGH_R] + f.w[o + S_CALF_L] + f.w[o + S_CALF_R] < 0.5) continue;
    const dz = f.pos[v * 3 + 2] - hipZ;
    const dy = thighY - y;
    const key = Math.round(f.pos[v * 3] / CELL) * 4096 + Math.round(Math.hypot(dy, dz) / CELL);
    const a = Math.atan2(dz, dy);
    const had = ahead.get(key);
    if (had === undefined || a > had) ahead.set(key, a);
  }
  const room = (p: THREE.Vector3) => {
    const dz = p.z - hipZ;
    const dy = thighY - p.y;
    const cx = Math.round(p.x / CELL);
    const cr = Math.round(Math.hypot(dy, dz) / CELL);
    let behind = -Infinity;
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) behind = Math.max(behind, ahead.get((cx + i) * 4096 + cr + k) ?? -Infinity);
    return Math.atan2(dz, dy) - behind; // Infinity when no thigh is behind it
  };
  // A column has the least room of its rows that swing, and of the columns within 7 cm of it: cloth
  // is pulled along by its neighbours (the strip between the knees has nothing behind it, but goes
  // with the knees either side); less a margin, as the thighs turn about their own joints. Then
  // smoothed, never above that, so the skirt doesn't crease where the room changes.
  const colRoom = new Float32Array(NC + 1).fill(Infinity);
  for (let j = 0; j <= NR; j++) {
    if (kOf(skirtRows[j].y) < 0.2) continue;
    for (let i = 0; i <= NC; i++) colRoom[i] = Math.min(colRoom[i], room(cloth.p(grid[j][i], pt)));
  }
  const near = colRoom.map((_, i) => THREE.MathUtils.clamp(Math.min(...colRoom.slice(Math.max(0, i - 2), i + 3)) - 0.03, 0, 0.5));
  const held = near.map((h, i) => Math.min(h, (near[Math.max(0, i - 1)] + 2 * h + near[Math.min(NC, i + 1)]) / 4));
  const gap = Math.max(...held);
  marks.swingGap = gap;
  const share = Float32Array.from(across, (a) => {
    if (gap <= 0) return 0;
    const x = THREE.MathUtils.clamp(((a + 1) / 2) * NC, 0, NC);
    const i = Math.min(NC - 1, Math.floor(x));
    return (held[i] + (held[i + 1] - held[i]) * (x - i)) / gap;
  });
  lap('skirt');
  const dyn: Dynamic = { start: v0, count: cloth.count - v0, k: Float32Array.from(dynK), stand: Float32Array.from(stand), seat: Float32Array.from(seat), clear: share, gap };

  // the bib: from the waist to its top, narrowing
  const BB = AP.bib;
  const BC = 10;
  const BR = 9;
  const bib: number[][] = [];
  for (let j = 0; j <= BR; j++) {
    const y = waistY + ((topY - waistY) * j) / BR;
    const prof = profile(y);
    const half = BB.bottom + ((BB.top - BB.bottom) * j) / BR;
    const ids: number[] = [];
    for (let i = 0; i <= BC; i++) {
      const s = (2 * i / BC - 1) * half;
      const th = point(prof, s, y, pt);
      F.weights(f, th, y, 3, 3, wv);
      ids.push(cloth.vert(pt, ...tex(BB.u + BB.w / 2 + s, BB.v + (BB.h * j) / BR), wv));
    }
    bib.push(ids);
  }
  for (let j = 0; j < BR; j++) for (let i = 0; i < BC; i++) cloth.quad(bib[j][i], bib[j][i + 1], bib[j + 1][i + 1], bib[j + 1][i], axis(waistY + 0.1));

  lap('bib');
  // the waistband, all the way round: on the apron at the front, snug on the clothes behind
  const BD = AP.band;
  const NBAND = 48;
  const bandHalf = 0.016;
  const edge = Math.abs(point(skirtRows[NR].prof, SK.top, waistY, pt));
  const bandRows: number[][] = [];
  const bandW: Float32Array[] = [];
  for (let n = 0; n <= NBAND; n++) {
    const th = -Math.PI + (2 * Math.PI * n) / NBAND;
    F.weights(f, th, waistY, 3, 2, wv);
    bandW.push(legsToPelvis(wv.slice()));
  }
  for (const dy of [-bandHalf, bandHalf]) {
    const y = waistY + dy;
    const r = new Float32Array(NBAND + 1);
    for (let n = 0; n <= NBAND; n++) {
      const th = -Math.PI + (2 * Math.PI * n) / NBAND;
      const onApron = 1 - smooth(edge - 0.06, edge + 0.08, Math.abs(th));
      const body = Math.max(sample(F, F.r, th, y), sample(F, F.r, th, waistY)) + 0.009;
      r[n] = Math.max(body, onApron * (sample(F, C, th, y) + 0.003));
    }
    // a band under tension doesn't dip into the small of the back
    for (let pass = 0; pass < 2; pass++)
      for (let n = 0; n <= NBAND; n++) r[n] = Math.max(r[n], (r[(n + NBAND - 1) % NBAND] + r[n] * 2 + r[(n + 1) % NBAND]) / 4);
    const ids: number[] = [];
    for (let n = 0; n <= NBAND; n++) {
      const th = -Math.PI + (2 * Math.PI * n) / NBAND;
      pt.set(r[n] * Math.sin(th), y, r[n] * Math.cos(th));
      ids.push(cloth.vert(pt, ...tex(BD.u + (BD.w * n) / NBAND, BD.v + (dy > 0 ? BD.h : 0)), bandW[n]));
    }
    bandRows.push(ids);
  }
  for (let n = 0; n < NBAND; n++) cloth.quad(bandRows[0][n], bandRows[0][n + 1], bandRows[1][n + 1], bandRows[1][n], axis(waistY));

  // the knot at the small of the back, and the ties' two short ends hanging from it
  const backR = Math.max(sample(F, F.r, Math.PI, waistY), sample(F, F.r, Math.PI - 0.05, waistY), sample(F, F.r, -Math.PI + 0.05, waistY));
  const knot = new THREE.Vector3(0, waistY - 0.003, -(backR + 0.009 + 0.012));
  const knotW = legsToPelvis(Float32Array.from(bandW[0]));
  ellipsoid(cloth, knot, new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), [0.024, 0.017, 0.012], 0.25, AP.knot, APRON_TEX, knotW);
  const TI = AP.tie;
  for (const side of [-1, 1]) {
    const len = side < 0 ? 0.165 : 0.14;
    const spread = side * 0.24;
    const SEG = 6;
    const ids: number[][] = [];
    let r = backR + 0.02;
    for (let m = 0; m <= SEG; m++) {
      const l = (len * m) / SEG;
      const x0 = side * 0.008 + Math.sin(spread) * l;
      const y = waistY - 0.012 - Math.cos(spread) * l;
      const row: number[] = [];
      for (const across of [-1, 1]) {
        // across the tie: perpendicular to its run; the tip is cut on the slant
        const x = x0 + across * 0.014 * Math.cos(spread);
        const yy = y + across * 0.014 * Math.sin(spread) * -1 + (m === SEG ? across * side * 0.012 : 0);
        const th = Math.PI - Math.atan2(x, backR);
        r = Math.max(r, sample(F, F.r, th, yy) + 0.012);
        pt.set(x, yy, -Math.sqrt(Math.max(0, r * r - x * x)));
        F.weights(f, th, yy, 2, 2, wv);
        row.push(cloth.vert(pt, ...tex(TI.u + (side > 0 ? 0.22 : 0) + (TI.w * m) / SEG, TI.v + (across > 0 ? TI.h : 0)), legsToPelvis(wv)));
      }
      ids.push(row);
    }
    for (let m = 0; m < SEG; m++) cloth.quad(ids[m][0], ids[m + 1][0], ids[m + 1][1], ids[m][1], axis(waistY - 0.1));
  }

  lap('band');
  // the neck strap: sewn onto the bib's top corners (2.5 cm down them), round the back of the neck
  const ends = [1, -1].map((side) => {
    const s = side * (BB.top - STRAP_W / 2 - 0.004);
    const top = new THREE.Vector3();
    const low = new THREE.Vector3();
    const th = point(profile(topY), s, topY, top);
    point(profile(topY - 0.025), s, topY - 0.025, low);
    const out = new THREE.Vector3(Math.sin(th), 0, Math.cos(th));
    F.weights(f, th, topY, 3, 3, wv);
    return { low: low.addScaledVector(out, 0.003), top: top.addScaledVector(out, 0.003), w: wv.slice() };
  });
  neckStrap(f, cloth, ends, topY, marks);
  lap('strap');
  return { cloth, dyn };
}

const STRAP_W = 0.022;

interface StrapEnd {
  /** Where it's sewn on: the bib's top edge, and 2.5 cm below it (fit space, just proud of the bib). */
  top: THREE.Vector3;
  low: THREE.Vector3;
  w: Float32Array;
}

function neckStrap(f: Fit, cloth: Cloth, ends: StrapEnd[], topY: number, marks: Record<string, number>) {
  const nk = f.at('neck');
  const near = new Nearest(f, 0.03, (_x, y) => y > topY - 0.08);
  // the neck's radius just above its base, from the surface round it
  const radii: number[] = [];
  for (let i = 0; i < f.pos.length; i += 3) {
    if (Math.abs(f.pos[i + 1] - nk.y - 0.04) > 0.008) continue;
    const r = Math.hypot(f.pos[i] - nk.x, f.pos[i + 2] - nk.z);
    if (r < 0.1) radii.push(r);
  }
  radii.sort((a, b) => a - b);
  const inside = new THREE.Vector3();
  const rn = radii.length ? radii[Math.floor(radii.length / 2)] : 0.055;
  marks.neckRadius = rn;

  const W = STRAP_W;
  const SG = AP.strap;
  const [L, R] = ends;
  const key = [
    L.low,
    L.top,
    new THREE.Vector3(nk.x + rn + 0.012, nk.y - 0.004, nk.z + 0.012),
    new THREE.Vector3(nk.x + 0.72 * (rn + 0.008), nk.y + 0.006, nk.z - 0.72 * (rn + 0.008)),
    new THREE.Vector3(nk.x, nk.y + 0.014, nk.z - (rn + 0.006)),
    new THREE.Vector3(nk.x - 0.72 * (rn + 0.008), nk.y + 0.006, nk.z - 0.72 * (rn + 0.008)),
    new THREE.Vector3(nk.x - rn - 0.012, nk.y - 0.004, nk.z + 0.012),
    R.top,
    R.low,
  ];
  const curve = new THREE.CatmullRomCurve3(key, false, 'centripetal');
  const N = 40;
  const P = curve.getSpacedPoints(N);
  const total = curve.getLength();
  // distance along it from the nearer end: the first 2.5 cm are sewn on; then it leaves the bib's
  // 1.5 cm clearance and settles to 4 mm off the clothes over the next 6 cm
  const fromEnd = P.map((_, m) => Math.min(m, N - m) * (total / N));
  const pinned = (m: number) => fromEnd[m] < 0.025;
  const clear = (m: number) => 0.004 + 0.011 * (1 - smooth(0.025, 0.085, fromEnd[m]));
  const nrm = P.map(() => new THREE.Vector3(0, 0, 1));
  const tris = P.map(() => -1);
  const bary = P.map(() => [0, 0]);
  const below = (p: THREE.Vector3) => inside.set(nk.x, p.y - 0.15, nk.z);
  // The nearest surface can be the wrong one: a collar stands off the neck, and a point that starts
  // between them is pushed off the neck, under the collar. So the outermost surface round the neck
  // (a field like the scarf's, square to the neck) has the last word: nothing goes inside it.
  const ax = f.at('head').sub(nk).normalize();
  const lat = new THREE.Vector3(1, 0, 0).addScaledVector(ax, -ax.x).normalize();
  const neckToFit = new THREE.Matrix4().makeBasis(lat, ax, new THREE.Vector3().crossVectors(lat, ax)).setPosition(nk);
  const fitToNeck = neckToFit.clone().invert();
  const FN = new Field(48, -0.09, 0.005, 34);
  FN.raster(f, 0.02, 0.16, fitToNeck);
  const loc = new THREE.Vector3();
  const outside = (p: THREE.Vector3, gap: number) => {
    loc.copy(p).applyMatrix4(fitToNeck);
    const r = Math.hypot(loc.x, loc.z);
    if (r > 0.15 || r < 1e-4 || loc.y < FN.y0 || loc.y > FN.y(FN.ny - 1)) return;
    const need = sample(FN, FN.r, Math.atan2(loc.x, loc.z), loc.y) + gap;
    if (need <= r) return;
    loc.x *= need / r;
    loc.z *= need / r;
    p.copy(loc).applyMatrix4(neckToFit);
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let m = 0; m <= N; m++) {
      if (pinned(m)) continue;
      if (!near.find(P[m], below(P[m]))) continue;
      P[m].copy(near.point).addScaledVector(near.normal, clear(m));
      outside(P[m], clear(m));
      nrm[m].copy(near.normal);
      tris[m] = near.tri;
      bary[m] = [near.u, near.v];
    }
    if (pass === 3) break;
    const Q = P.map((p) => p.clone());
    for (let m = 1; m < N; m++) if (!pinned(m)) P[m].copy(Q[m - 1]).add(Q[m + 1]).addScaledVector(Q[m], 2).multiplyScalar(0.25);
  }
  // weights: the surface's under it, smoothed along it; at the ends, the bib corners'
  const wl = L.w;
  const wr = R.w;
  const W0 = P.map((_, m) => {
    const w = new Float32Array(NB);
    if (tris[m] >= 0) addTriWeights(f, tris[m], bary[m][0], bary[m][1], 1, w);
    else w.set(m < N / 2 ? wl : wr);
    return w;
  });
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const ids: number[][] = [];
  let len = 0;
  for (let m = 0; m <= N; m++) {
    if (m > 0) len += P[m].distanceTo(P[m - 1]);
    const w = new Float32Array(NB);
    let g = 0;
    for (let d = -3; d <= 3; d++) {
      const q = THREE.MathUtils.clamp(m + d, 0, N);
      w.forEach((_, s) => (w[s] += W0[q][s] * (4 - Math.abs(d))));
      g += 4 - Math.abs(d);
    }
    for (let s = 0; s < NB; s++) w[s] /= g;
    const end = m < N / 2 ? wl : wr;
    const toEnd = smooth(0.09, 0.0, Math.min(len, total - len));
    for (let s = 0; s < NB; s++) w[s] = w[s] * (1 - toEnd) + end[s] * toEnd;
    if (pinned(m)) nrm[m].set(P[m].x, 0, P[m].z).normalize();
    tan.subVectors(P[Math.min(N, m + 1)], P[Math.max(0, m - 1)]).normalize();
    side.crossVectors(nrm[m], tan).normalize();
    const row: number[] = [];
    for (const across of [-1, 1]) {
      pt0.copy(P[m]).addScaledVector(side, (across * W) / 2);
      // keep the edges off the body where it curves in under the strap
      if (!pinned(m) && near.find(pt0, below(pt0)) && near.point.distanceTo(pt0) < 0.003) pt0.copy(near.point).addScaledVector(near.normal, 0.003);
      if (!pinned(m)) outside(pt0, 0.003);
      row.push(cloth.vert(pt0, (SG.u + (SG.w * m) / N) / APRON_TEX, (SG.v + (across > 0 ? SG.h : 0)) / APRON_TEX, w));
    }
    ids.push(row);
  }
  for (let m = 0; m < N; m++) cloth.quad(ids[m][0], ids[m + 1][0], ids[m + 1][1], ids[m][1], below(P[m]).setY(P[m].y - 0.02));
}
const pt0 = new THREE.Vector3();

/** A small squashed, slightly twisted ellipsoid (a knot), in the frame (x, y, z) at c. */
function ellipsoid(
  cloth: Cloth,
  c: THREE.Vector3,
  x: THREE.Vector3,
  y: THREE.Vector3,
  z: THREE.Vector3,
  radii: [number, number, number],
  twist: number,
  uvRect: { u: number; v: number; w: number; h: number },
  texSize: number,
  w: ArrayLike<number>,
) {
  const LON = 8;
  const LAT = 6;
  const ids: number[][] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= LAT; j++) {
    const phi = (j / LAT) * Math.PI - Math.PI / 2;
    const row: number[] = [];
    for (let i = 0; i <= LON; i++) {
      const lam = (i / LON) * Math.PI * 2 + twist * Math.sin(phi * 2);
      const a = Math.cos(phi) * Math.cos(lam) * radii[0];
      const b = Math.sin(phi) * radii[1];
      // flat against the body behind it, rounder in front
      const d = Math.cos(phi) * Math.sin(lam) * radii[2];
      p.copy(c).addScaledVector(x, a).addScaledVector(y, b).addScaledVector(z, d < 0 ? d * 0.45 : d);
      row.push(cloth.vert(p, (uvRect.u + (uvRect.w * i) / LON) / texSize, (uvRect.v + (uvRect.h * j) / LAT) / texSize, w));
    }
    ids.push(row);
  }
  for (let j = 0; j < LAT; j++) for (let i = 0; i < LON; i++) cloth.quad(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i], c);
}

// ── the scarf ────────────────────────────────────────────────────────────────────────────────────

const SCARF_TEX = 0.5;
const SC = {
  ring: { u: 0.01, v: 0.01, w: 0.47, h: 0.08 },
  knot: { u: 0.01, v: 0.11, w: 0.08, h: 0.07 },
  flapA: { u: 0.11, v: 0.11, w: 0.17, h: 0.08 },
  flapB: { u: 0.3, v: 0.11, w: 0.17, h: 0.08 },
};
/** The ends' half-width along their length (0 at the knot, 1 at the tip), metres: gathered at the knot, then open. */
const flapHalf = (t: number) => 0.008 + 0.016 * smooth(0, 0.6, t);
/** Where an end's corner is cut on the slant: from the short edge at FLAP_CUT to the long edge's tip. */
const FLAP_CUT = 0.7;
/** An end's edges across it at t (`long` is +1 or −1: which edge runs to the tip): [low, high] offsets. */
function flapSpan(t: number, long: number): [number, number] {
  const h = flapHalf(t);
  const short = t <= FLAP_CUT ? -h : -h + (2 * h * (t - FLAP_CUT)) / (1 - FLAP_CUT);
  return long > 0 ? [short, h] : [-h, -short];
}
/** The width of texture an end's offset is drawn across (its rect's height covers ±FLAP_V). */
const FLAP_V = 0.035;

function buildScarf(f: Fit, marks: Record<string, number>, lap: (step: string) => void): Cloth {
  const nk = f.at('neck');
  const hd = f.at('head');
  // a frame up the neck: the neck leans forward, and the scarf goes round it square to it
  const ax = hd.clone().sub(nk).normalize();
  const lat = new THREE.Vector3(1, 0, 0).addScaledVector(ax, -ax.x).normalize();
  const fw = new THREE.Vector3().crossVectors(lat, ax);
  const neckToFit = new THREE.Matrix4().makeBasis(lat, ax, fw).setPosition(nk);
  const fitToNeck = neckToFit.clone().invert();
  const F = new Field(64, -0.07, 0.004, 44);
  F.raster(f, 0.02, 0.14, fitToNeck);
  lap('raster');

  // Where it sits: on the collar, low at the front (down at the notch between the collarbones) and
  // up on the collar behind, a band of folded silk about 2.5 cm deep, gathered into the knot at
  // the side. It follows the collar's slope (wider at its lower edge where the neck meets the
  // shoulders) and is pulled tight round it: no dents in plan.
  const H0 = 0.014;
  const TILT = -0.024;
  const KNOT = 1.0; // radians round from the front towards the left: tied at the side
  const NSEG = 40;
  const NJ = 5; // rows up the band, for its radius
  const NCS = 8; // round its cross-section
  const thick = 0.0026; // half the folded band's thickness
  const hc = (phi: number) => H0 + TILT * Math.cos(phi);
  const gap = (phi: number) => Math.abs(Math.atan2(Math.sin(phi - KNOT), Math.cos(phi - KNOT)));
  const hh = (phi: number) => (0.0125 + 0.0015 * Math.sin(3 * phi + 0.7)) * (0.6 + 0.4 * smooth(0.0, 0.7, gap(phi)));
  marks.neck = nk.y;
  marks.scarf = nk.y + H0;

  // the radius of each row (s from −1 at the lower edge to 1 at the top) round the neck
  const half = Math.PI / NSEG;
  const rows: Float32Array[] = [];
  for (let j = 0; j < NJ; j++) {
    const s = -1 + (2 * j) / (NJ - 1);
    const need = new Float32Array(NSEG);
    for (let n = 0; n < NSEG; n++) {
      const phi = -Math.PI + (2 * Math.PI * n) / NSEG;
      const h = hc(phi) + hh(phi) * s;
      need[n] = Math.max(sample(F, F.r, phi, h - 0.004), sample(F, F.r, phi, h), sample(F, F.r, phi, h + 0.004));
    }
    // gaps (nothing hit): the neighbours' mean
    for (let n = 0; n < NSEG; n++) if (need[n] <= 0) need[n] = (need[(n + NSEG - 1) % NSEG] + need[(n + 1) % NSEG]) / 2 || 0.06;
    for (let n = 0; n < NSEG; n++) need[n] += 0.003;
    const rc = need.slice();
    // a point inside the chord between its neighbours is lifted onto it; then smoothed, never pressed in
    for (let pass = 0; pass < 8; pass++)
      for (let n = 0; n < NSEG; n++) {
        const a = rc[(n + NSEG - 1) % NSEG];
        const b = rc[(n + 1) % NSEG];
        rc[n] = Math.max(rc[n], (2 * a * b * Math.cos(2 * half)) / (a + b));
      }
    for (let pass = 0; pass < 2; pass++)
      for (let n = 0; n < NSEG; n++) rc[n] = Math.max(need[n], (rc[(n + NSEG - 1) % NSEG] + 2 * rc[n] + rc[(n + 1) % NSEG]) / 4);
    rows.push(rc);
  }
  // a folded band doesn't bulge in and out up its depth: each row at least its neighbours' mean
  // less a little (so it can still flare out down the slope)
  for (let n = 0; n < NSEG; n++)
    for (let j = 1; j < NJ - 1; j++) rows[j][n] = Math.max(rows[j][n], (rows[j - 1][n] + rows[j + 1][n]) / 2 - 0.001);
  const radius = (n: number, s: number) => {
    const x = ((s + 1) / 2) * (NJ - 1);
    const j = Math.min(NJ - 2, Math.floor(x));
    return rows[j][n % NSEG] + (rows[j + 1][n % NSEG] - rows[j][n % NSEG]) * (x - j);
  };

  const cloth = new Cloth();
  const wv = new Float32Array(NB);
  const ringW: Float32Array[] = [];
  for (let n = 0; n <= NSEG; n++) {
    const phi = -Math.PI + (2 * Math.PI * n) / NSEG;
    F.weights(f, phi, hc(phi), 2, 3, wv);
    ringW.push(wv.slice());
  }
  for (let pass = 0; pass < 2; pass++)
    for (let n = 0; n < NSEG; n++) {
      const a = ringW[(n + NSEG - 1) % NSEG];
      const b = ringW[(n + 1) % NSEG];
      for (let s = 0; s < NB; s++) ringW[n][s] = (a[s] + 2 * ringW[n][s] + b[s]) / 4;
    }
  ringW[NSEG] = ringW[0];
  const local = new THREE.Vector3();
  const p = new THREE.Vector3();
  const ids: number[][] = [];
  for (let n = 0; n <= NSEG; n++) {
    const phi = -Math.PI + (2 * Math.PI * n) / NSEG;
    const row: number[] = [];
    for (let c = 0; c <= NCS; c++) {
      // round the band's cross-section: its inner face on the collar, its outer face 5 mm out
      const psi = (2 * Math.PI * c) / NCS;
      const s = Math.sin(psi);
      const out = radius(n, s) + thick * (1 + Math.cos(psi));
      local.set(out * Math.sin(phi), hc(phi) + hh(phi) * s, out * Math.cos(phi));
      p.copy(local).applyMatrix4(neckToFit);
      row.push(cloth.vert(p, (SC.ring.u + (SC.ring.w * n) / NSEG) / SCARF_TEX, (SC.ring.v + (SC.ring.h * c) / NCS) / SCARF_TEX, ringW[n]));
    }
    ids.push(row);
  }
  for (let n = 0; n < NSEG; n++) {
    const phi = -Math.PI + (2 * Math.PI * (n + 0.5)) / NSEG;
    const centre = new THREE.Vector3(0, hc(phi), 0).applyMatrix4(neckToFit);
    for (let c = 0; c < NCS; c++) cloth.quad(ids[n][c], ids[n + 1][c], ids[n + 1][c + 1], ids[n][c + 1], centre);
  }

  // the knot at the side
  const nK = Math.round(((KNOT + Math.PI) / (2 * Math.PI)) * NSEG) % NSEG;
  const rK = radius(nK, 0) + 2 * thick;
  const radial = new THREE.Vector3(Math.sin(KNOT), 0, Math.cos(KNOT));
  const along = new THREE.Vector3(Math.cos(KNOT), 0, -Math.sin(KNOT)); // round the neck, towards the back
  const kc = radial.clone().multiplyScalar(rK + 0.008).setY(hc(KNOT) - 0.003).applyMatrix4(neckToFit);
  const toFit = (v: THREE.Vector3) => v.clone().transformDirection(neckToFit);
  const knotW = ringW[nK];
  ellipsoid(cloth, kc, toFit(along), ax, toFit(radial), [0.017, 0.014, 0.0095], 0.35, SC.knot, SCARF_TEX, knotW);

  lap('ring');
  // its two ends out of the knot, lying on whatever is under them: one forward and down over the
  // collarbone, one back across the top of the shoulder; each cut off on the slant, as a square
  // scarf's corners are
  const near = new Nearest(f, 0.03, (_x, y) => y > nk.y - 0.22);
  const neckAxis = new THREE.Vector3();
  // (the nearest surface can be one a collar covers: the outermost round the neck has the last word)
  const loc = new THREE.Vector3();
  const outside = (q: THREE.Vector3, gap: number) => {
    loc.copy(q).applyMatrix4(fitToNeck);
    const r = Math.hypot(loc.x, loc.z);
    if (r > 0.135 || r < 1e-4 || loc.y < F.y0 || loc.y > F.y(F.ny - 1)) return;
    const need = sample(F, F.r, Math.atan2(loc.x, loc.z), loc.y) + gap;
    if (need <= r) return;
    loc.x *= need / r;
    loc.z *= need / r;
    q.copy(loc).applyMatrix4(neckToFit);
  };
  const sideV = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  // (directions: down, round the neck towards the back, and out from it)
  for (const [down, back, out, len, rect, long] of [
    [0.8, -0.7, 0.15, 0.11, SC.flapA, 1],
    [0.45, 0.55, 0.45, 0.09, SC.flapB, -1],
  ] as const) {
    const d = toFit(new THREE.Vector3(0, -down, 0).addScaledVector(along, back).addScaledVector(radial, out)).normalize();
    const ROWS = 8;
    const strip: number[][] = [];
    const c = kc.clone();
    let prevW: Float32Array = knotW;
    for (let m = 0; m <= ROWS; m++) {
      const t = m / ROWS;
      if (m > 0) c.addScaledVector(d, len / ROWS);
      neckAxis.copy(nk).setY(c.y - 0.1);
      nrm.copy(radialFit(c, nk));
      const lift = 0.008 + 0.004 * t;
      if (m > 0 && near.find(c, neckAxis)) {
        c.copy(near.point).addScaledVector(near.normal, lift);
        outside(c, lift);
        nrm.copy(near.normal);
        const w = new Float32Array(NB);
        addTriWeights(f, near.tri, near.u, near.v, 1, w);
        prevW = w;
      }
      const w = new Float32Array(NB);
      const mix = 0.65 * t;
      for (let s = 0; s < NB; s++) w[s] = knotW[s] * (1 - mix) + prevW[s] * mix;
      sideV.crossVectors(nrm, d).normalize();
      const [lo, hi] = flapSpan(t, long);
      const row: number[] = [];
      for (const off of [lo, (lo + hi) / 2, hi]) {
        // a soft ridge down the middle where the silk folds, and the edges kept off the clothes
        p.copy(c).addScaledVector(sideV, off).addScaledVector(nrm, off === lo || off === hi ? 0 : 0.003 * ((hi - lo) / (2 * flapHalf(t))));
        if (m > 0 && near.find(p, neckAxis) && near.point.distanceTo(p) < 0.004) p.copy(near.point).addScaledVector(near.normal, 0.004);
        if (m > 0) outside(p, 0.004);
        row.push(cloth.vert(p, (rect.u + rect.w * t) / SCARF_TEX, (rect.v + rect.h / 2 + (off * rect.h) / (2 * FLAP_V)) / SCARF_TEX, w));
      }
      strip.push(row);
    }
    for (let m = 0; m < ROWS; m++) {
      const inside = qd.copy(nk).setY(cloth.p(strip[m][1], qb).y - 0.1).clone();
      cloth.quad(strip[m][0], strip[m + 1][0], strip[m + 1][1], strip[m][1], inside);
      cloth.quad(strip[m][1], strip[m + 1][1], strip[m + 1][2], strip[m][2], inside);
    }
  }
  lap('flaps');
  return cloth;
}

/** Outward from the neck's axis at that height (a fallback normal). */
function radialFit(p: THREE.Vector3, nk: THREE.Vector3) {
  return new THREE.Vector3(p.x - nk.x, 0.3, p.z - nk.z).normalize();
}

// ── cloth textures and materials ─────────────────────────────────────────────────────────────────

const textures = new Map<string, THREE.CanvasTexture>();

/** A cheap repeatable hash noise in [0, 1). */
function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A small canvas of grey noise round mid grey (±amp of 255); `chequer` makes it a 2×2 weave instead. */
function greyNoise(w: number, h: number, seed: number, amp: number, chequer = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = chequer ? ((x + y) & 1 ? 150 : 106) : 128 + (hash(x + seed * 1013, y - seed * 917) - 0.5) * 2 * amp;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** Cotton canvas in the apron's colour, its pieces laid out as AP says, with their stitching. */
function apronTexture(colour: string, accent: string | undefined): THREE.CanvasTexture {
  const key = `apron|${colour}|${accent ?? ''}`;
  const cached = textures.get(key);
  if (cached) return cached;
  const S = 512;
  const px = S / APRON_TEX;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const base = new THREE.Color(colour);
  g.fillStyle = colour;
  g.fillRect(0, 0, S, S);
  // grey noise laid over in 'overlay' (mid grey leaves the colour alone): soft mottling, slubs along
  // the warp and the weft (noise stretched one way), the plain weave's chequer, and fine grain
  g.globalCompositeOperation = 'overlay';
  g.imageSmoothingEnabled = true;
  const layer = (src: HTMLCanvasElement, alpha: number, repeat: boolean) => {
    g.globalAlpha = alpha;
    if (repeat) {
      g.fillStyle = g.createPattern(src, 'repeat')!;
      g.fillRect(0, 0, S, S);
    } else g.drawImage(src, 0, 0, S, S);
  };
  layer(greyNoise(10, 10, 1, 40), 0.3, false);
  layer(greyNoise(24, 256, 2, 60), 0.22, false);
  layer(greyNoise(256, 24, 3, 60), 0.18, false);
  layer(greyNoise(2, 2, 0, 0, true), 0.25, true);
  layer(greyNoise(64, 64, 4, 50), 0.3, true);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  const thread = accent ?? '#' + base.clone().lerp(new THREE.Color('#ffffff'), 0.5).getHexString();
  // canvas y runs down; texture v runs up
  const X = (u: number) => u * px;
  const Y = (v: number) => S - v * px;
  const stitch = (pts: [number, number][], closed = false) => {
    g.save();
    g.strokeStyle = thread;
    g.globalAlpha = 0.85;
    g.lineWidth = 1.3;
    g.setLineDash([2.6, 1.6]);
    g.beginPath();
    pts.forEach(([u, v], i) => (i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v))));
    if (closed) g.closePath();
    g.stroke();
    g.restore();
  };
  const fold = (pts: [number, number][], width: number) => {
    // the hem's turned-over edge, a shade darker
    g.save();
    g.strokeStyle = 'rgba(0,0,0,0.10)';
    g.lineWidth = width * px;
    g.beginPath();
    pts.forEach(([u, v], i) => (i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v))));
    g.stroke();
    g.restore();
  };
  const I = 0.008; // stitching 8 mm in from an edge
  const sk = AP.skirt;
  const cx = sk.u + sk.w / 2;
  const skirtEdge = (inset: number): [number, number][] => [
    [cx - sk.top + inset, sk.v + sk.h],
    [cx - sk.hem + inset, sk.v + inset],
    [cx + sk.hem - inset, sk.v + inset],
    [cx + sk.top - inset, sk.v + sk.h],
  ];
  fold(skirtEdge(0), 0.03);
  stitch(skirtEdge(I));
  stitch(skirtEdge(I + 0.004));
  const bb = AP.bib;
  const bx = bb.u + bb.w / 2;
  const bibEdge = (inset: number): [number, number][] => [
    [bx - bb.bottom + inset, bb.v],
    [bx - bb.top + inset, bb.v + bb.h - inset],
    [bx + bb.top - inset, bb.v + bb.h - inset],
    [bx + bb.bottom - inset, bb.v],
  ];
  fold(bibEdge(0), 0.03);
  stitch(bibEdge(I));
  const pk = AP.pocket;
  const pocketEdge = (inset: number): [number, number][] => [
    [pk.u + inset, pk.v + pk.h],
    [pk.u + inset, pk.v + inset],
    [pk.u + pk.w - inset, pk.v + inset],
    [pk.u + pk.w - inset, pk.v + pk.h],
  ];
  // the pocket's top hem, a shadow along its open edge, and its divider
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(X(pk.u), Y(pk.v + pk.h), pk.w * px, 0.022 * px);
  fold(pocketEdge(0), 0.012);
  stitch(pocketEdge(0.006));
  stitch([[pk.u, pk.v + pk.h - 0.016], [pk.u + pk.w, pk.v + pk.h - 0.016]]);
  stitch([[pk.u + pk.w / 2, pk.v + 0.006], [pk.u + pk.w / 2, pk.v + pk.h - 0.016]]);
  // the band, the strap and the ties: stitched along both edges
  for (const rect of [AP.band, AP.strap, { ...AP.tie, w: 0.42 }]) {
    stitch([[rect.u, rect.v + 0.004], [rect.u + rect.w, rect.v + 0.004]]);
    stitch([[rect.u, rect.v + rect.h - 0.004], [rect.u + rect.w, rect.v + rect.h - 0.004]]);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textures.set(key, tex);
  return tex;
}

/**
 * Silk twill in the scarf's colour with a fine diamond lattice (navy, with thin red lines
 * between), a navy border along the folded band's edges, and the ends' rolled hems.
 */
function scarfTexture(colour: string, accent: string | undefined): THREE.CanvasTexture {
  const key = `scarf|${colour}|${accent ?? ''}`;
  const cached = textures.get(key);
  if (cached) return cached;
  const S = 512;
  const px = S / SCARF_TEX;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const navy = '#1d1238';
  const red = accent ?? '#c8233f';
  g.fillStyle = colour;
  g.fillRect(0, 0, S, S);
  // the twill's fine diagonal grain, and a soft sheen across the silk
  g.globalAlpha = 0.07;
  g.strokeStyle = '#000';
  g.lineWidth = 1;
  g.beginPath();
  for (let k = -S; k < S; k += 3) {
    g.moveTo(k, S);
    g.lineTo(k + S, 0);
  }
  g.stroke();
  g.globalAlpha = 1;
  const sheen = g.createLinearGradient(0, 0, S, S);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(120,70,0,0.10)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, S, S);
  // the print: a diamond lattice every 3 cm, navy 1.5 mm with a thin red line halfway between. A
  // stripe one way round would spiral down the twisted band and read as a gold rope from a few
  // metres; crossing lines read as a print on the silk from any side.
  const step = 0.03 * px;
  for (const [offset, width, col] of [[0, 1.6, navy], [step / 2, 0.9, red]] as const) {
    g.strokeStyle = col;
    g.lineWidth = width;
    g.beginPath();
    for (let k = -S; k < S; k += step) {
      g.moveTo(k + offset, 0);
      g.lineTo(k + offset + S, S);
      g.moveTo(k + offset, S);
      g.lineTo(k + offset + S, 0);
    }
    g.stroke();
  }
  // the band's edges (a quarter and three quarters round its cross-section)
  g.fillStyle = navy;
  for (const at of [0.25, 0.75]) g.fillRect(SC.ring.u * px, S - (SC.ring.v + SC.ring.h * at) * px - 1.5, SC.ring.w * px, 3);
  // the ends' rolled hems, round their outline (flapSpan)
  for (const [rect, long] of [[SC.flapA, 1], [SC.flapB, -1]] as const) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 20; i++) pts.push([i / 20, flapSpan(i / 20, long)[1]]);
    for (let i = 20; i >= 0; i--) pts.push([i / 20, flapSpan(i / 20, long)[0]]);
    const toXY = ([t, o]: [number, number]): [number, number] => [(rect.u + rect.w * t) * px, S - (rect.v + rect.h / 2 + (o * rect.h) / (2 * FLAP_V)) * px];
    for (const [col, w] of [[navy, 7], [red, 2]] as const) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.lineJoin = 'round';
      g.beginPath();
      pts.forEach((q, i) => {
        const [x, y] = toXY(q);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textures.set(key, tex);
  return tex;
}

/** Double-sided cloth whose inside (back faces) is a shade darker, as the underside of fabric is in its own shadow. */
function clothMaterial(kind: GarmentKind, map: THREE.Texture, swing?: SwingUniforms): THREE.MeshStandardMaterial {
  const silk = kind === 'scarf';
  const mat = new THREE.MeshStandardMaterial({ map, roughness: silk ? 0.5 : 0.86, metalness: 0, side: THREE.DoubleSide });
  mat.name = `garment-${kind}`;
  const inside = silk ? '0.82' : '0.74';
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n  if ( ! gl_FrontFacing ) diffuseColor.rgb *= ${inside};`);
    if (swing) swingShader(shader, swing);
  };
  mat.customProgramCacheKey = () => `garment-${kind}${swing ? '-swing' : ''}`;
  return mat;
}

interface SwingUniforms {
  /**
   * The skirt's swing as bone matrices (the pelvis's world matrix, the turn, the pelvis's inverse
   * bind), one for each half: both turn forward about the hip line, and each half also out with its
   * own thigh when that thigh lifts sideways. uSkirtL/R turn with all of the leading thigh's swing
   * (cloth lying against the thighs); uSkirtClearL/R with what's left of it once it has crossed the
   * skirt's widest gap (Dynamic.gap). A vertex mixes the two by its own share of that gap.
   */
  uSkirtL: { value: THREE.Matrix4 };
  uSkirtR: { value: THREE.Matrix4 };
  uSkirtClearL: { value: THREE.Matrix4 };
  uSkirtClearR: { value: THREE.Matrix4 };
  /** 0 standing … 1 seated. */
  uSkirtSeated: { value: number };
}

/**
 * Skinning for the skirt. garmentSkirt: x = k, y = the pelvis's share of the rest (the spine has
 * the remainder), z = how far round the front it is (1 at the front, 0 at the sides), w = 1 + how
 * far it's on the left half (0…1); w is 0 for everything else, which skins as usual. garmentClear:
 * the vertex's share of the gap before a knee reaches it (Dynamic.clear). Standing, a skirt vertex
 * mixes the pelvis and spine (by 1 − k) with the swing matrices (by k). Seated it takes the body's
 * own weights (skinWeight: thighs, pelvis, spine) with the swing standing in for both thighs, so
 * the lap is one sheet over the two of them however they cross and folds at the hip crease as the
 * body does; at the sides the thighs' share goes to the pelvis, so the sides hang down beside the
 * thighs instead of sticking out level with the lap. (A lap lies on the thighs: no gap.)
 */
function swingShader(shader: THREE.WebGLProgramParametersWithUniforms, u: SwingUniforms) {
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
      uniform mat4 uSkirtL;
      uniform mat4 uSkirtR;
      uniform mat4 uSkirtClearL;
      uniform mat4 uSkirtClearR;
      uniform float uSkirtSeated;
      attribute vec4 garmentSkirt;
      attribute float garmentClear;`,
    )
    .replace(
      '#include <skinbase_vertex>',
      /* glsl */ `#include <skinbase_vertex>
      #ifdef USE_SKINNING
        vec4 skirtW = skinWeight;
        mat4 skirtM = mat4( 0.0 );
        if ( garmentSkirt.w > 0.5 ) {
          float lap = ( skinWeight.x + skinWeight.y ) * garmentSkirt.z;
          vec4 stand = vec4( 0.0, 0.0, garmentSkirt.y, 1.0 - garmentSkirt.y ) * ( 1.0 - garmentSkirt.x );
          vec4 seat = vec4( 0.0, 0.0, skinWeight.z + skinWeight.x + skinWeight.y - lap, skinWeight.w );
          skirtW = mix( stand, seat, uSkirtSeated );
          float legs = mix( garmentSkirt.x, lap, uSkirtSeated );
          float side = garmentSkirt.w - 1.0;
          mat4 pushed = uSkirtR * ( 1.0 - side ) + uSkirtL * side;
          mat4 clear = uSkirtClearR * ( 1.0 - side ) + uSkirtClearL * side;
          skirtM = ( pushed + ( clear - pushed ) * ( garmentClear * ( 1.0 - uSkirtSeated ) ) ) * legs;
        }
      #endif`,
    )
    .replace(
      '#include <skinnormal_vertex>',
      /* glsl */ `#ifdef USE_SKINNING
        mat4 skinMatrix = skirtW.x * boneMatX + skirtW.y * boneMatY + skirtW.z * boneMatZ + skirtW.w * boneMatW + skirtM;
        skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
        objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
      #endif`,
    )
    .replace(
      '#include <skinning_vertex>',
      /* glsl */ `#ifdef USE_SKINNING
        vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
        vec4 skinned = ( skirtW.x * boneMatX + skirtW.y * boneMatY + skirtW.z * boneMatZ + skirtW.w * boneMatW + skirtM ) * skinVertex;
        transformed = ( bindMatrixInverse * skinned ).xyz;
      #endif`,
    );
}

/** A shadow material that skins the skirt the same way. */
function swingDepth<M extends THREE.MeshDepthMaterial | THREE.MeshDistanceMaterial>(mat: M, u: SwingUniforms): M {
  mat.onBeforeCompile = (shader) => swingShader(shader, u);
  mat.customProgramCacheKey = () => 'garment-swing';
  return mat;
}

// ── the garment mesh ─────────────────────────────────────────────────────────────────────────────

/**
 * Makes a garment for this person, fitted to their body in its bind pose and skinned to its skeleton
 * (body.skeleton, body.bindMatrix). Add it beside the body (same parent, same local transform).
 */
export function buildGarment(kind: GarmentKind, body: THREE.SkinnedMesh, opts: GarmentOptions): THREE.SkinnedMesh {
  const t0 = performance.now();
  let t = t0;
  const steps: Record<string, number> = {};
  const lap = (name: string) => {
    const now = performance.now();
    steps[name] = now - t;
    t = now;
  };
  const f = fitBody(body, opts.spec);
  lap('fit');
  const marks: Record<string, number> = {};
  let cloth: Cloth;
  let dyn: Dynamic | null = null;
  if (kind === 'apron') ({ cloth, dyn } = buildApron(f, marks, lap));
  else cloth = buildScarf(f, marks, lap);
  const map = kind === 'apron' ? apronTexture(opts.colour, opts.accent) : scarfTexture(opts.colour, opts.accent);
  lap('texture');

  // into the body geometry's own space; normals worked out in metres first
  const geo = new THREE.BufferGeometry();
  const P = new Float32Array(cloth.pos);
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setIndex(cloth.index);
  geo.computeVertexNormals();
  const N = geo.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < cloth.count; i++) {
    v.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(f.fromFit);
    geo.attributes.position.setXYZ(i, v.x, v.y, v.z);
    v.fromBufferAttribute(N, i).applyMatrix3(f.normalFromFit).normalize();
    N.setXYZ(i, v.x, v.y, v.z);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cloth.uv), 2));
  const si = new Uint16Array(cloth.count * 4);
  const sw = new Float32Array(cloth.count * 4);
  for (let i = 0; i < cloth.count; i++) top4(f, cloth.w, i * NB, si, sw, i * 4);
  const swing = dyn ? skirtSwing(f, dyn, cloth.pos, si, sw, geo) : null;
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new THREE.SkinnedMesh(geo, clothMaterial(kind, map, swing?.uniforms));
  mesh.name = `garment-${kind}`;
  mesh.bind(body.skeleton, body.bindMatrix);
  mesh.bindMode = body.bindMode;
  mesh.position.copy(body.position);
  mesh.quaternion.copy(body.quaternion);
  mesh.scale.copy(body.scale);
  mesh.castShadow = body.castShadow;
  mesh.receiveShadow = body.receiveShadow;
  mesh.frustumCulled = body.frustumCulled;
  if (swing) {
    // its shadow swings too (point lights' as well as the sun's)
    mesh.customDepthMaterial = swingDepth(new THREE.MeshDepthMaterial(), swing.uniforms);
    mesh.customDistanceMaterial = swingDepth(new THREE.MeshDistanceMaterial(), swing.uniforms);
    mesh.onBeforeRender = swing.update;
    mesh.onBeforeShadow = swing.update;
  }

  lap('mesh');
  const info: GarmentInfo = { kind, triangles: cloth.index.length / 3, ms: performance.now() - t0, steps, marks, colour: opts.colour, accent: opts.accent };
  mesh.userData.garment = info;
  return mesh;
}

/**
 * Dyes a garment another colour in place: only its texture changes (drawn once per colour and
 * shared), so the fit, the material and its compiled program stay as they are.
 */
export function recolourGarment(mesh: THREE.SkinnedMesh, colour: string, accent?: string) {
  const info = mesh.userData.garment as GarmentInfo;
  if (info.colour === colour && info.accent === accent) return;
  (mesh.material as THREE.MeshStandardMaterial).map = info.kind === 'apron' ? apronTexture(colour, accent) : scarfTexture(colour, accent);
  info.colour = colour;
  info.accent = accent;
}

/** Frees a garment's geometry and material (its texture is shared by every garment of that colour, and kept). */
export function disposeGarment(mesh: THREE.SkinnedMesh) {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  mesh.customDepthMaterial?.dispose();
  mesh.customDistanceMaterial?.dispose();
  mesh.onBeforeRender = mesh.onBeforeShadow = () => {};
}

/**
 * The skirt's swing (see the header). Its vertices skin to [thighL, thighR, pelvis, spine] with the
 * body's own weights (used seated) and carry their standing mix in a garmentSkirt attribute; update
 * sets the uniforms from the thighs, just before the apron or its shadow is drawn. `pos` is the
 * cloth in fit space (x the person's left), for which half each vertex is on.
 */
function skirtSwing(f: Fit, dyn: Dynamic, pos: ArrayLike<number>, si: Uint16Array, sw: Float32Array, geo: THREE.BufferGeometry) {
  const bones = f.skeleton.bones;
  const pelvis = bones[f.index[S_PELVIS]];
  const pelvisInverse = f.skeleton.boneInverses[f.index[S_PELVIS]];
  const thighs = [bones[f.index[S_THIGH_L]], bones[f.index[S_THIGH_R]]];
  const calves = [bones[f.index[S_CALF_L]], bones[f.index[S_CALF_R]]];
  const up = f.pelvisUp.clone().normalize();
  const fwd = f.pelvisFwd.clone().normalize();
  // (fwd = left × up, so swinging forward is a negative turn about the left axis, and a positive
  // turn about fwd takes a leg out to the left)
  const left = new THREE.Vector3().crossVectors(up, fwd).normalize();
  const SIGN = [1, -1];
  const swingOf = (d: THREE.Vector3) => Math.atan2(d.dot(fwd), -d.dot(up));
  const liftOf = (d: THREE.Vector3, s: number) => Math.asin(THREE.MathUtils.clamp((SIGN[s] * d.dot(left)) / d.length(), -1, 1));
  const restLeg = [f.restPelvis('calfL').sub(f.restPelvis('thighL')), f.restPelvis('calfR').sub(f.restPelvis('thighR'))];
  const rest = restLeg.map(swingOf);
  const restLift = restLeg.map(liftOf);
  const slots = [f.index[S_THIGH_L], f.index[S_THIGH_R], f.index[S_PELVIS], f.index[S_SPINE]];
  const mix = new Float32Array(geo.attributes.position.count * 4);
  for (let i = 0; i < dyn.count; i++) {
    const v = dyn.start + i;
    for (let c = 0; c < 4; c++) {
      si[v * 4 + c] = slots[c];
      sw[v * 4 + c] = dyn.seat[i * 4 + c];
    }
    const round = Math.abs(Math.atan2(pos[v * 3], pos[v * 3 + 2]));
    mix.set([dyn.k[i], dyn.stand[i * 2], smooth(1.2, 0.7, round), 1 + smooth(-0.1, 0.1, pos[v * 3])], v * 4);
  }
  geo.setAttribute('garmentSkirt', new THREE.BufferAttribute(mix, 4));
  const clear = new Float32Array(geo.attributes.position.count);
  clear.set(dyn.clear, dyn.start);
  geo.setAttribute('garmentClear', new THREE.BufferAttribute(clear, 1));

  const m4 = () => ({ value: new THREE.Matrix4() });
  const uniforms: SwingUniforms = { uSkirtL: m4(), uSkirtR: m4(), uSkirtClearL: m4(), uSkirtClearR: m4(), uSkirtSeated: { value: 0 } };
  const inv = new THREE.Matrix4();
  const turn = new THREE.Matrix4();
  const out = new THREE.Matrix4();
  const mid = new THREE.Vector3();
  const hips = [new THREE.Vector3(), new THREE.Vector3()];
  const a = new THREE.Vector3();
  const flex = [0, 0];
  const lift = [0, 0];
  /** m = a turn by `angle` about `axis` through `at`. */
  const about = (m: THREE.Matrix4, axis: THREE.Vector3, angle: number, at: THREE.Vector3) => {
    m.makeRotationAxis(axis, angle);
    a.copy(at).applyMatrix4(m);
    return m.setPosition(a.subVectors(at, a));
  };
  /** The leading of two swings: a soft max, so the hand-over from one thigh to the other is smooth. */
  const leading = (x: number, y: number) => {
    const lead = 1 / (1 + Math.exp(-(x - y) / 0.05));
    return Math.max(-0.05, lead * x + (1 - lead) * y);
  };
  /** A thigh's swing once it has crossed the gap (backwards it goes at once). */
  const pastGap = (x: number) => x - THREE.MathUtils.clamp(x, 0, dyn.gap);
  /** The pair of matrices that turn the skirt forward by `angle`, each half out with its own thigh. */
  const swing = (angle: number, L: THREE.Matrix4, R: THREE.Matrix4) => {
    // forward about the line through the hip joints (where they are now, in the pelvis's space),
    // after each half has gone out with its own thigh, about that hip joint
    about(turn, left, -angle, mid.addVectors(hips[0], hips[1]).multiplyScalar(0.5)).premultiply(pelvis.matrixWorld);
    for (let s = 0; s < 2; s++) (s === 0 ? L : R).copy(about(out, fwd, SIGN[s] * lift[s], hips[s]).premultiply(turn).multiply(pelvisInverse));
  };
  const update = () => {
    inv.copy(pelvis.matrixWorld).invert();
    for (let s = 0; s < 2; s++) {
      hips[s].setFromMatrixPosition(thighs[s].matrixWorld).applyMatrix4(inv);
      a.setFromMatrixPosition(calves[s].matrixWorld).applyMatrix4(inv).sub(hips[s]);
      flex[s] = swingOf(a) - rest[s];
      lift[s] = Math.max(0, liftOf(a, s) - restLift[s]);
    }
    // how far into a sit both thighs are
    uniforms.uSkirtSeated.value = smooth(0.65, 1.15, Math.min(flex[0], flex[1]));
    swing(leading(flex[0], flex[1]), uniforms.uSkirtL.value, uniforms.uSkirtR.value);
    swing(leading(pastGap(flex[0]), pastGap(flex[1])), uniforms.uSkirtClearL.value, uniforms.uSkirtClearR.value);
  };
  return { uniforms, update };
}
