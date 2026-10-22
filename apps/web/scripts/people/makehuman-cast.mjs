// The MakeHuman people: the ages Rocketbox doesn't have (toddlers, small children, older women),
// made with MPFB from CC0 assets only (MakeHuman's system assets and the community's CC0 packs).
// makehuman.mjs builds them; each entry is everything that person's job needs.
//
// Assets are named as their folders are: clothes, hair, eyebrows and eyelashes are looked up in
// .people-cache/makehuman/data/<kind>/<name>/ (the system assets), then in each pack under
// .people-cache/makehuman/extra/<pack>/clothes/<name>/. Skins are data/skins/<name>/, eye colours
// data/eyes/materials/<name>.mhmat. `regions` says which outfit region a garment dyes as, where
// makehuman-post.mjs's guess (shoes by name, anything else split by the bones it hangs off) would
// be wrong: a dress is one garment, dyed as the top, as masks.mjs does with one-piece outfits.
//
// `height` is what the person is scaled to (metres, bare feet to crown): MakeHuman's own heights for
// small children run short, so the age sets the proportions and this sets the size. `skinTone` is
// AvatarSpec.skin (1 lightest … 5 deepest), by eye beside Rocketbox people and in the lightness band
// measure.mjs's skinTone() puts Rocketbox people of that tone in; `skinColour` is what the
// skin texture's middle tones are brought to (makehuman-post.mjs's matchSkin): the MakeHuman skins
// keep their lightness, but take the warmth of Rocketbox people of the same tone (red about 1.9×
// green in linear light for the light skins, 2.5× for the deep browns, where MakeHuman's old
// African skin had 5× and read maroon).

/** Asset packs (besides the system assets) at files.makehumancommunity.org/asset_packs/<pack>/<pack>_cc0.zip. */
export const PACKS = ['shirts01', 'pants01', 'skirts01', 'dress01', 'shoes01'];

export const CAST = [
  {
    id: 'MH_Toddler_Boy_01',
    gender: 'm',
    age: 'toddler',
    ageYears: 2.5,
    height: 0.93,
    skinTone: 1,
    macro: { gender: 1, muscle: 0.5, weight: 0.55, proportions: 0.5, race: { caucasian: 0.9, asian: 0.05, african: 0.05 } },
    skin: 'young_caucasian_male',
    skinColour: '#e9af8f',
    eyes: 'brown',
    eyebrows: 'eyebrow001',
    eyelashes: 'eyelashes01',
    hair: 'short02',
    clothes: ['male_worksuit01', 'shoes05'],
    tags: ['dungarees', 'trainers', 'shortHair'],
  },
  {
    id: 'MH_Toddler_Girl_01',
    gender: 'f',
    age: 'toddler',
    ageYears: 2.5,
    height: 0.92,
    skinTone: 5,
    macro: { gender: 0, muscle: 0.5, weight: 0.55, proportions: 0.5, race: { african: 0.9, caucasian: 0.05, asian: 0.05 } },
    skin: 'young_african_female',
    skinColour: '#643e2d',
    eyes: 'brown',
    eyebrows: 'eyebrow010',
    eyelashes: 'eyelashes02',
    hair: 'afro01',
    clothes: ['toigo_camisole_dress_with_full_skirt', 'cortu_t-bar'],
    regions: { toigo_camisole_dress_with_full_skirt: 'top' },
    tags: ['dress', 'sandals', 'curlyHair'],
  },
  {
    id: 'MH_Child_Boy_01',
    gender: 'm',
    age: 'child',
    ageYears: 6,
    height: 1.17,
    skinTone: 2,
    macro: { gender: 1, muscle: 0.5, weight: 0.5, proportions: 0.5, race: { asian: 0.85, caucasian: 0.1, african: 0.05 } },
    skin: 'young_asian_male',
    skinColour: '#d09a7c',
    eyes: 'brownlight',
    eyebrows: 'eyebrow002',
    eyelashes: 'eyelashes01',
    // (short04 parted down to bare scalp, and its cap broke into holes once LOD1 and LOD2 simplified it)
    hair: 'short02',
    hairTint: 'black',
    clothes: ['namuhekam_male_polo_shirt', 'toigo_wool_pants', 'shoes06'],
    regions: { namuhekam_male_polo_shirt: 'top', toigo_wool_pants: 'bottom' },
    tags: ['polo', 'trousers', 'trainers', 'shortHair'],
  },
  {
    id: 'MH_Child_Girl_01',
    gender: 'f',
    age: 'child',
    ageYears: 6,
    height: 1.15,
    skinTone: 1,
    macro: { gender: 0, muscle: 0.5, weight: 0.5, proportions: 0.5, race: { caucasian: 0.9, asian: 0.05, african: 0.05 } },
    skin: 'young_caucasian_female',
    skinColour: '#d7a183',
    eyes: 'blue',
    // full, flat brows and short lashes: the thin arched brows and long lashes read as make-up on a
    // six-year-old
    eyebrows: 'eyebrow001',
    eyelashes: 'eyelashes01',
    hair: 'ponytail01',
    clothes: ['joepal_crude_t-shirt_female', 'cortu_jeans_shorts', 'cortu_t-bar'],
    regions: { 'joepal_crude_t-shirt_female': 'top', cortu_jeans_shorts: 'bottom' },
    tags: ['tshirt', 'shorts', 'sandals', 'longHair', 'ponytail'],
  },
  {
    id: 'MH_Older_Woman_01',
    gender: 'f',
    age: 'older',
    ageYears: 72,
    height: 1.6,
    skinTone: 1,
    macro: { gender: 0, muscle: 0.4, weight: 0.6, proportions: 0.5, cupsize: 0.5, firmness: 0.3, race: { caucasian: 0.9, asian: 0.05, african: 0.05 } },
    skin: 'old_caucasian_female',
    skinColour: '#e2ae92',
    eyes: 'grey',
    eyebrows: 'eyebrow010',
    eyelashes: 'eyelashes03',
    // (short03's fringe hung over one eye)
    hair: 'short02',
    hairTint: 'white',
    clothes: ['toigo_fisherman_sweater', 'toigo_wool_pants', 'toigo_mj_cloth_shoes'],
    regions: { toigo_fisherman_sweater: 'top', toigo_wool_pants: 'bottom', toigo_mj_cloth_shoes: 'shoes' },
    tags: ['sweater', 'trousers', 'flats', 'greyHair', 'shortHair'],
  },
  {
    id: 'MH_Older_Woman_02',
    gender: 'f',
    age: 'older',
    ageYears: 70,
    height: 1.62,
    skinTone: 5,
    macro: { gender: 0, muscle: 0.45, weight: 0.65, proportions: 0.5, cupsize: 0.55, firmness: 0.3, race: { african: 0.9, caucasian: 0.05, asian: 0.05 } },
    skin: 'old_african_female',
    skinColour: '#623e2d',
    eyes: 'brown',
    eyebrows: 'eyebrow010',
    eyelashes: 'eyelashes03',
    hair: 'short01',
    hairTint: 'grey',
    clothes: ['female_elegantsuit01', 'toigo_ballet_flats'],
    regions: { toigo_ballet_flats: 'shoes' },
    tags: ['blouse', 'skirt', 'flats', 'greyHair', 'shortHair'],
  },
];
