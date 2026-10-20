// The voices of the flight: ATC, the first officer's calls and readbacks, the cabin crew's and the
// captain's announcements, and the aircraft's own synthetic voice (radio altitude callouts, GPWS).
//
// Every line is shown as text (onLine feeds the HUD's radio log) and, where the browser has
// speechSynthesis and the game isn't muted, spoken with a voice that suits the speaker. Lines are
// spoken one at a time from a short priority queue: a GPWS warning cuts into an ATC call, which
// cuts into a cabin announcement, and the queue never holds more than a few lines so the radio
// never falls behind what's happening. Without speech the same queue runs on estimated durations,
// so conversations keep their rhythm (and the logic tests can run in node).
//
// The helpers at the bottom write numbers the way they are said on the radio: "two seven",
// "one one eight decimal three", "niner", "five thousand", "flight level one two zero".

import type { Sfx } from '../world/audio';
import type { Speaker, Utterance } from './types';

/** How many lines may wait behind the one being spoken. */
const MAX_QUEUE = 3;
/** Pause between two lines (s): a beat between transmissions, like a real frequency. */
const GAP_S = 0.45;
/** Lines kept for the log. */
const LOG_MAX = 200;

/** The default priority of each speaker's lines (an utterance's own `priority` wins). */
const PRIORITY: Record<Speaker, number> = { gpws: 3, atc: 1, fo: 0, captain: 0, cabin: 0, pa: 0 };

/** The names shown for the crew when they talk in the cockpit (anything else from them is a radio call). */
export const FO_NAME = 'First Officer';
export const CAPTAIN_NAME = 'Captain';

interface VoiceProfile {
  rate: number;
  pitch: number;
  volume: number;
  /** Voice names to prefer, best first (the browsers' and OSes' English voices). */
  prefer: RegExp;
  /** Characters per second at rate 1, for the duration estimate. */
  cps: number;
}

const MALE = /Daniel|George|Guy|Ryan|David|Mark|Alex|Fred|Thomas|Arthur|Oliver|Male|Christopher|Eric|Rishi|Aaron/i;
const FEMALE = /Libby|Sonia|Hazel|Susan|Serena|Kate|Zira|Samantha|Karen|Moira|Tessa|Victoria|Jenny|Aria|Female|Michelle|Fiona/i;

const PROFILES: Record<Speaker, VoiceProfile> = {
  // controllers talk fast and flat
  atc: { rate: 1.14, pitch: 1.0, volume: 0.85, prefer: MALE, cps: 14.5 },
  fo: { rate: 1.06, pitch: 0.92, volume: 0.9, prefer: MALE, cps: 14 },
  captain: { rate: 0.98, pitch: 0.86, volume: 0.9, prefer: MALE, cps: 13.5 },
  // the cabin crew are warm and unhurried
  cabin: { rate: 0.97, pitch: 1.1, volume: 0.8, prefer: FEMALE, cps: 13.5 },
  pa: { rate: 0.97, pitch: 1.08, volume: 0.8, prefer: FEMALE, cps: 13.5 },
  // the aircraft's synthetic voice: low, even and a little mechanical
  gpws: { rate: 1.04, pitch: 0.5, volume: 1, prefer: /United States|US|David|Mark|Alex|Fred|Male/i, cps: 12 },
};

const prio = (u: Utterance) => u.priority ?? PRIORITY[u.speaker];
const spoken = (u: Utterance) => u.say ?? u.text;

/** A transmission on the radio (as opposed to talk on the flight deck or the PA): clicks, and hiss for ATC. */
function onRadio(u: Utterance) {
  if (u.speaker === 'atc') return true;
  return (u.speaker === 'fo' || u.speaker === 'captain') && u.from !== FO_NAME && u.from !== CAPTAIN_NAME;
}

export class Speech {
  /** Every line spoken (or shown) so far, oldest first (the last LOG_MAX). */
  readonly log: Utterance[] = [];
  /** Called as each line starts (the HUD's radio log shows it). */
  onLine: ((u: Utterance) => void) | null = null;
  /** Speak aloud when speech is available (text is always shown). */
  enabled = true;
  /** The last line cut short by a more important one (its owner may say it again). */
  lastCut: Utterance | null = null;

  private queue: Utterance[] = [];
  private current: Utterance | null = null;
  /** Seconds left of the current line: the estimate without speech, a watchdog with it. */
  private left = 0;
  private gap = 0;
  private synth: SpeechSynthesis | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  private utter: SpeechSynthesisUtterance | null = null;
  private utterDone = false;
  private radioOpen = false;
  private quiet = 0;

  constructor(private readonly sfx: Sfx) {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      // the voices load asynchronously (Chrome): take them when they arrive
      const load = () => (this.voices = this.synth!.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang)));
      load();
      this.synth.addEventListener('voiceschanged', load);
    }
  }

  /** Say a line (it's queued behind anything as important, and interrupts anything less so). */
  say(u: Utterance) {
    // the same warning repeating while it's already being said or waiting is one line, not a pile-up
    if (this.current && this.current.text === u.text && this.current.speaker === u.speaker) return;
    if (this.queue.some((q) => q.text === u.text && q.speaker === u.speaker)) return;
    const p = prio(u);
    if (this.current && p > prio(this.current)) {
      this.lastCut = this.current;
      this.stopCurrent();
      this.insert(u);
      this.gap = 0.05;
      return;
    }
    this.insert(u);
    if (this.queue.length > MAX_QUEUE) {
      // drop the oldest of the least important lines; its text still reaches the log
      let drop = 0;
      for (let i = 1; i < this.queue.length; i++) if (prio(this.queue[i]) < prio(this.queue[drop])) drop = i;
      const [d] = this.queue.splice(drop, 1);
      this.record(d);
    }
  }

  /**
   * Stop the line being spoken and drop the waiting ones, keeping those of at least `minPriority`
   * (with no argument everything stops).
   */
  cancel(minPriority = Infinity) {
    if (this.current && prio(this.current) < minPriority) this.stopCurrent();
    this.queue = this.queue.filter((q) => prio(q) >= minPriority);
  }

  /** Drop the waiting lines that match (stale callouts superseded by a newer one, say). */
  cancelWhere(match: (u: Utterance) => boolean) {
    this.queue = this.queue.filter((q) => !match(q));
  }

  /** Nothing being said and nothing waiting. */
  get idle() {
    return !this.current && this.queue.length === 0;
  }

  /** Whether a line of at least this priority is being said or waiting. */
  busy(minPriority = 0) {
    return (this.current !== null && prio(this.current) >= minPriority) || this.queue.some((q) => prio(q) >= minPriority);
  }

  /** Whether this line is still being said or waiting to be. */
  pending(u: Utterance) {
    return this.current === u || this.queue.includes(u);
  }

  /** How long nothing has been said or waiting (s): a pause on the frequency. */
  get quietFor() {
    return this.idle ? this.quiet : 0;
  }

  /** The line being said now, if any. */
  get speaking(): Utterance | null {
    return this.current;
  }

  /** How many lines wait behind the current one (never more than MAX_QUEUE). */
  get queued() {
    return this.queue.length;
  }

  update(dt: number) {
    this.quiet = this.idle ? this.quiet + dt : 0;
    if (this.current) {
      // muting mid-line silences it at once; the line still runs its course as text
      if (this.utter && (this.sfx.muted || !this.enabled)) {
        this.utter = null;
        this.synth?.cancel();
      }
      this.left -= dt;
      const done = this.utter ? this.utterDone || this.left <= 0 : this.left <= 0;
      if (done) {
        // the aircraft's voice rattles its callouts off back to back; people leave a beat
        this.gap = this.current.speaker === 'gpws' ? 0.06 : GAP_S;
        this.endRadio();
        this.utter = null;
        this.current = null;
      }
      return;
    }
    if (!this.queue.length) return;
    this.gap -= dt;
    if (this.gap > 0) return;
    this.start(this.queue.shift()!);
  }

  private insert(u: Utterance) {
    // by priority, first come first served within one
    const p = prio(u);
    let i = this.queue.length;
    while (i > 0 && prio(this.queue[i - 1]) < p) i--;
    this.queue.splice(i, 0, u);
  }

  private record(u: Utterance) {
    this.log.push(u);
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    this.onLine?.(u);
  }

  private start(u: Utterance) {
    this.current = u;
    this.record(u);
    const words = spoken(u);
    const prof = PROFILES[u.speaker];
    const estimate = words ? words.length / (prof.cps * prof.rate) + 0.35 : Math.min(4, 1 + u.text.length / 30);
    this.left = estimate;
    if (onRadio(u)) {
      this.sfx.radioClick();
      if (u.speaker === 'atc') this.sfx.radioHiss(true);
      this.radioOpen = true;
    }
    const synth = this.synth;
    const voiced = !!words && !!this.synth && this.enabled && !this.sfx.muted;
    // without a voice the ground proximity warnings still sound, as tones
    if (!voiced && words && prio(u) >= 3) this.sfx.gpwsAlert(/PULL UP|STALL/.test(u.text));
    if (!voiced || !synth) return;
    const su = new SpeechSynthesisUtterance(words);
    su.lang = 'en-GB';
    const voice = this.voiceFor(u);
    if (voice) {
      su.voice = voice;
      su.lang = voice.lang;
    }
    su.rate = prof.rate;
    su.pitch = prof.pitch;
    su.volume = prof.volume;
    // a watchdog in case the browser never says it has finished (it happens)
    this.left = estimate * 2.5 + 3;
    this.utterDone = false;
    const end = () => {
      if (this.utter === su) this.utterDone = true;
    };
    su.onend = end;
    su.onerror = end;
    this.utter = su;
    synth.speak(su);
  }

  private stopCurrent() {
    if (!this.current) return;
    if (this.utter) {
      this.utter = null;
      this.synth?.cancel();
    }
    this.endRadio();
    this.current = null;
  }

  private endRadio() {
    if (!this.radioOpen) return;
    this.radioOpen = false;
    this.sfx.radioHiss(false);
    this.sfx.radioClick();
  }

  /** A voice for the speaker: the preferred kind, and a different one per controller (by name). */
  private voiceFor(u: Utterance): SpeechSynthesisVoice | null {
    if (!this.voices.length) return null;
    const prof = PROFILES[u.speaker];
    const liked = this.voices.filter((v) => prof.prefer.test(v.name));
    const pool = liked.length ? liked : this.voices;
    let h = 0;
    for (let i = 0; i < u.from.length; i++) h = (h * 31 + u.from.charCodeAt(i)) | 0;
    // the crew and the aircraft keep one voice each; controllers are told apart by their station
    const pick = u.speaker === 'atc' ? Math.abs(h) % pool.length : u.speaker === 'fo' ? Math.min(1, pool.length - 1) : 0;
    return pool[pick];
  }
}

// ------------------------------------------------------------------------------------------------
// Numbers the radio way (ICAO phraseology)
// ------------------------------------------------------------------------------------------------

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Digit by digit: 27 → "two seven", "118.3" → "one one eight decimal three", 9 → "niner". */
export function digits(v: string | number): string {
  const out: string[] = [];
  for (const ch of String(v)) {
    if (ch >= '0' && ch <= '9') out.push(DIGIT_WORDS[ch.charCodeAt(0) - 48]);
    else if (ch === '.') out.push('decimal');
  }
  return out.join(' ');
}

/** Plain English for a whole number below 1000 ("twenty-nine"), for the cabin and the captain. */
export function plainNumber(n: number): string {
  n = Math.round(Math.abs(n));
  if (n < 20) return SMALL[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${SMALL[n % 10]}` : '');
  if (n < 1000) return `${SMALL[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${plainNumber(n % 100)}` : ''}`;
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${plainNumber(th)} thousand${rest ? (rest < 100 ? ` and ${plainNumber(rest)}` : ` ${plainNumber(rest)}`) : ''}`;
}

/** A frequency: "118.30" → "one one eight decimal three" (trailing zeros dropped, as ICAO says them). */
export function freqWords(f: string): string {
  const [whole, frac = ''] = f.split('.');
  const trimmed = frac.replace(/0+$/, '') || '0';
  return `${digits(whole)} decimal ${digits(trimmed)}`;
}

/**
 * An altitude below the transition level: 5000 → "five thousand", 3500 → "three thousand five
 * hundred", 13000 → "one three thousand" (ICAO: the thousands digit by digit, then the hundreds).
 */
export function altitudeWords(ft: number): string {
  ft = Math.round(ft / 100) * 100;
  const th = Math.floor(ft / 1000);
  const hu = Math.round((ft % 1000) / 100);
  const parts: string[] = [];
  if (th) parts.push(`${digits(th)} thousand`);
  if (hu) parts.push(`${DIGIT_WORDS[hu]} hundred`);
  return parts.join(' ') || 'zero';
}

/** A flight level: 120 → "flight level one two zero". */
export function flightLevelWords(fl: number): string {
  return `flight level ${digits(String(Math.round(fl)).padStart(3, '0'))}`;
}

/** A heading: 270 → "two seven zero", 5 → "zero zero five", 0 → "three six zero". */
export function headingWords(deg: number): string {
  const h = ((Math.round(deg) % 360) + 360) % 360 || 360;
  return digits(String(h).padStart(3, '0'));
}

/** A heading as written: 270 → "270", 5 → "005", 0 → "360". */
export function headingText(deg: number): string {
  const h = ((Math.round(deg) % 360) + 360) % 360 || 360;
  return String(h).padStart(3, '0');
}

/** A runway: "27" → "two seven". */
export function runwayWords(rw: string): string {
  return digits(rw);
}

/** A QNH: 1013 → "one zero one three". */
export function qnhWords(hpa: number): string {
  return digits(Math.floor(hpa));
}

/** A speed: 250 → "two five zero knots". */
export function speedWords(kt: number): string {
  return `${digits(Math.round(kt))} knots`;
}

/** The wind as ATC gives it: "two five zero degrees, one two knots, gusting two two", or "wind calm". */
export function windWords(fromDeg: number, kt: number, gustKt = 0): string {
  if (kt < 1) return 'wind calm';
  const dir = Math.round(fromDeg / 10) * 10 || 360;
  const base = `wind ${digits(String(dir).padStart(3, '0'))} degrees, ${digits(Math.round(kt))} knots`;
  return gustKt > kt ? `${base}, gusting ${digits(Math.round(gustKt))}` : base;
}

/** The same wind as written: "wind 250° 12 kt gusting 22", or "wind calm". */
export function windText(fromDeg: number, kt: number, gustKt = 0): string {
  if (kt < 1) return 'wind calm';
  const dir = Math.round(fromDeg / 10) * 10 || 360;
  const base = `wind ${String(dir).padStart(3, '0')}° ${Math.round(kt)} kt`;
  return gustKt > kt ? `${base} gusting ${Math.round(gustKt)}` : base;
}

/** A callsign with its number spoken digit by digit: "Funfair 101" → "Funfair one zero one". */
export function callsignWords(callsign: string): string {
  return callsign.replace(/\d+/g, (d) => digits(d));
}

/** A time of day, four digits: 13.08 h → "one three zero eight". */
export function timeWords(hour: number): string {
  const h = Math.floor(((hour % 24) + 24) % 24);
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  return digits(`${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`);
}

/** The ICAO spelling alphabet, for ATIS letters, taxiways and fixes. */
export const PHONETIC: Record<string, string> = {
  A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India',
  J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
  S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

/** A taxiway or position name spelled: "A4" → "Alfa four", "E2" → "Echo two". */
export function taxiwayWords(name: string): string {
  return name
    .split('')
    .map((ch) => PHONETIC[ch.toUpperCase()] ?? (ch >= '0' && ch <= '9' ? DIGIT_WORDS[ch.charCodeAt(0) - 48] : ch))
    .join(' ');
}
