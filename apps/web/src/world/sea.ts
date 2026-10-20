// The sea: one camera-following ocean surface out to the horizon, round both coasts and Palm Cay.
// A polar grid centred under the camera (fine close by, coarse far away) carries the swell of
// sea-waves.ts (the same numbers boats and jet-skis ride: see waveY); the fragment shader adds
// wind ripples from a tiling normal map, colours the water by its depth (the bed shows through the
// shallows: sand off the mainland, coral sand, sea grass and reef heads round Palm Cay, turquoise
// in the lagoon, deep blue beyond the drop-off), and paints the surf: foam lapping at the water's
// edge, waves breaking along the reef, whitecaps when the wind is up. Reflections come from the
// scene's environment map (no mirror pass); the sun's glint is clamped so bloom never blows out.

import * as THREE from 'three';
import type { Ctx } from './context';
import { withFogSun } from './fog';
import { ISLAND, SEA_Y, headingVec } from './geo';
import type { Quality } from './quality';
import { mulberry } from './random';
import { SWELL, setSwell, wavePhases } from './sea-waves';
import { LAND_UNIFORMS, farFadeFog, noiseTexture } from './terrain-shader';

export { waveY } from './sea-waves';

/** The ripple normal map's tile: a sum of short waves spread round +x (the shader turns it downwind). */
function rippleTexture(size: number) {
  const rnd = mulberry(808);
  // integer wavevectors, so the pattern tiles exactly
  const waves: { kx: number; ky: number; a: number; ph: number }[] = [];
  for (let i = 0; i < 48; i++) {
    const f = 2 + Math.floor(rnd() * 13);
    const ang = (rnd() - 0.5) * 2.8;
    const kx = Math.round(Math.cos(ang) * f);
    const ky = Math.round(Math.sin(ang) * f);
    if (kx === 0 && ky === 0) continue;
    waves.push({ kx, ky, a: 1 / Math.hypot(kx, ky) ** 1.15, ph: rnd() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  let max = 0;
  const gx = new Float32Array(size * size);
  const gy = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const arg = ((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.ph;
        const c = Math.cos(arg) * w.a;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      gx[y * size + x] = dx;
      gy[y * size + x] = dy;
      max = Math.max(max, Math.abs(dx), Math.abs(dy));
    }
  for (let i = 0; i < size * size; i++) {
    const nx = -gx[i] / max;
    const ny = -gy[i] / max;
    data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * A disc of rings round the origin: ring radii grow geometrically from `r1` to `R`, so the cells
 * stay roughly square. `aSpacing` is each vertex's cell size (the shader drops waves it can't hold).
 */
function polarGrid(segments: number, rings: number, r1: number, R: number) {
  const g = Math.pow(R / r1, 1 / (rings - 1));
  const pos = new Float32Array((1 + segments * rings) * 3);
  const spacing = new Float32Array(1 + segments * rings);
  spacing[0] = r1;
  for (let i = 0; i < rings; i++) {
    const r = r1 * Math.pow(g, i);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const k = 1 + i * segments + s;
      pos[k * 3] = Math.cos(a) * r;
      pos[k * 3 + 2] = Math.sin(a) * r;
      spacing[k] = Math.max(r * (g - 1), (r * Math.PI * 2) / segments);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let i = 0; i < rings - 1; i++)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      const a = 1 + i * segments + s;
      const b = 1 + i * segments + s2;
      const c = 1 + (i + 1) * segments + s;
      const d = 1 + (i + 1) * segments + s2;
      idx.push(a, b, c, b, d, c);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('aSpacing', new THREE.BufferAttribute(spacing, 1));
  geo.setIndex(idx);
  return geo;
}

/** GLSL shared by both stages: where the shores are and how deep the water is (mirrors terrain-land.ts and sea-waves.ts). */
function shoreGlsl() {
  const L = ISLAND.lagoon;
  const lag = { cx: (L.x0 + L.x1) / 2, cz: (L.z0 + L.z1) / 2, hx: (L.x1 - L.x0) / 2, hz: (L.z1 - L.z0) / 2, r: 160 };
  const f = (v: number) => v.toFixed(2);
  return /* glsl */ `
float seaCoastZ(float x) { return 1230.0 + 50.0 * sin(x / 1300.0 + 0.6) + 25.0 * sin(x / 470.0 + 2.1) + 10.0 * sin(x / 150.0); }
float islandK(vec2 p) {
  vec2 d = p - vec2(${f(ISLAND.centre.x)}, ${f(ISLAND.centre.z)});
  float a = atan(d.y, d.x);
  float wob = 1.0 + 0.035 * sin(3.0 * a + 1.0) + 0.025 * sin(5.0 * a + 2.3) + 0.012 * sin(11.0 * a + 0.7);
  vec2 q = abs(d / vec2(${f(ISLAND.rx)}, ${f(ISLAND.rz)}));
  return pow(q.x * q.x * q.x + q.y * q.y * q.y, 1.0 / 3.0) / wob;
}
// metres to the shore: positive on land, negative at sea (islandShoreDist / homeShoreDist)
float shoreDist(vec2 p) {
  if (p.y < 20000.0) return seaCoastZ(p.x) - p.y;
  float k = islandK(p);
  vec2 g = vec2(islandK(p + vec2(1.0, 0.0)) - islandK(p - vec2(1.0, 0.0)), islandK(p + vec2(0.0, 1.0)) - islandK(p - vec2(0.0, 1.0))) * 0.5;
  return (1.0 - k) / max(1e-6, length(g));
}
float lagoonSdf(vec2 p) {
  vec2 q = abs(p - vec2(${f(lag.cx)}, ${f(lag.cz)})) - vec2(${f(lag.hx - lag.r)}, ${f(lag.hz - lag.r)});
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${f(lag.r)};
}
bool lagoonMouth(vec2 p) { return abs(p.x - ${f(lag.cx)}) < ${f(lag.hx)} && p.y < ${f(L.z0)}; }
float reefAt(vec2 p) {
  float L = lagoonSdf(p);
  if (L <= 0.0 || L > 95.0 || lagoonMouth(p)) return 0.0;
  return smoothstep(0.0, 26.0, L) * (1.0 - smoothstep(48.0, 95.0, L));
}
// how much of the open-sea swell reaches p (swellFactor)
float swellAt(vec2 p, float d) {
  float u = -d;
  if (p.y < 20000.0) return 0.12 + 0.88 * smoothstep(5.0, 140.0, u);
  float open = 0.12 + 0.88 * smoothstep(5.0, 160.0, u);
  float L = lagoonSdf(p);
  float behind = lagoonMouth(p) ? 1.0 : 1.0 - smoothstep(-30.0, 40.0, L);
  return open * (1.0 - behind * 0.9) * (1.0 - reefAt(p) * 0.45);
}
`;
}

export class Sea {
  readonly mesh: THREE.Mesh;
  private uniforms = {
    uPhase: { value: [0, 0, 0, 0] },
    uWave: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uRadius: { value: 2300 },
    uTime: { value: 0 },
    uSeaEnv: { value: 2 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindKt: { value: 10 },
    uRipple: { value: null as THREE.Texture | null },
    uNoise: LAND_UNIFORMS.uNoise,
    uNight: LAND_UNIFORMS.uNight,
  };
  private phases: number[] = [0, 0, 0, 0];

  constructor(
    private ctx: Ctx,
    q: Quality,
  ) {
    const low = q.tier === 'low' || q.tier === 'lowest';
    noiseTexture();
    this.uniforms.uRipple.value = rippleTexture(low ? 128 : 256);
    const geo = polarGrid(low ? 64 : 112, low ? 110 : 160, 1.5, 62000);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.08, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      withFogSun(shader);
      farFadeFog(shader);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aSpacing;
          uniform float uPhase[4];
          uniform vec4 uWave[4];
          uniform float uRadius;
          varying vec3 vSeaW;
          varying float vSwell;
          ${shoreGlsl()}`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = position;
          // rings beyond the view collapse onto the edge of the visible sea
          float rr = length(transformed.xz);
          if (rr > uRadius) transformed.xz *= uRadius / rr;
          vec2 wp = (modelMatrix * vec4(transformed, 1.0)).xz;
          float sd = shoreDist(wp);
          vSwell = swellAt(wp, sd);
          float h = 0.0;
          for (int i = 0; i < 4; i++) {
            vec4 w = uWave[i];
            float lambda = 6.2832 / w.z;
            // a wave the grid can't hold here is left to the normals
            float keep = 1.0 - smoothstep(lambda * 0.12, lambda * 0.25, aSpacing);
            h += w.w * keep * sin(w.z * dot(w.xy, wp) - uPhase[i]);
          }
          transformed.y += h * vSwell;
          vSeaW = vec3(wp.x, transformed.y, wp.y);`,
        );
      shader.fragmentShader = shader.fragmentShader
        // the sea only ever reflects the sky: a ripple tilted towards the viewer must not look up the
        // reflection map's ground (below the horizon), or the far water turns a dull grey
        .replace(
          '#include <envmap_physical_pars_fragment>',
          THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
            'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );',
            'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );\n\t\t\treflectVec = normalize( vec3( reflectVec.x, max( reflectVec.y, 0.035 ), reflectVec.z ) );',
            )
            // and it mirrors the sky at full strength (the scene's dimmed environment suits the land, not water)
            .replace('return envMapColor.rgb * envMapIntensity;', 'return envMapColor.rgb * envMapIntensity * uSeaEnv;'),
        )
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uPhase[4];
          uniform vec4 uWave[4];
          uniform float uSeaEnv;
          uniform float uTime;
          uniform vec2 uWindDir;
          uniform float uWindKt;
          uniform sampler2D uRipple;
          uniform sampler2D uNoise;
          uniform float uNight;
          varying vec3 vSeaW;
          varying float vSwell;
          ${shoreGlsl()}
          vec4 seaNoise(vec2 p, float period) { return texture2D(uNoise, p / period); }
          // water depth below the mean surface at p, u metres out from the water's edge (mainlandDepth / islandDepth)
          float seaDepth(vec2 p, float u) {
            if (p.y < 20000.0) return u < 40.0 ? 0.072 * u : min(42.0, 2.88 + 0.03 * (u - 40.0));
            float shelf = u < 40.0 ? 0.072 * u : u < 260.0 ? 2.88 + 0.022 * (u - 40.0) : min(58.0, 7.72 + 0.12 * (u - 260.0));
            float L = lagoonSdf(p);
            if (L > 300.0) return shelf;
            float floorD = 2.1 + 1.6 * smoothstep(0.0, 220.0, -L) + 0.9 * (seaNoise(p, 900.0).x - 0.5);
            float d;
            if (L <= 0.0 || lagoonMouth(p)) d = floorD;
            else {
              float crest = 0.5 + 0.45 * seaNoise(p, 330.0).y;
              d = L < 30.0 ? mix(floorD, crest, smoothstep(0.0, 30.0, L)) : crest + max(0.0, L - 52.0) * 0.42;
            }
            return min(shelf, d);
          }
          float seaFoam;
          float seaRough;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec2 sp = vSeaW.xz;
          float sd = shoreDist(sp);
          // the land draws itself above the water's edge
          if (sd > 2.5) discard;
          float u = max(-sd, 0.0);
          float depth = seaDepth(sp, u);
          bool isle = sp.y > 20000.0;
          float reef = isle ? reefAt(sp) : 0.0;
          vec4 nA = seaNoise(sp, 41.0);
          vec4 nB = seaNoise(sp + uWindDir * uTime * 0.6, 13.0);
          // what the shallows show of the bed: sand, sea grass in the lagoon, coral heads on the reef
          vec3 bed = isle ? vec3(0.80, 0.72, 0.52) : vec3(0.55, 0.46, 0.30);
          if (isle) {
            // sea-grass meadows: patchy at two scales, soft-edged, thinning out where the water is shallow
            float gm = seaNoise(sp, 530.0).z * 0.6 + seaNoise(sp * mat2(0.8, 0.6, -0.6, 0.8), 97.0).y * 0.4;
            float grass = smoothstep(0.6, 0.78, gm) * (1.0 - reef) * smoothstep(1.2, 2.6, depth);
            bed = mix(bed, vec3(0.16, 0.22, 0.10), grass * 0.6);
            bed = mix(bed, mix(vec3(0.24, 0.17, 0.12), vec3(0.42, 0.30, 0.30), nA.y), reef * smoothstep(0.35, 0.6, nA.x));
          }
          vec3 absorb = exp(-depth * vec3(0.40, 0.085, 0.06));
          float see = exp(-depth * 0.2);
          vec3 deep = isle ? vec3(0.004, 0.040, 0.085) : vec3(0.006, 0.040, 0.065);
          vec3 scatter = isle ? vec3(0.0, 0.26, 0.30) : vec3(0.03, 0.16, 0.15);
          vec3 water = mix(deep, bed * absorb * 0.9 + scatter * (1.0 - see) * 0.6, see);
          // surf: foam lapping in at the water's edge, waves breaking along the reef, whitecaps in a strong wind
          float swash = (1.0 - smoothstep(0.0, 7.0 + 6.0 * vSwell, u + (nA.z - 0.5) * 4.0)) * (0.55 + 0.45 * sin(u * 0.8 - uTime * 1.3 + nA.w * 6.0));
          float edgeFoam = (1.0 - smoothstep(0.0, 1.6, u)) * 0.8;
          float breakers = reef * smoothstep(0.42, 0.75, nB.x * 0.7 + 0.5 * (0.5 + 0.5 * sin(dot(sp, uWindDir.yx * vec2(-1.0, 1.0)) * 0.05 - uTime * 0.9))) * 0.95;
          float caps = smoothstep(12.0, 26.0, uWindKt) * smoothstep(0.72, 0.86, nB.y * 0.6 + nA.x * 0.5) * smoothstep(60.0, 200.0, u);
          seaFoam = clamp(max(max(swash * smoothstep(0.0, 1.0, vSwell * 6.0), edgeFoam), max(breakers, caps)), 0.0, 1.0);
          seaFoam *= smoothstep(0.25, 0.75, nB.z + seaFoam * 0.4);
          diffuseColor.rgb = mix(water, vec3(0.92, 0.95, 0.96), seaFoam);
          seaRough = mix(0.06, 0.6, seaFoam);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
            // the swell's slope (as drawn by the vertices, plus what the grid couldn't hold), then the wind's ripples
            vec2 grad = vec2(0.0);
            float foot = length(fwidth(sp));
            for (int i = 0; i < 4; i++) {
              vec4 w = uWave[i];
              float keep = 1.0 - smoothstep(0.25, 0.6, foot * w.z / 6.2832);
              // the short wind waves are irregular in a real sea: let the ripples carry most of them
              float share = w.z > 0.12 ? 0.75 : 1.0;
              grad += w.w * w.z * keep * share * cos(w.z * dot(w.xy, sp) - uPhase[i]) * w.xy;
            }
            grad *= vSwell;
            vec2 wd = uWindDir;
            mat2 rot = mat2(wd.x, wd.y, -wd.y, wd.x);
            // each scale of ripples turned a little differently off the wind, so no tiling lines up
            mat2 rotB = mat2(0.955, 0.296, -0.296, 0.955) * rot;
            mat2 rotC = mat2(0.921, -0.389, 0.389, 0.921) * rot;
            float calm = isle ? mix(0.6, 1.0, vSwell) : 1.0;
            // patches of rougher and smoother water drifting with the wind
            float gustK = 0.6 + 0.8 * seaNoise(sp - uWindDir * uTime * 2.0, 1900.0).w;
            // about the slopes Cox & Munk measured on the open sea (rms ~0.15–0.2 in a moderate breeze)
            float strength = (0.09 + 0.009 * uWindKt) * calm * gustK;
            // each scale's weight wanders across the sea (so no tile repeats the same way twice), and a
            // scale too fine for the pixel fades out: from afar its tilt becomes roughness, not sparkle
            vec4 nV = seaNoise(sp, 2300.0);
            float kA = 1.0 - smoothstep(9.0, 40.0, foot);
            float k0 = 1.0 - smoothstep(4.0, 22.0, foot);
            float k1 = 1.0 - smoothstep(1.0, 5.5, foot);
            float k2 = 1.0 - smoothstep(0.3, 1.6, foot);
            vec2 rA = (texture2D(uRipple, (rotB * sp) / 263.0 + vec2(uTime * 0.004, 0.0)).xy * 2.0 - 1.0);
            vec2 r0 = (texture2D(uRipple, (rotC * sp) / 97.0 - vec2(uTime * 0.012, 0.0)).xy * 2.0 - 1.0);
            vec2 r1 = (texture2D(uRipple, (rotB * sp) / 23.0 - vec2(uTime * 0.035, 0.0)).xy * 2.0 - 1.0);
            vec2 r2 = (texture2D(uRipple, (rot * sp) / 6.7 + vec2(uTime * 0.05, uTime * 0.013)).xy * 2.0 - 1.0);
            vec2 rip = rot * (rA * 0.3 * kA * (0.4 + 1.2 * nV.y)
              + r0 * 0.3 * k0 * (0.3 + 1.4 * nV.x)
              + r1 * 0.5 * k1 * (0.5 + nV.z)
              + r2 * 0.4 * k2) * strength;
            vec3 nW = normalize(vec3(-grad.x - rip.x, 1.0, -grad.y - rip.y));
            nW = normalize(mix(nW, vec3(0.0, 1.0, 0.0), seaFoam * 0.7));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          // the glint spreads into a long path at a distance, as the waves too small to see still tilt the surface
          roughnessFactor = max(seaRough, mix(0.05, 0.2, smoothstep(150.0, 9000.0, length(vViewPosition))) + 0.06 * smoothstep(1.0, 5.5, length(fwidth(vSeaW.xz))) + 0.004 * uWindKt);`,
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
          // the sun's glint stays a glint: below the half-float range and a sane bloom
          gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(mix(2.6, 1.2, uNight)));`,
        );
    };
    mat.customProgramCacheKey = () => `sea-${q.tier}`;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = q.shadows;
    // last of the opaque things: whatever stands in front of it rejects its (costly) pixels early
    this.mesh.renderOrder = 2;
    this.mesh.position.y = SEA_Y;
    this.setWind(SWELL.fromDeg, SWELL.kt);
  }

  /** Wind FROM `fromDeg` at `kt`: the wind sea's waves (and waveY's), the ripples' drift and the whitecaps. */
  setWind(fromDeg: number, kt: number) {
    setSwell(fromDeg, kt);
    const d = headingVec(fromDeg + 180);
    this.uniforms.uWindDir.value.set(d.x, d.z);
    this.uniforms.uWindKt.value = kt;
    SWELL.waves.forEach((w, i) => this.uniforms.uWave.value[i].set(w.dx, w.dz, w.k, w.a));
  }

  /** `t` is the clock waveY is asked with (the one Environment.update gets). */
  update(_dt: number, t: number, camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera;
    // follow the camera, in whole metres (the grid's centre cells are 1.5 m)
    this.mesh.position.set(Math.round(cam.position.x), SEA_Y, Math.round(cam.position.z));
    this.mesh.updateMatrixWorld();
    this.uniforms.uRadius.value = (cam.far ?? 2400) * 0.98;
    this.uniforms.uTime.value = t % 3600;
    this.uniforms.uSeaEnv.value = 0.7 / Math.max(0.2, this.ctx.scene.environmentIntensity);
    wavePhases(t, this.phases);
    for (let i = 0; i < 4; i++) this.uniforms.uPhase.value[i] = this.phases[i];
  }
}
