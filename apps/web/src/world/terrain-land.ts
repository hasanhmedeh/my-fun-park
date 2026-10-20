// The shape of the land and the sea bed beyond the park: the hills round the fair, the rolling
// country and the mountains far to the north, the beaches, the coral reef round Palm Cay's lagoon,
// and what grows where (forests, villages, fields). Pure functions only, so the flight model, the
// boats and node checks can ask for the ground without a scene.
//
// Heights follow world/geo.ts: walkable land is y = 0; both coasts share one shore profile by
// shore distance d (y = 0 for d ≥ 25, down to SEA_Y at the water's edge, then on down under the sea).

import { FALCON_TRACK } from './rides';
import { CIRCUIT, WALL as CIRCUIT_WALL } from './attractions/speedway-track';
import { TRAIL, WALL as TRAIL_WALL } from './attractions/trail-track';
import { AIRPORTS, ISLAND, SEA_Y, homeCoastZ, homeShoreDist, islandShoreDist } from './geo';
import { GROUND, LAYOUT, PARK, VALLEY, WHEEL_LAWN } from './layout';
import { mulberry } from './random';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** GLSL's smoothstep(e0, e1, x). */
export const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------------------
// Noise. One small tileable texture of four independent noise channels drives the land's look in
// the shader; the same bytes, sampled the same way here, decide where trees stand, so the forests
// drawn into the ground and the 3D trees on them agree.
// ------------------------------------------------------------------------------------------------

export const NOISE_SIZE = 256;

/** RGBA8 data: each channel a smooth, tileable value-noise fBm stretched to the full 0–255 range. */
export const NOISE_DATA: Uint8Array = (() => {
  const N = NOISE_SIZE;
  const out = new Uint8Array(N * N * 4);
  const field = new Float32Array(N * N);
  for (let c = 0; c < 4; c++) {
    const rnd = mulberry(1013 + c * 77);
    field.fill(0);
    for (const [cells, amp] of [[4, 0.42], [8, 0.27], [16, 0.16], [32, 0.09], [64, 0.06]] as const) {
      const g = Float32Array.from({ length: cells * cells }, rnd);
      const at = (i: number, j: number) => g[(j % cells) * cells + (i % cells)];
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * cells;
          const fy = (y / N) * cells;
          const i = Math.floor(fx);
          const j = Math.floor(fy);
          let u = fx - i;
          let v = fy - j;
          u = u * u * (3 - 2 * u);
          v = v * v * (3 - 2 * v);
          const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
          const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
          field[y * N + x] += (a + (b - a) * v) * amp;
        }
    }
    // stretch so that the 1st..99th percentiles span the bytes (the sum of octaves bunches up round the middle)
    const sorted = Float32Array.from(field).sort();
    const lo = sorted[Math.floor(sorted.length * 0.01)];
    const hi = sorted[Math.floor(sorted.length * 0.99)];
    for (let k = 0; k < N * N; k++) out[k * 4 + c] = Math.round(clamp01((field[k] - lo) / (hi - lo)) * 255);
  }
  return out;
})();

/** Bilinear sample of one channel at world (x, z) for a texture spanning `period` metres (as the GPU's LinearFilter + RepeatWrapping does). */
export function noiseAt(x: number, z: number, period: number, channel: number) {
  const N = NOISE_SIZE;
  const fx = (x / period) * N - 0.5;
  const fz = (z / period) * N - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const i0 = ((i % N) + N) % N;
  const j0 = ((j % N) + N) % N;
  const i1 = (i0 + 1) % N;
  const j1 = (j0 + 1) % N;
  const d = NOISE_DATA;
  const a = d[(j0 * N + i0) * 4 + channel];
  const b = d[(j0 * N + i1) * 4 + channel];
  const c = d[(j1 * N + i0) * 4 + channel];
  const e = d[(j1 * N + i1) * 4 + channel];
  return (a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v) / 255;
}

/** The shader's rotated sample: (x, z) turned by 30° (breaks up the tiling of the big patterns). */
export const ROT_C = Math.cos(Math.PI / 6);
export const ROT_S = Math.sin(Math.PI / 6);

// ------------------------------------------------------------------------------------------------
// The hills round the fair: five rings of rolling hills (the park's original horizon), flattened
// wherever a ride runs out past the fence, and now also south of the park, where the airport is.
// ------------------------------------------------------------------------------------------------

const SEG = 180;
const RADII = [200, 290, 430, 610, 860];
const AMPS = [0, 3, 9, 18, 30];
/** The rings' colours as the park has always shown them (blue-grey with distance, for the walking view). */
export const RING_COLORS = ['#2b5c40', '#2a5038', '#2e4836', '#3a4250', '#4c4562'];

let ring: { y: Float32Array; reach: Float32Array } | null = null;
function rings() {
  if (ring) return ring;
  const h = (a: number, k: number) => (Math.sin(a * 3 + k) * 0.5 + Math.sin(a * 7.3 + k * 2.1) * 0.3 + Math.sin(a * 13.7 + k) * 0.2) * 0.5 + 0.5;
  // the hills flatten into a plain out past whatever stands beyond the fence, `spread` sectors either side
  const reach = new Float32Array(SEG);
  const clear = (x: number, z: number, pad: number, spread: number) => {
    const r = Math.hypot(x - PARK.x, z - PARK.z) + pad;
    if (r < 150) return;
    const si = Math.round(((((Math.atan2(z - PARK.z, x - PARK.x) / (Math.PI * 2)) % 1) + 1) % 1) * SEG);
    for (let d = -spread; d <= spread; d++) {
      const j = (((si + d) % SEG) + SEG) % SEG;
      reach[j] = Math.max(reach[j], r);
    }
  };
  // wherever the Sky Falcon runs out into the desert, behind the kart circuit and the Rally Trail,
  // round the giant wheel and over Creators' Valley (exactly as the park has always cleared them)
  for (let k = 0; k < FALCON_TRACK.pos.length; k += 4) clear(FALCON_TRACK.pos[k].x, FALCON_TRACK.pos[k].z, 0, 6);
  for (let k = 0; k < CIRCUIT.n; k += 4) clear(CIRCUIT.px[k], CIRCUIT.pz[k], CIRCUIT_WALL, 4);
  for (let k = 0; k < TRAIL.n; k += 4) clear(TRAIL.px[k], TRAIL.pz[k], TRAIL_WALL, 4);
  const wheel = LAYOUT.ferris;
  for (let x = -130; x <= 130; x += 10) for (const dz of [-50, 0, 50]) clear(wheel.x + x, wheel.z + dz, 10, 2);
  for (const l of VALLEY.lawns) for (let x = l.x0; x <= l.x1; x += 15) for (let z = l.z0; z <= l.z1; z += 15) clear(x, z, 40, 3);
  const y = new Float32Array(RADII.length * SEG);
  RADII.forEach((r, row) => {
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const flat = row === 0 || r < reach[i] + 140;
      y[row * SEG + i] = flat ? 0 : h(a, row) * AMPS[row] + AMPS[row] * 0.15;
    }
  });
  ring = { y, reach };
  return ring;
}

/** Sector coordinate (0..SEG) of a point round the park's centre. */
function sector(x: number, z: number) {
  const a = Math.atan2(z - PARK.z, x - PARK.x);
  return ((((a / (Math.PI * 2)) % 1) + 1) % 1) * SEG;
}

/** The ring hills at (x, z), and the ring row (fractional) for its colour; beyond the last ring its height carries on outward. */
function ringHill(x: number, z: number, r: number) {
  const { y } = rings();
  const f = sector(x, z);
  const i0 = Math.floor(f) % SEG;
  const i1 = (i0 + 1) % SEG;
  const u = f - Math.floor(f);
  let row = RADII.length - 1;
  let t = 0;
  if (r < RADII[RADII.length - 1]) {
    row = 0;
    while (row < RADII.length - 2 && r > RADII[row + 1]) row++;
    t = clamp01((r - RADII[row]) / (RADII[row + 1] - RADII[row]));
  }
  const at = (rw: number) => y[rw * SEG + i0] + (y[rw * SEG + i1] - y[rw * SEG + i0]) * u;
  const a = at(row);
  const hgt = t > 0 ? a + (at(row + 1) - a) * t : a;
  return { h: hgt, row: row + t };
}

/** Distance from (x, z) to the home runway's rectangle (0 on it). */
function runwayDist(x: number, z: number) {
  const rw = AIRPORTS.home.runway;
  const dx = Math.max(rw.x0 - x, 0, x - rw.x1);
  const dz = Math.abs(z - rw.z);
  return Math.hypot(dx, dz);
}

const HILL_N = (() => {
  const rnd = mulberry(4711);
  const N = 256;
  const g = Float32Array.from({ length: N * N }, rnd);
  const at = (i: number, j: number) => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * fx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * fx;
    return a + (b - a) * fy;
  };
})();

/** Rolling-hill shape 0..1: soft fBm with sharpened crests (ridges) for the far mountains. */
function hillShape(x: number, z: number, ridged: number) {
  let v = 0;
  let amp = 0.5;
  let f = 1 / 2400;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    let n = HILL_N(x * f + o * 17.3, z * f - o * 9.1);
    n = n + (1 - Math.abs(n * 2 - 1) - n) * ridged;
    v += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}

/**
 * The country beyond the ring hills: rolling hills that rise with distance from the fair into a
 * mountain range far to the north, and lower hills along the coast far east and west. The coastal
 * plain round the airport (and 4 km inland of it) stays flat, and within 2 km of the runway nothing
 * rises (its obstacle surfaces).
 */
function farHill(x: number, z: number, d: number, s: number) {
  const amp = 55 * sstep(900, 2600, d) + 150 * sstep(2600, 11000, d) + 380 * sstep(11000, 34000, d);
  if (amp <= 0) return 0;
  // the coastal plain: flat for the first 1.4 km inland, fully hilly from 4.8 km; far east and west
  // of the airport's approach corridors the hills come down closer to the sea
  const inland = Math.max(sstep(1400, 4800, s), sstep(16000, 19000, Math.abs(x)) * sstep(500, 2200, s));
  if (inland <= 0) return 0;
  const rw = sstep(2000, 3300, runwayDist(x, z));
  if (rw <= 0) return 0;
  // near the fair the hills only rise beyond whatever the park cleared (the rides out past the fence)
  const reach = d < 2500 ? sstep(rings().reach[Math.floor(sector(x, z)) % SEG] + 140, rings().reach[Math.floor(sector(x, z)) % SEG] + 700, d) : 1;
  const north = sstep(-6000, -26000, z);
  const shape = hillShape(x, z, 0.35 + 0.5 * north);
  return amp * Math.pow(shape, 1.5 + 0.6 * north) * inland * rw * reach;
}

/** The mainland's height on land (shore distance s ≥ 25): the ring hills and the country beyond. */
export function mainlandHill(x: number, z: number, s = homeShoreDist(x, z)) {
  const d = Math.hypot(x - PARK.x, z - PARK.z);
  let h = farHill(x, z, d, s);
  if (d > RADII[0] && d < 2600) {
    // the original ring hills, faded out south of the park (the airport's ground) and beyond 860 m
    const rh = ringHill(x, z, d).h * (1 - sstep(60, 235, z)) * (1 - sstep(860, 2600, d));
    h = Math.max(h, rh) + Math.min(h, rh) * 0.35;
    // outside the original rings, nothing new rises above 22 m within 2 km of the runway
    if (d > 860) {
      const cap = 22 + 600 * sstep(2000, 2700, runwayDist(x, z));
      h = h + (Math.min(h, cap) - h) * sstep(860, 1000, d);
    }
  }
  return h;
}

// ------------------------------------------------------------------------------------------------
// Palm Cay: two modest jungle hills on the south side, either side of the beach park.
// ------------------------------------------------------------------------------------------------

export const ISLAND_HILLS = [
  { x: 1260, z: 41210, sx: 175, sz: 105, h: 58 },
  { x: -1290, z: 41170, sx: 150, sz: 95, h: 44 },
];

export function islandHill(x: number, z: number, d = islandShoreDist(x, z)) {
  if (d < 25) return 0;
  let h = 0;
  for (const p of ISLAND_HILLS) {
    const u = (x - p.x) / p.sx;
    const v = (z - p.z) / p.sz;
    const q = u * u + v * v;
    // a rounded dome with gullies and spurs cut into its flanks
    if (q < 16) h += p.h * Math.exp(-0.5 * q) * (0.8 + 0.2 * HILL_N(x / 90 + 40, z / 90) + 0.25 * (HILL_N(x / 31 - 7, z / 31 + 3) - 0.5) * Math.min(1, q));
  }
  // the hills keep their feet out of the beach park (|x| ≥ 700 for anything you'd call a hill)
  return h * sstep(25, 160, d) * sstep(ISLAND.park.x1 + 50, ISLAND.park.x1 + 230, Math.abs(x));
}

// ------------------------------------------------------------------------------------------------
// The shore and the sea bed
// ------------------------------------------------------------------------------------------------

/** The beach's slope from the dry sand (d = 25, y = 0) down to the water's edge (d = 0, SEA_Y). */
export function shoreProfile(d: number) {
  const k = 1 - d / 25;
  return SEA_Y * k * Math.sqrt(k);
}

/** Water depth off the mainland, u metres out from the water's edge. */
export function mainlandDepth(u: number) {
  return u < 40 ? 0.072 * u : Math.min(42, 2.88 + 0.03 * (u - 40));
}

/** The lagoon's rounded rectangle (inside the reef): centre, half-size and corner radius. */
const LAG = (() => {
  const L = ISLAND.lagoon;
  return { cx: (L.x0 + L.x1) / 2, cz: (L.z0 + L.z1) / 2, hx: (L.x1 - L.x0) / 2, hz: (L.z1 - L.z0) / 2, r: 160 };
})();

/** Signed distance to the lagoon's edge: negative inside it. */
export function lagoonSdf(x: number, z: number) {
  const qx = Math.abs(x - LAG.cx) - (LAG.hx - LAG.r);
  const qz = Math.abs(z - LAG.cz) - (LAG.hz - LAG.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - LAG.r;
}

/** The coral reef along the lagoon's south, east and west sides: 0..1 across its crest (and where it is). */
export function reefAt(x: number, z: number) {
  const L = lagoonSdf(x, z);
  // not along the north side, where the lagoon opens onto the beach
  if (L <= 0 || L > 95 || (Math.abs(x - LAG.cx) < LAG.hx && z < ISLAND.lagoon.z0)) return 0;
  return sstep(0, 26, L) * (1 - sstep(48, 95, L));
}

/** Water depth round Palm Cay, u metres out from its water's edge: a sandy shelf, the lagoon, the reef, then the drop-off. */
export function islandDepth(x: number, z: number, u: number) {
  const shelf = u < 40 ? 0.072 * u : u < 260 ? 2.88 + 0.022 * (u - 40) : Math.min(58, 7.72 + 0.12 * (u - 260));
  const L = lagoonSdf(x, z);
  if (L > 300) return shelf;
  const north = Math.abs(x - LAG.cx) < LAG.hx && z < ISLAND.lagoon.z0;
  const floor = 2.1 + 1.6 * sstep(0, 220, -L) + 0.9 * (HILL_N(x / 60, z / 60) - 0.5);
  let d: number;
  if (L <= 0 || north) d = floor;
  else {
    // up the reef's back slope to its crest (half a metre down, coral heads nearly breaking the
    // surface), then over the front and down the drop-off to the ocean floor
    const crest = 0.5 + 0.45 * HILL_N(x / 23, z / 23);
    if (L < 30) d = floor + (crest - floor) * sstep(0, 30, L);
    else d = crest + Math.max(0, L - 52) * 0.42;
  }
  return Math.min(shelf, d);
}

/**
 * The visual ground at (x, z): 0 on walkable land, the hills, the shore profile down to the
 * water, and the sea bed beyond. (The park's own ground and the Sky Falcon's mountain are drawn
 * by their own meshes; here the land is 0 under them.)
 */
export function groundY(x: number, z: number): number {
  if (z > 20000) {
    const d = islandShoreDist(x, z);
    if (d >= 25) return islandHill(x, z, d);
    if (d >= 0) return shoreProfile(d);
    return SEA_Y - islandDepth(x, z, -d);
  }
  const s = homeShoreDist(x, z);
  if (s >= 25) return mainlandHill(x, z, s);
  if (s >= 0) return shoreProfile(s);
  return SEA_Y - mainlandDepth(-s);
}

/** True on land: shore distance ≥ margin (default 0, the water's edge). */
export function onLand(x: number, z: number, margin = 0) {
  return (z > 20000 ? islandShoreDist(x, z) : homeShoreDist(x, z)) >= margin;
}

// ------------------------------------------------------------------------------------------------
// Where the terrain mesh sits a little below the ground: under the park's own ground meshes (so
// they never fight over the same depth from far away) and a few centimetres down round the park,
// as the old far ground always was, under the tracks that lie on it.
// ------------------------------------------------------------------------------------------------

/** Ground the park draws itself: its square, the lawns out to the wheel and the Valley, and the mountain's window (see mountain.ts). */
const COVERS = [
  { x0: GROUND.x - GROUND.size / 2, x1: GROUND.x + GROUND.size / 2, z0: GROUND.z - GROUND.size / 2, z1: GROUND.z + GROUND.size / 2, depth: 0.6 },
  { x0: LAYOUT.ferris.x - WHEEL_LAWN.half, x1: LAYOUT.ferris.x + WHEEL_LAWN.half, z0: WHEEL_LAWN.z0, z1: WHEEL_LAWN.z1, depth: 0.6 },
  ...VALLEY.lawns.map((l) => ({ ...l, depth: 0.6 })),
  // the mountain's terrain window, laid out the same way mountain.ts lays it out
  { x0: -110, x1: 340 + Math.max(0, LAYOUT.falcon.x - 70), z0: -950, z1: -96, depth: 3 },
];

/** The home airport's flat ground (x −2700..2700, from z 250 down to the coast): 1 inside. */
export function airportZone(x: number, z: number) {
  return (1 - sstep(2700, 2760, Math.abs(x))) * sstep(190, 250, z);
}

/** The terrain mesh's height (see above). */
export function meshY(x: number, z: number) {
  if (z > 20000) return groundY(x, z);
  const s = homeShoreDist(x, z);
  if (s < 25) return groundY(x, z);
  let y = mainlandHill(x, z, s);
  const d = Math.hypot(x - PARK.x, z - PARK.z);
  y -= 0.05 * (1 - airportZone(x, z)) * (1 - sstep(1500, 1700, d));
  for (const c of COVERS) {
    const inset = Math.min(x - c.x0, c.x1 - x, z - c.z0, c.z1 - z);
    if (inset > 4) y = Math.min(y, -c.depth * sstep(4, 16, inset));
  }
  return y;
}

/** The ring row (0..4, fractional) and how hilly the ring is at (x, z): the walking view's distance tint. */
export function ringTint(x: number, z: number) {
  const d = Math.hypot(x - PARK.x, z - PARK.z);
  if (d < RADII[0]) return { row: 0, w: 0 };
  const { h, row } = ringHill(x, z, d);
  const far = d > 2600 ? 0 : farHill(x, z, d, homeShoreDist(x, z));
  const hill = Math.max(h * (1 - sstep(100, 260, z)) * (1 - sstep(860, 2600, d)), far);
  return { row, w: sstep(0.2, 2.5, hill) };
}

// ------------------------------------------------------------------------------------------------
// Land use. The shader paints it (terrain-shader.ts); these mirror its forest rule for the 3D trees.
// ------------------------------------------------------------------------------------------------

/** Villages on the mainland: centre, radius (m), and whether it's on the coast (lit windows at night). */
export const VILLAGES: { x: number; z: number; r: number; seed: number }[] = [
  // along the coast, east and west of the airport's approach corridors
  { x: -15800, z: 900, r: 420, seed: 1 },
  { x: 16600, z: 820, r: 460, seed: 2 },
  { x: -24500, z: 760, r: 330, seed: 3 },
  { x: 26200, z: 980, r: 360, seed: 4 },
  // inland, among the fields and the first hills
  { x: -6400, z: -2600, r: 380, seed: 5 },
  { x: 7200, z: -3400, r: 340, seed: 6 },
  { x: -3100, z: -7800, r: 300, seed: 7 },
  { x: 11800, z: -9200, r: 320, seed: 8 },
  { x: -12600, z: -5200, r: 360, seed: 9 },
  { x: 2600, z: -13800, r: 280, seed: 10 },
];

/**
 * The coast road: an east–west road 330 m inland of the water's edge which, past the airport,
 * swings north onto the line of the airport's own access road (z 270, see terminal-plan.ts) so
 * the two meet end to end. Painted into the land (terrain-shader.ts has the same formula).
 */
export const COAST_ROAD = { inland: 330, airportZ: 270, half: 4, join0: 3000, join1: 4800 };

/** The coast road's centreline z at x. */
export function coastRoadZ(x: number) {
  const R = COAST_ROAD;
  const along = homeCoastZ(x) - R.inland;
  return along + (R.airportZ - along) * (1 - sstep(R.join0, R.join1, Math.abs(x)));
}

/** Metres from (x, z) to the coast road's centreline (measured along z, scaled for the road's steepest swing). */
export function roadDist(x: number, z: number) {
  return Math.abs(z - coastRoadZ(x)) * 0.92;
}

/** How much forest is allowed at (x, z): none round the fair, on the coastal plain round the airport, by the sea or the road, or in a village. */
export function forestAllowed(x: number, z: number, s: number) {
  const park = sstep(1500, 2100, Math.hypot(x - PARK.x, z - PARK.z));
  // the coastal plain south of z 250 within 15 km of the airport: open fields under the approaches
  const plain = Math.max(sstep(14500, 15200, Math.abs(x)), 1 - sstep(150, 300, z));
  const coast = sstep(140, 260, s);
  let village = 1;
  for (const v of VILLAGES) {
    const d = Math.hypot(x - v.x, z - v.z);
    if (d < v.r + 80) village = Math.min(village, sstep(v.r, v.r + 80, d));
  }
  const road = sstep(14, 30, roadDist(x, z));
  return park * plain * coast * village * road;
}

/** The raw forest noise (0..1) at (x, z) for ground height h. */
export function forestNoise(x: number, z: number, h: number) {
  const rx = x * ROT_C - z * ROT_S;
  const rz = x * ROT_S + z * ROT_C;
  return (
    0.52 * noiseAt(x, z, 11300, 0) +
    0.33 * noiseAt(rx, rz, 6100, 1) +
    0.15 * noiseAt(x, z, 1700, 2) +
    0.08 * (noiseAt(x, z, 230, 3) - 0.5) +
    0.09 * sstep(15, 90, h)
  );
}

/** Forest cover at (x, z): 0..1 (≥ 0.5 counts as forest). */
export function forestAt(x: number, z: number, h: number, s = homeShoreDist(x, z)) {
  const allowed = forestAllowed(x, z, s);
  if (allowed <= 0) return 0;
  return sstep(0.575, 0.6, forestNoise(x, z, h)) * allowed;
}

// ------------------------------------------------------------------------------------------------
// Palm Cay's land use
// ------------------------------------------------------------------------------------------------

/**
 * Land kept clear of the jungle on Palm Cay: the airfield, the terminal and apron, the beach park
 * and the south beach. The clearings reach out a ragged 0–90 m further here and there, so the
 * jungle's edge is never a ruled line.
 */
export function islandClear(x: number, z: number) {
  const P = ISLAND.park;
  const rwZ = AIRPORTS.island.runway.z;
  const w = 90 * noiseAt(x, z, 700, 3);
  // the runway strip, the taxiway and the obstacle corridor beyond the ends
  const strip = Math.abs(z - rwZ) < 230 + w || (Math.abs(z - rwZ) < 330 + w && Math.abs(x) > 1250 - w);
  const apron = Math.abs(x) < 470 + w && z > 40400 && z < 40720 + w;
  const park = x > P.x0 - 40 - w && x < P.x1 + 40 + w && z > P.z0 - 40 && z < P.z1 + 60;
  const lagoonBeach = Math.abs(x) < 860 + w && z > ISLAND.beachZ - 60 - w;
  return strip || apron || park || lagoonBeach;
}

/** Jungle cover on Palm Cay (0..1), for shore distance d and ground height h. */
export function jungleAt(x: number, z: number, d: number, h: number) {
  if (d < 45 || islandClear(x, z)) return 0;
  const n = 0.6 * noiseAt(x, z, 2900, 1) + 0.4 * noiseAt(x, z, 700, 2) + 0.25 * sstep(5, 30, h);
  return sstep(0.37, 0.43, n) * sstep(45, 90, d);
}
