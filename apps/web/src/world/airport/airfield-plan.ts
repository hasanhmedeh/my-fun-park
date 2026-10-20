// The airfield's plan: everything airfield.ts builds, worked out from an airport's numbers
// (world/geo.ts) and its taxi network (aviation/airports.ts). Pure data, no scene objects, so it
// can be checked in node: the pavement as shapes, the paint as strokes, every light, every sign
// and the pavement lettering.
//
// Both runways run east–west (09/27). Taxi centrelines follow the network's edges, with turn
// curves at the junctions (as painted on real airfields: straight lines carry on through a
// junction and curved lines join the branches); the turns onto and off the runway use the same
// rule with long radii for the rapid exits. The lights, the follow-the-greens guidance and the
// pavement fillets are all laid along those same curves.

import { headingVec, vecHeading } from '../geo';
import { HOLD_OFFSET, type Airport, type RunwayIdent, type TaxiEdge } from '../../aviation/airports';

export interface P2 {
  x: number;
  z: number;
}
export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** A pavement shape: an axis-aligned box with rounded corners, or a capsule (a segment with a radius). */
export type Part = { kind: 'box'; x0: number; x1: number; z0: number; z1: number; r: number } | { kind: 'capsule'; a: P2; b: P2; r: number };
/** Shapes joined into the pavement with a smooth union of fillet size k (m). */
export interface Feature {
  parts: Part[];
  k: number;
}
/** A painted stroke: a segment with round ends and its paint width. */
export interface Stroke {
  a: P2;
  b: P2;
  w: number;
}

/** A taxi path the centreline lights and the guidance follow: an edge's straight line, or a turn curve. */
export interface Piece {
  kind: 'edge' | 'arc';
  pts: P2[];
  len: number;
  /** The edge (index into ap.edges); for an arc, the edge at its start (pts[0]). Light `along` runs from edge.a for edges, from pts[0] for arcs. */
  edge: number;
  /** Arcs only: the junction node, the edge at the arc's end, and the tangent length from the node along either edge. */
  node: string;
  edge2: number;
  tangent: number;
  /** Lights on the runway side of this holding point go dark while its stop bar is red. */
  hold: string | null;
}

export type LightGroup = 'runway' | 'approach' | 'papi' | 'taxi' | 'taxiEdge' | 'stopbar' | 'guard' | 'obstruction';

export interface LightSpec {
  x: number;
  y: number;
  z: number;
  /** Linear colour times intensity (above 1 blooms). */
  r: number;
  g: number;
  b: number;
  /** Beam axis (unit; all zero = all round), its tightness (intensity ∝ cos^exp) and the all-round floor. */
  dx: number;
  dy: number;
  dz: number;
  exp: number;
  omni: number;
  /** The flare's size in world metres (screen size has a floor so far lights stay visible). */
  size: number;
  /** −1 steady; 0..1 the phase of a sequenced flasher; 2 or 3 one lamp of a wig-wag pair. */
  flash: number;
  /** A PAPI unit's transition angle (deg), or 0. */
  papi: number;
  group: LightGroup;
  /** Taxi centreline lights: the piece and the distance along it. */
  piece: number;
  along: number;
  /** Stop bars, guard lights and lead-on lights: the holding point they belong to. */
  hold: string | null;
  /** Stands on a stalk above the ground (gets a fitting in the furniture). */
  elevated: boolean;
}

export type CellKind = 'loc' | 'dir' | 'mand' | 'info' | 'drs';
export interface Cell {
  kind: CellKind;
  text: string;
  /** Direction cells: the arrow's angle (deg, 0 = straight ahead, −90 = left). */
  arrow?: number;
}
export interface SignSpec {
  x: number;
  z: number;
  /** The heading the front face looks toward (towards the traffic that reads it). */
  facing: number;
  front: Cell[];
  back: Cell[] | null;
  /** Distance-remaining boards are bigger than taxi guidance signs. */
  big: boolean;
}

/** Lettering painted on the pavement: a box of `w` across by `l` along the reader's heading. */
export interface DecalSpec {
  x: number;
  z: number;
  heading: number;
  w: number;
  l: number;
  text: string;
  fg: string;
  bg: string;
}

export interface HoldSpec {
  id: string;
  /** The taxiway's name (A4). */
  name: string;
  x: number;
  z: number;
  /** Unit vector from the hold towards the runway, and to the left of a pilot facing it. */
  u: P2;
  left: P2;
  /** The runway designation as the sign reads from the holding side: "27-09". */
  designation: string;
}

export interface AlsStation {
  x: number;
  z: number;
  /** Height of the lamps (they ride on masts above the ground). */
  y: number;
  /** Half the width of the lit bar at this station (barrette or crossbar). */
  half: number;
  /** A sequenced flasher stands just ahead of the barrette. */
  flasher: boolean;
}

export interface RunwayPlan {
  /** Centre of the runway (the airfield's local origin). */
  cx: number;
  cz: number;
  halfLen: number;
  halfW: number;
  shoulder: number;
  blast: number;
  /** Centreline dashes: their period (≈ 50 m, fitted to the length) and where they start past each threshold. */
  dashPeriod: number;
  dashStart: number;
  /** Designators painted at the west (09) and east (27) ends. */
  west: RunwayIdent;
  east: RunwayIdent;
}

export interface AirfieldPlan {
  ap: Airport;
  runway: RunwayPlan;
  /** The ground mesh's extent (the fenced airside plus the approach light corridors). */
  region: Rect;
  /** The perimeter fence's rectangle (its side towards the terminal runs into the building's ends). */
  fence: Rect;
  /** The gap in the fence where the terminal stands (x range) on the apron side. */
  fenceGap: { x0: number; x1: number };
  /** The approach light corridors (mown strips beyond each threshold, outside the fence). */
  als: { x0: number; x1: number; half: number };
  /** The apron's concrete, with the service road along the terminal. */
  apron: Rect;
  features: Feature[];
  yellow: Stroke[];
  white: Stroke[];
  red: Stroke[];
  pieces: Piece[];
  holds: HoldSpec[];
  lights: LightSpec[];
  signs: SignSpec[];
  decals: DecalSpec[];
  alsStations: AlsStation[];
  papiUnits: { x: number; z: number; facing: number }[];
  loc: { x: number; z: number; facing: number; half: number }[];
  gs: { x: number; z: number; facing: number }[];
  windsocks: P2[];
  /** The security road just inside the fence (a closed loop of corners, rounded when built). */
  road: P2[];
  /** The road's sides that are left out (the apron side near the airside buildings). */
  roadGap: { x0: number; x1: number };
}

// ------------------------------------------------------------------------------------------------
// Dimensions (metres)
// ------------------------------------------------------------------------------------------------

/** Taxiway pavement half-width (23 m wide, code D/E) and paved shoulders beyond it. */
export const TAXI_HALF = 11.5;
export const SHOULDER = 7.5;
/** Blast pads beyond each runway end. */
export const BLAST = 60;
/** The pavement field's range beyond the edge (the shoulders plus a margin). */
export const PAVE_MAX = 8;
/** Taxi centreline paint width (ICAO minimum 0.15 m; a little more reads better from the cockpit). */
const CENTRELINE_W = 0.2;
/** Light spacing on straight taxiways and on curves. */
const TAXI_LIGHT_STRAIGHT = 15;
const TAXI_LIGHT_CURVE = 7.5;

// light colours (linear) times a base intensity
const WHITE = [1, 0.86, 0.66];
const YELLOW = [1, 0.62, 0.16];
const RED = [1, 0.06, 0.04];
const GREEN = [0.16, 1, 0.42];
const BLUE = [0.12, 0.28, 1];
const ALS_WHITE = [1, 0.92, 0.78];
const FLASH = [0.9, 0.95, 1.15];

const DEG = Math.PI / 180;
const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, z: a.z - b.z });
const len = (v: P2) => Math.hypot(v.x, v.z);
const unit = (v: P2): P2 => {
  const l = len(v) || 1;
  return { x: v.x / l, z: v.z / l };
};
const add = (a: P2, v: P2, k: number): P2 => ({ x: a.x + v.x * k, z: a.z + v.z * k });
/** Left of a direction (x east, z south): heading h's left is (cos h·…) = (f.z, −f.x). */
const leftOf = (u: P2): P2 => ({ x: u.z, z: -u.x });
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

function polyLen(pts: P2[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += len(sub(pts[i], pts[i - 1]));
  return l;
}

/** Points every `step` along a polyline, starting half a step in, with the distance along. */
function along(pts: P2[], step: number, offset = step / 2) {
  const out: { p: P2; s: number; dir: P2 }[] = [];
  const total = polyLen(pts);
  const n = Math.max(1, Math.round((total - offset * 2) / step) + 1);
  const st = n > 1 ? (total - offset * 2) / (n - 1) : 0;
  let seg = 0;
  let segStart = 0;
  for (let i = 0; i < n; i++) {
    const s = n > 1 ? offset + i * st : total / 2;
    while (seg < pts.length - 2 && segStart + len(sub(pts[seg + 1], pts[seg])) < s) {
      segStart += len(sub(pts[seg + 1], pts[seg]));
      seg++;
    }
    const d = sub(pts[seg + 1], pts[seg]);
    const l = len(d) || 1;
    const t = Math.min(1, Math.max(0, (s - segStart) / l));
    out.push({ p: add(pts[seg], d, t), s, dir: { x: d.x / l, z: d.z / l } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// The plan
// ------------------------------------------------------------------------------------------------

export function planAirfield(ap: Airport): AirfieldPlan {
  const geo = ap.geo;
  const rg = geo.runway;
  const N = ap.nodes;
  const E = ap.edges;
  const rz = rg.z;
  const halfW = rg.width / 2;
  const L = rg.x1 - rg.x0;
  const cx = (rg.x0 + rg.x1) / 2;
  // the taxiway side of the runway: −1 north, +1 south
  const taxiSide = Math.sign(geo.taxiwayZ - rz);
  const apronSide = Math.sign(geo.apron.z0 - rz);

  const pieces: Piece[] = [];
  const yellow: Stroke[] = [];
  const white: Stroke[] = [];
  const red: Stroke[] = [];
  const lights: LightSpec[] = [];
  const signs: SignSpec[] = [];
  const decals: DecalSpec[] = [];
  const features: Feature[] = [];

  const light = (o: Partial<LightSpec> & Pick<LightSpec, 'x' | 'z' | 'group'>, c: number[], k: number): LightSpec => {
    const l: LightSpec = {
      y: 0.05,
      r: c[0] * k,
      g: c[1] * k,
      b: c[2] * k,
      dx: 0,
      dy: 0,
      dz: 0,
      exp: 1,
      omni: 1,
      size: 0.5,
      flash: -1,
      papi: 0,
      piece: -1,
      along: 0,
      hold: null,
      elevated: false,
      ...o,
    };
    lights.push(l);
    return l;
  };

  // ---------------------------------------------------------------- the network's geometry
  const isRunway = (id: string) => N[id].kind === 'runway';
  const isStandEdge = (e: TaxiEdge) => /^\d+$/.test(e.name);
  const other = (e: TaxiEdge, id: string) => (e.a === id ? e.b : e.a);
  const edgesAt = new Map<string, number[]>();
  E.forEach((e, i) => {
    for (const id of [e.a, e.b]) {
      if (!edgesAt.has(id)) edgesAt.set(id, []);
      edgesAt.get(id)!.push(i);
    }
  });
  const canArrive = (e: TaxiEdge, at: string) => e.b === at || !e.oneWay;
  const canLeave = (e: TaxiEdge, from: string) => e.a === from || !e.oneWay;
  const dirFrom = (id: string, e: TaxiEdge) => unit(sub(N[other(e, id)], N[id]));

  /** How far a straight line runs from a node along an edge, carrying on through collinear edges of the same name. */
  const runLength = (from: string, ei: number): number => {
    let total = 0;
    let at = from;
    let e = E[ei];
    const d0 = dirFrom(from, e);
    for (let guard = 0; guard < 32; guard++) {
      const nx = other(e, at);
      total += len(sub(N[nx], N[at]));
      const next = (edgesAt.get(nx) ?? []).map((j) => E[j]).find((f) => f !== e && f.name === e.name && Math.abs(dirFrom(nx, f).x * d0.x + dirFrom(nx, f).z * d0.z - 1) < 1e-3);
      if (!next) break;
      at = nx;
      e = next;
    }
    return total;
  };

  // ---- turn curves at every junction
  const arcAt = new Map<string, number>(); // `${node}|${lo}|${hi}` → piece index
  const runwayTrim = new Map<number, number>(); // edge → how far from its runway node the straight paint stops
  const arcKey = (node: string, a: number, b: number) => `${node}|${Math.min(a, b)}|${Math.max(a, b)}`;
  for (const [id, list] of edgesAt) {
    for (const i of list)
      for (const j of list) {
        if (i === j) continue;
        const e1 = E[i];
        const e2 = E[j];
        if (e1.name === 'RWY' && e2.name === 'RWY') continue;
        if (!canArrive(e1, id) || !canLeave(e2, id)) continue;
        if (arcAt.has(arcKey(id, i, j))) continue;
        const uIn = unit(sub(N[id], N[other(e1, id)]));
        const uOut = dirFrom(id, e2);
        const turn = Math.acos(Math.max(-1, Math.min(1, uIn.x * uOut.x + uIn.z * uOut.z)));
        if (turn < 12 * DEG || turn > 136 * DEG) continue;
        const rwy = e1.name === 'RWY' || e2.name === 'RWY';
        let R = isStandEdge(e1) || isStandEdge(e2) ? 30 : rwy ? (turn < 50 * DEG ? 550 : 55) : turn < 50 * DEG ? 150 : 45;
        const room = 0.45 * Math.min(runLength(id, i), runLength(id, j));
        const tanHalf = Math.tan(turn / 2);
        R = Math.min(R, room / tanHalf);
        const T = R * tanHalf;
        const t1 = add(N[id], uIn, -T);
        const t2 = add(N[id], uOut, T);
        // the centre lies inside the turn, R from the first tangent point square to the way in
        const n = leftOf(uIn);
        const side = n.x * uOut.x + n.z * uOut.z > 0 ? 1 : -1;
        const c = add(t1, n, R * side);
        const a0 = Math.atan2(t1.z - c.z, t1.x - c.x);
        let sweep = Math.atan2(t2.z - c.z, t2.x - c.x) - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const steps = Math.max(4, Math.ceil((Math.abs(sweep) * R) / 1.5));
        const pts: P2[] = [];
        for (let k = 0; k <= steps; k++) {
          const a = a0 + (sweep * k) / steps;
          pts.push({ x: c.x + Math.cos(a) * R, z: c.z + Math.sin(a) * R });
        }
        arcAt.set(arcKey(id, i, j), pieces.length);
        pieces.push({ kind: 'arc', pts, len: polyLen(pts), edge: i, node: id, edge2: j, tangent: T, hold: null });
        if (isRunway(id)) for (const k of [i, j]) if (E[k].name !== 'RWY') runwayTrim.set(k, Math.max(runwayTrim.get(k) ?? 0, T));
      }
  }

  // ---- straight centrelines along every edge but the runway's
  const edgePiece = new Map<number, number>();
  E.forEach((e, i) => {
    if (e.name === 'RWY') return;
    const a = N[e.a];
    const b = N[e.b];
    let pa: P2 = a;
    let pb: P2 = b;
    // stop short of the runway where the turn curves take over (or at its edge)
    for (const [end, id] of [['a', e.a], ['b', e.b]] as const) {
      if (!isRunway(id)) continue;
      const far = end === 'a' ? b : a;
      const d = unit(sub(far, N[id]));
      const edgeCut = (halfW + 0.5) / Math.max(0.05, Math.abs(d.z));
      const cut = Math.max(runwayTrim.get(i) ?? 0, edgeCut);
      const p = add(N[id], d, cut);
      if (end === 'a') pa = p;
      else pb = p;
    }
    pieces.push({ kind: 'edge', pts: [pa, pb], len: len(sub(pb, pa)), edge: i, node: '', edge2: -1, tangent: 0, hold: null });
    edgePiece.set(i, pieces.length - 1);
  });

  // ---- holding points (stop bars, signs, pattern A markings)
  const holds: HoldSpec[] = [];
  for (const n of Object.values(N)) {
    if (n.kind !== 'hold') continue;
    const list = edgesAt.get(n.id) ?? [];
    const toRw = list.map((i) => E[i]).find((e) => isRunway(other(e, n.id)));
    if (!toRw) continue;
    const u = dirFrom(n.id, toRw);
    const left = leftOf(u);
    // the runway designation as read from here: the threshold to the left first
    const westLeft = left.x < 0;
    const designation = westLeft ? '09-27' : '27-09';
    holds.push({ id: n.id, name: toRw.name, x: n.x, z: n.z, u, left, designation });
  }
  // lead-on lights: the connector from each hold to the runway and its curves at the runway
  pieces.forEach((pc) => {
    const touch = (ei: number) => {
      const e = E[ei];
      const hold = holds.find((h) => (e.a === h.id || e.b === h.id) && (isRunway(e.a) || isRunway(e.b)));
      return hold?.id ?? null;
    };
    pc.hold = touch(pc.edge) ?? (pc.edge2 >= 0 ? touch(pc.edge2) : null);
  });

  // ---- paint: taxi centrelines, stand lead-ins and their stop marks
  for (const pc of pieces) {
    for (let i = 1; i < pc.pts.length; i++) yellow.push({ a: pc.pts[i - 1], b: pc.pts[i], w: CENTRELINE_W });
  }
  for (const s of ap.stands) {
    const lane = N[s.lane];
    const f = headingVec(s.heading);
    // the lead-in carries on from the stand's reference stop to the nose wheel's stop mark
    yellow.push({ a: { x: s.x, z: s.z }, b: s.noseStop, w: CENTRELINE_W });
    const side = leftOf(f);
    yellow.push({ a: add(s.noseStop, side, -2.2), b: add(s.noseStop, side, 2.2), w: 0.3 });
    decals.push({ ...add(add(s.noseStop, side, 4.4), f, -0.6), heading: s.heading, w: 3, l: 1.4, text: 'A320', fg: '#ffd21f', bg: '' });
    // the stand number at the start of the lead-in, for a pilot turning in off the taxilane
    const p = add(lane, f, 36);
    decals.push({ ...p, heading: s.heading, w: 3.2, l: 4.2, text: `${s.gate}`, fg: '#ffd21f', bg: '#151515' });
  }

  // ---------------------------------------------------------------- pavement
  // the runway (with its blast pads; the shoulders are the band just outside every shape)
  features.push({ parts: [{ kind: 'box', x0: rg.x0 - BLAST, x1: rg.x1 + BLAST, z0: rz - halfW, z1: rz + halfW, r: 0 }], k: 4 });
  const apron: Rect = { x0: geo.apron.x0, x1: geo.apron.x1, z0: geo.apron.z0, z1: geo.apron.z1 };
  // the apron runs on to the terminal's facade: the service road along it
  if (apronSide < 0) apron.z0 = Math.min(apron.z0, geo.terminal.airside);
  else apron.z1 = Math.max(apron.z1, geo.terminal.airside);
  features.push({ parts: [{ kind: 'box', ...apron, r: 8 }], k: 4 });
  // where the apron's edge runs close along the parallel taxiway, the strip of grass that would be
  // left between their shoulders is paved over (it would be a mower's nightmare and FOD trap)
  const tz = geo.taxiwayZ;
  const gapLo = tz > apron.z1 ? apron.z1 - 1 : tz + TAXI_HALF - 1;
  const gapHi = tz > apron.z1 ? tz - TAXI_HALF + 1 : apron.z0 + 1;
  if (gapHi > gapLo && gapHi - gapLo < 2 * SHOULDER + 12) features.push({ parts: [{ kind: 'box', x0: apron.x0, x1: apron.x1, z0: gapLo, z1: gapHi, r: 0 }], k: 4 });
  const inApron = (p: P2, m = 0) => p.x > apron.x0 - m && p.x < apron.x1 + m && p.z > apron.z0 - m && p.z < apron.z1 + m;
  // straight runs: collinear edges of the same taxiway make one shape (overlapping shapes would bulge the fillets)
  const used = new Set<number>();
  E.forEach((e, i) => {
    if (used.has(i) || e.name === 'RWY' || isStandEdge(e)) return;
    if (inApron(N[e.a]) && inApron(N[e.b])) return;
    // walk both ways along the run
    const chain = [i];
    used.add(i);
    let a = e.a;
    let b = e.b;
    const d0 = unit(sub(N[e.b], N[e.a]));
    const extend = (end: string, sign: number) => {
      for (let g = 0; g < 32; g++) {
        const next = (edgesAt.get(end) ?? []).find((j) => {
          if (used.has(j) || E[j].name !== e.name) return false;
          const d = dirFrom(end, E[j]);
          return Math.abs(d.x * d0.x * sign + d.z * d0.z * sign - 1) < 1e-3;
        });
        if (next === undefined) return end;
        used.add(next);
        chain.push(next);
        end = other(E[next], end);
      }
      return end;
    };
    b = extend(b, 1);
    a = extend(a, -1);
    features.push({ parts: [{ kind: 'capsule', a: N[a], b: N[b], r: TAXI_HALF }], k: 4 });
  });
  // turn curves outside the apron carry their own pavement (the fillets)
  for (const pc of pieces) {
    if (pc.kind !== 'arc' || pc.pts.every((p) => inApron(p, -4))) continue;
    const parts: Part[] = [];
    const step = Math.max(1, Math.floor(pc.pts.length / Math.ceil(pc.len / 4)));
    for (let k = 0; k < pc.pts.length - 1; k += step) parts.push({ kind: 'capsule', a: pc.pts[k], b: pc.pts[Math.min(pc.pts.length - 1, k + step)], r: TAXI_HALF });
    features.push({ parts, k: 4 });
  }

  // ---------------------------------------------------------------- apron paint
  const standXs = ap.stands.map((s) => s.x);
  const headZ = apronSide < 0 ? apron.z0 : apron.z1; // the facade side
  const inward = -apronSide; // from the facade towards the stands
  // the service road along the terminal: a solid edge line and a dashed centre
  const roadEdge = headZ + inward * 8;
  white.push({ a: { x: apron.x0 + 6, z: roadEdge }, b: { x: apron.x1 - 6, z: roadEdge }, w: 0.15 });
  for (let x = apron.x0 + 8; x < apron.x1 - 10; x += 6) white.push({ a: { x, z: headZ + inward * 4 }, b: { x: x + 3, z: headZ + inward * 4 }, w: 0.12 });
  // behind the stands' tails, a second road where the apron has room for one (the home apron)
  const standZ = ap.stands[0].z;
  const tailZ = standZ + inward * 26.5;
  const laneZ = N[ap.stands[0].lane].z;
  const tailRoad = Math.abs(laneZ - tailZ) > 36;
  if (tailRoad) {
    for (const z of [tailZ, tailZ + inward * 8]) white.push({ a: { x: apron.x0 + 6, z }, b: { x: apron.x1 - 6, z }, w: 0.15 });
    for (let x = apron.x0 + 8; x < apron.x1 - 10; x += 6) white.push({ a: { x, z: tailZ + inward * 4 }, b: { x: x + 3, z: tailZ + inward * 4 }, w: 0.12 });
  }
  // each stand's equipment restraint line (red) round the parked aircraft's envelope
  const eraFar = tailRoad ? tailZ - inward * 0.5 : standZ + inward * 24;
  for (const x of standXs) {
    const z0 = roadEdge + inward * 0.6;
    const pts = [
      { x: x - 21.5, z: z0 },
      { x: x - 21.5, z: eraFar },
      { x: x + 21.5, z: eraFar },
      { x: x + 21.5, z: z0 },
    ];
    for (let i = 1; i < pts.length; i++) red.push({ a: pts[i - 1], b: pts[i], w: 0.15 });
    // the safety zone under the nose and the jet bridge (no vehicles while the aircraft moves in):
    // red hatching. Palm Cay boards by airstairs, its passengers walking across that part of the
    // apron, so it has none.
    if (geo.id === 'home') {
      const nose = ap.stands.find((s) => s.x === x)!.noseStop;
      hatch(red, { x0: x - 4, x1: x + 4, z0: Math.min(nose.z - inward * 4, z0), z1: Math.max(nose.z - inward * 4, z0) }, 1.6, 0.12);
    }
  }
  // equipment parking boxes between the stands, at the head of the stand row
  const mids: number[] = [];
  for (let i = 0; i <= standXs.length; i++) {
    const x = i === 0 ? standXs[0] - 30 : i === standXs.length ? standXs[i - 1] + 30 : (standXs[i - 1] + standXs[i]) / 2;
    if (x - 6 > apron.x0 + 4 && x + 6 < apron.x1 - 4) mids.push(x);
  }
  for (const x of mids) {
    const za = roadEdge + inward * 1.5;
    const zb = roadEdge + inward * 16;
    const r: Rect = { x0: x - 5, x1: x + 5, z0: Math.min(za, zb), z1: Math.max(za, zb) };
    outline(white, r, 0.15);
    hatch(white, r, 2.2, 0.12);
  }

  // ---------------------------------------------------------------- runway lights
  const west = rg.x0;
  const east = rg.x1;
  const edgeN = Math.ceil(L / 60);
  for (let i = 0; i <= edgeN; i++) {
    const x = west + (L * i) / edgeN;
    for (const side of [-1, 1]) {
      const z = rz + side * (halfW + 1.2);
      // seen landing east (09) the lamp faces west; the last 600 m in either direction shows yellow
      light({ x, z, y: 0.38, group: 'runway', dx: -1, exp: 2.5, omni: 0.22, size: 0.75, elevated: true }, east - x < 600 ? YELLOW : WHITE, 4);
      light({ x, z, y: 0.38, group: 'runway', dx: 1, exp: 2.5, omni: 0, size: 0.75 }, x - west < 600 ? YELLOW : WHITE, 4);
    }
  }
  // centreline lights every 15 m, colour-coded towards the end in each direction
  const clN = Math.round(L / 15);
  for (let i = 0; i < clN; i++) {
    const x = west + 7.5 + i * (L - 15) / (clN - 1);
    const code = (rem: number) => (rem < 300 ? RED : rem < 900 ? (i % 2 ? RED : WHITE) : WHITE);
    light({ x, z: rz + 0.6, group: 'runway', dx: -1, exp: 6, omni: 0, size: 0.42 }, code(east - x), 3.2);
    light({ x, z: rz + 0.6, group: 'runway', dx: 1, exp: 6, omni: 0, size: 0.42 }, code(x - west), 3.2);
  }
  // threshold (green, towards the approach) and runway end (red, towards the runway) bars
  for (const [tx, s] of [
    [west, 1],
    [east, -1],
  ] as const) {
    for (let k = 0; k < 16; k++) {
      const z = rz - halfW + 1.5 + k * ((rg.width - 3) / 15);
      light({ x: tx - s * 1.2, z, y: 0.1, group: 'runway', dx: -s, dy: 0.05, exp: 3, omni: 0.08, size: 0.65 }, GREEN, 4.5);
      light({ x: tx - s * 1.2, z, y: 0.1, group: 'runway', dx: s, exp: 4, omni: 0, size: 0.55 }, RED, 3.5);
    }
    // touchdown zone barrettes, three lamps each side every 30 m to 900 m
    for (let a = 60; a <= 900; a += 30)
      for (const side of [-1, 1])
        for (let k = 0; k < 3; k++) light({ x: tx + s * a, z: rz + side * (9 + k * 1.5), group: 'runway', dx: -s, dy: 0.06, exp: 6, omni: 0, size: 0.42 }, WHITE, 3);
  }

  // ---------------------------------------------------------------- approach lights, PAPI, ILS, windsocks
  const alsStations: AlsStation[] = [];
  const papiUnits: AirfieldPlan['papiUnits'] = [];
  const loc: AirfieldPlan['loc'] = [];
  const gs: AirfieldPlan['gs'] = [];
  const windsocks: P2[] = [];
  const crossHalf = [9, 15, 18, 21, 24, 27];
  for (const ident of ['09', '27'] as const) {
    const rw = ap.runways[ident];
    const s = rw.heading === 90 ? 1 : -1; // +x per metre along the landing direction
    const thr = rw.threshold;
    const right = { x: 0, z: s }; // right of the landing direction: south landing east
    const n = Math.round(rg.approachLights / 30);
    const tilt = Math.sin(4 * DEG);
    for (let i = 1; i <= n; i++) {
      const a = i * 30;
      const x = thr.x - s * a;
      // over the paved blast pad the lamps are inset (semi-flush); beyond it they ride on masts
      const y = a <= BLAST ? 0.06 : 0.8 + (a / 900) * 1.7;
      const cross = i % 5 === 0 ? crossHalf[Math.min(crossHalf.length - 1, i / 5 - 1)] : 0;
      const flasher = a > 300;
      alsStations.push({ x, z: rz, y, half: Math.max(2, cross), flasher });
      // the centreline barrette: five lamps across 4 m
      for (let k = -2; k <= 2; k++) light({ x, y, z: rz + k, group: 'approach', dx: -s, dy: tilt, exp: 4, omni: 0, size: 0.75 }, ALS_WHITE, 4.5);
      if (cross)
        for (let b = 3; b <= cross + 0.01; b += 2.7)
          for (const side of [-1, 1]) light({ x, y, z: rz + side * b, group: 'approach', dx: -s, dy: tilt, exp: 4, omni: 0, size: 0.75 }, ALS_WHITE, 4.5);
      // red side barrettes over the inner 270 m (in line with the touchdown zone lights)
      if (a <= 270)
        for (const side of [-1, 1]) for (let k = 0; k < 3; k++) light({ x, y, z: rz + side * (9 + k * 1.5), group: 'approach', dx: -s, dy: tilt, exp: 4, omni: 0, size: 0.6 }, RED, 4);
      // the rabbit: one flasher per station from the outer end in to 330 m, twice a second
      if (flasher) light({ x: x - s * 0.6, y: y + 0.35, z: rz, group: 'approach', dx: -s, dy: tilt, exp: 2.5, omni: 0, size: 1.6, flash: ((n * 30 - a) / (n * 30 - 300)) * 0.42 }, FLASH, 14);
    }
    // the PAPI: four units on the left, the one nearest the runway set highest (ICAO)
    const left = { x: 0, z: -s };
    const settings = rw.papi.angles.slice().sort((p, q) => q - p);
    settings.forEach((ang, k) => {
      const p = add({ x: rw.papi.x, z: rw.papi.z }, left, k * 9);
      papiUnits.push({ x: p.x, z: p.z, facing: rw.heading + 180 });
      for (const off of [-0.32, 0.32]) light({ x: p.x, y: 0.62, z: p.z + off, group: 'papi', dx: -s, dy: 0.03, exp: 18, omni: 0, size: 1.15, papi: ang }, WHITE, 6);
    });
    // the localizer array beyond the far end (between two approach light stations of the other runway)
    loc.push({ x: rw.ils.locAntenna.x + s * 12, z: rz, facing: rw.heading + 180, half: 21 });
    // the glide slope mast beside the touchdown zone, on whichever side keeps clear of the taxiway
    let gz = rw.ils.gsAntenna.z;
    if (Math.sign(gz - rz) === taxiSide && Math.abs(gz - geo.taxiwayZ) < TAXI_HALF + SHOULDER + 30) gz = rz - (gz - rz);
    gs.push({ x: rw.ils.gsAntenna.x, z: gz, facing: rw.heading + 180 });
    // a windsock near each touchdown zone, on the side away from the PAPI
    windsocks.push(add(add(thr, { x: s, z: 0 }, 250), right, 100));
    // rapid exit indicator lights: 3-2-1 yellow lamps before each rapid exit's turn-off
    for (const ex of rw.exits) {
      if (!ex.rapid) continue;
      const exitEdge = E.findIndex((e) => e.a === ex.node && e.name === ex.name);
      if (exitEdge < 0) continue;
      const exDir = dirFrom(ex.node, E[exitEdge]);
      const exSide = Math.sign(exDir.z * s) || 1; // +: the exit turns right
      const pc = pieces.find((p) => p.kind === 'arc' && p.node === ex.node && (p.edge === exitEdge || p.edge2 === exitEdge));
      const tangentX = N[ex.node].x - s * (pc?.tangent ?? 0);
      for (const [dist, count] of [
        [300, 3],
        [200, 2],
        [100, 1],
      ] as const)
        for (let k = 0; k < count; k++) light({ x: tangentX - s * dist - s * k * 1.6, z: rz + exSide * s * 2, group: 'runway', dx: -s, exp: 5, omni: 0, size: 0.42 }, YELLOW, 3);
    }
  }

  // ---------------------------------------------------------------- taxiway centreline lights
  pieces.forEach((pc, pi) => {
    const step = pc.kind === 'arc' ? TAXI_LIGHT_CURVE : TAXI_LIGHT_STRAIGHT;
    const touchesRunway = (pc.kind === 'arc' && isRunway(pc.node)) || isRunway(E[pc.edge].a) || isRunway(E[pc.edge].b);
    along(pc.pts, step).forEach(({ p, s }, k) => {
      // lights within the runway strip on a lead-on/lead-off path alternate green and yellow
      const inStrip = touchesRunway && Math.abs(p.z - rz) < HOLD_OFFSET;
      light({ x: p.x, z: p.z, y: 0.04, group: 'taxi', piece: pi, along: s, hold: pc.hold, exp: 1, omni: 1, size: 0.4 }, inStrip && k % 2 ? YELLOW : GREEN, 2.6);
    });
  });

  // ---------------------------------------------------------------- holds: stop bars, guard lights, signs, markings
  for (const h of holds) {
    for (let k = -3.5; k <= 3.5; k++) {
      const p = add(h, h.left, k * 3);
      light({ x: p.x, z: p.z, y: 0.04, group: 'stopbar', hold: h.id, dx: -h.u.x, dz: -h.u.z, dy: 0.05, exp: 3, omni: 0.1, size: 0.5 }, RED, 4.5);
    }
    for (const side of [-1, 1]) {
      const p = add(h, h.left, side * (TAXI_HALF + 2));
      light({ x: p.x, z: p.z, y: 0.42, group: 'stopbar', hold: h.id, dx: -h.u.x, dz: -h.u.z, exp: 2, omni: 0.15, size: 0.6, elevated: true }, RED, 4.5);
      // runway guard lights: a wig-wag pair of yellow lamps either side
      for (const [k, ph] of [
        [-0.2, 2],
        [0.2, 3],
      ] as const) {
        const g = add(add(h, h.left, side * (TAXI_HALF + 4.5 + k)), h.u, -1);
        light({ x: g.x, z: g.z, y: 0.75, group: 'guard', hold: h.id, dx: -h.u.x, dz: -h.u.z, exp: 3, omni: 0.1, size: 0.7, flash: ph, elevated: k < 0 }, YELLOW, 5);
      }
      // the mandatory sign: runway designation, with the location sign outboard of it
      const sp = add(add(h, h.left, side * (TAXI_HALF + SHOULDER + 3.5)), h.u, -0.5);
      const loc: Cell = { kind: 'loc', text: h.name };
      const mand: Cell = { kind: 'mand', text: h.designation };
      signs.push({ ...sp, facing: vecHeading(-h.u.x, -h.u.z), front: side > 0 ? [loc, mand] : [mand, loc], back: [{ kind: 'loc', text: h.name }], big: false });
    }
    // painted holding position marking at the hold (pattern A: in the shader), with its pavement signs
    const hd = vecHeading(h.u.x, h.u.z);
    decals.push({ ...add(add(h, h.u, -5.2), h.left, -1.4), heading: hd, w: 9.6, l: 3.6, text: h.designation, fg: '#ffffff', bg: '#b3121f' });
    decals.push({ ...add(add(h, h.u, -5.2), h.left, 5.8), heading: hd, w: 3.6, l: 3.6, text: h.name, fg: '#ffd21f', bg: '#151515' });
    // intersection departures: the take-off run available from here
    for (const ident of ['09', '27'] as const) {
      const entry = ap.runways[ident].entries.find((en) => en.hold === h.id && en.intersection);
      if (!entry) continue;
      const turnLeft = (ap.runways[ident].heading === 270) === (h.left.x < 0);
      const ip = add(add(h, h.u, -55), h.left, TAXI_HALF + SHOULDER + 3.5);
      signs.push({ ...ip, facing: vecHeading(-h.u.x, -h.u.z), front: [{ kind: 'info', text: `${ident} TORA ${Math.round(entry.toraM)} M`, arrow: turnLeft ? -90 : 90 }], back: null, big: false });
    }
  }

  // ---- direction signs before each taxiway junction
  for (const n of Object.values(N)) {
    if (n.kind !== 'taxiway') continue;
    const list = edgesAt.get(n.id) ?? [];
    if (list.length < 3) continue;
    for (const i of list) {
      const ein = E[i];
      if (ein.name === 'RWY' || !canArrive(ein, n.id)) continue;
      const from = N[other(ein, n.id)];
      const uIn = unit(sub(n, from));
      const edgeLen = len(sub(n, from));
      if (edgeLen < 90) continue;
      const hIn = vecHeading(uIn.x, uIn.z);
      const cells: { cell: Cell; turn: number }[] = [];
      for (const j of list) {
        if (j === i) continue;
        const eo = E[j];
        if (eo.name === 'RWY' || !canLeave(eo, n.id)) continue;
        const d = dirFrom(n.id, eo);
        const turn = wrap180(vecHeading(d.x, d.z) - hIn);
        if (Math.abs(turn) > 150) continue;
        if (eo.name === ein.name && Math.abs(turn) < 20) continue;
        cells.push({ cell: { kind: 'dir', text: eo.name, arrow: Math.round(turn / 45) * 45 }, turn });
      }
      if (!cells.length) continue;
      cells.sort((p, q) => p.turn - q.turn);
      const lefts = cells.filter((c) => c.turn < -20).map((c) => c.cell);
      const rest = cells.filter((c) => c.turn >= -20).map((c) => c.cell);
      const front = [...lefts, { kind: 'loc' as const, text: ein.name }, ...rest];
      const sp = add(add(n, uIn, -60), leftOf(uIn), TAXI_HALF + SHOULDER + 3.5);
      signs.push({ ...sp, facing: vecHeading(-uIn.x, -uIn.z), front, back: null, big: false });
    }
  }

  // ---- exit signs on the runway, on the side of each exit, before it
  for (const ident of ['09', '27'] as const) {
    const rw = ap.runways[ident];
    const s = rw.heading === 90 ? 1 : -1;
    for (const ex of rw.exits) {
      const ei = E.findIndex((e) => (e.a === ex.node || e.b === ex.node) && e.name === ex.name);
      if (ei < 0) continue;
      const d = dirFrom(ex.node, E[ei]);
      const side = Math.sign(d.z) || 1; // the exit's side of the runway (+ south)
      const turn = wrap180(vecHeading(d.x, d.z) - rw.heading);
      const pc = pieces.find((p) => p.kind === 'arc' && p.node === ex.node && (p.edge === ei || p.edge2 === ei));
      const x = N[ex.node].x - s * ((pc?.tangent ?? 40) + 60);
      signs.push({ x, z: rz + side * (halfW + SHOULDER + 12), facing: rw.heading + 180, front: [{ kind: 'dir', text: ex.name, arrow: Math.round(turn / 45) * 45 }], back: null, big: false });
    }
  }

  // ---- distance remaining boards every 1000 ft, on the side away from the taxiway (both faces)
  const kft = Math.floor(L / 304.8);
  const margin = (L - kft * 304.8) / 2;
  for (let k = 1; k < kft; k++) {
    // the face read landing east shows the thousands of feet left to the east end
    const x = east - margin - k * 304.8;
    signs.push({ x, z: rz - taxiSide * (halfW + 25), facing: 270, front: [{ kind: 'drs', text: `${k}` }], back: [{ kind: 'drs', text: `${kft - k}` }], big: true });
  }

  // ---------------------------------------------------------------- the perimeter
  const fence: Rect =
    apronSide < 0
      ? { x0: rg.x0 - 400, x1: rg.x1 + 400, z0: geo.terminal.z0 + 20, z1: rz + 160 }
      : { x0: rg.x0 - 380, x1: rg.x1 + 380, z0: rz - 160, z1: geo.terminal.airside + 5 };
  const fenceGap = { x0: geo.terminal.x0 - 2, x1: geo.terminal.x1 + 2 };
  const ri = 8; // the road runs this far inside the fence
  const road: P2[] = [
    { x: fence.x0 + ri, z: fence.z0 + ri },
    { x: fence.x1 - ri, z: fence.z0 + ri },
    { x: fence.x1 - ri, z: fence.z1 - ri },
    { x: fence.x0 + ri, z: fence.z1 - ri },
  ];
  // the road leaves the terminal side alone where the hangars, tower and cargo stand
  const roadGap = { x0: cx - (apronSide < 0 ? 1300 : 600), x1: cx + (apronSide < 0 ? 1300 : 600) };
  const als = { x0: rg.x0 - rg.approachLights - 60, x1: rg.x1 + rg.approachLights + 60, half: 45 };
  const region: Rect = { x0: als.x0 - 10, x1: als.x1 + 10, z0: fence.z0 - 10, z1: fence.z1 + 10 };
  // obstruction lights on top of the masts
  for (const g of gs) light({ x: g.x, y: 14.4, z: g.z, group: 'obstruction', size: 0.7 }, RED, 4);
  for (const w of windsocks) light({ x: w.x, y: 6.75, z: w.z, group: 'obstruction', size: 0.6 }, RED, 4);
  for (const l of loc) for (const side of [-1, 1]) light({ x: l.x, y: 3.3, z: l.z + side * l.half, group: 'obstruction', size: 0.6 }, RED, 3.5);

  return {
    ap,
    runway: { cx, cz: rz, halfLen: L / 2, halfW, shoulder: rg.shoulder, blast: BLAST, ...dashes(L), west: '09', east: '27' },
    region,
    fence,
    fenceGap,
    als,
    apron,
    features,
    yellow,
    white,
    red,
    pieces,
    holds,
    lights,
    signs,
    decals,
    alsStations,
    papiUnits,
    loc,
    gs,
    windsocks,
    road,
    roadGap,
  };
}

/** Runway centreline dashes: 30 m painted, 20 m gaps, fitted so both ends start the same way past the designators. */
function dashes(L: number) {
  const dashStart = 66;
  const run = L - 2 * dashStart + 20;
  const n = Math.round(run / 50);
  return { dashPeriod: run / n, dashStart };
}

function outline(out: Stroke[], r: Rect, w: number) {
  const c = [
    { x: r.x0, z: r.z0 },
    { x: r.x1, z: r.z0 },
    { x: r.x1, z: r.z1 },
    { x: r.x0, z: r.z1 },
  ];
  for (let i = 0; i < 4; i++) out.push({ a: c[i], b: c[(i + 1) % 4], w });
}

/** Diagonal hatching inside a rectangle (45°, `gap` apart). */
function hatch(out: Stroke[], r: Rect, gap: number, w: number) {
  const W = r.x1 - r.x0;
  const H = r.z1 - r.z0;
  for (let t = gap / 2; t < W + H; t += gap) {
    // the line x − x0 + (z − z0) = t, clipped to the box
    const a = { x: r.x0 + Math.max(0, t - H), z: r.z0 + Math.min(H, t) };
    const b = { x: r.x0 + Math.min(W, t), z: r.z0 + Math.max(0, t - W) };
    if (len(sub(a, b)) > 0.3) out.push({ a, b, w });
  }
}

/**
 * Blue taxiway edge lights along the edges of the taxiways' main pavement (1.5 m out on the
 * shoulder), and round the apron, wherever the pavement really ends there: `paveAt` is the
 * pavement's signed distance (negative inside), so lights that would stand inside another
 * taxiway's pavement at a junction are left out.
 */
export function addTaxiEdgeLights(plan: AirfieldPlan, paveAt: (x: number, z: number) => number) {
  const rz = plan.runway.cz;
  const keepOff = plan.runway.halfW + plan.runway.shoulder + 3;
  const placed: P2[] = [];
  const tryAt = (p: P2) => {
    if (Math.abs(p.z - rz) < keepOff && p.x > plan.runway.cx - plan.runway.halfLen - BLAST && p.x < plan.runway.cx + plan.runway.halfLen + BLAST) return;
    const d = paveAt(p.x, p.z);
    if (d < 0.8 || d > 2.4) return;
    if (placed.some((q) => Math.abs(q.x - p.x) < 9 && Math.abs(q.z - p.z) < 9)) return;
    placed.push(p);
    plan.lights.push({
      x: p.x,
      y: 0.36,
      z: p.z,
      r: BLUE[0] * 3,
      g: BLUE[1] * 3,
      b: BLUE[2] * 3,
      dx: 0,
      dy: 0,
      dz: 0,
      exp: 1,
      omni: 1,
      size: 0.55,
      flash: -1,
      papi: 0,
      group: 'taxiEdge',
      piece: -1,
      along: 0,
      hold: null,
      elevated: true,
    });
  };
  const sides = (pts: P2[], step: number) => {
    for (const { p, dir } of along(pts, step)) {
      const n = leftOf(dir);
      for (const s of [-1, 1]) tryAt(add(p, n, s * (TAXI_HALF + 1.5)));
    }
  };
  // the straight runs first (the long, regular rows), then the curves
  for (const f of plan.features) {
    const part = f.parts[0];
    if (f.parts.length === 1 && part.kind === 'capsule') sides([part.a, part.b], 45);
  }
  for (const pc of plan.pieces) if (pc.kind === 'arc') sides(pc.pts, 15);
  // round the apron, except along the terminal
  const a = plan.apron;
  const facadeZ = Math.abs(a.z0 - plan.ap.geo.terminal.airside) < 1 ? a.z0 : a.z1;
  const ring: P2[] = [
    { x: a.x0 - 1.5, z: facadeZ },
    { x: a.x0 - 1.5, z: facadeZ === a.z0 ? a.z1 + 1.5 : a.z0 - 1.5 },
    { x: a.x1 + 1.5, z: facadeZ === a.z0 ? a.z1 + 1.5 : a.z0 - 1.5 },
    { x: a.x1 + 1.5, z: facadeZ },
  ];
  for (let i = 1; i < ring.length; i++) for (const { p } of along([ring[i - 1], ring[i]], 40)) tryAt(p);
}

/**
 * Taxi centreline lights to light for a route (follow the greens): the route's straight lines and
 * the turn curves it takes, from node `fromIndex` for up to `ahead` metres, stopping at the first
 * red stop bar. Returns the set of light indices (into plan.lights).
 */
export function guidanceLights(plan: AirfieldPlan, route: string[], fromIndex: number, ahead: number, redHold: (hold: string) => boolean): Set<number> {
  const ap = plan.ap;
  const E = ap.edges;
  const N = ap.nodes;
  const lit = new Set<number>();
  // the edges along the route and their distance from the route's start
  const steps: { edge: number; from: string; start: number; length: number }[] = [];
  let total = 0;
  for (let k = 0; k + 1 < route.length; k++) {
    const a = route[k];
    const b = route[k + 1];
    const edge = E.findIndex((e) => (e.a === a && e.b === b) || (e.b === a && e.a === b));
    const length = Math.hypot(N[b].x - N[a].x, N[b].z - N[a].z);
    steps.push({ edge, from: a, start: total, length });
    total += length;
  }
  // turns along the route: the curve at each node and how far it reaches either side
  const turns: { at: number; tangent: number; piece: number; reversed: boolean }[] = [];
  for (let k = 1; k < steps.length; k++) {
    const e1 = steps[k - 1].edge;
    const e2 = steps[k].edge;
    const node = route[k];
    const pi = plan.pieces.findIndex((p) => p.kind === 'arc' && p.node === node && ((p.edge === e1 && p.edge2 === e2) || (p.edge === e2 && p.edge2 === e1)));
    if (pi < 0) continue;
    const pc = plan.pieces[pi];
    turns.push({ at: steps[k].start, tangent: pc.tangent, piece: pi, reversed: pc.edge !== e1 });
  }
  // A route that ends on the runway is a departure lining up: the greens lead on round the curve
  // onto the centreline, towards the take-off direction of the runway that entry belongs to.
  const last = route[route.length - 1];
  if (steps.length && N[last]?.kind === 'runway') {
    const ident = (['09', '27'] as const).find((id) => ap.runways[id].entries.some((en) => en.runway === last));
    if (ident) {
      const f = headingVec(ap.runways[ident].heading);
      const e1 = steps[steps.length - 1].edge;
      const pi = plan.pieces.findIndex((p) => {
        if (p.kind !== 'arc' || p.node !== last || (p.edge !== e1 && p.edge2 !== e1)) return false;
        const e = E[p.edge === e1 ? p.edge2 : p.edge];
        const to = N[e.a === last ? e.b : e.a];
        return e.name === 'RWY' && (to.x - N[last].x) * f.x + (to.z - N[last].z) * f.z > 0;
      });
      if (pi >= 0) turns.push({ at: total, tangent: plan.pieces[pi].tangent, piece: pi, reversed: plan.pieces[pi].edge !== e1 });
    }
  }
  const startD = steps[Math.min(Math.max(0, fromIndex), Math.max(0, steps.length - 1))]?.start ?? 0;
  let endD = startD + ahead;
  // the route stops at a red stop bar
  for (let k = Math.max(0, fromIndex); k < route.length; k++) {
    const h = plan.holds.find((hh) => hh.id === route[k]);
    if (h && redHold(h.id)) {
      endD = Math.min(endD, (k < steps.length ? steps[k].start : total) - 2);
      break;
    }
  }
  const inTurn = (d: number) => turns.some((t) => Math.abs(d - t.at) < t.tangent - 0.5);
  plan.lights.forEach((l, i) => {
    if (l.group !== 'taxi' || l.piece < 0) return;
    const pc = plan.pieces[l.piece];
    let d = -1;
    if (pc.kind === 'edge') {
      const st = steps.find((s) => s.edge === pc.edge);
      if (!st) return;
      const e = E[pc.edge];
      // `along` runs from the piece's first point; measure it from the step's start node instead
      const fromA = Math.hypot(pc.pts[0].x - N[e.a].x, pc.pts[0].z - N[e.a].z) + l.along;
      const fromStart = st.from === e.a ? fromA : st.length - fromA;
      d = st.start + fromStart;
      if (inTurn(d)) return;
    } else {
      const t = turns.find((tt) => tt.piece === l.piece);
      if (!t) return;
      d = t.at - t.tangent + (t.reversed ? pc.len - l.along : l.along);
    }
    if (d >= startD - 1 && d <= endD) lit.add(i);
  });
  return lit;
}
