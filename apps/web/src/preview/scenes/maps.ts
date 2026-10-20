// The maps and the signposts: the minimap and the full-screen map over a blank page (the 3D view
// is left empty), or the fingerposts in the park, the terminal and on Palm Cay.
//
//   ?scene=maps&env=0&post=0&frames=120&mode=minimap&at=0,40&heading=0&view=55&size=360
//   ?scene=maps&env=0&post=0&frames=120&mode=map&at=0,40&tab=island&pick=jetski&zoom=-2
//   ?scene=maps&mode=posts&where=terminal&cam=…&look=…
//
//   mode     minimap | map | posts (default minimap)
//   where    for posts: fair | terminal | island, what is built round them first (default fair)
//   at       the visitor's "x,z" (default the fair's spawn); heading their yaw (radians)
//   view     the minimap's reach in metres (default 55); arrow=aircraft draws an airliner
//   size     the minimap's diameter in CSS pixels (default 360, so it can be read in a shot)
//   tab      the map's tab: home | island | world (default the visitor's own landmass)
//   pick     a place to select on the map (its card shows)
//   zoom     presses of the map's zoom buttons after it opens (+ in, − out)
import '../../styles.css';
import type { PreviewScene } from '../main';
import { HomeTerminal } from '../../world/airport/terminal';
import { Landside } from '../../world/airport/landside';
import { SkyLink } from '../../world/airport/skylink';
import { PalmCay } from '../../world/island/island';
import { regionAt } from '../../world/geo';
import { LAYOUT, type ZoneId } from '../../world/layout';
import { MAP_PLACES, Minimap } from '../../world/minimap';
import { mapTiles, tileMetres, TILE_LEVELS } from '../../world/map-tiles';
import { Wayfinding } from '../../world/wayfinding';
import { WorldMap } from '../../world/world-map';
import type { MapView } from '../../world/map-paint';
import { stage } from './island';
import { homeStage } from './terminal';

const MINIMAP_HTML = `
  <canvas aria-hidden="true"></canvas>
  <button type="button" class="minimap-open" aria-label="Open the park map" aria-haspopup="dialog" aria-controls="world-map">⤢</button>
  <span class="minimap-key" aria-hidden="true">M</span>`;

const WORLD_MAP_HTML = `
  <canvas aria-hidden="true"></canvas>
  <div class="wm-pins"></div>
  <div class="wm-you" aria-hidden="true"><canvas width="64" height="64"></canvas></div>
  <header class="wm-head">
    <p class="wm-kicker">Park map</p>
    <h2 id="wm-title">The Funfair</h2>
  </header>
  <nav class="wm-legend" aria-label="Places to go"><ul></ul></nav>
  <div class="wm-side">
    <span class="wm-compass" aria-hidden="true">N</span>
    <div class="wm-controls">
      <button type="button" data-wm-zoom="1" aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button type="button" data-wm-zoom="-1" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <button type="button" data-wm-locate aria-label="Centre on me" title="Centre on me (C)">◎</button>
    </div>
  </div>
  <div class="wm-scale" aria-hidden="true"><i></i><span>100 m</span></div>
  <div class="wm-card" aria-live="polite" hidden></div>
  <p class="wm-keys"><kbd>Drag</kbd> pan · <kbd>Scroll</kbd> zoom · Pick a place, pick again or <kbd>Enter</kbd> to fast travel · <kbd>M</kbd> close</p>
  <button type="button" class="wm-close" aria-label="Close map" title="Close (M / Esc)">✕</button>`;

const scene: PreviewScene = async (p) => {
  const q = p.params;
  const mode = q.get('mode') ?? 'minimap';
  const [x, z] = (q.get('at') ?? `${LAYOUT.spawn.x},${LAYOUT.spawn.z}`).split(',').map(Number);
  const visitor = { x, z, heading: Number(q.get('heading') ?? 0) };

  if (mode === 'posts') {
    // the posts find their spots against the colliders already in the world, so build those first
    const where = q.get('where') ?? 'fair';
    if (where === 'terminal') {
      homeStage(p);
      const parts = [new HomeTerminal(p.ctx), new Landside(p.ctx), new SkyLink(p.ctx)];
      for (const m of parts) p.ctx.scene.add(m.group);
      p.onFrame((dt, t) => parts.forEach((m) => m.update(dt, t, p.ctx.camera)));
      p.view({ x: 30, y: 2, z: 444 }, { x: 22, y: 2.5, z: 456 });
    } else if (where === 'island') {
      const park = new PalmCay(p.ctx);
      p.ctx.scene.add(park.group);
      stage(p, (k) => park.setNight(k));
      p.onFrame((dt, t) => park.update(dt, t, p.ctx.camera));
      p.view({ x: 8, y: 2.5, z: 40700 }, { x: 0, y: 2.5, z: 40730 });
    } else p.view({ x: LAYOUT.carousel.x + 12, y: 6, z: LAYOUT.carousel.z + 30 }, { x: LAYOUT.carousel.x, y: 3, z: LAYOUT.carousel.z + 15 });
    const before = p.ctx.scene.children.length;
    new Wayfinding(p.ctx);
    // where each sign and post found its spot (console), to aim the camera at
    if (q.get('list')) for (const o of p.ctx.scene.children.slice(before)) console.warn(`sign at ${o.position.x.toFixed(1)}, ${o.position.z.toFixed(1)}`);
    return;
  }

  if (mode === 'bench') {
    // what a tile costs to paint at each level, round the fair, the airport, Palm Cay and the open
    // sea (console): the second of two passes, once the painters' code has warmed up
    const spots = [LAYOUT.spawn, { x: 0, z: 480 }, { x: 0, z: 41100 }, { x: 0, z: 20000 }];
    for (const pass of [0, 1])
      for (let l = 0; l < TILE_LEVELS.length; l++) {
        const m = tileMetres(l);
        const times: string[] = [];
        for (const { x: sx, z: sz } of spots) {
          // (a frame apart, so the cache's per-frame painting budget never holds a tile back)
          await new Promise((done) => setTimeout(done, 20));
          const t0 = performance.now();
          mapTiles.get(l, Math.floor(sx / m), Math.floor(sz / m));
          times.push((performance.now() - t0).toFixed(1));
          mapTiles.invalidate();
        }
        if (pass) console.warn(`level ${l} (${Math.round(m)} m): ${times.join(' / ')} ms`);
      }
    return;
  }

  // the HUD's maps over a plain backdrop (the canvas behind them stays empty)
  document.getElementById('preview')!.style.display = 'none';
  document.body.style.background = '#1d1238';
  if (mode === 'minimap') {
    const root = document.createElement('div');
    root.id = 'minimap';
    root.className = 'minimap';
    root.innerHTML = MINIMAP_HTML;
    root.style.setProperty('--map', `${q.get('size') ?? 360}px`);
    root.style.left = root.style.bottom = '40px';
    document.body.appendChild(root);
    const map = new Minimap(root);
    map.setView(Number(q.get('view') ?? 55), true);
    if (q.get('arrow') === 'aircraft') map.arrow = 'aircraft';
    p.onFrame(() => map.update(visitor, []));
    return;
  }

  const root = document.createElement('div');
  root.id = 'world-map';
  root.className = 'world-map';
  root.setAttribute('role', 'dialog');
  root.hidden = true;
  root.innerHTML = WORLD_MAP_HTML;
  document.body.appendChild(root);
  const map = new WorldMap(root);
  // the first update tells the map where the visitor is, so it opens on their landmass
  map.update(0, visitor, []);
  map.open();
  const tab = (q.get('tab') as MapView | null) ?? regionAt(x, z);
  if (tab !== regionAt(x, z)) map.setRegion(tab, true);
  const pick = q.get('pick') as ZoneId | null;
  const i = pick ? MAP_PLACES.findIndex((m) => m.id === pick) : -1;
  if (i >= 0) root.querySelectorAll<HTMLButtonElement>('.wm-pin')[i]?.click();
  const zoom = Number(q.get('zoom') ?? 0);
  const button = root.querySelector<HTMLButtonElement>(`[data-wm-zoom="${Math.sign(zoom)}"]`);
  for (let k = 0; k < Math.abs(zoom); k++) button?.click();
  p.onFrame((dt) => map.update(dt, visitor, []));
};
export default scene;
