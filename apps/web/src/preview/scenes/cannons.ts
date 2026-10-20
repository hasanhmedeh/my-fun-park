// Pirate Cannons (world/attractions/island/cannons.ts) on Palm Cay: the fort on the south-west
// beach and the pirate fleet in the lagoon. With `fire` the scene plays a round by itself: it
// tracks a ship of that kind with the mouse (real pointer events on the canvas, leading the ship
// by the ball's flight time) and fires every `every` seconds from `at` until she sinks or `n`
// shots have gone. The game's own camera is used unless `cam` is given.
//
//   ?scene=cannons&cam=-300,30,41330&look=-385,4,41440                  the fort from the beach
//   ?scene=cannons&play=1&view=lookout                                  aiming, from the tower
//   ?scene=cannons&fire=sloop&frames=200                                hits, then a sinking
//   ?scene=cannons&fire=keg&frames=150                                  the powder kegs go up
//   (also: zoom=fov narrows the game's camera onto the target, wind=fromDeg,kt (default 120,0 while firing), hud=1 to show the unstyled HUD)
import * as THREE from 'three';
import type { PreviewScene } from '../main';
import { PalmCay } from '../../world/island/island';
import { Cannons } from '../../world/attractions/island/cannons';
import { fortToWorld, GUNS, lay, rangeAt } from '../../world/attractions/island/cannons-sim';
import { SEA_Y } from '../../world/geo';
import type { Ship, ShipKind } from '../../world/attractions/island/cannons-ships';
import { stage } from './island';

const preview: PreviewScene = (p) => {
  const park = new PalmCay(p.ctx);
  p.ctx.scene.add(park.group);
  const game = new Cannons(p.ctx);
  stage(p, (k) => {
    park.setNight(k);
    game.setNight(k);
  });
  const q = p.params;
  const kind = q.get('fire') as ShipKind | null;
  const play = kind !== null || q.get('play') === '1';
  const fixed = q.has('cam');
  const zoom = Number(q.get('zoom') ?? 0);
  const at = Number(q.get('at') ?? 1);
  const every = Number(q.get('every') ?? 1.1);
  const shots = Number(q.get('n') ?? 6);
  const [wFrom, wKt] = (q.get('wind') ?? (kind ? '120,0' : '')).split(',').map(Number);
  if (Number.isFinite(wFrom) && Number.isFinite(wKt)) game.setWind(wFrom, wKt);
  if (play) {
    game.start();
    game.input = null;
    if (q.get('view') === 'lookout') game.cycleCamera();
    if (q.get('hud') !== '1') document.getElementById('cn-hud')!.hidden = true;
    // the range tag is placed by the game's camera, which a fixed view doesn't run
    if (fixed) document.querySelector<HTMLElement>('.cn-tag')!.style.display = 'none';
  }

  // the middle gun's pivot, from which the lead is worked out
  const g = fortToWorld(GUNS[1].lx, GUNS[1].lz);
  const lead = new THREE.Vector3();
  const v = new THREE.Vector3();
  const canvas = p.ctx.renderer.domElement;
  let target: Ship | null = null;
  let fired = 0;
  let nextShot = at;
  const pointer = (type: string, pt: THREE.Vector3) => {
    v.copy(pt).project(p.ctx.camera);
    const r = canvas.getBoundingClientRect();
    const init = { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height, button: 0, pointerType: 'mouse', bubbles: true };
    canvas.dispatchEvent(new PointerEvent(type, init));
  };

  p.onFrame((dt, t) => {
    park.update(dt, t, p.ctx.camera);
    game.update(dt, t);
    if (!play) return;
    if (kind) {
      target ??= game.ships.find((s) => s.kind === kind && s.alive) ?? null;
      if (target && target.alive) {
        // lead her by the ball's flight time (a few passes, since the time depends on the range)
        let T = 2;
        for (let i = 0; i < 4; i++) {
          target.ahead(T, lead);
          const l = lay(g.x, GUNS[1].y, g.z, lead.x, lead.z);
          T = rangeAt(l.elev, GUNS[1].y - SEA_Y).t;
        }
        lead.y = SEA_Y;
        pointer('pointermove', lead);
        if (t >= nextShot && fired < shots) {
          game.action();
          fired++;
          nextShot = t + every;
        }
      }
    }
    // the game's camera (which also draws the mark and the arc for it), unless the URL fixes one
    if (!fixed) game.updateCamera(p.ctx.camera, dt);
    // zoom: the same camera, narrowed onto the target, to check the mark and the hits up close
    if (zoom && target) {
      p.ctx.camera.fov = zoom;
      p.ctx.camera.updateProjectionMatrix();
      p.ctx.camera.lookAt(target.group.position);
    }
  });
  p.view({ x: -300, y: 30, z: 41330 }, { x: -385, y: 4, z: 41440 });
};
export default preview;
