import * as THREE from 'three';
import { shadowed, staticBox, std, type Attraction, type Ctx } from '../context';
import type { Input } from '../input';
import { LAYOUT, parkBounds } from '../layout';
import { FALCON_TRACK, STACK_TRACK } from '../rides';
import { hdr, PALETTE, signMaterial, signTexture, stripeTexture } from '../textures';

/**
 * What a drone rental gets you: one battery's worth of flight time (one round, paid for with
 * tickets at the kiosk), after which the drone flies itself home and lands. `recharge()` is the
 * hook for selling extra flight time mid-air.
 */
export const DRONE_RENTAL = { battery: 120 };

const SCALE = 1.5; // a big, friendly camera drone that stays easy to spot from the chase cam
const SPEED = 12; // m/s cruising
const FAST = 32; // m/s with Shift (or the stick pushed all the way)
const CLIMB = 6;
const FAST_CLIMB = 14;
const TURN = 1.7; // rad/s
const HOME_SPEED = 24;
const CEILING = 320; // metres: high enough to look down on the 250 m giant wheel
const CLEARANCE = 1.2; // the drone never gets closer to the ground than this
const PAD_TOP = 0.125;
const PARKED_Y = PAD_TOP + 0.3 * SCALE; // the skids sit 0.3 below the drone's centre
const WARNINGS = [30, 10]; // seconds of battery left that get a heads-up

type Phase = 'parked' | 'takeoff' | 'fly' | 'home' | 'land';
type Cam = 'chase' | 'gimbal' | 'top';
const CAM_LABEL: Record<Cam, string> = { chase: 'Chase', gimbal: 'Gimbal', top: 'Top' };

const $ = (id: string) => document.getElementById(id)!;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The drone kiosk beside North Avenue: rent the camera drone and fly it anywhere over the park. */
export class Drone implements Attraction {
  private drone = new THREE.Group();
  private tilt = new THREE.Group();
  private rotors: THREE.Object3D[] = [];
  private discs: THREE.Mesh[] = [];
  private discMat = new THREE.MeshBasicMaterial({ color: '#e9e4f2', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  private rearLed = new THREE.MeshBasicMaterial({ color: hdr(PALETTE.candy, 6) });
  private pad = new THREE.Vector3(LAYOUT.dronePad.x, 0, LAYOUT.dronePad.z);
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private target = new THREE.Vector3();
  private heading = 0;
  private turnRate = 0;
  private spin = 0;
  private phase: Phase = 'parked';
  private phaseT = 0;
  private battery = 0;
  private capacity = 0;
  private warned = 0;
  private cam: Cam = 'chase';
  private camPitch = 0.3;
  private zoom = 1;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private bounds = { x0: 0, z0: 0, x1: 0, z1: 0 };
  private stats = { time: 0, distance: 0, maxAlt: 0, topSpeed: 0 };
  private hudTimer = 0;
  private toastTimer = 0;
  private introTimer = 0;
  private fenceTimer = 0;
  active = false;
  input: Input | null = null;
  /** The drone has touched down on its pad after flying itself home. */
  onLanded: (() => void) | null = null;
  onFinish: (() => void) | null = null;

  constructor(private ctx: Ctx, private ground: (x: number, z: number) => number) {
    this.buildKiosk();
    this.buildPad();
    this.buildDrone();
    this.park();

    // the flying zone: the park and both coasters, with room to spare
    let { x0, x1, z0, z1 } = parkBounds();
    for (const d of [STACK_TRACK, FALCON_TRACK])
      for (const p of d.pos) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z);
        z1 = Math.max(z1, p.z);
      }
    const m = 150;
    this.bounds = { x0: x0 - m, z0: Math.min(z0, LAYOUT.ferris.z) - m, x1: x1 + m, z1: z1 + m };
  }

  private buildKiosk() {
    const root = new THREE.Group();
    root.position.set(LAYOUT.drone.x, 0, LAYOUT.drone.z);
    root.rotation.y = -Math.PI / 2; // the counter faces North Avenue
    const hut = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.8, 2.6), std(PALETTE.violet));
    hut.position.y = 1.4;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 3), std(PALETTE.cream));
    roof.position.y = 2.95;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.18, 0.8), std(PALETTE.cream));
    counter.position.set(0, 1.25, 1.65);
    const window_ = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.1), std('#2a2050', { emissive: '#7ff0e4', emissiveIntensity: 1.4, roughness: 0.1 }));
    window_.position.set(0, 2.0, 1.31);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.06, 1.3), std('#ffffff', { map: stripeTexture(PALETTE.teal, PALETTE.cream, 10) }));
    awning.position.set(0, 2.75, 1.85);
    awning.rotation.x = 0.28;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 1.575),
      signMaterial(signTexture('DRONE FLIGHTS', { sub: 'See the whole fair from the sky', border: PALETTE.teal })),
    );
    sign.position.set(0, 3.95, 0.6);
    root.add(hut, roof, counter, window_, awning, sign);
    shadowed(root, true);
    this.ctx.scene.add(root);
    staticBox(this.ctx, LAYOUT.drone.x - 0.35, 1.4, LAYOUT.drone.z, 1.65, 1.4, 1.95);
  }

  private buildPad() {
    const g = new THREE.Group();
    g.position.copy(this.pad);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.9, PAD_TOP, 40), std('#3a3348'));
    base.position.y = PAD_TOP / 2;
    const top = new THREE.Mesh(new THREE.CircleGeometry(2.55, 40), std('#ffffff', { map: padTexture(), roughness: 0.6 }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = PAD_TOP + 0.005;
    const n = 12;
    const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(PALETTE.teal, 5) }), n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      lights.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * 2.72, PAD_TOP + 0.02, Math.sin(a) * 2.72));
    }
    g.add(base, top, lights);
    base.receiveShadow = top.receiveShadow = true;
    this.ctx.scene.add(g);
  }

  private buildDrone() {
    const shell = new THREE.MeshPhysicalMaterial({ color: PALETTE.cream, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 });
    const frame = std('#2a2433', { roughness: 0.5, metalness: 0.3 });
    const accent = std(PALETTE.teal, { roughness: 0.4 });
    const t = this.tilt;

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.5, 6, 14), shell);
    body.rotation.x = Math.PI / 2;
    body.scale.set(1.4, 1, 0.7);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.6), accent);
    stripe.position.y = 0.145;
    t.add(body, stripe);
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 1.75), frame);
      arm.rotation.y = a;
      t.add(arm);
    }
    const blade = new THREE.BoxGeometry(0.6, 0.012, 0.055);
    const front = new THREE.MeshBasicMaterial({ color: hdr(PALETTE.teal, 6) });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = sx * 0.62;
      const z = sz * 0.62;
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.12, 12), frame);
      motor.position.set(x, 0.06, z);
      const rotor = new THREE.Group();
      rotor.position.set(x, 0.13, z);
      rotor.add(new THREE.Mesh(blade, shell), new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8), accent));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.31, 24), this.discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, 0.13, z);
      this.discs.push(disc);
      const guard = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.018, 6, 28), accent);
      guard.rotation.x = Math.PI / 2;
      guard.position.set(x, 0.13, z);
      // navigation lights: teal at the front, blinking red at the back
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), sz < 0 ? front : this.rearLed);
      led.position.set(x, -0.02, z);
      t.add(motor, rotor, disc, guard, led);
      this.rotors.push(rotor);
    }
    const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), frame);
    gimbal.position.set(0, -0.16, -0.3);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), std('#14304a', { emissive: '#3aa0ff', emissiveIntensity: 1.2, roughness: 0.1 }));
    lens.position.set(0, -0.16, -0.391);
    lens.rotation.y = Math.PI;
    t.add(gimbal, lens);
    for (const sx of [-1, 1]) {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 6), frame);
      skid.rotation.x = Math.PI / 2;
      skid.position.set(sx * 0.2, -0.28, 0);
      t.add(skid);
      for (const sz of [-1, 1]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.2, 0.025), frame);
        strut.position.set(sx * 0.2, -0.18, sz * 0.17);
        t.add(strut);
      }
    }
    t.scale.setScalar(SCALE);
    this.drone.add(t);
    shadowed(this.drone);
    for (const d of this.discs) d.castShadow = false; // a blur, not a solid
    this.ctx.scene.add(this.drone);
  }

  /** Back on the pad, motors off. */
  private park() {
    this.pos.set(this.pad.x, PARKED_Y, this.pad.z);
    this.vel.set(0, 0, 0);
    this.heading = 0; // facing north, down North Avenue toward the giant wheel
    this.turnRate = 0;
    this.phase = 'parked';
    this.place(0, 0);
  }

  get position() {
    return this.pos;
  }

  /** Yaw, with 0 facing north (−z), like the visitor's. */
  get yaw() {
    return this.heading;
  }

  /** Height above the park's ground level. */
  get altitude() {
    return this.pos.y;
  }

  /** Ground point under the drone (for shadows). */
  get focus() {
    return this.pos.clone().setY(0);
  }

  private get forward() {
    return new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  /**
   * The rental offer: one battery for `cost` tickets. For guests (or a member short of tickets),
   * `gate` (a note and a way forward) takes the launch button's place.
   */
  offerHtml(cost: number, gate: string | null = null) {
    const { battery } = DRONE_RENTAL;
    return `<p class="eyebrow">Drone Flights · Rental kiosk</p><h2>See the whole fair from the sky 🚁</h2><p>Take our camera drone up over the park: skim the avenues, chase the coaster trains, and climb past the top of the 250 m Giant Wheel.</p><p class="drone-offer"><span>🔋 ${fmt(
      battery,
    )} of flight</span><span>🎟️ ${cost} ${cost === 1 ? 'ticket' : 'tickets'}</span></p><p>${this.controlsHtml()}</p><p class="sub">One flight per rental: when the battery runs flat (or you press <kbd>H</kbd>), the drone flies itself home and lands on its pad.</p>${
      gate ?? `<p><button class="btn btn-primary btn-small" type="button" data-drone-launch>Launch the drone · ${cost} 🎟️</button></p>`
    }`;
  }

  private controlsHtml() {
    return this.ctx.mobile
      ? 'Joystick <strong>up</strong> flies forward, <strong>sideways</strong> turns (push it all the way to go fast). <strong>▲ ▼</strong> climb and descend, <kbd>E</kbd> switches camera. Drag the view to look around.'
      : '<kbd>W</kbd>/<kbd>S</kbd> forward · back, <kbd>A</kbd>/<kbd>D</kbd> turn, <kbd>Space</kbd> climb, <kbd>X</kbd> descend, hold <kbd>Shift</kbd> to fly fast. <kbd>C</kbd> camera, <kbd>H</kbd> fly home. Drag to look around, scroll to zoom.';
  }

  /** Takes off with a fresh battery of `seconds` of flight time. */
  start(seconds = DRONE_RENTAL.battery) {
    this.park();
    this.active = true;
    this.phase = 'takeoff';
    this.phaseT = 0;
    this.battery = this.capacity = seconds;
    this.warned = 0;
    this.cam = 'chase';
    this.camPitch = 0.3;
    this.stats = { time: 0, distance: 0, maxAlt: 0, topSpeed: 0 };
    this.camPos.copy(this.pos).add(new THREE.Vector3(0, 4, 9));
    this.camLook.copy(this.pos);
    $('drone-hud').hidden = false;
    $('dh-toast').hidden = true;
    $('dh-cam').textContent = CAM_LABEL[this.cam];
    $('dh-keys').innerHTML = this.ctx.mobile
      ? 'Stick fly · ▲▼ climb · <kbd>E</kbd> camera'
      : '<kbd>WASD</kbd> fly · <kbd>Space</kbd>/<kbd>X</kbd> up · down · <kbd>Shift</kbd> fast · <kbd>C</kbd> cam · <kbd>H</kbd> home';
    document.body.classList.add('is-flying');
    this.hudTimer = 0;
    this.updateHud(0);
    // the intro opens by itself the first time (then steps aside); after that it's behind the ℹ️
    const shown = this.ctx.ui.setIntro(
      'drone-intro',
      'Drone Flights',
      `<p class="eyebrow">Drone Flights · ${fmt(seconds)} of battery</p><h2>Cleared for take-off!</h2><p>${this.controlsHtml()}</p>`,
      { accent: PALETTE.teal, left: true },
    );
    this.introTimer = shown ? 9 : 0;
    this.ctx.sfx.chime();
  }

  /** Adds flight time mid-air: the hook for buying more with park coins. */
  recharge(seconds: number) {
    if (!this.active) return;
    this.battery += seconds;
    this.capacity = Math.max(this.capacity, this.battery);
    this.warned = WARNINGS.filter((w) => this.battery <= w).length;
    if (this.phase === 'home') this.phase = 'fly';
    this.toast(`+${fmt(seconds)} of flight 🔋`);
  }

  /** Hands control to the autopilot, which flies back to the pad and lands. */
  flyHome() {
    if (this.phase !== 'fly') return;
    this.phase = 'home';
    this.phaseT = 0;
    this.toast(this.battery <= 0 ? 'Battery flat: flying home 🏠' : 'Flying home 🏠');
    this.ctx.sfx.whoosh();
  }

  cycleCamera() {
    const order: Cam[] = ['chase', 'gimbal', 'top'];
    this.cam = order[(order.indexOf(this.cam) + 1) % order.length];
    $('dh-cam').textContent = CAM_LABEL[this.cam];
    this.ctx.sfx.pop();
  }

  /** Dragging the view: sideways turns the drone, up/down tilts the camera. */
  look(dx: number, dy: number) {
    if (this.phase === 'fly') this.heading -= dx;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy, -0.35, 1.45);
  }

  zoomBy(delta: number) {
    this.zoom = THREE.MathUtils.clamp(this.zoom + delta * 0.001, 0.5, 2.5);
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.park();
    $('drone-hud').hidden = true;
    document.body.classList.remove('is-flying');
    this.ctx.sfx.setDrone(0);
    this.onFinish?.();
  }

  /** This flight's numbers (see account/stats.ts). */
  roundStats(): Record<string, number> {
    const s = this.stats;
    return { durationS: s.time, maxAltitudeM: s.maxAlt, distanceM: s.distance, topSpeedKmh: s.topSpeed * 3.6 };
  }

  update(dt: number, t: number) {
    this.rearLed.color.copy(hdr(PALETTE.candy, Math.sin(t * 7) > 0.2 ? 6 : 0.4));
    if (!this.active) {
      this.place(dt, t);
      return;
    }
    this.phaseT += dt;
    const tv = this.target.set(0, 0, 0);
    let spinTarget = 1;
    let turn = 0;
    let floor = this.ground(this.pos.x, this.pos.z) + CLEARANCE;

    if (this.phase === 'takeoff') {
      // spin up on the pad, then lift off to a hover
      if (this.phaseT > 0.9) tv.y = 3.5;
      if (this.pos.y > PARKED_Y + 6) this.phase = 'fly';
    } else if (this.phase === 'fly') {
      this.battery -= dt;
      this.stats.time += dt;
      this.batteryWarnings();
      if (this.battery <= 0) {
        this.battery = 0;
        this.flyHome();
      }
      const inp = this.input;
      if (inp) {
        const fast = inp.boost;
        tv.copy(this.forward).multiplyScalar(inp.throttle * (fast ? FAST : SPEED));
        tv.y = inp.lift * (fast ? FAST_CLIMB : CLIMB);
        turn = inp.steer * TURN;
      }
    } else if (this.phase === 'home') {
      this.stats.time += dt;
      turn = this.autopilot(tv);
    } else if (this.phase === 'land') {
      // settle onto the middle of the pad, facing north again
      tv.set((this.pad.x - this.pos.x) * 2, -THREE.MathUtils.clamp((this.pos.y - PARKED_Y) * 0.7, 1.2, 8), (this.pad.z - this.pos.z) * 2);
      turn = THREE.MathUtils.clamp(-angleTo(this.heading, 0) * 2, -TURN, TURN);
      floor = PARKED_Y;
      if (this.pos.y <= PARKED_Y + 0.01) {
        spinTarget = 0;
        tv.set(0, 0, 0);
        this.vel.set(0, 0, 0);
        if (this.spin < 0.05 && this.onLanded) {
          const cb = this.onLanded;
          this.phase = 'parked'; // fire once
          cb();
        }
      }
    }

    // floaty, drone-like response: velocity eases toward what the sticks ask for
    const kh = 1 - Math.exp(-dt * 2.4);
    const kv = 1 - Math.exp(-dt * 4);
    this.vel.x += (tv.x - this.vel.x) * kh;
    this.vel.z += (tv.z - this.vel.z) * kh;
    this.vel.y += (tv.y - this.vel.y) * kv;
    this.turnRate += (turn - this.turnRate) * (1 - Math.exp(-dt * 6));
    this.heading += this.turnRate * dt;
    this.spin += (spinTarget - this.spin) * (1 - Math.exp(-dt * (spinTarget ? 3 : 1.6)));

    const before = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      this.vel.y = Math.max(0, this.vel.y);
    }
    if (this.pos.y > CEILING) {
      this.pos.y = CEILING;
      this.vel.y = Math.min(0, this.vel.y);
    }
    this.geofence(dt);

    const moved = this.pos.distanceTo(before);
    this.stats.distance += moved;
    this.stats.maxAlt = Math.max(this.stats.maxAlt, this.pos.y);
    this.stats.topSpeed = Math.max(this.stats.topSpeed, moved / Math.max(dt, 1e-4));

    this.place(dt, t);
    this.ctx.sfx.setDrone(this.spin, this.vel.length() / FAST);
    this.updateHud(dt);
    if (this.introTimer > 0) {
      this.introTimer -= dt;
      if (this.introTimer <= 0 && this.ctx.ui.panelOpenKey === 'drone-intro') this.ctx.ui.hidePanel();
    }
  }

  /** Return-to-home: a glide path back to the pad, staying well clear of the cliff on the way. */
  private autopilot(tv: THREE.Vector3) {
    const dx = this.pad.x - this.pos.x;
    const dz = this.pad.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.5) {
      this.phase = 'land';
      return 0;
    }
    const ux = dx / d;
    const uz = dz / d;
    const ahead = Math.min(d, 60);
    const terrain = Math.max(this.ground(this.pos.x, this.pos.z), this.ground(this.pos.x + ux * ahead, this.pos.z + uz * ahead));
    const glide = Math.max(terrain + 18, PARKED_Y + 4 + d * 0.35);
    tv.y = THREE.MathUtils.clamp((glide - this.pos.y) * 0.8, -9, 9);
    // well above the glide path: ease off, so the descent keeps up and it doesn't arrive 100 m up
    const sp = Math.min(HOME_SPEED, d * 0.6) * THREE.MathUtils.clamp(1 - (this.pos.y - glide) / 80, 0.25, 1);
    tv.x = ux * sp;
    tv.z = uz * sp;
    return d > 3 ? THREE.MathUtils.clamp(angleTo(this.heading, Math.atan2(-ux, -uz)) * 2, -TURN, TURN) : 0;
  }

  /** Keeps the drone over the fair: it stops at the edge of the flying zone. */
  private geofence(dt: number) {
    const b = this.bounds;
    const p = this.pos;
    const v = this.vel;
    let hit = false;
    if (p.x < b.x0) [p.x, v.x, hit] = [b.x0, Math.max(0, v.x), true];
    if (p.x > b.x1) [p.x, v.x, hit] = [b.x1, Math.min(0, v.x), true];
    if (p.z < b.z0) [p.z, v.z, hit] = [b.z0, Math.max(0, v.z), true];
    if (p.z > b.z1) [p.z, v.z, hit] = [b.z1, Math.min(0, v.z), true];
    this.fenceTimer -= dt;
    if (hit && this.fenceTimer <= 0) {
      this.fenceTimer = 4;
      this.toast('Edge of the flying zone: turn back ↩️');
    }
  }

  private batteryWarnings() {
    while (this.warned < WARNINGS.length && this.battery <= WARNINGS[this.warned]) {
      const left = WARNINGS[this.warned++];
      this.toast(`🔋 ${left} s of battery left${left <= 10 ? ': heading home soon' : ''}`);
      this.ctx.sfx.beep(left <= 10);
    }
  }

  /** Moves the model to the flight state: tilt into the motion, spin the props. */
  private place(dt: number, t: number) {
    this.drone.position.copy(this.pos);
    this.drone.rotation.y = this.heading;
    // speed along / across the drone's nose, for a nose-down pitch and a bank into turns
    const f = this.forward;
    const along = this.vel.x * f.x + this.vel.z * f.z;
    this.tilt.rotation.x = THREE.MathUtils.clamp(-along / FAST, -0.3, 0.3);
    this.tilt.rotation.z = THREE.MathUtils.clamp(this.turnRate * 0.18 * (0.4 + Math.abs(along) / SPEED), -0.4, 0.4);
    this.tilt.position.y = this.spin > 0.5 && this.phase !== 'land' ? Math.sin(t * 2.3) * 0.05 : 0;
    this.rotors.forEach((r, i) => (r.rotation.y += (i % 2 ? 1 : -1) * this.spin * 55 * dt));
    this.discMat.opacity = Math.max(0, this.spin - 0.4) * 0.35;
    for (const r of this.rotors) r.visible = this.spin < 0.85;
  }

  private toast(text: string) {
    const el = $('dh-toast');
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.toastTimer = 3.2;
  }

  private updateHud(dt: number) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) $('dh-toast').hidden = true;
    }
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    $('dh-time').textContent = fmt(Math.ceil(this.battery));
    ($('dh-bar').firstElementChild as HTMLElement).style.width = `${(this.battery / Math.max(1, this.capacity)) * 100}%`;
    const hud = $('drone-hud');
    hud.classList.toggle('is-low', this.battery <= WARNINGS[0]);
    hud.classList.toggle('is-critical', this.battery <= WARNINGS[1]);
    $('dh-alt').textContent = `${Math.round(this.pos.y)} m`;
    $('dh-speed').textContent = `${Math.round(this.vel.length() * 3.6)} km/h`;
    $('dh-status').textContent = this.phase === 'home' ? 'Flying home…' : this.phase === 'land' ? 'Landing…' : this.phase === 'takeoff' ? 'Taking off…' : 'Battery';
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const f = this.forward;
    const p = this.pos;
    if (this.cam === 'gimbal') {
      // the camera under the drone's nose, tilted down by the gimbal
      camera.up.set(0, 1, 0);
      const eye = p.clone().addScaledVector(f, 0.62 * SCALE).setY(p.y - 0.3 * SCALE);
      const dir = f.clone().multiplyScalar(Math.cos(this.camPitch)).setY(-Math.sin(this.camPitch));
      camera.position.copy(eye);
      camera.lookAt(eye.add(dir));
      this.camPos.copy(camera.position);
      this.camLook.copy(p);
      return;
    }
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    if (this.cam === 'top') {
      // straight down from above, the drone's nose pointing up the screen
      camera.up.copy(f);
      pos = p.clone().setY(p.y + 45 * this.zoom);
      look = p.clone();
    } else {
      camera.up.set(0, 1, 0);
      const dist = 10 * this.zoom;
      pos = p
        .clone()
        .addScaledVector(f, -dist * Math.cos(this.camPitch))
        .setY(p.y + 1.2 + dist * Math.sin(this.camPitch));
      pos.y = Math.max(pos.y, this.ground(pos.x, pos.z) + 1.5);
      look = p.clone().addScaledVector(f, 6);
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
  }
}

/** Signed shortest angle from `a` to `b`. */
function angleTo(a: number, b: number) {
  const d = b - a;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/** The landing pad's marking: a ring and a big "D". */
function padTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2440';
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = PALETTE.mustard;
  g.lineWidth = 22;
  g.beginPath();
  g.arc(256, 256, 220, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([26, 22]);
  g.lineWidth = 8;
  g.strokeStyle = PALETTE.cream;
  g.beginPath();
  g.arc(256, 256, 175, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = PALETTE.cream;
  g.font = '260px "Lilita One", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('D', 256, 270);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
