// Dev-only preview: renders one module's scene so it can be looked at, or screenshotted headless,
// without loading the whole fair. Open /preview.html?scene=<name> on the dev server; the scene is
// src/preview/scenes/<name>.ts, whose default export builds into the scene.
//
// Query parameters:
//   scene    the scene module's name (required)
//   cam      camera position "x,y,z" (default: what the scene sets, else 0,20,60)
//   look     camera target "x,y,z" (default 0,0,0)
//   fov      vertical field of view (default 50); near / far planes (default 0.5 / 5000)
//   hour     clock 0–24 for the environment's sun (default 16)
//   env      1 (default): the park's real Environment (sky, sun, fog, the park itself); 0: plain lights and sky colour
//   post     1 (default): the game's post pipeline (tone mapping, bloom, SMAA); 0: render directly
//   frames   frames to render before signalling ready (default 30)
//   quality  forced tier (see quality.ts), e.g. quality=high
//
// When it's done the page's title becomes "READY" (or "ERROR: …"); scripts/shot.mjs waits for it.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Ctx } from '../world/context';
import { Environment } from '../world/environment';
import { Post } from '../world/post';
import { detectQuality } from '../world/quality';
import { Sfx } from '../world/audio';
import type { UI } from '../world/ui';

export interface PreviewApi {
  ctx: Ctx;
  /** The real environment, when env=1. */
  env: Environment | null;
  params: URLSearchParams;
  /** Point the camera (the URL's cam/look override what a scene sets). */
  view(pos: THREE.Vector3Like, look: THREE.Vector3Like): void;
  /** Called every frame with (dt, t). */
  onFrame(fn: (dt: number, t: number) => void): void;
}
export type PreviewScene = (p: PreviewApi) => void | Promise<void>;

const params = new URLSearchParams(location.search);
const status = document.getElementById('preview-status')!;
const vec = (s: string | null) => {
  if (!s) return null;
  const [x, y, z] = s.split(',').map(Number);
  return new THREE.Vector3(x, y, z);
};

/** Anything the UI is asked to do is a no-op here (the HUD isn't on this page). */
function stubUi(): UI {
  const noop = () => undefined;
  return new Proxy({}, { get: (_t, key) => (key === 'hud' ? document.createElement('div') : noop) }) as unknown as UI;
}

async function main() {
  const name = params.get('scene');
  const scenes = import.meta.glob<{ default: PreviewScene }>('./scenes/*.ts');
  const load = scenes[`./scenes/${name}.ts`];
  if (!load) throw new Error(`no scene "${name}"; have: ${Object.keys(scenes).map((k) => k.slice(9, -3)).join(', ')}`);

  const renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, preserveDrawingBuffer: true });
  const quality = detectQuality(renderer, false);
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.getElementById('preview')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(Number(params.get('fov') ?? 50), innerWidth / innerHeight, Number(params.get('near') ?? 0.5), Number(params.get('far') ?? 5000));
  const world = new CANNON.World();
  world.gravity.set(0, -20, 0);
  const mats = { ground: new CANNON.Material('ground'), player: new CANNON.Material('player'), prop: new CANNON.Material('prop') };
  const time = { t: 0 };
  const ctx: Ctx = { scene, world, renderer, camera, sfx: new Sfx(), ui: stubUi(), mobile: false, mats, quality, dynamics: [], time };

  let env: Environment | null = null;
  if (params.get('env') !== '0') {
    env = new Environment(ctx, quality);
    env.setHour(Number(params.get('hour') ?? 16));
  } else {
    scene.background = new THREE.Color('#9cc3e8');
    scene.add(new THREE.HemisphereLight('#dfefff', '#5a5040', 1.4));
    const sun = new THREE.DirectionalLight('#fff3e2', 2.2);
    sun.position.set(-60, 120, 40);
    scene.add(sun);
  }

  const frameFns: ((dt: number, t: number) => void)[] = [];
  const focus = new THREE.Vector3();
  const api: PreviewApi = {
    ctx,
    env,
    params,
    view(pos, look) {
      camera.position.copy(pos);
      focus.copy(look);
      camera.lookAt(focus);
    },
    onFrame: (fn) => frameFns.push(fn),
  };
  api.view({ x: 0, y: 20, z: 60 }, { x: 0, y: 0, z: 0 });
  await (await load()).default(api);
  const cam = vec(params.get('cam'));
  const look = vec(params.get('look'));
  if (cam || look) api.view(cam ?? camera.position, look ?? focus);

  const post = params.get('post') !== '0' ? new Post(renderer, scene, camera, quality) : null;
  post?.composer.setSize(innerWidth, innerHeight);

  const frames = Number(params.get('frames') ?? 30);
  let n = 0;
  const dt = 1 / 30;
  renderer.info.autoReset = false;
  const tick = () => {
    renderer.info.reset();
    time.t += dt;
    for (const fn of frameFns) fn(dt, time.t);
    if (env) {
      env.follow(focus);
      env.update(time.t, focus);
    }
    if (post) post.composer.render(dt);
    else renderer.render(scene, camera);
    n++;
    status.textContent = `${name}  cam ${camera.position.toArray().map((v) => v.toFixed(0)).join(',')}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`;
    if (n === frames) document.title = 'READY';
    requestAnimationFrame(tick);
  };
  tick();
}

main().catch((e: unknown) => {
  console.error(e);
  document.title = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  status.textContent = String(e instanceof Error ? e.stack : e);
});
