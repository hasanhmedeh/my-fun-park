// Palm Cay's night lights, built cheaply: strings of festoon bulbs on hanging wires, tiki-torch
// flames that flicker in the vertex shader, soft halos round the flames and lanterns (one points
// cloud), and warm pools of light on the ground (one instanced decal). No real lights: the bloom
// pass makes the glow, and everything is one draw call per kind however many there are.

import * as THREE from 'three';
import { withFogSun } from '../fog';
import { canvasTex, glowTexture, hdr } from '../textures';
import { catenary } from './kit';

export interface StringOptions {
  sag?: number;
  /** Metres between bulbs. */
  spacing?: number;
  colors?: string[];
}

const WARM = ['#ffd9a0', '#ffe8c2', '#ffcf8a'];

/**
 * A white radial falloff for the ground pools. The park's own pool texture is already orange, and
 * multiplied by each pool's warm colour it turned the pools a muddy red; here the hue comes from
 * the pool's colour alone (the fountain's are cyan, the torches' amber).
 */
function falloff() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  r.addColorStop(0.65, 'rgba(255,255,255,0.18)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return canvasTex(c);
}

/**
 * One set of night lights (the park has one, the terminal another). Add in world metres, then
 * `build()` once; everything is stored relative to `origin` (see Batch) and the group stands there.
 */
export class NightLights {
  readonly group = new THREE.Group();
  private bulbs: { p: THREE.Vector3; c: THREE.Color }[] = [];
  private wire: number[] = [];
  private flames: THREE.Vector3[] = [];
  private halos: { p: THREE.Vector3; c: THREE.Color; size: number }[] = [];
  private pools: { x: number; y: number; z: number; r: number; c: THREE.Color }[] = [];
  private bulbMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  private wireMat = new THREE.LineBasicMaterial({ color: '#2a2018' });
  private flameMat = new THREE.MeshBasicMaterial({ color: hdr('#ff9a3c', 5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private haloMat = new THREE.PointsMaterial({ map: glowTexture('#ffb070'), size: 2.2, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true });
  private poolMat = new THREE.MeshBasicMaterial({
    map: falloff(),
    color: hdr('#ffffff', 0.4),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });
  private uTime = { value: 0 };
  private flameMesh: THREE.Object3D | null = null;
  private haloMesh: THREE.Object3D | null = null;
  private poolMesh: THREE.Object3D | null = null;

  private readonly origin: THREE.Vector3;

  /**
   * `lean` (the low tiers) keeps only the bulbs and the halos: two draw calls. The wires, the
   * flame meshes and the ground pools are the finishing touches that cost the other three.
   */
  constructor(
    origin: THREE.Vector3Like = { x: 0, y: 0, z: 0 },
    private readonly lean = false,
  ) {
    this.origin = new THREE.Vector3().copy(origin);
    this.group.position.copy(origin);
    const uTime = this.uTime;
    // flames flicker and lick sideways, each with its own phase (from where it stands)
    this.flameMat.onBeforeCompile = (shader) => {
      withFogSun(shader);
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          vec2 seed = instanceMatrix[3].xz;
          float ph = dot(seed, vec2(0.71, 1.37));
          float f = 1.0 + 0.22 * sin(uTime * 11.0 + ph) + 0.14 * sin(uTime * 23.0 + ph * 1.7) + 0.08 * sin(uTime * 37.0 + ph * 0.3);
          transformed.y *= f;
          transformed.x += position.y * position.y * 0.6 * sin(uTime * 7.0 + ph * 2.1);
          transformed.z += position.y * position.y * 0.4 * cos(uTime * 6.0 + ph);`,
        );
    };
    this.flameMat.customProgramCacheKey = () => 'island-flame';
  }

  addBulb(p: THREE.Vector3, color: THREE.ColorRepresentation, k = 5) {
    this.bulbs.push({ p: p.clone().sub(this.origin), c: hdr(color, k) });
  }

  /** A festoon string from a to b: a sagging wire with bulbs along it. */
  addString(a: THREE.Vector3, b: THREE.Vector3, o: StringOptions = {}) {
    const len = a.distanceTo(b);
    const n = Math.max(2, Math.round(len / (o.spacing ?? 0.9)));
    const pts = catenary(a, b, o.sag ?? len * 0.06, n);
    const colors = o.colors ?? WARM;
    for (let i = 0; i < pts.length; i++) {
      const o = this.origin;
      if (i > 0) this.wire.push(pts[i - 1].x - o.x, pts[i - 1].y - o.y, pts[i - 1].z - o.z, pts[i].x - o.x, pts[i].y - o.y, pts[i].z - o.z);
      if (i > 0 && i < pts.length - 1) this.addBulb(pts[i].clone().setY(pts[i].y - 0.1), colors[i % colors.length]);
    }
  }

  /** A torch flame whose base is at p, with its halo and a pool of light on the ground below. */
  addFlame(p: THREE.Vector3, ground = 0) {
    this.flames.push(p.clone().sub(this.origin));
    this.halos.push({ p: p.clone().sub(this.origin).setY(p.y + 0.25), c: new THREE.Color('#ffb070'), size: 1 });
    this.addPool(p.x, ground, p.z, 4.5, '#ffaa5c');
  }

  /** A glowing halo (lanterns, lamp globes). */
  addHalo(p: THREE.Vector3, color: THREE.ColorRepresentation, size = 1) {
    this.halos.push({ p: p.clone().sub(this.origin), c: new THREE.Color(color), size });
  }

  addPool(x: number, y: number, z: number, r: number, color: THREE.ColorRepresentation) {
    this.pools.push({ x: x - this.origin.x, y: y - this.origin.y, z: z - this.origin.z, r, c: new THREE.Color(color) });
  }

  build() {
    const m = new THREE.Matrix4();
    if (this.bulbs.length) {
      const im = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.075, 0), this.bulbMat, this.bulbs.length);
      this.bulbs.forEach((b, i) => {
        im.setMatrixAt(i, m.makeTranslation(b.p.x, b.p.y, b.p.z));
        im.setColorAt(i, b.c);
      });
      im.computeBoundingSphere();
      this.group.add(im);
    }
    if (this.wire.length && !this.lean) {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(this.wire, 3));
      this.group.add(new THREE.LineSegments(g, this.wireMat));
    }
    if (this.flames.length && !this.lean) {
      // a teardrop flame, 0.5 m tall, its base at the origin
      const prof: THREE.Vector2[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        prof.push(new THREE.Vector2(0.11 * Math.sin(Math.PI * Math.pow(t, 0.7)) * (1 - t * 0.35), t * 0.52));
      }
      const im = new THREE.InstancedMesh(new THREE.LatheGeometry(prof, 7), this.flameMat, this.flames.length);
      this.flames.forEach((p, i) => im.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
      im.computeBoundingSphere();
      this.flameMesh = im;
      this.group.add(im);
    }
    if (this.halos.length) {
      const pos: number[] = [];
      const col: number[] = [];
      for (const h of this.halos) {
        pos.push(h.p.x, h.p.y, h.p.z);
        col.push(h.c.r * h.size, h.c.g * h.size, h.c.b * h.size);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const pts = new THREE.Points(g, this.haloMat);
      pts.renderOrder = 2;
      this.haloMesh = pts;
      this.group.add(pts);
    }
    if (this.pools.length && !this.lean) {
      const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, this.pools.length);
      const s = new THREE.Vector3();
      const q = new THREE.Quaternion();
      this.pools.forEach((p, i) => {
        im.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, p.y + 0.06, p.z), q, s.set(p.r * 2, 1, p.r * 2)));
        im.setColorAt(i, p.c);
      });
      im.computeBoundingSphere();
      im.renderOrder = 1;
      this.poolMesh = im;
      this.group.add(im);
    }
    for (const o of this.group.children) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
    this.setNight(0);
  }

  /** 0 by day (bulbs unlit, torches out) .. 1 at night. */
  setNight(k: number) {
    this.bulbMat.color.setScalar(0.16 + 0.84 * k);
    this.wireMat.color.setScalar(0.16 * (1 - k * 0.6));
    const on = k > 0.03;
    for (const o of [this.flameMesh, this.haloMesh, this.poolMesh]) if (o) o.visible = on;
    this.flameMat.opacity = Math.min(1, k * 1.5);
    this.haloMat.opacity = k * 0.9;
    this.poolMat.opacity = k;
  }

  update(t: number) {
    this.uTime.value = t;
  }
}
