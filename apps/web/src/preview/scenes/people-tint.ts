// Outfit dyeing (world/crowd/outfit-tint.ts) on real avatars: each avatar stands in a row of copies,
// one in its own clothes and the others dyed, so the dye can be checked against the original for
// fabric detail, clean edges, and skin, hair and faces left alone.
//
//   ?scene=people-tint&avatars=Male_Adult_01                    own + red/navy/white, mustard/black, teal/beige
//   ?scene=people-tint&avatars=Female_Adult_02,Male_Adult_01    several avatars, one row
//   ?scene=people-tint&avatars=Business_Male_01&variants=own,red,redAll&turn=180   from behind
//   ?scene=people-tint&avatars=Male_Adult_10&variants=own,mask,red&focus=2        close on the third
//   ?scene=people-tint&avatars=Construction_Male_07&env=1&hour=23&night=1         hi-vis trim at night
//   ?scene=people-tint&dir=models/people/_dev/&avatars=Male_Adult_01                masked copies (below)
//
// The avatars need the mask in their GLB. Until the build embeds it, make a masked copy of a crowd
// file to look at:
//   node scripts/people/masks.mjs public/models/people/<id>.crowd.glb
//        public/models/people/_dev/<id>.crowd.glb --from .people-cache/work/<id>/base.glb --no-meta
//
// Parameters: avatars (ids), dir (under the site root, default models/people/), suffix (default
// .crowd: the file is <dir><id><suffix>.glb), variants (comma list of the keys in VARIANTS, default
// own,red,mustard,teal), turn (degrees, 0 faces the camera), pose (seconds into the idle clip; -1
// keeps the bind pose), focus (a figure's index: frame its upper body), night (the trim's glow),
// labels=0 hides the tags.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { PreviewScene } from '../main';
import type { OutfitRegion } from '../../world/crowd/people-manifest';
import { outfitRegionsOf, takeOutfitMask, tintOutfit } from '../../world/crowd/outfit-tint';

type Tints = Partial<Record<OutfitRegion, string>>;
/** The dyes to try: what the task's brief asked for, plus the mask itself and an all-red one for dark fabrics. */
const VARIANTS: Record<string, { label: string; tints: Tints }> = {
  own: { label: 'own colours', tints: {} },
  red: { label: 'red / navy / white', tints: { top: '#c0202a', bottom: '#1b2a4a', shoes: '#f0f0f0' } },
  mustard: { label: 'mustard / black', tints: { top: '#d9a521', bottom: '#151515' } },
  teal: { label: 'teal / beige', tints: { top: '#1f8a8a', bottom: '#d8c7a0' } },
  redAll: { label: 'red / red', tints: { top: '#c0202a', bottom: '#c0202a' } },
  // (magenta for the top: red would hide on the red jackets and dresses)
  mask: { label: 'mask', tints: { top: '#ff30c8', bottom: '#2050ff', shoes: '#20ff50', trim: '#ffee00' } },
};

const scene: PreviewScene = async (p) => {
  const q = p.params;
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const { scene: sc, renderer } = p.ctx;
  const ids = (q.get('avatars') ?? 'Male_Adult_01').split(',').filter(Boolean);
  const dir = q.get('dir') ?? 'models/people/';
  const suffix = q.get('suffix') ?? '.crowd';
  const variants = (q.get('variants') ?? 'own,red,mustard,teal').split(',').filter((v) => VARIANTS[v]);
  const turn = (num('turn', 0) * Math.PI) / 180;
  const poseAt = num('pose', 2);
  const night = num('night', 0);
  const origin = new THREE.Vector3(0, 0, 800);

  if (!p.env) {
    const pm = new THREE.PMREMGenerator(renderer);
    sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    sc.environmentIntensity = 0.5;
  } else {
    // the sky box is centred on the fair: bring it out here with the camera
    const sky = sc.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);
    p.onFrame(() => sky?.position.copy(p.ctx.camera.position));
  }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#8d8b84', roughness: 0.95 }));
  ground.position.copy(origin).setY(0.002);
  ground.receiveShadow = true;
  sc.add(ground);

  const base = import.meta.env.BASE_URL;
  const ktx2 = new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  // the clip packs' idle, so the figures stand as they will in the park rather than in a T-pose
  const idle = async (gender: 'm' | 'f') => {
    try {
      const pack = await loader.loadAsync(`${base}models/people/clips-${gender}.glb`);
      const all = pack.animations.find((a) => a.name === 'clips') ?? pack.animations[0];
      return all ? THREE.AnimationUtils.subclip(all, 'idle', 0, 300, 30) : null;
    } catch {
      return null;
    }
  };
  const clips = { m: idle('m'), f: idle('f') };

  const figures: THREE.Object3D[] = [];
  const SPACING = 0.95;
  const GAP = 0.5;
  let x = 0;
  for (const id of ids) {
    const gltf = await loader.loadAsync(`${base}${dir}${id}${suffix}.glb`);
    const src = gltf.scene;
    // crowd files carry LOD1, LOD2 too: the preview looks at LOD0
    src.traverse((o) => {
      if (/^LOD[1-9]/.test(o.name)) o.visible = false;
    });
    // the body material is the one carrying the mask (usually <id>_body, but a one-material avatar's only one)
    let body: THREE.MeshStandardMaterial | null = null;
    src.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && !Array.isArray(m) && !body && takeOutfitMask(m)) body = m;
    });
    const bodyMat = body as THREE.MeshStandardMaterial | null;
    const mask = bodyMat ? takeOutfitMask(bodyMat) : null;
    const regions = bodyMat ? outfitRegionsOf(bodyMat) : null;
    if (!mask || !regions) console.warn(`${id}: no outfit mask`);
    const gender = /female|girl|_f_/i.test(id) ? 'f' : 'm';
    const clip = poseAt >= 0 ? await clips[gender] : null;

    for (const v of variants) {
      const fig = cloneSkinned(src);
      fig.position.set(origin.x + x, 0, origin.z);
      fig.rotation.y = turn;
      fig.traverse((o) => {
        const mesh = o as THREE.SkinnedMesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        if (mesh.material !== bodyMat || !mask || !regions) return;
        const mat = bodyMat.clone();
        mesh.material = mat;
        const tint = tintOutfit(mat, mask, regions);
        for (const [region, colour] of Object.entries(VARIANTS[v].tints)) tint.setTint(region as OutfitRegion, colour);
        tint.setNight(night);
      });
      if (clip) {
        const mixer = new THREE.AnimationMixer(fig);
        mixer.clipAction(clip).play();
        mixer.setTime(poseAt);
      }
      sc.add(fig);
      figures.push(fig);
      if (q.get('labels') !== '0') fig.add(tag(`${id} · ${VARIANTS[v].label}`));
      x += SPACING;
    }
    x += GAP;
  }
  const width = x - SPACING - GAP;
  const mid = origin.x + width / 2;

  if (!p.env) {
    sc.add(new THREE.HemisphereLight('#e8f0ff', '#6a6250', night ? 0.15 : 1.1));
    const sun = new THREE.DirectionalLight('#fff4e6', night ? 0.1 : 2.4);
    sun.position.set(mid - 4, 9, origin.z + 7);
    sun.target.position.set(mid, 0.9, origin.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -width / 2 - 3;
    s.right = width / 2 + 3;
    s.top = 4;
    s.bottom = -2;
    s.near = 1;
    s.far = 30;
    sc.add(sun, sun.target);
  }
  if (night && !p.env) {
    // a torch from the camera's side, for the reflective tape to send back
    const torch = new THREE.SpotLight('#fff6e0', 30, 25, 0.5, 0.6);
    torch.position.set(mid, 1.6, origin.z + 7);
    torch.target.position.set(mid, 1, origin.z);
    sc.add(torch, torch.target);
  }

  const focus = q.has('focus') ? figures[num('focus', 0)] : null;
  if (focus) {
    const at = focus.position;
    p.view({ x: at.x + 0.15, y: 1.35, z: at.z + 1.6 }, { x: at.x, y: 1.15, z: at.z });
  } else {
    // fit the row: the camera's horizontal half-angle sets the distance
    const cam = p.ctx.camera;
    const halfH = Math.tan((cam.fov * Math.PI) / 360);
    const dist = Math.max((width / 2 + 0.8) / (halfH * cam.aspect), 1.25 / halfH);
    p.view({ x: mid, y: 1.05, z: origin.z + dist }, { x: mid, y: 0.95, z: origin.z });
  }
};
export default scene;

/** A small caption over a figure's head. */
function tag(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,20,24,0.72)';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#fff';
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.9, 0.1125, 1);
  s.position.set(0, 2.02, 0);
  s.renderOrder = 10;
  return s;
}
