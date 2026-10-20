// What every display unit shares: the ECAM colour code, the cockpit font, a square canvas drawn in
// its own 1000 × 1000 units whatever its size on screen (sharp at the device's pixel ratio), and the
// little drawing helpers the PFD, ND, EWD and standby are made of.

import type { FcuState, IlsReading } from '../../../aviation/types';
import type { CockpitData } from './types';

/** The Airbus display colours: green for what is, cyan for what's selected or armed, magenta for what's managed, amber and red for cautions and warnings. */
export const C = {
  green: '#3cff4e',
  cyan: '#30e6ff',
  magenta: '#ff5cf4',
  amber: '#ffa31a',
  red: '#ff3b30',
  white: '#ffffff',
  yellow: '#ffee30',
  grey: '#9aa1ab',
  tape: '#4e535b',
  dark: '#1b1d22',
  sky: '#1e7fdc',
  ground: '#8a5527',
  black: '#000000',
} as const;

/**
 * B612 is the typeface Airbus and ENAC drew for cockpit screens; it comes from Google Fonts via
 * cockpit.css, with a plain monospace behind it while it loads (or if it can't).
 */
export const FONT_STACK = '"B612 Mono", "B612", ui-monospace, Menlo, Consolas, monospace';
export const font = (size: number, weight = 400) => `${weight} ${size}px ${FONT_STACK}`;

let fontWait: Promise<void> | null = null;
/** Resolves once B612 is ready to draw with, or after 2.5 s regardless (so a blocked font never blanks the instruments). */
export function cockpitFontReady(): Promise<void> {
  if (!fontWait) {
    const timeout = new Promise<void>((r) => setTimeout(r, 2500));
    const load = typeof document !== 'undefined' && document.fonts
      ? Promise.all([document.fonts.load('32px "B612 Mono"'), document.fonts.load('700 32px "B612 Mono"'), document.fonts.load('32px "B612"')]).then(() => undefined)
      : Promise.resolve();
    fontWait = Promise.race([load.catch(() => undefined), timeout]);
  }
  return fontWait;
}

export const UNITS = 1000;

/**
 * One display unit: a square canvas whose drawing space is UNITS × UNITS. The backing store follows
 * the element's size on screen (a ResizeObserver, not a layout read per frame) at up to 2× the
 * pixel ratio, and redraws are paced to `hz`.
 */
export class Display {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  private size = 0;
  private wantSize = 0;
  private readonly observer: ResizeObserver | null;
  private clock = 0;
  private readonly period: number;

  constructor(className: string, hz: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = className;
    this.g = this.canvas.getContext('2d')!;
    this.period = 1 / hz;
    this.observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((e) => (this.wantSize = e[0].contentRect.width)) : null;
    this.observer?.observe(this.canvas);
  }

  /** Whether a redraw is due this frame (and resets the pacing when it is). */
  due(dt: number) {
    this.clock += dt;
    if (this.clock < this.period) return false;
    this.clock = this.clock % this.period;
    return true;
  }

  /** Force the next due() to fire (after a layout change, so a resized display doesn't sit blank). */
  invalidate() {
    this.clock = this.period;
  }

  /** Size the backing store, set the unit transform and clear to black. False when the canvas isn't on screen. */
  begin(): boolean {
    if (!this.observer) this.wantSize = this.canvas.clientWidth;
    const css = this.wantSize;
    if (css < 8) return false;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const px = Math.round(css * dpr);
    if (px !== this.size) {
      this.size = px;
      this.canvas.width = px;
      this.canvas.height = px;
    }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.black;
    g.fillRect(0, 0, px, px);
    const k = px / UNITS;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.lineJoin = 'round';
    g.lineCap = 'butt';
    return true;
  }

  dispose() {
    this.observer?.disconnect();
    this.canvas.remove();
  }
}

// ------------------------------------------------------------------------------------------------
// Drawing helpers (all in display units)
// ------------------------------------------------------------------------------------------------

export function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, colour: string, size: number, align: CanvasTextAlign = 'center', weight = 400) {
  g.font = font(size, weight);
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillStyle = colour;
  g.fillText(s, x, y);
}

export function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string, width: number) {
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

export function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string, width: number) {
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.strokeRect(x, y, w, h);
}

/** A closed polygon from flat [x0, y0, x1, y1, …], filled and/or stroked. */
export function poly(g: CanvasRenderingContext2D, pts: readonly number[], fill: string | null, stroke: string | null = null, width = 3) {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.stroke();
  }
}

/** A vertical barber pole (the speed tape's red-and-black limits) between y0 and y1. */
export function barber(g: CanvasRenderingContext2D, x: number, y0: number, y1: number, w: number, a: string, b: string) {
  const top = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  if (h < 1) return;
  g.fillStyle = b;
  g.fillRect(x, top, w, h);
  g.fillStyle = a;
  const step = 22;
  const start = Math.floor(top / step) * step;
  g.save();
  g.beginPath();
  g.rect(x, top, w, h);
  g.clip();
  for (let y = start; y < top + h; y += step) g.fillRect(x, y, w, step / 2);
  g.restore();
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Signed difference a − b in degrees, −180..180. */
export const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
export const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');
/** Whether a blinking element is lit now (1 Hz, as the ECAM flashes). */
export const blink = (t: number, hz = 1) => (t * hz) % 1 < 0.6;

// ------------------------------------------------------------------------------------------------
// What the displays share about the guidance
// ------------------------------------------------------------------------------------------------


/** The lateral guidance is managed (NAV, the localizer, or NAV armed for takeoff): the FCU shows dashes and the displays no selected heading. */
export const lateralManaged = (fma: FcuState['fma']) => fma.lateral === 'NAV' || fma.lateral === 'LOC' || fma.lateral === 'LOC*' || (fma.lateral !== 'HDG' && fma.armedLateral === 'NAV');

/** The arrival ILS on the PFD and ND: once it has a signal, with LOC or APPR armed, or on the approach (not merely tuned on the departure runway). */
export function ilsShown(d: CockpitData): IlsReading | null {
  const ils = d.ils;
  if (!ils) return null;
  return ils.valid || d.fcu.loc || d.fcu.appr || d.phase === 'approach' || d.phase === 'final' || d.phase === 'landing' ? ils : null;
}
