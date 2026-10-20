// The Jet-Ski Race (world/attractions/island/jetski.ts) in Palm Cay's lagoon, with the beach park
// behind it. While idle the rivals lap the course; race=1 starts a race with an autopilot in your
// seat (no input attached, so it rides like a rival) and the race's own camera following you.
//
//   ?scene=jetski                                    the dock from the beach, rivals lapping
//   ?scene=jetski&race=1&skip=1                      on the grid, lights coming on
//   ?scene=jetski&race=1&skip=40                     mid-race, chase camera (jcam=pov|high)
//   ?scene=jetski&race=1&until=air                   the first jump you take, frozen in the air
//   ?scene=jetski&race=1&until=finish                just past the flag
//   &hud=1                                           with the race HUD over it
//   &close=x,y,z&freeze=1                            a close camera in your ski's frame (x right, y up, z back), sim held
//   &people=0                                        the merged stand-in riders (no people loaded)
// A cam / look in the URL overrides the race camera.
import * as THREE from 'three';
import type { PreviewScene } from '../main';
import type { Ctx } from '../../world/context';
import type { UI } from '../../world/ui';
import { SEA_Y } from '../../world/geo';
import { PalmCay } from '../../world/island/island';
import { JetSki } from '../../world/attractions/island/jetski';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GUEST_ANIMS_URL, GUESTS_URL, PeopleFactory, VISITOR_LOOK } from '../../world/crowd/people';
import { stage } from './island';

const preview: PreviewScene = async (p) => {
  const q = p.params;
  let ctx: Ctx = p.ctx;
  if (q.get('hud') === '1') {
    // a real #hud for the race's own HUD to go into, styled as in the game
    await import('../../styles.css');
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.className = 'hud';
    const panel = document.createElement('aside');
    panel.id = 'panel';
    panel.hidden = true;
    hud.append(panel);
    document.body.append(hud);
    const ui = p.ctx.ui;
    ctx = { ...p.ctx, ui: new Proxy(ui, { get: (t, key) => (key === 'hud' ? hud : Reflect.get(t, key)) }) as UI };
  }
  const park = new PalmCay(ctx);
  ctx.scene.add(park.group);
  const js = new JetSki(ctx);
  if (q.get('people') !== '0') {
    const loader = new GLTFLoader();
    const [guests, anims] = await Promise.all([loader.loadAsync(GUESTS_URL), loader.loadAsync(GUEST_ANIMS_URL)]);
    js.setPeople(new PeopleFactory(guests, anims), VISITOR_LOOK);
  }
  stage(p, (k) => {
    park.setNight(k);
    js.setNight(k);
  });

  // the sim keeps its own clock so a fast-forward and the frames that follow are one timeline
  let t = 0;
  const step = (dt: number) => {
    t += dt;
    js.update(dt, t);
  };
  const follow = q.get('race') === '1' && !q.get('cam');
  const camera = p.ctx.camera;
  if (q.get('race') === '1') {
    js.start();
    const order = ['chase', 'pov', 'high'];
    for (let k = 0; k < order.indexOf(q.get('jcam') ?? 'chase'); k++) js.cycleCamera();
    const until = q.get('until');
    const skip = Number(q.get('skip') ?? 0);
    const dt = 1 / 60;
    const settle = (n: number) => {
      for (let k = 0; k < n; k++) {
        step(dt);
        js.updateCamera(camera, dt);
      }
    };
    if (until === 'air') {
      // ride until you're properly airborne, a little past the top of the jump
      while (t < 400 && !(js.ski.air && js.ski.airT > 0.45 && js.ski.vy < 2.5 && js.ski.y > SEA_Y + 1)) settle(1);
    } else if (until === 'finish') {
      while (t < 400 && js.stage !== 'done') settle(1);
      settle(Math.round(2.5 / dt));
    } else settle(Math.round(skip / dt));
  }
  const freeze = q.get('until') === 'air' || q.get('freeze') === '1';
  const near = q.get('close')?.split(',').map(Number);
  const closeUp = () => {
    if (!near) return;
    const s = js.ski;
    const off = new THREE.Vector3(near[0], near[1], near[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.h);
    camera.position.set(s.x + off.x, s.y + off.y, s.z + off.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(s.x, s.y + 0.9, s.z);
  };
  p.onFrame((dt, ft) => {
    park.update(dt, ft, camera);
    if (!freeze) step(dt);
    if (!follow) return;
    // the shadows and the grass follow the ski
    p.view(camera.position, new THREE.Vector3(js.ski.x, js.ski.y, js.ski.z));
    js.updateCamera(camera, freeze ? 0 : dt);
    closeUp();
  });
  if (follow) {
    js.updateCamera(camera, 1);
    p.view(camera.position.clone(), new THREE.Vector3(js.ski.x, js.ski.y, js.ski.z));
    js.updateCamera(camera, 0);
    closeUp();
  } else p.view({ x: 30, y: 4, z: 41420 }, { x: 64, y: 0, z: 41600 });
};
export default preview;
