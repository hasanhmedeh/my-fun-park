// Logic checks for the radio modules (run by scripts/radio-check.mjs in node): the ILS receiver's
// geometry, the managed speeds, the scoring rules one by one, the speech queue and the radio's
// numbers, the GPWS envelopes, and whole scripted flights in both directions that run the
// navigator, ATC, the cabin, the callouts and the scorer together the way the flight attraction
// will, checking the order of the clearances, the fixes and the phases, and what was said.
//
// The scripted flights don't use the flight model: a kinematic pilot taxis along ATC's routes,
// flies the FMS legs and the ILS, flares and rolls out, so these checks only depend on this
// module's files and the contracts. Each check returns a row for the table: name, pass, numbers.

import * as THREE from 'three';
import { A320 } from './a320';
import { AIRFIELDS, flightPlan, neighbours, onRunway, runwayFrame, type RunwayEnd, type RunwayIdent } from './airports';
import { Atc, type RunwayStatus } from './atc';
import { Cabin } from './cabin';
import { Callouts, type AlertKind } from './callouts';
import { ilsReading, Navigator, phaseIndex, takeoffSpeeds, vlsFull, type FlightPhase } from './nav';
import { FlightScorer, SCHEDULE_PAD_S } from './scoring';
import { altitudeWords, digits, flightLevelWords, freqWords, headingWords, Speech, taxiwayWords, windWords } from './speech';
import { isaWeather } from './weather';
import { Sfx } from '../world/audio';
import { FT, KT, NM, SEA_Y, headingVec, regionAt, shoreDist, vecHeading, type Region } from '../world/geo';
import type { AircraftState, FcuState, FdmEvent, Utterance, Weather } from './types';

interface Row {
  name: string;
  ok: boolean;
  detail: string;
}

const D2R = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
/** Feet per minute → m/s. */
const fpm = (v: number) => (v * FT) / 60;

// ------------------------------------------------------------------------------------------------
// A kinematic aircraft: the AircraftState the modules read, filled in from a few numbers
// ------------------------------------------------------------------------------------------------

function blankState(): AircraftState {
  return {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    pitch: 0,
    bank: 0,
    heading: 0,
    track: 0,
    fpa: 0,
    q: 0,
    p: 0,
    r: 0,
    alpha: 3,
    beta: 0,
    ias: 0,
    tas: 0,
    gs: 0,
    mach: 0,
    iasTrend: 0,
    vs: 0,
    altFt: 0,
    radioAltFt: 0,
    nz: 1,
    ny: 0,
    n1: [0, 0],
    thrust: [0, 0],
    fuelFlow: 0,
    reverser: 0,
    mass: 64000,
    fuel: 4000,
    flapsDeg: 0,
    slatsDeg: 0,
    config: 0,
    gear: 1,
    spoilers: 0,
    aileron: 0,
    elevator: 0,
    rudder: 0,
    nosewheel: 0,
    wheelSpin: 0,
    compression: [0, 0, 0],
    onGround: true,
    noseOnGround: true,
    surface: 'apron',
    law: 'ground',
    stallWarning: false,
    alphaFloor: false,
    overspeed: false,
    speeds: { vls: 150, vaprot: 135, vamax: 125, vmax: 350, greenDot: 205, f: 145, s: 180, vs1g: 110 },
    time: 0,
  };
}

/** Characteristic speeds by configuration for 64 t (close to the FDM's, enough for the managed speed). */
function setSpeeds(s: AircraftState) {
  const c = s.config;
  const vls = c >= 5 ? vlsFull(s.mass) : c >= 4 ? 135 : c >= 2 ? 145 : c === 1 ? 160 : 190;
  s.speeds.vls = vls;
  s.speeds.vmax = c >= 5 ? A320.vfe[4] : c >= 4 ? A320.vfe[3] : c >= 3 ? A320.vfe[2] : c === 2 ? A320.vfe1F : c === 1 ? A320.vfe[1] : A320.vmo;
}

interface Kin {
  x: number;
  z: number;
  /** Height of the reference point above y = 0 (m). */
  h: number;
  hdg: number;
  /** Speed along the heading (m/s, negative backwards) and vertical speed (m/s). */
  v: number;
  vs: number;
  turnRate: number;
  onGround: boolean;
}

function writeState(k: Kin, s: AircraftState, dt: number) {
  const f = headingVec(k.hdg);
  s.pos.set(k.x, k.h, k.z);
  s.vel.set(f.x * k.v, k.vs, f.z * k.v);
  s.heading = ((k.hdg % 360) + 360) % 360;
  s.track = k.v >= 0 ? s.heading : (s.heading + 180) % 360;
  const kt = Math.abs(k.v) / KT;
  const prevIas = s.ias;
  s.gs = kt;
  s.ias = kt;
  s.tas = kt;
  s.mach = Math.abs(k.v) / 340;
  s.iasTrend = dt > 0 ? ((s.ias - prevIas) / dt) * 10 : 0;
  s.vs = k.vs / FT * 60;
  s.altFt = (k.h - SEA_Y) / FT;
  const groundY = shoreDist(k.x, k.z) > 0 ? 0 : SEA_Y;
  s.radioAltFt = Math.max(0, (k.h - groundY) / FT);
  s.fpa = Math.abs(k.v) > 1 ? Math.atan2(k.vs, Math.abs(k.v)) / D2R : 0;
  s.pitch = k.onGround ? 0 : s.fpa + 3;
  s.bank = k.onGround ? 0 : Math.atan((Math.abs(k.v) * k.turnRate * D2R) / 9.81) / D2R;
  s.onGround = k.onGround;
  s.noseOnGround = k.onGround;
  s.law = k.onGround ? 'ground' : 'flight';
  s.time += dt;
  setSpeeds(s);
}

const fcu = (): FcuState => ({
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
});

// ------------------------------------------------------------------------------------------------
// A scripted flight
// ------------------------------------------------------------------------------------------------

interface FlightOpts {
  from: Region;
  callsign: string;
  flightNo: string;
  weather: Weather;
  /** The departure's traffic once the aircraft is at the holding point: busy for this long, with this reason. */
  depBusyS: number;
  depReason: string;
  /** The arrival's traffic: busy between these distances to go to the threshold (NM), or for the whole approach. */
  arrBusy: { fromNm: number; toNm: number; reason: string } | 'always' | null;
  /** End the run once the go-around's direct-to has been given (the go-around check). */
  stopAfterGoAround?: boolean;
  /** Give up after this much simulated time (s). */
  maxS?: number;
}

interface FlightLog {
  clearances: { kind: string; t: number }[];
  lines: { u: Utterance; t: number }[];
  phases: { phase: FlightPhase; t: number }[];
  fixes: { name: string; t: number; distM: number }[];
  violations: string[];
  alerts: string[];
  maxQueue: number;
  managed: { takeoff: number; climb: number; iaf: number; vapp: number };
  touchdown: { along: number; right: number; fpm: number } | null;
  heldWhileBusy: boolean;
  takeoffWhileBusy: boolean;
  landWhileBusy: boolean;
  timeS: number;
  costMs: number;
  scorer: FlightScorer;
  nav: Navigator;
  atc: Atc;
  parked: boolean;
}

type Mode = 'boarding' | 'await-push' | 'push' | 'await-taxi' | 'taxi' | 'hold' | 'lineup' | 'wait-on-runway' | 'roll' | 'air' | 'missed' | 'rollout' | 'exit' | 'taxi-in' | 'parked';

function fly(o: FlightOpts): FlightLog {
  const ap = AIRFIELDS[o.from];
  const to: Region = o.from === 'home' ? 'island' : 'home';
  const rwy: RunwayIdent = '27';
  const plan = flightPlan(o.from, rwy, rwy);
  const nav = new Navigator(plan);
  const sfx = new Sfx();
  const speech = new Speech(sfx);
  speech.enabled = false;
  const s = blankState();
  const f = fcu();
  const arrRw = nav.arrivalRunway;
  const depRw = nav.departureRunway;
  const log: FlightLog = {
    clearances: [],
    lines: [],
    phases: [],
    fixes: [],
    violations: [],
    alerts: [],
    maxQueue: 0,
    managed: { takeoff: 0, climb: 0, iaf: 0, vapp: 0 },
    touchdown: null,
    heldWhileBusy: false,
    takeoffWhileBusy: false,
    landWhileBusy: false,
    timeS: 0,
    costMs: 0,
    scorer: null as unknown as FlightScorer,
    nav,
    atc: null as unknown as Atc,
    parked: false,
  };

  let t = 0;
  let mode: Mode = 'boarding';
  let atHoldT = -1;
  const runwayBusy = (region: Region): RunwayStatus => {
    if (region === o.from && region !== to) {
      if (atHoldT < 0) return { busy: false, clearInS: 0 };
      const left = o.depBusyS - (t - atHoldT);
      return left > 0 ? { busy: true, clearInS: left, reason: o.depReason } : { busy: false, clearInS: 0 };
    }
    if (!o.arrBusy || s.onGround) return { busy: false, clearInS: 0 };
    if (o.arrBusy === 'always') return { busy: true, clearInS: 150, reason: 'traffic on the runway' };
    const d = nav.distanceToGoM(s) / NM;
    return d < o.arrBusy.fromNm && d > o.arrBusy.toNm ? { busy: true, clearInS: 15, reason: o.arrBusy.reason } : { busy: false, clearInS: 0 };
  };

  const hour = 13.25;
  const atc = new Atc(speech, nav, o.weather, { callsign: o.callsign, flightNo: o.flightNo, runwayBusy, hour, chatter: 'all' });
  const scorer = new FlightScorer(nav);
  const cabin = new Cabin(speech, sfx, nav, o.flightNo, { hour, weather: o.weather, passengers: 150 });
  const callouts = new Callouts(speech, sfx);
  log.scorer = scorer;
  log.atc = atc;
  atc.onClearance = (kind) => {
    log.clearances.push({ kind, t });
    const busy = runwayBusy(kind === 'takeoff' ? o.from : to).busy;
    if (kind === 'takeoff' && busy) log.takeoffWhileBusy = true;
    if (kind === 'land' && busy) log.landWhileBusy = true;
  };
  atc.onViolation = (label, points, fatal) => {
    log.violations.push(`${label} at ${Math.round(t)} s, (${Math.round(s.pos.x)}, ${Math.round(s.pos.z)}), ${Math.round(s.altFt)} ft, ${nav.phase}`);
    scorer.violation(label, points, undefined, fatal);
  };
  callouts.onAlert = (kind) => {
    log.alerts.push(`${kind} at ${Math.round(s.radioAltFt)} ft RA, ${nav.phase}`);
    scorer.alert(kind);
  };
  speech.onLine = (u) => log.lines.push({ u, t });

  // the aircraft, on its stand
  const stand = ap.stands.find((x) => x.id === ap.playerStand)!;
  const k: Kin = { x: stand.x, z: stand.z, h: 0, hdg: stand.heading, v: 0, vs: 0, turnRate: 0, onGround: true };
  writeState(k, s, 0);
  nav.phase = 'boarding' as FlightPhase;

  let path: { x: number; z: number }[] = [];
  let throttle = 0;
  let n1 = 0;
  let pushT = 0;
  let rollT = 0;
  let afterTd = 0;
  let lastIndex = -1;
  let lastPhase: FlightPhase | null = null;
  let gaDirect = false;
  let vr = 0;
  const dt = 0.1;
  const maxS = o.maxS ?? 1500;
  const pushEnd = stand.pushEnd[atc.pushFace];
  let cost = 0;
  let frames = 0;

  /** Taxi along `path`: head for the next point at up to `vmax`, slowing for the corners and the last point. */
  const taxi = (vmax: number) => {
    if (!path.length) {
      k.v = Math.max(0, k.v - 1.5 * dt);
      return true;
    }
    const p = path[0];
    const last = path.length === 1;
    const d = Math.hypot(p.x - k.x, p.z - k.z);
    if (d < (last ? 0.4 : 4)) {
      path.shift();
      if (last) {
        // on the mark (the stop bar, the holding point): stop there
        k.x = p.x;
        k.z = p.z;
        k.v = 0;
        return true;
      }
      return false;
    }
    const want = vecHeading(p.x - k.x, p.z - k.z);
    const turn = clamp(angleDiff(want, k.hdg), -25 * dt, 25 * dt);
    k.hdg += turn;
    const corner = !last ? Math.abs(angleDiff(vecHeading(path[1].x - p.x, path[1].z - p.z), want)) : 0;
    const vt = last ? Math.min(vmax, Math.max(0.3, d * 0.2)) : Math.min(vmax, corner > 30 && d < 50 ? 6 : vmax);
    k.v += clamp(vt - k.v, -1.5 * dt, 1 * dt);
    k.turnRate = 0;
    return false;
  };
  const nodePts = (ids: string[], region: Region) => ids.map((id) => ({ x: AIRFIELDS[region].nodes[id].x, z: AIRFIELDS[region].nodes[id].z }));

  for (; t < maxS; t += dt) {
    const c = atc.clearance;
    switch (mode) {
      case 'boarding':
        cabin.boarding(Math.min(1, t / 30));
        if (t >= 30) mode = 'await-push';
        break;
      case 'await-push':
        if (atc.nextRequest === 'pushback') atc.request('pushback');
        if (c.pushback) {
          mode = 'push';
          nav.phase = 'pushback' as FlightPhase;
          pushT = 0;
        }
        break;
      case 'push': {
        // the tug: tail first off the stand, swinging onto the taxilane facing the way ATC said
        pushT += dt;
        const u = Math.min(1, pushT / 70);
        const e = u * u * (3 - 2 * u);
        const nx = stand.x + (pushEnd.x - stand.x) * (1 - Math.cos((e * Math.PI) / 2));
        const nz = stand.z + (pushEnd.z - stand.z) * Math.sin((e * Math.PI) / 2);
        const back = Math.hypot(nx - k.x, nz - k.z) / dt;
        k.x = nx;
        k.z = nz;
        k.hdg = stand.heading + angleDiff(pushEnd.heading, stand.heading) * e;
        k.v = -back;
        if (pushT > 25) n1 = Math.min(0.215, n1 + dt * 0.02);
        if (u >= 1) {
          k.v = 0;
          k.hdg = pushEnd.heading;
          mode = 'await-taxi';
        }
        break;
      }
      case 'await-taxi':
        // flaps 1+F for the takeoff, set once the tug has gone
        s.config = 2;
        n1 = Math.min(0.215, n1 + dt * 0.02);
        if (atc.nextRequest === 'taxi' && n1 > 0.2) atc.request('taxi');
        if (c.taxi) {
          path = nodePts(c.taxi.route, o.from);
          mode = 'taxi';
        }
        break;
      case 'taxi':
        n1 = 0.24;
        if (taxi(13)) {
          atHoldT = t;
          mode = 'hold';
        }
        break;
      case 'hold':
        if (atc.nextRequest === 'takeoff') atc.request('takeoff');
        if (runwayBusy(o.from).busy && t - atHoldT > 8) log.heldWhileBusy = true;
        if (c.lineUp) {
          const entry = atc.entry;
          const rn = ap.nodes[entry.runway];
          const g = headingVec(depRw.heading);
          path = [
            { x: rn.x, z: rn.z },
            { x: rn.x + g.x * 50, z: rn.z + g.z * 50 },
          ];
          mode = 'lineup';
        }
        break;
      case 'lineup':
        if (taxi(6)) {
          k.hdg = depRw.heading;
          mode = c.takeoff ? 'roll' : 'wait-on-runway';
          vr = takeoffSpeeds(s.mass).vr;
        }
        break;
      case 'wait-on-runway':
        if (c.takeoff) mode = 'roll';
        break;
      case 'roll':
        rollT += dt;
        throttle = A320.detents.flx;
        n1 = Math.min(0.92, n1 + dt * 0.12);
        k.hdg = depRw.heading;
        if (n1 > 0.8) k.v += 2.1 * dt;
        if (k.v / KT >= vr + 4) {
          k.onGround = false;
          k.vs = 2.5;
          mode = 'air';
          scorer.event({ kind: 'liftoff', ias: k.v / KT, pos: s.pos.clone() }, s);
        }
        break;
      case 'air':
      case 'missed': {
        // lateral: the FMS leg (with a cross-track correction), the ILS once cleared and close in, or ATC's heading
        const ils = nav.ils(s);
        const onFinal = c.approach && ils?.valid && nav.activeIndex >= nav.legs.length - 2 && Math.abs(ils.loc) < 2.4 && Math.abs(angleDiff(k.hdg, arrRw.heading)) < 60;
        let want = k.hdg;
        if (mode === 'missed' || c.heading !== null) want = c.heading ?? arrRw.heading;
        else if (onFinal && ils) want = arrRw.heading - clamp(ils.locM * 0.08, -30, 30);
        else {
          const leg = nav.navLeg(s);
          if (leg) want = leg.track - clamp(leg.xtkM * 0.01, -30, 30);
        }
        // no turns below 400 ft after the takeoff, and gentle corrections on short final
        const maxRate = s.radioAltFt < 400 && mode === 'air' && phaseIndex(nav.phase) <= phaseIndex('climb') ? 0 : s.radioAltFt < 300 ? 0.8 : 2.6;
        const rate = clamp(angleDiff(want, k.hdg) * 0.5, -maxRate, maxRate);
        k.turnRate = rate;
        k.hdg += rate * dt;

        // speed: the managed speed, within the flaps' limits
        const vt = nav.managedSpeed(s);
        k.v += clamp(vt * KT - k.v, -0.75 * dt, 1.2 * dt);

        // configuration on the approach, as the speed allows
        const dtg = nav.distanceToGoM(s) / NM;
        const wantConf = phaseIndex(nav.phase) >= phaseIndex('approach') && mode === 'air' ? (dtg < 5 ? 5 : dtg < 6.5 ? 4 : dtg < 8 ? 3 : dtg < 10 ? 2 : dtg < 14 ? 1 : 0) : mode === 'missed' ? 3 : 0;
        if (wantConf > s.config) {
          const vfeNext = wantConf >= 5 ? A320.vfe[4] : wantConf >= 4 ? A320.vfe[3] : wantConf >= 3 ? A320.vfe[2] : wantConf === 2 ? A320.vfe1F : A320.vfe[1];
          if (s.ias < vfeNext - 5) s.config++;
        } else if (wantConf < s.config && mode === 'air' && phaseIndex(nav.phase) < phaseIndex('approach') && s.ias > s.speeds.s) s.config--;
        if (s.radioAltFt > 100 && phaseIndex(nav.phase) < phaseIndex('approach') && mode === 'air') s.gear = 0;
        if (wantConf >= 4 || (dtg < 7 && phaseIndex(nav.phase) >= phaseIndex('approach'))) s.gear = 1;

        // vertical: the cleared altitude, or the glide slope
        const fr = runwayFrame(arrRw, k.x, k.z);
        const gpi = runwayFrame(arrRw, arrRw.ils.gpi.x, arrRw.ils.gpi.z).along;
        const pathH = (gpi - fr.along) * Math.tan(arrRw.ils.slopeDeg * D2R);
        const onSlope = mode === 'air' && onFinal && k.h > pathH - 15;
        let vsT: number;
        if (onSlope) {
          vsT = -k.v * Math.tan(3 * D2R) + (pathH - k.h) * 0.25;
          // the flare: from 35 ft, round out to a gentle touchdown
          const raFt = k.h / FT;
          if (raFt < 35) vsT = -fpm(70 + (raFt / 35) * 630);
          throttle = raFt < 12 ? 0 : A320.detents.cl;
        } else {
          const target = ((c.altitudeFt || plan.cruiseFt) * FT + SEA_Y) - k.h;
          vsT = clamp(target * 0.08, -fpm(1500), fpm(mode === 'missed' ? 2500 : 2200));
          throttle = A320.detents.cl;
        }
        k.vs += clamp(vsT - k.vs, -2 * dt, 2 * dt);
        n1 = throttle === 0 ? Math.max(A320.n1Idle, n1 - dt * 0.2) : mode === 'missed' && k.vs > 0 ? 0.9 : 0.6;
        k.h += k.vs * dt;

        // ATC's go-around: TOGA and climb away
        if (mode === 'air' && c.heading !== null && phaseIndex(nav.phase) >= phaseIndex('approach') && !c.approach) mode = 'missed';
        if (mode === 'missed' && c.directTo === arrRw.iaf && c.heading === null) {
          gaDirect = true;
          mode = 'air';
        }
        if (k.h <= 0 && mode === 'air') {
          // touchdown on the mains
          k.h = 0;
          const fpm = -k.vs / FT * 60;
          k.vs = 0;
          k.onGround = true;
          k.turnRate = 0;
          writeState(k, s, 0);
          const e: FdmEvent = { kind: 'touchdown', gear: 'main', vsFpm: -fpm, g: 1 + fpm / 1500, bank: 0, pitch: 4, crabDeg: 0, ias: s.ias, pos: s.pos.clone(), surface: 'runway' };
          scorer.event(e, s);
          const tf = runwayFrame(arrRw, k.x, k.z);
          log.touchdown = { along: tf.along, right: tf.right, fpm };
          mode = 'rollout';
          afterTd = 0;
        }
        break;
      }
      case 'rollout': {
        afterTd += dt;
        k.hdg = arrRw.heading;
        s.spoilers = 1;
        s.reverser = afterTd < 14 && s.ias > 70 ? Math.min(1, afterTd / 2) : Math.max(0, s.reverser - dt);
        n1 = s.reverser > 0.5 ? 0.7 : A320.n1Idle;
        // braking like autobrake MED, then down to the exit's speed at the exit ATC gave
        const exitName = c.vacate;
        const ex = exitName ? arrRw.exits.find((x) => x.name === exitName)! : null;
        const along = runwayFrame(arrRw, k.x, k.z).along;
        const vExit = ex?.rapid ? 22 : 7;
        const vt = ex ? Math.sqrt(vExit * vExit + 2 * 2.5 * Math.max(0, ex.distM - along - 20)) : 15;
        k.v = Math.max(k.v - 2.6 * dt, Math.min(k.v, vt));
        if (ex && along >= ex.distM - 25) {
          const ap2 = AIRFIELDS[to];
          const off = neighbours(ap2, ex.node).find((n) => n.edge.name === ex.name)!;
          const on = ap2.nodes[off.to];
          path = [{ x: on.x, z: on.z }];
          mode = 'exit';
          s.spoilers = 0;
        }
        break;
      }
      case 'exit':
        s.reverser = 0;
        s.spoilers = 0;
        n1 = 0.24;
        if (c.taxiIn) {
          // the taxi route starts at the node ahead of the aircraft: from there to the stand
          path = nodePts(c.taxiIn.route, to);
          mode = 'taxi-in';
        } else if (taxi(13)) k.v = 0;
        break;
      case 'taxi-in': {
        taxi(12);
        if (nav.phase === 'parked') {
          mode = 'parked';
          scorer.finish(s);
        }
        break;
      }
      case 'parked':
        n1 = Math.max(0, n1 - dt * 0.05);
        break;
    }

    // move (the tug places the aircraft itself)
    if (mode !== 'push') {
      const g = headingVec(k.hdg);
      k.x += g.x * k.v * dt;
      k.z += g.z * k.v * dt;
    }
    s.n1[0] = n1;
    s.n1[1] = n1;
    s.surface = k.onGround ? (onRunway(AIRFIELDS[regionAt(k.x, k.z)], k.x, k.z) ? 'runway' : 'taxiway') : 'water';
    writeState(k, s, dt);

    // the radio modules, as the attraction runs them each frame
    const a = performance.now();
    nav.update(dt, s);
    atc.update(dt, s, f);
    cabin.update(dt, s);
    callouts.update(dt, s, f, nav.ils(s), nav.phase, throttle);
    scorer.update(dt, s, f);
    speech.update(dt);
    cost += performance.now() - a;
    frames++;

    log.maxQueue = Math.max(log.maxQueue, speech.queued);
    if (nav.phase !== lastPhase) {
      lastPhase = nav.phase;
      log.phases.push({ phase: nav.phase, t });
    }
    if (nav.activeIndex !== lastIndex) {
      if (lastIndex >= 0 && nav.legs[lastIndex]) {
        const fx = nav.legs[lastIndex];
        log.fixes.push({ name: fx.name, t, distM: Math.hypot(fx.x - s.pos.x, fx.z - s.pos.z) });
      }
      lastIndex = nav.activeIndex;
    }
    // managed speed samples: the takeoff, the climb below FL100, near the IAF, and on short final
    if (nav.phase === 'takeoff' && !s.onGround && !log.managed.takeoff) log.managed.takeoff = nav.managedSpeed(s);
    if (nav.phase === 'climb' && s.altFt > 3000 && !log.managed.climb) log.managed.climb = nav.managedSpeed(s);
    const iaf = nav.legs.find((l) => l.name === arrRw.iaf)!;
    if (nav.phase === 'descent' && nav.activeFix === iaf && Math.hypot(iaf.x - s.pos.x, iaf.z - s.pos.z) < 9 * NM && !log.managed.iaf) log.managed.iaf = nav.managedSpeed(s);
    if (s.config >= 5 && nav.phase === 'final' && !log.managed.vapp) log.managed.vapp = nav.managedSpeed(s);

    if (o.stopAfterGoAround && gaDirect) break;
    if (mode === 'parked' && speech.idle && t > 5) {
      log.parked = true;
      // let the cabin finish its goodbyes
      if (log.lines.some((l) => /enjoy your stay/.test(l.u.text))) break;
    }
  }
  log.timeS = t;
  log.costMs = cost / Math.max(1, frames);
  return log;
}


// ------------------------------------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------------------------------------

export function runRadioChecks(): Row[] {
  const rows: Row[] = [];
  const add = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });

  // ---------------------------------------------------------------- ILS geometry
  {
    const rw: RunwayEnd = AIRFIELDS.home.runways['27'];
    const s = blankState();
    const gpiAlong = runwayFrame(rw, rw.ils.gpi.x, rw.ils.gpi.z).along;
    const at = (outM: number, rightM: number, aboveDeg = 0) => {
      // a point `outM` before the threshold, `rightM` right of the centreline, on the 3° path (+ `aboveDeg`)
      const f = headingVec(rw.heading);
      const rx = -f.z;
      const rz = f.x;
      const x = rw.threshold.x - f.x * outM + rx * rightM;
      const z = rw.threshold.z - f.z * outM + rz * rightM;
      const gsd = Math.hypot(x - rw.ils.gsAntenna.x, z - rw.ils.gsAntenna.z);
      const h = gsd * Math.tan((rw.ils.slopeDeg + aboveDeg) * D2R);
      s.pos.set(x, h, z);
      return ilsReading(rw, s);
    };
    const c = at(5 * NM, 0);
    add('ILS: on the localizer and the slope at 5 NM', c.valid && near(c.loc, 0, 0.01) && near(c.gs, 0, 0.01) && near(c.dme, 5, 0.1), `loc ${c.loc.toFixed(3)} gs ${c.gs.toFixed(3)} dme ${c.dme.toFixed(2)} NM, ${rw.ils.ident} ${rw.ils.freq}`);
    // 1.25° off at the localizer antenna (one dot), right of the centreline: the runway is left, the pointer goes negative
    const antD = Math.abs(runwayFrame(rw, rw.ils.locAntenna.x, rw.ils.locAntenna.z).along) + 5 * NM;
    const oneDot = antD * Math.tan(1.25 * D2R);
    const r1 = at(5 * NM, oneDot);
    const l1 = at(5 * NM, -oneDot * 2);
    add('ILS: localizer 1.25° a dot, sign (right of course = runway left)', near(r1.loc, -1, 0.02) && near(l1.loc, 2, 0.04) && near(r1.locM, oneDot, 0.5), `${oneDot.toFixed(0)} m right → ${r1.loc.toFixed(3)} dots; ${(2 * oneDot).toFixed(0)} m left → ${l1.loc.toFixed(3)}`);
    const hi = at(5 * NM, 0, 0.35);
    const lo = at(5 * NM, 0, -0.7);
    const peg = at(5 * NM, 0, -1.5);
    add('ILS: glide slope 0.35° a dot (0.7° full scale), above = negative', near(hi.gs, -1, 0.02) && near(lo.gs, 2, 0.03) && near(peg.gs, 2.5, 1e-6) && hi.gsFt > 0, `+0.35° → ${hi.gs.toFixed(3)}, −0.7° → ${lo.gs.toFixed(3)}, −1.5° pegs at ${peg.gs.toFixed(2)}; ${hi.gsFt.toFixed(0)} ft above`);
    // at the threshold on the path: the threshold crossing height
    const f = headingVec(rw.heading);
    s.pos.set(rw.threshold.x, gpiAlong * Math.tan(3 * D2R), rw.threshold.z);
    const thr = ilsReading(rw, s);
    add('ILS: threshold crossing height on the path', near(thr.gsFt, 0, 0.5) && near(rw.ils.tchFt, 51.5, 1), `TCH ${rw.ils.tchFt.toFixed(1)} ft, deviation ${thr.gsFt.toFixed(2)} ft`);
    const far = at(19 * NM, 0);
    const wide = at(5 * NM, (5 * NM + 3800) * Math.tan(40 * D2R));
    s.pos.set(rw.ils.locAntenna.x + f.x * 500, 300, rw.ils.locAntenna.z);
    const behind = ilsReading(rw, s);
    const inside = at(17.5 * NM, 0);
    add('ILS: coverage 18 NM, ±35°, in front of the antenna', !far.valid && !wide.valid && !behind.valid && inside.valid, `19 NM ${far.valid}, 40° off ${wide.valid}, behind ${behind.valid}, 17.5 NM ${inside.valid}`);
  }

  // ---------------------------------------------------------------- managed and approach speeds
  {
    const v = takeoffSpeeds(66000);
    const vh = takeoffSpeeds(73500);
    add('Takeoff speeds V1 ≤ VR < V2, scale with √mass', v.v1 <= v.vr && v.vr < v.v2 && v.v2 === A320.targets.v2Conf1F && vh.v2 > v.v2, `66 t ${v.v1}/${v.vr}/${v.v2}, 73.5 t ${vh.v1}/${vh.vr}/${vh.v2}`);
    const nav = new Navigator(flightPlan('home', '27', '27'));
    nav.setArrivalWind(270, 30);
    const s = blankState();
    s.config = 5;
    setSpeeds(s);
    const vls = s.speeds.vls;
    const strong = nav.vapp(s);
    nav.setArrivalWind(270, 6);
    const light = nav.vapp(s);
    nav.setArrivalWind(90, 10);
    const tail = nav.vapp(s);
    add('VAPP = VLS + ⅓ headwind, 5..15 kt', strong === Math.round(vls + 10) && light === Math.round(vls + 5) && tail === Math.round(vls + 5), `VLS ${vls.toFixed(1)}: 30 kt head → ${strong}, 6 kt → ${light}, tailwind → ${tail}`);
  }

  // ---------------------------------------------------------------- scoring rules
  {
    const plan = flightPlan('home', '27', '27');
    const rw = AIRFIELDS.island.runways['27'];
    const f = fcu();
    const mk = () => {
      const nav = new Navigator(plan);
      const sc = new FlightScorer(nav);
      const s = blankState();
      s.onGround = false;
      s.pos.set(0, 1500, 20000);
      s.altFt = 5000;
      s.radioAltFt = 5000;
      s.ias = 240;
      s.gear = 0;
      sc.update(1, s, f);
      return { nav, sc, s };
    };
    let landS = blankState();
    const land = (fpm: number, along = 450, right = 0, crab = 0) => {
      const { sc, s } = mk();
      const fw = headingVec(rw.heading);
      const x = rw.threshold.x + fw.x * along + -fw.z * right;
      const z = rw.threshold.z + fw.z * along + fw.x * right;
      s.pos.set(x, 0, z);
      s.track = rw.heading;
      sc.event({ kind: 'touchdown', gear: 'main', vsFpm: -fpm, g: 1.1, bank: 0, pitch: 4, crabDeg: crab, ias: 135, pos: s.pos.clone(), surface: 'runway' }, s);
      landS = s;
      return sc;
    };
    const bands: [number, number][] = [[100, 100], [180, 95], [300, 90], [500, 80], [700, 60]];
    const got = bands.map(([fpm]) => land(fpm).score());
    add('Score: landing rate bands 0/−5/−10/−20/−40', got.every((g, i) => g === bands[i][1]), bands.map(([fpm], i) => `${fpm} fpm → ${got[i]}`).join(', '));
    const long = land(100, 1000).score();
    const off = land(100, 450, 10).score();
    const crab = land(100, 450, 0, 7).score();
    const short = land(100, -30);
    add('Score: long −15, centreline > 8 m −10, crab > 5° −10', long === 85 && off === 90 && crab === 90, `1000 m → ${long}, 10 m off → ${off}, 7° crab → ${crab}`);
    {
      const { sc, s } = mk();
      s.pos.set(rw.threshold.x + 80, 0, rw.threshold.z);
      sc.event({ kind: 'touchdown', gear: 'main', vsFpm: -200, g: 1.1, bank: 0, pitch: 4, crabDeg: 0, ias: 135, pos: s.pos.clone(), surface: 'grass' }, s);
      add('Score: touchdown short of the runway fails (impact)', sc.failed === 'impact' && sc.score() === 0 && sc.stars() === 1 && short.score() <= 80, `on the grass → failed ${sc.failed}, score ${sc.score()}; on the pavement short of the threshold → ${short.score()}`);
    }
    {
      const { sc, s } = mk();
      sc.event({ kind: 'tailstrike', pitch: 12 }, s);
      const a = sc.score();
      sc.event({ kind: 'podstrike', side: 'L' }, s);
      add('Score: tailstrike −30, podstrike −40', a === 70 && sc.score() === 30, `tailstrike → ${a}, + podstrike → ${sc.score()}`);
    }
    {
      const { sc, s } = mk();
      s.bank = 40;
      sc.update(0.5, s, f);
      sc.update(0.5, s, f);
      const a = sc.score();
      s.bank = 50;
      sc.update(0.5, s, f);
      const b = sc.score();
      s.bank = 10;
      sc.update(3, s, f);
      s.bank = 38;
      sc.update(0.5, s, f);
      add('Score: bank > 35° −5, > 45° −10 once per excursion', a === 95 && b === 90 && sc.score() === 85, `40° → ${a}, then 50° → ${b}, a new 38° excursion → ${sc.score()}`);
    }
    {
      const { sc, s } = mk();
      s.nz = 1.45;
      sc.update(0.1, s, f);
      sc.update(5, s, f);
      const a = sc.score();
      sc.update(16, s, f);
      s.nz = 1;
      s.ias = 270;
      for (let i = 0; i < 50; i++) sc.update(0.1, s, f);
      const b = sc.score();
      for (let i = 0; i < 50; i++) sc.update(0.1, s, f);
      add('Score: load factor −5 / 20 s, 250 kt below FL100 −5 / 30 s', a === 95 && b === 85 && sc.score() === 85, `1.45 g → ${a} (once in 5 s), again 21 s later + 270 kt → ${b}, still 270 kt 5 s later → ${sc.score()}`);
    }
    {
      const { sc, s } = mk();
      s.ias = 360;
      sc.update(0.1, s, f);
      const a = sc.score();
      s.ias = 200;
      s.config = 5;
      sc.update(0.1, s, f);
      const b = sc.score();
      s.config = 0;
      s.stallWarning = true;
      sc.update(0.1, s, f);
      const c = sc.score();
      s.stallWarning = false;
      sc.alert('sink-rate');
      sc.alert('sink-rate');
      add('Score: VMO −15, flap overspeed −10, stall −15, GPWS −10', a === 85 && b === 75 && c === 60 && sc.score() === 50, `360 kt → ${a}, FULL at 200 kt → ${b}, stall warning → ${c}, SINK RATE ×2 → ${sc.score()}`);
    }
    {
      const { sc, s } = mk();
      sc.event({ kind: 'crash', reason: 'ditching', ias: 140, vsFpm: -900 }, s);
      add('Score: a ditching fails the flight', sc.failed === 'ditching' && sc.score() === 0 && sc.stars() === 1 && /ditched/.test(sc.debrief().title), `failed ${sc.failed}, "${sc.debrief().title}"`);
    }
    {
      // a flight 7 minutes over its block time: −3 a minute, at most −15; and the smooth bonus
      const late = mk();
      late.nav.phase = 'cruise';
      late.sc.update(plan.blockTimeS + SCHEDULE_PAD_S + 7 * 60, Object.assign(late.s, { onGround: true }), f);
      late.nav.phase = 'parked';
      late.sc.finish(late.s);
      const smooth = land(90);
      smooth.finish(landS);
      add('Score: late −3/min (max −15), smooth flight +5', late.sc.score() === 85 && smooth.score() === 100 && smooth.items.some((i) => i.points === 5), `7 min late → ${late.sc.score()}; butter landing, comfort ${smooth.comfort()} → ${smooth.score()} with ${smooth.items.map((i) => `${i.points}`).join(' ')}`);
    }
    {
      const mkS = (score: number) => {
        const { sc } = mk();
        if (score < 100) sc.penalise('x', 100 - score);
        return sc.stars();
      };
      const st = [90, 89, 75, 74, 55, 54, 35, 34].map(mkS);
      add('Stars: ≥90 5★, ≥75 4★, ≥55 3★, ≥35 2★', st.join('') === '54433221', `90 89 75 74 55 54 35 34 → ${st.join(' ')}`);
    }
  }

  // ---------------------------------------------------------------- speech: the queue and the radio's numbers
  {
    const sp = new Speech(new Sfx());
    sp.enabled = false;
    for (let i = 0; i < 6; i++) sp.say({ speaker: 'cabin', from: 'Purser', text: `Line ${i}` });
    sp.update(0.1);
    const q = sp.queued;
    sp.say({ speaker: 'atc', from: 'Funfair Tower', text: 'Funfair 101, hold position.' });
    sp.update(0.1);
    const atcNow = sp.speaking?.speaker;
    sp.say({ speaker: 'gpws', from: 'GPWS', text: 'PULL UP' });
    sp.update(0.1);
    add('Speech: queue ≤ 3, ATC interrupts cabin, GPWS interrupts ATC', q <= 3 && atcNow === 'atc' && sp.speaking?.speaker === 'gpws' && sp.log.length >= 6, `queued ${q}, then ${atcNow}, then ${sp.speaking?.speaker}; ${sp.log.length} lines logged`);
    const words = [digits(9), freqWords('118.30'), freqWords('121.80'), altitudeWords(5000), altitudeWords(3500), flightLevelWords(120), headingWords(270), windWords(250, 12, 22), taxiwayWords('E2')];
    const want = ['niner', 'one one eight decimal three', 'one two one decimal eight', 'five thousand', 'three thousand five hundred', 'flight level one two zero', 'two seven zero', 'wind two five zero degrees, one two knots, gusting two two', 'Echo two'];
    const bad = words.map((w, i) => (w === want[i] ? '' : `${w} ≠ ${want[i]}`)).filter(Boolean);
    add('Speech: numbers the radio way', bad.length === 0, bad.join('; ') || words.slice(1, 6).join(' | '));
  }

  // ---------------------------------------------------------------- GPWS envelopes
  {
    const run = (set: (s: AircraftState) => void, phase: FlightPhase = 'approach') => {
      const sp = new Speech(new Sfx());
      sp.enabled = false;
      const co = new Callouts(sp, new Sfx());
      const seen: AlertKind[] = [];
      co.onAlert = (k) => seen.push(k);
      const s = blankState();
      s.onGround = false;
      s.gear = 1;
      s.config = 5;
      s.ias = 140;
      s.radioAltFt = 800;
      s.vs = -700;
      set(s);
      for (let i = 0; i < 20; i++) co.update(0.1, s, fcu(), null, phase, 0.3);
      return seen;
    };
    const sink = run((s) => (s.vs = -2600));
    const pull = run((s) => (s.vs = -3600));
    const gear = run((s) => {
      s.radioAltFt = 400;
      s.gear = 0;
    });
    const flaps = run((s) => {
      s.radioAltFt = 200;
      s.config = 2;
      s.ias = 150;
    });
    const bank = run((s) => (s.bank = 40));
    const calm = run(() => undefined);
    const dep = run((s) => {
      s.radioAltFt = 300;
      s.gear = 0;
      s.config = 2;
    }, 'climb');
    add(
      'GPWS: sink rate, pull up, too low gear/flaps, bank angle',
      sink[0] === 'sink-rate' && pull[0] === 'pull-up' && gear[0] === 'too-low-gear' && flaps[0] === 'too-low-flaps' && bank.includes('bank-angle') && calm.length === 0 && dep.length === 0,
      `2600 fpm @800 → ${sink}, 3600 → ${pull}, gear up @400 → ${gear}, CONF 1+F @200 → ${flaps}, 40° → ${bank}, normal → [${calm}], departing gear up → [${dep}]`,
    );
  }

  // ---------------------------------------------------------------- whole flights
  const wx = isaWeather({ windFrom: 260, windKt: 12, gustKt: 0, tempC: 29, dewC: 22, qnh: 1012, clouds: [{ cover: 'FEW', baseFt: 2500 }] });
  const out = fly({ from: 'home', callsign: 'Funfair 101', flightNo: 'FA101', weather: wx, depBusyS: 35, depReason: 'traffic on final', arrBusy: { fromNm: 14, toNm: 5.5, reason: 'traffic vacating' } });
  const back = fly({ from: 'island', callsign: 'Funfair 102', flightNo: 'FA102', weather: wx, depBusyS: 30, depReason: 'departing traffic', arrBusy: null });
  for (const [fl, label] of [
    [out, 'FA101'],
    [back, 'FA102'],
  ] as const) {
    const kinds = fl.clearances.map((c) => c.kind);
    const order = ['ifr', 'pushback', 'taxi', 'lineup', 'takeoff', 'descent', 'approach', 'land', 'vacate', 'taxi-in'];
    let at = -1;
    let inOrder = true;
    for (const kd of order) {
      const i = kinds.indexOf(kd, at + 1);
      if (i < 0) inOrder = false;
      else at = i;
    }
    add(`${label}: ATC clearances in order`, inOrder && fl.atc.clearance.taxiIn !== null && !kinds.includes('go-around'), kinds.join(' → '));
    const ph = fl.phases.map((p) => p.phase);
    const want: FlightPhase[] = ['boarding', 'pushback', 'taxi-out', 'takeoff', 'climb', 'cruise', 'descent', 'approach', 'final', 'landing', 'rollout', 'taxi-in', 'parked'];
    add(`${label}: phases in flight order`, ph.join() === want.join(), ph.map((p, i) => `${p} ${Math.round(fl.phases[i].t)}s`).join(', '));
    const names = fl.fixes.map((f) => f.name);
    const legs = fl.nav.legs.map((l) => l.name);
    const seqOk = names.every((n, i) => i === 0 || legs.indexOf(n) > legs.indexOf(names[i - 1])) && names.includes('CORAL') && names.includes(fl.nav.arrivalRunway.iaf) && names.includes(fl.nav.arrivalRunway.if) && names[names.length - 1] === `RW27`;
    const iafSeq = fl.fixes.find((f) => f.name === fl.nav.arrivalRunway.iaf);
    add(`${label}: fixes sequenced with turn anticipation`, seqOk && !!iafSeq && iafSeq.distM > 150 && iafSeq.distM < 4 * NM, fl.fixes.map((f) => `${f.name} (${Math.round(f.distM)} m)`).join(' → '));
    const m = fl.managed;
    const vs = takeoffSpeeds(64000);
    add(`${label}: managed speed V2+10 / 250 / 220 / VAPP`, m.takeoff === vs.v2 + 10 && m.climb === 250 && m.iaf === 220 && m.vapp >= 130 && m.vapp <= 150, `takeoff ${m.takeoff}, climb ${m.climb}, IAF ${m.iaf}, VAPP ${m.vapp}`);
    const td = fl.touchdown;
    const st = fl.scorer.stats();
    const keys = ['score', 'stars', 'comfort', 'landingFpm', 'landingG', 'centrelineM', 'touchdownM', 'flightTimeS', 'distanceM', 'maxAltitudeFt', 'topSpeedKt', 'maxG', 'minG', 'maxBankDeg', 'violations', 'delayS'];
    const keysOk = keys.every((kk) => kk in st) && Object.keys(st).length === 16;
    add(`${label}: landed, parked, scored`, fl.parked && !!td && td.along > 150 && td.along < 900 && Math.abs(td.right) < 3 && keysOk && fl.scorer.failed === null && st.score >= 90, `touchdown ${td ? `${Math.round(td.along)} m, ${td.right.toFixed(1)} m, ${Math.round(td.fpm)} fpm` : 'none'}; score ${st.score} ${st.stars}★ comfort ${st.comfort}; ${Math.round(fl.timeS)} s; ${fl.scorer.items.map((i) => `${i.points} ${i.label}`).join('; ')}`);
    add(`${label}: no violations or GPWS alerts on a clean flight`, fl.violations.length === 0 && fl.alerts.length === 0, `violations [${fl.violations.join('; ')}], alerts [${fl.alerts.join(', ')}]`);
    const said = fl.lines.map((l) => l.u.text).join('\n');
    const calls = ['One hundred knots', 'V1', 'Rotate', 'Positive climb', '2500', '1000', '500', '400', '300', 'MINIMUMS', '100', '50', '40', '30', '20', '10', 'RETARD', 'Spoilers', 'Reverse green', 'Seventy knots'];
    const missingCalls = calls.filter((c) => !fl.lines.some((l) => l.u.text === c));
    add(`${label}: flight-deck callouts`, missingCalls.length === 0, missingCalls.length ? `missing ${missingCalls.join(', ')}` : calls.join(', '));
    const cab = [/arm doors/, /safety demonstration/, /life jacket/, /this is your captain speaking/, /seats for takeoff/, /started our descent/, /seats for landing/, /welcome to (Palm Cay|Funfair International)/i, /disarm doors/];
    const missingCab = cab.filter((r) => !r.test(said));
    add(`${label}: cabin announcements`, missingCab.length === 0, missingCab.length ? `missing ${missingCab.join(', ')}` : `${fl.lines.filter((l) => l.u.speaker === 'pa' || l.u.speaker === 'captain').length} PA lines`);
    const phr = [/information \w+, time \d{4}\. Runway 27 in use/, /request clearance to/, /pushback and start-up approved, face (east|west)/, /taxi to holding point A\d, runway 27, via/, /contact Tower 118\.\d+/, /cleared for takeoff/, /contact Sea Radar/, /Climb and maintain 5,000 ft/, /descend 3,000 ft/, /cleared ILS approach runway 27/, /cleared to land/, /vacate via E2/, /Taxi to stand \d via/];
    const missingPhr = phr.filter((r) => !r.test(said));
    add(`${label}: ATC phraseology`, missingPhr.length === 0, missingPhr.length ? `missing ${missingPhr.join(', ')}` : `${fl.lines.filter((l) => l.u.speaker === 'atc').length} ATC lines, ATIS "${fl.atc.atis.text.slice(0, 70)}…"`);
    add(`${label}: speech queue never above 3, radio cost per frame`, fl.maxQueue <= 3 && fl.costMs < 0.15, `max queue ${fl.maxQueue}, ${(fl.costMs * 1000).toFixed(1)} µs per frame for nav + ATC + cabin + callouts + scorer + speech`);
  }
  add('FA101: held for landing traffic, cleared only when free', out.heldWhileBusy && !out.takeoffWhileBusy && /hold position, traffic on final/.test(out.lines.map((l) => l.u.text).join('\n')), `held ${out.heldWhileBusy}, takeoff clearance while busy ${out.takeoffWhileBusy}`);
  add('FA101: continue approach while the runway is busy, then cleared to land', /continue approach, traffic vacating/.test(out.lines.map((l) => l.u.text).join('\n')) && !out.landWhileBusy, `cleared to land while busy: ${out.landWhileBusy}`);
  add('FA102: line up and wait behind a departure', /line up and wait runway 27, departing traffic/.test(back.lines.map((l) => l.u.text).join('\n')) && back.clearances.findIndex((c) => c.kind === 'lineup') < back.clearances.findIndex((c) => c.kind === 'takeoff'), back.clearances.map((c) => `${c.kind} ${Math.round(c.t)}s`).slice(2, 6).join(', '));

  // ---------------------------------------------------------------- a go-around ordered by the tower
  {
    const ga = fly({ from: 'home', callsign: 'Funfair 101', flightNo: 'FA101', weather: wx, depBusyS: 0, depReason: '', arrBusy: 'always', stopAfterGoAround: true, maxS: 1400 });
    const kinds = ga.clearances.map((c) => c.kind);
    const said = ga.lines.map((l) => l.u.text).join('\n');
    const ok = kinds.includes('go-around') && !kinds.includes('land') && ga.nav.goArounds === 1 && ga.nav.activeFix?.name === ga.nav.arrivalRunway.iaf && /go around, I say again, go around/.test(said) && /another ILS approach/.test(said) && ga.violations.length === 0;
    add('Go-around: ordered on short final, missed approach, back to the IAF', ok, `${kinds.slice(-4).join(' → ')}; nav go-arounds ${ga.nav.goArounds}, active fix ${ga.nav.activeFix?.name}, violations [${ga.violations.join('; ')}]`);
  }
  return rows;
}
