// Palm Cay's furniture and small buildings, each added into the shared batches (kit.ts) so a whole
// beach of them costs one draw call per material: benches, palapas and parasols, loungers and
// towels, beach huts, the bars and shops, the lifeguard tower, sandcastles and kayaks, torches,
// lanterns, fingerposts, the fountain, boardwalks and the pier. Positions are world metres; yaw
// follows the park's convention (0: the front faces north, −z).

import * as THREE from 'three';
import { staticBox, staticCylinder, type Ctx } from '../context';
import type { Tier } from '../quality';
import { at, coneRoof, disc, gableRoof, hipRoof, place, post, signPlane, strip, type Batches, type SignAtlas, type SignStyle, type V2 } from './kit';
import type { NightLights } from './lights';

/** Everything a prop builder adds to. */
export interface Build {
  b: Batches;
  lights: NightLights;
  atlas: SignAtlas;
  ctx: Ctx;
  rnd: () => number;
  tier: Tier;
  /** Whether to add physics colliders (the visitor and the crowd walk round them). */
  colliders: boolean;
}

/** A seat a beachgoer can use: where to stand to sit, and the way they face. */
export interface Seat extends V2 {
  yaw: number;
}

const WHITE = '#f4f1ea';
const IRON = '#2f3b33';

/** A cheap cylinder (n sides) between two heights, centred on (x, z). */
function cyl(r0: number, r1: number, h: number, seg = 8) {
  return post(r0, r1, h, seg);
}

/** Collider helper: a box of half-sizes (hx, hz) and height h at (x, z), turned by yaw. */
export function block(k: Build, x: number, z: number, hx: number, hz: number, h: number, yaw = 0) {
  if (k.colliders) staticBox(k.ctx, x, h / 2, z, hx, h / 2, hz, yaw);
}

/** World position of a local offset (lx, lz) in an object at (x, z) turned by yaw. */
export function local(x: number, z: number, yaw: number, lx: number, lz: number): V2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
}

// ------------------------------------------------------------------------------------------------
// Seating and shade
// ------------------------------------------------------------------------------------------------

/** A park bench: hardwood slats on cast-iron ends, 1.8 m long; the sitter faces −z (yaw 0 → north). */
export function bench(k: Build, x: number, z: number, yaw: number): Seat {
  const m = place(x, 0, z, yaw);
  const wood = '#b07a4a';
  for (let i = 0; i < 4; i++) k.b.timber.box(1.8, 0.04, 0.09, wood, at(m, 0, 0.45, -0.18 + i * 0.11), { box: 1, grain: 'x' });
  for (let i = 0; i < 3; i++) {
    const bm = at(m, 0, 0.62 + i * 0.12, 0.24 + i * 0.025);
    k.b.timber.box(1.8, 0.09, 0.035, wood, bm.multiply(new THREE.Matrix4().makeRotationX(-0.22)), { box: 1, grain: 'x' });
  }
  for (const sx of [-0.78, 0.78]) {
    k.b.metal.box(0.06, 0.45, 0.06, IRON, at(m, sx, 0.225, -0.2));
    k.b.metal.box(0.06, 0.9, 0.06, IRON, at(m, sx, 0.45, 0.25));
    k.b.metal.box(0.06, 0.05, 0.5, IRON, at(m, sx, 0.42, 0.02));
    k.b.metal.box(0.05, 0.05, 0.42, IRON, at(m, sx, 0.66, -0.02));
  }
  block(k, x, z, 0.9, 0.3, 0.9, yaw);
  const s = local(x, z, yaw, 0, -0.05);
  return { x: s.x, z: s.z, yaw };
}

/** A palapa: a thatched umbrella on a hardwood pole (radius r). */
export function palapa(k: Build, x: number, z: number, r = 1.7) {
  const h = 2.5;
  k.b.timber.add(cyl(0.08, 0.07, h + 0.9, 7), '#8a5c36', place(x, 0, z), { box: 1, grain: 'y' });
  k.b.thatch.add(coneRoof(r, 1.1, 12, 0.5), '#e8d4a6', place(x, h, z));
  // a ragged fringe under the eave
  k.b.thatch.add(new THREE.CylinderGeometry(r * 0.98, r * 1.02, 0.28, 12, 1, true), '#c9ab72', place(x, h - 0.1, z), { box: 0.5 });
  if (k.colliders) staticCylinder(k.ctx, x, z, 0.12, 2.2);
}

/** A beach parasol, eight panels in two alternating colours, tilted a little towards the sun (south-west). */
export function parasol(k: Build, x: number, z: number, a: string, b: string, tilt = 0.12) {
  const m = place(x, 0, z, k.rnd() * Math.PI * 2).multiply(new THREE.Matrix4().makeRotationX(tilt));
  k.b.metal.add(cyl(0.022, 0.02, 2.35, 6), WHITE, m);
  const r = 1.15;
  const rim = 1.86;
  const apex = 2.3;
  const tri = (i: number) => {
    const a0 = (i / 8) * Math.PI * 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2;
    const g = new THREE.BufferGeometry();
    const am = (a0 + a1) / 2;
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, apex, 0, Math.cos(a1) * r, rim, Math.sin(a1) * r, Math.cos(am) * r * 0.93, rim + 0.06, Math.sin(am) * r * 0.93, 0, apex, 0, Math.cos(am) * r * 0.93, rim + 0.06, Math.sin(am) * r * 0.93, Math.cos(a0) * r, rim, Math.sin(a0) * r],
        3,
      ),
    );
    g.computeVertexNormals();
    return g;
  };
  for (let i = 0; i < 8; i++) k.b.fabric.add(tri(i), i % 2 ? a : b, m);
  k.b.metal.add(new THREE.SphereGeometry(0.04, 6, 4), WHITE, at(m, 0, apex + 0.02, 0));
}

/** A sun lounger, backrest up; the person lies with their head at +z (yaw 0 → feet to the north). */
export function lounger(k: Build, x: number, z: number, yaw: number, cushion: string): Seat {
  const m = place(x, 0, z, yaw);
  const frame = WHITE;
  for (const sx of [-0.3, 0.3]) {
    k.b.paint.box(0.04, 0.04, 1.3, frame, at(m, sx, 0.3, -0.25));
    for (const lz of [-0.85, 0.3]) k.b.paint.box(0.04, 0.3, 0.04, frame, at(m, sx, 0.15, lz));
  }
  k.b.fabric.box(0.62, 0.06, 1.3, cushion, at(m, 0, 0.35, -0.25));
  const back = at(m, 0, 0.55, 0.62).multiply(new THREE.Matrix4().makeRotationX(-0.75));
  k.b.fabric.box(0.62, 0.06, 0.7, cushion, back);
  k.b.paint.box(0.66, 0.03, 0.72, frame, back.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.045, 0)));
  return { x, z, yaw };
}

/** A beach towel laid on the sand (three stripes). */
export function towel(k: Build, x: number, z: number, yaw: number, a: string, b: string) {
  const m = place(x, 0, z, yaw);
  k.b.fabric.box(0.85, 0.012, 0.6, a, at(m, 0, 0.012, -0.6));
  k.b.fabric.box(0.85, 0.012, 0.6, b, at(m, 0, 0.012, 0));
  k.b.fabric.box(0.85, 0.012, 0.6, a, at(m, 0, 0.012, 0.6));
}

// ------------------------------------------------------------------------------------------------
// Small buildings
// ------------------------------------------------------------------------------------------------

/** A painted beach hut (changing cabana): 2.2 m square, gable roof, white trim, the door at the front (−z). */
export function beachHut(k: Build, x: number, z: number, yaw: number, colour: string, roof: string) {
  const m = place(x, 0, z, yaw);
  const w = 2.2;
  const h = 2.4;
  k.b.deck.box(w + 0.6, 0.12, w + 0.9, '#c9a87a', at(m, 0, 0.06, -0.15), { box: 0.5 });
  // walls of vertical boards: a slab per side with a gap for the door
  k.b.paint.box(w, h, 0.08, colour, at(m, 0, h / 2 + 0.12, w / 2));
  k.b.paint.box(0.08, h, w, colour, at(m, -w / 2, h / 2 + 0.12, 0));
  k.b.paint.box(0.08, h, w, colour, at(m, w / 2, h / 2 + 0.12, 0));
  k.b.paint.box(0.55, h, 0.08, colour, at(m, -0.82, h / 2 + 0.12, -w / 2));
  k.b.paint.box(0.55, h, 0.08, colour, at(m, 0.82, h / 2 + 0.12, -w / 2));
  k.b.paint.box(1.1, 0.4, 0.08, colour, at(m, 0, h - 0.08, -w / 2));
  // board joints, read as vertical lines in the paint
  for (let i = -4; i <= 4; i++) if (Math.abs(i) > 2) k.b.paint.box(0.02, h, 0.02, '#ffffff', at(m, i * 0.24, h / 2 + 0.12, -w / 2 - 0.05));
  // the door, ajar, and the white trim
  k.b.paint.add(new THREE.BoxGeometry(1.08, 1.95, 0.05).translate(0.54, 0, 0), WHITE, at(m, -0.54, 1.1, -w / 2 - 0.02, -0.5));
  for (const sx of [-1, 1]) k.b.paint.box(0.1, h + 0.1, 0.1, WHITE, at(m, (sx * w) / 2, h / 2 + 0.12, -w / 2));
  for (const sx of [-1, 1]) k.b.paint.box(0.1, h + 0.1, 0.1, WHITE, at(m, (sx * w) / 2, h / 2 + 0.12, w / 2));
  const roofM = at(m, 0, h + 0.12, 0);
  k.b.paint.add(gableRoof(w + 0.5, w + 0.6, 0.9, 0.5), roof, roofM);
  // gable ends
  const gab = new THREE.BufferGeometry();
  gab.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, 0, 0.88, 0], 3));
  gab.computeVertexNormals();
  k.b.paint.add(gab, colour, at(m, 0, h + 0.12, -w / 2).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
  k.b.paint.add(gab, colour, at(m, 0, h + 0.12, w / 2));
  block(k, x, z, w / 2 + 0.1, w / 2 + 0.1, 2.5, yaw);
}

export interface BarOptions {
  /** The board above the counter. */
  name: string;
  sub?: string;
  sign: SignStyle;
  /** Width (along the counter) and depth (m). */
  w?: number;
  d?: number;
  /** Stools along the counter. */
  stools?: number;
  /** Counter front colour (the timber is tinted with it). */
  front?: string;
  /** What's on show: fruit bowls (smoothies), surfboards, an ice-cream freezer. */
  kind: 'smoothie' | 'surf' | 'ice' | 'tiki' | 'shop';
}

/**
 * A beach bar or shop: a timber hut with a serving counter at the front (−z), a thatched hip roof
 * on four posts overhanging the counter, a sign board, a lit back wall and stools. Returns the
 * stools (seats facing the counter).
 */
export function bar(k: Build, x: number, z: number, yaw: number, o: BarOptions): Seat[] {
  const w = o.w ?? 6;
  const d = o.d ?? 4;
  const m = place(x, 0, z, yaw);
  const wood = '#a8784c';
  // floor and walls
  k.b.deck.box(w + 1.6, 0.1, d + 2.2, '#b9926a', at(m, 0, 0, -0.5), { box: 0.5 });
  k.b.timber.box(w, 2.7, 0.14, wood, at(m, 0, 1.47, d / 2), { box: 1, grain: 'y' });
  k.b.timber.box(0.14, 2.7, d, wood, at(m, -w / 2, 1.47, 0), { box: 1, grain: 'y' });
  k.b.timber.box(0.14, 2.7, d, wood, at(m, w / 2, 1.47, 0), { box: 1, grain: 'y' });
  // the lit back wall and shelves (glow at night like a lamp-lit bar)
  k.b.lit.box(w - 0.5, 1.3, 0.04, '#ffd9a6', at(m, 0, 1.75, d / 2 - 0.09));
  for (let i = 0; i < 2; i++) k.b.timber.box(w - 0.6, 0.05, 0.3, '#6e4a2c', at(m, 0, 1.4 + i * 0.55, d / 2 - 0.25), { box: 1, grain: 'x' });
  // the counter: a bamboo-faced front with a hardwood top
  const front = o.front ?? '#c9a66b';
  k.b.timber.box(w - 0.3, 1.05, 0.5, front, at(m, 0, 0.645, -d / 2 + 0.25), { box: 1, grain: 'y' });
  for (let i = 0; i < Math.round(w / 0.16); i++) k.b.timber.add(cyl(0.045, 0.045, 1.0, 6), '#d8bf86', at(m, -w / 2 + 0.25 + i * 0.16, 0.12, -d / 2 - 0.02), { box: 2, grain: 'y' });
  k.b.timber.box(w + 0.1, 0.07, 0.8, '#7a4f2c', at(m, 0, 1.2, -d / 2 + 0.2), { box: 1, grain: 'x' });
  // four posts and the thatch
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) k.b.timber.add(cyl(0.11, 0.1, 3.0, 7), '#7a5232', at(m, (sx * (w + 0.6)) / 2, 0.12, (sz * (d + 0.8)) / 2 - 0.4), { box: 1, grain: 'y' });
  k.b.timber.box(w + 1.0, 0.18, 0.18, '#6e4a2c', at(m, 0, 3.05, -d / 2 - 0.8));
  k.b.timber.box(w + 1.0, 0.18, 0.18, '#6e4a2c', at(m, 0, 3.05, d / 2));
  k.b.thatch.add(hipRoof(w + 2.4, d + 3.0, 2.0, 0.5, 0.3), '#e2c995', at(m, 0, 3.1, -0.4));
  // the sign over the counter
  const r = k.atlas.sign(o.name, 640, 160, { ...o.sign, sub: o.sub });
  // the board hangs from the front beam, above the customers' heads
  k.b.signs.add(signPlane(3.2, 0.8, r), '#ffffff', at(m, 0, 2.55, -d / 2 - 0.94).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
  k.b.timber.box(3.4, 0.9, 0.06, '#5b3a22', at(m, 0, 2.55, -d / 2 - 0.9));
  for (const sx of [-1.4, 1.4]) k.b.metal.box(0.02, 0.1, 0.02, IRON, at(m, sx, 3.0, -d / 2 - 0.85));
  // wares
  if (o.kind === 'smoothie' || o.kind === 'tiki') {
    const fruit = ['#f5c020', '#e8462c', '#7fbf3a', '#f08a1c', '#ffd44d'];
    for (let i = 0; i < 9; i++) k.b.paint.add(new THREE.IcosahedronGeometry(0.1, 1), fruit[i % fruit.length], at(m, -w / 2 + 0.6 + i * ((w - 1.2) / 8), 1.3, -d / 2 + 0.35));
    for (let i = 0; i < 3; i++) k.b.metal.add(cyl(0.09, 0.1, 0.38, 10), i === 1 ? '#e8e8e8' : '#c03030', at(m, -1 + i, 1.24, d / 2 - 0.6));
    // bottles on the shelves
    const glass = ['#3a6b3a', '#8a4a20', '#d0d0c0', '#2a4a7a'];
    for (let s = 0; s < 2; s++) for (let i = 0; i < 12; i++) k.b.paint.add(cyl(0.035, 0.03, 0.28, 6), glass[(i + s) % 4], at(m, -w / 2 + 0.6 + i * ((w - 1.2) / 11), 1.43 + s * 0.55, d / 2 - 0.25));
  }
  if (o.kind === 'surf') {
    const boards = ['#f25c54', '#2ec4b6', '#ffd23f', '#3a86ff', '#ff8fab', '#ffffff'];
    for (let i = 0; i < 6; i++) {
      const bm = at(m, -w / 2 - 0.35, 0.12, -d / 2 + 0.6 + i * 0.55).multiply(new THREE.Matrix4().makeRotationX(0.12));
      k.b.paint.add(new THREE.SphereGeometry(1, 10, 6).scale(0.04, 1.05, 0.26).translate(0, 1.05, 0), boards[i], bm.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    }
  }
  if (o.kind === 'ice') {
    // an open display freezer (a glass lid would be the park's only glass: a draw call of its own)
    k.b.paint.box(1.6, 0.9, 0.7, '#e9f4f6', at(m, 0, 0.57, d / 2 - 0.6));
    const tubs = ['#f6d6e0', '#fff1c9', '#7a4a2c', '#bfe8c8', '#f7b0a0'];
    for (let i = 0; i < 5; i++) k.b.paint.box(0.26, 0.04, 0.4, tubs[i], at(m, -0.6 + i * 0.3, 1.0, d / 2 - 0.6));
  }
  const seats: Seat[] = [];
  const n = o.stools ?? Math.max(0, Math.floor(w / 1.1));
  for (let i = 0; i < n; i++) {
    const lx = -w / 2 + 0.7 + i * ((w - 1.4) / Math.max(1, n - 1));
    k.b.metal.add(cyl(0.025, 0.025, 0.75, 6), IRON, at(m, lx, 0.12, -d / 2 - 0.55));
    k.b.timber.add(cyl(0.19, 0.19, 0.06, 10), '#7a4f2c', at(m, lx, 0.82, -d / 2 - 0.55), { box: 2 });
    const s = local(x, z, yaw, lx, -d / 2 - 0.85);
    seats.push({ x: s.x, z: s.z, yaw: yaw + Math.PI });
  }
  block(k, local(x, z, yaw, 0, 0.2).x, local(x, z, yaw, 0, 0.2).z, w / 2 + 0.1, d / 2 + 0.2, 2.8, yaw);
  return seats;
}

/** The lifeguard tower: a painted hut on stilts with a ramp down to the sand at the back (+z) and a flag. */
export function lifeguardTower(k: Build, x: number, z: number, yaw: number) {
  const m = place(x, 0, z, yaw);
  const hut = '#f3f0e6';
  const accent = '#e8463c';
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.b.timber.add(cyl(0.1, 0.1, 2.3, 6), '#d8c7a6', at(m, sx * 1.15, 0, sz * 1.15), { box: 1, grain: 'y' });
  // cross bracing
  for (const sx of [-1, 1]) k.b.timber.add(new THREE.BoxGeometry(0.06, 3.2, 0.08), '#cbb894', at(m, sx * 1.15, 1.1, 0).multiply(new THREE.Matrix4().makeRotationX(0.78)), { box: 1, grain: 'y' });
  k.b.deck.box(3.3, 0.14, 3.6, '#c4a070', at(m, 0, 2.35, 0.15), { box: 0.5 });
  k.b.paint.box(2.6, 1.9, 2.4, hut, at(m, 0, 3.37, 0.2));
  k.b.paint.box(2.62, 0.35, 2.42, accent, at(m, 0, 2.6, 0.2));
  // windows all round (dark glass), a red cross on the front
  k.b.paint.box(2.0, 0.7, 0.04, '#2b3c48', at(m, 0, 3.6, -1.0));
  for (const sx of [-1, 1]) k.b.paint.box(0.04, 0.7, 1.6, '#2b3c48', at(m, sx * 1.31, 3.6, 0.2));
  k.b.paint.box(0.5, 0.14, 0.03, accent, at(m, 0, 2.95, -1.03));
  k.b.paint.box(0.14, 0.5, 0.03, accent, at(m, 0, 2.95, -1.03));
  // a sloping roof with an overhang, and the railing on the front deck
  k.b.paint.add(new THREE.BoxGeometry(3.2, 0.12, 3.4), '#2ec4b6', at(m, 0, 4.42, 0.15).multiply(new THREE.Matrix4().makeRotationX(-0.12)));
  for (let i = 0; i < 7; i++) k.b.timber.add(cyl(0.03, 0.03, 0.9, 5), WHITE, at(m, -1.5 + i * 0.5, 2.42, -1.5));
  k.b.timber.box(3.1, 0.06, 0.08, WHITE, at(m, 0, 3.32, -1.5));
  // the ramp down the back
  const ramp = at(m, 0, 1.2, 3.25).multiply(new THREE.Matrix4().makeRotationX(0.47));
  k.b.deck.box(1.0, 0.08, 5.0, '#c4a070', ramp, { box: 0.5 });
  // the flag, and a rescue tube hanging on the rail
  k.b.metal.add(cyl(0.025, 0.02, 3.2, 6), WHITE, at(m, 1.35, 4.4, -0.9));
  k.b.fabric.box(0.02, 0.5, 0.75, accent, at(m, 1.35, 7.25, -1.28));
  k.b.fabric.box(0.02, 0.25, 0.75, '#ffd23f', at(m, 1.35, 7.37, -1.28));
  k.b.paint.box(0.16, 0.9, 0.12, '#ff6b1a', at(m, -0.9, 2.6, -1.58));
  block(k, x, z, 1.3, 1.3, 2.4, yaw);
}

// ------------------------------------------------------------------------------------------------
// Beach clutter
// ------------------------------------------------------------------------------------------------

/** A sandcastle with four towers and a moat, with a bucket and spade beside it. */
export function sandcastle(k: Build, x: number, z: number, s = 1) {
  const m = place(x, 0, z, k.rnd() * Math.PI, s);
  const sand = '#d6b77c';
  k.b.paint.add(cyl(0.62, 0.55, 0.32, 14), sand, m);
  k.b.paint.add(cyl(0.3, 0.26, 0.6, 10), sand, m);
  k.b.paint.add(new THREE.ConeGeometry(0.28, 0.32, 10).translate(0, 0.76, 0), sand, m);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const t = at(m, Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
    k.b.paint.add(cyl(0.13, 0.12, 0.5, 8), sand, t);
    k.b.paint.add(new THREE.ConeGeometry(0.14, 0.2, 8).translate(0, 0.6, 0), sand, t);
  }
  k.b.ground.add(new THREE.RingGeometry(0.66, 0.9, 20).rotateX(-Math.PI / 2), '#a88c5c', at(m, 0, 0.01, 0));
  const bucket = ['#e8463c', '#2a7fff', '#ffd23f', '#2ec4b6'][Math.floor(k.rnd() * 4)];
  k.b.paint.add(cyl(0.09, 0.12, 0.22, 10), bucket, at(m, 1.0, 0, 0.3));
  k.b.paint.add(new THREE.BoxGeometry(0.1, 0.02, 0.18), bucket, at(m, 0.9, 0.02, -0.4, 0.6));
  k.b.paint.add(cyl(0.012, 0.012, 0.3, 4), bucket, at(m, 0.9, 0.02, -0.25).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
}

/** A sit-on-top kayak drawn up on the sand, with its paddle. */
export function kayak(k: Build, x: number, z: number, yaw: number, colour: string) {
  const m = place(x, 0, z, yaw);
  k.b.paint.add(new THREE.SphereGeometry(1, 14, 8).scale(0.36, 0.17, 1.75).translate(0, 0.12, 0), colour, m);
  k.b.paint.add(new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.22, 0.04, 0.42).translate(0, 0.27, 0.1), '#2a2a2a', m);
  k.b.metal.add(cyl(0.015, 0.015, 2.1, 5), '#222222', at(m, 0.55, 0.03, -1.0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  for (const e of [-1.05, 1.05]) k.b.paint.add(new THREE.SphereGeometry(1, 6, 4).scale(0.08, 0.015, 0.22), colour, at(m, 0.55, 0.04, -1.0 + e));
}

/** A beach shower: a chrome post with a rose and a timber duckboard. */
export function shower(k: Build, x: number, z: number) {
  const m = place(x, 0, z);
  k.b.deck.box(1.2, 0.08, 1.2, '#b08a5c', at(m, 0, 0.04, 0), { box: 0.5 });
  k.b.metal.add(cyl(0.04, 0.04, 2.4, 8), '#d8dde0', m);
  k.b.metal.add(new THREE.BoxGeometry(0.5, 0.04, 0.04).translate(0.25, 0, 0), '#d8dde0', at(m, 0, 2.38, 0));
  k.b.metal.add(cyl(0.1, 0.06, 0.06, 10), '#d8dde0', at(m, 0.5, 2.3, 0));
}

// ------------------------------------------------------------------------------------------------
// Lights and signs
// ------------------------------------------------------------------------------------------------

/** A tiki torch: a bamboo pole with a bronze cup and a flame (lit at night). */
export function torch(k: Build, x: number, z: number, h = 2.1) {
  const m = place(x, 0, z);
  k.b.timber.add(cyl(0.045, 0.035, h, 6), '#c9a66b', m, { box: 2, grain: 'y' });
  for (let i = 1; i < 4; i++) k.b.timber.add(cyl(0.05, 0.05, 0.03, 6), '#8a6a3a', at(m, 0, (h * i) / 4, 0));
  k.b.metal.add(cyl(0.05, 0.085, 0.16, 8), '#5a4a32', at(m, 0, h, 0));
  k.lights.addFlame(new THREE.Vector3(x, h + 0.13, z));
}

/** A lantern post: a bronze post with a glass lantern that glows at night. */
export function lantern(k: Build, x: number, z: number, h = 3.2) {
  const m = place(x, 0, z);
  k.b.metal.add(cyl(0.08, 0.05, h, 8), '#3a3328', m);
  k.b.metal.add(cyl(0.14, 0.14, 0.12, 8), '#3a3328', m);
  k.b.lit.add(cyl(0.13, 0.11, 0.38, 6), '#ffe1a8', at(m, 0, h, 0));
  k.b.metal.add(new THREE.ConeGeometry(0.2, 0.18, 6).translate(0, 0.09, 0), '#3a3328', at(m, 0, h + 0.38, 0));
  k.lights.addHalo(new THREE.Vector3(x, h + 0.2, z), '#ffcf8a', 1.4);
  k.lights.addPool(x, 0, z, 6, '#ffbf7a');
  if (k.colliders) staticCylinder(k.ctx, x, z, 0.12, 2);
}

/** A tall timber pole carrying festoon strings (returns its top, where the strings hang from). */
export function stringPole(k: Build, x: number, z: number, h = 4.6) {
  const m = place(x, 0, z);
  k.b.timber.add(cyl(0.085, 0.07, h, 7), '#8a6a44', m, { box: 1, grain: 'y' });
  k.b.metal.add(new THREE.SphereGeometry(0.06, 6, 4), '#3a3328', at(m, 0, h, 0));
  if (k.colliders) staticCylinder(k.ctx, x, z, 0.1, 2);
  return new THREE.Vector3(x, h - 0.1, z);
}

/** A hardwood fingerpost with arrow boards pointing at places (bearing in radians, park yaw: 0 = north). */
export function fingerpost(k: Build, x: number, z: number, arms: { text: string; yaw: number; colour: string }[]) {
  const m = place(x, 0, z);
  k.b.timber.add(cyl(0.09, 0.08, 3.4, 8), '#6e4a2c', m, { box: 1, grain: 'y' });
  k.b.timber.add(new THREE.ConeGeometry(0.12, 0.2, 8).translate(0, 3.5, 0), '#5b3a22', m);
  arms.forEach((a, i) => {
    // an arrow board pointing along `yaw`: its tip at the board's +x end
    // seen from the other side the tip is on the left, so that face gets its own left-pointing board
    const style: SignStyle = { bg: a.colour, fg: '#ffffff', font: 'display', square: true, border: '#fff5e3' };
    const front = k.atlas.sign(a.text, 512, 112, { ...style, arrow: 'right' });
    const back = k.atlas.sign(a.text, 512, 112, { ...style, arrow: 'left' });
    const bm = at(m, 0, 3.05 - i * 0.42, 0, a.yaw + Math.PI / 2).multiply(new THREE.Matrix4().makeTranslation(0.85, 0, 0));
    k.b.signs.add(signPlane(1.6, 0.36, front), '#ffffff', bm.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.026)));
    k.b.signs.add(signPlane(1.6, 0.36, back), '#ffffff', bm.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.026)).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
    k.b.timber.box(1.62, 0.37, 0.045, '#5b3a22', bm);
  });
  if (k.colliders) staticCylinder(k.ctx, x, z, 0.12, 2);
}

// ------------------------------------------------------------------------------------------------
// The fountain
// ------------------------------------------------------------------------------------------------

/**
 * The Beach Plaza's fountain: a wide coral-stone basin with a seat-height rim, a fluted column and
 * two bowls spilling water sheets into the pool. Its water uses the shared water material, whose
 * ripple map scrolls (PalmCay.update).
 */
export function fountain(k: Build, x: number, z: number) {
  const m = place(x, 0, z);
  const stone = '#efe4cc';
  const R = 7;
  k.b.stone.add(new THREE.CylinderGeometry(R + 0.3, R + 0.35, 0.55, 64, 1, true).translate(0, 0.275, 0), stone, m, { box: 0.5 });
  k.b.stone.add(new THREE.CylinderGeometry(R - 0.3, R - 0.3, 0.55, 64, 1, true).translate(0, 0.275, 0), '#d8ccb0', m, { box: 0.5 });
  k.b.stone.add(new THREE.RingGeometry(R - 0.32, R + 0.37, 64).rotateX(-Math.PI / 2).translate(0, 0.55, 0), '#f6eedc', m, { box: 0.5 });
  k.b.paint.add(new THREE.CircleGeometry(R - 0.3, 48).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#3f8f9a', m);
  k.b.water.add(new THREE.CircleGeometry(R - 0.3, 48).rotateX(-Math.PI / 2).translate(0, 0.42, 0), '#ffffff', m, { box: 0.25 });
  // column and bowls (lathed)
  const lathe = (pts: [number, number][], seg = 32) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  k.b.stone.add(lathe([[0, 0], [1.3, 0], [1.3, 0.35], [0.9, 0.5], [0.55, 0.7], [0.45, 1.6], [0.5, 1.75], [0.35, 1.85]]), stone, m, { box: 0.5 });
  k.b.stone.add(lathe([[0.3, 1.8], [1.2, 2.0], [2.3, 2.35], [2.4, 2.5], [2.25, 2.52]]), stone, m, { box: 0.5 });
  k.b.water.add(new THREE.CircleGeometry(2.25, 32).rotateX(-Math.PI / 2).translate(0, 2.47, 0), '#ffffff', m, { box: 0.4 });
  k.b.stone.add(lathe([[0, 2.45], [0.3, 2.5], [0.25, 3.3], [0.32, 3.4], [0.2, 3.5]]), stone, m, { box: 0.5 });
  k.b.stone.add(lathe([[0.15, 3.45], [0.6, 3.6], [1.0, 3.85], [1.05, 3.95], [0.95, 3.96]]), stone, m, { box: 0.5 });
  k.b.water.add(new THREE.CircleGeometry(0.95, 24).rotateX(-Math.PI / 2).translate(0, 3.92, 0), '#ffffff', m, { box: 0.4 });
  k.b.stone.add(lathe([[0, 3.9], [0.16, 3.95], [0.1, 4.3], [0.18, 4.45], [0, 4.7]], 16), '#f6eedc', m, { box: 0.5 });
  // the water sheets falling off each bowl's rim
  k.b.water.add(new THREE.CylinderGeometry(1.07, 1.25, 1.45, 32, 1, true).translate(0, 3.2, 0), '#ffffff', m, { box: 0.5, grain: 'y' });
  k.b.water.add(new THREE.CylinderGeometry(2.42, 2.75, 2.08, 48, 1, true).translate(0, 1.46, 0), '#ffffff', m, { box: 0.5, grain: 'y' });
  // four little jets arcing in from the rim
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(Math.cos(a) * (R - 0.5), 0.5, Math.sin(a) * (R - 0.5)), new THREE.Vector3(Math.cos(a) * 4.6, 2.6, Math.sin(a) * 4.6), new THREE.Vector3(Math.cos(a) * 3.0, 0.42, Math.sin(a) * 3.0));
    k.b.water.add(new THREE.TubeGeometry(curve, 10, 0.05, 5), '#ffffff', m, { box: 1 });
    k.b.metal.add(cyl(0.06, 0.05, 0.12, 6), '#b08a4a', at(m, Math.cos(a) * (R - 0.5), 0.45, Math.sin(a) * (R - 0.5)));
  }
  // underwater lights in the basin, between the falling sheet and where the jets land (at night)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.lights.addHalo(new THREE.Vector3(x + Math.cos(a) * 4.1, 0.5, z + Math.sin(a) * 4.1), '#9fe8ff', 1.6);
  }
  k.lights.addPool(x, 0.43, z, 6.5, '#7fd8ff');
  if (k.colliders) staticCylinder(k.ctx, x, z, R + 0.35, 0.6);
}

// ------------------------------------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------------------------------------

/** A paved coral-stone path along a polyline (kerbs on both sides). */
export function pavedPath(k: Build, pts: V2[], width: number, colour = '#f2e7cf', kerb = true) {
  k.b.stone.add(strip(pts, width, 0.04, 1 / 2.4), colour, place(pts[0].x, 0, pts[0].z));
  if (!kerb) return;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    for (const side of [-1, 1]) {
      const c = local((a.x + b.x) / 2, (a.z + b.z) / 2, yaw, (side * (width + 0.25)) / 2, 0);
      k.b.stone.box(0.25, 0.12, len + 0.2, '#d9cdb2', place(c.x, 0.06, c.z, yaw), { box: 1 / 1.2 });
    }
  }
}

/**
 * A boardwalk on the sand along a polyline: planks across the walk at ground level (the visitor
 * walks at y = 0), stringers either side and rope-and-post edges.
 */
export function boardwalk(k: Build, pts: V2[], width: number, rope = true) {
  k.b.deck.add(strip(pts, width, 0.07, 0.5), '#d6b48a', place(pts[0].x, 0, pts[0].z));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    for (const side of [-1, 1]) {
      const c = local((a.x + b.x) / 2, (a.z + b.z) / 2, yaw, (side * (width + 0.12)) / 2, 0);
      k.b.timber.box(0.12, 0.14, len + 0.1, '#8a6440', place(c.x, 0.05, c.z, yaw), { box: 1 });
      if (!rope) continue;
      const n = Math.max(1, Math.round(len / 3));
      for (let j = 0; j <= n; j++) {
        if (j === 0 && i > 1) continue;
        const pp = local(a.x + ((b.x - a.x) * j) / n, a.z + ((b.z - a.z) * j) / n, yaw, (side * (width + 0.3)) / 2, 0);
        k.b.timber.add(cyl(0.06, 0.055, 0.85, 6), '#9a7450', place(pp.x, 0, pp.z), { box: 2, grain: 'y' });
      }
      // the rope sags between posts: one gently drooping bar per span
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        const pp = local(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, yaw, (side * (width + 0.3)) / 2, 0);
        k.b.paint.box(0.035, 0.035, len / n, '#d8c8a0', place(pp.x, 0.7, pp.z, yaw));
      }
    }
  }
}

/** A pier out over the water from (x, z0) to (x, z1): deck on timber piles, rails, a thatched gazebo at the end. */
export function pier(k: Build, x: number, z0: number, z1: number, width = 3.6): Seat[] {
  const len = z1 - z0;
  const m = place(x, 0, (z0 + z1) / 2);
  k.b.deck.box(width, 0.14, len, '#cfa77a', at(m, 0, -0.03, 0), { box: 0.5, grain: 'x' });
  for (let zz = z0 + 2; zz <= z1; zz += 3.2)
    for (const sx of [-1, 1]) {
      k.b.timber.add(cyl(0.16, 0.16, 4.2, 7), '#6b5038', place(x + (sx * (width - 0.2)) / 2, -4.1, zz), { box: 1, grain: 'y' });
      k.b.timber.add(cyl(0.05, 0.05, 1.0, 5), '#8a6a48', place(x + (sx * (width - 0.05)) / 2, 0.1, zz), { box: 2, grain: 'y' });
    }
  for (const sx of [-1, 1]) {
    k.b.timber.box(0.08, 0.08, len, '#a07c58', at(m, (sx * (width - 0.05)) / 2, 1.05, 0));
    k.b.timber.box(0.05, 0.05, len, '#a07c58', at(m, (sx * (width - 0.05)) / 2, 0.6, 0));
  }
  // the gazebo: a wider hexagonal deck, six posts, a thatched cone roof and benches round the rail
  const gz = z1 + 4.5;
  // corners at 0°, 60°…, so an edge (not a post) faces back along the pier
  k.b.deck.add(new THREE.CylinderGeometry(5.2, 5.2, 0.14, 6).rotateY(Math.PI / 6).translate(0, -0.03, 0), '#cfa77a', place(x, 0, gz), { box: 0.5 });
  const seats: Seat[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.b.timber.add(cyl(0.16, 0.14, 4.05, 7), '#6b5038', place(x + Math.cos(a) * 4.8, -4.1, gz + Math.sin(a) * 4.8), { box: 1, grain: 'y' });
    k.b.timber.add(cyl(0.12, 0.11, 3.0, 7), '#7a5a3a', place(x + Math.cos(a) * 4.6, 0.12, gz + Math.sin(a) * 4.6), { box: 1, grain: 'y' });
    const mid = a + Math.PI / 6;
    if (i !== 4) {
      // a bench along the rail between posts (not across the pier's mouth)
      const bx = x + Math.cos(mid) * 3.9;
      const bz = gz + Math.sin(mid) * 3.9;
      const yaw = Math.atan2(Math.cos(mid), Math.sin(mid)) + Math.PI;
      k.b.timber.box(3.6, 0.06, 0.45, '#9a6a42', place(bx, 0.48, bz, yaw), { box: 1, grain: 'x' });
      k.b.timber.box(3.6, 0.42, 0.06, '#7a5a3a', place(bx, 0.27, bz, yaw), { box: 1 });
      const s = local(bx, bz, yaw, 0, -0.1);
      seats.push({ x: s.x, z: s.z, yaw });
    }
  }
  k.b.thatch.add(coneRoof(6.2, 3.2, 6, 0.5), '#e2c995', place(x, 3.1, gz));
  k.b.thatch.add(coneRoof(1.4, 0.9, 6, 0.5), '#d4b47a', place(x, 6.0, gz));
  k.lights.addHalo(new THREE.Vector3(x, 2.7, gz), '#ffcf8a', 2);
  k.b.lit.add(new THREE.SphereGeometry(0.22, 10, 8), '#ffe0a8', place(x, 2.75, gz));
  k.lights.addPool(x, 0.13, gz, 5.5, '#ffbf7a');
  if (k.colliders) {
    // the pier's rails (the visitor walks out along the deck but not off its sides)
    for (const sx of [-1, 1]) staticBox(k.ctx, x + (sx * (width + 0.1)) / 2, 0.6, (z0 + z1) / 2 + 0.5, 0.08, 0.6, len / 2 - 0.5);
  }
  return seats;
}

/** A flat bed of mulch or sand for planting, a rounded rectangle (w × d) at (x, z), with a stone kerb. */
export function bed(k: Build, x: number, z: number, w: number, d: number, yaw = 0, kerb = true) {
  const m = place(x, 0, z, yaw);
  const r = Math.min(w, d) * 0.45;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -d / 2);
  shape.lineTo(w / 2 - r, -d / 2);
  shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  shape.lineTo(w / 2, d / 2 - r);
  shape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
  shape.lineTo(-w / 2 + r, d / 2);
  shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
  shape.lineTo(-w / 2, -d / 2 + r);
  shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  const g = new THREE.ShapeGeometry(shape, 4).rotateX(-Math.PI / 2);
  k.b.ground.add(g, '#5a3e28', at(m, 0, 0.03, 0), { box: 0.5 });
  if (kerb) {
    const pts = shape.getSpacedPoints(Math.max(12, Math.round((w + d) * 1.2)));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const kyaw = Math.atan2(-(b.x - a.x), (b.y - a.y));
      k.b.stone.box(0.2, 0.16, len + 0.05, '#e3d7bd', at(m, (a.x + b.x) / 2, 0.08, -(a.y + b.y) / 2, kyaw), { box: 1 / 1.2 });
    }
  }
}

/** A disc of paving (plazas), with an optional inlay ring. */
export function pavedDisc(k: Build, x: number, z: number, r: number, colour: string, y = 0.045) {
  k.b.stone.add(disc(r, y, 72, 1 / 2.4), colour, place(x, 0, z));
}
