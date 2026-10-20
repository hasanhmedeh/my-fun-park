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
//   ?scene=travellers&place=island&cam=-4,4.5,40572&look=-28,2.4,40590&run=board&at=-30&cut=-30,1.7,40625,-30,1.5,40600
//                                    island boarding, called with the visitor at gate 2's desk, then the cut to the window
//   ?scene=travellers&check=1                                               route checks (console)
//
// Other parameters: n (passengers, default 18), pre (seconds, default 90), tier (as quality).
import * as THREE from 'three';
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
import { JetSki } from '../../world/attractions/island/jetski';
import { Slides } from '../../world/attractions/island/slides';
import { Cannons } from '../../world/attractions/island/cannons';
import { Volley } from '../../world/attractions/island/volley';

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
  // the island's games, as the game builds them (their colliders are what the walk grid routes round)
  const games = { jetski: new JetSki(ctx), slides: new Slides(ctx), cannons: new Cannons(ctx), volley: new Volley(ctx) };
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
      for (const g of Object.values(games)) g.setNight(k);
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
  // the visitor stands where the camera looks (as the game's camera follows them), or at visitor=x,z
  const vq = (params.get('visitor') ?? params.get('look') ?? '').split(',').map(Number);
  if (vq.length >= 2 && vq.every(Number.isFinite)) people.setVisitor(vq.length === 2 ? { x: vq[0], y: 0, z: vq[1] } : { x: vq[0], y: vq[1], z: vq[2] });
  // perf=1: how long the people's update takes, averaged (console)
  const perf = { on: params.has('perf'), ms: 0, n: 0 };

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
  // cut=x,y,z,lx,ly,lz: the camera there till the run starts, then cut to the view (as the game
  // cuts to the gate's window as boarding's called)
  const cutQ = (params.get('cut') ?? '').split(',').map(Number);
  let cutBack: { pos: THREE.Vector3; q: THREE.Quaternion } | null = null;
  const step = (dt: number) => {
    t += dt;
    if (run && !flight && t >= at) {
      if (cutBack) {
        ctx.camera.position.copy(cutBack.pos);
        ctx.camera.quaternion.copy(cutBack.q);
        ctx.camera.updateMatrixWorld();
        cutBack = null;
      }
      const path = place === 'home' ? (run === 'board' ? homeBoard : homeOff) : run === 'board' ? isleBoard : isleOff;
      flight = run === 'board' ? people.board(place, n, path) : people.deplane(place, n, path);
    }
    const t0 = perf.on ? performance.now() : 0;
    people.update(dt, t, ctx.camera, place);
    if (perf.on && t > pre - 20) {
      perf.ms += performance.now() - t0;
      perf.n++;
    }
  };

  let first = true;
  p.onFrame((dt) => {
    if (first) {
      // the day so far, simulated (at the frame rate the game runs at, with the camera where it is)
      first = false;
      if (run && cutQ.length === 6 && cutQ.every(Number.isFinite)) {
        cutBack = { pos: ctx.camera.position.clone(), q: ctx.camera.quaternion.clone() };
        ctx.camera.position.set(cutQ[0], cutQ[1], cutQ[2]);
        ctx.camera.lookAt(cutQ[3], cutQ[4], cutQ[5]);
      }
      ctx.camera.updateMatrixWorld();
      const trace = Number(params.get('trace') ?? 0);
      for (let i = 0; i < pre * 30; i++) {
        step(1 / 30);
        // trace=<seconds>: what everyone's up to every so often through the day so far
        if (trace && i % Math.round(trace * 30) === 0) {
          const f = flight as Boarding | null;
          console.warn(`[trace] t=${t.toFixed(0)}${f ? ` flight ${(f.progress * 100).toFixed(0)}% ${people.debugRun()}` : ""} ${f ? "" : JSON.stringify(people.debug(params.has("where")))}`);
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
      if (perf.on) {
        console.warn(`[perf] people.update ${(perf.ms / Math.max(1, perf.n)).toFixed(3)} ms avg over ${perf.n} steps · ${JSON.stringify(people.counts)}`);
        // and the whole frame drawn, waited for (a pixel read back), with and without the people
        const r = ctx.renderer;
        const px = new Uint8Array(4);
        const gl = r.getContext();
        const time = () => {
          for (let i = 0; i < 5; i++) r.render(ctx.scene, ctx.camera);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const t0 = performance.now();
          for (let i = 0; i < 30; i++) {
            people.update(1 / 60, t, ctx.camera, place);
            r.render(ctx.scene, ctx.camera);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          }
          return (performance.now() - t0) / 30;
        };
        const withPeople = time();
        const shown = ctx.scene.children.filter((o) => o.visible && (o.name === 'luggage' || o.type === 'Group' && o.getObjectByProperty('type', 'SkinnedMesh')));
        for (const o of shown) o.visible = false;
        r.render(ctx.scene, ctx.camera);
        const t0 = performance.now();
        for (let i = 0; i < 30; i++) {
          r.render(ctx.scene, ctx.camera);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        const without = (performance.now() - t0) / 30;
        for (const o of shown) o.visible = true;
        console.warn(`[perf] frame ${withPeople.toFixed(2)} ms with the people (update + draw), ${without.toFixed(2)} ms without (${shown.length} hidden) · calls ${r.info.render.calls}`);
      }
    }
    step(dt);
    people.setNight(p.env?.night ?? 0);
    for (const e of extras) e.update(dt, t);
    if (place === 'home') home.update(dt, t, ctx.camera);
    else {
      island.update(dt, t);
      palmCay.update(dt, t, ctx.camera);
      for (const g of Object.values(games)) g.update(dt, t);
    }
  });
  p.view(place === 'home' ? { x: 150, y: 1.7, z: 436 } : { x: 0, y: 3, z: 41395 }, place === 'home' ? { x: 60, y: 1.7, z: 500 } : { x: 0, y: 0, z: 41440 });
};
export default preview;
