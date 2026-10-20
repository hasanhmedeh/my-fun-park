// A sit-down jet-ski on the water, as arcade physics that still feels like a boat (no cannon: the
// whole race is five of these and a lagoon). A pump jet pushes along the nose, and the nozzle
// steers only while it's pushing: let go of the throttle and the ski carries on almost straight.
// Off the plane the hull wallows and slides; once it's up on the plane (from about 18 km/h) it
// sits higher, drags less and carves, the rider leaning into the turn. The hull floats on the sea
// surface (waveY) on a damped spring, so it bobs on the swell, bounces over wakes and, off a
// ramp's lip, flies, landing with a slap that costs speed unless it comes down flat. Pure
// functions of the state, so scripts/jetski-check.mjs can drive a ski round the course in node.

import { onRamp, rampLift, type Ramp } from './jetski-course';

/** Top speed flat out (m/s, 76 km/h), and with the surf boost. */
export const VMAX = 21;
export const BOOST_K = 1.28;
/** Gravity, a little stronger than Earth's: jumps feel snappy rather than floaty. */
export const GRAV = 11;
const ACCEL = 8.5;
const BRAKE = 7;
const REV_ACC = 3;
const REV_MAX = 3.5;
/** How deep the hull sits: off the plane, and up on it. */
const DRAFT = { low: 0.24, plane: 0.07 };
/** The water's spring and damping on the hull (per unit mass). */
const FLOAT_K = 70;
const FLOAT_C = 9;
/** Sideways grip: wallowing, planing (carving), and stunned. */
const GRIP = { low: 1.5, plane: 3.4, stun: 0.7 };
/** The shallows beyond the course's edge (sea grass, a sandbar): top speed there. */
const SHALLOW_K = 0.62;

export interface Craft {
  x: number;
  z: number;
  /** Yaw (park convention: 0 faces north, −z; forward is (−sin h, −cos h)). */
  h: number;
  vx: number;
  vz: number;
  /** The hull's reference point (its middle, at the keel) and its vertical speed. */
  y: number;
  vy: number;
  /** Nose up +, and lean left + (the body's rotation.x and rotation.z). */
  pitch: number;
  pitchV: number;
  roll: number;
  yawRate: number;
  /** The handlebars, easing towards the rider's input (−1..1, left +). */
  steer: number;
  /** 0 off the plane .. 1 up on it. */
  plane: number;
  air: boolean;
  airT: number;
  /** Yaw turned since leaving the water (a 360 spin is a trick). */
  airYaw: number;
  /** The ramp the ski is riding up (an index into the ramps), or −1. */
  ramp: number;
  boosting: boolean;
  /** Seconds of a burst of boost still to burn (the action button), and the surf meter (0..1). */
  burst: number;
  surf: number;
  /** Seconds still dazed after a bad landing or a crash: little power, little grip. */
  stunT: number;
  /** In the shallows beyond the course's edge (set by the race each frame). */
  shallow: boolean;
  /** This frame's controls. */
  throttle: number;
  steerIn: number;
  wantBoost: boolean;
}

export function newCraft(): Craft {
  return {
    x: 0, z: 0, h: 0, vx: 0, vz: 0, y: 0, vy: 0, pitch: 0, pitchV: 0, roll: 0, yawRate: 0, steer: 0, plane: 0,
    air: false, airT: 0, airYaw: 0, ramp: -1, boosting: false, burst: 0, surf: 0, stunT: 0, shallow: false,
    throttle: 0, steerIn: 0, wantBoost: false,
  };
}

/** What one step did that the race (or the effects) wants to know about. */
export interface StepEvents {
  /** Left the water or a ramp's lip this step, with this upward speed. */
  launched: number;
  /** Came down this step: the airtime, how hard (downward m/s), and how it went. */
  landed: null | { airT: number; impact: number; result: 'clean' | 'rough' | 'stuffed' | 'sideways'; spin: boolean };
}

export const forwardSpeed = (c: Craft) => -c.vx * Math.sin(c.h) - c.vz * Math.cos(c.h);

/** Yaw rate the nozzle can give at speed v (rad/s): quick when slow, a wider arc at full tilt. */
export const yawMax = (v: number) => (1.9 * Math.min(1, Math.abs(v) / 3)) / (1 + Math.abs(v) / 17);

const BOOST_DRAIN = 1 / 2.6; // a full meter lasts 2.6 s
const ev: StepEvents = { launched: 0, landed: null };
const rp = { along: 0, across: 0 };

/**
 * One physics step of `dt` seconds. `water` is the sea surface's height under the ski (waveY at
 * its middle) and `slope` the surface's rise per metre along its nose (from the bow and stern
 * heights); `ramps` are the course's kickers. Returns this step's events (a shared object).
 */
export function stepCraft(c: Craft, dt: number, water: number, slope: number, ramps: readonly Ramp[]): StepEvents {
  ev.launched = 0;
  ev.landed = null;
  const fx = -Math.sin(c.h);
  const fz = -Math.cos(c.h);
  const lx = fz; // left of the nose
  const lz = -fx;
  let vf = c.vx * fx + c.vz * fz;
  let vl = c.vx * lx + c.vz * lz;
  const stunned = c.stunT > 0;
  if (c.stunT > 0) c.stunT -= dt;

  // the boost: held (Shift) burns the meter; a burst (the action button) burns it for a moment
  if (c.burst > 0) c.burst -= dt;
  c.boosting = (c.wantBoost || c.burst > 0) && c.surf > 0 && !stunned && c.throttle > 0;
  if (c.boosting) c.surf = Math.max(0, c.surf - BOOST_DRAIN * dt);
  if (c.surf <= 0) c.burst = 0;

  // ---- vertical: riding up a ramp, floating, or flying
  const wasAir = c.air;
  const draft = DRAFT.low + (DRAFT.plane - DRAFT.low) * c.plane;
  let deck = -1;
  if (c.ramp >= 0) {
    const r = ramps[c.ramp];
    onRamp(r, c.x, c.z, rp);
    deck = Math.abs(rp.across) <= r.width / 2 + 0.3 ? rampLift(r, rp.along) : -1;
    if (deck < 0) {
      // off the lip (or over its side): the ski keeps the speed the slope gave it
      c.ramp = -1;
      if (rp.along > r.len - 0.5) ev.launched = c.vy;
    }
  }
  let inWater = false;
  if (deck >= 0) {
    const r = ramps[c.ramp];
    const ahead = rampLift(r, Math.min(r.len, rp.along + 0.5));
    const rise = (ahead - deck) / 0.5;
    c.y = water + deck;
    c.vy = Math.max(c.vy, rise * Math.max(0, vf));
    c.pitch += (Math.atan(rise) - c.pitch) * Math.min(1, dt * 14);
    c.pitchV = 0;
    c.air = false;
  } else {
    const depth = water - draft - c.y;
    if (depth > -0.04) {
      inWater = true;
      c.vy += (FLOAT_K * depth - FLOAT_C * c.vy) * dt;
      // a big belly-flop sinks it in and pops it back up: limit how far it can plunge
      if (depth > 0.7) c.y = water - draft - 0.7;
    } else c.vy -= GRAV * dt;
    c.y += c.vy * dt;
    c.air = !inWater && c.y > water - draft + 0.12;
  }

  // ---- landing
  if (wasAir && !c.air) {
    const sideways = Math.abs(Math.atan2(vl, Math.max(0.1, vf)));
    const spin = Math.abs(c.airYaw) > 5.2;
    let result: 'clean' | 'rough' | 'stuffed' | 'sideways';
    if (sideways > 0.65) result = 'sideways';
    else if (c.pitch < -0.42) result = 'stuffed';
    else if (Math.abs(c.pitch - slope) < 0.2) result = 'clean';
    else result = 'rough';
    const impact = -c.vy;
    if (result === 'sideways') {
      vf *= 0.45;
      vl *= 0.3;
      c.stunT = 0.9;
    } else if (result === 'stuffed') {
      vf *= 0.5;
      c.stunT = 0.7;
      c.pitchV -= 1.5;
    } else if (result === 'rough') vf *= 0.86;
    else vf *= 0.97;
    // the nose slaps down (or bounces up) and the hull plunges a little
    c.pitchV += -0.6 - Math.max(0, impact) * 0.05;
    ev.landed = { airT: c.airT, impact, result, spin };
    c.airT = 0;
    c.airYaw = 0;
  }
  if (c.air) {
    if (!wasAir && !ev.launched) ev.launched = c.vy;
    c.airT += dt;
  }

  // ---- along the nose: the jet (only with the intake in the water), brakes, drag
  const vmax = VMAX * (c.shallow ? SHALLOW_K : 1) * (c.boosting ? BOOST_K : 1);
  const thr = stunned ? c.throttle * 0.3 : c.throttle;
  const jet = !c.air;
  if (jet) {
    if (thr > 0) {
      if (vf < -0.5) vf += BRAKE * thr * dt;
      else vf += ACCEL * (c.boosting ? 1.6 : 1) * thr * Math.max(0, 1 - (vf / vmax) ** 2) * dt;
    } else if (thr < 0) {
      // the reverse bucket: brakes hard, then backs slowly
      if (vf > 0.5) vf = Math.max(0, vf + BRAKE * thr * dt);
      else vf = Math.max(-REV_MAX, vf + REV_ACC * thr * dt);
    }
    // the hull's drag: off the throttle a jet-ski slows quickly
    const coast = (thr <= 0.05 ? 0.7 + (0.006 + 0.004 * (1 - c.plane)) * vf * vf : 0) * dt;
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), coast);
    if (vf > vmax) vf -= (vf - vmax) * Math.min(1, (c.shallow ? 2.4 : 1.1) * dt);
  } else vf -= 0.0015 * vf * Math.abs(vf) * dt;

  // ---- steering: the nozzle turns the ski only while it pushes; in the air the rider can spin it
  c.steer += (c.steerIn - c.steer) * Math.min(1, dt * 8);
  let yaw: number;
  if (c.air) {
    yaw = c.steer * 4.6;
    c.airYaw += c.yawRate * dt;
  } else {
    const push = c.ramp >= 0 ? 0.25 : 0.32 + 0.68 * Math.max(0, thr);
    yaw = c.steer * yawMax(vf) * push * Math.sign(vf || 1);
  }
  c.yawRate += (yaw - c.yawRate) * Math.min(1, dt * (c.air ? 5 : 6));
  c.h += c.yawRate * dt;

  // ---- sideways: the hull's grip (none in the air: the ski keeps its momentum while it spins)
  if (!c.air) {
    const grip = stunned ? GRIP.stun : GRIP.low + (GRIP.plane - GRIP.low) * c.plane;
    vl *= Math.exp(-grip * dt);
  }
  // rebuild the velocity on the new heading (in the air, keep the old direction of travel)
  if (c.air) {
    c.vx = fx * vf + lx * vl;
    c.vz = fz * vf + lz * vl;
  } else {
    const nfx = -Math.sin(c.h);
    const nfz = -Math.cos(c.h);
    c.vx = nfx * vf + nfz * vl;
    c.vz = nfz * vf - nfx * vl;
  }
  c.x += c.vx * dt;
  c.z += c.vz * dt;

  // ---- up on the plane (from ~5 m/s, fully by 11 m/s)
  const planeWant = c.air ? c.plane : Math.min(1, Math.max(0, (vf - 5) / 6));
  c.plane += (planeWant - c.plane) * Math.min(1, dt * 1.8);

  // ---- pitch: the hull follows the water (bow up over the hump onto the plane, squatting under
  // power, dipping on the brakes); in the air the nose follows the flight path, and easing off
  // the throttle lifts it (the trick to a flat landing)
  if (c.ramp < 0) {
    let want: number;
    if (c.air) want = 0.55 * Math.atan2(c.vy, Math.max(4, Math.abs(vf))) + (c.throttle <= 0 ? 0.2 : 0) - (c.throttle > 0.5 ? 0.04 : 0);
    else {
      const hump = Math.sin(Math.PI * Math.min(1, c.plane * 1.4)) * 0.11 * Math.max(0, thr);
      want = Math.atan(slope) + hump + 0.02 * c.plane + (thr < 0 && vf > 2 ? -0.06 : 0);
    }
    const k = c.air ? 9 : 34;
    const d = c.air ? 6 : 9;
    c.pitchV += (k * (want - c.pitch) - d * c.pitchV) * dt;
    c.pitch += c.pitchV * dt;
  }

  // ---- lean into the turn (the lean a real rider holds against the sideways pull)
  if (!c.air) {
    const lat = vf * c.yawRate;
    const want = Math.max(-0.72, Math.min(0.72, Math.atan(lat / 9.81) * 0.9));
    c.roll += (want - c.roll) * Math.min(1, dt * 6);
  } else c.roll *= 1 - Math.min(1, dt * 1.5);
  return ev;
}

/** Puts a craft at rest on the water at (x, z) facing yaw h. */
export function placeCraft(c: Craft, x: number, z: number, h: number, water: number) {
  Object.assign(c, {
    x, z, h, vx: 0, vz: 0, y: water - DRAFT.low, vy: 0, pitch: 0, pitchV: 0, roll: 0, yawRate: 0, steer: 0, plane: 0,
    air: false, airT: 0, airYaw: 0, ramp: -1, boosting: false, burst: 0, stunT: 0, shallow: false, throttle: 0, steerIn: 0, wantBoost: false,
  });
}
