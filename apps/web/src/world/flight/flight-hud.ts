// The flight's own HUD, around the cockpit's instruments (those are instruments/cockpit.ts): the
// radio log (the last three lines, coloured by who's talking, fading once they're old), the next
// step ("Request pushback and start-up · E"), the taxi guide (the next turn, the distance to it,
// the speed to taxi at), the toasts (penalties and bonuses as they happen, and notes such as
// "Autopilot off"), the camera's name, the desktop key help and the two toggles (the ILS guide and
// the voices). It's plain DOM inside #hud, before #panel, so the cards still sit on top of it.

import type { ScoreItem, Utterance } from '../../aviation/types';
import type { Hint } from './sim';
import type { TaxiGuideInfo } from './taxi';
import './flight.css';

/** How long a radio line stays, and how long it takes to fade (s). */
const LINE_S = 14;
const LINE_FADE_S = 3;
const TOAST_S = 3.6;
const MAX_TOASTS = 3;

const ARROW: Record<TaxiGuideInfo['turn'], string> = { left: '↰', right: '↱', straight: '↑', stop: '⛔' };

/** The keyboard, grouped the way a pilot thinks about it (the desktop help card). */
const KEY_HELP: [string, string][] = [
  ['W S · ↑ ↓', 'stick: push / pull'],
  ['A D · ← →', 'stick: roll (steer below 40 kt)'],
  [', .', 'rudder'],
  ['PgUp PgDn · = -', 'thrust levers'],
  ['Y U J', 'TOGA · CL · idle'],
  ['R (hold)', 'reverse thrust'],
  ['F V', 'flaps up · down'],
  ['G', 'gear'],
  ['B · ⇧B', 'brakes · parking brake'],
  ['/ · ⇧/', 'speed brake · arm spoilers'],
  ['O', 'autobrake'],
  ['P · ⇧P', 'autopilot · autothrust'],
  ['1 2 3 4', 'FCU: SPD HDG ALT V/S'],
  ['[ ] · \\ \'', 'turn · push · pull'],
  ['L K', 'LOC · APPR'],
  ['E', 'radio: the next request'],
  ['T', 'time warp'],
  ['C', 'camera'],
];

interface Line {
  el: HTMLLIElement;
  age: number;
}

interface Toast {
  el: HTMLDivElement;
  age: number;
}

export class FlightHud {
  readonly root: HTMLDivElement;
  /** The toggles: the screen flips them (and remembers them). */
  onIlsGuide: (() => void) | null = null;
  onVoices: (() => void) | null = null;
  onKeyHelp: (() => void) | null = null;
  private readonly radio: HTMLOListElement;
  private readonly hintEl: HTMLDivElement;
  private readonly hintText: HTMLSpanElement;
  private readonly hintKey: HTMLElement;
  private readonly progressEl: HTMLDivElement;
  private readonly taxi: HTMLDivElement;
  private readonly taxiArrow: HTMLSpanElement;
  private readonly taxiText: HTMLSpanElement;
  private readonly taxiSpeed: HTMLSpanElement;
  private readonly toasts: HTMLDivElement;
  private readonly camEl: HTMLDivElement;
  private readonly keysEl: HTMLDetailsElement;
  private readonly ilsBtn: HTMLButtonElement;
  private readonly voiceBtn: HTMLButtonElement;
  private readonly fadeEl: HTMLDivElement;
  private readonly lines: Line[] = [];
  private readonly toastList: Toast[] = [];
  /** The last text written, so a frame that changes nothing touches no DOM. */
  private lastHint = '';
  private lastKey = '';
  private lastTaxi = '';
  private lastProgress = '';

  constructor(hud: HTMLElement, mobile: boolean) {
    const el = document.createElement('div');
    el.className = 'fl-hud';
    el.hidden = true;
    el.innerHTML = `
      <div class="fl-top">
        <div class="fl-hint"><span class="fl-hint-text"></span><kbd class="fl-hint-key" hidden></kbd></div>
        <div class="fl-progress" hidden></div>
        <div class="fl-taxi" hidden><span class="fl-taxi-arrow"></span><span class="fl-taxi-text"></span><span class="fl-taxi-speed"></span></div>
        <div class="fl-toasts" aria-live="polite"></div>
      </div>
      <ol class="fl-radio" aria-live="polite"></ol>
      <div class="fl-side">
        <div class="fl-cam"></div>
        <div class="fl-tools">
          <button type="button" class="fl-tool" data-fl-ils aria-pressed="false" title="The ILS guide: boxes along the glide path on final">ILS guide</button>
          <button type="button" class="fl-tool" data-fl-voice aria-pressed="false" title="Hear the radio and the cabin (spoken aloud)">Voices</button>
        </div>
        <details class="fl-keys"${mobile ? ' hidden' : ''}><summary>Keys</summary><dl>${KEY_HELP.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></details>
      </div>
      <div class="fl-fade"></div>`;
    hud.insertBefore(el, hud.querySelector('#panel'));
    this.root = el;
    const q = <T extends Element>(s: string) => el.querySelector(s) as T;
    this.radio = q('.fl-radio');
    this.hintEl = q('.fl-hint');
    this.hintText = q('.fl-hint-text');
    this.hintKey = q('.fl-hint-key');
    this.progressEl = q('.fl-progress');
    this.taxi = q('.fl-taxi');
    this.taxiArrow = q('.fl-taxi-arrow');
    this.taxiText = q('.fl-taxi-text');
    this.taxiSpeed = q('.fl-taxi-speed');
    this.toasts = q('.fl-toasts');
    this.camEl = q('.fl-cam');
    this.keysEl = q('.fl-keys');
    this.ilsBtn = q('[data-fl-ils]');
    this.voiceBtn = q('[data-fl-voice]');
    this.fadeEl = q('.fl-fade');
    this.ilsBtn.addEventListener('click', () => this.onIlsGuide?.());
    this.voiceBtn.addEventListener('click', () => this.onVoices?.());
    this.keysEl.addEventListener('toggle', () => this.onKeyHelp?.());
  }

  show(on: boolean) {
    this.root.hidden = !on;
    if (!on) this.clear();
  }

  /** Empties the log and the toasts (a new flight). */
  clear() {
    for (const l of this.lines) l.el.remove();
    this.lines.length = 0;
    for (const t of this.toastList) t.el.remove();
    this.toastList.length = 0;
    this.lastHint = this.lastKey = this.lastTaxi = this.lastProgress = '';
    this.hintText.textContent = '';
    this.hintKey.hidden = true;
    this.taxi.hidden = true;
    this.progressEl.hidden = true;
    this.fade(false);
  }

  /** A line of radio or cabin talk, as it starts. */
  line(u: Utterance) {
    // a line cut off by a more urgent one is said again from the start: show it once, as the latest
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.el.dataset.key === `${u.from}|${u.text}`) {
        l.age = 0;
        l.el.style.opacity = '';
        this.radio.append(l.el);
        this.lines.splice(i, 1);
        this.lines.push(l);
        return;
      }
    }
    const li = document.createElement('li');
    li.dataset.key = `${u.from}|${u.text}`;
    li.className = `fl-line fl-${u.speaker}`;
    const who = document.createElement('b');
    who.textContent = u.from;
    const what = document.createElement('span');
    what.textContent = u.text;
    li.append(who, what);
    this.radio.append(li);
    this.lines.push({ el: li, age: 0 });
    while (this.lines.length > 3) this.lines.shift()!.el.remove();
  }

  /** A penalty or a bonus as it happens: "Heavy landing −10". */
  score(it: ScoreItem) {
    const pts = it.points === 0 ? '' : it.points > 0 ? ` +${it.points}` : ` −${-it.points}`;
    this.toast(`${it.label}${pts}`, it.points < 0 ? 'bad' : it.points > 0 ? 'good' : '');
  }

  /** A note: "Autopilot off", "Going around". */
  toast(text: string, kind: 'bad' | 'good' | '' = '') {
    const el = document.createElement('div');
    el.className = `fl-toast${kind ? ` is-${kind}` : ''}`;
    el.textContent = text;
    this.toasts.append(el);
    this.toastList.push({ el, age: 0 });
    while (this.toastList.length > MAX_TOASTS) this.toastList.shift()!.el.remove();
  }

  /** The next step and the key that does it (on a keyboard; touch shows only the words). */
  hint(h: Hint | null, mobile: boolean) {
    const text = h?.text ?? '';
    const key = !mobile && h?.keys ? h.keys : '';
    if (text !== this.lastHint) {
      this.lastHint = text;
      this.hintText.textContent = text;
      this.hintEl.hidden = !text;
    }
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.hintKey.textContent = key;
      this.hintKey.hidden = !key;
    }
  }

  /** The flight's progress line in the air ("FA101 · 18 NM to Palm Cay · 6 min"), or null to hide it. */
  progress(text: string | null) {
    const t = text ?? '';
    if (t === this.lastProgress) return;
    this.lastProgress = t;
    this.progressEl.textContent = t;
    this.progressEl.hidden = !t;
  }

  /** The taxi guide (null hides it). */
  taxiGuide(g: TaxiGuideInfo | null, gsKt: number) {
    if (!g || g.arrived) {
      if (this.lastTaxi) {
        this.lastTaxi = '';
        this.taxi.hidden = true;
      }
      return;
    }
    const dist = g.distM >= 1000 ? `${(g.distM / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(g.distM / 10) * 10)} m`;
    const text =
      g.turn === 'stop'
        ? `Stop at ${g.name} in ${dist}`
        : g.turn === 'straight'
          ? `Straight on`
          : `Turn ${g.turn}${g.name ? ` onto ${g.name}` : ''} in ${dist}`;
    const speed = `${Math.round(gsKt)} kt · max ${Math.round(g.adviceKt)}`;
    const key = `${g.turn}|${text}|${speed}|${g.tooFast}`;
    if (key === this.lastTaxi) return;
    this.lastTaxi = key;
    this.taxi.hidden = false;
    this.taxiArrow.textContent = ARROW[g.turn];
    this.taxiText.textContent = text;
    this.taxiSpeed.textContent = speed;
    this.taxi.classList.toggle('is-fast', g.tooFast);
  }

  camera(label: string) {
    this.camEl.textContent = `🎥 ${label}`;
  }

  /** The toggles' states. */
  toggles(ils: boolean, voices: boolean) {
    this.ilsBtn.setAttribute('aria-pressed', String(ils));
    this.voiceBtn.setAttribute('aria-pressed', String(voices));
  }

  /** The key help card's open state (remembered by the screen). */
  get keysOpen() {
    return this.keysEl.open;
  }
  set keysOpen(on: boolean) {
    this.keysEl.open = on;
  }

  /** A black fade over the view (skipping the taxi-in): on, then off a moment later. */
  fade(on: boolean) {
    this.fadeEl.classList.toggle('on', on);
  }

  /** The log's and the toasts' ageing. */
  update(dt: number) {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      l.age += dt;
      if (l.age > LINE_S) {
        const k = Math.min(1, (l.age - LINE_S) / LINE_FADE_S);
        l.el.style.opacity = String(1 - k);
        if (k >= 1) {
          l.el.remove();
          this.lines.splice(i, 1);
        }
      }
    }
    for (let i = this.toastList.length - 1; i >= 0; i--) {
      const t = this.toastList[i];
      t.age += dt;
      if (t.age > TOAST_S) {
        t.el.remove();
        this.toastList.splice(i, 1);
      }
    }
  }
}
