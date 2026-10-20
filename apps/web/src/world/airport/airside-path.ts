// Paths on the ground for everything that drives or taxis round the airside: a polyline whose
// corners are rounded into circular arcs, sampled densely so a vehicle (or an AI aircraft's
// reference point) can be placed at any distance along it, with its heading and the safe speed
// for the curvature it is on.
//
// Paths are built once (the vehicles' loops when the airside is made, an AI aircraft's taxi route
// when it's cleared) and read every frame without allocating.

export interface P2 {
  x: number;
  z: number;
}

/** A pose on the ground: position and heading (degrees clockwise from north). */
export interface Pose2 {
  x: number;
  z: number;
  heading: number;
}

const DEG = 180 / Math.PI;

/** Wraps an angle difference (degrees) into −180..180. */
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export class Path {
  /** Sampled points, their distance from the start, and the curvature radius there (Infinity on straights). */
  private readonly xs: Float64Array;
  private readonly zs: Float64Array;
  private readonly ss: Float64Array;
  private readonly rs: Float64Array;
  readonly length: number;
  readonly closed: boolean;
  private hint = 0;

  /**
   * `pts` are the corners; `radius` is how round each interior corner is (one value for all, or
   * one per point; it's limited by half of each neighbouring leg, so short legs still meet). A
   * closed path rounds its first and last corners too.
   */
  constructor(pts: readonly P2[], radius: number | readonly number[], closed = false, step = 1.5) {
    this.closed = closed;
    const n = pts.length;
    const rad = (i: number) => (typeof radius === 'number' ? radius : (radius[i] ?? radius[radius.length - 1]));
    // each sample: where, the curvature radius, and which corner's arc it's on (−1: none)
    const out: { x: number; z: number; r: number; a: number }[] = [];
    const corner = (i: number) => {
      const p = pts[(i + n) % n];
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      const ax = a.x - p.x;
      const az = a.z - p.z;
      const bx = b.x - p.x;
      const bz = b.z - p.z;
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      const cos = (ax * bx + az * bz) / (la * lb);
      const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2; // half the angle between the legs
      // straight on (or a reversal): no arc
      if (la < 1e-6 || lb < 1e-6 || Math.abs(Math.PI / 2 - half) < 1e-3 || half < 1e-3) {
        out.push({ x: p.x, z: p.z, r: Infinity, a: -1 });
        return;
      }
      const turn = Math.PI - 2 * half; // the change of heading through the corner
      // the tangent length for the wanted radius, limited to half of each leg
      let t = rad(i) * Math.tan(turn / 2);
      t = Math.min(t, la / 2, lb / 2);
      const r = t / Math.tan(turn / 2);
      const ux = ax / la;
      const uz = az / la;
      const vx = bx / lb;
      const vz = bz / lb;
      const t0x = p.x + ux * t;
      const t0z = p.z + uz * t;
      const t1x = p.x + vx * t;
      const t1z = p.z + vz * t;
      // the arc's centre lies along the bisector
      const bisx = ux + vx;
      const bisz = uz + vz;
      const bl = Math.hypot(bisx, bisz);
      const d = r / Math.sin(half);
      const cx = p.x + (bisx / bl) * d;
      const cz = p.z + (bisz / bl) * d;
      const a0 = Math.atan2(t0z - cz, t0x - cx);
      let a1 = Math.atan2(t1z - cz, t1x - cx);
      // go the short way round
      let da = a1 - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      a1 = a0 + da;
      const segs = Math.max(2, Math.ceil((Math.abs(da) * r) / step));
      for (let k = 0; k <= segs; k++) {
        const ang = a0 + (da * k) / segs;
        out.push({ x: cx + Math.cos(ang) * r, z: cz + Math.sin(ang) * r, r, a: i });
      }
    };
    if (closed) for (let i = 0; i < n; i++) corner(i);
    else {
      out.push({ x: pts[0].x, z: pts[0].z, r: Infinity, a: -1 });
      for (let i = 1; i < n - 1; i++) corner(i);
      out.push({ x: pts[n - 1].x, z: pts[n - 1].z, r: Infinity, a: -1 });
    }
    if (closed) out.push({ ...out[0] });
    // straight legs between the arcs are subdivided too, so the samples are evenly spread
    const dense: { x: number; z: number; r: number; a: number }[] = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1];
      const b = out[i];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      if (l < 1e-6) continue;
      const k = Math.max(1, Math.ceil(l / (step * 4)));
      // along an arc the radius is the arc's; between two arcs (a straight) there is none
      const arc = a.a >= 0 && a.a === b.a;
      for (let j = 1; j <= k; j++) dense.push({ x: a.x + ((b.x - a.x) * j) / k, z: a.z + ((b.z - a.z) * j) / k, r: j === k ? b.r : arc ? a.r : Infinity, a: j === k ? b.a : arc ? a.a : -1 });
    }
    const m = dense.length;
    this.xs = new Float64Array(m);
    this.zs = new Float64Array(m);
    this.ss = new Float64Array(m);
    this.rs = new Float64Array(m);
    let s = 0;
    for (let i = 0; i < m; i++) {
      if (i > 0) s += Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z);
      this.xs[i] = dense[i].x;
      this.zs[i] = dense[i].z;
      this.ss[i] = s;
      this.rs[i] = dense[i].r;
    }
    this.length = s;
  }

  /** Wraps (closed) or clamps (open) a distance onto the path. */
  norm(s: number) {
    if (this.closed) return ((s % this.length) + this.length) % this.length;
    return Math.max(0, Math.min(this.length, s));
  }

  private index(s: number) {
    const ss = this.ss;
    let i = Math.min(this.hint, ss.length - 2);
    // walk from the last lookup (paths are read in order), else bisect
    if (s >= ss[i] && s <= ss[i + 1]) return i;
    if (i + 2 < ss.length && s >= ss[i + 1] && s <= ss[i + 2]) return (this.hint = i + 1);
    let lo = 0;
    let hi = ss.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ss[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
    this.hint = i;
    return i;
  }

  /** The pose at distance `s` (heading along the direction of travel). */
  at(s: number, out: Pose2): Pose2 {
    s = this.norm(s);
    const i = this.index(s);
    const s0 = this.ss[i];
    const s1 = this.ss[i + 1];
    const k = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const x0 = this.xs[i];
    const z0 = this.zs[i];
    const x1 = this.xs[i + 1];
    const z1 = this.zs[i + 1];
    out.x = x0 + (x1 - x0) * k;
    out.z = z0 + (z1 - z0) * k;
    // the heading blends with the neighbouring segments' (each segment's own at its middle), so
    // turns don't step
    const h0 = Math.atan2(x1 - x0, -(z1 - z0)) * DEG;
    let h = h0;
    if (k < 0.5 && i > 0) {
      const hp = Math.atan2(x0 - this.xs[i - 1], -(z0 - this.zs[i - 1])) * DEG;
      h = hp + wrap180(h0 - hp) * (0.5 + k);
    } else if (k >= 0.5 && i + 2 < this.xs.length) {
      const hn = Math.atan2(this.xs[i + 2] - x1, -(this.zs[i + 2] - z1)) * DEG;
      h = h0 + wrap180(hn - h0) * (k - 0.5);
    }
    out.heading = ((h % 360) + 360) % 360;
    return out;
  }

  /** The tightest radius within `ahead` metres past `s` (Infinity on a straight). */
  radiusAhead(s: number, ahead: number) {
    let r = Infinity;
    const end = s + ahead;
    // a coarse scan is enough: arcs are sampled every metre or two
    for (let d = s; d <= end; d += 2) {
      if (!this.closed && d > this.length) break;
      const i = this.index(this.norm(d));
      if (this.rs[i] < r) r = this.rs[i];
    }
    return r;
  }

  /** The distance along the path nearest to a point (a full scan: only for setting things up). */
  project(x: number, z: number) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.xs.length - 1; i++) {
      const ax = this.xs[i];
      const az = this.zs[i];
      const dx = this.xs[i + 1] - ax;
      const dz = this.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz;
      const k = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(ax + dx * k - x, az + dz * k - z);
      if (d < bd) {
        bd = d;
        best = this.ss[i] + (this.ss[i + 1] - this.ss[i]) * k;
      }
    }
    return best;
  }
}

/** The safe speed (m/s) round a curve of radius r with a lateral acceleration a (m/s²), up to vmax. */
export function curveSpeed(r: number, a: number, vmax: number) {
  return Math.min(vmax, Math.sqrt(a * r));
}

/** The speed from which a vehicle can still stop within d metres braking at b m/s². */
export function stopSpeed(d: number, b: number) {
  return d > 0 ? Math.sqrt(2 * b * d) : 0;
}
