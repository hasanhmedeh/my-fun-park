// The flight deck the visitor flies from: a full-screen layer over the 3D view with the A320's
// windscreen structure (frame.ts), the glareshield with the FCU and the master lights, and the main
// panel below with the captain's PFD and ND, the standby instrument, the gear lever, autobrake and
// clock, and the upper ECAM. From the outside cameras it shrinks to a compact, collapsible strip
// (a small PFD and ND and the key numbers) in the bottom-left corner.
//
// The layout is CSS (cockpit.css): the outside view keeps the upper ~55 % on a desktop; a phone
// held sideways gets PFD + ND only under a narrower glareshield; a phone held upright, PFD and ND
// stacked at the bottom. The displays redraw on their own clocks (PFD 30 Hz, ND and EWD 10 Hz,
// standby 15 Hz) once the cockpit font has loaded, and only when they're on screen.

import '../cockpit.css';
import type { Ctx } from '../../context';
import { cockpitFontReady } from './display';
import { Ewd } from './ewd';
import { FcuPanel } from './fcu';
import { WindshieldFrame, type FrameColours } from './frame';
import { Nd } from './nd';
import { Pfd } from './pfd';
import { Standby } from './standby';
import type { CockpitData, FcuCommand } from './types';

export type CockpitView = 'cockpit' | 'outside' | 'hidden';

const STRIP_KEY = 'funfair.cockpit.strip';
/** The compact strip's numbers refresh at this rate (Hz). */
const STRIP_HZ = 5;

/** Day and night colours of the flight deck (Airbus blue-grey panels; integral lighting at night). */
const DAY = { structure: '#4a545d', shade: '#2c3238', rim: '#7f8a94', overhead: '#56616b', door: '#3d464f', panel: '#47515a', glare: '#1e2226', label: '#eef1f4' };
const NIGHT = { structure: '#161a1e', shade: '#0a0c0e', rim: '#2a3137', overhead: '#1b2025', door: '#121518', panel: '#14181c', glare: '#0b0d0f', label: '#d8cdb4' };

function mix(a: string, b: string, k: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

const div = (cls: string) => {
  const e = document.createElement('div');
  e.className = cls;
  return e;
};

export class Cockpit {
  onFcu: ((c: FcuCommand) => void) | null = null;

  private readonly ctx: Ctx;
  private readonly mount: HTMLElement;
  private readonly root: HTMLElement;
  private readonly deckView: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly stripData: HTMLElement;
  private readonly slots: Record<'pfd' | 'nd' | 'ewd' | 'isis' | 'spfd' | 'snd', HTMLElement>;
  private readonly frame: WindshieldFrame;
  private readonly pfd = new Pfd('ck-canvas', 30);
  private readonly nd = new Nd('ck-canvas', 10);
  private readonly ewd = new Ewd('ck-canvas', 10);
  private readonly isis = new Standby('ck-canvas', 15);
  private readonly fcu = new FcuPanel();
  private view: CockpitView = 'hidden';
  private ready = false;
  private t = 0;
  private night = -1;
  private colours: FrameColours = { ...DAY };
  private stripClock = 0;
  private collapsed: boolean;
  private last: CockpitData | null = null;
  private readonly stripCells: Record<'n1' | 'flaps' | 'gear' | 'sb' | 'modes' | 'ab', HTMLElement>;

  constructor(ctx: Ctx, mount: HTMLElement) {
    this.ctx = ctx;
    this.mount = mount;
    mount.classList.add('ck-host');
    this.root = div('ck-root');
    this.root.hidden = true;

    // ---------------------------------------------------------------- the flight deck
    this.deckView = div('ck-cockpit');
    this.frame = new WindshieldFrame('ck-frame');
    const deck = div('ck-deck');
    const panel = div('ck-panel');
    const slot = (cls: string) => div(`ck-du ${cls}`);
    this.slots = {
      pfd: slot('ck-du-pfd'),
      nd: slot('ck-du-nd'),
      ewd: slot('ck-du-ewd'),
      isis: slot('ck-du-isis'),
      spfd: slot('ck-du-s'),
      snd: slot('ck-du-s'),
    };
    const col = div('ck-col');
    col.append(this.slots.isis, this.fcu.centre);
    panel.append(this.slots.pfd, this.slots.nd, col, this.slots.ewd);
    deck.append(this.fcu.glare, panel);
    this.deckView.append(this.frame.canvas, deck);

    // the ND's range steps with a click; the small button beside it switches ARC / ROSE
    for (const s of [this.slots.nd, this.slots.snd]) {
      s.classList.add('ck-du-click');
      s.title = 'Click: ND range';
      s.addEventListener('click', () => this.nd.cycleRange());
      const mode = document.createElement('button');
      mode.type = 'button';
      mode.className = 'ck-ndmode';
      mode.textContent = 'ARC/ROSE';
      mode.addEventListener('pointerdown', (e) => e.preventDefault());
      mode.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.last) this.nd.toggleMode(this.nd.mode(this.last));
      });
      s.append(mode);
    }

    // ---------------------------------------------------------------- the outside views' strip
    this.strip = div('ck-strip');
    let collapsed = ctx.mobile;
    try {
      const saved = localStorage.getItem(STRIP_KEY);
      if (saved !== null) collapsed = saved === '1';
    } catch {
      /* storage blocked: keep the default */
    }
    this.collapsed = collapsed;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'ck-strip-tab';
    tab.innerHTML = '<span>Instruments</span><i></i>';
    tab.addEventListener('pointerdown', (e) => e.preventDefault());
    tab.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    const body = div('ck-strip-body');
    this.stripData = document.createElement('dl');
    this.stripData.className = 'ck-strip-data';
    const cell = (label: string) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      this.stripData.append(dt, dd);
      return dd;
    };
    this.stripCells = { n1: cell('N1'), flaps: cell('FLAPS'), gear: cell('GEAR'), sb: cell('SPD BRK'), ab: cell('A/BRK'), modes: cell('AP') };
    body.append(this.slots.spfd, this.slots.snd, this.stripData);
    this.strip.append(tab, body);
    this.strip.classList.toggle('collapsed', this.collapsed);

    this.root.append(this.deckView, this.strip);
    mount.append(this.root);

    this.fcu.onCommand = (c) => this.onFcu?.(c);
    void cockpitFontReady().then(() => {
      this.ready = true;
      this.invalidate();
    });
  }

  /** The cockpit view, the outside views' strip, or nothing. */
  setView(v: CockpitView) {
    if (v === this.view) return;
    this.view = v;
    this.root.hidden = v === 'hidden';
    this.root.dataset.view = v;
    this.deckView.hidden = v !== 'cockpit';
    this.strip.hidden = v !== 'outside';
    if (v !== 'cockpit') this.fcu.closePop();
    // one PFD and one ND, moved to wherever they're shown
    if (v === 'cockpit') {
      this.slots.pfd.prepend(this.pfd.display.canvas);
      this.slots.nd.prepend(this.nd.display.canvas);
      this.slots.ewd.prepend(this.ewd.display.canvas);
      this.slots.isis.prepend(this.isis.display.canvas);
    } else if (v === 'outside') {
      this.slots.spfd.prepend(this.pfd.display.canvas);
      this.slots.snd.prepend(this.nd.display.canvas);
    }
    this.invalidate();
  }

  update(dt: number, d: CockpitData) {
    this.last = d;
    if (this.view === 'hidden') return;
    this.t += dt;
    this.setNight(d.night);
    if (this.ready) {
      this.pfd.update(dt, d);
      this.nd.update(dt, d);
      if (this.view === 'cockpit') {
        this.ewd.update(dt, d);
        this.isis.update(dt, d);
      }
    }
    if (this.view === 'cockpit') {
      this.frame.update(this.ctx.camera, d.s.quat, this.colours);
      this.fcu.update(dt, d, this.t);
    } else {
      this.stripClock += dt;
      if (this.stripClock >= 1 / STRIP_HZ && !this.collapsed) {
        this.stripClock = 0;
        this.updateStrip(d);
      }
    }
  }

  dispose() {
    this.pfd.dispose();
    this.nd.dispose();
    this.ewd.dispose();
    this.isis.dispose();
    this.frame.dispose();
    this.fcu.dispose();
    this.root.remove();
    this.mount.classList.remove('ck-host');
  }

  // ---------------------------------------------------------------------------------------------- internals

  private invalidate() {
    this.pfd.display.invalidate();
    this.nd.display.invalidate();
    this.ewd.display.invalidate();
    this.isis.display.invalidate();
    this.stripClock = 1;
  }

  private setCollapsed(on: boolean) {
    this.collapsed = on;
    this.strip.classList.toggle('collapsed', on);
    try {
      localStorage.setItem(STRIP_KEY, on ? '1' : '0');
    } catch {
      /* storage blocked: it just won't be remembered */
    }
    this.invalidate();
  }

  /** The deck's lighting: blue-grey by day, dark with warm integral lighting and glowing screens at night. */
  private setNight(k: number) {
    const n = Math.round(Math.max(0, Math.min(1, k)) * 20) / 20;
    if (n === this.night) return;
    this.night = n;
    const c = {} as Record<keyof typeof DAY, string>;
    for (const key of Object.keys(DAY) as (keyof typeof DAY)[]) c[key] = mix(DAY[key], NIGHT[key], n);
    this.colours = { structure: c.structure, shade: c.shade, rim: c.rim, overhead: c.overhead, door: c.door };
    const st = this.root.style;
    st.setProperty('--ck-panel', c.panel);
    st.setProperty('--ck-glare', c.glare);
    st.setProperty('--ck-label', c.label);
    st.setProperty('--ck-glow', String(n));
  }

  private updateStrip(d: CockpitData) {
    const { s, fcu } = d;
    const c = this.stripCells;
    const set = (e: HTMLElement, v: string) => {
      if (e.textContent !== v) e.textContent = v;
    };
    set(c.n1, `${(s.n1[0] * 100).toFixed(1)} · ${(s.n1[1] * 100).toFixed(1)}`);
    set(c.flaps, ['0', '1', '1+F', '2', '3', 'FULL'][s.config] ?? '0');
    set(c.gear, s.gear > 0.99 ? 'DOWN' : s.gear < 0.01 ? 'UP' : 'TRANSIT');
    c.gear.className = s.gear > 0.99 ? 'g' : s.gear < 0.01 ? '' : 'r';
    set(c.sb, s.spoilers > 0.05 ? `${Math.round(s.spoilers * 100)} %` : d.controls?.spoilersArmed ? 'ARMED' : 'RET');
    set(c.ab, (d.controls?.autobrake ?? 'off').toUpperCase());
    const modes = [fcu.ap ? 'AP1' : '', fcu.athr ? 'A/THR' : ''].filter(Boolean).join(' ');
    set(c.modes, modes || 'OFF');
    c.modes.className = fcu.ap ? 'g' : '';
  }
}

export type { CockpitData, FcuCommand, FcuKnob, TrafficContact } from './types';
