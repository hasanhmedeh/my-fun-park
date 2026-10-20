// Flight information displays (FIDS): the big departure and arrival boards in the halls and the
// screen over every gate desk. Every screen of a terminal is a region of one canvas texture, so
// they all draw with one material; a board is only repainted when its flights change.
//
// The look follows the real thing: white on deep navy, alternating row tints, a coloured status
// column (green boarding, amber delayed, red closed), the airport's name and a small clock-style
// header. Airlines and places are fictional.

import * as THREE from 'three';
import { AIRFIELDS } from '../../aviation/airports';
import { SCHEDULE_PAD_S } from '../../aviation/scoring';
import { TIME_OF_DAY_HOUR, type TimeOfDay } from '../../aviation/types';
import { bookFlight, clockText } from '../flight/booking';
import type { Region } from '../geo';
import { BODY_FONT, canvasTex } from '../textures';
import type { UvRect } from './terminal-kit';

/** One line of a departures (or arrivals) board. For arrivals `to` is where the flight comes from, `gate` the reclaim belt. */
export interface FlightRow {
  /** Scheduled time, "16:40". */
  time: string;
  /** Flight number, "FA101". */
  flight: string;
  /** Destination (or origin, on an arrivals board). */
  to: string;
  /** Gate number as text ("3"), or the belt on arrivals. */
  gate: string;
  /** "On time", "Boarding", "Final call", "Gate closed", "Departed", "Delayed 15'", "Landed", "Cancelled"… */
  status: string;
}

/** Board colours (shared with the island's boards so both airports read alike). */
export const FIDS = {
  bg: '#0b1530',
  row: '#13214a',
  rowAlt: '#0f1b3d',
  head: '#1d2f66',
  text: '#f2f5ff',
  dim: '#93a3cf',
  yellow: '#ffd23f',
  green: '#4ee08a',
  amber: '#ffb03b',
  red: '#ff5a5a',
};

/** The colour a status reads in. */
export function statusColour(status: string) {
  const s = status.toLowerCase();
  if (/board|final|go to gate|landed|arrived|baggage/.test(s)) return FIDS.green;
  if (/delay|expected|diverted/.test(s)) return FIDS.amber;
  if (/closed|cancel/.test(s)) return FIDS.red;
  if (/departed|airborne/.test(s)) return FIDS.dim;
  return FIDS.text;
}

/** A plane symbol for board headers (nose up-right for departures, down-right for arrivals). */
export function drawPlaneIcon(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, angle: number, colour: string) {
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  g.scale(s, s);
  g.fillStyle = colour;
  g.beginPath();
  g.moveTo(0, -0.5);
  g.quadraticCurveTo(0.07, -0.44, 0.07, -0.3);
  g.lineTo(0.07, -0.1);
  g.lineTo(0.48, 0.12);
  g.lineTo(0.48, 0.2);
  g.lineTo(0.07, 0.08);
  g.lineTo(0.06, 0.32);
  g.lineTo(0.2, 0.42);
  g.lineTo(0.2, 0.48);
  g.lineTo(0, 0.43);
  g.lineTo(-0.2, 0.48);
  g.lineTo(-0.2, 0.42);
  g.lineTo(-0.06, 0.32);
  g.lineTo(-0.07, 0.08);
  g.lineTo(-0.48, 0.2);
  g.lineTo(-0.48, 0.12);
  g.lineTo(-0.07, -0.1);
  g.lineTo(-0.07, -0.3);
  g.quadraticCurveTo(-0.07, -0.44, 0, -0.5);
  g.fill();
  g.restore();
}

/** Text squeezed to fit `maxW` (a FIDS narrows long names rather than cutting them). */
function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number) {
  const w = g.measureText(text).width;
  if (w <= maxW) {
    g.fillText(text, x, y);
    return;
  }
  g.save();
  g.translate(x, y);
  g.scale(maxW / w, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

/**
 * Paints a departures or arrivals board into (x, y, w, h) of a canvas: a header with the
 * direction, the airport's name, then up to `rows` lines.
 */
export function paintBoard(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: 'departures' | 'arrivals',
  airport: string,
  flights: FlightRow[],
  rows = 10,
) {
  g.save();
  g.translate(x, y);
  g.fillStyle = FIDS.bg;
  g.fillRect(0, 0, w, h);
  const headH = Math.round(h * 0.15);
  const colH = Math.round(h * 0.065);
  const rowH = (h - headH - colH) / rows;
  // header
  g.fillStyle = FIDS.head;
  g.fillRect(0, 0, w, headH);
  drawPlaneIcon(g, headH * 0.55, headH / 2, headH * 0.72, kind === 'departures' ? Math.PI / 4 : (3 * Math.PI) / 4, FIDS.yellow);
  g.fillStyle = FIDS.yellow;
  g.textBaseline = 'middle';
  g.font = `700 ${Math.round(headH * 0.5)}px ${BODY_FONT}`;
  g.fillText(kind === 'departures' ? 'Departures' : 'Arrivals', headH * 1.1, headH * 0.42);
  g.fillStyle = FIDS.dim;
  g.font = `500 ${Math.round(headH * 0.22)}px ${BODY_FONT}`;
  g.fillText(kind === 'departures' ? 'Départs · Abflug · Salidas' : 'Arrivées · Ankunft · Llegadas', headH * 1.12, headH * 0.8);
  g.textAlign = 'right';
  g.fillStyle = FIDS.text;
  g.font = `700 ${Math.round(headH * 0.3)}px ${BODY_FONT}`;
  g.fillText(airport, w - headH * 0.35, headH / 2);
  g.textAlign = 'left';
  // column titles
  const cols = { time: 0.025, flight: 0.13, to: 0.3, gate: 0.66, status: 0.76 };
  g.fillStyle = FIDS.rowAlt;
  g.fillRect(0, headH, w, colH);
  g.fillStyle = FIDS.dim;
  g.font = `700 ${Math.round(colH * 0.5)}px ${BODY_FONT}`;
  const titles =
    kind === 'departures'
      ? { time: 'Time', flight: 'Flight', to: 'Destination', gate: 'Gate', status: 'Remarks' }
      : { time: 'Time', flight: 'Flight', to: 'From', gate: 'Belt', status: 'Remarks' };
  for (const k of Object.keys(cols) as (keyof typeof cols)[]) g.fillText(titles[k].toUpperCase(), w * cols[k], headH + colH / 2);
  // flights
  const fs = Math.round(rowH * 0.5);
  for (let i = 0; i < rows; i++) {
    const ry = headH + colH + i * rowH;
    g.fillStyle = i % 2 ? FIDS.rowAlt : FIDS.row;
    g.fillRect(0, ry, w, rowH);
    const f = flights[i];
    if (!f) continue;
    const cy = ry + rowH / 2;
    g.font = `700 ${fs}px ${BODY_FONT}`;
    g.fillStyle = FIDS.yellow;
    g.fillText(f.time, w * cols.time, cy);
    g.fillStyle = FIDS.text;
    g.fillText(f.flight, w * cols.flight, cy);
    fitText(g, f.to, w * cols.to, cy, w * (cols.gate - cols.to - 0.02));
    g.font = `700 ${Math.round(fs * 1.05)}px ${BODY_FONT}`;
    g.fillText(f.gate, w * cols.gate + w * 0.012, cy);
    g.font = `700 ${fs}px ${BODY_FONT}`;
    g.fillStyle = statusColour(f.status);
    fitText(g, f.status, w * cols.status, cy, w * (1 - cols.status - 0.02));
  }
  g.restore();
}

/**
 * Paints a gate screen: the gate number, the flight at it (or "next" when none is boarding), its
 * destination, time and status, and the airline's name.
 */
export function paintGateScreen(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, gate: number, f: FlightRow | null, airline: string) {
  g.save();
  g.translate(x, y);
  g.fillStyle = FIDS.bg;
  g.fillRect(0, 0, w, h);
  // the gate number in a yellow block on the left, like the signs
  const bw = h * 0.62;
  g.fillStyle = FIDS.yellow;
  g.fillRect(0, 0, bw, h);
  g.fillStyle = FIDS.bg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${Math.round(h * 0.13)}px ${BODY_FONT}`;
  g.fillText('GATE', bw / 2, h * 0.17);
  g.font = `700 ${Math.round(h * 0.56)}px ${BODY_FONT}`;
  g.fillText(String(gate), bw / 2, h * 0.58);
  g.textAlign = 'left';
  const lx = bw + h * 0.1;
  const tw = w - lx - h * 0.08;
  if (!f) {
    g.fillStyle = FIDS.dim;
    g.font = `700 ${Math.round(h * 0.16)}px ${BODY_FONT}`;
    g.fillText('No departures', lx, h * 0.42);
    g.font = `500 ${Math.round(h * 0.11)}px ${BODY_FONT}`;
    g.fillText('Please check the departures board', lx, h * 0.62);
    g.restore();
    return;
  }
  g.fillStyle = FIDS.text;
  g.font = `700 ${Math.round(h * 0.15)}px ${BODY_FONT}`;
  g.fillText(`${f.flight}  ·  ${f.time}`, lx, h * 0.18);
  g.fillStyle = FIDS.yellow;
  g.font = `700 ${Math.round(h * 0.25)}px ${BODY_FONT}`;
  fitText(g, f.to, lx, h * 0.45, tw);
  g.fillStyle = statusColour(f.status);
  g.font = `700 ${Math.round(h * 0.15)}px ${BODY_FONT}`;
  fitText(g, f.status, lx, h * 0.7, tw);
  g.fillStyle = FIDS.dim;
  g.font = `500 ${Math.round(h * 0.1)}px ${BODY_FONT}`;
  g.fillText(airline, lx, h * 0.88);
  g.restore();
}

/** Believable boards for before the game sets the real ones: the player's flight among invented traffic. */
export const DEFAULT_DEPARTURES: FlightRow[] = [
  { time: '15:50', flight: 'SU412', to: 'Sunset Bay', gate: '6', status: 'Departed' },
  { time: '16:05', flight: 'CN231', to: 'Candy Island', gate: '1', status: 'Gate closed' },
  { time: '16:20', flight: 'LG077', to: 'Lagoon City', gate: '5', status: 'Final call' },
  { time: '16:40', flight: 'FA101', to: 'Palm Cay', gate: '3', status: 'Boarding' },
  { time: '16:55', flight: 'FA117', to: 'Toffee Point', gate: '2', status: 'Go to gate' },
  { time: '17:10', flight: 'PC012', to: 'Palm Cay', gate: '4', status: 'On time' },
  { time: '17:25', flight: 'SU418', to: 'Marzipan Coast', gate: '6', status: 'Delayed 20′' },
  { time: '17:40', flight: 'CN236', to: 'Candy Island', gate: '1', status: 'On time' },
  { time: '18:05', flight: 'FA125', to: 'Starlight Harbour', gate: '5', status: 'On time' },
  { time: '18:30', flight: 'LG081', to: 'Coconut Reef', gate: '2', status: 'On time' },
];
export const DEFAULT_ARRIVALS: FlightRow[] = [
  { time: '15:35', flight: 'FA102', to: 'Palm Cay', gate: '2', status: 'Baggage in hall' },
  { time: '15:55', flight: 'CN230', to: 'Candy Island', gate: '1', status: 'Landed' },
  { time: '16:10', flight: 'SU411', to: 'Sunset Bay', gate: '3', status: 'Landed' },
  { time: '16:30', flight: 'PC011', to: 'Palm Cay', gate: '1', status: 'Expected 16:42' },
  { time: '16:50', flight: 'LG076', to: 'Lagoon City', gate: '2', status: 'On time' },
  { time: '17:05', flight: 'FA116', to: 'Toffee Point', gate: '3', status: 'On time' },
  { time: '17:35', flight: 'FA104', to: 'Palm Cay', gate: '1', status: 'On time' },
  { time: '17:50', flight: 'SU417', to: 'Marzipan Coast', gate: '2', status: 'On time' },
  { time: '18:20', flight: 'FA124', to: 'Starlight Harbour', gate: '3', status: 'On time' },
  { time: '18:45', flight: 'CN235', to: 'Candy Island', gate: '1', status: 'On time' },
];

// ------------------------------------------------------------------------------------------------
// The day's schedule: Funfair Air's own legs from the booking, the invented traffic round them
// ------------------------------------------------------------------------------------------------

/** The four departures a day, in the order the booking card offers them. */
const TIMES_OF_DAY: TimeOfDay[] = ['dawn', 'day', 'dusk', 'night'];
const BOARD_ROWS = 10;
/** Boarding starts this long before departure (h): the boards read as at that moment. */
const BOARDING_LEAD_H = 0.25;

/** "16:40" (or "16:40 …") as hours. */
const hoursOf = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? Number(m[1]) + Number(m[2]) / 60 : 0;
};

/**
 * The boards of one airport, from the same source as the booking card: Funfair Air's four legs a
 * day out of `region` (FA101 from home, FA102 from the island, at the card's times, bookFlight's
 * hour) and the four coming in (at departure + the card's block time), among the invented traffic
 * of `base` (whose own FA101/FA102 rows are dropped). The boards read as they would when the
 * leg `chosen` (the time of day picked on the card) starts boarding: that one is "Boarding" at the
 * visitor's gate (its gate screen shows it), the earlier legs have gone, and the invented traffic's
 * remarks follow the same clock. Ten rows, from a little before that moment.
 */
export function scheduleBoards(
  region: Region,
  chosen: TimeOfDay,
  base: { departures: FlightRow[]; arrivals: FlightRow[] },
  now = new Date(),
): { departures: FlightRow[]; arrivals: FlightRow[] } {
  const away: Region = region === 'home' ? 'island' : 'home';
  const clock = TIME_OF_DAY_HOUR[chosen] - BOARDING_LEAD_H;
  const gateOf = (r: Region) => String(AIRFIELDS[r].stands.find((s) => s.id === AIRFIELDS[r].playerStand)?.gate ?? '');
  const placeName = (r: Region) => (r === 'home' ? 'Funfair' : 'Palm Cay');
  const ownNos = new Set(['FA101', 'FA102']);
  type Timed = { h: number; row: FlightRow };

  const departures: Timed[] = TIMES_OF_DAY.map((tod) => {
    const f = bookFlight(region, tod, now);
    const status = tod === chosen ? 'Boarding' : f.hour < TIME_OF_DAY_HOUR[chosen] ? 'Departed' : 'On time';
    return { h: f.hour, row: { time: clockText(f.hour), flight: f.flightNo, to: placeName(away), gate: gateOf(region), status } };
  });
  for (const r of base.departures) {
    if (ownNos.has(r.flight)) continue;
    const h = hoursOf(r.time);
    const d = h - clock;
    const status =
      d < -0.15 ? 'Departed' : d < 0 ? 'Gate closed' : d < 0.12 ? 'Final call' : d < 0.45 ? 'Boarding' : d < 0.75 ? 'Go to gate' : /delay/i.test(r.status) ? r.status : 'On time';
    departures.push({ h, row: { ...r, status } });
  }

  // the legs flying in: home's FA102 belt and the island's FA101 belt are the base boards' own
  const belt = base.arrivals.find((r) => ownNos.has(r.flight))?.gate ?? '1';
  const arrivals: Timed[] = TIMES_OF_DAY.map((tod) => {
    const f = bookFlight(away, tod, now);
    const h = (f.hour + (f.plan.blockTimeS + SCHEDULE_PAD_S) / 3600) % 24;
    return { h, row: { time: clockText(h), flight: f.flightNo, to: placeName(away), gate: belt, status: '' } };
  });
  for (const r of base.arrivals) if (!ownNos.has(r.flight)) arrivals.push({ h: hoursOf(r.time), row: { ...r } });
  for (const a of arrivals) {
    const d = a.h - clock;
    a.row.status = d < -0.5 ? 'Landed' : d < 0 ? 'Baggage in hall' : /expected|delay/i.test(a.row.status) ? a.row.status : 'On time';
  }

  // ten rows from an hour before the moment (or the day's last ten)
  const window = (list: Timed[]) => {
    list.sort((a, b) => a.h - b.h);
    let i = list.findIndex((t) => t.h >= clock - 1);
    if (i < 0) i = list.length;
    i = Math.min(i, Math.max(0, list.length - BOARD_ROWS));
    return list.slice(i, i + BOARD_ROWS).map((t) => t.row);
  };
  return { departures: window(departures), arrivals: window(arrivals) };
}

const W = 2048;
const H = 1280;
const BOARD = { w: 1024, h: 640 };
const GATE = { w: 512, h: 288 };

/**
 * Every screen of one terminal on one canvas: the departures board, the arrivals board and a
 * screen per gate. Meshes take their uvs from `screens`.
 */
export class FlightBoards {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  /** Screens light themselves: unlit, a touch brighter at night (so they bloom softly in the dark). */
  readonly material: THREE.MeshBasicMaterial;
  readonly screens: { departures: UvRect; arrivals: UvRect; gate: Record<number, UvRect> };
  private readonly g: CanvasRenderingContext2D;
  private departures: FlightRow[] = DEFAULT_DEPARTURES;
  private arrivals: FlightRow[] = DEFAULT_ARRIVALS;

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly opts: { airport: string; airline: string; gates: number[] },
  ) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = canvasTex(this.canvas, renderer);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: true });
    const uv = (x: number, y: number, w: number, h: number): UvRect => ({ u0: (x + 1) / W, u1: (x + w - 1) / W, v0: 1 - (y + h - 1) / H, v1: 1 - (y + 1) / H });
    const gate: Record<number, UvRect> = {};
    opts.gates.forEach((n, i) => {
      gate[n] = uv((i % 4) * GATE.w, BOARD.h + Math.floor(i / 4) * GATE.h, GATE.w, GATE.h);
    });
    this.screens = { departures: uv(0, 0, BOARD.w, BOARD.h), arrivals: uv(BOARD.w, 0, BOARD.w, BOARD.h), gate };
    this.paint();
    // the boards' font may still be on its way: paint again once it's here
    void document.fonts?.ready.then(() => this.paint());
  }

  /** The aspect (width / height) of the big boards and of the gate screens. */
  static readonly boardAspect = BOARD.w / BOARD.h;
  static readonly gateAspect = GATE.w / GATE.h;

  setDepartures(rows: FlightRow[]) {
    this.departures = rows;
    this.paint();
  }

  setArrivals(rows: FlightRow[]) {
    this.arrivals = rows;
    this.paint();
  }

  setNight(k: number) {
    this.material.color.setScalar(THREE.MathUtils.lerp(1, 1.35, k));
  }

  private paint() {
    const g = this.g;
    paintBoard(g, 0, 0, BOARD.w, BOARD.h, 'departures', this.opts.airport, this.departures);
    paintBoard(g, BOARD.w, 0, BOARD.w, BOARD.h, 'arrivals', this.opts.airport, this.arrivals);
    this.opts.gates.forEach((n, i) => {
      // the gate shows its next departure that hasn't left yet
      const f = this.departures.find((r) => r.gate === String(n) && !/departed|cancel/i.test(r.status)) ?? null;
      paintGateScreen(g, (i % 4) * GATE.w, BOARD.h + Math.floor(i / 4) * GATE.h, GATE.w, GATE.h, n, f, this.opts.airline);
    });
    this.texture.needsUpdate = true;
  }
}
