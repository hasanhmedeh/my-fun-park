// The world beyond the park: the mainland out to 60 km east, west and north (the fair's ring hills,
// fields, forests, villages and a mountain range far to the north), the south coast's beaches, and
// Palm Cay 40 km out to sea. The shapes come from terrain-land.ts, the colours from
// terrain-shader.ts; this builds the meshes and keeps them (and the trees and towns) up to date.
//
// The meshes follow the coast: rows run parallel to the shoreline (z = homeCoastZ(x) − s), and
// Palm Cay's rings run round it at fixed shore distances, so the beach's profile and the water's
// edge are exact wherever you look from. Tiles of different resolutions meet under short skirts.

import * as THREE from 'three';
import type { Ctx } from './context';
import { ISLAND, homeCoastZ, islandK, islandShoreDist } from './geo';
import type { Quality } from './quality';
import { LAND_UNIFORMS, landMaterial, ringColour } from './terrain-shader';
import { groundY, meshY, ringTint, sstep } from './terrain-land';
import { Vegetation } from './terrain-trees';
import { Towns } from './terrain-towns';

export { groundY, onLand } from './terrain-land';

type StepFn = (v: number) => number;

/** Grid lines from a to b, `step(v)` apart (always including both ends). */
function graded(a: number, b: number, step: StepFn) {
  const out = [a];
  let v = a;
  while (v < b - 1e-6) {
    const s = step(v);
    v = b - v < s * 1.5 ? b : v + s;
    out.push(v);
  }
  return out;
}

/** Steps that grow linearly with |v| between `near` (at |v| = v0) and `far` (at |v| = v1). */
const growing = (near: number, far: number, v0: number, v1: number): StepFn => (v) => near + (far - near) * sstep(v0, v1, Math.abs(v)) ** 0.8;

interface TileSpec {
  xs: number[];
  ss: number[];
}

const tint = new THREE.Color();

/**
 * One tile of the mainland: columns xs, rows ss (shore distance), as a mesh with skirts round its
 * edges (hiding the cracks where a neighbour has other vertices along the seam).
 */
function mainlandTile({ xs, ss }: TileSpec) {
  const W = xs.length;
  const H = ss.length;
  const n = W * H;
  const pos = new Float32Array(n * 3);
  const shore = new Float32Array(n);
  const tints = new Float32Array(n * 4);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const x = xs[i];
      const s = ss[j];
      const z = homeCoastZ(x) - s;
      pos[k * 3] = x;
      pos[k * 3 + 1] = meshY(x, z);
      pos[k * 3 + 2] = z;
      shore[k] = s;
      const t = ringTint(x, z);
      if (t.w > 0) {
        ringColour(t.row, tint);
        tints.set([tint.r, tint.g, tint.b, t.w], k * 4);
      }
    }
  const idx: number[] = [];
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      idx.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
    }
  const edge: number[] = [];
  for (let i = 0; i < W; i++) edge.push(i);
  for (let j = 1; j < H; j++) edge.push(j * W + W - 1);
  for (let i = W - 2; i >= 0; i--) edge.push((H - 1) * W + i);
  for (let j = H - 2; j >= 0; j--) edge.push(j * W);
  return finish(pos, shore, tints, idx, edge, true);
}

/** Builds the geometry, with a skirt hanging below the edge loop (`ring`, in order). */
function finish(pos: Float32Array, shore: Float32Array, tints: Float32Array, idx: number[], ring: number[], closed: boolean) {
  const n = pos.length / 3;
  const g0 = new THREE.BufferGeometry();
  g0.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g0.setIndex(idx);
  g0.computeVertexNormals();
  const nrm = g0.attributes.normal.array as Float32Array;
  // the skirt: a copy of the edge loop, dropped a few metres
  const m = ring.length;
  const P = new Float32Array((n + m) * 3);
  const N = new Float32Array((n + m) * 3);
  const S = new Float32Array(n + m);
  const T = new Float32Array((n + m) * 4);
  P.set(pos);
  N.set(nrm);
  S.set(shore);
  T.set(tints);
  const all = idx.slice();
  for (let e = 0; e < m; e++) {
    const v = ring[e];
    const k = n + e;
    P[k * 3] = pos[v * 3];
    P[k * 3 + 1] = pos[v * 3 + 1] - 6;
    P[k * 3 + 2] = pos[v * 3 + 2];
    N.set([nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]], k * 3);
    S[k] = shore[v];
    T.set(tints.subarray(v * 4, v * 4 + 4), k * 4);
    if (e < m - 1 || closed) {
      const v2 = ring[(e + 1) % m];
      const k2 = n + ((e + 1) % m);
      // both windings: whichever side faces the camera covers the crack
      all.push(v, k, v2, v2, k, k2, v, v2, k, v2, k2, k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('aShore', new THREE.BufferAttribute(S, 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(T, 4));
  g.setIndex(all);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  g0.dispose();
  return g;
}

/**
 * Palm Cay: rays out from its centre, rings at fixed shore distances near the shore (so the
 * beach profile is exact) and evenly spaced inland.
 */
function islandGeometry(rays: number) {
  const cx = ISLAND.centre.x;
  const cz = ISLAND.centre.z;
  const shoreRows = [-30, -14, -6, -2, 0, 2.5, 6, 10, 15, 20, 25, 33, 45, 62, 85, 115, 160];
  const inner = 18;
  const H = shoreRows.length + inner;
  const n = rays * H;
  const pos = new Float32Array(n * 3);
  const shore = new Float32Array(n);
  const tints = new Float32Array(n * 4);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    // islandK is homogeneous along a ray (k = r·K1) and so is its gradient's length (constant), so
    // the shore distance falls linearly along the ray: d(r) = (1 − r·K1) / G
    const K1 = islandK(cx + ux, cz + uz);
    const r0 = 1 / K1;
    const G = (100 * K1) / islandShoreDist(cx + ux * (r0 - 100), cz + uz * (r0 - 100));
    const rAt = (d: number) => (1 - d * G) / K1;
    const rInner = Math.max(0, rAt(shoreRows[shoreRows.length - 1]));
    for (let j = 0; j < H; j++) {
      // j = 0 is the outermost ring (out at sea), then inward to the centre
      const r = j < shoreRows.length ? rAt(shoreRows[j]) : rInner * (1 - (j - shoreRows.length + 1) / inner);
      const x = cx + ux * r;
      const z = cz + uz * r;
      const k = j * rays + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = groundY(x, z);
      pos[k * 3 + 2] = z;
      shore[k] = islandShoreDist(x, z);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < rays; i++) {
      const i2 = (i + 1) % rays;
      const a = j * rays + i;
      const b = j * rays + i2;
      const c = (j + 1) * rays + i;
      const d = (j + 1) * rays + i2;
      idx.push(a, c, b, b, c, d);
    }
  const ring: number[] = [];
  for (let i = 0; i < rays; i++) ring.push(i);
  return finish(pos, shore, tints, idx, ring, true);
}

/** The mainland's tiles: fine round the fair and the airport, coarser outward (shore distance s from 300 m inland; the coast strip below). */
function mainlandTiles(low: boolean): TileSpec[] {
  const k = low ? 1.6 : 1;
  const parkCols = graded(-1700, 1700, () => 25 * k);
  const parkRows = graded(300, 2700, () => 25 * k);
  const midStep = () => 70 * k;
  const eastCols = graded(6000, 60000, growing(70 * k, 1500, 6000, 60000));
  const farRows = graded(300, 61300, growing(100 * k, 1500, 300, 61300));
  const northCols = graded(-6000, 6000, growing(70 * k, 300, 1700, 6000));
  const northRows = graded(6000, 61300, growing(70 * k, 1500, 6000, 61300));
  // a graded axis from −a to −b runs with |v| shrinking: build it on the positive side and mirror
  const mirror = (xs: number[]) => xs.map((v) => -v).reverse();
  return [
    { xs: parkCols, ss: parkRows },
    { xs: graded(-6000, -1700, midStep), ss: graded(300, 6000, midStep) },
    { xs: graded(1700, 6000, midStep), ss: graded(300, 6000, midStep) },
    { xs: graded(-1700, 1700, midStep), ss: graded(2700, 6000, midStep) },
    { xs: mirror(eastCols), ss: farRows },
    { xs: eastCols, ss: farRows },
    { xs: northCols, ss: northRows },
  ];
}

/** The coast strip: from 30 m out at sea to 400 m inland, fine along the shore, in chunks east to west. */
function coastTiles(low: boolean): TileSpec[] {
  const k = low ? 1.6 : 1;
  const rows = [-30, -14, -6, -2, 0, 2.5, 6, 10, 15, 20, 25, 33, 45, 62, 85, 120, 180, 260, 400];
  const step = (v: number) => k * (Math.abs(v) < 3500 ? 25 : Math.abs(v) < 12000 ? 50 : Math.abs(v) < 30000 ? 100 : 200);
  const pos = graded(0, 60000, step);
  const neg = pos.map((v) => -v).reverse();
  const cut = (lo: number, hi: number) => [...neg, ...pos.slice(1)].filter((v) => v >= lo && v <= hi);
  return [
    { xs: cut(-60000, -12000), ss: rows },
    { xs: cut(-12000, -3500), ss: rows },
    { xs: cut(-3500, 3500), ss: rows },
    { xs: cut(3500, 12000), ss: rows },
    { xs: cut(12000, 60000), ss: rows },
  ];
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly vegetation: Vegetation;
  readonly towns: Towns;
  private tiles: THREE.Mesh[] = [];
  private box = new THREE.Box3();

  constructor(
    private ctx: Ctx,
    q: Quality,
  ) {
    const low = q.tier === 'low' || q.tier === 'lowest';
    const mat = landMaterial(q.tier);
    const add = (g: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = q.shadows;
      m.matrixAutoUpdate = false;
      // drawn after the park's own ground and buildings, so their depth rejects what's beneath them
      m.renderOrder = 1;
      this.tiles.push(m);
      this.group.add(m);
    };
    for (const t of [...coastTiles(low), ...mainlandTiles(low)]) add(mainlandTile(t));
    add(islandGeometry(low ? 320 : 512));
    this.vegetation = new Vegetation(ctx, q);
    this.towns = new Towns(ctx, q);
    this.group.add(this.vegetation.group, this.towns.group);
  }

  /** 0 by day .. 1 at night: the villages' windows and street lights. */
  setNight(k: number) {
    LAND_UNIFORMS.uNight.value = k;
    this.towns.setNight(k);
  }

  /** How far the camera sees: the far plane, or less in thick fog. */
  private seeing(cam: THREE.PerspectiveCamera) {
    const far = cam.far ?? 2400;
    const fog = this.ctx.scene.fog as THREE.FogExp2 | null;
    return Math.min(far, fog && fog.density > 0 ? 2.6 / fog.density : far);
  }

  /** Tiles wholly beyond what can be seen from `p` (fog or the far plane) aren't drawn at all. */
  private cull(p: THREE.Vector3, seeing: number) {
    for (const t of this.tiles) {
      this.box.copy(t.geometry.boundingBox!);
      t.visible = this.box.distanceToPoint(p) < seeing;
    }
  }

  update(camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera;
    const far = cam.far ?? 2400;
    LAND_UNIFORMS.uWalk.value = far < 5000 ? 1 : 0;
    LAND_UNIFORMS.uFarFade.value.set(far * 0.8, far * 0.96);
    const seeing = this.seeing(cam);
    this.cull(camera.position, seeing);
    this.vegetation.update(camera, seeing);
    this.towns.update();
  }

  /**
   * Call right after a teleport or a region change (once the camera's far plane and the fog are
   * set for where it's going): plants the trees round (x, z) at once, nearest first, within
   * `budgetMs`, so they're there on the first frame instead of filling in over seconds; the far
   * fringe follows over the next frames as usual. `y` is the camera's height there (default:
   * standing on the ground). Returns the time taken (ms).
   */
  warm(x: number, z: number, budgetMs = 45, y?: number): number {
    const pos = new THREE.Vector3(x, y ?? groundY(x, z) + 1.7, z);
    const seeing = this.seeing(this.ctx.camera as THREE.PerspectiveCamera);
    this.cull(pos, seeing);
    return this.vegetation.warm(pos, seeing, budgetMs);
  }
}
