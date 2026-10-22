// The visitor's customiser (world/customiser.ts) over the park, with a stand-in host built from the
// real people manifest: the changing room beside Rosa's booth, the visitor (a hero avatar, idling,
// dyed and sized as the look says) standing in it, and the camera framing them beside the panel as
// the game will. Changing person downloads that person's hero file, so the spinner is real.
//
//   ?scene=customiser                         the changing room (Done / Cancel)
//   ?scene=customiser&first=1                 the first visit ("Who's visiting today?")
//   ?scene=customiser&tab=colours             open on a tab (person, colours, body)
//   ?scene=customiser&filter=f                the Women chip
//   ?scene=customiser&avatar=Male_Adult_04&top=c3302d&bottom=1b1b1e&height=1.05
//   ?scene=customiser&delay=1500              hold each new person back, to see the spinner
//   ?scene=customiser&hour=21                 at dusk (the visitor glows a little: &glow=0 for none)
//
// window.__cust has { customiser, visitor, people, events } for scripts: events lists what the
// host was asked (preview / close), and a close re-opens the panel a moment later.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { PreviewApi, PreviewScene } from '../main';
import { Booth } from '../../world/attractions/landmarks';
import { ChangingRoom, CHANGING_ROOM, onChangingRoom } from '../../world/attractions/changing-room';
import { Customiser, customiserPeople, type CustomiserHost } from '../../world/customiser';
import { tintHair, type HairTint } from '../../world/crowd/hair-tint';
import { canTintHair } from '../../world/crowd/looks';
import { takeOutfitMask, tintOutfit, type OutfitTint } from '../../world/crowd/outfit-tint';
import type { AvatarSpec, ClipInfo, PeopleManifest, VisitorLook } from '../../world/crowd/people-manifest';
import { hdr, PALETTE } from '../../world/textures';

const BASE = `${import.meta.env.BASE_URL}models/people/`;
/** How much of their own colours the visitor glows with in full night while dressing (see PreviewVisitor.setGlow). */
const SHOWCASE_GLOW = 0.4;

/** One loaded person: their figure, idling, and the handles that dye them. */
interface Figure {
  id: string;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  tint: OutfitTint | null;
  hair: HairTint | null;
  spec: AvatarSpec;
}

/**
 * The visitor for the preview: loads a person's hero file on demand (once), plays the idle from
 * their clip pack, and wears a look (outfit dyes through outfit-tint, hair through hair-tint, size
 * by scale), as the game's PersonRig does.
 */
export class PreviewVisitor {
  readonly group = new THREE.Group();
  private loader: GLTFLoader;
  private figures = new Map<string, Promise<Figure>>();
  private clips = new Map<string, Promise<THREE.AnimationClip | null>>();
  private on: Figure | null = null;
  private turning = 0;
  /** Counts wear() calls: one whose person arrives after a later call's must not undo it. */
  private wearing = 0;
  /** The showcase glow (see setGlow), shared by every figure's materials. */
  private glow = { value: 0 };
  /** Extra wait (ms) the first time each person is fetched, to see the spinner. */
  delay = 0;

  constructor(
    p: PreviewApi,
    private manifest: PeopleManifest,
  ) {
    const ktx2 = new KTX2Loader().setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/').detectSupport(p.ctx.renderer);
    this.loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    p.ctx.scene.add(this.group);
    p.onFrame((dt) => {
      this.on?.mixer.update(dt);
      if (this.turning) {
        const step = Math.min(this.turning, dt * 5);
        this.turning -= step;
        this.group.rotation.y += step;
      }
    });
  }

  /**
   * Puts `look` on the visitor (fetching that person first if need be). The latest call wins: choose
   * A (downloading), then B (already here), and B stays on when A arrives.
   */
  async wear(look: VisitorLook) {
    const n = ++this.wearing;
    const fig = await this.figure(look.avatar);
    if (n !== this.wearing) return;
    if (this.on !== fig) {
      if (this.on) this.group.remove(this.on.root);
      this.group.add(fig.root);
      this.on = fig;
    }
    for (const r of ['top', 'bottom', 'shoes'] as const) fig.tint?.setTint(r, look[r]);
    fig.hair?.setTint(look.hair);
    fig.root.scale.set(look.height * look.build, look.height, look.height * look.build);
  }

  turn() {
    this.turning += Math.PI;
  }

  /**
   * Lights the visitor from within by `k` of their own colours, dyes and all (emissive = the dyed
   * albedo × k, as outfit-tint's hi-vis trim glows at night). After dark the changing room's warm
   * walls light nothing, and without this the visitor is a black cut-out against them: no use for
   * choosing colours. The game's people need the same while dressing (PersonRig.setGlow adds a
   * flat grey, which washes the dyes out instead).
   */
  setGlow(k: number) {
    this.glow.value = k;
  }

  private figure(id: string) {
    let f = this.figures.get(id);
    if (!f) {
      f = this.load(id);
      // a failed fetch may be tried again
      f.catch(() => this.figures.delete(id));
      this.figures.set(id, f);
    }
    return f;
  }

  private async load(id: string): Promise<Figure> {
    const spec = this.manifest.avatars.find((a) => a.id === id);
    const file = spec?.files.hero ?? spec?.files.crowd;
    if (!spec || !file) throw new Error(`no such person: ${id}`);
    const [gltf, clip] = await Promise.all([this.loader.loadAsync(`${BASE}${file}`), this.idle(spec), this.delay ? new Promise((r) => setTimeout(r, this.delay)) : null]);
    const root = gltf.scene;
    let body: THREE.MeshStandardMaterial | null = null;
    let hair: HairTint | null = null;
    const materials = new Set<THREE.MeshStandardMaterial>();
    const bones = this.manifest.rigs[spec.rig]?.bones ?? {};
    root.traverse((o) => {
      if (/^LOD[1-9]/.test(o.name)) o.visible = false;
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const m = mesh.material as THREE.MeshStandardMaterial;
      materials.add(m);
      if (m.name === spec.parts.body) body = m;
      if (!hair && mesh.isSkinnedMesh && m.name === spec.parts.hair && canTintHair(spec)) {
        const skeleton = mesh.skeleton;
        const index = (bone: string | undefined) => (bone ? skeleton.bones.findIndex((b) => b.name === bone) : -1);
        hair = tintHair(m, spec.hairTone, { eyes: [index(bones.eye_l), index(bones.eye_r)], head: Math.max(0, index(bones.Head)), boneInverses: skeleton.boneInverses, bindMatrix: mesh.bindMatrix });
      }
    });
    const bodyMat = body as THREE.MeshStandardMaterial | null;
    const mask = bodyMat ? takeOutfitMask(bodyMat) : null;
    const tint = bodyMat && mask && spec.outfit ? tintOutfit(bodyMat, mask, spec.outfit.regions) : null;
    // the showcase glow, after the dye (so it glows the dyed colour)
    for (const m of materials) glowFromWithin(m, this.glow);
    const mixer = new THREE.AnimationMixer(root);
    if (clip) mixer.clipAction(clip).play();
    return { id, root, mixer, tint, hair, spec };
  }

  /** The idle from the person's own clip pack, its hip height scaled to them. */
  private idle(spec: AvatarSpec) {
    const key = `${spec.gender}:${spec.hip}`;
    let c = this.clips.get(key);
    if (!c) {
      c = (async () => {
        const pack = this.manifest.clipPacks[spec.gender];
        const info = pack?.clips.find((k) => k.name === 'Idle_Loop');
        if (!pack || !info) return null;
        const gltf = await this.loader.loadAsync(`${BASE}${pack.file}`);
        const all = gltf.animations.find((a) => a.name === 'clips') ?? gltf.animations[0];
        return all ? cut(all, info, spec.hip / pack.refHip, this.manifest.rigs[pack.rig]?.root ?? 'Bip01') : null;
      })();
      this.clips.set(key, c);
    }
    return c;
  }
}

/** Adds `glow` × the material's own (dyed) albedo to its emissive light: see PreviewVisitor.setGlow. */
function glowFromWithin(material: THREE.MeshStandardMaterial, glow: { value: number }) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.uShowcase = glow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uShowcase;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uShowcase;');
  };
  material.customProgramCacheKey = function () {
    return `${previousKey.call(this)}|showcase`;
  };
  material.needsUpdate = true;
}

/** One clip out of a pack's single timeline (see ClipInfo.start), the root's height scaled by `hip`. */
function cut(all: THREE.AnimationClip, info: ClipInfo, hip: number, rootNode: string) {
  const start = info.start ?? 0;
  const tracks = all.tracks.map((t) => {
    const c = t.clone().trim(start - 0.01, start + info.duration + 0.01).shift(-start);
    if (c.name === `${rootNode}.position`) for (let i = 0; i < c.values.length; i++) c.values[i] *= hip;
    return c;
  });
  return new THREE.AnimationClip(info.name, info.duration, tracks);
}

/** The prompt ring Zones draws for a zone (for the screenshots: the game draws its own). */
export function ringAt(scene: THREE.Scene, x: number, z: number, radius: number) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.35, radius, 48), new THREE.MeshBasicMaterial({ color: hdr(PALETTE.mustard, 2.4), transparent: true, opacity: 0.95 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.04, z);
  const fill = new THREE.Mesh(new THREE.CircleGeometry(radius - 0.35, 48), new THREE.MeshBasicMaterial({ color: PALETTE.mustard, transparent: true, opacity: 0.12, depthWrite: false }));
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(x, 0.03, z);
  scene.add(ring, fill);
}

/**
 * Mows the lawn under the cubicle's deck: the grass is planted before the cubicle exists, so here
 * the tufts on it are shrunk to nothing. (A stand-in for the screenshots: in the game,
 * environment.ts's grass growth should leave out `onChangingRoom` as it does the museum.)
 */
export function clearLawn(scene: THREE.Scene) {
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const none = new THREE.Matrix4().makeScale(0, 0, 0);
  scene.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh || !mesh.geometry.getAttribute('aSway')) return;
    let hit = false;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (!onChangingRoom(p.x, p.z, 0.15)) continue;
      mesh.setMatrixAt(i, none);
      hit = true;
    }
    if (hit) mesh.instanceMatrix.needsUpdate = true;
  });
}

export async function loadManifest() {
  const res = await fetch(`${BASE}manifest.json`);
  if (!res.ok) throw new Error(`manifest: ${res.status}`);
  return (await res.json()) as PeopleManifest;
}

const scene: PreviewScene = async (p) => {
  const q = p.params;
  // the game's stylesheet (the panel builds on its colours, fonts and buttons) and its fonts
  await import('../../styles.css');
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=Lilita+One&display=swap';
  document.head.appendChild(fonts);
  document.getElementById('preview-status')!.style.display = q.get('status') === '1' ? '' : 'none';

  const booth = new Booth(p.ctx);
  const room = new ChangingRoom(p.ctx);
  clearLawn(p.ctx.scene);
  p.onFrame((dt, t) => {
    booth.update(dt, t);
    room.update(dt, t);
  });

  const manifest = await loadManifest();
  const people = customiserPeople(manifest.avatars, BASE);
  const visitor = new PreviewVisitor(p, manifest);
  visitor.group.position.copy(room.standAt);
  // (the people face +z in their files: turn them to face out of the cubicle)
  visitor.group.rotation.y = CHANGING_ROOM.yaw;
  visitor.delay = Number(q.get('delay') ?? 0);
  // after dark, lit from within enough to see the colours (?glow=0 to see them without)
  const glow = Number(q.get('glow') ?? SHOWCASE_GLOW);
  p.onFrame(() => visitor.setGlow(glow * (p.env?.night ?? 0)));

  const colour = (k: string) => (q.get(k) ? `#${q.get(k)!.replace('#', '').toLowerCase()}` : null);
  const look: VisitorLook = {
    v: 1,
    avatar: q.get('avatar') ?? 'Female_Adult_01',
    top: colour('top'),
    bottom: colour('bottom'),
    shoes: colour('shoes'),
    hair: colour('hair'),
    height: Number(q.get('height') ?? 1),
    build: Number(q.get('build') ?? 1),
  };
  const firstVisit = q.get('first') === '1';
  const events: string[] = [];
  let customiser: Customiser;
  const host: CustomiserHost = {
    people,
    preview: (l) => {
      events.push(`preview ${l.avatar} ${l.top ?? '-'} ${l.bottom ?? '-'} ${l.shoes ?? '-'} ${l.hair ?? '-'} ${l.height} ${l.build}`);
      return visitor.wear(l);
    },
    close: (saved) => {
      events.push(`close ${saved}`);
      setTimeout(() => customiser.open(customiser.current, { firstVisit }), 1200);
    },
    turn: () => visitor.turn(),
  };
  // in a HUD layer, as the game mounts it (its stylesheet's rules for HUD buttons then apply too)
  const hud = document.createElement('div');
  hud.className = 'hud';
  document.body.appendChild(hud);
  customiser = new Customiser(host, hud);
  (window as unknown as { __cust: unknown }).__cust = { customiser, visitor, people, events, room };

  // the camera as the game will frame it: beside the panel (or above it on a phone)
  const camera = p.ctx.camera;
  const frame = () => {
    const w = innerWidth;
    const h = innerHeight;
    const portrait = w / h < 0.8;
    camera.fov = portrait ? 58 : 42;
    camera.aspect = w / h;
    const shot = room.shot(portrait);
    p.view(shot.pos, shot.look);
    const off = customiser.viewOffset(w, h);
    if (off.x || off.y) camera.setViewOffset(w, h, off.x, off.y, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };

  await visitor.wear(look).catch((e: unknown) => console.warn(e));
  customiser.open(look, { firstVisit });
  const tab = q.get('tab');
  if (tab) (document.querySelector(`[data-cust-tab="${tab}"]`) as HTMLElement | null)?.click();
  const filter = q.get('filter');
  if (filter) (document.querySelector(`[data-cust-filter="${filter}"]`) as HTMLElement | null)?.click();
  frame();
  addEventListener('resize', frame);
  // the panel's size settles once the fonts are in
  void document.fonts.ready.then(frame);
};
export default scene;
