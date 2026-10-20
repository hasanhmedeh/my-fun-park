// The Jet-Ski Race's rules and its rivals' riding, as pure maths over the course and the craft
// physics (no scene, no DOM), so scripts/jetski-check.mjs can run whole races in node: where each
// ski is on the course, its laps and the buoy gates it passes or misses, the wakes the skis leave
// (and the bumps they give whoever crosses them), the ramps, the skis shoving each other apart,
// the course's edges, and the rivals' controls (a speed profile from the course's curvature, a
// lane round the others and the ramps, and a flat landing off every jump).

import { COURSE, GATES, GATE_HALF, LAPS, RAMPS, SHALLOWS, START_S, WALL, coursePoint, deltaS, locate, onRamp, rampLift, wrapS } from './jetski-course';
import { BOOST_K, forwardSpeed, newCraft, placeCraft, stepCraft, VMAX, yawMax, type Craft, type StepEvents } from './jetski-physics';

/** Seconds added to your race time for each buoy gate missed. */
export const MISS_PENALTY = 3;
/** A ski's collision radius. */
export const SKI_R = 1.25;
/**
 * The rivals' cornering margin: the share of the nozzle's full yaw they plan a bend for. They hold
 * most of the throttle on through it (the nozzle steers only as hard as it pushes: 0.92 of its
 * full yaw there), and keep the rest in hand for the slide and for correcting the line.
 */
const AI_TURN = 0.55;
const AI_BRAKE = 5.5;
/** Wake samples per ski (one every WAKE_DT seconds: about four seconds of wake). */
export const WAKE_N = 36;
export const WAKE_DT = 0.12;
/** How fast a wake's arms spread sideways, as a share of the ski's speed (a Kelvin wedge's ~19°). */
export const WAKE_SPREAD = 0.34;
/** How long a wake lasts (s). */
export const WAKE_LIFE = WAKE_N * WAKE_DT;
const SURF_TRICKLE = 0.012;

/** A wake as a ring of samples: where the stern was, which way it pointed, how fast, and when. */
export interface Wake {
  x: Float32Array;
  z: Float32Array;
  /** The stern's left unit vector, the ski's speed (m/s) and the time each sample was laid. */
  lx: Float32Array;
  lz: Float32Array;
  v: Float32Array;
  t: Float32Array;
  /** The newest sample's index, and the time of the next one. */
  head: number;
  next: number;
}

export function newWake(): Wake {
  const f = () => new Float32Array(WAKE_N);
  const w = { x: f(), z: f(), lx: f(), lz: f(), v: f(), t: f(), head: 0, next: 0 };
  w.t.fill(-1e9);
  return w;
}

export interface Racer {
  name: string;
  color: string;
  c: Craft;
  /** Nearest course sample, arc length and lateral offset (positive = left). */
  i: number;
  s: number;
  d: number;
  /** Metres past the start line, counting every lap (negative on the grid; −1e9 when not racing). */
  prog: number;
  laps: number;
  lapStart: number;
  bestLap: number;
  /** Race time at the line, penalties included (null until then). */
  finished: number | null;
  /** The next gate to pass (an index into GATES) and the progress at which it's due. */
  gate: number;
  gateAt: number;
  missed: number;
  penalty: number;
  jumps: number;
  /** Seconds going the wrong way (negative: recently nagged). */
  wrongT: number;
  /** A rival's pace (a share of the profile), its favourite lane and the lane it's steering for. */
  skill: number;
  pref: number;
  lane: number;
  /** Whether this rival goes for the ramps. */
  jumper: boolean;
  /** Seconds before another wake can kick this ski up. */
  kickT: number;
  wake: Wake;
}

export function newRacer(name: string, color: string, skill: number, jumper: boolean): Racer {
  return {
    name, color, c: newCraft(), i: 0, s: 0, d: 0, prog: -1e9, laps: 0, lapStart: 0, bestLap: 0, finished: null, gate: 0, gateAt: 0,
    missed: 0, penalty: 0, jumps: 0, wrongT: 0, skill, pref: 0, lane: 0, jumper, kickT: 0, wake: newWake(),
  };
}

/** The offset of gate j from the start line, along the course. */
export const gateOffset = (j: number) => wrapS(GATES[j].s - START_S);

/** The five grid slots, side by side just behind the line (slot 0 nearest the dock, on the left). */
export function gridSlot(j: number) {
  return { s: START_S - 6, d: 7.2 - j * 3.6 };
}

/** Puts a racer on its grid slot, at rest, ready for the lights. */
export function toGrid(r: Racer, slot: number, water: (x: number, z: number) => number) {
  const g = gridSlot(slot);
  const p = coursePoint(g.s, g.d);
  placeCraft(r.c, p.x, p.z, Math.atan2(-p.tx, -p.tz), water(p.x, p.z));
  r.c.surf = 0.25;
  Object.assign(r, { prog: g.s - START_S, laps: 0, lapStart: 0, bestLap: 0, finished: null, gate: 1, gateAt: gateOffset(1), missed: 0, penalty: 0, jumps: 0, wrongT: 0, pref: g.d * 0.5, lane: g.d, kickT: 0 });
  const at = locate(r.c.x, r.c.z);
  r.i = at.i;
  r.s = at.s;
  r.d = at.d;
  r.wake.t.fill(-1e9);
}

/** Starts a racer off on a ghost lap (no lap counting) from arc length s. */
export function toGhost(r: Racer, s: number, d: number, water: (x: number, z: number) => number) {
  const p = coursePoint(s, d);
  placeCraft(r.c, p.x, p.z, Math.atan2(-p.tx, -p.tz), water(p.x, p.z));
  const c = r.c;
  c.vx = p.tx * VMAX * 0.7 * r.skill;
  c.vz = p.tz * VMAX * 0.7 * r.skill;
  c.plane = 1;
  Object.assign(r, { prog: -1e9, finished: null, pref: d * 0.6, lane: d });
  const at = locate(c.x, c.z);
  r.i = at.i;
  r.s = at.s;
  r.d = at.d;
}

// ------------------------------------------------------------------------------------------------
// The rivals
// ------------------------------------------------------------------------------------------------

/** The speed a ski can carry round a bend of curvature k (from the nozzle's yaw limit). */
function cornerSpeed(k: number) {
  let lo = 2;
  let hi = VMAX;
  for (let n = 0; n < 24; n++) {
    const v = (lo + hi) / 2;
    if (v * Math.abs(k) <= AI_TURN * yawMax(v)) lo = v;
    else hi = v;
  }
  return lo;
}

/** Target speed round the course for a rival of skill 1 (from the curvature, with braking zones). */
export const PROFILE = (() => {
  const C = COURSE;
  const v = new Float32Array(C.n);
  for (let i = 0; i < C.n; i++) {
    // the tightest bend just ahead sets the speed (skis slide wide, so look a few metres on)
    let k = 0;
    for (let q = -2; q <= 6; q++) k = Math.max(k, Math.abs(C.k[(i + q + C.n) % C.n]));
    v[i] = cornerSpeed(k);
  }
  for (let pass = 0; pass < 2; pass++)
    for (let q = C.n - 1; q >= 0; q--) {
      const next = v[(q + 1) % C.n];
      v[q] = Math.min(v[q], Math.sqrt(next * next + 2 * AI_BRAKE * C.ds));
    }
  return v;
})();

const profileAt = (s: number) => PROFILE[Math.floor(wrapS(s) / COURSE.ds) % COURSE.n];

/**
 * A rival's (or the autopilot's) controls: a lane (its favourite, round the ski ahead, onto or
 * past a ramp), pure pursuit to a point up the course in that lane, and the profile's pace.
 * `rubber` scales the pace (a touch of rubber band in a race: 1 when not racing).
 */
export function aiControls(r: Racer, all: readonly Racer[], dt: number, rubber = 1) {
  const c = r.c;
  const v = forwardSpeed(c);
  let lane = r.pref;
  let caution = 1;
  let lining = false;
  // a ramp coming up: line up with it (a jumper), or keep well clear of it
  for (const rp of RAMPS) {
    const ahead = deltaS(r.s, rp.s);
    if (ahead < -rp.len || ahead > 70) continue;
    const clear = rp.width / 2 + SKI_R + 1.2;
    if (r.jumper && r.finished === null) {
      lane = rp.d;
      // committed to the jump in the last stretch: no swerving round anyone now
      lining = ahead < 35;
    }
    else if (Math.abs(lane - rp.d) < clear) lane = rp.d + (lane >= rp.d ? clear : -clear);
  }
  // a slower ski just ahead in the lane: go round it on the side with more room
  for (const o of all) {
    if (lining || o === r || o.c.air) continue;
    const ahead = deltaS(r.s, o.s);
    if (ahead < 0 || ahead > 14) continue;
    if (Math.abs(o.d - lane) > 2.6) continue;
    const side = o.d > 0 ? -1 : 1;
    lane = o.d + side * 3.2;
    if (ahead < 6 && forwardSpeed(o.c) < v - 1) caution = Math.min(caution, 0.92);
  }
  lane = Math.max(-GATE_HALF + 2, Math.min(GATE_HALF - 2, lane));
  r.lane += (lane - r.lane) * Math.min(1, dt * (lining ? 5 : 2.5));

  // pure pursuit: a point a little way up the course, in the chosen lane
  const ld = 7 + Math.abs(v) * 0.5;
  const p = coursePoint(r.s + ld, r.lane);
  const fx = -Math.sin(c.h);
  const fz = -Math.cos(c.h);
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  const fwd = dx * fx + dz * fz;
  const left = dx * fz - dz * fx;
  const alpha = Math.atan2(left, fwd);
  const omega = (Math.max(v, 3) * 2 * Math.sin(alpha)) / ld;
  c.steerIn = Math.max(-1, Math.min(1, omega / Math.max(0.2, yawMax(Math.max(v, 3)))));

  // pace: the profile a little way ahead, scaled by skill
  let pace = r.skill * caution * rubber;
  if (r.finished !== null) pace *= 0.55;
  const target = Math.min(profileAt(r.s + Math.max(0, v) * 0.5), profileAt(r.s + Math.max(0, v) * 1.2) + 1.5) * pace;
  if (c.air) {
    // off the throttle and the bars straight in the air: the nose comes up, the ski lands flat
    c.throttle = 0;
    c.steerIn = 0;
  } else {
    c.throttle = v < target - 0.3 ? 1 : v > target + 2.5 ? -1 : v > target + 1 ? 0.45 : 0.85;
    // the nozzle only steers while it pushes: on full lock and not too fast, power through it
    if (Math.abs(c.steerIn) > 0.9 && v < target + 3) c.throttle = 1;
  }
  // the surf boost on the straights, once up to speed
  const straight = profileAt(r.s + 30) >= VMAX * 0.97 && profileAt(r.s + 60) >= VMAX * 0.9;
  c.wantBoost = straight && v > VMAX * 0.85 * pace && c.surf > 0.3 && r.finished === null;
  c.wantHop = false;
}

// ------------------------------------------------------------------------------------------------
// One step of the race
// ------------------------------------------------------------------------------------------------

/** What the step did that the race wants to tell the rider about (shared object, reset each call). */
export interface RaceEvents {
  physics: StepEvents;
  /** A gate passed (true) or missed (false) this step: its index. */
  gate: { j: number; ok: boolean } | null;
  /** A lap completed this step: its time. */
  lap: number | null;
  /** Crossed the line for the last time. */
  finished: boolean;
  /** Bumped into the course's edge, a ramp's side or another ski, this hard (m/s). */
  bump: number;
  /** Kicked up by a wake. */
  wakeKick: boolean;
}

const rev: RaceEvents = { physics: { launched: 0, landed: null }, gate: null, lap: null, finished: false, bump: 0, wakeKick: false };
const at = { i: 0, s: 0, d: 0 };
const rp = { along: 0, across: 0 };

/**
 * One physics step for one racer: the ramps it rides onto (or bounces off), the wakes it crosses,
 * the craft's physics on the water at `water(x, z)`, the course's edges, then where it is now:
 * laps, gates and the wrong way. `raceT` is the race clock (penalties are added at the line);
 * `counting` is false on ghost laps.
 */
export function stepRacer(r: Racer, all: readonly Racer[], dt: number, t: number, raceT: number, counting: boolean, water: (x: number, z: number) => number): RaceEvents {
  const c = r.c;
  rev.gate = null;
  rev.lap = null;
  rev.finished = false;
  rev.bump = 0;
  rev.wakeKick = false;

  // ---- the ramps: up the slope from its foot; anything else bounces off its sides
  if (c.ramp < 0)
    for (let k = 0; k < RAMPS.length; k++) {
      const ramp = RAMPS[k];
      onRamp(ramp, c.x, c.z, rp);
      if (rp.along < -1 || rp.along > ramp.len + 0.5 || Math.abs(rp.across) > ramp.width / 2 + 0.9) continue;
      const deck = rampLift(ramp, Math.max(0, Math.min(ramp.len, rp.along)));
      const surface = water(c.x, c.z);
      if (c.y > surface + deck + 0.05) continue; // flying over it
      const vf = c.vx * ramp.ux + c.vz * ramp.uz;
      if (rp.along < 0.9 && Math.abs(rp.across) <= ramp.width / 2 && vf > 1) {
        c.ramp = k;
        break;
      }
      if (rp.along < 0) continue;
      // into its side (or its back): pushed out the shortest way, bounced
      const outSide = ramp.width / 2 + 0.9 - Math.abs(rp.across);
      const outBack = ramp.len + 0.5 - rp.along;
      const lx = ramp.uz;
      const lz = -ramp.ux;
      let nx: number;
      let nz: number;
      let pen: number;
      if (outSide < outBack) {
        const side = Math.sign(rp.across) || 1;
        nx = lx * side;
        nz = lz * side;
        pen = outSide;
      } else {
        nx = ramp.ux;
        nz = ramp.uz;
        pen = outBack;
      }
      c.x += nx * pen;
      c.z += nz * pen;
      const vn = c.vx * nx + c.vz * nz;
      if (vn < 0) {
        c.vx -= nx * vn * 1.4;
        c.vz -= nz * vn * 1.4;
        rev.bump = Math.max(rev.bump, -vn);
        if (-vn > 5) c.stunT = Math.max(c.stunT, 0.6);
      }
    }

  // ---- the others' wakes: crossing an arm at speed bounces the ski up
  if (r.kickT > 0) r.kickT -= dt;
  else if (!c.air && c.ramp < 0) {
    const sp = Math.hypot(c.vx, c.vz);
    if (sp > 9)
      for (const o of all) {
        if (o === r) continue;
        const k = wakeKick(o.wake, c, sp, t);
        if (k <= 0) continue;
        c.vy += k;
        r.kickT = 0.45;
        rev.wakeKick = true;
        break;
      }
  }

  // ---- the craft on the water (its nose and tail heights give the surface's slope)
  const fx = -Math.sin(c.h);
  const fz = -Math.cos(c.h);
  const w = water(c.x, c.z);
  const slope = (water(c.x + fx * 1.4, c.z + fz * 1.4) - water(c.x - fx * 1.4, c.z - fz * 1.4)) / 2.8;
  c.shallow = Math.abs(r.d) > SHALLOWS;
  rev.physics = stepCraft(c, dt, w, slope, RAMPS);
  // the surf meter: filled by air (more for a long one, nothing for a botched landing, a bonus
  // for a full spin), and a slow trickle
  const landed = rev.physics.landed;
  if (landed) {
    if (landed.airT > 0.5 && counting) r.jumps++;
    const gain = landed.result === 'clean' ? 1 : landed.result === 'rough' ? 0.5 : 0;
    c.surf = Math.min(1, c.surf + gain * Math.min(0.45, 0.08 + landed.airT * 0.22) + (landed.spin && gain ? 0.3 : 0));
  }
  c.surf = Math.min(1, c.surf + SURF_TRICKLE * dt);

  // ---- the course's edge: a soft rope of floats; ride into it and it turns you back
  locate(c.x, c.z, r.i, 8, at);
  const lim = WALL - 1.2;
  if (Math.abs(at.d) > lim) {
    const side = Math.sign(at.d);
    const C = COURSE;
    const nx = C.tz[at.i] * side; // outward
    const nz = -C.tx[at.i] * side;
    const pen = Math.abs(at.d) - lim;
    c.x -= nx * pen;
    c.z -= nz * pen;
    const vn = c.vx * nx + c.vz * nz;
    if (vn > 0) {
      c.vx -= nx * vn * 1.5;
      c.vz -= nz * vn * 1.5;
      rev.bump = Math.max(rev.bump, vn);
    }
  }

  // ---- the wake: a sample every WAKE_DT while the hull's in the water and moving
  const wk = r.wake;
  if (t >= wk.next) {
    wk.next = t + WAKE_DT;
    const sp = Math.hypot(c.vx, c.vz);
    if (!c.air && sp > 1.5) {
      wk.head = (wk.head + 1) % WAKE_N;
      const h = wk.head;
      wk.x[h] = c.x - fx * 1.5;
      wk.z[h] = c.z - fz * 1.5;
      wk.lx[h] = fz;
      wk.lz[h] = -fx;
      wk.v[h] = sp;
      wk.t[h] = t;
    }
  }

  // ---- where it is now: progress, laps, gates, the wrong way
  track(r, raceT, counting, dt);
  return rev;
}

/**
 * The upward kick (m/s) a ski crossing one of this wake's arms gets, or 0. Each arm is the line of
 * points a sample's stern left, spread sideways by WAKE_SPREAD × its speed × its age; the kick
 * grows with the wake-maker's speed and the crosser's, and dies away as the wake fades.
 */
export function wakeKick(w: Wake, c: Craft, sp: number, t: number) {
  for (let q = 0; q < WAKE_N; q++) {
    const age = t - w.t[q];
    if (age < 0.5 || age > WAKE_LIFE * 0.8 || w.v[q] < 8) continue;
    const spread = WAKE_SPREAD * w.v[q] * age;
    for (const side of [-1, 1]) {
      const ax = w.x[q] + w.lx[q] * spread * side;
      const az = w.z[q] + w.lz[q] * spread * side;
      if (Math.abs(ax - c.x) > 0.9 || Math.abs(az - c.z) > 0.9) continue;
      // only when crossing it: the ski's course across the arm, not along it
      const across = Math.abs((c.vx * w.lx[q] + c.vz * w.lz[q]) / sp);
      if (across < 0.3) continue;
      const fade = 1 - age / WAKE_LIFE;
      return (0.6 + 0.09 * w.v[q] + 0.05 * sp) * fade * (0.6 + 0.4 * across);
    }
  }
  return 0;
}

function track(r: Racer, raceT: number, counting: boolean, dt: number) {
  const prevS = r.s;
  locate(r.c.x, r.c.z, r.i, 8, at);
  r.i = at.i;
  r.s = at.s;
  r.d = at.d;
  if (!counting || r.prog < -1e8 || r.finished !== null) return;
  r.prog += deltaS(prevS, r.s);
  // the gates, in order: passed between the buoys, or missed
  const L = COURSE.length;
  while (r.prog >= r.gateAt) {
    const ok = Math.abs(r.d) <= GATE_HALF + 0.4;
    if (!ok) {
      r.missed++;
      r.penalty += MISS_PENALTY;
    }
    rev.gate = { j: r.gate, ok };
    const lapBase = r.gateAt - gateOffset(r.gate);
    r.gate = (r.gate + 1) % GATES.length;
    r.gateAt = lapBase + (r.gate === 0 ? L : 0) + gateOffset(r.gate);
  }
  const done = Math.floor(r.prog / L);
  if (done > r.laps) {
    r.laps = done;
    const lap = raceT - r.lapStart;
    r.lapStart = raceT;
    if (!r.bestLap || lap < r.bestLap) r.bestLap = lap;
    rev.lap = lap;
    if (r.laps >= LAPS) {
      r.finished = raceT + r.penalty;
      rev.finished = true;
    }
  }
  const C = COURSE;
  const along = r.c.vx * C.tx[r.i] + r.c.vz * C.tz[r.i];
  r.wrongT = along < -2 ? r.wrongT + dt : Math.min(0, r.wrongT + dt);
}

/** Skis shove each other apart (a mostly inelastic nudge); returns the hardest knock involving `me`. */
export function collideRacers(rs: readonly Racer[], me: Racer | null) {
  let hardest = 0;
  for (let a = 0; a < rs.length; a++)
    for (let b = a + 1; b < rs.length; b++) {
      const A = rs[a].c;
      const B = rs[b].c;
      if (Math.abs(A.y - B.y) > 1) continue; // one flying over the other
      const dx = A.x - B.x;
      const dz = A.z - B.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 4 * SKI_R * SKI_R || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      const pen = 2 * SKI_R - d;
      A.x += nx * pen * 0.5;
      A.z += nz * pen * 0.5;
      B.x -= nx * pen * 0.5;
      B.z -= nz * pen * 0.5;
      const rel = (A.vx - B.vx) * nx + (A.vz - B.vz) * nz;
      if (rel >= 0) continue;
      const j = (-(1 + 0.25) * rel) / 2;
      A.vx += nx * j;
      A.vz += nz * j;
      B.vx -= nx * j;
      B.vz -= nz * j;
      if (rs[a] === me || rs[b] === me) hardest = Math.max(hardest, -rel);
    }
  return hardest;
}

/** Who's ahead: finishers by time, then everyone by distance covered. */
export function standings(rs: readonly Racer[]) {
  return [...rs].sort((a, b) => {
    if (a.finished !== null || b.finished !== null) return (a.finished ?? Infinity) - (b.finished ?? Infinity);
    return b.prog - a.prog;
  });
}

/** Top speed with the surf boost, for the speedo's scale and the camera's widening. */
export const VTOP = VMAX * BOOST_K;
