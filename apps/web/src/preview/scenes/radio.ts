// The radio and flight audio, looked at rather than listened to: every Funfair Air sound is rendered
// offline (the Sfx runs on an OfflineAudioContext, so no user gesture or speakers are needed) and
// drawn as a spectrum or a spectrogram, next to the radio logic checks run in the browser.
//
//   ?scene=radio&env=0&post=0
//
// The engine panels mark where the LEAP-1A's shaft and blade-pass frequencies should be for the N1
// shown; the spectrograms show each one-shot's shape over two seconds.

import type { PreviewScene } from '../main';
import { Sfx } from '../../world/audio';
import { runRadioChecks } from '../../aviation/radio-check';

const SR = 44100;
const LEN = SR * 2;

type AircraftParams = Parameters<Sfx['aircraft']>[0];

/** Render two seconds of whatever `play` does on a fresh Sfx bound to an offline context. */
async function renderOffline(play: (sfx: Sfx) => void): Promise<Float32Array> {
  class OfflineAC extends OfflineAudioContext {
    constructor() {
      super(1, LEN, SR);
    }
  }
  const w = window as unknown as { AudioContext: unknown };
  const real = w.AudioContext;
  w.AudioContext = OfflineAC;
  const sfx = new Sfx();
  sfx.muted = false;
  try {
    sfx.unlock();
  } finally {
    w.AudioContext = real;
  }
  play(sfx);
  const ctx = (sfx as unknown as { ctx: OfflineAudioContext }).ctx;
  const buf = await ctx.startRendering();
  return buf.getChannelData(0).slice();
}

/** In-place radix-2 FFT (re, im of length 2^n). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k);
        const wi = Math.sin(a * k);
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - xr;
        im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
  }
}

/** Power spectrum (dB) of a window of `size` samples from `at`, Hann-windowed. */
function spectrum(x: Float32Array, at: number, size: number) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = (x[at + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  fft(re, im);
  const out = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) out[i] = 10 * Math.log10((re[i] * re[i] + im[i] * im[i]) / size + 1e-14);
  return out;
}

const F0 = 30;
const F1 = 12000;
const fx = (f: number, x0: number, w: number) => x0 + (Math.log(f / F0) / Math.log(F1 / F0)) * w;

const scene: PreviewScene = async () => {
  const cv = document.createElement('canvas');
  const W = innerWidth;
  const H = innerHeight;
  cv.width = W;
  cv.height = H;
  Object.assign(cv.style, { position: 'fixed', inset: '0', zIndex: '5' });
  document.body.appendChild(cv);
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0d1420';
  g.fillRect(0, 0, W, H);
  g.font = '600 15px system-ui, sans-serif';
  g.fillStyle = '#e8eef8';
  g.fillText('Funfair Air: flight audio (rendered offline) and the radio logic checks', 16, 24);

  // ------------------------------------------------------------------ the engines
  const engine: { label: string; p: AircraftParams; n1: number }[] = [
    { label: 'Idle on the apron, outside (N1 21 %)', n1: 0.21, p: { n1: [0.21, 0.21], ias: 0, onGround: true, groundSpeed: 0, reverser: 0, spoilers: 0, gear: 1, inside: false, flapsMoving: false, gearMoving: false } },
    { label: 'Takeoff roll, outside (N1 95 %, 120 kt)', n1: 0.95, p: { n1: [0.95, 0.95], ias: 120, onGround: true, groundSpeed: 120, reverser: 0, spoilers: 0, gear: 1, inside: false, flapsMoving: false, gearMoving: false } },
    { label: 'Cruise in the cabin (N1 62 %, 250 kt)', n1: 0.62, p: { n1: [0.62, 0.62], ias: 250, onGround: false, groundSpeed: 250, reverser: 0, spoilers: 0, gear: 0, inside: true, flapsMoving: false, gearMoving: false } },
    { label: 'Landing roll: reversers, spoilers (N1 70 %)', n1: 0.7, p: { n1: [0.7, 0.7], ias: 110, onGround: true, groundSpeed: 110, reverser: 1, spoilers: 1, gear: 1, inside: false, flapsMoving: false, gearMoving: false } },
  ];
  const pw = 400;
  const ph = 150;
  for (let i = 0; i < engine.length; i++) {
    const e = engine[i];
    const x = await renderOffline((sfx) => {
      sfx.startAircraft();
      sfx.aircraft(e.p);
    });
    // average the spectra of the last second (the voices have settled by then)
    const size = 8192;
    const acc = new Float64Array(size / 2);
    let n = 0;
    for (let at = SR; at + size <= LEN; at += size / 2, n++) {
      const s = spectrum(x, at, size);
      for (let k = 0; k < acc.length; k++) acc[k] += s[k];
    }
    let rms = 0;
    for (let k = SR; k < LEN; k++) rms += x[k] * x[k];
    rms = 10 * Math.log10(rms / SR + 1e-14);
    const x0 = 16 + (i % 2) * (pw + 16);
    const y0 = 44 + Math.floor(i / 2) * (ph + 34);
    g.fillStyle = '#16202f';
    g.fillRect(x0, y0, pw, ph);
    // the shaft and blade-pass frequencies of the LEAP-1A's 18-blade fan at this N1
    const shaft = e.n1 * 64.27;
    for (const [f, c] of [
      [shaft, '#7a5cff'],
      [shaft * 18, '#ff9a3d'],
    ] as const) {
      g.strokeStyle = c;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(fx(f, x0, pw), y0);
      g.lineTo(fx(f, x0, pw), y0 + ph);
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = '#5fd0ff';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = 1; k < acc.length; k++) {
      const f = (k * SR) / size;
      if (f < F0 || f > F1) continue;
      const db = acc[k] / n;
      const px = fx(f, x0, pw);
      const py = y0 + ph - ((db + 120) / 115) * ph;
      if (f === (1 * SR) / size || px === fx(F0, x0, pw)) g.moveTo(px, py);
      else g.lineTo(px, Math.max(y0, Math.min(y0 + ph, py)));
    }
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = '#c9d6ea';
    g.font = '12px system-ui, sans-serif';
    g.fillText(`${e.label}   ${rms.toFixed(1)} dBFS`, x0, y0 + ph + 14);
    g.fillStyle = '#7b8aa3';
    g.font = '10px system-ui, sans-serif';
    for (const f of [50, 100, 300, 1000, 3000, 10000]) g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, fx(f, x0, pw) - 6, y0 + ph - 3);
  }
  g.fillStyle = '#7a5cff';
  g.fillText('- - fan shaft', 16, 418);
  g.fillStyle = '#ff9a3d';
  g.fillText('- - blade pass (18 blades)', 96, 418);

  // ------------------------------------------------------------------ the one-shots and loops
  const sounds: [string, (s: Sfx) => void][] = [
    ['touchdown(0.3)', (s) => s.touchdown(0.3)],
    ['touchdown(1)', (s) => s.touchdown(1)],
    ['cabinChime double', (s) => s.cabinChime('double')],
    ['cabinChime seatbelt', (s) => s.cabinChime('seatbelt')],
    ['cavalryCharge', (s) => s.cavalryCharge()],
    ['masterWarning', (s) => s.masterWarning(true)],
    ['masterCaution', (s) => s.masterCaution()],
    ['overspeedClacker', (s) => s.overspeedClacker(true)],
    ['stallCricket', (s) => s.stallCricket(true)],
    ['whoop + gpwsAlert', (s) => (s.whoop(), s.gpwsAlert(true))],
    ['radioClick + hiss', (s) => (s.radioClick(), s.radioHiss(true))],
    ['trafficJet(1, 0.9)', (s) => s.trafficJet(1, 0.9)],
    ['seaAmbience(1)', (s) => s.seaAmbience(1)],
    ['boatEngine(0.8)', (s) => s.boatEngine(true, 0.8)],
    ['cannonBoom', (s) => s.cannonBoom()],
    ['splash(1)', (s) => s.splash(1)],
    ['whoosh(1.5)', (s) => s.whoosh(1.5)],
    ['ballHit + coconut', (s) => (s.ballHit(0.8), s.coconutThunk())],
    ['cheer(1)', (s) => s.cheer(1)],
    ['murmur(1)', (s) => s.murmur(1)],
  ];
  const cols = 5;
  const sw = 158;
  const sh = 52;
  const rows = 48;
  const win = 1024;
  const hop = 1024;
  for (let i = 0; i < sounds.length; i++) {
    const [label, play] = sounds[i];
    const x = await renderOffline(play);
    const x0 = 16 + (i % cols) * (sw + 6);
    const y0 = 432 + Math.floor(i / cols) * (sh + 20);
    const colsN = Math.floor((LEN - win) / hop);
    const cw = sw / colsN;
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    for (let c = 0; c < colsN; c++) {
      const s = spectrum(x, c * hop, win);
      for (let r = 0; r < rows; r++) {
        const f = F0 * Math.pow(F1 / F0, r / rows);
        const db = s[Math.min(s.length - 1, Math.round((f * win) / SR))];
        const v = Math.max(0, Math.min(1, (db + 100) / 70));
        g.fillStyle = `hsl(${220 - v * 200}, 85%, ${6 + v * 58}%)`;
        g.fillRect(x0 + c * cw, y0 + sh - ((r + 1) / rows) * sh, cw + 0.5, sh / rows + 0.5);
      }
    }
    g.fillStyle = peak > 0.001 ? '#c9d6ea' : '#ff6b6b';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${label}  ${(20 * Math.log10(peak + 1e-9)).toFixed(0)} dB`, x0, y0 + sh + 12);
  }

  // ------------------------------------------------------------------ the logic checks, in the browser
  const rowsOut = runRadioChecks();
  const tx = 856;
  g.font = '600 13px system-ui, sans-serif';
  g.fillStyle = '#e8eef8';
  const passed = rowsOut.filter((r) => r.ok).length;
  g.fillText(`Radio checks: ${passed} / ${rowsOut.length} pass`, tx, 52);
  g.font = '11px system-ui, sans-serif';
  rowsOut.forEach((r, i) => {
    g.fillStyle = r.ok ? '#5fe08a' : '#ff6b6b';
    g.fillText(r.ok ? 'PASS' : 'FAIL', tx, 70 + i * 14.4);
    g.fillStyle = '#c9d6ea';
    g.fillText(r.name.length > 60 ? `${r.name.slice(0, 59)}…` : r.name, tx + 34, 70 + i * 14.4);
  });
};
export default scene;
