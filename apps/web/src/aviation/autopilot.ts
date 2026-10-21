// The A320's flight guidance: the FCU's selections, the flight mode annunciator, the flight
// director, the autopilot and the autothrust.
//
// Like the real FMGC, the autopilot doesn't move control surfaces: it flies the fly-by-wire
// through the same normal law the pilot does, with small, smooth sidestick demands (load factor in
// pitch, roll rate in roll), so its manoeuvres are as gentle as an airliner's (±0.1 g, 5°/s of roll,
// 25° of bank) and every protection still applies. The guidance is computed whether the autopilot
// is engaged or not, so the PFD's flight director bars always show what it would do.
//
// Modes follow the Airbus FMA:
//   thrust    MAN TOGA / MAN FLX (levers beyond CL), THR CLB, THR IDLE, SPEED, A.FLOOR, TOGA LK,
//             THR LVR (levers between IDLE and CL)
//   vertical  SRS on takeoff (V2 + 10 on the elevator), CLB / OP CLB and DES / OP DES (speed on the
//             elevator, thrust fixed), ALT* / ALT, V/S, G/S* / G/S
//   lateral   RWY on the takeoff roll, RWY TRK after liftoff, HDG, NAV, LOC* / LOC
// The autothrust works with the levers in the CL detent (it never commands more than the levers'
// position); beyond CL the thrust is manual. The levers' climb detent after takeoff is the pilot's
// job ("LVR CLB" flashes at the thrust reduction altitude). On an ILS approach the autopilot
// disconnects at 200 ft for the manual landing (the cavalry charge), the flight director stays, and
// the autothrust retards to idle at 20 ft ("RETARD"); it disconnects when the levers reach idle or
// the aircraft touches down.
//
// With an autoland briefed (`autoland`) the autopilot stays in: LAND from 400 ft (the localizer and
// the glide slope both held, the rudder joining in from 60 ft to line the nose up with the runway),
// FLARE from 50 ft (the sink eased off with height, a wing down into the crosswind from 30 ft,
// RETARD at 10 ft rather than 20), and
// ROLL OUT on the runway (the nose wheel down, the rudder and the nose wheel on the localizer) until
// the crew disconnect it at taxi speed.

import { A320 } from './a320';
import { leverN1, n1Lever } from './fdm';
import { FPM, KT, headingVec } from '../world/geo';
import type { AircraftState, Controls, FcuState, LandMode, LateralMode, NavSource, ThrustMode, VerticalMode } from './types';

const G = 9.80665;
const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const approach = (v: number, target: number, rate: number) => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
/** Signed difference a − b in degrees, −180..180. */
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

export type ApEvent = 'ap-off' | 'athr-off' | 'alt-alert' | 'a-floor' | 'ap-on' | 'mode';

/** How close to a detent the levers count as in it. */
const DETENT_TOL = 0.03;
/** Thrust reduction and acceleration altitude (ft above the runway). */
const THR_RED_FT = 1500;
/** The autopilot can be engaged this high and this long after liftoff. */
const AP_MIN_FT = 100;
const AP_MIN_S = 5;
/** On an ILS approach the autopilot hands over at this radio height (manual landing). */
const AP_OFF_APPR_FT = 200;
/** The autoland: LAND engages below this radio height, FLARE below the next. */
const LAND_FT = 400;
const FLARE_FT = 50;
/** How fast the autopilot's sidestick may move in the flare and the roll out (per second): the flare's pull is quick. */
const FLARE_SLEW = 2.5;
/** The autothrust retards to idle at this radio height on the approach. */
const RETARD_FT = 20;
/** An autoland retards later, at 10 ft: the thrust holds the speed through the flare. */
export const AUTOLAND_RETARD_FT = 10;
/** Sidestick deflection that disconnects the autopilot (the pilot taking over). */
const INSTINCTIVE = 0.5;
/** How fast the autopilot's sidestick orders may change (per second). */
const STICK_SLEW = 0.25;
/** Guidance limits: bank, roll rate (°/s), and the load factor change (g) of normal manoeuvres and captures. */
const BANK_LIMIT = 25;
const ROLL_RATE = 5;
const NZ_LIMIT = 0.1;
const NZ_CAPTURE = 0.15;
/** Heading/track hold: the time constant of the turn's exponential approach to the target (s). */
const TURN_TAU = 6;
/** ALT*: the time constant of the asymptotic capture (s); ALT: altitude error → vertical speed. */
const ALT_CAPTURE_TAU = 8;
const ALT_HOLD_TAU = 10;
/** Flight path response (1/s), and the speed loop on the elevator (1/s; acceleration per knot of error). */
const GAMMA_K = 0.5;
const SPEED_ELEV_K = 0.6;
const ACCEL_PER_KT = 0.12 * KT;
const ACCEL_MAX = 0.5;
/** Lateral guidance: the time constant of closing a cross-track or localizer offset (s). */
const NAV_TAU = 20;
const LOC_TAU = 16;
/** Glide slope: closing a height error off the path (s). */
const GS_TAU = 7;
/** The SRS's attitude limit and the climb modes' least vertical speed (fpm). */
const SRS_PITCH_MAX = 18;
const CLIMB_MIN_FPM = 300;
/** Autothrust: N1 per second per m/s² of acceleration error, and its proportional term. */
const ATHR_KI = 0.07;
const ATHR_KP = 0.03;
/**
 * How fast the autothrust moves to a fixed thrust (THR CLB, THR IDLE): N1 per second. The real one
 * eases the thrust to climb over a dozen seconds rather than slamming it, for the passengers and
 * so the pitch-up of a level change keeps pace with it.
 */
const ATHR_SLEW = 0.03;
/** The altitude alert sounds when approaching within 750 ft of the selected altitude, or leaving a captured one by 250 ft. */
const ALERT_APPROACH_FT = 750;
const ALERT_DEVIATE_FT = 250;

/** Vertical modes in which the speed is flown on the elevator. */
const SPEED_ON_ELEVATOR: ReadonlySet<VerticalMode> = new Set(['SRS', 'CLB', 'OP CLB', 'DES', 'OP DES']);

/** Whether a mode is one of the autoland's (LAND, FLARE, ROLL OUT). */
export const isLandMode = (m: VerticalMode | LateralMode): m is LandMode => m === 'LAND' || m === 'FLARE' || m === 'ROLL OUT';

export class Autopilot {
  readonly fcu: FcuState = {
    ap: false,
    athr: false,
    spd: null,
    hdg: 0,
    alt: 5000,
    vs: 0,
    loc: false,
    appr: false,
    fma: { thrust: 'none', vertical: 'none', lateral: 'none', armedVertical: 'none', armedLateral: 'none' },
    fdPitch: null,
    fdBank: null,
  };
  onEvent: ((e: ApEvent) => void) | null = null;
  /** "LVR CLB" flashing on the FMA: above the thrust reduction altitude with the levers still beyond CL. */
  lvrClb = false;
  /** The speed target in use (kt): the selected speed, or the managed one, kept above VLS. */
  speedTarget = 0;
  /** The altitude being captured or held (ft), the selected one or a constraint on the way. */
  targetAlt = 0;
  /** The autothrust is driving the engines now (not just armed). */
  athrActive = false;
  /** An autoland is briefed: the autopilot keeps the approach past 200 ft and lands (LAND, FLARE, ROLL OUT). */
  autoland = false;

  private readonly nav: NavSource;
  private n1Cmd = 0;
  /** The autopilot's sidestick orders, slewed like a servo so they never jerk the aircraft. */
  private apPitch = 0;
  private apRoll = 0;
  /** The flare: its integral (deg of pitch), and the flight model's flare-law nose-down so far (deg, estimated). */
  private flareI = 0;
  private flareDown = 0;
  /** The sink rate a frame ago and its rate of change (fpm/s, smoothed), for the flare's damping. */
  private flareVs = 0;
  private flareAz = 0;
  private aFloor = false;
  private airborneT = 0;
  private wasOnGround = true;
  private radioFt = 0;
  private trackHold = 0;
  /** ALT*: the vertical speed at capture (the asymptote starts from it). */
  private captureVs = 0;
  private gsStable = 0;
  private alertArmed = true;
  private lastAlertAlt = Number.NaN;
  private retard = false;
  /** Last FMA, to announce mode changes. */
  private readonly lastFma: FcuState['fma'] = { thrust: 'none', vertical: 'none', lateral: 'none', armedVertical: 'none', armedLateral: 'none' };
  /** The altitude at the last update, for the FCU's knobs between frames. */
  private lastAlt = 0;

  constructor(nav: NavSource) {
    this.nav = nav;
  }

  /**
   * The aircraft was put straight into the air (FlightModel.placeInAir, a skipped departure): take
   * it as flying, past the takeoff, so the autopilot can be engaged at once.
   */
  syncAirborne(s: AircraftState) {
    this.wasOnGround = false;
    this.airborneT = 1000;
    this.radioFt = s.radioAltFt;
    this.lastAlt = s.altFt;
    this.n1Cmd = (s.n1[0] + s.n1[1]) / 2;
  }

  // ---------------------------------------------------------------------------------------------- the FCU

  /** The AP 1 pushbutton: engage (in the air, from 100 ft, 5 s after liftoff) or disconnect. */
  toggleAp() {
    const fcu = this.fcu;
    if (fcu.ap) {
      this.disconnectAp();
      return;
    }
    if (this.wasOnGround || this.airborneT < AP_MIN_S || this.radioFt < AP_MIN_FT) return;
    fcu.ap = true;
    this.emit('ap-on');
  }

  /** The A/THR pushbutton: arm/engage, or disconnect. */
  toggleAthr() {
    const fcu = this.fcu;
    if (fcu.athr) this.disconnectAthr();
    else {
      fcu.athr = true;
      this.aFloor = false;
    }
  }

  /** The SPD knob: pulled with a value (selected), pushed with null (managed). */
  setSpd(kt: number | null) {
    this.fcu.spd = kt === null ? null : clamp(Math.round(kt), 100, 399);
  }

  setHdg(deg: number) {
    this.fcu.hdg = ((Math.round(deg) % 360) + 360) % 360;
  }

  setAlt(ft: number) {
    this.fcu.alt = clamp(Math.round(ft / 100) * 100, 100, 39000);
    this.alertArmed = true;
  }

  /** The V/S knob: turning it to a value and pulling engages V/S. */
  setVs(fpm: number) {
    this.fcu.vs = clamp(Math.round(fpm / 100) * 100, -6000, 6000);
    this.setVertical('V/S');
  }

  /** ALT knob pulled: open climb or descent to the selected altitude (speed on the elevator, thrust fixed). */
  pullAlt() {
    this.levelChange(true);
  }

  /** ALT knob pushed: managed climb or descent (respecting the flight plan's constraints). */
  pushAlt() {
    this.levelChange(false);
  }

  /** HDG knob pulled: fly the selected heading. */
  pullHdg() {
    this.fma().armedLateral = this.fma().armedLateral === 'NAV' ? 'none' : this.fma().armedLateral;
    this.setLateral('HDG');
  }

  /** HDG knob pushed: NAV, following the flight plan (armed until airborne). */
  pushHdg() {
    const fma = this.fma();
    if (this.wasOnGround) fma.armedLateral = 'NAV';
    else this.setLateral('NAV');
  }

  /** The LOC pushbutton: arm (or disarm) the localizer capture. */
  pushLoc() {
    const fcu = this.fcu;
    fcu.loc = !fcu.loc;
    fcu.appr = false;
    const fma = this.fma();
    if (fcu.loc) fma.armedLateral = fma.lateral === 'LOC' || fma.lateral === 'LOC*' ? 'none' : 'LOC';
    else {
      if (fma.armedLateral === 'LOC') fma.armedLateral = 'none';
      if (fma.armedVertical === 'G/S') fma.armedVertical = 'none';
    }
  }

  /** The APPR pushbutton: arm (or disarm) the localizer and the glide slope. */
  pushAppr() {
    const fcu = this.fcu;
    fcu.appr = !fcu.appr;
    fcu.loc = false;
    const fma = this.fma();
    if (fcu.appr) {
      if (fma.lateral !== 'LOC' && fma.lateral !== 'LOC*') fma.armedLateral = 'LOC';
      if (fma.vertical !== 'G/S' && fma.vertical !== 'G/S*') fma.armedVertical = 'G/S';
    } else {
      if (fma.armedLateral === 'LOC') fma.armedLateral = 'none';
      if (fma.armedVertical === 'G/S') fma.armedVertical = 'none';
    }
  }

  // ---------------------------------------------------------------------------------------------- guidance

  /**
   * One frame: work out the modes, the flight director and, when engaged, the autopilot's
   * sidestick and the autothrust's lever. `pilot` is what the pilot does; `out` (returned) is
   * what the flight model gets: the pilot's controls with the automatics' axes in place of theirs.
   */
  update(dt: number, s: AircraftState, pilot: Controls, out: Controls): Controls {
    Object.assign(out, pilot);
    const fcu = this.fcu;
    const fma = fcu.fma;
    this.radioFt = s.radioAltFt;
    this.lastAlt = s.altFt;

    // ---------------------------------------------------------------- ground and air
    if (s.onGround) {
      if (!this.wasOnGround && this.airborneT > 5) this.landed();
      this.airborneT = 0;
      this.wasOnGround = true;
    } else {
      this.airborneT += dt;
      if (this.airborneT > 0.5) this.wasOnGround = false;
    }
    const inAir = !this.wasOnGround;
    // the autoland called off (or the autopilot gone, or one column changed by hand, a V/S pulled
    // in LAND): back to the ILS for the flight director, or nothing on the runway
    if ((isLandMode(fma.vertical) || isLandMode(fma.lateral)) && (!this.autoland || !fcu.ap || fma.vertical !== fma.lateral)) {
      if (isLandMode(fma.vertical)) fma.vertical = inAir ? 'G/S' : 'none';
      if (isLandMode(fma.lateral)) fma.lateral = inAir ? 'LOC' : 'none';
    }

    // the takeoff: the levers to FLX or TOGA on the ground arm the autothrust and engage SRS / RWY
    if (s.onGround && pilot.throttle >= A320.detents.flx - DETENT_TOL && fma.vertical !== 'SRS') {
      fcu.athr = true;
      this.aFloor = false;
      fma.vertical = 'SRS';
      fma.lateral = 'RWY';
      fma.armedVertical = 'CLB';
      fma.armedLateral = this.nav.navLeg(s) ? 'NAV' : 'none';
      this.trackHold = s.heading;
    }
    if (s.onGround && fcu.ap && fma.vertical !== 'ROLL OUT') this.disconnectAp();

    // ---------------------------------------------------------------- vertical mode transitions
    const alt = s.altFt;
    if (inAir) {
      // at the acceleration altitude SRS hands over to the climb
      if (fma.vertical === 'SRS' && s.radioAltFt > THR_RED_FT) this.setVertical(fcu.alt > alt + 100 ? (fma.armedVertical === 'CLB' ? 'CLB' : 'OP CLB') : 'ALT*');
      this.lvrClb = (fma.vertical === 'SRS' || s.radioAltFt > THR_RED_FT) && pilot.throttle > A320.detents.cl + DETENT_TOL && !this.aFloor && s.radioAltFt > THR_RED_FT - 100 && this.airborneT < 600;
    } else this.lvrClb = false;

    // the altitude to capture: the selected one, or a constraint met first in a managed climb/descent
    let capAlt = fcu.alt;
    if (fma.vertical === 'DES' || fma.vertical === 'CLB') {
      const cst = this.nav.nextAltitude(s);
      if (cst !== null) capAlt = fma.vertical === 'DES' ? Math.max(capAlt, cst) : Math.min(capAlt, cst);
    }
    if (fma.vertical !== 'ALT*' && fma.vertical !== 'ALT') this.targetAlt = capAlt;
    const climbing = fma.vertical === 'SRS' || fma.vertical === 'CLB' || fma.vertical === 'OP CLB' || (fma.vertical === 'V/S' && fcu.vs > 0);
    const descending = fma.vertical === 'DES' || fma.vertical === 'OP DES' || (fma.vertical === 'V/S' && fcu.vs < 0);
    if (inAir && (climbing || descending) && fma.vertical !== 'SRS') {
      const err = this.targetAlt - alt;
      const toward = (climbing && err > 0 && s.vs > 0) || (descending && err < 0 && s.vs < 0);
      if (toward && Math.abs(err) <= (Math.abs(s.vs) * ALT_CAPTURE_TAU) / 60 + 30) {
        this.captureVs = s.vs;
        this.setVertical('ALT*');
      } else if ((climbing && err < -50) || (descending && err > 50)) {
        // already beyond the target (the selected altitude was moved behind the aircraft): level off
        this.captureVs = s.vs;
        this.setVertical('ALT*');
      }
    }
    if (fma.vertical === 'ALT*' && Math.abs(this.targetAlt - alt) < 20 && Math.abs(s.vs) < 200) this.setVertical('ALT');

    // ---------------------------------------------------------------- ILS captures
    const ils = this.nav.ils(s);
    const V = Math.max(30, s.vel.length());
    const crsDiff = ils ? angleDiff(s.track, ils.course) : 0;
    if (inAir && ils?.valid && fma.armedLateral === 'LOC') {
      // capture once the closure makes it time to start the turn onto the beam (from the beam's geometry in
      // metres, inside the localizer's coverage: the display's 2 dots are only ~500 m out on an
      // intercept, too late to start a 30–40° turn onto it)
      const vLat = V * Math.sin(crsDiff * DEG);
      const closing = vLat * ils.locM < 0;
      if ((closing && Math.abs(ils.locM) <= Math.abs(vLat) * LOC_TAU * 1.1 + 30) || Math.abs(ils.locM) < 40) {
        fma.armedLateral = 'none';
        this.setLateral('LOC*');
      }
    }
    if (fma.lateral === 'LOC*' && ils && Math.abs(ils.locM) < 20 && Math.abs(crsDiff) < 6) this.setLateral('LOC');
    if (inAir && ils?.valid && fma.armedVertical === 'G/S' && (fma.lateral === 'LOC*' || fma.lateral === 'LOC')) {
      const pathVs = this.pathVs(s);
      const closing = ((s.vs - pathVs) / 60) * Math.sign(-ils.gsFt); // ft/s towards the path
      if (Math.abs(ils.gs) < 2 && closing > -1 && Math.abs(ils.gsFt) < 40 + Math.max(0, closing) * 6) {
        fma.armedVertical = 'none';
        this.gsStable = 0;
        this.setVertical('G/S*');
      }
    }
    if (fma.vertical === 'G/S*' && ils) {
      this.gsStable = Math.abs(ils.gsFt) < 25 ? this.gsStable + dt : 0;
      if (this.gsStable > 2) this.setVertical('G/S');
    }
    // the autoland: LAND once the localizer and the glide slope are both held low down, then the flare
    if (this.autoland && fcu.ap && inAir && fma.vertical === 'G/S' && fma.lateral === 'LOC' && s.radioAltFt < LAND_FT) this.setLand('LAND');
    if (fma.vertical === 'LAND' && s.radioAltFt < FLARE_FT) this.setLand('FLARE');
    const landing = isLandMode(fma.vertical);
    const onGs = fma.vertical === 'G/S' || fma.vertical === 'G/S*' || landing;
    if (fcu.ap && onGs && !landing && s.radioAltFt < AP_OFF_APPR_FT) this.disconnectAp();
    this.retard = onGs && s.radioAltFt < (landing ? AUTOLAND_RETARD_FT : RETARD_FT) && inAir;

    // RWY TRK after liftoff; NAV engages from 30 ft if armed
    if (inAir && fma.lateral === 'RWY') {
      this.trackHold = s.track;
      this.setLateral('RWY TRK');
    }
    if (inAir && fma.armedLateral === 'NAV' && s.radioAltFt > 30 && this.nav.navLeg(s)) {
      fma.armedLateral = 'none';
      this.setLateral('NAV');
    }
    if (fma.lateral === 'NAV' && !this.nav.navLeg(s)) {
      fcu.hdg = Math.round(s.heading) % 360;
      this.setLateral('HDG');
    }

    // ---------------------------------------------------------------- speed target
    const managed = fcu.spd === null || fma.vertical === 'SRS';
    let spd = managed ? this.nav.managedSpeed(s) : (fcu.spd as number);
    if (inAir && s.speeds.vls > 0) spd = Math.max(spd, Math.round(s.speeds.vls));
    if (inAir && s.speeds.vmax > 0) spd = Math.min(spd, s.speeds.vmax - 5);
    this.speedTarget = spd;

    // ---------------------------------------------------------------- vertical guidance → flight path
    const gamma = Math.asin(clamp((s.vs * FPM) / V, -1, 1));
    const aNow = (s.iasTrend / 10) * KT;
    const aDes = clamp((spd - s.ias) * ACCEL_PER_KT, -ACCEL_MAX, ACCEL_MAX);
    let gammaDot = 0;
    let gammaTgt = gamma;
    let nzLim = NZ_LIMIT;
    let vMode = fma.vertical;
    // V/S at the managed descent's path rate (a DES towards a constraint ahead), or null for an idle descent
    const desVs = vMode === 'DES' ? this.desPathVs(s) : null;
    if (vMode === 'DES' && desVs !== null) vMode = 'V/S';
    if (SPEED_ON_ELEVATOR.has(vMode)) {
      gammaDot = (SPEED_ELEV_K * (aNow - aDes)) / G;
      gammaTgt = gamma + gammaDot * 3;
      // each mode's own limits on the path
      let lo = -0.3;
      let hi = 0.3;
      if (vMode === 'SRS' || vMode === 'CLB' || vMode === 'OP CLB') lo = Math.asin(clamp((CLIMB_MIN_FPM * FPM) / V, 0, 0.3));
      if (vMode === 'DES' || vMode === 'OP DES') hi = Math.asin(clamp((-CLIMB_MIN_FPM * FPM) / V, -0.3, 0));
      if (vMode === 'SRS') hi = Math.min(hi, gamma + (SRS_PITCH_MAX - s.pitch) * DEG);
      if (gammaTgt < lo || gammaTgt > hi) {
        gammaTgt = clamp(gammaTgt, lo, hi);
        gammaDot = GAMMA_K * (gammaTgt - gamma);
      }
    } else if (vMode !== 'none') {
      let vsCmd = 0;
      if (vMode === 'ALT*') {
        nzLim = NZ_CAPTURE;
        const err = this.targetAlt - alt;
        const lim = Math.max(Math.abs(this.captureVs), 300);
        vsCmd = clamp((err * 60) / ALT_CAPTURE_TAU, -lim, lim);
      } else if (vMode === 'ALT') {
        vsCmd = clamp(((this.targetAlt - alt) * 60) / ALT_HOLD_TAU, -1000, 1000);
      } else if (vMode === 'V/S') {
        // (on the managed path the thrust is near idle: if the speed still runs over 250 kt (or a higher target) the
        // descent eases off, the FMGS's speed protection, rather than break the 250 kt limit)
        vsCmd = desVs !== null ? Math.min(0, desVs + Math.max(0, s.ias - Math.max(spd, A320.speedLimitLow) - 1) * 200) : fcu.vs;
      } else if (ils && (vMode === 'G/S' || vMode === 'G/S*' || vMode === 'LAND')) {
        vsCmd = this.pathVs(s) - clamp((ils.gsFt * 60) / GS_TAU, -600, 600);
        if (vMode === 'G/S*') nzLim = NZ_CAPTURE;
      }
      gammaTgt = Math.asin(clamp((vsCmd * FPM) / V, -0.3, 0.3));
      gammaDot = GAMMA_K * (gammaTgt - gamma);
    }
    // the load factor that makes that flight path rate, within the comfort limit, as sidestick
    const bankRad = s.bank * DEG;
    const dn = clamp((V * gammaDot) / G, -nzLim, nzLim) / Math.max(0.5, Math.cos(bankRad));
    const flapsOut = s.config > 0 || s.slatsDeg > 1;
    const nzMax = flapsOut ? A320.nzMax[1] : A320.nzMax[0];
    const nzMin = flapsOut ? A320.nzMin[1] : A320.nzMin[0];
    let apPitch = dn >= 0 ? dn / (nzMax - 1) : dn / (1 - nzMin);
    fcu.fdPitch = vMode === 'none' || !inAir ? null : s.pitch + clamp((gammaTgt - gamma) / DEG, -10, 10);
    // the flare and the roll out are flown on the stick itself, quicker than the path modes
    let stickMax = 0.5;
    let slew = STICK_SLEW;
    if (vMode !== 'FLARE') {
      this.flareI = this.flareDown = this.flareAz = 0;
      this.flareVs = s.vs;
    }
    if (vMode === 'FLARE' || vMode === 'ROLL OUT') {
      apPitch = vMode === 'FLARE' && inAir ? this.flarePitch(s, dt) : 0;
      stickMax = 1;
      slew = FLARE_SLEW;
    }

    // ---------------------------------------------------------------- lateral guidance → bank
    let bankCmd: number | null = null;
    let trackCmd = s.track;
    let useTrack = true;
    const lat = fma.lateral;
    if (lat === 'HDG') {
      trackCmd = fcu.hdg;
      useTrack = false;
    } else if (lat === 'RWY TRK') trackCmd = this.trackHold;
    else if (lat === 'NAV') {
      const leg = this.nav.navLeg(s);
      if (leg) trackCmd = leg.track - Math.asin(clamp(leg.xtkM / (V * NAV_TAU), -0.5, 0.5)) / DEG;
    } else if ((lat === 'LOC*' || lat === 'LOC' || lat === 'LAND' || lat === 'FLARE') && ils) {
      const vLatCmd = clamp(-ils.locM / LOC_TAU, -V * 0.5, V * 0.5);
      trackCmd = ils.course + Math.asin(vLatCmd / V) / DEG;
    }
    if (inAir && lat !== 'none' && lat !== 'RWY' && lat !== 'ROLL OUT') {
      const err = angleDiff(trackCmd, useTrack ? s.track : s.heading);
      // a turn whose rate closes the error with the TURN_TAU time constant
      const rateCmd = (err * DEG) / TURN_TAU;
      bankCmd = clamp(Math.atan((rateCmd * V) / G) / DEG, -BANK_LIMIT, BANK_LIMIT);
    }
    fcu.fdBank = bankCmd;
    let apRoll = bankCmd === null ? 0 : clamp(0.6 * (bankCmd - s.bank), -ROLL_RATE, ROLL_RATE) / A320.rollRateMax;
    // the autoland's last 60 ft: the rudder lines the nose up with the runway (the decrab) and a wing
    // goes down into the wind to hold the centreline against the drift; on the runway the rudder and
    // the nose wheel steer for the centreline
    let apYaw: number | null = null;
    if (landing && ils) {
      const ra = s.radioAltFt;
      if (lat === 'ROLL OUT') {
        apRoll = 0;
        apYaw = clamp(angleDiff(ils.course - clamp(ils.locM * 0.4, -3, 3), s.heading) * 0.15 - s.r * 0.3, -1, 1);
      } else {
        if (ra < 60) {
          apYaw = clamp(angleDiff(ils.course, s.heading) / 8 - s.r * 0.1, -1, 1);
          const fw = headingVec(ils.course);
          // the drift across the runway (m/s, + right), from the velocity
          const drift = s.vel.x * -fw.z + s.vel.z * fw.x;
          const bankT = clamp(-(ils.locM * 0.5 + drift * 3.5), -8, 8);
          apRoll = clamp((bankT - s.bank) * 0.12 - s.p * 0.02, -0.4, 0.4);
        }
      }
    }

    // ---------------------------------------------------------------- autopilot
    if (fcu.ap && (Math.abs(pilot.pitch) > INSTINCTIVE || Math.abs(pilot.roll) > INSTINCTIVE)) this.disconnectAp();
    // in the autoland's last feet and on the runway the pedals and the tiller take over too
    if (fcu.ap && landing && (Math.abs(pilot.yaw) > INSTINCTIVE || Math.abs(pilot.tiller) > INSTINCTIVE)) this.disconnectAp();
    if (fcu.ap) {
      if (fma.vertical === 'none') {
        fcu.vs = Math.round(s.vs / 100) * 100;
        this.setVertical('V/S');
      }
      if (fma.lateral === 'none') {
        fcu.hdg = Math.round(s.heading) % 360;
        this.setLateral('HDG');
      }
      this.apPitch = approach(this.apPitch, clamp(apPitch, -stickMax, stickMax), slew * dt);
      this.apRoll = approach(this.apRoll, clamp(apRoll, -0.5, 0.5), slew * dt);
      out.pitch = this.apPitch;
      out.roll = this.apRoll;
      if (apYaw !== null) {
        out.yaw = apYaw;
        out.tiller = 0;
      }
    } else {
      // engaging starts from neutral, like the real servos
      this.apPitch = 0;
      this.apRoll = 0;
    }

    // ---------------------------------------------------------------- autothrust
    // alpha floor: TOGA whatever the levers, whether the autothrust was on or not
    if (inAir && s.alphaFloor && s.radioAltFt > 100 && !this.aFloor) {
      this.aFloor = true;
      fcu.athr = true;
      this.emit('a-floor');
    }
    const lever = pilot.throttle;
    const inCl = Math.abs(lever - A320.detents.cl) < DETENT_TOL;
    let thrust: ThrustMode = 'none';
    this.athrActive = false;
    if (fcu.athr) {
      if (this.aFloor) {
        thrust = s.alphaFloor ? 'A.FLOOR' : 'TOGA LK';
        out.throttle = 1;
        this.n1Cmd = A320.n1Toga;
      } else if (lever > A320.detents.cl + DETENT_TOL) {
        thrust = lever >= A320.detents.toga - DETENT_TOL ? 'MAN TOGA' : 'MAN FLX';
        this.n1Cmd = (s.n1[0] + s.n1[1]) / 2;
      } else if (lever < 0.02 && inAir) {
        this.disconnectAthr();
      } else if (inAir) {
        // active: never more than the levers ask for
        this.athrActive = true;
        const limit = leverN1(lever);
        const v = fma.vertical;
        if (this.retard) {
          thrust = 'THR IDLE';
          this.n1Cmd = A320.n1Idle;
        } else if ((v === 'CLB' || v === 'OP CLB' || v === 'SRS') && !this.lvrClb) {
          thrust = 'THR CLB';
          this.n1Cmd = approach(this.n1Cmd, limit, ATHR_SLEW * dt);
        } else if (v === 'OP DES' || (v === 'DES' && desVs === null)) {
          thrust = 'THR IDLE';
          this.n1Cmd = approach(this.n1Cmd, A320.n1Idle, ATHR_SLEW * dt);
        } else {
          thrust = inCl ? 'SPEED' : 'THR LVR';
          const e = aDes - aNow;
          this.n1Cmd = clamp(this.n1Cmd + ATHR_KI * e * dt, A320.n1Idle, limit);
          out.throttle = n1Lever(clamp(this.n1Cmd + ATHR_KP * e, A320.n1Idle, limit));
        }
        if (thrust !== 'SPEED' && thrust !== 'THR LVR') out.throttle = n1Lever(Math.min(this.n1Cmd, limit));
      } else {
        // on the ground below the takeoff detents: armed, not active
        this.n1Cmd = (s.n1[0] + s.n1[1]) / 2;
      }
    } else this.n1Cmd = (s.n1[0] + s.n1[1]) / 2;
    fma.thrust = thrust;

    // ---------------------------------------------------------------- the altitude alert
    if (inAir && !onGs) {
      const d = Math.abs(fcu.alt - alt);
      if (fcu.alt !== this.lastAlertAlt) {
        this.lastAlertAlt = fcu.alt;
        this.alertArmed = d > ALERT_APPROACH_FT;
      }
      if (this.alertArmed && d < ALERT_APPROACH_FT) {
        this.alertArmed = false;
        this.emit('alt-alert');
      } else if (!this.alertArmed && fma.vertical === 'ALT' && Math.abs(this.targetAlt - alt) > ALERT_DEVIATE_FT) {
        this.alertArmed = true;
        this.emit('alt-alert');
      }
    }

    this.announce();
    return out;
  }

  // ---------------------------------------------------------------------------------------------- internals

  private fma() {
    return this.fcu.fma;
  }

  private setVertical(m: VerticalMode) {
    const fma = this.fcu.fma;
    if (fma.vertical === m) return;
    fma.vertical = m;
    if (m === 'ALT*' || m === 'ALT') {
      if (fma.armedVertical === 'CLB') fma.armedVertical = 'none';
    }
  }

  private setLateral(m: LateralMode) {
    this.fcu.fma.lateral = m;
  }

  /** LAND, FLARE or ROLL OUT: both columns at once, nothing armed. */
  private setLand(m: LandMode) {
    const fma = this.fcu.fma;
    fma.vertical = m;
    fma.lateral = m;
    fma.armedVertical = 'none';
    fma.armedLateral = 'none';
  }

  /**
   * The flare's sidestick. The FDM's flare law takes the stick below 50 ft as a pitch attitude
   * (8° a full stick), so this asks for the attitude change that brings the sink rate to a target
   * falling with the height (18 fpm a foot, about 3 s to the runway, down to 80 fpm): proportional,
   * an integral for the trim it needs, the sink's rate of change damping the pull, and the flare
   * law's nose-down bias below 30 ft held off. The target never asks to sink faster than the
   * aircraft is already (no pushing over at 50 ft) unless it has floated well above the profile
   * (11 fpm a foot): leveling off in ground effect runs the touchdown past the zone.
   */
  private flarePitch(s: AircraftState, dt: number) {
    const ra = s.radioAltFt;
    if (ra < 30) this.flareDown = Math.min(2, this.flareDown + 0.25 * dt);
    if (dt > 0) this.flareAz += ((s.vs - this.flareVs) / dt - this.flareAz) * Math.min(1, dt / 0.3);
    this.flareVs = s.vs;
    const vsT = -clamp(ra * 18, 80, Math.max(80, -s.vs, ra * 11));
    const e = vsT - s.vs;
    // fpm of sink a degree of pitch is worth at this ground speed
    const fpmPerDeg = Math.max(150, s.gs * 101.3 * 0.01745);
    this.flareI = clamp(this.flareI + (e / fpmPerDeg) * 0.5 * dt, -3, 6);
    const dTheta = (e / fpmPerDeg) * 4 + this.flareI + this.flareDown - (1.5 * this.flareAz) / fpmPerDeg;
    return clamp(dTheta / 8, -0.35, 0.9);
  }


  /** ALT pulled or pushed: OP CLB / OP DES (or CLB / DES managed) towards the selected altitude, or hold here. */
  private levelChange(open: boolean) {
    if (this.wasOnGround) return;
    const fma = this.fcu.fma;
    const alt = this.lastAlt;
    const d = this.fcu.alt - alt;
    if (Math.abs(d) < 50) {
      this.targetAlt = this.fcu.alt;
      this.captureVs = 0;
      this.setVertical('ALT*');
      return;
    }
    if (fma.armedVertical === 'CLB') fma.armedVertical = 'none';
    this.setVertical(d > 0 ? (open ? 'OP CLB' : 'CLB') : open ? 'OP DES' : 'DES');
    this.alertArmed = Math.abs(d) > ALERT_APPROACH_FT;
  }

  /** The vertical speed (fpm) of the 3° glide path at the current ground speed. */
  private pathVs(s: AircraftState) {
    return -((s.gs * KT * Math.tan(3 * DEG)) / FPM);
  }

  /**
   * Managed descent towards the active leg's altitude constraint: the vertical speed that meets it
   * at the fix (with 10 % in hand), or null when there's none below (an idle descent then).
   */
  private desPathVs(s: AircraftState): number | null {
    const leg = this.nav.navLeg(s);
    const cst = leg?.fix.altFt;
    if (!leg || cst === undefined || cst >= s.altFt - 100) return null;
    const t = leg.distM / Math.max(60, s.gs * KT);
    return clamp((-(s.altFt - Math.max(cst, this.fcu.alt)) / t) * 60 * 1.1, -2500, -500);
  }

  private disconnectAp() {
    if (!this.fcu.ap) return;
    this.fcu.ap = false;
    this.emit('ap-off');
  }

  private disconnectAthr() {
    const was = this.fcu.athr;
    this.fcu.athr = false;
    this.aFloor = false;
    this.athrActive = false;
    if (was) this.emit('athr-off');
  }

  /** Touchdown at the end of a flight: everything drops out, ready for the next one (but an autoland's ROLL OUT). */
  private landed() {
    const fma = this.fcu.fma;
    if (this.fcu.ap && this.autoland && (fma.vertical === 'FLARE' || fma.vertical === 'LAND')) {
      this.disconnectAthr();
      this.setLand('ROLL OUT');
      this.fcu.loc = false;
      this.fcu.appr = false;
      this.lvrClb = false;
      return;
    }
    this.disconnectAp();
    this.disconnectAthr();
    fma.vertical = 'none';
    fma.lateral = 'none';
    fma.armedVertical = 'none';
    fma.armedLateral = 'none';
    this.fcu.loc = false;
    this.fcu.appr = false;
    this.lvrClb = false;
  }

  private emit(e: ApEvent) {
    this.onEvent?.(e);
  }

  /** Announce an FMA change (the PFD boxes a new mode for 10 s; callouts may read it). */
  private announce() {
    const f = this.fcu.fma;
    const l = this.lastFma;
    if (f.thrust !== l.thrust || f.vertical !== l.vertical || f.lateral !== l.lateral || f.armedVertical !== l.armedVertical || f.armedLateral !== l.armedLateral) {
      l.thrust = f.thrust;
      l.vertical = f.vertical;
      l.lateral = f.lateral;
      l.armedVertical = f.armedVertical;
      l.armedLateral = f.armedLateral;
      this.emit('mode');
    }
  }
}
