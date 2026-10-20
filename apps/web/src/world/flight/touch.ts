// The A320 on a touch screen: the park's own stick (pitch and roll, the nose wheel below 40 kt;
// Input reads it), a vertical thrust lever with its detents (IDLE, CL, FLX, TOGA) that the thumb
// drags and that clicks into each detent, and the buttons a pilot needs without a keyboard: FLAPS
// − / +, GEAR, the brakes and the reversers (held), the speed brake, AP, A/THR, the camera and the
// time warp. The radio is the park's action button. It's DOM inside #touch, shown only while
// flying (body.is-piloting); the layout for phones held either way is in flight.css.

import { A320 } from '../../aviation/a320';

export type TouchCommand = 'flaps-up' | 'flaps-down' | 'gear' | 'speedbrake' | 'ap' | 'athr' | 'camera' | 'warp';

const DETENTS: { at: number; label: string }[] = [
  { at: A320.detents.idle, label: 'IDLE' },
  { at: A320.detents.cl, label: 'CL' },
  { at: A320.detents.flx, label: 'FLX' },
  { at: A320.detents.toga, label: 'TOGA' },
];
/** The lever snaps into a detent within this much of it. */
const SNAP = 0.035;

export class FlightTouch {
  readonly root: HTMLDivElement;
  /** A button tapped. */
  onCommand: ((c: TouchCommand) => void) | null = null;
  /** The lever moved by the thumb (0 IDLE .. 1 TOGA). */
  onThrust: ((v: number) => void) | null = null;
  /** Held now. */
  brake = false;
  reverse = false;
  private readonly lever: HTMLDivElement;
  private readonly handle: HTMLDivElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private shown = -1;
  private lastDetent = -1;
  /** The lit states last drawn (update's key), -1 for none yet. */
  private litKey = -1;

  constructor(touch: HTMLElement, private readonly onDetent: () => void) {
    const el = document.createElement('div');
    el.className = 'fl-touch';
    el.innerHTML = `
      <div class="fl-thrust" aria-label="Thrust levers">
        <div class="fl-thrust-track">${DETENTS.map((d) => `<i style="bottom:${d.at * 100}%"><b>${d.label}</b></i>`).join('')}<div class="fl-thrust-handle"></div></div>
      </div>
      <div class="fl-tbtns fl-tbtns-a">
        <button type="button" data-cmd="flaps-up">FLAPS −</button>
        <button type="button" data-cmd="flaps-down">FLAPS +</button>
        <button type="button" data-cmd="gear">GEAR</button>
        <button type="button" data-cmd="speedbrake">SPD BRK</button>
        <button type="button" data-hold="brake">BRK</button>
        <button type="button" data-hold="reverse">REV</button>
      </div>
      <div class="fl-tbtns fl-tbtns-b">
        <button type="button" data-cmd="ap">AP</button>
        <button type="button" data-cmd="athr">A/THR</button>
        <button type="button" data-cmd="camera">CAM</button>
        <button type="button" data-cmd="warp">×2</button>
      </div>`;
    touch.append(el);
    this.root = el;
    this.lever = el.querySelector('.fl-thrust-track') as HTMLDivElement;
    this.handle = el.querySelector('.fl-thrust-handle') as HTMLDivElement;
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      this.buttons.set(b.dataset.cmd ?? b.dataset.hold ?? '', b);
      const cmd = b.dataset.cmd as TouchCommand | undefined;
      if (cmd)
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.onCommand?.(cmd);
        });
      const hold = b.dataset.hold as 'brake' | 'reverse' | undefined;
      if (hold) {
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          b.setPointerCapture(e.pointerId);
          this[hold] = true;
          b.classList.add('is-on');
        });
        const end = () => {
          this[hold] = false;
          b.classList.remove('is-on');
        };
        b.addEventListener('pointerup', end);
        b.addEventListener('pointercancel', end);
      }
    });
    this.setupLever();
  }

  private setupLever() {
    const track = this.lever;
    let id = -1;
    const move = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      let v = 1 - (e.clientY - r.top) / Math.max(1, r.height);
      v = Math.max(0, Math.min(1, v));
      // the detents hold the lever: near one it clicks in
      let d = -1;
      for (let i = 0; i < DETENTS.length; i++)
        if (Math.abs(v - DETENTS[i].at) < SNAP) {
          v = DETENTS[i].at;
          d = i;
        }
      if (d >= 0 && d !== this.lastDetent) this.onDetent();
      this.lastDetent = d;
      this.onThrust?.(v);
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      track.setPointerCapture(id);
      move(e);
    });
    track.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
    const end = (e: PointerEvent) => {
      if (e.pointerId === id) id = -1;
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  /**
   * The lever's position as the flight has it (the keyboard and the autothrust move it too), and the
   * buttons' lit states. Called every frame: the DOM is only touched when something changed.
   */
  update(throttle: number, lit: { gear: boolean; ap: boolean; athr: boolean; speedbrake: boolean; warp: number; flaps: number }) {
    const pct = Math.round(throttle * 200) / 2;
    if (pct !== this.shown) {
      this.shown = pct;
      this.handle.style.bottom = `${pct}%`;
    }
    const key = (lit.gear ? 1 : 0) | (lit.ap ? 2 : 0) | (lit.athr ? 4 : 0) | (lit.speedbrake ? 8 : 0) | (lit.warp << 4) | (lit.flaps << 8);
    if (key === this.litKey) return;
    this.litKey = key;
    this.buttons.get('gear')?.classList.toggle('is-on', lit.gear);
    this.buttons.get('ap')?.classList.toggle('is-on', lit.ap);
    this.buttons.get('athr')?.classList.toggle('is-on', lit.athr);
    this.buttons.get('speedbrake')?.classList.toggle('is-on', lit.speedbrake);
    const warp = this.buttons.get('warp');
    if (warp) {
      warp.textContent = `×${lit.warp === 1 ? 2 : lit.warp === 2 ? 4 : 1}`;
      warp.classList.toggle('is-on', lit.warp > 1);
    }
    const fl = this.buttons.get('flaps-down');
    if (fl) fl.textContent = `FLAPS + ${['0', '1', '2', '3', 'F'][lit.flaps] ?? ''}`;
  }

  /** Lets go of everything (the round ends, or the page loses focus). */
  release() {
    this.brake = this.reverse = false;
    this.buttons.get('brake')?.classList.remove('is-on');
    this.buttons.get('reverse')?.classList.remove('is-on');
  }
}
