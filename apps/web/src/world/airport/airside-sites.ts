// Where everything on each airport's airside stands, and where its vehicles drive: the buildings
// (placed through airside-buildings.ts), the parked fleet, the equipment round each parked
// aircraft, and the vehicle routes.
//
// The apron's own roads come from the airfield's paint (airfield-plan.ts): the service road along
// the terminal's facade (the "head" road) and the road behind the stands' tails. Vehicles go
// round the apron one way (head road towards the west, tail road towards the east) so they never
// meet head-on; outside the apron the service road has a lane each way. Every stand's equipment
// is laid out in the parked aircraft's own frame (A320 door and hold positions), so it fits both
// airports whichever way their stands face.

import { Matrix4 } from 'three';
import type { Airport, Stand } from '../../aviation/airports';
import { A320_POINTS } from '../../aviation/a320';
import { headingVec } from '../geo';
import type { LiveryId } from './liveries';
import type { P2 } from './airside-path';
import { Path } from './airside-path';
import type { RouteSpec, VehicleKind } from './vehicles';
import { block, cargoTerminal, cones, controlTower, fireStation, fuelFarm, hangar, mast, shed, COLOURS, type Parts } from './airside-buildings';

/** A vehicle (or a crew member) standing still. */
export interface StaticVehicle {
  kind: VehicleKind;
  variant?: number;
  x: number;
  z: number;
  heading: number;
  y?: number;
}

/** A vehicle that moves between its waiting spot and its place at the aircraft (a belt loader). */
export interface ServiceVehicle {
  kind: VehicleKind;
  path: Path;
}

export interface ParkedSpec {
  x: number;
  z: number;
  heading: number;
  livery: LiveryId;
  /** Door L1 open (a jet bridge or stairs at it) and the holds open. */
  doors: boolean;
  /** The stand it occupies (the terminal docks its bridge), if it's at one. */
  stand?: string;
  /** Inside a hangar: no lights at night but the hangar's. */
  hangar?: boolean;
}

export interface Site {
  parked: ParkedSpec[];
  statics: StaticVehicle[];
  crew: { x: number; z: number; heading: number }[];
  routes: RouteSpec[];
  /** Each reserved stand's equipment that drives in when an aircraft is on it. */
  service: Record<string, ServiceVehicle[]>;
  /** The marshaller at the player's stand: where he stands, facing the aircraft coming in. */
  marshaller: { x: number; z: number; heading: number };
}

// ------------------------------------------------------------------------------------------------
// The apron's frame
// ------------------------------------------------------------------------------------------------

interface Frame {
  ap: Airport;
  /** +1 if the stands lie south of the terminal (home), −1 north (Palm Cay). */
  inward: number;
  headZ: number;
  /** Lane centres: the head road (westbound round the apron), the tail road (eastbound). */
  head: number;
  tail: number;
  /** Outside the apron: the service road's westbound lane (on the head road's line) and eastbound lane. */
  west: number;
  east: number;
  /** The x of the ring's two sides (just inside the apron's ends). */
  x0: number;
  x1: number;
}

function frame(ap: Airport): Frame {
  const g = ap.geo;
  // the stands face the terminal: heading 000 (home) puts them south of it, 180 (Palm Cay) north
  const inward = g.standHeading === 0 ? 1 : -1;
  const headZ = g.terminal.airside;
  const standZ = ap.stands[0].z;
  // the airfield paints the tail road from 26.5 m behind the stop line, 8 m wide
  const tail = standZ + inward * (26.5 + 4);
  // the head road's lane nearest the facade (clear of the jet bridges' rotunda columns)
  const head = headZ + inward * 3;
  return { ap, inward, headZ, head, tail, west: head - inward * 0.5, east: head + inward * 3.5, x0: g.apron.x0 + 8, x1: g.apron.x1 - 8 };
}

/** A point in a parked aircraft's frame (right +x, aft +z, metres from its reference point) in the world. */
function bodyPt(st: { x: number; z: number; heading: number }, bx: number, bz: number): P2 {
  const f = headingVec(st.heading);
  return { x: st.x + -f.z * bx - f.x * bz, z: st.z + f.x * bx - f.z * bz };
}

/** A heading in the parked aircraft's frame (0: its nose's way, 90: towards its right) in the world. */
const bodyHdg = (st: { heading: number }, h: number) => (st.heading + h + 360) % 360;

// ------------------------------------------------------------------------------------------------
// Equipment round a parked aircraft
// ------------------------------------------------------------------------------------------------

/** The direction (x, z) a heading in the aircraft frame points (0: its nose, 90: its right). */
function bodyDir(h: number) {
  const r = (h * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

/** How far the belt's tip reaches ahead of the loader's centre (vehicles.ts). */
const BELT_TIP = 3.95;
/** The fuselage's side at the lower lobe, where the hold doors' sills are (m from the centreline). */
const HOLD_X = 2.25;

/** A belt loader with its belt's tip at a hold door, facing heading `h` (aircraft frame): where its centre is. */
function beltAt(tip: P2, h: number) {
  const d = bodyDir(h);
  return { x: tip.x - d.x * BELT_TIP, z: tip.z - d.z * BELT_TIP, h };
}

/** Where the belt loaders, catering truck, bowser and ground power stand at a turnaround (aircraft frame). */
const AT = {
  // the forward hold's door is beside the engine: its loader comes in from ahead of the intake,
  // angled back along the fuselage; the aft hold's squarely from the side, behind the wing root
  beltFwd: beltAt({ x: HOLD_X, z: -8.6 }, -155),
  beltAft: beltAt({ x: HOLD_X, z: 7.9 }, -90),
  // the catering box's platform (4.8 m ahead of the truck's centre) against door R2
  catering: { x: A320_POINTS.doorR2.x + 0.1 + 4.8, z: A320_POINTS.doorR2.z, h: -90 },
  // the bowser ahead of the right wing, outboard of the engine
  bowser: { x: 12.5, z: -7.0, h: 0 },
  gpu: { x: 2.8, z: -16.2, h: 0 },
};

/** The turnaround: everything parked at an aircraft that's being worked (doors open). */
function turnaround(st: { x: number; z: number; heading: number }, out: Site, opts: { catering: boolean; bowser: boolean; belts: boolean }) {
  const place = (kind: VehicleKind, b: { x: number; z: number; h: number }) => {
    const p = bodyPt(st, b.x, b.z);
    out.statics.push({ kind, x: p.x, z: p.z, heading: bodyHdg(st, b.h) });
  };
  const crew = (x: number, z: number, h: number) => {
    const p = bodyPt(st, x, z);
    out.crew.push({ x: p.x, z: p.z, heading: bodyHdg(st, h) });
  };
  if (opts.belts) {
    place('belt', AT.beltFwd);
    place('belt', AT.beltAft);
    // a loader at the foot of each belt, facing it
    crew(AT.beltFwd.x + 2.6, AT.beltFwd.z - 4.4, -60);
    crew(AT.beltAft.x + 5.2, AT.beltAft.z + 1.5, -90);
  }
  if (opts.catering) place('catering', AT.catering);
  if (opts.bowser) {
    place('bowser', AT.bowser);
    crew(AT.bowser.x - 2.2, AT.bowser.z + 2.5, -90);
  }
  place('gpu', AT.gpu);
  // the dispatcher at the nose, headset plugged in
  crew(0.9, -18.6, 180);
}

/** Safety cones at the wingtips, in front of the engines and behind the tail of a parked aircraft. */
function standCones(st: { x: number; z: number; heading: number }, parts: Parts) {
  const pts = [bodyPt(st, -18.7, 3.4), bodyPt(st, 18.7, 3.4), bodyPt(st, -5.75, -13), bodyPt(st, 5.75, -13), bodyPt(st, 0, 21.5)];
  cones(parts.detail, pts);
}

/**
 * A reserved stand's belt loaders: waiting side by side in the equipment area at the head of the
 * stand (clear of the pushback tug's spot), and the paths they drive to the holds when an
 * aircraft is on the stand. Each path ends on the loader's working pose, driving in nose first.
 */
function serviceSet(st: Stand): ServiceVehicle[] {
  const pts = (list: P2[]) => list.map((p) => bodyPt(st, p.x, p.z));
  const f = AT.beltFwd;
  const fd = bodyDir(f.h);
  const a = AT.beltAft;
  return [
    // across the head of the stand, then in along the fuselage ahead of the engine
    { kind: 'belt', path: new Path(pts([{ x: 27.5, z: -22 }, { x: f.x - fd.x * 13, z: f.z - fd.z * 13 }, { x: f.x, z: f.z }]), 6) },
    // down outside the wingtip, then in behind the wing
    { kind: 'belt', path: new Path(pts([{ x: 32.5, z: -22 }, { x: 32.5, z: a.z }, { x: a.x, z: a.z }]), 6) },
  ];
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

/**
 * A baggage train's detour from the tail road into a parked aircraft's stand: up beside the aft
 * hold's belt loader, across behind the wing, and back out. Returns the corner points in the
 * order the train drives them (the tail road runs east, +x) and where it stops.
 */
function detour(F: Frame, st: Stand) {
  const zd = bodyPt(st, 0, 5.5).z;
  const near = bodyPt(st, 12.5, 0).x;
  const far = bodyPt(st, 24, 0).x;
  const [xa, xb] = near < far ? [near, far] : [far, near];
  const pts = [
    { x: xa, z: F.tail },
    { x: xa, z: zd },
    { x: xb, z: zd },
    { x: xb, z: F.tail },
  ];
  // the tractor stops beside the aft belt loader (its carts trailing behind)
  const stop = { x: near, z: zd + F.inward * 3.5 };
  return { pts, stop };
}

/** The apron ring: head road west, down the west end, tail road east (with detours), up the east end. */
function ring(F: Frame, detours: { pts: P2[] }[] = []): P2[] {
  const tailPts: P2[] = [];
  for (const d of [...detours].sort((a, b) => a.pts[0].x - b.pts[0].x)) tailPts.push(...d.pts);
  return [{ x: F.x1, z: F.head }, { x: F.x0, z: F.head }, { x: F.x0, z: F.tail }, ...tailPts, { x: F.x1, z: F.tail }];
}

/** Each corner's radius: the ring's own corners are wide, the detours' tight. */
function radii(pts: P2[], wide: number[]) {
  return pts.map((_, i) => (wide.includes(i) ? 9 : 4.5));
}

function route(kind: VehicleKind, pts: P2[], rad: number | number[], vmax: number, start: number, stops: { at: P2; dwell: number; work?: 'lift' }[] = [], train?: RouteSpec['train'], variant = 0): RouteSpec {
  const path = new Path(pts, rad, true);
  const st = stops.map((s) => ({ s: path.project(s.at.x, s.at.z), dwell: s.dwell, work: s.work })).sort((a, b) => a.s - b.s);
  return { kind, variant, path, vmax, start: start * path.length, stops: st, train };
}

/** The ring with each given stand's detour, as a baggage train's route stopping at each. */
function baggageTrain(F: Frame, stands: Stand[], start: number, carts = 3, variant = 0): RouteSpec {
  const ds = stands.map((s) => detour(F, s));
  const pts = ring(F, ds);
  return route('tractor', pts, radii(pts, [0, 1, 2, pts.length - 1]), 5, start, ds.map((d) => ({ at: d.stop, dwell: 45 })), { kind: 'cart', count: carts }, variant);
}

/**
 * A round trip from somewhere off the apron: in along the westbound lane, round the apron ring,
 * out along the eastbound lane (or the other way for places to the west), with the stops given.
 */
function outAndBack(F: Frame, side: 'east' | 'west', depot: P2[], kind: VehicleKind, start: number, stops: { at: P2; dwell: number; work?: 'lift' }[], vmax = 7, train?: RouteSpec['train']): RouteSpec {
  // the depot loop's points run from where it leaves the eastbound (or westbound) lane round to
  // where it joins the other lane
  const pts: P2[] =
    side === 'east'
      ? [...depot, { x: F.x1 + 6, z: F.west }, { x: F.x0, z: F.head }, { x: F.x0, z: F.tail }, { x: F.x1, z: F.tail }, { x: F.x1, z: F.east }]
      : [...depot, { x: F.x0 - 6, z: F.east }, { x: F.x0, z: F.tail }, { x: F.x1, z: F.tail }, { x: F.x1, z: F.head }, { x: F.x0 - 8, z: F.west }];
  return route(kind, pts, 8, vmax, start, stops, train);
}

// ------------------------------------------------------------------------------------------------
// Funfair International
// ------------------------------------------------------------------------------------------------

/** Liveries for the stands that aren't reserved, in stand order. */
const HOME_FLEET: LiveryId[] = ['funfair', 'candy', 'sunset', 'lagoon', 'palmcay', 'funfair'];

export function homeSite(ap: Airport, parts: Parts, reserved: string[]): Site {
  const F = frame(ap);
  const out: Site = { parked: [], statics: [], crew: [], routes: [], service: {}, marshaller: { x: 0, z: 0, heading: 0 } };
  const stands = ap.stands;
  const busy = stands.filter((s) => !reserved.includes(s.id));
  busy.forEach((s, i) => {
    out.parked.push({ x: s.x, z: s.z, heading: s.heading, livery: HOME_FLEET[(stands.indexOf(s) + i) % HOME_FLEET.length], doors: true, stand: s.id });
    turnaround(s, out, { catering: i % 2 === 0, bowser: i !== 1, belts: true });
    standCones(s, parts);
  });
  for (const id of reserved) {
    const s = stands.find((x) => x.id === id);
    if (!s) continue;
    out.service[id] = serviceSet(s);
    // the ground power unit waits at the nose of every stand
    const g = bodyPt(s, AT.gpu.x, AT.gpu.z);
    out.statics.push({ kind: 'gpu', x: g.x, z: g.z, heading: s.heading });
  }
  const player = stands.find((s) => s.id === ap.playerStand)!;
  const m = bodyPt(player, 0, A320_POINTS.noseGear.z - 10.5);
  out.marshaller = { x: m.x, z: m.z, heading: (player.heading + 180) % 360 };

  // ---------------------------------------------------------------- the buildings
  const y = F.west;
  // maintenance: two hangars (one open, an aircraft inside), the workshop
  hangar(parts, { x0: -700, x1: -628, z0: 470, z1: 538, face: 1, eaves: 17.5, rise: 5.5, doorH: 15.5, open: 1, title: 'FUNFAIR AIR ENGINEERING', label: 'HANGAR 1', clad: '#d9dde1', trim: '#1d1238' });
  hangar(parts, { x0: -618, x1: -546, z0: 470, z1: 538, face: 1, eaves: 17.5, rise: 5.5, doorH: 15.5, open: 0, title: 'FUNFAIR AIR ENGINEERING', label: 'HANGAR 2', clad: '#d9dde1', trim: '#1d1238' });
  out.parked.push({ x: -664, z: 505, heading: 0, livery: 'funfair', doors: true, hangar: true });
  block(parts, { x: -495, z: 503, w: 86, d: 50, h: 10, floors: 2, clad: '#d4d8dc', trim: '#1d1238', doors: { n: 4, face: 's', w: 6, h: 5, open: [1, 2] }, sign: { text: 'ENGINEERING', face: 's', bg: '#1d1238', fg: '#ffffff' } });
  parts.paving.rect(-712, -440, F.east + 3, 708, '#9d9d98');
  parts.paving.rect(-712, -440, 538, F.east + 3, '#9d9d98');
  // the remote stand in front of hangar 2, with an aircraft towed out of maintenance
  out.parked.push({ x: -582, z: 606, heading: 180, livery: 'sunset', doors: false });
  standCones({ x: -582, z: 606, heading: 180 }, parts);
  // the ground handler's equipment base: a shed and the parked equipment rows
  shed(parts, -405, 505, 40, 46, 6, COLOURS.YELLOW);
  block(parts, { x: -360, z: 492, w: 26, d: 30, h: 7.5, floors: 2, clad: '#e8e3d8', trim: '#c98f16', sign: { text: 'GROUND SERVICES', face: 's', bg: '#c98f16', fg: '#ffffff' } });
  parts.paving.rect(-432, -330, 466, 538, '#8f908e');
  for (let i = 0; i < 4; i++) out.statics.push({ kind: 'belt', x: -418 + i * 9, z: 495, heading: 180 });
  for (let i = 0; i < 3; i++) out.statics.push({ kind: 'tractor', x: -414 + i * 6, z: 518, heading: 180 });
  for (let i = 0; i < 2; i++) out.statics.push({ kind: 'tug', x: -393 + i * 7, z: 518, heading: 180 });
  out.statics.push({ kind: 'catering', x: -383, z: 495, heading: 180 });
  for (let r = 0; r < 2; r++) for (let i = 0; i < 6; i++) out.statics.push({ kind: r ? 'dolly' : 'cart', variant: i, x: -345 + r * 2.6, z: 474 + i * 4.3 + (r ? 30 : 0), heading: 0 });
  // the bus gate at the west end of the terminal
  shed(parts, -268, 532, 30, 9, 4.2, '#2f6fd6');
  parts.paving.rect(-300, -236, 524, 540, '#8d8e8f');
  parts.signs.push({ text: 'BUS GATE 7', bg: '#2f6fd6', fg: '#ffffff', w: 8, h: 1.1, m: atS(-268, 3.7, 537.1), lit: true });

  // the catering unit, the tower, cargo, the fire station and the fuel farm, east of the apron
  block(parts, { x: 392, z: 498, w: 60, d: 40, h: 9, floors: 2, clad: '#fff3f6', trim: '#ff4d6d', doors: { n: 4, face: 's', w: 5, h: 4.5, open: [0, 2], color: '#ffc2d1' }, sign: { text: 'CANDY CATERING', face: 's', bg: '#ff4d6d', fg: '#ffffff' } });
  parts.paving.rect(352, 432, 518, 540, '#8d8e8f');
  controlTower(parts, { x: 470, z: 612, cabFloor: 53, r0: 4.6, r1: 3.6, cab: [6.4, 7.6], shaft: '#e9e7e2', trim: '#1d1238', name: 'FUNFAIR', base: { dx: 0, dz: -8, w: 46, d: 26, h: 7.2 } });
  parts.paving.rect(438, 502, F.east + 3, 580, '#7d7e80');
  for (let i = 0; i < 5; i++) out.statics.push({ kind: 'van', x: 448 + i * 6.5, z: 568, heading: 0 });
  out.statics.push({ kind: 'followme', x: 484, z: 556, heading: 90 });
  cargoTerminal(parts, 560, 800, 470, 536, 1);
  parts.paving.rect(556, 822, F.east + 3, 708, '#9b9b96');
  parts.paving.rect(556, 822, 536, F.east + 3, '#8d8e8f');
  out.parked.push({ x: 700, z: 606, heading: 0, livery: 'cargo', doors: false });
  standCones({ x: 700, z: 606, heading: 0 }, parts);
  out.statics.push({ kind: 'hiloader', x: 700 - 1.95 - 4.75, z: 606 - 9, heading: 90 });
  out.statics.push({ kind: 'belt', ...bodyPt({ x: 700, z: 606, heading: 0 }, AT.beltAft.x, AT.beltAft.z), heading: 270 });
  for (let i = 0; i < 4; i++) out.statics.push({ kind: 'dolly', variant: i, x: 676 - i * 4.1, z: 590, heading: 90 });
  out.statics.push({ kind: 'tractor', x: 681, z: 590, heading: 90 });
  out.crew.push({ x: 692, z: 600.5, heading: 90 }, { x: 699, z: 619, heading: 270 });
  fireStation(parts, 905, 625, 6, 1, 'AIRPORT FIRE & RESCUE');
  parts.paving.rect(850, 948, F.east + 3, 708, '#8d8e8f');
  for (const [x, z] of [[892, 652], [912, 652]]) out.statics.push({ kind: 'fire', x, z, heading: 180 });
  // in the open bays (every other door)
  for (const x of [888.75, 901.75, 914.75]) out.statics.push({ kind: 'fire', x, z: 628, heading: 180 });
  fuelFarm(
    parts,
    [{ x: 1015, z: 492, r: 11, h: 13 }, { x: 1043, z: 492, r: 11, h: 13 }, { x: 1015, z: 521, r: 11, h: 13 }, { x: 1043, z: 521, r: 11, h: 13 }],
    { x0: 1000, x1: 1058, z0: 477, z1: 536 },
    { x: 1090, z: 520 },
    'FUEL FARM',
  );
  out.statics.push({ kind: 'bowser', x: 1084, z: 528, heading: 180 });
  // the service road: asphalt from the hangars to the fuel farm, both lanes
  parts.paving.rect(-1300, -330, Math.min(F.west, F.east) - 2.5, Math.max(F.west, F.east) + 2.5, '#3f4246');
  parts.paving.rect(330, 1300, Math.min(F.west, F.east) - 2.5, Math.max(F.west, F.east) + 2.5, '#3f4246');
  for (const [x, z0, z1] of [[470, F.east, 590], [905, F.east, 613], [1090, F.east, 530], [384, 518, F.east], [-268, 524, F.west]] as const) parts.paving.rect(x - 4, x + 4, Math.min(z0, z1), Math.max(z0, z1), '#3f4246');

  // the apron's floodlight masts, behind the stands (clear of every pushback's swing) and at the ends
  for (const x of [-180, -120, -60, 0, 60, 120, 180]) mast(parts, x, F.tail + 9, 24, 0);
  for (const x of [-300, 300]) mast(parts, x, F.tail + 9, 24, 0, 40);
  for (const x of [-326, 326]) mast(parts, x, 552, 24, 180, 40);
  for (const [x, z, aim] of [[-708, 650, 90], [-444, 650, 270], [560, 650, 90], [818, 650, 270], [470, 560, 180]] as const) mast(parts, x, z, 22, aim, 40);

  // ---------------------------------------------------------------- the vehicles' routes
  const R = out.routes;
  const parkedStands = busy.slice(0, 3);
  parkedStands.forEach((s, i) => R.push(baggageTrain(F, [s], 0.12 + i * 0.31, 3, i)));
  R.push(baggageTrain(F, parkedStands.slice(0, 2), 0.72, 2, 1));
  const ringPts = ring(F);
  R.push(route('belt', ringPts, 9, 4.5, 0.45));
  R.push(route('tractor', ringPts, 9, 5, 0.86, [], { kind: 'gpu', count: 1 }));
  R.push(route('van', ringPts, 9, 6, 0.58));
  // the apron bus: from the bus gate, round to the remote stand by the hangars and back
  R.push(
    route(
      'bus',
      [
        { x: F.x1, z: F.head },
        { x: -250, z: F.head },
        { x: -250, z: 530 },
        { x: -290, z: 530 },
        { x: -290, z: y },
        { x: -556, z: y },
        { x: -556, z: 650 },
        { x: -530, z: 650 },
        { x: -530, z: F.east },
        { x: F.x0 - 6, z: F.east },
        { x: F.x0, z: F.tail },
        { x: F.x1, z: F.tail },
      ],
      [9, 6, 6, 6, 9, 9, 9, 9, 9, 9, 9, 9],
      6.5,
      0.1,
      [
        { at: { x: -270, z: 530 }, dwell: 50 },
        { at: { x: -556, z: 618 }, dwell: 55 },
      ],
    ),
  );
  R.push(route('bus', ringPts, 9, 6.5, 0.3, [], undefined));
  // the fuel bowsers and the catering truck, out from their depots and round the apron
  const fuel = [{ x: 1096, z: F.east }, { x: 1096, z: 512 }, { x: 1084, z: 512 }, { x: 1084, z: F.west }];
  R.push(outAndBack(F, 'east', fuel, 'bowser', 0.05, [{ at: { x: 1096, z: 521 }, dwell: 70 }], 8));
  R.push(outAndBack(F, 'east', fuel, 'bowser', 0.55, [{ at: { x: 1096, z: 521 }, dwell: 70 }], 8));
  const cater = [{ x: 396, z: F.east }, { x: 396, z: 522 }, { x: 384, z: 522 }, { x: 384, z: F.west }];
  R.push(outAndBack(F, 'east', cater, 'catering', 0.3, [{ at: { x: 396, z: 526 }, dwell: 80, work: 'lift' }], 6));
  // cargo trains: from the passenger apron to the freighter and back
  const cargo = [{ x: 750, z: F.east }, { x: 750, z: 628 }, { x: 724, z: 628 }, { x: 724, z: F.west }];
  R.push(outAndBack(F, 'east', cargo, 'tractor', 0.2, [{ at: { x: 724, z: 612 }, dwell: 50 }], 5.5, { kind: 'dolly', count: 4 }));
  R.push(outAndBack(F, 'east', cargo, 'tractor', 0.7, [{ at: { x: 724, z: 612 }, dwell: 50 }], 5.5, { kind: 'dolly', count: 3 }));
  // engineering's van and a tug between the hangars and the apron
  // (the van calls at the workshop's door, north of the road, out of the bus's way)
  const eng = [{ x: -490, z: F.west }, { x: -490, z: 533 }, { x: -510, z: 533 }, { x: -510, z: F.east }];
  R.push(outAndBack(F, 'west', eng, 'van', 0.4, [{ at: { x: -500, z: 533 }, dwell: 40 }], 8));
  R.push(outAndBack(F, 'west', [{ x: -700, z: F.west }, { x: -700, z: 600 }, { x: -720, z: 600 }, { x: -720, z: F.east }], 'tug', 0.8, [{ at: { x: -700, z: 590 }, dwell: 60 }], 5));
  // the follow-me car patrols the service road and the perimeter road
  R.push(perimeter(F, ap, 'followme', 0.15, 11));
  R.push(perimeter(F, ap, 'van', 0.62, 10));
  return out;
}

/** The airfield's security road round the fence, joined to the service road at both ends. */
function perimeter(F: Frame, ap: Airport, kind: VehicleKind, start: number, vmax: number): RouteSpec {
  const r = ap.geo.runway;
  const home = F.inward > 0;
  // the fence (airfield-plan.ts): 400 m beyond the runway ends at home, 380 on the island
  const fx = (home ? r.x1 + 400 : r.x1 + 380) - 8;
  const nearZ = home ? ap.geo.terminal.z0 + 20 + 8 : ap.geo.terminal.airside + 5 - 8;
  const farZ = home ? r.z + 160 - 8 : r.z - 160 + 8;
  const gap = home ? 1300 : 600;
  const pts = [
    { x: gap, z: F.west },
    { x: -gap, z: F.west },
    { x: -gap - 70, z: nearZ },
    { x: -fx, z: nearZ },
    { x: -fx, z: farZ },
    { x: fx, z: farZ },
    { x: fx, z: nearZ },
    { x: gap + 70, z: nearZ },
  ];
  return route(kind, pts, 14, vmax, start);
}

/** A sign's matrix facing south (a viewer on the apron at home). */
function atS(x: number, y: number, z: number) {
  return atFacing(x, y, z, Math.PI);
}
function atFacing(x: number, y: number, z: number, ry: number) {
  const m = new Matrix4();
  m.makeRotationY(ry);
  m.setPosition(x, y, z);
  return m;
}

// ------------------------------------------------------------------------------------------------
// Palm Cay
// ------------------------------------------------------------------------------------------------

const ISLAND_FLEET: LiveryId[] = ['palmcay', 'lagoon', 'candy', 'palmcay'];

export function islandSite(ap: Airport, parts: Parts, reserved: string[]): Site {
  const F = frame(ap);
  const out: Site = { parked: [], statics: [], crew: [], routes: [], service: {}, marshaller: { x: 0, z: 0, heading: 0 } };
  const stands = ap.stands;
  const busy = stands.filter((s) => !reserved.includes(s.id));
  busy.forEach((s, i) => {
    out.parked.push({ x: s.x, z: s.z, heading: s.heading, livery: ISLAND_FLEET[stands.indexOf(s)], doors: true, stand: s.id });
    turnaround(s, out, { catering: i === 0, bowser: i === 1, belts: true });
    standCones(s, parts);
  });
  for (const id of reserved) {
    const s = stands.find((x) => x.id === id);
    if (!s) continue;
    out.service[id] = serviceSet(s);
    const g = bodyPt(s, AT.gpu.x, AT.gpu.z);
    out.statics.push({ kind: 'gpu', x: g.x, z: g.z, heading: s.heading });
  }
  const player = stands.find((s) => s.id === ap.playerStand)!;
  const m = bodyPt(player, 0, A320_POINTS.noseGear.z - 10.5);
  out.marshaller = { x: m.x, z: m.z, heading: (player.heading + 180) % 360 };

  const z0 = ap.geo.apron.z0;
  // a small tower east of the apron (under 25 m, as everything near the runway must be)
  controlTower(parts, { x: 300, z: 40556, cabFloor: 15, r0: 2.8, r1: 2.3, cab: [3.6, 4.4], shaft: '#f4efe6', trim: COLOURS.TEAL, name: 'PALM CAY', base: { dx: 0, dz: 6, w: 22, d: 14, h: 4.2 } });
  parts.paving.rect(282, 318, 40568, F.east - 2.5, '#8d8e8f');
  out.statics.push({ kind: 'van', x: 290, z: 40576, heading: 180 }, { kind: 'followme', x: 309, z: 40576, heading: 180 });
  // the fire station facing the runway, its forecourt out to the taxiway
  fireStation(parts, -340, 40556, 3, -1, 'FIRE & RESCUE');
  parts.paving.rect(-372, -308, z0 + 6, 40544, '#8d8e8f');
  parts.paving.rect(-330, -322, 40568, F.east - 2.5, '#3f4246');
  out.statics.push({ kind: 'fire', x: -346.5, z: 40536, heading: 0 }, { kind: 'fire', x: -333.5, z: 40553, heading: 0 });
  // the fuel point: two small tanks and a loading bay
  fuelFarm(parts, [{ x: 418, z: 40574, r: 7, h: 9 }, { x: 438, z: 40574, r: 7, h: 9 }], { x0: 408, x1: 448, z0: 40564, z1: 40586 }, { x: 476, z: 40580 }, 'FUEL');
  out.statics.push({ kind: 'bowser', x: 470, z: 40578, heading: 0 });
  // the handler's shed and equipment beside the terminal's east end
  shed(parts, 240, 40580, 36, 14, 5, COLOURS.TEAL);
  parts.paving.rect(220, 262, 40570, F.east - 2.5, '#8f908e');
  for (let i = 0; i < 3; i++) out.statics.push({ kind: 'cart', variant: i, x: 228 + i * 2.4, z: 40580, heading: 0 });
  out.statics.push({ kind: 'tractor', x: 240, z: 40582, heading: 0 }, { kind: 'belt', x: 250, z: 40580, heading: 0 }, { kind: 'tug', x: 257, z: 40581, heading: 0 });
  // the service road east and west of the apron
  parts.paving.rect(-600, -200, Math.min(F.west, F.east) - 2.5, Math.max(F.west, F.east) + 2.5, '#3f4246');
  parts.paving.rect(200, 600, Math.min(F.west, F.east) - 2.5, Math.max(F.west, F.east) + 2.5, '#3f4246');
  parts.paving.rect(472, 480, 40572, F.east - 2.5, '#3f4246');
  // masts at the apron's corners and beside the terminal (the pushbacks swing behind the stands)
  for (const [x, z, aim] of [[-206, 40488, 135], [206, 40488, 225], [-206, 40562, 45], [206, 40562, 315], [-160, 40603, 0], [160, 40603, 0]] as const) mast(parts, x, z, 20, aim, 36);

  const R = out.routes;
  const ringPts = ring(F);
  if (busy[0]) R.push(baggageTrain(F, [busy[0]], 0.1, 3));
  if (busy[1]) R.push(baggageTrain(F, [busy[1]], 0.6, 2, 1));
  R.push(route('belt', ringPts, 9, 4, 0.35));
  const fuel = [{ x: 480 + 4, z: F.east }, { x: 484, z: 40576 }, { x: 472, z: 40576 }, { x: 472, z: F.west }];
  R.push(outAndBack(F, 'east', fuel, 'bowser', 0.4, [{ at: { x: 484, z: 40580 }, dwell: 60 }], 7));
  R.push(perimeter(F, ap, 'followme', 0.3, 11));
  return out;
}

