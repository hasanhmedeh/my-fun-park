// The visitor's hands on the A320: the keyboard map (SPEC2's sim-style keys, by physical key code),
// the touch controls (flight/touch.ts) and the cockpit's own FCU buttons, all turned into the
// FlightSim's pilot controls and the autopilot's buttons. The stick and the rudder are rate
// limited, so a keyboard's all-or-nothing keys still give the fly-by-wire a smooth input, and the
// discrete controls (flaps, gear, autobrake…) answer with a short note for the toasts, because a
// keyboard pilot can't see the lever move.

import { A320 } from '../../aviation/a320';
import type { Input } from '../input';
import type { FcuCommand, FcuKnob } from './instruments/types';
import type { FlightSim } from './sim';
import type { FlightTouch, TouchCommand } from './touch';

/** Keys the flight takes from the browser while flying (page scrolling, quick find…). */
export const CAPTURED_KEYS = [
  'PageUp',
  'PageDown',
  'Equal',
  'Minus',
  'Slash',
  'Backslash',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'KeyY',
  'KeyU',
  'KeyJ',
  'KeyR',
  'KeyF',
  'KeyV',
  'KeyG',
  'KeyB',
  'KeyO',
  'KeyP',
  'KeyL',
  'KeyK',
  'KeyT',
];

/** How fast the stick and the rudder follow the keys (full travel per second), and the thrust levers. */
const STICK_RATE = 3.2;
const STICK_RETURN = 5;
const LEVER_RATE = 0.45;
const FLAP_NAMES = ['0', '1', '2', '3', 'FULL'];
const AUTOBRAKES = ['off', 'lo', 'med', 'max'] as const;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

export class FlightControls {
  /** The FCU knob the keyboard turns (keys 1–4), highlighted on the FCU. */
  knob: FcuKnob | null = 'hdg';
  /** The clock's chronometer (s), or null when it's off. */
  chronoS: number | null = null;
  /** A note for the toasts ("Flaps 2", "Autobrake MED"). */
  onNote: ((text: string) => void) | null = null;
  /** The camera (CAM on touch) and the time warp (T, ×2 on touch): the screen handles those. */
  onCamera: (() => void) | null = null;
  onWarp: (() => void) | null = null;
  /** Whether the visitor's hands are on the controls (false while the passengers board, and in the aftermath). */
  enabled = false;

  private sim: FlightSim | null = null;
  private unsub: (() => void)[] = [];

  constructor(
    private readonly input: Input,
    private readonly touch: FlightTouch | null,
  ) {
    if (touch) {
      touch.onCommand = (c) => this.touchCommand(c);
      touch.onThrust = (v) => {
        if (this.sim && this.enabled) this.sim.pilot.throttle = v;
      };
    }
  }

  /** Takes the controls of this flight (binds the keys). */
  attach(sim: FlightSim) {
    this.detach();
    this.sim = sim;
    this.knob = 'hdg';
    this.chronoS = null;
    for (const k of CAPTURED_KEYS) this.input.capture.add(k);
    const on = (code: string, fn: (e: KeyboardEvent) => void) => this.unsub.push(this.input.onKey(code, (e) => this.enabled && this.sim && fn(e)));
    const p = () => this.sim!.pilot;
    on('KeyY', () => this.lever(A320.detents.toga, 'TOGA'));
    on('KeyU', () => this.lever(A320.detents.cl, 'CL'));
    on('KeyJ', () => this.lever(A320.detents.idle, 'IDLE'));
    on('KeyR', () => {
      // the reversers only come out with the levers at idle
      p().throttle = 0;
    });
    on('KeyF', () => this.flaps(-1));
    on('KeyV', () => this.flaps(1));
    on('KeyG', () => this.gear());
    on('KeyB', (e) => {
      if (!e.shiftKey) return;
      p().parkingBrake = !p().parkingBrake;
      this.onNote?.(p().parkingBrake ? 'Parking brake set' : 'Parking brake released');
    });
    on('Slash', (e) => {
      if (e.shiftKey) {
        p().spoilersArmed = !p().spoilersArmed;
        this.onNote?.(p().spoilersArmed ? 'Ground spoilers armed' : 'Ground spoilers disarmed');
      } else this.speedbrake();
    });
    on('KeyO', () => {
      const i = AUTOBRAKES.indexOf(p().autobrake);
      p().autobrake = AUTOBRAKES[(i + 1) % AUTOBRAKES.length];
      this.onNote?.(`Autobrake ${p().autobrake === 'off' ? 'off' : p().autobrake.toUpperCase()}`);
    });
    on('KeyP', (e) => (e.shiftKey ? this.fcu({ kind: 'athr' }) : this.fcu({ kind: 'ap' })));
    on('KeyL', () => this.fcu({ kind: 'loc' }));
    on('KeyK', () => this.fcu({ kind: 'appr' }));
    const knobs: [string, FcuKnob][] = [
      ['Digit1', 'spd'],
      ['Digit2', 'hdg'],
      ['Digit3', 'alt'],
      ['Digit4', 'vs'],
    ];
    for (const [code, knob] of knobs) on(code, () => this.fcu({ kind: 'select', knob }));
    on('BracketLeft', (e) => this.fcu({ kind: 'turn', knob: this.knob ?? 'hdg', delta: e.shiftKey ? -10 : -1 }));
    on('BracketRight', (e) => this.fcu({ kind: 'turn', knob: this.knob ?? 'hdg', delta: e.shiftKey ? 10 : 1 }));
    on('Backslash', () => this.fcu({ kind: 'push', knob: this.knob ?? 'hdg' }));
    on('Quote', () => this.fcu({ kind: 'pull', knob: this.knob ?? 'hdg' }));
    on('KeyT', () => this.onWarp?.());
  }

  /** Lets go of the keys (the round's over). */
  detach() {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    for (const k of CAPTURED_KEYS) this.input.capture.delete(k);
    this.touch?.release();
    this.sim = null;
    this.enabled = false;
  }

  /**
   * The continuous controls, every simulation step (FlightSim.step's pilotInput): the stick, the
   * rudder and the tiller, the thrust levers held up or down, the brakes and the reversers.
   */
  readonly frame = (dt: number) => {
    const sim = this.sim;
    if (!sim || !this.enabled) return;
    const c = sim.pilot;
    const s = sim.state;
    const inp = this.input;
    if (this.chronoS !== null) this.chronoS += dt;
    // stick: forward (W, ↑, the stick pushed up) is nose down; Input.steer is + to the left
    const wantPitch = -inp.throttle;
    const wantRoll = -inp.steer;
    const slow = s.onGround && s.gs < 40;
    c.pitch = toward(c.pitch, wantPitch, (wantPitch === 0 ? STICK_RETURN : STICK_RATE) * dt);
    // below 40 kt on the ground the same keys (and the stick's x) steer the nose wheel instead of rolling
    const rollTarget = slow ? 0 : wantRoll;
    c.roll = toward(c.roll, rollTarget, (rollTarget === 0 ? STICK_RETURN : STICK_RATE) * dt);
    let rud = 0;
    if (inp.held('Comma')) rud -= 1;
    if (inp.held('Period')) rud += 1;
    c.yaw = toward(c.yaw, rud, (rud === 0 ? STICK_RETURN : STICK_RATE * 0.8) * dt);
    const tiller = slow ? clamp(wantRoll + rud * 0.4, -1, 1) : 0;
    c.tiller = toward(c.tiller, tiller, (tiller === 0 ? 2.5 : 1.6) * dt);
    // thrust levers, held up or down (the detent keys jump)
    let lv = 0;
    if (inp.held('PageUp') || inp.held('Equal')) lv += 1;
    if (inp.held('PageDown') || inp.held('Minus')) lv -= 1;
    if (lv) c.throttle = clamp(c.throttle + lv * LEVER_RATE * dt, 0, 1);
    // toe brakes (B or BRK held), reversers (R or REV held, on the ground with the levers at idle)
    const brake = inp.held('KeyB') && !inp.held('ShiftLeft') && !inp.held('ShiftRight');
    const b = brake || (this.touch?.brake ?? false) ? 1 : 0;
    c.brakeL = c.brakeR = b;
    const rev = inp.held('KeyR') || (this.touch?.reverse ?? false);
    if (rev && s.onGround) c.throttle = 0;
    c.reverse = toward(c.reverse, rev && s.onGround ? 1 : 0, 2 * dt);
  };

  /** The FCU: the cockpit's buttons and knobs, and the keyboard's. */
  fcu(cmd: FcuCommand) {
    const sim = this.sim;
    if (!sim) return;
    const ap = sim.ap;
    const f = ap.fcu;
    const s = sim.state;
    switch (cmd.kind) {
      case 'ap':
        ap.toggleAp();
        break;
      case 'athr':
        ap.toggleAthr();
        break;
      case 'loc':
        ap.pushLoc();
        break;
      case 'appr':
        ap.pushAppr();
        break;
      case 'select':
        this.knob = cmd.knob;
        break;
      case 'turn': {
        this.knob = cmd.knob;
        const d = cmd.delta;
        if (cmd.knob === 'spd') ap.setSpd(clamp((f.spd ?? Math.round(ap.speedTarget || s.ias)) + d, 100, 350));
        else if (cmd.knob === 'hdg') ap.setHdg((((f.hdg + d) % 360) + 360) % 360);
        else if (cmd.knob === 'alt') ap.setAlt(f.alt + d * 100);
        else {
          // turning the V/S knob only previews the rate; in V/S it changes it
          const vs = clamp(f.vs + d * 100, -6000, 6000);
          if (f.fma.vertical === 'V/S') ap.setVs(vs);
          else f.vs = vs;
        }
        break;
      }
      case 'push':
        this.knob = cmd.knob;
        if (cmd.knob === 'spd') ap.setSpd(null);
        else if (cmd.knob === 'hdg') ap.pushHdg();
        else if (cmd.knob === 'alt') ap.pushAlt();
        else ap.setVs(0);
        break;
      case 'pull':
        this.knob = cmd.knob;
        if (cmd.knob === 'spd') ap.setSpd(f.spd ?? Math.round(s.ias));
        else if (cmd.knob === 'hdg') ap.pullHdg();
        else if (cmd.knob === 'alt') ap.pullAlt();
        else ap.setVs(f.vs);
        break;
      case 'autobrake': {
        const p = sim.pilot;
        p.autobrake = p.autobrake === cmd.mode ? 'off' : cmd.mode;
        this.onNote?.(`Autobrake ${p.autobrake === 'off' ? 'off' : p.autobrake.toUpperCase()}`);
        break;
      }
      case 'gear':
        this.gear();
        break;
      case 'chrono':
        this.chronoS = this.chronoS === null ? 0 : null;
        break;
    }
  }

  private touchCommand(c: TouchCommand) {
    if (c === 'camera') {
      this.onCamera?.();
      return;
    }
    if (!this.sim || !this.enabled) return;
    if (c === 'flaps-up') this.flaps(-1);
    else if (c === 'flaps-down') this.flaps(1);
    else if (c === 'gear') this.gear();
    else if (c === 'speedbrake') this.speedbrake();
    else if (c === 'ap') this.fcu({ kind: 'ap' });
    else if (c === 'athr') this.fcu({ kind: 'athr' });
    else if (c === 'warp') this.onWarp?.();
  }

  private lever(v: number, name: string) {
    this.sim!.pilot.throttle = v;
    this.onNote?.(`Thrust ${name}`);
  }

  private flaps(d: number) {
    const p = this.sim!.pilot;
    const next = clamp(p.flapLever + d, 0, 4);
    if (next === p.flapLever) return;
    p.flapLever = next;
    this.onNote?.(`Flaps ${FLAP_NAMES[next]}`);
  }

  private gear() {
    const sim = this.sim!;
    const p = sim.pilot;
    // the lever can't go up with weight on the wheels
    if (p.gearDown && sim.state.onGround) {
      this.onNote?.('Gear stays down on the ground');
      return;
    }
    p.gearDown = !p.gearDown;
    this.onNote?.(p.gearDown ? 'Gear down' : 'Gear up');
  }

  private speedbrake() {
    const p = this.sim!.pilot;
    p.speedbrake = p.speedbrake < 0.25 ? 0.5 : p.speedbrake < 0.75 ? 1 : 0;
    this.onNote?.(p.speedbrake === 0 ? 'Speed brake retracted' : p.speedbrake < 1 ? 'Speed brake ½' : 'Speed brake full');
  }
}
