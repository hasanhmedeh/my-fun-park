// A scripted crew that flies a FlightSim gate to gate the way a careful visitor would: asks ATC for
// each clearance in turn, taxis along the cleared route at the guide's speeds, waits at the red
// stop bar, takes off at TOGA in CONF 1+F and rotates at VR, raises the gear, engages the
// autopilot and the autothrust, cleans up, cruises on NAV, descends, arms the approach and
// configures by the speeds, lands by hand from 200 ft (the flight director to 50 ft, a flare for
// ~150 fpm, the decrab), vacates at the cleared exit and taxis onto the stand.
//
// It drives the same inputs the visitor's keys do (sim.pilot and the autopilot's buttons), so the
// node check (scripts/flight-check.mjs) and the preview (preview/scenes/flight.ts) exercise the
// real flight, not a shortcut. The flying is adapted from aviation/sim-check.ts's crew; the ground
// work is GroundCrew's (shared with the first officer's auto taxi). Like a visitor, it can leave
// the taxiing and the landing to the first officer and the autoland (sim.fo, sim.ap.autoland).

import { A320 } from '../../aviation/a320';
import { runwayFrame } from '../../aviation/airports';
import { isLandMode } from '../../aviation/autopilot';
import { angleDiff, phaseIndex } from '../../aviation/nav';
import type { FdmEvent } from '../../aviation/types';
import { headingVec } from '../geo';
import { GroundCrew } from './ground-crew';
import type { FlightSim } from './sim';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface CrewOptions {
  /** Skip the taxi-in with the action key once the runway is vacated (default false: taxi to the stand). */
  skipTaxiIn?: boolean;
  /** Fly the approach on the autopilot to 200 ft (default true); otherwise hand-fly the flight director from the IF. */
  autopilot?: boolean;
  /** Go around (TOGA) from the first approach at this radio height (ft), then come round and land (default 0: never). */
  goAroundFt?: number;
  /** Leave the radio calls and the taxiing, out and in, to the first officer's auto taxi (sim.fo.autoTaxi): the crew only takes off. */
  autoTaxi?: boolean;
  /** Leave the approach's configuration, the landing and the rollout to the autoland (sim.ap.autoland) and the first officer. */
  autoland?: boolean;
}

/** What the crew noticed (for the check's report). */
export interface CrewLog {
  liftoffT: number;
  touchdownT: number;
  touchdown: Extract<FdmEvent, { kind: 'touchdown' }> | null;
  maxAltFt: number;
  waitedAtHoldS: number;
  stopBarCrossedRed: boolean;
}

export class Crew {
  readonly log: CrewLog = { liftoffT: -1, touchdownT: -1, touchdown: null, maxAltFt: 0, waitedAtHoldS: 0, stopBarCrossedRed: false };
  private rotating = false;
  private engaged = false;
  private manual = false;
  private apprArmed = false;
  private fromAbove = false;
  private clearedAlt = 0;
  /** The go-arounds already flown (nav.goArounds), and whether the one asked for has been. */
  private goArounds = 0;
  private wentAround = false;
  private readonly ground: GroundCrew;
  private readonly opts: Required<CrewOptions>;

  constructor(
    private readonly sim: FlightSim,
    opts: CrewOptions = {},
  ) {
    this.ground = new GroundCrew(sim);
    this.opts = { skipTaxiIn: opts.skipTaxiIn ?? false, autopilot: opts.autopilot ?? true, goAroundFt: opts.goAroundFt ?? 0, autoTaxi: opts.autoTaxi ?? false, autoland: opts.autoland ?? false };
    sim.onEvent = (e) => {
      if (e.kind === 'touchdown' && e.gear === 'main' && !this.log.touchdown && phaseIndex(sim.nav.phase) >= phaseIndex('approach')) {
        this.log.touchdown = e;
        this.log.touchdownT = sim.t;
      }
    };
    const prev = sim.ap.onEvent;
    sim.ap.onEvent = (e) => {
      prev?.(e);
      if (e === 'ap-off' && this.engaged) this.manual = true;
    };
  }

  /** The way off the runway and the steering target (the check's trace). */
  get exitPath() {
    return this.ground.exitPath;
  }
  get tgt() {
    return this.ground.tgt;
  }

  /** One frame of the crew (FlightSim.step's pilot input). */
  frame = (dt: number) => {
    const sim = this.sim;
    const c = sim.pilot;
    this.ground.tick(dt);
    switch (sim.stage) {
      case 'stand':
        if (!this.opts.autoTaxi) this.ground.ask('pushback');
        return;
      case 'push':
        return;
      case 'taxi':
        this.taxiOut(dt);
        return;
      case 'flight':
        this.fly(dt);
        return;
      case 'taxi-in':
        if (!this.opts.autoTaxi) this.ground.taxiIn(this.opts.skipTaxiIn);
        return;
      default:
        c.pitch = c.roll = c.yaw = c.tiller = 0;
    }
  };

  // ---------------------------------------------------------------------------------------------- on the ground

  private taxiOut(dt: number) {
    const sim = this.sim;
    const c = sim.pilot;
    // once rolling it's the takeoff whatever the line-up looked like
    if (this.rotating || c.throttle >= A320.detents.flx) {
      this.takeoffRoll();
      return;
    }
    // with the auto taxi the first officer brings it onto the runway; the takeoff is the crew's
    const lined = this.opts.autoTaxi ? sim.fo.readyForTakeoff : this.ground.taxiOut(dt);
    this.log.waitedAtHoldS = this.ground.waitedAtHoldS;
    if (lined) this.takeoffRoll();
  }

  private takeoffRoll() {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const rw = sim.depRw;
    const fr = runwayFrame(rw, s.pos.x, s.pos.z);
    c.parkingBrake = false;
    c.brakeL = c.brakeR = 0;
    c.tiller = 0;
    c.throttle = A320.detents.toga;
    // straight down the centreline, rotate at VR towards 15° at 3°/s
    c.yaw = s.onGround ? clamp(angleDiff(rw.heading - clamp(fr.right * 0.4, -3, 3), s.heading) * 0.15 - s.r * 0.3, -1, 1) : 0;
    if (s.ias >= sim.nav.vSpeeds.vr) this.rotating = true;
    if (this.rotating) c.pitch = clamp(0.3 + 0.12 * (3 - s.q), 0, 0.8);
  }

  // ---------------------------------------------------------------------------------------------- in the air

  private fly(dt: number) {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const ap = sim.ap;
    const fcu = ap.fcu;
    const phase = sim.nav.phase;
    if (s.onGround && this.log.liftoffT < 0 && !this.log.touchdown) {
      this.takeoffRoll();
      return;
    }
    if (this.log.liftoffT < 0 && !s.onGround) this.log.liftoffT = sim.t;
    this.log.maxAltFt = Math.max(this.log.maxAltFt, s.altFt);

    // the go-around asked for: TOGA from the first approach
    if (this.opts.goAroundFt > 0 && !this.wentAround && phase === 'final' && !s.onGround && s.radioAltFt < this.opts.goAroundFt) {
      this.wentAround = true;
      c.throttle = A320.detents.toga;
    }
    // alpha floor on the approach (a gust, the raw angle of attack): TOGA LK would carry the aircraft
    // onto the runway far too fast, so the crew goes around, as the SOP says for any protection
    // triggering on final
    if (phase === 'final' && !s.onGround && s.radioAltFt > 30 && c.throttle < A320.detents.toga && (s.alphaFloor || fcu.fma.thrust === 'TOGA LK')) c.throttle = A320.detents.toga;
    // not stabilised by 700 ft (no glide slope, or the gear still up): go around, as the SOP says
    if (phase === 'final' && !s.onGround && s.radioAltFt < 700 && s.radioAltFt > 100 && c.throttle < A320.detents.toga && !sim.nav.goingAround && this.engaged && !this.manual && (s.gear < 0.9 || (fcu.fma.vertical !== 'G/S' && fcu.fma.vertical !== 'G/S*' && !isLandMode(fcu.fma.vertical)))) c.throttle = A320.detents.toga;
    // the tower says go around (traffic still on the runway): the approach clearance is withdrawn
    if (phase === 'final' && !s.onGround && s.radioAltFt > 30 && c.throttle < A320.detents.toga && !sim.nav.goingAround && !sim.atc.clearance.approach && !sim.atc.clearance.land) c.throttle = A320.detents.toga;
    // round again, whatever started it: the approach is flown afresh once ATC clears it
    if (sim.nav.goArounds > this.goArounds) {
      this.goArounds = sim.nav.goArounds;
      this.apprArmed = false;
      this.fromAbove = false;
      this.manual = false;
      this.clearedAlt = 0;
      this.engaged = fcu.ap;
      if (!s.onGround) this.log.touchdown = null;
    }
    // the missed approach, until ATC clears the next approach (the sim ends it there); the first
    // approach's clearance still stands for a few seconds after TOGA, so it can't be the test
    const missed = sim.nav.goingAround && phase === 'approach';
    if (missed) {
      if (s.vs > 300 && s.radioAltFt > 500) c.gearDown = false;
      if (c.flapLever > 0 && s.ias > (c.flapLever >= 2 ? s.speeds.f : s.speeds.s) + 5) c.flapLever--;
      if (s.radioAltFt > 1500 && c.throttle > A320.detents.cl) c.throttle = A320.detents.cl;
    }

    if (!this.engaged && !this.log.touchdown) {
      // hand-flown on the bars until the autopilot can go in
      c.yaw = 0;
      c.pitch = fcu.fdPitch !== null ? clamp((fcu.fdPitch - s.pitch) * 0.06 - s.q * 0.06, -0.2, 0.2) : 0;
      c.roll = fcu.fdBank !== null ? clamp((fcu.fdBank - s.bank) * 0.04, -0.3, 0.3) : 0;
      if (s.radioAltFt > 120) {
        ap.toggleAp();
        if (!fcu.athr) ap.toggleAthr();
        if (fcu.ap) {
          this.engaged = true;
          c.pitch = c.roll = 0;
        }
      }
    }
    if (!s.onGround && s.vs > 300 && s.radioAltFt > 35 && phaseIndex(phase) < phaseIndex('approach')) c.gearDown = false;
    if (ap.lvrClb) c.throttle = A320.detents.cl;
    if (phase === 'climb' && c.flapLever === 1 && s.ias > s.speeds.s) c.flapLever = 0;
    // the altitude ATC clears on the FCU: a managed climb or descent to it (never ahead of the clearance)
    const cleared = sim.atc.clearance.altitudeFt;
    if (this.engaged && cleared && cleared !== this.clearedAlt && !this.fromAbove) {
      this.clearedAlt = cleared;
      ap.setAlt(cleared);
      if (Math.abs(cleared - s.altFt) > 100) ap.pushAlt();
    }
    // cleared lower but held level at a constraint already behind (the managed descent stops at the
    // initial approach fix's altitude and doesn't resume, which after a go-around leaves the aircraft
    // at the missed approach altitude down the final): an open descent to what ATC cleared
    // (with the autoland the first officer flies the approach's configuration and its descents: flight/first-officer.ts)
    const own = !this.opts.autoland;
    if (own && this.engaged && !this.fromAbove && phase === 'approach' && sim.atc.clearance.approach && fcu.fma.vertical === 'ALT' && fcu.alt < s.altFt - 200) ap.pullAlt();
    if (own && (phase === 'approach' || phase === 'final') && !this.apprArmed && !missed) {
      this.apprArmed = true;
      if (!fcu.appr) ap.pushAppr();
      c.autobrake = 'med';
      c.spoilersArmed = true;
    }
    if (this.apprArmed && !this.manual) {
      // configure by the speeds, never above the next VFE
      if (c.flapLever === 0 && s.ias < s.speeds.greenDot + 10 && s.ias < A320.vfe[1]) c.flapLever = 1;
      else if (c.flapLever === 1 && s.ias < s.speeds.s + 10 && s.ias < A320.vfe[2]) c.flapLever = 2;
      if (fcu.fma.vertical === 'G/S*' || fcu.fma.vertical === 'G/S') {
        c.gearDown = true;
        if (c.flapLever < 3 && s.ias < A320.vfe[3]) c.flapLever = 3;
      }
      if (c.flapLever === 3 && s.radioAltFt < 1500 && s.ias < A320.vfe[4]) c.flapLever = 4;
    }
    // the speed brakes when the managed descent runs fast (a late or tight arrival), never once configured
    if (!s.onGround && !missed && (phase === 'descent' || phase === 'approach' || phase === 'final')) {
      const want = sim.nav.managedSpeed(s);
      c.speedbrake = c.flapLever < 3 && s.ias > want + 12 ? 1 : s.ias < want + 4 ? 0 : c.speedbrake;
    } else c.speedbrake = 0;
    // established on the localizer but above the glide slope: down at 1,500 fpm to meet it from above
    const ils = sim.nav.ils(s);
    if (own && !this.fromAbove && ils?.valid && fcu.ap && (fcu.fma.lateral === 'LOC' || fcu.fma.lateral === 'LOC*') && fcu.fma.armedVertical === 'G/S' && ils.gsFt > 80) {
      this.fromAbove = true;
      ap.setAlt(1000);
      ap.setVs(-1500);
    }
    // still above the beam when the altitude levels off (a tight join after a go-around): on down
    // in steps, to 500 ft at the lowest, until the glide slope is captured from above
    if (this.fromAbove && ils?.valid && fcu.ap && fcu.fma.armedVertical === 'G/S' && (fcu.fma.vertical === 'ALT' || fcu.fma.vertical === 'ALT*') && ils.gsFt > 60 && s.radioAltFt > 650) {
      ap.setAlt(Math.max(500, Math.floor((s.altFt - 400) / 100) * 100));
      ap.setVs(-1500);
    }
    if (!this.opts.autopilot && this.engaged && phase === 'final' && fcu.ap) ap.toggleAp();
    this.land(dt);
  }

  /** The manual landing from the autopilot's hand-over, and the rollout to the exit. */
  private land(_dt: number) {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const fcu = sim.ap.fcu;
    const rw = sim.arrRw;
    const fr = runwayFrame(rw, s.pos.x, s.pos.z);
    if (this.manual && !s.onGround && !this.log.touchdown) {
      const ra = s.radioAltFt;
      if (ra > 50 && fcu.fdPitch !== null) c.pitch = clamp((fcu.fdPitch - s.pitch) * 0.06 - s.q * 0.03, -0.3, 0.3);
      else {
        // the flare: a sink rate that falls with the height (about 4 s to the runway), never more
        // than it's sinking already (no pushing over at 50 ft); the flare law's nose-down bias
        // below 30 ft is held off, and the pitch rate damps the pull. A gust that balloons the
        // aircraft (sinking far less than wanted, or climbing) gets a firm push back down: floating
        // in ground effect on a gusty day runs the touchdown past the zone.
        const vsT = -clamp(ra * 13, 110, Math.max(110, -s.vs));
        const bias = ra < 30 ? 0.12 + 0.1 * (1 - ra / 30) : 0;
        const floating = s.vs > vsT + 120;
        c.pitch = clamp((vsT - s.vs) * 0.0026 + bias - s.q * 0.04, floating ? -0.35 : -0.1, 0.9);
      }
      // below 30 ft: hold the centreline by its drift (a wing down into the wind, at most 5°);
      // the decrab from 60 ft, the rudder lining the nose up with the runway by the touchdown
      const fw = headingVec(rw.heading);
      const drift = s.vel.x * -fw.z + s.vel.z * fw.x;
      const bankT = clamp(-(fr.right * 0.12 + drift * 0.9), -5, 5);
      c.roll = fcu.fdBank !== null && ra > 30 ? clamp((fcu.fdBank - s.bank) * 0.04, -0.4, 0.4) : clamp((bankT - s.bank) * 0.06 - s.p * 0.02, -0.4, 0.4);
      c.yaw = ra < 60 ? clamp(angleDiff(rw.heading, s.heading) / 8 - s.r * 0.1, -1, 1) : 0;
      // the autothrust holds VAPP to the flare; then the levers come back to idle (RETARD, 20 ft)
      if (ra < 20) {
        c.throttle = 0;
        if (fcu.athr) sim.ap.toggleAthr();
      } else if (fcu.athr && c.throttle < A320.detents.toga) c.throttle = A320.detents.cl;
    }
    if (!this.log.touchdown || !s.onGround) return;
    // the rollout, unless the first officer has it (the autoland's ROLL OUT, or the auto taxi below 40 kt)
    if (!sim.fo.driving) this.ground.rollout();
  }
}
