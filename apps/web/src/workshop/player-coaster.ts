// A coaster a member built in the Coaster Workshop, as the park runs it: the shared layout (rules.ts)
// placed on a plot, ridden with the shared physics, in the member's colours, with "Designed by
// @username" on its station. The same coaster stands in the Builder's Yard while it's being built.
import * as THREE from 'three';
import type { Ctx } from '../world/context';
import { Coaster } from '../world/attractions/coaster';
import { PHYS, type TrackData } from '../world/attractions/track';
import { escapeHtml } from '../world/ui';
import { layTrack, PLOT_SIZE, STEADY_DRIVER, stepTrain, type Design, type Track } from './rules';

/** Where a plot's frame sits in the world: its centre, and how far it's turned about y. */
export interface Placement {
  x: number;
  z: number;
  yaw: number;
}

/** The shared track (plot-local, flat arrays) placed in the world as the park's coasters have it. */
export function placeTrack(t: Track, at: Placement): TrackData {
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  const point = (a: number[], i: number, offset: boolean) => {
    const x = a[i * 3];
    const z = a[i * 3 + 2];
    return new THREE.Vector3((offset ? at.x : 0) + x * c + z * s, a[i * 3 + 1], (offset ? at.z : 0) - x * s + z * c);
  };
  const pos: THREE.Vector3[] = [];
  const tan: THREE.Vector3[] = [];
  const up: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  for (let i = 0; i < t.n; i++) {
    pos.push(point(t.pos, i, true));
    tan.push(point(t.tan, i, false));
    up.push(point(t.up, i, false));
    right.push(point(t.right, i, false));
  }
  return { pos, tan, up, right, zone: t.zone.slice(), length: t.length };
}

/** A point in a plot's frame, out in the world. */
export function plotToWorld(at: Placement, lx: number, y: number, lz: number) {
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  return new THREE.Vector3(at.x + lx * c + lz * s, y, at.z - lx * s + lz * c);
}

export interface PlayerCoasterOptions {
  /** Short id (the best-lap key): the creation's, or the yard's. */
  id: string;
  design: Design;
  /** Whose it is ("Designed by @…" on the station); null in the yard, where it's yours. */
  creator: string | null;
  at: Placement;
  /** The track already laid out, when the caller has it. */
  track?: Track;
  parent?: THREE.Object3D;
  layer?: number;
}

/** Builds a member's coaster: nobody walks on the plots or in the yard, so it has no colliders. */
export function playerCoaster(ctx: Ctx, o: PlayerCoasterOptions) {
  const { design, at } = o;
  const track = o.track ?? layTrack(design.pieces);
  const data = placeTrack(track, at);
  const driven = design.mode === 'driven';
  // camera spots round the plot's edge, a little outside it, for the trackside view
  const h = PLOT_SIZE / 2 + 6;
  const trackside = [
    [-h, 7, -h],
    [h, 7, -h],
    [h, 6, h],
    [-h, 6, h],
    [0, 10, -h],
    [-h, 9, 0],
    [h, 9, 0],
  ].map(([x, y, z]) => plotToWorld(at, x, y, z));
  const name = design.name;
  const coaster = new Coaster(ctx, {
    id: o.id,
    name,
    track: data,
    phys: PHYS,
    station: { title: name.toUpperCase(), sub: o.creator ? `Designed by @${o.creator}` : 'Your design · test ride', side: -1 },
    colors: { rail: design.colors.rails, spine: design.colors.spine, cars: design.colors.cars, supports: design.colors.supports },
    cars: design.cars,
    trackside,
    solid: false,
    parent: o.parent,
    layer: o.layer,
    step: (st, throttle, turbo, dt) => stepTrain(track, st, throttle, turbo, dt),
    stalls: design.mode,
    controls: driven,
    // the ghost train's driver keeps the motors on below a steady speed (as the stats assume)
    ghostThrottle: driven ? (v) => (v < STEADY_DRIVER ? 1 : 0) : undefined,
    beats: { lift: 'Up the lift hill ⛓️', launch: 'LAUNCH! 🚀', brake: 'Brakes on…' },
    intro: (touch) => {
      const by = o.creator ? `Designed by @${escapeHtml(o.creator)}` : 'Your design';
      const how = driven
        ? touch
          ? 'Push the joystick <strong>up</strong> for power, <strong>down</strong> to brake. Tap <kbd>E</kbd> to switch camera.'
          : 'Hold <kbd>W</kbd> for power, <kbd>S</kbd> to brake, <kbd>Shift</kbd> for turbo, <kbd>C</kbd> to switch camera.'
        : `It rides itself: sit back and enjoy it. ${touch ? 'Tap <kbd>E</kbd>' : 'Press <kbd>C</kbd>'} to switch camera.`;
      return `<p class="eyebrow">${escapeHtml(name)} · ${by}</p><h2>Built in the Coaster Workshop</h2><p>${how} Real physics: if the train runs out of speed on a climb, it stalls and gets towed back.</p>`;
    },
  });
  return { coaster, track, data };
}
