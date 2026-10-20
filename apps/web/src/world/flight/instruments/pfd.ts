// The captain's Primary Flight Display, laid out as the A320's: the flight mode annunciator across
// the top, the attitude sphere with its pitch ladder, bank scale, aircraft symbol and flight
// director bars in the middle, the speed tape on the left (with the characteristic speeds and the
// red-and-black limits), the altitude tape and vertical speed scale on the right, the heading tape
// below, the radio height, the ILS deviation scales and the PFD's own messages.
//
// Everything is drawn in display units (1000 × 1000, see display.ts) from one CockpitData.

import { A320 } from '../../../aviation/a320';
import type { AircraftState, FcuState } from '../../../aviation/types';
import { C, Display, angleDiff, barber, blink, box, clamp, ilsShown, lateralManaged, line, pad, poly, text } from './display';
import type { CockpitData } from './types';

const D2R = Math.PI / 180;

// ------------------------------------------------------------------ layout (display units)
/** Centre of the attitude sphere, units per degree of pitch, and the sphere's clip. */
const AX = 440;
const AY = 478;
const PPD = 11.4;
const SPHERE_R = 302;
const SPHERE_X0 = 250;
const SPHERE_X1 = 630;
/** The speed tape: its edges, half height and units per knot (±42 kt in view, as the real one). */
const SP_X0 = 36;
const SP_X1 = 170;
const TAPE_HALF = 288;
const SP_K = 6.8;
/** The altitude tape: edges and units per foot (±540 ft in view). */
const AL_X0 = 708;
const AL_X1 = 816;
const AL_K = 0.533;
/** The vertical speed scale's left edge. */
const VS_X = 866;
/** The heading tape: top, bottom and units per degree. */
const HD_Y0 = 828;
const HD_Y1 = 896;
const HD_K = 11.5;
/** FMA: column edges and row centres. */
const FMA_COLS = [0, 206, 404, 602, 800, 1000];
const FMA_ROWS = [36, 78, 120];
const FMA_SIZE = 37;
/** How long a new FMA mode stays boxed (s). */
const FMA_BOX_S = 10;
/** The LOC and G/S scales: units per dot. */
const LOC_DOT = 58;
const GS_DOT = 54;

type FmaCell = { text: string; colour: string } | null;

/** The PFD: one Display, plus the FMA's memory of when each mode came on (for the white box). */
export class Pfd {
  readonly display: Display;
  private t = 0;
  private readonly fmaLast = ['', '', '', '', ''];
  private readonly fmaSince = [-99, -99, -99, -99, -99];

  constructor(className: string, hz = 30) {
    this.display = new Display(className, hz);
  }

  update(dt: number, d: CockpitData) {
    this.t += dt;
    // the FMA's boxes must time out even when the display isn't redrawn this frame
    this.trackFma(d);
    if (!this.display.due(dt) || !this.display.begin()) return;
    const g = this.display.g;
    this.attitude(g, d);
    this.speedTape(g, d);
    this.altitudeTape(g, d);
    this.verticalSpeed(g, d.s);
    this.headingTape(g, d);
    this.ilsScales(g, d);
    this.messages(g, d);
    this.fma(g, d);
  }

  dispose() {
    this.display.dispose();
  }

  // ---------------------------------------------------------------------------------------------- FMA

  /** The five columns' three rows: thrust, vertical, lateral, approach capability, engagement. */
  private fmaCells(d: CockpitData): FmaCell[][] {
    const { fcu, s } = d;
    const fma = fcu.fma;
    const cols: FmaCell[][] = [[null, null, null], [null, null, null], [null, null, null], [null, null, null], [null, null, null]];
    // 1: autothrust / thrust lever mode
    if (d.lvrClb) {
      if (blink(this.t, 1.2)) cols[0][0] = { text: 'LVR CLB', colour: C.white };
    } else if (fma.thrust === 'MAN TOGA' || fma.thrust === 'MAN FLX') {
      cols[0][0] = { text: 'MAN', colour: C.white };
      cols[0][1] = { text: fma.thrust === 'MAN TOGA' ? 'TOGA' : 'FLX', colour: C.white };
    } else if (fma.thrust !== 'none') cols[0][0] = { text: fma.thrust, colour: C.green };
    // 2: vertical, with ALT armed (cyan) while climbing or descending to the FCU's altitude
    if (fma.vertical !== 'none') cols[1][0] = { text: fma.vertical, colour: C.green };
    if (fma.armedVertical !== 'none') cols[1][1] = { text: fma.armedVertical, colour: C.cyan };
    else if (['SRS', 'CLB', 'OP CLB', 'DES', 'OP DES', 'V/S'].includes(fma.vertical) && Math.abs(fcu.alt - s.altFt) > 250) cols[1][1] = { text: 'ALT', colour: C.cyan };
    // 3: lateral
    if (fma.lateral !== 'none') cols[2][0] = { text: fma.lateral, colour: C.green };
    if (fma.armedLateral !== 'none') cols[2][1] = { text: fma.armedLateral, colour: C.cyan };
    // 4: approach capability (a CAT 1 ILS here) and the decision height
    if (fcu.appr || fma.vertical === 'G/S' || fma.vertical === 'G/S*') {
      cols[3][0] = { text: 'CAT 1', colour: C.white };
      cols[3][2] = { text: `DH ${d.dhFt ?? 200}`, colour: C.cyan };
    }
    // 5: AP, FD, A/THR engagement
    if (fcu.ap) cols[4][0] = { text: 'AP1', colour: C.white };
    // both flight directors are always on
    cols[4][1] = { text: '1 FD 2', colour: C.white };
    if (fcu.athr) cols[4][2] = { text: 'A/THR', colour: d.athrActive === false ? C.cyan : C.white };
    return cols;
  }

  private trackFma(d: CockpitData) {
    const f = d.fcu.fma;
    const now = [f.thrust, f.vertical, f.lateral, d.fcu.appr ? 'CAT' : '', d.fcu.ap ? 'AP' : ''];
    for (let i = 0; i < 5; i++) {
      if (now[i] !== this.fmaLast[i]) {
        this.fmaLast[i] = now[i];
        this.fmaSince[i] = now[i] && now[i] !== 'none' ? this.t : -99;
      }
    }
  }

  private fma(g: CanvasRenderingContext2D, d: CockpitData) {
    for (let i = 1; i < 5; i++) line(g, FMA_COLS[i], 8, FMA_COLS[i], 140, C.grey, 3);
    const cols = this.fmaCells(d);
    for (let c = 0; c < 5; c++) {
      const cx = (FMA_COLS[c] + FMA_COLS[c + 1]) / 2;
      for (let r = 0; r < 3; r++) {
        const cell = cols[c][r];
        if (cell) text(g, cell.text, cx, FMA_ROWS[r], cell.colour, cell.text.length > 8 ? FMA_SIZE - 6 : FMA_SIZE);
      }
      const w = FMA_COLS[c + 1] - FMA_COLS[c] - 18;
      // a new mode is boxed in white for ten seconds
      if (this.t - this.fmaSince[c] < FMA_BOX_S && cols[c][0]) box(g, FMA_COLS[c] + 9, FMA_ROWS[0] - 22, w, 44, C.white, 3);
    }
    // MAN TOGA / MAN FLX always sit in a white box; A.FLOOR and TOGA LK in an amber one
    const thr = d.fcu.fma.thrust;
    if (!d.lvrClb && (thr === 'MAN TOGA' || thr === 'MAN FLX')) box(g, FMA_COLS[0] + 9, FMA_ROWS[0] - 22, FMA_COLS[1] - 18, FMA_ROWS[1] - FMA_ROWS[0] + 44, C.white, 3);
    if (thr === 'A.FLOOR' || thr === 'TOGA LK') box(g, FMA_COLS[0] + 9, FMA_ROWS[0] - 22, FMA_COLS[1] - 18, 44, C.amber, 3);
    // the low-energy warning takes the third row of the first three columns
    if (lowEnergy(d) && blink(this.t, 1.5)) text(g, 'SPEED SPEED SPEED', (FMA_COLS[0] + FMA_COLS[3]) / 2, FMA_ROWS[2], C.amber, FMA_SIZE);
  }

  // ---------------------------------------------------------------------------------------------- attitude

  private attitude(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s, fcu } = d;
    const bank = s.bank * D2R;
    g.save();
    // the sphere: a box with its top and bottom cut by a circle, as Airbus draws it
    g.beginPath();
    g.rect(SPHERE_X0, AY - SPHERE_R, SPHERE_X1 - SPHERE_X0, SPHERE_R * 2);
    g.clip();
    g.beginPath();
    g.arc(AX, AY, SPHERE_R, 0, Math.PI * 2);
    g.clip();
    g.translate(AX, AY);
    g.rotate(-bank);
    g.translate(0, s.pitch * PPD);
    g.fillStyle = C.sky;
    g.fillRect(-900, -2400, 1800, 2400);
    g.fillStyle = C.ground;
    g.fillRect(-900, 0, 1800, 2400);
    line(g, -900, 0, 900, 0, C.white, 4);
    // the pitch ladder every 2.5°, numbered every 10°
    const lo = Math.ceil((s.pitch - 24) / 2.5) * 2.5;
    for (let p = lo; p <= s.pitch + 24; p += 2.5) {
      if (Math.abs(p) < 0.1) continue;
      const y = -p * PPD;
      const ten = Math.abs(p % 10) < 0.1;
      const five = Math.abs(p % 5) < 0.1;
      const w = ten ? 92 : five ? 52 : 24;
      line(g, -w, y, w, y, C.white, 4);
      if (ten) {
        const label = String(Math.abs(p));
        text(g, label, -w - 34, y, C.white, 34);
        text(g, label, w + 34, y, C.white, 34);
      }
    }
    // the pitch attitude protection limits, green "="
    const pMax = s.config >= 5 ? A320.pitchMaxFull : A320.pitchMax;
    for (const p of [pMax, A320.pitchMin]) {
      const y = -p * PPD;
      for (const side of [-1, 1]) {
        line(g, side * 112, y - 6, side * 142, y - 6, C.green, 4);
        line(g, side * 112, y + 6, side * 142, y + 6, C.green, 4);
      }
    }
    g.restore();

    // the bank scale turns with the horizon; the yellow roll index and the sideslip index stay put
    g.save();
    g.translate(AX, AY);
    g.rotate(-bank);
    const R = 294;
    g.strokeStyle = C.white;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(0, 0, R, (-90 - 45) * D2R, (-90 + 45) * D2R);
    g.stroke();
    for (const a of [-45, -30, -20, -10, 10, 20, 30, 45]) {
      const r1 = R + (Math.abs(a) === 30 || Math.abs(a) === 45 ? 30 : 18);
      const ca = Math.sin(a * D2R);
      const sa = -Math.cos(a * D2R);
      line(g, ca * R, sa * R, ca * r1, sa * r1, C.white, 4);
    }
    poly(g, [0, -R, -14, -R - 22, 14, -R - 22], null, C.white, 4);
    for (const a of [-67, 67]) {
      for (const k of [-5, 5]) {
        const ca = Math.sin((a + k * 0.55) * D2R);
        const sa = -Math.cos((a + k * 0.55) * D2R);
        line(g, ca * (R + 6), sa * (R + 6), ca * (R + 26), sa * (R + 26), C.green, 4);
      }
    }
    g.restore();
    poly(g, [AX, AY - R + 3, AX - 16, AY - R + 30, AX + 16, AY - R + 30], C.black, C.yellow, 4);
    const slip = clamp(s.beta * 7, -40, 40);
    poly(g, [AX - 18 + slip, AY - R + 34, AX + 18 + slip, AY - R + 34, AX + 24 + slip, AY - R + 46, AX - 24 + slip, AY - R + 46], C.black, Math.abs(s.beta) > 5 ? C.amber : C.yellow, 4);

    // the flight director bars, behind the aircraft symbol
    if (fcu.fdPitch !== null || fcu.fdBank !== null) this.fdBars(g, s, fcu);
    // the aircraft symbol: black with a yellow outline, two wings and a square at the centre
    for (const side of [-1, 1]) {
      const xi = AX + side * 74;
      const xo = AX + side * 196;
      poly(g, [xo, AY - 8, xi, AY - 8, xi, AY + 34, xi - side * 16, AY + 34, xi - side * 16, AY + 8, xo, AY + 8], C.black, C.yellow, 4);
    }
    poly(g, [AX - 10, AY - 10, AX + 10, AY - 10, AX + 10, AY + 10, AX - 10, AY + 10], C.black, C.yellow, 4);

    // radio height under the symbol, below 2500 ft
    if (s.radioAltFt < 2500) {
      const ra = s.radioAltFt;
      const v = ra < 50 ? Math.max(0, Math.round(ra)) : ra < 200 ? Math.round(ra / 5) * 5 : Math.round(ra / 10) * 10;
      const low = ra < (d.dhFt ?? 200) && isApproach(d.phase);
      text(g, String(v), AX, AY + 216, low ? C.amber : C.green, 48);
    }
  }

  private fdBars(g: CanvasRenderingContext2D, s: AircraftState, fcu: FcuState) {
    if (fcu.fdPitch !== null) {
      const y = AY - clamp((fcu.fdPitch - s.pitch) * PPD, -120, 120);
      line(g, AX - 118, y, AX + 118, y, C.green, 6);
    }
    if (fcu.fdBank !== null) {
      const x = AX + clamp(angleDiff(fcu.fdBank, s.bank) * 3.6, -120, 120);
      line(g, x, AY - 118, x, AY + 118, C.green, 6);
    }
  }

  // ---------------------------------------------------------------------------------------------- speed

  private speedTape(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s, fcu } = d;
    // the scale starts at 30 kt: below it the reference sits at 30
    const v = Math.max(30, s.ias);
    const yOf = (kt: number) => AY - (kt - v) * SP_K;
    const top = AY - TAPE_HALF;
    const bot = AY + TAPE_HALF;
    g.save();
    g.beginPath();
    g.rect(SP_X0, top, SP_X1 - SP_X0 + 60, bot - top);
    g.clip();
    g.fillStyle = C.tape;
    g.fillRect(SP_X0, top, SP_X1 - SP_X0, Math.min(bot, yOf(30)) - top);
    for (let kt = Math.floor((v - 46) / 10) * 10; kt <= v + 46; kt += 10) {
      if (kt < 30) continue;
      const y = yOf(kt);
      line(g, SP_X1 - 20, y, SP_X1, y, C.white, 4);
      if (kt % 20 === 0) text(g, pad(kt, 3), SP_X1 - 30, y, C.white, 38, 'right');
    }
    const air = !s.onGround;
    const sp = s.speeds;
    if (air) {
      // VMAX: red and black from the limit up
      barber(g, SP_X1 - 14, yOf(sp.vmax), top - 20, 14, C.red, C.black);
      // the low-speed end: VLS amber, α prot amber and black, α max solid red
      g.fillStyle = C.amber;
      g.fillRect(SP_X1 - 7, yOf(sp.vls), 7, Math.max(0, yOf(sp.vaprot) - yOf(sp.vls)));
      barber(g, SP_X1 - 14, yOf(sp.vaprot), yOf(sp.vamax), 14, C.amber, C.black);
      g.fillStyle = C.red;
      g.fillRect(SP_X1 - 14, yOf(sp.vamax), 14, Math.max(0, bot + 20 - yOf(sp.vamax)));
      // green dot clean, S with slats only, F with the flaps at 2 or 3
      if (s.config === 0) {
        g.strokeStyle = C.green;
        g.lineWidth = 5;
        g.beginPath();
        g.arc(SP_X1 + 14, yOf(sp.greenDot), 10, 0, Math.PI * 2);
        g.stroke();
      } else if (s.config <= 2) speedMark(g, yOf(sp.s), 'S');
      else if (s.config <= 4) speedMark(g, yOf(sp.f), 'F');
    }
    // V1 and VR on the takeoff roll
    const vs = d.nav.vSpeeds;
    if (s.onGround && (d.phase === 'takeoff' || d.phase === 'taxi-out')) {
      text(g, '1', SP_X1 + 18, yOf(vs.v1), C.cyan, 38, 'center', 700);
      g.strokeStyle = C.cyan;
      g.lineWidth = 5;
      g.beginPath();
      g.arc(SP_X1 + 14, yOf(vs.vr), 9, 0, Math.PI * 2);
      g.stroke();
    }
    // the speed target: cyan when selected, magenta when managed
    const target = fcu.spd ?? d.speedTarget ?? null;
    const tc = fcu.spd !== null ? C.cyan : C.magenta;
    if (target !== null && target > 0) {
      const y = yOf(target);
      if (y > top + 10 && y < bot - 10) poly(g, [SP_X1 + 2, y, SP_X1 + 30, y - 17, SP_X1 + 30, y + 17], null, tc, 5);
    }
    // the trend arrow: where the speed will be in ten seconds
    const trend = s.iasTrend - s.ias;
    if (Math.abs(trend) > 2 && s.ias > 30) {
      const y1 = AY - clamp(trend, -40, 40) * SP_K;
      const x = SP_X1 - 46;
      line(g, x, AY, x, y1, C.yellow, 5);
      const dir = trend > 0 ? 1 : -1;
      line(g, x - 12, y1 + dir * 16, x, y1, C.yellow, 5);
      line(g, x + 12, y1 + dir * 16, x, y1, C.yellow, 5);
    }
    g.restore();
    // the edges and the fixed yellow speed reference
    line(g, SP_X0, top, SP_X1 + 6, top, C.white, 4);
    line(g, SP_X0, bot, SP_X1 + 6, bot, C.white, 4);
    line(g, SP_X1, top, SP_X1, bot, C.white, 4);
    line(g, SP_X0 - 4, AY, SP_X1 - 4, AY, C.yellow, 6);
    poly(g, [SP_X1 - 4, AY, SP_X1 + 24, AY - 16, SP_X1 + 24, AY + 16], C.yellow);
    // a target off the scale is written above or below it
    if (target !== null && target > 0) {
      const y = yOf(target);
      if (y <= top + 10) text(g, String(Math.round(target)), (SP_X0 + SP_X1) / 2, top - 26, tc, 36);
      else if (y >= bot - 10) text(g, String(Math.round(target)), (SP_X0 + SP_X1) / 2, bot + 28, tc, 36);
    }
    if (s.onGround && (d.phase === 'takeoff' || d.phase === 'taxi-out') && yOf(vs.v1) < top) text(g, String(vs.v1), SP_X1 + 30, top - 26, C.cyan, 34);
    if (s.mach >= 0.5) text(g, `.${pad(s.mach * 100, 2)}`, (SP_X0 + SP_X1) / 2, bot + 66, C.green, 36);
  }

  // ---------------------------------------------------------------------------------------------- altitude

  private altitudeTape(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s, fcu } = d;
    const a = s.altFt;
    const yOf = (ft: number) => AY - (ft - a) * AL_K;
    const top = AY - TAPE_HALF;
    const bot = AY + TAPE_HALF;
    g.save();
    g.beginPath();
    g.rect(AL_X0 - 30, top, AL_X1 - AL_X0 + 60, bot - top);
    g.clip();
    g.fillStyle = C.tape;
    g.fillRect(AL_X0, top, AL_X1 - AL_X0, bot - top);
    for (let ft = Math.floor((a - 600) / 100) * 100; ft <= a + 600; ft += 100) {
      const y = yOf(ft);
      line(g, AL_X0, y, AL_X0 + (ft % 500 === 0 ? 24 : 14), y, C.white, 4);
      if (ft % 500 === 0 && ft >= 0) text(g, pad(ft / 100, 2), AL_X0 + 70, y, C.white, 38);
    }
    // the ground below, as a red ribbon, under 570 ft of radio height
    if (s.radioAltFt < 570) {
      const y = yOf(a - s.radioAltFt);
      g.fillStyle = C.red;
      g.fillRect(AL_X1 - 14, y, 14, bot + 20 - y);
      barber(g, AL_X0, y, y + 30, AL_X1 - AL_X0 - 14, C.red, C.tape);
    }
    // the selected altitude, cyan, where it is on the scale
    const ys = yOf(fcu.alt);
    if (ys > top + 30 && ys < bot - 30) {
      g.fillStyle = C.black;
      g.fillRect(AL_X0 + 2, ys - 24, AL_X1 - AL_X0 - 4, 48);
      box(g, AL_X0 + 2, ys - 24, AL_X1 - AL_X0 - 4, 48, C.cyan, 4);
      text(g, String(fcu.alt), (AL_X0 + AL_X1) / 2, ys, C.cyan, 34);
    }
    g.restore();
    line(g, AL_X0, top, AL_X1 + 16, top, C.white, 4);
    line(g, AL_X0, bot, AL_X1 + 16, bot, C.white, 4);
    if (ys <= top + 30) text(g, String(fcu.alt), (AL_X0 + AL_X1) / 2, top - 26, C.cyan, 36);
    else if (ys >= bot - 30) text(g, String(fcu.alt), (AL_X0 + AL_X1) / 2, bot + 28, C.cyan, 36);

    // the altitude window: hundreds and thousands, and the tens on a rolling drum
    const neg = a < 0;
    const abs = Math.abs(a);
    const wx0 = AL_X0 + 18;
    const wx1 = AL_X1 + 54;
    g.fillStyle = C.black;
    g.fillRect(wx0, AY - 34, wx1 - wx0, 68);
    const drumX = AL_X1 - 6;
    g.fillRect(drumX, AY - 58, wx1 - drumX, 116);
    const hundreds = Math.floor(abs / 100);
    text(g, (neg ? '-' : '') + String(hundreds), drumX - 4, AY, C.green, 56, 'right');
    g.save();
    g.beginPath();
    g.rect(drumX, AY - 58, wx1 - drumX, 116);
    g.clip();
    const tens = abs % 100;
    const base = Math.floor(tens / 20) * 20;
    const frac = (tens - base) / 20;
    for (let k = -2; k <= 2; k++) {
      const v = (((base + k * 20) % 100) + 100) % 100;
      text(g, pad(v, 2), (drumX + wx1) / 2, AY + frac * 46 - k * 46, C.green, 40);
    }
    g.restore();
    poly(g, [wx0, AY - 34, drumX, AY - 34, drumX, AY - 58, wx1, AY - 58, wx1, AY + 58, drumX, AY + 58, drumX, AY + 34, wx0, AY + 34], null, C.yellow, 4);

    // the barometric setting
    text(g, 'QNH', (AL_X0 + AL_X1) / 2 - 10, 832, C.white, 32);
    text(g, String(Math.round(d.weather.qnh)), (AL_X0 + AL_X1) / 2 - 10, 872, C.cyan, 36);
  }

  // ---------------------------------------------------------------------------------------------- vertical speed

  private verticalSpeed(g: CanvasRenderingContext2D, s: AircraftState) {
    const x0 = VS_X;
    const x1 = VS_X + 70;
    const top = AY - 262;
    const bot = AY + 262;
    poly(g, [x0, top + 40, x0 + 30, top, x1, top, x1, AY - 70, x1 - 22, AY - 40, x1 - 22, AY + 40, x1, AY + 70, x1, bot, x0 + 30, bot, x0, bot - 40], C.tape);
    // the scale is not linear: 500, 1000, 1500, 2000 and 6000 ft/min
    const marks: [number, number, string][] = [
      [0.5, 70, ''],
      [1, 130, '1'],
      [1.5, 168, ''],
      [2, 206, '2'],
      [6, 252, '6'],
    ];
    line(g, x0 + 4, AY, x0 + 26, AY, C.yellow, 5);
    for (const [, off, label] of marks) {
      for (const sgn of [-1, 1]) {
        const y = AY - sgn * off;
        line(g, x0 + 6, y, x0 + (label ? 24 : 16), y, C.white, 4);
        if (label) text(g, label, x0 + 42, y, C.white, 30);
      }
    }
    const vs = s.vs;
    const off = vsOffset(vs);
    const yv = AY - off;
    const amber = Math.abs(vs) >= 6000 || (s.radioAltFt < 2500 && vs < -2000) || (s.radioAltFt < 1000 && vs < -1200);
    const colour = amber ? C.amber : C.green;
    // the needle points from a pivot off the display's right edge
    const px = 1120;
    const ex = x1 + 6;
    const ey = AY + ((yv - AY) * (ex - px)) / (x0 + 6 - px);
    line(g, x0 + 6, yv, ex, ey, colour, 6);
    if (Math.abs(vs) >= 200) {
      const label = pad(Math.min(99, Math.abs(vs) / 100), 2);
      const ty = clamp(yv + (vs > 0 ? -30 : 30), top + 20, bot - 20);
      g.fillStyle = C.black;
      g.fillRect(x0 + 12, ty - 19, 56, 38);
      text(g, label, x0 + 40, ty, colour, 34);
    }
  }

  // ---------------------------------------------------------------------------------------------- heading

  private headingTape(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s, fcu } = d;
    const h = s.heading;
    const xOf = (deg: number) => AX + angleDiff(deg, h) * HD_K;
    g.save();
    g.beginPath();
    g.rect(SPHERE_X0, HD_Y0, SPHERE_X1 - SPHERE_X0, HD_Y1 - HD_Y0 + 4);
    g.clip();
    g.fillStyle = C.tape;
    g.fillRect(SPHERE_X0, HD_Y0, SPHERE_X1 - SPHERE_X0, HD_Y1 - HD_Y0);
    for (let k = Math.floor((h - 20) / 5) * 5; k <= h + 20; k += 5) {
      const deg = ((k % 360) + 360) % 360;
      const x = xOf(deg);
      const ten = deg % 10 === 0;
      line(g, x, HD_Y0, x, HD_Y0 + (ten ? 22 : 12), C.white, 4);
      if (ten) text(g, pad(deg / 10, 2), x, HD_Y0 + 44, C.white, deg % 30 === 0 ? 38 : 32);
    }
    // the ILS course in magenta, the track as a green diamond
    const ils = ilsShown(d);
    if (ils) {
      const xc = xOf(ils.course);
      line(g, xc, HD_Y0, xc, HD_Y1, C.magenta, 5);
    }
    const xt = xOf(s.track);
    if (!s.onGround || s.gs > 5) poly(g, [xt, HD_Y0 + 2, xt + 11, HD_Y0 + 16, xt, HD_Y0 + 30, xt - 11, HD_Y0 + 16], null, C.green, 4);
    g.restore();
    line(g, SPHERE_X0, HD_Y0, SPHERE_X1, HD_Y0, C.white, 3);
    // the selected heading: cyan, on the tape or written at its end
    if (!lateralManaged(fcu.fma)) {
      const off = angleDiff(fcu.hdg, h);
      if (Math.abs(off) * HD_K < (SPHERE_X1 - SPHERE_X0) / 2 - 12) {
        const x = xOf(fcu.hdg);
        poly(g, [x, HD_Y0 + 2, x - 13, HD_Y0 - 22, x + 13, HD_Y0 - 22], null, C.cyan, 5);
      } else text(g, pad(fcu.hdg, 3), off > 0 ? SPHERE_X1 - 46 : SPHERE_X0 + 46, HD_Y0 - 22, C.cyan, 32);
    }
    // the fixed yellow lubber line
    line(g, AX, HD_Y0 - 30, AX, HD_Y0 + 26, C.yellow, 6);
  }

  // ---------------------------------------------------------------------------------------------- ILS

  private ilsScales(g: CanvasRenderingContext2D, d: CockpitData) {
    const ils = ilsShown(d);
    if (!ils) return;
    // LOC under the sphere, G/S beside it
    const ly = AY + 266;
    const gx = SPHERE_X1 + 40;
    g.strokeStyle = C.white;
    g.lineWidth = 4;
    for (const k of [-2, -1, 1, 2]) {
      g.beginPath();
      g.arc(AX + k * LOC_DOT, ly, 9, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(gx, AY + k * GS_DOT, 9, 0, Math.PI * 2);
      g.stroke();
    }
    line(g, AX, ly - 20, AX, ly + 20, C.yellow, 5);
    line(g, gx - 20, AY, gx + 20, AY, C.yellow, 5);
    if (ils.valid) {
      const lx = AX + clamp(ils.loc, -2.3, 2.3) * LOC_DOT;
      poly(g, [lx - 22, ly, lx, ly - 15, lx + 22, ly, lx, ly + 15], Math.abs(ils.loc) < 2.3 ? C.magenta : null, C.magenta, 4);
      const gy = AY - clamp(ils.gs, -2.3, 2.3) * GS_DOT;
      poly(g, [gx, gy - 22, gx + 15, gy, gx, gy + 22, gx - 15, gy], Math.abs(ils.gs) < 2.3 ? C.magenta : null, C.magenta, 4);
    }
    // the ident, frequency and DME in the bottom-left corner
    text(g, ils.ident, 30, 838, C.magenta, 34, 'left');
    text(g, ils.freq, 30, 876, C.magenta, 34, 'left');
    text(g, ils.valid ? `${ils.dme < 10 ? ils.dme.toFixed(1) : Math.round(ils.dme)}NM` : '---NM', 30, 914, C.magenta, 32, 'left');
  }

  // ---------------------------------------------------------------------------------------------- messages

  private messages(g: CanvasRenderingContext2D, d: CockpitData) {
    const { s } = d;
    if (s.onGround || !isApproach(d.phase)) return;
    const ra = s.radioAltFt;
    const lever = d.controls?.throttle ?? 0;
    if (ra < 25 && lever > 0.03) {
      if (blink(this.t, 1.6)) {
        g.fillStyle = C.black;
        g.fillRect(AX - 110, AY + 112, 220, 50);
        text(g, 'RETARD', AX, AY + 137, C.white, 44, 'center', 700);
      }
    } else if (ra <= (d.dhFt ?? 200) && ra > 25 && s.vs < 0) {
      g.fillStyle = C.black;
      g.fillRect(AX - 120, AY + 112, 240, 50);
      text(g, 'MINIMUM', AX, AY + 137, C.amber, 42, 'center', 700);
    }
  }
}

/** The vertical speed scale's offset (units) for a vertical speed (ft/min). */
function vsOffset(vs: number) {
  const a = Math.min(Math.abs(vs) / 1000, 6.4);
  let off: number;
  if (a <= 1) off = a * 130;
  else if (a <= 2) off = 130 + (a - 1) * 76;
  else off = 206 + ((a - 2) / 4) * 46;
  return Math.sign(vs) * Math.min(off, 258);
}

function speedMark(g: CanvasRenderingContext2D, y: number, letter: string) {
  line(g, SP_X1, y, SP_X1 + 14, y, C.green, 5);
  text(g, letter, SP_X1 + 30, y, C.green, 36);
}

const isApproach = (p: CockpitData['phase']) => p === 'approach' || p === 'final' || p === 'landing';

/** "SPEED SPEED SPEED": low energy on the approach (well below VLS without the thrust to recover). */
function lowEnergy(d: CockpitData) {
  const s = d.s;
  if (s.onGround || s.config < 3 || s.radioAltFt < 100 || s.radioAltFt > 2000) return false;
  const lever = d.controls?.throttle ?? 0.5;
  return s.ias < s.speeds.vls - 4 && s.iasTrend < s.speeds.vls && lever < A320.detents.flx;
}
