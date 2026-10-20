// The A320neo model (world/airport/a320-model.ts) on the airport's grass south of the terminal,
// posed from the URL so every moving part and light can be checked from any angle.
//
//   ?scene=a320&cam=-28,6,770&look=0,3,800                       front three-quarter, left
//   ?scene=a320&gear=0.5&flaps=40&slats=27&spoil=1&cam=..         surfaces and gear mid-way
//   ?scene=a320&lights=all&hour=23                                night lighting
//   ?scene=a320&fleet=1&cam=0,60,900&look=0,0,800                 every livery, at the parked detail
//
// Pose parameters: livery, detail (hero|ai|parked), gear 0..1, flaps / slats (deg), spoil 0..1
// (or spoilL/spoilR), rev 0..1, ail / elev / rud −1..1, steer (deg), comp (m), l1 / l2 / cargo
// 0..1, n1 0..1, lights (all | none | comma list of nav,beacon,strobe,landing,taxi,logo,cabin),
// y (height of the reference point), pitch / bank / hdg (deg), cockpit=1, t (clock, s),
// vis (m: the flying visibility the environment's fog is set to, e.g. 35000).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { PreviewScene } from '../main';
import type { PlaneModel, PlaneVisual } from '../../aviation/types';
import { LIVERIES, createA320, restVisual } from '../../world/airport/a320-model';
import type { LiveryId } from '../../world/airport/liveries';

const DEG = Math.PI / 180;

const scene: PreviewScene = async (p) => {
  // the titles are in the fair's display font, which the preview page doesn't load by itself
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&family=Lilita+One&display=swap';
  document.head.appendChild(link);
  await Promise.race([Promise.all([document.fonts.load('64px "Lilita One"'), document.fonts.load('700 32px "DM Sans"')]), new Promise((r) => setTimeout(r, 4000))]);

  const q = p.params;
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const { scene: sc, camera } = p.ctx;
  const origin = new THREE.Vector3(num('x', 0), num('y', 0), num('z', 800));

  if (!p.env) {
    // a neutral studio for reflections, so the paint and metal read as they will in the world
    const pm = new THREE.PMREMGenerator(p.ctx.renderer);
    sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    sc.environmentIntensity = 0.6;
    const g = new THREE.Mesh(new THREE.CircleGeometry(400, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#6f8f55', roughness: 0.95 }));
    g.position.set(origin.x, 0, origin.z);
    sc.add(g);
  } else {
    // the park's sky box is centred on the fair: carry it with the camera out here
    const sky = sc.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);
    p.onFrame(() => sky?.position.copy(camera.position));
  }
  // a strip of apron concrete under the aircraft (the airfield's pavement isn't in this scene)
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(90, 70).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#a7a69f', roughness: 0.9 }));
  apron.position.set(origin.x, 0.02, origin.z);
  apron.receiveShadow = true;
  sc.add(apron);

  const lightsOf = (s: string | null): PlaneVisual['lights'] => {
    const all = s === 'all';
    const set = new Set((s ?? '').split(','));
    const on = (k: string) => all || set.has(k);
    return { nav: on('nav'), beacon: on('beacon'), strobe: on('strobe'), landing: on('landing'), taxi: on('taxi'), logo: on('logo'), cabin: on('cabin') };
  };
  const visual = (): PlaneVisual => {
    const v = restVisual();
    v.gear = num('gear', 1);
    v.flapsDeg = num('flaps', 0);
    v.slatsDeg = num('slats', v.flapsDeg > 0 ? Math.min(27, 18 + v.flapsDeg * 0.25) : 0);
    v.spoilerL = num('spoilL', num('spoil', 0));
    v.spoilerR = num('spoilR', num('spoil', 0));
    v.reverser = num('rev', 0);
    v.aileron = num('ail', 0);
    v.elevator = num('elev', 0);
    v.rudder = num('rud', 0);
    v.nosewheel = num('steer', 0);
    const c = num('comp', 0.2);
    v.compression = [c, c, c];
    v.doorL1 = num('l1', 0);
    v.doorL2 = num('l2', 0);
    v.cargo = num('cargo', 0);
    const n1 = num('n1', 0.22);
    v.n1 = [n1, n1];
    v.wheelSpin = num('spin', 0);
    v.lights = lightsOf(q.get('lights'));
    return v;
  };

  const planes: PlaneModel[] = [];
  const place = (m: PlaneModel, x: number, z: number, hdg: number) => {
    m.group.position.set(x, origin.y, z);
    m.group.rotation.set(num('pitch', 0) * DEG, -hdg * DEG, -num('bank', 0) * DEG, 'YXZ');
    sc.add(m.group);
    planes.push(m);
  };
  if (q.get('fleet') === '1') {
    const ids = Object.keys(LIVERIES) as LiveryId[];
    ids.forEach((id, i) => place(createA320({ livery: LIVERIES[id], detail: (q.get('detail') as 'parked') ?? 'parked', shadows: true }), origin.x - 112 + i * 45, origin.z, 0));
  } else {
    const id = (q.get('livery') ?? 'funfair') as LiveryId;
    const detail = (q.get('detail') ?? 'hero') as 'hero' | 'ai' | 'parked';
    place(createA320({ livery: LIVERIES[id], detail, shadows: true }), origin.x, origin.z, num('hdg', 90));
  }
  if (q.get('cockpit') === '1') planes[0].setCockpitView(true);

  const v = visual();
  const t0 = num('t', 0);
  p.onFrame((dt, t) => {
    const night = p.env?.night ?? (q.has('night') ? num('night', 0) : 0);
    for (const m of planes) {
      m.setNight(night);
      m.setVisual(v, dt, t0 + t);
    }
  });
  if (q.has('vis')) p.env?.setVisibility(num('vis', 35000));
  p.view({ x: origin.x - 30, y: 7, z: origin.z - 26 }, { x: origin.x, y: 3, z: origin.z });
};
export default scene;
