// Logic checks for Palm Cay (world/island): the walk areas stay on dry ground, every spot the
// people use is somewhere walkable, nothing of the park stands in the games' plots, and the
// airstairs dock to the door and back. They need the DOM (the island paints its textures on
// canvases), so they run in the preview page; each result is a console warning that
// scripts/shot.mjs prints:
//
//   node scripts/shot.mjs "?scene=island-check&env=0&frames=2" out.png
//
// The last line reads "[island-check] all N checks passed" or "[island-check] N failed".
import type { PreviewScene } from '../main';
import { AIRFIELDS } from '../../aviation/airports';
import { A320_POINTS } from '../../aviation/a320';
import { islandShoreDist } from '../../world/geo';
import { Airstairs } from '../../world/island/airstairs';
import { IslandTerminal } from '../../world/island/island-terminal';
import { PalmCay } from '../../world/island/island';
import type { V2, WalkRect } from '../../world/island/kit';
import * as THREE from 'three';

/** The games' plots, as the spec gives them (wave 2 builds in them). */
const PLOTS: (WalkRect & { name: string })[] = [
  { name: 'slides', x0: -275, x1: -185, z0: 41090, z1: 41210 },
  { name: 'cannons', x0: -440, x1: -320, z0: 41340, z1: 41460 },
  { name: 'volley', x0: 175, x1: 245, z0: 41370, z1: 41430 },
  { name: 'jet-ski dock', x0: 30, x1: 90, z0: 41440, z1: 41600 },
];

const inside = (r: WalkRect, p: V2, pad = 0) => p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.z >= r.z0 - pad && p.z <= r.z1 + pad;

const preview: PreviewScene = (p) => {
  const rows: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });

  const park = new PalmCay(p.ctx);
  const term = new IslandTerminal(p.ctx);
  p.ctx.scene.add(park.group, term.group);

  // ---- walk areas on dry ground (shore distance ≥ 22 m) and at least 1 m across
  let wet = 0;
  let worst = Infinity;
  // (the pier's two narrow rects stand over the water on purpose: its deck is at y = 0)
  for (const r of park.walk.filter((w) => w.x1 - w.x0 > 10))
    for (let x = r.x0; x <= r.x1; x += 2)
      for (let z = r.z0; z <= r.z1; z += 2) {
        const d = islandShoreDist(x, z);
        worst = Math.min(worst, d);
        if (d < 21.5) wet++;
      }
  check('park walk on dry ground', wet === 0, `${park.walk.length} rects, nearest the water ${worst.toFixed(1)} m (${wet} wet samples)`);
  const thin = [...park.walk, ...term.walk].filter((r) => r.x1 - r.x0 < 1 || r.z1 - r.z0 < 1);
  check('walk rects at least 1 m across', thin.length === 0, `${thin.length} too thin`);

  // ---- the people's spots are walkable
  const all = [...park.walk, ...term.walk, ...term.apronWalk];
  const offWalk = (pts: readonly V2[]) => pts.filter((q) => !all.some((r) => inside(r, q, 0.3)));
  const s = park.spots;
  for (const [name, pts] of [
    ['plaza', [s.plaza]],
    ['promenade', s.promenade],
    ['benches', s.benches],
    ['beach', s.beach],
    ['bar', s.bar],
    ['wander', s.wander],
  ] as const) {
    const off = offWalk(pts);
    check(`park spots: ${name}`, pts.length > 0 && off.length === 0, `${pts.length} spots, ${off.length} off the walk areas${off[0] ? ` (first ${off[0].x.toFixed(1)}, ${off[0].z.toFixed(1)})` : ''}`);
  }
  const ts = term.spots;
  for (const [name, pts] of [
    ['gate desk', [ts.gateDesk]],
    ['boarding path', ts.boardingPath],
    ['arrivals path', ts.arrivalsPath],
    ['lounge seats', ts.seats],
  ] as const) {
    const off = offWalk(pts);
    check(`terminal spots: ${name}`, pts.length > 0 && off.length === 0, `${pts.length} spots, ${off.length} off the walk areas${off[0] ? ` (first ${off[0].x.toFixed(1)}, ${off[0].z.toFixed(1)})` : ''}`);
  }
  const s2 = AIRFIELDS.island.stands.find((st) => st.id === 'S2')!;
  const foot = term.stairs.S2.path[0];
  const lastBoard = ts.boardingPath[ts.boardingPath.length - 1];
  check('boarding path ends at S2 stairs foot', Math.hypot(lastBoard.x - foot.x, lastBoard.z - foot.z) < 1, `${Math.hypot(lastBoard.x - foot.x, lastBoard.z - foot.z).toFixed(2)} m apart`);
  const firstArr = ts.arrivalsPath[0];
  check('arrivals path starts at S2 stairs foot', Math.hypot(firstArr.x - foot.x, firstArr.z - foot.z) < 1, `${Math.hypot(firstArr.x - foot.x, firstArr.z - foot.z).toFixed(2)} m apart`);
  const lastArr = ts.arrivalsPath[ts.arrivalsPath.length - 1];
  check('arrivals path ends on the arrivals plaza', lastArr.z > 40672 && park.walk.some((r) => inside(r, lastArr)), `ends at ${lastArr.x.toFixed(1)}, ${lastArr.z.toFixed(1)}`);
  const firstBoard = ts.boardingPath[0];
  check('boarding path starts at the gate desk', Math.hypot(firstBoard.x - ts.gateDesk.x, firstBoard.z - ts.gateDesk.z) < 25, `${Math.hypot(firstBoard.x - ts.gateDesk.x, firstBoard.z - ts.gateDesk.z).toFixed(1)} m from the desk`);

  // ---- nothing of the park's above the ground in the games' plots
  park.group.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const hits: Record<string, number> = {};
  park.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.y < 0.3) continue;
      for (const r of PLOTS) if (inside(r, { x: v.x, z: v.z })) hits[r.name] = (hits[r.name] ?? 0) + 1;
    }
  });
  const trunks = (park as unknown as { palms: { trunks: { x: number; z: number }[] } }).palms.trunks;
  for (const t of trunks) for (const r of PLOTS) if (inside(r, t, 2)) hits[r.name] = (hits[r.name] ?? 0) + 1;
  for (const r of PLOTS) check(`plot clear: ${r.name}`, !hits[r.name], `${hits[r.name] ?? 0} vertices or palms inside`);

  // ---- airstairs: the path's top is the door, the dock takes its time and comes back
  const door = { x: s2.doorL1.x, y: A320_POINTS.doorL1.y, z: s2.doorL1.z };
  const st = new Airstairs(p.ctx, door, s2.heading);
  const top = st.path[st.path.length - 1];
  check('stairs path ends at the door sill', Math.hypot(top.x - door.x, top.y - door.y, top.z - door.z) < 0.05, `top ${top.x.toFixed(2)}, ${top.y.toFixed(2)}, ${top.z.toFixed(2)}`);
  check('stairs foot on the apron, clear of the fuselage', st.path[0].y === 0 && Math.hypot(st.path[0].x - door.x, st.path[0].z - door.z) > 4, `foot ${Math.hypot(st.path[0].x - door.x, st.path[0].z - door.z).toFixed(1)} m out from the door`);
  st.dock();
  let tDock = 0;
  while (st.k < 1 && tDock < 120) {
    st.update(0.1);
    tDock += 0.1;
  }
  check('stairs dock in 10–40 s', st.k === 1 && tDock >= 10 && tDock <= 40, `docked after ${tDock.toFixed(1)} s`);
  st.retract();
  for (let i = 0; i < 1200 && st.k > 0; i++) st.update(0.1);
  check('stairs retract', st.k === 0, `k = ${st.k}`);
  check('every stand has stairs', AIRFIELDS.island.stands.every((x) => term.stairs[x.id] instanceof Airstairs), Object.keys(term.stairs).join(', '));

  for (const r of rows) console.warn(`[island-check] ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  const failed = rows.filter((r) => !r.ok).length;
  console.warn(failed ? `[island-check] ${failed} failed` : `[island-check] all ${rows.length} checks passed`);
  p.view({ x: 0, y: 200, z: 40500 }, { x: 0, y: 0, z: 41000 });
};
export default preview;
