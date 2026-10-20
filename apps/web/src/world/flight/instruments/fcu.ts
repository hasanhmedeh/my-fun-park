// The glareshield's Flight Control Unit and the centre panel's switches, as DOM the visitor can
// click or tap: the SPD, HDG, ALT and V/S windows with their managed dots (a window opens a little
// knob for turning, pushing and pulling it; the mouse wheel turns it too), the LOC, AP1, A/THR and
// APPR pushbuttons with their green bars, the master warning and caution lights, the landing gear
// lever and its three green arrows, the autobrake buttons, the brake pressure gauge and the clock.

import { lateralManaged, pad } from './display';
import type { CockpitData, FcuCommand, FcuKnob } from './types';

/** The knob's popover closes on its own after this long untouched (s). */
const POP_IDLE_S = 6;
/** Hold-to-repeat for the knob buttons (ms). */
const REPEAT_DELAY = 380;
const REPEAT_EVERY = 85;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

/** Sets a node's text only when it changed (no layout work for the 99 % of frames where nothing did). */
function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}
function setOn(e: HTMLElement, cls: string, on: boolean) {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

export class FcuPanel {
  /** The glareshield strip (FCU and master lights) and the centre panel's switches. */
  readonly glare: HTMLElement;
  readonly centre: HTMLElement;
  onCommand: ((c: FcuCommand) => void) | null = null;

  private readonly windows = new Map<FcuKnob, { root: HTMLElement; value: HTMLElement; dot: HTMLElement }>();
  private readonly buttons = new Map<'loc' | 'ap' | 'athr' | 'appr', HTMLElement>();
  private readonly pop: HTMLElement;
  private popKnob: FcuKnob | null = null;
  private popIdle = 0;
  private selected: FcuKnob | null = null;
  private readonly mw: HTMLElement;
  private readonly mc: HTMLElement;
  private readonly gear: HTMLElement[] = [];
  private readonly gearLever: HTMLElement;
  private readonly autobrake = new Map<'lo' | 'med' | 'max', HTMLElement>();
  private readonly brakeL: HTMLElement;
  private readonly brakeR: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly chrono: HTMLElement;
  private readonly flapLever: HTMLElement;
  private readonly parkBrake: HTMLElement;
  private repeat = 0;
  private repeatStart = 0;

  constructor() {
    // ---------------------------------------------------------------- the glareshield
    this.glare = el('div', 'ck-glare');
    const lights = el('div', 'ck-masters');
    this.mw = el('div', 'ck-master ck-master-w', '<b>MASTER</b><b>WARN</b>');
    this.mc = el('div', 'ck-master ck-master-c', '<b>MASTER</b><b>CAUT</b>');
    lights.append(this.mw, this.mc);
    const fcu = el('div', 'ck-fcu');
    const knob = (k: FcuKnob, label: string) => {
      const root = el('button', 'ck-knob');
      root.type = 'button';
      root.dataset.knob = k;
      root.title = `${label}: click to turn, push or pull (wheel turns, Shift ×10)`;
      const lab = el('span', 'ck-klabel', label);
      const win = el('span', 'ck-win');
      const value = el('span', 'ck-kval');
      const dot = el('i', 'ck-dot');
      win.append(value, dot);
      root.append(lab, win);
      this.windows.set(k, { root, value, dot });
      root.addEventListener('pointerdown', (e) => e.preventDefault());
      root.addEventListener('click', () => this.openPop(k));
      root.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          this.send({ kind: 'turn', knob: k, delta: (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1) });
          this.popIdle = 0;
        },
        { passive: false },
      );
      return root;
    };
    const button = (k: 'loc' | 'ap' | 'athr' | 'appr', label: string) => {
      const b = el('button', 'ck-pb', `<span>${label}</span><i></i>`);
      b.type = 'button';
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.send({ kind: k }));
      this.buttons.set(k, b);
      return b;
    };
    const mid = el('div', 'ck-fcu-mid');
    mid.append(button('ap', 'AP1'), button('athr', 'A/THR'));
    fcu.append(knob('spd', 'SPD'), knob('hdg', 'HDG'), button('loc', 'LOC'), mid, knob('alt', 'ALT'), knob('vs', 'V/S'), button('appr', 'APPR'));
    // the knob popover: turn by one or ten clicks, push for managed, pull for selected
    this.pop = el('div', 'ck-pop');
    this.pop.hidden = true;
    const popBtn = (label: string, title: string, act: () => void, repeat = false) => {
      const b = el('button', 'ck-popb', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        act();
        this.popIdle = 0;
        if (repeat) {
          this.repeatStart = performance.now();
          window.clearInterval(this.repeat);
          this.repeat = window.setInterval(() => {
            if (performance.now() - this.repeatStart > REPEAT_DELAY) act();
          }, REPEAT_EVERY);
        }
      });
      const stop = () => window.clearInterval(this.repeat);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('pointerleave', stop);
      return b;
    };
    const turn = (n: number) => () => this.popKnob && this.send({ kind: 'turn', knob: this.popKnob, delta: n });
    this.pop.append(
      popBtn('−10', 'Turn ten clicks down', turn(-10), true),
      popBtn('−', 'Turn one click down', turn(-1), true),
      popBtn('+', 'Turn one click up', turn(1), true),
      popBtn('+10', 'Turn ten clicks up', turn(10), true),
      popBtn('PUSH', 'Push: managed', () => this.popKnob && this.send({ kind: 'push', knob: this.popKnob })),
      popBtn('PULL', 'Pull: selected', () => this.popKnob && this.send({ kind: 'pull', knob: this.popKnob })),
    );
    fcu.append(this.pop);
    this.glare.append(lights, fcu);

    // ---------------------------------------------------------------- the centre panel
    this.centre = el('div', 'ck-centre');
    const gearBox = el('div', 'ck-gear');
    gearBox.append(el('span', 'ck-plabel', 'LDG GEAR'));
    const arrows = el('div', 'ck-gear-arrows');
    for (let i = 0; i < 3; i++) {
      const a = el('span', 'ck-garrow', '<b>▽</b><em>UNLK</em>');
      this.gear.push(a);
      arrows.append(a);
    }
    gearBox.append(arrows);
    this.gearLever = el('button', 'ck-lever', '<span>GEAR</span><i></i>');
    (this.gearLever as HTMLButtonElement).type = 'button';
    this.gearLever.title = 'Landing gear lever (G)';
    this.gearLever.addEventListener('pointerdown', (e) => e.preventDefault());
    this.gearLever.addEventListener('click', () => this.send({ kind: 'gear' }));
    gearBox.append(this.gearLever);

    const ab = el('div', 'ck-abrk');
    ab.append(el('span', 'ck-plabel', 'AUTO/BRK'));
    const abRow = el('div', 'ck-abrk-row');
    for (const mode of ['lo', 'med', 'max'] as const) {
      const b = el('button', 'ck-abb', `<em>DECEL</em><span>${mode.toUpperCase()}</span><i>ON</i>`);
      (b as HTMLButtonElement).type = 'button';
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.send({ kind: 'autobrake', mode }));
      this.autobrake.set(mode, b);
      abRow.append(b);
    }
    ab.append(abRow);

    const misc = el('div', 'ck-misc');
    const brk = el('div', 'ck-brk');
    brk.append(el('span', 'ck-plabel', 'BRAKES'));
    const bars = el('div', 'ck-brk-bars');
    this.brakeL = el('i', '');
    this.brakeR = el('i', '');
    const bl = el('span', 'ck-brk-bar');
    bl.append(this.brakeL);
    const br = el('span', 'ck-brk-bar');
    br.append(this.brakeR);
    bars.append(bl, br);
    brk.append(bars);
    this.parkBrake = el('span', 'ck-park', 'PARK BRK');
    brk.append(this.parkBrake);
    this.flapLever = el('span', 'ck-flaplvr', 'FLAPS 0');
    misc.append(brk, this.flapLever);

    const clk = el('div', 'ck-clock');
    this.clock = el('span', 'ck-utc', '--:--');
    this.chrono = el('span', 'ck-chr', '');
    const chrBtn = el('button', 'ck-chrb', 'CHR');
    (chrBtn as HTMLButtonElement).type = 'button';
    chrBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    chrBtn.addEventListener('click', () => this.send({ kind: 'chrono' }));
    clk.append(el('span', 'ck-plabel', 'UTC'), this.clock, chrBtn, this.chrono);

    this.centre.append(gearBox, ab, misc, clk);

    document.addEventListener('pointerdown', this.onDocDown, true);
  }

  /** Refresh every window, light and indicator from the data (cheap: text only changes when it differs). */
  update(dt: number, d: CockpitData, t: number) {
    const { fcu, s } = d;
    const fma = fcu.fma;
    if (this.popKnob) {
      this.popIdle += dt;
      if (this.popIdle > POP_IDLE_S) this.closePop();
    }
    this.selected = d.knob === undefined ? this.selected : d.knob;
    // SPD: dashes and the managed dot when the FMS flies the speed
    const spd = this.windows.get('spd')!;
    setText(spd.value, fcu.spd === null ? '---' : pad(fcu.spd, 3));
    setOn(spd.dot, 'on', fcu.spd === null);
    // HDG: dashes in NAV and on the localizer
    const hdg = this.windows.get('hdg')!;
    const managedLat = lateralManaged(fma);
    setText(hdg.value, managedLat ? '---' : pad(fcu.hdg, 3));
    setOn(hdg.dot, 'on', managedLat);
    // ALT: always the value; the dot in a managed climb or descent
    const alt = this.windows.get('alt')!;
    setText(alt.value, pad(fcu.alt, 5));
    setOn(alt.dot, 'on', fma.vertical === 'CLB' || fma.vertical === 'DES' || fma.armedVertical === 'CLB');
    // V/S: dashes until V/S is engaged, then "+15oo" the way the FCU writes hundreds
    const vs = this.windows.get('vs')!;
    setText(vs.value, fma.vertical === 'V/S' ? `${fcu.vs >= 0 ? '+' : '−'}${pad(Math.abs(fcu.vs) / 100, 2)}oo` : '-----');
    setOn(vs.dot, 'on', false);
    for (const [k, w] of this.windows) setOn(w.root, 'sel', k === this.selected || k === this.popKnob);
    setOn(this.buttons.get('ap')!, 'on', fcu.ap);
    setOn(this.buttons.get('athr')!, 'on', fcu.athr);
    setOn(this.buttons.get('loc')!, 'on', fcu.loc || (!fcu.appr && (fma.lateral === 'LOC' || fma.lateral === 'LOC*')));
    setOn(this.buttons.get('appr')!, 'on', fcu.appr);
    // the master lights flash
    const flash = t % 0.8 < 0.5;
    setOn(this.mw, 'on', !!d.masterWarning && flash);
    setOn(this.mc, 'on', !!d.masterCaution);
    // three green arrows down and locked, red UNLK in transit, dark when up
    const g = s.gear;
    for (const a of this.gear) {
      setOn(a, 'down', g > 0.99);
      setOn(a, 'unlk', g > 0.01 && g <= 0.99);
    }
    const lever = d.controls?.gearDown ?? g > 0.5;
    setOn(this.gearLever, 'down', lever);
    // autobrake: the blue ON of the selected mode, green DECEL while it brakes
    const mode = d.controls?.autobrake ?? 'off';
    const decel = !!d.sys?.autobrakeActive;
    for (const [m, b] of this.autobrake) {
      setOn(b, 'on', mode === m);
      setOn(b, 'decel', mode === m && decel);
    }
    const brakes = d.sys?.brakes ?? [0, 0];
    const parked = !!d.controls?.parkingBrake;
    const pl = `${Math.round((parked ? 0.7 : brakes[0]) * 100)}%`;
    const pr = `${Math.round((parked ? 0.7 : brakes[1]) * 100)}%`;
    if (this.brakeL.style.height !== pl) this.brakeL.style.height = pl;
    if (this.brakeR.style.height !== pr) this.brakeR.style.height = pr;
    setOn(this.parkBrake, 'on', parked);
    const fl = d.controls?.flapLever;
    setText(this.flapLever, `FLAPS ${fl === undefined ? '-' : ['0', '1', '2', '3', 'FULL'][fl]}`);
    setText(this.clock, d.utc);
    setText(this.chrono, d.chronoS === null ? '' : `${pad(Math.floor(d.chronoS / 60) % 100, 2)}:${pad(Math.floor(d.chronoS % 60), 2)}`);
  }

  dispose() {
    window.clearInterval(this.repeat);
    document.removeEventListener('pointerdown', this.onDocDown, true);
    this.glare.remove();
    this.centre.remove();
  }

  closePop() {
    this.popKnob = null;
    this.pop.hidden = true;
  }

  private openPop(k: FcuKnob) {
    this.send({ kind: 'select', knob: k });
    if (this.popKnob === k) {
      this.closePop();
      return;
    }
    this.popKnob = k;
    this.popIdle = 0;
    this.pop.hidden = false;
    // under its window
    const w = this.windows.get(k)!.root;
    this.pop.style.left = `${w.offsetLeft + w.offsetWidth / 2}px`;
  }

  private readonly onDocDown = (e: PointerEvent) => {
    if (!this.popKnob) return;
    const target = e.target as Node;
    if (this.pop.contains(target) || this.windows.get(this.popKnob)!.root.contains(target)) return;
    this.closePop();
  };

  private send(c: FcuCommand) {
    this.onCommand?.(c);
  }
}

