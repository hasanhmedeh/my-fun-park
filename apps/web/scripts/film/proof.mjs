// Proves the film pipeline on the real game: films the Thunder Loop's ghost train through its launch
// and loop, 5 s at 1920 × 1080 and 30 fps, then 1 s upright (1080 × 1920), and reports how long it
// took, whether every frame moved the game on exactly 1/30 s, and whether any frame repeats the one
// before it (judder). Also times PNG against JPEG capture. Needs the game's dev server (see
// lib/session.mjs GAME_URL).
//
//   node scripts/film/proof.mjs [outDir]

import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FFMPEG, record } from './lib/capture.mjs';
import { openGame } from './lib/session.mjs';

const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });
const FPS = 30;

/** Each frame's mean difference from the one before it (0–255, luma): a repeat shows as about 0. */
function frameChanges(file) {
  // (the metadata filter prints to ffmpeg's log, on stderr)
  const { stderr } = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  return [...stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
}
/** How evenly something moved: its per-frame distance, and the biggest jump between two frames' distances. */
function evenness(points) {
  const d = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1], p[2] - points[i][2]));
  const jumps = d.slice(1).map((v, i) => Math.abs(v - d[i]));
  return { metresPerFrame: { min: Math.min(...d), max: Math.max(...d) }, biggestChange: Math.max(...jumps) };
}
const summary = (r) => ({ ...r, probes: undefined });

const t0 = Date.now();
const page = await openGame({ width: 1920, height: 1080, hour: 17.3 });
const report = { loadSeconds: page.loadMs / 1000, settings: page.settings };
try {
  // the clock stops here: from now on the game only moves when a frame is filmed
  await page.evaluate('__film.freeze()');
  // on to the moment the ghost train leaves the station's launch track (deterministic: film time)
  const waited = await page.evaluate(`(() => {
    const s = __game.stack;
    let n = 0;
    // (first out of the station if it's there, then up to the launch)
    while (n < 3600 && !(s.speed > 1 && s.trainPosition.x < -72 && s.trainPosition.x > -76)) { __film.step(${1000 / FPS}); n++; }
    return n / ${FPS};
  })()`);
  report.waitedForTrainSeconds = waited;
  await page.evaluate(`__director.follow({ target: 'stack.trainPosition', offset: [8, 7, 26], look: [0, 2, 0], smooth: 2.5 })`);
  const train = '(() => { const p = __game.stack.trainPosition; const c = __game.camera.position; return [[p.x, p.y, p.z], [c.x, c.y, c.z], __game.stack.speed]; })()';
  const wide = join(outDir, 'scout-draft.mp4');
  const r = await record(page, { seconds: 5, fps: FPS, out: wide, format: 'jpeg', quality: 92, probe: train });
  report.landscape = { file: wide, bytes: statSync(wide).size, ...summary(r) };
  report.landscape.train = evenness(r.probes.map((p) => p[0]));
  report.landscape.camera = evenness(r.probes.map((p) => p[1]));
  report.landscape.speedKmh = { min: Math.min(...r.probes.map((p) => p[2] * 3.6)), max: Math.max(...r.probes.map((p) => p[2] * 3.6)) };
  const changes = frameChanges(wide);
  report.landscape.frameChange = { min: Math.min(...changes), mean: changes.reduce((a, b) => a + b, 0) / changes.length, repeats: changes.filter((v) => v < 0.25).length };

  // the same scene captured as PNG and as JPEG, nothing encoded: what each costs per frame
  report.png = summary(await record(page, { seconds: 1, fps: FPS, out: null, format: 'png', fast: true }));
  report.pngSlow = summary(await record(page, { seconds: 1, fps: FPS, out: null, format: 'png', fast: false }));
  report.jpeg = summary(await record(page, { seconds: 1, fps: FPS, out: null, format: 'jpeg', quality: 92 }));

  // upright, for shorts: the page's size changes, the game resizes itself (a wider lens when portrait)
  await page.setViewport({ width: 1080, height: 1920 });
  await page.evaluate(`(dispatchEvent(new Event('resize')), __film.step(${1000 / FPS}), 0)`);
  report.portraitCanvas = await page.evaluate('[__game.renderer.domElement.width, __game.renderer.domElement.height, __game.camera.fov]');
  await page.evaluate(`__director.follow({ target: 'stack.trainPosition', offset: [10, 12, 30], look: [0, 2, 0], smooth: 2.5 })`);
  const tall = join(outDir, 'scout-draft-vertical.mp4');
  const v = await record(page, { seconds: 1, fps: FPS, out: tall, format: 'jpeg', quality: 92 });
  report.portrait = { file: tall, bytes: statSync(tall).size, ...summary(v) };
  const tallChanges = frameChanges(tall);
  report.portrait.frameChange = { min: Math.min(...tallChanges), repeats: tallChanges.filter((x) => x < 0.25).length };
} finally {
  await page.close();
}
report.totalSeconds = (Date.now() - t0) / 1000;
console.log(JSON.stringify(report, null, 2));
