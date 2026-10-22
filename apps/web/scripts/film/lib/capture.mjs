// Records the page frame by frame into a video: each frame moves the film clock on exactly 1/fps s
// (__film.step: the game's tick and draw), then screenshots the page (the 3D view and whatever
// interface is showing), and pipes the picture into ffmpeg. However long a frame takes to draw and
// capture, the video plays at real speed.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const FFMPEG = process.env.FFMPEG ?? ['C:/ffmpeg/ffmpeg.exe', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].find((p) => existsSync(p)) ?? 'ffmpeg';

/**
 * An ffmpeg that reads `format` ('jpeg' or 'png') pictures on its stdin at `fps` and writes `out`:
 * H.264 (High profile, 4:2:0, BT.709 limited range, +faststart) at `crf` (18: a master to cut
 * and re-encode from, about 40–60 Mbit/s for the park's grass at 1080p), unless `args` says
 * otherwise. Resolves with ffmpeg's stderr once it exits.
 */
export function encoder(out, { fps = 30, format = 'jpeg', crf = 18, preset = 'slow', args = null } = {}) {
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', format === 'png' ? 'png' : 'mjpeg', '-i', '-'];
  const output = args ?? [
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart',
  ];
  const proc = spawn(FFMPEG, [...input, ...output, out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited with ${code}: ${err.slice(-2000)}`))));
  });
  return {
    write: (buf) => new Promise((resolve, reject) => (proc.stdin.write(buf, (e) => (e ? reject(e) : resolve())))),
    end: () => {
      proc.stdin.end();
      return done;
    },
  };
}

/**
 * Films `seconds` of the page at `fps` into `out` (see encoder for the options; null: nothing is
 * encoded, for timing runs). The film clock must be frozen first (__film.freeze()). `before(i, t)`
 * runs before frame i is stepped (t: its time from the start, s): the place for timed director
 * calls. `probe` is an expression read in the page straight after each step (say, where the train
 * is), returned per frame. Returns timings: the wall-clock seconds spent per second of video, split
 * into stepping (the game's update and draw), capture and handing the picture to ffmpeg, and the
 * game time each frame advanced (every one should be exactly 1/fps). `keep(i)` picks the frames to
 * capture (all of them unless it says otherwise: a check run keeps a few and steps through the
 * rest), and `onFrame(i, picture)` gets each one captured.
 */
export async function record(page, { seconds, fps = 30, out, format = 'jpeg', quality = 92, fast = true, before = null, probe = null, encode = {}, keep = null, onFrame = null }) {
  const frames = Math.round(seconds * fps);
  const enc = out ? encoder(out, { fps, format, ...encode }) : null;
  const stepMs = 1000 / fps;
  let stepping = 0;
  let capturing = 0;
  let writing = 0;
  let bytes = 0;
  const gameDt = [];
  const probes = [];
  // (a title card has no game: its own film clock stands in for the game's)
  let lastT = await page.evaluate('window.__game ? __game.time.t : __film.time');
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (before) await before(i, i / fps);
    let a = performance.now();
    const [t, p] = await page.evaluate(`(__film.step(${stepMs}), [window.__game ? __game.time.t : __film.time, ${probe ?? 'null'}])`);
    stepping += performance.now() - a;
    gameDt.push(t - lastT);
    lastT = t;
    if (probe) probes.push(p);
    if (keep && !keep(i)) continue;
    a = performance.now();
    const shot = await page.screenshot({ format, quality: format === 'png' ? undefined : quality, fast });
    capturing += performance.now() - a;
    bytes += shot.length;
    a = performance.now();
    if (enc) await enc.write(shot);
    if (onFrame) await onFrame(i, shot);
    writing += performance.now() - a;
  }
  if (enc) await enc.end();
  const wall = (performance.now() - t0) / 1000;
  const video = frames / fps;
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    frames,
    video,
    wall,
    perVideoSecond: wall / video,
    stepMsPerFrame: stepping / frames,
    captureMsPerFrame: capturing / frames,
    writeMsPerFrame: writing / frames,
    kbPerFrame: bytes / frames / 1024,
    gameDt: { min: round(Math.min(...gameDt)), max: round(Math.max(...gameDt)), expected: round(1 / fps) },
    probes,
  };
}
