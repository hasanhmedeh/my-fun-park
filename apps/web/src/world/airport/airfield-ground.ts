// The airfield's ground: one mesh over the pavement and the runway strip, painted per pixel. The
// pavement's outline, its shoulders and the taxiway edge lines come from the distance-field
// texture (airfield-field.ts); the runway's own markings (piano keys, centreline, touchdown zone,
// aiming points, side stripes, blast pad chevrons), the runway-holding positions and the textures
// of the surfaces (grooved asphalt, rubber in the touchdown zones, concrete slabs on the apron,
// mowing stripes on the strip's grass) are worked out in the shader from the runway's numbers.
// Only two things lie on top: the thin painted lines (airfield-paint.ts) and the lettering
// (designators, stand numbers, hold signs), each one mesh drawn with a stronger depth offset, so
// from 1,500 m up or from the cockpit nothing z-fights.

import * as THREE from 'three';
import { withFogSun } from '../fog';
import { canvasTex, detailNormalTexture } from '../textures';
import { farFadeFog, noiseTexture } from '../terrain-shader';
import { headingVec } from '../geo';
import { PAVE_RANGE, type PaveField } from './airfield-field';
import { TAXI_HALF, type AirfieldPlan, type DecalSpec, type Rect } from './airfield-plan';

/** The ground sits this far above y = 0 (the land's mesh), the lettering a little higher. */
export const GROUND_Y = 0.03;
const DECAL_Y = 0.06;
/** The mown strip either side of the runway beyond the runway's ends (m). */
const STRIP_END = 60;

const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/** The grass strip round the runway that this mesh mows (the land beyond it is the terrain's). */
export function stripRect(plan: AirfieldPlan): Rect {
  const rw = plan.runway;
  const s = plan.ap.geo.runway.strip;
  return { x0: rw.cx - rw.halfLen - rw.blast - STRIP_END, x1: rw.cx + rw.halfLen + rw.blast + STRIP_END, z0: rw.cz - s, z1: rw.cz + s };
}

const fieldTextures = new WeakMap<PaveField, THREE.DataTexture>();
/** The field as a texture (one per field, shared by the ground and the strip overlay). */
function fieldTex(f: PaveField) {
  const had = fieldTextures.get(f);
  if (had) return had;
  const t = new THREE.DataTexture(f.data, f.w, f.h, THREE.RedFormat);
  t.unpackAlignment = 1;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.flipY = false;
  t.needsUpdate = true;
  fieldTextures.set(f, t);
  return t;
}

/** Flat quads at height y, with up normals and UVs of world metres / 4 (for the detail normal map). */
function flatGeometry(quads: Rect[], y: number) {
  const n = quads.length * 4;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const idx: number[] = [];
  quads.forEach((q, k) => {
    const corners = [q.x0, q.z0, q.x1, q.z0, q.x1, q.z1, q.x0, q.z1];
    for (let c = 0; c < 4; c++) {
      const v = k * 4 + c;
      pos.set([corners[c * 2], y, corners[c * 2 + 1]], v * 3);
      nrm.set([0, 1, 0], v * 3);
      uv.set([corners[c * 2] / 4, -corners[c * 2 + 1] / 4], v * 2);
    }
    // wound to face up
    idx.push(k * 4, k * 4 + 2, k * 4 + 1, k * 4, k * 4 + 3, k * 4 + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * The pavement's mesh: quads over the cells (24 m) that hold pavement or its shoulders, merged
 * along each row, so a 3.6 km runway is a handful of quads.
 */
function groundGeometry(plan: AirfieldPlan, f: PaveField) {
  const C = 24;
  const r = f.rect;
  const nx = Math.ceil((r.x1 - r.x0) / C);
  const nz = Math.ceil((r.z1 - r.z0) / C);
  const shoulder = plan.ap.geo.runway.shoulder;
  const cover = new Uint8Array(nx * nz);
  for (let j = 0; j < f.h; j++) {
    const cz = Math.min(nz - 1, Math.floor(((j + 0.5) * f.dz) / C));
    for (let i = 0; i < f.w; i++) {
      const d = PAVE_RANGE.lo + (f.data[j * f.w + i] / 255) * (PAVE_RANGE.hi - PAVE_RANGE.lo);
      if (d < shoulder + 1) cover[cz * nx + Math.min(nx - 1, Math.floor(((i + 0.5) * f.dx) / C))] = 1;
    }
  }
  const quads: Rect[] = [];
  for (let j = 0; j < nz; j++) {
    let run = -1;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && cover[j * nx + i] === 1;
      if (on && run < 0) run = i;
      if (!on && run >= 0) {
        quads.push({ x0: r.x0 + run * C, x1: Math.min(r.x1, r.x0 + i * C), z0: r.z0 + j * C, z1: Math.min(r.z1, r.z0 + (j + 1) * C) });
        run = -1;
      }
    }
  }
  return flatGeometry(quads, GROUND_Y);
}

/** GLSL: a hash, and box-filtered bands and stripes (exact for any pixel footprint, so no shimmer far away). */
const FILTERS = /* glsl */ `
float afHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// coverage of [a, b] for a pixel footprint w centred on x
float band(float x, float a, float b, float w) { w = max(w, 1e-4); return clamp((min(x + 0.5 * w, b) - max(x - 0.5 * w, a)) / w, 0.0, 1.0); }
// the same for stripes [0, on) repeating every p (the box filter of the pulse train)
float pulseInt(float x, float p, float on) { return floor(x / p) * on + min(mod(x, p), on); }
float stripes(float x, float p, float on, float w) { w = max(w, 1e-4); return (pulseInt(x + 0.5 * w, p, on) - pulseInt(x - 0.5 * w, p, on)) / w; }
`;

/** GLSL for the ground's colour: the surfaces and every marking. */
function groundGlsl(plan: AirfieldPlan) {
  const holds = plan.holds;
  const f = (v: number) => v.toFixed(3);
  return /* glsl */ `
uniform sampler2D uField;
uniform vec4 uFieldRect;
uniform sampler2D uNoise;
uniform vec4 uRw;
uniform vec4 uRw2;
uniform vec4 uApron;
uniform vec4 uHolds[${holds.length}];
varying vec3 vAfW;

${FILTERS}float box2(vec2 q, vec2 lo, vec2 hi, vec2 w) { return band(q.x, lo.x, hi.x, w.x) * band(q.y, lo.y, hi.y, w.y); }

vec3 airfieldColour(out float rough, out float keep) {
  vec2 p = vAfW.xz;
  vec2 fw = max(fwidth(p), vec2(1e-4));
  float pave = ${f(PAVE_RANGE.lo)} + texture2D(uField, (p - uFieldRect.xy) * uFieldRect.zw).r * ${f(PAVE_RANGE.hi - PAVE_RANGE.lo)};
  vec4 nA = texture2D(uNoise, p / 23.0);
  vec4 nB = texture2D(uNoise, p / 3.1);
  vec4 nC = texture2D(uNoise, p / 170.0);
  float grain = 0.9 + 0.2 * nB.x;

  // runway-local: along (x), across, distance from the nearer threshold and the side
  vec2 q = p - uRw.xy;
  float t = uRw.z - abs(q.x);
  float ay = abs(q.y);
  bool onRw = t > -uRw2.y && ay < uRw.w + uRw2.x;
  bool inApron = p.x > uApron.x && p.x < uApron.z && p.y > uApron.y && p.y < uApron.w;
  float shoulder = uRw2.x;
  keep = 1.0;
  rough = 0.88;

  // off the pavement and its shoulders the land shows through (the strip overlay mows it)
  if (pave > shoulder && !onRw) { keep = 0.0; return vec3(0.0); }

  // ---- the surfaces
  vec3 col;
  bool sh = pave > 0.0 && !(onRw && ay < uRw.w && t > -uRw2.y);
  if (onRw && t < 0.0) {
    // blast pad: older, paler asphalt
    col = ${lin('#57564f')} * grain * (0.94 + 0.12 * nA.y);
  } else if (onRw && ay < uRw.w) {
    // grooved runway asphalt: resurfacing lanes across, patches along, darker where the wheels run
    float lane = afHash(vec2(floor(q.y / 7.5), 3.0));
    float pch = afHash(vec2(floor(q.x / 61.0), floor(q.y / 15.0)));
    col = ${lin('#414244')} * grain * (0.95 + 0.06 * lane) * (0.97 + 0.06 * pch) * (0.92 + 0.16 * nA.z);
    col *= 1.0 - 0.06 * (1.0 - smoothstep(4.0, 16.0, ay));
  } else if (sh) {
    // paved shoulders: lighter, with a joint where they meet the pavement proper
    col = ${lin('#68655d')} * grain * (0.94 + 0.1 * nA.x);
    col *= 1.0 - 0.25 * band(pave, 0.0, 0.08, fwidth(pave));
  } else if (inApron) {
    // concrete slabs (5 m), each a touch different, with dark joints and stains
    vec2 slab = floor(p / 5.0);
    col = ${lin('#a6a398')} * (0.94 + 0.08 * afHash(slab)) * (0.95 + 0.1 * nB.x) * (0.94 + 0.1 * nA.w);
    vec2 jt = vec2(stripes(p.x + 0.02, 5.0, 0.04, fw.x), stripes(p.y + 0.02, 5.0, 0.04, fw.y));
    col *= 1.0 - 0.4 * max(jt.x, jt.y);
    col *= 1.0 - 0.28 * smoothstep(0.62, 0.9, nA.y) * smoothstep(0.4, 0.8, nC.x);
    rough = 0.82;
  } else {
    col = ${lin('#4b4c4d')} * grain * (0.94 + 0.1 * nA.z) * (0.96 + 0.08 * afHash(floor(p / 9.0)));
  }

  // ---- the runway's markings (white), and the blast pad's chevrons (yellow)
  float white = 0.0;
  float yel = 0.0;
  float rubber = 0.0;
  if (onRw) {
    if (t >= 0.0) {
      white = max(white, band(ay, uRw.w - 0.9, uRw.w, fw.y));
      // threshold: 12 stripes 1.7 m wide, 30 m long
      white = max(white, stripes(ay - 1.7, 3.4, 1.7, fw.y) * band(ay, 1.7, 20.4, fw.y) * band(t, 6.0, 36.0, fw.x));
      // centreline: 30 m dashes, 20 m gaps, 0.9 m wide (precision approach runway)
      float s = q.x + uRw.z - uRw2.w;
      white = max(white, band(ay, 0.0, 0.45, fw.y) * stripes(s, uRw2.z, 30.0, fw.x) * band(s, 0.0, 2.0 * uRw.z - 2.0 * uRw2.w, fw.x));
      // aiming point markings (400 m) and the touchdown zone's pairs of bars
      white = max(white, box2(vec2(t, ay), vec2(400.0, 9.0), vec2(460.0, 18.0), fw));
      for (int k = 0; k < 5; k++) {
        float at = k == 0 ? 150.0 : k == 1 ? 300.0 : k == 2 ? 600.0 : k == 3 ? 750.0 : 900.0;
        float n = k < 2 ? 3.0 : k < 4 ? 2.0 : 1.0;
        white = max(white, band(t, at, at + 22.5, fw.x) * stripes(ay - 9.0, 3.3, 1.8, fw.y) * band(ay, 9.0, 9.0 + 3.3 * n - 1.5, fw.y));
      }
      // rubber laid down where the wheels touch down and spin up, heaviest on the main gear's tracks
      float zone = smoothstep(180.0, 320.0, t) * (1.0 - smoothstep(700.0, 1250.0, t));
      float tracks = exp(-pow((ay - 3.8) / 2.6, 2.0)) + 0.55 * exp(-pow(ay / 5.0, 2.0));
      rubber = zone * clamp(tracks * (0.45 + 0.9 * nA.x * nB.z) * (1.0 - smoothstep(13.0, 19.0, ay)), 0.0, 0.85);
    } else if (ay < uRw.w) {
      float c = -t - ay;
      yel = stripes(c, 30.0, 1.27, length(fw)) * band(-t, 3.0, uRw2.y - 3.0, fw.x) * band(ay, 0.0, uRw.w - 1.0, fw.y);
    }
  }

  // ---- runway-holding positions (pattern A) and the enhanced centreline leading to them
  if (!onRw) {
    for (int i = 0; i < ${holds.length}; i++) {
      vec4 h = uHolds[i];
      vec2 d = p - h.xy;
      float a = dot(d, h.zw);
      float b = dot(d, vec2(h.w, -h.z));
      float fa = max(abs(h.z) * fw.x + abs(h.w) * fw.y, 1e-4);
      float fb = max(abs(h.w) * fw.x + abs(h.z) * fw.y, 1e-4);
      if (abs(b) < ${f(TAXI_HALF)} && a > -48.0 && a < 1.0) {
        float lines = max(band(a, -0.6, -0.45, fa), band(a, -0.3, -0.15, fa));
        float dashed = max(band(a, 0.0, 0.15, fa), band(a, 0.3, 0.45, fa)) * stripes(b + 0.45, 1.8, 0.9, fb);
        yel = max(yel, max(lines, dashed));
        float enh = band(abs(b), 0.25, 0.4, fb) * stripes(-a - 0.9, 4.0, 3.0, fa) * band(a, -47.0, -0.9, fa);
        yel = max(yel, enh);
      }
    }
  }

  // taxiway edge markings: two yellow lines along pavement that has shoulders (not the apron or the runway)
  float fp = fwidth(pave) + 1e-4;
  if (!onRw && !inApron) yel = max(yel, max(band(pave, -0.45, -0.3, fp), band(pave, -0.15, 0.0, fp)));

  float wear = 0.82 + 0.18 * nB.w;
  col = mix(col, ${lin('#e6e6de')} * wear, white * wear);
  col = mix(col, ${lin('#f0b92a')} * wear, yel * wear);
  rough = mix(rough, 0.7, max(white, yel) * 0.8);
  // rubber covers paint and asphalt alike
  col = mix(col, ${lin('#19191a')}, rubber);
  rough = mix(rough, 0.75, rubber);
  return col;
}
`;
}

export function groundMaterial(plan: AirfieldPlan, f: PaveField) {
  noiseTexture();
  const normal = detailNormalTexture(256);
  const mat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.88,
    metalness: 0,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const rw = plan.runway;
  const uniforms = {
    uField: { value: fieldTex(f) },
    uFieldRect: { value: new THREE.Vector4(f.rect.x0, f.rect.z0, 1 / (f.rect.x1 - f.rect.x0), 1 / (f.rect.z1 - f.rect.z0)) },
    uNoise: { value: noiseTexture() },
    uRw: { value: new THREE.Vector4(rw.cx, rw.cz, rw.halfLen, rw.halfW) },
    uRw2: { value: new THREE.Vector4(rw.shoulder, rw.blast, rw.dashPeriod, rw.dashStart) },
    uApron: { value: new THREE.Vector4(plan.apron.x0, plan.apron.z0, plan.apron.x1, plan.apron.z1) },
    uHolds: { value: plan.holds.map((h) => new THREE.Vector4(h.x, h.z, h.u.x, h.u.z)) },
  };
  mat.onBeforeCompile = (shader) => {
    withFogSun(shader);
    farFadeFog(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAfW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvAfW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${groundGlsl(plan)}`)
      .replace('#include <map_fragment>', 'float afRough;\nfloat afKeep;\ndiffuseColor.rgb *= airfieldColour(afRough, afKeep);\nif (afKeep < 0.5) discard;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = afRough;');
  };
  mat.customProgramCacheKey = () => `airfield-ground-${plan.ap.geo.id}`;
  return mat;
}

export function groundMesh(plan: AirfieldPlan, f: PaveField) {
  const m = new THREE.Mesh(groundGeometry(plan, f), groundMaterial(plan, f));
  m.receiveShadow = true;
  m.matrixAutoUpdate = false;
  return m;
}

// ------------------------------------------------------------------------------------------------
// The strip's grass: an overlay that darkens the land's own grass in mowing stripes (so its colour
// always matches the land round it), wears it sandy along the shoulders and fades out at the
// strip's edges and with distance
// ------------------------------------------------------------------------------------------------

const STRIP_VERT = /* glsl */ `
varying vec3 vW;
varying float vDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

function stripFrag() {
  const f = (v: number) => v.toFixed(3);
  return /* glsl */ `
uniform sampler2D uField;
uniform vec4 uFieldRect;
uniform sampler2D uNoise;
uniform vec4 uRw;
uniform vec4 uRw2;
uniform vec4 uStrip;
uniform float uFog;
varying vec3 vW;
varying float vDist;
${FILTERS}
void main() {
  vec2 p = vW.xz;
  float pave = ${f(PAVE_RANGE.lo)} + texture2D(uField, (p - uFieldRect.xy) * uFieldRect.zw).r * ${f(PAVE_RANGE.hi - PAVE_RANGE.lo)};
  vec2 q = p - uRw.xy;
  float shoulder = uRw2.x;
  if (pave < shoulder || (uRw.z - abs(q.x) > -uRw2.y && abs(q.y) < uRw.w + shoulder)) discard;
  vec2 e = min(p - uStrip.xy, uStrip.zw - p);
  float edge = smoothstep(0.0, 40.0, min(e.x, e.y));
  float near = 1.0 - smoothstep(700.0, 2600.0, vDist);
  vec2 fw = max(fwidth(p), vec2(1e-4));
  float n = texture2D(uNoise, p / 31.0).x;
  float n2 = texture2D(uNoise, p / 7.0).y;
  // the mower's passes run along the runway, 8 m wide
  float dark = stripes(p.y - uStrip.y + 2.0 * (n - 0.5), 16.0, 8.0, fw.y);
  vec3 m = vec3(1.0 - 0.085 * dark * near * edge);
  m *= 1.0 - 0.06 * smoothstep(0.55, 0.85, n) * smoothstep(0.3, 0.7, n2) * near * edge;
  float worn = 1.0 - smoothstep(shoulder, shoulder + 2.5 + 2.5 * n2, pave);
  m *= mix(vec3(1.0), vec3(1.0, 0.92, 0.74), worn * 0.75);
  float fd = uFog * vDist;
  m = mix(m, vec3(1.0), 1.0 - exp(-fd * fd));
  gl_FragColor = vec4(m, 1.0);
}
`;
}

export class StripOverlay {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(plan: AirfieldPlan, f: PaveField) {
    const strip = stripRect(plan);
    const rw = plan.runway;
    noiseTexture();
    this.uniforms = {
      uField: { value: fieldTex(f) },
      uFieldRect: { value: new THREE.Vector4(f.rect.x0, f.rect.z0, 1 / (f.rect.x1 - f.rect.x0), 1 / (f.rect.z1 - f.rect.z0)) },
      uNoise: { value: noiseTexture() },
      uRw: { value: new THREE.Vector4(rw.cx, rw.cz, rw.halfLen, rw.halfW) },
      uRw2: { value: new THREE.Vector4(rw.shoulder, rw.blast, rw.dashPeriod, rw.dashStart) },
      uStrip: { value: new THREE.Vector4(strip.x0, strip.z0, strip.x1, strip.z1) },
      uFog: { value: 0 },
    };
    const quads: Rect[] = [];
    const n = Math.ceil((strip.x1 - strip.x0) / 400);
    for (let k = 0; k < n; k++) quads.push({ x0: strip.x0 + ((strip.x1 - strip.x0) * k) / n, x1: strip.x0 + ((strip.x1 - strip.x0) * (k + 1)) / n, z0: strip.z0, z1: strip.z1 });
    const mat = new THREE.ShaderMaterial({
      vertexShader: STRIP_VERT,
      fragmentShader: stripFrag(),
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      // multiply what's already drawn (the land's grass) by the shader's colour
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(flatGeometry(quads, GROUND_Y), mat);
    this.mesh.renderOrder = 1;
    this.mesh.matrixAutoUpdate = false;
  }

  /** The scene's FogExp2 density, so the stripes fade as the land does. */
  setFog(density: number) {
    this.uniforms.uFog.value = density;
  }
}

// ------------------------------------------------------------------------------------------------
// Lettering: runway designators, stand numbers, hold markings, painted into one atlas
// ------------------------------------------------------------------------------------------------

const SIGN_FONT = '"Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif';

/** The runway designators: block numerals 9 m tall, 12 m past the threshold stripes. */
export function designatorDecals(plan: AirfieldPlan): DecalSpec[] {
  const out: DecalSpec[] = [];
  for (const ident of ['09', '27'] as const) {
    const rw = plan.ap.runways[ident];
    const f = headingVec(rw.heading);
    out.push({ x: rw.threshold.x + f.x * 52.5, z: rw.threshold.z + f.z * 52.5, heading: rw.heading, w: 9, l: 9, text: ident, fg: '#e6e6de', bg: '' });
  }
  return out;
}

/** Draw one decal's lettering into a slot (canvas y down = the reader's forward). */
function drawDecal(g: CanvasRenderingContext2D, d: DecalSpec, x: number, y: number, w: number, h: number) {
  g.save();
  g.translate(x, y);
  if (d.bg) {
    g.fillStyle = d.bg;
    g.fillRect(0, 0, w, h);
    // location markings carry a yellow border; mandatory ones a white one round the red
    g.strokeStyle = d.bg === '#151515' ? d.fg : '#ffffff';
    g.lineWidth = Math.max(2, h * 0.05);
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
  }
  const pad = d.bg ? h * 0.12 : 0;
  g.fillStyle = d.fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = (h - pad * 2) * 1.12;
  g.font = `700 ${size}px ${SIGN_FONT}`;
  const tw = g.measureText(d.text).width;
  const room = w - pad * 2;
  g.translate(w / 2, h / 2 + size * 0.04);
  // airfield lettering is tall and narrow: squeeze to the box, never stretch past 1.6× wide
  g.scale(Math.min(1.6, room / tw), 1);
  g.fillText(d.text, 0, 0);
  // painted lettering is heavier than the typeface: thicken the strokes
  g.strokeStyle = d.fg;
  g.lineWidth = size * 0.05;
  g.lineJoin = 'round';
  g.strokeText(d.text, 0, 0);
  g.restore();
}

export function decalMesh(decals: DecalSpec[], renderer: THREE.WebGLRenderer) {
  // shelf-pack the slots, 36 px per metre (designators 9 m: 324 px)
  const PX = 36;
  const W = 2048;
  const slots: { d: DecalSpec; x: number; y: number; w: number; h: number }[] = [];
  let sx = 0;
  let sy = 0;
  let row = 0;
  const sorted = decals.slice().sort((a, b) => b.l - a.l);
  for (const d of sorted) {
    const w = Math.ceil(d.w * PX) + 4;
    const h = Math.ceil(d.l * PX) + 4;
    if (sx + w > W) {
      sx = 0;
      sy += row;
      row = 0;
    }
    slots.push({ d, x: sx + 2, y: sy + 2, w: w - 4, h: h - 4 });
    sx += w;
    row = Math.max(row, h);
  }
  const H = THREE.MathUtils.ceilPowerOfTwo(sy + row);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  for (const s of slots) drawDecal(g, s.d, s.x, s.y, s.w, s.h);
  const tex = canvasTex(c, renderer);

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const s of slots) {
    const d = s.d;
    const f = headingVec(d.heading);
    const r = { x: -f.z, z: f.x };
    const b = pos.length / 3;
    // corners: back-left, back-right, front-right, front-left (front = the reader's forward = canvas top)
    for (const [kr, kf] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      pos.push(d.x + (r.x * kr * d.w) / 2 + (f.x * kf * d.l) / 2, DECAL_Y, d.z + (r.z * kr * d.w) / 2 + (f.z * kf * d.l) / 2);
    const u0 = s.x / W;
    const u1 = (s.x + s.w) / W;
    const vTop = 1 - s.y / H;
    const vBot = 1 - (s.y + s.h) / H;
    uv.push(u0, vBot, u1, vBot, u1, vTop, u0, vTop);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.02,
    depthWrite: false,
    roughness: 0.75,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  m.renderOrder = 2;
  m.matrixAutoUpdate = false;
  return m;
}
