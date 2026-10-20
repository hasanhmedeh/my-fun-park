// The airfield's signs (ICAO Annex 14 colours): mandatory instruction signs (white on red) at the
// runway-holding positions, location signs (yellow on black, framed in yellow), direction signs
// (black on yellow, with arrows) before the junctions, take-off run available boards at the
// intersection departures, and the runway's distance remaining boards (white on black). Every face
// is painted once into one atlas; the boxes, their frames and legs are one merged mesh lit from
// inside at night (an emissive mask that lights the faces only).

import * as THREE from 'three';
import { canvasTex } from '../textures';
import { headingVec } from '../geo';
import type { Cell, SignSpec } from './airfield-plan';

const FONT = '"Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif';
/** Atlas pixels per face (one row of cells) and the atlas's width. */
const ROW_PX = 96;
const ATLAS_W = 2048;
/** Face heights (m), the boxes' depth, the height of the face's bottom edge. */
const FACE_H = 1.0;
const DRS_H = 1.6;
const DEPTH = 0.3;
const LIFT = 0.4;

const COLOURS: Record<Cell['kind'], { bg: string; fg: string }> = {
  loc: { bg: '#141414', fg: '#ffd21f' },
  mand: { bg: '#c8102e', fg: '#ffffff' },
  dir: { bg: '#ffd21f', fg: '#141414' },
  info: { bg: '#ffd21f', fg: '#141414' },
  drs: { bg: '#141414', fg: '#ffffff' },
};

/** An arrow pointing `deg` from straight up (−90 left), centred at (x, y), `s` pixels long. */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, s: number, deg: number) {
  g.save();
  g.translate(x, y);
  g.rotate((deg * Math.PI) / 180);
  g.beginPath();
  const w = s * 0.12;
  g.moveTo(-w, s * 0.5);
  g.lineTo(w, s * 0.5);
  g.lineTo(w, -s * 0.12);
  g.lineTo(s * 0.3, -s * 0.12);
  g.lineTo(0, -s * 0.5);
  g.lineTo(-s * 0.3, -s * 0.12);
  g.lineTo(-w, -s * 0.12);
  g.closePath();
  g.fill();
  g.restore();
}

interface FaceLayout {
  cells: { cell: Cell; w: number }[];
  w: number;
}

function layout(g: CanvasRenderingContext2D, cells: Cell[]): FaceLayout {
  const out: FaceLayout = { cells: [], w: 0 };
  for (const cell of cells) {
    g.font = `700 ${cell.kind === 'drs' ? ROW_PX * 0.86 : ROW_PX * 0.66}px ${FONT}`;
    const tw = g.measureText(cell.text).width;
    const w = Math.ceil(tw + ROW_PX * (cell.kind === 'drs' ? 0.5 : 0.42) + (cell.arrow !== undefined ? ROW_PX * 0.62 : 0));
    out.cells.push({ cell, w });
    out.w += w;
  }
  return out;
}

function drawFace(g: CanvasRenderingContext2D, f: FaceLayout, x0: number, y0: number, emissive: boolean) {
  let x = x0;
  const H = ROW_PX;
  for (let i = 0; i < f.cells.length; i++) {
    const { cell, w } = f.cells[i];
    const c = COLOURS[cell.kind];
    // Lit from inside, a sign glows in its own colours through the translucent face; the black of
    // location and distance signs is opaque, so only their lettering (and frame) glows.
    const dark = cell.kind === 'loc' || cell.kind === 'drs';
    g.fillStyle = emissive && dark ? '#000000' : c.bg;
    g.fillRect(x, y0, w, H);
    g.fillStyle = emissive && c.fg === '#141414' ? '#000000' : c.fg;
    if (cell.kind === 'loc') {
      // the location sign's yellow frame
      g.strokeStyle = c.fg;
      g.lineWidth = H * 0.06;
      g.strokeRect(x + H * 0.09, y0 + H * 0.09, w - H * 0.18, H - H * 0.18);
    }
    g.font = `700 ${cell.kind === 'drs' ? H * 0.86 : H * 0.66}px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const hasArrow = cell.arrow !== undefined;
    const left = hasArrow && cell.arrow! < 0;
    const aw = hasArrow ? H * 0.62 : 0;
    const tx = x + (w + (hasArrow ? (left ? aw : -aw) : 0)) / 2;
    g.fillText(cell.text, tx, y0 + H * 0.53);
    if (hasArrow) arrow(g, left ? x + H * 0.16 + aw / 2 : x + w - H * 0.16 - aw / 2, y0 + H / 2, H * 0.62, cell.arrow!);
    // adjoining yellow cells are split by a black bar
    const next = f.cells[i + 1]?.cell.kind;
    if (!emissive && (cell.kind === 'dir' || cell.kind === 'info') && (next === 'dir' || next === 'info')) {
      g.fillStyle = '#141414';
      g.fillRect(x + w - H * 0.03, y0, H * 0.06, H);
    }
    x += w;
  }
  if (!emissive && f.cells.some((c) => c.cell.kind === 'mand')) {
    // mandatory signs carry a thin black outline
    g.strokeStyle = '#141414';
    g.lineWidth = H * 0.05;
    g.strokeRect(x0 + H * 0.025, y0 + H * 0.025, f.w - H * 0.05, H - H * 0.05);
  }
}

export function signsMesh(signs: SignSpec[], renderer: THREE.WebGLRenderer, origin: THREE.Vector3) {
  const probe = document.createElement('canvas').getContext('2d')!;
  // every distinct face once
  const faces = new Map<string, { f: FaceLayout; x: number; y: number }>();
  const key = (cells: Cell[]) => JSON.stringify(cells);
  let sx = 0;
  let sy = ROW_PX; // the first row holds the frame's plain grey patch
  for (const s of signs)
    for (const cells of [s.front, s.back]) {
      if (!cells || faces.has(key(cells))) continue;
      const f = layout(probe, cells);
      if (sx + f.w + 4 > ATLAS_W) {
        sx = 0;
        sy += ROW_PX + 4;
      }
      faces.set(key(cells), { f, x: sx, y: sy });
      sx += f.w + 4;
    }
  const H = THREE.MathUtils.ceilPowerOfTwo(sy + ROW_PX + 4);
  const paint = (emissive: boolean) => {
    const c = document.createElement('canvas');
    c.width = ATLAS_W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = emissive ? '#000000' : '#3b3d40';
    g.fillRect(0, 0, ATLAS_W, H);
    // the frame patch (painted grey metal) top-left
    g.fillStyle = emissive ? '#000000' : '#5d6064';
    g.fillRect(0, 0, 64, 64);
    for (const { f, x, y } of faces.values()) drawFace(g, f, x, y, emissive);
    return canvasTex(c, renderer);
  };
  const map = paint(false);
  const emissiveMap = paint(true);
  const frameUv = [16 / ATLAS_W, 1 - 16 / H, 48 / ATLAS_W, 1 - 48 / H];

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  /** A quad from corner c, along a (u) and b (v), facing n, with UVs u0..u1, v0..v1. */
  const quad = (c: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, n: THREE.Vector3, u: number[]) => {
    const base = pos.length / 3;
    for (const [ka, kb] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      v.copy(c).addScaledVector(a, ka).addScaledVector(b, kb).sub(origin);
      pos.push(v.x, v.y, v.z);
      nrm.push(n.x, n.y, n.z);
      uv.push(ka ? u[2] : u[0], kb ? u[3] : u[1]);
    }
    // wind so the face looks along n
    const cross = new THREE.Vector3().crossVectors(a, b);
    if (cross.dot(n) > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  /** A plain box (frame-coloured) from its centre and half sizes along right / up / normal. */
  const box = (c: THREE.Vector3, r: THREE.Vector3, n: THREE.Vector3, hw: number, hh: number, hd: number) => {
    const up = new THREE.Vector3(0, 1, 0);
    const R = r.clone().multiplyScalar(hw);
    const U = up.clone().multiplyScalar(hh);
    const N = n.clone().multiplyScalar(hd);
    const corner = (kr: number, ku: number, kn: number) => c.clone().addScaledVector(R, kr).addScaledVector(U, ku).addScaledVector(N, kn);
    quad(corner(-1, -1, 1), R.clone().multiplyScalar(2), U.clone().multiplyScalar(2), n, frameUv);
    quad(corner(1, -1, -1), R.clone().multiplyScalar(-2), U.clone().multiplyScalar(2), n.clone().negate(), frameUv);
    quad(corner(1, -1, 1), N.clone().multiplyScalar(-2), U.clone().multiplyScalar(2), r, frameUv);
    quad(corner(-1, -1, -1), N.clone().multiplyScalar(2), U.clone().multiplyScalar(2), r.clone().negate(), frameUv);
    quad(corner(-1, 1, 1), R.clone().multiplyScalar(2), N.clone().multiplyScalar(-2), up, frameUv);
  };
  const faceUv = (cells: Cell[] | null): number[] | null => {
    if (!cells) return null;
    const f = faces.get(key(cells))!;
    return [f.x / ATLAS_W, 1 - (f.y + ROW_PX) / H, (f.x + f.f.w) / ATLAS_W, 1 - f.y / H];
  };
  for (const s of signs) {
    const n = new THREE.Vector3(headingVec(s.facing).x, 0, headingVec(s.facing).z);
    // the reader faces −n; their right is the face's +u
    const r = new THREE.Vector3(-n.z, 0, n.x).negate();
    const fh = s.big ? DRS_H : FACE_H;
    const fl = faces.get(key(s.front))!.f;
    const w = (fl.w / ROW_PX) * fh;
    const lift = s.big ? 0.6 : LIFT;
    const c = new THREE.Vector3(s.x, lift + fh / 2, s.z);
    // the box's frame round the faces
    box(c, r, n, w / 2 + 0.04, fh / 2 + 0.04, DEPTH / 2);
    // the faces, a hair proud of the frame
    const front = c.clone().addScaledVector(r, -w / 2).addScaledVector(n, DEPTH / 2 + 0.005);
    front.y -= fh / 2;
    quad(front, r.clone().multiplyScalar(w), new THREE.Vector3(0, fh, 0), n, faceUv(s.front)!);
    const backUv = faceUv(s.back);
    if (backUv) {
      const bl = faces.get(key(s.back!))!.f;
      const bw = Math.min(w, (bl.w / ROW_PX) * fh);
      const back = c.clone().addScaledVector(r, bw / 2).addScaledVector(n, -DEPTH / 2 - 0.005);
      back.y -= fh / 2;
      quad(back, r.clone().multiplyScalar(-bw), new THREE.Vector3(0, fh, 0), n.clone().negate(), backUv);
    }
    // frangible legs
    const legs = Math.max(2, Math.ceil(w / 2.5));
    for (let k = 0; k < legs; k++) {
      const lx = -w / 2 + 0.25 + ((w - 0.5) * k) / (legs - 1);
      box(new THREE.Vector3(s.x, lift / 2, s.z).addScaledVector(r, lx), r, n, 0.05, lift / 2, 0.05);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map, emissiveMap, emissive: '#ffffff', emissiveIntensity: 0, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}
