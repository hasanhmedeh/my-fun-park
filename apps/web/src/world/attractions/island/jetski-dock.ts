// The jet-ski dock on Palm Cay's south beach: a hardwood jetty on piles from the end of the
// beach boardwalk out over the water to a T-head, with a floating pontoon below it where the race
// skis and the rental fleet are moored; the ticket hut at the jetty's foot (the race's zone ring is
// in front of it), the race-control tower on the T-head, rope rails, lanterns and festoon strings.
// Built with Palm Cay's own kit (kit.ts: one draw call per material for the lot, the island's
// shared materials and night lights), so it looks of a piece with the park round it.

import * as THREE from 'three';
import { staticBox, type Ctx } from '../../context';
import type { WalkRect } from '../../island/kit';
import { at, Batches, islandMaterials, place, post } from '../../island/kit';
import { NightLights } from '../../island/lights';
import { SEA_Y } from '../../geo';
import { signTexture } from '../../textures';
import { DOCK } from './jetski-course';

/** The pontoon's deck height (it floats: a third of a metre above the water line). */
export const PONTOON_Y = SEA_Y + 0.34;
/** The jetty's T-head: a wide fixed platform across the jetty's end. */
export const HEAD = { x0: DOCK.x - 11, x1: DOCK.x + 11, z0: DOCK.z1 - 9, z1: DOCK.z1 };
/** The jetty and its head, walkable at y = 0 (register them with the island's walk areas). */
export const JETSKI_WALK: WalkRect[] = [
  { x0: DOCK.x - DOCK.half + 0.3, x1: DOCK.x + DOCK.half - 0.3, z0: DOCK.z0, z1: HEAD.z0 + 0.5 },
  { x0: HEAD.x0 + 0.4, x1: HEAD.x1 - 0.4, z0: HEAD.z0, z1: HEAD.z1 - 0.5 },
];
/** The zone ring: on the sand at the jetty's foot, in front of the ticket hut, facing out to sea. */
export const JETSKI_RING = { x: DOCK.x, z: DOCK.z0 + 15, heading: Math.PI };
/** Where the rental skis lie moored along the pontoon's seaward edge (nose to the pontoon). */
export const MOORINGS: { x: number; z: number; h: number }[] = (() => {
  const out: { x: number; z: number; h: number }[] = [];
  for (let x = DOCK.pontoon.x0 + 5; x <= DOCK.pontoon.x1 - 5; x += 5.2) {
    if (Math.abs(x - DOCK.x) < 6) continue; // the gangway's landing
    out.push({ x, z: DOCK.pontoon.z1 + 2.2, h: 0 });
  }
  return out;
})();
/** Spots along the T-head's seaward rail and the pontoon where spectators stand (y, and facing south). */
export const SPECTATOR_SPOTS: { x: number; y: number; z: number }[] = (() => {
  const out: { x: number; y: number; z: number }[] = [];
  for (let x = HEAD.x0 + 1.2; x <= HEAD.x1 - 1.2; x += 1.15) if (Math.abs(x - DOCK.x) > 1.6) out.push({ x, y: 0, z: HEAD.z1 - 0.8 - ((x * 7.3) % 1) * 0.5 });
  for (let x = DOCK.pontoon.x0 + 1.5; x <= DOCK.pontoon.x1 - 1.5; x += 3.1) if (Math.abs(x - DOCK.x) > 7) out.push({ x, y: PONTOON_Y, z: DOCK.pontoon.z0 + 1.2 + ((x * 3.7) % 1) * 1.6 });
  return out;
})();

const DECK = '#cfa77a';
const WHITE = '#f4f1ea';
const ROPE = '#d8c8a0';

/** The dock and its buildings. `setNight` and `update` drive its lights. */
export class Dock {
  readonly group = new THREE.Group();
  private lights: NightLights;
  private signMats: THREE.MeshStandardMaterial[] = [];

  constructor(private ctx: Ctx) {
    const origin = new THREE.Vector3(DOCK.x, 0, (DOCK.z0 + DOCK.z1) / 2);
    const lean = ctx.quality.tier === 'low' || ctx.quality.tier === 'lowest';
    const b = new Batches(origin);
    this.lights = new NightLights(origin, lean);
    this.jetty(b);
    this.head(b);
    this.pontoon(b);
    this.hut(b);
    this.tower(b);
    const mats = islandMaterials(ctx.renderer);
    // (no atlas signs here: the boards below have their own textures)
    b.build(this.group, mats, mats.paint, ctx.quality.shadows, lean);
    this.lights.build();
    this.group.add(this.lights.group);
    this.signs();
    this.colliders();
  }

  /** The jetty: deck on paired piles, a rope rail each side, lanterns and festoon strings. */
  private jetty(b: Batches) {
    const len = HEAD.z0 - DOCK.z0;
    const w = DOCK.half * 2;
    const m = place(DOCK.x, 0, (DOCK.z0 + HEAD.z0) / 2);
    b.deck.box(w, 0.14, len, DECK, at(m, 0, -0.03, 0), { box: 0.5, grain: 'x' });
    // stringers under the deck's edges, and the piles (driven deep: the sand and the sea hide their feet)
    for (const sx of [-1, 1]) b.timber.box(0.18, 0.26, len, '#5e4630', at(m, (sx * (w - 0.2)) / 2, -0.23, 0));
    for (let z = DOCK.z0 + 3; z < HEAD.z0; z += 3.2)
      for (const sx of [-1, 1]) {
        b.timber.add(post(0.17, 0.15, 4.6, 8), '#5b432c', place(DOCK.x + (sx * (w - 0.15)) / 2, -4.5, z), { box: 1, grain: 'y' });
        b.timber.add(post(0.055, 0.05, 1.05, 6), '#8a6a48', place(DOCK.x + (sx * (w + 0.05)) / 2, 0.04, z), { box: 2, grain: 'y' });
      }
    // a cross-brace under every other bay, where the water shows it
    for (let z = DOCK.z0 + 50; z < HEAD.z0; z += 6.4) b.timber.add(new THREE.BoxGeometry(w * 1.12, 0.1, 0.12), '#5e4630', place(DOCK.x, -0.85, z).multiply(new THREE.Matrix4().makeRotationZ(0.35)), { box: 1 });
    // the rails: a top rope and a lower one, drooping a little between the posts
    for (const sx of [-1, 1]) {
      const x = DOCK.x + (sx * (w + 0.05)) / 2;
      b.timber.box(0.09, 0.07, len, '#a07c58', place(x, 1.08, (DOCK.z0 + HEAD.z0) / 2));
      b.paint.box(0.04, 0.04, len, ROPE, place(x, 0.62, (DOCK.z0 + HEAD.z0) / 2));
    }
    // lanterns every 18 m on alternate sides, festoon strings between poles down both rails
    let side = 1;
    for (let z = DOCK.z0 + 9; z < HEAD.z0 - 4; z += 18) {
      this.lantern(b, DOCK.x + side * (DOCK.half + 0.25), z, 3.1);
      side = -side;
    }
    const poles: THREE.Vector3[][] = [[], []];
    for (let z = DOCK.z0 + 4; z <= HEAD.z0 + 0.5; z += 24)
      for (const [k, sx] of [
        [0, -1],
        [1, 1],
      ] as const) {
        const x = DOCK.x + sx * (DOCK.half + 0.3);
        b.timber.add(post(0.075, 0.06, 4.4, 7), '#8a6a44', place(x, 0, z), { box: 1, grain: 'y' });
        poles[k].push(new THREE.Vector3(x, 4.3, z));
      }
    const pennants = ['#ff4d6d', '#ffd23f', '#2ec4b6', '#3a86ff', '#ffffff'];
    for (const row of poles)
      for (let i = 1; i < row.length; i++) {
        this.lights.addString(row[i - 1], row[i], { sag: 0.7, spacing: 1.2 });
        // pennant bunting under the festoon wire: little triangles along a second line
        const a = row[i - 1];
        const c = row[i];
        const n = 14;
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const p = a.clone().lerp(c, t);
          p.y -= Math.sin(t * Math.PI) * 0.9 + 0.35;
          const flag = new THREE.BufferGeometry();
          flag.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.22, 0, 0, 0.22, 0, -0.42, 0], 3));
          flag.computeVertexNormals();
          b.fabric.add(flag, pennants[k % pennants.length], place(p.x, p.y, p.z));
        }
      }
  }

  /** The T-head: a wide platform with rails round it, life rings, benches, the gangways down to the pontoon. */
  private head(b: Batches) {
    const w = HEAD.x1 - HEAD.x0;
    const d = HEAD.z1 - HEAD.z0;
    const cx = (HEAD.x0 + HEAD.x1) / 2;
    const cz = (HEAD.z0 + HEAD.z1) / 2;
    b.deck.box(w, 0.14, d, DECK, place(cx, -0.03, cz), { box: 0.5, grain: 'z' });
    for (let x = HEAD.x0 + 0.3; x <= HEAD.x1; x += 3.6)
      for (const z of [HEAD.z0 + 0.3, HEAD.z1 - 0.3, cz]) b.timber.add(post(0.18, 0.16, 4.7, 8), '#5b432c', place(x, -4.6, z), { box: 1, grain: 'y' });
    // rails on three sides (the jetty comes in at the north, the gangways leave from the south)
    const rail = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      b.timber.box(0.09, 0.07, len, '#a07c58', place(mx, 1.08, mz, yaw));
      b.paint.box(0.04, 0.04, len, ROPE, place(mx, 0.62, mz, yaw));
      const n = Math.max(1, Math.round(len / 2.4));
      for (let k = 0; k <= n; k++) b.timber.add(post(0.055, 0.05, 1.05, 6), '#8a6a48', place(x0 + ((x1 - x0) * k) / n, 0.04, z0 + ((z1 - z0) * k) / n), { box: 2, grain: 'y' });
    };
    rail(HEAD.x0, HEAD.z0, DOCK.x - DOCK.half, HEAD.z0);
    rail(DOCK.x + DOCK.half, HEAD.z0, HEAD.x1, HEAD.z0);
    rail(HEAD.x0, HEAD.z0, HEAD.x0, HEAD.z1);
    rail(HEAD.x1, HEAD.z0, HEAD.x1, HEAD.z1);
    rail(HEAD.x0, HEAD.z1, DOCK.x - 1.4, HEAD.z1);
    rail(DOCK.x + 1.4, HEAD.z1, HEAD.x1, HEAD.z1);
    // the gangway down to the pontoon (a slatted ramp with hand ropes) and a chain across its top
    const drop = 0.04 - PONTOON_Y;
    const run = DOCK.pontoon.z0 + 2.6 - HEAD.z1;
    const slope = Math.atan2(drop, run);
    const g = place(DOCK.x, (0.04 + PONTOON_Y) / 2 - 0.05, HEAD.z1 + run / 2).multiply(new THREE.Matrix4().makeRotationX(-slope));
    b.deck.box(2.4, 0.08, Math.hypot(run, drop) + 0.2, DECK, g, { box: 0.5, grain: 'x' });
    for (const sx of [-1, 1]) b.paint.box(0.04, 0.04, Math.hypot(run, drop), ROPE, at(g, sx * 1.2, 0.9, 0));
    for (const sx of [-1, 1]) for (const k of [0, 1]) b.metal.add(post(0.03, 0.03, 0.95, 5), '#c9ccd2', at(g, sx * 1.2, 0, (k - 0.5) * Math.hypot(run, drop)));
    b.paint.box(2.8, 0.03, 0.03, '#d23a2a', place(DOCK.x, 0.75, HEAD.z1));
    // life rings on the rail posts, a bench either side of the jetty's mouth
    for (const x of [HEAD.x0 + 0.05, HEAD.x1 - 0.05]) b.paint.add(new THREE.TorusGeometry(0.36, 0.09, 8, 18).rotateY(Math.PI / 2), '#ff6b1a', place(x, 0.75, cz));
    for (const x of [HEAD.x0 + 0.05, HEAD.x1 - 0.05]) b.paint.add(new THREE.TorusGeometry(0.36, 0.092, 4, 18, 0.4).rotateY(Math.PI / 2), WHITE, place(x, 0.75, cz));
    for (const sx of [-1, 1]) {
      const x = DOCK.x + sx * 6.5;
      b.timber.box(3, 0.06, 0.45, '#9a6a42', place(x, 0.48, HEAD.z0 + 1.2), { box: 1, grain: 'x' });
      b.timber.box(3, 0.42, 0.06, '#7a5a3a', place(x, 0.27, HEAD.z0 + 1.05), { box: 1 });
    }
    // lanterns at the head's seaward corners
    this.lantern(b, HEAD.x1 - 0.4, HEAD.z1 - 0.4, 3.4);
    this.lantern(b, DOCK.x + 1.8, HEAD.z1 - 0.4, 3.4);
  }

  /** The floating pontoon: deck on foam floats, rubber fenders, cleats and the mooring slips. */
  private pontoon(b: Batches) {
    const p = DOCK.pontoon;
    const w = p.x1 - p.x0;
    const d = p.z1 - p.z0;
    const cx = (p.x0 + p.x1) / 2;
    const cz = (p.z0 + p.z1) / 2;
    b.deck.box(w, 0.12, d, '#c39a6c', place(cx, PONTOON_Y - 0.06, cz), { box: 0.5, grain: 'z' });
    // the floats: grey drums under the deck, showing a hand's breadth above the water
    for (let x = p.x0 + 1.5; x < p.x1; x += 3) for (const z of [p.z0 + 1.6, p.z1 - 1.6]) b.paint.add(new THREE.CylinderGeometry(0.55, 0.55, 2.6, 12).rotateX(Math.PI / 2), '#5d636b', place(x, PONTOON_Y - 0.62, z));
    // a dark timber kerb and fenders along the seaward edge
    b.timber.box(w, 0.2, 0.18, '#4f3a26', place(cx, PONTOON_Y - 0.1, p.z1 + 0.05));
    for (let x = p.x0 + 1; x < p.x1; x += 2.6) b.paint.add(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 8), '#1f2228', place(x, PONTOON_Y - 0.2, p.z1 + 0.18));
    // mooring slips: short finger floats between the skis, a cleat on each
    for (const mo of MOORINGS) {
      for (const sx of [-1, 1]) {
        b.deck.box(0.6, 0.1, 3.4, '#c39a6c', place(mo.x + sx * 2.6, PONTOON_Y - 0.08, p.z1 + 1.7), { box: 0.5, grain: 'x' });
        b.paint.add(new THREE.CylinderGeometry(0.28, 0.28, 3.2, 10).rotateX(Math.PI / 2), '#5d636b', place(mo.x + sx * 2.6, PONTOON_Y - 0.45, p.z1 + 1.7));
      }
      b.metal.add(new THREE.BoxGeometry(0.34, 0.08, 0.1), '#c9ccd2', place(mo.x, PONTOON_Y + 0.05, p.z1 - 0.2));
    }
    // a rack of life vests and a stack of spare buoys at the pontoon's east end
    const rack = place(p.x1 - 3, PONTOON_Y, p.z0 + 1.2);
    b.metal.box(2.4, 0.05, 0.05, '#c9ccd2', at(rack, 0, 1.55, 0));
    for (const sx of [-1, 1]) b.metal.add(post(0.03, 0.03, 1.6, 5), '#c9ccd2', at(rack, sx * 1.2, 0, 0));
    const vests = ['#ff6b1a', '#ffd23f', '#ff4d6d', '#3a86ff', '#ff6b1a', '#2ec4b6'];
    vests.forEach((c, k) => b.fabric.box(0.34, 0.5, 0.12, c, at(rack, -1 + k * 0.4, 1.22, 0.05)));
    for (let k = 0; k < 3; k++) b.paint.add(new THREE.CylinderGeometry(0.5, 0.55, 0.9, 12), k % 2 ? '#ffd23f' : '#ff4d2e', place(p.x0 + 2 + k * 1.15, PONTOON_Y + 0.45, p.z0 + 1.4));
  }

  /** The ticket hut at the jetty's foot, its counter facing the zone ring. */
  private hut(b: Batches) {
    const x = DOCK.x + 6.2;
    const z = DOCK.z0 + 12.5;
    const yaw = Math.PI / 2; // the counter faces west, onto the jetty's foot
    const m = place(x, 0, z, yaw);
    const blue = '#2f7fd8';
    b.deck.box(4.6, 0.14, 4.4, '#c9a87a', at(m, 0, 0.07, 0.3), { box: 0.5 });
    // walls of painted boards (open at the front, behind the counter)
    b.paint.box(4, 2.5, 0.1, blue, at(m, 0, 1.39, 1.6));
    for (const sx of [-1, 1]) b.paint.box(0.1, 2.5, 3.2, blue, at(m, sx * 2, 1.39, 0));
    b.paint.box(4, 0.6, 0.1, blue, at(m, 0, 2.34, -1.6));
    for (let i = -7; i <= 7; i++) b.paint.box(0.02, 2.5, 0.02, '#ffffff', at(m, i * 0.27, 1.39, 1.66));
    // the counter, its top, and a striped awning out over it
    b.paint.box(4, 1.0, 0.5, WHITE, at(m, 0, 0.64, -1.45));
    b.timber.box(4.2, 0.07, 0.75, '#9a6a42', at(m, 0, 1.17, -1.5), { box: 1, grain: 'x' });
    for (let k = 0; k < 8; k++) b.fabric.box(0.52, 0.04, 1.5, k % 2 ? '#ffffff' : '#ff4d6d', at(m, -1.82 + k * 0.52, 2.62, -2.2).multiply(new THREE.Matrix4().makeRotationX(0.32)));
    b.thatch.add(new THREE.BoxGeometry(4.8, 0.3, 4).translate(0, 0, 0), '#e2c995', at(m, 0, 2.78, 0));
    // a pair of skis on show on trestles beside the hut, and a flag
    b.metal.add(post(0.03, 0.025, 5.4, 6), WHITE, at(m, 2.4, 0.1, -1.6));
    b.fabric.box(0.02, 0.6, 1.0, '#3a86ff', at(m, 2.4, 5.1, -2.15));
    b.fabric.box(0.022, 0.2, 1.0, '#ffd23f', at(m, 2.4, 5.1, -2.15));
    this.lights.addHalo(new THREE.Vector3(x - 1.6, 2.4, z), '#ffcf8a', 1.2);
    this.lights.addPool(x - 1.8, 0, z, 4, '#ffbf7a');
  }

  /** Race control on the T-head's west end: a timber two-storey tower with a glazed cabin and flags. */
  private tower(b: Batches) {
    const x = HEAD.x0 + 3.2;
    const z = HEAD.z0 + 4.4;
    const m = place(x, 0, z);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.timber.add(post(0.12, 0.12, 3.2, 7), '#6b5038', at(m, sx * 1.6, 0, sz * 1.6), { box: 1, grain: 'y' });
    for (const sx of [-1, 1]) b.timber.add(new THREE.BoxGeometry(0.07, 4.4, 0.1), '#7a5a3a', at(m, sx * 1.6, 1.55, 0).multiply(new THREE.Matrix4().makeRotationX(0.72)), { box: 1, grain: 'y' });
    b.deck.box(4, 0.16, 4, '#c4a070', at(m, 0, 3.2, 0), { box: 0.5 });
    b.paint.box(3.4, 2.1, 3.4, WHITE, at(m, 0, 4.33, 0));
    b.paint.box(3.42, 0.3, 3.42, '#3a86ff', at(m, 0, 3.45, 0));
    // windows all round, the widest facing the course
    b.paint.box(3.0, 0.95, 0.04, '#24323d', at(m, 0, 4.55, 1.72));
    for (const sx of [-1, 1]) b.paint.box(0.04, 0.95, 2.6, '#24323d', at(m, sx * 1.72, 4.55, 0));
    b.paint.box(1.2, 0.95, 0.04, '#24323d', at(m, 0.6, 4.55, -1.72));
    b.paint.add(new THREE.BoxGeometry(4.2, 0.14, 4.2), '#2ec4b6', at(m, 0, 5.47, 0).multiply(new THREE.Matrix4().makeRotationX(0.06)));
    // the stairs up its east side
    const st = at(m, 2.25, 1.6, -0.3).multiply(new THREE.Matrix4().makeRotationX(-0.82));
    b.deck.box(0.9, 0.08, 4.4, '#c4a070', st, { box: 0.5 });
    // flagpoles on the roof: the chequered flag and the island's
    for (const [sx, a, c] of [
      [-1, '#ffffff', '#1d1d22'],
      [1, '#2ec4b6', '#ffd23f'],
    ] as const) {
      b.metal.add(post(0.03, 0.025, 3, 6), WHITE, at(m, sx * 1.4, 5.55, 1.4));
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) b.fabric.box(0.02, 0.2, 0.25, (i + j) % 2 ? a : c, at(m, sx * 1.4, 8.2 - j * 0.2, 1.53 + i * 0.25));
    }
    // a loudhailer horn under the eaves, aimed at the course
    b.metal.add(new THREE.CylinderGeometry(0.22, 0.06, 0.45, 10).rotateX(Math.PI / 2), '#c9ccd2', at(m, -1.2, 5.25, 2.0));
    this.lights.addHalo(new THREE.Vector3(x, 4.6, z + 1.8), '#cfe8ff', 1.4);
  }

  private lantern(b: Batches, x: number, z: number, h: number) {
    const m = place(x, 0, z);
    b.metal.add(post(0.07, 0.05, h, 8), '#3a3328', m);
    b.lit.add(post(0.12, 0.1, 0.36, 6), '#ffe1a8', at(m, 0, h, 0));
    b.metal.add(new THREE.ConeGeometry(0.19, 0.17, 6).translate(0, 0.085, 0), '#3a3328', at(m, 0, h + 0.36, 0));
    this.lights.addHalo(new THREE.Vector3(x, h + 0.18, z), '#ffcf8a', 1.4);
    this.lights.addPool(x, 0.05, z, 5, '#ffbf7a');
  }

  /** The hut's and the tower's boards (their own small textures, lit at night). */
  private signs() {
    const hutTex = signTexture('JET-SKI RACE', { sub: '3 laps · 4 rivals · 1 ticket', border: '#2f7fd8', width: 1024, height: 320 });
    const towerTex = signTexture('RACE CONTROL', { sub: 'Palm Cay Lagoon', border: '#2ec4b6', bulbs: false, width: 1024, height: 256 });
    const add = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, yaw: number) => {
      const mm = new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.25, roughness: 0.6 });
      this.signMats.push(mm);
      const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mm);
      s.castShadow = this.ctx.quality.shadows;
      s.position.set(x, y, z);
      s.rotation.y = yaw;
      this.group.add(s);
      return mm;
    };
    // the hut's board above its awning, facing the ring (west); the tower's facing the course (south)
    add(hutTex, 3.6, 1.12, DOCK.x + 4.05, 3.45, DOCK.z0 + 12.5, -Math.PI / 2);
    add(towerTex, 3.2, 0.8, HEAD.x0 + 3.2, 5.95, HEAD.z0 + 6.2, 0);
    // a big board for the beach on the hut's back, facing the boardwalk (north)
    const beach = signTexture('JET-SKI RACE', { sub: 'Race the lagoon · this way ↓', border: '#ff4d6d', width: 1024, height: 320 });
    add(beach, 3.4, 1.06, DOCK.x + 6.2, 2.0, DOCK.z0 + 10.85, Math.PI);
  }

  private colliders() {
    const ctx = this.ctx;
    // the hut and the tower; the jetty's rails, so the visitor walks out along it and not off it
    staticBox(ctx, DOCK.x + 6.2, 1.3, DOCK.z0 + 12.5, 2.1, 1.3, 1.7, 0);
    staticBox(ctx, HEAD.x0 + 3.2, 1.6, HEAD.z0 + 4.4, 1.8, 1.6, 1.8, 0);
    const beachEnd = DOCK.z0 + 24;
    const len = HEAD.z0 - beachEnd;
    for (const sx of [-1, 1])
      for (let k = 0; k < 2; k++) {
        const z0 = beachEnd + (len * k) / 2;
        staticBox(ctx, DOCK.x + sx * (DOCK.half + 0.1), 0.8, z0 + len / 4, 0.1, 0.8, len / 4, 0);
      }
    const w = (HEAD.x1 - HEAD.x0) / 2;
    staticBox(ctx, (HEAD.x0 + HEAD.x1) / 2, 0.8, HEAD.z1 + 0.1, w, 0.8, 0.1, 0);
    for (const x of [HEAD.x0 - 0.1, HEAD.x1 + 0.1]) staticBox(ctx, x, 0.8, (HEAD.z0 + HEAD.z1) / 2, 0.1, 0.8, (HEAD.z1 - HEAD.z0) / 2, 0);
    for (const sx of [-1, 1]) {
      const x0 = sx < 0 ? HEAD.x0 : DOCK.x + DOCK.half;
      const x1 = sx < 0 ? DOCK.x - DOCK.half : HEAD.x1;
      staticBox(ctx, (x0 + x1) / 2, 0.8, HEAD.z0 - 0.1, (x1 - x0) / 2, 0.8, 0.1, 0);
    }
  }

  setNight(k: number) {
    this.lights.setNight(k);
    for (const m of this.signMats) m.emissiveIntensity = 0.2 + 1.3 * k;
  }

  update(t: number) {
    this.lights.update(t);
  }
}
