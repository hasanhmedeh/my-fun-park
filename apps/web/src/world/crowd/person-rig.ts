// One person: a real avatar from the people manifest (Rocketbox, or MakeHuman for the youngest and
// some older women), animated with the shared clip packs, and dressed per person. The PeopleFactory
// (people-factory.ts) builds them; this is what the game drives every frame. It keeps every public
// member of the old Quaternius rig with the same meaning, so its consumers barely change:
//
// - root at the feet on the ground; at root.rotation.y = 0 the person faces -z;
// - update(dt, speed) blends idle and locomotion by ground speed, on one shared stride phase that
//   advances by distance walked, so feet stay planted at any pace;
// - setBase picks what they do standing still (or seated, crouched, dancing…), play() a one-shot,
//   wave(), kick() and armsUp layer on top;
// - seatDrop is how far below a seat's surface the root goes in the seated pose, and in that pose the
//   hips land where the old rig's did relative to the root (the model is shifted inside the rig by
//   the difference, blended by the sit weight), so every seat in the game keeps working.
//
// Animation data is shared: clips come from a ClipLibrary per clip pack and hip height, whose
// rotation tracks every avatar of that pack shares. Materials are cloned per person (dyes, hair
// tint and glow are per person) but compile to shared programs. Garments a look wears (Rosa's apron,
// the cabin crew's scarf: Look.wear) are fitted to this body when it's built (garments.ts) and come
// and go with applyLook.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { AvatarSpec, CanonicalBone, ClipInfo, OutfitRegion, RigSpec } from './people-manifest';
import { canTintHair, hairCovered, isChild, paintedHair, sameModel, type Look } from './looks';
import { tintOutfit, type OutfitRegions, type OutfitTint } from './outfit-tint';
import { tintHair, type HairTint, type HatClip } from './hair-tint';
import { buildGarment, disposeGarment, recolourGarment, type GarmentKind } from './garments';

export type { HatClip } from './hair-tint';

export type Base =
  | 'stand' | 'sit' | 'talk' | 'crouch' | 'dance'
  | 'listen' | 'phone' | 'text' | 'foldArms' | 'rail' | 'clap' | 'cheer' | 'sitGround' | 'lie'
  | 'swim' | 'tread' | 'drive' | 'carry' | 'bag' | 'wait' | 'trolley' | 'kneel';
export type AnchorName = 'headTop' | 'back' | 'shoulderL' | 'palmL' | 'palmR';
export type TintRegion = 'top' | 'bottom' | 'shoes' | 'hair';

/** The animation an avatar can play: its packs' clips, with the hip motion scaled to its body. */
export interface ClipLibrary {
  /** The full-body clip, or undefined if no pack has it. */
  clip(name: string): THREE.AnimationClip | undefined;
  /** The same clip for the upper body only (from the second spine bone up), to layer over legs doing something else. */
  upper(name: string): THREE.AnimationClip | undefined;
  info(name: string): ClipInfo | undefined;
  /** A locomotion loop's left heel strike, as a fraction of its cycle (0 when unmeasured). */
  plant(name: string): number;
  names(): string[];
  /** Where the hips are (model space, the model facing +z) in the seated idle, and in the crouch: averaged over the clip. */
  sitHips: THREE.Vector3;
  crouchHips: THREE.Vector3 | null;
  /** The rig's node names that some clip moves (the others never change: face bones). */
  animated: ReadonlySet<string>;
  /** The packs' reference hip height for the gender pack (speeds scale by hip over it). */
  refHip: number;
}

/** What the factory parsed for one avatar file, shared by everyone built from it. */
export interface AvatarTemplate {
  spec: AvatarSpec;
  hero: boolean;
  rig: RigSpec;
  scene: THREE.Object3D;
  clips: ClipLibrary;
  outfit: { mask: THREE.Texture; regions: OutfitRegions } | null;
  /** The head texture's painted hair, where the GLB masks it (taken off the template's head material, see takeHairMask). */
  hairMask: THREE.Texture | null;
  /** Skeleton indices for the hair tint: the eye bones (never tinted) and the head (the hat clip's frame). */
  skin: { eyes: [number, number]; head: number };
}

/**
 * Where the OLD rig's hips (its pelvis bone) sat relative to the root in its seated and crouched
 * clips, per metre of height, for its male and female bodies (root space: +x the person's right,
 * +z behind them), averaged over the loop. Measured with the old PeopleFactory in the people
 * preview (?scene=people&mode=bench&measure=1, and base=crouch); the new rig is shifted by the
 * difference so seats placed for the old one still fit. (The new avatars' own seatDrop sets the
 * height: their buttocks rest on the seat, where the old rig's sank 5 cm into it.)
 */
export const OLD_SIT_HIPS = { m: { x: -0.0016, z: 0.1885 }, f: { x: -0.0017, z: 0.1973 } };
export const OLD_CROUCH_HIPS = { m: { x: -0.0184, z: 0.1592 }, f: { x: -0.02, z: 0.1666 } };

/**
 * At setGlow(1) every surface adds this much of its own colour (dyes and hair tint included) to the
 * light it gives off: after dark people stay readable under the park's lights in their own colours.
 * (The old rig added a flat grey, which washed the dyes out.)
 */
const GLOW = 0.3;

/** The garments a Look can wear, in the order they're put on. */
const GARMENTS: GarmentKind[] = ['apron', 'scarf'];

/** Dev warnings already given (a crowd of one avatar would otherwise repeat each one every frame). */
const warned = new Set<string>();
function warnOnce(msg: string) {
  if (!import.meta.env.DEV || warned.has(msg)) return;
  warned.add(msg);
  console.warn(`people: ${msg}`);
}

/**
 * Adds `glow.value` × the surface's own colour to the light it gives off (after the dyes and the hair
 * tint, which run in map_fragment). Every material of every person carries it under the same cache
 * key, so they still share compiled programs; `glow` is the person's own uniform.
 */
function glowFromWithin(material: THREE.MeshStandardMaterial, glow: { value: number }) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.uGlow = glow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uGlow;');
  };
  material.customProgramCacheKey = function () {
    return `${previousKey.call(this)}|glow`;
  };
  material.needsUpdate = true;
}

/** LOD switch distances (metres, for a 1.75 m person; smaller people switch sooner) and the hysteresis around them. */
export const LOD_DISTANCES = [14, 34];
const LOD_HYSTERESIS = 0.06;

/** Each person's own choice among these, so a crowd doesn't move in lockstep. */
const STAND_IDLES = ['Idle_Loop', 'Idle_Loop', 'Idle_Breathe', 'Idle_Weight_Shift'];
/** Short, subtle fidgets while standing a while; the rare ones are bigger. */
const STAND_FIDGETS = ['Idle_Look_Around', 'Idle_Look_Around_2', 'Idle_Scratch_Head'];
const RARE_FIDGETS = ['Idle_Yawn', 'Idle_Stretch'];

interface BaseDef {
  /** Clip choices (each person picks one; some bases switch now and then). */
  clips: string[];
  /** Over walking legs, the base's upper body carries on (texting while walking); 'always': it's only ever an upper-body layer (carrying a box). */
  upper?: 'moving' | 'always';
  /** No walking legs in this pose (in the water, lying down, at the wheel). */
  still?: boolean;
  /** The legs stay as they are under an arm-only one-shot (seated, crouched, kneeling, in the water). */
  planted?: boolean;
  /** One-shots it fidgets with now and then, and whether it switches between its clips. */
  fidgets?: string[];
  switches?: boolean;
}

const BASES: Record<Base, BaseDef> = {
  stand: { clips: STAND_IDLES, fidgets: STAND_FIDGETS, switches: true },
  sit: { clips: ['Sitting_Idle_Loop'], fidgets: ['Sitting_Look_Around'], planted: true },
  talk: { clips: ['Idle_Talking_Loop', 'Talk_2', 'Talk_3', 'Talk_4', 'Talk_5', 'Talk_6'], switches: true },
  crouch: { clips: ['Crouch_Idle_Loop'], planted: true },
  dance: { clips: ['Dance_Loop', 'Dance_2'] },
  listen: { clips: ['Listen', 'Listen_2', 'Listen_3'], fidgets: ['Nod'], switches: true },
  phone: { clips: ['Phone_Call'], upper: 'moving' },
  text: { clips: ['Phone_Text'], upper: 'moving' },
  foldArms: { clips: ['Idle_FoldArms_Loop'], upper: 'moving' },
  rail: { clips: ['Idle_Rail_Loop'], fidgets: ['Idle_Rail_Call'] },
  clap: { clips: ['Clap'] },
  cheer: { clips: ['Cheer', 'Cheer_2'] },
  sitGround: { clips: ['Sit_Ground_Loop'], still: true, planted: true },
  lie: { clips: ['Lie_Loop'], still: true, planted: true },
  swim: { clips: ['Swim_Fwd_Loop'], still: true, planted: true },
  tread: { clips: ['Swim_Idle_Loop'], still: true, planted: true },
  drive: { clips: ['Driving_Loop'], still: true, planted: true },
  carry: { clips: ['Walk_Carry_Loop'], upper: 'always' },
  bag: { clips: ['Hold_Bag'], upper: 'moving' },
  wait: { clips: ['Idle_Waiting'] },
  trolley: { clips: ['Trolley_Idle'], upper: 'moving' },
  kneel: { clips: ['Kneel_Fix_Loop'], still: true, planted: true },
};

/** One-shots that only need the arms: played over walking legs instead of stopping them. */
const UPPER_OK = new Set(['Interact', 'Wave', 'Wave_2', 'Offer', 'Eat', 'Thumbs_Up', 'Pick_Up', 'Drink', 'Take_Photo', 'Clap', 'Cheer', 'Cheer_2', 'Shrug', 'Nod', 'Head_Shake', 'Shake_No', 'Throw_Overhand', 'Phone_Call', 'Phone_Text']);

/** The walking and running loops, slowest first; each person walks with one slow and one normal walk. */
const SLOW_WALKS = ['Walk_Stroll_Loop', 'Walk_Slow_Loop'];
const WALKS = ['Walk_Loop', 'Walk_Loop', 'Walk_Fast_Loop'];
const RUNS = ['Jog_Fwd_Loop', 'Run_Loop', 'Sprint_Loop'];

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const v3 = new THREE.Vector3();
const q3 = new THREE.Quaternion();
const smooth = THREE.MathUtils.smoothstep;
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
/**
 * `x` eased towards `to` by kk, landing on it once close: a clip at a weight of 1e-6 costs as
 * much to evaluate as one at full weight, and an exponential ease never gets to 0 by itself.
 */
const ease = (x: number, to: number, kk: number) => {
  const y = x + (to - x) * kk;
  return Math.abs(to - y) < 0.004 ? to : y;
};

/** Turn a bone (in world space) so the direction to its child bone becomes `dir`, by amount k. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3, k = 1) {
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(false, false);
  const from = v1.setFromMatrixPosition(child.matrixWorld).sub(v2.setFromMatrixPosition(bone.matrixWorld)).normalize();
  q1.setFromUnitVectors(from, dir);
  if (k < 1) q1.slerp(q2.identity(), 1 - k);
  bone.getWorldQuaternion(q2);
  q2.premultiply(q1);
  bone.parent!.getWorldQuaternion(q1).invert();
  bone.quaternion.copy(q1.multiply(q2));
}

interface Gait {
  name: string;
  action: THREE.AnimationAction;
  /** Ground speed (m/s) at the avatar's own size, and at this person's. */
  v0: number;
  v: number;
  dur: number;
  plant: number;
  /** The blend into this one is a change of gait (walk → jog): kept short, as people switch rather than glide. */
  change: boolean;
}

/** A base's full-body clip, crossfading to another now and then, and its upper-body twin (bases that carry on over walking legs). */
interface Slot {
  def: BaseDef;
  cur: THREE.AnimationAction;
  prev: THREE.AnimationAction | null;
  x: number;
  upper: THREE.AnimationAction | null;
}

/** A one-shot: a play()'d gesture or an idle fidget, over the whole body or the upper body. */
interface Shot {
  action: THREE.AnimationAction;
  t: number;
  dur: number;
  fadeIn: number;
  fadeOut: number;
  w: number;
  kind: 'gesture' | 'fidget' | 'wave';
  upper: boolean;
}

/** One person's model and animation: locomotion blend, idle variety, gestures, poses, dyes, LOD. */
export class PersonRig {
  readonly root = new THREE.Group();
  /** 0…1: both hands in the air (coaster airtime). */
  armsUp = 0;
  /** The LOD0 meshes, for measuring the head, fitting a vest or a hat. */
  readonly parts: { body: THREE.SkinnedMesh; head: THREE.SkinnedMesh; hair: THREE.SkinnedMesh | null; extras: Record<string, THREE.SkinnedMesh> };

  private current: Look;
  private holder = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private meshes: THREE.SkinnedMesh[] = [];
  private lodGroups: THREE.Object3D[] = [];
  private lod = -1;
  private bones = new Map<CanonicalBone, THREE.Object3D>();
  private anchors = new Map<AnchorName, THREE.Object3D>();
  private materials: THREE.MeshStandardMaterial[] = [];
  private outfit: OutfitTint | null = null;
  /** The hair cards' tint (and hat clip), and the head texture's painted hair where the GLB masks it. */
  private cards: HairTint | null = null;
  private hair: HairTint[] = [];
  /** Extras hidden: by the look, and (hats) while a hat is worn. */
  private hiddenByLook = new Set<string>();
  private hatOn = false;
  /** Garments worn over the outfit (Look.wear): one mesh each, for every LOD (they sit beside the LOD groups). */
  private worn: Partial<Record<GarmentKind, THREE.SkinnedMesh>> = {};
  /** The glow uniform all this person's materials (garments too) share: see setGlow. */
  private glow = { value: 0 };
  private castShadows = true;
  private disposed = false;

  private gaits: Gait[] = [];
  private gaitW: number[] = [];
  private gaitWant: number[] = [];
  private phase = Math.random();
  private moveW = 0;
  private slots = new Map<Base, Slot>();
  private baseW = new Map<Base, number>();
  private base: Base = 'stand';
  /** The carry layer's weight (an upper-body-only base). */
  private carryW = 0;
  private carry: THREE.AnimationAction | null = null;
  private shots: Shot[] = [];
  private idleT = 4 + Math.random() * 10;
  private waveT = 0;
  private waveDur = 1;
  private kickT = 0;
  /** Bones the procedural layer turned last frame, and (per bone, reused) the rotation the clips gave them. */
  private aimed = new Set<THREE.Object3D>();
  private clipRot = new Map<THREE.Object3D, THREE.Quaternion>();
  private limbs: Record<'upperarm_l' | 'lowerarm_l' | 'hand_l' | 'upperarm_r' | 'lowerarm_r' | 'hand_r' | 'thigh_r' | 'calf_r' | 'foot_r', THREE.Object3D> | null = null;
  /** How much of the whole body a play()'d gesture takes this frame (fidgets belong to the pose). */
  private overGesture = 0;
  private sitShift = new THREE.Vector3();
  private crouchShift = new THREE.Vector3();
  /** The model's size: the look's height over the avatar's own. */
  private k = 1;

  constructor(
    private t: AvatarTemplate,
    look: Look,
  ) {
    this.current = this.ownLook(look);
    const spec = t.spec;
    this.model = cloneSkinned(t.scene);

    // the LOD nodes (a Group of one SkinnedMesh per material, or the mesh itself); a file without
    // them is all LOD0
    for (let i = 0; i < 4; i++) {
      const g = this.model.getObjectByName(`LOD${i}`);
      if (g) this.lodGroups.push(g);
    }
    if (!this.lodGroups.length) this.lodGroups.push(this.model);
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) this.meshes.push(o as THREE.SkinnedMesh);
    });
    // one skeleton for every LOD and material (the clone gave each mesh its own copy, and each
    // copy would update and upload its bone texture every frame)
    const skeleton = this.meshes[0].skeleton;
    const same = (s: THREE.Skeleton) => s.bones.length === skeleton.bones.length && s.bones.every((b, i) => b === skeleton.bones[i]);
    for (const m of this.meshes) if (m.skeleton !== skeleton && same(m.skeleton)) m.bind(skeleton, m.bindMatrix);

    // per-person materials: dyes, hair tint and glow are this person's own
    const own = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const bodyName = spec.parts.body;
    const hairName = spec.parts.hair;
    for (const m of this.meshes) {
      const src = m.material as THREE.MeshStandardMaterial;
      let mat = own.get(src);
      if (!mat) {
        mat = src.clone();
        own.set(src, mat);
        this.materials.push(mat);
        const hairSkin = { eyes: t.skin.eyes, head: t.skin.head, boneInverses: skeleton.boneInverses, bindMatrix: m.bindMatrix };
        if (src.name === bodyName && t.outfit) this.outfit = tintOutfit(mat, t.outfit.mask, t.outfit.regions);
        else if (src.name === hairName && hairName !== bodyName && canTintHair(spec)) this.hair.push((this.cards = tintHair(mat, spec.hairTone, hairSkin)));
        // the hair painted into the head texture (the scalp under the cards, a crew cut, a beard),
        // where the GLB masks it: tinted with the cards, from the same tone so the two stay as alike
        // as they were (the file's mask is what counts, whatever the manifest says)
        else if (src.name === spec.parts.head && spec.parts.head !== bodyName && t.hairMask && !hairCovered(spec)) {
          const paint = paintedHair(spec);
          this.hair.push(tintHair(mat, spec.hairTone, hairSkin, t.hairMask, { scalp: paint?.scalp?.mean, beard: paint?.beard?.mean }));
        }
      }
      m.material = mat;
    }
    // (after the dye and the hair tint: the glow is the dyed colour)
    for (const mat of this.materials) glowFromWithin(mat, this.glow);
    this.castShadows = this.meshes.some((m) => m.castShadow);

    // the LOD0 parts by material
    const lod0: THREE.SkinnedMesh[] = [];
    this.lodGroups[0].traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) lod0.push(o as THREE.SkinnedMesh);
    });
    const byName = (name: string | undefined) => (name ? lod0.find((m) => (m.material as THREE.Material).name === name) : undefined);
    const body = byName(spec.parts.body) ?? lod0[0];
    const extras: Record<string, THREE.SkinnedMesh> = {};
    for (const [key, name] of Object.entries(spec.parts.extras ?? {})) {
      const m = byName(name);
      if (m) extras[key] = m;
    }
    this.parts = { body, head: byName(spec.parts.head) ?? body, hair: (hairName !== bodyName && byName(hairName)) || null, extras };

    for (const [name, node] of Object.entries(t.rig.bones) as [CanonicalBone, string][]) {
      const b = this.model.getObjectByName(node);
      if (b) this.bones.set(name, b);
    }
    // bones no clip moves (the face) keep their local matrix: skip recomposing it every frame. The
    // ones that move don't keep their Euler `rotation` in step with the quaternion the clips set
    // (a sixth of the animation's cost): turn bones by their quaternion.
    const noEuler = () => undefined;
    for (const b of skeleton.bones)
      if (!t.clips.animated.has(b.name)) {
        b.updateMatrix();
        b.matrixAutoUpdate = false;
      } else b.quaternion._onChange(noEuler);

    this.holder.add(this.model);
    this.holder.rotation.y = Math.PI; // the avatars face +z; the park's convention is -z forward
    this.root.add(this.holder);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.buildGaits();
    this.slotFor('stand');
    this.baseW.set('stand', 1);
    this.applyLook(this.current, true);
    this.showLod(0);
  }

  // ---------------------------------------------------------------------------------- looks

  get look(): Look {
    return this.current;
  }

  get spec(): AvatarSpec {
    return this.t.spec;
  }

  get height() {
    return this.current.height;
  }

  /** Whether this rig was built from the 1024 px hero file. */
  get hero() {
    return this.t.hero;
  }

  /**
   * Wears `look` in place when it's the same avatar (and file): dyes, hair, height, build, hidden
   * parts and garments (put on, recoloured or taken off). False when it needs another model (or this
   * rig was disposed): build a new rig with PeopleFactory.create. A gesture under way carries on.
   */
  applyLook(look: Look, force = false): boolean {
    if (this.disposed || (!force && !sameModel(look, this.current))) return false;
    this.current = this.ownLook(look);
    for (const r of ['top', 'bottom', 'shoes', 'hair'] as const) this.setTint(r, look[r]);
    this.k = look.height / this.t.spec.height;
    this.holder.scale.set(this.k * look.build, this.k, this.k * (0.5 + look.build / 2));
    this.hiddenByLook = new Set(look.hide ?? []);
    this.updateExtras();
    this.dress(look.wear);
    this.measureShifts();
    return true;
  }

  /** The look as worn by this model: a stand-in (see PeopleFactory.create) says what it really is. */
  private ownLook(look: Look): Look {
    const spec = this.t.spec;
    return { ...look, avatar: spec.id, gender: spec.gender, age: spec.age, child: isChild(spec.age), hero: this.t.hero || undefined, wear: look.wear && { ...look.wear } };
  }

  /**
   * Puts on, recolours or takes off the garments `wear` names. Each is fitted to this body in its
   * bind pose (garments.ts: an apron costs 30–80 ms, the first in a colour the most, as it draws its
   * canvas; a scarf 5–10 ms) and skinned to the shared skeleton. Being skinned in attached mode it can sit anywhere
   * under the model: it goes beside the LOD groups, so it's worn at every LOD.
   */
  private dress(wear: Look['wear']) {
    for (const kind of GARMENTS) {
      const colour = wear?.[kind];
      const had = this.worn[kind];
      if (had && colour) recolourGarment(had, colour);
      else if (had) {
        disposeGarment(had);
        delete this.worn[kind];
      } else if (colour) {
        let g: THREE.SkinnedMesh;
        try {
          g = buildGarment(kind, this.parts.body, { colour, spec: this.t.spec });
        } catch (e) {
          // (a body the garments can't measure: the look goes without rather than the game failing)
          warnOnce(`${this.t.spec.id} can't wear the ${kind}: ${(e as Error).message}`);
          continue;
        }
        // its own material (never cloned: the apron's skirt swings in its shader), glowing with the person
        glowFromWithin(g.material as THREE.MeshStandardMaterial, this.glow);
        g.castShadow = this.castShadows;
        this.model.add(g);
        this.worn[kind] = g;
      }
    }
  }

  /** The garment worn (Look.wear), or null: to measure it, or hide it with the person. */
  garment(kind: GarmentKind): THREE.SkinnedMesh | null {
    return this.worn[kind] ?? null;
  }

  /** Dyes one region of the outfit, or tints the hair ('#rrggbb'); null gives it back its own colour. */
  setTint(region: TintRegion, colour: string | null) {
    this.current[region] = colour;
    if (region === 'hair') for (const h of this.hair) h.setTint(colour);
    else this.outfit?.setTint(region, colour);
  }

  /** Whether that region can be dyed on this avatar (the customiser greys out the others). */
  canTint(region: TintRegion) {
    return region === 'hair' ? this.hair.length > 0 : !!this.outfit?.has(region as OutfitRegion);
  }

  /**
   * A hat is worn: hair inside `hat` (an ellipsoid in Head-bone space, metres) is hidden, and so are
   * the avatar's own hats and helmets; null shows them again.
   */
  setHatClip(hat: HatClip | null) {
    // (the cards only: the scalp is under the hat anyway)
    this.cards?.setHatClip(hat);
    this.hatOn = !!hat;
    this.updateExtras();
  }

  /** A hat clip that suits a cap or a sun hat on this avatar's head: the crown down to the brow, the hair below and behind left showing. */
  defaultHatClip(): HatClip {
    const top = this.t.spec.anchors.headTop.at;
    // the head bone runs up the neck: its x axis points to the crown (the anchor is almost straight up it)
    const up = new THREE.Vector3(...top);
    const len = up.length();
    up.normalize();
    // (sized for an adult's head; a child's is smaller, though not in proportion to their height)
    const s = THREE.MathUtils.clamp(Math.sqrt(this.t.spec.height / 1.75), 0.8, 1);
    const c = up.clone().multiplyScalar(len - 0.075 * s);
    return { centre: [c.x, c.y, c.z], radii: [0.105 * s, 0.13 * s, 0.125 * s] };
  }

  /** At night: how brightly hi-vis tape shines back (0 by day … 1). */
  setNight(k: number) {
    this.outfit?.setNight(k);
  }

  private updateExtras() {
    for (const [key, mesh] of Object.entries(this.parts.extras)) {
      const hide = this.hiddenByLook.has(key) || (this.hatOn && /hat|helmet|cap/i.test(key));
      // every LOD's copy of that part
      const name = (mesh.material as THREE.Material).name;
      for (const m of this.meshes) if ((m.material as THREE.Material).name === name) m.visible = !hide;
    }
  }

  // ---------------------------------------------------------------------------------- the old rig's members

  /** A canonical bone (Head, hand_l, pelvis…), for what's worn or held to follow it. */
  bone(name: CanonicalBone): THREE.Object3D {
    const b = this.bones.get(name);
    if (!b) throw new Error(`${this.t.spec.id} has no bone ${name}`);
    return b;
  }

  /** Every skinned mesh, all LODs (the visible LOD's are the ones drawn). */
  get skinnedMeshes(): readonly THREE.SkinnedMesh[] {
    return this.meshes;
  }

  /** World position of one of the avatar's anchors (the top of the head, the back, a shoulder, a palm). */
  anchor(name: AnchorName, out = new THREE.Vector3()) {
    const a = this.t.spec.anchors[name];
    const bone = this.bone(a.bone);
    bone.updateWorldMatrix(true, false);
    return bone.localToWorld(out.set(a.at[0], a.at[1], a.at[2]));
  }

  /** An empty Object3D at the anchor, following its bone: hang a prop on it. */
  anchorObject(name: AnchorName): THREE.Object3D {
    let o = this.anchors.get(name);
    if (!o) {
      const a = this.t.spec.anchors[name];
      o = new THREE.Object3D();
      o.name = `anchor_${name}`;
      o.position.set(a.at[0], a.at[1], a.at[2]);
      this.bone(a.bone).add(o);
      this.anchors.set(name, o);
    }
    return o;
  }

  /** Where the stride is, 0…1 (0 the left heel strike, about 0.5 the right). */
  get stride() {
    return this.phase;
  }

  /** 0 walking … 1 running. */
  get runBlend() {
    let w = 0;
    for (let i = 0; i < this.gaits.length; i++) if (RUNS.includes(this.gaits[i].name)) w += this.gaitW[i];
    return w;
  }

  /**
   * After dark: a faint glow so the person stays readable under the park lights, in their own
   * colours (each surface gives off `k` × GLOW of its dyed colour: dark clothes stay dark, a red top
   * stays red). 0 turns it off.
   */
  setGlow(k: number) {
    this.glow.value = GLOW * Math.max(0, k);
  }

  /** Where the rig's origin goes below a seat surface for the seated pose to sit on it. */
  get seatDrop() {
    return this.t.spec.seatDrop * this.k;
  }

  /**
   * Root space: the point on the seat under the hips in the seated pose (the rig's origin is
   * seatDrop below the seat, the hips behind it). To sit someone on a saddle: root = saddle − this.
   */
  seatPoint(out = new THREE.Vector3()) {
    const old = OLD_SIT_HIPS[this.t.spec.gender];
    return out.set(old.x * this.current.height, this.seatDrop, old.z * this.current.height);
  }

  /** What the person does while standing still. */
  setBase(b: Base) {
    if (b === this.base || this.disposed) return;
    if (!this.slotFor(b)) {
      warnOnce(`${this.t.spec.id} has no clip for the "${b}" pose`);
      b = 'stand';
    }
    this.base = b;
    // a fidget belongs to the pose it started in
    for (const s of this.shots) if (s.kind === 'fidget') s.dur = Math.min(s.dur, s.t + s.fadeOut);
    this.idleT = 5 + Math.random() * 10;
  }

  get pose() {
    return this.base;
  }

  /** Does the avatar have this clip? */
  has(clip: string) {
    return !!this.t.clips.clip(clip);
  }

  clipNames() {
    return this.t.clips.names();
  }

  /**
   * A one-shot clip: 'Interact', 'Roll', 'Punch_Cross', 'Jump_Start'… Arm-only ones (Interact, Offer,
   * Drink…) are played over the legs while walking; the rest take the whole body. Returns its length
   * in seconds (0 if the avatar has no such clip).
   */
  play(name: string, speed = 1, opts: { upper?: boolean } = {}) {
    // (seated, crouched or in the water, a reach or a wave mustn't stand them up)
    if (this.disposed) return 0;
    const upper = opts.upper ?? (UPPER_OK.has(name) && (this.moveW > 0.3 || !!BASES[this.base].planted));
    const clip = upper ? this.t.clips.upper(name) : this.t.clips.clip(name);
    if (!clip) {
      warnOnce(`${this.t.spec.id} has no clip "${name}"`);
      return 0;
    }
    const dur = clip.duration / speed;
    this.shoot(clip, speed, dur, 'gesture', upper, 0.15, 0.18);
    return dur;
  }

  /** A play()'d gesture is running. */
  get busy() {
    return this.shots.some((s) => s.kind === 'gesture' && s.t < s.dur);
  }

  /** Wave with the right hand for a couple of seconds: the real wave standing still, the arm alone on the move. */
  wave(seconds = 2.2) {
    if (this.disposed) return;
    const clip = this.t.clips.upper('Wave');
    if (clip && this.moveW < 0.3 && !BASES[this.base].still) {
      // the clip raises the arm, waves and lowers it: a short wave plays it a little faster, and
      // always to the end (cutting it off mid-wave looks like a glitch)
      const speed = THREE.MathUtils.clamp(clip.duration / Math.max(0.5, seconds), 1, 1.6);
      this.shoot(clip, speed, clip.duration / speed, 'wave', true, 0.3, 0.45);
      return;
    }
    this.waveT = this.waveDur = seconds;
  }

  /** A quick right-footed kick (procedural: the library has no kick). */
  kick() {
    this.kickT = 0.55;
  }

  /** Near: the full model (LOD0). Far: LOD1. setDistance picks among all three by distance. */
  setDetail(near: boolean) {
    this.showLod(near ? 0 : 1);
  }

  /** Picks the LOD by the camera's distance (metres), with a little hysteresis so it doesn't flicker at a boundary. */
  setDistance(d: number) {
    const s = Math.max(0.5, this.current.height / 1.75);
    let lod = 0;
    for (let i = 0; i < LOD_DISTANCES.length; i++) {
      const edge = LOD_DISTANCES[i] * s * (this.lod > i ? 1 - LOD_HYSTERESIS : 1 + LOD_HYSTERESIS);
      if (d > edge) lod = i + 1;
    }
    this.showLod(lod);
  }

  /** The LOD shown now (0 full … 2 coarsest). */
  get detail() {
    return this.lod;
  }

  private showLod(lod: number) {
    lod = Math.min(lod, this.lodGroups.length - 1);
    if (lod === this.lod) return;
    this.lod = lod;
    for (let i = 0; i < this.lodGroups.length; i++) this.lodGroups[i].visible = i === lod;
  }

  /** Whether the person (garments too) casts shadows. */
  setShadows(on: boolean) {
    this.castShadows = on;
    for (const m of this.meshes) m.castShadow = on;
    for (const kind of GARMENTS) {
      const g = this.worn[kind];
      if (g) g.castShadow = on;
    }
  }

  // ---------------------------------------------------------------------------------- animation set-up

  private buildGaits() {
    const c = this.t.clips;
    const has = (n: string) => !!c.clip(n) && !!c.info(n)?.speed;
    const slow = SLOW_WALKS.filter(has);
    const walks = WALKS.filter(has);
    const names = [...(slow.length ? [pick(slow)] : []), ...(walks.length ? [pick(walks)] : []), ...RUNS.filter(has)];
    // speeds scale with leg length: the clips' were for the pack's reference hips
    const legs = this.t.spec.hip / c.refHip;
    const nodes = names.map((name) => {
      const clip = c.clip(name)!;
      const action = this.mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      action.timeScale = 0; // the phase follows the distance walked
      return { name, action, v0: c.info(name)!.speed! * legs, dur: clip.duration, plant: c.plant(name), change: RUNS.includes(name) };
    });
    nodes.sort((a, b) => a.v0 - b.v0);
    this.gaits = nodes.map((n) => ({ ...n, v: n.v0 * this.k }));
    this.gaitW = this.gaits.map((_, i) => (i === Math.min(1, this.gaits.length - 1) ? 1 : 0));
    this.gaitWant = this.gaits.map(() => 0);
  }

  /** The base's actions, made the first time it's used. Null when the avatar has none of its clips. */
  private slotFor(b: Base): Slot | null {
    const had = this.slots.get(b);
    if (had) return had;
    const def = BASES[b];
    const names = def.clips.filter((n) => this.t.clips.clip(n));
    if (!names.length) return null;
    if (def.upper === 'always') {
      // an upper-body-only base: the legs do what standing or walking does
      if (!this.carry) {
        this.carry = this.mixer.clipAction(this.t.clips.upper(names[0])!);
        this.carry.play().setEffectiveWeight(0);
      }
      const slot: Slot = { def, cur: this.carry, prev: null, x: 1, upper: null };
      this.slots.set(b, slot);
      return slot;
    }
    const cur = this.loop(pick(names));
    let upper: THREE.AnimationAction | null = null;
    if (def.upper === 'moving') {
      upper = this.mixer.clipAction(this.t.clips.upper(names[0])!);
      upper.play().setEffectiveWeight(0);
    }
    const slot: Slot = { def, cur, prev: null, x: 1, upper };
    this.slots.set(b, slot);
    if (!this.baseW.has(b)) this.baseW.set(b, 0);
    return slot;
  }

  /** A looping action at a random point of its loop (nobody breathes in sync). */
  private loop(name: string) {
    const a = this.mixer.clipAction(this.t.clips.clip(name)!);
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.play();
    a.setEffectiveWeight(0);
    a.time = Math.random() * a.getClip().duration;
    return a;
  }

  private shoot(clip: THREE.AnimationClip, speed: number, dur: number, kind: Shot['kind'], upper: boolean, fadeIn: number, fadeOut: number) {
    const action = this.mixer.clipAction(clip);
    // whatever was playing on that layer makes way (a whole-body one-shot stops them all)
    for (const s of this.shots)
      if (s.upper === upper || !upper) {
        s.dur = Math.min(s.dur, s.t + 0.15);
        s.fadeOut = Math.min(s.fadeOut, 0.15);
      }
    this.shots = this.shots.filter((s) => s.action !== action);
    action.reset().setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(speed).setEffectiveWeight(0).play();
    action.clampWhenFinished = true;
    this.shots.push({ action, t: 0, dur, fadeIn, fadeOut, w: 0, kind, upper });
  }

  /** Where the hips go in the seated and crouched poses: shifted so they land where the old rig's did. */
  private measureShifts() {
    const s = this.holder.scale;
    const h = this.current.height;
    // model space → root space: the holder turns the model round (x, z negated) and scales it
    const sit = this.t.clips.sitHips;
    const g = this.t.spec.gender;
    this.sitShift.set(OLD_SIT_HIPS[g].x * h + sit.x * s.x, 0, OLD_SIT_HIPS[g].z * h + sit.z * s.z);
    const crouch = this.t.clips.crouchHips;
    if (crouch) this.crouchShift.set(OLD_CROUCH_HIPS[g].x * h + crouch.x * s.x, 0, OLD_CROUCH_HIPS[g].z * h + crouch.z * s.z);
  }

  // ---------------------------------------------------------------------------------- every frame

  /** Advance the animation. `speed` is ground speed (m/s). */
  update(dt: number, speed: number) {
    // (a consumer may hold on to a person it has disposed for a frame: nothing's left to move)
    if (this.disposed) return;
    // the clips only write a bone when its value changes: put back what the procedural layer bent
    for (const bone of this.aimed) bone.quaternion.copy(this.clipRot.get(bone)!);
    this.aimed.clear();

    const kk = 1 - Math.exp(-dt * 8);
    const def = BASES[this.base];
    this.locomotion(dt, def.still ? 0 : speed, kk);
    // setting off ends a fidget there and then (it takes the whole body: the legs would stay put)
    if (speed > 0.05 && !def.still)
      for (const s of this.shots)
        if (s.kind === 'fidget' && s.dur > s.t + 0.25 * s.w) {
          // (fading from the weight it has now, so it never jumps)
          s.fadeOut = 0.25;
          s.dur = s.t + 0.25 * s.w;
        }
    const over = this.updateShots(dt);
    this.idle(dt);

    // the legs: every gait at the shared stride phase, counted from its own left heel strike
    for (let i = 0; i < this.gaits.length; i++) {
      const g = this.gaits[i];
      g.action.time = ((this.phase + g.plant) % 1) * g.dur;
      g.action.setEffectiveWeight(this.gaitW[i] * this.moveW * (1 - over));
    }

    // the bases: the one chosen fades in, the others out; their clips share what standing still leaves
    const still = (1 - this.moveW) * (1 - over);
    const target = def.upper === 'always' ? 'stand' : this.base;
    let layers = 1;
    for (const [b, slot] of this.slots) {
      const w0 = this.baseW.get(b) ?? 0;
      const w = ease(w0, b === target ? 1 : 0, kk);
      this.baseW.set(b, w);
      if (slot.def.upper === 'always') continue;
      slot.x = Math.min(1, slot.x + dt / 1.5);
      slot.cur.setEffectiveWeight(w * still * slot.x);
      if (slot.prev) {
        slot.prev.setEffectiveWeight(w * still * (1 - slot.x));
        if (slot.x >= 1) slot.prev.stop(), (slot.prev = null);
      }
      if (slot.upper) {
        // texting, on the phone, a bag in hand: the arms carry on over walking legs
        slot.upper.time = slot.cur.time;
        const f = Math.min(0.97, w * this.moveW * (1 - over));
        const wu = (f / (1 - f)) * layers;
        slot.upper.setEffectiveWeight(wu);
        layers += wu;
      }
    }
    if (this.carry) {
      // carrying: the arms hold the box, standing or walking (in step with the stride)
      this.carryW = ease(this.carryW, this.base === 'carry' ? 1 : 0, kk);
      this.carry.timeScale = 0;
      if (this.moveW > 0.05) this.carry.time = ((this.phase + this.t.clips.plant('Walk_Carry_Loop')) % 1) * this.carry.getClip().duration;
      const f = Math.min(0.97, this.carryW * (1 - over));
      const wu = (f / (1 - f)) * layers;
      this.carry.setEffectiveWeight(wu);
      layers += wu;
    }
    // the upper-body one-shots go on top of everything (a wave over the idle, a reach while walking)
    for (const s of this.shots) {
      if (!s.upper) continue;
      const f = Math.min(0.98, s.w);
      const wu = (f / (1 - f)) * layers;
      s.action.setEffectiveWeight(wu);
      layers += wu;
    }
    if (this.base === 'swim') {
      // stroke faster the faster they swim (the clip is a calm crawl)
      const slot = this.slots.get('swim');
      if (slot) slot.cur.timeScale = THREE.MathUtils.clamp(0.6 + speed * 0.5, 0.6, 1.6);
    }

    this.mixer.update(dt);

    // seated or crouched, the hips go where the old rig put them
    // (a seated fidget is seated too: only a gesture over the whole body takes them out of the seat)
    const seated = (1 - this.moveW) * (1 - this.overGesture);
    const sit = (this.baseW.get('sit') ?? 0) * seated;
    const crouch = (this.baseW.get('crouch') ?? 0) * seated;
    this.holder.position.set(this.sitShift.x * sit + this.crouchShift.x * crouch, 0, this.sitShift.z * sit + this.crouchShift.z * crouch);
    this.procedural(dt);
  }

  /** Walk, jog, run or sprint by speed, on one stride phase advanced by distance. */
  private locomotion(dt: number, speed: number, kk: number) {
    const g = this.gaits;
    const n = g.length;
    if (!n) {
      this.moveW = 0;
      return;
    }
    for (const x of g) x.v = x.v0 * this.k;
    const want = this.gaitWant;
    want.fill(0);
    if (speed <= g[0].v) want[0] = 1;
    else if (speed >= g[n - 1].v) want[n - 1] = 1;
    else
      for (let i = 0; i < n - 1; i++) {
        if (speed >= g[i + 1].v) continue;
        // between two paces the nearer gait carries on with a longer or shorter stride, and they
        // blend over the middle stretch only (as people do; and one clip costs half of two)
        const t = (speed - g[i].v) / (g[i + 1].v - g[i].v);
        const b = g[i + 1].change ? smooth(t, 0.45, 0.8) : smooth(t, 0.3, 0.7);
        want[i] = 1 - b;
        want[i + 1] = b;
        break;
      }
    let rate = 0;
    for (let i = 0; i < n; i++) {
      this.gaitW[i] = ease(this.gaitW[i], want[i], kk);
      rate += (this.gaitW[i] * (speed / g[i].v)) / g[i].dur;
    }
    this.phase = (this.phase + rate * dt) % 1;
    this.moveW = ease(this.moveW, Math.min(1, speed / (g[0].v * 0.5)), kk);
  }

  /** The one-shots' weights (fading in and out) and how much of the whole body they take. */
  private updateShots(dt: number) {
    let over = 0;
    this.overGesture = 0;
    for (const s of this.shots) {
      s.t += dt;
      const w = Math.max(0, Math.min(1, s.fadeIn > 0 ? s.t / s.fadeIn : 1, s.fadeOut > 0 ? (s.dur - s.t) / s.fadeOut : 1));
      s.w = w;
      if (!s.upper) {
        s.action.setEffectiveWeight(w);
        over = Math.max(over, w);
        if (s.kind !== 'fidget') this.overGesture = Math.max(this.overGesture, w);
      }
    }
    for (const s of this.shots) if (s.t >= s.dur) s.action.stop();
    this.shots = this.shots.filter((s) => s.t < s.dur);
    // two full-body shots crossfading: their weights share what they take
    return Math.min(1, over);
  }

  /**
   * Standing (or sitting, talking, listening) a while: now and then a small fidget, or a slow change
   * to another of the pose's loops. Never during a gesture, a wave or a walk.
   */
  private idle(dt: number) {
    const def = BASES[this.base];
    if (!def.fidgets && !def.switches) return;
    if (this.moveW > 0.05 || this.shots.length || this.waveT > 0 || this.armsUp > 0.01 || this.kickT > 0 || (this.baseW.get(this.base) ?? 0) < 0.95) return;
    this.idleT -= dt;
    if (this.idleT > 0) return;
    this.idleT = 7 + Math.random() * 12;
    const slot = this.slots.get(this.base);
    if (!slot) return;
    const switchTo = def.switches ? def.clips.filter((n) => n !== slot.cur.getClip().name && this.t.clips.clip(n)) : [];
    const fidgets = (def.fidgets ?? []).filter((n) => this.t.clips.clip(n));
    if (this.base === 'stand' && Math.random() < 0.12) fidgets.push(...RARE_FIDGETS.filter((n) => this.t.clips.clip(n)));
    if (fidgets.length && (!switchTo.length || Math.random() < 0.55)) {
      const clip = this.t.clips.clip(pick(fidgets))!;
      this.shoot(clip, 1, clip.duration, 'fidget', false, 0.6, 0.7);
    } else if (switchTo.length && !slot.prev) {
      slot.prev = slot.cur;
      slot.cur = this.loop(pick(switchTo));
      slot.x = 0;
    }
  }

  /** Poses the clips don't have, layered on top: hands up, waving on the move, kicking. */
  private procedural(dt: number) {
    const needed = this.armsUp > 0.01 || this.waveT > 0 || this.kickT > 0;
    if (!needed) return;
    // (the limbs are looked up once: this runs every frame for a coaster train of riders with their hands up)
    const L = (this.limbs ??= {
      upperarm_l: this.bone('upperarm_l'), lowerarm_l: this.bone('lowerarm_l'), hand_l: this.bone('hand_l'),
      upperarm_r: this.bone('upperarm_r'), lowerarm_r: this.bone('lowerarm_r'), hand_r: this.bone('hand_r'),
      thigh_r: this.bone('thigh_r'), calf_r: this.bone('calf_r'), foot_r: this.bone('foot_r'),
    });
    this.root.updateWorldMatrix(true, false);
    const rq = this.root.getWorldQuaternion(q3);
    const dir = (x: number, y: number, z: number) => v3.set(x, y, z).normalize().applyQuaternion(rq);
    // the person's left is -x in their own frame
    if (this.armsUp > 0.01) {
      this.keep(L.upperarm_l), this.keep(L.lowerarm_l);
      aim(L.upperarm_l, L.lowerarm_l, dir(-0.35, 1, -0.1), this.armsUp);
      aim(L.lowerarm_l, L.hand_l, dir(-0.2, 1, -0.05), this.armsUp);
      this.keep(L.upperarm_r), this.keep(L.lowerarm_r);
      aim(L.upperarm_r, L.lowerarm_r, dir(0.35, 1, -0.1), this.armsUp);
      aim(L.lowerarm_r, L.hand_r, dir(0.2, 1, -0.05), this.armsUp);
    }
    if (this.waveT > 0) {
      this.waveT -= dt;
      // raise the arm over a quarter second, lower it again at the end
      const k = THREE.MathUtils.clamp(Math.min(this.waveT, this.waveDur - this.waveT) * 4, 0, 1);
      const sway = Math.sin(this.waveT * 14) * 0.45;
      this.keep(L.upperarm_r), this.keep(L.lowerarm_r);
      aim(L.upperarm_r, L.lowerarm_r, dir(0.8, 0.55, -0.1), k);
      aim(L.lowerarm_r, L.hand_r, dir(0.25 + sway, 1, 0), k);
    }
    if (this.kickT > 0) {
      this.kickT -= dt;
      const p = 1 - this.kickT / 0.55; // 0 → 1
      const swing = Math.sin(Math.min(1, p) * Math.PI); // wind-up and follow-through
      const fwd = p < 0.3 ? -0.6 : 1;
      this.keep(L.thigh_r), this.keep(L.calf_r);
      aim(L.thigh_r, L.calf_r, dir(0.05, -1 + swing * 0.9, -fwd * swing), Math.min(1, swing * 1.4));
      aim(L.calf_r, L.foot_r, dir(0, -1 + swing * 1.1, -swing * 1.3), Math.min(1, swing * 1.4));
    }
  }

  /** Notes the rotation the clips gave a bone, before the procedural layer turns it (see update). */
  private keep(bone: THREE.Object3D) {
    if (this.aimed.has(bone)) return;
    let q = this.clipRot.get(bone);
    if (!q) this.clipRot.set(bone, (q = new THREE.Quaternion()));
    q.copy(bone.quaternion);
    this.aimed.add(bone);
  }

  /** Frees the person (at any moment, mid-gesture included); calling it again does nothing, and so does every later update(). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.shots.length = 0;
    this.root.removeFromParent();
    for (const kind of GARMENTS) {
      const g = this.worn[kind];
      if (g) disposeGarment(g);
    }
    this.worn = {};
    for (const m of this.materials) m.dispose();
    // each person's skeleton keeps its bone matrices in a texture of its own on the GPU
    for (const s of new Set(this.meshes.map((m) => m.skeleton))) s.dispose();
  }
}
