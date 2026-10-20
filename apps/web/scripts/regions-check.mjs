// Logic checks for the regions' plumbing (world/layout.ts, world/map-paint.ts, world/map-tiles.ts), in node:
//   node scripts/regions-check.mjs
// Every place belongs to the region it stands in, fast travel never crosses the sea, each side's
// departure gate is on its own side, the walk areas clamp and respawn within the visitor's own
// region (and a key registered again replaces its areas), every ring stands on walkable ground,
// each map tab frames all its places, and no view of either map needs more tiles than the cache holds.
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
try {
  const geo = await server.ssrLoadModule('/src/world/geo.ts');
  const L = await server.ssrLoadModule('/src/world/layout.ts');
  const { regionAt } = geo;
  const ids = Object.keys(L.ZONES);

  // every place is in a district, and in the region it stands in
  const unassigned = ids.filter((id) => !L.ZONE_REGION[id]);
  check(unassigned.length === 0, `every place is in a district (${unassigned.join(', ') || 'all are'})`);
  const misplaced = ids.filter((id) => L.ZONE_REGION[id] && regionAt(L.ZONES[id].x, L.ZONES[id].z) !== L.ZONE_REGION[id]);
  check(misplaced.length === 0, `every place's district is in the region it stands in (${misplaced.join(', ') || 'all are'})`);
  for (const d of Object.values(L.DISTRICTS)) {
    const [px, pz] = d.plaza;
    check(regionAt(px, pz) === d.region && regionAt(d.label[0], d.label[1]) === d.region, `${d.name}: plaza and label in ${d.region}`);
  }
  check(
    L.FAIR_DISTRICTS.every((d) => d.region === 'home' && Math.hypot(d.plaza[0] - L.PARK.x, d.plaza[1] - L.PARK.z) < L.PARK.r + 140),
    `the fair's districts (${L.FAIR_DISTRICTS.length}) are all at the fair`,
  );

  // fast travel stays on the visitor's landmass; each side's way across is on that side
  for (const r of ['home', 'island']) {
    const info = L.REGION_INFO[r];
    check(L.ZONE_REGION[info.departure] === r && L.ZONE_REGION[info.arrival] === r, `${r}: departure (${info.departure}) and arrival (${info.arrival}) on its own side`);
    const reach = ids.filter((id) => L.canTravel(r, id));
    check(reach.length > 0 && reach.every((id) => L.ZONE_REGION[id] === r), `${r}: fast travel reaches ${reach.length} places, all on its own side`);
  }
  check(!L.canTravel('home', 'jetski') && L.canTravel('island', 'jetski') && L.canTravel('home', 'flight') && !L.canTravel('island', 'flight'), 'the jet-skis are on Palm Cay, gate 3 at home');

  // walking: on the ground, clamped within the region, respawned on the right side
  const spawn = L.LAYOUT.spawn;
  check(L.onWalk(spawn.x, spawn.z) && L.clampToGrounds(spawn.x, spawn.z) === null, 'the fair spawn is walkable');
  const sea = [0, 20000];
  check(L.clampToGrounds(sea[0], sea[1], 'home')[1] < 2000, 'a point mid-sea clamps to the mainland side for a home visitor');
  check(L.clampToGrounds(sea[0], sea[1], 'island')[1] > 39000, '…and to Palm Cay for an island visitor');
  const offIsland = L.clampToGrounds(0, 41700);
  check(offIsland && regionAt(offIsland[0], offIsland[1]) === 'island' && L.onWalk(offIsland[0], offIsland[1]), 'south of the beach clamps back onto Palm Cay');
  const r1 = L.respawnFor(0, 41700);
  check(regionAt(r1.x, r1.z) === 'island' && L.onWalk(r1.x, r1.z), `a fall off Palm Cay respawns there (${r1.x}, ${r1.z})`);
  const r2 = L.respawnFor(0, 560);
  check(regionAt(r2.x, r2.z) === 'home' && L.onWalk(r2.x, r2.z), `a fall off the airport's apron respawns at home (${r2.x}, ${r2.z})`);
  const r3 = L.respawnFor(0, 200);
  check(L.onWalk(r3.x, r3.z, 'home'), `a fall between the fair and the terminal lands on walkable ground (${r3.x}, ${r3.z})`);
  for (const r of ['home', 'island']) check(L.onWalk(L.RESPAWN[r].x, L.RESPAWN[r].z, r), `${r}: its default respawn is walkable`);

  // registering a key again replaces its areas rather than adding to them
  const before = L.WALK_AREAS.length;
  L.registerWalkAreas('island', [{ x0: 900, x1: 920, z0: 41000, z1: 41020 }], 'check');
  check(L.onWalk(910, 41010) && L.WALK_AREAS.length === before + 1, 'a registered area is walkable');
  L.registerWalkAreas('island', [{ x0: 950, x1: 960, z0: 41000, z1: 41010 }], 'check');
  check(!L.onWalk(910, 41010) && L.onWalk(955, 41005) && L.WALK_AREAS.length === before + 1, 'registering the key again replaces it');
  check(!L.onWalk(955, 41005 - 40000 + 20000, 'home'), "an island area never counts for the home region's clamp");
  L.registerWalkAreas('island', [], 'check');
  check(L.WALK_AREAS.length === before, 'registering it empty removes it');

  // every ring a visitor stands in is on walkable ground (before the buildings register their exact plans)
  const rings = ids.filter((id) => L.ZONES[id].radius > 0 && !id.startsWith('plot'));
  const off = rings.filter((id) => !L.onWalk(L.ZONES[id].x, L.ZONES[id].z, L.ZONE_REGION[id] ?? regionAt(L.ZONES[id].x, L.ZONES[id].z)));
  check(off.length === 0, `every ring (${rings.length}) is on walkable ground (${off.join(', ') || 'all are'})`);
  const lifted = ids.filter((id) => L.ZONES[id].y !== undefined);
  check(lifted.every((id) => L.ZONES[id].y >= 0 && L.ZONES[id].y < 0.1), `raised floors (${lifted.join(', ')}) are a few centimetres up`);

  // the maps: each tab frames its places, and no view outruns the tile cache
  const paint = await server.ssrLoadModule('/src/world/map-paint.ts');
  const tiles = await server.ssrLoadModule('/src/world/map-tiles.ts');
  for (const r of ['home', 'island', 'world']) {
    const b = paint.regionBounds(r);
    const outside = ids.filter((id) => (r === 'world' || L.ZONE_REGION[id] === r) && L.ZONE_REGION[id] && !(L.ZONES[id].x >= b.x0 && L.ZONES[id].x <= b.x1 && L.ZONES[id].z >= b.z0 && L.ZONES[id].z <= b.z1));
    check(outside.length === 0, `the ${r} tab frames all its places (${outside.join(', ') || 'it does'})`);
  }
  const need = (ppm, w, h, density) => {
    let level = tiles.levelFor(ppm * density);
    const span = (l) => {
      const m = tiles.tileMetres(l);
      return (Math.ceil(w / ppm / m) + 1) * (Math.ceil(h / ppm / m) + 1);
    };
    while (level < tiles.TILE_LEVELS.length - 1 && span(level) > 14) level++;
    return span(level);
  };
  // the World tab on a 4K screen, its closest tiled zoom, and the minimap's widest flight view on a retina phone
  const world = paint.regionBounds('world');
  const fit = Math.min(3840 / ((world.x1 - world.x0) * 1.1), 2160 / ((world.z1 - world.z0) * 1.1));
  check(need(fit, 3840, 2160, 1) <= 14, `the World tab on a 4K screen draws from ${need(fit, 3840, 2160, 1)} tiles at most`);
  check(need(3.39, 2560, 1440, 1) <= 28, `the map's closest tiled zoom draws from ${need(3.39, 2560, 1440, 1)} tiles`);
  check(need(168 / 30000, 168, 168, 2) <= 4, `the minimap at 15 km reach draws from ${need(168 / 30000, 168, 168, 2)} tiles`);
  check(need(168 / 110, 168, 168, 2) <= 4, `the minimap on foot draws from ${need(168 / 110, 168, 168, 2)} tiles`);
} finally {
  await server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
