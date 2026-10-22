// Which Rocketbox avatars the game uses, what each is for, and how they're grouped into sets.
// The judgement calls live here (roles, tags, who's older, which go in the park); everything
// measurable (height, hip, anchors, skin tone from the head texture) is measured by convert.mjs,
// except the skin tones in SKIN below, set by eye where the measure gets them wrong.
//
// Each entry: [id, folder, gender, age, roles, tags, outputs]
//   folder   Adults | Children | Professions (under Assets/Avatars in the Rocketbox repo)
//   outputs  'hero+crowd' (1024 px hero file too: playable avatars, pilots) or 'crowd'
// Tags are free-form traits for choosing and dressing (see AvatarSpec.tags).
//
// Left out on purpose: military, police/SWAT, fire and surgeons (not for a family park:
// Medical_Female_01 and Medical_Male_01, 02, 04, 05 are in scrubs), Construction_Male_01 (his
// welding visor is down over his face), and Female_Party_01/02 under Professions (stray
// duplicates of the Adults ones).

const P = ['guest', 'playable'];
const H = 'hero+crowd';
const C = 'crowd';

/** @type {[string, string, 'm'|'f', 'toddler'|'child'|'adult'|'older', string[], string[], string][]} */
const ROWS = [
  // ---- women (playable)
  ['Female_Adult_01', 'Adults', 'f', 'adult', P, ['ponytail', 'blonde', 'jeans', 'shirt'], H],
  ['Female_Adult_02', 'Adults', 'f', 'older', P, ['ponytail', 'sweater', 'skirt'], H],
  ['Female_Adult_03', 'Adults', 'f', 'adult', P, ['longHair', 'top', 'trousers'], H],
  ['Female_Adult_04', 'Adults', 'f', 'adult', P, ['shortHair', 'blonde', 'jacket', 'trousers', 'boots'], H],
  ['Female_Adult_05', 'Adults', 'f', 'adult', P, ['shortHair', 'jacket', 'jeans'], H],
  ['Female_Adult_06', 'Adults', 'f', 'adult', P, ['headscarf', 'longDress'], H],
  ['Female_Adult_07', 'Adults', 'f', 'adult', P, ['ponytail', 'jacket', 'jeans', 'boots'], H],
  ['Female_Adult_08', 'Adults', 'f', 'adult', P, ['longHair', 'tshirt', 'jeans'], H],
  ['Female_Adult_09', 'Adults', 'f', 'adult', P, ['ponytail', 'cardigan', 'trousers'], H],
  ['Female_Adult_10', 'Adults', 'f', 'adult', P, ['headscarf', 'abaya', 'longDress'], H],
  ['Female_Adult_11', 'Adults', 'f', 'adult', P, ['ponytail', 'dress', 'boots'], H],
  ['Female_Adult_12', 'Adults', 'f', 'adult', P, ['shortHair', 'fringe', 'hoodie', 'shorts', 'trainers'], H],
  ['Female_Adult_13', 'Adults', 'f', 'adult', P, ['shortHair', 'blonde', 'top', 'jeans'], H],
  ['Female_Adult_14', 'Adults', 'f', 'adult', P, ['shortHair', 'cardigan', 'jeans', 'boots'], H],
  ['Female_Adult_15', 'Adults', 'f', 'adult', P, ['longHair', 'shirt', 'skirt', 'boots'], H],
  ['Female_Adult_17', 'Adults', 'f', 'adult', P, ['blonde', 'bun', 'tshirt', 'jeans', 'sandals'], H],
  ['Female_Party_01', 'Adults', 'f', 'adult', P, ['longHair', 'blonde', 'shorts', 'boots', 'top'], H],
  ['Female_Party_02', 'Adults', 'f', 'adult', P, ['curlyHair', 'top', 'skirt', 'sandals'], H],
  ['Sports_Female_02', 'Professions', 'f', 'adult', P, ['ponytail', 'top', 'trousers', 'trainers'], H],
  // the burqa is an older, simpler model (one material): crowd only
  ['Female_Adult_16', 'Adults', 'f', 'adult', ['guest'], ['burqa', 'veil', 'longDress'], C],

  // ---- men (playable)
  ['Male_Adult_01', 'Adults', 'm', 'adult', P, ['shorts', 'polo', 'trainers'], H],
  ['Male_Adult_02', 'Adults', 'm', 'adult', P, ['sweater', 'trousers'], H],
  ['Male_Adult_03', 'Adults', 'm', 'older', P, ['greyHair', 'jacket', 'trousers'], H],
  ['Male_Adult_04', 'Adults', 'm', 'adult', P, ['curlyHair', 'jacket', 'trousers', 'trainers'], H],
  ['Male_Adult_05', 'Adults', 'm', 'older', P, ['greyHair', 'beard', 'gilet', 'sweater', 'trousers'], H],
  ['Male_Adult_06', 'Adults', 'm', 'adult', P, ['top', 'jeans', 'trainers'], H],
  ['Male_Adult_07', 'Adults', 'm', 'adult', P, ['jacket', 'jeans'], H],
  ['Male_Adult_08', 'Adults', 'm', 'adult', P, ['shirt', 'trousers'], H],
  ['Male_Adult_09', 'Adults', 'm', 'adult', P, ['longHair', 'ponytail', 'tshirt', 'jeans'], H],
  ['Male_Adult_10', 'Adults', 'm', 'adult', P, ['trackSuit', 'trainers'], H],
  ['Male_Adult_11', 'Adults', 'm', 'adult', P, ['shirt', 'jeans'], H],
  ['Male_Adult_12', 'Adults', 'm', 'adult', P, ['jacket', 'jeans', 'trainers'], H],
  ['Male_Adult_13', 'Adults', 'm', 'older', P, ['bald', 'sweater', 'jeans'], H],
  ['Male_Adult_14', 'Adults', 'm', 'older', P, ['bald', 'shirt', 'trousers'], H],
  ['Male_Adult_15', 'Adults', 'm', 'adult', P, ['beard', 'hat', 'longShirt', 'traditional'], H],
  ['Male_Adult_16', 'Adults', 'm', 'adult', P, ['blonde', 'tshirt', 'jeans', 'trainers'], H],
  ['Male_Adult_17', 'Adults', 'm', 'adult', P, ['hat', 'cap', 'hoodie', 'jeans', 'trainers'], H],
  ['Male_Adult_18', 'Adults', 'm', 'adult', P, ['hood', 'hoodie', 'trousers'], H],
  ['Male_Adult_19', 'Adults', 'm', 'adult', P, ['beard', 'keffiyeh', 'thobe', 'sandals', 'traditional'], H],
  ['Male_Adult_20', 'Adults', 'm', 'adult', P, ['hoodie', 'jeans'], H],
  ['Male_Adult_21', 'Adults', 'm', 'adult', P, ['beard', 'keffiyeh', 'thobe', 'traditional'], H],
  ['Business_Male_06', 'Professions', 'm', 'adult', P, ['shirt', 'trousers'], H],
  ['Business_Male_07', 'Professions', 'm', 'older', P, ['bald', 'shirt', 'tie', 'jeans'], H],
  ['Delivery_Male_01', 'Professions', 'm', 'adult', P, ['beard', 'hat', 'beanie', 'shirt', 'jeans', 'boots'], H],
  ['Wood_Male_01', 'Professions', 'm', 'adult', P, ['hat', 'cap', 'beard', 'shirt', 'jeans', 'boots'], H],
  ['Business_Male_04', 'Professions', 'm', 'older', P, ['bald', 'waistcoat', 'trousers'], H],

  // ---- children (about 10–12; the small ones come from MakeHuman)
  ['Female_Child_01', 'Children', 'f', 'child', ['guest'], ['ponytail', 'blonde', 'tshirt', 'jeans', 'trainers'], C],
  ['Female_Child_02', 'Children', 'f', 'child', ['guest'], ['headscarf', 'longDress'], C],
  ['Male_Child_01', 'Children', 'm', 'child', ['guest'], ['sweater', 'jeans', 'trainers'], C],
  ['Male_Child_02', 'Children', 'm', 'child', ['guest', 'beach'], ['tshirt', 'shorts', 'sandals', 'printedText'], C],

  // ---- older women (more from MakeHuman)
  ['Business_Female_02', 'Professions', 'f', 'older', ['guest'], ['shortHair', 'blonde', 'glasses', 'jacket', 'trousers'], C],

  // ---- airport
  ['Pilot_Male_01', 'Professions', 'm', 'adult', ['pilot'], ['hat', 'uniform', 'jacket', 'tie'], H],
  ['Pilot_Male_02', 'Professions', 'm', 'older', ['pilot'], ['hat', 'uniform', 'jacket', 'tie', 'greyHair'], H],
  ['Pilot_Male_03', 'Professions', 'm', 'adult', ['pilot'], ['hat', 'uniform', 'shortSleeves'], C],
  ['Pilot_Female_01', 'Professions', 'f', 'adult', ['pilot', 'cabin'], ['hat', 'uniform', 'shortSleeves'], C],
  ['Pilot_Female_02', 'Professions', 'f', 'adult', ['pilot', 'cabin'], ['hat', 'uniform', 'shortSleeves'], C],
  ['Business_Female_01', 'Professions', 'f', 'adult', ['cabin'], ['shortHair', 'curlyHair', 'suit', 'trousers'], C],
  ['Business_Female_03', 'Professions', 'f', 'adult', ['cabin'], ['shortHair', 'suit', 'skirt', 'heels'], C],
  ['Business_Female_04', 'Professions', 'f', 'adult', ['cabin'], ['ponytail', 'suit', 'trousers'], C],
  ['Business_Male_01', 'Professions', 'm', 'adult', ['cabin'], ['suit', 'tie'], C],
  ['Business_Male_02', 'Professions', 'm', 'adult', ['cabin'], ['suit', 'tie'], C],
  ['Business_Male_03', 'Professions', 'm', 'adult', ['cabin'], ['suit', 'tie'], C],
  ['Business_Male_05', 'Professions', 'm', 'adult', ['cabin'], ['suit', 'tie'], C],
  ['Construction_Female_01', 'Professions', 'f', 'adult', ['ground'], ['helmet', 'hiVis', 'overalls', 'gloves', 'boots', 'radio'], C],
  ['Construction_Male_07', 'Professions', 'm', 'adult', ['ground'], ['helmet', 'hiVis', 'overalls', 'boots'], C],
  ['Construction_Male_08', 'Professions', 'm', 'adult', ['ground'], ['helmet', 'hiVis', 'overalls', 'gloves', 'boots', 'radio'], C],
  ['Construction_Male_02', 'Professions', 'm', 'older', ['mechanic'], ['helmet', 'overalls', 'boots'], C],
  ['Construction_Male_05', 'Professions', 'm', 'adult', ['mechanic'], ['helmet', 'overalls', 'boots'], C],
  ['Construction_Male_06', 'Professions', 'm', 'adult', ['mechanic'], ['helmet', 'overalls', 'toolBelt', 'boots'], C],
  ['Construction_Male_03', 'Professions', 'm', 'adult', ['mechanic'], ['helmet', 'overalls', 'toolBelt', 'boots'], C],
  ['Construction_Male_04', 'Professions', 'm', 'adult', ['mechanic'], ['helmet', 'overalls', 'toolBelt', 'boots'], C],
  ['Security_Female_01', 'Professions', 'f', 'adult', ['security'], ['hat', 'uniform'], C],
  ['Security_Male_01', 'Professions', 'm', 'older', ['security'], ['hat', 'uniform', 'tie'], C],

  // ---- island
  ['Sports_Female_01', 'Professions', 'f', 'adult', ['swim', 'beach'], ['swimwear', 'barefoot', 'ponytail', 'blonde'], C],
  ['Sports_Male_01', 'Professions', 'm', 'adult', ['swim', 'beach'], ['swimwear', 'barefoot'], C],
  ['Sports_Male_02', 'Professions', 'm', 'adult', ['beach'], ['sportsKit', 'shorts', 'printedText', 'footballBoots'], C],
  ['Sports_Male_03', 'Professions', 'm', 'adult', ['beach'], ['sportsKit', 'shorts', 'curlyHair', 'printedText', 'footballBoots'], C],
  ['Sports_Male_04', 'Professions', 'm', 'adult', ['beach'], ['vest', 'shorts', 'trainers'], C],

  // ---- park staff
  ['Gardener_Male_01', 'Professions', 'm', 'older', ['staff'], ['beard', 'jacket', 'trousers', 'gloves', 'wellies'], C],
  ['Chef_Female_01', 'Professions', 'f', 'adult', ['vendor', 'staff'], ['hat', 'uniform', 'apron'], C],
  // the first-aid post
  ['Medical_Female_02', 'Professions', 'f', 'adult', ['staff'], ['labCoat', 'trousers'], C],
  ['Medical_Male_03', 'Professions', 'm', 'older', ['staff'], ['labCoat', 'bald', 'tie', 'trousers'], C],
];

/**
 * Skin tones (1 lightest to 5 darkest) set by eye from the contact sheets, where the one measured
 * from the head texture is wrong: a beard or stubble, wrinkle shading or a hat's shadow reads as
 * darker skin, and a few textures are lighter or darker than they render. Female_Adult_16's face
 * is behind the burqa's mesh, so hers is nominal. Everyone else keeps the measured tone.
 */
const SKIN = {
  Business_Female_01: 4,
  Business_Male_02: 2,
  Business_Male_04: 2,
  Business_Male_05: 4,
  Business_Male_06: 2,
  Construction_Male_02: 2,
  Construction_Male_08: 4,
  Delivery_Male_01: 3,
  Female_Adult_16: 3,
  Female_Child_02: 3,
  Female_Party_02: 3,
  Male_Adult_03: 2,
  Male_Adult_19: 3,
  Male_Adult_20: 2,
  Male_Adult_21: 3,
  Pilot_Female_02: 4,
  Pilot_Male_03: 2,
  Security_Male_01: 2,
  Sports_Male_03: 4,
};

export const AVATARS = ROWS.map(([id, folder, gender, age, roles, tags, outputs]) => ({ id, folder, gender, age, roles, tags, hero: outputs === H, skin: SKIN[id] }));
export const avatar = (id) => {
  const a = AVATARS.find((x) => x.id === id);
  if (!a) throw new Error(`not in the catalogue: ${id}`);
  return a;
};

/** Converted and checked first: a man and a woman each young and older, two children, and the women's and men's clip sets. */
export const STARTER = ['Male_Adult_01', 'Male_Adult_08', 'Female_Adult_01', 'Female_Adult_04', 'Male_Adult_05', 'Business_Female_02', 'Male_Child_01', 'Female_Child_01'];

/**
 * Avatars loaded together (the MakeHuman people by their ids too: makehuman-cast.mjs).
 * 'park': the fair's crowd, 26 people: 8 women and 8 men of mixed skin tones and outfits, 4 older
 * (two of them MakeHuman's women), 4 children (two each from Rocketbox and MakeHuman) and
 * MakeHuman's 2 toddlers. Rocketbox has few dark-skinned women out of uniform, so
 * Business_Female_01 comes in her suit.
 * 'airport': the crew only (pilots, cabin crew in suits, ground crew, mechanics, security); the
 * travellers are the park's people, already loaded. 'island': the beach and the sea (swimwear, a
 * vest, a party top), with the park's people again for everyone else.
 */
export const SETS = {
  park: [
    'Female_Adult_01', 'Female_Adult_03', 'Female_Adult_04', 'Female_Adult_06', 'Female_Adult_08', 'Female_Adult_12', 'Female_Party_02', 'Business_Female_01',
    'Male_Adult_01', 'Male_Adult_04', 'Male_Adult_06', 'Male_Adult_08', 'Male_Adult_09', 'Male_Adult_12', 'Male_Adult_15', 'Male_Adult_17',
    'Male_Adult_05', 'Business_Female_02', 'MH_Older_Woman_01', 'MH_Older_Woman_02',
    'Female_Child_01', 'Male_Child_01', 'MH_Child_Boy_01', 'MH_Child_Girl_01',
    'MH_Toddler_Boy_01', 'MH_Toddler_Girl_01',
  ],
  airport: [
    'Pilot_Male_01', 'Pilot_Male_03', 'Pilot_Female_01',
    'Business_Female_03', 'Business_Female_04', 'Business_Male_02',
    'Construction_Female_01', 'Construction_Male_07', 'Construction_Male_08', 'Construction_Male_05',
    'Security_Female_01', 'Security_Male_01',
  ],
  island: ['Sports_Female_01', 'Sports_Male_01', 'Sports_Male_04', 'Female_Party_01'],
};
