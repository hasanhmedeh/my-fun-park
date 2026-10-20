// Both airports as the aircraft sees them: the taxi network (nodes and named taxiways), the stands
// with their stop and pushback positions, each runway end with its ILS, PAPI and departure
// entries, the rapid exits, the radio frequencies, the en-route fixes and the flight plans.
//
// The scenery (world/airport/airfield.ts) paints its centrelines, signs and lights from these
// numbers; the flight attraction guides the taxi along them; AI traffic follows them. Positions
// are world metres (see world/geo.ts). Taxi positions are where the aircraft's REFERENCE POINT
// (between the main gear, see a320.ts) runs: on a straight line that's the centreline.

import { AIRPORTS, FT, NM, headingVec, type AirportGeo, type Region } from '../world/geo';
import type { Fix, FlightPlan } from './types';

export type RunwayIdent = '09' | '27';

export type NodeKind = 'stand' | 'lane' | 'taxiway' | 'hold' | 'runway';
export interface TaxiNode {
  id: string;
  x: number;
  z: number;
  kind: NodeKind;
}
export interface TaxiEdge {
  a: string;
  b: string;
  /** Taxiway name as ATC and the signs call it: "A", "A4", "T", "K", "E2", "RWY". */
  name: string;
  /** Only a → b (rapid exits are one-way off the runway). */
  oneWay?: boolean;
}

export interface Stand {
  id: string;
  /** Gate number shown on the terminal and the boards. */
  gate: number;
  /** Where the reference point stops (main gear on the stop bar) and the parked heading. */
  x: number;
  z: number;
  heading: number;
  /** The nose gear's stop mark (the stand's lead-in line ends here). */
  noseStop: { x: number; z: number };
  /** Boarding door L1's sill in the world (the jet bridge docks here), at A320_POINTS.doorL1.y above the ground. */
  doorL1: { x: number; z: number };
  /** The taxilane node in front of the stand (lead-in line from here to the stand). */
  lane: string;
  /** Where the pushback ends: the reference point on the taxilane, facing east (090) or west (270). */
  pushEnd: Record<'east' | 'west', { x: number; z: number; heading: number }>;
}

export interface Ils {
  ident: string;
  freq: string;
  /** Final approach course (= the runway heading) and glide slope angle. */
  course: number;
  slopeDeg: number;
  /** Glide path origin on the centreline (where the 3° path meets the runway), threshold crossing height (ft). */
  gpi: { x: number; z: number };
  tchFt: number;
  /** Localizer antenna (beyond the far end) and glide slope antenna (beside the runway at the GPI). */
  locAntenna: { x: number; z: number };
  gsAntenna: { x: number; z: number };
  /** Usable range (NM) and the localizer's half-width for full scale (degrees: ±2 dots). */
  rangeNm: number;
  locHalfWidthDeg: number;
}

export interface RunwayEnd {
  ident: RunwayIdent;
  /** Magnetic = true heading here. */
  heading: number;
  /** Landing threshold (centreline at the threshold bar) and the far end. */
  threshold: { x: number; z: number };
  end: { x: number; z: number };
  lengthM: number;
  /** Aiming point markings (m past the threshold) and touchdown zone (m past the threshold, for markings and scoring). */
  aimPointM: number;
  tdz: { from: number; to: number };
  ils: Ils;
  /** The PAPI's four boxes: centre of the bar, on the left of the landing direction, and its angles (deg, outer → inner). */
  papi: { x: number; z: number; angles: [number, number, number, number] };
  /** Departure entries for this runway: the hold node, the runway node it enters at, and the takeoff run available from there. */
  entries: { name: string; hold: string; runway: string; toraM: number; intersection: boolean }[];
  /** Exits for an aircraft landing on this end: the runway node, its name, and how far past the threshold it is. */
  exits: { name: string; node: string; distM: number; rapid: boolean }[];
  /** Approach fixes: the initial approach fix (over the sea) and the intermediate fix on the extended centreline. */
  iaf: string;
  if: string;
}

export interface Frequencies {
  atis: string;
  ground: string;
  tower: string;
  /** Departure / approach radar (shared over the sea). */
  radar: string;
}

export interface Airport {
  geo: AirportGeo;
  nodes: Record<string, TaxiNode>;
  edges: TaxiEdge[];
  stands: Stand[];
  /** The stand the player's flight uses (both legs). */
  playerStand: string;
  runways: Record<RunwayIdent, RunwayEnd>;
  freq: Frequencies;
  /** Field elevation (ft above the sea: the ground's y = 0 is 1.2 m above it). */
  elevationFt: number;
}

// ------------------------------------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------------------------------------

const GLIDE = 3;
/** Glide path origin past the threshold (m): 300 m at 3° gives a threshold crossing height of ~52 ft. */
const GPI_M = 300;
const AIM_M = 400;
/** Holding points stand this far from the runway centreline (m; code C/D, ILS category I). */
export const HOLD_OFFSET = 90;
/** The pushback's turn radius (m, reference point). */
const PUSH_R = 40;
/** Distance of the intermediate fix (on the extended centreline) before the threshold (NM), and its altitude (ft). */
const IF_NM = 5;
const IF_FT = 1700;

function node(nodes: Record<string, TaxiNode>, id: string, x: number, z: number, kind: NodeKind) {
  nodes[id] = { id, x, z, kind };
  return id;
}

function runwayEnd(
  geo: AirportGeo,
  ident: RunwayIdent,
  ils: { ident: string; freq: string },
  iaf: string,
  ifFix: string,
): Omit<RunwayEnd, 'entries' | 'exits'> {
  const r = geo.runway;
  const east = ident === '09'; // landing towards the east
  const heading = east ? 90 : 270;
  const thrX = east ? r.x0 : r.x1;
  const endX = east ? r.x1 : r.x0;
  const s = east ? 1 : -1; // +x per metre along the landing direction
  // the left of the landing direction: north (−z) landing east, south (+z) landing west
  const left = east ? -1 : 1;
  const papiOff = r.width / 2 + 15;
  return {
    ident,
    heading,
    threshold: { x: thrX, z: r.z },
    end: { x: endX, z: r.z },
    lengthM: Math.abs(r.x1 - r.x0),
    aimPointM: AIM_M,
    tdz: { from: 150, to: 900 },
    ils: {
      ident: ils.ident,
      freq: ils.freq,
      course: heading,
      slopeDeg: GLIDE,
      gpi: { x: thrX + s * GPI_M, z: r.z },
      tchFt: (GPI_M * Math.tan((GLIDE * Math.PI) / 180)) / FT,
      locAntenna: { x: endX + s * 300, z: r.z },
      gsAntenna: { x: thrX + s * GPI_M, z: r.z - left * (r.width / 2 + 120) },
      rangeNm: 18,
      // (ICAO: full scale is about 105 m either side of the centreline at the threshold, from the antenna
      // 300 m beyond the far end: about 1.6° at Funfair International, 1.9° at Palm Cay)
      locHalfWidthDeg: Math.min(3, (Math.atan(106 / (Math.abs(r.x1 - r.x0) + 300)) * 180) / Math.PI),
    },
    papi: { x: thrX + s * (GPI_M + 30), z: r.z + left * papiOff, angles: [3.5, 3.1667, 2.8333, 2.5] },
    iaf,
    if: ifFix,
  };
}

/** A pushback from a stand: back out of the stand, turning onto the taxilane at `laneZ`. */
function pushEnds(x: number, laneZ: number) {
  // Pushed tail-first, the aircraft ends facing east with its reference point PUSH_R west of the stand, and vice versa.
  return {
    east: { x: x - PUSH_R, z: laneZ, heading: 90 },
    west: { x: x + PUSH_R, z: laneZ, heading: 270 },
  };
}

function stand(gate: number, x: number, z: number, heading: number, laneId: string, laneZ: number): Stand {
  const f = headingVec(heading);
  // door L1 is 12.8 m forward and 1.98 m to the left (see A320_POINTS.doorL1)
  const lx = f.z; // left of heading h = (sin(h − 90), −cos(h − 90)) = (−cos h, −sin h) = (f.z, −f.x)
  const lz = -f.x;
  return {
    id: `S${gate}`,
    gate,
    x,
    z,
    heading,
    noseStop: { x: x + f.x * 12.64, z: z + f.z * 12.64 },
    doorL1: { x: x + f.x * 12.8 + lx * 1.98, z: z + f.z * 12.8 + lz * 1.98 },
    lane: laneId,
    pushEnd: pushEnds(x, laneZ),
  };
}

// ------------------------------------------------------------------------------------------------
// Funfair International (XFUN), on the mainland's south coast
// ------------------------------------------------------------------------------------------------
//
//   z 440..540   terminal (gates on its south facade)
//   z ≈ 574      stands' stop bars (main gear), aircraft nose-in, heading 000
//   z = 650      taxilane T in front of the stands, x −330..330
//   z = 720      parallel taxiway A, x −1700..1700
//   z = 810      holding points on A1, A2, A4, A5
//   z = 900      runway 09/27, x −1750..1750
//
// Runway 27 departs from A4 (x = +900, 2,650 m available) or A5 (full length); 09 from A2 / A1.
// Landing 27 the aircraft vacates by the rapid exit E2 at x = +300 (≈1,450 m past the threshold);
// landing 09 by E1 at x = −300. Both rapid exits meet A at x = 0, opposite the apron link K.

function buildHome(): Airport {
  const geo = AIRPORTS.home;
  const r = geo.runway;
  const N: Record<string, TaxiNode> = {};
  const E: TaxiEdge[] = [];
  const LANE = 650;
  const A = geo.taxiwayZ;
  const HOLD = r.z - HOLD_OFFSET;

  // the taxilane and the stands
  const standXs = [-150, -90, -30, 30, 90, 150];
  const laneXs = [-330, -300, ...standXs.slice(0, 3), 0, ...standXs.slice(3), 300, 330];
  for (const x of laneXs) node(N, `T${x}`, x, LANE, 'lane');
  for (let i = 1; i < laneXs.length; i++) E.push({ a: `T${laneXs[i - 1]}`, b: `T${laneXs[i]}`, name: 'T' });
  const stopZ = 573.7;
  const stands = standXs.map((x, i) => {
    const s = stand(i + 1, x, stopZ, 0, `T${x}`, LANE);
    node(N, s.id, x, stopZ, 'stand');
    E.push({ a: s.id, b: s.lane, name: `${s.gate}` });
    return s;
  });

  // taxiway A and the apron links J (west), K (centre), L (east)
  const aXs = [-1700, -900, -300, 0, 300, 900, 1700];
  for (const x of aXs) node(N, `A${x}`, x, A, 'taxiway');
  for (let i = 1; i < aXs.length; i++) E.push({ a: `A${aXs[i - 1]}`, b: `A${aXs[i]}`, name: 'A' });
  E.push({ a: 'T-300', b: 'A-300', name: 'J' }, { a: 'T0', b: 'A0', name: 'K' }, { a: 'T300', b: 'A300', name: 'L' });

  // the runway and its connectors
  const rwXs = [r.x0, -1700, -900, -300, 300, 900, 1700, r.x1];
  for (const x of rwXs) node(N, `R${x}`, x, r.z, 'runway');
  for (let i = 1; i < rwXs.length; i++) E.push({ a: `R${rwXs[i - 1]}`, b: `R${rwXs[i]}`, name: 'RWY' });
  const conn: [string, number][] = [['A1', -1700], ['A2', -900], ['A4', 900], ['A5', 1700]];
  for (const [name, x] of conn) {
    node(N, `H${name}`, x, HOLD, 'hold');
    E.push({ a: `A${x}`, b: `H${name}`, name }, { a: `H${name}`, b: `R${x}`, name });
  }
  // rapid exits: off the runway at ±300, onto A at 0 (one-way)
  E.push({ a: 'R-300', b: 'A0', name: 'E1', oneWay: true }, { a: 'R300', b: 'A0', name: 'E2', oneWay: true });

  const r09 = runwayEnd(geo, '09', { ident: 'IFNW', freq: '109.50' }, 'TAFFY', 'FN09I');
  const r27 = runwayEnd(geo, '27', { ident: 'IFUN', freq: '110.30' }, 'CANDY', 'FN27I');
  return {
    geo,
    nodes: N,
    edges: E,
    stands,
    playerStand: 'S3',
    runways: {
      '09': {
        ...r09,
        entries: [
          { name: 'A2', hold: 'HA2', runway: 'R-900', toraM: r.x1 + 900, intersection: true },
          { name: 'A1', hold: 'HA1', runway: 'R-1700', toraM: r.x1 + 1700, intersection: false },
        ],
        exits: [
          { name: 'E1', node: 'R-300', distM: -300 - r.x0, rapid: true },
          { name: 'A4', node: 'R900', distM: 900 - r.x0, rapid: false },
          { name: 'A5', node: 'R1700', distM: 1700 - r.x0, rapid: false },
        ],
      },
      '27': {
        ...r27,
        entries: [
          { name: 'A4', hold: 'HA4', runway: 'R900', toraM: 900 - r.x0, intersection: true },
          { name: 'A5', hold: 'HA5', runway: 'R1700', toraM: 1700 - r.x0, intersection: false },
        ],
        exits: [
          { name: 'E2', node: 'R300', distM: r.x1 - 300, rapid: true },
          { name: 'A2', node: 'R-900', distM: r.x1 + 900, rapid: false },
          { name: 'A1', node: 'R-1700', distM: r.x1 + 1700, rapid: false },
        ],
      },
    },
    freq: { atis: '127.85', ground: '121.80', tower: '118.30', radar: '124.35' },
    elevationFt: 1.2 / FT,
  };
}

// ------------------------------------------------------------------------------------------------
// Palm Cay (XPCY), along the island's north side
// ------------------------------------------------------------------------------------------------
//
//   z = 40300    runway 09/27, x −1400..1400
//   z = 40390    holding points on A1, A2, A4, A5
//   z = 40450    parallel taxiway A, x −1350..1350
//   z = 40500    taxilane T, x −150..150
//   z ≈ 40566    stands' stop bars, aircraft nose-in heading 180 (the terminal is south)
//   z 40600..670 terminal; the beach park beyond
//
// Runway 27 departs from A4 (x = +700, 2,100 m) or A5 (full length); 09 from A2 / A1. Landing 27
// the aircraft vacates by E2 at x = −100 (1,500 m past the threshold) onto A at −350; landing 09,
// by E1 at x = +100 onto A at +350. The apron link K joins A at x = 0.

function buildIsland(): Airport {
  const geo = AIRPORTS.island;
  const r = geo.runway;
  const N: Record<string, TaxiNode> = {};
  const E: TaxiEdge[] = [];
  const LANE = 40500;
  const A = geo.taxiwayZ;
  const HOLD = r.z + HOLD_OFFSET;

  const standXs = [-90, -30, 30, 90];
  const laneXs = [-150, ...standXs.slice(0, 2), 0, ...standXs.slice(2), 150];
  for (const x of laneXs) node(N, `T${x}`, x, LANE, 'lane');
  for (let i = 1; i < laneXs.length; i++) E.push({ a: `T${laneXs[i - 1]}`, b: `T${laneXs[i]}`, name: 'T' });
  const stopZ = 40566.3;
  const stands = standXs.map((x, i) => {
    const s = stand(i + 1, x, stopZ, 180, `T${x}`, LANE);
    node(N, s.id, x, stopZ, 'stand');
    E.push({ a: s.id, b: s.lane, name: `${s.gate}` });
    return s;
  });

  const aXs = [-1350, -700, -350, 0, 350, 700, 1350];
  for (const x of aXs) node(N, `A${x}`, x, A, 'taxiway');
  for (let i = 1; i < aXs.length; i++) E.push({ a: `A${aXs[i - 1]}`, b: `A${aXs[i]}`, name: 'A' });
  E.push({ a: 'T0', b: 'A0', name: 'K' });
  // the taxilane's ends join A too, so stands at either end needn't use K
  E.push({ a: 'T-150', b: 'A-350', name: 'J' }, { a: 'T150', b: 'A350', name: 'L' });

  const rwXs = [r.x0, -1350, -700, -100, 100, 700, 1350, r.x1];
  for (const x of rwXs) node(N, `R${x}`, x, r.z, 'runway');
  for (let i = 1; i < rwXs.length; i++) E.push({ a: `R${rwXs[i - 1]}`, b: `R${rwXs[i]}`, name: 'RWY' });
  const conn: [string, number][] = [['A1', -1350], ['A2', -700], ['A4', 700], ['A5', 1350]];
  for (const [name, x] of conn) {
    node(N, `H${name}`, x, HOLD, 'hold');
    E.push({ a: `A${x}`, b: `H${name}`, name }, { a: `H${name}`, b: `R${x}`, name });
  }
  E.push({ a: 'R100', b: 'A350', name: 'E1', oneWay: true }, { a: 'R-100', b: 'A-350', name: 'E2', oneWay: true });

  const r09 = runwayEnd(geo, '09', { ident: 'IPCW', freq: '111.10' }, 'REEFS', 'PC09I');
  const r27 = runwayEnd(geo, '27', { ident: 'IPCY', freq: '108.90' }, 'SURFS', 'PC27I');
  return {
    geo,
    nodes: N,
    edges: E,
    stands,
    playerStand: 'S2',
    runways: {
      '09': {
        ...r09,
        entries: [
          { name: 'A2', hold: 'HA2', runway: 'R-700', toraM: r.x1 + 700, intersection: true },
          { name: 'A1', hold: 'HA1', runway: 'R-1350', toraM: r.x1 + 1350, intersection: false },
        ],
        exits: [
          { name: 'E1', node: 'R100', distM: 100 - r.x0, rapid: true },
          { name: 'A4', node: 'R700', distM: 700 - r.x0, rapid: false },
          { name: 'A5', node: 'R1350', distM: 1350 - r.x0, rapid: false },
        ],
      },
      '27': {
        ...r27,
        entries: [
          { name: 'A4', hold: 'HA4', runway: 'R700', toraM: 700 - r.x0, intersection: true },
          { name: 'A5', hold: 'HA5', runway: 'R1350', toraM: 1350 - r.x0, intersection: false },
        ],
        exits: [
          { name: 'E2', node: 'R-100', distM: r.x1 + 100, rapid: true },
          { name: 'A2', node: 'R-700', distM: r.x1 + 700, rapid: false },
          { name: 'A1', node: 'R-1350', distM: r.x1 + 1350, rapid: false },
        ],
      },
    },
    freq: { atis: '128.45', ground: '121.95', tower: '118.70', radar: '119.10' },
    elevationFt: 1.2 / FT,
  };
}

export const AIRFIELDS: Record<Region, Airport> = { home: buildHome(), island: buildIsland() };

// ------------------------------------------------------------------------------------------------
// Fixes and flight plans
// ------------------------------------------------------------------------------------------------
//
// The direct line between the runways is ~39 km, but both runways run east–west, so each
// approach swings out to an initial approach fix over the sea and joins the localizer 5 NM out.
// Gate to gate is about 50 km; the cruise is at 5,000 ft and 250 kt (the speed limit below FL100).

/** The intermediate fix's x: IF_NM before a threshold at `thrX`, landing east (09) or west (27). */
const ifX = (thrX: number, east: boolean) => thrX + (east ? -1 : 1) * IF_NM * NM;
const ISL = AIRPORTS.island.runway;
const HOM = AIRPORTS.home.runway;

export const FIXES: Record<string, Fix> = {
  // departures from the mainland, and the en-route point mid-sea
  TOFFY: { name: 'TOFFY', x: 0, z: 9000, altFt: 4000 },
  CORAL: { name: 'CORAL', x: 0, z: 20000, altFt: 5000 },
  PALMS: { name: 'PALMS', x: 0, z: 32000, altFt: 4000 },
  // Palm Cay's approach: initial approach fixes north-east / north-west of the island, over the sea
  SURFS: { name: 'SURFS', x: 14500, z: 36500, altFt: 3000, spdKt: 220 },
  REEFS: { name: 'REEFS', x: -14500, z: 36500, altFt: 3000, spdKt: 220 },
  PC27I: { name: 'PC27I', x: ifX(ISL.x1, false), z: ISL.z, altFt: IF_FT, spdKt: 180 },
  PC09I: { name: 'PC09I', x: ifX(ISL.x0, true), z: ISL.z, altFt: IF_FT, spdKt: 180 },
  // Funfair International's approach: south-east / south-west of the airport, over the sea
  CANDY: { name: 'CANDY', x: 14800, z: 4700, altFt: 3000, spdKt: 220 },
  TAFFY: { name: 'TAFFY', x: -14800, z: 4700, altFt: 3000, spdKt: 220 },
  FN27I: { name: 'FN27I', x: ifX(HOM.x1, false), z: HOM.z, altFt: IF_FT, spdKt: 180 },
  FN09I: { name: 'FN09I', x: ifX(HOM.x0, true), z: HOM.z, altFt: IF_FT, spdKt: 180 },
};

export const CRUISE_FT = 5000;

/** The runway in use for a wind: the one with a headwind (27 when it's calm or straight across). */
export function runwayForWind(windFrom: number, windKt: number): RunwayIdent {
  if (windKt < 3) return '27';
  const head27 = Math.cos(((windFrom - 270) * Math.PI) / 180);
  return head27 >= -0.05 ? '27' : '09';
}

/** The plan for one leg: departure fix, the mid-sea point, the IAF and the IF, then the runway. */
export function flightPlan(from: Region, depRunway: RunwayIdent, arrRunway: RunwayIdent): FlightPlan {
  const to: Region = from === 'home' ? 'island' : 'home';
  const arr = AIRFIELDS[to].runways[arrRunway];
  const names = from === 'home' ? ['TOFFY', 'CORAL', arr.iaf, arr.if] : ['PALMS', 'CORAL', arr.iaf, arr.if];
  const fixes = names.map((n) => ({ ...FIXES[n] }));
  // the plan's length from the departure runway's liftoff point to the arrival threshold
  const dep = AIRFIELDS[from].runways[depRunway];
  let px = dep.threshold.x + (dep.heading === 90 ? 1 : -1) * 1800;
  let pz = dep.threshold.z;
  let dist = 0;
  for (const f of fixes) {
    dist += Math.hypot(f.x - px, f.z - pz);
    px = f.x;
    pz = f.z;
  }
  dist += Math.hypot(arr.threshold.x - px, arr.threshold.z - pz);
  const blockTimeS = blockTime(from, to, dep, arr, dist);
  return { from, to, depRunway, arrRunway, cruiseFt: CRUISE_FT, fixes, blockTimeS };
}

/** Average taxi speeds the plan assumes (m/s): out, with the turns, the stops at the crossings and the slow line-up (about 12 kt); in, on the faster lanes back (about 17 kt). */
const PLAN_TAXI_OUT_MS = 6;
const PLAN_TAXI_IN_MS = 9;

/**
 * Gate to gate (s), the way an airline plans it: the pushback and engine start, the taxi out along
 * the route ATC gives (the stand's taxilane to the runway entry it hands out), lining up and the
 * takeoff run, the airborne part at an average 96 m/s (the 250 kt climb and cruise, the slower
 * approach), the landing roll to the first exit, and the taxi in to the stand.
 */
function blockTime(from: Region, to: Region, dep: RunwayEnd, arr: RunwayEnd, airM: number) {
  const depAp = AIRFIELDS[from];
  const arrAp = AIRFIELDS[to];
  const entry = dep.entries[0];
  const stand = depAp.stands.find((s) => s.id === depAp.playerStand);
  const outM = (stand && entry ? taxiRoute(depAp, stand.lane, entry.hold)?.lengthM : 0) || 1800;
  const exit = arr.exits[0];
  const inM = (exit ? taxiRoute(arrAp, exit.node, arrAp.playerStand, true)?.lengthM : 0) || 700;
  const taxiOutS = 80 + outM / PLAN_TAXI_OUT_MS + 30;
  const flyingS = 35 + airM / 96 + 45;
  const taxiInS = inM / PLAN_TAXI_IN_MS + 10;
  return Math.round(taxiOutS + flyingS + taxiInS);
}

// ------------------------------------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------------------------------------

/** Position relative to a runway end: metres past the threshold along the landing direction, and right of the centreline. */
export function runwayFrame(rw: RunwayEnd, x: number, z: number) {
  const f = headingVec(rw.heading);
  const dx = x - rw.threshold.x;
  const dz = z - rw.threshold.z;
  // right of heading h = (cos h, sin h) = (−f.z, f.x)
  return { along: dx * f.x + dz * f.z, right: dx * -f.z + dz * f.x };
}

/** Whether a point is on a runway's paved surface (with its shoulders). */
export function onRunway(ap: Airport, x: number, z: number, margin = 0) {
  const r = ap.geo.runway;
  return x >= r.x0 - margin && x <= r.x1 + margin && Math.abs(z - r.z) <= r.width / 2 + r.shoulder + margin;
}

/** The edges leaving a node (respecting one-way exits). */
export function neighbours(ap: Airport, id: string) {
  const out: { to: string; edge: TaxiEdge; len: number }[] = [];
  for (const e of ap.edges) {
    const other = e.a === id ? e.b : !e.oneWay && e.b === id ? e.a : null;
    if (!other) continue;
    const a = ap.nodes[id];
    const b = ap.nodes[other];
    out.push({ to: other, edge: e, len: Math.hypot(b.x - a.x, b.z - a.z) });
  }
  return out;
}

/**
 * The shortest taxi route between two nodes (Dijkstra), never along the runway unless `allowRunway`.
 * Returns the node ids from `from` to `to` and the taxiway names in order (for the clearance), or null.
 */
export function taxiRoute(ap: Airport, from: string, to: string, allowRunway = false): { nodes: string[]; via: string[]; lengthM: number } | null {
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; edge: TaxiEdge }>();
  const open = new Set<string>([from]);
  while (open.size) {
    let cur = '';
    let best = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    open.delete(cur);
    if (cur === to) break;
    for (const n of neighbours(ap, cur)) {
      if (!allowRunway && n.edge.name === 'RWY') continue;
      const d = best + n.len;
      if (d < (dist.get(n.to) ?? Infinity)) {
        dist.set(n.to, d);
        prev.set(n.to, { node: cur, edge: n.edge });
        open.add(n.to);
      }
    }
  }
  if (!dist.has(to)) return null;
  const nodes = [to];
  const via: string[] = [];
  for (let id = to; id !== from; ) {
    const p = prev.get(id)!;
    if (via[0] !== p.edge.name) via.unshift(p.edge.name);
    nodes.unshift(p.node);
    id = p.node;
  }
  return { nodes, via: via.filter((v) => !/^\d+$/.test(v)), lengthM: dist.get(to)! };
}

/** The node nearest to a point (optionally of some kinds). */
export function nearestNode(ap: Airport, x: number, z: number, kinds?: NodeKind[]) {
  let best: TaxiNode | null = null;
  let bd = Infinity;
  for (const n of Object.values(ap.nodes)) {
    if (kinds && !kinds.includes(n.kind)) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best!;
}
