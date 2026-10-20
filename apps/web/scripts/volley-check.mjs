// Logic checks for Beach Volley (world/attractions/island/volley-*.ts), in node:
//   node scripts/volley-check.mjs
// The flights the game asks for are the flights it gets: a well-timed serve or spike lands where
// it was aimed and clears the net, an early mishit goes into the net and a late one long, a shot
// at a coconut hits it, the soft passes come down where they were sent; the grades, the rings,
// the points and a defender's reach behave.
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
try {
  const V = await server.ssrLoadModule('/src/world/attractions/island/volley-ball.ts');
  const R = await server.ssrLoadModule('/src/world/attractions/island/volley-rules.ts');
  const C = await server.ssrLoadModule('/src/world/attractions/island/volley-court.ts');
  const rnd = mulberry(7);

  // ---- serves from the toss (struck at 3.05 m, a little in front of the baseline)
  const SX = 1.12;
  const SY = 3.05;
  const SZ = -8.6;
  let worst = 0;
  let netFails = 0;
  let speeds = [];
  for (let i = 0; i < 40; i++) {
    const tx = (rnd() - 0.5) * 7;
    const tz = 1.6 + rnd() * 6.2;
    const b = V.attack(SX, SY, SZ, tx, tz, 'top', R.ELEVS.jumpServe, 0.08);
    speeds.push(V.speedOf(b));
    const hit = V.fly(V.copyBall(b), {});
    if (hit?.kind !== 'land') netFails++;
    const end = V.predict(b, {}).at;
    worst = Math.max(worst, Math.hypot(end.x - tx, end.z - tz));
  }
  check(netFails === 0, `perfect jump serves all clear the net (${netFails} of 40 failed)`);
  check(worst < 0.25, `perfect jump serves land where aimed (worst ${worst.toFixed(2)} m)`);
  speeds.sort((a, b) => a - b);
  check(speeds[0] > 10 && speeds[speeds.length - 1] < 32, `serve speeds are a jump serve's (${speeds[0].toFixed(1)}–${speeds[speeds.length - 1].toFixed(1)} m/s)`);

  // float serves (an 'ok' strike) still get over and in
  let floats = 0;
  for (let i = 0; i < 20; i++) {
    const b = V.attack(SX, SY, SZ, (rnd() - 0.5) * 6, 2 + rnd() * 5, 'float', R.ELEVS.floatServe, 0.2, rnd() * 6);
    const hit = V.fly(b, {});
    if (hit?.kind === 'land' && V.inCourt(b.x, b.z, 1)) floats++;
  }
  check(floats >= 18, `float serves land in the far court (${floats} of 20)`);

  // the mishits: early into the net, late long (as the game strikes them)
  const strike = (s, x, y, z) => (s.ty !== null ? V.attackThrough(x, y, z, s.x, s.ty, s.z, s.spin, s.elevs, -9) : V.attack(x, y, z, s.x, s.z, s.spin, s.elevs, s.margin));
  let early = 0;
  let late = 0;
  for (let i = 0; i < 20; i++) {
    const se = R.shot('miss', -0.3, (rnd() - 0.5) * 6, 5, i % 2 ? 'serve' : 'spike', rnd);
    const be = i % 2 ? strike(se, SX, SY, SZ) : strike(se, 1.7, 3.05, -1.05);
    if (V.fly(be, {})?.kind === 'net') early++;
    const sl = R.shot('miss', 0.3, (rnd() - 0.5) * 6, 5, i % 2 ? 'serve' : 'spike', rnd);
    const bl = i % 2 ? strike(sl, SX, SY, SZ) : strike(sl, 1.7, 3.05, -1.05);
    const h = V.fly(bl, {});
    if (h?.kind === 'land' && !V.inCourt(bl.x, bl.z, 1)) late++;
  }
  check(early >= 16, `an early mishit goes into the net (${early} of 20)`);
  check(late >= 18, `a late mishit lands long (${late} of 20)`);

  // ---- spikes from the set (1.7, 3.05, −1.05)
  let spikesIn = 0;
  let steep = 0;
  for (let i = 0; i < 30; i++) {
    const s = R.shot('perfect', 0, (rnd() - 0.5) * 7, 1 + rnd() * 6.5, 'spike', rnd);
    const b = V.attack(1.7, 3.05, -1.05, s.x, s.z, s.spin, s.elevs, s.margin);
    if (b.vy < 0) steep++;
    const h = V.fly(b, {});
    if (h?.kind === 'land' && V.inCourt(b.x, b.z, 1)) spikesIn++;
  }
  check(spikesIn >= 28, `perfect spikes land in the far court (${spikesIn} of 30)`);
  check(steep >= 15, `most spikes are hit downwards (${steep} of 30)`);
  let rolls = 0;
  for (let i = 0; i < 20; i++) {
    const s = R.shot('ok', 0.15, (rnd() - 0.5) * 5, 2 + rnd() * 4, 'spike', rnd);
    const b = V.attack(1.7, 3.05, -1.05, s.x, s.z, s.spin, s.elevs, s.margin);
    const h = V.fly(b, {});
    if (h?.kind === 'land' && b.z > 0) rolls++;
  }
  check(rolls >= 18, `an 'ok' spike becomes a roll shot that gets over (${rolls} of 20)`);

  // the locals' attacks from their set (±2, 3, 1.15) at the visitor's side
  let theirs = 0;
  for (let i = 0; i < 30; i++) {
    const x = (rnd() < 0.5 ? -1 : 1) * (1.6 + rnd() * 1.2);
    const hard = rnd() < 0.6;
    const b = V.attack(x, 3, 1.15, (rnd() - 0.5) * 6.4, -(1.5 + rnd() * 5.8), hard ? 'top' : 'soft', hard ? [-0.45, -0.35, -0.25, -0.15, -0.05, 0.05] : [0.35, 0.5, 0.65], 0.2);
    const h = V.fly(b, {});
    if (h?.kind === 'land' && V.inCourt(b.x, b.z, -1)) theirs++;
  }
  check(theirs >= 28, `the locals' attacks land in the visitor's court (${theirs} of 30)`);

  // ---- the coconuts
  const targets = C.COCONUTS.map((c) => ({ x: c.x, y: c.y, z: C.SHY_Z, r: C.COCONUT_R }));
  let nutServes = 0;
  let nutSpikes = 0;
  C.COCONUTS.forEach((c, i) => {
    const bs = V.attackThrough(SX, SY, SZ, c.x, c.y, C.SHY_Z, 'top', R.ELEVS.coconut, 0.12);
    const hs = V.fly(bs, { targets });
    if (hs?.kind === 'target' && hs.index === i) nutServes++;
    const bk = V.attackThrough(1.7, 3.05, -1.05, c.x, c.y, C.SHY_Z, 'top', R.ELEVS.coconut, 0.12);
    const hk = V.fly(bk, { targets });
    if (hk?.kind === 'target' && hk.index === i) nutSpikes++;
  });
  check(nutServes === 5, `a perfect serve at each coconut hits it (${nutServes} of 5)`);
  check(nutSpikes === 5, `a perfect spike at each coconut hits it (${nutSpikes} of 5)`);

  // ---- the soft passes come down through where they were sent, when lob says
  let lobWorst = 0;
  for (let i = 0; i < 20; i++) {
    const from = { x: (rnd() - 0.5) * 6, y: 0.78, z: 2 + rnd() * 5 };
    const to = { x: (rnd() - 0.5) * 3, y: 2.45, z: 1.7 };
    const { b, t } = V.lob(from, to, 4 + rnd());
    const s = V.copyBall(b);
    while (s.t < t - 1e-9) V.stepBall(s);
    lobWorst = Math.max(lobWorst, Math.hypot(s.x - to.x, s.y - to.y, s.z - to.z));
  }
  check(lobWorst < 0.08, `digs and sets reach their target on time (worst ${lobWorst.toFixed(3)} m)`);

  // ---- the toss: the strike height comes in a sensible window
  const toss = V.ball(SX, 1.45, -9.3, 0, 6.3, 0.75, 'soft');
  let tPerfect = 0;
  let tLate = 0;
  for (let i = 0; i < 2400 && !tLate; i++) {
    const py = toss.y;
    V.stepBall(toss);
    if (toss.vy < 0 && py >= 3.05 && toss.y < 3.05) tPerfect = toss.t;
    if (toss.vy < 0 && py >= 1.35 && toss.y < 1.35) tLate = toss.t;
  }
  check(tPerfect > 0.9 && tPerfect < 1.3 && tLate - tPerfect > 0.25, `the toss gives a fair window (perfect at ${tPerfect.toFixed(2)} s, over at ${tLate.toFixed(2)} s)`);

  // ---- the rules
  check(R.grade(0) === 'perfect' && R.grade(0.08) === 'good' && R.grade(-0.15) === 'ok' && R.grade(0.3) === 'miss', 'grades by timing');
  check(R.grade(0.04, 0.5) === 'good' && R.grade(0.09, 0.5) === 'ok', 'a dive tightens the grades');
  let ringsOk = true;
  let ringWhy = '';
  for (let i = 0; i < 200; i++) {
    const rings = R.placeRings(rnd);
    const fail = (why) => {
      ringsOk = false;
      ringWhy ||= why;
    };
    if (rings.length !== 3 || new Set(rings.map((r) => r.value)).size !== 3) fail('values');
    for (const r of rings) if (Math.abs(r.x) + r.r > V.HALF_W + 0.05 || r.z - r.r < 0 || r.z + r.r > V.HALF_L + 0.05) fail(`outside: ${JSON.stringify(r)}`);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (Math.hypot(rings[a].x - rings[b].x, rings[a].z - rings[b].z) < rings[a].r + rings[b].r) fail('overlap');
  }
  check(ringsOk, `rings: one of each value, inside the far court, never overlapping ${ringWhy}`);
  const rings = [{ x: 2, z: 6, r: 0.72, value: 3 }];
  check(R.ringAt(rings, 2.5, 6) === 3 && R.ringAt(rings, 3.2, 6) === 0, 'ringAt finds the ring under a landing');
  check(R.points({ won: true, how: 'ace', ring: 3, coconuts: 0 }, 0) === 4 && R.points({ won: true, how: 'ace', ring: 0, coconuts: 0 }, 0) === 2, 'an ace is its ring plus one');
  check(R.points({ won: true, how: 'kill', ring: 2, coconuts: 0 }, 2) === 3 && R.points({ won: true, how: 'kill', ring: 0, coconuts: 0 }, 1) === 1, 'a kill is its ring, plus one after a rally');
  check(R.points({ won: true, how: 'coconut', ring: 0, coconuts: 2 }, 0) === 10 && R.points({ won: false, how: 'net' }, 0) === 0, 'coconuts pay 5 each, a lost rally nothing');
  check(R.reach(0.5, 0.5, 5.6, 0.3).how === 'set' && R.reach(3.2, 0.8, 5.6, 0.3).how === 'dive' && R.reach(8, 0.8, 5.6, 0.3).how === 'none', 'reach: standing, diving, too far');
  check(R.digChance(22, 'dive', 0.9, 0) < R.digChance(10, 'set', 0.9, 0) && R.digChance(10, 'set', 0.9, 4) < R.digChance(10, 'set', 0.9, 0), 'digs get harder with pace, a dive and a long rally');
} finally {
  await server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
