// Logic checks for the AI traffic (aviation/traffic.ts) and the airside's vehicles
// (world/airport/vehicles.ts, airside-sites.ts), in node:
//   node scripts/traffic-check.mjs [minutes]
// Two hours of both airports with stub aircraft: arrivals land, vacate and park, departures push,
// taxi, take off and leave; the runway never has two users at once and each movement holds it for
// about a minute; aircraft on the ground keep apart; every flight gets its radio calls. Holding
// for the player stops line-ups and spawning and sends a close arrival round. Then the vehicles:
// half an hour of each airport's service-road loops without a stall or a collision.
import { createServer } from 'vite';

const minutes = Number(process.argv[2] ?? 120);
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
try {
  const THREE = await server.ssrLoadModule('three');
  const { Traffic } = await server.ssrLoadModule('/src/aviation/traffic.ts');
  const { AIRFIELDS, onRunway } = await server.ssrLoadModule('/src/aviation/airports.ts');
  const { homeSite, islandSite } = await server.ssrLoadModule('/src/world/airport/airside-sites.ts');
  const { reservedStands } = await server.ssrLoadModule('/src/world/airport/airside.ts');
  const { Fleet, Drivers } = await server.ssrLoadModule('/src/world/airport/vehicles.ts');
  const { Kit, Paving } = await server.ssrLoadModule('/src/world/airport/airside-kit.ts');

  // ---------------------------------------------------------------- the traffic
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 50, 600);
  let jets = 0;
  const ctx = { camera, quality: { shadows: false }, sfx: { trafficJet: (k) => (jets = Math.max(jets, k)) } };
  let models = 0;
  const createPlane = (o) => {
    models++;
    return { group: new THREE.Group(), livery: o.livery, setVisual() {}, setCockpitView() {}, setNight() {}, dispose() {} };
  };
  const standEvents = [];
  const traffic = new Traffic(ctx, { createPlane, onStand: (r, id, s) => standEvents.push(`${r}:${id}:${s}`) });
  const lines = [];
  traffic.onRadioAt = (u, region, station) => lines.push({ u, region, station });
  let heard = 0;
  traffic.onRadio = () => heard++;

  const dt = 0.1;
  const steps = (minutes * 60) / dt;
  const RW = ['flare', 'roll', 'lineup', 'takeoff'];
  const stats = { home: null, island: null };
  const mk = () => ({ maxUsers: 0, occ: [], busySince: -1, landed: 0, parked: 0, gone: 0, ga: 0, minGap: Infinity, nan: false, maxPerField: 0, seen: new Map() });
  stats.home = mk();
  stats.island = mk();
  const last = new Map();
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    // the player sits at the island's stand for the first hour, then holds the home runway for a few minutes
    const holdHome = t > 3600 && t < 3900;
    traffic.holdForPlayer('home', holdHome);
    traffic.update(dt, t, null, 'home');
    const snap = traffic.snapshot();
    for (const region of ['home', 'island']) {
      const S = stats[region];
      const ap = AIRFIELDS[region];
      const mine = snap.filter((f) => f.region === region);
      S.maxPerField = Math.max(S.maxPerField, mine.length);
      const users = mine.filter((f) => RW.includes(f.phase) || (f.phase === 'taxiIn' && onRunway(ap, f.x, f.z, 30)));
      S.maxUsers = Math.max(S.maxUsers, users.length);
      if (holdHome && region === 'home') for (const f of mine) if (f.phase === 'takeoff' || (f.phase === 'lineup' && !last.get(f.callsign)?.startsWith('lineup'))) S.holdViolation = true;
      // the runway's actual occupancy: someone on it (ATC's runwayBusy also counts short final)
      const busy = users.length > 0;
      if (traffic.runwayBusy(region).busy) S.atcBusy = (S.atcBusy ?? 0) + dt;
      if (busy && S.busySince < 0) S.busySince = t;
      if (!busy && S.busySince >= 0) {
        S.occ.push(t - S.busySince);
        S.busySince = -1;
      }
      const ground = mine.filter((f) => f.y < 1 && f.phase !== 'parked');
      for (let a = 0; a < ground.length; a++)
        for (let b = a + 1; b < ground.length; b++) {
          const d = Math.hypot(ground[a].x - ground[b].x, ground[a].z - ground[b].z);
          // two at their stands' pushback points can be close side by side; moving ones must not
          if (ground[a].kt > 1 || ground[b].kt > 1) S.minGap = Math.min(S.minGap, d);
        }
      for (const f of mine) {
        if (![f.x, f.y, f.z].every(Number.isFinite)) S.nan = true;
        const key = `${region}:${f.callsign}`;
        const prev = last.get(key);
        if (prev !== f.phase) {
          if (f.phase === 'roll') S.landed++;
          if (prev === 'taxiIn' && f.phase === 'parked') S.parked++;
          if (f.phase === 'goaround') S.ga++;
          last.set(key, f.phase);
        }
        S.seen.set(key, f.phase);
      }
      for (const [key, ph] of S.seen) if ((ph === 'climb' || ph === 'goaround') && !mine.some((f) => `${region}:${f.callsign}` === key)) {
        S.gone++;
        S.seen.delete(key);
        last.delete(key);
      }
    }
  }
  for (const region of ['home', 'island']) {
    const S = stats[region];
    const occ = S.occ.filter((o) => o > 5);
    const mean = occ.reduce((a, b) => a + b, 0) / Math.max(1, occ.length);
    console.log(`${region}: ${S.landed} landings, ${S.parked} parked, ${S.gone} gone, ${S.ga} go-arounds; runway occupied ${occ.length}× mean ${mean.toFixed(0)} s (max ${Math.max(...occ).toFixed(0)} s); closest moving aircraft ${S.minGap.toFixed(0)} m; ATC sees it busy ${((100 * (S.atcBusy ?? 0)) / (minutes * 60)).toFixed(0)} % of the time`);
    check(!S.nan, `${region}: positions stay finite`);
    check(S.maxUsers <= 1, `${region}: one runway user at a time (max ${S.maxUsers})`);
    check(S.maxPerField <= 3, `${region}: at most three AI aircraft (max ${S.maxPerField})`);
    check(S.landed >= minutes / (region === 'home' ? 12 : 20), `${region}: arrivals land (${S.landed} in ${minutes} min)`);
    check(S.parked >= S.landed - 3 - S.ga, `${region}: arrivals reach their stands (${S.parked} of ${S.landed})`);
    check(S.gone >= minutes / (region === 'home' ? 12 : 20), `${region}: departures leave (${S.gone})`);
    check(mean > 40 && mean < 95, `${region}: each movement holds the runway about a minute (${mean.toFixed(0)} s)`);
    check(S.minGap > 45, `${region}: aircraft keep apart on the ground (${S.minGap.toFixed(0)} m)`);
  }
  check(!stats.home.holdViolation, 'holding for the player: nobody lines up or takes off');
  check(models <= 7, `models are pooled (${models} made)`);
  check(standEvents.some((e) => e.endsWith('arrived')) && standEvents.some((e) => e.endsWith('departing')), `stand events (${standEvents.length})`);
  const said = (re) => lines.filter((l) => re.test(l.u.text)).length;
  check(said(/cleared to land/) >= stats.home.landed, `landing clearances (${said(/cleared to land/)})`);
  check(said(/cleared for takeoff/) >= stats.home.gone, `takeoff clearances (${said(/cleared for takeoff/)})`);
  check(said(/pushback approved/) > 0 && said(/taxi to holding point/) > 0 && said(/taxi to stand/) > 0, 'ground calls');
  check(heard > 0 && heard < lines.length, `the player hears their region's lines (${heard} of ${lines.length})`);
  check(jets > 0, 'the engines are heard');
  for (const l of lines.slice(0, 14)) console.log(`     [${l.region ?? 'sea'} ${l.station}] ${l.u.from}: ${l.u.text}`);

  // ---------------------------------------------------------------- the vehicles
  for (const region of ['home', 'island']) {
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
    const fleet = new Fleet(origin, kinds, false);
    const drivers = new Drivers(fleet, site.routes, origin);
    const bodies = drivers.all;
    const n = site.routes.length;
    // the leading body of each driver: the first of its group
    const leads = [];
    {
      let k = 0;
      for (const r of site.routes) {
        leads.push(k);
        k += 1 + (r.train?.count ?? 0);
      }
    }
    const moved = new Array(n).fill(0);
    const prev = leads.map((k) => ({ x: bodies[k].x, z: bodies[k].z }));
    let stuck = 0;
    let overlap = 0;
    let worst = '';
    const window = new Array(n).fill(0);
    for (let i = 0; i < (30 * 60) / dt; i++) {
      drivers.update(dt, [], false);
      leads.forEach((k, j) => {
        const b = bodies[k];
        const d = Math.hypot(b.x - prev[j].x, b.z - prev[j].z);
        moved[j] += d;
        window[j] += d;
        prev[j].x = b.x;
        prev[j].z = b.z;
      });
      // every 4 minutes each vehicle must have got somewhere (stops last at most 80 s)
      if (i % ((240) / dt) === 0 && i > 0) {
        window.forEach((w, j) => {
          if (w < 20) {
            stuck++;
            worst = `${site.routes[j].kind} #${j}`;
          }
          window[j] = 0;
        });
      }
      if (i % 10 === 0)
        for (let a = 0; a < leads.length; a++)
          for (let b = a + 1; b < leads.length; b++) {
            const A = bodies[leads[a]];
            const B = bodies[leads[b]];
            if (Math.hypot(A.x - B.x, A.z - B.z) < Math.min(A.hl, B.hl) * 0.8) overlap++;
          }
    }
    const laps = site.routes.map((r, j) => moved[j] / r.path.length);
    console.log(`${region}: ${n} vehicles, ${bodies.length} bodies; laps in 30 min ${Math.min(...laps).toFixed(1)}..${Math.max(...laps).toFixed(1)}`);
    check(stuck === 0, `${region}: no vehicle stalls (${stuck}${worst ? `, e.g. ${worst}` : ''})`);
    check(overlap === 0, `${region}: vehicles never overlap (${overlap})`);
    check(Math.min(...laps) > 0.5, `${region}: every vehicle gets round its loop`);
  }
} finally {
  await server.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
