// Palm Cay's beach park: from the arrivals plaza outside the terminal, the Palm Promenade runs
// south between double rows of coconut palms, bars and shops, festoon lights and tiki torches to
// the Beach Plaza and its fountain; boardwalks lead from there to the four games (the slide
// tower, the pirate fort, the volleyball court and the jet-ski dock, which their own modules
// build round the anchors in geo.ts), and to the south beach with its parasols, palapas, loungers,
// beach huts, lifeguard towers, kayaks, a pier and the swimming area's buoys. Gardens either side
// (a lily pool and hammock grove to the west, a picnic lawn with a little stage to the east) fill
// the rest of the park.
//
// Everything static is merged into one mesh per material (kit.ts), the palms and shrubs are
// instanced (flora.ts) and the night lights are one draw call per kind (lights.ts); the meshes'
// vertices are stored relative to the park's centre so they keep their precision 41 km from the
// world's origin.

import * as THREE from 'three';
import { staticCylinder, type Ctx } from '../context';
import { ISLAND, ISLAND_SPOTS, SEA_Y, islandShoreDist } from '../geo';
import { mulberry } from '../random';
import { PALETTE } from '../textures';
import { Palms, Shrubs, canMultiDraw, type PalmSpot, type ShrubKind, type ShrubSpot } from './flora';
import { Batches, SignAtlas, at, hipRoof, islandMaterials, litLevel, place, roundRect, signPlane, type V2, type WalkRect } from './kit';
import { NightLights } from './lights';
import {
  bar,
  beachHut,
  bed,
  bench,
  block,
  boardwalk,
  fingerpost,
  fountain,
  kayak,
  lantern,
  lifeguardTower,
  local,
  lounger,
  palapa,
  parasol,
  pavedDisc,
  pavedPath,
  pier,
  sandcastle,
  shower,
  stringPole,
  torch,
  towel,
  type Build,
  type Seat,
} from './props';

const PARK = ISLAND.park;
/** The park's meshes are stored relative to this point (its middle). */
const ORIGIN = { x: 0, y: 0, z: (PARK.z0 + PARK.z1) / 2 };
/** The static batches' culling cells (m), where the GPU can multi-draw (kit.ts, Batch.build). */
const BATCH_CELL = 64;

/** The arrivals plaza in front of the terminal, the promenade south of it, and the Beach Plaza. */
const ARRIVALS = { x0: -70, x1: 70, z0: 40672.5, z1: 40742 };
const PROM = { z0: 40742, z1: 41146, half: 7, strip: 3, side: 3 };
const PLAZA = { ...ISLAND_SPOTS.plaza, r: 38 };
/** The boardwalk along the top of the beach. */
const BEACH_WALK_Z = 41436;
/** The pier's line, and the lily pool and the stage lawn. */
const PIER_X = 330;
const POOL = { x: -300, z: 40930, r: 15 };
const LAWN = { x: 285, z: 40960 };
/** The colour the lamp-lit water glows at night. */
const WATER_GLOW = new THREE.Color('#2a9fb8');

/**
 * Areas the games build in (wave 2): nothing of the park's may stand in them. The cannons'
 * targets sail the sea to the south-west of the fort; the jet-ski dock juts into the lagoon.
 */
const KEEP_CLEAR: WalkRect[] = [
  { x0: -280, x1: -180, z0: 41085, z1: 41215 }, // slides
  { x0: -445, x1: -315, z0: 41335, z1: 41465 }, // cannons
  { x0: 165, x1: 255, z0: 41355, z1: 41432 }, // volley court and its little stands
  { x0: 25, x1: 95, z0: 41438, z1: 41610 }, // jet-ski dock
];

/** Where the dry beach ends (shore distance 22 m, see islandShoreDist) along x: the walkable sand's south edge. */
function dryBeachZ(x: number) {
  let z = 41700;
  while (z > ISLAND.beachZ && islandShoreDist(x, z) < 22) z -= 0.5;
  return z;
}

function inRect(r: WalkRect, x: number, z: number, pad = 0) {
  return x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;
}

/**
 * The beach park's walkable ground (y = 0), worked out from the plan alone so the walk areas can
 * be registered without building anything: the park down to the beach boardwalk, the dry sand in
 * 20 m columns down to where the beach stays dry, and the pier.
 */
export const PALM_CAY_WALK: WalkRect[] = (() => {
  // (from just outside the terminal's landside wall, which the terminal's own walk areas meet)
  const out: WalkRect[] = [{ x0: PARK.x0, x1: PARK.x1, z0: ARRIVALS.z0 - 2, z1: BEACH_WALK_Z + 4 }];
  for (let x = PARK.x0; x < PARK.x1; x += 20) {
    let z1 = Infinity;
    for (let xx = x; xx <= x + 20; xx += 2) z1 = Math.min(z1, dryBeachZ(xx));
    out.push({ x0: x, x1: x + 20, z0: BEACH_WALK_Z, z1 });
  }
  // the pier and its gazebo
  const p = pierLine();
  out.push({ x0: PIER_X - 1.6, x1: PIER_X + 1.6, z0: p.z0, z1: p.z1 + 1 });
  out.push({ x0: PIER_X - 4.3, x1: PIER_X + 4.3, z0: p.z1 + 0.2, z1: p.z1 + 8.8 });
  return out;
})();

/** The pier runs from the top of the wet sand out ~60 m to its gazebo (well short of the lagoon). */
function pierLine() {
  let z0 = 41450;
  while (islandShoreDist(PIER_X, z0) > 26) z0 += 1;
  return { z0, z1: z0 + 62 };
}

export interface PalmCaySpots {
  /** The Beach Plaza (by the fountain). */
  plaza: V2;
  /** Points down the middle of the promenade, north to south. */
  promenade: V2[];
  /** Bench seats (where to stand to sit down, and the way to face). */
  benches: (V2 & { yaw: number })[];
  /** On the sand: towels, loungers and spots near the water's edge. */
  beach: (V2 & { yaw: number })[];
  /** Bar stools along the counters (seat height 0.82 m), facing the bar. */
  bar: (V2 & { yaw: number })[];
  /** Places to stroll between: the plazas, the paths, the gardens and the beach. */
  wander: V2[];
}

export class PalmCay {
  readonly group = new THREE.Group();
  readonly walk: WalkRect[] = PALM_CAY_WALK;
  readonly spots: PalmCaySpots;
  private mats = islandMaterials();
  private signMat: THREE.MeshStandardMaterial;
  private lights: NightLights;
  private palms: Palms;
  private shrubs: Shrubs;
  /** The static batches (their small parts are hidden by distance, see kit.ts). */
  private batches: Batches;
  /** Bobbing buoys (high and medium tiers; the low ones float still, merged into the static paint). */
  private buoys: Buoys | null = null;
  private night = -1;

  constructor(ctx: Ctx) {
    const q = ctx.quality;
    this.mats = islandMaterials(ctx.renderer);
    const atlas = new SignAtlas(ctx.renderer);
    const lean = q.tier === 'low' || q.tier === 'lowest';
    this.lights = new NightLights(ORIGIN, lean);
    const k: Build = { b: new Batches(ORIGIN), lights: this.lights, atlas, ctx, rnd: mulberry(4107), tier: q.tier, colliders: true };
    const palms: PalmSpot[] = [];
    const shrubs: ShrubSpot[] = [];
    const spots: PalmCaySpots = { plaza: { x: PLAZA.x, z: PLAZA.z - 14 }, promenade: [], benches: [], beach: [], bar: [], wander: [] };
    const plan = new Plan(k, palms, shrubs, spots);
    plan.build();

    const buoys = plan.buoyLine();
    if (lean) for (const [i, b] of buoys.entries()) k.b.paint.add(BUOY, BUOY_COLOURS[i % 2], place(b.x, SEA_Y + 0.06, b.z));
    this.signMat = atlas.material(0.08);
    k.b.build(this.group, this.mats, this.signMat, q.shadows, lean, canMultiDraw(ctx.renderer) ? BATCH_CELL : 0);
    this.batches = k.b;
    this.lights.build();
    this.group.add(this.lights.group);
    this.palms = new Palms(palms, { origin: ORIGIN, tier: q.tier, shadows: q.shadows, renderer: ctx.renderer, seed: 31 });
    this.shrubs = new Shrubs(shrubs, { origin: ORIGIN, tier: q.tier, shadows: q.shadows && q.tier === 'high', seed: 32, renderer: ctx.renderer });
    this.group.add(this.palms.group, this.shrubs.group);
    if (!lean) {
      this.buoys = new Buoys(buoys);
      this.group.add(this.buoys.mesh);
    }
    // the palms' trunks are in the way on foot (only those where people walk need a collider)
    for (const t of this.palms.trunks) if (this.walk.some((r) => inRect(r, t.x, t.z))) plan.trunk(t.x, t.z, t.r);
    this.spots = spots;
    this.setNight(0);
  }

  /** 0 by day .. 1 at night: torches, festoons, lanterns and the bars' lamp-lit back walls glow. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 0.002) return;
    this.night = k;
    this.mats.lit.color.setScalar(litLevel(k));
    // the fountain's and the lily pool's water glow from their underwater lamps
    this.mats.water.emissive.copy(WATER_GLOW).multiplyScalar(k * 0.26);
    this.signMat.emissiveIntensity = 0.06 + k * 0.55;
    this.lights.setNight(k);
  }

  update(dt: number, t: number, camera: THREE.Camera) {
    // only the near side of the world needs anything done
    const dz = camera.position.z - ORIGIN.z;
    if (Math.abs(dz) > 8000) return;
    this.batches.update(camera);
    this.palms.update(camera);
    this.shrubs.update(camera);
    this.lights.update(t);
    const map = this.mats.water.map;
    if (map) map.offset.set((t * 0.013) % 1, (-t * 0.07) % 1);
    if (this.buoys && Math.hypot(camera.position.x - ORIGIN.x, dz) < 2500) this.buoys.update(t);
    void dt;
  }
}

// ------------------------------------------------------------------------------------------------
// The plan
// ------------------------------------------------------------------------------------------------

const PARASOLS: [string, string][] = [
  ['#ff4d6d', '#fff5e3'],
  ['#2ec4b6', '#fff5e3'],
  ['#ffc23d', '#ff8a3d'],
  ['#3a86ff', '#ffffff'],
  ['#7b5cd6', '#ffd23f'],
  ['#ff8fab', '#ffffff'],
];
const TOWELS: [string, string][] = [
  ['#ff4d6d', '#ffffff'],
  ['#2ec4b6', '#ffd23f'],
  ['#3a86ff', '#fff5e3'],
  ['#ff8a3d', '#ffffff'],
  ['#7ee2b8', '#1d6fb8'],
];
const HUTS: [string, string][] = [
  ['#ff9eb5', '#e8463c'],
  ['#9fe0d8', '#1d8a99'],
  ['#ffe08a', '#e88a2c'],
  ['#b9d8ff', '#3a6fd8'],
  ['#c9f2b0', '#3a9a5a'],
  ['#ffc9a8', '#d8582c'],
  ['#e0c8ff', '#7b5cd6'],
];
const BED_SHRUBS: ShrubKind[] = ['hibiscus', 'bougainvillea', 'allamanda', 'croton', 'oleander'];

class Plan {
  constructor(
    private k: Build,
    private palms: PalmSpot[],
    private shrubs: ShrubSpot[],
    private spots: PalmCaySpots,
  ) {}

  build() {
    this.arrivals();
    this.promenade();
    this.plaza();
    this.paths();
    this.beach();
    this.gardens();
    this.edges();
  }

  /** A trunk collider, once the palms are placed. */
  trunk(x: number, z: number, r: number) {
    if (this.k.colliders) staticCylinder(this.k.ctx, x, z, Math.max(0.2, r), 2.4);
  }

  private clear(x: number, z: number, pad = 2) {
    return !KEEP_CLEAR.some((r) => inRect(r, x, z, pad));
  }

  private palm(x: number, z: number, s = 1, kind: PalmSpot['kind'] = 'coconut', yaw?: number) {
    if (this.clear(x, z, 4)) this.palms.push({ x, z, s, kind, yaw });
  }

  private shrubBed(x: number, z: number, w: number, d: number, yaw = 0, kinds = BED_SHRUBS, palmsIn = 0) {
    bed(this.k, x, z, w, d, yaw);
    const rnd = this.k.rnd;
    const n = Math.max(2, Math.round((w * d) / 3.2));
    for (let i = 0; i < n; i++) {
      const p = local(x, z, yaw, (rnd() - 0.5) * (w - 1.4), (rnd() - 0.5) * (d - 1.4));
      this.shrubs.push({ x: p.x, z: p.z, kind: kinds[Math.floor(rnd() * kinds.length)], s: 0.7 + rnd() * 0.5 });
    }
    for (let i = 0; i < palmsIn; i++) {
      const p = local(x, z, yaw, (rnd() - 0.5) * (w - 3), (rnd() - 0.5) * (d - 3));
      this.palm(p.x, p.z, 0.8 + rnd() * 0.4, rnd() > 0.5 ? 'young' : 'coconut');
    }
  }

  private seat(s: Seat) {
    this.spots.benches.push(s);
  }

  // ----------------------------------------------------------------------------------------------

  /** The arrivals plaza: paving, planted beds, the welcome gateway, an island map, benches and lanterns. */
  private arrivals() {
    const k = this.k;
    const a = ARRIVALS;
    k.b.stone.add(new THREE.PlaneGeometry(a.x1 - a.x0, a.z1 - a.z0).rotateX(-Math.PI / 2).translate(0, 0.045, 0), '#f1e6cc', place((a.x0 + a.x1) / 2, 0, (a.z0 + a.z1) / 2), { box: 1 / 2.4 });
    // a darker band leading the eye from the terminal's doors to the promenade
    k.b.stone.add(new THREE.PlaneGeometry(10, a.z1 - a.z0).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#d9c7a2', place(0, 0, (a.z0 + a.z1) / 2), { box: 1 / 2.4 });
    for (const sx of [-1, 1]) {
      this.shrubBed(sx * 46, 40703, 30, 14, 0, BED_SHRUBS, 0);
      for (const dx of [-10, 0, 10]) this.palm(sx * 46 + dx, 40703 + (dx === 0 ? -2 : 2), 1.05);
      this.shrubBed(sx * 21, 40728, 10, 7, 0, ['hibiscus', 'allamanda'], 0);
      this.palm(sx * 21, 40728, 0.9, 'young');
      for (const dx of [-8, 8]) this.seat(bench(k, sx * 46 + dx, 40693.6, Math.PI));
      this.seat(bench(k, sx * 21, 40723.4, Math.PI));
      for (const z of [40685, 40712, 40738]) lantern(k, sx * 32, z);
    }
    this.gateway(0, a.z1 - 1);
    this.mapBoard(-14, 40712, Math.PI / 2);
    this.spots.wander.push({ x: 0, z: 40700 }, { x: -40, z: 40720 }, { x: 40, z: 40720 });
    // an island-buggy stand for the hotels (parked carts)
    for (let i = 0; i < 3; i++) this.buggy(58 - i * 3.2, 40685, 0);
    fingerpost(k, 9, 40735, [
      { text: 'Beach & Plaza', yaw: Math.PI, colour: '#1d8a99' },
      { text: 'Hammock Grove', yaw: Math.PI * 0.75, colour: '#3a9a5a' },
      { text: 'Sunset Lawn', yaw: -Math.PI * 0.75, colour: '#e8732a' },
      { text: 'Departures', yaw: 0, colour: '#24272d' },
    ]);
  }

  /** "Welcome to Palm Cay": two carved posts and a thatched lintel over the promenade's start. */
  private gateway(x: number, z: number) {
    const k = this.k;
    const m = place(x, 0, z);
    for (const sx of [-1, 1]) {
      k.b.stone.box(1.6, 0.6, 1.6, '#e8dcc0', at(m, sx * 8.2, 0.3, 0), { box: 1 / 1.2 });
      k.b.timber.add(new THREE.CylinderGeometry(0.34, 0.42, 6.2, 10).translate(0, 3.1, 0), '#7a5232', at(m, sx * 8.2, 0.6, 0), { box: 1, grain: 'y' });
      // carved rings
      for (let i = 0; i < 5; i++) k.b.timber.add(new THREE.CylinderGeometry(0.46, 0.46, 0.14, 10), '#5b3a22', at(m, sx * 8.2, 1.4 + i * 1.1, 0));
    }
    k.b.timber.box(19, 0.5, 0.6, '#6e4a2c', at(m, 0, 6.9, 0), { box: 1, grain: 'x' });
    k.b.timber.box(18, 0.3, 0.4, '#8a5c36', at(m, 0, 6.35, 0), { box: 1, grain: 'x' });
    k.b.thatch.add(
      gableTop(20.5, 2.6, 1.3),
      '#e2c995',
      at(m, 0, 7.15, 0),
    );
    const r = k.atlas.paint(1024, 192, (g, w, h) => {
      g.fillStyle = '#123f4a';
      roundRect(g, 0, 0, w, h, 26);
      g.fill();
      g.strokeStyle = '#ffd23f';
      g.lineWidth = 8;
      roundRect(g, 10, 10, w - 20, h - 20, 20);
      g.stroke();
      g.fillStyle = '#fff5e3';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `86px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
      g.fillText('Welcome to Palm Cay', w / 2, h * 0.47);
      g.fillStyle = '#ffd23f';
      g.font = `700 30px "DM Sans", system-ui, sans-serif`;
      g.fillText('BEACH  ·  LAGOON  ·  PROMENADE', w / 2, h * 0.82);
    }, 0.7);
    for (const [dz, yaw] of [[-0.33, Math.PI], [0.33, 0]] as const) k.b.signs.add(signPlane(11, 2.06, r), '#ffffff', at(m, 0, 5.15, dz).multiply(new THREE.Matrix4().makeRotationY(yaw)));
    k.b.timber.box(11.3, 2.3, 0.6, '#5b3a22', at(m, 0, 5.15, 0));
    for (const sx of [-4, 4]) k.b.metal.box(0.06, 0.6, 0.06, '#3a3328', at(m, sx, 6.15, 0));
    // torches either side
    for (const sx of [-1, 1]) for (const dz of [-1.4, 1.4]) torch(k, x + sx * 9.6, z + dz, 2.3);
    for (const sx of [-1, 1]) block(k, x + sx * 8.2, z, 0.8, 0.8, 3);
  }

  /** The island's map, painted on a board under a little roof. */
  private mapBoard(x: number, z: number, yaw: number) {
    const k = this.k;
    const m = place(x, 0, z, yaw);
    const r = k.atlas.paint(640, 448, (g, w, h) => paintMap(g, w, h), 0.45);
    k.b.signs.add(signPlane(3.2, 2.24, r), '#ffffff', at(m, 0, 1.95, -0.06).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
    k.b.timber.box(3.5, 2.5, 0.1, '#6e4a2c', at(m, 0, 1.95, 0));
    for (const sx of [-1.6, 1.6]) k.b.timber.box(0.16, 3.4, 0.16, '#5b3a22', at(m, sx, 1.7, 0));
    k.b.thatch.add(gableTop(4.2, 1.2, 0.6), '#e2c995', at(m, 0, 3.4, 0));
    block(k, x, z, 1.8, 0.2, 2, yaw);
  }

  /** A six-seat island buggy (an electric golf cart with a fringed canopy). */
  private buggy(x: number, z: number, yaw: number) {
    const k = this.k;
    const m = place(x, 0, z, yaw);
    const body = '#f4f1ea';
    k.b.paint.box(1.3, 0.55, 3.6, body, at(m, 0, 0.55, 0));
    k.b.paint.box(1.32, 0.12, 3.62, '#2ec4b6', at(m, 0, 0.84, 0));
    for (const lz of [-0.4, 0.5, 1.4]) {
      k.b.paint.box(1.2, 0.12, 0.55, '#c98a4a', at(m, 0, 0.92, lz));
      k.b.paint.box(1.2, 0.5, 0.1, '#c98a4a', at(m, 0, 1.2, lz + 0.3));
    }
    k.b.paint.box(1.2, 0.5, 0.06, '#2b3c48', at(m, 0, 1.45, -1.3));
    for (const sx of [-0.6, 0.6]) for (const lz of [-1.65, 1.75]) k.b.metal.box(0.04, 1.4, 0.04, '#d8dde0', at(m, sx, 1.55, lz));
    k.b.fabric.box(1.45, 0.06, 3.7, '#2ec4b6', at(m, 0, 2.26, 0.05));
    k.b.fabric.box(1.46, 0.16, 3.71, '#fff5e3', at(m, 0, 2.17, 0.05));
    for (const sx of [-0.62, 0.62]) for (const lz of [-1.25, 1.2]) k.b.paint.add(new THREE.CylinderGeometry(0.24, 0.24, 0.18, 12).rotateZ(Math.PI / 2), '#1e1e1e', at(m, sx, 0.24, lz));
    block(k, x, z, 0.7, 1.9, 1.6, yaw);
  }

  /** The Palm Promenade: paving, two planted strips with palms, benches, poles with festoons zigzagging across, torches and the bars. */
  private promenade() {
    const k = this.k;
    const p = PROM;
    const len = p.z1 - p.z0;
    const mz = (p.z0 + p.z1) / 2;
    k.b.stone.add(new THREE.PlaneGeometry(p.half * 2, len).rotateX(-Math.PI / 2).translate(0, 0.045, 0), '#f3e8d0', place(0, 0, mz), { box: 1 / 2.4 });
    // an inlaid wave band down the middle
    for (let z = p.z0 + 3; z < p.z1 - 2; z += 6) {
      k.b.stone.add(new THREE.CircleGeometry(1.1, 18).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#d2b98c', place(0, 0, z), { box: 1 / 2.4 });
      k.b.stone.add(new THREE.RingGeometry(1.5, 1.75, 24).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#d2b98c', place(0, 0, z), { box: 1 / 2.4 });
    }
    for (const sx of [-1, 1]) {
      const cx = sx * (p.half + p.strip / 2);
      // the planted strip and its kerbs
      k.b.ground.add(new THREE.PlaneGeometry(p.strip, len).rotateX(-Math.PI / 2).translate(0, 0.03, 0), '#5a3e28', place(cx, 0, mz), { box: 0.5 });
      for (const ex of [p.half, p.half + p.strip]) k.b.stone.box(0.25, 0.14, len, '#e0d4b8', place(sx * ex, 0.07, mz), { box: 1 / 1.2 });
      // the side walk in front of the shops
      k.b.stone.add(new THREE.PlaneGeometry(p.side, len).rotateX(-Math.PI / 2).translate(0, 0.045, 0), '#e8dcc0', place(sx * (p.half + p.strip + p.side / 2), 0, mz), { box: 1 / 2.4 });
      for (let z = p.z0 + 8; z < p.z1 - 4; z += 12) {
        this.palm(cx, z, 1.05 + ((z * 7) % 3) * 0.05, 'coconut', sx > 0 ? Math.PI : 0);
        // shrubs between the palms, and a bench facing across every other gap
        for (const dz of [-4, 4]) this.shrubs.push({ x: cx + (k.rnd() - 0.5) * 1.2, z: z + dz + (k.rnd() - 0.5), kind: BED_SHRUBS[Math.floor(k.rnd() * BED_SHRUBS.length)], s: 0.8 + k.rnd() * 0.3 });
        torch(k, sx * (p.half + p.strip + p.side + 0.6), z + 6);
      }
      for (let z = p.z0 + 26; z < p.z1 - 10; z += 48) this.seat(bench(k, sx * (p.half - 0.75), z, (sx * Math.PI) / 2));
    }
    // festoon poles every 24 m each side, the strings crossing in a zigzag and running along each side
    const tops: THREE.Vector3[][] = [[], []];
    for (let z = p.z0 + 2, i = 0; z < p.z1; z += 24, i++)
      for (const [j, sx] of [[0, -1], [1, 1]] as const) tops[j].push(stringPole(k, sx * (p.half + 0.4), z + (sx > 0 ? 12 : 0)));
    for (let i = 0; i < tops[0].length; i++) {
      if (tops[1][i]) this.k.lights.addString(tops[0][i], tops[1][i], { sag: 0.9 });
      if (tops[0][i + 1] && tops[1][i]) this.k.lights.addString(tops[1][i], tops[0][i + 1], { sag: 0.9 });
    }
    for (let i = 0; i < 24 && i < tops[0].length * 2; i++) this.spots.promenade.push({ x: 0, z: p.z0 + 6 + i * 17 });
    this.spots.promenade.length = Math.min(this.spots.promenade.length, Math.floor(len / 17));
    // the shops and bars, fronts facing the promenade
    const wx = -(p.half + p.strip + p.side + 4.6);
    const ex = -wx;
    const sign = (bg: string, fg = '#fff5e3') => ({ bg, fg, border: '#fff5e3', font: 'display' as const });
    const bars: [number, number, Parameters<typeof bar>[4]][] = [
      [wx, 40810, { name: 'Mango Tango', sub: 'SMOOTHIES · FRESH JUICE', sign: sign('#f08a1c'), kind: 'smoothie', front: '#ffd08a' }],
      [ex, 40850, { name: 'Coco Gelato', sub: 'ICE CREAM · SORBET', sign: sign('#ff8fab'), kind: 'ice', w: 5, front: '#ffe0ea', stools: 0 }],
      [wx, 40930, { name: 'Reef Riders', sub: 'SURF CO. · RENTALS', sign: sign('#1d6fb8'), kind: 'surf', w: 7, stools: 0 }],
      [ex, 40990, { name: 'Driftwood Tiki Bar', sub: 'COCKTAILS · MOCKTAILS', sign: sign('#7a3a1c', '#ffd23f'), kind: 'tiki', w: 8, d: 4.5, front: '#c9a66b' }],
      [wx, 41060, { name: 'Shell Shack', sub: 'SOUVENIRS · SUNSCREEN', sign: sign('#2ec4b6'), kind: 'shop', w: 5, stools: 0 }],
      [ex, 41100, { name: 'Coconut Corner', sub: 'FRESH COCONUTS', sign: sign('#3a9a5a', '#fff5e3'), kind: 'smoothie', w: 5 }],
    ];
    for (const [x, z, o] of bars) {
      const seats = bar(k, x, z, x < 0 ? -Math.PI / 2 : Math.PI / 2, o);
      this.spots.bar.push(...seats);
      // planting round each hut
      this.palm(x + Math.sign(x) * 5, z - (o.w ?? 6) / 2 - 3, 1.1);
      this.palm(x + Math.sign(x) * 6, z + (o.w ?? 6) / 2 + 3, 0.95, 'young');
      this.shrubBed(x + Math.sign(x) * 1.5, z + (o.w ?? 6) / 2 + 3, 4, 3);
    }
    this.spots.wander.push({ x: -10.5, z: 40880 }, { x: 10.5, z: 40920 }, { x: 0, z: 41000 }, { x: -10.5, z: 41090 }, { x: 10.5, z: 40800 });
  }

  /** The Beach Plaza: a paved circle with an inlaid compass rose, the fountain, a ring of palms, benches and lanterns. */
  private plaza() {
    const k = this.k;
    const { x, z, r } = PLAZA;
    pavedDisc(k, x, z, r, '#f3e8d0');
    k.b.stone.add(new THREE.RingGeometry(r - 7, r - 6.2, 96).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#c9ae80', place(x, 0, z), { box: 1 / 2.4 });
    k.b.stone.add(new THREE.RingGeometry(9.2, 10, 72).rotateX(-Math.PI / 2).translate(0, 0.05, 0), '#c9ae80', place(x, 0, z), { box: 1 / 2.4 });
    // the compass rose's points between the rings
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const long = i % 2 === 0 ? r - 7.5 : 18;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1.6, 0, 10.5, -1.6, 0, 10.5, 1.6, 0, 10.5, 0, 0, long, -1.6, 0, 10.5], 3));
      g.computeVertexNormals();
      k.b.stone.add(g.translate(0, 0.052, 0), i === 0 ? '#e0a050' : '#d2b98c', place(x, 0, z, a), { box: 1 / 2.4 });
    }
    fountain(k, x, z);
    // benches facing the fountain and palms round the edge
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
      const bx = x + Math.cos(a) * 15;
      const bz = z + Math.sin(a) * 15;
      // skip the openings to the promenade (north) and the beach (south)
      if (Math.abs(Math.cos(a)) < 0.3) continue;
      this.seat(bench(k, bx, bz, Math.atan2(Math.cos(a), Math.sin(a))));
    }
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const px = x + Math.cos(a) * (r - 2.5);
      const pz = z + Math.sin(a) * (r - 2.5);
      // leave the six openings clear (paths to the promenade, the games and the beach)
      if ([-Math.PI / 2, Math.PI / 2, Math.PI, Math.PI * 0.72, Math.PI * 0.28, -Math.PI * 0.06].some((o) => Math.abs(Math.atan2(Math.sin(a - o), Math.cos(a - o))) < 0.16)) continue;
      this.palm(px, pz, 1.12, 'coconut', a + Math.PI);
      this.shrubs.push({ x: px + Math.cos(a) * 1.4, z: pz + Math.sin(a) * 1.4, kind: 'bougainvillea', s: 1.1 });
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      lantern(k, x + Math.cos(a) * 24, z + Math.sin(a) * 24);
    }
    fingerpost(k, x + 11, z - 20, [
      { text: 'Splash Tower', yaw: Math.PI / 2 + 0.1, colour: '#1d8a99' },
      { text: 'Pirate Cannons', yaw: Math.PI * 0.72, colour: '#7a3a1c' },
      { text: 'Beach Volley', yaw: -Math.PI * 0.72, colour: '#e8732a' },
      { text: 'Jet-Ski Race', yaw: Math.PI + 0.2, colour: '#3a86ff' },
      { text: 'Airport', yaw: 0, colour: '#24272d' },
    ]);
    this.spots.wander.push({ x: x - 20, z: z - 18 }, { x: x + 20, z: z + 18 }, { x: x - 24, z: z + 10 }, { x: x + 24, z: z - 10 });
  }

  /** Paths from the Beach Plaza to the games and the beach, and into the gardens. */
  private paths() {
    const k = this.k;
    const { x, z, r } = PLAZA;
    // slides: west along a paved path
    pavedPath(k, [{ x: x - r + 1, z: z - 4 }, { x: -120, z: 41166 }, { x: -182, z: 41152 }], 5);
    // cannons: a boardwalk south-west through the dunes
    boardwalk(k, [{ x: x - 27, z: z + 26 }, { x: -110, z: 41290 }, { x: -215, z: 41352 }, { x: -312, z: 41398 }], 3.2);
    // volley: south-east
    boardwalk(k, [{ x: x + 27, z: z + 26 }, { x: 105, z: 41300 }, { x: 160, z: 41390 }], 3.2);
    // the jet-ski dock and the beach: straight south, then a dog-leg to the dock's head
    boardwalk(k, [{ x, z: z + r - 1 }, { x, z: 41330 }, { x: 48, z: 41410 }, { x: 58, z: 41437 }], 3.6);
    // the beach boardwalk along the top of the sand, either side of the dock
    boardwalk(k, [{ x: -305, z: BEACH_WALK_Z }, { x: 22, z: BEACH_WALK_Z }], 3, false);
    boardwalk(k, [{ x: 98, z: BEACH_WALK_Z }, { x: 490, z: BEACH_WALK_Z }], 3, false);
    // garden paths off the promenade
    pavedPath(k, [{ x: -(PROM.half + PROM.strip + PROM.side), z: 40896 }, { x: -120, z: 40900 }, { x: POOL.x + POOL.r + 9, z: POOL.z - 6 }], 3.4, '#efe2c4');
    pavedPath(k, [{ x: PROM.half + PROM.strip + PROM.side, z: 40948 }, { x: 140, z: 40955 }, { x: LAWN.x - 34, z: LAWN.z }], 3.4, '#efe2c4');
    // torches along the boardwalks to the games
    const along = (pts: V2[], every: number, off: number) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
        for (let d = every / 2; d < len; d += every) {
          const c = { x: a.x + ((b.x - a.x) * d) / len, z: a.z + ((b.z - a.z) * d) / len };
          const t = local(c.x, c.z, yaw, off, 0);
          if (this.clear(t.x, t.z, 1)) torch(k, t.x, t.z);
          this.spots.wander.push(c);
        }
      }
    };
    along([{ x: x - 27, z: z + 26 }, { x: -110, z: 41290 }, { x: -215, z: 41352 }, { x: -300, z: 41392 }], 16, 2.6);
    along([{ x: x + 27, z: z + 26 }, { x: 105, z: 41300 }, { x: 150, z: 41375 }], 16, -2.6);
    along([{ x: x - r, z: z - 4 }, { x: -120, z: 41166 }, { x: -178, z: 41153 }], 16, 3.6);
    // palms and beds lining the paths
    for (let i = 0; i < 9; i++) {
      this.palm(-60 - i * 14, 41158 + (i % 2) * 18 - 4, 1);
      this.palm(30 + i * 14, 41250 + i * 10 + (i % 2) * 8, 0.95);
      this.palm(-40 - i * 30, 41262 + i * 12 - (i % 2) * 16, 1.05);
    }
  }

  /** The south beach: parasols, palapas and loungers in rows, towels, huts, lifeguard towers, kayaks, sandcastles, showers and the pier. */
  private beach() {
    const k = this.k;
    const rnd = k.rnd;
    const p = pierLine();
    const sp = this.spots;
    const free = (x: number, z: number, pad = 3) => this.clear(x, z, pad) && Math.abs(x - PIER_X) > 6 && islandShoreDist(x, z) > 24;
    // rows of shade from the boardwalk to the dry sand's edge
    for (let x = -296; x <= 480; x += 9) {
      const zEnd = dryBeachZ(x) - 6;
      for (let z = BEACH_WALK_Z + 9, row = 0; z < zEnd; z += 11, row++) {
        const xx = x + (row % 2) * 4.5 + (rnd() - 0.5) * 1.5;
        const zz = z + (rnd() - 0.5) * 2;
        if (!free(xx, zz, 4) || rnd() < 0.18) continue;
        if ((Math.floor(x / 9) + row) % 3 === 0) palapa(k, xx, zz);
        else {
          const c = PARASOLS[Math.floor(rnd() * PARASOLS.length)];
          parasol(k, xx, zz, c[0], c[1]);
        }
        // two loungers under each, heads to the north, facing the sea; or towels
        if (rnd() < 0.7) {
          const cushion = ['#2ec4b6', '#fff5e3', '#ffc23d', '#ff8fab', '#3a86ff'][Math.floor(rnd() * 5)];
          for (const dx of [-0.55, 0.55]) sp.beach.push(lounger(k, xx + dx, zz + 0.6, 0, cushion));
        } else {
          for (const dx of [-0.7, 0.7]) {
            const t = TOWELS[Math.floor(rnd() * TOWELS.length)];
            const yaw = (rnd() - 0.5) * 0.4;
            towel(k, xx + dx, zz + 0.8, yaw, t[0], t[1]);
            sp.beach.push({ x: xx + dx, z: zz + 0.8, yaw: yaw + Math.PI });
          }
        }
      }
    }
    // scattered towels down by the water
    for (let i = 0; i < 46; i++) {
      const x = -290 + rnd() * 770;
      const z = dryBeachZ(x) - 2 - rnd() * 8;
      if (!free(x, z, 3)) continue;
      const t = TOWELS[Math.floor(rnd() * TOWELS.length)];
      const yaw = Math.PI + (rnd() - 0.5) * 0.8;
      towel(k, x, z, yaw, t[0], t[1]);
      sp.beach.push({ x, z, yaw: yaw + Math.PI });
    }
    // sandcastles at the foot of the dry sand, and a spot beside each to kneel and build
    for (let i = 0; i < 14; i++) {
      const x = -280 + rnd() * 740;
      const z = dryBeachZ(x) - 3 - rnd() * 4;
      if (!free(x, z, 2)) continue;
      sandcastle(k, x, z, 0.8 + rnd() * 0.6);
      const s = { x: x + 1.2, z: z - 0.4, yaw: -Math.PI / 2 };
      if (PALM_CAY_WALK.some((r) => inRect(r, s.x, s.z))) sp.beach.push(s);
    }
    // beach huts in a row at the back of the east beach, and a few on the west
    for (let i = 0; i < 9; i++) {
      const [c, r] = HUTS[i % HUTS.length];
      beachHut(k, 270 + i * 4.2, BEACH_WALK_Z + 5.5, Math.PI, c, r);
    }
    for (let i = 0; i < 5; i++) {
      const [c, r] = HUTS[(i + 3) % HUTS.length];
      beachHut(k, -280 + i * 4.2, BEACH_WALK_Z + 5.5, Math.PI, c, r);
    }
    // lifeguard towers face the sea
    lifeguardTower(k, -140, dryBeachZ(-140) - 14, Math.PI);
    lifeguardTower(k, 400, dryBeachZ(400) - 14, Math.PI);
    // kayaks drawn up by the water, next to the dock
    for (let i = 0; i < 7; i++) {
      const x = 112 + i * 2.1;
      kayak(k, x, dryBeachZ(x) + 2, -0.12 + (rnd() - 0.5) * 0.2, ['#ffd23f', '#ff4d6d', '#2ec4b6', '#ff8a3d', '#3a86ff'][i % 5]);
    }
    // showers and bins at the boardwalk's access points
    for (const x of [-220, -60, 130, 250, 440]) shower(k, x, BEACH_WALK_Z + 3.5);
    // the pier, with benches in its gazebo
    sp.benches.push(...pier(k, PIER_X, p.z0, p.z1));
    boardwalk(k, [{ x: PIER_X, z: BEACH_WALK_Z + 1.5 }, { x: PIER_X, z: p.z0 + 0.5 }], 3.2, true);
    // coconut palms along the back of the beach, leaning out towards the sea
    for (let x = -300; x <= 490; x += 11 + rnd() * 9) {
      const z = BEACH_WALK_Z - 4 - rnd() * 10;
      this.palm(x, z, 1 + rnd() * 0.25, 'coconut', -Math.PI / 2 + (rnd() - 0.5) * 0.9);
    }
    for (let i = 0; i < 16; i++) {
      const x = -290 + rnd() * 770;
      const z = BEACH_WALK_Z + 6 + rnd() * 18;
      if (free(x, z, 6)) this.palm(x, z, 1.05 + rnd() * 0.2, 'coconut', -Math.PI / 2 + (rnd() - 0.5) * 1.2);
    }
    for (let x = -280; x < 480; x += 40) sp.wander.push({ x: x + rnd() * 20, z: BEACH_WALK_Z + 10 + rnd() * 30 });
  }

  /** The buoy line marking the swimming area, off the beach between the games' waters and the pier. */
  buoyLine() {
    const out: V2[] = [];
    const runs: [number, number][] = [
      [-280, 15],
      [105, PIER_X - 12],
      [PIER_X + 12, 500],
    ];
    for (const [x0, x1] of runs)
      for (let x = x0; x <= x1; x += 7) {
        // ~55 m out from the water's edge, never into the lagoon's race course
        let z = dryBeachZ(x) + 22;
        z = Math.min(z + 55, ISLAND.lagoon.z0 - 12);
        out.push({ x, z });
      }
    return out;
  }

  /** The gardens: the lily pool and hammock grove (west), the picnic lawn and stage (east), groves and beds. */
  private gardens() {
    const k = this.k;
    const rnd = k.rnd;
    // ---- the lily pool
    const { x, z, r } = POOL;
    const m = place(x, 0, z);
    k.b.stone.add(new THREE.CylinderGeometry(r + 0.5, r + 0.55, 0.42, 64, 1, true).translate(0, 0.21, 0), '#e8dcc0', m, { box: 0.5 });
    k.b.stone.add(new THREE.RingGeometry(r - 0.05, r + 0.6, 64).rotateX(-Math.PI / 2).translate(0, 0.42, 0), '#f2e8d2', m, { box: 0.5 });
    k.b.paint.add(new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2).translate(0, 0.06, 0), '#2f6a5a', m);
    k.b.water.add(new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2).translate(0, 0.3, 0), '#cfeee0', m, { box: 0.25 });
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 3 + Math.sqrt(rnd()) * (r - 4);
      const pad = new THREE.CircleGeometry(0.35 + rnd() * 0.35, 10, 0.3, Math.PI * 2 - 0.6).rotateX(-Math.PI / 2).translate(0, 0.32, 0);
      k.b.paint.add(pad, rnd() > 0.2 ? '#4f8a36' : '#6aa040', at(m, Math.cos(a) * d, 0, Math.sin(a) * d, rnd() * 6));
      if (rnd() < 0.3) k.b.paint.add(new THREE.IcosahedronGeometry(0.12, 0).translate(0, 0.38, 0), rnd() > 0.5 ? '#f6a0b8' : '#fff5e3', at(m, Math.cos(a) * d + 0.1, 0, Math.sin(a) * d));
    }
    // a little timber bridge over its waist would cross the pool; a deck pavilion on its north edge instead
    k.b.deck.box(9, 0.14, 5, '#c4a070', place(x, 0.46, z - r - 1.6), { box: 0.5 });
    for (const sx of [-4.2, 4.2]) for (const sz of [-2.3, 2.3]) k.b.timber.add(new THREE.CylinderGeometry(0.1, 0.12, 3, 7).translate(0, 1.5, 0), '#7a5232', place(x + sx, 0.5, z - r - 1.6 + sz), { box: 1, grain: 'y' });
    k.b.thatch.add(hip(10.5, 6.6, 1.8), '#e2c995', place(x, 3.5, z - r - 1.6));
    this.seat(bench(k, x - 2, z - r - 0.6, 0));
    this.seat(bench(k, x + 2, z - r - 0.6, 0));
    if (k.colliders) {
      staticCylinder(k.ctx, x, z, r + 0.55, 0.45);
      block(k, x, z - r - 1.6, 4.5, 2.5, 0.5);
    }
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      if (Math.sin(a) < -0.6) continue;
      this.palm(x + Math.cos(a) * (r + 6), z + Math.sin(a) * (r + 6), 0.9 + rnd() * 0.3, i % 3 ? 'coconut' : 'young');
      if (i % 2) lantern(k, x + Math.cos(a + 0.2) * (r + 3), z + Math.sin(a + 0.2) * (r + 3), 2.6);
    }
    // ---- the hammock grove, south-west of the pool
    for (let i = 0; i < 7; i++) {
      const hx = -360 + (i % 4) * 26 + (rnd() - 0.5) * 6;
      const hz = 41000 + Math.floor(i / 4) * 30 + (rnd() - 0.5) * 6;
      const yaw = rnd() * Math.PI;
      const a = local(hx, hz, yaw, -2.4, 0);
      const b = local(hx, hz, yaw, 2.4, 0);
      this.palm(a.x, a.z, 1, 'coconut');
      this.palm(b.x, b.z, 1, 'coconut');
      hammock(k, a, b, ['#ff8a3d', '#2ec4b6', '#ffd23f', '#ff4d6d', '#7b5cd6'][i % 5]);
      this.spots.beach.push({ x: hx, z: hz, yaw });
    }
    // ---- the picnic lawn: palapas over picnic tables, and the little stage
    for (let i = 0; i < 8; i++) {
      const px = LAWN.x - 20 + (i % 4) * 16;
      const pz = LAWN.z - 12 + Math.floor(i / 4) * 26;
      palapa(k, px, pz, 2.4);
      picnicTable(k, px, pz, (i * 0.7) % Math.PI, this.spots.benches);
    }
    this.stage(LAWN.x + 46, LAWN.z + 2);
    // ---- groves over the rest of the lawns, kept off paths, plazas and the games' plots
    const busy = (px: number, pz: number) =>
      Math.abs(px) < 30 ||
      inRect(ARRIVALS, px, pz, 6) ||
      Math.hypot(px - PLAZA.x, pz - PLAZA.z) < PLAZA.r + 6 ||
      Math.hypot(px - POOL.x, pz - POOL.z) < POOL.r + 12 ||
      Math.hypot(px - LAWN.x, pz - LAWN.z) < 52 ||
      Math.abs(pz - 40900) < 5 ||
      Math.abs(pz - 40952) < 5 ||
      pz > BEACH_WALK_Z - 3 ||
      !this.clear(px, pz, 8);
    const groves: [number, number, number, number][] = [
      // centre x, z, radius, palms
      [-180, 40790, 50, 28],
      [-420, 40780, 70, 40],
      [-460, 40990, 45, 22],
      [-130, 41020, 40, 18],
      [-200, 41060, 35, 12],
      [-90, 41380, 45, 16],
      [190, 40790, 55, 28],
      [420, 40800, 70, 36],
      [450, 41080, 55, 24],
      [140, 41140, 50, 20],
      [180, 41060, 35, 12],
      [330, 41260, 60, 26],
      [-480, 41250, 40, 16],
      [-300, 41260, 40, 14],
      [470, 41330, 35, 12],
    ];
    for (const [gx, gz, gr, n] of groves)
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * gr;
        const px = gx + Math.cos(a) * d;
        const pz = gz + Math.sin(a) * d;
        if (busy(px, pz) || px < PARK.x0 + 4 || px > PARK.x1 - 4) continue;
        this.palm(px, pz, 0.85 + rnd() * 0.4, rnd() < 0.3 ? 'young' : 'coconut');
        if (rnd() < 0.5) this.shrubs.push({ x: px + (rnd() - 0.5) * 4, z: pz + (rnd() - 0.5) * 4, kind: BED_SHRUBS[Math.floor(rnd() * BED_SHRUBS.length)], s: 0.8 + rnd() * 0.6 });
      }
    // flower beds dotted about the lawns
    for (let i = 0; i < 18; i++) {
      const px = PARK.x0 + 30 + rnd() * (PARK.x1 - PARK.x0 - 60);
      const pz = 40760 + rnd() * 560;
      if (busy(px, pz)) continue;
      this.shrubBed(px, pz, 6 + rnd() * 6, 4 + rnd() * 3, rnd() * Math.PI, BED_SHRUBS, rnd() < 0.5 ? 1 : 0);
    }
    this.spots.wander.push({ x: POOL.x + 20, z: POOL.z - 20 }, { x: LAWN.x, z: LAWN.z }, { x: LAWN.x - 30, z: LAWN.z + 20 }, { x: -330, z: 41010 });
  }

  /** A small thatched stage for evening music, facing west over the lawn, with festoons. */
  private stage(x: number, z: number) {
    const k = this.k;
    const m = place(x, 0, z, Math.PI / 2);
    k.b.deck.box(12, 0.8, 7, '#b58a5c', at(m, 0, 0.4, 0), { box: 0.5 });
    k.b.timber.box(12.2, 0.8, 0.2, '#6e4a2c', at(m, 0, 0.4, -3.55), { box: 1 });
    for (const sx of [-5.8, 5.8]) for (const sz of [-3.3, 3.3]) k.b.timber.add(new THREE.CylinderGeometry(0.16, 0.18, 4.4, 8).translate(0, 2.2, 0), '#6e4a2c', at(m, sx, 0.8, sz), { box: 1, grain: 'y' });
    k.b.timber.box(12, 3.6, 0.2, '#8a5c36', at(m, 0, 2.6, 3.4), { box: 1, grain: 'y' });
    k.b.thatch.add(hip(14.5, 9.5, 2.6), '#e2c995', at(m, 0, 5.2, 0));
    // steps, speakers, a drum kit's worth of shapes
    for (let i = 0; i < 3; i++) k.b.deck.box(2.4, 0.27, 0.35, '#b58a5c', at(m, 3.5, 0.135 + i * 0.27, -3.7 - (2 - i) * 0.35), { box: 0.5 });
    for (const sx of [-5, 5]) k.b.paint.box(0.7, 1.4, 0.6, '#1e1e1e', at(m, sx, 1.5, 2.5));
    k.b.paint.add(new THREE.CylinderGeometry(0.35, 0.35, 0.5, 14).rotateX(Math.PI / 2), '#e8463c', at(m, 0, 1.3, 2));
    const r = k.atlas.sign('Sunset Stage', 768, 160, { bg: '#e8732a', fg: '#fff5e3', border: '#ffd23f', sub: 'LIVE MUSIC FROM 7 PM' });
    k.b.signs.add(signPlane(5.2, 1.08, r), '#ffffff', at(m, 0, 4.4, -3.4).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
    const a = new THREE.Vector3();
    for (const sz of [-3.3, 3.3]) {
      const p0 = a.set(x, 4.9, z).clone().add(new THREE.Vector3(-3.3, 0, sz).applyAxisAngle(THREE.Object3D.DEFAULT_UP, Math.PI / 2));
      k.lights.addString(p0, p0.clone().add(new THREE.Vector3(0, 0, 0).set(-18, -1.2, 0)), { sag: 0.6 });
    }
    k.lights.addPool(x, 0.8, z, 6, '#ffbf7a');
    block(k, x, z, 3.6, 6.1, 0.8);
  }

  /** The park's edges: a hibiscus hedge with a post-and-rail fence along the north (beside the terminal) and hedges east and west. */
  private edges() {
    const k = this.k;
    const z = ARRIVALS.z0 + 0.5;
    for (const [x0, x1] of [
      [PARK.x0, ARRIVALS.x0 - 1],
      [ARRIVALS.x1 + 1, PARK.x1],
    ]) {
      for (let x = x0; x < x1; x += 2.1) this.shrubs.push({ x, z: z + 1.2 + (k.rnd() - 0.5) * 0.4, kind: k.rnd() > 0.3 ? 'hibiscus' : 'oleander', s: 1.15 });
      for (let x = x0; x <= x1; x += 3) k.b.timber.add(new THREE.CylinderGeometry(0.06, 0.07, 1.2, 6).translate(0, 0.6, 0), '#7a5a3a', place(x, 0, z), { box: 2, grain: 'y' });
      for (const y of [0.45, 1.0]) k.b.timber.box(x1 - x0, 0.08, 0.06, '#8a6a48', place((x0 + x1) / 2, y, z), { box: 1, grain: 'x' });
      for (let x = x0 + 8; x < x1; x += 24 + k.rnd() * 10) this.palm(x, z + 6 + k.rnd() * 4, 1.1 + k.rnd() * 0.2);
    }
    for (const x of [PARK.x0 + 1.5, PARK.x1 - 1.5]) for (let zz = ARRIVALS.z0 + 4; zz < BEACH_WALK_Z - 4; zz += 2.4) this.shrubs.push({ x: x + (k.rnd() - 0.5) * 0.6, z: zz, kind: k.rnd() > 0.5 ? 'bougainvillea' : 'croton', s: 1.25 });
  }
}

// ------------------------------------------------------------------------------------------------
// Small pieces used by the plan
// ------------------------------------------------------------------------------------------------

function hip(w: number, d: number, rise: number) {
  return hipRoof(w, d, rise);
}

/** A thatched ridge cap (a gable, open ends) of span × rise, length along x. */
function gableTop(len: number, span: number, rise: number) {
  const hs = span / 2;
  const hl = len / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-hl, 0, -hs, hl, 0, -hs, hl, rise, 0, -hl, 0, -hs, hl, rise, 0, -hl, rise, 0, hl, 0, hs, -hl, 0, hs, -hl, rise, 0, hl, 0, hs, -hl, rise, 0, hl, rise, 0], 3));
  const slope = Math.hypot(hs, rise);
  g.setAttribute('uv', new THREE.Float32BufferAttribute([-hl, slope, hl, slope, hl, 0, -hl, slope, hl, 0, -hl, 0, hl, slope, -hl, slope, -hl, 0, hl, slope, -hl, 0, hl, 0].map((v) => v * 0.5), 2));
  g.computeVertexNormals();
  return g;
}

/** A rope hammock slung between two trunks, sagging to ~0.6 m. */
function hammock(k: Build, a: V2, b: V2, colour: string) {
  const n = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const sx = -dz / len;
  const sz = dx / len;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = 1.5 - Math.sin(t * Math.PI) * 0.95;
    const w = 0.12 + Math.sin(t * Math.PI) * 0.45;
    const cx = dx * t;
    const cz = dz * t;
    pos.push(cx + sx * w, y + Math.sin(t * Math.PI) * 0.12, cz + sz * w, cx - sx * w, y + Math.sin(t * Math.PI) * 0.12, cz - sz * w, cx, y - 0.05, cz);
    if (i > 0) {
      const p = (i - 1) * 3;
      idx.push(p, p + 3, p + 2, p + 2, p + 3, p + 5, p + 2, p + 5, p + 1, p + 1, p + 5, p + 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  k.b.fabric.add(g, colour, place(a.x, 0, a.z));
}

/** A picnic table with two benches; adds the bench seats. */
function picnicTable(k: Build, x: number, z: number, yaw: number, seats: Seat[]) {
  const m = place(x, 0, z, yaw);
  k.b.timber.box(1.9, 0.06, 0.8, '#a8784c', at(m, 0, 0.76, 0), { box: 1, grain: 'x' });
  for (const sx of [-0.75, 0.75]) k.b.timber.box(0.08, 0.76, 0.08, '#7a5232', at(m, sx, 0.38, 0));
  for (const sz of [-0.7, 0.7]) {
    k.b.timber.box(1.9, 0.05, 0.3, '#a8784c', at(m, 0, 0.45, sz), { box: 1, grain: 'x' });
    for (const sx of [-0.75, 0.75]) k.b.timber.box(0.07, 0.45, 0.07, '#7a5232', at(m, sx, 0.225, sz));
    for (const lx of [-0.45, 0.45]) {
      const s = local(x, z, yaw, lx, sz);
      seats.push({ x: s.x, z: s.z, yaw: yaw + (sz < 0 ? Math.PI : 0) });
    }
  }
  block(k, x, z, 0.95, 0.85, 0.8, yaw);
}

/** The island map painted on the arrivals plaza's board (north up, the plan of the park). */
function paintMap(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = '#5ac8d8';
  g.fillRect(0, 0, w, h);
  // map frame: x −560..560, z 40560..41640 onto the board
  const sx = (x: number) => ((x + 560) / 1120) * w;
  const sz = (z: number) => ((z - 40560) / 1080) * h;
  g.fillStyle = '#7ed36a';
  g.beginPath();
  for (let i = 0; i <= 64; i++) {
    const x = -560 + (i / 64) * 1120;
    let z = 41700;
    while (z > 40700 && islandShoreDist(x, z) < 0) z -= 4;
    if (i === 0) g.moveTo(sx(x), 0);
    g.lineTo(sx(x), sz(z));
  }
  g.lineTo(w, 0);
  g.closePath();
  g.fill();
  // the beach
  g.strokeStyle = '#f3dfa8';
  g.lineWidth = 18;
  g.beginPath();
  for (let i = 0; i <= 64; i++) {
    const x = -560 + (i / 64) * 1120;
    let z = 41700;
    while (z > 40700 && islandShoreDist(x, z) < 0) z -= 4;
    if (i === 0) g.moveTo(sx(x), sz(z) - 9);
    else g.lineTo(sx(x), sz(z) - 9);
  }
  g.stroke();
  // the terminal and apron
  g.fillStyle = '#9aa4ad';
  g.fillRect(sx(-200), 0, sx(200) - sx(-200), sz(40598));
  g.fillStyle = '#c96f3a';
  g.fillRect(sx(-130), sz(40600), sx(130) - sx(-130), sz(40670) - sz(40600));
  // promenade, plaza and paths
  g.strokeStyle = '#fff5e3';
  g.lineCap = 'round';
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(sx(0), sz(40672));
  g.lineTo(sx(0), sz(41150));
  g.moveTo(sx(-35), sz(41175));
  g.lineTo(sx(-182), sz(41152));
  g.moveTo(sx(-27), sz(41206));
  g.lineTo(sx(-312), sz(41398));
  g.moveTo(sx(27), sz(41206));
  g.lineTo(sx(160), sz(41390));
  g.moveTo(sx(0), sz(41216));
  g.lineTo(sx(58), sz(41437));
  g.stroke();
  g.fillStyle = '#fff5e3';
  g.beginPath();
  g.arc(sx(0), sz(41180), 22, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#5ac8d8';
  g.beginPath();
  g.arc(sx(0), sz(41180), 6, 0, Math.PI * 2);
  g.arc(sx(POOL.x), sz(POOL.z), 9, 0, Math.PI * 2);
  g.fill();
  // the game spots, numbered pins
  const pins: [number, number, string, string][] = [
    [ISLAND_SPOTS.slides.x, ISLAND_SPOTS.slides.z, '1', PALETTE.teal],
    [ISLAND_SPOTS.cannons.x, ISLAND_SPOTS.cannons.z, '2', '#7a3a1c'],
    [ISLAND_SPOTS.volley.x, ISLAND_SPOTS.volley.z, '3', PALETTE.orange],
    [ISLAND_SPOTS.jetski.x, ISLAND_SPOTS.jetski.z + 60, '4', PALETTE.sky],
  ];
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [x, z, n, c] of pins) {
    g.fillStyle = c;
    g.beginPath();
    g.arc(sx(x), sz(z), 22, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = `34px "Lilita One", sans-serif`;
    g.fillText(n, sx(x), sz(z) + 2);
  }
  // you are here
  g.fillStyle = PALETTE.candy;
  g.beginPath();
  g.arc(sx(-14), sz(40712), 12, 0, Math.PI * 2);
  g.fill();
  // title and legend
  g.fillStyle = 'rgba(18,63,74,0.88)';
  roundRect(g, 14, h - 128, w - 28, 114, 16);
  g.fill();
  g.fillStyle = '#fff5e3';
  g.textAlign = 'left';
  g.font = `40px "Lilita One", sans-serif`;
  g.fillText('Palm Cay Beach Park', 30, h - 98);
  g.font = `700 21px "DM Sans", system-ui, sans-serif`;
  g.fillStyle = '#ffd23f';
  g.fillText('1 Splash Tower   2 Pirate Cannons   3 Beach Volley   4 Jet-Ski Race', 30, h - 58);
  g.fillStyle = '#fff5e3';
  g.fillText('●  You are here', 30, h - 28);
  g.fillStyle = PALETTE.candy;
  g.fillText('●', 30, h - 28);
}

// ------------------------------------------------------------------------------------------------
// The swimming area's buoys
// ------------------------------------------------------------------------------------------------

/** A float: a squashed ball, alternately orange and yellow along the line. */
const BUOY = new THREE.SphereGeometry(0.32, 10, 6).scale(1, 0.8, 1);
const BUOY_COLOURS = ['#ff6b1a', '#ffd23f'] as const;

/** Floats along the swimming area's line, bobbing on the swell (one instanced draw). */
class Buoys {
  readonly mesh: THREE.InstancedMesh;
  private spots: V2[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(spots: V2[]) {
    this.spots = spots;
    this.mesh = new THREE.InstancedMesh(BUOY, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0 }), spots.length);
    this.mesh.position.copy(ORIGIN);
    const c = new THREE.Color();
    spots.forEach((_, i) => this.mesh.setColorAt(i, c.set(BUOY_COLOURS[i % 2])));
    this.update(0);
    this.mesh.computeBoundingSphere();
    this.mesh.castShadow = false;
  }

  update(t: number) {
    for (let i = 0; i < this.spots.length; i++) {
      const b = this.spots[i];
      const ph = b.x * 0.09 + b.z * 0.05;
      this.p.set(b.x - ORIGIN.x, SEA_Y + 0.06 + 0.09 * Math.sin(t * 1.3 + ph) + 0.04 * Math.sin(t * 2.1 + ph * 1.7), b.z - ORIGIN.z);
      this.q.setFromEuler(this.e.set(0.12 * Math.sin(t * 1.1 + ph), 0, 0.12 * Math.cos(t * 0.9 + ph)));
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
