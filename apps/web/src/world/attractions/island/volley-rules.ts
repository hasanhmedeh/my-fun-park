// Beach Volley's rules and judgement, as pure numbers so the logic checks can run them in node:
// how a press on the timing meter is graded, what that does to the shot, where the scoring rings
// go, how many points a rally is worth, and whether a defender gets to the ball and digs it.

import { HALF_L, HALF_W, NET_TOP } from './volley-ball';

/** A round (one ticket) is this many serves, each played out as a rally. */
export const SERVES = 10;
/** A coconut knocked off the shy. */
export const COCONUT_POINTS = 5;

/** How well a press on the meter was timed. */
export type Grade = 'perfect' | 'good' | 'ok' | 'miss';
/** The grades' windows: how far (s) from the perfect moment each still counts. */
export const TOLERANCE = { perfect: 0.05, good: 0.11, ok: 0.2 };

/** The grade for a press `err` seconds from the perfect moment (late is positive). `scale` < 1 tightens it (a dive). */
export function grade(err: number, scale = 1): Grade {
  const e = Math.abs(err) / scale;
  return e <= TOLERANCE.perfect ? 'perfect' : e <= TOLERANCE.good ? 'good' : e <= TOLERANCE.ok ? 'ok' : 'miss';
}

/** The elevations an attack may take (ascending, see `attack` in volley-ball.ts): the flattest that clears is used. */
export const ELEVS = {
  /** A topspin jump serve, hit from above the head. */
  jumpServe: [-0.04, 0.02, 0.08, 0.14, 0.2, 0.27, 0.34, 0.42, 0.5, 0.6, 0.7, 0.8],
  /** A float serve: flatter-faced, a little loftier. */
  floatServe: [0.1, 0.16, 0.22, 0.3, 0.38, 0.48, 0.6],
  /** A spike from above the net: steeply down. */
  spike: [-0.55, -0.45, -0.35, -0.25, -0.15, -0.05, 0.05, 0.15],
  /** A soft roll shot over the block. */
  roll: [0.45, 0.6, 0.75, 0.9],
  /** At a coconut on its post (the flattest the hitter can still reach it with). */
  coconut: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5],
};

/**
 * What the timing does to a serve or a spike aimed at (tx, tz): perfect and good keep the
 * topspin (perfect is dead on, good wanders a little); ok has to play safe (a float serve, or a
 * roll shot instead of a spike) and lands short or long by the error; a miss is mishit — early
 * into the net (`ty`: the shot is struck through that height just past the net, i.e. into the
 * mesh), late long and out. `rnd` gives the scatter.
 */
export function shot(g: Grade, err: number, tx: number, tz: number, kind: 'serve' | 'spike', rnd: () => number) {
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.82;
  const sigma = g === 'perfect' ? 0.15 : g === 'good' ? 0.45 : g === 'ok' ? 0.8 : 1.2;
  let x = tx + gauss() * sigma;
  let z = tz + gauss() * sigma + (g === 'perfect' ? 0 : err * (g === 'good' ? 5 : 9));
  let ty: number | null = null;
  if (g === 'miss') {
    // early: struck too low, into the net; late: struck on the way down, long
    if (err < 0) {
      z = 0.25;
      ty = NET_TOP - 0.3 - rnd() * 0.5;
    } else z = HALF_L + 1.5 + rnd() * 2.5;
  }
  const spin: 'top' | 'float' = g === 'ok' && kind === 'serve' ? 'float' : 'top';
  const elevs = kind === 'serve' ? (spin === 'float' ? ELEVS.floatServe : ELEVS.jumpServe) : g === 'ok' ? ELEVS.roll : ELEVS.spike;
  const margin = g === 'perfect' ? 0.08 : 0.2;
  x = Math.max(-HALF_W - 2, Math.min(HALF_W + 2, x));
  return { x, z, ty, spin: kind === 'spike' && g === 'ok' ? ('soft' as const) : spin, elevs, margin };
}

/** A scoring ring on the far court. */
export interface Ring {
  x: number;
  z: number;
  r: number;
  value: 1 | 2 | 3;
}

/** The rings' sizes by value: the more it's worth, the smaller it is. */
export const RING_R: Record<1 | 2 | 3, number> = { 1: 1.35, 2: 1.0, 3: 0.72 };

/**
 * Three rings for a serve, spread over the far court: the 3 deep in a corner or tight on a line,
 * the 2 somewhere along the sideline, the 1 in the open. They never overlap.
 */
export function placeRings(rnd: () => number): Ring[] {
  const out: Ring[] = [];
  const fits = (x: number, z: number, r: number) => out.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r + 0.6);
  const put = (value: 1 | 2 | 3, pick: () => [number, number]) => {
    const r = RING_R[value];
    for (let i = 0; i < 400; i++) {
      const [x, z] = pick();
      if (fits(x, z, r)) return out.push({ x, z, r, value });
    }
    const [x, z] = pick();
    out.push({ x, z, r, value });
  };
  const side = () => (rnd() < 0.5 ? -1 : 1);
  put(3, () => [side() * (HALF_W - 0.85 - rnd() * 0.5), HALF_L - 0.85 - rnd() * 2.6]);
  put(2, () => [side() * (HALF_W - 1.1 - rnd() * 0.4), 2.6 + rnd() * 3.4]);
  put(1, () => [(rnd() - 0.5) * 3.2, 2.9 + rnd() * 3.6]);
  return out;
}

/** The value of the ring (x, z) lands in (the ball's footprint counts), or 0. */
export function ringAt(rings: readonly Ring[], x: number, z: number) {
  let v = 0;
  for (const r of rings) if (Math.hypot(r.x - x, r.z - z) <= r.r + 0.1) v = Math.max(v, r.value);
  return v;
}

/** How a rally ended, from the visitor's side. */
export type Outcome =
  | { won: true; how: 'ace' | 'kill' | 'error' | 'shank' | 'coconut'; ring: number; coconuts: number }
  | { won: false; how: 'net' | 'out' | 'fault' | 'dug' | 'missed' | 'blocked' };

/**
 * A won rally's points: an ace is worth its ring (1 outside the rings) plus one; a kill its ring
 * (plus one when the rally had gone back and forth); the locals' errors and shanked digs one; each
 * coconut COCONUT_POINTS.
 */
export function points(o: Outcome, exchanges: number) {
  if (!o.won) return 0;
  if (o.how === 'coconut') return o.coconuts * COCONUT_POINTS;
  if (o.how === 'ace') return Math.max(1, o.ring) + 1;
  if (o.how === 'kill') return Math.max(1, o.ring) + (exchanges >= 2 ? 1 : 0);
  return 1;
}

/** A defender's chance of getting to the ball. */
export interface Reach {
  /** Whether they get there standing (in time to set their feet), with a dive, or not at all. */
  how: 'set' | 'dive' | 'none';
  /** Seconds to spare (negative: too late). */
  spare: number;
}

/**
 * Can a defender `dist` metres from where the ball comes down, with `time` seconds until it does,
 * get there? They read the ball for `react` seconds, then run at `speed`; arms reach `arm` metres,
 * and a dive stretches that by another 1.6 m at the cost of 0.15 s.
 */
export function reach(dist: number, time: number, speed: number, react: number, arm = 0.75): Reach {
  const need = react + Math.max(0, dist - arm) / speed;
  if (need <= time - 0.08) return { how: 'set', spare: time - need };
  const needDive = react + Math.max(0, dist - arm - 1.6) / speed + 0.15;
  if (needDive <= time) return { how: 'dive', spare: time - needDive };
  return { how: 'none', spare: time - needDive };
}

/**
 * The chance a defender who gets there digs the ball up cleanly (else they shank it out): harder
 * the faster it comes (a hard spike at 20 m/s is a reflex), harder still at full stretch, and the
 * locals tire as a rally goes on.
 */
export function digChance(speed: number, how: 'set' | 'dive', skill: number, exchanges: number) {
  const pace = Math.max(0, speed - 9) * 0.035;
  const p = skill - pace - (how === 'dive' ? 0.3 : 0) - exchanges * 0.07;
  return Math.max(0.05, Math.min(0.95, p));
}
