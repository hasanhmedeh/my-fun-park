// The captain's Navigation Display: heading up, in ARC (the 90° sector ahead, the usual mode in the
// air) or ROSE NAV (the whole compass, on the ground). It draws the flight plan in green with the
// active fix in white, the aircraft's track and selected heading, the wind, ground and true air
// speed, the next fix's bearing, distance and time, the range rings, the TCAS traffic with relative
// altitudes, both airports' runways with the arrival's extended centreline once the ILS is tuned,
// and — as an aid the real one shows as terrain — the coastlines of the mainland and Palm Cay.
//
// The range follows the phase (5 NM on the ground, 20 en route, 10 on the approach); a click on
// the display steps through the ranges (and back to automatic), see Cockpit.

import { AIRPORTS, KT, NM, homeCoastZ, islandK, ISLAND } from '../../../world/geo';
import { C, Display, angleDiff, clamp, ilsShown, lateralManaged, line, pad, poly, text } from './display';
import type { CockpitData } from './types';

const D2R = Math.PI / 180;

/** The ranges the display steps through (NM). */
export const ND_RANGES = [5, 10, 20, 40] as const;
type NdMode = 'arc' | 'rose';

/** Where the aircraft symbol sits and the compass radius, by mode. */
const GEO: Record<NdMode, { cx: number; cy: number; r: number }> = {
  arc: { cx: 500, cy: 850, r: 680 },
  rose: { cx: 500, cy: 520, r: 345 },
};

/** The coastlines in world metres, sampled once: the mainland's south coast and Palm Cay's shore. */
const COASTS: Float32Array[] = (() => {
  const home: number[] = [];
  for (let x = -60000; x <= 60000; x += 500) home.push(x, homeCoastZ(x));
  const island: number[] = [];
  // islandK is linear in distance along a ray from the centre (its wobble depends only on the angle), so the shore is r = 1 / k(unit)
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const k = islandK(ISLAND.centre.x + ux * 1000, ISLAND.centre.z + uz * 1000) / 1000;
    island.push(ISLAND.centre.x + ux / k, ISLAND.centre.z + uz / k);
  }
  return [new Float32Array(home), new Float32Array(island)];
})();

/** Both runways' corners (world metres), for drawing them to scale. */
const RUNWAYS = Object.values(AIRPORTS).map((ap) => {
  const r = ap.runway;
  return { x0: r.x0, x1: r.x1, z: r.z, w: r.width };
});

export class Nd {
  readonly display: Display;
  /** Chosen by the visitor: a range (NM) and mode, or null for automatic. */
  rangeOverride: number | null = null;
  modeOverride: NdMode | null = null;
  // scratch for the transform (no allocation per point)
  private cx = 0;
  private cy = 0;
  private k = 0;
  private px = 0;
  private pz = 0;
  private fx = 0;
  private fz = 0;
  private sx = 0;
  private sy = 0;

  constructor(className: string, hz = 10) {
    this.display = new Display(className, hz);
  }

  /** A click on the display: the next range, then back to automatic after the largest. */
  cycleRange() {
    const i = this.rangeOverride === null ? -1 : ND_RANGES.indexOf(this.rangeOverride as (typeof ND_RANGES)[number]);
    this.rangeOverride = i + 1 < ND_RANGES.length ? ND_RANGES[i + 1] : null;
    this.display.invalidate();
  }

  toggleMode(current: NdMode) {
    this.modeOverride = current === 'arc' ? 'rose' : 'arc';
    this.display.invalidate();
  }

  /** The mode in use for this state. */
  mode(d: CockpitData): NdMode {
    return this.modeOverride ?? (d.s.onGround && d.s.gs < 60 ? 'rose' : 'arc');
  }

  range(d: CockpitData): number {
    if (this.rangeOverride !== null) return this.rangeOverride;
    switch (d.phase) {
      case 'climb':
      case 'cruise':
      case 'descent':
        return 20;
      case 'approach':
      case 'final':
      case 'landing':
        return 10;
      case 'takeoff':
        return d.s.onGround ? 5 : 10;
      default:
        return 5;
    }
  }

  update(dt: number, d: CockpitData) {
    if (!this.display.due(dt) || !this.display.begin()) return;
    const g = this.display.g;
    const { s } = d;
    const mode = this.mode(d);
    const range = this.range(d);
    const geo = GEO[mode];
    this.cx = geo.cx;
    this.cy = geo.cy;
    this.k = geo.r / (range * NM);
    this.px = s.pos.x;
    this.pz = s.pos.z;
    this.fx = Math.sin(s.heading * D2R);
    this.fz = -Math.cos(s.heading * D2R);

    // the map, clipped to the compass
    g.save();
    g.beginPath();
    if (mode === 'arc') {
      g.arc(geo.cx, geo.cy, geo.r, Math.PI, 0);
      g.lineTo(1000, 1000);
      g.lineTo(0, 1000);
    } else g.arc(geo.cx, geo.cy, geo.r, 0, Math.PI * 2);
    g.clip();
    this.coasts(g);
    this.runways(g, d, range);
    this.route(g, d);
    this.traffic(g, d);
    g.restore();

    this.compass(g, d, mode, range);
    this.aircraft(g);
    this.corners(g, d, mode);
  }

  dispose() {
    this.display.dispose();
  }

  // ---------------------------------------------------------------------------------------------- transform

  /** World (x, z) to display units, into sx/sy. */
  private toScreen(x: number, z: number) {
    const dx = x - this.px;
    const dz = z - this.pz;
    const along = dx * this.fx + dz * this.fz;
    const right = dx * -this.fz + dz * this.fx;
    this.sx = this.cx + right * this.k;
    this.sy = this.cy - along * this.k;
  }

  // ---------------------------------------------------------------------------------------------- map

  private coasts(g: CanvasRenderingContext2D) {
    g.strokeStyle = '#4f6f86';
    g.lineWidth = 3;
    for (const c of COASTS) {
      g.beginPath();
      for (let i = 0; i < c.length; i += 2) {
        this.toScreen(c[i], c[i + 1]);
        if (i === 0) g.moveTo(this.sx, this.sy);
        else g.lineTo(this.sx, this.sy);
      }
      g.stroke();
    }
  }

  private runways(g: CanvasRenderingContext2D, d: CockpitData, range: number) {
    for (const r of RUNWAYS) {
      const hw = Math.max(r.w / 2, 3 / this.k);
      const pts: number[] = [];
      for (const [x, z] of [
        [r.x0, r.z - hw],
        [r.x1, r.z - hw],
        [r.x1, r.z + hw],
        [r.x0, r.z + hw],
      ]) {
        this.toScreen(x, z);
        pts.push(this.sx, this.sy);
      }
      poly(g, pts, null, C.white, 3);
    }
    // the arrival runway's extended centreline, once its ILS is tuned
    const ils = ilsShown(d);
    if (ils) {
      const rw = d.nav.arrivalRunway;
      const thr = rw.threshold;
      const back = Math.sin(rw.heading * D2R);
      const len = Math.min(range, 14) * NM;
      g.setLineDash([18, 14]);
      this.toScreen(thr.x, thr.z);
      const x0 = this.sx;
      const y0 = this.sy;
      this.toScreen(thr.x - back * len, thr.z);
      line(g, x0, y0, this.sx, this.sy, C.white, 3);
      g.setLineDash([]);
    }
  }

  private route(g: CanvasRenderingContext2D, d: CockpitData) {
    const nav = d.nav;
    const legs = nav.legs;
    if (nav.activeIndex >= legs.length) return;
    g.strokeStyle = C.green;
    g.lineWidth = 4;
    g.beginPath();
    this.toScreen(nav.legStart.x, nav.legStart.z);
    g.moveTo(this.sx, this.sy);
    for (let i = nav.activeIndex; i < legs.length; i++) {
      this.toScreen(legs[i].x, legs[i].z);
      g.lineTo(this.sx, this.sy);
    }
    g.stroke();
    // the fixes: green diamonds, the active one white, with their names (the runway as its threshold)
    for (let i = nav.activeIndex; i < legs.length; i++) {
      const f = legs[i];
      this.toScreen(f.x, f.z);
      const colour = i === nav.activeIndex ? C.white : C.green;
      const x = this.sx;
      const y = this.sy;
      if (f.name.startsWith('RW')) {
        line(g, x - 14, y, x + 14, y, colour, 4);
      } else poly(g, [x, y - 13, x + 13, y, x, y + 13, x - 13, y], null, colour, 4);
      text(g, f.name, x + 22, y - 22, colour, 30, 'left');
      if (f.altFt !== undefined && !f.name.startsWith('RW')) text(g, String(f.altFt), x + 22, y + 10, C.magenta, 26, 'left');
    }
  }

  private traffic(g: CanvasRenderingContext2D, d: CockpitData) {
    const s = d.s;
    for (const c of d.traffic) {
      const rel = (c.altFt - s.altFt) / 100;
      if (Math.abs(rel) > 27) continue;
      const dist = Math.hypot(c.x - s.pos.x, c.z - s.pos.z) / NM;
      this.toScreen(c.x, c.z);
      const x = this.sx;
      const y = this.sy;
      // resolution advisory (red square), traffic advisory (amber circle), proximate (filled white diamond), other (hollow)
      const ra = !s.onGround && dist < 1.5 && Math.abs(rel) < 6;
      const ta = !s.onGround && dist < 3 && Math.abs(rel) < 9;
      const near = dist < 6 && Math.abs(rel) < 12;
      const colour = ra ? C.red : ta ? C.amber : C.white;
      if (ra) {
        g.fillStyle = colour;
        g.fillRect(x - 12, y - 12, 24, 24);
      } else if (ta) {
        g.fillStyle = colour;
        g.beginPath();
        g.arc(x, y, 13, 0, Math.PI * 2);
        g.fill();
      } else poly(g, [x, y - 15, x + 12, y, x, y + 15, x - 12, y], near ? colour : null, colour, 3);
      const r = Math.round(rel);
      const label = `${r >= 0 ? '+' : '-'}${pad(Math.abs(r), 2)}`;
      text(g, label, x, r >= 0 ? y - 32 : y + 32, colour, 26);
      if (Math.abs(c.vs) > 500) {
        const up = c.vs > 0;
        line(g, x + 24, y + 12, x + 24, y - 12, colour, 3);
        poly(g, up ? [x + 18, y - 6, x + 30, y - 6, x + 24, y - 16] : [x + 18, y + 6, x + 30, y + 6, x + 24, y + 16], colour);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- compass

  private compass(g: CanvasRenderingContext2D, d: CockpitData, mode: NdMode, range: number) {
    const { s, fcu } = d;
    const { cx, cy, r } = GEO[mode];
    const h = s.heading;
    const at = (bearing: number, rad: number) => {
      const a = angleDiff(bearing, h) * D2R;
      return [cx + Math.sin(a) * rad, cy - Math.cos(a) * rad] as const;
    };
    g.strokeStyle = C.white;
    g.lineWidth = 4;
    g.beginPath();
    if (mode === 'arc') g.arc(cx, cy, r, (-90 - 52) * D2R, (-90 + 52) * D2R);
    else g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    // the inner range rings, dashed, with their range in cyan
    g.setLineDash([14, 16]);
    g.lineWidth = 3;
    for (const f of mode === 'arc' ? [0.25, 0.5, 0.75] : [0.5]) {
      g.beginPath();
      if (mode === 'arc') g.arc(cx, cy, r * f, (-90 - 52) * D2R, (-90 + 52) * D2R);
      else g.arc(cx, cy, r * f, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash([]);
    const [lx, ly] = at(h - 46, r * 0.5);
    text(g, String(range / 2), lx - 24, ly, C.cyan, 28, 'right');
    if (mode === 'arc') {
      const [l2x, l2y] = at(h - 46, r);
      text(g, String(range), l2x - 24, l2y + 18, C.cyan, 28, 'right');
    }
    // graduations every 5°, numbers every 10° (in tens)
    const span = mode === 'arc' ? 52 : 180;
    for (let k = Math.ceil((h - span) / 5) * 5; k <= h + span; k += 5) {
      const deg = ((k % 360) + 360) % 360;
      if (mode === 'rose' && k === Math.ceil((h + span) / 5) * 5 && Math.abs(angleDiff(deg, h)) > 179) continue;
      const ten = deg % 10 === 0;
      const [x0, y0] = at(deg, r);
      const [x1, y1] = at(deg, r + (ten ? 24 : 13));
      line(g, x0, y0, x1, y1, C.white, 4);
      if (ten) {
        const [tx, ty] = at(deg, r + 50);
        text(g, String(deg / 10), tx, ty, C.white, deg % 30 === 0 ? 38 : 30);
      }
    }
    // the ILS course pointer
    const ils = ilsShown(d);
    if (ils) {
      const [x0, y0] = at(ils.course, r - 34);
      const [x1, y1] = at(ils.course, r + 8);
      line(g, x0, y0, x1, y1, C.magenta, 6);
      if (mode === 'rose') {
        const [x2, y2] = at(ils.course + 180, r - 34);
        const [x3, y3] = at(ils.course + 180, r + 8);
        line(g, x2, y2, x3, y3, C.magenta, 6);
      }
    }
    // the track, a green diamond on the scale
    if (!s.onGround || s.gs > 5) {
      const off = angleDiff(s.track, h);
      if (Math.abs(off) < span) {
        const a = off * D2R;
        const ux = Math.sin(a);
        const uy = -Math.cos(a);
        const bx = cx + ux * (r - 4);
        const by = cy + uy * (r - 4);
        const nx = -uy;
        const ny = ux;
        poly(g, [bx, by, bx - ux * 14 + nx * 11, by - uy * 14 + ny * 11, bx - ux * 28, by - uy * 28, bx - ux * 14 - nx * 11, by - uy * 14 - ny * 11], null, C.green, 4);
      }
    }
    // the selected heading, a cyan triangle outside the scale
    if (!lateralManaged(fcu.fma)) {
      const off = angleDiff(fcu.hdg, h);
      if (Math.abs(off) < span) {
        const a = off * D2R;
        const ux = Math.sin(a);
        const uy = -Math.cos(a);
        const nx = -uy;
        const ny = ux;
        const bx = cx + ux * (r + 4);
        const by = cy + uy * (r + 4);
        poly(g, [bx, by, bx + ux * 28 + nx * 15, by + uy * 28 + ny * 15, bx + ux * 28 - nx * 15, by + uy * 28 - ny * 15], null, C.cyan, 5);
      } else if (mode === 'arc') text(g, `${pad(fcu.hdg, 3)}`, off > 0 ? 930 : 70, cy - r * 0.62, C.cyan, 32);
    }
    // the yellow lubber line at the top
    line(g, cx, cy - r - 30, cx, cy - r + 22, C.yellow, 6);
  }

  private aircraft(g: CanvasRenderingContext2D) {
    const x = this.cx;
    const y = this.cy;
    g.strokeStyle = C.yellow;
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(x, y - 30);
    g.lineTo(x, y + 44);
    g.moveTo(x - 40, y - 4);
    g.lineTo(x + 40, y - 4);
    g.moveTo(x - 16, y + 36);
    g.lineTo(x + 16, y + 36);
    g.stroke();
  }

  // ---------------------------------------------------------------------------------------------- the corners

  private corners(g: CanvasRenderingContext2D, d: CockpitData, mode: NdMode) {
    const { s, nav } = d;
    // ground and true air speed, and the wind (the inertial ground vector minus the air vector)
    text(g, 'GS', 24, 36, C.white, 32, 'left');
    text(g, String(Math.round(s.gs)), 84, 36, C.green, 36, 'left');
    text(g, 'TAS', 200, 36, C.white, 32, 'left');
    text(g, s.tas > 60 ? String(Math.round(s.tas)) : '---', 278, 36, C.green, 36, 'left');
    const hr = s.heading * D2R;
    const tasMs = s.tas * KT;
    const wx = s.vel.x - Math.sin(hr) * tasMs;
    const wz = s.vel.z + Math.cos(hr) * tasMs;
    const wKt = Math.hypot(wx, wz) / KT;
    // the air data computes the wind above 100 kt of true air speed
    if (s.tas > 100 && wKt >= 2) {
      // the wind blows towards (wx, wz): it comes from the opposite bearing
      const toward = (Math.atan2(wx, -wz) / D2R + 360) % 360;
      const from = (toward + 180) % 360;
      text(g, `${pad(from, 3)}°/${Math.round(wKt)}`, 24, 80, C.green, 34, 'left');
      // the arrow points the way the wind blows, relative to the nose
      const a = angleDiff(toward, s.heading) * D2R;
      const ax = 64;
      const ay = 150;
      const ux = Math.sin(a);
      const uy = -Math.cos(a);
      line(g, ax - ux * 34, ay - uy * 34, ax + ux * 34, ay + uy * 34, C.green, 5);
      line(g, ax + ux * 34, ay + uy * 34, ax + ux * 14 - uy * 14, ay + uy * 14 + ux * 14, C.green, 5);
      line(g, ax + ux * 34, ay + uy * 34, ax + ux * 14 + uy * 14, ay + uy * 14 - ux * 14, C.green, 5);
    } else text(g, '---°/---', 24, 80, C.green, 34, 'left');

    // the active fix: name, bearing, distance and the time there
    const fix = nav.activeFix;
    if (fix) {
      const dx = fix.x - s.pos.x;
      const dz = fix.z - s.pos.z;
      const brg = (Math.atan2(dx, -dz) / D2R + 360) % 360;
      const nm = Math.hypot(dx, dz) / NM;
      text(g, fix.name, 760, 36, C.white, 34, 'right');
      text(g, `${pad(brg, 3)}°`, 976, 36, C.green, 34, 'right');
      text(g, nm < 20 ? nm.toFixed(1) : String(Math.round(nm)), 900, 80, C.green, 36, 'right');
      text(g, 'NM', 976, 80, C.cyan, 30, 'right');
      const gsMs = Math.max(s.gs * KT, 30);
      text(g, clockPlus(d.utc, nm * NM / gsMs), 976, 122, C.green, 34, 'right');
    }
    // the tuned ILS
    const ils = ilsShown(d);
    if (ils) {
      text(g, ils.ident, 24, 900, C.magenta, 32, 'left');
      text(g, `${ils.freq}  CRS${pad(ils.course, 3)}°`, 24, 940, C.magenta, 30, 'left');
    }
    if (mode === 'rose' && !ils) text(g, 'GPS PRIMARY', 500, 966, C.white, 28);
    if (d.timeWarp > 1) text(g, `TIME ×${d.timeWarp}`, 976, 950, C.amber, 32, 'right');
  }
}

/** "HH:MM" of a clock string plus some seconds (the ND's ETA). */
function clockPlus(utc: string, seconds: number) {
  const [h, m] = utc.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '--:--';
  const total = Math.round(h * 60 + m + clamp(seconds, 0, 86400) / 60);
  return `${pad(Math.floor(total / 60) % 24, 2)}:${pad(total % 60, 2)}`;
}

