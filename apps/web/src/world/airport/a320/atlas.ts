// The A320's texture atlas: one canvas holds the whole aircraft's paint (fuselage, fin, nacelles,
// wing panels, the fan face and a block of solid swatches for the metal, rubber and glass parts),
// so the entire airframe draws with ONE material and one draw call. A second canvas with the same
// layout carries the surface properties (glow for the cabin windows, roughness, metalness); it
// doesn't depend on the livery, so every aircraft shares it.
//
// Regions are in the base 2048 × 1024 layout (the hero aircraft paints the same layout at 2×).

import { LENGTH, NOSE_Z } from './shape';

export const ATLAS = { w: 2048, h: 1024 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const REGION = {
  /** Fuselage: u along its length (nose → tail), rows by arc length s (keel → left side → crown → right side → keel). */
  fus: { x: 0, y: 0, w: 2048, h: 700 },
  /** Fin and rudder, one region per side, as seen from that side. */
  finL: { x: 0, y: 704, w: 360, h: 320 },
  finR: { x: 362, y: 704, w: 360, h: 320 },
  /** Nacelle fan cowl and reverser sleeve: columns round the circumference, rows along the engine. */
  nac: { x: 724, y: 704, w: 390, h: 320 },
  /** A half-wing's planform (upper and lower skins share it; the stabilisers too). */
  wing: { x: 1116, y: 704, w: 410, h: 320 },
  /** Solid swatches. */
  swatch: { x: 1528, y: 704, w: 520, h: 196 },
  /** The fan face, as a disc (the moving fan of the lower detail levels). */
  fan: { x: 1528, y: 902, w: 122, h: 122 },
} satisfies Record<string, Rect>;

/** Fin region: body z and height y spanned. */
export const FIN_MAP = { z0: 9.2, z1: 18.0, y0: 5.5, y1: 11.9 };
/** Wing region: span (|x|) and body z spanned. */
export const WING_MAP = { x0: 1.2, x1: 18.0, z0: -5.3, z1: 5.0 };
/** Nacelle region: body z spanned (rows). */
export const NAC_MAP = { z0: -10.32, z1: -5.7 };

export const SWATCHES = [
  'white',
  'wingGrey',
  'metal',
  'chrome',
  'tyre',
  'hub',
  'dark',
  'well',
  'inlet',
  'fanBlade',
  'core',
  'exhaust',
  'interior',
  'hold',
  'glass',
  'lens',
  'red',
  'green',
  'antenna',
  'tail',
  'engine',
  'belly',
  'fuselage',
  'cheat',
  'primer',
  'black',
  'cascade',
  'spinner',
] as const;
export type Swatch = (typeof SWATCHES)[number];
const CELL = 48;
const COLS = 10;

export function swatchRect(name: Swatch): Rect {
  const i = SWATCHES.indexOf(name);
  return { x: REGION.swatch.x + (i % COLS) * CELL, y: REGION.swatch.y + Math.floor(i / COLS) * CELL, w: CELL, h: CELL };
}

const W = ATLAS.w;
const H = ATLAS.h;
export type UV = [number, number];
const toUv = (cx: number, cy: number): UV => [cx / W, 1 - cy / H];

export function swatchUv(name: Swatch): UV {
  const r = swatchRect(name);
  return toUv(r.x + r.w / 2, r.y + r.h / 2);
}

/** Canvas pixel (base layout) of fuselage station z, arc length s. */
export function fusPx(z: number, s: number): [number, number] {
  const r = REGION.fus;
  return [r.x + ((z - NOSE_Z) / LENGTH) * r.w, r.y + s * r.h];
}
export const fusUv = (z: number, s: number) => toUv(...fusPx(z, s));

export function finPx(z: number, y: number, side: 'L' | 'R'): [number, number] {
  const r = side === 'L' ? REGION.finL : REGION.finR;
  const u = (z - FIN_MAP.z0) / (FIN_MAP.z1 - FIN_MAP.z0);
  return [r.x + (side === 'L' ? u : 1 - u) * r.w, r.y + ((FIN_MAP.y1 - y) / (FIN_MAP.y1 - FIN_MAP.y0)) * r.h];
}
export const finUv = (z: number, y: number, side: 'L' | 'R') => toUv(...finPx(z, y, side));

export function wingPx(ax: number, z: number): [number, number] {
  const r = REGION.wing;
  return [r.x + ((ax - WING_MAP.x0) / (WING_MAP.x1 - WING_MAP.x0)) * r.w, r.y + ((z - WING_MAP.z0) / (WING_MAP.z1 - WING_MAP.z0)) * r.h];
}
export const wingUv = (ax: number, z: number) => toUv(...wingPx(ax, z));

/** Nacelle: `round` 0..1 round the circumference (0 at the top, rising outboard→down), z along the engine. */
export function nacPx(round: number, z: number): [number, number] {
  const r = REGION.nac;
  return [r.x + round * r.w, r.y + ((z - NAC_MAP.z0) / (NAC_MAP.z1 - NAC_MAP.z0)) * r.h];
}
export const nacUv = (round: number, z: number) => toUv(...nacPx(round, z));

/** The fan face disc: (dx, dy) in −1..1 across it. */
export function fanUv(dx: number, dy: number): UV {
  const r = REGION.fan;
  return toUv(r.x + r.w / 2 + (dx * r.w) / 2 * 0.96, r.y + r.h / 2 - (dy * r.h) / 2 * 0.96);
}
