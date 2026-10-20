// Probe for the airside's vehicle loops: runs one airport's drivers and prints any that stall,
// where they are and what they're waiting for.   node scripts/airside-probe.mjs [home|island] [minutes]
import { createServer } from 'vite';

const region = process.argv[2] ?? 'home';
const minutes = Number(process.argv[3] ?? 20);
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const THREE = await server.ssrLoadModule('three');
  const { AIRFIELDS } = await server.ssrLoadModule('/src/aviation/airports.ts');
  const { homeSite, islandSite } = await server.ssrLoadModule('/src/world/airport/airside-sites.ts');
  const { reservedStands } = await server.ssrLoadModule('/src/world/airport/airside.ts');
  const { Fleet, Drivers } = await server.ssrLoadModule('/src/world/airport/vehicles.ts');
  const { Kit, Paving } = await server.ssrLoadModule('/src/world/airport/airside-kit.ts');
  const ap = AIRFIELDS[region];
  const parts = { paint: new Kit(), detail: new Kit(), glass: new Kit(), paving: new Paving(), signs: [], lamps: [], pools: [] };
  const site = (region === 'home' ? homeSite : islandSite)(ap, parts, reservedStands(region));
  const origin = new THREE.Vector3(0, 0, Math.round(ap.stands[0].z));
  const kinds = [];
  for (const r of site.routes) {
    kinds.push({ kind: r.kind, variant: r.variant ?? 0, count: 1 });
    if (r.kind === 'catering') kinds.push({ kind: 'cateringBox', count: 1 });
    for (let i = 0; i < (r.train?.count ?? 0); i++) kinds.push({ kind: r.train.kind, variant: i + (r.variant ?? 0), count: 1 });
  }
  const drivers = new Drivers(new Fleet(origin, kinds, false), site.routes, origin);
  const D = drivers.drivers;
  const dt = 0.1;
  const still = new Array(D.length).fill(0);
  const reported = new Set();
  for (let i = 0; i < (minutes * 60) / dt; i++) {
    drivers.update(dt, [], false);
    D.forEach((d, j) => {
      still[j] = d.v < 0.05 && d.dwell <= 0 ? still[j] + dt : 0;
      if (still[j] > 20 && !reported.has(j)) {
        reported.add(j);
        const w = d.waitingFor >= 0 ? drivers.bodies[d.waitingFor] : null;
        const wo = d.waitingFor >= 0 ? drivers.owner[d.waitingFor] : -1;
        console.log(`t=${(i * dt).toFixed(0)} #${j} ${d.spec.kind} stuck at (${d.pose.x.toFixed(1)}, ${d.pose.z.toFixed(1)}) hdg ${d.pose.heading.toFixed(0)} s=${d.s.toFixed(0)}/${d.spec.path.length.toFixed(0)}; waits for ${wo >= 0 ? `#${wo} ${D[wo].spec.kind}` : 'nothing'} ${w ? `at (${w.x.toFixed(1)}, ${w.z.toFixed(1)}) hdg ${w.heading.toFixed(0)}` : ''}`);
      }
    });
  }
  console.log(`${D.length} drivers, ${reported.size} stalled`);
  // where everyone is at the end, and what holds them
  D.forEach((d, j) => {
    const wo = d.waitingFor >= 0 ? drivers.owner[d.waitingFor] : -1;
    console.log(`  #${j} ${d.spec.kind} (${d.pose.x.toFixed(0)}, ${d.pose.z.toFixed(0)}) v ${d.v.toFixed(1)} dwell ${d.dwell.toFixed(0)} waits ${wo}`);
  });
} finally {
  await server.close();
}
