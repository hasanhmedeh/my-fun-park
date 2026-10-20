// The plan of Funfair International's terminal: every number the building, its interior, the jet
// bridges, the forecourt and the SkyLink stations are laid out from, in one place, so that the
// walls the visitor bumps into, the furniture the crowd walks round and the spots they head for
// all agree.
//
//   z 422..440   the kerb walk under the roof's landside overhang (columns on its edge, z 433)
//   z 440        the landside facade: doors at x −154, −110 (arrivals) and 22, 110, 154 (departures)
//   z 440..487   the public hall: arrivals and the meeting point (west), information, the entrance
//                from the SkyLink (x 22), check-in islands (east)
//   z 470..512   baggage reclaim (x −220..−40), under the west mezzanine
//   z 487..501   security, under the east mezzanine; food court (east) and shops (west) beside it
//   z 501..512   duty free, the concourse's shops
//   z 512..540   the concourse and gate lounges 1–6; each gate's escalator up to its jet bridge
//   z 540        the airside facade; fixed links out to the rotundas at z 547

import { AIRFIELDS, type Stand } from '../../aviation/airports';
import { AIRPORTS, AIRPORT_SPOTS, SKYLINK } from '../geo';
import type { V2, WalkRect } from './terminal-kit';

export const TERM = AIRPORTS.home.terminal;
/** The landside (north) and airside (south) facades. */
export const LAND_Z = TERM.z0;
export const AIR_Z = TERM.z1;
/** The floor's surface (a little above the grass so the two never fight). */
export const FLOOR_Y = 0.02;

// ------------------------------------------------------------------------------------------------
// The roof: one long wave, arched across the building, overhanging both sides
// ------------------------------------------------------------------------------------------------

export const ROOF = { x0: -228, x1: 228, z0: 422, z1: 552 };
/** The wave's length along the building (crests over x = 0, ±88, ±176) and the arch's centre line. */
const WAVE = 88;
const ARCH_Z = 490;
const ARCH_HALF = 66;

/** How far the arch has risen at z: 1 along the centre line, falling to ~0 at the overhangs' edges. */
function arch(z: number) {
  const u = (z - ARCH_Z) / ARCH_HALF;
  return 1 - u * u;
}

/** The roof's underside (the timber ceiling) at (x, z). */
export function roofUnder(x: number, z: number) {
  return 14.6 + 4.2 * arch(z) + 1.9 * Math.cos((2 * Math.PI * x) / WAVE);
}

/** The roof's depth at z: deepest along its spine. */
export function roofDepth(z: number) {
  return 1.0 + 1.5 * Math.max(0, arch(z));
}

/** The skylights: five long lights over the wave crests, either side of the spine. */
export const SKYLIGHTS: WalkRect[] = [-176, -88, 0, 88, 176].flatMap((cx) => [
  { x0: cx - 14, x1: cx + 14, z0: 470, z1: 482 },
  { x0: cx - 14, x1: cx + 14, z0: 498, z1: 510 },
]);

// ------------------------------------------------------------------------------------------------
// Structure
// ------------------------------------------------------------------------------------------------

/** The tree columns holding the roof up inside: two rows, 44 m apart along the building. */
export const COLUMNS: V2[] = [466, 514].flatMap((z) => [-176, -132, -88, -44, 0, 44, 88, 132, 176].map((x) => ({ x, z })));
/** The columns on the kerb, under the landside overhang. */
export const KERB_Z = 433;
export const KERB_COLUMNS: V2[] = [-198, -132, -66, 66, 198].map((x) => ({ x, z: KERB_Z }));
/** Each column's colour, west to east: the fair's palette run down the building. */
export const COLUMN_COLOURS = ['#7b5cd6', '#5a8dee', '#2ec4b6', '#7ee2b8', '#ffc23d', '#ff8a3d', '#ff4d6d', '#c9304f', '#7b5cd6'];

export type DoorKind = 'arrivals' | 'departures';
/** The landside doors (centre x, width), each a pair of sliding glass leaves under a small canopy. */
export const DOORS: { x: number; w: number; kind: DoorKind }[] = [
  { x: -154, w: 5, kind: 'arrivals' },
  { x: -110, w: 5, kind: 'arrivals' },
  { x: 22, w: 7, kind: 'departures' },
  { x: 110, w: 5, kind: 'departures' },
  { x: 154, w: 5, kind: 'departures' },
];

/** The mezzanines (decks over the reclaim hall and over security): top and underside heights. */
export const MEZZ_TOP = 6.4;
export const MEZZ_UNDER = 5.8;
export const MEZZANINES: WalkRect[] = [
  { x0: -220, x1: -40, z0: 470, z1: 512 },
  { x0: -40, x1: 210, z0: 487, z1: 503 },
];
/** The slim columns under the mezzanines' open edges. */
export const MEZZ_COLUMNS: V2[] = [
  ...[-15, 10, 35, 60, 85, 110, 135, 160, 185, 208].flatMap((x) => [
    { x, z: 487.6 },
    { x, z: 502.4 },
  ]),
];

/** Baggage reclaim: its walls, the door in from the gates (south) and the exit into the arrivals hall (north). */
export const RECLAIM = { x0: -220, x1: -40, z0: 470, z1: 512, entryX: -61, exitX: -100, door: 6 };
/** The reclaim belts: long ovals running north–south. */
export const BELTS = [-185, -152, -119].map((x, i) => ({ belt: i + 1, x, z0: 478, z1: 503, half: 3.2 }));

/** Security: the partition line, the screening line (where the arches stand) and the lanes' conveyors. */
export const SECURITY = { z0: 487, z1: 501, screenZ: 494, lanes: [12, 22, 32, 42, 52, 62, 72] };
/** The x of each lane's walk-through arch: beside its conveyor. */
export const archX = (laneX: number) => laneX + 2.4;
/** Inside width of an arch (wide enough for anyone, as the accessible lanes are). */
export const ARCH_W = 1.3;

/** Check-in: three islands running north–south, desks along both sides, a bag belt down the middle. */
export const CHECKIN = { xs: [110, 154, 198], z0: 450, z1: 478, half: 3.4, desks: 11 };

/** The shops, cafés and other blocks the visitor walks round (footprint, height of their walls). */
export interface Unit extends WalkRect {
  name: string;
  sub: string;
  /** Fascia colours. */
  bg: string;
  fg: string;
  accent: string;
  /** Which side its open front faces: 'n' (−z), 's', 'e' (+x), 'w'. */
  front: 'n' | 's' | 'e' | 'w';
  kind: 'shop' | 'cafe' | 'food' | 'toilets' | 'desk';
}
export const UNITS: Unit[] = [
  // arrivals hall, against the reclaim hall's north wall
  { name: 'Candy Floss Café', sub: 'Coffee · cakes · candy floss', x0: -84, x1: -62, z0: 462, z1: 470, bg: '#ff4d6d', fg: '#fff5e3', accent: '#ffc23d', front: 'n', kind: 'cafe' },
  { name: 'Ferris Pharmacy', sub: 'Travel essentials', x0: -174, x1: -156, z0: 462, z1: 470, bg: '#2ec4b6', fg: '#ffffff', accent: '#1d1238', front: 'n', kind: 'shop' },
  // airside, under the east mezzanine: the food court's kitchens behind their counters
  { name: 'Corn Dog Co.', sub: 'Corn dogs · fries', x0: 120, x1: 136, z0: 487, z1: 493, bg: '#ffc23d', fg: '#1d1238', accent: '#ff4d6d', front: 's', kind: 'food' },
  { name: 'Pizza Wheel', sub: 'Wood-fired by the slice', x0: 138, x1: 154, z0: 487, z1: 493, bg: '#c9304f', fg: '#fff5e3', accent: '#ffc23d', front: 's', kind: 'food' },
  { name: 'Noodle Coaster', sub: 'Ramen · bao · bowls', x0: 156, x1: 172, z0: 487, z1: 493, bg: '#1d1238', fg: '#ffc23d', accent: '#2ec4b6', front: 's', kind: 'food' },
  { name: 'Fresh Squeeze', sub: 'Juices · smoothies', x0: 174, x1: 190, z0: 487, z1: 493, bg: '#7ee2b8', fg: '#1d1238', accent: '#ff8a3d', front: 's', kind: 'food' },
  { name: 'Big Top Burgers', sub: 'Burgers · shakes', x0: 192, x1: 208, z0: 487, z1: 493, bg: '#ff8a3d', fg: '#fff5e3', accent: '#1d1238', front: 's', kind: 'food' },
  // airside west of security
  { name: 'Ticket Stub News', sub: 'News · books · snacks', x0: -38, x1: -18, z0: 487, z1: 497, bg: '#5a8dee', fg: '#ffffff', accent: '#ffc23d', front: 's', kind: 'shop' },
  { name: 'Big Top Coffee', sub: 'Espresso bar', x0: -14, x1: 4, z0: 487, z1: 495, bg: '#3b2a20', fg: '#ffc23d', accent: '#ff4d6d', front: 's', kind: 'cafe' },
  { name: 'Toilets', sub: '', x0: 84, x1: 116, z0: 487, z1: 497, bg: '#24272d', fg: '#ffcc1a', accent: '#24272d', front: 's', kind: 'toilets' },
  // the concourse's west and east ends
  { name: 'Toilets', sub: '', x0: -219.6, x1: -204, z0: 515, z1: 539.6, bg: '#24272d', fg: '#ffcc1a', accent: '#24272d', front: 'e', kind: 'toilets' },
  { name: 'Lucky Arcade', sub: 'Games · prizes', x0: 196, x1: 219.6, z0: 515, z1: 534, bg: '#7b5cd6', fg: '#ffc23d', accent: '#ff4d6d', front: 'w', kind: 'shop' },
];

/** The duty-free walk-through, just past security. */
export const DUTY_FREE = { x0: 8, x1: 82, z0: 502, z1: 511.5 };
/** The information desk in the public hall. */
export const INFO_DESK = { x: -20, z: 457, r: 3.2 };

// ------------------------------------------------------------------------------------------------
// Gates
// ------------------------------------------------------------------------------------------------

export interface GatePlan {
  gate: number;
  stand: Stand;
  /** The stand's x (the gate's lounge is centred on it). */
  sx: number;
  /** The jet bridge's rotunda, and the doorway in the facade its fixed link starts from. */
  rotunda: V2;
  doorwayX: number;
  /** The gate desk's centre (its counter faces north, the lounge). */
  desk: V2;
  /** The glazed boarding area round the escalator: its rectangle and the door in its north side. */
  pen: WalkRect;
  penDoor: { x0: number; x1: number };
  /** The escalator's foot (where passengers step on, going west, up to the bridge). */
  foot: V2;
}

/** The gate lounges' seats face south, out at the apron; the desk sits between the seat blocks. */
export const DESK_Z = 525.5;
export const GATES: GatePlan[] = AIRFIELDS.home.stands.map((stand) => {
  const sx = stand.x;
  return {
    gate: stand.gate,
    stand,
    sx,
    rotunda: { x: sx - 20, z: 547 },
    doorwayX: sx - 20,
    desk: { x: sx, z: DESK_Z },
    pen: { x0: sx - 24, x1: sx - 7.5, z0: 530, z1: AIR_Z - 0.3 },
    penDoor: { x0: sx - 10.5, x1: sx - 7.9 },
    foot: { x: sx - 10.6, z: 538.2 },
  };
});
/** The escalator up to a gate's bridge: the top landing, then the incline down eastwards to the foot. */
export const ESCALATOR = { topX: -17.6, footX: -11.6, landX0: -22.2, z0: 537.3, z1: 539.0, stairZ0: 535.7, stairZ1: 537.1 };
/** The fixed link from the facade to the rotunda: its floor matches the rotunda's. */
export const LINK_W = 2.4;

// ------------------------------------------------------------------------------------------------
// The SkyLink stations (shared with skylink.ts and the forecourt)
// ------------------------------------------------------------------------------------------------

/**
 * Each station: a glazed hall at ground level (lifts up to the platform) under the platform deck,
 * which carries the guideway's end. Halls are 20 m by 24 m, centred on the station's point.
 */
export const STATION = { halfX: 10, halfZ: 12 };
export const stationHall = (c: V2): WalkRect => ({ x0: c.x - STATION.halfX, x1: c.x + STATION.halfX, z0: c.z - STATION.halfZ, z1: c.z + STATION.halfZ });

/**
 * The guideway and its stations, across the line (x offsets from its centre line, x = 22):
 *   the two lanes (each with its own train, shuttling) at ±1.8, their running surface at the deck
 *   (11 m); in the stations a side platform outside each lane, from ±3.3 (the screen doors) out to
 *   the glass at ±10, at the cars' floor height; a glass lift from the hall up to each platform at
 *   ±6.6, halfway along; an escalator pair outside each long wall, from the hall's north end up to
 *   the platform's south end.
 */
export const SKY = {
  lanes: [-1.8, 1.8],
  deck: SKYLINK.height,
  floor: SKYLINK.height + 0.9,
  psdX: 3.3,
  lift: { x: 6.6, hx: 1.2, hz: 1.3 },
};
/** Where the visitor waits to take the SkyLink: the middle of a station's hall, between the lifts. */
export const skylinkSpot = (c: V2): V2 => ({ x: c.x, z: c.z });

// ------------------------------------------------------------------------------------------------
// The forecourt
// ------------------------------------------------------------------------------------------------

/** The kerb road in front of the terminal (one way, eastbound), and the kerb walk between it and the doors. */
export const KERB_ROAD = { z0: 419, z1: 431, x0: -246, x1: 246 };
/** The airport's access road, running east–west north of the car parks (dual carriageway). */
export const ACCESS_ROAD = { z: 270, half: 9.5, x0: -2700, x1: 2700 };
/** The link roads from the access road down to the kerb (west, southbound) and back up (east, northbound). */
export const LINK_ROADS = { west: -254, east: 254, half: 4 };
/** The car parks: surface (west) and multi-storey (east). */
export const CAR_PARK = { x0: -232, x1: -14, z0: 296, z1: 388 };
export const GARAGE = { x0: 64, x1: 232, z0: 300, z1: 384, levels: 4, storey: 3.1 };

/** Where the visitor may walk: the forecourt (car parks, roads, the station) and the terminal's floor. */
export const WALK: WalkRect[] = [
  { x0: -240, x1: 240, z0: 290, z1: LAND_Z + 0.5 },
  { x0: TERM.x0 + 0.4, x1: TERM.x1 - 0.4, z0: LAND_Z, z1: AIR_Z - 0.4 },
];

/** The spots the game itself places the visitor at (from geo.ts, so the two never disagree). */
export const GATE_DESK_SPOT = AIRPORT_SPOTS.home.gateDesk;
export const ARRIVAL_SPOT = AIRPORT_SPOTS.home.arrivals;
export const SKYLINK_POINT = SKYLINK.airport;
