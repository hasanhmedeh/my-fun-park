// Funfair International's airfield (world/airport/airfield.ts) on the geography's land and sea,
// seen as a pilot does: with a 60 km view and the haze thinned to a visibility (`vis`, metres).
// `stage` is shared with the airfield-island scene.
//
//   ?scene=airfield-home&cam=-1700,40,880&look=0,0,900&far=60000&near=2       the runway from the air
//   ?scene=airfield-home&cam=-30,4.6,650&look=-30,4.6,720&near=0.5            from the cockpit on the taxilane
//   &hour=23 night (the lights come on), &route=1 follow-the-greens from S3 to A5 with its stop bar red,
//   &wind=200,14 the windsocks' wind, &vis=30000, &land=0 without the land and sea, &lights=1 force the lights on
import * as THREE from 'three';
import type { PreviewApi, PreviewScene } from '../main';
import { AIRFIELDS, taxiRoute } from '../../aviation/airports';
import type { Region } from '../../world/geo';
import { Airfield } from '../../world/airport/airfield';
import { Terrain } from '../../world/terrain';
import { Sea } from '../../world/sea';

/** The land and sea round the airfield, the sky following the camera, the haze set to a visibility. */
export function stage(p: PreviewApi, id: Region) {
  const { ctx } = p;
  const { scene, camera } = ctx;
  // land=0 leaves the land and sea out (to count the airfield's own draw calls)
  const land = p.params.get('land') !== '0';
  const terrain = land ? new Terrain(ctx, ctx.quality) : null;
  const sea = land ? new Sea(ctx, ctx.quality) : null;
  if (terrain && sea) scene.add(terrain.group, sea.mesh);
  const field = new Airfield(ctx, AIRFIELDS[id]);
  scene.add(field.group);

  const wind = (p.params.get('wind') ?? '250,12').split(',').map(Number);
  field.setWind(wind[0], wind[1]);
  sea?.setWind(wind[0], wind[1]);
  if (p.params.get('route')) {
    const ap = AIRFIELDS[id];
    const entry = ap.runways['27'].entries[ap.runways['27'].entries.length - 1];
    const r = taxiRoute(ap, ap.playerStand, entry.runway);
    if (r) field.setGuidance(r.nodes, Number(p.params.get('from') ?? 0));
  }
  if (p.params.get('green')) for (const h of field.plan.holds) field.setStopBar(h.id, false);

  // the park's sky box is only 900 m across, centred on the fair: carry it with the camera
  const sky = scene.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);
  const vis = Number(p.params.get('vis') ?? 25000);
  let haze = 1;
  p.onFrame((dt, t) => {
    sky?.position.copy(camera.position);
    const night = p.env?.night ?? 0;
    const lights = p.params.get('lights');
    field.setLights(lights !== null ? Number(lights) : night);
    terrain?.setNight(night);
    terrain?.update(camera);
    sea?.update(dt, t, camera);
    field.update(dt, t, camera);
    // thin the park's haze to the visibility asked for (98 % fog at `vis`), nudging the
    // environment's own multiplier (it recomputes the density each frame)
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog && p.env && fog.density > 0) {
      haze *= 1.978 / vis / fog.density;
      p.env.setHaze(haze);
    }
  });
  return field;
}

const preview: PreviewScene = (p) => {
  stage(p, 'home');
  p.view({ x: -2400, y: 160, z: 1150 }, { x: 0, y: 0, z: 800 });
};
export default preview;
