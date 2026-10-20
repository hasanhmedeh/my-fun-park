// The Beach Volley ball's flight, in the court's own frame (metres; the origin is the middle of the
// net on the sand, +z runs south to the far court, +x east, y up). Pure numbers, no scene: the
// game, the AI and the logic checks (scripts/volley-check.mjs) all fly the same ball.
//
// A beach volleyball is 260–280 g and 66–68 cm round, so drag matters (a 20 m/s serve loses a
// quarter of its speed crossing the court), topspin dips a jump serve into the court with the
// Magnus force, and a float serve (hit flat, no spin) wobbles from side to side. Every flight is
// stepped at a fixed 240 Hz, so the prediction the defenders read is exactly the flight you see.

/** The ball's radius (m). */
export const BALL_R = 0.105;
/** The sand's surface in the court (it is raked up a little above the lawn). */
export const SAND_Y = 0.06;
/** The top of the net (men's height) and the net's depth below it. */
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
/** A float serve's sideways wobble (m/s²) and how fast it swings. */
const FLOAT_A = 1.6;
const FLOAT_HZ = 1.25;

/** How the ball was struck: topspin (jump serves, spikes), a flat float, or a soft pass (no drag worth modelling). */
export type Spin = 'top' | 'float' | 'soft';

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: Spin;
  /** Seconds since the ball was struck (drives the float's wobble). */
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

export function ball(x: number, y: number, z: number, vx: number, vy: number, vz: number, spin: Spin, phase = 0): Ball {
  return { x, y, z, vx, vy, vz, spin, t: 0, phase };
}

export function copyBall(from: Ball, to: Ball = ball(0, 0, 0, 0, 0, 0, 'soft')) {
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
      if (b.spin === 'top') {
        // spin axis = up × v̂ (horizontal, to the ball's left); the force ω × v points down and back along the arc
        const sx = b.vz / h;
        const sz = -b.vx / h;
        const k = MAGNUS * speed;
        ax += k * (sz * b.vy - 0);
        ay += k * (sz * -b.vx - sx * b.vz) * -1 * -1;
        az += k * (0 - sx * b.vy);
        // (written out: ω̂ × v with ω̂ = (sx, 0, sz))
      } else {
        // a float: no spin, so the seams and the wake shove it sideways, back and forth
        const w = FLOAT_A * Math.sin(b.t * FLOAT_HZ * Math.PI * 2 + b.phase) * Math.min(1, speed / 14);
        ax += (w * b.vz) / h;
        az -= (w * b.vx) / h;
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
  /** Stop when the ball comes down through this height (a dig or a set); the 'height' hit. */
  catchY?: number;
  /** Ignore the net (a pass that stays on its own side, or a prediction that only wants the landing). */
  noNet?: boolean;
  /** Spheres to test (the coconuts). */
  targets?: readonly (Sphere | null)[];
  /** Give up after this long. */
  maxT?: number;
}

/**
 * Steps the ball until something happens: it lands on the sand, meets the net (or crosses
 * outside an antenna), touches a target sphere, or comes down through `catchY`. The ball is left
 * where it happened. Returns null if nothing did within `maxT`.
 */
export function fly(b: Ball, o: FlyOptions = {}): Hit | null {
  const maxT = o.maxT ?? 6;
  let t = 0;
  while (t < maxT) {
    const pz = b.z;
    const py = b.y;
    stepBall(b);
    t += STEP;
    if (!o.noNet && Math.sign(pz) !== Math.sign(b.z) && pz !== 0) {
      // crossing the net's plane: between the antennas it must pass over the tape
      if (Math.abs(b.x) > ANTENNA_X) return { kind: 'wide', t };
      if (b.y - BALL_R < NET_TOP && b.y + BALL_R > NET_TOP - NET_DEPTH) return { kind: 'net', t };
      if (b.y + BALL_R <= NET_TOP - NET_DEPTH) return { kind: 'net', t };
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
  }
  return null;
}

/** Where a ball struck from (x, y, z) towards `yaw` (0 = +z) at `elev` and `speed` first touches the sand, ignoring the net. */
export function landing(x: number, y: number, z: number, yaw: number, elev: number, speed: number, spin: Spin, out = ball(0, 0, 0, 0, 0, 0, 'soft')) {
  const h = Math.cos(elev) * speed;
  out.x = x;
  out.y = y;
  out.z = z;
  out.vx = Math.sin(yaw) * h;
  out.vy = Math.sin(elev) * speed;
  out.vz = Math.cos(yaw) * h;
  out.spin = spin;
  out.t = 0;
  out.phase = 0;
  fly(out, { noNet: true });
  return out;
}

const probe = ball(0, 0, 0, 0, 0, 0, 'soft');

/**
 * The speed that carries a ball struck from (x, y, z) towards `yaw` at `elev` exactly `dist`
 * metres (horizontally) before it lands, found by bisection (the carry grows with speed).
 */
export function speedFor(x: number, y: number, z: number, yaw: number, elev: number, dist: number, spin: Spin) {
  let lo = 2;
  let hi = 40;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    landing(x, y, z, yaw, elev, mid, spin, probe);
    if (Math.hypot(probe.x - x, probe.z - z) < dist) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Launch velocity for a ball struck from (x, y, z) to land `dist` along `yaw` at `elev`. */
export function strike(x: number, y: number, z: number, yaw: number, elev: number, dist: number, spin: Spin, phase = 0): Ball {
  const s = speedFor(x, y, z, yaw, elev, dist, spin);
  const h = Math.cos(elev) * s;
  return ball(x, y, z, Math.sin(yaw) * h, Math.sin(elev) * s, Math.cos(yaw) * h, spin, phase);
}

/**
 * An attack (a spike or a serve) from (x, y, z) to land at (tx, tz): the flattest of a few
 * elevations that still clears the net with `margin` to spare (a real hitter hits as flat as the
 * net allows). Falls back to the loftiest if none clears.
 */
export function attack(x: number, y: number, z: number, tx: number, tz: number, spin: Spin, elevs: readonly number[], margin = 0.15, phase = 0): Ball {
  const yaw = Math.atan2(tx - x, tz - z);
  const dist = Math.hypot(tx - x, tz - z);
  let best: Ball | null = null;
  for (const e of elevs) {
    const b = strike(x, y, z, yaw, e, dist, spin, phase);
    best = b;
    if (clearance(b) >= margin) return b;
  }
  return best!;
}

/** How far above the tape the ball's bottom passes when it crosses the net (−Infinity if it never gets there). */
export function clearance(b: Ball) {
  const s = copyBall(b, probe);
  let t = 0;
  while (t < 4) {
    const pz = s.z;
    stepBall(s);
    t += STEP;
    if (Math.sign(pz) !== Math.sign(s.z) && pz !== 0) return s.y - BALL_R - NET_TOP;
    if (s.y <= SAND_Y + BALL_R) return -Infinity;
  }
  return -Infinity;
}

/**
 * A soft, drag-free lob from one point to another that tops out at `apex` (a dig, a set): its
 * velocity and how long it takes. The ball comes down through the target's height at the end.
 */
export function lob(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, apex: number) {
  const top = Math.max(apex, from.y + 0.2, to.y + 0.2);
  const vy = Math.sqrt(2 * G * (top - from.y));
  const t = vy / G + Math.sqrt((2 * (top - to.y)) / G);
  return { b: ball(from.x, from.y, from.z, (to.x - from.x) / t, vy, (to.z - from.z) / t, 'soft'), t };
}

/** Where a soft ball is after `t` seconds (exact, for the timing ring). */
export function lobAt(b: Ball, t: number, out: { x: number; y: number; z: number }) {
  out.x = b.x + b.vx * t;
  out.y = b.y + b.vy * t - 0.5 * G * t * t;
  out.z = b.z + b.vz * t;
  return out;
}

/** True when (x, z) is in the court on the side `side` (+1 the far, south side; −1 the near one); the lines are in. */
export function inCourt(x: number, z: number, side: number) {
  return Math.abs(x) <= HALF_W + BALL_R && z * side >= 0 && z * side <= HALF_L + BALL_R;
}
