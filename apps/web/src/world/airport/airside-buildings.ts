// The airside's buildings, each built into the shared kits (airside-kit.ts): the control towers,
// the maintenance hangars and their workshop, the ground handler's equipment base, the cargo
// terminal, the fire stations, the fuel farms, the catering unit and the apron floodlight masts.
//
// Every builder takes the airport's parts (the kits it adds geometry to, the signs, lamps and
// light pools it adds to) and world positions; the airside places nothing itself. Big shapes go
// in `paint` (seen from the air), small fittings in `detail` (only drawn near by), glazing that
// should reflect the sky in `glass`.

import * as THREE from 'three';
import { CAB_GLOW, HANGAR_GLOW, Kit, WINDOW_GLOW, at, type Glow, type LampSpec, type Paving, type SignSpec } from './airside-kit';

/** What a builder adds to: the airport's kits, its signs, lamps and night light pools. */
export interface Parts {
  paint: Kit;
  detail: Kit;
  glass: Kit;
  paving: Paving;
  signs: SignSpec[];
  lamps: LampSpec[];
  pools: { x: number; z: number; rx: number; rz: number; ry: number }[];
}

const CONCRETE = '#d9d6cf';
const CONCRETE_DARK = '#b9b5ad';
const CLAD = '#c8ccd1';
const CLAD_DARK = '#7f8790';
const STEEL = '#6d747b';
const ROOF = '#9aa1a8';
const WIN = '#2a3a48';
const WHITE = '#f1f2f0';
const RED = '#c8221c';
const YELLOW = '#f2b632';
const INK = '#1d1238';
const CANDY = '#ff4d6d';
const TEAL = '#0d8f8a';

const RED_LAMP = { r: 3.2, g: 0.15, b: 0.08 };
const FLOOD = { r: 3.0, g: 2.7, b: 2.2 };

/** A steady red aircraft-warning light on top of something tall. */
function obstruction(p: Parts, x: number, y: number, z: number, blink = false) {
  p.lamps.push({ x, y, z, ...RED_LAMP, size: 0.7, mode: blink ? 'blink' : 'steady', day: 0.25 });
}

/**
 * A band of windows round a box (w along x, d along z) at height y: a dark glazed strip set just
 * proud of the walls, lit warm at night, broken by mullions every `pitch` metres.
 */
function windowBand(k: Kit, cx: number, cz: number, w: number, d: number, y: number, h: number, pitch: number, sides: ('n' | 's' | 'e' | 'w')[], glow: Glow = WINDOW_GLOW, ry = 0) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  // local (lx, lz) → world, turned by ry (park yaw)
  const pt = (lx: number, lz: number) => ({ x: cx + lx * c + lz * s, z: cz - lx * s + lz * c });
  for (const side of sides) {
    const alongX = side === 'n' || side === 's';
    const len = alongX ? w : d;
    const off = (alongX ? d : w) / 2 + 0.04;
    const sign = side === 's' || side === 'e' ? 1 : -1;
    const lpos = alongX ? pt(0, sign * off) : pt(sign * off, 0);
    const rot = ry + (alongX ? 0 : Math.PI / 2);
    k.box(len - 1.2, h, 0.1, WIN, at(lpos.x, y, lpos.z, rot), glow);
    const n = Math.floor((len - 1.2) / pitch);
    for (let i = 0; i <= n; i++) {
      const u = -((len - 1.2) / 2) + (i * (len - 1.2)) / n;
      const q = alongX ? pt(u, sign * (off + 0.06)) : pt(sign * (off + 0.06), u);
      k.box(0.14, h, 0.1, CLAD_DARK, at(q.x, y, q.z, rot));
    }
  }
}

/** Flips a geometry inside out (for ceilings seen from below a single-sided roof). */
function inside(g: THREE.BufferGeometry) {
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    idx.setX(i, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

// ------------------------------------------------------------------------------------------------
// Control towers
// ------------------------------------------------------------------------------------------------

export interface TowerSpec {
  x: number;
  z: number;
  /** Height of the cab's floor (m); the whole tower stands about 10 m taller. */
  cabFloor: number;
  /** Shaft radius at the foot and under the cab. */
  r0: number;
  r1: number;
  /** The cab's glazing: radius at its sill and at its head (it leans out). */
  cab: [number, number];
  /** Facade colour of the shaft, and the trim. */
  shaft: string;
  trim: string;
  /** The station's name on the cab's fascia, e.g. "FUNFAIR". */
  name: string;
  /** The operations block at the tower's foot (centre offset, size), or null. */
  base: { dx: number; dz: number; w: number; d: number; h: number } | null;
}

/**
 * An air traffic control tower: a tapering shaft with a glazed lift and stair strip, the
 * equipment floors and catwalk under the cab, the cab's outward-leaning tinted glass (consoles
 * glowing inside at night), the roof with its antennas and the warning lights on top.
 */
export function controlTower(p: Parts, t: TowerSpec) {
  const { paint, detail, glass } = p;
  const seg = 12;
  const H = t.cabFloor - 4;
  // the shaft, and its glazed strip on the south side (the stair and lifts)
  paint.cyl(t.r1, t.r0, H, seg, t.shaft, at(t.x, 0, t.z, Math.PI / seg));
  paint.box(1.6, H - 3, 0.6, WIN, at(t.x, 2, t.z + t.r1 * 0.98 + 0.05), WINDOW_GLOW);
  for (let y = 4; y < H - 2; y += 3.2) paint.box(1.7, 0.18, 0.66, t.trim, at(t.x, y, t.z + t.r1 * 0.98 + 0.06));
  // a fin of trim running up the shaft's north side
  paint.box(0.8, H, 1.4, t.trim, at(t.x, 0, t.z - t.r1 * 0.9));
  // the equipment floors under the cab, flaring out
  paint.cyl(t.cab[0] - 0.4, t.r1, 2.2, seg, t.shaft, at(t.x, H, t.z, Math.PI / seg));
  paint.cyl(t.cab[0] - 0.3, t.cab[0] - 0.3, 1.8, seg, CLAD, at(t.x, H + 2.2, t.z, Math.PI / seg));
  windowBandRound(paint, t.x, t.z, t.cab[0] - 0.25, H + 2.55, 1.0, seg);
  // the catwalk and its railing just below the cab
  paint.cyl(t.cab[0] + 0.9, t.cab[0] + 0.9, 0.2, seg * 2, STEEL, at(t.x, t.cabFloor - 0.2, t.z));
  detail.cyl(t.cab[0] + 0.88, t.cab[0] + 0.88, 1.05, seg * 2, '#cfd3d7', at(t.x, t.cabFloor, t.z), [0, 0, 0, 0], true);
  // the cab: sill, leaning glazing, mullions, the head band with the station's name
  paint.cyl(t.cab[0], t.cab[0], 0.9, seg, t.trim, at(t.x, t.cabFloor, t.z, Math.PI / seg));
  const gh = 4.4;
  glass.cyl(t.cab[1], t.cab[0], gh, seg, '#3a5566', at(t.x, t.cabFloor + 0.9, t.z, Math.PI / seg), CAB_GLOW, true);
  // the cab's dark interior (seen through the glass) and its consoles
  paint.cyl(t.cab[0] - 0.4, t.cab[0] - 0.4, gh, seg, '#1d2329', at(t.x, t.cabFloor + 0.9, t.z, Math.PI / seg), CAB_GLOW, true);
  for (let i = 0; i < seg; i++) {
    const a = ((i + 0.5) / seg) * Math.PI * 2;
    const r = (t.cab[0] + t.cab[1]) / 2;
    const lean = Math.atan2(t.cab[1] - t.cab[0], gh);
    detail.box(0.16, gh, 0.16, t.trim, at(t.x + Math.sin(a) * r, t.cabFloor + 0.9, t.z + Math.cos(a) * r, a, -lean));
  }
  paint.cyl(t.cab[1] + 0.6, t.cab[1] + 0.2, 1.1, seg, t.trim, at(t.x, t.cabFloor + 0.9 + gh, t.z, Math.PI / seg));
  paint.cyl(t.cab[1] - 0.8, t.cab[1] + 0.6, 0.7, seg, ROOF, at(t.x, t.cabFloor + 2.0 + gh, t.z, Math.PI / seg));
  const top = t.cabFloor + 2.7 + gh;
  // roof plant, the antenna mast and two dishes
  paint.cyl(1.6, 1.8, 1.4, 10, CLAD, at(t.x, top, t.z));
  detail.cyl(0.12, 0.2, 7, 6, '#e8e8e8', at(t.x + 1.2, top, t.z - 0.6));
  detail.cyl(0.05, 0.08, 4, 6, '#e8e8e8', at(t.x - 1.4, top, t.z + 0.4));
  detail.add(new THREE.SphereGeometry(0.9, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), '#f4f4f4', at(t.x - 0.6, top + 2.2, t.z - 1.4, 0.6));
  obstruction(p, t.x + 1.2, top + 7.2, t.z - 0.6, true);
  obstruction(p, t.x, top + 1.6, t.z + 1.9);
  p.signs.push({ text: t.name, bg: t.trim, fg: '#ffffff', w: Math.min(9, t.cab[1] * 1.3), h: 0.8, m: at(t.x, t.cabFloor + 0.9 + gh + 0.55, t.z + t.cab[1] + 0.62, Math.PI), lit: true });
  p.signs.push({ text: t.name, bg: t.trim, fg: '#ffffff', w: Math.min(9, t.cab[1] * 1.3), h: 0.8, m: at(t.x, t.cabFloor + 0.9 + gh + 0.55, t.z - t.cab[1] - 0.62, 0), lit: true });
  // the operations block at the foot
  if (t.base) {
    const b = t.base;
    const bx = t.x + b.dx;
    const bz = t.z + b.dz;
    paint.box(b.w, b.h, b.d, CLAD, at(bx, 0, bz));
    paint.box(b.w + 0.4, 0.5, b.d + 0.4, t.trim, at(bx, b.h, bz));
    for (let f = 0; f < Math.floor(b.h / 3.6); f++) windowBand(paint, bx, bz, b.w, b.d, 1.0 + f * 3.6, 1.6, 2.4, ['n', 's', 'e', 'w']);
    // the entrance canopy and roof plant
    paint.box(6, 0.3, 3, t.trim, at(bx, 3.2, bz - b.d / 2 - 1.5));
    detail.box(5, 1.6, 3, '#aab0b5', at(bx + b.w / 4, b.h + 0.5, bz));
    p.paving.rect(bx - b.w / 2 - 4, bx + b.w / 2 + 4, bz - b.d / 2 - 14, bz - b.d / 2, '#8d8e8f');
  }
}

/** A ring of windows round a polygonal floor (radius r) at height y. */
function windowBandRound(k: Kit, x: number, z: number, r: number, y: number, h: number, seg: number) {
  k.cyl(r + 0.05, r + 0.05, h, seg, WIN, at(x, y, z, Math.PI / seg), WINDOW_GLOW, true);
}

// ------------------------------------------------------------------------------------------------
// Maintenance hangars
// ------------------------------------------------------------------------------------------------

export interface HangarSpec {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The doors' side: +1 they open south (+z), −1 north. */
  face: 1 | -1;
  /** Eaves height, the vault's rise over that, the door opening's height. */
  eaves: number;
  rise: number;
  doorH: number;
  /** How far open the doors are (0 shut .. 1 open: the leaves stacked in their end pockets). */
  open: number;
  /** Lettering over the doors, and the hangar's number on its side. */
  title: string;
  label: string;
  /** Cladding and trim colours. */
  clad: string;
  trim: string;
}

/**
 * A maintenance hangar for one narrowbody: a barrel-vaulted shed with a full-width door of
 * sliding leaves, a lit interior (high-bay lamps on day and night) with its floor markings,
 * wing and tail docks round where the aircraft stands, tool chests and work lights.
 */
export function hangar(p: Parts, h: HangarSpec) {
  const { paint, detail } = p;
  const W = h.x1 - h.x0;
  const D = h.z1 - h.z0;
  const cx = (h.x0 + h.x1) / 2;
  const cz = (h.z0 + h.z1) / 2;
  const front = h.face > 0 ? h.z1 : h.z0;
  const back = h.face > 0 ? h.z0 : h.z1;
  const t = 0.6;
  // the side and back walls (inner faces lighter: you look in through the open doors)
  for (const x of [h.x0 + t / 2, h.x1 - t / 2]) {
    paint.box(t, h.eaves, D, h.clad, at(x, 0, cz));
    paint.box(0.05, h.eaves - 0.5, D - 1, '#e4e6e8', at(x + (x < cx ? t / 2 + 0.03 : -t / 2 - 0.03), 0, cz));
  }
  paint.box(W, h.eaves, t, h.clad, at(cx, 0, back - (h.face * t) / 2));
  paint.box(W - 1, h.eaves - 0.5, 0.05, '#e4e6e8', at(cx, 0, back + h.face * (t + 0.03)));
  // a yellow dado band and ribbing outside
  for (const x of [h.x0 - 0.02, h.x1 + 0.02]) for (let z = h.z0 + 3; z < h.z1 - 1; z += 3) detail.box(0.1, h.eaves - 0.4, 0.25, CLAD_DARK, at(x, 0.2, z));
  // the barrel vault: radius from the span and rise, along z; a ceiling under it
  const R = (W * W) / (8 * h.rise) + h.rise / 2;
  const half = Math.asin(W / 2 / R);
  const vault = new THREE.CylinderGeometry(R, R, D, 40, 1, true, -half, 2 * half).rotateX(Math.PI / 2).rotateZ(0);
  // the cylinder's axis is now z; its crown at y = R: drop it so the springing sits on the eaves
  const yc = h.eaves - Math.cos(half) * R;
  paint.add(vault.clone().rotateZ(Math.PI / 2).rotateZ(-Math.PI / 2), ROOF, at(cx, yc, cz, 0, 0, 0));
  paint.add(inside(vault.clone()), '#dfe2e5', at(cx, yc - 0.15, cz));
  // the roof's standing seams (ribs across) and its ridge lights
  for (let i = 0; i <= 12; i++) {
    const a = -half + (2 * half * i) / 12;
    detail.boxC(0.25, 0.25, D + 0.4, CLAD_DARK, at(cx + Math.sin(a) * (R + 0.05), yc + Math.cos(a) * (R + 0.05), cz, 0, 0, -a));
  }
  // the front gable over the door: a shape from the door head up to the vault
  const gable = new THREE.Shape();
  gable.moveTo(-W / 2, h.doorH);
  gable.lineTo(-W / 2, h.eaves);
  for (let i = 0; i <= 24; i++) {
    const a = -half + (2 * half * i) / 24;
    gable.lineTo(Math.sin(a) * R, yc + Math.cos(a) * R);
  }
  gable.lineTo(W / 2, h.doorH);
  gable.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gable, { depth: 1.8, bevelEnabled: false }).translate(0, 0, -0.9);
  paint.add(gableGeo, h.trim, at(cx, 0, front - h.face * 0.6));
  // the back gable, closed
  const backGable = new THREE.Shape();
  backGable.moveTo(-W / 2, h.eaves - 0.01);
  for (let i = 0; i <= 24; i++) {
    const a = -half + (2 * half * i) / 24;
    backGable.lineTo(Math.sin(a) * R, yc + Math.cos(a) * R);
  }
  backGable.lineTo(W / 2, h.eaves - 0.01);
  backGable.closePath();
  paint.add(new THREE.ExtrudeGeometry(backGable, { depth: 0.6, bevelEnabled: false }).translate(0, 0, -0.3), h.clad, at(cx, 0, back));
  // the door leaves: six, sliding into pockets at both ends when open
  const leaves = 6;
  const lw = (W - 2) / leaves;
  for (let i = 0; i < leaves; i++) {
    const shut = h.x0 + 1 + lw * (i + 0.5);
    const pocket = i < leaves / 2 ? h.x0 + 1 + lw * 0.5 + i * 0.5 : h.x1 - 1 - lw * 0.5 - (leaves - 1 - i) * 0.5;
    const x = shut + (pocket - shut) * h.open;
    const z = front + h.face * (0.4 + (i % 3) * 0.45);
    paint.box(lw - 0.1, h.doorH, 0.35, h.clad, at(x, 0, z));
    for (let j = 1; j < 5; j++) detail.box(0.12, h.doorH - 0.4, 0.06, CLAD_DARK, at(x - lw / 2 + (j * lw) / 5, 0.2, z + h.face * 0.2));
    detail.box(lw - 0.1, 0.5, 0.42, YELLOW, at(x, 0, z));
  }
  // the door's guide rail and the pocket screens at both ends
  for (const x of [h.x0 + 0.9, h.x1 - 0.9]) paint.box(1.8, h.doorH + 0.5, 2.2, h.trim, at(x, 0, front + h.face * 1.1));
  // lettering over the door, the hangar's number on each side
  p.signs.push({ text: h.title, bg: h.trim, fg: '#ffffff', w: W * 0.72, h: 2.4, m: at(cx, h.doorH + 2.2, front + h.face * 0.32, h.face > 0 ? Math.PI : 0), lit: true });
  for (const [x, ry] of [[h.x0 - 0.05, -Math.PI / 2], [h.x1 + 0.05, Math.PI / 2]] as const) p.signs.push({ text: h.label, bg: h.clad, fg: INK, w: 10, h: 3, m: at(x, h.eaves - 3.5, cz, ry) });
  // inside: the floor, its painted aircraft outline and walkways, the lamps
  paint.box(W - 2 * t, 0.06, D - t - 1.2, '#d3d6d2', at(cx, 0.03, cz - (h.face * 0.6) / 2));
  for (const x of [cx - 21, cx + 21]) detail.box(0.2, 0.012, D - 6, YELLOW, at(x, 0.095, cz));
  detail.box(0.25, 0.012, D - 8, YELLOW, at(cx, 0.095, cz));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const lx = h.x0 + (W * (j + 1)) / 4;
      const lz = h.z0 + (D * (i + 0.5)) / 4;
      const ly = yc + Math.cos(Math.asin((lx - cx) / R)) * R - 1.6;
      detail.box(1.4, 0.35, 1.4, '#2d3238', at(lx, ly, lz));
      detail.box(1.2, 0.04, 1.2, '#fffaf0', at(lx, ly - 0.03, lz), HANGAR_GLOW);
      p.lamps.push({ x: lx, y: ly - 0.1, z: lz, r: 1.6, g: 1.6, b: 1.5, size: 0.9, mode: 'steady', day: 0.8 });
    }
  }
  // work stands: a yellow dock under each wing and a tall tail dock at the back
  for (const s of [-1, 1]) {
    const x = cx + s * 9.5;
    const z = cz + h.face * 1;
    dock(detail, x, z, 8, 3.2, 2.6, Math.PI / 2 - s * 0.45);
  }
  dock(detail, cx, back + h.face * 6, 7, 5, 9.5, 0);
  // tool chests and a parts rack along the side walls
  for (let i = 0; i < 6; i++) detail.box(1.2, 1.1, 0.6, i % 2 ? RED : '#2f6fd6', at(h.x0 + 2, 0, h.z0 + 8 + i * 7, Math.PI / 2));
  for (let i = 0; i < 3; i++) shelving(detail, h.x1 - 2.2, h.z0 + 10 + i * 14);
  // the side annex's personnel door and the roof's smoke vents
  for (let i = 0; i < 3; i++) detail.box(3, 1.2, 2, ROOF, at(cx - 15 + i * 15, yc + R - 0.3, cz + 6));
  // outside: a lamp over each pocket and the apron's door track
  for (const x of [h.x0 + 1, h.x1 - 1]) p.lamps.push({ x, y: h.doorH + 1.2, z: front + h.face * 2.4, ...FLOOD, size: 0.8, mode: 'steady', day: 0, dir: [0, -0.4, h.face], spread: 0.2 });
  p.pools.push({ x: cx, z: front + h.face * 24, rx: W * 0.45, rz: 22, ry: 0 });
}

/** A yellow scaffold work platform: decks, legs, railings, a stair. */
function dock(k: Kit, x: number, z: number, l: number, w: number, hgt: number, ry: number) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const pt = (lx: number, lz: number) => [x + lx * c + lz * s, z - lx * s + lz * c] as const;
  k.box(w, 0.2, l, YELLOW, at(x, hgt, z, ry));
  for (const lx of [-w / 2 + 0.15, w / 2 - 0.15]) {
    for (const lz of [-l / 2 + 0.2, 0, l / 2 - 0.2]) {
      const [px, pz] = pt(lx, lz);
      k.box(0.12, hgt, 0.12, YELLOW, at(px, 0, pz, ry));
    }
    const [rx, rz] = pt(lx, 0);
    k.box(0.06, 0.06, l, '#e7e7e7', at(rx, hgt + 1.05, rz, ry));
  }
  const [sx, sz] = pt(0, l / 2 + hgt * 0.4);
  k.box(0.9, 0.12, hgt * 1.15, YELLOW, at(sx, hgt / 2, sz, ry, -0.72));
}

/** Parts shelving: uprights, shelves and a few boxes. */
function shelving(k: Kit, x: number, z: number) {
  for (const dz of [-4, 4]) k.box(0.1, 4, 1.0, STEEL, at(x, 0, z + dz));
  for (let i = 0; i < 4; i++) {
    k.box(1.0, 0.06, 8, '#e08a1e', at(x, 0.5 + i * 1.1, z));
    for (let j = 0; j < 5; j++) k.box(0.7, 0.5, 1.0, ['#c9a46a', '#8f7a5a', '#5c6e80'][(i + j) % 3], at(x, 0.56 + i * 1.1, z - 3 + j * 1.5));
  }
}

// ------------------------------------------------------------------------------------------------
// Low buildings: workshops, offices, the catering unit, the GSE shed
// ------------------------------------------------------------------------------------------------

export interface BlockSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Storeys of windows, cladding and trim. */
  floors: number;
  clad: string;
  trim: string;
  /** Roller doors on one face (count, which face), and the sign (on the same face). */
  doors?: { n: number; face: 'n' | 's'; w: number; h: number; open?: number[]; color?: string };
  sign?: { text: string; face: 'n' | 's'; bg: string; fg: string };
}

/** A flat-roofed block: window bands, a parapet, roof plant, roller doors with lit openings. */
export function block(p: Parts, b: BlockSpec) {
  const { paint, detail } = p;
  paint.box(b.w, b.h, b.d, b.clad, at(b.x, 0, b.z));
  paint.box(b.w + 0.3, 0.6, b.d + 0.3, b.trim, at(b.x, b.h, b.z));
  const doorFace = b.doors?.face;
  for (let f = 0; f < b.floors; f++) {
    const y = (b.doors ? b.doors.h + 1.2 : 1.1) + f * 3.6;
    if (y + 1.4 > b.h) break;
    windowBand(paint, b.x, b.z, b.w, b.d, y, 1.4, 2.4, ['n', 's', 'e', 'w']);
  }
  if (b.doors) {
    const d = b.doors;
    const sgn = d.face === 's' ? 1 : -1;
    const z = b.z + sgn * (b.d / 2 + 0.05);
    const pitch = (b.w - 4) / d.n;
    for (let i = 0; i < d.n; i++) {
      const x = b.x - b.w / 2 + 2 + pitch * (i + 0.5);
      const open = d.open?.includes(i) ?? false;
      // an open door shows the lit bay inside; a shut one its ribbed leaf
      paint.box(d.w, d.h, 0.12, open ? '#3b3f44' : (d.color ?? '#b9bfc5'), at(x, 0, z), open ? HANGAR_GLOW : [0, 0, 0, 0]);
      if (!open) for (let j = 1; j < 8; j++) detail.box(d.w, 0.05, 0.05, CLAD_DARK, at(x, (j * d.h) / 8, z + sgn * 0.08));
      paint.box(d.w + 0.6, 0.4, 0.3, b.trim, at(x, d.h, z));
      p.lamps.push({ x, y: d.h + 0.6, z: z + sgn * 0.4, r: 2.4, g: 2.2, b: 1.8, size: 0.35, mode: 'steady', day: 0 });
    }
  }
  if (b.sign) {
    const sgn = b.sign.face === 's' ? 1 : -1;
    const y = doorFace === b.sign.face && b.doors ? Math.min(b.h - 1.1, b.doors.h + 1.0) : b.h - 1.2;
    p.signs.push({ text: b.sign.text, bg: b.sign.bg, fg: b.sign.fg, w: Math.min(b.w * 0.6, b.sign.text.length * 1.2), h: 1.4, m: at(b.x, y + 0.4, b.z + sgn * (b.d / 2 + 0.12), sgn > 0 ? Math.PI : 0), lit: true });
  }
  // roof plant: air handlers and a few vents
  const n = Math.max(1, Math.floor(b.w / 20));
  for (let i = 0; i < n; i++) detail.box(4, 1.5, 2.6, '#aab0b5', at(b.x - b.w / 2 + (b.w * (i + 0.5)) / n, b.h + 0.6, b.z));
}

/** An open-sided equipment shed: a canopy on columns, the vehicles park underneath. */
export function shed(p: Parts, x: number, z: number, w: number, d: number, h: number, color: string) {
  const { paint, detail } = p;
  paint.box(w + 1, 0.5, d + 1, color, at(x, h, z));
  paint.box(w + 1.2, 0.2, d + 1.2, CLAD_DARK, at(x, h + 0.5, z));
  for (let i = 0; i <= Math.round(w / 8); i++) for (const dz of [-d / 2, d / 2]) detail.box(0.35, h, 0.35, STEEL, at(x - w / 2 + (i * w) / Math.round(w / 8), 0, z + dz));
  paint.box(w, h * 0.55, 0.3, CLAD, at(x, 0, z - d / 2));
  for (let i = 0; i < Math.round(w / 8); i++) {
    const lx = x - w / 2 + (i + 0.5) * (w / Math.round(w / 8));
    detail.box(1.2, 0.08, 0.4, '#fffaf0', at(lx, h - 0.1, z), HANGAR_GLOW);
  }
}

// ------------------------------------------------------------------------------------------------
// The cargo terminal
// ------------------------------------------------------------------------------------------------

/** A big shed with loading doors on its airside face, an office block, ULD racks along the front. */
export function cargoTerminal(p: Parts, x0: number, x1: number, z0: number, z1: number, face: 1 | -1) {
  const { paint, detail, glass } = p;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const front = face > 0 ? z1 : z0;
  const H = 15;
  // the shed: dark cladding, a light band, a pale roof with its edge
  paint.box(w - 30, H, d, '#4a5563', at(cx + 15, 0, cz));
  paint.box(w - 30 + 0.2, 1.4, d + 0.2, '#ffc23d', at(cx + 15, H - 3, cz));
  paint.box(w - 29, 0.8, d + 1, '#d8dbde', at(cx + 15, H, cz));
  for (let xx = x0 + 32; xx < x1 - 1; xx += 4) for (const zz of [z0 - 0.06, z1 + 0.06]) detail.box(0.18, H - 0.5, 0.12, '#3e4855', at(xx, 0, zz));
  // the loading doors (some open, lit inside), dock levellers and canopy
  const n = 10;
  const pitch = (w - 36) / n;
  for (let i = 0; i < n; i++) {
    const x = x0 + 34 + pitch * (i + 0.5);
    const open = i % 3 !== 1;
    paint.box(5.5, 5.5, 0.15, open ? '#2c3036' : '#c7ccd1', at(x, 0, front + face * 0.08), open ? HANGAR_GLOW : [0, 0, 0, 0]);
    if (!open) for (let j = 1; j < 8; j++) detail.box(5.5, 0.05, 0.05, CLAD_DARK, at(x, j * 0.68, front + face * 0.17));
    detail.box(6.2, 0.3, 0.4, '#ffc23d', at(x, 5.5, front + face * 0.2));
    p.lamps.push({ x, y: 6.1, z: front + face * 0.6, r: 2.4, g: 2.2, b: 1.8, size: 0.35, mode: 'steady', day: 0 });
  }
  paint.box(w - 32, 0.35, 6, CLAD_DARK, at(cx + 16, 7.2, front + face * 3));
  // the office block at the west end: glazed, three floors
  const ox = x0 + 15;
  paint.box(30, 12.5, d, WHITE, at(ox, 0, cz));
  glass.box(28.5, 9.8, d + 0.4, '#3a5566', at(ox, 1.4, cz), WINDOW_GLOW);
  for (let f = 1; f < 3; f++) paint.box(30.2, 0.45, d + 0.6, WHITE, at(ox, 1.2 + f * 3.4, cz));
  for (let i = 0; i <= 10; i++) detail.box(0.18, 9.8, d + 0.7, '#d8dbde', at(x0 + 0.9 + i * 2.82, 1.4, cz));
  paint.box(31, 0.8, d + 1, '#ffc23d', at(ox, 12.5, cz));
  // the name along the front
  p.signs.push({ text: 'FUNFAIR CARGO', bg: '#4a5563', fg: '#ffffff', w: 46, h: 4.2, m: at(cx + 25, H - 7.2, front + face * 0.14, face > 0 ? Math.PI : 0), lit: true });
  p.signs.push({ text: 'FUNFAIR CARGO', bg: '#4a5563', fg: '#ffffff', w: 46, h: 4.2, m: at(cx + 25, H - 7.2, (face > 0 ? z0 : z1) - face * 0.14, face > 0 ? 0 : Math.PI), lit: true });
  // ULD racks along the front: frames with containers and pallets on them
  for (let i = 0; i < 12; i++) {
    const x = x0 + 40 + i * 16;
    const z = front + face * 9;
    detail.box(14, 0.35, 3.4, STEEL, at(x, 1.1, z));
    for (let l = 0; l < 2; l++) {
      detail.box(14, 0.2, 3.4, STEEL, at(x, 1.1 + l * 2.25, z));
      for (let j = 0; j < 4; j++) {
        const kind = (i + j + l) % 5;
        if (kind === 4) continue;
        uld(detail, x - 5.2 + j * 3.4, 1.45 + l * 2.25, z, kind);
      }
    }
    for (const dx of [-6.9, 6.9]) for (const dz of [-1.6, 1.6]) detail.box(0.2, 5.6, 0.2, STEEL, at(x + dx, 0, z + dz));
  }
}

/** A container or a pallet on a rack: LD3s in silver or the fair's colours, a netted pallet. */
function uld(k: Kit, x: number, y: number, z: number, kind: number) {
  if (kind === 3) {
    k.box(2.9, 0.08, 2.2, '#9aa0a6', at(x, y, z));
    k.box(2.6, 1.3, 2.0, '#6d5a3f', at(x, y + 0.08, z));
    k.box(2.65, 1.32, 2.05, '#1a1a1a', at(x, y + 0.08, z, 0.02));
    return;
  }
  k.box(1.55, 1.63, 2.0, ['#c9cdd2', '#c9cdd2', CANDY][kind], at(x, y, z));
  k.box(1.58, 0.18, 1.8, ['#2f6fd6', '#ffc23d', '#ffffff'][kind], at(x, y + 1.2, z));
}

// ------------------------------------------------------------------------------------------------
// Fire stations
// ------------------------------------------------------------------------------------------------

/**
 * An airport fire station: the appliance hall with its row of red doors facing the runway (some
 * up, an appliance showing inside), the crew block with the watch room glazed towards the
 * airfield, and the hose-drying / training tower.
 */
export function fireStation(p: Parts, x: number, z: number, bays: number, face: 1 | -1, title: string) {
  const { paint, detail, glass } = p;
  const bayW = 6.5;
  const W = bays * bayW + 2;
  const D = 24;
  const H = 8;
  const front = z + (face * D) / 2;
  paint.box(W, H, D, WHITE, at(x, 0, z));
  paint.box(W + 0.4, 1.0, D + 0.4, RED, at(x, H - 0.6, z));
  for (let i = 0; i < bays; i++) {
    const bx = x - W / 2 + 1 + bayW * (i + 0.5);
    const open = i % 2 === 0;
    paint.box(bayW - 1.2, 5.2, 0.15, open ? '#33383e' : RED, at(bx, 0, front + face * 0.08), open ? HANGAR_GLOW : [0, 0, 0, 0]);
    if (!open) for (let j = 1; j < 10; j++) detail.box(bayW - 1.2, 0.05, 0.05, '#8f1712', at(bx, j * 0.52, front + face * 0.17));
    detail.box(0.5, H - 1.6, 0.4, '#e9e9e9', at(bx + bayW / 2, 0, front + face * 0.2));
    p.lamps.push({ x: bx, y: 5.8, z: front + face * 0.5, r: 2.6, g: 2.4, b: 2.0, size: 0.4, mode: 'steady', day: 0 });
  }
  // the crew block on the west end, two storeys, with the glazed watch room on top
  const cx = x - W / 2 - 9;
  paint.box(18, 7, D, WHITE, at(cx, 0, z));
  windowBand(paint, cx, z, 18, D, 1.1, 1.5, 2.4, ['n', 's', 'w']);
  windowBand(paint, cx, z, 18, D, 4.6, 1.5, 2.4, ['n', 's', 'w']);
  paint.box(10, 0.4, 10, RED, at(cx, 7, z + (face * D) / 4));
  glass.box(9.4, 3.2, 9.4, '#3a5566', at(cx, 7.4, z + (face * D) / 4), CAB_GLOW);
  paint.box(10.4, 0.5, 10.4, RED, at(cx, 10.6, z + (face * D) / 4));
  // the hose tower on the east end
  const tx = x + W / 2 + 3;
  paint.box(5, 17, 5, WHITE, at(tx, 0, z - (face * D) / 4));
  for (let f = 1; f < 5; f++) detail.box(2, 1.4, 0.2, WIN, at(tx, f * 3.4, z - (face * D) / 4 + face * 2.55), WINDOW_GLOW);
  paint.box(5.6, 0.6, 5.6, RED, at(tx, 17, z - (face * D) / 4));
  obstruction(p, tx, 17.9, z - (face * D) / 4);
  p.signs.push({ text: title, bg: RED, fg: '#ffffff', w: Math.min(W * 0.8, title.length * 1.1), h: 1.6, m: at(x, H - 1.6, front + face * 0.25, face > 0 ? Math.PI : 0), lit: true });
  // the forecourt's drain line and bollards
  for (let i = 0; i <= bays; i++) detail.cyl(0.15, 0.15, 1.0, 8, YELLOW, at(x - W / 2 + 1 + i * bayW, 0, front + face * 1.2));
  p.pools.push({ x, z: front + face * 12, rx: W * 0.55, rz: 14, ry: 0 });
}

// ------------------------------------------------------------------------------------------------
// Fuel farms
// ------------------------------------------------------------------------------------------------

/** Tanks in a bund, the pump house, pipe racks and the bowsers' loading gantry. */
export function fuelFarm(p: Parts, tanks: { x: number; z: number; r: number; h: number }[], bund: { x0: number; x1: number; z0: number; z1: number }, gantry: { x: number; z: number }, title: string) {
  const { paint, detail } = p;
  // the bund wall: a low concrete wall round the tanks
  const bw = 0.5;
  const bh = 1.3;
  const bx = (bund.x0 + bund.x1) / 2;
  const bz = (bund.z0 + bund.z1) / 2;
  paint.box(bund.x1 - bund.x0, bh, bw, CONCRETE_DARK, at(bx, 0, bund.z0));
  paint.box(bund.x1 - bund.x0, bh, bw, CONCRETE_DARK, at(bx, 0, bund.z1));
  paint.box(bw, bh, bund.z1 - bund.z0, CONCRETE_DARK, at(bund.x0, 0, bz));
  paint.box(bw, bh, bund.z1 - bund.z0, CONCRETE_DARK, at(bund.x1, 0, bz));
  p.paving.rect(bund.x0, bund.x1, bund.z0, bund.z1, '#a7a294');
  for (const t of tanks) {
    paint.cyl(t.r, t.r, t.h, 28, '#eef0ee', at(t.x, 0, t.z));
    paint.cyl(t.r + 0.02, t.r + 0.02, 1.2, 28, '#2e9e5b', at(t.x, t.h * 0.62, t.z), [0, 0, 0, 0], true);
    paint.cyl(t.r * 0.25, t.r + 0.1, t.r * 0.18, 28, '#dfe2df', at(t.x, t.h, t.z));
    // the spiral stair approximated as a raking band, and the roof's rail
    for (let i = 0; i < 10; i++) {
      const a = 0.6 + i * 0.16;
      detail.box(1.0, 0.12, 1.4, STEEL, at(t.x + Math.sin(a) * (t.r + 0.6), (t.h * (i + 1)) / 10, t.z + Math.cos(a) * (t.r + 0.6), a));
    }
    detail.cyl(t.r * 0.95, t.r * 0.95, 1.0, 28, '#cfd3d7', at(t.x, t.h + t.r * 0.04, t.z), [0, 0, 0, 0], true);
    obstruction(p, t.x, t.h + t.r * 0.18 + 0.3, t.z);
  }
  // pipe racks from the tanks to the pump house and the gantry
  const px = gantry.x;
  for (const t of tanks) {
    const l = Math.hypot(px - t.x, gantry.z - 14 - t.z);
    const a = Math.atan2(px - t.x, gantry.z - 14 - t.z);
    detail.boxC(0.4, 0.4, l, '#c5c9cc', at((px + t.x) / 2, 1.0, (gantry.z - 14 + t.z) / 2, a));
  }
  paint.box(12, 4.5, 8, CLAD, at(px, 0, gantry.z - 14));
  paint.box(12.4, 0.4, 8.4, '#2e9e5b', at(px, 4.5, gantry.z - 14));
  // the loading gantry: a canopy over two bays
  paint.box(18, 0.6, 12, '#2e9e5b', at(px, 6.2, gantry.z));
  for (const dx of [-8, 8]) for (const dz of [-5, 5]) detail.box(0.35, 6.2, 0.35, STEEL, at(px + dx, 0, gantry.z + dz));
  for (const dx of [-4, 4]) detail.box(1.2, 4.2, 1.2, '#c5c9cc', at(px + dx, 0, gantry.z));
  p.paving.rect(px - 14, px + 14, gantry.z - 9, gantry.z + 12, '#8a8b8c');
  p.signs.push({ text: title, bg: '#2e9e5b', fg: '#ffffff', w: 10, h: 1.1, m: at(px, 5.0, gantry.z + 6.05, Math.PI), lit: true });
  p.lamps.push({ x: px, y: 6.0, z: gantry.z, ...FLOOD, size: 0.6, mode: 'steady', day: 0 });
  p.pools.push({ x: px, z: gantry.z, rx: 14, rz: 10, ry: 0 });
}

// ------------------------------------------------------------------------------------------------
// Apron floodlight masts
// ------------------------------------------------------------------------------------------------

/**
 * A floodlight mast: a tapered pole with a head frame of lamps aimed down over the apron
 * (`aim`: the heading the head faces), a pool of light at its foot at night.
 */
export function mast(p: Parts, x: number, z: number, h: number, aim: number, reach = 34) {
  const { paint, detail } = p;
  paint.cyl(0.32, 0.55, h, 10, '#b9bec3', at(x, 0, z));
  detail.cyl(0.9, 1.0, 0.6, 10, CONCRETE, at(x, 0, z));
  const a = (aim * Math.PI) / 180;
  const fx = Math.sin(a);
  const fz = -Math.cos(a);
  // the head frame and its lamps (two rows of four), facing `aim`
  detail.box(4.6, 2.2, 0.3, '#6d747b', at(x + fx * 0.5, h - 1.6, z + fz * 0.5, -a));
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 4; i++) {
      const lx = -1.65 + i * 1.1;
      const wx = x + fx * 0.75 + Math.cos(a) * lx;
      const wz = z + fz * 0.75 + Math.sin(a) * lx;
      detail.box(0.9, 0.7, 0.35, '#3a3f45', at(wx, h - 1.4 - row * 1.0, wz, -a, 0.5));
      detail.box(0.8, 0.6, 0.04, '#fff6e0', at(wx + fx * 0.2, h - 1.35 - row * 1.0, wz + fz * 0.2, -a, 0.5), [2.6, 2.4, 2.0, 0]);
    }
  }
  p.lamps.push({ x: x + fx * 0.9, y: h - 1.0, z: z + fz * 0.9, ...FLOOD, size: 1.6, mode: 'steady', day: 0, dir: [fx, -0.55, fz], spread: -0.2 });
  obstruction(p, x, h + 0.35, z);
  p.pools.push({ x: x + fx * reach * 0.6, z: z + fz * reach * 0.6, rx: reach * 0.75, rz: reach, ry: -a });
}

/** A low perimeter of bollards or a run of safety cones (the parked aircraft's). */
export function cones(k: Kit, pts: { x: number; z: number }[]) {
  for (const c of pts) {
    k.cyl(0.03, 0.17, 0.5, 8, '#ff6a14', at(c.x, 0, c.z));
    k.cyl(0.11, 0.135, 0.07, 8, '#f2f2f2', at(c.x, 0.2, c.z));
    k.box(0.38, 0.03, 0.38, '#222', at(c.x, 0, c.z));
  }
}

export const COLOURS = { CONCRETE, CLAD, CLAD_DARK, WHITE, RED, YELLOW, INK, CANDY, TEAL, STEEL, ROOF, WIN };
