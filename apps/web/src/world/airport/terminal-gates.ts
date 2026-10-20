// The gate lounges along the airside facade: rows of seats facing the apron, each gate's desk with
// its screen and number, and the glazed boarding area round the escalator that climbs to the jet
// bridge's doorway. Also where the crowd sits, queues to board and walks off an arriving flight.

import type { FlightBoards } from './boards';
import { gateNumber, signAtlas, wayfinding, type SignAtlas } from './terminal-signs';
import type { V2, V3, WalkRect } from './terminal-kit';
import { AIR_Z, COLUMNS, DESK_Z, ESCALATOR, FLOOR_Y, GATES, RECLAIM, type GatePlan } from './terminal-plan';
import type { Ctx } from '../context';
import { ROTUNDA_FLOOR } from './jet-bridge';
import type { Collision, Placer } from './terminal-interior';
import type { TerminalKits } from './terminal-shell';

/** A seat: where to sit, and which way the sitter faces (the park's yaw: 0 north, π south). */
export interface Seat extends V2 {
  yaw: number;
}

const UPHOLSTERY = ['#2f4f7a', '#2f4f7a', '#ff4d6d', '#2f4f7a', '#2ec4b6'];
const FRAME = '#8d959d';
const SEAT_PITCH = 0.62;

/** A row of seats facing south, from x0 to x1 at z (the seat pans' centres), broken into banks of eight. */
function seatRow(k: TerminalKits, x0: number, x1: number, z: number, colour: string, seats: Seat[], col: Collision) {
  const n = Math.floor((x1 - x0 + 0.9) / (SEAT_PITCH * 8 + 0.9)) * 8 + Math.min(8, Math.floor(((x1 - x0 + 0.9) % (SEAT_PITCH * 8 + 0.9)) / SEAT_PITCH));
  if (n < 2) return;
  let x = x0;
  let bank: number[] = [];
  const flush = () => {
    if (!bank.length) return;
    const a = bank[0] - SEAT_PITCH / 2;
    const b = bank[bank.length - 1] + SEAT_PITCH / 2;
    // the bank's beam and its legs
    k.metal.span(a, 0.3, z - 0.12, b, 0.36, z + 0.02, FRAME);
    for (const lx of [a + 0.2, b - 0.2]) {
      k.metal.span(lx - 0.03, FLOOR_Y, z - 0.25, lx + 0.03, 0.32, z + 0.2, FRAME);
    }
    col.blocks.push({ x0: a, z0: z - 0.35, x1: b, z1: z + 0.3, h: 0.9 });
    bank = [];
  };
  for (let i = 0; i < n; i++) {
    if (bank.length === 8) {
      flush();
      x += 0.9;
    }
    const cx = x + SEAT_PITCH / 2;
    if (cx + SEAT_PITCH / 2 > x1 + 1e-6) break;
    // the pan and the back as their visible faces only (there are thousands of seats), the arm to
    // the seat's left
    const a = cx - 0.26;
    const b = cx + 0.26;
    const zf = z + 0.24;
    const zb = z - 0.24;
    k.interior.quad({ x: a, y: 0.48, z: zf }, { x: b, y: 0.48, z: zf }, { x: b, y: 0.48, z: zb }, { x: a, y: 0.48, z: zb }, colour);
    k.interior.quad({ x: a, y: 0.4, z: zf }, { x: b, y: 0.4, z: zf }, { x: b, y: 0.48, z: zf }, { x: a, y: 0.48, z: zf }, colour);
    k.interior.quad({ x: a, y: 0.48, z: zb }, { x: b, y: 0.48, z: zb }, { x: b, y: 0.98, z: zb - 0.06 }, { x: a, y: 0.98, z: zb - 0.06 }, colour);
    k.interior.quad({ x: b, y: 0.48, z: zb - 0.06 }, { x: a, y: 0.48, z: zb - 0.06 }, { x: a, y: 0.98, z: zb - 0.12 }, { x: b, y: 0.98, z: zb - 0.12 }, FRAME);
    k.interior.quad({ x: a, y: 0.98, z: zb - 0.06 }, { x: b, y: 0.98, z: zb - 0.06 }, { x: b, y: 0.98, z: zb - 0.12 }, { x: a, y: 0.98, z: zb - 0.12 }, colour);
    k.metal.bar({ x: cx - SEAT_PITCH / 2, y: 0.62, z: z - 0.24 }, { x: cx - SEAT_PITCH / 2, y: 0.62, z: z + 0.2 }, 0.03, FRAME, 4);
    seats.push({ x: cx, z: z + 0.02, yaw: Math.PI });
    bank.push(cx);
    x += SEAT_PITCH;
  }
  flush();
}

/** The free stretches of [x0, x1] once the excluded intervals are cut out. */
function freeSpans(x0: number, x1: number, cuts: [number, number][]) {
  const out: [number, number][] = [];
  let s = x0;
  for (const [a, b] of [...cuts].sort((p, q) => p[0] - q[0])) {
    if (a > s) out.push([s, Math.min(a, x1)]);
    s = Math.max(s, b);
    if (s >= x1) break;
  }
  if (s < x1) out.push([s, x1]);
  return out.filter(([a, b]) => b - a > 1.4);
}

/** Every rectangle a seat row must keep out of, for one gate. */
function exclusions(g: GatePlan): WalkRect[] {
  const sx = g.sx;
  return [
    // the desk, its screen pylon and the space round them
    { x0: sx - 4.2, x1: sx + 4.2, z0: 521.6, z1: 530.2 },
    // the aisle from the concourse to the desk, and the walk to the boarding area's door
    { x0: sx - 2.2, x1: sx + 2.2, z0: 512, z1: 530 },
    { x0: g.penDoor.x0 - 1.2, x1: g.penDoor.x1 + 1.2, z0: 512, z1: 530.2 },
    // the boarding area
    { x0: g.pen.x0 - 0.6, x1: g.pen.x1 + 0.6, z0: g.pen.z0 - 0.7, z1: AIR_Z },
  ];
}

/** The desk: a counter facing the lounge, the gate's screen and number on a pylon behind it. */
function gateDesk(k: TerminalKits, g: GatePlan, atlas: SignAtlas, boards: FlightBoards, col: Collision) {
  const { x, z } = g.desk;
  const i = k.interior;
  // the counter: an ink-coloured front with the airline's stripe, a pale top, a raised ledge
  i.span(x - 2, FLOOR_Y, z - 0.4, x + 2, 1.0, z + 0.4, '#1d1238');
  i.span(x - 2.05, 1.0, z - 0.45, x + 2.05, 1.05, z + 0.45, '#f4f2ee');
  i.span(x - 2, 1.05, z - 0.45, x + 2, 1.2, z - 0.3, '#f4f2ee');
  i.box(x, 0.55, z - 0.405, 4, 0.12, 0.01, '#ff4d6d');
  i.box(x, 0.68, z - 0.405, 4, 0.04, 0.01, '#ffc23d');
  // two agents' screens and the boarding-pass readers
  for (const s of [-1, 1]) {
    i.box(x + s * 0.9, 1.32, z + 0.1, 0.5, 0.32, 0.03, '#15171a');
    i.box(x + s * 0.9, 1.12, z + 0.12, 0.08, 0.14, 0.08, '#2a2d31');
    i.box(x + s * 1.7, 1.12, z - 0.3, 0.18, 0.12, 0.22, '#2a2d31');
  }
  col.blocks.push({ x0: x - 2.1, z0: z - 0.5, x1: x + 2.1, z1: z + 0.5, h: 1.2 });
  // the pylon behind: the gate screen, the big number above it
  const pz = z + 2.3;
  k.metal.span(x - 1.45, FLOOR_Y, pz - 0.12, x - 1.25, 4.6, pz + 0.12, '#3a3f45');
  k.metal.span(x + 1.25, FLOOR_Y, pz - 0.12, x + 1.45, 4.6, pz + 0.12, '#3a3f45');
  k.interior.span(x - 1.3, 1.65, pz - 0.08, x + 1.3, 3.15, pz + 0.08, '#15171a');
  k.screens.panel(x, 2.4, pz - 0.09, 2.5, 2.5 / 1.778, 0, '#ffffff', boards.screens.gate[g.gate]);
  const num = gateNumber(atlas, g.gate);
  k.signs.panel(x, 3.95, pz - 0.09, 1.0 * num.aspect, 1.0, 0, '#ffffff', num.uv);
  k.signs.panel(x, 3.95, pz + 0.09, 1.0 * num.aspect, 1.0, Math.PI, '#ffffff', num.uv);
  col.cylinders.push({ x: x - 1.35, z: pz, r: 0.25, h: 4.6 }, { x: x + 1.35, z: pz, r: 0.25, h: 4.6 });
}

/** The boarding area: glass screens round the escalator and stair up to the bridge's doorway. */
function boardingArea(k: TerminalKits, g: GatePlan, col: Collision): V3[] {
  const sx = g.sx;
  const p = g.pen;
  const H = 2.3;
  // glass screens with a steel top rail, a door with two e-gates in the north side
  const screen = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 1.6));
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 1) / n;
      const ax = x0 + (x1 - x0) * a;
      const az = z0 + (z1 - z0) * a;
      const bx = x0 + (x1 - x0) * b;
      const bz = z0 + (z1 - z0) * b;
      k.glass.quad({ x: ax, y: FLOOR_Y, z: az }, { x: bx, y: FLOOR_Y, z: bz }, { x: bx, y: H, z: bz }, { x: ax, y: H, z: az }, '#ffffff');
      k.metal.bar({ x: ax, y: FLOOR_Y, z: az }, { x: ax, y: H, z: az }, 0.025, '#c3c9cf', 4);
    }
    k.metal.beam({ x: x0, y: H, z: z0 }, { x: x1, y: H, z: z1 }, 0.06, 0.06, '#c3c9cf');
    col.walls.push({ x0, z0, x1, z1, h: 2.3 });
  };
  screen(p.x0, p.z0, g.penDoor.x0, p.z0);
  screen(g.penDoor.x1, p.z0, p.x1, p.z0);
  screen(p.x0, p.z0, p.x0, p.z1);
  screen(p.x1, p.z0, p.x1, p.z1);
  for (const x of [g.penDoor.x0 + 0.25, g.penDoor.x1 - 0.25]) {
    k.interior.span(x - 0.15, FLOOR_Y, p.z0 - 0.4, x + 0.15, 1.05, p.z0 + 0.4, '#d8dce0');
    k.emitter.box(x, 1.06, p.z0 - 0.3, 0.2, 0.02, 0.12, '#58e08f');
  }

  // the escalator and stair, eastward down from the top landing at the bridge's level
  const E = ESCALATOR;
  const top = sx + E.topX;
  const foot = sx + E.footX;
  const land0 = sx + E.landX0;
  const f = ROTUNDA_FLOOR;
  const zc = (E.z0 + E.z1) / 2;
  // the top landing (a slab on a solid, panelled base), its balustrade. The base is clad in
  // stone-grey panels with dark joints over a dark plinth, under a steel fascia at the slab's edge
  // (a plain pale box here read as an untextured block from the gate window).
  const kick = 0.14;
  const fascia = 0.26;
  const z1 = AIR_Z - 0.1;
  k.interior.span(land0, FLOOR_Y, E.stairZ0, top, f - fascia, z1, '#b5aea3');
  k.interior.span(land0 - 0.015, FLOOR_Y, E.stairZ0 - 0.015, top, FLOOR_Y + kick, z1, '#3a3f45');
  k.metal.span(land0 - 0.03, f - fascia, E.stairZ0 - 0.03, top, f, z1, '#c3c9cf');
  const joint = '#7b766e';
  const panels = (n: number) => Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
  // on the north face (the lounge's side) and both ends, vertical joints every 1.1 m or so, and one across
  for (const a of panels(Math.max(2, Math.round((top - land0) / 1.1)))) {
    const x = land0 + (top - land0) * a;
    k.interior.span(x - 0.012, FLOOR_Y + kick, E.stairZ0 - 0.012, x + 0.012, f - fascia, E.stairZ0, joint);
  }
  const midY = (FLOOR_Y + kick + f - fascia) / 2;
  for (const [xa, xb] of [[land0 - 0.012, land0], [top, top + 0.012]]) {
    for (const a of panels(Math.max(2, Math.round((z1 - E.stairZ0) / 1.1)))) {
      const z = E.stairZ0 + (z1 - E.stairZ0) * a;
      k.interior.span(xa, FLOOR_Y + kick, z - 0.012, xb, f - fascia, z + 0.012, joint);
    }
    k.interior.span(xa, midY - 0.012, E.stairZ0, xb, midY + 0.012, z1, joint);
  }
  k.interior.span(land0, midY - 0.012, E.stairZ0 - 0.012, top, midY + 0.012, E.stairZ0, joint);
  k.floor.floor(land0, E.stairZ0, top, AIR_Z - 0.1, f + 0.01, '#ddd6ca');
  k.floor.worldUvXZ(k.floor.vertexCount - 4, 2.4);
  k.glass.quad({ x: land0, y: f, z: E.stairZ0 }, { x: top, y: f, z: E.stairZ0 }, { x: top, y: f + 1.05, z: E.stairZ0 }, { x: land0, y: f + 1.05, z: E.stairZ0 }, '#ffffff');
  k.metal.bar({ x: land0, y: f + 1.08, z: E.stairZ0 }, { x: top, y: f + 1.08, z: E.stairZ0 }, 0.03, '#c3c9cf');
  // the escalator's truss, steps and balustrades with black handrails
  const rise = (x: number) => f * ((foot - x) / (foot - top));
  k.metal.beam({ x: foot + 0.6, y: -0.35, z: zc }, { x: top - 0.6, y: f - 0.35, z: zc }, 1.7, 0.9, '#c9ced4');
  for (let i = 0; i < 24; i++) {
    const xa = foot - ((foot - top) * i) / 24;
    const xb = foot - ((foot - top) * (i + 1)) / 24;
    k.interior.quad({ x: xa, y: rise(xa) + 0.03, z: E.z1 - 0.2 }, { x: xb, y: rise(xb) + 0.03, z: E.z1 - 0.2 }, { x: xb, y: rise(xb) + 0.03, z: E.z0 + 0.2 }, { x: xa, y: rise(xa) + 0.03, z: E.z0 + 0.2 }, i % 2 ? '#3b4046' : '#2c3035');
  }
  k.interior.floor(foot, E.z0 + 0.2, foot + 0.9, E.z1 - 0.2, FLOOR_Y + 0.03, '#9aa0a6');
  for (const z of [E.z0 + 0.05, E.z1 - 0.05]) {
    k.glass.quad({ x: foot + 0.9, y: 0.2, z }, { x: top, y: f + 0.2, z }, { x: top, y: f + 1.05, z }, { x: foot + 0.9, y: 1.05, z }, '#ffffff');
    k.interior.bar({ x: foot + 0.9, y: 1.05, z }, { x: top, y: f + 1.05, z }, 0.045, '#101215', 6);
  }
  // the stair alongside: steps, stringers, a balustrade on its open side
  const steps = 20;
  for (let i = 0; i < steps; i++) {
    const xa = foot - ((foot - top) * i) / steps;
    const y = (f * (i + 1)) / steps;
    k.interior.span(xa - (foot - top) / steps, y - 0.18, E.stairZ0, xa, y, E.stairZ1, i % 2 ? '#d6d0c6' : '#cfc8bd');
  }
  k.glass.quad({ x: foot, y: 0.2, z: E.stairZ0 }, { x: top, y: f + 0.2, z: E.stairZ0 }, { x: top, y: f + 1.05, z: E.stairZ0 }, { x: foot, y: 1.05, z: E.stairZ0 }, '#ffffff');
  k.metal.bar({ x: foot, y: 1.05, z: E.stairZ0 }, { x: top, y: f + 1.05, z: E.stairZ0 }, 0.03, '#c3c9cf');
  col.blocks.push({ x0: land0, z0: E.stairZ0 - 0.1, x1: foot - 0.2, z1: AIR_Z - 0.05, h: 3.6 });

  // the passengers' way up, to the doorway in the facade
  return [
    { x: g.foot.x, y: 0, z: g.foot.z },
    { x: foot, y: 0, z: zc },
    { x: top, y: f, z: zc },
    { x: g.doorwayX, y: f, z: zc + 0.3 },
    { x: g.doorwayX, y: f, z: AIR_Z + 0.2 },
  ];
}

export interface GateResult {
  seats: Record<number, Seat[]>;
  /** Each gate's walkway up to its bridge (the jet bridge's `entry`). */
  entries: Record<number, V3[]>;
  boardingQueue: V2[];
  arrivalsPath: V2[];
}

/** The six gate lounges. */
export function buildGates(ctx: Ctx, k: TerminalKits, boards: FlightBoards, col: Collision, place: Placer): GateResult {
  const atlas = signAtlas(ctx);
  const seats: Record<number, Seat[]> = {};
  const entries: Record<number, V3[]> = {};
  GATES.forEach((g, gi) => {
    const list: Seat[] = [];
    const ex = exclusions(g);
    const rows: [number, string][] = [
      [517.2, 'n'],
      [519.9, 'n'],
      [522.6, 'n'],
      [531.6, 's'],
      [534.3, 's'],
      [537.0, 's'],
    ];
    rows.forEach(([z], ri) => {
      const cuts: [number, number][] = [];
      for (const e of ex) if (z + 0.35 > e.z0 && z - 0.4 < e.z1) cuts.push([e.x0, e.x1]);
      for (const c of COLUMNS) if (Math.abs(c.z - z) < 1.4) cuts.push([c.x - 1.3, c.x + 1.3]);
      for (const [a, b] of freeSpans(g.sx - 27, g.sx + 27, cuts)) seatRow(k, a + 0.2, b - 0.2, z, UPHOLSTERY[(gi + ri) % UPHOLSTERY.length], list, col);
    });
    seats[g.gate] = list;
    gateDesk(k, g, atlas, boards, col);
    entries[g.gate] = boardingArea(k, g, col);
    // the gate's sign over the lounge, hung at the concourse's edge
    const sign = wayfinding(atlas, ['gate', `Gate ${g.gate}`], { location: true, height: 96 });
    place.hang(k, sign, g.sx, 4.6, 516.4, 0.75, 0, true);
    // a pot plant either side of the desk
    place.plant(k, g.sx - 6, 527.6, 'pot');
    place.plant(k, g.sx + 6, 527.6, 'pot');
  });

  // gate 3 (the player's flight): the queue past the desk to the boarding door, and the walk off an arriving flight
  const g3 = GATES.find((g) => g.gate === 3)!;
  const sx = g3.sx;
  const doorX = (g3.penDoor.x0 + g3.penDoor.x1) / 2;
  const boardingQueue: V2[] = [
    { x: sx - 3, z: 524.2 },
    { x: sx - 3, z: 527.4 },
    { x: doorX, z: g3.pen.z0 - 0.6 },
    { x: doorX, z: g3.pen.z0 + 1.2 },
    { x: g3.foot.x + 0.6, z: 535.4 },
    { x: g3.foot.x, z: g3.foot.z },
  ];
  const arrivalsPath: V2[] = [
    { x: g3.foot.x, z: g3.foot.z },
    { x: g3.foot.x + 0.6, z: 535.4 },
    { x: doorX, z: g3.pen.z0 + 1.2 },
    { x: doorX, z: g3.pen.z0 - 0.6 },
    { x: doorX, z: 515.3 },
    { x: RECLAIM.entryX + 3, z: 515.3 },
    { x: RECLAIM.entryX, z: 513.4 },
    { x: RECLAIM.entryX, z: 509 },
    { x: -92, z: 494 },
    { x: RECLAIM.exitX, z: 475 },
    { x: RECLAIM.exitX, z: 466 },
    { x: -106, z: 452 },
  ];
  return { seats, entries, boardingQueue, arrivalsPath };
}

/** The airside facade's gate numbers, outside above each doorway (for the apron and the cockpit). */
export function facadeNumbers(ctx: Ctx, k: TerminalKits) {
  const atlas = signAtlas(ctx);
  for (const g of GATES) {
    const num = gateNumber(atlas, g.gate);
    k.signs.panel(g.doorwayX, 8.6, AIR_Z + 0.3, 2.2 * num.aspect, 2.2, Math.PI, '#ffffff', num.uv);
    k.metal.span(g.doorwayX - 0.95, 7.4, AIR_Z + 0.2, g.doorwayX + 0.95, 9.8, AIR_Z + 0.28, '#2b2f34');
  }
}

/** Re-exported for the interior's own signs. */
export { DESK_Z };
