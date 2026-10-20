// Funfair International's building: the long wave of a roof (a timber-slatted ceiling under a
// standing-seam top, skylights over the crests), the tree columns holding it up in the fair's
// colours, the glass curtain walls with their fins and doors, the mezzanine decks, the floors and
// the kerb walk. The interior (terminal-interior.ts) and the gates (terminal-gates.ts) are
// furnished inside this shell.

import * as THREE from 'three';
import type { Kit, KitMaterials } from './terminal-kit';
import {
  AIR_Z,
  COLUMN_COLOURS,
  COLUMNS,
  DOORS,
  FLOOR_Y,
  GATES,
  KERB_COLUMNS,
  KERB_ROAD,
  LAND_Z,
  LINK_W,
  MEZZ_COLUMNS,
  MEZZ_TOP,
  MEZZ_UNDER,
  MEZZANINES,
  RECLAIM,
  ROOF,
  SKYLIGHTS,
  TERM,
  UNITS,
  roofDepth,
  roofUnder,
} from './terminal-plan';
import { ROTUNDA_FLOOR, ROTUNDA_R } from './jet-bridge';

/** The terminal's kits, one per material (see terminal.ts for which mesh each becomes). */
export interface TerminalKits {
  /** Inside: walls, furniture (fill-lit). */
  interior: Kit;
  /** Outside: plinths, kerbs, door canopies, links. */
  exterior: Kit;
  metal: Kit;
  floor: Kit;
  glass: Kit;
  emitter: Kit;
  /** Panels painted from the sign atlas. */
  signs: Kit;
  /** Panels painted from the flight boards' canvas. */
  screens: Kit;
}

const STEEL = '#a9b0b7';
const DARK_STEEL = '#4d545b';
const PLINTH = '#3a3f45';
/** Transoms at 3.3, 6.5, 9.7 and 12.9 m all fit under the roof's lowest point over the facades (14.5 m). */
const LOW_TRANSOMS = 4;

// ------------------------------------------------------------------------------------------------
// The roof (its own geometry: smooth normals, two textured surfaces)
// ------------------------------------------------------------------------------------------------

const GX = 4;
const GZ = 5;

function inSkylight(x: number, z: number) {
  return SKYLIGHTS.some((s) => x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1);
}

/**
 * The roof's two surfaces as grids over its footprint (skylight cells left open): the ceiling
 * (underside, slats running along the building) and the top (seams running down the slope).
 */
export function roofMeshes(m: KitMaterials, shadows: boolean) {
  const nx = Math.round((ROOF.x1 - ROOF.x0) / GX);
  const nz = Math.round((ROOF.z1 - ROOF.z0) / GZ);
  const build = (top: boolean) => {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const y = (x: number, z: number) => roofUnder(x, z) + (top ? roofDepth(z) : 0);
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= nx; i++) {
        const x = ROOF.x0 + i * GX;
        const z = ROOF.z0 + j * GZ;
        pos.push(x, y(x, z), z);
        const dx = (y(x + 0.5, z) - y(x - 0.5, z)) / 1;
        const dz = (y(x, z + 0.5) - y(x, z - 0.5)) / 1;
        const n = new THREE.Vector3(-dx, 1, -dz).normalize();
        if (!top) n.negate();
        nor.push(n.x, n.y, n.z);
        if (top) uv.push(x / 1.2, z / 6);
        else uv.push(z / 1.2, x / 6);
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const cx = ROOF.x0 + (i + 0.5) * GX;
        const cz = ROOF.z0 + (j + 0.5) * GZ;
        if (inSkylight(cx, cz)) continue;
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        // the top faces up, the ceiling down
        if (top) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, top ? m.roof : m.ceiling);
    mesh.castShadow = shadows && top;
    mesh.receiveShadow = shadows && !top;
    mesh.matrixAutoUpdate = false;
    return mesh;
  };
  return { top: build(true), ceiling: build(false) };
}

/** The roof's edges, skylight curbs and glazing, and the ceiling's light lines. */
function roofTrim(k: TerminalKits) {
  const metal = k.metal;
  const edge = (x0: number, z0: number, x1: number, z1: number, lift: number) => {
    // a vertical strip following the roof between two points, facing the right of a → b (seen from above)
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4));
    for (let i = 0; i < n; i++) {
      const xa = x0 + ((x1 - x0) * i) / n;
      const za = z0 + ((z1 - z0) * i) / n;
      const xb = x0 + ((x1 - x0) * (i + 1)) / n;
      const zb = z0 + ((z1 - z0) * (i + 1)) / n;
      const ya = roofUnder(xa, za);
      const yb = roofUnder(xb, zb);
      metal.quad(
        { x: xa, y: ya - 0.05, z: za },
        { x: xb, y: yb - 0.05, z: zb },
        { x: xb, y: yb + roofDepth(zb) + lift, z: zb },
        { x: xa, y: ya + roofDepth(za) + lift, z: za },
        '#d6dade',
      );
    }
  };
  // the outer fascia, wound so each face looks outwards
  edge(ROOF.x1, ROOF.z0, ROOF.x0, ROOF.z0, 0.05);
  edge(ROOF.x1, ROOF.z1, ROOF.x1, ROOF.z0, 0.05);
  edge(ROOF.x0, ROOF.z1, ROOF.x1, ROOF.z1, 0.05);
  edge(ROOF.x0, ROOF.z0, ROOF.x0, ROOF.z1, 0.05);
  for (const s of SKYLIGHTS) {
    // curbs facing into the opening, a glazed top following the wave, and its glazing bars
    edge(s.x1, s.z1, s.x0, s.z1, 0.35);
    edge(s.x1, s.z0, s.x1, s.z1, 0.35);
    edge(s.x0, s.z0, s.x1, s.z0, 0.35);
    edge(s.x0, s.z1, s.x0, s.z0, 0.35);
    const n = Math.round((s.x1 - s.x0) / 2);
    for (let i = 0; i < n; i++) {
      const xa = s.x0 + ((s.x1 - s.x0) * i) / n;
      const xb = s.x0 + ((s.x1 - s.x0) * (i + 1)) / n;
      const top = (x: number, z: number) => roofUnder(x, z) + roofDepth(z) + 0.35;
      k.glass.quad({ x: xa, y: top(xa, s.z1), z: s.z1 }, { x: xb, y: top(xb, s.z1), z: s.z1 }, { x: xb, y: top(xb, s.z0), z: s.z0 }, { x: xa, y: top(xa, s.z0), z: s.z0 }, '#ffffff');
      metal.bar({ x: xa, y: top(xa, s.z0), z: s.z0 }, { x: xa, y: top(xa, s.z1), z: s.z1 }, 0.06, DARK_STEEL, 4);
    }
    // a steel truss spanning each skylight underneath, every 4 m
    for (let x = s.x0 + 2; x < s.x1; x += 4) {
      const ya = roofUnder(x, s.z0);
      const yb = roofUnder(x, s.z1);
      metal.bar({ x, y: ya, z: s.z0 }, { x, y: yb, z: s.z1 }, 0.09, '#eef0f2', 6);
      metal.bar({ x, y: ya - 0.9, z: s.z0 + 1 }, { x, y: yb - 0.9, z: s.z1 - 1 }, 0.06, '#eef0f2', 6);
      for (let t = 0; t <= 4; t++) {
        const zz = s.z0 + 1 + ((s.z1 - s.z0 - 2) * t) / 4;
        const yy = THREE.MathUtils.lerp(ya, yb, (zz - s.z0) / (s.z1 - s.z0));
        metal.bar({ x, y: yy - 0.9, z: zz }, { x, y: yy, z: zz + (t % 2 ? 1 : -1) }, 0.035, '#eef0f2', 4);
      }
    }
  }
  // light lines along the ceiling, following the wave
  for (const z of [452, 462, 490, 518, 528]) {
    for (let x = TERM.x0 + 2; x < TERM.x1 - 2; x += 4) {
      const xb = Math.min(TERM.x1 - 2, x + 4);
      if (inSkylight(x + 2, z)) continue;
      const ya = roofUnder(x, z) - 0.06;
      const yb = roofUnder(xb, z) - 0.06;
      k.emitter.quad({ x, y: ya, z: z - 0.12 }, { x: xb, y: yb, z: z - 0.12 }, { x: xb, y: yb, z: z + 0.12 }, { x, y: ya, z: z + 0.12 }, '#fff1d6');
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Columns
// ------------------------------------------------------------------------------------------------

/** A tree column: a tapering trunk, a crown, and branches reaching up to the ceiling. */
function treeColumn(k: TerminalKits, x: number, z: number, colour: string, reach: number) {
  const m = k.metal;
  m.cyl(x, FLOOR_Y, z, 0.7, 0.7, 0.12, DARK_STEEL, 16);
  m.cyl(x, FLOOR_Y + 0.12, z, 0.55, 0.42, 8.2, colour, 16);
  m.blob(x, 8.6, z, 0.75, 0.6, 0.75, colour);
  const branches: [number, number][] = [
    [-reach, -7],
    [reach, -7],
    [-reach, 7],
    [reach, 7],
    [0, -10],
    [0, 10],
  ];
  for (const [dx, dz] of branches) {
    const tx = x + dx;
    const tz = z + dz;
    const ty = roofUnder(tx, tz) - 0.05;
    m.bar({ x, y: 8.6, z }, { x: tx, y: ty, z: tz }, 0.2, colour, 8);
    m.cyl(tx, ty - 0.12, tz, 0.5, 0.5, 0.12, '#e8e6e0', 10);
  }
  // an uplight ring at its foot
  k.emitter.cyl(x, FLOOR_Y + 0.12, z, 0.62, 0.62, 0.03, '#ffe7c2', 16);
}

function columns(k: TerminalKits) {
  COLUMNS.forEach((c) => {
    const i = Math.round((c.x + 176) / 44);
    treeColumn(k, c.x, c.z, COLUMN_COLOURS[i], 7);
  });
  // the kerb's columns lean their branches back under the overhang only
  for (const c of KERB_COLUMNS) {
    const m = k.metal;
    const col = '#d6dade';
    m.cyl(c.x, 0.05, c.z, 0.45, 0.32, 7.5, col, 14);
    m.blob(c.x, 7.8, c.z, 0.5, 0.42, 0.5, col);
    for (const [dx, dz] of [
      [-6, -6],
      [6, -6],
      [-6, 5],
      [6, 5],
    ]) {
      const tx = c.x + dx;
      const tz = c.z + dz;
      m.bar({ x: c.x, y: 7.8, z: c.z }, { x: tx, y: roofUnder(tx, tz) - 0.05, z: tz }, 0.15, col, 8);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Curtain walls
// ------------------------------------------------------------------------------------------------

/** One facade line from a to b (the outside on the left of a → b, seen from above), with door gaps along it. */
function facade(k: TerminalKits, ax: number, az: number, bx: number, bz: number, bay: number, gaps: { at: number; w: number }[], upper: { at: number; w: number }[]) {
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  // outward normal: left of the direction of travel
  const ox = uz;
  const oz = -ux;
  const n = Math.round(len / bay);
  const pt = (s: number, y: number, out = 0) => ({ x: ax + ux * s + ox * out, y, z: az + uz * s + oz * out });
  const top = (s: number) => {
    const p = pt(s, 0);
    return roofUnder(p.x, p.z) - 0.02;
  };
  const inGap = (s: number) => gaps.find((g) => Math.abs(s - g.at) < g.w / 2);
  for (let i = 0; i < n; i++) {
    const s0 = (len * i) / n;
    const s1 = (len * (i + 1)) / n;
    const mid = (s0 + s1) / 2;
    const door = inGap(mid);
    const y0 = door ? 3.4 : FLOOR_Y + 0.3;
    const up = upper.find((g) => Math.abs(mid - g.at) < g.w / 2 + bay / 2);
    if (up) {
      // the jet bridge's doorway: glazing below and above it, a solid frame round it
      k.glass.quad(pt(s0, y0, 0), pt(s1, y0, 0), pt(s1, 3.3, 0), pt(s0, 3.3, 0), '#ffffff');
      k.glass.quad(pt(s0, 6.4, 0), pt(s1, 6.4, 0), pt(s1, top(s1), 0), pt(s0, top(s0), 0), '#ffffff');
    } else k.glass.quad(pt(s0, y0, 0), pt(s1, y0, 0), pt(s1, top(s1), 0), pt(s0, top(s0), 0), '#ffffff');
    // mullion fin on the inside; a deeper structural fin every fourth
    const big = i % 4 === 0;
    const a = pt(s0, 0, -(big ? 0.4 : 0.15));
    const fy = top(s0);
    k.metal.box(a.x, fy / 2, a.z, Math.abs(ux) > 0.5 ? 0.08 : big ? 0.8 : 0.3, fy, Math.abs(ux) > 0.5 ? (big ? 0.8 : 0.3) : 0.08, big ? '#e4e6e8' : STEEL);
    // the transoms high up, where the roof's wave leaves only some bays tall enough for them
    for (let y = 3.3 + 3.2 * LOW_TRANSOMS; y < Math.min(top(s0), top(s1)) - 0.4; y += 3.2) k.metal.beam(pt(s0, y, -0.06), pt(s1, y, -0.06), 0.12, 0.08, STEEL);
  }
  // the transoms every 3.2 m below the roof's lowest point run the facade's whole length in one piece
  for (let j = 0; j < LOW_TRANSOMS; j++) k.metal.beam(pt(0, 3.3 + 3.2 * j, -0.06), pt(len, 3.3 + 3.2 * j, -0.06), 0.12, 0.08, STEEL);
  // the plinth (dark base strip), interrupted at the doors
  let s = 0;
  const cuts = [...gaps].sort((p, q) => p.at - q.at);
  for (const g of [...cuts, { at: len + 10, w: 0 }]) {
    const e = Math.min(len, g.at - g.w / 2);
    if (e > s) {
      const p0 = pt(s, 0.17, 0.02);
      const p1 = pt(e, 0.17, 0.02);
      k.exterior.beam(p0, p1, 0.18, 0.3, PLINTH);
    }
    s = g.at + g.w / 2;
  }
  return { pt, ux, uz, ox, oz };
}

/** The landside doors: sliding leaves (parked open), a portal and a canopy with the sign above. */
function doors(k: TerminalKits) {
  for (const d of DOORS) {
    const z = LAND_Z;
    const x0 = d.x - d.w / 2;
    const x1 = d.x + d.w / 2;
    // portal
    k.metal.span(x0 - 0.25, FLOOR_Y, z - 0.2, x0, 3.6, z + 0.2, DARK_STEEL);
    k.metal.span(x1, FLOOR_Y, z - 0.2, x1 + 0.25, 3.6, z + 0.2, DARK_STEEL);
    k.metal.span(x0 - 0.25, 3.4, z - 0.25, x1 + 0.25, 3.7, z + 0.25, DARK_STEEL);
    // the leaves slid aside behind the fixed panes, and the sensor box over them
    for (const s of [-1, 1]) {
      const cx = d.x + s * (d.w / 2 - d.w / 8);
      k.glass.panel(cx, 1.75, z + 0.35, d.w / 4, 3.3, 0, '#ffffff');
      k.metal.box(cx, 1.75, z + 0.35, d.w / 4, 3.3, 0.05, '#c0c6cc');
    }
    k.metal.box(d.x, 3.25, z + 0.3, 1.2, 0.18, 0.3, '#2b2f34');
    // the canopy out over the kerb walk, on two posts
    k.exterior.span(x0 - 1.5, 4.0, z - 4.2, x1 + 1.5, 4.25, z, '#e9ecef');
    k.metal.span(x0 - 1.6, 3.9, z - 4.3, x1 + 1.6, 4.0, z + 0.05, '#2b2f34');
    for (const s of [-1, 1]) k.metal.cyl(d.x + s * (d.w / 2 + 1.2), 0.05, z - 3.8, 0.09, 0.09, 3.85, DARK_STEEL, 8);
    k.emitter.floor(x0 - 1.2, z - 3.9, x1 + 1.2, z - 3.6, 3.89, '#fff3dd', undefined, true);
  }
}

function curtainWalls(k: TerminalKits) {
  const gaps = DOORS.map((d) => ({ at: d.x - TERM.x0, w: d.w }));
  // landside: west → east, outside to the north
  facade(k, TERM.x0, LAND_Z, TERM.x1, LAND_Z, 2.75, gaps, []);
  // airside: east → west, outside to the south; the jet bridges' doorways are cut at the upper level
  const upper = GATES.map((g) => ({ at: TERM.x1 - g.doorwayX, w: LINK_W + 0.2 }));
  facade(k, TERM.x1, AIR_Z, TERM.x0, AIR_Z, 2.75, [], upper);
  // the ends
  facade(k, TERM.x1, LAND_Z, TERM.x1, AIR_Z, 2.5, [], []);
  facade(k, TERM.x0, AIR_Z, TERM.x0, LAND_Z, 2.5, [], []);
  doors(k);
}

// ------------------------------------------------------------------------------------------------
// Floors, mezzanines, the reclaim hall's walls, the kerb walk, the bridges' fixed links
// ------------------------------------------------------------------------------------------------

/** Pale terrazzo everywhere, darker bands along the concourse, carpet in the gate lounges. */
function floors(k: TerminalKits) {
  const f = k.floor;
  const from = f.vertexCount;
  const x0 = TERM.x0;
  const x1 = TERM.x1;
  // the base: everything between the facades except the bands laid below
  f.floor(x0, LAND_Z, x1, 511, FLOOR_Y, '#f3efe8');
  f.floor(x0, 511, x1, 512, FLOOR_Y, '#4b5563');
  f.floor(x0, 512, x1, 515, FLOOR_Y, '#d9d2c6');
  f.floor(x0, 515, x1, 516, FLOOR_Y, '#4b5563');
  // the lounges: carpet in front of each gate, terrazzo between them
  let x = x0;
  for (const g of GATES) {
    const c0 = g.sx - 27;
    const c1 = g.sx + 27;
    if (c0 > x) f.floor(x, 516, c0, AIR_Z, FLOOR_Y, '#ece6dc');
    f.floor(c0, 516, c1, AIR_Z, FLOOR_Y, '#5a6b84');
    x = c1;
  }
  f.floor(x, 516, x1, AIR_Z, FLOOR_Y, '#ece6dc');
  // inlays (just above): a compass rose of bands at the main entrance, the security line
  const inlay = FLOOR_Y + 0.008;
  f.floor(-2, 441, 46, 443, inlay, '#ff4d6d');
  f.floor(-2, 443, 46, 444, inlay, '#ffc23d');
  f.floor(20.6, 444, 23.4, 486, inlay, '#4b5563');
  for (const lx of [-20, 64]) f.floor(lx - 0.6, 444, lx + 0.6, 486, inlay, '#cfc6b8');
  f.worldUvXZ(from, 2.4);
}

function mezzanines(k: TerminalKits) {
  for (const m of MEZZANINES) {
    k.interior.span(m.x0, MEZZ_UNDER, m.z0, m.x1, MEZZ_TOP - 0.05, m.z1, '#f4f2ee');
    k.floor.floor(m.x0, m.z0, m.x1, m.z1, MEZZ_TOP, '#ddd6ca');
    k.floor.worldUvXZ(k.floor.vertexCount - 4, 2.4);
    // downlights in rows under the deck
    for (let x = m.x0 + 3; x < m.x1 - 1; x += 6)
      for (let z = m.z0 + 3; z < m.z1 - 1; z += 5) k.emitter.floor(x - 0.17, z - 0.17, x + 0.17, z + 0.17, MEZZ_UNDER - 0.02, '#fff4dc', undefined, true);
  }
  // balustrades along every open edge: glass panes between posts, a steel handrail on top
  const rail = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 2));
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 1) / n;
      const pa = { x: x0 + (x1 - x0) * a, z: z0 + (z1 - z0) * a };
      const pb = { x: x0 + (x1 - x0) * b, z: z0 + (z1 - z0) * b };
      k.glass.quad({ x: pa.x, y: MEZZ_TOP, z: pa.z }, { x: pb.x, y: MEZZ_TOP, z: pb.z }, { x: pb.x, y: MEZZ_TOP + 1.05, z: pb.z }, { x: pa.x, y: MEZZ_TOP + 1.05, z: pa.z }, '#ffffff');
      k.metal.bar({ x: pa.x, y: MEZZ_TOP, z: pa.z }, { x: pa.x, y: MEZZ_TOP + 1.1, z: pa.z }, 0.03, STEEL, 4);
    }
    k.metal.bar({ x: x0, y: MEZZ_TOP + 1.1, z: z0 }, { x: x1, y: MEZZ_TOP + 1.1, z: z1 }, 0.035, '#d7dbdf', 6);
  };
  rail(-220, 470.2, -40, 470.2);
  rail(-220, 511.8, -40, 511.8);
  rail(-40.2, 470.2, -40.2, 487);
  rail(-40.2, 503, -40.2, 511.8);
  rail(-40, 487.2, 210, 487.2);
  rail(-40, 502.8, 210, 502.8);
  rail(209.8, 487.2, 209.8, 502.8);
  // the slim columns under the decks' open edges (not where a shop's walls already stand)
  for (const c of MEZZ_COLUMNS) {
    if (UNITS.some((u) => c.x > u.x0 - 0.5 && c.x < u.x1 + 0.5 && c.z > u.z0 - 0.5 && c.z < u.z1 + 0.5)) continue;
    k.metal.cyl(c.x, FLOOR_Y, c.z, 0.28, 0.28, MEZZ_UNDER - FLOOR_Y, '#e8e6e0', 12);
  }
}

/** The reclaim hall's walls (up to the mezzanine), with the door in from the gates and the exit to arrivals. */
function reclaimWalls(k: TerminalKits) {
  const R = RECLAIM;
  const h = MEZZ_UNDER;
  const wall = (x0: number, z0: number, x1: number, z1: number, colour: string) => k.interior.span(x0, FLOOR_Y, z0, x1, h, z1, colour);
  // north wall, with the arrivals exit (frosted glass doors) in it
  wall(R.x0, R.z0 - 0.2, R.exitX - R.door / 2, R.z0 + 0.2, '#e9e4dc');
  wall(R.exitX + R.door / 2, R.z0 - 0.2, R.x1, R.z0 + 0.2, '#e9e4dc');
  k.interior.span(R.exitX - R.door / 2, 3.2, R.z0 - 0.2, R.exitX + R.door / 2, h, R.z0 + 0.2, '#e9e4dc');
  // south wall, with the door in from the gates
  wall(R.x0, R.z1 - 0.2, R.entryX - R.door / 2, R.z1 + 0.2, '#e3ddd3');
  wall(R.entryX + R.door / 2, R.z1 - 0.2, R.x1, R.z1 + 0.2, '#e3ddd3');
  k.interior.span(R.entryX - R.door / 2, 3.2, R.z1 - 0.2, R.entryX + R.door / 2, h, R.z1 + 0.2, '#e3ddd3');
  // east wall
  wall(R.x1 - 0.2, R.z0, R.x1 + 0.2, R.z1, '#e9e4dc');
  // grooved cladding stripes on the public faces
  for (let x = R.x0 + 2; x < R.x1; x += 2) {
    if (Math.abs(x - R.exitX) > R.door / 2 + 0.2) k.interior.box(x, h / 2 + 1.6, R.z0 - 0.21, 0.05, h - 3.2, 0.01, '#d6d0c6');
    if (Math.abs(x - R.entryX) > R.door / 2 + 0.2) k.interior.box(x, h / 2 + 1.6, R.z1 + 0.21, 0.05, h - 3.2, 0.01, '#d1cabf');
  }
}

/** The kerb walk under the overhang (pale concrete paving, kerb stones), and the building's footing. */
function kerbWalk(k: TerminalKits) {
  const e = k.exterior;
  e.span(KERB_ROAD.x0, 0, KERB_ROAD.z1, KERB_ROAD.x1, 0.14, LAND_Z, '#d9d6cf');
  e.span(KERB_ROAD.x0, 0, KERB_ROAD.z1 - 0.05, KERB_ROAD.x1, 0.16, KERB_ROAD.z1 + 0.3, '#bdb8ae');
  // a footing round the other three sides
  e.span(TERM.x0 - 1.5, 0, AIR_Z, TERM.x1 + 1.5, 0.12, AIR_Z + 1.2, '#b9b5ad');
  e.span(TERM.x0 - 1.5, 0, LAND_Z, TERM.x0, 0.12, AIR_Z, '#b9b5ad');
  e.span(TERM.x1, 0, LAND_Z, TERM.x1 + 1.5, 0.12, AIR_Z, '#b9b5ad');
  // bollards along the kerb edge
  for (let x = KERB_ROAD.x0 + 3; x < KERB_ROAD.x1; x += 3) k.metal.cyl(x, 0.14, KERB_ROAD.z1 + 0.7, 0.1, 0.1, 0.85, '#3c4147', 6);
}

/** The fixed link from each gate's doorway out to its bridge's rotunda (glazed, on the rotunda's level). */
function fixedLinks(k: TerminalKits) {
  for (const g of GATES) {
    const x = g.doorwayX;
    const z0 = AIR_Z;
    const z1 = g.rotunda.z - ROTUNDA_R + 0.3;
    const w = LINK_W / 2;
    const f = ROTUNDA_FLOOR;
    k.exterior.span(x - w - 0.1, f - 0.4, z0, x + w + 0.1, f, z1, '#c9ced4');
    for (const s of [-1, 1]) {
      k.exterior.span(x + s * w - 0.05, f, z0, x + s * w + 0.05, f + 0.8, z1, '#e8ebee');
      k.exterior.glow = 0.7;
      k.exterior.span(x + s * w - 0.03, f + 0.8, z0, x + s * w + 0.03, f + 2.2, z1, '#33495c');
      k.exterior.glow = 0;
    }
    k.exterior.span(x - w - 0.15, f + 2.2, z0, x + w + 0.15, f + 2.55, z1, '#e8ebee');
    // the doorway's frame on the facade, and the gate number above it
    k.metal.span(x - w - 0.3, 3.3, z0 - 0.05, x + w + 0.3, 3.45, z0 + 0.25, DARK_STEEL);
    k.metal.span(x - w - 0.3, 6.2, z0 - 0.05, x + w + 0.3, 6.45, z0 + 0.25, DARK_STEEL);
    for (const s of [-1, 1]) k.metal.span(x + s * (w + 0.15) - 0.15, 3.3, z0 - 0.05, x + s * (w + 0.15) + 0.15, 6.45, z0 + 0.25, DARK_STEEL);
  }
}

/** The whole shell, into the kits (the roof's surfaces are separate meshes: see roofMeshes). */
export function buildShell(k: TerminalKits) {
  roofTrim(k);
  columns(k);
  curtainWalls(k);
  floors(k);
  mezzanines(k);
  reclaimWalls(k);
  kerbWalk(k);
  fixedLinks(k);
}

/** The shell's colliders: facades with their door gaps, the reclaim hall, columns. Returned as boxes (centre, half sizes, yaw). */
export function shellWalls(): { x0: number; z0: number; x1: number; z1: number; h: number }[] {
  const out: { x0: number; z0: number; x1: number; z1: number; h: number }[] = [];
  const line = (x0: number, z0: number, x1: number, z1: number, gaps: { a: number; b: number }[], h = 4) => {
    let s = x0;
    const sorted = [...gaps].sort((p, q) => p.a - q.a);
    for (const g of sorted) {
      if (g.a > s) out.push({ x0: s, z0, x1: g.a, z1, h });
      s = g.b;
    }
    if (x1 > s) out.push({ x0: s, z0, x1, z1, h });
  };
  line(TERM.x0, LAND_Z, TERM.x1, LAND_Z, DOORS.map((d) => ({ a: d.x - d.w / 2, b: d.x + d.w / 2 })));
  line(TERM.x0, AIR_Z, TERM.x1, AIR_Z, []);
  out.push({ x0: TERM.x0, z0: LAND_Z, x1: TERM.x0, z1: AIR_Z, h: 4 });
  out.push({ x0: TERM.x1, z0: LAND_Z, x1: TERM.x1, z1: AIR_Z, h: 4 });
  const R = RECLAIM;
  line(R.x0, R.z0, R.x1, R.z0, [{ a: R.exitX - R.door / 2, b: R.exitX + R.door / 2 }]);
  line(R.x0, R.z1, R.x1, R.z1, [{ a: R.entryX - R.door / 2, b: R.entryX + R.door / 2 }]);
  out.push({ x0: R.x1, z0: R.z0, x1: R.x1, z1: R.z1, h: 4 });
  return out;
}
