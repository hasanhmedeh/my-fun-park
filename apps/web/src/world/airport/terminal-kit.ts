// Shared building kit for Funfair International's landside: the terminal, its jet bridges, the
// forecourt and the SkyLink. Everything static is poured into a few big merged meshes, one per
// material (the whole terminal is a handful of draw calls), with colour carried per vertex instead
// of per material. The materials, the grain textures and the night lighting are shared by every
// module that builds with the kit, so the terminal, the forecourt and the stations light up together.

import * as THREE from 'three';
import { staticBox, type Ctx } from '../context';
import { withFogSun } from '../fog';
import { canvasTex } from '../textures';

/** A walkable rectangle on the ground (y = 0). */
export interface WalkRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
/** A point on the ground. */
export interface V2 {
  x: number;
  z: number;
}
/** A point in the world. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}
/** A rectangle of texture space. */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

// ------------------------------------------------------------------------------------------------
// Geometry accumulator
// ------------------------------------------------------------------------------------------------

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_BLOB = new THREE.IcosahedronGeometry(1, 1);
const UNIT_BLOB_LO = new THREE.IcosahedronGeometry(1, 0);
const cylinders = new Map<string, THREE.CylinderGeometry>();
function unitCylinder(seg: number, open: boolean) {
  const key = `${seg}${open}`;
  let g = cylinders.get(key);
  if (!g) cylinders.set(key, (g = new THREE.CylinderGeometry(1, 1, 1, seg, 1, open)));
  return g;
}

/**
 * Collects geometry (positions, normals, uvs, vertex colours, night glow) for one merged mesh.
 * Every primitive goes in through `add` with its own matrix and colour; `build` hands back one
 * indexed geometry.
 */
export class Kit {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private glw: number[] = [];
  private idx: number[] = [];
  /**
   * How strongly what's added next glows at night (0..1): lit windows, light boxes, the inside of
   * a tunnel seen through its glass. The kit's materials light it with the shared night uniform.
   */
  glow = 0;
  private readonly c = new THREE.Color();
  private readonly m = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly t = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  get vertexCount() {
    return this.pos.length / 3;
  }

  /** Adds a geometry transformed by `matrix`, painted `color` (multiplied into its own colours, if any); its uvs squeezed into `uv`. */
  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color: THREE.ColorRepresentation, uv?: UvRect) {
    const p = geo.attributes.position as THREE.BufferAttribute;
    const n = geo.attributes.normal as THREE.BufferAttribute | undefined;
    const t = geo.attributes.uv as THREE.BufferAttribute | undefined;
    const vc = geo.attributes.color as THREE.BufferAttribute | undefined;
    const base = this.pos.length / 3;
    const m = matrix ?? this.m.identity();
    this.nm.getNormalMatrix(m);
    this.c.set(color);
    for (let i = 0; i < p.count; i++) {
      this.v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      if (n) this.v.fromBufferAttribute(n, i).applyMatrix3(this.nm).normalize();
      else this.v.set(0, 1, 0);
      this.nor.push(this.v.x, this.v.y, this.v.z);
      const u = t ? t.getX(i) : 0;
      const w = t ? t.getY(i) : 0;
      if (uv) this.uv.push(uv.u0 + (uv.u1 - uv.u0) * u, uv.v0 + (uv.v1 - uv.v0) * w);
      else this.uv.push(u, w);
      if (vc) this.col.push(this.c.r * vc.getX(i), this.c.g * vc.getY(i), this.c.b * vc.getZ(i));
      else this.col.push(this.c.r, this.c.g, this.c.b);
      this.glw.push(this.glow);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) this.idx.push(base + geo.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    return this;
  }

  /** An axis-aligned box by its centre and size, turned `rotY` about its centre. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.ColorRepresentation, rotY = 0) {
    this.q.setFromAxisAngle(this.up, rotY);
    this.m.compose(this.t.set(cx, cy, cz), this.q, this.s.set(sx, sy, sz));
    return this.add(UNIT_BOX, this.m, color);
  }

  /** A box from corner to corner (axis-aligned). */
  span(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: THREE.ColorRepresentation) {
    return this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), color);
  }

  /** An upright cylinder (or cone, r0 ≠ r1) standing on y0. */
  cyl(x: number, y0: number, z: number, r0: number, r1: number, h: number, color: THREE.ColorRepresentation, seg = 12) {
    // a unit cylinder scaled can't taper, so tapered ones are built fresh
    if (r0 !== r1) {
      const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, false);
      this.m.makeTranslation(x, y0 + h / 2, z);
      return this.add(g, this.m, color);
    }
    this.m.compose(this.t.set(x, y0 + h / 2, z), this.q.identity(), this.s.set(r0, h, r0));
    return this.add(unitCylinder(seg, false), this.m, color);
  }

  /** A squashed sphere (foliage, cushions, globes) centred at (x, y, z) with radii rx, ry, rz; `coarse` for small or far things (20 faces, not 80). */
  blob(x: number, y: number, z: number, rx: number, ry: number, rz: number, color: THREE.ColorRepresentation, coarse = false) {
    this.m.compose(this.t.set(x, y, z), this.q.identity(), this.s.set(rx, ry, rz));
    return this.add(coarse ? UNIT_BLOB_LO : UNIT_BLOB, this.m, color);
  }

  /** A round bar from a to b. */
  bar(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, color: THREE.ColorRepresentation, seg = 6) {
    const d = this.v.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = d.length();
    if (len < 1e-4) return this;
    this.q.setFromUnitVectors(this.up, d.divideScalar(len));
    this.m.compose(this.t.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), this.q, this.s.set(r, len, r));
    return this.add(unitCylinder(seg, true), this.m, color);
  }

  /** A rectangular-section beam from a to b (`w` wide across, `h` deep), kept upright. */
  beam(a: THREE.Vector3Like, b: THREE.Vector3Like, w: number, h: number, color: THREE.ColorRepresentation) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return this;
    const fwd = new THREE.Vector3(dx, dy, dz).divideScalar(len);
    const side = new THREE.Vector3().crossVectors(fwd, this.up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const up = new THREE.Vector3().crossVectors(side, fwd);
    this.m.makeBasis(side.multiplyScalar(w), up.multiplyScalar(h), fwd.multiplyScalar(len));
    this.m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return this.add(UNIT_BOX, this.m, color);
  }

  /**
   * An upright prism: the outline (x, z points, either winding) extruded from y0 to y1. Counters,
   * kerbs round a bend, curved desks.
   */
  prism(outline: V2[], y0: number, y1: number, color: THREE.ColorRepresentation) {
    // the shape's y is −z so that, turned −90° about x, its extrusion rises along +y
    const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 });
    this.m.makeRotationX(-Math.PI / 2).setPosition(0, y0, 0);
    this.add(g, this.m, color);
    g.dispose();
    return this;
  }

  /**
   * A flat quad through four corners, given counter-clockwise as seen from its front; the uvs run
   * (0,0) at the first corner to (1,1) at the third, squeezed into `uv`.
   */
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, color: THREE.ColorRepresentation, uv?: UvRect) {
    const base = this.pos.length / 3;
    const e1 = this.t.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const e2 = this.s.set(d.x - a.x, d.y - a.y, d.z - a.z);
    const nrm = e1.cross(e2).normalize();
    this.c.set(color);
    const r = uv ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
    const us = [r.u0, r.u1, r.u1, r.u0];
    const vs = [r.v0, r.v0, r.v1, r.v1];
    const corners = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(nrm.x, nrm.y, nrm.z);
      this.uv.push(us[i], vs[i]);
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.glw.push(this.glow);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  /** An upright panel `w` × `h` centred at (x, y, z), its front facing heading `facing` (radians, 0 = north/−z, π/2 = east). */
  panel(x: number, y: number, z: number, w: number, h: number, facing: number, color: THREE.ColorRepresentation, uv?: UvRect) {
    // the front faces along (sin f, 0, −cos f); a viewer in front of it, looking back at it, has
    // (−cos f, 0, −sin f) on their right
    const rx = -Math.cos(facing) * (w / 2);
    const rz = -Math.sin(facing) * (w / 2);
    const hh = h / 2;
    return this.quad(
      { x: x - rx, y: y - hh, z: z - rz },
      { x: x + rx, y: y - hh, z: z + rz },
      { x: x + rx, y: y + hh, z: z + rz },
      { x: x - rx, y: y + hh, z: z - rz },
      color,
      uv,
    );
  }

  /** A horizontal rectangle at height y (facing up, or down when `down`). */
  floor(x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.ColorRepresentation, uv?: UvRect, down = false) {
    if (down) return this.quad({ x: x0, y, z: z0 }, { x: x1, y, z: z0 }, { x: x1, y, z: z1 }, { x: x0, y, z: z1 }, color, uv);
    return this.quad({ x: x0, y, z: z1 }, { x: x1, y, z: z1 }, { x: x1, y, z: z0 }, { x: x0, y, z: z0 }, color, uv);
  }

  /** Planar uvs in metres (u along x, v along z, `scale` metres per repeat) for everything added since vertex `from`. */
  worldUvXZ(from: number, scale: number) {
    for (let i = from; i < this.pos.length / 3; i++) {
      this.uv[i * 2] = this.pos[i * 3] / scale;
      this.uv[i * 2 + 1] = this.pos[i * 3 + 2] / scale;
    }
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(this.glw, 1));
    // big merged meshes pass 65,535 vertices easily
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ------------------------------------------------------------------------------------------------
// Textures
// ------------------------------------------------------------------------------------------------

export function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Polished terrazzo: a pale ground with chips of stone, tileable, near white so vertex colours show through. */
function terrazzoTexture(renderer: THREE.WebGLRenderer) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f2ee';
  g.fillRect(0, 0, S, S);
  const rnd = seeded(91);
  const chips = ['#d9d4cc', '#c9c2b8', '#e9e5df', '#b8b2aa', '#fbfaf8', '#a59f98'];
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 0.6 + rnd() * rnd() * 3.2;
    g.fillStyle = chips[Math.floor(rnd() * chips.length)];
    g.beginPath();
    // wrap the chips across the edges so the tile repeats seamlessly
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      g.moveTo(x + ox + r, y + oy);
      g.ellipse(x + ox, y + oy, r, r * (0.6 + rnd() * 0.4), rnd() * Math.PI, 0, Math.PI * 2);
    }
    g.fill();
  }
  // the joints between the 1.2 m slabs (the texture repeats every 2.4 m: two slabs a side)
  g.fillStyle = 'rgba(120, 112, 104, 0.35)';
  g.fillRect(0, 0, S, 2);
  g.fillRect(0, S / 2 - 1, S, 2);
  g.fillRect(0, 0, 2, S);
  g.fillRect(S / 2 - 1, 0, 2, S);
  const t = canvasTex(c, renderer);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Asphalt / concrete grain: fine speckle around mid-grey-white, tileable. */
function grainTexture(renderer: THREE.WebGLRenderer) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const rnd = seeded(37);
  // two octaves of value noise for blotches, plus per-pixel grit
  const N = 32;
  const grid = Float32Array.from({ length: N * N }, rnd);
  const at = (i: number, j: number) => grid[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * N;
      const fy = (y / S) * N;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const sx = fx - x0;
      const sy = fy - y0;
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      const blotch = a + (b - a) * sy;
      const v = 0.86 + blotch * 0.08 + (rnd() - 0.5) * 0.16;
      const i = (y * S + x) * 4;
      const k = Math.max(0, Math.min(255, v * 255));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = canvasTex(c, renderer);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The roof's underside: warm timber slats with dark gaps (one repeat = 1.2 m across the slats). */
function slatTexture(renderer: THREE.WebGLRenderer) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  const rnd = seeded(5);
  g.fillStyle = '#2a2018';
  g.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 4; i++) {
    const tone = 0.88 + rnd() * 0.12;
    g.fillStyle = `rgb(${Math.round(232 * tone)}, ${Math.round(196 * tone)}, ${Math.round(150 * tone)})`;
    g.fillRect(i * 64 + 4, 0, 52, 64);
    // grain
    for (let k = 0; k < 30; k++) {
      g.fillStyle = `rgba(120, 80, 40, ${0.05 + rnd() * 0.08})`;
      g.fillRect(i * 64 + 4 + rnd() * 52, 0, 1 + rnd() * 2, 64);
    }
  }
  const t = canvasTex(c, renderer);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The roof's top: standing-seam metal sheet (seams every 0.6 m), pale silver. */
function seamTexture(renderer: THREE.WebGLRenderer) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e6e9ec';
  g.fillRect(0, 0, 128, 32);
  for (const x of [0, 64]) {
    g.fillStyle = '#9aa1a8';
    g.fillRect(x, 0, 3, 32);
    g.fillStyle = '#ffffff';
    g.fillRect(x + 3, 0, 2, 32);
  }
  const t = canvasTex(c, renderer);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function poolTex(renderer: THREE.WebGLRenderer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,226,180,1)');
  grad.addColorStop(0.4, 'rgba(255,210,150,0.45)');
  grad.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return canvasTex(c, renderer);
}

// ------------------------------------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------------------------------------

/**
 * The kit's materials. The vertex-coloured ones also read the kit's `glow` attribute: what was
 * built glowing lights up warm at night. `interior`, `floor` and `ceiling` add a soft fill (the
 * terminal's own lighting, brighter at night) on top of the sun and sky, since the roof shades
 * everything under it.
 */
export interface KitMaterials {
  /** Plaster, concrete, painted panels, furniture outside (vertex colours). */
  structure: THREE.MeshStandardMaterial;
  /** The same, indoors: a fill light keeps the hall bright under its roof. */
  interior: THREE.MeshStandardMaterial;
  /** Steel and aluminium: mullions, columns, trusses, rails (vertex colours). */
  metal: THREE.MeshStandardMaterial;
  /** Polished terrazzo floors (vertex colours × chips; uvs in metres / 2.4). */
  floor: THREE.MeshStandardMaterial;
  /** Asphalt, concrete paving (vertex colours × grain; uvs in metres / 6). */
  paving: THREE.MeshStandardMaterial;
  /** Painted road and kerb markings, drawn over the paving. */
  marking: THREE.MeshStandardMaterial;
  /** The roof's slatted timber underside (uvs: u across the slats in 1.2 m repeats). */
  ceiling: THREE.MeshStandardMaterial;
  /** The roof's standing-seam top (uvs: u across the seams in 1.2 m repeats). */
  roof: THREE.MeshStandardMaterial;
  /** Curtain walls, skylights, balustrades. */
  glass: THREE.MeshStandardMaterial;
  /** Light fittings, lit letters: unlit colour (vertex colours carry each one's brightness). */
  emitter: THREE.MeshBasicMaterial;
  /** Ground light pools under the lamps at night. */
  pool: THREE.MeshBasicMaterial;
  /** Shared uniforms: how much the glowing parts glow, and the halls' fill light. */
  night: { value: number };
  fill: { value: number };
}

const cache = new WeakMap<THREE.WebGLRenderer, KitMaterials>();
const NO_FILL = { value: 0 };

/** Teaches a vertex-coloured material the kit's glow attribute and (indoors) the fill light. */
function patch(mat: THREE.MeshStandardMaterial, key: string, fill: { value: number }, night: { value: number }) {
  mat.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uFill = fill;
    shader.uniforms.uGlow = night;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFill;\nuniform float uGlow;\nvarying float vGlow;')
      // the hall's lights (a soft, shadowless glow of the surface's own colour), and lamplight
      // behind lit glass: warm white, whatever colour the glass is by day
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uFill + vec3(1.0, 0.82, 0.58) * (vGlow * uGlow);',
      );
  };
  mat.customProgramCacheKey = () => `terminal-kit-${key}`;
}

/** The kit's shared materials (one set per renderer). */
export function kitMaterials(ctx: Ctx): KitMaterials {
  const hit = cache.get(ctx.renderer);
  if (hit) return hit;
  const r = ctx.renderer;
  const fill = { value: 0.12 };
  const night = { value: 0 };
  const vc = (roughness: number, metalness: number, key: string, f: { value: number }, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness, ...extra });
    patch(m, key, f, night);
    return m;
  };
  const ceiling = new THREE.MeshStandardMaterial({ map: slatTexture(r), roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  ceiling.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uFill = fill;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFill;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uFill;');
  };
  ceiling.customProgramCacheKey = () => 'terminal-kit-ceiling';
  const mats: KitMaterials = {
    structure: vc(0.82, 0.02, 'structure', NO_FILL),
    interior: vc(0.72, 0.02, 'interior', fill),
    metal: vc(0.36, 0.62, 'metal', NO_FILL),
    floor: vc(0.28, 0, 'floor', fill, { map: terrazzoTexture(r), envMapIntensity: 1.2 }),
    paving: vc(0.93, 0, 'paving', NO_FILL, { map: grainTexture(r), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    marking: vc(0.7, 0, 'marking', NO_FILL, { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
    ceiling,
    roof: new THREE.MeshStandardMaterial({ map: seamTexture(r), roughness: 0.42, metalness: 0.55 }),
    glass: new THREE.MeshStandardMaterial({
      color: '#a7c4d2',
      roughness: 0.04,
      metalness: 0.25,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.7,
    }),
    emitter: new THREE.MeshBasicMaterial({ vertexColors: true }),
    pool: new THREE.MeshBasicMaterial({
      map: poolTex(r),
      color: new THREE.Color('#ffc58a').multiplyScalar(0.5),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    }),
    night,
    fill,
  };
  // one pass for the glass, both faces at once (it's thin and see-through either way)
  mats.glass.forceSinglePass = true;
  cache.set(ctx.renderer, mats);
  setKitNight(mats, 0);
  return mats;
}

/** Day → night: the fittings, signs and the hall's fill brighten, lit windows glow, pools appear. */
export function setKitNight(m: KitMaterials, k: number) {
  const lerp = THREE.MathUtils.lerp;
  m.emitter.color.setScalar(lerp(1, 2.6, k));
  m.night.value = THREE.MathUtils.smoothstep(k, 0.05, 0.7) * 1.5;
  m.pool.opacity = THREE.MathUtils.smoothstep(k, 0.2, 0.9);
  m.pool.visible = k > 0.2;
  m.fill.value = lerp(0.12, 0.3, k);
}

/** A mesh of one material from a kit, shadowed as asked. */
export function kitMesh(kit: Kit, mat: THREE.Material, cast = false, receive = false) {
  const mesh = new THREE.Mesh(kit.build(), mat);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// ------------------------------------------------------------------------------------------------
// Colliders
// ------------------------------------------------------------------------------------------------

/**
 * A straight wall collider from (x0, z0) to (x1, z1), `h` high and `t` thick, split into pieces
 * of at most 100 m (the crowd ignores obstacles longer than 120 m as floor slabs).
 */
export function wallCollider(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, h = 4, t = 0.4) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.05) return;
  const n = Math.ceil(len / 100);
  const rot = -Math.atan2(z1 - z0, x1 - x0);
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) / n;
    staticBox(ctx, x0 + (x1 - x0) * a, h / 2, z0 + (z1 - z0) * a, len / n / 2, h / 2, t / 2, rot);
  }
}

/** A box collider by its footprint (x0..x1, z0..z1), from the ground up to h. */
export function blockCollider(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, h: number) {
  const hx = Math.abs(x1 - x0) / 2;
  const hz = Math.abs(z1 - z0) / 2;
  if (hx > 50 || hz > 50) {
    // long blocks become a row of shorter ones so the crowd still sees them
    const along = hx > hz;
    const L = along ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const n = Math.ceil(L / 100);
    for (let i = 0; i < n; i++) {
      const a0 = i / n;
      const a1 = (i + 1) / n;
      if (along) blockCollider(ctx, x0 + (x1 - x0) * a0, z0, x0 + (x1 - x0) * a1, z1, h);
      else blockCollider(ctx, x0, z0 + (z1 - z0) * a0, x1, z0 + (z1 - z0) * a1, h);
    }
    return;
  }
  staticBox(ctx, (x0 + x1) / 2, h / 2, (z0 + z1) / 2, hx, h / 2, hz);
}
