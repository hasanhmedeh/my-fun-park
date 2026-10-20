// The world beyond the park as the flight sees it: the far plane out to 60 km, a visibility for
// flying, and (optionally) cloud layers. `geography` is shared with the coast and island-terrain
// scenes. Query parameters on top of the harness's own:
//   vis      visibility in metres (default 35000 by day, 22000 at dawn/dusk, 14000 at night)
//   layers   cloud layers, e.g. "SCT:3000,BKN:4500" (cover:base ft); none by default here
//   wind     "from,kt" for the sea (default 240,12)
//   hide     comma list of terrain, trees, towns, sea, clouds (to look at one part alone)
//   walk     1: keep the park's own walking far plane and fog (the walking look)
//
//   ?scene=flight-view&cam=0,450,3000&look=0,300,9000                 leaving the coast, looking south
//   ?scene=flight-view&cam=0,457,20000&look=0,0,40500                 mid-way at 1500 ft, the island ahead
//   ?scene=flight-view&cam=-1500,300,39400&look=0,0,40900             over Palm Cay at 300 m
//   ?scene=flight-view&cam=2500,300,2200&look=0,0,700                 the home coast at 300 m
import type { PreviewApi, PreviewScene } from '../main';
import type { CloudLayer } from '../../world/clouds';

export function geography(p: PreviewApi) {
  const env = p.env;
  if (!env) return;
  const q = p.params;
  const hide = new Set((q.get('hide') ?? '').split(','));
  if (hide.has('terrain')) env.terrain.group.visible = false;
  if (hide.has('trees')) env.terrain.vegetation.group.visible = false;
  if (hide.has('towns')) env.terrain.towns.group.visible = false;
  if (hide.has('sea')) env.sea.mesh.visible = false;
  const wind = (q.get('wind') ?? '240,12').split(',').map(Number);
  env.sea.setWind(wind[0], wind[1]);
  const layers = q.get('layers');
  if (layers && !hide.has('clouds'))
    env.clouds.setLayers(
      layers.split(',').map((s) => {
        const [cover, ft] = s.split(':');
        return { cover: cover as CloudLayer['cover'], baseFt: Number(ft) };
      }),
    );
  if (q.get('walk') === '1') {
    env.restoreViewRange();
    return;
  }
  const hour = Number(q.get('hour') ?? 16);
  const night = hour < 5.5 || hour > 19;
  const glow = !night && (hour < 8 || hour > 16.5);
  env.setViewRange(Number(q.get('far') ?? 60000), Number(q.get('near') ?? 2));
  env.setVisibility(Number(q.get('vis') ?? (night ? 14000 : glow ? 22000 : 35000)));
  env.setFarFocus(true);
  env.setShadowSpan(600);
}

const scene: PreviewScene = (p) => {
  p.view({ x: 0, y: 450, z: 3000 }, { x: 0, y: 300, z: 9000 });
  geography(p);
};
export default scene;
