import { PARK, PATHS, PLAZAS } from '../layout';
import type { Obstacle, Obstacles } from './obstacles';

export interface NavNode {
  id: number;
  x: number;
  z: number;
  /** Half the width of the path here: walkers spread across it instead of single-filing. */
  half: number;
  links: number[];
  /** False once cut off from the rest of the park by an obstacle. */
  live: boolean;
}

/**
 * The walkable network: every path polyline becomes a chain of nodes (split where other paths
 * join it and every few metres along long stretches), and every plaza gets a hub node.
 */
export class NavGraph {
  nodes: NavNode[] = [];

  constructor() {
    const SPLIT = 9; // max metres between nodes, so walkers can turn off mid-avenue
    const ends = PATHS.flatMap((p) => p.points);

    for (const path of PATHS) {
      let prev = -1;
      for (let i = 0; i < path.points.length - 1; i++) {
        const [ax, az] = path.points[i];
        const [bx, bz] = path.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        // where along this segment other paths start or end (junctions)
        const cuts = new Set<number>([0, 1]);
        for (const [px, pz] of ends) {
          const t = ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / (len * len);
          if (t <= 0 || t >= 1) continue;
          if (Math.hypot(ax + (bx - ax) * t - px, az + (bz - az) * t - pz) < 1) cuts.add(t);
        }
        const sorted = [...cuts].sort((a, b) => a - b);
        const ts: number[] = [];
        for (let k = 0; k < sorted.length - 1; k++) {
          const steps = Math.max(1, Math.ceil(((sorted[k + 1] - sorted[k]) * len) / SPLIT));
          for (let j = 0; j < steps; j++) ts.push(sorted[k] + ((sorted[k + 1] - sorted[k]) * j) / steps);
        }
        if (i === path.points.length - 2) ts.push(1);
        for (const t of ts) {
          if (i > 0 && t === 0) continue; // shared with the previous segment
          const id = this.node(ax + (bx - ax) * t, az + (bz - az) * t, path.width / 2);
          if (prev >= 0 && prev !== id) this.link(prev, id);
          prev = id;
        }
      }
    }
    // plazas: a hub linked to every node inside them
    for (const [x, z, r] of PLAZAS) {
      const hub = this.node(x, z, r * 0.6);
      for (const n of this.nodes) if (n.id !== hub && Math.hypot(n.x - x, n.z - z) < r) this.link(hub, n.id);
    }
  }

  private node(x: number, z: number, half: number) {
    const near = this.nodes.find((n) => Math.hypot(n.x - x, n.z - z) < 1.2);
    if (near) {
      near.half = Math.max(near.half, half);
      return near.id;
    }
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, half, links: [], live: true });
    return id;
  }

  private unlink(a: number, b: number) {
    this.nodes[a].links = this.nodes[a].links.filter((l) => l !== b);
    this.nodes[b].links = this.nodes[b].links.filter((l) => l !== a);
  }

  /**
   * Make the network walkable around solid things. Nodes inside an obstacle and links through
   * one are removed; every big round obstacle in the way (the carousel) gets a ring of
   * waypoints around it, and the loose ends are tied back to the ring (or to each other) by
   * line of sight. Whatever still can't be reached from `home` is retired.
   */
  repair(obs: Obstacles, home: { x: number; z: number }) {
    const loose = new Set<number>();
    const rings = new Map<object, number[]>();
    const ringFor = (o: Obstacle) => {
      if (o.kind !== 'circle' || o.r < 1.5) return;
      if (rings.has(o)) return;
      // enough nodes that every chord between neighbours stays clear of the circle
      // wide enough to pass outside lamp posts and the like standing round it
      const R = o.r + 2.2;
      // (big ones get extra nodes, so the chords hug the ring and pass outside lamps on it)
      const n = Math.max(o.r > 5 ? 14 : 6, Math.ceil(Math.PI / Math.acos((o.r + 0.6) / R)));
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const p = { x: o.x + Math.cos(a) * R, z: o.z + Math.sin(a) * R };
        obs.push(p, 0.5);
        if (obs.inside(p.x, p.z, 0.3)) continue;
        const id = this.nodes.length;
        this.nodes.push({ id, x: p.x, z: p.z, half: 1.2, links: [], live: true });
        ids.push(id);
      }
      for (let i = 0; i < ids.length; i++) {
        const a = this.nodes[ids[i]];
        // the next one round, or the one after if something stands in between
        for (const k of [1, 2]) {
          const b = this.nodes[ids[(i + k) % ids.length]];
          if (obs.clear(a.x, a.z, b.x, b.z, 0.3)) {
            this.link(a.id, b.id);
            break;
          }
        }
      }
      rings.set(o, ids);
    };
    // nodes stuck inside something
    for (const n of this.nodes) {
      const o = obs.inside(n.x, n.z, 0.6);
      if (!o) continue;
      ringFor(o);
      for (const l of [...n.links]) {
        this.unlink(n.id, l);
        loose.add(l);
      }
      n.live = false;
    }
    // links cutting through something
    for (const a of this.nodes) {
      if (!a.live) continue;
      for (const l of [...a.links]) {
        const b = this.nodes[l];
        if (obs.clear(a.x, a.z, b.x, b.z, 0.4)) continue;
        const blockers = new Set<Obstacle>();
        for (let t = 0; t <= 1; t += 0.05) {
          const o = obs.inside(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 0.4);
          if (o) ringFor(o), blockers.add(o);
        }
        this.unlink(a.id, b.id);
        // a lamp post or a sign standing in the path: step round it
        if (!this.detour(obs, a, b, blockers)) loose.add(a.id).add(b.id);
      }
    }
    // tie the loose ends back in: to the nearest visible ring nodes, else to visible neighbours
    const ringIds = new Set([...rings.values()].flat());
    for (const id of loose) {
      const a = this.nodes[id];
      if (!a.live) continue;
      const cands = this.nodes
        .filter((b) => b.live && b.id !== a.id && !a.links.includes(b.id) && Math.hypot(b.x - a.x, b.z - a.z) < 14)
        // ring waypoints first, nearest first
        .sort((p, q) => Number(ringIds.has(q.id)) - Number(ringIds.has(p.id)) || Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(q.x - a.x, q.z - a.z));
      let tied = 0;
      for (const b of cands) {
        if (tied >= 2) break;
        if (obs.clear(a.x, a.z, b.x, b.z, 0.4)) {
          this.link(a.id, b.id);
          tied++;
        }
      }
    }
    // keep only what's connected to the entrance
    const start = this.nearest(home.x, home.z);
    const seen = new Set([start.id]);
    const stack = [start.id];
    while (stack.length) for (const l of this.nodes[stack.pop()!].links) if (!seen.has(l)) seen.add(l), stack.push(l);
    for (const n of this.nodes) n.live = n.live && seen.has(n.id);
    // something new standing across a path can cut most of the park off, leaving everyone to
    // spawn and wander in the few metres still connected to the entrance
    const live = this.nodes.filter((n) => n.live).length;
    if (import.meta.env.DEV && live < this.nodes.length * 0.85) console.warn(`crowd: only ${live} of ${this.nodes.length} path nodes connect to the entrance`);
  }

  /**
   * Re-link a → b round a single small obstacle (a post, a sign, a bin) standing across the link:
   * through a waypoint beside it, on whichever side is clear. False if there's no way round.
   */
  private detour(obs: Obstacles, a: NavNode, b: NavNode, blockers: Set<Obstacle>) {
    if (blockers.size !== 1) return false;
    const [o] = blockers;
    const size = o.kind === 'circle' ? o.r : Math.hypot(o.hx, o.hz);
    if (size > 1.5) return false;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len;
    const nz = dx / len;
    // round the side with more room first: away from the link, past the obstacle's middle
    const s = Math.sign((o.x - a.x) * nx + (o.z - a.z) * nz) || 1;
    for (const side of [-s, s]) {
      const p = { x: o.x + nx * side * (size + 0.9), z: o.z + nz * side * (size + 0.9) };
      if (obs.inside(p.x, p.z, 0.4) || !obs.clear(a.x, a.z, p.x, p.z, 0.4) || !obs.clear(p.x, p.z, b.x, b.z, 0.4)) continue;
      const id = this.nodes.length;
      this.nodes.push({ id, x: p.x, z: p.z, half: 1.2, links: [], live: true });
      this.link(a.id, id);
      this.link(id, b.id);
      return true;
    }
    return false;
  }

  private link(a: number, b: number) {
    if (!this.nodes[a].links.includes(b)) this.nodes[a].links.push(b);
    if (!this.nodes[b].links.includes(a)) this.nodes[b].links.push(a);
  }

  nearest(x: number, z: number) {
    let best = this.nodes[0];
    let bd = Infinity;
    for (const n of this.nodes) {
      if (!n.live) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /** Shortest route between two nodes (Dijkstra; the graph is tiny). */
  route(from: number, to: number): NavNode[] {
    const dist = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const done = new Uint8Array(this.nodes.length);
    dist[from] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === to) break;
      done[u] = 1;
      const a = this.nodes[u];
      for (const v of a.links) {
        const b = this.nodes[v];
        const d = dist[u] + Math.hypot(a.x - b.x, a.z - b.z);
        if (d < dist[v]) {
          dist[v] = d;
          prev[v] = u;
        }
      }
    }
    const out: NavNode[] = [];
    for (let v = to; v >= 0; v = prev[v]) out.unshift(this.nodes[v]);
    return out[0]?.id === from ? out : [this.nodes[to]];
  }

  /** A random walkable node, optionally only within `radius` of the park centre. */
  random(rand: () => number, radius = Infinity) {
    const pool = this.nodes.filter((n) => n.live && Math.hypot(n.x - PARK.x, n.z - PARK.z) < radius);
    return pool[Math.floor(rand() * pool.length)];
  }
}
