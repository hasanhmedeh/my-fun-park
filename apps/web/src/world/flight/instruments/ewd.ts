// The Engine and Warning Display (upper ECAM): the two LEAP-1A's N1 dials with the thrust limit and
// the thrust levers' position, EGT, N2 and fuel flow, the fuel on board, the slats/flaps indicator,
// and below the line the warning and memo area: red and amber alerts, the T.O and LDG memos with
// their checklist lines (cyan until done, green once done), and the green memos on the right.
//
// The flight model gives N1 and fuel flow; EGT and N2 follow from N1 along the LEAP-1A's working
// line (idle ~440 °C / 63 %, takeoff ~880 °C / 98 %), which is what the gauges of a real one show.

import { A320 } from '../../../aviation/a320';
import { leverN1 } from '../../../aviation/fdm';
import { phaseIndex } from '../../../aviation/nav';
import { C, Display, clamp, line, poly, text } from './display';
import type { CockpitData } from './types';

const D2R = Math.PI / 180;

/** Engine dial centres (x for engine 1, 2), the N1 and EGT rows. */
const ENG_X = [190, 520];
const N1_Y = 190;
const N1_R = 118;
const EGT_Y = 418;
const EGT_R = 76;
/** The thrust limits the FADEC works to (N1 %): the same detents the flight model uses. */
const LIMIT = { TOGA: A320.n1Toga * 100, FLX: 94, CLB: 90 };
/** The N1 dial: 0 % at 150° (lower left), sweeping 210° clockwise to 110 %. */
const N1_START = 150;
const N1_SWEEP = 210;
const N1_MAX = 110;
/** The EGT dial: 0 °C on the left to 1200 °C on the right, red line 1060 °C (the LEAP-1A's limit). */
const EGT_MAX = 1200;
const EGT_RED = 1060;
/** The memo area. */
const MEMO_Y = 668;
const MEMO_ROW = 44;
const DETENT_TOL = 0.03;

const CONFIG_NAMES = ['', '1', '1+F', '2', '3', 'FULL'];
const LEVER_NAMES = ['', '1+F', '2', '3', 'FULL'];
/** Positions on the indicator: slats 0/18/22/27°, flaps 0/10/15/20/40°. */
const SLAT_STOPS = [0, 18, 22, 27];
const FLAP_STOPS = [0, 10, 15, 20, 40];

export class Ewd {
  readonly display: Display;
  private warp = 1;

  constructor(className: string, hz = 10) {
    this.display = new Display(className, hz);
  }

  update(dt: number, d: CockpitData) {
    // a time-warp change shows at once rather than at the next 10 Hz redraw
    if (d.timeWarp !== this.warp) {
      this.warp = d.timeWarp;
      this.display.invalidate();
    }
    if (!this.display.due(dt) || !this.display.begin()) return;
    const g = this.display.g;
    this.engines(g, d);
    this.limit(g, d);
    this.fuel(g, d);
    this.slatsFlaps(g, d);
    line(g, 20, 630, 980, 630, C.white, 3);
    line(g, 520, 650, 520, 980, C.white, 3);
    this.memos(g, d);
  }

  dispose() {
    this.display.dispose();
  }

  // ---------------------------------------------------------------------------------------------- engines

  private engines(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s } = d;
    const lever = d.controls?.throttle ?? null;
    const limit = LIMIT[thrustLimit(d)];
    const tla = lever === null ? null : leverN1(lever) * 100;
    const eng = engineReadouts(d);
    for (let i = 0; i < 2; i++) {
      const cx = ENG_X[i];
      const r = eng[i];
      const n1 = r.n1;
      const { starting, live } = r;

      // N1: white scale, red beyond 101 %, the amber limit mark, the levers' cyan circle, the green needle
      const ang = (v: number) => (N1_START + (clamp(v, 0, N1_MAX) / N1_MAX) * N1_SWEEP) * D2R;
      g.strokeStyle = C.white;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(cx, N1_Y, N1_R, ang(0), ang(101));
      g.stroke();
      g.strokeStyle = C.red;
      g.lineWidth = 8;
      g.beginPath();
      g.arc(cx, N1_Y, N1_R, ang(101), ang(N1_MAX));
      g.stroke();
      for (let v = 20; v <= 100; v += 10) {
        const a = ang(v);
        const r0 = N1_R - (v % 50 === 0 ? 20 : 12);
        line(g, cx + Math.cos(a) * r0, N1_Y + Math.sin(a) * r0, cx + Math.cos(a) * N1_R, N1_Y + Math.sin(a) * N1_R, C.white, 4);
      }
      for (const [v, label] of [
        [50, '5'],
        [100, '10'],
      ] as const) {
        const a = ang(v);
        text(g, label, cx + Math.cos(a) * (N1_R - 42), N1_Y + Math.sin(a) * (N1_R - 42), C.white, 30);
      }
      const la = ang(limit);
      line(g, cx + Math.cos(la) * (N1_R - 4), N1_Y + Math.sin(la) * (N1_R - 4), cx + Math.cos(la) * (N1_R + 22), N1_Y + Math.sin(la) * (N1_R + 22), C.amber, 6);
      if (tla !== null && live) {
        const ta = ang(tla);
        g.strokeStyle = C.cyan;
        g.lineWidth = 4;
        g.beginPath();
        g.arc(cx + Math.cos(ta) * (N1_R + 14), N1_Y + Math.sin(ta) * (N1_R + 14), 9, 0, Math.PI * 2);
        g.stroke();
        // the autothrust's command, an arc from the needle to the levers' limit when they differ
        if (d.athrActive && Math.abs(tla - n1) > 1.5) {
          g.strokeStyle = C.green;
          g.lineWidth = 5;
          g.beginPath();
          const a0 = ang(Math.min(n1, tla));
          const a1 = ang(Math.max(n1, tla));
          g.arc(cx, N1_Y, N1_R + 2, a0, a1);
          g.stroke();
        }
      }
      const na = ang(n1);
      line(g, cx, N1_Y, cx + Math.cos(na) * (N1_R - 6), N1_Y + Math.sin(na) * (N1_R - 6), live ? C.green : C.grey, 6);
      // the digital N1, with the tenths small
      g.fillStyle = C.black;
      g.fillRect(cx + 4, N1_Y + 20, 128, 56);
      const colour = live ? (n1 > 101 ? C.red : C.green) : C.grey;
      text(g, String(Math.floor(n1)), cx + 92, N1_Y + 48, colour, 50, 'right');
      text(g, `.${Math.floor((n1 * 10) % 10)}`, cx + 94, N1_Y + 54, colour, 36, 'left');
      // reversers: amber "REV" in transit, green once deployed
      if (s.reverser > 0.05) {
        const deployed = s.reverser > 0.95;
        g.fillStyle = C.black;
        g.fillRect(cx - 50, N1_Y - 70, 100, 46);
        poly(g, [cx - 50, N1_Y - 70, cx + 50, N1_Y - 70, cx + 50, N1_Y - 24, cx - 50, N1_Y - 24], null, deployed ? C.green : C.amber, 3);
        text(g, 'REV', cx, N1_Y - 47, deployed ? C.green : C.amber, 36);
      }
      if (starting) text(g, 'START', cx, N1_Y - 44, C.white, 28);

      // EGT: a half dial, red line at the limit
      const egt = r.egt;
      const ea = (v: number) => (180 + (clamp(v, 0, EGT_MAX) / EGT_MAX) * 180) * D2R;
      g.strokeStyle = C.white;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(cx, EGT_Y, EGT_R, ea(0), ea(EGT_RED));
      g.stroke();
      const ra = ea(EGT_RED);
      line(g, cx + Math.cos(ra) * (EGT_R - 10), EGT_Y + Math.sin(ra) * (EGT_R - 10), cx + Math.cos(ra) * (EGT_R + 14), EGT_Y + Math.sin(ra) * (EGT_R + 14), C.red, 6);
      const ea2 = ea(egt);
      line(g, cx, EGT_Y, cx + Math.cos(ea2) * (EGT_R - 4), EGT_Y + Math.sin(ea2) * (EGT_R - 4), live ? C.green : C.grey, 5);
      text(g, String(Math.round(egt / 5) * 5), cx, EGT_Y + 32, live ? C.green : C.grey, 40);

      // N2 and fuel flow
      text(g, live ? r.n2.toFixed(1) : 'XX', cx, 528, live ? C.green : C.amber, 40);
      text(g, live ? String(Math.round(r.ffKgH / 20) * 20) : 'XX', cx, 588, live ? C.green : C.amber, 40);
    }
    // the labels between the engines
    const mx = (ENG_X[0] + ENG_X[1]) / 2;
    text(g, 'N1', mx, N1_Y - 10, C.white, 34);
    text(g, '%', mx, N1_Y + 28, C.cyan, 30);
    text(g, 'EGT', mx, EGT_Y - 20, C.white, 32);
    text(g, '°C', mx, EGT_Y + 16, C.cyan, 30);
    text(g, 'N2', mx, 512, C.white, 30);
    text(g, '%', mx, 544, C.cyan, 28);
    text(g, 'FF', mx, 572, C.white, 30);
    text(g, 'KG/H', mx, 604, C.cyan, 26);
  }

  /** The thrust limit mode in the top right corner, with the thrust levers' detent and A/THR. */
  private limit(g: CanvasRenderingContext2D, d: CockpitData) {
    const mode = thrustLimit(d);
    text(g, mode, 830, 44, C.cyan, 40);
    text(g, LIMIT[mode].toFixed(1), 900, 92, C.green, 42, 'right');
    text(g, '%', 912, 94, C.cyan, 32, 'left');
    const lever = d.controls?.throttle;
    if (lever !== undefined) {
      const det = A320.detents;
      const name = lever >= det.toga - DETENT_TOL ? 'TOGA' : lever >= det.flx - DETENT_TOL ? 'FLX' : Math.abs(lever - det.cl) < DETENT_TOL ? 'CL' : lever <= DETENT_TOL ? 'IDLE' : 'MAN';
      text(g, `LVR ${name}`, 830, 146, C.white, 30);
    }
    if (d.fcu.athr) text(g, 'A/THR', 830, 188, d.athrActive === false ? C.cyan : C.green, 32);
  }

  private fuel(g: CanvasRenderingContext2D, d: CockpitData) {
    text(g, 'FOB :', 690, 262, C.white, 32, 'left');
    text(g, String(Math.round(d.s.fuel / 10) * 10), 930, 262, C.green, 38, 'right');
    text(g, 'KG', 940, 264, C.cyan, 28, 'left');
  }

  /** The slats on the left and flaps on the right of a small wing, with the configuration underneath. */
  private slatsFlaps(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s } = d;
    const cx = 806;
    const cy = 380;
    // the wing
    poly(g, [cx - 44, cy - 6, cx + 44, cy - 10, cx + 44, cy + 6, cx - 44, cy + 10], C.grey);
    text(g, 'S', cx - 128, cy - 34, C.white, 32);
    text(g, 'F', cx + 128, cy - 34, C.white, 32);
    // the stops: small white markers down and out from each edge
    const slatAt = (deg: number) => {
      const k = stopIndex(SLAT_STOPS, deg);
      return [cx - 50 - k * 32, cy + 8 + k * 15] as const;
    };
    const flapAt = (deg: number) => {
      const k = stopIndex(FLAP_STOPS, deg);
      return [cx + 50 + k * 27, cy + 8 + k * 12] as const;
    };
    for (let i = 1; i < SLAT_STOPS.length; i++) {
      const [x, y] = slatAt(SLAT_STOPS[i]);
      g.fillStyle = C.white;
      g.fillRect(x - 4, y + 10, 8, 8);
    }
    for (let i = 1; i < FLAP_STOPS.length; i++) {
      const [x, y] = flapAt(FLAP_STOPS[i]);
      g.fillStyle = C.white;
      g.fillRect(x - 4, y + 10, 8, 8);
    }
    const [sx, sy] = slatAt(s.slatsDeg);
    const [fx, fy] = flapAt(s.flapsDeg);
    poly(g, [cx - 46, cy - 4, sx, sy - 6, sx - 10, sy + 6, cx - 46, cy + 10], C.green);
    poly(g, [cx + 46, cy - 6, fx + 10, fy - 4, fx, fy + 8, cx + 46, cy + 8], C.green);
    // the configuration: cyan while moving to the lever's, green once there
    const lever = d.controls?.flapLever;
    const target = lever === undefined ? CONFIG_NAMES[s.config] : lever === 1 ? (s.onGround || s.flapsDeg > 1 ? '1+F' : '1') : LEVER_NAMES[lever];
    const moving = target !== CONFIG_NAMES[s.config];
    if (target) text(g, target, cx, cy + 74, moving ? C.cyan : C.green, 40);
  }

  // ---------------------------------------------------------------------------------------------- memos

  private memos(g: CanvasRenderingContext2D, d: CockpitData) {
    const { left, right } = ecamLists(d);
    left.slice(0, MEMO_ROWS).forEach((m, i) => text(g, m.text, 34, MEMO_Y + i * MEMO_ROW, m.colour, 33, 'left'));
    right.slice(0, MEMO_ROWS).forEach((m, i) => text(g, m.text, 548, MEMO_Y + i * MEMO_ROW, m.colour, 33, 'left'));
  }
}

/** One line of the EWD's warning and memo area. */
export interface MemoLine {
  text: string;
  colour: string;
}

/** The memo rows each side has room for. */
const MEMO_ROWS = 7;
/** The flight's memos the EWD works out itself, or shows on the left in the T.O / LDG memo (dropped from its list). */
const DERIVED_MEMO = /^(TIME ×|PARK BRK$|SPEED BRK$|AUTO BRK|GND SPLRS ARMED$|SEAT BELTS$|NO SMOKING$|SIGNS ON$|CABIN READY$|SPLRS |FLAPS |LDG GEAR |T\.O )/;
/** Without the controls the EWD can still tell the time warp and the checklist lines itself. */
const DERIVED_MEMO_NO_CONTROLS = /^(TIME ×|SIGNS ON$|CABIN READY$|SPLRS |FLAPS |LDG GEAR |T\.O )/;
/** The warnings liveWarnings() decides each frame (the flight's own copies of these are ignored). */
const LIVE_WARNINGS = new Set(['L/G GEAR NOT DOWN', 'OVERSPEED', 'STALL', 'CONFIG PARK BRK ON', 'CONFIG FLAPS NOT IN T.O CONFIG', 'SPD BRK STILL OUT']);

/**
 * What the EWD's lower half shows now: the warnings and cautions (or, with none, the T.O / LDG memo)
 * on the left, the memos on the right.
 *
 * Everything the cockpit data can tell is worked out here from this frame's state rather than taken
 * from the flight's lists, which it rebuilds only a few times a second and which would otherwise keep
 * a line up after the state behind it has gone (the "TIME ×4" that stayed on after the warp): the
 * time warp from `timeWarp`; the gear, speed and configuration warnings, the brakes, speed brake,
 * spoilers and signs from `s` and `controls`; and an "ENG n SHUT DOWN" from the flight is kept only
 * while `sys` still has that engine stopped and not starting. Any other line the flight sends passes
 * through as it is. Pure, so it can be checked headless.
 */
export function ecamLists(d: CockpitData): { left: MemoLine[]; right: MemoLine[] } {
  const c = d.controls;
  const s = d.s;
  const live = liveWarnings(d);
  const warnings: CockpitData['warnings'] = live ?? [];
  for (const w of d.warnings) {
    if (live && LIVE_WARNINGS.has(w.text)) continue;
    const eng = /^ENG ([12]) SHUT DOWN$/.exec(w.text);
    if (eng && d.sys) {
      const i = Number(eng[1]) - 1;
      if (d.sys.engineRunning[i] || d.sys.engineStart[i] >= 0) continue;
    }
    if (!warnings.some((x) => x.text === w.text)) warnings.push(w);
  }
  // red warnings above amber cautions, each in the order raised
  const left: MemoLine[] = [...warnings.filter((w) => w.level === 'warning'), ...warnings.filter((w) => w.level !== 'warning')].map((w) => ({ text: w.text, colour: w.level === 'warning' ? C.red : C.amber }));
  const check = checklist(d);
  if (!left.length) left.push(...check);

  const right: MemoLine[] = [];
  const add = (t: string, colour: string = C.green) => {
    if (!right.some((m) => m.text === t)) right.push({ text: t, colour });
  };
  if (d.timeWarp > 1) add(`TIME ×${d.timeWarp}`);
  if (c) {
    const p = phaseIndex(d.phase);
    if (c.parkingBrake) add('PARK BRK');
    // amber with the thrust above idle and the speed brake out
    if (!s.onGround && c.speedbrake > 0.05) add('SPEED BRK', c.throttle > 0.05 ? C.amber : C.green);
    if (d.sys?.autobrakeActive) add('AUTO BRK DECEL');
    else if (!s.onGround && c.autobrake !== 'off' && p >= phaseIndex('approach')) add(`AUTO BRK ${c.autobrake.toUpperCase()}`);
    if (!s.onGround && c.spoilersArmed && p >= phaseIndex('approach')) add('GND SPLRS ARMED');
    // the signs are items of the T.O and LDG memos while those apply, their own memos otherwise
    if (!check.length) {
      add('SEAT BELTS');
      add('NO SMOKING');
    }
  }
  const derived = c ? DERIVED_MEMO : DERIVED_MEMO_NO_CONTROLS;
  for (const m of d.memos) if (!derived.test(m)) add(m);
  return { left, right };
}

/** The gear, speed and configuration warnings from this frame's state and controls (null without the controls). */
function liveWarnings(d: CockpitData): CockpitData['warnings'] | null {
  const c = d.controls;
  if (!c) return null;
  const s = d.s;
  const det = A320.detents;
  const out: CockpitData['warnings'] = [];
  if (!s.onGround && !c.gearDown && s.radioAltFt < 750 && (c.flapLever >= 3 || c.throttle < 0.1)) out.push({ text: 'L/G GEAR NOT DOWN', level: 'warning' });
  if (s.overspeed) out.push({ text: 'OVERSPEED', level: 'warning' });
  if (s.stallWarning) out.push({ text: 'STALL', level: 'warning' });
  if (s.onGround && c.parkingBrake && c.throttle > det.flx - 0.05) out.push({ text: 'CONFIG PARK BRK ON', level: 'warning' });
  if (s.onGround && c.throttle > det.flx - 0.05 && c.flapLever === 0) out.push({ text: 'CONFIG FLAPS NOT IN T.O CONFIG', level: 'warning' });
  if (!s.onGround && c.speedbrake > 0 && c.throttle > det.cl + 0.05) out.push({ text: 'SPD BRK STILL OUT', level: 'caution' });
  return out;
}

/** The T.O memo before takeoff and the LDG memo on the approach, item by item. */
function checklist(d: CockpitData): MemoLine[] {
  const { s } = d;
  const c = d.controls;
  const p = phaseIndex(d.phase);
  const running = d.sys ? d.sys.engineRunning[0] && d.sys.engineRunning[1] : s.n1[0] > 0.18 && s.n1[1] > 0.18;
  const item = (label: string, value: string, done: boolean): MemoLine => ({ text: done ? `${label} ${value}` : `${label}${'.'.repeat(Math.max(2, 15 - label.length - value.length))}${value}`, colour: done ? C.green : C.cyan });
  if (s.onGround && running && p >= phaseIndex('pushback') && p <= phaseIndex('takeoff') && s.ias < 60) {
    const lever = c?.flapLever ?? 0;
    const flapsOk = lever >= 1 && lever <= 3;
    const ab = c?.autobrake === 'max';
    const splrs = c?.spoilersArmed ?? false;
    return [
      { text: ab ? 'T.O AUTO BRK MAX' : 'T.O AUTO BRK.....MAX', colour: ab ? C.green : C.cyan },
      item('    SIGNS', 'ON', true),
      item('    CABIN', 'READY', true),
      item('    SPLRS', 'ARM', splrs),
      item('    FLAPS', 'T.O', flapsOk),
      item('    T.O CONFIG', flapsOk && splrs ? 'NORM' : 'TEST', flapsOk && splrs),
    ];
  }
  if (!s.onGround && (p >= phaseIndex('approach') || (s.radioAltFt < 2000 && p >= phaseIndex('descent')))) {
    // down and locked, with the lever down (a lever moved up shows cyan at once)
    const gearDn = s.gear > 0.99 && (c?.gearDown ?? true);
    return [
      { text: gearDn ? 'LDG GEAR DN' : 'LDG GEAR......DN', colour: gearDn ? C.green : C.cyan },
      item('    SIGNS', 'ON', true),
      item('    CABIN', 'READY', true),
      item('    SPLRS', 'ARM', c?.spoilersArmed ?? false),
      item('    FLAPS', 'FULL', (c?.flapLever ?? Math.min(4, s.config)) >= 4),
    ];
  }
  return [];
}

/** The thrust limit the FADEC shows: TOGA before takeoff, then by the levers (FLX or TOGA beyond CL, else CLB). */
function thrustLimit(d: CockpitData): keyof typeof LIMIT {
  const lever = d.controls?.throttle ?? 0;
  const det = A320.detents;
  if (lever >= det.toga - DETENT_TOL) return 'TOGA';
  if (lever >= det.flx - DETENT_TOL) return 'FLX';
  if (d.s.onGround && phaseIndex(d.phase) <= phaseIndex('takeoff')) return 'TOGA';
  return 'CLB';
}

/** One engine's EWD readouts. */
export interface EngineReadout {
  /** N1 (%), N2 (%), EGT (°C) and fuel flow (kg/h, never negative). */
  n1: number;
  n2: number;
  egt: number;
  ffKgH: number;
  running: boolean;
  starting: boolean;
  /** Drawn green (turning); otherwise the needles are grey and N2/FF read XX. */
  live: boolean;
}

/**
 * The two engines' readouts. The flight model gives only the total fuel flow, so it's shared
 * between the engines by each one's own schedule (idle flow plus the share of the TOGA flow its
 * thrust fraction calls for, the law the model burns by). The reversers' negative thrust never
 * enters it, so the flow stays positive and physical in reverse.
 */
export function engineReadouts(d: CockpitData): [EngineReadout, EngineReadout] {
  const { s } = d;
  const total = Math.max(0, Number.isFinite(s.fuelFlow) ? s.fuelFlow : 0) * 3600;
  const read = (i: number) => {
    const n1 = clamp(Number.isFinite(s.n1[i]) ? s.n1[i] : 0, 0, 1.2);
    const running = d.sys ? d.sys.engineRunning[i] : n1 > 0.15;
    const starting = d.sys ? d.sys.engineStart[i] >= 0 : false;
    const live = running || starting || n1 > 0.02;
    const r: EngineReadout = { n1: n1 * 100, n2: n2For(n1), egt: egtFor(n1, d.weather.tempC), ffKgH: 0, running, starting, live };
    return { r, w: running || starting ? flowShape(n1) : 0 };
  };
  const a = read(0);
  const b = read(1);
  const sum = a.w + b.w;
  if (sum > 0) {
    a.r.ffKgH = (total * a.w) / sum;
    b.r.ffKgH = (total * b.w) / sum;
  }
  return [a.r, b.r];
}

/** The flight model's per-engine fuel schedule (relative) for an N1: idle flow plus the TOGA share by thrust fraction. */
function flowShape(n1: number) {
  const idle = A320.n1Idle;
  const frac = n1 < idle ? A320.idleThrustFrac * (n1 / idle) ** 2 : A320.idleThrustFrac + (1 - A320.idleThrustFrac) * clamp((n1 - idle) / (A320.n1Toga - idle), 0, 1.05) ** A320.thrustExp;
  return A320.fuelIdle + (A320.fuelToga - A320.fuelIdle) * clamp((frac - A320.idleThrustFrac) / (1 - A320.idleThrustFrac), 0, 1.1);
}

/** Where a surface angle sits between the indicator's stops (0 .. stops − 1, fractional while moving). */
function stopIndex(stops: readonly number[], deg: number) {
  for (let i = 1; i < stops.length; i++) {
    if (deg <= stops[i]) return i - 1 + (deg - stops[i - 1]) / (stops[i] - stops[i - 1]);
  }
  return stops.length - 1;
}

/** EGT (°C) along the LEAP-1A's working line for an N1 (0..1), from the outside air when it's not turning. */
export function egtFor(n1: number, oatC: number) {
  const idle = A320.n1Idle;
  if (n1 <= idle) return oatC + (n1 / idle) ** 1.5 * (440 - oatC);
  return 440 + ((n1 - idle) / (A320.n1Toga - idle)) ** 1.3 * 440;
}

/** N2 (%) for an N1 (0..1): ~63 % at idle, ~98 % at takeoff thrust. */
export function n2For(n1: number) {
  const idle = A320.n1Idle;
  if (n1 <= idle) return (n1 / idle) * 63;
  return 63 + ((n1 - idle) / (A320.n1Toga - idle)) * 35;
}
