// What the flight deck says on its own: the first officer's standard calls on the takeoff and
// landing rolls, the A320's synthetic voice (radio altitude callouts, "RETARD"), the ground
// proximity warning system's modes, the stall and overspeed warnings, and the chimes that go with
// the autopilot and autothrust disconnecting.
//
// GPWS modes, simplified from the EGPWS envelopes but the same logic:
//   1  excessive descent rate          SINK RATE, then PULL UP (with the whoop)
//   2  excessive terrain closure       TERRAIN TERRAIN, then PULL UP
//   3  altitude loss after takeoff     DON'T SINK
//   4  unsafe terrain clearance        TOO LOW GEAR, TOO LOW FLAPS, TOO LOW TERRAIN
//   5  below the glide slope           GLIDESLOPE
//   6  excessive bank angle            BANK ANGLE
// Each alert is said again every couple of seconds while it lasts; the most urgent one wins.

import { A320 } from './a320';
import { isLandMode } from './autopilot';
import { takeoffSpeeds, type FlightPhase, type VSpeeds } from './nav';
import { FO_NAME, type Speech } from './speech';
import type { Sfx } from '../world/audio';
import type { AircraftState, FcuState, IlsReading, Utterance } from './types';

export type AlertKind =
  | 'pull-up'
  | 'terrain'
  | 'too-low-terrain'
  | 'dont-sink'
  | 'sink-rate'
  | 'too-low-gear'
  | 'too-low-flaps'
  | 'glideslope'
  | 'bank-angle'
  | 'stall'
  | 'overspeed'
  | 'config';

/** Most urgent first: the alert said when several are true at once. */
const ALERT_ORDER: AlertKind[] = ['stall', 'pull-up', 'terrain', 'too-low-terrain', 'dont-sink', 'sink-rate', 'too-low-gear', 'too-low-flaps', 'glideslope', 'bank-angle'];

const ALERT_WORDS: Record<Exclude<AlertKind, 'overspeed' | 'config'>, { text: string; say: string; every: number }> = {
  stall: { text: 'STALL, STALL', say: 'stall, stall', every: 1.8 },
  'pull-up': { text: 'WHOOP WHOOP, PULL UP', say: 'pull up', every: 1.6 },
  terrain: { text: 'TERRAIN, TERRAIN', say: 'terrain, terrain', every: 2 },
  'too-low-terrain': { text: 'TOO LOW, TERRAIN', say: 'too low, terrain', every: 2.5 },
  'dont-sink': { text: "DON'T SINK", say: "don't sink", every: 2.2 },
  'sink-rate': { text: 'SINK RATE', say: 'sink rate, sink rate', every: 2.6 },
  'too-low-gear': { text: 'TOO LOW, GEAR', say: 'too low, gear', every: 2.6 },
  'too-low-flaps': { text: 'TOO LOW, FLAPS', say: 'too low, flaps', every: 2.6 },
  glideslope: { text: 'GLIDESLOPE', say: 'glide slope', every: 3 },
  'bank-angle': { text: 'BANK ANGLE, BANK ANGLE', say: 'bank angle, bank angle', every: 2.5 },
};

/** The radio altitude callouts (ft) and their words; 200 is the decision altitude. */
const RA_CALLS: { ft: number; say: string; text: string }[] = [
  { ft: 2500, say: 'twenty-five hundred', text: '2500' },
  { ft: 1000, say: 'one thousand', text: '1000' },
  { ft: 500, say: 'five hundred', text: '500' },
  { ft: 400, say: 'four hundred', text: '400' },
  { ft: 300, say: 'three hundred', text: '300' },
  { ft: 200, say: 'minimum', text: 'MINIMUM' },
  { ft: 100, say: 'one hundred', text: '100' },
  { ft: 50, say: 'fifty', text: '50' },
  { ft: 40, say: 'forty', text: '40' },
  { ft: 30, say: 'thirty', text: '30' },
  { ft: 20, say: 'twenty', text: '20' },
  { ft: 10, say: 'ten', text: '10' },
];

/** Speech latency: callouts are triggered this long before the height, at the current descent rate (s). */
const LEAD_S = 0.3;
const CALLOUT_FROM = 'Auto callout';
const GPWS_FROM = 'GPWS';

const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));
/** Mode 1's SINK RATE and PULL UP boundaries (descent rate, fpm, for a radio height). */
const sinkRateLimit = (ra: number) => (ra < 284 ? 1500 : lerp(1560, 5000, (ra - 284) / (2450 - 284)));
const pullUpLimit = (ra: number) => (ra < 284 ? 1800 : lerp(1710, 7125, (ra - 284) / (2450 - 284)));
/** Mode 6's bank limit: 35° above 150 ft, down to 10° at 30 ft. */
const bankLimit = (ra: number) => (ra >= 150 ? 35 : lerp(10, 35, (ra - 30) / 120));
/** Mode 5's soft GLIDESLOPE boundary (dots below the beam): 1.3 above 150 ft, widening to 2.98 at 30 ft, where the beam converges on its antenna. */
const glideslopeLimit = (ra: number) => (ra >= 150 ? 1.3 : lerp(2.98, 1.3, (ra - 30) / 120));

export class Callouts {
  /** Called once as each alert starts (the scorer counts GPWS warnings: FlightScorer.alert). */
  onAlert: ((kind: AlertKind) => void) | null = null;
  /** The alert sounding now (the PFD's red/amber GPWS and PULL UP lights), and the master warning / caution lights. */
  active: AlertKind | null = null;
  masterWarning = false;
  masterCaution = false;

  private raPrev = Infinity;
  private readonly raFired = new Set<number>();
  private retarding = false;
  private retardClock = 0;
  private sinceTouchdown = Infinity;
  private wasOnGround = true;
  private airborneOnce = false;
  private apPrev = false;
  private athrPrev = false;
  private cautionLeft = 0;
  private alertClock = 0;
  private readonly alertsOn = new Set<AlertKind>();
  private vs: VSpeeds | null = null;
  private readonly called = new Set<string>();
  private gsPrev = 0;
  private decel = 0;
  private closure = 0;
  private maxRaAfterTakeoff = 0;
  private stall = false;
  private overspeed = false;
  private config: string | null = null;
  private crcOn = false;
  private apFlash = 0;
  private readonly later: { at: number; u: Utterance }[] = [];

  constructor(
    private readonly speech: Speech,
    private readonly sfx: Sfx,
  ) {}

  /**
   * Every frame in flight. `throttle` is the thrust levers' position (Controls.throttle) when the
   * caller has it: "RETARD" is called until the levers reach idle; without it the autothrust's
   * state and N1 tell.
   */
  update(dt: number, s: AircraftState, fcu: FcuState, ils: IlsReading | null, phase: FlightPhase, throttle?: number) {
    if (dt <= 0) return;
    this.flush(dt);
    const ra = s.radioAltFt;
    const air = !s.onGround;
    const sink = Math.max(0, -s.vs);

    // touchdown and liftoff
    if (s.onGround && !this.wasOnGround) {
      this.sinceTouchdown = 0;
      this.called.delete('spoilers');
    }
    if (!s.onGround && this.wasOnGround) this.maxRaAfterTakeoff = 0;
    this.wasOnGround = s.onGround;
    if (air) this.airborneOnce = true;
    this.sinceTouchdown += dt;

    // a smoothed terrain closure rate (fpm), and the ground roll's deceleration (m/s²)
    if (Number.isFinite(this.raPrev) && air) this.closure += ((((this.raPrev - ra) / dt) * 60 - this.closure) * Math.min(1, dt * 2));
    this.decel += (((this.gsPrev - s.gs) * 0.514444) / dt - this.decel) * Math.min(1, dt * 3);
    this.gsPrev = s.gs;

    this.takeoffCalls(s, phase);
    this.landingRollCalls(s, phase);
    this.radioAltitude(dt, s, fcu, phase, throttle);
    this.raPrev = ra;
    this.chimes(dt, s, fcu);
    this.warnings(s);
    this.configWarning(s, phase);

    // GPWS: work out which alerts are true now, then say the most urgent one
    const on = this.alertsOn;
    on.clear();
    if (air && ra > 30 && ra < 2450) {
      if (sink > pullUpLimit(ra)) on.add('pull-up');
      else if (sink > sinkRateLimit(ra)) on.add('sink-rate');
      const landingConfig = s.gear > 0.99 && s.config >= 4;
      if (!landingConfig && ra < 1650 && this.closure > 2000 + ra * 4.7) on.add(this.closure > 3000 + ra * 5.5 ? 'pull-up' : 'terrain');
      if ((phase === 'takeoff' || phase === 'climb') && ra < 1500) {
        this.maxRaAfterTakeoff = Math.max(this.maxRaAfterTakeoff, ra);
        if (this.maxRaAfterTakeoff - ra > 10 + 0.1 * this.maxRaAfterTakeoff && s.vs < 0) on.add('dont-sink');
      }
      const departing = phase === 'takeoff' || phase === 'climb';
      if (!departing && ra < 500) {
        if (s.gear < 0.99) on.add(s.ias < 190 ? 'too-low-gear' : 'too-low-terrain');
        else if (ra < 245 && s.config < 4 && s.ias < 159) on.add('too-low-flaps');
      }
      if (ils?.valid && s.gear > 0.99 && ra < 1000 && ils.gs > glideslopeLimit(ra) && !departing) on.add('glideslope');
    }
    if (air && ra > 5 && Math.abs(s.bank) > bankLimit(ra)) on.add('bank-angle');
    if (s.stallWarning) on.add('stall');

    let top: AlertKind | null = null;
    for (const k of ALERT_ORDER)
      if (on.has(k)) {
        top = k;
        break;
      }
    this.alertClock -= dt;
    if (top !== this.active) {
      if (top && (this.active === null || ALERT_ORDER.indexOf(top) < ALERT_ORDER.indexOf(this.active) || !on.has(this.active))) {
        this.onAlert?.(top);
        this.alertClock = 0;
      }
      this.active = top;
      if (!top) this.speech.cancelWhere((u) => u.from === GPWS_FROM);
    }
    if (this.active && this.active !== 'overspeed' && this.active !== 'config' && this.alertClock <= 0) {
      const w = ALERT_WORDS[this.active];
      this.alertClock = w.every;
      if (this.active === 'pull-up') this.sfx.whoop();
      this.say({ speaker: 'gpws', from: GPWS_FROM, text: w.text, say: w.say, priority: 3 }, this.active === 'pull-up' ? 0.85 : 0);
    }
  }

  // ---------------------------------------------------------------------------------------------- the rolls

  private takeoffCalls(s: AircraftState, phase: FlightPhase) {
    if (phase !== 'takeoff') {
      if (phase === 'taxi-out' && s.gs < 30) {
        // a rejected takeoff re-arms the calls for the next attempt
        for (const k of ['100', 'v1', 'rotate', 'positive']) this.called.delete(k);
        this.vs = null;
      }
      return;
    }
    if (s.onGround && !this.vs && s.ias > 40) this.vs = takeoffSpeeds(s.mass);
    const v = this.vs;
    if (s.onGround && s.ias >= 100) this.fo('100', 'One hundred knots', 'one hundred knots');
    if (v && s.onGround && s.ias >= v.v1) this.fo('v1', 'V1', 'vee one');
    if (v && s.ias >= v.vr && this.called.has('v1')) this.fo('rotate', 'Rotate', 'rotate');
    if (!s.onGround && s.vs > 200 && s.radioAltFt > 20) this.fo('positive', 'Positive climb', 'positive climb');
  }

  private landingRollCalls(s: AircraftState, phase: FlightPhase) {
    if (!s.onGround || !this.airborneOnce || (phase !== 'landing' && phase !== 'rollout')) return;
    if (this.sinceTouchdown < 2.5 && s.spoilers > 0.5) this.fo('spoilers', 'Spoilers', 'spoilers');
    else if (this.sinceTouchdown >= 2.5 && !this.called.has('spoilers') && s.gs > 60) this.fo('spoilers', 'No spoilers', 'no spoilers');
    if (s.reverser > 0.9) this.fo('reverse', 'Reverse green', 'reverse green');
    if (this.sinceTouchdown < 8 && this.decel > 1.5 && s.gs > 60) this.fo('decel', 'Decel', 'decel');
    if (s.ias < 70 && this.called.has('spoilers') && s.gs > 20) this.fo('70', 'Seventy knots', 'seventy knots');
  }

  /** A first officer's standard call, once per flight leg. */
  private fo(key: string, text: string, say: string) {
    if (this.called.has(key)) return;
    this.called.add(key);
    this.speech.say({ speaker: 'fo', from: FO_NAME, text, say, priority: 2 });
  }

  // ---------------------------------------------------------------------------------------------- radio altitude

  private radioAltitude(dt: number, s: AircraftState, fcu: FcuState, phase: FlightPhase, throttle?: number) {
    const ra = s.radioAltFt;
    const descending = s.vs < -50;
    const arriving = phase === 'descent' || phase === 'approach' || phase === 'final' || phase === 'landing';
    const lead = (Math.max(0, -s.vs) / 60) * LEAD_S;
    for (const c of RA_CALLS) {
      // re-armed once well above the height again (a go-around)
      if (ra > c.ft + Math.max(60, c.ft * 0.2)) this.raFired.delete(c.ft);
      if (this.raFired.has(c.ft) || s.onGround || !descending || !arriving) continue;
      if (this.raPrev > c.ft + lead && ra <= c.ft + lead) {
        this.raFired.add(c.ft);
        // a newer callout makes any still waiting stale
        this.speech.cancelWhere((u) => u.from === CALLOUT_FROM);
        this.say({ speaker: 'gpws', from: CALLOUT_FROM, text: c.text, say: c.say, priority: 2 });
        // (an autoland retards at 10 ft)
        if (c.ft === (isLandMode(fcu.fma.vertical) ? 10 : 20) && !this.leversIdle(s, fcu, throttle)) {
          this.retarding = true;
          this.retardClock = 0.35;
        }
      }
    }
    if (this.retarding) {
      if (this.leversIdle(s, fcu, throttle) || (s.onGround && this.sinceTouchdown > 2) || ra > 80) this.retarding = false;
      else {
        this.retardClock -= dt;
        if (this.retardClock <= 0) {
          this.retardClock = 1.1;
          this.say({ speaker: 'gpws', from: CALLOUT_FROM, text: 'RETARD', say: 'retard, retard', priority: 2 });
        }
      }
    }
  }

  private leversIdle(s: AircraftState, fcu: FcuState, throttle?: number) {
    if (throttle !== undefined) return throttle <= 0.02;
    if (fcu.athr && fcu.fma.thrust !== 'THR IDLE' && fcu.fma.thrust !== 'none') return false;
    return (s.n1[0] + s.n1[1]) / 2 < A320.n1Idle + 0.08;
  }

  // ---------------------------------------------------------------------------------------------- chimes and warnings

  private chimes(dt: number, s: AircraftState, fcu: FcuState) {
    // the autopilot disconnecting: the cavalry charge, the master warning lit for a moment
    if (this.apPrev && !fcu.ap) {
      this.sfx.cavalryCharge();
      this.apFlash = 1.6;
    }
    // the autothrust disconnecting in flight: a single chime and the master caution
    if (this.athrPrev && !fcu.athr && !s.onGround && s.radioAltFt > 50) {
      this.sfx.masterCaution();
      this.cautionLeft = Math.max(this.cautionLeft, 3);
    }
    this.apPrev = fcu.ap;
    this.athrPrev = fcu.athr;
    this.cautionLeft = Math.max(0, this.cautionLeft - dt);
    this.masterCaution = this.cautionLeft > 0;
    this.apFlash = Math.max(0, this.apFlash - dt);
    this.masterWarning = this.crcOn || this.apFlash > 0;
  }

  private warnings(s: AircraftState) {
    if (s.stallWarning !== this.stall) {
      this.stall = s.stallWarning;
      this.sfx.stallCricket(this.stall);
    }
    if (s.overspeed !== this.overspeed) {
      this.overspeed = s.overspeed;
      this.sfx.overspeedClacker(this.overspeed);
      if (this.overspeed) this.onAlert?.('overspeed');
    }
    this.syncMasterWarning();
  }

  /** The takeoff configuration warning: takeoff thrust set with the aircraft not configured for it. */
  private configWarning(s: AircraftState, phase: FlightPhase) {
    const thrust = (s.n1[0] + s.n1[1]) / 2 > 0.7;
    let msg: string | null = null;
    if (s.onGround && thrust && (phase === 'taxi-out' || phase === 'takeoff') && s.ias < 100) {
      if (s.config === 0 || s.config >= 5) msg = 'CONFIG FLAPS NOT IN T.O. CONFIG';
      else if (s.spoilers > 0.1) msg = 'CONFIG SPD BRK NOT RETRACTED';
    }
    if (msg !== this.config) {
      this.config = msg;
      if (msg) {
        this.onAlert?.('config');
        this.speech.say({ speaker: 'gpws', from: 'ECAM', text: msg, say: '', priority: 2 });
      }
      this.syncMasterWarning();
    }
  }

  /** The continuous repetitive chime sounds with the overspeed and the configuration warnings. */
  private syncMasterWarning() {
    const on = this.overspeed || this.config !== null;
    if (on !== this.crcOn) {
      this.crcOn = on;
      this.sfx.masterWarning(on);
    }
    this.masterWarning = this.crcOn || this.apFlash > 0;
  }

  private say(u: Utterance, delayS = 0) {
    if (delayS <= 0) this.speech.say(u);
    else this.later.push({ at: delayS, u });
  }

  /** Say the lines held back a moment (PULL UP after its whoop). */
  private flush(dt: number) {
    for (let i = this.later.length - 1; i >= 0; i--) {
      this.later[i].at -= dt;
      if (this.later[i].at <= 0) {
        this.speech.say(this.later[i].u);
        this.later.splice(i, 1);
      }
    }
  }
}
