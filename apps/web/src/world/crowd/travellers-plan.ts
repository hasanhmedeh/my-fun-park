import type { HomeTerminal } from '../airport/terminal';
import { AIR_Z, archX, BELTS, CHECKIN, DOORS, ESCALATOR, GATES, LAND_Z, RECLAIM, SECURITY, TERM, UNITS } from '../airport/terminal-plan';
import { AIRPORTS, ISLAND, ISLAND_SPOTS, SEA_Y, islandShoreDist } from '../geo';
import type { IslandTerminal } from '../island/island-terminal';
import type { PalmCay } from '../island/island';
import { groundY } from '../terrain-land';
import type { Obstacles } from './obstacles';
import { WalkGrid, type Rect, type V2 } from './walk-grid';

// Where the airports' and the island's people go and what they do there, worked out once from
// what the terminal, island-terminal and island modules built (their spots, plans and colliders):
// check-in desks to stand at, security lanes to pass, seats to sit in (with the side to approach
// them from), windows to watch from, belts to wait at, towels, loungers, hammocks and sandcastles,
// the shallows, and the walk grids that join them up.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Stand here, facing `yaw` (the park's convention: 0 north, π south). */
export interface Spot extends V2 {
  yaw: number;
}

/** A seat: its surface (x, y, z), the way a sitter faces, and where to stand before sitting down. */
export interface Seat extends Spot {
  y: number;
  approach: V2;
}

/** A security lane: the queue's head on the landside, the arch, and the way out airside. */
export interface Lane {
  entry: V2;
  path: V2[];
}

/** One way between two grids (a doorway): routes from one to the other pass through it. */
export interface Portal extends V2 {
  a: WalkGrid;
  b: WalkGrid;
}

/** The ground a site's people walk on: its grids, and the doorways between them. */
export class Site {
  constructor(
    readonly grids: WalkGrid[],
    readonly portals: Portal[] = [],
  ) {}

  /** Which grid a point belongs to (the first that has it free; else the first that contains it). */
  gridAt(x: number, z: number) {
    return this.grids.find((g) => g.free(x, z)) ?? this.grids.find((g) => g.contains(x, z)) ?? null;
  }

  free(x: number, z: number) {
    return this.grids.some((g) => g.free(x, z));
  }

  nearestFree(x: number, z: number, maxR = 4) {
    for (const g of this.grids) {
      const p = g.nearestFree(x, z, maxR);
      if (p) return p;
    }
    return null;
  }

  /** A route a → b, through a doorway if they're on different grids (appends the corners to `out`). */
  route(ax: number, az: number, bx: number, bz: number, out: V2[]) {
    const ga = this.gridAt(ax, az);
    const gb = this.gridAt(bx, bz);
    if (!ga || !gb) return false;
    if (ga === gb) return ga.route(ax, az, bx, bz, out);
    let best: Portal | null = null;
    let bd = Infinity;
    for (const p of this.portals) {
      if (!((p.a === ga && p.b === gb) || (p.a === gb && p.b === ga))) continue;
      const d = Math.hypot(p.x - ax, p.z - az) + Math.hypot(bx - p.x, bz - p.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (!best) return false;
    const n = out.length;
    if (ga.route(ax, az, best.x, best.z, out) && gb.route(best.x, best.z, bx, bz, out)) return true;
    out.length = n;
    return false;
  }
}

const forward = (yaw: number): V2 => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const yawTo = (from: V2, to: V2) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** A seat's approach: where to stand, in front of it (or behind, for stools at a counter). */
function seat(site: Site, x: number, z: number, yaw: number, y: number, from = 0.55): Seat | null {
  const f = forward(yaw);
  const a = site.nearestFree(x + f.x * from, z + f.z * from, 1.2);
  return a ? { x, z, yaw, y, approach: a } : null;
}

/** The way someone standing at (x, z) to browse would face: towards whatever solid is nearest. */
function faceSolid(site: Site, x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * Math.PI * 2;
    const f = forward(yaw);
    for (let d = 0.4; d < 2.6; d += 0.2)
      if (!site.free(x + f.x * d, z + f.z * d)) {
        if (d < bd) {
          bd = d;
          best = yaw;
        }
        break;
      }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------
// Funfair International
// ------------------------------------------------------------------------------------------------

export interface GateWay {
  gate: number;
  /** In front of the desk, where the gate's queue starts. */
  desk: V2;
  /** From the lounge through the boarding area's door to the escalator's foot. */
  pen: V2[];
  /** From the escalator's foot up to the doorway onto the bridge (where travellers pass out of sight). */
  up: V3[];
}

export interface HomePlan {
  site: Site;
  grid: WalkGrid;
  /** Kerbside, outside the doors: where travellers are dropped off, and where arrivals leave. */
  kerb: { departures: V2[]; arrivals: V2[] };
  checkIn: Spot[];
  lanes: Lane[];
  /** Browsing spots airside (past security), and in the public hall. */
  shops: Spot[];
  hallShops: Spot[];
  gateSeats: Record<number, Seat[]>;
  /** At the airside glass, between the gates' boarding areas, facing the apron. */
  windows: Spot[];
  /** Round the reclaim belts, facing them. */
  belts: Spot[];
  /** The meeting point under the boards. */
  hall: Spot[];
  gates: Record<number, GateWay>;
  /** Gate 3's queue: from its head (beside the desk) back through the lounge into the concourse. */
  tail: V2[];
  /** Where the crew come out airside to walk to their gate. */
  crewStart: V2;
  /** The reclaim's way out into the arrivals hall. */
  reclaimExit: V2;
}

export function homePlan(term: HomeTerminal, obs: Obstacles): HomePlan {
  const bounds: Rect = { x0: TERM.x0 - 1, x1: TERM.x1 + 1, z0: 428, z1: AIR_Z };
  // the kerb walk outside the doors, then the terminal's own floor
  const walk: Rect[] = [{ x0: TERM.x0, x1: TERM.x1, z0: 429.5, z1: LAND_Z + 0.5 }, ...term.walk.filter((r) => r.z1 > LAND_Z + 1)];
  const grid = new WalkGrid(bounds, 0.5, walk, obs, 0.3);
  const site = new Site([grid]);
  const sp = term.spots;

  const kerb = {
    departures: DOORS.filter((d) => d.kind === 'departures').map((d) => ({ x: d.x, z: 431.2 })),
    arrivals: DOORS.filter((d) => d.kind === 'arrivals').map((d) => ({ x: d.x, z: 431.2 })),
  };
  const checkIn: Spot[] = sp.checkIn.map((p) => {
    const cx = CHECKIN.xs.reduce((a, b) => (Math.abs(b - p.x) < Math.abs(a - p.x) ? b : a));
    return { ...p, yaw: yawTo(p, { x: cx, z: p.z }) };
  });
  const S = SECURITY;
  const lanes: Lane[] = S.lanes.map((lx) => {
    const ax = archX(lx);
    return {
      entry: { x: lx + 1.5, z: S.z0 - 0.8 },
      path: [
        { x: ax, z: S.z0 + 1.2 },
        { x: ax, z: S.screenZ },
        { x: ax, z: S.screenZ + 2.4 },
        { x: ax, z: S.z1 + 0.7 },
      ],
    };
  });
  const browse = (list: V2[]) =>
    list.flatMap((p) => {
      const q = site.nearestFree(p.x, p.z, 0.8);
      return q ? [{ ...q, yaw: faceSolid(site, q.x, q.z) }] : [];
    });
  const shops = browse(sp.shops.filter((p) => p.z > S.z1));
  const hallShops = browse(sp.shops.filter((p) => p.z < S.z0));
  const gateSeats: Record<number, Seat[]> = {};
  for (const g of Object.keys(sp.gateSeats).map(Number)) {
    gateSeats[g] = sp.gateSeats[g].flatMap((s) => {
      const q = seat(site, s.x, s.z, s.yaw, 0.48);
      return q ? [q] : [];
    });
  }
  // the glass: every couple of metres along the lounges, clear of the boarding areas and seat rows
  const windows: Spot[] = [];
  for (let x = TERM.x0 + 22; x < TERM.x1 - 22; x += 2.3) {
    if (GATES.some((g) => x > g.pen.x0 - 1.5 && x < g.pen.x1 + 1.5)) continue;
    const z = AIR_Z - 1.0;
    if (site.free(x, z) && site.free(x, z - 0.6)) windows.push({ x, z, yaw: Math.PI });
  }
  const belts: Spot[] = [];
  for (const b of BELTS)
    for (const s of [-1, 1])
      for (let z = b.z0 + 3; z <= b.z1 - 3; z += 2.2) {
        const p = site.nearestFree(b.x + s * (b.half + 0.9), z, 0.6);
        if (p) belts.push({ ...p, yaw: s > 0 ? Math.PI / 2 : -Math.PI / 2 });
      }
  const hall = sp.hall.flatMap((p) => {
    const q = site.nearestFree(p.x, p.z, 1);
    return q ? [{ ...q, yaw: Math.PI }] : [];
  });

  const gates: Record<number, GateWay> = {};
  for (const g of GATES) {
    const doorX = (g.penDoor.x0 + g.penDoor.x1) / 2;
    const bridge = term.bridges[g.stand.id];
    // the bridge's walk starts with the gate's own walkway: foot → escalator → landing → doorway
    const doorway = bridge.walkPath.findIndex((p) => p.z > AIR_Z);
    gates[g.gate] = {
      gate: g.gate,
      desk: { x: g.desk.x - 3, z: g.desk.z - 1.3 },
      pen: [
        { x: doorX, z: g.pen.z0 - 0.6 },
        { x: doorX, z: g.pen.z0 + 1.2 },
        { x: g.foot.x + 0.6, z: 535.4 },
        { x: g.foot.x, z: g.foot.z },
      ],
      up: bridge.walkPath.slice(1, doorway + 1).map((p) => ({ ...p })),
    };
  }
  const g3 = GATES.find((g) => g.gate === 3)!;
  const sx = g3.sx;
  const tail: V2[] = [
    { x: sx - 3, z: 524.2 },
    { x: sx - 2.9, z: 521.4 },
    { x: sx - 1.3, z: 520.6 },
    { x: sx - 1.3, z: 515.5 },
    { x: sx - 10, z: 515.5 },
    { x: sx - 50, z: 515.5 },
  ];
  return {
    site,
    grid,
    kerb,
    checkIn,
    lanes,
    shops,
    hallShops,
    gateSeats,
    windows,
    belts,
    hall,
    gates,
    tail,
    crewStart: site.nearestFree(96, 514.5, 3) ?? { x: 96, z: 514.5 },
    reclaimExit: { x: RECLAIM.exitX, z: RECLAIM.z0 - 2 },
  };
}

/** The escalator's top landing at a gate (for those coming down off an arriving flight). */
export const escalatorTop = (sx: number) => sx + ESCALATOR.topX;

/** The arrivals hall's units (cafés and shops) people stop at on their way out. */
export const HALL_UNITS = UNITS.filter((u) => u.z1 <= 471);

// ------------------------------------------------------------------------------------------------
// Palm Cay
// ------------------------------------------------------------------------------------------------

// From the island terminal's plan (island-terminal.ts keeps these private): the airside glass,
// the line between the airside and landside halls, the landside screens; the departures entrance.
const IT = AIRPORTS.island.terminal;
const Z_AIR = IT.z0;
const Z_MID = 40630;
const Z_LAND = IT.z1;
const ENTRANCE_X = -48;
const SECURITY_LANES = [-54, -46];
const CHECKIN_DESKS = { x0: -116, z: 40645, n: 8, pitch: 5 };
const GATE1_X = -90;
/** Where the beach park's own plan puts the top of the sand, and the gardens' hammock grove's southern edge. */
const BEACH_WALK_Z = 41436;
/** The swimming area, between the cannons' waters and the jet-ski dock, and from the dock to the pier. */
const SWIM: [number, number][] = [
  [-250, 0],
  [118, 312],
];

export interface LieSpot extends Spot {
  /** The kind of bed: a towel on the sand, a sun lounger, a hammock between palms. */
  kind: 'towel' | 'lounger' | 'hammock';
  /** Where to walk to first (beside it). */
  approach: V2;
}

export interface Shallows {
  /** On the dry sand above the water's edge. */
  edge: V2;
  /** Knee to waist deep (y is the sea bed). */
  wade: V3[];
  /** Further out, where people swim. */
  swim: V2[];
}

export interface IslandPlan {
  site: Site;
  terminal: WalkGrid;
  park: WalkGrid;
  entrance: { out: V2; in: V2 };
  checkIn: Spot[];
  lanes: Lane[];
  lounge: Seat[];
  /** Gate 1's door, where those on the island's other flights leave the lounge. */
  gate1: V2;
  benches: Seat[];
  bars: Seat[];
  beds: LieSpot[];
  castles: Spot[];
  promenade: V2[];
  wander: V2[];
  /** Round the games, facing them. */
  watch: Spot[];
  shallows: Shallows[];
  /** Gate 2's queue: from the gate door back past the desk into the lounge. */
  tail: V2[];
  plaza: V2;
}

export function islandPlan(term: IslandTerminal, park: PalmCay, obs: Obstacles): IslandPlan {
  const tGrid = new WalkGrid({ x0: IT.x0 - 1, x1: IT.x1 + 1, z0: Z_AIR - 1, z1: 40704 }, 0.5, term.walk, obs, 0.3);
  const pGrid = new WalkGrid({ x0: -460, x1: 500, z0: ISLAND.park.z0 - 2, z1: 41560 }, 1, park.walk, obs, 0.35);
  const site = new Site([tGrid, pGrid], [
    { x: 0, z: 40692, a: tGrid, b: pGrid },
    { x: ENTRANCE_X, z: 40673.5, a: tGrid, b: pGrid },
  ]);
  const sp = park.spots;
  // what can be walked to from the Beach Plaza (the games' equipment walls off a pocket or two)
  pGrid.connect(sp.plaza.x, sp.plaza.z);
  const onFoot = (p: V2) => (pGrid.contains(p.x, p.z) && !tGrid.free(p.x, p.z) ? pGrid.linked(p.x, p.z) : site.free(p.x, p.z));

  const checkIn: Spot[] = [];
  for (let i = 0; i < CHECKIN_DESKS.n; i++) {
    const x = CHECKIN_DESKS.x0 + CHECKIN_DESKS.pitch / 2 + i * CHECKIN_DESKS.pitch - 0.6;
    const p = tGrid.nearestFree(x, CHECKIN_DESKS.z + 1.25, 0.6);
    if (p) checkIn.push({ ...p, yaw: 0 });
  }
  const lanes: Lane[] = SECURITY_LANES.map((x) => ({
    entry: { x, z: Z_MID + 4.2 },
    path: [
      { x, z: Z_MID + 1.2 },
      { x, z: Z_MID },
      { x, z: Z_MID - 3.4 },
    ],
  }));
  const lounge = term.spots.seats.flatMap((s) => {
    const q = seat(site, s.x, s.z, s.yaw, 0.48, 0.5);
    return q ? [q] : [];
  });
  const benches = sp.benches.flatMap((s) => {
    const q = seat(site, s.x, s.z, s.yaw, 0.47, 0.6);
    return q ? [q] : [];
  });
  // bar stools: approached from behind (the counter is in front)
  const bars = sp.bar.flatMap((s) => {
    const q = seat(site, s.x, s.z, s.yaw, 0.82, -0.55);
    return q ? [q] : [];
  });

  // the beach's spots, told apart by how the park laid them: hammocks are in the gardens (north of
  // the sand), loungers face north under the shades, the sandcastle builders kneel to the east of
  // their castles, the rest are towels
  const beds: LieSpot[] = [];
  const castles: Spot[] = [];
  for (const s of sp.beach) {
    if (s.yaw === -Math.PI / 2) {
      // (the castle stands 1.2 m west and 0.4 m south of its builder's spot)
      const p = site.nearestFree(s.x, s.z, 0.8);
      if (p) castles.push({ ...p, yaw: yawTo(p, { x: s.x - 1.2, z: s.z + 0.4 }) });
      continue;
    }
    const kind: LieSpot['kind'] = s.z < BEACH_WALK_Z - 20 ? 'hammock' : s.yaw === 0 ? 'lounger' : 'towel';
    // beside it: to the side of a lounger or a hammock's middle, at the foot of a towel
    const f = forward(s.yaw);
    const side = { x: -f.z, z: f.x };
    const off = kind === 'towel' ? { x: f.x * 1.3, z: f.z * 1.3 } : { x: side.x * 0.75, z: side.z * 0.75 };
    const a = site.nearestFree(s.x + off.x, s.z + off.z, 1.5);
    if (a) beds.push({ x: s.x, z: s.z, yaw: s.yaw, kind, approach: a });
  }

  // round the games: a ring of places to stand and watch from, outside each game's plot
  const watch: Spot[] = [];
  const games: [V2, number, number, number][] = [
    // anchor, radius, and the arc to watch from (centre bearing, half-width), as yaw from the anchor
    [ISLAND_SPOTS.volley, 26, 0, 1.2],
    [ISLAND_SPOTS.cannons, 30, Math.PI * 0.25, 1.0],
    [ISLAND_SPOTS.slides, 34, -Math.PI * 0.5, 1.1],
    [ISLAND_SPOTS.jetski, 14, 0, 1.0],
  ];
  for (const [c, r, mid, half] of games)
    for (let i = 0; i < 9; i++) {
      const yaw = mid - half + (2 * half * i) / 8;
      const f = forward(yaw);
      // (outward from the ring until there's ground joined to the rest of the park)
      for (let rr = r; rr < r + 14; rr += 2) {
        const p = pGrid.nearestLinked(c.x + f.x * rr, c.z + f.z * rr, 2);
        if (!p) continue;
        watch.push({ ...p, yaw: yawTo(p, c) });
        break;
      }
    }

  const shallows: Shallows[] = [];
  for (const [x0, x1] of SWIM)
    for (let x = x0 + 6; x < x1 - 6; x += 9) {
      // down the beach to the water's edge
      let z = BEACH_WALK_Z;
      while (z < 41800 && islandShoreDist(x, z) > 0) z += 0.5;
      const edge = pGrid.nearestLinked(x, z - 23, 4);
      if (!edge) continue;
      const wade: V3[] = [];
      for (const d of [4.5, 7, 9.5]) {
        let zz = z;
        while (zz < z + 60 && islandShoreDist(x, zz) > -d) zz += 0.25;
        wade.push({ x: x + (wade.length - 1) * 1.2, y: groundY(x, zz), z: zz });
      }
      const swim: V2[] = [];
      for (const d of [14, 19, 24]) {
        let zz = z;
        while (zz < z + 80 && islandShoreDist(x, zz) > -d) zz += 0.5;
        swim.push({ x: x + (swim.length - 1) * 3, z: zz });
      }
      // deep enough to swim, and not into the lagoon's race course
      if (swim.every((p) => SEA_Y - groundY(p.x, p.z) > 0.8 && p.z < ISLAND.lagoon.z0 - 20)) shallows.push({ edge, wade, swim });
    }

  const gx = -30;
  const tail: V2[] = [
    { x: gx, z: Z_AIR + 2.5 },
    { x: gx, z: Z_AIR + 9.3 },
    { x: gx - 2.6, z: Z_AIR + 9.8 },
    { x: gx - 2.8, z: Z_AIR + 14 },
    { x: gx - 4.5, z: Z_MID - 2.5 },
    { x: gx - 30, z: Z_MID - 2.5 },
  ];
  return {
    site,
    terminal: tGrid,
    park: pGrid,
    entrance: { out: { x: ENTRANCE_X, z: Z_LAND + 2.2 }, in: { x: ENTRANCE_X, z: Z_LAND - 3 } },
    checkIn,
    lanes,
    lounge,
    gate1: { x: GATE1_X, z: Z_AIR + 0.9 },
    benches: benches.filter((b) => onFoot(b.approach)),
    bars: bars.filter((b) => onFoot(b.approach)),
    beds: beds.filter((b) => onFoot(b.approach)),
    castles: castles.filter(onFoot),
    promenade: sp.promenade.filter(onFoot).map((p) => ({ ...p })),
    wander: sp.wander.filter((p) => pGrid.linked(p.x, p.z)).map((p) => ({ ...p })),
    watch,
    shallows,
    tail,
    plaza: { ...sp.plaza },
  };
}
