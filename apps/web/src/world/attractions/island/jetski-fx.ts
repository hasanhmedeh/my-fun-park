// The water effects of the Jet-Ski Race, each one draw call however many skis there are: the
// wakes (a churned-up foam trail straight behind each ski and the two arms of its V spreading
// out to the sides, drawn from the same samples whose arms bump the other skis in jetski-race.ts,
// fading as they age), and the spray (the rooster tail thrown up behind the jet, the sheets off
// the bow in a carve, and the splash of a landing) as a pool of soft points.

import * as THREE from 'three';
import { canvasTex } from '../../textures';
import { WAKE_LIFE, WAKE_N, WAKE_SPREAD, type Wake } from './jetski-race';

/** The foam: soft streaks along the trail, brighter in the middle. */
function foamCanvas() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  // bubbles and streaks knocked out of it, so it reads as churned water rather than paint
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(0,0,0,${0.25 + Math.random() * 0.5})`;
    const x = Math.random() * 64;
    const y = Math.random() * 256;
    g.beginPath();
    g.ellipse(x, y, 1 + Math.random() * 3, 2 + Math.random() * 9, 0, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/** A round, soft dot for the spray. */
function dropCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/** Ribbons per wake: the trail and the two arms. */
const RIBBONS = 3;

/**
 * Every ski's wake in one mesh. Vertices are stored relative to `origin` (the lagoon, 41 km from
 * the world's origin: float32 positions there would only be good to a few millimetres).
 */
export class Wakes {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private uvs: Float32Array;
  private tex: THREE.Texture;

  constructor(
    private readonly count: number,
    private readonly origin: THREE.Vector3,
    renderer?: THREE.WebGLRenderer,
  ) {
    const verts = count * RIBBONS * WAKE_N * 2;
    this.pos = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 4);
    this.uvs = new Float32Array(verts * 2);
    const idx: number[] = [];
    for (let r = 0; r < count * RIBBONS; r++)
      for (let q = 0; q < WAKE_N - 1; q++) {
        const a = (r * WAKE_N + q) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    // the foam lies flat on the water: every normal straight up
    const nor = new Float32Array(verts * 3);
    for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    this.tex = canvasTex(foamCanvas(), renderer);
    this.tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshLambertMaterial({
      map: this.tex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.position.copy(origin);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Rebuilds the ribbons from each ski's wake samples (newest first), on the water at `water`. */
  update(wakes: readonly Wake[], t: number, water: (x: number, z: number) => number) {
    const o = this.origin;
    const P = this.pos;
    const Cc = this.col;
    const U = this.uvs;
    for (let w = 0; w < this.count; w++) {
      const wk = wakes[w];
      for (let rib = 0; rib < RIBBONS; rib++) {
        const base = (w * RIBBONS + rib) * WAKE_N * 2;
        let along = 0;
        let px = 0;
        let pz = 0;
        for (let q = 0; q < WAKE_N; q++) {
          // newest sample first
          const h = (wk.head - q + WAKE_N) % WAKE_N;
          const age = t - wk.t[h];
          const v = wk.v[h];
          const life = Math.max(0, 1 - age / WAKE_LIFE);
          let cx = wk.x[h];
          let cz = wk.z[h];
          const lx = wk.lx[h];
          const lz = wk.lz[h];
          let half: number;
          let alpha: number;
          if (rib === 0) {
            // the churned trail: wide as the hull, spreading and fading fast
            half = 0.55 + age * 0.9;
            alpha = Math.min(1, v / 10) * life * life * 0.85;
          } else {
            const side = rib === 1 ? 1 : -1;
            const spread = WAKE_SPREAD * v * age;
            cx += lx * spread * side;
            cz += lz * spread * side;
            half = 0.3 + age * 0.35;
            alpha = Math.min(1, Math.max(0, (v - 5) / 9)) * life * 0.6 * Math.min(1, age * 3);
          }
          if (age < 0 || age > WAKE_LIFE) alpha = 0;
          if (q > 0) along += Math.hypot(cx - px, cz - pz);
          px = cx;
          pz = cz;
          const y = water(cx, cz) + 0.04 - o.y;
          for (let e = 0; e < 2; e++) {
            const s = e ? -1 : 1;
            const vi = base + q * 2 + e;
            P[vi * 3] = cx + lx * half * s - o.x;
            P[vi * 3 + 1] = y;
            P[vi * 3 + 2] = cz + lz * half * s - o.z;
            Cc[vi * 4] = Cc[vi * 4 + 1] = Cc[vi * 4 + 2] = 1;
            Cc[vi * 4 + 3] = alpha;
            U[vi * 2] = e;
            U[vi * 2 + 1] = along / 6;
          }
        }
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
  }

  /** The foam is lit like the water: dimmer at night. */
  setNight(k: number) {
    (this.mesh.material as THREE.MeshLambertMaterial).color.setScalar(1 - 0.35 * k);
  }
}

/**
 * Spray as a fixed pool of points: emitted with a position, a velocity and a life, falling under
 * gravity and fading. The pool wraps round, so a burst of splashes recycles the oldest drops.
 */
export class Spray {
  readonly points: THREE.Points;
  private n: number;
  private next = 0;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private pos: Float32Array;
  private col: Float32Array;
  private level = 1;

  constructor(
    n: number,
    private readonly origin: THREE.Vector3,
    renderer?: THREE.WebGLRenderer,
  ) {
    this.n = n;
    const f = () => new Float32Array(n);
    this.x = f();
    this.y = f();
    this.z = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f().fill(1);
    this.life = f().fill(1);
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      map: canvasTex(dropCanvas(), renderer),
      size: 0.42,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, mat);
    this.points.position.copy(origin);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /** One drop at (x, y, z) world, moving (vx, vy, vz), living `life` seconds. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
  }

  /** A ring of drops thrown up and out from (x, z): a landing, a big bounce, a crash. */
  splash(x: number, y: number, z: number, vx: number, vz: number, size: number) {
    const n = Math.round(14 + size * 30);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const out = (1.5 + Math.random() * 3) * size;
      this.emit(x + Math.cos(a) * 0.6, y, z + Math.sin(a) * 0.6, vx * 0.4 + Math.cos(a) * out, (2 + Math.random() * 4) * size, vz * 0.4 + Math.sin(a) * out, 0.6 + Math.random() * 0.6);
    }
  }

  /** Spray is white water lit by the sky: grey-blue at night. */
  setNight(k: number) {
    this.level = 1 - 0.7 * k;
  }

  update(dt: number) {
    const o = this.origin;
    for (let i = 0; i < this.n; i++) {
      const a = this.age[i];
      if (a >= this.life[i]) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.age[i] = a + dt;
      this.vy[i] -= 9.8 * dt;
      // the air slows the spray (fine drops most)
      const drag = Math.exp(-dt * 1.4);
      this.vx[i] *= drag;
      this.vz[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.pos[i * 3] = this.x[i] - o.x;
      this.pos[i * 3 + 1] = this.y[i] - o.y;
      this.pos[i * 3 + 2] = this.z[i] - o.z;
      const k = a / this.life[i];
      const l = this.level * (0.85 + 0.15 * (1 - k));
      this.col[i * 4] = l;
      this.col[i * 4 + 1] = l;
      this.col[i * 4 + 2] = l;
      this.col[i * 4 + 3] = (1 - k) * (1 - k) * 0.75;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}
