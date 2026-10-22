// Garments (world/crowd/garments.ts) on real avatars: Rosa's apron and the cabin crew's scarf, fitted
// to each body and played through the clips, so the fit can be judged from every side.
//
//   ?scene=people-garments&env=0&avatars=Female_Adult_09&clips=Idle_Loop,Walk_Loop&turns=0,90,180
//   ?scene=people-garments&env=0&avatars=Business_Female_03,Business_Male_02&wear=scarf&dye=navy&focus=0&zoom=neck
//   ?scene=people-garments&env=0&avatars=Female_Adult_09&clips=Sitting_Idle_Loop&t=3&turns=90&seat=1
//   ?scene=people-garments&env=0&avatars=Female_Adult_09&check=1      poke-through count (see below)
//
// Parameters: avatars (ids), file (hero | crowd; default hero when the avatar has one), wear (apron |
// scarf | none; default the avatar's role: cabin crew get the scarf), colour, accent, dye (navy: the
// suit dyed dark navy, as the crew wear it), clips (names; the extra pack's Interact and
// Crouch_Idle_Loop are the game's), t (seconds into each clip, one or a list), turns (degrees, 0
// faces the camera), focus (a figure's index) with zoom (upper | neck | legs | full), seat=1 (a
// bench under seated figures), labels=0, wire=1 (the garment's wireframe over it), bare=1 (the garment
// alone, its outside only), lod (which of a crowd file's bodies to show: the garment is still fitted
// to LOD0's and worn over the coarser one, as in the crowd). clips=bind leaves the bind pose.
//
// check=1 colours everything flat (garment green, the body's torso and legs red, arms, hands and
// head blue) and, for each figure, counts the red pixels where the garment alone would be: body
// showing through the cloth, from eight sides (or views: a list of degrees). The counts go in the
// corner, with each garment's build time and size, and the renders on a sheet (poke-through yellow).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { PreviewScene } from '../main';
import type { AvatarSpec, ClipPack, PeopleManifest } from '../../world/crowd/people-manifest';
import { outfitRegionsOf, takeOutfitMask, tintOutfit } from '../../world/crowd/outfit-tint';
import { buildGarment, type GarmentInfo, type GarmentKind } from '../../world/crowd/garments';
import { AIRLINE } from '../../world/crowd/looks';
import { PALETTE } from '../../world/textures';

/** The crew's uniform, as PeopleFactory dresses them: the airline's navy suit (top and bottom), black shoes. */
const NAVY = { top: AIRLINE.suit, bottom: AIRLINE.suit, shoes: AIRLINE.shoes } as const;
/** A figure on show: its body is the one that shows (lod), the garment's fitted to LOD0's. */
interface Figure {
  root: THREE.Object3D;
  garment: THREE.SkinnedMesh | null;
  body: THREE.SkinnedMesh;
  label: string;
  lod: string;
}
/** Clips the extra (retargeted) pack provides under the same names as native ones, which the game means. */
const EXTRA_FIRST = new Set(['Interact', 'Crouch_Idle_Loop']);

const scene: PreviewScene = async (p) => {
  const q = p.params;
  const list = (k: string, d: string) => (q.get(k) ?? d).split(',').filter(Boolean);
  const { scene: sc, renderer } = p.ctx;
  const base = import.meta.env.BASE_URL;
  const origin = new THREE.Vector3(0, 0, 800);
  const check = q.get('check') === '1';

  const ktx2 = new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const manifest = (await (await fetch(`${base}models/people/manifest.json`)).json()) as PeopleManifest;

  // the clip packs, cut into clips (a native pack keeps them all on one 'clips' timeline)
  const packs = new Map<string, Promise<Map<string, THREE.AnimationClip>>>();
  const pack = (key: string) => {
    let got = packs.get(key);
    if (!got) {
      const info = manifest.clipPacks[key];
      got = loader.loadAsync(`${base}models/people/${info.file}`).then((gltf) => {
        const clips = new Map<string, THREE.AnimationClip>();
        const all = gltf.animations.find((a) => a.name === 'clips');
        for (const c of info.clips) {
          if (c.start !== undefined && all) {
            const start = c.start;
            const tracks = all.tracks.map((t) => t.clone().trim(start - 0.01, start + c.duration + 0.01).shift(-start));
            clips.set(c.name, new THREE.AnimationClip(c.name, c.duration, tracks));
          } else {
            const a = gltf.animations.find((x) => x.name === c.name);
            if (a) clips.set(c.name, a);
          }
        }
        return clips;
      });
      packs.set(key, got);
    }
    return got;
  };
  const clipFor = async (name: string, spec: AvatarSpec) => {
    const own = Object.entries(manifest.clipPacks).find(([, pk]) => pk.gender === spec.gender)?.[0];
    const extra = Object.entries(manifest.clipPacks).find(([, pk]) => pk.gender === 'any')?.[0];
    const order = EXTRA_FIRST.has(name) ? [extra, own] : [own, extra];
    for (const key of order) {
      if (!key) continue;
      const clip = (await pack(key)).get(name);
      if (clip) return fitClip(clip, spec, manifest.clipPacks[key], manifest.rigs[manifest.clipPacks[key].rig]?.root ?? 'Bip01');
    }
    throw new Error(`no clip ${name}`);
  };

  if (!p.env) {
    const pm = new THREE.PMREMGenerator(renderer);
    sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    sc.environmentIntensity = check ? 0 : 0.5;
  }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#8d8b84', roughness: 0.95 }));
  ground.position.copy(origin).setY(0.002);
  ground.receiveShadow = true;
  if (!check) sc.add(ground);

  const ids = list('avatars', 'Female_Adult_09');
  const clips = list('clips', 'Idle_Loop');
  const times = list('t', '2').map(Number);
  const turns = list('turns', '0').map((d) => (Number(d) * Math.PI) / 180);
  const SPACING = Number(q.get('spacing') ?? 0.95);
  const figures: Figure[] = [];
  const report: string[] = [];
  let x = 0;
  for (const id of ids) {
    const spec = manifest.avatars.find((a) => a.id === id);
    if (!spec) throw new Error(`no avatar ${id}`);
    const file = q.get('file') === 'crowd' || !spec.files.hero ? spec.files.crowd : spec.files.hero;
    const gltf = await loader.loadAsync(`${base}models/people/${file}`);
    const wearParam = q.get('wear') ?? 'auto';
    const wear: GarmentKind | null = wearParam === 'none' ? null : wearParam === 'auto' ? (spec.roles.includes('cabin') ? 'scarf' : 'apron') : (wearParam as GarmentKind);
    const colour = q.get('colour') ?? (wear === 'scarf' ? AIRLINE.gold : PALETTE.teal);
    const lod = `LOD${Math.min(Number(q.get('lod') ?? 0), spec.lods - 1)}`;
    const dye = q.get('dye') === 'navy';
    for (const [ci, clipName] of clips.entries()) {
      const clip = clipName === 'bind' ? null : await clipFor(clipName, spec);
      for (const turn of turns) {
        const fig = cloneSkinned(gltf.scene);
        fig.position.set(origin.x + x, 0, origin.z);
        fig.rotation.y = turn;
        let body: THREE.SkinnedMesh | null = null;
        let shown: THREE.SkinnedMesh | null = null;
        fig.traverse((o) => {
          const mesh = o as THREE.SkinnedMesh;
          if (/^LOD\d$/.test(o.name)) o.visible = o.name === lod;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.frustumCulled = false;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat.name === spec.parts.body && mesh.parent?.name === 'LOD0') body = mesh;
          if (mat.name === spec.parts.body && mesh.parent?.name === lod) shown = mesh;
          if (dye && mat.name === spec.parts.body) {
            const mask = takeOutfitMask(mat);
            const regions = outfitRegionsOf(mat);
            if (mask && regions) {
              const dyed = mat.clone();
              mesh.material = dyed;
              const tint = tintOutfit(dyed, mask, regions);
              for (const [region, c] of Object.entries(NAVY)) tint.setTint(region as keyof typeof NAVY, c);
            }
          }
        });
        if (!body || !shown) throw new Error(`${id}: no ${body ? lod : 'LOD0'} body`);
        const bodyMesh = body as THREE.SkinnedMesh;
        const shownMesh = shown as THREE.SkinnedMesh;
        let garment: THREE.SkinnedMesh | null = null;
        if (wear) {
          garment = buildGarment(wear, bodyMesh, { colour, spec, accent: q.get('accent') ?? undefined });
          garment.castShadow = true;
          garment.frustumCulled = false;
          // (beside the body that shows: a skinned mesh in attached mode can sit anywhere, so this is LOD0's
          // own group unless lod= shows another)
          shownMesh.parent!.add(garment);
          const info = garment.userData.garment as GarmentInfo;
          report.push(`${id} ${wear}: ${info.ms.toFixed(1)} ms, ${info.triangles} tris`);
          console.warn(`garment ${id} ${wear} ${info.ms.toFixed(2)} ms ${info.triangles} tris steps ${JSON.stringify(info.steps, (_k, v) => (typeof v === 'number' ? +v.toFixed(2) : v))} marks ${JSON.stringify(info.marks, (_k, v) => (typeof v === 'number' ? +v.toFixed(3) : v))}`);
          if (q.get('wire') === '1') {
            // (with the garment's own shader patch: the apron's skirt is skinned in it)
            const own = garment.material as THREE.Material;
            const wireMat = new THREE.MeshBasicMaterial({ color: '#000', wireframe: true, transparent: true, opacity: 0.35 });
            wireMat.onBeforeCompile = own.onBeforeCompile;
            wireMat.customProgramCacheKey = () => `wire-${own.customProgramCacheKey()}`;
            const wire = new THREE.SkinnedMesh(garment.geometry, wireMat);
            wire.bind(garment.skeleton, garment.bindMatrix);
            wire.frustumCulled = false;
            wire.onBeforeRender = garment.onBeforeRender;
            shownMesh.parent!.add(wire);
          }
        }
        const t = times[Math.min(ci, times.length - 1)];
        if (clip) {
          const mixer = new THREE.AnimationMixer(fig);
          mixer.clipAction(clip).play();
          mixer.setTime(t);
          if (q.get('live') === '1') p.onFrame((dt) => mixer.update(dt));
        }
        // a bench under a seated figure: its top at seatDrop above the rig's origin, 0.46 m behind it
        if (q.get('seat') === '1' && /Sitting/.test(clipName)) {
          const bench = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.42), new THREE.MeshStandardMaterial({ color: '#7a5a3c', roughness: 0.8 }));
          bench.position.set(0, spec.seatDrop - 0.03, -0.46 * (spec.hip / 0.923));
          bench.castShadow = bench.receiveShadow = true;
          fig.add(bench);
        }
        sc.add(fig);
        const label = `${id} · ${clipName}${times.length > 1 || t !== 2 ? `@${t}` : ''}${lod === 'LOD0' ? '' : ` · ${lod}`}`;
        if (q.get('labels') !== '0' && !check) fig.add(tag(label, turn));
        // the garment on its own (its outside faces only), to see which way they face
        if (q.get('bare') === '1')
          fig.traverse((o) => {
            if ((o as THREE.Mesh).isMesh && o !== garment) o.visible = false;
            if (o === garment) ((o as THREE.Mesh).material as THREE.Material).side = THREE.FrontSide;
          });
        figures.push({ root: fig, garment, body: shownMesh, label, lod });
        x += SPACING;
      }
    }
  }
  const width = x - SPACING;
  const mid = origin.x + width / 2;

  if (!p.env) {
    sc.add(new THREE.HemisphereLight('#e8f0ff', '#6a6250', 1.1));
    const sun = new THREE.DirectionalLight('#fff4e6', 2.4);
    sun.position.set(mid - 3, 8, origin.z + 7);
    sun.target.position.set(mid, 0.9, origin.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.01;
    const s = sun.shadow.camera;
    s.left = -width / 2 - 3;
    s.right = width / 2 + 3;
    s.top = 4;
    s.bottom = -2;
    s.near = 1;
    s.far = 30;
    sc.add(sun, sun.target);
  }

  const zoom = q.get('zoom') ?? 'upper';
  const focus = q.has('focus') ? figures[Number(q.get('focus'))]?.root : null;
  if (focus) {
    const at = focus.position;
    const view = {
      upper: [0.0, 1.3, 1.45, 1.15],
      neck: [0.0, 1.5, 0.75, 1.42],
      legs: [0.0, 0.85, 1.6, 0.75],
      full: [0.0, 1.05, 2.9, 0.92],
    }[zoom] ?? [0, 1.3, 1.45, 1.15];
    p.view({ x: at.x + view[0], y: view[1], z: at.z + view[2] }, { x: at.x, y: view[3], z: at.z });
  } else {
    const cam = p.ctx.camera;
    const halfH = Math.tan((cam.fov * Math.PI) / 360);
    const dist = Math.max((width / 2 + 0.6) / (halfH * cam.aspect), 1.1 / halfH);
    p.view({ x: mid, y: 1.0, z: origin.z + dist }, { x: mid, y: 0.92, z: origin.z });
  }

  const overlay = document.createElement('pre');
  overlay.style.cssText = 'position:fixed;left:8px;bottom:8px;margin:0;padding:6px 8px;background:rgba(20,20,24,.72);color:#fff;font:12px/1.35 ui-monospace,monospace;z-index:5;pointer-events:none';
  overlay.textContent = report.join('\n');
  document.body.appendChild(overlay);

  if (check) await pokeCheck(p, figures, overlay, list('views', '0,45,90,135,180,225,270,315').map(Number));
};
export default scene;

/** A clip for this body: the root's position track scaled by its hip height over the pack's. */
function fitClip(clip: THREE.AnimationClip, spec: AvatarSpec, pack: ClipPack, root: string) {
  const k = spec.hip / pack.refHip;
  const c = clip.clone();
  for (const t of c.tracks) if (t.name === `${root}.position`) t.values = t.values.map((v) => v * k);
  return c;
}

/**
 * Body showing through the garment, counted in pixels: everything is drawn flat (garment green, torso
 * and legs red, arms, hands, head and hair blue), once with the garment alone and once with
 * everything, from eight sides. The garment's front faces only: they face out, so seen from behind,
 * the apron's front is culled rather than counted as hidden. Red where the garment alone showed is
 * body in front of cloth that should cover it. Hands and arms legitimately pass in front of an
 * apron, so they're blue and don't count. A sheet of the renders (poke-through in yellow) goes on
 * the page, a row per figure.
 */
async function pokeCheck(p: Parameters<PreviewScene>[0], figures: Figure[], overlay: HTMLElement, views: number[]) {
  const { renderer, scene, camera } = p.ctx;
  const blue = new THREE.MeshBasicMaterial({ color: '#0000ff', side: THREE.DoubleSide });
  const ARM = /_[LR]_(UpperArm|Forearm|Hand|Finger)/;
  scene.background = new THREE.Color('#000');
  scene.fog = null;
  for (const fig of figures) {
    fig.root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      if (mesh === fig.garment) {
        // its own material (the apron's skirt swings in its shader), made flat green
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.map = null;
        mat.color.set('#000');
        mat.emissive.set('#00ff00');
        mat.side = THREE.FrontSide;
        mat.needsUpdate = true;
        return;
      }
      if (mesh !== fig.body) {
        mesh.material = blue;
        return;
      }
      // the body: red, but arms and hands (by their skin weights) blue
      const g = mesh.geometry;
      const si = g.attributes.skinIndex;
      const sw = g.attributes.skinWeight;
      const bones = mesh.skeleton.bones;
      const colours = new Float32Array(si.count * 3);
      for (let i = 0; i < si.count; i++) {
        let arm = 0;
        for (let k = 0; k < 4; k++) if (ARM.test(bones[si.getComponent(i, k)].name)) arm += sw.getComponent(i, k);
        colours.set(arm > 0.3 ? [0, 0, 1] : [1, 0, 0], i * 3);
      }
      const geo = g.clone();
      geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      mesh.geometry = geo;
      mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    });
  }
  const W = 384;
  const H = 512;
  const rt = new THREE.WebGLRenderTarget(W, H);
  const px = new Uint8Array(W * H * 4);
  const lines: string[] = [];
  const prevAspect = camera.aspect;
  const prevPos = camera.position.clone();
  const prevRot = camera.quaternion.clone();
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  // (a few views: full size, to see where)
  const SHRINK = views.length > 3 ? 3 : 1;
  const TW = W / SHRINK;
  const TH = H / SHRINK;
  const sheet = document.createElement('canvas');
  sheet.width = TW * views.length;
  sheet.height = TH * figures.length;
  sheet.style.cssText = 'position:fixed;left:0;top:0;z-index:4;background:#000';
  const sg = sheet.getContext('2d')!;
  const thumb = sg.createImageData(TW, TH);
  let row = 0;
  for (const fig of figures) {
    if (!fig.garment) continue;
    const at = fig.root.position;
    const counts: string[] = [];
    let worst = 0;
    for (const deg of views) {
      const a = (deg * Math.PI) / 180;
      camera.position.set(at.x + Math.sin(a) * 2.1, 1.0, at.z + Math.cos(a) * 2.1);
      camera.lookAt(at.x, 0.95, at.z);
      for (const other of figures) other.root.visible = other === fig;
      const shot = (garmentOnly: boolean) => {
        fig.root.traverse((o) => {
          const lodName = o.parent && /^LOD\d$/.test(o.parent.name) ? o.parent.name : fig.lod;
          if ((o as THREE.Mesh).isMesh && o !== fig.garment) o.visible = !garmentOnly && lodName === fig.lod;
        });
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
        renderer.setRenderTarget(null);
        return px.slice();
      };
      const alone = shot(true);
      const all = shot(false);
      let cloth = 0;
      let poke = 0;
      for (let i = 0; i < W * H; i++) {
        if (alone[i * 4 + 1] < 128) continue;
        cloth++;
        if (all[i * 4] > 128 && all[i * 4 + 1] < 128) poke++;
      }
      // the thumbnail (render targets read bottom row first)
      for (let ty = 0; ty < TH; ty++)
        for (let tx = 0; tx < TW; tx++) {
          const i = ((H - 1 - ty * SHRINK) * W + tx * SHRINK) * 4;
          const o = (ty * TW + tx) * 4;
          const bad = alone[i + 1] > 128 && all[i] > 128 && all[i + 1] < 128;
          thumb.data[o] = bad ? 255 : all[i];
          thumb.data[o + 1] = bad ? 255 : all[i + 1];
          thumb.data[o + 2] = bad ? 0 : all[i + 2];
          thumb.data[o + 3] = 255;
        }
      sg.putImageData(thumb, views.indexOf(deg) * TW, row * TH);
      counts.push(`${deg}°:${poke}`);
      worst = Math.max(worst, cloth ? poke / cloth : 0);
    }
    lines.push(`${fig.label}  ${counts.join(' ')}  worst ${(worst * 100).toFixed(2)}%`);
    sg.fillStyle = '#fff';
    sg.font = '11px monospace';
    sg.fillText(fig.label, 4, row * TH + 12);
    row++;
  }
  document.body.appendChild(sheet);
  camera.position.copy(prevPos);
  camera.quaternion.copy(prevRot);
  for (const other of figures) other.root.visible = true;
  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();
  overlay.textContent += `\npoke-through (body px over cloth, of ${W}x${H}):\n${lines.join('\n')}`;
  console.warn(lines.join('\n'));
}

/** A small caption over a figure's head, turned to face the camera. */
function tag(text: string, turn: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,20,24,0.72)';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#fff';
  g.font = '600 24px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.85, 0.106, 1);
  s.position.set(0, 2.0, 0);
  s.rotation.y = -turn;
  s.renderOrder = 10;
  return s;
}
