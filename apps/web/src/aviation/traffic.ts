// The other airliners: kinematic A320s (no flight model, just believable paths and speeds) that
// keep both airports busy round the player's flight.
//
// Each airport runs its own loop. An arrival appears 16–18 km out, intercepts the localizer, flies
// the 3° glide path, flares, rolls out with reversers and spoilers, leaves by the rapid exit and
// taxis (airports.ts taxiRoute) to one of the stands kept for traffic (TRAFFIC_STANDS). After its
// turnaround it pushes back behind a tug, taxis to the holding point, lines up, takes off, climbs
// out over the sea and is gone at 25 km. Now and then an airliner cruises across the strait at
// flight level 110. The runway is one aircraft's at a time (an arrival holds it from 2 km out until
// it has vacated, a departure from lining up until it's well clear), departures go in the gaps
// between arrivals, and everything keeps clear of the player: `holdForPlayer` (and the player
// being on the runway or on final) stops line-ups and new arrivals, and sends an arrival inside
// 3 NM around. Every movement has its radio calls (`onRadio`), paced like a real frequency.
//
// At most three AI aircraft per airport exist at once, the ones parked at the traffic stands
// included; away from the player's region they're hidden and stepped a few times a second.

import * as THREE from 'three';
import type { Ctx } from '../world/context';
import { FT, KT, NM, SEA_Y, type Region } from '../world/geo';
import { mulberry } from '../world/random';
import { LIVERIES, type LiveryId } from '../world/airport/liveries';
import { Path, stopSpeed, curveSpeed, wrap180, type P2, type Pose2 } from '../world/airport/airside-path';
import { PushbackTug, type Body } from '../world/airport/vehicles';
import { TRAFFIC_STANDS } from '../world/airport/airside';
import { restVisual } from '../world/airport/a320-model';
import { AIRFIELDS, onRunway, runwayForWind, runwayFrame, taxiRoute, type Airport, type RunwayEnd, type RunwayIdent } from './airports';
import type { AircraftState, PlaneModel, PlaneModelOptions, PlaneVisual, Utterance, Weather } from './types';
import { callsignWords, digits, freqWords, runwayWords, taxiwayWords, windText, windWords } from './speech';

const DEG = Math.PI / 180;
const TAN3 = Math.tan(3 * DEG);

/** Speeds (m/s): final approach, the initial approach, rotation, initial climb, climb, taxi, pushback. */
const V = { app: 137 * KT, initial: 180 * KT, rotate: 142 * KT, climb: 160 * KT, cruiseClimb: 250 * KT, taxi: 22 * KT, turn: 9 * KT, push: 1.3 };
/** The glide path's origin past the threshold (airports.ts GPI_M) and the flare's law (sink = A + B × height). */
const GPI_M = 300;
const FLARE = { a: 0.5, b: 0.45 };
/** Where an arrival appears (m from the threshold, and how far to the side, over the sea). */
const SPAWN = { min: 16000, max: 18000, side: 3000, alt: 3000 * FT };
/** Where a flight is finished with (m from its airport). */
const GONE = 25000;
/** A departure may line up only if no arrival is closer to the threshold than this (the arrival needs its landing clearance ~70 s later, 3 NM out). */
const DEP_GAP = 12000;
/** Arrivals follow each other at least this far apart (5 NM). */
const ARR_SEP = 5 * NM;
/** An arrival that's not been cleared to land by here goes around; holdForPlayer sends it round inside this too. */
const GA_DIST = 3 * NM;
/** Aircraft never get closer than this on the ground (m between reference points along the way). */
const TAXI_GAP = 55;
/** An aircraft's footprint for the airside's vehicles (wings included). */
const BODY_HL = 19;
const BODY_HW = 18;
/** Per airport: how many AI aircraft at once. */
const SLOTS = 3;
const SLOW_STEP = 0.5;
/** The overflight's level and speed. */
const OVER = { y: 11000 * FT + SEA_Y, v: 290 * KT, z: 20000, x: 32000 };

/** Who flies what: the callsign's airline for each livery, and the flight numbers it uses. */
const AIRLINE: Record<LiveryId, { name: string; numbers: number[] }> = {
  funfair: { name: 'Funfair', numbers: [207, 212, 315, 330, 404] },
  palmcay: { name: 'Palm Cay Air', numbers: [12, 18, 24, 31] },
  candy: { name: 'Candy', numbers: [23, 58, 61, 77] },
  sunset: { name: 'Sunset', numbers: [16, 41, 45, 88] },
  lagoon: { name: 'Lagoon', numbers: [7, 9, 14, 52] },
  cargo: { name: 'Starfreight', numbers: [9, 19, 29] },
};
const SLOT_LIVERIES: Record<Region, LiveryId[]> = { home: ['candy', 'sunset', 'lagoon'], island: ['palmcay', 'funfair', 'candy'] };

type Phase =
  | 'parked' // at a traffic stand, turning round
  | 'push' // pushed back by the tug
  | 'start' // engines starting at the end of the pushback
  | 'taxiOut' // to the holding point
  | 'hold' // at the holding point, waiting for the runway
  | 'lineup' // lining up (and waiting, if not yet cleared for takeoff)
  | 'takeoff' // the takeoff roll
  | 'climb' // airborne, climbing out
  | 'final' // on the approach
  | 'flare'
  | 'roll' // landed, slowing down
  | 'taxiIn' // vacating and taxiing to the stand
  | 'goaround'
  | 'cruise'; // the overflight

interface Flight {
  slot: number;
  /** The airport it belongs to (null: the overflight). */
  ap: Airport | null;
  callsign: string;
  say: string;
  phase: Phase;
  /** Seconds in this phase. */
  tp: number;
  pos: THREE.Vector3;
  heading: number;
  pitch: number;
  bank: number;
  /** Ground speed (m/s) along the heading, and vertical speed (m/s). */
  v: number;
  vs: number;
  path: Path | null;
  s: number;
  /** Where along the path it stops (a pushback ends short of the path's end, a line-up too). */
  end: number;
  /** The stand it's going to or parked at, and its runway end, holding point and exit. */
  stand: string | null;
  rw: RunwayEnd | null;
  entry: RunwayEnd['entries'][number] | null;
  exit: RunwayEnd['exits'][number] | null;
  /** Turnaround left (s), or other waits. */
  wait: number;
  cleared: boolean;
  /** Visual state ramps: gear, flaps, engines. */
  gear: number;
  flaps: number;
  n1: number;
  model: PlaneModel;
  visual: PlaneVisual;
  body: Body;
  /** Who it's waiting for (a flight's slot index), for breaking ties on the taxiways. */
  waitingFor: Flight | null;
  /** Radio calls already made in this phase (bit flags). */
  said: number;
}

interface Field {
  ap: Airport;
  region: Region;
  rw: RunwayEnd;
  slots: (Flight | null)[];
  models: PlaneModel[];
  liveries: LiveryId[];
  tug: PushbackTug;
  tugUser: Flight | null;
  hold: boolean;
  /** Whether the player is using the runway (on it, lined up, or on short final). */
  playerOnRunway: boolean;
  /** The player's distance to this field's threshold while on its approach (Infinity otherwise). */
  playerFinal: number;
  nextArrival: number;
  /** Logic steps far from the player run at a low rate. */
  acc: number;
  bodies: Body[];
}

interface RadioLine {
  u: Utterance;
  region: Region | null;
  station: 'tower' | 'ground' | 'radar' | 'pilot';
}

export interface TrafficOptions {
  createPlane: (o: PlaneModelOptions) => PlaneModel;
  /** An AI aircraft has arrived on a stand (dock the jet bridge, bring the equipment) or is about to push back from it. */
  onStand?: (region: Region, standId: string, state: 'arrived' | 'departing') => void;
  /** Seed for the schedule (flight numbers, turnaround times). */
  seed?: number;
}

const _e = new THREE.Euler();

export class Traffic {
  readonly group = new THREE.Group();
  /** Radio lines for the frequency the player is on (their airport's Ground / Tower, Sea Radar in the air). */
  onRadio: ((u: Utterance) => void) | null = null;
  /** Every radio line, with the airport and the station it was said on (to filter by frequency). */
  onRadioAt: ((u: Utterance, region: Region | null, station: 'tower' | 'ground' | 'radar' | 'pilot') => void) | null = null;

  private readonly ctx: Ctx;
  private readonly opts: TrafficOptions;
  private readonly fields: Record<Region, Field>;
  private readonly rnd: () => number;
  private over: Flight | null = null;
  private overModel: PlaneModel | null = null;
  private nextOver: number;
  private night = 0;
  private weather: Weather | null = null;
  private clock = 0;
  private readonly queue: RadioLine[] = [];
  private radioFree = 0;
  private playerRegion: Region = 'home';
  private playerAirborne = false;
  private readonly playerBody: Body = { x: 0, z: 0, heading: 0, hl: BODY_HL, hw: BODY_HW };
  private playerOnGround = false;
  private readonly contactList: { callsign: string; x: number; z: number; altFt: number; vs: number }[] = [];

  constructor(ctx: Ctx, opts: TrafficOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.rnd = mulberry(opts.seed ?? 20261020);
    this.group.name = 'traffic';
    this.fields = { home: this.field('home'), island: this.field('island') };
    this.nextOver = 90 + this.rnd() * 120;
    // start with the traffic stands busy (one departure soon) and an arrival on its way in
    for (const f of Object.values(this.fields)) this.seed(f);
  }

  private field(region: Region): Field {
    const ap = AIRFIELDS[region];
    const tug = new PushbackTug(this.ctx, ap, TRAFFIC_STANDS[region][0]);
    this.group.add(tug.group);
    return {
      ap,
      region,
      rw: ap.runways['27'],
      slots: new Array<Flight | null>(SLOTS).fill(null),
      models: [],
      liveries: SLOT_LIVERIES[region],
      tug,
      tugUser: null,
      hold: false,
      playerOnRunway: false,
      playerFinal: Infinity,
      nextArrival: 0,
      acc: 0,
      bodies: [],
    };
  }

  private seed(F: Field) {
    const stands = TRAFFIC_STANDS[F.region];
    stands.forEach((id, i) => {
      // home: the first stand's aircraft leaves soon; the second stand waits for the arrival
      if (F.region === 'home' && i === 1) return;
      const fl = this.newFlight(F, 'parked');
      if (!fl) return;
      const st = F.ap.stands.find((s) => s.id === id)!;
      this.parkAt(F, fl, st.id);
      fl.wait = 50 + this.rnd() * 40 + i * 120;
    });
    F.nextArrival = F.region === 'home' ? 2 : 140;
  }

  // ------------------------------------------------------------------------------------------------
  // The public side
  // ------------------------------------------------------------------------------------------------

  /** The weather sets each airport's runway in use (new movements use it). */
  setWeather(w: Weather) {
    this.weather = w;
    for (const F of Object.values(this.fields)) {
      const id: RunwayIdent = runwayForWind(w.windFrom, w.windKt);
      F.rw = F.ap.runways[id];
    }
  }

  /** The runway in use at an airport. */
  runwayInUse(region: Region): RunwayIdent {
    return this.fields[region].rw.ident;
  }

  setNight(k: number) {
    this.night = k;
    for (const F of Object.values(this.fields)) for (const m of F.models) m.setNight(k);
    this.overModel?.setNight(k);
  }

  /** Keep the AI off the runway while the player uses it (lining up, taking off, landing). */
  holdForPlayer(region: Region, on: boolean) {
    this.fields[region].hold = on;
  }

  /** Whether the runway is in use by AI traffic, for ATC (Atc's opts.runwayBusy). */
  runwayBusy(region: Region): { busy: boolean; clearInS: number; reason?: string } {
    const F = this.fields[region];
    let best: { busy: boolean; clearInS: number; reason?: string } = { busy: false, clearInS: 0 };
    for (const f of F.slots) {
      if (!f) continue;
      const st = this.runwayUse(F, f);
      if (st && (!best.busy || st.clearInS > best.clearInS)) best = st;
    }
    return best;
  }

  /** The AI aircraft in the air (and on the runway), for the ND's traffic display. */
  contacts() {
    const out = this.contactList;
    let n = 0;
    const add = (f: Flight) => {
      if (f.phase === 'parked' || f.phase === 'push' || f.phase === 'start') return;
      const c = out[n] ?? (out[n] = { callsign: '', x: 0, z: 0, altFt: 0, vs: 0 });
      c.callsign = f.callsign;
      c.x = f.pos.x;
      c.z = f.pos.z;
      c.altFt = (f.pos.y - SEA_Y) / FT;
      c.vs = (f.vs / FT) * 60;
      n++;
    };
    for (const F of Object.values(this.fields)) for (const f of F.slots) if (f) add(f);
    if (this.over) add(this.over);
    out.length = n;
    return out;
  }

  /** What every AI flight is doing (for the preview's status line and the logic check). */
  snapshot(): { region: Region | null; callsign: string; phase: string; x: number; y: number; z: number; kt: number }[] {
    const out: { region: Region | null; callsign: string; phase: string; x: number; y: number; z: number; kt: number }[] = [];
    for (const F of Object.values(this.fields)) for (const f of F.slots) if (f) out.push({ region: F.region, callsign: f.callsign, phase: f.phase, x: f.pos.x, y: f.pos.y, z: f.pos.z, kt: f.v / KT });
    if (this.over) out.push({ region: null, callsign: this.over.callsign, phase: this.over.phase, x: this.over.pos.x, y: this.over.pos.y, z: this.over.pos.z, kt: this.over.v / KT });
    return out;
  }

  /** The AI aircraft on the ground at an airport, for its vehicles to give way to (Airside.setAircraft). */
  bodies(region: Region): readonly Body[] {
    return this.fields[region].bodies;
  }

  update(dt: number, t: number, player: AircraftState | null, playerRegion: Region) {
    this.clock = t;
    this.playerRegion = playerRegion;
    this.playerAirborne = !!player && player.radioAltFt > 50;
    this.playerOnGround = !!player && !this.playerAirborne;
    if (player) {
      this.playerBody.x = player.pos.x;
      this.playerBody.z = player.pos.z;
      this.playerBody.heading = player.heading;
    }
    const cam = this.ctx.camera.position;
    for (const F of Object.values(this.fields)) {
      this.watchPlayer(F, player, playerRegion);
      const near = F.region === playerRegion || Math.hypot(cam.x, cam.z - F.ap.geo.runway.z) < GONE + 5000;
      if (near) {
        this.step(F, dt);
        F.acc = 0;
      } else {
        F.acc += dt;
        if (F.acc >= SLOW_STEP) {
          this.step(F, Math.min(F.acc, 2));
          F.acc = 0;
        }
      }
      for (const f of F.slots) if (f) this.pose(f, dt, t, near);
      F.tug.update(dt, t, this.night);
      F.tug.group.visible = near;
    }
    this.stepOverflight(dt, t);
    this.engineSound();
    this.radio();
  }

  dispose() {
    this.group.removeFromParent();
    for (const F of Object.values(this.fields)) {
      for (const m of F.models) m.dispose();
      F.tug.dispose();
    }
    this.overModel?.dispose();
  }

  // ------------------------------------------------------------------------------------------------
  // The loop at one airport
  // ------------------------------------------------------------------------------------------------

  /** Where the player is against this airport: on its runway, or on its final. */
  private watchPlayer(F: Field, player: AircraftState | null, region: Region) {
    F.playerOnRunway = false;
    F.playerFinal = Infinity;
    if (!player || region !== F.region) return;
    const p = player.pos;
    if (onRunway(F.ap, p.x, p.z, 10) && player.radioAltFt < 200) F.playerOnRunway = true;
    for (const rw of Object.values(F.ap.runways)) {
      const r = runwayFrame(rw, p.x, p.z);
      // on the approach: before the threshold, near the centreline, below 4000 ft, heading in
      if (this.playerAirborne && r.along < 0 && r.along > -20000 && Math.abs(r.right) < 3000 && player.altFt < 4000 && Math.abs(wrap180(player.heading - rw.heading)) < 60) {
        F.playerFinal = Math.min(F.playerFinal, -r.along);
        if (-r.along < GA_DIST) F.playerOnRunway = true;
      }
    }
  }

  private step(F: Field, dt: number) {
    // a new arrival when there's a stand for it, a slot free, and the approach is clear
    F.nextArrival -= dt;
    if (F.nextArrival <= 0) {
      F.nextArrival = 5;
      if (this.canSpawnArrival(F)) {
        this.spawnArrival(F);
        // a few movements an hour each way: the player rarely waits more than a couple of minutes
        F.nextArrival = (F.region === 'home' ? 200 : 260) + this.rnd() * 180;
      }
    }
    for (const f of F.slots) if (f) this.fly(F, f, dt);
    // the bodies the vehicles keep clear of
    F.bodies.length = 0;
    for (const f of F.slots) if (f && f.pos.y < 1 && f.phase !== 'parked') F.bodies.push(f.body);
  }

  private canSpawnArrival(F: Field) {
    if (F.hold || F.playerOnRunway || F.slots.every((s) => s)) return false;
    if (!this.freeStand(F)) return false;
    // behind the player on the approach, and behind the last arrival
    if (F.playerFinal < SPAWN.max + ARR_SEP) return false;
    for (const f of F.slots) if (f && (f.phase === 'final' || f.phase === 'goaround') && this.toThreshold(F, f) > SPAWN.min - ARR_SEP) return false;
    return true;
  }

  /** A traffic stand nobody is on or heading for. */
  private freeStand(F: Field): string | null {
    for (const id of TRAFFIC_STANDS[F.region]) if (!F.slots.some((f) => f && f.stand === id)) return id;
    return null;
  }

  private newFlight(F: Field, phase: Phase): Flight | null {
    const slot = F.slots.indexOf(null);
    if (slot < 0) return null;
    const model = (F.models[slot] ??= this.makeModel(F.liveries[slot]));
    const air = AIRLINE[F.liveries[slot]];
    const num = air.numbers[Math.floor(this.rnd() * air.numbers.length)];
    const callsign = `${air.name} ${num}`;
    const fl: Flight = {
      slot,
      ap: F.ap,
      callsign,
      say: callsignWords(callsign),
      phase,
      tp: 0,
      pos: new THREE.Vector3(),
      heading: 0,
      pitch: 0,
      bank: 0,
      v: 0,
      vs: 0,
      path: null,
      s: 0,
      end: 0,
      stand: null,
      rw: null,
      entry: null,
      exit: null,
      wait: 0,
      cleared: false,
      gear: 1,
      flaps: 0,
      n1: 0,
      model,
      visual: restVisual(),
      body: { x: 0, z: 0, heading: 0, hl: BODY_HL, hw: BODY_HW },
      waitingFor: null,
      said: 0,
    };
    model.group.visible = true;
    F.slots[slot] = fl;
    return fl;
  }

  private makeModel(livery: LiveryId) {
    const m = this.opts.createPlane({ livery: LIVERIES[livery], detail: 'ai', shadows: this.ctx.quality.shadows });
    m.setNight(this.night);
    m.group.visible = false;
    this.group.add(m.group);
    return m;
  }

  private end(F: Field, f: Flight) {
    f.model.group.visible = false;
    F.slots[f.slot] = null;
    if (F.tugUser === f) F.tugUser = null;
  }

  private setPhase(f: Flight, p: Phase) {
    f.phase = p;
    f.tp = 0;
    f.said = 0;
  }

  /** Metres to the threshold of the runway in use along the approach (negative past it). */
  private toThreshold(F: Field, f: Flight) {
    const rw = f.rw ?? F.rw;
    return -runwayFrame(rw, f.pos.x, f.pos.z).along;
  }

  // ------------------------------------------------------------------------------------------------
  // Arrivals
  // ------------------------------------------------------------------------------------------------

  private spawnArrival(F: Field) {
    const fl = this.newFlight(F, 'final');
    if (!fl) return;
    const rw = F.rw;
    fl.rw = rw;
    fl.stand = this.freeStand(F);
    fl.exit = rw.exits.find((e) => e.rapid) ?? rw.exits[0];
    const fx = Math.sin(rw.heading * DEG);
    const fz = -Math.cos(rw.heading * DEG);
    const d = SPAWN.min + this.rnd() * (SPAWN.max - SPAWN.min);
    // offset to the sea's side (south at home, north at Palm Cay): right of 27 at home is north…
    const seaZ = F.region === 'home' ? 1 : -1;
    fl.pos.set(rw.threshold.x - fx * d, Math.min(SPAWN.alt, (d + GPI_M) * TAN3), rw.threshold.z - fz * d + seaZ * SPAWN.side);
    // turn the intercept towards the centreline whichever side it's on
    const r = runwayFrame(rw, fl.pos.x, fl.pos.z);
    fl.heading = (rw.heading + (r.right > 0 ? -30 : 30) + 360) % 360;
    fl.v = V.initial;
    fl.gear = 0;
    fl.flaps = 1;
    fl.n1 = 0.45;
    const ap = F.ap;
    this.say(F, 'pilot', fl, `${ap.geo.atc} Tower, ${fl.callsign}, established ILS runway ${rw.ident}.`, `${ap.geo.atc} Tower, ${fl.say}, established I L S runway ${runwayWords(rw.ident)}.`);
    const n = this.arrivalsAhead(F, fl) + 1;
    this.say(F, 'tower', fl, `${fl.callsign}, ${ap.geo.atc} Tower, continue approach, number ${n}.`, `${fl.say}, ${ap.geo.atc} Tower, continue approach, number ${digits(n)}.`);
  }

  private arrivalsAhead(F: Field, fl: Flight) {
    let n = F.playerFinal < this.toThreshold(F, fl) ? 1 : 0;
    for (const f of F.slots) if (f && f !== fl && (f.phase === 'final' || f.phase === 'flare') && this.toThreshold(F, f) < this.toThreshold(F, fl)) n++;
    return n;
  }

  /** The runway is free for an arrival to land: nobody on it, nobody lined up, the player not using it. */
  private runwayFreeFor(F: Field, me: Flight) {
    if (F.hold || F.playerOnRunway) return false;
    for (const f of F.slots) {
      if (!f || f === me) continue;
      if (f.phase === 'roll' || f.phase === 'flare' || f.phase === 'lineup' || f.phase === 'takeoff') return false;
      if (f.phase === 'taxiIn' && this.onRunwayStrip(F, f)) return false;
    }
    return true;
  }

  private onRunwayStrip(F: Field, f: Flight) {
    return Math.abs(f.pos.z - F.ap.geo.runway.z) < 80 && f.pos.x > F.ap.geo.runway.x0 - 60 && f.pos.x < F.ap.geo.runway.x1 + 60;
  }

  private final(F: Field, f: Flight, dt: number) {
    const rw = f.rw!;
    const r = runwayFrame(rw, f.pos.x, f.pos.z);
    const toGo = -r.along;
    // localizer: pure pursuit of a point on the centreline ahead
    const look = Math.max(900, Math.min(3000, toGo * 0.25 + Math.abs(r.right)));
    const fx = Math.sin(rw.heading * DEG);
    const fz = -Math.cos(rw.heading * DEG);
    const tx = rw.threshold.x + fx * (r.along + look);
    const tz = rw.threshold.z + fz * (r.along + look);
    const want = (Math.atan2(tx - f.pos.x, -(tz - f.pos.z)) / DEG + 360) % 360;
    this.turnTo(f, want, 2.5, dt);
    // the glide path, joined from below (level until it's met)
    const glideY = (toGo + GPI_M) * TAN3;
    const targetY = Math.min(SPAWN.alt, glideY);
    const dy = Math.max(-12 * dt, Math.min(4 * dt, targetY - f.pos.y));
    // speed: back to the approach speed by 6 km out
    const vt = toGo > 10000 ? V.initial : toGo > 6000 ? V.app + ((V.initial - V.app) * (toGo - 6000)) / 4000 : V.app;
    f.v += Math.max(-0.6 * dt, Math.min(0.6 * dt, vt - f.v));
    // configuration: flaps out in stages, gear at 10 km, full flap by 8 km
    f.flaps = toGo > 13000 ? 1 : toGo > 10500 ? 2 : toGo > 8000 ? 3 : 4;
    if (toGo < 10000) f.gear = Math.min(1, f.gear + dt / 10);
    f.n1 = 0.32 + (f.v > vt + 1 ? -0.05 : 0.08) + (f.gear > 0.5 ? 0.06 : 0);
    this.move(f, dt, dy / Math.max(dt, 1e-6));
    f.pitch = 2.5 * DEG + (dy / dt > -1 ? 1.5 * DEG : 0);

    // the landing clearance, or a go-around
    if (!f.cleared && toGo < 8000 && this.runwayFreeFor(F, f)) {
      f.cleared = true;
      const w = this.wind();
      this.say(F, 'tower', f, `${f.callsign}, ${w.text}, runway ${rw.ident}, cleared to land.`, `${f.say}, ${w.say}, runway ${runwayWords(rw.ident)}, cleared to land.`);
      this.say(F, 'pilot', f, `Cleared to land runway ${rw.ident}, ${f.callsign}.`, `Cleared to land runway ${runwayWords(rw.ident)}, ${f.say}.`);
    }
    const blocked = F.hold || F.playerOnRunway;
    if ((blocked && toGo < GA_DIST && toGo > 200) || (!f.cleared && toGo < GA_DIST)) {
      this.goAround(F, f, blocked ? 'traffic on the runway' : 'runway occupied');
      return;
    }
    if (blocked) f.cleared = false;
    // the flare starts where its sink rate drops below the glide path's
    if (f.pos.y < (V.app * TAN3 - FLARE.a) / FLARE.b && toGo < 600) this.setPhase(f, 'flare');
  }

  private flare(f: Flight, dt: number) {
    // the sink eases off with height (an exponential flare), the nose comes up a little
    const sink = Math.min(V.app * TAN3, FLARE.a + FLARE.b * f.pos.y);
    f.v = Math.max(V.app - 6 * KT, f.v - 0.5 * dt);
    f.n1 = Math.max(0.2, f.n1 - dt * 0.12);
    this.followCentreline(f, dt);
    this.move(f, dt, -sink);
    f.pitch += (5 * DEG - f.pitch) * Math.min(1, dt * 1.2);
    if (f.pos.y <= 0) {
      f.pos.y = 0;
      f.vs = 0;
      this.setPhase(f, 'roll');
    }
  }

  /** On the runway: the reference point keeps to the centreline, heading along it. */
  private followCentreline(f: Flight, dt: number) {
    const rw = f.rw!;
    const r = runwayFrame(rw, f.pos.x, f.pos.z);
    const want = rw.heading - Math.max(-8, Math.min(8, r.right * 0.15));
    this.turnTo(f, want, 3, dt);
  }

  private roll(F: Field, f: Flight, dt: number) {
    const rw = f.rw!;
    const exit = f.exit!;
    const r = runwayFrame(rw, f.pos.x, f.pos.z);
    const left = exit.distM - r.along;
    // brake to the exit's speed by the exit
    const vExit = exit.rapid ? 15 : 7;
    const a = Math.max(0.8, Math.min(3, (f.v * f.v - vExit * vExit) / (2 * Math.max(40, left - 20))));
    f.v = Math.max(vExit, f.v - a * dt);
    f.pitch = Math.max(0, f.pitch - 1.6 * DEG * dt);
    this.followCentreline(f, dt);
    this.move(f, dt, 0);
    f.n1 = f.v > 70 * KT ? 0.7 : 0.22;
    if (left < 60) {
      // off the runway by the exit, then along the taxiways to the stand
      const route = taxiRoute(F.ap, exit.node, f.stand!);
      const pts: P2[] = [{ x: f.pos.x, z: f.pos.z }];
      const radii: number[] = [0];
      for (const id of route?.nodes ?? [exit.node]) {
        const n = F.ap.nodes[id];
        pts.push({ x: n.x, z: n.z });
        radii.push(n.kind === 'runway' ? 140 : 30);
      }
      f.path = new Path(pts, radii);
      f.s = 0;
      this.setPhase(f, 'taxiIn');
      const ap = F.ap;
      const via = (route?.via ?? []).filter((v) => v !== exit.name);
      this.say(F, 'tower', f, `${f.callsign}, vacate via ${exit.name}, contact Ground ${ap.freq.ground}.`, `${f.say}, vacate via ${taxiwayWords(exit.name)}, contact Ground ${freqWords(ap.freq.ground)}.`);
      this.say(F, 'pilot', f, `Via ${exit.name}, Ground ${ap.freq.ground}, ${f.callsign}.`, `Via ${taxiwayWords(exit.name)}, Ground ${freqWords(ap.freq.ground)}, ${f.say}.`);
      const gate = ap.stands.find((s) => s.id === f.stand)!.gate;
      const viaText = via.join(', ');
      const viaSay = via.map(taxiwayWords).join(', ');
      this.say(F, 'pilot', f, `${ap.geo.atc} Ground, ${f.callsign}, vacated ${exit.name}.`, `${ap.geo.atc} Ground, ${f.say}, vacated ${taxiwayWords(exit.name)}.`);
      this.say(F, 'ground', f, `${f.callsign}, taxi to stand ${gate} via ${viaText}.`, `${f.say}, taxi to stand ${digits(gate)} via ${viaSay}.`);
      this.say(F, 'pilot', f, `Stand ${gate} via ${viaText}, ${f.callsign}.`, `Stand ${digits(gate)} via ${viaSay}, ${f.say}.`);
    }
  }

  private goAround(F: Field, f: Flight, why: string) {
    this.setPhase(f, 'goaround');
    f.cleared = false;
    this.say(F, 'tower', f, `${f.callsign}, go around, I say again, go around, ${why}.`, `${f.say}, go around, I say again, go around, ${why}.`);
    this.say(F, 'pilot', f, `Going around, ${f.callsign}.`, `Going around, ${f.say}.`);
  }

  // ------------------------------------------------------------------------------------------------
  // Departures
  // ------------------------------------------------------------------------------------------------

  private parkAt(F: Field, f: Flight, standId: string) {
    const st = F.ap.stands.find((s) => s.id === standId)!;
    f.stand = standId;
    f.pos.set(st.x, 0, st.z);
    f.heading = st.heading;
    f.pitch = 0;
    f.v = 0;
    f.vs = 0;
    f.gear = 1;
    f.flaps = 0;
    f.n1 = 0;
    f.path = null;
    this.setPhase(f, 'parked');
    f.wait = 240 + this.rnd() * 180;
    this.opts.onStand?.(F.region, standId, 'arrived');
  }

  private parked(F: Field, f: Flight, dt: number) {
    f.wait -= dt;
    if (f.wait > 0 || F.tugUser || F.hold) return;
    // push only when nothing is taxiing along the lane behind the stand
    const st = F.ap.stands.find((s) => s.id === f.stand)!;
    const lane = F.ap.nodes[st.lane];
    for (const o of F.slots) if (o && o !== f && (o.phase === 'taxiIn' || o.phase === 'taxiOut' || o.phase === 'push') && Math.hypot(o.pos.x - lane.x, o.pos.z - lane.z) < 160) return;
    if (this.playerOnGround && this.playerRegion === F.region && Math.hypot(this.playerBody.x - lane.x, this.playerBody.z - lane.z) < 120) return;
    // face the way the runway's departure entry lies
    const rw = F.rw;
    f.rw = rw;
    f.entry = rw.entries[0];
    const hold = F.ap.nodes[f.entry.hold];
    const face: 'east' | 'west' = hold.x > st.x ? 'east' : 'west';
    const end = st.pushEnd[face];
    // tail first out of the stand, swinging onto the lane: the corner's leg on past the end keeps the turn round
    const ex = end.x + (end.x - st.x);
    f.path = new Path([{ x: st.x, z: st.z }, { x: st.x, z: end.z }, { x: ex, z: end.z }], 40);
    f.s = 0;
    f.end = f.path.length - Math.abs(ex - end.x);
    F.tugUser = f;
    F.tug.attach(st.id);
    this.opts.onStand?.(F.region, st.id, 'departing');
    this.setPhase(f, 'push');
    this.say(F, 'pilot', f, `${F.ap.geo.atc} Ground, ${f.callsign}, stand ${st.gate}, request pushback.`, `${F.ap.geo.atc} Ground, ${f.say}, stand ${digits(st.gate)}, request push back.`);
    this.say(F, 'ground', f, `${f.callsign}, pushback approved, face ${face}.`, `${f.say}, push back approved, face ${face}.`);
    this.say(F, 'pilot', f, `Pushback approved, face ${face}, ${f.callsign}.`, `Push back approved, face ${face}, ${f.say}.`);
  }

  private push(F: Field, f: Flight, dt: number) {
    const path = f.path!;
    const end = f.end;
    // the tug walks it back, slowing to a stop at the end of the push
    const vt = Math.min(V.push, Math.max(0.15, stopSpeed(end - f.s, 0.25)), f.tp < 6 ? f.tp * 0.25 : V.push);
    f.v = vt;
    f.s = Math.min(end, f.s + vt * dt);
    path.at(f.s, _pose);
    f.pos.x = _pose.x;
    f.pos.z = _pose.z;
    // tail first: the aircraft faces against the way it's moving
    f.heading = (_pose.heading + 180) % 360;
    f.n1 = Math.min(0.2, Math.max(0, (f.tp - 20) * 0.01));
    F.tug.follow({ x: f.pos.x, z: f.pos.z, heading: f.heading }, dt);
    if (f.s >= end - 0.05) {
      F.tug.detach();
      F.tugUser = null;
      f.v = 0;
      this.setPhase(f, 'start');
      f.wait = 25 + this.rnd() * 15;
      // off the stand: it's free for the next arrival
      f.stand = null;
    }
  }

  private start(F: Field, f: Flight, dt: number) {
    f.n1 = Math.min(0.21, f.n1 + dt * 0.01);
    f.wait -= dt;
    if (f.wait > 0) return;
    const entry = f.entry!;
    // along the lane the way it's facing, then the shortest way to the holding point
    const lanes = Object.values(F.ap.nodes).filter((n) => n.kind === 'lane');
    const fx = Math.sin(f.heading * DEG);
    let first = lanes[0];
    let best = Infinity;
    for (const n of lanes) {
      const ahead = (n.x - f.pos.x) * fx;
      if (ahead > 15 && ahead < best && Math.abs(n.z - f.pos.z) < 5) {
        best = ahead;
        first = n;
      }
    }
    const route = taxiRoute(F.ap, first.id, entry.hold);
    const pts: P2[] = [{ x: f.pos.x, z: f.pos.z }];
    for (const id of route?.nodes ?? [entry.hold]) pts.push({ x: F.ap.nodes[id].x, z: F.ap.nodes[id].z });
    f.path = new Path(pts, 30);
    f.s = 0;
    this.setPhase(f, 'taxiOut');
    const via = (route?.via ?? []).filter((v) => v !== entry.name);
    const rw = f.rw!;
    this.say(F, 'pilot', f, `${f.callsign}, ready to taxi.`, `${f.say}, ready to taxi.`);
    this.say(F, 'ground', f, `${f.callsign}, taxi to holding point ${entry.name}, runway ${rw.ident}, via ${via.join(', ')}.`, `${f.say}, taxi to holding point ${taxiwayWords(entry.name)}, runway ${runwayWords(rw.ident)}, via ${via.map(taxiwayWords).join(', ')}.`);
    this.say(F, 'pilot', f, `Holding point ${entry.name}, runway ${rw.ident}, via ${via.join(', ')}, ${f.callsign}.`, `Holding point ${taxiwayWords(entry.name)}, runway ${runwayWords(rw.ident)}, via ${via.map(taxiwayWords).join(', ')}, ${f.say}.`);
  }

  /** May this departure have the runway now? */
  private departureClear(F: Field, me: Flight) {
    if (F.hold || F.playerOnRunway || F.playerFinal < DEP_GAP) return false;
    for (const f of F.slots) {
      if (!f || f === me) continue;
      if (f.phase === 'lineup' || f.phase === 'takeoff' || f.phase === 'roll' || f.phase === 'flare') return false;
      if (f.phase === 'taxiIn' && this.onRunwayStrip(F, f)) return false;
      if ((f.phase === 'final' || f.phase === 'goaround') && this.toThreshold(F, f) < DEP_GAP && this.toThreshold(F, f) > -500) return false;
      if (f.phase === 'climb' && f.tp < 20) return false;
    }
    return true;
  }

  private holding(F: Field, f: Flight, dt: number) {
    f.v = 0;
    f.wait -= dt;
    if (!(f.said & 1)) {
      f.said |= 1;
      this.say(F, 'ground', f, `${f.callsign}, contact Tower ${F.ap.freq.tower}.`, `${f.say}, contact Tower ${freqWords(F.ap.freq.tower)}.`);
      this.say(F, 'pilot', f, `Tower ${F.ap.freq.tower}, ${f.callsign}.`, `Tower ${freqWords(F.ap.freq.tower)}, ${f.say}.`);
      this.say(F, 'pilot', f, `${F.ap.geo.atc} Tower, ${f.callsign}, holding point ${f.entry!.name}, ready for departure.`, `${F.ap.geo.atc} Tower, ${f.say}, holding point ${taxiwayWords(f.entry!.name)}, ready for departure.`);
      f.wait = 8;
    }
    if (f.wait > 0) return;
    if (!this.departureClear(F, f)) {
      // told once to hold position while the runway's in use
      if (!(f.said & 2)) {
        f.said |= 2;
        this.say(F, 'tower', f, `${f.callsign}, hold position, traffic on final.`, `${f.say}, hold position, traffic on final.`);
        this.say(F, 'pilot', f, `Holding position, ${f.callsign}.`, `Holding position, ${f.say}.`);
      }
      return;
    }
    // onto the runway, turning to face down it: lined up and away in one go (a gap between arrivals)
    const rw = f.rw!;
    const entry = f.entry!;
    const rn = F.ap.nodes[entry.runway];
    const fx = Math.sin(rw.heading * DEG);
    const fz = -Math.cos(rw.heading * DEG);
    f.path = new Path([{ x: f.pos.x, z: f.pos.z }, { x: rn.x, z: rn.z }, { x: rn.x + fx * 120, z: rn.z + fz * 120 }], 45);
    f.s = 0;
    f.end = f.path.length - 60;
    f.cleared = true;
    f.wait = 3;
    this.setPhase(f, 'lineup');
    const w = this.wind();
    this.say(F, 'tower', f, `${f.callsign}, ${w.text}, runway ${rw.ident}, cleared for takeoff.`, `${f.say}, ${w.say}, runway ${runwayWords(rw.ident)}, cleared for take off.`);
    this.say(F, 'pilot', f, `Cleared for takeoff runway ${rw.ident}, ${f.callsign}.`, `Cleared for take off runway ${runwayWords(rw.ident)}, ${f.say}.`);
  }

  private lineup(F: Field, f: Flight, dt: number) {
    const path = f.path!;
    if (f.s < f.end - 0.05) {
      const vt = Math.min(curveSpeed(path.radiusAhead(f.s, 30), 0.6, 7), Math.max(0.5, stopSpeed(f.end - f.s, 0.6)));
      f.v = vt > f.v ? Math.min(vt, f.v + 0.8 * dt) : vt;
      f.s = Math.min(f.end, f.s + f.v * dt);
      path.at(f.s, _pose);
      f.pos.x = _pose.x;
      f.pos.z = _pose.z;
      f.heading = _pose.heading;
      return;
    }
    f.v = 0;
    // the player has been given the runway after all: it waits, lined up, until it's back
    if (F.hold || F.playerOnRunway) {
      f.wait = 3;
      return;
    }
    f.wait -= dt;
    if (f.wait <= 0) this.setPhase(f, 'takeoff');
  }

  private takeoff(f: Flight, dt: number) {
    f.n1 = Math.min(0.92, f.n1 + dt * 0.15);
    f.flaps = 1;
    const a = f.v < 40 ? 2.1 : 1.75;
    f.v += a * dt * Math.min(1, f.n1 / 0.8);
    this.followCentreline(f, dt);
    if (f.v > V.rotate) f.pitch = Math.min(8 * DEG, f.pitch + 3 * DEG * dt);
    // airborne once rotated: climbing away
    const vs = f.pitch > 6 * DEG ? (f.pitch - 6 * DEG) * 120 : 0;
    this.move(f, dt, vs);
    if (f.pos.y > 1.5) {
      this.setPhase(f, 'climb');
      f.vs = vs;
    }
  }

  private climb(F: Field, f: Flight, dt: number, goAround: boolean) {
    // initial climb straight ahead, the gear up, then a turn out over the sea
    if (f.tp > (goAround ? 5 : 3)) f.gear = Math.max(0, f.gear - dt / 9);
    f.n1 = goAround && f.tp < 8 ? 0.95 : f.pos.y > 900 ? 0.82 : 0.9;
    const vt = f.pos.y < 600 ? V.climb : V.cruiseClimb;
    f.v += Math.max(-0.5 * dt, Math.min(0.9 * dt, vt - f.v));
    if (f.pos.y > 300) f.flaps = Math.max(0, f.flaps - dt / 15);
    const vsT = f.pos.y < 5000 * FT ? 12.7 : 2;
    f.vs += Math.max(-1 * dt, Math.min(1 * dt, vsT - f.vs));
    if (f.pos.y > 1500 * FT) this.turnTo(f, F.region === 'home' ? 180 : 0, 1.6, dt);
    this.move(f, dt, f.vs);
    f.pitch += (Math.atan2(f.vs, f.v) + 5 * DEG - f.pitch) * Math.min(1, dt);
    if (!(f.said & 1) && f.tp > 25) {
      f.said |= 1;
      const ap = F.ap;
      this.say(F, 'tower', f, `${f.callsign}, contact Sea Radar ${ap.freq.radar}, good day.`, `${f.say}, contact Sea Radar ${freqWords(ap.freq.radar)}, good day.`);
      this.say(F, 'pilot', f, `Sea Radar ${ap.freq.radar}, ${f.callsign}, good day.`, `Sea Radar ${freqWords(ap.freq.radar)}, ${f.say}, good day.`);
    }
    const c = F.ap.geo.runway;
    if (Math.hypot(f.pos.x, f.pos.z - c.z) > GONE) this.end(F, f);
  }

  // ------------------------------------------------------------------------------------------------
  // Taxiing
  // ------------------------------------------------------------------------------------------------

  private taxi(F: Field, f: Flight, dt: number) {
    const path = f.path!;
    const left = path.length - f.s;
    let vt = Math.min(curveSpeed(path.radiusAhead(f.s, 20 + (f.v * f.v) / 1.6), 0.55, f.phase === 'taxiIn' && f.tp < 12 ? 16 : V.taxi), Math.max(0.4, stopSpeed(left, 0.5)));
    // into the stand: slow for the marshalling
    if (f.phase === 'taxiIn' && left < 70) vt = Math.min(vt, 1 + left * 0.05);
    const gap = this.clearAhead(F, f);
    if (gap < Infinity) vt = Math.min(vt, stopSpeed(gap - TAXI_GAP, 0.8));
    f.v = vt > f.v ? Math.min(vt, f.v + 0.5 * dt) : Math.max(vt, f.v - 1.6 * dt);
    f.s = Math.min(path.length, f.s + f.v * dt);
    path.at(f.s, _pose);
    f.pos.x = _pose.x;
    f.pos.z = _pose.z;
    f.heading = _pose.heading;
    f.pitch = 0;
    f.n1 = 0.2 + (vt > f.v + 0.5 ? 0.06 : 0);
    if (left < 0.05) {
      if (f.phase === 'taxiIn') this.parkAt(F, f, f.stand!);
      else {
        this.setPhase(f, 'hold');
        f.wait = 0;
      }
    }
  }

  /** The distance to whatever is in the way ahead on the taxiways (other aircraft, the player's). */
  private clearAhead(F: Field, f: Flight) {
    const fx = Math.sin(f.heading * DEG);
    const fz = -Math.cos(f.heading * DEG);
    const range = 140 + (f.v * f.v) / 1.6;
    let best = Infinity;
    f.waitingFor = null;
    const test = (x: number, z: number, o: Flight | null) => {
      const dx = x - f.pos.x;
      const dz = z - f.pos.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > range) return;
      if (Math.abs(dx * -fz + dz * fx) > 40) return;
      // two aircraft in each other's way: the one that's waited for goes first
      if (o && o.waitingFor === f && o.slot < f.slot) return;
      if (ahead < best) {
        best = ahead;
        f.waitingFor = o;
      }
    };
    for (const o of F.slots) if (o && o !== f && o.pos.y < 1 && o.phase !== 'parked') test(o.pos.x, o.pos.z, o);
    if (this.playerOnGround && this.playerRegion === F.region) test(this.playerBody.x, this.playerBody.z, null);
    return best;
  }

  // ------------------------------------------------------------------------------------------------
  // Moving and drawing
  // ------------------------------------------------------------------------------------------------

  private fly(F: Field, f: Flight, dt: number) {
    f.tp += dt;
    switch (f.phase) {
      case 'parked':
        this.parked(F, f, dt);
        break;
      case 'push':
        this.push(F, f, dt);
        break;
      case 'start':
        this.start(F, f, dt);
        break;
      case 'taxiOut':
      case 'taxiIn':
        this.taxi(F, f, dt);
        break;
      case 'hold':
        this.holding(F, f, dt);
        break;
      case 'lineup':
        this.lineup(F, f, dt);
        break;
      case 'takeoff':
        this.takeoff(f, dt);
        break;
      case 'climb':
        this.climb(F, f, dt, false);
        break;
      case 'goaround':
        this.climb(F, f, dt, true);
        break;
      case 'final':
        this.final(F, f, dt);
        break;
      case 'flare':
        this.flare(f, dt);
        break;
      case 'roll':
        this.roll(F, f, dt);
        break;
      case 'cruise':
        break;
    }
    const b = f.body;
    b.x = f.pos.x;
    b.z = f.pos.z;
    b.heading = f.heading;
  }

  /** Turn towards a heading at up to `rate` °/s, banking into the turn. */
  private turnTo(f: Flight, want: number, rate: number, dt: number) {
    const d = wrap180(want - f.heading);
    const turn = Math.max(-rate * dt, Math.min(rate * dt, d * Math.min(1, dt * 0.6)));
    f.heading = (f.heading + turn + 360) % 360;
    const air = f.pos.y > 3;
    // the bank for that rate of turn at this speed (tan φ = ω v / g)
    const target = air ? Math.atan(((turn / Math.max(dt, 1e-6)) * DEG * f.v) / 9.81) : 0;
    f.bank += (Math.max(-25 * DEG, Math.min(25 * DEG, target)) - f.bank) * Math.min(1, dt * 1.5);
  }

  /** Move along the heading at v, climbing at vs. */
  private move(f: Flight, dt: number, vs: number) {
    f.vs = vs;
    f.pos.x += Math.sin(f.heading * DEG) * f.v * dt;
    f.pos.z -= Math.cos(f.heading * DEG) * f.v * dt;
    f.pos.y = Math.max(0, f.pos.y + vs * dt);
    if (f.pos.y <= 0) f.bank = 0;
  }

  /** The model follows the flight; its lights, gear, flaps, reversers and spoilers by phase. */
  private pose(f: Flight, dt: number, t: number, near: boolean) {
    const m = f.model;
    m.group.visible = near;
    if (!near) return;
    m.group.position.copy(f.pos);
    _e.set(f.pitch, -f.heading * DEG, -f.bank, 'YXZ');
    m.group.quaternion.setFromEuler(_e);
    const v = f.visual;
    const p = f.phase;
    const ground = f.pos.y < 0.5;
    const L = v.lights;
    const moving = p !== 'parked';
    const runway = p === 'lineup' || p === 'takeoff' || p === 'climb' || p === 'goaround' || p === 'final' || p === 'flare' || p === 'roll';
    L.beacon = moving || f.n1 > 0.01;
    L.nav = moving || this.night > 0.3;
    L.strobe = runway;
    L.landing = runway && (f.pos.y < 3000 || p !== 'climb');
    L.taxi = ground && moving && p !== 'push' && p !== 'start';
    L.logo = this.night > 0.3;
    L.cabin = this.night > 0.2;
    const flaps = [0, 10, 15, 20, 40][Math.round(Math.max(0, Math.min(4, f.flaps)))];
    const slats = [0, 18, 22, 22, 27][Math.round(Math.max(0, Math.min(4, f.flaps)))];
    v.flapsDeg += (flaps - v.flapsDeg) * Math.min(1, dt * 0.5);
    v.slatsDeg += (slats - v.slatsDeg) * Math.min(1, dt * 0.5);
    v.gear = f.gear;
    v.n1[0] = v.n1[1] = f.n1;
    v.reverser = p === 'roll' && f.v > 60 * KT ? Math.min(1, v.reverser + dt) : Math.max(0, v.reverser - dt * 0.5);
    const spoil = p === 'roll' ? 1 : 0;
    v.spoilerL += (spoil - v.spoilerL) * Math.min(1, dt * 3);
    v.spoilerR = v.spoilerL;
    v.wheelSpin = ground ? f.v / 0.57 : Math.max(0, v.wheelSpin - dt * 8);
    v.compression[0] = v.compression[1] = v.compression[2] = ground ? 0.22 : 0;
    v.nosewheel = 0;
    v.doorL1 = p === 'parked' && f.wait > 60 ? 1 : 0;
    v.cargo = v.doorL1;
    m.setVisual(v, dt, t);
  }

  // ------------------------------------------------------------------------------------------------
  // The overflight
  // ------------------------------------------------------------------------------------------------

  private stepOverflight(dt: number, t: number) {
    if (!this.over) {
      this.nextOver -= dt;
      if (this.nextOver > 0) return;
      this.nextOver = 420 + this.rnd() * 300;
      this.overModel ??= this.makeModel('cargo');
      const east = this.rnd() < 0.5;
      const callsign = `Starfreight ${AIRLINE.cargo.numbers[Math.floor(this.rnd() * 3)]}`;
      const f: Flight = {
        slot: -1,
        ap: null,
        callsign,
        say: callsignWords(callsign),
        phase: 'cruise',
        tp: 0,
        pos: new THREE.Vector3(east ? -OVER.x : OVER.x, OVER.y, OVER.z + (this.rnd() - 0.5) * 6000),
        heading: east ? 90 : 270,
        pitch: 2 * DEG,
        bank: 0,
        v: OVER.v,
        vs: 0,
        path: null,
        s: 0,
        end: 0,
        stand: null,
        rw: null,
        entry: null,
        exit: null,
        wait: 0,
        cleared: false,
        gear: 0,
        flaps: 0,
        n1: 0.78,
        model: this.overModel,
        visual: restVisual(),
        body: { x: 0, z: 0, heading: 0, hl: BODY_HL, hw: BODY_HW },
        waitingFor: null,
        said: 0,
      };
      this.over = f;
      if (this.playerAirborne) {
        const fl = 110;
        this.queueLine({ speaker: 'atc', from: callsign, text: `Sea Radar, ${callsign}, flight level ${fl}.`, say: `Sea Radar, ${f.say}, flight level ${digits(fl)}.`, priority: 1 }, null, 'pilot');
        this.queueLine({ speaker: 'atc', from: 'Sea Radar', text: `${callsign}, Sea Radar, identified, maintain flight level ${fl}.`, say: `${f.say}, Sea Radar, identified, maintain flight level ${digits(fl)}.`, priority: 1 }, null, 'radar');
      }
    }
    const f = this.over;
    f.tp += dt;
    f.pos.x += Math.sin(f.heading * DEG) * f.v * dt;
    const cam = this.ctx.camera.position;
    const near = Math.hypot(cam.x - f.pos.x, cam.z - f.pos.z) < 40000;
    const v = f.visual;
    v.gear = 0;
    v.n1[0] = v.n1[1] = f.n1;
    v.lights.nav = v.lights.beacon = v.lights.strobe = true;
    v.lights.logo = this.night > 0.3;
    v.lights.cabin = this.night > 0.2;
    f.model.group.visible = near;
    if (near) {
      f.model.group.position.copy(f.pos);
      _e.set(f.pitch, -f.heading * DEG, 0, 'YXZ');
      f.model.group.quaternion.setFromEuler(_e);
      v.compression[0] = v.compression[1] = v.compression[2] = 0;
      f.model.setVisual(v, dt, t);
    }
    if (Math.abs(f.pos.x) > OVER.x + 1) {
      f.model.group.visible = false;
      this.over = null;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Sound and radio
  // ------------------------------------------------------------------------------------------------

  /** The nearest running engines are heard (the loudness by distance from the camera). */
  private engineSound() {
    const cam = this.ctx.camera.position;
    let k = 0;
    let n1 = 0;
    for (const F of Object.values(this.fields))
      for (const f of F.slots) {
        if (!f || f.n1 < 0.05) continue;
        const d = cam.distanceTo(f.pos);
        // louder with power: the takeoff roll carries kilometres, idle taxiing a few hundred metres
        const kk = (f.n1 * f.n1) / (1 + (d / 220) ** 2);
        if (kk > k) {
          k = kk;
          n1 = f.n1;
        }
      }
    this.ctx.sfx?.trafficJet(Math.min(1, k * 1.6), n1);
  }

  private wind() {
    const w = this.weather;
    if (!w) return { text: windText(250, 8), say: windWords(250, 8) };
    return { text: windText(w.windFrom, w.windKt, w.gustKt), say: windWords(w.windFrom, w.windKt, w.gustKt) };
  }

  /** A radio call at this airport: the controller ('tower' / 'ground') or the flight's pilot. */
  private say(F: Field, who: 'tower' | 'ground' | 'pilot', f: Flight, text: string, say: string) {
    const from = who === 'pilot' ? f.callsign : `${F.ap.geo.atc} ${who === 'tower' ? 'Tower' : 'Ground'}`;
    this.queueLine({ speaker: 'atc', from, text, say, priority: 1 }, F.region, who);
  }

  private queueLine(u: Utterance, region: Region | null, station: RadioLine['station']) {
    // a frequency only has so much air: old chatter is dropped rather than read out late
    if (this.queue.length > 8) this.queue.shift();
    this.queue.push({ u, region, station });
  }

  /** One line at a time, each given the time it takes to say. */
  private radio() {
    if (this.clock < this.radioFree || !this.queue.length) return;
    const line = this.queue.shift()!;
    const words = (line.u.say ?? line.u.text).split(/\s+/).length;
    this.radioFree = this.clock + 0.9 + words * 0.36;
    this.onRadioAt?.(line.u, line.region, line.station);
    // the player hears their own airport's frequencies (and Sea Radar in the air)
    const here = line.region === null ? this.playerAirborne : line.region === this.playerRegion;
    if (here) this.onRadio?.(line.u);
  }

  // ------------------------------------------------------------------------------------------------
  // Runway use, for ATC
  // ------------------------------------------------------------------------------------------------

  private runwayUse(F: Field, f: Flight): { busy: boolean; clearInS: number; reason?: string } | null {
    switch (f.phase) {
      case 'final': {
        const d = this.toThreshold(F, f);
        if (d > 5000) return null;
        return { busy: true, clearInS: d / Math.max(30, f.v) + 50, reason: 'traffic on final' };
      }
      case 'flare':
        return { busy: true, clearInS: 50, reason: 'traffic landing' };
      case 'roll': {
        const left = f.exit ? f.exit.distM - runwayFrame(f.rw!, f.pos.x, f.pos.z).along : 500;
        return { busy: true, clearInS: Math.max(8, left / Math.max(10, f.v) + 12), reason: 'traffic landing' };
      }
      case 'taxiIn':
        return this.onRunwayStrip(F, f) ? { busy: true, clearInS: 10, reason: 'traffic vacating' } : null;
      case 'lineup':
        return { busy: true, clearInS: f.cleared ? 60 : 120, reason: 'departing traffic' };
      case 'takeoff':
        return { busy: true, clearInS: Math.max(10, (V.rotate - f.v) / 1.8 + 15), reason: 'departing traffic' };
      case 'climb':
        return f.tp < 15 ? { busy: true, clearInS: 15 - f.tp, reason: 'departing traffic' } : null;
      default:
        return null;
    }
  }
}

const _pose: Pose2 = { x: 0, z: 0, heading: 0 };
