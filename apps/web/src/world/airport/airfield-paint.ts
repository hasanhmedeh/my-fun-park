// The airfield's thin painted lines as one mesh: the taxiway centrelines and their turn curves,
// the stand lead-in lines and stop marks, the apron's service road lines, the equipment boxes and
// the red equipment restraint lines with their hatching.
//
// They can't be painted into the pavement's distance field (a 15–30 cm line is narrower than its
// texels), and plain thin quads would shimmer and break up into dashes as soon as they shrink
// below a pixel. So each run of strokes is a ribbon whose vertices the shader pushes out to at
// least a pixel and a half across (measured square to the line, foreshortening included), and the
// fragment shader box-filters the true width over the pixel's footprint: up close a crisp,
// anti-aliased line; far away a faint, steady one with the right average brightness, as the eye
// sees it. The ribbons lie a hair above the ground with a stronger depth offset than the
// pavement, below the lettering's.

import * as THREE from 'three';
import { withFogSun } from '../fog';
import { farFadeFog, noiseTexture } from '../terrain-shader';
import { GROUND_Y } from './airfield-ground';
import type { AirfieldPlan, P2, Stroke } from './airfield-plan';

const PAINT_Y = GROUND_Y + 0.02;

const PAINTS: { key: 'yellow' | 'white' | 'red'; hex: string }[] = [
  { key: 'yellow', hex: '#f0b92a' },
  { key: 'white', hex: '#e6e6de' },
  { key: 'red', hex: '#b0161f' },
];

/** Joins strokes end to end into polylines (the plan lays curves down as runs of short strokes). */
function chains(strokes: Stroke[]) {
  const out: { pts: P2[]; w: number }[] = [];
  let cur: { pts: P2[]; w: number } | null = null;
  for (const s of strokes) {
    const last = cur?.pts[cur.pts.length - 1];
    if (cur && last && cur.w === s.w && Math.abs(last.x - s.a.x) < 1e-3 && Math.abs(last.z - s.a.z) < 1e-3) {
      cur.pts.push(s.b);
      continue;
    }
    cur = { pts: [s.a, s.b], w: s.w };
    out.push(cur);
  }
  return out;
}

function paintGeometry(plan: AirfieldPlan, origin: THREE.Vector3) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const side: number[] = [];
  const miter: number[] = [];
  const half: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (const paint of PAINTS) {
    c.set(paint.hex);
    for (const ch of chains(plan[paint.key])) {
      const pts = ch.pts;
      const n = pts.length;
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(n - 1, i + 1)];
        // the tangent here (averaged at the joints), its left-hand normal and the miter's stretch
        const inL = Math.hypot(p.x - a.x, p.z - a.z) || 1;
        const tx = b.x - a.x;
        const tz = b.z - a.z;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = tz / tl;
        const nz = -tx / tl;
        const inNx = i > 0 ? (p.z - a.z) / inL : nx;
        const inNz = i > 0 ? -(p.x - a.x) / inL : nz;
        const stretch = 1 / Math.max(0.35, nx * inNx + nz * inNz);
        for (const s of [-1, 1]) {
          pos.push(p.x - origin.x, PAINT_Y - origin.y, p.z - origin.z);
          nrm.push(0, 1, 0);
          col.push(c.r, c.g, c.b);
          side.push(s);
          miter.push(nx * stretch, nz * stretch);
          half.push(ch.w / 2);
        }
        if (i > 0) {
          const q = base + (i - 1) * 2;
          // wound to face up
          idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aMiter', new THREE.Float32BufferAttribute(miter, 2));
  g.setAttribute('aHalf', new THREE.Float32BufferAttribute(half, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  // the ribbons widen with distance: pad the bounds so culling never clips a widened line
  if (g.boundingSphere) g.boundingSphere.radius += 10;
  return g;
}

const VERT_PARS = /* glsl */ `
attribute float aSide;
attribute vec2 aMiter;
attribute float aHalf;
uniform float uPxScale;
varying float vAcross;
varying float vMpp;
varying float vHalf;
varying vec2 vPaintW;
`;

const VERT_BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
{
  vec3 wc = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 toP = wc - cameraPosition;
  float dist = max(length(toP), 0.01);
  vec3 nu = normalize(vec3(aMiter.x, 0.0, aMiter.y));
  float k = dot(nu, toP / dist);
  // metres per pixel square to the line, where it lies on the ground
  float mpp = dist / (uPxScale * sqrt(max(1.0 - k * k, 0.0025)));
  float hq = aHalf + 0.75 * mpp;
  transformed.xz += aMiter * aSide * hq;
  vAcross = aSide * hq;
  vMpp = mpp;
  vHalf = aHalf;
  vPaintW = wc.xz;
}
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uNoise;
varying float vAcross;
varying float vMpp;
varying float vHalf;
varying vec2 vPaintW;
`;

const FRAG_COVER = /* glsl */ `
#include <color_fragment>
{
  // the line's width box-filtered over the pixel's footprint across it
  float lo = max(vAcross - 0.5 * vMpp, -vHalf);
  float hi = min(vAcross + 0.5 * vMpp, vHalf);
  float cover = clamp((hi - lo) / vMpp, 0.0, 1.0);
  float wear = 0.82 + 0.18 * texture2D(uNoise, vPaintW / 3.1).w;
  diffuseColor.rgb *= wear;
  diffuseColor.a *= cover * wear;
}
`;

export class PaintLines {
  readonly mesh: THREE.Mesh;
  private pxScale = { value: 800 };

  constructor(plan: AirfieldPlan, origin: THREE.Vector3) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const noise = { value: noiseTexture() };
    mat.onBeforeCompile = (shader) => {
      withFogSun(shader);
      farFadeFog(shader);
      shader.uniforms.uPxScale = this.pxScale;
      shader.uniforms.uNoise = noise;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <begin_vertex>', VERT_BEGIN);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_PARS}`).replace('#include <color_fragment>', FRAG_COVER);
    };
    mat.customProgramCacheKey = () => 'airfield-paint';
    this.mesh = new THREE.Mesh(paintGeometry(plan, origin), mat);
    this.mesh.position.copy(origin);
    this.mesh.updateMatrix();
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
  }

  /** Pixels per unit of distance at the screen's centre (the drawing buffer's height over the view's height at 1 m). */
  setPixelScale(s: number) {
    this.pxScale.value = s;
  }
}
