// The SkyLink's vehicles: driverless rubber-tyred people-mover cars, two to a train, in the shape
// of the real airport shuttles (a boxy, rounded body, a full-width raked windscreen at the cab end,
// a continuous dark window band, two double plug-sliding doors each side, a bellows-covered
// gangway between the cars). Each car is lofted from one cross-section along its length, so the body, its glass and
// its lining all share the same outline; door and window openings are real holes, so a rider
// standing inside sees out through them.
//
// Car frame: origin on the running surface at the car's centre, forward (the cab end) −z, up +y.

import * as THREE from 'three';
import { Kit } from './terminal-kit';

/** Half the body's length: the cab's nose tip at −HALF_LEN, the gangway end at +HALF_LEN. */
export const HALF_LEN = 5.6;
/** Car centres sit this far either side of the train's centre (the bellows meet in the middle). */
export const CAR_OFFSET = HALF_LEN + 0.3;
/** The car floor above the running surface (level with the platforms). */
export const CAR_FLOOR = 0.9;
/** The body's half-width at the waist. */
export const HALF_W = 1.4;
/** Door openings: centres along the car (local z), half-width, sill and head heights. */
export const DOORS_Z = [-2.4, 2.6];
export const DOOR_HALF = 0.8;
export const DOOR_SILL = 0.95;
export const DOOR_HEAD = 2.9;
/** Where a rider stands (local, on the car's floor): in the aisle, looking ahead through the windscreen. */
export const RIDER_SPOT = { z: -1.2 };

const NOSE_START = -3.5;
/** The cab nose runs from NOSE_START forward to the tip at −HALF_LEN. */
const NOSE_LEN = HALF_LEN + NOSE_START;
const WIN_SILL = 1.45;
const WIN_HEAD = 2.9;
const WINDOWS: [number, number][] = [
  [-1.4, 0.0],
  [0.2, 1.6],
  [3.6, 5.3],
];

const WHITE = '#f3f5f7';
const ROOF = '#d5dade';
const SKIRT = '#3a3f45';
const PILLAR = '#1c2630';
const STRIPE = '#7b5cd6';
const STRIPE_GOLD = '#ffc23d';
const LINING = '#e6e9ec';
const FLOOR = '#3b4656';

/** The right half of the cross-section, bottom centre to roof centre (x, y). */
const HALF_SECTION: [number, number][] = [
  [0, 0.42],
  [1.22, 0.42],
  [1.38, 0.56],
  [1.4, DOOR_SILL],
  [1.4, 1.22],
  [1.4, 1.36],
  [1.4, WIN_SILL],
  [1.4, WIN_HEAD],
  [1.36, 3.1],
  [1.22, 3.3],
  [0.9, 3.42],
  [0.45, 3.47],
  [0, 3.48],
];

/** The whole section as a closed ring: up the right side, over the roof, down the left. */
function ring(): [number, number][] {
  const right = HALF_SECTION;
  const left = right
    .slice(1, -1)
    .reverse()
    .map(([x, y]) => [-x, y] as [number, number]);
  return [...right, ...left];
}
const RING = ring();

const within = (v: number, a: number, b: number) => v > a - 1e-4 && v < b + 1e-4;
const onSide = (x0: number, x1: number) => Math.abs(x0) > 1.39 && Math.abs(x1) > 1.39;

/** What a face of the outer skin is: a hole (doorway), glass, or painted body (with its colour). */
function skinFace(za: number, zb: number, ya: number, yb: number, xa: number, xb: number, nose: boolean): 'hole' | 'glass' | string {
  const zm = (za + zb) / 2;
  const y0 = Math.min(ya, yb);
  const y1 = Math.max(ya, yb);
  const side = onSide(xa, xb);
  if (nose) {
    // the windscreen wraps the cab's front above the waist
    if (y0 >= WIN_SILL - 1e-4 && y1 <= 3.12) return 'glass';
  } else if (side) {
    if (DOORS_Z.some((d) => within(zm, d - DOOR_HALF, d + DOOR_HALF)) && y0 >= DOOR_SILL - 1e-4 && y1 <= DOOR_HEAD + 1e-4) return 'hole';
    if (WINDOWS.some(([a, b]) => within(zm, a, b)) && y0 >= WIN_SILL - 1e-4 && y1 <= WIN_HEAD + 1e-4) return 'glass';
  }
  if (y1 <= DOOR_SILL + 1e-4 && side) return SKIRT;
  if (y1 <= 0.6) return SKIRT;
  if (side && y0 >= 1.22 - 1e-4 && y1 <= 1.36 + 1e-4) return STRIPE;
  if (side && y0 >= 1.36 - 1e-4 && y1 <= WIN_SILL + 1e-4) return STRIPE_GOLD;
  if (side && y0 >= WIN_SILL - 1e-4 && y1 <= WIN_HEAD + 1e-4) return PILLAR;
  if (y0 >= 3.25) return ROOF;
  return WHITE;
}

/** The cab nose's shape at u (0 where it starts, 1 at the tip) for a section point (x, y). */
function nosePoint(x: number, y: number, u: number): [number, number, number] {
  // a rounded plan (narrowing to the tip), a windscreen raked back towards the roof
  const sx = 1 - 0.3 * Math.pow(u, 2.2);
  const rake = y <= 1.3 ? 1 : THREE.MathUtils.lerp(1, 0.42, Math.min(1, (y - 1.3) / 2.18));
  const under = y < 0.6 ? 0.88 : 1;
  const z = NOSE_START - NOSE_LEN * u * rake * under;
  const yy = y > 3 ? y - 0.12 * u * u : y;
  return [x * sx, yy, z];
}

/** The positions of every ring along the car, nose tip to gangway end. */
function rings(inset: number) {
  const out: { z: number; pts: [number, number, number][]; nose: boolean }[] = [];
  const us = [1, 0.9, 0.75, 0.55, 0.3, 0];
  const shrink = (x: number, y: number): [number, number] => [x * (1 - inset / HALF_W), 1.95 + (y - 1.95) * (1 - inset / 1.55)];
  for (const u of us) {
    out.push({
      z: NOSE_START - NOSE_LEN * u,
      nose: u > 0,
      pts: RING.map(([x, y]) => {
        const [sx, sy] = shrink(x, y);
        const p = nosePoint(sx, sy, u);
        return [p[0], p[1], p[2] + inset * u];
      }),
    });
  }
  const zs = [-3.2, -1.6, -1.4, 0.0, 0.2, 1.6, 1.8, 3.4, 3.6, 5.3, HALF_LEN - inset * 0.5];
  for (const z of zs)
    out.push({
      z,
      nose: false,
      pts: RING.map(([x, y]) => {
        const [sx, sy] = shrink(x, y);
        return [sx, sy, z];
      }),
    });
  return out;
}

/**
 * One car: its body (skin, bellows, lights, underframe) and its cabin (lining, floor, seats,
 * poles), each one geometry for a vertex-coloured material, and its glass.
 */
export function carGeometry() {
  const body = new Kit();
  const glass = new Kit();
  const R = rings(0);
  const n = RING.length;
  for (let i = 0; i + 1 < R.length; i++) {
    const a = R[i];
    const b = R[i + 1];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const p0 = a.pts[j];
      const p1 = a.pts[k];
      const p2 = b.pts[k];
      const p3 = b.pts[j];
      const kind = skinFace(p0[2], p3[2], p0[1], p1[1], p0[0], p1[0], a.nose);
      if (kind === 'hole') continue;
      const v = (p: [number, number, number]) => ({ x: p[0], y: p[1], z: p[2] });
      // outward: up the ring (j → k) crossed with along the car (towards +z)
      if (kind === 'glass') glass.quad(v(p0), v(p1), v(p2), v(p3), '#ffffff');
      else body.quad(v(p0), v(p1), v(p2), v(p3), kind);
    }
  }
  // the nose tip's cap and the gangway end's wall: fans to their centres
  const cap = (pts: [number, number, number][], centre: [number, number, number], flip: boolean, glassAbove: number) => {
    for (let j = 0; j < n; j++) {
      const p0 = pts[j];
      const p1 = pts[(j + 1) % n];
      const into = (p0[1] + p1[1]) / 2 > glassAbove ? glass : body;
      const c = { x: centre[0], y: centre[1], z: centre[2] };
      const A = { x: p0[0], y: p0[1], z: p0[2] };
      const B = { x: p1[0], y: p1[1], z: p1[2] };
      const colour = (p0[1] + p1[1]) / 2 < 0.6 ? SKIRT : WHITE;
      if (flip) into.quad(A, B, c, c, colour);
      else into.quad(B, A, c, c, colour);
    }
  };
  const tip = R[0].pts;
  cap(tip, [0, 1.8, NOSE_START - NOSE_LEN * 0.9], false, 1.5);
  cap(R[R.length - 1].pts, [0, 1.95, HALF_LEN], true, 99);

  // the cabin (its own geometry, for the indoor material): the lining, the same loft a little
  // inside facing in, lit at night; the floor, seats, poles
  const cabin = new Kit();
  cabin.glow = 0.55;
  const L = rings(0.07);
  for (let i = 0; i + 1 < L.length; i++) {
    const a = L[i];
    const b = L[i + 1];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const p0 = a.pts[j];
      const p1 = a.pts[k];
      const p2 = b.pts[k];
      const p3 = b.pts[j];
      const kind = skinFace(p0[2], p3[2], p0[1], p1[1], p0[0] / (1 - 0.07 / HALF_W), p1[0] / (1 - 0.07 / HALF_W), a.nose);
      if (kind === 'hole' || kind === 'glass') continue;
      const ym = (p0[1] + p1[1]) / 2;
      if (ym < CAR_FLOOR) continue;
      const v = (p: [number, number, number]) => ({ x: p[0], y: p[1], z: p[2] });
      cabin.quad(v(p0), v(p3), v(p2), v(p1), ym > 3.2 ? '#f6f7f8' : LINING);
    }
  }
  // the ceiling's light strip
  cabin.glow = 1;
  cabin.floor(-0.3, -4.6, 0.3, 5.3, 3.36, '#fffaf0', undefined, true);
  cabin.glow = 0.3;
  // the floor, and the gangway's floor plate
  cabin.floor(-1.25, -4.7, 1.25, HALF_LEN, CAR_FLOOR, FLOOR);
  cabin.floor(-0.85, HALF_LEN, 0.85, CAR_OFFSET, CAR_FLOOR, '#2a2f36');
  cabin.glow = 0;
  // perimeter seats at the gangway end and behind the cab, grab poles by the doors
  for (const [z0, z1] of [
    [3.45, 5.35],
    [-1.4, 1.6],
  ])
    for (const s of [-1, 1]) {
      cabin.span(s * 1.3, CAR_FLOOR, z0, s * 0.85, CAR_FLOOR + 0.45, z1, '#2f4f7a');
      cabin.span(s * 1.33, CAR_FLOOR + 0.45, z0, s * 1.25, CAR_FLOOR + 1.0, z1, '#2f4f7a');
    }
  for (const d of DOORS_Z) for (const dz of [-1.0, 1.0]) cabin.bar({ x: 0.55, y: CAR_FLOOR, z: d + dz }, { x: 0.55, y: 3.3, z: d + dz }, 0.025, '#c3c9cf', 6);
  for (const d of DOORS_Z) cabin.bar({ x: -0.55, y: CAR_FLOOR, z: d }, { x: -0.55, y: 3.3, z: d }, 0.025, '#c3c9cf', 6);
  // a rail across the windscreen for the front-window riders
  cabin.bar({ x: -1.15, y: CAR_FLOOR + 1.05, z: -4.35 }, { x: 1.15, y: CAR_FLOOR + 1.05, z: -4.35 }, 0.025, '#c3c9cf', 6);
  // the gangway's bellows (half of them: the next car brings the other half)
  body.span(-0.95, 0.9, HALF_LEN - 0.05, -0.85, 3.05, CAR_OFFSET, '#25282c');
  body.span(0.85, 0.9, HALF_LEN - 0.05, 0.95, 3.05, CAR_OFFSET, '#25282c');
  body.span(-0.95, 2.95, HALF_LEN - 0.05, 0.95, 3.05, CAR_OFFSET, '#25282c');
  // the headlights on the nose
  body.glow = 1;
  for (const s of [-1, 1]) body.panel(s * 0.92, 1.05, nosePoint(0.92, 1.05, 0.97)[2] - 0.02, 0.36, 0.14, 0, '#fff4dc');
  body.glow = 0;
  // the underframe: two bogies, each two rubber tyres on the running pads and guide wheels
  for (const bz of [-3.3, 3.4]) {
    body.span(-1.2, 0.18, bz - 1.0, 1.2, 0.5, bz + 1.0, '#2a2e33');
    for (const s of [-1, 1]) {
      body.bar({ x: s * 0.82, y: 0.41, z: bz }, { x: s * 1.12, y: 0.41, z: bz }, 0.41, '#151515', 12);
      body.cyl(s * 0.97, 0.3, bz, 0.12, 0.12, 0.2, '#6f767d', 8);
    }
    body.cyl(0, 0.08, bz - 0.55, 0.16, 0.16, 0.18, '#151515', 8);
    body.cyl(0, 0.08, bz + 0.55, 0.16, 0.16, 0.18, '#151515', 8);
  }
  return { body: body.build(), cabin: cabin.build(), glass: glass.build() };
}

/**
 * One door leaf, closed position at its origin: 0.8 m along the car, 1.95 m tall, its outer face
 * towards +x (the instance matrix turns it to whichever side it's on). A dark window, lit at night.
 */
export function leafGeometry() {
  const k = new Kit();
  const h = DOOR_HEAD - DOOR_SILL;
  k.span(-0.03, -h / 2, -DOOR_HALF / 2, 0.03, h / 2, DOOR_HALF / 2, WHITE);
  k.glow = 0.6;
  k.span(0.031, WIN_SILL - (DOOR_SILL + h / 2), -DOOR_HALF / 2 + 0.06, 0.035, WIN_HEAD - 0.08 - (DOOR_SILL + h / 2), DOOR_HALF / 2 - 0.06, PILLAR);
  k.glow = 0;
  k.span(0.031, 1.22 - (DOOR_SILL + h / 2), -DOOR_HALF / 2, 0.034, 1.36 - (DOOR_SILL + h / 2), DOOR_HALF / 2, STRIPE);
  return k.build();
}
