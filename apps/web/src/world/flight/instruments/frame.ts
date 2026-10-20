// The A320's flight deck structure round the captain's eye, drawn over the 3D view: the centre post
// and corner posts between the windscreen panes, the sliding side windows and the aft side windows,
// the brow above and the overhead panel, the rear wall with the flight deck door behind. It's
// geometry in the aircraft's body frame (metres, see a320.ts) projected through the camera, so the
// posts sit where they really are for the camera's field of view and slide past as the visitor
// looks round; looking aft there are no windows, and the wall covers the 3D model's cut-away nose.
//
// Everything that isn't glass is painted, then the windows are cut out of it. It is redrawn only
// when the view changes (the camera turning relative to the aircraft, a resize, the lighting).

import * as THREE from 'three';
import { A320_POINTS } from '../../../aviation/a320';

type P3 = readonly [number, number, number];

/** Round a polygon's corners (in 3D, before projection): each corner becomes a short curve. */
function rounded(pts: readonly P3[], r: number, steps = 4): P3[] {
  const out: P3[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]);
    const ta = Math.min(0.45, r / la);
    const tb = Math.min(0.45, r / lb);
    const s: P3 = [p[0] + (a[0] - p[0]) * ta, p[1] + (a[1] - p[1]) * ta, p[2] + (a[2] - p[2]) * ta];
    const e: P3 = [p[0] + (b[0] - p[0]) * tb, p[1] + (b[1] - p[1]) * tb, p[2] + (b[2] - p[2]) * tb];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([u * u * s[0] + 2 * u * t * p[0] + t * t * e[0], u * u * s[1] + 2 * u * t * p[1] + t * t * e[1], u * u * s[2] + 2 * u * t * p[2] + t * t * e[2]]);
    }
  }
  return out;
}

const mirror = (pts: readonly P3[]): P3[] => pts.map(([x, y, z]) => [-x, y, z] as P3).reverse();

// The glass, in the body frame. The windscreen panes meet at the centre post on the centreline; the
// corner posts are ~0.9 m out; the side windows run aft to the flight deck's rear wall at z ≈ −13.9.
const PANE_L: P3[] = [
  [-0.05, 4.3, -16.28],
  [-0.05, 5.07, -15.84],
  [-0.79, 5.0, -15.64],
  [-0.9, 4.31, -16.0],
];
const SIDE_L: P3[] = [
  [-0.99, 4.33, -15.9],
  [-0.88, 4.97, -15.56],
  [-1.04, 4.97, -14.86],
  [-1.18, 4.31, -14.96],
];
const AFT_L: P3[] = [
  [-1.2, 4.38, -14.78],
  [-1.07, 4.9, -14.72],
  [-1.1, 4.9, -14.12],
  [-1.24, 4.38, -14.12],
];
const WINDOWS: P3[][] = [PANE_L, mirror(PANE_L), SIDE_L, mirror(SIDE_L), AFT_L, mirror(AFT_L)].map((w) => rounded(w, 0.07));

/** Painted panels on the structure: the overhead panel, the flight deck door and the rear wall's equipment. */
const OVERHEAD: P3[] = rounded(
  [
    [-0.55, 5.32, -15.55],
    [0.55, 5.32, -15.55],
    [0.62, 5.42, -14.3],
    [-0.62, 5.42, -14.3],
  ],
  0.05,
);
const DOOR: P3[] = rounded(
  [
    [-0.38, 3.45, -13.9],
    [0.38, 3.45, -13.9],
    [0.38, 5.35, -13.9],
    [-0.38, 5.35, -13.9],
  ],
  0.04,
);
const DOOR_WINDOW: P3[] = rounded(
  [
    [-0.08, 4.55, -13.89],
    [0.08, 4.55, -13.89],
    [0.08, 4.75, -13.89],
    [-0.08, 4.75, -13.89],
  ],
  0.02,
);
const CB_PANEL: P3[] = [
  [-1.15, 4.3, -13.95],
  [-0.55, 4.3, -13.92],
  [-0.55, 5.25, -13.92],
  [-1.05, 5.25, -13.95],
];

export interface FrameColours {
  structure: string;
  shade: string;
  rim: string;
  overhead: string;
  door: string;
}

const EYE = new THREE.Vector3(A320_POINTS.eye.x, A320_POINTS.eye.y, A320_POINTS.eye.z);

export class WindshieldFrame {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private wantW = 0;
  private wantH = 0;
  private readonly observer: ResizeObserver | null;
  private readonly rel = new THREE.Quaternion();
  private readonly inv = new THREE.Quaternion();
  private readonly camQ = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly last = new THREE.Quaternion(2, 0, 0, 0);
  private lastFov = 0;
  private lastColours = '';
  /** Scratch for the clipped, projected polygon (screen px, flat x/y). */
  private readonly clipA: number[] = [];
  private readonly clipB: number[] = [];
  private readonly screen: number[] = [];

  constructor(className: string) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = className;
    this.g = this.canvas.getContext('2d')!;
    this.observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((e) => {
            this.wantW = e[0].contentRect.width;
            this.wantH = e[0].contentRect.height;
          })
        : null;
    this.observer?.observe(this.canvas);
  }

  /**
   * Draw the structure for the camera's direction relative to the aircraft (`aircraft` is the body
   * → world rotation). The camera is taken to be at the captain's eye, wherever it really is.
   */
  update(camera: THREE.PerspectiveCamera, aircraft: THREE.Quaternion, colours: FrameColours) {
    if (!this.observer) {
      this.wantW = this.canvas.clientWidth;
      this.wantH = this.canvas.clientHeight;
    }
    if (this.wantW < 8 || this.wantH < 8) return;
    camera.getWorldQuaternion(this.camQ);
    // the camera's rotation in the body frame
    this.rel.copy(aircraft).invert().multiply(this.camQ);
    const key = `${colours.structure}${colours.rim}`;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pw = Math.round(this.wantW * dpr);
    const ph = Math.round(this.wantH * dpr);
    const fov = camera.getEffectiveFOV();
    if (pw === this.w && ph === this.h && Math.abs(this.rel.dot(this.last)) > 0.999999 && fov === this.lastFov && key === this.lastColours) return;
    this.last.copy(this.rel);
    this.lastFov = fov;
    this.lastColours = key;
    if (pw !== this.w || ph !== this.h) {
      this.w = this.canvas.width = pw;
      this.h = this.canvas.height = ph;
    }
    this.inv.copy(this.rel).invert();
    const f = 1 / Math.tan((fov * Math.PI) / 360);
    const aspect = pw / ph;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    // the structure, lit a little from the windows above
    const grad = g.createLinearGradient(0, 0, 0, ph);
    grad.addColorStop(0, colours.shade);
    grad.addColorStop(0.35, colours.structure);
    grad.addColorStop(1, colours.shade);
    g.fillStyle = grad;
    g.fillRect(0, 0, pw, ph);
    // the panels painted on it
    this.fill(OVERHEAD, f, aspect, colours.overhead, null);
    this.fill(CB_PANEL, f, aspect, colours.door, null);
    this.fill(DOOR, f, aspect, colours.door, colours.rim);
    this.fill(DOOR_WINDOW, f, aspect, '#0b0d10', null);
    // cut the windows out, then draw their rims
    g.globalCompositeOperation = 'destination-out';
    for (const w of WINDOWS) this.fill(w, f, aspect, '#000', null);
    g.globalCompositeOperation = 'source-over';
    const rim = Math.max(2, ph / 260);
    for (const w of WINDOWS) {
      if (!this.path(w, f, aspect)) continue;
      g.strokeStyle = colours.rim;
      g.lineWidth = rim;
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.lineWidth = rim * 3;
      g.globalCompositeOperation = 'destination-over';
      g.stroke();
      g.globalCompositeOperation = 'source-over';
    }
  }

  dispose() {
    this.observer?.disconnect();
    this.canvas.remove();
  }

  private fill(pts: readonly P3[], f: number, aspect: number, fill: string, stroke: string | null) {
    if (!this.path(pts, f, aspect)) return;
    const g = this.g;
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = Math.max(1.5, this.h / 400);
      g.stroke();
    }
  }

  /** Put a body-frame polygon, clipped to the near plane and projected, in the context's path. False when nothing of it is in front. */
  private path(pts: readonly P3[], f: number, aspect: number): boolean {
    // into camera space (x right, y up, looking down −z)
    const a = this.clipA;
    a.length = 0;
    for (const p of pts) {
      this.v.set(p[0] - EYE.x, p[1] - EYE.y, p[2] - EYE.z).applyQuaternion(this.inv);
      a.push(this.v.x, this.v.y, this.v.z);
    }
    // Sutherland–Hodgman against z = −NEAR
    const NEAR = 0.02;
    const b = this.clipB;
    b.length = 0;
    const n = a.length / 3;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const za = a[i * 3 + 2];
      const zb = a[j * 3 + 2];
      const ina = za <= -NEAR;
      const inb = zb <= -NEAR;
      if (ina) b.push(a[i * 3], a[i * 3 + 1], za);
      if (ina !== inb) {
        const t = (-NEAR - za) / (zb - za);
        b.push(a[i * 3] + (a[j * 3] - a[i * 3]) * t, a[i * 3 + 1] + (a[j * 3 + 1] - a[i * 3 + 1]) * t, -NEAR);
      }
    }
    if (b.length < 9) return false;
    const s = this.screen;
    s.length = 0;
    const hw = this.w / 2;
    const hh = this.h / 2;
    for (let i = 0; i < b.length; i += 3) {
      const iz = -1 / b[i + 2];
      // far off-screen points are clamped so the canvas path stays well-conditioned
      s.push(Math.max(-1e5, Math.min(1e5, hw + ((b[i] * f) / aspect) * iz * hw)), Math.max(-1e5, Math.min(1e5, hh - b[i + 1] * f * iz * hh)));
    }
    const g = this.g;
    g.beginPath();
    g.moveTo(s[0], s[1]);
    for (let i = 2; i < s.length; i += 2) g.lineTo(s[i], s[i + 1]);
    g.closePath();
    return true;
  }
}
