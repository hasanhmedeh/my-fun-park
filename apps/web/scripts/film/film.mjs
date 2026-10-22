// Films a video from its shot list (scripts/film/shots/<id>.mjs): each shot staged in the game and
// filmed frame by frame on the film clock (lib/capture.mjs), the cards drawn as HTML, the shots
// joined with their cuts, crossfades and fades, the music laid under at a steady loudness, then
// encoded for wherever the film goes.
//
//   node scripts/film/film.mjs <id>                  the whole film at 1920 × 1080, into scripts/film/out/<id>/
//   node scripts/film/film.mjs <id> --draft          half size (960 × 540: the same picture, drawn at half the pixels),
//                                                    quick encodes, English subtitles burnt in
//   node scripts/film/film.mjs <id> --size 1080x1920 vertical (each shot's `vertical` settings apply)
//   node scripts/film/film.mjs <id> --to <shot>      a partial cut: the shots up to this one (--from <shot>, --only a,b)
//   node scripts/film/film.mjs <id> --refilm         film the chosen shots again, even if they're cached
//   node scripts/film/film.mjs <id> --check          no video: the first, middle and last frame of each shot
//   node scripts/film/film.mjs <id> --lint           the checks only (lengths, chapters, subtitles, every language's words)
//   node scripts/film/film.mjs <id> --burn fr        subtitles in French burnt into the picture (none: no subtitles)
//   node scripts/film/film.mjs <id> --out <dir>      the outputs somewhere else
//   node scripts/film/film.mjs <id> --dpr 2          the game drawn at twice the pixels and scaled down (smoother edges, ~3x slower)
//   node scripts/film/film.mjs <id> --publish --date 2026-11-02
//                                                    the page's files: H.264 and AV1 MP4s, posters and WebVTT,
//                                                    content-hashed in public/media/videos/, and src/landing/media.json
//   node scripts/film/film.mjs trailer --loop [--publish --date …]
//                                                    the hero's silent loop, from the trailer's `loop` segments
//
// Each shot is filmed once per size and kept (out/<id>/cache/<size>/<shot>.<hash>.mp4, the hash
// taken over everything that shapes the shot), so changing one shot films that one again and the
// rest come from the cache. The game's dev server must be up (lib/session.mjs GAME_URL).
//
// A shot list is a module whose default export is:
//
//   { id, kind: 'trailer' | 'tutorial' | 'vertical', fps: 30, size: [w, h],
//     music: { track, from, fadeIn, fadeOut, gain },      a track of music.json (bpm comes from there)
//     session: { api, enter, touch, storage, url, hour },  how the game is opened (openGame's options)
//     defaults: { … },                                    any shot setting, for every shot
//     helpers() { … },                                    page code run once per session (window.__shots…)
//     poster: { shot, at },                               the frame the page's poster is cut from
//     thumbnail: { kicker, words },                       YouTube's thumbnail words (youtube.mjs)
//     textFrom: id,                                       another video's words (the vertical teaser: the trailer's)
//     loop: [{ shot, from, seconds }],                    the hero loop's segments (the trailer)
//     shots: [ … ] }
//
// and each shot:
//
//   id, duration (s) or beats (of the music), chapter, cues: [{ id, at, end | dur }] (s from the shot's start)
//   in: 'cut' | { xfade: s } | { fade: s },  out: { fade: s }
//   card: { type: 'sting' | 'end', icon, still }       an HTML card instead of the game
//   hour, ui: 'clean' | 'game', hide (people within m of the lens not drawn), visitor (true/false),
//   fov, settle (frames drawn before filming), reset (back on foot first; default true), seed
//   setup()                                            page code (it runs in the game's page, so it can use
//                                                      only __game, __director, __film, __stills and the
//                                                      list's helpers); may return a camera
//   camera: { fixed: { pos, look } } | { path: keys, ease } | { orbit } | { follow } | { game: true }
//   hints: rows | { rows, at }                         the keycaps (director.hints)
//   overlay: { title: { seconds, delay } }             the trailer's title over the shot
//   cursor, fingers, pointer: [x, y]                   the drawn mouse pointer / fingertips, and where it starts
//   actions: [{ t, … }]                                timed input: see run() below
//   vertical: { … }                                    settings that replace these in a portrait film
//   session: { … }                                     a shot that needs the game opened otherwise (touch, a member)

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { record } from './lib/capture.mjs';
import { checkFonts, endCard, page as cardPage, stingCard, titleOverlay, WEB, WEB_URL } from './lib/cards.mjs';
import { launch } from './lib/chrome.mjs';
import { CLOCK_SCRIPT } from './lib/clock.mjs';
import { contactSheet, frame, hash, loop as loopFilm, musicLibrary, prepareMusic, probe, render, track } from './lib/media.mjs';
import { GAME_URL, openGame } from './lib/session.mjs';
import { layout, lint, RTL, toAss, toVtt } from './lib/timeline.mjs';
import { installStills } from './stills.mjs';

export const FILM = dirname(fileURLToPath(import.meta.url));
export const CONTENT = join(WEB, 'src/landing/content');
export const MEDIA_DIR = join(WEB, 'public/media/videos');
export const MEDIA_JSON = join(WEB, 'src/landing/media.json');
export const LANGS = ['en', 'fr', 'ar'];
/** The site's address, as the end card shows it (SITE_URL, as vite.config.ts reads it, else the Vercel one). */
export const SITE_URL = (process.env.SITE_URL ?? 'https://hasanhmedeh.vercel.app').replace(/\/$/, '');
export const DOMAIN = new URL(SITE_URL).host;
/** Changes whenever the way shots are filmed changes, so the cache doesn't hand back old ones. */
const CACHE_VERSION = 4;
const FULL = [1920, 1080];

// ---------------------------------------------------------------------------------------------
// Shot lists and their words
// ---------------------------------------------------------------------------------------------

/** A shot list with its music's tempo filled in from music.json. */
export async function loadList(id) {
  const file = join(FILM, 'shots', `${id}.mjs`);
  if (!existsSync(file)) {
    const known = readdirSync(join(FILM, 'shots')).map((f) => f.replace(/\.mjs$/, ''));
    throw new Error(`no shot list "${id}" (there are: ${known.join(', ')})`);
  }
  const list = (await import(pathToFileURL(file).href)).default;
  list.fps ??= 30;
  list.defaults ??= {};
  list.session ??= {};
  if (list.music) {
    const info = musicLibrary().tracks[list.music.track];
    if (!info) throw new Error(`${id}: no track "${list.music.track}" in music.json`);
    list.music = { bpm: info.bpm, firstBeat: info.firstBeat ?? 0, ...list.music };
  }
  return list;
}

/** content/videos.<lang>.json's text for `id`, per language (null where a language hasn't got it). */
export function texts(id) {
  const out = {};
  for (const lang of LANGS) {
    const file = join(CONTENT, `videos.${lang}.json`);
    out[lang] = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8'))[id] ?? null) : null;
  }
  return out;
}

/** The video's text in content/: a vertical teaser borrows its parent's (the trailer's). */
export const textId = (list) => list.textFrom ?? list.id;

/** A shot with the list's defaults under it and, in a portrait film, its `vertical` settings over it. */
export function resolveShot(list, shot, { vertical = false } = {}) {
  const { vertical: v, ...rest } = shot;
  return { ...list.defaults, ...rest, ...(vertical && v ? v : {}) };
}

/** The game's options for a shot (the list's session, the shot's own over it). */
function sessionOf(list, shot) {
  return { ...list.session, ...(shot.session ?? {}) };
}

/** Page code as an expression: a method (`setup() {…}`) becomes a function expression. */
export function pageSource(fn) {
  const src = fn.toString();
  if (/^(async\s*)?(\(|function\b|[\w$]+\s*=>)/.test(src)) return src;
  return src.replace(/^(async\s+)?[\w$]+\s*\(/, (_m, a) => `${a ?? ''}function (`);
}

const stringify = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'function' ? x.toString() : x));

/** The shots chosen by --only / --from / --to, in list order. */
export function choose(list, { only = null, from = null, to = null } = {}) {
  const ids = list.shots.map((s) => s.id);
  for (const id of [...(only ?? []), from, to].filter(Boolean)) if (!ids.includes(id)) throw new Error(`${list.id}: no shot "${id}"`);
  if (only) return list.shots.filter((s) => only.includes(s.id));
  const a = from ? ids.indexOf(from) : 0;
  const b = to ? ids.indexOf(to) : ids.length - 1;
  return list.shots.slice(a, b + 1);
}

// ---------------------------------------------------------------------------------------------
// Filming
// ---------------------------------------------------------------------------------------------

/** Where a shot's take is kept: its hash covers the shot, the list's session and helpers, the size and the game. */
function cachePath(list, shot, { width, height, scale, dpr, cacheDir, youtube = false }) {
  const key = stringify({ v: CACHE_VERSION, shot: resolveShot(list, shot, { vertical: height > width }), session: shot.card ? null : sessionOf(list, shot), helpers: list.helpers ?? null, width, height, scale, dpr, fps: list.fps, game: shot.card ? null : GAME_URL, youtube });
  return join(cacheDir, `${shot.id}${youtube ? '.yt' : ''}.${hash(key, 10, { text: true })}.mp4`);
}

/** A whole number from a shot's id: its Math.random sequence (lib/clock.mjs seed). */
const seedOf = (id) => parseInt(hash(id, 8, { text: true }), 16);

/** Back on foot, the camera handed back, no dialog open, nothing frozen, held or drawn over the picture. */
async function reset(page) {
  await page.evaluate(() => {
    window.__stills.release();
    __director.release();
    __director.still();
    __director.hints(null);
    __director.overlay(null);
    const g = __game;
    __director.fades(false);
    if (g.mode === 'workshop') g.leaveWorkshop(true);
    else if (g.mode === 'dressing') g.leaveDressing?.(false);
    else if (g.mode !== 'drive') __director.leave({ fade: false });
    // (Crate Smash is played on foot: a round still running is stopped, as Esc stops it)
    else if (g.round?.ride === 'crates') g.leave(false);
    __director.fades(true);
    g.ui.hidePanel?.();
    __director.camera(null);
    __film.advance(0.5);
    // a round's results screen (or any other dialog) shut, as Esc shuts it
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    __film.advance(0.1);
  });
}

/** The page call that starts a camera (a setting of the shot list's). */
function cameraCall(cam) {
  if (!cam) return null;
  if (cam.game) return '__director.camera(null)';
  if (cam.fixed) return `__director.camera(${JSON.stringify(cam.fixed.pos)}, ${JSON.stringify(cam.fixed.look)})`;
  if (cam.path) return `__director.path(${JSON.stringify(cam.path)}, { ease: ${!!cam.ease} })`;
  if (cam.orbit) return `__director.orbit(${JSON.stringify(cam.orbit)})`;
  if (cam.follow) return `__director.follow(${JSON.stringify(cam.follow)})`;
  throw new Error(`a camera that's none of fixed, path, orbit, follow or game: ${JSON.stringify(cam)}`);
}

/**
 * Where a target is on the page, in CSS pixels: a selector's centre, { sel, text, dx, dy } (the
 * first of sel's elements whose text has `text` in it, moved by dx, dy), or [x, y] (fractions of the
 * page when both are ≤ 1, else CSS pixels).
 */
async function where(page, target, { width, height }) {
  if (Array.isArray(target)) {
    const [x, y] = target;
    return x <= 1 && y <= 1 ? { x: x * width, y: y * height } : { x, y };
  }
  const sel = typeof target === 'string' ? target : target.sel;
  const r = await page.rect(sel, target.text ?? null);
  if (!r) throw new Error(`nothing on the page at "${sel}"${target.text ? ` with "${target.text}" in it` : ''}`);
  return { x: r.cx + (target.dx ?? 0), y: r.cy + (target.dy ?? 0) };
}

const ease = (u) => u * u * (3 - 2 * u);

/**
 * The shot's timed input, as record()'s `before(i, t)`. Each action starts at its `t` (seconds
 * from the shot's start); those that take time (a pointer gliding, a drag, typing) carry on over
 * the frames after it:
 *   { hold: 'KeyW', for: 2 } · { tap: 'KeyE' } · { down: 'KeyW' } · { up: 'KeyW' } · { release: true }
 *   { move: target, glide } · { click: target, glide } · { drag: { from, to, seconds } }
 *   { wheel: deltaY, times, every (frames), at: target } · { type: 'text', cps }
 *   { touch: { from, to, seconds, hold } } (a finger: the joystick, a swipe) · { touchTap: target }
 *   { hints: rows | null, at } · { camera } · { fov } · { cursor } · { fingers } · { page: fn | 'code', args }
 */
function run(page, actions, size, fps) {
  const pending = [...(actions ?? [])].sort((a, b) => a.t - b.t);
  const motions = [];
  const pointer = page.pointer;
  const glideTo = (to, frames, i, { buttons = 0, then = null } = {}) => {
    const from = { ...pointer };
    const end = i + Math.max(1, frames);
    motions.push({
      end,
      async frame(k) {
        const u = ease(Math.min(1, (k - i) / Math.max(1, frames)));
        pointer.x = from.x + (to.x - from.x) * u;
        pointer.y = from.y + (to.y - from.y) * u;
        await page.mouse('mouseMoved', pointer.x, pointer.y, { buttons });
        if (k >= end && then) await then();
      },
    });
  };
  async function start(a, i) {
    const frames = (s) => Math.round((s ?? 0) * fps);
    if (a.hold) await page.evaluate(`__director.hold(${JSON.stringify(a.hold)}, ${a.for ?? 1})`);
    else if (a.tap) await page.evaluate(`__director.tap(${JSON.stringify(a.tap)})`);
    else if (a.down) await page.evaluate(`__director.key(${JSON.stringify(a.down)}, true)`);
    else if (a.up) await page.evaluate(`__director.key(${JSON.stringify(a.up)}, false)`);
    else if (a.release) await page.evaluate('__director.release()');
    else if (a.move) glideTo(await where(page, a.move, size), frames(a.glide ?? 0.6), i);
    else if (a.click) {
      const to = await where(page, a.click, size);
      glideTo(to, frames(a.glide ?? 0.6), i, {
        then: async () => {
          await page.mouse('mousePressed', to.x, to.y, { buttons: 1 });
          await page.mouse('mouseReleased', to.x, to.y, { buttons: 0 });
        },
      });
    } else if (a.drag) {
      const from = a.drag.from ? await where(page, a.drag.from, size) : { ...pointer };
      const to = a.drag.to ? await where(page, a.drag.to, size) : { x: from.x + (a.drag.by?.[0] ?? 0) * size.width, y: from.y + (a.drag.by?.[1] ?? 0) * size.height };
      Object.assign(pointer, from);
      await page.mouse('mouseMoved', from.x, from.y);
      await page.mouse('mousePressed', from.x, from.y, { buttons: 1 });
      glideTo(to, frames(a.drag.seconds ?? 1), i, { buttons: 1, then: () => page.mouse('mouseReleased', to.x, to.y, { buttons: 0 }) });
    } else if (a.wheel !== undefined) {
      const at = a.at ? await where(page, a.at, size) : { ...pointer };
      const times = a.times ?? 1;
      const every = a.every ?? 3;
      motions.push({
        end: i + (times - 1) * every,
        async frame(k) {
          if ((k - i) % every === 0 && k - i < times * every) await page.mouse('mouseWheel', at.x, at.y, { deltaY: a.wheel });
        },
      });
    } else if (a.type !== undefined) {
      const chars = [...a.type];
      const every = Math.max(1, Math.round(fps / (a.cps ?? 12)));
      motions.push({
        end: i + (chars.length - 1) * every,
        async frame(k) {
          const n = k - i;
          if (n % every === 0 && n / every < chars.length) await page.insertText(chars[n / every]);
        },
      });
    } else if (a.touch) {
      const from = await where(page, a.touch.from, size);
      const to = a.touch.to ? await where(page, a.touch.to, size) : { x: from.x + (a.touch.by?.[0] ?? 0), y: from.y + (a.touch.by?.[1] ?? 0) };
      const move = frames(a.touch.seconds ?? 0.4);
      const hold = frames(a.touch.hold ?? 0);
      await page.touch('touchStart', [{ x: from.x, y: from.y }]);
      motions.push({
        end: i + move + hold,
        async frame(k) {
          const n = k - i;
          if (n > move + hold) return;
          if (n === move + hold) return page.touch('touchEnd', []);
          const u = ease(Math.min(1, n / Math.max(1, move)));
          await page.touch('touchMove', [{ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u }]);
        },
      });
    } else if (a.touchTap) {
      const at = await where(page, a.touchTap, size);
      await page.touch('touchStart', [at]);
      motions.push({ end: i + 3, frame: (k) => (k === i + 3 ? page.touch('touchEnd', []) : null) });
    } else if (a.hints !== undefined) await page.evaluate(`__director.hints(${JSON.stringify(a.hints)}, { at: ${JSON.stringify(a.at ?? 'right')} })`);
    else if (a.camera) await page.evaluate(cameraCall(a.camera));
    else if (a.fov) await page.evaluate(`__director.fov(${a.fov})`);
    else if (a.cursor !== undefined) await page.evaluate(`(__director.cursor(${!!a.cursor}), __director.cursorAt(${pointer.x}, ${pointer.y}))`);
    else if (a.fingers !== undefined) await page.evaluate(`__director.fingers(${!!a.fingers})`);
    else if (a.page) await page.evaluate(typeof a.page === 'function' ? `(${pageSource(a.page)})(...${JSON.stringify(a.args ?? [])})` : a.page);
    else throw new Error(`an action that does nothing: ${stringify(a)}`);
  }
  return async (i, t) => {
    while (pending.length && pending[0].t <= t + 1e-6) await start(pending.shift(), i);
    for (const m of [...motions]) {
      await m.frame(i);
      if (i >= m.end) motions.splice(motions.indexOf(m), 1);
    }
  };
}

/** Stages one shot in the game's page and films it into `file` (or, `check`, keeps three frames). */
async function filmShot(page, list, shot, seconds, { file, width, height, fps, draft, check }) {
  const s = resolveShot(list, shot, { vertical: height > width });
  if (s.reset !== false) await reset(page);
  await page.evaluate(`__film.seed(${s.seed ?? seedOf(shot.id)})`);
  await page.evaluate(
    ({ hour, hide, clean, visitor }) => {
      if (hour !== null) __director.hour(hour);
      __director.hidePeople(hide);
      __director.clean(clean);
      __director.visitor(visitor);
    },
    { hour: s.hour ?? null, hide: s.hide ?? 0, clean: (s.ui ?? 'clean') === 'clean', visitor: s.visitor ?? true },
  );
  const result = s.setup ? await page.evaluate(`(${pageSource(s.setup)})(${JSON.stringify(s.args ?? null)})`) : null;
  const cam = result?.camera ?? (result?.pos ? { fixed: result } : null) ?? s.camera ?? null;
  const call = cameraCall(cam);
  if (call) await page.evaluate(call);
  if (s.fov) await page.evaluate(`__director.fov(${s.fov})`);
  await page.evaluate(`__film.advance(${(s.settle ?? 8) / 30})`);
  // a move starts on the first filmed frame (the settle drew from its first key)
  if (cam?.path || cam?.orbit) await page.evaluate(call);
  if (s.fov) await page.evaluate(`__director.fov(${s.fov})`);
  const pointer = s.pointer ? await where(page, s.pointer, { width, height }) : null;
  if (pointer) Object.assign(page.pointer, pointer);
  await page.evaluate(`(__director.cursor(${!!s.cursor}), __director.cursorAt(${page.pointer.x}, ${page.pointer.y}), __director.fingers(${!!s.fingers}))`);
  if (pointer) await page.mouse('mouseMoved', pointer.x, pointer.y);
  const hints = Array.isArray(s.hints) ? { rows: s.hints } : s.hints;
  await page.evaluate(`__director.hints(${JSON.stringify(hints?.rows ?? null)}, { at: ${JSON.stringify(hints?.at ?? 'right')} })`);
  if (s.overlay?.title) {
    const o = titleOverlay(s.overlay.title);
    await page.evaluate(`(__director.overlay(${JSON.stringify(o.html)}, ${JSON.stringify(o.css)}), document.getElementById('film-overlay').classList.add('play'))`);
  }
  const frames = Math.round(seconds * fps);
  const keep = check ? new Set([0, Math.floor(frames / 2), frames - 1]) : null;
  const kept = [];
  const timing = await record(page, {
    seconds,
    fps,
    out: check ? null : file,
    before: run(page, s.actions, { width, height }, fps),
    encode: draft ? { crf: 20, preset: 'veryfast' } : { crf: 16, preset: 'faster' },
    keep: keep ? (i) => keep.has(i) : null,
    onFrame: keep ? (i, buf) => kept.push(buf) : null,
  });
  await page.evaluate('(__director.release(), __director.overlay(null))');
  return { timing, kept };
}

/** Films a card (the sting, the end card) as an HTML page in its own Chrome, `seconds` long. */
async function filmCard(cardChrome, list, shot, seconds, { file, width, height, fps, draft, check, youtube = false }) {
  const s = resolveShot(list, shot, { vertical: height > width });
  const c = s.card;
  const card = c.type === 'sting' ? stingCard({ icon: c.icon, still: c.still, seconds }) : endCard({ domain: DOMAIN, still: c.still, layout: youtube ? 'youtube' : 'site' });
  await cardChrome.setContent(cardPage(card, { width, height }), WEB_URL);
  await checkFonts(cardChrome);
  await cardChrome.evaluate('__film.freeze()');
  await cardChrome.evaluate('document.body.classList.add("play")');
  const frames = Math.round(seconds * fps);
  const keep = check ? new Set([0, Math.floor(frames / 2), frames - 1]) : null;
  const kept = [];
  const timing = await record(cardChrome, {
    seconds,
    fps,
    out: check ? null : file,
    encode: draft ? { crf: 20, preset: 'veryfast' } : { crf: 16, preset: 'faster' },
    keep: keep ? (i) => keep.has(i) : null,
    onFrame: keep ? (i, buf) => kept.push(buf) : null,
  });
  return { timing, kept };
}

/** Chrome's log, without the shader compiler's warnings (D3D's precision notes on every program). */
const chromeLog = (verbose) => (line) => {
  if (/X4122|Program Info Log|warning X\d+/.test(line)) return;
  if (verbose || /error|failed|uncaught/i.test(line)) console.log(`  ${line.slice(0, 300)}`);
};

/**
 * Makes sure every shot in `shots` has a take at this size, filming the missing ones (or all of
 * them, `refilm`): the game is opened once per session the shots need, the cards in a Chrome of
 * their own. `overrides` (shot id → settings) changes shots for this film only (YouTube's longer
 * end card). Returns shot id → file, and the filming times.
 */
export async function filmShots(list, shots, { width, height, scale = 1, dpr = 1, draft = false, refilm = false, check = false, checkDir = null, verbose = false, overrides = {}, youtube = false }) {
  const fps = list.fps;
  // (YouTube's cut shares the game's takes: only its cards differ, kept under their own names)
  const cacheDir = join(FILM, 'out', list.id, 'cache', `${width * scale}x${height * scale}${dpr > 1 ? `@${dpr}` : ''}`);
  mkdirSync(cacheDir, { recursive: true });
  const files = {};
  const todo = [];
  for (const raw of shots) {
    const shot = overrides[raw.id] ? { ...raw, ...overrides[raw.id] } : raw;
    const file = cachePath(list, shot, { width, height, scale, dpr, cacheDir, youtube: youtube && !!shot.card });
    files[raw.id] = file;
    if (check || refilm || !existsSync(file)) todo.push({ shot, file, seconds: layoutSeconds(list, shot) });
  }
  const stats = [];
  if (!todo.length) return { files, stats };
  // the game's shots, a session at a time (in list order within each), then the cards
  const groups = new Map();
  for (const job of todo) {
    if (job.shot.card) continue;
    const key = stringify(sessionOf(list, job.shot));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const sheets = [];
  const finish = async (job, result, t0) => {
    const wall = (Date.now() - t0) / 1000;
    stats.push({ shot: job.shot.id, seconds: job.seconds, wall, perSecond: wall / job.seconds });
    console.log(`  ${job.shot.id}: ${job.seconds.toFixed(2)} s filmed in ${wall.toFixed(1)} s (${(wall / job.seconds).toFixed(1)} s a second)${check ? '' : `, game dt ${result.timing.gameDt.min}–${result.timing.gameDt.max}`}`);
    if (check) sheets.push({ id: job.shot.id, frames: result.kept });
    else {
      // only the newest take of each shot is kept
      // (a card's YouTube take, <id>.yt.<hash>.mp4, is a shot of its own)
      const kind = (f) => f.slice(job.shot.id.length).startsWith('.yt.');
      for (const f of readdirSync(cacheDir)) if (f.startsWith(`${job.shot.id}.`) && kind(f) === kind(basename(job.file)) && join(cacheDir, f) !== job.file) rmSync(join(cacheDir, f), { force: true });
    }
  };
  for (const [key, jobs] of groups) {
    const sess = JSON.parse(key);
    const t0 = Date.now();
    const page = await openGame({
      width,
      height,
      scale,
      // (the game draws at the picture's own pixels: half of them in a draft)
      dpr: dpr * scale,
      quality: 'high',
      hour: sess.hour ?? 16,
      clean: false,
      api: sess.api ?? false,
      enter: sess.enter ?? true,
      touch: !!sess.touch,
      storage: sess.storage ?? null,
      url: sess.url ?? GAME_URL,
      log: chromeLog(verbose),
    });
    try {
      console.log(`the game is up in ${((Date.now() - t0) / 1000).toFixed(0)} s (${JSON.stringify(page.settings)}${sess.touch ? ', touch' : ''}${sess.api ? ', a pretend member' : ''})`);
      await page.evaluate(`(${installStills})()`);
      if (list.helpers) await page.evaluate(`(${pageSource(list.helpers)})()`);
      await page.evaluate('__film.freeze()');
      page.pointer = { x: width / 2, y: height * 0.55 };
      for (const job of jobs) {
        const t1 = Date.now();
        const result = await filmShot(page, list, job.shot, job.seconds, { file: job.file, width, height, fps, draft, check });
        await finish(job, result, t1);
      }
    } finally {
      await page.close();
    }
  }
  const cards = todo.filter((j) => j.shot.card);
  if (cards.length) {
    const chrome = await launch({ width, height, scale, log: chromeLog(verbose) });
    try {
      await chrome.addInitScript(CLOCK_SCRIPT);
      for (const job of cards) {
        const t1 = Date.now();
        const result = await filmCard(chrome, list, job.shot, job.seconds, { file: job.file, width, height, fps, draft, check, youtube });
        await finish(job, result, t1);
      }
    } finally {
      await chrome.close();
    }
  }
  if (check) await checkSheets(list, sheets, checkDir, width * scale);
  return { files, stats };
}

/** A shot's length as the cut lays it (its duration or beats). */
const layoutSeconds = (list, shot) => layout({ ...list, shots: [shot] }).duration;

/** Each shot's first, middle and last frame side by side, one picture per shot, in `dir`. */
async function checkSheets(list, sheets, dir, width) {
  mkdirSync(dir, { recursive: true });
  const w = Math.min(640, width);
  for (const [n, s] of list.shots.filter((x) => sheets.some((y) => y.id === x.id)).entries()) {
    const { frames } = sheets.find((y) => y.id === s.id);
    const tiles = await Promise.all(frames.map((f) => sharp(f).resize({ width: w }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })));
    const h = tiles[0].info.height;
    const out = join(dir, `${String(n + 1).padStart(2, '0')}-${s.id}.jpg`);
    await sharp({ create: { width: w * tiles.length + 8 * (tiles.length - 1), height: h, channels: 3, background: '#000' } })
      .composite(tiles.map((t, i) => ({ input: t.data, left: i * (w + 8), top: 0 })))
      .jpeg({ quality: 85 })
      .toFile(out);
  }
  console.log(`check frames in ${dir}`);
}

// ---------------------------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------------------------

/**
 * What ffmpeg needs to join `shots` into a film: the clips, the music (measured for its second
 * loudness pass, starting where this part of the film starts in the whole one) and the layout.
 */
export async function cut(list, shots, files, { width, height, overrides = {} }) {
  const resolved = shots.map((s) => (overrides[s.id] ? { ...s, ...overrides[s.id] } : s));
  const lay = layout(list, resolved);
  const whole = layout(list, list.shots.map((s) => (overrides[s.id] ? { ...s, ...overrides[s.id] } : s)));
  const offset = whole.shots.find((p) => p.shot.id === resolved[0].id)?.start ?? 0;
  const clips = lay.shots.map((p) => ({
    file: files[p.shot.id],
    duration: p.duration,
    overlap: p.overlap,
    fadeIn: typeof p.shot.in === 'object' && p.shot.in.fade ? p.shot.in.fade : 0,
    fadeOut: p.shot.out?.fade ?? 0,
  }));
  let music = null;
  if (list.music) {
    const t = track(list.music.track);
    if (!t) console.warn(`  the music (${list.music.track}) isn't under ${musicLibrary().root}: the film is silent`);
    else music = await prepareMusic({ ...list.music, path: t.path, from: (list.music.from ?? 0) + offset, credit: t }, lay.duration);
  }
  return { lay, clips, music, width, height, fps: list.fps };
}

/** Writes the film's subtitles for `lang` as ASS beside `out` (for burning in) and returns its file name, or null. */
function burnFile(list, lay, lang, dir, { width, height }) {
  const words = texts(textId(list))[lang];
  if (!lang || lang === 'none' || !lay.cues.length || !words?.captions) return null;
  const name = `${list.id}.${lang}.${width}x${height}.ass`;
  writeFileSync(join(dir, name), toAss(lay.cues, words.captions, lang, { width, height }));
  return name;
}

/** The WebVTT for each language that has words for every cue: lang → text. */
export function captionFiles(list, lay) {
  const out = {};
  if (!lay.cues.length) return out;
  const all = texts(textId(list));
  for (const lang of LANGS) {
    const words = all[lang]?.captions;
    if (words && lay.cues.every((c) => words[c.id])) out[lang] = toVtt(lay.cues, words, lang);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Publishing (the page's files and media.json)
// ---------------------------------------------------------------------------------------------

/** Renames `file` to carry its content hash (`<base>.<hash><ext>`), and returns the new name. */
function hashed(file, base, ext) {
  const name = `${base}.${hash(file)}${ext}`;
  renameSync(file, join(dirname(file), name));
  return name;
}

/** The poster at 1280 and 1920 wide in AVIF, WebP and JPEG, content-hashed, from a PNG frame. */
async function posters(png, base) {
  const out = [];
  for (const w of [1280, 1920]) {
    const img = sharp(png).resize({ width: w, kernel: 'lanczos3' });
    const kinds = [
      ['avif', 'image/avif', (i) => i.avif({ quality: 55, effort: 6 })],
      ['webp', 'image/webp', (i) => i.webp({ quality: 80, effort: 6 })],
      ['jpg', 'image/jpeg', (i) => i.jpeg({ quality: 84, mozjpeg: true })],
    ];
    for (const [ext, type, enc] of kinds) {
      const buf = await enc(img.clone()).toBuffer();
      const name = `${base}-${w}.${hash(buf, 8, { text: true })}.${ext}`;
      writeFileSync(join(MEDIA_DIR, name), buf);
      out.push({ src: `/media/videos/${name}`, width: w, height: Math.round((w * 9) / 16), type });
    }
  }
  return out;
}

/** media.json as it is (or empty), and a writer that keeps it tidy. */
function manifest() {
  const m = existsSync(MEDIA_JSON) ? JSON.parse(readFileSync(MEDIA_JSON, 'utf8')) : { videos: {} };
  m.videos ??= {};
  return { m, save: () => writeFileSync(MEDIA_JSON, `${JSON.stringify(m, null, 2)}\n`) };
}

/** Removes the files of `prefix` in public/media/videos/ that `keep` doesn't list (the old versions). */
function sweep(prefix, keep) {
  if (!existsSync(MEDIA_DIR)) return;
  for (const f of readdirSync(MEDIA_DIR)) if (f.startsWith(prefix) && !keep.has(f)) rmSync(join(MEDIA_DIR, f), { force: true });
}

const H264_TYPE = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
const AV1_TYPE = 'video/mp4; codecs="av01.0.08M.08, mp4a.40.2"';

/** Encodes the film for the page (AV1 first, H.264 after it), its posters and captions, and records it in media.json. */
async function publish(list, c, { date, tmp }) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const id = list.id;
  const sources = [];
  const t0 = Date.now();
  for (const [encode, ext, type] of [
    ['av1', '.av1.mp4', AV1_TYPE],
    ['h264', '.mp4', H264_TYPE],
  ]) {
    const file = join(MEDIA_DIR, `${id}.new${ext}`);
    const info = await render({ cut: { ...c, seconds: c.lay.duration }, encode, out: file, cwd: tmp });
    const name = hashed(file, id, ext);
    sources.push({ src: `/media/videos/${name}`, type, width: info.video.width, height: info.video.height, bytes: info.bytes });
    console.log(`  ${encode}: ${(info.bytes / 1e6).toFixed(1)} MB, ${((info.bytes * 8) / info.duration / 1e6).toFixed(2)} Mbit/s (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  // the poster: the list's chosen frame of the H.264
  const at = list.poster ? (c.lay.shots.find((p) => p.shot.id === list.poster.shot)?.start ?? 0) + (list.poster.at ?? 0) : c.lay.duration * 0.3;
  const png = join(tmp, `${id}.poster.png`);
  await frame(join(MEDIA_DIR, sources[1].src.split('/').pop()), at, png);
  const poster = await posters(png, `${id}.poster`);
  rmSync(png, { force: true });
  const captions = {};
  for (const [lang, vtt] of Object.entries(captionFiles(list, c.lay))) {
    const name = `${id}.${lang}.${hash(vtt, 8, { text: true })}.vtt`;
    writeFileSync(join(MEDIA_DIR, name), vtt);
    captions[lang] = `/media/videos/${name}`;
  }
  const keep = new Set([...sources, ...poster].map((s) => s.src.split('/').pop()).concat(Object.values(captions).map((s) => s.split('/').pop())));
  sweep(`${id}.`, keep);
  const { m, save } = manifest();
  m.videos[id] = {
    duration: Math.round(c.lay.duration * 100) / 100,
    uploadDate: date,
    sources,
    poster,
    captions,
    chapters: c.lay.chapters,
    youtubeId: m.videos[id]?.youtubeId ?? null,
  };
  save();
  console.log(`published ${id}: ${sources.map((s) => s.src).join(', ')}; media.json updated`);
}

/** The hero's loop from the trailer's `loop` segments, into `dir` (and, `publish`, onto the page). */
async function heroLoop(list, files, { dir, publish: pub, date }) {
  const segments = list.loop.map((s) => ({ file: files[s.shot], from: s.from ?? 0, seconds: s.seconds }));
  const h264 = join(dir, 'loop.mp4');
  const av1 = join(dir, 'loop.av1.mp4');
  const r = await loopFilm({ segments, fps: list.fps, outH264: h264, outAv1: av1 });
  console.log(`loop: ${r.seconds.toFixed(2)} s, H.264 ${(r.h264.bytes / 1e6).toFixed(2)} MB, AV1 ${(r.av1.bytes / 1e6).toFixed(2)} MB`);
  if (!pub) return;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const sources = [];
  for (const [file, ext, type] of [
    [av1, '.av1.mp4', 'video/mp4; codecs="av01.0.08M.08"'],
    [h264, '.mp4', 'video/mp4; codecs="avc1.640028"'],
  ]) {
    const target = join(MEDIA_DIR, `loop.new${ext}`);
    renameSync(file, target);
    const info = probe(target);
    sources.push({ src: `/media/videos/${hashed(target, 'loop', ext)}`, type, width: info.video.width, height: info.video.height, bytes: info.bytes });
  }
  const png = join(dir, 'loop.poster.png');
  await frame(join(MEDIA_DIR, sources[1].src.split('/').pop()), 0, png);
  const poster = await posters(png, 'loop.poster');
  rmSync(png, { force: true });
  sweep('loop.', new Set([...sources, ...poster].map((s) => s.src.split('/').pop())));
  const { m, save } = manifest();
  m.loop = { duration: Math.round(r.seconds * 100) / 100, sources, poster };
  save();
  console.log(`published the loop (${date}); media.json updated`);
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = argv.slice();
  const id = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.match(/^--(size|only|from|to|burn|out|date|dpr)$/));
  const flag = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  return {
    id,
    draft: args.includes('--draft'),
    size: flag('--size'),
    only: flag('--only')?.split(',').filter(Boolean) ?? null,
    from: flag('--from') ?? null,
    to: flag('--to') ?? null,
    refilm: args.includes('--refilm'),
    check: args.includes('--check'),
    lint: args.includes('--lint'),
    burn: flag('--burn'),
    out: flag('--out'),
    dpr: Number(flag('--dpr') ?? 1),
    publish: args.includes('--publish'),
    loop: args.includes('--loop'),
    date: flag('--date'),
    verbose: args.includes('--verbose'),
  };
}

/**
 * The film's size: --size, else the list's own, else 1920 × 1080, in CSS pixels (where the game
 * lays out its interface), and `scale`, the picture's pixels per CSS pixel. A draft is drawn at
 * half scale: the same picture and layout as the full film, at a quarter of the pixels.
 */
export function sizeOf(list, o) {
  const [w, h] = o.size ? o.size.split('x').map(Number) : (list.size ?? FULL);
  if (!w || !h) throw new Error(`--size wants WxH, like 1920x1080 (got ${o.size})`);
  return { width: w, height: h, scale: o.draft ? 0.5 : 1 };
}

/** Prints lint()'s findings; true if the film may be made. */
export function report(list) {
  const all = texts(textId(list));
  const r = lint(list, list.kind === 'vertical' ? {} : all);
  console.log(`${list.id}: ${r.duration.toFixed(2)} s, ${list.shots.length} shots, ${r.chapters.length} chapters (${r.chapters.map((c) => `${c.start}s ${c.id}`).join(', ')}), ${r.cues.length} subtitles`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  for (const e of r.errors) console.log(`  error: ${e}`);
  return r.errors.length === 0;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.id) throw new Error('which film? node scripts/film/film.mjs <id> (a file in scripts/film/shots/)');
  const list = await loadList(o.id);
  const ok = report(list);
  if (o.lint) process.exit(ok ? 0 : 1);
  const size = sizeOf(list, o);
  // the picture's pixels (the shots are staged at the CSS size)
  const width = size.width * size.scale;
  const height = size.height * size.scale;
  const vertical = height > width;
  const shots = o.loop ? list.shots.filter((s) => list.loop?.some((l) => l.shot === s.id)) : choose(list, o);
  const partial = shots.length !== list.shots.length;
  if (o.loop && !list.loop) throw new Error(`${list.id} has no loop segments`);
  if (o.publish) {
    if (!o.date || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error('--publish needs --date YYYY-MM-DD (the day it was filmed, for media.json)');
    if (!o.loop && (o.draft || partial || vertical || width !== FULL[0])) throw new Error('--publish makes the page\'s files: the whole film at 1920 × 1080, no --draft, --size or partial cut');
    if (!o.loop && !ok) throw new Error('fix the errors above before publishing');
  }
  const dir = resolve(o.out ?? join(FILM, 'out', list.id));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  console.log(`filming ${list.id}${partial ? ` (${shots.map((s) => s.id).join(', ')})` : ''} at ${width} × ${height}${o.draft ? ' (draft)' : ''} from ${GAME_URL}`);
  const { files, stats } = await filmShots(list, shots, { width: size.width, height: size.height, scale: size.scale, dpr: o.dpr, draft: o.draft, refilm: o.refilm, check: o.check, checkDir: join(dir, 'check'), verbose: o.verbose });
  if (o.check) return;
  const filmed = stats.reduce((a, s) => a + s.seconds, 0);
  const filming = stats.reduce((a, s) => a + s.wall, 0);
  if (o.loop) return heroLoop(list, files, { dir, publish: o.publish, date: o.date });
  const c = await cut(list, shots, files, { width, height });
  if (o.publish) return publish(list, c, { date: o.date, tmp: dir });
  // a copy to watch: out/, with the subtitles burnt in (drafts in English unless --burn says otherwise)
  const base = `${list.id}${vertical ? '.vertical' : ''}${partial ? '.part' : ''}${o.draft ? '.draft' : ''}`;
  const burn = o.burn ?? (o.draft ? 'en' : 'none');
  const ass = burnFile(list, c.lay, burn, dir, { width, height });
  const out = join(dir, `${base}.mp4`);
  const t1 = Date.now();
  const info = await render({ cut: { ...c, ass, seconds: c.lay.duration }, encode: o.draft ? 'draft' : 'review', out, cwd: dir });
  if (ass) rmSync(join(dir, ass), { force: true });
  const joining = (Date.now() - t1) / 1000;
  for (const [lang, vtt] of Object.entries(captionFiles(list, c.lay))) writeFileSync(join(dir, `${base}.${lang}.vtt`), vtt);
  const sheet = await contactSheet(out, join(dir, `${base}.sheet.jpg`), { count: Math.min(16, Math.max(8, Math.round(c.lay.duration / 4))), cols: 4, width: 480 });
  writeFileSync(
    join(dir, `${base}.timeline.json`),
    `${JSON.stringify({ id: list.id, width, height, fps: list.fps, duration: c.lay.duration, chapters: c.lay.chapters, cues: c.lay.cues, shots: c.lay.shots.map((p) => ({ id: p.shot.id, start: Math.round(p.start * 1000) / 1000, duration: Math.round(p.duration * 1000) / 1000 })), music: c.music ? { track: c.music.credit.id, from: c.music.from, credit: `${c.music.credit.title} by ${c.music.credit.author} (${c.music.credit.licence})` } : null }, null, 2)}\n`,
  );
  const total = (Date.now() - t0) / 1000;
  console.log(`${out}: ${info.duration.toFixed(2)} s, ${(info.bytes / 1e6).toFixed(1)} MB${ass ? `, ${burn} subtitles burnt in` : ''}`);
  console.log(`contact sheet ${sheet.out}`);
  if (filmed) console.log(`filming: ${filmed.toFixed(1)} s of shots in ${filming.toFixed(0)} s (${(filming / filmed).toFixed(1)} s per second of film, the game's load not counted); joining ${joining.toFixed(0)} s; all in ${total.toFixed(0)} s`);
  if (RTL.has(burn)) console.log('(right-to-left subtitles: check the burnt-in lines read from the right)');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await main();
  } catch (e) {
    console.error(e.message ?? e);
    process.exitCode = 1;
  }
}
