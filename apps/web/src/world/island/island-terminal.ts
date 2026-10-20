// Palm Cay's terminal: a tropical regional airport in three timber pavilions under deep palm
// thatch (a tall pyramid over the central hall, long hipped wings either side), with a glass wall
// onto the apron, louvred hardwood screens to the landside and open-air gaps under the eaves for
// the breeze. West of the central partition: departures, the check-in hall with its island of
// desks, two security lanes and the gate lounge (gates 1, 2 and the walk-out door for 3 and 4).
// East of it: arrivals, a welcome lobby with passport booths, the baggage hall with its
// carousel, tour desks and a café, and the exit under a thatched canopy onto the arrivals plaza.
//
// Passengers walk across the apron between the gate doors and the stands' airstairs along
// painted walkways (there are no jet bridges here). Everything stands on the ground (y = 0); the
// roof is not walkable. Static parts are merged per material (kit.ts); the fans are one instanced
// mesh, the flight boards one canvas, the stairs two instanced meshes (airstairs.ts).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { staticBox, staticCylinder, type Ctx } from '../context';
import { AIRPORT_SPOTS, AIRPORTS } from '../geo';
import { AIRFIELDS } from '../../aviation/airports';
import { A320_POINTS } from '../../aviation/a320';
import { FlightBoards, type FlightRow } from '../airport/boards';
import { mulberry } from '../random';
import { BODY_FONT, DISPLAY_FONT } from '../textures';
import { Airstairs, airstairsGroup } from './airstairs';
import { Palms, Shrubs, canMultiDraw, type PalmSpot, type ShrubSpot } from './flora';
import { Batch, Batches, SignAtlas, at, hipRoof, islandMaterials, litLevel, place, setInteriorFill, setInteriorFillColor, signPlane, strip, type SignStyle, type UvRect, type V2, type WalkRect } from './kit';
import { NightLights } from './lights';
import { lantern, torch, type Build } from './props';

const AP = AIRPORTS.island;
const T = AP.terminal;
/** The terminal's meshes are stored relative to its middle (precision 40 km out). */
const ORIGIN = { x: 0, y: 0, z: (T.z0 + T.z1) / 2 };
/** The static batches' culling cells (m), where the GPU can multi-draw (kit.ts, Batch.build). */
const BATCH_CELL = 40;

/** The airside glass wall, the line between the airside and landside halls, the landside screens. */
const Z_AIR = T.z0;
const Z_MID = 40630;
const Z_LAND = T.z1;
/** The partition between departures (west) and arrivals (east), and the arrivals lobby's east wall (offices beyond). */
const X_SPLIT = -6;
const X_OFFICE = 40;
/** Openings: the departures entrance and the arrivals exit (landside), security, the gate and arrivals doors (airside). */
const ENTRANCE = { x0: -62, x1: -34 };
const EXIT = { x0: -5, x1: 15 };
const SECURITY = { x0: -58, x1: -42 };
const GATE_DOORS: { gate: string; x: number; stands: string[] }[] = [
  { gate: '1', x: -90, stands: ['S1'] },
  { gate: '2', x: -30, stands: ['S2'] },
  { gate: '3 · 4', x: -14, stands: ['S3', 'S4'] },
];
const ARRIVALS_DOOR = { x0: 2, x1: 10 };
const DOOR_HALF = 1.6;
/** The roofs: the wings' eaves and rise, the central pyramid's half-size, eaves and rise. */
const WING = { eave: 6.5, rise: 16, inner: 38, outer: T.x1 + 3, z0: T.z0 - 3, z1: T.z1 + 3 };
const HALL = { half: 41, eave: 9, rise: 18 };
/** The exit canopy over the arrivals kerb (where the visitor steps out after a flight). */
const CANOPY = { x0: -18, x1: 18, z0: Z_LAND, z1: 40702, eave: 5.4 };
/**
 * The light under the roofs (kit.ts's interior fill): by day the sun bounced off the sand-coloured
 * floor and in through the open sides, warm; at night the lamps' glow. The fill boxes reach FILL_PAD
 * past the walls (it fades in over 3 m from a box's edge).
 */
const FILL_DAY = new THREE.Color('#ffe2bc');
const FILL_NIGHT = new THREE.Color('#ffbf80');
const FILL_DAY_K = 1.8;
const FILL_NIGHT_K = 0.55;
const FILL_PAD = 2.5;
const FILL_COLOUR = new THREE.Color();

/** The underside of the thatch above (x, z): the highest of the three roofs there (hipRoof's planes). */
function roofY(x: number, z: number) {
  const hip = (cx: number, hw: number, hd: number, base: number, rise: number) => {
    const t = Math.min(1 - Math.abs(z - ORIGIN.z) / hd, (hw - Math.abs(x - cx)) / hd);
    return t > 0 ? base + rise * t : -Infinity;
  };
  const hw = (WING.outer - WING.inner) / 2;
  const hd = (WING.z1 - WING.z0) / 2;
  return Math.max(
    hip(-(WING.inner + hw), hw, hd, WING.eave + 0.4, WING.rise),
    hip(WING.inner + hw, hw, hd, WING.eave + 0.4, WING.rise),
    hip(0, HALL.half, HALL.half, HALL.eave + 0.4, HALL.rise),
  );
}

/** Where the visitor may walk inside (y = 0). */
const WALK: WalkRect[] = [
  { x0: T.x0 + 0.4, x1: X_SPLIT - 0.4, z0: Z_AIR + 0.4, z1: Z_MID - 0.4 }, // departure lounge
  { x0: T.x0 + 0.4, x1: X_SPLIT - 0.4, z0: Z_MID + 0.4, z1: Z_LAND - 0.4 }, // check-in hall
  { x0: SECURITY.x0, x1: SECURITY.x1, z0: Z_MID - 1, z1: Z_MID + 1 }, // through security
  { x0: ENTRANCE.x0, x1: ENTRANCE.x1, z0: Z_LAND - 1, z1: Z_LAND + 3 }, // the departures entrance
  { x0: X_SPLIT + 0.4, x1: X_OFFICE - 0.4, z0: Z_AIR + 0.4, z1: Z_MID - 0.4 }, // arrivals lobby
  { x0: X_SPLIT + 0.4, x1: X_OFFICE - 0.4, z0: Z_MID - 1, z1: Z_MID + 1 }, // through passport control
  { x0: X_SPLIT + 0.4, x1: T.x1 - 0.4, z0: Z_MID + 0.4, z1: Z_LAND - 0.4 }, // baggage hall
  { x0: EXIT.x0, x1: EXIT.x1, z0: Z_LAND - 1, z1: Z_LAND + 1 }, // the exit
  { x0: CANOPY.x0 - 12, x1: CANOPY.x1 + 12, z0: Z_LAND, z1: CANOPY.z1 }, // under the canopy, onto the plaza
];

export interface IslandTerminalSpots {
  /** Gate 2's desk, where FA102 is booked and boarded (= AIRPORT_SPOTS.island.gateDesk). */
  gateDesk: V2;
  /** Gate 2's door → the painted walkway across the apron → the foot of S2's airstairs. */
  boardingPath: V2[];
  /** The foot of S2's airstairs → the walkway → the arrivals door → passport control → the baggage hall → the exit → the arrivals plaza. */
  arrivalsPath: V2[];
  /** Seats in the gate lounge (where to stand to sit, and the way to face). */
  seats: (V2 & { yaw: number })[];
}

/** Believable boards before the game sets the real ones: island hops and the flight home. */
export const ISLAND_DEPARTURES: FlightRow[] = [
  { time: '15:45', flight: 'PC013', to: 'Coconut Reef', gate: '4', status: 'Departed' },
  { time: '16:10', flight: 'CN238', to: 'Candy Island', gate: '1', status: 'Departed' },
  { time: '16:35', flight: 'SU420', to: 'Sunset Bay', gate: '3', status: 'Gate closed' },
  { time: '16:55', flight: 'FA102', to: 'Funfair', gate: '2', status: 'Boarding' },
  { time: '17:20', flight: 'PC015', to: 'Lagoon City', gate: '4', status: 'On time' },
  { time: '17:45', flight: 'FA106', to: 'Funfair', gate: '1', status: 'On time' },
  { time: '18:15', flight: 'CN240', to: 'Candy Island', gate: '3', status: 'Delayed 15′' },
  { time: '18:50', flight: 'FA110', to: 'Funfair', gate: '2', status: 'On time' },
];
export const ISLAND_ARRIVALS: FlightRow[] = [
  { time: '15:40', flight: 'FA101', to: 'Funfair', gate: '1', status: 'Baggage in hall' },
  { time: '16:00', flight: 'SU419', to: 'Sunset Bay', gate: '1', status: 'Landed' },
  { time: '16:25', flight: 'PC014', to: 'Lagoon City', gate: '1', status: 'Landed' },
  { time: '16:50', flight: 'CN239', to: 'Candy Island', gate: '1', status: 'Expected 16:58' },
  { time: '17:15', flight: 'FA105', to: 'Funfair', gate: '1', status: 'On time' },
  { time: '17:40', flight: 'PC016', to: 'Coconut Reef', gate: '1', status: 'On time' },
  { time: '18:30', flight: 'FA109', to: 'Funfair', gate: '1', status: 'On time' },
];

const NAVY = '#14213d';
const YELLOW = '#ffd23f';
const WAY: SignStyle = { bg: NAVY, fg: YELLOW, font: 'body', square: true };

export class IslandTerminal {
  readonly group = new THREE.Group();
  readonly walk: WalkRect[] = WALK;
  /** The painted walkways on the apron, between the doors and the stands' stairs (not for free walking: the flight scripts it). */
  readonly apronWalk: WalkRect[] = [];
  readonly stairs: Record<string, Airstairs> = {};
  readonly spots: IslandTerminalSpots;
  private mats = islandMaterials();
  private signMat: THREE.MeshStandardMaterial;
  private boards: FlightBoards;
  private lights: NightLights;
  /** The static batches (their small parts are hidden by distance, see kit.ts). */
  private batches: Batches;
  private palms: Palms;
  private shrubs: Shrubs;
  /** The spinning fans (high and medium tiers; the low ones merge still fans into the static paint). */
  private fans: Fans | null = null;
  private night = -1;

  constructor(private ctx: Ctx) {
    const q = ctx.quality;
    this.mats = islandMaterials(ctx.renderer);
    const atlas = new SignAtlas(ctx.renderer);
    const lean = q.tier === 'low' || q.tier === 'lowest';
    this.lights = new NightLights(ORIGIN, lean);
    this.boards = new FlightBoards(ctx.renderer, { airport: `${AP.name} · ${AP.icao}`, airline: 'Funfair Air · Palm Cay Air', gates: [1, 2, 3, 4] });
    this.boards.setDepartures(ISLAND_DEPARTURES);
    this.boards.setArrivals(ISLAND_ARRIVALS);
    const k: Build = { b: new Batches(ORIGIN), lights: this.lights, atlas, ctx, rnd: mulberry(5150), tier: q.tier, colliders: true };
    const screens = new Batch(ORIGIN);
    const palms: PalmSpot[] = [];
    const shrubs: ShrubSpot[] = [];
    const fanSpots: THREE.Vector3[] = [];
    const seats: (V2 & { yaw: number })[] = [];
    const plan = new Plan(k, screens, this.boards.screens, palms, shrubs, fanSpots, seats);
    plan.build();
    // a set of stairs at every stand, parked clear of its aircraft until it's called
    for (const s of AIRFIELDS.island.stands) this.stairs[s.id] = new Airstairs(ctx, { x: s.doorL1.x, y: A320_POINTS.doorL1.y, z: s.doorL1.z }, s.heading);

    const gate2 = plan.walkways(this.stairs, this.apronWalk);

    this.signMat = atlas.material(0.08);
    if (lean) staticFans(k.b.paint, fanSpots);
    k.b.build(this.group, this.mats, this.signMat, q.shadows, lean, canMultiDraw(ctx.renderer) ? BATCH_CELL : 0);
    this.batches = k.b;
    const screenMesh = screens.build(this.boards.material, false, false);
    if (screenMesh) this.group.add(screenMesh);
    this.lights.build();
    this.group.add(this.lights.group);
    this.palms = new Palms(palms, { origin: ORIGIN, tier: q.tier, shadows: q.shadows, renderer: ctx.renderer, seed: 61 });
    this.shrubs = new Shrubs(shrubs, { origin: ORIGIN, tier: q.tier, shadows: false, seed: 62, renderer: ctx.renderer });
    if (!lean) {
      this.fans = new Fans(fanSpots, ORIGIN);
      this.group.add(this.fans.mesh);
    }
    this.group.add(this.palms.group, this.shrubs.group, airstairsGroup(ctx));

    this.spots = {
      gateDesk: { x: AIRPORT_SPOTS.island.gateDesk.x, z: AIRPORT_SPOTS.island.gateDesk.z },
      boardingPath: gate2.boarding,
      arrivalsPath: gate2.arrivals,
      seats,
    };
    // the halls under the thatch, and the exit canopy: bounced light fills them (kit.ts), reaching a
    // little past the walls so it is full strength right up to them
    setInteriorFill([
      { x0: T.x0 - FILL_PAD, z0: T.z0 - FILL_PAD, x1: T.x1 + FILL_PAD, z1: T.z1 + FILL_PAD, top: WING.eave - 0.3 },
      { x0: CANOPY.x0 - FILL_PAD, z0: Z_LAND - 3, x1: CANOPY.x1 + FILL_PAD, z1: CANOPY.z1 + FILL_PAD, top: CANOPY.eave - 0.3 },
    ]);
    this.setNight(0);
  }

  /** The departure boards and the gate screens (and, given, the arrivals board). */
  setFlights(rows: FlightRow[], arrivals?: FlightRow[]) {
    this.boards.setDepartures(rows);
    if (arrivals) this.boards.setArrivals(arrivals);
  }

  /** 0 by day .. 1 at night: lanterns, the lit offices and the signs glow; the boards brighten. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 0.002) return;
    this.night = k;
    this.mats.lit.color.setScalar(litLevel(k));
    this.signMat.emissiveIntensity = 0.08 + k * 0.6;
    this.boards.setNight(k);
    this.lights.setNight(k);
    FILL_COLOUR.lerpColors(FILL_DAY, FILL_NIGHT, k);
    setInteriorFillColor(FILL_COLOUR, THREE.MathUtils.lerp(FILL_DAY_K, FILL_NIGHT_K, k));
  }

  update(dt: number, t: number) {
    for (const id in this.stairs) this.stairs[id].update(dt);
    const cam = this.ctx.camera.position;
    if (Math.abs(cam.z - ORIGIN.z) > 6000) return;
    this.batches.update(this.ctx.camera);
    this.palms.update(this.ctx.camera);
    this.shrubs.update(this.ctx.camera);
    this.lights.update(t);
    if (this.fans && Math.hypot(cam.x - ORIGIN.x, cam.z - ORIGIN.z) < 400) this.fans.update(dt);
  }
}

// ------------------------------------------------------------------------------------------------
// Ceiling fans
// ------------------------------------------------------------------------------------------------

/** A ceiling fan's parts, hub at the origin (the downrod rises 1.4 m above it), with their colours. */
function fanParts(): [THREE.BufferGeometry, string][] {
  const out: [THREE.BufferGeometry, string][] = [
    [new THREE.CylinderGeometry(0.025, 0.025, 1.4, 6).translate(0, 0.7, 0), '#3a3328'],
    [new THREE.CylinderGeometry(0.16, 0.2, 0.22, 12), '#5b4a32'],
    [new THREE.CylinderGeometry(0.1, 0.06, 0.12, 10).translate(0, -0.16, 0), '#d8c7a6'],
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    out.push([new THREE.BoxGeometry(0.62, 0.016, 0.15).translate(0.48, -0.05, 0).rotateX(0.12).rotateY(a), '#8a5c36']);
  }
  return out;
}

/** The low tiers' fans: still, merged into the static paint so they cost no draw call of their own. */
function staticFans(b: Batch, spots: THREE.Vector3[]) {
  const parts = fanParts();
  const rnd = mulberry(91);
  for (const p of spots) {
    const m = place(p.x, p.y, p.z, rnd() * 6);
    for (const [g, colour] of parts) b.add(g, colour, m);
  }
}

/** Five-bladed timber fans on downrods under the roof beams, turning slowly (one instanced draw). */
class Fans {
  readonly mesh: THREE.InstancedMesh;
  private angle: number[] = [];
  private speed: number[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();

  constructor(
    private spots: THREE.Vector3[],
    origin: THREE.Vector3Like,
  ) {
    const parts: THREE.BufferGeometry[] = [];
    for (const [g, colour] of fanParts()) {
      const c = new THREE.Color(colour);
      const n = g.attributes.position.count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]), 3));
      g.deleteAttribute('uv');
      parts.push(g.index ? g.toNonIndexed() : g);
    }
    const geo = mergeGeometries(parts);
    this.mesh = new THREE.InstancedMesh(geo, islandMaterials().paint, spots.length);
    this.mesh.position.set(origin.x, origin.y, origin.z);
    for (const sp of spots) sp.sub(this.mesh.position);
    const rnd = mulberry(91);
    for (let i = 0; i < spots.length; i++) {
      this.angle.push(rnd() * 6);
      this.speed.push(2.2 + rnd() * 0.8);
    }
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.update(0);
    this.mesh.computeBoundingSphere();
  }

  update(dt: number) {
    for (let i = 0; i < this.spots.length; i++) {
      this.angle[i] += this.speed[i] * dt;
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.angle[i]);
      this.mesh.setMatrixAt(i, this.m.compose(this.p.copy(this.spots[i]), this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------------
// The plan
// ------------------------------------------------------------------------------------------------

const TIMBER = '#8a5c36';
const DARK_TIMBER = '#5b3a22';
const FLOOR = '#f7e6c6';

class Plan {
  constructor(
    private k: Build,
    private screens: Batch,
    private uv: FlightBoards['screens'],
    private palms: PalmSpot[],
    private shrubs: ShrubSpot[],
    private fans: THREE.Vector3[],
    private seats: (V2 & { yaw: number })[],
  ) {}

  build() {
    this.floor();
    this.structure();
    this.roofs();
    this.airside();
    this.landside();
    this.partitions();
    this.checkIn();
    this.security();
    this.lounge();
    this.arrivals();
    this.baggageHall();
    this.canopy();
    this.signs();
  }

  private get ctx() {
    return this.k.ctx;
  }

  /** A wall collider along x (z fixed) or along z (x fixed), split into ≤ 100 m pieces. */
  private wallX(x0: number, x1: number, z: number, h = 3) {
    for (let a = x0; a < x1 - 0.01; a += 100) {
      const b = Math.min(x1, a + 100);
      staticBox(this.ctx, (a + b) / 2, h / 2, z, (b - a) / 2, h / 2, 0.18);
    }
  }

  private wallZ(z0: number, z1: number, x: number, h = 3) {
    for (let a = z0; a < z1 - 0.01; a += 100) {
      const b = Math.min(z1, a + 100);
      staticBox(this.ctx, x, h / 2, (a + b) / 2, 0.18, h / 2, (b - a) / 2);
    }
  }

  private board(w: number, h: number, r: UvRect, m: THREE.Matrix4) {
    this.screens.add(signPlane(w, h, r), '#ffffff', m);
  }

  /** A wayfinding sign: a dark box with the painted face on both sides (or one), hanging from rods. */
  private sign(text: string, x: number, y: number, z: number, yaw: number, w = 4, style: SignStyle = WAY, both = true, rods = true) {
    const k = this.k;
    const h = w * 0.22;
    const r = k.atlas.sign(text, 512, 112, style);
    const m = place(x, y, z, yaw);
    k.b.paint.box(w + 0.1, h + 0.1, 0.12, '#101a30', m);
    k.b.signs.add(signPlane(w, h, r), '#ffffff', at(m, 0, 0, 0.065));
    if (both) k.b.signs.add(signPlane(w, h, r), '#ffffff', at(m, 0, 0, -0.065, Math.PI));
    if (rods) for (const sx of [-w * 0.4, w * 0.4]) k.b.metal.box(0.03, 1.4, 0.03, '#3a3328', at(m, sx, h / 2 + 0.7, 0));
  }

  // ----------------------------------------------------------------------------------------------

  /** Polished coral-stone floors with darker inlaid bands, a mosaic sun in the central hall and a threshold strip round the outside. */
  private floor() {
    const k = this.k;
    const w = T.x1 - T.x0;
    const d = Z_LAND - Z_AIR;
    k.b.stone.add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(0, 0.035, 0), FLOOR, place(0, 0, ORIGIN.z), { box: 1 / 1.2 });
    // a terrace round the building: the airside kerb and the landside pavement out to the plaza
    k.b.stone.add(new THREE.PlaneGeometry(w + 6, 3).rotateX(-Math.PI / 2).translate(0, 0.03, 0), '#ddd2b8', place(0, 0, Z_LAND + 1.5), { box: 1 / 2.4 });
    // inlaid timber-coloured bands along each hall, and the mosaic sun under the pyramid
    for (const z of [Z_AIR + 9, Z_MID + 6, Z_LAND - 6])
      for (const [x0, x1] of [
        [T.x0 + 2, X_SPLIT - 2],
        [X_SPLIT + 2, T.x1 - 2],
      ])
        k.b.stone.add(new THREE.PlaneGeometry(x1 - x0, 0.5).rotateX(-Math.PI / 2).translate(0, 0.04, 0), '#c9a87a', place((x0 + x1) / 2, 0, z), { box: 1 / 1.2 });
    const sun = place(15, 0, 40648);
    k.b.stone.add(new THREE.CircleGeometry(4, 40).rotateX(-Math.PI / 2).translate(0, 0.042, 0), '#e8a640', sun, { box: 1 / 1.2 });
    k.b.stone.add(new THREE.RingGeometry(4.6, 5.2, 48).rotateX(-Math.PI / 2).translate(0, 0.042, 0), '#2a8a95', sun, { box: 1 / 1.2 });
    for (let i = 0; i < 16; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0.5, 0.042, -4.2, 0, 0.042, -7.6, -0.5, 0.042, -4.2], 3));
      g.computeVertexNormals();
      k.b.stone.add(g, i % 2 ? '#e8a640' : '#f0c870', at(sun, 0, 0, 0, (i / 16) * Math.PI * 2), { box: 1 / 1.2 });
    }
  }

  /** Glulam columns on a grid, ring beams at the eaves, tie beams and king posts carrying the roofs. */
  private structure() {
    const k = this.k;
    const col = (x: number, z: number, h: number) => {
      k.b.timber.box(0.55, h, 0.55, TIMBER, place(x, h / 2, z), { box: 1, grain: 'y' });
      k.b.stone.box(0.8, 0.5, 0.8, '#e3d7bd', place(x, 0.25, z), { box: 1 / 1.2 });
    };
    const height = (x: number) => (Math.abs(x) < WING.inner ? HALL.eave : WING.eave);
    // facade columns every ~9.5 m along both long sides, and down the middle line
    const xs: number[] = [];
    for (let x = T.x0; x <= T.x1 + 0.01; x += 260 / 28) xs.push(Math.round(x * 100) / 100);
    for (const x of xs) {
      col(x, Z_AIR - 0.3, height(x));
      col(x, Z_LAND + 0.3, height(x));
      if (x > T.x0 + 1 && x < T.x1 - 1 && Math.abs(x - X_SPLIT) > 3 && !(x > SECURITY.x0 - 1 && x < SECURITY.x1 + 1) && !(x > X_SPLIT && x < X_OFFICE)) {
        col(x, Z_MID, height(x));
        staticCylinder(this.ctx, x, Z_MID, 0.4, 3);
      }
      // tie beams across the halls at the eaves, with king posts up towards the ridge
      const h = height(x);
      k.b.timber.box(0.4, 0.7, Z_LAND - Z_AIR + 0.6, DARK_TIMBER, place(x, h - 0.35, ORIGIN.z), { box: 1, grain: 'z' });
      // a king post up to just under the thatch, and raking struts to the rafters either side
      const top = roofY(x, ORIGIN.z) - 0.9;
      if (top > h + 1) k.b.timber.box(0.35, top - h, 0.35, DARK_TIMBER, place(x, (h + top) / 2, ORIGIN.z), { box: 1, grain: 'y' });
      for (const s of [-1, 1]) {
        const foot = new THREE.Vector3(x, h, ORIGIN.z + s * 7);
        const head = new THREE.Vector3(x, roofY(x, ORIGIN.z + s * 19) - 0.75, ORIGIN.z + s * 19);
        if (head.y - foot.y < 1.5) continue;
        const m = new THREE.Matrix4().lookAt(foot, head, THREE.Object3D.DEFAULT_UP).setPosition(foot.clone().lerp(head, 0.5));
        k.b.timber.add(new THREE.BoxGeometry(0.25, 0.25, foot.distanceTo(head)), DARK_TIMBER, m, { box: 1, grain: 'z' });
      }
    }
    for (const x of [T.x0, T.x1]) for (let z = Z_AIR + 10; z < Z_LAND - 5; z += 10) col(x, z, WING.eave);
    // ring beams round the eaves
    for (const [x0, x1, h] of [
      [T.x0, -WING.inner, WING.eave],
      [WING.inner, T.x1, WING.eave],
      [-WING.inner, WING.inner, HALL.eave],
    ] as const)
      for (const z of [Z_AIR - 0.3, Z_LAND + 0.3]) k.b.timber.box(x1 - x0 + 0.6, 0.6, 0.6, DARK_TIMBER, place((x0 + x1) / 2, h + 0.1, z), { box: 1, grain: 'x' });
    for (const x of [T.x0, T.x1]) k.b.timber.box(0.6, 0.6, Z_LAND - Z_AIR + 0.6, DARK_TIMBER, place(x, WING.eave + 0.1, ORIGIN.z), { box: 1, grain: 'z' });
    // where the wings meet the tall hall: the hall's side beams carry the clerestory screens
    for (const s of [-1, 1]) {
      k.b.timber.box(0.6, 0.6, Z_LAND - Z_AIR + 0.6, DARK_TIMBER, place(s * WING.inner, HALL.eave + 0.1, ORIGIN.z), { box: 1, grain: 'z' });
      for (let z = Z_AIR; z <= Z_LAND + 0.01; z += 70 / 6) k.b.timber.box(0.4, HALL.eave - WING.eave, 0.4, TIMBER, place(s * WING.inner, (HALL.eave + WING.eave) / 2, z), { box: 1, grain: 'y' });
      // louvred clerestory: slats between the wing's eave and the hall's
      for (let y = WING.eave + 0.4; y < HALL.eave - 0.2; y += 0.32) k.b.timber.box(0.06, 0.12, Z_LAND - Z_AIR, '#a8784c', place(s * WING.inner, y, ORIGIN.z).multiply(new THREE.Matrix4().makeRotationZ(s * 0.6)), { box: 1, grain: 'z' });
    }
    // ceiling fans: a grid under the beams in every hall (none over the office block)
    for (let i = 1; i < xs.length - 1; i++) {
      const x = (xs[i] + xs[i - 1]) / 2;
      const h = height(x) - 1.6;
      for (const z of [Z_AIR + 8, Z_AIR + 22, Z_MID + 10, Z_MID + 28]) {
        if (x > X_OFFICE && z < Z_MID) continue;
        this.fans.push(new THREE.Vector3(x, Math.min(h, 5.4), z));
      }
    }
  }

  /** The thatch: hipped wings and the pyramid over the central hall, with rafters and purlins showing underneath. */
  private roofs() {
    const k = this.k;
    const d = WING.z1 - WING.z0;
    const zc = (WING.z0 + WING.z1) / 2;
    for (const s of [-1, 1]) {
      // the hip at the inner end sits under the hall's eave; the outer end overhangs the gable wall
      const w = WING.outer - WING.inner;
      const cx = s * (WING.inner + w / 2);
      k.b.thatch.add(hipRoof(w, d, WING.rise, 0.5, 0.5), '#dcc08a', place(cx, WING.eave + 0.4, zc));
      this.underside(cx, WING.eave + 0.4, w, d, WING.rise);
    }
    const hd = HALL.half;
    k.b.thatch.add(hipRoof(hd * 2, hd * 2, HALL.rise, 0.5, 0.55), '#e2c995', place(0, HALL.eave + 0.4, ORIGIN.z));
    this.underside(0, HALL.eave + 0.4, hd * 2, hd * 2, HALL.rise);
    // the hall's finial: a carved timber spire
    k.b.timber.add(new THREE.CylinderGeometry(0.05, 0.45, 3.2, 8).translate(0, 1.6, 0), DARK_TIMBER, place(0, HALL.eave + 0.4 + HALL.rise - 0.2, ORIGIN.z), { box: 1, grain: 'y' });
    k.b.metal.add(new THREE.SphereGeometry(0.3, 10, 8), '#c9a040', place(0, HALL.eave + HALL.rise + 3.4, ORIGIN.z));
  }

  /** Rafters down the hip lines and purlins across the slopes, just under the thatch. */
  private underside(cx: number, y: number, w: number, d: number, rise: number) {
    const k = this.k;
    const hw = w / 2;
    const hd = d / 2;
    const r = Math.max(0, hw - hd);
    const v = (x: number, yy: number, z: number) => new THREE.Vector3(cx + x, y + yy, ORIGIN.z + z);
    const beam = (a: THREE.Vector3, b: THREE.Vector3, size: number) => {
      const len = a.distanceTo(b);
      const g = new THREE.BoxGeometry(size, size, len);
      const m = new THREE.Matrix4().lookAt(a, b, THREE.Object3D.DEFAULT_UP).setPosition(a.clone().lerp(b, 0.5));
      k.b.timber.add(g, DARK_TIMBER, m, { box: 1, grain: 'z' });
    };
    const drop = 0.35;
    // the four hip rafters and the ridge beam
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      beam(v(sx * hw, -drop, sz * hd), v(sx * r, rise - drop, 0), 0.4);
    if (r > 0) beam(v(-r, rise - drop, 0), v(r, rise - drop, 0), 0.45);
    // common rafters every ~4 m along the long slopes, purlins across at thirds
    for (let x = -r; x <= r + 0.01; x += Math.max(4, (2 * r) / Math.max(1, Math.round((2 * r) / 4))))
      for (const sz of [-1, 1]) beam(v(x, -drop, sz * hd), v(x, rise - drop, 0), 0.22);
    for (const t of [0.25, 0.5, 0.75]) {
      const yy = rise * t - drop - 0.2;
      const zz = hd * (1 - t);
      const xx = r + (hw - r) * (1 - t);
      for (const sz of [-1, 1]) beam(v(-xx, yy, sz * zz), v(xx, yy, sz * zz), 0.2);
      for (const sx of [-1, 1]) beam(v(sx * xx, yy, -zz), v(sx * xx, yy, zz), 0.2);
    }
  }

  /** The glass wall onto the apron: hardwood mullions and transoms, the gate doors (open sliders), the office block's windows. */
  private airside() {
    const k = this.k;
    const z = Z_AIR;
    const gaps = [...GATE_DOORS.map((g) => ({ x0: g.x - DOOR_HALF, x1: g.x + DOOR_HALF })), ARRIVALS_DOOR];
    const height = (x: number) => (Math.abs(x) < WING.inner ? HALL.eave : WING.eave);
    // glazing between the columns (the office block gets solid spandrels and smaller windows)
    const bays = 260 / 28;
    for (let x = T.x0; x < T.x1 - 0.01; x += bays) {
      const x0 = x + 0.3;
      const x1 = x + bays - 0.3;
      const h = height(x + bays / 2);
      const office = x0 >= X_OFFICE - 0.5;
      const gap = gaps.find((g) => g.x0 < x1 && g.x1 > x0);
      const panes = gap ? [[x0, gap.x0 - 0.1], [gap.x1 + 0.1, x1]] : [[x0, x1]];
      for (const [a, b] of panes) {
        if (b - a < 0.2) continue;
        if (office) {
          k.b.timber.box(b - a, 1.1, 0.25, '#a8784c', place((a + b) / 2, 0.55, z), { box: 1, grain: 'x' });
          k.b.timber.box(b - a, h - 3.4, 0.25, '#a8784c', place((a + b) / 2, (h + 3.4) / 2, z), { box: 1, grain: 'x' });
          k.b.glass.box(b - a, 2.3, 0.04, '#ffffff', place((a + b) / 2, 2.25, z));
          // the lit office behind its blinds
          k.b.lit.box(b - a, 2.3, 0.04, '#ffe4b8', place((a + b) / 2, 2.25, z + 3));
          for (let y = 1.25; y < 3.35; y += 0.16) k.b.timber.box(b - a, 0.07, 0.02, '#d8bf86', place((a + b) / 2, y, z + 0.25));
          continue;
        }
        k.b.glass.box(b - a, h - 0.1, 0.04, '#ffffff', place((a + b) / 2, h / 2, z));
        for (const y of [2.8, 5.2]) if (y < h - 0.5) k.b.timber.box(b - a, 0.14, 0.18, TIMBER, place((a + b) / 2, y, z), { box: 1, grain: 'x' });
        for (let xm = a + (b - a) / Math.max(1, Math.round((b - a) / 2.4)); xm < b - 0.3; xm += (b - a) / Math.max(1, Math.round((b - a) / 2.4)))
          k.b.timber.box(0.1, h, 0.16, TIMBER, place(xm, h / 2, z), { box: 1, grain: 'y' });
        k.b.timber.box(b - a, 0.18, 0.3, DARK_TIMBER, place((a + b) / 2, 0.09, z), { box: 1, grain: 'x' });
      }
    }
    // the doors: frames, two glass sliders drawn back, a mat, and a canopy over each
    for (const g of gaps) {
      const cx = (g.x0 + g.x1) / 2;
      const w = g.x1 - g.x0;
      k.b.metal.box(w + 0.4, 0.3, 0.3, '#3a3328', place(cx, 2.7, z));
      for (const s of [-1, 1]) {
        k.b.metal.box(0.15, 2.7, 0.3, '#3a3328', place(cx + (s * (w + 0.15)) / 2, 1.35, z));
        k.b.glass.box(w / 2, 2.5, 0.03, '#ffffff', place(cx + s * (w / 2 + w / 4 - 0.05), 1.3, z + 0.18));
      }
      k.b.ground.add(new THREE.PlaneGeometry(w, 2.4).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#3a3a36', place(cx, 0, z + 1.4), { box: 0.5 });
      k.b.thatch.add(hipRoof(w + 3, 3.2, 0.9, 0.5, 0.25), '#d4b47a', place(cx, 3.35, z - 1.4));
      for (const s of [-1, 1]) k.b.timber.box(0.14, 3.35, 0.14, TIMBER, place(cx + s * (w / 2 + 1.2), 1.675, z - 2.7), { box: 1, grain: 'y' });
    }
    // colliders along the glass, with the doors left open
    const xs = [T.x0, ...gaps.flatMap((g) => [g.x0, g.x1]), T.x1].sort((a, b) => a - b);
    for (let i = 0; i < xs.length; i += 2) this.wallX(xs[i], xs[i + 1], z);
  }

  /** The landside: hardwood louvre screens between the columns, the entrance and the exit open to the plaza, the gable ends. */
  private landside() {
    const k = this.k;
    const z = Z_LAND;
    const louvres = (x0: number, x1: number, h: number, zz: number) => {
      for (let y = 0.6; y < h - 0.2; y += 0.26) k.b.timber.box(x1 - x0, 0.14, 0.05, '#a8784c', place((x0 + x1) / 2, y, zz).multiply(new THREE.Matrix4().makeRotationX(-0.55)), { box: 1, grain: 'x' });
      k.b.timber.box(x1 - x0, 0.5, 0.3, DARK_TIMBER, place((x0 + x1) / 2, 0.25, zz), { box: 1, grain: 'x' });
    };
    const openings = [ENTRANCE, EXIT];
    const xs = [T.x0, ...openings.flatMap((o) => [o.x0, o.x1]), T.x1];
    for (let i = 0; i < xs.length; i += 2) {
      // louvres up to the transom, open fretwork above it for the breeze
      const a = xs[i];
      const b = xs[i + 1];
      const cuts = [a, ...[-WING.inner, WING.inner].filter((c) => c > a && c < b), b];
      for (let j = 1; j < cuts.length; j++) {
        const mid = (cuts[j - 1] + cuts[j]) / 2;
        louvres(cuts[j - 1], cuts[j], Math.abs(mid) < WING.inner ? 5 : 4.6, z);
      }
      this.wallX(a, b, z);
    }
    for (const o of openings) {
      // a timber portal with the threshold and a coir mat
      const cx = (o.x0 + o.x1) / 2;
      const w = o.x1 - o.x0;
      k.b.timber.box(w, 0.6, 0.6, DARK_TIMBER, place(cx, 4.4, z), { box: 1, grain: 'x' });
      k.b.ground.add(new THREE.PlaneGeometry(w - 2, 3).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#8a6a40', place(cx, 0, z - 1.8), { box: 0.5 });
    }
    // the gable ends: louvres the full depth
    for (const x of [T.x0, T.x1]) {
      for (let y = 0.6; y < WING.eave - 0.3; y += 0.26) k.b.timber.box(0.05, 0.14, Z_LAND - Z_AIR, '#a8784c', place(x, y, ORIGIN.z).multiply(new THREE.Matrix4().makeRotationZ(x < 0 ? 0.55 : -0.55)), { box: 1, grain: 'z' });
      k.b.timber.box(0.3, 0.5, Z_LAND - Z_AIR, DARK_TIMBER, place(x, 0.25, ORIGIN.z), { box: 1, grain: 'z' });
      this.wallZ(Z_AIR, Z_LAND, x);
    }
  }

  /** Inside walls: the departures/arrivals partition, the glass line between check-in and the lounge, the office block. */
  private partitions() {
    const k = this.k;
    // the partition: hardwood boarding, 5 m high, with a painted mural band on the arrivals side
    k.b.timber.box(0.35, 5, Z_LAND - Z_AIR, '#9a6a42', place(X_SPLIT, 2.5, ORIGIN.z), { box: 1, grain: 'y' });
    k.b.timber.box(0.5, 0.25, Z_LAND - Z_AIR, DARK_TIMBER, place(X_SPLIT, 5.1, ORIGIN.z), { box: 1, grain: 'z' });
    this.wallZ(Z_AIR, Z_LAND, X_SPLIT);
    const mural = k.atlas.paint(1024, 176, (g, w, h) => paintMural(g, w, h), 0.5);
    k.b.signs.add(signPlane(27, 4.66, mural), '#ffffff', place(X_SPLIT + 0.19, 2.6, Z_AIR + 15, Math.PI / 2));
    // check-in | lounge: glass on a timber base, open at security
    for (const [a, b] of [
      [T.x0, SECURITY.x0],
      [SECURITY.x1, X_SPLIT],
    ]) {
      k.b.timber.box(b - a, 0.9, 0.3, '#a8784c', place((a + b) / 2, 0.45, Z_MID), { box: 1, grain: 'x' });
      k.b.glass.box(b - a, 3.4, 0.04, '#ffffff', place((a + b) / 2, 2.6, Z_MID));
      k.b.timber.box(b - a, 0.16, 0.2, TIMBER, place((a + b) / 2, 4.3, Z_MID), { box: 1, grain: 'x' });
      for (let x = a + 2.4; x < b - 0.5; x += 2.4) k.b.timber.box(0.1, 3.4, 0.14, TIMBER, place(x, 2.6, Z_MID), { box: 1, grain: 'y' });
      this.wallX(a, b, Z_MID);
    }
    // the office block's walls (closed), and the baggage hall's north wall behind the carousel feed
    k.b.timber.box(T.x1 - X_OFFICE, 5, 0.35, '#9a6a42', place((X_OFFICE + T.x1) / 2, 2.5, Z_MID), { box: 1, grain: 'y' });
    this.wallX(X_OFFICE, T.x1, Z_MID);
    k.b.timber.box(0.35, 5, Z_MID - Z_AIR, '#9a6a42', place(X_OFFICE, 2.5, (Z_AIR + Z_MID) / 2), { box: 1, grain: 'y' });
    this.wallZ(Z_AIR, Z_MID, X_OFFICE);
    // a flat ceiling over the offices (they're closed rooms) and its lit windows into the lobby
    k.b.timber.box(T.x1 - X_OFFICE, 0.25, Z_MID - Z_AIR, '#c9a87a', place((X_OFFICE + T.x1) / 2, 5.1, (Z_AIR + Z_MID) / 2), { box: 1, grain: 'x' });
    for (const z of [Z_AIR + 8, Z_AIR + 20]) {
      k.b.glass.box(0.04, 1.6, 6, '#ffffff', place(X_OFFICE - 0.2, 2.2, z));
      k.b.lit.box(0.04, 1.6, 6, '#ffe4b8', place(X_OFFICE + 0.4, 2.2, z));
    }
  }

  /** The check-in island: eight desks with scales and screens, the bag belt behind, branded back panels and queue lines. */
  private checkIn() {
    const k = this.k;
    const z = 40645;
    const x0 = -116;
    const n = 8;
    const pitch = 5;
    const airlines = ['Funfair Air', 'Funfair Air', 'Funfair Air', 'Palm Cay Air', 'Palm Cay Air', 'Candy Air', 'Sunset Airways', 'Lagoon Air'];
    const colours = ['#e8463c', '#e8463c', '#e8463c', '#1d8a99', '#1d8a99', '#ff6fa8', '#f08a1c', '#2a7fff'];
    // the back panel and the conveyor behind the desks
    k.b.timber.box(n * pitch + 2, 3.2, 0.3, '#a8784c', place(x0 + (n * pitch) / 2, 1.6, z - 3.2), { box: 1, grain: 'y' });
    k.b.metal.box(n * pitch + 2, 0.5, 1.1, '#9aa3aa', place(x0 + (n * pitch) / 2, 0.45, z - 1.9));
    k.b.paint.box(n * pitch + 2, 0.04, 0.9, '#1e1e1e', place(x0 + (n * pitch) / 2, 0.72, z - 1.9));
    staticBox(this.ctx, x0 + (n * pitch) / 2, 1, z - 2.2, (n * pitch) / 2 + 1, 1, 1.4);
    for (let i = 0; i < n; i++) {
      const x = x0 + pitch / 2 + i * pitch;
      // the desk: a white solid-surface counter with a timber front, a bag scale beside it
      k.b.paint.box(2.6, 1.05, 0.8, '#f4f1ea', place(x - 0.6, 0.525, z));
      k.b.timber.box(2.62, 0.9, 0.04, '#7a4f2c', place(x - 0.6, 0.5, z + 0.42), { box: 1, grain: 'y' });
      k.b.paint.box(2.7, 0.05, 0.9, '#e6e1d6', place(x - 0.6, 1.07, z));
      k.b.metal.box(0.9, 0.25, 1.1, '#5b6168', place(x + 1.25, 0.125, z - 0.1));
      k.b.paint.box(0.3, 0.2, 0.05, '#2b3c48', place(x + 1.25, 1.05, z + 0.45));
      // the agent's screen, and the airline's lit sign on a post above
      k.b.paint.box(0.5, 0.32, 0.04, '#1e1e1e', place(x - 0.6, 1.3, z - 0.1).multiply(new THREE.Matrix4().makeRotationX(-0.2)));
      const r = k.atlas.sign(airlines[i], 384, 96, { bg: colours[i], fg: '#ffffff', font: 'display', square: true, sub: `CHECK-IN ${i + 1}` });
      k.b.metal.box(0.08, 2.1, 0.08, '#3a3328', place(x - 0.6, 2.25, z - 3.0));
      k.b.paint.box(2.1, 0.6, 0.1, '#101a30', place(x - 0.6, 3.1, z - 3.0));
      k.b.signs.add(signPlane(2.0, 0.5, r), '#ffffff', place(x - 0.6, 3.1, z - 2.94));
      // queue posts with retractable belts
      for (const dz of [2.2, 4.4]) for (const dx of [-1.8, 0.6]) k.b.metal.add(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 8).translate(0, 0.475, 0), '#c8ccd0', place(x + dx, 0, z + dz), { box: 1 });
      for (const dz of [2.2, 4.4]) k.b.fabric.box(2.4, 0.06, 0.01, colours[i], place(x - 0.6, 0.9, z + dz));
      staticBox(this.ctx, x - 0.6, 0.5, z, 1.3, 0.5, 0.4);
    }
    this.sign('Check-in  ·  Enregistrement', x0 + (n * pitch) / 2, 5.6, z + 1, 0, 9);
    // the information desk, a round counter in the middle of the hall
    const ix = -26;
    const iz = 40652;
    k.b.paint.add(new THREE.CylinderGeometry(1.8, 1.8, 1.05, 24, 1, true).translate(0, 0.525, 0), '#f4f1ea', place(ix, 0, iz), { box: 1 });
    k.b.timber.add(new THREE.RingGeometry(1.4, 1.95, 24).rotateX(-Math.PI / 2).translate(0, 1.08, 0), '#7a4f2c', place(ix, 0, iz), { box: 1 });
    this.sign('i  Information', ix, 3.2, iz, 0, 3.2, { bg: '#1d8a99', fg: '#ffffff', font: 'body', square: true });
    staticCylinder(this.ctx, ix, iz, 1.95, 1.1);
    // a shop in the south-west corner of the hall
    this.shopFront(-128, -110, 40664, 'Shell & Sail', 'BEACHWEAR · BOOKS · SNACKS', '#2ec4b6');
  }

  /** A shop open to the hall: shelving, a counter, a lit back wall and its board. */
  private shopFront(x0: number, x1: number, zBack: number, name: string, sub: string, colour: string) {
    const k = this.k;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    const front = zBack - 5.5;
    const s = Math.sign(ORIGIN.z - zBack) || 1;
    k.b.lit.box(w, 2.4, 0.05, '#ffe9c8', place(cx, 1.8, zBack - s * 0.4));
    for (let i = 0; i < 4; i++) {
      const x = x0 + 2 + i * ((w - 4) / 3);
      k.b.timber.box(0.6, 1.8, 2.6, '#a8784c', place(x, 0.9, zBack - s * 3.2), { box: 1, grain: 'y' });
      for (const y of [0.5, 1.0, 1.5]) for (const dz of [-0.9, 0, 0.9]) k.b.paint.box(0.5, 0.3, 0.6, ['#ff8a3d', '#2ec4b6', '#ffd23f', '#ff4d6d', '#3a86ff'][(i + Math.round(y * 2) + Math.round(dz)) % 5], place(x, y + 0.15, zBack - s * 3.2 + dz));
      staticBox(this.ctx, x, 0.9, zBack - s * 3.2, 0.3, 0.9, 1.3);
    }
    k.b.paint.box(3.2, 1.0, 0.7, '#f4f1ea', place(x1 - 2.2, 0.5, front + s * 0.5));
    staticBox(this.ctx, x1 - 2.2, 0.5, front + s * 0.5, 1.6, 0.5, 0.35);
    const r = k.atlas.sign(name, 512, 128, { bg: colour, fg: '#ffffff', border: '#fff5e3', font: 'display', sub });
    k.b.timber.box(w, 0.9, 0.12, DARK_TIMBER, place(cx, 3.6, front));
    k.b.signs.add(signPlane(Math.min(w - 1, 4.8), 1.2, r), '#ffffff', place(cx, 3.6, front - s * 0.07, s > 0 ? 0 : Math.PI));
  }

  /** Two security lanes: X-ray tunnels with roller tables, walk-through arches, trays and the officers' desks. */
  private security() {
    const k = this.k;
    const z = Z_MID;
    for (const x of [-54, -46]) {
      // the arch, standing in the line of the glass
      for (const s of [-1, 1]) k.b.paint.box(0.14, 2.3, 0.6, '#d8dde0', place(x + s * 0.5, 1.15, z));
      k.b.paint.box(1.14, 0.3, 0.6, '#d8dde0', place(x, 2.45, z));
      k.b.paint.box(0.08, 0.12, 0.08, '#2ee05a', place(x - 0.5, 2.62, z));
      // the X-ray machine and its roller tables, landside of the line beside the arch
      const mx = x - 2.2;
      k.b.paint.box(1.3, 1.6, 2.2, '#5b6168', place(mx, 0.8, z + 2.0));
      k.b.paint.box(0.9, 0.55, 2.24, '#1e1e1e', place(mx, 0.95, z + 2.0));
      k.b.metal.box(0.9, 0.08, 4.5, '#c8ccd0', place(mx, 0.82, z + 5.3));
      k.b.metal.box(0.9, 0.08, 2.5, '#c8ccd0', place(mx, 0.82, z - 1.5));
      for (let i = 0; i < 4; i++) k.b.paint.box(0.55, 0.08, 0.4, '#4a4f55', place(mx, 0.9, z + 4 + i * 0.6));
      k.b.paint.box(0.6, 0.45, 0.05, '#1e1e1e', place(mx - 0.9, 1.5, z + 0.8, -0.6));
      staticBox(this.ctx, mx, 0.8, z + 2.5, 0.65, 0.8, 4.4);
      for (const s of [-1, 1]) staticBox(this.ctx, x + s * 0.55, 1.1, z, 0.08, 1.1, 0.3);
    }
    // lane barriers between the lanes and the glass either side
    for (const x of [SECURITY.x0, -50, SECURITY.x1]) {
      for (let dz = 1; dz <= 9; dz += 2) k.b.metal.add(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 8).translate(0, 0.475, 0), '#c8ccd0', place(x, 0, z + dz), { box: 1 });
      k.b.fabric.box(0.01, 0.06, 8, '#14213d', place(x, 0.9, z + 5));
    }
    this.sign('Security  ·  Gates 1 – 4', -50, 5.2, z + 0.6, 0, 6);
  }

  /** The gate lounge: beam seating facing the apron, gate desks with screens, the café and the duty-free. */
  private lounge() {
    const k = this.k;
    // seating blocks: rows back to back, every seat facing the windows (north) or away
    const blocks: [number, number][] = [
      [-109, -97],
      [-83, -61],
      [-23, -9],
    ];
    for (const [x0, x1] of blocks) for (const z of [40616, 40622.5]) this.seatRow(x0, x1, z);
    // gate desks with their screens and the big gate numbers over the doors
    const gateNumber = (gate: string, x: number) => {
      const r = k.atlas.sign(gate, 256, 256, { bg: YELLOW, fg: NAVY, font: 'body', square: true });
      k.b.paint.box(1.7, 1.7, 0.12, '#101a30', place(x, 4.2, Z_AIR + 0.4));
      k.b.signs.add(signPlane(1.6, 1.6, r), '#ffffff', place(x, 4.2, Z_AIR + 0.47));
      k.b.signs.add(signPlane(1.6, 1.6, r), '#ffffff', place(x, 4.0, Z_AIR - 0.12, Math.PI));
      // hung from the roof on two rods, so it reads as a sign over the door rather than a block in the air
      const top = Math.abs(x) < WING.inner ? HALL.eave : WING.eave;
      for (const sx of [-0.6, 0.6]) k.b.metal.box(0.03, top - 5.05, 0.03, '#3a3328', place(x + sx, (top + 5.05) / 2, Z_AIR + 0.4));
    };
    for (const g of GATE_DOORS) {
      gateNumber(g.gate, g.x);
      if (g.gate.length > 1) continue;
      const n = Number(g.gate);
      const desk = { x: g.x, z: AIRPORT_SPOTS.island.gateDesk.z - 1.4 };
      k.b.paint.box(2.4, 1.05, 0.7, '#f4f1ea', place(desk.x, 0.525, desk.z));
      k.b.timber.box(2.42, 0.85, 0.04, '#7a4f2c', place(desk.x, 0.5, desk.z + 0.37), { box: 1, grain: 'y' });
      k.b.paint.box(2.5, 0.05, 0.8, '#e6e1d6', place(desk.x, 1.07, desk.z));
      k.b.paint.box(0.5, 0.32, 0.04, '#1e1e1e', place(desk.x - 0.5, 1.3, desk.z - 0.15).multiply(new THREE.Matrix4().makeRotationX(-0.2)));
      staticBox(this.ctx, desk.x, 0.5, desk.z, 1.2, 0.5, 0.35);
      // the gate screen on a post behind the desk, facing the lounge
      k.b.metal.box(0.1, 2.6, 0.1, '#3a3328', place(desk.x + 1.6, 1.3, desk.z - 0.6));
      const aspect = FlightBoards.gateAspect;
      k.b.paint.box(1.9, 1.9 / aspect + 0.1, 0.1, '#101a30', place(desk.x + 1.6, 2.9, desk.z - 0.6));
      this.board(1.8, 1.8 / aspect, this.uv.gate[n], place(desk.x + 1.6, 2.9, desk.z - 0.54));
      // stanchions marking the boarding lane from the desk to the door
      for (const s of [-1, 1]) for (let zz = Z_AIR + 1.5; zz < desk.z - 0.6; zz += 1.6) k.b.metal.add(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 8).translate(0, 0.475, 0), '#c8ccd0', place(g.x + s * 1.5, 0, zz), { box: 1 });
    }
    // the gate 3·4 screen beside its door
    const aspect = FlightBoards.gateAspect;
    for (const [n, dx] of [
      [3, -2.4],
      [4, 2.4],
    ] as const) {
      k.b.paint.box(1.9, 1.9 / aspect + 0.1, 0.1, '#101a30', place(-14 + dx, 2.9, Z_AIR + 0.5));
      this.board(1.8, 1.8 / aspect, this.uv.gate[n], place(-14 + dx, 2.9, Z_AIR + 0.56));
    }
    // a departures board for the lounge, hanging over the aisle, both sides
    const bw = 5.2;
    const bh = bw / FlightBoards.boardAspect;
    k.b.paint.box(bw + 0.2, bh + 0.2, 0.2, '#101a30', place(-50, 4.5, 40618));
    this.board(bw, bh, this.uv.departures, place(-50, 4.5, 40618.11));
    this.board(bw, bh, this.uv.departures, place(-50, 4.5, 40617.89, Math.PI));
    for (const sx of [-bw * 0.4, bw * 0.4]) k.b.metal.box(0.04, 1.6, 0.04, '#3a3328', place(-50 + sx, 4.5 + bh / 2 + 0.8, 40618));
    // the café: a bar against the glass with stools, and a few tables
    this.cafe(-79, -67, Z_MID - 1.2, 'Frangipani Café', '#e8732a', Math.PI);
    for (const [x, z] of [
      [-74, 40609],
      [-68, 40610],
      [-62, 40608],
    ])
      this.table(x, z);
    // the duty-free at the lounge's west end: shelf islands and a till
    this.dutyFree(T.x0 + 1, -115);
    // planters with young palms along the windows
    for (const x of [-100, -76, -58, -42, -20]) this.planter(x, Z_AIR + 4.5);
    this.sign('Gates 1 – 2  ←', -40, 5.0, 40626, Math.PI, 4.2);
    this.sign('Toilets  ·  Duty free  →', -95, 5.0, 40626, Math.PI, 5);
  }

  private seatRow(x0: number, x1: number, z: number) {
    const k = this.k;
    const pitch = 0.62;
    const n = Math.floor((x1 - x0) / pitch);
    k.b.metal.box(x1 - x0, 0.08, 0.08, '#5b6168', place((x0 + x1) / 2, 0.3, z));
    for (let i = 0; i < n; i += 4) for (const s of [-1, 1]) k.b.metal.box(0.06, 0.32, 0.9, '#5b6168', place(x0 + i * pitch + 0.1, 0.16, z + s * 0.2));
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * pitch;
      for (const s of [-1, 1]) {
        // a seat facing −z (s = −1, towards the apron) or +z
        k.b.paint.box(0.52, 0.06, 0.46, '#1d8a99', place(x, 0.45, z + s * 0.28));
        k.b.paint.add(new THREE.BoxGeometry(0.52, 0.5, 0.05), '#1d8a99', place(x, 0.74, z - s * 0.04).multiply(new THREE.Matrix4().makeRotationX(s * 0.18)));
        if (i % 4 === 3) k.b.metal.box(0.05, 0.05, 0.4, '#5b6168', place(x + pitch / 2, 0.66, z + s * 0.28));
        this.seats.push({ x, z: z + s * 0.62, yaw: s < 0 ? 0 : Math.PI });
      }
    }
    staticBox(this.ctx, (x0 + x1) / 2, 0.45, z, (x1 - x0) / 2, 0.45, 0.55);
  }

  private table(x: number, z: number) {
    const k = this.k;
    k.b.timber.add(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 16), '#7a4f2c', place(x, 0.74, z), { box: 1 });
    k.b.metal.add(new THREE.CylinderGeometry(0.04, 0.2, 0.72, 8).translate(0, 0.36, 0), '#3a3328', place(x, 0, z));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      const cx = x + Math.cos(a) * 0.8;
      const cz = z + Math.sin(a) * 0.8;
      k.b.timber.add(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), '#c9a66b', place(cx, 0.46, cz), { box: 1 });
      k.b.metal.add(new THREE.CylinderGeometry(0.02, 0.02, 0.45, 5).translate(0, 0.225, 0), '#3a3328', place(cx, 0, cz));
    }
    staticCylinder(this.ctx, x, z, 0.5, 0.8);
  }

  /** A café counter (yaw: the way its customers face), with stools, a lit back wall and its board. */
  private cafe(x0: number, x1: number, z: number, name: string, colour: string, yaw: number) {
    const k = this.k;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    const m = place(cx, 0, z, yaw);
    k.b.timber.box(w, 1.1, 0.7, '#c9a66b', at(m, 0, 0.55, -1.2), { box: 1, grain: 'y' });
    k.b.timber.box(w + 0.2, 0.06, 0.9, '#7a4f2c', at(m, 0, 1.13, -1.2), { box: 1, grain: 'x' });
    k.b.lit.box(w, 1.4, 0.04, '#ffd9a6', at(m, 0, 1.9, 0.6));
    k.b.metal.box(1.0, 0.6, 0.6, '#c8ccd0', at(m, -w / 3, 1.45, -1.2));
    for (let i = 0; i < Math.floor(w / 1.2); i++) {
      const lx = -w / 2 + 0.7 + i * 1.2;
      k.b.metal.add(new THREE.CylinderGeometry(0.025, 0.025, 0.75, 6).translate(0, 0.375, 0), '#3a3328', at(m, lx, 0, -2.0));
      k.b.timber.add(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 10), '#7a4f2c', at(m, lx, 0.78, -2.0), { box: 2 });
    }
    const r = k.atlas.sign(name, 512, 128, { bg: colour, fg: '#fff5e3', border: '#fff5e3', font: 'display', sub: 'COFFEE · JUICES · PASTRIES' });
    k.b.signs.add(signPlane(4.2, 1.05, r), '#ffffff', at(m, 0, 3.3, -1.6));
    k.b.timber.box(4.4, 1.2, 0.08, DARK_TIMBER, at(m, 0, 3.3, -1.55));
    const c = new THREE.Vector3(0, 0, -1.2).applyMatrix4(m);
    staticBox(this.ctx, c.x, 0.55, c.z, Math.abs(Math.cos(yaw)) * w * 0.5 + 0.4, 0.55, Math.abs(Math.sin(yaw)) * w * 0.5 + 0.4);
  }

  private dutyFree(x0: number, x1: number) {
    const k = this.k;
    const r = k.atlas.sign('Island Duty Free', 512, 128, { bg: '#7b5cd6', fg: '#ffffff', border: '#ffd23f', font: 'display', sub: 'FRAGRANCE · RUM · CHOCOLATE' });
    k.b.signs.add(signPlane(5, 1.25, r), '#ffffff', place(x1 + 0.2, 4.2, (Z_AIR + Z_MID) / 2, -Math.PI / 2));
    k.b.lit.box(0.05, 2.6, Z_MID - Z_AIR - 4, '#ffeedd', place(x0 + 0.3, 1.9, (Z_AIR + Z_MID) / 2));
    for (let i = 0; i < 3; i++) {
      const z = Z_AIR + 6 + i * 8;
      k.b.paint.box(1.0, 1.5, 4.5, '#f4f1ea', place((x0 + x1) / 2, 0.75, z));
      for (const y of [0.6, 1.0, 1.4]) for (let j = 0; j < 6; j++) k.b.paint.box(0.18, 0.28, 0.18, ['#c03030', '#d8a640', '#3a6b3a', '#7b5cd6', '#e8e8e8'][(i + j) % 5], place((x0 + x1) / 2 + (j % 2 ? 0.25 : -0.25), y + 0.14, z - 1.8 + j * 0.7));
      staticBox(this.ctx, (x0 + x1) / 2, 0.75, z, 0.5, 0.75, 2.25);
    }
    k.b.paint.box(2.5, 1.0, 0.7, '#14213d', place(x1 - 2, 0.5, Z_MID - 3));
    staticBox(this.ctx, x1 - 2, 0.5, Z_MID - 3, 1.25, 0.5, 0.35);
  }

  /** A big round planter with a young palm and flowers. */
  private planter(x: number, z: number, r = 1.3) {
    const k = this.k;
    k.b.stone.add(new THREE.CylinderGeometry(r, r * 0.92, 0.6, 24).translate(0, 0.3, 0), '#e3d7bd', place(x, 0, z), { box: 1 / 1.2 });
    k.b.ground.add(new THREE.CircleGeometry(r - 0.1, 20).rotateX(-Math.PI / 2), '#5a3e28', place(x, 0.58, z), { box: 0.5 });
    this.palms.push({ x, z, y: 0.55, kind: 'young', s: 0.75 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      this.shrubs.push({ x: x + Math.cos(a) * r * 0.6, z: z + Math.sin(a) * r * 0.6, y: 0.5, kind: i % 2 ? 'croton' : 'allamanda', s: 0.45 });
    }
    staticCylinder(this.ctx, x, z, r, 0.6);
  }

  /** The arrivals lobby: the welcome wall, passport booths across the way into the baggage hall. */
  private arrivals() {
    const k = this.k;
    const r = k.atlas.paint(768, 192, (g, w, h) => paintWelcome(g, w, h), 0.6);
    k.b.signs.add(signPlane(14, 3.5, r), '#ffffff', place((X_SPLIT + X_OFFICE) / 2, 3.6, Z_MID - 0.25, Math.PI));
    // three booths with lanes between them
    for (const x of [8, 19, 30]) {
      const m = place(x, 0, Z_MID);
      k.b.timber.box(2.4, 1.15, 2.0, '#a8784c', at(m, 0, 0.575, 0), { box: 1, grain: 'y' });
      k.b.glass.box(2.4, 1.0, 0.04, '#ffffff', at(m, 0, 1.65, -1.0));
      for (const s of [-1, 1]) k.b.timber.box(0.1, 2.3, 2.0, DARK_TIMBER, at(m, s * 1.2, 1.15, 0), { box: 1, grain: 'y' });
      k.b.thatch.add(hipRoof(3.0, 2.6, 0.7, 0.5, 0.15), '#d4b47a', at(m, 0, 2.35, 0));
      k.b.paint.box(0.12, 0.12, 0.05, '#2ee05a', at(m, 1.0, 2.15, -1.03));
      staticBox(this.ctx, x, 0.6, Z_MID, 1.25, 0.6, 1.0);
      // lane barriers in the queue area
      for (const s of [-1, 1]) for (let dz = 2; dz <= 8; dz += 2) k.b.metal.add(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 8).translate(0, 0.475, 0), '#c8ccd0', place(x + s * 1.2, 0, Z_MID - dz), { box: 1 });
    }
    this.sign('Passport control', 19, 4.6, Z_MID - 3, Math.PI, 5);
    this.sign('Arrivals  ·  Welcome', 6, 4.2, Z_AIR + 2.5, Math.PI, 5);
    for (const x of [0, 36]) this.planter(x, Z_AIR + 12, 1.5);
  }

  /** The baggage hall: the carousel with bags on it and its screen, tour desks, the café, the customs exit. */
  private baggageHall() {
    const k = this.k;
    const cx = 62;
    const cz = 40650;
    const len = 22;
    const r = 3.4;
    // the carousel: a stainless racetrack with a rubber slat band, fed through the north wall
    const shape = (rr: number) => {
      const s = new THREE.Shape();
      s.absarc(len / 2, 0, rr, -Math.PI / 2, Math.PI / 2, false);
      s.absarc(-len / 2, 0, rr, Math.PI / 2, (3 * Math.PI) / 2, false);
      return s;
    };
    const ring = (outer: number, inner: number) => {
      const s = shape(outer);
      s.holes.push(new THREE.Path(shape(inner).getPoints(24).reverse()));
      return new THREE.ShapeGeometry(s, 24).rotateX(-Math.PI / 2);
    };
    const body = new THREE.ExtrudeGeometry(shape(r + 0.6), { depth: 0.45, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2);
    k.b.metal.add(body, '#c8ccd0', place(cx, 0, cz));
    k.b.paint.add(ring(r + 0.55, r - 0.55), '#26282b', place(cx, 0.47, cz));
    k.b.metal.add(new THREE.ShapeGeometry(shape(r - 0.55), 24).rotateX(-Math.PI / 2), '#9aa3aa', place(cx, 0.6, cz));
    k.b.metal.box(1.6, 1.2, 8, '#9aa3aa', place(cx + 4, 0.6, cz - 6));
    k.b.fabric.box(1.4, 1.0, 0.05, '#1e1e1e', place(cx + 4, 0.75, Z_MID + 0.3));
    staticBox(this.ctx, cx, 0.4, cz, len / 2 + r + 0.6, 0.4, r + 0.6);
    staticBox(this.ctx, cx + 4, 0.6, cz - 6, 0.8, 0.6, 4);
    // bags riding round
    const rnd = this.k.rnd;
    for (let i = 0; i < 14; i++) {
      const t = i / 14;
      const perim = 2 * len + 2 * Math.PI * r;
      let d = t * perim;
      let x = 0;
      let z = 0;
      let yaw = 0;
      if (d < len) [x, z, yaw] = [-len / 2 + d, r, 0];
      else if ((d -= len) < Math.PI * r) [x, z, yaw] = [len / 2 + Math.sin(d / r) * r, Math.cos(d / r) * r, -d / r];
      else if ((d -= Math.PI * r) < len) [x, z, yaw] = [len / 2 - d, -r, Math.PI];
      else {
        d -= len;
        [x, z, yaw] = [-len / 2 - Math.sin(d / r) * r, -Math.cos(d / r) * r, Math.PI - d / r];
      }
      if (rnd() < 0.3) continue;
      const big = rnd() > 0.5;
      k.b.paint.box(big ? 0.75 : 0.55, big ? 0.3 : 0.24, big ? 0.5 : 0.38, ['#2a4a7a', '#c03030', '#1e1e1e', '#3a6b3a', '#ff8a3d', '#7b5cd6'][Math.floor(rnd() * 6)], place(cx + x, 0.62, cz + z, yaw + rnd() * 0.4));
    }
    // the belt's screen and the arrivals board on the partition
    k.b.metal.box(0.1, 2.8, 0.1, '#3a3328', place(cx - len / 2 - 5, 1.4, cz));
    const aspect = FlightBoards.gateAspect;
    const rb = k.atlas.sign('Belt 1  ·  FA101 Funfair', 512, 128, { bg: NAVY, fg: YELLOW, font: 'body', square: true, sub: 'BAGGAGE IN HALL' });
    k.b.paint.box(2.3, 2.3 / aspect, 0.12, '#101a30', place(cx - len / 2 - 5, 3.2, cz));
    k.b.signs.add(signPlane(2.2, 0.55, rb), '#ffffff', place(cx - len / 2 - 5, 3.2, cz + 0.07));
    k.b.signs.add(signPlane(2.2, 0.55, rb), '#ffffff', place(cx - len / 2 - 5, 3.2, cz - 0.07, Math.PI));
    const bw = 6;
    const bh = bw / FlightBoards.boardAspect;
    k.b.paint.box(0.2, bh + 0.2, bw + 0.2, '#101a30', place(X_SPLIT + 0.3, 3.6, 40652));
    this.board(bw, bh, this.uv.arrivals, place(X_SPLIT + 0.42, 3.6, 40652, Math.PI / 2));
    // and the departures board on the check-in side of the same wall
    k.b.paint.box(0.2, bh + 0.2, bw + 0.2, '#101a30', place(X_SPLIT - 0.3, 3.6, 40650));
    this.board(bw, bh, this.uv.departures, place(X_SPLIT - 0.42, 3.6, 40650, -Math.PI / 2));
    // tour and buggy-hire desks along the east wall
    const desks: [string, string, string][] = [
      ['Island Tours', 'REEF · JUNGLE · SUNSET CRUISES', '#1d8a99'],
      ['Buggy Hire', 'ELECTRIC CARTS BY THE DAY', '#3a9a5a'],
      ['Hotel Shuttles', 'ALL RESORTS · EVERY 20 MIN', '#e8732a'],
    ];
    desks.forEach(([name, sub, colour], i) => {
      const z = 40640 + i * 10;
      const x = T.x1 - 3;
      k.b.paint.box(0.8, 1.05, 3.2, '#f4f1ea', place(x, 0.525, z));
      k.b.timber.box(0.04, 0.9, 3.22, '#7a4f2c', place(x - 0.42, 0.5, z), { box: 1, grain: 'y' });
      const rr = k.atlas.sign(name, 512, 128, { bg: colour, fg: '#ffffff', border: '#fff5e3', font: 'display', sub });
      k.b.timber.box(0.1, 1.2, 4.2, DARK_TIMBER, place(T.x1 - 0.6, 3.0, z));
      k.b.signs.add(signPlane(4.0, 1.0, rr), '#ffffff', place(T.x1 - 0.66, 3.0, z, -Math.PI / 2));
      staticBox(this.ctx, x, 0.5, z, 0.4, 0.5, 1.6);
    });
    // the café by the exit, and its tables
    this.cafe(92, 106, Z_LAND - 1.6, 'Sea Grape Café', '#3a9a5a', 0);
    for (const [x, z] of [
      [90, 40658],
      [96, 40656],
      [102, 40658],
      [108, 40655],
    ])
      this.table(x, z);
    for (const x of [30, 46, 80, 118]) this.planter(x, Z_LAND - 4, 1.4);
    // customs: the green channel at the exit
    this.sign('Nothing to declare', (EXIT.x0 + EXIT.x1) / 2, 4.0, Z_LAND - 3, Math.PI, 5, { bg: '#1f8a4a', fg: '#ffffff', font: 'body', square: true });
    this.sign('Exit  ·  Beach Park  ·  Buggies', (EXIT.x0 + EXIT.x1) / 2, 4.0, Z_LAND - 3.3, 0, 5.4);
    this.sign('Baggage reclaim', cx - len / 2 - 5, 5.2, Z_MID + 4, 0, 5);
  }

  /** The thatched canopy over the exit: posts, a hip roof, lanterns, planters and torches at the kerb. */
  private canopy() {
    const k = this.k;
    const c = CANOPY;
    const cx = (c.x0 + c.x1) / 2;
    const cz = (c.z0 + c.z1) / 2;
    for (const sx of [c.x0 + 0.6, c.x1 - 0.6])
      for (const z of [c.z0 + 10, c.z1 - 0.6]) {
        k.b.timber.box(0.5, c.eave, 0.5, TIMBER, place(sx, c.eave / 2, z), { box: 1, grain: 'y' });
        k.b.stone.box(0.8, 0.5, 0.8, '#e3d7bd', place(sx, 0.25, z), { box: 1 / 1.2 });
        staticCylinder(this.ctx, sx, z, 0.4, 3);
      }
    for (const z of [c.z0 + 10, c.z1 - 0.6]) k.b.timber.box(c.x1 - c.x0, 0.5, 0.5, DARK_TIMBER, place(cx, c.eave - 0.25, z), { box: 1, grain: 'x' });
    for (const sx of [c.x0 + 0.6, c.x1 - 0.6]) k.b.timber.box(0.5, 0.5, c.z1 - c.z0, DARK_TIMBER, place(sx, c.eave - 0.25, cz), { box: 1, grain: 'z' });
    k.b.thatch.add(hipRoof(c.x1 - c.x0 + 4, c.z1 - c.z0 + 3, 3.2, 0.5, 0.35), '#e2c995', place(cx, c.eave, cz + 1));
    const r = k.atlas.sign('Palm Cay  ·  Arrivals', 640, 133, { bg: '#123f4a', fg: '#fff5e3', border: '#ffd23f', font: 'display', sub: 'BEACH PARK · BUGGIES · HOTEL SHUTTLES' });
    k.b.timber.box(9.2, 1.9, 0.2, DARK_TIMBER, place(cx, c.eave - 1.2, c.z1 - 0.6));
    k.b.signs.add(signPlane(9, 1.875, r), '#ffffff', place(cx, c.eave - 1.2, c.z1 - 0.48));
    k.b.signs.add(signPlane(9, 1.875, r), '#ffffff', place(cx, c.eave - 1.2, c.z1 - 0.72, Math.PI));
    // hanging lanterns under the canopy, in two rows either side of the middle: none on the axis,
    // where they would hang in front of the Arrivals sign (and over the arrivals spot, x = 0)
    for (const x of [-13, -6.5, 6.5, 13])
      for (const z of [c.z0 + 8, c.z0 + 22]) {
        k.b.metal.box(0.02, 1.2, 0.02, '#3a3328', place(x, c.eave - 0.6, z));
        k.b.lit.add(new THREE.CylinderGeometry(0.22, 0.18, 0.5, 8), '#ffe1a8', place(x, c.eave - 1.45, z));
        k.lights.addHalo(new THREE.Vector3(x, c.eave - 1.45, z), '#ffcf8a', 1.6);
        k.lights.addPool(x, 0, z, 6, '#ffbf7a');
      }
    // the kerb: torches either side of the doors and lanterns where the plaza begins
    for (const x of [ENTRANCE.x0 - 1, ENTRANCE.x1 + 1, EXIT.x0 - 1.5, EXIT.x1 + 1.5]) torch(k, x, Z_LAND + 1.6, 2.4);
    for (const x of [-26, 26]) lantern(k, x, Z_LAND + 2.2);
  }

  /** The names on the building: on the apron side and the landside fascia, departures and arrivals over the doors. */
  private signs() {
    const k = this.k;
    const name = k.atlas.paint(1024, 176, (g, w, h) => paintName(g, w, h), 0.7);
    // airside: on the hall's fascia under the eave, above the glass
    k.b.timber.box(13.4, 2.5, 0.3, DARK_TIMBER, place(0, HALL.eave - 1.3, Z_AIR - 0.75));
    k.b.signs.add(signPlane(12.8, 2.2, name), '#ffffff', place(0, HALL.eave - 1.3, Z_AIR - 0.92, Math.PI));
    // landside: over the arrivals canopy's roof line, and Departures over the entrance
    k.b.timber.box(13.4, 2.5, 0.3, DARK_TIMBER, place(-36, HALL.eave - 1.3, Z_LAND + 0.75));
    k.b.signs.add(signPlane(12.8, 2.2, name), '#ffffff', place(-36, HALL.eave - 1.3, Z_LAND + 0.92));
    const dep = k.atlas.sign('Departures', 512, 128, { bg: '#123f4a', fg: '#fff5e3', border: '#ffd23f', font: 'display', sub: 'CHECK-IN · GATES 1 – 4' });
    k.b.signs.add(signPlane(7, 1.75, dep), '#ffffff', place((ENTRANCE.x0 + ENTRANCE.x1) / 2, 5.6, Z_LAND + 0.5));
    k.b.timber.box(7.2, 1.95, 0.15, DARK_TIMBER, place((ENTRANCE.x0 + ENTRANCE.x1) / 2, 5.6, Z_LAND + 0.4));
    // pendant lanterns down every hall
    for (let x = T.x0 + 8; x < T.x1 - 4; x += 12)
      for (const z of [Z_AIR + 15, Z_MID + 20]) {
        if (x > X_OFFICE && z < Z_MID) continue;
        const h = Math.abs(x) < WING.inner ? HALL.eave : WING.eave;
        k.b.metal.box(0.02, h - 4.2, 0.02, '#3a3328', place(x, (h + 4.2) / 2, z));
        k.b.lit.add(new THREE.CylinderGeometry(0.35, 0.28, 0.7, 10), '#ffe1a8', place(x, 3.9, z));
        k.b.timber.add(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 10), DARK_TIMBER, place(x, 4.3, z), { box: 1 });
        k.lights.addHalo(new THREE.Vector3(x, 3.9, z), '#ffcf8a', 2.2);
        k.lights.addPool(x, 0, z, 7, '#ffbf7a');
      }
  }

  /**
   * The painted walkways on the apron, from each gate door to its stands' stairs and from every
   * stand to the arrivals door, and the paths gate 2's passengers take (FA102 boards at S2).
   */
  walkways(stairs: Record<string, Airstairs>, out: WalkRect[]) {
    const k = this.k;
    const lane = Z_AIR - 9;
    const arrivalsX = (ARRIVALS_DOOR.x0 + ARRIVALS_DOOR.x1) / 2;
    const paint = (pts: V2[], w: number) => {
      // two white edge lines with green chevron blocks between them: the walkway
      for (const s of [-1, 1]) k.b.ground.add(strip(offset(pts, (s * w) / 2), 0.2, 0.05, 0.5), '#f4f4f0', place(pts[0].x + 0, 0, pts[0].z));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
        for (let d = 1.5; d < len - 1; d += 3) {
          const p = { x: a.x + ((b.x - a.x) * d) / len, z: a.z + ((b.z - a.z) * d) / len };
          k.b.ground.add(new THREE.PlaneGeometry(w - 0.8, 0.5).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#3fae5a', place(p.x, 0, p.z, yaw), { box: 0.5 });
        }
        out.push({ x0: Math.min(a.x, b.x) - w / 2, x1: Math.max(a.x, b.x) + w / 2, z0: Math.min(a.z, b.z) - w / 2, z1: Math.max(a.z, b.z) + w / 2 });
      }
    };
    const routes: Record<string, { boarding: V2[]; arrivals: V2[] }> = {};
    for (const g of GATE_DOORS)
      for (const id of g.stands) {
        const foot = stairs[id].path[0];
        const side = { x: foot.x + 4.5, z: foot.z };
        const boarding = [
          { x: g.x, z: Z_AIR + 2.5 },
          { x: g.x, z: Z_AIR - 3 },
          { x: g.x + Math.sign(side.x - g.x) * 4, z: lane },
          { x: side.x, z: lane },
          side,
          { x: foot.x, z: foot.z },
        ];
        const arrivals = [
          { x: foot.x, z: foot.z },
          side,
          { x: side.x, z: lane },
          { x: arrivalsX + Math.sign(side.x - arrivalsX) * 4, z: lane },
          { x: arrivalsX, z: Z_AIR - 3 },
          { x: arrivalsX, z: Z_AIR + 3 },
          { x: 13.5, z: Z_AIR + 14 },
          { x: 13.5, z: Z_MID + 3 },
          { x: 14, z: 40660 },
          { x: (EXIT.x0 + EXIT.x1) / 2, z: Z_LAND - 2 },
          { x: AIRPORT_SPOTS.island.arrivals.x, z: AIRPORT_SPOTS.island.arrivals.z },
          { x: 0, z: 40712 },
        ];
        paint(boarding.slice(1), 2.6);
        paint(arrivals.slice(1, 6), 2.6);
        routes[id] = { boarding, arrivals };
      }
    // stanchions with rope barriers either side of gate 2's walkway, from the door to the lane
    // (the apron beyond is out of bounds, and the rope keeps the line of passengers tidy)
    const s2 = routes.S2.boarding;
    for (let i = 1; i < 3; i++) {
      const a = s2[i];
      const b = s2[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.round(len / 2.2));
      for (const side of [-1, 1]) {
        const off = offset([a, b], side * 1.75);
        const tops: THREE.Vector3[] = [];
        for (let j = i === 1 ? 0 : 1; j <= n; j++) {
          const x = off[0].x + ((off[1].x - off[0].x) * j) / n;
          const z = off[0].z + ((off[1].z - off[0].z) * j) / n;
          k.b.metal.add(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 8).translate(0, 0.5, 0), '#c9ced2', place(x, 0, z));
          k.b.metal.add(new THREE.CylinderGeometry(0.16, 0.18, 0.05, 14).translate(0, 0.025, 0), '#3a3f44', place(x, 0, z));
          tops.push(new THREE.Vector3(x, 0.9, z));
        }
        for (let j = 1; j < tops.length; j++) {
          const p = tops[j - 1].clone().lerp(tops[j], 0.5);
          const l = tops[j - 1].distanceTo(tops[j]);
          const yaw = Math.atan2(-(tops[j].x - tops[j - 1].x), -(tops[j].z - tops[j - 1].z));
          k.b.fabric.box(0.04, 0.04, l, '#1d8a99', place(p.x, 0.86, p.z, yaw), 'keep');
        }
      }
    }
    return routes.S2;

  }
}

/** A polyline moved sideways by d (left of travel for d > 0). */
function offset(pts: V2[], d: number): V2[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: p.x - (dz / l) * d, z: p.z + (dx / l) * d };
  });
}

// ------------------------------------------------------------------------------------------------
// Painted boards
// ------------------------------------------------------------------------------------------------

function paintName(g: CanvasRenderingContext2D, w: number, h: number) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#5b3a22';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff5e3';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${Math.round(h * 0.6)}px ${DISPLAY_FONT}`;
  g.fillText('PALM CAY', w * 0.42, h * 0.52);
  g.fillStyle = '#ffd23f';
  g.font = `700 ${Math.round(h * 0.25)}px ${BODY_FONT}`;
  g.fillText(AP.icao, w * 0.84, h * 0.52);
  g.fillRect(w * 0.73, h * 0.25, 3, h * 0.5);
}

function paintWelcome(g: CanvasRenderingContext2D, w: number, h: number) {
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#ff9a5a');
  sky.addColorStop(0.55, '#ffd28a');
  sky.addColorStop(0.56, '#2ab3c4');
  sky.addColorStop(1, '#1d6f8a');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff2c0';
  g.beginPath();
  g.arc(w * 0.78, h * 0.56, h * 0.22, Math.PI, 0);
  g.fill();
  // two palm silhouettes
  g.strokeStyle = '#3a2a1a';
  g.fillStyle = '#3a2a1a';
  g.lineWidth = 9;
  for (const [x, lean] of [
    [w * 0.08, 30],
    [w * 0.93, -40],
  ]) {
    g.beginPath();
    g.moveTo(x, h);
    g.quadraticCurveTo(x + lean * 0.3, h * 0.5, x + lean, h * 0.2);
    g.stroke();
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI + (i / 6) * Math.PI;
      g.beginPath();
      g.moveTo(x + lean, h * 0.2);
      g.quadraticCurveTo(x + lean + Math.cos(a) * 50, h * 0.2 + Math.sin(a) * 40 - 10, x + lean + Math.cos(a) * 90, h * 0.2 + Math.abs(Math.sin(a)) * 10 + 20);
      g.lineWidth = 6;
      g.stroke();
    }
    g.lineWidth = 9;
  }
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 8;
  g.font = `${Math.round(h * 0.36)}px ${DISPLAY_FONT}`;
  g.fillText('Welcome to Palm Cay', w * 0.47, h * 0.36);
  g.font = `700 ${Math.round(h * 0.12)}px ${BODY_FONT}`;
  g.fillText('Bienvenue  ·  Willkommen  ·  Bienvenidos', w * 0.47, h * 0.78);
  g.shadowBlur = 0;
}

/** The mural on the arrivals side of the partition: the reef, fish and turtles. */
function paintMural(g: CanvasRenderingContext2D, w: number, h: number) {
  const sea = g.createLinearGradient(0, 0, 0, h);
  sea.addColorStop(0, '#5fd3e0');
  sea.addColorStop(1, '#13617a');
  g.fillStyle = sea;
  g.fillRect(0, 0, w, h);
  const rnd = mulberry(808);
  // coral along the bottom
  const coral = ['#ff7f6a', '#ffb347', '#e85a8a', '#f7d046', '#b06ad8'];
  for (let i = 0; i < 40; i++) {
    const x = rnd() * w;
    const ch = 40 + rnd() * 80;
    g.fillStyle = coral[i % coral.length];
    g.beginPath();
    g.ellipse(x, h - ch * 0.3, 12 + rnd() * 26, ch * 0.5, 0, 0, Math.PI * 2);
    g.fill();
  }
  // fish
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w;
    const y = 30 + rnd() * (h - 120);
    const s = 10 + rnd() * 16;
    g.fillStyle = ['#ffd23f', '#ff8a3d', '#ffffff', '#3a86ff'][i % 4];
    g.beginPath();
    g.ellipse(x, y, s, s * 0.5, 0, 0, Math.PI * 2);
    g.moveTo(x - s, y);
    g.lineTo(x - s * 1.6, y - s * 0.5);
    g.lineTo(x - s * 1.6, y + s * 0.5);
    g.fill();
  }
  // two turtles
  for (const [x, y] of [
    [w * 0.3, h * 0.35],
    [w * 0.72, h * 0.5],
  ]) {
    g.fillStyle = '#4f8a36';
    g.beginPath();
    g.ellipse(x, y, 46, 34, -0.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#7fbf5a';
    for (const [dx, dy] of [
      [52, -10],
      [-30, -34],
      [-30, 34],
      [20, -36],
      [20, 36],
    ]) {
      g.beginPath();
      g.ellipse(x + dx, y + dy, 14, 9, 0.4, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(30,60,20,0.6)';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(x, y, 30, 20, -0.2, 0, Math.PI * 2);
    g.stroke();
  }
}
