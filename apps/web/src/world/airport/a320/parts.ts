// The rest of the A320neo's airframe, next to the fuselage and wing in airframe.ts: the fin and
// rudder, the horizontal stabiliser and elevators, the LEAP-1A nacelles with their fans, thrust
// reverser sleeves and pylons, both landing gears with their wheels and doors, and (hero only) the
// probes and antennas that sell the nose at close range. Everything is built in the gear-down,
// surfaces-neutral pose and bound to its bone (rig.ts).

import * as THREE from 'three';
import { fanUv, finUv, nacUv, swatchUv, type Swatch, type UV } from './atlas';
import { SkinBuilder, type Vec } from './mesh';
import { BONE, sideBones, type Side } from './rig';
import { box, chordSamples, lathe, rod, type Lod } from './airframe';
import {
  ENGINE,
  FIN,
  HSTAB,
  MAIN_GEAR,
  NACELLE,
  NOSE_GEAR,
  airfoil,
  finAt,
  fuselage as FUS,
  hstabChord,
  hstabLe,
  hstabY,
  sAtHeight,
  skinAt,
  wingLeZ,
  wingY,
} from './shape';

const sw = (n: Swatch) => swatchUv(n);
const DEG = Math.PI / 180;

/** Station values from a to b about `step` apart, always including both ends and the given splits. */
function range(a: number, b: number, step: number) {
  const n = Math.max(1, Math.round((b - a) / step));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/** Lofts a list of sections (each the same number of points) into one grid. */
function loft(b: SkinBuilder, rows: Vec[][], bone: number, uv: UV | ((p: Vec) => UV), ref: (r: number) => Vec) {
  const cols = rows[0].length;
  const P = rows.flat();
  b.grid(P, rows.length, cols, { bone, ref, uv: typeof uv === 'function' ? (_r, _c, x, y, z) => uv([x, y, z]) : uv });
}

/** A flat disc facing `n`. */
function disc(b: SkinBuilder, c: Vec, n: Vec, r: number, segs: number, bone: number, uv: UV) {
  const nv = new THREE.Vector3(...n).normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(nv.x) > 0.9) u.set(0, 1, 0);
  const v = new THREE.Vector3().crossVectors(nv, u).normalize();
  u.crossVectors(v, nv).normalize();
  const pts: Vec[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push([c[0] + r * (u.x * Math.cos(a) + v.x * Math.sin(a)), c[1] + r * (u.y * Math.cos(a) + v.y * Math.sin(a)), c[2] + r * (u.z * Math.cos(a) + v.z * Math.sin(a))]);
  }
  b.cap(pts, [nv.x, nv.y, nv.z], bone, uv);
}

// ------------------------------------------------------------------------------------------------
// Fin and rudder
// ------------------------------------------------------------------------------------------------

/**
 * The fin, one half (side) at a time so each side maps into its own region of the atlas. The
 * rudder is a separate loft with a rounded nose that sits in the fin's rear cove.
 */
export function fin(b: SkinBuilder, L: Lod) {
  const tc = FIN.tc;
  const step = Math.max(0.35, L.span * 0.6);
  const n = Math.max(5, Math.round(L.foil * 0.75));
  const top = FIN.stations[2].y;
  const pt = (y: number, c: number, side: Side): Vec => {
    const { le, te } = finAt(y);
    const ch = te - le;
    // the dorsal fillet's thick root thins quickly into the fin proper
    const k = 1 + 0.9 * Math.max(0, 1 - (y - FIN.stations[0].y) / 0.9) ** 2;
    return [side * airfoil(c, tc, 0).half * ch * k, y, le + c * ch];
  };
  const uvOf = (side: Side) => (p: Vec) => finUv(p[2], p[1], side < 0 ? 'L' : 'R');
  // each loft's normals face away from a point on its own chord line (mid-fin, mid-rudder)
  const ref = (ys: number[], c = 0.5) => (r: number): Vec => {
    const { le, te } = finAt(ys[r]);
    return [0, ys[r], le + c * (te - le)];
  };
  const half = (ys: number[], c0: number, c1: number, side: Side, bone: number) => {
    const cs = chordSamples(n, c0, c1);
    loft(b, ys.map((y) => cs.map((c) => pt(y, c, side))), bone, uvOf(side), ref(ys));
  };
  const rudderHalf = (ys: number[], side: Side) => {
    // a quarter-round nose from the centreline to the skin at the hinge, then the skin to the trailing edge
    const c0 = FIN.rudder + 0.012;
    const cs = chordSamples(Math.max(3, Math.round(n / 2)), c0, 1);
    const rows = ys.map((y) => {
      const { le, te } = finAt(y);
      const ch = te - le;
      const r = Math.abs(pt(y, c0, side)[0]);
      const nose: Vec[] = [];
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * (i / 4);
        nose.push([side * r * Math.sin(a), y, le + c0 * ch - r * Math.cos(a) * 0.9]);
      }
      return [...nose, ...cs.map((c) => pt(y, c, side))];
    });
    loft(b, rows, BONE.rudder, uvOf(side), ref(ys, (1 + FIN.rudder) / 2));
  };
  const y0 = FIN.stations[0].y;
  const yA = FIN.rudderY0;
  const yB = FIN.rudderY1;
  for (const side of [-1, 1] as Side[]) {
    half(range(y0, yA, step), 0, 1, side, BONE.root);
    half(range(yA, yB, step), 0, FIN.rudder, side, BONE.root);
    half(range(yB, top, step), 0, 1, side, BONE.root);
    rudderHalf(range(yA, yB, step), side);
  }
  // the rudder cove (the fin's spar face behind which the rudder swings), and the tip
  const ys = range(yA, yB, step);
  const cove = (side: Side) => ys.map((y) => pt(y, FIN.rudder, side));
  b.strip(cove(-1), cove(1), BONE.root, sw('dark'), [0, (yA + yB) / 2, 0]);
  const cs = chordSamples(n, 0, 1);
  b.cap([...cs.map((c) => pt(top, c, -1)), ...[...cs].reverse().map((c) => pt(top, c, 1))], [0, 1, 0], BONE.root, sw('tail'));
}

// ------------------------------------------------------------------------------------------------
// Horizontal stabiliser and elevators
// ------------------------------------------------------------------------------------------------

export function stabiliser(b: SkinBuilder, L: Lod, s: Side) {
  const bn = sideBones(s);
  const n = Math.max(5, Math.round(L.foil * 0.7));
  const step = Math.max(0.5, L.span * 0.7);
  const pt = (x: number, c: number, h: number): Vec => {
    const ch = hstabChord(x);
    return [s * x, hstabY(x) + h * ch, hstabLe(x) + c * ch];
  };
  const loop = (x: number, c0: number, c1: number): Vec[] => {
    const cs = chordSamples(n, c0, c1);
    const f = (c: number) => airfoil(c, HSTAB.tc, 0).half;
    return [...[...cs].reverse().map((c) => pt(x, c, f(c))), ...cs.slice(1).map((c) => pt(x, c, -f(c)))];
  };
  const ref = (xs: number[]) => (r: number): Vec => pt(xs[r], 0.45, 0);
  const uv = sw('fuselage');
  const piece = (xs: number[], c0: number, c1: number, bone: number) => loft(b, xs.map((x) => loop(x, c0, c1)), bone, uv, ref(xs));
  const xa = range(HSTAB.root, HSTAB.elevX0, step);
  const xb = range(HSTAB.elevX0, HSTAB.elevX1, step);
  const xc = range(HSTAB.elevX1, HSTAB.tip, step);
  piece(xa, 0, 1, BONE.root);
  piece(xb, 0, HSTAB.elev, BONE.root);
  piece(xc, 0, 1, BONE.root);
  // the elevator: a rounded nose in the stabiliser's cove
  const c0 = HSTAB.elev + 0.012;
  const cs = chordSamples(Math.max(3, Math.round(n / 2)), c0, 1);
  const elevRows = xb.map((x) => {
    const r = airfoil(c0, HSTAB.tc, 0).half;
    const nose: Vec[] = [];
    for (let i = 1; i < 6; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / 6;
      nose.push(pt(x, c0 + r * Math.cos(a) * 0.9, r * Math.sin(a)));
    }
    const f = (c: number) => airfoil(c, HSTAB.tc, 0).half;
    return [...[...cs].reverse().map((c) => pt(x, c, f(c))), ...nose, ...cs.map((c) => pt(x, c, -f(c)))];
  });
  // its normals face away from the elevator's own chord line (the stabiliser's would turn its nose inside out)
  loft(b, elevRows, bn.elev, uv, (r) => pt(xb[r], (1 + HSTAB.elev) / 2, 0));
  const coveA = xb.map((x) => pt(x, HSTAB.elev, airfoil(HSTAB.elev, HSTAB.tc, 0).half));
  const coveB = xb.map((x) => pt(x, HSTAB.elev, -airfoil(HSTAB.elev, HSTAB.tc, 0).half));
  b.strip(coveA, coveB, BONE.root, sw('dark'), pt((HSTAB.elevX0 + HSTAB.elevX1) / 2, 0.3, 0));
  b.cap(loop(HSTAB.tip, 0, 1), [s, 0, 0], BONE.root, uv);
}

// ------------------------------------------------------------------------------------------------
// LEAP-1A nacelle, fan and pylon
// ------------------------------------------------------------------------------------------------

export function nacelle(b: SkinBuilder, L: Lod, s: Side) {
  const bn = sideBones(s);
  const cx = s * ENGINE.x;
  const cy = ENGINE.y;
  const segs = L.nac;
  // θ = 0 at the top, rising outboard, so the painted cowl reads the same way on both engines
  const place = (a: number, r: number, th: number): Vec => [cx + s * r * Math.sin(th), cy + r * Math.cos(th), a];
  const nacRow = (_row: number, round: number, a: number) => nacUv(round, a);
  const swRow = (n: Swatch) => () => sw(n);

  // inlet: the inner barrel (dark acoustic liner) round the polished lip to the cowl
  lathe(b, NACELLE.inlet, segs, place, { bone: BONE.root, outRow: NACELLE.inlet.length - 1, uv: (row) => sw(row < 3 ? 'inlet' : 'chrome') });
  lathe(b, NACELLE.cowl, segs, place, { bone: BONE.root, outRow: 2, uv: nacRow });
  // reverser: the cascades the sleeve uncovers, the translating sleeve itself (outer skin and the bypass nozzle's inner wall)
  const cas = NACELLE.cascade;
  lathe(b, [[cas.z0, cas.r], [cas.z1, cas.r]], segs, place, { bone: BONE.root, outRow: 0, uv: swRow('cascade') });
  lathe(b, NACELLE.sleeve, segs, place, { bone: bn.rev, outRow: 1, uv: (row, round, a) => (row < 4 ? nacUv(round, a) : sw('dark')) });
  lathe(b, NACELLE.duct, Math.max(12, segs >> 1), place, { bone: BONE.root, outRow: 1, inward: true, uv: swRow('dark') });
  // the core: from behind the fan hub, the core cowl out of the bypass nozzle, the exhaust and plug
  lathe(b, [[-9.12, 0.37], [-8.2, 0.5], ...NACELLE.core], Math.max(12, segs >> 1), place, { bone: BONE.root, outRow: 3, uv: (row) => sw(row < 2 ? 'dark' : 'core') });
  lathe(b, NACELLE.plug, Math.max(10, segs >> 1), place, { bone: BONE.root, outRow: 1, uv: swRow('exhaust') });
  const exhaust: Vec[] = [];
  const ring = Math.max(10, segs >> 1);
  for (let i = 0; i <= ring; i++) exhaust.push(place(-4.6, 0.43, (i / ring) * Math.PI * 2));
  for (let i = 0; i <= ring; i++) exhaust.push(place(-4.6, 0.32, (i / ring) * Math.PI * 2));
  b.grid(exhaust, 2, ring + 1, { bone: BONE.root, uv: sw('black'), flat: true, ref: () => [cx, cy, -5.5] });

  // the fan: a dark backing disc, the spinner, and 18 wide-chord blades (or a painted disc)
  const fz = ENGINE.fanZ;
  disc(b, [cx, cy, fz + 0.32], [0, 0, -1], ENGINE.fanR + 0.02, segs, BONE.root, sw('black'));
  const spinner: [number, number][] = [[-9.99, 0.004], [-9.93, 0.1], [-9.8, 0.2], [-9.62, 0.29], [-9.42, 0.35], [-9.2, 0.37]];
  lathe(b, spinner, Math.max(12, segs >> 1), place, { bone: bn.fan, outRow: 3, uv: swRow('spinner') });
  if (L.blades) {
    const blades = ENGINE.blades;
    const nr = 7;
    for (let k = 0; k < blades; k++) {
      const th0 = (k / blades) * Math.PI * 2;
      for (const face of [1, -1]) {
        const P: Vec[] = [];
        for (let i = 0; i <= nr; i++) {
          const r = ENGINE.hubR + ((ENGINE.fanR - ENGINE.hubR) * i) / nr;
          // stagger: steep at the root, flat at the tip; the wide chord sweeps forward at mid-span
          const pitch = (52 - 28 * (i / nr)) * DEG;
          const chord = 0.34 + 0.12 * Math.sin((Math.PI * i) / nr);
          const dth = (chord * Math.cos(pitch)) / r / 2;
          const dz = (chord * Math.sin(pitch)) / 2;
          const sweep = -0.05 * Math.sin((Math.PI * i) / nr);
          for (const e of [-1, 1]) {
            const th = th0 + e * dth;
            const p = place(fz + sweep + e * dz, r, th);
            // a sliver of thickness so the two faces don't coincide
            P.push([p[0] + face * 0.006 * Math.cos(th0) * s, p[1] - face * 0.006 * Math.sin(th0), p[2]]);
          }
        }
        const centre: Vec = [cx, cy, fz];
        b.grid(P, nr + 1, 2, { bone: bn.fan, uv: sw('fanBlade'), flat: true, ref: () => [centre[0] - face * Math.cos(th0) * s * 3, centre[1] + face * Math.sin(th0) * 3, fz] });
      }
    }
  } else {
    const pts: Vec[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(place(fz - 0.02, ENGINE.fanR, a));
    }
    b.cap(pts, [0, 0, -1], bn.fan, (p) => fanUv((p[0] - cx) / ENGINE.fanR * s, (p[1] - cy) / ENGINE.fanR));
  }

  pylon(b, L, s);
}

/**
 * The pylon: a slim blade from the top of the fan cowl up into the wing's leading edge, and its
 * aft fairing under the wing over the core exhaust.
 */
function pylon(b: SkinBuilder, L: Lod, s: Side) {
  const cx = s * ENGINE.x;
  const wy = wingY(ENGINE.x);
  const le = wingLeZ(ENGINE.x);
  const z0 = -8.95;
  const z1 = 1.2;
  const top = (z: number) => {
    // it rises from the cowl into the wing's leading edge, then runs on inside the wing box
    if (z < le) return 3.05 + (wy + 0.02 - 3.05) * Math.min(1, ((z - z0) / (le - z0)) ** 0.55);
    return wy - 0.02;
  };
  const bot = (z: number) => {
    // hidden inside the cowl and sleeve, down onto the core behind the bypass nozzle, then up to the wing's lower skin
    if (z < -6.0) return 2.9;
    if (z < -4.3) return 2.5;
    return 2.5 + (wy - 0.14 - 2.5) * ((z + 4.3) / (z1 + 4.3)) ** 1.2;
  };
  const halfW = (z: number) => 0.06 + 0.27 * Math.sin(Math.PI * Math.min(1, Math.max(0, (z - z0) / (z1 - z0))) ** 0.7);
  const zs = range(z0, z1, Math.max(0.35, L.span * 0.5));
  const cols = Math.max(8, L.strut + 4);
  const rows = zs.map((z) => {
    const t = top(z);
    const bo = Math.min(bot(z), t - 0.08);
    const h = (t - bo) / 2;
    const yc = (t + bo) / 2;
    const w = halfW(z);
    const pts: Vec[] = [];
    for (let i = 0; i <= cols; i++) {
      const a = (i / cols) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pts.push([cx + w * Math.sign(sn) * Math.abs(sn) ** 0.6, yc + h * Math.sign(c) * Math.abs(c) ** 0.35, z]);
    }
    return pts;
  });
  const ref = (r: number): Vec => [cx, (top(zs[r]) + bot(zs[r])) / 2, zs[r]];
  b.grid(rows.flat(), zs.length, cols + 1, { bone: BONE.root, uv: sw('white'), wrap: true, ref });
  b.cap(rows[0].slice(0, cols), [0, 0, -1], BONE.root, sw('white'));
}

// ------------------------------------------------------------------------------------------------
// Landing gear
// ------------------------------------------------------------------------------------------------

/** A tyre (and its hub faces) about an axle along x, centred at c. */
function wheel(b: SkinBuilder, L: Lod, c: Vec, R: number, w: number, hubR: number, bone: number) {
  const h = w / 2;
  const prof: [number, number][] = [
    [-h, hubR],
    [-h, R * 0.82],
    [-h + w * 0.05, R * 0.925],
    [-h + w * 0.16, R * 0.985],
    [-h + w * 0.3, R],
    [h - w * 0.3, R],
    [h - w * 0.16, R * 0.985],
    [h - w * 0.05, R * 0.925],
    [h, R * 0.82],
    [h, hubR],
  ];
  const place = (a: number, r: number, th: number): Vec => [c[0] + a, c[1] + r * Math.cos(th), c[2] + r * Math.sin(th)];
  lathe(b, prof, L.wheel, place, { bone, outRow: 4, uv: () => sw('tyre') });
  for (const e of [-1, 1]) {
    disc(b, [c[0] + e * h, c[1], c[2]], [e, 0, 0], hubR, L.wheel, bone, sw('hub'));
    if (L.extras) {
      // the hub's bolt circle and cap: they make the wheel's spin visible
      rod(b, [c[0] + e * h, c[1], c[2]], [c[0] + e * (h + 0.03), c[1], c[2]], hubR * 0.45, 12, bone, sw('metal'));
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        box(b, [c[0] + e * (h + 0.01), c[1] + hubR * 0.7 * Math.cos(a), c[2] + hubR * 0.7 * Math.sin(a)], [0.03, 0.05, 0.05], bone, sw('dark'));
      }
    }
  }
}

export function mainGear(b: SkinBuilder, L: Lod, s: Side) {
  const bn = sideBones(s);
  const X = s * MAIN_GEAR.x;
  const z = MAIN_GEAR.z;
  const R = MAIN_GEAR.wheelR;
  const segs = L.strut;
  // the leg (shock strut cylinder), its chrome piston, the axle and brake housings, torque links
  rod(b, [X, MAIN_GEAR.trunnionY + 0.05, z], [X, 1.22, z], 0.15, segs, bn.mlg, sw('metal'));
  rod(b, [X, MAIN_GEAR.trunnionY + 0.02, z - 0.25], [X, MAIN_GEAR.trunnionY + 0.02, z + 0.25], 0.12, segs, bn.mlg, sw('metal'));
  rod(b, [X, 1.42, z], [X, 0.7, z], 0.105, segs, bn.oleo, sw('chrome'));
  box(b, [X, 0.66, z], [0.34, 0.24, 0.3], bn.oleo, sw('metal'));
  rod(b, [X - 0.5, R, z], [X + 0.5, R, z], 0.075, segs, bn.oleo, sw('metal'));
  box(b, [X, 1.36, z - 0.19], [0.07, 0.36, 0.06], bn.mlg, sw('metal'), [0.35, 0, 0]);
  box(b, [X, 1.0, z - 0.19], [0.07, 0.36, 0.06], bn.oleo, sw('metal'), [-0.35, 0, 0]);
  // the side stay, folding up into the wing root
  rod(b, [X, 1.6, z + 0.06], [X - s * 1.2, 2.5, z + 0.06], 0.055, segs, bn.mlg, sw('metal'));
  // the leg door on the outboard side (it closes the leg's slot under the wing when the gear is up)
  box(b, [X + s * 0.21, 1.8, z], [0.035, 1.22, 0.74], bn.mlg, sw('belly'));
  for (const e of [-1, 1]) {
    const wx = X + e * MAIN_GEAR.spread;
    // brake stack inside the wheel
    if (L.extras) rod(b, [wx - 0.16, R, z], [wx + 0.16, R, z], 0.24, 12, bn.oleo, sw('dark'));
    wheel(b, L, [wx, R, z], R, MAIN_GEAR.tyreW, 0.31, bn.wheel);
  }
}

export function noseGear(b: SkinBuilder, L: Lod) {
  const z = NOSE_GEAR.z;
  const R = NOSE_GEAR.wheelR;
  const segs = L.strut;
  rod(b, [0, NOSE_GEAR.trunnionY + 0.05, z], [0, 1.12, z], 0.1, segs, BONE.nlg, sw('metal'));
  rod(b, [-0.24, NOSE_GEAR.trunnionY, z], [0.24, NOSE_GEAR.trunnionY, z], 0.08, segs, BONE.nlg, sw('metal'));
  rod(b, [0, 1.3, z], [0, 0.5, z], 0.07, segs, BONE.nOleo, sw('chrome'));
  // the steering collar and fork turn with the wheels
  box(b, [0, 0.47, z], [0.22, 0.16, 0.2], BONE.nSteer, sw('metal'));
  rod(b, [-0.38, R, z], [0.38, R, z], 0.05, segs, BONE.nSteer, sw('metal'));
  // the drag brace, folding forward into the bay
  rod(b, [0, 1.45, z - 0.05], [0, NOSE_GEAR.trunnionY + 0.02, z - 1.2], 0.045, segs, BONE.nlg, sw('metal'));
  // the taxi and runway turn-off lights on the leg
  box(b, [0, 1.72, z - 0.14], [0.42, 0.15, 0.12], BONE.nlg, sw('metal'));
  for (const x of [-0.13, 0, 0.13]) disc(b, [x, 1.72, z - 0.205], [x * 2, 0, -1], 0.055, 10, BONE.nlg, sw('lens'));
  for (const e of [-1, 1]) wheel(b, L, [e * NOSE_GEAR.spread, R, z], R, NOSE_GEAR.tyreW, 0.19, BONE.nWheel);
}

// ------------------------------------------------------------------------------------------------
// Probes and antennas (hero only)
// ------------------------------------------------------------------------------------------------

export function extras(b: SkinBuilder) {
  const onSkin = (z: number, side: 'L' | 'R', y: number, out: number): Vec => {
    const p = skinAt(z, sAtHeight(z, side, y), { x: 0, y: 0 });
    const c = FUS.wide(z);
    const d = Math.hypot(p.x, p.y - c) || 1;
    return [p.x + (p.x / d) * out, p.y + ((p.y - c) / d) * out, z];
  };
  // pitot probes (three: two left, one right) and angle-of-attack vanes on the nose's sides
  for (const [z, side, y] of [[-15.25, 'L', 4.15], [-15.0, 'L', 3.75], [-15.25, 'R', 4.15]] as const) {
    const a = onSkin(z, side, y, 0);
    const c = onSkin(z, side, y, 0.13);
    rod(b, a, c, 0.018, 6, BONE.root, sw('metal'));
    rod(b, c, [c[0], c[1], c[2] - 0.16], 0.012, 6, BONE.root, sw('metal'));
  }
  for (const side of ['L', 'R'] as const) {
    const a = onSkin(-14.6, side, 4.45, 0.04);
    box(b, a, [0.02, 0.07, 0.14], BONE.root, sw('dark'), [0, 0, side === 'L' ? 0.3 : -0.3]);
  }
  // VHF blades on the crown and the forward belly (well clear of the tail cone's strike line)
  for (const [z, up] of [[-4.2, true], [6.2, true], [-10.4, false]] as const) {
    // a swept blade: its foot buried in the skin, its tip raked aft
    const y = up ? FUS.top(z) + 0.1 : FUS.bot(z) - 0.1;
    box(b, [0, y, z], [0.03, 0.26, 0.2], BONE.root, sw('antenna'), [up ? -0.5 : 0.5, 0, 0]);
  }
}
