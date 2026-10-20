// The fair's fictional airlines and their A320neo colours. None of them imitates a real carrier:
// the names, colours and tail art are the fair's own (candy, palms, waves, stars).
//
// The painter (a320/paint.ts) turns a livery into the aircraft's texture atlas. Atlases are cached
// per livery's contents, so a copy with only a new registration (`{ ...LIVERIES.funfair,
// registration: 'FF-SUN' }`) paints its own atlas: use that sparingly (each one is ~11 MB of GPU
// memory); the airside builder's parked fleet should mostly reuse these six.

import type { Livery } from '../../aviation/types';

export type LiveryId = 'funfair' | 'palmcay' | 'candy' | 'sunset' | 'lagoon' | 'cargo';

export const LIVERIES: Record<LiveryId, Livery> = {
  // the fair's own airline (flights FA101 / FA102): white, a candy-pink tail with the giant wheel
  funfair: {
    name: 'Funfair Air',
    code: 'FA',
    fuselage: '#ffffff',
    belly: '#ff4d6d',
    cheatline: '#ffc23d',
    tail: '#ff4d6d',
    tailArt: 'funfair',
    engines: '#ff4d6d',
    registration: 'FF-AIR',
  },
  // the island's regional carrier: lagoon teal and a palm
  palmcay: {
    name: 'Palm Cay Air',
    code: 'PC',
    fuselage: '#ffffff',
    belly: '#11a59b',
    cheatline: '#7ee2b8',
    tail: '#0d8f8a',
    tailArt: 'palm',
    engines: '#0d8f8a',
    registration: 'PC-SUN',
  },
  // a sweet-shop pastel low-cost carrier
  candy: {
    name: 'Candy Airways',
    code: 'CY',
    fuselage: '#fff0f5',
    belly: '#7b5cd6',
    cheatline: '#ff8fb8',
    tail: '#7b5cd6',
    tailArt: 'plain',
    engines: '#ff8fb8',
    registration: 'CY-SWT',
  },
  // evening-sky orange with a sunburst
  sunset: {
    name: 'Sunset Airlines',
    code: 'SN',
    fuselage: '#ffffff',
    belly: '#3d1f5c',
    cheatline: '#ff8a3d',
    tail: '#ff7433',
    tailArt: 'star',
    engines: '#3d1f5c',
    registration: 'SN-DSK',
  },
  // deep blue with breaking waves
  lagoon: {
    name: 'Lagoon Airways',
    code: 'LG',
    fuselage: '#ffffff',
    belly: '#0b4f8f',
    cheatline: '#35c3e8',
    tail: '#0b4f8f',
    tailArt: 'wave',
    engines: '#35c3e8',
    registration: 'LG-BLU',
  },
  // a converted freighter (windows plugged, main deck cargo door painted): grey and ink
  cargo: {
    name: 'Funfair Cargo',
    code: 'FC',
    fuselage: '#f3f3f1',
    belly: '#8d96a1',
    cheatline: '#ffc23d',
    tail: '#1d1238',
    tailArt: 'plain',
    engines: '#8d96a1',
    registration: 'FC-BOX',
  },
};

/** Freighters have their cabin windows plugged (painted over) and no lit cabin at night. */
export function isFreighter(l: Livery) {
  return /cargo/i.test(l.name);
}
