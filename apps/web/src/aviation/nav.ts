// Navigation for one flight: the flight plan's legs as the FMS flies them, the flight's phase, the
// managed speeds, and the arrival runway's ILS.
//
// The Navigator is the autopilot's NavSource: it sequences the plan's fixes with turn anticipation
// (the next leg starts where a 25° bank turn would roll out onto it), tells the phase of flight from
// what the aircraft does (taxi, takeoff roll, climb, cruise, descent, approach, final, landing,
// rollout, taxi-in), tunes the arrival ILS inside 25 NM and works out the managed speed the way
// the A320's FMGS does: V2 + 10 on the takeoff, 250 kt below FL100, the approach fix's constraint,
// then green dot / S / F by configuration and VAPP once the flaps are FULL.
//
// ilsReading() is the receiver: localizer deviation from the angle at the localizer antenna,
// glide slope deviation from the elevation angle at the glide slope antenna, DME to the threshold.

import { A320 } from './a320';
import { AIRFIELDS, onRunway, runwayFrame, type Airport, type RunwayEnd } from './airports';
import { FT, KT, NM, headingVec, vecHeading } from '../world/geo';
import type { AircraftState, Fix, FlightPlan, IlsReading, NavSource } from './types';

// ------------------------------------------------------------------------------------------------
// The ILS receiver
// ------------------------------------------------------------------------------------------------

/**
 * Display sensitivity: a localizer's full-scale deflection (2 dots) is its course half-width, tailored
 * per runway (airports.ts locHalfWidthDeg: about 105 m either side of the centreline at the
 * threshold, so 1.6° at Funfair International and 1.9° at Palm Cay); a glide slope's is 0.7° (0.12 ×
 * the 3° path each way per ICAO Annex 10, ≈ 0.35° a dot). Beyond full scale the pointers peg at the
 * edge of the scale (2.5 dots).
 */
export const GS_DEG_PER_DOT = 0.35;
const DOTS_MAX = 2.5;
/** The localizer's coverage either side of the course (deg). */
const LOC_COVERAGE_DEG = 35;
/** The arrival ILS is tuned (and the PFD shows it) inside this range of the threshold (NM). */
const TUNE_NM = 25;

const D2R = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Signed difference a − b in degrees, −180..180. */
export const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

export function emptyIls(): IlsReading {
  return { ident: '', freq: '', course: 0, dme: 0, loc: 0, gs: 0, locM: 0, gsFt: 0, valid: false };
}

/**
 * The ILS for a runway end as the aircraft's receiver sees it. The height used is the reference
 * point's (the main gear's) above the runway, which stands at y = 0, so a perfect autopilot
 * approach crosses the threshold at the published threshold crossing height (~52 ft).
 */
export function ilsReading(rw: RunwayEnd, s: AircraftState, out: IlsReading = emptyIls()): IlsReading {
  const ils = rw.ils;
  const f = headingVec(ils.course);
  const x = s.pos.x;
  const z = s.pos.z;
  const h = s.pos.y;
  out.ident = ils.ident;
  out.freq = ils.freq;
  out.course = ils.course;

  // localizer: the angle off the course line as seen from the antenna beyond the far end
  const ax = x - ils.locAntenna.x;
  const az = z - ils.locAntenna.z;
  const inFront = -(ax * f.x + az * f.z); // metres out on the approach side of the antenna
  const lateral = ax * -f.z + az * f.x; // right of the course line, looking along the landing direction
  const theta = Math.atan2(lateral, inFront) / D2R;
  // right of the centreline the runway lies to the left: the pointer swings left (negative)
  out.loc = clamp(-theta / (ils.locHalfWidthDeg / 2), -DOTS_MAX, DOTS_MAX);

  // glide slope: the elevation angle at the glide slope antenna, beside the runway at the GPI
  const gx = x - ils.gsAntenna.x;
  const gz = z - ils.gsAntenna.z;
  const elev = Math.atan2(h, Math.hypot(gx, gz)) / D2R;
  // below the path the slope is above the aircraft: positive
  out.gs = clamp((ils.slopeDeg - elev) / GS_DEG_PER_DOT, -DOTS_MAX, DOTS_MAX);

  const fr = runwayFrame(rw, x, z);
  const gpiAlong = runwayFrame(rw, ils.gpi.x, ils.gpi.z).along;
  out.locM = fr.right;
  out.gsFt = (h - (gpiAlong - fr.along) * Math.tan(ils.slopeDeg * D2R)) / FT;
  out.dme = Math.hypot(x - rw.threshold.x, z - rw.threshold.z, h) / NM;
  out.valid = inFront > 0 && Math.abs(theta) <= LOC_COVERAGE_DEG && out.dme <= ils.rangeNm;
  return out;
}

// ------------------------------------------------------------------------------------------------
// Speeds
// ------------------------------------------------------------------------------------------------

export interface VSpeeds {
  v1: number;
  vr: number;
  v2: number;
}

/**
 * Takeoff speeds for CONF 1+F, TOGA, a dry runway: V2 scales with √mass from the A320's reference
 * (146 kt at 66 t), VR is 4 kt below it and V1 2 kt below VR (a long runway: V1 close to VR).
 */
export function takeoffSpeeds(massKg: number): VSpeeds {
  const v2 = Math.round(A320.targets.v2Conf1F * Math.sqrt(massKg / A320.targets.mass));
  return { v1: v2 - 6, vr: v2 - 4, v2 };
}

/** VLS in CONF FULL for a mass: 1.23 × VS1g (107 kt at 66 t). */
export function vlsFull(massKg: number) {
  return 1.23 * A320.targets.vs1gFull * Math.sqrt(massKg / A320.targets.mass);
}

/** VAPP = VLS + a third of the headwind, at least 5 kt and at most 15 kt (FCOM). */
export function approachSpeed(vls: number, headwindKt: number) {
  return Math.round(vls + clamp(Math.max(5, headwindKt / 3), 5, 15));
}

/** The flap lever position (0..4) for a configuration index of A320.configs (0, 1, 1+F, 2, 3, FULL). */
const LEVER_OF_CONFIG = [0, 1, 1, 2, 3, 4];

/** VFE for the configuration the aircraft is in (kt). */
export function vfeFor(config: number) {
  if (config === 2) return A320.vfe1F;
  return A320.vfe[LEVER_OF_CONFIG[clamp(Math.round(config), 0, 5)]];
}

// ------------------------------------------------------------------------------------------------
// The navigator
// ------------------------------------------------------------------------------------------------

export type FlightPhase =
  | 'preflight'
  | 'boarding'
  | 'pushback'
  | 'taxi-out'
  | 'takeoff'
  | 'climb'
  | 'cruise'
  | 'descent'
  | 'approach'
  | 'final'
  | 'landing'
  | 'rollout'
  | 'taxi-in'
  | 'parked';

/** The phases in flight order, for "has the flight got this far" checks. */
export const PHASE_ORDER: readonly FlightPhase[] = ['preflight', 'boarding', 'pushback', 'taxi-out', 'takeoff', 'climb', 'cruise', 'descent', 'approach', 'final', 'landing', 'rollout', 'taxi-in', 'parked'];
export const phaseIndex = (p: FlightPhase) => PHASE_ORDER.indexOf(p);

/** Bank used for turn anticipation (the FMGS plans its fly-by turns at ~25°). */
const ANTICIPATION_BANK = 25;
/** Thrust reduction / acceleration altitude above the runway (ft). */
const ACCEL_ALT_FT = 1500;
/** A speed constraint starts to count this far before its fix (m): time to slow down to it. */
const DECEL_M = 10 * NM;
/** The 3° descent: three miles per thousand feet, plus the final and room to slow down. */
const TOD_NM_PER_1000 = 3;

export class Navigator implements NavSource {
  readonly plan: FlightPlan;
  readonly departure: Airport;
  readonly arrival: Airport;
  readonly departureRunway: RunwayEnd;
  readonly arrivalRunway: RunwayEnd;
  /** The legs flown: the plan's fixes, then the arrival runway's threshold (the final leg). */
  readonly legs: Fix[];
  /** Index of the active leg's fix in `legs`; `legs.length` once the threshold is passed. */
  activeIndex = 0;
  /** Where the active leg starts (the previous fix, or wherever a direct-to began). */
  readonly legStart = { x: 0, z: 0 };
  /** The phase of flight. preflight / boarding / pushback are set by the flight's controller; the rest follow from the aircraft. */
  phase: FlightPhase = 'preflight';
  /** Takeoff speeds, fixed when the takeoff roll starts (until then, for the current mass). */
  vSpeeds: VSpeeds = takeoffSpeeds(A320.targets.mass);
  /** Go-arounds flown so far, and whether one is in progress (until the approach is re-established). */
  goArounds = 0;
  goingAround = false;
  /** Whether the arrival ILS is tuned (inside 25 NM). */
  ilsTuned = false;
  /** The surface wind at the arrival airport, for VAPP's wind correction. */
  private arrWind = { fromDeg: 0, kt: 0 };

  private readonly ifIndex: number;
  private readonly iafIndex: number;
  private readonly fieldFt: number;
  private readonly ilsOut = emptyIls();
  private readonly legOut = { fix: null as unknown as Fix, track: 0, xtkM: 0, distM: 0 };
  private groundTime = 0;
  private readonly last = { x: 0, z: 0 };

  constructor(plan: FlightPlan) {
    this.plan = plan;
    this.departure = AIRFIELDS[plan.from];
    this.arrival = AIRFIELDS[plan.to];
    this.departureRunway = this.departure.runways[plan.depRunway];
    this.arrivalRunway = this.arrival.runways[plan.arrRunway];
    const thr = this.arrivalRunway.threshold;
    this.fieldFt = this.arrival.elevationFt;
    const rwFix: Fix = { name: `RW${plan.arrRunway}`, x: thr.x, z: thr.z, altFt: Math.round(this.fieldFt + this.arrivalRunway.ils.tchFt) };
    this.legs = [...plan.fixes, rwFix];
    this.ifIndex = this.legs.findIndex((f) => f.name === this.arrivalRunway.if);
    this.iafIndex = this.legs.findIndex((f) => f.name === this.arrivalRunway.iaf);
    // the first leg starts at the departure end of the runway: the FMS's runway-to-fix leg
    const der = this.departureRunway.end;
    this.legStart.x = der.x;
    this.legStart.z = der.z;
  }

  /** Set the arrival's surface wind (from the weather), for the approach speed's wind correction. */
  setArrivalWind(fromDeg: number, kt: number) {
    this.arrWind.fromDeg = fromDeg;
    this.arrWind.kt = kt;
  }

  /** The headwind component on the arrival runway (kt; negative is a tailwind). */
  arrivalHeadwind() {
    return this.arrWind.kt * Math.cos((this.arrWind.fromDeg - this.arrivalRunway.heading) * D2R);
  }

  /** The active leg's fix, or null once the threshold is passed. */
  get activeFix(): Fix | null {
    return this.legs[this.activeIndex] ?? null;
  }

  /**
   * Ground speed mini (kt to add to the managed approach speed): the headwind now (true airspeed
   * less ground speed) above the tower's, so a gust that raises the airspeed raises the target with
   * it and the autothrust keeps the energy for when the gust dies away (at most 15 kt; never less
   * than the speed itself, and only in the air).
   */
  groundSpeedMini(s: AircraftState) {
    if (s.onGround || s.gs < 60) return 0;
    const now = s.tas - s.gs;
    return Math.round(clamp(now - Math.max(0, this.arrivalHeadwind()), 0, 15));
  }

  /** The approach speed for the arrival (VLS in CONF FULL for the mass, plus the wind correction). */
  vapp(s: AircraftState) {
    const vls = s.config >= 5 ? s.speeds.vls : vlsFull(s.mass);
    return approachSpeed(vls, this.arrivalHeadwind());
  }

  update(dt: number, s: AircraftState) {
    this.last.x = s.pos.x;
    this.last.z = s.pos.z;
    if (phaseIndex(this.phase) >= phaseIndex('takeoff')) this.sequence(s);
    this.detectPhase(Math.max(0, dt), s);
    const thr = this.arrivalRunway.threshold;
    this.ilsTuned = Math.hypot(s.pos.x - thr.x, s.pos.z - thr.z) < TUNE_NM * NM;
    if (this.ilsTuned) ilsReading(this.arrivalRunway, s, this.ilsOut);
    else this.ilsOut.valid = false;
  }

  /** Fly direct to a fix of the plan from where the aircraft is now (ATC's "proceed direct CORAL"). */
  directTo(fix: string) {
    const i = this.legs.findIndex((f) => f.name === fix);
    if (i < 0) return;
    this.activeIndex = i;
    this.legStart.x = this.last.x;
    this.legStart.z = this.last.z;
  }

  /** A go-around: back to the initial approach fix, direct, for another approach. */
  goAround() {
    this.goArounds++;
    this.goingAround = true;
    this.phase = 'approach';
    this.directTo(this.legs[this.iafIndex >= 0 ? this.iafIndex : Math.max(0, this.ifIndex)].name);
  }

  /** Distance still to fly along the plan to the arrival threshold (m). */
  distanceToGoM(s: AircraftState) {
    const thr = this.arrivalRunway.threshold;
    if (this.activeIndex >= this.legs.length) return phaseIndex(this.phase) >= phaseIndex('rollout') ? 0 : Math.hypot(s.pos.x - thr.x, s.pos.z - thr.z);
    let d = Math.hypot(this.legs[this.activeIndex].x - s.pos.x, this.legs[this.activeIndex].z - s.pos.z);
    for (let i = this.activeIndex + 1; i < this.legs.length; i++) d += Math.hypot(this.legs[i].x - this.legs[i - 1].x, this.legs[i].z - this.legs[i - 1].z);
    return d;
  }

  /** Estimated time to the arrival threshold (s): at the ground speed in the air, at the plan's average before departure. */
  etaS(s: AircraftState) {
    const v = s.onGround && phaseIndex(this.phase) < phaseIndex('climb') ? 118 : Math.max(s.gs * KT, 60);
    return this.distanceToGoM(s) / v;
  }

  // ---------------------------------------------------------------------------------------------- NavSource

  navLeg(s: AircraftState) {
    const fix = this.legs[this.activeIndex];
    if (!fix) return null;
    let dx = fix.x - this.legStart.x;
    let dz = fix.z - this.legStart.z;
    let len = Math.hypot(dx, dz);
    if (len < 1) {
      // a direct-to that started on the fix: steer straight at it
      dx = fix.x - s.pos.x;
      dz = fix.z - s.pos.z;
      len = Math.max(1, Math.hypot(dx, dz));
    }
    const ux = dx / len;
    const uz = dz / len;
    const px = s.pos.x - this.legStart.x;
    const pz = s.pos.z - this.legStart.z;
    const o = this.legOut;
    o.fix = fix;
    o.track = vecHeading(ux, uz);
    o.xtkM = px * -uz + pz * ux;
    o.distM = Math.hypot(fix.x - s.pos.x, fix.z - s.pos.z);
    return o;
  }

  ils(_s: AircraftState): IlsReading | null {
    return this.ilsTuned ? this.ilsOut : null;
  }

  managedSpeed(s: AircraftState) {
    const p = phaseIndex(this.phase);
    if (p < phaseIndex('takeoff')) return this.vSpeeds.v2;
    if (this.phase === 'takeoff' && !this.goingAround) return this.vSpeeds.v2 + 10;
    if (p >= phaseIndex('approach')) {
      // APPR phase: green dot clean, S in CONF 1, F in CONF 1+F / 2 / 3, VAPP in FULL
      const c = s.config;
      const base = c >= 5 ? this.vapp(s) : c >= 2 ? Math.round(s.speeds.f) : c === 1 ? Math.round(s.speeds.s) : Math.round(s.speeds.greenDot);
      return base + this.groundSpeedMini(s);
    }
    // climb, cruise, descent: 250 kt below FL100, slower for a constraint ahead, never above VMAX − 5
    let v: number = s.altFt < 10000 ? A320.speedLimitLow : Math.min(300, A320.vmo - 10);
    const fix = this.legs[this.activeIndex];
    if (fix?.spdKt && Math.hypot(fix.x - s.pos.x, fix.z - s.pos.z) < DECEL_M) v = Math.min(v, fix.spdKt);
    return Math.round(Math.min(v, s.speeds.vmax - 5));
  }

  nextAltitude(_s: AircraftState): number | null {
    const p = phaseIndex(this.phase);
    if (this.goingAround) return this.legs[this.iafIndex]?.altFt ?? null;
    // climbing, the FMS climbs to the cruise altitude (the departure fixes are "at or above")
    if (p <= phaseIndex('cruise')) return this.plan.cruiseFt;
    for (let i = this.activeIndex; i < this.legs.length - 1; i++) {
      const a = this.legs[i].altFt;
      if (a !== undefined) return a;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------- internals

  /** Fly-by sequencing: switch to the next leg where a 25° turn onto it would begin. */
  private sequence(s: AircraftState) {
    const fix = this.legs[this.activeIndex];
    if (!fix) return;
    const dx = fix.x - this.legStart.x;
    const dz = fix.z - this.legStart.z;
    const len = Math.hypot(dx, dz);
    // distance still to go to the fix along the leg (negative once abeam it)
    const along = len > 1 ? ((fix.x - s.pos.x) * dx + (fix.z - s.pos.z) * dz) / len : Math.hypot(fix.x - s.pos.x, fix.z - s.pos.z);
    const next = this.legs[this.activeIndex + 1];
    let anticipate = 0;
    if (next && len > 1) {
      const turn = Math.abs(angleDiff(vecHeading(next.x - fix.x, next.z - fix.z), vecHeading(dx, dz)));
      const v = Math.max(s.gs, 140) * KT;
      const radius = (v * v) / (9.81 * Math.tan(ANTICIPATION_BANK * D2R));
      anticipate = clamp(radius * Math.tan((Math.min(turn, 150) * D2R) / 2), 60, 4 * NM);
      // a turn back on itself (direct to the initial approach fix after a go-around, then round to
      // the intermediate fix) is flown over the fix: anticipated as a fly-by it would be cut miles
      // short, joining the final leg a mile from the runway far above the glide slope
      if (turn > 100) anticipate = Math.min(anticipate, 0.3 * NM);
    }
    // the threshold is passed, not anticipated; a fix is also sequenced if it has been flown past
    if (along <= anticipate || (!next && along <= 0)) {
      this.activeIndex++;
      this.legStart.x = fix.x;
      this.legStart.z = fix.z;
    }
  }

  private detectPhase(dt: number, s: AircraftState) {
    const dep = this.departure;
    const arr = this.arrival;
    const n1 = (s.n1[0] + s.n1[1]) / 2;
    const hdg = headingVec(s.heading);
    const forward = s.vel.x * hdg.x + s.vel.z * hdg.z;
    const aboveDepFt = s.altFt - dep.elevationFt;
    this.groundTime = s.onGround ? this.groundTime + dt : 0;

    // however the approach was flown (a visual one off the localizer, say), arriving over the
    // runway low is the landing, and staying on it the rollout
    const p = phaseIndex(this.phase);
    if (p >= phaseIndex('descent') && p <= phaseIndex('final')) {
      const fr = runwayFrame(this.arrivalRunway, s.pos.x, s.pos.z);
      const overRunway = fr.along > -400 && fr.along < this.arrivalRunway.lengthM && Math.abs(fr.right) < 150;
      // (going around, the aircraft passes low over the runway without landing: only touching down counts then)
      if (overRunway && (s.onGround || (s.radioAltFt < 50 && !this.goingAround))) this.phase = 'landing';
    }

    switch (this.phase) {
      case 'preflight':
      case 'boarding':
      case 'pushback':
        // moving forward under its own power: the pushback is over
        if (s.onGround && forward > 1 && n1 > 0.15) this.phase = 'taxi-out';
        break;
      case 'taxi-out':
        if (s.onGround && onRunway(dep, s.pos.x, s.pos.z) && n1 > 0.7 && Math.abs(angleDiff(s.heading, this.departureRunway.heading)) < 25) {
          this.phase = 'takeoff';
          this.vSpeeds = takeoffSpeeds(s.mass);
        }
        if (!s.onGround) this.phase = 'takeoff';
        break;
      case 'takeoff':
        if (!s.onGround && aboveDepFt > ACCEL_ALT_FT) this.phase = 'climb';
        // a rejected takeoff: back to taxiing
        else if (s.onGround && s.gs < 25 && n1 < 0.5 && this.groundTime > 3) this.phase = 'taxi-out';
        break;
      case 'climb':
        if (s.altFt >= this.plan.cruiseFt - 250) this.phase = 'cruise';
        else if (this.topOfDescent(s) || (s.vs < -400 && this.activeIndex >= 1 && s.altFt < this.plan.cruiseFt - 400)) this.phase = 'descent';
        break;
      case 'cruise':
        if (this.topOfDescent(s) || (s.vs < -400 && s.altFt < this.plan.cruiseFt - 400)) this.phase = 'descent';
        break;
      case 'descent':
        if ((this.iafIndex >= 0 && this.activeIndex > this.iafIndex) || this.distanceToGoM(s) < 12 * NM) this.phase = 'approach';
        break;
      case 'approach':
        if (this.established(s)) {
          this.phase = 'final';
          this.goingAround = false;
        }
        break;
      case 'final':
      case 'landing': {
        if (this.goingAroundNow(s, n1)) {
          this.goAround();
          break;
        }
        if (this.phase === 'landing' && this.groundTime > 1.5 && onRunway(arr, s.pos.x, s.pos.z, 20)) this.phase = 'rollout';
        break;
      }
      case 'rollout':
        if (s.onGround && !onRunway(arr, s.pos.x, s.pos.z, 2)) this.phase = 'taxi-in';
        // a touch-and-go
        else if (!s.onGround && s.radioAltFt > 50) this.goAround();
        break;
      case 'taxi-in': {
        const st = arr.stands.find((x) => x.id === arr.playerStand);
        if (st && s.gs < 0.5 && Math.hypot(s.pos.x - st.x, s.pos.z - st.z) < 4) this.phase = 'parked';
        break;
      }
      case 'parked':
        break;
    }
  }

  /** Whether it's time to leave the cruise altitude for the approach (3° descent to the IF, plus the final and room to slow down). */
  private topOfDescent(s: AircraftState) {
    if (this.activeIndex < 1) return false;
    const ifAlt = this.legs[this.ifIndex]?.altFt ?? 1700;
    const todM = (((s.altFt - ifAlt) / 1000) * TOD_NM_PER_1000 + 9) * NM;
    return this.distanceToGoM(s) < todM;
  }

  /** Established on the final approach: localizer inside a dot, on course, short of the threshold and coming towards it. */
  private established(s: AircraftState) {
    if (!this.ilsTuned || !this.ilsOut.valid) return false;
    // after a go-around the approach is flown again from the initial approach fix
    if (this.goingAround && this.activeIndex <= this.iafIndex) return false;
    const rw = this.arrivalRunway;
    const fr = runwayFrame(rw, s.pos.x, s.pos.z);
    return Math.abs(this.ilsOut.loc) < 1 && Math.abs(angleDiff(s.track, rw.heading)) < 30 && fr.along < -300 && this.ilsOut.dme < 9 && s.altFt - this.fieldFt < 3000;
  }

  /** TOGA and climbing away on final or after touching down: a go-around. */
  private goingAroundNow(s: AircraftState, n1: number) {
    return !s.onGround && n1 > 0.8 && s.vs > 300 && s.radioAltFt > 30;
  }
}
