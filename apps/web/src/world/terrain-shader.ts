// The land's look, painted per pixel from world position: a patchwork of fields with hedgerows
// and farm tracks, forests, villages' gardens, the mown grass of the airport, beaches, rock on the
// steep mountainsides, and on Palm Cay coral sand, lush grass and jungle. Nothing is a big texture:
// one small noise texture (terrain-land.ts) at many scales, so it holds up from eye height to 3 km.
// The forest rule matches forestAt / jungleAt in terrain-land.ts (the 3D trees stand on it).

import * as THREE from 'three';
import { withFogSun } from './fog';
import { AIRPORTS, ISLAND } from './geo';
import { COAST_ROAD, NOISE_DATA, NOISE_SIZE, RING_COLORS, ROT_C, ROT_S, VILLAGES } from './terrain-land';

/** Uniforms shared by the land (and, for the noise and the far fade, by the sea and the trees). */
export const LAND_UNIFORMS = {
  uNoise: { value: null as THREE.DataTexture | null },
  /** 1 while walking (the park's far plane): the park's blue-grey ring hills; 0 when flying. */
  uWalk: { value: 1 },
  uNight: { value: 0 },
  /** Fog forced to full between these view depths, so whatever the far plane cuts off has already faded into the fog. */
  uFarFade: { value: new THREE.Vector2(2000, 2350) },
};

let noiseTex: THREE.DataTexture | null = null;
/** The shared noise texture (RGBA, tiling; sample it as world / period). */
export function noiseTexture() {
  if (noiseTex) return noiseTex;
  const t = new THREE.DataTexture(NOISE_DATA, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  noiseTex = t;
  LAND_UNIFORMS.uNoise.value = t;
  return t;
}

/**
 * Fog that reaches 100 % just inside the far plane. Splices into the (sun-tinted) fog chunk, so call
 * it from onBeforeCompile after installSunFog has run (the Environment's constructor does).
 */
export function farFadeFog(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uFarFade = LAND_UNIFORMS.uFarFade;
  const chunk = THREE.ShaderChunk.fog_fragment.replace(
    'gl_FragColor.rgb = mix(',
    'fogFactor = max( fogFactor, smoothstep( uFarFade.x, uFarFade.y, vFogDepth ) );\n\tgl_FragColor.rgb = mix(',
  );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nuniform vec2 uFarFade;')
    .replace('#include <fog_fragment>', chunk);
}

const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/** GLSL: noise sampling, hashing and the land-use colour functions. */
function landGlsl() {
  const isl = AIRPORTS.island;
  const P = ISLAND.park;
  return /* glsl */ `
uniform sampler2D uNoise;
uniform float uWalk;
uniform vec4 uVillages[${VILLAGES.length}];
varying vec3 vLandW;
varying float vShore;
varying vec4 vTint;
varying float vUp;

vec4 noiseP(vec2 p, float period) { return texture2D(uNoise, p / period); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// a soft line mask of half-width w (metres) round distance e, faded out once it's smaller than a pixel
float lineMask(float e, float w) {
  float fw = max(fwidth(e), 1e-3);
  return (1.0 - smoothstep(w - fw, w + fw, e)) * clamp(w / fw, 0.0, 1.0);
}

vec3 cropColour(float h) {
  if (h < 0.17) return ${lin('#9a8a4a')};      // ripe wheat
  if (h < 0.31) return ${lin('#5f7a36')};      // young barley
  if (h < 0.47) return ${lin('#3f6a34')};      // pasture
  if (h < 0.58) return ${lin('#6a5440')};      // ploughed earth
  if (h < 0.70) return ${lin('#4c7437')};      // grazing
  if (h < 0.80) return ${lin('#857a52')};      // stubble
  if (h < 0.87) return ${lin('#3a5a2c')};      // maize
  if (h < 0.93) return ${lin('#a4973c')};      // rapeseed in flower
  return ${lin('#7b6e58')};                    // fallow
}

// the patchwork: farms of rotated field grids, hedgerows and tracks along the field edges
vec3 fieldsColour(vec2 p, vec4 nE, vec4 nF, out float rough) {
  vec2 dc = floor(p / 2300.0);
  float hd = hash12(dc + 0.37);
  float ang = (hd - 0.5) * 0.8 + (hash12(dc + 7.3) > 0.5 ? 1.5708 : 0.0);
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y) + (nE.xy - 0.5) * 22.0;
  vec2 size = mix(vec2(105.0, 170.0), vec2(230.0, 400.0), hash12(dc + 3.1));
  vec2 c = floor(q / size);
  vec2 f = q / size - c;
  // some fields are split into two strips
  if (hash12(c + dc * 5.0 + 9.1) > 0.62) {
    float sp = step(0.5, f.x);
    c.x += sp * 0.5;
    f.x = fract(f.x * 2.0);
    size.x *= 0.5;
  }
  float hc = hash12(c + dc * 17.0);
  vec3 col = cropColour(hc);
  // a little variation across each field, and drill rows / furrows along it
  col *= 0.86 + 0.28 * nE.z;
  float rowsK = 1.0 - clamp(fwidth(q.y) * 0.9, 0.0, 1.0);
  col *= 1.0 - 0.07 * rowsK * (0.5 + 0.5 * sin(q.y * 2.2 + hc * 30.0));
  col *= 0.95 + 0.1 * nF.x;
  // the field's edge (and the farm's): a hedge, a farm track, or a plain grass margin
  vec2 e2 = min(f, 1.0 - f) * size;
  float edge = min(e2.x, e2.y);
  vec2 fd = fract(p / 2300.0);
  float farm = min(min(fd.x, 1.0 - fd.x), min(fd.y, 1.0 - fd.y)) * 2300.0;
  float kind = hash12(floor(c / 2.0) + 4.4);
  rough = 0.95;
  if (farm < edge * 1.5 || kind > 0.35) {
    // hedgerows: dark, a little lumpy, with a darker shadow line beside
    float hw = 1.6 + 1.4 * nF.y;
    col = mix(col, ${lin('#1c3a1e')} * (0.8 + 0.5 * nE.w), lineMask(min(edge, farm), hw));
  } else {
    col = mix(col, ${lin('#8a7a5c')}, lineMask(edge, 1.7) * 0.85);
  }
  return col;
}

// the coast road (coastRoadZ and roadDist in terrain-land.ts)
float coastZ(float x) { return 1230.0 + 50.0 * sin(x / 1300.0 + 0.6) + 25.0 * sin(x / 470.0 + 2.1) + 10.0 * sin(x / 150.0); }
float roadDist(vec2 p) {
  float along = coastZ(p.x) - ${COAST_ROAD.inland.toFixed(1)};
  float zc = mix(along, ${COAST_ROAD.airportZ.toFixed(1)}, 1.0 - smoothstep(${COAST_ROAD.join0.toFixed(1)}, ${COAST_ROAD.join1.toFixed(1)}, abs(p.x)));
  return abs(p.y - zc) * 0.92;
}

float villageMask(vec2 p, out vec4 v) {
  float m = 0.0;
  v = vec4(0.0);
  for (int i = 0; i < ${VILLAGES.length}; i++) {
    vec4 u = uVillages[i];
    float k = 1.0 - smoothstep(u.z * 0.8, u.z + 40.0, length(p - u.xy));
    if (k > m) { m = k; v = u; }
  }
  return m;
}

float forestAllowed(vec2 p, float s, float park) {
  float a = smoothstep(1500.0, 2100.0, park);
  a *= max(smoothstep(14500.0, 15200.0, abs(p.x)), 1.0 - smoothstep(150.0, 300.0, p.y));
  a *= smoothstep(140.0, 260.0, s);
  a *= smoothstep(14.0, 30.0, roadDist(p));
  for (int i = 0; i < ${VILLAGES.length}; i++) {
    vec4 u = uVillages[i];
    a *= smoothstep(u.z, u.z + 80.0, length(p - u.xy));
  }
  return a;
}

vec3 canopy(vec2 p, vec3 dark, vec3 light, vec4 nE) {
  // crowns ~6–10 m across, lit on top, shadowed between: three scales at odd periods and angles,
  // so no tile repeats in step; once a crown is smaller than a pixel only its average is left
  vec2 q = vec2(0.809 * p.x - 0.588 * p.y, 0.588 * p.x + 0.809 * p.y);
  float crowns = noiseP(p, 61.0).x * 0.45 + noiseP(q, 37.0).y * 0.35 + noiseP(p, 17.0).z * 0.2;
  float fade = clamp(length(fwidth(p)) / 9.0, 0.0, 1.0);
  float k = mix(smoothstep(0.3, 0.72, crowns), 0.42, fade);
  return mix(dark, light, k) * (0.85 + 0.3 * nE.y);
}

vec3 sandColour(float d, vec4 nE, vec4 nF, vec3 dry, vec3 wet, out float rough) {
  float wetK = 1.0 - smoothstep(1.5, 7.0, d + (nE.x - 0.5) * 3.0);
  rough = mix(0.92, 0.38, wetK);
  vec3 c = dry * (0.93 + 0.12 * nF.z) * (0.95 + 0.1 * nE.y);
  // ripples and footprints near the water, a drift line of shells and weed at high tide
  c *= 1.0 - 0.06 * smoothstep(0.55, 0.8, nF.w);
  c = mix(c, c * 0.82, (1.0 - smoothstep(0.0, 1.5, abs(d - 9.0 - nE.z * 3.0))) * 0.6);
  return mix(c, wet, wetK);
}

vec3 mainlandColour(vec2 p, float s, float h, float up, out float rough) {
  float park = length(p - vec2(0.0, -50.0));
  vec4 nA = noiseP(p, 11300.0);
  vec4 nB = noiseP(vec2(${ROT_C.toFixed(6)} * p.x - ${ROT_S.toFixed(6)} * p.y, ${ROT_S.toFixed(6)} * p.x + ${ROT_C.toFixed(6)} * p.y), 6100.0);
  vec4 nC = noiseP(p, 1700.0);
  vec4 nD = noiseP(p, 230.0);
  vec4 nE = noiseP(p, 41.0);
  vec4 nF = noiseP(p, 4.3);
  rough = 0.95;

  // the plain round the park: the fair's own dark lawn green
  vec3 meadow = ${lin('#2b5c40')} * (0.92 + 0.14 * nD.x) * (0.95 + 0.1 * nF.y);
  float fr;
  vec3 col = fieldsColour(p, nE, nF, fr);
  col = mix(meadow, col, smoothstep(1100.0, 1700.0, park));

  // the airport's mown grass
  float apt = (1.0 - smoothstep(2700.0, 2760.0, abs(p.x))) * smoothstep(190.0, 250.0, p.y);
  vec3 mown = ${lin('#3f6c3c')} * (0.93 + 0.1 * nC.z) * (0.95 + 0.1 * nE.x) * (0.96 + 0.08 * nF.x);
  col = mix(col, mown, apt);

  // villages: gardens, orchards and yards between the houses
  vec4 v;
  float vm = villageMask(p, v);
  if (vm > 0.0) {
    vec2 cell = floor((p - v.xy) / 23.0);
    float hv = hash12(cell + v.w * 13.0);
    vec3 g = hv < 0.5 ? ${lin('#3d6334')} : hv < 0.75 ? ${lin('#56703e')} : hv < 0.9 ? ${lin('#6b6253')} : ${lin('#7d7466')};
    col = mix(col, g * (0.9 + 0.2 * nF.x), vm);
  }

  // the coast road: asphalt with white edge lines and a dashed centre line, gravel verges
  float rd = roadDist(p);
  if (rd < ${(COAST_ROAD.half + 6).toFixed(1)}) {
    float hw = ${COAST_ROAD.half.toFixed(1)};
    vec3 asphalt = ${lin('#4b4a47')} * (0.9 + 0.15 * nE.y) * (0.94 + 0.12 * nF.z);
    vec3 verge = ${lin('#7d7258')} * (0.9 + 0.2 * nF.x);
    col = mix(col, verge, (1.0 - smoothstep(hw + 1.0, hw + 5.5, rd + (nE.x - 0.5) * 2.0)) * 0.75);
    col = mix(col, asphalt, 1.0 - smoothstep(hw - 0.15, hw + 0.15, rd));
    col = mix(col, ${lin('#d8d6cc')}, lineMask(abs(rd - (hw - 0.35)), 0.08));
    col = mix(col, ${lin('#d8d6cc')}, lineMask(rd, 0.07) * step(0.62, fract(p.x / 12.0)));
  }

  // forests (the same rule as forestAt)
  float fn = 0.52 * nA.x + 0.33 * nB.y + 0.15 * nC.z + 0.08 * (nD.w - 0.5) + 0.09 * smoothstep(15.0, 90.0, h);
  float forest = smoothstep(0.575, 0.6, fn) * forestAllowed(p, s, park);
  col = mix(col, canopy(p, ${lin('#18321b')}, ${lin('#3a622e')}, nE), forest);

  // the mountains: rock on the steep slopes, scrub high up
  float steep = 1.0 - smoothstep(0.7, 0.86, up + (nE.z - 0.5) * 0.1);
  col = mix(col, ${lin('#5e5a4e')} * (0.85 + 0.3 * nD.y), steep * smoothstep(40.0, 120.0, h));
  col = mix(col, ${lin('#56613f')} * (0.85 + 0.3 * nE.x), smoothstep(260.0, 420.0, h + nD.x * 60.0) * (1.0 - steep));

  // the beach: dune grass, dry sand, wet sand at the water's edge
  float sr;
  vec3 sand = sandColour(s, nE, nF, ${lin('#cdb98e')}, ${lin('#8a7656')}, sr);
  float beach = 1.0 - smoothstep(66.0, 78.0, s + (nD.y - 0.5) * 20.0);
  float dunes = (1.0 - smoothstep(70.0, 98.0, s)) * smoothstep(0.45, 0.7, nE.w) * (1.0 - apt * 0.5);
  col = mix(col, sand, beach);
  col = mix(col, ${lin('#6f7a46')} * (0.8 + 0.3 * nF.y), dunes * smoothstep(40.0, 66.0, s) * 0.8);
  rough = mix(0.95, sr, beach);
  return col;
}

bool islandClear(vec2 p) {
  float rz = abs(p.y - ${isl.runway.z.toFixed(1)});
  float w = 90.0 * noiseP(p, 700.0).w;
  bool strip = rz < 230.0 + w || (rz < 330.0 + w && abs(p.x) > 1250.0 - w);
  bool apron = abs(p.x) < 470.0 + w && p.y > 40400.0 && p.y < 40720.0 + w;
  bool park = p.x > ${(P.x0 - 40).toFixed(1)} - w && p.x < ${(P.x1 + 40).toFixed(1)} + w && p.y > ${(P.z0 - 40).toFixed(1)} && p.y < ${(P.z1 + 60).toFixed(1)};
  bool lagoonBeach = abs(p.x) < 860.0 + w && p.y > ${(ISLAND.beachZ - 60).toFixed(1)} - w;
  return strip || apron || park || lagoonBeach;
}

vec3 islandColour(vec2 p, float d, float h, float up, out float rough) {
  vec4 nC = noiseP(p, 1700.0);
  vec4 nD = noiseP(p, 230.0);
  vec4 nE = noiseP(p, 41.0);
  vec4 nF = noiseP(p, 4.3);
  rough = 0.95;
  // lush tropical grass, burnt a little in patches
  vec3 col = mix(${lin('#3f7a2e')}, ${lin('#7c7d3c')}, smoothstep(0.55, 0.8, nD.x) * 0.6) * (0.9 + 0.2 * nE.y) * (0.95 + 0.1 * nF.x);
  // the airfield's and the park's mown lawns
  // (soft, ragged edges: the mowers follow no ruler out in the rough)
  float rag = (nD.z - 0.5) * 60.0;
  float af = min(1760.0 - abs(p.x), min(p.y - 40120.0, 40700.0 - p.y)) + rag;
  float pk = min(min(p.x - ${P.x0.toFixed(1)}, ${P.x1.toFixed(1)} - p.x), min(p.y - ${P.z0.toFixed(1)}, ${ISLAND.beachZ.toFixed(1)} - p.y)) + rag * 0.4;
  vec3 mown = ${lin('#4a7c38')} * (0.93 + 0.1 * nC.z) * (0.95 + 0.1 * nE.x) * (0.96 + 0.08 * nF.x);
  col = mix(col, mown, smoothstep(-30.0, 30.0, af) * 0.85);
  col = mix(col, ${lin('#4f8a36')} * (0.94 + 0.08 * nE.x) * (0.96 + 0.08 * nF.x), smoothstep(-12.0, 12.0, pk));
  // jungle (the same rule as jungleAt)
  float jn = 0.6 * noiseP(p, 2900.0).y + 0.4 * noiseP(p, 700.0).z + 0.25 * smoothstep(5.0, 30.0, h);
  float jungle = islandClear(p) ? 0.0 : smoothstep(0.37, 0.43, jn) * smoothstep(45.0, 90.0, d);
  col = mix(col, canopy(p, ${lin('#163a18')}, ${lin('#467c2a')}, nE), jungle);
  col = mix(col, ${lin('#6b6150')} * (0.85 + 0.3 * nD.y), (1.0 - smoothstep(0.72, 0.86, up)) * 0.8);
  // coral sand: a rim all round, and the wide south beach below the park
  float sr;
  vec3 sand = sandColour(d, nE, nF, ${lin('#e8dcbc')}, ${lin('#a99470')}, sr);
  float rim = 1.0 - smoothstep(30.0, 40.0, d - 22.0 * nC.z - 8.0 * nE.y);
  float south = abs(p.x) < 900.0 ? smoothstep(${(ISLAND.beachZ - 12).toFixed(1)}, ${(ISLAND.beachZ + 6).toFixed(1)}, p.y + (nE.x - 0.5) * 14.0) * (1.0 - smoothstep(760.0, 900.0, abs(p.x))) : 0.0;
  float beach = max(rim, south);
  col = mix(col, sand, beach);
  rough = mix(0.95, sr, beach);
  return col;
}

vec3 landColour(out float rough) {
  vec2 p = vLandW.xz;
  vec3 col = p.y > 20000.0 ? islandColour(p, vShore, vLandW.y, vUp, rough) : mainlandColour(p, vShore, vLandW.y, vUp, rough);
  // the walking view: the park's ring hills fade blue-grey with distance, as they always have
  return mix(col, vTint.rgb, vTint.a * uWalk);
}
`;
}

/** Linear-space ring colour for a fractional ring row (the walking view's tint). */
export function ringColour(row: number, out: THREE.Color) {
  const i = Math.min(RING_COLORS.length - 2, Math.floor(row));
  return out.set(RING_COLORS[i]).lerp(new THREE.Color(RING_COLORS[i + 1]), Math.min(1, row - i));
}

/** The land's material: MeshStandard (Lambert on the lowest tier) with the land-use colours spliced in. */
export function landMaterial(tier: string) {
  noiseTexture();
  const params = { color: '#ffffff', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const mat = tier === 'lowest' ? new THREE.MeshLambertMaterial(params) : new THREE.MeshStandardMaterial({ ...params, roughness: 0.95, metalness: 0 });
  const villages = VILLAGES.map((v) => new THREE.Vector4(v.x, v.z, v.r, v.seed));
  mat.onBeforeCompile = (shader) => {
    withFogSun(shader);
    farFadeFog(shader);
    Object.assign(shader.uniforms, { uNoise: LAND_UNIFORMS.uNoise, uWalk: LAND_UNIFORMS.uWalk, uVillages: { value: villages } });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aShore;\nattribute vec4 aTint;\nvarying vec3 vLandW;\nvarying float vShore;\nvarying vec4 vTint;\nvarying float vUp;',
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvLandW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvShore = aShore;\nvTint = aTint;\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${landGlsl()}`)
      .replace('#include <map_fragment>', 'float landRough;\ndiffuseColor.rgb *= landColour(landRough);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = landRough;');
  };
  mat.customProgramCacheKey = () => `land-${tier}`;
  return mat;
}
