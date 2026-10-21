// The crew's hands on the ground, shared by the scripted crew (crew.ts: the node check and the
// preview) and the first officer's auto taxi (first-officer.ts): the radio calls for the taxi and
// the departure, the before-takeoff flow, the cleared route at the guide's speeds with the throttle
// and the toe brakes, the stop short of the red bar, the line-up, the rollout to the cleared exit
// after landing and the taxi in onto the stand.
//
// It drives the same inputs the visitor's keys do (sim.pilot), so what it does is what the visitor
// could have done.

import { runwayFrame, taxiRoute } from '../../aviation/airports';
import type { AtcRequest } from '../../aviation/atc';
import { angleDiff } from '../../aviation/nav';
import { KT, vecHeading } from '../geo';
import type { FlightSim } from './sim';
import { TaxiPath } from './taxi';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class GroundCrew {
  /** The way off the runway after landing (the cleared exit and the first nodes towards the stand), until ATC's taxi-in route. */
  exitPath: TaxiPath | null = null;
  /** How long the aircraft has waited at the holding point (s). */
  waitedAtHoldS = 0;
  /** The point ahead on the route the nose is steered at. */
  readonly tgt = { x: 0, z: 0 };
  /** A breather after each radio call (s), so a request isn't made twice while ATC answers. */
  private asked = 0;
  private disarmedAutobrake = false;

  constructor(private readonly sim: FlightSim) {}

  /** Every frame, before the rest. */
  tick(dt: number) {
    this.asked = Math.max(0, this.asked - dt);
  }

  /** The radio call `kind` (the action key), if it's the one ATC expects next. */
  ask(kind: AtcRequest) {
    if (this.asked || this.sim.atc.nextRequest !== kind) return;
    this.sim.action();
    this.asked = 2;
  }

  /**
   * From the end of the pushback to lined up: the before-takeoff flow (CONF 1+F, the ground
   * spoilers armed, the autobrake MAX), the taxi clearance asked for, the cleared route at the
   * guide's speeds, a stop short of the red bar while the crew call ready for departure, and the
   * line-up once the tower clears it, at a walking pace onto the centreline. True once lined up and
   * cleared for takeoff: the takeoff roll is the caller's.
   */
  taxiOut(dt: number): boolean {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const clr = sim.atc.clearance;
    const running = sim.fm.sys.engineRunning[0] && sim.fm.sys.engineRunning[1];
    c.flapLever = 1;
    c.spoilersArmed = true;
    c.autobrake = 'max';
    if (!running) {
      this.hold();
      return false;
    }
    if (!clr.taxi) {
      this.hold();
      this.ask('taxi');
      return false;
    }
    const route = sim.route;
    if (!route) {
      this.hold();
      return false;
    }
    if (sim.routeKind === 'out') {
      // at the holding point: stop short of the bar and call ready
      const left = route.lengthM - route.along;
      if (left < 250) this.ask('takeoff');
      if (left < 18) {
        this.hold();
        this.waitedAtHoldS += dt;
        return false;
      }
      this.follow(route, Math.min(sim.guide.adviceKt, 26));
      return false;
    }
    // the line-up: onto the runway at a walking pace, then wait on the centreline for the takeoff clearance
    const rw = sim.depRw;
    const fr = runwayFrame(rw, s.pos.x, s.pos.z);
    const err = angleDiff(rw.heading, s.heading);
    const onCentre = Math.abs(fr.right) < 4 && Math.abs(err) < 6 && route.along > route.lengthM - 300 + 30;
    if (onCentre && clr.takeoff) return true;
    if (onCentre) this.hold();
    else this.follow(route, 8);
    return false;
  }

  /** Stopped: the levers at idle and the toe brakes on. */
  hold() {
    const c = this.sim.pilot;
    c.throttle = 0;
    c.tiller = 0;
    c.brakeL = c.brakeR = this.sim.state.gs > 0.3 ? 0.5 : 0.3;
  }

  /** Pure pursuit along a route at a speed (kt), with the throttle and the toe brakes. */
  follow(route: TaxiPath, kt: number) {
    const s = this.sim.state;
    const c = this.sim.pilot;
    const v = s.gs;
    // the sim tracks its own cleared route; the exit path is tracked here
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

  /**
   * On the runway after the touchdown: the stick neutral, idle reverse, the autobrake down to
   * 40 kt, then the toe brakes (or a little thrust, from a stop) to the exit's speed, steering for
   * the centreline, and off at the cleared exit (or the next one ahead, if it's behind) towards the
   * stand once it's close. Without `vacate` it only slows to taxi speed on the centreline (the
   * autoland's hand-over: the visitor turns off).
   */
  rollout(vacate = true) {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    const rw = sim.arrRw;
    const fr = runwayFrame(rw, s.pos.x, s.pos.z);
    c.throttle = 0;
    c.pitch = 0;
    c.roll = 0;
    c.reverse = s.gs > 60 ? 0.1 : 0;
    if (!this.disarmedAutobrake && s.gs < 40) {
      // pedals: the autobrake lets go, and the crew brake to the exit's speed
      this.disarmedAutobrake = true;
      c.autobrake = 'off';
      c.brakeL = c.brakeR = 0.7;
      return;
    }
    if (vacate && !this.exitPath) {
      const ahead = (node: string) => {
        const n = sim.arr.nodes[node];
        return runwayFrame(rw, n.x, n.z).along - fr.along;
      };
      const cleared = rw.exits.find((e) => e.name === sim.atc.clearance.vacate);
      const exit = cleared && ahead(cleared.node) > -5 ? cleared : rw.exits.filter((e) => ahead(e.node) > 0).sort((a, b) => ahead(a.node) - ahead(b.node))[0];
      if (exit && ahead(exit.node) < 30 + s.gs * KT * 2) {
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
      if (s.gs < target - 3) {
        c.throttle = clamp(0.2 + (target - s.gs) * 0.02 + (s.gs < 1 ? 0.08 : 0), 0, 0.36);
        c.brakeL = c.brakeR = 0;
      } else c.brakeL = c.brakeR = s.gs > target ? clamp((s.gs - target) * 0.05, 0.1, 0.6) : 0;
    }
    c.tiller = 0;
    c.yaw = clamp(angleDiff(rw.heading - clamp(fr.right * 0.4, -3, 3), s.heading) * 0.15 - s.r * 0.3, -1, 1);
  }

  /** Off the runway: the after-landing flow, then ATC's route to the stand (or the exit's start until it comes), or the taxi-in skipped. */
  taxiIn(skip: boolean) {
    const sim = this.sim;
    const s = sim.state;
    const c = sim.pilot;
    c.reverse = 0;
    c.pitch = c.roll = 0;
    c.flapLever = 0;
    c.spoilersArmed = false;
    if (skip) {
      this.hold();
      this.ask('skip-taxi-in');
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
}
