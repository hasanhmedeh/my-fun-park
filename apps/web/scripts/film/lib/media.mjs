// Everything ffmpeg does to the films after they're shot: the shots joined (cuts, crossfades, fades
// to and from black), the music laid under them at a steady loudness, subtitles burnt in for a
// review copy, and the encodes for each place a film goes (the web page in H.264 and AV1, YouTube,
// the hero's silent loop), plus posters and content-hashed file names.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from './capture.mjs';

export { FFMPEG };
export const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext ?? ''}`);
const FILM = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs ffmpeg with `args` (in `cwd`); resolves with its log, rejects with the end of it. */
export function ffmpeg(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    proc.stderr.on('data', (d) => (log += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(`ffmpeg exited with ${code}:\n${log.slice(-3000)}`))));
  });
}

/** A file's first video and audio stream and its length, as ffprobe reports them. */
export function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,profile,level,width,height,bit_rate', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  return {
    duration: Number(j.format.duration),
    bytes: Number(j.format.size),
    video: j.streams.find((s) => s.codec_type === 'video') ?? null,
    audio: j.streams.find((s) => s.codec_type === 'audio') ?? null,
  };
}

/** The first `n` hex digits of a file's (or a string's) SHA-256: the content hash in a file name. */
export function hash(fileOrText, n = 8, { text = false } = {}) {
  return createHash('sha256')
    .update(text ? fileOrText : readFileSync(fileOrText))
    .digest('hex')
    .slice(0, n);
}

// ---------------------------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------------------------

/** music.json, with `root` resolved (FILM_MUSIC wins). */
export function musicLibrary() {
  const lib = JSON.parse(readFileSync(join(FILM, 'music.json'), 'utf8'));
  lib.root = resolve(FILM, process.env.FILM_MUSIC ?? lib.root);
  return lib;
}

/** Finds `name` anywhere under `dir` (the tracks keep their own names, whatever folders they sit in). */
function findFile(dir, name, depth = 4) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  if (depth > 0) for (const e of entries) if (e.isDirectory()) {
    const hit = findFile(join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** A track of music.json with its file found: { id, path, title, author, licence, source, bpm, loop }, or null if the file isn't there. */
export function track(id) {
  const lib = musicLibrary();
  const t = lib.tracks[id];
  if (!t) throw new Error(`no track "${id}" in music.json`);
  const path = findFile(lib.root, t.file);
  return path ? { id, ...t, path } : null;
}

/** "Flags" by Alexander Ehlers (tricksntraps), CC0 1.0, https://… */
export function credit(t) {
  return `"${t.title}" by ${t.author} (${t.licence}), ${t.source}`;
}

/** The music's audio filters before loudness: trimmed to the film, faded in and out, `gain` dB. */
function musicChain(input, { from = 0, fadeIn = 0, fadeOut = 2, gain = 0 }, seconds) {
  const fades = [fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn}` : null, fadeOut > 0 ? `afade=t=out:st=${Math.max(0, seconds - fadeOut).toFixed(3)}:d=${fadeOut}` : null].filter(Boolean);
  return `[${input}:a]atrim=start=${from}:duration=${seconds.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo${fades.length ? `,${fades.join(',')}` : ''}${gain ? `,volume=${gain}dB` : ''}`;
}

/** Target loudness: -14 LUFS integrated (YouTube's reference; quiet enough for the page), peaks under -1.5 dBTP. */
export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 };

/** loudnorm's first pass over the music as the film plays it: what the second pass needs to hit LOUDNESS exactly. */
async function measure(music, seconds) {
  const log = await ffmpeg(['-stream_loop', '-1', '-i', music.path, '-filter_complex', `${musicChain(0, music, seconds)},loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json[a]`, '-map', '[a]', '-f', 'null', '-']);
  const json = log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------------------------
// Joining the shots
// ---------------------------------------------------------------------------------------------

/**
 * ffmpeg inputs and a filter graph that lays `clips` end to end at `width` × `height`, `fps`:
 * clips is [{ file, duration, overlap (a crossfade from the clip before, s), fadeIn, fadeOut (to
 * and from black, s) }]. `music` ({ path, from, fadeIn, fadeOut, gain, measured }) goes under it,
 * or silence. `ass` burns subtitles in (a file name, read from ffmpeg's working folder). The
 * graph's outputs are [v] and [a].
 */
export function joinGraph({ clips, width, height, fps, music = null, ass = null, seconds }) {
  const inputs = [];
  const parts = [];
  for (const [i, c] of clips.entries()) {
    inputs.push('-i', c.file);
    const fades = [c.fadeIn ? `fade=t=in:st=0:d=${c.fadeIn}` : null, c.fadeOut ? `fade=t=out:st=${(c.duration - c.fadeOut).toFixed(3)}:d=${c.fadeOut}` : null].filter(Boolean);
    parts.push(
      `[${i}:v]trim=duration=${c.duration.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB${fades.length ? `,${fades.join(',')}` : ''}[c${i}]`,
    );
  }
  let cur = 'c0';
  let len = clips[0].duration;
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i];
    const next = `j${i}`;
    if (c.overlap > 0) parts.push(`[${cur}][c${i}]xfade=transition=fade:duration=${c.overlap.toFixed(3)}:offset=${(len - c.overlap).toFixed(3)}[${next}]`);
    else parts.push(`[${cur}][c${i}]concat=n=2:v=1:a=0[${next}]`);
    len += c.duration - c.overlap;
    cur = next;
  }
  parts.push(`[${cur}]${ass ? `ass=filename=${ass},` : ''}format=yuv420p[v]`);
  if (music) {
    const m = clips.length;
    inputs.push('-stream_loop', '-1', '-i', music.path);
    const n = music.measured;
    const loud = n
      ? `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:measured_I=${n.input_i}:measured_TP=${n.input_tp}:measured_LRA=${n.input_lra}:measured_thresh=${n.input_thresh}:offset=${n.target_offset}:linear=true`
      : `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
    parts.push(`${musicChain(m, music, seconds)},${loud},aresample=48000[a]`);
  } else parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds.toFixed(3)}[a]`);
  return { inputs, graph: parts.join(';\n') };
}

/** Measures the music once for a film (the second loudnorm pass needs it). */
export async function prepareMusic(music, seconds) {
  if (!music) return null;
  return { ...music, measured: await measure(music, seconds) };
}

// The encodes. Bitrates are averages over the film (two passes for H.264, VBR for AV1): park
// footage with grass is costly, cards and slow pans are cheap, and the passes move the bits to
// where they're needed. 3.4 Mbit/s H.264 and 2.8 Mbit/s AV1, with 128 kbit/s AAC, keep a 75 s
// 1080p trailer at about 33 MB and 28 MB (the brief: 25–35 MB per format).
const COLOUR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const AAC = (kbps) => ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ar', '48000', '-ac', '2'];

export const ENCODES = {
  /** A copy to watch (out/, not published): plain CRF. */
  review: { video: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high'], audio: AAC(160) },
  /** A quick draft. */
  draft: { video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high'], audio: AAC(128) },
  /** The page's H.264 (two passes; High 4.0; a keyframe every 2 s for seeking). */
  h264: {
    video: ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level', '4.0', '-b:v', '3400k', '-maxrate', '8000k', '-bufsize', '16000k', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'],
    audio: AAC(128),
    twoPass: true,
  },
  /** The page's AV1 (SVT-AV1, visual-quality tuning, VBR). */
  av1: { video: ['-c:v', 'libsvtav1', '-preset', '5', '-b:v', '2800k', '-g', '60', '-svtav1-params', 'tune=0'], audio: AAC(128) },
  /** YouTube's upload: high-bitrate H.264, closed GOP of half the frame rate (YouTube's recommended settings), AAC-LC 48 kHz. */
  youtube: { video: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-maxrate', '16000k', '-bufsize', '32000k', '-profile:v', 'high', '-g', '15', '-bf', '2', '-flags', '+cgop'], audio: AAC(320) },
};

/**
 * Joins and encodes in one go: `cut` is joinGraph's options, `encode` an ENCODES key, written
 * to `out` with +faststart. Two-pass encodes run the graph twice (the first pass without audio).
 */
export async function render({ cut, encode, out, cwd }) {
  const { inputs, graph } = joinGraph(cut);
  const e = ENCODES[encode];
  const common = ['-filter_complex', graph, '-map', '[v]'];
  const tail = [...COLOUR, '-movflags', '+faststart', '-t', cut.seconds.toFixed(3)];
  if (e.twoPass) {
    const log = `${out}.pass`;
    await ffmpeg([...inputs, ...common, ...e.video, '-pass', '1', '-passlogfile', log, '-an', '-f', 'null', '-'], { cwd });
    await ffmpeg([...inputs, ...common, '-map', '[a]', ...e.video, '-pass', '2', '-passlogfile', log, ...e.audio, ...tail, out], { cwd });
    for (const f of readdirSync(dirname(log))) if (f.startsWith(basename(log))) rmSync(join(dirname(log), f), { force: true });
  } else await ffmpeg([...inputs, ...common, '-map', '[a]', ...e.video, ...e.audio, ...tail, out], { cwd });
  return probe(out);
}


/**
 * The hero's silent loop from `segments` ([{ file, from, seconds }]): crossfaded one into the
 * next and the last back into the first, so it loops without a seam, at 1280 × 720 with no
 * sound. Writes `outH264` and `outAv1`.
 */
export async function loop({ segments, fps, xfade = 0.8, outH264, outAv1 }) {
  // the first segment again at the end, crossfaded in; the film then starts `xfade` into itself,
  // so its last frame runs straight on to its first
  const all = [...segments, { ...segments[0], seconds: xfade + 1 / fps }];
  const inputs = [];
  const parts = [];
  for (const [i, s] of all.entries()) {
    inputs.push('-ss', String(s.from), '-t', String(s.seconds), '-i', s.file);
    parts.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${fps},scale=1280:720:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB[s${i}]`);
  }
  let cur = 's0';
  let len = all[0].seconds;
  for (let i = 1; i < all.length; i++) {
    parts.push(`[${cur}][s${i}]xfade=transition=fade:duration=${xfade}:offset=${(len - xfade).toFixed(3)}[l${i}]`);
    len += all[i].seconds - xfade;
    cur = `l${i}`;
  }
  const total = len - xfade - 1 / fps;
  parts.push(`[${cur}]trim=start=${xfade}:duration=${total.toFixed(3)},setpts=PTS-STARTPTS[v]`);
  const graph = parts.join(';');
  await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-maxrate', '1500k', '-bufsize', '3000k', '-profile:v', 'high', '-level', '4.0', '-g', '60', ...COLOUR, '-movflags', '+faststart', outH264]);
  await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'libsvtav1', '-preset', '5', '-crf', '42', '-g', '60', '-svtav1-params', 'tune=0:mbr=1200', ...COLOUR, '-movflags', '+faststart', outAv1]);
  return { seconds: total, h264: probe(outH264), av1: probe(outAv1) };
}

/** One frame of `file` at `seconds`, as a PNG at `out`. */
export function frame(file, seconds, out) {
  return ffmpeg(['-ss', seconds.toFixed(3), '-i', file, '-frames:v', '1', out]);
}

/**
 * The font the contact sheets stamp their times in, named outright: drawtext left to find a font
 * itself asks fontconfig, which Windows builds of ffmpeg ship without a config for, and ffmpeg
 * crashes. With none of these the times are left off.
 */
const STAMP_FONT = ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'].find((f) => existsSync(f));

/**
 * A contact sheet of `file`: `count` frames spread over it (or at `times`), `cols` across, each
 * `width` wide, with the time stamped on each. For reviewing a render by eye.
 */
export async function contactSheet(file, out, { count = 12, cols = 4, width = 480, times = null } = {}) {
  const { duration } = probe(file);
  const at = times ?? Array.from({ length: count }, (_, i) => ((i + 0.5) * duration) / count);
  const inputs = [];
  const parts = [];
  // (the drive's colon escaped, as filter options need)
  const font = STAMP_FONT ? `fontfile='${STAMP_FONT.replace(/:/g, '\\:')}':` : null;
  for (const [i, t] of at.entries()) {
    inputs.push('-ss', t.toFixed(3), '-i', file);
    const stamp = font ? `,drawtext=${font}text='${t.toFixed(1)}s':x=8:y=8:fontsize=${Math.round(width / 18)}:fontcolor=white:box=1:boxcolor=black@0.6` : '';
    parts.push(`[${i}:v]trim=end_frame=1,scale=${width}:-2${stamp}[f${i}]`);
  }
  const rows = Math.ceil(at.length / cols);
  const layout = at.map((_, i) => `${(i % cols) === 0 ? '0' : Array.from({ length: i % cols }, () => 'w0').join('+')}_${Math.floor(i / cols) === 0 ? '0' : Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+')}`).join('|');
  parts.push(`${at.map((_, i) => `[f${i}]`).join('')}xstack=inputs=${at.length}:layout=${layout}:fill=black[v]`);
  await ffmpeg([...inputs, '-filter_complex', parts.join(';'), '-map', '[v]', '-frames:v', '1', '-q:v', '3', out]);
  return { out, rows, times: at };
}

/** Bytes of a file, or 0. */
export function size(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
