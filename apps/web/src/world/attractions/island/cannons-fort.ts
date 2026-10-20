// Pirate Cannons: Fort Cutlass, an old coquina-stone battery on the dunes at the south-west of
// Palm Cay's beach. A raised gun deck with a battered sea wall, a parapet with three splayed
// embrasures and a domed sentry box at each seaward corner; behind it a walled courtyard with its
// gate towards the beach boardwalk, a ramp up to the guns, the powder magazine, a timber
// lookout tower and the flag. Everything static is merged per material (the island's shared
// materials plus the fort's own stone); the three guns are two instanced meshes (carriages and
// barrels) that turn, elevate and recoil.

import * as THREE from 'three';
import { staticBox, staticCylinder, type Ctx } from '../../context';
import { Batch, Batches, hipRoof, islandMaterials, litLevel, post, strip, type IslandMaterials, type V2 } from '../../island/kit';
import { NightLights } from '../../island/lights';
import { mulberry } from '../../random';
import { canvasTex, signMaterial, signTexture } from '../../textures';
import { BARREL, FORT, GUNS, fortToWorld } from './cannons-sim';
import { jollyRoger, sailMaterial } from './cannons-ships';

const DECK = FORT.deckY;
const FORT_RAD = THREE.MathUtils.degToRad(FORT.heading);
/** The battery: x −16..16, the sea wall's foot at z −11.2, its top edge at −10, the deck back to z 6. */
const BAT = { x: 16, front: -10, foot: -11.2, back: 6 };
/** The courtyard behind it: walls along x ±16 and z 32; the gate in the left (east-south-east) wall. */
const YARD = { back: 32, wall: 3.1, thick: 1, gate: { z0: 20, z1: 24 } };
const RAMP = { x0: 9.6, x1: 13.6, z0: 8, z1: 30 };
const MAG = { x0: -13.5, x1: -6, z0: 8, z1: 15.5 };
const TOWER = { x: -12, z: 28.5, h: 11.5 };
/** The embrasures' centres along the parapet, and their opening. */
const EMBRASURE_HALF = 1.15;

/** Coquina ashlar: courses of shell-stone blocks, porous and sea-stained. One tile = 3 m. */
function stoneCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const rnd = mulberry(61);
  g.fillStyle = '#b8ab8e';
  g.fillRect(0, 0, 512, 512);
  const course = 512 / 6;
  for (let row = 0; row < 6; row++) {
    const y = row * course;
    let x = -rnd() * 120;
    while (x < 512) {
      const w = 110 + rnd() * 120;
      const s = 0.88 + rnd() * 0.18;
      const warm = rnd() * 14;
      g.fillStyle = `rgb(${Math.round(222 * s + warm)},${Math.round(210 * s + warm * 0.6)},${Math.round(182 * s)})`;
      g.fillRect(x + 3, y + 3, w - 6, course - 6);
      // shell pits and fossil specks
      for (let i = 0; i < 70; i++) {
        g.fillStyle = `rgba(${rnd() < 0.5 ? '90,80,60' : '255,250,235'},${0.15 + rnd() * 0.3})`;
        const r = 0.8 + rnd() * 2.6;
        g.beginPath();
        g.arc(x + 4 + rnd() * (w - 8), y + 4 + rnd() * (course - 8), r, 0, Math.PI * 2);
        g.fill();
      }
      // a worn, darker lower edge to each block
      const grad = g.createLinearGradient(0, y + course * 0.55, 0, y + course - 3);
      grad.addColorStop(0, 'rgba(70,60,45,0)');
      grad.addColorStop(1, 'rgba(70,60,45,0.18)');
      g.fillStyle = grad;
      g.fillRect(x + 3, y + 3, w - 6, course - 6);
      x += w;
    }
  }
  // rain streaks and salt stains running down the wall
  for (let i = 0; i < 40; i++) {
    const x = rnd() * 512;
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, 'rgba(60,55,40,0.12)');
    grad.addColorStop(1, 'rgba(60,55,40,0)');
    g.fillStyle = grad;
    g.fillRect(x, rnd() * 300, 2 + rnd() * 8, 200 + rnd() * 300);
  }
  return c;
}

/** One gun's pose: bearing relative to straight out (radians, + to the right), elevation, recoil (0..1). */
export interface GunPose {
  yaw: number;
  elev: number;
  recoil: number;
}

/**
 * The fort's meshes and colliders, and the guns. Built in the fort's own frame; `group` stands at
 * `FORT` turned to face the sea.
 */
export class Fort {
  readonly group = new THREE.Group();
  readonly poses: GunPose[] = GUNS.map(() => ({ yaw: 0, elev: 0, recoil: 0 }));
  private carriages: THREE.InstancedMesh;
  private barrels: THREE.InstancedMesh;
  private lights: NightLights;
  private mats: IslandMaterials;
  private signMat: THREE.MeshStandardMaterial;
  private flag: THREE.Mesh;
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(private ctx: Ctx) {
    const tier = ctx.quality.tier;
    const lean = tier === 'low' || tier === 'lowest';
    this.mats = islandMaterials(ctx.renderer);
    this.group.position.set(FORT.x, 0, FORT.z);
    this.group.rotation.y = -FORT_RAD;
    const b = new Batches({ x: 0, y: 0, z: 0 });
    const stone = new Batch();
    this.lights = new NightLights({ x: 0, y: 0, z: 0 }, lean);
    this.battery(b, stone);
    this.courtyard(b, stone);
    this.props(b);
    this.approach(b);
    b.build(this.group, this.mats, this.mats.paint, ctx.quality.shadows, lean);
    const stoneTex = canvasTex(stoneCanvas(), ctx.renderer);
    stoneTex.wrapS = stoneTex.wrapT = THREE.RepeatWrapping;
    const stoneMat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: stoneTex, bumpMap: stoneTex, bumpScale: 1.4, roughness: 0.92 });
    const walls = stone.build(stoneMat, ctx.quality.shadows, ctx.quality.shadows);
    if (walls) this.group.add(walls);
    this.lights.build();
    this.group.add(this.lights.group);
    // the sign at the gate
    this.signMat = signMaterial(signTexture('PIRATE CANNONS', { sub: 'Fort Cutlass · sink the fleet · 60 s', border: '#a8321f', bg: '#f3e6c8' }), { emissiveIntensity: 0.4 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.72), this.signMat);
    sign.position.set(-19.6, 3.2, YARD.gate.z1 + 3.2);
    sign.rotation.y = -Math.PI / 2 + 0.35;
    sign.castShadow = ctx.quality.shadows;
    this.group.add(sign);
    // the Jolly Roger over the battery
    this.flag = new THREE.Mesh(jollyRoger(3.6, 2.3), sailMaterial());
    this.flag.position.set(-13, DECK + 10.4 - 2.3 / 2 - 0.2, 3);
    this.flag.castShadow = ctx.quality.shadows;
    this.group.add(this.flag);
    // the guns: carriages and barrels, one instanced mesh each
    this.carriages = this.instanced(this.carriageGeometry(), this.mats.timber);
    this.barrels = this.instanced(this.barrelGeometry(), this.mats.metal);
    this.pose();
    this.colliders();
    this.setNight(0);
  }

  private instanced(geo: THREE.BufferGeometry, mat: THREE.Material) {
    const im = new THREE.InstancedMesh(geo, mat, GUNS.length);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = this.ctx.quality.shadows;
    im.receiveShadow = this.ctx.quality.shadows;
    im.frustumCulled = false;
    this.group.add(im);
    return im;
  }

  /** A battered wall-prism: the profile (z, y) swept across x0..x1, into the stone batch. */
  private prism(stone: Batch, profile: [number, number][], x0: number, x1: number, color = '#ffffff') {
    const s = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(-z, y)));
    const g = new THREE.ExtrudeGeometry(s, { depth: x1 - x0, bevelEnabled: false }).rotateY(Math.PI / 2).translate(x0, 0, 0);
    stone.add(g, color, undefined, { box: 1 / 3 });
  }

  private box(batch: Batch, w: number, h: number, d: number, x: number, y: number, z: number, color = '#ffffff', yaw = 0) {
    batch.box(w, h, d, color, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw), this.one), { box: 1 / 3 });
  }

  /** The gun deck: the sea wall, the parapet and its embrasures, the sentry boxes, the paving and the gun platforms. */
  private battery(b: Batches, stone: Batch) {
    // the platform, its sea wall battered back like the old forts' (proof against shot)
    this.prism(stone, [[BAT.foot, 0], [BAT.front, DECK], [BAT.back, DECK], [BAT.back, 0]], -BAT.x - 1.2, BAT.x + 1.2);
    // a weathered plinth course and a cordon (the rounded moulding at deck level) along the face
    this.prism(stone, [[BAT.foot - 0.35, 0], [BAT.foot - 0.1, 0.7], [BAT.foot + 0.25, 0.7], [BAT.foot + 0.1, 0]], -BAT.x - 1.4, BAT.x + 1.4, '#cbbf9f');
    this.prism(stone, [[BAT.front - 0.35, DECK - 0.25], [BAT.front - 0.35, DECK + 0.05], [BAT.front + 0.2, DECK + 0.05], [BAT.front + 0.2, DECK - 0.25]], -BAT.x - 1.4, BAT.x + 1.4, '#e8dfc8');
    // the parapet: merlons between the three embrasures, low sills in the openings (splayed outwards)
    const pz0 = BAT.front + 0.05;
    const pz1 = BAT.front + 1.45;
    const ph = 1.25;
    const gaps = GUNS.map((g) => g.lx);
    const edges = [-BAT.x - 1.2, ...gaps.flatMap((x) => [x - EMBRASURE_HALF, x + EMBRASURE_HALF]), BAT.x + 1.2];
    for (let i = 0; i < edges.length; i += 2) {
      const xa = edges[i];
      const xb = edges[i + 1];
      // each merlon's cheeks splay, so the gun can traverse: a trapezoid seen from above
      const inner = i > 0 ? 0.55 : 0;
      const outer = i + 2 < edges.length ? 0.55 : 0;
      const s = new THREE.Shape([
        new THREE.Vector2(xa, -pz1),
        new THREE.Vector2(xb, -pz1),
        new THREE.Vector2(xb - outer, -pz0),
        new THREE.Vector2(xa + inner, -pz0),
      ]);
      const g = new THREE.ExtrudeGeometry(s, { depth: ph, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 1 })
        .rotateX(-Math.PI / 2)
        .translate(0, DECK, 0);
      stone.add(g, '#ffffff', undefined, { box: 1 / 3 });
    }
    for (const x of gaps) this.box(stone, EMBRASURE_HALF * 2 + 0.6, 0.55, pz1 - pz0, x, DECK + 0.275, (pz0 + pz1) / 2, '#e2d8c0');
    // the side parapets, back to the deck's rear edge
    for (const sx of [-1, 1]) this.box(stone, 1.2, 1.1, BAT.back - pz1, sx * (BAT.x + 0.6), DECK + 0.55, (BAT.back + pz1) / 2);
    // domed sentry boxes on corbels at the two seaward corners
    for (const sx of [-1, 1]) {
      const x = sx * (BAT.x + 0.4);
      const z = BAT.front + 0.4;
      const m = (y: number) => new THREE.Matrix4().makeTranslation(x, y, z);
      stone.add(new THREE.CylinderGeometry(1.15, 0.35, 1.5, 12).translate(0, -0.75, 0), '#e8dfc8', m(DECK + 0.3), { box: 1 / 3 });
      stone.add(post(1.05, 1.05, 2.4, 14), '#ffffff', m(DECK + 0.3), { box: 1 / 3 });
      stone.add(new THREE.CylinderGeometry(1.2, 1.2, 0.18, 14), '#e8dfc8', m(DECK + 2.7), { box: 1 / 3 });
      stone.add(new THREE.SphereGeometry(1.08, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#f2ead6', m(DECK + 2.79), { box: 1 / 3 });
      stone.add(new THREE.SphereGeometry(0.16, 8, 5), '#e8dfc8', m(DECK + 3.95), { box: 1 / 3 });
      // the lookout slits, dark
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k - 1) * 0.9 + (sx < 0 ? -0.3 : 0.3);
        b.paint.box(0.16, 0.7, 0.08, '#171310', new THREE.Matrix4().compose(new THREE.Vector3(x + Math.sin(a) * 1.05, DECK + 1.6, z - Math.cos(a) * 1.05), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -a), this.one));
      }
    }
    // the deck paving, and a timber platform with a traversing rail under each gun
    b.stone.add(new THREE.PlaneGeometry(BAT.x * 2, BAT.back - pz1).rotateX(-Math.PI / 2), '#e9dfca', new THREE.Matrix4().makeTranslation(0, DECK + 0.015, (BAT.back + pz1) / 2), { box: 0.42 });
    for (const g of GUNS) {
      b.deck.add(new THREE.CylinderGeometry(2.5, 2.5, 0.14, 24, 1, false, -Math.PI / 2 - 1.2, Math.PI + 2.4), '#c4a27a', new THREE.Matrix4().makeTranslation(g.lx, DECK + 0.07, g.lz + 0.7), { box: 0.5 });
      b.metal.add(new THREE.TorusGeometry(2.1, 0.05, 4, 32, Math.PI + 1.6).rotateX(Math.PI / 2).rotateY(Math.PI / 2 - 0.8), '#3b3530', new THREE.Matrix4().makeTranslation(g.lx, DECK + 0.15, g.lz + 0.7));
      // shot stacked in a pyramid beside each gun, and the rammer and sponge laid along the foot of
      // the parapet (stood up against it they would cross the gunner's view of the sea)
      for (let layer = 0, n = 3; n > 0; layer++, n--)
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++)
            b.metal.add(new THREE.SphereGeometry(0.12, 8, 6), '#26221f', new THREE.Matrix4().makeTranslation(g.lx + 2.4 + (i - (n - 1) / 2) * 0.24, DECK + 0.13 + layer * 0.19, g.lz + 1.6 + (j - (n - 1) / 2) * 0.24));
      for (const [dz, col] of [
        [1.75, '#b48a5a'],
        [1.95, '#8a6440'],
      ] as const)
        b.timber.add(post(0.04, 0.04, 3.3, 6), col, new THREE.Matrix4().compose(new THREE.Vector3(g.lx - 2.7, DECK + 0.05, BAT.front + dz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), this.one), { box: 2, grain: 'y' });
    }
    // the flagpole at the battery's back corner
    b.timber.add(post(0.12, 0.07, 10.6, 8), '#7a5a3a', new THREE.Matrix4().makeTranslation(-13, DECK, 3), { box: 2, grain: 'y' });
    b.metal.add(new THREE.SphereGeometry(0.16, 8, 6), '#c9a24e', new THREE.Matrix4().makeTranslation(-13, DECK + 10.7, 3));
    this.box(stone, 1.4, 0.5, 1.4, -13, DECK + 0.25, 3, '#e2d8c0');
    // torches at the back corners of the deck
    for (const sx of [-1, 1]) this.torch(b, sx * 14.6, BAT.back - 0.8, DECK);
  }

  /** The walled courtyard: curtain walls with crenels, the gate, the ramp, the magazine and the tower. */
  private courtyard(b: Batches, stone: Batch) {
    const h = YARD.wall;
    const t = YARD.thick;
    const wall = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      this.box(stone, t, h, len, cx, h / 2, cz, '#ffffff', yaw);
      // crenellations along the top
      const n = Math.floor(len / 1.6);
      for (let i = 0; i < n; i++) {
        const k = (i + 0.5) / n;
        this.box(stone, t + 0.04, 0.55, 0.8, x0 + (x1 - x0) * k, h + 0.27, z0 + (z1 - z0) * k, '#efe6d2', yaw);
      }
    };
    wall(-BAT.x - 0.5, BAT.back, -BAT.x - 0.5, YARD.gate.z0);
    wall(-BAT.x - 0.5, YARD.gate.z1, -BAT.x - 0.5, YARD.back);
    wall(BAT.x + 0.5, BAT.back, BAT.x + 0.5, YARD.back);
    wall(-BAT.x - 1, YARD.back, BAT.x + 1, YARD.back);
    // the gate: stout piers, an arched lintel, the doors swung open
    const gx = -BAT.x - 0.5;
    for (const z of [YARD.gate.z0 - 0.5, YARD.gate.z1 + 0.5]) {
      this.box(stone, 1.6, 4.4, 1.2, gx, 2.2, z, '#efe6d2');
      this.box(stone, 1.8, 0.3, 1.4, gx, 4.55, z, '#e2d8c0');
    }
    const arch = new THREE.Shape();
    const w = (YARD.gate.z1 - YARD.gate.z0) / 2 + 1;
    arch.moveTo(-w, 0);
    arch.lineTo(w, 0);
    arch.lineTo(w, 1.3);
    arch.lineTo(-w, 1.3);
    arch.lineTo(-w, 0);
    const hole = new THREE.Path();
    hole.absarc(0, 0, w - 1, 0, Math.PI, false);
    hole.lineTo(-(w - 1), 0);
    arch.holes.push(hole);
    const archGeo = new THREE.ExtrudeGeometry(arch, { depth: 1.2, bevelEnabled: false }).translate(0, 0, -0.6).rotateY(Math.PI / 2);
    stone.add(archGeo, '#efe6d2', new THREE.Matrix4().makeTranslation(gx, 3.1, (YARD.gate.z0 + YARD.gate.z1) / 2), { box: 1 / 3 });
    for (const [z, yaw] of [
      [YARD.gate.z0 + 0.1, -1.25],
      [YARD.gate.z1 - 0.1, 1.25 + Math.PI],
    ] as const) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(gx + 0.6, 0, z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw), this.one);
      b.timber.box(0.14, 3, 1.9, '#6b4a2e', m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 1.5, 0.95)), { box: 1, grain: 'y' });
      for (const y of [0.6, 2.4]) b.metal.box(0.18, 0.12, 1.9, '#2a2420', m.clone().multiply(new THREE.Matrix4().makeTranslation(0, y, 0.95)));
    }
    // the ramp up to the guns, along the inside of the right-hand wall
    this.prism(stone, [[RAMP.z1, 0], [RAMP.z0, DECK], [BAT.back, DECK], [BAT.back, 0]], RAMP.x0, RAMP.x1, '#efe6d2');
    b.stone.add(
      new THREE.PlaneGeometry(RAMP.x1 - RAMP.x0, Math.hypot(RAMP.z1 - RAMP.z0, DECK)).rotateX(-Math.PI / 2 + Math.atan2(DECK, RAMP.z1 - RAMP.z0)),
      '#e0d4bc',
      new THREE.Matrix4().makeTranslation((RAMP.x0 + RAMP.x1) / 2, DECK / 2 + 0.03, (RAMP.z0 + RAMP.z1) / 2),
      { box: 0.42 },
    );
    // a rope across its foot: crew only
    for (const x of [RAMP.x0 + 0.2, RAMP.x1 - 0.2]) b.timber.add(post(0.07, 0.06, 1, 6), '#8a6440', new THREE.Matrix4().makeTranslation(x, 0, RAMP.z1 + 0.6), { box: 2, grain: 'y' });
    b.fabric.box(RAMP.x1 - RAMP.x0 - 0.4, 0.05, 0.05, '#c22e1e', new THREE.Matrix4().makeTranslation((RAMP.x0 + RAMP.x1) / 2, 0.82, RAMP.z1 + 0.6));
    // the powder magazine: thick walls under a stone barrel vault, an iron-studded door
    const mw = MAG.x1 - MAG.x0;
    const md = MAG.z1 - MAG.z0;
    const mx = (MAG.x0 + MAG.x1) / 2;
    const mz = (MAG.z0 + MAG.z1) / 2;
    this.box(stone, mw, 3, md, mx, 1.5, mz, '#efe6d2');
    stone.add(new THREE.CylinderGeometry(mw / 2, mw / 2, md + 0.3, 16, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2).scale(1, 0.5, 1), '#e6dcc6', new THREE.Matrix4().makeTranslation(mx, 3, mz), { box: 1 / 3 });
    b.timber.box(0.12, 2.1, 1.3, '#5a3a22', new THREE.Matrix4().makeTranslation(MAG.x1 + 0.06, 1.05, mz), { box: 1, grain: 'y' });
    for (const y of [0.5, 1.6]) b.metal.box(0.16, 0.1, 1.3, '#2a2420', new THREE.Matrix4().makeTranslation(MAG.x1 + 0.1, y, mz));
    // the lookout tower: four tarred posts with braces, a platform, a palm-thatch roof and a ladder
    const T = TOWER;
    const half = 1.6;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) b.timber.add(post(0.17, 0.14, T.h + 2.6, 8), '#4e3a28', new THREE.Matrix4().makeTranslation(T.x + sx * half, 0, T.z + sz * half), { box: 2, grain: 'y' });
    for (const y of [3.2, 7.2]) {
      for (const sx of [-1, 1]) b.timber.box(0.12, 0.18, half * 2, '#5e4630', new THREE.Matrix4().makeTranslation(T.x + sx * half, y, T.z), { box: 1 });
      for (const sz of [-1, 1]) b.timber.box(half * 2, 0.18, 0.12, '#5e4630', new THREE.Matrix4().makeTranslation(T.x, y, T.z + sz * half), { box: 1 });
      // X braces on two faces
      for (const s of [-1, 1]) {
        const ln = Math.hypot(half * 2, 4);
        b.timber.box(0.1, ln, 0.1, '#5e4630', new THREE.Matrix4().compose(new THREE.Vector3(T.x, y - 2, T.z + half), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, s * Math.atan2(half * 2, 4))), this.one), { box: 1 });
        b.timber.box(0.1, ln, 0.1, '#5e4630', new THREE.Matrix4().compose(new THREE.Vector3(T.x + half, y - 2, T.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(s * Math.atan2(half * 2, 4), 0, 0)), this.one), { box: 1 });
      }
    }
    b.deck.box(half * 2 + 0.8, 0.16, half * 2 + 0.8, '#b8946a', new THREE.Matrix4().makeTranslation(T.x, T.h, T.z), { box: 0.5 });
    for (const sx of [-1, 1]) b.timber.box(0.08, 0.08, half * 2 + 0.8, '#6b4a2e', new THREE.Matrix4().makeTranslation(T.x + sx * (half + 0.4), T.h + 1, T.z), { box: 1 });
    for (const sz of [-1, 1]) b.timber.box(half * 2 + 0.8, 0.08, 0.08, '#6b4a2e', new THREE.Matrix4().makeTranslation(T.x, T.h + 1, T.z + sz * (half + 0.4)), { box: 1 });
    b.thatch.add(hipRoof(half * 2 + 1.8, half * 2 + 1.8, 1.9, 0.5, 0.3), '#d9bf8a', new THREE.Matrix4().makeTranslation(T.x, T.h + 2.6, T.z));
    for (let i = 0; i < 14; i++) b.timber.box(0.6, 0.06, 0.08, '#7a5a3a', new THREE.Matrix4().makeTranslation(T.x + half + 0.05, 0.4 + i * 0.8, T.z), { box: 1 });
    for (const sz of [-0.3, 0.3]) b.timber.box(0.08, T.h, 0.08, '#6b4a2e', new THREE.Matrix4().makeTranslation(T.x + half + 0.05, T.h / 2, T.z + sz), { box: 1 });
    // a ship's bell hanging under the lookout's roof, and a lantern
    b.metal.add(new THREE.CylinderGeometry(0.12, 0.22, 0.32, 10), '#c9a24e', new THREE.Matrix4().makeTranslation(T.x, T.h + 2.15, T.z));
    b.lit.add(new THREE.CylinderGeometry(0.14, 0.11, 0.36, 6), '#ffe1a8', new THREE.Matrix4().makeTranslation(T.x - half, T.h + 1.6, T.z - half));
    this.lights.addHalo(new THREE.Vector3(T.x - half, T.h + 1.6, T.z - half), '#ffb070', 1.2);
    // torches at the gate and in the yard
    this.torch(b, gx - 1.3, YARD.gate.z0 - 1.3);
    this.torch(b, gx - 1.3, YARD.gate.z1 + 1.3);
    this.torch(b, 0, YARD.back - 1.4);
  }

  /** Barrels, crates, a rack of muskets' worth of oars, and the treasure chest everyone stops to look at. */
  private props(b: Batches) {
    const rnd = mulberry(17);
    const barrel = (x: number, z: number, y = 0, lying = false) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y + (lying ? 0.42 : 0), z), new THREE.Quaternion().setFromEuler(new THREE.Euler(lying ? Math.PI / 2 : 0, rnd() * 3, 0)), this.one);
      b.timber.add(lying ? new THREE.CylinderGeometry(0.4, 0.4, 0.95, 12) : post(0.38, 0.38, 0.95, 12), '#7a4a26', m, { box: 1, grain: 'y' });
      for (const dy of lying ? [-0.3, 0.3] : [0.2, 0.75]) b.metal.add(lying ? new THREE.CylinderGeometry(0.42, 0.42, 0.06, 12).translate(0, dy, 0) : post(0.41, 0.41, 0.06, 12).translate(0, dy, 0), '#2a2420', m);
    };
    // powder kegs by the magazine door, and two on the deck behind the guns
    for (let i = 0; i < 5; i++) barrel(MAG.x1 + 1.2 + (i % 3) * 0.85, MAG.z0 + 0.8 + Math.floor(i / 3) * 0.9);
    barrel(MAG.x1 + 2, MAG.z0 + 2.8, 0, true);
    barrel(-4.6, BAT.back - 1.2, DECK);
    barrel(4.6, BAT.back - 1.2, DECK);
    // crates of shot and stores
    for (const [x, z, s] of [
      [6.5, 26, 1],
      [7.3, 27.2, 0.8],
      [-2, 30.6, 1.1],
    ] as const) {
      b.timber.box(1.1 * s, 0.9 * s, 0.9 * s, '#a07848', new THREE.Matrix4().makeTranslation(x, 0.45 * s, z), { box: 1 });
      b.timber.box(1.14 * s, 0.1, 0.94 * s, '#6b4a2e', new THREE.Matrix4().makeTranslation(x, 0.85 * s, z), { box: 1 });
    }
    // the treasure chest, open, gold heaped inside
    const cx = 2;
    const cz = 22;
    b.timber.box(1.3, 0.62, 0.8, '#6b3a1e', new THREE.Matrix4().makeTranslation(cx, 0.31, cz), { box: 1 });
    for (const dx of [-0.5, 0, 0.5]) b.metal.box(0.08, 0.66, 0.84, '#c9a24e', new THREE.Matrix4().makeTranslation(cx + dx, 0.32, cz));
    b.timber.box(1.3, 0.08, 0.8, '#6b3a1e', new THREE.Matrix4().compose(new THREE.Vector3(cx, 0.9, cz + 0.62), new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.15, 0, 0)), this.one), { box: 1 });
    for (let i = 0; i < 26; i++) {
      const x = cx + (rnd() - 0.5) * 1.1;
      const z = cz + (rnd() - 0.5) * 0.6;
      b.metal.add(new THREE.CylinderGeometry(0.06, 0.06, 0.015, 8), '#ffcf5a', new THREE.Matrix4().compose(new THREE.Vector3(x, 0.62 + rnd() * 0.14, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() - 0.5, 0, rnd() - 0.5)), this.one));
    }
    // a spare cannon barrel and its shot lying in the sand by the wall, and a coil of rope
    b.metal.add(this.barrelGeometry(), '#ffffff', new THREE.Matrix4().compose(new THREE.Vector3(12.2, 0.32, 31.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), this.one));
    b.fabric.add(new THREE.TorusGeometry(0.42, 0.11, 6, 16).rotateX(Math.PI / 2), '#cbb588', new THREE.Matrix4().makeTranslation(-3.5, 0.11, 26));
  }

  /** The boardwalk from the end of the island's beach boardwalk to the gate, with torches. */
  private approach(b: Batches) {
    // the beach path ends at (−312, 41398) in the world: bring it round to the gate in the fort's frame
    const toLocal = (x: number, z: number): V2 => {
      const dx = x - FORT.x;
      const dz = z - FORT.z;
      const c = Math.cos(FORT_RAD);
      const s = Math.sin(FORT_RAD);
      // the inverse of fortToWorld: right = (cos h, sin h), forward = (sin h, −cos h)
      return { x: dx * c + dz * s, z: -(dx * s - dz * c) };
    };
    const end = toLocal(-312, 41398);
    const gateMid = (YARD.gate.z0 + YARD.gate.z1) / 2;
    const pts: V2[] = [end, { x: (end.x - BAT.x - 6) / 2 - 6, z: (end.z + gateMid) / 2 + 4 }, { x: -BAT.x - 5, z: gateMid }, { x: -BAT.x + 1, z: gateMid }];
    b.deck.add(strip(pts, 3.2, 0.07, 0.5), '#d6b48a', new THREE.Matrix4().makeTranslation(pts[0].x, 0, pts[0].z));
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const c = pts[i];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const yaw = Math.atan2(-(c.x - a.x), -(c.z - a.z));
      for (const side of [-1, 1]) {
        const ox = Math.cos(yaw) * side * 1.66;
        const oz = -Math.sin(yaw) * side * 1.66;
        b.timber.box(0.12, 0.14, len + 0.1, '#8a6440', new THREE.Matrix4().compose(new THREE.Vector3((a.x + c.x) / 2 + ox, 0.05, (a.z + c.z) / 2 + oz), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw), this.one), { box: 1 });
      }
    }
    this.torch(b, pts[1].x + 2.2, pts[1].z);
    // the sign's two posts
    for (const dz of [-1.9, 1.9]) b.timber.add(post(0.1, 0.09, 4.2, 8), '#6b4a2e', new THREE.Matrix4().makeTranslation(-19.6 + Math.sin(0.35) * dz, 0, YARD.gate.z1 + 3.2 + Math.cos(0.35) * dz), { box: 2, grain: 'y' });
  }

  /** An iron cresset on a post: a flame at night. */
  private torch(b: Batches, x: number, z: number, y = 0) {
    b.timber.add(post(0.06, 0.05, 2.2, 6), '#4e3a28', new THREE.Matrix4().makeTranslation(x, y, z), { box: 2, grain: 'y' });
    b.metal.add(new THREE.CylinderGeometry(0.2, 0.1, 0.26, 8), '#2a2420', new THREE.Matrix4().makeTranslation(x, y + 2.3, z));
    this.lights.addFlame(new THREE.Vector3(x, y + 2.4, z), y);
  }

  /** A naval truck carriage: stepped cheeks on two axles and four trucks, its trunnion seats at the origin. */
  private carriageGeometry() {
    const k = new Batch();
    const wood = '#7a5232';
    const iron = '#2a2420';
    for (const sx of [-1, 1]) {
      // the cheek, stepped down towards the rear
      const s = new THREE.Shape([new THREE.Vector2(-0.95, -0.5), new THREE.Vector2(0.95, -0.5), new THREE.Vector2(0.95, -0.05), new THREE.Vector2(0.45, -0.05), new THREE.Vector2(0.45, -0.22), new THREE.Vector2(-0.1, -0.22), new THREE.Vector2(-0.1, 0.06), new THREE.Vector2(-0.95, 0.06)]);
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: false }).translate(0, 0, -0.08).rotateY(Math.PI / 2);
      k.add(g, wood, new THREE.Matrix4().makeTranslation(sx * 0.42, 0, 0), { box: 1 });
      k.add(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 10).rotateZ(Math.PI / 2), iron, new THREE.Matrix4().makeTranslation(sx * 0.52, 0, 0));
    }
    for (const z of [-0.65, 0.65]) {
      k.box(1.1, 0.16, 0.18, wood, new THREE.Matrix4().makeTranslation(0, -0.62, z), { box: 1 });
      for (const sx of [-1, 1]) k.add(new THREE.CylinderGeometry(0.26, 0.26, 0.12, 14).rotateZ(Math.PI / 2), '#5e4028', new THREE.Matrix4().makeTranslation(sx * 0.55, -0.6, z), { box: 1 });
    }
    k.box(0.7, 0.12, 1.6, wood, new THREE.Matrix4().makeTranslation(0, -0.45, 0), { box: 1 });
    // the quoin: the wedge under the breech that sets the elevation
    k.box(0.36, 0.14, 0.5, '#9a7048', new THREE.Matrix4().makeTranslation(0, -0.18, 0.75), { box: 1 });
    return this.geometryOf(k, this.mats.timber);
  }

  /** The gun: a cast-iron long gun with its reinforces, cascabel and muzzle swell, along −z from the trunnions. */
  private barrelGeometry() {
    const k = new Batch();
    const prof: THREE.Vector2[] = [];
    const add = (y: number, r: number) => prof.push(new THREE.Vector2(r, y));
    // from the muzzle (y = BARREL) back to the cascabel (y = −1.05), radii in metres
    add(BARREL, 0.075);
    add(BARREL, 0.19);
    add(BARREL - 0.12, 0.2);
    add(BARREL - 0.24, 0.16);
    add(BARREL - 0.4, 0.15);
    add(0.9, 0.19);
    add(0.86, 0.22);
    add(0.8, 0.205);
    add(-0.5, 0.25);
    add(-0.54, 0.27);
    add(-0.62, 0.27);
    add(-0.68, 0.24);
    add(-0.8, 0.2);
    add(-0.9, 0.11);
    add(-0.95, 0.06);
    add(-1.02, 0.09);
    add(-1.1, 0.07);
    add(-1.13, 0.0);
    prof.reverse();
    const g = new THREE.LatheGeometry(prof, 14).rotateX(-Math.PI / 2);
    k.add(g, '#2b2a2a');
    // the bore, black
    k.add(new THREE.CircleGeometry(0.075, 10), '#050505', new THREE.Matrix4().makeTranslation(0, 0, -BARREL + 0.002).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
    k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.62, 10).rotateZ(Math.PI / 2), '#2b2a2a');
    return this.geometryOf(k, this.mats.metal);
  }

  private geometryOf(k: Batch, mat: THREE.Material) {
    const mesh = k.build(mat, false, false)!;
    return mesh.geometry;
  }

  /** Writes the guns' poses into the instanced meshes. */
  pose() {
    GUNS.forEach((g, i) => {
      const p = this.poses[i];
      const back = p.recoil * 0.9;
      // the carriage turns on its platform and runs back with the recoil
      this.q.setFromEuler(this.e.set(0, -p.yaw, 0));
      this.v.set(0, 0, back).applyQuaternion(this.q);
      this.m.compose(this.v.add({ x: g.lx, y: g.y, z: g.lz }), this.q, this.one);
      this.carriages.setMatrixAt(i, this.m);
      // the barrel pivots on its trunnions
      this.m2.compose(this.v, this.q.setFromEuler(this.e.set(p.elev, -p.yaw, 0)), this.one);
      this.barrels.setMatrixAt(i, this.m2);
    });
    this.carriages.instanceMatrix.needsUpdate = true;
    this.barrels.instanceMatrix.needsUpdate = true;
  }

  setNight(k: number) {
    this.lights.setNight(k);
    this.mats.lit.color.setScalar(litLevel(k));
    this.signMat.emissiveIntensity = 0.35 + k * 1.1;
  }

  update(t: number) {
    this.lights.update(t);
  }

  /** Static colliders: the battery, the yard's walls (the gate open), the ramp, the magazine and the tower's legs. */
  private colliders() {
    const rot = -FORT_RAD;
    const p = { x: 0, z: 0 };
    const box = (x0: number, x1: number, z0: number, z1: number, h: number) => {
      fortToWorld((x0 + x1) / 2, (z0 + z1) / 2, p);
      staticBox(this.ctx, p.x, h / 2, p.z, (x1 - x0) / 2, h / 2, (z1 - z0) / 2, rot);
    };
    box(-BAT.x - 1.2, BAT.x + 1.2, BAT.foot, BAT.back, DECK + 1.2);
    const t = YARD.thick / 2 + 0.1;
    box(-BAT.x - 0.5 - t, -BAT.x - 0.5 + t, BAT.back, YARD.gate.z0 - 1.1, YARD.wall);
    box(-BAT.x - 0.5 - t, -BAT.x - 0.5 + t, YARD.gate.z1 + 1.1, YARD.back, YARD.wall);
    box(BAT.x + 0.5 - t, BAT.x + 0.5 + t, BAT.back, YARD.back, YARD.wall);
    box(-BAT.x - 1, BAT.x + 1, YARD.back - t, YARD.back + t, YARD.wall);
    box(RAMP.x0, RAMP.x1, BAT.back, RAMP.z1 + 0.8, DECK);
    box(MAG.x0, MAG.x1, MAG.z0, MAG.z1, 4.2);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        fortToWorld(TOWER.x + sx * 1.6, TOWER.z + sz * 1.6, p);
        staticCylinder(this.ctx, p.x, p.z, 0.22, TOWER.h);
      }
  }
}

/** Fort-frame points the game's cameras use. */
export const FORT_VIEWS = {
  /** Behind and above the middle gun, on the battery. */
  battery: { x: 0, y: DECK + 3.3, z: 7.8 },
  /** Up at the lookout tower, just out past the eave of its roof (inside, the thatch fills the view). */
  lookout: { x: TOWER.x + 0.4, y: TOWER.h + 2.2, z: TOWER.z - 3.2 },
  /** Outside the gate, facing it: where the visitor stands to play. */
  gate: { x: -BAT.x - 4.4, z: (YARD.gate.z0 + YARD.gate.z1) / 2 },
};
