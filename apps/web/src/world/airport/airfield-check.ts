// Logic checks for the airfield's plan (airfield-plan.ts) and its pavement field (airfield-field.ts),
// run in node by scripts/airfield-check.mjs: the pavement covers every taxi path the aircraft
// follows (with room for its wheels), the grass lies where it should, the lights and signs add up,
// and follow-the-greens lights a route up to its red stop bar and no further.

import { AIRFIELDS, taxiRoute, type Airport } from '../../aviation/airports';
import { A320 } from '../../aviation/a320';
import type { Region } from '../geo';
import { buildField, paveAt, surfaceOf } from './airfield-field';
import { guidanceLights, planAirfield } from './airfield-plan';

export interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
}

function checkAirport(id: Region, rows: CheckRow[]) {
  const ap: Airport = AIRFIELDS[id];
  const t0 = performance.now();
  const plan = planAirfield(ap);
  const t1 = performance.now();
  const field = buildField(plan, 1);
  const t2 = performance.now();
  const row = (name: string, ok: boolean, detail: string) => rows.push({ name: `${ap.geo.icao} ${name}`, ok, detail });

  row('plan + field build time', t2 - t0 < 2500, `plan ${(t1 - t0).toFixed(0)} ms, field ${field.w}×${field.h} in ${(t2 - t1).toFixed(0)} ms`);

  // every taxi path on pavement, with the main gear (track 7.6 m) well inside it
  let worst = -Infinity;
  let worstAt = '';
  const gearHalf = A320.track / 2;
  for (const e of ap.edges) {
    if (e.name === 'RWY') continue;
    const a = ap.nodes[e.a];
    const b = ap.nodes[e.b];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / L;
    const uz = (b.z - a.z) / L;
    for (let s = 0; s <= L; s += 4) {
      for (const side of [-1, 0, 1]) {
        const x = a.x + ux * s - uz * side * (gearHalf + 1);
        const z = a.z + uz * s + ux * side * (gearHalf + 1);
        const d = paveAt(field, x, z);
        if (d > worst) {
          worst = d;
          worstAt = `${e.name} ${e.a}→${e.b} at ${s.toFixed(0)} m`;
        }
      }
    }
  }
  row('taxi paths on pavement', worst < -0.5, `worst edge distance ${worst.toFixed(2)} m (${worstAt})`);

  // the wingtips of a parked aircraft stay on the apron's concrete
  const span = A320.span / 2;
  const standsOk = ap.stands.every((s) => [-span, 0, span].every((dx) => surfaceOf(plan, field, s.x + dx, s.z) === 'apron'));
  row('stands on the apron', standsOk, `${ap.stands.length} stands, wingtips at ±${span.toFixed(1)} m`);

  // surfaces: runway at both thresholds, taxiway on A, grass in the strip between them
  const rw = ap.geo.runway;
  const midZ = (rw.z + ap.geo.taxiwayZ) / 2;
  const samples: [string, number, number, string | null][] = [
    ['09 threshold', rw.x0 + 5, rw.z, 'runway'],
    ['27 threshold', rw.x1 - 5, rw.z, 'runway'],
    ['taxiway A', 500, ap.geo.taxiwayZ, 'taxiway'],
    ['strip grass', 1200, midZ, null],
    ['beyond the blast pad', rw.x1 + 200, rw.z, null],
    ['apron', ap.stands[1].x, ap.stands[1].z, 'apron'],
    // the strip between the apron's edge and taxiway A is paved over
    ['apron–taxiway infill', 0, ap.geo.taxiwayZ > ap.geo.apron.z1 ? ap.geo.apron.z1 + 6 : ap.geo.apron.z0 - 6, 'taxiway'],
  ];
  const bad = samples.filter(([, x, z, want]) => surfaceOf(plan, field, x, z) !== want);
  row('surfaceAt samples', bad.length === 0, bad.length ? `wrong: ${bad.map((b) => `${b[0]}=${surfaceOf(plan, field, b[1], b[2])}`).join(', ')}` : samples.map((s) => s[0]).join(', '));

  // the lights add up and stay cheap
  const by = new Map<string, number>();
  for (const l of plan.lights) by.set(l.group, (by.get(l.group) ?? 0) + 1);
  const total = plan.lights.length;
  row('light count', total > 800 && total < 8000, [...by].map(([g, n]) => `${g} ${n}`).join(', ') + ` = ${total}`);
  const papi = plan.lights.filter((l) => l.group === 'papi').length;
  row('PAPI units', papi === 16, `${papi} lamps (4 units × 2 lamps × 2 runways)`);
  row('holds', plan.holds.length === 4, plan.holds.map((h) => `${h.name} ${h.designation}`).join(', '));
  row('signs', plan.signs.length > 20, `${plan.signs.length} signs, ${plan.decals.length} pavement decals`);

  // follow the greens from the player's stand to the far runway entry: lit right up to the stop bar
  const entry = ap.runways['27'].entries[ap.runways['27'].entries.length - 1];
  const route = taxiRoute(ap, ap.playerStand, entry.runway);
  if (!route) {
    row('guidance route', false, 'no route');
    return;
  }
  const lit = guidanceLights(plan, route.nodes, 0, 1e6, () => true);
  const hold = ap.nodes[entry.hold];
  const litLights = [...lit].map((i) => plan.lights[i]);
  const beyond = litLights.filter((l) => Math.abs(l.z - ap.geo.runway.z) < Math.abs(hold.z - ap.geo.runway.z) - 1);
  // the lit lights should run the whole route: no gap longer than a curve's spacing allows
  let maxGap = 0;
  const pts = litLights.map((l) => ({ x: l.x, z: l.z }));
  for (const p of pts) {
    let nearest = Infinity;
    for (const q of pts) if (q !== p) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.z - q.z));
    maxGap = Math.max(maxGap, nearest);
  }
  const expect = route.lengthM / 15;
  row('guidance lights the route', lit.size > expect * 0.8 && maxGap < 20, `${lit.size} lights over ${route.lengthM.toFixed(0)} m (via ${route.via.join(' ')}), widest gap ${maxGap.toFixed(1)} m`);
  row('guidance stops at the red bar', beyond.length === 0, `${beyond.length} lit lights past ${entry.hold}`);
  const free = guidanceLights(plan, route.nodes, 0, 1e6, () => false);
  row('green bar: lead-on lit', free.size >= lit.size + 8, `${free.size - lit.size} more lights onto the runway`);
  const near = guidanceLights(plan, route.nodes, 1, 300, () => true);
  row('guidance ahead window', near.size > 8 && near.size < lit.size, `${near.size} lights within 300 m ahead`);
}

export function runAirfieldChecks(): CheckRow[] {
  const rows: CheckRow[] = [];
  checkAirport('home', rows);
  checkAirport('island', rows);
  return rows;
}
