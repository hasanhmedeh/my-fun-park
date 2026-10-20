// A taxi route as the crew follows it: the cleared nodes as a polyline, where along it the aircraft
// is, the next turn (which way, how far, onto which taxiway), the speed to taxi at (30 kt on the
// straights, 10 kt through the turns, slowing for the stop at the end) and a point ahead on the
// line for a steering target. The flight's taxi guide and the airfield's follow-the-greens read
// it; the scripted crew steers by it. Pure maths over the taxi network: it runs in node.

import { vecHeading, KT } from '../geo';
import { angleDiff } from '../../aviation/nav';
import type { Airport } from '../../aviation/airports';

export type TaxiTurn = 'left' | 'right' | 'straight' | 'stop';

/** What the taxi guide shows. */
export interface TaxiGuideInfo {
  /** The next manoeuvre and how far ahead it starts (m). */
  turn: TaxiTurn;
  distM: number;
  /** The taxiway after it ("A", "A4", "T", the stand's number), or what stops the taxi ("HA4", "S3"). */
  name: string;
  /** How fast to taxi now (kt), and whether the aircraft is going faster than that. */
  adviceKt: number;
  tooFast: boolean;
  /** How far the aircraft is off the line (m, + right of it). */
  offM: number;
  /** At the end: the reference point is within a few metres of the last node. */
  arrived: boolean;
  /** Metres still to go along the route. */
  leftM: number;
}

export const STRAIGHT_KT = 30;
export const TURN_KT = 10;
/** A change of direction larger than this at a node is a turn (deg). */
const TURN_DEG = 20;
/** Taxi speed falls to TURN_KT this far before a turn, and to walking pace for the last metres of the route. */
const TURN_LEAD_M = 70;
const STOP_LEAD_M = 140;

export const emptyGuide = (): TaxiGuideInfo => ({ turn: 'straight', distM: 0, name: '', adviceKt: STRAIGHT_KT, tooFast: false, offM: 0, arrived: false, leftM: 0 });

export class TaxiPath {
  readonly nodes: readonly string[];
  /** The polyline's points, the length of each segment from its point, and the cumulative distance to each point. */
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly seg: number[] = [];
  private readonly cum: number[] = [];
  /** Each segment's taxiway name (the edge between its two nodes). */
  private readonly names: string[] = [];
  readonly lengthM: number;
  /** The segment the aircraft is on, and how far along the whole route it is (m). */
  index = 0;
  along = 0;
  private off = 0;

  /** Extra points carry the line on past the last node (the line-up along the runway). */
  constructor(ap: Airport, nodes: readonly string[], extra: readonly { x: number; z: number }[] = []) {
    this.nodes = nodes;
    let total = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = ap.nodes[nodes[i]];
      this.xs.push(n.x);
      this.zs.push(n.z);
      this.cum.push(total);
      if (i < nodes.length - 1) {
        const m = ap.nodes[nodes[i + 1]];
        const len = Math.hypot(m.x - n.x, m.z - n.z);
        this.seg.push(len);
        total += len;
        const e = ap.edges.find((ed) => (ed.a === nodes[i] && ed.b === nodes[i + 1]) || (ed.b === nodes[i] && ed.a === nodes[i + 1]));
        this.names.push(e?.name ?? '');
      }
    }
    for (const p of extra) {
      const i = this.xs.length - 1;
      const len = Math.hypot(p.x - this.xs[i], p.z - this.zs[i]);
      this.seg.push(len);
      this.names.push('RWY');
      total += len;
      this.xs.push(p.x);
      this.zs.push(p.z);
      this.cum.push(total);
    }
    this.lengthM = total;
  }

  /** The node index the guidance lights should start from (Airfield.setGuidance). */
  get fromIndex() {
    return this.index;
  }

  /** Where the aircraft is along the route: moves on to the next segment once past this one's end. Call each frame. */
  track(x: number, z: number) {
    const last = this.seg.length - 1;
    if (last < 0) return;
    // look at this segment and the next two: the nearest projection wins, never going backwards
    let best = Infinity;
    let bestI = this.index;
    let bestT = 0;
    for (let i = this.index; i <= Math.min(last, this.index + 2); i++) {
      const t = this.project(i, x, z);
      const px = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
      const pz = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best - 0.5) {
        best = d;
        bestI = i;
        bestT = t;
      }
    }
    // the end of a short segment is passed as soon as the aircraft is beyond it
    while (bestI < last && bestT >= 1) {
      bestI++;
      bestT = this.project(bestI, x, z);
    }
    this.index = bestI;
    this.along = this.cum[bestI] + this.seg[bestI] * bestT;
    const dx = this.xs[bestI + 1] - this.xs[bestI];
    const dz = this.zs[bestI + 1] - this.zs[bestI];
    const len = Math.max(1e-6, this.seg[bestI]);
    // + right of the line: right of direction (fx, fz) is (−fz, fx)
    this.off = ((x - this.xs[bestI]) * -dz + (z - this.zs[bestI]) * dx) / len;
  }

  /** A point `ahead` metres further along the route than the aircraft (clamped to its end). */
  pointAhead(ahead: number, out: { x: number; z: number }) {
    const d = Math.min(this.lengthM, this.along + ahead);
    let i = this.index;
    while (i < this.seg.length - 1 && this.cum[i + 1] < d) i++;
    const t = this.seg[i] > 0 ? Math.min(1, (d - this.cum[i]) / this.seg[i]) : 1;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
    return out;
  }

  /** The direction of the route where the aircraft is (deg). */
  get heading() {
    const i = this.index;
    return vecHeading(this.xs[i + 1] - this.xs[i], this.zs[i + 1] - this.zs[i]);
  }

  /** The guide for the aircraft now (after track()); `gsKt` is the ground speed. */
  guide(gsKt: number, out: TaxiGuideInfo) {
    const n = this.seg.length;
    const left = Math.max(0, this.lengthM - this.along);
    out.leftM = left;
    out.offM = this.off;
    out.arrived = n === 0 || left < 4;
    // the next node with a real change of direction
    let turnAt = -1;
    let turnDeg = 0;
    for (let j = this.index + 1; j < n; j++) {
      const h0 = vecHeading(this.xs[j] - this.xs[j - 1], this.zs[j] - this.zs[j - 1]);
      const h1 = vecHeading(this.xs[j + 1] - this.xs[j], this.zs[j + 1] - this.zs[j]);
      const d = angleDiff(h1, h0);
      if (Math.abs(d) >= TURN_DEG) {
        turnAt = j;
        turnDeg = d;
        break;
      }
    }
    if (turnAt >= 0) {
      out.turn = turnDeg > 0 ? 'right' : 'left';
      out.distM = Math.max(0, this.cum[turnAt] - this.along);
      out.name = this.names[turnAt] ?? '';
    } else {
      out.turn = 'stop';
      out.distM = left;
      out.name = this.nodes[this.nodes.length - 1] ?? '';
    }
    // the speed: 30 on the straights, 10 through a turn (and for a lead-in to it), a gentle stop at the end
    let adv = STRAIGHT_KT;
    if (turnAt >= 0 && out.distM < TURN_LEAD_M) adv = TURN_KT;
    // just through a turn (the first metres of the new segment), still 10
    if (this.index > 0 && this.along - this.cum[this.index] < 25) {
      const h0 = vecHeading(this.xs[this.index] - this.xs[this.index - 1], this.zs[this.index] - this.zs[this.index - 1]);
      if (Math.abs(angleDiff(this.heading, h0)) >= TURN_DEG) adv = TURN_KT;
    }
    if (left < STOP_LEAD_M) adv = Math.min(adv, Math.max(3, 4 + (left / STOP_LEAD_M) * 16));
    out.adviceKt = adv;
    out.tooFast = gsKt > adv + 5;
  }

  /** Metres to the route's end from a point (straight line). */
  distToEnd(x: number, z: number) {
    return Math.hypot(this.xs[this.xs.length - 1] - x, this.zs[this.zs.length - 1] - z);
  }

  private project(i: number, x: number, z: number) {
    const dx = this.xs[i + 1] - this.xs[i];
    const dz = this.zs[i + 1] - this.zs[i];
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-6) return 1;
    return Math.max(0, Math.min(1, ((x - this.xs[i]) * dx + (z - this.zs[i]) * dz) / l2));
  }
}

/** Ground speed in m/s for a taxi speed in kt (the crew's speed loop). */
export const ktToMs = (kt: number) => kt * KT;
