// The world beyond the fair: the mainland's south coast with Funfair International Airport on it,
// the sea, and Palm Cay, a tropical island 40 km south with its own airport and beach park.
//
// Same frame as layout.ts: x → east, z → south, y up, metres. Headings are degrees clockwise from
// north (−z): a heading h points along (sin h, 0, −cos h). True north = magnetic north here.
//
// Everything you can walk on stands at y = 0, like the park (the physics ground is one infinite
// plane at y = 0). The sea's surface is SEA_Y, a little below; beaches slope from 0 down under it.

/** The sea's mean surface (m). Altitudes are measured from here (0 ft MSL). */
export const SEA_Y = -1.2;

/** Unit conversions used across the aviation code. */
export const KT = 0.514444; // m/s per knot
export const FT = 0.3048; // m per foot
export const NM = 1852; // m per nautical mile
export const FPM = FT / 60; // m/s per foot-per-minute

/** A heading in degrees → unit direction on the ground (x, z). */
export function headingVec(deg: number) {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

/** Direction (x, z) → heading in degrees, 0–360. */
export function vecHeading(x: number, z: number) {
  const h = (Math.atan2(x, -z) * 180) / Math.PI;
  return (h + 360) % 360;
}

/**
 * The mainland's south coast: homeCoastZ(x) is the water's edge. Grass (y = 0) runs down to the
 * beach, which is `beach` metres of sand north of the water's edge (flat at y = 0, then sloping
 * into the water over its last 25 m); the sea lies beyond. The edge wanders between z ≈ 1145 and
 * 1315, so it stays at least 100 m south of the runway strip (z ≤ 1040) everywhere.
 *
 * Both landmasses share this profile by shore distance d (see shoreDist): y = 0 for d ≥ 25,
 * then down to SEA_Y at the water's edge (d = 0), then on down under the sea.
 */
export const HOME_COAST = { beach: 70 };
export function homeCoastZ(x: number) {
  return 1230 + 50 * Math.sin(x / 1300 + 0.6) + 25 * Math.sin(x / 470 + 2.1) + 10 * Math.sin(x / 150);
}

/** Metres from a point to the mainland's coastline: positive on land (north of it), negative out at sea. */
export function homeShoreDist(x: number, z: number) {
  return homeCoastZ(x) - z;
}

/**
 * Palm Cay: an island 40 km south of the fair, shaped as a wobbly superellipse (see islandK). The
 * airport runs along its north side; the beach park lies south of the terminal, down to the south
 * beach; the lagoon, inside a reef, is beyond that.
 *
 * Checked: the runway strip and its end safety areas (x ±1700, z 40160..40440) are ≥160 m from the
 * shore, both approach-light rows (to x ±2120) are on land (the tips reach x −2263 and +2445 on the
 * runway's line), the south shore is at z ≈ 41525..41580 across the park, the north shore at 39883.
 */
export const ISLAND = {
  name: 'Palm Cay',
  centre: { x: 0, z: 40740 },
  /** The superellipse's half-axes and exponent, before the shoreline's wobble. */
  rx: 2500,
  rz: 820,
  power: 3,
  /** The walkable beach park, south of the terminal down to the south beach. */
  park: { x0: -520, x1: 520, z0: 40670, z1: 41500 },
  /** Where the south beach's sand starts (it runs down to the water at about z1 of the park + 50). */
  beachZ: 41430,
  /** Open water south of the island, inside the reef, for the jet-ski race. */
  lagoon: { x0: -700, x1: 700, z0: 41620, z1: 42250 },
};

/** Palm Cay's normalised radius at a point: below 1 on the island, 1 on the shoreline, above 1 at sea. */
export function islandK(x: number, z: number) {
  const dx = x - ISLAND.centre.x;
  const dz = z - ISLAND.centre.z;
  const a = Math.atan2(dz, dx);
  const wobble = 1 + 0.035 * Math.sin(3 * a + 1) + 0.025 * Math.sin(5 * a + 2.3) + 0.012 * Math.sin(11 * a + 0.7);
  const p = ISLAND.power;
  return Math.pow(Math.abs(dx / ISLAND.rx) ** p + Math.abs(dz / ISLAND.rz) ** p, 1 / p) / wobble;
}

/** Approximate metres from a point to Palm Cay's shoreline: positive on the island, negative at sea. */
export function islandShoreDist(x: number, z: number) {
  const k = islandK(x, z);
  const gx = (islandK(x + 1, z) - islandK(x - 1, z)) / 2;
  const gz = (islandK(x, z + 1) - islandK(x, z - 1)) / 2;
  return (1 - k) / Math.max(1e-6, Math.hypot(gx, gz));
}

/** Metres to the nearest shoreline, whichever landmass: positive on land, negative at sea. */
export function shoreDist(x: number, z: number) {
  return regionAt(x, z) === 'island' ? islandShoreDist(x, z) : homeShoreDist(x, z);
}

/**
 * Where things stand on Palm Cay (the beach park's plan). Each game module builds round its own
 * anchor; island.ts lays the promenade, palms and the rest round them.
 */
export const ISLAND_SPOTS = {
  /** The terminal's landside doors open onto the arrivals plaza. */
  arrivals: { x: 0, z: 40700 },
  /** The Palm Promenade runs south from the arrivals plaza to the Beach Plaza. */
  plaza: { x: 0, z: 41180 },
  /** The water-slide tower and its splash pool (pool to the south of the tower). */
  slides: { x: -230, z: 41150 },
  /** The pirate fort on the south-west beach; its cannons fire out to sea (south-west). */
  cannons: { x: -380, z: 41400 },
  /** The beach volleyball court on the south beach. */
  volley: { x: 210, z: 41400 },
  /** The jet-ski dock on the south beach; the race runs in the lagoon beyond. */
  jetski: { x: 60, z: 41470 },
};

/**
 * The spots inside each terminal the game uses. `yaw` follows the park's convention (0: facing
 * north, π: facing south): the way the visitor faces standing there.
 *   gateDesk  the desk where flights are booked and boarded (the flight attraction's ring)
 *   arrivals  where the visitor steps off a flight, in the hall
 */
export const AIRPORT_SPOTS: Record<Region, { gateDesk: { x: number; z: number; yaw: number }; arrivals: { x: number; z: number; yaw: number } }> = {
  home: { gateDesk: { x: -30, z: 524, yaw: Math.PI }, arrivals: { x: -30, z: 470, yaw: 0 } },
  island: { gateDesk: { x: -30, z: 40612, yaw: 0 }, arrivals: { x: 0, z: 40690, yaw: Math.PI } },
};

/** Which landmass a point is on (or over): the fair's mainland, or Palm Cay. */
export type Region = 'home' | 'island';
export function regionAt(_x: number, z: number): Region {
  return z > 20000 ? 'island' : 'home';
}

// ------------------------------------------------------------------------------------------------
// Airports. Both runways run east–west (09/27). Taxi routes, stands and the ILS live in
// aviation/airports.ts; the scenery is built from these numbers and from that network.
// ------------------------------------------------------------------------------------------------

export interface RunwayGeo {
  /** "09/27" */
  name: string;
  /** Centreline z, and the x of each threshold (09 at x0, the west end; 27 at x1, the east end). */
  z: number;
  x0: number;
  x1: number;
  width: number;
  /** Paved shoulders either side, beyond the runway's width. */
  shoulder: number;
  /** The graded runway strip either side of the centreline (kept free of obstacles). */
  strip: number;
  /** How far the approach lighting reaches before each threshold. */
  approachLights: number;
}

export interface AirportGeo {
  id: Region;
  /** Fictional ICAO-style code shown on boards, the ND and ATC. */
  icao: string;
  name: string;
  /** The city / place on departure boards. */
  city: string;
  /** ATC callsign prefix: "<name> Tower", "<name> Ground"… */
  atc: string;
  runway: RunwayGeo;
  /** Parallel taxiway A's centreline z (it runs x0..x1 of the runway, minus 50 m each end). */
  taxiwayZ: number;
  /** The apron's rectangle (stands and the taxilane in front of the terminal). */
  apron: { x0: number; x1: number; z0: number; z1: number };
  /** The terminal building's footprint (walk-in). `airside` is the z of its facade facing the apron. */
  terminal: { x0: number; x1: number; z0: number; z1: number; airside: number };
  /** Where the visitor may walk: landside forecourt, the terminal, its gate lounges. */
  walk: { x0: number; x1: number; z0: number; z1: number }[];
  /** Heading of an aircraft parked nose-in at a stand (towards the terminal). */
  standHeading: number;
}

export const AIRPORTS: Record<Region, AirportGeo> = {
  home: {
    id: 'home',
    icao: 'XFUN',
    name: 'Funfair International',
    city: 'Funfair',
    atc: 'Funfair',
    runway: { name: '09/27', z: 900, x0: -1750, x1: 1750, width: 45, shoulder: 7.5, strip: 140, approachLights: 900 },
    taxiwayZ: 720,
    apron: { x0: -330, x1: 330, z0: 548, z1: 690 },
    // a 440 m long terminal: landside to the north (z0), the gates' facade facing the apron (airside)
    terminal: { x0: -220, x1: 220, z0: 440, z1: 540, airside: 540 },
    // the forecourt, the car park, the SkyLink station and the terminal itself
    walk: [{ x0: -240, x1: 240, z0: 290, z1: 541 }],
    standHeading: 0,
  },
  island: {
    id: 'island',
    icao: 'XPCY',
    name: 'Palm Cay',
    city: 'Palm Cay',
    atc: 'Palm Cay',
    runway: { name: '09/27', z: 40300, x0: -1400, x1: 1400, width: 45, shoulder: 7.5, strip: 140, approachLights: 720 },
    taxiwayZ: 40450,
    apron: { x0: -200, x1: 200, z0: 40470, z1: 40598 },
    // a regional terminal south of the apron, facing north; the beach park lies beyond it
    terminal: { x0: -130, x1: 130, z0: 40600, z1: 40670, airside: 40600 },
    walk: [{ x0: -140, x1: 140, z0: 40599, z1: 40700 }],
    standHeading: 180,
  },
};

/**
 * The SkyLink: the free people mover from the fair to the airport. Its park station stands south
 * of the entrance plaza; an elevated guideway (deck at `height`) runs straight south over the
 * Rally Trail to the station at the terminal's forecourt.
 */
export const SKYLINK = {
  park: { x: 22, z: 70 },
  airport: { x: 22, z: 405 },
  height: 11,
};
