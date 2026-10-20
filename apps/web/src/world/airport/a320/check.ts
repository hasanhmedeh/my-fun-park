// Logic checks for the A320neo model (run by scripts/a320-check.mjs): the built airframe against
// the published dimensions and the flight model's airframe points (A320_POINTS), the triangle
// budgets of each detail level, and the moving parts posed on the CPU exactly as the vertex shader
// skins them (gear retracting into the belly, flaps running aft and down, doors opening clear).

import * as THREE from 'three';
import { A320, A320_POINTS } from '../../../aviation/a320';
import type { PlaneVisual } from '../../../aviation/types';
import { airframeGeometry } from './build';
import type { Detail } from './airframe';
import { Pose } from './pose';
import { BONE } from './rig';
import { skinAt, sAtHeight } from './shape';

export interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
}

function rest(): PlaneVisual {
  return {
    flapsDeg: 0,
    slatsDeg: 0,
    gear: 1,
    aileron: 0,
    elevator: 0,
    rudder: 0,
    spoilerL: 0,
    spoilerR: 0,
    reverser: 0,
    n1: [0, 0],
    nosewheel: 0,
    wheelSpin: 0,
    compression: [0, 0, 0],
    doorL1: 0,
    doorL2: 0,
    cargo: 0,
    lights: { nav: false, beacon: false, strobe: false, landing: false, taxi: false, logo: false, cabin: false },
  };
}

/** Every vertex of a level, skinned for a visual (positions in the body frame), with its bone. */
function posed(detail: Detail, v: PlaneVisual) {
  const g = airframeGeometry(detail);
  const pose = new Pose();
  pose.apply(v, 0);
  pose.root.updateMatrixWorld(true);
  pose.skeleton.update();
  const mats = pose.skeleton.boneMatrices!;
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const out = new Float32Array(pos.count * 3);
  const bones = new Uint8Array(pos.count);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const b = si.getX(i);
    m.fromArray(mats, b * 16);
    p.fromBufferAttribute(pos, i).applyMatrix4(m);
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
    bones[i] = b;
  }
  return { P: out, bones, n: pos.count };
}

type Pts = ReturnType<typeof posed>;
function extent(s: Pts, keep: (x: number, y: number, z: number, bone: number) => boolean = () => true) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.n; i++) {
    const x = s.P[i * 3];
    const y = s.P[i * 3 + 1];
    const z = s.P[i * 3 + 2];
    if (!keep(x, y, z, s.bones[i])) continue;
    const v = [x, y, z];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  }
  return { lo, hi };
}

const GEAR_BONES = new Set<number>([BONE.mlgL, BONE.oleoL, BONE.wheelL, BONE.mlgR, BONE.oleoR, BONE.wheelR, BONE.nlg, BONE.nOleo, BONE.nSteer, BONE.nWheel]);
const f2 = (v: number) => v.toFixed(2);

export function runA320Checks(): CheckRow[] {
  const rows: CheckRow[] = [];
  const check = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });
  const near = (name: string, got: number, want: number, tol: number) => check(name, Math.abs(got - want) <= tol, `${f2(got)} (want ${f2(want)} ± ${tol})`);

  // ---- budgets
  const budget: Record<Detail, number> = { hero: 160000, ai: 32000, parked: 12000 };
  for (const d of ['hero', 'ai', 'parked'] as Detail[]) {
    const g = airframeGeometry(d);
    const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    check(`${d}: triangles`, tris <= budget[d], `${Math.round(tris)} (≤ ${budget[d]})`);
  }

  for (const d of ['hero', 'parked'] as Detail[]) {
    const s = posed(d, rest());
    const e = extent(s);
    // ---- dimensions
    near(`${d}: length`, e.hi[2] - e.lo[2], A320.length, 0.15);
    near(`${d}: span`, e.hi[0] - e.lo[0], A320.span, 0.2);
    near(`${d}: height`, e.hi[1], A320.height, 0.15);
    near(`${d}: tyres touch the ground (oleos extended)`, e.lo[1], 0, 0.03);
    const nose = extent(s, (_x, _y, z) => z < A320_POINTS.noseTip.z + 0.03);
    near(`${d}: nose tip height`, (nose.lo[1] + nose.hi[1]) / 2, A320_POINTS.noseTip.y, 0.12);
    // ---- gear contacts
    for (const [name, p, r] of [['main L', A320_POINTS.mainGearL, 0.8], ['main R', A320_POINTS.mainGearR, 0.8], ['nose', A320_POINTS.noseGear, 0.5]] as const) {
      const c = extent(s, (x, y, z) => y < 0.05 && Math.abs(x - p.x) < r && Math.abs(z - p.z) < 0.6);
      near(`${d}: ${name} gear contact x`, (c.lo[0] + c.hi[0]) / 2, p.x, 0.05);
      near(`${d}: ${name} gear contact z`, (c.lo[2] + c.hi[2]) / 2, p.z, 0.05);
    }
    // ---- nacelle and wingtip clearances
    const pod = extent(s, (x, _y, z) => Math.abs(Math.abs(x) - A320_POINTS.engineR.x) < 1.3 && z > -10.4 && z < -5.6);
    near(`${d}: nacelle ground clearance`, pod.lo[1], A320_POINTS.podR.y, 0.12);
    const tip = extent(s, (x) => Math.abs(x) > 16.8);
    near(`${d}: wingtip lowest point`, tip.lo[1], A320_POINTS.tipR.y, 0.3);
    // ---- tail strike: pitched about the main gear contacts, the tail cone meets the ground at ~11.5°
    const th = (11.5 * Math.PI) / 180;
    let low = Infinity;
    for (let i = 0; i < s.n; i++) {
      const z = s.P[i * 3 + 2];
      if (z < 5 || GEAR_BONES.has(s.bones[i])) continue;
      const y = s.P[i * 3 + 1];
      low = Math.min(low, y * Math.cos(th) - z * Math.sin(th));
    }
    near(`${d}: tail clearance at 11.5° pitch`, low, 0, 0.15);
  }

  // ---- the boarding door's sill lands where the jet bridge expects it
  const sill = skinAt(A320_POINTS.doorL1.z, sAtHeight(A320_POINTS.doorL1.z, 'L', A320_POINTS.doorL1.y), { x: 0, y: 0 });
  // (the contract's 1.98 is the half-width; the skin at the sill, below the widest line, is ~8 cm in)
  near('door L1 sill on the skin (x)', sill.x, A320_POINTS.doorL1.x, 0.1);

  // ---- gear up: every gear part inside the belly (above the fairing's flat bottom), nothing below
  const up = rest();
  up.gear = 0;
  const g0 = posed('hero', up);
  const gearUp = extent(g0, (_x, _y, _z, b) => GEAR_BONES.has(b));
  check('gear up: legs and wheels stowed above the belly', gearUp.lo[1] > 1.6, `lowest gear point y = ${f2(gearUp.lo[1])} (want > 1.60)`);
  // (the trunnions stay put in the wing root: the leg doors close flush under the wing; below that nothing may stick out)
  const under = extent(g0, (_x, y, _z, b) => GEAR_BONES.has(b) && y < 2.1);
  check('gear up: nothing hangs out under the wing', under.hi[0] < 2.6 && under.lo[0] > -2.6, `gear below y 2.1 spans x ${f2(under.lo[0])}..${f2(under.hi[0])} (want within ±2.6)`);
  const mid = rest();
  mid.gear = 0.5;
  const gm = extent(posed('hero', mid), (_x, _y, _z, b) => b === BONE.wheelL);
  check('gear mid-way: the left wheels swing inboard', (gm.lo[0] + gm.hi[0]) / 2 > A320_POINTS.mainGearL.x + 0.5, `left wheel centre x ${f2((gm.lo[0] + gm.hi[0]) / 2)}`);

  // ---- oleo compression lowers the airframe onto the wheels
  const comp = rest();
  comp.compression = [0.3, 0.3, 0.3];
  const cs = posed('parked', comp);
  const restBody = extent(posed('parked', rest()), (_x, _y, _z, b) => b === BONE.wheelL);
  const compBody = extent(cs, (_x, _y, _z, b) => b === BONE.wheelL);
  near('oleo compression lifts the wheels into the leg (m)', compBody.lo[1] - restBody.lo[1], 0.3, 0.01);

  // ---- flaps FULL: the flap runs aft (Fowler) and its trailing edge goes down
  const fl = rest();
  fl.flapsDeg = 40;
  fl.slatsDeg = 27;
  const fRest = extent(posed('ai', rest()), (_x, _y, _z, b) => b === BONE.flapOutR);
  const fFull = extent(posed('ai', fl), (_x, _y, _z, b) => b === BONE.flapOutR);
  check('flaps FULL: outer flap moves aft', fFull.hi[2] - fRest.hi[2] > 0.3, `trailing edge aft by ${f2(fFull.hi[2] - fRest.hi[2])} m`);
  check('flaps FULL: outer flap trailing edge drops', fRest.lo[1] - fFull.lo[1] > 0.5, `down by ${f2(fRest.lo[1] - fFull.lo[1])} m`);
  // the slat's leading edge at the outboard end of the track (its most forward point) runs forward and droops
  const leadingEdge = (s: Pts) => {
    let best = -1;
    for (let i = 0; i < s.n; i++) if (s.bones[i] === BONE.slatR && (best < 0 || s.P[i * 3 + 2] < s.P[best * 3 + 2])) best = i;
    return { y: s.P[best * 3 + 1], z: s.P[best * 3 + 2] };
  };
  const sRest = leadingEdge(posed('ai', rest()));
  const sFull = leadingEdge(posed('ai', fl));
  check('slats out: the leading edge runs forward and down', sRest.z - sFull.z > 0.2 && sRest.y - sFull.y > 0.1, `forward ${f2(sRest.z - sFull.z)} m, down ${f2(sRest.y - sFull.y)} m`);

  // ---- spoilers up: panels rise on the right side for spoilerR
  const sp = rest();
  sp.spoilerR = 1;
  const spR = extent(posed('ai', sp), (_x, _y, _z, b) => b >= BONE.spoilerR && b < BONE.spoilerR + 5);
  const spR0 = extent(posed('ai', rest()), (_x, _y, _z, b) => b >= BONE.spoilerR && b < BONE.spoilerR + 5);
  check('spoilers: the right panels rise', spR.hi[1] - spR0.hi[1] > 0.3, `top up by ${f2(spR.hi[1] - spR0.hi[1])} m`);

  // ---- door L1 open: it ends up forward of the opening, outside the skin
  const dr = rest();
  dr.doorL1 = 1;
  const d1 = extent(posed('hero', dr), (_x, _y, _z, b) => b === BONE.doorL1);
  check('door L1 open: clear of the opening, folded forward', d1.hi[2] < A320_POINTS.doorL1.z - 0.35 && d1.lo[0] < A320_POINTS.doorL1.x - 0.05, `door z ${f2(d1.lo[2])}..${f2(d1.hi[2])}, x from ${f2(d1.lo[0])}`);

  // ---- reverser: the sleeves translate aft
  const rv = rest();
  rv.reverser = 1;
  const r1 = extent(posed('ai', rv), (_x, _y, _z, b) => b === BONE.revL);
  const r0 = extent(posed('ai', rest()), (_x, _y, _z, b) => b === BONE.revL);
  near('reverser sleeve travel (m)', r1.hi[2] - r0.hi[2], 0.62, 0.02);
  return rows;
}
