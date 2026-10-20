// The flight itself, without a screen: the A320's flight model, the autopilot, the navigation,
// ATC, the cabin crew, the GPWS callouts, the score and the radio, run gate to gate in the order
// the aviation modules agreed on (nav → autopilot → flight model → ATC → cabin → callouts → score,
// then the speech once a frame), plus everything the crew does that isn't flying: the automatic
// pushback with the engines started on the way, the taxi routes and their guide, the stop bar,
// the hand-offs to the AI traffic, parking at the stand, and the failures.
//
// FlightSim is driven the same way in the game (world/attractions/flight.ts feeds it the visitor's
// keys and touches through `pilot` and the autopilot) and in node (scripts/flight-check.mjs feeds
// it a scripted crew, flight/crew.ts), so the whole flight can be checked without a browser.

import { A320 } from '../../aviation/a320';
import { AIRFIELDS, onRunway, runwayFrame, type Airport, type RunwayEnd, type Stand } from '../../aviation/airports';
import { Atc, type RunwayStatus } from '../../aviation/atc';
import { Autopilot, type ApEvent } from '../../aviation/autopilot';
import { Cabin } from '../../aviation/cabin';
import { Callouts } from '../../aviation/callouts';
import { FlightModel } from '../../aviation/fdm';
import { Navigator, phaseIndex } from '../../aviation/nav';
import { FlightScorer, type FailReason } from '../../aviation/scoring';
import { Speech } from '../../aviation/speech';
import { Air } from '../../aviation/weather';
import { neutralControls, type AircraftState, type Controls, type FdmEvent, type GroundQuery, type ScoreItem, type Utterance } from '../../aviation/types';
import { Path, stopSpeed, type Pose2 } from '../airport/airside-path';
import { headingVec, regionAt, type Region } from '../geo';
import type { Sfx } from '../audio';
import type { FlightInfo } from './booking';
import { TaxiPath, emptyGuide, type TaxiGuideInfo } from './taxi';

/** Where the flight is, beyond the navigator's phase: what the crew are doing on the ground. */
export type Stage = 'boarding' | 'stand' | 'push' | 'taxi' | 'flight' | 'taxi-in' | 'parking' | 'deplaning' | 'done' | 'failed';

/** What the AI traffic tells the flight (aviation/traffic.ts implements it). */
export interface SimTraffic {
  runwayBusy(region: Region): RunwayStatus;
  holdForPlayer(region: Region, on: boolean): void;
  /** No new arrivals at the destination while the player is cleared in (descent or approach, until landed or abandoned). */
  holdArrivals?(region: Region, on: boolean): void;
}

export interface FlightSimOptions {
  info: FlightInfo;
  ground: GroundQuery;
  sfx: Sfx;
  traffic?: SimTraffic | null;
  /** Speak aloud (speechSynthesis) as well as showing the lines. */
  speak?: boolean;
  /**
   * The radio's voice, kept by the screen from one flight to the next (each Speech listens for the
   * browser's voices for good, so a new one per flight would pile up listeners); a new one if absent.
   */
  speech?: Speech;
}

/** The next thing to do, for the HUD: what, and the key that does it on a keyboard. */
export interface Hint {
  text: string;
  keys?: string;
}

/** The pushback's speed (m/s) and how long the tug takes to get hold of the nose wheel before it pushes. */
const PUSH_V = 1.4;
const TUG_WAIT_S = 5;
/** After the push: the ground crew's goodbye, before the taxi can start. */
const DISCONNECT_S = 4;
/** Parked: engines off this long after the brake is set, then the doors open. */
const SHUTDOWN_S = 4;
const AFTERMATH_S = 10;
const DEPLANE_S = 10;
/** Time warp only cruising (AP on, above this height, no alert sounding). */
export const WARP_MIN_FT = 2000;
/** The thrust levers count as in a detent within this much of it. */
const DETENT_TOL = 0.03;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class FlightSim {
  readonly info: FlightInfo;
  readonly from: Region;
  readonly to: Region;
  readonly dep: Airport;
  readonly arr: Airport;
  readonly depStand: Stand;
  readonly arrStand: Stand;
  readonly depRw: RunwayEnd;
  readonly arrRw: RunwayEnd;

  readonly air: Air;
  readonly fm: FlightModel;
  readonly nav: Navigator;
  readonly ap: Autopilot;
  readonly speech: Speech;
  readonly atc: Atc;
  readonly cabin: Cabin;
  readonly callouts: Callouts;
  readonly scorer: FlightScorer;
  /** What the pilot commands (the visitor's keys and touches, or the scripted crew): the autopilot's axes replace theirs when engaged. */
  readonly pilot: Controls = neutralControls();
  /** What the flight model got this frame (the pilot's controls with the automatics in place). */
  readonly controls: Controls = neutralControls();

  stage: Stage = 'boarding';
  /** Seconds in the current stage (simulated). */
  stageT = 0;
  /** Simulated seconds since the round began, and real seconds (time warp makes them differ). */
  t = 0;
  realT = 0;
  /** ×1, ×2 or ×4 (cruise only). */
  warp = 1;
  /** Whether the radio and the cabin speak aloud (otherwise their lines are text only). */
  voices = false;
  /** The taxi route being followed, what it's for, and its guide. */
  route: TaxiPath | null = null;
  routeKind: 'out' | 'lineup' | 'in' | null = null;
  readonly guide: TaxiGuideInfo = emptyGuide();
  /** The departure's holding point stop bar is lit (until the line-up clearance). */
  holdRed = true;
  /** Why the flight failed, once it has. */
  failure: FailReason | null = null;
  /** The pushback: the tug has hold of the aircraft and is moving it now. */
  towing = false;
  /** The visitor skipped the taxi-in (the aircraft was put on the stand). */
  skippedTaxiIn = false;

  /** Hooks for the screen. */
  onStage: ((stage: Stage, prev: Stage) => void) | null = null;
  /** A score item as it happens (a penalty, a bonus, the landing's verdict). */
  onScore: ((item: ScoreItem) => void) | null = null;
  /** The flight model's events (touchdowns, strikes, the crash), after the scorer has seen them. */
  onEvent: ((e: FdmEvent) => void) | null = null;
  /** Something worth a toast that isn't a score item ("Autopilot off", "Parking brake released"). */
  onNote: ((text: string) => void) | null = null;
  /** The tug: whether it has the nose wheel yet (the screen's tug drives up to it), and the pose to push the aircraft along. */
  pushReady: (() => boolean) | null = null;
  /** Whether the passengers are all off (the screen's travellers); without it, deplaning takes DEPLANE_S. */
  deplaneDone: (() => boolean) | null = null;
  /** ATC's clearances as they're given (the screen lights the greens, the stop bars, the ILS guide). */
  onClearance: ((kind: string) => void) | null = null;

  private readonly traffic: SimTraffic | null;
  private pushPath: Path | null = null;
  private pushS = 0;
  private pushEndS = 0;
  private readonly pose: Pose2 = { x: 0, z: 0, heading: 0 };
  private engineStarts = 0;
  private scoreSeen = 0;
  private holdDep = false;
  private holdArr = false;
  /** The destination holds its new arrivals for the player (from the descent or approach clearance until landed). */
  private seqArr = false;
  private parkFrom: Pose2 | null = null;
  private wasOnGround = true;
  private apEngagedOnce = false;
  private lastGoArounds = 0;
  /** The go-around the FCU's modes were last set up for (nav.goArounds), and the levers' last frame, for TOGA's edge. */
  private gaModes = 0;
  /** Where radar sent the aircraft after the go-around (the clearance's directTo holds the arrival's earlier one until then). */
  private missedDirect: string | null = null;
  private wasToga = false;
  /** The reference point's velocity after the last flight-model step, for the load factors (not valid after a tow). */

  constructor(o: FlightSimOptions) {
    const info = o.info;
    this.info = info;
    this.from = info.from;
    this.to = info.to;
    this.dep = AIRFIELDS[info.from];
    this.arr = AIRFIELDS[info.to];
    this.depStand = this.dep.stands.find((s) => s.id === this.dep.playerStand)!;
    this.arrStand = this.arr.stands.find((s) => s.id === this.arr.playerStand)!;
    this.traffic = o.traffic ?? null;

    this.air = new Air(info.weather, o.ground, info.seed);
    this.fm = new FlightModel({ ground: o.ground, air: this.air });
    this.fm.setLoad(info.passengers, A320.blockFuel);
    this.nav = new Navigator(info.plan);
    this.nav.setArrivalWind(info.weather.windFrom, info.weather.windKt);
    this.depRw = this.nav.departureRunway;
    this.arrRw = this.nav.arrivalRunway;
    this.ap = new Autopilot(this.nav);
    this.speech = o.speech ?? new Speech(o.sfx);
    this.speech.cancel();
    this.speech.log.length = 0;
    this.speech.lastCut = null;
    this.voices = o.speak ?? false;
    this.speech.enabled = this.voices;
    this.scorer = new FlightScorer(this.nav);
    this.cabin = new Cabin(this.speech, o.sfx, this.nav, info.flightNo, { hour: info.hour, weather: info.weather, passengers: info.passengers });
    this.callouts = new Callouts(this.speech, o.sfx);
    this.callouts.onAlert = (k) => this.scorer.alert(k);

    // on the stand, cold and dark: the parking brake set, the FCU set up for the departure
    const st = this.depStand;
    this.fm.placeOnGround(st.x, st.z, st.heading);
    Object.assign(this.pilot, neutralControls());
    this.pilot.parkingBrake = true;
    this.nav.phase = 'boarding';
    this.ap.setAlt(info.plan.cruiseFt);
    this.ap.setHdg(this.depRw.heading);
    this.ap.setSpd(null);
    this.ap.pushHdg();

    // ATC: the ATIS and the IFR clearance play while the passengers board
    this.atc = new Atc(this.speech, this.nav, info.weather, {
      callsign: info.callsign,
      flightNo: info.flightNo,
      runwayBusy: (r) => this.traffic?.runwayBusy(r) ?? { busy: false, clearInS: 0 },
      hour: info.hour,
      // the AI traffic says its own lines (hear()); ATC only adds the radar's
      chatter: this.traffic ? 'radar' : 'all',
    });
    this.atc.onViolation = (label, pts, fatal) => this.scorer.violation(label, pts, undefined, fatal);
    this.atc.onClearance = (k) => this.clearance(k);
    this.ap.onEvent = (e) => this.apEvent(e);
  }

  get state(): AircraftState {
    return this.fm.state;
  }

  /** Whether the round has finished (parked and off, or the failure's aftermath over). */
  get finished() {
    return this.stage === 'done';
  }

  /** The flight failed (crash, ditching, incursion): the score is 0. */
  get failed() {
    return this.failure !== null;
  }

  /** Landed at the destination and off the runway (taxiing in, parked or done) without failing: the visitor has arrived. */
  get arrived() {
    const st = this.stage;
    return !this.failed && (st === 'taxi-in' || st === 'parking' || st === 'deplaning' || st === 'done');
  }

  // ---------------------------------------------------------------------------------------------- the visitor's requests

  /**
   * The action key (E): the radio call that comes next — pushback, taxi, ready for departure — or
   * skipping the taxi-in after landing. Boarding and deplaning are skipped by the screen (it owns
   * the passengers). Returns what was asked for, or null.
   */
  action(): string | null {
    if (this.stage === 'boarding' || this.stage === 'deplaning' || this.stage === 'done' || this.stage === 'failed') return null;
    const next = this.atc.nextRequest;
    if (!next) return null;
    if (next === 'takeoff' && this.stage !== 'taxi') return null;
    if (next === 'skip-taxi-in') {
      this.atc.request('skip-taxi-in');
      return next;
    }
    this.atc.request(next);
    return next;
  }

  /** Boarding's progress 0..1 (the screen's travellers): the cabin crew's announcements, and the doors close at 1. */
  boarding(progress: number) {
    if (this.stage !== 'boarding') return;
    this.cabin.boarding(Math.min(1, progress));
    if (progress >= 1) this.setStage('stand');
  }

  /** Cycle the time warp (×1 → ×2 → ×4), where it's allowed. */
  cycleWarp() {
    if (!this.warpAllowed()) {
      this.warp = 1;
      return this.warp;
    }
    this.warp = this.warp === 1 ? 2 : this.warp === 2 ? 4 : 1;
    return this.warp;
  }

  /** Time warp is for the long, quiet parts: the cruise on the autopilot above 2,000 ft, and the pushback. */
  warpAllowed() {
    const s = this.fm.state;
    if (this.stage === 'push') return true;
    if (this.stage !== 'flight') return false;
    const p = phaseIndex(this.nav.phase);
    return this.ap.fcu.ap && !s.onGround && s.altFt > WARP_MIN_FT && p >= phaseIndex('climb') && p <= phaseIndex('approach') && !this.callouts.active && !this.callouts.masterWarning;
  }

  /** Another aircraft's radio line (Traffic.onRadioAt): heard if it's on the frequency the crew are on. */
  hear(u: Utterance, region: Region | null, station: 'tower' | 'ground' | 'radar' | 'pilot') {
    const name = this.atc.station.name;
    const tuned = /Radar/.test(name) ? 'radar' : /Tower/.test(name) ? 'tower' : /Ground/.test(name) ? 'ground' : null;
    if (!tuned) return;
    if (tuned === 'radar') {
      // the radar sector is the sea between the airports: its lines (and the replies to them) come with no airport
      if (region !== null) return;
    } else {
      if (station !== 'pilot' && station !== tuned) return;
      if (region !== regionAt(this.fm.state.pos.x, this.fm.state.pos.z)) return;
    }
    this.speech.say(u);
  }

  // ---------------------------------------------------------------------------------------------- the frame

  /**
   * One frame of `dt` real seconds. `pilotInput` moves `pilot` (and may use the autopilot's
   * buttons) between the navigation's update and the autopilot's, so every input is seen this
   * frame. With time warp the simulation runs several steps of `dt`, and the radio keeps pace with it as
   * text only (voices can't be sped up, and a clearance held back four times as long arrives too late).
   */
  step(dt: number, pilotInput?: (dt: number) => void) {
    if (dt <= 0) return;
    if (this.warp > 1 && !this.warpAllowed()) {
      this.warp = 1;
      this.onNote?.('Time warp off');
    }
    const n = this.warp;
    for (let i = 0; i < n; i++) this.tick(dt, pilotInput);
    this.speech.enabled = this.voices && n === 1;
    this.speech.update(dt * n);
    this.realT += dt;
  }

  private tick(dt: number, pilotInput?: (dt: number) => void) {
    const s = this.fm.state;
    const fcu = this.ap.fcu;
    this.t += dt;
    this.stageT += dt;
    this.nav.update(dt, s);
    this.beforeControls(dt);
    pilotInput?.(dt);
    this.assist();
    const ctl = this.ap.update(dt, s, this.pilot, this.controls);
    // The model deploys armed ground spoilers whenever the levers are at idle on the ground, which on the
    // real aircraft needs the wheels spinning above 72 kt. Taxiing with them armed (the before-takeoff
    // flow) would otherwise pop them at the first idle, and the armed autobrake would then hold the
    // aircraft still. Below 30 kt before takeoff the arming is withheld from the model.
    if ((this.stage === 'stand' || this.stage === 'push' || this.stage === 'taxi' || this.stage === 'boarding') && s.gs < 31) ctl.spoilersArmed = false;
    if (this.towing || this.parkFrom) {
      if (this.towing) this.tow(dt);
      else this.slideOntoStand(dt);
    } else {
      // (the load factors the scorer, the cabin and the PFD read are the flight model's own)
      const events = this.fm.step(dt, ctl);
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        this.scorer.event(e, s);
        this.onEvent?.(e);
      }
    }
    this.atc.update(dt, s, fcu);
    this.cabin.update(dt, s);
    this.callouts.update(dt, s, fcu, this.nav.ils(s), this.nav.phase, this.pilot.throttle);
    this.scorer.update(dt, s, fcu);
    this.afterStep();
  }

  // ---------------------------------------------------------------------------------------------- the ground crew and the automatics

  /** What happens before the pilot's inputs: the push, the stage's own clock. */
  private beforeControls(_dt: number) {
    const s = this.fm.state;
    const st = this.stage;
    if (st === 'push' && !this.towing && this.pushPath && this.pushS === 0 && (this.pushReady?.() ?? this.stageT > TUG_WAIT_S)) {
      // the tug has the nose wheel: brakes off, and back we go (engine 2 first, as Airbus crews do)
      this.towing = true;
      this.pilot.parkingBrake = false;
      this.fm.startEngine(1);
      this.engineStarts = 1;
      this.speech.say({ speaker: 'atc', from: 'Ground crew', text: 'Brakes released, pushing back. Clear to start engines.', priority: 1 });
    }
    // the second engine once the first is at idle
    if (this.engineStarts === 1 && this.fm.sys.engineRunning[1]) {
      this.fm.startEngine(0);
      this.engineStarts = 2;
    }
    if (st === 'taxi' && this.stageT > DISCONNECT_S && this.engineStarts < 2 && this.fm.sys.engineRunning[1]) {
      this.fm.startEngine(0);
      this.engineStarts = 2;
    }
    if (st === 'parking' && this.stageT > SHUTDOWN_S * 0.5 && (s.n1[0] > 0 || s.n1[1] > 0) && this.fm.sys.engineRunning[0]) {
      this.fm.stopEngine(0);
      this.fm.stopEngine(1);
    }
  }

  /** Help the crew with what a real one wouldn't have to think about. */
  private assist() {
    const p = this.pilot;
    const s = this.fm.state;
    // thrust up with the parking brake still set, cleared to taxi: the first officer lets it off
    if (p.parkingBrake && (this.stage === 'taxi' || this.stage === 'taxi-in') && p.throttle > 0.08 && this.stageT > DISCONNECT_S && (this.atc.clearance.taxi || this.stage === 'taxi-in')) {
      p.parkingBrake = false;
      this.say('fo', 'Parking brake released.');
      this.onNote?.('Parking brake released');
    }
    // parked, pushed or failed: the brakes hold it
    if (this.stage === 'parking' || this.stage === 'deplaning' || this.stage === 'done' || this.stage === 'boarding' || this.stage === 'stand') {
      p.parkingBrake = true;
      p.throttle = 0;
      p.reverse = 0;
    }
    // alpha floor's TOGA LK holds TOGA until the autothrust is switched off: with the levers back in
    // the CL detent, clear of the ground, the first officer resets it (off and on again)
    if (this.ap.fcu.fma.thrust === 'TOGA LK' && !s.alphaFloor && s.radioAltFt > 1000 && Math.abs(p.throttle - A320.detents.cl) < DETENT_TOL) {
      this.ap.toggleAthr();
      this.ap.toggleAthr();
      this.say('fo', 'TOGA lock cleared, autothrust back on.');
      this.onNote?.('Autothrust reset');
    }
    if (this.stage === 'failed') {
      p.throttle = 0;
      p.brakeL = p.brakeR = 1;
      p.reverse = 0;
    }
  }

  private tow(dt: number) {
    const path = this.pushPath!;
    const left = this.pushEndS - this.pushS;
    const v = Math.min(PUSH_V, Math.max(0.12, stopSpeed(left, 0.2)), 0.2 + this.stageT * 0.12);
    this.pushS = Math.min(this.pushEndS, this.pushS + v * dt);
    path.at(this.pushS, this.pose);
    // tail first: the aircraft faces against the way it's pushed
    this.fm.tow(this.pose.x, this.pose.z, (this.pose.heading + 180) % 360, dt);
    if (this.pushS >= this.pushEndS - 0.02) {
      this.towing = false;
      this.pilot.parkingBrake = true;
      this.setStage('taxi');
      this.speech.say({ speaker: 'atc', from: 'Ground crew', text: 'Pushback complete, set the parking brake. Disconnecting now, have a good flight!', priority: 1 });
    }
  }

  /** Where the tug holds the aircraft now (the screen's tug follows it). */
  get pushPose(): Pose2 | null {
    if (!this.towing) return null;
    return this.pose;
  }

  /** The last metres onto the stand, as the marshaller waves it in: eased onto the stop mark. */
  private slideOntoStand(dt: number) {
    const f = this.parkFrom!;
    const st = this.arrStand;
    const k = clamp(this.stageT / 2.5, 0, 1);
    const e = k * k * (3 - 2 * k);
    const dh = ((((st.heading - f.heading) % 360) + 540) % 360) - 180;
    this.fm.tow(f.x + (st.x - f.x) * e, f.z + (st.z - f.z) * e, (f.heading + dh * e + 360) % 360, dt);
    if (k >= 1) this.parkFrom = null;
  }

  private afterStep() {
    const s = this.fm.state;
    const phase = this.nav.phase;
    const p = phaseIndex(phase);

    // the score's new items, for the toasts
    const items = this.scorer.items;
    while (this.scoreSeen < items.length) this.onScore?.(items[this.scoreSeen++]);

    // failure: the flight model's crash, or ATC's runway incursion with traffic
    if (this.stage !== 'failed' && this.stage !== 'done') {
      const why = this.fm.crashed ?? this.scorer.failed;
      if (why) {
        this.failure = why;
        this.scorer.fail(why);
        this.warp = 1;
        this.route = null;
        this.routeKind = null;
        this.speech.cancel(3);
        this.releaseRunways();
        this.setStage('failed');
        return;
      }
    }

    // the taxi route and its guide
    if (this.route) {
      this.route.track(s.pos.x, s.pos.z);
      this.route.guide(s.gs, this.guide);
    }

    switch (this.stage) {
      case 'taxi':
        if (p >= phaseIndex('takeoff') && (!s.onGround || s.ias > 50)) {
          this.route = null;
          this.routeKind = null;
          this.setStage('flight');
        }
        break;
      case 'flight':
        if (!s.onGround && !this.wasOnGround && s.radioAltFt > 600 && this.holdDep) {
          this.holdDep = false;
          this.traffic?.holdForPlayer(this.from, false);
        }
        if (phase === 'taxi-in' || (p >= phaseIndex('rollout') && s.onGround && !onRunway(this.arr, s.pos.x, s.pos.z, 2))) this.setStage('taxi-in');
        break;
      case 'taxi-in': {
        if (this.holdArr && !onRunway(this.arr, s.pos.x, s.pos.z, 20)) {
          this.holdArr = false;
          this.traffic?.holdForPlayer(this.to, false);
        }
        if (this.seqArr) {
          this.seqArr = false;
          this.traffic?.holdArrivals?.(this.to, false);
        }
        const st = this.arrStand;
        const near = Math.hypot(s.pos.x - st.x, s.pos.z - st.z);
        const aligned = Math.abs(((((s.heading - st.heading) % 360) + 540) % 360) - 180) < 25;
        if (phase === 'parked' || (near < 9 && aligned && s.gs < 3)) this.park(false);
        break;
      }
      case 'parking':
        if (this.stageT > SHUTDOWN_S && !this.parkFrom) this.setStage('deplaning');
        break;
      case 'deplaning':
        if (this.deplaneDone ? this.deplaneDone() : this.stageT > DEPLANE_S) this.setStage('done');
        break;
      case 'failed':
        if (this.stageT > AFTERMATH_S) this.setStage('done');
        break;
    }
    // TOGA on the approach is a go-around (the navigator itself only sees one once the aircraft climbs,
    // and with the approach modes still engaged the autopilot would hold the glide slope under TOGA thrust)
    const toga = this.pilot.throttle >= A320.detents.toga - DETENT_TOL;
    if (toga && !this.wasToga && this.stage === 'flight' && !s.onGround) {
      const approaching = phase === 'final' || phase === 'landing' || (phase === 'approach' && !this.nav.goingAround && s.config >= 1);
      if (approaching) this.nav.goAround();
    }
    this.wasToga = toga;
    if (this.nav.goArounds > this.gaModes && this.stage === 'flight') this.goAroundModes();
    if (this.nav.goArounds > this.lastGoArounds) {
      this.lastGoArounds = this.nav.goArounds;
      this.onNote?.('Going around');
    }
    this.wasOnGround = s.onGround;
  }

  /**
   * A go-around, however it began (TOGA, alpha floor, a touch-and-go, ATC's order): the FCU as the
   * real one sets itself, SRS and GA TRK, here an open climb to the missed approach altitude on the
   * runway heading, with the localizer and the glide slope disarmed so the autopilot lets go of
   * them; and the first officer takes the flaps up one step. The approach is armed again once ATC
   * clears it (the hint says when).
   */
  private goAroundModes() {
    this.gaModes = this.nav.goArounds;
    this.missedDirect = null;
    const ap = this.ap;
    const fcu = ap.fcu;
    const s = this.fm.state;
    if (fcu.appr) ap.pushAppr();
    else if (fcu.loc) ap.pushLoc();
    ap.setHdg(this.arrRw.heading);
    ap.pullHdg();
    ap.setAlt(this.nav.nextAltitude(s) ?? 3000);
    ap.pullAlt();
    ap.setSpd(null);
    const p = this.pilot;
    if (p.flapLever >= 2) {
      p.flapLever -= 1;
      this.say('fo', `Go around, flaps ${p.flapLever}.`);
    } else this.say('fo', 'Go around.');
  }

  /** On the stand at the destination: brakes, engines off, the score's final word. */
  private park(skipped: boolean) {
    if (this.stage === 'parking' || this.stage === 'deplaning' || this.stage === 'done') return;
    const s = this.fm.state;
    const st = this.arrStand;
    this.route = null;
    this.routeKind = null;
    this.warp = 1;
    this.releaseRunways();
    // the score first: a skipped taxi-in still counts the time it would have taken
    this.scorer.finish(s);
    if (skipped) {
      this.skippedTaxiIn = true;
      this.fm.placeOnGround(st.x, st.z, st.heading, { enginesRunning: true });
    } else if (Math.hypot(s.pos.x - st.x, s.pos.z - st.z) > 0.3) this.parkFrom = { x: s.pos.x, z: s.pos.z, heading: s.heading };
    const p = this.pilot;
    Object.assign(p, { throttle: 0, reverse: 0, brakeL: 0, brakeR: 0, parkingBrake: true, flapLever: 0, speedbrake: 0, spoilersArmed: false, autobrake: 'off', pitch: 0, roll: 0, yaw: 0, tiller: 0 });
    if (this.ap.fcu.athr) this.ap.toggleAthr();
    this.nav.phase = 'parked';
    this.cabin.arrived();
    this.say('fo', 'Parking brake set. Engines off, seatbelt sign off.');
    this.setStage('parking');
  }

  private releaseRunways() {
    if (this.holdDep) this.traffic?.holdForPlayer(this.from, false);
    if (this.holdArr) this.traffic?.holdForPlayer(this.to, false);
    if (this.seqArr) this.traffic?.holdArrivals?.(this.to, false);
    this.holdDep = this.holdArr = this.seqArr = false;
  }

  /**
   * Stop everything (the round ends early: Esc). Leaving while taxiing in still counts as arrived,
   * as a skipped taxi-in would: the score's final word (with the taxi time left) is had now.
   */
  abandon() {
    if (this.stage === 'taxi-in' && !this.failed) this.scorer.finish(this.fm.state);
    this.releaseRunways();
    this.speech.cancel();
    this.route = null;
    this.warp = 1;
  }

  private setStage(st: Stage) {
    const prev = this.stage;
    if (prev === st) return;
    this.stage = st;
    this.stageT = 0;
    if (st === 'stand') this.say('fo', 'Boarding complete, doors closed. Ready when you are, Captain.');
    this.onStage?.(st, prev);
  }

  private say(speaker: 'fo' | 'captain', text: string) {
    this.speech.say({ speaker, from: speaker === 'fo' ? 'First Officer' : 'Captain', text, priority: 0 });
  }

  // ---------------------------------------------------------------------------------------------- ATC

  private clearance(kind: string) {
    const c = this.atc.clearance;
    switch (kind) {
      case 'pushback': {
        if (this.stage !== 'stand') break;
        const st = this.depStand;
        const end = st.pushEnd[this.atc.pushFace];
        // tail first out of the stand, swinging onto the lane (the leg on past the end keeps the turn round)
        const ex = end.x + (end.x - st.x);
        this.pushPath = new Path([{ x: st.x, z: st.z }, { x: st.x, z: end.z }, { x: ex, z: end.z }], 40);
        this.pushEndS = this.pushPath.length - Math.abs(ex - end.x);
        this.pushS = 0;
        this.nav.phase = 'pushback';
        this.setStage('push');
        break;
      }
      case 'taxi':
        if (c.taxi) {
          this.route = new TaxiPath(this.dep, c.taxi.route);
          this.routeKind = 'out';
        }
        break;
      case 'lineup':
      case 'takeoff': {
        this.holdRed = false;
        if (!this.holdDep) {
          this.holdDep = true;
          this.traffic?.holdForPlayer(this.from, true);
        }
        if (this.routeKind !== 'lineup' && phaseIndex(this.nav.phase) < phaseIndex('takeoff')) {
          const e = this.atc.entry;
          const rn = this.dep.nodes[e.runway];
          const f = headingVec(this.depRw.heading);
          this.route = new TaxiPath(this.dep, [e.hold, e.runway], [{ x: rn.x + f.x * 300, z: rn.z + f.z * 300 }]);
          this.routeKind = 'lineup';
        }
        // the takeoff's FCU: runway heading, NAV armed, managed speed and climb
        this.ap.setHdg(this.depRw.heading);
        break;
      }
      case 'descent':
      case 'approach':
        // cleared in: the destination sequences its arrivals round the player from here on
        if (!this.seqArr) {
          this.seqArr = true;
          this.traffic?.holdArrivals?.(this.to, true);
        }
        if (kind === 'descent') break;
        // cleared for the approach again after a go-around: the missed approach is over. The
        // navigator would otherwise keep the missed approach altitude as the managed descent's
        // target until established, holding the aircraft at it all the way to the localizer.
        if (this.nav.goingAround) this.nav.goingAround = false;
        break;
      case 'land':
        if (!this.holdArr) {
          this.holdArr = true;
          this.traffic?.holdForPlayer(this.to, true);
        }
        break;
      case 'go-around':
        if (this.holdArr) {
          this.holdArr = false;
          this.traffic?.holdForPlayer(this.to, false);
        }
        break;
      case 'direct':
        // round again after a go-around: from the runway heading onto the plan (NAV) to the fix
        if (this.nav.goingAround) this.missedDirect = c.directTo;
        if (this.nav.goingAround && this.ap.fcu.fma.lateral === 'HDG') {
          this.ap.pushHdg();
          this.onNote?.(`NAV: direct ${c.directTo ?? ''}`.trim());
        }
        break;
      case 'taxi-in':
        if (c.taxiIn && this.stage === 'taxi-in') {
          this.route = new TaxiPath(this.arr, c.taxiIn.route);
          this.routeKind = 'in';
        }
        break;
      case 'skip-taxi-in':
        if (phaseIndex(this.nav.phase) >= phaseIndex('rollout') && this.stage !== 'failed') this.park(true);
        break;
    }
    this.onClearance?.(kind);
  }

  private apEvent(e: ApEvent) {
    const s = this.fm.state;
    if (e === 'ap-on') this.apEngagedOnce = true;
    if (e === 'ap-off' && this.apEngagedOnce && !s.onGround) this.onNote?.(s.radioAltFt < 400 ? 'Autopilot off: you have control. Land it!' : 'Autopilot off');
    if (e === 'a-floor') this.onNote?.('Alpha floor: TOGA thrust');
  }

  // ---------------------------------------------------------------------------------------------- what the screen shows

  /** The next thing to do (the HUD's hint line). */
  hint(): Hint | null {
    const s = this.fm.state;
    const fcu = this.ap.fcu;
    const p = this.pilot;
    const phase = this.nav.phase;
    const next = this.atc.nextRequest;
    switch (this.stage) {
      case 'boarding':
        return { text: 'Passengers boarding · skip', keys: 'E' };
      case 'stand':
        return next === 'pushback' ? { text: 'Request pushback and start-up', keys: 'E' } : { text: 'Listening to the ATIS and the IFR clearance…' };
      case 'push':
        return { text: this.towing ? `Pushing back · engines starting (${this.fm.sys.engineRunning.filter(Boolean).length}/2)` : 'The tug is connecting…', keys: this.warp === 1 ? 'T' : undefined };
      case 'taxi': {
        if (!this.fm.sys.engineRunning[0] || !this.fm.sys.engineRunning[1]) return { text: 'Starting engines…' };
        const c = this.atc.clearance;
        if (!c.taxi) return next === 'taxi' ? { text: 'Request taxi', keys: 'E' } : { text: 'Waiting for Ground…' };
        if (c.takeoff) {
          if (this.routeKind === 'lineup' && this.route && this.route.along < this.route.lengthM - 260) return { text: 'Line up on the centreline', keys: 'A D' };
          return p.throttle < A320.detents.flx - 0.02 ? { text: 'Cleared for takeoff: thrust levers TOGA', keys: 'Y' } : { text: `Rotate at ${Math.round(this.nav.vSpeeds.vr)} kt: pull back gently`, keys: 'S' };
        }
        if (c.lineUp) return { text: 'Line up and wait: stop on the centreline' };
        const hold = this.dep.nodes[c.taxi.holdShort];
        const dHold = Math.hypot(s.pos.x - hold.x, s.pos.z - hold.z);
        if (next === 'takeoff' && dHold < 220) return { text: 'Hold short of the red stop bar · ready for departure', keys: 'E' };
        if (dHold < 120) return { text: 'Holding short: wait for the tower' };
        if (p.parkingBrake) return { text: 'Thrust up a little to start rolling', keys: 'PgUp' };
        return { text: `Taxi to holding point ${c.taxi.holdShort.replace(/^H/, '')}: follow the green lights`, keys: 'A D' };
      }
      case 'flight': {
        const vs = this.nav.vSpeeds;
        if (phase === 'takeoff' || phase === 'taxi-out') {
          if (s.onGround) return s.ias < vs.vr - 5 ? { text: `Takeoff roll · rotate at ${Math.round(vs.vr)} kt` } : { text: 'Rotate: pull back gently', keys: 'S' };
          if (s.gear > 0.5 && p.gearDown) return { text: 'Positive climb: gear up', keys: 'G' };
          if (!fcu.ap && s.radioAltFt > 100) return { text: 'Engage the autopilot (or follow the flight director bars)', keys: 'P' };
          if (this.ap.lvrClb) return { text: 'Thrust levers to CL', keys: 'U' };
          return { text: 'Climbing out: follow the flight director' };
        }
        if (this.ap.lvrClb) return { text: 'Thrust levers to CL', keys: 'U' };
        if (p.gearDown && s.gear > 0.5 && phaseIndex(phase) < phaseIndex('approach')) return { text: 'Gear up', keys: 'G' };
        if (this.nav.goingAround && phase === 'approach') {
          // round again: clean up, climb, and fly what ATC says until the next approach clearance (which
          // ends the missed approach). The gear comes up from 500 ft: GPWS (aviation/callouts.ts) calls
          // TOO LOW GEAR below that outside the departure, go-around climbs included.
          if (p.gearDown && s.gear > 0.5 && s.vs > 300 && s.radioAltFt > 500) return { text: 'Positive climb: gear up', keys: 'G' };
          if (p.flapLever > 0 && s.ias > (p.flapLever >= 2 ? s.speeds.f : s.speeds.s) + 5) return { text: 'Flaps up one step', keys: 'F' };
          const cl = Math.abs(p.throttle - A320.detents.cl) < DETENT_TOL;
          if (!cl && (fcu.fma.thrust === 'TOGA LK' || (p.throttle > A320.detents.cl && s.radioAltFt > 1500))) return { text: 'Thrust levers to CL', keys: 'U' };
          if (!fcu.ap && s.radioAltFt > 100) return { text: 'Engage the autopilot (or follow the flight director bars)', keys: 'P' };
          const c = this.atc.clearance;
          if (this.missedDirect) return { text: `Going around: direct ${this.missedDirect} for another approach` };
          // until ATC's readback the clearance still holds the approach's altitude: the missed
          // approach's own (as set on the FCU) on the runway heading
          const alt = c.heading !== null ? c.altitudeFt : (this.nav.nextAltitude(s) ?? 3000);
          const hdg = c.heading ?? this.arrRw.heading;
          return { text: `Going around: climb to ${alt.toLocaleString('en-GB')} ft, heading ${String(Math.round(hdg) % 360 || 360).padStart(3, '0')}` };
        }
        if (phase === 'climb' || phase === 'cruise') {
          if (p.flapLever > 0 && s.ias > s.speeds.s) return { text: 'Retract the flaps', keys: 'F' };
          if (!fcu.athr) return { text: 'Engage the autothrust', keys: '⇧P' };
          if (!fcu.ap) return { text: 'Engage the autopilot', keys: 'P' };
          if (this.warpAllowed() && this.warp === 1) return { text: `${phase === 'cruise' ? 'Cruising' : 'Climbing'} to ${this.arr.geo.name} · time warp`, keys: 'T' };
          return { text: phase === 'cruise' ? `Cruising at ${Math.round(this.info.plan.cruiseFt).toLocaleString('en-GB')} ft to ${this.arr.geo.name}` : 'Climbing on the flight plan' };
        }
        if (phase === 'descent') return fcu.ap ? { text: 'Descending: the autopilot follows the plan' } : { text: 'Descend to 3,000 ft' };
        if (phase === 'approach' || phase === 'final') {
          if (!fcu.appr && !fcu.loc && fcu.fma.lateral !== 'LOC' && fcu.fma.vertical !== 'G/S') return { text: 'Arm the ILS approach (APPR)', keys: 'K' };
          const want = s.ias < s.speeds.greenDot + 10 ? 1 : 0;
          if (p.flapLever < want && p.flapLever === 0) return { text: 'Flaps 1', keys: 'V' };
          if (p.flapLever === 1 && s.ias < s.speeds.s + 10) return { text: 'Flaps 2', keys: 'V' };
          if (!p.gearDown && (fcu.fma.vertical === 'G/S' || fcu.fma.vertical === 'G/S*' || s.radioAltFt < 2000)) return { text: 'Gear down', keys: 'G' };
          if (p.flapLever === 2 && p.gearDown) return { text: 'Flaps 3', keys: 'V' };
          if (p.flapLever === 3 && s.radioAltFt < 1800) return { text: 'Flaps FULL', keys: 'V' };
          if (!p.spoilersArmed) return { text: 'Arm the ground spoilers', keys: '⇧/' };
          if (!fcu.ap && s.radioAltFt < 250) return { text: 'Flare at 30 ft: ease back, thrust idle', keys: 'S J' };
          return { text: fcu.ap ? 'Established: the autopilot hands over at 200 ft' : 'Follow the flight director to the runway' };
        }
        if (phase === 'landing') return s.onGround ? { text: 'Reverse thrust and brakes', keys: 'R B' } : { text: 'Flare: ease back, thrust idle', keys: 'S J' };
        if (phase === 'rollout') {
          if (s.gs > 40) return { text: 'Reverse thrust and brakes', keys: 'R B' };
          const v = this.atc.clearance.vacate;
          return v ? { text: `Vacate via ${v} · or skip the taxi-in`, keys: 'E' } : { text: 'Slow to taxi speed' };
        }
        return null;
      }
      case 'taxi-in':
        if (!this.atc.clearance.taxiIn) return { text: 'Vacate the runway · or skip the taxi-in', keys: 'E' };
        return { text: `Taxi to stand ${this.arrStand.gate}: follow the greens · or skip`, keys: 'E' };
      case 'parking':
        return { text: 'On the stand: engines off' };
      case 'deplaning':
        return { text: 'Passengers leaving · skip', keys: 'E' };
      case 'failed':
        return { text: this.failure === 'ditching' ? 'Ditched: passengers evacuated safely' : 'Passengers evacuated safely' };
      case 'done':
        return null;
    }
  }

  /** The ECAM's warnings and memos (the cockpit shows them). */
  ecam(): { warnings: { text: string; level: 'warning' | 'caution' }[]; memos: string[] } {
    const s = this.fm.state;
    const p = this.pilot;
    const warnings: { text: string; level: 'warning' | 'caution' }[] = [];
    const memos: string[] = [];
    if (!s.onGround && !p.gearDown && s.radioAltFt < 750 && (p.flapLever >= 3 || p.throttle < 0.1)) warnings.push({ text: 'L/G GEAR NOT DOWN', level: 'warning' });
    if (s.overspeed) warnings.push({ text: 'OVERSPEED', level: 'warning' });
    if (s.stallWarning) warnings.push({ text: 'STALL', level: 'warning' });
    if (s.onGround && p.parkingBrake && p.throttle > A320.detents.flx - 0.05) warnings.push({ text: 'CONFIG PARK BRK ON', level: 'warning' });
    if (s.onGround && p.throttle > A320.detents.flx - 0.05 && p.flapLever === 0) warnings.push({ text: 'CONFIG FLAPS NOT IN T.O CONFIG', level: 'warning' });
    if (!this.fm.sys.engineRunning[0] && this.stage !== 'boarding' && this.stage !== 'stand' && this.stage !== 'parking' && this.stage !== 'deplaning' && this.stage !== 'done' && this.fm.sys.engineStart[0] < 0 && this.stage !== 'push') warnings.push({ text: 'ENG 1 SHUT DOWN', level: 'caution' });
    if (!s.onGround && p.speedbrake > 0 && p.throttle > A320.detents.cl + 0.05) warnings.push({ text: 'SPD BRK STILL OUT', level: 'caution' });
    const phase = this.nav.phase;
    if (s.onGround && phaseIndex(phase) <= phaseIndex('takeoff') && this.stage !== 'boarding') {
      memos.push(`T.O AUTO BRK ${p.autobrake === 'max' ? 'MAX' : '…'}`, 'SIGNS ON', p.spoilersArmed ? 'SPLRS ARM' : 'SPLRS …', p.flapLever >= 1 && p.flapLever <= 3 ? 'FLAPS T.O' : 'FLAPS …', 'T.O CONFIG …');
    } else if (!s.onGround && s.radioAltFt < 2000 && phaseIndex(phase) >= phaseIndex('approach')) {
      memos.push(p.gearDown ? 'LDG GEAR DN' : 'LDG GEAR …', 'SIGNS ON', 'CABIN READY', p.spoilersArmed ? 'SPLRS ARM' : 'SPLRS …', p.flapLever >= 4 ? 'FLAPS FULL' : 'FLAPS …');
    } else memos.push('SEAT BELTS', 'NO SMOKING');
    if (p.parkingBrake) memos.push('PARK BRK');
    if (p.autobrake !== 'off' && phaseIndex(phase) > phaseIndex('takeoff')) memos.push(`AUTO BRK ${p.autobrake.toUpperCase()}`);
    if (p.spoilersArmed && phaseIndex(phase) > phaseIndex('takeoff')) memos.push('GND SPLRS ARMED');
    if (p.speedbrake > 0 && !s.onGround) memos.push('SPEED BRK');
    if (this.warp > 1) memos.push(`TIME ×${this.warp}`);
    return { warnings, memos };
  }

  /** The aircraft's distance gone and to go, and the ETA (s): for the HUD's progress line. */
  progress() {
    const s = this.fm.state;
    const toGo = this.nav.distanceToGoM(s);
    return { toGoNm: toGo / 1852, etaS: this.nav.etaS(s), gsKt: s.gs };
  }

  /** The runway the visitor is landing on now, and how far out (m before the threshold) — the ILS guide's. */
  finalDistance() {
    const s = this.fm.state;
    return -runwayFrame(this.arrRw, s.pos.x, s.pos.z).along;
  }
}
