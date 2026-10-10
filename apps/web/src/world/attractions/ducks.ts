import * as THREE from 'three';
import { shadowed, staticBox, std, type Attraction, type Ctx } from '../context';
import type { Input } from '../input';
import { LAYOUT } from '../layout';
import { hdr, PALETTE, signMaterial, signTexture, stripeTexture } from '../textures';

/** A round (one ticket) lasts this long. */
export const DUCKS_ROUND = 30;
/** The cork gun reloads in this long. */
const RELOAD = 0.32;
/** How fast the keys or the joystick move the sight (screen heights a second). */
const AIM_SPEED = 0.9;
/** A duck that has just come round is golden this often (and worth GOLD points). */
const GOLD_CHANCE = 0.08;
const GOLD = 50;
/** How long the last shot's flight shows before the round wraps up on its own. */
const LAST_LOOK = 1.2;

// The stall, in metres from its anchor (x east, z south): the counter runs along its open north
// side, facing the Midway, and the ducks glide along three rails in front of the back wall.
const HALF_W = 6;
const COUNTER_Z = -3.2;
const BACK_Z = 3.4;
/** The rails, back row first: height, depth, speed (m/s, the sign is the direction), points. */
const ROWS = [
  { y: 3.55, z: 2.7, speed: 2.6, points: 30, count: 5, color: PALETTE.candy },
  { y: 2.65, z: 1.9, speed: -1.9, points: 20, count: 6, color: PALETTE.teal },
  { y: 1.75, z: 1.1, speed: 1.3, points: 10, count: 6, color: PALETTE.mustard },
];
/** Ducks run out of sight behind the side panels at ±SPAN and come round again on the other side. */
const SPAN = HALF_W - 0.55;

interface Duck {
  row: number;
  /** Position along its rail, −SPAN…SPAN. */
  x: number;
  pivot: THREE.Group;
  body: THREE.Mesh;
  gold: boolean;
  /** Knocked down (it stays down until it comes round again), and how far it has tipped back. */
  down: boolean;
  tip: number;
}

/** A flat tin duck facing +x, standing on y = 0, painted on both faces. */
function duckGeometry() {
  const s = new THREE.Shape();
  // the body: a fat teardrop with a tail flick, then the neck and a round head with a beak
  s.moveTo(-0.42, 0.02);
  s.bezierCurveTo(-0.5, 0.18, -0.52, 0.34, -0.36, 0.38);
  s.lineTo(-0.48, 0.5);
  s.bezierCurveTo(-0.3, 0.48, -0.12, 0.38, 0.04, 0.36);
  s.bezierCurveTo(0.08, 0.46, 0.06, 0.58, 0.14, 0.66);
  s.bezierCurveTo(0.24, 0.76, 0.4, 0.72, 0.42, 0.6);
  s.lineTo(0.56, 0.56);
  s.lineTo(0.42, 0.5);
  s.bezierCurveTo(0.36, 0.42, 0.28, 0.4, 0.3, 0.3);
  s.bezierCurveTo(0.42, 0.22, 0.4, 0.06, 0.26, 0.02);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, curveSegments: 10 });
  g.translate(0, 0, -0.025);
  return g;
}

/**
 * The Duck Shoot: a shooting gallery on the Midway. Tin ducks glide along three rails (the higher
 * the rail, the faster and the more it's worth, and now and then a golden one comes round); a round
 * is 30 seconds with a cork gun, aimed with the mouse (or the keys / joystick, or a tap), fired
 * with a click, E or Space. Ducks knocked down tip back and stay down until they come round again.
 */
export class Ducks implements Attraction {
  private ducks: Duck[] = [];
  private origin = new THREE.Vector3(LAYOUT.ducks.x, 0, LAYOUT.ducks.z);
  private mats: { tin: THREE.Material[]; gold: THREE.Material };
  private gun = new THREE.Group();
  private cork: THREE.Mesh;
  private corkFlight: { from: THREE.Vector3; to: THREE.Vector3; t: number; hit: Duck | null } | null = null;
  private sight: HTMLDivElement;
  private ray = new THREE.Raycaster();
  /** The sight, in normalised device coordinates. */
  private aim = new THREE.Vector2(0, 0.05);
  private reload = 0;
  private timeLeft = 0;
  private elapsed = 0;
  private overT = -1;
  private stats = { score: 0, shots: 0, hits: 0, streak: 0, bestStreak: 0, golden: 0 };
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  active = false;
  input: Input | null = null;
  onFinish: (() => void) | null = null;
  /** The clock ran out: the round is over. */
  onComplete: (() => void) | null = null;
  /** A duck went down (or a shot missed): its points, and the round's score so far. */
  onShot: ((points: number, score: number) => void) | null = null;

  constructor(private ctx: Ctx) {
    this.mats = {
      tin: ROWS.map((r) => std(r.color, { metalness: 0.55, roughness: 0.35 })),
      gold: std('#ffcf5a', { metalness: 1, roughness: 0.18, emissive: '#7a5200', emissiveIntensity: 0.6 }),
    };
    this.buildStall();
    this.buildDucks();
    this.gun = this.buildGun();
    this.gun.scale.setScalar(1.25);
    this.gun.visible = false;
    ctx.scene.add(this.gun);
    this.cork = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.07, 10).rotateX(Math.PI / 2), std('#c8945a', { roughness: 0.8 }));
    this.cork.visible = false;
    ctx.scene.add(this.cork);

    this.sight = document.createElement('div');
    this.sight.className = 'ducks-sight';
    this.sight.hidden = true;
    document.body.appendChild(this.sight);
    const canvas = ctx.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.active && this.pointAt(e));
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
      this.pointAt(e);
      this.shoot();
    });
  }

  private buildStall() {
    const g = new THREE.Group();
    const wood = std('#8a5a3a', { roughness: 0.8 });
    const ink = std(PALETTE.ink, { roughness: 0.6 });
    // the back wall: a starry night painted on, with a lit edge
    const backTex = this.backdropTexture();
    // (the painted face is the box's −z side, towards the counter)
    const back = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2, 4.6, 0.3), [ink, ink, ink, ink, ink, std('#ffffff', { map: backTex, roughness: 0.7 })]);
    back.position.set(0, 2.3, BACK_Z);
    // side panels hide the ducks coming round
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.9, 4.6, BACK_Z - COUNTER_Z + 0.4), std(PALETTE.candy, { roughness: 0.6 }));
      side.position.set(sx * (HALF_W - 0.45), 2.3, (BACK_Z + COUNTER_Z) / 2);
      g.add(side);
    }
    // a raised floor inside (the lawn's grass stays under it)
    const floor = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 - 1.8, 0.9, BACK_Z - COUNTER_Z - 0.6), std('#6b4a35', { roughness: 0.85 }));
    floor.position.set(0, 0.45, (BACK_Z + COUNTER_Z) / 2 + 0.2);
    g.add(floor);
    // the rails, a shelf under each
    ROWS.forEach((r) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 - 1.6, 0.12, 0.42), wood);
      rail.position.set(0, r.y - 0.06, r.z);
      g.add(rail);
    });
    // the counter, with a striped front
    const counter = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2, 0.16, 1.1), std(PALETTE.cream, { roughness: 0.6 }));
    counter.position.set(0, 1.12, COUNTER_Z);
    const front = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2, 1.05, 0.08), std('#ffffff', { map: stripeTexture(PALETTE.violet, PALETTE.cream, 16), roughness: 0.7 }));
    front.position.set(0, 0.52, COUNTER_Z - 0.5);
    // the roof, sloping down to the front, under a striped awning
    const roof = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 0.6, 0.18, BACK_Z - COUNTER_Z + 1.4), ink);
    roof.position.set(0, 4.75, (BACK_Z + COUNTER_Z) / 2);
    roof.rotation.x = -0.08;
    const awning = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 0.8, 0.06, 1.5), std('#ffffff', { map: stripeTexture(PALETTE.mustard, PALETTE.cream, 16) }));
    awning.position.set(0, 4.45, COUNTER_Z - 1.1);
    awning.rotation.x = 0.32;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.9), signMaterial(signTexture('DUCK SHOOT', { sub: 'Tin ducks · 30 seconds · golden duck 50 pts', border: PALETTE.mustard })));
    sign.position.set(0, 6, COUNTER_Z - 0.4);
    sign.rotation.y = Math.PI; // facing the Midway (north)
    // bulbs along the front of the roof
    const n = 24;
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }), n);
    for (let i = 0; i < n; i++) {
      bulbs.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-HALF_W + 0.25 + (i * (HALF_W * 2 - 0.5)) / (n - 1), 4.12, COUNTER_Z - 1.75));
      bulbs.setColorAt(i, hdr(i % 2 ? '#ffd23d' : '#ff5d7a', 5));
    }
    // a gun on its chain at either end of the counter
    for (const sx of [-1, 1]) {
      const spare = this.buildGun();
      spare.position.set(sx * (HALF_W - 1.4), 1.27, COUNTER_Z);
      spare.rotation.set(0, Math.PI + sx * 0.3, Math.PI / 2);
      g.add(spare);
    }
    g.add(back, counter, front, roof, awning, sign, bulbs);
    g.position.copy(this.origin);
    shadowed(g, true);
    bulbs.castShadow = false;
    this.ctx.scene.add(g);
    // solid: the counter, the back wall and the sides
    const o = this.origin;
    staticBox(this.ctx, o.x, 0.6, o.z + COUNTER_Z, HALF_W, 0.6, 0.55);
    staticBox(this.ctx, o.x, 2.3, o.z + BACK_Z, HALF_W, 2.3, 0.2);
    for (const sx of [-1, 1]) staticBox(this.ctx, o.x + sx * (HALF_W - 0.45), 2.3, o.z + (BACK_Z + COUNTER_Z) / 2, 0.45, 2.3, (BACK_Z - COUNTER_Z) / 2);
  }

  private backdropTexture() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 400;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, '#1d1238');
    grad.addColorStop(1, '#3b2a6e');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    // stars and a moon
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(255, 245, 210, ${0.4 + rnd() * 0.6})`;
      g.beginPath();
      g.arc(rnd() * c.width, rnd() * c.height * 0.7, 1 + rnd() * 2.5, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#fff3c4';
    g.beginPath();
    g.arc(870, 80, 44, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3b2a6e';
    g.beginPath();
    g.arc(892, 68, 40, 0, Math.PI * 2);
    g.fill();
    // waves along the bottom, under each rail
    for (const [y, col] of [
      [150, '#2ec4b6'],
      [250, '#27a99d'],
      [340, '#1f8c82'],
    ] as const) {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(0, c.height);
      for (let x = 0; x <= c.width; x += 16) g.lineTo(x, y + Math.sin(x * 0.03) * 10);
      g.lineTo(c.width, c.height);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildDucks() {
    const geo = duckGeometry();
    // a white target dot on each face
    const dot = new THREE.CircleGeometry(0.075, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: '#fff5e3' });
    ROWS.forEach((r, row) => {
      for (let i = 0; i < r.count; i++) {
        const pivot = new THREE.Group();
        const body = new THREE.Mesh(geo, this.mats.tin[row]);
        // facing the way it glides
        body.rotation.y = r.speed > 0 ? 0 : Math.PI;
        for (const side of [1, -1]) {
          const d = new THREE.Mesh(dot, dotMat);
          d.position.set(-0.08, 0.2, side * 0.045);
          d.rotation.y = side > 0 ? 0 : Math.PI;
          body.add(d);
        }
        body.castShadow = true;
        pivot.add(body);
        pivot.position.set(this.origin.x, r.y, this.origin.z + r.z);
        this.ctx.scene.add(pivot);
        this.ducks.push({ row, x: -SPAN + ((i + 0.5) / r.count) * SPAN * 2, pivot, body, gold: false, down: false, tip: 0 });
      }
    });
  }

  /** A toy cork rifle: stock, barrel and a cork in the muzzle, pointing along −z. */
  private buildGun() {
    const g = new THREE.Group();
    const wood = std('#9a6236', { roughness: 0.6 });
    const metal = std('#3a3443', { metalness: 0.8, roughness: 0.3 });
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.36), wood);
    stock.position.set(0, -0.03, 0.2);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), wood);
    grip.position.set(0, -0.1, 0.05);
    grip.rotation.x = 0.35;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.5, 10).rotateX(Math.PI / 2), metal);
    barrel.position.set(0, 0.015, -0.24);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10).rotateX(Math.PI / 2), std(PALETTE.candy, { roughness: 0.5 }));
    tip.position.set(0, 0.015, -0.5);
    g.add(stock, grip, barrel, tip);
    return g;
  }

  /** The point a click or tap aims at. */
  private pointAt(e: PointerEvent) {
    const r = this.ctx.renderer.domElement.getBoundingClientRect();
    this.aim.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Where the counter is, for the visitor to stand at, facing the ducks (south). */
  get standSpot() {
    return { x: this.origin.x, z: this.origin.z + COUNTER_Z - 2.6, heading: Math.PI };
  }

  start() {
    this.active = true;
    this.timeLeft = DUCKS_ROUND;
    this.elapsed = 0;
    this.overT = -1;
    this.reload = 0;
    this.stats = { score: 0, shots: 0, hits: 0, streak: 0, bestStreak: 0, golden: 0 };
    this.aim.set(0, 0.05);
    // every duck back up for the new round
    for (const d of this.ducks) {
      d.down = false;
      d.tip = 0;
    }
    this.gun.visible = true;
    this.sight.hidden = false;
    // the shot starts from where the camera is now
    this.camPos.copy(this.ctx.camera.position);
    this.camLook.copy(this.origin).setY(2.4);
  }

  exit() {
    this.active = false;
    this.gun.visible = false;
    this.cork.visible = false;
    this.corkFlight = null;
    this.sight.hidden = true;
    this.onFinish?.();
  }

  /** Seconds left on the round's clock. */
  get secondsLeft() {
    return Math.max(0, this.timeLeft);
  }

  get score() {
    return this.stats.score;
  }

  get hits() {
    return this.stats.hits;
  }

  /** This round's numbers (see account/stats.ts). */
  roundStats(): Record<string, number> {
    const s = this.stats;
    if (!s.shots) return { score: 0, durationS: this.elapsed };
    return { score: s.score, ducksHit: s.hits, accuracy: Math.round((s.hits / s.shots) * 100), bestStreak: s.bestStreak, goldenDucks: s.golden, durationS: this.elapsed };
  }

  /** Fires the cork gun at the sight (E, Space, a click or a tap). */
  shoot() {
    if (!this.active || this.reload > 0 || this.timeLeft <= 0) return;
    this.reload = RELOAD;
    this.stats.shots++;
    this.ctx.sfx.cork();
    this.ray.setFromCamera(this.aim, this.ctx.camera);
    const standing = this.ducks.filter((d) => !d.down && d.pivot.visible);
    const hits = this.ray.intersectObjects(
      standing.map((d) => d.body),
      false,
    );
    const hit = hits.length ? standing.find((d) => d.body === hits[0].object) ?? null : null;
    // the cork flies from the muzzle to whatever it hits (or the back wall)
    const from = this.tmp.set(0, 0.015, -0.55).applyMatrix4(this.gun.matrixWorld).clone();
    let to: THREE.Vector3;
    if (hits.length) to = hits[0].point.clone();
    else {
      // the painted wall at the back (or wherever the shot was going, past it)
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), this.origin.z + BACK_Z - 0.16);
      to = this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.ray.ray.at(30, new THREE.Vector3());
    }
    this.corkFlight = { from, to, t: 0, hit };
    this.cork.visible = true;
    // the gun kicks back
    this.gun.userData.kick = 1;
  }

  /** The cork arrives: a duck tips over (points!), or it bounces off the wall. */
  private land(hit: Duck | null) {
    const s = this.stats;
    if (!hit || hit.down) {
      s.streak = 0;
      this.ctx.sfx.clack();
      this.onShot?.(0, s.score);
      return;
    }
    hit.down = true;
    const points = hit.gold ? GOLD : ROWS[hit.row].points;
    s.score += points;
    s.hits++;
    if (hit.gold) s.golden++;
    s.streak++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    this.ctx.sfx.ting(hit.gold);
    this.onShot?.(points, s.score);
  }

  /** The fixed shot over the counter while playing; the gun follows the sight. */
  updateCamera(cam: THREE.PerspectiveCamera, dt: number) {
    const o = this.origin;
    const k = 1 - Math.exp(-dt * 7);
    // (from a step back, so the counter frames the bottom of the shot)
    this.camPos.lerp(this.tmp.set(o.x, 2.2, o.z + COUNTER_Z - 3.3), k);
    this.camLook.lerp(this.tmp.set(o.x, 2.45, o.z + BACK_Z), k);
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    cam.updateMatrixWorld();
    // the gun at the bottom right of the view, aimed down the line of the sight
    this.ray.setFromCamera(this.aim, cam);
    const target = this.ray.ray.at(8, new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const fwd = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate();
    const kick = (this.gun.userData.kick as number | undefined) ?? 0;
    // (far enough out that the near plane never clips the stock)
    this.gun.position.copy(cam.position).addScaledVector(right, 0.36).addScaledVector(up, -0.32).addScaledVector(fwd, 1.1 - kick * 0.08);
    this.gun.lookAt(target);
    this.gun.rotateY(Math.PI); // the model points along −z, lookAt points +z at the target
    this.gun.rotateX(-kick * 0.12);
    this.gun.updateMatrixWorld();
    // the sight on screen
    const w = this.ctx.renderer.domElement.clientWidth;
    const h = this.ctx.renderer.domElement.clientHeight;
    this.sight.style.transform = `translate(${((this.aim.x + 1) / 2) * w}px, ${((1 - this.aim.y) / 2) * h}px)`;
    this.sight.classList.toggle('reloading', this.reload > 0);
  }

  update(dt: number) {
    // the ducks glide all day long, round and round (a golden one now and then)
    for (const d of this.ducks) {
      const r = ROWS[d.row];
      d.x += r.speed * dt;
      if (d.x > SPAN || d.x < -SPAN) {
        d.x = d.x > SPAN ? d.x - SPAN * 2 : d.x + SPAN * 2;
        d.down = false;
        d.gold = Math.random() < GOLD_CHANCE;
        d.body.material = d.gold ? this.mats.gold : this.mats.tin[d.row];
      }
      d.tip = THREE.MathUtils.lerp(d.tip, d.down ? 1 : 0, Math.min(1, dt * (d.down ? 14 : 6)));
      d.pivot.position.x = this.origin.x + d.x;
      // knocked down: it tips over backwards on its hinge
      d.pivot.rotation.x = d.tip * 1.45;
      // only the stretch of rail between the side panels shows
      d.pivot.visible = Math.abs(d.x) < SPAN - 0.1;
    }
    if (this.corkFlight) {
      const f = this.corkFlight;
      f.t += dt / 0.09;
      this.cork.position.lerpVectors(f.from, f.to, Math.min(1, f.t));
      this.cork.lookAt(f.to);
      if (f.t >= 1) {
        this.cork.visible = false;
        this.corkFlight = null;
        this.land(f.hit);
      }
    }
    const kick = (this.gun.userData.kick as number | undefined) ?? 0;
    if (kick) this.gun.userData.kick = Math.max(0, kick - dt * 8);
    if (!this.active) return;
    this.reload = Math.max(0, this.reload - dt);
    // the keys or the joystick nudge the sight (steer is positive to the left)
    if (this.input) {
      const aspect = this.ctx.camera.aspect;
      this.aim.x = THREE.MathUtils.clamp(this.aim.x - (this.input.steer * AIM_SPEED * dt * 2) / aspect, -0.95, 0.95);
      this.aim.y = THREE.MathUtils.clamp(this.aim.y + this.input.throttle * AIM_SPEED * dt * 2, -0.9, 0.9);
    }
    if (this.overT >= 0) {
      this.overT += dt;
      if (this.overT > LAST_LOOK && !this.corkFlight) {
        this.overT = -1;
        this.active = false;
        this.onComplete?.();
      }
      return;
    }
    this.elapsed += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) this.overT = 0;
  }

  /** The stall's card while playing: the clock, the score, how to aim and what each duck is worth. */
  panelHtml(touch: boolean) {
    const controls = touch
      ? 'Tap a duck to shoot it, or steer the sight with the joystick and press <kbd>E</kbd>.'
      : 'Aim with the <strong>mouse</strong> (or <kbd>WASD</kbd> / arrows) and click (or <kbd>E</kbd> / <kbd>Space</kbd>) to fire.';
    return `<p class="eyebrow">Duck Shoot · ${DUCKS_ROUND} seconds</p><h2>Knock 'em down! 🦆</h2><p>${controls} A duck you knock down stays down until it comes round again.</p><ul class="tags"><li>Bottom row · ${ROWS[2].points} pts</li><li>Middle row · ${ROWS[1].points} pts</li><li>Top row · ${ROWS[0].points} pts</li><li>✨ Golden duck · ${GOLD} pts</li></ul>`;
  }
}
