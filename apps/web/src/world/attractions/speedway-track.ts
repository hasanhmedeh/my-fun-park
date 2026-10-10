// The Turbo Speedway's kart circuit: a 470 m loop on the lawn outside the park's south-west fence.
// It's built once, up front (like the coaster tracks), so the trees and the horizon hills can keep
// clear of it and the minimap can draw it.
import * as THREE from 'three';
import { LAYOUT } from '../layout';

/** Half the asphalt's width: 11 m of road, room for four karts and the obstacles. */
export const ROAD_HALF = 5.5;
/** Red-and-white kerbs just outside the road edge, on the corners. */
export const CURB_W = 1.1;
/** The tyre walls, this far either side of the centre line. */
export const WALL = 10;
export const LAPS = 3;
/** The start / finish line, in metres from the first sample (on the main straight). */
export const START_S = 52;

/**
 * Control points in a frame turned to face the park: `a` runs along the main straight (towards the
 * south-east) and `b` is the distance out from the frame's origin, which LAYOUT.circuit then moves
 * to keep the main straight well outside the fence (the circuit itself is the same wherever it
 * stands). Laid out clockwise: a long main straight, a sweeping 180° right-hander, a
 * dip into the infield, an S up to the back straight and a long right-hander home. No two
 * stretches of track come within 33 m of each other; the tightest corner has a 15 m radius.
 */
const ANGLE = (3 * Math.PI) / 4; // the circuit lies to the south-west
const CONTROL: [number, number][] = [
  [-50, 116], [0, 116], [50, 116], [78, 124], [90, 145], [80, 166], [55, 172], [30, 160], [10, 150],
  [-10, 152], [-22, 168], [-32, 188], [-55, 198], [-80, 190], [-92, 170], [-88, 140], [-72, 122],
];

export interface Circuit {
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

function build(): Circuit {
  const ux = Math.cos(ANGLE);
  const uz = Math.sin(ANGLE);
  // along the straight: the outward direction turned a quarter turn
  const ax = uz;
  const az = -ux;
  // (the whole frame is then moved to where the park's layout wants the circuit)
  const o = LAYOUT.circuit;
  const pts = CONTROL.map(([a, b]) => new THREE.Vector3(o.x + ux * b + ax * a, 0, o.z + uz * b + az * a));
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

export const CIRCUIT = build();

/** Wraps an arc length into [0, length). */
export const wrapS = (s: number) => ((s % CIRCUIT.length) + CIRCUIT.length) % CIRCUIT.length;

/** The signed shortest distance along the loop from arc length a to b. */
export function deltaS(a: number, b: number) {
  const L = CIRCUIT.length;
  let d = (b - a) % L;
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
}

/** A point on the circuit: arc length `s`, `d` metres to the left of the centre line. */
export function circuitPoint(s: number, d: number, out = { x: 0, z: 0, tx: 0, tz: 0 }) {
  const C = CIRCUIT;
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
 * Where (x, z) sits relative to the circuit: the nearest sample `i` (searched within `window`
 * samples of `hint`, or everywhere when there's no hint), the arc length `s` and the signed
 * lateral offset `d` (positive = left of the centre line).
 */
export function locate(x: number, z: number, hint = -1, window = 10, out = { i: 0, s: 0, d: 0 }) {
  const C = CIRCUIT;
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

/** Spatial hash of the samples, for "is the circuit near here?" queries. */
const CELL = 8;
const grid = new Map<string, number[]>();
for (let i = 0; i < CIRCUIT.n; i += 2) {
  const key = `${Math.floor(CIRCUIT.px[i] / CELL)},${Math.floor(CIRCUIT.pz[i] / CELL)}`;
  let list = grid.get(key);
  if (!list) grid.set(key, (list = []));
  list.push(i);
}

/** True if the circuit's centre line passes within `r` metres of (x, z). */
export function nearCircuit(x: number, z: number, r: number) {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  const span = Math.ceil(r / CELL);
  for (let i = cx - span; i <= cx + span; i++)
    for (let j = cz - span; j <= cz + span; j++) {
      const list = grid.get(`${i},${j}`);
      if (!list) continue;
      for (const k of list) if ((CIRCUIT.px[k] - x) ** 2 + (CIRCUIT.pz[k] - z) ** 2 < r * r) return true;
    }
  return false;
}

/** The circuit's footprint, walls included. */
export const CIRCUIT_BOUNDS = (() => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < CIRCUIT.n; i++) {
    x0 = Math.min(x0, CIRCUIT.px[i]);
    x1 = Math.max(x1, CIRCUIT.px[i]);
    z0 = Math.min(z0, CIRCUIT.pz[i]);
    z1 = Math.max(z1, CIRCUIT.pz[i]);
  }
  return { x0: x0 - WALL, x1: x1 + WALL, z0: z0 - WALL, z1: z1 + WALL };
})();
