// The ground under the player's A320, as the flight model feels it: the airfields' pavement
// (runway, taxiway, apron) at the airport's level, grass and sand on the land round them, and the
// sea beyond the shore (water: touching it is a ditching).
//
// The flight model keeps the sample it is given for the rest of its substep (and between frames,
// for `state.surface`), so a sample must not change under it: the flat surfaces are frozen shared
// objects, and the terrain's (whose height varies) come from a ring of reusable objects that is
// far longer than the handful of queries one substep makes. Nothing is allocated per query.

import { SEA_Y, regionAt, type Region } from '../geo';
import { groundY, onLand } from '../terrain-land';
import { planAirfield } from '../airport/airfield-plan';
import { buildField, surfaceOf } from '../airport/airfield-field';
import type { Airport } from '../../aviation/airports';
import type { GroundQuery, GroundSample, Surface } from '../../aviation/types';

/** The pavement under a point at one airport, or null off it (Airfield.surfaceAt, or the node build of the same plan). */
export type PavementAt = (x: number, z: number) => Surface | null;

const flat = (surface: Surface, y = 0): GroundSample => Object.freeze({ y, surface });
const RUNWAY = flat('runway');
const TAXIWAY = flat('taxiway');
const APRON = flat('apron');
const WATER = flat('water', SEA_Y);
const PAVED: Partial<Record<Surface, GroundSample>> = { runway: RUNWAY, taxiway: TAXIWAY, apron: APRON };

/** Land nearer the water than this is beach sand; further in, grass. */
const BEACH_M = 45;
const RING = 64;

/**
 * The flight's ground query from each airport's pavement. Off the pavement it is the terrain's own
 * height (groundY), sand along the shore and grass inland, and the sea's surface past the water's edge.
 */
export function flightGround(pavement: Record<Region, PavementAt>): GroundQuery {
  const ring: GroundSample[] = Array.from({ length: RING }, () => ({ y: 0, surface: 'grass' as Surface }));
  let next = 0;
  return (x, z) => {
    const paved = pavement[regionAt(x, z)](x, z);
    if (paved) return PAVED[paved] ?? APRON;
    if (!onLand(x, z)) return WATER;
    const s = ring[next];
    next = (next + 1) % RING;
    s.y = Math.max(SEA_Y, groundY(x, z));
    s.surface = onLand(x, z, BEACH_M) ? 'grass' : 'sand';
    return s;
  };
}

/**
 * The same pavement as an Airfield's surfaceAt, without building its scenery: for node checks and
 * previews that fly without the 3D airfield (the plan and its raster are pure).
 */
export function planPavement(ap: Airport, texel = 1): PavementAt {
  const plan = planAirfield(ap);
  const field = buildField(plan, texel);
  return (x, z) => surfaceOf(plan, field, x, z);
}
