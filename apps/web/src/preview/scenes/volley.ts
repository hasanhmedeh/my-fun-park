// Beach Volley (world/attractions/island/volley.ts) on Palm Cay, with the island players on court.
// While idle the four keep a warm-up rally going; play=… starts a round with an autoplayer that
// presses at the perfect instant, runs it to a moment and freezes there.
//
//   ?scene=volley                                   the court from the beach, the warm-up on
//   ?scene=volley&play=meter&hud=1                  the toss, the serve meter about to hit the red
//   ?scene=volley&play=serve                        just after the strike, the ball on its way
//   ?scene=volley&play=rally&vcam=tv                the locals' attack coming at you, the dig meter up
//   ?scene=volley&play=spike                        at the top of your spike jump
//   ?scene=volley&play=coconut                      a serve knocking the middle coconut off
//   ?scene=volley&play=dive&at=0.3                  a local diving for a serve into the corner, `at` seconds in
//   ?scene=volley&skip=6&vcam=fans                  the warm-up from the court, looking at the fans and the umpire
//   &vcam=player|tv|beach                           the game's camera; a cam / look in the URL overrides it
//   &me=Male_Adult_06                               the visitor's avatar (a playable one)
// The people are the game's: the park set first, then the island set (on the first trip in the game),
// so the court waits for it as it does there.
import type { PreviewScene } from '../main';
import type { Ctx } from '../../world/context';
import type { UI } from '../../world/ui';
import { downloadPeople, PeopleFactory } from '../../world/crowd/people-factory';
import { lookFromVisitor } from '../../world/crowd/looks';
import { PalmCay } from '../../world/island/island';
import { Volley } from '../../world/attractions/island/volley';
import { COURT_ORIGIN, toWorld } from '../../world/attractions/island/volley-court';
import { stage } from './island';

const preview: PreviewScene = async (p) => {
  const q = p.params;
  let ctx: Ctx = p.ctx;
  if (q.get('hud') === '1') {
    // a real #hud for the game's own HUD to go into, styled as in the game
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
  const vb = new Volley(ctx);
  // the game's order: the park's people (and the visitor's hero file) at the start, the island's later
  const tier = ctx.quality.tier;
  const me = q.get('me') ?? 'Male_Adult_06';
  const dl = downloadPeople({ sets: ['park'], hero: [me], tier });
  const people = await PeopleFactory.create(ctx.renderer, dl, { tier });
  const visitor = lookFromVisitor({ v: 1, avatar: me, top: null, bottom: null, shoes: null, hair: null, height: 1, build: 1 }, people.spec(me)!);
  vb.setPeople(people, () => visitor);
  await people.loadSet('island');
  stage(p, (k) => {
    park.setNight(k);
    vb.setNight(k);
  });

  let t = 0;
  const camera = p.ctx.camera;
  const dt = 1 / 60;
  const play = q.get('play');
  const follow = !!play && play !== 'dive' && !q.get('cam');
  const step = (n: number, stop?: () => boolean) => {
    for (let k = 0; k < n; k++) {
      t += dt;
      vb.update(dt, t);
      if (play) vb.updateCamera(camera, dt);
      if (stop?.()) return true;
    }
    return false;
  };
  if (!play) step(Math.round(Number(q.get('skip') ?? 6) / dt));
  else if (play === 'dive') {
    // a serve into the far corner, until a local is `at` seconds into a dive for it
    vb.start();
    ctx.ui.hidePanel();
    vb.aimAt({ x: -3.7, z: 7.6 });
    const at = Number(q.get('at') ?? 0.3);
    for (let k = 0; k < 40 / dt; k++) {
      const cue = vb.cue;
      if (!cue) vb.action();
      else if (cue.toPerfect <= dt / 2) vb.action();
      step(1);
      if (vb.athletes.some((a) => a.diving >= at)) break;
    }
  } else {
    vb.start();
    ctx.ui.hidePanel();
    const order = ['player', 'tv', 'beach'];
    for (let k = 0; k < order.indexOf(q.get('vcam') ?? 'player'); k++) vb.cycleCamera();
    // the autoplayer: toss when there's a ball in hand, press at the perfect instant, aim deep
    const auto = () => {
      const cue = vb.cue;
      if (!cue) vb.action();
      else if (cue.toPerfect <= dt / 2) vb.action();
    };
    const until = (cond: () => boolean, max = 90) => {
      for (let k = 0; k < max / dt; k++) {
        if (cond()) return;
        auto();
        step(1);
      }
    };
    if (play === 'meter') {
      vb.aimAt({ x: 2.6, z: 6.4 });
      vb.action();
      step(200, () => (vb.cue?.toPerfect ?? 1) < 0.07);
    } else if (play === 'serve') {
      vb.aimAt({ x: -2.8, z: 6.6 });
      until(() => !vb.cue && vb.roundStats().accuracy > 0);
      step(14);
    } else if (play === 'coconut') {
      vb.aimAt(2);
      until(() => vb.roundStats().coconutsHit > 0);
      step(8);
    } else {
      // a serve the locals can play, so the rally comes back
      vb.aimAt({ x: 0.5, z: 4.2 });
      const want = play === 'spike' ? 'spike' : 'dig';
      until(() => {
        const c = vb.cue;
        if (!c) vb.aimAt(play === 'spike' ? { x: -2.6, z: 5.6 } : { x: 0.5, z: 4.2 });
        return !!c && c.kind === want && c.toPerfect < (want === 'spike' ? 0.02 : 0.3);
      });
    }
  }
  p.onFrame((fdt, ft) => {
    park.update(fdt, ft, camera);
    if (!play) {
      t += fdt;
      vb.update(fdt, t);
    }
    // the shadows and the grass follow the court
    if (follow) p.view(camera.position, COURT_ORIGIN);
  });
  if (q.get('vcam') === 'fans' || (play === 'dive' && !q.get('cam'))) {
    // from the court: the bleachers and the umpire's stand (fans), or across at the diver (dive)
    const diver = vb.athletes.find((a) => a.diving >= 0) ?? vb.athletes[3];
    const from = play === 'dive' ? toWorld(diver.pos.x + 3.2, 1.6, diver.pos.z - 2.6) : toWorld(1, 2.2, -4);
    const to = play === 'dive' ? toWorld(diver.pos.x, 0.5, diver.pos.z) : toWorld(9.6, 1.1, 0);
    p.view(from, to);
  } else if (!follow) p.view({ x: 196, y: 2.4, z: 41424 }, { x: 210, y: 1, z: 41400 });
};
export default preview;
