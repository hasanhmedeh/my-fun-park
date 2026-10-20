// The A320's external lights as the eye sees them: one point-sprite flare per lamp (nav lights in
// their real sectors, beacons, double-flash strobes, landing, taxi and runway turn-off lights),
// sized in pixels from the distance so a wingtip reads as a bright dot from 10 km at night and as a
// lamp with a halo up close; plus the landing and taxi beams as soft additive cones in the haze.
// Each is one draw call per aircraft, and nothing allocates per frame.

import * as THREE from 'three';
import { A320_POINTS } from '../../../aviation/a320';
import { fogSun } from '../../fog';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAIL_Z, WING, fuselage, wingLeZ, wingY } from './shape';

export type Lamp = 'navL' | 'navR' | 'tail' | 'strobeL' | 'strobeR' | 'strobeT' | 'beaconT' | 'beaconB' | 'landL' | 'landR' | 'taxi' | 'turnL' | 'turnR';

interface LampDef {
  pos: [number, number, number];
  colour: [number, number, number];
  /** Apparent size up close (m). */
  size: number;
  /** Beam direction (body frame) and the cosines where it starts to fade and where it's gone; omni lamps have none. */
  dir?: [number, number, number];
  cone?: [number, number];
  /** How much of its night brightness it keeps by day (strobes and landing lights cut through daylight). */
  day: number;
  /** Extra apparent size (CSS px) when seen straight down its beam: a landing light dazzles from kilometres away. */
  glare?: number;
}

/** The wingtip lamps sit in the fairing ahead of the sharklet; the tail lamps on the tail cone's end. */
const TIP_LIGHT = { x: WING.tip + 0.12, y: wingY(WING.tip) + 0.06, z: wingLeZ(WING.tip) + 0.45 };
const FUS_TAIL_LIGHT = { x: 0, y: (fuselage.top(TAIL_Z) + fuselage.bot(TAIL_Z)) / 2 + 0.24, z: TAIL_Z - 0.05 };

const deg = (d: number) => Math.cos((d * Math.PI) / 180);
const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const LAMPS: Record<Lamp, LampDef> = {
  // red left, green right, each from dead ahead to 110° round its side
  navL: { pos: [-TIP_LIGHT.x, TIP_LIGHT.y, TIP_LIGHT.z], colour: [6, 0.25, 0.2], size: 0.9, dir: norm([-0.82, 0, -0.57]), cone: [deg(50), deg(62)], day: 0.12 },
  navR: { pos: [TIP_LIGHT.x, TIP_LIGHT.y, TIP_LIGHT.z], colour: [0.25, 6, 1.2], size: 0.9, dir: norm([0.82, 0, -0.57]), cone: [deg(50), deg(62)], day: 0.12 },
  tail: { pos: [FUS_TAIL_LIGHT.x, FUS_TAIL_LIGHT.y, FUS_TAIL_LIGHT.z], colour: [5, 5, 4.6], size: 0.7, dir: [0, 0, 1], cone: [deg(62), deg(75)], day: 0.12 },
  strobeL: { pos: [-TIP_LIGHT.x, TIP_LIGHT.y + 0.05, TIP_LIGHT.z + 0.4], colour: [14, 14, 16], size: 1.1, day: 0.55 },
  strobeR: { pos: [TIP_LIGHT.x, TIP_LIGHT.y + 0.05, TIP_LIGHT.z + 0.4], colour: [14, 14, 16], size: 1.1, day: 0.55 },
  strobeT: { pos: [FUS_TAIL_LIGHT.x, FUS_TAIL_LIGHT.y + 0.1, FUS_TAIL_LIGHT.z - 0.15], colour: [12, 12, 14], size: 0.95, day: 0.5 },
  beaconT: { pos: [0, 6.04, -0.9], colour: [9, 0.4, 0.2], size: 0.95, day: 0.3 },
  beaconB: { pos: [0, 1.66, -7.3], colour: [9, 0.4, 0.2], size: 0.95, day: 0.3 },
  landL: { pos: [A320_POINTS.landingLightL.x, A320_POINTS.landingLightL.y, A320_POINTS.landingLightL.z], colour: [16, 15, 13], size: 2.4, dir: norm([-0.04, -0.035, -1]), cone: [deg(9), deg(24)], day: 0.6, glare: 16 },
  landR: { pos: [A320_POINTS.landingLightR.x, A320_POINTS.landingLightR.y, A320_POINTS.landingLightR.z], colour: [16, 15, 13], size: 2.4, dir: norm([0.04, -0.035, -1]), cone: [deg(9), deg(24)], day: 0.6, glare: 16 },
  taxi: { pos: [0, 1.72, A320_POINTS.taxiLight.z - 0.3], colour: [10, 9.6, 8.6], size: 1.2, dir: norm([0, -0.12, -1]), cone: [deg(18), deg(40)], day: 0.35, glare: 7 },
  turnL: { pos: [-0.13, 1.72, A320_POINTS.taxiLight.z - 0.3], colour: [8, 7.8, 7], size: 0.9, dir: norm([-0.55, -0.08, -0.83]), cone: [deg(20), deg(38)], day: 0.3 },
  turnR: { pos: [0.13, 1.72, A320_POINTS.taxiLight.z - 0.3], colour: [8, 7.8, 7], size: 0.9, dir: norm([0.55, -0.08, -0.83]), cone: [deg(20), deg(38)], day: 0.3 },
};
export const LAMP_IDS = Object.keys(LAMPS) as Lamp[];

const FLARE_VERT = /* glsl */ `
attribute vec3 aColour;
attribute float aSize;
attribute vec3 aDir;
attribute vec2 aCone;
attribute float aOn;
attribute float aGlare;
uniform float uViewH;
uniform float uMinPx;
varying vec3 vColour;
varying float vCore;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 toEye = normalize(cameraPosition - world.xyz);
  float k = aOn;
  float glare = 0.0;
  if (aCone.x > -1.5) {
    vec3 d = normalize(mat3(modelMatrix) * aDir);
    float beam = smoothstep(aCone.y, aCone.x, dot(d, toEye));
    k *= beam;
    glare = aGlare * beam * beam * aOn;
  }
  vec4 mvPosition = viewMatrix * world;
  float dist = max(0.5, -mvPosition.z);
  // pull the sprite a little towards the eye so the skin it sits on doesn't swallow it
  mvPosition.xyz += normalize(-mvPosition.xyz) * min(0.8, dist * 0.4);
  gl_Position = projectionMatrix * mvPosition;
  float px = aSize * uViewH * projectionMatrix[1][1] / (2.0 * dist) * 3.2;
  // (uMinPx is 4.5 CSS px in device pixels, so the glare scales with the screen's density too)
  float size = max(px, uMinPx * (1.0 + glare / 4.5));
  // a lamp below its true size keeps its punch as a point, a little dimmer with distance
  k *= mix(1.0, sqrt(clamp(px / uMinPx, 0.0, 1.0)), 0.4);
  vCore = clamp(px / 14.0, 0.0, 1.0);
  vColour = aColour * k;
  gl_PointSize = k > 0.003 ? size : 0.0;
  #include <fog_vertex>
}`;

const FLARE_FRAG = /* glsl */ `
varying vec3 vColour;
varying float vCore;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  // a hot core, a soft halo and (up close) faint diffraction spikes
  float core = exp(-r2 * mix(3.5, 40.0, vCore));
  float halo = exp(-r2 * 4.0) * 0.28;
  float spikes = vCore * 0.22 * (exp(-abs(c.x) * 28.0) + exp(-abs(c.y) * 28.0)) * (1.0 - r2);
  float a = core + halo + spikes;
  float fade = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    // a lamp pierces haze that swallows the airframe: it keeps a fifth of its punch in thick fog
    fade = 1.0 - fogFactor * 0.8;
  #endif
  gl_FragColor = vec4(vColour * a * fade, 1.0);
}`;

/** The flares of one aircraft: a Points object in its group, driven by `update`. */
export class Flares {
  readonly points: THREE.Points;
  private readonly on: Float32Array;
  private readonly attr: THREE.BufferAttribute;
  private readonly size = new THREE.Vector2();

  constructor() {
    const g = new THREE.BufferGeometry();
    const n = LAMP_IDS.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const cone = new Float32Array(n * 2);
    const size = new Float32Array(n);
    const glare = new Float32Array(n);
    LAMP_IDS.forEach((id, i) => {
      const l = LAMPS[id];
      pos.set(l.pos, i * 3);
      col.set(l.colour, i * 3);
      dir.set(l.dir ?? [0, 0, 0], i * 3);
      cone.set(l.cone ?? [-2, -2], i * 2);
      size[i] = l.size;
      glare[i] = l.glare ?? 0;
    });
    this.on = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColour', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aCone', new THREE.BufferAttribute(cone, 2));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aGlare', new THREE.BufferAttribute(glare, 1));
    this.attr = new THREE.BufferAttribute(this.on, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOn', this.attr);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 24);
    const m = new THREE.ShaderMaterial({
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uViewH: { value: 720 }, uMinPx: { value: 4.5 } }]),
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    Object.assign(m.uniforms, fogSun);
    this.points = new THREE.Points(g, m);
    this.points.renderOrder = 5;
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.size);
      m.uniforms.uViewH.value = this.size.y;
      // the smallest dot is set in CSS pixels, so a far lamp reads the same on a high-density phone screen
      m.uniforms.uMinPx.value = 4.5 * renderer.getPixelRatio();
    };
  }

  /** Set every lamp's brightness (0..1, already including flashing and day/night) and upload. */
  set(values: Record<Lamp, number>, night: number) {
    let any = false;
    LAMP_IDS.forEach((id, i) => {
      const v = values[id] * (LAMPS[id].day + (1 - LAMPS[id].day) * night);
      this.on[i] = v;
      if (v > 0.003) any = true;
    });
    this.attr.needsUpdate = true;
    this.points.visible = any;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------------------------------------
// Beams
// ------------------------------------------------------------------------------------------------

const BEAM_VERT = /* glsl */ `
attribute float aT;
attribute float aWhich;
uniform vec3 uOn;
varying float vT;
varying float vK;
varying float vEdge;
#include <fog_pars_vertex>
void main() {
  vT = aT;
  vK = aWhich < 0.5 ? uOn.x : aWhich < 1.5 ? uOn.y : uOn.z;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vEdge = abs(dot(n, normalize(cameraPosition - world.xyz)));
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BEAM_FRAG = /* glsl */ `
uniform float uK;
varying float vT;
varying float vK;
varying float vEdge;
#include <fog_pars_fragment>
void main() {
  // bright at the lamp, fading out along the beam; soft at the cone's silhouette
  float a = uK * vK * pow(1.0 - vT, 2.2) * smoothstep(0.0, 0.03, vT) * pow(vEdge, 1.6);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    a *= 1.0 - fogFactor;
  #endif
  gl_FragColor = vec4(vec3(1.0, 0.96, 0.88) * a, 1.0);
}`;

/** The landing lights' and taxi light's beams. */
export class Beams {
  readonly mesh: THREE.Mesh;
  private readonly m: THREE.ShaderMaterial;

  constructor() {
    const parts: THREE.BufferGeometry[] = [];
    const add = (lamp: Lamp, length: number, radius: number, which: number) => {
      const l = LAMPS[lamp];
      const g = new THREE.ConeGeometry(radius, length, 20, 6, true);
      // apex at the lamp: the cone's tip is at +y; turn +y into the beam's backward direction
      g.translate(0, -length / 2, 0);
      const t = new Float32Array(g.getAttribute('position').count);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) t[i] = -p.getY(i) / length;
      g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
      g.setAttribute('aWhich', new THREE.BufferAttribute(new Float32Array(p.count).fill(which), 1));
      const d = new THREE.Vector3(...l.dir!);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d));
      g.translate(...l.pos);
      parts.push(g);
    };
    add('landL', 110, 13, 0);
    add('landR', 110, 13, 1);
    add('taxi', 38, 9, 2);
    const merged = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -60), 75);
    this.m = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uOn: { value: new THREE.Vector3() }, uK: { value: 0 } }]),
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    Object.assign(this.m.uniforms, fogSun);
    this.mesh = new THREE.Mesh(merged, this.m);
    this.mesh.renderOrder = 4;
  }

  set(landL: number, landR: number, taxi: number, night: number) {
    (this.m.uniforms.uOn.value as THREE.Vector3).set(landL, landR, taxi);
    const k = 0.03 * night;
    this.m.uniforms.uK.value = k;
    this.mesh.visible = k > 0.001 && landL + landR + taxi > 0.01;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.m.dispose();
  }
}
