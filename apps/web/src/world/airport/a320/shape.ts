// The A320neo's outer shape as numbers: the fuselage's side and plan profiles, its cross-section,
// the wing-to-body fairing, the wing, stabiliser and fin planforms, the LEAP-1A nacelle's profile
// and the landing gear's geometry. Built to the published dimensions in aviation/a320.ts and to
// the airframe points the flight model uses (A320_POINTS), in the body frame: forward −Z, up +Y,
// right +X, the reference point between the main gear contacts at the origin.
//
// The geometry (airframe.ts), the livery painter (paint.ts) and the rig (rig.ts) all read the
// shape from here, so a window painted at a height lands where the skin really is.

import { A320, A320_POINTS } from '../../../aviation/a320';

export const NOSE_Z = A320_POINTS.noseTip.z;
export const TAIL_Z = A320_POINTS.tailTip.z;
export const LENGTH = TAIL_Z - NOSE_Z;
const DEG = Math.PI / 180;

/** Monotone cubic interpolation (Fritsch–Carlson): smooth through the points, never overshooting them. */
export function pchip(pts: readonly (readonly [number, number])[]) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
  };
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ------------------------------------------------------------------------------------------------
// Fuselage
// ------------------------------------------------------------------------------------------------

/** Nose stations are given as distance aft of the nose tip; the rest as body z. */
const nose = (rows: [number, number][]) => rows.map(([d, v]) => [NOSE_Z + d, v] as [number, number]);

/**
 * Crown (top) line. The radome rises to the windshield's sill, the windshield climbs steeply to
 * the cockpit roof, and the crown runs level (5.92 m: the 4.14 m deep section centred at 3.85 m)
 * until the tail cone droops gently to the APU exhaust.
 */
const TOP = pchip([
  ...nose([
    [0, 3.55], [0.02, 3.66], [0.08, 3.77], [0.2, 3.91], [0.4, 4.05], [0.7, 4.22], [1.1, 4.38], [1.45, 4.48],
    [1.75, 4.62], [2.05, 4.9], [2.35, 5.17], [2.75, 5.42], [3.4, 5.66], [4.2, 5.81], [5.0, 5.89], [5.8, 5.92],
  ]),
  [8, 5.92], [11, 5.915], [13, 5.9], [15, 5.86], [17, 5.79], [18.5, 5.72], [19.5, 5.64], [TAIL_Z, 5.6],
]);

/** Keel line: the chin curves up to the nose tip; behind the wing the tail cone sweeps up (tail strike at ~11.5°). */
const BOT = pchip([
  ...nose([[0, 3.55], [0.02, 3.4], [0.08, 3.25], [0.2, 3.08], [0.4, 2.88], [0.7, 2.65], [1.1, 2.45], [1.8, 2.18], [2.6, 1.98], [3.5, 1.87], [4.5, 1.8], [5.6, 1.78]]),
  [6.5, 1.78], [8.5, 1.84], [10, 2.08], [11.5, 2.45], [A320_POINTS.tailStrike.z, A320_POINTS.tailStrike.y], [15.5, 3.55], [17.5, 4.25], [19, 4.9], [TAIL_Z, 5.22],
]);

/** Half the fuselage's width (3.95 m in the constant section). */
const HALF = pchip([
  ...nose([[0, 0], [0.02, 0.17], [0.08, 0.34], [0.2, 0.54], [0.4, 0.76], [0.7, 1.02], [1.1, 1.25], [1.6, 1.45], [2.2, 1.63], [3.0, 1.8], [3.8, 1.91], [4.6, 1.96], [5.4, A320.fuselageWidth / 2]]),
  [8, A320.fuselageWidth / 2], [11, 1.96], [12.5, 1.92], [14, 1.8], [15.5, 1.55], [17, 1.2], [18.5, 0.78], [TAIL_Z, 0.2],
]);

/** Height of the widest point: a touch above the section's centre, rising with the tail cone. */
const WIDE = pchip([...nose([[0, 3.55], [1, 3.63], [3, 3.84], [5, 3.95]]), [8, 3.95], [13.5, 4.08], [16, 4.55], [TAIL_Z, 5.41]]);

/** Lower-lobe squareness: an ellipse forward, fuller (flatter-bottomed) where the tail sweeps up under the rear doors. */
const NLOW = pchip([[NOSE_Z, 2], [8, 2], [11, 2.6], [13.5, 3.3], [16, 3], [TAIL_Z, 2.2]]);

export const fuselage = { top: TOP, bot: BOT, half: HALF, wide: WIDE };

/** The wing-to-body fairing: how much of it there is along the fuselage (0 none .. 1 full). */
export function fairingK(z: number) {
  return smoothstep(-7.2, -4.4, z) * (1 - smoothstep(2.6, 7.2, z));
}
/** The fairing's flat belly height at full size (the retracted main wheels sit flush in it). */
export const FAIRING_BOTTOM = 1.76;
const FAIRING_CY = 2.55;

/**
 * The raw fuselage section at z, angle φ: 0 at the keel, π/2 the left side (−x), π the crown, 3π/2
 * the right. The lower lobe is a superellipse (exponent NLOW), the upper an ellipse.
 */
export function rawSection(z: number, phi: number, out: { x: number; y: number }) {
  const w = HALF(z);
  const yw = WIDE(z);
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  if (c >= 0) {
    const e = 2 / NLOW(z);
    out.x = -w * Math.sign(s) * Math.abs(s) ** e;
    out.y = yw - (yw - BOT(z)) * c ** e;
  } else {
    out.x = -w * s;
    out.y = yw + (TOP(z) - yw) * -c;
  }
  return out;
}

/** Inside the fairing's section at z (a flat-bottomed superellipse under the wing roots, an ellipse above)? */
function inFairing(k: number, x: number, y: number) {
  const a = 1.2 + 1.4 * k;
  const bottom = lerp(2.3, FAIRING_BOTTOM, k);
  const dy = y - FAIRING_CY;
  const ax = Math.abs(x) / a;
  if (dy < 0) return ax ** 6 + (-dy / (FAIRING_CY - bottom)) ** 6 <= 1;
  return ax * ax + (dy / 0.45) ** 2 <= 1;
}

/**
 * The outer skin at z, angle φ: the raw section, pushed out along the ray from the widest point
 * where the wing-to-body fairing bulges beyond it (their union, as one surface).
 */
export function skinPoint(z: number, phi: number, out: { x: number; y: number }) {
  rawSection(z, phi, out);
  const k = fairingK(z);
  if (k <= 0 || out.y > 3.1) return out;
  if (!inFairing(k, out.x, out.y)) return out;
  const yw = WIDE(z);
  const dx = out.x;
  const dy = out.y - yw;
  // bisect for where the ray leaves the fairing (it starts inside it at the raw skin)
  let lo = 1;
  let hi = 3;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (inFairing(k, dx * m, yw + dy * m)) lo = m;
    else hi = m;
  }
  out.x = dx * lo;
  out.y = yw + dy * lo;
  return out;
}

/**
 * One station's section, sampled finely, with its normalised arc length s (0 at the keel, rising
 * round the left side to the crown at ~0.5 and back down the right side to 1). The arc length is
 * the raw section's, so the fairing's bulge doesn't shift the paint above it.
 */
export interface SectionTable {
  z: number;
  phi: Float64Array;
  s: Float64Array;
  x: Float64Array;
  y: Float64Array;
}
const SAMPLES = 720;
const tableCache = new Map<number, SectionTable>();
export function sectionTable(z: number): SectionTable {
  const key = Math.round(z * 1000);
  const hit = tableCache.get(key);
  if (hit) return hit;
  const phi = new Float64Array(SAMPLES + 1);
  const s = new Float64Array(SAMPLES + 1);
  const x = new Float64Array(SAMPLES + 1);
  const y = new Float64Array(SAMPLES + 1);
  const p = { x: 0, y: 0 };
  let len = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    phi[i] = (i / SAMPLES) * Math.PI * 2;
    rawSection(z, phi[i], p);
    if (i > 0) len += Math.hypot(p.x - x[i - 1], p.y - y[i - 1]);
    x[i] = p.x;
    y[i] = p.y;
    s[i] = len;
  }
  for (let i = 0; i <= SAMPLES; i++) s[i] = len > 1e-9 ? s[i] / len : i / SAMPLES;
  const t = { z, phi, s, x, y };
  if (tableCache.size > 4000) tableCache.clear();
  tableCache.set(key, t);
  return t;
}

/** φ at arc length s on a station. */
export function phiAt(t: SectionTable, s: number) {
  let lo = 0;
  let hi = SAMPLES;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t.s[m] > s) hi = m;
    else lo = m;
  }
  const f = (s - t.s[lo]) / Math.max(1e-12, t.s[hi] - t.s[lo]);
  return t.phi[lo] + (t.phi[hi] - t.phi[lo]) * f;
}

/** The skin point at (z, s). */
export function skinAt(z: number, s: number, out: { x: number; y: number }) {
  return skinPoint(z, phiAt(sectionTable(z), s), out);
}

/** Arc length s where the raw section passes height y on the given side ('L' rises with s, 'R' falls). */
export function sAtHeight(z: number, side: 'L' | 'R', y: number) {
  const t = sectionTable(z);
  const half = SAMPLES / 2;
  let lo = side === 'L' ? 0 : half;
  let hi = side === 'L' ? half : SAMPLES;
  const up = side === 'L';
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t.y[m] < y === up) lo = m;
    else hi = m;
  }
  const f = (y - t.y[lo]) / (t.y[hi] - t.y[lo] || 1);
  return t.s[lo] + (t.s[hi] - t.s[lo]) * Math.min(1, Math.max(0, f));
}

/** Arc length s on the lower lobe where the raw section is |x| = ax off the centreline. */
export function sAtKeelOffset(z: number, side: 'L' | 'R', ax: number) {
  const t = sectionTable(z);
  const q = SAMPLES / 4;
  let lo = side === 'L' ? 0 : 3 * q;
  let hi = side === 'L' ? q : SAMPLES;
  const grows = side === 'L';
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (Math.abs(t.x[m]) < ax === grows) lo = m;
    else hi = m;
  }
  return (t.s[lo] + t.s[hi]) / 2;
}

/**
 * Arc length s of the skin point seen along the ray from the station's widest point through
 * (x, y): how the painter finds where something on the fairing (the wheel wells) lands in the
 * fuselage's texture.
 */
export function sOnRay(z: number, x: number, y: number) {
  const t = sectionTable(z);
  const yw = WIDE(z);
  const want = Math.atan2(y - yw, x);
  let best = 0;
  let err = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const a = Math.atan2(t.y[i] - yw, t.x[i]);
    let e = Math.abs(a - want);
    if (e > Math.PI) e = 2 * Math.PI - e;
    if (e < err) {
      err = e;
      best = i;
    }
  }
  return t.s[best];
}

/** The station where the nose skin passes through (x, y) seen front-on (for painting the cockpit windows). */
export function noseSurfaceZ(x: number, y: number) {
  // the nose's stations nest (each contains the one ahead), so bisect for the first that holds the point
  const inside = (z: number) => {
    const t = sectionTable(z);
    const yw = WIDE(z);
    const a = Math.atan2(y - yw, x);
    let best = 0;
    let err = Infinity;
    for (let i = 0; i <= SAMPLES; i += 2) {
      const e = Math.abs(Math.atan2(t.y[i] - yw, t.x[i]) - a);
      if (e < err) {
        err = e;
        best = i;
      }
    }
    return Math.hypot(x, y - yw) <= Math.hypot(t.x[best], t.y[best] - yw);
  };
  let lo: number = NOSE_Z;
  let hi = NOSE_Z + 6;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (inside(m)) hi = m;
    else lo = m;
  }
  return hi;
}

/** Where the fuselage's constant section is: a station used for the cabin's paint heights. */
export const CONST_Z = -2;

// Doors (sills at A320_POINTS.doorL1.y, 0.81 × 1.85 m) and the cargo doors (right side, lower lobe).
export const DOOR = { w: 0.81, h: 1.85, sill: A320_POINTS.doorL1.y };
export const DOORS = {
  L1: { z: A320_POINTS.doorL1.z, side: 'L' as const },
  L2: { z: A320_POINTS.doorL2.z, side: 'L' as const },
  R1: { z: A320_POINTS.doorR1.z, side: 'R' as const },
  R2: { z: A320_POINTS.doorR2.z, side: 'R' as const },
};
export const CARGO = {
  fwd: { z0: -9.5, z1: -7.69 },
  aft: { z0: 7.0, z1: 8.81 },
  y0: 2.02,
  y1: 3.26,
};
/** The nose gear bay: forward doors (closing again once the leg is down) and the aft door on the leg. */
export const NOSE_BAY = { z0: -14.95, zSplit: -13.05, z1: -12.3, halfW: 0.42 };
/** Overwing emergency exits (two per side, painted). */
export const OVERWING = [{ z: -1.05 }, { z: -0.25 }];
export const EXIT = { w: 0.51, h: 1.0, sill: 3.98 };

/** Cabin window rows: ~21 in pitch from behind door L1 to ahead of door L2, gaps for the overwing exits. */
export const WINDOW = { pitch: 0.533, w: 0.24, h: 0.33, y: 4.5 };
export function windowStations() {
  const out: number[] = [];
  for (let z = -11.55; z < 12.25; z += WINDOW.pitch) {
    if (OVERWING.some((e) => Math.abs(z - e.z) < 0.2)) {
      out.push(OVERWING.find((e) => Math.abs(z - e.z) < 0.2)!.z);
      continue;
    }
    out.push(z);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Wing (each side; x is the distance out from the centreline)
// ------------------------------------------------------------------------------------------------

/**
 * Planform: a straight leading edge swept 27.5° (25° at the quarter chord), an unswept inboard
 * trailing edge out to the kink at the engine, swept outboard to the 1.5 m tip; 122.6 m² gross.
 * The main gear (z = 0) stands at ~72 % of the local chord, behind the rear spar.
 */
export const WING = {
  root: 1.35,
  side: 1.98,
  kink: 6.3,
  tip: 16.95,
  le0: -5.58,
  leSlope: Math.tan(27.5 * DEG),
  teIn: 1.4,
  tipChord: 1.5,
  /** Chord plane height at the fuselage side, and the dihedral. */
  y0: 2.55,
  dihedral: 5.1 * DEG,
};
export const wingLeZ = (x: number) => WING.le0 + WING.leSlope * x;
const TIP_TE = WING.le0 + WING.leSlope * WING.tip + WING.tipChord;
export const wingTeZ = (x: number) => (x <= WING.kink ? WING.teIn : WING.teIn + ((x - WING.kink) * (TIP_TE - WING.teIn)) / (WING.tip - WING.kink));
export const wingChord = (x: number) => wingTeZ(x) - wingLeZ(x);
export const wingY = (x: number) => WING.y0 + (x - WING.side) * Math.tan(WING.dihedral);
/** Thickness/chord: 15 % at the root, 12 % at the kink, 10.8 % at the tip. */
export const wingTc = (x: number) => (x <= WING.kink ? lerp(0.15, 0.12, (x - WING.root) / (WING.kink - WING.root)) : lerp(0.12, 0.108, (x - WING.kink) / (WING.tip - WING.kink)));
/** Incidence (deg, leading edge up): washout towards the tip. */
export const wingTwist = (x: number) => lerp(3.0, -0.5, (x - WING.root) / (WING.tip - WING.root));

/** Chordwise splits: slat | wing box | flap or aileron; spoilers cover the box's aft upper skin. */
export const SPLIT = { slat: 0.13, flap: 0.74, spoiler: 0.6, spoilerEnd: 0.8 };
export const SLATS = [
  { x0: 2.3, x1: 5.15 },
  { x0: 6.4, x1: 16.6 },
];
export const FLAPS = {
  inner: { x0: WING.side, x1: WING.kink },
  outer: { x0: WING.kink, x1: 12.9 },
  aileron: { x0: 12.9, x1: 16.3 },
};
export const SPOILERS = [
  { x0: 2.7, x1: 5.15 },
  { x0: 6.6, x1: 8.1 },
  { x0: 8.1, x1: 9.6 },
  { x0: 9.6, x1: 11.1 },
  { x0: 11.1, x1: 12.6 },
];
/** Flap track fairings ("canoes") under the outer wing. */
export const CANOES = [7.6, 10.2, 12.55];

/**
 * The airfoil at chord fraction c: upper and lower surface heights (fractions of the chord) for
 * thickness ratio tc: a NACA four-digit thickness with an aft-loaded camber line.
 */
export function airfoil(c: number, tc: number, camber = 0.018) {
  const sq = Math.sqrt(Math.max(0, c));
  const t = 5 * tc * (0.2969 * sq - 0.126 * c - 0.3516 * c * c + 0.2843 * c ** 3 - 0.1036 * c ** 4);
  const p = 0.5;
  const yc = c < p ? (camber / (p * p)) * (2 * p * c - c * c) : (camber / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * c - c * c);
  return { up: yc + t, lo: yc - t, camber: yc, half: t };
}

/**
 * A point on a wing section at span x (positive, either side) and chord fraction c, with the
 * surface height h (fraction of chord, from airfoil()); world z/y, the chord twisted about 40 %.
 */
export function wingPoint(x: number, c: number, h: number, out: { y: number; z: number }) {
  const ch = wingChord(x);
  const tw = wingTwist(x) * DEG;
  const lc = (c - 0.4) * ch;
  const lh = h * ch;
  out.z = wingLeZ(x) + 0.4 * ch + lc * Math.cos(tw) + lh * Math.sin(tw);
  out.y = wingY(x) - lc * Math.sin(tw) + lh * Math.cos(tw);
  return out;
}

/** The sharklet: from the tip it curves up and out, 2.4 m tall, canted ~21°, swept back. */
export const SHARKLET = { height: 2.43, topX: A320.span / 2, rootChord: WING.tipChord, topChord: 0.42, sweep: 2.1, bend: 0.55 };

// ------------------------------------------------------------------------------------------------
// Tail
// ------------------------------------------------------------------------------------------------

/** Horizontal stabiliser: 12.45 m span, 33° leading edge sweep, 6° dihedral; elevators aft of 70 %. */
export const HSTAB = { root: 0.45, tip: 6.22, le0: 14.5, leSlope: Math.tan(33 * DEG), rootChord: 3.6, tipChord: 1.3, y0: 4.8, dihedral: 6 * DEG, tc: 0.1, elev: 0.7, elevX0: 0.95, elevX1: 6.0 };
export const hstabLe = (x: number) => HSTAB.le0 + HSTAB.leSlope * x;
export const hstabChord = (x: number) => lerp(HSTAB.rootChord, HSTAB.tipChord, x / HSTAB.tip);
export const hstabY = (x: number) => HSTAB.y0 + x * Math.tan(HSTAB.dihedral);

/** Fin: from the crown (with a small dorsal fillet) to 11.76 m; LE swept 34°, near-vertical trailing edge; rudder aft of 68 %. */
export const FIN = {
  stations: [
    { y: 5.62, le: 9.4, te: 17.42 },
    { y: 6.45, le: 11.45, te: 17.45 },
    { y: A320.height, le: 15.25, te: 17.62 },
  ],
  tc: 0.105,
  rudder: 0.68,
  rudderY0: 6.12,
  rudderY1: 11.45,
};
export function finAt(y: number) {
  const st = FIN.stations;
  const i = y < st[1].y ? 0 : 1;
  const t = (y - st[i].y) / (st[i + 1].y - st[i].y);
  return { le: lerp(st[i].le, st[i + 1].le, t), te: lerp(st[i].te, st[i + 1].te, t) };
}

// ------------------------------------------------------------------------------------------------
// LEAP-1A nacelle (each side), revolved about the engine axis
// ------------------------------------------------------------------------------------------------

export const ENGINE = {
  x: Math.abs(A320_POINTS.engineL.x),
  y: A320_POINTS.engineL.y,
  fanZ: A320_POINTS.engineL.z,
  fanR: 0.985,
  hubR: 0.36,
  blades: 18,
  /** The translating sleeve's travel (m) at full reverse. */
  sleeve: 0.62,
};
/** Profiles as (z, r). The fan cowl: inlet face, lip, outer cowl to the reverser split. */
export const NACELLE = {
  inlet: [[-9.4, 0.99], [-9.75, 0.975], [-10.12, 0.965], [-10.24, 0.985], [-10.3, 1.03], [-10.27, 1.075], [-10.18, 1.11]] as [number, number][],
  cowl: [[-10.18, 1.11], [-9.95, 1.145], [-9.6, 1.172], [-9.0, 1.19], [-8.3, 1.185], [-7.62, 1.165]] as [number, number][],
  sleeve: [[-7.62, 1.163], [-7.0, 1.125], [-6.35, 1.04], [-5.78, 0.93], [-5.74, 0.905], [-5.86, 0.88], [-6.5, 0.94], [-7.3, 0.985], [-7.62, 0.99]] as [number, number][],
  duct: [[-7.62, 0.99], [-8.6, 0.99], [-9.25, 0.99]] as [number, number][],
  core: [[-7.2, 0.6], [-6.4, 0.66], [-5.75, 0.645], [-5.0, 0.57], [-4.42, 0.47], [-4.4, 0.43], [-4.6, 0.42]] as [number, number][],
  plug: [[-4.6, 0.33], [-4.4, 0.32], [-4.1, 0.26], [-3.8, 0.15], [-3.58, 0.02]] as [number, number][],
  cascade: { z0: -7.62, z1: -7.0, r: 1.06 },
};

// ------------------------------------------------------------------------------------------------
// Landing gear
// ------------------------------------------------------------------------------------------------

/**
 * Main gear (each side): twin 46×17 in wheels on a leg hinged in the wing root, retracting
 * inboard through 90° so the outer wheel lies flush in the fairing's belly. Nose gear: twin
 * 30×8.8 in wheels, retracting forward into the bay under the cockpit.
 */
export const MAIN_GEAR = {
  x: Math.abs(A320_POINTS.mainGearL.x),
  z: A320_POINTS.mainGearL.z,
  wheelR: 0.584,
  tyreW: 0.43,
  /** Wheel centres either side of the leg. */
  spread: 0.4635,
  trunnionY: 2.415,
};
export const NOSE_GEAR = {
  z: A320_POINTS.noseGear.z,
  wheelR: 0.381,
  tyreW: 0.224,
  spread: 0.27,
  trunnionY: 2.3,
};
