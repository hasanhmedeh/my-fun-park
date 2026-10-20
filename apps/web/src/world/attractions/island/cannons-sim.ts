// Pirate Cannons: the pure maths behind the game, with no scene and no DOM, so
// scripts/cannons-check.mjs can check it in node. The fort's placement and its three guns, the
// ships' courses (racetrack loops in the western lagoon, clear of the jet-ski course), the
// cannonball's flight (gravity, a little air drag and the wind, in closed form so a ball lands
// in the same spot whatever the frame rate), the gun-laying solver and the hit test.

import * as THREE from 'three';
import { ISLAND_SPOTS, SEA_Y } from '../../geo';

// ------------------------------------------------------------------------------------------------
// The fort
// ------------------------------------------------------------------------------------------------

/**
 * The fort stands on the dunes at the south-west of the beach park, its battery facing the sea
 * a little west of south (the lagoon lies south and south-south-west of it; due west is the
 * headland). `x, z` is the centre of the battery's gun deck; the fort's local frame has −z
 * towards the sea and +x to its right (west-north-west), like every object turned by
 * `rotation.y = −heading`.
 */
export const FORT = {
  x: ISLAND_SPOTS.cannons.x,
  z: ISLAND_SPOTS.cannons.z + 32,
  /** Degrees clockwise from north: the way the battery faces. */
  heading: 200,
  /** The gun deck's height above the sand. */
  deckY: 4.2,
};
const FORT_RAD = THREE.MathUtils.degToRad(FORT.heading);
const FWD = { x: Math.sin(FORT_RAD), z: -Math.cos(FORT_RAD) };
const RIGHT = { x: Math.cos(FORT_RAD), z: Math.sin(FORT_RAD) };

/** World position of a point (lx, lz) in the fort's frame (y passes through). */
export function fortToWorld(lx: number, lz: number, out = { x: 0, z: 0 }) {
  out.x = FORT.x + lx * RIGHT.x - lz * FWD.x;
  out.z = FORT.z + lx * RIGHT.z - lz * FWD.z;
  return out;
}

/** The three guns along the battery's parapet: their pivots (trunnions) in the fort's frame. */
export const GUNS = [-9, 0, 9].map((lx) => ({ lx, lz: -6.6, y: FORT.deckY + 0.86 }));
/** Trunnions to muzzle, metres. */
export const BARREL = 2.9;
/** How far each gun can turn either side of straight out through its embrasure, and its elevation range (radians). */
export const TRAVERSE = THREE.MathUtils.degToRad(42);
export const ELEV_MIN = THREE.MathUtils.degToRad(-5);
export const ELEV_MAX = THREE.MathUtils.degToRad(14);
/** Where the aim may be put: the arc of sea in front of the battery. */
export const AIM = { minRange: 120, maxRange: 820, arc: THREE.MathUtils.degToRad(46) };

// ------------------------------------------------------------------------------------------------
// The ships' courses
// ------------------------------------------------------------------------------------------------

/**
 * A racetrack loop: two straights along x (the north one at z1, the south one at z2) joined by
 * half circles. `cw` sails it clockwise seen from above (east along the north straight).
 */
export interface Lane {
  name: string;
  /** Centre of the straights in x, and their half length. */
  cx: number;
  half: number;
  z1: number;
  z2: number;
  cw: boolean;
}

/**
 * Three loops in the western half of Palm Cay's lagoon (x −700..−200: it is 2–4 m deep there,
 * inside the reef that runs north–south at x ≈ −750), at about 250, 430 and 640 m from the guns.
 * The jet-ski course and its walls stay east of x −175, the swimming area north of z 41612.
 */
export const LANES: Lane[] = [
  { name: 'near', cx: -460, half: 150, z1: 41668, z2: 41742, cw: true },
  { name: 'mid', cx: -465, half: 150, z1: 41822, z2: 41930, cw: false },
  { name: 'far', cx: -462, half: 128, z1: 42034, z2: 42166, cw: true },
];

export function laneLength(l: Lane) {
  return 4 * l.half + Math.PI * (l.z2 - l.z1);
}

/** A point on a lane `s` metres round it (wrapped), with the direction of travel (unit). */
export function lanePoint(l: Lane, s: number, out = { x: 0, z: 0, tx: 0, tz: 0 }) {
  const L = laneLength(l);
  let u = ((s % L) + L) % L;
  if (!l.cw) u = L - u;
  const r = (l.z2 - l.z1) / 2;
  const zm = (l.z1 + l.z2) / 2;
  const arc = Math.PI * r;
  const a = 2 * l.half;
  // clockwise: the north straight eastwards, the east half circle, the south straight westwards, the west one
  if (u < a) {
    out.x = l.cx - l.half + u;
    out.z = l.z1;
    out.tx = 1;
    out.tz = 0;
  } else if (u < a + arc) {
    const th = (u - a) / r - Math.PI / 2; // −90° (north) .. +90° (south), round the east side
    out.x = l.cx + l.half + r * Math.cos(th);
    out.z = zm + r * Math.sin(th);
    out.tx = -Math.sin(th);
    out.tz = Math.cos(th);
  } else if (u < 2 * a + arc) {
    out.x = l.cx + l.half - (u - a - arc);
    out.z = l.z2;
    out.tx = -1;
    out.tz = 0;
  } else {
    const th = (u - 2 * a - arc) / r + Math.PI / 2; // +90° (south) .. 270° (north), round the west side
    out.x = l.cx - l.half + r * Math.cos(th);
    out.z = zm + r * Math.sin(th);
    out.tx = -Math.sin(th);
    out.tz = Math.cos(th);
  }
  if (!l.cw) {
    out.tx = -out.tx;
    out.tz = -out.tz;
  }
  return out;
}

/** Curvature of the lane at `s` (1/m, positive turning right as seen from the deck), for the heel in turns. */
export function laneTurn(l: Lane, s: number) {
  const L = laneLength(l);
  const u = ((s % L) + L) % L;
  const a = 2 * l.half;
  const arc = (Math.PI * (l.z2 - l.z1)) / 2;
  const onArc = (u >= a && u < a + arc) || u >= 2 * a + arc;
  return onArc ? ((l.cw ? 2 : -2) / (l.z2 - l.z1)) : 0;
}

// ------------------------------------------------------------------------------------------------
// Ballistics
// ------------------------------------------------------------------------------------------------

/** Muzzle velocity (m/s): slower than a real 24-pounder's, so the ball's arc can be watched. */
export const MUZZLE_V = 160;
export const GRAVITY = 9.81;
/** Linear air drag (1/s): the arc steepens a little as the ball slows. */
export const DRAG = 0.035;
/** How strongly the wind carries the ball (1/s): a 15 kt breeze moves a 4 s shot about 5 m. */
export const WIND_PUSH = 0.08;

/** A shot in flight: where and how it left the muzzle, and the wind (m/s, the way it blows). */
export interface Shot {
  x0: number;
  y0: number;
  z0: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wz: number;
}

/** Where a shot is `t` seconds after leaving the muzzle (closed form: frame-rate independent). */
export function shotAt(s: Shot, t: number, out = new THREE.Vector3()) {
  const k = DRAG;
  const e = (1 - Math.exp(-k * t)) / k;
  // horizontal: drag towards the wind's own speed, scaled; vertical: gravity against drag
  const ax = WIND_PUSH * s.wx;
  const az = WIND_PUSH * s.wz;
  out.x = s.x0 + (ax / k) * t + (s.vx - ax / k) * e;
  out.z = s.z0 + (az / k) * t + (s.vz - az / k) * e;
  out.y = s.y0 - (GRAVITY / k) * t + (s.vy + GRAVITY / k) * e;
  return out;
}

/** The time a ball launched upwards at `vy` from `dy` metres above a plane comes down through it. */
export function fallTime(vy: number, dy: number) {
  const k = DRAG;
  const g = GRAVITY;
  // start from the drag-free answer and polish it with Newton's method on y(t) = −dy
  let t = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * dy))) / g;
  for (let i = 0; i < 6; i++) {
    const ek = Math.exp(-k * t);
    const y = -(g / k) * t + ((vy + g / k) * (1 - ek)) / k + dy;
    const v = -g / k + (vy + g / k) * ek;
    if (Math.abs(v) < 1e-6) break;
    t -= y / v;
  }
  return t;
}

/** Range on the sea (no wind) of a ball fired at `elev` from `dy` metres above it, and the time it takes. */
export function rangeAt(elev: number, dy: number) {
  const vh = MUZZLE_V * Math.cos(elev);
  const t = fallTime(MUZZLE_V * Math.sin(elev), dy);
  return { range: (vh * (1 - Math.exp(-DRAG * t))) / DRAG, t };
}

/**
 * The elevation that lands a ball (without wind) `range` metres away on a plane `dy` below the
 * muzzle: bisection on the low arc, where range rises with elevation. Clamped to the gun's limits.
 */
export function elevationFor(range: number, dy: number) {
  let lo = ELEV_MIN;
  let hi = ELEV_MAX;
  if (rangeAt(lo, dy).range >= range) return lo;
  if (rangeAt(hi, dy).range <= range) return hi;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (rangeAt(mid, dy).range < range) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Bearing (radians clockwise from north) from one point to another. */
export function bearing(x0: number, z0: number, x1: number, z1: number) {
  return Math.atan2(x1 - x0, -(z1 - z0));
}

/** The smallest signed difference a − b between two angles (radians). */
export function angleDiff(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** The muzzle's world position for a gun's pivot (wx, y, wz), pointing at `bearing` and `elev`. */
export function muzzle(wx: number, y: number, wz: number, brg: number, elev: number, out = new THREE.Vector3()) {
  const c = Math.cos(elev) * BARREL;
  return out.set(wx + Math.sin(brg) * c, y + Math.sin(elev) * BARREL, wz - Math.cos(brg) * c);
}

/**
 * Lays a gun on a spot on the sea: its bearing and elevation, from its pivot. Two passes, since
 * the muzzle (where the ball starts) moves with the elevation.
 */
export function lay(wx: number, y: number, wz: number, tx: number, tz: number) {
  const brg = bearing(wx, wz, tx, tz);
  const m = new THREE.Vector3();
  let elev = 0;
  for (let i = 0; i < 2; i++) {
    muzzle(wx, y, wz, brg, elev, m);
    elev = elevationFor(Math.hypot(tx - m.x, tz - m.z), m.y - SEA_Y);
  }
  return { bearing: brg, elev };
}

// ------------------------------------------------------------------------------------------------
// Hits
// ------------------------------------------------------------------------------------------------

/**
 * Whether the segment a→b (in a ship's own frame) passes through its box (half sizes hx, hz, from
 * y0 to y1), and where it enters (the fraction along the segment), by the slab method.
 */
export function segmentHitsBox(a: THREE.Vector3, b: THREE.Vector3, hx: number, y0: number, y1: number, hz: number) {
  let t0 = 0;
  let t1 = 1;
  const lo = [-hx, y0, -hz];
  const hi = [hx, y1, hz];
  const p = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return -1;
      continue;
    }
    let ta = (lo[i] - p[i]) / d[i];
    let tb = (hi[i] - p[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0;
}

/** The streak multiplier: ×1, then one more for every three hits in a row, up to ×5. */
export function multiplier(streak: number) {
  return Math.min(5, 1 + Math.floor(streak / 3));
}
