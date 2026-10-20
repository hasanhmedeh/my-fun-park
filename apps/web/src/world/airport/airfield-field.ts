// The pavement as a signed distance field (negative on the pavement), rasterised once from the
// plan into a one-channel texture the airfield's ground shader draws from (and the CPU reads for
// surfaceAt).
//
// A distance field keeps the pavement's edges, its shoulders and the taxiway edge lines crisp at
// any range from a texture of about a metre per texel: near an edge the distance is linear, so
// bilinear filtering rebuilds it exactly and the shader draws a 15 cm edge line with an
// anti-aliased edge however close the camera gets. Junction fillets come from a smooth union of
// the shapes. Thin painted strokes can't live in it: a stroke's distance is V-shaped across the
// line, which bilinear filtering flattens away between texels, so they are a mesh of their own
// (airfield-paint.ts).

import { PAVE_MAX, type AirfieldPlan, type Part, type P2, type Rect } from './airfield-plan';

export const PAVE_RANGE = { lo: -1, hi: PAVE_MAX + 1 };

export interface PaveField {
  w: number;
  h: number;
  /** The field's rectangle in world metres (texel centres sit half a texel in from its edges). */
  rect: Rect;
  dx: number;
  dz: number;
  /** One byte per texel (the distance over PAVE_RANGE), row-major from rect.z0, rect.x0. */
  data: Uint8Array;
}

function partDist(p: Part, x: number, z: number) {
  if (p.kind === 'box') {
    const cx = (p.x0 + p.x1) / 2;
    const cz = (p.z0 + p.z1) / 2;
    const qx = Math.abs(x - cx) - ((p.x1 - p.x0) / 2 - p.r);
    const qz = Math.abs(z - cz) - ((p.z1 - p.z0) / 2 - p.r);
    const ox = Math.max(qx, 0);
    const oz = Math.max(qz, 0);
    return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - p.r;
  }
  return segDist(p.a, p.b, x, z) - p.r;
}

function segDist(a: P2, b: P2, x: number, z: number) {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2)) : 0;
  return Math.hypot(x - a.x - vx * t, z - a.z - vz * t);
}

function partBox(p: Part): Rect {
  if (p.kind === 'box') return { x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 };
  return { x0: Math.min(p.a.x, p.b.x) - p.r, x1: Math.max(p.a.x, p.b.x) + p.r, z0: Math.min(p.a.z, p.b.z) - p.r, z1: Math.max(p.a.z, p.b.z) + p.r };
}

/** Polynomial smooth minimum: a fillet of size k where two shapes meet. */
function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** The rectangle the field must cover: every pavement shape and stroke, with the shoulders' margin. */
export function fieldRect(plan: AirfieldPlan): Rect {
  const r: Rect = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const f of plan.features)
    for (const p of f.parts) {
      const b = partBox(p);
      r.x0 = Math.min(r.x0, b.x0);
      r.x1 = Math.max(r.x1, b.x1);
      r.z0 = Math.min(r.z0, b.z0);
      r.z1 = Math.max(r.z1, b.z1);
    }
  const m = PAVE_MAX + 6;
  return { x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 - m, z1: r.z1 + m };
}

export function rasterise(plan: AirfieldPlan, w: number, h: number): PaveField {
  const rect = fieldRect(plan);
  const dx = (rect.x1 - rect.x0) / w;
  const dz = (rect.z1 - rect.z0) / h;
  const n = w * h;
  // the texels within m of a rectangle
  const range = (b: Rect, m: number) => ({
    i0: Math.max(0, Math.floor((b.x0 - m - rect.x0) / dx - 0.5)),
    i1: Math.min(w - 1, Math.ceil((b.x1 + m - rect.x0) / dx - 0.5)),
    j0: Math.max(0, Math.floor((b.z0 - m - rect.z0) / dz - 0.5)),
    j1: Math.min(h - 1, Math.ceil((b.z1 + m - rect.z0) / dz - 0.5)),
  });

  // ---- pavement: a smooth union of every feature (each feature a plain union of its parts)
  const pave = new Float32Array(n).fill(PAVE_RANGE.hi);
  for (const f of plan.features) {
    const bb: Rect = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    const boxes = f.parts.map(partBox);
    for (const b of boxes) {
      bb.x0 = Math.min(bb.x0, b.x0);
      bb.x1 = Math.max(bb.x1, b.x1);
      bb.z0 = Math.min(bb.z0, b.z0);
      bb.z1 = Math.max(bb.z1, b.z1);
    }
    const m = PAVE_RANGE.hi + f.k;
    const g = range(bb, m);
    for (let j = g.j0; j <= g.j1; j++) {
      const z = rect.z0 + (j + 0.5) * dz;
      for (let i = g.i0; i <= g.i1; i++) {
        const x = rect.x0 + (i + 0.5) * dx;
        let d = Infinity;
        for (let k = 0; k < f.parts.length; k++) {
          const b = boxes[k];
          // skip parts too far away to matter here
          if (x < b.x0 - m || x > b.x1 + m || z < b.z0 - m || z > b.z1 + m) continue;
          d = Math.min(d, partDist(f.parts[k], x, z));
        }
        if (d > m) continue;
        const idx = j * w + i;
        pave[idx] = smin(pave[idx], d, f.k);
      }
    }
  }

  const data = new Uint8Array(n);
  const k = 255 / (PAVE_RANGE.hi - PAVE_RANGE.lo);
  for (let i = 0; i < n; i++) data[i] = Math.max(0, Math.min(255, Math.round((pave[i] - PAVE_RANGE.lo) * k)));
  return { w, h, rect, dx, dz, data };
}

/** The pavement's signed distance at a point (bilinear, like the GPU reads it); far outside, a large value. */
export function paveAt(f: PaveField, x: number, z: number) {
  const u = (x - f.rect.x0) / f.dx - 0.5;
  const v = (z - f.rect.z0) / f.dz - 0.5;
  if (u < 0 || v < 0 || u > f.w - 1 || v > f.h - 1) return PAVE_RANGE.hi;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const i1 = Math.min(f.w - 1, i + 1);
  const j1 = Math.min(f.h - 1, j + 1);
  const at = (ii: number, jj: number) => f.data[jj * f.w + ii];
  const top = at(i, j) + (at(i1, j) - at(i, j)) * fu;
  const bot = at(i, j1) + (at(i1, j1) - at(i, j1)) * fu;
  return PAVE_RANGE.lo + ((top + (bot - top) * fv) / 255) * (PAVE_RANGE.hi - PAVE_RANGE.lo);
}

/**
 * What the pavement is at a point: the runway (with its shoulders and blast pads), the apron, a
 * taxiway, or null off the pavement (grass or sand, which the caller decides).
 */
export function surfaceOf(plan: AirfieldPlan, f: PaveField, x: number, z: number): 'runway' | 'taxiway' | 'apron' | null {
  const rw = plan.runway;
  const r = plan.ap.geo.runway;
  if (Math.abs(x - rw.cx) <= rw.halfLen + rw.blast && Math.abs(z - rw.cz) <= rw.halfW + r.shoulder) return 'runway';
  if (paveAt(f, x, z) > r.shoulder) return null;
  const a = plan.apron;
  if (x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1) return 'apron';
  return 'taxiway';
}

/** The field at `texel` metres per texel (capped at 4096 texels a side). */
export function buildField(plan: AirfieldPlan, texel: number) {
  const r = fieldRect(plan);
  return rasterise(plan, Math.min(4096, Math.ceil((r.x1 - r.x0) / texel)), Math.min(4096, Math.ceil((r.z1 - r.z0) / texel)));
}
