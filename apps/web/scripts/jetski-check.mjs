// Logic checks for the Jet-Ski Race (world/attractions/island/jetski-*.ts), in node:
//   node scripts/jetski-check.mjs
// The course stays in deep, open lagoon water clear of the dock and the swimming area; the rivals
// (and an autopilot in your seat) ride whole three-lap races without leaving the course, missing
// a buoy or going the wrong way; the ramps launch the jumpers and they land; the lap times and
// top speeds are in the right range.
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
try {
  const course = await server.ssrLoadModule('/src/world/attractions/island/jetski-course.ts');
  const race = await server.ssrLoadModule('/src/world/attractions/island/jetski-race.ts');
  const phys = await server.ssrLoadModule('/src/world/attractions/island/jetski-physics.ts');
  const geo = await server.ssrLoadModule('/src/world/geo.ts');
  const land = await server.ssrLoadModule('/src/world/terrain-land.ts');
  const { waveY } = await server.ssrLoadModule('/src/world/sea-waves.ts');
  const C = course.COURSE;

  // ---- the course
  let sdf = -1e9;
  let depth = 1e9;
  let reef = 0;
  let zmin = 1e9;
  for (let i = 0; i < C.n; i++) {
    for (const d of [-course.WALL, 0, course.WALL]) {
      const p = course.coursePoint(i * C.ds, d);
      sdf = Math.max(sdf, land.lagoonSdf(p.x, p.z));
      reef = Math.max(reef, land.reefAt(p.x, p.z));
      zmin = Math.min(zmin, p.z);
    }
    for (const d of [-course.SHALLOWS, 0, course.SHALLOWS]) {
      const p = course.coursePoint(i * C.ds, d);
      depth = Math.min(depth, geo.SEA_Y - land.groundY(p.x, p.z));
    }
  }
  check(C.length > 850 && C.length < 1000, `lap length ${C.length.toFixed(0)} m (~900)`);
  check(sdf < -5, `course and its edge ropes inside the lagoon (max lagoonSdf ${sdf.toFixed(1)})`);
  check(reef === 0, 'clear of the reef');
  check(depth > 1.2, `at least 1.2 m of water across the raceable band (min ${depth.toFixed(2)} m)`);
  check(zmin > course.DOCK.pontoon.z1 + 25, `edge ropes clear of the pontoon (${(zmin - course.DOCK.pontoon.z1).toFixed(0)} m)`);
  check(zmin > geo.ISLAND.lagoon.z0, 'south of the swimming area (lagoon z0)');
  for (const r of course.RAMPS) check(land.lagoonSdf(r.x, r.z) < -20 && Math.abs(r.d) + r.width / 2 < course.GATE_HALF, `ramp at s ${r.s.toFixed(0)} in the lagoon, inside the gates' lane`);
  const pierEnd = geo.islandShoreDist(course.DOCK.x, course.DOCK.z1);
  check(pierEnd < -10, `pier head over water (${(-pierEnd).toFixed(0)} m out)`);
  check(geo.islandShoreDist(course.DOCK.x, course.DOCK.z0 + 15) > 22, 'ring spot at the dock gate on dry sand');

  // ---- whole races
  const water = (x, z) => waveY(x, z, 0);
  const names = ['You', 'A', 'B', 'C', 'D'];
  const skills = [0.9, 0.97, 0.94, 0.91, 0.87];
  const jumpers = [false, true, false, true, true];
  const rs = names.map((n, i) => race.newRacer(n, '#fff', skills[i], jumpers[i]));
  rs.forEach((r, i) => race.toGrid(r, i, water));
  const dt = 1 / 60;
  let t = 0;
  let maxD = 0;
  let top = 0;
  let wrong = 0;
  let kicks = 0;
  const landings = { clean: 0, rough: 0, stuffed: 0, sideways: 0 };
  let nan = false;
  while (t < 420 && rs.some((r) => r.finished === null)) {
    for (const r of rs) race.aiControls(r, rs, dt);
    for (const r of rs) {
      const ev = race.stepRacer(r, rs, dt, t, t, true, (x, z) => waveY(x, z, t));
      if (ev.physics.landed && ev.physics.landed.airT > 0.5) landings[ev.physics.landed.result]++;
      if (ev.wakeKick) kicks++;
      maxD = Math.max(maxD, Math.abs(r.d));
      top = Math.max(top, phys.forwardSpeed(r.c));
      if (r.wrongT > 1.2) wrong++;
      if (!Number.isFinite(r.c.x + r.c.z + r.c.y + r.c.h)) nan = true;
    }
    race.collideRacers(rs, rs[0]);
    t += dt;
  }
  check(!nan, 'no NaNs');
  for (const r of rs) {
    check(r.finished !== null, `${r.name} finished: ${r.finished?.toFixed(1)} s, best lap ${r.bestLap.toFixed(1)} s, missed ${r.missed}, jumps ${r.jumps}`);
    check(r.missed === 0, `${r.name} missed no gates`);
  }
  check(maxD < course.SHALLOWS, `everyone stayed off the shallows (max |d| ${maxD.toFixed(1)} m)`);
  check(wrong === 0, 'nobody went the wrong way');
  const best = Math.min(...rs.map((r) => r.bestLap));
  check(best > 40 && best < 75, `best lap ${best.toFixed(1)} s`);
  check(top * 3.6 > 65 && top * 3.6 < 100, `top speed ${(top * 3.6).toFixed(0)} km/h`);
  const jumps = rs.reduce((a, r) => a + r.jumps, 0);
  check(jumps >= 12, `the jumpers jumped (${jumps} airs over 0.5 s; landings ${JSON.stringify(landings)})`);
  check(landings.clean >= landings.rough + landings.stuffed + landings.sideways, 'mostly clean landings off the throttle');
  console.log(`wake kicks: ${kicks}; standings: ${race.standings(rs).map((r) => r.name).join(' ')}`);
} finally {
  await server.close();
}
console.log(failed ? `${failed} check(s) FAILED` : 'all jet-ski checks passed');
process.exit(failed ? 1 : 0);
