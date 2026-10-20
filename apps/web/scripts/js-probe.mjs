import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const c = await server.ssrLoadModule('/src/world/attractions/island/jetski-course.ts');
  const geo = await server.ssrLoadModule('/src/world/geo.ts');
  const tl = await server.ssrLoadModule('/src/world/terrain-land.ts');
  const C = c.COURSE;
  let kmax = 0, ki = 0, sdf = -1e9, zmin = 1e9, depthMin = 1e9;
  for (let i = 0; i < C.n; i++) { if (Math.abs(C.k[i]) > kmax) { kmax = Math.abs(C.k[i]); ki = i; }
    for (const d of [-c.WALL, 0, c.WALL]) { const p = c.coursePoint(i * C.ds, d); sdf = Math.max(sdf, tl.lagoonSdf(p.x, p.z)); zmin = Math.min(zmin, p.z); }
    for (const d of [-c.GATE_HALF, 0, c.GATE_HALF]) { const p = c.coursePoint(i * C.ds, d); depthMin = Math.min(depthMin, geo.SEA_Y - tl.groundY(p.x, p.z)); }
  }
  console.log('length', C.length.toFixed(1), 'minR', (1 / kmax).toFixed(1), 'at', C.px[ki].toFixed(0), C.pz[ki].toFixed(0), 'max sdf (wall band)', sdf.toFixed(1), 'min z', zmin.toFixed(1), 'min depth on lane', depthMin.toFixed(2));
  console.log('gates', c.GATES.length, c.GATES.map((g) => g.s.toFixed(0)).join(' '));
  console.log('ramps', c.RAMPS.map((r) => `${r.s.toFixed(0)}/${r.d}`).join(' '), 'angle', (c.rampAngle(c.RAMPS[0]) * 57.3).toFixed(1));
  const st = c.coursePoint(c.START_S, 0); console.log('start', st);
  // self-proximity: min distance between samples > 60 apart along
  let md = 1e9;
  for (let i = 0; i < C.n; i += 2) for (let j = 0; j < C.n; j += 2) { const ds = Math.abs(c.deltaS(i * C.ds, j * C.ds)); if (ds < 120) continue; md = Math.min(md, Math.hypot(C.px[i] - C.px[j], C.pz[i] - C.pz[j])); }
  console.log('closest other stretch', md.toFixed(1));
} finally { await server.close(); }
