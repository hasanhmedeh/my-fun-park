// Palm Cay's terminal (world/island/island-terminal.ts) beside its beach park, on the island
// scene's stand-in landmass. The stairs at the stands listed in `dock` (default S2) are docked
// to where the aircraft's front door would be; `dock=none` leaves them all parked.
//
//   ?scene=island-terminal&cam=-30,1.7,40625&look=-30,1.7,40590         gate 2's lounge, looking at the apron
//   ?scene=island-terminal&cam=-90,1.7,40668&look=-90,1.7,40640         the check-in hall
//   ?scene=island-terminal&cam=40,1.7,40665&look=70,1.2,40645           the baggage hall
//   ?scene=island-terminal&cam=-10,4,40590&look=-28,3,40579             S2's airstairs docked
//   ?scene=island-terminal&cam=0,90,40420&look=0,0,40640                the terminal from over the apron
import * as THREE from 'three';
import type { PreviewScene } from '../main';
import { IslandTerminal } from '../../world/island/island-terminal';
import { PalmCay } from '../../world/island/island';
import { stage } from './island';

/** Draw calls and triangles of a group's visible meshes (what the budget counts). */
function stats(o: THREE.Object3D) {
  let calls = 0;
  let tris = 0;
  o.traverseVisible((m) => {
    const mesh = m as THREE.Mesh;
    const points = (m as unknown as THREE.Points).isPoints === true;
    if (!mesh.isMesh && !points) return;
    const g = mesh.geometry;
    const n = g.index ? g.index.count : g.attributes.position.count;
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    if (inst === 0) return;
    calls++;
    tris += (points ? n : n / 3) * inst;
  });
  return `${calls} calls, ${Math.round(tris / 1000)}k tris`;
}

/** Each visible mesh's name (or type) and triangles, for finding what a budget is spent on. */
function detail(o: THREE.Object3D) {
  const out: string[] = [];
  o.traverseVisible((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    if (inst) out.push(`${mesh.name || mesh.type}${inst > 1 ? `×${inst}` : ''} ${Math.round((n * inst) / 1000)}k`);
  });
  return out.join(', ');
}

const preview: PreviewScene = (p) => {
  const terminal = new IslandTerminal(p.ctx);
  const park = new PalmCay(p.ctx);
  p.ctx.scene.add(terminal.group, park.group);
  stage(p, (k) => {
    terminal.setNight(k);
    park.setNight(k);
  });
  const dock = (p.params.get('dock') ?? 'S2').split(',');
  for (const id of dock) terminal.stairs[id]?.dock(true);
  let logged = 0;
  p.onFrame((dt, t) => {
    terminal.update(dt, t);
    park.update(dt, t, p.ctx.camera);
    // after the LODs have settled, report what the two groups cost from this viewpoint
    if (++logged === 30) {
      console.warn(`[stats] ${p.ctx.quality.tier}: terminal ${stats(terminal.group)} · park ${stats(park.group)}`);
      if (p.params.has('detail')) for (const [name, g] of [['terminal', terminal.group], ['park', park.group]] as const) console.warn(`[detail] ${name}: ${detail(g)}`);
    }
  });
  p.view({ x: -30, y: 1.7, z: 40625 }, { x: -30, y: 1.7, z: 40590 });
};
export default preview;
