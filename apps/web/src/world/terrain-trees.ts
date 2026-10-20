// The trees beyond the park: the mainland's woods (broadleaves, and conifers on the high ground to
// the north) and Palm Cay's jungle and beach palms. The forests are painted into the land as well
// (terrain-shader.ts), so these only need to stand near the camera: the ground is split into cells,
// each cell's trees are planted once (deterministically, by the same rules as the paint) and kept in
// a cache, and every few frames the cells round the camera are copied into one instanced mesh per
// kind of tree — denser close by, thinner towards the edge of the planted radius.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from './context';
import { withFogSun } from './fog';
import { homeShoreDist, islandShoreDist } from './geo';
import type { Quality } from './quality';
import { mulberry } from './random';
import { farFadeFog } from './terrain-shader';
import { forestAllowed, forestNoise, groundY, islandClear, jungleAt, sstep } from './terrain-land';

/** Cell size (m): trees are planted and cached per cell. */
const CELL = 128;

const enum Kind {
  Broadleaf,
  Conifer,
  Jungle,
  Palm,
}
const KINDS = 4;

/**
 * Per tier: how far round the camera trees stand, how far the full trees (~60 triangles) reach
 * before the far ones (a single 4–8 triangle crown) take over, and how many of each there may be
 * in all (the nearest cells are filled first, so only the far fringe goes when a budget runs out).
 */
const TIERS = {
  high: { radius: 3600, near: 900, nearBudget: 2500, farBudget: 12000 },
  medium: { radius: 3000, near: 750, nearBudget: 1800, farBudget: 8000 },
  low: { radius: 2200, near: 550, nearBudget: 1000, farBudget: 4000 },
  lowest: { radius: 1500, near: 400, nearBudget: 500, farBudget: 2000 },
};

/** Spherical normals round `centre` (soft, volumetric foliage instead of faceted blobs), and a dark-to-light colour up the crown. */
function shadeCrown(g: THREE.BufferGeometry, centre: THREE.Vector3, dark: string, light: string, y0: number, y1: number, soften = 0.8) {
  const p = g.attributes.position;
  const nrm = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  const out = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  const cd = new THREE.Color(dark);
  const cl = new THREE.Color(light);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    out.copy(v).sub(centre).normalize();
    n.fromBufferAttribute(nrm, i).lerp(out, soften);
    if (n.lengthSq() < 1e-4) n.copy(out);
    n.normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
    c.lerpColors(cd, cl, THREE.MathUtils.smoothstep(v.y, y0, y1));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A plain-coloured part (trunks). */
function paint(g: THREE.BufferGeometry, hex: string) {
  const c = new THREE.Color(hex);
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Strips a geometry to position + normal (the trees need no UVs), so all the parts merge. */
function plain(g: THREE.BufferGeometry) {
  g.deleteAttribute('uv');
  return g;
}

/** Non-indexed (as mergeGeometries needs every part to be): icosahedra already are, cones and cylinders aren't. */
function unindexed(g: THREE.BufferGeometry) {
  return g.index ? g.toNonIndexed() : g;
}

/**
 * Squashes a lump and roughens it, x and z scaled by base + spread × a random amount. The amount
 * is a hash of the vertex's own position, so the copies of a corner the faces share (the
 * geometry isn't indexed) all move together and no cracks open between the faces.
 */
function jitter(g: THREE.BufferGeometry, seed: number, base: number, spread: number, squash: number) {
  const p = g.attributes.position;
  const h = (x: number, y: number, z: number, k: number) => {
    const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 91.7 + k) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    p.setXYZ(i, x * (base + h(x, y, z, 0) * spread), y * squash, z * (base + h(x, y, z, 5.3) * spread));
  }
}

/** A broadleaf ~11 m tall: a lumpy crown of two blobs on a short trunk (about 50 triangles). */
function broadleafGeo() {
  const rnd = mulberry(31);
  const lump = (r: number, x: number, y: number, z: number) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    jitter(g, rnd(), 0.9, 0.2, 0.82);
    return g.translate(x, y, z);
  };
  const crown = mergeGeometries([lump(3.3, 0, 6.6, 0), lump(2.4, 1.1, 8.4, -0.5)].map(plain))!;
  shadeCrown(crown, new THREE.Vector3(0, 7, 0), '#1c3d1f', '#5d8a3c', 4, 10);
  const trunk = paint(plain(new THREE.CylinderGeometry(0.22, 0.4, 4.6, 4, 1, true).translate(0, 2.3, 0)), '#4a3a2c');
  return mergeGeometries([trunk.toNonIndexed(), unindexed(crown)])!;
}

/** A conifer ~15 m tall: two stacked cones on a trunk. */
function coniferGeo() {
  const tiers = [new THREE.ConeGeometry(2.6, 7.5, 6, 1, true).translate(0, 6, 0), new THREE.ConeGeometry(1.8, 6.5, 6, 1, true).translate(0, 10.5, 0)].map(plain);
  const crown = mergeGeometries(tiers)!;
  shadeCrown(crown, new THREE.Vector3(0, 8, 0), '#10261a', '#3f6a3a', 3, 14, 0.45);
  const trunk = paint(plain(new THREE.CylinderGeometry(0.18, 0.32, 3, 4, 1, true).translate(0, 1.5, 0)), '#3e3026');
  return mergeGeometries([trunk.toNonIndexed(), unindexed(crown)])!;
}

/** A rainforest tree ~18 m tall: a broad, flat-topped bright crown high on a pale trunk. */
function jungleGeo() {
  const rnd = mulberry(57);
  const lump = (r: number, x: number, y: number, z: number) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    jitter(g, rnd(), 1.05, 0.25, 0.55);
    return g.translate(x, y, z);
  };
  const crown = mergeGeometries([lump(4.6, 0, 14, 0), lump(3.2, -2.6, 12.6, 1.6), lump(3, 2.4, 13, -1.8)].map(plain))!;
  shadeCrown(crown, new THREE.Vector3(0, 13, 0), '#16401a', '#6aa23a', 11, 16.5);
  const trunk = paint(plain(new THREE.CylinderGeometry(0.3, 0.55, 12.5, 4, 1, true).translate(0, 6.25, 0)), '#8a7f6a');
  return mergeGeometries([trunk.toNonIndexed(), unindexed(crown)])!;
}

/** A coconut palm ~13 m tall: a curved trunk (leaning along +x) and seven drooping fronds. */
function palmGeo() {
  const parts: THREE.BufferGeometry[] = [];
  // the trunk: a 4-sided tube along a gentle curve
  const H = 12;
  const lean = 1.8;
  const seg = 4;
  const trunkPos: number[] = [];
  const trunkIdx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const cx = lean * t * t;
    const r = 0.26 - 0.1 * t;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      trunkPos.push(cx + Math.cos(a) * r, t * H, Math.sin(a) * r);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let k = 0; k < 4; k++) {
      const a = i * 4 + k;
      const b = i * 4 + ((k + 1) % 4);
      trunkIdx.push(a, a + 4, b, b, a + 4, b + 4);
    }
  const trunk = new THREE.BufferGeometry();
  trunk.setAttribute('position', new THREE.Float32BufferAttribute(trunkPos, 3));
  trunk.setIndex(trunkIdx);
  trunk.computeVertexNormals();
  parts.push(paint(trunk, '#8b7558').toNonIndexed());
  // the fronds: bent two-segment blades radiating from the crown, drooping at the tips
  const top = new THREE.Vector3(lean, H, 0);
  const frondPos: number[] = [];
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + 0.3;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const L = 5.2;
    const w = 0.85;
    // points along the frond: base, middle (rising a little), tip (drooping)
    const pts = [
      [0, 0.15],
      [0.5, 0.55],
      [1, -1.7],
    ].map(([u, y]) => new THREE.Vector3(top.x + dx * L * u, top.y + y, top.z + dz * L * u));
    const side = new THREE.Vector3(-dz, 0, dx);
    const widths = [0.15, w, 0.1];
    for (let s = 0; s < 2; s++) {
      const a0 = pts[s].clone().addScaledVector(side, -widths[s]);
      const a1 = pts[s].clone().addScaledVector(side, widths[s]);
      const b0 = pts[s + 1].clone().addScaledVector(side, -widths[s + 1]);
      const b1 = pts[s + 1].clone().addScaledVector(side, widths[s + 1]);
      // the blade folds down along its midrib a little
      a0.y -= 0.2 * widths[s];
      a1.y -= 0.2 * widths[s];
      b0.y -= 0.2 * widths[s + 1];
      b1.y -= 0.2 * widths[s + 1];
      // both faces (the material is single-sided, so each face keeps its own lit-from-above normal)
      frondPos.push(...a0.toArray(), ...b0.toArray(), ...a1.toArray(), ...a1.toArray(), ...b0.toArray(), ...b1.toArray());
      frondPos.push(...a0.toArray(), ...a1.toArray(), ...b0.toArray(), ...a1.toArray(), ...b1.toArray(), ...b0.toArray());
    }
  }
  const crown = new THREE.BufferGeometry();
  crown.setAttribute('position', new THREE.Float32BufferAttribute(frondPos, 3));
  crown.computeVertexNormals();
  // fronds lit mostly from above, whichever way their triangles face
  const nrm = crown.attributes.normal;
  for (let i = 0; i < nrm.count; i++) {
    const n = new THREE.Vector3(nrm.getX(i), Math.abs(nrm.getY(i)) + 0.8, nrm.getZ(i)).normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
  }
  shadeCrown(crown, top, '#2f5a1f', '#86a845', H - 1.8, H + 0.6, 0);
  parts.push(crown);
  return mergeGeometries(parts)!;
}

/** The far trees: just a crown, shaded like the full one, where the full tree's crown would be. */
function farGeos() {
  const blob = (r: number, squash: number, y: number, dark: string, light: string) => {
    const g = new THREE.OctahedronGeometry(r, 0).scale(1, squash, 1).translate(0, y, 0);
    g.deleteAttribute('uv');
    return shadeCrown(g, new THREE.Vector3(0, y, 0), dark, light, y - r * squash, y + r * squash);
  };
  const cone = plain(new THREE.ConeGeometry(2.4, 12.5, 4, 1, true).translate(0, 8.2, 0)).toNonIndexed();
  return [
    blob(3.5, 0.85, 7, '#1c3d1f', '#5d8a3c'),
    shadeCrown(cone, new THREE.Vector3(0, 8, 0), '#10261a', '#3f6a3a', 3, 14, 0.45),
    blob(5.4, 0.5, 13.6, '#16401a', '#6aa23a'),
    blob(3.8, 0.32, 11.8, '#2f5a1f', '#86a845'),
  ];
}

/** One cached cell: per kind, the instance matrices (16 floats each) and colours (3 floats each), in random order. */
interface Cell {
  cx: number;
  cz: number;
  n: number[];
  mats: Float32Array[];
  cols: Float32Array[];
  dist: number;
  /** Set while assembling: the share of the cell's trees drawn, and whether as full trees (0) or far ones (1). */
  thin: number;
  lod: number;
}

const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const p3 = new THREE.Vector3();
const s3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const tmpC = new THREE.Color();

/** Plants one cell's trees by the same rules the land's paint follows. */
function plantCell(cx: number, cz: number): Cell {
  const rnd = mulberry(((cx * 73856093) ^ (cz * 19349663)) >>> 0);
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const lists: number[][] = [[], [], [], []];
  const colours: number[][] = [[], [], [], []];
  const add = (kind: Kind, x: number, y: number, z: number, scale: number, yaw: number, tilt: number, hue: number, light: number) => {
    q4.setFromAxisAngle(UP, yaw);
    if (tilt) q4.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -tilt));
    m4.compose(p3.set(x, y - 0.3, z), q4, s3.set(scale, scale * (0.88 + rnd() * 0.24), scale));
    lists[kind].push(...m4.elements);
    tmpC.setHSL(hue, 0.25 + rnd() * 0.2, light);
    // instance colours multiply the vertex colours: keep them near white with a tint
    colours[kind].push(tmpC.r * 0.95, tmpC.g * 0.95, tmpC.b * 0.95);
  };
  const island = z0 > 20000;
  const spacing = island ? 9 : 11;
  const n = Math.floor(CELL / spacing);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = x0 + (i + 0.15 + rnd() * 0.7) * spacing;
      const z = z0 + (j + 0.15 + rnd() * 0.7) * spacing;
      const r = rnd();
      if (island) {
        const d = islandShoreDist(x, z);
        if (d < 26) continue;
        // coconut palms along the top of the beach, leaning out towards the sea
        if (d < 70 && !islandClear(x, z)) {
          if (r < 0.32 * (1 - sstep(45, 70, d))) {
            const gx = islandShoreDist(x + 4, z) - islandShoreDist(x - 4, z);
            const gz = islandShoreDist(x, z + 4) - islandShoreDist(x, z - 4);
            add(Kind.Palm, x, groundY(x, z), z, 0.8 + rnd() * 0.45, Math.atan2(gz, -gx), 0.05 + rnd() * 0.12, 0.22 + rnd() * 0.06, 0.55 + rnd() * 0.12);
          }
          continue;
        }
        const h = groundY(x, z);
        const k = jungleAt(x, z, d, h);
        if (k <= 0 || r > k) continue;
        if (rnd() < 0.3) add(Kind.Palm, x, h, z, 0.85 + rnd() * 0.5, rnd() * 6.3, rnd() * 0.08, 0.22 + rnd() * 0.06, 0.55 + rnd() * 0.12);
        else add(Kind.Jungle, x, h, z, 0.7 + rnd() * 0.55, rnd() * 6.3, 0, 0.24 + rnd() * 0.1, 0.5 + rnd() * 0.14);
        continue;
      }
      const s = homeShoreDist(x, z);
      if (s < 25) continue;
      const allowed = forestAllowed(x, z, s);
      if (allowed <= 0) continue;
      const h = groundY(x, z);
      const f = sstep(0.575, 0.6, forestNoise(x, z, h)) * allowed;
      // a few lone trees in the hedgerows and the fields too
      const lone = r > 0.996;
      if (!lone && (f <= 0 || r > f)) continue;
      // conifers on the high ground and to the north, broadleaves below
      const pine = sstep(60, 220, h) * 0.8 + sstep(-8000, -20000, z) * 0.4;
      const kind = rnd() < pine ? Kind.Conifer : Kind.Broadleaf;
      add(kind, x, h, z, 0.75 + rnd() * 0.6, rnd() * 6.3, 0, kind === Kind.Conifer ? 0.3 + rnd() * 0.08 : 0.2 + rnd() * 0.12, 0.5 + rnd() * 0.14);
    }
  const cell: Cell = { cx, cz, n: [], mats: [], cols: [], dist: 0, thin: 0, lod: 0 };
  for (let k = 0; k < KINDS; k++) {
    const count = lists[k].length / 16;
    // shuffle, so any prefix of the list is an even thinning of the cell
    const order = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const mats = new Float32Array(count * 16);
    const cols = new Float32Array(count * 3);
    order.forEach((src, dst) => {
      for (let e = 0; e < 16; e++) mats[dst * 16 + e] = lists[k][src * 16 + e];
      for (let e = 0; e < 3; e++) cols[dst * 3 + e] = colours[k][src * 3 + e];
    });
    cell.n.push(count);
    cell.mats.push(mats);
    cell.cols.push(cols);
  }
  return cell;
}

/** The cell offsets round a cell out to R (+ one cell), nearest first, as flat (di, dj) pairs; cached per radius in cells. */
const rings = new Map<number, Int16Array>();
function ringOffsets(R: number) {
  const m = Math.ceil(R / CELL);
  let offs = rings.get(m);
  if (offs) return offs;
  const list: [number, number, number][] = [];
  for (let i = -m - 1; i <= m + 1; i++)
    for (let j = -m - 1; j <= m + 1; j++) {
      const d = Math.hypot(i, j);
      if (d < m + 1) list.push([i, j, d]);
    }
  list.sort((a, b) => a[2] - b[2]);
  offs = new Int16Array(list.length * 2);
  list.forEach(([i, j], k) => {
    offs[k * 2] = i;
    offs[k * 2 + 1] = j;
  });
  rings.set(m, offs);
  return offs;
}

export class Vegetation {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private cells = new Map<number, Cell>();
  /** Cells still to plant round the plan's centre, nearest first, as flat (cx, cz) pairs; `queueAt` is the next one. */
  private queue: number[] = [];
  private queueAt = 0;
  private planCx = NaN;
  private planCz = NaN;
  private planR = 0;
  private dirty = false;
  private sinceAssemble = 0;
  /** The cells of the refill in progress, nearest first. */
  private list: Cell[] = [];
  private ringCount = new Int32Array(0);
  /** The refill in progress: the next cell, the thinning, and the instances written so far (per level, per mesh). */
  private job = { active: false, at: 0, share: 1, used: [0, 0], counts: new Array<number>(KINDS * 2).fill(0) };
  /** Per mesh, the buffers the next refill is written into (swapped with the live ones when done). */
  private spare: { m: Float32Array; c: Float32Array }[] = [];
  /** After a warm-up: the spot it was for, kept until the camera gets there (a few frames at most). */
  private hold: { x: number; z: number; frames: number } | null = null;
  private tier: (typeof TIERS)['high'];

  constructor(_ctx: Ctx, q: Quality) {
    const t = (this.tier = TIERS[q.tier]);
    const near = [broadleafGeo(), coniferGeo(), jungleGeo(), palmGeo()];
    const far = farGeos();
    const mat = () => {
      const m = new THREE.MeshLambertMaterial({ vertexColors: true });
      m.onBeforeCompile = (shader) => {
        withFogSun(shader);
        farFadeFog(shader);
      };
      m.customProgramCacheKey = () => 'trees';
      return m;
    };
    const solid = mat();
    // meshes[k] are the full trees of kind k, meshes[KINDS + k] the far ones
    [...near, ...far].forEach((g, i) => {
      const cap = i < KINDS ? t.nearBudget : t.farBudget;
      const im = new THREE.InstancedMesh(g, solid, cap);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.receiveShadow = q.shadows;
      // far away, and many: no shadow pass (it would draw every instance again)
      im.castShadow = false;
      im.matrixAutoUpdate = false;
      // the trees stand all round the camera, so the mesh is always in view: no bounding sphere to
      // recompute over every instance each time the buffers are refilled
      im.frustumCulled = false;
      im.renderOrder = 1;
      this.spare.push({ m: new Float32Array(cap * 16), c: new Float32Array(cap * 3) });
      this.meshes.push(im);
      this.group.add(im);
    });
  }

  private key(cx: number, cz: number) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Plants the cells round the camera (a little each frame) and keeps the instanced meshes filled from them. */
  update(camera: THREE.Camera, seeing: number) {
    const p = camera.position;
    if (this.hold) {
      // warmed for a spot the camera hasn't been moved to yet: keep those trees, don't re-plan here
      const h = this.hold;
      if (Math.hypot(p.x - h.x, p.z - h.z) < CELL * 2 || --h.frames <= 0) this.hold = null;
      else return;
    }
    const R = Math.min(this.tier.radius, seeing);
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.z / CELL);
    // into a new cell: the plan alone this frame (a refill under way goes on with the cells it has)
    if (cx !== this.planCx || cz !== this.planCz || Math.abs(R - this.planR) > CELL) {
      this.plan(cx, cz, R);
      return;
    }
    const walking = ((camera as THREE.PerspectiveCamera).far ?? 2400) < 5000;
    // the work is spread so no frame does much of it: a frame either sorts the cells for a refill,
    // or copies a slice of one, or plants a few cells
    if (this.job.active) {
      this.assembleStep(0.35);
      return;
    }
    // refill the instance buffers once planting is done, or a few times a second while it goes on
    this.sinceAssemble++;
    if (this.dirty && (this.queueAt >= this.queue.length || this.sinceAssemble >= (walking ? 30 : 8))) {
      this.assembleStart(p, R);
      return;
    }
    // plant queued cells for a moment each frame: flying, where the forests matter, up to ~0.7 ms;
    // walking in the park (the far plane short, the woods deep in the haze) under half a millisecond
    this.plant(walking ? 0.4 : 0.7);
  }

  /**
   * At once, for a camera about to be at `pos` (after a teleport or a region change): plans the
   * cells round it, plants the nearest within `budgetMs` and fills the meshes, so the trees are
   * there on the first frame; the far fringe follows over the next frames as usual. Returns the
   * time taken (ms).
   */
  warm(pos: THREE.Vector3, seeing: number, budgetMs = 45) {
    const t0 = performance.now();
    const R = Math.min(this.tier.radius, seeing);
    this.plan(Math.floor(pos.x / CELL), Math.floor(pos.z / CELL), R);
    // keep ~3 ms of the budget for filling the meshes
    this.plant(Math.max(1, budgetMs - 3));
    this.assembleStart(pos, R);
    this.assembleStep(Infinity);
    this.hold = { x: pos.x, z: pos.z, frames: 10 };
    return performance.now() - t0;
  }

  /** Plants queued cells, nearest first, for up to `ms` milliseconds (at least one). */
  private plant(ms: number) {
    const q = this.queue;
    const t0 = performance.now();
    while (this.queueAt < q.length && performance.now() - t0 < ms) {
      const cx = q[this.queueAt++];
      const cz = q[this.queueAt++];
      const k = this.key(cx, cz);
      if (!this.cells.has(k)) this.cells.set(k, plantCell(cx, cz));
      this.dirty = true;
    }
  }

  /** Works out which cells are wanted round (cx, cz), queues the missing ones nearest first, and forgets far ones. */
  private plan(cx: number, cz: number, R: number) {
    this.planCx = cx;
    this.planCz = cz;
    this.planR = R;
    const offs = ringOffsets(R);
    const q = this.queue;
    q.length = 0;
    this.queueAt = 0;
    for (let i = 0; i < offs.length; i += 2) {
      const a = cx + offs[i];
      const b = cz + offs[i + 1];
      if (!this.cells.has(this.key(a, b))) q.push(a, b);
    }
    const ox = (cx + 0.5) * CELL;
    const oz = (cz + 0.5) * CELL;
    const forget = R * 1.4 + CELL * 2;
    for (const [k, c] of this.cells) if (Math.hypot((c.cx + 0.5) * CELL - ox, (c.cz + 0.5) * CELL - oz) > forget) this.cells.delete(k);
    this.dirty = true;
  }

  /**
   * Starts refilling the instanced meshes from the planted cells round `p`: nearest first,
   * thinning out towards the edge. The copying is spread over the next frames (`assembleStep`)
   * into spare buffers, which are swapped in whole when it's done, so no frame draws half a refill.
   */
  private assembleStart(p: THREE.Vector3, R: number) {
    this.dirty = false;
    this.sinceAssemble = 0;
    // only the cells in range are sorted (the cache keeps a wider ring)
    const reach = R + CELL * 0.7;
    // nearest first, by a counting sort into 32 m rings (a comparison sort of ~2500 cells cost
    // ~0.5 ms; the order within a ring doesn't matter)
    const RING = 32;
    const nb = Math.ceil(reach / RING) + 1;
    const start = this.ringCount.length >= nb + 1 ? this.ringCount : (this.ringCount = new Int32Array(nb + 1));
    start.fill(0);
    let n = 0;
    for (const c of this.cells.values()) {
      c.dist = Math.hypot((c.cx + 0.5) * CELL - p.x, (c.cz + 0.5) * CELL - p.z);
      if (c.dist <= reach) {
        start[Math.floor(c.dist / RING) + 1]++;
        n++;
      }
    }
    for (let b = 1; b <= nb; b++) start[b] += start[b - 1];
    const list = this.list;
    list.length = n;
    for (const c of this.cells.values()) if (c.dist <= reach) list[start[Math.floor(c.dist / RING)]++] = c;
    // seen from high up, the trees below are as far away as those out to the side
    const lift = Math.max(0, p.y - groundY(p.x, p.z));
    // full trees and far ones each draw from their own budget, nearest cells first, so the forest
    // you are over is always whole and only the far fringe goes when a budget runs out
    const t = this.tier;
    // first what every cell would like, then one thinning per level so the lot fits its budget
    // (thinned evenly, not cut off at a cell's edge)
    const want = [0, 0];
    for (const c of list) {
      const d = Math.hypot(c.dist, lift);
      c.thin = THREE.MathUtils.clamp(1.35 - d / R, 0.3, 1);
      c.lod = d < t.near ? 0 : 1;
      want[c.lod] += (c.n[0] + c.n[1] + c.n[2] + c.n[3]) * c.thin;
    }
    // the same share for both, so the forest's density doesn't jump where the full trees end
    const j = this.job;
    j.share = Math.min(1, t.nearBudget / Math.max(1, want[0]), t.farBudget / Math.max(1, want[1]));
    j.at = 0;
    j.used[0] = j.used[1] = 0;
    j.counts.fill(0);
    j.active = true;
  }

  /** Copies the next cells of the refill for up to `ms` milliseconds; swaps the buffers in at the end. */
  private assembleStep(ms: number) {
    const j = this.job;
    const list = this.list;
    const budget = [this.tier.nearBudget, this.tier.farBudget];
    const t0 = performance.now();
    while (j.at < list.length) {
      const c = list[j.at++];
      const lod = c.lod;
      const thin = c.thin * j.share;
      for (let k = 0; k < KINDS; k++) {
        const take = Math.min(Math.floor(c.n[k] * thin + 0.5), budget[lod] - j.used[lod]);
        if (take <= 0) continue;
        const i = lod * KINDS + k;
        // copied by hand: a subarray view per cell and kind (thousands a refill) costs more than the copy
        const M = this.spare[i].m;
        const C = this.spare[i].c;
        const sm = c.mats[k];
        const sc = c.cols[k];
        const om = j.counts[i] * 16;
        const oc = j.counts[i] * 3;
        for (let e = 0, n = take * 16; e < n; e++) M[om + e] = sm[e];
        for (let e = 0, n = take * 3; e < n; e++) C[oc + e] = sc[e];
        j.counts[i] += take;
        j.used[lod] += take;
      }
      if ((j.at & 15) === 0 && performance.now() - t0 > ms) return;
    }
    j.active = false;
    for (let i = 0; i < this.meshes.length; i++) {
      const im = this.meshes[i];
      const count = j.counts[i];
      // the spare buffers become the live ones (same size), the live ones the spares
      const m = im.instanceMatrix;
      const c = im.instanceColor!;
      const s = this.spare[i];
      const lm = m.array as Float32Array;
      const lc = c.array as Float32Array;
      m.array = s.m;
      c.array = s.c;
      s.m = lm;
      s.c = lc;
      im.count = count;
      im.visible = count > 0;
      if (!count) continue;
      // upload only the part in use, not the whole budget's buffer
      m.clearUpdateRanges();
      m.addUpdateRange(0, count * 16);
      m.needsUpdate = true;
      c.clearUpdateRanges();
      c.addUpdateRange(0, count * 3);
      c.needsUpdate = true;
    }
  }
}
