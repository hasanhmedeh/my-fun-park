// Palm Cay's planting: coconut palms (tall, curving trunks with drooping pinnate fronds, coconut
// clusters and a dead frond or two), young palms with short trunks for the gardens, and flowering
// shrubs (hibiscus, bougainvillea, allamanda, croton). Everything is instanced and sways in the
// shared wind (wind.ts). Each kind has three levels of detail by distance: the full model close up
// (the only one inside the sun's shadow box), a coarser one with the same crown, and an eight-frond
// stand-in far off. Where the GPU can multi-draw, every palm (and every shrub) on the island is one
// BatchedMesh: one draw call for all kinds and levels, each tree culled against the camera's view
// and the shadow camera's; elsewhere instanced near/far sets. Levels are re-chosen only when the
// camera has moved, so a still camera costs nothing.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withFogSun } from '../fog';
import type { Tier } from '../quality';
import { mulberry } from '../random';
import { canvasTex } from '../textures';
import { wind } from '../wind';
import { addInteriorFill, palmAtlas } from './kit';

export type PalmKind = 'coconut' | 'young';

export interface PalmSpot {
  x: number;
  z: number;
  kind?: PalmKind;
  /** Uniform scale (1 ≈ a 9 m coconut palm). */
  s?: number;
  /** Which way the trunk leans (radians about y); random when omitted. */
  yaw?: number;
  /** Ground height (planters, the terminal's floor). */
  y?: number;
}

export type ShrubKind = 'hibiscus' | 'bougainvillea' | 'allamanda' | 'croton' | 'oleander';

export interface ShrubSpot {
  x: number;
  z: number;
  kind: ShrubKind;
  s?: number;
  y?: number;
}

const BLOOM: Record<ShrubKind, string> = {
  hibiscus: '#e8273f',
  bougainvillea: '#d6318f',
  allamanda: '#f7cf2a',
  croton: '#e8732a',
  oleander: '#f6a0b8',
};

// ------------------------------------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------------------------------------

interface PalmShape {
  height: number;
  /** How far the crown leans out over the base (m). */
  lean: number;
  fronds: number;
  /** Segments along each frond, and round / up the trunk. */
  frondSegs: number;
  sides: number;
  trunkSegs: number;
  frondLen: number;
  coconuts: number;
  dead: number;
  seed: number;
}

const FROND_TILE = 1.6; // metres of frond per texture tile (nine leaflets a side)
const BARK_TILE = 1.2;

/**
 * One palm, base at the origin, leaning towards +x. UVs: fronds in the atlas's left half (u 0 at
 * the midrib, 0.5 at the leaflet tips), bark in the right half. Vertex colours carry the greens and
 * the trunk's grey; `aSway` is 0 at the root, ~0.35 at the crown and 1 at the frond tips.
 */
function palmGeometry(o: PalmShape) {
  const rnd = mulberry(o.seed);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  const push = (p: THREE.Vector3, nn: THREE.Vector3, u: number, vv: number, cc: THREE.Color, s: number) => {
    pos.push(p.x, p.y, p.z);
    nor.push(nn.x, nn.y, nn.z);
    uv.push(u, vv);
    col.push(cc.r, cc.g, cc.b);
    sway.push(s);
    return pos.length / 3 - 1;
  };

  // the trunk: a tapering tube along a quadratic curve, swollen at the bole
  const H = o.height;
  const at = (t: number) => new THREE.Vector3(o.lean * t * t, H * t, 0);
  const tangent = (t: number) => new THREE.Vector3(2 * o.lean * t, H, 0).normalize();
  const B = new THREE.Vector3(0, 0, 1);
  const bark = new THREE.Color('#ffffff');
  for (let i = 0; i <= o.trunkSegs; i++) {
    const t = i / o.trunkSegs;
    const p = at(t);
    const T = tangent(t);
    const N = new THREE.Vector3().crossVectors(B, T).normalize();
    const r = 0.13 + 0.09 * (1 - t) + 0.13 * Math.exp(-t * 16);
    // older trunk low down is greyer, the top fresher and browner
    c.copy(bark).lerp(new THREE.Color('#c9b08a'), t * 0.6);
    for (let j = 0; j <= o.sides; j++) {
      const a = (j / o.sides) * Math.PI * 2;
      n.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      v.copy(p).addScaledVector(n, r);
      push(v, n, 0.5 + (0.5 * j) / o.sides, (t * H) / BARK_TILE, c, 0.35 * t * t);
    }
  }
  const ring = o.sides + 1;
  for (let i = 0; i < o.trunkSegs; i++)
    for (let j = 0; j < o.sides; j++) {
      const a = i * ring + j;
      idx.push(a, a + ring, a + 1, a + 1, a + ring, a + ring + 1);
    }

  // the crown
  const top = at(1);
  const up = new THREE.Vector3(0, 1, 0);
  const frond = (az: number, elev: number, len: number, sag: number, width: number, colour: THREE.Color, tipColour: THREE.Color, segs: number) => {
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    const ce = Math.cos(elev);
    const se = Math.sin(elev);
    const rach = (s: number) =>
      top
        .clone()
        .addScaledVector(dir, len * s * ce)
        .addScaledVector(up, len * (s * se - sag * s * s));
    const base = pos.length / 3;
    for (let k = 0; k <= segs; k++) {
      const s = k / segs;
      const p = rach(s);
      const tan = rach(Math.min(1, s + 0.02)).sub(rach(Math.max(0, s - 0.02))).normalize();
      const w = width * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + s * 0.95)), 0.6);
      // leaflets hang in a V under the midrib, more so towards the tip
      const droop = 0.45 + 0.55 * s;
      const cc = c.copy(colour).lerp(tipColour, s);
      const sw = 0.35 + 0.65 * s;
      const vv = (s * len) / FROND_TILE;
      // a soft, crown-shaped normal: mostly up, a little outward, so the crown lights as a volume
      const nn = new THREE.Vector3().crossVectors(tan, side).normalize();
      if (nn.y < 0) nn.negate();
      nn.lerp(dir.clone().multiplyScalar(0.6).add(up), 0.5).normalize();
      push(p, nn, 0, vv, cc, sw);
      for (const sgn of [-1, 1]) {
        const e = p
          .clone()
          .addScaledVector(side, sgn * w * Math.cos(droop))
          .addScaledVector(up, -w * Math.sin(droop))
          .addScaledVector(tan, w * 0.25);
        push(e, nn, 0.5, vv + 0.08, cc, sw);
      }
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 3;
      const b = a + 3;
      // left half (a, a+1) and right half (a, a+2)
      idx.push(a, a + 1, b, a + 1, b + 1, b, a, b, a + 2, a + 2, b, b + 2);
    }
  };

  const green = new THREE.Color('#5a9334');
  const tipGreen = new THREE.Color('#9dbf52');
  const golden = 2.39996;
  for (let k = 0; k < o.fronds; k++) {
    const f = k / o.fronds;
    const az = k * golden + rnd() * 0.3;
    // the youngest fronds stand up in the middle, the oldest droop round the outside
    const elev = THREE.MathUtils.lerp(1.05, -0.15, f) + (rnd() - 0.5) * 0.2;
    const len = o.frondLen * (0.75 + 0.35 * Math.sin(Math.PI * Math.min(1, f + 0.25))) * (0.9 + rnd() * 0.2);
    const old = THREE.MathUtils.smoothstep(f, 0.6, 1);
    const cc = green.clone().lerp(new THREE.Color('#6f7f2a'), old * 0.6);
    frond(az, elev, len, 0.45 + 0.4 * f + rnd() * 0.1, 0.95 + rnd() * 0.2, cc, tipGreen.clone().lerp(new THREE.Color('#b0a24a'), old * 0.5), o.frondSegs);
  }
  for (let k = 0; k < o.dead; k++) {
    const az = rnd() * Math.PI * 2;
    frond(az, -1.2, o.frondLen * 0.55, 0.2, 0.55, new THREE.Color('#8a6a3a'), new THREE.Color('#6b5030'), Math.max(2, o.frondSegs - 3));
  }

  const parts: THREE.BufferGeometry[] = [];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  parts.push(g);

  // a cluster of coconuts under the crown
  for (let k = 0; k < o.coconuts; k++) {
    const a = (k / o.coconuts) * Math.PI * 2 + rnd();
    const nut = new THREE.IcosahedronGeometry(0.15, 0);
    nut.scale(1, 1.15, 1);
    nut.translate(top.x + Math.cos(a) * 0.24, top.y - 0.3 - rnd() * 0.12, top.z + Math.sin(a) * 0.24);
    const cnt = nut.attributes.position.count;
    const nc = new THREE.Color(rnd() > 0.35 ? '#6f8a2a' : '#8a5a26');
    nut.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: cnt }, () => [nc.r, nc.g, nc.b]).flat(), 3));
    nut.setAttribute('aSway', new THREE.Float32BufferAttribute(new Array(cnt).fill(0.35), 1));
    // a flat patch of the bark texture, so the nuts read as solid husk
    const nuv = nut.attributes.uv;
    for (let i = 0; i < nuv.count; i++) nuv.setXY(i, 0.62 + (i % 3) * 0.02, 0.3);
    parts.push(nut);
  }
  const merged = mergeGeometries(
    parts.map((p) => (p.index ? p.toNonIndexed() : p)),
    false,
  )!;
  merged.computeBoundingSphere();
  return merged;
}

/** A flowering shrub: a lumpy mound of leaves (dark green) with blossom clusters (`aBloom` = 1, tinted per instance). */
function shrubGeometry(detail: 'near' | 'mid' | 'far') {
  const rnd = mulberry(404);
  const blobs: [number, number, number, number][] = [
    [0, 0.55, 0, 0.7],
    [0.5, 0.42, 0.2, 0.5],
    [-0.45, 0.45, -0.15, 0.52],
    [0.05, 0.85, 0.1, 0.45],
  ];
  const parts: THREE.BufferGeometry[] = [];
  const dark = new THREE.Color('#1f4d22');
  const light = new THREE.Color('#4f8a36');
  const centre = new THREE.Vector3(0, 0.55, 0);
  for (const [x, y, z, r] of detail === 'far' ? blobs.slice(0, 2) : blobs) {
    const g = new THREE.IcosahedronGeometry(r, detail === 'near' ? 1 : 0);
    const p = g.attributes.position;
    const seed = rnd() * 10;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i);
      const vy = p.getY(i);
      const vz = p.getZ(i);
      const k = 1 + Math.sin(vx * 5.1 + seed) * Math.cos(vz * 4.7 + seed) * Math.sin(vy * 3.9) * 0.18;
      p.setXYZ(i, vx * k + x, Math.max(0, vy * k + y), vz * k + z);
    }
    g.computeVertexNormals();
    const cl: number[] = [];
    const nrm = g.attributes.normal;
    const out = new THREE.Vector3();
    const nn = new THREE.Vector3();
    const cc = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      out.set(p.getX(i), p.getY(i), p.getZ(i)).sub(centre).normalize();
      nn.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).lerp(out, 0.7).normalize();
      nrm.setXYZ(i, nn.x, nn.y, nn.z);
      cc.lerpColors(dark, light, THREE.MathUtils.clamp(p.getY(i) / 1.1, 0, 1));
      cl.push(cc.r, cc.g, cc.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
    g.setAttribute('aBloom', new THREE.Float32BufferAttribute(new Array(p.count).fill(0), 1));
    g.deleteAttribute('uv');
    parts.push(g);
  }
  // blossom clusters dotted over the upper surface
  const flowers = detail === 'near' ? 14 : detail === 'mid' ? 10 : 5;
  for (let i = 0; i < flowers; i++) {
    const a = rnd() * Math.PI * 2;
    const e = 0.15 + rnd() * 1.1;
    const r = 0.62 + rnd() * 0.1;
    const f = new THREE.OctahedronGeometry(0.11 + rnd() * 0.06, 0);
    f.translate(Math.cos(a) * Math.cos(e) * r * 1.1, 0.55 + Math.sin(e) * r * 0.75, Math.sin(a) * Math.cos(e) * r * 1.1);
    const cnt = f.attributes.position.count;
    f.setAttribute('color', new THREE.Float32BufferAttribute(new Array(cnt * 3).fill(1), 3));
    f.setAttribute('aBloom', new THREE.Float32BufferAttribute(new Array(cnt).fill(1), 1));
    f.deleteAttribute('uv');
    parts.push(f);
  }
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------------------------
// Materials (shared by every palm and shrub on the island)
// ------------------------------------------------------------------------------------------------

let PALM_MAT: THREE.MeshStandardMaterial | null = null;
let SHRUB_MAT: THREE.MeshStandardMaterial | null = null;

function palmMaterial(renderer?: THREE.WebGLRenderer) {
  if (PALM_MAT) return PALM_MAT;
  const tex = canvasTex(palmAtlas(), renderer);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  PALM_MAT = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
  // palms bend more than the park's broadleaves: their crowns sit on a long, springy trunk
  palmWind(PALM_MAT, 0.16);
  addInteriorFill(PALM_MAT);
  return PALM_MAT;
}

/**
 * wind.ts's sway (same uniforms, same motion) for a material drawn either instanced or batched:
 * the shared `addWind` only knows instancing, and a BatchedMesh's trees take their place from the
 * batching matrix instead.
 */
function palmWind(material: THREE.Material, amount: number) {
  material.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uTime = wind.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #if defined( USE_BATCHING )
          mvPosition = batchingMatrix * mvPosition;
          vec3 root = (modelMatrix * batchingMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #elif defined( USE_INSTANCING )
          mvPosition = instanceMatrix * mvPosition;
          vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #else
          vec3 root = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif
        vec4 wPos = modelMatrix * mvPosition;
        float sway = aSway * aSway;
        float gust = sin(uTime * 0.6 + root.x * 0.05) * 0.5 + 0.5;
        float w = sin(uTime * 1.7 + root.x * 0.31 + root.z * 0.23) + 0.4 * sin(uTime * 3.3 + root.z * 0.7);
        wPos.x += w * ${amount.toFixed(3)} * (0.6 + gust) * sway;
        wPos.z += w * ${(amount * 0.45).toFixed(3)} * sway;
        mvPosition = viewMatrix * wPos;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => `island-palm-wind-${amount}`;
}

function shrubMaterial() {
  if (SHRUB_MAT) return SHRUB_MAT;
  SHRUB_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  // the leaves keep their own greens; only the blossoms take the instance's colour
  SHRUB_MAT.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBloom;')
      .replace(
        '#include <color_vertex>',
        /* glsl */ `vColor = vec4(1.0);
        #ifdef USE_COLOR
          vColor.rgb = color.rgb;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix(vColor.rgb, instanceColor.rgb, aBloom);
        #endif
        #ifdef USE_BATCHING_COLOR
          vColor.rgb = mix(vColor.rgb, getBatchingColor(getIndirectIndex(gl_DrawID)).rgb, aBloom);
        #endif`,
      );
  };
  SHRUB_MAT.customProgramCacheKey = () => 'island-shrub';
  addInteriorFill(SHRUB_MAT);
  return SHRUB_MAT;
}


// ------------------------------------------------------------------------------------------------
// Levels of detail
// ------------------------------------------------------------------------------------------------

/**
 * Whether this renderer draws a BatchedMesh in a single call (WEBGL_multi_draw). Without the
 * extension three draws a batch one range at a time, a call per tree, so the plantings fall back
 * to instanced near/far sets there.
 */
export function canMultiDraw(renderer?: THREE.WebGLRenderer) {
  return !!renderer && MULTI_DRAW !== false && renderer.extensions.has('WEBGL_multi_draw');
}

let MULTI_DRAW: boolean | null = null;

/** Dev tooling (the island previews' `nobatch`): `false` builds the instanced, unbatched fallback even where multi-draw works; `null` detects again. */
export function setMultiDraw(v: false | null) {
  MULTI_DRAW = v;
}

interface Item {
  m: THREE.Matrix4;
  c: THREE.Color;
  /** Position relative to the set's origin. */
  x: number;
  y: number;
  z: number;
}

interface Kind {
  lods: (THREE.BufferGeometry | null)[];
  items: Item[];
}

/** How far the full model is drawn, per tier (m), in the instanced fallback. */
const NEAR: Record<Tier, number> = { high: 240, medium: 170, low: 110, lowest: 70 };

/**
 * Batched palms: the camera distance (m) out to which each level is drawn (full, coarse,
 * stand-in); 0 skips a level. The full model covers the sun's shadow box (~46 m round the focus)
 * with room to spare, so every palm that casts a visible shadow casts it in full.
 */
const PALM_LODS: Record<Tier, [number, number, number]> = {
  high: [75, 280, Infinity],
  medium: [60, 220, Infinity],
  low: [0, 160, Infinity],
  lowest: [0, 100, Infinity],
};

/** Batched shrubs: the same, and past the last level they're gone (a metre-high bush is a couple of pixels by then). */
const SHRUB_LODS: Record<Tier, [number, number, number]> = {
  high: [32, 130, 340],
  medium: [26, 100, 260],
  low: [0, 70, 120],
  lowest: [0, 45, 75],
};

/**
 * A whole planting in one BatchedMesh (one draw call, plus one in the shadow pass): each tree
 * gets the level its distance calls for, or is hidden past the last, and three culls every tree
 * against the camera's view and the shadow camera's, so nothing behind the visitor or outside the
 * shadow box is drawn.
 */
class BatchedLods {
  readonly mesh: THREE.BatchedMesh;
  private readonly pos: Float32Array;
  /** The geometry id per instance and level (-1: that kind has no such level). */
  private readonly ids: Int32Array;
  /** The geometry each instance shows now (-1: hidden, -2: not set yet). */
  private readonly cur: Int32Array;
  private readonly r2: number[];
  private readonly levels: number;
  private readonly origin: THREE.Vector3;
  private last = new THREE.Vector3(Infinity, 0, 0);

  constructor(origin: THREE.Vector3Like, kinds: Kind[], mat: THREE.Material, ranges: number[], shadows: boolean) {
    this.origin = new THREE.Vector3().copy(origin);
    this.levels = ranges.length;
    this.r2 = ranges.map((r) => r * r);
    let verts = 0;
    let index = 0;
    let n = 0;
    for (const k of kinds) {
      if (!k.items.length) continue;
      n += k.items.length;
      k.lods.forEach((g, l) => {
        if (!g || !(ranges[l] > 0)) return;
        verts += g.attributes.position.count;
        index += g.index ? g.index.count : 0;
      });
    }
    this.mesh = new THREE.BatchedMesh(Math.max(1, n), Math.max(1, verts), Math.max(1, index), mat);
    this.pos = new Float32Array(n * 3);
    this.ids = new Int32Array(n * this.levels).fill(-1);
    this.cur = new Int32Array(n).fill(-2);
    for (const k of kinds) {
      if (!k.items.length) continue;
      const gid = k.lods.map((g, l) => (g && ranges[l] > 0 ? this.mesh.addGeometry(g) : -1));
      const first = gid.find((g) => g >= 0);
      if (first === undefined) continue;
      for (const it of k.items) {
        const id = this.mesh.addInstance(first);
        this.mesh.setMatrixAt(id, it.m);
        this.mesh.setColorAt(id, it.c);
        this.pos[id * 3] = it.x;
        this.pos[id * 3 + 1] = it.y;
        this.pos[id * 3 + 2] = it.z;
        for (let l = 0; l < this.levels; l++) this.ids[id * this.levels + l] = gid[l];
      }
    }
    // bounds round every tree at its biggest level
    this.mesh.computeBoundingSphere();
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = shadows;
  }

  /** Re-picks every tree's level once the camera has moved a few metres. */
  update(camera: THREE.Camera) {
    const cx = camera.position.x - this.origin.x;
    const cy = camera.position.y - this.origin.y;
    const cz = camera.position.z - this.origin.z;
    if (Math.hypot(cx - this.last.x, cy - this.last.y, cz - this.last.z) < 4) return;
    this.last.set(cx, cy, cz);
    const L = this.levels;
    const n = this.cur.length;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i * 3] - cx;
      const dy = this.pos[i * 3 + 1] - cy;
      const dz = this.pos[i * 3 + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      let g = -1;
      for (let l = 0; l < L; l++) {
        const id = this.ids[i * L + l];
        if (id >= 0 && d2 < this.r2[l]) {
          g = id;
          break;
        }
      }
      const was = this.cur[i];
      if (g === was) continue;
      if (g < 0) this.mesh.setVisibleAt(i, false);
      else {
        if (was === -1) this.mesh.setVisibleAt(i, true);
        this.mesh.setGeometryIdAt(i, g);
      }
      this.cur[i] = g;
    }
  }
}

interface Lod {
  near: THREE.InstancedMesh;
  far: THREE.InstancedMesh | null;
  /** Spot positions (x, z), instance matrices and colours, all relative to the group. */
  pos: Float32Array;
  mats: THREE.Matrix4[];
  cols: THREE.Color[];
}

/** A planting's sets: batched where the GPU can multi-draw, else a near and a far instanced model per kind, split by distance. */
class LodSet {
  readonly group = new THREE.Group();
  protected sets: Lod[] = [];
  private last = new THREE.Vector3(Infinity, 0, 0);
  protected nearR: number;
  /** The batched planting (then `sets` stays empty). */
  protected batched: BatchedLods | null = null;

  constructor(
    protected origin: THREE.Vector3Like,
    tier: Tier,
    /** Far copies vanish beyond this (0: never). */
    private cull = 0,
  ) {
    this.group.position.copy(origin);
    this.nearR = NEAR[tier];
  }

  protected add(nearGeo: THREE.BufferGeometry, farGeo: THREE.BufferGeometry | null, mat: THREE.Material, items: Item[], shadows: boolean) {
    if (!items.length) return;
    const near = new THREE.InstancedMesh(nearGeo, mat, items.length);
    const far = farGeo ? new THREE.InstancedMesh(farGeo, mat, items.length) : null;
    const pos = new Float32Array(items.length * 2);
    items.forEach((it, i) => {
      // positions relative to the group, kept for the split (world precision isn't needed for distances)
      pos[i * 2] = it.x;
      pos[i * 2 + 1] = it.z;
    });
    for (const im of far ? [near, far] : [near]) {
      // bounds round every spot (the split only ever draws a subset of them), then start empty
      items.forEach((it, i) => {
        im.setMatrixAt(i, it.m);
        im.setColorAt(i, it.c);
      });
      im.computeBoundingSphere();
      im.castShadow = shadows;
      im.receiveShadow = shadows;
      im.count = 0;
      this.group.add(im);
    }
    if (far) far.castShadow = false;
    this.sets.push({ near, far, pos, mats: items.map((i) => i.m), cols: items.map((i) => i.c) });
  }

  protected addBatched(kinds: Kind[], mat: THREE.Material, ranges: number[], shadows: boolean) {
    if (!kinds.some((k) => k.items.length)) return;
    this.batched = new BatchedLods(this.origin, kinds, mat, ranges, shadows);
    this.group.add(this.batched.mesh);
  }

  /** Re-picks levels (or re-splits near and far) when the camera has moved more than a few metres. */
  update(camera: THREE.Camera) {
    if (this.batched) {
      this.batched.update(camera);
      return;
    }
    const cx = camera.position.x - this.origin.x;
    const cz = camera.position.z - this.origin.z;
    const moved = Math.hypot(cx - this.last.x, cz - this.last.z);
    if (moved < 8) return;
    this.last.set(cx, 0, cz);
    const r2 = this.nearR * this.nearR;
    const c2 = this.cull * this.cull;
    for (const s of this.sets) {
      let n = 0;
      let f = 0;
      for (let i = 0; i < s.mats.length; i++) {
        const dx = s.pos[i * 2] - cx;
        const dz = s.pos[i * 2 + 1] - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r2) {
          s.near.setMatrixAt(n, s.mats[i]);
          s.near.setColorAt(n++, s.cols[i]);
        } else if (s.far && (!c2 || d2 < c2)) {
          s.far.setMatrixAt(f, s.mats[i]);
          s.far.setColorAt(f++, s.cols[i]);
        }
      }
      s.near.count = n;
      s.near.instanceMatrix.needsUpdate = true;
      if (s.near.instanceColor) s.near.instanceColor.needsUpdate = true;
      if (s.far) {
        s.far.count = f;
        s.far.instanceMatrix.needsUpdate = true;
        if (s.far.instanceColor) s.far.instanceColor.needsUpdate = true;
      }
    }
  }
}

/**
 * Palms in world positions (stored relative to `origin`). Two kinds, each a full model (~580
 * triangles for a coconut palm), a coarse one with the same crown (~310) and a stand-in (~140);
 * spots get a random lean direction, scale and tint. Batched where the GPU can multi-draw (pass
 * `renderer`), else instanced near/far sets.
 */
export class Palms extends LodSet {
  /** Trunk positions and radii at the base, for colliders and for keeping paths clear. */
  readonly trunks: { x: number; z: number; r: number }[] = [];

  constructor(spots: PalmSpot[], opts: { origin: THREE.Vector3Like; tier: Tier; shadows: boolean; renderer?: THREE.WebGLRenderer; seed?: number }) {
    super(opts.origin, opts.tier);
    const mat = palmMaterial(opts.renderer);
    const rnd = mulberry(opts.seed ?? 8);
    const batch = canMultiDraw(opts.renderer);
    // the instanced low tiers draw every palm with one middling model (one draw call per kind, not two)
    const lowPoly = !batch && (opts.tier === 'low' || opts.tier === 'lowest');
    if (lowPoly) this.nearR = Infinity;
    const lods = PALM_LODS[opts.tier];
    const shapes: Record<PalmKind, PalmShape[]> = batch
      ? {
          // the coarse level keeps the full model's frond, dead-frond and coconut counts, so it draws the same crown (the same random draws)
          coconut: [
            { height: 9, lean: 1.6, fronds: 14, frondSegs: 6, sides: 7, trunkSegs: 10, frondLen: 4.6, coconuts: 4, dead: 2, seed: 1 },
            { height: 9, lean: 1.6, fronds: 14, frondSegs: 3, sides: 5, trunkSegs: 5, frondLen: 4.6, coconuts: 4, dead: 2, seed: 1 },
            { height: 9, lean: 1.6, fronds: 8, frondSegs: 3, sides: 5, trunkSegs: 4, frondLen: 4.6, coconuts: 0, dead: 0, seed: 1 },
          ],
          young: [
            { height: 3.2, lean: 0.35, fronds: 13, frondSegs: 5, sides: 7, trunkSegs: 5, frondLen: 3.6, coconuts: 0, dead: 1, seed: 2 },
            { height: 3.2, lean: 0.35, fronds: 13, frondSegs: 3, sides: 5, trunkSegs: 3, frondLen: 3.6, coconuts: 0, dead: 1, seed: 2 },
            { height: 3.2, lean: 0.35, fronds: 7, frondSegs: 3, sides: 5, trunkSegs: 2, frondLen: 3.6, coconuts: 0, dead: 0, seed: 2 },
          ],
        }
      : {
          coconut: [
            { height: 9, lean: 1.6, fronds: lowPoly ? 10 : 14, frondSegs: lowPoly ? 3 : 6, sides: lowPoly ? 5 : 7, trunkSegs: lowPoly ? 5 : 10, frondLen: 4.6, coconuts: lowPoly ? 3 : 4, dead: lowPoly ? 1 : 2, seed: 1 },
            ...(lowPoly ? [] : [{ height: 9, lean: 1.6, fronds: 8, frondSegs: 3, sides: 5, trunkSegs: 4, frondLen: 4.6, coconuts: 0, dead: 0, seed: 1 }]),
          ],
          young: [
            { height: 3.2, lean: 0.35, fronds: lowPoly ? 9 : 13, frondSegs: lowPoly ? 3 : 5, sides: 7, trunkSegs: 5, frondLen: 3.6, coconuts: 0, dead: 1, seed: 2 },
            ...(lowPoly ? [] : [{ height: 3.2, lean: 0.35, fronds: 7, frondSegs: 3, sides: 5, trunkSegs: 2, frondLen: 3.6, coconuts: 0, dead: 0, seed: 2 }]),
          ],
        };
    const q = new THREE.Quaternion();
    const sv = new THREE.Vector3();
    const pv = new THREE.Vector3();
    const kinds: Kind[] = [];
    for (const kind of ['coconut', 'young'] as PalmKind[]) {
      const items = spots
        .filter((s) => (s.kind ?? 'coconut') === kind)
        .map((s) => {
          const sc = (s.s ?? 1) * (0.85 + rnd() * 0.3);
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.yaw ?? rnd() * Math.PI * 2);
          const x = s.x - opts.origin.x;
          const y = (s.y ?? 0) - opts.origin.y;
          const z = s.z - opts.origin.z;
          const m = new THREE.Matrix4().compose(pv.set(x, y, z), q, sv.set(sc, sc * (0.9 + rnd() * 0.2), sc));
          const c = new THREE.Color().setHSL(0.17 + rnd() * 0.06, 0.25, 0.86 + rnd() * 0.16);
          this.trunks.push({ x: s.x, z: s.z, r: 0.3 * sc });
          // distances are measured to the crown, about half way up
          return { m, c, x, y: y + (kind === 'coconut' ? 5 : 2) * sc, z };
        });
      const sh = shapes[kind];
      if (batch) kinds.push({ lods: sh.map((o, l) => (items.length && lods[l] > 0 ? palmGeometry(o) : null)), items });
      else this.add(palmGeometry(sh[0]), sh[1] ? palmGeometry(sh[1]) : null, mat, items, opts.shadows);
    }
    if (batch) this.addBatched(kinds, mat, lods, opts.shadows);
  }
}

/**
 * Flowering shrubs (beds, hedges, planters): three levels where the GPU can multi-draw (pass
 * `renderer`), gone past the last; else instanced near/far sets, the far ones dropped past ~2.5×
 * the near range.
 */
export class Shrubs extends LodSet {
  constructor(spots: ShrubSpot[], opts: { origin: THREE.Vector3Like; tier: Tier; shadows: boolean; seed?: number; renderer?: THREE.WebGLRenderer }) {
    super(opts.origin, opts.tier, NEAR[opts.tier] * 2.5);
    const rnd = mulberry(opts.seed ?? 17);
    const q = new THREE.Quaternion();
    const sv = new THREE.Vector3();
    const pv = new THREE.Vector3();
    const items = spots.map((s) => {
      const sc = (s.s ?? 1) * (0.8 + rnd() * 0.4);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
      const x = s.x - opts.origin.x;
      const y = (s.y ?? 0) - opts.origin.y;
      const z = s.z - opts.origin.z;
      const m = new THREE.Matrix4().compose(pv.set(x, y, z), q, sv.set(sc * (0.9 + rnd() * 0.3), sc * (0.8 + rnd() * 0.4), sc * (0.9 + rnd() * 0.3)));
      return { m, c: new THREE.Color(BLOOM[s.kind]).offsetHSL((rnd() - 0.5) * 0.03, 0, (rnd() - 0.5) * 0.08), x, y: y + 0.5, z };
    });
    if (canMultiDraw(opts.renderer)) {
      const lods = SHRUB_LODS[opts.tier];
      this.addBatched([{ lods: [lods[0] > 0 ? shrubGeometry('near') : null, shrubGeometry('mid'), shrubGeometry('far')], items }], shrubMaterial(), lods, opts.shadows);
      return;
    }
    // the low tiers draw only the near shrubs: beyond ~110 m they're lost in the lawns anyway
    const lean = opts.tier === 'low' || opts.tier === 'lowest';
    // elsewhere a shrub is down to a few pixels at half the palms' range: the far model takes over there
    if (!lean) this.nearR = NEAR[opts.tier] * 0.5;
    this.add(shrubGeometry('near'), lean ? null : shrubGeometry('far'), shrubMaterial(), items, opts.shadows);
  }
}
