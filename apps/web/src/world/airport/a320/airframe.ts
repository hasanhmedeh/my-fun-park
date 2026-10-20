// Builds the A320neo's airframe as one skinned geometry per detail level (see mesh.ts): fuselage
// with real door openings, the wing with its slats, Fowler flaps, ailerons and spoiler panels,
// the sharklets, the tail, the LEAP-1A nacelles and pylons, and both landing gears. Every part is
// bound to its bone (rig.ts) and UV-mapped into the shared atlas (atlas.ts).
//
// Detail levels: 'hero' (the player's aircraft: fine sections, 3D fan blades, probes, antennas,
// static wicks), 'ai' (taxiing and flying traffic) and 'parked' (stands and remote parking, also
// the far LOD of the others). They share the same bones, so any level animates the same way.

import * as THREE from 'three';
import { fusUv, swatchUv, wingUv, type Swatch, type UV } from './atlas';
import { SkinBuilder, type Vec } from './mesh';
import { BONE, noseRetracted, sideBones, wingPt, type Side } from './rig';
import {
  CANOES,
  CARGO,
  DOOR,
  DOORS,
  FLAPS,
  NOSE_BAY,
  NOSE_Z,
  SHARKLET,
  SLATS,
  SPLIT,
  SPOILERS,
  TAIL_Z,
  WING,
  airfoil,
  fuselage as FUS,
  sAtHeight,
  sAtKeelOffset,
  skinAt,
  wingChord,
  wingLeZ,
  wingPoint,
  wingTc,
  wingTeZ,
  wingTwist,
  wingY,
} from './shape';

export type Detail = 'hero' | 'ai' | 'parked';

interface Lod {
  /** Fuselage columns round the section, and station spacing (m) in the nose, the cabin and the tail. */
  ring: number;
  step: [number, number, number];
  /** Airfoil points per surface, spanwise station spacing (m). */
  foil: number;
  span: number;
  /** Segments round the nacelles, wheels and struts. */
  nac: number;
  wheel: number;
  strut: number;
  /** 3D fan blades (else a painted spinning disc), probes / antennas / wicks. */
  blades: boolean;
  extras: boolean;
}
const LODS: Record<Detail, Lod> = {
  hero: { ring: 76, step: [0.11, 0.42, 0.22], foil: 26, span: 0.75, nac: 56, wheel: 30, strut: 12, blades: true, extras: true },
  ai: { ring: 38, step: [0.3, 1.1, 0.55], foil: 12, span: 2.2, nac: 26, wheel: 16, strut: 7, blades: false, extras: false },
  parked: { ring: 22, step: [0.6, 2.4, 1.1], foil: 7, span: 6, nac: 16, wheel: 10, strut: 5, blades: false, extras: false },
};

const sw = (n: Swatch) => swatchUv(n);
const DEG = Math.PI / 180;
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec): Vec => scl(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const xf = (m: THREE.Matrix4, p: Vec): Vec => {
  const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
  return [v.x, v.y, v.z];
};

/** Sorted stations: the regular ones plus the required ones (which win when they crowd each other). */
function stations(regular: number[], required: number[], minGap: number) {
  const req = [...new Set(required.map((v) => Math.round(v * 1e6) / 1e6))];
  const out = [...req];
  for (const v of regular) if (req.every((r) => Math.abs(r - v) > minGap)) out.push(v);
  return out.sort((a, b) => a - b);
}
const nearest = (arr: number[], v: number) => arr.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(arr[bi] - v) ? i : bi), 0);

// ------------------------------------------------------------------------------------------------
// Primitive helpers
// ------------------------------------------------------------------------------------------------

/**
 * A surface of revolution. `place(a, r, θ)` puts profile point (a along the axis, r out from it)
 * at angle θ; `outRow` is a profile row on an outer surface, whose normals must face away from the
 * axis (the rest follow the profile's direction, so inner walls listed the other way face in),
 * or towards it with `inward` (a duct's inner wall).
 */
function lathe(
  b: SkinBuilder,
  prof: [number, number][],
  segs: number,
  place: (a: number, r: number, th: number) => Vec,
  o: { bone: number; uv: (row: number, round: number, a: number, r: number) => UV; outRow?: number; inward?: boolean; matrix?: THREE.Matrix4 },
) {
  const rows = prof.length;
  const cols = segs + 1;
  const P: Vec[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) P.push(place(prof[r][0], prof[r][1], ((c % segs) / segs) * Math.PI * 2));
  const R = o.outRow ?? 0;
  const at = (r: number, c: number) => P[r * cols + c];
  const dc = sub(at(R, 1), at(R, segs - 1));
  const dr = sub(at(Math.min(rows - 1, R + 1), 0), at(Math.max(0, R - 1), 0));
  const n: Vec = [dc[1] * dr[2] - dc[2] * dr[1], dc[2] * dr[0] - dc[0] * dr[2], dc[0] * dr[1] - dc[1] * dr[0]];
  const axis = place(prof[R][0], 0, 0);
  const radial = sub(at(R, 0), axis);
  const outward = n[0] * radial[0] + n[1] * radial[1] + n[2] * radial[2] >= 0;
  const sign = outward !== !!o.inward ? 1 : -1;
  b.grid(P, rows, cols, { bone: o.bone, wrap: true, sign, matrix: o.matrix, uv: (r, c) => o.uv(r, c / segs, prof[r][0], prof[r][1]) });
}

/** A cylinder (or cone) from a to c. */
function rod(b: SkinBuilder, a: Vec, c: Vec, r0: number, segs: number, bone: number, uv: UV, r1 = r0, caps = true) {
  const d = sub(c, a);
  const len = Math.hypot(d[0], d[1], d[2]);
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, 1, !caps);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...unit(d)));
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...add(a, scl(d, 0.5))), q, new THREE.Vector3(1, 1, 1));
  b.geometry(g, m, bone, uv);
}

function box(b: SkinBuilder, centre: Vec, size: Vec, bone: number, uv: UV, rot: [number, number, number] = [0, 0, 0]) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...centre), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));
  b.geometry(new THREE.BoxGeometry(...size), m, bone, uv);
}

// ------------------------------------------------------------------------------------------------
// Fuselage
// ------------------------------------------------------------------------------------------------

interface Hole {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  bone: number;
  thick: number;
  inner: Swatch;
  matrix?: THREE.Matrix4;
}
interface Liner {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  depth: number;
  swatch: Swatch;
  walls: { r0: boolean; r1: boolean; c0: boolean; c1: boolean };
}

function fuselageBody(b: SkinBuilder, L: Lod) {
  const [sn, sm, st] = L.step;
  const noseLen = 5.6;
  const regular: number[] = [];
  const nN = Math.ceil(noseLen / sn);
  // stations cluster towards the nose tip so the radome stays round
  for (let i = 0; i <= nN; i++) regular.push(NOSE_Z + noseLen * (i / nN) ** 1.6);
  const zA = NOSE_Z + noseLen;
  const nM = Math.ceil((8 - zA) / sm);
  for (let i = 1; i < nM; i++) regular.push(zA + ((8 - zA) * i) / nM);
  const nT = Math.ceil((TAIL_Z - 8) / st);
  for (let i = 0; i <= nT; i++) regular.push(8 + ((TAIL_Z - 8) * i) / nT);
  const dz = (d: { z: number }) => [d.z - DOOR.w / 2, d.z + DOOR.w / 2];
  const required = [NOSE_Z, TAIL_Z, ...dz(DOORS.L1), ...dz(DOORS.L2), CARGO.fwd.z0, CARGO.fwd.z1, CARGO.aft.z0, CARGO.aft.z1, NOSE_BAY.z0, NOSE_BAY.zSplit, NOSE_BAY.z1];
  const zs = stations(regular, required, Math.min(sn, 0.25) * 0.45);

  const bayMid = (NOSE_BAY.z0 + NOSE_BAY.z1) / 2;
  const fwdMid = (CARGO.fwd.z0 + CARGO.fwd.z1) / 2;
  const aftMid = (CARGO.aft.z0 + CARGO.aft.z1) / 2;
  const cut = {
    l1: [sAtHeight(DOORS.L1.z, 'L', DOOR.sill), sAtHeight(DOORS.L1.z, 'L', DOOR.sill + DOOR.h)],
    l2: [sAtHeight(DOORS.L2.z, 'L', DOOR.sill), sAtHeight(DOORS.L2.z, 'L', DOOR.sill + DOOR.h)],
    // right side: s falls as the height rises
    cf: [sAtHeight(fwdMid, 'R', CARGO.y1), sAtHeight(fwdMid, 'R', CARGO.y0)],
    ca: [sAtHeight(aftMid, 'R', CARGO.y1), sAtHeight(aftMid, 'R', CARGO.y0)],
    bay: [sAtKeelOffset(bayMid, 'L', NOSE_BAY.halfW), sAtKeelOffset(bayMid, 'R', NOSE_BAY.halfW)],
  };
  const regularS = Array.from({ length: L.ring + 1 }, (_, i) => i / L.ring);
  const ss = stations(regularS, [0, 1, ...cut.l1, ...cut.l2, ...cut.cf, ...cut.ca, ...cut.bay], 0.35 / L.ring);

  const R = zs.length;
  const C = ss.length;
  const P: Vec[] = new Array(R * C);
  const t = { x: 0, y: 0 };
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      skinAt(zs[r], ss[c], t);
      P[r * C + c] = [t.x, t.y, zs[r]];
    }
  const centre = (z: number): Vec => [0, FUS.wide(z), z];
  const ref = (r: number): Vec => (r === 0 ? [0, FUS.wide(zs[0]), zs[0] + 0.5] : centre(zs[r]));
  const uv = (r: number, c: number) => fusUv(zs[r], ss[c]);
  const zi = (z: number) => nearest(zs, z);
  const si = (s: number) => nearest(ss, s);

  const retract = noseRetracted().invert();
  const bay = { r0: zi(NOSE_BAY.z0), rS: zi(NOSE_BAY.zSplit), r1: zi(NOSE_BAY.z1), cL: si(cut.bay[0]), cR: si(cut.bay[1]) };
  const holes: Hole[] = [
    { r0: zi(DOORS.L1.z - DOOR.w / 2), r1: zi(DOORS.L1.z + DOOR.w / 2), c0: si(cut.l1[0]), c1: si(cut.l1[1]), bone: BONE.doorL1, thick: 0.1, inner: 'interior' },
    { r0: zi(DOORS.L2.z - DOOR.w / 2), r1: zi(DOORS.L2.z + DOOR.w / 2), c0: si(cut.l2[0]), c1: si(cut.l2[1]), bone: BONE.doorL2, thick: 0.1, inner: 'interior' },
    { r0: zi(CARGO.fwd.z0), r1: zi(CARGO.fwd.z1), c0: si(cut.cf[0]), c1: si(cut.cf[1]), bone: BONE.cargoF, thick: 0.07, inner: 'primer' },
    { r0: zi(CARGO.aft.z0), r1: zi(CARGO.aft.z1), c0: si(cut.ca[0]), c1: si(cut.ca[1]), bone: BONE.cargoA, thick: 0.07, inner: 'primer' },
    { r0: bay.r0, r1: bay.rS, c0: 0, c1: bay.cL, bone: BONE.nDoorL, thick: 0.03, inner: 'primer' },
    { r0: bay.r0, r1: bay.rS, c0: bay.cR, c1: C - 1, bone: BONE.nDoorR, thick: 0.03, inner: 'primer' },
    { r0: bay.rS, r1: bay.r1, c0: 0, c1: bay.cL, bone: BONE.nlg, thick: 0.03, inner: 'primer', matrix: retract },
    { r0: bay.rS, r1: bay.r1, c0: bay.cR, c1: C - 1, bone: BONE.nlg, thick: 0.03, inner: 'primer', matrix: retract },
  ];
  const all4 = { r0: true, r1: true, c0: true, c1: true };
  const liners: Liner[] = [
    { ...holes[0], depth: 1.25, swatch: 'interior', walls: all4 },
    { ...holes[1], depth: 1.05, swatch: 'interior', walls: all4 },
    { ...holes[2], depth: 1.1, swatch: 'hold', walls: all4 },
    { ...holes[3], depth: 1.0, swatch: 'hold', walls: all4 },
    { r0: bay.r0, r1: bay.r1, c0: 0, c1: bay.cL, depth: 0.9, swatch: 'well', walls: { r0: true, r1: true, c0: false, c1: true } },
    { r0: bay.r0, r1: bay.r1, c0: bay.cR, c1: C - 1, depth: 0.9, swatch: 'well', walls: { r0: true, r1: true, c0: true, c1: false } },
  ];
  const holeAt = (r: number, c: number) => holes.find((h) => r >= h.r0 && r < h.r1 && c >= h.c0 && c < h.c1);

  b.grid(P, R, C, { bone: BONE.root, uv, wrap: true, ref, skip: (r, c) => !!holeAt(r, c) });

  const inward = (p: Vec, d: number): Vec => {
    const c = centre(p[2]);
    return add(p, scl(unit(sub(c, p)), d));
  };
  const patch = (h: { r0: number; r1: number; c0: number; c1: number }, f: (p: Vec) => Vec) => {
    const out: Vec[] = [];
    for (let r = h.r0; r <= h.r1; r++) for (let c = h.c0; c <= h.c1; c++) out.push(f(P[r * C + c]));
    return out;
  };
  const edges = (h: { r0: number; r1: number; c0: number; c1: number }) => {
    const row = (r: number) => Array.from({ length: h.c1 - h.c0 + 1 }, (_, i) => P[r * C + h.c0 + i]);
    const col = (c: number) => Array.from({ length: h.r1 - h.r0 + 1 }, (_, i) => P[(h.r0 + i) * C + c]);
    return { r0: row(h.r0), r1: row(h.r1), c0: col(h.c0), c1: col(h.c1) };
  };
  const mid = (pts: Vec[]) => scl(pts.reduce((a, p) => add(a, p), [0, 0, 0] as Vec), 1 / pts.length);

  for (const h of holes) {
    // the door itself: the skin patch (exactly flush when shut), an inner face and its edges
    b.grid(P, R, C, { bone: h.bone, uv, wrap: true, ref, skip: (r, c) => holeAt(r, c) !== h, matrix: h.matrix });
    const nr = h.r1 - h.r0 + 1;
    const nc = h.c1 - h.c0 + 1;
    const m = h.matrix;
    const tf = (p: Vec) => (m ? xf(m, p) : p);
    const innerPts = patch(h, (p) => tf(inward(p, h.thick)));
    const zc = (zs[h.r0] + zs[h.r1]) / 2;
    const cRef = tf(centre(zc));
    b.grid(innerPts, nr, nc, { bone: h.bone, uv: sw(h.inner), ref: () => cRef, sign: -1 });
    const e = edges(h);
    const dc = tf(mid([...e.r0, ...e.r1]));
    for (const k of ['r0', 'r1', 'c0', 'c1'] as const) b.strip(e[k].map(tf), e[k].map((p) => tf(inward(p, h.thick))), h.bone, sw(h.inner), dc);
  }
  for (const l of liners) {
    // the opening's lining: walls from the skin inwards, and a back wall
    const nr = l.r1 - l.r0 + 1;
    const nc = l.c1 - l.c0 + 1;
    const back = patch(l, (p) => inward(p, l.depth));
    const zc = (zs[l.r0] + zs[l.r1]) / 2;
    b.grid(back, nr, nc, { bone: BONE.root, uv: sw(l.swatch), ref: () => centre(zc) });
    const e = edges(l);
    const hc = inward(mid([...e.r0, ...e.r1]), l.depth / 2);
    for (const k of ['r0', 'r1', 'c0', 'c1'] as const) if (l.walls[k]) b.strip(e[k], e[k].map((p) => inward(p, l.depth)), BONE.root, sw(l.swatch), hc, true);
  }

  // the tail cone's end and the APU exhaust
  const last = Array.from({ length: C - 1 }, (_, c) => P[(R - 1) * C + c]);
  b.cap(last, [0, 0, 1], BONE.root, sw('metal'));
  const apu: Vec = [0, (FUS.top(TAIL_Z) + FUS.bot(TAIL_Z)) / 2, TAIL_Z];
  rod(b, add(apu, [0, 0, -0.05]), add(apu, [0, 0, 0.12]), 0.14, L.strut + 2, BONE.root, sw('exhaust'), 0.15, false);
  b.cap(Array.from({ length: 14 }, (_, i) => add(apu, [0.13 * Math.cos((i / 14) * Math.PI * 2), 0.13 * Math.sin((i / 14) * Math.PI * 2), 0.08])), [0, 0, 1], BONE.root, sw('dark'));
}

// ------------------------------------------------------------------------------------------------
// Wing
// ------------------------------------------------------------------------------------------------

/** Cosine-spaced chord fractions in [a, b], with both ends. */
function chordSamples(n: number, a: number, b: number) {
  const out: number[] = [];
  for (let k = 0; k <= n; k++) {
    const c = 0.5 * (1 - Math.cos((Math.PI * k) / n));
    if (c > a && c < b) out.push(c);
  }
  return [a, ...out, b];
}

/** A wing-like surface section as (chord fraction, height in chords) pairs. */
type Foil = [number, number][];

function wing(b: SkinBuilder, L: Lod, s: Side) {
  const bn = sideBones(s);
  const regular: number[] = [];
  for (let x = WING.root; x < WING.tip; x += L.span) regular.push(x);
  const req = [WING.root, WING.side, ...SLATS.flatMap((p) => [p.x0, p.x1]), FLAPS.inner.x1, FLAPS.outer.x1, FLAPS.aileron.x1, ...SPOILERS.flatMap((p) => [p.x0, p.x1]), WING.tip];
  const xs = stations(regular, req, L.span * 0.4);
  const n = L.foil;

  const inSlat = (x: number) => SLATS.some((p) => x > p.x0 && x < p.x1);
  const spoilerAt = (x: number) => SPOILERS.findIndex((p) => x > p.x0 && x < p.x1);
  const teBone = (x: number) =>
    x > FLAPS.inner.x0 && x < FLAPS.inner.x1 ? bn.flapIn : x > FLAPS.outer.x0 && x < FLAPS.outer.x1 ? bn.flapOut : x > FLAPS.aileron.x0 && x < FLAPS.aileron.x1 ? bn.ail : BONE.root;

  const pt = (x: number, c: number, h: number): Vec => {
    const p = wingPoint(x, c, h, { y: 0, z: 0 });
    return [s * x, p.y, p.z];
  };
  const uv = (_r: number, _c: number, x: number, _y: number, z: number) => wingUv(Math.abs(x), z);
  /** Lofts a section between two span stations, with optional caps at each end. */
  const piece = (xa: number, xb: number, foil: (x: number) => Foil, bone: number, capA: boolean, capB: boolean, refC: number) => {
    const fa = foil(xa);
    const fb = foil(xb);
    const P: Vec[] = [...fa.map(([c, h]) => pt(xa, c, h)), ...fb.map(([c, h]) => pt(xb, c, h))];
    const refs = [wingPt(s, xa, refC), wingPt(s, xb, refC)];
    b.grid(P, 2, fa.length, { bone, uv, ref: (r) => refs[r] });
    if (capA) b.cap(fa.map(([c, h]) => pt(xa, c, h)), [-s, 0, 0], bone, sw('wingGrey'));
    if (capB) b.cap(fb.map(([c, h]) => pt(xb, c, h)), [s, 0, 0], bone, sw('wingGrey'));
  };
  const flatFace = (xa: number, xb: number, a: [number, number], c: [number, number], bone: number, refC: number, swatch: Swatch) => {
    const P = [pt(xa, ...a), pt(xa, ...c), pt(xb, ...a), pt(xb, ...c)];
    const rf = wingPt(s, (xa + xb) / 2, refC);
    b.grid(P, 2, 2, { bone, uv: sw(swatch), flat: true, ref: () => rf });
  };
  const up = (x: number, c: number) => airfoil(c, wingTc(x)).up;
  const lo = (x: number, c: number) => airfoil(c, wingTc(x)).lo;

  // sections: the leading edge (slat), the box, the trailing edge (flap/aileron, with a rounded nose)
  const leFoil = (x: number): Foil => {
    const cs = chordSamples(n, 0, SPLIT.slat);
    return [...[...cs].reverse().map((c) => [c, up(x, c)] as [number, number]), ...cs.slice(1).map((c) => [c, lo(x, c)] as [number, number])];
  };
  const boxUpper = (cEnd: number) => (x: number): Foil => chordSamples(n, SPLIT.slat, cEnd).map((c) => [c, up(x, c)]);
  const boxLower = (x: number): Foil => chordSamples(n, SPLIT.slat, SPLIT.flap).map((c) => [c, lo(x, c)]);
  const NOSE = 0.032;
  const teFoil = (x: number): Foil => {
    const c0 = SPLIT.flap;
    const cs = chordSamples(Math.max(3, Math.round(n * 0.55)), c0 + NOSE, 1);
    // the flap's top is recessed a little where the spoilers overlap it, so the two never touch
    const upF = (c: number) => up(x, c) - 0.006 * (1 - Math.min(1, Math.max(0, (c - SPLIT.spoilerEnd) / 0.06)));
    const mid = (upF(c0 + NOSE) + lo(x, c0 + NOSE)) / 2;
    const hu = upF(c0 + NOSE) - mid;
    const hl = mid - lo(x, c0 + NOSE);
    const arc: [number, number][] = [];
    const k = Math.max(3, Math.round(n / 3));
    for (let i = 1; i < k; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / k;
      arc.push([c0 + NOSE + NOSE * Math.cos(a), mid + (Math.sin(a) > 0 ? hu : hl) * Math.sin(a)]);
    }
    return [...[...cs].reverse().map((c) => [c, upF(c)] as [number, number]), ...arc, ...cs.map((c) => [c, lo(x, c)] as [number, number])];
  };
  const spoilerFoil = (x: number): Foil => {
    const cs = chordSamples(Math.max(2, Math.round(n / 3)), SPLIT.spoiler, SPLIT.spoilerEnd);
    return [...cs.map((c) => [c, up(x, c) + 0.0008] as [number, number]), ...[...cs].reverse().map((c) => [c, up(x, c) - 0.008] as [number, number])];
  };

  const key = (x: number) => `${inSlat(x)}|${spoilerAt(x)}|${teBone(x)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i];
    const xb = xs[i + 1];
    const xm = (xa + xb) / 2;
    const first = i === 0;
    const last = i === xs.length - 2;
    const prevDiff = first || key(xs[i - 1] + 1e-3 + (xa - xs[i - 1]) / 2) !== key(xm);
    const nextDiff = last || key(xb + (xs[i + 2] - xb) / 2) !== key(xm);
    const slat = inSlat(xm);
    const sp = spoilerAt(xm);
    const te = teBone(xm);
    const cUp = sp >= 0 ? SPLIT.spoiler : SPLIT.flap;
    piece(xa, xb, leFoil, slat ? bn.slat : BONE.root, slat || prevDiff, slat || nextDiff, 0.06);
    piece(xa, xb, boxUpper(cUp), BONE.root, false, false, 0.4);
    piece(xa, xb, boxLower, BONE.root, false, false, 0.4);
    // the box's ends, its front (behind the slat) and its rear spar / spoiler cove
    const boxFoil = (x: number): Foil => [...boxUpper(cUp)(x), ...[...boxLower(x)].reverse()];
    if (prevDiff) b.cap(boxFoil(xa).map(([c, h]) => pt(xa, c, h)), [-s, 0, 0], BONE.root, sw('well'));
    if (nextDiff) b.cap(boxFoil(xb).map(([c, h]) => pt(xb, c, h)), [s, 0, 0], BONE.root, sw('well'));
    flatFace(xa, xb, [SPLIT.slat, up(xm, SPLIT.slat)], [SPLIT.slat, lo(xm, SPLIT.slat)], BONE.root, 0.4, 'well');
    flatFace(xa, xb, [cUp, up(xm, cUp)], [SPLIT.flap, lo(xm, SPLIT.flap)], BONE.root, 0.4, 'well');
    flatFace(xa, xb, [SPLIT.slat, up(xm, SPLIT.slat)], [SPLIT.slat, lo(xm, SPLIT.slat)], slat ? bn.slat : BONE.root, 0.06, 'well');
    piece(xa, xb, teFoil, te, te !== BONE.root || prevDiff, te !== BONE.root || nextDiff, 0.86);
    if (sp >= 0) piece(xa, xb, spoilerFoil, bn.spoiler + sp, true, true, 0.7);
  }

  // flap track fairings ("canoes"): the front fixed under the wing, the aft end rides with the flap
  for (const cx of CANOES) {
    const ch = wingChord(cx);
    const z0 = wingLeZ(cx) + 0.42 * ch;
    const zf = wingLeZ(cx) + SPLIT.flap * ch;
    const z1 = wingTeZ(cx) + 0.95;
    const segs = Math.max(6, Math.round(L.strut * 1.2));
    const ring = (z: number) => {
      const tt = (z - z0) / (z1 - z0);
      const depth = 0.62 * Math.sin(Math.PI * Math.min(1, tt * 1.25) ** 0.7) * (1 - 0.5 * tt);
      const half = 0.17 * Math.sin(Math.PI * Math.min(1, tt * 1.1 + 0.05) ** 0.6);
      const c = (z - wingLeZ(cx)) / ch;
      const top = wingPoint(cx, Math.min(1, c), lo(cx, Math.min(1, c)), { y: 0, z: 0 }).y + 0.1;
      const pts: Vec[] = [];
      for (let k = 0; k <= segs; k++) {
        const a = Math.PI * (k / segs);
        pts.push([s * cx + Math.cos(a) * Math.max(0.01, half), top - Math.sin(a) * Math.max(0.02, depth + 0.1), z]);
      }
      return pts;
    };
    const part = (za: number, zb: number, nz: number, bone: number) => {
      const P: Vec[] = [];
      for (let k = 0; k <= nz; k++) P.push(...ring(za + ((zb - za) * k) / nz));
      b.grid(P, nz + 1, segs + 1, { bone, uv: sw('wingGrey'), ref: () => [s * cx, wingY(cx) + 0.2, (za + zb) / 2] });
    };
    const nz = Math.max(3, Math.round(L.foil / 3));
    part(z0, zf, nz, BONE.root);
    part(zf, z1, nz, bn.flapOut);
  }

  sharklet(b, L, s);
}

/** The sharklet: the tip section bends up and out through a tight curve, then rises swept and tapering. */
function sharklet(b: SkinBuilder, L: Lod, s: Side) {
  const tip = WING.tip;
  const ch0 = WING.tipChord;
  const tw = wingTwist(tip) * DEG;
  const le0 = wingLeZ(tip);
  const y0 = wingY(tip);
  const end = 78 * DEG;
  const R = SHARKLET.bend;
  const straight = (SHARKLET.height - R * (1 - Math.cos(end))) / Math.sin(end);
  const nb = Math.max(2, Math.round(L.foil / 3));
  const ns = Math.max(2, Math.round(L.foil / 4));
  const frames: { o: [number, number]; d: [number, number]; ch: number; le: number }[] = [];
  const arcLen = R * end;
  const total = arcLen + straight;
  for (let k = 0; k <= nb; k++) {
    const a = (end * k) / nb;
    frames.push({ o: [R * Math.sin(a), R * (1 - Math.cos(a))], d: [Math.cos(a), Math.sin(a)], ch: 0, le: 0 });
  }
  const ob = frames[nb].o;
  for (let k = 1; k <= ns; k++) {
    const l = (straight * k) / ns;
    frames.push({ o: [ob[0] + l * Math.cos(end), ob[1] + l * Math.sin(end)], d: [Math.cos(end), Math.sin(end)], ch: 0, le: 0 });
  }
  frames.forEach((f, i) => {
    const along = i <= nb ? (arcLen * i) / nb : arcLen + (straight * (i - nb)) / ns;
    const u = along / total;
    f.ch = ch0 + (SHARKLET.topChord - ch0) * (u ** 0.8);
    f.le = SHARKLET.sweep * u ** 1.25;
  });
  const cs = chordSamples(Math.max(4, Math.round(L.foil * 0.6)), 0, 1);
  const foil: [number, number][] = [...[...cs].reverse().map((c) => [c, airfoil(c, 0.105, 0.01).up] as [number, number]), ...cs.slice(1).map((c) => [c, airfoil(c, 0.105, 0.01).lo] as [number, number])];
  const P: Vec[] = [];
  for (const f of frames) {
    // section plane: chord along +z, thickness along the bend's normal (−sin, cos) in the x–y plane
    const nx = -f.d[1];
    const ny = f.d[0];
    for (const [c, h] of foil) {
      const lc = (c - 0.4) * f.ch;
      const zc = le0 + f.le + 0.4 * f.ch + lc * Math.cos(tw);
      const hh = h * f.ch - lc * Math.sin(tw);
      P.push([s * (tip + f.o[0] + nx * hh), y0 + f.o[1] + ny * hh, zc]);
    }
  }
  const spine = frames.map((f) => [s * (tip + f.o[0]), y0 + f.o[1], le0 + f.le + 0.45 * f.ch] as Vec);
  b.grid(P, frames.length, foil.length, { bone: BONE.root, uv: sw('tail'), ref: (r) => spine[r] });
  const top = P.slice((frames.length - 1) * foil.length);
  b.cap(top, [s * Math.cos(end), Math.sin(end), 0], BONE.root, sw('tail'));
}

export { fuselageBody, wing, lathe, rod, box, chordSamples, LODS, type Lod };
