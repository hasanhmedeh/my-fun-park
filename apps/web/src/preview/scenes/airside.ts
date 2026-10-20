// An airport's airside (world/airport/airside.ts) on its airfield, land and sea (the airfield-home
// scene's staging), with the terminal and its jet bridges docked at the parked aircraft.
//
//   ?scene=airside&cam=-30,1.7,552&look=-90,2,580                     on the apron at eye height
//   ?scene=airside&cam=200,300,900&look=0,0,600&far=60000             the apron from 300 m
//   ?scene=airside&cam=470,70,700&look=470,50,612                     the control tower's cab
//   ?scene=airside&cam=-560,30,700&look=-650,8,510                    the hangars, one open
//   ?scene=airside&cam=760,40,720&look=680,5,590                      cargo, the freighter
//   ?scene=airside&cam=1000,40,740&look=950,5,600                     the fire station and fuel farm
//   ?scene=airside&region=island&cam=150,120,40380&look=0,0,40560     Palm Cay's apron
//   &player=1 the player's aircraft taxiing in to its stand (the marshaller waves it in), &push=1
//   the tug pushing it back, &service=S5 a traffic stand's belt loaders working, &hour=23 night,
//   &stats=1 the airside's meshes and triangles (console)
import * as THREE from 'three';
import type { PreviewApi, PreviewScene } from '../main';
import { AIRFIELDS } from '../../aviation/airports';
import type { Region } from '../../world/geo';
import { Airside, reservedStands } from '../../world/airport/airside';
import { HomeTerminal } from '../../world/airport/terminal';
import { IslandTerminal } from '../../world/island/island-terminal';
import { createA320, restVisual } from '../../world/airport/a320-model';
import { LIVERIES } from '../../world/airport/liveries';
import { headingVec } from '../../world/geo';
import { stage } from './airfield-home';
import { groupStats } from './terminal';

const preview: PreviewScene = (p: PreviewApi) => {
  const region = (p.params.get('region') ?? 'home') as Region;
  const ap = AIRFIELDS[region];
  const { ctx } = p;
  stage(p, region);
  const air = new Airside(ctx, ap, { reserved: reservedStands(region) });
  ctx.scene.add(air.group);
  let night = 0;
  if (region === 'home') {
    const term = new HomeTerminal(ctx);
    ctx.scene.add(term.group);
    for (const id of air.parkedStands) term.bridges[id].dock(true);
    p.onFrame((dt, t) => {
      term.setNight(night);
      term.update(dt, t, ctx.camera);
    });
  } else {
    const term = new IslandTerminal(ctx);
    ctx.scene.add(term.group);
    p.onFrame((dt, t) => {
      term.setNight(night);
      term.update(dt, t);
    });
  }
  for (const id of (p.params.get('service') ?? '').split(',').filter(Boolean)) air.setStandService(id, true);

  // the player's aircraft: in along the lead-in line to the stop mark, or pushed back off it
  const st = ap.stands.find((s) => s.id === ap.playerStand)!;
  const push = p.params.get('push') === '1';
  if (p.params.get('player') === '1' || push) {
    const plane = createA320({ livery: LIVERIES.funfair, detail: 'ai', shadows: ctx.quality.shadows });
    const v = restVisual();
    v.lights.nav = v.lights.beacon = v.lights.taxi = true;
    ctx.scene.add(plane.group);
    const f = headingVec(st.heading);
    const pose = { x: st.x, z: st.z, heading: st.heading };
    if (push) air.tug.attach(st.id);
    p.onFrame((dt, t) => {
      // in: 70 m out to the stop over ~50 s, slowing; push: back 45 m over 60 s, then let go
      const k = Math.min(1, (t % 70) / 55);
      const back = push ? 45 * k * k * (3 - 2 * k) : 70 * (1 - k) * (1 - k);
      pose.x = st.x - f.x * back;
      pose.z = st.z - f.z * back;
      plane.group.position.set(pose.x, 0, pose.z);
      plane.group.rotation.set(0, -pose.heading * (Math.PI / 180), 0, 'YXZ');
      plane.setNight(night);
      plane.setVisual(v, dt, t);
      air.setPlayerAircraft(pose);
      if (push) {
        if (k < 1 && !air.tug.attached) air.tug.attach(st.id);
        if (k < 1) air.tug.follow(pose, dt);
        else if (air.tug.attached) air.tug.detach();
      }
    });
  }

  p.onFrame((dt, t) => {
    night = p.env?.night ?? 0;
    air.setNight(night);
    air.update(dt, t, ctx.camera);
  });
  if (p.params.get('stats')) console.warn(`airside ${groupStats(air.group)}`);
  const c = region === 'home' ? new THREE.Vector3(200, 300, 900) : new THREE.Vector3(150, 300, 40300);
  p.view({ x: c.x, y: c.y, z: c.z }, { x: 0, y: 0, z: region === 'home' ? 600 : 40560 });
};
export default preview;
