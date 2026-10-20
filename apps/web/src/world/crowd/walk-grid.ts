import { Obstacles } from './obstacles';

// Where the airports' and the island's people can walk: a fine occupancy grid over one site (a
// terminal, the beach park), rasterised once from the walk areas and the static colliders at
// walking height, with an A* search over it and the route pulled taut afterwards. The park's
// crowd walks a hand-laid path network instead; a terminal full of seat rows, desks, queue lanes
// and shops is far easier to get right from the colliders that are already there.

export interface V2 {
  x: number;
  z: number;
}

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const SQRT2 = Math.SQRT2;
/** Neighbour steps: the four sides, then the four diagonals. */
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * The search's working arrays, shared by every grid (they search one at a time) and grown to the
 * largest. `stamp` marks which cells belong to the current search, so nothing is cleared between.
 */
const work = {
  size: 0,
  g: new Float32Array(0),
  from: new Uint8Array(0),
  stamp: new Uint16Array(0),
  closed: new Uint16Array(0),
  run: 0,
  heap: new Int32Array(1024),
  f: new Float32Array(1024),
};

function ensureWork(n: number) {
  if (work.size >= n) return;
  work.size = n;
  work.g = new Float32Array(n);
  work.from = new Uint8Array(n);
  work.stamp = new Uint16Array(n);
  work.closed = new Uint16Array(n);
  work.run = 0;
}

export class WalkGrid {
  readonly nx: number;
  readonly nz: number;
  /** 1 where nobody can stand: outside the walk areas, or inside something solid. */
  private blocked: Uint8Array;
  /** After `connect`: 1 for the cells reachable on foot from its seed (null until then). */
  private reach: Uint8Array | null = null;

  constructor(
    readonly bounds: Rect,
    readonly cell: number,
    walk: Rect[],
    private readonly obs: Obstacles,
    /** How close to a collider a person's centre may come. */
    private readonly margin = 0.3,
  ) {
    this.nx = Math.ceil((bounds.x1 - bounds.x0) / cell);
    this.nz = Math.ceil((bounds.z1 - bounds.z0) / cell);
    this.blocked = new Uint8Array(this.nx * this.nz).fill(1);
    // open the walk areas (a cell counts if its centre is in one)
    for (const r of walk) {
      const [i0, i1] = this.span(r.x0, r.x1, this.bounds.x0, this.nx);
      const [k0, k1] = this.span(r.z0, r.z1, this.bounds.z0, this.nz);
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.blocked[k * this.nx + i] = 0;
    }
    // then close whatever stands in them
    const out = { x: 0, z: 0 };
    for (const o of obs.list) {
      const reach = (o.kind === 'circle' ? o.r : Math.hypot(o.hx, o.hz)) + margin;
      if (o.x + reach < bounds.x0 || o.x - reach > bounds.x1 || o.z + reach < bounds.z0 || o.z - reach > bounds.z1) continue;
      const [i0, i1] = this.span(o.x - reach - cell, o.x + reach + cell, this.bounds.x0, this.nx);
      const [k0, k1] = this.span(o.z - reach - cell, o.z + reach + cell, this.bounds.z0, this.nz);
      // something thinner than a cell (a rail, a rope post) could fall between the cells' centres:
      // those are tried at four more points across each cell too
      const thin = (o.kind === 'circle' ? o.r : Math.min(o.hx, o.hz)) + margin < cell * 0.5;
      const q = cell * 0.25;
      for (let k = k0; k <= k1; k++)
        for (let i = i0; i <= i1; i++) {
          const x = bounds.x0 + (i + 0.5) * cell;
          const z = bounds.z0 + (k + 0.5) * cell;
          if (
            Obstacles.depth(o, x, z, margin, out) > 0 ||
            (thin && (Obstacles.depth(o, x - q, z - q, margin, out) > 0 || Obstacles.depth(o, x + q, z - q, margin, out) > 0 || Obstacles.depth(o, x - q, z + q, margin, out) > 0 || Obstacles.depth(o, x + q, z + q, margin, out) > 0))
          )
            this.blocked[k * this.nx + i] = 1;
        }
    }
    ensureWork(this.nx * this.nz);
  }

  /** The cells whose centres lie in [a, b] along one axis, clamped to the grid. */
  private span(a: number, b: number, origin: number, n: number): [number, number] {
    const c = this.cell;
    return [Math.max(0, Math.ceil((a - origin) / c - 0.5)), Math.min(n - 1, Math.floor((b - origin) / c - 0.5))];
  }

  private index(x: number, z: number) {
    const i = Math.floor((x - this.bounds.x0) / this.cell);
    const k = Math.floor((z - this.bounds.z0) / this.cell);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return -1;
    return k * this.nx + i;
  }

  contains(x: number, z: number) {
    return x >= this.bounds.x0 && x < this.bounds.x1 && z >= this.bounds.z0 && z < this.bounds.z1;
  }

  free(x: number, z: number) {
    const c = this.index(x, z);
    return c >= 0 && !this.blocked[c];
  }

  /** Close (or reopen) a rectangle: doorways one way only, plots that later builders fill. */
  setBlocked(r: Rect, on: boolean) {
    const [i0, i1] = this.span(r.x0, r.x1, this.bounds.x0, this.nx);
    const [k0, k1] = this.span(r.z0, r.z1, this.bounds.z0, this.nz);
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.blocked[k * this.nx + i] = on ? 1 : 0;
  }

  /**
   * Flood the free cells reachable on foot from (x, z) (as the search steps: no cutting corners),
   * so spots walled off in a pocket of their own can be told apart (`linked`, `nearestLinked`).
   */
  connect(x: number, z: number) {
    const s0 = this.nearestFree(x, z, 4);
    const reach = new Uint8Array(this.nx * this.nz);
    this.reach = reach;
    if (!s0) return;
    const nx = this.nx;
    const stack = new Int32Array(this.nx * this.nz);
    let n = 0;
    const s = this.index(s0.x, s0.z);
    reach[s] = 1;
    stack[n++] = s;
    while (n > 0) {
      const c = stack[--n];
      const ix = c % nx;
      const iz = (c - ix) / nx;
      for (let d = 0; d < 8; d++) {
        const jx = ix + DX[d];
        const jz = iz + DZ[d];
        if (jx < 0 || jz < 0 || jx >= nx || jz >= this.nz) continue;
        const m = jz * nx + jx;
        if (this.blocked[m] || reach[m]) continue;
        if (d >= 4 && (this.blocked[iz * nx + jx] || this.blocked[jz * nx + ix])) continue;
        reach[m] = 1;
        stack[n++] = m;
      }
    }
  }

  /** Free and reachable from `connect`'s seed (just free, before it's called). */
  linked(x: number, z: number) {
    const c = this.index(x, z);
    return c >= 0 && !this.blocked[c] && (!this.reach || this.reach[c] === 1);
  }

  /** The nearest linked cell's centre within `maxR` metres, or null. */
  nearestLinked(x: number, z: number, maxR = 4): V2 | null {
    return this.nearestFree(x, z, maxR, this.reach);
  }

  /** The nearest free cell's centre within `maxR` metres (rings outward), or null. */
  nearestFree(x: number, z: number, maxR = 4, within: Uint8Array | null = null): V2 | null {
    const c0 = this.index(x, z);
    if (c0 >= 0 && !this.blocked[c0] && (!within || within[c0])) return { x, z };
    const c = this.cell;
    const ci = Math.floor((x - this.bounds.x0) / c);
    const ck = Math.floor((z - this.bounds.z0) / c);
    let best: V2 | null = null;
    let bd = Infinity;
    const rings = Math.ceil(maxR / c);
    for (let r = 1; r <= rings; r++) {
      for (let k = ck - r; k <= ck + r; k++)
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(k - ck)) !== r) continue;
          if (i < 0 || k < 0 || i >= this.nx || k >= this.nz || this.blocked[k * this.nx + i] || (within && !within[k * this.nx + i])) continue;
          const px = this.bounds.x0 + (i + 0.5) * c;
          const pz = this.bounds.z0 + (k + 0.5) * c;
          const d = (px - x) ** 2 + (pz - z) ** 2;
          if (d < bd) {
            bd = d;
            best = { x: px, z: pz };
          }
        }
      // a ring's corners are farther than the next ring's sides: one more ring settles it
      if (best && Math.sqrt(bd) <= r * c) break;
    }
    return best && Math.sqrt(bd) <= maxR ? best : null;
  }

  /**
   * Is the straight line a→b free all the way (sampled at a third of a cell)? And clear of the
   * colliders themselves: a coarse grid's cells are closed by their centres, so a line between two
   * open ones can still clip the corner of something narrower than a cell or two.
   */
  clear(ax: number, az: number, bx: number, bz: number) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (this.cell / 3)));
    for (let i = 0; i <= n; i++) if (!this.free(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return false;
    return this.cell < 0.75 || this.obs.clear(ax, az, bx, bz, Math.min(this.margin, 0.3));
  }

  /**
   * A walkable route from a to b (both moved to the nearest free cell first), pulled taut: the
   * corners only. Appends to `out` (without the start) and returns false if there is no way.
   * `limit` caps the cells searched, so a hopeless search can't stall a frame.
   */
  route(ax: number, az: number, bx: number, bz: number, out: V2[], limit = 400000): boolean {
    const a = this.nearestFree(ax, az, 3);
    if (!a) return false;
    // (from the main walk, to the nearest cell joined to it: not into a pocket walled off by itself)
    const b = this.reach && this.reach[this.index(a.x, a.z)] ? this.nearestLinked(bx, bz, 4) : this.nearestFree(bx, bz, 4);
    if (!b) return false;
    const s = this.index(a.x, a.z);
    const t = this.index(b.x, b.z);
    if (s === t) {
      out.push(b);
      return true;
    }
    const W = work;
    if (++W.run >= 65535) {
      W.stamp.fill(0);
      W.closed.fill(0);
      W.run = 1;
    }
    const run = W.run;
    const nx = this.nx;
    const tx = t % nx;
    const tz = (t - tx) / nx;
    const h = (c: number) => {
      const ix = c % nx;
      const dx = Math.abs(ix - tx);
      const dz = Math.abs((c - ix) / nx - tz);
      return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * 1.001;
    };
    let size = 0;
    const push = (c: number, f: number) => {
      if (size >= W.heap.length) {
        const heap = new Int32Array(W.heap.length * 2);
        heap.set(W.heap);
        W.heap = heap;
        const ff = new Float32Array(W.f.length * 2);
        ff.set(W.f);
        W.f = ff;
      }
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (W.f[p] <= f) break;
        W.heap[i] = W.heap[p];
        W.f[i] = W.f[p];
        i = p;
      }
      W.heap[i] = c;
      W.f[i] = f;
    };
    const pop = () => {
      const top = W.heap[0];
      const lastC = W.heap[--size];
      const lastF = W.f[size];
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= size) break;
        if (m + 1 < size && W.f[m + 1] < W.f[m]) m++;
        if (W.f[m] >= lastF) break;
        W.heap[i] = W.heap[m];
        W.f[i] = W.f[m];
        i = m;
      }
      W.heap[i] = lastC;
      W.f[i] = lastF;
      return top;
    };
    W.stamp[s] = run;
    W.g[s] = 0;
    push(s, h(s));
    let found = false;
    let searched = 0;
    while (size > 0) {
      const c = pop();
      if (W.closed[c] === run) continue;
      W.closed[c] = run;
      if (c === t) {
        found = true;
        break;
      }
      if (++searched > limit) break;
      const ix = c % nx;
      const iz = (c - ix) / nx;
      for (let d = 0; d < 8; d++) {
        const jx = ix + DX[d];
        const jz = iz + DZ[d];
        if (jx < 0 || jz < 0 || jx >= nx || jz >= this.nz) continue;
        const n = jz * nx + jx;
        if (this.blocked[n] || W.closed[n] === run) continue;
        // no cutting corners past something solid
        if (d >= 4 && (this.blocked[iz * nx + jx] || this.blocked[jz * nx + ix])) continue;
        const g = W.g[c] + (d >= 4 ? SQRT2 : 1);
        if (W.stamp[n] === run && W.g[n] <= g) continue;
        W.stamp[n] = run;
        W.g[n] = g;
        W.from[n] = d;
        push(n, g + h(n));
      }
    }
    if (!found) return false;
    // walk back to the start, then pull the string: keep only the corners that block the view
    const cells: number[] = [];
    for (let c = t; c !== s; ) {
      cells.push(c);
      const d = W.from[c];
      const ix = c % nx;
      c = ((c - ix) / nx - DZ[d]) * nx + (ix - DX[d]);
    }
    cells.reverse();
    const centre = (c: number): V2 => {
      const ix = c % nx;
      return { x: this.bounds.x0 + (ix + 0.5) * this.cell, z: this.bounds.z0 + (((c - ix) / nx) + 0.5) * this.cell };
    };
    let from: V2 = a;
    let i = 0;
    while (i < cells.length) {
      // the farthest cell still in plain sight (stepping back from the end, a few at a time)
      let j = cells.length - 1;
      while (j > i) {
        const p = j === cells.length - 1 ? b : centre(cells[j]);
        if (this.clear(from.x, from.z, p.x, p.z)) break;
        j -= Math.max(1, Math.floor((j - i) / 6));
      }
      // (the next cell along always is: it touches the last corner)
      j = Math.max(j, i);
      const p = j === cells.length - 1 ? b : centre(cells[j]);
      out.push(p);
      from = p;
      i = j + 1;
    }
    return true;
  }
}
