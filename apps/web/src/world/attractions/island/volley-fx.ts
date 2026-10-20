// Beach Volley's moving visuals, all in the court's frame (see volley-ball.ts): the ball (panelled
// yellow, blue and white, spinning the way it was struck) and its shadow on the sand, the scoring
// rings on the far court, the aim reticle with its arrow and a dotted preview of the start of the
// flight, and the puffs of sand where the ball lands and players dive.

import * as THREE from 'three';
import { canvasTex } from '../../textures';
import { BALL_R, SAND_Y, stepBall, type Ball } from './volley-ball';
import type { Ring } from './volley-rules';

const RING_COLOURS: Record<1 | 2 | 3, string> = { 1: '#2ec4b6', 2: '#ffc23d', 3: '#ff4d6d' };
const DOTS = 18;
const CHEVRONS = 5;
const PUFFS = 48;

/** A beach ball's panels: three groups of curved stripes in yellow, blue and white. */
function ballCanvas() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const cols = ['#ffd23d', '#2257c9', '#f7f7f2'];
  for (let i = 0; i < 9; i++) {
    g.fillStyle = cols[i % 3];
    g.beginPath();
    for (let y = 0; y <= 256; y += 8) {
      const x = (i * 512) / 9 + Math.sin((y / 256) * Math.PI * 2) * 22;
      if (y === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let y = 256; y >= 0; y -= 8) g.lineTo(((i + 1) * 512) / 9 + Math.sin((y / 256) * Math.PI * 2) * 22, y);
    g.closePath();
    g.fill();
  }
  // the seams
  g.strokeStyle = 'rgba(40,40,60,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i <= 9; i++) {
    g.beginPath();
    for (let y = 0; y <= 256; y += 8) {
      const x = (i * 512) / 9 + Math.sin((y / 256) * Math.PI * 2) * 22;
      if (y === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
}

/** The rings' painted insides: a tinted disc with its value, three cells side by side. */
function ringCanvas() {
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = 256;
  const g = c.getContext('2d')!;
  ([1, 2, 3] as const).forEach((v, i) => {
    const x = i * 256 + 128;
    const grad = g.createRadialGradient(x, 128, 20, x, 128, 124);
    grad.addColorStop(0, `${RING_COLOURS[v]}55`);
    grad.addColorStop(0.8, `${RING_COLOURS[v]}38`);
    grad.addColorStop(1, `${RING_COLOURS[v]}00`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, 128, 124, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.88)';
    g.font = `120px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(v), x, 136);
  });
  return c;
}

export class CourtFx {
  readonly ball: THREE.Mesh;
  private shadow: THREE.Mesh;
  private rings: THREE.InstancedMesh;
  private ringDecal: THREE.Mesh;
  private ringTex: THREE.CanvasTexture;
  readonly reticle = new THREE.Group();
  private reticleMat: THREE.MeshBasicMaterial;
  private chevrons: THREE.InstancedMesh;
  private dots: THREE.InstancedMesh;
  private puffs: THREE.InstancedMesh;
  private puff: { p: THREE.Vector3; v: THREE.Vector3; life: number; s: number }[] = [];
  private spinAxis = new THREE.Vector3(1, 0, 0);
  private spinRate = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private probe: Ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 'soft', t: 0, phase: 0 };
  private flow = 0;
  private aimFrom = new THREE.Vector3();
  private aimTo = new THREE.Vector3();
  private aimOn = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    parent: THREE.Object3D,
    shadows: boolean,
  ) {
    const tex = canvasTex(ballCanvas(), renderer);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
    this.ball.castShadow = shadows;
    this.ball.visible = false;
    const shadowTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, 'rgba(40,28,10,0.55)');
      r.addColorStop(1, 'rgba(40,28,10,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
      return canvasTex(c);
    })();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.shadow.visible = false;
    this.shadow.renderOrder = 2;

    // the rings: hoops lying on the sand (one instanced torus) over their painted insides (one quad each, merged)
    this.rings = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.035, 8, 48).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 0.15 }), 3);
    this.rings.castShadow = shadows;
    this.rings.visible = false;
    this.ringTex = canvasTex(ringCanvas(), renderer);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 4 * 3), 3));
    dg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(3 * 4 * 2), 2));
    dg.setIndex([0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7, 8, 10, 9, 9, 10, 11]);
    this.ringDecal = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ map: this.ringTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.ringDecal.visible = false;
    this.ringDecal.renderOrder = 1;
    void document.fonts?.ready.then(() => {
      const c = this.ringTex.image as HTMLCanvasElement;
      c.getContext('2d')!.drawImage(ringCanvas(), 0, 0);
      this.ringTex.needsUpdate = true;
    });

    // the reticle: a ring and a dot, flat on the sand (or upright, round a coconut)
    this.reticleMat = new THREE.MeshBasicMaterial({ color: '#fff5e3', transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 40), this.reticleMat);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), this.reticleMat);
    const ticks = new THREE.Mesh(
      (() => {
        const geos = [0, 1, 2, 3].map((i) => new THREE.PlaneGeometry(0.035, 0.16).translate(0, 0.5, 0).rotateZ((i * Math.PI) / 2));
        const pos: number[] = [];
        for (const g of geos) {
          const ng = g.toNonIndexed();
          pos.push(...(ng.attributes.position.array as Float32Array));
        }
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        return out;
      })(),
      this.reticleMat,
    );
    this.reticle.add(ring, dot, ticks);
    this.reticle.renderOrder = 4;
    for (const c of this.reticle.children) c.renderOrder = 4;
    this.reticle.visible = false;

    // the aim arrow: chevrons flowing along the sand towards the target
    const chev = new THREE.Shape();
    chev.moveTo(-0.32, -0.12);
    chev.lineTo(0, 0.16);
    chev.lineTo(0.32, -0.12);
    chev.lineTo(0.32, -0.26);
    chev.lineTo(0, 0.02);
    chev.lineTo(-0.32, -0.26);
    chev.closePath();
    this.chevrons = new THREE.InstancedMesh(
      new THREE.ShapeGeometry(chev).rotateX(-Math.PI / 2).rotateY(Math.PI),
      new THREE.MeshBasicMaterial({ color: '#fff5e3', transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }),
      CHEVRONS,
    );
    this.chevrons.visible = false;
    this.chevrons.renderOrder = 3;
    this.chevrons.frustumCulled = false;
    // the dotted start of the flight
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false }), DOTS);
    this.dots.visible = false;
    this.dots.frustumCulled = false;

    this.puffs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.06, 0), new THREE.MeshStandardMaterial({ color: '#e3cf9f', roughness: 1, transparent: true, opacity: 0.85, depthWrite: false }), PUFFS);
    this.puffs.count = 0;
    this.puffs.frustumCulled = false;
    for (let i = 0; i < PUFFS; i++) this.puff.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, s: 1 });

    parent.add(this.ball, this.shadow, this.rings, this.ringDecal, this.reticle, this.chevrons, this.dots, this.puffs);
  }

  /** Shows the ball where `b` is, spinning as it was struck, with its shadow beneath. */
  showBall(b: Ball | null, dt: number) {
    const on = !!b;
    this.ball.visible = on;
    this.shadow.visible = on;
    if (!b) return;
    this.ball.position.set(b.x, b.y, b.z);
    if (this.spinRate) this.ball.rotateOnWorldAxis(this.spinAxis, this.spinRate * dt);
    const h = Math.max(0, b.y - SAND_Y);
    const s = 0.34 + h * 0.06;
    this.shadow.position.set(b.x, SAND_Y + 0.012, b.z);
    this.shadow.scale.set(s, 1, s);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.15, 1 - h * 0.12);
  }

  /** Sets the ball spinning for a strike: topspin rolls forward over its top, a float barely turns, a pass drifts. */
  spinFor(b: Ball) {
    const h = Math.hypot(b.vx, b.vz) || 1;
    // (the parent's frame is the court's; the spin axis is world-space, so turn it there)
    this.spinAxis.set(b.vz / h, 0, -b.vx / h).applyQuaternion(this.ball.parent!.getWorldQuaternion(this.q)).normalize();
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    this.spinRate = b.spin === 'top' ? speed * 2.2 : b.spin === 'float' ? 0.6 : 2 + Math.random() * 3;
  }

  /** The rings for this serve (none: hidden). */
  setRings(rings: readonly Ring[]) {
    const on = rings.length > 0;
    this.rings.visible = on;
    this.ringDecal.visible = on;
    if (!on) return;
    const c = new THREE.Color();
    const pos = this.ringDecal.geometry.attributes.position as THREE.BufferAttribute;
    const uv = this.ringDecal.geometry.attributes.uv as THREE.BufferAttribute;
    rings.forEach((r, i) => {
      this.rings.setMatrixAt(i, this.m4.compose(this.v.set(r.x, SAND_Y + 0.03, r.z), this.q.identity(), this.s.set(r.r, 1, r.r)));
      this.rings.setColorAt(i, c.set(RING_COLOURS[r.value]));
      const y = SAND_Y + 0.02;
      // (the number reads the right way up from the server's end, at −z)
      pos.setXYZ(i * 4, r.x + r.r, y, r.z - r.r);
      pos.setXYZ(i * 4 + 1, r.x - r.r, y, r.z - r.r);
      pos.setXYZ(i * 4 + 2, r.x + r.r, y, r.z + r.r);
      pos.setXYZ(i * 4 + 3, r.x - r.r, y, r.z + r.r);
      const u0 = (r.value - 1) / 3;
      const u1 = r.value / 3;
      uv.setXY(i * 4, u0, 0);
      uv.setXY(i * 4 + 1, u1, 0);
      uv.setXY(i * 4 + 2, u0, 1);
      uv.setXY(i * 4 + 3, u1, 1);
    });
    this.rings.count = rings.length;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    this.ringDecal.geometry.computeBoundingSphere();
    this.rings.computeBoundingSphere();
  }

  /** A ring pulses when the ball lands in it. */
  flashRing(i: number) {
    this.flashI = i;
    this.flashT = 1;
  }
  private flashI = -1;
  private flashT = 0;

  /**
   * The reticle at the target (flat on the sand; `upright` round a coconut), the arrow from the
   * hitter, and the dotted first part of the flight `preview` would take (null: no dots).
   */
  aim(from: THREE.Vector3 | null, to: THREE.Vector3 | null, upright: boolean, preview: Ball | null) {
    this.aimOn = !!(from && to);
    this.reticle.visible = !!to;
    this.chevrons.visible = this.aimOn;
    this.dots.visible = !!preview;
    if (to) {
      this.reticle.position.copy(to);
      if (upright) this.reticle.rotation.set(0, 0, 0);
      else {
        this.reticle.rotation.set(-Math.PI / 2, 0, 0);
        this.reticle.position.y = SAND_Y + 0.03;
      }
    }
    if (from && to) {
      this.aimFrom.copy(from).setY(SAND_Y + 0.03);
      this.aimTo.copy(to).setY(SAND_Y + 0.03);
    }
    if (preview) {
      const p = this.probe;
      Object.assign(p, preview);
      p.t = 0;
      let n = 0;
      // the first 40% of the way, a dot every few hundredths of a second
      const total = Math.hypot(this.aimTo.x - p.x, this.aimTo.z - p.z) * 0.4;
      const x0 = p.x;
      const z0 = p.z;
      for (let i = 0; i < 2000 && n < DOTS; i++) {
        stepBall(p);
        if (i % 6 === 5) {
          if (Math.hypot(p.x - x0, p.z - z0) > total || p.y < SAND_Y) break;
          this.dots.setMatrixAt(n++, this.m4.makeTranslation(p.x, p.y, p.z));
        }
      }
      this.dots.count = n;
      this.dots.instanceMatrix.needsUpdate = true;
    }
  }

  /** A burst of sand at (x, z): `k` 0.3 (a soft landing) .. 1.5 (a spike, a dive). */
  sand(x: number, z: number, k: number, along?: { x: number; z: number }) {
    const n = Math.round(10 + k * 14);
    let made = 0;
    for (const p of this.puff) {
      if (p.life > 0) continue;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.6 + Math.random() * 1.6) * k;
      p.p.set(x + Math.cos(a) * 0.1, SAND_Y + 0.05, z + Math.sin(a) * 0.1);
      p.v.set(Math.cos(a) * sp + (along?.x ?? 0) * k * 1.5, (1.2 + Math.random() * 2.2) * Math.sqrt(k), Math.sin(a) * sp + (along?.z ?? 0) * k * 1.5);
      p.life = 0.5 + Math.random() * 0.5;
      p.s = 0.6 + Math.random() * 0.9;
      if (++made >= n) break;
    }
  }

  update(dt: number, t: number) {
    // chevrons flow from the hitter to the target
    if (this.aimOn) {
      this.flow = (this.flow + dt * 0.8) % 1;
      const dx = this.aimTo.x - this.aimFrom.x;
      const dz = this.aimTo.z - this.aimFrom.z;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      for (let i = 0; i < CHEVRONS; i++) {
        const u = Math.min(0.95, 0.06 + ((i + this.flow) / CHEVRONS) * 0.32);
        this.chevrons.setMatrixAt(i, this.m4.compose(this.v.set(this.aimFrom.x + dx * u, SAND_Y + 0.03, this.aimFrom.z + dz * u), this.q, this.s.setScalar(Math.min(1.2, 0.6 + len * 0.04))));
      }
      this.chevrons.instanceMatrix.needsUpdate = true;
      this.reticleMat.opacity = 0.75 + 0.2 * Math.sin(t * 8);
      const s = 1 + 0.08 * Math.sin(t * 8);
      this.reticle.scale.setScalar(s);
    }
    if (this.flashT > 0 && this.flashI >= 0) {
      this.flashT = Math.max(0, this.flashT - dt * 1.5);
      this.rings.getMatrixAt(this.flashI, this.m4);
      this.m4.decompose(this.v, this.q, this.s);
      this.v.y = SAND_Y + 0.03 + Math.sin(this.flashT * Math.PI * 4) * 0.08 * this.flashT;
      this.rings.setMatrixAt(this.flashI, this.m4.compose(this.v, this.q, this.s));
      this.rings.instanceMatrix.needsUpdate = true;
      (this.rings.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15 + this.flashT * 1.6;
    }
    let n = 0;
    for (const p of this.puff) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.v.y -= 9.81 * dt;
      p.v.multiplyScalar(1 - dt * 1.8);
      p.p.addScaledVector(p.v, dt);
      if (p.p.y < SAND_Y) {
        p.p.y = SAND_Y;
        p.v.set(0, 0, 0);
      }
      const k = Math.max(0, Math.min(1, p.life * 2)) * p.s;
      this.puffs.setMatrixAt(n++, this.m4.compose(p.p, this.q.identity(), this.s.setScalar(k)));
    }
    this.puffs.count = n;
    if (n) this.puffs.instanceMatrix.needsUpdate = true;
  }
}
