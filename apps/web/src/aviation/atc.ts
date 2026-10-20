// Air traffic control for the player's flight, from the ATIS on the stand to "taxi to stand" at the
// other end, in ICAO phraseology:
//
//   ATIS            information letter, runway in use, wind, visibility, cloud, temperature, QNH
//   Ground          the IFR clearance, pushback and start-up ("face east"), taxi to the holding
//                   point via the taxiways, then "contact Tower"
//   Tower           hold position / line up and wait while the runway is busy, cleared for takeoff
//                   with the wind, then "contact Sea Radar"
//   Sea Radar       identified, climb 5,000 ft, direct CORAL; the hand-over between the two radar
//                   sectors mid-sea; descend 3,000 ft; cleared ILS approach; "contact Tower"
//   Tower           cleared to land with the wind, or continue approach while it's busy, or a
//                   go-around if the runway won't be clear in time; vacate via the rapid exit
//   Ground          taxi to the stand
//
// The player asks for pushback, taxi and takeoff (request()); everything else follows from where
// the aircraft is. The first officer makes the calls and reads every clearance back. ATC waits for
// the runway (runwayBusy, from the AI traffic) like a real tower, notices a runway incursion, a
// takeoff or landing without clearance and an altitude bust (onViolation: the scorer charges
// them), and other aircraft talk on the frequency now and then.

import { AIRFIELDS, HOLD_OFFSET, nearestNode, onRunway, runwayFrame, taxiRoute, type Airport, type NodeKind, type RunwayEnd } from './airports';
import { metar } from './weather';
import { phaseIndex, type Navigator } from './nav';
import {
  altitudeWords,
  callsignWords,
  digits,
  freqWords,
  headingText,
  headingWords,
  PHONETIC,
  qnhWords,
  runwayWords,
  taxiwayWords,
  windText,
  windWords,
  type Speech,
} from './speech';
import { mulberry } from '../world/random';
import { KT, NM, headingVec, regionAt, type Region } from '../world/geo';
import type { AircraftState, FcuState, Utterance, Weather } from './types';

export interface RunwayStatus {
  busy: boolean;
  /** Seconds until it's free (the landing traffic has vacated, the departure is airborne). */
  clearInS: number;
  /** What's using it, as ATC would say it: "traffic on final", "departing traffic", "traffic vacating". */
  reason?: string;
}

export type AtcRequest = 'pushback' | 'taxi' | 'takeoff' | 'skip-taxi-in';

export interface Clearance {
  pushback: boolean;
  taxi: { route: string[]; via: string[]; holdShort: string } | null;
  lineUp: boolean;
  takeoff: boolean;
  altitudeFt: number;
  heading: number | null;
  directTo: string | null;
  approach: boolean;
  land: boolean;
  vacate: string | null;
  taxiIn: { route: string[]; via: string[] } | null;
}

export interface AtcOptions {
  /** The callsign as written, e.g. "Funfair 101" (it's spoken "Funfair one zero one"). */
  callsign: string;
  /** The flight number, e.g. "FA101". */
  flightNo: string;
  /** Whether a region's runway is in use by other traffic (Traffic.runwayBusy). */
  runwayBusy: (region: Region) => RunwayStatus;
  /** The clock (hours) when the flight starts, for the ATIS time. Default 12.5. */
  hour?: number;
  /**
   * Other aircraft talking on the frequency: 'all' stations, only 'radar' (when the AI traffic's
   * own radio lines are wired to the speech, they already fill Ground and Tower), or 'off'.
   */
  chatter?: 'all' | 'radar' | 'off';
}

/** A line in a conversation: said after `delay` seconds of quiet; `then` runs once it has been said. */
interface Step {
  u: Utterance;
  delay: number;
  then?: () => void;
  /** ATIS lines give way when the crew start talking. */
  atis?: boolean;
}

type Stage =
  | 'clearance' // waiting for the IFR clearance
  | 'push' // cleared, ready to ask for pushback
  | 'taxi' // pushback approved, ready to ask for taxi
  | 'taxiing' // taxiing to the holding point, on Ground
  | 'tower' // on Tower, ready for departure
  | 'holding' // asked for takeoff, waiting for the runway
  | 'rolling' // cleared for takeoff
  | 'departure' // airborne on Tower
  | 'radar' // with Sea Radar
  | 'arr-tower' // with the arrival's Tower
  | 'missed' // going around, on Tower
  | 'vacating' // landed, told to vacate
  | 'arr-ground' // on the arrival's Ground
  | 'done';

const ft = (n: number) => `${Math.round(n).toLocaleString('en-GB')} ft`;

/** Other airlines on the frequency (fictional carriers). */
const OTHERS = ['Candy 23', 'Sunset 41', 'Palm Cay Air 12', 'Lagoon 7', 'Funfair 207', 'Starfreight 9', 'Candy 58', 'Sunset 16'];

export class Atc {
  readonly clearance: Clearance = {
    pushback: false,
    taxi: null,
    lineUp: false,
    takeoff: false,
    altitudeFt: 0,
    heading: null,
    directTo: null,
    approach: false,
    land: false,
    vacate: null,
    taxiIn: null,
  };
  /** Called when a clearance is given ('ifr', 'pushback', 'taxi', 'lineup', 'takeoff', 'direct', 'descent', 'approach', 'land', 'go-around', 'vacate', 'taxi-in', 'skip-taxi-in'). */
  onClearance: ((kind: string) => void) | null = null;
  /** Called for an ATC violation: the label, the points it costs, and 'runway-incursion' if it ends the flight. */
  onViolation: ((label: string, points: number, fatal?: 'runway-incursion') => void) | null = null;
  /** The station being talked to and its frequency (the radio panel shows it). */
  readonly station = { name: '', freq: '' };
  /** The ATIS: its letter, what it says, and the METAR it's built from. */
  readonly atis: { letter: string; text: string; metar: string };
  readonly squawk: string;
  /** The way the pushback leaves the aircraft facing, for the departure's taxi. */
  readonly pushFace: 'east' | 'west';
  /** The departure's runway entry (its holding point), e.g. "A4". */
  readonly entry: RunwayEnd['entries'][number];

  private stage: Stage = 'clearance';
  private readonly cs: string;
  private readonly csSay: string;
  private readonly dep: Airport;
  private readonly arr: Airport;
  private readonly depRw: RunwayEnd;
  private readonly arrRw: RunwayEnd;
  private readonly rnd: () => number;
  private readonly chatter: 'all' | 'radar' | 'off';

  private convo: Step[] = [];
  private inFlight: Step | null = null;
  private since = 0;
  private t = 0;
  private poll = 0;
  private pending: AtcRequest[] = [];
  /** What the crew have asked for already (each is asked once: the HUD stops offering it). */
  private readonly asked = new Set<AtcRequest>();
  private radarSector: Region;
  private descentGiven = false;
  private goAroundOrdered = false;
  private navGoArounds = 0;
  private incursion = false;
  private noTakeoffClearance = false;
  private landedFlagged = false;
  private reachedCleared = false;
  private bustFlagged = false;
  private lastCleared = 0;
  private clearedAt = 0;
  private nextChatter = 30;
  private wasOnGround = true;

  constructor(
    private readonly speech: Speech,
    private readonly nav: Navigator,
    private readonly w: Weather,
    private readonly opts: AtcOptions,
  ) {
    this.cs = opts.callsign;
    this.csSay = callsignWords(opts.callsign);
    this.dep = nav.departure;
    this.arr = nav.arrival;
    this.depRw = nav.departureRunway;
    this.arrRw = nav.arrivalRunway;
    this.chatter = opts.chatter ?? 'all';
    let h = 7;
    for (const ch of opts.flightNo) h = (h * 31 + ch.charCodeAt(0)) | 0;
    this.rnd = mulberry(h);
    const hour = opts.hour ?? 12.5;
    const letter = String.fromCharCode(65 + ((Math.floor(hour) + Math.abs(h)) % 26));
    this.atis = { letter, text: '', metar: metar(w, this.dep.geo.icao, hour) };
    this.squawk = `${4 + Math.floor(this.rnd() * 3)}${Math.floor(this.rnd() * 8)}${Math.floor(this.rnd() * 8)}${1 + Math.floor(this.rnd() * 7)}`;
    nav.setArrivalWind(w.windFrom, w.windKt);

    // the departure's runway entry (the intersection, as the spec's flight takes) and which way the push leaves the nose
    this.entry = this.depRw.entries[0];
    const stand = this.depStand();
    this.pushFace = this.dep.nodes[this.entry.hold].x > stand.x ? 'east' : 'west';
    this.radarSector = nav.plan.from;
    this.setStation('ground', this.dep);
    this.atis.text = this.playAtis(hour);
    this.clearanceDelivery();
  }

  /** What the player can ask for next (the HUD's hint), or null. */
  get nextRequest(): AtcRequest | null {
    const p = phaseIndex(this.nav.phase);
    if (this.stage === 'done') return null;
    if (p >= phaseIndex('rollout')) return this.stage === 'vacating' || this.stage === 'arr-ground' ? 'skip-taxi-in' : null;
    if (!this.clearance.pushback && !this.asked.has('pushback')) return 'pushback';
    if (this.clearance.pushback && !this.clearance.taxi && !this.asked.has('taxi')) return 'taxi';
    if (this.clearance.taxi && !this.clearance.takeoff && this.stage !== 'holding' && !this.asked.has('takeoff') && p < phaseIndex('climb')) return 'takeoff';
    return null;
  }

  request(kind: AtcRequest) {
    // the crew talking: the rest of the ATIS can wait
    this.convo = this.convo.filter((s) => !s.atis);
    if (kind === 'skip-taxi-in') {
      this.skipTaxiIn();
      return;
    }
    if (this.asked.has(kind)) return;
    this.asked.add(kind);
    this.pending.push(kind);
  }

  update(dt: number, s: AircraftState, _fcu: FcuState) {
    if (dt <= 0) return;
    this.t += dt;
    this.runConvo(dt);
    this.servePending(s);
    this.poll -= dt;
    const pollNow = this.poll <= 0;
    if (pollNow) this.poll = 1;

    const phase = this.nav.phase;
    const p = phaseIndex(phase);
    const onGround = s.onGround;

    // ---------------------------------------------------------------- departure, on the ground
    if (this.stage === 'taxiing' && this.clearance.taxi) {
      const hold = this.dep.nodes[this.clearance.taxi.holdShort];
      if (Math.hypot(s.pos.x - hold.x, s.pos.z - hold.z) < 260) this.handToTower();
    }
    if (this.stage === 'holding' && pollNow && this.idle()) this.departureSlot();
    this.watchIncursion(s);
    if (phase === 'takeoff' && !this.clearance.takeoff && !this.noTakeoffClearance && onGround && s.ias > 40) {
      this.noTakeoffClearance = true;
      this.violation('Took off without a takeoff clearance', 25);
      this.say(this.atc(`${this.cs}, you are not cleared for takeoff!`, `${this.csSay}, you are not cleared for takeoff!`), 0.3);
    }

    // ---------------------------------------------------------------- departure, airborne
    if ((this.stage === 'rolling' || this.stage === 'tower' || this.stage === 'holding') && !onGround && p >= phaseIndex('takeoff')) this.stage = 'departure';
    if (this.stage === 'departure' && s.altFt - this.dep.elevationFt > 1000 && this.idle()) this.handToRadar(s);
    if (this.stage === 'radar') this.enRoute(s);

    // ---------------------------------------------------------------- arrival
    if (this.stage === 'arr-tower' && pollNow && this.idle()) this.landingSlot(s);
    if (this.nav.goArounds > this.navGoArounds) {
      this.navGoArounds = this.nav.goArounds;
      this.pilotGoAround();
    }
    if (this.stage === 'missed' && s.altFt - this.arr.elevationFt > 1500 && this.idle()) this.backToRadar();
    if (onGround && !this.wasOnGround && p >= phaseIndex('approach')) this.touchdown(s);
    this.wasOnGround = onGround;
    if (this.stage === 'vacating' && phase === 'rollout' && s.gs < 110 && !this.clearance.vacate && this.idle()) this.vacate(s);
    if ((this.stage === 'vacating' || this.stage === 'arr-tower') && phase === 'taxi-in' && this.idle()) this.taxiIn(s);
    if (phase === 'parked' && this.stage === 'arr-ground') this.stage = 'done';

    this.altitudeWatch(s);
    this.trafficChatter(dt, s);
  }

  // ---------------------------------------------------------------------------------------------- the conversation engine

  private runConvo(dt: number) {
    if (this.inFlight) {
      if (this.speech.pending(this.inFlight.u)) return;
      const done = this.inFlight;
      this.inFlight = null;
      this.since = 0;
      done.then?.();
    }
    if (!this.convo.length) return;
    this.since += dt;
    const next = this.convo[0];
    // ATC and the crew wait for each other, for a warning or a callout, not for the cabin
    if (this.since < next.delay || this.speech.busy(1)) return;
    this.convo.shift();
    this.inFlight = next;
    this.speech.say(next.u);
  }

  /** Nothing being said or waiting on the radio: ATC can start a new exchange. */
  private idle() {
    return !this.inFlight && this.convo.length === 0 && !this.speech.busy(1);
  }

  private say(u: Utterance, delay: number, then?: () => void) {
    this.convo.push({ u, delay, then });
  }

  /** Lines said in turn, after anything already waiting (an instruction and its readback). */
  private push(...steps: Step[]) {
    this.convo.push(...steps);
  }

  /** Lines that go straight after the one being said (a reply): ahead of anything else waiting. */
  private reply(...steps: Step[]) {
    this.convo.unshift(...steps);
  }

  private atc(text: string, say: string): Utterance {
    return { speaker: 'atc', from: this.station.name, text, say, priority: 1 };
  }

  /** The first officer on the radio (shown under the callsign, so the radio clicks go with it). */
  private crew(text: string, say: string): Utterance {
    return { speaker: 'fo', from: this.cs, text, say, priority: 1 };
  }

  /** ATC's line and the readback that follows it. */
  private clear(atcText: string, atcSay: string, rbText: string, rbSay: string, then?: () => void, delay = 1.4): Step[] {
    return [
      { u: this.atc(atcText, atcSay), delay, then },
      { u: this.crew(`${rbText}, ${this.cs}.`, `${rbSay}, ${this.csSay}.`), delay: 0.5 },
    ];
  }

  private setStation(kind: 'ground' | 'tower' | 'radar' | 'atis', ap: Airport) {
    const names = { ground: 'Ground', tower: 'Tower', radar: 'Radar', atis: 'ATIS' };
    this.station.name = kind === 'radar' ? 'Sea Radar' : `${ap.geo.atc} ${names[kind]}`;
    this.station.freq = ap.freq[kind];
  }

  private give(kind: string) {
    this.onClearance?.(kind);
  }

  private violation(label: string, points: number, fatal?: 'runway-incursion') {
    this.onViolation?.(label, points, fatal);
  }

  // ---------------------------------------------------------------------------------------------- phraseology pieces

  /** The wind as the tower gives it now (it wanders a little from report to report). */
  private wind() {
    const w = this.w;
    const dir = (w.windFrom + (this.rnd() - 0.5) * 20 + 360) % 360;
    const kt = Math.max(0, Math.round(w.windKt + (this.rnd() - 0.5) * 4));
    const gust = w.gustKt > w.windKt ? Math.round(w.gustKt + (this.rnd() - 0.5) * 3) : 0;
    return { text: windText(dir, kt, gust), say: windWords(dir, kt, gust) };
  }

  private qnh() {
    const q = Math.floor(this.w.qnh);
    return { text: `QNH ${q}`, say: `QNH ${qnhWords(q)}` };
  }

  private depStand() {
    return this.dep.stands.find((x) => x.id === this.dep.playerStand)!;
  }

  private arrStand() {
    return this.arr.stands.find((x) => x.id === this.arr.playerStand)!;
  }

  private viaText(via: string[]) {
    return { text: via.join(', '), say: via.map(taxiwayWords).join(', ') };
  }

  // ---------------------------------------------------------------------------------------------- on the stand

  private playAtis(hour: number) {
    const w = this.w;
    const ap = this.dep;
    const L = this.atis.letter;
    const name = ap.geo.name;
    const hh = Math.floor(((hour % 24) + 24) % 24);
    const mm = Math.floor((hour - Math.floor(hour)) * 2) * 30;
    const time = `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
    const rw = this.depRw.ident;
    const cavok = w.visibilityM >= 10000 && w.clouds.every((c) => c.baseFt >= 5000);
    const vis = w.visibilityM >= 10000 ? { text: 'visibility 10 km or more', say: 'visibility one zero kilometres or more' } : { text: `visibility ${(w.visibilityM / 1000).toFixed(0)} km`, say: `visibility ${digits(Math.round(w.visibilityM / 1000))} kilometres` };
    const coverWord = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' } as const;
    const clouds = w.clouds.filter((c) => c.baseFt < 5000);
    const cloud = clouds.length
      ? { text: clouds.map((c) => `${coverWord[c.cover]} ${ft(c.baseFt)}`).join(', '), say: clouds.map((c) => `${coverWord[c.cover]} ${altitudeWords(c.baseFt)} feet`).join(', ') }
      : { text: 'no significant cloud', say: 'no significant cloud' };
    const wind = { text: windText(w.windFrom, w.windKt, w.gustKt), say: windWords(w.windFrom, w.windKt, w.gustKt) };
    const temp = `temperature ${w.tempC}, dew point ${w.dewC}`;
    const tempSay = `temperature ${digits(w.tempC)}, dew point ${digits(w.dewC)}`;
    const q = this.qnh();
    const l1 = `${name} information ${PHONETIC[L]}, time ${time}. Runway ${rw} in use. ${cap(wind.text)}.`;
    const s1 = `${name} information ${PHONETIC[L]}, time ${digits(time)}. Runway ${runwayWords(rw)} in use. ${wind.say}.`;
    const l2 = cavok ? `CAVOK, ${temp}. ${q.text}. Advise on initial contact you have information ${PHONETIC[L]}.` : `${cap(vis.text)}, ${cloud.text}, ${temp}. ${q.text}. Advise on initial contact you have information ${PHONETIC[L]}.`;
    const s2 = cavok ? `cav oh kay, ${tempSay}. ${q.say}. Advise on initial contact you have information ${PHONETIC[L]}.` : `${vis.say}, ${cloud.say}, ${tempSay}. ${q.say}. Advise on initial contact you have information ${PHONETIC[L]}.`;
    const from = `${ap.geo.atc} ATIS`;
    for (const [text, say] of [
      [l1, s1],
      [l2, s2],
    ])
      this.convo.push({ u: { speaker: 'atc', from, text, say, priority: 0 }, delay: 1.5, atis: true });
    return `${l1} ${l2}`;
  }

  /** The IFR clearance, asked for as soon as the ATIS has been heard. */
  private clearanceDelivery() {
    const plan = this.nav.plan;
    const stand = this.depStand();
    const dest = AIRFIELDS[plan.to].geo.name;
    const route = plan.fixes.filter((f) => f.name !== this.arrRw.if).map((f) => f.name);
    const rw = this.depRw.ident;
    const alt = plan.cruiseFt;
    const L = PHONETIC[this.atis.letter];
    const g = this.station.name;
    this.say(this.crew(`${g}, ${this.cs}, stand ${stand.gate}, information ${L}, request clearance to ${dest}.`, `${g}, ${this.csSay}, stand ${digits(stand.gate)}, information ${L}, request clearance to ${dest}.`), 1.2);
    const routeText = route.join(', ');
    const sq = this.squawk;
    this.say(
      this.atc(`${this.cs}, cleared to ${dest} via ${routeText}, runway ${rw} departure, climb ${ft(alt)}, squawk ${sq}.`, `${this.csSay}, cleared to ${dest} via ${route.join(', ')}, runway ${runwayWords(rw)} departure, climb ${altitudeWords(alt)} feet, squawk ${digits(sq)}.`),
      1.8,
    );
    this.say(this.crew(`Cleared to ${dest} via ${routeText}, runway ${rw}, climb ${ft(alt)}, squawk ${sq}, ${this.cs}.`, `Cleared to ${dest} via ${route.join(', ')}, runway ${runwayWords(rw)}, climb ${altitudeWords(alt)} feet, squawk ${digits(sq)}, ${this.csSay}.`), 0.5);
    this.say(this.atc(`${this.cs}, readback correct, report ready for pushback.`, `${this.csSay}, readback correct, report ready for pushback.`), 1.2, () => {
      this.clearance.altitudeFt = alt;
      this.stage = 'push';
      this.give('ifr');
    });
  }

  /** Act on the player's requests once ATC is free for them. */
  private servePending(s: AircraftState) {
    if (!this.pending.length || !this.idle()) return;
    const kind = this.pending[0];
    if (kind === 'pushback') {
      if (this.stage === 'clearance') return;
      this.pending.shift();
      this.pushback();
    } else if (kind === 'taxi') {
      if (!this.clearance.pushback) return;
      this.pending.shift();
      this.taxi(s);
    } else if (kind === 'takeoff') {
      if (!this.clearance.taxi) return;
      // still on Ground: change over to Tower first
      if (this.stage === 'taxiing') {
        this.handToTower();
        return;
      }
      if (this.stage !== 'tower') {
        this.pending.shift();
        return;
      }
      this.pending.shift();
      this.readyForDeparture();
    }
  }

  private pushback() {
    const stand = this.depStand();
    const g = this.station.name;
    const face = this.pushFace;
    this.say(this.crew(`${g}, ${this.cs}, stand ${stand.gate}, request pushback and start-up.`, `${g}, ${this.csSay}, stand ${digits(stand.gate)}, request pushback and start up.`), 0.2);
    this.say(this.atc(`${this.cs}, pushback and start-up approved, face ${face}.`, `${this.csSay}, push back and start up approved, face ${face}.`), 1.6);
    this.say(this.crew(`Pushback and start-up approved, face ${face}, ${this.cs}.`, `Push back and start up approved, face ${face}, ${this.csSay}.`), 0.5, () => {
      this.clearance.pushback = true;
      this.stage = 'taxi';
      this.give('pushback');
    });
  }

  private taxi(s: AircraftState) {
    const ap = this.dep;
    const hold = this.entry.hold;
    // from the node ahead of the aircraft: where the pushback leaves it, or where it is now
    const pe = this.depStand().pushEnd[this.pushFace];
    const moved = Math.hypot(s.pos.x - pe.x, s.pos.z - pe.z) < 400 && phaseIndex(this.nav.phase) >= phaseIndex('taxi-out');
    const start = moved ? nodeAhead(ap, s.pos.x, s.pos.z, s.heading) : nodeAhead(ap, pe.x, pe.z, pe.heading);
    const route = taxiRoute(ap, start.id, hold) ?? { nodes: [start.id, hold], via: [this.entry.name], lengthM: 0 };
    const via = route.via.filter((v, i) => !(i === route.via.length - 1 && v === this.entry.name));
    const v = this.viaText(via);
    const rw = this.depRw.ident;
    const q = this.qnh();
    const g = this.station.name;
    this.say(this.crew(`${g}, ${this.cs}, request taxi.`, `${g}, ${this.csSay}, request taxi.`), 0.2);
    this.say(
      this.atc(`${this.cs}, taxi to holding point ${this.entry.name}, runway ${rw}, via ${v.text}. ${q.text}.`, `${this.csSay}, taxi to holding point ${taxiwayWords(this.entry.name)}, runway ${runwayWords(rw)}, via ${v.say}. ${q.say}.`),
      1.7,
    );
    this.say(
      this.crew(`Taxi to holding point ${this.entry.name}, runway ${rw}, via ${v.text}, ${q.text}, ${this.cs}.`, `Taxi to holding point ${taxiwayWords(this.entry.name)}, runway ${runwayWords(rw)}, via ${v.say}, ${q.say}, ${this.csSay}.`),
      0.5,
      () => {
        this.clearance.taxi = { route: route.nodes, via, holdShort: hold };
        this.stage = 'taxiing';
        this.give('taxi');
      },
    );
  }

  private handToTower() {
    if (this.stage !== 'taxiing') return;
    this.stage = 'tower';
    const f = this.dep.freq.tower;
    this.say(this.atc(`${this.cs}, contact Tower ${f}.`, `${this.csSay}, contact Tower ${freqWords(f)}.`), 0.8);
    this.say(this.crew(`Tower ${f}, ${this.cs}.`, `Tower ${freqWords(f)}, ${this.csSay}.`), 0.5, () => this.setStation('tower', this.dep));
  }

  private readyForDeparture() {
    const t = this.station.name;
    this.say(this.crew(`${t}, ${this.cs}, holding point ${this.entry.name}, ready for departure.`, `${t}, ${this.csSay}, holding point ${taxiwayWords(this.entry.name)}, ready for departure.`), 0.2, () => {
      this.stage = 'holding';
      this.departureSlot(true);
    });
  }

  /** At the holding point: take off if the runway is free, line up behind a departure, or hold for the traffic. */
  private departureSlot(first = false) {
    const st = this.opts.runwayBusy(this.dep.geo.id);
    const rw = this.depRw.ident;
    const lead = first ? 1.6 : 0.3;
    if (!st.busy) {
      this.stage = 'rolling';
      const wd = this.wind();
      const lined = this.clearance.lineUp;
      this.reply(
        ...this.clear(
          `${this.cs}${first ? `, ${this.station.name}` : ''}, ${wd.text}, runway ${rw}, cleared for takeoff.`,
          `${this.csSay}${first ? `, ${this.station.name}` : ''}, ${wd.say}, runway ${runwayWords(rw)}, cleared for takeoff.`,
          `Cleared for takeoff runway ${rw}`,
          `Cleared for take off runway ${runwayWords(rw)}`,
          () => {
            this.clearance.lineUp = true;
            this.clearance.takeoff = true;
            if (!lined) this.give('lineup');
            this.give('takeoff');
          },
          lead,
        ),
      );
      return;
    }
    const reason = st.reason ?? 'traffic on the runway';
    if (!this.clearance.lineUp && /depart/i.test(reason)) {
      this.reply(
        ...this.clear(`${this.cs}, line up and wait runway ${rw}, ${reason}.`, `${this.csSay}, line up and wait runway ${runwayWords(rw)}, ${reason}.`, `Line up and wait runway ${rw}`, `Line up and wait runway ${runwayWords(rw)}`, () => {
          this.clearance.lineUp = true;
          this.give('lineup');
        }, lead),
      );
      return;
    }
    if (first) {
      const wait = st.clearInS > 90 ? `, expect departure in ${Math.ceil(st.clearInS / 60)} minutes` : '';
      const waitSay = st.clearInS > 90 ? `, expect departure in ${digits(Math.ceil(st.clearInS / 60))} minutes` : '';
      this.reply(...this.clear(`${this.cs}, ${this.station.name}, hold position, ${reason}${wait}.`, `${this.csSay}, ${this.station.name}, hold position, ${reason}${waitSay}.`, 'Holding position', 'Holding position', undefined, lead));
    }
  }

  /** Crossing the holding point onto the runway without a clearance to line up. */
  private watchIncursion(s: AircraftState) {
    if (this.incursion || !s.onGround || this.clearance.lineUp) return;
    if (phaseIndex(this.nav.phase) >= phaseIndex('climb')) return;
    const r = this.dep.geo.runway;
    const onIt = Math.abs(s.pos.z - r.z) < HOLD_OFFSET - 8 && s.pos.x > r.x0 - 150 && s.pos.x < r.x1 + 150;
    if (!onIt) return;
    this.incursion = true;
    const st = this.opts.runwayBusy(this.dep.geo.id);
    this.violation('Runway incursion: crossed a red stop bar without a clearance', 25, st.busy ? 'runway-incursion' : undefined);
    this.convo = [];
    this.say(this.atc(`${this.cs}, stop immediately! You have entered the runway without a clearance.`, `${this.csSay}, stop immediately, I say again, stop immediately! You have entered the runway without a clearance.`), 0.2);
  }

  // ---------------------------------------------------------------------------------------------- en route

  private handToRadar(s: AircraftState) {
    this.stage = 'radar';
    const f = this.dep.freq.radar;
    const alt = this.nav.plan.cruiseFt;
    const passing = Math.round(s.altFt / 100) * 100;
    this.say(this.atc(`${this.cs}, contact Sea Radar ${f}, good day.`, `${this.csSay}, contact Sea Radar ${freqWords(f)}, good day.`), 0.8);
    this.say(this.crew(`Sea Radar ${f}, ${this.cs}, good day.`, `Sea Radar ${freqWords(f)}, ${this.csSay}, good day.`), 0.5, () => this.setStation('radar', this.dep));
    this.say(this.crew(`Sea Radar, ${this.cs}, passing ${ft(passing)}, climbing ${ft(alt)}.`, `Sea Radar, ${this.csSay}, passing ${altitudeWords(passing)} feet, climbing ${altitudeWords(alt)} feet.`), 1.5);
    const direct = 'CORAL';
    const directOk = this.nav.legs.some((l) => l.name === direct) && this.nav.activeIndex <= this.nav.legs.findIndex((l) => l.name === direct);
    const dText = directOk ? `, proceed direct ${direct}` : '';
    this.say(this.atc(`${this.cs}, Sea Radar, identified. Climb and maintain ${ft(alt)}${dText}.`, `${this.csSay}, Sea Radar, identified. Climb and maintain ${altitudeWords(alt)} feet${dText}.`), 1.6);
    this.say(this.crew(`Climb and maintain ${ft(alt)}${dText}, ${this.cs}.`, `Climb and maintain ${altitudeWords(alt)} feet${dText}, ${this.csSay}.`), 0.5, () => {
      this.setCleared(alt);
      this.clearance.heading = null;
      if (directOk) {
        this.clearance.directTo = direct;
        this.nav.directTo(direct);
        this.give('direct');
      }
    });
  }

  private enRoute(s: AircraftState) {
    if (!this.idle()) return;
    const nav = this.nav;
    // the hand-over between the two radar sectors, mid-sea
    const sector = regionAt(s.pos.x, s.pos.z);
    if (sector !== this.radarSector) {
      this.radarSector = sector;
      const f = AIRFIELDS[sector].freq.radar;
      const alt = Math.round(s.altFt / 100) * 100;
      const info = PHONETIC[String.fromCharCode(65 + ((this.atis.letter.charCodeAt(0) - 65 + 2) % 26))];
      const arrName = this.arr.geo.name;
      this.say(this.atc(`${this.cs}, contact Sea Radar ${f}.`, `${this.csSay}, contact Sea Radar ${freqWords(f)}.`), 0.8);
      this.say(this.crew(`Sea Radar ${f}, ${this.cs}.`, `Sea Radar ${freqWords(f)}, ${this.csSay}.`), 0.5, () => (this.station.freq = f));
      this.say(this.crew(`Sea Radar, ${this.cs}, ${ft(alt)}.`, `Sea Radar, ${this.csSay}, ${altitudeWords(alt)} feet.`), 1.5);
      this.say(
        this.atc(`${this.cs}, Sea Radar, identified. Expect ILS approach runway ${this.arrRw.ident}, ${arrName} information ${info} is current.`, `${this.csSay}, Sea Radar, identified. Expect I L S approach runway ${runwayWords(this.arrRw.ident)}, ${arrName} information ${info} is current.`),
        1.6,
      );
      this.say(this.crew(`Expect ILS runway ${this.arrRw.ident}, information ${info}, ${this.cs}.`, `Expect I L S runway ${runwayWords(this.arrRw.ident)}, information ${info}, ${this.csSay}.`), 0.5);
      return;
    }
    // descent: before the top of descent, down to the initial approach fix's altitude
    const iaf = nav.legs.find((l) => l.name === this.arrRw.iaf);
    const iafAlt = iaf?.altFt ?? 3000;
    const todM = (((Math.max(iafAlt, s.altFt) - iafAlt) / 1000) * 3 + 14) * NM;
    if (!this.descentGiven && sector === this.nav.plan.to && (nav.distanceToGoM(s) < todM || nav.phase === 'descent')) {
      this.descentGiven = true;
      const q = this.qnh();
      this.push(
        ...this.pair(`${this.cs}, descend ${ft(iafAlt)}, ${q.text}.`, `${this.csSay}, descend ${altitudeWords(iafAlt)} feet, ${q.say}.`, `Descend ${ft(iafAlt)}, ${q.text}`, `Descend ${altitudeWords(iafAlt)} feet, ${q.say}`, () => {
          this.setCleared(iafAlt);
          this.give('descent');
        }),
      );
      return;
    }
    // the approach clearance, nearing the initial approach fix (or past it)
    const iafIdx = nav.legs.findIndex((l) => l.name === this.arrRw.iaf);
    const nearIaf = iaf && (nav.activeIndex > iafIdx || (nav.activeIndex === iafIdx && Math.hypot(iaf.x - s.pos.x, iaf.z - s.pos.z) < 7 * NM));
    if (!this.clearance.approach && this.descentGiven && nearIaf) {
      const ifFix = nav.legs.find((l) => l.name === this.arrRw.if);
      const ifAlt = ifFix?.altFt ?? 1700;
      const rw = this.arrRw.ident;
      this.push(
        ...this.pair(
          `${this.cs}, descend ${ft(ifAlt)}, cleared ILS approach runway ${rw}.`,
          `${this.csSay}, descend ${altitudeWords(ifAlt)} feet, cleared I L S approach runway ${runwayWords(rw)}.`,
          `Descend ${ft(ifAlt)}, cleared ILS approach runway ${rw}`,
          `Descend ${altitudeWords(ifAlt)} feet, cleared I L S approach runway ${runwayWords(rw)}`,
          () => {
            this.clearance.approach = true;
            this.clearance.heading = null;
            this.setCleared(ifAlt);
            this.give('approach');
          },
        ),
      );
      return;
    }
    // established (or close in): over to the tower
    const ils = nav.ils(s);
    if (this.clearance.approach && (nav.phase === 'final' || (ils?.valid && ils.dme < 7))) {
      const f = this.arr.freq.tower;
      this.stage = 'arr-tower';
      this.say(this.atc(`${this.cs}, contact ${this.arr.geo.atc} Tower ${f}.`, `${this.csSay}, contact ${this.arr.geo.atc} Tower ${freqWords(f)}.`), 0.8);
      this.say(this.crew(`${this.arr.geo.atc} Tower ${f}, ${this.cs}.`, `${this.arr.geo.atc} Tower ${freqWords(f)}, ${this.csSay}.`), 0.5, () => this.setStation('tower', this.arr));
      const rw = this.arrRw.ident;
      this.say(this.crew(`${this.arr.geo.atc} Tower, ${this.cs}, established ILS runway ${rw}.`, `${this.arr.geo.atc} Tower, ${this.csSay}, established I L S runway ${runwayWords(rw)}.`), 1.5, () => this.landingSlot(s, true));
    }
  }

  /** An ATC instruction and its readback, both on the current station. */
  private pair(atcText: string, atcSay: string, rbText: string, rbSay: string, then?: () => void): Step[] {
    return this.clear(atcText, atcSay, rbText, rbSay, then, 0.8);
  }

  // ---------------------------------------------------------------------------------------------- arrival

  /** On final: cleared to land, or continue while the runway is busy, or a go-around if it won't be free in time. */
  private landingSlot(s: AircraftState, first = false) {
    if (this.stage !== 'arr-tower' || this.clearance.land) return;
    const st = this.opts.runwayBusy(this.arr.geo.id);
    const rw = this.arrRw.ident;
    const name = this.station.name;
    const intro = first ? `, ${name}` : '';
    if (!st.busy) {
      const wd = this.wind();
      this.reply(
        ...this.clear(`${this.cs}${intro}, ${wd.text}, runway ${rw}, cleared to land.`, `${this.csSay}${intro}, ${wd.say}, runway ${runwayWords(rw)}, cleared to land.`, `Cleared to land runway ${rw}`, `Cleared to land runway ${runwayWords(rw)}`, () => {
          this.clearance.land = true;
          this.give('land');
        }, first ? 1.6 : 0.4),
      );
      return;
    }
    const reason = st.reason ?? 'traffic on the runway';
    const fr = runwayFrame(this.arrRw, s.pos.x, s.pos.z);
    const toThreshold = -fr.along / Math.max(30, s.gs * KT);
    if (!first && toThreshold < 35 && st.clearInS > toThreshold - 10) {
      this.goAroundOrdered = true;
      this.stage = 'missed';
      const missedAlt = this.nav.legs.find((l) => l.name === this.arrRw.iaf)?.altFt ?? 3000;
      const hdg = this.arrRw.heading;
      this.convo = [];
      this.reply(
        ...this.clear(
          `${this.cs}, go around, I say again, go around, ${reason}. Climb ${ft(missedAlt)}, fly heading ${headingText(hdg)}.`,
          `${this.csSay}, go around, I say again, go around, ${reason}. Climb ${altitudeWords(missedAlt)} feet, fly heading ${headingWords(hdg)}.`,
          `Going around, climb ${ft(missedAlt)}, heading ${headingText(hdg)}`,
          `Going around, climb ${altitudeWords(missedAlt)} feet, heading ${headingWords(hdg)}`,
          () => {
            this.clearance.land = false;
            this.clearance.approach = false;
            this.clearance.heading = hdg;
            this.setCleared(missedAlt);
            this.give('go-around');
          },
          0.2,
        ),
      );
      return;
    }
    if (first) this.reply(...this.clear(`${this.cs}, ${name}, continue approach, ${reason}.`, `${this.csSay}, ${name}, continue approach, ${reason}.`, 'Continue approach', 'Continue approach', undefined, 1.6));
  }

  /** The crew went around on their own (TOGA on final, or a touch-and-go). */
  private pilotGoAround() {
    if (this.goAroundOrdered && this.stage === 'missed') {
      this.goAroundOrdered = false;
      return;
    }
    this.stage = 'missed';
    this.convo = [];
    const missedAlt = this.nav.legs.find((l) => l.name === this.arrRw.iaf)?.altFt ?? 3000;
    const hdg = this.arrRw.heading;
    this.say(this.crew(`${this.station.name}, ${this.cs}, going around.`, `${this.station.name}, ${this.csSay}, going around.`), 0.3);
    this.push(
      ...this.pair(`${this.cs}, roger, climb ${ft(missedAlt)}, fly heading ${headingText(hdg)}.`, `${this.csSay}, roger, climb ${altitudeWords(missedAlt)} feet, fly heading ${headingWords(hdg)}.`, `Climb ${ft(missedAlt)}, heading ${headingText(hdg)}`, `Climb ${altitudeWords(missedAlt)} feet, heading ${headingWords(hdg)}`, () => {
        this.clearance.land = false;
        this.clearance.approach = false;
        this.clearance.heading = hdg;
        this.setCleared(missedAlt);
      }),
    );
  }

  /** After a go-around: back to Sea Radar, round to the initial approach fix for another ILS. */
  private backToRadar() {
    this.stage = 'radar';
    this.goAroundOrdered = false;
    const f = this.arr.freq.radar;
    const iaf = this.arrRw.iaf;
    const rw = this.arrRw.ident;
    const alt = this.clearance.altitudeFt;
    this.say(this.atc(`${this.cs}, contact Sea Radar ${f}.`, `${this.csSay}, contact Sea Radar ${freqWords(f)}.`), 0.8);
    this.say(this.crew(`Sea Radar ${f}, ${this.cs}.`, `Sea Radar ${freqWords(f)}, ${this.csSay}.`), 0.5, () => this.setStation('radar', this.arr));
    this.say(this.crew(`Sea Radar, ${this.cs}, going around, climbing ${ft(alt)}.`, `Sea Radar, ${this.csSay}, going around, climbing ${altitudeWords(alt)} feet.`), 1.5);
    this.push(
      ...this.pair(`${this.cs}, Sea Radar, identified. Maintain ${ft(alt)}, proceed direct ${iaf} for another ILS approach runway ${rw}.`, `${this.csSay}, Sea Radar, identified. Maintain ${altitudeWords(alt)} feet, proceed direct ${iaf} for another I L S approach runway ${runwayWords(rw)}.`, `Maintain ${ft(alt)}, direct ${iaf}`, `Maintain ${altitudeWords(alt)} feet, direct ${iaf}`, () => {
        this.clearance.heading = null;
        this.clearance.directTo = iaf;
        if (!this.nav.goingAround) this.nav.goAround();
        else this.nav.directTo(iaf);
        this.give('direct');
      }),
    );
  }

  private touchdown(s: AircraftState) {
    if (this.landedFlagged || !onRunway(this.arr, s.pos.x, s.pos.z, 30)) return;
    this.landedFlagged = true;
    if (!this.clearance.land) {
      const busy = this.opts.runwayBusy(this.arr.geo.id).busy;
      this.violation('Landed without a landing clearance', 20, busy && this.goAroundOrdered ? 'runway-incursion' : undefined);
    }
    this.convo = [];
    this.stage = 'vacating';
    this.station.name = `${this.arr.geo.atc} Tower`;
  }

  /** On the rollout: the exit ahead the aircraft can make, and over to Ground. */
  private vacate(s: AircraftState) {
    const along = runwayFrame(this.arrRw, s.pos.x, s.pos.z).along;
    const v = s.gs * KT;
    // the first exit the aircraft can make braking like autobrake MED (~2.5 m/s²): a rapid exit is
    // taken at up to 50 kt, a right-angled one at a taxi speed of 15 kt
    const need = (vExit: number) => Math.max(0, v * v - vExit * vExit) / (2 * 2.5);
    const exits = [...this.arrRw.exits].sort((a, b) => a.distM - b.distM);
    const exit = exits.find((e) => e.distM > along + need((e.rapid ? 50 : 15) * KT)) ?? exits[exits.length - 1];
    const f = this.arr.freq.ground;
    this.push(
      ...this.pair(`${this.cs}, vacate via ${exit.name}, contact Ground ${f}.`, `${this.csSay}, vacate via ${taxiwayWords(exit.name)}, contact Ground ${freqWords(f)}.`, `Vacate via ${exit.name}, Ground ${f}`, `Vacate via ${taxiwayWords(exit.name)}, Ground ${freqWords(f)}`, () => {
        this.clearance.vacate = exit.name;
        this.give('vacate');
      }),
    );
  }

  /** Off the runway: the taxi to the stand. */
  private taxiIn(s: AircraftState) {
    this.stage = 'arr-ground';
    this.setStation('ground', this.arr);
    const route = this.taxiInRoute(s);
    const v = this.viaText(route.via);
    const stand = this.arrStand();
    const g = this.station.name;
    const rw = this.arrRw.ident;
    const exit = this.clearance.vacate;
    const vac = exit ? ` via ${exit}` : '';
    const vacSay = exit ? ` via ${taxiwayWords(exit)}` : '';
    this.say(this.crew(`${g}, ${this.cs}, runway ${rw} vacated${vac}.`, `${g}, ${this.csSay}, runway ${runwayWords(rw)} vacated${vacSay}.`), 0.6);
    this.push(
      ...this.pair(`${this.cs}, ${g}, welcome to ${this.arr.geo.name}. Taxi to stand ${stand.gate} via ${v.text}.`, `${this.csSay}, ${g}, welcome to ${this.arr.geo.name}. Taxi to stand ${digits(stand.gate)} via ${v.say}.`, `Taxi to stand ${stand.gate} via ${v.text}`, `Taxi to stand ${digits(stand.gate)} via ${v.say}`, () => {
        this.clearance.taxiIn = { route: route.nodes, via: route.via };
        this.give('taxi-in');
      }),
    );
  }

  private taxiInRoute(s: AircraftState) {
    const ap = this.arr;
    const start = nodeAhead(ap, s.pos.x, s.pos.z, s.heading, ['taxiway', 'lane']);
    const r = taxiRoute(ap, start.id, ap.playerStand);
    return r ? { nodes: r.nodes, via: r.via } : { nodes: [start.id, ap.playerStand], via: [] as string[] };
  }

  private skipTaxiIn() {
    if (this.stage === 'done') return;
    if (!this.clearance.taxiIn) {
      const ap = this.arr;
      const st = this.arrStand();
      const r = taxiRoute(ap, nearestNode(ap, st.x, st.z, ['lane']).id, ap.playerStand);
      this.clearance.taxiIn = { route: r?.nodes ?? [ap.playerStand], via: r?.via ?? [] };
    }
    this.convo = [];
    this.pending = [];
    this.stage = 'done';
    this.give('skip-taxi-in');
  }

  // ---------------------------------------------------------------------------------------------- watching the flight

  private setCleared(alt: number) {
    this.clearance.altitudeFt = alt;
    if (alt !== this.lastCleared) {
      this.lastCleared = alt;
      this.clearedAt = this.t;
      this.reachedCleared = false;
      this.bustFlagged = false;
    }
  }

  /** An altitude bust: more than 300 ft through the cleared altitude (while flying under radar control). */
  private altitudeWatch(s: AircraftState) {
    const alt = this.clearance.altitudeFt;
    if (!alt || s.onGround || this.stage !== 'radar' || this.clearance.approach) return;
    const dev = s.altFt - alt;
    if (Math.abs(dev) < 150) this.reachedCleared = true;
    if (this.bustFlagged || Math.abs(dev) < 300) return;
    // levelled at it and wandered off, or flying away from it (climbing above it, descending below
    // it) once the crew have had a moment to react to the clearance
    const away = (dev > 0 && s.vs > 200) || (dev < 0 && s.vs < -200);
    const bust = this.reachedCleared || (away && this.t - this.clearedAt > 10);
    if (!bust) return;
    this.bustFlagged = true;
    this.violation(`Altitude deviation (${dev > 0 ? '+' : '−'}${Math.round(Math.abs(dev) / 10) * 10} ft from ${ft(alt)})`, 5);
    if (this.idle()) this.say(this.atc(`${this.cs}, check altitude, cleared ${ft(alt)}.`, `${this.csSay}, check altitude, cleared ${altitudeWords(alt)} feet.`), 0.5);
  }

  /** Other aircraft on the frequency, now and then, when it's quiet (never on short final or the takeoff roll: the tower keeps those quiet). */
  private trafficChatter(dt: number, s: AircraftState) {
    if (this.chatter === 'off' || this.stage === 'done' || this.stage === 'clearance' || this.stage === 'rolling') return;
    if (this.stage === 'arr-tower' && s.radioAltFt < 1200) return;
    const kind = /Radar/.test(this.station.name) ? 'radar' : /Tower/.test(this.station.name) ? 'tower' : 'ground';
    if (this.chatter === 'radar' && kind !== 'radar') return;
    this.nextChatter -= dt;
    if (this.nextChatter > 0 || !this.idle() || this.speech.quietFor < 6) return;
    this.nextChatter = 25 + this.rnd() * 35;
    const other = OTHERS[Math.floor(this.rnd() * OTHERS.length)];
    const os = callsignWords(other);
    const ap = this.stage === 'radar' ? AIRFIELDS[this.radarSector] : phaseIndex(this.nav.phase) >= phaseIndex('descent') ? this.arr : this.dep;
    const rw = this.nav.phase === 'taxi-out' || phaseIndex(this.nav.phase) < phaseIndex('climb') ? this.depRw.ident : this.arrRw.ident;
    const lines: [string, string, string, string][] = [];
    if (kind === 'ground') {
      const st = 1 + Math.floor(this.rnd() * ap.stands.length);
      // another departure goes to the full-length holding point of the runway in use
      const entries = ap.runways[rw].entries;
      const hp = entries[entries.length - 1].name;
      lines.push(
        [`${other}, taxi to holding point ${hp}, runway ${rw}, via A.`, `${os}, taxi to holding point ${taxiwayWords(hp)}, runway ${runwayWords(rw)}, via Alfa.`, `Holding point ${hp} via A, ${other}.`, `Holding point ${taxiwayWords(hp)} via Alfa, ${os}.`],
        [`${other}, taxi to stand ${st} via K, T.`, `${os}, taxi to stand ${digits(st)} via Kilo, Tango.`, `Stand ${st} via K, T, ${other}.`, `Stand ${digits(st)} via Kilo, Tango, ${os}.`],
        [`${other}, pushback approved, face west.`, `${os}, push back approved, face west.`, `Pushback approved, face west, ${other}.`, `Push back approved, face west, ${os}.`],
      );
    } else if (kind === 'tower') {
      lines.push([`${other}, contact Sea Radar ${ap.freq.radar}, good day.`, `${os}, contact Sea Radar ${freqWords(ap.freq.radar)}, good day.`, `Sea Radar ${ap.freq.radar}, ${other}, good day.`, `Sea Radar ${freqWords(ap.freq.radar)}, ${os}, good day.`]);
      if (this.stage === 'arr-tower') {
        // the player is the one landing: the traffic behind is told to follow
        lines.push([`${other}, continue approach, number two, traffic is an A320 on final.`, `${os}, continue approach, number two, traffic is an A three twenty on final.`, `Continue approach, number two, traffic in sight, ${other}.`, `Continue approach, number two, traffic in sight, ${os}.`]);
      } else if (!this.clearance.lineUp && /final|landing/i.test(this.opts.runwayBusy(ap.geo.id).reason ?? '')) {
        // the player holds on the ground while the traffic on final is cleared to land first
        const wd = this.wind();
        lines.push([`${other}, ${wd.text}, runway ${rw}, cleared to land.`, `${os}, ${wd.say}, runway ${runwayWords(rw)}, cleared to land.`, `Cleared to land runway ${rw}, ${other}.`, `Cleared to land runway ${runwayWords(rw)}, ${os}.`]);
      }
    } else {
      const hdg = Math.round((40 + this.rnd() * 280) / 5) * 5;
      const alt = 3000 + Math.floor(this.rnd() * 4) * 1000;
      const fl = 70 + Math.floor(this.rnd() * 5) * 10;
      lines.push(
        [`${other}, turn left heading ${headingText(hdg)}, descend ${ft(alt)}.`, `${os}, turn left heading ${headingWords(hdg)}, descend ${altitudeWords(alt)} feet.`, `Left heading ${headingText(hdg)}, descend ${ft(alt)}, ${other}.`, `Left heading ${headingWords(hdg)}, descend ${altitudeWords(alt)} feet, ${os}.`],
        [`${other}, climb flight level ${fl}.`, `${os}, climb flight level ${digits(String(fl).padStart(3, '0'))}.`, `Climb flight level ${fl}, ${other}.`, `Climb flight level ${digits(String(fl).padStart(3, '0'))}, ${os}.`],
        [`${other}, traffic information: an A320 ${ft(alt)} at your two o'clock, eight miles, opposite direction.`, `${os}, traffic information, an A three twenty, ${altitudeWords(alt)} feet, at your two o'clock, eight miles, opposite direction.`, `Looking out, ${other}.`, `Looking out, ${os}.`],
      );
    }
    const [at, as, pt, ps] = lines[Math.floor(this.rnd() * lines.length)];
    this.say({ speaker: 'atc', from: this.station.name, text: at, say: as, priority: 1 }, 0);
    // the other pilot answers on the same frequency (heard over the radio, like the controller)
    this.say({ speaker: 'atc', from: other, text: pt, say: ps, priority: 1 }, 0.5);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The taxi node ahead of a pose: the nearest within ±70° of the heading (the next one to taxi to). */
export function nodeAhead(ap: Airport, x: number, z: number, heading: number, kinds: NodeKind[] = ['lane', 'taxiway']) {
  const f = headingVec(heading);
  let best: ReturnType<typeof nearestNode> | null = null;
  let bd = Infinity;
  for (const n of Object.values(ap.nodes)) {
    if (!kinds.includes(n.kind)) continue;
    const dx = n.x - x;
    const dz = n.z - z;
    const d = Math.hypot(dx, dz);
    if (d < 5 || d > 600) continue;
    if ((dx * f.x + dz * f.z) / d < Math.cos((70 * Math.PI) / 180)) continue;
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best ?? nearestNode(ap, x, z, kinds);
}
