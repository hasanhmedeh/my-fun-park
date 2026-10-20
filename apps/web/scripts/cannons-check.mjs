// Logic checks for Pirate Cannons (world/attractions/island/cannons-*.ts), in node:
//   node scripts/cannons-check.mjs
// The three ship lanes stay on open lagoon water (no land, no reef, no hull seen aground, clear of
// the jet-ski course) all round, hull corners included; every lane is in reach of the guns and
// inside their arc; the gun-laying solver lands a windless ball on the spot it was
// laid for; a ball fired at a ship's box hits it and one fired past misses; the multiplier steps.
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
try {
  const sim = await server.ssrLoadModule('/src/world/attractions/island/cannons-sim.ts');
  const geo = await server.ssrLoadModule('/src/world/geo.ts');
  const land = await server.ssrLoadModule('/src/world/terrain-land.ts');
  const THREE = await server.ssrLoadModule('three');
  // the sea is opaque, so a keel below the sand never shows: what matters is that no hull is seen
  // aground, which takes a metre and a half of water under the waterline
  const minDepth = 1.5;
  const g = sim.fortToWorld(sim.GUNS[1].lx, sim.GUNS[1].lz);
  const heading = THREE.MathUtils.degToRad(sim.FORT.heading);

  // ---- the lanes
  for (const lane of sim.LANES) {
    const L = sim.laneLength(lane);
    let wet = true;
    let depth = 1e9;
    let reef = 0;
    let xmax = -1e9;
    let rmin = 1e9;
    let rmax = 0;
    let arc = 0;
    const p = { x: 0, z: 0, tx: 0, tz: 0 };
    for (let s = 0; s < L; s += 2) {
      sim.lanePoint(lane, s, p);
      // the hull's corners as well as its centre (the galleon is 40 m by 11)
      for (const [a, b] of [[0, 0], [20, 6], [20, -6], [-20, 6], [-20, -6]]) {
        const x = p.x + p.tx * a - p.tz * b;
        const z = p.z + p.tz * a + p.tx * b;
        if (land.onLand(x, z)) wet = false;
        depth = Math.min(depth, geo.SEA_Y - land.groundY(x, z));
        reef = Math.max(reef, land.reefAt(x, z));
        xmax = Math.max(xmax, x);
      }
      const r = Math.hypot(p.x - g.x, p.z - g.z);
      rmin = Math.min(rmin, r);
      rmax = Math.max(rmax, r);
      arc = Math.max(arc, Math.abs(sim.angleDiff(sim.bearing(g.x, g.z, p.x, p.z), heading)));
    }
    check(wet, `${lane.name} lane: on water all round`);
    check(depth > minDepth, `${lane.name} lane: at least ${minDepth} m deep (min ${depth.toFixed(2)} m)`);
    check(reef < 0.05, `${lane.name} lane: clear of the reef (${reef.toFixed(3)})`);
    check(xmax < -190, `${lane.name} lane: west of the jet-ski course (x max ${xmax.toFixed(0)})`);
    check(rmin > sim.AIM.minRange && rmax < sim.AIM.maxRange, `${lane.name} lane: in range (${rmin.toFixed(0)}..${rmax.toFixed(0)} m)`);
    check(arc < sim.AIM.arc, `${lane.name} lane: inside the guns' arc (${THREE.MathUtils.radToDeg(arc).toFixed(1)}°)`);
    // the direction of travel is continuous (no jumps at the joins)
    let jump = 0;
    const q = { x: 0, z: 0, tx: 0, tz: 0 };
    for (let s = 0; s < L; s += 1) {
      sim.lanePoint(lane, s, p);
      sim.lanePoint(lane, s + 1, q);
      jump = Math.max(jump, Math.hypot(q.x - p.x, q.z - p.z));
    }
    check(jump < 1.05, `${lane.name} lane: continuous (step ${jump.toFixed(3)} m per m)`);
  }

  // ---- laying and flight
  let worst = 0;
  let worstElev = 0;
  for (let range = sim.AIM.minRange; range <= 700; range += 40)
    for (let d = -40; d <= 40; d += 20) {
      const brg = heading + THREE.MathUtils.degToRad(d);
      const tx = g.x + Math.sin(brg) * range;
      const tz = g.z - Math.cos(brg) * range;
      const l = sim.lay(g.x, sim.GUNS[1].y, g.z, tx, tz);
      worstElev = Math.max(worstElev, l.elev);
      const m = sim.muzzle(g.x, sim.GUNS[1].y, g.z, l.bearing, l.elev);
      const ch = Math.cos(l.elev) * sim.MUZZLE_V;
      const shot = { x0: m.x, y0: m.y, z0: m.z, vx: Math.sin(l.bearing) * ch, vy: Math.sin(l.elev) * sim.MUZZLE_V, vz: -Math.cos(l.bearing) * ch, wx: 0, wz: 0 };
      const t = sim.fallTime(shot.vy, m.y - geo.SEA_Y);
      const hit = sim.shotAt(shot, t);
      worst = Math.max(worst, Math.hypot(hit.x - tx, hit.z - tz), Math.abs(hit.y - geo.SEA_Y));
    }
  check(worst < 0.5, `lay → flight lands on the spot (worst ${worst.toFixed(3)} m)`);
  check(worstElev < sim.ELEV_MAX, `700 m needs ${THREE.MathUtils.radToDeg(worstElev).toFixed(1)}° (gun max ${THREE.MathUtils.radToDeg(sim.ELEV_MAX).toFixed(0)}°)`);
  check(sim.rangeAt(sim.ELEV_MAX, sim.GUNS[1].y - geo.SEA_Y).range > sim.AIM.maxRange, 'full elevation reaches the furthest mark');
  // the wind: a 15 kt crosswind moves a 4 s ball a few metres, not tens
  {
    const ms = 15 * 0.514444;
    const s0 = { x0: 0, y0: 6, z0: 0, vx: 0, vy: 10, vz: -159, wx: ms, wz: 0 };
    const t = sim.fallTime(10, 6 - geo.SEA_Y);
    const drift = sim.shotAt(s0, t).x;
    check(drift > 1.5 && drift < 12, `15 kt crosswind drift over ${t.toFixed(1)} s: ${drift.toFixed(1)} m`);
  }

  // ---- the hit test
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  check(sim.segmentHitsBox(V(-10, 1, 0), V(10, 1, 0), 3, -1, 3, 10) >= 0, 'a ball through the beam hits');
  check(Math.abs(sim.segmentHitsBox(V(-10, 1, 0), V(10, 1, 0), 3, -1, 3, 10) - 0.35) < 1e-9, 'and enters at the near side');
  check(sim.segmentHitsBox(V(-10, 5, 0), V(10, 5, 0), 3, -1, 3, 10) < 0, 'a ball over the deck misses');
  check(sim.segmentHitsBox(V(-10, 1, 12), V(10, 1, 12), 3, -1, 3, 10) < 0, 'a ball past the bow misses');
  check(sim.segmentHitsBox(V(0, 8, 0), V(0, 2, 0), 3, -1, 3, 10) >= 0, 'a plunging ball onto the deck hits');
  check(sim.segmentHitsBox(V(-10, 1, 0), V(-5, 1, 0), 3, -1, 3, 10) < 0, 'a ball that stops short misses');

  // ---- scoring
  check([0, 2, 3, 6, 9, 12, 30].map(sim.multiplier).join() === '1,1,2,3,4,5,5', 'multiplier ×1, then +1 every three hits, up to ×5');
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await server.close();
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
