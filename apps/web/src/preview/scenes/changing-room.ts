// The changing room (world/attractions/changing-room.ts) beside Rosa's Ticket Booth, in the park,
// with its prompt ring and the booth's drawn as Zones would draw them.
//
//   ?scene=changing-room                      from the entrance plaza
//   ?scene=changing-room&view=close           close up on the opening
//   ?scene=changing-room&view=inside          the customiser's framing (no panel)
//   ?scene=changing-room&view=top             from above: where it stands among the booth, the garland and the lawn
//   ?scene=changing-room&avatar=Male_Adult_04 someone standing inside (a hero avatar, idling)
import type { PreviewScene } from '../main';
import { Booth } from '../../world/attractions/landmarks';
import { ChangingRoom, CHANGING_ROOM } from '../../world/attractions/changing-room';
import { ZONES } from '../../world/layout';
import { clearLawn, loadManifest, PreviewVisitor, ringAt } from './customiser';

const scene: PreviewScene = async (p) => {
  const q = p.params;
  const booth = new Booth(p.ctx);
  const room = new ChangingRoom(p.ctx);
  // (?lawn=1 leaves the grass coming up through the deck, as it will until environment.ts mows it)
  if (q.get('lawn') !== '1') clearLawn(p.ctx.scene);
  p.onFrame((dt, t) => {
    booth.update(dt, t);
    room.update(dt, t);
  });
  ringAt(p.ctx.scene, room.zone.x, room.zone.z, room.zone.radius);
  ringAt(p.ctx.scene, ZONES.booth.x, ZONES.booth.z, ZONES.booth.radius);

  const avatar = q.get('avatar');
  if (avatar) {
    const visitor = new PreviewVisitor(p, await loadManifest());
    visitor.group.position.copy(room.standAt);
    visitor.group.rotation.y = CHANGING_ROOM.yaw;
    await visitor.wear({ v: 1, avatar, top: null, bottom: null, shoes: null, hair: null, height: 1, build: 1 });
  }

  const c = CHANGING_ROOM;
  const view = q.get('view') ?? 'plaza';
  if (view === 'close') p.view({ x: c.x - 4.2, y: 2.1, z: c.z + 5.2 }, { x: c.x, y: 1.3, z: c.z });
  else if (view === 'inside') {
    const shot = room.shot(p.ctx.camera.aspect < 0.8);
    p.view(shot.pos, shot.look);
  } else if (view === 'top') p.view({ x: c.x - 2, y: 26, z: c.z + 18 }, { x: c.x - 3, y: 0, z: c.z + 1 });
  else p.view({ x: -3, y: 2.4, z: 56 }, { x: 15, y: 1.6, z: 41 });
};
export default scene;
