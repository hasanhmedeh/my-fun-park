// The sea's swell as a pure function, so boats, jet-skis and buoys ride exactly the waves the sea
// mesh draws (sea.ts feeds the same components to its vertex shader).
//
// Four long-crested waves: two swells rolling in from the open ocean to the south-west, and two
// shorter wind waves running downwind, their height growing with the wind. Deep-water dispersion
// (ω² = g k). Near the shore the swell dies down, and inside Palm Cay's reef the lagoon is nearly
// flat (a ripple of a few centimetres).

import { ISLAND, SEA_Y, headingVec, homeShoreDist, islandShoreDist } from './geo';
import { lagoonSdf, reefAt, sstep } from './terrain-land';

export interface WaveComponent {
  /** Unit direction the crests travel (x, z), wavenumber (rad/m), angular frequency (rad/s), amplitude (m), phase. */
  dx: number;
  dz: number;
  k: number;
  w: number;
  a: number;
  phase: number;
}

const G = 9.81;
function component(towards: number, wavelength: number, a: number, phase: number): WaveComponent {
  const d = headingVec(towards);
  const k = (Math.PI * 2) / wavelength;
  return { dx: d.x, dz: d.z, k, w: Math.sqrt(G * k), a, phase };
}

/** The live wave set (setSwell changes it; sea.ts reads it every frame). */
export const SWELL = {
  fromDeg: 240,
  kt: 10,
  waves: [] as WaveComponent[],
};

/** Sets the sea state for a wind blowing FROM `fromDeg` at `kt` knots. */
export function setSwell(fromDeg: number, kt: number) {
  SWELL.fromDeg = fromDeg;
  SWELL.kt = kt;
  const wind = Math.min(0.62, 0.05 + 0.022 * kt);
  const downwind = fromDeg + 180;
  SWELL.waves = [
    // the ocean swell from the south-south-west, whatever the local wind
    component(20, 112, 0.27, 0.0),
    component(48, 71, 0.15, 1.7),
    // the wind sea
    component(downwind, 33, wind, 4.1),
    component(downwind + 34, 19, wind * 0.55, 2.3),
  ];
}
setSwell(SWELL.fromDeg, SWELL.kt);

/** How much of the swell reaches (x, z): 1 offshore, a little at the water's edge, almost none in the lagoon. */
export function swellFactor(x: number, z: number) {
  if (z > 20000) {
    const u = -islandShoreDist(x, z);
    const open = 0.12 + 0.88 * sstep(5, 160, u);
    const L = lagoonSdf(x, z);
    const behindReef = Math.abs(x) < ISLAND.lagoon.x1 && z < ISLAND.lagoon.z0 ? 1 : 1 - sstep(-30, 40, L);
    // the swell breaks on the reef: livelier over the crest than in the lagoon behind it
    return open * (1 - behindReef * 0.9) * (1 - reefAt(x, z) * 0.45);
  }
  return 0.12 + 0.88 * sstep(5, 140, -homeShoreDist(x, z));
}

/** Phase of each wave at time t, wrapped (the shader gets the same numbers). */
export function wavePhases(t: number, out: number[]) {
  const TAU = Math.PI * 2;
  for (let i = 0; i < SWELL.waves.length; i++) {
    const c = SWELL.waves[i];
    out[i] = (((c.w * t - c.phase) % TAU) + TAU) % TAU;
  }
  return out;
}

const phases: number[] = [0, 0, 0, 0];

/** The sea surface's height at (x, z) and time t (s), swell included: for boats, jet-skis and buoys. */
export function waveY(x: number, z: number, t: number): number {
  wavePhases(t, phases);
  let h = 0;
  for (let i = 0; i < SWELL.waves.length; i++) {
    const c = SWELL.waves[i];
    h += c.a * Math.sin(c.k * (c.dx * x + c.dz * z) - phases[i]);
  }
  return SEA_Y + h * swellFactor(x, z);
}
