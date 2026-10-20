// Splash Tower's static build: the three flumes (fibreglass shells, glossy interiors that glow
// where sunlight comes through the tube walls, clear tube sections, a film of water flowing down
// them, bolted flanges, LED strips for the night, steel supports and the helices' central masts),
// the open steel tower with its stairs, deck, start gates and sail canopy, the splash pool, the
// entrance and the queue. Everything is built in the attraction's local frame (its anchor at the
// origin), so float32 vertices stay precise 41 km from the world's origin, and merged into one mesh
// per material: the whole attraction is about twenty draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { staticBox, staticCylinder, type Ctx } from '../../context';
import { withFogSun } from '../../fog';
import type { Tier } from '../../quality';
import { mulberry } from '../../random';
import { BODY_FONT, canvasTex, DISPLAY_FONT } from '../../textures';
import { Batch, islandMaterials, place, post, type IslandMaterials } from '../../island/kit';
import { DS, POOL, TOWER, frame, sampleSlide, sectionAt, type SlidePath } from './slides-path';

/** The fibreglass's thickness (inner surface to outer), and the flanges' extra height. */
const TH = 0.06;
const FLANGE = 0.05;
/** Section joints along every flume (m). */
const JOINT = 3;
/** The coloured stripe along the outside of each flume (angles from the bottom). */
const STRIPE: [number, number] = [1.3, 1.42];
/** The water film covers the flume's floor this far either side of the bottom (rad). */
const FILM = 0.55;
/** The splash lane's standing water: this deep over the flume's bottom. */
export const LANE_DEPTH = 0.3;

const WHITE = '#f4f1ea';
const TEAL = '#1d8a99';
const STEEL = '#d9dee0';
const GRATE = '#5d676c';

/** The stair corners (relative to the tower's centre): the stair climbs clockwise from the north-east corner. */
const CORNERS: [number, number][] = [
  [3.75, -3.75],
  [3.75, 3.75],
  [-3.75, 3.75],
  [-3.75, -3.75],
];
export const FLIGHTS = 8;
export const FLIGHT_RISE = 3;

/** The queue: from the entrance arch (at the end of the island's path from the east) round to the stair's foot. */
export const QUEUE: { x: number; z: number }[] = [
  { x: 47, z: 2 },
  { x: 40, z: 2 },
  { x: 40, z: -44 },
  { x: 3.75, z: -44 },
  { x: 3.75, z: -39.6 },
];
export const ENTRANCE = { x: 42, z: 2 };

// ------------------------------------------------------------------------------------------------
// Vertex soup
// ------------------------------------------------------------------------------------------------

/** Positions, normals, colours, uvs and a glow weight, appended vertex by vertex. */
class Soup {
  private p: number[] = [];
  private n: number[] = [];
  private c: number[] = [];
  private uv: number[] = [];
  private g: number[] = [];
  private idx: number[] = [];

  get count() {
    return this.p.length / 3;
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, u = 0, v = 0, glow = 0) {
    this.p.push(p.x, p.y, p.z);
    this.n.push(n.x, n.y, n.z);
    this.c.push(c.r, c.g, c.b);
    this.uv.push(u, v);
    this.g.push(glow);
    return this.count - 1;
  }

  /** Two triangles over a-b-c-d; the face is seen from the side (b − a) × (d − a) points to. */
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, d, b, c, d);
  }

  /** Quads between two rows of vertices; `outward` faces (b − a) × (along the row). */
  strip(a: number[], b: number[], outward: boolean) {
    for (let j = 0; j + 1 < a.length; j++) {
      if (outward) this.quad(a[j], b[j], b[j + 1], a[j + 1]);
      else this.quad(a[j], a[j + 1], b[j + 1], b[j]);
    }
  }

  build(glow = false) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (glow) geo.setAttribute('glow', new THREE.Float32BufferAttribute(this.g, 1));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

// ------------------------------------------------------------------------------------------------
// Textures
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

/** Running water: a pale, half-clear sheet with long streaks and foam flecks along v (2 m a tile). */
function flowCanvas() {
  const { c, g } = canvas(128, 512);
  const rnd = mulberry(41);
  g.fillStyle = 'rgba(215,245,255,0.42)';
  g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 140; i++) {
    const x = rnd() * 128;
    const y = rnd() * 512;
    const len = 30 + rnd() * 140;
    g.strokeStyle = `rgba(255,255,255,${0.25 + rnd() * 0.55})`;
    g.lineWidth = 0.6 + rnd() * 2.2;
    for (const dy of [0, -512, 512]) {
      g.beginPath();
      g.moveTo(x, y + dy);
      g.bezierCurveTo(x + (rnd() - 0.5) * 6, y + dy + len * 0.3, x + (rnd() - 0.5) * 6, y + dy + len * 0.7, x + (rnd() - 0.5) * 4, y + dy + len);
      g.stroke();
    }
  }
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(255,255,255,${0.4 + rnd() * 0.6})`;
    g.fillRect(rnd() * 128, rnd() * 512, 1 + rnd() * 2, 2 + rnd() * 6);
  }
  return c;
}

/** Pool tiles: small aqua mosaic with pale grout, one tile = 1 m. */
function tileCanvas() {
  const { c, g } = canvas(256, 256);
  const rnd = mulberry(9);
  g.fillStyle = '#e6f4f4';
  g.fillRect(0, 0, 256, 256);
  const n = 10;
  const s = 256 / n;
  const hues = ['#6fc9d6', '#59bccb', '#7fd3dc', '#4fb2c4', '#8adbe2'];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      g.fillStyle = hues[Math.floor(rnd() * hues.length)];
      g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
    }
  return c;
}

/** The pool's surface: caustic-like ripples (scrolled slowly). */
function rippleCanvas() {
  const { c, g } = canvas(256, 256);
  const rnd = mulberry(23);
  g.fillStyle = '#7fd2e0';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 110; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const rx = 8 + rnd() * 26;
    const ry = 3 + rnd() * 9;
    g.strokeStyle = rnd() > 0.45 ? `rgba(255,255,255,${0.35 + rnd() * 0.4})` : 'rgba(30,110,140,0.3)';
    g.lineWidth = 1 + rnd() * 2;
    for (const [dx, dy] of [
      [0, 0],
      [256, 0],
      [-256, 0],
      [0, 256],
      [0, -256],
    ]) {
      g.beginPath();
      g.ellipse(x + dx, y + dy, rx, ry, rnd() * 0.4, 0, Math.PI * 2);
      g.stroke();
    }
  }
  return c;
}

/** Churned white water where the slides pour into the pool. */
function foamCanvas() {
  const { c, g } = canvas(256, 256);
  const rnd = mulberry(5);
  g.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 420; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 0.7) * 118;
    const x = 128 + Math.cos(a) * r;
    const y = 128 + Math.sin(a) * r;
    const k = 1 - r / 128;
    g.fillStyle = `rgba(255,255,255,${(0.15 + rnd() * 0.5) * k})`;
    g.beginPath();
    g.arc(x, y, 2 + rnd() * 9 * k, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/** UV rectangles of the sign atlas. */
interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Every painted board in one 1024² canvas: the tower's big name board, the entrance arch's board,
 * and the three start gates' boards (number and name in the slide's colours).
 */
function signAtlas(slides: SlidePath[]) {
  const { c, g } = canvas(1024, 1024);
  const cells: { tower: Cell; arch: Cell; gates: Cell[] } = { tower: cell(0, 0, 1024, 256), arch: cell(0, 264, 1024, 230), gates: [] };
  function cell(x: number, y: number, w: number, h: number): Cell {
    return { u0: x / 1024, u1: (x + w) / 1024, v0: 1 - (y + h) / 1024, v1: 1 - y / 1024 };
  }
  const paint = () => {
    g.clearRect(0, 0, 1024, 1024);
    // the tower's board: deep teal, cream letters, a band of waves along the bottom
    board(g, 0, 0, 1024, 256, '#0f6f80', '#fff5e3');
    g.fillStyle = '#fff5e3';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fit(g, 'SPLASH TOWER', 150, 900, DISPLAY_FONT);
    g.fillText('SPLASH TOWER', 512, 118);
    waves(g, 24, 205, 976, '#5fd3e3');
    // the arch: sunny yellow with the three slides' colour dots
    board(g, 0, 264, 1024, 230, '#ffc23d', '#1d1238');
    g.fillStyle = '#1d1238';
    fit(g, 'Splash Tower', 112, 900, DISPLAY_FONT);
    g.fillText('Splash Tower', 512, 352);
    fit(g, 'Kamikaze · Typhoon · Lazy Loop', 40, 880, BODY_FONT, 700);
    g.fillText('Kamikaze · Typhoon · Lazy Loop', 512, 440);
    slides.forEach((p, k) => {
      const x = 4 + k * 340;
      const y = 504;
      board(g, x, y, 332, 170, p.spec.colour, '#ffffff');
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x + 70, y + 85, 52, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = p.spec.colour;
      g.font = `400 80px ${DISPLAY_FONT}`;
      g.fillText(String(p.spec.n), x + 70, y + 90);
      g.fillStyle = '#ffffff';
      fit(g, p.spec.name, 52, 196, DISPLAY_FONT);
      g.fillText(p.spec.name, x + 222, y + 88);
      cells.gates.push(cell(x, y, 332, 170));
    });
  };
  paint();
  const tex = canvasTex(c);
  // the web fonts may arrive after the first paint: paint again once they have
  void document.fonts?.ready.then(() => {
    cells.gates = [];
    paint();
    tex.needsUpdate = true;
  });
  return { tex, cells };
}

/** Sets the font at `size` px, smaller if the text would be wider than `max` (a fallback font is wider). */
function fit(g: CanvasRenderingContext2D, text: string, size: number, max: number, family: string, weight = 400) {
  g.font = `${weight} ${size}px ${family}`;
  const w = g.measureText(text).width;
  if (w > max) g.font = `${weight} ${Math.floor((size * max) / w)}px ${family}`;
}

function board(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bg: string, edge: string) {
  const r = Math.min(40, h * 0.25);
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(x + 4, y + 4, w - 8, h - 8, r);
  g.fill();
  g.strokeStyle = edge;
  g.lineWidth = 8;
  g.beginPath();
  g.roundRect(x + 14, y + 14, w - 28, h - 28, r - 8);
  g.stroke();
}

function waves(g: CanvasRenderingContext2D, x0: number, y: number, w: number, colour: string) {
  g.strokeStyle = colour;
  g.lineWidth = 9;
  g.beginPath();
  for (let x = 0; x <= w; x += 4) {
    const yy = y + Math.sin((x / w) * Math.PI * 14) * 9;
    if (x === 0) g.moveTo(x0 + x, yy);
    else g.lineTo(x0 + x, yy);
  }
  g.stroke();
}

// ------------------------------------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------------------------------------

export interface SlideMaterials {
  /** Gloss fibreglass outside (vertex colours: body, stripe, flanges). */
  shell: THREE.MeshStandardMaterial;
  /** The glossy gelcoat inside; tube sections glow with the daylight through their walls. */
  inner: THREE.MeshStandardMaterial;
  /** The clear tube sections. */
  clear: THREE.MeshStandardMaterial;
  /** The film of water running down the flumes (two layers of streaks scrolling at different rates). */
  water: THREE.MeshStandardMaterial;
  /** LED strips: dim by day, glowing through the bloom at night. */
  led: THREE.MeshBasicMaterial;
  tile: THREE.MeshStandardMaterial;
  pool: THREE.MeshStandardMaterial;
  foam: THREE.MeshBasicMaterial;
  sign: THREE.MeshStandardMaterial;
  /** The riders (vertex colours). */
  rider: THREE.MeshStandardMaterial;
  uTime: { value: number };
  uGlow: { value: number };
}

function materials(renderer: THREE.WebGLRenderer, signTex: THREE.Texture): SlideMaterials {
  const uTime = { value: 0 };
  const uGlow = { value: 0.3 };
  const inner = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.16, metalness: 0 });
  inner.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uGlow = uGlow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlow;');
  };
  inner.customProgramCacheKey = () => 'slides-inner';

  const flow = repeat(canvasTex(flowCanvas(), renderer));
  const water = new THREE.MeshStandardMaterial({ color: '#ffffff', map: flow, transparent: true, roughness: 0.04, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide });
  water.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uTime = uTime;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <map_fragment>',
      /* glsl */ `#ifdef USE_MAP
        vec4 fa = texture2D( map, vMapUv + vec2( 0.0, -uTime * 1.35 ) );
        vec4 fb = texture2D( map, vMapUv * vec2( 0.7, 0.45 ) + vec2( 0.37, -uTime * 0.85 ) );
        vec4 sampledDiffuseColor = vec4( max( fa.rgb, fb.rgb ), clamp( fa.a + fb.a * 0.6, 0.0, 0.95 ) );
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  water.customProgramCacheKey = () => 'slides-water';

  const tile = repeat(canvasTex(tileCanvas(), renderer));
  const ripple = repeat(canvasTex(rippleCanvas(), renderer));
  ripple.repeat.set(1 / 6, 1 / 6);
  return {
    shell: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.3, metalness: 0 }),
    inner,
    clear: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, transparent: true, opacity: 0.5, roughness: 0.06, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false }),
    water,
    led: new THREE.MeshBasicMaterial({ color: '#ffffff', vertexColors: true }),
    tile: new THREE.MeshStandardMaterial({ color: '#ffffff', map: tile, roughness: 0.35 }),
    pool: new THREE.MeshStandardMaterial({ color: '#bdeef5', map: ripple, transparent: true, opacity: 0.8, roughness: 0.05, metalness: 0.2, depthWrite: false, emissive: '#0d6a80', emissiveIntensity: 0 }),
    foam: new THREE.MeshBasicMaterial({ map: canvasTex(foamCanvas(), renderer), transparent: true, depthWrite: false, opacity: 0.8 }),
    sign: new THREE.MeshStandardMaterial({ map: signTex, emissive: '#ffffff', emissiveMap: signTex, emissiveIntensity: 0.1, roughness: 0.5, alphaTest: 0.5 }),
    rider: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.55 }),
    uTime,
    uGlow,
  };
}

// ------------------------------------------------------------------------------------------------
// The flumes
// ------------------------------------------------------------------------------------------------

interface Detail {
  /** Ring spacing along the flume (m), segments up each wall and across the bottom. */
  step: number;
  side: number;
  mid: number;
}

const DETAIL: Record<Tier, Detail> = {
  high: { step: 0.5, side: 5, mid: 14 },
  medium: { step: 0.5, side: 4, mid: 12 },
  low: { step: 1, side: 3, mid: 9 },
  lowest: { step: 1, side: 3, mid: 8 },
};

/** One entry round a cross-section: its angle from the bottom and whether it's in the stripe. */
interface Spoke {
  a: number;
  stripe: boolean;
}

/**
 * The cross-section's spokes from the left lip (−L) under the bottom to the right lip (R): the
 * same count whatever the lips, so neighbouring rings always join up; the stripe's edges are
 * doubled so its colour is crisp.
 */
function spokes(L: number, R: number, d: Detail): Spoke[] {
  const out: Spoke[] = [];
  const run = (a0: number, a1: number, n: number, stripe: boolean) => {
    for (let i = 0; i <= n; i++) out.push({ a: a0 + ((a1 - a0) * i) / n, stripe });
  };
  const [b0, b1] = STRIPE;
  const l1 = Math.min(L, b1);
  const l0 = Math.min(L, b0);
  const r1 = Math.min(R, b1);
  const r0 = Math.min(R, b0);
  run(-L, -l1, d.side, false);
  run(-l1, -l0, 1, true);
  run(-l0, r0, d.mid, false);
  run(r0, r1, 1, true);
  run(r1, R, d.side, false);
  return out;
}

const dirOf = (f: { r: THREE.Vector3; u: THREE.Vector3 }, a: number, out: THREE.Vector3) => out.copy(f.r).multiplyScalar(Math.sin(a)).addScaledVector(f.u, -Math.cos(a));

interface FlumeSoups {
  shell: Soup;
  inner: Soup;
  clear: Soup;
  water: Soup;
  led: Soup;
}

/** The ring positions along a flume: every `step`, plus a pair either side of each joint. */
function ringStations(length: number, step: number) {
  const s = new Set<number>();
  for (let x = 0; x < length; x += step) s.add(Math.round(x * 1000) / 1000);
  s.add(length);
  for (let j = JOINT; j < length - 0.5; j += JOINT) {
    s.add(j - 0.04);
    s.add(j + 0.04);
  }
  return [...s].sort((a, b) => a - b);
}

/** Lip angles at arc length s (π for a closed tube). */
function lips(path: SlidePath, s: number) {
  const i = THREE.MathUtils.clamp(Math.round(s / DS), 0, path.lipL.length - 1);
  return [path.lipL[i], path.lipR[i]] as const;
}

const isClosed = (sec: string) => sec === 'tube' || sec === 'clear';

function flume(path: SlidePath, d: Detail, o: FlumeSoups) {
  const spec = path.spec;
  const R = spec.radius;
  const body = new THREE.Color(spec.colour);
  const stripe = new THREE.Color(spec.stripe);
  const flange = body.clone().multiplyScalar(0.82);
  const innerBody = body.clone().lerp(new THREE.Color('#ffffff'), 0.22);
  const innerJoint = innerBody.clone().multiplyScalar(0.84);
  const clearTint = body.clone().lerp(new THREE.Color('#e8f6ff'), 0.2);
  const led = new THREE.Color(spec.led);
  const st = ringStations(path.length, d.step);
  const fa = frame();
  const fb = frame();
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const D = new THREE.Vector3();
  const ring = (soup: Soup, f: typeof fa, sp: Spoke[], rad: number, outward: boolean, col: (s: Spoke) => THREE.Color, v: number, glow: number) =>
    sp.map((k) => {
      dirOf(f, k.a, D);
      P.copy(f.p).addScaledVector(D, rad);
      N.copy(D).multiplyScalar(outward ? 1 : -1);
      return soup.vert(P, N, col(k), 0, v, glow);
    });
  /** A lip's edge (inner surface → rolled bead → outer surface) between two stations. */
  const lipEdge = (fA: typeof fa, fB: typeof fa, aA: number, aB: number, side: 1 | -1) => {
    const rowsA: number[] = [];
    const rowsB: number[] = [];
    for (const [f, a, rows] of [
      [fA, aA, rowsA],
      [fB, aB, rowsB],
    ] as const) {
      const tangent = new THREE.Vector3().copy(f.r).multiplyScalar(Math.cos(a)).addScaledVector(f.u, Math.sin(a)).multiplyScalar(side);
      for (const [rad, da] of [
        [R, 0],
        [R + TH / 2, 0.035 * side],
        [R + TH, 0],
      ] as const) {
        dirOf(f, a + da, D);
        P.copy(f.p).addScaledVector(D, rad);
        rows.push(o.shell.vert(P, tangent, body));
      }
    }
    // the right edge faces +θ: wind the radial-then-along quads one way, the left edge the other
    o.shell.strip(rowsA, rowsB, side < 0);
  };

  for (let k = 0; k + 1 < st.length; k++) {
    const s0 = st[k];
    const s1 = st[k + 1];
    const mid = (s0 + s1) / 2;
    const sec = sectionAt(path, mid);
    const closed = isClosed(sec);
    const joint = Math.abs(mid - Math.round(mid / JOINT) * JOINT) < 0.05 && mid > 0.5;
    sampleSlide(path, s0, fa);
    sampleSlide(path, s1, fb);
    const [La, Ra] = closed ? [Math.PI, Math.PI] : lips(path, s0);
    const [Lb, Rb] = closed ? [Math.PI, Math.PI] : lips(path, s1);
    const spA = spokes(La, Ra, d);
    const spB = spokes(Lb, Rb, d);
    const v0 = s0 * 0.5;
    const v1 = s1 * 0.5;

    // the shell: opaque outside and in, or (clear sections, bar their flanges) one see-through wall
    if (sec === 'clear' && !joint) {
      o.clear.strip(ring(o.clear, fa, spA, R + 0.02, true, () => clearTint, v0, 0), ring(o.clear, fb, spB, R + 0.02, true, () => clearTint, v1, 0), true);
    } else {
      const ro = R + TH + (joint ? FLANGE : 0);
      const outer = (s: Spoke) => (joint ? flange : s.stripe ? stripe : body);
      o.shell.strip(ring(o.shell, fa, spA, ro, true, outer, v0, 0), ring(o.shell, fb, spB, ro, true, outer, v1, 0), true);
      const glow = closed ? 1 : 0;
      const ic = () => (joint ? innerJoint : innerBody);
      o.inner.strip(ring(o.inner, fa, spA, R, false, ic, v0, glow), ring(o.inner, fb, spB, R, false, ic, v1, glow), false);
      if (joint) {
        // the flange's two faces, front and back
        for (const [f, sp, sign] of [
          [fa, spA, -1],
          [fb, spB, 1],
        ] as const) {
          const n = f.t.clone().multiplyScalar(sign);
          const inRow = sp.map((q) => o.shell.vert(P.copy(f.p).addScaledVector(dirOf(f, q.a, D), R + TH), n, flange));
          const outRow = sp.map((q) => o.shell.vert(P.copy(f.p).addScaledVector(dirOf(f, q.a, D), R + TH + FLANGE), n, flange));
          o.shell.strip(inRow, outRow, sign < 0);
        }
      }
    }
    if (!closed) {
      lipEdge(fa, fb, Ra, Rb, 1);
      lipEdge(fa, fb, -La, -Lb, -1);
    }

    // the water: a film over the floor, or the splash lane's standing water
    if (sec === 'lane') {
      const laneRow = (f: typeof fa, v: number) => {
        const h = R - LANE_DEPTH;
        const w = Math.sqrt(R * R - h * h);
        return [-1, -0.5, 0, 0.5, 1].map((x) => o.water.vert(P.copy(f.p).addScaledVector(f.u, -h).addScaledVector(f.r, x * w), f.u, WATER_COL, (x + 1) / 2, v));
      };
      o.water.strip(laneRow(fa, v0), laneRow(fb, v1), false);
    } else {
      const film = (f: typeof fa, v: number) =>
        [0, 1, 2, 3, 4, 5, 6].map((i) => {
          const a = -FILM + (2 * FILM * i) / 6;
          dirOf(f, a, D);
          return o.water.vert(P.copy(f.p).addScaledVector(D, R - 0.012), N.copy(D).negate(), WATER_COL, i / 6, v);
        });
      o.water.strip(film(fa, v0), film(fb, v1), false);
    }

    // LED strips: along both lips of an open trough, along the crown of a tube (outside and in)
    const ledStrip = (soup: Soup, fA: typeof fa, fB: typeof fa, a0A: number, a1A: number, a0B: number, a1B: number, rad: number, outward: boolean) => {
      const row = (f: typeof fa, a0: number, a1: number) =>
        [a0, a1].map((a) => {
          dirOf(f, a, D);
          return soup.vert(P.copy(f.p).addScaledVector(D, rad), N.copy(D).multiplyScalar(outward ? 1 : -1), led);
        });
      soup.strip(row(fA, a0A, a1A), row(fB, a0B, a1B), outward);
    };
    if (closed) {
      ledStrip(o.led, fa, fb, Math.PI - 0.035, Math.PI + 0.035, Math.PI - 0.035, Math.PI + 0.035, R + TH + (joint ? FLANGE : 0) + 0.004, true);
      ledStrip(o.led, fa, fb, Math.PI - 0.04, Math.PI + 0.04, Math.PI - 0.04, Math.PI + 0.04, R - 0.004, false);
    } else {
      ledStrip(o.led, fa, fb, Ra - 0.11, Ra - 0.06, Rb - 0.11, Rb - 0.06, R + TH + 0.004, true);
      ledStrip(o.led, fa, fb, -La + 0.06, -La + 0.11, -Lb + 0.06, -Lb + 0.11, R + TH + 0.004, true);
    }
  }
  spill(path, o.water);
}

const WATER_COL = new THREE.Color('#ffffff');

/** The flume's water pouring off its lip into the pool: a short falling sheet. */
function spill(path: SlidePath, soup: Soup) {
  const f = frame();
  sampleSlide(path, path.length, f);
  const R = path.spec.radius;
  const v0 = 2.6;
  const rows: number[][] = [];
  const P = new THREE.Vector3();
  const D = new THREE.Vector3();
  const N = new THREE.Vector3();
  const lane = sectionAt(path, path.length) === 'lane';
  const drop = f.p.y - R + (lane ? LANE_DEPTH : 0.01) - POOL.water;
  const tEnd = Math.sqrt((2 * drop) / 9.81);
  for (let i = 0; i <= 6; i++) {
    const t = (tEnd * i) / 6;
    const along = v0 * t;
    const down = 0.5 * 9.81 * t * t;
    const row: number[] = [];
    for (let j = 0; j <= 4; j++) {
      const a = -FILM + (2 * FILM * j) / 4;
      dirOf(f, a, D);
      const spread = 1 + t * 0.6;
      P.copy(f.p)
        .addScaledVector(f.t, along)
        .addScaledVector(f.r, Math.sin(a) * (R - 0.012) * spread)
        .addScaledVector(f.u, -Math.cos(a) * (R - 0.012) + (lane ? LANE_DEPTH * 0.7 : 0) - down);
      N.copy(f.t).multiplyScalar(-0.3).add(f.u).normalize();
      row.push(soup.vert(P, N, WATER_COL, j / 4, (path.length + along + down) * 0.5));
    }
    rows.push(row);
  }
  for (let i = 0; i + 1 < rows.length; i++) soup.strip(rows[i], rows[i + 1], false);
}

// ------------------------------------------------------------------------------------------------
// Supports
// ------------------------------------------------------------------------------------------------

interface ColliderBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  rotY: number;
}
interface ColliderCyl {
  x: number;
  z: number;
  r: number;
  h: number;
}

/**
 * Steel columns with U-cradles every few metres where nothing runs underneath; the helices
 * hang off a central mast on radial arms instead (a column there would pierce the turn below).
 */
function supports(paths: SlidePath[], metal: Batch, cyl: ColliderCyl[]) {
  const f = frame();
  const m = new THREE.Matrix4();
  const back = new THREE.Vector3();
  const every = Math.round(4.5 / DS);
  const blocked = (x: number, z: number, y: number, self: SlidePath, i: number) => {
    for (const q of paths) {
      const R = q.spec.radius + TH + 0.35;
      for (let j = 0; j < q.pos.length; j += 2) {
        if (q === self && Math.abs(j - i) < 12) continue;
        const p = q.pos[j];
        if (p.y < y && Math.abs(p.x - x) < R && Math.abs(p.z - z) < R && Math.hypot(p.x - x, p.z - z) < R) return true;
      }
    }
    return false;
  };
  const inTower = (x: number, z: number) => Math.abs(x - TOWER.x) < TOWER.half + 0.4 && Math.abs(z - TOWER.z) < TOWER.half + 0.4;
  const inPool = (x: number, z: number) => x > POOL.x0 - 0.5 && x < POOL.x1 + 0.5 && z > POOL.z0 - 0.3 && z < POOL.z1 + 0.5;
  for (const path of paths) {
    const spec = path.spec;
    const R = spec.radius + TH;
    const masts = new Map<number, { x: number; z: number; top: number }>();
    for (let i = every; i < path.pos.length - 2; i += every) {
      sampleSlide(path, i * DS, f);
      const bottom = f.p.clone().addScaledVector(f.u, -R);
      if (bottom.y < 0.45 || inTower(bottom.x, bottom.z) || inPool(bottom.x, bottom.z)) continue;
      // the U-cradle: a cross beam under the flume and two cheeks up its sides
      back.copy(f.t).negate();
      m.makeBasis(f.r, f.u, back).setPosition(bottom.clone().addScaledVector(f.u, -0.07));
      metal.box(2 * R + 0.24, 0.14, 0.16, STEEL, m.clone());
      for (const side of [-1, 1]) {
        m.makeBasis(f.r, f.u, back).setPosition(bottom.clone().addScaledVector(f.r, side * (R + 0.06)).addScaledVector(f.u, R * 0.45));
        metal.box(0.08, R * 0.9 + 0.1, 0.12, STEEL, m.clone());
      }
      const piece = spec.pieces[path.piece[i]];
      const helix = piece.t === 'turn' && Math.abs(piece.angle) >= 300;
      if (helix) {
        let mast = masts.get(path.piece[i]);
        if (!mast) {
          // the axis: the middle of the helix's first full turn in plan
          const turn = Math.round((Math.PI * 2 * piece.radius) / DS);
          let x = 0;
          let z = 0;
          let n = 0;
          let top = 0;
          for (let j = 0; j < path.pos.length; j++) {
            if (path.piece[j] !== path.piece[i]) continue;
            top = Math.max(top, path.pos[j].y);
            if (n >= turn) continue;
            x += path.pos[j].x;
            z += path.pos[j].z;
            n++;
          }
          mast = { x: x / n, z: z / n, top };
          masts.set(path.piece[i], mast);
        }
        // a radial arm from the mast to the cradle
        const dx = bottom.x - mast.x;
        const dz = bottom.z - mast.z;
        const len = Math.hypot(dx, dz);
        metal.box(0.16, 0.22, len, STEEL, place(mast.x + dx / 2, bottom.y - 0.18, mast.z + dz / 2, Math.atan2(-dx, -dz)));
        continue;
      }
      if (blocked(bottom.x, bottom.z, bottom.y, path, i)) continue;
      const h = bottom.y - 0.14;
      metal.add(post(0.14, 0.12, h, 10), STEEL, place(bottom.x, 0, bottom.z));
      metal.box(0.5, 0.08, 0.5, GRATE, place(bottom.x, 0.04, bottom.z));
      cyl.push({ x: bottom.x, z: bottom.z, r: 0.2, h });
    }
    for (const mast of masts.values()) {
      metal.add(post(0.34, 0.3, mast.top + 0.4, 14), TEAL, place(mast.x, 0, mast.z));
      metal.box(1.1, 0.12, 1.1, GRATE, place(mast.x, 0.06, mast.z));
      metal.add(new THREE.SphereGeometry(0.36, 12, 8), WHITE, place(mast.x, mast.top + 0.4, mast.z));
      cyl.push({ x: mast.x, z: mast.z, r: 0.42, h: mast.top });
    }
  }
}

/** Box colliders along any flume that runs low enough to walk into (the run-outs near the pool). */
function lowColliders(paths: SlidePath[], boxes: ColliderBox[]) {
  const f = frame();
  for (const path of paths) {
    const R = path.spec.radius + TH;
    for (let s = 1.5; s < path.length; s += 3) {
      sampleSlide(path, s, f);
      const bottom = f.p.y - R;
      if (bottom > 2.1 || f.p.z > POOL.z0 - 0.5) continue;
      const top = f.p.y + R;
      boxes.push({ x: f.p.x, y: top / 2, z: f.p.z, hx: R, hy: top / 2, hz: 1.6, rotY: Math.atan2(f.t.x, f.t.z) });
    }
  }
}

// ------------------------------------------------------------------------------------------------
// The tower
// ------------------------------------------------------------------------------------------------

interface TowerBatches {
  paint: Batch;
  metal: Batch;
  glass: Batch;
  fabric: Batch;
  stone: Batch;
}

/** A box from a to b (centre line), w × h in section, its width kept level. */
function beam(b: Batch, a: THREE.Vector3, c: THREE.Vector3, w: number, h: number, colour: string) {
  const d = c.clone().sub(a);
  const len = d.length();
  const yaw = Math.atan2(-d.x, -d.z);
  const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  const m = place((a.x + c.x) / 2, (a.y + c.y) / 2, (a.z + c.z) / 2, yaw).multiply(new THREE.Matrix4().makeRotationX(pitch));
  b.box(w, h, len, colour, m);
}

/** A railing between two points at deck height y: posts, a top rail, a mid rail and (optionally) glass. */
function railing(t: TowerBatches, x0: number, z0: number, x1: number, z1: number, y: number, glass: boolean) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 1.5));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const z = z0 + ((z1 - z0) * i) / n;
    t.metal.add(post(0.03, 0.03, 1.1, 6), STEEL, place(x, y, z));
  }
  const a = new THREE.Vector3(x0, y + 1.1, z0);
  const b = new THREE.Vector3(x1, y + 1.1, z1);
  beam(t.metal, a, b, 0.06, 0.05, STEEL);
  beam(t.metal, a.clone().setY(y + 0.55), b.clone().setY(y + 0.55), 0.03, 0.03, STEEL);
  if (glass) beam(t.glass, a.clone().setY(y + 0.58), b.clone().setY(y + 0.58), 0.02, 0.96, '#ffffff');
}

/** The deck's start gates: where each slide leaves the tower (local, world-facing direction). */
export interface Gate {
  /** Centre of the gate on the deck's edge, and the way out (unit, horizontal). */
  x: number;
  z: number;
  out: THREE.Vector3;
  /** Half the gate's width. */
  half: number;
  /** The traffic light's lamps (red above green), facing the deck. */
  red: THREE.Vector3;
  green: THREE.Vector3;
}

function tower(t: TowerBatches, paths: SlidePath[], d: { glass: boolean }, boxes: ColliderBox[]) {
  const cx = TOWER.x;
  const cz = TOWER.z;
  const H = TOWER.deck;
  const half = TOWER.half;
  const c = 4.35;
  // the canopy's corners alternate high and low (a hypar sail); the corner columns run up to them
  const roof = (sx: number, sz: number) => (sx * sz < 0 ? H + 4.7 : H + 3.0);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const h = roof(sx, sz);
      t.paint.box(0.42, h, 0.42, WHITE, place(cx + sx * c, h / 2, cz + sz * c));
      t.paint.box(0.26, H, 0.26, WHITE, place(cx + sx * 3.0, H / 2, cz + sz * 3.0));
      t.metal.box(0.8, 0.1, 0.8, GRATE, place(cx + sx * c, 0.05, cz + sz * c));
    }
  // ring beams, and cross bracing on every face between them
  for (const y of [6, 12, 18, H - 0.45]) {
    for (const s of [-1, 1]) {
      t.paint.box(2 * c, 0.3, 0.24, TEAL, place(cx, y, cz + s * c));
      t.paint.box(0.24, 0.3, 2 * c, TEAL, place(cx + s * c, y, cz));
    }
  }
  for (let y = 0; y < H - 1; y += 6) {
    const y1 = Math.min(H - 0.45, y + 6);
    for (const s of [-1, 1]) {
      for (const [a, b] of [
        [-1, 1],
        [1, -1],
      ]) {
        beam(t.metal, new THREE.Vector3(cx + a * c, y + 0.2, cz + s * (c + 0.1)), new THREE.Vector3(cx + b * c, y1 - 0.2, cz + s * (c + 0.1)), 0.07, 0.07, TEAL);
        beam(t.metal, new THREE.Vector3(cx + s * (c + 0.1), y + 0.2, cz + a * c), new THREE.Vector3(cx + s * (c + 0.1), y1 - 0.2, cz + b * c), 0.07, 0.07, TEAL);
      }
    }
  }
  // the stair: eight flights of 3 m, clockwise round the inside of the frame, landings at the corners
  for (let k = 0; k < FLIGHTS; k++) {
    const [ax, az] = CORNERS[k % 4];
    const [bx, bz] = CORNERS[(k + 1) % 4];
    const dir = new THREE.Vector3(bx - ax, 0, bz - az).normalize();
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    const y0 = k * FLIGHT_RISE;
    const start = new THREE.Vector3(cx + ax, y0, cz + az).addScaledVector(dir, 0.75);
    const end = new THREE.Vector3(cx + bx, y0 + FLIGHT_RISE, cz + bz).addScaledVector(dir, -0.75);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const steps = 15;
    for (let i = 0; i < steps; i++) {
      const p = start.clone().addScaledVector(dir, 0.2 + (i * 6) / steps);
      t.metal.box(1.24, 0.04, 0.36, GRATE, place(p.x, y0 + ((i + 1) * FLIGHT_RISE) / steps - 0.02, p.z, yaw));
    }
    // the outer side of the flight is the one nearer the tower's face
    const outSide = across.x * ax + across.z * az > 0 ? 1 : -1;
    for (const side of [-1, 1]) {
      const o = across.clone().multiplyScalar(side * 0.66);
      beam(t.paint, start.clone().add(o).setY(y0 - 0.05), end.clone().add(o).setY(end.y - 0.05), 0.08, 0.26, TEAL);
      const rail = new THREE.Vector3(0, 0.95, 0);
      beam(t.metal, start.clone().add(o).add(rail), end.clone().add(o).add(rail), 0.05, 0.05, STEEL);
      if (side === outSide && d.glass) beam(t.glass, start.clone().add(o).setY(y0 + 0.5), end.clone().add(o).setY(end.y + 0.5), 0.02, 0.8, '#ffffff');
    }
    if (k > 0) {
      // the landing this flight leaves from, and its rails on the two outer sides
      t.metal.box(1.5, 0.1, 1.5, GRATE, place(cx + ax, y0 - 0.05, cz + az));
      railing(t, cx + Math.sign(ax) * 4.5, cz + az - 0.75, cx + Math.sign(ax) * 4.5, cz + az + 0.75, y0, false);
      railing(t, cx + ax - 0.75, cz + Math.sign(az) * 4.5, cx + ax + 0.75, cz + Math.sign(az) * 4.5, y0, false);
    }
  }
  // the deck: one slab, with the stairwell open along the north side above the last flight
  const top = H;
  const th = 0.35;
  const slab = (x0: number, x1: number, z0: number, z1: number) => t.paint.box(x1 - x0, th, z1 - z0, '#e3eaec', place(cx + (x0 + x1) / 2, top - th / 2, cz + (z0 + z1) / 2));
  slab(-4.65, 4.65, -3.0, 4.65);
  slab(-4.65, -3.0, -4.65, -3.0);
  slab(3.0, 4.65, -4.65, -3.0);
  // the deck's railings: round the stairwell, and round the edge with gaps at the three gates
  railing(t, cx - 3.0, cz - 3.0, cx + 3.0, cz - 3.0, top, d.glass);
  railing(t, cx - 3.0, cz - 4.6, cx - 3.0, cz - 3.0, top, d.glass);
  railing(t, cx - 4.6, cz - 4.6, cx + 4.6, cz - 4.6, top, d.glass);
  const gates: Gate[] = [];
  for (const p of paths) {
    const t0 = p.tan[0];
    const out = new THREE.Vector3(t0.x, 0, t0.z).normalize();
    const along = new THREE.Vector3(-out.z, 0, out.x);
    const gx = cx + out.x * 4.6;
    const gz = cz + out.z * 4.6;
    const halfW = p.spec.radius + 0.35;
    gates.push({
      x: gx,
      z: gz,
      out,
      half: halfW,
      red: new THREE.Vector3(gx, top + 2.25, gz).addScaledVector(along, halfW + 0.02).addScaledVector(out, -0.12),
      green: new THREE.Vector3(gx, top + 1.98, gz).addScaledVector(along, halfW + 0.02).addScaledVector(out, -0.12),
    });
    // the gate's frame: two posts and a lintel that carries the board
    for (const side of [-1, 1]) {
      const pp = new THREE.Vector3(gx, top, gz).addScaledVector(along, side * halfW);
      t.paint.box(0.16, 2.6, 0.16, p.spec.colour, place(pp.x, top + 1.3, pp.z));
    }
    const lintel = new THREE.Vector3(gx, top + 2.62, gz);
    t.paint.box(Math.abs(along.x) * (2 * halfW + 0.3) + 0.16, 0.16, Math.abs(along.z) * (2 * halfW + 0.3) + 0.16, p.spec.colour, place(lintel.x, lintel.y, lintel.z));
    // a light box for the lamps on the right post (seen from the deck)
    const box = new THREE.Vector3(gx, top + 2.11, gz).addScaledVector(along, halfW + 0.02).addScaledVector(out, -0.02);
    t.paint.box(0.22, 0.6, 0.22, '#23272b', place(box.x, box.y, box.z));
    // edge railings either side of the gate, to the corners
    for (const side of [-1, 1]) {
      const a = new THREE.Vector3(gx, 0, gz).addScaledVector(along, side * (halfW + 0.12));
      const b = new THREE.Vector3(gx, 0, gz).addScaledVector(along, side * 4.6);
      // the north edge is railed already (the stairwell side); skip a gate's rails into it
      railing(t, a.x, a.z, b.x, b.z, top, d.glass);
    }
  }
  // the sail canopy: a hypar in gores of white and teal, edged with a cable
  const corners = [
    new THREE.Vector3(cx - c, roof(-1, -1), cz - c),
    new THREE.Vector3(cx + c, roof(1, -1), cz - c),
    new THREE.Vector3(cx + c, roof(1, 1), cz + c),
    new THREE.Vector3(cx - c, roof(-1, 1), cz + c),
  ];
  const at = (u: number, v: number) => {
    const a = corners[0].clone().lerp(corners[1], u);
    const b = corners[3].clone().lerp(corners[2], u);
    return a.lerp(b, v);
  };
  const gores = 8;
  const rows = 8;
  for (let gi = 0; gi < gores; gi++) {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= rows; i++)
      for (let j = 0; j <= 1; j++) {
        const p = at((gi + j) / gores, i / rows);
        // the sail sags a little between its corners
        const u = (gi + j) / gores;
        const v = i / rows;
        p.y -= 0.35 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI);
        pos.push(p.x, p.y, p.z);
      }
    for (let i = 0; i < rows; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    t.fabric.add(g, gi % 2 ? TEAL : '#fbf7ee');
  }
  for (let i = 0; i < 4; i++) beam(t.metal, corners[i], corners[(i + 1) % 4], 0.05, 0.05, STEEL);

  // the tower's base is closed off: a box collider round the frame
  boxes.push({ x: cx, y: 1.5, z: cz, hx: half + 0.2, hy: 1.5, hz: half + 0.2, rotY: 0 });
  return gates;
}

/** The splash pool: a raised basin with a tiled floor and walls, coping, steps out, and a paved surround. */
function pool(t: TowerBatches, tileGeo: THREE.BufferGeometry[], boxes: ColliderBox[], paths: SlidePath[]) {
  const { x0, x1, z0, z1, rim } = POOL;
  const w = x1 - x0;
  const dd = z1 - z0;
  const wall = 0.3;
  // tiled floor and inner walls (uv in metres: one tile a metre)
  const floor = new THREE.PlaneGeometry(w, dd).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0.03, (z0 + z1) / 2);
  metreUv(floor, 'xz');
  tileGeo.push(floor);
  const inner = (len: number, x: number, z: number, ry: number, axis: 'xy' | 'zy') => {
    const g = new THREE.PlaneGeometry(len, rim - 0.03).rotateY(ry).translate(x, (rim + 0.03) / 2, z);
    metreUv(g, axis);
    tileGeo.push(g);
  };
  inner(w, (x0 + x1) / 2, z0 + 0.005, 0, 'xy');
  inner(w, (x0 + x1) / 2, z1 - 0.005, Math.PI, 'xy');
  inner(dd, x0 + 0.005, (z0 + z1) / 2, Math.PI / 2, 'zy');
  inner(dd, x1 - 0.005, (z0 + z1) / 2, -Math.PI / 2, 'zy');
  // the walls' outsides and the coping
  const wallBox = (cx: number, cz: number, hx: number, hz: number) => {
    t.paint.box(hx * 2, rim, hz * 2, '#f2efe6', place(cx, rim / 2, cz));
    t.stone.box(hx * 2 + 0.24, 0.08, hz * 2 + 0.24, '#efe4cc', place(cx, rim + 0.04, cz));
    boxes.push({ x: cx, y: rim / 2, z: cz, hx, hy: rim / 2, hz, rotY: 0 });
  };
  wallBox((x0 + x1) / 2, z0 - wall / 2, w / 2 + wall, wall / 2);
  wallBox((x0 + x1) / 2, z1 + wall / 2, w / 2 + wall, wall / 2);
  wallBox(x0 - wall / 2, (z0 + z1) / 2, wall / 2, dd / 2);
  wallBox(x1 + wall / 2, (z0 + z1) / 2, wall / 2, dd / 2);
  // a dark lane line on the floor out from each slide, and the steps out on the south side
  for (const p of paths) {
    const e = p.pos[p.pos.length - 1];
    t.paint.box(0.3, 0.02, 12, '#1f5f8f', place(e.x, 0.045, z0 + 7));
    t.paint.box(1.4, 0.02, 0.3, '#1f5f8f', place(e.x, 0.045, z0 + 13));
  }
  for (const sx of [-14, 14]) {
    for (let i = 0; i < 3; i++) t.paint.box(2.4, 0.28, 0.4, '#f2efe6', place(sx, 0.14 + i * 0.28, z1 - 0.2 - (2 - i) * 0.4));
    for (const hx of [-1.1, 1.1]) {
      t.metal.add(post(0.025, 0.025, 1.0, 6), STEEL, place(sx + hx, rim, z1 + 0.08));
      beam(t.metal, new THREE.Vector3(sx + hx, rim + 1.0, z1 + 0.08), new THREE.Vector3(sx + hx, 0.9, z1 - 1.2), 0.04, 0.04, STEEL);
    }
  }
  // the paved surround, laid on the ground
  const pave = (ax: number, bx: number, az: number, bz: number) => t.stone.box(bx - ax, 0.04, bz - az, '#efe2c4', place((ax + bx) / 2, 0.02, (az + bz) / 2));
  pave(x0 - 3.5, x1 + 3.5, z1 + wall, z1 + 3.5);
  pave(x0 - 3.5, x1 + 3.5, z0 - 3.0, z0 - wall);
  pave(x0 - 3.5, x0 - wall, z0 - wall, z1 + wall);
  pave(x1 + wall, x1 + 3.5, z0 - wall, z1 + wall);
  // a lifeguard's high chair at the south-east corner
  const lx = x1 + 1.8;
  const lz = z1 - 3;
  for (const [ox, oz] of [
    [-0.4, -0.4],
    [0.4, -0.4],
    [-0.4, 0.4],
    [0.4, 0.4],
  ])
    t.paint.box(0.08, 2.0, 0.08, WHITE, place(lx + ox, 1.0, lz + oz));
  t.paint.box(0.9, 0.08, 0.9, '#d6402f', place(lx, 2.0, lz));
  t.paint.box(0.9, 0.6, 0.06, '#d6402f', place(lx + 0.45, 2.3, lz, Math.PI / 2));
  t.metal.add(post(0.025, 0.025, 2.6, 6), STEEL, place(lx - 0.3, 2.0, lz));
  t.fabric.add(new THREE.ConeGeometry(1.1, 0.4, 10, 1, true).translate(0, 0.2, 0), '#d6402f', place(lx - 0.3, 4.4, lz));
  boxes.push({ x: lx, y: 1.0, z: lz, hx: 0.5, hy: 1.0, hz: 0.5, rotY: 0 });
}

function metreUv(g: THREE.BufferGeometry, axes: 'xz' | 'xy' | 'zy') {
  const p = g.attributes.position;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const a = axes === 'zy' ? p.getZ(i) : p.getX(i);
    const b = axes === 'xz' ? p.getZ(i) : p.getY(i);
    uv.setXY(i, a, b);
  }
}

/** The entrance arch over the path in from the east, and the queue's paving and rope barriers. */
function entrance(t: TowerBatches, boxes: ColliderBox[]) {
  const { x, z } = ENTRANCE;
  for (const s of [-1, 1]) {
    t.paint.box(0.6, 4.4, 0.6, TEAL, place(x, 2.2, z + s * 2.6));
    t.paint.box(0.9, 0.3, 0.9, WHITE, place(x, 4.5, z + s * 2.6));
    boxes.push({ x, y: 2.2, z: z + s * 2.6, hx: 0.3, hy: 2.2, hz: 0.3, rotY: 0 });
  }
  t.paint.box(0.3, 0.3, 5.8, WHITE, place(x, 4.1, z));
  // paving along the queue
  for (let i = 0; i + 1 < QUEUE.length; i++) {
    const a = QUEUE[i];
    const b = QUEUE[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) + 2.4;
    t.stone.box(2.4, 0.04, len, '#f2e7cf', place((a.x + b.x) / 2, 0.025, (a.z + b.z) / 2, Math.atan2(-(b.x - a.x), -(b.z - a.z))));
  }
  // stanchions and ropes along both sides of the queue (from the arch to the stair)
  for (let i = 1; i + 1 < QUEUE.length; i++) {
    const a = QUEUE[i];
    const b = QUEUE[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    for (const side of [-1.25, 1.25]) {
      const n = Math.max(1, Math.round(len / 3));
      for (let k = 0; k <= n; k++) {
        const px = a.x + dx * (len * k) / n - dz * side;
        const pz = a.z + dz * (len * k) / n + dx * side;
        t.metal.add(post(0.035, 0.03, 0.95, 6), '#c9a227', place(px, 0, pz));
      }
      beam(t.fabric, new THREE.Vector3(a.x - dz * side, 0.85, a.z + dx * side), new THREE.Vector3(b.x - dz * side, 0.85, b.z + dx * side), 0.03, 0.03, '#c0283a');
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Riders and the people on the tower
// ------------------------------------------------------------------------------------------------

export type Pose = 'lie' | 'ring' | 'stand';

export interface Look {
  skin: string;
  suit: string;
  hair: string;
  /** A one-piece swimsuit (else trunks and a bare chest). */
  onePiece: boolean;
  ring?: string;
}

export const LOOKS: Look[] = [
  { skin: '#e9b48c', suit: '#e8333b', hair: '#3a2416', onePiece: true },
  { skin: '#8d5a3b', suit: '#1e7fd6', hair: '#17110c', onePiece: false },
  { skin: '#f1c9a5', suit: '#2ec4b6', hair: '#c99a4a', onePiece: true, ring: '#ff8a3d' },
  { skin: '#c68a5e', suit: '#ffc23d', hair: '#2a1a10', onePiece: false, ring: '#ffd23d' },
  { skin: '#6b4430', suit: '#7b5cd6', hair: '#120c08', onePiece: true },
  { skin: '#e2a982', suit: '#ff5d7a', hair: '#5a3a1e', onePiece: false },
];

/**
 * A rider as one small mesh: lying feet first on a body slide (arms crossed), sitting in a ring, or
 * standing. Local frame: +Y away from the surface they're on, −Z the way they face (feet first).
 */
export function riderGeometry(pose: Pose, look: Look) {
  const parts: THREE.BufferGeometry[] = [];
  const part = (g: THREE.BufferGeometry, colour: string, m: THREE.Matrix4) => {
    const geo = g.toNonIndexed();
    geo.deleteAttribute('uv');
    geo.applyMatrix4(m);
    const c = new THREE.Color(colour);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(geo);
  };
  const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 3, 8);
  const ball = (r: number) => new THREE.SphereGeometry(r, 10, 8);
  const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));
  const chest = look.onePiece ? look.suit : look.skin;
  if (pose === 'stand') {
    for (const s of [-1, 1]) {
      part(cap(0.075, 0.72), look.skin, T(s * 0.1, 0.44, 0));
      part(cap(0.05, 0.5), look.skin, T(s * 0.25, 1.12, 0, 0, 0, s * 0.12));
    }
    part(cap(0.135, 0.18), look.suit, T(0, 0.95, 0));
    part(cap(0.16, 0.26), chest, T(0, 1.24, 0));
    part(ball(0.11), look.skin, T(0, 1.6, 0));
    part(ball(0.115), look.hair, T(0, 1.64, 0.02, 0, 0, 0, 1));
  } else if (pose === 'lie') {
    // the torso rises a little towards the shoulders, the head up looking along the slide
    part(cap(0.13, 0.16), look.suit, T(0, 0.14, 0.08, Math.PI / 2 + 0.1));
    part(cap(0.155, 0.24), chest, T(0, 0.19, 0.38, Math.PI / 2 + 0.22));
    part(ball(0.105), look.skin, T(0, 0.36, 0.68));
    part(ball(0.11), look.hair, T(0, 0.38, 0.72));
    for (const s of [-1, 1]) {
      part(cap(0.072, 0.7), look.skin, T(s * 0.09, 0.09, -0.45, Math.PI / 2 - 0.04));
      if (!look.onePiece) part(cap(0.085, 0.14), look.suit, T(s * 0.09, 0.11, -0.12, Math.PI / 2));
      // arms crossed on the chest
      part(cap(0.045, 0.3), look.skin, T(s * 0.02, 0.33, 0.36, Math.PI / 2 + 0.2, s * 1.0));
    }
  } else {
    const ring = new THREE.TorusGeometry(0.46, 0.17, 10, 22).rotateX(Math.PI / 2);
    part(ring, look.ring ?? '#ff8a3d', T(0, 0.17, 0));
    part(cap(0.13, 0.14), look.suit, T(0, 0.2, 0.06, -0.5));
    part(cap(0.15, 0.24), chest, T(0, 0.5, 0.2, -0.45));
    part(ball(0.105), look.skin, T(0, 0.78, 0.33));
    part(ball(0.11), look.hair, T(0, 0.8, 0.36));
    for (const s of [-1, 1]) {
      part(cap(0.075, 0.36), look.skin, T(s * 0.1, 0.32, -0.28, Math.PI / 2 - 0.2));
      part(cap(0.065, 0.36), look.skin, T(s * 0.1, 0.2, -0.62, -0.15));
      part(cap(0.045, 0.32), look.skin, T(s * 0.33, 0.48, 0.12, 0.3, 0, s * 0.9));
    }
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------------------------------------------------------
// The whole build
// ------------------------------------------------------------------------------------------------

export interface SplashTowerBuild {
  group: THREE.Group;
  mats: SlideMaterials;
  gates: Gate[];
  /** The gates' lamps (red, green per gate) as instances: colours are set by the attraction. */
  lamps: THREE.InstancedMesh;
  /** The foam patches below the slides' lips (hidden on the low tiers). */
  foam: THREE.Mesh | null;
}

/**
 * Builds the attraction into a group standing at `anchor` (world) and adds its colliders. `paths`
 * are the three slides built by `buildSlide` (local coordinates).
 */
export function buildSplashTower(ctx: Ctx, anchor: THREE.Vector3Like, paths: SlidePath[]): SplashTowerBuild {
  const tier = ctx.quality.tier;
  const d = DETAIL[tier];
  const lean = tier === 'low' || tier === 'lowest';
  const shadows = ctx.quality.shadows;
  const { tex: signTex, cells } = signAtlas(paths);
  const mats = materials(ctx.renderer, signTex);
  const im: IslandMaterials = islandMaterials(ctx.renderer);
  const group = new THREE.Group();
  group.position.set(anchor.x, 0, anchor.z);
  group.name = 'splash-tower';

  const soups: FlumeSoups = { shell: new Soup(), inner: new Soup(), clear: new Soup(), water: new Soup(), led: new Soup() };
  for (const p of paths) flume(p, d, soups);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean, order = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadows && cast;
    m.receiveShadow = shadows && receive;
    m.renderOrder = order;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    return m;
  };
  mesh(soups.shell.build(), mats.shell, true, true);
  mesh(soups.inner.build(true), mats.inner, false, true);
  if (soups.clear.count) mesh(soups.clear.build(), mats.clear, false, false, 3);
  mesh(soups.water.build(), mats.water, false, false, 4);
  mesh(soups.led.build(), mats.led, false, false);

  const boxes: ColliderBox[] = [];
  const cyls: ColliderCyl[] = [];
  const t: TowerBatches = { paint: new Batch(), metal: new Batch(), glass: new Batch(), fabric: new Batch(), stone: new Batch() };
  supports(paths, t.metal, cyls);
  lowColliders(paths, boxes);
  const gates = tower(t, paths, { glass: !lean }, boxes);
  const tileGeo: THREE.BufferGeometry[] = [];
  pool(t, tileGeo, boxes, paths);
  entrance(t, boxes);
  for (const [b, mat, cast, receive] of [
    [t.stone, im.stone, false, true],
    [t.paint, im.paint, true, true],
    [t.metal, im.metal, true, true],
    [t.fabric, im.fabric, true, false],
    [t.glass, im.glass, false, false],
  ] as const) {
    const m = b.build(mat, shadows && cast, shadows && receive);
    if (!m) continue;
    if (mat === im.glass) m.renderOrder = 3;
    group.add(m);
  }
  const tiles = mergeGeometries(tileGeo, false)!;
  for (const g of tileGeo) g.dispose();
  mesh(tiles, mats.tile, false, true);
  const water = new THREE.PlaneGeometry(POOL.x1 - POOL.x0, POOL.z1 - POOL.z0).rotateX(-Math.PI / 2);
  metreUv(water, 'xz');
  water.translate((POOL.x0 + POOL.x1) / 2, POOL.water, (POOL.z0 + POOL.z1) / 2);
  mesh(water, mats.pool, false, false, 2);

  // foam where each slide pours in
  let foam: THREE.Mesh | null = null;
  if (!lean) {
    const quads = paths.map((p) => {
      const e = p.pos[p.pos.length - 1];
      return new THREE.PlaneGeometry(3.2, 3.2).rotateX(-Math.PI / 2).translate(e.x, POOL.water + 0.02, POOL.z0 + 1.7);
    });
    foam = mesh(mergeGeometries(quads, false)!, mats.foam, false, false, 5);
  }

  // the boards: the tower's name on its east and north faces, the arch, the gates
  const boards: THREE.BufferGeometry[] = [];
  const board = (w: number, h: number, c: Cell, x: number, y: number, z: number, ry: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, c.u0 + uv.getX(i) * (c.u1 - c.u0), c.v0 + uv.getY(i) * (c.v1 - c.v0));
    g.rotateY(ry).translate(x, y, z);
    boards.push(g);
  };
  board(8.6, 2.15, cells.tower, TOWER.x + TOWER.half + 0.12, TOWER.deck - 3.4, TOWER.z, Math.PI / 2);
  board(8.6, 2.15, cells.tower, TOWER.x, TOWER.deck - 3.4, TOWER.z - TOWER.half - 0.12, Math.PI);
  board(5.6, 1.26, cells.arch, ENTRANCE.x + 0.2, 4.95, ENTRANCE.z, Math.PI / 2);
  board(5.6, 1.26, cells.arch, ENTRANCE.x - 0.2, 4.95, ENTRANCE.z, -Math.PI / 2);
  gates.forEach((g, k) => {
    // the board faces the deck (inwards), hung on the lintel
    board(1.5, 0.77, cells.gates[k], g.x - g.out.x * 0.1, TOWER.deck + 3.12, g.z - g.out.z * 0.1, Math.atan2(-g.out.x, -g.out.z));
  });
  mesh(mergeGeometries(boards, false)!, mats.sign, false, false);

  const lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.085, 14), new THREE.MeshBasicMaterial({ color: '#ffffff' }), gates.length * 2);
  const m4 = new THREE.Matrix4();
  gates.forEach((g, k) => {
    const ry = Math.atan2(-g.out.x, -g.out.z);
    lamps.setMatrixAt(k * 2, m4.compose(g.red, new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, ry), new THREE.Vector3(1, 1, 1)));
    lamps.setMatrixAt(k * 2 + 1, m4.compose(g.green, new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, ry), new THREE.Vector3(1, 1, 1)));
    lamps.setColorAt(k * 2, new THREE.Color('#ff3b30'));
    lamps.setColorAt(k * 2 + 1, new THREE.Color('#1f3b26'));
  });
  group.add(lamps);

  // colliders, in world space
  for (const b of boxes) staticBox(ctx, anchor.x + b.x, b.y, anchor.z + b.z, b.hx, b.hy, b.hz, b.rotY);
  for (const c of cyls) staticCylinder(ctx, anchor.x + c.x, anchor.z + c.z, c.r, c.h);
  return { group, mats, gates, lamps, foam };
}

/** The people on the tower: a dispatcher on the deck, guests waiting their turn and on the stairs. */
export function towerPeople() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (look: Look, x: number, y: number, z: number, yaw: number) => {
    const g = riderGeometry('stand', look);
    g.applyMatrix4(place(x, y, z, yaw));
    parts.push(g);
  };
  const cx = TOWER.x;
  const cz = TOWER.z;
  // the dispatcher: a lifeguard in red by the south gate, facing the deck
  add({ skin: '#c68a5e', suit: '#d6402f', hair: '#1a120c', onePiece: true }, cx + 1.6, TOWER.deck, cz + 3.6, 0.3);
  add(LOOKS[4], cx - 1.8, TOWER.deck, cz - 1.6, 2.4);
  add(LOOKS[5], cx - 2.4, TOWER.deck, cz - 1.0, 2.1);
  // a few climbing the stairs (on the flights' treads)
  const onFlight = (k: number, f: number, look: Look) => {
    const [ax, az] = CORNERS[k % 4];
    const [bx, bz] = CORNERS[(k + 1) % 4];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const x = cx + ax + (dx / len) * (0.75 + 6 * f);
    const z = cz + az + (dz / len) * (0.75 + 6 * f);
    add(look, x, k * FLIGHT_RISE + f * FLIGHT_RISE + 0.1, z, Math.atan2(-dx, -dz));
  };
  onFlight(2, 0.4, LOOKS[1]);
  onFlight(5, 0.6, LOOKS[3]);
  onFlight(6, 0.3, LOOKS[0]);
  onFlight(7, 0.7, LOOKS[2]);
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return geo;
}

/** The stair as a walkable line (local): from the queue's end up all eight flights (landing, flight, landing) to the deck. */
export function stairPath(): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [new THREE.Vector3(TOWER.x + 3.75, 0, TOWER.z - 6.5)];
  for (let k = 0; k < FLIGHTS; k++) {
    const [ax, az] = CORNERS[k % 4];
    const [bx, bz] = CORNERS[(k + 1) % 4];
    const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    const y = k * FLIGHT_RISE;
    pts.push(new THREE.Vector3(TOWER.x + ax, y, TOWER.z + az));
    pts.push(new THREE.Vector3(TOWER.x + ax + dx * 0.75, y, TOWER.z + az + dz * 0.75));
    pts.push(new THREE.Vector3(TOWER.x + bx - dx * 0.75, y + FLIGHT_RISE, TOWER.z + bz - dz * 0.75));
  }
  pts.push(new THREE.Vector3(TOWER.x + 3.75, TOWER.deck, TOWER.z - 3.75), new THREE.Vector3(TOWER.x + 1.2, TOWER.deck, TOWER.z - 1.2));
  return pts;
}
