// The AI traffic (aviation/traffic.ts) at work over an airport's airfield, airside and terminal.
// `warp` runs the traffic that many seconds ahead before the first frame (the schedule is seeded,
// so a given warp always shows the same moment); the status line lists every flight's phase.
//
//   ?scene=traffic&warp=222&cam=2600,120,960&look=1500,40,900&far=60000      an arrival on short final for 27 (home)
//   ?scene=traffic&warp=258&cam=500,30,760&look=300,0,880                    vacating by the rapid exit E2
//   ?scene=traffic&warp=110&cam=200,40,700&look=90,0,640                      a pushback from S5 behind the tug
//   ?scene=traffic&warp=372&cam=1000,25,860&look=840,3,900                   lined up on 27 at A4
//   ?scene=traffic&region=island&warp=200&cam=300,60,40420&look=0,0,40450     Palm Cay's traffic
//   &hour=23 at night (the lights by phase), &list=1 print the flights every 10 s (console)
import type { PreviewApi, PreviewScene } from '../main';
import { AIRFIELDS } from '../../aviation/airports';
import { Traffic } from '../../aviation/traffic';
import type { Region } from '../../world/geo';
import { Airside, reservedStands } from '../../world/airport/airside';
import { HomeTerminal } from '../../world/airport/terminal';
import { IslandTerminal } from '../../world/island/island-terminal';
import { createA320 } from '../../world/airport/a320-model';
import { stage } from './airfield-home';

const preview: PreviewScene = (p: PreviewApi) => {
  const region = (p.params.get('region') ?? 'home') as Region;
  const ap = AIRFIELDS[region];
  const { ctx } = p;
  stage(p, region);
  const air = new Airside(ctx, ap, { reserved: reservedStands(region) });
  ctx.scene.add(air.group);
  const home = region === 'home' ? new HomeTerminal(ctx) : null;
  const island = region === 'island' ? new IslandTerminal(ctx) : null;
  ctx.scene.add((home ?? island)!.group);
  if (home) for (const id of air.parkedStands) home.bridges[id].dock(true);

  const traffic = new Traffic(ctx, {
    createPlane: (o) => createA320(o),
    onStand: (r, id, state) => {
      if (r !== region) return;
      home?.bridges[id]?.dock(state === 'arrived');
      air.setStandService(id, state === 'arrived');
    },
  });
  ctx.scene.add(traffic.group);
  const lines: string[] = [];
  traffic.onRadioAt = (u, r) => {
    if (r === region || r === null) lines.push(`${u.from}: ${u.text}`);
  };
  // run the schedule ahead (with the camera where it'll be, so the far-away logic doesn't kick in)
  const warp = Number(p.params.get('warp') ?? 0);
  for (let t = 0; t < warp; t += 0.1) traffic.update(0.1, t, null, region);
  const list = p.params.get('list') === '1';
  let nextList = 0;
  p.onFrame((dt, t) => {
    const n = p.env?.night ?? 0;
    const tt = t + warp;
    traffic.setNight(n);
    traffic.update(dt, tt, null, region);
    air.setAircraft(traffic.bodies(region));
    air.setNight(n);
    air.update(dt, tt, ctx.camera);
    home?.setNight(n);
    home?.update(dt, tt, ctx.camera);
    island?.setNight(n);
    island?.update(dt, tt);
    if (list && tt > nextList) {
      nextList = tt + 10;
      console.warn(`t=${tt.toFixed(0)} ${traffic.snapshot().map((f) => `${f.callsign} ${f.phase} (${f.x.toFixed(0)}, ${f.y.toFixed(0)}, ${f.z.toFixed(0)}) ${f.kt.toFixed(0)} kt`).join(' | ')}`);
      for (const l of lines.splice(0)) console.warn(`  ${l}`);
    }
  });
  if (region === 'home') p.view({ x: 2600, y: 120, z: 960 }, { x: 1500, y: 40, z: 900 });
  else p.view({ x: 300, y: 60, z: 40420 }, { x: 0, y: 0, z: 40450 });
};
export default preview;
