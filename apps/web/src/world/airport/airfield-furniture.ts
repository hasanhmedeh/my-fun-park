// The airfield's hardware round the pavement: the approach lighting's masts and crossbars (on low
// piers where the ground drops away towards the sea), the PAPI units, the localizer's antenna
// array and the glide slope mast with their equipment shelters, the windsock masts and their
// socks (which fill with the wind), the fittings of the elevated lights, the perimeter fence and
// the security road just inside it. Static parts are merged by colour into a couple of meshes
// (vertex colours, one material); the light fittings are one instanced mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTex } from '../textures';
import { withFogSun } from '../fog';
import { SEA_Y, headingVec } from '../geo';
import { groundY } from '../terrain-land';
import type { AirfieldPlan, LightSpec, P2 } from './airfield-plan';

const WHITE = '#e4e2da';
const ALU = '#c4c8cb';
const STEEL = '#8d9196';
const ORANGE = '#e8571d';
const RED = '#c22a22';
const CONCRETE = '#a9a69d';
const ROOF = '#6f7378';
const DARK = '#2c2f33';

/** Merges boxes and cylinders, each with a flat colour, into one vertex-coloured geometry. */
class Kit {
  private parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(private origin: THREE.Vector3) {}

  private push(g: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rotY: number, rotX = 0, rotZ = 0) {
    g.deleteAttribute('uv');
    this.e.set(rotX, rotY, rotZ, 'YXZ');
    this.m.compose(this.p.set(x - this.origin.x, y - this.origin.y, z - this.origin.z), this.q.setFromEuler(this.e), this.s.set(1, 1, 1));
    g.applyMatrix4(this.m);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g.index ? g.toNonIndexed() : g);
  }

  /** A box centred at (x, y, z), sizes along its own x (after turning rotY), y, z. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, rotY = 0) {
    this.push(new THREE.BoxGeometry(sx, sy, sz), color, x, y, z, rotY);
  }

  /** An upright cylinder from y0 to y1. */
  post(x: number, z: number, y0: number, y1: number, r: number, color: string, seg = 8) {
    this.push(new THREE.CylinderGeometry(r, r, y1 - y0, seg, 1), color, x, (y0 + y1) / 2, z, 0);
  }

  /** A horizontal tube centred at (x, y, z), `len` long, along heading `rotY` (0: along −z). */
  bar(x: number, y: number, z: number, len: number, r: number, color: string, rotY: number) {
    this.push(new THREE.CylinderGeometry(r, r, len, 6, 1), color, x, y, z, rotY, Math.PI / 2);
  }

  get empty() {
    return this.parts.length === 0;
  }

  build() {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

/** Ground height under a point, never above the airfield's y = 0. */
const baseAt = (x: number, z: number) => Math.min(0, groundY(x, z));

function approachLighting(kit: Kit, plan: AirfieldPlan) {
  for (const st of plan.alsStations) {
    if (st.y < 0.3) continue;
    const base = baseAt(st.x, st.z);
    const top = st.y - 0.12;
    if (base < -0.25) {
      // where the land falls away the station stands on a concrete pier with a walkway deck
      const foot = Math.min(base, SEA_Y) - 1.5;
      kit.box(st.x, (foot + top - 0.35) / 2, st.z, 1.2, top - 0.35 - foot, 1.2, CONCRETE);
      kit.box(st.x, top - 0.3, st.z, 2.4, 0.12, Math.max(4.4, st.half * 2 + 0.8), CONCRETE);
    } else {
      kit.box(st.x, 0.08, st.z, 1.4, 0.16, 1.4, CONCRETE);
    }
    const mastBase = base < -0.25 ? top - 0.24 : 0;
    // frangible masts every ~6 m under the bar, painted in the obstacle colours
    const masts = Math.max(1, Math.round((st.half * 2) / 6));
    for (let k = 0; k < masts; k++) {
      const mz = masts === 1 ? st.z : st.z - st.half + (st.half * 2 * k) / (masts - 1);
      kit.post(st.x, mz, mastBase, top, 0.055, k % 2 ? ORANGE : WHITE, 6);
      if (top - mastBase > 1.4) kit.post(st.x, mz, mastBase + (top - mastBase) * 0.5, mastBase + (top - mastBase) * 0.75, 0.06, ORANGE, 6);
    }
    kit.bar(st.x, top - 0.02, st.z, st.half * 2 + 0.6, 0.045, STEEL, 0);
  }
  // a lamp housing under every approach light
  for (const l of plan.lights) if (l.group === 'approach' && l.flash < 0 && l.y > 0.3) kit.box(l.x, l.y - 0.07, l.z, 0.32, 0.18, 0.26, DARK);
}

function papiUnits(kit: Kit, plan: AirfieldPlan) {
  for (const u of plan.papiUnits) {
    const rot = (-u.facing * Math.PI) / 180;
    kit.box(u.x, 0.06, u.z, 1.6, 0.12, 2.2, CONCRETE, rot);
    kit.box(u.x, 0.62, u.z, 0.9, 0.46, 1.25, WHITE, rot);
    kit.box(u.x, 0.88, u.z, 1.0, 0.05, 1.35, ORANGE, rot);
    for (const s of [-0.45, 0.45]) {
      const f = headingVec(u.facing);
      kit.post(u.x - f.z * s * 1.2, u.z + f.x * s * 1.2, 0.1, 0.4, 0.05, STEEL, 6);
    }
  }
}

function hut(kit: Kit, x: number, z: number, w: number, d: number, h: number, rotY: number) {
  kit.box(x, h / 2, z, w, h, d, WHITE, rotY);
  kit.box(x, h + 0.12, z, w + 0.4, 0.24, d + 0.4, ROOF, rotY);
  kit.box(x, 0.06, z, w + 1.2, 0.12, d + 1.2, CONCRETE, rotY);
}

function navaids(kit: Kit, plan: AirfieldPlan) {
  // localizer: a row of log-periodic dipole antennas on a frame, the equipment hut behind it
  for (const l of plan.loc) {
    const f = headingVec(l.facing);
    const n = 24;
    for (let k = 0; k < n; k++) {
      const z = l.z - l.half + (l.half * 2 * k) / (n - 1);
      kit.post(l.x, z, 0, 2.9, 0.045, ALU, 6);
      for (const h of [1.9, 2.4, 2.8]) kit.bar(l.x, h, z, 1.6 - h * 0.25, 0.022, ALU, 0);
      kit.bar(l.x - f.x * 0.4, 2.15, z, 0.8, 0.02, ALU, Math.PI / 2);
    }
    kit.bar(l.x, 1.35, l.z, l.half * 2 + 0.4, 0.06, STEEL, 0);
    kit.bar(l.x, 3.0, l.z, l.half * 2 + 0.4, 0.05, STEEL, 0);
    for (const side of [-1, 1]) kit.post(l.x, l.z + side * l.half, 0, 3.3, 0.08, RED, 6);
    hut(kit, l.x - f.x * 40, l.z + 30, 4, 3, 2.6, 0);
  }
  // glide slope: a 14 m mast with three antennas facing the approach, its shelter beside it
  for (const g of plan.gs) {
    const f = headingVec(g.facing);
    const rot = (-g.facing * Math.PI) / 180;
    kit.box(g.x, 0.1, g.z, 2.5, 0.2, 2.5, CONCRETE);
    kit.post(g.x, g.z, 0, 12.8, 0.16, WHITE, 8);
    kit.post(g.x, g.z, 12.8, 14.3, 0.16, RED, 8);
    for (const h of [4.6, 9.2, 13.6]) kit.box(g.x + f.x * 0.4, h, g.z + f.z * 0.4, 1.4, 0.5, 0.2, ALU, rot);
    hut(kit, g.x - f.z * 6, g.z + f.x * 6, 3, 3, 2.6, rot);
  }
  // windsock masts: banded poles with a swivel ring at the top (the socks are animated separately)
  for (const w of plan.windsocks) {
    kit.box(w.x, 0.1, w.z, 1.6, 0.2, 1.6, CONCRETE);
    for (let k = 0; k < 4; k++) kit.post(w.x, w.z, 0.2 + k * 1.55, 0.2 + (k + 1) * 1.55, 0.09, k % 2 ? WHITE : RED, 8);
    kit.post(w.x, w.z, 6.4, 6.75, 0.06, DARK, 6);
  }
}

/** A light fitting: a short frangible stalk and the lamp's head. */
function fittingGeometry() {
  const stalk = new THREE.CylinderGeometry(0.035, 0.05, 0.3, 6, 1).translate(0, 0.15, 0);
  const head = new THREE.CylinderGeometry(0.085, 0.1, 0.12, 8, 1).translate(0, 0.33, 0);
  const g = mergeGeometries([stalk.toNonIndexed(), head.toNonIndexed()], false)!;
  g.deleteAttribute('uv');
  return g;
}

export function fittings(plan: AirfieldPlan, origin: THREE.Vector3) {
  const lamps = plan.lights.filter((l: LightSpec) => l.elevated);
  const mesh = new THREE.InstancedMesh(fittingGeometry(), new THREE.MeshStandardMaterial({ color: '#9b9a8f', roughness: 0.6, metalness: 0.3 }), lamps.length);
  const m = new THREE.Matrix4();
  lamps.forEach((l, i) => {
    // the head sits just under the lamp's flare
    const s = l.y / 0.38;
    m.makeScale(1, s, 1).setPosition(l.x - origin.x, -origin.y, l.z - origin.z);
    mesh.setMatrixAt(i, m);
  });
  mesh.position.copy(origin);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.computeBoundingSphere();
  return mesh;
}

export function hardware(plan: AirfieldPlan, origin: THREE.Vector3) {
  const kit = new Kit(origin);
  approachLighting(kit, plan);
  papiUnits(kit, plan);
  navaids(kit, plan);
  const mesh = new THREE.Mesh(kit.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 }));
  mesh.position.copy(origin);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// ------------------------------------------------------------------------------------------------
// The perimeter: chain-link fence with barbed wire, and the security road inside it
// ------------------------------------------------------------------------------------------------

const FENCE_H = 3;
const FENCE_TILE = 3;

function fenceTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  // 2.4 m of chain-link (from the bottom), then three strands of barbed wire on the outrigger
  const meshTop = 256 * (1 - 2.4 / FENCE_H);
  g.strokeStyle = 'rgba(150,156,160,0.95)';
  g.lineWidth = 1.2;
  for (let k = -256; k < 512; k += 7) {
    g.beginPath();
    g.moveTo(k, 256);
    g.lineTo(k + (256 - meshTop), meshTop);
    g.stroke();
    g.beginPath();
    g.moveTo(k, meshTop);
    g.lineTo(k + (256 - meshTop), 256);
    g.stroke();
  }
  g.fillStyle = '#8a8f93';
  g.fillRect(0, meshTop - 2, 256, 4);
  g.fillRect(0, 250, 256, 4);
  g.fillStyle = '#6f7478';
  for (let k = 0; k < 3; k++) {
    const y = meshTop - 12 - k * 15;
    g.fillRect(0, y, 256, 2);
    for (let x = 6; x < 256; x += 18) g.fillRect(x, y - 3, 2, 8);
  }
  // the post at the tile's edge, with its outrigger arm
  g.fillStyle = '#7d8286';
  g.fillRect(0, meshTop, 7, 256 - meshTop);
  g.save();
  g.translate(3, meshTop);
  g.rotate(-0.5);
  g.fillRect(-3, -50, 5, 52);
  g.restore();
  // Transparent texels take the wire's colour, so the mipmaps (averaging wire and gaps) stay
  // grey instead of darkening towards black; rows flipped for the upload (canvas y runs down).
  const src = g.getImageData(0, 0, 256, 256).data;
  const data = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      const o = ((255 - y) * 256 + x) * 4;
      const a = src[i + 3];
      data[o] = a ? src[i] : 150;
      data[o + 1] = a ? src[i + 1] : 156;
      data[o + 2] = a ? src[i + 2] : 160;
      data[o + 3] = a;
    }
  const t = new THREE.DataTexture(data, 256, 256, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** A vertical ribbon along a polyline, `h` tall, its UVs tiling every FENCE_TILE metres. */
function wall(paths: P2[][], h: number, origin: THREE.Vector3) {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const pts of paths) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      // round the tile count so posts land at both ends of every run
      const tiles = Math.max(1, Math.round(L / FENCE_TILE));
      const nx = (b.z - a.z) / L;
      const nz = -(b.x - a.x) / L;
      const base = pos.length / 3;
      for (const [p, u] of [
        [a, s],
        [b, s + tiles],
      ] as const) {
        pos.push(p.x - origin.x, -origin.y, p.z - origin.z, p.x - origin.x, h - origin.y, p.z - origin.z);
        uv.push(u, 0, u, 1);
        nrm.push(nx, 0, nz, nx, 0, nz);
      }
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      s += tiles;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** The fence's runs: the rectangle, open where the terminal stands in its apron-side edge. */
export function fenceRuns(plan: AirfieldPlan): P2[][] {
  const f = plan.fence;
  const apronSide = Math.sign(plan.ap.geo.apron.z0 - plan.runway.cz);
  const zT = apronSide < 0 ? f.z0 : f.z1;
  const zF = apronSide < 0 ? f.z1 : f.z0;
  return [
    [
      { x: plan.fenceGap.x1, z: zT },
      { x: f.x1, z: zT },
      { x: f.x1, z: zF },
      { x: f.x0, z: zF },
      { x: f.x0, z: zT },
      { x: plan.fenceGap.x0, z: zT },
    ],
  ];
}

export function fence(plan: AirfieldPlan, origin: THREE.Vector3) {
  const mat = new THREE.MeshStandardMaterial({ map: fenceTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 });
  // chain-link thins out with distance (as it does to the eye) instead of filling in solid
  mat.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFenceDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFenceDist = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFenceDist;')
      .replace('#include <alphatest_fragment>', 'diffuseColor.a *= 1.0 - smoothstep(220.0, 600.0, vFenceDist);\n#include <alphatest_fragment>');
  };
  mat.customProgramCacheKey = () => 'airfield-fence';
  const mesh = new THREE.Mesh(wall(fenceRuns(plan), FENCE_H, origin), mat);
  mesh.position.copy(origin);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** A polyline with its corners rounded (radius r). */
function rounded(pts: P2[], r: number): P2[] {
  const out: P2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const u1 = { x: (b.x - a.x) / Math.hypot(b.x - a.x, b.z - a.z), z: (b.z - a.z) / Math.hypot(b.x - a.x, b.z - a.z) };
    const u2 = { x: (c.x - b.x) / Math.hypot(c.x - b.x, c.z - b.z), z: (c.z - b.z) / Math.hypot(c.x - b.x, c.z - b.z) };
    for (let k = 0; k <= 8; k++) {
      // a quadratic Bézier through the corner: close enough to a circular fillet for a road
      const t = k / 8;
      const p0 = { x: b.x - u1.x * r, z: b.z - u1.z * r };
      const p2 = { x: b.x + u2.x * r, z: b.z + u2.z * r };
      const w0 = (1 - t) * (1 - t);
      const w1 = 2 * t * (1 - t);
      const w2 = t * t;
      out.push({ x: p0.x * w0 + b.x * w1 + p2.x * w2, z: p0.z * w0 + b.z * w1 + p2.z * w2 });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function roadTexture(renderer: THREE.WebGLRenderer) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5a5b5c';
  g.fillRect(0, 0, 64, 128);
  for (let k = 0; k < 500; k++) {
    g.fillStyle = `rgba(${k % 2 ? 255 : 0},${k % 2 ? 255 : 0},${k % 2 ? 255 : 0},0.06)`;
    g.fillRect((k * 37) % 64, (k * 53) % 128, 2, 2);
  }
  g.fillStyle = '#d8d6cc';
  g.fillRect(2, 0, 2, 128);
  g.fillRect(60, 0, 2, 128);
  g.fillRect(31, 0, 2, 64);
  const t = canvasTex(c, renderer);
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function securityRoad(plan: AirfieldPlan, renderer: THREE.WebGLRenderer, origin: THREE.Vector3) {
  const r = plan.road;
  const apronSide = Math.sign(plan.ap.geo.apron.z0 - plan.runway.cz);
  // the road's corners in order round the loop, starting and ending at the gap on the terminal side
  const zT = apronSide < 0 ? r[0].z : r[2].z;
  const zF = apronSide < 0 ? r[2].z : r[0].z;
  const x0 = r[0].x;
  const x1 = r[1].x;
  const path = rounded(
    [
      { x: plan.roadGap.x1, z: zT },
      { x: x1, z: zT },
      { x: x1, z: zF },
      { x: x0, z: zF },
      { x: x0, z: zT },
      { x: plan.roadGap.x0, z: zT },
    ],
    30,
  );
  const W = 2.6;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let s = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / L;
    const nz = (b.x - a.x) / L;
    if (i > 0) s += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    const p = path[i];
    pos.push(p.x + nx * W - origin.x, 0.04 - origin.y, p.z + nz * W - origin.z, p.x - nx * W - origin.x, 0.04 - origin.y, p.z - nz * W - origin.z);
    uv.push(0, s / 12, 1, s / 12);
    if (i > 0) {
      const q = (i - 1) * 2;
      // wound to face up
      idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({ map: roadTexture(renderer), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
  );
  mesh.position.copy(origin);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------------------------------------
// Windsocks
// ------------------------------------------------------------------------------------------------

const SOCK_RINGS = 13;
const SOCK_SIDES = 12;
const SOCK_LEN = 3.6;

/**
 * The airfield's windsocks: orange and white cones on swivels, 3.6 m long and 0.9 m across the
 * mouth (ICAO), one mesh for all of them. They hang limp in a calm, lift section by section as
 * the wind rises and stand straight out from 15 kt, flapping a little.
 */
export class Windsocks {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private fromDeg = 270;
  private kt = 8;
  private shown = 0;

  constructor(
    private spots: P2[],
    private origin: THREE.Vector3,
  ) {
    const per = SOCK_RINGS * SOCK_SIDES;
    const n = per * spots.length;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    const col = new Float32Array(n * 3);
    const orange = new THREE.Color(ORANGE);
    const white = new THREE.Color('#f2f0ea');
    const idx: number[] = [];
    for (let s = 0; s < spots.length; s++)
      for (let i = 0; i < SOCK_RINGS; i++) {
        // five bands, orange at the mouth and the tail
        const band = Math.min(4, Math.floor((i / (SOCK_RINGS - 1)) * 5 - 1e-6));
        const c = band % 2 ? white : orange;
        for (let j = 0; j < SOCK_SIDES; j++) {
          const v = s * per + i * SOCK_SIDES + j;
          col.set([c.r, c.g, c.b], v * 3);
          if (i < SOCK_RINGS - 1) {
            const a = v;
            const b = s * per + i * SOCK_SIDES + ((j + 1) % SOCK_SIDES);
            idx.push(a, a + SOCK_SIDES, b, b, a + SOCK_SIDES, b + SOCK_SIDES);
          }
        }
      }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
    this.mesh.position.copy(origin);
    this.mesh.frustumCulled = false;
    this.shape(0);
    g.computeBoundingSphere();
  }

  setWind(fromDeg: number, kt: number) {
    this.fromDeg = fromDeg;
    this.kt = kt;
  }

  /** Re-shape the socks (call while they're in view; ~20 Hz is plenty). */
  update(t: number) {
    if (t - this.shown < 0.05) return;
    this.shown = t;
    this.shape(t);
  }

  private shape(t: number) {
    const fill = THREE.MathUtils.clamp(this.kt / 15, 0, 1);
    const down = headingVec(this.fromDeg + 180);
    const arr = this.pos.array as Float32Array;
    const per = SOCK_RINGS * SOCK_SIDES;
    const ds = SOCK_LEN / (SOCK_RINGS - 1);
    for (let s = 0; s < this.spots.length; s++) {
      const sp = this.spots[s];
      const ph = s * 2.1;
      // the swivel weathervanes round its mast a little behind the gusts
      const yaw = Math.atan2(down.x, down.z) + Math.sin(t * 0.7 + ph) * 0.05 * fill;
      let x = 0;
      let y = 6.6;
      let z = 0;
      for (let i = 0; i < SOCK_RINGS; i++) {
        const u = i / (SOCK_RINGS - 1);
        // droop below horizontal: limp when calm, sections beyond the filled part hang down
        let droop = THREE.MathUtils.lerp(1.42, 0.08, fill) + Math.max(0, u - fill) * 0.9;
        droop += Math.sin(t * 8.5 + u * 6 + ph) * 0.05 * fill * u;
        droop = Math.min(droop, 1.5);
        const wob = Math.sin(t * 6.1 + u * 4.5 + ph) * 0.06 * fill * u;
        const dx = Math.sin(yaw + wob) * Math.cos(droop);
        const dz = Math.cos(yaw + wob) * Math.cos(droop);
        const dy = -Math.sin(droop);
        if (i > 0) {
          x += dx * ds;
          y += dy * ds;
          z += dz * ds;
        }
        // the cone tapers from the mouth; unfilled sections collapse flat
        const r = THREE.MathUtils.lerp(0.45, 0.22, u);
        const limp = THREE.MathUtils.smoothstep(u, fill - 0.05, fill + 0.25);
        // the ring's frame: across (horizontal, square to the sock) and up-ish (square to both)
        const ax = Math.cos(yaw + wob);
        const az = -Math.sin(yaw + wob);
        const ux = -dy * Math.sin(yaw + wob);
        const uy = Math.cos(droop);
        const uz = -dy * Math.cos(yaw + wob);
        for (let j = 0; j < SOCK_SIDES; j++) {
          const a = (j / SOCK_SIDES) * Math.PI * 2;
          const ca = Math.cos(a) * r;
          const sa = Math.sin(a) * r * (1 - 0.65 * limp);
          const k = (s * per + i * SOCK_SIDES + j) * 3;
          arr[k] = sp.x - this.origin.x + x + ax * ca + ux * sa;
          arr[k + 1] = y - this.origin.y + uy * sa;
          arr[k + 2] = sp.z - this.origin.z + z + az * ca + uz * sa;
        }
      }
    }
    this.pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}
