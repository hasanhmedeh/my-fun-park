// Funfair International's landside: the airport's access road (a dual carriageway running east and
// west out of the scene), the link roads down to the terminal's kerb, the kerb road with its
// drop-off lane, taxi rank and bus stop, the surface car park and the multi-storey car park, the
// plaza under the SkyLink between them, street lights, signs, and the traffic: cars, taxis and
// buses driving the loop (stopping at the kerb, and for the visitor at the crossings) and the cars
// parked in the car parks.
//
// Like the terminal it is a few merged meshes (terminal-kit.ts) plus two instanced fleets (cars,
// buses); the moving vehicles are the first instances of each, so only they are re-uploaded.

import * as THREE from 'three';
import { staticCylinder, type Ctx } from '../context';
import { blockCollider, Kit, kitMaterials, kitMesh, seeded, setKitNight, type KitMaterials, type V2 } from './terminal-kit';
import { ACCESS_ROAD, CAR_PARK, GARAGE, KERB_ROAD, LINK_ROADS, SKYLINK_POINT, STATION } from './terminal-plan';
import { lettering, signAtlas, wayfinding, type PaintedSign, type SignAtlas } from './terminal-signs';

/** Road surface heights: asphalt a little above the grass, paint a little above that (plus polygon offset). */
const ROAD_Y = 0.03;
const PAINT_Y = 0.045;
const KERB_H = 0.14;

const ASPHALT = '#4a4d52';
const ASPHALT_LIGHT = '#5a5d62';
const PAVING = '#c9c4ba';
const CONCRETE = '#b9b5ad';
const WHITE = '#f2f2ee';
const YELLOW = '#f2c21a';

const CAR_COLOURS = ['#f4f4f2', '#1d1f22', '#8d939a', '#c9cdd1', '#2f4f7a', '#8a1c25', '#3b4a3a', '#5a5f66', '#e8e2d4', '#24324d', '#b23a2a', '#d9d9d6'];
const TAXI = '#f2c21a';

// ------------------------------------------------------------------------------------------------
// Vehicle geometry (one merged geometry each; the paint comes from the instance's colour)
// ------------------------------------------------------------------------------------------------

/** A saloon, origin on the ground at its centre, facing −z: 4.5 m long. Cheap (a few boxes): there are hundreds. */
function carGeometry() {
  const k = new Kit();
  // body (white: the instance colour paints it), cabin glass, wheels, lights
  k.box(0, 0.62, 0, 1.78, 0.62, 4.5, '#ffffff');
  k.box(0, 1.17, 0.25, 1.58, 0.5, 2.3, '#ffffff');
  k.box(0, 1.17, 0.25, 1.62, 0.42, 2.1, '#262b31');
  k.box(0, 0.33, -1.42, 1.84, 0.62, 0.66, '#151515');
  k.box(0, 0.33, 1.42, 1.84, 0.62, 0.66, '#151515');
  k.glow = 1;
  k.panel(0, 0.72, -2.255, 1.5, 0.14, 0, '#fff6e0');
  k.glow = 0.35;
  k.panel(0, 0.78, 2.255, 1.5, 0.12, Math.PI, '#ff2a2a');
  k.glow = 0;
  return k.build();
}

/** A bus, origin on the ground at its centre, facing −z: 12 m long, a lit window band. */
function busGeometry() {
  const k = new Kit();
  k.box(0, 1.75, 0, 2.55, 2.7, 12, '#ffffff');
  k.box(0, 3.15, 0, 2.3, 0.15, 10, '#d9dde2');
  k.glow = 0.7;
  k.box(0, 2.15, 0.4, 2.57, 1.15, 10.6, '#2a3038');
  k.box(0, 1.95, -6.0, 2.3, 1.6, 0.02, '#2a3038');
  k.glow = 0;
  k.box(0, 0.42, -3.8, 2.6, 0.84, 1.0, '#151515');
  k.box(0, 0.42, 4.0, 2.6, 0.84, 1.0, '#151515');
  k.glow = 1;
  k.panel(0, 0.75, -6.01, 2.0, 0.16, 0, '#fff6e0');
  k.glow = 0.35;
  k.panel(0, 0.8, 6.01, 2.0, 0.16, Math.PI, '#ff2a2a');
  k.glow = 0;
  return k.build();
}

// ------------------------------------------------------------------------------------------------
// The traffic's routes
// ------------------------------------------------------------------------------------------------

/** A polyline with rounded corners, sampled every metre or so, with headings, for vehicles to run along. */
class Route {
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly s: number[] = [];
  /** The speed limit at each sample (m/s): lower round the bends. */
  readonly v: number[] = [];
  readonly length: number;

  constructor(points: V2[], speed: number, radius = 9) {
    const push = (x: number, z: number, v: number) => {
      const n = this.x.length;
      const d = n ? Math.hypot(x - this.x[n - 1], z - this.z[n - 1]) : 0;
      if (n && d < 0.05) return;
      this.x.push(x);
      this.z.push(z);
      this.s.push(n ? this.s[n - 1] + d : 0);
      this.v.push(v);
    };
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0 || i === points.length - 1) {
        if (i > 0) this.line(this.x[this.x.length - 1], this.z[this.z.length - 1], p.x, p.z, speed, push);
        else push(p.x, p.z, speed);
        continue;
      }
      // a bend: straight up to where its arc starts, the arc, on to the next
      const a = points[i - 1];
      const b = points[i + 1];
      const l1 = Math.hypot(p.x - a.x, p.z - a.z);
      const l2 = Math.hypot(b.x - p.x, b.z - p.z);
      const r = Math.min(radius, l1 * 0.45, l2 * 0.45);
      const ax = p.x + ((a.x - p.x) / l1) * r;
      const az = p.z + ((a.z - p.z) / l1) * r;
      const bx = p.x + ((b.x - p.x) / l2) * r;
      const bz = p.z + ((b.z - p.z) / l2) * r;
      this.line(this.x[this.x.length - 1], this.z[this.z.length - 1], ax, az, speed, push);
      const turnV = Math.min(speed, 5.5);
      for (let t = 0.1; t <= 1.0001; t += 0.1) {
        // a quadratic bezier through the corner, close enough to an arc
        const u = 1 - t;
        push(u * u * ax + 2 * u * t * p.x + t * t * bx, u * u * az + 2 * u * t * p.z + t * t * bz, turnV);
      }
    }
    this.length = this.s[this.s.length - 1];
    // ease the limits so vehicles brake before a bend and pick up after it
    for (let pass = 0; pass < 2; pass++)
      for (let i = this.v.length - 2; i >= 0; i--) {
        const ds = this.s[i + 1] - this.s[i];
        this.v[i] = Math.min(this.v[i], Math.sqrt(this.v[i + 1] ** 2 + 2 * 2.2 * ds));
      }
  }

  private line(x0: number, z0: number, x1: number, z1: number, v: number, push: (x: number, z: number, v: number) => void) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4));
    for (let i = 1; i <= n; i++) push(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n, v);
  }

  /** The sample index at or before distance s (walking from `hint`, which is where this vehicle was last frame). */
  index(s: number, hint: number) {
    let i = Math.min(Math.max(0, hint), this.s.length - 2);
    while (i > 0 && this.s[i] > s) i--;
    while (i < this.s.length - 2 && this.s[i + 1] <= s) i++;
    return i;
  }
}

interface Vehicle {
  route: Route;
  s: number;
  v: number;
  /** Where on the route it last was (sample index), its cruising speed factor, and its stop (if any). */
  i: number;
  pace: number;
  stopAt: number;
  stopFor: number;
  stopped: number;
  bus: boolean;
  slot: number;
  /** The vehicle ahead on the same route (its gap is kept). */
  ahead: Vehicle | null;
}

// ------------------------------------------------------------------------------------------------
// Landside
// ------------------------------------------------------------------------------------------------

export class Landside {
  readonly group = new THREE.Group();
  /** The visitor, when walking about here: vehicles stop for them at the crossings and in the car parks. */
  visitor: THREE.Vector3Like | null = null;
  private readonly mats: KitMaterials;
  private readonly atlas: SignAtlas;
  private readonly cars: THREE.InstancedMesh;
  private readonly buses: THREE.InstancedMesh;
  private readonly vehicles: Vehicle[] = [];
  private readonly movingCars: number;
  private readonly movingBuses: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly centre = new THREE.Vector3(0, 0, 360);
  private night = -1;

  constructor(ctx: Ctx) {
    this.group.name = 'landside';
    this.mats = kitMaterials(ctx);
    this.atlas = signAtlas(ctx);
    const k = { paving: new Kit(), marking: new Kit(), structure: new Kit(), metal: new Kit(), glass: new Kit(), emitter: new Kit(), signs: new Kit(), pool: new Kit() };
    const rnd = seeded(2024);

    this.roads(k);
    this.kerbside(k);
    const parked = this.carPark(ctx, k, rnd);
    const garageCars = this.garage(ctx, k, rnd);
    this.plaza(ctx, k, rnd);
    this.lights(ctx, k);
    this.signage(k);

    const sh = ctx.quality.shadows;
    const m = this.mats;
    const meshes = [
      kitMesh(k.paving, m.paving, false, sh),
      kitMesh(k.marking, m.marking, false, sh),
      kitMesh(k.structure, m.structure, sh, sh),
      kitMesh(k.metal, m.metal, sh, false),
      kitMesh(k.glass, m.glass),
      kitMesh(k.emitter, m.emitter),
      kitMesh(k.signs, this.atlas.material),
      kitMesh(k.pool, m.pool),
    ];
    meshes[4].renderOrder = 2;
    meshes[7].renderOrder = 1;
    this.group.add(...meshes);

    // the traffic: routes round the loop, vehicles spaced along them
    const routes = this.routes();
    const spawn = (route: Route, n: number, bus: boolean, stops: { from: number; to: number; p: number; dwell: [number, number] } | null) => {
      const list: Vehicle[] = [];
      for (let i = 0; i < n; i++) {
        const s = (route.length * (i + rnd() * 0.4)) / n;
        let stopAt = -1;
        if (stops && rnd() < stops.p) stopAt = stops.from + rnd() * (stops.to - stops.from);
        list.push({ route, s, v: 0, i: 0, pace: 0.85 + rnd() * 0.25, stopAt, stopFor: stops ? stops.dwell[0] + rnd() * (stops.dwell[1] - stops.dwell[0]) : 0, stopped: 0, bus, slot: 0, ahead: null });
      }
      list.sort((a, b) => a.s - b.s);
      list.forEach((v, i) => (v.ahead = list.length > 1 ? list[(i + 1) % list.length] : null));
      this.vehicles.push(...list);
    };
    const kerbFrom = routes.kerbStart + 40;
    spawn(routes.through, 14, false, null);
    spawn(routes.westbound, 14, false, null);
    spawn(routes.dropOff, 12, false, { from: kerbFrom, to: kerbFrom + 300, p: 0.75, dwell: [6, 16] });
    spawn(routes.kerb, 8, false, null);
    spawn(routes.busLoop, 3, true, { from: routes.busStop, to: routes.busStop + 0.01, p: 1, dwell: [14, 22] });

    let carSlot = 0;
    let busSlot = 0;
    for (const v of this.vehicles) v.slot = v.bus ? busSlot++ : carSlot++;
    this.movingCars = carSlot;
    this.movingBuses = busSlot;

    // the fleets: the moving vehicles first, then the parked ones (set once)
    const fleetMat = m.metal;
    const allParked = [...parked.cars, ...garageCars];
    this.cars = new THREE.InstancedMesh(carGeometry(), fleetMat, carSlot + allParked.length);
    this.buses = new THREE.InstancedMesh(busGeometry(), fleetMat, busSlot + parked.buses.length);
    for (const mesh of [this.cars, this.buses]) {
      mesh.castShadow = sh;
      mesh.receiveShadow = sh;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    const c = new THREE.Color();
    for (const v of this.vehicles) {
      if (v.bus) this.buses.setColorAt(v.slot, c.set(['#2ec4b6', '#ff4d6d', '#f4f2ee'][v.slot % 3]));
      else this.cars.setColorAt(v.slot, c.set(v.route === routes.kerb && v.slot % 2 === 0 ? TAXI : CAR_COLOURS[Math.floor(rnd() * CAR_COLOURS.length)]));
    }
    allParked.forEach((pc, i) => {
      this.place(this.cars, carSlot + i, pc.x, pc.y, pc.z, pc.heading);
      this.cars.setColorAt(carSlot + i, c.set(pc.taxi ? TAXI : CAR_COLOURS[Math.floor(rnd() * CAR_COLOURS.length)]));
    });
    parked.buses.forEach((pb, i) => {
      this.place(this.buses, busSlot + i, pb.x, 0, pb.z, pb.heading);
      this.buses.setColorAt(busSlot + i, c.set('#5a8dee'));
    });
    this.group.add(this.cars, this.buses);
    this.step(0);
    this.cars.instanceMatrix.needsUpdate = true;
    this.buses.instanceMatrix.needsUpdate = true;
  }

  // ----------------------------------------------------------------------------------------------
  // Roads
  // ----------------------------------------------------------------------------------------------

  /** Paint dashes along a line (dash, gap in metres). */
  private dashes(k: Kit, x0: number, z0: number, x1: number, z1: number, w: number, dash: number, gap: number, colour = WHITE) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    for (let s = 0; s + dash <= len; s += dash + gap) this.rect(k, x0 + ux * s, z0 + uz * s, x0 + ux * (s + dash), z0 + uz * (s + dash), w, colour);
  }

  /** A painted stripe from a to b, `w` wide, facing up. */
  private rect(k: Kit, x0: number, z0: number, x1: number, z1: number, w: number, colour: string) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const nx = (-(z1 - z0) / len) * (w / 2);
    const nz = ((x1 - x0) / len) * (w / 2);
    const y = PAINT_Y;
    const a = { x: x0 - nx, y, z: z0 - nz };
    const b = { x: x1 - nx, y, z: z1 - nz };
    const c = { x: x1 + nx, y, z: z1 + nz };
    const d = { x: x0 + nx, y, z: z0 + nz };
    // wind so the face is up whichever way the stripe runs
    const up = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x) < 0;
    if (up) k.quad(a, b, c, d, colour);
    else k.quad(a, d, c, b, colour);
  }

  /** An upward-facing rectangle of surface (x0..x1, z0..z1). */
  private area(k: Kit, x0: number, z0: number, x1: number, z1: number, y: number, colour: string) {
    k.floor(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), y, colour);
  }

  private roads(k: Record<string, Kit>) {
    const A = ACCESS_ROAD;
    const L = LINK_ROADS;
    const P = k.paving;
    const M = k.marking;
    const from = P.vertexCount;
    // the access road: two carriageways with a grass-free median and hard shoulders
    this.area(P, A.x0, A.z - A.half, A.x1, A.z + A.half, ROAD_Y, ASPHALT);
    k.structure.span(A.x0, 0, A.z - 1.0, A.x1, 0.2, A.z + 1.0, CONCRETE);
    // edge lines, lane dashes, the median's lines
    for (const z of [A.z - A.half + 0.4, A.z + A.half - 0.4, A.z - 1.25, A.z + 1.25]) this.rect(M, A.x0, z, A.x1, z, 0.15, WHITE);
    for (const z of [A.z - 5.2, A.z + 5.2]) this.dashes(M, A.x0, z, A.x1, z, 0.13, 3, 9);
    // the link roads down to the kerb (west: southbound, east: northbound), with their joins to the access road
    for (const x of [L.west, L.east]) {
      this.area(P, x - L.half, A.z + A.half - 0.5, x + L.half, KERB_ROAD.z1, ROAD_Y + 0.001, ASPHALT_LIGHT);
      for (const s of [-1, 1]) this.rect(M, x + s * (L.half - 0.3), A.z + A.half + 6, x + s * (L.half - 0.3), KERB_ROAD.z0 - 4, 0.13, WHITE);
      // kerbs alongside
      for (const s of [-1, 1]) k.structure.span(x + s * L.half - 0.15, 0, A.z + A.half + 4, x + s * L.half + 0.15, KERB_H, KERB_ROAD.z0 - 5, CONCRETE);
    }
    // the kerb road, one way eastbound: drop-off lane by the kerb, through lane, outer lane
    const K = KERB_ROAD;
    this.area(P, K.x0 - 12, K.z0, K.x1 + 12, K.z1, ROAD_Y + 0.002, ASPHALT);
    this.rect(M, K.x0, K.z0 + 0.35, K.x1, K.z0 + 0.35, 0.15, WHITE);
    this.dashes(M, K.x0, K.z0 + 4, K.x1, K.z0 + 4, 0.13, 3, 6);
    this.dashes(M, K.x0, K.z0 + 8, K.x1, K.z0 + 8, 0.25, 1, 1);
    // the drop-off lane's words, the taxi rank's yellow box, the bus stop's
    const dropX = [-60, 40, 120, 200];
    for (const x of dropX) this.words(k.signs, 'DROP-OFF', x, K.z0 + 10, 0.9);
    this.rect(M, -205, K.z1 - 0.35, -110, K.z1 - 0.35, 0.3, YELLOW);
    this.dashes(M, -205, K.z1 - 3.4, -110, K.z1 - 3.4, 0.2, 1.5, 1.5, YELLOW);
    this.words(k.signs, 'TAXI', -160, K.z0 + 10, 1.0, YELLOW);
    this.rect(M, -40, K.z1 - 0.35, 0, K.z1 - 0.35, 0.3, YELLOW);
    this.words(k.signs, 'BUS', -20, K.z0 + 10, 1.0, YELLOW);
    // zebra crossings to the SkyLink station and the car parks
    for (const x of [SKYLINK_POINT.x, -110, 154]) for (let z = K.z0 + 0.8; z < K.z1 - 0.5; z += 1.0) this.rect(M, x - 2.2, z + 0.25, x + 2.2, z + 0.25, 0.5, WHITE);
    // arrows on the kerb road
    for (const x of [-220, -40, 80, 220]) this.arrow(M, x, K.z0 + 2, 1);
    P.worldUvXZ(from, 6);
  }

  /** Painted lettering on the road, read by drivers heading east. */
  private words(k: Kit, text: string, x: number, z: number, h: number, colour = WHITE) {
    const s = lettering(this.atlas, text, { fg: colour, bg: '#4a4d52', height: 96, font: `800 64px "DM Sans", system-ui, sans-serif` });
    // stretched along the direction of travel, as road markings are, lying flat
    const w = h * s.aspect * 0.55;
    const y = PAINT_Y + 0.004;
    k.quad({ x: x + h * 1.6, y, z: z - w / 2 }, { x: x + h * 1.6, y, z: z + w / 2 }, { x: x - h * 1.6, y, z: z + w / 2 }, { x: x - h * 1.6, y, z: z - w / 2 }, '#ffffff', s.uv);
  }

  /** A painted straight-ahead arrow pointing along +x (dir 1) or −x. */
  private arrow(k: Kit, x: number, z: number, dir: number) {
    this.rect(k, x - dir * 2.5, z, x + dir * 1.2, z, 0.18, WHITE);
    const y = PAINT_Y;
    const tip = { x: x + dir * 2.6, y, z };
    const l = { x: x + dir * 1.1, y, z: z - 0.6 };
    const r = { x: x + dir * 1.1, y, z: z + 0.6 };
    if (dir > 0) k.quad(l, r, tip, tip, WHITE);
    else k.quad(r, l, tip, tip, WHITE);
  }

  /** The kerb walk's furniture beyond the terminal's: the bus shelter, the taxi rank's sign, benches, planters. */
  private kerbside(k: Record<string, Kit>) {
    const K = KERB_ROAD;
    const z = K.z1 + 2.2;
    // the bus shelter: a glass box with a canopy, a timetable panel, a bench
    k.metal.span(-34, KERB_H, z - 0.05, -6, 2.6, z + 0.05, '#3a3f45');
    k.glass.span(-33.9, KERB_H + 0.1, z + 0.1, -6.1, 2.5, z + 0.15, '#ffffff');
    k.structure.span(-35, 2.6, z - 1.6, -5, 2.8, z + 0.4, '#e9ecef');
    for (const x of [-34, -20, -6]) k.metal.cyl(x, KERB_H, z - 1.4, 0.06, 0.06, 2.5, '#3a3f45', 6);
    k.structure.span(-30, 0.4, z - 0.5, -10, 0.48, z, '#c9a27a');
    this.totem(k, wayfinding(this.atlas, ['bus', 'Buses · Coaches'], { location: true, height: 80 }), -38, z - 1.2, 0.55, 3.2);
    this.totem(k, wayfinding(this.atlas, ['taxi', 'Taxis'], { location: true, height: 80 }), -112, z - 1.2, 0.55, 3.2);
    this.totem(k, wayfinding(this.atlas, ['train', 'SkyLink ↔ the Fair'], { location: true, height: 80 }), SKYLINK_POINT.x - 4, K.z0 - 2.4, 0.55, 3.2);
  }

  /** A sign on a post, both faces. */
  private totem(k: Record<string, Kit>, s: PaintedSign, x: number, z: number, h: number, top: number) {
    const w = h * s.aspect;
    k.metal.cyl(x, 0, z, 0.06, 0.06, top, '#3a3f45', 6);
    k.metal.box(x, top - h / 2, z, w + 0.08, h + 0.08, 0.06, '#24272d');
    k.signs.panel(x, top - h / 2, z - 0.035, w, h, 0, '#ffffff', s.uv);
    k.signs.panel(x, top - h / 2, z + 0.035, w, h, Math.PI, '#ffffff', s.uv);
  }

  // ----------------------------------------------------------------------------------------------
  // Car parks
  // ----------------------------------------------------------------------------------------------

  /** The surface car park: rows of bays either side of aisles, trees between the double rows, some cars. */
  private carPark(ctx: Ctx, k: Record<string, Kit>, rnd: () => number) {
    const C = CAR_PARK;
    const cars: { x: number; y: number; z: number; heading: number; taxi: boolean }[] = [];
    const buses: { x: number; z: number; heading: number }[] = [];
    this.area(k.paving, C.x0, C.z0, C.x1, C.z1, ROAD_Y, '#55585d');
    k.paving.worldUvXZ(k.paving.vertexCount - 4, 6);
    // the kerb round it
    for (const [x0, z0, x1, z1] of [
      [C.x0, C.z0, C.x1, C.z0],
      [C.x0, C.z1, C.x1, C.z1],
      [C.x0, C.z0, C.x0, C.z1],
      [C.x1, C.z0, C.x1, C.z1],
    ])
      k.structure.span(Math.min(x0, x1) - 0.15, 0, Math.min(z0, z1) - 0.15, Math.max(x0, x1) + 0.15, KERB_H, Math.max(z0, z1) + 0.15, CONCRETE);
    // double rows of bays (5 m deep, 2.5 m wide) facing each other across 6.5 m aisles
    const bay = 2.5;
    const depth = 5;
    const aisle = 6.5;
    let z = C.z0 + 3;
    const xa = C.x0 + 8;
    const xb = C.x1 - 8;
    while (z + depth * 2 + aisle < C.z1 - 3) {
      // a row facing north, an aisle, a row facing south... arranged as: bays | aisle | bays | island
      const rows = [
        { z0: z, z1: z + depth, heading: 0 },
        { z0: z + depth + aisle, z1: z + 2 * depth + aisle, heading: 180 },
      ];
      for (const r of rows) {
        let run: number[] = [];
        const flush = () => {
          if (run.length) blockCollider(ctx, run[0] - bay / 2 + 0.3, r.z0 + 0.3, run[run.length - 1] + bay / 2 - 0.3, r.z1 - 0.3, 1.5);
          run = [];
        };
        for (let x = xa; x + bay <= xb; x += bay) {
          // the bay's dividing line
          this.rect(k.marking, x, r.z0, x, r.z1, 0.12, WHITE);
          const cx = x + bay / 2;
          if (rnd() < 0.62) {
            // parked nose-in, a little off-centre
            const h = r.heading === 0 ? 0 : 180;
            const cz = (r.z0 + r.z1) / 2 + (h === 0 ? 0.25 : -0.25);
            cars.push({ x: cx + (rnd() - 0.5) * 0.3, y: 0, z: cz, heading: h + (rnd() - 0.5) * 4, taxi: false });
            run.push(cx);
          } else flush();
        }
        flush();
      }
      // the island between this double row and the next: kerbed, trees, lamp posts
      const iz0 = z + 2 * depth + aisle;
      const iz1 = iz0 + 2.4;
      if (iz1 < C.z1 - 6) {
        k.structure.span(xa, 0, iz0, xb, 0.16, iz1, '#7a9a58');
        for (let x = xa + 6; x < xb - 4; x += 14) this.tree(k, x + (rnd() - 0.5) * 2, (iz0 + iz1) / 2, rnd, 0.8);
      }
      z = iz1 + aisle;
    }
    // the entrance from the west link road, the ticket barrier and its kiosk
    const ez = (C.z0 + C.z1) / 2;
    this.area(k.paving, LINK_ROADS.west + LINK_ROADS.half, ez - 4, C.x0, ez + 4, ROAD_Y + 0.001, ASPHALT_LIGHT);
    k.structure.span(C.x0 + 2, 0, ez - 0.4, C.x0 + 3.2, 1.3, ez + 0.4, '#e9ecef');
    k.metal.span(C.x0 + 3.2, 0.95, ez - 0.04, C.x0 + 6.5, 1.0, ez + 0.04, '#ff4d6d');
    // coaches parked along the car park's north edge
    for (let i = 0; i < 3; i++) buses.push({ x: C.x0 + 40 + i * 16, z: C.z0 - 4.5, heading: 90 });
    return { cars, buses };
  }

  /** The multi-storey car park: four decks on columns, spandrel panels, stair cores, ramps, cars on every level. */
  private garage(ctx: Ctx, k: Record<string, Kit>, rnd: () => number) {
    const G = GARAGE;
    const cars: { x: number; y: number; z: number; heading: number; taxi: boolean }[] = [];
    const s = k.structure;
    const top = G.levels * G.storey;
    // the decks (each a slab with its underside), the roof deck's parapet
    for (let l = 1; l <= G.levels; l++) {
      const y = l * G.storey;
      s.span(G.x0, y - 0.35, G.z0, G.x1, y, G.z1, '#c8c4bb');
      // the spandrel: a precast band round each deck's edge, the fair's colour stripe on it
      for (const [x0, z0, x1, z1] of [
        [G.x0 - 0.2, G.z0 - 0.2, G.x1 + 0.2, G.z0],
        [G.x0 - 0.2, G.z1, G.x1 + 0.2, G.z1 + 0.2],
        [G.x0 - 0.2, G.z0, G.x0, G.z1],
        [G.x1, G.z0, G.x1 + 0.2, G.z1],
      ])
        s.span(x0, y, z0, x1, y + 1.05, z1, '#e4e1da');
      s.span(G.x0 - 0.22, y + 0.75, G.z0 - 0.22, G.x1 + 0.22, y + 0.9, G.z0 - 0.2, ['#7b5cd6', '#2ec4b6', '#ffc23d', '#ff4d6d'][l - 1]);
      // lamp strips under each deck, lit at night
      if (l < G.levels + 1) for (let x = G.x0 + 8; x < G.x1 - 4; x += 16) k.emitter.floor(x - 2, G.z0 + 10, x + 2, G.z0 + 10.3, y - 0.36, '#fff1d6', undefined, true);
    }
    // the ground floor's slab, columns on a grid, the stair cores at the corners with the "P"
    this.area(k.paving, G.x0, G.z0, G.x1, G.z1, ROAD_Y + 0.001, '#6a6d72');
    for (let x = G.x0 + 0.5; x <= G.x1 - 0.4; x += 16.8) for (let z = G.z0 + 0.5; z <= G.z1 - 0.4; z += 16.6) s.span(x - 0.3, 0, z - 0.3, x + 0.3, top, z + 0.3, '#d9d6cf');
    const P = wayfinding(this.atlas, ['parking'], { location: true, height: 128 });
    for (const [cx, cz] of [
      [G.x0 + 4, G.z1 + 3],
      [G.x1 - 4, G.z1 + 3],
    ]) {
      s.span(cx - 3.5, 0, cz - 3, cx + 3.5, top + 3, cz + 3, '#3a3f45');
      k.glass.span(cx - 3.3, 0.2, cz + 3.01, cx + 3.3, top + 2.6, cz + 3.05, '#ffffff');
      k.signs.panel(cx, top + 1.2, cz + 3.08, 2.4, 2.4, Math.PI, '#ffffff', P.uv);
      blockCollider(ctx, cx - 3.5, cz - 3, cx + 3.5, cz + 3, 4);
    }
    // the ramps' looks, at the west end: sloped slabs between the decks
    for (let l = 0; l < G.levels; l++) {
      const y0 = l * G.storey;
      const y1 = y0 + G.storey;
      s.quad({ x: G.x0 + 2, y: y0 + 0.05, z: G.z1 - 2 }, { x: G.x0 + 9, y: y0 + 0.05, z: G.z1 - 2 }, { x: G.x0 + 9, y: y1 - 0.3, z: G.z1 - 34 }, { x: G.x0 + 2, y: y1 - 0.3, z: G.z1 - 34 }, '#b9b5ad');
    }
    // the garage's name along the top, both long sides
    const name = lettering(this.atlas, 'Car Park P2', { fg: '#ffffff', bg: '#1d1238', height: 96 });
    for (const [z, f] of [
      [G.z0 - 0.25, 0],
      [G.z1 + 0.25, Math.PI],
    ] as const)
      k.signs.panel((G.x0 + G.x1) / 2, top + 1.8, z, 2.2 * name.aspect, 2.2, f, '#ffffff', name.uv);
    s.span(G.x0 + 40, top + 0.6, G.z0 - 0.2, G.x1 - 40, top + 3.0, G.z0 - 0.15, '#1d1238');
    s.span(G.x0 + 40, top + 0.6, G.z1 + 0.15, G.x1 - 40, top + 3.0, G.z1 + 0.2, '#1d1238');
    // cars along each deck's outer bays (the ones seen through the openings)
    for (let l = 0; l <= G.levels; l++) {
      const y = l === 0 ? 0 : l * G.storey;
      for (let x = G.x0 + 12; x < G.x1 - 6; x += 2.5) {
        for (const [z, h] of [
          [G.z0 + 2.8, 0],
          [G.z1 - 2.8, 180],
        ] as const)
          if (rnd() < (l === G.levels ? 0.35 : 0.7)) cars.push({ x, y, z, heading: h + (rnd() - 0.5) * 3, taxi: false });
      }
    }
    blockCollider(ctx, G.x0 - 0.2, G.z0 - 0.2, G.x1 + 0.2, G.z1 + 0.2, 4);
    return cars;
  }

  /** The plaza under the SkyLink between the car parks: paving, planters, trees, benches, a path to the station. */
  private plaza(ctx: Ctx, k: Record<string, Kit>, rnd: () => number) {
    const x0 = CAR_PARK.x1 + 2;
    const x1 = GARAGE.x0 - 2;
    const z0 = ACCESS_ROAD.z + ACCESS_ROAD.half + 8;
    const z1 = KERB_ROAD.z0 - 1;
    const P = k.paving;
    this.area(P, x0, z0, x1, z1, ROAD_Y + 0.004, PAVING);
    P.worldUvXZ(P.vertexCount - 4, 3);
    // the footways along the kerb road's north side, across the forecourt
    this.area(P, KERB_ROAD.x0, KERB_ROAD.z0 - 4, KERB_ROAD.x1, KERB_ROAD.z0, ROAD_Y + 0.006, PAVING);
    P.worldUvXZ(P.vertexCount - 4, 3);
    k.structure.span(KERB_ROAD.x0, 0, KERB_ROAD.z0 - 0.3, KERB_ROAD.x1, KERB_H, KERB_ROAD.z0, CONCRETE);
    // long planters either side of the walk under the guideway, trees in them
    for (const x of [SKYLINK_POINT.x - 9, SKYLINK_POINT.x + 9]) {
      for (let z = z0 + 8; z < z1 - 44; z += 26) {
        k.structure.span(x - 1.6, 0, z, x + 1.6, 0.55, z + 18, '#d9d3c9');
        k.structure.span(x - 1.45, 0.55, z + 0.15, x + 1.45, 0.58, z + 17.85, '#5a4532');
        for (let t = z + 3; t < z + 17; t += 6) this.tree(k, x, t, rnd, 1);
        blockCollider(ctx, x - 1.6, z, x + 1.6, z + 18, 0.55);
      }
      for (let z = z0 + 21; z < z1 - 44; z += 26) this.bench(k, x + (x < SKYLINK_POINT.x ? 2.6 : -2.6), z + 3, x < SKYLINK_POINT.x ? Math.PI / 2 : -Math.PI / 2);
    }
    // the station's forecourt: lighter paving, the zebra's approach
    const st = { x0: SKYLINK_POINT.x - STATION.halfX - 6, x1: SKYLINK_POINT.x + STATION.halfX + 6, z0: SKYLINK_POINT.z - STATION.halfZ - 6, z1: KERB_ROAD.z0 - 4 };
    this.area(P, st.x0, st.z0, st.x1, st.z1, ROAD_Y + 0.008, '#ddd8cf');
    P.worldUvXZ(P.vertexCount - 4, 3);
    // a footway from the car park's middle across to the plaza
    this.area(P, CAR_PARK.x1 - 2, (CAR_PARK.z0 + CAR_PARK.z1) / 2 - 2, x0, (CAR_PARK.z0 + CAR_PARK.z1) / 2 + 2, ROAD_Y + 0.006, PAVING);
  }

  private tree(k: Record<string, Kit>, x: number, z: number, rnd: () => number, scale: number) {
    const h = (4.5 + rnd() * 2) * scale;
    k.structure.cyl(x, 0, z, 0.16 * scale, 0.12 * scale, h * 0.55, '#6b4f36', 6);
    const leaf = ['#3f7d3a', '#4f8f43', '#356b34', '#5b9a4a'];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rnd();
      k.structure.blob(x + Math.cos(a) * 0.8 * scale, h * (0.62 + rnd() * 0.18), z + Math.sin(a) * 0.8 * scale, 1.5 * scale, 1.3 * scale, 1.5 * scale, leaf[i % 4], true);
    }
    k.structure.blob(x, h * 0.85, z, 1.4 * scale, 1.2 * scale, 1.4 * scale, leaf[Math.floor(rnd() * 4)], true);
  }

  private bench(k: Record<string, Kit>, x: number, z: number, facing: number) {
    const c = Math.cos(facing);
    const s = Math.sin(facing);
    k.structure.box(x, 0.45, z, 2.0, 0.08, 0.5, '#c9a27a', -facing);
    k.structure.box(x - s * 0.24, 0.72, z + c * 0.24, 2.0, 0.45, 0.06, '#c9a27a', -facing);
    for (const d of [-0.8, 0.8]) k.metal.box(x + c * d, 0.22, z + s * d, 0.06, 0.44, 0.45, '#3a3f45', -facing);
  }

  // ----------------------------------------------------------------------------------------------
  // Street lights and signs
  // ----------------------------------------------------------------------------------------------

  private lamp(ctx: Ctx, k: Record<string, Kit>, x: number, z: number, arms: { dx: number; dz: number }[], h = 10, collide = true) {
    k.metal.cyl(x, 0, z, 0.13, 0.09, h, '#8d959d', 6);
    for (const a of arms) {
      const tx = x + a.dx * 1.8;
      const tz = z + a.dz * 1.8;
      k.metal.bar({ x, y: h - 0.2, z }, { x: tx, y: h, z: tz }, 0.05, '#8d959d', 4);
      k.metal.box(tx, h - 0.05, tz, 0.7, 0.14, 0.3, '#5a6168');
      k.emitter.floor(tx - 0.3, tz - 0.12, tx + 0.3, tz + 0.12, h - 0.13, '#fff1d6', undefined, true);
      // its pool of light on the ground at night
      const r = 9;
      k.pool.floor(tx - r, tz - r, tx + r, tz + r, PAINT_Y + 0.01, '#ffffff');
    }
    if (collide) staticCylinder(ctx, x, z, 0.18, 4);
  }

  private lights(ctx: Ctx, k: Record<string, Kit>) {
    const A = ACCESS_ROAD;
    // twin-armed lamps down the access road's median, every 42 m (near the terminal; the road runs on into the dark)
    for (let x = -1400; x <= 1400; x += 42) this.lamp(ctx, k, x, A.z, [{ dx: 0, dz: -1 }, { dx: 0, dz: 1 }], 12, false);
    // along the link roads and the kerb road's north side
    for (const x of [LINK_ROADS.west - LINK_ROADS.half - 1.2, LINK_ROADS.east + LINK_ROADS.half + 1.2])
      for (let z = A.z + A.half + 18; z < KERB_ROAD.z0 - 8; z += 30) this.lamp(ctx, k, x, z, [{ dx: x < 0 ? 1 : -1, dz: 0 }], 9);
    for (let x = KERB_ROAD.x0 + 10; x < KERB_ROAD.x1; x += 32) this.lamp(ctx, k, x, KERB_ROAD.z0 - 1.2, [{ dx: 0, dz: 1 }], 8);
    // the surface car park: single lamps on its islands, round its edge
    const C = CAR_PARK;
    for (let x = C.x0 + 14; x < C.x1 - 6; x += 28)
      for (const z of [C.z0 + 1, (C.z0 + C.z1) / 2 + 3.5, C.z1 - 1]) this.lamp(ctx, k, x, z, [{ dx: 0, dz: 1 }, { dx: 0, dz: -1 }], 9);
  }

  private signage(k: Record<string, Kit>) {
    const A = ACCESS_ROAD;
    // gantries over the access road ahead of the turn-off, for both directions
    const gantry = (x: number, z0: number, z1: number, facing: number, parts: string[][]) => {
      for (const z of [z0, z1]) k.metal.cyl(x, 0, z, 0.25, 0.25, 7.6, '#8d959d', 8);
      k.metal.span(x - 0.3, 6.9, Math.min(z0, z1), x + 0.3, 7.5, Math.max(z0, z1), '#8d959d');
      const signs = parts.map((p) => wayfinding(this.atlas, p, { height: 96 }));
      const total = signs.reduce((t, s) => t + 1.6 * s.aspect + 0.4, 0);
      let at = (z0 + z1) / 2 - (total / 2) * (facing === Math.PI / 2 ? -1 : 1);
      for (const s of signs) {
        const w = 1.6 * s.aspect;
        const c = at + (w / 2) * (facing === Math.PI / 2 ? -1 : 1);
        const off = facing === Math.PI / 2 ? 0.36 : -0.36;
        k.metal.box(x + off * 0.5, 6.1, c, 0.1, 1.7, w + 0.1, '#24272d');
        k.signs.panel(x + off, 6.1, c, w, 1.6, facing, '#ffffff', s.uv);
        at += (w + 0.4) * (facing === Math.PI / 2 ? -1 : 1);
      }
    };
    // eastbound traffic (south carriageway) sees signs facing west
    gantry(LINK_ROADS.west - 260, A.z + 1.4, A.z + A.half + 1, -Math.PI / 2, [
      ['departures', 'arrivals', 'Funfair International', '↘'],
      ['parking', 'Car parks', '↘'],
    ]);
    // westbound traffic (north carriageway) sees signs facing east
    gantry(LINK_ROADS.east + 260, A.z - A.half - 1, A.z - 1.4, Math.PI / 2, [['departures', 'Funfair International', 'train', 'SkyLink']]);
    // the terminal's own name on the forecourt, by the west link's turn
    this.totem(k, lettering(this.atlas, 'Funfair International  ·  XFUN', { fg: '#ffffff', bg: '#1d1238', height: 96 }), LINK_ROADS.west + 14, A.z + A.half + 10, 1.4, 4.2);
  }

  // ----------------------------------------------------------------------------------------------
  // Traffic
  // ----------------------------------------------------------------------------------------------

  private routes() {
    const A = ACCESS_ROAD;
    const L = LINK_ROADS;
    const K = KERB_ROAD;
    const east = { lane1: A.z + 7.3, lane2: A.z + 3.2 };
    const west = { lane1: A.z - 7.3, lane2: A.z - 3.2 };
    const far = 2600;
    const through = new Route([{ x: -far, z: east.lane2 }, { x: far, z: east.lane2 }], 15);
    const westbound = new Route([{ x: far, z: west.lane2 }, { x: -far, z: west.lane2 }], 15);
    // in from the west, down the west link, along the kerb (drop-off lane), up the east link, away east
    const loop = (kerbZ: number, speed: number) =>
      new Route(
        [
          { x: -far, z: east.lane1 },
          { x: L.west, z: east.lane1 },
          { x: L.west, z: kerbZ },
          { x: L.east, z: kerbZ },
          { x: L.east, z: east.lane1 },
          { x: far, z: east.lane1 },
        ],
        speed,
      );
    const dropOff = loop(K.z1 - 2.2, 13);
    const kerb = loop(K.z0 + 5.6, 13);
    const busLoop = loop(K.z1 - 2.2, 11);
    // where the kerb starts along the loop (for the drop-off stops) and where the bus stop is
    const along = (r: Route, x: number, z: number) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < r.x.length; i++) {
        const d = Math.hypot(r.x[i] - x, r.z[i] - z);
        if (d < bd) {
          bd = d;
          best = r.s[i];
        }
      }
      return best;
    };
    return { through, westbound, dropOff, kerb, busLoop, kerbStart: along(dropOff, K.x0, K.z1 - 2.2), busStop: along(busLoop, -20, K.z1 - 2.2) };
  }

  /** Puts instance `i` of a fleet at (x, y, z) facing `heading` (degrees). */
  private place(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, heading: number) {
    this.q.setFromAxisAngle(this.up, (-heading * Math.PI) / 180);
    this.m.compose(this.p.set(x, y, z), this.q, this.one);
    mesh.setMatrixAt(i, this.m);
  }

  /** Moves the traffic on by dt: following the vehicle ahead, stopping at stops and for the visitor. */
  private step(dt: number) {
    const vis = this.visitor;
    for (const v of this.vehicles) {
      const r = v.route;
      v.i = r.index(v.s, v.i);
      const i = v.i;
      const j = Math.min(i + 1, r.x.length - 1);
      const t = r.s[j] > r.s[i] ? (v.s - r.s[i]) / (r.s[j] - r.s[i]) : 0;
      const x = r.x[i] + (r.x[j] - r.x[i]) * t;
      const z = r.z[i] + (r.z[j] - r.z[i]) * t;
      const fx = r.x[j] - r.x[i];
      const fz = r.z[j] - r.z[i];
      const fl = Math.hypot(fx, fz) || 1;
      let target = r.v[i] * v.pace;
      // the gap to the vehicle ahead (round the loop's end too)
      if (v.ahead && v.ahead !== v) {
        let gap = v.ahead.s - v.s;
        if (gap < 0) gap += r.length;
        const need = (v.bus || v.ahead.bus ? 15 : 9) + v.v * 0.9;
        if (gap < need) target = Math.min(target, Math.max(0, (gap - (v.bus ? 13 : 7)) * 0.8));
      }
      // a stop ahead: brake to it, wait, go
      if (v.stopAt >= 0 && v.stopped >= 0) {
        const d = v.stopAt - v.s;
        if (d > 0 && d < 40) target = Math.min(target, Math.sqrt(2 * 1.6 * Math.max(0, d - 0.3)));
        if (d <= 0.5 && d > -1) {
          v.stopped += dt;
          target = 0;
          if (v.stopped > v.stopFor) v.stopped = -1;
        }
      }
      // the visitor on the road ahead
      if (vis) {
        const dx = vis.x - x;
        const dz = vis.z - z;
        const ahead = (dx * fx + dz * fz) / fl;
        const side = Math.abs((dx * fz - dz * fx) / fl);
        if (ahead > 0 && ahead < 14 && side < (v.bus ? 2.4 : 2.0)) target = Math.min(target, Math.max(0, (ahead - 4.5) * 0.7));
      }
      // accelerate gently, brake firmly
      const acc = target > v.v ? 1.8 : 4.5;
      v.v += THREE.MathUtils.clamp(target - v.v, -acc * dt, acc * dt);
      v.s += v.v * dt;
      if (v.s >= r.length) {
        // round again (the loop's ends are kilometres out, in the haze); a new stop for some
        v.s -= r.length;
        v.i = 0;
        if (v.stopped < 0) v.stopped = 0;
      }
      this.place(v.bus ? this.buses : this.cars, v.slot, x, 0, z, (Math.atan2(fx, -fz) * 180) / Math.PI);
    }
  }

  /** 0 by day .. 1 at night: street lights, lamp pools, lit windows and headlights. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 1e-3) return;
    this.night = k;
    setKitNight(this.mats, k);
    this.atlas.setNight(k);
  }

  update(dt: number, _t: number, camera?: THREE.Camera) {
    // far away (in flight, on the island) the traffic stops being animated and the fleets hide
    const far = camera ? camera.position.distanceTo(this.centre) > 6000 : false;
    this.group.visible = camera ? camera.position.distanceTo(this.centre) < 22000 : true;
    if (far) return;
    this.step(Math.min(dt, 0.1));
    this.cars.instanceMatrix.clearUpdateRanges();
    this.cars.instanceMatrix.addUpdateRange(0, this.movingCars * 16);
    this.cars.instanceMatrix.needsUpdate = true;
    this.buses.instanceMatrix.clearUpdateRanges();
    this.buses.instanceMatrix.addUpdateRange(0, this.movingBuses * 16);
    this.buses.instanceMatrix.needsUpdate = true;
  }
}
