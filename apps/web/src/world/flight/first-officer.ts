// The first officer's hands, for the parts the visitor would rather hand over: the auto taxi (the
// radio calls, the pushback request, the taxi along ATC's greens, the stop at the red bar, the
// line-up; after landing the rollout from 40 kt, the cleared exit and the taxi in onto the stand)
// and the autoland's crew duties (the autopilot and the autothrust in, APPR, the autobrake, the
// ground spoilers, the flaps and the gear by the speeds, the descent onto a glide slope joined
// from above, the levers to idle at RETARD, and the go-around if it isn't stabilised; the
// autopilot itself flies LAND, FLARE and ROLL OUT, aviation/autopilot.ts). The takeoff is always
// the visitor's.
//
// Any steering, thrust or brake input (sim.handsOn, from flight/controls.ts) takes the taxi back,
// and the autopilot going off on the approach (the stick, the AP button) takes the landing back:
// the switch goes off with a "you have control", and the HUD's toggle gives it again. It runs
// after the pilot's input each frame, so what it sets is what the flight model gets, and it drives
// the same inputs the visitor's keys do (GroundCrew, shared with the scripted crew).

import { A320 } from '../../aviation/a320';
import { AUTOLAND_RETARD_FT, isLandMode } from '../../aviation/autopilot';
import { phaseIndex } from '../../aviation/nav';
import { GroundCrew } from './ground-crew';
import type { FlightSim } from './sim';

/** After landing the auto taxi takes the rollout below this (kt), with the visitor's hands off. */
const TAKE_ROLLOUT_KT = 40;
/** The autoland alone hands the aircraft over on the centreline at taxi speed (kt). */
const HANDOVER_KT = 20;

export class FirstOfficer {
  /** Lined up and cleared for takeoff after the first officer's line-up: the brakes held until the visitor's thrust. */
  readyForTakeoff = false;
  /** A departure skipped onto a busy runway waits at the holding point: the first officer lines it up once the tower clears it, auto taxi or not. */
  lineUpAfterSkip = false;
  /** The auto taxi or the autoland switched off by a takeover: the HUD's toggles follow. */
  onChange: (() => void) | null = null;

  private readonly ground: GroundCrew;
  private taxiOn = false;
  private landOn = false;
  /** Whether the first officer had hands on the aircraft this frame. */
  private drivingNow = false;
  /** The takeoff handed to the visitor (their thrust): nothing more on the ground until after landing. */
  private departed = false;
  /** The landing's rollout: not started, the first officer's, or handed over (or taken). */
  private roll: 'none' | 'fo' | 'visitor' = 'none';
  /** The approach the autoland was set up for (nav.goArounds), and whether the autopilot is in for it. */
  private setUpFor = -1;
  private apIn = false;
  private fromAbove = false;
  private wentAround = 0;

  constructor(private readonly sim: FlightSim) {
    this.ground = new GroundCrew(sim);
  }

  /** The auto taxi: out to the runway and in to the stand. */
  get autoTaxi() {
    return this.taxiOn;
  }
  set autoTaxi(on: boolean) {
    if (on === this.taxiOn) return;
    this.taxiOn = on;
    if (!on) this.readyForTakeoff = false;
    // given back on the runway after a takeover: the rollout is the first officer's again
    if (on && this.roll === 'visitor') this.roll = 'none';
  }

  /** The autoland: the autopilot lands (LAND, FLARE, ROLL OUT) and the first officer configures. */
  get autoland() {
    return this.landOn;
  }
  set autoland(on: boolean) {
    if (on === this.landOn) return;
    this.landOn = on;
    this.sim.ap.autoland = on;
    // (switched on again: the approach is set up afresh, the autopilot back in)
    this.setUpFor = -1;
    this.apIn = false;
    if (on && this.roll === 'visitor' && this.sim.ap.fcu.fma.vertical === 'ROLL OUT') this.roll = 'none';
  }

  /** The autoland is flying this approach (the autopilot in for it). */
  get landing() {
    return this.landOn && this.apIn;
  }

  /** Whether the first officer has the aircraft now (the HUD says so; the scripted crew stands back). */
  get driving() {
    return this.drivingNow;
  }

  /** One frame, after the pilot's input (FlightSim.tick). */
  frame(dt: number) {
    const sim = this.sim;
    this.ground.tick(dt);
    this.drivingNow = false;
    switch (sim.stage) {
      case 'stand':
        if (this.taxiOn) this.ground.ask('pushback');
        break;
      case 'taxi':
        this.taxiOut(dt);
        break;
      case 'flight':
        if (this.landOn) this.approach();
        this.rollout();
        break;
      case 'taxi-in':
        if (this.taxiOn) this.taxiIn();
        break;
    }
  }

  /** ATC ordered a go-around (traffic on the runway): with the autoland in charge, TOGA. */
  goAroundOrdered() {
    const s = this.sim.state;
    if (!this.landOn || !this.apIn || s.onGround || s.radioAltFt < 30) return;
    this.toga('Go around, traffic on the runway.');
  }

  // ---------------------------------------------------------------------------------------------- the taxi out

  private taxiOut(dt: number) {
    const sim = this.sim;
    const c = sim.pilot;
    if (this.departed || (!this.taxiOn && !this.lineUpAfterSkip)) return;
    // lined up and cleared: the visitor's thrust (or any control) is the takeoff, theirs from here
    if (this.readyForTakeoff && (sim.handsOn || c.throttle >= A320.detents.flx - 0.02)) {
      this.readyForTakeoff = false;
      this.lineUpAfterSkip = false;
      this.departed = true;
      return;
    }
    // a skipped departure waiting at the holding point, without the auto taxi: nothing to do until the line-up
    if (!this.taxiOn && sim.routeKind !== 'lineup') return;
    if (sim.handsOn) {
      this.takeover();
      return;
    }
    this.drivingNow = true;
    if (this.ground.taxiOut(dt)) {
      this.ground.hold();
      this.readyForTakeoff = true;
    }
  }

  // ---------------------------------------------------------------------------------------------- the autoland's crew duties

  private approach() {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const ap = sim.ap;
    const fcu = ap.fcu;
    const phase = sim.nav.phase;
    if (s.onGround) return;
    if (this.apIn && !fcu.ap) {
      // the visitor took it (the stick, the AP button): the landing is theirs
      this.autoland = false;
      sim.onNote?.(s.radioAltFt < 400 ? 'Autoland off: you have control. Land it!' : 'Autoland off: you have control');
      sim.say('fo', 'Your controls.');
      this.onChange?.();
      return;
    }
    if (sim.nav.goingAround && phase === 'approach') {
      // the missed approach the autoland was flying: gear up, flaps up by the speeds, CL once clear
      if (!this.apIn) return;
      if (c.gearDown && s.vs > 300 && s.radioAltFt > 500) {
        c.gearDown = false;
        sim.say('fo', 'Positive climb, gear up.');
      }
      if (c.flapLever > 0 && s.ias > (c.flapLever >= 2 ? s.speeds.f : s.speeds.s) + 5) c.flapLever--;
      if (s.radioAltFt > 1500 && c.throttle > A320.detents.cl) c.throttle = A320.detents.cl;
      return;
    }
    if (phase !== 'approach' && phase !== 'final' && phase !== 'landing') return;
    // the set-up, once an approach (again after a go-around): the automatics in, the approach armed
    if (this.setUpFor !== sim.nav.goArounds) {
      this.setUpFor = sim.nav.goArounds;
      this.apIn = false;
      this.fromAbove = false;
      if (!fcu.athr) {
        if (c.throttle < A320.detents.cl - 0.03 || c.throttle > A320.detents.cl + 0.03) c.throttle = A320.detents.cl;
        ap.toggleAthr();
      }
      ap.setSpd(null);
      if (!fcu.appr) ap.pushAppr();
      c.autobrake = 'med';
      c.spoilersArmed = true;
      sim.say('fo', 'Autoland: approach armed, autobrake medium, spoilers armed.');
    }
    if (!this.apIn) {
      if (!fcu.ap) ap.toggleAp();
      this.apIn = fcu.ap;
      if (!this.apIn) return;
    }
    // configure by the speeds, never above the next VFE
    const flaps = c.flapLever;
    if (c.flapLever === 0 && s.ias < s.speeds.greenDot + 10 && s.ias < A320.vfe[1]) c.flapLever = 1;
    else if (c.flapLever === 1 && s.ias < s.speeds.s + 10 && s.ias < A320.vfe[2]) c.flapLever = 2;
    const v = fcu.fma.vertical;
    const onGs = v === 'G/S*' || v === 'G/S' || isLandMode(v);
    if (onGs && !c.gearDown) {
      c.gearDown = true;
      c.speedbrake = 0;
      sim.say('fo', 'Gear down.');
    }
    if (onGs && c.flapLever < 3 && s.ias < A320.vfe[3]) c.flapLever = 3;
    if (c.flapLever === 3 && s.radioAltFt < 1500 && s.ias < A320.vfe[4]) c.flapLever = 4;
    if (c.flapLever !== flaps) sim.say('fo', `Flaps ${c.flapLever === 4 ? 'full' : c.flapLever}.`);
    // established on the localizer but above the glide slope: down at 1,500 fpm to meet it from
    // above, in steps to 500 ft at the lowest if the altitude levels off first
    const ils = sim.nav.ils(s);
    const onLoc = fcu.fma.lateral === 'LOC' || fcu.fma.lateral === 'LOC*';
    if (!this.fromAbove && ils?.valid && onLoc && fcu.fma.armedVertical === 'G/S' && ils.gsFt > 80) {
      this.fromAbove = true;
      ap.setAlt(1000);
      ap.setVs(-1500);
    }
    if (this.fromAbove && ils?.valid && fcu.fma.armedVertical === 'G/S' && (v === 'ALT' || v === 'ALT*') && ils.gsFt > 60 && s.radioAltFt > 650) {
      ap.setAlt(Math.max(500, Math.floor((s.altFt - 400) / 100) * 100));
      ap.setVs(-1500);
    }
    // cleared lower but held level at a constraint already behind: an open descent to what ATC cleared
    if (!this.fromAbove && phase === 'approach' && sim.atc.clearance.approach && v === 'ALT' && fcu.alt < s.altFt - 200) ap.pullAlt();
    // not stabilised by 700 ft (no glide slope, or the gear not down): go around, as the SOP says
    if (phase === 'final' && s.radioAltFt < 700 && s.radioAltFt > 100 && (s.gear < 0.9 || !onGs)) {
      this.toga('Not stabilised, go around.');
      return;
    }
    // the autothrust holds VAPP into the flare; RETARD at 10 ft, the levers to idle
    if (v === 'FLARE' && s.radioAltFt < AUTOLAND_RETARD_FT) c.throttle = 0;
  }

  private toga(line: string) {
    const sim = this.sim;
    if (sim.nav.goingAround || this.wentAround === sim.nav.goArounds + 1) return;
    this.wentAround = sim.nav.goArounds + 1;
    sim.pilot.throttle = A320.detents.toga;
    sim.say('fo', line);
  }

  // ---------------------------------------------------------------------------------------------- after landing

  /**
   * The landing roll: the autoland's ROLL OUT from the touchdown (the autopilot on the centreline,
   * the first officer on the levers and the reversers), or the auto taxi's from 40 kt with the
   * visitor's hands off. Below 40 kt the autopilot comes out; with the auto taxi the first officer
   * vacates, without it they hand over at taxi speed.
   */
  private rollout() {
    const sim = this.sim;
    const s = sim.state;
    const fcu = sim.ap.fcu;
    if (!s.onGround || phaseIndex(sim.nav.phase) < phaseIndex('landing') || this.roll === 'visitor') return;
    const rollOut = fcu.fma.vertical === 'ROLL OUT';
    if (this.roll === 'none') {
      if (rollOut) this.roll = 'fo';
      else if (this.taxiOn && s.gs < TAKE_ROLLOUT_KT && !sim.handsOn) {
        this.roll = 'fo';
        const v = sim.atc.clearance.vacate;
        sim.onNote?.(v ? `Auto taxi: vacating via ${v}` : 'Auto taxi: vacating');
      } else return;
    }
    if (sim.handsOn) {
      // the autopilot keeps the centreline while the visitor brakes or reverses; below 40 kt, or
      // off the autoland, any control is a takeover
      if (rollOut && s.gs >= TAKE_ROLLOUT_KT) return;
      this.roll = 'visitor';
      if (fcu.ap) sim.ap.toggleAp();
      if (this.taxiOn) this.takeover();
      else sim.onNote?.('You have control');
      return;
    }
    this.drivingNow = true;
    if (rollOut && s.gs >= TAKE_ROLLOUT_KT) {
      // ROLL OUT: the autopilot steers, the autobrake brakes; levers idle, idle reverse
      const c = sim.pilot;
      c.throttle = 0;
      c.pitch = c.roll = 0;
      c.reverse = s.gs > 60 ? 0.1 : 0;
      return;
    }
    if (fcu.ap) sim.ap.toggleAp();
    this.ground.rollout(this.taxiOn);
    if (!this.taxiOn && s.gs <= HANDOVER_KT) {
      this.roll = 'visitor';
      const v = sim.atc.clearance.vacate;
      sim.onNote?.(`Autoland complete: you have control${v ? `. Vacate via ${v}` : ''}`);
      sim.say('fo', 'Your controls.');
    }
  }

  private taxiIn() {
    const sim = this.sim;
    if (sim.handsOn) {
      this.takeover();
      return;
    }
    this.drivingNow = true;
    this.ground.taxiIn(false);
  }

  /** The visitor's hands on the controls while the first officer taxis: the auto taxi goes off. */
  private takeover() {
    if (!this.taxiOn && !this.lineUpAfterSkip) return;
    this.sim.onNote?.(this.taxiOn ? 'Auto taxi off: you have control' : 'You have control');
    this.autoTaxi = false;
    this.lineUpAfterSkip = false;
    this.sim.say('fo', 'Your controls.');
    this.onChange?.();
  }
}
