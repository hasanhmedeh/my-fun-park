// The airside's vehicles: pushback tugs, baggage tractors and their carts, ULD dollies, belt
// loaders, catering hi-lift trucks, fuel bowsers, apron buses, the follow-me car, ground power
// units, the fire service's crash tenders, a main-deck loader, vans, and the ground crew.
//
// Every vehicle of an airport is one instance in one BatchedMesh (one draw call for the lot, plus
// the shadow pass), built from vertex-coloured geometry (airside-kit.ts) that lights its own
// headlights and cab at night. Drivers move them round their loops at sensible speeds, slowing
// for corners and stopping where the work is; each one gives way to whatever is in the lane
// ahead of it, vehicle or aircraft, so nothing drives through anything. Amber beacons and
// headlamps are one point-sprite draw.
//
// Vehicle frame: forward is −z, origin on the ground at the vehicle's centre, metres.

import * as THREE from 'three';
import type { Ctx } from '../context';
import type { Airport } from '../../aviation/airports';
import { A320_POINTS } from '../../aviation/a320';
import { headingVec } from '../geo';
import { HEAD_GLOW, Kit, Lamps, TAIL_GLOW, WINDOW_GLOW, at, kitMaterial, type Glow, type LampSpec, type NightUniform } from './airside-kit';
import { Path, curveSpeed, stopSpeed, wrap180, type P2, type Pose2 } from './airside-path';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------
// Colours
// ------------------------------------------------------------------------------------------------

/** The fair's ground handler: mustard yellow equipment on dark chassis. */
const GSE = '#f2b632';
const GSE_DARK = '#c98f16';
const CHASSIS = '#2b2d31';
const TYRE = '#18191b';
const RIM = '#8b9096';
const GLASS = '#1f2c36';
const WHITE = '#eef0f2';
const GREY = '#9aa0a6';
const STEEL = '#6d747b';
const RUBBER = '#141414';
const AMBER = '#ffad1f';
const CANDY = '#ff4d6d';
const BLUE = '#2f6fd6';
const FIRE_RED = '#c8221c';
const HIVIS = '#d8f22a';
const ORANGE = '#ff7a1a';
const SKIN = '#c78f6a';

const CAB_GLOW: Glow = [0.5, 0.42, 0.3, 0];
const SIGN_GLOW: Glow = [1.8, 1.6, 0.9, 0];

// ------------------------------------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------------------------------------

/** A wheel of radius r and width w, its axle along x at (x, r, z): tyre and hub. */
function wheel(k: Kit, x: number, z: number, r: number, w: number) {
  k.wheel(r, w, TYRE, at(x, r, z));
  k.wheel(r * 0.55, w + 0.02, RIM, at(x, r, z));
}

/** Pairs of wheels either side at each z (track = distance between wheel centres). */
function axles(k: Kit, zs: number[], track: number, r: number, w: number) {
  for (const z of zs) for (const s of [-1, 1]) wheel(k, (s * track) / 2, z, r, w);
}

/** A profile in the vehicle's side plane (z, y), extruded across x by width w (centred). */
function sideProfile(k: Kit, pts: [number, number][], w: number, color: string, x = 0, glow?: Glow) {
  const s = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  // shape x → vehicle z, shape y → y, extrusion z → vehicle x
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, -w / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  k.add(g, color, at(x, 0, 0), glow);
}

/** An amber beacon on a short stalk at (x, y, z). */
function beaconLens(k: Kit, x: number, y: number, z: number) {
  k.cyl(0.09, 0.11, 0.08, 8, CHASSIS, at(x, y, z));
  k.cyl(0.08, 0.09, 0.16, 10, AMBER, at(x, y + 0.08, z));
}

/** Headlamps at the front (z) and tail lamps at the back, `x` either side. */
function lamps(k: Kit, x: number, y: number, zf: number, zr: number) {
  for (const s of [-1, 1]) {
    k.boxC(0.22, 0.14, 0.04, '#f4f1e6', at(s * x, y, zf), HEAD_GLOW);
    k.boxC(0.18, 0.1, 0.04, '#7a1410', at(s * x, y, zr), TAIL_GLOW);
  }
}

// ------------------------------------------------------------------------------------------------
// The vehicles
// ------------------------------------------------------------------------------------------------

export type VehicleKind =
  | 'tug'
  | 'tractor'
  | 'cart'
  | 'dolly'
  | 'belt'
  | 'catering'
  | 'cateringBox'
  | 'bowser'
  | 'bus'
  | 'followme'
  | 'gpu'
  | 'fire'
  | 'hiloader'
  | 'van'
  | 'crew'
  | 'armL'
  | 'armR';

/**
 * Each kind's footprint (length, width: for spacing and giving way), where its amber beacon
 * sits (or null) and how far apart its headlamps are and how high, for the night-time flares.
 */
export const VEHICLE: Record<VehicleKind, { l: number; w: number; beacon: [number, number, number] | null; head: [number, number, number] | null }> = {
  tug: { l: 7.2, w: 3.0, beacon: [0.85, 2.4, 2.6], head: [1.15, 0.95, -3.6] },
  tractor: { l: 3.3, w: 1.6, beacon: [0, 2.15, 0.35], head: [0.55, 0.85, -1.7] },
  cart: { l: 3.9, w: 1.6, beacon: null, head: null },
  dolly: { l: 3.9, w: 1.8, beacon: null, head: null },
  belt: { l: 8.2, w: 2.1, beacon: [-0.7, 2.25, 2.2], head: [0.75, 0.8, -4.05] },
  catering: { l: 9.6, w: 2.5, beacon: [0, 3.05, -2.7], head: [0.95, 0.85, -4.85] },
  cateringBox: { l: 6.6, w: 2.5, beacon: null, head: null },
  bowser: { l: 10.2, w: 2.5, beacon: [0, 3.25, -3.3], head: [0.95, 0.9, -5.1] },
  bus: { l: 14, w: 3.0, beacon: [0, 3.05, -6.2], head: [1.2, 0.75, -7.02] },
  followme: { l: 4.8, w: 1.9, beacon: [0, 2.05, 0.3], head: [0.7, 0.75, -2.42] },
  gpu: { l: 3.6, w: 1.5, beacon: null, head: null },
  fire: { l: 12, w: 3.0, beacon: [0, 3.75, -4.3], head: [1.2, 1.05, -6.02] },
  hiloader: { l: 9.5, w: 3.6, beacon: [1.5, 3.1, 4.0], head: null },
  van: { l: 5.4, w: 2.0, beacon: [0, 2.6, -0.6], head: [0.78, 0.8, -2.72] },
  crew: { l: 0.6, w: 0.6, beacon: null, head: null },
  armL: { l: 0.2, w: 0.2, beacon: null, head: null },
  armR: { l: 0.2, w: 0.2, beacon: null, head: null },
};

/** A towbarless pushback tug: the aircraft's nose wheel sits in the cradle at its front. */
function tug(k: Kit) {
  // the chassis in two halves either side of the cradle, joined behind it
  for (const s of [-1, 1]) k.box(0.85, 0.75, 3.2, CHASSIS, at(s * 1.05, 0.3, -2.0));
  k.box(2.95, 0.85, 4.0, CHASSIS, at(0, 0.3, 1.6));
  // the yellow body: low decks over the chassis, the engine deck behind
  for (const s of [-1, 1]) k.box(0.95, 0.22, 3.4, GSE, at(s * 1.05, 1.05, -1.9));
  k.box(3.0, 0.5, 4.1, GSE, at(0, 1.05, 1.6));
  k.box(3.0, 0.08, 4.1, GSE_DARK, at(0, 1.55, 1.6));
  // the cradle's clamp arms and its turntable
  for (const s of [-1, 1]) k.box(0.2, 0.5, 1.4, STEEL, at(s * 0.55, 0.25, -2.2));
  k.cyl(0.62, 0.62, 0.12, 16, STEEL, at(0, 0.2, -2.1));
  // the driver's low cab at the back right, glazed all round (clear of the aircraft's radome)
  k.box(1.25, 0.6, 1.6, GLASS, at(0.85, 1.55, 2.6), CAB_GLOW);
  k.box(1.35, 0.08, 1.7, GSE, at(0.85, 2.15, 2.6));
  for (const [x, z] of [[0.25, 1.82], [1.45, 1.82], [0.25, 3.38], [1.45, 3.38]]) k.box(0.07, 0.6, 0.07, GSE_DARK, at(x, 1.55, z));
  // exhaust and grab rails
  k.cyl(0.07, 0.07, 0.7, 8, STEEL, at(-1.25, 1.55, 3.2));
  k.box(2.4, 0.06, 0.06, STEEL, at(0, 1.6, 3.62));
  // bumpers: black rubber across the front ends and the back
  for (const s of [-1, 1]) k.box(0.95, 0.35, 0.18, RUBBER, at(s * 1.05, 0.45, -3.62));
  k.box(3.0, 0.4, 0.2, RUBBER, at(0, 0.45, 3.62));
  // hazard stripes on the front faces
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) k.box(0.12, 0.2, 0.02, '#151515', at(s * (0.75 + i * 0.28), 1.05, -3.61, 0, 0, 0.6));
  axles(k, [-2.3, 2.3], 2.3, 0.5, 0.42);
  lamps(k, 1.15, 0.95, -3.62, 3.64);
  beaconLens(k, 0.85, 2.23, 2.6);
}

/** A baggage tractor: short bonnet, open cab under a canopy, the tow hitch behind. */
function tractor(k: Kit) {
  k.box(1.3, 0.35, 3.1, CHASSIS, at(0, 0.28, 0));
  // bonnet and front grille
  sideProfile(k, [[-1.65, 0.55], [-0.35, 0.55], [-0.35, 1.25], [-1.25, 1.18], [-1.65, 1.0]], 1.45, GSE);
  k.boxC(1.1, 0.3, 0.03, '#1e1e1e', at(0, 0.8, -1.66));
  // floor, seat and steering column
  k.box(1.45, 0.12, 1.5, GSE_DARK, at(0, 0.6, 0.4));
  k.box(0.6, 0.12, 0.55, '#262626', at(0, 0.95, 0.65));
  k.box(0.6, 0.6, 0.12, '#262626', at(0, 1.0, 0.95));
  k.cyl(0.035, 0.035, 0.6, 6, '#222', at(0, 0.9, -0.15, 0, 0.5));
  k.cyl(0.18, 0.18, 0.04, 12, '#222', at(0, 1.38, -0.32, 0, 1.0));
  // canopy on four posts, a windscreen in front
  for (const [x, z] of [[-0.68, -0.32], [0.68, -0.32], [-0.68, 1.15], [0.68, 1.15]]) k.box(0.06, 1.35, 0.06, CHASSIS, at(x, 0.65, z));
  k.box(1.5, 0.08, 1.65, GSE, at(0, 2.0, 0.4));
  k.boxC(1.3, 0.7, 0.03, '#7895a8', at(0, 1.6, -0.32, 0, -0.08));
  // rear deck and hitch
  k.box(1.45, 0.45, 0.45, GSE, at(0, 0.55, 1.35));
  k.box(0.2, 0.1, 0.35, STEEL, at(0, 0.45, 1.7));
  axles(k, [-1.05, 1.05], 1.2, 0.3, 0.24);
  lamps(k, 0.55, 0.85, -1.67, 1.81);
  beaconLens(k, 0, 2.08, 0.35);
}

/** A covered baggage cart with suitcases inside (`seed` picks the bags' colours). */
function cart(k: Kit, seed: number) {
  k.box(1.5, 0.12, 2.9, CHASSIS, at(0, 0.42, 0));
  k.box(1.55, 0.06, 3.0, GREY, at(0, 0.54, 0));
  // drawbar to the cart (or tractor) ahead
  k.box(0.08, 0.08, 1.0, STEEL, at(0, 0.38, -1.95));
  // posts, the canopy, solid end panels, a curtain half drawn on the left side
  for (const [x, z] of [[-0.72, -1.45], [0.72, -1.45], [-0.72, 1.45], [0.72, 1.45]]) k.box(0.05, 1.35, 0.05, STEEL, at(x, 0.6, z));
  k.box(1.6, 0.08, 3.05, '#3d4f66', at(0, 1.95, 0));
  k.box(1.5, 1.35, 0.05, '#3d4f66', at(0, 0.6, 1.47));
  k.box(1.5, 0.5, 0.05, '#3d4f66', at(0, 1.45, -1.47));
  k.box(0.04, 1.3, 1.6, '#4b6380', at(-0.74, 0.62, 0.7));
  // the bags: a seeded jumble of colours and sizes
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const bags = ['#2b2b2b', '#5a2a82', '#c0392b', '#1f5f99', '#2e7d32', '#e0a526', '#555b66', '#7b3f20', '#ff6f91'];
  for (let i = 0; i < 9; i++) {
    const w = 0.45 + rnd() * 0.25;
    const h = 0.25 + rnd() * 0.3;
    const d = 0.6 + rnd() * 0.25;
    const z = -1.1 + (i % 4) * 0.72;
    const x = (i < 4 ? -0.36 : 0.36) + (rnd() - 0.5) * 0.08;
    const y = 0.57 + (i >= 8 ? 0.5 : 0);
    k.box(w, h, d, bags[Math.floor(rnd() * bags.length)], at(x, y, z, (rnd() - 0.5) * 0.3));
  }
  axles(k, [-1.0, 1.0], 1.3, 0.22, 0.16);
}

/** A ULD dolly carrying one LD3 container (the aluminium box with the slanted lower side). */
function dolly(k: Kit, label: string) {
  k.box(1.7, 0.14, 3.0, CHASSIS, at(0, 0.36, 0));
  k.box(1.75, 0.06, 3.1, GREY, at(0, 0.5, 0));
  for (let i = 0; i < 5; i++) k.cyl(0.04, 0.04, 1.6, 6, STEEL, at(0, 0.58, -1.2 + i * 0.6, 0, 0, Math.PI / 2));
  k.box(0.08, 0.08, 1.0, STEEL, at(0, 0.34, -1.95));
  // the LD3: across the dolly, its contour on the right
  const ld3: [number, number][] = [[-0.78, 0], [0.78, 0], [1.23, 0.62], [1.23, 1.63], [-0.78, 1.63]];
  const s = new THREE.Shape(ld3.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.53, bevelEnabled: false }).translate(-0.22, 0, -0.765);
  k.add(g, '#c9cdd2', at(0, 0.62, 0, Math.PI / 2));
  // its door's frame and the label band
  k.boxC(0.03, 1.4, 1.3, '#8b9198', at(-0.77, 1.45, 0));
  k.boxC(0.035, 0.18, 1.2, label, at(-0.78, 2.0, 0));
  axles(k, [-1.05, 1.05], 1.45, 0.2, 0.15);
}

/** A self-propelled belt loader: the belt rises to the front, the driver sits low at the back. */
function belt(k: Kit) {
  k.box(1.7, 0.45, 7.2, CHASSIS, at(0, 0.3, 0.1));
  k.box(2.0, 0.35, 3.0, GSE, at(0, 0.7, 2.1));
  // the boom: an inclined frame carrying the belt (tip at the hold's sill, ~2.1 m)
  const tilt = Math.atan2(2.15 - 1.0, 7.4);
  const boom = (dy: number, w: number, h: number, c: string) => k.boxC(w, h, 7.6, c, at(0, 1.55 + dy, -0.15, 0, tilt));
  boom(-0.12, 1.25, 0.22, GSE_DARK);
  boom(0.02, 1.0, 0.06, RUBBER);
  for (const s of [-1, 1]) k.boxC(0.06, 0.32, 7.6, GSE, at(s * 0.62, 1.68, -0.15, 0, tilt));
  // handrails along the top
  for (const s of [-1, 1]) k.boxC(0.04, 0.04, 5.0, '#e7e7e7', at(s * 0.62, 2.55, -1.2, 0, tilt));
  // the lifting struts and the front bumper pad
  for (const s of [-1, 1]) k.box(0.1, 1.0, 0.12, STEEL, at(s * 0.5, 0.75, -2.3));
  k.boxC(1.3, 0.25, 0.25, RUBBER, at(0, 2.05, -3.95));
  // the driver's seat and dashboard, back left
  k.box(0.75, 0.55, 0.8, GSE, at(-0.6, 1.05, 2.4));
  k.box(0.55, 0.55, 0.12, '#262626', at(-0.6, 1.25, 2.85));
  k.box(0.06, 1.15, 0.06, CHASSIS, at(-0.95, 1.05, 2.0));
  k.box(0.85, 0.06, 1.1, GSE, at(-0.6, 2.18, 2.45));
  axles(k, [-2.4, 2.6], 1.55, 0.36, 0.26);
  lamps(k, 0.75, 0.8, -3.47, 3.72);
  beaconLens(k, -0.7, 2.21, 2.2);
}

/** The catering truck's chassis and cab (the box on its scissor lift is a separate part). */
function catering(k: Kit) {
  k.box(1.9, 0.5, 9.4, CHASSIS, at(0, 0.45, 0));
  // the cab up front
  sideProfile(k, [[-4.85, 0.75], [-2.4, 0.75], [-2.4, 2.95], [-4.4, 2.95], [-4.8, 2.3]], 2.4, WHITE);
  sideProfile(k, [[-4.82, 1.75], [-4.4, 2.82], [-3.7, 2.82], [-3.7, 1.75]], 2.42, GLASS, 0, CAB_GLOW);
  k.boxC(1.9, 0.35, 0.05, '#333', at(0, 1.05, -4.84));
  k.box(2.4, 0.18, 2.5, CANDY, at(0, 0.95, -3.62));
  // the scissor base and the platform's front bridge (folded)
  k.box(2.2, 0.35, 6.0, STEEL, at(0, 0.95, 1.6));
  axles(k, [-3.5, 2.4, 3.6], 2.0, 0.48, 0.38);
  lamps(k, 0.95, 0.85, -4.86, 4.72);
  beaconLens(k, 0, 2.98, -2.7);
}

/** The catering box: a galley-cart container with its front platform and handrails, the scissor under it. */
function cateringBox(k: Kit) {
  k.box(2.5, 2.55, 6.4, WHITE, at(0, 0, 0.1));
  k.box(2.52, 0.4, 6.42, CANDY, at(0, 0.3, 0.1));
  k.box(2.52, 0.12, 6.42, '#ffc23d', at(0, 0.75, 0.1));
  // the front platform that docks at the door, with rails and a bumper
  k.box(2.0, 0.12, 1.1, STEEL, at(0, 0, -3.65));
  for (const s of [-1, 1]) k.box(0.05, 1.0, 1.1, '#e7e7e7', at(s * 0.95, 0.12, -3.65));
  k.boxC(1.9, 0.18, 0.18, RUBBER, at(0, 0.1, -4.2));
  // the roller door at the front, the roof lamps
  k.boxC(1.7, 2.2, 0.04, '#d5d8dc', at(0, 1.2, -3.12));
  // the scissor arms below the floor
  for (const s of [-1, 1]) for (const d of [-1, 1]) k.boxC(0.12, 0.14, 5.4, STEEL, at(s * 0.9, -1.05, 0.4, 0, d * 0.38));
}

/** A refuelling bowser: cab, elliptic tank, the hose cabinet at the back. */
function bowser(k: Kit) {
  k.box(1.9, 0.5, 9.8, CHASSIS, at(0, 0.45, 0));
  sideProfile(k, [[-5.1, 0.75], [-2.9, 0.75], [-2.9, 3.0], [-4.6, 3.0], [-5.05, 2.3]], 2.45, WHITE);
  sideProfile(k, [[-5.07, 1.8], [-4.6, 2.88], [-3.9, 2.88], [-3.9, 1.8]], 2.47, GLASS, 0, CAB_GLOW);
  k.box(2.47, 0.3, 2.2, BLUE, at(0, 1.05, -4.0));
  // the tank: an elliptic barrel on the chassis
  const tank = new THREE.CylinderGeometry(1.0, 1.0, 6.0, 20, 1).rotateX(Math.PI / 2).scale(1.22, 1.05, 1);
  k.add(tank, '#e9ecef', at(0, 2.0, 0.6));
  k.add(new THREE.CylinderGeometry(1.01, 1.01, 0.5, 20, 1, true).rotateX(Math.PI / 2).scale(1.22, 1.05, 1), BLUE, at(0, 2.0, 0.2));
  for (const z of [-2.3, 3.5]) k.add(new THREE.SphereGeometry(1.0, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(z < 0 ? -Math.PI / 2 : Math.PI / 2).scale(1.22, 1.05, 0.35), '#e9ecef', at(0, 2.0, z + (z < 0 ? -0.1 : 0.1)));
  // the walkway rail on top, the hose cabinet and reel at the back
  k.box(0.5, 0.05, 5.0, GREY, at(0, 3.05, 0.6));
  for (const s of [-1, 1]) k.box(0.04, 0.45, 5.0, '#d7d7d7', at(s * 0.3, 3.05, 0.6));
  k.box(2.3, 1.6, 1.1, GREY, at(0, 0.75, 4.35));
  k.cyl(0.45, 0.45, 0.4, 14, '#1c1c1c', at(0, 2.2, 4.35, 0, 0, Math.PI / 2));
  axles(k, [-3.8, 2.6, 3.8], 2.0, 0.5, 0.4);
  lamps(k, 0.95, 0.9, -5.11, 4.92);
  beaconLens(k, 0, 3.02, -3.3);
}

/** A low-floor apron bus: wide doors both sides, glass all round, lit inside at night. */
function bus(k: Kit) {
  const L = 14;
  const W = 3.0;
  k.box(W - 0.2, 0.35, L - 0.6, CHASSIS, at(0, 0.18, 0));
  // the body: white skirt, a glazed band, the roof
  k.box(W, 0.75, L, WHITE, at(0, 0.35, 0));
  k.box(W + 0.01, 0.16, L + 0.01, BLUE, at(0, 0.62, 0));
  k.box(W - 0.06, 1.55, L - 0.08, GLASS, at(0, 1.1, 0), WINDOW_GLOW);
  k.box(W, 0.35, L, WHITE, at(0, 2.65, 0));
  k.box(W + 0.01, 0.1, L + 0.01, CANDY, at(0, 2.62, 0));
  // pillars between the windows, door frames
  for (let i = 0; i <= 8; i++) for (const s of [-1, 1]) k.box(0.05, 1.55, 0.14, WHITE, at((s * W) / 2, 1.1, -L / 2 + 0.2 + i * ((L - 0.4) / 8)));
  // the roof's air conditioning pods
  for (const z of [-4, 0.5, 4.5]) k.box(1.8, 0.3, 2.0, '#d8dbdf', at(0, 3.0, z));
  // driver's end: a darker windscreen, the bumper
  k.boxC(W - 0.3, 1.4, 0.05, '#18232c', at(0, 1.8, -L / 2 - 0.01));
  k.boxC(W, 0.3, 0.12, '#333', at(0, 0.5, -L / 2 - 0.04));
  k.boxC(W, 0.3, 0.12, '#333', at(0, 0.5, L / 2 + 0.04));
  axles(k, [-4.6, 4.6], 2.45, 0.42, 0.34);
  lamps(k, 1.2, 0.75, -L / 2 - 0.02, L / 2 + 0.02);
  beaconLens(k, 0, 3.0, -6.2);
}

/** The follow-me car: a yellow estate in black-and-yellow chequers with its lit roof sign. */
function followme(k: Kit) {
  sideProfile(k, [[-2.4, 0.3], [2.4, 0.3], [2.4, 1.05], [2.2, 1.45], [0.2, 1.48], [-0.7, 1.05], [-2.35, 0.95]], 1.85, '#ffd21f');
  sideProfile(k, [[-0.62, 1.07], [0.25, 1.43], [2.15, 1.42], [2.3, 1.08]], 1.87, GLASS, 0, CAB_GLOW);
  // chequers along each side
  for (const s of [-1, 1]) for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) k.boxC(0.01, 0.16, 0.36, '#111', at((s * 1.86) / 2, 0.5 + j * 0.16, -2.0 + i * 0.36));
  // the roof sign, lit at night
  k.box(1.25, 0.42, 0.32, '#111', at(0, 1.5, 0.3));
  k.boxC(1.15, 0.3, 0.02, '#ffe14a', at(0, 1.71, 0.13), SIGN_GLOW);
  k.boxC(1.15, 0.3, 0.02, '#ffe14a', at(0, 1.71, 0.47), SIGN_GLOW);
  axles(k, [-1.45, 1.45], 1.55, 0.32, 0.22);
  lamps(k, 0.7, 0.75, -2.41, 2.41);
  beaconLens(k, 0, 1.92, 0.3);
}

/** A towable ground power unit: a box on wheels with its cable coiled on top. */
function gpu(k: Kit) {
  k.box(1.4, 1.2, 2.4, GSE, at(0, 0.45, 0.2));
  k.box(1.42, 0.1, 2.42, GSE_DARK, at(0, 1.62, 0.2));
  for (let i = 0; i < 6; i++) k.boxC(0.02, 0.6, 0.06, '#3a3a3a', at(0.71, 1.0, -0.4 + i * 0.22));
  k.add(new THREE.TorusGeometry(0.35, 0.06, 6, 14).rotateX(Math.PI / 2), '#111', at(0, 1.72, 0.4));
  k.box(0.07, 0.07, 1.2, STEEL, at(0, 0.4, -1.6));
  axles(k, [-0.6, 1.0], 1.25, 0.26, 0.18);
}

/** An airport crash tender (6×6): forward cab, the water tank body, roof and bumper turrets. */
function fire(k: Kit) {
  const L = 12;
  k.box(2.4, 0.6, L - 0.6, CHASSIS, at(0, 0.5, 0));
  // the cab: tall windscreen sloping back, crew doors
  sideProfile(k, [[-6.0, 0.9], [-3.4, 0.9], [-3.4, 3.35], [-5.1, 3.35], [-5.95, 2.1]], 2.95, FIRE_RED);
  sideProfile(k, [[-5.92, 2.15], [-5.1, 3.25], [-4.4, 3.25], [-4.4, 2.15]], 2.97, GLASS, 0, CAB_GLOW);
  // the body: lockers, the tank, a white band and hi-vis chevrons
  k.box(3.0, 2.45, 8.2, FIRE_RED, at(0, 0.9, 1.75));
  k.box(3.02, 0.22, 8.22, WHITE, at(0, 1.6, 1.75));
  k.box(3.02, 0.14, 8.22, HIVIS, at(0, 1.85, 1.75));
  for (let i = 0; i < 5; i++) k.boxC(0.02, 1.0, 0.05, '#8f1712', at(1.51, 2.6, -1.6 + i * 1.6));
  for (let i = 0; i < 5; i++) k.boxC(0.02, 1.0, 0.05, '#8f1712', at(-1.51, 2.6, -1.6 + i * 1.6));
  for (let i = 0; i < 6; i++) k.boxC(1.4, 0.22, 0.03, i % 2 ? HIVIS : FIRE_RED, at(0, 0.7 + i * 0.22, L / 2 - 0.06));
  // the roof turret (monitor) on the cab, the bumper turret low in front
  k.cyl(0.25, 0.3, 0.3, 10, '#dcdcdc', at(0, 3.35, -4.5));
  k.cyl(0.12, 0.14, 1.6, 8, '#dcdcdc', at(0, 3.55, -4.5, 0, Math.PI / 2 - 0.15));
  k.cyl(0.08, 0.1, 0.8, 8, '#dcdcdc', at(0, 0.95, -6.0, 0, Math.PI / 2));
  // light bars on the cab roof and ladder rack
  k.box(2.0, 0.14, 0.28, '#e02420', at(0, 3.36, -3.7));
  k.box(0.6, 0.12, 6.5, GREY, at(0.9, 3.36, 2.0));
  axles(k, [-3.6, 2.4, 4.4], 2.35, 0.62, 0.5);
  lamps(k, 1.2, 1.05, -6.01, L / 2 + 0.02);
}

/** A main-deck cargo loader (for the freighter), its platform up at the door. */
function hiloader(k: Kit) {
  k.box(3.2, 0.5, 9.2, CHASSIS, at(0, 0.35, 0));
  k.box(3.5, 0.3, 9.4, GSE, at(0, 0.85, 0));
  // front platform raised to the main deck sill, the rear one lower
  for (const [z, y, l] of [[-2.6, 3.35, 4.2], [2.6, 1.45, 4.0]] as const) {
    k.box(3.4, 0.25, l, GSE_DARK, at(0, y, z));
    for (let i = 0; i < 8; i++) k.cyl(0.05, 0.05, 3.3, 6, STEEL, at(0, y + 0.25, z - l / 2 + 0.3 + i * (l / 8), 0, 0, Math.PI / 2));
    for (const s of [-1, 1]) for (const d of [-1, 1]) k.boxC(0.12, 0.16, Math.max(1, (y - 1.1) * 2.2), STEEL, at(s * 1.3, (y + 1.1) / 2, z, 0, d * 0.55));
  }
  for (const s of [-1, 1]) k.box(0.05, 1.0, 4.2, '#e7e7e7', at(s * 1.68, 3.6, -2.6));
  // the operator's cab on the right
  k.box(1.0, 1.6, 1.2, GLASS, at(1.25, 1.15, 4.0), CAB_GLOW);
  k.box(1.1, 0.1, 1.3, GSE, at(1.25, 2.75, 4.0));
  axles(k, [-3.5, -1.2, 1.2, 3.5], 2.6, 0.33, 0.3);
  beaconLens(k, 1.5, 2.85, 4.0);
}

/** A white service van with an orange band. */
function van(k: Kit) {
  sideProfile(k, [[-2.7, 0.35], [2.7, 0.35], [2.7, 2.35], [-1.6, 2.35], [-2.65, 1.25]], 1.95, WHITE);
  sideProfile(k, [[-2.6, 1.3], [-1.62, 2.22], [-1.0, 2.22], [-1.0, 1.3]], 1.97, GLASS, 0, CAB_GLOW);
  k.box(1.97, 0.25, 5.4, ORANGE, at(0, 0.95, 0));
  k.box(1.2, 0.12, 0.3, '#e02420', at(0, 2.35, -0.6));
  axles(k, [-1.75, 1.8], 1.65, 0.36, 0.24);
  lamps(k, 0.78, 0.8, -2.71, 2.71);
  beaconLens(k, 0, 2.47, -0.6);
}

/** A ground crew member in a hi-vis vest and ear defenders (the arms are separate parts). */
function crew(k: Kit) {
  // legs (dark trousers with reflective bands), boots
  for (const s of [-1, 1]) {
    k.cyl(0.075, 0.065, 0.82, 6, '#22262e', at(s * 0.1, 0.06, 0));
    k.cyl(0.078, 0.078, 0.05, 6, '#c9d0d6', at(s * 0.1, 0.3, 0));
    k.box(0.12, 0.08, 0.26, '#111', at(s * 0.1, 0, -0.04));
  }
  // torso: hi-vis vest with silver stripes, over a dark top
  k.cyl(0.17, 0.15, 0.62, 8, HIVIS, at(0, 0.86, 0));
  k.cyl(0.172, 0.17, 0.05, 8, '#d5dadf', at(0, 1.05, 0));
  k.cyl(0.178, 0.176, 0.05, 8, '#d5dadf', at(0, 1.3, 0));
  k.cyl(0.08, 0.1, 0.12, 8, SKIN, at(0, 1.48, 0));
  // head, cap, ear defenders
  k.add(new THREE.SphereGeometry(0.11, 10, 8), SKIN, at(0, 1.66, 0));
  k.add(new THREE.SphereGeometry(0.115, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#1f2d4a', at(0, 1.69, 0));
  k.box(0.18, 0.02, 0.1, '#1f2d4a', at(0, 1.69, -0.12));
  for (const s of [-1, 1]) k.cyl(0.05, 0.05, 0.06, 8, '#e02420', at(s * 0.12, 1.66, 0, 0, 0, Math.PI / 2));
}

/** An arm hanging from the shoulder (origin at the shoulder, pointing down), with a marshalling wand. */
function arm(k: Kit) {
  k.cyl(0.05, 0.045, 0.32, 6, HIVIS, at(0, -0.32, 0));
  k.cyl(0.045, 0.04, 0.28, 6, '#22262e', at(0, -0.6, 0));
  k.add(new THREE.SphereGeometry(0.045, 6, 4), SKIN, at(0, -0.63, 0));
  k.cyl(0.025, 0.025, 0.1, 6, '#111', at(0, -0.74, 0));
  k.cyl(0.03, 0.025, 0.42, 6, ORANGE, at(0, -1.16, 0), [2.4, 0.9, 0.2, 0]);
}

const BUILDERS: Record<VehicleKind, (k: Kit, variant: number) => void> = {
  tug,
  tractor,
  cart: (k, v) => cart(k, v),
  dolly: (k, v) => dolly(k, ['#ff4d6d', '#2f6fd6', '#2ec4b6', '#ffc23d'][v % 4]),
  belt,
  catering,
  cateringBox,
  bowser,
  bus,
  followme,
  gpu,
  fire,
  hiloader,
  van,
  crew,
  armL: arm,
  armR: arm,
};

/** How many looks some kinds come in (carts with different bags, dollies with different labels). */
const VARIANTS: Partial<Record<VehicleKind, number>> = { cart: 3, dolly: 4 };

const geoCache = new Map<string, THREE.BufferGeometry>();
/** A vehicle's geometry (cached; `variant` picks among a kind's looks). */
export function vehicleGeometry(kind: VehicleKind, variant = 0) {
  const v = variant % (VARIANTS[kind] ?? 1);
  const key = `${kind}:${v}`;
  let g = geoCache.get(key);
  if (!g) {
    const k = new Kit();
    BUILDERS[kind](k, v);
    g = k.build();
    geoCache.set(key, g);
  }
  return g;
}

// ------------------------------------------------------------------------------------------------
// The shared material
// ------------------------------------------------------------------------------------------------

/** Every vehicle at every airport lights up from this one night level. */
export const VEHICLE_NIGHT: NightUniform = { uNight: { value: 0 } };
let vehicleMat: THREE.MeshStandardMaterial | null = null;
function vehicleMaterial() {
  vehicleMat ??= kitMaterial(VEHICLE_NIGHT, { roughness: 0.55, metalness: 0.15 }, 'vehicles');
  return vehicleMat;
}

// ------------------------------------------------------------------------------------------------
// The fleet: all of an airport's vehicles in one batched mesh
// ------------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4();

export class Fleet {
  readonly mesh: THREE.BatchedMesh;
  private readonly geoIds = new Map<string, number>();
  private readonly origin: THREE.Vector3;

  /** `kinds`: every kind (and variant) this fleet will hold, with how many of each, so the batch is sized once. */
  constructor(origin: THREE.Vector3, kinds: { kind: VehicleKind; variant?: number; count: number }[], shadows: boolean) {
    this.origin = origin.clone();
    let verts = 0;
    let index = 0;
    let instances = 0;
    const geos: { key: string; g: THREE.BufferGeometry }[] = [];
    for (const k of kinds) {
      const key = `${k.kind}:${(k.variant ?? 0) % (VARIANTS[k.kind] ?? 1)}`;
      instances += k.count;
      if (geos.some((g) => g.key === key)) continue;
      const g = vehicleGeometry(k.kind, k.variant);
      geos.push({ key, g });
      verts += g.attributes.position.count;
      index += g.index!.count;
    }
    this.mesh = new THREE.BatchedMesh(Math.max(1, instances), Math.max(3, verts), Math.max(3, index), vehicleMaterial());
    for (const { key, g } of geos) this.geoIds.set(key, this.mesh.addGeometry(g));
    this.mesh.position.copy(this.origin);
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = shadows;
    this.mesh.name = 'airside-vehicles';
  }

  /** Adds a vehicle (parked out of sight until it's placed). */
  add(kind: VehicleKind, variant = 0) {
    const key = `${kind}:${variant % (VARIANTS[kind] ?? 1)}`;
    const g = this.geoIds.get(key);
    if (g === undefined) throw new Error(`fleet has no ${key}`);
    const id = this.mesh.addInstance(g);
    this.mesh.setMatrixAt(id, _m.makeTranslation(0, -100, 0));
    return id;
  }

  /** Puts vehicle `id` at a world position, facing `heading` (degrees), pitched / rolled (radians). */
  place(id: number, x: number, y: number, z: number, heading: number, pitch = 0, roll = 0) {
    this.mesh.setMatrixAt(id, at(x - this.origin.x, y, z - this.origin.z, -heading * DEG, pitch, roll));
  }

  /** Places with a ready-made matrix in the airport's local frame. */
  placeMatrix(id: number, m: THREE.Matrix4) {
    this.mesh.setMatrixAt(id, m);
  }

  show(id: number, on: boolean) {
    this.mesh.setVisibleAt(id, on);
  }
}

// ------------------------------------------------------------------------------------------------
// Drivers: vehicles going round their loops
// ------------------------------------------------------------------------------------------------

/** Something on the ground others must keep clear of: a vehicle, a cart, an aircraft. */
export interface Body {
  x: number;
  z: number;
  /** Heading (deg), half-length and half-width (m). */
  heading: number;
  hl: number;
  hw: number;
}

/** A stop on a route: where (distance along it), for how long, and what the vehicle does there. */
export interface Stop {
  s: number;
  dwell: number;
  /** The catering box goes up to the door while stopped; a belt loader's crew walk; a bus loads. */
  work?: 'lift';
}

export interface RouteSpec {
  kind: VehicleKind;
  variant?: number;
  path: Path;
  /** Top speed (m/s) and where to start along the path. */
  vmax: number;
  start: number;
  stops?: Stop[];
  /** Carts towed behind (a baggage train), each this kind. */
  train?: { kind: VehicleKind; count: number };
}

const LAT_ACC = 1.1; // m/s² round corners
const ACC = 1.2;
const BRAKE = 2.2;
const GAP = 3.0; // metres kept clear ahead

interface Driver {
  spec: RouteSpec;
  id: number;
  carts: number[];
  s: number;
  v: number;
  pose: Pose2;
  body: Body;
  cartBodies: Body[];
  cartPoses: Pose2[];
  nextStop: number;
  dwell: number;
  /** The catering box's lift (0 down .. 1 at the door). */
  lift: number;
  boxId: number;
  lampBase: number;
  /** Who is in my way (index of a body), for breaking ties at crossings. */
  waitingFor: number;
}

/** How far a cart's centre trails the one ahead (m). */
const CART_PITCH: Partial<Record<VehicleKind, number>> = { cart: 4.1, dolly: 4.1 };

const _p = { x: 0, z: 0, heading: 0 };

/**
 * Moves the vehicles round their routes. Each driver brakes for corners, its next stop and
 * anything in its lane ahead (other vehicles, their carts, aircraft passed in through `obstacles`).
 */
export class Drivers {
  private readonly drivers: Driver[] = [];
  private readonly bodies: Body[] = [];
  /** Which driver each body belongs to (−1: an outside obstacle). */
  private readonly owner: number[] = [];
  readonly lamps: Lamps;
  private readonly lampSpecs: LampSpec[] = [];
  private readonly origin: THREE.Vector3;

  constructor(
    private readonly fleet: Fleet,
    routes: RouteSpec[],
    origin: THREE.Vector3,
  ) {
    this.origin = origin.clone();
    for (const spec of routes) {
      const id = fleet.add(spec.kind, spec.variant ?? 0);
      const carts: number[] = [];
      for (let i = 0; i < (spec.train?.count ?? 0); i++) carts.push(fleet.add(spec.train!.kind, i + (spec.variant ?? 0)));
      const V = VEHICLE[spec.kind];
      const d: Driver = {
        spec,
        id,
        carts,
        s: spec.path.norm(spec.start),
        v: 0,
        pose: { x: 0, z: 0, heading: 0 },
        body: { x: 0, z: 0, heading: 0, hl: V.l / 2, hw: V.w / 2 },
        cartBodies: carts.map(() => ({ x: 0, z: 0, heading: 0, hl: VEHICLE[spec.train!.kind].l / 2, hw: VEHICLE[spec.train!.kind].w / 2 })),
        cartPoses: carts.map(() => ({ x: 0, z: 0, heading: 0 })),
        nextStop: 0,
        dwell: 0,
        lift: 0,
        boxId: spec.kind === 'catering' ? fleet.add('cateringBox') : -1,
        lampBase: this.lampSpecs.length,
        waitingFor: -1,
      };
      // the first stop still ahead of where it starts
      const stops = spec.stops ?? [];
      d.nextStop = stops.length ? Math.max(0, stops.findIndex((st) => st.s >= d.s)) : 0;
      this.drivers.push(d);
      // lamps: the beacon, then two headlamps
      if (V.beacon) this.lampSpecs.push({ x: 0, y: 0, z: 0, r: 2.6, g: 1.2, b: 0.15, size: 0.28, mode: 'beacon', day: 0.55, phase: Math.random() });
      if (V.head) for (let i = 0; i < 2; i++) this.lampSpecs.push({ x: 0, y: 0, z: 0, r: 2.2, g: 2.1, b: 1.9, size: 0.3, mode: 'steady', day: 0 });
    }
    this.lamps = new Lamps(this.lampSpecs, origin, true);
    for (const d of this.drivers) this.pose(d);
    this.rebuildBodies();
  }

  /** The bodies of every vehicle and cart (read by the airside to keep its aircraft's tug clear). */
  get all(): readonly Body[] {
    return this.bodies;
  }

  private rebuildBodies() {
    this.bodies.length = 0;
    this.owner.length = 0;
    this.drivers.forEach((d, i) => {
      this.bodies.push(d.body);
      this.owner.push(i);
      for (const c of d.cartBodies) {
        this.bodies.push(c);
        this.owner.push(i);
      }
    });
  }

  /**
   * Advances every driver. `obstacles` are outside bodies to give way to (aircraft taxiing or
   * being pushed). `detail` false skips the per-frame matrix and lamp updates (nobody's looking).
   */
  update(dt: number, obstacles: readonly Body[], detail: boolean) {
    const n = this.drivers.length;
    for (let i = 0; i < n; i++) this.drive(i, dt, obstacles);
    if (!detail) return;
    for (const d of this.drivers) this.pose(d);
    this.lamps.commit();
  }

  private drive(i: number, dt: number, obstacles: readonly Body[]) {
    const d = this.drivers[i];
    const sp = d.spec;
    const stops = sp.stops ?? [];
    // at a stop: wait (the catering box goes up and down meanwhile)
    if (d.dwell > 0) {
      d.dwell -= dt;
      const st = stops[(d.nextStop - 1 + stops.length) % stops.length];
      if (st?.work === 'lift') {
        const up = Math.min(1, (st.dwell - d.dwell) / 25);
        const down = Math.min(1, d.dwell / 25);
        d.lift = Math.max(0, Math.min(up, down));
      }
      d.v = 0;
      // done: pull away past the stop (a route with one stop would otherwise find itself there again)
      if (d.dwell <= 0) d.s = sp.path.norm(d.s + 0.5);
      return;
    }
    // the speed it may do here: corners ahead, the next stop, anything in the lane
    const look = 6 + (d.v * d.v) / (2 * BRAKE);
    let vt = curveSpeed(sp.path.radiusAhead(d.s, look + 4), LAT_ACC, sp.vmax);
    if (stops.length) {
      const st = stops[d.nextStop];
      let ds = st.s - d.s;
      if (sp.path.closed && ds < 0) ds += sp.path.length;
      vt = Math.min(vt, Math.max(0.6, stopSpeed(ds, BRAKE * 0.6)));
      if (ds < 0.4) {
        d.s = st.s;
        d.dwell = st.dwell;
        d.nextStop = (d.nextStop + 1) % stops.length;
        d.v = 0;
        return;
      }
    } else if (!sp.path.closed) {
      vt = Math.min(vt, stopSpeed(sp.path.length - d.s, BRAKE * 0.6));
    }
    const gap = this.clearAhead(i, d, obstacles, look + 10);
    if (gap < Infinity) vt = Math.min(vt, stopSpeed(gap - GAP, BRAKE));
    d.v = vt > d.v ? Math.min(vt, d.v + ACC * dt) : Math.max(vt, d.v - BRAKE * 1.5 * dt);
    d.s = sp.path.norm(d.s + d.v * dt);
    // keep the bodies current for the others (cheap: no matrices here)
    sp.path.at(d.s, d.pose);
    copyBody(d.body, d.pose);
    let s = d.s - d.body.hl;
    d.cartPoses.forEach((cp, j) => {
      const pitch = CART_PITCH[sp.train!.kind] ?? 4;
      s -= j === 0 ? pitch / 2 + 0.6 : pitch;
      sp.path.at(sp.path.norm(s), cp);
      copyBody(d.cartBodies[j], cp);
    });
  }

  /** The distance to the nearest body in this driver's lane ahead (Infinity if clear). */
  private clearAhead(i: number, d: Driver, obstacles: readonly Body[], range: number) {
    const f = headingVec(d.pose.heading);
    let best = Infinity;
    d.waitingFor = -1;
    const test = (b: Body, k: number, ownerIdx: number) => {
      if (ownerIdx === i) return;
      const dx = b.x - d.pose.x;
      const dz = b.z - d.pose.z;
      const reach = range + b.hl;
      if (dx * dx + dz * dz > reach * reach) return;
      const ahead = dx * f.x + dz * f.z;
      if (ahead <= 0) return;
      const lat = Math.abs(dx * -f.z + dz * f.x);
      // the other's extent across my lane, by how it lies
      const rel = (b.heading - d.pose.heading) * DEG;
      const across = Math.abs(Math.sin(rel)) * b.hl + Math.abs(Math.cos(rel)) * b.hw;
      const along = Math.abs(Math.cos(rel)) * b.hl + Math.abs(Math.sin(rel)) * b.hw;
      if (lat > d.body.hw + across + 0.6) return;
      // two drivers in each other's way at a crossing: the lower number goes first
      if (ownerIdx >= 0) {
        const o = this.drivers[ownerIdx];
        if (o.waitingFor >= 0 && this.owner[o.waitingFor] === i && ownerIdx > i) return;
      }
      const gap = ahead - d.body.hl - along;
      if (gap < best) {
        best = gap;
        d.waitingFor = k;
      }
    };
    for (let k = 0; k < this.bodies.length; k++) test(this.bodies[k], k, this.owner[k]);
    for (const b of obstacles) test(b, -1, -1);
    return best;
  }

  private pose(d: Driver) {
    const sp = d.spec;
    sp.path.at(d.s, d.pose);
    copyBody(d.body, d.pose);
    this.fleet.place(d.id, d.pose.x, 0, d.pose.z, d.pose.heading);
    if (d.boxId >= 0) {
      // the box rides 1.25 m up on the chassis, and lifts to the cabin door's sill
      const y = 1.3 + d.lift * (A320_POINTS.doorL1.y - 1.3 - 0.05);
      const f = headingVec(d.pose.heading);
      this.fleet.place(d.boxId, d.pose.x + f.x * 0.6, y, d.pose.z + f.z * 0.6, d.pose.heading);
    }
    d.carts.forEach((c, j) => {
      const cp = d.cartPoses[j];
      this.fleet.place(c, cp.x, 0, cp.z, cp.heading);
    });
    // the lamps follow the vehicle
    const V = VEHICLE[sp.kind];
    let li = d.lampBase;
    const f = headingVec(d.pose.heading);
    const rx = -f.z;
    const rz = f.x;
    const put = (lx: number, ly: number, lz: number) => {
      // vehicle frame: −z forward, +x right
      this.lamps.move(li++, d.pose.x + rx * lx - f.x * lz - this.origin.x, ly, d.pose.z + rz * lx - f.z * lz - this.origin.z);
    };
    if (V.beacon) put(V.beacon[0], V.beacon[1], V.beacon[2]);
    if (V.head) {
      put(-V.head[0], V.head[1], V.head[2]);
      put(V.head[0], V.head[1], V.head[2]);
    }
  }

  /** Clock and night level for the lamps. */
  setTime(t: number, night: number) {
    this.lamps.update(t, night);
  }

  dispose() {
    this.lamps.dispose();
  }
}

function copyBody(b: Body, p: Pose2) {
  b.x = p.x;
  b.z = p.z;
  b.heading = p.heading;
}

// ------------------------------------------------------------------------------------------------
// The pushback tug
// ------------------------------------------------------------------------------------------------

/** Where the nose wheel sits in the tug's cradle, from the tug's centre (m, forward). */
const CRADLE = 2.1;
const TUG_SPEED = 4;

let tugMesh: THREE.BufferGeometry | null = null;

/**
 * A pushback tug. It waits by its stand's equipment area; attached, it holds the aircraft's nose
 * wheel and goes wherever the aircraft's pose takes it (the flight attraction drives the pose
 * along the pushback); detached, it backs off and drives home to wait for the next one.
 */
export class PushbackTug {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly lamps: Lamps;
  private readonly ap: Airport;
  private home: Pose2;
  private pose: Pose2;
  private mode: 'idle' | 'attaching' | 'attached' | 'returning' = 'idle';
  private blend = 0;
  private from: Pose2 = { x: 0, z: 0, heading: 0 };
  /** Where it's heading for while attached: holding the nose wheel. */
  private readonly target: Pose2 = { x: 0, z: 0, heading: 0 };
  /** Going home after a detach: first reversing out, then the drive. */
  private reversePath: Path | null = null;
  private path: Path | null = null;
  private s = 0;
  private v = 0;
  private lastNose: P2 | null = null;
  private wheelHeading = 0;
  private reverse = false;

  constructor(ctx: Ctx, ap: Airport, standId: string = ap.playerStand) {
    this.ap = ap;
    tugMesh ??= vehicleGeometry('tug');
    this.mesh = new THREE.Mesh(tugMesh, vehicleMaterial());
    this.mesh.castShadow = ctx.quality.shadows;
    this.mesh.receiveShadow = ctx.quality.shadows;
    this.group.add(this.mesh);
    const V = VEHICLE.tug;
    const specs: LampSpec[] = [
      { x: V.beacon![0], y: V.beacon![1], z: V.beacon![2], r: 2.6, g: 1.2, b: 0.15, size: 0.3, mode: 'beacon', day: 0.6, phase: Math.random() },
      { x: -V.head![0], y: V.head![1], z: V.head![2], r: 2.2, g: 2.1, b: 1.9, size: 0.3, mode: 'steady', day: 0 },
      { x: V.head![0], y: V.head![1], z: V.head![2], r: 2.2, g: 2.1, b: 1.9, size: 0.3, mode: 'steady', day: 0 },
    ];
    this.lamps = new Lamps(specs, new THREE.Vector3());
    this.group.add(this.lamps.points);
    this.group.name = 'pushback-tug';
    this.home = tugHome(ap, standId);
    this.pose = { ...this.home };
    this.apply();
  }

  /** The tug's place now (for others to keep clear of). */
  get body(): Body {
    const b = this._body;
    b.x = this.pose.x;
    b.z = this.pose.z;
    b.heading = this.pose.heading;
    return b;
  }
  private readonly _body: Body = { x: 0, z: 0, heading: 0, hl: VEHICLE.tug.l / 2, hw: VEHICLE.tug.w / 2 };

  /** Whether it's holding an aircraft. */
  get attached() {
    return this.mode === 'attaching' || this.mode === 'attached';
  }

  /** Drive in under the nose of the aircraft at this stand (it's there in a few seconds). */
  attach(standId: string) {
    const st = this.ap.stands.find((s) => s.id === standId) ?? this.ap.stands[0];
    this.home = tugHome(this.ap, standId);
    this.from = { ...this.pose };
    this.mode = 'attaching';
    this.blend = 0;
    this.lastNose = null;
    this.wheelHeading = st.heading;
    // until the first pose arrives it waits at the parked aircraft's nose
    const f = headingVec(st.heading);
    this.target.x = st.x + f.x * (-A320_POINTS.noseGear.z + CRADLE);
    this.target.z = st.z + f.z * (-A320_POINTS.noseGear.z + CRADLE);
    this.target.heading = (st.heading + 180) % 360;
  }

  /**
   * The aircraft's reference-point pose this frame (heading in degrees): the tug holds its nose
   * wheel, facing the aircraft, turned the way the nose wheel is rolling.
   */
  follow(pose: { x: number; z: number; heading: number }, dt: number) {
    if (!this.attached) return;
    const f = headingVec(pose.heading);
    const nz = -A320_POINTS.noseGear.z;
    const nx = pose.x + f.x * nz;
    const nzw = pose.z + f.z * nz;
    // the nose wheel's direction of roll is the steering angle the tug sets
    if (this.lastNose) {
      const dx = nx - this.lastNose.x;
      const dz = nzw - this.lastNose.z;
      const moved = Math.hypot(dx, dz);
      if (moved > 0.02) {
        let h = (Math.atan2(dx, -dz) / DEG + 360) % 360;
        // rolling backwards: the wheel points the other way
        if (Math.abs(wrap180(h - pose.heading)) > 90) h = (h + 180) % 360;
        // never more than the nose gear's steering limit
        const rel = Math.max(-75, Math.min(75, wrap180(h - pose.heading)));
        const want = pose.heading + rel;
        this.wheelHeading += wrap180(want - this.wheelHeading) * Math.min(1, dt * 4);
      } else this.wheelHeading += wrap180(pose.heading - this.wheelHeading) * Math.min(1, dt * 0.5);
    } else this.wheelHeading = pose.heading;
    this.lastNose = { x: nx, z: nzw };
    const w = headingVec(this.wheelHeading);
    this.target.x = nx + w.x * CRADLE;
    this.target.z = nzw + w.z * CRADLE;
    this.target.heading = (this.wheelHeading + 180) % 360;
    if (this.mode === 'attaching') {
      this.blend = Math.min(1, this.blend + dt / 4);
      if (this.blend >= 1) this.mode = 'attached';
    }
    this.apply();
  }

  /** Let go: back away from the nose and drive home. */
  detach() {
    if (!this.attached) return;
    const f = headingVec(this.pose.heading);
    const p0 = { x: this.pose.x, z: this.pose.z };
    // reverse out (away from the aircraft), then round to its waiting spot
    const back = { x: p0.x - f.x * 14, z: p0.z - f.z * 14 };
    this.reversePath = new Path([p0, back], 8);
    const h = headingVec(this.home.heading);
    const approach = { x: this.home.x - h.x * 18, z: this.home.z - h.z * 18 };
    this.path = new Path([back, { x: (back.x + approach.x) / 2, z: back.z }, approach, { x: this.home.x, z: this.home.z }], 14);
    this.reverse = true;
    this.s = 0;
    this.v = 0;
    this.mode = 'returning';
    this.lastNose = null;
  }

  /** Drives home after a detach; call every frame. */
  update(dt: number, t: number, night: number) {
    this.lamps.update(t, night);
    if (this.mode !== 'returning') return;
    const path = this.reverse ? this.reversePath : this.path;
    if (!path) return;
    const vmax = this.reverse ? 1.5 : TUG_SPEED;
    const left = path.length - this.s;
    const vt = Math.min(vmax, curveSpeed(path.radiusAhead(this.s, 10), 0.8, vmax), Math.max(0.3, stopSpeed(left, 0.8)));
    this.v = vt > this.v ? Math.min(vt, this.v + 0.8 * dt) : vt;
    this.s = Math.min(path.length, this.s + this.v * dt);
    path.at(this.s, _p);
    this.pose.x = _p.x;
    this.pose.z = _p.z;
    this.pose.heading = this.reverse ? (_p.heading + 180) % 360 : _p.heading;
    if (this.s >= path.length - 0.05) {
      if (this.reverse) {
        this.reverse = false;
        this.s = 0;
        this.v = 0;
      } else {
        this.mode = 'idle';
        this.pose = { ...this.home };
      }
    }
    this.place();
  }

  private apply() {
    if (this.mode === 'attaching') {
      const k = this.blend * this.blend * (3 - 2 * this.blend);
      this.pose.x = this.from.x + (this.target.x - this.from.x) * k;
      this.pose.z = this.from.z + (this.target.z - this.from.z) * k;
      this.pose.heading = this.from.heading + wrap180(this.target.heading - this.from.heading) * k;
    } else if (this.mode === 'attached') {
      this.pose.x = this.target.x;
      this.pose.z = this.target.z;
      this.pose.heading = this.target.heading;
    }
    this.place();
  }

  private place() {
    this.group.position.set(this.pose.x, 0, this.pose.z);
    this.group.rotation.set(0, -this.pose.heading * DEG, 0);
  }

  /** Go back to waiting at a stand straight away (e.g. when a flight is abandoned). */
  reset(standId: string = this.ap.playerStand) {
    this.home = tugHome(this.ap, standId);
    this.pose = { ...this.home };
    this.mode = 'idle';
    this.place();
  }

  dispose() {
    this.group.removeFromParent();
    this.lamps.dispose();
  }
}

/**
 * Where a stand's tug waits: beside the nose, in the equipment area towards the terminal, parked
 * along the head of the stand facing the way it will drive in.
 */
export function tugHome(ap: Airport, standId: string): Pose2 {
  const st = ap.stands.find((s) => s.id === standId) ?? ap.stands[0];
  const f = headingVec(st.heading);
  // the stand's right (when the aircraft faces the terminal)
  const rx = -f.z;
  const rz = f.x;
  const ahead = -A320_POINTS.noseGear.z + 5.5;
  return { x: st.x + f.x * ahead + rx * 13, z: st.z + f.z * ahead + rz * 13, heading: (st.heading + 180) % 360 };
}

// ------------------------------------------------------------------------------------------------
// People: the ground crew and the marshaller
// ------------------------------------------------------------------------------------------------

/** A crew member's arms: angles (radians) raising each arm forward/up from hanging. */
export interface ArmPose {
  /** Raise (0 hanging, π/2 straight out to the side, π straight up) and swing forward. */
  leftUp: number;
  rightUp: number;
  leftFwd: number;
  rightFwd: number;
}

const SHOULDER = { x: 0.2, y: 1.42 };

/** Places a crew member (body and both arms) in the fleet. */
export function placeCrew(fleet: Fleet, ids: [number, number, number], x: number, z: number, heading: number, arms: ArmPose, origin: THREE.Vector3) {
  fleet.place(ids[0], x, 0, z, heading);
  const yaw = -heading * DEG;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (const side of [-1, 1] as const) {
    const up = side < 0 ? arms.leftUp : arms.rightUp;
    const fwd = side < 0 ? arms.leftFwd : arms.rightFwd;
    // the shoulder in the world, then the arm rolled out to its side and swung forward
    const lx = side * SHOULDER.x;
    const wx = x + c * lx;
    const wz = z - s * lx;
    _e.set(fwd, yaw, side * up, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_v.set(wx - origin.x, SHOULDER.y, wz - origin.z), _q, _one);
    fleet.placeMatrix(ids[side < 0 ? 1 : 2], _m);
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/** The arm positions a marshaller uses (ICAO signals), and a ground crew member at rest. */
/** The waving signals write here (one marshaller moves at a time; nothing is allocated per frame). */
const _wave: ArmPose = { leftUp: 0, rightUp: 0, leftFwd: 0, rightFwd: 0 };
function wave(up: number, fwd: number): ArmPose {
  _wave.leftUp = _wave.rightUp = up;
  _wave.leftFwd = _wave.rightFwd = fwd;
  return _wave;
}

export const SIGNALS = {
  rest: { leftUp: 0.12, rightUp: 0.12, leftFwd: 0.1, rightFwd: 0.1 },
  /** "This way / come ahead": both wands up, bent, waved towards the head. */
  ahead: (t: number) => wave(2.4 + 0.35 * Math.sin(t * 5), 0.5),
  /** "Slow down": both arms out and down, patted up and down. */
  slow: (t: number) => wave(1.05 + 0.25 * Math.sin(t * 4), 0.6),
  /** "Stop": the wands crossed above the head. */
  stop: { leftUp: 2.75, rightUp: 2.75, leftFwd: 0.2, rightFwd: 0.2 },
  /** "Engines started / all clear": a thumbs-up arm out to the side. */
  clear: { leftUp: 0.12, rightUp: 1.55, leftFwd: 0.1, rightFwd: 0.3 },
} as const;
