import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Ctx } from './context';
import type { Input } from './input';
import { clampToGrounds, LAYOUT, respawnFor } from './layout';
import type { PersonRig } from './crowd/people';
import { perks } from './perks';

// The visitor is one of the park's realistic people (see crowd/people.ts): the same rig and
// animation library as every guest, with a fixed outfit. Idle / walk / jog / sprint blend by
// speed; rolling, kicking, waving and reaching out are layered on top.

const WALK_SPEED = 7; // m/s: the park is big, so plain walking already moves at a run
const RUN_SPEED = 11; // holding Shift: a flat-out sprint
const ROLL_SPEED = 12; // faster than the sprint, so a roll still lunges forward
const ACCEL = 24;
const BODY_R = 0.42; // lower collision sphere: its centre sits this high when standing
const KICK_TIME = 0.55;

type Move = 'roll' | 'kick' | 'interact';

/** The visitor: a rigged, motion-animated person who walks, runs, rolls, kicks and waves. */
export class Player {
  group = new THREE.Group();
  body: CANNON.Body;
  speed = 0;
  enabled = true;
  /** Fired when the visitor waves or kicks, so guests nearby can react. */
  onWave: (() => void) | null = null;
  onKick: (() => void) | null = null;
  private move: Move | null = null;
  private moveT = 0;
  private moveDur = 0;
  private kicked = false;
  private heading = 0;
  /** Yaw of the follow camera (0 = looking north); movement input is relative to it. */
  camYaw = 0;
  private turnRate = 0;
  private lastStep = 0;
  private lastImpact = 0;
  private vel = new THREE.Vector2();
  private lean = new THREE.Group();
  /** True while a ride carries the visitor (see carry): no walking, no gravity, no keeping to the ground. */
  private carried = false;

  constructor(
    private ctx: Ctx,
    readonly rig: PersonRig,
  ) {
    // the rig stands on its feet; the physics body's centre sits BODY_R above the ground
    rig.root.position.y = -BODY_R;
    rig.setShadows(true);
    rig.setDetail(true);
    this.lean.add(rig.root);
    this.group.add(this.lean);
    ctx.scene.add(this.group);

    // ---- physics: two spheres (legs + chest) so the visitor can shove letters and crates ----
    this.body = new CANNON.Body({ mass: 90, material: ctx.mats.player, linearDamping: 0.05, fixedRotation: true });
    this.body.addShape(new CANNON.Sphere(BODY_R), new CANNON.Vec3(0, 0, 0));
    this.body.addShape(new CANNON.Sphere(0.32), new CANNON.Vec3(0, 0.82, 0));
    this.body.allowSleep = false;
    ctx.world.addBody(this.body);
    this.body.addEventListener('collide', (e: { contact: CANNON.ContactEquation }) => {
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (v > 3 && ctx.time.t - this.lastImpact > 0.2) {
        this.lastImpact = ctx.time.t;
        ctx.sfx.thunk(v * 0.6);
      }
    });
    this.reset(LAYOUT.spawn.x, LAYOUT.spawn.z, LAYOUT.spawn.heading);
  }

  /** After dark the visitor carries a faint glow of their own colours, so they stay readable. */
  setNightGlow(k: number) {
    this.rig.setGlow(k);
  }

  /** Puts the visitor on their feet at (x, z) facing `heading`, on a floor `floorY` above the ground (a terminal's). */
  reset(x: number, z: number, heading: number, floorY = 0) {
    this.release();
    this.body.position.set(x, floorY + BODY_R + 0.05, z);
    this.body.velocity.setZero();
    this.vel.set(0, 0);
    this.heading = heading;
    this.speed = 0;
    this.sync();
  }

  /**
   * A ride carries the visitor (the SkyLink's train, a scripted walk up a jet bridge): each frame
   * it says where their feet are and which way they face, and `speed` drives the walk cycle (0:
   * standing). Until `release()` (or a `reset`) nothing keeps them to the ground, gravity leaves
   * them be and their own input doesn't move them.
   */
  carry(x: number, feetY: number, z: number, heading: number, speed = 0) {
    if (!this.carried) {
      this.carried = true;
      this.body.type = CANNON.Body.KINEMATIC;
      this.body.collisionResponse = false;
      this.move = null;
    }
    this.body.position.set(x, feetY + BODY_R, z);
    this.body.velocity.setZero();
    this.vel.set(0, 0);
    this.heading = heading;
    this.speed = speed;
    this.sync();
  }

  /** The ride's over: the visitor walks (and falls) on their own again, from wherever it left them. */
  release() {
    if (!this.carried) return;
    this.carried = false;
    this.body.type = CANNON.Body.DYNAMIC;
    this.body.collisionResponse = true;
    this.body.velocity.setZero();
    this.body.wakeUp();
  }

  /** True while a ride carries the visitor (see carry). */
  get isCarried() {
    return this.carried;
  }

  get position() {
    return this.group.position;
  }

  get forward() {
    return new THREE.Vector2(-Math.sin(this.heading), -Math.cos(this.heading));
  }

  /** Wave with the right hand (upper body only, so it works while walking). */
  wave() {
    this.rig.wave(1.8);
    this.ctx.sfx.whistle();
    this.onWave?.();
  }

  /** Dodge-roll forward. */
  roll() {
    if (this.startMove('roll')) this.ctx.sfx.swish();
  }

  /** Kick whatever is in front of you: crates, letters… */
  kick() {
    if (this.startMove('kick')) this.kicked = false;
  }

  /** A short "reach out" gesture when using an attraction. */
  interact() {
    this.startMove('interact');
  }

  private startMove(m: Move) {
    if (!this.enabled || this.move) return false;
    this.move = m;
    if (m === 'kick') {
      this.rig.kick();
      this.moveT = KICK_TIME;
    } else this.moveT = this.rig.play(m === 'roll' ? 'Roll' : 'Interact', m === 'roll' ? 1.15 : 1.2);
    this.moveDur = this.moveT;
    return true;
  }

  update(dt: number, input: Input) {
    const b = this.body;
    if (this.carried) {
      // the ride sets the pose: the visitor only animates (walking along with it, or standing)
      this.animate(dt);
      return;
    }
    // camera-relative movement: W = away from the camera, D = to its right
    let mx = 0;
    let mz = 0;
    if (this.enabled) {
      const ix = -input.steer;
      const iz = -input.throttle;
      const c = Math.cos(this.camYaw);
      const s = Math.sin(this.camYaw);
      mx = ix * c + iz * s;
      mz = -ix * s + iz * c;
    }
    const mag = Math.min(1, Math.hypot(mx, mz));
    const running = this.enabled && input.boost && mag > 0.1;
    // a sugar rush from the booth's cotton candy
    let top = (running ? RUN_SPEED : WALK_SPEED) * mag * perks.speedMul;
    let tx = 0;
    let tz = 0;
    if (this.move === 'roll') {
      // committed to the roll: carry on forward, fading out at the end
      const f = this.forward;
      const k = ROLL_SPEED * Math.min(1, this.moveT * 2.5);
      tx = f.x * k;
      tz = f.y * k;
    } else {
      if (this.move) top *= 0.15; // planted while kicking / interacting
      if (mag > 0.05) {
        const k = top / Math.hypot(mx, mz);
        tx = mx * k;
        tz = mz * k;
        // turn to face where we're going (shortest way round)
        let d = Math.atan2(-mx, -mz) - this.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const turn = THREE.MathUtils.clamp(d, -10 * dt, 10 * dt);
        this.heading += turn;
        this.turnRate = THREE.MathUtils.lerp(this.turnRate, turn / Math.max(dt, 1e-4), 0.2);
      } else {
        this.turnRate = THREE.MathUtils.lerp(this.turnRate, 0, 0.2);
      }
    }
    const dvx = tx - this.vel.x;
    const dvz = tz - this.vel.y;
    const dl = Math.hypot(dvx, dvz);
    const accel = this.move === 'roll' ? ACCEL * 2 : ACCEL;
    const step = Math.min(dl, accel * dt);
    if (dl > 1e-5) this.vel.add(new THREE.Vector2((dvx / dl) * step, (dvz / dl) * step));
    b.velocity.x = this.vel.x;
    b.velocity.z = this.vel.y;
    this.speed = this.vel.length();

    // keep to the walkable ground of the landmass the visitor is on (the fair and the roads out of
    // it, the airport, Palm Cay), never across the sea
    const clamped = clampToGrounds(b.position.x, b.position.z);
    if (clamped) {
      b.position.x = clamped[0];
      b.position.z = clamped[1];
      this.vel.multiplyScalar(0.3);
    }
    // a fall through the world puts them back on their feet in the same region
    if (b.position.y < -5) {
      const r = respawnFor(b.position.x, b.position.z);
      this.reset(r.x, r.z, r.heading);
    }

    this.animate(dt);
    this.ctx.sfx.setEngine(0, false);
    this.sync();
  }

  private animate(dt: number) {
    const s = this.speed;
    if (this.move) {
      this.moveT -= dt;
      // the foot connects a third of the way into the kick
      if (this.move === 'kick' && !this.kicked && this.moveT < this.moveDur * 0.62) {
        this.kicked = true;
        this.kickProps();
        this.onKick?.();
      }
      if (this.moveT <= 0) this.move = null;
    }
    this.rig.update(dt, this.move === 'roll' ? 0 : s);

    // footsteps: two per stride
    const stepIndex = Math.floor(this.rig.stride * 2);
    if (stepIndex !== this.lastStep) {
      this.lastStep = stepIndex;
      if (s > 0.6 && !this.move) this.ctx.sfx.footstep(this.rig.runBlend > 0.5);
    }

    // a little lean into turns at speed
    const kk = 1 - Math.exp(-dt * 10);
    this.lean.rotation.z = THREE.MathUtils.lerp(this.lean.rotation.z, THREE.MathUtils.clamp(-this.turnRate * s * 0.01, -0.2, 0.2), kk);
  }

  /** Launch every loose prop just in front of the kicking foot. */
  private kickProps() {
    const f = this.forward;
    const p = this.body.position;
    const foot = new THREE.Vector2(p.x + f.x * 0.9, p.z + f.y * 0.9);
    let hit = false;
    for (const { body } of this.ctx.dynamics) {
      if (body.mass <= 0 || body === this.body) continue;
      const dx = body.position.x - foot.x;
      const dz = body.position.z - foot.y;
      if (Math.hypot(dx, dz) > 1.7 || body.position.y > 3) continue;
      const m = body.mass;
      // the booth's popcorn: a power kick
      const k = perks.kickMul;
      body.wakeUp();
      body.applyImpulse(new CANNON.Vec3(f.x * m * 9 * k, m * 4.5 * Math.sqrt(k), f.y * m * 9 * k));
      body.angularVelocity.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
      hit = true;
    }
    if (hit) this.ctx.sfx.whack();
  }

  sync() {
    this.group.position.set(this.body.position.x, this.body.position.y, this.body.position.z);
    this.group.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.heading);
  }
}
