// The airports' and the island's people (world/crowd/travellers.ts) in their places: Funfair
// International's terminal with gate 3's bridge docked to a stand-in A320, and Palm Cay's terminal
// with S2's airstairs docked, and the beach park. The far place sleeps, as in the game; `place`
// says which one the visitor is in. The simulation runs `pre` seconds before the first frame so
// everyone is well into their day, and `run` starts the visitor's flight boarding or unloading
// `at` seconds into that.
//
//   ?scene=travellers&cam=150,1.7,436&look=60,1.7,500                       the hall: kerb, check-in, security
//   ?scene=travellers&cam=-70,8,512&look=-30,3,540&run=board&at=-25         gate 3 boarding, onto the bridge
//   ?scene=travellers&place=island&cam=-8,4,40575&look=-28,2,40590&run=deplane&at=-14   down S2's airstairs
//   ?scene=travellers&place=island&cam=0,3,41395&look=0,0,41440              the promenade and the beach
//   ?scene=travellers&check=1                                               route checks (console)
//
// Other parameters: n (passengers, default 18), pre (seconds, default 90), tier (as quality).
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PreviewScene } from '../main';
import { AIRFIELDS } from '../../aviation/airports';
import { HomeTerminal } from '../../world/airport/terminal';
import { Landside } from '../../world/airport/landside';
import { IslandTerminal } from '../../world/island/island-terminal';
import { PalmCay } from '../../world/island/island';
import { GUEST_ANIMS_URL, GUESTS_URL, PeopleFactory } from '../../world/crowd/people';
import { Travellers, type Boarding } from '../../world/crowd/travellers';
import type { Region } from '../../world/geo';
import { homeStage, standIn } from './terminal';
import { stage } from './island';

const preview: PreviewScene = async (p) => {
  const { ctx, params } = p;
  const place: Region = params.get('place') === 'island' ? 'island' : 'home';
  const loader = new GLTFLoader();
  const [guests, anims] = await Promise.all([loader.loadAsync(GUESTS_URL), loader.loadAsync(GUEST_ANIMS_URL)]);
  const factory = new PeopleFactory(guests, anims);

  // both places are built (the people are planned on both, as in the game); only one is staged
  const home = new HomeTerminal(ctx);
  const island = new IslandTerminal(ctx);
  const palmCay = new PalmCay(ctx);
  ctx.scene.add(home.group, island.group, palmCay.group);
  const extras: { update(dt: number, t: number): void }[] = [];
  if (place === 'home') {
    homeStage(p);
    const land = new Landside(ctx);
    ctx.scene.add(land.group);
    extras.push({ update: (dt, t) => land.update(dt, t, ctx.camera) });
    for (const s of AIRFIELDS.home.stands) {
      standIn(ctx.scene, s.x, s.z, s.heading);
      home.bridges[s.id].dock(true);
    }
    p.onFrame(() => {
      const n = p.env?.night ?? 0;
      home.setNight(n);
      land.setNight(n);
    });
  } else {
    stage(p, (k) => {
      island.setNight(k);
      palmCay.setNight(k);
    });
    island.stairs.S2?.dock(true);
  }
  // let the bridges and stairs finish docking before the paths are read
  for (let i = 0; i < 600; i++) {
    home.update(1 / 30, i / 30, ctx.camera);
    island.update(1 / 30, i / 30);
  }

  const tierParam = params.get('tier');
  const tier = tierParam === 'lowest' || tierParam === 'low' || tierParam === 'medium' || tierParam === 'high' ? tierParam : ctx.quality.tier;
  const people = new Travellers(ctx, factory, { home, island, palmCay, shadows: ctx.quality.shadows, tier });

  if (params.get('check')) {
    // probe=ax,az,bx,bz;…: extra walks to try (and show the corners of)
    const probes = (params.get('probe') ?? '')
      .split(';')
      .filter(Boolean)
      .map((q) => q.split(',').map(Number))
      .map(([ax, az, bx, bz]): [{ x: number; z: number }, { x: number; z: number }] => [{ x: ax, z: az }, { x: bx, z: bz }]);
    const r = people.check(probes);
    for (const n of r.notes) console.warn(`[check] ${n}`);
    console.warn(`[check] ${r.summary}`);
    for (const f of r.fails) console.warn(`[check] FAIL ${f}`);
    console.warn(`[check] ${r.fails.length ? 'FAILED' : 'PASSED'}`);
  }

  // the visitor's flight's walks, as the game hands them over
  const homeBoard = [...home.spots.boardingQueue.map((q) => ({ x: q.x, y: 0, z: q.z })), ...home.bridges.S3.walkPath.slice(1)];
  const homeOff = [...[...home.bridges.S3.walkPath].reverse(), ...home.spots.arrivalsPath.slice(1).map((q) => ({ x: q.x, y: 0, z: q.z }))];
  const S2 = island.stairs.S2;
  const isleBoard = [...island.spots.boardingPath.map((q) => ({ x: q.x, y: 0, z: q.z })), ...S2.path.slice(1)];
  const isleOff = [...[...S2.path].reverse(), ...island.spots.arrivalsPath.slice(1).map((q) => ({ x: q.x, y: 0, z: q.z }))];

  const run = params.get('run');
  const n = Number(params.get('n') ?? 18);
  const pre = Number(params.get('pre') ?? 90);
  const at = pre + Number(params.get('at') ?? -20);
  let flight: Boarding | null = null;
  let t = 0;
  const step = (dt: number) => {
    t += dt;
    if (run && !flight && t >= at) {
      const path = place === 'home' ? (run === 'board' ? homeBoard : homeOff) : run === 'board' ? isleBoard : isleOff;
      flight = run === 'board' ? people.board(place, n, path) : people.deplane(place, n, path);
    }
    people.update(dt, t, ctx.camera, place);
  };

  let first = true;
  p.onFrame((dt) => {
    if (first) {
      // the day so far, simulated (at the frame rate the game runs at, with the camera where it is)
      first = false;
      ctx.camera.updateMatrixWorld();
      const trace = Number(params.get('trace') ?? 0);
      for (let i = 0; i < pre * 30; i++) {
        step(1 / 30);
        // trace=<seconds>: what everyone's up to every so often through the day so far
        if (trace && i % Math.round(trace * 30) === 0) {
          const f = flight as Boarding | null;
          console.warn(`[trace] t=${t.toFixed(0)}${f ? ` flight ${(f.progress * 100).toFixed(0)}%` : ""} ${JSON.stringify(people.debug(params.has("where")))}`);
        }
      }
      // follow=<what they're doing>: the camera a few paces (fd, default 4) ahead of and beside the first one doing it
      const follow = params.get('follow');
      const who = follow ? people.whereIs(follow) : null;
      if (who) {
        const fd = Number(params.get('fd') ?? 4);
        const a = who.heading + 0.6;
        ctx.camera.position.set(who.x - Math.sin(a) * fd, who.y + 1.6, who.z - Math.cos(a) * fd);
        ctx.camera.lookAt(who.x, who.y + 0.9, who.z);
        ctx.camera.updateMatrixWorld();
      } else if (follow) console.warn(`[travellers] nobody ${follow}`);
      people.setNight(p.env?.night ?? 0);
      const f = flight as Boarding | null;
      console.warn(`[travellers] ${place} t=${t.toFixed(0)}s ${JSON.stringify(people.debug())}${f ? ` · flight ${(f.progress * 100).toFixed(0)}%${f.done ? ' done' : ''}` : ''}`);
    }
    step(dt);
    people.setNight(p.env?.night ?? 0);
    for (const e of extras) e.update(dt, t);
    if (place === 'home') home.update(dt, t, ctx.camera);
    else {
      island.update(dt, t);
      palmCay.update(dt, t, ctx.camera);
    }
  });
  p.view(place === 'home' ? { x: 150, y: 1.7, z: 436 } : { x: 0, y: 3, z: 41395 }, place === 'home' ? { x: 60, y: 1.7, z: 500 } : { x: 0, y: 0, z: 41440 });
};
export default preview;
