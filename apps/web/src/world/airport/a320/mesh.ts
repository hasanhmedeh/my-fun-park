// Collects the whole airframe into one skinned BufferGeometry: every vertex is bound rigidly to
// one bone (a moving part: a flap, a gear leg, a door…), so the aircraft draws as a single mesh
// and its parts move in the vertex shader. Surfaces come in as grids (lofts, lathes), as Three's
// primitive geometries, or as flat caps; UVs point into the texture atlas (atlas.ts).

import * as THREE from 'three';
import type { UV } from './atlas';

export type Vec = [number, number, number];
type UvFn = (r: number, c: number, x: number, y: number, z: number) => UV;

export interface GridOptions {
  bone: number;
  uv: UvFn | UV;
  /** The last column repeats the first (a closed ring): normals look across the seam. */
  wrap?: boolean;
  /** Normals point away from this point for each row (default), or `sign` flips the computed ones. */
  ref?: (r: number) => Vec;
  sign?: 1 | -1;
  /** Faceted (per-triangle) shading instead of smooth: for flat plates. */
  flat?: boolean;
  /** Skip a quad (r, c is its first corner). */
  skip?: (r: number, c: number) => boolean;
  /** Transform applied to positions and normals after they're computed (e.g. the inverse of a part's motion). */
  matrix?: THREE.Matrix4;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

export class SkinBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uvs: number[] = [];
  private bones: number[] = [];
  private idx: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  private vertex(p: Vec | THREE.Vector3, n: Vec | THREE.Vector3, uv: UV, bone: number) {
    if (Array.isArray(p)) this.pos.push(p[0], p[1], p[2]);
    else this.pos.push(p.x, p.y, p.z);
    if (Array.isArray(n)) this.nor.push(n[0], n[1], n[2]);
    else this.nor.push(n.x, n.y, n.z);
    this.uvs.push(uv[0], uv[1]);
    this.bones.push(bone);
    return this.pos.length / 3 - 1;
  }

  /** A triangle, wound so that its face agrees with the (average) vertex normal. */
  private tri(a: number, b: number, c: number) {
    const P = this.pos;
    const N = this.nor;
    const ux = P[b * 3] - P[a * 3];
    const uy = P[b * 3 + 1] - P[a * 3 + 1];
    const uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3];
    const vy = P[c * 3 + 1] - P[a * 3 + 1];
    const vz = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const nx = N[a * 3] + N[b * 3] + N[c * 3];
    const ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (fx * nx + fy * ny + fz * nz < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }

  /**
   * A grid surface of rows × cols points (row-major [x, y, z] triples). Normals come from the
   * neighbouring points (central differences), so lofts shade smoothly and seams match.
   */
  grid(P: Vec[], rows: number, cols: number, o: GridOptions) {
    const at = (r: number, c: number) => P[r * cols + c];
    const normal = (r: number, c: number): Vec => {
      const cw = o.wrap ? cols - 1 : cols;
      const cm = o.wrap ? at(r, (c - 1 + cw) % cw) : at(r, Math.max(0, c - 1));
      const cp = o.wrap ? at(r, (c + 1) % cw) : at(r, Math.min(cols - 1, c + 1));
      const rm = at(Math.max(0, r - 1), c);
      const rp = at(Math.min(rows - 1, r + 1), c);
      const ax = cp[0] - cm[0];
      const ay = cp[1] - cm[1];
      const az = cp[2] - cm[2];
      const bx = rp[0] - rm[0];
      const by = rp[1] - rm[1];
      const bz = rp[2] - rm[2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      let l = Math.hypot(nx, ny, nz);
      const p = at(r, c);
      const ref = o.ref?.(r);
      if (l < 1e-9) {
        // a pole (a ring shrunk to a point): point away from the reference, or along the rows
        if (ref) [nx, ny, nz] = [p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]];
        else [nx, ny, nz] = [rm[0] - rp[0], rm[1] - rp[1], rm[2] - rp[2]];
        l = Math.hypot(nx, ny, nz) || 1;
      }
      nx /= l;
      ny /= l;
      nz /= l;
      let flip = o.sign ?? 1;
      if (ref && (p[0] - ref[0]) * nx + (p[1] - ref[1]) * ny + (p[2] - ref[2]) * nz < 0) flip = -flip as 1 | -1;
      return [nx * flip, ny * flip, nz * flip];
    };
    const uvAt = (r: number, c: number): UV => (typeof o.uv === 'function' ? o.uv(r, c, ...at(r, c)) : o.uv);
    const m = o.matrix;
    if (m) _m3.getNormalMatrix(m);
    const emit = (r: number, c: number, n: Vec) => {
      const p = at(r, c);
      if (!m) return this.vertex(p, n, uvAt(r, c), o.bone);
      _v.set(p[0], p[1], p[2]).applyMatrix4(m);
      _n.set(n[0], n[1], n[2]).applyMatrix3(_m3).normalize();
      return this.vertex(_v, _n, uvAt(r, c), o.bone);
    };
    if (o.flat) {
      for (let r = 0; r < rows - 1; r++)
        for (let c = 0; c < cols - 1; c++) {
          if (o.skip?.(r, c)) continue;
          const q = [at(r, c), at(r + 1, c), at(r, c + 1), at(r + 1, c + 1)];
          const ux = q[1][0] - q[0][0], uy = q[1][1] - q[0][1], uz = q[1][2] - q[0][2];
          const vx = q[2][0] - q[0][0], vy = q[2][1] - q[0][1], vz = q[2][2] - q[0][2];
          let n: Vec = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
          const l = Math.hypot(...n) || 1;
          n = [n[0] / l, n[1] / l, n[2] / l];
          const ref = o.ref?.(r);
          const s = o.sign ?? 1;
          let f: number = s;
          if (ref && (q[0][0] - ref[0]) * n[0] + (q[0][1] - ref[1]) * n[1] + (q[0][2] - ref[2]) * n[2] < 0) f = -s;
          n = [n[0] * f, n[1] * f, n[2] * f];
          const a = emit(r, c, n);
          const b = emit(r + 1, c, n);
          const cc = emit(r, c + 1, n);
          const d = emit(r + 1, c + 1, n);
          this.tri(a, b, cc);
          this.tri(b, d, cc);
        }
      return;
    }
    const index = new Int32Array(rows * cols).fill(-1);
    const vid = (r: number, c: number) => {
      const k = r * cols + c;
      if (index[k] < 0) index[k] = emit(r, c, normal(r, c));
      return index[k];
    };
    for (let r = 0; r < rows - 1; r++)
      for (let c = 0; c < cols - 1; c++) {
        if (o.skip?.(r, c)) continue;
        const a = vid(r, c);
        const b = vid(r + 1, c);
        const cc = vid(r, c + 1);
        const d = vid(r + 1, c + 1);
        // degenerate triangles at poles are dropped
        if (!same(at(r, c), at(r + 1, c)) && !same(at(r, c), at(r, c + 1))) this.tri(a, b, cc);
        if (!same(at(r + 1, c), at(r + 1, c + 1)) && !same(at(r, c + 1), at(r + 1, c + 1))) this.tri(b, d, cc);
      }
  }

  /** A Three.js geometry (any primitive), moved by `m`, all of it bound to one bone. */
  geometry(g: THREE.BufferGeometry, m: THREE.Matrix4 | null, bone: number, uv: UV | ((p: THREE.Vector3, n: THREE.Vector3) => UV)) {
    const src = g;
    const p = src.getAttribute('position') as THREE.BufferAttribute;
    if (!src.getAttribute('normal')) src.computeVertexNormals();
    const n = src.getAttribute('normal') as THREE.BufferAttribute;
    if (m) _m3.getNormalMatrix(m);
    const base = this.vertexCount;
    for (let i = 0; i < p.count; i++) {
      const pv = new THREE.Vector3().fromBufferAttribute(p, i);
      const nv = new THREE.Vector3().fromBufferAttribute(n, i);
      if (m) {
        pv.applyMatrix4(m);
        nv.applyMatrix3(_m3).normalize();
      }
      this.vertex(pv, nv, typeof uv === 'function' ? uv(pv, nv) : uv, bone);
    }
    if (src.index) {
      const ix = src.index;
      for (let i = 0; i < ix.count; i += 3) this.tri(base + ix.getX(i), base + ix.getX(i + 1), base + ix.getX(i + 2));
    } else for (let i = 0; i < p.count; i += 3) this.tri(base + i, base + i + 1, base + i + 2);
    g.dispose();
  }

  /** A flat polygon (convex or star-shaped about its centroid), facing `normal`. */
  cap(points: Vec[], normal: Vec, bone: number, uv: UV | ((p: Vec) => UV)) {
    const c: Vec = [0, 0, 0];
    for (const p of points) {
      c[0] += p[0] / points.length;
      c[1] += p[1] / points.length;
      c[2] += p[2] / points.length;
    }
    const f = (p: Vec) => (typeof uv === 'function' ? uv(p) : uv);
    const ci = this.vertex(c, normal, f(c), bone);
    const ids = points.map((p) => this.vertex(p, normal, f(p), bone));
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      if (same(points[i], points[(i + 1) % ids.length])) continue;
      this.tri(ci, a, b);
    }
  }

  /** A quad strip between two polylines (equal length), for edges and jambs, facing away from `ref`. */
  strip(a: Vec[], b: Vec[], bone: number, uv: UV, ref: Vec, toward = false) {
    const P: Vec[] = [];
    for (let i = 0; i < a.length; i++) P.push(a[i]);
    for (let i = 0; i < b.length; i++) P.push(b[i]);
    this.grid(P, 2, a.length, { bone, uv, flat: true, ref: () => ref, sign: toward ? -1 : 1 });
  }

  build() {
    const g = new THREE.BufferGeometry();
    const n = this.vertexCount;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    const si = new Uint8Array(n * 4);
    const sw = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = this.bones[i];
      sw[i * 4] = 255;
    }
    g.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(sw, 4, true));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    return g;
  }
}

function same(a: Vec, b: Vec) {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7 && Math.abs(a[2] - b[2]) < 1e-7;
}
