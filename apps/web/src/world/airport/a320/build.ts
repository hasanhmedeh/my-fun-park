// Assembles the whole airframe for one detail level into a single skinned geometry. Geometries
// are cached per level and shared by every aircraft of that level (they are never disposed: the
// fleet keeps reusing them).

import type * as THREE from 'three';
import { LODS, fuselageBody, wing, type Detail } from './airframe';
import { SkinBuilder } from './mesh';
import { extras, fin, mainGear, nacelle, noseGear, stabiliser } from './parts';
import type { Side } from './rig';

const cache = new Map<Detail, THREE.BufferGeometry>();

export function airframeGeometry(detail: Detail) {
  const hit = cache.get(detail);
  if (hit) return hit;
  const L = LODS[detail];
  const b = new SkinBuilder();
  fuselageBody(b, L);
  for (const s of [-1, 1] as Side[]) {
    wing(b, L, s);
    stabiliser(b, L, s);
    nacelle(b, L, s);
    mainGear(b, L, s);
  }
  fin(b, L);
  noseGear(b, L);
  if (L.extras) extras(b);
  const g = b.build();
  g.computeBoundingSphere();
  cache.set(detail, g);
  return g;
}
