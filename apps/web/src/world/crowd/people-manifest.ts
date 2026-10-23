// The people's asset manifest: what scripts/people/ builds into public/models/people/manifest.json,
// and what PeopleFactory reads to know which avatars exist, which skeleton each uses, where its
// bones and anchors are, which clips it can play and how to recolour its outfit. Avatars come from
// the Microsoft Rocketbox library (MIT) and, for small children and older women, from MakeHuman
// (CC0); see the manifest's `sources`.

/**
 * The bone names the game speaks (the UE-mannequin names the old rig used). Each rig maps them to
 * its own node names, as GLTFLoader leaves them (spaces become underscores: `Bip01_L_Hand`).
 */
export type CanonicalBone =
  | 'pelvis' | 'spine_01' | 'spine_02' | 'spine_03' | 'neck_01' | 'Head'
  | 'clavicle_l' | 'upperarm_l' | 'lowerarm_l' | 'hand_l' | 'middle_01_l'
  | 'clavicle_r' | 'upperarm_r' | 'lowerarm_r' | 'hand_r' | 'middle_01_r'
  | 'thigh_l' | 'calf_l' | 'foot_l' | 'ball_l'
  | 'thigh_r' | 'calf_r' | 'foot_r' | 'ball_r'
  | 'eye_l' | 'eye_r';

export interface RigSpec {
  /** Canonical name → this rig's node name. */
  bones: Partial<Record<CanonicalBone, string>>;
  /** The node whose position track carries hip height in this rig's clips (Rocketbox: `Bip01`). */
  root: string;
}

export interface ClipInfo {
  /**
   * The game's name for it. Clips that stand in for the old library keep its names (`Idle_Loop`,
   * `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`, `Sitting_Idle_Loop`, `Idle_Talking_Loop`,
   * `Crouch_Idle_Loop`, `Dance_Loop`, `Interact`, `Roll`, `Punch_Cross`, `Jump_Start`, `Jump_Loop`,
   * `Jump_Land`, `Sitting_Enter`, `Sitting_Exit`); new ones get plain descriptive names
   * (`Wave`, `Cheer`, `Clap`, `Take_Photo`, `Phone_Text`, `Talk_2`…).
   */
  name: string;
  /** Seconds. */
  duration: number;
  loop: boolean;
  /** Locomotion only: ground speed (m/s) it was captured at, for an avatar `refHeight` tall. Root travel is removed from the track. */
  speed?: number;
  /**
   * Set when the pack keeps all its clips on one timeline, as a single glTF animation named
   * 'clips' (one animation per clip would cost ~0.7 MB of glTF JSON a pack): the clip's start
   * there, in whole seconds. Every track has keys at exactly `start` and `start + duration`, so
   * cut each one out with `track.clone().trim(start - 0.01, start + duration + 0.01).shift(-start)`
   * (clips are at least 0.5 s apart). Absent: the clip is its own glTF animation, named `name`.
   */
  start?: number;
}

/** A GLB of animations only, all on one rig. */
export interface ClipPack {
  /** Relative to models/people/. */
  file: string;
  rig: string;
  /** Who it was captured on (or retargeted to): clips for 'any' suit both. */
  gender: 'm' | 'f' | 'any';
  /** The skeleton height and hip height the clips were made for (metres), to scale hip motion to other bodies. */
  refHeight: number;
  refHip: number;
  clips: ClipInfo[];
  bytes: number;
}

export type AgeGroup = 'toddler' | 'child' | 'adult' | 'older';
export type Role = 'guest' | 'playable' | 'vendor' | 'pilot' | 'cabin' | 'ground' | 'mechanic' | 'security' | 'swim' | 'beach' | 'staff';
export type OutfitRegion = 'top' | 'bottom' | 'shoes' | 'trim';
/** A point in a bone's local space (metres). */
export interface Anchor {
  bone: CanonicalBone;
  at: [number, number, number];
}

export interface AvatarSpec {
  /** The source's own name, e.g. `Male_Adult_01`, `MH_Toddler_01`. */
  id: string;
  source: 'rocketbox' | 'makehuman';
  /** Key into PeopleManifest.rigs. */
  rig: string;
  gender: 'm' | 'f';
  age: AgeGroup;
  /** 1 lightest … 5 deepest. */
  skin: 1 | 2 | 3 | 4 | 5;
  roles: Role[];
  /** Free-form traits for choosing and dressing: 'longHair', 'hat', 'helmet', 'barefoot', 'shorts', 'skirt', 'glasses', 'beard', 'headscarf'… */
  tags: string[];
  /**
   * GLBs relative to models/people/. `crowd`: 512 px textures and LOD meshes named `LOD0`, `LOD1`…
   * on one skin; `hero`: 1024 px textures, `LOD0` only (the visitor, Rosa, close-ups).
   */
  files: { crowd?: string; hero?: string };
  bytes: { crowd?: number; hero?: number };
  lods: number;
  /** Measured in the bind pose (metres). */
  height: number;
  hip: number;
  /** How far the rig's origin sits below a seat surface in the seated idle (metres). */
  seatDrop: number;
  anchors: { headTop: Anchor; back: Anchor; shoulderL: Anchor; palmL: Anchor; palmR: Anchor };
  /** The primitives' material names: body, head, hair cards (if any), and extras such as a hat or a helmet that can be hidden. */
  parts: { body: string; head: string; hair?: string; extras?: Record<string, string> };
  /**
   * Recolouring: the GLB carries a texture named `outfitMask` in the body's UV space (R top, G
   * bottom, B shoes, A trim). For each region present: its mean linear luminance in the body
   * texture (the tint keeps the fabric's detail relative to it) and its own colour as '#rrggbb'.
   */
  outfit?: { regions: Partial<Record<OutfitRegion, { mean: number; colour: string }>> };
  /**
   * The hair's tone in the `parts.hair` material's texture (the hair cards only, not lashes or
   * brows): mean linear luminance and colour, for tinting it the way the outfit is tinted. An
   * avatar without cards has the painted scalp's tone here, or else its beard's.
   */
  hairTone?: {
    mean: number;
    colour: string;
    /**
     * The scalp's hair painted into the head texture (a crew cut, the scalp under the cards), where
     * the GLB masks it: a texture named `hairMask` on the head material (R channel; a lossless PNG
     * in the occlusion slot at strength 0, in the colour texture's UVs, 256 px in crowd files and
     * 512 in hero files). Its own mean linear luminance and colour, as for the cards. Missing where
     * the paint isn't masked: covered or bald heads, and thin grey hair that a dye would blotch.
     */
    scalp?: { mean: number; colour: string };
    /**
     * The beard or moustache painted into the head texture, masked by `hairMask`'s G channel: its
     * tone. Missing for stubble and for white or grey beards (as bright as the skin between their
     * hairs, so their mask would come out in patches).
     */
    beard?: { mean: number; colour: string };
  };
  /** A small portrait for the customiser (webp, relative to models/people/). */
  portrait?: string;
}

export interface PeopleManifest {
  version: 1;
  sources: { id: string; name: string; licence: string; url: string; commit?: string }[];
  rigs: Record<string, RigSpec>;
  clipPacks: Record<string, ClipPack>;
  avatars: AvatarSpec[];
  /** Avatars loaded together, by name: 'park' (the fair's crowd), 'airport', 'island'. Playable avatars load one at a time. */
  sets: Record<string, string[]>;
}

/**
 * The visitor's own look, made in the customiser: saved in the browser for guests and on the
 * account for members (the server keeps it as JSON and checks it with the same limits).
 */
export interface VisitorLook {
  v: 1;
  /** A playable AvatarSpec.id. */
  avatar: string;
  /** '#rrggbb' to recolour that part of the outfit, or null for its own colour. */
  top: string | null;
  bottom: string | null;
  shoes: string | null;
  /** '#rrggbb' hair tint, or null for the avatar's own. */
  hair: string | null;
  /** Scale on the avatar's own height. */
  height: number;
  /** Scale on its width. */
  build: number;
}

export const VISITOR_LOOK_LIMITS = { height: [0.92, 1.08], build: [0.94, 1.06], avatarId: /^[A-Za-z0-9_]{1,48}$/, colour: /^#[0-9a-f]{6}$/ } as const;
