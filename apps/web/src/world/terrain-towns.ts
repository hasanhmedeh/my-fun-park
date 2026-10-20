// The mainland's villages and farms, as seen from the airport, the coast and the air: houses with
// gabled roofs along a few streets in each village (a church tower in the middle), farmsteads out
// in the fields, and at night lit windows and street lamps. Everything is instanced: walls, roofs,
// spires and lamps are four draw calls for the whole country.

import * as THREE from 'three';
import type { Ctx } from './context';
import { withFogSun } from './fog';
import { AIRPORTS, homeShoreDist } from './geo';
import type { Quality } from './quality';
import { mulberry } from './random';
import { farFadeFog, LAND_UNIFORMS } from './terrain-shader';
import { VILLAGES, coastRoadZ, forestAt, groundY, roadDist } from './terrain-land';
import { glowTexture } from './textures';

interface Building {
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  h: number;
  wall: string;
  roof: string;
  /** Roof pitch: ridge height over the width. */
  pitch: number;
  /** A church tower: a spire instead of a gable. */
  tower?: boolean;
}

const WALLS = ['#e9e1d0', '#efe6cf', '#d9cbb0', '#e4d3b4', '#cfc3ae', '#f1ece2', '#d8c09a', '#c9b79a'];
const ROOFS = ['#9a4a32', '#a8553a', '#8a3f2c', '#5b5550', '#6a5f58', '#b0603e', '#7d4636'];
const BARN_WALLS = ['#8a4a36', '#7a6a58', '#9a8f80', '#6e3a2c'];
const BARN_ROOFS = ['#4f4c48', '#5e5a55', '#6b5b4b'];

/** The houses, church and street lamps of one village, along a few streets out from its centre and along the coast road. */
function village(v: (typeof VILLAGES)[number], out: Building[], lamps: number[]) {
  const rnd = mulberry(900 + v.seed * 31);
  const near = (x: number, z: number, gap: number) => out.some((b) => (b.x - x) ** 2 + (b.z - z) ** 2 < gap * gap);
  const ok = (x: number, z: number) => homeShoreDist(x, z) > 60 && Math.hypot(x - v.x, z - v.z) < v.r;
  // the church on the green in the middle
  const cy = rnd() * Math.PI;
  const chx = v.x + Math.cos(cy) * 18;
  const chz = v.z + Math.sin(cy) * 18;
  out.push({ x: chx, z: chz, yaw: cy, w: 11, d: 24, h: 10, wall: '#d8cfbd', roof: '#5b5550', pitch: 0.7 });
  // the tower at one end of the nave (along its local z)
  out.push({ x: chx + Math.sin(cy) * 15, z: chz + Math.cos(cy) * 15, yaw: cy, w: 6, d: 6, h: 22, wall: '#d2c8b4', roof: '#4c4844', pitch: 2.4, tower: true });
  // streets: a few running out from the centre, wandering a little, plus the coast road through it
  const streets: { x: number; z: number; ux: number; uz: number }[][] = [];
  const nStreets = 3 + Math.floor(rnd() * 3);
  for (let s = 0; s < nStreets; s++) {
    const a0 = (s / nStreets) * Math.PI * 2 + rnd() * 0.8;
    const pts: { x: number; z: number; ux: number; uz: number }[] = [];
    let a = a0;
    let x = v.x;
    let z = v.z;
    for (let d = 0; d < v.r; d += 12) {
      a += (rnd() - 0.5) * 0.12;
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      x += ux * 12;
      z += uz * 12;
      pts.push({ x, z, ux, uz });
    }
    streets.push(pts);
  }
  if (Math.abs(coastRoadZ(v.x) - v.z) < v.r) {
    const pts: { x: number; z: number; ux: number; uz: number }[] = [];
    for (let x = v.x - v.r; x < v.x + v.r; x += 12) {
      const z = coastRoadZ(x);
      const dz = coastRoadZ(x + 1) - z;
      const l = Math.hypot(1, dz);
      pts.push({ x, z, ux: 1 / l, uz: dz / l });
    }
    streets.push(pts);
  }
  for (const pts of streets)
    pts.forEach((p, i) => {
      if (i % 3 === 0) lamps.push(p.x - p.uz * 6, groundY(p.x, p.z) + 5, p.z + p.ux * 6);
      for (const side of [-1, 1]) {
        if (rnd() < 0.18) continue;
        const set = 9 + rnd() * 5;
        const x = p.x - p.uz * set * side;
        const z = p.z + p.ux * set * side;
        if (!ok(x, z) || near(x, z, 10.5) || roadDist(x, z) < 9) continue;
        const w = 7 + rnd() * 4;
        out.push({
          x,
          z,
          yaw: Math.atan2(p.ux, p.uz) + (rnd() - 0.5) * 0.1,
          w,
          d: 8 + rnd() * 5,
          h: 5 + Math.floor(rnd() * 2) * 2.8 + rnd() * 0.8,
          wall: WALLS[Math.floor(rnd() * WALLS.length)],
          roof: ROOFS[Math.floor(rnd() * ROOFS.length)],
          pitch: 0.42 + rnd() * 0.2,
        });
      }
    });
}

/** Farmsteads out in the fields: a farmhouse and a barn or two, every kilometre or so, kept off the airport's surroundings. */
function farms(out: Building[]) {
  const rnd = mulberry(4040);
  const rw = AIRPORTS.home.runway;
  const SP = 950;
  for (let gx = -26; gx <= 26; gx++)
    for (let gz = -26; gz <= 2; gz++) {
      const x = gx * SP + (rnd() - 0.5) * SP * 0.8;
      const z = gz * SP + (rnd() - 0.5) * SP * 0.8;
      const s = homeShoreDist(x, z);
      if (s < 300 || Math.hypot(x, z + 50) < 1900) continue;
      // nothing within 2.5 km of the runway, nor under the approaches for 13 km out
      const dx = Math.max(rw.x0 - x, 0, x - rw.x1);
      if (Math.hypot(dx, z - rw.z) < 2500 || (Math.abs(z - rw.z) < 600 && Math.abs(x) < rw.x1 + 13000)) continue;
      if (VILLAGES.some((v) => Math.hypot(x - v.x, z - v.z) < v.r + 250)) continue;
      const h = groundY(x, z);
      if (h > 140 || forestAt(x, z, h, s) > 0.2 || rnd() < 0.25) continue;
      const yaw = rnd() * Math.PI;
      const ux = Math.cos(yaw);
      const uz = Math.sin(yaw);
      out.push({ x, z, yaw, w: 8 + rnd() * 2, d: 11 + rnd() * 3, h: 6.5, wall: WALLS[Math.floor(rnd() * WALLS.length)], roof: ROOFS[Math.floor(rnd() * ROOFS.length)], pitch: 0.5 });
      const barns = 1 + Math.floor(rnd() * 2.2);
      for (let b = 0; b < barns; b++) {
        const off = 24 + b * 22 + rnd() * 6;
        const bx = x + ux * off - uz * (rnd() - 0.5) * 14;
        const bz = z + uz * off + ux * (rnd() - 0.5) * 14;
        out.push({ x: bx, z: bz, yaw: yaw + (rnd() < 0.5 ? 0 : Math.PI / 2), w: 13 + rnd() * 6, d: 22 + rnd() * 14, h: 6 + rnd() * 2, wall: BARN_WALLS[Math.floor(rnd() * BARN_WALLS.length)], roof: BARN_ROOFS[Math.floor(rnd() * BARN_ROOFS.length)], pitch: 0.32 });
      }
    }
}

/** A gable roof for a unit house: x −0.5..0.5 (eaves), ridge along z at y = 1. */
function gableGeo() {
  const e = 0.5;
  const p = [
    // the two roof slopes
    -e, 0, -e, -e, 0, e, 0, 1, e, -e, 0, -e, 0, 1, e, 0, 1, -e,
    e, 0, e, e, 0, -e, 0, 1, -e, e, 0, e, 0, 1, -e, 0, 1, e,
    // the gable ends
    -e, 0, e, e, 0, e, 0, 1, e,
    e, 0, -e, -e, 0, -e, 0, 1, -e,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** A four-sided spire for a unit tower. */
function spireGeo() {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, true).rotateY(Math.PI / 4).translate(0, 0.5, 0);
  g.deleteAttribute('uv');
  return g.toNonIndexed();
}

/** Walls with windows: dark glass by day, a share of them lit warm at night (fading to their average once they're smaller than a pixel). */
function wallMaterial() {
  const mat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  mat.onBeforeCompile = (shader) => {
    withFogSun(shader);
    farFadeFog(shader);
    shader.uniforms.uNight = LAND_UNIFORMS.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHouse;\nvarying vec3 vHouseN;\nvarying float vSeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 hs = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vHouse = position * hs;
        vHouseN = normal;
        vSeed = fract(instanceMatrix[3].x * 0.0137 + instanceMatrix[3].z * 0.0291);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        varying vec3 vHouse;
        varying vec3 vHouseN;
        varying float vSeed;
        float hashW(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float winMask = 0.0;
        float winLit = 0.0;
        if (abs(vHouseN.y) < 0.5) {
          float u = abs(vHouseN.x) > 0.5 ? vHouse.z : vHouse.x;
          float v = vHouse.y;
          vec2 cell = vec2(floor(u / 3.1), floor((v - 0.7) / 2.8));
          vec2 f = vec2(fract(u / 3.1), fract((v - 0.7) / 2.8));
          float px = max(fwidth(u), fwidth(v));
          float edge = 0.04 + px * 0.3;
          float m = smoothstep(0.28 - edge, 0.28 + edge, f.x) * (1.0 - smoothstep(0.72 - edge, 0.72 + edge, f.x))
                  * smoothstep(0.3 - edge, 0.3 + edge, f.y) * (1.0 - smoothstep(0.78 - edge, 0.78 + edge, f.y));
          // sub-pixel windows: their average coverage instead of shimmering
          m = mix(m, 0.2, smoothstep(0.6, 1.4, px));
          // none at the foot of the wall below the first floor's windows, none in the gable's band
          m *= step(0.7, v);
          winMask = m;
          winLit = step(0.5, hashW(cell + vSeed * 97.0 + vec2(vHouseN.x * 3.0, vHouseN.z * 7.0)));
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.1, 0.13), winMask * 0.85);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.68, 0.36) * 2.2 * winMask * winLit * uNight;`,
      );
  };
  mat.customProgramCacheKey = () => 'town-walls';
  return mat;
}

/** Night lights seen from afar: street lamps, a few pixels across whatever the distance. */
function lampPoints(positions: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: glowTexture('#ffd59a') },
      uNight: LAND_UNIFORMS.uNight,
      uFog: { value: 0 },
      uFogColor: { value: new THREE.Color() },
      uScale: { value: 600 },
    },
    vertexShader: /* glsl */ `
      uniform float uScale;
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uScale * 8.0 / vDepth, 2.5, 26.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uNight;
      uniform float uFog;
      varying float vDepth;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        float fog = exp(-uFog * uFog * vDepth * vDepth);
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.5) * 3.0 * a * uNight * fog, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

export class Towns {
  readonly group = new THREE.Group();
  private lamps: THREE.Points;

  constructor(
    private ctx: Ctx,
    q: Quality,
  ) {
    const buildings: Building[] = [];
    const lamps: number[] = [];
    for (const v of VILLAGES) village(v, buildings, lamps);
    if (q.tier !== 'lowest') farms(buildings);

    const n = buildings.length;
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), wallMaterial(), n);
    const roofMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    roofMat.onBeforeCompile = (shader) => {
      withFogSun(shader);
      farFadeFog(shader);
    };
    roofMat.customProgramCacheKey = () => 'town-roofs';
    const gables = new THREE.InstancedMesh(gableGeo(), roofMat, n);
    const spires = new THREE.InstancedMesh(spireGeo(), roofMat, VILLAGES.length);
    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    let ng = 0;
    let ns = 0;
    buildings.forEach((b, i) => {
      // on a slope the walls carry on down into the ground to its lowest corner
      const ca = Math.cos(b.yaw);
      const sa = Math.sin(b.yaw);
      let lo = Infinity;
      let hi = -Infinity;
      for (const [u, w] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const gy = groundY(b.x + (u * b.w * ca + w * b.d * sa) / 2, b.z + (-u * b.w * sa + w * b.d * ca) / 2);
        lo = Math.min(lo, gy);
        hi = Math.max(hi, gy);
      }
      const base = lo - 0.4;
      const top = hi + b.h;
      qt.setFromAxisAngle(up, b.yaw);
      walls.setMatrixAt(i, m.compose(pos.set(b.x, base, b.z), qt, sc.set(b.w, top - base, b.d)));
      walls.setColorAt(i, c.set(b.wall));
      if (b.tower) {
        spires.setMatrixAt(ns, m.compose(pos.set(b.x, top, b.z), qt, sc.set(b.w * 1.02, b.w * b.pitch, b.d * 1.02)));
        spires.setColorAt(ns++, c.set(b.roof));
      } else {
        // the roof overhangs the walls a little
        gables.setMatrixAt(ng, m.compose(pos.set(b.x, top, b.z), qt, sc.set(b.w + 0.7, b.w * b.pitch, b.d + 0.6)));
        gables.setColorAt(ng++, c.set(b.roof));
      }
    });
    gables.count = ng;
    spires.count = ns;
    for (const im of [walls, gables, spires]) {
      im.receiveShadow = q.shadows;
      im.castShadow = false;
      im.matrixAutoUpdate = false;
      im.renderOrder = 1;
      im.computeBoundingSphere();
      this.group.add(im);
    }
    this.lamps = lampPoints(lamps);
    this.group.add(this.lamps);
  }

  /** 0 by day .. 1 at night: windows and street lamps (LAND_UNIFORMS.uNight drives both). */
  setNight(k: number) {
    this.lamps.visible = k > 0.02;
  }

  /** Keeps the lamps' own fog and size in step with the scene. */
  update() {
    const fog = this.ctx.scene.fog as THREE.FogExp2 | null;
    const u = (this.lamps.material as THREE.ShaderMaterial).uniforms;
    u.uFog.value = fog ? fog.density * 0.55 : 0;
    u.uScale.value = this.ctx.renderer.domElement.height * 0.5;
  }
}
