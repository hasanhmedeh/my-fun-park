// The airport's signage, painted into one shared atlas texture so every sign, shop front, gate
// number and airline header in the terminal and on the forecourt draws in a single call: wayfinding
// in the international style (yellow on charcoal, standard pictograms and arrows), the airline's
// branding, shop and café fronts, and the big gate numbers on the airside facade. Fictional names
// only.

import * as THREE from 'three';
import type { Ctx } from '../context';
import { BODY_FONT, canvasTex, DISPLAY_FONT, PALETTE } from '../textures';
import type { UvRect } from './terminal-kit';

const W = 2048;
const H = 3584;
const PAD = 4;

/** Wayfinding colours: directions are yellow on charcoal, locations charcoal on yellow. */
export const SIGN = { bg: '#24272d', fg: '#ffcc1a', white: '#f4f4f0', line: '#3a3e46' };
/** Funfair Air's colours. */
export const AIRLINE = { ink: PALETTE.ink, red: PALETTE.candy, cream: PALETTE.cream, gold: PALETTE.mustard };

export type Pictogram =
  | 'departures'
  | 'arrivals'
  | 'baggage'
  | 'toilets'
  | 'cafe'
  | 'food'
  | 'shop'
  | 'info'
  | 'security'
  | 'gate'
  | 'train'
  | 'lift'
  | 'taxi'
  | 'bus'
  | 'parking'
  | 'checkin'
  | 'carhire'
  | 'meeting';
export type Arrow = '←' | '→' | '↑' | '↓' | '↖' | '↗' | '↙' | '↘';
const ARROWS: Record<Arrow, number> = { '↑': 0, '↗': 45, '→': 90, '↘': 135, '↓': 180, '↙': 225, '←': 270, '↖': 315 };
const isArrow = (s: string): s is Arrow => s in ARROWS;
const PICTOS = new Set<string>(['departures', 'arrivals', 'baggage', 'toilets', 'cafe', 'food', 'shop', 'info', 'security', 'gate', 'train', 'lift', 'taxi', 'bus', 'parking', 'checkin', 'carhire', 'meeting']);
const isPicto = (s: string): s is Pictogram => PICTOS.has(s);

// ------------------------------------------------------------------------------------------------
// Pictograms (drawn in a unit box: (0,0)–(1,1), y down)
// ------------------------------------------------------------------------------------------------

function planeShape(g: CanvasRenderingContext2D) {
  // seen from above, nose up: fuselage, swept wings, tailplane
  g.beginPath();
  g.moveTo(0.5, 0.04);
  g.quadraticCurveTo(0.56, 0.08, 0.56, 0.2);
  g.lineTo(0.56, 0.4);
  g.lineTo(0.95, 0.6);
  g.lineTo(0.95, 0.68);
  g.lineTo(0.56, 0.56);
  g.lineTo(0.55, 0.8);
  g.lineTo(0.7, 0.9);
  g.lineTo(0.7, 0.96);
  g.lineTo(0.5, 0.91);
  g.lineTo(0.3, 0.96);
  g.lineTo(0.3, 0.9);
  g.lineTo(0.45, 0.8);
  g.lineTo(0.44, 0.56);
  g.lineTo(0.05, 0.68);
  g.lineTo(0.05, 0.6);
  g.lineTo(0.44, 0.4);
  g.lineTo(0.44, 0.2);
  g.quadraticCurveTo(0.44, 0.08, 0.5, 0.04);
  g.closePath();
  g.fill();
}

function person(g: CanvasRenderingContext2D, x: number, y: number, s: number, skirt = false) {
  g.beginPath();
  g.arc(x, y + s * 0.09, s * 0.085, 0, Math.PI * 2);
  g.fill();
  if (skirt) {
    g.beginPath();
    g.moveTo(x - s * 0.1, y + s * 0.21);
    g.lineTo(x + s * 0.1, y + s * 0.21);
    g.lineTo(x + s * 0.19, y + s * 0.62);
    g.lineTo(x - s * 0.19, y + s * 0.62);
    g.closePath();
    g.fill();
  } else g.fillRect(x - s * 0.12, y + s * 0.21, s * 0.24, s * 0.42);
  g.fillRect(x - s * 0.1, y + s * 0.6, s * 0.08, s * 0.38);
  g.fillRect(x + s * 0.02, y + s * 0.6, s * 0.08, s * 0.38);
  // arms
  g.fillRect(x - s * 0.19, y + s * 0.22, s * 0.06, s * 0.32);
  g.fillRect(x + s * 0.13, y + s * 0.22, s * 0.06, s * 0.32);
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function car(g: CanvasRenderingContext2D, x: number, y: number, w: number) {
  // side view: body, cabin, wheels
  const h = w * 0.42;
  rrect(g, x, y + h * 0.35, w, h * 0.42, w * 0.06);
  g.fill();
  g.beginPath();
  g.moveTo(x + w * 0.2, y + h * 0.37);
  g.lineTo(x + w * 0.32, y);
  g.lineTo(x + w * 0.72, y);
  g.lineTo(x + w * 0.84, y + h * 0.37);
  g.closePath();
  g.fill();
  g.beginPath();
  g.arc(x + w * 0.24, y + h * 0.8, w * 0.1, 0, Math.PI * 2);
  g.arc(x + w * 0.76, y + h * 0.8, w * 0.1, 0, Math.PI * 2);
  g.fill();
}

export function drawPictogram(g: CanvasRenderingContext2D, kind: Pictogram, x: number, y: number, s: number, fg: string, bg: string) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = fg;
  g.strokeStyle = fg;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (kind) {
    case 'departures':
    case 'arrivals':
    case 'gate': {
      g.save();
      g.translate(0.5, 0.48);
      g.rotate(kind === 'departures' ? Math.PI / 4 : kind === 'arrivals' ? (3 * Math.PI) / 4 : Math.PI / 2);
      g.scale(0.82, 0.82);
      g.translate(-0.5, -0.5);
      planeShape(g);
      g.restore();
      if (kind !== 'gate') g.fillRect(0.06, 0.9, 0.88, 0.06);
      break;
    }
    case 'baggage': {
      rrect(g, 0.2, 0.28, 0.6, 0.46, 0.06);
      g.fill();
      g.lineWidth = 0.06;
      rrect(g, 0.37, 0.14, 0.26, 0.18, 0.05);
      g.stroke();
      g.fillStyle = bg;
      g.fillRect(0.33, 0.32, 0.04, 0.38);
      g.fillRect(0.63, 0.32, 0.04, 0.38);
      g.fillStyle = fg;
      // the reclaim belt under it
      g.fillRect(0.04, 0.82, 0.92, 0.08);
      for (const cx of [0.16, 0.38, 0.62, 0.84]) {
        g.beginPath();
        g.arc(cx, 0.94, 0.04, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'toilets': {
      person(g, 0.25, 0.02, 0.96);
      person(g, 0.75, 0.02, 0.96, true);
      g.fillRect(0.485, 0.02, 0.03, 0.96);
      break;
    }
    case 'cafe': {
      // cup and saucer, with steam
      g.beginPath();
      g.moveTo(0.18, 0.42);
      g.lineTo(0.7, 0.42);
      g.quadraticCurveTo(0.7, 0.8, 0.44, 0.8);
      g.quadraticCurveTo(0.18, 0.8, 0.18, 0.42);
      g.fill();
      g.lineWidth = 0.06;
      g.beginPath();
      g.arc(0.74, 0.54, 0.1, -Math.PI / 2, Math.PI / 2);
      g.stroke();
      g.fillRect(0.08, 0.86, 0.74, 0.06);
      g.lineWidth = 0.045;
      for (const sx of [0.32, 0.46, 0.6]) {
        g.beginPath();
        g.moveTo(sx, 0.34);
        g.bezierCurveTo(sx - 0.06, 0.26, sx + 0.06, 0.2, sx, 0.1);
        g.stroke();
      }
      break;
    }
    case 'food': {
      // fork and knife
      g.lineWidth = 0.06;
      for (const fx of [0.24, 0.32, 0.4]) {
        g.beginPath();
        g.moveTo(fx, 0.08);
        g.lineTo(fx, 0.34);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(0.24, 0.34);
      g.quadraticCurveTo(0.32, 0.46, 0.4, 0.34);
      g.stroke();
      g.fillRect(0.29, 0.4, 0.06, 0.54);
      g.beginPath();
      g.moveTo(0.64, 0.08);
      g.quadraticCurveTo(0.8, 0.2, 0.74, 0.52);
      g.lineTo(0.68, 0.52);
      g.lineTo(0.68, 0.94);
      g.lineTo(0.62, 0.94);
      g.closePath();
      g.fill();
      break;
    }
    case 'shop': {
      g.beginPath();
      g.moveTo(0.18, 0.34);
      g.lineTo(0.82, 0.34);
      g.lineTo(0.88, 0.92);
      g.lineTo(0.12, 0.92);
      g.closePath();
      g.fill();
      g.lineWidth = 0.06;
      g.beginPath();
      g.arc(0.5, 0.34, 0.16, Math.PI, 0);
      g.stroke();
      break;
    }
    case 'info': {
      g.beginPath();
      g.arc(0.5, 0.2, 0.09, 0, Math.PI * 2);
      g.fill();
      g.fillRect(0.42, 0.36, 0.16, 0.5);
      g.fillRect(0.34, 0.36, 0.12, 0.08);
      g.fillRect(0.34, 0.82, 0.32, 0.08);
      break;
    }
    case 'security': {
      // a traveller walking through the scanner's arch
      g.lineWidth = 0.07;
      g.beginPath();
      g.moveTo(0.14, 0.96);
      g.lineTo(0.14, 0.12);
      g.lineTo(0.86, 0.12);
      g.lineTo(0.86, 0.96);
      g.stroke();
      person(g, 0.5, 0.2, 0.74);
      break;
    }
    case 'train': {
      rrect(g, 0.2, 0.06, 0.6, 0.72, 0.14);
      g.fill();
      g.fillStyle = bg;
      rrect(g, 0.28, 0.16, 0.44, 0.26, 0.05);
      g.fill();
      g.beginPath();
      g.arc(0.33, 0.6, 0.05, 0, Math.PI * 2);
      g.arc(0.67, 0.6, 0.05, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = fg;
      g.lineWidth = 0.06;
      g.beginPath();
      g.moveTo(0.3, 0.8);
      g.lineTo(0.16, 0.96);
      g.moveTo(0.7, 0.8);
      g.lineTo(0.84, 0.96);
      g.stroke();
      break;
    }
    case 'lift': {
      g.lineWidth = 0.06;
      rrect(g, 0.08, 0.06, 0.84, 0.88, 0.06);
      g.stroke();
      person(g, 0.36, 0.22, 0.66);
      g.beginPath();
      g.moveTo(0.72, 0.24);
      g.lineTo(0.82, 0.38);
      g.lineTo(0.62, 0.38);
      g.closePath();
      g.moveTo(0.72, 0.76);
      g.lineTo(0.82, 0.62);
      g.lineTo(0.62, 0.62);
      g.closePath();
      g.fill();
      break;
    }
    case 'taxi': {
      car(g, 0.06, 0.38, 0.88);
      rrect(g, 0.36, 0.2, 0.28, 0.14, 0.03);
      g.fill();
      break;
    }
    case 'bus': {
      rrect(g, 0.16, 0.06, 0.68, 0.78, 0.1);
      g.fill();
      g.fillStyle = bg;
      g.fillRect(0.24, 0.18, 0.52, 0.3);
      g.beginPath();
      g.arc(0.3, 0.66, 0.05, 0, Math.PI * 2);
      g.arc(0.7, 0.66, 0.05, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = fg;
      g.fillRect(0.22, 0.84, 0.14, 0.12);
      g.fillRect(0.64, 0.84, 0.14, 0.12);
      break;
    }
    case 'parking': {
      g.font = `900 0.86px ${BODY_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('P', 0.5, 0.55);
      break;
    }
    case 'checkin': {
      // a traveller at a desk, a bag on the scale
      person(g, 0.3, 0.04, 0.92);
      g.fillRect(0.5, 0.52, 0.46, 0.08);
      g.fillRect(0.88, 0.6, 0.08, 0.36);
      rrect(g, 0.56, 0.26, 0.26, 0.24, 0.04);
      g.fill();
      break;
    }
    case 'carhire': {
      car(g, 0.06, 0.46, 0.88);
      g.lineWidth = 0.06;
      g.beginPath();
      g.arc(0.3, 0.2, 0.1, 0, Math.PI * 2);
      g.moveTo(0.4, 0.2);
      g.lineTo(0.8, 0.2);
      g.moveTo(0.7, 0.2);
      g.lineTo(0.7, 0.3);
      g.stroke();
      break;
    }
    case 'meeting': {
      person(g, 0.3, 0.04, 0.92);
      person(g, 0.7, 0.04, 0.92, true);
      break;
    }
  }
  g.restore();
}

function drawArrow(g: CanvasRenderingContext2D, a: Arrow, x: number, y: number, s: number, fg: string) {
  g.save();
  g.translate(x + s / 2, y + s / 2);
  g.rotate((ARROWS[a] * Math.PI) / 180);
  g.fillStyle = fg;
  g.beginPath();
  g.moveTo(0, -s * 0.44);
  g.lineTo(s * 0.36, -s * 0.06);
  g.lineTo(s * 0.12, -s * 0.06);
  g.lineTo(s * 0.12, s * 0.44);
  g.lineTo(-s * 0.12, s * 0.44);
  g.lineTo(-s * 0.12, -s * 0.06);
  g.lineTo(-s * 0.36, -s * 0.06);
  g.closePath();
  g.fill();
  g.restore();
}

// ------------------------------------------------------------------------------------------------
// The atlas
// ------------------------------------------------------------------------------------------------

/** One shared canvas of every sign (see the file comment), packed in shelves. */
export class SignAtlas {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  /** Backlit signs: the painted face also glows (brighter at night). */
  readonly material: THREE.MeshStandardMaterial;
  private readonly g: CanvasRenderingContext2D;
  private readonly regions = new Map<string, { uv: UvRect; w: number; h: number }>();
  /** Open shelves (rows of regions): their top, height, and how far along they are filled. */
  private readonly shelves: { y: number; h: number; x: number }[] = [];
  private bottom = PAD;

  constructor(renderer: THREE.WebGLRenderer) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.g.fillStyle = SIGN.bg;
    this.g.fillRect(0, 0, W, H);
    this.texture = canvasTex(this.canvas, renderer);
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissive: '#ffffff',
      emissiveMap: this.texture,
      emissiveIntensity: 0.35,
      roughness: 0.45,
      metalness: 0,
    });
  }

  /** The region painted under `key` (painting it, `w` × `h` px, the first time it's asked for). */
  region(key: string, w: number, h: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): UvRect {
    const hit = this.regions.get(key);
    if (hit) return hit.uv;
    w = Math.min(Math.ceil(w), W - 2 * PAD);
    h = Math.ceil(h);
    // best fit: the lowest shelf tall enough (but not wastefully tall) with room left, else a new one
    let best: { y: number; h: number; x: number } | null = null;
    for (const sh of this.shelves) if (sh.h >= h && sh.h <= h * 1.35 + 8 && sh.x + w + PAD <= W && (!best || sh.h < best.h)) best = sh;
    if (!best) {
      if (this.bottom + h + PAD > H) throw new Error(`sign atlas full (${key})`);
      best = { y: this.bottom, h, x: PAD };
      this.shelves.push(best);
      this.bottom += h + PAD * 2;
    }
    const x = best.x;
    const y = best.y;
    best.x += w + PAD * 2;
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    paint(g, w, h);
    g.restore();
    this.texture.needsUpdate = true;
    // canvas y runs down, texture v up (flipY): a half-texel inset keeps neighbours from bleeding in
    const uv = { u0: (x + 0.5) / W, u1: (x + w - 0.5) / W, v0: 1 - (y + h - 0.5) / H, v1: 1 - (y + 0.5) / H };
    this.regions.set(key, { uv, w, h });
    return uv;
  }

  /** The pixel size of a region painted earlier (its aspect sets the panel's shape). */
  size(key: string) {
    const r = this.regions.get(key);
    return r ? { w: r.w, h: r.h } : null;
  }

  /** Signs glow a little by day (backlit) and properly at night. */
  setNight(k: number) {
    this.material.emissiveIntensity = THREE.MathUtils.lerp(0.35, 1.25, k);
  }
}

const atlases = new WeakMap<THREE.WebGLRenderer, SignAtlas>();
/** The airport's sign atlas (one per renderer). */
export function signAtlas(ctx: Ctx) {
  let a = atlases.get(ctx.renderer);
  if (!a) atlases.set(ctx.renderer, (a = new SignAtlas(ctx.renderer)));
  return a;
}

// ------------------------------------------------------------------------------------------------
// Sign painters
// ------------------------------------------------------------------------------------------------

export interface PaintedSign {
  uv: UvRect;
  /** Width / height of the painted sign. */
  aspect: number;
}

/**
 * A wayfinding sign: a row of arrows, pictograms and words, e.g. ['←', 'gate', 'Gates 1–6'].
 * `location` paints a location sign (charcoal on yellow) instead of a direction sign.
 */
export function wayfinding(atlas: SignAtlas, parts: string[], opts: { location?: boolean; height?: number } = {}): PaintedSign {
  const h = opts.height ?? 96;
  const fg = opts.location ? SIGN.bg : SIGN.fg;
  const bg = opts.location ? SIGN.fg : SIGN.bg;
  const font = `700 ${Math.round(h * 0.46)}px ${BODY_FONT}`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const icon = h * 0.7;
  const gap = h * 0.22;
  let w = gap;
  for (const p of parts) w += (isArrow(p) || isPicto(p) ? icon : measure.measureText(p).width) + gap;
  w += gap * 0.5;
  const key = `way:${opts.location ? 'L' : 'D'}:${h}:${parts.join('|')}`;
  const uv = atlas.region(key, w, h, (g, cw, ch) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, cw, ch);
    let x = gap;
    const y = (ch - icon) / 2;
    g.font = font;
    g.textBaseline = 'middle';
    for (const p of parts) {
      if (isArrow(p)) {
        drawArrow(g, p, x, y, icon, fg);
        x += icon + gap;
      } else if (isPicto(p)) {
        // pictograms sit in a white-edged square on direction signs, like the real thing
        if (!opts.location) {
          g.fillStyle = SIGN.white;
          rrect(g, x, y, icon, icon, icon * 0.1);
          g.fill();
          drawPictogram(g, p, x + icon * 0.12, y + icon * 0.12, icon * 0.76, SIGN.bg, SIGN.white);
        } else drawPictogram(g, p, x + icon * 0.06, y + icon * 0.06, icon * 0.88, fg, bg);
        x += icon + gap;
      } else {
        g.fillStyle = fg;
        g.fillText(p, x, ch / 2 + h * 0.02);
        x += g.measureText(p).width + gap;
      }
    }
    // a thin border, as on the real panels
    g.strokeStyle = opts.location ? SIGN.bg : SIGN.line;
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, cw - 3, ch - 3);
  });
  const s = atlas.size(key)!;
  return { uv, aspect: s.w / s.h };
}

/** The airline's header: "Funfair Air" in the display font with the ferris-wheel mark, `sub` underneath. */
export function airlineHeader(atlas: SignAtlas, title: string, sub: string, colours = AIRLINE): PaintedSign {
  const w = 1024;
  const h = 192;
  const key = `airline:${title}:${sub}:${colours.ink}:${colours.red}`;
  const uv = atlas.region(key, w, h, (g) => {
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, colours.ink);
    grad.addColorStop(1, '#2d1d58');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = colours.red;
    g.fillRect(0, h - 18, w, 18);
    g.fillStyle = colours.gold;
    g.fillRect(0, h - 26, w, 8);
    wheelMark(g, 100, h / 2 - 8, 62, colours);
    g.fillStyle = colours.cream;
    g.textBaseline = 'middle';
    g.font = `92px ${DISPLAY_FONT}`;
    g.fillText(title, 196, h / 2 - 22);
    g.font = `700 34px ${BODY_FONT}`;
    g.fillStyle = colours.gold;
    g.fillText(sub, 200, h / 2 + 44);
  });
  return { uv, aspect: w / h };
}

/** Funfair Air's mark: a little ferris wheel in a roundel. */
export function wheelMark(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, colours = AIRLINE) {
  g.save();
  g.fillStyle = colours.red;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = colours.cream;
  g.lineWidth = r * 0.08;
  g.beginPath();
  g.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
    g.stroke();
    g.fillStyle = colours.gold;
    g.beginPath();
    g.arc(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62, r * 0.11, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** The end of a check-in island's bulkhead: the airline's mark over its name, seen down the hall. */
export function islandEnd(atlas: SignAtlas, title: string, colours = AIRLINE): PaintedSign {
  const s = 224;
  const uv = atlas.region(`island-end:${title}:${colours.ink}`, s, s, (g) => {
    g.fillStyle = colours.ink;
    g.fillRect(0, 0, s, s);
    g.fillStyle = colours.gold;
    g.fillRect(0, s - 22, s, 6);
    g.fillStyle = colours.red;
    g.fillRect(0, s - 16, s, 16);
    wheelMark(g, s / 2, 84, 62, colours);
    g.fillStyle = colours.cream;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // the longest name has to fit the square: shrink the type until it does
    let px = 34;
    do g.font = `${px--}px ${DISPLAY_FONT}`;
    while (g.measureText(title).width > s - 20 && px > 12);
    g.fillText(title, s / 2, 175);
  });
  return { uv, aspect: 1 };
}

/** A shop or café front's fascia: a name in its own colours. */
export function fascia(atlas: SignAtlas, name: string, sub: string, bg: string, fg: string, accent: string): PaintedSign {
  const w = 768;
  const h = 128;
  const uv = atlas.region(`fascia:${name}`, w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    g.fillRect(0, h - 12, w, 12);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 70;
    g.font = `${size}px ${DISPLAY_FONT}`;
    while (g.measureText(name).width > w - 60 && size > 30) g.font = `${(size -= 4)}px ${DISPLAY_FONT}`;
    g.fillText(name, w / 2, sub ? h * 0.4 : h / 2);
    if (sub) {
      g.font = `700 24px ${BODY_FONT}`;
      g.fillStyle = accent;
      g.fillText(sub.toUpperCase(), w / 2, h * 0.8);
    }
  });
  return { uv, aspect: w / h };
}

/** The gate number on the airside facade and in the lounge: a big numeral, "Gate" above it. */
export function gateNumber(atlas: SignAtlas, gate: number): PaintedSign {
  const w = 192;
  const h = 256;
  const uv = atlas.region(`gate:${gate}`, w, h, (g) => {
    g.fillStyle = SIGN.fg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = SIGN.bg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 40px ${BODY_FONT}`;
    g.fillText('GATE', w / 2, 38);
    g.font = `800 170px ${BODY_FONT}`;
    g.fillText(String(gate), w / 2, 156);
  });
  return { uv, aspect: w / h };
}

/** A menu board / poster: a coloured panel with a title and a few lines (cafés, the food court, adverts). */
export function poster(atlas: SignAtlas, key: string, title: string, lines: string[], bg: string, fg: string, accent: string): PaintedSign {
  const w = 336;
  const h = 224;
  const uv = atlas.region(`poster:${key}`, w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    g.fillRect(0, 0, w, 64);
    g.fillStyle = bg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `40px ${DISPLAY_FONT}`;
    g.fillText(title, w / 2, 32);
    g.fillStyle = fg;
    g.textAlign = 'left';
    g.font = `700 23px ${BODY_FONT}`;
    lines.forEach((l, i) => {
      const [item, price] = l.split('|');
      g.fillText(item, 20, 88 + i * 34);
      if (price) {
        g.textAlign = 'right';
        g.fillText(price, w - 20, 88 + i * 34);
        g.textAlign = 'left';
      }
    });
  });
  return { uv, aspect: w / h };
}

/** Big lettering painted on a dark or clear ground (e.g. "Funfair International" over the doors). */
export function lettering(atlas: SignAtlas, text: string, opts: { fg: string; bg: string; font?: string; height?: number }): PaintedSign {
  const h = opts.height ?? 128;
  const font = opts.font ?? `${Math.round(h * 0.7)}px ${DISPLAY_FONT}`;
  const m = document.createElement('canvas').getContext('2d')!;
  m.font = font;
  const w = m.measureText(text).width + h * 0.6;
  const key = `letters:${text}:${opts.fg}:${opts.bg}:${h}`;
  const uv = atlas.region(key, w, h, (g, cw, ch) => {
    g.fillStyle = opts.bg;
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = opts.fg;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cw / 2, ch * 0.54);
  });
  const s = atlas.size(key)!;
  return { uv, aspect: s.w / s.h };
}

/**
 * Small numbers 1..`count` (desk numbers, lane numbers) painted once as a grid in one region,
 * yellow on charcoal; each is a cell of it.
 */
export function smallNumber(atlas: SignAtlas, n: number, count = 72): PaintedSign {
  const cols = 12;
  const rows = Math.ceil(count / cols);
  const cw = 60;
  const ch = 44;
  const uv = atlas.region(`numbers:${count}`, cols * cw, rows * ch, (g) => {
    g.fillStyle = SIGN.bg;
    g.fillRect(0, 0, cols * cw, rows * ch);
    g.fillStyle = SIGN.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 32px ${BODY_FONT}`;
    for (let i = 0; i < count; i++) g.fillText(String(i + 1), (i % cols) * cw + cw / 2, Math.floor(i / cols) * ch + ch / 2 + 1);
  });
  const i = n - 1;
  const du = (uv.u1 - uv.u0) / cols;
  const dv = (uv.v1 - uv.v0) / rows;
  const c = i % cols;
  const r = Math.floor(i / cols);
  // canvas rows run down, v runs up
  return { uv: { u0: uv.u0 + c * du, u1: uv.u0 + (c + 1) * du, v0: uv.v1 - (r + 1) * dv, v1: uv.v1 - r * dv }, aspect: cw / ch };
}
