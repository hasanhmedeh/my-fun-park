// Tiny WebAudio synth: every sound is generated, so there are no audio files to download.
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ride: { rumble: GainNode; rumbleF: BiquadFilterNode; wind: GainNode; windF: BiquadFilterNode; whine: OscillatorNode; whineG: GainNode } | null = null;
  private drone: { props: OscillatorNode[]; propsF: BiquadFilterNode; propsG: GainNode; wash: GainNode } | null = null;
  private kart: { osc: OscillatorNode[]; filter: BiquadFilterNode; gain: GainNode; squeal: GainNode; squealF: BiquadFilterNode; rough: GainNode } | null = null;
  private lastThunk = 0;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('fair-muted') === '1';
    } catch {
      /* storage unavailable */
    }
  }

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);

    const len = this.ctx.sampleRate * 1.5;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 40;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start();
    this.engine = { osc, gain, filter };
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem('fair-muted', m ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    this.applyVolume();
  }

  /** Silences the fair for a while (an ad is playing), leaving the visitor's own mute alone. */
  hush(on: boolean) {
    this.hushed = on;
    this.applyVolume();
  }

  private hushed = false;

  private applyVolume() {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted || this.hushed ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  /** speed01: 0..1 */
  setEngine(speed01: number, active: boolean) {
    if (!this.engine || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.engine.osc.frequency.setTargetAtTime(38 + speed01 * 70, t, 0.1);
    this.engine.filter.frequency.setTargetAtTime(220 + speed01 * 500, t, 0.1);
    this.engine.gain.gain.setTargetAtTime(active ? 0.05 + speed01 * 0.07 : 0, t, 0.15);
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, delay = 0, slideTo?: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, freq: number, vol = 0.3, q = 1, delay = 0) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return null;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
    return { f, t };
  }

  /** Continuous coaster sounds: wheel rumble, wind and the launch motors' whine. */
  setCoaster(speed01: number, launching: boolean, active: boolean) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const c = this.ctx;
    if (!this.ride) {
      const mk = (type: BiquadFilterType, f: number) => {
        const src = c.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const filt = c.createBiquadFilter();
        filt.type = type;
        filt.frequency.value = f;
        const g = c.createGain();
        g.gain.value = 0;
        src.connect(filt).connect(g).connect(this.master!);
        src.start();
        return { g, filt };
      };
      const r = mk('lowpass', 180);
      const w = mk('bandpass', 900);
      const whine = c.createOscillator();
      whine.type = 'sawtooth';
      const wf = c.createBiquadFilter();
      wf.type = 'bandpass';
      wf.frequency.value = 1200;
      wf.Q.value = 3;
      const whineG = c.createGain();
      whineG.gain.value = 0;
      whine.connect(wf).connect(whineG).connect(this.master);
      whine.start();
      this.ride = { rumble: r.g, rumbleF: r.filt, wind: w.g, windF: w.filt, whine, whineG };
    }
    const t = c.currentTime;
    const k = active ? 1 : 0.35; // the ghost train is quieter
    this.ride.rumble.gain.setTargetAtTime(Math.min(0.5, speed01 * 0.55) * k, t, 0.08);
    this.ride.rumbleF.frequency.setTargetAtTime(120 + speed01 * 380, t, 0.1);
    this.ride.wind.gain.setTargetAtTime(active ? Math.pow(speed01, 2) * 0.35 : 0, t, 0.1);
    this.ride.windF.frequency.setTargetAtTime(500 + speed01 * 1800, t, 0.1);
    this.ride.whine.frequency.setTargetAtTime(220 + speed01 * 900, t, 0.05);
    this.ride.whineG.gain.setTargetAtTime(launching ? 0.09 * k : 0, t, 0.06);
  }

  /** The rental drone's rotor buzz: `spin` 0..1 is the motors' speed, `effort` 0..1 how hard they work. */
  setDrone(spin: number, effort = 0) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const c = this.ctx;
    if (!this.drone) {
      if (spin <= 0) return;
      // two slightly detuned props beat against each other, like a real quad
      const propsF = c.createBiquadFilter();
      propsF.type = 'lowpass';
      propsF.frequency.value = 900;
      const propsG = c.createGain();
      propsG.gain.value = 0;
      propsF.connect(propsG).connect(this.master);
      const props = [0, 7].map((detune) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 140 + detune;
        o.connect(propsF);
        o.start();
        return o;
      });
      const src = c.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const washF = c.createBiquadFilter();
      washF.type = 'bandpass';
      washF.frequency.value = 700;
      const wash = c.createGain();
      wash.gain.value = 0;
      src.connect(washF).connect(wash).connect(this.master);
      src.start();
      this.drone = { props, propsF, propsG, wash };
    }
    const t = c.currentTime;
    const d = this.drone;
    d.props.forEach((o, i) => o.frequency.setTargetAtTime((120 + spin * 70 + effort * 60) * (i ? 1.04 : 1), t, 0.1));
    d.propsF.frequency.setTargetAtTime(500 + spin * 700 + effort * 600, t, 0.1);
    d.propsG.gain.setTargetAtTime(spin * (0.035 + effort * 0.03), t, 0.1);
    d.wash.gain.setTargetAtTime(spin * (0.05 + effort * 0.12), t, 0.1);
  }

  /**
   * A racing kart's two-stroke buzz. `rpm` 0..1 sets the pitch, `load` 0..1 how hard the engine
   * works, `skid` 0..1 the tyre squeal and `rough` 0..1 the rumble of grass under the wheels.
   * `vol` scales it all (karts heard from the side of the track are quieter).
   */
  setKart(rpm: number, load: number, skid: number, rough: number, vol = 1) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const c = this.ctx;
    if (!this.kart) {
      if (vol <= 0) return;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600;
      filter.Q.value = 2;
      const gain = c.createGain();
      gain.gain.value = 0;
      filter.connect(gain).connect(this.master);
      // a sawtooth and a square an octave down: the raspy note of a small single-cylinder engine
      const osc = (['sawtooth', 'square'] as const).map((type) => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = 60;
        o.connect(filter);
        o.start();
        return o;
      });
      const noise = (type: BiquadFilterType, f: number, q: number) => {
        const src = c.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const filt = c.createBiquadFilter();
        filt.type = type;
        filt.frequency.value = f;
        filt.Q.value = q;
        const g = c.createGain();
        g.gain.value = 0;
        src.connect(filt).connect(g).connect(this.master!);
        src.start();
        return { g, filt };
      };
      const squeal = noise('bandpass', 2200, 8);
      const rough = noise('lowpass', 160, 0.7);
      this.kart = { osc, filter, gain, squeal: squeal.g, squealF: squeal.filt, rough: rough.g };
    }
    const t = c.currentTime;
    const k = this.kart;
    const f = 55 + rpm * 190;
    k.osc[0].frequency.setTargetAtTime(f, t, 0.05);
    k.osc[1].frequency.setTargetAtTime(f * 0.505, t, 0.05);
    k.filter.frequency.setTargetAtTime(380 + rpm * 1300 + load * 600, t, 0.08);
    k.gain.gain.setTargetAtTime(vol * (0.03 + load * 0.035 + rpm * 0.02), t, 0.08);
    k.squeal.gain.setTargetAtTime(vol * skid * 0.08, t, 0.05);
    k.squealF.frequency.setTargetAtTime(1900 + skid * 700, t, 0.1);
    k.rough.gain.setTargetAtTime(vol * rough * 0.4, t, 0.08);
  }

  /** A soft footstep on the gravel paths (heavier when running). */
  footstep(run: boolean) {
    this.noise(run ? 0.07 : 0.05, run ? 760 : 560, run ? 0.08 : 0.05, 1.3);
    this.tone(run ? 95 : 80, 0.06, 'sine', run ? 0.05 : 0.03);
  }

  /** Cloth-and-gravel swish of a dodge-roll. */
  swish() {
    const n = this.noise(0.32, 700, 0.1, 1.1);
    if (n) n.f.frequency.exponentialRampToValueAtTime(260, n.t + 0.3);
  }

  /** A friendly two-note whistle, to go with a wave. */
  whistle() {
    this.tone(1250, 0.16, 'sine', 0.1, 0, 1750);
    this.tone(1750, 0.28, 'sine', 0.1, 0.2, 1150);
  }

  thunk(strength: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastThunk < 0.08) return;
    this.lastThunk = now;
    const v = Math.min(0.35, strength * 0.05);
    this.tone(90 + Math.random() * 40, 0.18, 'triangle', v);
    this.noise(0.08, 900, v * 0.6, 2);
  }

  ding() {
    [0, 0.002].forEach((d, i) => this.tone(1320 * (i ? 2.01 : 1), 1.6, 'sine', 0.25, d));
    this.tone(1980, 1.2, 'sine', 0.08);
  }

  whack() {
    this.noise(0.15, 300, 0.5, 1.5);
    this.tone(70, 0.25, 'triangle', 0.4);
  }

  beep(high = false) {
    this.tone(high ? 880 : 520, high ? 0.5 : 0.18, 'square', 0.1);
  }

  rumble(dur: number) {
    const n = this.noise(dur, 120, 0.5, 0.6);
    if (n) n.f.frequency.exponentialRampToValueAtTime(600, n.t + dur);
  }

  whoosh() {
    const n = this.noise(1.1, 400, 0.25, 1.2);
    if (n) n.f.frequency.exponentialRampToValueAtTime(2400, n.t + 1);
  }

  clack() {
    this.noise(0.03, 2500, 0.08, 4);
  }

  pop() {
    this.tone(600, 0.12, 'sine', 0.2, 0, 1200);
  }

  /** The Duck Shoot's cork gun going off: a sharp pop of air. */
  cork() {
    this.noise(0.06, 1800, 0.35, 1.4);
    this.tone(320, 0.07, 'triangle', 0.18, 0, 140);
  }

  /** A cork striking a tin duck (higher for the golden one). */
  ting(gold = false) {
    const f = gold ? 2350 : 1760;
    this.tone(f, 0.35, 'sine', 0.16, 0.01);
    this.tone(f * 2.76, 0.18, 'sine', 0.05, 0.01);
    this.noise(0.04, 3200, 0.06, 3, 0.01);
  }

  chime() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.12, i * 0.09));
  }
}
