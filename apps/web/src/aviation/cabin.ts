// The cabin: what the passengers hear over the PA through the flight, and how they react to it.
//
// The purser welcomes them aboard while they board, asks the crew to arm the doors once they're
// closed, runs the safety briefing on the pushback (life jackets matter: the whole flight is over
// the sea), and the captain says hello after the takeoff with the flight time, the altitude and
// the weather at the other end. Then the descent, "seats for landing", the welcome at the
// destination with the local time and temperature, and "disarm doors" on the stand.
//
// The passengers applaud a butter landing, murmur after a hard one, and gasp at a big jolt or a
// steep bank. Announcements wait for a quiet moment on the radio rather than talking over ATC.

import { AIRFIELDS } from './airports';
import { phaseIndex, type Navigator } from './nav';
import { CAPTAIN_NAME, plainNumber, type Speech } from './speech';
import type { Sfx } from '../world/audio';
import type { AircraftState, Utterance, Weather } from './types';

const PURSER = 'Purser';
const CABIN = 'Cabin';

interface Announcement {
  u: Utterance;
  /** A chime before the line, and how long after it the line starts (s). */
  chime?: 'single' | 'double' | 'seatbelt';
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** "1:05 in the afternoon" → written "1:05 pm", said "one oh five in the afternoon". */
function clock(hour: number) {
  const h24 = Math.floor(((hour % 24) + 24) % 24);
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  const h12 = h24 % 12 || 12;
  const part = h24 < 12 ? 'in the morning' : h24 < 18 ? 'in the afternoon' : 'in the evening';
  const mm = m === 0 ? "o'clock" : m < 10 ? `oh ${plainNumber(m)}` : plainNumber(m);
  return { text: `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`, say: `${plainNumber(h12)} ${mm} ${part}` };
}

const greeting = (hour: number) => (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');

export class Cabin {
  /** The clock (hours) at the start of the flight, the weather and the passengers aboard. */
  hour: number;
  weather: Weather | null;
  passengers: number;

  private readonly queue: Announcement[] = [];
  private readonly done = new Set<string>();
  private chimeWait = 0;
  private held: Utterance | null = null;
  private sent: Utterance | null = null;
  private t = 0;
  private wasAirborne = false;
  private wasOnGround = true;
  private lastVs = 0;
  private lastGasp = -Infinity;
  private goArounds = 0;
  private boarded = -1;

  constructor(
    private readonly speech: Speech,
    private readonly sfx: Sfx,
    private readonly nav: Navigator,
    private readonly flightNo: string,
    opts: { hour?: number; weather?: Weather; passengers?: number } = {},
  ) {
    this.hour = opts.hour ?? 12.5;
    this.weather = opts.weather ?? null;
    this.passengers = opts.passengers ?? 156;
  }

  /** Boarding's progress, 0 (doors open, first passengers) .. 1 (everyone seated, doors closed). */
  boarding(progress: number) {
    const dest = AIRFIELDS[this.nav.plan.to].geo.name;
    const num = this.flightNo.replace(/^\D+/, '');
    if (progress >= 0 && this.boarded < 0) {
      this.boarded = 0;
      this.pa('welcome', `${greeting(this.hour)} ladies and gentlemen, and welcome aboard Funfair Air flight ${this.flightNo} to ${dest}.`, `${greeting(this.hour)} ladies and gentlemen, and welcome aboard Funfair Air flight ${plainNumber(+num || 0)} to ${dest}.`);
      this.pa('stow', 'Please find your seat quickly, stow your bags in the overhead lockers or under the seat in front of you, and keep the aisle clear for those behind you.');
    }
    if (progress >= 0.6 && this.boarded < 0.6) {
      this.boarded = 0.6;
      this.pa('nearly', 'Boarding is nearly complete. Please take your seat now and fasten your seatbelt.');
    }
    if (progress >= 1 && this.boarded < 1) {
      this.boarded = 1;
      this.pa('arm', 'Cabin crew, arm doors and cross-check.', undefined, 'double');
    }
  }

  /** The aircraft is on the stand at the destination (also call it when the taxi-in is skipped). */
  arrived() {
    if (this.done.has('disarm')) return;
    this.pa('disarm', 'Cabin crew, disarm doors and cross-check.', undefined, 'seatbelt');
    this.pa('goodbye', 'The seatbelt sign is off. Please take care opening the overhead lockers, as items may have moved during the flight. Thank you for flying Funfair Air, and enjoy your stay.');
  }

  update(dt: number, s: AircraftState) {
    if (dt <= 0) return;
    this.t += dt;
    this.feed(dt);
    const nav = this.nav;
    const phase = nav.phase;
    const p = phaseIndex(phase);
    const to = AIRFIELDS[nav.plan.to].geo;
    const w = this.weather;

    if (phase === 'pushback' || (p >= phaseIndex('taxi-out') && p <= phaseIndex('takeoff'))) this.safetyBriefing();

    // nearing the holding point: the crew take their seats
    if (phase === 'taxi-out' && Math.abs(s.pos.z - nav.departure.geo.runway.z) < 170) this.captain('seats-takeoff', 'Cabin crew, seats for takeoff.', undefined, 'single');

    if ((phase === 'climb' || phase === 'cruise') && s.altFt > 3000 && !this.done.has('welcome-fd')) {
      const mins = Math.max(2, Math.round(nav.etaS(s) / 60 + 1));
      const cruise = plainNumber(nav.plan.cruiseFt);
      const wx = w ? `The weather in ${to.name} is fine: ${w.tempC} degrees, with a ${w.windKt < 8 ? 'light' : w.windKt < 16 ? 'pleasant' : 'fresh'} breeze from the ${compass(w.windFrom)}.` : `The weather in ${to.name} looks fine.`;
      const wxSay = w ? `The weather in ${to.name} is fine: ${plainNumber(w.tempC)} degrees, with a ${w.windKt < 8 ? 'light' : w.windKt < 16 ? 'pleasant' : 'fresh'} breeze from the ${compass(w.windFrom)}.` : undefined;
      this.queue.push({ chime: 'seatbelt', u: { speaker: 'captain', from: CAPTAIN_NAME, text: `Ladies and gentlemen, ${greeting(this.hour + this.t / 3600).toLowerCase()} from the flight deck, this is your captain speaking. We're climbing to our cruising altitude of ${nav.plan.cruiseFt.toLocaleString('en-GB')} feet, and our flight time today is just ${mins} minutes.`, say: `Ladies and gentlemen, ${greeting(this.hour + this.t / 3600).toLowerCase()} from the flight deck, this is your captain speaking. We're climbing to our cruising altitude of ${cruise} feet, and our flight time today is just ${plainNumber(mins)} minutes.` } });
      this.queue.push({ u: { speaker: 'captain', from: CAPTAIN_NAME, text: `${wx} It's a short hop, so I'll keep the seatbelt signs on: please stay in your seats with your belts fastened, and enjoy the view of the sea.`, say: wxSay ? `${wxSay} It's a short hop, so I'll keep the seatbelt signs on: please stay in your seats with your belts fastened, and enjoy the view of the sea.` : undefined } });
      this.done.add('welcome-fd');
    }
    if (phase === 'cruise' && nav.etaS(s) > 150) this.pa('juice', `Our cabin crew will be coming through the cabin shortly with a complimentary ${nav.plan.to === 'island' ? 'Palm Cay pineapple juice' : 'Funfair candy-floss lemonade'}.`);

    if (p >= phaseIndex('descent') && p <= phaseIndex('final') && !nav.goingAround) {
      this.pa('descent', `Ladies and gentlemen, we have started our descent into ${to.name}. Please make sure your seatbelt is fastened, your seat back is upright, your tray table is stowed and your window blinds are open.`);
    }
    if ((phase === 'approach' || phase === 'final') && s.gear > 0.5) this.captain('seats-landing', 'Cabin crew, seats for landing.', undefined, 'single');

    // a go-around: the captain explains
    if (nav.goArounds > this.goArounds) {
      this.goArounds = nav.goArounds;
      this.queue.push({ u: { speaker: 'captain', from: CAPTAIN_NAME, text: "Ladies and gentlemen, this is your captain. As you'll have noticed, we've discontinued our approach and climbed away: it's a normal procedure. We'll fly round for another approach and be on the ground in a few minutes." } });
    }

    if ((phase === 'taxi-in' || (phase === 'rollout' && s.gs < 40)) && !this.done.has('arrival')) {
      this.done.add('arrival');
      const c = clock(this.hour + this.t / 3600);
      const temp = w ? ` and the temperature is ${w.tempC} degrees` : '';
      const tempSay = w ? ` and the temperature is ${plainNumber(w.tempC)} degrees` : '';
      this.queue.push({
        u: {
          speaker: 'pa',
          from: PURSER,
          text: `Ladies and gentlemen, welcome to ${to.name}. The local time is ${c.text}${temp}. Please remain seated with your seatbelt fastened until the captain has switched off the seatbelt sign.`,
          say: `Ladies and gentlemen, welcome to ${to.name}. The local time is ${c.say}${tempSay}. Please remain seated with your seatbelt fastened until the captain has switched off the seatbelt sign.`,
        },
      });
    }
    if (phase === 'parked') this.arrived();

    this.reactions(s);
  }

  // ---------------------------------------------------------------------------------------------- the passengers

  private reactions(s: AircraftState) {
    const air = !s.onGround;
    if (air) {
      this.lastVs = s.vs;
      this.wasAirborne = true;
    }
    if (s.onGround && !this.wasOnGround && this.wasAirborne && !this.done.has('touchdown')) {
      this.done.add('touchdown');
      const fpm = Math.abs(this.lastVs);
      if (fpm < 150) {
        this.sfx.cheer(0.75);
        this.react('The passengers burst into applause: a butter-smooth landing.');
      } else if (fpm < 230) {
        this.sfx.cheer(0.3);
        this.react('A ripple of applause from the cabin.');
      } else if (fpm > 700) {
        this.sfx.murmur(1);
        this.react('Gasps from the cabin: that was a hard landing.');
      } else if (fpm > 400) {
        this.sfx.murmur(0.7);
        this.react('A nervous murmur runs through the cabin.');
      }
    }
    this.wasOnGround = s.onGround;
    if (air && this.t - this.lastGasp > 30 && (Math.abs(s.nz - 1) > 0.45 || Math.abs(s.bank) > 40)) {
      this.lastGasp = this.t;
      this.sfx.murmur(0.6);
      this.react(Math.abs(s.bank) > 40 ? 'Passengers grip their armrests as the aircraft banks steeply.' : 'A jolt: gasps from the cabin.');
    }
  }

  /** A line of text only (no voice): what the cabin does. */
  private react(text: string) {
    this.speech.say({ speaker: 'cabin', from: CABIN, text, say: '', priority: 0 });
  }

  // ---------------------------------------------------------------------------------------------- announcements

  private safetyBriefing() {
    if (this.done.has('safety')) return;
    this.done.add('safety');
    const lines = [
      'Ladies and gentlemen, please give us your attention for the safety demonstration, even if you fly with us often.',
      'To fasten your seatbelt, insert the metal tip into the buckle and tighten the strap. To release it, lift the buckle.',
      'This aircraft has eight emergency exits: two doors at the front, four window exits over the wings and two doors at the rear. Lighting in the floor will lead you to them.',
      'If the cabin loses pressure, oxygen masks will drop from above you. Pull one down, place it over your nose and mouth and breathe normally. Fit your own mask before helping others.',
      'Your life jacket is under your seat. Put it over your head, fasten the straps round your waist, and only inflate it as you leave the aircraft, by pulling the red tabs.',
      'Smoking is not allowed anywhere on board. Thank you for your attention, and enjoy the flight.',
    ];
    for (const text of lines) this.queue.push({ u: { speaker: 'pa', from: PURSER, text } });
  }

  private pa(key: string, text: string, say?: string, chime?: Announcement['chime']) {
    if (this.done.has(key)) return;
    this.done.add(key);
    this.queue.push({ u: { speaker: 'pa', from: PURSER, text, say }, chime });
  }

  private captain(key: string, text: string, say?: string, chime?: Announcement['chime']) {
    if (this.done.has(key)) return;
    this.done.add(key);
    this.queue.push({ u: { speaker: 'captain', from: CAPTAIN_NAME, text, say }, chime });
  }

  /**
   * Hand the next announcement over once the radio has been quiet for a moment (ATC gets the
   * first word), after its chime. A line ATC cut short is said again when it's quiet.
   */
  private feed(dt: number) {
    if (this.sent && this.speech.lastCut === this.sent) {
      this.queue.unshift({ u: this.sent });
      this.speech.lastCut = null;
      this.sent = null;
    }
    if (this.held) {
      this.chimeWait -= dt;
      if (this.chimeWait <= 0) this.send(this.held);
      return;
    }
    if (!this.queue.length || this.speech.quietFor < 1.2) return;
    const a = this.queue.shift()!;
    if (a.chime) {
      this.sfx.cabinChime(a.chime);
      this.held = a.u;
      this.chimeWait = a.chime === 'double' ? 1.9 : 1.3;
    } else this.send(a.u);
  }

  private send(u: Utterance) {
    this.held = null;
    this.sent = u;
    this.speech.say(u);
  }
}
