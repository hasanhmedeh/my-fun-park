import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const g = await server.ssrLoadModule('/src/world/geo.ts');
  const t = await server.ssrLoadModule('/src/world/terrain-land.ts');
  const s = await server.ssrLoadModule('/src/world/sea-waves.ts');
  // shoreline z for x
  for (let x = -900; x <= -100; x += 50) {
    let z = 41200; while (g.islandShoreDist(x, z) > 0) z += 1;
    console.log('x', x, 'water edge z', z, 'lagoonSdf', t.lagoonSdf(x, z+100).toFixed(0), 'reef@+150', t.reefAt(x,z+150).toFixed(2));
  }
  // from fort along bearings
  const F = { x: -380, z: 41400 };
  for (const brg of [180, 200, 225, 250, 270]) {
    const row = [];
    for (let r = 50; r <= 600; r += 50) {
      const h = brg * Math.PI / 180; const x = F.x + Math.sin(h) * r, z = F.z - Math.cos(h) * r;
      row.push(`${r}:${t.onLand(x, z, -3) ? 'L' : 'w'}${t.lagoonSdf(x, z) < 0 ? 'g' : ''}${t.reefAt(x,z)>0.1?'R':''}${(-t.groundY(x,z)).toFixed(0)}/${s.swellFactor(x,z).toFixed(2)}`);
    }
    console.log('brg', brg, row.join(' '));
  }
  console.log('ground at fort', t.groundY(-380,41400), g.islandShoreDist(-380,41400), 'corner', g.islandShoreDist(-445,41465), g.islandShoreDist(-315,41465), g.islandShoreDist(-445,41335));
} finally { await server.close(); }
