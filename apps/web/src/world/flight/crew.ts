// A scripted crew that flies a FlightSim gate to gate the way a careful visitor would: asks ATC for
// each clearance in turn, taxis along the cleared route at the guide's speeds, waits at the red
// stop bar, takes off at TOGA in CONF 1+F and rotates at VR, raises the gear, engages the
// autopilot and the autothrust, cleans up, cruises on NAV, descends, arms the approach and
// configures by the speeds, lands by hand from 200 ft (the flight director to 50 ft, a flare for
// ~150 fpm, the decrab), vacates at the cleared exit and taxis onto the stand.
//
// It drives the same inputs the visitor's keys do (sim.pilot and the autopilot's buttons), so the
// node check (scripts/flight-check.mjs) and the preview (preview/scenes/flight.ts) exercise the
// real flight, not a shortcut. The flying is adapted from aviation/sim-check.ts's crew.

import { A320 } from '../../aviation/a320';
import { runwayFrame, taxiRoute } from '../../aviation/airports';
import { angleDiff, phaseIndex } from '../../aviation/nav';
import type { FdmEvent } from '../../aviation/types';
import { KT, headingVec, vecHeading } from '../geo';
import type { FlightSim } from './sim';
import { TaxiPath } from './taxi';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface CrewOptions {
  /** Skip the taxi-in with the action key once the runway is vacated (default false: taxi to the stand). */
  skipTaxiIn?: boolean;
  /** Fly the approach on the autopilot to 200 ft (default true); otherwise hand-fly the flight director from the IF. */
  autopilot?: boolean;
  /** Go around (TOGA) from the first approach at this radio height (ft), then come round and land (default 0: never). */
  goAroundFt?: number;
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
  private exitPath: TaxiPath | null = null;
  private disarmedAutobrake = false;
  private asked = 0;
  /** The go-arounds already flown (nav.goArounds), and whether the one asked for has been. */
  private goArounds = 0;
  private wentAround = false;
  private readonly tgt = { x: 0, z: 0 };
  private readonly opts: Required<CrewOptions>;

  constructor(
    private readonly sim: FlightSim,
    opts: CrewOptions = {},
  ) {
    this.opts = { skipTaxiIn: opts.skipTaxiIn ?? false, autopilot: opts.autopilot ?? true, goAroundFt: opts.goAroundFt ?? 0 };
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

  /** One frame of the crew (FlightSim.step's pilot input). */
  frame = (dt: number) => {
    const sim = this.sim;
    const c = sim.pilot;
    const next = sim.atc.nextRequest;
    this.asked = Math.max(0, this.asked - dt);
    switch (sim.stage) {
      case 'stand':
        if (next === 'pushback' && !this.asked) this.ask();
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
        this.taxiIn(dt);
        return;
      default:
        c.pitch = c.roll = c.yaw = c.tiller = 0;
    }
  };

  private ask() {
    this.sim.action();
    this.asked = 2;
  }

  // ---------------------------------------------------------------------------------------------- on the ground

  private taxiOut(_dt: number) {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const clr = sim.atc.clearance;
    const running = sim.fm.sys.engineRunning[0] && sim.fm.sys.engineRunning[1];
    // the before-takeoff flow: CONF 1+F, ground spoilers armed, autobrake MAX, the climb on the FCU
    c.flapLever = 1;
    c.spoilersArmed = true;
    c.autobrake = 'max';
    if (!running) {
      this.hold();
      return;
    }
    if (!clr.taxi) {
      this.hold();
      if (sim.atc.nextRequest === 'taxi' && !this.asked) this.ask();
      return;
    }
    const route = sim.route;
    if (!route) {
      this.hold();
      return;
    }
    if (sim.routeKind === 'out') {
      // at the holding point: stop short of the bar and call ready
      const left = route.lengthM - route.along;
      if (sim.atc.nextRequest === 'takeoff' && left < 250 && !this.asked) this.ask();
      if (left < 18) {
        this.hold();
        this.log.waitedAtHoldS += _dt;
        return;
      }
      this.follow(route, Math.min(route ? sim.guide.adviceKt : 10, 26));
      return;
    }
    // the line-up: onto the runway at a walking pace, then the takeoff
    const rw = sim.depRw;
    const fr = runwayFrame(rw, s.pos.x, s.pos.z);
    const err = angleDiff(rw.heading, s.heading);
    const onCentre = Math.abs(fr.right) < 4 && Math.abs(err) < 6 && route.along > route.lengthM - 300 + 30;
    if (!this.rotating && !(onCentre && clr.takeoff) && c.throttle < A320.detents.flx) {
      if (onCentre && !clr.takeoff) {
        this.hold();
        return;
      }
      this.follow(route, 8);
      return;
    }
    this.takeoffRoll();
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

  private hold() {
    const c = this.sim.pilot;
    c.throttle = 0;
    c.tiller = 0;
    c.brakeL = c.brakeR = this.sim.state.gs > 0.3 ? 0.5 : 0.3;
  }

  /** Pure pursuit along a route at a speed (kt), with the throttle and the toe brakes. */
  private follow(route: TaxiPath, kt: number) {
    const s = this.sim.state;
    const c = this.sim.pilot;
    const v = s.gs;
    // the sim tracks its own cleared route; the crew's exit path is tracked here
    if (route !== this.sim.route) route.track(s.pos.x, s.pos.z);
    const look = clamp(12 + v * KT * 2.5, 14, 34);
    route.pointAhead(look, this.tgt);
    const want = vecHeading(this.tgt.x - s.pos.x, this.tgt.z - s.pos.z);
    const err = angleDiff(want, s.heading);
    // full tiller from a standstill only scrubs the nose wheel: roll first, then turn
    const most = v < 2 ? 0.35 : v < 5 ? 0.7 : 1;
    c.tiller = clamp(err / 30 - s.r * 0.04, -most, most);
    c.yaw = 0;
    // a sharp turn ahead of the nose: slow for it
    const target = Math.abs(err) > 25 ? Math.min(kt, 8) : kt;
    if (v < target - 0.5) {
      c.throttle = clamp(0.2 + (target - v) * 0.02 + (v < 1 ? 0.08 : 0), 0, 0.36);
      c.brakeL = c.brakeR = 0;
    } else {
      c.throttle = 0;
      c.brakeL = c.brakeR = v > target + 1.5 ? clamp((v - target) * 0.06, 0.05, 0.55) : 0;
    }
  }

  private taxiIn(_dt: number) {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    c.reverse = 0;
    c.pitch = c.roll = 0;
    c.flapLever = 0;
    c.spoilersArmed = false;
    if (this.opts.skipTaxiIn) {
      this.hold();
      if (sim.atc.nextRequest === 'skip-taxi-in' && !this.asked) this.ask();
      return;
    }
    const route = sim.route ?? this.exitPath;
    if (!route) {
      this.hold();
      return;
    }
    const left = route === sim.route ? route.lengthM - route.along : Infinity;
    if (left < 1.5 || (route === sim.route && route.distToEnd(s.pos.x, s.pos.z) < 2)) {
      this.hold();
      c.brakeL = c.brakeR = 0.8;
      return;
    }
    this.follow(route, route === sim.route ? Math.min(sim.guide.adviceKt, 20) : 12);
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
    if (phase === 'final' && !s.onGround && s.radioAltFt < 700 && s.radioAltFt > 100 && c.throttle < A320.detents.toga && !sim.nav.goingAround && this.engaged && !this.manual && (s.gear < 0.9 || (fcu.fma.vertical !== 'G/S' && fcu.fma.vertical !== 'G/S*'))) c.throttle = A320.detents.toga;
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
    if (this.engaged && !this.fromAbove && phase === 'approach' && sim.atc.clearance.approach && fcu.fma.vertical === 'ALT' && fcu.alt < s.altFt - 200) ap.pullAlt();
    if ((phase === 'approach' || phase === 'final') && !this.apprArmed && !missed) {
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
    if (!this.fromAbove && ils?.valid && fcu.ap && (fcu.fma.lateral === 'LOC' || fcu.fma.lateral === 'LOC*') && fcu.fma.armedVertical === 'G/S' && ils.gsFt > 80) {
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
    // the rollout: stick neutral, idle reverse, the autobrake to taxi speed; steer for the centreline
    c.throttle = 0;
    c.pitch = 0;
    c.roll = 0;
    c.reverse = s.gs > 60 ? 0.1 : 0;
    const exitName = sim.atc.clearance.vacate;
    const exit = exitName ? rw.exits.find((e) => e.name === exitName) : null;
    if (!this.disarmedAutobrake && s.gs < 40) {
      // pedals: the autobrake lets go, and the crew brakes to the exit's speed
      this.disarmedAutobrake = true;
      c.autobrake = 'off';
      c.brakeL = c.brakeR = 0.7;
      return;
    }
    if (exit && !this.exitPath) {
      const node = sim.arr.nodes[exit.node];
      const along = runwayFrame(rw, node.x, node.z).along;
      const ahead = along - fr.along;
      if (ahead < 30 + s.gs * KT * 2) {
        const r = taxiRoute(sim.arr, exit.node, sim.arr.playerStand);
        if (r) this.exitPath = new TaxiPath(sim.arr, r.nodes.slice(0, Math.min(r.nodes.length, 3)));
      }
    }
    if (this.exitPath) {
      this.follow(this.exitPath, 12);
      return;
    }
    if (this.disarmedAutobrake) {
      const target = 18;
      c.brakeL = c.brakeR = s.gs > target ? clamp((s.gs - target) * 0.05, 0.1, 0.6) : 0;
    }
    c.tiller = 0;
    c.yaw = clamp(angleDiff(rw.heading - clamp(fr.right * 0.4, -3, 3), s.heading) * 0.15 - s.r * 0.3, -1, 1);
  }
}
