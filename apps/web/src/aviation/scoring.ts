// The flight's score: 100 points to start with, lost to what an airline's flight-data monitoring
// would flag (a hard landing, a tailstrike, flying too fast low down, a steep bank, a stall
// warning, a GPWS warning, an ATC violation, arriving late), a bonus for a smooth flight, and a
// separate comfort score from what the passengers felt. A crash or a ditching fails the flight.
//
// FlightScorer watches the AircraftState every frame and takes the flight model's events. The
// flight's controller feeds it ATC's violations (runway incursions, landing without clearance) and
// the GPWS alerts (Callouts.onAlert), calls finish() when the aircraft is parked (or the taxi-in
// skipped), and shows debrief() on the results card; stats() are the round's stat keys.

import { A320 } from './a320';
import { AIRFIELDS, runwayFrame, taxiRoute, nearestNode, type RunwayEnd } from './airports';
import { KT, regionAt } from '../world/geo';
import { phaseIndex, vfeFor, type Navigator } from './nav';
import type { AircraftState, CrashReason, FcuState, FdmEvent, ScoreItem } from './types';

export type FailReason = CrashReason | 'runway-incursion';

/** Landing rate bands (fpm, upper bound) and what they cost. */
const LANDING_BANDS: { below: number; points: number; label: string }[] = [
  { below: 120, points: 0, label: 'Butter-smooth landing' },
  { below: 240, points: 5, label: 'Firm landing' },
  { below: 360, points: 10, label: 'Heavy landing' },
  { below: 600, points: 20, label: 'Hard landing' },
  { below: Infinity, points: 40, label: 'Very hard landing' },
];

/**
 * The load factor the cabin feels, smoothed over this long (s): the seat and the body take out the
 * turbulence's quick buzz (the flight model's specific force at each substep), which an airline's
 * flight-data monitoring filters out as well; a pull, a push or a sustained turn still counts in full.
 */
const NZ_SMOOTH_S = 0.4;

/** Speed tolerance before the 250 kt rule counts (an autothrust holding 250 wanders a knot or two), and how long. */
const SPEED_LIMIT_TOL = 5;
const SPEED_LIMIT_HOLD_S = 3;
/**
 * The schedule's padding over the plan's block time (s). flightPlan() already counts the pushback,
 * the taxi both ways, the takeoff run, the air time and the landing roll; the airline pads that by
 * a couple of minutes for a wait at the holding point or a slow taxi. A tidy flight arrives on
 * time and a dawdling one (or one that goes around) is late.
 */
export const SCHEDULE_PAD_S = 120;

/**
 * The most stars a flight can earn with each landing band (the same order as LANDING_BANDS): a
 * five-star flight can't have a heavy landing on its list, whatever the points say.
 */
const LANDING_STAR_CAP = [5, 5, 4, 3, 2] as const;

const FAIL_TEXT: Record<FailReason, string> = {
  impact: 'the aircraft struck the ground',
  ditching: 'the aircraft ditched in the sea',
  'gear-collapse': 'the landing gear collapsed',
  'belly-landing': 'a wheels-up landing',
  wingstrike: 'a wing struck the ground',
  'runway-excursion': 'the aircraft ran off the runway',
  overspeed: 'structural overspeed',
  obstacle: 'the aircraft hit an obstacle',
  'runway-incursion': 'a runway incursion into the path of traffic',
};

/** A limit that costs points once each time it is exceeded, until the aircraft is back inside it for a while. */
class Excursion {
  private on = false;
  private quiet = 0;
  constructor(private readonly settleS = 2) {}
  /** True the moment the limit is first exceeded. */
  check(over: boolean, inside: boolean, dt: number) {
    if (over) {
      this.quiet = 0;
      if (this.on) return false;
      this.on = true;
      return true;
    }
    if (this.on && inside) {
      this.quiet += dt;
      if (this.quiet >= this.settleS) this.on = false;
    }
    return false;
  }
}

/** What the touchdown was like (the landing's numbers for the debrief and the stats). */
export interface LandingReport {
  fpm: number;
  g: number;
  /** Metres off the centreline (+ right), metres past the threshold, crab angle (deg), the runway. */
  centrelineM: number;
  touchdownM: number;
  crabDeg: number;
  runway: string;
  airport: string;
  bounced: boolean;
}

export class FlightScorer {
  readonly items: ScoreItem[] = [];
  /** The landing, once the main gear has touched down after the takeoff. */
  landing: LandingReport | null = null;
  private failure: FailReason | null = null;
  private t = 0;
  private finished = false;

  // the flight's numbers
  private blockS = 0;
  private airS = 0;
  private distM = 0;
  private maxAltFt = -Infinity;
  private topKt = 0;
  private maxG = 1;
  private minG = 1;
  private maxBank = 0;
  private airborneOnce = false;
  private sinceTouchdown = Infinity;
  private bounceAirS = 0;
  private delayS = 0;

  // comfort: accumulated discomfort, the worst jolt, and the landing's share
  private discomfort = 0;
  private worstJolt = 0;
  private landingDiscomfort = 0;

  // rules that count once per excursion or once per interval
  private bankItem: ScoreItem | null = null;
  private readonly vmoEx = new Excursion(5);
  private readonly flapEx = new Excursion(3);
  private readonly gearEx = new Excursion(3);
  private readonly stallEx = new Excursion(5);
  private lastG = -Infinity;
  /** The smoothed load factor (see NZ_SMOOTH_S). */
  private nzF = 1;
  private lastSpeed = -Infinity;
  private speedOver = 0;
  private readonly lastAlert = new Map<string, number>();
  private lastStrike = -Infinity;

  constructor(private readonly nav: Navigator) {}

  /** The scheduled gate-to-gate time (s): the plan's block time and the schedule's padding. */
  get scheduleS() {
    return this.nav.plan.blockTimeS + SCHEDULE_PAD_S;
  }

  /** Gate-to-gate time so far (s, from the pushback). */
  get blockTimeS() {
    return this.blockS;
  }

  /** Why the flight failed, or null. */
  get failed(): FailReason | null {
    return this.failure;
  }

  update(dt: number, s: AircraftState, _fcu: FcuState) {
    if (this.failure || this.finished || dt <= 0) return;
    this.t += dt;
    const phase = this.nav.phase;
    if (phaseIndex(phase) >= phaseIndex('pushback')) {
      this.blockS += dt;
      this.distM += s.gs * KT * dt;
    }
    const air = !s.onGround;
    if (air) {
      this.airborneOnce = true;
      this.airS += dt;
    }
    this.sinceTouchdown += dt;
    this.maxAltFt = Math.max(this.maxAltFt, s.altFt);
    this.topKt = Math.max(this.topKt, s.ias);

    // a bounce: airborne again for a moment after the first touchdown
    if (this.landing && !this.landing.bounced) {
      this.bounceAirS = air && s.radioAltFt > 4 ? this.bounceAirS + dt : 0;
      if (this.bounceAirS > 0.5 && this.sinceTouchdown < 8) {
        this.landing.bounced = true;
        this.landingDiscomfort += 6;
        this.penalise('Bounced landing', 5, this.t);
      }
    }

    this.nzF += (s.nz - this.nzF) * Math.min(1, dt / NZ_SMOOTH_S);
    if (air && this.sinceTouchdown > 1.5) {
      const nz = this.nzF;
      this.maxG = Math.max(this.maxG, nz);
      this.minG = Math.min(this.minG, nz);
      this.maxBank = Math.max(this.maxBank, Math.abs(s.bank));
      this.worstJolt = Math.max(this.worstJolt, Math.abs(nz - 1));

      // passengers feel load factor, side force, steep banks and big pitch attitudes
      const ge = Math.max(0, Math.abs(nz - 1) - 0.08);
      const be = Math.max(0, Math.abs(s.bank) - 30);
      const pe = Math.max(0, s.pitch - 20) + Math.max(0, -s.pitch - 8);
      this.discomfort += (ge * ge * 12 + be * 0.04 + pe * 0.05) * dt;

      // bank angle: 35° costs 5 points, 45° in the same excursion makes it 10
      const bank = Math.abs(s.bank);
      if (bank > 35 && !this.bankItem) this.bankItem = this.penalise('Bank angle beyond 35°', 5, this.t);
      if (bank > 45 && this.bankItem && this.bankItem.points > -10) {
        this.bankItem.label = 'Bank angle beyond 45°';
        this.bankItem.points = -10;
      }
      if (bank < 30) this.bankItem = null;

      // load factor: more than 0.3 g off 1 g costs 5 points, at most once every 20 s
      if (Math.abs(nz - 1) > 0.3 && this.t - this.lastG >= 20) {
        this.lastG = this.t;
        this.penalise(`Uncomfortable load factor (${nz.toFixed(2)} g)`, 5, this.t);
      }

      // the 250 kt speed limit below 10,000 ft, at most once every 30 s
      this.speedOver = s.altFt < 10000 && s.ias > A320.speedLimitLow + SPEED_LIMIT_TOL ? this.speedOver + dt : 0;
      if (this.speedOver > SPEED_LIMIT_HOLD_S && this.t - this.lastSpeed >= 30) {
        this.lastSpeed = this.t;
        this.penalise(`Above 250 kt below 10,000 ft (${Math.round(s.ias)} kt)`, 5, this.t);
      }
    }
    // side force bothers people on the ground too: taxiing round a corner too fast
    const ye = Math.max(0, Math.abs(s.ny) - 0.04);
    this.discomfort += ye * ye * 40 * dt;

    // VMO / MMO
    // (the model's overspeed flag also counts VFE and VLE, which have their own items below)
    const overVmo = s.ias > A320.vmo || s.mach > A320.mmo;
    if (this.vmoEx.check(overVmo, s.ias < A320.vmo - 5 && s.mach < A320.mmo - 0.01, dt)) this.penalise(`Overspeed beyond VMO/MMO (${Math.round(s.ias)} kt)`, 15, this.t);

    // flaps and gear beyond their limiting speeds (VFE, VLE, VLO while moving)
    const vfe = vfeFor(s.config);
    if (this.flapEx.check(air && s.config > 0 && s.ias > vfe + 3, s.config === 0 || s.ias < vfe - 2, dt)) this.penalise(`Flap overspeed (${Math.round(s.ias)} kt, VFE ${vfe})`, 10, this.t);
    const gearMoving = s.gear > 0.02 && s.gear < 0.98;
    const vGear = gearMoving ? Math.min(A320.vlo.extend, A320.vlo.retract) : A320.vle;
    if (this.gearEx.check(air && s.gear > 0.02 && s.ias > vGear + 3, s.gear <= 0.02 || s.ias < vGear - 2, dt)) this.penalise(`Gear overspeed (${Math.round(s.ias)} kt)`, 10, this.t);

    // stall warning and alpha floor
    if (this.stallEx.check(air && (s.stallWarning || s.alphaFloor), !s.stallWarning && !s.alphaFloor, dt)) this.penalise(s.stallWarning ? 'Stall warning' : 'Alpha floor (protection triggered)', 15, this.t);
  }

  event(e: FdmEvent, s: AircraftState) {
    if (this.failure || this.finished) return;
    switch (e.kind) {
      case 'crash':
        this.fail(e.reason, this.t);
        break;
      case 'tailstrike':
        if (this.t - this.lastStrike > 3) this.penalise(`Tailstrike (${e.pitch.toFixed(1)}° pitch)`, 30, this.t);
        this.lastStrike = this.t;
        break;
      case 'podstrike':
        this.penalise(`Engine pod strike (${e.side === 'L' ? 'left' : 'right'})`, 40, this.t);
        break;
      case 'wingstrike':
        this.penalise(`Wingtip strike (${e.side === 'L' ? 'left' : 'right'})`, 40, this.t);
        break;
      case 'touchdown':
        this.touchdown(e, s);
        break;
      case 'liftoff':
      case 'gearLocked':
        break;
    }
  }

  /** Take points off (`points` is the cost, positive). Returns the item, which may be revised. */
  penalise(label: string, points: number, t: number = this.t): ScoreItem {
    const item = { label, points: -Math.abs(points), at: t };
    this.items.push(item);
    return item;
  }

  bonus(label: string, points: number, t: number = this.t): ScoreItem {
    const item = { label, points: Math.abs(points), at: t };
    this.items.push(item);
    return item;
  }

  /** A GPWS alert from Callouts.onAlert: 10 points per kind, at most once every 30 s (bank angle has its own rule). */
  alert(kind: string, t: number = this.t) {
    if (this.failure || this.finished || kind === 'bank-angle' || kind === 'stall' || kind === 'overspeed') return;
    const last = this.lastAlert.get(kind) ?? -Infinity;
    if (t - last < 30) return;
    this.lastAlert.set(kind, t);
    // the takeoff configuration warning comes from the ECAM, not the GPWS, but costs the same
    this.penalise(kind === 'config' ? 'Takeoff configuration warning' : `GPWS warning: ${kind.replace(/-/g, ' ').toUpperCase()}`, 10, t);
  }

  /** An ATC violation (Atc.onViolation): its cost, and whether it ends the flight. */
  violation(label: string, points: number, t: number = this.t, fatal?: FailReason) {
    if (this.failure || this.finished) return;
    this.penalise(label, points, t);
    if (fatal) this.fail(fatal, t);
  }

  /** End the flight as failed. */
  fail(reason: FailReason, t: number = this.t) {
    if (this.failure) return;
    this.failure = reason;
    this.items.push({ label: `Flight failed: ${FAIL_TEXT[reason]}`, points: -100, at: t });
  }

  /**
   * The flight is over (parked at the stand, or the taxi-in skipped): the delay against the plan's
   * block time (a skipped taxi-in counts the time it would have taken) and the smooth-flight bonus.
   */
  finish(s: AircraftState) {
    if (this.finished) return;
    if (!this.failure) {
      let block = this.blockS;
      if (this.nav.phase !== 'parked') block += this.taxiInLeftS(s);
      this.delayS = Math.max(0, block - this.scheduleS);
      const late = Math.min(15, Math.floor(this.delayS / 60) * 3);
      if (late > 0) this.penalise(`Late arrival (${Math.floor(this.delayS / 60)} min behind schedule)`, late, this.t);
      if (this.landing && this.landing.fpm < 200 && this.comfort() >= 90) this.bonus('Smooth flight', 5, this.t);
    }
    this.finished = true;
  }

  /** 0..100 (0 if the flight failed). */
  score() {
    if (this.failure) return 0;
    let p = 100;
    for (const i of this.items) p += i.points;
    return Math.max(0, Math.min(100, Math.round(p)));
  }

  /** Passenger comfort 0..100: load factor, side force, bank and pitch, the worst jolt and the touchdown. */
  comfort() {
    if (this.failure) return 0;
    const jolt = 12 * Math.max(0, this.worstJolt - 0.35);
    return Math.max(0, Math.min(100, Math.round(100 - this.discomfort - jolt - this.landingDiscomfort)));
  }

  stars(): 1 | 2 | 3 | 4 | 5 {
    const sc = this.score();
    if (this.failure) return 1;
    const byScore = sc >= 90 ? 5 : sc >= 75 ? 4 : sc >= 55 ? 3 : sc >= 35 ? 2 : 1;
    return Math.min(byScore, this.starCap()) as 1 | 2 | 3 | 4 | 5;
  }

  /**
   * The most stars the itemised list allows: the landing's band (heavy 4, hard 3, very hard 2), a
   * bounce 4, and a strike (tail, pod or wingtip) 3, so the stars never contradict the debrief.
   */
  private starCap(): number {
    let cap = 5;
    const l = this.landing;
    if (l) {
      const band = LANDING_BANDS.findIndex((b) => l.fpm < b.below);
      cap = Math.min(cap, LANDING_STAR_CAP[band < 0 ? LANDING_STAR_CAP.length - 1 : band]);
      if (l.bounced) cap = Math.min(cap, 4);
    }
    if (this.items.some((i) => /^(Tailstrike|Engine pod strike|Wingtip strike)/.test(i.label))) cap = Math.min(cap, 3);
    return cap;
  }

  /** The round's stats (SPEC §3's flight keys). The landing's keys are only there if it landed. */
  stats(): Record<string, number> {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const out: Record<string, number> = {
      score: this.score(),
      stars: this.stars(),
      comfort: this.comfort(),
      flightTimeS: Math.round(this.airS),
      delayS: Math.round(this.delayS),
      distanceM: Math.round(this.distM),
      maxAltitudeFt: Math.round(Number.isFinite(this.maxAltFt) ? this.maxAltFt : 0),
      topSpeedKt: Math.round(this.topKt),
      maxG: r2(this.maxG),
      minG: r2(this.minG),
      maxBankDeg: Math.round(this.maxBank),
      violations: this.items.filter((i) => i.points < 0).length,
    };
    if (this.landing && !this.failure) {
      out.landingFpm = Math.round(this.landing.fpm);
      out.landingG = r2(this.landing.g);
      out.centrelineM = r1(Math.abs(this.landing.centrelineM));
      out.touchdownM = Math.round(this.landing.touchdownM);
    }
    return out;
  }

  /** The flight report for the results card. */
  debrief(): { title: string; lines: string[] } {
    const plan = this.nav.plan;
    const to = AIRFIELDS[plan.to].geo.name;
    const lines: string[] = [];
    const title = this.failure
      ? `Flight failed: ${FAIL_TEXT[this.failure]}`
      : `${'★'.repeat(this.stars())}${'☆'.repeat(5 - this.stars())} ${this.verdict()} to ${to}`;
    lines.push(`Score ${this.score()} / 100 · passenger comfort ${this.comfort()} %`);
    const l = this.landing;
    if (l && !this.failure) {
      const side = Math.abs(l.centrelineM) < 0.5 ? 'on the centreline' : `${Math.abs(l.centrelineM).toFixed(1)} m ${l.centrelineM > 0 ? 'right' : 'left'} of the centreline`;
      lines.push(`Touchdown on runway ${l.runway}: ${Math.round(l.fpm)} fpm, ${l.g.toFixed(2)} g, ${Math.round(l.touchdownM)} m past the threshold, ${side}${l.bounced ? ', bounced' : ''}`);
    }
    const mins = (sec: number) => `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, '0')} s`;
    lines.push(`Flight time ${mins(this.airS)} · ${(this.distM / 1000).toFixed(1)} km · highest ${Math.round(Math.max(0, this.maxAltFt)).toLocaleString('en-GB')} ft · fastest ${Math.round(this.topKt)} kt`);
    if (this.finished && !this.failure) lines.push(this.delayS >= 60 ? `Arrived ${Math.floor(this.delayS / 60)} min late` : 'Arrived on time');
    for (const i of this.items) {
      if (i.points === 0) lines.push(`· ${i.label}`);
      else lines.push(`${i.points > 0 ? '+' : '−'}${Math.abs(i.points)}  ${i.label}`);
    }
    if (!this.items.some((i) => i.points < 0) && !this.failure) lines.push('No penalties: a textbook flight.');
    return { title, lines };
  }

  // ---------------------------------------------------------------------------------------------- internals

  /** The title's word for the flight, from its stars (so the two always agree). */
  private verdict() {
    return ['Eventful flight', 'Rough flight', 'Safe flight', 'Good flight', 'Superb flight'][this.stars() - 1];
  }

  private touchdown(e: Extract<FdmEvent, { kind: 'touchdown' }>, s: AircraftState) {
    if (!this.airborneOnce) return;
    // only the first touchdown after the takeoff is the landing; later ones are bounces (counted in update)
    if (this.landing) {
      this.sinceTouchdown = 0;
      return;
    }
    if (e.gear === 'nose') {
      this.penalise('Nose wheel touched down first', 10, this.t);
      // the mains will follow: the landing is scored when they do
      return;
    }
    this.sinceTouchdown = 0;
    const fpm = Math.abs(e.vsFpm);
    const rw = this.runwayAt(e.pos.x, e.pos.z, s.track);
    const fr = runwayFrame(rw.end, e.pos.x, e.pos.z);
    this.landing = { fpm, g: e.g, centrelineM: fr.right, touchdownM: fr.along, crabDeg: e.crabDeg, runway: rw.end.ident, airport: rw.airport, bounced: false };
    this.maxG = Math.max(this.maxG, e.g);

    // off the pavement is not a landing: the ground before the threshold, the grass, the sand
    if (e.surface !== 'runway' && e.surface !== 'water') {
      this.fail('impact', this.t);
      return;
    }
    const band = LANDING_BANDS.find((b) => fpm < b.below)!;
    if (band.points) this.penalise(`${band.label} (${Math.round(fpm)} fpm)`, band.points, this.t);
    else this.items.push({ label: `${band.label} (${Math.round(fpm)} fpm)`, points: 0, at: this.t });
    this.landingDiscomfort = Math.min(40, Math.max(0, fpm - 150) / 18);

    const tdz = rw.end.tdz;
    if (fr.along < 0) this.penalise(`Touched down before the threshold (${Math.round(-fr.along)} m short)`, 20, this.t);
    else if (fr.along < tdz.from) this.penalise(`Short of the touchdown zone (${Math.round(fr.along)} m)`, 5, this.t);
    else if (fr.along > tdz.to) this.penalise(`Long landing (${Math.round(fr.along)} m past the threshold)`, 15, this.t);
    if (Math.abs(fr.right) > 8) this.penalise(`Off the centreline (${Math.abs(fr.right).toFixed(1)} m)`, 10, this.t);
    if (Math.abs(e.crabDeg) > 5) this.penalise(`Landed in a crab (${Math.abs(e.crabDeg).toFixed(0)}°)`, 10, this.t);
  }

  /** The runway end being landed on: the arrival's, or wherever the aircraft came down (back at the departure, say). */
  private runwayAt(x: number, z: number, track: number): { end: RunwayEnd; airport: string } {
    const ap = AIRFIELDS[regionAt(x, z)];
    const r27 = ap.runways['27'];
    const r09 = ap.runways['09'];
    const d27 = Math.abs(((((track - r27.heading) % 360) + 540) % 360) - 180);
    const d09 = Math.abs(((((track - r09.heading) % 360) + 540) % 360) - 180);
    return { end: d27 <= d09 ? r27 : r09, airport: ap.geo.icao };
  }

  /** How long the taxi-in would still take from here to the stand, at a steady 15 kt (s). */
  private taxiInLeftS(s: AircraftState) {
    const ap = this.nav.arrival;
    const from = nearestNode(ap, s.pos.x, s.pos.z, ['taxiway', 'lane', 'runway']);
    const route = taxiRoute(ap, from.id, ap.playerStand, true);
    const m = (route?.lengthM ?? 1500) + Math.hypot(from.x - s.pos.x, from.z - s.pos.z);
    return m / (15 * KT);
  }
}
