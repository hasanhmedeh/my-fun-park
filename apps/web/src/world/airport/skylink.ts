// The SkyLink: the free driverless people mover from the fair's gate (22, 70) to Funfair
// International's forecourt (22, 405). An elevated dual-lane guideway at 11 m on slim piers (placed
// off the Rally Trail and the kart circuit), a glazed station at each end (a tall hall at ground
// level with a glass lift up to each side platform, platform screen doors, an arched canopy, an
// escalator pair outside each long wall), and two 2-car trains, one on each lane, shuttling the
// 335 m in about half a minute with ease in and out, dwelling with their doors open at each end.
//
// The visitor's ride is a scripted pose (ride()): into the lift, up to the platform, aboard the
// train's leading car when it's in, the run along the guideway at the windscreen, then out and down
// at the far end. The SkyLink holds that lane's train for them (and sends it over to fetch them if
// it's at the other end), so the wait is never longer than one run.
//
// Static parts are a few merged meshes (terminal-kit.ts); the trains, their door leaves, the
// platform doors and the lift cars are instanced (one draw call each for every car, leaf or lift).

import * as THREE from 'three';
import { staticCylinder, type Ctx } from '../context';
import { SKYLINK } from '../geo';
import { nearCircuit } from '../attractions/speedway-track';
import { nearTrail } from '../attractions/trail-track';
import { blockCollider, Kit, kitMaterials, kitMesh, setKitNight, wallCollider, type KitMaterials, type V2, type WalkRect } from './terminal-kit';
import { ACCESS_ROAD, SKY, STATION, skylinkSpot, stationHall } from './terminal-plan';
import { lettering, poster, signAtlas, wayfinding, type PaintedSign, type SignAtlas } from './terminal-signs';
import { CAR_OFFSET, carGeometry, DOOR_HALF, DOOR_HEAD, DOOR_SILL, DOORS_Z, HALF_W, leafGeometry, RIDER_SPOT } from './terminal-skylink-train';

/** The guideway's centre line. */
const CX = SKYLINK.park.x;
/** The two stops, park first: where a train's centre stops (the middle of each station). */
const STOPS: V2[] = [SKYLINK.park, SKYLINK.airport];
/** Station to station. */
const LINE = SKYLINK.airport.z - SKYLINK.park.z;
/** The run: a gentle trapezoid of speed (people-mover comfort: 1.3 m/s², 63 km/h at most). */
const ACC = 1.3;
const VMAX = 17.5;
const RAMP_T = VMAX / ACC;
const RUN_T = LINE / VMAX + RAMP_T;
/** At a stop: settle, doors open (DOOR_T), wait, doors close, a beat, go. */
const SETTLE = 0.8;
const DOOR_T = 2.2;
const DWELL = 16;
/** Walking pace for the rider's scripted steps, and the lifts' speed. */
const WALK = 1.35;
const LIFT_V = 2.4;

const DECK = SKY.deck;
const FLOOR = SKY.floor;
/** The station deck's underside: the hall's glass reaches up to it. */
const DECK_UNDER = DECK - 0.75;
/** The platform canopy's arch: eaves and crown. */
const EAVES = FLOOR + 4.0;
const CROWN = FLOOR + 5.6;
const LIFT_TOP = FLOOR + 3.1;
/** The escalators: their incline (30°) from the hall's north end up to the platform's south end. */
const ESC_FOOT = -11.0;
const ESC_TOP = ESC_FOOT + FLOOR / Math.tan(Math.PI / 6);
const ESC_X0 = STATION.halfX + 0.3;
const ESC_X1 = ESC_X0 + 3.4;
/**
 * Platform doorways along each side (dz from the train's centre): one per car doorway. Car 0 (the
 * north car) faces north, car 1 is turned round, so their doors mirror about the middle.
 */
const DOOR_DZ = [...DOORS_Z.map((d) => -CAR_OFFSET + d), ...DOORS_Z.map((d) => CAR_OFFSET - d)].sort((a, b) => a - b);
/** How far a door leaf slides open. */
const SLIDE = DOOR_HALF - 0.04;

const CONCRETE = '#cbc7bf';
const CONCRETE_DARK = '#9c988f';
const WHITE = '#eef0f1';
const STEEL = '#8d959d';
const DARK = '#2a2e33';
const LED = '#3fb5d0';

const smooth = (t: number) => t * t * (3 - 2 * t);

// ------------------------------------------------------------------------------------------------
// The guideway's piers
// ------------------------------------------------------------------------------------------------

/** z where the park's fence crosses the guideway (it must not stand a pier in the fence line). */
const FENCE_Z = -50 + Math.sqrt(142.5 ** 2 - CX ** 2);

/** True if a pier may stand at z on the centre line: off the trail and its fences, the karts, the park's fence, the road. */
function pierClear(z: number) {
  if (nearTrail(CX, z, 10)) return false;
  if (nearCircuit(CX, z, 13)) return false;
  if (Math.abs(z - FENCE_Z) < 4) return false;
  if (Math.abs(z - ACCESS_ROAD.z) < ACCESS_ROAD.half + 3) return false;
  return true;
}

/** The piers: spaced evenly (~30 m) between the stations, each slid to the nearest clear spot. */
function pierSpots() {
  const z0 = STOPS[0].z + STATION.halfZ;
  const z1 = STOPS[1].z - STATION.halfZ;
  const n = Math.round((z1 - z0) / 30);
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    const want = z0 + ((z1 - z0) * i) / n;
    for (let d = 0; d <= 14; d += 0.5) {
      const z = [want + d, want - d].find((c) => pierClear(c) && c > z0 + 8 && c < z1 - 8 && out.every((o) => Math.abs(o - c) > 12));
      if (z !== undefined) {
        out.push(z);
        break;
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// ------------------------------------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------------------------------------

/**
 * Extrudes a closed outline in the x–y plane (anticlockwise seen from +z, x relative to the
 * centre line) along z from z0 to z1: the guideway's girder. `colour(i)` paints edge i.
 */
function extrudeZ(k: Kit, outline: [number, number][], z0: number, z1: number, colour: (i: number) => string) {
  for (let i = 0; i < outline.length; i++) {
    const [xa, ya] = outline[i];
    const [xb, yb] = outline[(i + 1) % outline.length];
    // (b − a) × (+z) points out of an anticlockwise outline
    k.quad({ x: CX + xa, y: ya, z: z0 }, { x: CX + xb, y: yb, z: z0 }, { x: CX + xb, y: yb, z: z1 }, { x: CX + xa, y: ya, z: z1 }, colour(i));
  }
}

/** A horizontal slab (x0..x1, z0..z1, y0..y1) with a rectangular hole cut through it. */
function slabWithHole(k: Kit, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, hole: WalkRect, colour: string) {
  const parts: [number, number, number, number][] = [
    [x0, hole.x0, z0, z1],
    [hole.x1, x1, z0, z1],
    [hole.x0, hole.x1, z0, hole.z0],
    [hole.x0, hole.x1, hole.z1, z1],
  ];
  for (const [a, b, c, d] of parts) if (b - a > 0.01 && d - c > 0.01) k.span(a, y0, c, b, y1, d, colour);
}

/** Same, as a floor finish only (facing up, or down for a ceiling). */
function floorWithHole(k: Kit, x0: number, x1: number, z0: number, z1: number, y: number, hole: WalkRect, colour: string, down = false) {
  const parts: [number, number, number, number][] = [
    [x0, hole.x0, z0, z1],
    [hole.x1, x1, z0, z1],
    [hole.x0, hole.x1, z0, hole.z0],
    [hole.x0, hole.x1, hole.z1, z1],
  ];
  for (const [a, b, c, d] of parts) if (b - a > 0.01 && d - c > 0.01) k.floor(a, c, b, d, y, colour, undefined, down);
}

/** The kits a station and the guideway are built into (one merged mesh each). */
interface Kits {
  structure: Kit;
  interior: Kit;
  metal: Kit;
  floor: Kit;
  glass: Kit;
  emitter: Kit;
  signs: Kit;
}

/** A glass wall from (x0, z0) to (x1, z1), y0..y1, with mullions every `pitch` metres and transoms at `transoms`. */
function curtain(k: Pick<Kits, 'glass' | 'metal'>, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, pitch: number, transoms: number[]) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.05) return;
  const ux = (x1 - x0) / len;
  const uz = (z1 - z0) / len;
  k.glass.quad({ x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z0 }, '#ffffff');
  const n = Math.max(1, Math.round(len / pitch));
  const rot = -Math.atan2(uz, ux);
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const z = z0 + ((z1 - z0) * i) / n;
    k.metal.box(x, (y0 + y1) / 2, z, 0.08, y1 - y0, 0.16, STEEL, rot + Math.PI / 2);
  }
  for (const y of [y0 + 0.04, ...transoms, y1 - 0.04]) k.metal.box((x0 + x1) / 2, y, (z0 + z1) / 2, len, 0.08, 0.12, STEEL, rot);
}

// ------------------------------------------------------------------------------------------------
// The SkyLink
// ------------------------------------------------------------------------------------------------

interface Lane {
  /** Which side its platform is on (−1 west, +1 east), and its centre line's x. */
  side: number;
  x: number;
  /** The stop it's at (dwelling) or left from (running). */
  at: number;
  mode: 'dwell' | 'run';
  /** Time in this mode, and when this dwell's doors start to close (Infinity while held for a rider). */
  t: number;
  closeAt: number;
  /** 0 shut .. 1 open. */
  doors: number;
  /** The train's centre (z), its direction of travel on the last or current run. */
  z: number;
  dir: number;
  /** A rider's claim: the stop the train must wait at for them (null: free running). */
  holdAt: number | null;
}

export type SkyLinkPhase = 'to-lift' | 'lift-up' | 'to-train' | 'board' | 'ride' | 'alight' | 'lift-down' | 'out' | 'done';

export interface SkyLinkPose {
  /** The rider's feet (y is the floor they stand on: the hall, the lift car, the platform, the car). */
  pos: THREE.Vector3;
  /** Which way they face, in the park's convention (rotation.y: 0 faces north, π south). */
  yaw: number;
  done: boolean;
  /** Where in the trip they are. */
  phase: SkyLinkPhase;
  /** True while they're aboard the train (a camera may want to sit at the windscreen). */
  aboard: boolean;
}

export interface SkyLinkRide {
  update(dt: number): SkyLinkPose;
}

export class SkyLink {
  readonly group = new THREE.Group();
  /** Where the visitor takes the SkyLink at each end: the middle of the station's hall, between its lifts. */
  readonly stations: { park: V2; airport: V2 };
  /** The stations' halls (y = 0), for the walk areas (the airport's is inside the forecourt's; the park's inside the fair). */
  readonly walk: WalkRect[] = [stationHall(STOPS[0]), stationHall(STOPS[1])];
  /** Where the piers stand (z on x = 22), for scenery to keep clear of. */
  readonly piers: number[];
  private readonly mats: KitMaterials;
  private readonly atlas: SignAtlas;
  private readonly lanes: Lane[];
  private readonly cars: THREE.InstancedMesh;
  private readonly carGlass: THREE.InstancedMesh;
  private readonly cabins: THREE.InstancedMesh;
  private readonly leaves: THREE.InstancedMesh;
  private readonly psd: THREE.InstancedMesh;
  private readonly liftFrames: THREE.InstancedMesh;
  private readonly liftGlass: THREE.InstancedMesh;
  /** Each lift car's height and where it's going: [stop * 2 + (side > 0 ? 1 : 0)]. */
  private readonly liftY = [0, 0, 0, 0];
  private readonly liftTo = [0, 0, 0, 0];
  private readonly liftIdle = [0, 0, 0, 0];
  /** Lifts a rider is using (they don't go back down on their own). */
  private readonly claimed = [false, false, false, false];
  private readonly moving: THREE.Object3D[] = [];
  private readonly centre = new THREE.Vector3(CX, 10, (STOPS[0].z + STOPS[1].z) / 2);
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private night = -1;

  constructor(ctx: Ctx) {
    this.group.name = 'skylink';
    this.mats = kitMaterials(ctx);
    this.atlas = signAtlas(ctx);
    this.stations = { park: skylinkSpot(STOPS[0]), airport: skylinkSpot(STOPS[1]) };
    const k: Kits = { structure: new Kit(), interior: new Kit(), metal: new Kit(), floor: new Kit(), glass: new Kit(), emitter: new Kit(), signs: new Kit() };

    this.piers = pierSpots();
    this.guideway(ctx, k);
    this.station(ctx, k, 0);
    this.station(ctx, k, 1);

    const sh = ctx.quality.shadows;
    const m = this.mats;
    const meshes = [
      kitMesh(k.structure, m.structure, sh, sh),
      kitMesh(k.interior, m.interior, false, sh),
      kitMesh(k.metal, m.metal, sh, false),
      kitMesh(k.floor, m.floor, false, sh),
      kitMesh(k.glass, m.glass),
      kitMesh(k.emitter, m.emitter),
      kitMesh(k.signs, this.atlas.material),
    ];
    meshes[4].renderOrder = 2;
    this.group.add(...meshes);

    // the trains: one per lane, free running from opposite ends
    this.lanes = SKY.lanes.map((x, i) => ({
      side: Math.sign(x),
      x: CX + x,
      at: i,
      mode: 'dwell' as const,
      t: i === 0 ? SETTLE + DOOR_T : DWELL * 0.5,
      closeAt: DWELL,
      doors: 1,
      z: STOPS[i].z,
      dir: i === 0 ? 1 : -1,
      holdAt: null,
    }));
    const car = carGeometry();
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, cast: boolean) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.castShadow = cast && sh;
      mesh.receiveShadow = sh;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      this.moving.push(mesh);
      return mesh;
    };
    this.cars = inst(car.body, m.structure, 4, true);
    // the indoor material: its fill light keeps the cabin bright by day, as a lit car would be
    this.cabins = inst(car.cabin, m.interior, 4, false);
    this.carGlass = inst(car.glass, m.glass, 4, false);
    this.carGlass.renderOrder = 2;
    this.leaves = inst(leafGeometry(), m.structure, 4 * DOORS_Z.length * 2 * 2, false);
    this.psd = inst(psdLeafGeometry(), m.glass, 2 * 2 * DOOR_DZ.length * 2, false);
    this.psd.renderOrder = 2;
    const lift = liftGeometry();
    this.liftFrames = inst(lift.frame, m.metal, 4, false);
    this.liftGlass = inst(lift.glass, m.glass, 4, false);
    this.liftGlass.renderOrder = 2;
    this.draw();
    this.setNight(0);
  }

  // ----------------------------------------------------------------------------------------------
  // The guideway
  // ----------------------------------------------------------------------------------------------

  private guideway(ctx: Ctx, k: Kits) {
    const z0 = STOPS[0].z + STATION.halfZ;
    const z1 = STOPS[1].z - STATION.halfZ;
    // the box girder: a trapezoidal box, its deck cantilevered out to parapets either side
    const D = DECK;
    const girder: [number, number][] = [
      [-2.1, D - 1.75],
      [2.1, D - 1.75],
      [2.95, D - 0.4],
      [3.95, D - 0.25],
      [3.95, D + 1.0],
      [3.65, D + 1.0],
      [3.65, D],
      [-3.65, D],
      [-3.65, D + 1.0],
      [-3.95, D + 1.0],
      [-3.95, D - 0.25],
      [-2.95, D - 0.4],
    ];
    extrudeZ(k.structure, girder, z0, z1, (i) => (i === 6 ? CONCRETE_DARK : i === 0 ? '#bdb9b1' : CONCRETE));
    this.trackbed(k, z0, z1);
    // the cyan light line along each parapet's outer face (and a drip groove under it)
    for (const s of [-1, 1]) {
      const x = CX + s * 3.96;
      k.emitter.quad({ x, y: D + 0.72, z: s > 0 ? z1 : z0 }, { x, y: D + 0.72, z: s > 0 ? z0 : z1 }, { x, y: D + 0.8, z: s > 0 ? z0 : z1 }, { x, y: D + 0.8, z: s > 0 ? z1 : z0 }, LED);
      k.metal.span(CX + s * 3.97 - 0.02, D - 0.2, z0, CX + s * 3.97 + 0.02, D - 0.12, z1, DARK);
    }
    // the piers: an oval column, a hammerhead under the girder, bearings, a footing
    for (const z of this.piers) {
      const top = D - 1.75;
      const s = k.structure;
      s.cyl(CX - 0.42, 0, z, 0.72, 0.72, top - 1.0, CONCRETE, 16);
      s.cyl(CX + 0.42, 0, z, 0.72, 0.72, top - 1.0, CONCRETE, 16);
      s.span(CX - 0.42, 0, z - 0.72, CX + 0.42, top - 1.0, z + 0.72, CONCRETE);
      // the hammerhead flares out under the girder's bottom flange
      s.quad({ x: CX - 1.15, y: top - 1.0, z: z + 0.8 }, { x: CX + 1.15, y: top - 1.0, z: z + 0.8 }, { x: CX + 2.3, y: top - 0.15, z: z + 0.8 }, { x: CX - 2.3, y: top - 0.15, z: z + 0.8 }, CONCRETE);
      s.quad({ x: CX + 1.15, y: top - 1.0, z: z - 0.8 }, { x: CX - 1.15, y: top - 1.0, z: z - 0.8 }, { x: CX - 2.3, y: top - 0.15, z: z - 0.8 }, { x: CX + 2.3, y: top - 0.15, z: z - 0.8 }, CONCRETE);
      for (const side of [-1, 1]) {
        const a = { x: CX + side * 1.15, y: top - 1.0 };
        const b = { x: CX + side * 2.3, y: top - 0.15 };
        // the sloping underside, facing out and down
        if (side > 0) s.quad({ x: a.x, y: a.y, z: z + 0.8 }, { x: a.x, y: a.y, z: z - 0.8 }, { x: b.x, y: b.y, z: z - 0.8 }, { x: b.x, y: b.y, z: z + 0.8 }, CONCRETE);
        else s.quad({ x: a.x, y: a.y, z: z - 0.8 }, { x: a.x, y: a.y, z: z + 0.8 }, { x: b.x, y: b.y, z: z + 0.8 }, { x: b.x, y: b.y, z: z - 0.8 }, CONCRETE);
      }
      s.span(CX - 2.3, top - 0.15, z - 0.8, CX + 2.3, top - 0.08, z + 0.8, CONCRETE);
      for (const side of [-1, 1]) k.metal.span(CX + side * 1.5 - 0.3, top - 0.08, z - 0.35, CX + side * 1.5 + 0.3, top, z + 0.35, DARK);
      s.span(CX - 1.6, 0, z - 1.3, CX + 1.6, 0.25, z + 1.3, CONCRETE_DARK);
      staticCylinder(ctx, CX, z, 1.2, 4);
    }
  }

  /** The running pads, guide rails and power rails of both lanes, z0..z1. */
  private trackbed(k: Kits, z0: number, z1: number) {
    for (const lx of SKY.lanes) {
      const x = CX + lx;
      for (const s of [-1, 1]) k.metal.span(x + s * 0.97 - 0.24, DECK, z0, x + s * 0.97 + 0.24, DECK + 0.05, z1, '#6d7074');
      // the guide beam down the middle (the cars' guide wheels grip it), on its plinth
      k.metal.span(x - 0.05, DECK, z0, x + 0.05, DECK + 0.26, z1, STEEL);
      k.metal.span(x - 0.12, DECK + 0.22, z0, x + 0.12, DECK + 0.27, z1, STEEL);
      // the power rails on the parapet side
      const ps = Math.sign(lx);
      k.metal.span(x + ps * 1.72, DECK + 0.38, z0, x + ps * 1.8, DECK + 0.52, z1, '#4d545b');
    }
  }

  // ----------------------------------------------------------------------------------------------
  // A station
  // ----------------------------------------------------------------------------------------------

  /** Stop `i`'s station: 0 at the fair (the guideway leaves south), 1 at the airport (it arrives from the north). */
  private station(ctx: Ctx, k: Kits, i: number) {
    const c = STOPS[i];
    const open = i === 0 ? 1 : -1;
    const H = STATION;
    const x0 = c.x - H.halfX;
    const x1 = c.x + H.halfX;
    const z0 = c.z - H.halfZ;
    const z1 = c.z + H.halfZ;
    const L = SKY.lift;
    const holes = [-1, 1].map((s) => ({ x0: c.x + s * L.x - L.hx, x1: c.x + s * L.x + L.hx, z0: c.z - L.hz, z1: c.z + L.hz }));
    const hole = (s: number) => holes[s < 0 ? 0 : 1];

    // ---- the hall: a floor, glass on all four sides up to the deck, doors, columns
    const fl = k.floor.vertexCount;
    k.floor.floor(x0, z0, x1, z1, 0.02, '#e9e5de');
    k.floor.worldUvXZ(fl, 2.4);
    // a darker band round the edge, an entrance mat at each door
    for (const s of [-1, 1]) k.floor.floor(c.x + s * H.halfX - (s > 0 ? 1.2 : 0), z0, c.x + s * H.halfX + (s > 0 ? 0 : 1.2), z1, 0.025, '#8f8a82');
    const doors: { face: 'n' | 's' | 'w'; at: number }[] = i === 0 ? [{ face: 'n', at: c.x }, { face: 'w', at: c.z - 7 }] : [{ face: 'n', at: c.x }, { face: 's', at: c.x }];
    const DW = 2.2;
    const wall = (ax: number, az: number, bx: number, bz: number, face: 'n' | 's' | 'e' | 'w') => {
      // split round any door on this face
      const gaps = doors.filter((d) => d.face === face).map((d) => d.at);
      const alongX = az === bz;
      let from = alongX ? ax : az;
      const to = alongX ? bx : bz;
      const pieces: [number, number][] = [];
      for (const g of gaps.sort((p, q) => p - q)) {
        pieces.push([from, g - DW]);
        from = g + DW;
      }
      pieces.push([from, to]);
      for (const [p, q] of pieces) {
        if (q - p < 0.05) continue;
        if (alongX) {
          curtain(k, p, az, q, az, 0.02, DECK_UNDER, 2.4, [3.4, 6.8]);
          wallCollider(ctx, p, az, q, az, 4, 0.3);
        } else {
          curtain(k, ax, p, ax, q, 0.02, DECK_UNDER, 2.4, [3.4, 6.8]);
          wallCollider(ctx, ax, p, ax, q, 4, 0.3);
        }
      }
      // the doorways: frames, the open sliding leaves parked either side, the glass above, a canopy outside
      for (const g of gaps) {
        const out = face === 'n' ? -1 : face === 's' ? 1 : -1;
        if (alongX) {
          for (const s of [-1, 1]) k.metal.span(g + s * DW - 0.08, 0.02, az - 0.1, g + s * DW + 0.08, 3.0, az + 0.1, DARK);
          k.metal.span(g - DW, 2.9, az - 0.12, g + DW, 3.1, az + 0.12, DARK);
          for (const s of [-1, 1]) k.glass.quad({ x: g + s * DW, y: 0.05, z: az - out * 0.15 }, { x: g + s * (DW + 2.0), y: 0.05, z: az - out * 0.15 }, { x: g + s * (DW + 2.0), y: 2.9, z: az - out * 0.15 }, { x: g + s * DW, y: 2.9, z: az - out * 0.15 }, '#ffffff');
          curtain(k, g - DW, az, g + DW, az, 3.1, DECK_UNDER, 2.2, [6.8]);
          k.structure.span(g - DW - 1.2, 3.25, Math.min(az, az + out * 3.2), g + DW + 1.2, 3.45, Math.max(az, az + out * 3.2), WHITE);
          k.emitter.floor(g - DW, Math.min(az + out * 0.6, az + out * 2.8), g + DW, Math.max(az + out * 0.6, az + out * 2.8), 3.24, '#fff1d6', undefined, true);
          const mat = k.floor.vertexCount;
          k.floor.floor(g - DW, Math.min(az, az - out * 2.4), g + DW, Math.max(az, az - out * 2.4), 0.03, '#4a4f56');
          k.floor.worldUvXZ(mat, 2.4);
        } else {
          for (const s of [-1, 1]) k.metal.span(ax - 0.1, 0.02, g + s * DW - 0.08, ax + 0.1, 3.0, g + s * DW + 0.08, DARK);
          k.metal.span(ax - 0.12, 2.9, g - DW, ax + 0.12, 3.1, g + DW, DARK);
          for (const s of [-1, 1]) k.glass.quad({ x: ax + 0.15, y: 0.05, z: g + s * DW }, { x: ax + 0.15, y: 0.05, z: g + s * (DW + 2.0) }, { x: ax + 0.15, y: 2.9, z: g + s * (DW + 2.0) }, { x: ax + 0.15, y: 2.9, z: g + s * DW }, '#ffffff');
          curtain(k, ax, g - DW, ax, g + DW, 3.1, DECK_UNDER, 2.2, [6.8]);
          k.structure.span(ax - 3.2, 3.25, g - DW - 1.2, ax, 3.45, g + DW + 1.2, WHITE);
          k.emitter.floor(ax - 2.8, g - DW, ax - 0.6, g + DW, 3.24, '#fff1d6', undefined, true);
          const mat = k.floor.vertexCount;
          k.floor.floor(ax, g - DW, ax + 2.4, g + DW, 0.03, '#4a4f56');
          k.floor.worldUvXZ(mat, 2.4);
        }
      }
    };
    wall(x0, z0, x1, z0, 'n');
    wall(x0, z1, x1, z1, 's');
    wall(x0, z0, x0, z1, 'w');
    wall(x1, z0, x1, z1, 'e');
    // columns carrying the deck, under the trackbeds' edges
    for (const s of [-1, 1])
      for (const dz of [-8, 8]) {
        k.structure.cyl(c.x + s * 3.2, 0.02, c.z + dz, 0.42, 0.42, DECK_UNDER, WHITE, 16);
        staticCylinder(ctx, c.x + s * 3.2, c.z + dz, 0.45, 4);
      }

    // ---- the deck: the hall's ceiling, the trackbeds, the side platforms
    for (const s of [-1, 1]) {
      const h = hole(s);
      const xa = s < 0 ? x0 - 0.2 : c.x + SKY.psdX;
      const xb = s < 0 ? c.x - SKY.psdX : x1 + 0.2;
      slabWithHole(k.structure, xa, xb, z0, z1, DECK_UNDER, FLOOR, h, CONCRETE);
      floorWithHole(k.floor, xa, xb, z0, z1, FLOOR + 0.004, h, '#ddd8cf');
      // the hall's ceiling under it: a lit soffit
      floorWithHole(k.interior, xa, xb, z0, z1, DECK_UNDER - 0.01, h, '#f2f1ee', true);
    }
    k.structure.span(c.x - SKY.psdX, DECK_UNDER, z0, c.x + SKY.psdX, DECK, z1, CONCRETE);
    k.interior.floor(c.x - SKY.psdX, z0, c.x + SKY.psdX, z1, DECK_UNDER - 0.01, '#f2f1ee', undefined, true);
    // the deck's edge band outside, white
    for (const z of [z0 - 0.21, z1 + 0.01]) k.structure.span(x0 - 0.2, DECK_UNDER - 0.1, z, x1 + 0.2, FLOOR + 0.1, z + 0.2, WHITE);
    for (const x of [x0 - 0.21, x1 + 0.01]) k.structure.span(x, DECK_UNDER - 0.1, z0, x + 0.2, FLOOR + 0.1, z1, WHITE);
    // downlights in the hall's soffit
    for (const s of [-1, 1]) for (let dz = -10; dz <= 10; dz += 4) k.emitter.floor(c.x + s * 8.6 - 0.3, c.z + dz - 0.3, c.x + s * 8.6 + 0.3, c.z + dz + 0.3, DECK_UNDER - 0.03, '#fff3dd', undefined, true);
    for (let dz = -10; dz <= 10; dz += 5) k.emitter.floor(c.x - 0.4, c.z + dz - 0.4, c.x + 0.4, c.z + dz + 0.4, DECK_UNDER - 0.03, '#fff3dd', undefined, true);
    this.trackbed(k, z0, z1);
    // the buffer stops at the closed end
    const endZ = c.z - open * (H.halfZ - 0.5);
    for (const lx of SKY.lanes) {
      k.metal.span(CX + lx - 1.0, DECK, endZ - 0.4, CX + lx + 1.0, DECK + 1.1, endZ + 0.4, '#ffc23d');
      k.metal.span(CX + lx - 1.02, DECK + 0.5, endZ - 0.42, CX + lx + 1.02, DECK + 0.7, endZ + 0.42, DARK);
    }

    // ---- the platform screen doors along each platform edge: fixed glass between the doorways
    for (const s of [-1, 1]) {
      const x = c.x + s * SKY.psdX;
      const top = FLOOR + 2.25;
      let from = z0 + 0.3;
      const edges = DOOR_DZ.map((d) => c.z + d);
      for (const e of edges) {
        k.glass.quad({ x, y: FLOOR, z: from }, { x, y: FLOOR, z: e - DOOR_HALF }, { x, y: top, z: e - DOOR_HALF }, { x, y: top, z: from }, '#ffffff');
        for (const zz of [e - DOOR_HALF, e + DOOR_HALF]) k.metal.span(x - 0.06, FLOOR, zz - 0.06, x + 0.06, top, zz + 0.06, '#5a6168');
        from = e + DOOR_HALF;
      }
      k.glass.quad({ x, y: FLOOR, z: from }, { x, y: FLOOR, z: z1 - 0.3 }, { x, y: top, z: z1 - 0.3 }, { x, y: top, z: from }, '#ffffff');
      for (let zz = z0 + 0.3; zz <= z1 - 0.2; zz += 2.4) k.metal.span(x - 0.04, FLOOR, zz - 0.04, x + 0.04, top, zz + 0.04, '#5a6168');
      // the header over them, its strip light along the platform side, the doorway numbers
      k.metal.span(x - 0.12, top, z0 + 0.2, x + 0.12, top + 0.42, z1 - 0.2, '#3a3f45');
      k.emitter.panel(x + s * 0.13, top + 0.06, c.z, H.halfZ * 2 - 0.6, 0.05, s > 0 ? Math.PI / 2 : -Math.PI / 2, '#fff3dd');
      // the yellow line and the door positions painted on the platform floor
      for (const e of edges) k.floor.floor(Math.min(x, x + s * 0.9), e - DOOR_HALF, Math.max(x, x + s * 0.9), e + DOOR_HALF, FLOOR + 0.008, '#f2c21a');
    }

    // ---- the platform level's glass walls, the canopy over it
    for (const s of [-1, 1]) {
      const x = c.x + s * H.halfX;
      // a gap at the top of the escalator (the platform's south end)
      const gz0 = c.z + ESC_TOP - 0.1;
      curtain(k, x, z0, x, gz0, FLOOR, EAVES, 2.4, [FLOOR + 1.1]);
      curtain(k, x, z1 - 0.2, x, z1, FLOOR + 2.6, EAVES, 2.4, []);
      curtain(k, x, gz0, x, z1 - 0.2, FLOOR + 2.6, EAVES, 2.4, []);
      for (const zz of [gz0, z1 - 0.2]) k.metal.span(x - 0.1, FLOOR, zz - 0.08, x + 0.1, FLOOR + 2.6, zz + 0.08, DARK);
    }
    // the closed end's glass, the open end's either side of the guideway's mouth
    const closedZ = c.z - open * H.halfZ;
    const openZ = c.z + open * H.halfZ;
    curtain(k, x0, closedZ, x1, closedZ, FLOOR, EAVES + 0.4, 2.4, [FLOOR + 1.1]);
    for (const s of [-1, 1]) curtain(k, c.x + s * 4.2, openZ, c.x + s * H.halfX, openZ, FLOOR, EAVES, 2.4, [FLOOR + 1.1]);
    this.canopy(k, c);

    // ---- the lifts: glass shafts from the hall through the deck to the platforms, doors facing the tracks
    for (const s of [-1, 1]) {
      const h = hole(s);
      const inner = s < 0 ? h.x1 : h.x0;
      const outer = s < 0 ? h.x0 : h.x1;
      const g = k;
      curtain(g, outer, h.z0, outer, h.z1, 0.02, LIFT_TOP, 3, []);
      curtain(g, h.x0, h.z0, h.x1, h.z0, 0.02, LIFT_TOP, 3, []);
      curtain(g, h.x0, h.z1, h.x1, h.z1, 0.02, LIFT_TOP, 3, []);
      // the door side: glass except the doorways at the hall and the platform
      curtain(g, inner, h.z0, inner, h.z1, 2.35, FLOOR - 0.02, 3, []);
      curtain(g, inner, h.z0, inner, h.z1, FLOOR + 2.35, LIFT_TOP, 3, []);
      for (const y of [0.02, FLOOR]) {
        k.metal.span(inner - 0.08, y, h.z0, inner + 0.08, y + 2.35, h.z0 + 0.35, '#c3c9cf');
        k.metal.span(inner - 0.08, y, h.z1 - 0.35, inner + 0.08, y + 2.35, h.z1, '#c3c9cf');
        k.metal.span(inner - 0.08, y + 2.2, h.z0, inner + 0.08, y + 2.35, h.z1, '#c3c9cf');
      }
      // the machine box on top, the guide rails up the back
      k.metal.span(h.x0, LIFT_TOP, h.z0, h.x1, LIFT_TOP + 0.35, h.z1, '#5a6168');
      for (const zz of [h.z0 + 0.3, h.z1 - 0.3]) k.metal.span(outer - s * 0.12 - 0.04, 0.02, zz - 0.04, outer - s * 0.12 + 0.04, LIFT_TOP, zz + 0.04, '#5a6168');
      // a lift sign over each door, both levels
      const sign = wayfinding(this.atlas, ['lift', i === 0 ? 'Platform · to the Airport' : 'Platform · to the Fair'], { height: 80 });
      const facing = s < 0 ? Math.PI / 2 : -Math.PI / 2;
      k.signs.panel(inner + s * -0.13, 2.85, c.z, 0.5 * sign.aspect, 0.5, facing, '#ffffff', sign.uv);
      const down = wayfinding(this.atlas, ['lift', 'Way out'], { height: 80 });
      k.signs.panel(inner + s * -0.13, FLOOR + 2.85, c.z, 0.5 * down.aspect, 0.5, facing, '#ffffff', down.uv);
      blockCollider(ctx, h.x0, h.z0, h.x1, h.z1, 4);
    }

    // ---- the escalators outside the long walls, from the hall's north end up to the platform's south end
    for (const s of [-1, 1]) this.escalator(ctx, k, c, s);

    // ---- the hall's furniture: benches along the walls, the route map, hanging signs, the name outside
    for (const s of [-1, 1])
      for (const dz of [-9.5, 5.5]) {
        const bx = c.x + s * 8.9;
        k.structure.span(bx - 0.3, 0.42, c.z + dz, bx + 0.3, 0.48, c.z + dz + 3.2, '#c9a27a');
        for (const e of [0.3, 2.9]) k.metal.span(bx - 0.25, 0.02, c.z + dz + e - 0.04, bx + 0.25, 0.42, c.z + dz + e + 0.04, DARK);
        blockCollider(ctx, bx - 0.3, c.z + dz, bx + 0.3, c.z + dz + 3.2, 0.5);
      }
    const map = poster(this.atlas, `skylink-map`, 'SkyLink', ['Fair Gate|0:00', 'Funfair International|0:35', 'Free · every 2 minutes', 'Driverless · step-free'], '#1d1238', '#fff5e3', '#2ec4b6');
    for (const s of [-1, 1]) {
      const x = c.x + s * (H.halfX - 0.25);
      const facing = s < 0 ? Math.PI / 2 : -Math.PI / 2;
      k.metal.box(x, 2.0, c.z - 5.5, 0.06, 1.62, 1.55 * map.aspect + 0.1, DARK);
      k.signs.panel(x - s * 0.04, 2.0, c.z - 5.5, 1.5 * map.aspect, 1.5, facing, '#ffffff', map.uv);
    }
    const here = wayfinding(this.atlas, ['train', 'SkyLink', i === 0 ? 'departures' : 'gate', i === 0 ? 'Airport' : 'The Fair'], { location: true, height: 96 });
    this.hang(k, here, c.x, 4.4, c.z - 4.5, 0.9, 0);
    this.hang(k, here, c.x, 4.4, c.z + 4.5, 0.9, Math.PI);
    const name = lettering(this.atlas, i === 0 ? 'SkyLink  ·  Fair Gate' : 'SkyLink  ·  Funfair International', { fg: '#ffffff', bg: '#1d1238', height: 96 });
    // the long sides just say SkyLink, at the north end (the escalators climb past the south end)
    const brand = lettering(this.atlas, 'SkyLink', { fg: '#ffffff', bg: '#1d1238', height: 96 });
    for (const s of [-1, 1]) {
      const facing = s < 0 ? -Math.PI / 2 : Math.PI / 2;
      k.signs.panel(c.x + s * (H.halfX + 0.23), DECK_UNDER + 0.85, c.z - 6.5, 1.25 * brand.aspect, 1.25, facing, '#ffffff', brand.uv);
    }
    // over the main door, facing out
    const doorFace = i === 0 ? 0 : Math.PI;
    k.signs.panel(c.x, DECK_UNDER + 0.85, (i === 0 ? z0 : z1) + (i === 0 ? -0.23 : 0.23), 1.25 * name.aspect, 1.25, doorFace, '#ffffff', name.uv);
  }

  /** A sign hanging on two rods from the soffit, both faces. */
  private hang(k: Kits, s: PaintedSign, x: number, y: number, z: number, h: number, facing: number) {
    const w = h * s.aspect;
    const rx = Math.cos(facing) * (w / 2 - 0.2);
    const rz = Math.sin(facing) * (w / 2 - 0.2);
    for (const d of [-1, 1]) k.metal.bar({ x: x + rx * d, y: y + h / 2, z: z + rz * d }, { x: x + rx * d, y: DECK_UNDER, z: z + rz * d }, 0.015, '#8d959d', 4);
    k.metal.box(x, y, z, Math.abs(Math.cos(facing)) * (w + 0.06) + 0.06, h + 0.06, Math.abs(Math.sin(facing)) * (w + 0.06) + 0.06, DARK);
    const nx = Math.sin(facing) * 0.035;
    const nz = -Math.cos(facing) * 0.035;
    k.signs.panel(x + nx, y, z + nz, w, h, facing, '#ffffff', s.uv);
    k.signs.panel(x - nx, y, z - nz, w, h, facing + Math.PI, '#ffffff', s.uv);
  }

  /** The platform's arched canopy: a white top, a pale lit underside, fascias carrying the name. */
  private canopy(k: Kits, c: V2) {
    const hx = STATION.halfX + 0.8;
    const z0 = c.z - STATION.halfZ - 1.0;
    const z1 = c.z + STATION.halfZ + 1.0;
    const n = 12;
    const y = (x: number) => EAVES + (CROWN - EAVES) * (1 - (x / hx) ** 2);
    for (let j = 0; j < n; j++) {
      const xa = -hx + (2 * hx * j) / n;
      const xb = -hx + (2 * hx * (j + 1)) / n;
      const ya = y(xa);
      const yb = y(xb);
      k.structure.quad({ x: c.x + xa, y: ya + 0.3, z: z1 }, { x: c.x + xb, y: yb + 0.3, z: z1 }, { x: c.x + xb, y: yb + 0.3, z: z0 }, { x: c.x + xa, y: ya + 0.3, z: z0 }, WHITE);
      k.interior.quad({ x: c.x + xa, y: ya, z: z0 }, { x: c.x + xb, y: yb, z: z0 }, { x: c.x + xb, y: yb, z: z1 }, { x: c.x + xa, y: ya, z: z1 }, '#e8e6e1');
      // the arch's end faces
      for (const [z, f] of [
        [z0, -1],
        [z1, 1],
      ] as const) {
        const A = { x: c.x + xa, y: ya, z };
        const B = { x: c.x + xb, y: yb, z };
        const C = { x: c.x + xb, y: yb + 0.3, z };
        const D = { x: c.x + xa, y: ya + 0.3, z };
        if (f > 0) k.structure.quad(A, B, C, D, WHITE);
        else k.structure.quad(B, A, D, C, WHITE);
      }
    }
    // the eaves' fascias, the arch ribs underneath, the light lines between them
    for (const s of [-1, 1]) k.structure.span(c.x + s * hx - 0.12, EAVES - 0.5, z0, c.x + s * hx + 0.12, EAVES + 0.3, z1, WHITE);
    for (let z = z0 + 1.0; z <= z1 - 0.9; z += 4.6) {
      for (let j = 0; j < n; j++) {
        const xa = -hx + (2 * hx * j) / n;
        const xb = -hx + (2 * hx * (j + 1)) / n;
        k.metal.beam({ x: c.x + xa, y: y(xa) - 0.12, z }, { x: c.x + xb, y: y(xb) - 0.12, z }, 0.14, 0.24, '#d4d8dc');
      }
    }
    for (const lx of [-6.5, 0, 6.5]) k.emitter.floor(c.x + lx - 0.12, z0 + 1.5, c.x + lx + 0.12, z1 - 1.5, y(lx) - 0.03, '#fff3dd', undefined, true);
  }

  /** The escalator pair outside a station's long wall (side s): truss, steps, glass balustrades, handrails. */
  private escalator(ctx: Ctx, k: Kits, c: V2, s: number) {
    const xa = c.x + s * ESC_X0;
    const xb = c.x + s * ESC_X1;
    const xm = (xa + xb) / 2;
    const za = c.z + ESC_FOOT;
    const zb = c.z + ESC_TOP;
    const run = zb - za;
    // the truss, clad in brushed aluminium, and its foot pit / top landing
    k.metal.beam({ x: xm, y: -0.62, z: za }, { x: xm, y: FLOOR - 0.62, z: zb }, 3.4, 1.15, '#c9ced4');
    k.structure.span(Math.min(xa, xb), DECK_UNDER, zb, Math.max(xa, xb), FLOOR, c.z + STATION.halfZ, CONCRETE);
    k.floor.floor(Math.min(xa, xb), zb, Math.max(xa, xb), c.z + STATION.halfZ, FLOOR + 0.004, '#ddd8cf');
    k.metal.floor(Math.min(xa, xb), za - 2.2, Math.max(xa, xb), za, 0.03, '#8d959d');
    // the column under its middle
    const mid = 0.45;
    k.structure.cyl(xm, 0, za + run * mid, 0.32, 0.32, FLOOR * mid - 1.1, WHITE, 12);
    staticCylinder(ctx, xm, za + run * mid, 0.35, 4);
    // two flights of steps (one up, one down), ribbed treads
    const steps = Math.round(FLOOR / 0.2);
    const rise = FLOOR / steps;
    const tread = run / steps;
    for (const lane of [0.25, 0.75]) {
      const xc = xa + (xb - xa) * lane;
      const hw = 0.5;
      for (let j = 0; j < steps; j++) {
        const z = za + j * tread;
        const y = j * rise;
        k.metal.quad({ x: xc - hw, y: y + rise, z: z + tread }, { x: xc + hw, y: y + rise, z: z + tread }, { x: xc + hw, y: y + rise, z }, { x: xc - hw, y: y + rise, z }, j % 2 ? '#4d545b' : '#575e66');
        k.metal.quad({ x: xc - hw, y, z }, { x: xc - hw, y: y + rise, z }, { x: xc + hw, y: y + rise, z }, { x: xc + hw, y, z }, '#2e3238');
        // the yellow edge on each tread
        k.metal.quad({ x: xc - hw, y: y + rise + 0.003, z: z + 0.06 }, { x: xc + hw, y: y + rise + 0.003, z: z + 0.06 }, { x: xc + hw, y: y + rise + 0.003, z }, { x: xc - hw, y: y + rise + 0.003, z }, '#e8c02a');
      }
      // balustrades either side of the flight: glass, a black handrail on top
      for (const e of [-1, 1]) {
        const x = xc + e * (hw + 0.1);
        k.glass.quad({ x, y: 0.15, z: za - 1.2 }, { x, y: FLOOR + 0.15, z: zb }, { x, y: FLOOR + 1.05, z: zb + 0.4 }, { x, y: 1.05, z: za - 0.8 }, '#ffffff');
        k.metal.bar({ x, y: 1.05, z: za - 1.2 }, { x, y: FLOOR + 1.05, z: zb + 0.4 }, 0.045, '#15171a', 6);
        k.metal.quad({ x, y: -0.05, z: za - 1.2 }, { x, y: FLOOR - 0.05, z: zb }, { x, y: FLOOR + 0.18, z: zb }, { x, y: 0.18, z: za - 1.2 }, '#aab1b8');
      }
    }
    blockCollider(ctx, Math.min(xa, xb), za - 2.2, Math.max(xa, xb), zb, 3);
  }

  // ----------------------------------------------------------------------------------------------
  // Running
  // ----------------------------------------------------------------------------------------------

  /** Distance covered `t` seconds into a run. */
  private static runDist(t: number) {
    if (t <= 0) return 0;
    if (t >= RUN_T) return LINE;
    if (t < RAMP_T) return 0.5 * ACC * t * t;
    if (t < RUN_T - RAMP_T) return 0.5 * ACC * RAMP_T * RAMP_T + VMAX * (t - RAMP_T);
    const r = RUN_T - t;
    return LINE - 0.5 * ACC * r * r;
  }

  private stepLane(l: Lane, dt: number) {
    l.t += dt;
    if (l.mode === 'run') {
      const from = STOPS[l.at].z;
      l.z = from + l.dir * SkyLink.runDist(l.t);
      if (l.t >= RUN_T) {
        l.at = 1 - l.at;
        l.z = STOPS[l.at].z;
        l.mode = 'dwell';
        l.t = 0;
        l.closeAt = l.holdAt === l.at ? Infinity : l.holdAt !== null ? SETTLE + DOOR_T + 1.5 : DWELL;
      }
      l.doors = 0;
      return;
    }
    // dwelling: held for a rider here (doors stay open, or open again), or hurried along to fetch one from the other end
    if (l.holdAt === l.at) l.closeAt = Infinity;
    else if (l.holdAt !== null) l.closeAt = Math.min(l.closeAt, Math.max(l.t, SETTLE + DOOR_T + 1.5));
    const open = l.t >= SETTLE && l.t < l.closeAt;
    l.doors = THREE.MathUtils.clamp(l.doors + (open ? dt : -dt) / DOOR_T, 0, 1);
    if (!open && l.doors === 0 && l.t >= l.closeAt + DOOR_T + 0.8) {
      l.mode = 'run';
      l.t = 0;
      l.dir = l.at === 0 ? 1 : -1;
    }
  }

  /** Seconds until lane `l` would stand at stop `i` with its doors open, if sent for. */
  private waitFor(l: Lane, i: number) {
    const turn = SETTLE + DOOR_T * 2 + 2.3;
    if (l.mode === 'dwell' && l.at === i) return l.t > l.closeAt ? DOOR_T : Math.max(0, SETTLE + DOOR_T - l.t);
    if (l.mode === 'run' && l.at !== i) return RUN_T - l.t + SETTLE + DOOR_T;
    if (l.mode === 'dwell') return Math.max(0, turn - l.t) + RUN_T + SETTLE + DOOR_T;
    return RUN_T - l.t + turn + RUN_T + SETTLE + DOOR_T;
  }

  private draw() {
    const D = DOORS_Z.length;
    this.lanes.forEach((l, li) => {
      // the cars: car 0's nose to the north, car 1 turned round, its nose to the south
      for (let ci = 0; ci < 2; ci++) {
        const flip = ci === 1;
        const z = l.z + (flip ? CAR_OFFSET : -CAR_OFFSET);
        this.q.setFromAxisAngle(this.up, flip ? Math.PI : 0);
        this.m.compose(this.p.set(l.x, DECK, z), this.q, this.one);
        const idx = li * 2 + ci;
        this.cars.setMatrixAt(idx, this.m);
        this.carGlass.setMatrixAt(idx, this.m);
        this.cabins.setMatrixAt(idx, this.m);
        // the doors: open on the platform's side only (the car's own left or right, as it's turned)
        const platformLocal = flip ? -l.side : l.side;
        for (let d = 0; d < D; d++)
          for (const sl of [-1, 1]) {
            const open = sl === platformLocal ? l.doors : 0;
            const plug = Math.min(1, open * 4);
            const slide = smooth(THREE.MathUtils.clamp((open - 0.15) / 0.85, 0, 1));
            for (const e of [-1, 1]) {
              this.q.setFromAxisAngle(this.up, sl < 0 ? Math.PI : 0);
              this.m2.compose(this.p.set(sl * (HALF_W + 0.02 + 0.07 * plug), (DOOR_SILL + DOOR_HEAD) / 2, DOORS_Z[d] + e * (DOOR_HALF / 2 + SLIDE * slide)), this.q, this.one);
              this.m2.premultiply(this.m);
              this.leaves.setMatrixAt(((idx * D + d) * 2 + (sl < 0 ? 0 : 1)) * 2 + (e < 0 ? 0 : 1), this.m2);
            }
          }
      }
      // the platform screen doors at both stations, open in step with the train's when it's in
      for (let si = 0; si < 2; si++) {
        const here = l.mode === 'dwell' && l.at === si ? l.doors : 0;
        const slide = smooth(here);
        const c = STOPS[si];
        DOOR_DZ.forEach((dz, d) => {
          for (const e of [-1, 1]) {
            this.m.makeTranslation(c.x + l.side * (SKY.psdX + 0.06), FLOOR, c.z + dz + e * (DOOR_HALF / 2 + SLIDE * slide));
            this.psd.setMatrixAt(((si * 2 + li) * DOOR_DZ.length + d) * 2 + (e < 0 ? 0 : 1), this.m);
          }
        });
      }
    });
    // the lift cars
    for (let si = 0; si < 2; si++)
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        const c = STOPS[si];
        this.q.setFromAxisAngle(this.up, side < 0 ? 0 : Math.PI);
        this.m.compose(this.p.set(c.x + side * SKY.lift.x, this.liftY[si * 2 + s], c.z), this.q, this.one);
        this.liftFrames.setMatrixAt(si * 2 + s, this.m);
        this.liftGlass.setMatrixAt(si * 2 + s, this.m);
      }
    for (const mesh of [this.cars, this.carGlass, this.cabins, this.leaves, this.psd, this.liftFrames, this.liftGlass]) mesh.instanceMatrix.needsUpdate = true;
  }

  private stepLifts(dt: number) {
    for (let j = 0; j < 4; j++) {
      const d = this.liftTo[j] - this.liftY[j];
      if (Math.abs(d) < 1e-3) {
        // an empty lift left at the platform goes back down to the hall after a while
        this.liftIdle[j] += dt;
        if (this.liftY[j] > 0 && this.liftIdle[j] > 25 && !this.claimed[j]) this.liftTo[j] = 0;
        continue;
      }
      this.liftIdle[j] = 0;
      // a smooth start and stop: speed tapers within a metre and a half of the landing
      const v = Math.min(LIFT_V, 0.35 + Math.abs(d) * 1.4);
      this.liftY[j] += Math.sign(d) * Math.min(Math.abs(d), v * dt);
    }
  }

  update(dt: number, _t: number, camera?: THREE.Camera) {
    const step = Math.min(dt, 0.1);
    for (const l of this.lanes) this.stepLane(l, step);
    this.stepLifts(step);
    const d = camera ? camera.position.distanceTo(this.centre) : 0;
    this.group.visible = d < 22000;
    const near = d < 3500;
    for (const o of this.moving) o.visible = near;
    if (near) this.draw();
  }

  /** 0 by day .. 1 at night: the stations' lights, the guideway's light line, the trains' lit cabins. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 1e-3) return;
    this.night = k;
    setKitNight(this.mats, k);
    this.atlas.setNight(k);
  }

  // ----------------------------------------------------------------------------------------------
  // The visitor's ride
  // ----------------------------------------------------------------------------------------------

  /**
   * The visitor's trip from one station's hall to the other's: drives a pose the game puts the
   * player (or the camera) at, from the hall's floor into the lift, up, along the platform, aboard
   * at the leading car's windscreen, along the guideway, and out and down at the far end.
   */
  ride(from: 'park' | 'airport'): SkyLinkRide {
    const a = from === 'park' ? 0 : 1;
    const b = 1 - a;
    // the lane whose train can be at our platform soonest; it's ours until we're off at the far end
    const L = this.lanes.reduce((best, l) => (this.waitFor(l, a) < this.waitFor(best, a) ? l : best), this.lanes[0]);
    L.holdAt = a;
    const dir = b > a ? 1 : -1;
    const s = L.side;
    const lift = (stop: number) => stop * 2 + (s < 0 ? 0 : 1);
    this.claimed[lift(a)] = true;
    this.liftTo[lift(a)] = 0;
    // the doorway nearest the leading cab, and the windscreen spot ahead of it
    const doorDz = dir * Math.max(...DOOR_DZ.map(Math.abs));
    const noseDz = dir * (CAR_OFFSET - RIDER_SPOT.z);
    const travelYaw = dir > 0 ? Math.PI : 0;
    // facing the lift's doors (they face the tracks) and facing the tracks from the platform
    const toTracks = s < 0 ? -Math.PI / 2 : Math.PI / 2;

    const pose: SkyLinkPose = { pos: new THREE.Vector3(STOPS[a].x, 0, STOPS[a].z), yaw: dir > 0 ? Math.PI : 0, done: false, phase: 'to-lift', aboard: false };
    let phase: SkyLinkPhase = 'to-lift';
    let path: THREE.Vector3[] = [];
    let seg = 0;
    /** Whether the rider has stepped into the lift car (they wait outside until it's there). */
    let inside = false;
    const setPath = (pts: THREE.Vector3[]) => {
      path = [pose.pos.clone(), ...pts];
      seg = 0;
    };
    /** Walks the path at a stroll; true once at its end. */
    const walk = (dt: number) => {
      let left = WALK * dt;
      while (seg < path.length - 1 && left > 0) {
        const to = path[seg + 1];
        const dx = to.x - pose.pos.x;
        const dz = to.z - pose.pos.z;
        const dist = Math.hypot(dx, dz, to.y - pose.pos.y);
        if (Math.hypot(dx, dz) > 0.02) pose.yaw = Math.atan2(-dx, -dz);
        if (dist <= left) {
          pose.pos.copy(to);
          left -= dist;
          seg++;
        } else {
          pose.pos.lerp(to, left / dist);
          left = 0;
        }
      }
      return seg >= path.length - 1;
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const liftFront = (stop: number, y: number) => V(STOPS[stop].x + s * (SKY.lift.x - SKY.lift.hx - 1.0), y, STOPS[stop].z);
    const inLift = (stop: number, y: number) => V(STOPS[stop].x + s * SKY.lift.x, y, STOPS[stop].z);
    const psdFront = (stop: number) => V(STOPS[stop].x + s * (SKY.psdX + 0.6), FLOOR, STOPS[stop].z + doorDz);
    const liftAt = (stop: number, y: number) => Math.abs(this.liftY[lift(stop)] - y) < 0.01;
    setPath([liftFront(a, 0)]);

    const update = (dt: number): SkyLinkPose => {
      dt = Math.min(dt, 0.1);
      switch (phase) {
        case 'to-lift':
          // to the lift's door, wait for the car, step in, ride up
          if (walk(dt)) {
            if (!inside && liftAt(a, 0)) {
              inside = true;
              setPath([inLift(a, 0)]);
            } else if (inside) {
              phase = 'lift-up';
              pose.yaw = toTracks;
              this.liftTo[lift(a)] = FLOOR;
            } else pose.yaw = s < 0 ? Math.PI / 2 : -Math.PI / 2;
          }
          break;
        case 'lift-up':
          pose.pos.y = this.liftY[lift(a)];
          if (liftAt(a, FLOOR)) {
            phase = 'to-train';
            setPath([liftFront(a, FLOOR), psdFront(a)]);
          }
          break;
        case 'to-train': {
          // out onto the platform, to the screen door in front of the leading cab's doorway; wait for the train
          const there = walk(dt);
          if (there) pose.yaw = toTracks;
          if (there && L.mode === 'dwell' && L.at === a && L.doors > 0.98) {
            phase = 'board';
            this.claimed[lift(a)] = false;
            setPath([V(L.x + s * 0.7, FLOOR, STOPS[a].z + doorDz), V(L.x, FLOOR, STOPS[a].z + noseDz)]);
          }
          break;
        }
        case 'board':
          if (walk(dt)) {
            phase = 'ride';
            pose.yaw = travelYaw;
            pose.aboard = true;
            // aboard: off it goes (and it's held at the far end until we're off)
            L.holdAt = b;
            L.closeAt = L.t + 0.6;
            this.claimed[lift(b)] = true;
          }
          break;
        case 'ride':
          pose.pos.set(L.x, FLOOR, L.z + noseDz);
          pose.yaw = travelYaw;
          // the far lift comes up to the platform to meet us
          if (L.mode === 'run') this.liftTo[lift(b)] = FLOOR;
          if (L.mode === 'dwell' && L.at === b && L.doors > 0.98) {
            phase = 'alight';
            pose.aboard = false;
            inside = false;
            setPath([V(L.x + s * 0.7, FLOOR, STOPS[b].z + doorDz), psdFront(b), liftFront(b, FLOOR)]);
          }
          break;
        case 'alight':
          if (walk(dt)) {
            if (!inside && liftAt(b, FLOOR)) {
              inside = true;
              setPath([inLift(b, FLOOR)]);
            } else if (inside) {
              phase = 'lift-down';
              pose.yaw = toTracks;
              this.liftTo[lift(b)] = 0;
              // the train's free to go about its business
              L.holdAt = null;
              L.closeAt = L.t + 4;
            }
          }
          break;
        case 'lift-down':
          pose.pos.y = this.liftY[lift(b)];
          if (liftAt(b, 0)) {
            phase = 'out';
            this.claimed[lift(b)] = false;
            const spot = STOPS[b];
            setPath([liftFront(b, 0), V(spot.x, 0, spot.z)]);
          }
          break;
        case 'out':
          if (walk(dt)) {
            phase = 'done';
            pose.done = true;
            // facing the hall's main door: the terminal to the south, the fair to the north
            pose.yaw = b === 1 ? Math.PI : 0;
          }
          break;
        case 'done':
          break;
      }
      pose.phase = phase;
      return pose;
    };
    return { update };
  }
}

// ------------------------------------------------------------------------------------------------
// Instanced parts
// ------------------------------------------------------------------------------------------------

/** A platform screen door leaf: framed glass, 0.8 m wide, from the platform up to the header; origin at its foot's centre. */
function psdLeafGeometry() {
  const k = new Kit();
  k.quad({ x: 0, y: 0.05, z: -DOOR_HALF / 2 }, { x: 0, y: 0.05, z: DOOR_HALF / 2 }, { x: 0, y: 2.2, z: DOOR_HALF / 2 }, { x: 0, y: 2.2, z: -DOOR_HALF / 2 }, '#ffffff');
  // a frosted band at eye height, so the glass reads as a door
  k.quad({ x: 0.012, y: 1.3, z: -DOOR_HALF / 2 + 0.04 }, { x: 0.012, y: 1.3, z: DOOR_HALF / 2 - 0.04 }, { x: 0.012, y: 1.42, z: DOOR_HALF / 2 - 0.04 }, { x: 0.012, y: 1.42, z: -DOOR_HALF / 2 + 0.04 }, '#ffffff');
  k.quad({ x: -0.012, y: 1.3, z: DOOR_HALF / 2 - 0.04 }, { x: -0.012, y: 1.3, z: -DOOR_HALF / 2 + 0.04 }, { x: -0.012, y: 1.42, z: -DOOR_HALF / 2 + 0.04 }, { x: -0.012, y: 1.42, z: DOOR_HALF / 2 - 0.04 }, '#ffffff');
  return k.build();
}

/**
 * A lift car, its floor at the origin, its open front (the doors) facing +x: a steel frame, floor
 * and roof (metal), glass on three sides.
 */
function liftGeometry() {
  const frame = new Kit();
  const glass = new Kit();
  const hx = SKY.lift.hx - 0.15;
  const hz = SKY.lift.hz - 0.15;
  const h = 2.3;
  frame.span(-hx, -0.12, -hz, hx, 0, hz, '#5a6168');
  frame.span(-hx, h, -hz, hx, h + 0.15, hz, '#5a6168');
  frame.glow = 1;
  frame.floor(-0.4, -0.4, 0.4, 0.4, h - 0.01, '#fff3dd', undefined, true);
  frame.glow = 0;
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) frame.span(x - 0.05, 0, z - 0.05, x + 0.05, h, z + 0.05, '#c3c9cf');
  frame.span(-hx + 0.05, 0.95, -hz + 0.02, hx - 0.05, 1.0, -hz + 0.07, '#c3c9cf');
  frame.span(-hx + 0.05, 0.95, hz - 0.07, hx - 0.05, 1.0, hz - 0.02, '#c3c9cf');
  glass.quad({ x: -hx, y: 0, z: hz }, { x: -hx, y: 0, z: -hz }, { x: -hx, y: h, z: -hz }, { x: -hx, y: h, z: hz }, '#ffffff');
  glass.quad({ x: -hx, y: 0, z: -hz }, { x: hx, y: 0, z: -hz }, { x: hx, y: h, z: -hz }, { x: -hx, y: h, z: -hz }, '#ffffff');
  glass.quad({ x: hx, y: 0, z: hz }, { x: -hx, y: 0, z: hz }, { x: -hx, y: h, z: hz }, { x: hx, y: h, z: hz }, '#ffffff');
  return { frame: frame.build(), glass: glass.build() };
}
