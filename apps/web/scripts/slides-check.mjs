// Logic checks for Splash Tower's slides (src/world/attractions/island/slides-path.ts): each layout
// stays inside the island's plot for it, ends on the splash pool's wall heading south, keeps clear of
// the tower, of the other slides and of itself, and rides the way it should (speeds, G, duration).
//
//   node scripts/slides-check.mjs [--map]      (--map also prints a plan of the layouts)
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
try {
  const m = await server.ssrLoadModule('/src/world/attractions/island/slides-path.ts');
  const { SLIDES, buildSlide, simulate, TOWER, POOL, DS } = m;
  // the plot the island keeps clear (island.ts KEEP_CLEAR), local to ISLAND_SPOTS.slides (-230, 41150)
  const PLOT = { x0: -280 + 230, x1: -180 + 230, z0: 41085 - 41150, z1: 41215 - 41150 };
  const paths = SLIDES.map(buildSlide);
  const want = {
    kamikaze: { top: [65, 82], g: [2.2, 4.2], dur: [3, 9] },
    typhoon: { top: [35, 55], g: [1.6, 3.6], dur: [10, 24] },
    lazy: { top: [20, 38], g: [1.2, 2.6], dur: [14, 34] },
  };
  for (const p of paths) {
    const id = p.spec.id;
    const R = p.spec.radius + 0.12;
    const end = p.pos[p.pos.length - 1];
    const t = p.tan[p.tan.length - 1];
    const run = simulate(p, null);
    console.log(
      `\n${p.spec.name}: ${p.length.toFixed(1)} m, drop ${(p.pos[0].y - end.y).toFixed(1)} m, end (${end.x.toFixed(1)}, ${end.y.toFixed(2)}, ${end.z.toFixed(1)}) ` +
        `tan (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}); ride ${run.duration.toFixed(1)} s, top ${(run.topSpeed * 3.6).toFixed(0)} km/h, ` +
        `max ${run.maxG.toFixed(2)} G, exit ${(run.exitSpeed * 3.6).toFixed(0)} km/h, highest swing ${((Math.max(...run.samples.map((s) => Math.abs(s.phi))) * 180) / Math.PI).toFixed(0)}°`,
    );
    let inPlot = true;
    for (const q of p.pos) if (q.x - R < PLOT.x0 + 1 || q.x + R > PLOT.x1 - 1 || q.z - R < PLOT.z0 + 1 || q.z + R > PLOT.z1 - 1) inPlot = false;
    check(inPlot, `${id}: inside the plot`);
    check(Math.abs(end.z - POOL.z0) < 0.6 && end.x > POOL.x0 + 4 && end.x < POOL.x1 - 4, `${id}: ends on the pool's north wall (z ${end.z.toFixed(2)})`);
    const bottom = end.y - p.spec.radius;
    check(bottom > POOL.water + 0.05 && bottom < POOL.water + 0.6, `${id}: lip ${bottom.toFixed(2)} m, just above the water`);
    check(t.z > 0.97, `${id}: heads south at the end`);
    const [lo, hi] = want[id].top;
    check(run.topSpeed * 3.6 >= lo && run.topSpeed * 3.6 <= hi, `${id}: top speed in ${lo}-${hi} km/h`);
    check(run.maxG >= want[id].g[0] && run.maxG <= want[id].g[1], `${id}: max G in ${want[id].g.join('-')}`);
    check(run.duration >= want[id].dur[0] && run.duration <= want[id].dur[1], `${id}: ride time in ${want[id].dur.join('-')} s`);
    check(run.exitSpeed * 3.6 > 8 && run.exitSpeed * 3.6 < 34, `${id}: splashes in at a sensible speed`);
    // clear of the tower (bar where it leaves the deck)
    let tower = true;
    for (let i = Math.round(4 / DS); i < p.pos.length; i++) {
      const q = p.pos[i];
      if (Math.abs(q.x - TOWER.x) < TOWER.half + R + 0.6 && Math.abs(q.z - TOWER.z) < TOWER.half + R + 0.6 && q.y < TOWER.deck + 6) tower = false;
    }
    check(tower, `${id}: clear of the tower`);
    // clear of itself where it passes over (the loops and helices)
    let self = Infinity;
    for (let i = 0; i < p.pos.length; i += 2)
      for (let j = i + Math.round((Math.PI * 2 * 6) / DS); j < p.pos.length; j += 2) {
        const a = p.pos[i];
        const b = p.pos[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) < 2 * R) self = Math.min(self, Math.abs(a.y - b.y));
      }
    check(self > 2 * R + 0.8, `${id}: passes over itself with ${self === Infinity ? 'no crossing' : `${self.toFixed(1)} m`} of height`);
    // the walls never need to be higher than a closed tube
    check(p.lipL.every((v) => v <= Math.PI) && p.lipR.every((v) => v <= Math.PI), `${id}: wall heights valid`);
  }
  // the slides keep clear of one another
  for (let a = 0; a < paths.length; a++)
    for (let b = a + 1; b < paths.length; b++) {
      let min = Infinity;
      for (const p of paths[a].pos)
        for (let j = 0; j < paths[b].pos.length; j += 2) {
          const q = paths[b].pos[j];
          min = Math.min(min, p.distanceTo(q));
        }
      check(min > paths[a].spec.radius + paths[b].spec.radius + 0.8, `${paths[a].spec.id} / ${paths[b].spec.id}: ${min.toFixed(1)} m apart`);
    }
  if (process.argv.includes('--map')) {
    const W = 50;
    const H = 66;
    const grid = Array.from({ length: H }, () => new Array(W).fill('.'));
    const put = (x, z, ch) => {
      const c = Math.floor(((x - PLOT.x0) / (PLOT.x1 - PLOT.x0)) * W);
      const r = Math.floor(((z - PLOT.z0) / (PLOT.z1 - PLOT.z0)) * H);
      if (r >= 0 && r < H && c >= 0 && c < W) grid[r][c] = ch;
    };
    for (let x = POOL.x0; x <= POOL.x1; x += 1) for (let z = POOL.z0; z <= POOL.z1; z += 1) put(x, z, '~');
    for (let x = -TOWER.half; x <= TOWER.half; x += 1) for (let z = -TOWER.half; z <= TOWER.half; z += 1) put(TOWER.x + x, TOWER.z + z, '#');
    paths.forEach((p, k) => {
      for (const q of p.pos) put(q.x, q.z, q.y > 8 ? 'KTL'[k] : 'ktl'[k]);
    });
    console.log(`\n${grid.map((r) => r.join('')).join('\n')}`);
  }
} finally {
  await server.close();
}
console.log(fails.length ? `\n[slides-check] ${fails.length} failed` : '\n[slides-check] all checks passed');
process.exit(fails.length ? 1 : 0);
