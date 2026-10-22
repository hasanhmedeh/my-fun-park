// What a person looks like: which avatar (a real clothed person from the people manifest, see
// people-manifest.ts), how tall and broad, and how their clothes and hair are dyed. A Look is plain
// data: the PeopleFactory (people-factory.ts) builds a PersonRig from it, and the same look always
// builds the same person. Colours are '#rrggbb' strings, or null for the avatar's own.
//
// The palettes here dress a crowd of a few dozen avatars so it doesn't read as clones: everyday
// clothes in believable colours (no neon outside sportswear and hi-vis), denims and chinos for
// bottoms, natural hair colours. Traditional and religious dress keeps to its own sober palettes.

import type { AgeGroup, AvatarSpec, OutfitRegion, VisitorLook } from './people-manifest';

export type Gender = 'm' | 'f';

export interface Look {
  /** AvatarSpec.id. */
  avatar: string;
  gender: Gender;
  age: AgeGroup;
  /** The avatar is a toddler or a child. */
  child: boolean;
  /** Standing height in metres (the avatar's own height times a scale). */
  height: number;
  /** Width multiplier, about 0.94–1.06. */
  build: number;
  /** '#rrggbb' dye for that outfit region, or null for its own colour. */
  top: string | null;
  bottom: string | null;
  shoes: string | null;
  /** Hair tint, or null for the avatar's own hair. */
  hair: string | null;
  /** Use the 1024 px hero file (the visitor, Rosa) rather than the crowd's 512 px one. */
  hero?: boolean;
  /** Keys of AvatarSpec.parts.extras to hide (a built-in cap under a bought hat, say). */
  hide?: string[];
  /** Garments worn over the outfit, each in a colour (garments.ts builds them). */
  wear?: { apron?: string; scarf?: string };
}

export const isChild = (age: AgeGroup) => age === 'toddler' || age === 'child';

/** The look of a visitor made in the customiser, on the avatar `spec` it names. */
export function lookFromVisitor(v: VisitorLook, spec: AvatarSpec): Look {
  return {
    avatar: spec.id,
    gender: spec.gender,
    age: spec.age,
    child: isChild(spec.age),
    height: spec.height * v.height,
    build: v.build,
    top: v.top,
    bottom: v.bottom,
    shoes: v.shoes,
    hair: v.hair,
    hero: true,
  };
}

/** A short string that changes whenever anything visible about the look changes. */
export function lookKey(l: Look): string {
  const hide = l.hide?.length ? [...l.hide].sort().join('+') : '';
  return [l.avatar, l.hero ? 'h' : '', l.height.toFixed(3), l.build.toFixed(3), l.top, l.bottom, l.shoes, l.hair, hide, l.wear?.apron ?? '', l.wear?.scarf ?? ''].join('|');
}

/** Whether two looks build the same model (only dyes, hair, size and hidden parts differ): see PersonRig.applyLook. */
export const sameModel = (a: Look, b: Look) => a.avatar === b.avatar && !!a.hero === !!b.hero;

// ------------------------------------------------------------------------------------ palettes

const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.min(a.length - 1, Math.floor(r() * a.length))];

/** Everyday tops: whites, greys and darks, denim and sky blues, earthy and muted colours, a few brights. */
export const TOPS = [
  '#f4f2ed', '#e9e2d0', '#c9c6bf', '#8d8f93', '#3b3d42', '#16171b', '#1f2a44', '#2f4d7a', '#5b7fa8', '#9cc0dd',
  '#6d1f2b', '#b3262e', '#d9644a', '#c97b2f', '#d9b13b', '#2f5233', '#6b7a3a', '#3f8a7a', '#7aa58c', '#e3a5b5',
  '#9d6fa6', '#5a3f6e', '#b89a7a', '#7a5638', '#ffffff', '#2e6f9e',
];
/** Bottoms: denim (raw to light wash), black, greys, khaki, beige, navy, a brown. */
export const BOTTOMS = ['#1c2333', '#2b3a55', '#3d5577', '#6f8fb3', '#15161a', '#3a3c41', '#6e7075', '#b5a27e', '#d6c7a6', '#1f2740', '#5b4433'];
export const SHOES = ['#f2f2f0', '#f2f2f0', '#151515', '#151515', '#5a3a24', '#8a8d93', '#1f2740', '#b08a5e'];
/** Suits and jackets worn as suits: the sober cloths. */
const SUITS = ['#1b1c22', '#23293a', '#1f2740', '#3a3c41', '#55575c', '#3b2f28', '#2a3328'];
/** A thobe or a kandura: whites, creams, a light grey, sand. */
const THOBES = ['#f4f2ec', '#ece6d8', '#d9d4c7', '#c9bfa8'];
/** An abaya or a burqa: black, ink navy, dark brown, charcoal. */
const DARK_ROBES = ['#141414', '#1d2230', '#2b2522', '#3a3540'];
/** Long dresses worn with a headscarf: muted colours. */
const MODEST = ['#6b7a3a', '#c9b48a', '#1f2a44', '#6d1f2b', '#6e7075', '#5b4433', '#b98b94', '#3f5f6a', '#e9e2d0'];

/** On holiday: brighter tees and vests, sand and denim shorts. */
export const HOLIDAY_TOPS = ['#ffffff', '#f6e7c8', '#ff8a65', '#4fc3f7', '#ffd54f', '#f48fb1', '#81c784', '#ba68c8', '#4db6ac', '#ff7043', '#90caf9', '#e1f5fe'];
export const HOLIDAY_BOTTOMS = ['#e8dcc4', '#c9b48a', '#3d5c8e', '#4f6f9e', '#f4f1ea', '#7aa6c2', '#556b2f', '#d97a5b'];
/** Swimsuits and swim shorts. */
export const SWIM = ['#e53950', '#1e88e5', '#ffb300', '#00acc1', '#8e24aa', '#43a047', '#f06292', '#ff7043', '#263238', '#fdd835'];

/** Natural hair colours, darkest first: black, browns, dark auburn, chestnut, blondes, auburn, ginger; and greys for older people. */
export const HAIRS = ['#16110e', '#2a1c14', '#33221a', '#4a2216', '#4a3020', '#5a3a26', '#6b4a2e', '#7a3b1e', '#8c6a42', '#a07a4a', '#a2502a', '#b88a5a', '#cfae74'];
export const GREY_HAIRS = ['#8c8a86', '#b9b6b0', '#dedbd5'];

/** Linear luminance of '#rrggbb'. */
function luminance(hex: string) {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
}

/** Mean linear luminance and colour ('#rrggbb') of some hair, as AvatarSpec.hairTone has the cards'. */
export interface HairToneOf {
  mean: number;
  colour: string;
}

/**
 * The hair painted into the head texture, where the GLB masks it (a 'hairMask' on the head material,
 * from scripts/people/hair-mask.mjs: R the scalp's hair, G facial hair) and the manifest gives each
 * part's tone, as `hairTone.scalp` and `hairTone.beard`. Null when the head has no such hair (or it
 * isn't masked): then only the cards can be tinted.
 */
export function paintedHair(spec: AvatarSpec): { scalp: HairToneOf | null; beard: HairToneOf | null } | null {
  const t = spec.hairTone as { scalp?: unknown; beard?: unknown } | undefined;
  const tone = (x: unknown) => (x && typeof x === 'object' && typeof (x as HairToneOf).mean === 'number' ? (x as HairToneOf) : null);
  const scalp = tone(t?.scalp);
  const beard = tone(t?.beard);
  return scalp || beard ? { scalp, beard } : null;
}

/**
 * The hair colours that look real on this avatar (none if its hair can't be tinted). Where the hair
 * painted into the head texture is masked (paintedHair) it tints with the cards, and any natural
 * colour reads as one head of hair. Where it isn't, only the cards change over the painted scalp,
 * so only shades near the hair's own do: the natural colours from 0.45 to 2.2 times its luminance
 * (dark hair: black to brown; blonde: light brown to blonde and auburn; grey: the greys).
 */
export function hairShades(spec: AvatarSpec): string[] {
  if (!canTintHair(spec)) return [];
  const grey = spec.tags.includes('greyHair') || spec.age === 'older';
  const all = grey ? GREY_HAIRS : HAIRS;
  if (paintedHair(spec)) return [...all];
  const own = spec.hairTone?.mean ?? 0.045;
  const near = all.filter((c) => {
    const k = luminance(c) / own;
    return k > 0.45 && k < 2.2;
  });
  return near;
}

/** Funfair Air: the fair's ink navy (cabin crew's suits, a believable dark one) and its gold (their scarf). */
export const AIRLINE = { suit: '#1f1c36', gold: '#ffc23d', shoes: '#141414' };

/** Far stand-ins' skin by AvatarSpec.skin (1 lightest … 5 deepest), as seen in daylight. */
const SKIN_TONES = ['#f0d2bd', '#dfb597', '#c08f6c', '#8f5f3f', '#5c3b28'];
export const skinTone = (skin: AvatarSpec['skin']) => SKIN_TONES[Math.min(4, Math.max(0, skin - 1))];

/** Covered hair (the hair material holds the cloth's fringe, not hair): never tinted. */
const COVERED = /^(headscarf|keffiyeh|burqa|veil|hood|helmet)$/;
export const hairCovered = (spec: AvatarSpec) => spec.tags.some((t) => COVERED.test(t));

/**
 * Can this avatar's hair be tinted: it has hair cards that aren't a headscarf's fringe, or hair
 * painted into the head texture that its GLB masks (a crew cut, a beard: paintedHair).
 */
export const canTintHair = (spec: AvatarSpec) => !hairCovered(spec) && (!!paintedHair(spec) || (!!spec.parts.hair && !spec.tags.includes('bald')));

/** The avatar's hair colour as it comes, for a far stand-in. */
export function ownHair(spec: AvatarSpec, skin: string): string {
  if (spec.hairTone?.colour) return spec.hairTone.colour;
  const painted = paintedHair(spec);
  if (painted?.scalp) return painted.scalp.colour;
  if (spec.tags.includes('bald')) return skin;
  if (spec.tags.includes('greyHair')) return '#9b9893';
  if (spec.tags.includes('blonde')) return '#c8a46a';
  return '#2f2117';
}

/** A region's own colour (or a sensible guess for a far stand-in when the outfit has no such region). */
export function ownColour(spec: AvatarSpec, region: OutfitRegion): string {
  const c = spec.outfit?.regions[region]?.colour;
  if (c) return c;
  if (region === 'bottom') return spec.outfit?.regions.top?.colour ?? '#2b3a55';
  if (region === 'shoes') return spec.tags.includes('barefoot') ? skinTone(spec.skin) : '#2a2622';
  return '#8d8f93';
}

/** Which dye palettes suit this avatar's clothes (null: leave that region as it is). */
function palettes(spec: AvatarSpec, holiday: boolean): { top: readonly string[] | null; bottom: readonly string[] | null } {
  const t = new Set(spec.tags);
  if (t.has('uniform') || t.has('hiVis') || t.has('overalls') || t.has('labCoat') || t.has('sportsKit') || t.has('swimwear')) return { top: null, bottom: null };
  if (t.has('thobe') || t.has('traditional')) return { top: THOBES, bottom: null };
  if (t.has('abaya') || t.has('burqa')) return { top: DARK_ROBES, bottom: null };
  if (t.has('headscarf')) return { top: MODEST, bottom: MODEST };
  if (t.has('suit')) return { top: SUITS, bottom: SUITS };
  return holiday ? { top: HOLIDAY_TOPS, bottom: HOLIDAY_BOTTOMS } : { top: TOPS, bottom: BOTTOMS };
}

/**
 * Recolours a look in place: with chance `dye`, its top and/or bottom from the palettes that suit
 * the avatar (a suit stays one cloth; top and bottom never come out the same otherwise), sometimes
 * the shoes, and sometimes the hair (natural colours; greys for older people).
 */
export function dyeLook(look: Look, spec: AvatarSpec, r: () => number, dye = 0.55, holiday = false) {
  const regions = spec.outfit?.regions ?? {};
  const p = palettes(spec, holiday);
  if (r() < dye) {
    const roll = r();
    const top = roll < 0.8 && p.top && regions.top ? pick(r, p.top) : null;
    let bottom = (roll >= 0.5 || !top) && p.bottom && regions.bottom ? pick(r, p.bottom) : null;
    if (spec.tags.includes('suit') && top && regions.bottom) bottom = top;
    else if (bottom && bottom === top) bottom = pick(r, p.bottom!.filter((c) => c !== top));
    look.top = top;
    look.bottom = bottom;
    if (regions.shoes && p.top && r() < 0.15) look.shoes = pick(r, SHOES);
  }
  const shades = r() < 0.3 ? hairShades(spec) : [];
  if (shades.length) look.hair = pick(r, shades);
  return look;
}

/** A look on `spec` in its own colours, at its own size times (height, build). */
export function plainLook(spec: AvatarSpec, height = 1, build = 1, hero = false): Look {
  return {
    avatar: spec.id,
    gender: spec.gender,
    age: spec.age,
    child: isChild(spec.age),
    height: spec.height * height,
    build,
    top: null,
    bottom: null,
    shoes: null,
    hair: null,
    ...(hero ? { hero: true } : {}),
  };
}

export { pick as pickFrom };
