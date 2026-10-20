// The Jet-Ski Race's course: a ~0.9 km loop of buoy gates in Palm Cay's lagoon, just off the
// jet-ski dock on the south beach. It's built once, up front (a closed centripetal Catmull-Rom
// through the control points, resampled every metre, like the Turbo Speedway's circuit), so the
// race, the rivals' speed profile, the buoys, the ramps and the minimap all read the same line.
// Everything here is pure maths (no three.js scene, no DOM), so scripts/jetski-check.mjs can
// check in node that the whole course stays in deep, open lagoon water.

import * as THREE from 'three';
import { ISLAND_SPOTS } from '../../geo';

export const LAPS = 3;
/** Half the gap between a gate's two buoys: an 18 m wide gate, room for the five skis. */
export const GATE_HALF = 9;
/** Beyond this far off the line the water turns to sea-grass shallows (drag); at WALL you're turned back. */
export const SHALLOWS = 26;
export const WALL = 40;
/** The start / finish line, in metres from the first sample (on the straight in front of the dock). */
export const START_S = 30;

/** The dock: the boardwalk from the beach path's end (z 41437) to the pontoon over the water. */
export const DOCK = {
  x: ISLAND_SPOTS.jetski.x - 2,
  /** Where the walkway leaves the beach boardwalk, and where the pier's deck over the water ends. */
  z0: 41437,
  z1: 41596,
  half: 2,
  /** The floating pontoon across the pier's head, where the skis are moored. */
  pontoon: { x0: ISLAND_SPOTS.jetski.x - 34, x1: ISLAND_SPOTS.jetski.x + 34, z0: 41596, z1: 41604 },
};

/**
 * Laid out clockwise seen from above: a straight east past the dock, a sweeping right-hander out
 * into the lagoon, a long back straight west with an S through it, a tight hairpin at the west
 * end and a fast curving run back north-east to the line. It all stays at least 70 m inside the
 * reef, clear of the swimming area's buoy line to the north (z < 41612) and of the dock (the
 * walls' band reaches z 41633 at its northernmost).
 */
const CONTROL: [number, number][] = [
  [10, 41678], [100, 41674], [178, 41684], [226, 41718], [240, 41770], [222, 41822], [172, 41850],
  [112, 41856], [58, 41872], [2, 41860], [-52, 41872], [-104, 41856], [-134, 41818], [-126, 41774],
  [-94, 41752], [-56, 41728], [-28, 41694],
];

export interface Course {
  /** Number of samples (spaced `ds` apart along the centre line). */
  n: number;
  ds: number;
  length: number;
  px: Float32Array;
  pz: Float32Array;
  /** Unit tangent, in the direction of the race. */
  tx: Float32Array;
  tz: Float32Array;
  /** Signed curvature, smoothed (1/m, positive = turning left). */
  k: Float32Array;
}

function build(): Course {
  const pts = CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const length = curve.getLength();
  const n = Math.round(length);
  const ds = length / n;
  const spaced = curve.getSpacedPoints(n);
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = spaced[i].x;
    pz[i] = spaced[i].z;
  }
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const dx = px[b] - px[a];
    const dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz);
    tx[i] = dx / l;
    tz[i] = dz / l;
  }
  // curvature from the change of tangent, projected on the left normal (tz, -tx)
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n;
    const b = (i + 2) % n;
    raw[i] = ((tx[b] - tx[a]) * tz[i] - (tz[b] - tz[a]) * tx[i]) / (4 * ds);
  }
  const k = new Float32Array(n);
  const W = 5;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -W; j <= W; j++) sum += raw[(i + j + n) % n];
    k[i] = sum / (2 * W + 1);
  }
  return { n, ds, length, px, pz, tx, tz, k };
}

export const COURSE = build();

/** Wraps an arc length into [0, length). */
export const wrapS = (s: number) => ((s % COURSE.length) + COURSE.length) % COURSE.length;

/** The signed shortest distance along the loop from arc length a to b. */
export function deltaS(a: number, b: number) {
  const L = COURSE.length;
  let d = (b - a) % L;
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
}

/** A point on the course: arc length `s`, `d` metres to the left of the centre line. */
export function coursePoint(s: number, d: number, out = { x: 0, z: 0, tx: 0, tz: 0 }) {
  const C = COURSE;
  const f = wrapS(s) / C.ds;
  const i = Math.floor(f) % C.n;
  const j = (i + 1) % C.n;
  const t = f - Math.floor(f);
  let tx = C.tx[i] + (C.tx[j] - C.tx[i]) * t;
  let tz = C.tz[i] + (C.tz[j] - C.tz[i]) * t;
  const l = Math.hypot(tx, tz);
  tx /= l;
  tz /= l;
  out.x = C.px[i] + (C.px[j] - C.px[i]) * t + tz * d;
  out.z = C.pz[i] + (C.pz[j] - C.pz[i]) * t - tx * d;
  out.tx = tx;
  out.tz = tz;
  return out;
}

/** The yaw that faces along the tangent (0 faces north, −z, like the visitor's heading). */
export const headingOf = (tx: number, tz: number) => Math.atan2(-tx, -tz);

/**
 * Where (x, z) sits relative to the course: the nearest sample `i` (searched within `window`
 * samples of `hint`, or everywhere when there's no hint), the arc length `s` and the signed
 * lateral offset `d` (positive = left of the centre line).
 */
export function locate(x: number, z: number, hint = -1, window = 10, out = { i: 0, s: 0, d: 0 }) {
  const C = COURSE;
  let best = hint;
  let bd = Infinity;
  const from = hint < 0 ? 0 : hint - window;
  const to = hint < 0 ? C.n - 1 : hint + window;
  for (let q = from; q <= to; q++) {
    const i = ((q % C.n) + C.n) % C.n;
    const d = (C.px[i] - x) ** 2 + (C.pz[i] - z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const i = best;
  const dx = x - C.px[i];
  const dz = z - C.pz[i];
  out.i = i;
  out.s = wrapS(i * C.ds + dx * C.tx[i] + dz * C.tz[i]);
  out.d = dx * C.tz[i] - dz * C.tx[i];
  return out;
}

/** The curvature at arc length s (1/m, positive = turning left). */
export const curvatureAt = (s: number) => COURSE.k[Math.floor(wrapS(s) / COURSE.ds) % COURSE.n];

// ------------------------------------------------------------------------------------------------
// Gates and ramps
// ------------------------------------------------------------------------------------------------

export interface Gate {
  /** Arc length of the gate's line across the course. */
  s: number;
  /** The start / finish gate (under the arch). */
  start: boolean;
}

/**
 * A pair of buoys every 55–70 m, closer together through the bends (where cutting the corner is
 * tempting); the first is the start / finish line.
 */
export const GATES: Gate[] = (() => {
  const out: Gate[] = [{ s: START_S, start: true }];
  let s = START_S + 60;
  const end = START_S + COURSE.length - 40;
  while (s < end) {
    out.push({ s: wrapS(s), start: false });
    let bend = 0;
    for (let q = 0; q <= 60; q += 4) bend = Math.max(bend, Math.abs(curvatureAt(s + q)));
    s += bend > 1 / 45 ? 48 : 66;
  }
  return out;
})();

export interface Ramp {
  /** Arc length of the ramp's foot, its lateral offset (left +). */
  s: number;
  d: number;
  /** Length of the slope (along the course), width across it, height of the lip above the water. */
  len: number;
  width: number;
  height: number;
  /** The foot's middle in the world, the unit direction up the slope, and its yaw (park convention). */
  x: number;
  z: number;
  ux: number;
  uz: number;
  yaw: number;
}

function ramp(s: number, d: number): Ramp {
  const p = coursePoint(s, d);
  return { s: wrapS(s), d, len: 6.5, width: 4.2, height: 1.55, x: p.x, z: p.z, ux: p.tx, uz: p.tz, yaw: headingOf(p.tx, p.tz) };
}

/**
 * Two floating kickers on the straights, off to one side: take them for air (and surf), or don't.
 * The first is on the straight past the dock (where the spectators are), the second in the middle
 * of the back straight.
 */
export const RAMPS: Ramp[] = [ramp(START_S + 105, -4.2), ramp(locate(60, 41870).s, 4.5)];

/** A point's place on a ramp: `along` metres up the slope from the foot, `across` off its middle (left +). */
export function onRamp(r: Ramp, x: number, z: number, out = { along: 0, across: 0 }) {
  const dx = x - r.x;
  const dz = z - r.z;
  out.along = dx * r.ux + dz * r.uz;
  out.across = dx * r.uz - dz * r.ux;
  return out;
}

/**
 * The ramp's deck height above the water `along` metres up the slope (−1 off its ends). The slope
 * is a gentle curve (a kicker), so the craft leaves the lip at its steepest.
 */
export function rampLift(r: Ramp, along: number) {
  if (along < 0 || along > r.len) return -1;
  const u = along / r.len;
  return r.height * (0.35 * u + 0.65 * u * u);
}

/** The lip's launch angle (rad): the slope's gradient at the top. */
export const rampAngle = (r: Ramp) => Math.atan((r.height * (0.35 + 1.3)) / r.len);

/** The course's footprint (with the walls). */
export const COURSE_BOUNDS = (() => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < COURSE.n; i++) {
    x0 = Math.min(x0, COURSE.px[i]);
    x1 = Math.max(x1, COURSE.px[i]);
    z0 = Math.min(z0, COURSE.pz[i]);
    z1 = Math.max(z1, COURSE.pz[i]);
  }
  return { x0: x0 - WALL, x1: x1 + WALL, z0: z0 - WALL, z1: z1 + WALL };
})();
