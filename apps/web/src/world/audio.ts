// Tiny WebAudio synth: every sound is generated, so there are no audio files to download.
import { KT } from './geo';

/** A looping noise source through a filter and a gain (a continuous voice's building block). */
interface NoiseVoice {
  filt: BiquadFilterNode;
  g: GainNode;
}
/** An oscillator through an optional filter and a gain. */
interface OscVoice {
  o: OscillatorNode;
  g: GainNode;
  filt: BiquadFilterNode | null;
}
/** The player's A320neo: both engines, airflow, the gear, spoilers and the motors. */
interface JetVoices {
  bus: GainNode;
  cabin: BiquadFilterNode;
  engineMix: GainNode;
  engines: { saw: OscVoice; tone: OscVoice; whine: OscVoice }[];
  roar: NoiseVoice;
  rumble: NoiseVoice;
  reverse: NoiseVoice;
  air: NoiseVoice;
  gearAir: NoiseVoice;
  roll: NoiseVoice;
  spoil: NoiseVoice;
  flapMotor: OscVoice;
  gearMotor: OscVoice;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ride: { rumble: GainNode; rumbleF: BiquadFilterNode; wind: GainNode; windF: BiquadFilterNode; whine: OscillatorNode; whineG: GainNode } | null = null;
  private drone: { props: OscillatorNode[]; propsF: BiquadFilterNode; propsG: GainNode; wash: GainNode } | null = null;
  private kart: { osc: OscillatorNode[]; filter: BiquadFilterNode; gain: GainNode; squeal: GainNode; squealF: BiquadFilterNode; rough: GainNode } | null = null;
  private lastThunk = 0;
  // Funfair Air and Palm Cay (built lazily, parked at gain 0 when idle)
  private longNoise: AudioBuffer | null = null;
  private jet: JetVoices | null = null;
  private aircraftOn = false;
  private lastAircraftT = 0;
  private rollDist = 0;
  private ptuLeft = 0;
  private ptuDone = 0;
  private ptuClock = 0;
  private crc: GainNode | null = null;
  private clacker: GainNode | null = null;
  private cricket: GainNode | null = null;
  private hiss: NoiseVoice | null = null;
  private trafficVoice: { roar: NoiseVoice; whine: OscVoice; buzz: OscVoice } | null = null;
  private sea: { waves: NoiseVoice; surf: NoiseVoice } | null = null;
  private nextGull = 0;
  private boat: { osc: OscVoice[]; filter: BiquadFilterNode; gain: GainNode; spray: NoiseVoice; slap: NoiseVoice } | null = null;
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
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
    // speech synthesis doesn't go through the master gain, so it's stopped here (see aviation/speech.ts)
    if (m && typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
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

  // ----------------------------------------------------------------------------------------------
  // Funfair Air: the A320neo, its cockpit tones and radio, AI jets, the sea and the island games
  // ----------------------------------------------------------------------------------------------

  /** Nine seconds of pink noise for long, exposed ambience (the 1.5 s white loop would audibly repeat). */
  private get ambience(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (!this.longNoise) {
      const len = Math.floor(this.ctx.sampleRate * 9);
      this.longNoise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.longNoise.getChannelData(0);
      // Paul Kellet's economy pink filter
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
    }
    return this.longNoise;
  }

  /** A looping filtered noise voice, parked at gain 0, into `dest`. */
  private noiseVoice(type: BiquadFilterType, freq: number, q: number, dest: AudioNode, buffer = this.noiseBuffer): NoiseVoice {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filt = c.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(filt).connect(g).connect(dest);
    // each voice starts at its own point of the loop, so layered voices don't share a pattern
    src.start(0, Math.random() * (buffer?.duration ?? 1));
    return { filt, g };
  }

  /** An oscillator voice, parked at gain 0, into `dest` (optionally through a filter). */
  private oscVoice(type: OscillatorType, freq: number, dest: AudioNode, filter?: { type: BiquadFilterType; freq: number; q: number }): OscVoice {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = 0;
    let filt: BiquadFilterNode | null = null;
    if (filter) {
      filt = c.createBiquadFilter();
      filt.type = filter.type;
      filt.frequency.value = filter.freq;
      filt.Q.value = filter.q;
      o.connect(filt).connect(g);
    } else o.connect(g);
    g.connect(dest);
    o.start();
    return { o, g, filt };
  }

  /**
   * A gain that an LFO opens and shuts (between 0 and 1 at `rate` Hz) into `dest`: the continuous
   * repetitive chime, the overspeed clacker, the stall cricket and the spoiler buffet are gated so.
   */
  private gate(rate: number, dest: AudioNode, shape: OscillatorType = 'square') {
    const c = this.ctx!;
    const gate = c.createGain();
    gate.gain.value = 0.5;
    const lfo = c.createOscillator();
    lfo.type = shape;
    lfo.frequency.value = rate;
    const depth = c.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(gate.gain);
    lfo.start();
    gate.connect(dest);
    return gate;
  }

  private buildJet(): JetVoices {
    const c = this.ctx!;
    const bus = c.createGain();
    bus.gain.value = 0;
    bus.connect(this.master!);
    // the engines are heard through the cabin's walls inside, full band outside
    const cabin = c.createBiquadFilter();
    cabin.type = 'lowpass';
    cabin.frequency.value = 16000;
    cabin.Q.value = 0.5;
    const engineMix = c.createGain();
    engineMix.gain.value = 1;
    engineMix.connect(cabin).connect(bus);
    const engines = [0, 1].map(() => ({
      // the fan's shaft-order buzz-saw: a sawtooth at the shaft frequency, its harmonics round the blade-pass frequency
      saw: this.oscVoice('sawtooth', 20, engineMix, { type: 'bandpass', freq: 400, q: 3.5 }),
      // the blade-pass tone itself, and the core's whine
      tone: this.oscVoice('sine', 400, engineMix),
      whine: this.oscVoice('sine', 2400, engineMix),
    }));
    const amb = this.ambience;
    return {
      bus,
      cabin,
      engineMix,
      engines,
      roar: this.noiseVoice('lowpass', 600, 0.6, engineMix, amb),
      rumble: this.noiseVoice('lowpass', 90, 0.8, engineMix, amb),
      reverse: this.noiseVoice('bandpass', 700, 0.7, engineMix),
      air: this.noiseVoice('bandpass', 900, 0.8, bus, amb),
      gearAir: this.noiseVoice('lowpass', 150, 0.8, bus),
      roll: this.noiseVoice('lowpass', 120, 0.9, bus, amb),
      // spoiler buffet: low noise with a shudder in it
      spoil: this.noiseVoice('lowpass', 85, 0.9, this.gate(6.5, bus, 'sine')),
      flapMotor: this.oscVoice('sawtooth', 170, bus, { type: 'bandpass', freq: 340, q: 6 }),
      gearMotor: this.oscVoice('sawtooth', 400, bus, { type: 'bandpass', freq: 800, q: 6 }),
    };
  }

  /** Bring up the player's aircraft (its voices build on the first call). Call aircraft() every frame after. */
  startAircraft() {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (!this.jet) this.jet = this.buildJet();
    this.aircraftOn = true;
    this.jet.bus.gain.setTargetAtTime(1, this.ctx.currentTime, 0.2);
    this.lastAircraftT = this.ctx.currentTime;
  }

  /** Silence the aircraft and every warning loop (the flight is over). */
  stopAircraft() {
    if (!this.ctx) return;
    this.aircraftOn = false;
    if (this.jet) this.jet.bus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    this.ptuLeft = 0;
    this.masterWarning(false);
    this.overspeedClacker(false);
    this.stallCricket(false);
    this.radioHiss(false);
  }

  /**
   * The A320neo, every frame: two LEAP-1A engines (the fan's buzz-saw and blade-pass tone, the
   * core's whine, the exhaust's roar and rumble, all rising with N1; engine 2 a hair off engine 1 so
   * they beat), airflow with IAS, the gear's rumble on the runway and buffet in the air, reverser
   * roar, spoiler buffet, and the flap and gear motors. Inside, the engines are muffled by the cabin.
   * `n1` 0..~1.02 per engine, `ias`/`groundSpeed` in knots, `reverser`/`spoilers`/`gear` 0..1.
   */
  aircraft(p: { n1: [number, number]; ias: number; onGround: boolean; groundSpeed: number; reverser: number; spoilers: number; gear: number; inside: boolean; flapsMoving: boolean; gearMoving: boolean }) {
    if (!this.ctx || !this.jet || !this.aircraftOn) return;
    const t = this.ctx.currentTime;
    const dt = Math.min(0.25, Math.max(0, t - this.lastAircraftT));
    this.lastAircraftT = t;
    const j = this.jet;
    const tau = 0.08;
    const ias = Math.max(0, p.ias);
    const gs = Math.max(0, p.groundSpeed);

    j.cabin.frequency.setTargetAtTime(p.inside ? 620 : 16000, t, 0.15);
    j.engineMix.gain.setTargetAtTime(p.inside ? 0.6 : 1, t, 0.15);

    let n1Sum = 0;
    let running = 0;
    for (let i = 0; i < 2; i++) {
      const n1 = Math.max(0, p.n1[i]);
      n1Sum += n1;
      if (n1 > 0.17) running++;
      const e = j.engines[i];
      // LEAP-1A: 18 fan blades, 3,856 rpm at 100 % N1 (64.3 Hz shaft, 1,157 Hz blade pass)
      const shaft = n1 * 64.27 * (i ? 1.007 : 1);
      const bpf = shaft * 18;
      e.saw.o.frequency.setTargetAtTime(Math.max(8, shaft), t, tau);
      e.saw.filt!.frequency.setTargetAtTime(Math.max(60, bpf), t, tau);
      // the buzz-saw only really sings with the fan tips supersonic, high on the power
      e.saw.g.gain.setTargetAtTime(n1 ** 3 * 0.07 + Math.max(0, n1 - 0.72) * 0.32, t, tau);
      e.tone.o.frequency.setTargetAtTime(Math.max(20, bpf), t, tau);
      e.tone.g.gain.setTargetAtTime(n1 * n1 * 0.05, t, tau);
      // the core turns faster than the fan and whines even at idle: the sound of a jet on the apron
      e.whine.o.frequency.setTargetAtTime(1900 + n1 * 3900 * (i ? 1.005 : 1), t, 0.2);
      e.whine.g.gain.setTargetAtTime(n1 > 0.03 ? 0.008 + Math.min(1, n1 / 0.2) * 0.01 + n1 * 0.008 : 0, t, 0.2);
    }
    const n1 = n1Sum / 2;
    j.roar.filt.frequency.setTargetAtTime(200 + n1 * 2500, t, tau);
    j.roar.g.gain.setTargetAtTime(n1 * n1 * 0.42, t, tau);
    j.rumble.g.gain.setTargetAtTime(n1 * n1 * 0.32, t, tau);
    j.reverse.g.gain.setTargetAtTime(p.reverser * (0.08 + n1 * 0.45), t, 0.12);
    j.reverse.filt.frequency.setTargetAtTime(500 + n1 * 700, t, 0.12);

    // airflow over the flight deck: loud inside at speed, a soft rush outside
    j.air.filt.frequency.setTargetAtTime(300 + ias * 6, t, 0.1);
    j.air.g.gain.setTargetAtTime(Math.min(0.4, (ias / 250) ** 2 * 0.35) * (p.inside ? 1 : 0.4), t, 0.1);
    j.gearAir.g.gain.setTargetAtTime(p.onGround ? 0 : p.gear * Math.min(1.5, (ias / 180) ** 2) * 0.1, t, 0.15);
    j.roll.g.gain.setTargetAtTime(p.onGround ? Math.min(1, gs / 60) * 0.32 + (gs > 0.5 ? 0.03 : 0) : 0, t, 0.06);
    j.roll.filt.frequency.setTargetAtTime(90 + Math.min(1, gs / 80) * 160, t, 0.1);
    j.spoil.g.gain.setTargetAtTime(p.spoilers * Math.min(1, (ias / 150) ** 2) * 0.2, t, 0.12);
    j.flapMotor.g.gain.setTargetAtTime(p.flapsMoving ? 0.02 : 0, t, 0.15);
    j.gearMotor.g.gain.setTargetAtTime(p.gearMoving ? 0.026 : 0, t, 0.15);

    if (p.onGround && gs > 2) {
      // the nose wheels thump over the centreline lights, 15 m apart
      this.rollDist += gs * KT * dt;
      if (this.rollDist >= 15) {
        this.rollDist %= 15;
        const k = Math.min(1, gs / 40);
        this.tone(58 + Math.random() * 10, 0.07, 'sine', 0.05 + 0.07 * k);
        this.noise(0.03, 260, 0.03 + 0.05 * k, 1.2);
      }
    }

    // the A320's power transfer unit "barks" for a few seconds while only one engine runs on the ground
    if (p.onGround && running === 1) {
      if (this.ptuLeft <= 0 && this.ptuDone < 8) this.ptuLeft = 3.5;
    } else if (running !== 1) this.ptuDone = 0;
    if (this.ptuLeft > 0) {
      this.ptuLeft -= dt;
      this.ptuDone += dt;
      this.ptuClock -= dt;
      if (this.ptuClock <= 0) {
        this.ptuClock = 0.16;
        this.tone(115, 0.12, 'sawtooth', 0.035, 0, 95);
        this.tone(230, 0.08, 'square', 0.012);
      }
    }
  }

  /** The main gear meeting the runway: a thump and the tyres' chirp (`intensity` 0 greaser .. 1 very hard). */
  touchdown(intensity: number) {
    const v = Math.max(0, Math.min(1, intensity));
    this.tone(55, 0.35, 'sine', 0.12 + v * 0.38, 0, 35);
    this.noise(0.25, 180, 0.12 + v * 0.42, 0.8);
    // both main gears, a few hundredths of a second apart
    this.noise(0.13, 2600, 0.08 + v * 0.16, 6);
    this.noise(0.12, 2400, 0.07 + v * 0.14, 6, 0.045);
    if (v > 0.55) this.noise(0.45, 520, (v - 0.4) * 0.35, 1.1, 0.03);
  }

  /** Cabin chimes: 'single' (a call), 'double' (the hi-lo PA chime), 'seatbelt' (the sign switching). */
  cabinChime(kind: 'single' | 'double' | 'seatbelt') {
    if (kind === 'double') {
      this.tone(932, 1.3, 'sine', 0.11);
      this.tone(1864, 0.8, 'sine', 0.025);
      this.tone(740, 1.7, 'sine', 0.11, 0.6);
      this.tone(1480, 1, 'sine', 0.022, 0.6);
    } else if (kind === 'seatbelt') {
      this.tone(587, 1.6, 'sine', 0.12);
      this.tone(1174, 1.1, 'sine', 0.03);
    } else {
      this.tone(1046, 1.4, 'sine', 0.1);
      this.tone(2093, 0.9, 'sine', 0.025);
    }
  }

  /** The autopilot disconnect's "cavalry charge": a bright bugle-like run, played twice. */
  cavalryCharge() {
    const notes = [392, 523, 659, 784, 659, 784];
    for (let r = 0; r < 2; r++)
      notes.forEach((f, i) => {
        const at = r * 0.78 + i * 0.12;
        this.tone(f, i === 3 || i === 5 ? 0.22 : 0.13, 'triangle', 0.1, at);
        this.tone(f * 2, 0.1, 'square', 0.012, at);
      });
  }

  /** The master warning's continuous repetitive chime, on until switched off. */
  masterWarning(on: boolean) {
    if (!this.ctx || !this.master) return;
    if (!this.crc) {
      if (!on) return;
      const out = this.ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);
      const g = this.gate(3.3, out);
      this.oscVoice('sine', 1040, g).g.gain.value = 0.1;
      this.oscVoice('sine', 2080, g).g.gain.value = 0.025;
      this.crc = out;
    }
    this.crc.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** The master caution's single chime. */
  masterCaution() {
    this.tone(880, 0.9, 'sine', 0.13);
    this.tone(1760, 0.5, 'sine', 0.035);
  }

  /** The overspeed clacker, on until switched off. */
  overspeedClacker(on: boolean) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (!this.clacker) {
      if (!on) return;
      const out = this.ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);
      this.noiseVoice('bandpass', 2600, 3, this.gate(11, out)).g.gain.value = 0.32;
      this.oscVoice('square', 180, this.gate(11, out)).g.gain.value = 0.02;
      this.clacker = out;
    }
    this.clacker.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** The stall warning's cricket, on until switched off. */
  stallCricket(on: boolean) {
    if (!this.ctx || !this.master) return;
    if (!this.cricket) {
      if (!on) return;
      const out = this.ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);
      // a 2.9 kHz chirp, buzzed at 30 Hz, a few chirps a second
      const slow = this.gate(2.6, out);
      const fast = this.gate(30, slow);
      this.oscVoice('sine', 2900, fast).g.gain.value = 0.09;
      this.cricket = out;
    }
    this.cricket.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** The press-to-talk click and squelch tail that bracket a radio transmission. */
  radioClick() {
    this.noise(0.012, 3200, 0.12, 2);
    this.tone(1400, 0.02, 'square', 0.015);
    this.noise(0.11, 1800, 0.035, 0.8, 0.012);
  }

  /** Radio hiss under an ATC transmission. */
  radioHiss(on: boolean) {
    if (!this.ctx || !this.master) return;
    if (!this.hiss) {
      if (!on) return;
      this.hiss = this.noiseVoice('bandpass', 1500, 0.7, this.master, this.ambience);
    }
    this.hiss.g.gain.setTargetAtTime(on ? 0.05 : 0, this.ctx.currentTime, on ? 0.01 : 0.04);
  }

  /** The nearest AI airliner: `k` 0..1 its loudness at the listener (the caller works out the distance), `n1` its power. */
  trafficJet(k: number, n1: number) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (!this.trafficVoice) {
      if (k <= 0) return;
      this.trafficVoice = {
        roar: this.noiseVoice('lowpass', 500, 0.6, this.master, this.ambience),
        whine: this.oscVoice('sine', 3000, this.master),
        buzz: this.oscVoice('sawtooth', 60, this.master, { type: 'bandpass', freq: 1100, q: 3 }),
      };
    }
    const t = this.ctx.currentTime;
    const v = this.trafficVoice;
    const kk = Math.max(0, Math.min(1, k));
    v.roar.filt.frequency.setTargetAtTime(300 + n1 * 1800, t, 0.2);
    v.roar.g.gain.setTargetAtTime(kk * (0.04 + n1 * n1 * 0.3), t, 0.2);
    v.whine.o.frequency.setTargetAtTime(2000 + n1 * 3500, t, 0.3);
    v.whine.g.gain.setTargetAtTime(n1 > 0.05 ? kk * 0.012 : 0, t, 0.2);
    v.buzz.o.frequency.setTargetAtTime(Math.max(8, n1 * 64), t, 0.2);
    v.buzz.filt!.frequency.setTargetAtTime(Math.max(60, n1 * 1157), t, 0.2);
    v.buzz.g.gain.setTargetAtTime(kk * Math.max(0, n1 - 0.7) * 0.15, t, 0.2);
  }

  /** The seaside: waves rolling in, surf, and gulls now and then (`k` 0..1, how near the shore). */
  seaAmbience(k: number) {
    if (!this.ctx || !this.master) return;
    const c = this.ctx;
    if (!this.sea) {
      if (k <= 0) return;
      const amb = this.ambience;
      // each layer's gain swells with a slow LFO: the waves' rhythm for free
      const swell = (rate: number, depth: number) => {
        const g = c.createGain();
        g.gain.value = 1 - depth;
        const lfo = c.createOscillator();
        lfo.frequency.value = rate;
        const d = c.createGain();
        d.gain.value = depth;
        lfo.connect(d).connect(g.gain);
        lfo.start();
        g.connect(this.master!);
        return g;
      };
      this.sea = {
        waves: this.noiseVoice('lowpass', 500, 0.7, swell(0.11, 0.6), amb),
        surf: this.noiseVoice('highpass', 2400, 0.7, swell(0.13, 0.8), amb),
      };
      this.nextGull = c.currentTime + 2;
    }
    const t = c.currentTime;
    const kk = Math.max(0, Math.min(1, k));
    this.sea.waves.g.gain.setTargetAtTime(kk * 0.3, t, 0.4);
    this.sea.surf.g.gain.setTargetAtTime(kk * 0.05, t, 0.4);
    if (kk > 0.2 && t >= this.nextGull) {
      this.nextGull = t + 4 + Math.random() * 11;
      const v = 0.03 * kk;
      const f = 1500 + Math.random() * 500;
      for (let i = 0, n = 1 + Math.floor(Math.random() * 3); i < n; i++) {
        this.tone(f, 0.3, 'sine', v, i * 0.32, f * 0.68);
        this.tone(f * 2.02, 0.22, 'sine', v * 0.25, i * 0.32, f * 1.3);
      }
    }
  }

  /** A jet-ski's engine and spray: on, with `rpm` 0..1. */
  boatEngine(on: boolean, rpm = 0.5) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (!this.boat) {
      if (!on) return;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 700;
      filter.Q.value = 1.6;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      filter.connect(gain).connect(this.master);
      this.boat = {
        osc: [this.oscVoice('sawtooth', 80, filter), this.oscVoice('square', 40, filter)],
        filter,
        gain,
        spray: this.noiseVoice('highpass', 3000, 0.7, this.master),
        slap: this.noiseVoice('lowpass', 300, 0.8, this.master),
      };
      for (const o of this.boat.osc) o.g.gain.value = 1;
    }
    const t = this.ctx.currentTime;
    const b = this.boat;
    const r = Math.max(0, Math.min(1, rpm));
    const f = 70 + r * 230;
    b.osc[0].o.frequency.setTargetAtTime(f, t, 0.06);
    b.osc[1].o.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    b.filter.frequency.setTargetAtTime(500 + r * 1800, t, 0.08);
    b.gain.gain.setTargetAtTime(on ? 0.035 + r * 0.05 : 0, t, 0.08);
    b.spray.g.gain.setTargetAtTime(on ? r * r * 0.07 : 0, t, 0.1);
    b.slap.g.gain.setTargetAtTime(on ? 0.03 + r * 0.08 : 0, t, 0.1);
  }

  /** A cannon firing: the boom, the crack and its echo off the water. */
  cannonBoom() {
    this.noise(0.9, 140, 0.5, 0.5);
    this.tone(48, 0.7, 'triangle', 0.42, 0, 28);
    this.noise(0.22, 1300, 0.16, 0.7);
    this.noise(0.6, 220, 0.1, 0.5, 0.38);
  }

  /** Something hitting the water: `size` 0.1 (a pebble) .. 1 (a cannonball) .. 2 (someone off the slide). */
  splash(size: number) {
    const s = Math.max(0.1, Math.min(2, size));
    const n = this.noise(0.3 + 0.35 * s, 1300, 0.08 + 0.14 * s, 0.9);
    if (n) n.f.frequency.exponentialRampToValueAtTime(280, n.t + 0.28 + 0.3 * s);
    this.tone(160 / Math.sqrt(s), 0.15, 'sine', 0.05 + 0.06 * s, 0, 70);
    this.noise(0.4 * s, 3200, 0.03 * s, 1.2, 0.06);
  }

  /** A rush of air past the ears; `speed` scales it (1, the default, is the park's usual whoosh). */
  whoosh(speed = 1) {
    const k = Math.max(0.2, Math.min(2.5, speed));
    const n = this.noise(1.1 / Math.sqrt(k), 400, 0.25 * Math.min(1.6, k), 1.2);
    if (n) n.f.frequency.exponentialRampToValueAtTime(2400 * (0.6 + 0.4 * k), n.t + 1 / Math.sqrt(k));
  }

  /** A volleyball struck (`power` 0..1). */
  ballHit(power: number) {
    const p = Math.max(0, Math.min(1, power));
    this.noise(0.08, 900 + p * 800, 0.18 + p * 0.3, 1.4);
    this.tone(150 + p * 90, 0.12, 'triangle', 0.14 + p * 0.2);
  }

  /** A coconut knocked: a hollow wooden tock. */
  coconutThunk() {
    this.tone(430, 0.1, 'triangle', 0.24, 0, 300);
    this.tone(860, 0.05, 'sine', 0.06);
    this.noise(0.05, 700, 0.14, 3);
  }

  /** A crowd cheering and clapping (`k` 0..1: a polite few to a roar). */
  cheer(k: number) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const c = this.ctx;
    const kk = Math.max(0.05, Math.min(1, k));
    const t = c.currentTime;
    const dur = 1.6 + kk * 1.6;
    const bands: [number, number, number][] = [
      [900, 0.6, 0.1],
      [1700, 0.9, 0.05],
      [420, 0.7, 0.05],
    ];
    for (const [f, q, v] of bands) {
      const src = c.createBufferSource();
      src.buffer = this.ambience;
      const filt = c.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = f;
      filt.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v * kk, t + 0.25);
      g.gain.setValueAtTime(v * kk, t + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filt).connect(g).connect(this.master);
      src.start(t, Math.random() * 6);
      src.stop(t + dur + 0.05);
    }
    // hands clapping, and a whistle or two from the keen ones
    const claps = Math.round(10 + kk * 30);
    for (let i = 0; i < claps; i++) this.noise(0.03, 1600 + Math.random() * 1400, 0.03 + kk * 0.03, 2.5, Math.random() * dur * 0.8);
    if (kk > 0.4) this.tone(2100, 0.5, 'sine', 0.035 * kk, 0.2 + Math.random() * 0.4, 2700);
  }

  /** A nervous murmur through the cabin (after a hard landing, in turbulence): `k` 0..1. */
  murmur(k: number) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const c = this.ctx;
    const kk = Math.max(0.05, Math.min(1, k));
    const t = c.currentTime;
    const dur = 2.5 + kk;
    const src = c.createBufferSource();
    src.buffer = this.ambience;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 480;
    filt.Q.value = 1.4;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09 * kk, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // the voices rise and fall
    const lfo = c.createOscillator();
    lfo.frequency.value = 3.1;
    const d = c.createGain();
    d.gain.value = 180;
    lfo.connect(d).connect(filt.frequency);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t, Math.random() * 6);
    lfo.start(t);
    src.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /**
   * A GPWS alert as tones, for when there's no speech synthesis to say it: a flat, buzzy
   * three-note "attention" pattern, twice as fast and an octave up when it's a warning
   * (PULL UP, STALL) rather than a caution.
   */
  gpwsAlert(urgent: boolean) {
    const base = urgent ? 760 : 520;
    const step = urgent ? 0.13 : 0.2;
    for (let i = 0; i < 3; i++) {
      this.tone(i === 1 ? base * 0.8 : base, step * 0.85, 'square', 0.035, i * step);
      this.tone(i === 1 ? base * 1.6 : base * 2, step * 0.85, 'sawtooth', 0.012, i * step);
    }
  }

  /** The GPWS "whoop whoop" that goes before PULL UP. */
  whoop() {
    for (const at of [0, 0.42]) {
      this.tone(380, 0.32, 'triangle', 0.16, at, 1250);
      this.tone(760, 0.32, 'sine', 0.04, at, 2500);
    }
  }
}
