// The flight model's acceptance tests: the A320neo's published performance (a320.ts `targets`),
// the fly-by-wire's handling, the autopilot's captures, a full ILS approach in a crosswind with a
// manual flare, a short-field takeoff from Palm Cay and the crash detection. Run them with
//   node scripts/sim-check.mjs
// Every check flies the real model at 60 frames a second over a flat Palm Cay (the real runway,
// the sea beyond the shore) and the real AIRFIELDS; nothing is stubbed but the flight plan.

import * as THREE from 'three';
import { A320 } from './a320';
import { AIRFIELDS, flightPlan, onRunway, runwayFrame, type RunwayEnd } from './airports';
import { Autopilot } from './autopilot';
import { FlightModel } from './fdm';
import { Navigator, emptyIls, ilsReading, type FlightPhase } from './nav';
import { Air, isaWeather, makeWeather, metar, windComponents } from './weather';
import { FT, KT, NM, SEA_Y, islandShoreDist } from '../world/geo';
import { neutralControls, type AircraftState, type Controls, type FdmEvent, type Fix, type GroundQuery, type GroundSample, type IlsReading, type NavSource, type Weather } from './types';

export interface SimCheck {
  name: string;
  ok: boolean;
  /** What the model did, and what it should do. */
  value: string;
  target: string;
}

const DT = 1 / 60;
const ISL = AIRFIELDS.island;
const RW27 = ISL.runways['27'];
const T = A320.targets;

// ------------------------------------------------------------------------------------------------
// The test world
// ------------------------------------------------------------------------------------------------

// One shared object per surface: the flight model keeps the sample it gets, so it must not change.
const RUNWAY: GroundSample = Object.freeze({ y: 0, surface: 'runway' });
const GRASS: GroundSample = Object.freeze({ y: 0, surface: 'grass' });
const WATER: GroundSample = Object.freeze({ y: SEA_Y, surface: 'water' });
const APRON: GroundSample = Object.freeze({ y: 0, surface: 'apron' });

/** Palm Cay, flat: the runway with its shoulders, grass elsewhere on the island, the sea around it. */
const flatIsland: GroundQuery = (x, z) => (onRunway(ISL, x, z) ? RUNWAY : z > 30000 && islandShoreDist(x, z) > 0 ? GRASS : WATER);

/** A flight plan with one leg at a time, the arrival ILS, and the speeds the test asks for. */
class TestNav implements NavSource {
  legs: Fix[] = [];
  index = 0;
  readonly legStart = { x: 0, z: 0 };
  ilsRunway: RunwayEnd | null = null;
  speed: (s: AircraftState) => number = () => 250;
  nextAlt: number | null = null;
  private readonly ilsOut: IlsReading = emptyIls();
  private readonly legOut = { fix: null as unknown as Fix, track: 0, xtkM: 0, distM: 0 };

  navLeg(s: AircraftState) {
    let fix = this.legs[this.index];
    if (!fix) return null;
    if (Math.hypot(fix.x - s.pos.x, fix.z - s.pos.z) < 1500 && this.index < this.legs.length - 1) {
      this.legStart.x = fix.x;
      this.legStart.z = fix.z;
      fix = this.legs[++this.index];
    }
    const dx = fix.x - this.legStart.x;
    const dz = fix.z - this.legStart.z;
    const len = Math.max(1, Math.hypot(dx, dz));
    const o = this.legOut;
    o.fix = fix;
    o.track = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    o.xtkM = ((s.pos.x - this.legStart.x) * -dz + (s.pos.z - this.legStart.z) * dx) / len;
    o.distM = Math.hypot(fix.x - s.pos.x, fix.z - s.pos.z);
    return o;
  }

  ils(s: AircraftState) {
    if (!this.ilsRunway) return null;
    return ilsReading(this.ilsRunway, s, this.ilsOut);
  }

  managedSpeed(s: AircraftState) {
    return this.speed(s);
  }

  nextAltitude() {
    return this.nextAlt;
  }
}

interface Rig {
  fm: FlightModel;
  ap: Autopilot;
  nav: TestNav;
  c: Controls;
  out: Controls;
  events: FdmEvent[];
}

function rig(w: Weather = isaWeather(), seed = 1): Rig {
  const air = new Air(w, flatIsland, seed);
  const fm = new FlightModel({ ground: flatIsland, air });
  const nav = new TestNav();
  const c = neutralControls();
  c.parkingBrake = false;
  return { fm, ap: new Autopilot(nav), nav, c, out: neutralControls(), events: [] };
}

/** The A320's reference mass (66 t) as a passenger and fuel load. */
function loadTo(fm: FlightModel, mass: number) {
  const pax = Math.min(A320.seats, Math.floor((mass - A320.oew - 3000) / A320.paxMass));
  fm.setLoad(pax, mass - A320.oew - pax * A320.paxMass);
}

/** Put the rig in trimmed flight, the levers where the trim says, the guidance told it's flying. */
function airborne(r: Rig, x: number, z: number, altFt: number, heading: number, ias: number, lever: number, gear: boolean) {
  r.fm.placeInAir(x, z, altFt, heading, ias, lever, gear);
  r.c.flapLever = lever;
  r.c.gearDown = gear;
  r.c.throttle = r.fm.trim.throttle;
  r.ap.syncAirborne(r.fm.state);
}

/**
 * Fly for up to `seconds`: each frame `pilot` may move the controls (returning true ends the run),
 * then the guidance and the flight model step. Events are collected in `r.events`.
 */
function fly(r: Rig, seconds: number, pilot: (s: AircraftState, t: number) => boolean | void = () => {}, guidance = true) {
  const s = r.fm.state;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (pilot(s, i * DT)) return true;
    const ctl = guidance ? r.ap.update(DT, s, r.c, r.out) : r.c;
    for (const e of r.fm.step(DT, ctl)) r.events.push(e);
    if (r.fm.crashed) return false;
  }
  return false;
}

const f0 = (v: number) => v.toFixed(0);
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const pct = (v: number, target: number) => `${(((v - target) / target) * 100).toFixed(1)} %`;
const within = (v: number, target: number, tol: number) => Math.abs(v - target) <= tol * Math.abs(target);
const angle = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

// ------------------------------------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------------------------------------

export function runSimChecks(): SimCheck[] {
  const out: SimCheck[] = [];
  const add = (name: string, ok: boolean, value: string, target: string) => out.push({ name, ok, value, target });

  stallSpeeds(add);
  trimAndStability(add);
  climb(add);
  takeoff(add);
  shortTakeoff(add);
  rejectedTakeoff(add);
  turnAndHeading(add);
  altitudeCapture(add);
  approaches(add);
  gateToGate(add);
  hardLanding(add);
  protections(add);
  groundHandling(add);
  engineStart(add);
  weather(add);
  cost(add);
  return out;
}

type Add = (name: string, ok: boolean, value: string, target: string) => void;

/** 1 g stall speeds from the model's own polar at 66 t, sea level. */
function stallSpeeds(add: Add) {
  for (const [lever, target, label] of [
    [0, T.vs1gClean, 'clean'],
    [4, T.vs1gFull, 'CONF FULL'],
  ] as const) {
    const r = rig();
    loadTo(r.fm, T.mass);
    r.fm.placeInAir(0, 20000, 3000, 270, 200, lever, lever > 0);
    let clMax = 0;
    for (let a = 0; a <= 25; a += 0.02) clMax = Math.max(clMax, r.fm.polar(a).cl);
    const vs = Math.sqrt((2 * T.mass * 9.80665) / (1.225 * A320.wingArea * clMax)) / KT;
    add(`VS1g ${label}`, within(vs, target, 0.05), `${f1(vs)} kt (${pct(vs, target)})`, `${target} kt ±5 %`);
    add(`VS1g ${label}: speed scale agrees`, Math.abs(r.fm.state.speeds.vs1g - vs) < 1.5, `${f1(r.fm.state.speeds.vs1g)} kt`, `${f1(vs)} kt ±1.5`);
  }
}

/** Trimmed level flight at 250 kt / 5,000 ft, then a minute hands off. */
function trimAndStability(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  airborne(r, 0, 20000, 5000, 180, 250, 0, false);
  const s = r.fm.state;
  const p0 = s.pitch;
  let nz = 0;
  let vs = 0;
  let n = 0;
  fly(r, 10, () => {
    nz += s.nz;
    vs += s.vs;
    n++;
  }, false);
  nz /= n;
  vs /= n;
  add('Level cruise 250 kt / 5000 ft trims (1 g)', Math.abs(nz - 1) < 0.02 && Math.abs(vs) < 100 && Math.abs(s.ias - 250) < 2, `nz ${f2(nz)}, V/S ${f0(vs)} fpm, ${f1(s.ias)} kt; α ${f1(r.fm.trim.alphaDeg)}°, THS ${f1(r.fm.trim.thsDeg)}°, N1 ${f1(r.fm.trim.n1 * 100)} %`, 'nz 1 ±0.02, |V/S| < 100');
  let dPitch = 0;
  let dBank = 0;
  let dAlt = 0;
  const alt0 = s.altFt;
  fly(r, 60, () => {
    dPitch = Math.max(dPitch, Math.abs(s.pitch - p0));
    dBank = Math.max(dBank, Math.abs(s.bank));
    dAlt = Math.max(dAlt, Math.abs(s.altFt - alt0));
  }, false);
  add('Hands off 60 s: attitude held', dPitch < 1 && dBank < 1 && dAlt < 100, `Δpitch ${f2(dPitch)}°, bank ${f2(dBank)}°, Δalt ${f0(dAlt)} ft`, 'Δpitch < 1°, bank < 1°, Δalt < 100 ft');
}

/** Initial climb: 250 kt, CL thrust, clean, through 2,000 ft (OP CLB, the speed on the elevator). */
function climb(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  // level at 500 ft first, so the level change's gentle pitch-up (0.1 g) is over before the measurement
  airborne(r, 0, 20000, 500, 180, 250, 0, false);
  const { ap, c } = r;
  c.throttle = A320.detents.cl;
  ap.setSpd(250);
  ap.setAlt(10000);
  ap.toggleAthr();
  ap.pullAlt();
  ap.toggleAp();
  const s = r.fm.state;
  let sum = 0;
  let n = 0;
  let ias = 0;
  fly(r, 120, () => {
    if (s.altFt > 1800 && s.altFt < 2200) {
      sum += s.vs;
      ias += s.ias;
      n++;
    }
    return s.altFt > 2300;
  });
  const vs = n ? sum / n : 0;
  const iasMean = n ? ias / n : 0;
  add('Climb 250 kt, CL, clean, 2000 ft', within(vs, T.climb250, 0.2) && Math.abs(iasMean - 250) < 5, `${f0(vs)} fpm at ${f1(iasMean)} kt (${pct(vs, T.climb250)}), FMA ${ap.fcu.fma.thrust} / ${ap.fcu.fma.vertical}`, `${T.climb250} fpm ±20 %`);
}

interface TakeoffResult {
  liftoffM: number;
  liftoffKt: number;
  tailstrike: boolean;
  crashed: boolean;
  climbFpm: number;
}

/** A TOGA takeoff in CONF 1+F from a runway node, rotating at `vr` (about 3°/s to 15°). */
function flyTakeoff(r: Rig, x: number, vr: number): TakeoffResult {
  const { fm, c } = r;
  fm.placeOnGround(x, RW27.threshold.z, 270, { enginesRunning: true });
  c.flapLever = 1;
  c.gearDown = true;
  c.spoilersArmed = true;
  c.autobrake = 'max';
  c.throttle = 1;
  const s = fm.state;
  let rotating = false;
  let liftoffX = Number.NaN;
  let liftoffKt = 0;
  let climbFpm = 0;
  fly(r, 90, (st, t) => {
    if (!rotating && st.ias >= vr) rotating = true;
    // the pilot rotates at 3°/s towards 15° (the FCTM's technique), then follows the SRS bar
    if (rotating) {
      const fd = r.ap.fcu.fdPitch;
      if (st.pitch < 14 && (st.onGround || st.radioAltFt < 35)) c.pitch = clamp(0.3 + 0.12 * (3 - st.q), 0, 0.8);
      else c.pitch = fd !== null ? clamp((fd - st.pitch) * 0.15 - st.q * 0.05, -0.4, 0.4) : 0;
    }
    for (const e of r.events)
      if (e.kind === 'liftoff' && Number.isNaN(liftoffX)) {
        liftoffX = e.pos.x;
        liftoffKt = e.ias;
      }
    if (!st.onGround && st.radioAltFt > 35 && st.gear > 0.99) c.gearDown = false;
    if (st.radioAltFt > 400) climbFpm = st.vs;
    return st.radioAltFt > 500 || t > 85;
  });
  return { liftoffM: x - liftoffX, liftoffKt, tailstrike: r.events.some((e) => e.kind === 'tailstrike'), crashed: !!fm.crashed || s.time < 0, climbFpm };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The reference takeoff: 66 t, TOGA, CONF 1+F, rotate at 144 kt, from a standing start. */
function takeoff(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  const res = flyTakeoff(r, ISL.runways['27'].threshold.x - 50, 144);
  add('Takeoff ground roll (TOGA, 1+F, VR 144)', within(res.liftoffM, T.groundRollToga, 0.15) && !res.tailstrike && !res.crashed, `${f0(res.liftoffM)} m, liftoff ${f0(res.liftoffKt)} kt (${pct(res.liftoffM, T.groundRollToga)})${res.tailstrike ? ', TAILSTRIKE' : ''}`, `${T.groundRollToga} m ±15 %`);
  add('Initial climb after takeoff (TOGA, V2+10)', res.climbFpm > 2000, `${f0(res.climbFpm)} fpm at 400 ft`, '> 2000 fpm');
}

/** Palm Cay from the A4 intersection (2,100 m available) at 70 t, TOGA. */
function shortTakeoff(add: Add) {
  const r = rig();
  loadTo(r.fm, 70000);
  const entry = RW27.entries.find((e) => e.name === 'A4')!;
  const start = ISL.nodes[entry.runway];
  const vr = r.fm.sys.vr;
  const res = flyTakeoff(r, start.x, vr);
  const spare = entry.toraM - res.liftoffM;
  add(`Palm Cay A4 (TORA ${entry.toraM} m) at 70 t`, spare >= 300 && !res.tailstrike && !res.crashed, `liftoff after ${f0(res.liftoffM)} m at ${f0(res.liftoffKt)} kt (VR ${vr}), ${f0(spare)} m to spare`, '≥ 300 m to spare');
}

/**
 * A rejected takeoff at Palm Cay 27: CONF 1+F, ground spoilers armed, AUTO BRK MAX, FLX to 110 kt,
 * then the levers to idle. MAX stays armed through the roll and brakes once the spoilers deploy.
 */
function rejectedTakeoff(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  const { fm, c } = r;
  const x0 = RW27.threshold.x - 50;
  fm.placeOnGround(x0, RW27.threshold.z, 270, { enginesRunning: true });
  c.flapLever = 1;
  c.gearDown = true;
  c.spoilersArmed = true;
  c.autobrake = 'max';
  c.throttle = A320.detents.flx;
  let rejected = false;
  let active = false;
  let peak = 0;
  let prevGs = 0;
  let rejectX = 0;
  fly(r, 120, (st, t) => {
    if (!rejected && st.ias >= 110) {
      rejected = true;
      rejectX = st.pos.x;
      c.throttle = 0;
    }
    if (rejected) {
      active ||= fm.sys.autobrakeActive;
      if (t > 0) peak = Math.max(peak, ((prevGs - st.gs) * KT) / DT);
    }
    prevGs = st.gs;
    return rejected && st.gs < 1;
  }, false);
  const stopM = x0 - fm.state.pos.x;
  const left = RW27.lengthM - 50 - stopM;
  add('Rejected takeoff at 110 kt: AUTO BRK MAX brakes', active && peak > 4 && fm.state.gs < 1 && left > 300, `autobrake ${active ? 'on' : 'OFF'}, peak ${f1(peak)} m/s², stopped ${f0(rejectX - fm.state.pos.x)} m after the reject at ${f0(x0 - rejectX)} m, ${f0(left)} m to spare`, 'MAX on, > 4 m/s², ≥ 300 m to spare');
}

/** A 25° coordinated turn with ALT held, and HDG captures. */
function turnAndHeading(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  airborne(r, 0, 20000, 5000, 90, 250, 0, false);
  const { ap, c } = r;
  c.throttle = A320.detents.cl;
  ap.setSpd(250);
  ap.setAlt(5000);
  ap.toggleAthr();
  ap.pushAlt();
  ap.setHdg(260);
  ap.pullHdg();
  ap.toggleAp();
  const s = r.fm.state;
  let maxBank = 0;
  let maxBeta = 0;
  let dAlt = 0;
  let over = 0;
  fly(r, 150, () => {
    maxBank = Math.max(maxBank, Math.abs(s.bank));
    maxBeta = Math.max(maxBeta, Math.abs(s.beta));
    dAlt = Math.max(dAlt, Math.abs(s.altFt - 5000));
    over = Math.max(over, angle(s.heading, 260));
  });
  add('25° turn, AP ALT: altitude held', dAlt <= 100 && maxBank > 23 && maxBank < 27 && maxBeta < 1.5, `bank ${f1(maxBank)}°, β ${f2(maxBeta)}°, Δalt ${f0(dAlt)} ft`, 'Δalt ≤ 100 ft, bank 25°, coordinated');
  add('AP HDG 090 → 260 capture', over <= 3 && Math.abs(angle(s.heading, 260)) < 1, `overshoot ${f1(over)}°, final ${f1(s.heading)}°`, 'overshoot ≤ 3°');

  // a small change the other way
  ap.setHdg(230);
  let under = 0;
  fly(r, 60, () => {
    under = Math.max(under, angle(230, s.heading));
  });
  add('AP HDG 260 → 230 capture', under <= 3 && Math.abs(angle(s.heading, 230)) < 1, `overshoot ${f1(under)}°, final ${f1(s.heading)}°`, 'overshoot ≤ 3°');
}

/** OP CLB to 5,000 ft and OP DES to 3,000 ft: the ALT* captures. */
function altitudeCapture(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  airborne(r, 0, 20000, 3000, 180, 250, 0, false);
  const { ap, c } = r;
  c.throttle = A320.detents.cl;
  ap.setSpd(250);
  ap.setAlt(5000);
  ap.toggleAthr();
  ap.pullAlt();
  ap.toggleAp();
  const s = r.fm.state;
  let maxAlt = 0;
  let alerts = 0;
  ap.onEvent = (e) => {
    if (e === 'alt-alert') alerts++;
  };
  fly(r, 150, () => {
    maxAlt = Math.max(maxAlt, s.altFt);
  });
  add('ALT* capture climbing to 5000', maxAlt - 5000 <= 150 && ap.fcu.fma.vertical === 'ALT' && Math.abs(s.altFt - 5000) < 30, `overshoot ${f0(maxAlt - 5000)} ft, now ${ap.fcu.fma.vertical} ${f0(s.altFt)} ft, ${alerts} alert`, 'overshoot ≤ 150 ft');

  ap.setAlt(3000);
  ap.pullAlt();
  let minAlt = 1e9;
  fly(r, 150, () => {
    minAlt = Math.min(minAlt, s.altFt);
  });
  add('ALT* capture descending to 3000', 3000 - minAlt <= 150 && ap.fcu.fma.vertical === 'ALT' && Math.abs(s.altFt - 3000) < 30, `undershoot ${f0(3000 - minAlt)} ft, now ${ap.fcu.fma.vertical} ${f0(s.altFt)} ft`, 'undershoot ≤ 150 ft');
}

interface ApproachResult {
  /** Worst LOC and G/S deviations (dots) from G/S engaged to 200 ft. */
  locDots: number;
  gsDots: number;
  apOffFt: number;
  n1: number;
  td: Extract<FdmEvent, { kind: 'touchdown' }> | null;
  tdM: number;
  rollM: number;
  maxRight: number;
  crashed: string | null;
  fma: string;
}

type Touchdown = Extract<FdmEvent, { kind: 'touchdown' }>;

/**
 * The scripted pilot of a manual landing, once the autopilot has handed over at 200 ft: follows
 * the flight director's bars to 50 ft, then flares for a sink rate that falls with height to
 * ~150 fpm at the wheels, decrabs with the rudder from 40 ft, retards at 10 ft, and on the
 * ground keeps straight with the pedals, idle reverse and the autobrake until stopped.
 */
class Lander {
  td: Touchdown | null = null;
  /** Touchdown distance past the threshold, worst distance off the centreline on the rollout, and the 50 ft → stop distance (m). */
  tdM = 0;
  maxRight = 0;
  rollM = 0;
  private along50 = Number.NaN;
  private stoppedT = 0;

  constructor(private readonly rw: RunwayEnd) {}

  /** One frame; `manual` once the autopilot is off. Returns true when the aircraft has stopped. */
  frame(st: AircraftState, c: Controls, fcu: Autopilot['fcu'], events: readonly FdmEvent[], manual: boolean): boolean {
    const rw = this.rw;
    const fr = runwayFrame(rw, st.pos.x, st.pos.z);
    if (Number.isNaN(this.along50) && st.radioAltFt < 50 && !st.onGround) this.along50 = fr.along;
    for (const e of events)
      if (e.kind === 'touchdown' && e.gear === 'main' && !this.td) {
        this.td = e;
        this.tdM = runwayFrame(rw, e.pos.x, e.pos.z).along;
      }
    if (manual && !st.onGround && !this.td) {
      const ra = st.radioAltFt;
      // the stick asks for a load factor, so a gentle gain on the bar error, damped by the pitch rate, keeps the pilot out of a gust-driven PIO
      if (ra > 50 && fcu.fdPitch !== null) c.pitch = clamp((fcu.fdPitch - st.pitch) * 0.06 - st.q * 0.03, -0.3, 0.3);
      else {
        const vsT = -Math.max(130, Math.min(700, ra * 15));
        c.pitch = clamp((vsT - st.vs) * 0.0012 + (ra < 30 ? 0.05 : 0), -0.6, 0.8);
      }
      c.roll = fcu.fdBank !== null && ra > 30 ? clamp((fcu.fdBank - st.bank) * 0.04, -0.4, 0.4) : clamp(-st.bank * 0.05 - fr.right * 0.004, -0.3, 0.3);
      // decrab: in the flight law the pedals ask for sideslip (~15° at full travel), so the pedal is
      // the crab over 15, damped by the yaw rate
      c.yaw = ra < 40 ? clamp(angle(rw.heading, st.heading) / 15 - st.r * 0.08, -1, 1) : 0;
      if (ra < 10) c.throttle = 0;
    }
    if (!this.td) return false;
    // the rollout: stick neutral, idle reverse, the autobrake; steer for a heading a few degrees
    // towards the centreline, damped by the yaw rate
    c.throttle = 0;
    c.pitch = 0;
    c.roll = 0;
    c.reverse = st.gs > 60 ? 0.1 : 0;
    c.yaw = clamp(angle(rw.heading - clamp(fr.right * 0.4, -3, 3), st.heading) * 0.15 - st.r * 0.3, -1, 1);
    this.maxRight = Math.max(this.maxRight, Math.abs(fr.right));
    if (st.gs < 1) this.stoppedT += DT;
    if (this.stoppedT > 0.5) {
      this.rollM = fr.along - this.along50;
      return true;
    }
    return false;
  }
}

/**
 * A full autopilot ILS approach to Palm Cay 27: from 3 NM outside PC27I, offset 900 m north and
 * intercepting at 20°, 1,700 ft, 180 kt in CONF 2; gear down and CONF 3 at G/S capture, FULL at
 * 1,700 ft, managed speed to VAPP; the autopilot hands over at 200 ft, then a scripted pilot
 * follows the flight director, flares, decrabs, retards, and stops with autobrake MED and idle reverse.
 */
function flyApproach(w: Weather): ApproachResult {
  const r = rig(w, 7);
  loadTo(r.fm, T.mass);
  const { ap, c, nav, fm } = r;
  const s = fm.state;
  const pc27i = { x: RW27.threshold.x + 5 * NM, z: RW27.threshold.z };
  const head = windComponents(w, RW27.heading).head;
  nav.ilsRunway = RW27;
  nav.legs = [{ name: 'PC27I', x: pc27i.x, z: pc27i.z, altFt: 1700 }];
  // VAPP = VLS + a third of the headwind (5 to 15 kt); with strong gusts the crew selects the gust
  // increment instead, as the FCOM allows, within the same 15 kt
  const gust = Math.max(0, w.gustKt - w.windKt);
  nav.speed = (st) => (st.config >= 5 ? Math.round(st.speeds.vls + Math.min(15, Math.max(5, head / 3, gust))) : st.config >= 3 ? Math.round(st.speeds.f) : 180);
  airborne(r, pc27i.x + 3 * NM, pc27i.z - 900, 1700, 250, 180, 2, false);
  c.throttle = A320.detents.cl;
  c.spoilersArmed = true;
  c.autobrake = 'med';
  ap.setAlt(1700);
  ap.setHdg(250);
  ap.toggleAthr();
  ap.pushAlt();
  ap.pullHdg();
  ap.pushAppr();
  ap.toggleAp();

  const res: ApproachResult = { locDots: 0, gsDots: 0, apOffFt: 0, n1: 0, td: null, tdM: 0, rollM: 0, maxRight: 0, crashed: null, fma: '' };
  let n1Sum = 0;
  let n1N = 0;
  let gsT = 0;
  let manual = false;
  const lander = new Lander(RW27);
  const ils = emptyIls();
  ap.onEvent = (e) => {
    if (e === 'ap-off' && !manual) {
      manual = true;
      res.apOffFt = s.radioAltFt;
    }
  };
  fly(r, 600, (st) => {
    const fma = ap.fcu.fma;
    // configuration as the approach goes on
    if (fma.vertical === 'G/S*' || fma.vertical === 'G/S') {
      c.gearDown = true;
      if (c.flapLever < 3) c.flapLever = 3;
    }
    if (c.flapLever === 3 && st.altFt < 1500) c.flapLever = 4;
    if (fma.vertical === 'G/S') gsT += DT;
    ilsReading(RW27, st, ils);
    if (gsT > 15 && !manual && st.radioAltFt > 200) {
      res.locDots = Math.max(res.locDots, Math.abs(ils.loc));
      res.gsDots = Math.max(res.gsDots, Math.abs(ils.gs));
    }
    if (st.radioAltFt < 1000 && st.radioAltFt > 500 && fma.vertical === 'G/S') {
      n1Sum += (st.n1[0] + st.n1[1]) / 2;
      n1N++;
    }
    const stopped = lander.frame(st, c, ap.fcu, r.events, manual);
    r.events.length = 0;
    return stopped;
  });
  res.n1 = n1N ? n1Sum / n1N : 0;
  res.td = lander.td;
  res.tdM = lander.tdM;
  res.rollM = lander.rollM;
  res.maxRight = lander.maxRight;
  res.crashed = fm.crashed;
  res.fma = `${ap.fcu.fma.lateral}/${ap.fcu.fma.vertical}`;
  return res;
}

function approaches(add: Add) {
  // calm ISA: the reference approach N1 and landing roll
  const calm = flyApproach(isaWeather());
  add('Approach N1 (3° ILS, VAPP, FULL, gear down)', Math.abs(calm.n1 - T.approachN1) <= 0.05, `${f1(calm.n1 * 100)} %`, `${f0(T.approachN1 * 100)} % ±5`);
  add('Landing roll 50 ft → stop (autobrake MED, idle rev)', within(calm.rollM, T.landingRollMed, 0.2) && !calm.crashed, `${f0(calm.rollM)} m (${pct(calm.rollM, T.landingRollMed)})`, `${T.landingRollMed} m ±20 %`);

  // 15 kt straight across from the right, with light turbulence
  const w = isaWeather({ windFrom: 360, windKt: 15, turbulence: 0.25, tempC: 28, qnh: 1012 });
  const xw = flyApproach(w);
  add('AP ILS from PC27I, 15 kt crosswind: LOC', xw.locDots <= 0.3, `max ${f2(xw.locDots)} dots`, '±0.3 dots to 200 ft');
  add('AP ILS from PC27I, 15 kt crosswind: G/S', xw.gsDots <= 0.3, `max ${f2(xw.gsDots)} dots`, '±0.3 dots to 200 ft');
  add('AP disconnects at 200 ft for the manual landing', xw.apOffFt > 150 && xw.apOffFt <= 205, `AP off at ${f0(xw.apOffFt)} ft RA`, '200 ft');
  const td = xw.td;
  const tdz = RW27.tdz;
  add(
    'Scripted flare: touchdown 100–300 fpm in the TDZ',
    !!td && td.vsFpm >= 100 && td.vsFpm <= 300 && Math.abs(td.crabDeg) <= 5 && xw.tdM >= tdz.from && xw.tdM <= tdz.to && !xw.crashed,
    td ? `${td.vsFpm} fpm, ${f2(td.g)} g, ${f0(xw.tdM)} m past the threshold, crab ${f1(td.crabDeg)}°, bank ${f1(td.bank)}°, pitch ${f1(td.pitch)}°, ${f0(td.ias)} kt` : `no touchdown (${xw.crashed ?? xw.fma})`,
    `100–300 fpm, ${tdz.from}–${tdz.to} m, crab ≤ 5°`,
  );
  add('Crosswind rollout stays on the runway', xw.maxRight < 18 && !xw.crashed, `max ${f1(xw.maxRight)} m off the centreline, stopped after ${f0(xw.rollM)} m`, '< 18 m');

  // the roughest day the weather rolls: 22 kt gusting 34, 50° off the runway, moderate turbulence
  const rough = flyApproach(isaWeather({ windFrom: 320, windKt: 22, gustKt: 34, turbulence: 0.8, tempC: 30, qnh: 1009 }));
  const rtd = rough.td;
  add(
    'Gusty 32022G34KT: AP ILS, hand landing intact',
    !!rtd && !rough.crashed && rough.locDots < 1 && rough.gsDots < 1 && rtd.vsFpm < 600 && rough.tdM >= tdz.from && rough.tdM <= tdz.to + 300 && rough.maxRight < 18,
    rtd ? `LOC ${f2(rough.locDots)} / G/S ${f2(rough.gsDots)} dots; ${rtd.vsFpm} fpm, ${f2(rtd.g)} g, ${f0(rough.tdM)} m, crab ${f1(rtd.crabDeg)}°, ${f1(rough.maxRight)} m off` : `no touchdown (${rough.crashed ?? rough.fma})`,
    'within 1 dot, < 600 fpm, on the runway',
  );
}

/**
 * FA101 runway to runway: Funfair 27 to Palm Cay 27 on the real Navigator and flight plan, in a
 * 10 kt north-westerly with light turbulence. The scripted crew takes off at TOGA in CONF 1+F
 * (rotating at VR on the flight director), raises the gear, engages the autopilot at 100 ft with
 * NAV and managed climb armed, sets the levers to CL at "LVR CLB", cleans up at S; cruises at
 * 5,000 ft; starts a managed descent at the top of descent; arms APPR in the approach phase,
 * configures by the speeds (1 at green dot, 2 at S, gear and 3 at the glide slope, FULL below
 * 1,500 ft); and lands by hand from 200 ft. The flight must arrive in the touchdown zone, intact.
 */
function gateToGate(add: Add) {
  const HOME = AIRFIELDS.home;
  const ground: GroundQuery = (x, z) => (onRunway(HOME, x, z) || onRunway(ISL, x, z) ? RUNWAY : WATER);
  const w = isaWeather({ windFrom: 300, windKt: 10, turbulence: 0.2, tempC: 29, qnh: 1011 });
  const fm = new FlightModel({ ground, air: new Air(w, ground, 3) });
  fm.setLoad(150, A320.blockFuel);
  const plan = flightPlan('home', '27', '27');
  const nav = new Navigator(plan);
  nav.setArrivalWind(w.windFrom, w.windKt);
  const ap = new Autopilot(nav);
  const dep = HOME.runways['27'];
  fm.placeOnGround(dep.threshold.x - 20, dep.threshold.z, dep.heading, { enginesRunning: true });
  nav.phase = 'taxi-out';
  const s = fm.state;
  const c = neutralControls();
  const out = neutralControls();
  c.parkingBrake = false;
  c.flapLever = 1;
  c.spoilersArmed = true;
  c.autobrake = 'max';
  ap.setAlt(plan.cruiseFt);
  ap.setSpd(null);
  ap.pushHdg();
  c.throttle = 1;

  const lander = new Lander(RW27);
  let rotating = false;
  let engaged = false;
  let manual = false;
  let descending = false;
  let apprArmed = false;
  let liftoffT = -1;
  let tdT = -1;
  let maxAlt = 0;
  let maxBank = 0;
  let maxNz = 1;
  let minNz = 1;
  let maxLowIas = 0;
  let stopped = false;
  const phases = new Set<FlightPhase>();
  ap.onEvent = (e) => {
    if (e === 'ap-off' && engaged) manual = true;
  };
  for (let i = 0; i < 1500 / DT && !stopped && !fm.crashed; i++) {
    nav.update(DT, s);
    // (widened: the compiler can't see update() moving the phase on from the one set above)
    const phase = nav.phase as FlightPhase;
    phases.add(phase);
    const fcu = ap.fcu;
    if (liftoffT < 0) {
      // the takeoff roll: straight down the centreline, rotate at VR towards 15° at 3°/s
      const fr = runwayFrame(dep, s.pos.x, s.pos.z);
      c.yaw = s.onGround ? clamp(angle(dep.heading - clamp(fr.right * 0.4, -3, 3), s.heading) * 0.15 - s.r * 0.3, -1, 1) : 0;
      if (s.ias >= nav.vSpeeds.vr) rotating = true;
      if (rotating) c.pitch = clamp(0.3 + 0.12 * (3 - s.q), 0, 0.8);
      // off the ground the rotation input gives way to the bars, or the pull carries on into the climb
      if (!s.onGround) liftoffT = s.time;
    } else if (!engaged) {
      // hand-flown on the bars until the autopilot can go in
      c.yaw = 0;
      c.pitch = fcu.fdPitch !== null ? clamp((fcu.fdPitch - s.pitch) * 0.06 - s.q * 0.06, -0.2, 0.2) : 0;
      c.roll = fcu.fdBank !== null ? clamp((fcu.fdBank - s.bank) * 0.04, -0.3, 0.3) : 0;
      if (s.radioAltFt > 100) {
        ap.toggleAp();
        if (fcu.ap) {
          engaged = true;
          c.pitch = c.roll = 0;
        }
      }
    }
    if (!s.onGround && s.vs > 300 && s.radioAltFt > 35) c.gearDown = false;
    if (ap.lvrClb) c.throttle = A320.detents.cl;
    // clean up at S on the climb
    if (phase === 'climb' && c.flapLever === 1 && s.ias > s.speeds.s) c.flapLever = 0;
    if (phase === 'descent' && !descending) {
      descending = true;
      ap.setAlt(1700);
      ap.pushAlt();
    }
    if (phase === 'approach' && !apprArmed) {
      apprArmed = true;
      ap.pushAppr();
      c.autobrake = 'med';
    }
    if (apprArmed && !manual) {
      // configure by the speeds, never above the next VFE
      if (c.flapLever === 0 && s.ias < s.speeds.greenDot + 10 && s.ias < A320.vfe[1]) c.flapLever = 1;
      else if (c.flapLever === 1 && s.ias < s.speeds.s + 10 && s.ias < A320.vfe[2]) c.flapLever = 2;
      if (fcu.fma.vertical === 'G/S*' || fcu.fma.vertical === 'G/S') {
        c.gearDown = true;
        if (c.flapLever < 3 && s.ias < A320.vfe[3]) c.flapLever = 3;
      }
      if (c.flapLever === 3 && s.altFt < 1500 && s.ias < A320.vfe[4]) c.flapLever = 4;
    }
    const ctl = ap.update(DT, s, c, out);
    const events = fm.step(DT, ctl);
    if (lander.frame(s, c, fcu, events, manual)) stopped = true;
    if (lander.td && tdT < 0) tdT = s.time;
    if (!s.onGround && liftoffT >= 0) {
      maxAlt = Math.max(maxAlt, s.altFt);
      maxBank = Math.max(maxBank, Math.abs(s.bank));
      maxNz = Math.max(maxNz, s.nz);
      minNz = Math.min(minNz, s.nz);
      if (s.altFt < 10000) maxLowIas = Math.max(maxLowIas, s.ias);
    }
  }
  const td = lander.td;
  const tdz = RW27.tdz;
  const airS = tdT > 0 ? tdT - liftoffT : 0;
  const ok = !!td && !fm.crashed && stopped && td.vsFpm <= 360 && lander.tdM >= tdz.from && lander.tdM <= tdz.to && Math.abs(maxAlt - plan.cruiseFt) < 150 && maxBank < 27 && maxNz < 1.3 && minNz > 0.7 && phases.has('cruise');
  add(
    'FA101 runway to runway: AP NAV, CLB, DES, APPR, hand landing',
    ok,
    td ? `${Math.floor(airS / 60)} min ${f0(airS % 60)} s airborne, max ${f0(maxAlt)} ft, ${f0(maxLowIas)} kt, bank ≤ ${f1(maxBank)}°, ${f2(minNz)}–${f2(maxNz)} g; touchdown ${td.vsFpm} fpm ${f0(lander.tdM)} m in${fm.crashed ? `, ${fm.crashed}` : ''}` : `no landing (${fm.crashed ?? `${nav.phase}, ${ap.fcu.fma.lateral}/${ap.fcu.fma.vertical}`})`,
    `cruise ${plan.cruiseFt} ft, TDZ ${tdz.from}–${tdz.to} m, ≤ 360 fpm`,
  );
}

/** A 3,000 fpm arrival on the runway: the gear can't take it. */
function hardLanding(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  airborne(r, 0, RW27.threshold.z, 1.2 / FT + 12, 270, 137, 4, true);
  r.fm.setVerticalSpeed(-3000);
  fly(r, 5, () => {}, false);
  const crash = r.events.find((e) => e.kind === 'crash');
  add('3000 fpm touchdown crashes', !!crash, crash && crash.kind === 'crash' ? `crash: ${crash.reason} at ${crash.vsFpm} fpm` : 'no crash', 'crash event');
}

/**
 * Normal law, the flight-test way: in CONF FULL at idle the pilot holds the altitude while the speed
 * decays until α protection engages, then pulls the stick fully back and holds it. The aircraft must
 * settle at α max (below the stall) and VαMAX, sinking, not stall. Then the bank limits.
 */
function protections(add: Add) {
  const r = rig();
  loadTo(r.fm, T.mass);
  airborne(r, 0, 20000, 4000, 180, 160, 4, true);
  const s = r.fm.state;
  r.c.throttle = 0;
  let maxAlpha = 0;
  let protT = -1;
  let iasSum = 0;
  let iasN = 0;
  let floor = false;
  const stall = A320.configs[5].alphaStall;
  fly(r, 120, (st, t) => {
    if (protT < 0 && r.fm.sys.alphaProt) protT = t;
    r.c.pitch = protT < 0 ? clamp((4000 - st.altFt) * 0.004 - st.vs * 0.0006, -1, 1) : 1;
    if (protT >= 0) {
      maxAlpha = Math.max(maxAlpha, st.alpha);
      floor ||= st.alphaFloor;
      // the steady state, once the pitch has settled after the pull
      if (t > protT + 20) {
        iasSum += st.ias;
        iasN++;
      }
    }
    return protT >= 0 && t > protT + 35;
  }, false);
  const ias = iasN ? iasSum / iasN : 0;
  add('α protection: full back stick, idle, FULL', protT > 0 && maxAlpha < stall && Math.abs(ias - s.speeds.vamax) < 6, `α max ${f1(maxAlpha)}° (stall ${stall}°), steady ${f0(ias)} kt (VαMAX ${f0(s.speeds.vamax)})${floor ? ', α floor' : ''}`, `α < ${stall}°, VαMAX ±6 kt`);

  // full right stick for 12 s, then released; the pilot pulls to hold the altitude as a real one
  // would (Airbus's bank compensation stops at 33°, beyond it the pilot must pull or the nose drops)
  const b = rig();
  loadTo(b.fm, T.mass);
  airborne(b, 0, 20000, 5000, 180, 250, 0, false);
  let maxBank = 0;
  let after = 0;
  fly(b, 30, (st, t) => {
    b.c.roll = t < 12 ? 1 : 0;
    b.c.pitch = clamp((5000 - st.altFt) * 0.004 - st.vs * 0.0006, -1, 1);
    maxBank = Math.max(maxBank, Math.abs(st.bank));
    if (t > 28) after = Math.abs(st.bank);
  }, false);
  add('Bank protection: full stick 67°, back to 33° released', maxBank <= 67.5 && maxBank > 60 && Math.abs(after - 33) < 3, `max ${f1(maxBank)}°, released ${f1(after)}°`, '≤ 67°, then 33°');
}

/**
 * On the ground: idle alone doesn't break the aircraft away but a touch of thrust (~35–40 % N1)
 * does, after which it creeps faster at idle; 45° of tiller turns it about a point a wheelbase
 * from the mains (radius = wheelbase / tan 45°); the brakes stop it and hold it; and a pushback
 * (the tow tractor's kinematic path) hands over to the physics without a bump.
 */
function groundHandling(add: Add) {
  const pave: GroundQuery = () => APRON;
  const fm = new FlightModel({ ground: pave, air: new Air(isaWeather(), pave) });
  loadTo(fm, 64000);
  fm.placeOnGround(0, 0, 0, { enginesRunning: true });
  const c = neutralControls();
  c.parkingBrake = false;
  const s = fm.state;
  const run = (seconds: number, each: (t: number) => void = () => {}) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      each(i * DT);
      fm.step(DT, c);
    }
  };
  run(5);
  const idleStill = s.gs < 0.2;
  // the levers forward until it rolls
  let breakN1 = 0;
  c.throttle = 0.25;
  run(15, () => {
    if (!breakN1 && s.gs > 0.5) breakN1 = s.n1[0];
    if (breakN1) c.throttle = 0;
  });
  c.throttle = 0;
  const gs0 = s.gs;
  run(20);
  const creep = s.gs - gs0;
  // a steady tiller turn
  c.tiller = 0.6;
  let radius = 0;
  run(25, (t) => {
    if (t > 15) radius = (s.gs * KT) / Math.max(1e-3, Math.abs(s.r) * (Math.PI / 180));
  });
  c.tiller = 0;
  run(5);
  // the toe brakes, then held
  c.brakeL = c.brakeR = 0.6;
  run(8);
  const x0 = s.pos.x;
  const z0 = s.pos.z;
  run(10);
  const held = Math.hypot(s.pos.x - x0, s.pos.z - z0);
  const target = A320.wheelbase / Math.tan((0.6 * A320.tillerMax * Math.PI) / 180);
  add(
    'Taxi: breakaway, idle creep, tiller turn, brakes',
    idleStill && breakN1 > 0.3 && breakN1 < 0.45 && creep > 0 && within(radius, target, 0.25) && held < 0.05,
    `${idleStill ? 'idle holds' : 'IDLE ROLLS'}, rolls at N1 ${f1(breakN1 * 100)} %, idle +${f1(creep)} kt in 20 s, radius ${f1(radius)} m, held ${f2(held)} m`,
    `breakaway 30–45 % N1, radius ${f1(target)} m ±25 %, held < 0.05 m`,
  );

  // a pushback: 40 m straight back, then a 90° turn tail-left onto a taxilane, then released
  const p = new FlightModel({ ground: pave, air: new Air(isaWeather(), pave) });
  loadTo(p, 64000);
  p.placeOnGround(0, 0, 0, { enginesRunning: true });
  const ps = p.state;
  const pc = neutralControls();
  let x = 0;
  let z = 0;
  let hdg = 0;
  let maxSwivel = 0;
  for (let i = 0; i < 40 / DT; i++) {
    z += 1 * DT;
    p.tow(x, z, hdg, DT);
  }
  // reversing round an arc of 30 m radius about a centre to the aircraft's left
  for (let i = 0; i < ((Math.PI / 2) * 30) / DT; i++) {
    hdg += ((1 / 30) * 180) / Math.PI * DT;
    const h = (hdg * Math.PI) / 180;
    x = -30 + 30 * Math.cos(h);
    z = 40 + 30 * Math.sin(h);
    p.tow(x, z, hdg, DT);
    maxSwivel = Math.max(maxSwivel, Math.abs(ps.nosewheel));
  }
  let maxVy = 0;
  let bumps = 0;
  for (let i = 0; i < 10 / DT; i++) {
    for (const e of p.step(DT, pc)) if (e.kind === 'touchdown' || e.kind === 'crash') bumps++;
    maxVy = Math.max(maxVy, Math.abs(ps.vel.y));
  }
  add(
    'Pushback: tow round a 90° arc, then released',
    maxVy < 0.05 && bumps === 0 && ps.gs < 0.2 && Math.abs(angle(ps.heading, 90)) < 1 && maxSwivel > 10,
    `heading ${f1(ps.heading)}°, nosewheel up to ${f0(maxSwivel)}°, max |vy| ${f2(maxVy)} m/s after release, ${bumps} events`,
    'heading 090, no bump, stands still',
  );
}

function engineStart(add: Add) {
  const r = rig();
  r.fm.placeOnGround(0, RW27.threshold.z, 270);
  r.fm.startEngine(0);
  let at = 0;
  r.c.parkingBrake = true;
  fly(r, 40, (st, t) => {
    if (!at && r.fm.sys.engineRunning[0]) at = t;
    return at > 0 && st.n1[0] > 0;
  }, false);
  const n1 = r.fm.state.n1[0];
  add('Engine start: N1 0 → idle', at > 20 && at < 30 && Math.abs(n1 - A320.n1Idle) < 0.01, `${f1(at)} s, N1 ${f1(n1 * 100)} %`, '~25 s to idle');
}

function weather(add: Add) {
  const a = JSON.stringify(makeWeather(101, 'day'));
  const b = JSON.stringify(makeWeather(101, 'day'));
  let ok = a === b;
  let minW = 99;
  let maxW = 0;
  let minV = 1e9;
  let maxV = 0;
  let maxG = 0;
  let gusty = 0;
  let gapOk = true;
  let fmtOk = true;
  for (let i = 0; i < 300; i++) {
    const tod = (['dawn', 'day', 'dusk', 'night'] as const)[i % 4];
    const w = makeWeather(i, tod);
    minW = Math.min(minW, w.windKt);
    maxW = Math.max(maxW, w.windKt);
    maxG = Math.max(maxG, w.gustKt);
    if (w.gustKt) {
      gusty++;
      if (w.gustKt < w.windKt + 10) gapOk = false;
    }
    if (tod !== 'dawn') minV = Math.min(minV, w.visibilityM);
    maxV = Math.max(maxV, w.visibilityM);
    const m = metar(w, 'XPCY', 13, 19);
    if (!/^XPCY 191300Z (\d{5}(G\d{2})?KT|VRB\d{2}KT|00000KT) (CAVOK|\d{4}( BR)?( (FEW|SCT|BKN|OVC)\d{3})+|\d{4}( BR)? NSC) \d{2}\/\d{2} Q\d{4} NOSIG$/.test(m)) fmtOk = false;
  }
  ok &&= minW >= 4 && maxW <= 18 && maxG <= 25 && gapOk && gusty > 10 && minV >= 8000 && maxV <= 40000;
  add('Weather: deterministic, winds 4–18 kt, gusts ≤ 25 kt, vis 8–40 km', ok, `wind ${minW}–${maxW} kt, gusts to ${maxG} kt (${gusty} of 300 days), vis ${f0(minV / 1000)}–${f0(maxV / 1000)} km`, '4–18 kt, G ≤ 25, 8–40 km');
  add('METAR format', fmtOk, metar(makeWeather(7, 'day'), 'XPCY', 13, 19), 'ICAO METAR');
  const wc = windComponents(isaWeather({ windFrom: 360, windKt: 15 }), 270);
  const wh = windComponents(isaWeather({ windFrom: 270, windKt: 10 }), 270);
  add('Wind components', Math.abs(wc.cross - 15) < 0.01 && Math.abs(wc.head) < 0.01 && Math.abs(wh.head - 10) < 0.01, `360/15 on 27: cross ${f1(wc.cross)}, head ${f1(wc.head)}; 270/10: head ${f1(wh.head)}`, 'cross +15 (from the right), head 10');
  // the air: ISA density at 5,000 ft, and the wind profile (the mean over 15 km and 15 minutes: any
  // one sample has the turbulence and the lulls in it)
  const air = new Air(isaWeather({ windFrom: 90, windKt: 20 }), flatIsland);
  const smp = { wind: new THREE.Vector3(), density: 0, soundSpeed: 0, oatC: 0 };
  const at = new THREE.Vector3(0, SEA_Y + 5000 * FT, 20000);
  air.sample(at, smp);
  const rho5 = smp.density;
  const mean = (hM: number) => {
    const sum = new THREE.Vector3();
    const n = 3000;
    for (let i = 0; i < n; i++) {
      air.step(DT, i * 0.3);
      air.sample(at.set(-7500 + i * 5, SEA_Y + hM, 20000), smp);
      sum.add(smp.wind);
    }
    return sum.divideScalar(n);
  };
  const m10 = mean(10);
  const w10 = m10.length() / KT;
  // blowing from 090: towards the west
  const fromDeg = (((Math.atan2(-m10.x, m10.z) * 180) / Math.PI) + 360) % 360;
  const w300 = mean(300).length() / KT;
  const w300Target = 20 * Math.pow(30, 1 / 7);
  add(
    'ISA density at 5000 ft; wind 10 m and 300 m',
    Math.abs(rho5 - 1.0556) < 0.005 && Math.abs(w10 - 20) < 1 && Math.abs(angle(fromDeg, 90)) < 3 && Math.abs(w300 - w300Target) < 1.5,
    `ρ ${rho5.toFixed(4)} kg/m³, ${f0(fromDeg)}/${f1(w10)} kt at 10 m, ${f1(w300)} kt at 300 m`,
    `ρ 1.0556, 090/20, ${f1(w300Target)} kt (1/7 power law)`,
  );
}

/** The cost of one 60 Hz frame of the flight model (4 substeps), in turbulence near the ground. */
function cost(add: Add) {
  const w = isaWeather({ windFrom: 30, windKt: 18, gustKt: 28, turbulence: 0.6 });
  const r = rig(w);
  loadTo(r.fm, T.mass);
  airborne(r, RW27.threshold.x + 3000, RW27.threshold.z, 500, 270, 150, 3, true);
  const c = r.c;
  // warm up, then time
  for (let i = 0; i < 300; i++) r.fm.step(DT, c);
  const frames = 3000;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) r.fm.step(DT, c);
  const ms = (performance.now() - t0) / frames;
  add('step() cost per 60 Hz frame', ms < 0.25, `${ms.toFixed(3)} ms`, '< 0.25 ms');
}
