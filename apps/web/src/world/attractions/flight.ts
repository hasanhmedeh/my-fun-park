// Funfair Air: the visitor flies the A320neo gate to gate, FA101 from Funfair International to
// Palm Cay and FA102 back. This is the screen around the flight (world/flight/sim.ts runs the flight
// itself): the booking card at the gate desk, the passengers boarding and leaving through the real
// jet bridge or airstairs, the cockpit and its instruments, the cameras, the HUD and the touch
// controls, the tug that pushes the aircraft back, the greens and the stop bars on the airfield,
// the sky, the clock and the weather of the chosen time of day, the engines' sound, the failures'
// aftermath and the flight report.
//
// The hero aircraft lives in the world for good: between flights it waits at the stand it last
// parked on (Funfair International's S3 to begin with), its door open to the bridge or the stairs.

import * as THREE from 'three';
import { A320_POINTS } from '../../aviation/a320';
import { AIRFIELDS } from '../../aviation/airports';
import { Speech } from '../../aviation/speech';
import { phaseIndex } from '../../aviation/nav';
import { SCHEDULE_PAD_S } from '../../aviation/scoring';
import { TIME_OF_DAY_HOUR, type AircraftState, type GroundQuery, type PlaneModel, type PlaneVisual, type ScoreItem, type TimeOfDay } from '../../aviation/types';
import type { Traffic } from '../../aviation/traffic';
import { createA320, LIVERIES, restVisual } from '../airport/a320-model';
import type { Airfield } from '../airport/airfield';
import type { Airside } from '../airport/airside';
import type { HomeTerminal } from '../airport/terminal';
import type { Attraction, Ctx } from '../context';
import type { Boarding, Travellers } from '../crowd/travellers';
import type { Environment } from '../environment';
import { AIRPORT_SPOTS, FT, SEA_Y, regionAt, type Region } from '../geo';
import type { Input } from '../input';
import type { IslandTerminal } from '../island/island-terminal';
import type { Post } from '../post';
import { SWELL } from '../sea-waves';
import { bookFlight, blockText, clockText, decodeWeather, FLIGHT_COST, metars, runwayText, type FlightInfo } from '../flight/booking';
import { CAM_LABEL, FlightCameras } from '../flight/cameras';
import { FlightControls } from '../flight/controls';
import { FlightHud } from '../flight/flight-hud';
import { IlsGuide } from '../flight/ils-guide';
import { Cockpit } from '../flight/instruments/cockpit';
import type { CockpitData } from '../flight/instruments/types';
import { FlightSim, type Hint, type Stage } from '../flight/sim';
import { FlightTouch } from '../flight/touch';

export interface FlightDeps {
  env: Environment;
  post: Post;
  airfields: Record<Region, Airfield>;
  homeTerminal: HomeTerminal;
  islandTerminal: IslandTerminal;
  airside: Record<Region, Airside>;
  traffic: Traffic;
  travellers: Travellers;
  /** The world's ground for the flight model: y and surface (water at sea, runway/taxiway/apron from the airfields, grass/sand elsewhere). */
  ground: GroundQuery;
}

export interface FlightMarker {
  x: number;
  z: number;
  kind: 'traffic' | 'fix';
  label: string;
}

const D2R = Math.PI / 180;
const TODS: { id: TimeOfDay; label: string }[] = [
  { id: 'dawn', label: '🌅 Dawn' },
  { id: 'day', label: '☀️ Day' },
  { id: 'dusk', label: '🌇 Dusk' },
  { id: 'night', label: '🌙 Night' },
];
/** Passengers the visitor watches walk on and off (the rest are already aboard, or leave behind them). */
const WALKERS = 16;
/**
 * The boarding and deplaning shots end by themselves after this long (E skips sooner): a safety net
 * for a stuck run, longer than the runs themselves (about 42 s to board 16 at home, 26 to 32 s to
 * deplane), so the whole queue is seen walking on and off.
 */
const BOARDING_MAX_S = 55;
const DEPLANING_MAX_S = 45;
/** The door closes this fast (s), then the bridge pulls back. */
const DOOR_S = 2.5;
/** Engines off on the stand, then this long before the bridge or the stairs come to the door. */
const DOCK_DELAY_S = 1.5;
/** The hint once the report is up (the sim's own would go on about the stand or the aftermath). */
const REPORT_HINT: Hint = { text: 'Flight report · Continue', keys: 'E' };
const STORE = {
  ils: 'funfair.flight.ils',
  voices: 'funfair.flight.voices',
  keys: 'funfair.flight.keys',
  flown: 'funfair.flight.flown',
  skip: 'funfair.flight.skip',
  autoTaxi: 'funfair.flight.autotaxi',
  autoland: 'funfair.flight.autoland',
};
/** The booking card's first officer switches (all off until the visitor turns one on, then remembered). */
const ASSISTS = [
  { id: 'skip', store: STORE.skip, label: '⏩ Skip to the runway', sub: 'Start lined up, engines running, cleared for takeoff' },
  { id: 'autoTaxi', store: STORE.autoTaxi, label: '🚕 Auto taxi', sub: 'The first officer taxis out, and in to the stand after landing' },
  { id: 'autoland', store: STORE.autoland, label: '🛬 Autoland', sub: 'The autopilot lands it (4 stars at most)' },
] as const;
/** The fade over the skip to the runway: the jump at JUMP_S, the fade lifts at FADE_S. */
const JUMP_S = 0.5;
const FADE_S = 0.9;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage blocked: it just won't be remembered */
  }
}

/** The gate window's view of the stand, for boarding and deplaning: the bridge at home, the stairs on the island. */
const GATE_SHOT: Record<Region, { pos: THREE.Vector3; look: THREE.Vector3 }> = {
  home: { pos: new THREE.Vector3(-60, 8, 526), look: new THREE.Vector3(-30, 3.6, 562) },
  island: { pos: new THREE.Vector3(-4, 4.5, 40572), look: new THREE.Vector3(-28, 2.4, 40590) },
};

export class Flight implements Attraction {
  active = false;
  input: Input | null = null;
  onFinish: (() => void) | null = null;
  /** The round has run its course (parked and deplaned, or the failure's aftermath and its report read): Game leaves with `completed`. */
  onComplete: (() => void) | null = null;
  /** Set by the booking card before Game boards: which leg and the chosen time of day. */
  booking: { from: Region; timeOfDay: TimeOfDay } | null = null;
  /** After exit(): where the visitor stands now (yaw in the park's convention, as AIRPORT_SPOTS). */
  arrival: { x: number; z: number; heading: number } | null = null;
  /** Whether the last round flew gate to gate (Game's leave(completed)). */
  completed = false;
  /** Dev and preview only: a scripted crew's hands in place of the visitor's (flight/crew.ts's frame). */
  pilotOverride: ((dt: number) => void) | null = null;

  private readonly ctx: Ctx;
  private readonly deps: FlightDeps;
  private readonly hero: PlaneModel;
  private readonly visual: PlaneVisual = restVisual();
  private readonly cockpit: Cockpit;
  private readonly hud: FlightHud;
  private readonly touch: FlightTouch | null;
  private controls: FlightControls | null = null;
  private readonly cams = new FlightCameras();
  private readonly ils: IlsGuide;
  private readonly slides: THREE.Group;
  private sim: FlightSim | null = null;
  /**
   * One radio for every flight: a Speech per flight would add a speechSynthesis voiceschanged
   * listener each round that is never taken off. FlightSim clears it at the start.
   */
  private readonly speech: Speech;
  /** The last round ended without arriving (Esc before landing): its stats score nothing. */
  private abandoned = false;
  /** Whether the flight that last ended (exit()) had crashed or ditched: Game reads it however the round was left. */
  lastFailed = false;
  /** Where the hero waits between flights. */
  private parkedAt: Region = 'home';
  private tod: TimeOfDay = 'day';
  /** The time of day the booking card offers (its default, or the visitor's pick): the boards show that departure. */
  get timeOfDay(): TimeOfDay {
    return this.tod;
  }
  /** Called when the visitor picks another time of day on the card (Game repaints the terminals' boards). */
  onTimeOfDay: ((tod: TimeOfDay) => void) | null = null;
  private offerCost = FLIGHT_COST;
  private offerGate: string | null = null;
  private offerFrom: Region = 'home';

  // the round's screen state
  private run: Boarding | null = null;
  private runT = 0;
  private doorK = 1;
  private cargoK = 1;
  private doorTarget = 1;
  private docked = false;
  private dockT = 0;
  private tugT = 0;
  private skipT = -1;
  /** The skip to the runway's fade (s), or -1. */
  private runwayT = -1;
  private reportShown = false;
  private completeFired = false;
  private hintClock = 0;
  private ecamClock = 1;
  private lastFlaps = 0;
  private ilsOn = true;
  private aftermathT = 0;
  private readonly saved = { hours: 0, timeMode: 'paused' as Environment['timeMode'], swellFrom: 0, swellKt: 0 };

  // preallocated
  private data: CockpitData | null = null;
  /** Where the hero is between flights (the getters read it then). */
  private readonly idlePos = new THREE.Vector3();
  private idleHeading = 0;
  private readonly focusV = new THREE.Vector3();
  private readonly posV = new THREE.Vector3();
  private readonly pose = { x: 0, z: 0, heading: 0 };
  private readonly markerPool: FlightMarker[] = [];
  private readonly markerList: FlightMarker[] = [];
  private readonly sfxParams: Parameters<Ctx['sfx']['aircraft']>[0] = { n1: [0, 0], ias: 0, onGround: true, groundSpeed: 0, reverser: 0, spoilers: 0, gear: 1, inside: true, flapsMoving: false, gearMoving: false };
  private readonly touchLit: Parameters<FlightTouch['update']>[1] = { gear: true, ap: false, athr: false, speedbrake: false, warp: 1, flaps: 0 };
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private utcSec = -1;

  constructor(ctx: Ctx, deps: FlightDeps) {
    this.ctx = ctx;
    this.deps = deps;
    this.speech = new Speech(ctx.sfx);
    this.hero = createA320({ livery: LIVERIES.funfair, detail: 'hero', shadows: ctx.quality.shadows }, { spotLight: !ctx.mobile, lowMemory: ctx.mobile || ctx.quality.tier === 'lowest' || ctx.quality.tier === 'low' });
    this.hero.group.name = 'flight-hero';
    ctx.scene.add(this.hero.group);
    this.slides = this.buildSlides();
    this.hero.group.add(this.slides);
    this.ils = new IlsGuide(ctx.scene);

    // the overlays: the cockpit's instruments under everything, the HUD's own lines before the cards
    const hud = ctx.ui.hud;
    const mount = document.createElement('div');
    mount.className = 'fl-cockpit-mount';
    // first in the HUD, so the Game's own buttons (exit, info) and the touch controls draw over the windscreen
    hud.insertBefore(mount, hud.firstChild);
    this.cockpit = new Cockpit(ctx, mount);
    this.cockpit.setView('hidden');
    this.hud = new FlightHud(hud, ctx.mobile);
    const touchEl = document.getElementById('touch');
    this.touch = touchEl ? new FlightTouch(touchEl, () => ctx.sfx.pop()) : null;
    this.hud.onIlsGuide = () => {
      this.ilsOn = !this.ilsOn;
      save(STORE.ils, this.ilsOn ? '1' : '0');
      this.hud.toggles(this.ilsOn, this.sim?.voices ?? false);
      this.hud.toast(this.ilsOn ? 'ILS guide on: fly through the boxes on final' : 'ILS guide off');
    };
    this.hud.onVoices = () => {
      const sim = this.sim;
      if (!sim) return;
      sim.voices = !sim.voices;
      if (!sim.voices) sim.speech.cancel();
      save(STORE.voices, sim.voices ? '1' : '0');
      this.hud.toggles(this.ilsOn, sim.voices);
    };
    // the first officer's switches: remembered for the booking card too
    this.hud.onAutoTaxi = () => {
      const fo = this.sim?.fo;
      if (!fo) return;
      fo.autoTaxi = !fo.autoTaxi;
      save(STORE.autoTaxi, fo.autoTaxi ? '1' : '0');
      this.hud.assists(fo.autoTaxi, fo.autoland);
      this.hud.toast(fo.autoTaxi ? 'Auto taxi on: the first officer taxis' : 'Auto taxi off: you have control');
    };
    this.hud.onAutoland = () => {
      const fo = this.sim?.fo;
      if (!fo) return;
      fo.autoland = !fo.autoland;
      save(STORE.autoland, fo.autoland ? '1' : '0');
      this.hud.assists(fo.autoTaxi, fo.autoland);
      this.hud.toast(fo.autoland ? 'Autoland on: the autopilot lands, the first officer configures' : 'Autoland off: you land it');
    };
    this.hud.onSkip = () => this.skipToRunway();
    this.hud.onKeyHelp = () => save(STORE.keys, this.hud.keysOpen ? '1' : '0');

    // the hero waits at home with its door on the bridge
    this.park('home');
  }

  // ---------------------------------------------------------------------------------------------- the booking card

  /**
   * The booking card for the gate desk at `from` (ui.panel html). For guests (or a member short of
   * tickets), `gate` (a note and a way forward) takes the Board button's place.
   */
  offerHtml(from: Region, cost = FLIGHT_COST, gate: string | null = null): string {
    this.offerFrom = from;
    this.offerCost = cost;
    this.offerGate = gate;
    this.booking = { from, timeOfDay: this.tod };
    const f = bookFlight(from, this.tod);
    const dep = AIRFIELDS[f.from].geo;
    const arr = AIRFIELDS[f.to].geo;
    const w = decodeWeather(f.weather);
    const m = metars(f);
    const stand = AIRFIELDS[from].stands.find((s) => s.id === AIRFIELDS[from].playerStand);
    const tickets = `${cost} ${cost === 1 ? 'ticket' : 'tickets'}`;
    // each with its departure time: the same times the terminal's boards list (boards.ts scheduleBoards)
    const tod = TODS.map((t) => `<button type="button" data-fl-tod="${t.id}" aria-pressed="${t.id === this.tod}">${t.label}<span class="fl-tod-time">${f.flightNo} · ${clockText(TIME_OF_DAY_HOUR[t.id])}</span></button>`).join('');
    const controls = this.ctx.mobile
      ? 'The stick flies it, the lever on the right is the thrust, the buttons do the rest; <kbd>E</kbd> talks to ATC.'
      : '<kbd>W</kbd><kbd>S</kbd> pitch, <kbd>A</kbd><kbd>D</kbd> roll and steer, <kbd>Y</kbd> TOGA, <kbd>P</kbd> autopilot, <kbd>E</kbd> talks to ATC. The full list is on screen.';
    const assists = ASSISTS.map(
      (a) =>
        `<label class="fl-switch"><input type="checkbox" data-fl-assist="${a.id}"${load(a.store) === '1' ? ' checked' : ''}><span class="fl-switch-track" aria-hidden="true"></span><span><b>${a.label}</b><small>${a.sub}</small></span></label>`,
    ).join('');
    return `<div class="fl-offer" data-fl-offer>
<p class="eyebrow">Funfair Air · Gate ${stand?.gate ?? ''} · ${dep.icao}</p>
<h2>${f.flightNo} to ${arr.name} ✈️</h2>
<p>Take the captain's seat of our Airbus A320neo: push back, taxi out, fly ${f.flightNo === 'FA101' ? 'south over the sea to the island' : 'north back to the fair'} and land it yourself. ATC, the autopilot and your first officer help all the way.</p>
<p class="drone-offer"><span>🛫 ${f.flightNo}</span><span>⏱️ ${blockText(f.plan.blockTimeS + SCHEDULE_PAD_S)}</span><span>👥 ${f.passengers} aboard</span><span>🎟️ ${tickets}</span></p>
<p class="sub">Fly at</p>
<div class="fl-offer-tod" role="group" aria-label="Time of day">${tod}</div>
<p class="sub">Your first officer</p>
<div class="fl-offer-assist" role="group" aria-label="Your first officer">${assists}</div>
<dl class="fl-offer-facts">
<dt>Route</dt><dd>${dep.name} (${dep.icao}) → ${arr.name} (${arr.icao})</dd>
<dt>Aircraft</dt><dd>Airbus A320neo · ${f.registration}</dd>
<dt>Departs</dt><dd>${clockText(f.hour)} · block ${blockText(f.plan.blockTimeS + SCHEDULE_PAD_S)}</dd>
<dt>Departure</dt><dd>${runwayText(f, f.depRunway)}</dd>
<dt>Arrival</dt><dd>${runwayText({ ...f, from: f.to }, f.arrRunway)}</dd>
<dt>Wind</dt><dd>${w.wind}</dd>
<dt>Visibility</dt><dd>${w.vis}</dd>
<dt>Cloud</dt><dd>${w.clouds}</dd>
<dt>Air</dt><dd>${w.temp} · ${w.qnh}</dd>
</dl>
<p class="fl-offer-metar">${m.dep}<br>${m.arr}</p>
<p class="sub">${controls}</p>
${gate ?? `<p><button class="btn btn-primary btn-small" type="button" data-flight-board>Board ${f.flightNo} · ${cost} 🎟️</button></p>`}
</div>`;
  }

  /** The card's time-of-day picker (it redraws the card for the new weather), its first officer switches and its Board button. */
  wireOffer(panel: HTMLElement, onBook: () => void): void {
    const card = panel.querySelector<HTMLElement>('[data-fl-offer]');
    if (!card) return;
    card.querySelectorAll<HTMLInputElement>('[data-fl-assist]').forEach((box) =>
      box.addEventListener('change', () => {
        const a = ASSISTS.find((x) => x.id === box.dataset.flAssist);
        if (a) save(a.store, box.checked ? '1' : '0');
        this.ctx.sfx.pop();
      }),
    );
    card.querySelectorAll<HTMLButtonElement>('[data-fl-tod]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tod = b.dataset.flTod as TimeOfDay;
        this.onTimeOfDay?.(this.tod);
        this.ctx.sfx.pop();
        card.outerHTML = this.offerHtml(this.offerFrom, this.offerCost, this.offerGate);
        this.wireOffer(panel, onBook);
      }),
    );
    card.querySelector('[data-flight-board]')?.addEventListener('click', () => onBook());
  }

  // ---------------------------------------------------------------------------------------------- the round

  start(): void {
    const d = this.deps;
    const from = this.booking?.from ?? this.parkedAt;
    const info = bookFlight(from, this.booking?.timeOfDay ?? this.tod);
    const voices = load(STORE.voices) === '1';
    const sim = new FlightSim({ info, ground: d.ground, sfx: this.ctx.sfx, traffic: d.traffic, speak: voices, speech: this.speech });
    // the booking card's switches
    const skip = load(STORE.skip) === '1';
    sim.fo.autoTaxi = load(STORE.autoTaxi) === '1';
    sim.fo.autoland = load(STORE.autoland) === '1';
    sim.fo.onChange = () => this.hud.assists(sim.fo.autoTaxi, sim.fo.autoland);
    this.sim = sim;
    this.active = true;
    this.completed = false;
    this.abandoned = false;
    this.lastFailed = false;
    this.arrival = null;
    this.reportShown = false;
    this.completeFired = false;
    this.aftermathT = 0;
    this.skipT = -1;
    this.runwayT = -1;
    this.tugT = 0;
    this.hintClock = 0;
    this.utcSec = -1;
    this.data = null;
    this.ecamClock = 0;
    const ilsSaved = load(STORE.ils);
    this.ilsOn = ilsSaved === null ? load(STORE.flown) !== '1' : ilsSaved === '1';

    // the sky of the chosen hour, the weather on the card
    const env = d.env;
    this.saved.hours = env.hours;
    this.saved.timeMode = env.timeMode;
    this.saved.swellFrom = SWELL.fromDeg;
    this.saved.swellKt = SWELL.kt;
    env.timeMode = 'paused';
    env.setHour(info.hour);
    env.clouds.setLayers(info.weather.clouds.map((c) => ({ cover: c.cover, baseFt: c.baseFt })));
    env.sea.setWind(info.weather.windFrom, info.weather.windKt);
    env.setVisibility(info.weather.visibilityM);
    env.setFarFocus(true);
    d.traffic.setWeather(info.weather);
    for (const r of ['home', 'island'] as const) d.airfields[r].setWind(info.weather.windFrom, info.weather.windKt);

    // the radio: the AI's lines on our frequency, every line into the log
    const prevRadio = d.traffic.onRadioAt;
    this.prevRadio = prevRadio;
    d.traffic.onRadioAt = (u, region, station) => {
      prevRadio?.(u, region, station);
      this.sim?.hear(u, region, station);
    };
    sim.speech.onLine = (u) => this.hud.line(u);
    // the cabin (the PA and the passengers) is its own channel: its own card, never the radio log
    // (and none once the flight has failed or its report is up: no "we've started our descent" over the sea)
    sim.speech.onCabin = (u) => {
      if (!sim.failed && !this.reportShown) this.hud.cabin(u);
    };
    sim.onScore = (it: ScoreItem) => this.hud.score(it);
    sim.onNote = (t) => this.hud.toast(t);
    sim.onStage = (st, prev) => this.stageChanged(st, prev);
    sim.pushReady = () => this.tugT > 4.3;
    sim.deplaneDone = () => (this.run ? this.run.done : false);
    sim.onClearance = (k) => {
      if (k === 'approach' && this.ilsOn) this.hud.toast('Cleared for the ILS: fly through the boxes');
    };

    // the aircraft at its stand, the door on the bridge (or the stairs), the passengers walking on
    this.parkedAt = from;
    this.placeHero(sim.depStand.x, sim.depStand.z, sim.depStand.heading);
    this.dock(from, true);
    this.docked = true;
    this.doorK = this.doorTarget = 1;
    this.cargoK = 1;
    this.slides.visible = false;
    this.ils.setRunway(sim.arrRw);
    this.ils.show(false);
    this.run = skip ? null : d.travellers.board(from, WALKERS, this.boardPath(from));
    this.runT = 0;
    this.cams.set('cockpit');
    this.cams.orbit = false;
    this.cams.fixed = { pos: GATE_SHOT[from].pos, look: GATE_SHOT[from].look, fov: 50 };

    // the screen
    if (this.input) {
      this.controls = new FlightControls(this.input, this.touch);
      this.controls.onNote = (t) => this.hud.toast(t);
      this.controls.onCamera = () => this.cycleCamera();
      this.controls.onWarp = () => this.warp();
      this.controls.onSkip = () => this.skipToRunway();
      this.controls.attach(sim);
      this.controls.enabled = false;
    }
    this.cockpit.onFcu = (c) => this.controls?.fcu(c);
    this.cockpit.setView('hidden');
    this.hud.show(true);
    this.hud.clear();
    this.hud.toggles(this.ilsOn, voices);
    this.hud.assists(sim.fo.autoTaxi, sim.fo.autoland);
    this.hud.keysOpen = load(STORE.keys) === '1';
    this.hud.camera('Gate window');
    document.body.classList.add('is-piloting');
    this.ctx.sfx.startAircraft();
    this.ctx.sfx.chime();
    if (skip) {
      // straight to the runway: no boarding to watch, and the hint says what's next
      this.jumpToRunway();
      return;
    }
    this.ctx.ui.setIntro(
      'flight-intro',
      'Funfair Air',
      `<p class="eyebrow">Funfair Air · ${info.flightNo} · ${info.callsign}</p><h2>Welcome aboard, Captain</h2><p>The passengers are boarding. Once the doors are closed, press <kbd>E</kbd> to call ATC for the pushback, then for taxi and for takeoff. The hint at the top always says what comes next.</p><p>${
        this.ctx.mobile ? 'The stick flies it; the lever on the right sets the thrust; the buttons do flaps, gear, brakes, the autopilot and the camera.' : 'The keys are listed on the right of the screen (Keys). <kbd>C</kbd> changes the camera; drag to look round.'
      }</p><p>In a hurry? <b>⏩ Skip to the runway</b>${this.ctx.mobile ? '' : ' (<kbd>N</kbd>)'} puts you on the runway with the engines running, any time before the takeoff.</p>`,
      {},
    );
  }

  /** ⏩ (or N): the boarding, the pushback and the taxi skipped, behind a fade. */
  private skipToRunway() {
    const sim = this.sim;
    if (!this.active || !sim || !sim.canSkip || this.runwayT >= 0 || this.skipT >= 0 || this.reportShown) return;
    this.ctx.sfx.pop();
    this.hud.fade(true);
    this.runwayT = 0;
  }

  /** The skip itself: the aircraft on the runway (the sim), the passengers aboard, the doors shut, the bridge or the stairs away, the captain's seat. */
  private jumpToRunway() {
    const sim = this.sim!;
    if (!sim.skipToRunway()) return;
    this.run?.skip();
    this.run = null;
    this.doorK = this.doorTarget = 0;
    this.cargoK = 0;
    if (this.docked) {
      this.retract(sim.from, true);
      this.docked = false;
    }
    this.cams.fixed = null;
    this.cams.orbit = false;
    this.cams.set('cockpit');
    this.hud.camera(CAM_LABEL.cockpit);
    if (this.ctx.ui.panelOpenKey === 'flight-intro') this.ctx.ui.hidePanel();
  }

  private prevRadio: Traffic['onRadioAt'] = null;

  /** E: the next radio call, or skipping what can be skipped (boarding, the taxi-in, deplaning, the report). */
  action(): void {
    const sim = this.sim;
    if (!this.active || !sim) return;
    if (this.reportShown) {
      this.complete();
      return;
    }
    switch (sim.stage) {
      case 'boarding':
      case 'deplaning':
        this.run?.skip();
        return;
      case 'failed':
        this.aftermathT = 1e9;
        return;
    }
    if (sim.atc.nextRequest === 'skip-taxi-in' && this.skipT < 0) {
      // a fade over the jump to the stand
      this.hud.fade(true);
      this.skipT = 0;
      return;
    }
    if (!sim.action()) {
      const h = sim.hint();
      if (h) this.hud.toast(h.text);
    }
  }

  cycleCamera(): void {
    if (!this.active || this.cams.fixed || this.cams.orbit) return;
    const m = this.cams.cycle();
    this.hud.camera(CAM_LABEL[m]);
    this.ctx.sfx.pop();
  }

  look(dx: number, dy: number): void {
    this.cams.look(dx, dy);
  }

  zoomBy(d: number): void {
    this.cams.zoomBy(d);
  }

  private warp() {
    const sim = this.sim;
    if (!sim) return;
    const before = sim.warp;
    const w = sim.cycleWarp();
    if (w === 1 && before === 1) this.hud.toast('Time warp: cruising on the autopilot above 2,000 ft');
    else this.hud.toast(w === 1 ? 'Time warp off' : `Time ×${w}`);
  }

  /** The round's end: everything put back as it was. */
  exit(): void {
    if (!this.active) return;
    this.active = false;
    const d = this.deps;
    const sim = this.sim!;
    // landed and off the runway counts as arrived, Esc on the taxi-in or at the stand included: the
    // visitor gets off at the destination and the aircraft stays there
    const done = sim.arrived;
    this.completed = done;
    this.lastFailed = sim.failed;
    this.abandoned = !done && !sim.failed;
    if (!sim.finished) sim.abandon();
    sim.speech.cancel();
    sim.speech.onLine = null;
    sim.speech.onCabin = null;
    this.hud.cabin(null);
    d.traffic.onRadioAt = this.prevRadio;
    this.prevRadio = null;
    this.run?.skip();
    this.run = null;

    // the visitor: off the aircraft at the destination, or back at the departure's gate desk
    const spot = done ? AIRPORT_SPOTS[sim.to].arrivals : AIRPORT_SPOTS[sim.from].gateDesk;
    this.arrival = { x: spot.x, z: spot.z, heading: spot.yaw };
    if (done) save(STORE.flown, '1');

    // the aircraft waits where the visitor is: at the destination's stand, or back at the departure's
    const at: Region = done ? sim.to : sim.from;
    for (const r of ['home', 'island'] as const) {
      const as = d.airside[r];
      if (as.tug.attached) as.tug.detach();
      as.tug.reset();
      d.airfields[r].setGuidance(null);
      d.airside[r].setPlayerAircraft(null);
    }
    d.airfields[sim.from].setStopBar(sim.atc.entry.hold, true);
    this.park(at);

    // the sky and the camera
    const env = d.env;
    env.timeMode = this.saved.timeMode;
    env.setHour(this.saved.hours);
    env.clouds.setLayers(null);
    env.sea.setWind(this.saved.swellFrom, this.saved.swellKt);
    env.setVisibility(null);
    env.resetShadowSpan();
    env.setFarFocus(false);
    env.restoreViewRange();
    d.post.setAOEnabled(true);
    const cam = this.ctx.camera;
    cam.up.set(0, 1, 0);
    // (from the aspect, as on foot: a phone may have turned during the flight)
    cam.fov = cam.aspect < 0.8 ? 58 : 42;
    cam.updateProjectionMatrix();

    // the screen
    this.controls?.detach();
    this.controls = null;
    this.cockpit.onFcu = null;
    this.cockpit.setView('hidden');
    this.hero.setCockpitView(false);
    this.hud.show(false);
    this.ils.show(false);
    document.body.classList.remove('is-piloting');
    if (this.ctx.ui.panelOpenKey === 'flight-report' || this.ctx.ui.panelOpenKey === 'flight-intro') this.ctx.ui.hidePanel();
    this.ctx.sfx.stopAircraft();
    this.cams.fixed = null;
    this.cams.orbit = false;
    this.onFinish?.();
  }

  /**
   * This flight's numbers (see account/stats.ts); valid mid-round. A flight left before arriving
   * scores nothing (as a failed one): only what was flown counts, not the points not yet lost; one
   * left before the takeoff reports its 0 score and nothing else.
   */
  roundStats(): Record<string, number> {
    if (!this.sim) return {};
    // left early: after exit(), or still under way when the page closes (Game's pagehide)
    const left = this.abandoned || (this.active && !this.sim.arrived && !this.sim.failed);
    // left before the takeoff (boarding, pushback, taxi): nothing was flown, so nothing but the 0
    if (left && !this.sim.scorer.tookOff) return { score: 0 };
    const st = this.sim.scorer.stats();
    if (left) {
      st.score = 0;
      st.stars = 1;
      for (const k of ['landingFpm', 'landingG', 'centrelineM', 'touchdownM']) delete st[k];
    }
    return st;
  }

  /** Landed and off the runway (Game's Esc then leaves as completed, at the destination). */
  get arrived(): boolean {
    return this.active && !!this.sim && this.sim.arrived;
  }

  /** The flight crashed or ditched (its aftermath, or its report): the round is over, Esc just closes it. */
  get failed(): boolean {
    return this.active && !!this.sim && this.sim.failed;
  }

  /** The flight while it's flown; between flights the getters read the parked hero. */
  private get live(): FlightSim | null {
    return this.active ? this.sim : null;
  }

  // ---------------------------------------------------------------------------------------------- for Game

  /** The ground point under the aircraft (env.follow). */
  get focus(): THREE.Vector3 {
    const p = this.live ? this.live.state.pos : this.idlePos;
    return this.focusV.set(p.x, 0, p.z);
  }

  get position(): THREE.Vector3 {
    return this.posV.copy(this.live ? this.live.state.pos : this.idlePos);
  }

  /** The park's yaw (radians, 0 north, forward = (−sin, −cos)): −heading. */
  get yaw(): number {
    return -(this.live ? this.live.state.heading : this.idleHeading) * D2R;
  }

  /** Metres above the ground (the haze and the minimap's scale). */
  get altitude(): number {
    return this.live ? Math.max(0, this.live.state.radioAltFt * FT) : 0;
  }

  /** The aircraft's state for Traffic.update's player (null between flights). */
  get trafficPlayer(): AircraftState | null {
    return this.active && this.sim ? this.sim.state : null;
  }

  /** Which region the aircraft is over now (the visitor's region while flying). */
  get region(): Region {
    const p = this.live ? this.live.state.pos : this.idlePos;
    return regionAt(p.x, p.z);
  }

  /** The flight being flown (dev and preview), or null between flights. */
  get simulation(): FlightSim | null {
    return this.active ? this.sim : null;
  }

  /** For the minimap in flight: the AI traffic and the plan's fixes. */
  get markers(): FlightMarker[] {
    const out = this.markerList;
    out.length = 0;
    const sim = this.live;
    if (!sim) return out;
    let n = 0;
    const take = () => this.markerPool[n] ?? (this.markerPool[n] = { x: 0, z: 0, kind: 'fix', label: '' });
    for (const c of this.deps.traffic.contacts()) {
      const m = take();
      m.x = c.x;
      m.z = c.z;
      m.kind = 'traffic';
      m.label = c.callsign;
      out.push(m);
      n++;
    }
    for (const f of sim.nav.legs) {
      const m = take();
      m.x = f.x;
      m.z = f.z;
      m.kind = 'fix';
      m.label = f.name;
      out.push(m);
      n++;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- the frame

  update(dt: number, t: number): void {
    const sim = this.sim;
    if (!this.active || !sim) {
      this.idle(dt, t);
      return;
    }
    const d = this.deps;
    const realDt = Math.min(dt, 0.1);
    if (this.controls) this.controls.enabled = sim.stage !== 'boarding' && sim.stage !== 'failed' && sim.stage !== 'done' && sim.stage !== 'deplaning' && sim.stage !== 'parking';

    // the taxi-in skip: the fade first, then the jump, then the fade lifts
    if (this.skipT >= 0) {
      this.skipT += realDt;
      if (this.skipT > 0.5 && sim.atc.nextRequest === 'skip-taxi-in') sim.action();
      if (this.skipT > 0.9) {
        this.hud.fade(false);
        this.skipT = -1;
      }
    }
    // the skip to the runway: the same fade over the jump
    if (this.runwayT >= 0) {
      const before = this.runwayT;
      this.runwayT += realDt;
      if (before < JUMP_S && this.runwayT >= JUMP_S) this.jumpToRunway();
      if (this.runwayT > FADE_S) {
        this.hud.fade(false);
        this.runwayT = -1;
      }
    }
    this.hud.skipShown(sim.canSkip && this.runwayT < 0 && !this.reportShown);

    // the passengers, and what they set going
    if (this.run) {
      this.runT += realDt;
      if (sim.stage === 'boarding') {
        if (this.runT > BOARDING_MAX_S && !this.run.done) this.run.skip();
        sim.boarding(this.run.done ? 1 : Math.min(0.99, this.run.progress));
      } else if (sim.stage === 'deplaning' && this.runT > DEPLANING_MAX_S && !this.run.done) this.run.skip();
    }

    sim.step(realDt, this.pilotOverride ?? this.controls?.frame);
    const s = sim.state;
    const region = regionAt(s.pos.x, s.pos.z);

    // the door, the bridge or the stairs, the tug
    this.doorK = toward(this.doorK, this.doorTarget, realDt / DOOR_S);
    this.cargoK = toward(this.cargoK, sim.stage === 'boarding' ? 1 : 0, realDt / 4);
    if (sim.stage === 'stand' && this.docked && this.doorK <= 0.001) {
      this.retract(sim.from);
      this.docked = false;
    }
    if (sim.stage === 'parking' || sim.stage === 'deplaning' || sim.stage === 'done') {
      this.dockT += realDt;
      if (!this.docked && this.dockT > DOCK_DELAY_S) {
        this.dock(sim.to, false);
        this.docked = true;
      }
      // (the door opens once the bridge or the stairs are there, or after a while whatever they're doing)
      if (this.docked && (this.dockK(sim.to) > 0.98 || this.dockT > DOCK_DELAY_S + 12)) this.doorTarget = 1;
      if (sim.stage === 'deplaning' && !this.run && this.doorK > 0.98) {
        this.run = d.travellers.deplane(sim.to, WALKERS, this.deplanePath(sim.to));
        this.runT = 0;
      }
    }
    const tug = d.airside[sim.from].tug;
    this.pose.x = s.pos.x;
    this.pose.z = s.pos.z;
    this.pose.heading = s.heading;
    if (sim.stage === 'push' && tug.attached) {
      this.tugT += realDt;
      tug.follow(this.pose, realDt);
    }
    for (const r of ['home', 'island'] as const) d.airside[r].setPlayerAircraft(s.onGround && r === region ? this.pose : null);

    // the greens and the stop bar
    const field = d.airfields[region];
    if (sim.route && (sim.stage === 'taxi' || sim.stage === 'taxi-in')) field.setGuidance(sim.route.nodes as string[], sim.route.fromIndex);
    else field.setGuidance(null);
    d.airfields[sim.from].setStopBar(sim.atc.entry.hold, sim.holdRed);
    const lowVis = sim.info.weather.visibilityM < 5000 ? 1 : 0;
    field.setLights(Math.max(d.env.night, lowVis));

    // the sky: the clock runs with the simulation (warp included), the view reaches as far as the weather lets it
    const env = d.env;
    env.setHour(sim.info.hour + sim.t / 3600);
    const agl = Math.max(0, s.radioAltFt * FT);
    const vis = sim.info.weather.visibilityM;
    const near = this.cams.fixed ? 0.5 : Math.min(50, Math.max(2, 2 + agl * 0.02));
    env.setViewRange(Math.min(60000, Math.max(vis, 9000) * 1.05), near);
    env.setVisibility(vis);
    env.setShadowSpan(s.onGround ? 90 : Math.min(400, 120 + agl * 0.3));
    d.post.setAOEnabled(agl < 50);

    // the ILS guide on the approach
    const p = phaseIndex(sim.nav.phase);
    const out = sim.finalDistance();
    this.ils.show(this.ilsOn && sim.stage === 'flight' && p >= phaseIndex('approach') && p < phaseIndex('landing') && out > 0 && out < 9.5 * 1852);

    this.visualise(sim, realDt, t);
    this.sound(sim);
    this.updateHud(sim, realDt);

    // the aftermath, then the report
    if (sim.stage === 'failed' || (sim.stage === 'done' && sim.failed)) {
      this.aftermathT += realDt;
      if (this.aftermathT > 10 && !this.reportShown) this.report();
    } else if (sim.stage === 'done' && !this.reportShown) this.report();
  }

  /** The camera, then the cockpit's instruments (the windscreen frame follows the camera). */
  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const sim = this.sim;
    if (!sim) return;
    this.cams.update(camera, dt, sim.state);
    const deck = this.cams.onFlightDeck;
    this.hero.setCockpitView(deck);
    const failed = sim.stage === 'failed' || this.reportShown;
    this.cockpit.setView(this.cams.fixed || failed ? 'hidden' : deck ? 'cockpit' : 'outside');
    this.cockpit.update(Math.min(dt, 0.1), this.fillData(sim, Math.min(dt, 0.1)));
  }

  // ---------------------------------------------------------------------------------------------- stages

  private stageChanged(st: Stage, prev: Stage) {
    const sim = this.sim!;
    const d = this.deps;
    switch (st) {
      case 'stand':
        // doors closed: off the gate window into the captain's seat
        this.run = null;
        this.doorTarget = 0;
        this.cams.fixed = null;
        this.cams.set('cockpit');
        this.hud.camera(CAM_LABEL.cockpit);
        if (this.ctx.ui.panelOpenKey === 'flight-intro') this.ctx.ui.hidePanel();
        break;
      case 'push':
        d.airside[sim.from].tug.attach(sim.depStand.id);
        this.tugT = 0;
        break;
      case 'taxi':
        if (prev === 'push') d.airside[sim.from].tug.detach();
        break;
      case 'parking':
        this.dockT = 0;
        this.docked = false;
        this.doorTarget = 0;
        this.hud.fade(false);
        break;
      case 'deplaning':
        // to the terminal's window, to watch the bridge (or the stairs) come and the passengers walk off
        this.cams.fixed = { pos: GATE_SHOT[sim.to].pos, look: GATE_SHOT[sim.to].look, fov: 50 };
        this.hud.camera('Gate window');
        break;
      case 'failed': {
        this.cams.fixed = null;
        this.cams.orbit = true;
        this.aftermathT = 0;
        this.ils.show(false);
        const ditched = sim.failure === 'ditching' || (sim.state.pos.y < 2 && d.ground(sim.state.pos.x, sim.state.pos.z).surface === 'water');
        this.slides.visible = ditched;
        this.hud.camera('Aftermath');
        // the cabin's routine announcements are over: the card goes with them
        this.hud.cabin(null);
        this.hud.toast('Passengers evacuated safely', 'bad');
        this.ctx.sfx.stopAircraft();
        break;
      }
    }
  }

  /** The Flight report card: the score, the stars, the landing, the comfort and the list. */
  private report() {
    const sim = this.sim!;
    this.reportShown = true;
    this.hud.cabin(null);
    const r = sim.scorer.debrief();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const lines = r.lines
      .map((l) => `<li class="${/^−/.test(l) ? 'fl-bad' : /^\+/.test(l) ? 'fl-good' : ''}">${esc(l)}</li>`)
      .join('');
    const failed = sim.failed;
    this.ctx.ui.panel(
      'flight-report',
      `<div class="fl-report"><p class="eyebrow">Flight report · ${sim.info.flightNo} · ${AIRFIELDS[sim.from].geo.icao} → ${AIRFIELDS[sim.to].geo.icao}</p><h2>${esc(r.title)}</h2>${
        failed ? '<p>Everyone got off safely: the cabin crew had the slides out in seconds.</p>' : ''
      }<ol>${lines}</ol><p><button class="btn btn-primary btn-small" type="button" data-flight-continue>Continue <kbd>E</kbd></button></p></div>`,
      { left: true },
    );
    this.ctx.ui.panelElement.querySelector('[data-flight-continue]')?.addEventListener('click', () => this.complete());
    this.ctx.sfx.chime();
  }

  private complete() {
    if (this.completeFired) return;
    this.completeFired = true;
    if (this.ctx.ui.panelOpenKey === 'flight-report') this.ctx.ui.hidePanel();
    const sim = this.sim;
    this.completed = !!sim && sim.finished && !sim.failed;
    this.onComplete?.();
  }

  // ---------------------------------------------------------------------------------------------- the aircraft

  /** Between flights: parked on its stand at `region`, door open to the bridge or the stairs. */
  private park(region: Region) {
    this.parkedAt = region;
    const ap = AIRFIELDS[region];
    const st = ap.stands.find((s) => s.id === ap.playerStand)!;
    this.placeHero(st.x, st.z, st.heading);
    this.dock(region, true);
    const other: Region = region === 'home' ? 'island' : 'home';
    this.retract(other, true);
    this.slides.visible = false;
    Object.assign(this.visual, restVisual());
    this.visual.doorL1 = 1;
    this.doorK = 1;
    this.pose.x = st.x;
    this.pose.z = st.z;
    this.pose.heading = st.heading;
  }

  private placeHero(x: number, z: number, heading: number) {
    const g = this.hero.group;
    g.position.set(x, this.deps.ground(x, z).y, z);
    g.quaternion.setFromAxisAngle(this.up, -heading * D2R);
    this.idlePos.copy(g.position);
    this.idleHeading = heading;
  }

  private idle(dt: number, t: number) {
    this.visual.lights.cabin = this.deps.env.night > 0.3;
    this.visual.lights.logo = this.visual.lights.cabin;
    this.hero.setNight(this.deps.env.night);
    this.hero.setVisual(this.visual, dt, t);
    this.deps.airside[this.parkedAt].setPlayerAircraft(this.pose);
  }

  private visualise(sim: FlightSim, dt: number, t: number) {
    const s = sim.state;
    const fm = sim.fm;
    const v = this.visual;
    const g = this.hero.group;
    g.position.copy(s.pos);
    g.quaternion.copy(s.quat);
    if (this.slides.visible) {
      // afloat: level, low in the water, rocking on the swell
      this.aftermathFloat(sim, t);
    }
    v.flapsDeg = s.flapsDeg;
    v.slatsDeg = s.slatsDeg;
    v.gear = s.gear;
    v.aileron = s.aileron;
    v.elevator = s.elevator;
    v.rudder = s.rudder;
    v.spoilerL = fm.sys.spoilerL;
    v.spoilerR = fm.sys.spoilerR;
    v.reverser = s.reverser;
    v.n1[0] = s.n1[0];
    v.n1[1] = s.n1[1];
    v.nosewheel = s.nosewheel;
    v.wheelSpin = s.wheelSpin;
    v.compression[0] = s.compression[0];
    v.compression[1] = s.compression[1];
    v.compression[2] = s.compression[2];
    v.doorL1 = this.doorK;
    v.doorL2 = 0;
    v.cargo = this.cargoK;
    const st = sim.stage;
    const running = fm.sys.engineRunning[0] || fm.sys.engineRunning[1];
    const moving = st === 'push' || st === 'taxi' || st === 'flight' || st === 'taxi-in';
    const L = v.lights;
    const night = this.deps.env.night;
    L.nav = st !== 'boarding' && st !== 'done';
    L.beacon = running || st === 'push';
    const onRunwayOrAir = st === 'flight';
    L.strobe = onRunwayOrAir && (!s.onGround || s.ias > 30 || sim.atc.clearance.takeoff);
    L.landing = onRunwayOrAir && s.altFt < 10000 + 500 && (!s.onGround || s.ias > 25 || sim.atc.clearance.takeoff);
    L.taxi = moving && s.onGround && s.gs > 0.5;
    L.logo = night > 0.3 && st !== 'failed';
    L.cabin = st !== 'failed';
    this.hero.setNight(night);
    this.hero.setVisual(v, dt, t);
  }

  private aftermathFloat(sim: FlightSim, t: number) {
    const g = this.hero.group;
    const s = sim.state;
    g.position.set(s.pos.x, SEA_Y - 2.0 + Math.sin(t * 0.7) * 0.15, s.pos.z);
    this.q.setFromAxisAngle(this.up, -s.heading * D2R);
    g.quaternion.copy(this.q);
    g.rotateZ(Math.sin(t * 0.5) * 0.02);
    g.rotateX(0.035);
  }

  /** The four door slides, out and inflated (a ditching's aftermath). */
  private buildSlides() {
    const grp = new THREE.Group();
    grp.name = 'flight-slides';
    const mat = new THREE.MeshStandardMaterial({ color: '#ffcf1f', roughness: 0.55 });
    const geo = new THREE.BoxGeometry(1.7, 0.45, 6.2).translate(0, 0, 3.1);
    const doors = [A320_POINTS.doorL1, A320_POINTS.doorR1, A320_POINTS.doorL2, A320_POINTS.doorR2];
    for (const p of doors) {
      const m = new THREE.Mesh(geo, mat);
      const side = Math.sign(p.x);
      m.position.set(p.x + side * 0.3, p.y - 0.2, p.z);
      // out from the door, down to the water
      m.rotation.set(0.32, side * Math.PI * 0.5, 0, 'YXZ');
      m.castShadow = this.ctx.quality.shadows;
      grp.add(m);
    }
    grp.visible = false;
    return grp;
  }

  // ---------------------------------------------------------------------------------------------- bridges, stairs, passengers

  private dock(region: Region, instant: boolean) {
    if (region === 'home') this.deps.homeTerminal.bridges[AIRFIELDS.home.playerStand]?.dock(instant);
    else this.deps.islandTerminal.stairs[AIRFIELDS.island.playerStand]?.dock(instant);
  }

  private retract(region: Region, instant = false) {
    if (region === 'home') this.deps.homeTerminal.bridges[AIRFIELDS.home.playerStand]?.retract(instant);
    else this.deps.islandTerminal.stairs[AIRFIELDS.island.playerStand]?.retract(instant);
  }

  private dockK(region: Region) {
    return region === 'home' ? (this.deps.homeTerminal.bridges[AIRFIELDS.home.playerStand]?.k ?? 1) : (this.deps.islandTerminal.stairs[AIRFIELDS.island.playerStand]?.k ?? 1);
  }

  private boardPath(region: Region): THREE.Vector3Like[] {
    if (region === 'home') {
      const t = this.deps.homeTerminal;
      return [...t.spots.boardingQueue.map((q) => ({ x: q.x, y: 0, z: q.z })), ...t.bridges[AIRFIELDS.home.playerStand].walkPath.slice(1)];
    }
    const t = this.deps.islandTerminal;
    return [...t.spots.boardingPath.map((q) => ({ x: q.x, y: 0, z: q.z })), ...t.stairs[AIRFIELDS.island.playerStand].path.slice(1)];
  }

  private deplanePath(region: Region): THREE.Vector3Like[] {
    if (region === 'home') {
      const t = this.deps.homeTerminal;
      return [...[...t.bridges[AIRFIELDS.home.playerStand].walkPath].reverse(), ...t.spots.arrivalsPath.slice(1).map((q) => ({ x: q.x, y: 0, z: q.z }))];
    }
    const t = this.deps.islandTerminal;
    return [...[...t.stairs[AIRFIELDS.island.playerStand].path].reverse(), ...t.spots.arrivalsPath.slice(1).map((q) => ({ x: q.x, y: 0, z: q.z }))];
  }

  // ---------------------------------------------------------------------------------------------- sound, HUD, instruments

  private sound(sim: FlightSim) {
    const s = sim.state;
    const sys = sim.fm.sys;
    const flapsMoving = Math.abs(s.flapsDeg - this.lastFlaps) > 0.001;
    this.lastFlaps = s.flapsDeg;
    if (sim.stage === 'failed' || sim.stage === 'done') return;
    const a = this.sfxParams;
    a.n1 = s.n1;
    a.ias = s.ias;
    a.onGround = s.onGround;
    a.groundSpeed = s.gs;
    a.reverser = s.reverser;
    a.spoilers = Math.max(sys.spoilerL, sys.spoilerR);
    a.gear = s.gear;
    a.inside = this.cams.inside;
    a.flapsMoving = flapsMoving;
    a.gearMoving = s.gear > 0.01 && s.gear < 0.99;
    this.ctx.sfx.aircraft(a);
  }

  private updateHud(sim: FlightSim, dt: number) {
    const hud = this.hud;
    hud.update(dt);
    this.hintClock -= dt;
    if (this.hintClock <= 0) {
      this.hintClock = 0.25;
      hud.hint(this.reportShown ? REPORT_HINT : sim.hint(), this.ctx.mobile);
      if (sim.stage === 'flight' && !sim.state.onGround && phaseIndex(sim.nav.phase) < phaseIndex('final')) {
        const pr = sim.progress();
        const mins = Math.max(1, Math.round(pr.etaS / 60));
        hud.progress(`${sim.info.flightNo} · ${Math.round(pr.toGoNm)} NM to ${sim.arr.geo.name} · ${mins} min${sim.warp > 1 ? ` · time ×${sim.warp}` : ''}`);
      } else if (sim.stage === 'push' && sim.warp > 1) hud.progress(`Time ×${sim.warp}`);
      else hud.progress(null);
    }
    const taxiing = (sim.stage === 'taxi' || sim.stage === 'taxi-in') && sim.route && sim.routeKind !== 'lineup';
    hud.taxiGuide(taxiing ? sim.guide : null, sim.state.gs);
    if (this.touch) {
      const f = sim.ap.fcu;
      const lit = this.touchLit;
      lit.gear = sim.pilot.gearDown;
      lit.ap = f.ap;
      lit.athr = f.athr;
      lit.speedbrake = sim.pilot.speedbrake > 0;
      lit.warp = sim.warp;
      lit.flaps = sim.pilot.flapLever;
      this.touch.update(sim.pilot.throttle, lit);
    }
  }

  private fillData(sim: FlightSim, dt: number): CockpitData {
    const s = sim.state;
    // one object for the whole round, its fields refreshed every frame
    const d = (this.data ??= { s, fcu: sim.ap.fcu, ils: null, nav: sim.nav, traffic: [], weather: sim.info.weather, phase: sim.nav.phase, warnings: [], memos: [], utc: '', chronoS: null, timeWarp: 1, night: 0, dhFt: 200 });
    d.s = s;
    d.fcu = sim.ap.fcu;
    d.ils = sim.nav.ils(s);
    d.nav = sim.nav;
    d.traffic = this.deps.traffic.contacts();
    d.weather = sim.info.weather;
    d.phase = sim.nav.phase;
    d.timeWarp = sim.warp;
    d.night = this.deps.env.night;
    d.sys = sim.fm.sys;
    d.controls = sim.pilot;
    d.speedTarget = sim.ap.speedTarget;
    d.lvrClb = sim.ap.lvrClb;
    d.athrActive = sim.ap.athrActive;
    d.masterWarning = sim.callouts.masterWarning;
    d.masterCaution = sim.callouts.masterCaution;
    d.knob = this.controls?.knob ?? null;
    d.chronoS = this.controls?.chronoS ?? null;
    d.autoland = sim.fo.autoland;
    // the ECAM's lists a few times a second (they're built afresh), the clock once a second
    this.ecamClock -= dt;
    if (this.ecamClock <= 0) {
      this.ecamClock = 0.25;
      const e = sim.ecam();
      d.warnings = e.warnings;
      d.memos = e.memos;
    }
    const h = sim.info.hour + sim.t / 3600;
    const sec = Math.floor(h * 3600) % 86400;
    if (sec !== this.utcSec) {
      this.utcSec = sec;
      const two = (n: number) => String(n).padStart(2, '0');
      d.utc = `${two(Math.floor(sec / 3600))}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}`;
    }
    return d;
  }
}

const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));


export type { FlightInfo };
