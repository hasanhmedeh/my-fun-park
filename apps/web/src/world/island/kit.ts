// The building kit shared by Palm Cay's beach park (island.ts) and its terminal
// (island-terminal.ts): a geometry batcher that merges everything static into one mesh per
// material (so a whole hut, a whole boardwalk or the whole terminal roof costs one draw call),
// the handful of shared materials and their painted textures (thatch, tropical hardwood,
// decking, coral-stone pavers, water), a sign atlas, and small geometry helpers.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry } from '../random';
import { BODY_FONT, canvasTex, DISPLAY_FONT } from '../textures';

export interface V2 {
  x: number;
  z: number;
}
export interface WalkRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

// ------------------------------------------------------------------------------------------------
// Batching
// ------------------------------------------------------------------------------------------------

/**
 * How a part's texture coordinates are made. `keep` uses the geometry's own; `box` projects world
 * metres onto the face's two widest axes (so a 12 m beam and a 0.3 m peg share one grain scale),
 * with the grain running along the part's longest side unless `grain` says otherwise.
 */
export type UvMode = 'keep' | { box: number; grain?: 'x' | 'y' | 'z' };

/** Per-vertex colour adjustment in world space (shading a trunk darker at the root, and so on). */
export type Tint = (x: number, y: number, z: number, c: THREE.Color) => void;

const KEEP = new Set(['position', 'normal', 'uv']);
const tmpC = new THREE.Color();

/**
 * Collects static parts for one material and merges them into a single mesh. Parts are placed in
 * world metres but stored relative to `origin` (where the batch's mesh will stand): float32
 * vertex positions 41 km from the world's origin are only good to ~4 mm, enough to make stacked
 * decals shimmer.
 */
export class Batch {
  private parts: THREE.BufferGeometry[] = [];
  private verts = 0;
  private readonly origin: THREE.Vector3;
  private readonly shift: THREE.Matrix4;

  constructor(origin: THREE.Vector3Like = { x: 0, y: 0, z: 0 }) {
    this.origin = new THREE.Vector3().copy(origin);
    this.shift = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
  }

  get count() {
    return this.verts;
  }

  /** Takes over another batch's parts (same origin), their colours multiplied by `tint` if given. */
  absorb(other: Batch, tint?: THREE.ColorRepresentation) {
    const c = tint === undefined ? null : new THREE.Color(tint);
    for (const g of other.parts) {
      if (c) {
        const col = g.attributes.color as THREE.BufferAttribute;
        for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * c.r, col.getY(i) * c.g, col.getZ(i) * c.b);
      }
      this.parts.push(g);
    }
    this.verts += other.verts;
    other.parts = [];
    other.verts = 0;
  }

  /**
   * Adds a copy of `geo`, moved by `m` (world metres), painted `color` (multiplied with the
   * material's map). `box` texture coordinates are projected in metres from the origin, so
   * neighbouring parts' grain and paving line up; `tint` gets each vertex's world position.
   */
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m?: THREE.Matrix4, uv: UvMode = 'keep', tint?: Tint) {
    const g = geo.clone();
    if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
    for (const k of Object.keys(g.attributes)) if (!KEEP.has(k)) g.deleteAttribute(k);
    g.morphAttributes = {};
    g.clearGroups();
    if (!g.attributes.normal) g.computeVertexNormals();
    // one float64 product, then a single store: positions arrive relative to the origin, at full precision
    g.applyMatrix4(m ? M3.multiplyMatrices(this.shift, m) : this.shift);
    const n = g.attributes.position.count;
    if (!g.attributes.uv || uv !== 'keep') g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    if (uv !== 'keep') boxUv(g, uv.box, uv.grain);
    const col = new Float32Array(n * 3);
    const base = new THREE.Color(color);
    const o = this.origin;
    const p = g.attributes.position;
    for (let i = 0; i < n; i++) {
      tmpC.copy(base);
      if (tint) tint(p.getX(i) + o.x, p.getY(i) + o.y, p.getZ(i) + o.z, tmpC);
      col[i * 3] = tmpC.r;
      col[i * 3 + 1] = tmpC.g;
      col[i * 3 + 2] = tmpC.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
    this.verts += n;
  }

  /** A w × h × d box whose centre `m` places (see `at`). */
  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, m: THREE.Matrix4, uv: UvMode = { box: 1 }) {
    this.add(unitBox(), color, M2.multiplyMatrices(m, S.makeScale(w, h, d)), uv);
  }

  /**
   * Merges everything added so far into one mesh, standing at the origin (null when empty).
   *
   * With `cell` (metres; only where the GPU can multi-draw, see flora.ts's `canMultiDraw`) it is a
   * BatchedMesh instead: the parts are sorted into square cells of that size on the ground (a part
   * longer than a cell gets one of its own), and three culls each cell against the camera's view
   * and the shadow camera's. Still one draw call per pass, but only what's in view (or in the
   * sun's shadow box, ~100 m across) is drawn, not the whole park. Small parts are kept in cells of
   * their own by size, and `update` hides those cells once the parts in them would be under a
   * couple of pixels (FINE_CULL).
   */
  build(material: THREE.Material, cast = true, receive = true, cell = 0): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const geo = cell > 0 ? null : mergeGeometries(this.parts, false)!;
    const mesh = geo ? new THREE.Mesh(geo, material) : this.cells(material, cell);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    this.verts = 0;
    geo?.computeBoundingSphere();
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.position.copy(this.origin);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /** The parts merged per ground cell and size class, one BatchedMesh instance each (see `build`). */
  private cells(material: THREE.Material, cell: number) {
    const buckets = new Map<string, { parts: THREE.BufferGeometry[]; size: number }>();
    const box = new THREE.Box3();
    const ext = new THREE.Vector3();
    let big = 0;
    for (const p of this.parts) {
      box.setFromBufferAttribute(p.attributes.position as THREE.BufferAttribute);
      box.getSize(ext);
      const size = FINE_CULL.findIndex(([s]) => Math.max(ext.x, ext.y, ext.z) < s);
      const key =
        ext.x > cell || ext.z > cell
          ? `big${big++}`
          : `${Math.floor((box.min.x + box.max.x) / 2 / cell)},${Math.floor((box.min.z + box.max.z) / 2 / cell)},${size}`;
      const b = buckets.get(key);
      if (b) b.parts.push(p);
      else buckets.set(key, { parts: [p], size });
    }
    const list = [...buckets.values()];
    const geos = list.map((b) => (b.parts.length === 1 ? b.parts[0] : mergeGeometries(b.parts, false)!));
    let verts = 0;
    let index = 0;
    for (const g of geos) {
      verts += g.attributes.position.count;
      index += g.index!.count;
    }
    const mesh = new THREE.BatchedMesh(geos.length, verts, index, material);
    const fine: number[] = [];
    const sphere = new THREE.Sphere();
    geos.forEach((g, i) => {
      const gid = mesh.addGeometry(g);
      const id = mesh.addInstance(gid);
      const size = list[i].size;
      if (size < 0) return;
      // the cell's middle, and the distance past which it's hidden
      mesh.getBoundingSphereAt(gid, sphere);
      fine.push(id, sphere.center.x, sphere.center.y, sphere.center.z, (FINE_CULL[size][1] + sphere.radius) ** 2);
    });
    for (const g of geos) g.dispose();
    mesh.computeBoundingSphere();
    if (fine.length) this.fine.push({ mesh, cells: Float32Array.from(fine), shown: new Uint8Array(fine.length / 5).fill(1) });
    return mesh;
  }

  /** Hides the small parts' cells that are too far off to see (call when the camera has moved; positions relative to the origin). */
  cull(cx: number, cy: number, cz: number) {
    for (const f of this.fine) {
      const c = f.cells;
      for (let i = 0, j = 0; i < c.length; i += 5, j++) {
        const dx = c[i + 1] - cx;
        const dy = c[i + 2] - cy;
        const dz = c[i + 3] - cz;
        const show = dx * dx + dy * dy + dz * dz < c[i + 4] ? 1 : 0;
        if (show === f.shown[j]) continue;
        f.shown[j] = show;
        f.mesh.setVisibleAt(c[i], show === 1);
      }
    }
  }

  private fine: { mesh: THREE.BatchedMesh; cells: Float32Array; shown: Uint8Array }[] = [];
}

/**
 * Size classes of small parts (largest dimension under the first number, m) and how far off
 * their cells are still drawn (m): about where such a part shrinks under two pixels at 720p and
 * a 50° view. Anything bigger is always drawn.
 */
const FINE_CULL: [number, number][] = [
  [0.45, 230],
  [1.1, 520],
];

const M2 = new THREE.Matrix4();
const M3 = new THREE.Matrix4();
const S = new THREE.Matrix4();
let UNIT_BOX: THREE.BufferGeometry | null = null;
const unitBox = () => (UNIT_BOX ??= new THREE.BoxGeometry(1, 1, 1));

/**
 * Metre texture coordinates projected along each face's dominant normal axis, measured from the
 * batch's origin (small numbers, so float32 UVs keep their precision).
 */
function boxUv(g: THREE.BufferGeometry, scale: number, grain?: 'x' | 'y' | 'z') {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const size = bb.getSize(new THREE.Vector3());
  const along = grain ?? (size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z');
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const ax = { x: 0, y: 1, z: 2 } as const;
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i), p.getY(i), p.getZ(i)];
    const an = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const dom = an[0] >= an[1] && an[0] >= an[2] ? 0 : an[1] >= an[2] ? 1 : 2;
    const rest = [0, 1, 2].filter((k) => k !== dom);
    const g0 = ax[along];
    // the grain axis goes to u whenever it lies in this face; end grain just takes the other two
    const [a, b] = rest.includes(g0) ? [g0, rest.find((k) => k !== g0)!] : rest;
    uv.setXY(i, v[a] * scale, v[b] * scale);
  }
}

// ------------------------------------------------------------------------------------------------
// Painted textures
// ------------------------------------------------------------------------------------------------

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function repeat<T extends THREE.Texture>(t: T) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Palm-leaf thatch: courses of dry fronds laid in overlapping rows down the slope (v runs down
 * the slope, one tile = 2 m), each course's lower edge shading the one below.
 */
function thatchCanvas() {
  const { c, g } = canvas(512, 512);
  const rnd = mulberry(77);
  g.fillStyle = '#7a5a32';
  g.fillRect(0, 0, 512, 512);
  const straw = ['#b8935a', '#a07c45', '#8a6837', '#c9a66b', '#6b4d2a', '#d4b47a', '#94733f'];
  const course = 128;
  for (let row = 0; row < 4; row++) {
    const y0 = row * course;
    for (let i = 0; i < 900; i++) {
      const x = rnd() * 512;
      const y = y0 - 20 + rnd() * (course + 10);
      const len = 50 + rnd() * 110;
      const lean = (rnd() - 0.5) * 14;
      g.strokeStyle = straw[Math.floor(rnd() * straw.length)];
      g.globalAlpha = 0.55 + rnd() * 0.45;
      g.lineWidth = 1 + rnd() * 2.6;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + lean * 0.4, y + len * 0.5, x + lean, y + len);
      g.stroke();
      // the same strand across the tile's side edge so the texture wraps without a seam
      if (x < 20 || x > 492) {
        const ox = x < 20 ? 512 : -512;
        g.beginPath();
        g.moveTo(x + ox, y);
        g.quadraticCurveTo(x + ox + lean * 0.4, y + len * 0.5, x + ox + lean, y + len);
        g.stroke();
      }
    }
    // the shadow under the overlapping course above, and the ragged cut ends catching the light
    g.globalAlpha = 1;
    const sh = g.createLinearGradient(0, y0, 0, y0 + 26);
    sh.addColorStop(0, 'rgba(25,14,4,0.75)');
    sh.addColorStop(1, 'rgba(25,14,4,0)');
    g.fillStyle = sh;
    g.fillRect(0, y0, 512, 26);
    for (let x = 0; x < 512; x += 2 + rnd() * 3) {
      g.fillStyle = straw[Math.floor(rnd() * 4)];
      g.globalAlpha = 0.8;
      g.fillRect(x, y0 - 3 - rnd() * 6, 1.6, 4 + rnd() * 5);
    }
  }
  g.globalAlpha = 1;
  return c;
}

/** Tropical hardwood: warm grain running along u (one tile = 2 m × 0.5 m of timber). */
function timberCanvas() {
  const { c, g } = canvas(512, 256);
  const rnd = mulberry(31);
  g.fillStyle = '#9a6a42';
  g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 260; i++) {
    const y = rnd() * 256;
    g.strokeStyle = rnd() > 0.5 ? 'rgba(60,32,14,0.35)' : 'rgba(210,160,110,0.22)';
    g.lineWidth = 0.6 + rnd() * 2.2;
    g.beginPath();
    g.moveTo(-10, y);
    for (let x = 0; x <= 520; x += 32) g.lineTo(x, y + Math.sin(x * 0.012 + i) * (2 + rnd() * 2.5));
    g.stroke();
  }
  // a couple of knots
  for (let i = 0; i < 3; i++) {
    const x = 60 + rnd() * 390;
    const y = 30 + rnd() * 190;
    const rg = g.createRadialGradient(x, y, 0, x, y, 9);
    rg.addColorStop(0, 'rgba(50,25,10,0.8)');
    rg.addColorStop(1, 'rgba(50,25,10,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.ellipse(x, y, 14, 7, 0, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/** Boardwalk decking: planks across the walk (gaps at constant u), one tile = 2 m. */
function deckCanvas() {
  const { c, g } = canvas(512, 256);
  const rnd = mulberry(5);
  const plank = 512 / 14;
  for (let i = 0; i < 14; i++) {
    const shade = 0.82 + rnd() * 0.3;
    g.fillStyle = `rgb(${Math.round(176 * shade)},${Math.round(132 * shade)},${Math.round(92 * shade)})`;
    g.fillRect(i * plank, 0, plank, 256);
    for (let k = 0; k < 14; k++) {
      g.strokeStyle = rnd() > 0.5 ? 'rgba(70,40,20,0.25)' : 'rgba(235,200,160,0.18)';
      g.lineWidth = 0.6 + rnd() * 1.4;
      const x = i * plank + 3 + rnd() * (plank - 6);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + (rnd() - 0.5) * 4, 256);
      g.stroke();
    }
    // salt-bleached ends and nail heads
    g.fillStyle = 'rgba(40,24,12,0.7)';
    for (const y of [20, 128, 236]) {
      g.fillRect(i * plank + plank * 0.3, y, 2, 2);
      g.fillRect(i * plank + plank * 0.7, y, 2, 2);
    }
    g.fillStyle = 'rgba(30,18,8,0.9)';
    g.fillRect(i * plank, 0, 2.5, 256);
  }
  return c;
}

/**
 * Coral limestone pavers in a running bond (one tile = 2.4 m): cream stone with a little colour
 * variation, fossil speckles and sandy joints.
 */
function paverCanvas() {
  const { c, g } = canvas(512, 512);
  const rnd = mulberry(12);
  g.fillStyle = '#b8a888';
  g.fillRect(0, 0, 512, 512);
  const rowH = 512 / 8;
  const len = 512 / 4;
  for (let r = 0; r < 8; r++) {
    const off = r % 2 ? len / 2 : 0;
    for (let k = -1; k < 5; k++) {
      const x = k * len + off;
      const s = 0.9 + rnd() * 0.14;
      const warm = rnd() * 12;
      g.fillStyle = `rgb(${Math.round(236 * s)},${Math.round((224 - warm) * s)},${Math.round((198 - warm * 1.5) * s)})`;
      g.fillRect(x + 2, r * rowH + 2, len - 4, rowH - 4);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = rnd() > 0.5 ? 'rgba(150,130,100,0.35)' : 'rgba(255,250,235,0.4)';
        const px = x + 4 + rnd() * (len - 8);
        const py = r * rowH + 4 + rnd() * (rowH - 8);
        g.beginPath();
        g.arc(px, py, 0.6 + rnd() * 1.8, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  return c;
}

/** Bark for the palm trunks and the bamboo: grey-brown with the leaf-scar rings. */
function barkColumn(g: CanvasRenderingContext2D, x0: number, w: number, h: number) {
  const rnd = mulberry(9);
  g.fillStyle = '#8c7a66';
  g.fillRect(x0, 0, w, h);
  for (let i = 0; i < 140; i++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(60,48,38,0.25)' : 'rgba(190,175,150,0.2)';
    g.fillRect(x0 + rnd() * w, rnd() * h, 1 + rnd() * 3, 6 + rnd() * 26);
  }
  // rings every 1/16 of the tile (the tile spans 1.2 m of trunk)
  for (let i = 0; i < 16; i++) {
    const y = (i / 16) * h + rnd() * 3;
    g.fillStyle = 'rgba(52,40,30,0.75)';
    g.fillRect(x0, y, w, 2.2 + rnd() * 1.5);
    g.fillStyle = 'rgba(200,185,160,0.35)';
    g.fillRect(x0, y + 3, w, 1.5);
  }
}

/**
 * The palms' atlas: the left half is one side of a pinnate frond (u = 0 at the midrib, 0.5 at the
 * leaflet tips; leaflets slant towards the frond's tip, with gaps between them that the alpha test
 * cuts out), the right half the trunk's bark. Pale so instance colours can tint it.
 */
export function palmAtlas() {
  const { c, g } = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  barkColumn(g, 256, 256, 512);
  const n = 9; // leaflets per tile
  for (let i = -1; i <= n; i++) {
    const y = (i / n) * 512;
    // a leaflet: lanceolate, from the midrib outwards and towards the tip (-y is towards the tip)
    g.save();
    g.translate(0, y);
    const grad = g.createLinearGradient(0, 0, 250, 0);
    grad.addColorStop(0, '#dfe8b8');
    grad.addColorStop(0.5, '#eef4dc');
    grad.addColorStop(1, '#d4e2b4');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -10);
    g.quadraticCurveTo(120, -34, 252, -58);
    g.quadraticCurveTo(130, -8, 0, 22);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(120,135,70,0.7)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 6);
    g.quadraticCurveTo(120, -20, 250, -57);
    g.stroke();
    g.restore();
  }
  // the midrib itself (opaque at u = 0, so the fronds never break up along their spine)
  g.fillStyle = '#c8c890';
  g.fillRect(0, 0, 7, 512);
  return c;
}

/** A fine light/dark speckle (mulch, worn paint), tinted by vertex colour; one tile = 2 m. */
function speckleCanvas() {
  const { c, g } = canvas(256, 256);
  const rnd = mulberry(61);
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = Math.round(150 + rnd() * 105);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
  }
  return c;
}

/** Ripples for the fountain and the pond, scrolled in v. */
function rippleCanvas() {
  const { c, g } = canvas(256, 256);
  const rnd = mulberry(3);
  g.fillStyle = '#8fd8e4';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.55)' : 'rgba(40,120,150,0.35)';
    g.lineWidth = 1 + rnd() * 2.5;
    const y = rnd() * 256;
    const x = rnd() * 256;
    g.beginPath();
    g.ellipse(x, y, 10 + rnd() * 30, 2 + rnd() * 3, 0, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.ellipse(x, y + 256 * (y > 128 ? -1 : 1), 10 + rnd() * 30, 2 + rnd() * 3, 0, 0, Math.PI * 2);
    g.stroke();
  }
  return c;
}

// ------------------------------------------------------------------------------------------------
// Materials (one set, shared by the park and the terminal)
// ------------------------------------------------------------------------------------------------

export interface IslandMaterials {
  /** Painted surfaces, metal-free: vertex colours only. */
  paint: THREE.MeshStandardMaterial;
  /** Fabric (umbrellas, awnings, towels, hammocks): double-sided, matt. */
  fabric: THREE.MeshStandardMaterial;
  /** Hardwood beams, posts, furniture (box-projected grain). */
  timber: THREE.MeshStandardMaterial;
  /** Boardwalk and pier decking (planks across the walk). */
  deck: THREE.MeshStandardMaterial;
  /** Palm thatch (roofs, palapa umbrellas): seen from below inside the pavilions too. */
  thatch: THREE.MeshStandardMaterial;
  /** Coral-stone paving and kerbs. */
  stone: THREE.MeshStandardMaterial;
  /** Painted or anodised metal (rails, frames, the stairs truck). */
  metal: THREE.MeshStandardMaterial;
  /** Window glass: clear, reflective. */
  glass: THREE.MeshStandardMaterial;
  /** Lit surfaces (shop interiors, lanterns, lit windows): unlit, brightened at night by `setLit`. */
  lit: THREE.MeshBasicMaterial;
  /** Fountain and pond water (its map scrolls). */
  water: THREE.MeshStandardMaterial;
  /** Flat ground cover laid on y = 0 (planting beds' mulch, painted walkway lines): speckled, pulled towards the camera so it never z-fights. */
  ground: THREE.MeshStandardMaterial;
}

let MATS: IslandMaterials | null = null;

/** The island's shared materials (built once). */
export function islandMaterials(renderer?: THREE.WebGLRenderer): IslandMaterials {
  if (MATS) return MATS;
  const tex = (c: HTMLCanvasElement) => repeat(canvasTex(c, renderer));
  const thatch = tex(thatchCanvas());
  const timber = tex(timberCanvas());
  const deck = tex(deckCanvas());
  const pavers = tex(paverCanvas());
  const ripple = tex(rippleCanvas());
  const speckle = tex(speckleCanvas());
  MATS = {
    paint: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.62, metalness: 0.02 }),
    fabric: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }),
    timber: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: timber, bumpMap: timber, bumpScale: 0.6, roughness: 0.82 }),
    deck: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: deck, bumpMap: deck, bumpScale: 1.2, roughness: 0.88 }),
    thatch: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: thatch, bumpMap: thatch, bumpScale: 2.5, roughness: 1, side: THREE.DoubleSide }),
    stone: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: pavers, bumpMap: pavers, bumpScale: 0.8, roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.38, metalness: 0.65 }),
    glass: new THREE.MeshStandardMaterial({ color: '#cfe9ee', roughness: 0.04, metalness: 0.55, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide }),
    lit: new THREE.MeshBasicMaterial({ color: '#ffffff', vertexColors: true }),
    water: new THREE.MeshStandardMaterial({ color: '#a8e6ee', map: ripple, roughness: 0.06, metalness: 0.25, transparent: true, opacity: 0.82, depthWrite: false }),
    ground: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: speckle, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
  };
  // flat stone and decking would z-fight with the island's ground (y = 0) from the air
  for (const m of [MATS.stone, MATS.deck]) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -4;
  }
  // light bounced in under the terminal's thatch (setInteriorFill)
  for (const m of [MATS.paint, MATS.fabric, MATS.timber, MATS.deck, MATS.thatch, MATS.stone, MATS.metal, MATS.glass, MATS.water, MATS.ground]) addInteriorFill(m);
  return MATS;
}

// ------------------------------------------------------------------------------------------------
// Interior fill: light bounced in under the big thatched roofs
// ------------------------------------------------------------------------------------------------

/** How many boxes `setInteriorFill` takes. */
const FILL_BOXES = 4;

const FILL = {
  uFillBox: { value: Array.from({ length: FILL_BOXES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uFillTop: { value: new Array<number>(FILL_BOXES).fill(0) },
  uFillColor: { value: new THREE.Color(0, 0, 0) },
};

/**
 * Where the sunlit floor, the open sides and the lamps fill a roofed hall with light (no real
 * lights, which every shader in the world would pay for): world rectangles (x0, z0, x1, z1) and,
 * per box, the height above which upward-facing surfaces are outside it (the roof's top). One set
 * for the whole scene (the island terminal's). Surfaces inside get `color` as extra ambient
 * light, fading in over 3 m from each box's edge so the outside of the walls stays as it was.
 */
export function setInteriorFill(boxes: { x0: number; z0: number; x1: number; z1: number; top: number }[]) {
  FILL.uFillBox.value.forEach((v, i) => {
    const b = boxes[i];
    if (b) v.set(b.x0, b.z0, b.x1, b.z1);
    else v.set(0, 0, 0, 0);
    FILL.uFillTop.value[i] = b?.top ?? 0;
  });
}

/** The fill's colour and strength (irradiance; ~2 by day under the thatch, less from the lamps at night). */
export function setInteriorFillColor(color: THREE.ColorRepresentation, k: number) {
  FILL.uFillColor.value.set(color).multiplyScalar(k);
}

/**
 * Adds the interior fill to a lit material, after anything its own onBeforeCompile does (call it
 * last; the program cache key keeps the material's own key and adds to it).
 */
export function addInteriorFill(material: THREE.Material) {
  const prev = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, FILL);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFillW;').replace(
      '#include <worldpos_vertex>',
      /* glsl */ `#include <worldpos_vertex>
      vec4 fillW = vec4( transformed, 1.0 );
      #ifdef USE_BATCHING
        fillW = batchingMatrix * fillW;
      #endif
      #ifdef USE_INSTANCING
        fillW = instanceMatrix * fillW;
      #endif
      vFillW = ( modelMatrix * fillW ).xyz;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vFillW;\nuniform vec4 uFillBox[${FILL_BOXES}];\nuniform float uFillTop[${FILL_BOXES}];\nuniform vec3 uFillColor;`)
      .replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `#include <lights_fragment_maps>
        {
          vec3 wn = inverseTransformDirection( normal, viewMatrix );
          float m = 0.0;
          for ( int i = 0; i < ${FILL_BOXES}; i ++ ) {
            vec4 b = uFillBox[ i ];
            vec2 e = min( vFillW.xz - b.xy, b.zw - vFillW.xz );
            // inside, and not a roof's sunlit top (upward-facing, above the eaves)
            float k = smoothstep( 0.0, 3.0, min( e.x, e.y ) ) * ( ( wn.y < 0.3 || vFillW.y < uFillTop[ i ] ) ? 1.0 : 0.0 );
            m = max( m, k );
          }
          // a little more onto the floor (sky through the open sides) than up into the thatch
          irradiance += uFillColor * m * ( 1.0 + 0.12 * wn.y );
        }`,
      );
  };
  material.customProgramCacheKey = () => `${key}|island-fill`;
}

/** How bright the lit surfaces are: dim interiors by day, glowing (bloom) at night. */
export function litLevel(night: number) {
  return 0.55 + night * 2.6;
}

// ------------------------------------------------------------------------------------------------
// Sign atlas: every painted board on the island in one texture
// ------------------------------------------------------------------------------------------------

export interface SignStyle {
  bg: string;
  fg: string;
  /** A border colour, or none. */
  border?: string;
  sub?: string;
  subColor?: string;
  font?: 'display' | 'body';
  /** Draw an arrow on this side. */
  arrow?: 'left' | 'right';
  /** Leave the board's corners square (wayfinding arrows, FIDS frames). */
  square?: boolean;
}

/** Hands out cells of one 2048² canvas; `uv(cell)` maps a plane's 0..1 UVs onto a cell. */
export class SignAtlas {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private emissiveCanvas: HTMLCanvasElement;
  private eg: CanvasRenderingContext2D;
  private x = 0;
  private y = 0;
  private rowH = 0;
  readonly texture: THREE.CanvasTexture;
  readonly emissive: THREE.CanvasTexture;
  /** Every cell's painter, kept to paint the whole atlas again once the web fonts have arrived. */
  private ops: (() => void)[] = [];

  constructor(renderer?: THREE.WebGLRenderer) {
    ({ c: this.canvas, g: this.g } = canvas(2048, 2048));
    ({ c: this.emissiveCanvas, g: this.eg } = canvas(2048, 2048));
    this.eg.fillStyle = '#000';
    this.eg.fillRect(0, 0, 2048, 2048);
    this.texture = canvasTex(this.canvas, renderer);
    this.emissive = canvasTex(this.emissiveCanvas, renderer);
    void document.fonts?.ready.then(() => this.repaint());
  }

  private repaint() {
    this.g.clearRect(0, 0, 2048, 2048);
    this.eg.fillStyle = '#000';
    this.eg.fillRect(0, 0, 2048, 2048);
    for (const op of this.ops) op();
    this.texture.needsUpdate = true;
    this.emissive.needsUpdate = true;
  }

  private run(op: () => void) {
    this.ops.push(op);
    op();
  }

  private alloc(w: number, h: number) {
    if (this.x + w > 2048) {
      this.x = 0;
      this.y += this.rowH + 4;
      this.rowH = 0;
    }
    if (this.y + h > 2048) throw new Error('sign atlas full');
    const cell = { x: this.x, y: this.y, w, h };
    this.x += w + 4;
    this.rowH = Math.max(this.rowH, h);
    return cell;
  }

  /** Paints a board with a title (and a subtitle) and returns its UV rectangle. */
  sign(title: string, w: number, h: number, s: SignStyle) {
    const cell = this.alloc(w, h);
    this.run(() => this.paintSign(cell, title, w, h, s));
    return this.uvRect(cell);
  }

  private paintSign(cell: { x: number; y: number }, title: string, w: number, h: number, s: SignStyle) {
    const g = this.g;
    g.save();
    g.translate(cell.x, cell.y);
    const r = s.square ? 0 : Math.min(w, h) * 0.18;
    g.fillStyle = s.border ?? s.bg;
    roundRect(g, 0, 0, w, h, r);
    g.fill();
    if (s.border) {
      g.fillStyle = s.bg;
      const b = Math.max(4, h * 0.07);
      roundRect(g, b, b, w - 2 * b, h - 2 * b, Math.max(0, r - b));
      g.fill();
    }
    const arrowW = s.arrow ? h * 0.75 : 0;
    const left = s.arrow === 'left' ? arrowW : 0;
    const tw = w - arrowW - h * 0.3;
    g.fillStyle = s.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const family = s.font === 'body' ? `700 FONTSIZEpx ${BODY_FONT}` : `FONTSIZEpx ${DISPLAY_FONT}`;
    let size = s.sub ? h * 0.42 : h * 0.56;
    const setFont = () => (g.font = family.replace('FONTSIZE', String(Math.round(size))));
    setFont();
    while (g.measureText(title).width > tw && size > 10) {
      size -= 2;
      setFont();
    }
    const cx = left + h * 0.15 + tw / 2;
    g.fillText(title, cx, s.sub ? h * 0.4 : h * 0.54);
    if (s.sub) {
      let sub = h * 0.2;
      g.font = `700 ${sub}px ${BODY_FONT}`;
      while (g.measureText(s.sub).width > tw && sub > 8) {
        sub -= 1;
        g.font = `700 ${sub}px ${BODY_FONT}`;
      }
      g.fillStyle = s.subColor ?? s.fg;
      g.fillText(s.sub, cx, h * 0.76);
    }
    if (s.arrow) {
      const ax = s.arrow === 'left' ? h * 0.45 : w - h * 0.45;
      const dir = s.arrow === 'left' ? -1 : 1;
      g.fillStyle = s.fg;
      g.beginPath();
      g.moveTo(ax + dir * h * 0.25, h / 2);
      g.lineTo(ax - dir * h * 0.12, h * 0.24);
      g.lineTo(ax - dir * h * 0.12, h * 0.76);
      g.closePath();
      g.fill();
    }
    g.restore();
    // the emissive mask: the whole board, as if floodlit (the material's intensity follows the night)
    this.eg.save();
    this.eg.globalAlpha = 0.85;
    this.eg.drawImage(this.canvas, cell.x, cell.y, w, h, cell.x, cell.y, w, h);
    this.eg.restore();
  }

  /** Paints into a free cell with a custom painter (the island map board, the welcome arch…). */
  paint(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, glow = 0.6) {
    const cell = this.alloc(w, h);
    this.run(() => {
      this.g.save();
      this.g.translate(cell.x, cell.y);
      draw(this.g, w, h);
      this.g.restore();
      this.eg.save();
      this.eg.globalAlpha = glow;
      this.eg.drawImage(this.canvas, cell.x, cell.y, w, h, cell.x, cell.y, w, h);
      this.eg.restore();
    });
    return this.uvRect(cell);
  }

  private uvRect(cell: { x: number; y: number; w: number; h: number }) {
    return { u0: cell.x / 2048, u1: (cell.x + cell.w) / 2048, v0: 1 - (cell.y + cell.h) / 2048, v1: 1 - cell.y / 2048 };
  }

  /** The material every sign on the island shares. */
  material(intensity = 0.25) {
    const m = new THREE.MeshStandardMaterial({ map: this.texture, emissive: '#ffffff', emissiveMap: this.emissive, emissiveIntensity: intensity, roughness: 0.6, metalness: 0 });
    addInteriorFill(m);
    return m;
  }
}

export type UvRect = { u0: number; u1: number; v0: number; v1: number };

/** A w × h plane facing +z with its UVs mapped onto an atlas cell. */
export function signPlane(w: number, h: number, r: UvRect) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  return g;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ------------------------------------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------------------------------------

/** A transform: position, yaw (park convention: 0 faces north, −z) and uniform scale. */
export function place(x: number, y: number, z: number, yaw = 0, s = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw), new THREE.Vector3(s, s, s));
}

/** `parent` followed by a local offset (x, y, z) and yaw: a child's placement in a placed object. */
export function at(parent: THREE.Matrix4, x: number, y: number, z: number, yaw = 0) {
  return parent.clone().multiply(place(x, y, z, yaw));
}

/** A cylinder standing on y = 0 (radius r0 at the bottom, r1 at the top). */
export function post(r0: number, r1: number, h: number, seg = 8) {
  return new THREE.CylinderGeometry(r1, r0, h, seg).translate(0, h / 2, 0);
}

/**
 * A thatched hip roof over a w × d rectangle (x × z, centred on the origin) whose eaves sit at
 * y = 0 and whose ridge is `rise` above them; a rectangle with w = d gives a pyramid. UVs run
 * along the eaves (u) and down the slope (v), in metres × `uvScale`, so the thatch courses lie
 * level. `ridgeAlongZ` turns it 90° (ridge along z).
 */
export function hipRoof(w: number, d: number, rise: number, uvScale = 0.5, thickness = 0.35) {
  const hw = w / 2;
  const hd = d / 2;
  const r = Math.max(0, hw - hd); // half the ridge's length
  const top: [number, number][] = [
    [-r, 0],
    [r, 0],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  const quad = (a: number[], b: number[], c: number[], e: number[]) => {
    // a, b on the eave, c, e at the ridge; v from the ridge down
    const slope = Math.hypot(rise, hd);
    const pts = [a, b, c, a, c, e];
    for (const p of pts) {
      pos.push(p[0], p[1], p[2]);
      const along = Math.abs(a[2]) > 1e-6 && Math.abs(a[2] - b[2]) < 1e-6 ? p[0] : p[2];
      const down = (1 - p[1] / rise) * slope;
      uv.push(along * uvScale, down * uvScale);
    }
  };
  // south (+z) and north (−z) slopes: trapezoids; east and west: triangles (or trapezoids for a pyramid)
  quad([-hw, 0, hd], [hw, 0, hd], [top[1][0], rise, 0], [top[0][0], rise, 0]);
  quad([hw, 0, -hd], [-hw, 0, -hd], [top[0][0], rise, 0], [top[1][0], rise, 0]);
  quad([hw, 0, hd], [hw, 0, -hd], [top[1][0], rise, 0], [top[1][0], rise, 0]);
  quad([-hw, 0, -hd], [-hw, 0, hd], [top[0][0], rise, 0], [top[0][0], rise, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  // the thatch's thick eave edge: a band of fascia round the bottom
  const parts = [g];
  if (thickness > 0) {
    const band = new THREE.BoxGeometry(w + 0.1, thickness, thickness);
    parts.push(band.clone().translate(0, -thickness / 2, hd), band.clone().translate(0, -thickness / 2, -hd));
    const side = new THREE.BoxGeometry(thickness, thickness, d);
    parts.push(side.clone().translate(hw, -thickness / 2, 0), side.clone().translate(-hw, -thickness / 2, 0));
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

/**
 * A thatched gable roof: ridge along z, length `len`, span `span` (x), eaves at y = 0, ridge at
 * `rise`. Open gable ends (the caller fills them). UVs as hipRoof's.
 */
export function gableRoof(span: number, len: number, rise: number, uvScale = 0.5) {
  const hs = span / 2;
  const hl = len / 2;
  const slope = Math.hypot(hs, rise);
  const pos = [
    // west slope
    -hs, 0, hl, -hs, 0, -hl, 0, rise, -hl, -hs, 0, hl, 0, rise, -hl, 0, rise, hl,
    // east slope
    hs, 0, -hl, hs, 0, hl, 0, rise, hl, hs, 0, -hl, 0, rise, hl, 0, rise, -hl,
  ];
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i + 2] * uvScale, (1 - pos[i + 1] / rise) * slope * uvScale);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** A cone roof (palapa umbrellas, round bars): apex at `rise`, eave radius r at y = 0. */
export function coneRoof(r: number, rise: number, seg = 14, uvScale = 0.5) {
  const pos: number[] = [];
  const uv: number[] = [];
  const slope = Math.hypot(r, rise);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const arc = (a: number) => (a * r) * uvScale;
    pos.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, 0, rise, 0, Math.cos(a1) * r, 0, Math.sin(a1) * r);
    uv.push(arc(a0), slope * uvScale, (arc(a0) + arc(a1)) / 2, 0, arc(a1), slope * uvScale);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * A flat strip on the ground along a polyline (paths, painted walkway lines): y is constant. The
 * vertices are relative to the first point (place the result there: `place(p0.x, 0, p0.z)`), so a
 * path 41 km out keeps its precision.
 */
export function strip(points: V2[], width: number, y: number, uvScale = 0.5) {
  const ox = points[0].x;
  const oz = points[0].z;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    if (i > 0) along += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    const p = points[i];
    pos.push(p.x - ox + (nx * width) / 2, y, p.z - oz + (nz * width) / 2, p.x - ox - (nx * width) / 2, y, p.z - oz - (nz * width) / 2);
    uv.push(along * uvScale, 0, along * uvScale, width * uvScale);
    if (i > 0) {
      const q = (i - 1) * 2;
      idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A disc on the ground (plazas, pools of light), UVs in world metres × uvScale. */
export function disc(r: number, y: number, seg = 48, uvScale = 0.5) {
  const g = new THREE.CircleGeometry(r, seg).rotateX(-Math.PI / 2).translate(0, y, 0);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) * uvScale, p.getZ(i) * uvScale);
  return g;
}

/** Points along a hanging cable from a to b (sag at mid-span), n segments. */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, n: number) {
  const out: THREE.Vector3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p = a.clone().lerp(b, t);
    p.y -= Math.sin(t * Math.PI) * sag;
    out.push(p);
  }
  return out;
}

/**
 * A truncated hip roof: eaves round a w0 × d0 rectangle at y = 0, sloping up to a smaller
 * w1 × d1 rectangle at `rise` (open at the top, where a clerestory and an upper roof sit). UVs as
 * hipRoof's: along the eaves and down the slope, so the thatch courses lie level.
 */
export function frustumRoof(w0: number, d0: number, w1: number, d1: number, rise: number, uvScale = 0.5) {
  const pos: number[] = [];
  const uv: number[] = [];
  const corners = (w: number, d: number, y: number) => [
    [-w / 2, y, d / 2],
    [w / 2, y, d / 2],
    [w / 2, y, -d / 2],
    [-w / 2, y, -d / 2],
  ];
  const lo = corners(w0, d0, 0);
  const hi = corners(w1, d1, rise);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const run = i % 2 === 0 ? (d0 - d1) / 2 : (w0 - w1) / 2;
    const slope = Math.hypot(run, rise);
    // u along the eave (x on the south and north slopes, z on the east and west), v down the slope
    const along = (p: number[]) => (i % 2 === 0 ? p[0] : p[2]);
    const quad = [lo[i], lo[j], hi[j], lo[i], hi[j], hi[i]];
    for (const p of quad) {
      pos.push(p[0], p[1], p[2]);
      uv.push(along(p) * uvScale, (1 - p[1] / rise) * slope * uvScale);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------------
// One batch per shared material
// ------------------------------------------------------------------------------------------------

export type MaterialKey = keyof IslandMaterials;

/**
 * A batch for each of the island's materials plus the sign atlas, all stored relative to one
 * origin; `build` turns each non-empty one into a single mesh in `group` (so a whole district
 * costs one draw call per material it uses).
 */
export class Batches {
  readonly paint: Batch;
  readonly fabric: Batch;
  readonly timber: Batch;
  readonly deck: Batch;
  readonly thatch: Batch;
  readonly stone: Batch;
  readonly metal: Batch;
  readonly glass: Batch;
  readonly lit: Batch;
  readonly water: Batch;
  readonly ground: Batch;
  readonly signs: Batch;

  constructor(readonly origin: THREE.Vector3Like) {
    this.paint = new Batch(origin);
    this.fabric = new Batch(origin);
    this.timber = new Batch(origin);
    this.deck = new Batch(origin);
    this.thatch = new Batch(origin);
    this.stone = new Batch(origin);
    this.metal = new Batch(origin);
    this.glass = new Batch(origin);
    this.lit = new Batch(origin);
    this.water = new Batch(origin);
    this.ground = new Batch(origin);
    this.signs = new Batch(origin);
  }

  /**
   * Builds every non-empty batch into `group`; flat ground cover and glowing or see-through parts
   * cast no shadow. `lean` (the low tiers) folds the materials that only differ in finish into
   * one another to save draw calls: decking into timber, and paint, metal and water into the
   * double-sided fabric (water turns opaque, metal loses its sheen). `cell` (metres, 0: off) builds
   * each batch as per-cell BatchedMesh instances, culled against the view and the shadow box (see
   * `Batch.build`); pass it only where `canMultiDraw` holds.
   */
  build(group: THREE.Group, mats: IslandMaterials, signMat: THREE.Material, shadows: boolean, lean = false, cell = 0) {
    if (lean) {
      this.timber.absorb(this.deck);
      this.fabric.absorb(this.paint);
      this.fabric.absorb(this.metal);
      this.fabric.absorb(this.water, mats.water.color);
    }
    const keys = BATCH_KEYS;
    const noCast = new Set<MaterialKey>(['ground', 'stone', 'deck', 'glass', 'lit', 'water']);
    const out: THREE.Mesh[] = [];
    for (const k of keys) {
      const mesh = this[k].build(mats[k], shadows && !noCast.has(k), shadows && k !== 'glass' && k !== 'lit' && k !== 'water', cell);
      if (mesh) {
        mesh.name = k;
        out.push(mesh);
      }
    }
    const signs = this.signs.build(signMat, false, shadows, cell);
    if (signs) out.push(signs);
    // see-through water and glass draw after everything opaque
    for (const m of out) if (m.material === mats.glass || m.material === mats.water) m.renderOrder = 3;
    group.add(...out);
    return out;
  }

  private last = new THREE.Vector3(Infinity, 0, 0);

  /** With `cell`: hides the small parts too far from the camera to see (cheap; only works when the camera has moved a few metres). */
  update(camera: THREE.Camera) {
    const o = this.origin;
    const p = camera.position;
    if (Math.hypot(p.x - o.x - this.last.x, p.y - o.y - this.last.y, p.z - o.z - this.last.z) < 6) return;
    this.last.set(p.x - o.x, p.y - o.y, p.z - o.z);
    for (const k of [...BATCH_KEYS, 'signs'] as const) this[k].cull(this.last.x, this.last.y, this.last.z);
  }
}

const BATCH_KEYS: MaterialKey[] = ['ground', 'stone', 'deck', 'paint', 'fabric', 'timber', 'thatch', 'metal', 'lit', 'glass', 'water'];
