// Paints the A320's texture atlas (atlas.ts) for a livery: the fuselage with its belly colour
// sweeping up into the tail, cheatline, titles, registration, cabin and cockpit windows and door
// outlines; the fin's tail art on both sides; the engine cowls; the wing panels; the fan face; and
// the solid swatches. Everything is placed through the shape's own section tables, so a window
// painted at 4.5 m lands at 4.5 m on the skin.
//
// Two livery-independent maps share the layout: `surface` (roughness in G, metalness in B, the
// glTF packing MeshStandardMaterial reads) and `glow` (R: cabin windows, G: the fin washed by the
// logo lights, B: the nose-gear lamps), which the model's shader turns into night lighting.

import { BODY_FONT, DISPLAY_FONT } from '../../textures';
import type { Livery } from '../../../aviation/types';
import { ATLAS, FIN_MAP, REGION, SWATCHES, finPx, fusPx, nacPx, swatchRect, wingPx, type Rect, type Swatch } from './atlas';
import {
  CARGO,
  CONST_Z,
  DOOR,
  DOORS,
  EXIT,
  LENGTH,
  MAIN_GEAR,
  NACELLE,
  NOSE_Z,
  OVERWING,
  SLATS,
  TAIL_Z,
  WINDOW,
  WING,
  finAt,
  fuselage as FUS,
  phiAt,
  sAtHeight,
  sOnRay,
  sectionTable,
  skinPoint,
  smoothstep,
  windowStations,
  wingLeZ,
  wingTeZ,
} from './shape';

type C2D = CanvasRenderingContext2D;

function canvas(k: number) {
  const c = document.createElement('canvas');
  c.width = ATLAS.w * k;
  c.height = ATLAS.h * k;
  const g = c.getContext('2d')!;
  g.scale(k, k);
  return { c, g };
}

// ------------------------------------------------------------------------------------------------
// The livery's geometry on the fuselage
// ------------------------------------------------------------------------------------------------

/** The belly colour's upper edge (m): level under the cabin, sweeping up over the tail cone into the fin. */
export const beltY = (z: number) => 3.12 + (6.0 - 3.12) * smoothstep(6.5, 18.6, z) ** 1.25;
const CHEAT = { off: 0.1, w: 0.2 };
const STEP = 0.06;

/** A band on one side between heights lo(z) and hi(z), as a canvas polygon (z from z0 to z1). */
function band(g: C2D, side: 'L' | 'R', z0: number, z1: number, lo: (z: number) => number, hi: (z: number) => number) {
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  for (let z = z0; z <= z1 + 1e-6; z += STEP) {
    const zz = Math.min(z, z1);
    top.push(fusPx(zz, sAtHeight(zz, side, hi(zz))));
    bot.push(fusPx(zz, sAtHeight(zz, side, lo(zz))));
  }
  g.beginPath();
  g.moveTo(...top[0]);
  for (const p of top) g.lineTo(...p);
  for (let i = bot.length - 1; i >= 0; i--) g.lineTo(...bot[i]);
  g.closePath();
  g.fill();
}

/** A rounded rectangle on the skin: z centre and width, heights from y0 to y1, on one side. */
function skinRect(g: C2D, side: 'L' | 'R', zc: number, w: number, y0: number, y1: number, r: number) {
  const n = 6;
  const pts: [number, number][] = [];
  const corner = (cz: number, cy: number, a0: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (Math.PI / 2) * (i / n);
      const z = cz + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      pts.push(fusPx(z, sAtHeight(zc, side, y)));
    }
  };
  const za = zc - w / 2 + r;
  const zb = zc + w / 2 - r;
  corner(zb, y1 - r, 0);
  corner(za, y1 - r, Math.PI / 2);
  corner(za, y0 + r, Math.PI);
  corner(zb, y0 + r, Math.PI * 1.5);
  g.beginPath();
  g.moveTo(...pts[0]);
  for (const p of pts) g.lineTo(...p);
  g.closePath();
}

/**
 * Text along the fuselage on one side, `y` its centre height (m), `h` its cap height. The left
 * side's rows run up the body as the canvas runs down, and the right side's run nose-to-tail as
 * the view runs tail-to-nose, so each side flips the text to read correctly from outside.
 */
function skinText(g: C2D, side: 'L' | 'R', text: string, zc: number, y: number, h: number, font: string, colour: string, maxW?: number) {
  const [px, py] = fusPx(zc, sAtHeight(CONST_Z, side, y));
  const ph = (sAtHeight(CONST_Z, side, y + h / 2) - sAtHeight(CONST_Z, side, y - h / 2)) * REGION.fus.h;
  g.save();
  g.translate(px, py);
  g.scale(side === 'R' ? -1 : 1, side === 'L' ? -1 : 1);
  g.font = font.replace('{px}', `${Math.abs(ph) * 1.25}px`);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = colour;
  const pxPerM = REGION.fus.w / LENGTH;
  if (maxW) {
    const w = g.measureText(text).width;
    if (w > maxW * pxPerM) g.scale((maxW * pxPerM) / w, 1);
  }
  g.fillText(text, 0, 0);
  g.restore();
}

// ------------------------------------------------------------------------------------------------
// Cockpit windows
// ------------------------------------------------------------------------------------------------

/**
 * The flight deck's six panes, judged per pixel on the nose skin: a window band in side view (sill
 * and top lines by distance aft of the nose tip), split by posts at azimuths round the nose (the
 * centre post, the windshield/side-window posts) and by station (the sliding window and the small
 * aft one, with its cut top corner). Returns 0 outside, 1 glass, 2 frame.
 */
function cockpitPane(d: number, x: number, y: number, yc: number) {
  const ax = Math.abs(x);
  const az = (Math.atan2(ax, y - yc) * 180) / Math.PI;
  const sill = 4.6 + 0.045 * (d - 1.6);
  const top = d < 2.55 ? 5.06 + (d - 1.6) * 0.33 : 5.37 - (d - 2.55) * 0.21;
  if (d < 1.42 || d > 3.6 || y < sill - 0.03 || y > top + 0.03) return 0;
  const f = 0.035; // frame width (m)
  let edge = Math.min(y - sill, top - y);
  if (az < 44) {
    // windshield: from the centre post to the corner post
    const post = 0.07;
    edge = Math.min(edge, ax - post, ((44 - az) * Math.PI) / 180 * 1.0);
    if (d > 2.45) return 0;
  } else {
    if (az < 47) return 2;
    edge = Math.min(edge, ((az - 47) * Math.PI) / 180 * 1.0);
    if (d < 2.12) {
      // the sliding window's front edge follows the corner post's slant
      edge = Math.min(edge, d - 1.98 + (y - sill) * 0.18);
    }
    if (d < 2.95) edge = Math.min(edge, 2.95 - d);
    else if (d < 3.04) return 2;
    else {
      // the aft window: its top slopes down to a cut corner
      const cut = top - (d - 3.04) * 0.55;
      edge = Math.min(edge, d - 3.04, cut - y, 3.55 - d);
    }
  }
  if (edge < -f) return 0;
  return edge < 0 ? 2 : 1;
}

function paintCockpit(c: HTMLCanvasElement, k: number, glass: [number, number, number], frame: [number, number, number]) {
  const g = c.getContext('2d')!;
  const [x0] = fusPx(NOSE_Z + 1.35, 0);
  const [x1] = fusPx(NOSE_Z + 3.65, 0);
  const y0 = REGION.fus.y + 0.18 * REGION.fus.h;
  const y1 = REGION.fus.y + 0.82 * REGION.fus.h;
  const X0 = Math.floor(x0 * k);
  const Y0 = Math.floor(y0 * k);
  const W = Math.ceil((x1 - x0) * k);
  const H = Math.ceil((y1 - y0) * k);
  const img = g.getImageData(X0, Y0, W, H);
  const p = { x: 0, y: 0 };
  for (let i = 0; i < W; i++) {
    const z = NOSE_Z + ((X0 + i + 0.5) / k / REGION.fus.w) * LENGTH;
    const t = sectionTable(z);
    const yc = FUS.wide(z);
    for (let j = 0; j < H; j++) {
      const s = ((Y0 + j + 0.5) / k - REGION.fus.y) / REGION.fus.h;
      skinPoint(z, phiAt(t, s), p);
      const v = cockpitPane(z - NOSE_Z, p.x, p.y, yc);
      if (!v) continue;
      const o = (j * W + i) * 4;
      // the glass darkens towards its top (the sky's reflection does the rest)
      const col = v === 1 ? glass : frame;
      const shade = v === 1 ? 1 - 0.25 * Math.min(1, Math.max(0, (p.y - 4.6) / 0.7)) : 1;
      img.data[o] = col[0] * shade;
      img.data[o + 1] = col[1] * shade;
      img.data[o + 2] = col[2] * shade;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, X0, Y0);
}

// ------------------------------------------------------------------------------------------------
// Tail art (drawn in fin coordinates: body z, height y, in metres)
// ------------------------------------------------------------------------------------------------

type FinXY = (z: number, y: number) => [number, number];
const FIN_PX_PER_M = REGION.finL.w / (FIN_MAP.z1 - FIN_MAP.z0);

function finOutline(g: C2D, P: FinXY) {
  const st = [5.5, 6.45, 11.76];
  g.beginPath();
  g.moveTo(...P(finAt(st[0]).le, st[0]));
  for (const y of st) g.lineTo(...P(finAt(y).le, y));
  g.lineTo(...P(finAt(st[2]).te, st[2]));
  g.lineTo(...P(finAt(st[0]).te + 0.05, st[0]));
  g.closePath();
}

function tailArt(g: C2D, l: Livery, P: FinXY) {
  const m = FIN_PX_PER_M;
  const circle = (z: number, y: number, r: number) => {
    g.beginPath();
    g.arc(...P(z, y), r * m, 0, Math.PI * 2);
  };
  switch (l.tailArt) {
    case 'funfair': {
      // the fair's giant wheel, its hub low on the rudder, cut by the fin's edges
      const [cz, cy, R] = [15.6, 8.4, 2.75];
      g.lineWidth = 0.16 * m;
      g.strokeStyle = l.cheatline;
      circle(cz, cy, R);
      g.stroke();
      g.lineWidth = 0.06 * m;
      g.strokeStyle = '#fff5e3';
      circle(cz, cy, R * 0.72);
      g.stroke();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.beginPath();
        g.moveTo(...P(cz, cy));
        g.lineTo(...P(cz + R * Math.cos(a), cy + R * Math.sin(a)));
        g.stroke();
      }
      const cars = ['#fff5e3', l.cheatline, '#2ec4b6', '#fff5e3', '#7b5cd6', l.cheatline];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.26;
        g.fillStyle = cars[i % cars.length];
        circle(cz + R * Math.cos(a), cy + R * Math.sin(a) - 0.28, 0.24);
        g.fill();
      }
      g.fillStyle = l.cheatline;
      circle(cz, cy, 0.34);
      g.fill();
      break;
    }
    case 'palm': {
      g.fillStyle = '#ffc23d';
      circle(14.6, 9.6, 1.25);
      g.fill();
      g.strokeStyle = '#fff5e3';
      g.lineCap = 'round';
      g.lineWidth = 0.32 * m;
      g.beginPath();
      g.moveTo(...P(17.2, 5.6));
      g.quadraticCurveTo(...P(16.9, 8.4), ...P(15.6, 10.1));
      g.stroke();
      g.fillStyle = '#fff5e3';
      for (let i = 0; i < 7; i++) {
        const a = -0.4 + (i / 6) * Math.PI * 1.25;
        const [tz, ty] = [15.6 + 2.0 * Math.cos(a), 10.1 + 1.25 * Math.sin(a) - 0.5 * Math.cos(a) ** 2];
        g.beginPath();
        g.moveTo(...P(15.6, 10.15));
        g.quadraticCurveTo(...P((15.6 + tz) / 2 + 0.3 * Math.sin(a), (10.1 + ty) / 2 + 0.45), ...P(tz, ty));
        g.quadraticCurveTo(...P((15.6 + tz) / 2, (10.1 + ty) / 2 + 0.05), ...P(15.6, 10.0));
        g.fill();
      }
      break;
    }
    case 'wave': {
      const cols = [l.cheatline, '#ffffff', l.cheatline];
      cols.forEach((c, i) => {
        g.fillStyle = c;
        const base = 6.0 + i * 1.35;
        g.beginPath();
        g.moveTo(...P(9, base));
        for (let z = 9; z <= 18.2; z += 0.2) g.lineTo(...P(z, base + 0.55 * Math.sin((z - 9) * 1.1 + i) + (z - 9) * 0.22));
        g.lineTo(...P(18.2, base + 0.5));
        g.lineTo(...P(18.2, base - 0.4));
        for (let z = 18.2; z >= 9; z -= 0.2) g.lineTo(...P(z, base - 0.45 + 0.4 * Math.sin((z - 9) * 1.1 + i + 0.6) + (z - 9) * 0.22));
        g.closePath();
        g.fill();
      });
      break;
    }
    case 'star': {
      // a low sun on the rudder's foot throwing rays up the fin
      const [sz, sy] = [17.8, 5.7];
      g.fillStyle = l.cheatline;
      for (let i = 0; i < 9; i++) {
        const a0 = Math.PI * 0.5 + (i / 9) * Math.PI * 0.62;
        const a1 = a0 + 0.075;
        g.beginPath();
        g.moveTo(...P(sz, sy));
        g.lineTo(...P(sz + 9 * Math.cos(a0), sy + 9 * Math.sin(a0)));
        g.lineTo(...P(sz + 9 * Math.cos(a1), sy + 9 * Math.sin(a1)));
        g.closePath();
        g.fill();
      }
      g.fillStyle = '#ffd36b';
      circle(sz, sy, 1.6);
      g.fill();
      break;
    }
    case 'plain':
      break;
  }
}

/** A plain tail carries the airline's code up the fin instead of art (each side reads correctly from outside). */
function finCode(g: C2D, l: Livery, P: FinXY) {
  const [x, y] = P(15.2, 8.6);
  g.save();
  g.translate(x, y);
  g.fillStyle = luminance(l.tail) > 0.6 ? '#1d1238' : '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${2.7 * FIN_PX_PER_M}px ${DISPLAY_FONT}`;
  g.rotate(-0.1);
  g.fillText(l.code, 0, 0);
  g.restore();
}

// ------------------------------------------------------------------------------------------------
// The livery atlas
// ------------------------------------------------------------------------------------------------

const SWATCH_COLOURS: Record<Swatch, string> = {
  white: '#f2f3f4',
  wingGrey: '#b8bec5',
  metal: '#8f969d',
  chrome: '#d9dde1',
  tyre: '#1b1c1e',
  hub: '#a3a8ad',
  dark: '#2b2e33',
  well: '#7a8189',
  inlet: '#40454b',
  fanBlade: '#3c4148',
  core: '#a2a7ad',
  exhaust: '#5c5249',
  interior: '#cfc8bb',
  hold: '#8a8f86',
  glass: '#18222d',
  lens: '#eef5ff',
  red: '#d0102a',
  green: '#10c040',
  antenna: '#e9e9e9',
  tail: '#000',
  engine: '#000',
  belly: '#000',
  fuselage: '#000',
  cheat: '#000',
  primer: '#9db18f',
  black: '#0b0b0d',
  cascade: '#2c2c2c',
  spinner: '#30343a',
};

function swatches(g: C2D, colour: (s: Swatch) => string) {
  for (const s of SWATCHES) {
    const r = swatchRect(s);
    g.fillStyle = colour(s);
    g.fillRect(r.x, r.y, r.w, r.h);
  }
}

const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Whether `fg` reads on `bg` (else use a dark ink). */
function luminance(hex: string) {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function paintLivery(l: Livery, k: number, freighter: boolean) {
  const { c, g } = canvas(k);
  const F = REGION.fus;
  // ---- fuselage
  g.fillStyle = l.fuselage;
  g.fillRect(F.x, F.y, F.w, F.h);
  // a faint sheen gradient round the section (paint never looks perfectly flat)
  const sheen = g.createLinearGradient(0, F.y, 0, F.y + F.h);
  sheen.addColorStop(0, 'rgba(0,0,0,0.05)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.03)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.05)');
  g.fillStyle = sheen;
  g.fillRect(F.x, F.y, F.w, F.h);
  const zs = NOSE_Z + 0.4;
  for (const side of ['L', 'R'] as const) {
    g.fillStyle = l.belly;
    band(g, side, zs, TAIL_Z, () => 0, beltY);
    // the cheatline starts as a point under the cockpit and widens aft
    g.fillStyle = l.cheatline;
    const c0 = NOSE_Z + 2.4;
    const cw = (z: number) => CHEAT.w * smoothstep(c0, c0 + 5, z) ** 0.7;
    band(g, side, c0, TAIL_Z, (z) => beltY(z) + CHEAT.off, (z) => beltY(z) + CHEAT.off + cw(z));
  }
  // the radome: a slightly different paint, as on the real aircraft
  g.fillStyle = 'rgba(0,0,0,0.035)';
  const [rx] = fusPx(NOSE_Z + 1.25, 0);
  g.fillRect(F.x, F.y, rx - F.x, F.h);

  // panel joints: circumferential frames at the fuselage section breaks, lap joints along it
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.lineWidth = 0.8;
  for (const z of [-14.4, -9.6, -5.1, -1.8, 3.4, 8.9, 12.1, 16.2]) {
    const [x] = fusPx(z, 0);
    g.beginPath();
    g.moveTo(x, F.y);
    g.lineTo(x, F.y + F.h);
    g.stroke();
  }
  for (const y of [3.05, 5.52]) {
    for (const side of ['L', 'R'] as const) {
      g.beginPath();
      for (let z = -14; z < 13; z += 0.5) {
        const p = fusPx(z, sAtHeight(z, side, y));
        if (z === -14) g.moveTo(...p);
        else g.lineTo(...p);
      }
      g.stroke();
    }
  }

  // ---- titles and registration
  const titleColour = luminance(l.fuselage) > 0.6 ? (luminance(l.tail) < 0.75 ? l.tail : '#1d1238') : '#ffffff';
  for (const side of ['L', 'R'] as const) {
    skinText(g, side, l.name, -4.6, 5.12, 0.62, `{px} ${DISPLAY_FONT}`, titleColour, 10.5);
    const regZ = 15.0;
    const regY = 4.25;
    const regBg = regY < beltY(regZ) ? l.belly : l.fuselage;
    skinText(g, side, l.registration, regZ, regY, 0.3, `700 {px} ${BODY_FONT}`, luminance(regBg) > 0.55 ? '#1d1238' : '#ffffff', 3);
  }

  // ---- doors, exits, windows
  const outline = (side: 'L' | 'R', zc: number, w: number, y0: number, y1: number, r: number) => {
    skinRect(g, side, zc, w, y0, y1, r);
    g.strokeStyle = 'rgba(20,24,30,0.45)';
    g.lineWidth = 1.1;
    g.stroke();
  };
  for (const d of Object.values(DOORS)) {
    outline(d.side, d.z, DOOR.w + 0.04, DOOR.sill - 0.02, DOOR.sill + DOOR.h + 0.02, 0.14);
    // the door's own small window and its handle
    skinRect(g, d.side, d.z, 0.2, 4.36, 4.64, 0.08);
    g.fillStyle = SWATCH_COLOURS.glass;
    g.fill();
    skinRect(g, d.side, d.z + (d.z < 0 ? 0.22 : -0.22), 0.16, 3.98, 4.04, 0.02);
    g.fillStyle = 'rgba(30,30,30,0.5)';
    g.fill();
  }
  for (const e of OVERWING)
    for (const side of ['L', 'R'] as const) {
      outline(side, e.z, EXIT.w + 0.02, EXIT.sill, EXIT.sill + EXIT.h, 0.1);
      // the exits' red handle marks
      skinRect(g, side, e.z, 0.12, EXIT.sill + EXIT.h - 0.16, EXIT.sill + EXIT.h - 0.08, 0.02);
      g.fillStyle = '#c8102e';
      g.fill();
    }
  for (const d of [CARGO.fwd, CARGO.aft]) outline('R', (d.z0 + d.z1) / 2, d.z1 - d.z0 + 0.02, CARGO.y0 - 0.01, CARGO.y1 + 0.01, 0.08);
  if (freighter) outline('L', -10.5, 3.6, 3.55, 5.55, 0.18);
  for (const z of windowStations())
    for (const side of ['L', 'R'] as const) {
      skinRect(g, side, z, WINDOW.w, WINDOW.y - WINDOW.h / 2, WINDOW.y + WINDOW.h / 2, 0.09);
      if (freighter) {
        g.strokeStyle = 'rgba(0,0,0,0.12)';
        g.lineWidth = 0.7;
        g.stroke();
        continue;
      }
      g.fillStyle = '#5c6670';
      g.fill();
      skinRect(g, side, z, WINDOW.w - 0.04, WINDOW.y - WINDOW.h / 2 + 0.02, WINDOW.y + WINDOW.h / 2 - 0.02, 0.075);
      g.fillStyle = SWATCH_COLOURS.glass;
      g.fill();
    }

  // the main gear's wheel wells, open in the fairing's belly while the gear is down
  for (const s of [-1, 1]) {
    const cxw = s * (MAIN_GEAR.x - (MAIN_GEAR.trunnionY - MAIN_GEAR.wheelR));
    const R = MAIN_GEAR.wheelR + 0.04;
    g.fillStyle = '#2a2d31';
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const z = MAIN_GEAR.z + R * Math.sin(a);
      const x = cxw + R * Math.cos(a);
      const p = fusPx(z, sOnRay(z, x, 1.7));
      if (i === 0) g.moveTo(...p);
      else g.lineTo(...p);
    }
    g.closePath();
    g.fill();
  }

  // ---- fin (both sides)
  for (const side of ['L', 'R'] as const) {
    const r = side === 'L' ? REGION.finL : REGION.finR;
    const P: FinXY = (z, y) => finPx(z, y, side);
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.fillStyle = l.tail;
    g.fillRect(r.x, r.y, r.w, r.h);
    finOutline(g, P);
    g.save();
    g.clip();
    tailArt(g, l, P);
    g.restore();
    if (l.tailArt === 'plain') finCode(g, l, P);
    // the rudder's hinge line
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(...P(finAt(6.12).le + 0.68 * (finAt(6.12).te - finAt(6.12).le), 6.12));
    g.lineTo(...P(finAt(11.45).le + 0.68 * (finAt(11.45).te - finAt(11.45).le), 11.45));
    g.stroke();
    g.restore();
  }

  // ---- nacelles: the cowl in the engine colour, a cheatline ring behind the polished lip
  const N = REGION.nac;
  g.fillStyle = l.engines;
  g.fillRect(N.x, N.y, N.w, N.h);
  const [, ringA] = nacPx(0, NACELLE.cowl[0][0]);
  const [, ringB] = nacPx(0, -9.92);
  g.fillStyle = l.cheatline;
  g.fillRect(N.x, ringA, N.w, ringB - ringA);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  const [, seam] = nacPx(0, -7.62);
  g.fillRect(N.x, seam - 0.6, N.w, 1.2);
  const [, lipA] = nacPx(0, -5.95);
  g.fillStyle = '#9aa0a6';
  g.fillRect(N.x, lipA, N.w, N.y + N.h - lipA);
  // the fan cowl's latches along the bottom
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (const z of [-9.4, -8.8, -8.2]) {
    const [x, y] = nacPx(0.5, z);
    g.fillRect(x - 3, y - 0.6, 6, 1.2);
  }

  // ---- wing: grey panels, the bare-metal leading edges (slats), walkways, panel lines
  const Wr = REGION.wing;
  g.fillStyle = SWATCH_COLOURS.wingGrey;
  g.fillRect(Wr.x, Wr.y, Wr.w, Wr.h);
  g.fillStyle = '#cfd3d7';
  g.beginPath();
  g.moveTo(...wingPx(WING.root, wingLeZ(WING.root) - 0.2));
  g.lineTo(...wingPx(18, wingLeZ(18) - 0.2));
  g.lineTo(...wingPx(18, wingLeZ(18) + 0.28));
  g.lineTo(...wingPx(WING.root, wingLeZ(WING.root) + 0.42));
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 0.8;
  for (const c of [0.15, 0.6]) {
    g.beginPath();
    g.moveTo(...wingPx(WING.root, wingLeZ(WING.root) + c * (wingTeZ(WING.root) - wingLeZ(WING.root))));
    g.lineTo(...wingPx(17, wingLeZ(17) + c * (wingTeZ(17) - wingLeZ(17))));
    g.stroke();
  }
  for (const p of SLATS) {
    for (const x of [p.x0, p.x1]) {
      g.beginPath();
      g.moveTo(...wingPx(x, wingLeZ(x) - 0.2));
      g.lineTo(...wingPx(x, wingTeZ(x) + 0.2));
      g.stroke();
    }
  }
  // the walkway outline over the inner wing (black lines, "NO STEP" beyond)
  g.strokeStyle = 'rgba(20,20,20,0.55)';
  g.lineWidth = 1;
  g.strokeRect(...(() => {
    const [ax, ay] = wingPx(2.1, -1.6);
    const [bx, by] = wingPx(5.2, 0.4);
    return [ax, ay, bx - ax, by - ay] as [number, number, number, number];
  })());
  g.fillStyle = 'rgba(20,20,20,0.5)';
  g.font = `700 6px ${BODY_FONT}`;
  g.fillText('NO STEP', ...wingPx(5.6, -0.9));

  // ---- fan face (the lower detail levels' spinning disc)
  const fr = REGION.fan;
  const fcx = fr.x + fr.w / 2;
  const fcy = fr.y + fr.h / 2;
  const R = (fr.w / 2) * 0.98;
  g.fillStyle = '#16181b';
  g.beginPath();
  g.arc(fcx, fcy, R, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#4b5158';
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    g.beginPath();
    g.moveTo(fcx + Math.cos(a) * R * 0.36, fcy + Math.sin(a) * R * 0.36);
    g.quadraticCurveTo(fcx + Math.cos(a + 0.22) * R * 0.7, fcy + Math.sin(a + 0.22) * R * 0.7, fcx + Math.cos(a + 0.12) * R, fcy + Math.sin(a + 0.12) * R);
    g.lineTo(fcx + Math.cos(a + 0.38) * R, fcy + Math.sin(a + 0.38) * R);
    g.quadraticCurveTo(fcx + Math.cos(a + 0.4) * R * 0.66, fcy + Math.sin(a + 0.4) * R * 0.66, fcx + Math.cos(a + 0.3) * R * 0.36, fcy + Math.sin(a + 0.3) * R * 0.36);
    g.closePath();
    g.fill();
  }
  g.fillStyle = SWATCH_COLOURS.spinner;
  g.beginPath();
  g.arc(fcx, fcy, R * 0.36, 0, Math.PI * 2);
  g.fill();

  // ---- solid swatches
  const livery: Partial<Record<Swatch, string>> = { tail: l.tail, engine: l.engines, belly: l.belly, fuselage: l.fuselage, cheat: l.cheatline };
  swatches(g, (s) => livery[s] ?? SWATCH_COLOURS[s]);

  paintCockpit(c, k, rgb('#18222d'), rgb('#3a3f46'));
  return c;
}

// ------------------------------------------------------------------------------------------------
// Surface properties and night glow (livery-independent)
// ------------------------------------------------------------------------------------------------

/** Roughness / metalness per swatch. */
const SURFACE: Partial<Record<Swatch, [number, number]>> = {
  white: [0.42, 0],
  wingGrey: [0.55, 0.05],
  metal: [0.38, 0.85],
  chrome: [0.12, 1],
  tyre: [0.88, 0],
  hub: [0.4, 0.7],
  dark: [0.6, 0.1],
  well: [0.7, 0.2],
  inlet: [0.6, 0.2],
  fanBlade: [0.32, 0.55],
  core: [0.42, 0.75],
  exhaust: [0.7, 0.4],
  glass: [0.06, 0.4],
  lens: [0.05, 0.2],
  red: [0.2, 0],
  green: [0.2, 0],
  spinner: [0.3, 0.6],
  cascade: [0.7, 0.3],
  black: [0.8, 0],
};
const PAINT: [number, number] = [0.36, 0];

const surf = ([r, m]: [number, number]) => `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`;

export function paintSurface(freighter: boolean) {
  const { c, g } = canvas(1);
  g.fillStyle = surf(PAINT);
  g.fillRect(0, 0, ATLAS.w, ATLAS.h);
  const W = REGION.wing;
  g.fillStyle = surf([0.55, 0.06]);
  g.fillRect(W.x, W.y, W.w, W.h);
  g.fillStyle = surf([0.28, 0.75]);
  g.beginPath();
  g.moveTo(...wingPx(WING.root, wingLeZ(WING.root) - 0.2));
  g.lineTo(...wingPx(18, wingLeZ(18) - 0.2));
  g.lineTo(...wingPx(18, wingLeZ(18) + 0.28));
  g.lineTo(...wingPx(WING.root, wingLeZ(WING.root) + 0.42));
  g.closePath();
  g.fill();
  const N = REGION.nac;
  const [, lipA] = nacPx(0, -5.95);
  g.fillStyle = surf([0.35, 0.8]);
  g.fillRect(N.x, lipA, N.w, N.y + N.h - lipA);
  const fr = REGION.fan;
  g.fillStyle = surf([0.35, 0.55]);
  g.fillRect(fr.x, fr.y, fr.w, fr.h);
  swatches(g, (s) => surf(SURFACE[s] ?? PAINT));
  if (!freighter) {
    g.fillStyle = surf(SURFACE.glass!);
    for (const z of windowStations()) for (const side of ['L', 'R'] as const) {
      skinRect(g, side, z, WINDOW.w - 0.04, WINDOW.y - WINDOW.h / 2 + 0.02, WINDOW.y + WINDOW.h / 2 - 0.02, 0.075);
      g.fill();
    }
  }
  const [gr, gm] = SURFACE.glass!;
  paintCockpit(c, 1, [0, Math.round(gr * 255), Math.round(gm * 255)], [0, Math.round(0.4 * 255), 0]);
  return c;
}

export function paintGlow(freighter: boolean) {
  const { c, g } = canvas(1);
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS.w, ATLAS.h);
  if (!freighter) {
    g.fillStyle = 'rgb(255,0,0)';
    for (const z of windowStations()) for (const side of ['L', 'R'] as const) {
      skinRect(g, side, z, WINDOW.w - 0.04, WINDOW.y - WINDOW.h / 2 + 0.02, WINDOW.y + WINDOW.h / 2 - 0.02, 0.075);
      g.fill();
    }
    for (const d of Object.values(DOORS)) {
      skinRect(g, d.side, d.z, 0.2, 4.36, 4.64, 0.08);
      g.fill();
    }
  }
  // the logo lights sit in the stabiliser's upper skin, washing the fin brightest at its foot
  g.globalCompositeOperation = 'lighter';
  for (const side of ['L', 'R'] as const) {
    const r: Rect = side === 'L' ? REGION.finL : REGION.finR;
    const [, yb] = finPx(15, 5.6, side);
    const [, yt] = finPx(15, 11.0, side);
    const grad = g.createLinearGradient(0, yb, 0, yt);
    grad.addColorStop(0, 'rgb(0,255,0)');
    grad.addColorStop(0.55, 'rgb(0,120,0)');
    grad.addColorStop(1, 'rgb(0,25,0)');
    g.fillStyle = grad;
    g.fillRect(r.x, r.y, r.w, r.h);
  }
  const lens = swatchRect('lens');
  g.fillStyle = 'rgb(0,0,255)';
  g.fillRect(lens.x, lens.y, lens.w, lens.h);
  g.globalCompositeOperation = 'source-over';
  return c;
}
