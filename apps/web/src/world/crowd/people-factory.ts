// Builds the game's people from the people manifest (public/models/people/manifest.json, see
// people-manifest.ts): real clothed avatars from the Microsoft Rocketbox library (MIT) and
// MakeHuman (CC0), animated with shared clip packs.
//
//   const dl = downloadPeople({ sets: ['park'], hero: [visitorAvatar] });   // first thing, no renderer needed
//   …build the world…
//   const people = await PeopleFactory.create(renderer, dl, { tier });
//   const guest = people.create(people.randomLook(rnd));
//   await people.loadSet('airport');                                        // on the first trip
//   const crew = people.create(people.roleLook('cabin', rnd));
//
// The download starts the moment it's called (the manifest, then the clip packs and the sets'
// crowd files in parallel); create() parses what arrived. Avatars outside the sets load on demand
// (load(id)), one file each. Each avatar is parsed once into a template, and every person built
// from it shares its geometry, textures and clips; only materials (their dyes) and the skeleton are
// per person.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Tier } from '../quality';
import type { AgeGroup, AvatarSpec, ClipInfo, ClipPack, PeopleManifest, RigSpec, Role } from './people-manifest';
import { AIRLINE, HOLIDAY_TOPS, SWIM, dyeLook, isChild, ownColour, ownHair, pickFrom, plainLook, skinTone, GREY_HAIRS, hairShades, type Gender, type Look } from './looks';
import { outfitRegionsOf, takeOutfitMask } from './outfit-tint';
import { takeHairMask } from './hair-tint';
import { PersonRig, type AvatarTemplate, type ClipLibrary } from './person-rig';

export const PEOPLE_URL = `${import.meta.env.BASE_URL}models/people/`;
const TRANSCODER_URL = `${import.meta.env.BASE_URL}basis/`;

// ------------------------------------------------------------------------------------ download

/** The people's files, fetching from the moment downloadPeople() was called. */
export class PeopleDownload {
  readonly manifest: Promise<PeopleManifest>;
  /** performance.now() when it started. */
  readonly started = performance.now();
  /** Milliseconds from the start until everything first asked for had arrived. */
  readonly done: Promise<number>;
  /** Bytes arrived so far. */
  bytes = 0;
  private files = new Map<string, Promise<ArrayBuffer>>();

  constructor(
    readonly sets: readonly string[],
    readonly hero: readonly string[],
    /** The quality tier if known: the low tiers fetch only the park avatars they keep (see setMembers). */
    readonly tier: Tier | null,
    /** Where the manifest and the GLBs are (PEOPLE_URL unless a test says otherwise). */
    readonly url: string = PEOPLE_URL,
  ) {
    this.manifest = readManifest(url);
    // (PeopleFactory.create hears of a failure)
    this.manifest.catch(() => undefined);
    // as soon as the manifest is in: the clip packs, the sets' crowd files and the hero files at once
    this.done = this.manifest.then(async (m) => {
      const byId = new Map(m.avatars.map((a) => [a.id, a]));
      const names = new Set<string>(Object.values(m.clipPacks).map((p) => p.file));
      for (const set of sets)
        for (const id of setMembers(m, set, tier)) {
          const f = byId.get(id)?.files.crowd;
          if (f) names.add(f);
        }
      for (const id of hero) {
        const f = byId.get(id)?.files.hero;
        if (f) names.add(f);
      }
      await Promise.allSettled([...names].map((n) => this.file(n)));
      return performance.now() - this.started;
    });
    this.done.catch(() => undefined);
  }

  /** A file's bytes (relative to models/people/), fetched once. */
  file(name: string): Promise<ArrayBuffer> {
    let p = this.files.get(name);
    if (!p) {
      p = fetch(this.url + name).then(async (r) => {
        if (!r.ok) throw new Error(`people: ${name}: HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        this.bytes += buf.byteLength;
        return buf;
      });
      p.catch(() => undefined); // (whoever asks for it hears of a failure)
      this.files.set(name, p);
    }
    return p;
  }

  /** Lets go of a file's bytes once parsed (asking again fetches it again, from the HTTP cache). */
  release(name: string) {
    this.files.delete(name);
  }
}

/**
 * Starts downloading the people: the manifest, the clip packs, every crowd file of `sets` (e.g.
 * ['park']) and the hero files of the avatars in `hero` (the visitor's, Rosa's). Needs no renderer,
 * so the game can call it first thing. Given the quality `tier`, the low tiers skip the park
 * avatars they won't keep (about 5 MB); without it everything is fetched, and the factory lets go
 * of what it doesn't keep.
 */
export function downloadPeople(opts: { sets: string[]; hero?: string[]; tier?: Tier; url?: string }): PeopleDownload {
  return new PeopleDownload(opts.sets, opts.hero ?? [], opts.tier ?? null, opts.url);
}

/**
 * The manifest at `url`, checked enough to fail clearly: a missing file (or the dev server's HTML
 * page in its place) rejects with what went wrong, rather than with a parse error deep in the factory.
 */
async function readManifest(url: string): Promise<PeopleManifest> {
  const where = `${url}manifest.json`;
  let r: Response;
  try {
    r = await fetch(where);
  } catch (e) {
    throw new Error(`people: couldn't fetch ${where} (${(e as Error).message})`);
  }
  if (!r.ok) throw new Error(`people: ${where} is missing (HTTP ${r.status})`);
  let m: PeopleManifest;
  try {
    m = (await r.json()) as PeopleManifest;
  } catch {
    // (a dev server or an SPA host answers a missing file with its HTML page)
    const type = r.headers.get('content-type') ?? '';
    throw new Error(type.includes('html') ? `people: ${where} is missing (the server sent an HTML page)` : `people: ${where} isn't JSON (${type || 'no content type'})`);
  }
  if (!Array.isArray(m?.avatars) || !m.clipPacks || !m.rigs || !m.sets) throw new Error(`people: ${where} isn't a people manifest (no avatars, rigs, clip packs or sets)`);
  return m;
}

/** On the low tiers the park keeps this many distinct avatars (a round over men, women, children and older people, so each kind is there). */
const LOW_TIER_PARK = 12;

/**
 * A set's avatars that `tier` keeps (null: all of them). On the 'low' and 'lowest' tiers the park
 * keeps 12: one of each kind of person (by gender and age: a toddler for the shoulders, an older
 * woman…), then more of the kinds the set has most of, in the set's order.
 */
function setMembers(m: PeopleManifest, name: string, tier: Tier | null): string[] {
  const specs = new Map(m.avatars.map((a) => [a.id, a]));
  const ids = (m.sets[name] ?? []).filter((id) => specs.has(id));
  if (name !== 'park' || (tier !== 'low' && tier !== 'lowest') || ids.length <= LOW_TIER_PARK) return ids;
  const kind = (id: string) => `${specs.get(id)!.gender}|${specs.get(id)!.age}`;
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(kind(id), [...(groups.get(kind(id)) ?? []), id]);
  const kept = new Map([...groups.keys()].map((k) => [k, 1]));
  for (let n = groups.size; n < LOW_TIER_PARK; n++) {
    let best = '';
    let gap = -Infinity;
    for (const [k, g] of groups) {
      const have = kept.get(k)!;
      const short = (g.length / ids.length) * LOW_TIER_PARK - have;
      if (have < g.length && short > gap) (best = k), (gap = short);
    }
    kept.set(best, kept.get(best)! + 1);
  }
  return ids.filter((id) => {
    const left = kept.get(kind(id))!;
    kept.set(kind(id), left - 1);
    return left > 0;
  });
}

// ------------------------------------------------------------------------------------ clips

interface PackData {
  key: string;
  spec: ClipPack;
  /** The rig's root node, whose position track carries the hip height. */
  root: string;
  clips: Map<string, THREE.AnimationClip>;
  /** Locomotion loops: the left heel strike as a fraction of the cycle. */
  plants: Map<string, number>;
  /** The hips' mean position (pack units, model space) in the seated idle and the crouch. */
  hips: Map<string, THREE.Vector3>;
  /** Node names under the second spine bone (inclusive): the upper body. */
  upper: Set<string>;
}

/** The extra pack's clips win a clash of names: its Interact and Crouch_Idle_Loop are the ones the game means. */
function packOrder(packs: PackData[], gender: Gender) {
  const own = packs.filter((p) => p.spec.gender === gender);
  const any = packs.filter((p) => p.spec.gender === 'any');
  return [...own, ...any];
}

/** A clip pack's clips, cut from its one timeline, measured on its own skeleton. */
function readPack(key: string, spec: ClipPack, gltf: GLTF, rig: RigSpec): PackData {
  const clips = new Map<string, THREE.AnimationClip>();
  const timeline = gltf.animations.find((a) => a.name === 'clips');
  for (const info of spec.clips) {
    let clip: THREE.AnimationClip | undefined;
    if (info.start !== undefined && timeline) {
      const s = info.start;
      const tracks = timeline.tracks.map((t) => t.clone().trim(s - 0.01, s + info.duration + 0.01).shift(-s));
      clip = new THREE.AnimationClip(info.name, info.duration, tracks);
    } else {
      clip = gltf.animations.find((a) => a.name === info.name);
      if (clip) clip.name = info.name;
    }
    if (clip) clips.set(info.name, clip);
  }
  const root = rig.root;
  const model = gltf.scene;
  const upper = new Set<string>();
  model.getObjectByName(rig.bones.spine_02 ?? '')?.traverse((o) => upper.add(o.name));

  // pose the pack's own skeleton to measure where feet plant and hips sit
  const mixer = new THREE.AnimationMixer(model);
  const foot = model.getObjectByName(rig.bones.foot_l ?? '');
  const hipsNode = model.getObjectByName(root);
  const plants = new Map<string, number>();
  const hips = new Map<string, THREE.Vector3>();
  const p = new THREE.Vector3();
  const h = new THREE.Vector3();
  const pose = (clip: THREE.AnimationClip, t: number) => {
    mixer.stopAllAction();
    const a = mixer.clipAction(clip);
    a.play();
    a.time = t;
    mixer.update(0);
    model.updateMatrixWorld(true);
  };
  for (const info of spec.clips) {
    const clip = clips.get(info.name);
    if (!clip || !foot || !hipsNode) continue;
    if (info.speed) {
      // the left heel strikes when that foot is furthest forward of the hips (the model faces +z)
      let best = -Infinity;
      let at = 0;
      const N = 96;
      for (let i = 0; i < N; i++) {
        pose(clip, (i / N) * clip.duration);
        const z = foot.getWorldPosition(p).z - hipsNode.getWorldPosition(h).z;
        if (z > best) (best = z), (at = i / N);
      }
      plants.set(info.name, at);
    }
    if (info.name === 'Sitting_Idle_Loop' || info.name === 'Crouch_Idle_Loop') {
      const sum = new THREE.Vector3();
      const N = 24;
      for (let i = 0; i < N; i++) {
        pose(clip, (i / N) * clip.duration);
        sum.add(hipsNode.getWorldPosition(h));
      }
      hips.set(info.name, sum.divideScalar(N));
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return { key, spec, root, clips, plants, hips, upper };
}

/** One avatar body's clips: its gender's pack and the extra pack, with hip motion scaled to its hips. */
class Library implements ClipLibrary {
  private from = new Map<string, PackData>();
  private full = new Map<string, THREE.AnimationClip>();
  private top = new Map<string, THREE.AnimationClip>();
  readonly sitHips: THREE.Vector3;
  readonly crouchHips: THREE.Vector3 | null;
  readonly animated = new Set<string>();
  readonly refHip: number;

  constructor(
    packs: PackData[],
    private hip: number,
  ) {
    for (const p of packs) for (const name of p.clips.keys()) this.from.set(name, p);
    for (const p of packs) for (const c of p.clips.values()) for (const t of c.tracks) this.animated.add(t.name.slice(0, t.name.lastIndexOf('.')));
    this.refHip = packs[0]?.spec.refHip ?? 0.9;
    const hipsOf = (name: string) => {
      const p = this.from.get(name);
      const v = p?.hips.get(name);
      return v && p ? v.clone().multiplyScalar(hip / p.spec.refHip) : null;
    };
    this.sitHips = hipsOf('Sitting_Idle_Loop') ?? new THREE.Vector3(0, 0.6, -0.46);
    this.crouchHips = hipsOf('Crouch_Idle_Loop');
  }

  clip(name: string) {
    let c = this.full.get(name);
    if (c) return c;
    const p = this.from.get(name);
    const raw = p?.clips.get(name);
    if (!p || !raw) return undefined;
    const k = this.hip / p.spec.refHip;
    if (Math.abs(k - 1) < 1e-3) c = raw;
    else {
      // only the hip height track differs from body to body: the rotations are shared
      const rootPos = `${p.root}.position`;
      const tracks = raw.tracks.map((t) => {
        if (t.name !== rootPos) return t;
        const s = t.clone();
        s.values = s.values.map((v) => v * k);
        return s;
      });
      c = new THREE.AnimationClip(name, raw.duration, tracks);
    }
    this.full.set(name, c);
    return c;
  }

  upper(name: string) {
    let c = this.top.get(name);
    if (c) return c;
    const full = this.clip(name);
    const p = this.from.get(name);
    if (!full || !p) return undefined;
    c = new THREE.AnimationClip(`${name}~upper`, full.duration, full.tracks.filter((t) => p.upper.has(t.name.slice(0, t.name.lastIndexOf('.')))));
    this.top.set(name, c);
    return c;
  }

  info(name: string): ClipInfo | undefined {
    return this.from.get(name)?.spec.clips.find((c) => c.name === name);
  }

  plant(name: string) {
    return this.from.get(name)?.plants.get(name) ?? 0;
  }

  names() {
    return [...this.from.keys()];
  }
}

// ------------------------------------------------------------------------------------ factory

export type LookRole = 'pilot' | 'cabin' | 'ground' | 'mechanic' | 'security' | 'swim' | 'beach' | 'traveller';

export interface RandomLookOptions {
  child?: boolean;
  gender?: Gender;
  age?: AgeGroup | 'young' | 'old';
  /** The avatars' role (default 'guest'). */
  role?: Role;
  /** Which set's avatars (default 'park'). */
  set?: string;
  /** Avatars to leave out (the visitor's, so nobody in the crowd is their double). */
  exclude?: string[];
  /** Chance of recolouring the outfit (default 0.55). */
  dye?: number;
}

const U = (r: () => number, a: number, b: number) => a + r() * (b - a);
const BUILD = (r: () => number) => U(r, 0.95, 1.05);
const HEIGHT = (r: () => number) => U(r, 0.96, 1.04);
const SUMMER = /^(shorts|vest|tshirt|sandals|swimwear|top|polo)$/;

export class PeopleFactory {
  readonly manifest: PeopleManifest;
  /** Timings and sizes, for the record. */
  readonly stats = { downloadMs: 0, parseMs: 0, textureBytes: 0, templates: 0 };
  private loader: GLTFLoader;
  private packs: PackData[] = [];
  private libraries = new Map<string, Library>();
  private templates = new Map<string, AvatarTemplate>();
  private pending = new Map<string, Promise<AvatarTemplate | null>>();
  private setsLoaded = new Set<string>();
  private setLoads = new Map<string, Promise<void>>();
  private uses = new Map<string, number>();
  private specs: Map<string, AvatarSpec>;
  private dl: PeopleDownload;
  private tier: Tier;
  private warned = new Set<string>();
  private members = new Map<string, string[]>();

  private constructor(renderer: THREE.WebGLRenderer, manifest: PeopleManifest, dl: PeopleDownload, tier: Tier) {
    this.manifest = manifest;
    this.dl = dl;
    this.tier = tier;
    this.specs = new Map(manifest.avatars.map((a) => [a.id, a]));
    const ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_URL).detectSupport(renderer);
    this.loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  }

  /**
   * Parses what `dl` downloads: the clip packs, the sets' avatars and the hero files. On the 'low'
   * and 'lowest' tiers the park keeps 12 of its avatars (texture memory: each crowd avatar is
   * about 1.4 MB on the GPU), chosen to keep men, women, children and older people.
   */
  static async create(renderer: THREE.WebGLRenderer, dl: PeopleDownload, opts: { tier?: Tier } = {}): Promise<PeopleFactory> {
    const manifest = await dl.manifest;
    const f = new PeopleFactory(renderer, manifest, dl, opts.tier ?? 'high');
    const t0 = performance.now();
    await f.loadPacks();
    await Promise.all([...dl.sets.map((s) => f.loadSet(s)), ...dl.hero.map((id) => f.load(id, { hero: true }))]);
    // (a download that didn't know the tier fetched the whole set: let go of the files this tier leaves out)
    for (const s of dl.sets) {
      const kept = new Set(f.setMembers(s));
      for (const id of manifest.sets[s] ?? []) {
        const file = f.spec(id)?.files.crowd;
        if (file && !kept.has(id)) dl.release(file);
      }
    }
    f.stats.parseMs = performance.now() - t0;
    f.stats.downloadMs = await dl.done;
    return f;
  }

  private async loadPacks() {
    const entries = Object.entries(this.manifest.clipPacks);
    const rigs = this.manifest.rigs;
    const fallback = rigs.rocketbox ?? Object.values(rigs)[0];
    this.packs = await Promise.all(
      entries.map(async ([key, spec]) => {
        const gltf = await this.loader.parseAsync(await this.dl.file(spec.file), this.dl.url);
        this.dl.release(spec.file);
        // (a pack retargeted onto the same skeleton may name a rig the manifest doesn't list)
        return readPack(key, spec, gltf, rigs[spec.rig] ?? fallback);
      }),
    );
  }

  /** The clips for a body of this gender and hip height (shared by every avatar that matches). */
  private library(gender: Gender, hip: number) {
    const key = `${gender}|${hip.toFixed(3)}`;
    let lib = this.libraries.get(key);
    if (!lib) this.libraries.set(key, (lib = new Library(packOrder(this.packs, gender), hip)));
    return lib;
  }

  // ---------------------------------------------------------------------------------- avatars

  spec(id: string) {
    return this.specs.get(id);
  }

  /** The avatars a visitor can be, in manifest order. */
  playable() {
    return this.manifest.avatars.filter((a) => a.roles.includes('playable'));
  }

  /** Is that avatar's file (hero: the 1024 px one) loaded? */
  has(id: string, hero = false) {
    return this.templates.has(`${id}|${hero ? 'hero' : 'crowd'}`);
  }

  /** Loads one avatar (the crowd file, or the hero file): for a customiser's pick, Rosa, the visitor. */
  async load(id: string, opts: { hero?: boolean } = {}): Promise<void> {
    await this.template(id, !!opts.hero);
  }

  /**
   * Loads a whole set ('park', 'airport', 'island'), say on the first trip there. Calling it again,
   * even while the first call is still loading, waits for the same load (each file is fetched and
   * parsed once). An avatar that fails to load is left out with a warning; the rest still load.
   */
  loadSet(name: string): Promise<void> {
    let p = this.setLoads.get(name);
    if (!p) {
      p = Promise.all(this.setMembers(name).map((id) => this.template(id, false))).then((got) => {
        this.setsLoaded.add(name);
        // (one missing after a network failure: the next call tries it again)
        if (got.includes(null)) this.setLoads.delete(name);
      });
      this.setLoads.set(name, p);
    }
    return p;
  }

  isSetLoaded(name: string) {
    return this.setsLoaded.has(name);
  }

  /** The set's avatars this tier keeps. */
  private setMembers(name: string) {
    let ids = this.members.get(name);
    if (!ids) this.members.set(name, (ids = setMembers(this.manifest, name, this.tier)));
    return ids;
  }

  private template(id: string, hero: boolean): Promise<AvatarTemplate | null> {
    const key = `${id}|${hero ? 'hero' : 'crowd'}`;
    const had = this.templates.get(key);
    if (had) return Promise.resolve(had);
    // (two callers at once share one fetch and one parse; a failure is forgotten, so a later call tries again)
    let p = this.pending.get(key);
    if (!p) {
      p = this.parse(id, hero)
        .catch((e) => {
          console.warn(`people: ${id} failed to load`, e);
          return null;
        })
        .then((t) => {
          if (t) this.templates.set(key, t);
          this.pending.delete(key);
          return t;
        });
      this.pending.set(key, p);
    }
    return p;
  }

  private async parse(id: string, hero: boolean): Promise<AvatarTemplate | null> {
    const spec = this.specs.get(id);
    const file = spec && (hero ? spec.files.hero : spec.files.crowd);
    if (!spec || !file) {
      if (import.meta.env.DEV) console.warn(`people: no ${hero ? 'hero' : 'crowd'} file for "${id}"`);
      return null;
    }
    let gltf: GLTF;
    try {
      gltf = await this.loader.parseAsync(await this.dl.file(file), this.dl.url);
    } catch (e) {
      console.warn(`people: ${file} failed to load`, e);
      return null;
    } finally {
      this.dl.release(file);
    }
    const rig = this.manifest.rigs[spec.rig] ?? Object.values(this.manifest.rigs)[0];
    const scene = gltf.scene;
    let body: THREE.MeshStandardMaterial | null = null;
    let head: THREE.MeshStandardMaterial | null = null;
    let skeleton: THREE.Skeleton | null = null;
    const seen = new Set<THREE.Texture>();
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.castShadow = true;
      // (shade under roofs, trees and each other, rather than glowing as if pasted in)
      m.receiveShadow = true;
      // the crowd culls people by a sphere round each; a skinned mesh's own bounds don't follow its pose
      m.frustumCulled = false;
      skeleton ??= m.skeleton;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name === spec.parts.body) body = mat;
      else if (mat.name === spec.parts.head) head = mat;
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) seen.add(v);
    });
    // the masks come off the template's materials before anyone clones them (or a clone would draw them as ambient occlusion)
    const bodyMat = body as THREE.MeshStandardMaterial | null;
    const mask = bodyMat ? takeOutfitMask(bodyMat) : null;
    const headMat = head as THREE.MeshStandardMaterial | null;
    const hairMask = headMat ? takeHairMask(headMat) : null;
    const regions = spec.outfit?.regions ?? (bodyMat ? outfitRegionsOf(bodyMat) : null);
    for (const tex of seen) this.stats.textureBytes += textureBytes(tex);
    this.stats.templates++;
    const bones = (skeleton as THREE.Skeleton | null)?.bones ?? [];
    const index = (bone: string | undefined) => (bone ? bones.findIndex((b) => b.name === bone) : -1);
    return {
      spec,
      hero,
      rig,
      scene,
      clips: this.library(spec.gender, spec.hip),
      outfit: mask && regions && Object.keys(regions).length ? { mask, regions } : null,
      hairMask,
      skin: { eyes: [index(rig.bones.eye_l), index(rig.bones.eye_r)], head: Math.max(0, index(rig.bones.Head)) },
    };
  }

  /** The loaded templates, crowd files (or hero ones when that's all there is). */
  private loaded(): AvatarSpec[] {
    const out = new Map<string, AvatarSpec>();
    for (const t of this.templates.values()) out.set(t.spec.id, t.spec);
    return [...out.values()];
  }

  /** Loaded avatars of a set (what this tier kept of it). */
  private loadedIn(set: string) {
    const ids = new Set(this.setMembers(set));
    return this.loaded().filter((a) => ids.has(a.id));
  }

  // ---------------------------------------------------------------------------------- people

  /**
   * A person wearing `look`, at once. If that avatar (or its hero file) isn't loaded, the crowd file
   * stands in, else the closest loaded avatar of the same gender and age (a warning in dev).
   */
  create(look: Look): PersonRig {
    const want = look.hero ? this.templates.get(`${look.avatar}|hero`) : undefined;
    let t = want ?? this.templates.get(`${look.avatar}|crowd`) ?? (look.hero ? undefined : this.templates.get(`${look.avatar}|hero`));
    if (!t) {
      const close = this.closest(look);
      if (!close) throw new Error('people: no avatars are loaded');
      this.warnOnce(`${look.avatar} isn't loaded: ${close.spec.id} stands in (load it, or its set, first)`, `stand-in|${look.avatar}`);
      t = close;
    } else if (look.hero && !want) this.warnOnce(`${look.avatar}'s hero file isn't loaded: the crowd file stands in`, `hero|${look.avatar}`);
    return new PersonRig(t, look);
  }

  private closest(look: Look): AvatarTemplate | undefined {
    const all = [...this.templates.values()].filter((t) => !t.hero);
    const pool = all.length ? all : [...this.templates.values()];
    const score = (t: AvatarTemplate) => (t.spec.gender === look.gender ? 0 : 2) + (t.spec.age === look.age ? 0 : isChild(t.spec.age) === look.child ? 1 : 4);
    return pool.sort((a, b) => score(a) - score(b))[0];
  }

  /** A dev warning, once per `key` (the message itself unless given: a stand-in's warns once per avatar asked for, whoever stands in). */
  private warnOnce(msg: string, key = msg) {
    if (!import.meta.env.DEV || this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`people: ${msg}`);
  }

  /** Picks among `pool`, favouring avatars used least so far (fewer doubles in a crowd). */
  private choose(r: () => number, pool: AvatarSpec[]): AvatarSpec {
    const w = pool.map((a) => 1 / (1 + (this.uses.get(a.id) ?? 0)));
    let x = r() * w.reduce((s, v) => s + v, 0);
    let i = 0;
    while (i < pool.length - 1 && (x -= w[i]) > 0) i++;
    const spec = pool[i];
    this.uses.set(spec.id, (this.uses.get(spec.id) ?? 0) + 1);
    return spec;
  }

  /**
   * A park guest (or another role's person) among the loaded avatars of `set`: adults unless
   * `child`; 'old' picks older people, 'young' anyone but. With chance `dye` their top and/or bottom
   * is recoloured from everyday palettes, so a few dozen avatars make a crowd without clones; height
   * varies ±4 % and build ±5 %.
   */
  randomLook(r: () => number, opts: RandomLookOptions = {}): Look {
    const role = opts.role ?? 'guest';
    const exclude = new Set(opts.exclude ?? []);
    const all = this.loadedIn(opts.set ?? 'park').filter((a) => !exclude.has(a.id));
    const fits = (a: AvatarSpec, strict: { role: boolean; gender: boolean; age: boolean }) => {
      if (strict.role && !a.roles.includes(role)) return false;
      if (isChild(a.age) !== !!opts.child) return false;
      if (strict.gender && opts.gender && a.gender !== opts.gender) return false;
      if (strict.age && opts.age) {
        if (opts.age === 'old') return a.age === 'older';
        if (opts.age === 'young') return a.age !== 'older';
        return a.age === opts.age;
      }
      return true;
    };
    let greyed = false;
    let pool = all.filter((a) => fits(a, { role: true, gender: true, age: true }));
    if (!pool.length) {
      // no older person of that gender here: an adult with grey hair
      pool = all.filter((a) => fits(a, { role: true, gender: true, age: false }));
      greyed = opts.age === 'old';
    }
    if (!pool.length) pool = all.filter((a) => fits(a, { role: false, gender: true, age: false }));
    if (!pool.length) {
      // the set isn't loaded (an airport-only scene asking for travellers): someone of that role from
      // another set rather than a pilot in uniform
      this.warnOnce(`randomLook: no "${opts.set ?? 'park'}" avatars are loaded`);
      pool = this.loaded().filter((a) => !exclude.has(a.id) && fits(a, { role: true, gender: true, age: false }));
    }
    if (!pool.length) pool = this.loaded().filter((a) => isChild(a.age) === !!opts.child);
    if (!pool.length) pool = this.loaded();
    const spec = this.choose(r, pool);
    const look = plainLook(spec, HEIGHT(r), BUILD(r));
    dyeLook(look, spec, r, opts.dye ?? 0.55);
    // (greyed only where grey looks real on that hair: see hairShades)
    const greys = greyed ? GREY_HAIRS.filter((c) => hairShades({ ...spec, tags: [...spec.tags, 'greyHair'] }).includes(c)) : [];
    if (greys.length) look.hair = pickFrom(r, greys);
    return look;
  }

  /**
   * A look for one of the airport's and the island's people: pilots and cabin crew (dark suits with
   * the airline's gold scarf), hi-vis ground crew, mechanics, security, swimmers, holidaymakers on
   * the beach, and travellers (the park's guests). Picks among loaded avatars; if none of that role
   * is loaded yet it borrows a guest (load the set first: loadSet('airport'), loadSet('island')).
   */
  roleLook(role: LookRole, r: () => number, opts: { child?: boolean; gender?: Gender } = {}): Look {
    const child = !!opts.child;
    const loaded = this.loaded().filter((a) => isChild(a.age) === child);
    const byGender = (pool: AvatarSpec[]) => {
      const g = opts.gender ? pool.filter((a) => a.gender === opts.gender) : pool;
      return g.length ? g : pool;
    };
    const withRole = (want: Role, extra?: (a: AvatarSpec) => boolean) => byGender(loaded.filter((a) => a.roles.includes(want) && (!extra || extra(a))));
    const make = (pool: AvatarSpec[], fallback: () => Look) => {
      if (!pool.length) {
        this.warnOnce(`no "${role}" avatars are loaded: a guest stands in`);
        return fallback();
      }
      const spec = this.choose(r, pool);
      return plainLook(spec, HEIGHT(r), BUILD(r));
    };
    switch (role) {
      case 'pilot':
        return make(withRole('pilot'), () => this.randomLook(r, { ...opts, dye: 0 }));
      case 'cabin': {
        // the cabin crew's suit: a dark ink navy, black shoes, the airline's gold scarf
        const suits = withRole('cabin', (a) => a.tags.includes('suit'));
        const look = make(suits.length ? suits : withRole('cabin'), () => this.randomLook(r, { ...opts, dye: 0 }));
        const regions = this.specs.get(look.avatar)?.outfit?.regions ?? {};
        look.top = regions.top ? AIRLINE.suit : null;
        look.bottom = regions.bottom ? AIRLINE.suit : null;
        look.shoes = regions.shoes ? AIRLINE.shoes : null;
        look.wear = { scarf: AIRLINE.gold };
        return look;
      }
      case 'ground':
      case 'mechanic':
      case 'security':
        return make(withRole(role), () => this.randomLook(r, { ...opts, dye: 0 }));
      case 'swim': {
        if (child) return this.roleLook('beach', r, opts);
        const look = make(withRole('swim'), () => this.roleLook('beach', r, opts));
        const regions = this.specs.get(look.avatar)?.outfit?.regions ?? {};
        if (r() < 0.75) {
          const c = pickFrom(r, SWIM);
          if (regions.top) look.top = c;
          if (regions.bottom) look.bottom = c;
        }
        return look;
      }
      case 'beach': {
        const summer = byGender(loaded.filter((a) => a.roles.includes('beach') || (a.roles.includes('guest') && a.tags.some((t) => SUMMER.test(t)) && !a.tags.includes('swimwear'))));
        const look = make(summer, () => this.randomLook(r, { ...opts, dye: 0.8 }));
        const spec = this.specs.get(look.avatar);
        if (spec) dyeLook(look, spec, r, 0.8, true);
        return look;
      }
      case 'traveller': {
        const look = this.randomLook(r, { child, gender: opts.gender });
        const spec = this.specs.get(look.avatar);
        if (spec?.outfit?.regions.top && !spec.tags.includes('suit') && !spec.tags.includes('traditional') && r() < 0.35) look.top = pickFrom(r, HOLIDAY_TOPS);
        return look;
      }
    }
  }

  /**
   * The look's colours as '#rrggbb', for far stand-ins (block figures, the jet-ski's far rider):
   * its dyes, else the avatar's own (outfit regions, hair tone, a skin tone for its AvatarSpec.skin).
   */
  coloursOf(look: Look): { skin: string; hair: string; top: string; bottom: string; shoes: string } {
    const spec = this.specs.get(look.avatar);
    if (!spec) return { skin: '#dfb597', hair: look.hair ?? '#2f2117', top: look.top ?? '#8d8f93', bottom: look.bottom ?? '#2b3a55', shoes: look.shoes ?? '#2a2622' };
    const skin = skinTone(spec.skin);
    return {
      skin,
      hair: look.hair ?? ownHair(spec, skin),
      top: look.top ?? ownColour(spec, 'top'),
      bottom: look.bottom ?? look.top ?? ownColour(spec, 'bottom'),
      shoes: look.shoes ?? ownColour(spec, 'shoes'),
    };
  }
}

/** GPU bytes of a texture: a compressed one's mip chain as it is, others RGBA8 plus a third for mips. */
export function textureBytes(tex: THREE.Texture): number {
  const t = tex as THREE.CompressedTexture;
  if (t.isCompressedTexture) return t.mipmaps.reduce((s: number, m: { data: ArrayBufferView }) => s + m.data.byteLength, 0);
  const img = tex.image as { width?: number; height?: number } | undefined;
  return img?.width && img.height ? Math.round(img.width * img.height * 4 * (4 / 3)) : 0;
}
