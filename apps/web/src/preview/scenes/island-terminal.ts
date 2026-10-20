// Palm Cay's terminal (world/island/island-terminal.ts) beside its beach park, on the island
// scene's stand-in landmass. The stairs at the stands listed in `dock` (default S2) are docked
// to where the aircraft's front door would be; `dock=none` leaves them all parked.
//
//   ?scene=island-terminal&cam=-30,1.7,40625&look=-30,1.7,40590         gate 2's lounge, looking at the apron
//   ?scene=island-terminal&cam=-90,1.7,40668&look=-90,1.7,40640         the check-in hall
//   ?scene=island-terminal&cam=40,1.7,40665&look=70,1.2,40645           the baggage hall
//   ?scene=island-terminal&cam=-10,4,40590&look=-28,3,40579             S2's airstairs docked
//   ?scene=island-terminal&cam=0,90,40420&look=0,0,40640                the terminal from over the apron
import type { PreviewScene } from '../main';
import { IslandTerminal } from '../../world/island/island-terminal';
import { PalmCay } from '../../world/island/island';
import { groupStats, shadowStats, stage } from './island';
import { setMultiDraw } from '../../world/island/flora';

const preview: PreviewScene = (p) => {
  setMultiDraw(p.params.has('nobatch') ? false : null);
  const terminal = new IslandTerminal(p.ctx);
  const park = new PalmCay(p.ctx);
  p.ctx.scene.add(terminal.group, park.group);
  stage(p, (k) => {
    terminal.setNight(k);
    park.setNight(k);
  });
  const dock = (p.params.get('dock') ?? 'S2').split(',');
  for (const id of dock) terminal.stairs[id]?.dock(true);
  const shadow = [shadowStats(terminal.group), shadowStats(park.group)];
  let logged = 0;
  p.onFrame((dt, t) => {
    terminal.update(dt, t);
    park.update(dt, t, p.ctx.camera);
    // after the LODs have settled, report what the two groups cost from this viewpoint (see island.ts's groupStats)
    if (++logged !== 30) {
      for (const s of shadow) s.reset();
      return;
    }
    const d = p.params.has('detail');
    console.warn(`[stats] ${p.ctx.quality.tier}: terminal ${groupStats(terminal.group, p.ctx.camera, d)}, shadow pass ${shadow[0].text(d)}`);
    console.warn(`[stats] ${p.ctx.quality.tier}: park ${groupStats(park.group, p.ctx.camera, d)}, shadow pass ${shadow[1].text(d)}`);
  });
  p.view({ x: -30, y: 1.7, z: 40625 }, { x: -30, y: 1.7, z: 40590 });
};
export default preview;
