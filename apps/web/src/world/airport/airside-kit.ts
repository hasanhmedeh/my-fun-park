// The airside's building blocks: a geometry kit that merges boxes, cylinders and shapes into one
// vertex-coloured mesh per material, the shared materials (painted surfaces, tinted glass, the
// concrete of the service areas, the signs), and the lamp flares that read from kilometres away.
//
// Every vertex carries its daylight colour and a night glow (a lit window, a lamp's lens, a cab's
// interior): one material lights them all from a single `uNight` uniform, so a whole airport's
// buildings and vehicles draw in a handful of calls. Vertices are stored relative to each
// airport's own origin, which keeps them precise 40 km from the world's.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fogSun, withFogSun } from '../fog';
import { canvasTex } from '../textures';

// ------------------------------------------------------------------------------------------------
// Placement
// ------------------------------------------------------------------------------------------------

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** A transform: position, yaw (rotation about y, park convention), then optional pitch / roll and scale. */
export function at(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** A glow: linear RGB emissive radiance, and whether it shines by day as well (1) or only at night (0). */
export type Glow = readonly [number, number, number, number];
export const NO_GLOW: Glow = [0, 0, 0, 0];
/** Warm interior light through office windows. */
export const WINDOW_GLOW: Glow = [1.25, 0.95, 0.6, 0];
/** Cool white of hangar and workshop lighting (on day and night). */
export const HANGAR_GLOW: Glow = [1.6, 1.65, 1.7, 1];
/** The tower cab's consoles and radar screens through the tinted glass. */
export const CAB_GLOW: Glow = [0.35, 0.75, 0.65, 0];
/** Vehicle headlights' lenses and tail lights. */
export const HEAD_GLOW: Glow = [3, 2.9, 2.6, 0];
export const TAIL_GLOW: Glow = [2.4, 0.1, 0.05, 0];

// ------------------------------------------------------------------------------------------------
// The kit
// ------------------------------------------------------------------------------------------------

/**
 * Collects coloured primitives into one geometry. Each primitive is painted with a flat colour
 * (sRGB hex, converted to the linear vertex colour the renderer expects) and a glow.
 */
export class Kit {
  private parts: THREE.BufferGeometry[] = [];
  private readonly col = new THREE.Color();

  /** Add any indexed geometry, painted and placed. */
  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4 | null, glow: Glow = NO_GLOW) {
    const geo = g.index ? g : indexed(g);
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (m) geo.applyMatrix4(m);
    const n = geo.attributes.position.count;
    this.col.set(color);
    const c = new Float32Array(n * 3);
    const e = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      c[i * 3] = this.col.r;
      c[i * 3 + 1] = this.col.g;
      c[i * 3 + 2] = this.col.b;
      e.set(glow, i * 4);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geo.setAttribute('glow', new THREE.BufferAttribute(e, 4));
    this.parts.push(geo);
    return this;
  }

  /** A box w × h × d standing on its base (y = 0 at the bottom), then placed. */
  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, m: THREE.Matrix4, glow: Glow = NO_GLOW) {
    return this.add(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), color, m, glow);
  }

  /** A box centred on its middle. */
  boxC(w: number, h: number, d: number, color: THREE.ColorRepresentation, m: THREE.Matrix4, glow: Glow = NO_GLOW) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, m, glow);
  }

  /** An upright cylinder (or cone frustum) standing on its base. */
  cyl(rTop: number, rBot: number, h: number, seg: number, color: THREE.ColorRepresentation, m: THREE.Matrix4, glow: Glow = NO_GLOW, open = false) {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open).translate(0, h / 2, 0), color, m, glow);
  }

  /** A wheel: a cylinder on its side (axis along x), centred. */
  wheel(r: number, w: number, color: THREE.ColorRepresentation, m: THREE.Matrix4) {
    return this.add(new THREE.CylinderGeometry(r, r, w, 14).rotateZ(Math.PI / 2), color, m);
  }

  /** A flat polygon (x, z outline, counter-clockwise from above) extruded up by h. */
  prism(pts: [number, number][], h: number, color: THREE.ColorRepresentation, m: THREE.Matrix4, glow: Glow = NO_GLOW) {
    const s = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2);
    return this.add(g, color, m, glow);
  }

  get empty() {
    return this.parts.length === 0;
  }

  /** Merge everything added so far into one geometry (and start afresh). */
  build(): THREE.BufferGeometry {
    const g = this.parts.length ? mergeGeometries(this.parts, false)! : emptyGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

function indexed(g: THREE.BufferGeometry) {
  const n = g.attributes.position.count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function emptyGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(12), 4));
  g.setIndex([0, 1, 2]);
  return g;
}

// ------------------------------------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------------------------------------

/** The night level every airside material reads (0 by day .. 1 at night). */
export interface NightUniform {
  uNight: THREE.IUniform<number>;
}

/**
 * A vertex-coloured standard material whose `glow` attribute lights up at night (or always, for
 * glows marked so). `key` names the shader variant so materials with the same hook share it.
 */
export function kitMaterial(u: NightUniform, params: THREE.MeshStandardMaterialParameters, key: string) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.05, ...params });
  m.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uNight = u.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 glow;\nvarying vec4 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec4 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow.rgb * max(uNight, vGlow.a);');
  };
  m.customProgramCacheKey = () => `airside-${key}`;
  return m;
}

/** The shared materials of one airport's airside. */
export interface KitMaterials {
  u: NightUniform;
  /** Painted metal, concrete, cladding, vehicles. */
  paint: THREE.MeshStandardMaterial;
  /** Tinted, reflective glazing (the tower cab, offices, the bus). */
  glass: THREE.MeshStandardMaterial;
}

export function kitMaterials(): KitMaterials {
  const u: NightUniform = { uNight: { value: 0 } };
  return {
    u,
    paint: kitMaterial(u, {}, 'paint'),
    glass: kitMaterial(u, { roughness: 0.06, metalness: 0.85, envMapIntensity: 1.4 }, 'glass'),
  };
}

// ------------------------------------------------------------------------------------------------
// Service-area paving: concrete slabs and asphalt roads, with world-space texture coordinates
// ------------------------------------------------------------------------------------------------

/** Paving sits this high, above the airfield's own ground (0.03) and its paint (0.06). */
export const PAD_Y = 0.075;

let concreteTex: THREE.CanvasTexture | null = null;
/** A 10 m tile of concrete: four 5 m slabs with sealed joints, mottled and lightly stained. */
function concreteTexture(renderer: THREE.WebGLRenderer) {
  if (concreteTex) return concreteTex;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#bdbdbd';
  g.fillRect(0, 0, S, S);
  // a seeded mottle so every tile is the same and the repeat is hard to spot at a glance
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const v = 170 + rnd() * 60;
    g.fillStyle = `rgba(${v},${v},${v - 4},${0.05 + rnd() * 0.08})`;
    const r = 4 + rnd() * 26;
    g.beginPath();
    g.arc(rnd() * S, rnd() * S, r, 0, Math.PI * 2);
    g.fill();
  }
  // tyre and oil stains
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(40,38,34,${0.03 + rnd() * 0.05})`;
    g.beginPath();
    g.ellipse(rnd() * S, rnd() * S, 6 + rnd() * 30, 3 + rnd() * 10, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(55,55,55,0.55)';
  g.lineWidth = 3;
  for (const p of [1.5, S / 2]) {
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, S);
    g.moveTo(0, p);
    g.lineTo(S, p);
    g.stroke();
  }
  concreteTex = canvasTex(c, renderer);
  concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping;
  return concreteTex;
}

/** Rectangles of paving (concrete, asphalt or gravel by colour) merged into one mesh. */
export class Paving {
  private rects: { x0: number; x1: number; z0: number; z1: number; color: string }[] = [];

  rect(x0: number, x1: number, z0: number, z1: number, color = '#ffffff') {
    this.rects.push({ x0, x1, z0, z1, color });
    return this;
  }

  /** The mesh, its vertices relative to `origin`; the tile repeats every 10 m in world space. */
  build(origin: THREE.Vector3, renderer: THREE.WebGLRenderer, u: NightUniform) {
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const c = new THREE.Color();
    for (const r of this.rects) {
      const b = pos.length / 3;
      c.set(r.color);
      for (const [x, z] of [
        [r.x0, r.z0],
        [r.x1, r.z0],
        [r.x1, r.z1],
        [r.x0, r.z1],
      ]) {
        pos.push(x - origin.x, PAD_Y, z - origin.z);
        uv.push(x / 10, -z / 10);
        col.push(c.r, c.g, c.b);
      }
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const n = pos.length / 3;
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(n * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = kitMaterial(u, { map: concreteTexture(renderer), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, 'paving');
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(origin);
    mesh.receiveShadow = true;
    mesh.name = 'airside-paving';
    return mesh;
  }
}

// ------------------------------------------------------------------------------------------------
// Signs: lettering painted into one canvas atlas, on textured quads
// ------------------------------------------------------------------------------------------------

export interface SignSpec {
  text: string;
  /** Board colour and letter colour; `font` defaults to the display font. */
  bg: string;
  fg: string;
  font?: string;
  /** Sign size (m) and where it hangs: centre, facing heading `ry` (park yaw: 0 faces north). */
  w: number;
  h: number;
  m: THREE.Matrix4;
  /** Lit at night (back-lit lettering). */
  lit?: boolean;
}

/**
 * All of one airport's signs in one mesh: each sign's lettering is drawn into a strip of the atlas
 * and mapped onto a quad. Lit signs glow at night through the same night uniform.
 */
export function signMesh(specs: SignSpec[], origin: THREE.Vector3, renderer: THREE.WebGLRenderer, u: NightUniform, font: string) {
  const W = 2048;
  const rowH = 128;
  const rows = Math.max(1, specs.length);
  const H = THREE.MathUtils.ceilPowerOfTwo(rows * rowH);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const glow: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  specs.forEach((s, i) => {
    // the strip's width follows the sign's aspect so the letters aren't stretched
    const sw = Math.min(W, Math.round((rowH * s.w) / s.h));
    const y0 = i * rowH;
    g.fillStyle = s.bg;
    g.fillRect(0, y0, sw, rowH);
    g.fillStyle = s.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = rowH * 0.62;
    g.font = `${size}px ${s.font ?? font}`;
    const tw = g.measureText(s.text).width;
    if (tw > sw * 0.9) {
      size *= (sw * 0.9) / tw;
      g.font = `${size}px ${s.font ?? font}`;
    }
    g.fillText(s.text, sw / 2, y0 + rowH * 0.54);
    const b = pos.length / 3;
    nm.getNormalMatrix(s.m);
    nv.set(0, 0, -1).applyMatrix3(nm).normalize();
    const u0 = 0;
    const u1 = sw / W;
    const v0 = 1 - (y0 + rowH) / H;
    const v1 = 1 - y0 / H;
    // the quad faces −z in its own frame (towards a viewer standing north of a yaw-0 sign)
    for (const [qx, qy, tu, tv] of [
      [s.w / 2, -s.h / 2, u0, v0],
      [-s.w / 2, -s.h / 2, u1, v0],
      [-s.w / 2, s.h / 2, u1, v1],
      [s.w / 2, s.h / 2, u0, v1],
    ]) {
      v.set(qx, qy, 0).applyMatrix4(s.m);
      pos.push(v.x - origin.x, v.y - origin.y, v.z - origin.z);
      uv.push(tu, tv);
      nrm.push(nv.x, nv.y, nv.z);
      const k = s.lit ? 1 : 0;
      glow.push(0.9 * k, 0.9 * k, 0.85 * k, 0);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 4));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const tex = canvasTex(c, renderer);
  // the glow is the lettering's own colour, so a lit sign shows its words, not a white panel
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.1 });
  m.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uNight = u.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 glow;\nvarying vec4 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec4 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow.rgb * uNight;');
  };
  m.customProgramCacheKey = () => 'airside-signs';
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.copy(origin);
  mesh.name = 'airside-signs';
  return mesh;
}

// ------------------------------------------------------------------------------------------------
// Lamp flares
// ------------------------------------------------------------------------------------------------

/** How a lamp shines: steady, a rotating beacon's flash, a double strobe, or a slow obstruction blink. */
export type LampMode = 'steady' | 'beacon' | 'strobe' | 'blink';
const MODE: Record<LampMode, number> = { steady: 0, beacon: 1, strobe: 2, blink: 3 };

export interface LampSpec {
  x: number;
  y: number;
  z: number;
  /** Linear HDR colour (above 1 blooms). */
  r: number;
  g: number;
  b: number;
  /** Apparent size up close (m). */
  size: number;
  mode: LampMode;
  /** How much of its brightness it keeps by day (0 night only .. 1 always). */
  day: number;
  /** Phase offset (0..1) so neighbouring beacons don't flash in step. */
  phase?: number;
  /** Aimed lamps (floodlights): the direction they face, and how widely they're seen (cosine). */
  dir?: [number, number, number];
  spread?: number;
}

const LAMP_VERT = /* glsl */ `
attribute vec3 aColour;
attribute vec4 aParam;   // size, mode, phase, day
attribute vec4 aDir;     // aim (xyz, 0 = omni), cosine where it's gone
attribute float aOn;
uniform float uViewH;
uniform float uMinPx;
uniform float uNight;
uniform float uTime;
varying vec3 vColour;
varying float vCore;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 toEye = normalize(cameraPosition - world.xyz);
  float k = aOn * mix(aParam.w, 1.0, uNight);
  if (dot(aDir.xyz, aDir.xyz) > 0.0) k *= mix(0.25, 1.0, smoothstep(aDir.w, 1.0, dot(normalize(aDir.xyz), toEye)));
  float mode = aParam.y;
  float ph = fract(uTime * 0.9 + aParam.z);
  if (mode > 0.5 && mode < 1.5) k *= 0.08 + exp(-pow(ph - 0.5, 2.0) / 0.006);
  else if (mode > 1.5 && mode < 2.5) { float sp = fract(uTime / 1.2 + aParam.z); k *= (sp < 0.04 || (sp > 0.12 && sp < 0.16)) ? 1.0 : 0.0; }
  else if (mode > 2.5) k *= step(0.45, fract(uTime / 1.6 + aParam.z));
  vec4 mvPosition = viewMatrix * world;
  float dist = max(0.5, -mvPosition.z);
  mvPosition.xyz += normalize(-mvPosition.xyz) * min(0.6, dist * 0.3);
  gl_Position = projectionMatrix * mvPosition;
  float px = aParam.x * uViewH * projectionMatrix[1][1] / (2.0 * dist) * 3.0;
  float size = max(px, uMinPx);
  k *= mix(1.0, sqrt(clamp(px / uMinPx, 0.0, 1.0)), 0.5);
  vCore = clamp(px / 14.0, 0.0, 1.0);
  vColour = aColour * k;
  gl_PointSize = k > 0.003 ? size : 0.0;
  #include <fog_vertex>
}`;

const LAMP_FRAG = /* glsl */ `
varying vec3 vColour;
varying float vCore;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * mix(3.5, 36.0, vCore)) + exp(-r2 * 4.0) * 0.26;
  float fade = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    fade = 1.0 - fogFactor * 0.8;
  #endif
  gl_FragColor = vec4(vColour * a * fade, 1.0);
}`;

/**
 * A set of lamps in one draw: steady or flashing point sprites sized by distance, never smaller
 * than a few pixels. Positions are relative to the object (moving vehicles' lamps are rewritten
 * each frame through `move`).
 */
export class Lamps {
  readonly points: THREE.Points;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly onAttr: THREE.BufferAttribute;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly size = new THREE.Vector2();

  constructor(specs: LampSpec[], origin: THREE.Vector3, dynamic = false) {
    const n = Math.max(1, specs.length);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const par = new Float32Array(n * 4);
    const dir = new Float32Array(n * 4);
    specs.forEach((s, i) => {
      pos.set([s.x - origin.x, s.y - origin.y, s.z - origin.z], i * 3);
      col.set([s.r, s.g, s.b], i * 3);
      par.set([s.size, MODE[s.mode], s.phase ?? 0, s.day], i * 4);
      dir.set([...(s.dir ?? [0, 0, 0]), s.spread ?? 0], i * 4);
    });
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    if (dynamic) this.posAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aColour', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aParam', new THREE.BufferAttribute(par, 4));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 4));
    this.onAttr = new THREE.BufferAttribute(new Float32Array(n).fill(specs.length ? 1 : 0), 1);
    this.onAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOn', this.onAttr);
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uViewH: { value: 720 }, uMinPx: { value: 3 }, uNight: { value: 0 }, uTime: { value: 0 } }]);
    const m = new THREE.ShaderMaterial({
      vertexShader: LAMP_VERT,
      fragmentShader: LAMP_FRAG,
      uniforms: this.uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    Object.assign(m.uniforms, fogSun);
    this.points = new THREE.Points(g, m);
    this.points.position.copy(origin);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.size);
      this.uniforms.uViewH.value = this.size.y;
      this.uniforms.uMinPx.value = 3 * renderer.getPixelRatio();
    };
  }

  /** The clock (flashing) and the night level (lamps that are dark by day). */
  update(t: number, night: number) {
    this.uniforms.uTime.value = t;
    this.uniforms.uNight.value = night;
  }

  /** Move lamp `i` (relative to the object's origin). Call `commit` after a batch. */
  move(i: number, x: number, y: number, z: number) {
    this.posAttr.setXYZ(i, x, y, z);
  }

  /** Switch lamp `i` on or off. */
  set(i: number, on: number) {
    this.onAttr.setX(i, on);
  }

  commit() {
    this.posAttr.needsUpdate = true;
    this.onAttr.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------------------------------------
// Light pools on the ground under floodlights (additive soft discs, night only)
// ------------------------------------------------------------------------------------------------

let poolTex: THREE.CanvasTexture | null = null;
function poolTexture(renderer: THREE.WebGLRenderer) {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,236,200,1)');
  gr.addColorStop(0.45, 'rgba(255,226,180,0.55)');
  gr.addColorStop(1, 'rgba(255,220,170,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  poolTex = canvasTex(c, renderer);
  return poolTex;
}

/** Ellipses of light on the apron: x, z, radii along / across, yaw. */
export function lightPools(pools: { x: number; z: number; rx: number; rz: number; ry: number }[], origin: THREE.Vector3, renderer: THREE.WebGLRenderer) {
  const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: poolTexture(renderer),
    color: '#000000',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    fog: true,
  });
  const mesh = new THREE.InstancedMesh(quad, mat, Math.max(1, pools.length));
  pools.forEach((p, i) => mesh.setMatrixAt(i, at(p.x - origin.x, PAD_Y + 0.04, p.z - origin.z, p.ry, 0, 0, p.rx, 1, p.rz)));
  mesh.count = pools.length;
  mesh.position.copy(origin);
  mesh.renderOrder = 2;
  mesh.computeBoundingSphere();
  mesh.name = 'airside-pools';
  return {
    mesh,
    /** Brightness: the pools are only there at night. */
    set(k: number) {
      mat.color.setScalar(0.42 * k);
      mesh.visible = k > 0.02;
    },
  };
}
