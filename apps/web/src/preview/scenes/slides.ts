// Splash Tower (world/attractions/island/slides.ts) on Palm Cay, with the island's park round it.
// While idle, guests keep going down all three slides; ride=1 starts a round with the attraction's
// own camera and fast-forwards it to the moment asked for, then freezes it there.
//
//   ?scene=slides                                         the tower from the path in from the plaza
//   ?scene=slides&ride=1&at=climb&k=0.6                   the crane shot up the stairs, 60% of the way
//   ?scene=slides&ride=1&at=pick&slide=2&hud=1            on the deck, the picker on slide 2
//   ?scene=slides&ride=1&slide=1&k=0.4&scam=pov&hud=1     slide 1, 40% of the way down (scam=chase|drone)
//   ?scene=slides&ride=1&slide=3&at=splash&scam=chase     just after hitting the pool
//   &park=0                                               without the island's park (draw-call count)
// A cam / look in the URL overrides the ride's camera.
import * as THREE from 'three';
import type { PreviewScene } from '../main';
import type { Ctx } from '../../world/context';
import type { Input } from '../../world/input';
import type { UI } from '../../world/ui';
import { PalmCay } from '../../world/island/island';
import { Slides } from '../../world/attractions/island/slides';
import { stage } from './island';

const preview: PreviewScene = async (p) => {
  const q = p.params;
  let ctx: Ctx = p.ctx;
  if (q.get('hud') === '1') {
    // a real #hud for the picker and the ride HUD to go into, styled as in the game
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
  const park = q.get('park') === '0' ? null : new PalmCay(ctx);
  if (park) ctx.scene.add(park.group);
  const sl = new Slides(ctx);
  stage(p, (k) => {
    park?.setNight(k);
    sl.setNight(k);
  });
  const camera = p.ctx.camera;
  let t = 0;
  const step = (dt: number) => {
    t += dt;
    sl.update(dt, t);
    sl.updateCamera(camera, dt);
  };
  const ride = q.get('ride') === '1';
  if (ride) {
    // a stand-in for the keyboard: hands off, or a steer pulse to move the picker's highlight
    const input = { throttle: 0, steer: 0, boost: false, lift: 0, paused: false };
    sl.input = input as unknown as Input;
    // let the guests get going first, so the other slides have someone on them
    for (let i = 0; i < 4 * 60; i++) sl.update(1 / 60, (t += 1 / 60));
    sl.start();
    const order = ['pov', 'chase', 'drone'];
    for (let k = 0; k < order.indexOf(q.get('scam') ?? 'pov'); k++) sl.cycleCamera();
    const at = q.get('at') ?? 'ride';
    const k = Number(q.get('k') ?? 0.5);
    const n = Math.max(1, Math.min(3, Number(q.get('slide') ?? 1)));
    const dt = 1 / 60;
    const until = (done: () => boolean) => {
      for (let i = 0; i < 6000 && !done(); i++) step(dt);
    };
    if (at === 'climb') until(() => sl.stage !== 'climb' || t > 4 + 7.5 * k);
    else {
      until(() => sl.stage !== 'climb' || t > 7);
      sl.action();
      for (let i = 1; i < n; i++) {
        input.steer = -1;
        step(dt);
        input.steer = 0;
        step(dt);
      }
      step(0.4);
      if (at !== 'pick') {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: `Digit${n}` }));
        until(() => sl.stage === 'ride');
        if (at === 'splash') until(() => sl.stage === 'float' || sl.stage === 'done');
        else until(() => sl.progress >= k || sl.stage !== 'ride');
        if (at === 'splash') for (let i = 0; i < 12; i++) step(dt);
      }
    }
  }
  const follow = ride && !q.get('cam');
  p.onFrame((dt, ft) => {
    park?.update(dt, ft, camera);
    // frozen at the moment asked for: only the water keeps flowing
    if (!ride) sl.update(dt, ft);
    if (!follow) return;
    p.view(camera.position.clone(), sl.position);
    sl.updateCamera(camera, 0);
  });
  if (!ride) p.view(new THREE.Vector3(-150, 1.7, 41160), new THREE.Vector3(-230, 14, 41120));
  else if (follow) {
    p.view(camera.position.clone(), sl.position);
    sl.updateCamera(camera, 0);
  }
};
export default preview;
