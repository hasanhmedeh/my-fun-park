import * as THREE from 'three';
import { shadowed, staticBox, std, type Attraction, type Ctx } from '../context';
import { LAYOUT, type Zone } from '../layout';
import { mulberry } from '../random';
import { canvasTex, hdr, PALETTE, signMaterial, signTexture, stripeTexture } from '../textures';

// The changing room: a little fairground cubicle on the lawn beside Rosa's Ticket Booth, where the
// visitor changes who they are and what they wear (world/customiser.ts). Painted boards in the
// booth's teal on a wooden deck, a candy-striped roof, a striped curtain drawn back to one side,
// a tall mirror on a stand, a shirt left on a hook, and a warm glow inside (its cream walls glow a
// little, as the booth's do: no lights of its own). Its open front faces south-west, across the
// entrance plaza towards the gate, so it's seen on the way in.
//
// In its own frame the front is +z and the visitor's right, looking in, is +x.

/**
 * Where it stands: on the lawn east of the booth (just outside the plaza's garland), clear of the
 * booth's ring and queue, the SkyLink station and the grove beyond. `yaw` turns its front (+z)
 * towards the south-west.
 */
export const CHANGING_ROOM = { x: LAYOUT.booth.x + 6, z: LAYOUT.booth.z + 0.5, yaw: -Math.PI / 4 };

/** Outside: width (x), depth (z), the walls' height, and how thick they are. */
const W = 1.9;
const D = 1.6;
const H = 2.35;
const T = 0.05;
/**
 * The deck's top, above the lawn. Nearly flush: the visitor's physics stand them on the ground, so
 * a deck any higher would swallow their shoes (the very thing they've come in to dye).
 */
const DECK = 0.02;
/** Where the visitor stands inside (own frame): a little left of centre, clear of the mirror. */
const STAND = new THREE.Vector3(-0.1, 0, 0.05);

/** The prompt ring's centre (own frame) and radius: a worn patch of lawn in front of the opening. */
const APRON = { z: D / 2 + 1.45, r: 1.4 };
/**
 * The stepping stones (own frame): from the deck's edge out to the entrance plaza, passing east of
 * the end of the booth's queue. Their far end is about (14.6, 46.5) in the world, at the plaza's
 * edge.
 */
const PATH = { from: new THREE.Vector2(0, 1.2), to: new THREE.Vector2(0.75, 7.7) };

/**
 * True on the cubicle's deck, the worn patch in front of it, or its stepping stones, grown by
 * `margin`. For the lawn (environment.ts's grass growth leaves these bare, as it does the museum
 * with `onMuseum`): the tufts are half a metre tall, and would come up through the floor and hide
 * the stones and the prompt ring.
 */
export function onChangingRoom(x: number, z: number, margin = 0) {
  const dx = x - CHANGING_ROOM.x;
  const dz = z - CHANGING_ROOM.z;
  const c = Math.cos(CHANGING_ROOM.yaw);
  const s = Math.sin(CHANGING_ROOM.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  if (Math.abs(lx) < (W + 0.12) / 2 + margin && Math.abs(lz) < (D + 0.12) / 2 + margin) return true;
  if (Math.hypot(lx, lz - APRON.z) < APRON.r + margin) return true;
  // the stones: near the line between the path's ends
  const ax = PATH.to.x - PATH.from.x;
  const az = PATH.to.y - PATH.from.y;
  const k = THREE.MathUtils.clamp(((lx - PATH.from.x) * ax + (lz - PATH.from.y) * az) / (ax * ax + az * az), 0, 1);
  return Math.hypot(lx - PATH.from.x - ax * k, lz - PATH.from.y - az * k) < 0.42 + margin;
}

export class ChangingRoom implements Attraction {
  readonly root = new THREE.Group();
  /** Where the visitor stands inside (world): y is the deck's top, 2 cm above the lawn. */
  readonly standAt: THREE.Vector3;
  /** The heading (as ZONES' and the player's: 0 faces north, -z) of a visitor standing there, facing out. */
  readonly facing: number;
  /** The customiser's camera on a wide screen: in front, a little to the right, the whole visitor in frame. */
  readonly cameraAt: THREE.Vector3;
  readonly lookAt: THREE.Vector3;
  /**
   * The ring in front of the curtain, for ZONES (layout.ts): step in and press E. Its heading faces
   * the visitor into the cubicle.
   */
  readonly zone: Zone;
  private flag: THREE.Object3D;
  private curtain: THREE.Object3D;

  constructor(ctx: Ctx) {
    const { x, z, yaw } = CHANGING_ROOM;
    const root = this.root;
    root.position.set(x, 0, z);
    root.rotation.y = yaw;
    root.name = 'changing-room';
    const world = (lx: number, ly: number, lz: number) => root.localToWorld(new THREE.Vector3(lx, ly, lz));
    root.updateMatrixWorld();

    const boards = boardTexture(PALETTE.teal);
    const teal = std('#ffffff', { map: boards, roughness: 0.7 });
    // the inside is cream and glows warmly, like the booth's
    const inside = std('#fff1d6', { roughness: 0.9, emissive: '#ffb46b', emissiveIntensity: 0.22 });
    const wood = std('#b98a5a', { roughness: 0.8, map: deckTexture() });
    const trim = std(PALETTE.cream, { roughness: 0.6 });
    const brass = std('#d8a940', { metalness: 0.85, roughness: 0.3 });
    const box = (w: number, h: number, d: number, px: number, py: number, pz: number, m: THREE.Material, parent: THREE.Object3D = root) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(px, py, pz);
      parent.add(b);
      return b;
    };

    // the deck (a thick one sunk into the lawn: only its top two centimetres show), and the shell:
    // back and sides of painted boards (the front stays open)
    box(W + 0.12, 0.08, D + 0.12, 0, DECK - 0.04, 0, wood);
    box(W, H, T, 0, DECK + H / 2, -D / 2 + T / 2, teal);
    for (const s of [-1, 1]) box(T, H, D, s * (W / 2 - T / 2), DECK + H / 2, 0, teal);
    // the warm inside faces
    box(W - 2 * T, H - 0.02, 0.01, 0, DECK + H / 2, -D / 2 + T + 0.005, inside);
    for (const s of [-1, 1]) box(0.01, H - 0.02, D - T, s * (W / 2 - T - 0.005), DECK + H / 2, T / 2, inside);
    box(W - 2 * T, 0.01, D - T, 0, DECK + H - 0.06, T / 2, inside);
    // corner posts in cream, and a fascia over the opening
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.1, H + 0.06, 0.1, sx * (W / 2 - 0.02), DECK + (H + 0.06) / 2, sz * (D / 2 - 0.02), trim);
    box(W, 0.26, 0.06, 0, DECK + H - 0.13, D / 2 - 0.02, teal);
    box(W + 0.02, 0.05, 0.08, 0, DECK + H - 0.28, D / 2 - 0.02, trim);
    // a skirting rail round the outside, just above the deck
    box(W + 0.02, 0.1, 0.03, 0, DECK + 0.08, -D / 2 - 0.005, trim);
    for (const s of [-1, 1]) box(0.03, 0.1, D, s * (W / 2 + 0.005), DECK + 0.08, 0, trim);

    // the roof: a slab, and a candy-striped pyramid like the booth's
    box(W + 0.22, 0.08, D + 0.22, 0, DECK + H + 0.04, 0, std(PALETTE.teal, { roughness: 0.6 }));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.SQRT2, 0.72, 4, 1), std('#ffffff', { map: stripeTexture(PALETTE.candy, PALETTE.cream, 8) }));
    roof.rotation.y = Math.PI / 4;
    roof.scale.set((W + 0.3) / 2, 1, (D + 0.3) / 2);
    roof.position.y = DECK + H + 0.08 + 0.36;
    root.add(roof);
    // a pennant on top
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55), brass);
    pole.position.y = DECK + H + 0.08 + 0.72 + 0.22;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), brass);
    ball.position.y = pole.position.y + 0.29;
    this.flag = new THREE.Group();
    const pennant = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.34, 3), std(PALETTE.mustard, { roughness: 0.7 }));
    pennant.rotation.z = -Math.PI / 2;
    pennant.position.x = 0.17;
    this.flag.add(pennant);
    this.flag.position.y = pole.position.y + 0.17;
    root.add(pole, ball, this.flag);

    // the sign over the opening
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.6),
      signMaterial(signTexture('CHANGING ROOM', { sub: 'New look? Step inside', border: PALETTE.teal, width: 1024, height: 360 })),
    );
    sign.position.set(0, DECK + H + 0.42, D / 2 + 0.16);
    sign.rotation.x = -0.18;
    root.add(sign);

    // a little lamp under the roof: a bright bulb in a brass shade (it blooms; it lights nothing)
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.09, 16, 1, true), std('#2c2433', { metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide }));
    shade.position.set(0, DECK + H - 0.13, -0.15);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: hdr('#ffd59a', 6) }));
    bulb.position.set(0, DECK + H - 0.19, -0.15);
    root.add(shade, bulb);

    this.curtain = this.buildCurtain(brass);
    root.add(this.curtain);
    root.add(this.buildMirror(brass));
    root.add(this.buildHook(brass));
    root.add(buildStones());

    shadowed(root, true);
    // the roof mustn't plunge the inside into shade: the visitor has to be seen in there
    roof.castShadow = false;
    sign.castShadow = false;
    bulb.castShadow = false;
    ctx.scene.add(root);

    // walls only: the front is open
    const wall = (lx: number, lz: number, hx: number, hz: number) => {
      const c = world(lx, 0, lz);
      staticBox(ctx, c.x, DECK + H / 2, c.z, hx, H / 2, hz, yaw);
    };
    wall(0, -D / 2 + T / 2, W / 2, T / 2 + 0.02);
    for (const s of [-1, 1]) wall(s * (W / 2 - T / 2), 0, T / 2 + 0.02, D / 2);

    this.standAt = world(STAND.x, DECK, STAND.z);
    this.facing = wrap(yaw + Math.PI);
    // far enough back that the posts, the sign's edge and the lawn frame the visitor: it reads as
    // the cubicle on the fairground, not as being shut in a cupboard with them
    this.cameraAt = world(0.55, 1.62, 4.25);
    this.lookAt = world(STAND.x, 1.0, STAND.z);
    const ring = world(0, 0, APRON.z);
    this.zone = { x: ring.x, z: ring.z, radius: APRON.r, title: 'Changing room', action: 'Change your look', heading: wrap(yaw) };
  }

  /**
   * The customiser's camera: in front of the opening with the whole visitor in frame. On a
   * portrait screen the panel takes the bottom half, so the camera stands back to fit the visitor
   * in the top half.
   */
  shot(portrait = false) {
    if (!portrait) return { pos: this.cameraAt.clone(), look: this.lookAt.clone() };
    return { pos: this.root.localToWorld(new THREE.Vector3(0.35, 1.6, 5.4)), look: this.lookAt.clone() };
  }

  update(_dt: number, t: number) {
    this.flag.rotation.y = Math.sin(t * 2.7) * 0.35;
    // the curtain stirs in the breeze
    this.curtain.rotation.x = Math.sin(t * 1.3) * 0.012;
  }

  /**
   * The curtain, drawn back to the left and caught in a tie-back: a pleated sheet in candy and
   * cream stripes, gathered narrow at the tie and fanning out above and below it, on rings along a
   * brass rail.
   */
  private buildCurtain(brass: THREE.Material) {
    const g = new THREE.Group();
    const top = DECK + H - 0.32;
    const bottom = DECK + 0.06;
    const left = -W / 2 + 0.08;
    const zc = D / 2 - 0.1;
    // the rail, the whole width of the opening
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, W - 0.12), brass);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, top + 0.03, zc);
    g.add(rail);
    const tie = 0.47; // how far down the tie-back is (0 top, 1 bottom)
    const widthAt = (v: number) => {
      // full at the top, pinched at the tie, flaring a little to the hem
      const k = v < tie ? v / tie : (v - tie) / (1 - tie);
      return v < tie ? THREE.MathUtils.lerp(0.42, 0.17, Math.sin((k * Math.PI) / 2)) : THREE.MathUtils.lerp(0.17, 0.33, 1 - Math.cos((k * Math.PI) / 2));
    };
    const folds = 7;
    const geo = new THREE.PlaneGeometry(1, 1, 42, 30);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i);
      const v = 1 - uv.getY(i);
      const w = widthAt(v);
      // the narrower the cloth is gathered, the deeper its folds
      const amp = 0.028 * Math.min(2.2, 0.42 / w);
      pos.setXYZ(i, left + u * w, top - v * (top - bottom), zc + Math.sin(u * folds * Math.PI * 2) * amp + (v > tie ? (v - tie) * 0.06 : 0));
    }
    geo.computeVertexNormals();
    const stripes = stripeTexture(PALETTE.candy, PALETTE.cream, 8);
    stripes.repeat.set(1.75, 1);
    const cloth = new THREE.Mesh(geo, std('#ffffff', { map: stripes, roughness: 0.92, side: THREE.DoubleSide }));
    g.add(cloth);
    // the tie-back: a mustard cord round the gathered cloth, with a tassel
    const tieY = top - tie * (top - bottom);
    const cord = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.016, 8, 24), std(PALETTE.mustard, { roughness: 0.8 }));
    // tipped towards the front, so from outside it reads as a loop round the cloth, not a bar
    cord.rotation.set(Math.PI / 2 - 0.45, 0, 0.12);
    cord.scale.set(1, 0.55, 1);
    cord.position.set(left + 0.085, tieY, zc);
    const tassel = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 8), std(PALETTE.mustard, { roughness: 0.85 }));
    tassel.position.set(left + 0.17, tieY - 0.08, zc + 0.04);
    g.add(cord, tassel);
    // rings on the rail over the bunched cloth, and a couple left out across the opening
    const ringGeo = new THREE.TorusGeometry(0.026, 0.006, 6, 14);
    for (const rx of [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.9, 1.35]) {
      const r = new THREE.Mesh(ringGeo, brass);
      r.position.set(left + rx, top + 0.03, zc);
      g.add(r);
    }
    return g;
  }

  /** A tall arched mirror on a wooden stand in the back right corner, turned to the middle of the cubicle. */
  private buildMirror(brass: THREE.Material) {
    const g = new THREE.Group();
    const w = 0.48;
    const h = 1.42;
    const arch = (hw: number, hh: number) => {
      const s = new THREE.Shape();
      s.moveTo(-hw, -hh);
      s.lineTo(hw, -hh);
      s.lineTo(hw, hh - hw);
      s.absarc(0, hh - hw, hw, 0, Math.PI, false);
      s.lineTo(-hw, -hh);
      return s;
    };
    const glassShape = arch(w / 2, h / 2);
    const glass = new THREE.Mesh(
      new THREE.ShapeGeometry(glassShape, 24),
      new THREE.MeshStandardMaterial({ color: '#dfe9ef', metalness: 1, roughness: 0.05, emissive: '#ffffff', emissiveMap: sheenTexture(), emissiveIntensity: 0.32 }),
    );
    // the glass's UVs run over its own shape: map them to 0..1 for the sheen
    const uv = glass.geometry.attributes.uv;
    const p = glass.geometry.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
    glass.position.z = 0.012;
    const frameShape = arch(w / 2 + 0.045, h / 2 + 0.045);
    frameShape.holes.push(arch(w / 2, h / 2));
    const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(frameShape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 24 }), brass);
    const back = new THREE.Mesh(new THREE.ShapeGeometry(arch(w / 2 + 0.04, h / 2 + 0.04), 24), std('#5a3d2b', { roughness: 0.8 }));
    back.position.z = -0.004;
    back.rotation.y = Math.PI;
    const mirror = new THREE.Group();
    mirror.add(glass, frame, back);
    mirror.position.y = 0.32 + h / 2;
    mirror.rotation.x = -0.05; // tipped back a touch, as cheval mirrors are
    // the stand: two uprights and their feet, in dark wood
    const woodDark = std('#5a3d2b', { roughness: 0.75 });
    for (const s of [-1, 1]) {
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.3, 0.04), woodDark);
      up.position.set(s * (w / 2 + 0.08), 0.65 + DECK, -0.02);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.36), woodDark);
      foot.position.set(s * (w / 2 + 0.08), DECK + 0.02, -0.02);
      const pin = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), brass);
      pin.position.set(s * (w / 2 + 0.055), mirror.position.y, 0);
      g.add(up, foot, pin);
    }
    g.add(mirror);
    // (turned, the stand's back foot reaches 0.36 m behind the group and its corner 0.4 m to the
    // right: these keep both inside the walls)
    g.position.set(W / 2 - 0.46, 0, -D / 2 + 0.45);
    // turned to face the middle of the cubicle (and so, past the visitor, the way out)
    g.rotation.y = -0.62;
    return g;
  }

  /** A brass hook on the back wall with a T-shirt left hanging on it. */
  private buildHook(brass: THREE.Material) {
    const g = new THREE.Group();
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.007, 6, 16, Math.PI * 1.3), brass);
    hook.rotation.z = Math.PI * 0.85;
    hook.position.set(0, 0, 0.04);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.01), brass);
    // a T-shirt's outline, hung from its neck
    const s = new THREE.Shape();
    s.moveTo(-0.05, 0);
    s.lineTo(-0.15, -0.03);
    s.lineTo(-0.25, -0.15);
    s.lineTo(-0.2, -0.21);
    s.lineTo(-0.14, -0.15);
    s.lineTo(-0.15, -0.58);
    s.lineTo(0.15, -0.58);
    s.lineTo(0.14, -0.15);
    s.lineTo(0.2, -0.21);
    s.lineTo(0.25, -0.15);
    s.lineTo(0.15, -0.03);
    s.lineTo(0.05, 0);
    s.quadraticCurveTo(0, -0.05, -0.05, 0);
    const shirt = new THREE.Mesh(
      new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2 }),
      std(PALETTE.violet, { roughness: 0.95 }),
    );
    shirt.position.set(0, -0.015, 0.012);
    shirt.rotation.z = 0.08;
    // a star on its front (the fair's merchandise, of course)
    const points = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.024 : 0.058;
      const a = Math.PI / 2 + (i * Math.PI) / 5;
      if (i) points.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      else points.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const star = new THREE.Mesh(new THREE.ShapeGeometry(points), std(PALETTE.mustard, { roughness: 0.8 }));
    star.position.set(0.0, -0.26, 0.058);
    shirt.add(star);
    g.add(plate, hook, shirt);
    g.position.set(-W / 2 + 0.42, DECK + 1.82, -D / 2 + T + 0.012);
    return g;
  }
}

/** An angle in (-π, π]. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Flat stepping stones across the lawn from the plaza to the opening (PATH), staggered a little
 * either side of the line as if laid by hand. Pale, so they read from the plaza as the way in.
 */
function buildStones() {
  const rnd = mulberry(23);
  const along = PATH.to.clone().sub(PATH.from);
  const length = along.length();
  const side = new THREE.Vector2(along.y, -along.x).normalize();
  const n = Math.round(length / 0.6);
  const geo = new THREE.CylinderGeometry(1, 1.06, 1, 9);
  const stones = new THREE.InstancedMesh(geo, std('#ffffff', { roughness: 0.95 }), n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const colour = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const at = PATH.from.clone().addScaledVector(along, t).addScaledVector(side, (i % 2 ? 1 : -1) * (0.07 + rnd() * 0.05));
    const r = 0.2 + rnd() * 0.06;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI);
    m.compose(new THREE.Vector3(at.x, 0.02, at.y), q, new THREE.Vector3(r * (1.1 + rnd() * 0.25), 0.045, r));
    stones.setMatrixAt(i, m);
    stones.setColorAt(i, colour.set('#cdbfa6').offsetHSL(0, 0, (rnd() - 0.5) * 0.08));
  }
  stones.computeBoundingSphere();
  return stones;
}

/** Painted tongue-and-groove boards: the colour, upright grooves, and a little brushed grain. */
function boardTexture(colour: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = colour;
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry(7);
  for (let i = 0; i < 140; i++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.025 + rnd() * 0.035})` : `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
    g.fillRect(rnd() * 256, 0, 1 + rnd() * 2, 256);
  }
  for (let i = 0; i < 8; i++) {
    g.fillStyle = 'rgba(10,40,40,0.35)';
    g.fillRect(i * 32, 0, 2, 256);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(i * 32 + 2, 0, 1, 256);
  }
  const tex = canvasTex(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** The deck's planks, running front to back. */
function deckTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  const rnd = mulberry(3);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = `rgba(90,60,30,${0.05 + rnd() * 0.1})`;
    g.fillRect(i * 16, 0, 16, 128);
    g.fillStyle = 'rgba(60,35,15,0.45)';
    g.fillRect(i * 16, 0, 1, 128);
  }
  return canvasTex(c);
}

/** A mirror's sheen: a soft gradient with two pale diagonal streaks, so it reads as glass in any light. */
function sheenTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 192;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 192);
  grad.addColorStop(0, '#8fa6b8');
  grad.addColorStop(0.55, '#5f7487');
  grad.addColorStop(1, '#46566a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 192);
  g.globalAlpha = 0.5;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(10, 192);
  g.lineTo(30, 192);
  g.lineTo(64, 70);
  g.lineTo(64, 40);
  g.closePath();
  g.fill();
  g.globalAlpha = 0.28;
  g.beginPath();
  g.moveTo(36, 192);
  g.lineTo(44, 192);
  g.lineTo(64, 120);
  g.lineTo(64, 100);
  g.closePath();
  g.fill();
  return canvasTex(c);
}
