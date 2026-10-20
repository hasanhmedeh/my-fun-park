// Every airfield light in one draw call: instanced camera-facing flares, coloured and aimed as the
// plan says (airfield-plan.ts), drawn additively so they bloom at night.
//
// Real airfield lights are tiny lamps that read from many kilometres because they're intense and
// aimed: here each flare has a size in metres but never shrinks below a couple of pixels (it dims
// instead, slower than its area would), its beam fades off-axis (runway lights face along the
// runway, the PAPI's beams are tight), the fog dims it less than it dims the land, and the
// shader works out what only it can know cheaply: the PAPI's red or white from the viewer's
// elevation angle, the sequenced flashers' "rabbit" and the guard lights' wig-wag from the clock.

import * as THREE from 'three';
import type { LightGroup, LightSpec } from './airfield-plan';

export const GROUPS: LightGroup[] = ['runway', 'approach', 'papi', 'taxi', 'taxiEdge', 'stopbar', 'guard', 'obstruction'];

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec4 iBeam;
attribute vec4 iParam;
attribute float iOn;
uniform float uTime;
uniform float uScale;
uniform float uMinPx;
uniform float uGlow;
uniform float uFog;
uniform vec2 uViewport;
uniform float uGroup[${GROUPS.length}];
varying vec2 vQ;
varying vec3 vCol;
varying float vSharp;

void main() {
  vec4 world = modelMatrix * vec4(iPos, 1.0);
  vec4 mv = viewMatrix * world;
  float dist = -mv.z;
  float k = iOn * uGroup[int(iParam.w + 0.5)];
  if (k <= 0.001 || dist <= 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 toCam = normalize(cameraPosition - world.xyz);
  float I = 1.0;
  float bl = length(iBeam.xyz);
  if (bl > 0.0) I = iParam.x + (1.0 - iParam.x) * pow(max(dot(toCam, iBeam.xyz / bl), 0.0), iBeam.w);
  vec3 col = iCol.rgb;
  // the PAPI: white above the unit's angle, red below, through a narrow pink transition
  if (iParam.z > 0.0) {
    float el = degrees(asin(clamp(toCam.y, -1.0, 1.0)));
    col = mix(vec3(1.0, 0.05, 0.03) * max(col.r, col.g), col, smoothstep(iParam.z - 0.07, iParam.z + 0.07, el));
  }
  // sequenced flashers: twice a second, a 40 ms burst at this lamp's phase; wig-wags alternate
  float fl = iParam.y;
  if (fl >= 0.0 && fl < 1.5) {
    float ph = fract(uTime * 2.0 - fl);
    I *= exp(-ph * 55.0) * 1.4;
  } else if (fl > 1.5) {
    float on = step(0.5, fract(uTime * 0.8));
    I *= fl < 2.5 ? on : 1.0 - on;
  }
  // haze dims lights much less than it hides the land
  float fd = uFog * dist * 0.45;
  I *= exp(-fd * fd);
  // apparent size: by day just the lamp's lens, a hard bright point; at night its glow blooms
  // round it. Never below the minimum (then it dims instead).
  float px = iCol.a * uScale / dist;
  float R = px * mix(0.45, 2.0, uGlow);
  if (R < uMinPx) {
    I *= pow(R / uMinPx, 1.0);
    R = uMinPx;
  }
  vCol = col * I * k;
  vSharp = clamp(R / max(px * 0.4, 1e-3), 1.0, 6.0);
  vQ = position.xy;
  // Pulled towards the eye so the flare's lower half isn't buried in the ground it stands on: the
  // ray through its bottom edge meets the ground r / tan(elevation) short of the lamp, r being the
  // glow's radius at the lamp (the pixel size is kept: it's applied after the move).
  float sinE = clamp(toCam.y, 0.02, 0.99);
  float rw = R * dist / uScale;
  mv.xyz += normalize(-mv.xyz) * min(0.5 + rw * sqrt(1.0 - sinE * sinE) / sinE, dist * 0.6);
  gl_Position = projectionMatrix * mv;
  gl_Position.xy += position.xy * R * 2.0 / uViewport * gl_Position.w;
}
`;

const FRAG = /* glsl */ `
uniform float uGlow;
varying vec2 vQ;
varying vec3 vCol;
varying float vSharp;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * vSharp * vSharp * 2.2);
  float glow = exp(-r2 * 5.0) * 0.28 * uGlow;
  gl_FragColor = vec4(vCol * (core + glow), 1.0);
}
`;

export class AirfieldLights {
  readonly mesh: THREE.Mesh;
  readonly specs: LightSpec[];
  private on: THREE.InstancedBufferAttribute;
  private uniforms = {
    uTime: { value: 0 },
    uScale: { value: 800 },
    uMinPx: { value: 1.6 },
    uGlow: { value: 1 },
    uFog: { value: 0 },
    uViewport: { value: new THREE.Vector2(1280, 720) },
    uGroup: { value: GROUPS.map(() => 1) },
  };

  constructor(specs: LightSpec[], origin: THREE.Vector3) {
    this.specs = specs;
    const n = specs.length;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 4);
    const beam = new Float32Array(n * 4);
    const param = new Float32Array(n * 4);
    specs.forEach((l, i) => {
      // positions relative to the airfield's origin keep the floats small at 40 km out
      pos.set([l.x - origin.x, l.y - origin.y, l.z - origin.z], i * 3);
      col.set([l.r, l.g, l.b, l.size], i * 4);
      beam.set([l.dx, l.dy, l.dz, l.exp], i * 4);
      param.set([l.omni, l.flash, l.papi, GROUPS.indexOf(l.group)], i * 4);
    });
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(col, 4));
    g.setAttribute('iBeam', new THREE.InstancedBufferAttribute(beam, 4));
    g.setAttribute('iParam', new THREE.InstancedBufferAttribute(param, 4));
    this.on = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
    this.on.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iOn', this.on);
    g.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.position.copy(origin);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** How bright each group shows (0 off .. 1 full). */
  setGroup(group: LightGroup, k: number) {
    this.uniforms.uGroup.value[GROUPS.indexOf(group)] = k;
  }

  /** Switch single lamps on or off (guidance, stop bars). Call `commit` after a batch. */
  set(i: number, on: boolean) {
    this.on.array[i] = on ? 1 : 0;
  }

  commit() {
    this.on.needsUpdate = true;
  }

  /** Per frame: the clock, the camera's projection scale, the fog and how much glow the night gives. */
  update(t: number, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, fog: THREE.Fog | THREE.FogExp2 | null, night: number) {
    const u = this.uniforms;
    u.uTime.value = t;
    const h = renderer.domElement.height;
    u.uViewport.value.set(renderer.domElement.width, h);
    u.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.zoom);
    u.uMinPx.value = Math.max(1.2, h / 520);
    u.uFog.value = fog && 'density' in fog ? fog.density : 0;
    u.uGlow.value = night;
  }
}
