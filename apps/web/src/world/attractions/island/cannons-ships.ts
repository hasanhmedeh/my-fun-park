// Pirate Cannons: the pirate fleet. Four kinds of ship (a sloop, a brig, a galleon and the
// powder-keg sloop), each modelled once in its own frame (forward −Z, up +Y, the waterline at
// y = 0) and shared by every ship of that kind: a lofted hull with painted bands, deck,
// castles, gunports, masts, yards and spars in one mesh; sails and flags in a second (which ripple
// in the vertex shader); the rigging as lines. A Ship sails its lane in the lagoon, rides the
// swell, heels in the wind and in turns, smokes where it's been hit, and settles and goes down
// when it has taken enough.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withFogSun } from '../../fog';
import { waveY } from '../../sea';
import { canvasTex } from '../../textures';
import { mulberry } from '../../random';
import { lanePoint, laneTurn, type Lane } from './cannons-sim';

export type ShipKind = 'sloop' | 'brig' | 'galleon' | 'keg';

export interface ShipSpec {
  name: string;
  length: number;
  beam: number;
  /** Deck height above the water at midships, and the keel's depth below it. */
  freeboard: number;
  draft: number;
  /** Hits it takes to sink. */
  hp: number;
  /** Cruising speed, m/s. */
  speed: number;
  /** Points for sinking it (each hit scores HIT_POINTS on top). */
  sinkBonus: number;
  hull: string;
  stripe: string;
  sail: string;
}

export const SHIP_KINDS: Record<ShipKind, ShipSpec> = {
  sloop: { name: 'Sloop', length: 17, beam: 5.2, freeboard: 1.5, draft: 1.8, hp: 2, speed: 6.4, sinkBonus: 150, hull: '#3b2a1f', stripe: '#c9962e', sail: '#efe4cc' },
  brig: { name: 'Brig', length: 27, beam: 7.6, freeboard: 2.0, draft: 2.6, hp: 3, speed: 5, sinkBonus: 250, hull: '#1f1b1a', stripe: '#a8321f', sail: '#e9dcc0' },
  galleon: { name: 'Galleon', length: 40, beam: 11, freeboard: 2.8, draft: 3.6, hp: 5, speed: 3.2, sinkBonus: 500, hull: '#4a2c1c', stripe: '#d8a63a', sail: '#2e2a2a' },
  keg: { name: 'Powder-keg sloop', length: 15, beam: 4.8, freeboard: 1.3, draft: 1.6, hp: 1, speed: 5.6, sinkBonus: 300, hull: '#2a2321', stripe: '#d23a26', sail: '#b8321f' },
};

/** Points for each hit on a ship (times the streak multiplier). */
export const HIT_POINTS = 50;

const NAMES: Record<ShipKind, string[]> = {
  sloop: ['Salty Kipper', 'Black Gull', 'Rum Runner', 'Jolly Mackerel', 'Sea Biscuit', 'Barnacle Betty', 'Scurvy Dog', 'Bilge Rat'],
  brig: ['Crimson Squid', 'Howling Parrot', 'Grim Grog', 'Mad Marlin', 'Rusty Cutlass'],
  galleon: ['Gilded Kraken', 'Dread Doubloon', 'Iron Mermaid'],
  keg: ['Kaboom Kate', 'Powder Monkey', 'Short Fuse'],
};

// ------------------------------------------------------------------------------------------------
// Textures: a hull atlas (planks, spar grain, stern windows, plain paint, lantern glass) and a
// sail atlas (sailcloth, the Jolly Roger, the powder-keg flag)
// ------------------------------------------------------------------------------------------------

type Rect = { u0: number; u1: number; v0: number; v1: number };
/** Atlas cells, in texture coordinates (v up: canvas y 0 is v 1). */
const px = (x0: number, y0: number, x1: number, y1: number, size = 512): Rect => ({ u0: x0 / size, u1: x1 / size, v0: 1 - y1 / size, v1: 1 - y0 / size });
const HULL_UV = {
  planks: px(0, 0, 512, 256),
  grain: px(0, 256, 256, 512),
  windows: px(256, 256, 512, 384),
  plain: px(268, 400, 436, 500),
  lantern: px(452, 452, 500, 500),
};
const SAIL_UV = {
  cloth: px(0, 128, 512, 512),
  roger: px(4, 4, 252, 124),
  keg: px(260, 4, 508, 124),
};

function hullTextures(): { map: THREE.Texture; emissive: THREE.Texture } {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const e = document.createElement('canvas');
  e.width = e.height = 512;
  const eg = e.getContext('2d')!;
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, 512, 512);
  const rnd = mulberry(91);
  // planks: light grey strakes (tinted by the vertex colours), dark seams, the odd butt joint
  for (let y = 0; y < 256; y += 16) {
    const s = 205 + rnd() * 40;
    g.fillStyle = `rgb(${s},${s},${s})`;
    g.fillRect(0, y, 512, 16);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, y, 512, 2);
    for (let x = rnd() * 120; x < 512; x += 90 + rnd() * 140) g.fillRect(x, y, 2, 16);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(0,0,0,${0.04 + rnd() * 0.06})`;
      g.fillRect(rnd() * 512, y + 3 + rnd() * 11, 20 + rnd() * 60, 1);
    }
  }
  // spar grain: vertical streaks
  for (let x = 0; x < 256; x++) {
    const s = 190 + Math.sin(x * 0.7) * 12 + rnd() * 30;
    g.fillStyle = `rgb(${s},${s},${s})`;
    g.fillRect(x, 256, 1, 256);
  }
  // stern windows: four leaded lights in a gilt frame (lit from inside at night)
  g.fillStyle = '#d6b45a';
  g.fillRect(256, 256, 256, 128);
  eg.fillStyle = '#000';
  for (let i = 0; i < 4; i++) {
    const x = 266 + i * 61;
    g.fillStyle = '#5b3a1e';
    g.fillRect(x - 3, 274, 55, 92);
    g.fillStyle = '#26303a';
    g.fillRect(x, 278, 49, 84);
    eg.fillStyle = '#ffd08a';
    eg.fillRect(x, 278, 49, 84);
    g.strokeStyle = '#c9a24e';
    g.lineWidth = 2;
    for (let k = 1; k < 3; k++) {
      g.beginPath();
      g.moveTo(x + (49 * k) / 3, 278);
      g.lineTo(x + (49 * k) / 3, 362);
      g.stroke();
      eg.fillStyle = '#000';
      eg.fillRect(x + (49 * k) / 3 - 1, 278, 2, 84);
    }
    g.beginPath();
    g.moveTo(x, 320);
    g.lineTo(x + 49, 320);
    g.stroke();
    eg.fillRect(x, 319, 49, 2);
  }
  // plain paint, and the lantern glass (white, fully lit in the emissive map)
  g.fillStyle = '#ffffff';
  g.fillRect(256, 384, 256, 128);
  eg.fillStyle = '#ffe2a6';
  eg.fillRect(448, 448, 64, 64);
  const map = canvasTex(c);
  const emissive = canvasTex(e);
  return { map, emissive };
}

/** A cartoon skull and crossbones (or a bomb with a lit fuse) on a flag cell. */
function flag(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, kind: 'roger' | 'keg') {
  g.fillStyle = kind === 'roger' ? '#161414' : '#b3201c';
  g.fillRect(x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h / 2;
  g.save();
  g.translate(cx, cy);
  if (kind === 'roger') {
    g.strokeStyle = '#f2ead8';
    g.lineCap = 'round';
    g.lineWidth = 10;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(-34 * s, -34);
      g.lineTo(34 * s, 38);
      g.stroke();
      for (const [bx, by] of [
        [-34 * s, -34],
        [34 * s, 38],
      ]) {
        g.fillStyle = '#f2ead8';
        g.beginPath();
        g.arc(bx - 4, by, 7, 0, Math.PI * 2);
        g.arc(bx + 4, by, 7, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = '#f2ead8';
    g.beginPath();
    g.ellipse(0, -6, 27, 25, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(-14, 10, 28, 16);
    g.fillStyle = '#161414';
    g.beginPath();
    g.ellipse(-10, -8, 7, 8, 0, 0, Math.PI * 2);
    g.ellipse(10, -8, 7, 8, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(0, 2);
    g.lineTo(-4, 9);
    g.lineTo(4, 9);
    g.fill();
    for (let i = -1; i <= 1; i++) g.fillRect(i * 7 - 1, 16, 2, 10);
  } else {
    // a round black bomb with a highlight, its fuse fizzing
    g.fillStyle = '#121010';
    g.beginPath();
    g.arc(-6, 8, 30, 0, Math.PI * 2);
    g.fill();
    g.fillRect(-2, -30, 16, 14);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.arc(-16, -2, 8, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#f2ead8';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(6, -30);
    g.quadraticCurveTo(20, -46, 34, -38);
    g.stroke();
    g.fillStyle = '#ffd23d';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(36, -38);
      g.lineTo(36 + Math.cos(a) * 14, -38 + Math.sin(a) * 14);
      g.lineTo(36 + Math.cos(a + 0.3) * 6, -38 + Math.sin(a + 0.3) * 6);
      g.fill();
    }
  }
  g.restore();
}

function sailTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const rnd = mulberry(23);
  // sailcloth: vertical cloths with seams, a reef band or two, weathering and patches
  g.fillStyle = '#ffffff';
  g.fillRect(0, 128, 512, 384);
  for (let x = 0; x < 512; x += 32) {
    const s = 236 + rnd() * 19;
    g.fillStyle = `rgb(${s},${s},${s - 6})`;
    g.fillRect(x, 128, 32, 384);
    g.fillStyle = 'rgba(80,60,40,0.22)';
    g.fillRect(x, 128, 2, 384);
  }
  g.fillStyle = 'rgba(80,60,40,0.18)';
  for (const y of [200, 260]) g.fillRect(0, y, 512, 3);
  for (let i = 0; i < 18; i++) {
    const s = 210 + rnd() * 30;
    g.fillStyle = `rgba(${s},${s - 10},${s - 30},0.6)`;
    const w = 20 + rnd() * 40;
    const h = 16 + rnd() * 30;
    const x = rnd() * 470;
    const y = 150 + rnd() * 330;
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(70,50,30,0.35)';
    g.lineWidth = 1;
    g.strokeRect(x, y, w, h);
  }
  const grad = g.createLinearGradient(0, 128, 0, 512);
  grad.addColorStop(0, 'rgba(90,70,50,0)');
  grad.addColorStop(1, 'rgba(90,70,50,0.22)');
  g.fillStyle = grad;
  g.fillRect(0, 128, 512, 384);
  flag(g, 4, 4, 248, 120, 'roger');
  flag(g, 260, 4, 248, 120, 'keg');
  return canvasTex(c);
}

let SHARED: { hullMap: THREE.Texture; hullEmissive: THREE.Texture; sailMap: THREE.Texture; uTime: { value: number }; uWind: { value: number } } | null = null;

function shared() {
  if (SHARED) return SHARED;
  const h = hullTextures();
  SHARED = { hullMap: h.map, hullEmissive: h.emissive, sailMap: sailTexture(), uTime: { value: 0 }, uWind: { value: 1 } };
  return SHARED;
}

/** The fleet's clock and the breeze's strength (0..~1.5), for the sails' and flags' ripple. */
export function setFleetTime(t: number, wind: number) {
  const s = shared();
  s.uTime.value = t;
  s.uWind.value = wind;
}

/** The base hull material (cloned per ship, so each one can char, sink and fade on its own). */
function hullMaterial() {
  const s = shared();
  return new THREE.MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: true,
    map: s.hullMap,
    emissive: '#ffffff',
    emissiveMap: s.hullEmissive,
    emissiveIntensity: 0,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
  });
}

/** Sails and flags: double-sided cloth; `aWave` (0 at a sail's bolt-rope, more at a flag's fly) sets how much each vertex ripples. */
export function sailMaterial() {
  const s = shared();
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: s.sailMap, roughness: 0.95, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    withFogSun(shader);
    shader.uniforms.uTime = s.uTime;
    shader.uniforms.uWind = s.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWave;\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          // flags flap (a travelling wave towards the fly); sails breathe as the breeze gusts
          float w = aWave;
          float ph = position.x * 1.7 + position.y * 0.9 + position.z * 0.6;
          float flap = sin(uTime * (5.0 + 3.0 * uWind) - position.z * 2.2 - position.x * 1.4 + ph * 0.2);
          transformed.x += w * w * 0.55 * flap * (0.4 + uWind);
          transformed.y += w * w * 0.18 * sin(uTime * 7.3 - position.z * 3.0 + ph);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'cannons-sail';
  return m;
}

// ------------------------------------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------------------------------------

/** Collects parts in a ship's frame and merges them (position, normal, uv, color and optionally aWave). */
class Parts {
  private list: THREE.BufferGeometry[] = [];
  constructor(private readonly wave = false) {}

  /**
   * Adds `geo` moved by `m`, its UVs squeezed into `rect` (null: they already point into the
   * atlas), painted `color`, rippling by `wave` (a number, or per vertex).
   */
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4 | null, rect: Rect | null, wave: number | ((p: THREE.Vector3) => number) = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (m) g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
    const out = new Float32Array(n * 2);
    if (rect === null && uv) out.set(uv.array as Float32Array);
    else {
      const r = rect ?? HULL_UV.plain;
      for (let i = 0; i < n; i++) {
        const u = uv ? THREE.MathUtils.clamp(uv.getX(i), 0, 1) : 0.5;
        const v = uv ? THREE.MathUtils.clamp(uv.getY(i), 0, 1) : 0.5;
        out[i * 2] = r.u0 + u * (r.u1 - r.u0);
        out[i * 2 + 1] = r.v0 + v * (r.v1 - r.v0);
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(out, 2));
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (this.wave) {
      const p = g.attributes.position;
      const w = new Float32Array(n);
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) w[i] = typeof wave === 'number' ? wave : wave(v.fromBufferAttribute(p, i));
      g.setAttribute('aWave', new THREE.BufferAttribute(w, 1));
    }
    this.list.push(g);
  }

  /** Adds a ready-made geometry that already has its uv and color (and aWave) attributes. */
  raw(g: THREE.BufferGeometry) {
    this.list.push(g.index ? g.toNonIndexed() : g);
  }

  build() {
    const g = mergeGeometries(this.list, false)!;
    for (const p of this.list) p.dispose();
    this.list = [];
    g.computeBoundingSphere();
    return g;
  }
}

const M = () => new THREE.Matrix4();
/** A transform: position, then rotations about x, y and z (radians). */
function tr(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  return M().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));
}
/** A cylinder from a to b (radius r0 at a, r1 at b). */
function spar(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg = 6) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyMatrix4(M().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** One model per kind: the geometries every ship of that kind shares, and its key points. */
export interface ShipModel {
  hull: THREE.BufferGeometry;
  sails: THREE.BufferGeometry;
  rigging: THREE.BufferGeometry;
  /** The hit box in the ship's frame: half beam, half length, bottom and top. */
  box: { hx: number; hz: number; y0: number; y1: number };
  /** Where the masts stand (for the sinking's topple and the smoke), the powder kegs' fuse. */
  mastTops: THREE.Vector3[];
  fuse: THREE.Vector3 | null;
  /** Height of the tallest masthead above the water. */
  height: number;
}

/**
 * The hull's half beam at u (−0.5 the transom .. +0.5 the stem), as a fraction of the full half
 * beam: full amidships, a fine bow and a broad, flat transom.
 */
function beamAt(u: number) {
  if (u > 0.1) return Math.pow(Math.max(0, Math.cos(((u - 0.1) / 0.4) * (Math.PI / 2))), 0.62);
  if (u < -0.25) return 1 - 0.36 * Math.pow((-0.25 - u) / 0.25, 1.6);
  return 1;
}

/** The sheer: how far the rail rises above its midships height towards the bow and the stern. */
const sheerAt = (u: number, F: number) => F * (u > 0 ? 0.5 * Math.pow(u * 2, 2.2) : 0.32 * Math.pow(-u * 2, 2));

/** The keel's depth at u: full under the hull, rising into the stem at the bow. */
const keelAt = (u: number, D: number) => D * (u > 0.3 ? Math.max(-0.25, 1 - Math.pow((u - 0.3) / 0.2, 1.5) * 1.25) : 1 - 0.12 * Math.max(0, (-u - 0.35) / 0.15));

const BULWARK = 0.95;

/** The lofted hull: both sides in painted bands, the transom, and the deck. */
function hullGeometry(s: ShipSpec): THREE.BufferGeometry[] {
  const L = s.length;
  const B = s.beam / 2;
  const F = s.freeboard;
  const D = s.draft;
  const NS = 28;
  const bands: { y0: number; y1: number; c: string; rows: number }[] = [
    { y0: -1, y1: 0.12, c: '#8a4126', rows: 5 },
    { y0: 0.12, y1: 0.3, c: '#e6dcc4', rows: 1 },
    { y0: 0.3, y1: F * 0.46, c: s.hull, rows: 2 },
    { y0: F * 0.46, y1: F * 0.66, c: s.stripe, rows: 1 },
    { y0: F * 0.66, y1: 99, c: s.hull, rows: 3 },
    { y0: 99, y1: 100, c: '#4a3020', rows: 1 },
  ];
  const out: THREE.BufferGeometry[] = [];
  const pu = HULL_UV.planks;
  const topAt = (u: number) => F + BULWARK + sheerAt(u, F);
  const halfAt = (u: number, y: number) => {
    const b = B * beamAt(u);
    const k = Math.max(0.05, keelAt(u, D));
    if (y < 0) return b * Math.pow(Math.max(0, 1 - Math.pow(-y / k, 2)), 0.42);
    return b * (1 - 0.07 * Math.pow(y / topAt(u), 2));
  };
  for (const side of [-1, 1]) {
    for (const band of bands) {
      const pos: number[] = [];
      const uv: number[] = [];
      const col: number[] = [];
      const c = new THREE.Color(band.c);
      const idx: number[] = [];
      const rows = band.rows + 1;
      for (let i = 0; i <= NS; i++) {
        const u = -0.5 + i / NS;
        const top = topAt(u);
        const keel = -keelAt(u, D);
        // the band's heights at this station (the bottom band starts at the keel, the rail cap ends at the top)
        const ya = band.y0 === -1 ? Math.min(keel, 0.1) : band.y0 === 99 ? top - 0.16 : Math.min(band.y0, top - 0.16);
        const yb = band.y1 === 100 ? top : band.y1 === 99 ? top - 0.16 : Math.min(band.y1, top - 0.16);
        for (let j = 0; j < rows; j++) {
          const y = ya + ((yb - ya) * j) / band.rows;
          const x = halfAt(u, y) * side;
          pos.push(x, y, -u * L);
          uv.push(pu.u0 + (u + 0.5) * (pu.u1 - pu.u0), pu.v0 + THREE.MathUtils.clamp((y + D) / (F + D + 2.5), 0, 1) * (pu.v1 - pu.v0));
          col.push(c.r, c.g, c.b);
        }
      }
      for (let i = 0; i < NS; i++)
        for (let j = 0; j < band.rows; j++) {
          const a = i * rows + j;
          const b = a + rows;
          if (side > 0) idx.push(a, b, a + 1, b, b + 1, a + 1);
          else idx.push(a, a + 1, b, b, a + 1, b + 1);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      out.push(g.toNonIndexed());
    }
  }
  // the transom: the stern's flat face, a fan from the keel to the rail
  {
    const u = -0.5;
    const pos: number[] = [];
    const top = topAt(u);
    const keel = -keelAt(u, D) * 0.6;
    const n = 8;
    const pts: [number, number][] = [];
    for (let j = 0; j <= n; j++) {
      const y = keel + ((top - keel) * j) / n;
      pts.push([halfAt(u, y), y]);
    }
    for (let j = 0; j < n; j++) {
      const [x0, y0] = pts[j];
      const [x1, y1] = pts[j + 1];
      pos.push(-x0, y0, L / 2, x0, y0, L / 2, x1, y1, L / 2, -x0, y0, L / 2, x1, y1, L / 2, -x1, y1, L / 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const c = new THREE.Color(s.hull);
    const nv = pos.length / 3;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(nv * 2).fill(0).map((_, i) => (i % 2 ? pu.v0 + 0.3 * (pu.v1 - pu.v0) : pu.u0 + 0.5 * (pu.u1 - pu.u0))), 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(nv).fill(0).flatMap(() => [c.r, c.g, c.b]), 3));
    out.push(g);
  }
  // the deck, planked along the length, just below the rail
  {
    const pos: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i < NS; i++) {
      const ua = -0.5 + i / NS;
      const ub = ua + 1 / NS;
      const ya = F + sheerAt(ua, F) * 0.9;
      const yb = F + sheerAt(ub, F) * 0.9;
      const xa = halfAt(ua, ya) * 0.97;
      const xb = halfAt(ub, yb) * 0.97;
      const za = -ua * L;
      const zb = -ub * L;
      pos.push(-xa, ya, za, xa, ya, za, xb, yb, zb, -xa, ya, za, xb, yb, zb, -xb, yb, zb);
      const va = (x: number) => pu.v0 + ((x / (B * 2) + 0.5) * 0.5 + 0.25) * (pu.v1 - pu.v0);
      const uu = (u: number) => pu.u0 + (u + 0.5) * (pu.u1 - pu.u0);
      uv.push(uu(ua), va(-xa), uu(ua), va(xa), uu(ub), va(xb), uu(ua), va(-xa), uu(ub), va(xb), uu(ub), va(-xb));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const c = new THREE.Color('#b58e5e');
    const nv = pos.length / 3;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(nv).fill(0).flatMap(() => [c.r, c.g, c.b]), 3));
    out.push(g);
  }
  return out;
}

/** A box with its faces mapped to atlas cells (the stern face can show the windows). */
function cellBox(w: number, h: number, d: number, rect: Rect = HULL_UV.plain, stern?: Rect) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry's faces come in the order +x, −x, +y, −y, +z, −z: four vertices each
  for (let f = 0; f < 6; f++) {
    const r = f === 4 && stern ? stern : rect;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
    }
  }
  return g;
}

/** A square sail hanging from a yard: `w` wide at the head, `foot` at the foot, `h` deep, bellied forward. */
function squareSail(w: number, foot: number, h: number, belly: number) {
  const g = new THREE.PlaneGeometry(1, 1, 8, 6);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i) - 0.5; // 0 at the head .. −1 at the foot
    const t = -y;
    const ww = w + (foot - w) * t;
    const fx = x * ww;
    const bulge = belly * (1 - Math.pow(2 * x, 2)) * Math.sin(Math.PI * Math.min(1, t * 0.85 + 0.12));
    p.setXYZ(i, fx, y * h, -bulge);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A fore-and-aft sail (a gaff mainsail or a jib) through its corners in the ship's frame, bellied
 * to one side: `tack` (forward foot), `clew` (after foot), `peak` (after head) and `throat`
 * (forward head; a triangle when it equals `peak`).
 */
function foreAftSail(tack: THREE.Vector3, clew: THREE.Vector3, peak: THREE.Vector3, throat: THREE.Vector3, belly: number) {
  const nu = 6;
  const nv = 6;
  const pos: number[] = [];
  const uv: number[] = [];
  const pts: THREE.Vector3[] = [];
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    const a = tack.clone().lerp(throat, v);
    const b = clew.clone().lerp(peak, v);
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const q = a.clone().lerp(b, u);
      q.x += belly * Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 0.8 + 0.15));
      pts.push(q);
    }
  }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const quad = [a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1];
      for (const k of quad) {
        pos.push(pts[k].x, pts[k].y, pts[k].z);
        uv.push((k % (nu + 1)) / nu, Math.floor(k / (nu + 1)) / nv);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** A flag `w` × `h` flying aft from a staff at `at` (the hoist), rippling more towards the fly. */
function flagGeometry(w: number, h: number) {
  const g = new THREE.PlaneGeometry(w, h, 8, 3).rotateY(Math.PI / 2).translate(0, 0, w / 2);
  return g;
}

/** A Jolly Roger `w` × `h` flying towards +z from its hoist at the origin (for the sail material: the fort flies one too). */
export function jollyRoger(w: number, h: number) {
  const p = new Parts(true);
  p.add(flagGeometry(w, h), '#ffffff', null, SAIL_UV.roger, (q) => Math.min(1, q.z / w));
  return p.build();
}

/** Builds the shared model for one kind of ship. */
export function buildShipModel(kind: ShipKind): ShipModel {
  const s = SHIP_KINDS[kind];
  const L = s.length;
  const F = s.freeboard;
  const B = s.beam / 2;
  const hull = new Parts();
  for (const g of hullGeometry(s)) hull.raw(g);
  const sails = new Parts(true);
  const rig: number[] = [];
  const line = (a: THREE.Vector3, b: THREE.Vector3) => rig.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const deckY = (u: number) => F + sheerAt(u, F) * 0.9;
  const sternTop = F + BULWARK + sheerAt(-0.5, F);
  const wood = '#6b4a2c';
  const iron = '#1d1c1e';
  let castleTop = sternTop;

  // castles: a quarterdeck (brig, galleon), a poop and a forecastle (galleon), with the stern windows aft
  if (kind === 'brig' || kind === 'galleon') {
    const len = L * (kind === 'galleon' ? 0.32 : 0.26);
    const h = kind === 'galleon' ? 2.4 : 1.6;
    const w = B * 2 * beamAt(-0.42) * 0.95;
    const zc = L / 2 - len / 2;
    hull.add(cellBox(w, h, len, HULL_UV.planks, HULL_UV.windows), s.hull, tr(0, sternTop - 0.4 + h / 2, zc), null);
    hull.add(cellBox(w + 0.2, 0.22, len + 0.1), s.stripe, tr(0, sternTop - 0.4 + h, zc), null);
    castleTop = sternTop - 0.4 + h;
    if (kind === 'galleon') {
      const len2 = L * 0.16;
      const h2 = 1.9;
      const w2 = w * 0.86;
      hull.add(cellBox(w2, h2, len2, HULL_UV.planks, HULL_UV.windows), s.hull, tr(0, castleTop + h2 / 2, L / 2 - len2 / 2), null);
      hull.add(cellBox(w2 + 0.2, 0.2, len2 + 0.1), s.stripe, tr(0, castleTop + h2, L / 2 - len2 / 2), null);
      castleTop += h2;
      // the forecastle
      const lf = L * 0.16;
      const wf = B * 2 * beamAt(0.28) * 0.92;
      hull.add(cellBox(wf, 1.5, lf), s.hull, tr(0, deckY(0.3) + BULWARK + 0.35, -L * 0.3), null);
      hull.add(cellBox(wf + 0.2, 0.2, lf + 0.1), s.stripe, tr(0, deckY(0.3) + BULWARK + 1.1, -L * 0.3), null);
      // a gilded figure-board on the stern
      hull.add(cellBox(w * 0.5, 0.6, 0.12), '#d8a63a', tr(0, castleTop + 0.3, L / 2 - 0.05), null);
    }
    // stern lanterns (lit at night)
    const lx = kind === 'galleon' ? [-w * 0.42, 0, w * 0.42] : [0];
    for (const x of lx) {
      hull.add(new THREE.CylinderGeometry(0.22, 0.16, 0.6, 6), '#ffffff', tr(x, castleTop + 0.55, L / 2 - 0.2), HULL_UV.lantern);
      hull.add(new THREE.ConeGeometry(0.28, 0.3, 6), iron, tr(x, castleTop + 1.0, L / 2 - 0.2), HULL_UV.plain);
    }
  } else {
    // a sloop's single stern lantern on a short post
    hull.add(spar(V(0, sternTop - 0.2, L / 2 - 0.3), V(0, sternTop + 0.9, L / 2 - 0.1), 0.06, 0.05), wood, null, HULL_UV.grain);
    hull.add(new THREE.CylinderGeometry(0.17, 0.12, 0.42, 6), '#ffffff', tr(0, sternTop + 1.1, L / 2 - 0.1), HULL_UV.lantern);
  }

  // gunports with the guns run out, along both sides (two tiers on the galleon)
  const tiers = kind === 'galleon' ? [F * 0.36, F * 0.82] : kind === 'brig' ? [F * 0.78] : [F * 0.8];
  const ports = kind === 'galleon' ? 8 : kind === 'brig' ? 6 : kind === 'keg' ? 2 : 3;
  for (const y of tiers)
    for (let i = 0; i < ports; i++) {
      const u = -0.3 + (0.62 * (i + 0.5)) / ports;
      for (const side of [-1, 1]) {
        const x = B * beamAt(u) * (1 - 0.07 * Math.pow(y / (F + BULWARK), 2)) * side;
        hull.add(new THREE.BoxGeometry(0.06, 0.5, 0.55), '#121010', tr(x + side * 0.02, y, -u * L), HULL_UV.plain);
        hull.add(new THREE.BoxGeometry(0.05, 0.52, 0.6), s.stripe, tr(x + side * 0.08, y + 0.48, -u * L, 0, 0, side * 0.9), HULL_UV.plain);
        hull.add(spar(V(x - side * 0.1, y, -u * L), V(x + side * 0.55, y, -u * L), 0.11, 0.09, 6), iron, null, HULL_UV.plain);
      }
    }

  // masts, tops, yards and sails
  const mastTops: THREE.Vector3[] = [];
  const bowTip = V(0, F + sheerAt(0.5, F) + 1.4, -L / 2 - L * 0.2);
  hull.add(spar(V(0, deckY(0.42) + 0.4, -L * 0.42), bowTip, 0.22, 0.09), wood, null, HULL_UV.grain);
  const flagAt: THREE.Vector3[] = [];
  const square = (u: number, h: number, tiersN: number, yardW: number) => {
    const z = -u * L;
    const base = deckY(u);
    const top = V(0, base + h, z);
    hull.add(spar(V(0, base - 0.5, z), top, 0.32 * (L / 27) ** 0.5, 0.12), wood, null, HULL_UV.grain);
    mastTops.push(top);
    flagAt.push(top.clone().add(V(0, 0.6, 0)));
    // the courses and topsails, the yards above each
    const lo = base + 3;
    const span = h - 3.6;
    for (let k = 0; k < tiersN; k++) {
      const yTop = lo + span * ((k + 1) / tiersN);
      const yBot = lo + span * (k / tiersN) + 0.3;
      const w = yardW * (1 - k * 0.22);
      hull.add(spar(V(-w / 2 - 0.5, yTop, z - 0.25), V(w / 2 + 0.5, yTop, z - 0.25), 0.12, 0.12), wood, null, HULL_UV.grain);
      sails.add(squareSail(w, w * (k === 0 ? 1.08 : 1.12), yTop - yBot, w * 0.11), s.sail, tr(0, yTop, z - 0.5), SAIL_UV.cloth, 0);
      if (k === 0) hull.add(new THREE.CylinderGeometry(0.9, 0.7, 0.18, 8), wood, tr(0, yTop + 0.45, z), HULL_UV.grain);
      // braces and lifts: from the yardarms down to the rail
      line(V(-w / 2, yTop, z), V(-B * 0.9, deckY(u - 0.12) + BULWARK, z + L * 0.12));
      line(V(w / 2, yTop, z), V(B * 0.9, deckY(u - 0.12) + BULWARK, z + L * 0.12));
    }
    // shrouds either side
    for (const side of [-1, 1])
      for (let k = -1; k <= 1; k++) line(V(0, base + h * 0.72, z), V(side * B * beamAt(u) * 0.98, base + BULWARK, z + k * 0.9 + 1.2));
  };
  const gaff = (u: number, h: number, boomLen: number, colour: string) => {
    const z = -u * L;
    const base = deckY(u);
    const top = V(0, base + h, z);
    hull.add(spar(V(0, base - 0.5, z), top, 0.26, 0.11), wood, null, HULL_UV.grain);
    mastTops.push(top);
    flagAt.push(top.clone().add(V(0, 0.5, 0)));
    const tack = V(0, base + 1.4, z + 0.3);
    const clew = V(0, base + 1.6, z + boomLen);
    const throat = V(0, base + h * 0.72, z + 0.3);
    const peak = V(0, base + h * 0.94, z + boomLen * 0.92);
    hull.add(spar(tack, clew, 0.12, 0.1), wood, null, HULL_UV.grain);
    hull.add(spar(throat, peak, 0.1, 0.08), wood, null, HULL_UV.grain);
    sails.add(foreAftSail(tack, clew, peak, throat, boomLen * 0.1), colour, null, SAIL_UV.cloth, 0);
    // the jib, from the bowsprit to the masthead
    const jibTop = V(0, base + h * 0.86, z - 0.2);
    sails.add(foreAftSail(bowTip.clone().add(V(0, 0.2, 0.6)), V(0, deckY(0.3) + 1.2, z - 1.2), jibTop, jibTop, 0.7), colour, null, SAIL_UV.cloth, 0);
    line(bowTip, top);
    line(top, V(0, sternTop, L / 2 - 0.4));
    for (const side of [-1, 1]) for (let k = 0; k < 2; k++) line(V(0, base + h * 0.8, z), V(side * B * beamAt(u) * 0.98, base + BULWARK, z + k * 1.0 + 0.4));
  };
  if (kind === 'sloop') gaff(0.1, 15, L * 0.55, s.sail);
  else if (kind === 'keg') {
    gaff(0.08, 12, L * 0.52, s.sail);
    // the cargo: a deck stacked with powder kegs, red-banded, roped down
    const rnd = mulberry(7);
    for (let i = 0; i < 14; i++) {
      const u = -0.28 + (i % 7) * 0.075;
      const row = Math.floor(i / 7);
      const x = (row ? 1 : -1) * B * 0.42;
      const y = deckY(u) + 0.45;
      hull.add(new THREE.CylinderGeometry(0.42, 0.42, 0.9, 10), '#7a4a26', tr(x, y, -u * L, 0, rnd() * 3, 0), HULL_UV.grain);
      for (const dy of [-0.28, 0.28]) hull.add(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 10), '#c22e1e', tr(x, y + dy, -u * L), HULL_UV.plain);
    }
    for (let i = 0; i < 4; i++) {
      const u = -0.24 + i * 0.12;
      hull.add(new THREE.CylinderGeometry(0.42, 0.42, 0.9, 10), '#7a4a26', tr(0, deckY(u) + 1.3, -u * L, Math.PI / 2, 0, 0), HULL_UV.grain);
      hull.add(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 10), '#c22e1e', tr(0, deckY(u) + 1.3, -u * L, Math.PI / 2, 0, 0), HULL_UV.plain);
    }
  } else if (kind === 'brig') {
    square(0.24, 19, 2, B * 2.1);
    square(-0.08, 21, 3, B * 2.3);
    // a spanker on the main mast's after side
    const z = 0.08 * L;
    sails.add(foreAftSail(V(0, deckY(-0.1) + 2, z + 0.4), V(0, deckY(-0.4) + 2.2, z + L * 0.36), V(0, deckY(-0.1) + 11, z + L * 0.3), V(0, deckY(-0.1) + 9, z + 0.4), 0.8), s.sail, null, SAIL_UV.cloth, 0);
    line(bowTip, mastTops[0]);
    line(mastTops[0], mastTops[1]);
    line(mastTops[1], V(0, castleTop, L / 2 - 0.4));
  } else {
    square(0.29, 22, 2, B * 2.0);
    square(0.0, 28, 3, B * 2.3);
    // the mizzen: a lateen sail on a long slanting yard
    const z = 0.3 * L;
    const base = castleTop;
    const top = V(0, base + 14, z);
    hull.add(spar(V(0, base - 1, z), top, 0.24, 0.1), wood, null, HULL_UV.grain);
    mastTops.push(top);
    const yA = V(0, base + 2.2, z - 5.5);
    const yB = V(0, base + 15, z + 6.5);
    hull.add(spar(yA, yB, 0.12, 0.08), wood, null, HULL_UV.grain);
    sails.add(foreAftSail(yA.clone().add(V(0, -0.2, 0)), V(0, base + 1.2, z + 5.5), yB, yB, 1.2), s.sail, null, SAIL_UV.cloth, 0);
    // a spritsail under the bowsprit
    sails.add(squareSail(B * 1.1, B * 1.2, 3.2, 0.5), s.sail, tr(0, bowTip.y - 0.6, bowTip.z * 0.82 + 1), SAIL_UV.cloth, 0);
    line(bowTip, mastTops[0]);
    line(mastTops[0], mastTops[1]);
    line(mastTops[1], top);
    line(top, V(0, castleTop, L / 2 - 0.4));
  }
  // flags at the mastheads: the Jolly Roger (the powder-keg sloop flies its own warning)
  for (const [i, p] of flagAt.entries()) {
    const big = kind === 'galleon' ? 1.5 : kind === 'brig' ? 1.25 : 1;
    const fw = 3 * big;
    const fh = 1.8 * big;
    hull.add(spar(p.clone().add(V(0, -0.6, 0)), p.clone().add(V(0, fh + 0.5, 0)), 0.05, 0.04, 4), wood, null, HULL_UV.grain);
    const rect = kind === 'keg' ? SAIL_UV.keg : SAIL_UV.roger;
    if (i > 0 && kind === 'galleon') continue;
    sails.add(flagGeometry(fw, fh), '#ffffff', tr(0, p.y + fh / 2 + 0.2, p.z), rect, (q) => Math.min(1, (q.z - p.z) / fw));
  }
  const height = Math.max(...mastTops.map((p) => p.y)) + 2;
  const rigging = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(rig, 3));
  rigging.computeBoundingSphere();
  return {
    hull: hull.build(),
    sails: sails.build(),
    rigging,
    box: { hx: B + 0.5, hz: L / 2 + 0.6, y0: -1.3, y1: Math.max(castleTop, F + BULWARK + 0.6) + 0.6 },
    mastTops,
    fuse: kind === 'keg' ? V(0, deckY(0) + 1.9, 0) : null,
    height,
  };
}

// ------------------------------------------------------------------------------------------------
// A ship at sea
// ------------------------------------------------------------------------------------------------

export type ShipState = 'arriving' | 'sailing' | 'sinking' | 'gone';
/** How long a ship takes to fade in out of the haze, and to go down. */
const ARRIVE = 3;
export const SINK_TIME = 9;
/** The powder-keg sloop is blown apart rather than holed: what is left goes down at once, its sails gone. */
const KEG_SINK = 2.6;

const tmpP = new THREE.Vector3();
const lp = { x: 0, z: 0, tx: 0, tz: 0 };

/** A place where the ship was hit: smoke (and maybe flames) rise from it, in the ship's frame. */
export interface Wound {
  p: THREE.Vector3;
  fire: boolean;
  /** Seconds to the next puff. */
  next: number;
}

/**
 * One pirate ship: its meshes (sharing its kind's geometry, with its own material copies), its
 * lane and place along it, and its damage. The game moves it with `update`, checks hits against
 * `box` through `toLocal`, and calls `hit` and `respawn`.
 */
export class Ship {
  readonly group = new THREE.Group();
  readonly spec: ShipSpec;
  name = '';
  state: ShipState = 'gone';
  hp = 0;
  /** Metres round its lane, and its speed (it slows as it takes water). */
  s = 0;
  speed = 0;
  /** 0 → 1 while it fades in; seconds since it began to sink. */
  private arriveT = 0;
  sinkT = 0;
  /** Seconds since it was last hit (the hull shudders), and which side it lists to. */
  private shudder = 9;
  private listSide = 1;
  private listDeg = 0;
  private sinkBow = 1;
  readonly wounds: Wound[] = [];
  /** The way it sails: radians clockwise from north. */
  heading = 0;
  private readonly sails: THREE.Mesh;
  private readonly rig: THREE.LineSegments | null;
  private hullMat: THREE.MeshStandardMaterial;
  private sailMat: THREE.MeshStandardMaterial;
  private rigMat: THREE.LineBasicMaterial;
  private fading = false;
  private readonly phase: number;
  private readonly inv = new THREE.Matrix4();
  private rnd: () => number;

  constructor(
    readonly kind: ShipKind,
    readonly model: ShipModel,
    readonly lane: Lane,
    seed: number,
    rigging: boolean,
  ) {
    this.spec = SHIP_KINDS[kind];
    this.rnd = mulberry(seed);
    this.phase = this.rnd() * 10;
    this.hullMat = hullMaterial();
    this.sailMat = sailMaterial();
    this.rigMat = new THREE.LineBasicMaterial({ color: '#2a2018' });
    const hull = new THREE.Mesh(model.hull, this.hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    const sails = (this.sails = new THREE.Mesh(model.sails, this.sailMat));
    sails.castShadow = true;
    this.group.add(hull, sails);
    this.rig = rigging ? new THREE.LineSegments(model.rigging, this.rigMat) : null;
    if (this.rig) this.group.add(this.rig);
    this.group.rotation.order = 'YXZ';
    this.group.visible = false;
  }

  get alive() {
    return this.state === 'arriving' || this.state === 'sailing';
  }

  /** Fresh out of the haze at `s` round its lane (or already there, `instant`). */
  respawn(s: number, instant = false) {
    this.s = s;
    this.hp = this.spec.hp;
    this.speed = this.spec.speed * (0.92 + this.rnd() * 0.16);
    this.sinkT = 0;
    this.listDeg = 0;
    this.shudder = 9;
    this.wounds.length = 0;
    const names = NAMES[this.kind];
    this.name = names[Math.floor(this.rnd() * names.length)];
    this.state = instant ? 'sailing' : 'arriving';
    this.arriveT = instant ? 1 : 0;
    this.hullMat.color.setScalar(1);
    this.setOpacity(instant ? 1 : 0);
    this.sails.visible = true;
    if (this.rig) this.rig.visible = true;
    this.group.visible = true;
  }

  /** Takes a hit at `local` (a point in its frame): returns true if that one sinks it. */
  hit(local: THREE.Vector3) {
    if (!this.alive) return false;
    this.hp--;
    this.shudder = 0;
    this.listSide = local.x >= 0 ? 1 : -1;
    this.listDeg += 4 + this.rnd() * 3;
    this.speed *= 0.82;
    // the hull chars as it takes damage
    this.hullMat.color.setScalar(0.58 + 0.42 * (this.hp / this.spec.hp));
    const deck = Math.max(local.y, this.spec.freeboard * 0.7);
    this.wounds.push({ p: new THREE.Vector3(THREE.MathUtils.clamp(local.x, -this.spec.beam / 2, this.spec.beam / 2), deck, local.z), fire: this.wounds.length > 0 || this.hp <= 1, next: 0 });
    if (this.hp <= 0) {
      this.state = 'sinking';
      this.sinkT = 0;
      this.sinkBow = this.rnd() < 0.6 ? 1 : -1;
      this.setOpacity(1);
      if (this.kind === 'keg') {
        this.sails.visible = false;
        if (this.rig) this.rig.visible = false;
      }
      return true;
    }
    return false;
  }

  /** Into the ship's own frame (for the hit test), from the latest `update`. */
  toLocal(p: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(p).applyMatrix4(this.inv);
  }

  /** Out of its frame into the world. */
  toWorld(p: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(p).applyMatrix4(this.group.matrixWorld);
  }

  private setOpacity(k: number) {
    const fade = k < 0.999;
    if (fade !== this.fading) {
      this.fading = fade;
      for (const m of [this.hullMat, this.sailMat, this.rigMat]) {
        m.transparent = fade;
        m.depthWrite = !fade;
        m.needsUpdate = true;
      }
    }
    this.hullMat.opacity = this.sailMat.opacity = this.rigMat.opacity = k;
  }

  setNight(k: number) {
    this.hullMat.emissiveIntensity = k * 2.4;
  }

  /** Sails on (or goes down); `windHeel` is the breeze's heel in radians (signed: to starboard +). */
  update(dt: number, t: number, windHeel: number) {
    if (this.state === 'gone') return;
    const sp = this.spec;
    if (this.state === 'arriving') {
      this.arriveT = Math.min(1, this.arriveT + dt / ARRIVE);
      this.setOpacity(this.arriveT * this.arriveT);
      if (this.arriveT >= 1) this.state = 'sailing';
    }
    let sink = 0;
    let pitchX = 0;
    let rollX = 0;
    if (this.state === 'sinking') {
      this.sinkT += dt;
      const time = this.kind === 'keg' ? KEG_SINK : SINK_TIME;
      const k = this.sinkT / time;
      // it stops, takes water, lists and settles by the head (or the stern), then slides under
      this.speed = Math.max(0, this.speed - dt * 1.2);
      sink = Math.pow(k, 1.7) * (this.model.height + sp.draft + 2);
      pitchX = -THREE.MathUtils.smoothstep(k, 0.1, 0.8) * THREE.MathUtils.degToRad(sp.length > 30 ? 14 : 22) * this.sinkBow;
      rollX = THREE.MathUtils.smoothstep(k, 0, 0.6) * THREE.MathUtils.degToRad(26) * this.listSide;
      if (this.sinkT >= time) {
        this.state = 'gone';
        this.group.visible = false;
        return;
      }
    }
    this.s += this.speed * dt;
    lanePoint(this.lane, this.s, lp);
    const head = Math.atan2(lp.tx, -lp.tz);
    this.heading = head;
    // ride the swell: the sea's height under the bow, stern and either beam
    const fx = Math.sin(head);
    const fz = -Math.cos(head);
    const hl = sp.length * 0.4;
    const hb = sp.beam * 0.45;
    const yb = waveY(lp.x + fx * hl, lp.z + fz * hl, t);
    const ys = waveY(lp.x - fx * hl, lp.z - fz * hl, t);
    const yp = waveY(lp.x + fz * hb, lp.z - fx * hb, t);
    const yq = waveY(lp.x - fz * hb, lp.z + fx * hb, t);
    const y = (yb + ys + yp + yq) / 4;
    const pitch = Math.atan2(yb - ys, hl * 2) + THREE.MathUtils.degToRad(0.7) * Math.sin(t * 0.8 + this.phase);
    let roll = Math.atan2(yp - yq, hb * 2) + THREE.MathUtils.degToRad(1.6) * Math.sin(t * 1.05 + this.phase * 1.3);
    // heel: the breeze on the sails, outwards in a turn, the water she has taken, and the shudder of a hit
    const turn = laneTurn(this.lane, this.s);
    roll += windHeel * (this.state === 'sinking' ? 0.3 : 1) - THREE.MathUtils.clamp(this.speed * this.speed * turn * 0.06, -0.12, 0.12);
    roll += THREE.MathUtils.degToRad(Math.min(14, this.listDeg)) * this.listSide;
    this.shudder += dt;
    const shake = this.shudder < 0.8 ? Math.sin(this.shudder * 40) * 0.035 * (1 - this.shudder / 0.8) : 0;
    this.group.position.set(lp.x, y + sp.freeboard * 0.02 - sink, lp.z);
    // Euler YXZ: y = −heading, x = pitch (bow up +), z = −bank (to starboard)
    this.group.rotation.set(pitch + pitchX + shake, -head, -(roll + rollX) + shake * 0.6);
    this.group.updateMatrixWorld();
    this.inv.copy(this.group.matrixWorld).invert();
  }

  /** Where it will be `sec` seconds from now if it holds its course (y = 0). */
  ahead(sec: number, out = tmpP) {
    lanePoint(this.lane, this.s + this.speed * sec, lp);
    return out.set(lp.x, 0, lp.z);
  }
}
