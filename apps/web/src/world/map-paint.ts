// The world from above, for the minimap and the full-screen map: the sea, the mainland's coast
// with its beach, the country, forests and villages, the fair, Funfair International, the
// SkyLink, and Palm Cay with its airport, beach park and lagoon. Pure vector painting onto a 2D
// canvas, so it reads at any scale; the land's cover (forests, jungle, hills) is sampled on a
// coarse grid and smoothed up, as the terrain's own shader blends it.
//
// Every painter takes `X` / `Z` (world metres → canvas pixels), `s` (pixels per metre) and the
// world box being painted, and leaves out whatever lies outside it.

import { PLOT_IDS, type PlotId } from '../account/api';
import { AIRFIELDS } from '../aviation/airports';
import { planAirfield, type AirfieldPlan } from './airport/airfield-plan';
import { ACCESS_ROAD, CAR_PARK, GARAGE, GATES, KERB_ROAD, LINK_ROADS, SKYLIGHTS, stationHall, TERM } from './airport/terminal-plan';
import { COURSE, DOCK, GATE_HALF, GATES as BUOY_GATES, coursePoint } from './attractions/island/jetski-course';
import { CIRCUIT, CIRCUIT_BOUNDS, circuitPoint, ROAD_HALF, START_S, WALL } from './attractions/speedway-track';
import { START_S as TRAIL_START, TRAIL, TRAIL_BOUNDS, TRAIL_HALF, trailPoint, WALL as TRAIL_WALL } from './attractions/trail-track';
import { AIRPORTS, HOME_COAST, ISLAND, ISLAND_SPOTS, SKYLINK, homeCoastZ, homeShoreDist, islandK, islandShoreDist, type Region } from './geo';
import { FAIR_DISTRICTS, FLIP_YAW, LAYOUT, MUSEUM, museumPoint, PARK, parkBounds, PATHS, PLAZAS, plotPoint, VALLEY } from './layout';
import { FALCON_TRACK, STACK_TRACK } from './rides';
import { coastRoadZ, forestAt, islandHill, jungleAt, mainlandHill, VILLAGES } from './terrain-land';
import { mulberry } from './random';
import { PALETTE } from './textures';

/** World metres → canvas pixels, along one axis. */
export type Axis = (v: number) => number;
/** A rectangle of the world (x0..x1 by z0..z1). */
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const meets = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
const grow = (b: Box, m: number): Box => ({ x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m });
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** The map's colours: the fair's own (lawn, paths) are in paintFair. */
export const MAP_COLOURS = {
  ocean: '#1d6c9c',
  sea: '#2b83b5',
  shallow: '#56b5d2',
  lagoon: '#43c6c4',
  reef: '#b5ecdf',
  surf: 'rgba(255, 255, 255, 0.7)',
  sand: '#ead6a0',
  wetSand: '#d6bb80',
  country: '#8db46a',
  mown: '#9cc177',
  forest: [52, 108, 60] as const,
  jungle: [34, 112, 70] as const,
  hill: [118, 112, 78] as const,
  village: '#d9c6a8',
  roof: '#b8644a',
  road: '#7d7a80',
  roadEdge: '#e8e2d6',
  pavement: '#86858b',
  asphalt: '#46454c',
  concrete: '#b1afad',
  roof2: '#e7e3db',
  ink: 'rgba(29, 18, 56, 0.6)',
  water: '#5cc4e0',
  boardwalk: '#b48858',
  paving: '#efe2c4',
};

// ------------------------------------------------------------------------------------------------
// Regions: what each map tab frames
// ------------------------------------------------------------------------------------------------

/** The area worth mapping round the fair: the park itself plus both coaster tracks, the kart circuit, the Rally Trail and Creators' Valley. */
export function fairBounds(): Box {
  const c = CIRCUIT_BOUNDS;
  const t = TRAIL_BOUNDS;
  const p = parkBounds();
  const [v] = VALLEY.lawns;
  let x0 = Math.min(p.x0, c.x0, t.x0, v.x0), x1 = Math.max(p.x1, c.x1, t.x1), z0 = Math.min(p.z0, c.z0, t.z0, v.z0), z1 = Math.max(p.z1, c.z1, t.z1, v.z1);
  for (const d of [STACK_TRACK, FALCON_TRACK])
    for (const q of d.pos) {
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      z0 = Math.min(z0, q.z);
      z1 = Math.max(z1, q.z);
    }
  return { x0, z0, x1, z1 };
}

/** What the map shows: one landmass, or the "World" overview with the sea between them. */
export type MapView = Region | 'world';

let regionBoxes: Record<MapView, Box> | null = null;
/** The box each map view frames: the fair with the airport and its coast; Palm Cay with its lagoon; both, and the sea between. */
export function regionBounds(r: MapView): Box {
  if (!regionBoxes) {
    const f = fairBounds();
    const rw = AIRPORTS.home.runway;
    const home = { x0: Math.min(f.x0, rw.x0 - rw.approachLights - 150), x1: Math.max(f.x1, rw.x1 + rw.approachLights + 150), z0: f.z0, z1: 1450 };
    const island = { x0: -2800, x1: 2800, z0: 39750, z1: 42400 };
    // the World's frame leaves room above the fair for the map's heading and below Palm Cay for its keys
    regionBoxes = { home, island, world: { x0: -16000, x1: 16000, z0: home.z0 - 5000, z1: island.z1 + 8000 } };
  }
  return regionBoxes[r];
}

/** Where each airport sits (its runway's middle), for the far views' labels and icons. */
export const AIRPORT_MARKS = (Object.keys(AIRPORTS) as Region[]).map((r) => {
  const rw = AIRPORTS[r].runway;
  return { region: r, icao: AIRPORTS[r].icao, name: AIRPORTS[r].name, x: (rw.x0 + rw.x1) / 2, z: rw.z };
});

// ------------------------------------------------------------------------------------------------
// Coastlines
// ------------------------------------------------------------------------------------------------

/**
 * Palm Cay's outline at a shore distance (0: the water's edge; positive: inland). islandK is a
 * norm divided by a wobble that depends only on the angle round the centre, so it grows in
 * proportion along each ray from the centre and the shoreline (k = 1) lies exactly 1 / islandK
 * of a unit step out. An inland line is the shoreline moved `inset` metres back along the ray:
 * the same as moving it square to the shore where the coast runs round the centre, and a little
 * less where it runs slantwise (a few metres at most on the beach-wide insets drawn here).
 */
const islandRings = new Map<number, Float64Array>();
function islandRing(inset: number) {
  let ring = islandRings.get(inset);
  if (ring) return ring;
  const N = 1440;
  ring = new Float64Array(N * 2);
  const { x: cx, z: cz } = ISLAND.centre;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const t = 1 / islandK(cx + dx, cz + dz);
    const r = t - inset;
    ring[i * 2] = cx + dx * r;
    ring[i * 2 + 1] = cz + dz * r;
  }
  islandRings.set(inset, ring);
  return ring;
}

function islandPath(g: CanvasRenderingContext2D, X: Axis, Z: Axis, inset: number) {
  const ring = islandRing(inset);
  g.beginPath();
  for (let i = 0; i < ring.length; i += 2) g.lineTo(X(ring[i]), Z(ring[i + 1]));
  g.closePath();
}

/** The mainland's water's edge (moved `inland` metres north) across the box, closed round the box's top. */
function mainlandPath(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number, box: Box, inland: number, closed: boolean) {
  const step = Math.max(2, 3 / s);
  g.beginPath();
  for (let x = box.x0 - step; x <= box.x1 + step; x += step) g.lineTo(X(x), Z(homeCoastZ(x) - inland));
  if (closed) {
    g.lineTo(X(box.x1 + step), Z(box.z0 - 50));
    g.lineTo(X(box.x0 - step), Z(box.z0 - 50));
    g.closePath();
  }
}

/** The mainland's coast lies south of here everywhere (and Palm Cay's land within these bounds). */
const MAINLAND_SOUTH = 1340;
const ISLAND_BOX: Box = { x0: ISLAND.centre.x - ISLAND.rx * 1.08, x1: ISLAND.centre.x + ISLAND.rx * 1.08, z0: ISLAND.centre.z - ISLAND.rz * 1.08, z1: ISLAND.centre.z + ISLAND.rz * 1.08 };
const LAGOON_BOX: Box = grow({ x0: ISLAND.lagoon.x0, x1: ISLAND.lagoon.x1, z0: ISLAND.lagoon.z0, z1: ISLAND.lagoon.z1 }, 140);

// ------------------------------------------------------------------------------------------------
// The whole world
// ------------------------------------------------------------------------------------------------

/**
 * Paints everything in `box`: the sea and its shallows, the land and beaches, the cover (when
 * `cover` is set: forests, jungle, hills, sampled at `cover` cells across), the roads and
 * villages, then the fair, the airports and Palm Cay's park on top.
 */
export function paintWorld(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number, box: Box, cover = 0) {
  g.save();
  g.lineCap = g.lineJoin = 'round';
  // the open sea, deeper further out
  g.fillStyle = MAP_COLOURS.sea;
  g.fillRect(X(box.x0), Z(box.z0), (box.x1 - box.x0) * s, (box.z1 - box.z0) * s);
  const home = box.z0 < MAINLAND_SOUTH;
  const isle = meets(box, grow(ISLAND_BOX, 900));
  // the shelf round each coast: bands of paler water, widest (and faintest) furthest out
  for (const [w, a] of [
    [900, 0.18],
    [420, 0.22],
    [180, 0.3],
    [70, 0.4],
  ] as const) {
    if (w * s < 1.5) continue;
    g.strokeStyle = MAP_COLOURS.shallow;
    g.globalAlpha = a;
    g.lineWidth = w * 2 * s;
    if (home) {
      mainlandPath(g, X, Z, s, box, 0, false);
      g.stroke();
    }
    if (isle) {
      islandPath(g, X, Z, 0);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  if (meets(box, LAGOON_BOX)) paintLagoon(g, X, Z, s);

  // the land: sand from the water's edge, then the grass beyond the beach
  if (home) {
    g.fillStyle = MAP_COLOURS.sand;
    mainlandPath(g, X, Z, s, box, 0, true);
    g.fill();
    g.fillStyle = MAP_COLOURS.country;
    mainlandPath(g, X, Z, s, box, HOME_COAST.beach - 18, true);
    g.fill();
  }
  if (isle) {
    g.fillStyle = MAP_COLOURS.sand;
    islandPath(g, X, Z, 0);
    g.fill();
    g.fillStyle = MAP_COLOURS.country;
    islandPath(g, X, Z, 28);
    g.fill();
    // the south beach in front of the park and the lagoon is a broad one
    g.save();
    islandPath(g, X, Z, 0);
    g.clip();
    g.fillStyle = MAP_COLOURS.sand;
    g.beginPath();
    const bz = ISLAND.beachZ;
    for (let x = -880; x <= 880; x += 20) g.lineTo(X(x), Z(bz - 30 + 30 * sstep(520, 880, Math.abs(x)) + 6 * Math.sin(x / 37)));
    g.lineTo(X(880), Z(ISLAND.lagoon.z0 + 200));
    g.lineTo(X(-880), Z(ISLAND.lagoon.z0 + 200));
    g.closePath();
    g.fill();
    g.restore();
  }
  // the wet sand and the surf line at the water's edge
  if (6 * s > 0.8) {
    for (const [colour, w] of [
      [MAP_COLOURS.wetSand, 9],
      [MAP_COLOURS.surf, 2.2],
    ] as const) {
      g.strokeStyle = colour;
      g.lineWidth = Math.max(w * s, colour === MAP_COLOURS.surf ? 0.8 : 1);
      if (home) {
        mainlandPath(g, X, Z, s, box, colour === MAP_COLOURS.surf ? -1.5 : 3, false);
        g.stroke();
      }
      if (isle) {
        islandPath(g, X, Z, colour === MAP_COLOURS.surf ? -1.5 : 3);
        g.stroke();
      }
    }
  }

  if (cover > 0) paintCover(g, X, Z, s, box, cover);
  if (home) paintCountry(g, X, Z, s, box);

  const fair = grow(fairBounds(), 20);
  if (meets(box, fair)) paintFair(g, X, Z, s);
  for (const r of ['home', 'island'] as const) if (meets(box, airportBox(r))) paintAirport(g, X, Z, s, r);
  if (meets(box, { x0: SKYLINK.park.x - 20, x1: SKYLINK.park.x + 20, z0: SKYLINK.park.z - 20, z1: SKYLINK.airport.z + 20 })) paintSkyLink(g, X, Z, s);
  if (meets(box, grow({ ...ISLAND.park }, 120))) paintPalmCay(g, X, Z, s);
  if (meets(box, LAGOON_BOX)) paintRaceCourse(g, X, Z, s);
  if (extras.length) paintExtras(g, X, Z, s, box);
  g.restore();
}

/** Palm Cay's lagoon: turquoise water inside the reef, the reef's pale crest round its south, east and west. */
function paintLagoon(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  const L = ISLAND.lagoon;
  const r = 160;
  // the lagoon's rounded rectangle grown by `out`; `open` leaves out its north side (it opens onto the beach)
  const rounded = (out: number, open: boolean) => {
    const x0 = L.x0 - out;
    const x1 = L.x1 + out;
    const z0 = L.z0 - out;
    const z1 = L.z1 + out;
    const rr = (r + out) * s;
    g.beginPath();
    if (open) {
      g.moveTo(X(x0), Z(L.z0 + 30));
      g.arcTo(X(x0), Z(z1), X(x1), Z(z1), rr);
      g.arcTo(X(x1), Z(z1), X(x1), Z(z0), rr);
      g.lineTo(X(x1), Z(L.z0 + 30));
      return;
    }
    g.moveTo(X(x0), Z(z0 + r + out));
    g.arcTo(X(x0), Z(z0), X(x1), Z(z0), rr);
    g.arcTo(X(x1), Z(z0), X(x1), Z(z1), rr);
    g.arcTo(X(x1), Z(z1), X(x0), Z(z1), rr);
    g.arcTo(X(x0), Z(z1), X(x0), Z(z0), rr);
    g.closePath();
  };
  g.fillStyle = MAP_COLOURS.lagoon;
  rounded(0, false);
  g.fill();
  // the lagoon runs on up to the beach (its north side opens onto the shallows)
  g.fillRect(X(L.x0 + r * 0.4), Z(L.z0 - 90), (L.x1 - L.x0 - r * 0.8) * s, 120 * s);
  // the reef: a darker drop-off beyond, then its pale crest
  g.strokeStyle = 'rgba(16, 78, 120, 0.35)';
  g.lineWidth = Math.max(1, 60 * s);
  rounded(70, true);
  g.stroke();
  g.strokeStyle = MAP_COLOURS.reef;
  g.lineWidth = Math.max(1, 26 * s);
  rounded(28, true);
  g.stroke();
  if (s > 0.3) {
    // breakers along the crest
    g.strokeStyle = MAP_COLOURS.surf;
    g.lineWidth = Math.max(0.8, 2.5 * s);
    g.setLineDash([14 * s, 22 * s]);
    rounded(44, true);
    g.stroke();
    g.setLineDash([]);
  }
}

// ------------------------------------------------------------------------------------------------
// The land's cover: sampled on a grid and smoothed, like the terrain's own blend
// ------------------------------------------------------------------------------------------------

let coverCanvas: HTMLCanvasElement | null = null;
/** The samples (premultiplied r, g, b and alpha) and a scratch row for the blur, reused tile to tile. */
let coverGrid = new Float32Array(0);
let coverTmp = new Float32Array(0);

/** The cover at one point: premultiplied colour and alpha written into `out` at `o`. */
function coverAt(out: Float32Array, o: number, x: number, z: number) {
  let r = 0;
  let gg = 0;
  let b = 0;
  let a = 0;
  if (z > 20000) {
    const sd = islandShoreDist(x, z);
    if (sd > 25) {
      const h = islandHill(x, z, sd);
      const k = jungleAt(x, z, sd, h);
      if (k > 0) [r, gg, b, a] = [...MAP_COLOURS.jungle, k * 0.9];
      const t = sstep(8, 50, h) * 0.45;
      if (t > 0) [r, gg, b, a] = [r * (1 - t) + MAP_COLOURS.hill[0] * t * 0.6, gg * (1 - t) + MAP_COLOURS.hill[1] * t * 0.6, b * (1 - t) + MAP_COLOURS.hill[2] * t * 0.6, Math.max(a, t)];
    }
  } else {
    const sd = homeShoreDist(x, z);
    if (sd > 25) {
      const h = mainlandHill(x, z, sd);
      const k = forestAt(x, z, h, sd);
      if (k > 0) [r, gg, b, a] = [...MAP_COLOURS.forest, k * 0.85];
      const t = sstep(20, 260, h) * 0.6;
      if (t > 0) {
        const w = a > 0 ? t * 0.5 : 1;
        [r, gg, b, a] = [r * (1 - w) + MAP_COLOURS.hill[0] * w, gg * (1 - w) + MAP_COLOURS.hill[1] * w, b * (1 - w) + MAP_COLOURS.hill[2] * w, Math.max(a, t)];
      }
    }
  }
  a = clamp01(a);
  out[o] = r * a;
  out[o + 1] = gg * a;
  out[o + 2] = b * a;
  out[o + 3] = a;
}

/**
 * Forests, Palm Cay's jungle and the hills' tint, as `n` × `n` samples over the box. The grid
 * reaches one sample past the box on every side and is blurred (a 1-2-1 pass each way) before
 * it's drawn: a stretched raster's hard steps would show as stairs at a coarse level, and the
 * margin means neighbouring tiles blur over the same samples, so no seam shows between them.
 */
function paintCover(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number, box: Box, n: number) {
  const N = n + 2;
  if (coverGrid.length !== N * N * 4) {
    coverGrid = new Float32Array(N * N * 4);
    coverTmp = new Float32Array(N * 4);
  }
  const grid = coverGrid;
  const fx = (box.x1 - box.x0) / n;
  const fz = (box.z1 - box.z0) / n;
  let any = false;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const o = (j * N + i) * 4;
      coverAt(grid, o, box.x0 + (i - 0.5) * fx, box.z0 + (j - 0.5) * fz);
      if (grid[o + 3] > 0) any = true;
    }
  if (!any) return;
  // the blur, along the rows and then the columns (the outermost samples only feed their neighbours)
  const tmp = coverTmp;
  for (const [step, line] of [
    [4, N * 4],
    [N * 4, 4],
  ]) {
    for (let l = 0; l < N; l++) {
      const base = l * line;
      for (let k = 1; k < N - 1; k++)
        for (let c = 0; c < 4; c++) {
          const o = base + k * step + c;
          tmp[k * 4 + c] = (grid[o - step] + 2 * grid[o] + grid[o + step]) * 0.25;
        }
      for (let k = 1; k < N - 1; k++) for (let c = 0; c < 4; c++) grid[base + k * step + c] = tmp[k * 4 + c];
    }
  }
  const c = (coverCanvas ??= document.createElement('canvas'));
  if (c.width !== n) c.width = c.height = n;
  const cg = c.getContext('2d')!;
  const img = cg.createImageData(n, n);
  const d = img.data;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const o = ((j + 1) * N + i + 1) * 4;
      const a = grid[o + 3];
      if (a <= 0.002) continue;
      const p = (j * n + i) * 4;
      d[p] = grid[o] / a;
      d[p + 1] = grid[o + 1] / a;
      d[p + 2] = grid[o + 2] / a;
      d[p + 3] = Math.round(a * 255);
    }
  cg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, X(box.x0), Z(box.z0), (box.x1 - box.x0) * s, (box.z1 - box.z0) * s);
}

/** The mainland's coast road and its villages. */
function paintCountry(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number, box: Box) {
  // the coast road (it becomes the airport's access road in front of the terminal)
  const step = Math.max(4, 4 / s);
  const road = () => {
    g.beginPath();
    for (let x = box.x0 - step; x <= box.x1 + step; x += step) g.lineTo(X(x), Z(coastRoadZ(x)));
  };
  g.strokeStyle = MAP_COLOURS.roadEdge;
  g.lineWidth = Math.max(1.2, 11 * s);
  road();
  g.stroke();
  g.strokeStyle = MAP_COLOURS.road;
  g.lineWidth = Math.max(0.8, 8 * s);
  road();
  g.stroke();
  // villages: a square of streets and red roofs round each centre
  for (const v of VILLAGES) {
    if (!meets(box, { x0: v.x - v.r, x1: v.x + v.r, z0: v.z - v.r, z1: v.z + v.r })) continue;
    g.fillStyle = MAP_COLOURS.village;
    g.beginPath();
    g.arc(X(v.x), Z(v.z), v.r * 0.85 * s, 0, Math.PI * 2);
    g.fill();
    if (s < 0.08) continue;
    const rnd = mulberry(v.seed * 31 + 7);
    g.fillStyle = MAP_COLOURS.roof;
    const n = Math.round((v.r / 26) ** 2);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * v.r * 0.8;
      const w = 8 + rnd() * 9;
      g.fillRect(X(v.x + Math.cos(a) * r), Z(v.z + Math.sin(a) * r), Math.max(1, w * s), Math.max(1, w * 0.7 * s));
    }
  }
}

// ------------------------------------------------------------------------------------------------
// The airports
// ------------------------------------------------------------------------------------------------

const plans: Partial<Record<Region, AirfieldPlan>> = {};
/** The airfield's plan (worked out once, the first time the map needs it). */
function planOf(r: Region) {
  return (plans[r] ??= planAirfield(AIRFIELDS[r]));
}

/** The box an airport's painting covers: its fenced field, the approach lights and the landside. */
function airportBox(r: Region): Box {
  const rw = AIRPORTS[r].runway;
  const t = AIRPORTS[r].terminal;
  return {
    x0: rw.x0 - rw.approachLights - 80,
    x1: rw.x1 + rw.approachLights + 80,
    z0: Math.min(rw.z - rw.strip - 120, t.z0 - (r === 'home' ? 200 : 20)),
    z1: Math.max(rw.z + rw.strip + 120, t.z1 + 20),
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** An airport from above: the mown strip, the pavement, its paint and lettering, the approach lights, the terminal. */
function paintAirport(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number, r: Region) {
  const plan = planOf(r);
  const geo = AIRPORTS[r];
  const rw = geo.runway;
  // the fenced field and the mown runway strip
  const f = plan.fence;
  g.fillStyle = MAP_COLOURS.mown;
  g.globalAlpha = 0.55;
  g.fillRect(X(f.x0), Z(f.z0), (f.x1 - f.x0) * s, (f.z1 - f.z0) * s);
  g.globalAlpha = 1;
  g.fillStyle = MAP_COLOURS.mown;
  g.fillRect(X(rw.x0 - 60), Z(rw.z - rw.strip), (rw.x1 - rw.x0 + 120) * s, rw.strip * 2 * s);
  // the approach light corridors
  g.fillRect(X(plan.als.x0), Z(rw.z - plan.als.half), (rw.x0 - plan.als.x0) * s, plan.als.half * 2 * s);
  g.fillRect(X(rw.x1), Z(rw.z - plan.als.half), (plan.als.x1 - rw.x1) * s, plan.als.half * 2 * s);
  if (s > 0.15) {
    g.strokeStyle = 'rgba(29, 18, 56, 0.35)';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.strokeRect(X(f.x0), Z(f.z0), (f.x1 - f.x0) * s, (f.z1 - f.z0) * s);
    g.setLineDash([]);
  }
  // the security road inside the fence
  if (s > 0.2 && plan.road.length) {
    g.strokeStyle = 'rgba(125, 122, 128, 0.8)';
    g.lineWidth = Math.max(1, 5 * s);
    g.beginPath();
    for (const p of plan.road) g.lineTo(X(p.x), Z(p.z));
    g.closePath();
    g.stroke();
  }

  // the pavement: taxiways, fillets and shoulders, then the runway's asphalt and the apron's concrete
  g.fillStyle = g.strokeStyle = MAP_COLOURS.pavement;
  for (const feat of plan.features)
    for (const p of feat.parts) {
      if (p.kind === 'box') {
        roundRect(g, X(p.x0), Z(p.z0), (p.x1 - p.x0) * s, (p.z1 - p.z0) * s, p.r * s);
        g.fill();
      } else {
        g.lineWidth = Math.max(1, p.r * 2 * s);
        g.beginPath();
        g.moveTo(X(p.a.x), Z(p.a.z));
        g.lineTo(X(p.b.x), Z(p.b.z));
        g.stroke();
      }
    }
  const ap = plan.apron;
  g.fillStyle = MAP_COLOURS.concrete;
  g.fillRect(X(ap.x0), Z(ap.z0), (ap.x1 - ap.x0) * s, (ap.z1 - ap.z0) * s);
  const half = rw.width / 2;
  g.fillStyle = MAP_COLOURS.asphalt;
  g.fillRect(X(rw.x0 - 60), Z(rw.z - half - rw.shoulder), (rw.x1 - rw.x0 + 120) * s, (half + rw.shoulder) * 2 * s);
  g.fillStyle = '#3a3940';
  g.fillRect(X(rw.x0), Z(rw.z - half), (rw.x1 - rw.x0) * s, half * 2 * s);

  // the paint: runway markings white, taxi lines yellow, holding bars red (only once they'd show)
  if (s >= 0.3) {
    for (const [list, colour, min] of [
      [plan.white, '#f4f4f0', 0.5],
      [plan.yellow, '#ffd21f', 0.6],
      [plan.red, '#d8222f', 0.6],
    ] as const) {
      g.strokeStyle = colour;
      g.beginPath();
      let w = -1;
      for (const st of list) {
        const lw = Math.max(min, st.w * s);
        if (lw !== w) {
          if (w >= 0) g.stroke();
          g.beginPath();
          g.lineWidth = w = lw;
        }
        g.moveTo(X(st.a.x), Z(st.a.z));
        g.lineTo(X(st.b.x), Z(st.b.z));
      }
      g.stroke();
    }
  } else {
    // far out: just the runway's centreline
    g.strokeStyle = 'rgba(244, 244, 240, 0.8)';
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(X(rw.x0 + 60), Z(rw.z));
    g.lineTo(X(rw.x1 - 60), Z(rw.z));
    g.stroke();
    g.setLineDash([]);
  }
  // the pavement's lettering: stand numbers, holding point designations
  if (s >= 1.2)
    for (const d of plan.decals) {
      g.save();
      g.translate(X(d.x), Z(d.z));
      g.rotate((d.heading * Math.PI) / 180);
      if (d.bg) {
        g.fillStyle = d.bg;
        g.fillRect((-d.w / 2) * s, (-d.l / 2) * s, d.w * s, d.l * s);
      }
      g.fillStyle = d.fg;
      g.font = `700 ${Math.max(6, d.l * 0.8 * s)}px "DM Sans", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(d.text, 0, d.l * 0.05 * s, d.w * s);
      g.restore();
    }
  // the approach lights' bars
  if (s >= 0.25) {
    g.fillStyle = '#fff3c4';
    for (const a of plan.alsStations) g.fillRect(X(a.x) - 1, Z(a.z - a.half), Math.max(1.5, 1.2 * s), Math.max(1.5, a.half * 2 * s));
  }
  if (r === 'home') paintHomeTerminal(g, X, Z, s);
  else paintIslandTerminal(g, X, Z, s);
}

/** Funfair International's terminal, its gates' bridges and the forecourt (roads, kerb, car parks). */
function paintHomeTerminal(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  const rect = (b: Box, fill: string) => {
    g.fillStyle = fill;
    g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * s, (b.z1 - b.z0) * s);
  };
  // the access road and the link roads down to the kerb
  g.strokeStyle = MAP_COLOURS.road;
  g.lineWidth = Math.max(1, ACCESS_ROAD.half * 2 * s);
  g.beginPath();
  g.moveTo(X(LINK_ROADS.west), Z(ACCESS_ROAD.z));
  g.lineTo(X(LINK_ROADS.east), Z(ACCESS_ROAD.z));
  g.stroke();
  g.lineWidth = Math.max(1, LINK_ROADS.half * 2 * s);
  for (const x of [LINK_ROADS.west, LINK_ROADS.east]) {
    g.beginPath();
    g.moveTo(X(x), Z(ACCESS_ROAD.z));
    g.lineTo(X(x), Z((KERB_ROAD.z0 + KERB_ROAD.z1) / 2));
    g.stroke();
  }
  rect({ x0: KERB_ROAD.x0, x1: KERB_ROAD.x1, z0: KERB_ROAD.z0, z1: KERB_ROAD.z1 }, MAP_COLOURS.road);
  // the kerb walk under the roof's overhang
  rect({ x0: TERM.x0 - 8, x1: TERM.x1 + 8, z0: KERB_ROAD.z1, z1: TERM.z0 }, MAP_COLOURS.concrete);
  // the surface car park, with its rows of bays
  rect(CAR_PARK, '#6f6e74');
  if (s >= 0.8) {
    g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    g.lineWidth = 1;
    g.beginPath();
    for (let z = CAR_PARK.z0 + 8; z < CAR_PARK.z1 - 4; z += 15)
      for (let x = CAR_PARK.x0 + 3; x < CAR_PARK.x1 - 2; x += 2.6) {
        g.moveTo(X(x), Z(z));
        g.lineTo(X(x), Z(z + 5));
      }
    g.stroke();
  }
  // the multi-storey (its top deck), and the forecourt's planting between
  rect(GARAGE, '#9e9ca0');
  if (s >= 0.5) {
    g.strokeStyle = 'rgba(29, 18, 56, 0.4)';
    g.lineWidth = 1;
    g.strokeRect(X(GARAGE.x0), Z(GARAGE.z0), (GARAGE.x1 - GARAGE.x0) * s, (GARAGE.z1 - GARAGE.z0) * s);
  }
  // the terminal's roof, its skylights, and the bridges out to the stands
  roundRect(g, X(TERM.x0), Z(TERM.z0), (TERM.x1 - TERM.x0) * s, (TERM.z1 - TERM.z0) * s, 6 * s);
  g.fillStyle = MAP_COLOURS.roof2;
  g.fill();
  g.strokeStyle = MAP_COLOURS.ink;
  g.lineWidth = Math.max(1, 0.8 * s);
  g.stroke();
  if (s >= 0.4) {
    g.fillStyle = '#a9d4ea';
    for (const k of SKYLIGHTS) g.fillRect(X(k.x0), Z(k.z0), (k.x1 - k.x0) * s, (k.z1 - k.z0) * s);
  }
  if (s >= 0.6) {
    g.strokeStyle = '#d6d2ca';
    g.lineWidth = Math.max(1, 3 * s);
    for (const gt of GATES) {
      // the fixed link and the bridge itself, from the rotunda out to the aircraft's door
      g.beginPath();
      g.moveTo(X(gt.doorwayX), Z(TERM.z1));
      g.lineTo(X(gt.rotunda.x), Z(gt.rotunda.z));
      g.lineTo(X(gt.stand.x - 2), Z(gt.stand.z - 6));
      g.stroke();
      g.fillStyle = '#d6d2ca';
      g.beginPath();
      g.arc(X(gt.rotunda.x), Z(gt.rotunda.z), Math.max(1.5, 2.6 * s), 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** Palm Cay's thatched terminal and its canopy onto the arrivals plaza. */
function paintIslandTerminal(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  const t = AIRPORTS.island.terminal;
  roundRect(g, X(t.x0), Z(t.z0), (t.x1 - t.x0) * s, (t.z1 - t.z0) * s, 4 * s);
  g.fillStyle = '#c99f62';
  g.fill();
  g.strokeStyle = MAP_COLOURS.ink;
  g.lineWidth = Math.max(1, 0.8 * s);
  g.stroke();
  if (s >= 0.5) {
    // the thatch's ridges
    g.strokeStyle = 'rgba(120, 82, 40, 0.5)';
    g.lineWidth = Math.max(1, 0.6 * s);
    g.beginPath();
    for (let x = t.x0 + 6; x < t.x1; x += 13) {
      g.moveTo(X(x), Z(t.z0 + 2));
      g.lineTo(X(x), Z(t.z1 - 2));
    }
    g.stroke();
  }
}

/** The SkyLink: its guideway on piers from the fair's station south to the airport's. */
function paintSkyLink(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  const p = SKYLINK.park;
  const a = SKYLINK.airport;
  for (const [colour, w] of [
    ['rgba(29, 18, 56, 0.45)', 8.5],
    ['#dcd9d2', 7],
  ] as const) {
    g.strokeStyle = colour;
    g.lineWidth = Math.max(w === 7 ? 2 : 3, w * s);
    g.beginPath();
    g.moveTo(X(p.x), Z(p.z));
    g.lineTo(X(a.x), Z(a.z));
    g.stroke();
  }
  if (s >= 0.8) {
    // the two lanes
    g.strokeStyle = 'rgba(29, 18, 56, 0.35)';
    g.lineWidth = Math.max(1, 0.5 * s);
    for (const dx of [-1.8, 1.8]) {
      g.beginPath();
      g.moveTo(X(p.x + dx), Z(p.z));
      g.lineTo(X(a.x + dx), Z(a.z));
      g.stroke();
    }
  }
  for (const c of [p, a]) {
    const h = stationHall(c);
    roundRect(g, X(h.x0), Z(h.z0), (h.x1 - h.x0) * s, (h.z1 - h.z0) * s, 2 * s);
    g.fillStyle = '#e9f2f6';
    g.fill();
    g.strokeStyle = PALETTE.teal;
    g.lineWidth = Math.max(1.2, 1.2 * s);
    g.stroke();
  }
}

// ------------------------------------------------------------------------------------------------
// Palm Cay's beach park (as island.ts lays it out) and the jet-ski course
// ------------------------------------------------------------------------------------------------

const ISLE = {
  arrivals: { x0: -70, x1: 70, z0: 40672.5, z1: 40742 },
  prom: { z0: 40742, z1: 41146, half: 13 },
  plaza: { ...ISLAND_SPOTS.plaza, r: 38 },
  beachWalkZ: 41436,
  pierX: 330,
  pool: { x: -300, z: 40930, r: 15 },
  lawn: { x: 285, z: 40960, r: 34 },
};

/** The paths from the Beach Plaza to the games and along the beach: points, width, and boardwalk (timber) or paving. */
const ISLE_PATHS: { pts: [number, number][]; w: number; timber: boolean }[] = (() => {
  const { x, z, r } = ISLE.plaza;
  return [
    { pts: [[x - r + 1, z - 4], [-120, 41166], [-182, 41152]], w: 5, timber: false },
    { pts: [[x - 27, z + 26], [-110, 41290], [-215, 41352], [-312, 41398]], w: 3.2, timber: true },
    { pts: [[x + 27, z + 26], [105, 41300], [160, 41390]], w: 3.2, timber: true },
    { pts: [[x, z + r - 1], [x, 41330], [48, 41410], [58, 41437]], w: 3.6, timber: true },
    { pts: [[-305, ISLE.beachWalkZ], [22, ISLE.beachWalkZ]], w: 3, timber: true },
    { pts: [[98, ISLE.beachWalkZ], [490, ISLE.beachWalkZ]], w: 3, timber: true },
    { pts: [[-23, 40896], [-120, 40900], [ISLE.pool.x + ISLE.pool.r + 9, ISLE.pool.z - 6]], w: 3.4, timber: false },
    { pts: [[23, 40948], [140, 40955], [ISLE.lawn.x - 34, ISLE.lawn.z]], w: 3.4, timber: false },
    { pts: [[ISLE.pierX, ISLE.beachWalkZ + 1.5], [ISLE.pierX, 41545]], w: 3.2, timber: true },
  ];
})();

function paintPalmCay(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  const line = (pts: [number, number][], w: number, colour: string, min = 1) => {
    g.strokeStyle = colour;
    g.lineWidth = Math.max(min, w * s);
    g.beginPath();
    for (const [x, z] of pts) g.lineTo(X(x), Z(z));
    g.stroke();
  };
  const disc = (x: number, z: number, r: number, colour: string) => {
    g.fillStyle = colour;
    g.beginPath();
    g.arc(X(x), Z(z), Math.max(1, r * s), 0, Math.PI * 2);
    g.fill();
  };
  // the arrivals plaza, the Palm Promenade and the Beach Plaza with its fountain
  const a = ISLE.arrivals;
  g.fillStyle = MAP_COLOURS.paving;
  g.fillRect(X(a.x0), Z(a.z0), (a.x1 - a.x0) * s, (a.z1 - a.z0) * s);
  g.fillRect(X(-ISLE.prom.half), Z(ISLE.prom.z0), ISLE.prom.half * 2 * s, (ISLE.prom.z1 - ISLE.prom.z0) * s);
  disc(ISLE.plaza.x, ISLE.plaza.z, ISLE.plaza.r, MAP_COLOURS.paving);
  disc(ISLE.plaza.x, ISLE.plaza.z, 9, MAP_COLOURS.water);
  if (s >= 0.5) {
    // the promenade's palms, down both sides
    g.fillStyle = '#3f8f4f';
    for (let z = ISLE.prom.z0 + 8; z < ISLE.prom.z1; z += 16)
      for (const x of [-8.5, 8.5]) {
        g.beginPath();
        g.arc(X(x), Z(z), Math.max(1, 2.6 * s), 0, Math.PI * 2);
        g.fill();
      }
  }
  // the pool and the lawn in the gardens
  disc(ISLE.lawn.x, ISLE.lawn.z, ISLE.lawn.r, MAP_COLOURS.mown);
  disc(ISLE.pool.x, ISLE.pool.z, ISLE.pool.r + 3, MAP_COLOURS.paving);
  disc(ISLE.pool.x, ISLE.pool.z, ISLE.pool.r, MAP_COLOURS.water);
  // the paths and boardwalks
  for (const p of ISLE_PATHS) line(p.pts, p.w, p.timber ? MAP_COLOURS.boardwalk : MAP_COLOURS.paving);
  // the pier's gazebo
  disc(ISLE.pierX, 41549, 4.3, MAP_COLOURS.boardwalk);

  // the games' grounds round their anchors
  const sl = ISLAND_SPOTS.slides;
  disc(sl.x, sl.z + 32, 16, MAP_COLOURS.paving);
  disc(sl.x, sl.z + 32, 13, MAP_COLOURS.water);
  g.fillStyle = '#ef6f5e';
  g.fillRect(X(sl.x - 7), Z(sl.z - 7), 14 * s, 14 * s);
  const cn = ISLAND_SPOTS.cannons;
  g.fillStyle = '#b9a07a';
  g.beginPath();
  for (let k = 0; k < 5; k++) {
    const ang = -Math.PI / 2 + (k / 5) * Math.PI * 2;
    g.lineTo(X(cn.x + Math.cos(ang) * 22), Z(cn.z + Math.sin(ang) * 22));
  }
  g.closePath();
  g.fill();
  g.strokeStyle = MAP_COLOURS.ink;
  g.lineWidth = Math.max(1, 0.8 * s);
  g.stroke();
  const vb = ISLAND_SPOTS.volley;
  g.fillStyle = '#f3dfa8';
  g.fillRect(X(vb.x - 8 - 3), Z(vb.z - 4 - 3), 22 * s, 14 * s);
  if (s >= 0.6) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1, 0.12 * s);
    g.strokeRect(X(vb.x - 8), Z(vb.z - 4), 16 * s, 8 * s);
    g.beginPath();
    g.moveTo(X(vb.x), Z(vb.z - 4.6));
    g.lineTo(X(vb.x), Z(vb.z + 4.6));
    g.strokeStyle = '#1d1238';
    g.stroke();
  }
}

/** The Jet-Ski Race's dock and its buoy course in the lagoon. */
function paintRaceCourse(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  // the dock's walkway and its pontoon
  g.strokeStyle = MAP_COLOURS.boardwalk;
  g.lineWidth = Math.max(1, DOCK.half * 2 * s);
  g.beginPath();
  g.moveTo(X(DOCK.x), Z(DOCK.z0));
  g.lineTo(X(DOCK.x), Z(DOCK.z1));
  g.stroke();
  const pt = DOCK.pontoon;
  g.fillStyle = MAP_COLOURS.boardwalk;
  g.fillRect(X(pt.x0), Z(pt.z0), (pt.x1 - pt.x0) * s, (pt.z1 - pt.z0) * s);
  // the racing line, faint, and the gates' buoys
  g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  g.lineWidth = Math.max(1, 3 * s);
  g.setLineDash([6 * Math.max(1, s), 6 * Math.max(1, s)]);
  g.beginPath();
  for (let i = 0; i <= COURSE.n; i++) g.lineTo(X(COURSE.px[i % COURSE.n]), Z(COURSE.pz[i % COURSE.n]));
  g.stroke();
  g.setLineDash([]);
  if (s < 0.25) return;
  const p = { x: 0, z: 0, tx: 0, tz: 0 };
  for (const gate of BUOY_GATES)
    for (const side of [-1, 1]) {
      coursePoint(gate.s, side * GATE_HALF, p);
      g.fillStyle = gate.start ? '#ffffff' : side < 0 ? '#ff6b1a' : '#ffd23f';
      g.beginPath();
      g.arc(X(p.x), Z(p.z), Math.max(1.6, 1.2 * s), 0, Math.PI * 2);
      g.fill();
    }
}

// ------------------------------------------------------------------------------------------------
// Buildings registered later (the airside's hangars, tower, cargo sheds…)
// ------------------------------------------------------------------------------------------------

/** A building's footprint for the maps: an axis-aligned rectangle, or a circle (radius `r`). */
export type MapShape = { x0: number; x1: number; z0: number; z1: number; colour?: string } | { x: number; z: number; r: number; colour?: string };
const extras: MapShape[] = [];

/**
 * Adds buildings to the maps (the airside's hangars, the tower, the fire station…) from the module
 * that builds them. Call `onMapChange` listeners afterwards so the maps repaint (see addMapShapes in minimap.ts).
 */
export function pushMapShapes(shapes: readonly MapShape[]) {
  extras.push(...shapes);
}

function paintExtras(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number, box: Box) {
  for (const sh of extras) {
    g.fillStyle = sh.colour ?? '#c9c6c0';
    g.strokeStyle = MAP_COLOURS.ink;
    g.lineWidth = Math.max(1, 0.6 * s);
    if ('r' in sh) {
      if (!meets(box, { x0: sh.x - sh.r, x1: sh.x + sh.r, z0: sh.z - sh.r, z1: sh.z + sh.r })) continue;
      g.beginPath();
      g.arc(X(sh.x), Z(sh.z), Math.max(1, sh.r * s), 0, Math.PI * 2);
    } else {
      if (!meets(box, sh)) continue;
      g.beginPath();
      g.rect(X(sh.x0), Z(sh.z0), (sh.x1 - sh.x0) * s, (sh.z1 - sh.z0) * s);
    }
    g.fill();
    if (s > 0.3) g.stroke();
  }
}

// ------------------------------------------------------------------------------------------------
// The fair
// ------------------------------------------------------------------------------------------------

/** The released coasters' tracks, seen from above (world x, z), by plot. */
const valleyTracks = new Map<PlotId, { pts: [number, number][]; color: string }>();

/** A coaster opened on a plot (its track from above), or the plot emptied (null). */
export function setValleyTrack(id: PlotId, track: { pts: [number, number][]; color: string } | null) {
  if (track) valleyTracks.set(id, track);
  else valleyTracks.delete(id);
}

/**
 * Paints the fair from above: lawn, paths, plazas, coaster tracks and the big rides.
 * `X` / `Z` map world metres to canvas pixels and `s` is pixels per metre.
 */
export function paintFair(g: CanvasRenderingContext2D, X: Axis, Z: Axis, s: number) {
  g.save();
  // Creators' Valley's lawn out past the west fence, and its eight plots (the road is one of the paths)
  g.fillStyle = '#5c9a4e';
  for (const v of VALLEY.lawns) g.fillRect(X(v.x0), Z(v.z0), (v.x1 - v.x0) * s, (v.z1 - v.z0) * s);
  for (let n = 1; n <= PLOT_IDS.length; n++) {
    const a = plotPoint(n, -VALLEY.size / 2, -VALLEY.size / 2);
    const b = plotPoint(n, VALLEY.size / 2, VALLEY.size / 2);
    g.fillStyle = 'rgba(29, 18, 56, 0.12)';
    g.fillRect(X(Math.min(a.x, b.x)), Z(Math.min(a.z, b.z)), VALLEY.size * s, VALLEY.size * s);
    g.strokeStyle = 'rgba(224, 90, 168, 0.7)';
    g.lineWidth = Math.max(1, 0.8 * s);
    g.setLineDash([3 * s, 2 * s]);
    g.strokeRect(X(Math.min(a.x, b.x)), Z(Math.min(a.z, b.z)), VALLEY.size * s, VALLEY.size * s);
    g.setLineDash([]);
  }

  // the fair's lawn
  g.fillStyle = '#5c9a4e';
  g.beginPath();
  g.arc(X(PARK.x), Z(PARK.z), PARK.r * s, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(29, 18, 56, 0.55)';
  g.lineWidth = Math.max(1, 1.2 * s);
  g.stroke();

  // footpaths + plazas
  g.strokeStyle = g.fillStyle = '#efdcb6';
  g.lineCap = g.lineJoin = 'round';
  for (const p of PATHS) {
    g.lineWidth = p.width * s;
    g.beginPath();
    p.points.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.stroke();
  }
  for (const [x, z, r] of PLAZAS) {
    g.beginPath();
    g.arc(X(x), Z(z), r * s, 0, Math.PI * 2);
    g.fill();
  }
  // each district's colour, round its plaza (as it's set into the paving)
  for (const { plaza: [x, z], color } of FAIR_DISTRICTS) {
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, 1.1 * s);
    g.beginPath();
    g.arc(X(x), Z(z), 6.2 * s, 0, Math.PI * 2);
    g.stroke();
  }

  // the kart circuit outside the south-west fence: its lawn, the asphalt and the start line
  const lap = (d: number) => {
    g.beginPath();
    for (let i = 0; i <= CIRCUIT.n; i++) {
      const p = circuitPoint(i * CIRCUIT.ds, d);
      if (i) g.lineTo(X(p.x), Z(p.z));
      else g.moveTo(X(p.x), Z(p.z));
    }
    g.closePath();
  };
  g.fillStyle = g.strokeStyle = '#5c9a4e';
  g.lineWidth = (WALL + 3) * 2 * s;
  lap(0);
  g.fill();
  g.stroke();
  for (const [stroke, width] of [
    ['rgba(29, 18, 56, 0.6)', ROAD_HALF * 2 + 2],
    ['#4a4752', ROAD_HALF * 2],
  ] as const) {
    g.strokeStyle = stroke;
    g.lineWidth = Math.max(width * s, 2);
    lap(0);
    g.stroke();
  }
  const a = circuitPoint(START_S, ROAD_HALF);
  const b = circuitPoint(START_S, -ROAD_HALF);
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1.6 * s, 1.5);
  g.beginPath();
  g.moveTo(X(a.x), Z(a.z));
  g.lineTo(X(b.x), Z(b.z));
  g.stroke();

  // the Rally Trail outside the south fence: its meadow, the dirt and the start line
  const loop = (d: number) => {
    g.beginPath();
    for (let i = 0; i <= TRAIL.n; i++) {
      const p = trailPoint(i * TRAIL.ds, d);
      if (i) g.lineTo(X(p.x), Z(p.z));
      else g.moveTo(X(p.x), Z(p.z));
    }
    g.closePath();
  };
  g.fillStyle = g.strokeStyle = '#5c9a4e';
  g.lineWidth = (TRAIL_WALL + 2) * 2 * s;
  loop(0);
  g.fill();
  g.stroke();
  for (const [stroke, width] of [
    ['rgba(29, 18, 56, 0.55)', TRAIL_HALF * 2 + 2],
    ['#a07c52', TRAIL_HALF * 2],
  ] as const) {
    g.strokeStyle = stroke;
    g.lineWidth = Math.max(width * s, 2);
    loop(0);
    g.stroke();
  }
  const ta = trailPoint(TRAIL_START, TRAIL_HALF);
  const tb = trailPoint(TRAIL_START, -TRAIL_HALF);
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1.6 * s, 1.5);
  g.beginPath();
  g.moveTo(X(ta.x), Z(ta.z));
  g.lineTo(X(tb.x), Z(tb.z));
  g.stroke();

  // coaster tracks (dark casing under a coloured line so they read on any ground)
  for (const [d, color] of [
    [FALCON_TRACK, PALETTE.teal],
    [STACK_TRACK, PALETTE.candy],
  ] as const) {
    for (const [stroke, width] of [
      ['rgba(29, 18, 56, 0.6)', 2.6],
      [color, 1.4],
    ] as const) {
      g.strokeStyle = stroke;
      g.lineWidth = Math.max(width * s, width);
      g.beginPath();
      d.pos.forEach((p, i) => (i ? g.lineTo(X(p.x), Z(p.z)) : g.moveTo(X(p.x), Z(p.z))));
      g.closePath();
      g.stroke();
    }
  }
  // …and the coasters members built, on their plots in the valley
  for (const { pts, color } of valleyTracks.values())
    for (const [stroke, width] of [
      ['rgba(29, 18, 56, 0.6)', 2.2],
      [color, 1.1],
    ] as const) {
      g.strokeStyle = stroke;
      g.lineWidth = Math.max(width * s, width);
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
      g.closePath();
      g.stroke();
    }

  // the giant wheel seen from above: the rim edge-on, the hub, and its two A-frames
  const wz = LAYOUT.ferris.z;
  g.strokeStyle = '#3a3f48';
  g.lineWidth = 1.6 * s;
  for (const side of [-1, 1])
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.moveTo(X(LAYOUT.ferris.x + sx * 56), Z(wz + side * 40));
      g.lineTo(X(LAYOUT.ferris.x), Z(wz + side * 22));
      g.stroke();
    }
  g.strokeStyle = '#e9edf2';
  g.lineWidth = 3 * s;
  g.beginPath();
  g.moveTo(X(LAYOUT.ferris.x - 124), Z(wz));
  g.lineTo(X(LAYOUT.ferris.x + 124), Z(wz));
  g.stroke();

  // the Career Museum from above: its glass roof (with the ridge down the middle) and the porch
  const m = MUSEUM;
  const outline = (hw: number, z0: number, z1: number) => {
    g.beginPath();
    for (const [lx, lz] of [[-hw, z0], [hw, z0], [hw, z1], [-hw, z1]]) {
      const p = museumPoint(lx, lz);
      g.lineTo(X(p.x), Z(p.z));
    }
    g.closePath();
  };
  outline(m.halfW + m.wall + 0.35, -m.halfL - m.wall - 0.35, m.halfL + m.wall + 0.35);
  g.fillStyle = '#bcd9e6';
  g.fill();
  g.strokeStyle = 'rgba(29, 18, 56, 0.6)';
  g.lineWidth = Math.max(0.8 * s, 1);
  g.stroke();
  outline(m.halfW + m.wall + 0.3, m.halfL + m.wall, m.halfL + m.wall + m.porch);
  g.fillStyle = '#f7f0e2';
  g.fill();
  g.stroke();
  const a0 = museumPoint(0, -m.halfL - m.wall);
  const a1 = museumPoint(0, m.halfL + m.wall);
  g.beginPath();
  g.moveTo(X(a0.x), Z(a0.z));
  g.lineTo(X(a1.x), Z(a1.z));
  g.stroke();

  // the Sky Flip from above: its fenced swing and the tower
  const along = { x: Math.cos(FLIP_YAW), z: -Math.sin(FLIP_YAW) };
  const out = { x: Math.sin(FLIP_YAW), z: Math.cos(FLIP_YAW) };
  const fp = (lx: number, lz: number) => [X(LAYOUT.flip.x + along.x * lx + out.x * lz), Z(LAYOUT.flip.z + along.z * lx + out.z * lz)] as const;
  g.fillStyle = 'rgba(255, 138, 61, 0.35)';
  g.beginPath();
  for (const [lx, lz] of [[-26, -4], [26, -4], [26, 16], [-26, 16]]) g.lineTo(...fp(lx, lz));
  g.fill();
  g.strokeStyle = PALETTE.candy;
  g.lineWidth = 2.4 * s;
  g.beginPath();
  g.moveTo(...fp(-60, 3.6));
  g.lineTo(...fp(60, 3.6));
  g.stroke();
  g.fillStyle = '#3a3f48';
  g.beginPath();
  g.arc(...fp(0, 0), 2.6 * s, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// ------------------------------------------------------------------------------------------------
// Markers drawn over the map
// ------------------------------------------------------------------------------------------------

/** The visitor's arrow, drawn at the current origin (heading 0 faces up / -z). */
export function paintVisitor(g: CanvasRenderingContext2D, heading: number, size = 1) {
  g.save();
  g.rotate(-heading);
  g.scale(size, size);
  g.fillStyle = PALETTE.candy;
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(0, -9);
  g.lineTo(6.5, 7);
  g.lineTo(0, 3.5);
  g.lineTo(-6.5, 7);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

/** An airliner seen from above, nose up (heading 0 faces -z), at the current origin: the visitor's own in candy red, traffic in white. */
export function paintAircraft(g: CanvasRenderingContext2D, heading: number, size = 1, colour: string = PALETTE.candy) {
  g.save();
  g.rotate(-heading);
  g.scale(size, size);
  g.fillStyle = colour;
  g.strokeStyle = colour === PALETTE.candy ? '#fff' : '#1d1238';
  g.lineWidth = 1.6;
  g.lineJoin = 'round';
  g.beginPath();
  // fuselage, wings swept back, tailplane
  g.moveTo(0, -10);
  g.quadraticCurveTo(1.6, -8.5, 1.5, -4);
  g.lineTo(10, 1.5);
  g.lineTo(10, 3);
  g.lineTo(1.5, 1);
  g.lineTo(1.1, 6.5);
  g.lineTo(4, 8.8);
  g.lineTo(4, 10);
  g.lineTo(0, 9);
  g.lineTo(-4, 10);
  g.lineTo(-4, 8.8);
  g.lineTo(-1.1, 6.5);
  g.lineTo(-1.5, 1);
  g.lineTo(-10, 3);
  g.lineTo(-10, 1.5);
  g.lineTo(-1.5, -4);
  g.quadraticCurveTo(-1.6, -8.5, 0, -10);
  g.closePath();
  g.stroke();
  g.fill();
  g.restore();
}

/** Moving coaster trains (and karts, buggies, boats) as small dots. */
export function paintTrain(g: CanvasRenderingContext2D, x: number, y: number, color: string, r = 3.5) {
  g.fillStyle = color;
  g.strokeStyle = '#1d1238';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}

/** A navigation fix: a small triangle with its name beside it. */
export function paintFix(g: CanvasRenderingContext2D, x: number, y: number, label: string) {
  g.fillStyle = '#7ee2f0';
  g.strokeStyle = '#1d1238';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(x, y - 5);
  g.lineTo(x + 4.5, y + 3.5);
  g.lineTo(x - 4.5, y + 3.5);
  g.closePath();
  g.stroke();
  g.fill();
  g.font = '700 10px "DM Sans", sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.lineWidth = 3;
  g.strokeText(label, x + 7, y);
  g.fillStyle = '#e8fbff';
  g.fillText(label, x + 7, y);
}
