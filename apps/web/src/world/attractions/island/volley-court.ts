// Beach Volley's court and everything round it: the raked sand pit with its blue boundary tapes,
// the net between padded posts (it bellies when a ball hits it), the umpire's stand, the little
// aluminium bleachers under shade sails, corner flags, catch nets behind both ends, floodlights,
// a ball cart, the scoreboard, and the coconut shy beyond the far end where five coconuts sit in
// cups on posts of three heights. A sandy boardwalk leads in from the end of the island's path.
//
// The court has its own frame (see volley-ball.ts): the origin is the middle of the net on the
// sand, +z runs east to the far court (the end the visitor serves at), +x north (towards the
// bleachers). `frame` maps it into the world: the court stands at ISLAND_SPOTS.volley, turned a
// quarter turn so its length runs east–west, with the beach and the sea to the south. Static
// parts are merged into the island's shared materials, one draw call per material.

import * as THREE from 'three';
import { staticBox, staticCylinder, type Ctx } from '../../context';
import { ISLAND_SPOTS } from '../../geo';
import { mulberry } from '../../random';
import { canvasTex } from '../../textures';
import { Palms, type PalmSpot } from '../../island/flora';
import { Batch, islandMaterials, litLevel, place, post, roundRect, type IslandMaterials } from '../../island/kit';
import { NightLights } from '../../island/lights';
import { BALL_R, HALF_L, HALF_W, NET_DEPTH, NET_TOP, SAND_Y, type Sphere } from './volley-ball';

/** The court's centre in the world, and its frame: local (x, y, z) → world (ox + z, y, oz − x). */
export const COURT_ORIGIN = new THREE.Vector3(ISLAND_SPOTS.volley.x, 0, ISLAND_SPOTS.volley.z);
export const COURT_YAW = Math.PI / 2;
const FRAME = new THREE.Matrix4().compose(COURT_ORIGIN, new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, COURT_YAW), new THREE.Vector3(1, 1, 1));

/** A world matrix for a part placed at (x, y, z) in the court's frame, turned `yaw` about y there. */
function L(x: number, y: number, z: number, yaw = 0, s = 1) {
  return FRAME.clone().multiply(place(x, y, z, yaw, s));
}

/** World coordinates of a point in the court's frame. */
export function toWorld(x: number, y: number, z: number, out = new THREE.Vector3()) {
  return out.set(COURT_ORIGIN.x + z, y, COURT_ORIGIN.z - x);
}

/** The court's frame of a world point. */
export function toLocal(p: THREE.Vector3Like, out = new THREE.Vector3()) {
  return out.set(COURT_ORIGIN.z - p.z, p.y, p.x - COURT_ORIGIN.x);
}

/** The sand pit's half-sizes (the court plus a free zone all round). */
export const PIT_X = 8.1;
export const PIT_Z = 11.8;
/** The net posts stand this far out from the middle (a metre outside the sidelines). */
const POST_X = 5;
/** The coconut shy: its posts' line and its back board (balls stop against it). */
export const SHY_Z = 13.05;
export const SHY_BACK_Z = 13.7;
const SHY_HALF = 4.4;
/** The catch nets behind both ends (a ball stops against them). */
export const CATCH_Z = 14.7;
const CATCH_HALF = 9.5;
const CATCH_H = 4.2;
/** Where the coconuts sit (on their cups), and how close a ball must pass to knock one off. */
export const COCONUTS: readonly { x: number; y: number }[] = [
  { x: -3, y: 1.86 },
  { x: -1.5, y: 2.16 },
  { x: 0, y: 2.46 },
  { x: 1.5, y: 2.16 },
  { x: 3, y: 1.86 },
];
export const COCONUT_R = 0.12;
const COCONUT_HIT_R = 0.17;
/** The bleachers: their front edge, rows and length (north of the court). */
export const BLEACHER = { x0: 9.4, rows: 4, step: 0.62, rise: 0.38, half: 6 };
/** The umpire stands on a platform beside the north post. */
export const UMPIRE = { x: 5.95, y: 1.55, z: 0 };

const SAND = '#e9d3a2';
const TAPE = '#2a5fc4';
const TIMBER = '#8a6440';
const WHITE = '#f1f2ef';
const ALU = '#c9ced3';

/** A coconut knocked off its cup: where it is and how it tumbles. */
interface Nut {
  home: THREE.Vector3;
  p: THREE.Vector3;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  down: boolean;
  /** Seconds since it fell (it settles on the sand after a while). */
  t: number;
}

export class Court {
  /** The court's frame: dynamic things (players, the ball, the rings) are its children, in court metres. */
  readonly frame = new THREE.Group();
  /** Static scenery in world space (merged meshes, stored relative to COURT_ORIGIN). */
  readonly group = new THREE.Group();
  private mats: IslandMaterials;
  private sandMat: THREE.MeshStandardMaterial;
  private signMat: THREE.MeshStandardMaterial;
  private net: THREE.Mesh;
  private netRest: Float32Array;
  private netShake = 0;
  private netHit = new THREE.Vector2();
  private lights: NightLights;
  private palms: Palms;
  private flags: THREE.Mesh;
  private nutMesh!: THREE.InstancedMesh;
  private nuts: Nut[] = [];
  /** The coconuts as hit spheres for the ball (null once knocked off). */
  readonly targets: (Sphere | null)[] = [];
  private board: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; key: string };
  private night = -1;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s1 = new THREE.Vector3(1, 1, 1);

  constructor(private ctx: Ctx) {
    const q = ctx.quality;
    const lean = q.tier === 'low' || q.tier === 'lowest';
    this.mats = islandMaterials(ctx.renderer);
    this.frame.position.copy(COURT_ORIGIN);
    this.frame.rotation.y = COURT_YAW;
    this.frame.updateMatrixWorld();

    const b = {
      paint: new Batch(COURT_ORIGIN),
      fabric: new Batch(COURT_ORIGIN),
      timber: new Batch(COURT_ORIGIN),
      deck: new Batch(COURT_ORIGIN),
      metal: new Batch(COURT_ORIGIN),
      signs: new Batch(COURT_ORIGIN),
    };
    this.lights = new NightLights(COURT_ORIGIN, lean);
    const signs = this.signAtlas();
    this.signMat = new THREE.MeshStandardMaterial({ map: signs.tex, emissive: '#ffffff', emissiveMap: signs.tex, emissiveIntensity: 0.05, roughness: 0.6 });

    this.sandMat = this.buildSand();
    this.frame.add(this.apron());
    this.border(b);
    this.boardwalk(b);
    this.netHardware(b);
    this.umpireStand(b);
    this.bleachers(b);
    this.shy(b, signs.cells);
    this.catchNets(b);
    this.floodlights(b);
    this.extras(b, signs.cells);
    this.flags = this.cornerFlags();
    this.frame.add(this.flags);

    // the merged scenery: lean tiers fold the finishes into fewer materials
    if (lean) {
      b.timber.absorb(b.deck);
      b.fabric.absorb(b.paint);
      b.fabric.absorb(b.metal);
    }
    const parts: [Batch, THREE.Material, boolean][] = [
      [b.deck, this.mats.deck, false],
      [b.paint, this.mats.paint, true],
      [b.fabric, this.mats.fabric, true],
      [b.timber, this.mats.timber, true],
      [b.metal, this.mats.metal, true],
      [b.signs, this.signMat, true],
    ];
    for (const [batch, mat, cast] of parts) {
      const mesh = batch.build(mat, q.shadows && cast, q.shadows);
      if (mesh) this.group.add(mesh);
    }
    this.lights.build();
    this.group.add(this.lights.group);

    const net = this.buildNet();
    this.net = net.mesh;
    this.netRest = net.rest;
    this.frame.add(this.net);
    this.frame.add(this.catchNetMesh());

    this.buildCoconuts();
    this.frame.add(this.nutMesh);

    this.board = this.buildScoreboard();

    const palms: PalmSpot[] = [
      { ...xz(-12.2, -16.5), s: 1.05, yaw: 2.4 },
      { ...xz(13.6, -17.5), s: 0.95, yaw: 0.6 },
      { ...xz(-12.6, 17.2), s: 1.1, yaw: 3.6 },
      { ...xz(12.8, 18.2), s: 1, yaw: 5.2 },
      { ...xz(14.4, -8.4), kind: 'young', s: 1.1 },
      { ...xz(14.6, 8.2), kind: 'young', s: 1.15 },
    ];
    this.palms = new Palms(palms, { origin: COURT_ORIGIN, tier: q.tier, shadows: q.shadows, renderer: ctx.renderer, seed: 77 });
    this.group.add(this.palms.group);
    for (const t of this.palms.trunks) staticCylinder(ctx, t.x, t.z, t.r + 0.05, 3);

    this.colliders();
    this.setNight(0);
  }

  // ---------------------------------------------------------------------------------------------
  // The sand

  /** The raked pit: a slightly lumpy sheet with the court painted into its texture. */
  private buildSand() {
    const w = PIT_X * 2;
    const d = PIT_Z * 2;
    const g = new THREE.PlaneGeometry(w, d, 48, 70).rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const rnd = mulberry(91);
    const bumps = Array.from({ length: 26 }, () => ({ x: (rnd() - 0.5) * w, z: (rnd() - 0.5) * d, r: 0.6 + rnd() * 1.6, h: (rnd() - 0.4) * 0.05 }));
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      let y = SAND_Y + Math.sin(x * 2.3 + z * 0.7) * 0.006 + Math.sin(z * 3.1 - x * 1.3) * 0.005;
      for (const bp of bumps) y += bp.h * Math.exp(-((x - bp.x) ** 2 + (z - bp.z) ** 2) / (bp.r * bp.r));
      // the court itself is raked flat; the free zone is lumpier, and the edge tucks under the sleepers
      const inCourt = Math.abs(x) < HALF_W + 0.4 && Math.abs(z) < HALF_L + 0.4;
      if (inCourt) y = SAND_Y + (y - SAND_Y) * 0.3;
      const edge = Math.min(PIT_X - Math.abs(x), PIT_Z - Math.abs(z));
      if (edge < 0.25) y = THREE.MathUtils.lerp(0.03, y, Math.max(0, edge / 0.25));
      p.setY(i, y);
    }
    g.computeVertexNormals();
    const tex = canvasTex(sandCanvas(), this.ctx.renderer);
    const glow = canvasTex(poolCanvas(), this.ctx.renderer);
    // tinted down a little: the painted pit is lighter than the island's sand under the same sun
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: '#f0e2c4', roughness: 1, emissive: '#ffe2b0', emissiveMap: glow, emissiveIntensity: 0 });
    const sand = new THREE.Mesh(g, mat);
    sand.receiveShadow = true;
    this.frame.add(sand);
    return mat;
  }

  /**
   * Loose sand blown round the pit and down to the beach (the court sits at the top of the south
   * beach): a feathered sheet over the lawn, so the court reads as part of the beach.
   */
  private apron() {
    const x0 = -36;
    const x1 = 17;
    const z0 = -24;
    const z1 = 24;
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0.015, (z0 + z1) / 2);
    const tex = canvasTex(apronCanvas(x0, x1, z0, z1), this.ctx.renderer);
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    return mesh;
  }

  /** Railway-sleeper timbers round the pit. */
  private border(b: Record<string, Batch>) {
    for (const sx of [-1, 1]) b.timber.box(0.22, 0.14, PIT_Z * 2 + 0.44, TIMBER, L(sx * (PIT_X + 0.11), 0.07, 0), { box: 1, grain: 'z' });
    for (const sz of [-1, 1]) b.timber.box(PIT_X * 2, 0.14, 0.22, TIMBER, L(0, 0.07, sz * (PIT_Z + 0.11)), { box: 1, grain: 'x' });
  }

  /** Decking in from the end of the island's boardwalk to the pit's south-west corner (the visitor arrives here). */
  private boardwalk(b: Record<string, Batch>) {
    const pts = [
      { x: 10, z: -50.5 },
      { x: 9.6, z: -24 },
      { x: 7.4, z: -13.2 },
    ];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const c = pts[i];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const yaw = Math.atan2(c.x - a.x, c.z - a.z);
      b.deck.box(3.2, 0.07, len + 1.2, '#d6b48a', L((a.x + c.x) / 2, 0.035, (a.z + c.z) / 2, yaw), { box: 0.5, grain: 'x' });
      for (const s of [-1, 1]) {
        const ox = Math.cos(yaw) * s * 1.66;
        const oz = -Math.sin(yaw) * s * 1.66;
        b.timber.box(0.12, 0.14, len + 1.2, TIMBER, L((a.x + c.x) / 2 + ox, 0.05, (a.z + c.z) / 2 + oz, yaw), { box: 1 });
      }
    }
    // a landing in front of the pit
    b.deck.box(5, 0.07, 2.4, '#d6b48a', L(6.2, 0.035, -13.2), { box: 0.5, grain: 'x' });
  }

  // ---------------------------------------------------------------------------------------------
  // The net

  private netHardware(b: Record<string, Batch>) {
    for (const sx of [-1, 1]) {
      const x = sx * POST_X;
      b.metal.add(post(0.065, 0.06, 2.95, 12), WHITE, L(x, 0, 0));
      b.metal.add(new THREE.SphereGeometry(0.075, 10, 6), WHITE, L(x, 2.95, 0));
      // the padding round each post, in the tournament's blue with a white band
      b.fabric.add(post(0.17, 0.17, 1.55, 14), TAPE, L(x, 0.12, 0));
      b.fabric.add(post(0.172, 0.172, 0.22, 14), WHITE, L(x, 1.67, 0));
      // the head and foot cables from the net's corners to the posts, and the guy rope out to its anchor
      for (const y of [NET_TOP - 0.03, NET_TOP - NET_DEPTH + 0.02]) bar(b.paint, '#20242a', 0.012, x * 0.86, y, 0, x, y + 0.02, 0);
      bar(b.paint, '#d8cfb8', 0.016, x, 2.9, 0, sx * 7.6, 0.08, 0);
      b.timber.box(0.16, 0.16, 0.16, TIMBER, L(sx * 7.6, 0.06, 0));
    }
    // the antennas over the sidelines: red and white bands, 80 cm above the tape
    for (const sx of [-1, 1])
      for (let i = 0; i < 18; i++) b.paint.add(post(0.011, 0.011, 0.1, 6), i % 2 ? WHITE : '#d8262e', L(sx * (HALF_W + 0.05), NET_TOP - NET_DEPTH + i * 0.1, 0));
  }

  /** The net itself: a double-sided mesh with tapes, its vertices kept to belly when hit. */
  private buildNet() {
    const w = HALF_W * 2 + 0.6;
    const g = new THREE.PlaneGeometry(w, NET_DEPTH, 30, 5);
    g.translate(0, NET_TOP - NET_DEPTH / 2, 0);
    const rest = new Float32Array(g.attributes.position.array);
    const tex = canvasTex(netCanvas(), this.ctx.renderer);
    tex.wrapS = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = this.ctx.quality.shadows;
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.45 });
    return { mesh, rest };
  }

  /** A ball has hit the net at (x, y): it bellies out and shivers. */
  shakeNet(x: number, y: number, k = 1) {
    this.netHit.set(x, y);
    this.netShake = Math.min(1.4, this.netShake + k);
  }

  private updateNet(dt: number, t: number) {
    if (this.netShake <= 0) return;
    this.netShake = Math.max(0, this.netShake - dt * 1.1);
    const p = this.net.geometry.attributes.position as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    const k = this.netShake;
    for (let i = 0; i < p.count; i++) {
      const x = this.netRest[i * 3];
      const y = this.netRest[i * 3 + 1];
      // pinned along the top and bottom cables and at the sides
      const pin = Math.sin(((y - (NET_TOP - NET_DEPTH)) / NET_DEPTH) * Math.PI) * Math.max(0, 1 - Math.abs(x) / (HALF_W + 0.3));
      const near = Math.exp(-((x - this.netHit.x) ** 2) / 1.6);
      a[i * 3 + 2] = pin * near * k * 0.32 * Math.cos(t * 17 + x * 0.8) * Math.min(1, k * 1.5);
    }
    p.needsUpdate = true;
    if (this.netShake === 0) {
      for (let i = 0; i < p.count; i++) a[i * 3 + 2] = 0;
      p.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Round the court

  /** The umpire's stand: a white platform on four legs, with a ladder and a rail. */
  private umpireStand(b: Record<string, Batch>) {
    const { x, y, z } = UMPIRE;
    for (const [dx, dz] of [
      [-0.35, -0.35],
      [0.35, -0.35],
      [-0.35, 0.35],
      [0.35, 0.35],
    ])
      b.metal.add(post(0.03, 0.03, y, 6), WHITE, L(x + dx, 0, z + dz));
    b.timber.box(0.86, 0.06, 0.86, '#b88a5a', L(x, y - 0.03, z), { box: 1 });
    // the rail round three sides (the ladder comes up the fourth, on the far side from the court)
    for (const dz of [-0.4, 0.4]) bar(b.metal, WHITE, 0.03, x - 0.4, y + 0.95, z + dz, x + 0.4, y + 0.95, z + dz);
    bar(b.metal, WHITE, 0.03, x - 0.4, y + 0.95, z - 0.4, x - 0.4, y + 0.95, z + 0.4);
    for (const [dx, dz] of [
      [-0.4, -0.4],
      [-0.4, 0.4],
      [0.4, -0.4],
      [0.4, 0.4],
    ])
      b.metal.add(post(0.02, 0.02, 0.95, 6), WHITE, L(x + dx, y, z + dz));
    // a canvas skirt round the rail, in the tournament's colours
    b.fabric.box(0.02, 0.45, 0.8, TAPE, L(x - 0.41, y + 0.6, z));
    for (let i = 0; i < 6; i++) b.metal.box(0.5, 0.03, 0.05, WHITE, L(x + 0.75, 0.25 + i * 0.26, z));
    for (const dz of [-0.26, 0.26]) bar(b.metal, WHITE, 0.03, x + 0.75, 0, z + dz, x + 0.45, y + 0.1, z + dz);
  }

  /** Two small aluminium bleachers on the north side, under shade sails. */
  private bleachers(b: Record<string, Batch>) {
    const { x0, rows, step, rise, half } = BLEACHER;
    for (const z0 of [-half, 0.4]) {
      const z1 = z0 + half - 0.4;
      const zc = (z0 + z1) / 2;
      const len = z1 - z0;
      for (let i = 0; i < rows; i++) {
        const x = x0 + i * step;
        const y = 0.42 + i * rise;
        // the seat plank and the footboard in front of it
        b.metal.box(0.3, 0.05, len, ALU, L(x + 0.38, y, zc), { box: 1, grain: 'z' });
        b.metal.box(0.28, 0.04, len, '#9ea5ac', L(x + 0.05, y - rise + 0.05, zc), { box: 1, grain: 'z' });
      }
      // frames every couple of metres: a sloping stringer on legs
      for (let fz = z0; fz <= z1 + 0.01; fz += len / 3) {
        bar(b.metal, '#8f979e', 0.06, x0, 0.05, fz, x0 + rows * step, 0.42 + (rows - 1) * rise, fz);
        for (let i = 0; i < rows; i++) b.metal.add(post(0.025, 0.025, 0.42 + i * rise, 6), '#8f979e', L(x0 + i * step + 0.38, 0, fz));
      }
      // the back rail
      const bx = x0 + rows * step + 0.1;
      const by = 0.42 + (rows - 1) * rise;
      for (const fz of [z0, z1]) b.metal.add(post(0.03, 0.03, by + 1, 6), '#8f979e', L(bx, 0, fz));
      bar(b.metal, '#8f979e', 0.04, bx, by + 1, z0, bx, by + 1, z1);
      bar(b.metal, '#8f979e', 0.03, bx, by + 0.55, z0, bx, by + 0.55, z1);
      // the shade sail: a sagging triangle pair on four poles, high at the back
      const poles = [
        [x0 - 0.5, z0 - 0.3, 3.1],
        [x0 - 0.5, z1 + 0.3, 3.1],
        [bx + 0.6, z0 - 0.3, 4.3],
        [bx + 0.6, z1 + 0.3, 4.3],
      ];
      for (const [px, pz, h] of poles) b.metal.add(post(0.05, 0.045, h + 0.2, 8), '#e9ecef', L(px, 0, pz));
      b.fabric.add(sail(poles.map(([px, pz, h]) => new THREE.Vector3(px, h, pz))), z0 < 0 ? '#f3ead6' : '#3fb3b0', FRAME);
    }
    // a sponsor's banner along the front of the bleachers' footboards (painted, so it costs nothing)
  }

  /** The coconut shy beyond the far end: a striped stall, five posts with cups, a painted back board. */
  private shy(b: Record<string, Batch>, cells: Cells) {
    const z = SHY_Z;
    for (const sx of [-1, 1])
      for (const pz of [z - 0.5, SHY_BACK_Z])
        b.timber.add(post(0.08, 0.07, 3.3, 8), '#7a5634', L(sx * SHY_HALF, 0, pz), { box: 1, grain: 'y' });
    // the back board (balls that miss thump into it), with the stall's sign painted on
    b.signs.add(cellPlane(SHY_HALF * 2, 2.6, cells.shy), '#ffffff', L(0, 0.32 + 1.3, SHY_BACK_Z - 0.05, Math.PI));
    b.timber.box(SHY_HALF * 2 + 0.2, 2.7, 0.08, '#6e4c2e', L(0, 0.3 + 1.3, SHY_BACK_Z + 0.02), { box: 1 });
    // the striped canopy, sloping down to the front
    const stripes = 8;
    for (let i = 0; i < stripes; i++) {
      const x = -SHY_HALF - 0.1 + ((i + 0.5) * (SHY_HALF * 2 + 0.2)) / stripes;
      const m = L(x, 3.25, z + 0.1);
      m.multiply(new THREE.Matrix4().makeRotationX(0.22));
      b.fabric.box((SHY_HALF * 2 + 0.2) / stripes, 0.04, 1.9, i % 2 ? '#f6f1e6' : '#d8342f', m);
    }
    // the valance, scalloped by alternating drops
    for (let i = 0; i < 16; i++) {
      const x = -SHY_HALF + ((i + 0.5) * SHY_HALF * 2) / 16;
      b.fabric.box((SHY_HALF * 2) / 16, i % 2 ? 0.28 : 0.36, 0.02, i % 2 ? '#f6f1e6' : '#d8342f', L(x, 3.0, z - 0.85));
    }
    // the posts and their cups
    for (const c of COCONUTS) {
      b.timber.add(post(0.05, 0.04, c.y - 0.12, 8), '#9a7450', L(c.x, 0, z), { box: 2, grain: 'y' });
      b.metal.add(new THREE.CylinderGeometry(0.1, 0.06, 0.08, 12, 1, true), '#c9a24a', L(c.x, c.y - 0.12, z));
      b.metal.add(post(0.06, 0.06, 0.01, 12), '#c9a24a', L(c.x, c.y - 0.16, z));
    }
    // a little counter at each side with a basket of spare coconuts
    for (const sx of [-1, 1]) {
      b.timber.box(1, 0.9, 0.6, '#b0814f', L(sx * (SHY_HALF + 0.9), 0.45, z + 0.1), { box: 1 });
      for (let i = 0; i < 5; i++)
        b.paint.add(new THREE.IcosahedronGeometry(COCONUT_R, 1), '#6a4a2c', L(sx * (SHY_HALF + 0.9) + ((i % 3) - 1) * 0.2, 1.0 + Math.floor(i / 3) * 0.12, z + 0.1 + ((i % 2) - 0.5) * 0.18));
    }
  }

  /** Posts for the catch nets behind both ends (the nets are one see-through mesh). */
  private catchNets(b: Record<string, Batch>) {
    for (const sz of [-1, 1])
      for (let x = -CATCH_HALF; x <= CATCH_HALF + 0.01; x += CATCH_HALF / 3) b.metal.add(post(0.045, 0.04, CATCH_H + 0.15, 8), '#30473a', L(x, 0, sz * CATCH_Z));
  }

  private catchNetMesh() {
    const tex = canvasTex(netCanvas(true), this.ctx.renderer);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set((CATCH_HALF * 2) / 1.6, CATCH_H / 1.6);
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, roughness: 0.9 });
    const geos: THREE.BufferGeometry[] = [];
    for (const sz of [-1, 1]) geos.push(new THREE.PlaneGeometry(CATCH_HALF * 2, CATCH_H).translate(0, CATCH_H / 2 + 0.1, sz * CATCH_Z));
    const g = mergeTwo(geos);
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 1;
    return mesh;
  }

  /** Four floodlight masts at the pit's corners, aimed at the court. */
  private floodlights(b: Record<string, Batch>) {
    const v = new THREE.Vector3();
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = sx * (PIT_X + 1.1);
        const z = sz * (PIT_Z + 0.8);
        b.metal.add(post(0.1, 0.07, 7.6, 10), '#9aa3aa', L(x, 0, z));
        // the head: a cross-bar with two lamp boxes facing the court's middle
        const yaw = Math.atan2(-x, -z);
        b.metal.box(1.6, 0.08, 0.08, '#6c757d', L(x, 7.5, z, yaw + Math.PI / 2));
        for (const s of [-0.5, 0.5]) {
          const lx = x + Math.cos(yaw) * s;
          const lz = z - Math.sin(yaw) * s;
          const m = L(lx, 7.45, lz, yaw);
          m.multiply(new THREE.Matrix4().makeRotationX(0.55));
          b.metal.box(0.55, 0.42, 0.22, '#3d444b', m);
          const face = L(lx, 7.45, lz, yaw);
          face.multiply(new THREE.Matrix4().makeRotationX(0.55)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.115));
          this.lights.addBulb(v.setFromMatrixPosition(face), '#fff4dc', 7);
          this.lights.addHalo(v, '#fff1d6', 1.6);
        }
      }
    // festoons along the front of the bleachers' sails
    for (const z0 of [-BLEACHER.half, 0.4]) {
      const z1 = z0 + BLEACHER.half - 0.4;
      this.lights.addString(toWorld(BLEACHER.x0 - 0.5, 2.95, z0 - 0.3), toWorld(BLEACHER.x0 - 0.5, 2.95, z1 + 0.3), { sag: 0.35, spacing: 0.75 });
    }
  }

  /** The welcome sign, the team benches, the ball cart, the scoreboard's posts and a cool box. */
  private extras(b: Record<string, Batch>, cells: Cells) {
    // the sign at the end of the boardwalk, facing the visitor walking in
    for (const sz of [-1.6, 1.6]) b.timber.add(post(0.07, 0.06, 3, 8), '#7a5634', L(9.6 + sz * 0.05, 0, -16 + sz), { box: 1, grain: 'y' });
    b.signs.add(cellPlane(3.6, 1.15, cells.welcome), '#ffffff', L(9.62, 2.25, -16, -Math.PI / 2));
    b.signs.add(cellPlane(3.6, 1.15, cells.welcome), '#ffffff', L(9.58, 2.25, -16, Math.PI / 2));
    // team benches out by the ends on the beach side; the far one under a parasol (one at the near
    // end would stand right between the beach and the play)
    for (const sz of [-1, 1]) {
      const z = sz * 9.9;
      for (let i = 0; i < 3; i++) b.timber.box(0.12, 0.04, 2.4, '#b07a4a', L(-9.25 - i * 0.13, 0.45, z), { box: 1, grain: 'z' });
      for (const dz of [-1, 1]) b.metal.box(0.45, 0.45, 0.05, '#2f3b33', L(-9.38, 0.22, z + dz * 1.05));
      if (sz > 0) {
        b.paint.add(post(0.03, 0.03, 2.4, 6), WHITE, L(-10.2, 0, z));
        b.fabric.add(new THREE.ConeGeometry(1.5, 0.45, 12, 1, true).translate(0, 2.55, 0), '#2ec4b6', L(-10.2, 0, z));
      } else b.fabric.box(0.5, 0.015, 0.9, '#ff8a3d', L(-9.38, 0.475, z - 0.5));
      // a cool box of drinks and a towel
      b.paint.box(0.5, 0.4, 0.35, sz < 0 ? '#2a6fd6' : '#e8402e', L(-9.4, 0.2, z + 1.5));
      b.paint.box(0.52, 0.06, 0.37, WHITE, L(-9.4, 0.43, z + 1.5));
    }
    // the ball cart behind the near baseline: a wire basket of spare balls
    const cx = -6.4;
    const cz = -12.9;
    for (const [dx, dz] of [
      [-0.3, -0.3],
      [0.3, -0.3],
      [-0.3, 0.3],
      [0.3, 0.3],
    ])
      b.metal.add(post(0.012, 0.012, 0.9, 5), '#3a3f45', L(cx + dx, 0, cz + dz));
    b.metal.box(0.66, 0.02, 0.66, '#3a3f45', L(cx, 0.55, cz));
    const ballGeo = new THREE.IcosahedronGeometry(BALL_R, 2);
    for (let i = 0; i < 7; i++) b.paint.add(ballGeo, i % 3 === 0 ? '#2a5fc4' : i % 3 === 1 ? '#ffd23d' : WHITE, L(cx + ((i % 3) - 1) * 0.21, 0.67 + Math.floor(i / 3) * 0.17, cz + ((i % 2) - 0.5) * 0.2));
    // the scoreboard's legs (the board itself is a live canvas)
    const sb = SCOREBOARD;
    for (const s of [-0.95, 0.95]) b.metal.add(post(0.05, 0.05, sb.y + 0.75, 8), '#4a535b', L(sb.x + Math.cos(sb.yaw) * s, 0, sb.z - Math.sin(sb.yaw) * s));
    b.metal.box(2.6, 1.6, 0.12, '#262b31', L(sb.x, sb.y, sb.z, sb.yaw).multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.07)));
  }

  /** Pennants on poles round the pit: the four corners and the south end of the net line. */
  private cornerFlags() {
    const geos: THREE.BufferGeometry[] = [];
    const cols: number[] = [];
    const c = new THREE.Color();
    const push = (geo: THREE.BufferGeometry, color: string) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      c.set(color);
      for (let i = 0; i < g.attributes.position.count; i++) cols.push(c.r, c.g, c.b);
      geos.push(g);
    };
    const spots: [number, number, number][] = [
      [-PIT_X + 0.2, -PIT_Z + 0.2, 1],
      [PIT_X - 0.2, -PIT_Z + 0.2, 1],
      [-PIT_X + 0.2, PIT_Z - 0.2, -1],
      [PIT_X - 0.2, PIT_Z - 0.2, -1],
      [-PIT_X + 0.2, 0, 1],
    ];
    spots.forEach(([x, z, dir], i) => {
      push(post(0.02, 0.018, 1.7, 5).translate(x, 0, z), WHITE);
      const flag = new THREE.BufferGeometry();
      flag.setAttribute('position', new THREE.Float32BufferAttribute([x, 1.68, z, x, 1.3, z, x, 1.5, z + 0.55 * dir], 3));
      push(flag, i % 2 ? '#2ec4b6' : '#ff8a3d');
    });
    const g = mergeTwo(geos, true);
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
    mesh.castShadow = this.ctx.quality.shadows;
    return mesh;
  }

  private colliders() {
    const ctx = this.ctx;
    const w = new THREE.Vector3();
    const box = (x: number, z: number, hx: number, hz: number, h: number) => {
      toWorld(x, 0, z, w);
      // (the court's x runs along the world's −z: swap the half-sizes)
      staticBox(ctx, w.x, h / 2, w.z, hz, h / 2, hx);
    };
    for (const sx of [-1, 1]) {
      toWorld(sx * POST_X, 0, 0, w);
      staticCylinder(ctx, w.x, w.z, 0.18, 2.95);
    }
    box(UMPIRE.x, UMPIRE.z, 0.45, 0.45, 2.6);
    const { x0, rows, step, half } = BLEACHER;
    box(x0 + (rows * step) / 2 + 0.1, 0, (rows * step) / 2 + 0.2, half + 0.1, 1.9);
    box(0, SHY_BACK_Z - 0.2, SHY_HALF + 0.1, 0.45, 3);
    for (const sx of [-1, 1]) box(sx * (SHY_HALF + 0.9), SHY_Z + 0.1, 0.5, 0.3, 1);
    for (const sz of [-1, 1]) box(-9.35, sz * 9.9, 0.3, 1.2, 0.9);
    box(SCOREBOARD.x, SCOREBOARD.z, 1.1, 0.3, 1.5);
  }

  // ---------------------------------------------------------------------------------------------
  // Coconuts

  private buildCoconuts() {
    const tex = canvasTex(coconutCanvas(), this.ctx.renderer);
    const geo = new THREE.IcosahedronGeometry(COCONUT_R, 2);
    geo.scale(1, 1.12, 1);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }), COCONUTS.length);
    mesh.castShadow = this.ctx.quality.shadows;
    mesh.frustumCulled = false;
    this.nutMesh = mesh;
    for (const c of COCONUTS) {
      const home = new THREE.Vector3(c.x, c.y, SHY_Z);
      this.nuts.push({ home, p: home.clone(), v: new THREE.Vector3(), spin: new THREE.Vector3(), rot: new THREE.Euler(0, Math.random() * 6, 0), down: false, t: 0 });
      this.targets.push({ x: c.x, y: c.y, z: SHY_Z, r: COCONUT_HIT_R });
    }
    this.placeNuts();
  }

  /** How many coconuts are still on their cups. */
  get coconutsUp() {
    return this.nuts.filter((n) => !n.down).length;
  }

  /** Knocks coconut `i` off its cup, sent off along the ball's velocity (vx, vy, vz). */
  knock(i: number, vx: number, vy: number, vz: number) {
    const n = this.nuts[i];
    if (!n || n.down) return;
    n.down = true;
    n.t = 0;
    n.v.set(vx * 0.35, Math.max(1.5, vy * 0.2 + 2), vz * 0.35 + 0.6);
    n.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14);
    this.targets[i] = null;
  }

  /** Every coconut back on its cup. */
  resetCoconuts() {
    this.nuts.forEach((n, i) => {
      n.down = false;
      n.p.copy(n.home);
      n.v.set(0, 0, 0);
      this.targets[i] = { x: n.home.x, y: n.home.y, z: n.home.z, r: COCONUT_HIT_R };
    });
    this.placeNuts();
  }

  private updateNuts(dt: number) {
    let moving = false;
    for (const n of this.nuts) {
      if (!n.down || n.t > 4) continue;
      moving = true;
      n.t += dt;
      n.v.y -= 9.81 * dt;
      n.p.addScaledVector(n.v, dt);
      // the back board stops it; then the sand
      if (n.p.z > SHY_BACK_Z - 0.15) {
        n.p.z = SHY_BACK_Z - 0.15;
        n.v.z *= -0.3;
      }
      const floor = COCONUT_R * 1.05;
      if (n.p.y < floor) {
        n.p.y = floor;
        if (n.v.y < -1) this.ctx.sfx.thunk(Math.min(4, -n.v.y));
        n.v.y = -n.v.y * 0.28;
        n.v.x *= 0.6;
        n.v.z *= 0.6;
        n.spin.multiplyScalar(0.6);
      }
      n.rot.x += n.spin.x * dt;
      n.rot.y += n.spin.y * dt;
      n.rot.z += n.spin.z * dt;
    }
    if (moving) this.placeNuts();
  }

  private placeNuts() {
    this.nuts.forEach((n, i) => {
      this.q.setFromEuler(n.rot);
      this.nutMesh.setMatrixAt(i, this.m4.compose(n.p, this.q, this.s1));
    });
    this.nutMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------------
  // The scoreboard

  private buildScoreboard() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const tex = canvasTex(canvas, this.ctx.renderer);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.5 });
    const sb = SCOREBOARD;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5), mat);
    mesh.position.set(sb.x, sb.y, sb.z);
    mesh.rotation.y = sb.yaw;
    this.frame.add(mesh);
    const board = { canvas, tex, key: '' };
    this.board = board;
    this.setScoreboard({ title: 'BEACH VOLLEY', home: 0, away: 0, line: 'Palm Cay Open · Serve to win' });
    return board;
  }

  /** Repaints the scoreboard (only when what it says has changed). */
  setScoreboard(s: { title: string; home: number; away: number; line: string }) {
    const key = `${s.title}|${s.home}|${s.away}|${s.line}`;
    if (key === this.board.key) return;
    this.board.key = key;
    const g = this.board.canvas.getContext('2d')!;
    const w = 512;
    const h = 320;
    g.fillStyle = '#10141a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f5fbf';
    g.fillRect(0, 0, w, 64);
    g.fillStyle = '#fff5e3';
    g.font = `40px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.title, w / 2, 34);
    g.font = `700 26px "DM Sans", system-ui, sans-serif`;
    g.fillStyle = '#9fd8ff';
    g.fillText('YOU', w * 0.25, 92);
    g.fillText('LOCALS', w * 0.75, 92);
    g.font = `128px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
    g.fillStyle = '#ffc23d';
    g.fillText(String(s.home), w * 0.25, 178);
    g.fillStyle = '#ff6b5e';
    g.fillText(String(s.away), w * 0.75, 178);
    g.fillStyle = '#39424c';
    g.fillRect(w / 2 - 2, 80, 4, 150);
    g.font = `700 24px "DM Sans", system-ui, sans-serif`;
    g.fillStyle = '#e6edf3';
    g.fillText(s.line, w / 2, 274);
    this.board.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Signs

  private signAtlas() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 512;
    const tex = canvasTex(c, this.ctx.renderer);
    const cells: Cells = { shy: { x: 0, y: 0, w: 1024, h: 300 }, welcome: { x: 0, y: 308, w: 640, h: 204 } };
    const paint = () => {
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, 1024, 512);
      // the shy's back board: red and cream stripes, the name in a cartouche, and the prize
      const s = cells.shy;
      for (let i = 0; i < 16; i++) {
        g.fillStyle = i % 2 ? '#f6efe0' : '#cf3a32';
        g.fillRect(s.x + (i * s.w) / 16, s.y, s.w / 16 + 1, s.h);
      }
      g.fillStyle = '#1d1238';
      roundRect(g, 222, 22, 580, 116, 30);
      g.fill();
      g.fillStyle = '#ffc23d';
      g.font = `86px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('COCONUT SHY', 512, 84);
      g.fillStyle = '#fff5e3';
      roundRect(g, 330, 214, 364, 64, 20);
      g.fill();
      g.fillStyle = '#1d1238';
      g.font = `700 36px "DM Sans", system-ui, sans-serif`;
      g.fillText('+5 a coconut!', 512, 247);
      // the welcome sign
      const w = cells.welcome;
      g.fillStyle = '#1f5fbf';
      roundRect(g, w.x + 4, w.y + 4, w.w - 8, w.h - 8, 30);
      g.fill();
      g.strokeStyle = '#fff5e3';
      g.lineWidth = 8;
      roundRect(g, w.x + 16, w.y + 16, w.w - 32, w.h - 32, 22);
      g.stroke();
      g.fillStyle = '#fff5e3';
      g.font = `78px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
      g.fillText('BEACH VOLLEY', w.x + w.w / 2, w.y + 86);
      g.fillStyle = '#ffc23d';
      g.font = `700 32px "DM Sans", system-ui, sans-serif`;
      g.fillText('Serve · Spike · Coconut Shy', w.x + w.w / 2, w.y + 152);
      tex.needsUpdate = true;
    };
    paint();
    void document.fonts?.ready.then(() => {
      paint();
      const key = this.board?.key;
      if (this.board && key) {
        this.board.key = '';
        const [title, home, away, line] = key.split('|');
        this.setScoreboard({ title, home: Number(home), away: Number(away), line });
      }
    });
    return { tex, cells };
  }

  // ---------------------------------------------------------------------------------------------

  /** 0 by day .. 1 at night: floodlights on, the sand lit in pools, the signs glowing. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 0.002) return;
    this.night = k;
    this.lights.setNight(k);
    this.sandMat.emissiveIntensity = k * 0.42;
    this.signMat.emissiveIntensity = 0.05 + k * 0.5;
    this.mats.lit.color.setScalar(litLevel(k));
  }

  update(dt: number, t: number, camera: THREE.Camera) {
    this.palms.update(camera);
    this.lights.update(t);
    this.updateNet(dt, t);
    this.updateNuts(dt);
  }
}

/** Where the scoreboard stands (court frame) and which way it faces: towards the server and the beach. */
const SCOREBOARD = { x: 10.6, y: 3.0, z: 9.6, yaw: Math.atan2(-0.62, -0.78) };

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Cells = { shy: Cell; welcome: Cell };

/** (x, z) in the world for a point in the court's frame. */
function xz(x: number, z: number) {
  const w = toWorld(x, 0, z);
  return { x: w.x, z: w.z };
}

/** A w × h plane facing +z with its UVs on a cell of the 1024 × 512 sign canvas. */
function cellPlane(w: number, h: number, c: Cell) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (c.x + uv.getX(i) * c.w) / 1024, 1 - (c.y + (1 - uv.getY(i)) * c.h) / 512);
  return g;
}

/** A thin square bar from (x0, y0, z0) to (x1, y1, z1), in the court's frame. */
function bar(b: Batch, color: string, t: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const a = new THREE.Vector3(x0, y0, z0);
  const c = new THREE.Vector3(x1, y1, z1);
  const len = a.distanceTo(c);
  const g = new THREE.BoxGeometry(t, t, len);
  const m = new THREE.Matrix4().lookAt(c, a, THREE.Object3D.DEFAULT_UP);
  if (Math.abs(c.x - a.x) < 1e-4 && Math.abs(c.z - a.z) < 1e-4) m.lookAt(c, a, new THREE.Vector3(1, 0, 0));
  m.setPosition(a.clone().add(c).multiplyScalar(0.5));
  b.add(g, color, FRAME.clone().multiply(m), { box: 1 });
}

/** A shade sail over four corners (front pair first, then the back pair), sagging in the middle. */
function sail(c: THREE.Vector3[]) {
  const n = 6;
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  const a = new THREE.Vector3();
  const bb = new THREE.Vector3();
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const u = i / n;
      const v = j / n;
      a.lerpVectors(c[0], c[1], v);
      bb.lerpVectors(c[2], c[3], v);
      p.lerpVectors(a, bb, u);
      // the cloth droops between the poles, and its edges curve in a little
      p.y -= Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.32;
      pos.push(p.x, p.y, p.z);
    }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const q = i * (n + 1) + j;
      idx.push(q, q + 1, q + n + 1, q + 1, q + n + 2, q + n + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Merges geometries with the same attributes (position, normal, uv), dropping anything else. */
function mergeTwo(geos: THREE.BufferGeometry[], positionsOnly = false) {
  const keys = positionsOnly ? ['position'] : ['position', 'normal', 'uv'];
  const out = new THREE.BufferGeometry();
  for (const k of keys) {
    const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g).getAttribute(k) as THREE.BufferAttribute);
    const size = parts[0].itemSize;
    const arr = new Float32Array(parts.reduce((s, p) => s + p.count * size, 0));
    let o = 0;
    for (const p of parts) {
      arr.set(p.array as Float32Array, o);
      o += p.count * size;
    }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  if (positionsOnly) out.computeVertexNormals();
  return out;
}

// ------------------------------------------------------------------------------------------------
// Painted textures

/** The pit's sand, 16.2 × 23.6 m: grain, raking, scuffs and footprints where play happens, and the court's tapes. */
function sandCanvas() {
  const W = 1024;
  const H = 1536;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const px = (x: number) => ((x + PIT_X) / (PIT_X * 2)) * W;
  const pz = (z: number) => ((z + PIT_Z) / (PIT_Z * 2)) * H;
  const mpx = W / (PIT_X * 2);
  g.fillStyle = SAND;
  g.fillRect(0, 0, W, H);
  const rnd = mulberry(5);
  // broad tonal drifts, so it doesn't read as a flat colour
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 60 + rnd() * 220;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const light = rnd() < 0.5;
    gr.addColorStop(0, light ? 'rgba(255,248,226,0.22)' : 'rgba(176,146,98,0.16)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // raking: faint parallel furrows across the free zone
  g.lineWidth = 1.4;
  for (let i = 0; i < 520; i++) {
    const y = rnd() * H;
    const x = rnd() * W;
    const len = 30 + rnd() * 120;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(150,120,80,0.12)' : 'rgba(255,250,232,0.16)';
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + len / 2, y + (rnd() - 0.5) * 6, x + len, y + (rnd() - 0.5) * 4);
    g.stroke();
  }
  // where the players stand and dive the sand is churned: darker hollows and spray
  const churn = (x: number, z: number, r: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * r;
      const cx = px(x + Math.cos(a) * d);
      const cy = pz(z + Math.sin(a) * d);
      const rr = (0.08 + rnd() * 0.22) * mpx;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
      gr.addColorStop(0, 'rgba(150,118,74,0.32)');
      gr.addColorStop(0.7, 'rgba(170,140,96,0.12)');
      gr.addColorStop(1, 'rgba(255,250,230,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(cx, cy, rr, rr * (0.6 + rnd() * 0.5), a, 0, Math.PI * 2);
      g.fill();
    }
  };
  for (const sz of [-1, 1]) {
    churn(-1.8, sz * 4.5, 3.2, 160);
    churn(1.8, sz * 4.5, 3.2, 160);
    churn(0, sz * 1.4, 2.6, 120);
    churn(0, sz * 9.4, 1.8, 90);
  }
  // footprints: pairs of little ovals heading every which way
  for (let i = 0; i < 260; i++) {
    const x = (rnd() - 0.5) * 11;
    const z = (rnd() - 0.5) * 21;
    const a = rnd() * Math.PI * 2;
    for (const s of [-1, 1]) {
      const fx = px(x + Math.cos(a + Math.PI / 2) * 0.09 * s);
      const fy = pz(z + Math.sin(a + Math.PI / 2) * 0.09 * s);
      g.fillStyle = 'rgba(140,110,70,0.2)';
      g.beginPath();
      g.ellipse(fx, fy, 0.05 * mpx, 0.12 * mpx, a + Math.PI / 2, 0, Math.PI * 2);
      g.fill();
    }
  }
  // grain
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 26;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n * 0.8;
  }
  g.putImageData(img, 0, 0);
  // the boundary tapes, 5 cm wide, with a shadow line on the sand side and the corner anchors
  const tape = (x0: number, z0: number, x1: number, z1: number) => {
    const t = 0.05 * mpx;
    g.fillStyle = 'rgba(90,70,40,0.35)';
    g.fillRect(Math.min(px(x0), px(x1)) - t / 2 + 1.5, Math.min(pz(z0), pz(z1)) - t / 2 + 1.5, Math.abs(px(x1) - px(x0)) + t, Math.abs(pz(z1) - pz(z0)) + t);
    g.fillStyle = TAPE;
    g.fillRect(Math.min(px(x0), px(x1)) - t / 2, Math.min(pz(z0), pz(z1)) - t / 2, Math.abs(px(x1) - px(x0)) + t, Math.abs(pz(z1) - pz(z0)) + t);
  };
  tape(-HALF_W, -HALF_L, HALF_W, -HALF_L);
  tape(-HALF_W, HALF_L, HALF_W, HALF_L);
  tape(-HALF_W, -HALF_L, -HALF_W, HALF_L);
  tape(HALF_W, -HALF_L, HALF_W, HALF_L);
  // sand blown over the tapes here and there
  for (let i = 0; i < 140; i++) {
    const side = Math.floor(rnd() * 4);
    const t = rnd() * 2 - 1;
    const x = side < 2 ? t * HALF_W : (side === 2 ? -1 : 1) * HALF_W;
    const z = side < 2 ? (side === 0 ? -1 : 1) * HALF_L : t * HALF_L;
    g.fillStyle = `rgba(234,216,174,${0.5 + rnd() * 0.4})`;
    g.beginPath();
    g.ellipse(px(x), pz(z), (0.04 + rnd() * 0.1) * mpx, (0.02 + rnd() * 0.04) * mpx, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/**
 * The loose sand round the pit, x0..x1 × z0..z1 in the court's frame: opaque near the pit and
 * along the beach side (−x), thinning in ragged drifts into the lawn.
 */
function apronCanvas(x0: number, x1: number, z0: number, z1: number) {
  const W = 512;
  const H = 464;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const rnd = mulberry(23);
  const base = new THREE.Color(SAND);
  const wave = (a: number, f: number, p: number) => Math.sin(a * f + p);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / W;
      const z = z0 + ((z1 - z0) * (j + 0.5)) / H;
      // distance outside the pit (0 inside), and how near the beach (−x) this is
      const dx = Math.max(0, Math.abs(x) - PIT_X);
      const dz = Math.max(0, Math.abs(z) - PIT_Z);
      const out = Math.hypot(dx, dz);
      const ragged = 3 * wave(z, 0.31, 1) + 2 * wave(x, 0.47, 2) + 1.4 * wave(x + z, 0.9, 0.3) + (rnd() - 0.5) * 1.2;
      const reach = (x < 0 ? 9 + Math.max(0, -x - 8) * 0.9 : 6) + ragged;
      let a = THREE.MathUtils.clamp(1 - (out - reach * 0.55) / (reach * 0.6), 0, 1);
      // the far edges of the sheet always fade out, so no straight border shows
      const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      a *= THREE.MathUtils.clamp(edge / 4, 0, 1);
      const n = 1.03 + (rnd() - 0.5) * 0.05 + 0.03 * wave(x, 0.21, 0.4) * wave(z, 0.17, 1.1);
      const k = (j * W + i) * 4;
      img.data[k] = Math.min(255, base.r * 255 * n);
      img.data[k + 1] = Math.min(255, base.g * 255 * n);
      img.data[k + 2] = Math.min(255, base.b * 255 * n * 0.98);
      img.data[k + 3] = a * a * (3 - 2 * a) * 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** Where the floodlights' pools fall on the sand at night (an emissive map over the pit). */
function poolCanvas() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 384);
  g.globalCompositeOperation = 'lighter';
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = ((sx * 3.2 + PIT_X) / (PIT_X * 2)) * 256;
      const y = ((sz * 5.5 + PIT_Z) / (PIT_Z * 2)) * 384;
      const r = g.createRadialGradient(x, y, 0, x, y, 170);
      r.addColorStop(0, 'rgba(255,255,255,0.75)');
      r.addColorStop(0.55, 'rgba(255,255,255,0.32)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 256, 384);
    }
  return c;
}

/**
 * The net's texture: 10 cm black mesh squares, the white top tape (7 cm) and bottom tape, and
 * the white side bands over the sidelines. `plain` paints only the mesh (the catch nets).
 */
function netCanvas(plain = false) {
  const c = document.createElement('canvas');
  const w = plain ? 128 : 1024;
  const h = plain ? 128 : 120;
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  if (plain) {
    // 12 cm squares of thin dark-green cord (the texture repeats every 1.6 m)
    g.strokeStyle = 'rgba(38,58,48,0.9)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 13; i++) {
      const v = (i * 128) / 13 + 0.6;
      g.beginPath();
      g.moveTo(v, 0);
      g.lineTo(v, 128);
      g.moveTo(0, v);
      g.lineTo(128, v);
      g.stroke();
    }
    return c;
  }
  // 8.6 m wide × 1 m deep: 119 px a metre across, 120 down
  const pxm = w / (HALF_W * 2 + 0.6);
  g.strokeStyle = '#15181c';
  g.lineWidth = 2;
  for (let x = 0; x <= w; x += pxm * 0.1) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  for (let y = 0; y <= h; y += 12) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.fillStyle = '#f7f7f2';
  g.fillRect(0, 0, w, 9);
  g.fillStyle = '#1f5fbf';
  g.fillRect(0, 9, w, 2);
  g.fillStyle = '#f7f7f2';
  g.fillRect(0, h - 6, w, 6);
  for (const sx of [-1, 1]) {
    const x = w / 2 + sx * HALF_W * pxm;
    g.fillRect(x - 3, 0, 6, h);
  }
  // sponsor-free printing on the top tape: the event's name every couple of metres
  g.fillStyle = '#1f5fbf';
  g.font = '700 8px sans-serif';
  g.textBaseline = 'middle';
  for (let x = 40; x < w - 60; x += 220) g.fillText('PALM CAY OPEN', x, 5);
  return c;
}

/** A husked coconut: dark brown with fibres and the three eyes. */
function coconutCanvas() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5b3c22';
  g.fillRect(0, 0, 256, 128);
  const rnd = mulberry(3);
  g.lineWidth = 1.2;
  for (let i = 0; i < 900; i++) {
    const x = rnd() * 256;
    const y = rnd() * 128;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(150,104,60,0.6)' : 'rgba(40,24,12,0.6)';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 6, y + 6 + rnd() * 10);
    g.stroke();
  }
  g.fillStyle = '#2a1a0e';
  for (const [x, y] of [
    [120, 10],
    [136, 10],
    [128, 20],
  ]) {
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}
