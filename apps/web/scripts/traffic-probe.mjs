// Prints the AI traffic's flights every few seconds (to find moments for the traffic preview's warp):
//   node scripts/traffic-probe.mjs [region] [seconds] [every]
import { createServer } from 'vite';

const region = process.argv[2] ?? 'home';
const seconds = Number(process.argv[3] ?? 600);
const every = Number(process.argv[4] ?? 10);
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const THREE = await server.ssrLoadModule('three');
  const { Traffic } = await server.ssrLoadModule('/src/aviation/traffic.ts');
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 50, region === 'home' ? 600 : 40500);
  const ctx = { camera, quality: { shadows: false }, sfx: { trafficJet() {} } };
  const createPlane = (o) => ({ group: new THREE.Group(), livery: o.livery, setVisual() {}, setCockpitView() {}, setNight() {}, dispose() {} });
  const traffic = new Traffic(ctx, { createPlane });
  traffic.onRadioAt = (u, r) => r === region && console.log(`        ${u.from}: ${u.text}`);
  for (let i = 0; i * 0.1 < seconds; i++) {
    const t = i * 0.1;
    traffic.update(0.1, t, null, region);
    if (i % Math.round(every / 0.1) === 0)
      console.log(`t=${t.toFixed(0)} ${traffic.snapshot().filter((f) => f.region === region).map((f) => `${f.callsign} ${f.phase} (${f.x.toFixed(0)},${f.y.toFixed(0)},${f.z.toFixed(0)}) ${f.kt.toFixed(0)}kt`).join(' | ')}`);
  }
} finally {
  await server.close();
}
