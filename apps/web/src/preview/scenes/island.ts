// Palm Cay's beach park (world/island/island.ts) on the geography's island and sea, beside the
// airfield builder's runway and apron (field=0: grey slabs for the pavement instead). With env=0 a
// stand-in landmass takes their place: sand and grass by shore distance, a flat turquoise sea at
// SEA_Y. `stage` is shared with the island-terminal scene; see flight-view.ts for far, vis, wind.
//
//   ?scene=island&cam=0,1.7,40760&look=0,1.7,40900          the promenade at eye height
//   ?scene=island&cam=0,300,40100&look=0,0,41100             from the air on approach
import * as THREE from 'three';
import type { PreviewApi, PreviewScene } from '../main';
import { AIRPORTS, ISLAND, SEA_Y, islandShoreDist } from '../../world/geo';
import { PalmCay } from '../../world/island/island';
import { geography } from './flight-view';
import { Airfield } from '../../world/airport/airfield';
import { AIRFIELDS } from '../../aviation/airports';

/** The stand-in island, the sky following the camera, and the time of day forwarded to `setNight`. */
export function stage(p: PreviewApi, setNight: (k: number) => void) {
  const { scene, camera } = p.ctx;
  // the park's sky box is only 900 m across, centred on the fair: carry it with the camera
  const sky = scene.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);
  p.onFrame(() => {
    sky?.position.copy(camera.position);
    setNight(p.env?.night ?? 0);
  });

  // with the real environment the geography's island, shore and sea are there: use them
  if (p.env?.terrain) {
    geography(p);
    // and the airfield builder's runway, taxiways and apron (field=0 for grey slabs instead)
    if (p.params.get('field') === '0') apron(p);
    else {
      const field = new Airfield(p.ctx, AIRFIELDS.island);
      scene.add(field.group);
      p.onFrame((dt, t) => {
        field.setLights(p.env?.night ?? 0);
        field.update(dt, t, camera);
      });
    }
    return;
  }
  const x0 = -3000;
  const x1 = 3000;
  const z0 = 39700;
  const z1 = 41900;
  const step = 6;
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz).rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const col: number[] = [];
  const sand = new THREE.Color('#e8d6ac');
  const wet = new THREE.Color('#bfa77a');
  const grass = new THREE.Color('#5f8f3c');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i) + (z0 + z1) / 2;
    const d = islandShoreDist(x, z);
    const y = d >= 25 ? 0 : d >= 0 ? SEA_Y * (1 - d / 25) : SEA_Y + d * 0.06;
    pos.setY(i, y);
    const beach = z > ISLAND.beachZ - 10 && Math.abs(x) < 900 ? 1 : THREE.MathUtils.smoothstep(60 - d, 0, 30);
    c.copy(grass).lerp(sand, beach);
    if (d < 6) c.lerp(wet, THREE.MathUtils.clamp(1 - d / 6, 0, 1));
    const n = Math.sin(x * 0.37) * Math.cos(z * 0.29) * 0.05;
    col.push(c.r * (1 + n), c.g * (1 + n), c.b * (1 + n));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const land = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  land.position.set(0, 0, (z0 + z1) / 2);
  land.receiveShadow = true;
  scene.add(land);

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 20000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#2aa6b8', roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.88 }),
  );
  sea.position.set(0, SEA_Y, 40800);
  scene.add(sea);

  apron(p);
}

/** The airport's pavement (the airfield builder's), so the terminal has its apron. */
function apron(p: PreviewApi) {
  const { scene } = p.ctx;
  const ap = AIRPORTS.island;
  const pave = new THREE.MeshStandardMaterial({ color: '#8d8f8c', roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const slab = (xa: number, xb: number, za: number, zb: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(xb - xa, zb - za).rotateX(-Math.PI / 2), pave);
    m.position.set((xa + xb) / 2, 0.02, (za + zb) / 2);
    m.receiveShadow = true;
    scene.add(m);
  };
  slab(ap.apron.x0, ap.apron.x1, ap.apron.z0, ap.apron.z1);
  slab(ap.runway.x0, ap.runway.x1, ap.runway.z - 30, ap.runway.z + 30);
  slab(-1350, 1350, ap.taxiwayZ - 12, ap.taxiwayZ + 12);
  slab(-12, 12, ap.taxiwayZ, ap.apron.z0);
}

const preview: PreviewScene = (p) => {
  const park = new PalmCay(p.ctx);
  p.ctx.scene.add(park.group);
  stage(p, (k) => park.setNight(k));
  p.onFrame((dt, t) => park.update(dt, t, p.ctx.camera));
  p.view({ x: 0, y: 1.7, z: 40760 }, { x: 0, y: 1.7, z: 40900 });
};
export default preview;
