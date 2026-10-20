// Pirate Cannons: smoke, fire, spray, foam and flying timber. Everything is pooled and drawn as a
// handful of instanced meshes whatever is going on: soft puffs (powder smoke, spray, mist) that
// face the camera, additive flames and flashes, foam rings lying on the water, and splinters and
// planks that fly, fall, float a while and sink. One point light (on the tiers that have extra
// lights) flashes with each shot and explosion.

import * as THREE from 'three';
import type { Ctx } from '../../context';
import { withFogSun } from '../../fog';
import { waveY } from '../../sea';
import { canvasTex, hdr } from '../../textures';
import { mulberry } from '../../random';

const rnd = mulberry(4242);
const r = (a: number, b: number) => a + rnd() * (b - a);

/** A soft, cloudy puff (white; tinted per particle). */
function puffTexture(ring = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  if (ring) {
    // a ring of churned foam, broken up
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = 38 + (rnd() - 0.5) * 22;
      const x = 64 + Math.cos(a) * rr;
      const y = 64 + Math.sin(a) * rr;
      const s = 3 + rnd() * 7;
      const gr = g.createRadialGradient(x, y, 0, x, y, s);
      gr.addColorStop(0, 'rgba(255,255,255,0.5)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(x - s, y - s, s * 2, s * 2);
    }
  } else {
    for (let i = 0; i < 14; i++) {
      const x = 64 + (rnd() - 0.5) * 46;
      const y = 64 + (rnd() - 0.5) * 46;
      const s = 22 + rnd() * 20;
      const gr = g.createRadialGradient(x, y, 0, x, y, s);
      gr.addColorStop(0, 'rgba(255,255,255,0.42)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.16)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    }
    // fade the square's edges out completely
    g.globalCompositeOperation = 'destination-in';
    const m = g.createRadialGradient(64, 64, 20, 64, 64, 63);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m;
    g.fillRect(0, 0, 128, 128);
  }
  return canvasTex(c);
}

/** Per-particle behaviour: how it moves, grows and fades. */
interface PuffOptions {
  size: [number, number];
  life: number;
  alpha?: number;
  color?: THREE.Color;
  /** Gravity's share (spray falls: 1; smoke: 0). */
  gravity?: number;
  /** How fast it slows to the air's own motion (1/s). */
  drag?: number;
  /** Lift as it drifts (m/s, smoke rises). */
  rise?: number;
  /** Lies flat on the water, riding the swell (foam). */
  flat?: boolean;
}

/**
 * A pool of camera-facing (or flat) quads in one instanced mesh, with a per-instance alpha. New
 * particles overwrite the oldest when the pool is full.
 */
class Puffs {
  readonly mesh: THREE.InstancedMesh;
  private readonly n: number;
  private next = 0;
  private live = 0;
  private p: Float32Array;
  private v: Float32Array;
  /** age, life, size0, size1, alpha, gravity, drag, rise, flat, spin, rot */
  private q: Float32Array;
  private alpha: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly spinQ = new THREE.Quaternion();
  private readonly flatQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private static readonly Z = new THREE.Vector3(0, 0, 1);
  private static readonly Y = new THREE.Vector3(0, 1, 0);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(n: number, map: THREE.Texture, additive: boolean) {
    this.n = n;
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.q = new Float32Array(n * 11);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: '#ffffff',
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    mat.onBeforeCompile = (shader) => {
      withFogSun(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vAlpha;');
    };
    mat.customProgramCacheKey = () => `cannons-puff-${additive ? 'add' : 'mix'}`;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    for (let i = 0; i < n; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, new THREE.Color('#ffffff'));
    }
    this.mesh.renderOrder = additive ? 5 : 4;
  }

  get material() {
    return this.mesh.material as THREE.MeshBasicMaterial;
  }

  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, o: PuffOptions) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.p.set([x, y, z], i * 3);
    this.v.set([vx, vy, vz], i * 3);
    this.q.set([0, o.life, o.size[0], o.size[1], o.alpha ?? 1, o.gravity ?? 0, o.drag ?? 0, o.rise ?? 0, o.flat ? 1 : 0, r(-0.6, 0.6), r(0, Math.PI * 2)], i * 11);
    this.mesh.setColorAt(i, o.color ?? WHITE);
    this.mesh.instanceColor!.needsUpdate = true;
    this.live = this.n;
  }

  update(dt: number, t: number, camera: THREE.Camera, wx: number, wz: number) {
    if (!this.live) return;
    let any = 0;
    const p = this.p;
    const v = this.v;
    const q = this.q;
    for (let i = 0; i < this.n; i++) {
      const k = i * 11;
      const life = q[k + 1];
      if (life <= 0) continue;
      const age = (q[k] += dt);
      if (age >= life) {
        q[k + 1] = 0;
        this.mesh.setMatrixAt(i, this.zero);
        this.alpha.setX(i, 0);
        continue;
      }
      any++;
      const j = i * 3;
      const drag = q[k + 6];
      // drag towards the breeze (and the smoke's rise), gravity on spray
      if (drag > 0) {
        const e = Math.min(1, drag * dt);
        v[j] += (wx - v[j]) * e;
        v[j + 2] += (wz - v[j + 2]) * e;
        v[j + 1] += (q[k + 7] - v[j + 1]) * e;
      }
      v[j + 1] -= 9.81 * q[k + 5] * dt;
      p[j] += v[j] * dt;
      p[j + 1] += v[j + 1] * dt;
      p[j + 2] += v[j + 2] * dt;
      const flat = q[k + 8] > 0;
      if (flat) p[j + 1] = waveY(p[j], p[j + 2], t) + 0.06;
      const f = age / life;
      const size = q[k + 2] + (q[k + 3] - q[k + 2]) * (1 - (1 - f) * (1 - f));
      const a = q[k + 4] * Math.min(1, age / (life * 0.06 + 0.02)) * (1 - THREE.MathUtils.smoothstep(f, 0.3, 1));
      q[k + 10] += q[k + 9] * dt;
      if (flat) this.quat.copy(this.flatQ).premultiply(this.spinQ.setFromAxisAngle(Puffs.Y, q[k + 10]));
      else this.quat.copy(camera.quaternion).multiply(this.spinQ.setFromAxisAngle(Puffs.Z, q[k + 10]));
      this.m.compose(this.pos.set(p[j], p[j + 1], p[j + 2]), this.quat, this.scl.set(size, size, size));
      this.mesh.setMatrixAt(i, this.m);
      this.alpha.setX(i, a);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    if (!any) this.live = 0;
  }
}

const WHITE = new THREE.Color('#ffffff');

/** Splinters and planks: tumbling boxes that fall, float on the swell for a while and sink. */
class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly n = 120;
  private next = 0;
  private live = 0;
  private items: { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; axis: THREE.Vector3; spin: number; size: THREE.Vector3; age: number; life: number; floating: boolean }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly dq = new THREE.Quaternion();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly s = new THREE.Vector3();

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    for (let i = 0; i < this.n; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, WHITE);
      this.items.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), axis: new THREE.Vector3(1, 0, 0), spin: 0, size: new THREE.Vector3(), age: 0, life: 0, floating: false });
    }
  }

  add(p: THREE.Vector3, v: THREE.Vector3, len: number, color: THREE.ColorRepresentation) {
    const d = this.items[this.next];
    this.mesh.setColorAt(this.next, new THREE.Color(color).multiplyScalar(r(0.75, 1.1)));
    this.mesh.instanceColor!.needsUpdate = true;
    this.next = (this.next + 1) % this.n;
    d.p.copy(p);
    d.v.copy(v);
    d.q.setFromEuler(new THREE.Euler(r(0, 6), r(0, 6), r(0, 6)));
    d.axis.set(r(-1, 1), r(-1, 1), r(-1, 1)).normalize();
    d.spin = r(4, 14);
    d.size.set(len * r(0.12, 0.25), len * r(0.05, 0.1), len);
    d.age = 0;
    d.life = r(5, 9);
    d.floating = false;
    this.live = this.n;
  }

  update(dt: number, t: number) {
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < this.n; i++) {
      const d = this.items[i];
      if (d.life <= 0) continue;
      d.age += dt;
      if (d.age >= d.life) {
        d.life = 0;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      any++;
      const sea = waveY(d.p.x, d.p.z, t);
      if (!d.floating) {
        d.v.y -= 9.81 * dt;
        d.p.addScaledVector(d.v, dt);
        d.q.premultiply(this.dq.setFromAxisAngle(d.axis, d.spin * dt));
        if (d.p.y < sea && d.v.y < 0) {
          d.floating = true;
          d.v.multiplyScalar(0.15).setY(0);
        }
      } else {
        // bobbing on the swell, drifting to a stop, and finally going under
        d.v.multiplyScalar(Math.exp(-dt * 0.8));
        d.p.addScaledVector(d.v, dt);
        const sinkAt = d.life - 1.5;
        d.p.y = sea - 0.02 - (d.age > sinkAt ? (d.age - sinkAt) * 0.4 : 0);
        d.q.slerp(this.dq.setFromEuler(new THREE.Euler(0, d.spin, 0)), Math.min(1, dt * 2));
      }
      this.mesh.setMatrixAt(i, this.m.compose(d.p, d.q, this.s.copy(d.size)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!any) this.live = 0;
  }
}

const SMOKE_DAY = new THREE.Color('#e9e4dc');
const SMOKE_NIGHT = new THREE.Color('#5d6270');

/**
 * The effects of the battle. Call the event methods (muzzle, splash, hit, explosion, …) when things
 * happen and `update` once a frame; `shake` is how hard the ground is shaking at the fort (for the
 * camera), and decays by itself.
 */
export class Fx {
  readonly group = new THREE.Group();
  private soft: Puffs;
  private fire: Puffs;
  private foam: Puffs;
  private debris = new Debris();
  private light: THREE.PointLight | null = null;
  private lightK = 0;
  private night = 0;
  shake = 0;
  private wind = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly tmp = new THREE.Vector3();

  constructor(ctx: Ctx) {
    const soft = puffTexture();
    const heavy = ctx.quality.tier === 'low' || ctx.quality.tier === 'lowest';
    this.soft = new Puffs(heavy ? 260 : 420, soft, false);
    this.fire = new Puffs(heavy ? 90 : 140, soft, true);
    this.foam = new Puffs(48, puffTexture(true), false);
    this.group.add(this.soft.mesh, this.fire.mesh, this.foam.mesh, this.debris.mesh);
    if (ctx.quality.extraLights) {
      // added once and kept (intensity 0 when dark), so no shader ever recompiles for it
      this.light = new THREE.PointLight('#ffb060', 0, 160, 1.6);
      this.group.add(this.light);
    }
  }

  /** The breeze (m/s, the way it blows): smoke drifts with it. */
  setWind(x: number, z: number) {
    this.wind.set(x, 0, z);
  }

  setNight(k: number) {
    this.night = k;
  }

  private smokeColor(shade = 1) {
    return this.c.copy(SMOKE_DAY).lerp(SMOKE_NIGHT, this.night).multiplyScalar(shade).clone();
  }

  private flashAt(p: THREE.Vector3, k: number) {
    if (!this.light) return;
    this.light.position.copy(p);
    this.lightK = Math.max(this.lightK, k);
  }

  /** A gun fires: the flash out of the muzzle, a bank of powder smoke rolling out, the ground shakes. */
  muzzle(p: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 5; i++) {
      const d = r(0.2, 2.4);
      this.fire.add(p.x + dir.x * d, p.y + dir.y * d, p.z + dir.z * d, dir.x * 8, dir.y * 8, dir.z * 8, { size: [r(0.9, 1.6), r(1.8, 3.2)], life: r(0.1, 0.2), color: hdr(i % 2 ? '#ffd27a' : '#ff8a2a', 3.4) });
    }
    // a smaller, shorter-lived cloud than a real gun's, so the gunner can see where the ball lands
    for (let i = 0; i < 9; i++) {
      const sp = r(3, 18);
      this.soft.add(
        p.x + dir.x * r(0.5, 2),
        p.y + dir.y * r(0.5, 2) + r(-0.2, 0.3),
        p.z + dir.z * r(0.5, 2),
        dir.x * sp + r(-1.2, 1.2),
        dir.y * sp + r(0, 1.2),
        dir.z * sp + r(-1.2, 1.2),
        { size: [r(1, 1.8), r(4, 7)], life: r(1.8, 3.2), alpha: r(0.35, 0.55), color: this.smokeColor(r(0.92, 1.04)), drag: 1.3, rise: r(0.4, 0.9) },
      );
    }
    this.flashAt(p, 1);
    this.shake = Math.min(1.5, this.shake + 0.55);
  }

  /** A puff of the ball's smoke trail. */
  trail(p: THREE.Vector3) {
    this.soft.add(p.x, p.y, p.z, 0, 0, 0, { size: [0.5, 1.8], life: 0.9, alpha: 0.32, color: this.smokeColor(0.95), drag: 2, rise: 0.3 });
  }

  /** Something hits the water: a column of spray, mist and a foam ring (`k` 1 for a ball, more for bigger things). */
  splash(p: THREE.Vector3, k = 1) {
    const n = Math.round(10 + 6 * k);
    const spray = this.c.set('#f4fbff').clone();
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const out = r(0.5, 2.6) * Math.sqrt(k);
      const up = r(6, 14) * Math.sqrt(k);
      this.soft.add(p.x + Math.cos(a) * 0.4, p.y + 0.2, p.z + Math.sin(a) * 0.4, Math.cos(a) * out, up, Math.sin(a) * out, {
        size: [r(0.8, 1.4) * k, r(2.4, 4.2) * k],
        life: r(1.1, 1.8) * Math.sqrt(k),
        alpha: r(0.6, 0.9),
        color: spray,
        gravity: 1,
        drag: 0.4,
      });
    }
    for (let i = 0; i < 3; i++) this.soft.add(p.x + r(-1, 1), p.y + 1, p.z + r(-1, 1), r(-1, 1), r(0.5, 1.5), r(-1, 1), { size: [2 * k, 7 * k], life: r(1.8, 2.6), alpha: 0.35, color: spray, drag: 1, rise: 0.3 });
    this.foam.add(p.x, p.y, p.z, 0, 0, 0, { size: [2 * k, 10 * k], life: 2.6, alpha: 0.85, flat: true });
    this.foam.add(p.x, p.y, p.z, 0, 0, 0, { size: [1 * k, 5 * k], life: 3.4, alpha: 0.6, flat: true });
  }

  /** A ball strikes timber: splinters, a burst of flame and dark smoke. */
  hit(p: THREE.Vector3, dir: THREE.Vector3, wood: THREE.ColorRepresentation) {
    for (let i = 0; i < 10; i++) {
      this.tmp.set(dir.x * r(2, 7) + r(-4, 4), r(3, 9), dir.z * r(2, 7) + r(-4, 4));
      this.debris.add(p, this.tmp, r(0.4, 1.3), wood);
    }
    for (let i = 0; i < 4; i++) this.fire.add(p.x + r(-0.5, 0.5), p.y + r(0, 0.8), p.z + r(-0.5, 0.5), r(-1, 1), r(1, 3), r(-1, 1), { size: [r(1, 1.8), r(2.5, 4)], life: r(0.18, 0.35), color: hdr('#ffae4a', 3) });
    for (let i = 0; i < 6; i++) this.soft.add(p.x, p.y + 0.5, p.z, r(-2, 2), r(1, 4), r(-2, 2), { size: [r(1.5, 2.5), r(5, 8)], life: r(2.5, 4), alpha: 0.7, color: this.smokeColor(0.45), drag: 1, rise: 1.6 });
  }

  /** The powder kegs go up: a fireball, a tower of spray and smoke, a shock ring and a shower of timber. */
  explosion(p: THREE.Vector3) {
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const out = r(2, 12);
      this.fire.add(p.x, p.y + r(0, 3), p.z, Math.cos(a) * out, r(3, 16), Math.sin(a) * out, {
        size: [r(3, 6), r(9, 16)],
        life: r(0.5, 1.3),
        color: hdr(i % 3 ? '#ff9a32' : '#ffe08a', 3.6),
        drag: 1.8,
        rise: 3,
      });
    }
    for (let i = 0; i < 24; i++) {
      const a = rnd() * Math.PI * 2;
      this.soft.add(p.x + Math.cos(a) * 2, p.y + r(1, 6), p.z + Math.sin(a) * 2, Math.cos(a) * r(1, 5), r(4, 13), Math.sin(a) * r(1, 5), {
        size: [r(4, 7), r(14, 24)],
        life: r(5, 8),
        alpha: 0.8,
        color: this.smokeColor(r(0.32, 0.5)),
        drag: 0.6,
        rise: 2.2,
      });
    }
    this.splash(p, 3.2);
    this.foam.add(p.x, p.y, p.z, 0, 0, 0, { size: [6, 70], life: 1.8, alpha: 0.9, flat: true });
    for (let i = 0; i < 44; i++) {
      const a = rnd() * Math.PI * 2;
      const out = r(4, 18);
      this.tmp.set(Math.cos(a) * out, r(8, 26), Math.sin(a) * out);
      this.debris.add(this.tmp.clone().multiplyScalar(0.05).add(p).setY(p.y + 2), this.tmp, r(0.6, 2.4), i % 4 ? '#6b4a2c' : '#7a3a20');
    }
    this.flashAt(p.clone().setY(p.y + 6), 4);
  }

  /** One breath of smoke (and a lick of flame) from a burning hole. */
  wound(p: THREE.Vector3, fire: boolean) {
    this.soft.add(p.x + r(-0.3, 0.3), p.y, p.z + r(-0.3, 0.3), 0, r(1.5, 3), 0, { size: [r(1, 1.8), r(4.5, 7)], life: r(3, 4.5), alpha: 0.62, color: this.smokeColor(r(0.38, 0.55)), drag: 0.7, rise: r(1.8, 2.8) });
    if (fire) this.fire.add(p.x + r(-0.4, 0.4), p.y + 0.2, p.z + r(-0.4, 0.4), 0, r(1, 2), 0, { size: [r(0.6, 1.1), r(1.2, 2)], life: r(0.3, 0.5), color: hdr('#ff8a2a', 2.6) });
  }

  /** The fizzing fuse on the powder-keg sloop: sparks. */
  spark(p: THREE.Vector3) {
    this.fire.add(p.x, p.y, p.z, r(-1.5, 1.5), r(1, 3), r(-1.5, 1.5), { size: [0.35, 0.1], life: r(0.15, 0.3), color: hdr('#ffd36a', 4), gravity: 0.6 });
  }

  /** A ship going down: air boiling up round it. */
  bubbles(p: THREE.Vector3, radius: number) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * radius;
    this.soft.add(p.x + Math.cos(a) * d, p.y, p.z + Math.sin(a) * d, 0, r(1, 3), 0, { size: [0.6, 2.2], life: 0.9, alpha: 0.7, color: WHITE, gravity: 0.5 });
    if (rnd() < 0.3) this.foam.add(p.x + Math.cos(a) * d, p.y, p.z + Math.sin(a) * d, 0, 0, 0, { size: [1, 5], life: 2, alpha: 0.6, flat: true });
  }

  update(dt: number, t: number, camera: THREE.Camera) {
    const wx = this.wind.x;
    const wz = this.wind.z;
    this.soft.update(dt, t, camera, wx, wz);
    this.fire.update(dt, t, camera, wx, wz);
    this.foam.update(dt, t, camera, 0, 0);
    this.debris.update(dt, t);
    if (this.light) {
      this.lightK = Math.max(0, this.lightK - dt * 9);
      this.light.intensity = this.lightK * this.lightK * 900;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }
}
