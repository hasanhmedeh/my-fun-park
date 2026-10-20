// The Beach Volley ball's flight, in the court's own frame (metres; the origin is the middle of the
// net on the sand, +z runs to the far court, +x to the court's left as the server sees it, y up).
// Pure numbers, no scene: the game, the AI players and the logic checks (scripts/volley-check.mjs)
// all fly the same ball.
//
// A beach volleyball is 260–280 g and 66–68 cm round, so drag matters (a 20 m/s serve loses a
// quarter of its speed crossing the court), topspin dips a jump serve into the court with the
// Magnus force, and a float serve (hit flat, no spin) wobbles from side to side. Every flight is
// stepped at a fixed 240 Hz by the same `stepCheck`, so a prediction (where a defender must be,
// when the timing meter is perfect) is exactly the flight that is then shown.

/** The ball's radius (m). */
export const BALL_R = 0.105;
/** The sand's surface in the court (raked up a little above the lawn). */
export const SAND_Y = 0.06;
/** The top of the net (men's height) and how deep the net hangs below its top tape. */
export const NET_TOP = 2.43;
export const NET_DEPTH = 1;
/** Half the court's width (x) and length (z): a 16 × 8 m beach court. */
export const HALF_W = 4;
export const HALF_L = 8;
/** The antennas stand on the net over the sidelines; a ball crossing outside them is out. */
export const ANTENNA_X = HALF_W + 0.05;
export const G = 9.81;
/** Fixed simulation step (s). */
export const STEP = 1 / 240;

/** Drag: ½ρ·Cd·A/m for a beach ball (Cd ≈ 0.33): the deceleration is DRAG·|v|². */
const DRAG = 0.0254;
/** Topspin lift: ½ρ·CL·A/m with CL ≈ 0.2 for a heavy jump-serve topspin. */
const MAGNUS = 0.0154;
/** A float serve's sideways wobble (m/s² at full speed) and how fast it swings. */
const FLOAT_A = 1.6;
const FLOAT_HZ = 1.25;

/** How the ball was struck: topspin (jump serves, spikes), a flat float, or a soft pass (drag too small to matter). */
export type Spin = 'top' | 'float' | 'soft';

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: Spin;
  /** Seconds since the ball was struck (drives the float's wobble, and the plans' contact times). */
  t: number;
  /** The float's wobble phase (random per serve). */
  phase: number;
}

export interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

export type Hit =
  | { kind: 'land'; t: number }
  | { kind: 'net'; t: number }
  | { kind: 'wide'; t: number }
  | { kind: 'target'; t: number; index: number }
  | { kind: 'height'; t: number };

export function ball(x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, spin: Spin = 'soft', phase = 0): Ball {
  return { x, y, z, vx, vy, vz, spin, t: 0, phase };
}

export function copyBall(from: Ball, to: Ball = ball()) {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.vx = from.vx;
  to.vy = from.vy;
  to.vz = from.vz;
  to.spin = from.spin;
  to.t = from.t;
  to.phase = from.phase;
  return to;
}

export function speedOf(b: Ball) {
  return Math.hypot(b.vx, b.vy, b.vz);
}

/** One fixed step: gravity, drag, the Magnus dip of topspin and a float's wobble (semi-implicit Euler). */
export function stepBall(b: Ball, dt = STEP) {
  const speed = Math.hypot(b.vx, b.vy, b.vz);
  let ax = 0;
  let ay = -G;
  let az = 0;
  if (b.spin !== 'soft' && speed > 0.01) {
    const d = DRAG * speed;
    ax -= d * b.vx;
    ay -= d * b.vy;
    az -= d * b.vz;
    const h = Math.hypot(b.vx, b.vz);
    if (h > 0.01) {
      // the unit spin axis for topspin: horizontal, square to the flight (for a ball flying +z it is +x)
      const wx = b.vz / h;
      const wz = -b.vx / h;
      if (b.spin === 'top') {
        // the Magnus force k·(ŵ × v): down and forward on the way up, down and back on the way down
        const k = MAGNUS * speed;
        ax += k * -wz * b.vy;
        ay += k * (wz * b.vx - wx * b.vz);
        az += k * wx * b.vy;
      } else {
        // a float: no spin, so the seams and the wake shove it sideways, back and forth
        const w = FLOAT_A * Math.sin(b.t * FLOAT_HZ * Math.PI * 2 + b.phase) * Math.min(1, speed / 14);
        ax += w * wx;
        az += w * wz;
      }
    }
  }
  b.vx += ax * dt;
  b.vy += ay * dt;
  b.vz += az * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  b.t += dt;
}

export interface FlyOptions {
  /** Stop when the ball comes down through this height (a dig or a set): the 'height' hit. */
  catchY?: number;
  /** Ignore the net (a pass that stays on its own side, or a prediction that only wants the landing). */
  noNet?: boolean;
  /** Spheres to test (the coconuts); null entries are skipped. */
  targets?: readonly (Sphere | null)[];
}

/**
 * One fixed step, then whatever happened during it: the ball met the net (or crossed outside an
 * antenna), touched a target sphere, came down through `catchY`, or reached the sand (where it
 * is left resting on top). Null when it is still flying.
 */
export function stepCheck(b: Ball, o: FlyOptions = {}): Hit | null {
  const pz = b.z;
  const py = b.y;
  stepBall(b);
  const t = b.t;
  if (!o.noNet && pz !== 0 && Math.sign(pz) !== Math.sign(b.z)) {
    // crossing the net's plane: between the antennas it must pass over the tape
    if (Math.abs(b.x) > ANTENNA_X) return { kind: 'wide', t };
    if (b.y - BALL_R < NET_TOP && b.y + BALL_R > NET_TOP - NET_DEPTH) return { kind: 'net', t };
  }
  if (o.targets)
    for (let i = 0; i < o.targets.length; i++) {
      const s = o.targets[i];
      if (s && (b.x - s.x) ** 2 + (b.y - s.y) ** 2 + (b.z - s.z) ** 2 < (s.r + BALL_R) ** 2) return { kind: 'target', t, index: i };
    }
  if (o.catchY !== undefined && b.vy < 0 && py >= o.catchY && b.y < o.catchY) return { kind: 'height', t };
  if (b.y <= SAND_Y + BALL_R) {
    b.y = SAND_Y + BALL_R;
    return { kind: 'land', t };
  }
  return null;
}

/**
 * Steps the ball until something happens (see `stepCheck`), for at most `maxT` seconds of flight.
 * The ball is left where it happened. Returns null if nothing did.
 */
export function fly(b: Ball, o: FlyOptions = {}, maxT = 6): Hit | null {
  const end = b.t + maxT;
  while (b.t < end) {
    const hit = stepCheck(b, o);
    if (hit) return hit;
  }
  return null;
}

const probe = ball();

/** The launch velocity along `yaw` (0 = +z, towards +x positive) at `elev` and `speed`, into `out`. */
function launch(out: Ball, x: number, y: number, z: number, yaw: number, elev: number, speed: number, spin: Spin, phase = 0) {
  const h = Math.cos(elev) * speed;
  out.x = x;
  out.y = y;
  out.z = z;
  out.vx = Math.sin(yaw) * h;
  out.vy = Math.sin(elev) * speed;
  out.vz = Math.cos(yaw) * h;
  out.spin = spin;
  out.t = 0;
  out.phase = phase;
  return out;
}

/**
 * The speed that carries a ball struck from (x, y, z) towards `yaw` at `elev` exactly `dist`
 * metres (horizontally) before it lands, found by bisection (the carry grows with speed).
 */
export function speedFor(x: number, y: number, z: number, yaw: number, elev: number, dist: number, spin: Spin) {
  let lo = 2;
  let hi = 42;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    fly(launch(probe, x, y, z, yaw, elev, mid, spin), { noNet: true });
    if (Math.hypot(probe.x - x, probe.z - z) < dist) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A ball struck from (x, y, z) to land `dist` along `yaw` at `elev`. */
export function strike(x: number, y: number, z: number, yaw: number, elev: number, dist: number, spin: Spin, phase = 0): Ball {
  return launch(ball(), x, y, z, yaw, elev, speedFor(x, y, z, yaw, elev, dist, spin), spin, phase);
}

/**
 * The height a ball is at when it has gone `dist` metres horizontally from where it was struck
 * (−Infinity if it comes down before it gets there).
 */
function heightAt(b: Ball, dist: number) {
  const x0 = b.x;
  const z0 = b.z;
  for (let i = 0; i < 2400; i++) {
    const py = b.y;
    const pd = Math.hypot(b.x - x0, b.z - z0);
    stepBall(b);
    const d = Math.hypot(b.x - x0, b.z - z0);
    if (d >= dist) return py + ((b.y - py) * (dist - pd)) / Math.max(1e-6, d - pd);
    if (b.y <= SAND_Y + BALL_R) return -Infinity;
  }
  return -Infinity;
}

/**
 * A ball struck from (x, y, z) at `elev` that passes through the point (tx, ty, tz) (a coconut
 * on its post): the speed is found by bisection on the height it has when it gets there.
 */
export function through(x: number, y: number, z: number, tx: number, ty: number, tz: number, elev: number, spin: Spin, phase = 0): Ball {
  const yaw = Math.atan2(tx - x, tz - z);
  const dist = Math.hypot(tx - x, tz - z);
  let lo = 2;
  let hi = 42;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(launch(probe, x, y, z, yaw, elev, mid, spin, phase), dist) < ty) lo = mid;
    else hi = mid;
  }
  return launch(ball(), x, y, z, yaw, elev, (lo + hi) / 2, spin, phase);
}

/** How far above the tape the ball's bottom passes when it crosses the net (−Infinity if it never gets there). */
export function clearance(b: Ball) {
  const s = copyBall(b, probe);
  for (let i = 0; i < 1200; i++) {
    const pz = s.z;
    stepBall(s);
    if (pz !== 0 && Math.sign(pz) !== Math.sign(s.z)) return s.y - BALL_R - NET_TOP;
    if (s.y <= SAND_Y + BALL_R) return -Infinity;
  }
  return -Infinity;
}

/**
 * An attack (a spike or a serve) from (x, y, z) to land at (tx, tz): the flattest of `elevs`
 * (ascending) that still clears the net with `margin` to spare, since a real hitter hits as flat
 * as the net allows, and that carries that far at all (too flat and even the bisection's top speed
 * comes down short). Falls back to the loftiest.
 */
export function attack(x: number, y: number, z: number, tx: number, tz: number, spin: Spin, elevs: readonly number[], margin = 0.15, phase = 0): Ball {
  const yaw = Math.atan2(tx - x, tz - z);
  const dist = Math.hypot(tx - x, tz - z);
  let best: Ball | null = null;
  for (const e of elevs) {
    best = strike(x, y, z, yaw, e, dist, spin, phase);
    if (clearance(best) >= margin && speedOf(best) < 41) return best;
  }
  return best!;
}

/**
 * Like `attack`, but through a point in the air (a coconut) instead of onto the sand. Too flat
 * and even the hardest strike (the bisection's top speed) dips under the point, so those are
 * skipped too.
 */
export function attackThrough(x: number, y: number, z: number, tx: number, ty: number, tz: number, spin: Spin, elevs: readonly number[], margin = 0.15, phase = 0): Ball {
  let best: Ball | null = null;
  for (const e of elevs) {
    best = through(x, y, z, tx, ty, tz, e, spin, phase);
    if (clearance(best) >= margin && speedOf(best) < 41) return best;
  }
  return best!;
}

/**
 * A soft, drag-free lob from one point that comes down through `to` (its height on the way
 * down) after topping out at `apex`: a dig, a set, a free ball. Returns the ball and its time.
 */
export function lob(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, apex: number) {
  const top = Math.max(apex, from.y + 0.2, to.y + 0.2);
  const vy = Math.sqrt(2 * G * (top - from.y));
  const t = vy / G + Math.sqrt((2 * (top - to.y)) / G);
  return { b: ball(from.x, from.y, from.z, (to.x - from.x) / t, vy, (to.z - from.z) / t, 'soft'), t };
}

/** True when (x, z) is in the court on the side `side` (+1 the far side, −1 the near one); the lines are in. */
export function inCourt(x: number, z: number, side: number) {
  return Math.abs(x) <= HALF_W + BALL_R && z * side >= 0 && z * side <= HALF_L + BALL_R;
}

/**
 * Predicts a flight on a copy: what ends it (the first hit with `o`), when (in the ball's own
 * time, `b.t` included) and where the ball is then.
 */
export function predict(b: Ball, o: FlyOptions = {}, out: Ball = ball()) {
  copyBall(b, out);
  const hit = fly(out, o);
  return { hit, at: out };
}
