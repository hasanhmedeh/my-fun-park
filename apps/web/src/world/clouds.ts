// Cloud layers you can fly through: each layer (a METAR group, e.g. SCT at 3000 ft) is a field of
// clouds built from soft, lit billboard puffs — heaped cumulus for FEW/SCT, wide flat-bottomed
// stratocumulus decks for BKN/OVC. The field repeats round the camera (a 30 km tile), puffs are
// sorted back to front a few times a second, and every puff is shaded as a sphere from the sun
// and the sky, darker underneath, cut flat at the layer's base. When the camera is inside one,
// `inside` says how deep (the Environment thickens the fog to a white-out).

import * as THREE from 'three';
import type { Ctx } from './context';
import { fogSun } from './fog';
import { FT, SEA_Y } from './geo';
import type { Quality } from './quality';
import { mulberry } from './random';

export interface CloudLayer {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC';
  baseFt: number;
}

/** The repeating tile (m): the field wraps round the camera every TILE metres. */
const TILE = 30000;
/** How much of the sky each cover hides (FEW 1–2 oktas … OVC 8). */
const COVER = { FEW: 0.16, SCT: 0.38, BKN: 0.7, OVC: 0.97 };
const WHITE = new THREE.Color(1, 1, 1);
/** Moonlight on a cloud: the moon's blue, greyed (linear). */
const MOON_GREY = new THREE.Color(0.42, 0.45, 0.5);

/** A soft, lumpy puff (alpha) with a little internal density variation (rgb). */
function puffTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const rnd = mulberry(77);
  const blobs = Array.from({ length: 14 }, () => {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * 0.42;
    return { x: 0.5 + Math.cos(a) * r * 0.75, y: 0.5 + Math.sin(a) * r * 0.75, r: 0.16 + rnd() * 0.16 };
  });
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const v = (y + 0.5) / S;
      let d = 0;
      for (const b of blobs) {
        const q = ((u - b.x) ** 2 + (v - b.y) ** 2) / (b.r * b.r);
        d += Math.exp(-q * 2.2);
      }
      // a soft, wispy edge: density thins out gradually, nothing like a disc's rim
      const edge = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 2);
      const a = Math.pow(Math.min(1, d * 0.55), 1.6) * Math.pow(edge, 0.9);
      const k = (y * S + x) * 4;
      const dens = Math.min(1, d * 0.5);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(dens * 255);
      img.data[k + 3] = Math.round(Math.min(1, a * 1.25) * 255);
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  size: number;
  base: number;
  /** 0 at the bottom of its cloud .. 1 at the top (shading). */
  height: number;
  seed: number;
}

export class Clouds {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** 0 outside every cloud .. 1 deep inside one (for the fog's white-out). */
  inside = 0;
  private puffs: Puff[] = [];
  private order: { i: number; d: number; x: number; z: number }[] = [];
  private aPuff: THREE.InstancedBufferAttribute;
  private aInfo: THREE.InstancedBufferAttribute;
  private sortIn = 0;
  private max: number;
  private uniforms = {
    uMap: { value: null as THREE.Texture | null },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color('#ffffff') },
    uSkyColor: { value: new THREE.Color('#9fb4d0') },
    uGroundColor: { value: new THREE.Color('#5a5850') },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0 },
    uFar: { value: 2400 },
    uFogSunDir: fogSun.uFogSunDir,
    uFogSunColor: fogSun.uFogSunColor,
    uWrap: { value: 0.35 },
  };

  constructor(
    private ctx: Ctx,
    q: Quality,
  ) {
    this.max = q.tier === 'high' ? 9000 : q.tier === 'medium' ? 6000 : 3000;
    this.uniforms.uMap.value = puffTexture();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPuff = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aInfo = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPuff', this.aPuff);
    geo.setAttribute('aInfo', this.aInfo);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec4 aPuff;   // centre xyz, size
        attribute vec4 aInfo;   // base y, height in cloud, seed, -
        uniform float uFar;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vBase;
        varying float vHeight;
        varying float vFade;
        varying float vSeed;
        varying vec3 vRight;
        varying vec3 vUp;
        varying vec3 vView;
        void main() {
          vSeed = aInfo.z;
          float size = aPuff.w;
          // camera-facing, turned a little per puff so neighbours don't repeat
          float a = aInfo.z * 6.2832;
          vec2 c2 = vec2(cos(a), sin(a));
          vec2 lp = mat2(c2.x, c2.y, -c2.y, c2.x) * position.xy;
          vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 world = aPuff.xyz + (vRight * lp.x + vUp * lp.y) * size;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = length(aPuff.xyz - cameraPosition);
          // a puff melts away as the camera flies into it (the fog takes over), and into the far haze
          vFade = smoothstep(size * 0.25, size * 0.75, dist) * (1.0 - smoothstep(uFar * 0.75, uFar * 0.95, dist));
          vUv = position.xy + 0.5;
          vWorld = world;
          vBase = aInfo.x;
          vHeight = aInfo.y;
          vView = normalize(world - cameraPosition);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uWrap;
        uniform vec3 uSkyColor;
        uniform vec3 uGroundColor;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uFogSunDir;
        uniform vec3 uFogSunColor;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vBase;
        varying float vHeight;
        varying float vFade;
        varying float vSeed;
        varying vec3 vRight;
        varying vec3 vUp;
        varying vec3 vView;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          // the layer's flat base: nothing hangs below it
          // billows: the same puff, turned and shrunk, eats into the edge so no two outlines match
          float sa = vSeed * 6.2832;
          vec2 uv2 = mat2(cos(sa), sin(sa), -sin(sa), cos(sa)) * (vUv - 0.5) * 1.9 + 0.5 + vSeed;
          float billow = texture2D(uMap, uv2).r;
          float a = min(1.0, 1.2 * tex.a) * smoothstep(0.05, 0.55, billow * 0.8 + tex.a * 0.6) * vFade * smoothstep(vBase - 25.0, vBase + 35.0, vWorld.y);
          if (a < 0.004) discard;
          // light the puff as a soft, bulging mass (its normal from where on the disc this pixel
          // is, bent upward) with wrapped lighting: clouds scatter, they have no hard terminator
          vec2 q = vUv * 2.0 - 1.0;
          float r2 = min(dot(q, q), 1.0);
          vec3 n = normalize((vRight * q.x + vUp * q.y) * 0.7 - vView * sqrt(1.0 - r2) * 0.5 + vec3(0.0, 0.45, 0.0));
          float sun = uWrap + (1.0 - uWrap) * (0.5 + 0.5 * dot(n, uSunDir));
          // light through the thin edges when looking towards the sun (the silver lining)
          float rim = pow(max(dot(vView, uSunDir), 0.0), 6.0) * (1.0 - tex.r) * 1.2;
          // darker towards the cloud's base, where little light gets through from above
          float self = mix(0.58, 1.0, clamp(vHeight + q.y * 0.12, 0.0, 1.0)) * mix(0.88, 1.0, tex.r);
          vec3 amb = mix(uGroundColor, uSkyColor, 0.55 + 0.45 * n.y);
          vec3 col = (amb * 0.75 + uSunColor * (sun * 0.8 + rim)) * self;
          // the scene's fog (sun-tinted, as fog.ts does it)
          float d = length(vWorld - cameraPosition);
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
          float sunAmt = pow(max(dot(vView, uFogSunDir), 0.0), 5.0);
          col = mix(col, mix(uFogColor, uFogSunColor, sunAmt), fogF);
          gl_FragColor = vec4(col * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // drawn after the terrain and the sea, before the park's glows
    this.mesh.renderOrder = 3;
  }

  /** The layers to draw (from the weather), or null for none (the park's own sky clouds only). */
  setLayers(layers: CloudLayer[] | null) {
    this.puffs = [];
    if (layers) layers.forEach((l, i) => this.buildLayer(l, i));
    if (this.puffs.length > this.max) this.puffs.length = this.max;
    this.order = this.puffs.map((_, i) => ({ i, d: 0, x: 0, z: 0 }));
    this.mesh.geometry.instanceCount = this.puffs.length;
    this.mesh.visible = this.puffs.length > 0;
    this.sortIn = 0;
    this.inside = 0;
  }

  private buildLayer(l: CloudLayer, index: number) {
    const rnd = mulberry(1301 + index * 97 + Math.round(l.baseFt));
    const cover = COVER[l.cover];
    const base = SEA_Y + l.baseFt * FT;
    const deck = l.cover === 'BKN' || l.cover === 'OVC';
    const budget = Math.floor(this.max / 2);
    // clusters: heaps of puffs; cumulus are tall and round, decks are wide and flat
    const meanR = deck ? 1100 : 850;
    const clusters = Math.round((cover * TILE * TILE) / (Math.PI * meanR * meanR * (deck ? 0.75 : 0.9)));
    const perCluster = Math.max(6, Math.min(deck ? 16 : 24, Math.floor(budget / Math.max(1, clusters))));
    for (let c = 0; c < clusters; c++) {
      const cx = (rnd() - 0.5) * TILE;
      const cz = (rnd() - 0.5) * TILE;
      const R = meanR * (0.55 + rnd() * 0.9);
      const tall = deck ? 120 + rnd() * 160 : R * (0.45 + rnd() * 0.55);
      for (let p = 0; p < perCluster; p++) {
        const a = rnd() * Math.PI * 2;
        // cumulus: a compact heap of overlapping puffs; decks: spread wide
        const rr = Math.sqrt(rnd()) * R * (deck ? 1 : 0.5);
        // cumulus: higher in the middle, a dome; decks: a lumpy slab
        const dome = deck ? 0.5 : 1 - (rr / R) ** 2;
        const h = rnd() * dome;
        // big puffs make the body, small ones the cauliflower detail round it
        const size = (deck ? 520 : 400) * (0.45 + rnd() * 0.85) * (deck ? 1 : 0.55 + 0.6 * dome);
        this.puffs.push({
          x: cx + Math.cos(a) * rr,
          y: base + size * 0.3 + h * tall,
          z: cz + Math.sin(a) * rr * (deck ? 0.7 : 1),
          size,
          base,
          height: Math.min(1, 0.2 + h * 0.9),
          seed: rnd(),
        });
      }
    }
  }

  /**
   * The light the clouds are lit by, straight from the scene's lights: the sun's (or at night the
   * moon's) direction, colour and intensity, and the hemisphere light's sky and ground colours.
   * `moon` says the direct light is moonlight: the game's moon is far brighter than a real one
   * (so the park stays playable at night), but a cloud is a near-white reflector seen against a
   * black sky, so it gets only the share a moonlit cloud really shows: dim grey-blue. A low sun
   * reaches the clouds through a long, reddening path (gold to salmon), and the sky light is the
   * whole dome's: paler than the zenith tint by day, none of that at dusk or at night.
   */
  light(sunDir: THREE.Vector3, sun: THREE.Color, intensity: number, sky: THREE.Color, ground: THREE.Color, moon = false) {
    const u = this.uniforms;
    const smooth = THREE.MathUtils.smoothstep;
    u.uSunDir.value.copy(sunDir);
    const d = u.uSunColor.value.copy(sun);
    // how high the sun is: 0 at dusk, dawn and at night .. 1 by day
    const dome = moon ? 0 : smooth(sunDir.y, 0.04, 0.35);
    if (moon) d.lerp(MOON_GREY, 0.6).multiplyScalar(Math.min(0.4, intensity * 0.2));
    else {
      const low = 1 - smooth(sunDir.y, 0.0, 0.3);
      d.multiplyScalar(Math.min(1.6, intensity * 0.55));
      d.g *= 1 - 0.22 * low;
      d.b *= 1 - 0.5 * low;
    }
    // the shade side: wrapped half-lit by day, darker against a low sun or the moon
    u.uWrap.value = 0.15 + 0.2 * dome;
    const k = 0.55 + 0.45 * dome;
    u.uSkyColor.value.copy(sky).lerp(WHITE, 0.35 * dome).multiplyScalar(k);
    u.uGroundColor.value.copy(ground).multiplyScalar(k);
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.mesh.visible) return;
    const cam = camera as THREE.PerspectiveCamera;
    const u = this.uniforms;
    const fog = this.ctx.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density;
    }
    u.uFar.value = cam.far ?? 2400;
    this.sortIn -= dt;
    if (this.sortIn > 0) return;
    // a few times a second: wrap the field round the camera and sort it back to front
    this.sortIn = 0.2;
    const p = cam.position;
    let inside = 0;
    for (const o of this.order) {
      const f = this.puffs[o.i];
      o.x = p.x + THREE.MathUtils.euclideanModulo(f.x - p.x + TILE / 2, TILE) - TILE / 2;
      o.z = p.z + THREE.MathUtils.euclideanModulo(f.z - p.z + TILE / 2, TILE) - TILE / 2;
      o.d = (o.x - p.x) ** 2 + (f.y - p.y) ** 2 + (o.z - p.z) ** 2;
      const k = 1 - Math.sqrt(o.d) / (f.size * 0.42);
      if (k > inside && p.y > f.base) inside = k;
    }
    this.inside = Math.min(1, inside * 1.6);
    this.order.sort((a, b) => b.d - a.d);
    const P = this.aPuff.array as Float32Array;
    const I = this.aInfo.array as Float32Array;
    this.order.forEach((o, k) => {
      const f = this.puffs[o.i];
      P[k * 4] = o.x;
      P[k * 4 + 1] = f.y;
      P[k * 4 + 2] = o.z;
      P[k * 4 + 3] = f.size;
      I[k * 4] = f.base;
      I[k * 4 + 1] = f.height;
      I[k * 4 + 2] = f.seed;
    });
    this.aPuff.needsUpdate = true;
    this.aInfo.needsUpdate = true;
  }
}
