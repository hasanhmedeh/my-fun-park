// Funfair International's terminal (world/airport/terminal.ts) with its forecourt (landside.ts) and the SkyLink,
// on a stand-in apron until the airfield is in: grass, the apron's concrete with the stands' lead-in
// lines, and plain white A320-sized fuselages at the stands whose bridges are docked.
//
//   ?scene=terminal&cam=-30,1.7,505&look=-30,1.7,560          gate 3's lounge, looking out at the stand
//   ?scene=terminal&cam=150,1.7,442&look=150,1.7,470          check-in at eye height
//   ?scene=terminal&cam=40,1.7,482&look=40,1.7,500            security
//   ?scene=terminal&cam=0,60,640&look=0,10,520                the airside facade from the apron
//   ?scene=terminal&cam=22,8,330&look=22,8,440                the forecourt
//   ?scene=terminal&dock=S3,S5                                 dock these stands' bridges (default: all but S3)
//   ?scene=terminal&stats=1                                    print each module's meshes and triangles (console)
import * as THREE from 'three';
import type { PreviewApi, PreviewScene } from '../main';
import { AIRFIELDS } from '../../aviation/airports';
import { A320_POINTS } from '../../aviation/a320';
import { AIRPORTS } from '../../world/geo';
import { HomeTerminal } from '../../world/airport/terminal';
import { Landside } from '../../world/airport/landside';
import { SkyLink } from '../../world/airport/skylink';

/** The stand-in ground round the airport, the sky carried with the camera, the hills hidden. */
export function homeStage(p: PreviewApi) {
  const { scene, camera } = p.ctx;
  const sky = scene.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);
  // the park's horizon hills stand where the airport is: out of the way for the preview
  for (const o of scene.children) {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && (m as THREE.MeshLambertMaterial).isMeshLambertMaterial && m.side === THREE.DoubleSide) o.visible = false;
  }
  p.onFrame(() => sky?.position.copy(camera.position));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 3000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#5d8a45', roughness: 1 }));
  ground.position.set(0, -0.03, 700);
  ground.receiveShadow = true;
  scene.add(ground);
  const ap = AIRPORTS.home;
  const pave = new THREE.MeshStandardMaterial({ color: '#a4a49e', roughness: 0.9 });
  const slab = (xa: number, xb: number, za: number, zb: number, m = pave) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(xb - xa, zb - za).rotateX(-Math.PI / 2), m);
    s.position.set((xa + xb) / 2, 0.0, (za + zb) / 2);
    s.receiveShadow = true;
    scene.add(s);
  };
  slab(ap.apron.x0, ap.apron.x1, 541, ap.apron.z1);
  slab(-1700, 1700, ap.taxiwayZ - 12, ap.taxiwayZ + 12);
  const yellow = new THREE.MeshBasicMaterial({ color: '#e8c02a', polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const s of AIRFIELDS.home.stands) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 650 - s.noseStop.z).rotateX(-Math.PI / 2), yellow);
    line.position.set(s.x, 0.02, (650 + s.noseStop.z) / 2);
    scene.add(line);
  }
}

/** A plain fuselage, wing and fin at a stand: enough to see the bridge meet door L1. */
export function standIn(scene: THREE.Scene, x: number, z: number, heading: number) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#f2f3f5', roughness: 0.4 });
  const P = A320_POINTS;
  const len = P.tailTip.z - P.noseTip.z;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.97, len - 4, 8, 20).rotateX(Math.PI / 2), white);
  body.position.set(0, P.fuselageY, (P.tailTip.z + P.noseTip.z) / 2);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(34, 0.3, 4.5), white);
  wing.position.set(0, 2.6, 1.5);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6, 4), white);
  fin.position.set(0, 8.5, 16);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.85, 0.81), new THREE.MeshStandardMaterial({ color: '#2a2e33' }));
  door.position.set(P.doorL1.x - 0.02, P.doorL1.y + 0.92, P.doorL1.z);
  g.add(body, wing, fin, door);
  g.position.set(x, 0, z);
  g.rotation.y = (-heading * Math.PI) / 180;
  g.traverse((o) => (o.castShadow = o.receiveShadow = true));
  scene.add(g);
}

/** Draw calls (meshes) and triangles in a group, for the budgets. */
export function groupStats(g: THREE.Object3D) {
  let calls = 0;
  let tris = 0;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry;
    const n = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    calls++;
    tris += n * inst;
  });
  return `${calls} meshes, ${Math.round(tris / 1000)}k tris`;
}

const preview: PreviewScene = (p) => {
  homeStage(p);
  const term = new HomeTerminal(p.ctx);
  const land = new Landside(p.ctx);
  const link = new SkyLink(p.ctx);
  p.ctx.scene.add(term.group, land.group, link.group);
  const dock = (p.params.get('dock') ?? 'S1,S2,S4,S5,S6').split(',').filter(Boolean);
  for (const s of AIRFIELDS.home.stands) {
    if (!dock.includes(s.id)) continue;
    standIn(p.ctx.scene, s.x, s.z, s.heading);
    term.bridges[s.id].dock(true);
  }
  p.onFrame((dt, t) => {
    const n = p.env?.night ?? 0;
    term.setNight(n);
    land.setNight(n);
    link.setNight(n);
    term.update(dt, t, p.ctx.camera);
    land.update(dt, t, p.ctx.camera);
    link.update(dt, t, p.ctx.camera);
  });
  if (p.params.get('stats')) console.warn(`terminal ${groupStats(term.group)} | landside ${groupStats(land.group)} | skylink ${groupStats(link.group)}`);
  p.view({ x: -30, y: 1.7, z: 505 }, { x: -30, y: 1.7, z: 560 });
};
export default preview;
