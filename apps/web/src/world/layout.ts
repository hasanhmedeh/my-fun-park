// Top-down map of the fair (x → east, z → south). The camera looks north (-z).
//
// The park is a round lawn inside a fence, laid out like a wheel: the carousel on the Hub at its
// centre, four straight avenues out from it (Main Street south to the entrance, North Avenue to the
// gate and the giant wheel, and an avenue east and west), and the Promenade, a loop that ties the
// districts together. Each district has its own plaza on the loop:
//
//   Thrill Ridge (west)      the Thunder Loop and the Sky Flip
//   Cosmos (north-east)      the Rocket Ride, the Nebula 360 and Drone Flights
//   Falcon Gate (east)       the Sky Falcon's station and the Career Museum
//   The Midway (south-east)  the games: Crate Smash, the High Striker and the Duck Shoot
//   Motor Town (south-west)  the kart garage and the Rally Trail's shed (their tracks lie outside the fence)
//   Main Gate (south)        the entrance plaza, the Ticket Booth and the Idea Box
//   Creators' Valley (west)  out of the west gate: the Coaster Workshop and eight plots for the
//                            coasters members build there
//
// Beyond the fair (see geo.ts) the world has one more district on the mainland's south coast and
// two on Palm Cay, 40 km out to sea:
//
//   Funfair International    the airport: Funfair Air's gate 3 desk and the SkyLink's airport station
//   Palm Cay Airport         the island's terminal: the flight home and the arrivals plaza
//   Lagoon Beach             the island's games: the jet-skis, the slides, the cannons and the volleyball
//
// The two landmasses are regions: the visitor walks, fast travels and is kept on the ground within
// the region they stand in, and only a flight takes them across the sea.

import { PLOT_IDS, plotNumber, type PlotId } from '../account/api';
import { AIRPORT_SPOTS, AIRPORTS, ISLAND, ISLAND_SPOTS, SKYLINK, regionAt, type Region } from './geo';

export type { Region };

/** The park's lawn: a circle of radius `r` around (x, z), inside a fence just beyond it. */
export const PARK = { x: 0, z: -50, r: 140 };
/** The fence runs this far outside the lawn's edge. */
export const FENCE_GAP = 2.5;
/** The square of park ground (lawn texture, paths and plazas) under the fair: `size` across, centred on (x, z). */
export const GROUND = { x: 0, z: -50, size: 300 };

export const LAYOUT = {
  spawn: { x: 0, z: 54, heading: 0 },
  letters: { x: 0, z: 42 },
  arch: { x: 0, z: 29 },
  carousel: { x: PARK.x, z: PARK.z }, // on the Hub, at the park's centre
  ferris: { x: 0, z: -262 }, // the giant wheel stands outside the park, at the end of the road out of the north gate
  /** Where each coaster's track starts (the head of its station): the tracks are laid out from here. */
  coaster: { x: -68, z: -58 },
  falcon: { x: 110, z: 22 }, // the station stands just inside the east fence; the rest of the ride is out in the desert
  rocket: { x: 30, z: -150 },
  crates: { x: 68, z: 6 },
  striker: { x: 90, z: 10 },
  ducks: { x: 79, z: 30 }, // the Duck Shoot's stall, south of the Midway, its counter facing north
  booth: { x: 13.5, z: 40 },
  ideas: { x: -13.5, z: 46 }, // the Idea Box, on the entrance plaza's west side, its slot facing east
  drone: { x: 12, z: -170 }, // the rental kiosk, beside North Avenue near the gate
  dronePad: { x: 12, z: -178.5 },
  flip: { x: -64, z: -120 }, // the Sky Flip's tower, in the north-west
  ship: { x: 72, z: -124 }, // the Nebula 360 pendulum ship, at the east end of the Cosmic Way
  speedway: { x: -58, z: 26 }, // the kart garage; the circuit itself lies outside the south-west fence
  /** How far the kart circuit is moved from where its design frame puts it (see speedway-track.ts). */
  circuit: { x: -11, z: 11 },
  trail: { x: -30, z: 72 }, // the Rally Trail's shed; the trail itself lies outside the south fence
  museum: { x: 96, z: -50 }, // the Career Museum's hall, at the east end of the East Avenue; its door faces west
};

/** The Sky Flip's arm swings in a vertical plane turned this far about y, so it faces the park. */
export const FLIP_YAW = Math.PI / 6;

/** (x, z) in the Sky Flip's own frame: lx along its swing, lz out towards the park. */
export function flipLocal(x: number, z: number): [number, number] {
  const dx = x - LAYOUT.flip.x;
  const dz = z - LAYOUT.flip.z;
  const c = Math.cos(FLIP_YAW);
  const s = Math.sin(FLIP_YAW);
  return [dx * c - dz * s, dx * s + dz * c];
}

/**
 * The Career Museum: a hall `halfL` either side of its centre along its length and `halfW` across,
 * inside walls `wall` thick, with a porch `porch` deep in front of the door. In its own frame the
 * hall runs from the door (lz = +halfL) to the end wall (lz = -halfL); it is turned by `yaw`, so
 * its door faces down the East Avenue.
 */
export const MUSEUM = { yaw: -Math.PI / 2, halfW: 6, halfL: 12.5, wall: 0.4, porch: 2.4, height: 6.6 };

/** (x, z) in the museum's own frame, out in the fair. */
export function museumPoint(lx: number, lz: number) {
  const c = Math.cos(MUSEUM.yaw);
  const s = Math.sin(MUSEUM.yaw);
  return { x: LAYOUT.museum.x + lx * c + lz * s, z: LAYOUT.museum.z - lx * s + lz * c };
}

/** A point in the fair, in the museum's own frame. */
export function museumLocal(x: number, z: number) {
  const dx = x - LAYOUT.museum.x;
  const dz = z - LAYOUT.museum.z;
  const c = Math.cos(MUSEUM.yaw);
  const s = Math.sin(MUSEUM.yaw);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/** True on the museum's footprint (walls and porch), grown by `margin`. */
export function onMuseum(x: number, z: number, margin = 0) {
  const { lx, lz } = museumLocal(x, z);
  const m = MUSEUM;
  return Math.abs(lx) < m.halfW + m.wall + margin && lz > -m.halfL - m.wall - margin && lz < m.halfL + m.wall + m.porch + margin;
}

export type ZoneId =
  | 'entrance'
  | 'coaster'
  | 'falcon'
  | 'rocket'
  | 'crates'
  | 'striker'
  | 'ducks'
  | 'ferris'
  | 'booth'
  | 'ideas'
  | 'drone'
  | 'flip'
  | 'ship'
  | 'speedway'
  | 'trail'
  | 'museum'
  | 'workshop'
  | 'flight'
  | 'flightBack'
  | 'airport'
  | 'skylink'
  | 'skylinkBack'
  | 'palmcay'
  | 'jetski'
  | 'slides'
  | 'cannons'
  | 'volley'
  | PlotId;

/**
 * A place: where the visitor is put when they fast travel there (facing `heading`), and the ring
 * they step into to use it (`radius` 0: a destination with no ring). `y` is the floor the ring
 * lies on where that isn't the ground (a terminal's floor sits a little above it).
 */
export type Zone = { x: number; z: number; radius: number; title: string; action: string; heading: number; y?: number };

/**
 * Creators' Valley, west of the park: the Valley Road leaves the Promenade, runs out of the west
 * gate and on past eight 70 × 70 m plots, four either side, where the coasters members build in
 * the Coaster Workshop are released. Odd plots are on the north side of the road, even ones on
 * the south, numbered from the park outward. Each plot has its own frame (as the builder's): x
 * across, z towards its front, which faces the road. The plots themselves aren't walkable: the
 * road and its verges are.
 */
export const VALLEY = {
  /** The road's centre line, from the Promenade out to the far end. */
  road: { z: -10, x0: -54.4, x1: -540, width: 6 },
  /** Where the visitor may walk out here (the road and its verges): z0..z1, as far as x1. */
  walk: { z0: -16.6, z1: -3.4, x1: -536 },
  /** The plots' centres across (x), and each row's centre (z). */
  xs: [-265, -343, -421, -499],
  north: -52,
  south: 32,
  size: 70,
  /**
   * The valley's lawn, beyond the park's ground: the plots' field, and the strip the road crosses
   * from the west gate (narrow enough to keep clear of the kart circuit, south of it).
   */
  lawns: [
    { x0: -560, x1: -216, z0: -110, z1: 88 },
    { x0: -232, x1: -128, z0: -45, z1: 28 },
  ],
  /** The Coaster Workshop's kiosk, on the north verge at the valley's entrance (its counter faces the road). */
  kiosk: { x: -205, z: -21.5 },
  /** The district's plaza, just inside the west gate. */
  plaza: [-118, -10] as [number, number],
};

/** Plot n (1–8): its centre and how its frame is turned (0: front to +z, the north row; π: the south row). */
export function plotPlace(n: number) {
  const north = n % 2 === 1;
  return { x: VALLEY.xs[Math.floor((n - 1) / 2)], z: north ? VALLEY.north : VALLEY.south, yaw: north ? 0 : Math.PI };
}

/** A point in plot n's own frame (lx across, lz towards its front), out in the fair. */
export function plotPoint(n: number, lx: number, lz: number) {
  const p = plotPlace(n);
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** True on plot n's ground (grown by `margin`). */
export function onPlot(n: number, x: number, z: number, margin = 0) {
  const p = plotPlace(n);
  return Math.abs(x - p.x) < VALLEY.size / 2 + margin && Math.abs(z - p.z) < VALLEY.size / 2 + margin;
}

/** True on Creators' Valley's lawn (grown by `margin`), out past the fence. */
export const inValley = (x: number, z: number, margin = 0) =>
  parkDistance(x, z) > PARK.r + FENCE_GAP && VALLEY.lawns.some((l) => x > l.x0 - margin && x < l.x1 + margin && z > l.z0 - margin && z < l.z1 + margin);

/** Where guests step up to plot n's coaster: on the verge in front of its station's entrance stairs. */
const plotZone = (n: number): Zone => {
  const p = plotPoint(n, 4, 37.6);
  return { x: p.x, z: p.z, radius: 3.2, title: `Plot ${n}`, action: 'Ride the coaster', heading: n % 2 === 1 ? 0 : Math.PI };
};

/** A zone `dx`, `dz` from an attraction's anchor: each one keeps its place beside its attraction wherever that stands. */
const near = (a: { x: number; z: number }, dx: number, dz: number, rest: Omit<Zone, 'x' | 'z'>): Zone => ({ x: a.x + dx, z: a.z + dz, ...rest });

/** The terminals' floors: the home terminal's and the SkyLink halls' finish, and Palm Cay's tiles. */
const HOME_FLOOR = 0.02;
const ISLAND_FLOOR = 0.035;

/** Where the visitor is placed when teleporting to a zone, and the zone trigger. */
export const ZONES: Record<ZoneId, Zone> = {
  entrance: near(LAYOUT.spawn, 0, -2, { radius: 0, title: 'Entrance', action: '', heading: 0 }),
  // east of the station: the track itself is a solid wall you can't cross
  coaster: near(LAYOUT.coaster, 7, 8, { radius: 3.6, title: 'Thunder Loop', action: 'Drive the coaster', heading: Math.PI / 2 }),
  falcon: near(LAYOUT.falcon, -7, -10, { radius: 3.6, title: 'Sky Falcon', action: 'Ride the 250 km/h cliff coaster', heading: -Math.PI / 2 }),
  rocket: near(LAYOUT.rocket, 0, 12, { radius: 3.6, title: 'Rocket Ride', action: 'Launch into orbit', heading: 0 }),
  crates: near(LAYOUT.crates, 0, 10, { radius: 3.6, title: 'Crate Smash', action: 'Play a round', heading: 0 }),
  striker: near(LAYOUT.striker, 0, 7, { radius: 3.4, title: 'High Striker', action: 'Swing the hammer', heading: 0 }),
  // at the stall's counter, facing south at the ducks
  ducks: near(LAYOUT.ducks, 0, -6.4, { radius: 3.2, title: 'Duck Shoot', action: 'Shoot the tin ducks', heading: Math.PI }),
  // at the wheel's boarding terminal, at the far end of the road out of the park
  ferris: near(LAYOUT.ferris, 0, 19, { radius: 3.6, title: 'Giant Wheel', action: 'Ride the 250 m wheel', heading: 0 }),
  booth: near(LAYOUT.booth, 0, 6, { radius: 3.4, title: 'Ticket Booth', action: 'Step up to the counter', heading: 0 }),
  // in front of the Idea Box, facing west at its slot
  ideas: near(LAYOUT.ideas, 3.5, 0, { radius: 2.6, title: 'Idea Box', action: 'Share an idea', heading: Math.PI / 2 }),
  // at the kiosk counter, facing east
  drone: near(LAYOUT.drone, -5, 0, { radius: 3.2, title: 'Drone Flights', action: 'Rent a drone', heading: -Math.PI / 2 }),
  // outside the Sky Flip's gate, facing the tower
  flip: near(LAYOUT.flip, 15, 13.9, { radius: 3.4, title: 'Sky Flip', action: 'Swing 125 m up and flip', heading: FLIP_YAW }),
  // at the ship's queue, facing south over the fence at the boat
  ship: near(LAYOUT.ship, 0, -14, { radius: 3.4, title: 'Nebula 360', action: 'Loop the pendulum ship', heading: Math.PI }),
  // at the kart garage's counter, facing south-west towards the circuit
  speedway: near(LAYOUT.speedway, 7, -7, { radius: 3.4, title: 'Turbo Speedway', action: 'Race the karts', heading: (3 * Math.PI) / 4 }),
  // at the Rally Trail's counter, facing south towards the shed and the trail beyond the fence
  trail: near(LAYOUT.trail, -1, -7, { radius: 3.4, title: 'Rally Trail', action: 'Drive the time trial', heading: Math.PI }),
  // on the museum's porch, facing east through its door
  museum: near(LAYOUT.museum, -14.1, 0, { radius: 1.6, title: 'Career Museum', action: 'Take the guided tour', heading: -Math.PI / 2 }),
  // at the Coaster Workshop's counter, facing north at the kiosk
  workshop: near(VALLEY.kiosk, 0, 7, { radius: 3.4, title: 'Coaster Workshop', action: 'Build your own coaster', heading: 0 }),
  // at gate 3's desk in the home terminal, facing it (south: the apron, and FA101 beyond the glass)
  flight: near(AIRPORT_SPOTS.home.gateDesk, 0, 0, { radius: 3, title: 'Funfair Air · Gate 3', action: 'Book a flight', heading: AIRPORT_SPOTS.home.gateDesk.yaw, y: HOME_FLOOR }),
  // at gate 2's desk in Palm Cay's terminal, facing it (north, towards the apron)
  flightBack: near(AIRPORT_SPOTS.island.gateDesk, 0, 0, { radius: 3, title: 'Funfair Air · Palm Cay', action: 'Book the flight home', heading: AIRPORT_SPOTS.island.gateDesk.yaw, y: ISLAND_FLOOR }),
  // just inside the terminal's departures doors (the ones the SkyLink's passengers use), facing into the hall
  airport: { x: SKYLINK.airport.x, z: AIRPORTS.home.terminal.z0 + 12, radius: 0, title: 'Funfair International', action: '', heading: Math.PI },
  // in each SkyLink station's hall, between the lifts: the train to the airport, and the one back to the fair
  skylink: near(SKYLINK.park, 0, 0, { radius: 3, title: 'SkyLink', action: 'Ride to the airport', heading: Math.PI, y: HOME_FLOOR }),
  skylinkBack: near(SKYLINK.airport, 0, 0, { radius: 3, title: 'SkyLink', action: 'Ride back to the fair', heading: 0, y: HOME_FLOOR }),
  // out of the island terminal's arrivals doors, facing the promenade
  palmcay: near(AIRPORT_SPOTS.island.arrivals, 0, 0, { radius: 0, title: 'Palm Cay', action: '', heading: AIRPORT_SPOTS.island.arrivals.yaw }),
  // the island's games, each where its path from the Beach Plaza arrives (see island.ts):
  // the jet-skis at the head of the dock, facing the lagoon
  jetski: near(ISLAND_SPOTS.jetski, -2, -29, { radius: 3.4, title: 'Jet-Ski Race', action: 'Race round the lagoon', heading: Math.PI }),
  // the Splash Tower's gate, at the end of the paved path in from the east, facing the tower
  slides: near(ISLAND_SPOTS.slides, 45, 2, { radius: 3.4, title: 'Splash Tower', action: 'Ride the water slides', heading: Math.PI / 2 }),
  // the pirate fort's gate, at the end of the dune boardwalk, facing the fort (west)
  cannons: near(ISLAND_SPOTS.cannons, 62, -2, { radius: 3.4, title: 'Pirate Cannons', action: 'Sink the pirate ships', heading: Math.PI / 2 }),
  // beside the volleyball court, at the end of its boardwalk, facing the court (east)
  volley: near(ISLAND_SPOTS.volley, -48, -9, { radius: 3.4, title: 'Beach Volley', action: 'Serve, spike and hit the coconuts', heading: -Math.PI / 2 }),
  // each plot's title is its coaster's name while one runs there (see setPlotTitle)
  ...(Object.fromEntries(PLOT_IDS.map((id, i) => [id, plotZone(i + 1)])) as Record<PlotId, Zone>),
};

/** Names a plot's zone after the coaster running on it (or back to "Plot n" when it's empty). */
export function setPlotTitle(id: PlotId, name: string | null) {
  ZONES[id].title = name ?? `Plot ${plotNumber(id)}`;
}

/** Where the road to the giant wheel ends, in front of its terminal. */
const WHEEL_END = LAYOUT.ferris.z + 22;

/**
 * The districts, in the order the map lists them: each with its plaza (and the colour of its signs
 * and paving), its attractions, and where the zoomed-out map writes its name (clear of the pins).
 */
export type DistrictId = 'gate' | 'midway' | 'falcon' | 'cosmos' | 'thrill' | 'motor' | 'valley' | 'airport' | 'palmport' | 'lagoon';
/** A district: the region (landmass) it's on, its plaza (where its sign stands), where the map writes its name, and its places. */
export type District = { name: string; icon: string; color: string; region: Region; plaza: [number, number]; label: [number, number]; zones: ZoneId[] };
export const DISTRICTS: Record<DistrictId, District> = {
  gate: { name: 'Main Gate', icon: '🎪', color: '#ff4d6d', region: 'home', plaza: [0, 18], label: [0, 6], zones: ['entrance', 'booth', 'ideas', 'skylink'] },
  midway: { name: 'The Midway', icon: '🎯', color: '#ffb627', region: 'home', plaza: [79, 18], label: [79, 2], zones: ['crates', 'striker', 'ducks'] },
  falcon: { name: 'Falcon Gate', icon: '🦅', color: '#2ec4b6', region: 'home', plaza: [64, -50], label: [84, -66], zones: ['falcon', 'museum'] },
  cosmos: { name: 'Cosmos', icon: '🚀', color: '#7b5cd6', region: 'home', plaza: [0, -138], label: [-24, -140], zones: ['rocket', 'ship', 'drone', 'ferris'] },
  thrill: { name: 'Thrill Ridge', icon: '🎢', color: '#ff8a3d', region: 'home', plaza: [-56, -50], label: [-34, -62], zones: ['coaster', 'flip'] },
  motor: { name: 'Motor Town', icon: '🏁', color: '#4a90d9', region: 'home', plaza: [-50, 18], label: [-52, 34], zones: ['speedway', 'trail'] },
  valley: { name: "Creators' Valley", icon: '🛠️', color: '#e05aa8', region: 'home', plaza: VALLEY.plaza, label: [-382, -100], zones: ['workshop', ...PLOT_IDS] },
  // the airport on the coast: its "plaza" is the terminal's public hall
  airport: { name: 'Funfair International', icon: '✈️', color: '#5b6cff', region: 'home', plaza: [SKYLINK.airport.x, AIRPORTS.home.terminal.z0 + 12], label: [0, 640], zones: ['flight', 'airport', 'skylinkBack'] },
  // Palm Cay: the terminal and its arrivals plaza; then the beach park's games round the Beach Plaza
  palmport: { name: 'Palm Cay Airport', icon: '🌴', color: '#1fb36b', region: 'island', plaza: [0, 40708], label: [0, 40420], zones: ['flightBack', 'palmcay'] },
  lagoon: { name: 'Lagoon Beach', icon: '🏖️', color: '#00a6d6', region: 'island', plaza: [ISLAND_SPOTS.plaza.x, ISLAND_SPOTS.plaza.z], label: [0, 41290], zones: ['jetski', 'slides', 'cannons', 'volley'] },
};

/**
 * The districts inside the fair itself (on the mainland, on the park's ground): the ones whose
 * plazas are paved into the park's lawn, get benches and idle guests, and join the walkers'
 * network. The airport's and the island's districts have buildings and people of their own.
 */
export const FAIR_DISTRICTS: District[] = Object.values(DISTRICTS).filter(
  (d) => d.region === 'home' && Math.abs(d.plaza[0] - GROUND.x) < GROUND.size / 2 && Math.abs(d.plaza[1] - GROUND.z) < GROUND.size / 2,
);

/** Which region each place is on (its district's). */
export const ZONE_REGION = Object.fromEntries(Object.values(DISTRICTS).flatMap((d) => d.zones.map((id) => [id, d.region]))) as Record<ZoneId, Region>;

/** Each region's name, and the places the flights across the sea leave from and arrive at. */
export const REGION_INFO: Record<Region, { name: string; departure: ZoneId; arrival: ZoneId }> = {
  home: { name: 'The Funfair', departure: 'flight', arrival: 'airport' },
  island: { name: ISLAND.name, departure: 'flightBack', arrival: 'palmcay' },
};

/** Fast travel stays on the landmass the visitor stands on: across the sea, you fly. */
export const canTravel = (from: Region, zone: ZoneId) => ZONE_REGION[zone] === from;

/** The Promenade: the loop round the park's heart, past every district (back round to where it starts). */
export const PROMENADE: [number, number][] = [
  [0, -112], [44, -100], [64, -76], [64, -50], [64, -24], [50, 18], [0, 18], [-50, 18], [-56, -20], [-56, -50], [-56, -80], [-40, -102], [0, -112],
];

/** The Midway: the games' alley, east off the Promenade to the Sky Falcon's station. */
export const MIDWAY: { points: [number, number][]; width: number } = { points: [[50, 18], [98, 18], [103, 12]], width: 5 };

export const PATHS: { points: [number, number][]; width: number }[] = [
  // Main Street, from the entrance plaza north to the Hub, and on as North Avenue, out of the north gate to the giant wheel
  { points: [[0, 58], [0, WHEEL_END]], width: 7 },
  // the East and West Avenues: the Hub out to the museum's door and to the Thunder Loop's station
  { points: [[0, -50], [82, -50]], width: 5 },
  { points: [[0, -50], [-61, -50]], width: 5 },
  // the Promenade
  { points: PROMENADE, width: 5 },
  // Cosmos: the Cosmic Way, from North Avenue past the Rocket Ride to the Nebula 360's queue, and the spur to the drone kiosk
  { points: [[0, -138], [72, -138]], width: 4.5 },
  { points: [[0, -170], [7, -170]], width: 4.5 },
  MIDWAY,
  // the Falcon Walk: from the Promenade below Falcon Gate's plaza, down to the Sky Falcon's station
  { points: [[64, -24], [103, 12]], width: 4.5 },
  // the Rally Lane: the Promenade south to the trail's shed
  { points: [[-31, 18], [-31, 65]], width: 4.5 },
  // the Sky Flip's gate, off the Promenade
  { points: [[-41.1, -100.5], [-49, -106.1]], width: 4.5 },
  // the Valley Road: off the Promenade, out of the west gate, past the plots of Creators' Valley
  { points: [[VALLEY.road.x0, VALLEY.road.z], [VALLEY.road.x1, VALLEY.road.z]], width: VALLEY.road.width },
];

export const PLAZAS: [number, number, number][] = [
  [0, 46, 13], // the entrance plaza
  [0, -50, 14], // the Hub, round the carousel
  [0, -112, 8], // where North Avenue crosses the Promenade
  [0, WHEEL_END, 10], // in front of the giant wheel's terminal
  // the districts' plazas (the fair's own: the airport and the island have paving of their own)
  ...FAIR_DISTRICTS.map(({ plaza: [x, z] }) => [x, z, 8] as [number, number, number]),
  [68, 12, 8], // Crate Smash
  [90, 14, 5.5], // the High Striker
  [79, 23, 4], // the Duck Shoot's counter
  [10, -174, 7.5], // the drone kiosk and its landing pad
  [30, -138, 5], // the Rocket Ride's gate
  [72, -138, 5], // the Nebula 360's queue
  [-49, -106.1, 3.4], // the Sky Flip's gate
  [-51, 19, 5], // the kart garage
  [-31, 65, 5], // the Rally Trail's shed
  [84.4, -50, 3.6], // the Career Museum's steps
  [103, 12, 5], // the Sky Falcon's queue
  [-61, -50, 5], // the Thunder Loop's queue
];

/** The Sky Falcon's station and its queue (its own supports stand in it; nothing else may). */
export const FALCON_STATION: [number, number, number] = [LAYOUT.falcon.x - 2, LAYOUT.falcon.z - 10, 12];

/**
 * The ground each attraction stands on, as circles (x, z, radius) that scenery (trees, lamps, stalls,
 * benches, coaster supports) keeps clear of. The coaster tracks, the Sky Flip's swing and the
 * museum have their own tests (nearTrack, flipLocal, onMuseum).
 */
export const FOOTPRINTS: [number, number, number][] = [
  [LAYOUT.carousel.x, LAYOUT.carousel.z, 9],
  [LAYOUT.arch.x - 8, LAYOUT.arch.z, 2],
  [LAYOUT.arch.x + 8, LAYOUT.arch.z, 2],
  [LAYOUT.letters.x, LAYOUT.letters.z, 10],
  [LAYOUT.booth.x, LAYOUT.booth.z, 4.5],
  [LAYOUT.ideas.x, LAYOUT.ideas.z, 3],
  [LAYOUT.rocket.x, LAYOUT.rocket.z, 9],
  [LAYOUT.rocket.x + 5.2, LAYOUT.rocket.z, 3],
  [LAYOUT.crates.x, LAYOUT.crates.z - 3, 9.5],
  [LAYOUT.striker.x, LAYOUT.striker.z, 3.5],
  [LAYOUT.ducks.x, LAYOUT.ducks.z, 8],
  [LAYOUT.drone.x, LAYOUT.drone.z, 3.5],
  [LAYOUT.dronePad.x, LAYOUT.dronePad.z, 4],
  [LAYOUT.ship.x, LAYOUT.ship.z, 21],
  [LAYOUT.speedway.x, LAYOUT.speedway.z, 8],
  [LAYOUT.trail.x + 1, LAYOUT.trail.z - 0.5, 10],
  [LAYOUT.flip.x, LAYOUT.flip.z, 7],
  [LAYOUT.museum.x, LAYOUT.museum.z, 16],
  [LAYOUT.coaster.x + 3, LAYOUT.coaster.z + 10, 12], // the Thunder Loop's station
  FALCON_STATION,
  [VALLEY.kiosk.x, VALLEY.kiosk.z, 6], // the Coaster Workshop
  [SKYLINK.park.x, SKYLINK.park.z, 19], // the SkyLink's park station, with the escalators along its sides
];

/** True if (x, z) is on an attraction's ground (see FOOTPRINTS), grown by `margin`. */
export const onFootprint = (x: number, z: number, margin = 0) => FOOTPRINTS.some(([fx, fz, r]) => Math.hypot(x - fx, z - fz) < r + margin);

/** The road out of the north gate to the giant wheel: the one stretch of ground outside the fence you can walk on. */
export const WHEEL_ROAD = { half: 4.2, end: WHEEL_END, plaza: { x: LAYOUT.ferris.x, z: WHEEL_END, r: 9.5 } };

/**
 * The lawn the road runs through, beyond the edge of the park's own ground: x within ±half,
 * z from z0 (behind the wheel's terminal) to z1 (just inside the park ground's edge). It fades
 * out into the open country over the last `fade` metres of each side.
 */
export const WHEEL_LAWN = { half: 50, z0: LAYOUT.ferris.z - 6, z1: GROUND.z - GROUND.size / 2 + 4, fade: 12 };

/** How far (x, z) is from the park's centre. */
export const parkDistance = (x: number, z: number) => Math.hypot(x - PARK.x, z - PARK.z);

/** True inside the park's fence, or `margin` metres beyond it (negative: that far inside). */
export const inPark = (x: number, z: number, margin = 0) => parkDistance(x, z) < PARK.r + FENCE_GAP + margin;

/** True on the square of park ground, grown by `margin`. */
export const onParkGround = (x: number, z: number, margin = 0) =>
  Math.abs(x - GROUND.x) < GROUND.size / 2 + margin && Math.abs(z - GROUND.z) < GROUND.size / 2 + margin;

/** The park's square bounding box (its lawn), grown by `margin`. */
export const parkBounds = (margin = 0) => ({ x0: PARK.x - PARK.r - margin, x1: PARK.x + PARK.r + margin, z0: PARK.z - PARK.r - margin, z1: PARK.z + PARK.r + margin });

/** True if (x, z) is on (or within `margin` of) a footpath or plaza. */
export function onPath(x: number, z: number, margin = 0) {
  for (const { points, width } of PATHS)
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) < width / 2 + margin) return true;
    }
  return PLAZAS.some(([px, pz, r]) => Math.hypot(x - px, z - pz) < r + margin);
}

// ------------------------------------------------------------------------------------------------
// Where the visitor may walk
// ------------------------------------------------------------------------------------------------

/** An axis-aligned rectangle on the ground (x0..x1 by z0..z1). */
export interface WalkRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Where a visitor who falls off the world (or into the sea) is put back on their feet. */
export interface Respawn {
  x: number;
  z: number;
  heading: number;
}

/**
 * A piece of walkable ground, in one region: `contains` says whether a point is on it, `nearest`
 * finds its closest point to one that isn't. `respawn` is where a fall from it lands.
 */
export interface WalkArea {
  region: Region;
  /** What it is (for debugging, and to replace an area registered later). */
  name: string;
  contains(x: number, z: number): boolean;
  nearest(x: number, z: number): [number, number];
  respawn: Respawn;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** A rectangular walk area. */
export function rectArea(region: Region, name: string, r: WalkRect, respawn: Respawn): WalkArea {
  return {
    region,
    name,
    contains: (x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1,
    nearest: (x, z) => [clamp(x, r.x0, r.x1), clamp(z, r.z0, r.z1)],
    respawn,
  };
}

/** A round walk area. */
function discArea(region: Region, name: string, cx: number, cz: number, radius: number, respawn: Respawn): WalkArea {
  return {
    region,
    name,
    contains: (x, z) => (x - cx) ** 2 + (z - cz) ** 2 <= radius * radius,
    nearest: (x, z) => {
      const d = Math.hypot(x - cx, z - cz) || 1;
      return [cx + ((x - cx) * radius) / d, cz + ((z - cz) * radius) / d];
    },
    respawn,
  };
}

/** Where a fall lands: the fair's entrance, the airport's hall, Palm Cay's arrivals plaza. */
const FAIR_RESPAWN: Respawn = { ...LAYOUT.spawn };
const AIRPORT_RESPAWN: Respawn = { x: ZONES.airport.x, z: ZONES.airport.z, heading: ZONES.airport.heading };
const ISLAND_RESPAWN: Respawn = { x: ZONES.palmcay.x, z: ZONES.palmcay.z, heading: ZONES.palmcay.heading };
/** Each region's respawn when nothing nearer applies. */
export const RESPAWN: Record<Region, Respawn> = { home: FAIR_RESPAWN, island: ISLAND_RESPAWN };

/** The road out of the north gate runs from just inside the gate out to the wheel's plaza. */
const GATE_Z = PARK.z - PARK.r + WHEEL_ROAD.half;
/** The Valley Road leaves the park just inside the west gate. */
const WEST_GATE_X = -Math.sqrt(PARK.r ** 2 - (VALLEY.road.z - PARK.z) ** 2) + 4;

/**
 * Palm Cay's beach park before its own walk areas are registered (from the plan in geo.ts and
 * island.ts): from the terminal's landside wall down onto the dry sand past the beach boardwalk
 * (the shore is at z 41525 or further south across the park, and the dry sand reaches to 22 m
 * short of it), where the jet-skis' dock starts.
 */
const PALM_CAY_SEED: WalkRect = { x0: ISLAND.park.x0, x1: ISLAND.park.x1, z0: 40670.5, z1: 41480 };

/**
 * The ground the visitor may walk on, region by region:
 *   the fair    inside the fence, the road to the giant wheel and its plaza, the Valley Road
 *   the airport the forecourt (car parks, the kerb, the SkyLink's station) and the terminal
 *   Palm Cay    the island terminal and its arrivals plaza, the beach park
 * The terminals and the beach park register their exact areas once they're built
 * (registerWalkAreas); these cover them meanwhile.
 */
const BASE_AREAS: WalkArea[] = [
  discArea('home', 'park', PARK.x, PARK.z, PARK.r, FAIR_RESPAWN),
  rectArea('home', 'wheel road', { x0: PARK.x - WHEEL_ROAD.half, x1: PARK.x + WHEEL_ROAD.half, z0: WHEEL_ROAD.end, z1: GATE_Z }, FAIR_RESPAWN),
  discArea('home', 'wheel plaza', WHEEL_ROAD.plaza.x, WHEEL_ROAD.plaza.z, WHEEL_ROAD.plaza.r, FAIR_RESPAWN),
  rectArea('home', 'valley road', { x0: VALLEY.walk.x1, x1: WEST_GATE_X, z0: VALLEY.walk.z0, z1: VALLEY.walk.z1 }, FAIR_RESPAWN),
  ...AIRPORTS.home.walk.map((r, i) => rectArea('home', `airport ${i + 1}`, r, AIRPORT_RESPAWN)),
  ...AIRPORTS.island.walk.map((r, i) => rectArea('island', `island terminal ${i + 1}`, r, ISLAND_RESPAWN)),
  rectArea('island', 'palm cay', PALM_CAY_SEED, ISLAND_RESPAWN),
];

/** Walk areas registered after construction, by key (registering a key again replaces its areas). */
const registered = new Map<string, WalkArea[]>();

/** Every walk area, in every region (the base ones first, then those registered). */
export const WALK_AREAS: WalkArea[] = [...BASE_AREAS];
/** The same, split by region: the clamp only ever looks in the visitor's own. */
const BY_REGION: Record<Region, WalkArea[]> = { home: [], island: [] };
function rebuild() {
  WALK_AREAS.length = 0;
  WALK_AREAS.push(...BASE_AREAS, ...[...registered.values()].flat());
  BY_REGION.home = WALK_AREAS.filter((a) => a.region === 'home');
  BY_REGION.island = WALK_AREAS.filter((a) => a.region === 'island');
}
rebuild();

/**
 * Adds walkable rectangles (y = 0) to a region, from a building that knows its own floor plan:
 * the home terminal's and the SkyLink's `walk`, Palm Cay's park and terminal `walk`. Registering
 * the same `key` again replaces what it added before. A fall from them respawns at `respawn`
 * (default: the region's own).
 */
export function registerWalkAreas(region: Region, rects: readonly WalkRect[], key: string, respawn: Respawn = region === 'home' ? AIRPORT_RESPAWN : ISLAND_RESPAWN) {
  registered.set(
    key,
    rects.map((r, i) => rectArea(region, `${key} ${i + 1}`, r, respawn)),
  );
  rebuild();
}

/** True if (x, z) is on walkable ground (in its own region). */
export function onWalk(x: number, z: number, region: Region = regionAt(x, z)) {
  for (const a of BY_REGION[region]) if (a.contains(x, z)) return true;
  return false;
}

/** The walk area nearest (x, z) in its region, and that nearest point. */
function nearestArea(x: number, z: number, region: Region) {
  let best: WalkArea | null = null;
  let point: [number, number] = [x, z];
  let bd = Infinity;
  for (const a of BY_REGION[region]) {
    const p = a.nearest(x, z);
    const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
    if (d < bd) {
      bd = d;
      best = a;
      point = p;
    }
  }
  return { area: best, point };
}

/**
 * Where the visitor may walk (see WALK_AREAS). Returns the nearest walkable point to (x, z), or
 * null when (x, z) is already walkable. It only looks in the region (x, z) is in, so nothing ever
 * pulls a visitor across the sea.
 */
export function clampToGrounds(x: number, z: number, region: Region = regionAt(x, z)): [number, number] | null {
  for (const a of BY_REGION[region]) if (a.contains(x, z)) return null;
  return nearestArea(x, z, region).point;
}

/** Where a visitor who fell at (x, z) gets back on their feet: the respawn of the walk area nearest them, in their region. */
export function respawnFor(x: number, z: number, region: Region = regionAt(x, z)): Respawn {
  return nearestArea(x, z, region).area?.respawn ?? RESPAWN[region];
}
