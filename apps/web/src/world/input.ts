// Keyboard + touch joystick, normalised into one input state.
export class Input {
  throttle = 0; // -1..1
  steer = 0; // -1..1 (positive = left)
  boost = false;
  lift = 0; // -1..1: climb / descend (the drone)
  private touchLift = 0;
  private keys = new Set<string>();
  private stick = { x: 0, y: 0, active: false };
  private handlers: Record<string, (() => void)[]> = {};
  private _paused = false;
  private keyHandlers = new Map<string, ((e: KeyboardEvent) => void)[]>();
  /**
   * Extra key codes whose browser default is cancelled (PageUp, '/', the quote key...). The flight fills this on
   * entry and clears it on exit, so page scrolling and quick-find behave as usual everywhere else.
   */
  readonly capture = new Set<string>();

  constructor(private touchEls: { stick: HTMLElement; knob: HTMLElement; action: HTMLElement; lift: HTMLElement }) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.setupStick();
    touchEls.action.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.emit('action');
    });
    // the drone's ▲ / ▼ buttons: held down to climb or descend
    touchEls.lift.querySelectorAll<HTMLElement>('[data-lift]').forEach((b) => {
      const dir = Number(b.dataset.lift);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.touchLift = dir;
      });
      const end = () => this.touchLift === dir && (this.touchLift = 0);
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
    });
  }

  /** While paused (e.g. the park map is open) the game ignores the keyboard. */
  get paused() {
    return this._paused;
  }
  set paused(v: boolean) {
    this._paused = v;
    if (v) this.keys.clear();
  }

  on(evt: 'action' | 'roll' | 'kick' | 'reset' | 'restart' | 'honk' | 'escape' | 'camera' | 'info' | 'any', fn: () => void) {
    (this.handlers[evt] ??= []).push(fn);
  }

  /** Whether a physical key (KeyboardEvent.code) is held right now; always false while paused. */
  held(code: string): boolean {
    return this.keys.has(code);
  }

  /**
   * Calls fn on the first press of a physical key (never on auto-repeat), behind the same filters as the named
   * events: nothing while paused, typing into a form field or using a dialog. Returns a function that unsubscribes.
   */
  onKey(code: string, fn: (e: KeyboardEvent) => void): () => void {
    let list = this.keyHandlers.get(code);
    if (!list) this.keyHandlers.set(code, (list = []));
    const own = list;
    own.push(fn);
    return () => {
      const i = own.indexOf(fn);
      if (i >= 0) own.splice(i, 1);
    };
  }

  private emit(evt: string) {
    this.handlers[evt]?.forEach((f) => f());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this._paused) return;
    const target = e.target as HTMLElement;
    // typing into a form field, or using the time panel, a dialog (sign up) or the booth's shop, isn't playing the game
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest?.('.time-panel, #clock, dialog, .shop'))) return;
    const driving = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
    if (driving.includes(e.code) || this.capture.has(e.code)) e.preventDefault();
    if (e.repeat) {
      this.keys.add(e.code);
      return;
    }
    this.keys.add(e.code);
    this.emit('any');
    if (e.code === 'KeyE' || e.code === 'Enter') {
      // Enter on a focused button should press the button, not the game.
      if (e.code === 'Enter' && target?.tagName === 'BUTTON') return;
      this.emit('action');
    }
    if (e.code === 'Space') this.emit('roll');
    if (e.code === 'KeyF') this.emit('kick');
    if (e.code === 'KeyR') this.emit('reset');
    if (e.code === 'KeyT') this.emit('restart');
    if (e.code === 'KeyH') this.emit('honk');
    if (e.code === 'KeyC') this.emit('camera');
    if (e.code === 'Escape') {
      // Esc may open "leave early?" (a modal <dialog>): left uncancelled, this same key press would close it straight away
      e.preventDefault();
      this.emit('escape');
    }
    if (e.code === 'KeyI') this.emit('info');
    this.keyHandlers.get(e.code)?.forEach((f) => f(e));
  };

  private setupStick() {
    const { stick, knob } = this.touchEls;
    let id = -1;
    const move = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      const max = r.width / 2;
      let x = e.clientX - (r.left + max);
      let y = e.clientY - (r.top + max);
      const len = Math.hypot(x, y);
      if (len > max) {
        x = (x / len) * max;
        y = (y / len) * max;
      }
      knob.style.transform = `translate(${x}px, ${y}px)`;
      this.stick.x = x / max;
      this.stick.y = y / max;
    };
    stick.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      stick.setPointerCapture(id);
      this.stick.active = true;
      move(e);
      this.emit('any');
    });
    stick.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      this.stick = { x: 0, y: 0, active: false };
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
  }

  update() {
    const k = this.keys;
    let t = 0;
    let s = 0;
    if (k.has('KeyW') || k.has('KeyZ') || k.has('ArrowUp')) t += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) t -= 1;
    if (k.has('KeyA') || k.has('KeyQ') || k.has('ArrowLeft')) s += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s -= 1;
    this.boost = k.has('ShiftLeft') || k.has('ShiftRight');
    let l = 0;
    if (k.has('Space') || k.has('PageUp')) l += 1;
    if (k.has('KeyX') || k.has('PageDown')) l -= 1;
    this.lift = this.touchLift || l;

    if (this.stick.active) {
      // Up = throttle, sideways = steer (behaves like the keyboard).
      const mag = Math.hypot(this.stick.x, this.stick.y);
      t = mag > 0.15 ? -this.stick.y : 0;
      s = Math.abs(this.stick.x) > 0.15 ? -this.stick.x : 0;
      this.boost = mag > 0.95;
    }
    this.throttle = t;
    this.steer = s;
  }

  get pressingAny() {
    return this.keys.size > 0 || this.stick.active;
  }
}
