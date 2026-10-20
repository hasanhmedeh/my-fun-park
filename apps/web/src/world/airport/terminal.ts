// Funfair International's passenger terminal (XFUN): the building, its halls and gate lounges, the
// six jet bridges out to the stands, the flight boards, and the colliders and spots the visitor and
// the crowd use. The forecourt in front of it is landside.ts; the SkyLink is skylink.ts.
//
// The whole building is a handful of merged meshes (one per material: see terminal-kit.ts), plus
// the six bridges' shared instanced parts. Everything walkable is the ground floor (y = 0); the
// mezzanines, escalators and the bridges' insides are looks, which passengers glide along.

import * as THREE from 'three';
import { A320_POINTS } from '../../aviation/a320';
import { staticCylinder, type Ctx } from '../context';
import { FlightBoards, type FlightRow } from './boards';
import { JetBridge, jetBridgeGroup } from './jet-bridge';
import { buildGates, facadeNumbers } from './terminal-gates';
import { buildInterior, ceilingAt, Placer, type Collision } from './terminal-interior';
import { blockCollider, Kit, kitMaterials, kitMesh, setKitNight, wallCollider, type KitMaterials, type V2, type WalkRect } from './terminal-kit';
import { AIR_Z, COLUMNS, DOORS, GATES, GATE_DESK_SPOT, KERB_COLUMNS, LAND_Z, MEZZ_COLUMNS, SKYLINK_POINT, skylinkSpot, TERM, UNITS, WALK } from './terminal-plan';
import { buildShell, roofMeshes, shellWalls, type TerminalKits } from './terminal-shell';
import { signAtlas, type SignAtlas } from './terminal-signs';

export type { FlightRow, V2, WalkRect };
export { JetBridge };

/** Beyond this distance the furniture, screens and signs inside are hidden (only the shell shows). */
const DETAIL_RANGE = 1100;
/** Beyond this the whole terminal is hidden (from the island, or high over the sea). */
const DRAW_RANGE = 22000;

export interface TerminalSpots {
  /** Outside each landside door, on the kerb walk. */
  entrance: V2[];
  /** Desk fronts at check-in (where a passenger stands at the counter). */
  checkIn: V2[];
  /** Security lanes' entries (in front of each lane's divest tables). */
  security: V2[];
  /** Browse points: in front of shelves, counters and display tables. */
  shops: V2[];
  /** The seats in each gate's lounge (1..6), each with the yaw a sitter faces (park convention). */
  gateSeats: Record<number, (V2 & { yaw: number })[]>;
  /** Gate 3's desk, where the visitor books and boards FA101 (= AIRPORT_SPOTS.home.gateDesk). */
  gateDesk: V2;
  /** Gate 3: from the desk, through the boarding door, to the foot of the escalator up to the bridge (in order). */
  boardingQueue: V2[];
  /** From the foot of gate 3's escalator (where the bridge's walk comes down) to the arrivals hall. */
  arrivalsPath: V2[];
  /** Where the visitor stands to take the SkyLink: the middle of the airport station's hall, between its lifts (= SkyLink.stations.airport). */
  skylink: V2;
  /** Where people linger in the public hall (the meeting point, under the boards). */
  hall: V2[];
}

export class HomeTerminal {
  readonly group = new THREE.Group();
  /** Where the visitor may walk (y = 0): the forecourt and the terminal's floor. Walls inside are colliders. */
  readonly walk: WalkRect[] = WALK.map((r) => ({ ...r }));
  /** The jet bridges by stand id, 'S1'..'S6' (all parked to start with). */
  readonly bridges: Record<string, JetBridge> = {};
  readonly spots: TerminalSpots;
  private readonly boards: FlightBoards;
  private readonly mats: KitMaterials;
  private readonly atlas: SignAtlas;
  /** What's hidden from afar. */
  private readonly detail: THREE.Object3D[] = [];
  private readonly centre = new THREE.Vector3((TERM.x0 + TERM.x1) / 2, 10, (TERM.z0 + TERM.z1) / 2);
  private readonly bridgeList: JetBridge[] = [];
  private night = -1;

  constructor(ctx: Ctx) {
    this.group.name = 'home-terminal';
    this.mats = kitMaterials(ctx);
    this.atlas = signAtlas(ctx);
    this.boards = new FlightBoards(ctx.renderer, { airport: 'Funfair International', airline: 'Funfair Air', gates: GATES.map((g) => g.gate) });
    const k: TerminalKits = {
      interior: new Kit(),
      exterior: new Kit(),
      metal: new Kit(),
      floor: new Kit(),
      glass: new Kit(),
      emitter: new Kit(),
      signs: new Kit(),
      screens: new Kit(),
    };
    const col: Collision = { blocks: [], walls: [], cylinders: [] };
    const place = new Placer();

    buildShell(k);
    const gates = buildGates(ctx, k, this.boards, col, place);
    const inside = buildInterior(ctx, k, this.boards, col, place);
    facadeNumbers(ctx, k);

    // the meshes: one per material
    const sh = ctx.quality.shadows;
    const m = this.mats;
    const roof = roofMeshes(m, sh);
    const meshes = {
      interior: kitMesh(k.interior, m.interior, false, false),
      exterior: kitMesh(k.exterior, m.structure, sh, sh),
      metal: kitMesh(k.metal, m.metal, sh, false),
      floor: kitMesh(k.floor, m.floor, false, false),
      glass: kitMesh(k.glass, m.glass),
      emitter: kitMesh(k.emitter, m.emitter),
      signs: kitMesh(k.signs, this.atlas.material),
      screens: kitMesh(k.screens, this.boards.material),
    };
    // the glass draws after everything solid inside it
    meshes.glass.renderOrder = 2;
    this.group.add(roof.top, roof.ceiling, ...Object.values(meshes));
    this.detail.push(meshes.interior, meshes.screens, meshes.emitter);
    this.group.add(jetBridgeGroup(ctx));

    // the jet bridges, one per stand, from each gate's rotunda to the parked aircraft's door L1
    for (const g of GATES) {
      const door = { x: g.stand.doorL1.x, y: A320_POINTS.doorL1.y, z: g.stand.doorL1.z };
      const bridge = new JetBridge(ctx, { rotunda: g.rotunda, door, entry: gates.entries[g.gate] });
      this.bridges[g.stand.id] = bridge;
      this.bridgeList.push(bridge);
    }

    this.colliders(ctx, col);

    this.spots = {
      entrance: DOORS.map((d) => ({ x: d.x, z: LAND_Z - 1.6 })),
      checkIn: inside.checkIn,
      security: inside.security,
      shops: inside.shops,
      gateSeats: gates.seats,
      gateDesk: { x: GATE_DESK_SPOT.x, z: GATE_DESK_SPOT.z },
      boardingQueue: gates.boardingQueue,
      arrivalsPath: gates.arrivalsPath,
      skylink: skylinkSpot(SKYLINK_POINT),
      hall: inside.hall,
    };
    this.setNight(0);
  }

  private colliders(ctx: Ctx, col: Collision) {
    for (const w of shellWalls()) wallCollider(ctx, w.x0, w.z0, w.x1, w.z1, w.h, 0.4);
    for (const w of col.walls) wallCollider(ctx, w.x0, w.z0, w.x1, w.z1, w.h, 0.3);
    for (const b of col.blocks) blockCollider(ctx, b.x0, b.z0, b.x1, b.z1, b.h);
    for (const c of col.cylinders) staticCylinder(ctx, c.x, c.z, c.r, c.h);
    // the columns: the roof's trees, the kerb's, the slim ones under the mezzanines
    for (const c of COLUMNS) staticCylinder(ctx, c.x, c.z, 0.6, 4);
    for (const c of KERB_COLUMNS) staticCylinder(ctx, c.x, c.z, 0.45, 4);
    for (const c of MEZZ_COLUMNS) {
      if (UNITS.some((u) => c.x > u.x0 - 0.5 && c.x < u.x1 + 0.5 && c.z > u.z0 - 0.5 && c.z < u.z1 + 0.5)) continue;
      staticCylinder(ctx, c.x, c.z, 0.3, 4);
    }
  }

  /**
   * Updates the boards: `departures` on every departures board and the gate screens (each gate
   * shows its next flight that hasn't left); `arrivals`, when given, on the arrivals boards.
   */
  setFlights(departures: FlightRow[], arrivals?: FlightRow[]) {
    this.boards.setDepartures(departures);
    if (arrivals) this.boards.setArrivals(arrivals);
  }

  /** 0 by day .. 1 at night: the hall lights, the signs, the boards and the lit glass. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 1e-3) return;
    this.night = k;
    setKitNight(this.mats, k);
    this.atlas.setNight(k);
    this.boards.setNight(k);
  }

  update(dt: number, _t: number, camera: THREE.Camera) {
    for (const b of this.bridgeList) b.update(dt);
    const d = camera.position.distanceTo(this.centre);
    this.group.visible = d < DRAW_RANGE;
    const near = d < DETAIL_RANGE;
    for (const o of this.detail) o.visible = near;
  }

  /** True if (x, z) is inside the building (between its facades). */
  inside(p: THREE.Vector3Like) {
    return p.x > TERM.x0 && p.x < TERM.x1 && p.z > LAND_Z && p.z < AIR_Z;
  }

  /**
   * Inside the building, the follow camera stays within its facades and under whatever is
   * overhead (the roof, or a mezzanine): it slides in along its line to `target` (a spring arm).
   */
  clampCamera(target: THREE.Vector3, v: THREE.Vector3) {
    const pad = 0.6;
    let t = 1;
    const lim: [number, number, number, number][] = [
      [target.x, v.x, TERM.x0 + pad, TERM.x1 - pad],
      [target.z, v.z, LAND_Z + pad, AIR_Z - pad],
    ];
    for (const [from, to, lo, hi] of lim) {
      if (to < lo) t = Math.min(t, (lo - from) / (to - from));
      if (to > hi) t = Math.min(t, (hi - from) / (to - from));
    }
    const top = Math.min(ceilingAt(target.x, target.z), ceilingAt(v.x, v.z)) - 0.5;
    if (v.y > top && v.y > target.y) t = Math.min(t, (top - target.y) / (v.y - target.y));
    if (t < 1) v.lerpVectors(target, v, Math.max(0, t));
  }
}
