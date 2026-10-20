// Furnishing Funfair International's halls: the check-in islands with their desks, bag belts and
// queue lanes, security's lanes with the X-ray tunnels and walk-through arches, the shops, cafés
// and the food court, the duty-free walk-through, the information desk, baggage reclaim with its
// carousels, the meeting point and car hire, the flight boards, the wayfinding signs hung from the
// roof, the plants, and the escalators up to the mezzanines (a look only: everything walkable is
// on the ground floor). Also the colliders that go with all of it and the spots the crowd uses.

import type { Ctx } from '../context';
import { FlightBoards } from './boards';
import { airlineHeader, fascia, islandEnd, lettering, poster, signAtlas, smallNumber, wayfinding, type PaintedSign, type SignAtlas } from './terminal-signs';
import { seeded, type V2 } from './terminal-kit';
import type { TerminalKits } from './terminal-shell';
import {
  ARCH_W,
  BELTS,
  CHECKIN,
  DOORS,
  DUTY_FREE,
  FLOOR_Y,
  INFO_DESK,
  LAND_Z,
  MEZZ_UNDER,
  MEZZANINES,
  RECLAIM,
  SECURITY,
  TERM,
  UNITS,
  archX,
  roofUnder,
  type Unit,
} from './terminal-plan';

/** Footprints the visitor and the crowd bump into: blocks (x0..x1, z0..z1, up to h) and walls (a line, 0.3 m thick). */
export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  h: number;
}
export interface Collision {
  blocks: Footprint[];
  walls: Footprint[];
  cylinders: { x: number; z: number; r: number; h: number }[];
}

const WALL = '#ece8e1';
const STEEL = '#a9b0b7';
const DARK = '#2b2f34';
const LEAF = ['#3f7d3a', '#4f8f43', '#356b34', '#5b9a4a'];

/** The height of whatever is overhead at (x, z): a mezzanine's underside, or the roof's ceiling. */
export function ceilingAt(x: number, z: number) {
  for (const m of MEZZANINES) if (x > m.x0 && x < m.x1 && z > m.z0 && z < m.z1) return MEZZ_UNDER;
  return roofUnder(x, z);
}

/** The direction a facing (radians, 0 = north) looks along, and the panel's width axis. */
function axes(facing: number) {
  return { nx: Math.sin(facing), nz: -Math.cos(facing), wx: Math.cos(facing), wz: Math.sin(facing) };
}

/**
 * Puts signs and plants into the kits: signs hang on rods from the ceiling (or stand on a post),
 * plants sit in pots, planters or big tree tubs.
 */
export class Placer {
  private readonly rnd = seeded(77);

  /** A sign `h` tall hung with its centre at (x, y, z), facing `facing`; `both` paints its back too. */
  hang(k: TerminalKits, sign: PaintedSign, x: number, y: number, z: number, h: number, facing: number, both = false) {
    const w = h * sign.aspect;
    const a = axes(facing);
    k.metal.box(x, y, z, w + 0.12, h + 0.12, 0.1, DARK, -facing);
    k.signs.panel(x + a.nx * 0.052, y, z + a.nz * 0.052, w, h, facing, '#ffffff', sign.uv);
    if (both) k.signs.panel(x - a.nx * 0.052, y, z - a.nz * 0.052, w, h, facing + Math.PI, '#ffffff', sign.uv);
    // two rods up to whatever is overhead
    for (const s of [-1, 1]) {
      const rx = x + a.wx * s * w * 0.38;
      const rz = z + a.wz * s * w * 0.38;
      const top = ceilingAt(rx, rz);
      if (top > y + h / 2 + 0.05) k.metal.bar({ x: rx, y: y + h / 2, z: rz }, { x: rx, y: top, z: rz }, 0.02, STEEL, 4);
    }
  }

  /** A sign on a slim totem standing on the floor (its top at `top`). */
  totem(k: TerminalKits, sign: PaintedSign, x: number, z: number, h: number, top: number, facing: number, col: Collision) {
    const w = h * sign.aspect;
    const a = axes(facing);
    k.metal.box(x, top / 2, z, w + 0.16, top, 0.22, DARK, -facing);
    for (const s of [1, -1]) {
      const f = s > 0 ? facing : facing + Math.PI;
      k.signs.panel(x + a.nx * 0.112 * s, top - h / 2 - 0.08, z + a.nz * 0.112 * s, w, h, f, '#ffffff', sign.uv);
    }
    col.blocks.push({ x0: x - Math.abs(a.wx) * w / 2 - 0.15, x1: x + Math.abs(a.wx) * w / 2 + 0.15, z0: z - Math.abs(a.wz) * w / 2 - 0.15, z1: z + Math.abs(a.wz) * w / 2 + 0.15, h: top });
  }

  /** A plant: 'pot' (a round pot of leaves), 'tree' (a ficus in a big tub), 'bed' (a long planter, `len` along x). */
  plant(k: TerminalKits, x: number, z: number, kind: 'pot' | 'tree' | 'bed', len = 4) {
    const r = this.rnd;
    const leaf = () => LEAF[Math.floor(r() * LEAF.length)];
    if (kind === 'pot') {
      k.interior.cyl(x, FLOOR_Y, z, 0.32, 0.42, 0.7, '#e7e2da', 14);
      k.interior.cyl(x, 0.7, z, 0.38, 0.38, 0.03, '#4a3a2a', 14);
      for (let i = 0; i < 4; i++) k.interior.blob(x + (r() - 0.5) * 0.4, 1.05 + r() * 0.35, z + (r() - 0.5) * 0.4, 0.34 + r() * 0.12, 0.42, 0.34 + r() * 0.12, leaf(), true);
      return;
    }
    if (kind === 'tree') {
      k.interior.cyl(x, FLOOR_Y, z, 0.95, 0.95, 0.75, '#d9d3c9', 18);
      k.interior.cyl(x, 0.75, z, 0.9, 0.9, 0.03, '#4a3a2a', 18);
      k.interior.cyl(x, 0.75, z, 0.09, 0.07, 2.6, '#6b4f36', 8);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const d = 0.3 + r() * 0.5;
        k.interior.blob(x + Math.cos(a) * d, 2.9 + r() * 1.1, z + Math.sin(a) * d, 0.6 + r() * 0.25, 0.55, 0.6 + r() * 0.25, leaf());
      }
      return;
    }
    k.interior.span(x - len / 2, FLOOR_Y, z - 0.45, x + len / 2, 0.55, z + 0.45, '#d9d3c9');
    for (let px = x - len / 2 + 0.35; px < x + len / 2 - 0.2; px += 0.55) k.interior.blob(px, 0.75 + r() * 0.15, z + (r() - 0.5) * 0.3, 0.38, 0.32 + r() * 0.1, 0.36, leaf(), true);
  }
}

// ------------------------------------------------------------------------------------------------
// Check-in
// ------------------------------------------------------------------------------------------------

/** Who flies from each island (fictional carriers; Funfair Air has the first two). */
const ISLAND_AIRLINES = [
  { title: 'Funfair Air', sub: 'CHECK-IN  ·  BAG DROP  ·  DESKS 1–22', colours: undefined },
  { title: 'Funfair Air', sub: 'CHECK-IN  ·  BAG DROP  ·  DESKS 23–44', colours: undefined },
  { title: 'Lagoon Airways', sub: 'CANDY WINGS  ·  SUNSET AIR  ·  DESKS 45–66', colours: { ink: '#0d4f6b', red: '#2ec4b6', cream: '#f4fbff', gold: '#ffd23f' } },
];

function checkIn(k: TerminalKits, atlas: SignAtlas, place: Placer, col: Collision, spots: V2[]) {
  const C = CHECKIN;
  const pitch = (C.z1 - C.z0) / C.desks;
  let deskNo = 1;
  C.xs.forEach((cx, ii) => {
    const airline = ISLAND_AIRLINES[ii];
    // the island's body under the collector belt, the belt itself and its side guards
    k.interior.span(cx - 0.6, FLOOR_Y, C.z0, cx + 0.6, 0.45, C.z1, '#c9ced4');
    k.interior.span(cx - 0.42, 0.45, C.z0, cx + 0.42, 0.5, C.z1, '#1d1f22');
    for (const s of [-1, 1]) k.metal.span(cx + s * 0.5 - 0.04, 0.45, C.z0, cx + s * 0.5 + 0.04, 0.68, C.z1, STEEL);
    // the bulkhead above the belt: the airline's name both sides, lit desk numbers along its foot
    k.interior.span(cx - 0.18, 2.55, C.z0 - 0.3, cx + 0.18, 3.75, C.z1 + 0.3, airline.colours?.ink ?? '#1d1238');
    for (const post of [C.z0 + 1, (C.z0 + C.z1) / 2, C.z1 - 1]) k.metal.span(cx - 0.12, FLOOR_Y, post - 0.12, cx + 0.12, 2.55, post + 0.12, '#3a3f45');
    const head = airlineHeader(atlas, airline.title, airline.sub, airline.colours);
    const hh = 1.1;
    for (const s of [-1, 1]) {
      const facing = s > 0 ? Math.PI / 2 : -Math.PI / 2;
      for (const zc of [C.z0 + (C.z1 - C.z0) * 0.27, C.z0 + (C.z1 - C.z0) * 0.73]) k.signs.panel(cx + s * 0.185, 3.15, zc, hh * head.aspect, hh, facing, '#ffffff', head.uv);
    }
    // the island's ends: the airline's colour wrapped round, its mark and name on a panel seen down the hall
    for (const z of [C.z0 - 0.3, C.z1 + 0.3]) k.interior.span(cx - 0.6, 2.55, z - 0.02, cx + 0.6, 3.75, z + 0.02, airline.colours?.red ?? '#ff4d6d');
    const end = islandEnd(atlas, airline.title, airline.colours);
    k.signs.panel(cx, 3.15, C.z0 - 0.33, 1.0, 1.0, 0, '#ffffff', end.uv);
    k.signs.panel(cx, 3.15, C.z1 + 0.33, 1.0, 1.0, Math.PI, '#ffffff', end.uv);
    // the desks either side
    for (const s of [-1, 1]) {
      const facing = s > 0 ? Math.PI / 2 : -Math.PI / 2;
      for (let i = 0; i < C.desks; i++) {
        const z = C.z0 + pitch * (i + 0.5);
        const dx = cx + s * (C.half - 0.38);
        // the counter (front panel in the airline's colour, pale top), the bag scale and its feed belt in to the collector
        k.interior.span(dx - 0.36, FLOOR_Y, z - 0.62, dx + 0.36, 1.02, z + 0.25, '#f4f2ee');
        k.interior.span(dx + s * 0.34, 0.08, z - 0.6, dx + s * 0.37, 0.98, z + 0.23, airline.colours?.ink ?? '#1d1238');
        k.interior.span(dx + s * 0.375, 0.6, z - 0.6, dx + s * 0.38, 0.72, z + 0.23, airline.colours?.red ?? '#ff4d6d');
        k.interior.span(dx - 0.4, 1.02, z - 0.66, dx + 0.4, 1.06, z + 0.29, '#d9d4cc');
        k.metal.span(cx + s * 0.55, 0.32, z + 0.32, cx + s * (C.half + 0.05), 0.4, z + 1.12, '#4d545b');
        k.interior.span(cx + s * 0.55, 0.4, z + 0.36, cx + s * (C.half + 0.05), 0.43, z + 1.08, '#1d1f22');
        // the agent's screen, printer and chair
        k.interior.box(dx - s * 0.1, 1.28, z - 0.2, 0.05, 0.34, 0.48, '#15171a');
        k.interior.box(dx - s * 0.12, 1.12, z + 0.05, 0.28, 0.12, 0.22, '#d6d9dc');
        k.interior.cyl(dx - s * 0.95, FLOOR_Y, z - 0.2, 0.22, 0.22, 0.5, '#3a3f45', 8);
        k.interior.box(dx - s * 0.95, 0.62, z - 0.2, 0.46, 0.08, 0.46, '#2f4f7a');
        // the desk's number in a little light box on the bulkhead's foot
        const num = smallNumber(atlas, deskNo);
        k.signs.panel(cx + s * 0.185, 2.3, z, 0.42 * num.aspect, 0.42, facing, '#ffffff', num.uv);
        k.metal.box(cx + s * 0.12, 2.3, z, 0.12, 0.48, 0.42 * num.aspect + 0.06, DARK);
        spots.push({ x: cx + s * (C.half + 0.65), z: z - 0.1 });
        deskNo++;
      }
    }
    col.blocks.push({ x0: cx - C.half, z0: C.z0 - 0.35, x1: cx + C.half, z1: C.z1 + 0.35, h: 1.2 });
    // the queue lanes in front of each side: rows of belt posts, the belts leaving a gap at alternate ends
    for (const s of [-1, 1]) {
      const qx0 = cx + s * (C.half + 1.7);
      const rows = 4;
      const zA = C.z0 + 2;
      const zB = C.z1 - 2;
      for (let j = 0; j < rows; j++) {
        const x = qx0 + s * j * 1.6;
        const posts: number[] = [];
        for (let z = zA; z <= zB + 1e-6; z += (zB - zA) / 9) posts.push(z);
        posts.forEach((z, pi) => {
          k.metal.cyl(x, FLOOR_Y, z, 0.17, 0.17, 0.03, '#3a3f45', 8);
          k.metal.bar({ x, y: FLOOR_Y, z }, { x, y: 0.98, z }, 0.035, '#c3c9cf', 4);
          // the belt to the next post, except at the end the lane turns round
          const next = posts[pi + 1];
          const gapEnd = j % 2 === 0 ? pi === posts.length - 2 : pi === 0;
          if (next !== undefined && !(gapEnd && j < rows - 1)) k.interior.span(x - 0.012, 0.86, z, x + 0.012, 0.93, next, airline.colours?.red ?? '#ff4d6d');
        });
      }
      const xa = qx0 - s * 0.1;
      const xb = qx0 + s * ((rows - 1) * 1.6 + 0.1);
      col.blocks.push({ x0: Math.min(xa, xb), z0: zA - 0.2, x1: Math.max(xa, xb), z1: zB + 0.2, h: 1.0 });
    }
  });
  // the check-in zone's sign over the walk in from the doors
  place.hang(k, wayfinding(atlas, ['checkin', 'Check-in', 'Desks 1–66'], { location: true, height: 80 }), 154, 5.2, 446, 0.8, 0, true);
}

// ------------------------------------------------------------------------------------------------
// Security
// ------------------------------------------------------------------------------------------------

function security(k: TerminalKits, atlas: SignAtlas, place: Placer, col: Collision, spots: V2[]) {
  const S = SECURITY;
  const lanes = S.lanes;
  const xA = lanes[0] - 4;
  const xB = lanes[lanes.length - 1] + 6;
  const rnd = seeded(13);
  for (const lx of lanes) {
    // divest tables and roller beds north of the tunnel, the X-ray tunnel, the reclaim rollers south of it
    k.metal.span(lx - 0.5, FLOOR_Y, S.z0 + 0.6, lx + 0.5, 0.82, S.screenZ - 1.6, '#c9ced4');
    for (let z = S.z0 + 0.7; z < S.screenZ - 1.7; z += 0.18) k.metal.box(lx, 0.84, z, 0.92, 0.04, 0.05, '#7d858d');
    k.interior.span(lx - 0.75, FLOOR_Y, S.screenZ - 1.6, lx + 0.75, 1.75, S.screenZ + 1.6, '#e3e6e9');
    k.interior.span(lx - 0.5, 0.8, S.screenZ - 1.62, lx + 0.5, 1.45, S.screenZ - 1.6, '#1d1f22');
    k.interior.span(lx - 0.5, 0.8, S.screenZ + 1.6, lx + 0.5, 1.45, S.screenZ + 1.62, '#1d1f22');
    k.interior.span(lx - 0.77, 1.3, S.screenZ - 1.4, lx - 0.75, 1.5, S.screenZ + 1.4, '#2e7dd6');
    k.metal.span(lx - 0.5, FLOOR_Y, S.screenZ + 1.6, lx + 0.5, 0.82, S.z1 - 0.4, '#c9ced4');
    for (let z = S.screenZ + 1.7; z < S.z1 - 0.5; z += 0.18) k.metal.box(lx, 0.84, z, 0.92, 0.04, 0.05, '#7d858d');
    // grey trays waiting on the rollers
    for (let i = 0; i < 4; i++) {
      const z = S.z0 + 1.2 + i * 1.1 + rnd() * 0.3;
      if (z < S.screenZ - 2.1) k.interior.span(lx - 0.36, 0.86, z - 0.28, lx + 0.36, 0.96, z + 0.28, '#6c737a');
    }
    for (let i = 0; i < 3; i++) {
      const z = S.screenZ + 2.1 + i * 1.3;
      k.interior.span(lx - 0.36, 0.86, z - 0.28, lx + 0.36, 0.96, z + 0.28, '#6c737a');
      if (rnd() < 0.7) k.interior.box(lx + (rnd() - 0.5) * 0.2, 1.06, z, 0.4, 0.18, 0.3, ['#2d3748', '#7b5cd6', '#c9304f', '#2ec4b6'][Math.floor(rnd() * 4)]);
    }
    // the operator's screen at the tunnel's exit
    k.interior.span(lx - 1.35, FLOOR_Y, S.screenZ + 1.8, lx - 0.85, 1.0, S.screenZ + 2.6, '#3a3f45');
    k.interior.box(lx - 1.1, 1.25, S.screenZ + 2.2, 0.06, 0.38, 0.55, '#15171a');
    // the walk-through arch, its indicator lights on top
    const ax = archX(lx);
    const half = ARCH_W / 2;
    for (const s of [-1, 1]) k.interior.span(ax + s * half, FLOOR_Y, S.screenZ - 0.32, ax + s * (half + 0.16), 2.2, S.screenZ + 0.32, '#d8dce0');
    k.interior.span(ax - half - 0.16, 2.2, S.screenZ - 0.32, ax + half + 0.16, 2.42, S.screenZ + 0.32, '#d8dce0');
    k.emitter.box(ax, 2.43, S.screenZ, 0.5, 0.03, 0.12, '#58e08f');
    // a body scanner beside the arch: a glazed cylinder on a dais
    const bx = lx + 4.7;
    k.interior.cyl(bx, FLOOR_Y, S.screenZ, 1.05, 1.05, 0.08, '#c9ced4', 20);
    k.glass.cyl(bx, 0.08, S.screenZ, 0.95, 0.95, 2.05, '#ffffff', 20);
    k.interior.cyl(bx, 2.13, S.screenZ, 1.05, 1.05, 0.25, '#e3e6e9', 20);
    k.interior.span(bx - 1.05, 0.08, S.screenZ - 0.12, bx - 0.85, 2.13, S.screenZ + 0.12, '#e3e6e9');
    k.interior.span(bx + 0.85, 0.08, S.screenZ - 0.12, bx + 1.05, 2.13, S.screenZ + 0.12, '#e3e6e9');
    // the lane's number on a sign over its entry
    const num = wayfinding(atlas, ['security', String(lanes.indexOf(lx) + 1)], { height: 64 });
    place.hang(k, num, lx + 1.5, 3.4, S.z0 - 0.2, 0.42, 0);
    col.blocks.push({ x0: lx - 0.78, z0: S.z0 + 0.5, x1: lx + 0.78, z1: S.z1 - 0.35, h: 1.8 });
    col.cylinders.push({ x: bx, z: S.screenZ, r: 1.05, h: 2.4 });
    spots.push({ x: lx + 1.5, z: S.z0 - 0.8 });
  }
  // glass partitions between the lanes (the walk is through the arches only), and the screening line
  for (const lx of lanes) {
    const px = lx + 6.5;
    if (px < xB) {
      k.glass.quad({ x: px, y: FLOOR_Y, z: S.z0 + 0.4 }, { x: px, y: FLOOR_Y, z: S.z1 - 0.3 }, { x: px, y: 2.2, z: S.z1 - 0.3 }, { x: px, y: 2.2, z: S.z0 + 0.4 }, '#ffffff');
      k.metal.bar({ x: px, y: 2.2, z: S.z0 + 0.4 }, { x: px, y: 2.2, z: S.z1 - 0.3 }, 0.03, STEEL);
    }
  }
  // the screening line: a glazed screen with gaps at the arches only
  const cuts: [number, number][] = [];
  for (const lx of lanes) {
    cuts.push([lx - 0.78, lx + 0.78]);
    cuts.push([archX(lx) - ARCH_W / 2 - 0.16, archX(lx) + ARCH_W / 2 + 0.16]);
    cuts.push([lx + 3.65, lx + 5.75]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  let s = xA;
  for (const [a, b] of [...cuts, [xB, xB] as [number, number]]) {
    if (a > s + 0.05) {
      k.glass.quad({ x: s, y: FLOOR_Y, z: S.screenZ }, { x: a, y: FLOOR_Y, z: S.screenZ }, { x: a, y: 2.2, z: S.screenZ }, { x: s, y: 2.2, z: S.screenZ }, '#ffffff');
      k.metal.bar({ x: s, y: 2.2, z: S.screenZ }, { x: a, y: 2.2, z: S.screenZ }, 0.03, STEEL);
      col.walls.push({ x0: s, z0: S.screenZ, x1: a, z1: S.screenZ, h: 2.2 });
    }
    s = Math.max(s, b);
  }
  // closing the line off either side, back to the landside partition
  for (const x of [xA, xB]) {
    k.interior.span(x - 0.15, FLOOR_Y, S.z0, x + 0.15, MEZZ_UNDER, S.screenZ, WALL);
    col.walls.push({ x0: x, z0: S.z0, x1: x, z1: S.screenZ, h: 4 });
  }
  // the landside partition: solid wall under the mezzanine either side of the lanes
  const partition = (x0: number, x1: number) => {
    k.interior.span(x0, FLOOR_Y, S.z0 - 0.15, x1, MEZZ_UNDER, S.z0 + 0.15, WALL);
    // a band of the fair's colours at head height, so the long wall reads as part of the fair
    k.interior.span(x0, 2.3, S.z0 - 0.16, x1, 2.42, S.z0 - 0.155, '#ff4d6d');
    k.interior.span(x0, 2.42, S.z0 - 0.16, x1, 2.5, S.z0 - 0.155, '#ffc23d');
    col.walls.push({ x0, z0: S.z0, x1, z1: S.z0, h: 4 });
  };
  partition(-40, xA);
  partition(xB, TERM.x1);
  place.hang(k, wayfinding(atlas, ['security', 'Security', 'gate', 'Gates 1–6', '↓'], { height: 88 }), (xA + xB) / 2, 4.6, S.z0 - 1.2, 0.85, 0);
}

// ------------------------------------------------------------------------------------------------
// Shops, cafés, the food court
// ------------------------------------------------------------------------------------------------

/** A unit's front: its line (a → b, left to right as seen from outside), outward normal and facing. */
function frontOf(u: Unit) {
  switch (u.front) {
    case 'n':
      return { ax: u.x1, az: u.z0, bx: u.x0, bz: u.z0, nx: 0, nz: -1, facing: 0 };
    case 's':
      return { ax: u.x0, az: u.z1, bx: u.x1, bz: u.z1, nx: 0, nz: 1, facing: Math.PI };
    case 'e':
      return { ax: u.x1, az: u.z1, bx: u.x1, bz: u.z0, nx: 1, nz: 0, facing: Math.PI / 2 };
    default:
      return { ax: u.x0, az: u.z0, bx: u.x0, bz: u.z1, nx: -1, nz: 0, facing: -Math.PI / 2 };
  }
}

const MENUS: Record<string, string[]> = {
  'Candy Floss Café': ['Flat white|3.20', 'Candy floss|2.50', 'Toffee latte|3.60', 'Carrot cake|3.90'],
  'Big Top Coffee': ['Espresso|2.40', 'Cappuccino|3.30', 'Iced mocha|3.80', 'Croissant|2.60'],
  'Corn Dog Co.': ['Corn dog|5.50', 'Loaded fries|4.80', 'Onion rings|3.90', 'Lemonade|2.90'],
  'Pizza Wheel': ['Margherita|4.50', 'Pepperoni|5.20', 'Four cheese|5.40', 'Garlic bread|3.20'],
  'Noodle Coaster': ['Chicken ramen|9.80', 'Veggie bowl|8.90', 'Pork bao (2)|6.40', 'Iced tea|2.80'],
  'Fresh Squeeze': ['Orange juice|3.90', 'Berry blast|4.60', 'Green power|4.80', 'Mango lassi|4.20'],
  'Big Top Burgers': ['Ringmaster|9.90', 'Cheeseburger|7.80', 'Veggie stack|8.40', 'Thick shake|4.40'],
};

function unit(k: TerminalKits, atlas: SignAtlas, u: Unit, col: Collision, browse: V2[], rnd: () => number) {
  const underMezz = MEZZANINES.some((m) => (u.x0 + u.x1) / 2 > m.x0 && (u.x0 + u.x1) / 2 < m.x1 && (u.z0 + u.z1) / 2 > m.z0 && (u.z0 + u.z1) / 2 < m.z1);
  const H = underMezz ? MEZZ_UNDER : 4.6;
  const f = frontOf(u);
  const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
  const ux = (f.bx - f.ax) / len;
  const uz = (f.bz - f.az) / len;
  // inward from the front
  const ix = -f.nx;
  const iz = -f.nz;
  const depth = u.front === 'n' || u.front === 's' ? u.z1 - u.z0 : u.x1 - u.x0;
  const at = (s: number, d: number) => ({ x: f.ax + ux * s + ix * d, z: f.az + uz * s + iz * d });
  const i = k.interior;
  // the walls: everything but the front
  const edges: [number, number, number, number, Unit['front']][] = [
    [u.x0, u.z0, u.x1, u.z0, 'n'],
    [u.x0, u.z1, u.x1, u.z1, 's'],
    [u.x1, u.z0, u.x1, u.z1, 'e'],
    [u.x0, u.z0, u.x0, u.z1, 'w'],
  ];
  for (const [x0, z0, x1, z1, side] of edges) {
    if (side === u.front) continue;
    const t = 0.1;
    i.span(Math.min(x0, x1) - (x0 === x1 ? t : 0), FLOOR_Y, Math.min(z0, z1) - (z0 === z1 ? t : 0), Math.max(x0, x1) + (x0 === x1 ? t : 0), H, Math.max(z0, z1) + (z0 === z1 ? t : 0), WALL);
    if (u.kind === 'shop' || u.kind === 'cafe') col.walls.push({ x0, z0, x1, z1, h: 3 });
  }
  // the front's bulkhead: the fascia band in the unit's colours, then wall to the ceiling
  const mid = at(len / 2, 0);
  const box = (s0: number, s1: number, y0: number, y1: number, d0: number, d1: number, colour: string) => {
    const a = at(s0, d0);
    const b = at(s1, d1);
    i.span(a.x, y0, a.z, b.x, y1, b.z, colour);
  };
  box(0, len, 3.3, 4.35, -0.12, 0.12, u.bg);
  if (H > 4.4) box(0, len, 4.35, H, -0.05, 0.12, WALL);
  const sign = fascia(atlas, u.name, u.sub, u.bg, u.fg, u.accent);
  const sh = 0.82;
  k.signs.panel(mid.x + f.nx * 0.13, 3.82, mid.z + f.nz * 0.13, Math.min(len - 0.6, sh * sign.aspect), Math.min(len - 0.6, sh * sign.aspect) / sign.aspect, f.facing, '#ffffff', sign.uv);
  // downlights along the inside of the front, glowing at night
  for (let s = 1.5; s < len - 1; s += 2.5) {
    const p = at(s, 1.2);
    k.emitter.cyl(p.x, 3.26, p.z, 0.14, 0.14, 0.03, '#fff1d6', 8);
  }

  if (u.kind === 'toilets') {
    // a tiled front with two entrances (screened from view by a return wall), the pictogram over each
    box(0, len, FLOOR_Y, 3.3, 0, 0.18, '#d8dde2');
    const pict = wayfinding(atlas, ['toilets'], { location: true, height: 96 });
    for (const s of [len * 0.3, len * 0.7]) {
      box(s - 0.8, s + 0.8, FLOOR_Y, 2.3, -0.01, 0.19, '#2a2e33');
      box(s - 1.3, s + 1.3, FLOOR_Y, 2.3, 1.4, 1.6, '#c3cad1');
      const p = at(s, -0.02);
      k.signs.panel(p.x, 2.75, p.z, 0.6, 0.6, f.facing, '#ffffff', pict.uv);
    }
    col.blocks.push({ x0: u.x0, z0: u.z0, x1: u.x1, z1: u.z1, h: 3 });
    return;
  }

  // inside: a floor in the unit's own finish, shelves round the walls
  const floorCol = u.kind === 'food' ? '#c8ccd0' : u.kind === 'cafe' ? '#c9a27a' : '#e6dfd3';
  k.floor.floor(u.x0 + 0.1, u.z0 + 0.1, u.x1 - 0.1, u.z1 - 0.1, FLOOR_Y + 0.006, floorCol);
  k.floor.worldUvXZ(k.floor.vertexCount - 4, 2.4);

  if (u.kind === 'food') {
    // a counter across the whole front, the kitchen behind it: hoods, fryers, the menu boards
    box(0.2, len - 0.2, FLOOR_Y, 1.05, 0.15, 0.85, u.accent);
    box(0.1, len - 0.1, 1.05, 1.1, 0.05, 0.95, '#f4f2ee');
    box(0.4, len - 0.4, 1.1, 1.45, 0.75, 0.8, '#d6e4ea');
    box(0.3, len - 0.3, FLOOR_Y, 0.95, depth - 1.0, depth - 0.15, '#b8bec5');
    box(0.5, len - 0.5, 2.5, 3.2, depth - 1.3, depth - 0.2, '#9aa2aa');
    for (let s = 1.2; s < len - 1; s += 1.8) {
      const p = at(s, depth - 0.6);
      k.metal.box(p.x, 1.1, p.z, 0.8, 0.3, 0.6, '#7d858d');
    }
    const menu = MENUS[u.name];
    if (menu) {
      const m = poster(atlas, u.name, u.name.split(' ')[0], menu, '#1d1238', '#fff5e3', u.bg);
      for (const s of [len * 0.28, len * 0.72]) {
        const p = at(s, depth - 0.12);
        k.signs.panel(p.x, 2.15, p.z, 1.5, 1.5 / m.aspect, f.facing, '#ffffff', m.uv);
      }
    }
    col.blocks.push({ x0: u.x0, z0: u.z0, x1: u.x1, z1: u.z1, h: 1.6 });
    for (const s of [len * 0.3, len * 0.7]) browse.push(at(s, -1.0));
    return;
  }

  if (u.kind === 'cafe') {
    // the counter across the back half, a pastry case and the espresso machine on it, menus behind
    const cd = depth * 0.55;
    box(1.0, len - 1.0, FLOOR_Y, 1.05, cd, cd + 0.8, '#3b2a20');
    box(0.9, len - 0.9, 1.05, 1.1, cd - 0.05, cd + 0.85, '#e9e2d6');
    const caseA = at(len * 0.3, cd + 0.4);
    k.glass.box(caseA.x, 1.35, caseA.z, Math.abs(ux) > 0.5 ? 2.4 : 0.7, 0.5, Math.abs(ux) > 0.5 ? 0.7 : 2.4, '#ffffff');
    for (let n = 0; n < 6; n++) {
      const p = at(len * 0.3 - 0.9 + n * 0.36, cd + 0.4);
      k.interior.blob(p.x, 1.2, p.z, 0.13, 0.08, 0.13, ['#f2c27a', '#c98b5a', '#ffd3e0', '#8a5a3b'][n % 4], true);
    }
    const mach = at(len * 0.62, cd + 0.45);
    k.metal.box(mach.x, 1.38, mach.z, Math.abs(ux) > 0.5 ? 0.9 : 0.55, 0.55, Math.abs(ux) > 0.5 ? 0.55 : 0.9, '#c0c6cc');
    box(0.6, len - 0.6, FLOOR_Y, 2.2, depth - 0.55, depth - 0.12, '#5b4030');
    for (const s of [len * 0.25, len * 0.5, len * 0.75]) {
      const p = at(s, depth - 0.1);
      const menu = poster(atlas, `${u.name}`, u.name.split(' ')[0], MENUS[u.name] ?? [], '#2a1d15', '#fff5e3', u.accent);
      k.signs.panel(p.x, 2.75, p.z, 1.2, 1.2 / menu.aspect, f.facing, '#ffffff', menu.uv);
    }
    const c0 = at(1.0, cd);
    const c1 = at(len - 1.0, cd + 0.85);
    col.blocks.push({ x0: Math.min(c0.x, c1.x), z0: Math.min(c0.z, c1.z), x1: Math.max(c0.x, c1.x), z1: Math.max(c0.z, c1.z), h: 1.1 });
    browse.push(at(len * 0.4, cd - 0.7), at(len * 0.6, cd - 0.7));
    return;
  }

  // a shop: glazed front with a wide opening in the middle, shelves round the walls, display tables
  const open = Math.min(4.5, len * 0.4);
  const s0 = (len - open) / 2;
  const s1 = (len + open) / 2;
  for (const [a, b] of [
    [0.1, s0],
    [s1, len - 0.1],
  ]) {
    const pa = at(a, 0);
    const pb = at(b, 0);
    k.glass.quad({ x: pa.x, y: FLOOR_Y, z: pa.z }, { x: pb.x, y: FLOOR_Y, z: pb.z }, { x: pb.x, y: 3.3, z: pb.z }, { x: pa.x, y: 3.3, z: pa.z }, '#ffffff');
    col.walls.push({ x0: pa.x, z0: pa.z, x1: pb.x, z1: pb.z, h: 3 });
    for (let s = a; s <= b + 0.01; s += (b - a) / Math.max(1, Math.round((b - a) / 1.6))) {
      const p = at(s, 0);
      k.metal.box(p.x, 1.65, p.z, 0.06, 3.3, 0.06, DARK);
    }
    // a window display just behind the glass
    const d0 = at(a + 0.4, 0.4);
    const d1 = at(b - 0.4, 1.0);
    i.span(Math.min(d0.x, d1.x), FLOOR_Y, Math.min(d0.z, d1.z), Math.max(d0.x, d1.x), 0.45, Math.max(d0.z, d1.z), '#f4f2ee');
  }
  const shelf = (sa: number, sb: number, d: number) => {
    // a run of shelving along the line at depth d (from s = sa to sb), backed against the wall
    const n = Math.max(1, Math.round((sb - sa) / 1.2));
    for (let j = 0; j < n; j++) {
      const p = at(sa + ((sb - sa) * (j + 0.5)) / n, d);
      const along = Math.abs(ux) > 0.5;
      const w = (sb - sa) / n - 0.04;
      k.interior.box(p.x, 1.1, p.z, along ? w : 0.5, 2.2, along ? 0.5 : w, '#f1ede6');
      for (let lvl = 0; lvl < 4; lvl++) {
        const colour = ['#ff4d6d', '#ffc23d', '#2ec4b6', '#5a8dee', '#7b5cd6', '#f4f2ee', '#ff8a3d'][Math.floor(rnd() * 7)];
        const y = 0.35 + lvl * 0.48;
        const q = at(sa + ((sb - sa) * (j + 0.5)) / n, d - 0.27);
        k.interior.box(q.x, y + 0.14, q.z, along ? w - 0.1 : 0.1, 0.26, along ? 0.1 : w - 0.1, colour);
      }
    }
  };
  shelf(0.4, len - 0.4, depth - 0.3);
  // display tables down the middle
  for (let s = 2; s < len - 1.5; s += 3.2) {
    const p = at(s, depth * 0.5);
    k.interior.box(p.x, 0.42, p.z, 1.4, 0.84, 1.4, '#c9a27a');
    for (let n = 0; n < 5; n++) k.interior.box(p.x + (rnd() - 0.5) * 1.0, 0.9 + rnd() * 0.08, p.z + (rnd() - 0.5) * 1.0, 0.2, 0.12 + rnd() * 0.1, 0.25, ['#ff4d6d', '#ffc23d', '#2ec4b6', '#5a8dee'][n % 4]);
    col.blocks.push({ x0: p.x - 0.7, z0: p.z - 0.7, x1: p.x + 0.7, z1: p.z + 0.7, h: 0.9 });
    browse.push(at(s, depth * 0.5 - 1.2));
  }
  // the till by the door
  const till = at(s1 + 0.8, 1.6);
  k.interior.box(till.x, 0.52, till.z, 1.6, 1.04, 0.7, u.bg);
  k.interior.box(till.x, 1.15, till.z, 0.4, 0.25, 0.05, '#15171a');
  col.blocks.push({ x0: till.x - 0.8, z0: till.z - 0.8, x1: till.x + 0.8, z1: till.z + 0.8, h: 1.1 });
}

/** Café tables: a round top on a post, two or four chairs round it. */
function table(k: TerminalKits, x: number, z: number, chairs: number, colour: string, col: Collision, rnd: () => number) {
  k.metal.cyl(x, FLOOR_Y, z, 0.28, 0.28, 0.03, DARK, 8);
  k.metal.bar({ x, y: FLOOR_Y, z }, { x, y: 0.72, z }, 0.04, DARK, 4);
  k.interior.cyl(x, 0.72, z, 0.42, 0.42, 0.04, '#f4f2ee', 12);
  for (let c = 0; c < chairs; c++) {
    const a = (c / chairs) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
    const cx = x + Math.cos(a) * 0.72;
    const cz = z + Math.sin(a) * 0.72;
    k.interior.box(cx, 0.45, cz, 0.42, 0.06, 0.42, colour, -a);
    k.interior.box(cx + Math.cos(a) * 0.2, 0.72, cz + Math.sin(a) * 0.2, 0.05, 0.5, 0.4, colour, -a);
    k.metal.bar({ x: cx, y: FLOOR_Y, z: cz }, { x: cx, y: 0.42, z: cz }, 0.03, DARK, 4);
  }
  col.cylinders.push({ x, z, r: 1.0, h: 0.8 });
}

function shopsAndFood(k: TerminalKits, atlas: SignAtlas, place: Placer, col: Collision, browse: V2[]) {
  const rnd = seeded(29);
  for (const u of UNITS) unit(k, atlas, u, col, browse, rnd);
  // the food court's tables, between the kitchens and the concourse
  const chairCols = ['#ff4d6d', '#ffc23d', '#2ec4b6', '#5a8dee'];
  for (let x = 122; x <= 206; x += 4.2)
    for (let z = 497; z <= 509; z += 3.6) table(k, x + (Math.round(z) % 2 ? 1.1 : 0), z, 4, chairCols[Math.floor(rnd() * 4)], col, rnd);
  place.hang(k, wayfinding(atlas, ['food', 'Food court', 'cafe'], { location: true, height: 80 }), 164, 4.2, 511.6, 0.7, Math.PI, true);
  // the espresso bar's tables, and the arrivals café's
  for (let x = -12; x <= 2; x += 3.5) for (const z of [498.5, 502]) table(k, x, z, 2, '#3b2a20', col, rnd);
  for (let x = -82; x <= -64; x += 3.6) table(k, x, 458.5, 2, '#ff4d6d', col, rnd);
  // the toilets' signs, out over the walkways
  place.hang(k, wayfinding(atlas, ['toilets', 'Toilets'], { location: true, height: 80 }), 100, 3.2, 497.6, 0.6, Math.PI);
}

function dutyFree(k: TerminalKits, atlas: SignAtlas, place: Placer, col: Collision, browse: V2[]) {
  const D = DUTY_FREE;
  const rnd = seeded(43);
  // the walk-through's floor: dark, glossy, a gold edge
  k.floor.floor(D.x0, D.z0, D.x1, D.z1, FLOOR_Y + 0.006, '#3b3f4a');
  k.floor.floor(D.x0, D.z0, D.x1, D.z0 + 0.25, FLOOR_Y + 0.008, '#ffc23d');
  k.floor.floor(D.x0, D.z1 - 0.25, D.x1, D.z1, FLOOR_Y + 0.008, '#ffc23d');
  k.floor.worldUvXZ(k.floor.vertexCount - 12, 2.4);
  // gondolas of perfume, chocolate and souvenirs, in two staggered rows so the walk winds through
  const gondola = (x0: number, x1: number, z: number) => {
    k.interior.span(x0, FLOOR_Y, z - 0.5, x1, 0.12, z + 0.5, '#1d1238');
    k.interior.span(x0 + 0.05, 0.12, z - 0.45, x1 - 0.05, 1.45, z + 0.45, '#f4f2ee');
    for (let x = x0 + 0.2; x < x1 - 0.2; x += 0.45)
      for (const s of [-1, 1])
        for (let lvl = 0; lvl < 3; lvl++) {
          const colour = ['#ffd3e0', '#ffc23d', '#7b5cd6', '#c9304f', '#2ec4b6', '#3b2a20', '#e6e9ec'][Math.floor(rnd() * 7)];
          k.interior.panel(x, 0.46 + lvl * 0.4, z + s * 0.455, 0.34, 0.2 + rnd() * 0.08, s > 0 ? Math.PI : 0, colour);
        }
    k.emitter.span(x0 + 0.05, 1.45, z - 0.05, x1 - 0.05, 1.5, z + 0.05, '#fff1d6');
    col.blocks.push({ x0, z0: z - 0.5, x1, z1: z + 0.5, h: 1.5 });
    browse.push({ x: (x0 + x1) / 2, z: z - 1.1 }, { x: (x0 + x1) / 2, z: z + 1.1 });
  };
  gondola(14, 30, 504.6);
  gondola(36, 52, 504.6);
  gondola(58, 74, 504.6);
  gondola(22, 40, 508.6);
  gondola(46, 64, 508.6);
  // perfume counters at the ends with their light boxes
  for (const x of [10, 80]) {
    k.interior.span(x - 1.2, FLOOR_Y, 503.4, x + 1.2, 1.0, 510.6, '#1d1238');
    k.glass.span(x - 1.1, 1.0, 503.6, x + 1.1, 1.4, 510.4, '#ffffff');
    col.blocks.push({ x0: x - 1.2, z0: 503.4, x1: x + 1.2, z1: 510.6, h: 1.4 });
  }
  const title = lettering(atlas, 'Funfair Duty Free', { fg: '#ffc23d', bg: '#1d1238', height: 110 });
  place.hang(k, title, (D.x0 + D.x1) / 2, 4.0, D.z0 + 0.2, 0.9, 0, true);
}

// ------------------------------------------------------------------------------------------------
// The public hall: information, meeting point, car hire; baggage reclaim
// ------------------------------------------------------------------------------------------------

/** A ring of desk (part of an annulus, angles a0..a1, radians from +x towards +z) as a prism. */
function arcBand(cx: number, cz: number, r0: number, r1: number, a0: number, a1: number): V2[] {
  const out: V2[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: cx + Math.cos(a) * r1, z: cz + Math.sin(a) * r1 });
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: cx + Math.cos(a) * r0, z: cz + Math.sin(a) * r0 });
  }
  return out;
}

/** An oval (a stadium) round the long axis z0..z1 at x, `half` wide. */
function stadium(x: number, z0: number, z1: number, half: number): V2[] {
  const out: V2[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = Math.PI + (Math.PI * i) / n;
    out.push({ x: x + Math.cos(a) * half, z: z0 + half + Math.sin(a) * half });
  }
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * i) / n;
    out.push({ x: x + Math.cos(a) * half, z: z1 - half + Math.sin(a) * half });
  }
  return out;
}

function publicHall(k: TerminalKits, atlas: SignAtlas, place: Placer, col: Collision) {
  // the information desk: a ring counter round a pillar carrying the "i"
  const I = INFO_DESK;
  k.interior.prism(arcBand(I.x, I.z, I.r - 0.75, I.r, -Math.PI * 0.95, Math.PI * 0.75), FLOOR_Y, 1.05, '#f4f2ee');
  k.interior.prism(arcBand(I.x, I.z, I.r - 0.8, I.r + 0.06, -Math.PI * 0.95, Math.PI * 0.75), 1.05, 1.1, '#d9d4cc');
  k.interior.prism(arcBand(I.x, I.z, I.r + 0.0, I.r + 0.02, -Math.PI * 0.95, Math.PI * 0.75), 0.5, 0.62, '#ffc23d');
  k.metal.cyl(I.x, FLOOR_Y, I.z, 0.35, 0.35, 4.6, DARK, 14);
  const info = wayfinding(atlas, ['info'], { location: true, height: 128 });
  for (let a = 0; a < 4; a++) {
    const f = (a * Math.PI) / 2;
    const ax = axes(f);
    k.signs.panel(I.x + ax.nx * 0.36, 4.0, I.z + ax.nz * 0.36, 0.7, 0.7, f, '#ffffff', info.uv);
  }
  for (const s of [-1, 1]) k.interior.box(I.x + s * 1.2, 1.25, I.z + 0.6, 0.45, 0.3, 0.05, '#15171a');
  col.cylinders.push({ x: I.x, z: I.z, r: I.r, h: 1.1 });

  // the meeting point: rails out from the reclaim exit, a sign, benches facing the doors
  const R = RECLAIM;
  for (const s of [-1, 1]) {
    const x = R.exitX + s * 4.5;
    k.metal.span(x - 0.03, FLOOR_Y, R.z0 - 7, x + 0.03, 1.0, R.z0 - 0.2, STEEL);
    k.glass.quad({ x, y: 0.1, z: R.z0 - 7 }, { x, y: 0.1, z: R.z0 - 0.2 }, { x, y: 0.95, z: R.z0 - 0.2 }, { x, y: 0.95, z: R.z0 - 7 }, '#ffffff');
    col.walls.push({ x0: x, z0: R.z0 - 7, x1: x, z1: R.z0 - 0.2, h: 1.0 });
  }
  place.hang(k, wayfinding(atlas, ['meeting', 'Meeting point'], { location: true, height: 80 }), R.exitX, 4.0, R.z0 - 7.5, 0.7, Math.PI, true);
  place.hang(k, wayfinding(atlas, ['arrivals', 'Arrivals'], { height: 80 }), R.exitX, 3.85, R.z0 - 0.3, 0.6, 0);
  for (const bx of [-140, -128, -78, -66]) bench(k, bx, 449, col);

  // car hire along the west end
  k.interior.span(-219.5, FLOOR_Y, 446, -216.5, 1.05, 466, '#f4f2ee');
  k.interior.span(-216.6, 0.1, 446, -216.5, 0.95, 466, '#2ec4b6');
  k.interior.span(-219.6, 1.05, 445.8, -216.3, 1.1, 466.2, '#d9d4cc');
  k.interior.span(-219.6, 2.6, 445.8, -219.3, 3.6, 466.2, '#1d1238');
  const carHire = wayfinding(atlas, ['carhire', 'Car hire'], { location: true, height: 80 });
  k.signs.panel(-219.25, 3.1, 456, 0.8 * carHire.aspect, 0.8, Math.PI / 2, '#ffffff', carHire.uv);
  for (let z = 448; z < 465; z += 3.4) k.interior.box(-218.2, 1.28, z, 0.05, 0.34, 0.5, '#15171a');
  col.blocks.push({ x0: -220, z0: 445.8, x1: -216.3, z1: 466.2, h: 1.1 });

  // the main hall's direction signs, for people coming in from the doors (facing north) and going out
  const inbound = [
    { parts: ['←', 'arrivals', 'Arrivals', 'meeting', 'Meeting point'], x: -50 },
    { parts: ['↓', 'security', 'Departures', 'gate', 'Gates 1–6'], x: 22 },
    { parts: ['checkin', 'Check-in 1–66', '→'], x: 86 },
  ];
  for (const s of inbound) place.hang(k, wayfinding(atlas, s.parts, { height: 80 }), s.x, 4.6, 449, 0.72, 0);
  const outbound = [
    { parts: ['↑', 'train', 'SkyLink to the Fair'], x: 22, z: 480 },
    { parts: ['↑', 'taxi', 'bus', 'parking', 'Taxis · Buses · Car park'], x: -100, z: 455 },
    { parts: ['↑', 'train', 'SkyLink', 'taxi', 'Taxis'], x: -160, z: 455 },
  ];
  for (const s of outbound) place.hang(k, wayfinding(atlas, s.parts, { height: 80 }), s.x, 4.6, s.z, 0.72, Math.PI);
  // big trees in tubs and planters across the hall
  for (const [x, z] of [
    [-62, 451],
    [-30, 478],
    [64, 455],
    [64, 478],
    [-190, 452],
    [132, 444.5],
    [176, 444.5],
  ])
    place.plant(k, x, z, 'tree');
  for (const [x, z] of [
    [8, 446],
    [36, 446],
  ])
    place.plant(k, x, z, 'bed', 5);
  for (const [x, z] of [
    [-62, 451],
    [-30, 478],
    [64, 455],
    [64, 478],
    [-190, 452],
    [132, 444.5],
    [176, 444.5],
  ])
    col.cylinders.push({ x, z, r: 0.95, h: 0.8 });
  col.blocks.push({ x0: 5.5, z0: 445.5, x1: 10.5, z1: 446.5, h: 0.6 }, { x0: 33.5, z0: 445.5, x1: 38.5, z1: 446.5, h: 0.6 });
}

function bench(k: TerminalKits, x: number, z: number, col: Collision) {
  k.interior.span(x - 2.2, 0.42, z - 0.3, x + 2.2, 0.48, z + 0.3, '#c9a27a');
  k.interior.span(x - 2.2, 0.48, z + 0.24, x + 2.2, 0.95, z + 0.3, '#c9a27a');
  for (const s of [-1.9, 0, 1.9]) k.metal.span(x + s - 0.04, FLOOR_Y, z - 0.25, x + s + 0.04, 0.42, z + 0.25, DARK);
  col.blocks.push({ x0: x - 2.2, z0: z - 0.35, x1: x + 2.2, z1: z + 0.35, h: 0.95 });
}

function reclaim(k: TerminalKits, atlas: SignAtlas, place: Placer, col: Collision) {
  const rnd = seeded(61);
  for (const b of BELTS) {
    const outer = stadium(b.x, b.z0, b.z1, b.half);
    const inner = stadium(b.x, b.z0 + 1.1, b.z1 - 1.1, b.half - 1.1);
    // the skirt, the steel plates (a ring: the outer prism, the feed island raised in the middle)
    k.metal.prism(outer, FLOOR_Y, 0.36, '#9aa0a6');
    k.interior.prism(stadium(b.x, b.z0 + 0.05, b.z1 - 0.05, b.half - 0.05), 0.36, 0.42, '#3b4046');
    k.interior.prism(inner, 0.42, 0.95, '#d6d9dc');
    k.interior.prism(stadium(b.x, b.z0 + 1.3, b.z1 - 1.3, b.half - 1.3), 0.95, 1.0, '#c3c8cd');
    // suitcases riding round
    for (let n = 0; n < 14; n++) {
      const t = rnd();
      const L = b.z1 - b.z0 - 2 * b.half;
      const per = 2 * L + 2 * Math.PI * (b.half - 0.55);
      let s = t * per;
      let x: number;
      let z: number;
      const r = b.half - 0.55;
      if (s < L) {
        x = b.x + r;
        z = b.z0 + b.half + s;
      } else if ((s -= L) < Math.PI * r) {
        const a = s / r;
        x = b.x + Math.cos(a) * r;
        z = b.z1 - b.half + Math.sin(a) * r;
      } else if ((s -= Math.PI * r) < L) {
        x = b.x - r;
        z = b.z1 - b.half - s;
      } else {
        const a = Math.PI + (s - L) / r;
        x = b.x + Math.cos(a) * r;
        z = b.z0 + b.half + Math.sin(a) * r;
      }
      const colour = ['#2d3748', '#c9304f', '#5a8dee', '#1d1f22', '#ffc23d', '#7b5cd6', '#4b5563'][Math.floor(rnd() * 7)];
      k.interior.box(x, 0.62, z, 0.45, 0.4, 0.7, colour, rnd() * Math.PI);
    }
    // the belt's number on a post at its north end, a flight screen under it
    const num = wayfinding(atlas, ['baggage', String(b.belt)], { location: true, height: 96 });
    const pz = b.z0 - 1.4;
    k.metal.span(b.x - 0.08, FLOOR_Y, pz - 0.08, b.x + 0.08, 3.1, pz + 0.08, DARK);
    k.metal.box(b.x, 2.75, pz, 0.8 * num.aspect + 0.1, 0.9, 0.12, DARK);
    k.signs.panel(b.x, 2.75, pz + 0.065, 0.8 * num.aspect, 0.8, Math.PI, '#ffffff', num.uv);
    k.signs.panel(b.x, 2.75, pz - 0.065, 0.8 * num.aspect, 0.8, 0, '#ffffff', num.uv);
    col.blocks.push({ x0: b.x - b.half, z0: b.z0, x1: b.x + b.half, z1: b.z1, h: 1.0 });
    col.cylinders.push({ x: b.x, z: pz, r: 0.3, h: 3.1 });
  }
  // trolleys parked in a bay by the entry, and the hall's sign
  for (let n = 0; n < 9; n++) {
    const x = -78 + n * 0.32;
    const z = 507.5;
    k.metal.span(x - 0.02, 0.15, z - 0.45, x + 0.02, 0.95, z + 0.45, STEEL);
    k.metal.span(x - 0.25, 0.25, z - 0.4, x + 0.25, 0.28, z + 0.45, STEEL);
  }
  col.blocks.push({ x0: -78.4, z0: 506.9, x1: -75, z1: 508.1, h: 1.0 });
  place.hang(k, wayfinding(atlas, ['baggage', 'Baggage reclaim'], { location: true, height: 80 }), -130, 4.4, R_ENTRY_SIGN_Z, 0.7, Math.PI, true);
  place.hang(k, wayfinding(atlas, ['↑', 'Exit', 'arrivals', 'Arrivals hall'], { height: 80 }), RECLAIM.exitX, 4.0, RECLAIM.z0 + 3.5, 0.6, Math.PI);
  // the concourse's sign towards it, for the walk off an arriving flight
  place.hang(k, wayfinding(atlas, ['←', 'baggage', 'Baggage reclaim', 'Exit'], { height: 80 }), -20, 4.4, 514, 0.66, Math.PI / 2);
}
const R_ENTRY_SIGN_Z = 491;

// ------------------------------------------------------------------------------------------------
// Escalators up to the mezzanines (a look: the visitor stays on the ground floor)
// ------------------------------------------------------------------------------------------------

/** An escalator pair rising along +z from (x0..x1, z0) to height h at z1. */
function escalators(k: TerminalKits, x0: number, x1: number, z0: number, z1: number, h: number, col: Collision) {
  const w = (x1 - x0) / 2;
  for (let e = 0; e < 2; e++) {
    const a = x0 + e * w + 0.15;
    const b = a + w - 0.3;
    const foot = z0 + 1.2;
    const top = z1 - 1.0;
    const rise = (z: number) => (h * (z - foot)) / (top - foot);
    k.metal.beam({ x: (a + b) / 2, y: -0.35, z: foot - 0.4 }, { x: (a + b) / 2, y: h - 0.35, z: top + 0.4 }, b - a + 0.2, 0.9, '#c9ced4');
    for (let i = 0; i < 30; i++) {
      const za = foot + ((top - foot) * i) / 30;
      const zb = foot + ((top - foot) * (i + 1)) / 30;
      k.interior.quad({ x: a + 0.15, y: rise(za) + 0.03, z: za }, { x: b - 0.15, y: rise(za) + 0.03, z: za }, { x: b - 0.15, y: rise(zb) + 0.03, z: zb }, { x: a + 0.15, y: rise(zb) + 0.03, z: zb }, i % 2 ? '#3b4046' : '#2c3035');
    }
    k.interior.floor(a + 0.15, z0, b - 0.15, foot, FLOOR_Y + 0.03, '#9aa0a6');
    for (const x of [a + 0.08, b - 0.08]) {
      k.glass.quad({ x, y: 0.2, z: foot }, { x, y: h + 0.2, z: top }, { x, y: h + 1.05, z: top }, { x, y: 1.05, z: foot }, '#ffffff');
      k.interior.bar({ x, y: 1.05, z: z0 + 0.3 }, { x, y: 1.05, z: foot }, 0.045, '#101215', 6);
      k.interior.bar({ x, y: 1.05, z: foot }, { x, y: h + 1.05, z: top }, 0.045, '#101215', 6);
    }
  }
  col.blocks.push({ x0, z0, x1, z1, h: 1.2 });
}

// ------------------------------------------------------------------------------------------------
// Flight boards and the airside's signs
// ------------------------------------------------------------------------------------------------

function boardsAndSigns(k: TerminalKits, boards: FlightBoards, atlas: SignAtlas, place: Placer, col: Collision) {
  const aspect = FlightBoards.boardAspect;
  const S = boards.screens;
  // the main board gantry in the public hall: departures and arrivals, both sides
  const gz = 468;
  const bh = 3.0;
  const bw = bh * aspect;
  const gx = 22;
  for (const s of [-1, 1]) {
    k.metal.span(gx + s * (bw + 0.6) - 0.15, FLOOR_Y, gz - 0.15, gx + s * (bw + 0.6) + 0.15, 7.4, gz + 0.15, DARK);
    col.cylinders.push({ x: gx + s * (bw + 0.6), z: gz, r: 0.3, h: 4 });
  }
  k.metal.span(gx - bw - 0.6, 4.1, gz - 0.25, gx + bw + 0.6, 7.3, gz + 0.25, '#1b1e22');
  for (const [i, uv] of [
    [-1, S.departures],
    [1, S.arrivals],
  ] as const) {
    k.screens.panel(gx + i * (bw / 2 + 0.15), 5.7, gz - 0.26, bw, bh, 0, '#ffffff', uv);
    k.screens.panel(gx - i * (bw / 2 + 0.15), 5.7, gz + 0.26, bw, bh, Math.PI, '#ffffff', uv);
  }
  // the arrivals hall's board on the reclaim hall's wall, for those waiting at the meeting point
  k.metal.span(-136 - 0.1, 2.2, RECLAIM.z0 - 0.32, -136 + 2.6 * aspect + 0.1, 2.2 + 2.6 + 0.2, RECLAIM.z0 - 0.2, '#1b1e22');
  k.screens.panel(-136 + 1.3 * aspect, 3.6, RECLAIM.z0 - 0.33, 2.6 * aspect, 2.6, 0, '#ffffff', S.arrivals);
  // the concourse's departure boards, hung where the walk out of duty free meets it
  for (const x of [45]) {
    k.metal.box(x, 5.1, 513.6, 2.4 * aspect + 0.2, 2.6, 0.3, '#1b1e22');
    k.screens.panel(x, 5.1, 513.44, 2.4 * aspect, 2.4, 0, '#ffffff', S.departures);
    k.screens.panel(x, 5.1, 513.76, 2.4 * aspect, 2.4, Math.PI, '#ffffff', S.departures);
    for (const s of [-1, 1]) {
      const rx = x + s * aspect;
      k.metal.bar({ x: rx, y: 6.4, z: 513.6 }, { x: rx, y: roofUnder(rx, 513.6), z: 513.6 }, 0.03, STEEL, 4);
    }
  }
  // the concourse's direction signs
  place.hang(k, wayfinding(atlas, ['←', 'gate', 'Gates 1–3'], { height: 80 }), 22, 4.4, 513.8, 0.7, 0);
  place.hang(k, wayfinding(atlas, ['gate', 'Gates 4–6', '→'], { height: 80 }), 68, 4.4, 513.8, 0.7, 0);
  place.hang(k, wayfinding(atlas, ['gate', 'Gates 4–6', '→'], { height: 80 }), -60, 4.4, 514.5, 0.66, -Math.PI / 2);
  place.hang(k, wayfinding(atlas, ['←', 'gate', 'Gates 1–3'], { height: 80 }), 100, 4.4, 514.5, 0.66, Math.PI / 2);
  // the mezzanines' fascia lettering, seen across the hall
  const lounge = lettering(atlas, 'Funfair Air Lounge', { fg: '#ffc23d', bg: '#1d1238', height: 96 });
  k.signs.panel(-130, 6.1, MEZZANINES[0].z0 - 0.02, 0.55 * lounge.aspect, 0.55, 0, '#ffffff', lounge.uv);
  const name = lettering(atlas, 'Welcome to Funfair International', { fg: '#1d1238', bg: '#ffc23d', height: 96 });
  k.signs.panel(85, 6.1, MEZZANINES[1].z0 - 0.02, 0.55 * name.aspect, 0.55, 0, '#ffffff', name.uv);
  // planters along the mezzanines' edges, trailing over
  const rnd = seeded(91);
  for (const m of MEZZANINES)
    for (let x = m.x0 + 3; x < m.x1 - 2; x += 6) {
      k.interior.span(x - 1.2, 6.4, m.z0 + 0.4, x + 1.2, 6.9, m.z0 + 1.0, '#d9d3c9');
      for (let j = 0; j < 3; j++) k.interior.blob(x - 0.8 + j * 0.8, 7.05, m.z0 + 0.7, 0.42, 0.3, 0.32, LEAF[Math.floor(rnd() * LEAF.length)], true);
    }
}

// ------------------------------------------------------------------------------------------------
// Everything
// ------------------------------------------------------------------------------------------------

export interface InteriorResult {
  checkIn: V2[];
  security: V2[];
  shops: V2[];
  /** Where people wait in the public hall (the meeting point and the boards). */
  hall: V2[];
}

/** Furnishes the halls into the kits and collects their colliders. */
export function buildInterior(ctx: Ctx, k: TerminalKits, boards: FlightBoards, col: Collision, place: Placer): InteriorResult {
  const atlas = signAtlas(ctx);
  const checkInSpots: V2[] = [];
  const securitySpots: V2[] = [];
  const shops: V2[] = [];
  checkIn(k, atlas, place, col, checkInSpots);
  security(k, atlas, place, col, securitySpots);
  shopsAndFood(k, atlas, place, col, shops);
  dutyFree(k, atlas, place, col, shops);
  publicHall(k, atlas, place, col);
  reclaim(k, atlas, place, col);
  escalators(k, 80, 87, 470, 487, 6.4, col);
  boardsAndSigns(k, boards, atlas, place, col);
  // the facade's lettering over the main doors, inside and out
  const title = lettering(atlas, 'Funfair International', { fg: '#ffffff', bg: '#1d1238', height: 128 });
  k.signs.panel(22, 9.2, LAND_Z - 0.35, 2.4 * title.aspect, 2.4, 0, '#ffffff', title.uv);
  for (const d of DOORS) {
    const s = wayfinding(atlas, [d.kind === 'arrivals' ? 'arrivals' : 'departures', d.kind === 'arrivals' ? 'Arrivals' : 'Departures'], { location: true, height: 80 });
    k.signs.panel(d.x, 4.55, LAND_Z - 4.35, 0.62 * s.aspect, 0.62, 0, '#ffffff', s.uv);
  }
  const hall: V2[] = [
    { x: RECLAIM.exitX - 2, z: 461 },
    { x: RECLAIM.exitX + 2, z: 460 },
    { x: RECLAIM.exitX - 6, z: 458 },
    { x: 18, z: 463 },
    { x: 27, z: 462 },
    { x: 14, z: 474 },
    { x: 30, z: 475 },
  ];
  return { checkIn: checkInSpots, security: securitySpots, shops, hall };
}
