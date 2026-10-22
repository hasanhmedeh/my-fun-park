// Draws the retarget contact sheet (see index.html for the query). Rows are clips; each avatar gets
// one column per moment, the first avatar seen from front-left and the next from front-right, so
// arms crossing the body show from one side or the other. Under each cell: how far the lowest foot
// joint sits from its standing height (red past 3 cm into the floor).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const q = new URLSearchParams(location.search);
const list = (k, d) => (q.get(k) ?? d).split(',').filter(Boolean);
const packUrl = q.get('pack') ?? '/models/people/clips-extra.glb';
const avatarUrls = list('avatars', '/.people-cache/work/retarget/avatars/male01.glb,/.people-cache/work/retarget/avatars/female01.glb');
const phases = list('t', '0.1,0.45,0.8').map(Number);
const [W, H] = (q.get('cell') ?? '220x300').split('x').map(Number);
const angles = list('angles', '40,-40').map(Number);
// a first column group with the source clip on Quaternius' own mannequin, for comparison
const withSource = q.get('source') !== '0';
const SOURCES = { ual1: '/.people-cache/sources/ual1/AnimationLibrary_Godot_Standard.glb', ual2: '/.people-cache/sources/ual2/UAL2_Standard.glb' };

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const wp = (o) => o.getWorldPosition(new THREE.Vector3());

try {
  const pack = await loader.loadAsync(packUrl);
  const refHip = pack.scene.getObjectByName('Bip01').position.y;
  const wanted = list('clips', pack.animations.map((c) => c.name).join(','));
  const clips = wanted.map((n) => {
    const c = pack.animations.find((a) => a.name === n);
    if (!c) throw new Error(`pack has no clip ${n}`);
    return c;
  });

  const people = [];
  for (const url of avatarUrls) {
    const g = await loader.loadAsync(url);
    const root = g.scene;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      for (const m of [].concat(o.material)) {
        // FBX2glTF's Phong guess is metallic; hair cards are cut out, not blended
        m.metalness = 0;
        m.roughness = 0.82;
        if (/opacity/i.test(m.name)) Object.assign(m, { transparent: false, alphaTest: 0.4, side: THREE.DoubleSide, depthWrite: true });
      }
    });
    root.updateMatrixWorld(true);
    const bip = root.getObjectByName('Bip01');
    const hip = bip.position.y;
    const feet = ['Bip01_L_Foot', 'Bip01_R_Foot', 'Bip01_L_Toe0', 'Bip01_R_Toe0'].map((n) => root.getObjectByName(n));
    const rest = feet.map((f) => wp(f).y);
    const mixer = new THREE.AnimationMixer(root);
    // the runtime scales the hip track by this body's hip height over the pack's
    const actions = new Map(
      clips.map((c) => {
        const k = c.clone();
        for (const t of k.tracks) if (t.name === 'Bip01.position') t.values = t.values.map((v) => v * (hip / refHip));
        return [c.name, mixer.clipAction(k)];
      }),
    );
    people.push({ name: url.split('/').pop().replace(/\.glb$/, ''), root, mixer, actions, feet, rest });
  }
  if (withSource) {
    const origins = await (await fetch('/.people-cache/work/retarget/origins.json')).json();
    const libs = {};
    for (const [key, url] of Object.entries(SOURCES)) {
      if (!clips.some((c) => origins[c.name]?.src === key)) continue;
      const g = await loader.loadAsync(url);
      g.scene.traverse((o) => o.isMesh && ((o.castShadow = true), (o.frustumCulled = false)));
      g.scene.updateMatrixWorld(true);
      // UAL1's Godot file has Rigify names (GLTFLoader drops their dots), UAL2 the UE ones
      const feet = ['foot_l', 'foot_r', 'ball_l', 'ball_r', 'DEF-footL', 'DEF-footR', 'DEF-toeL', 'DEF-toeR'].map((n) => g.scene.getObjectByName(n)).filter(Boolean);
      libs[key] = { root: g.scene, mixer: new THREE.AnimationMixer(g.scene), clips: g.animations, feet, rest: feet.map((f) => wp(f).y) };
    }
    people.unshift({ name: 'source', origins, libs, source: true });
  }

  const cols = people.length * phases.length;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(cols * W, clips.length * H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9dde2);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8475, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
  sun.position.set(1.5, 5, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5 });
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(2.4, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc9c3b8, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(4.8, 24, 0x8a8478, 0xa9a397);
  grid.position.y = 0.001;
  scene.add(grid);
  const roots = people.flatMap((p) => (p.source ? Object.values(p.libs).map((l) => l.root) : [p.root]));
  for (const r of roots) {
    r.visible = false;
    scene.add(r);
  }

  if (withSource) angles.unshift(angles[0]);
  const cams = angles.map((deg) => {
    const a = THREE.MathUtils.degToRad(deg);
    // zoom=<height>,<distance>,<fov> looks closer, e.g. at the hands and face: zoom=1.45,1.4,30
    const [zy, zd, fov] = (q.get('zoom') ?? '0.8,5.2,28').split(',').map(Number);
    const cam = new THREE.PerspectiveCamera(fov, W / H, 0.05, 50);
    cam.position.set(Math.sin(a) * zd, zy + 0.55 * (zd / 5.2), Math.cos(a) * zd);
    cam.lookAt(0, zy, 0);
    return cam;
  });

  renderer.setScissorTest(true);
  const labels = document.getElementById('labels');
  const label = (cls, text, x, y) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    Object.assign(d.style, { left: `${x}px`, top: `${y}px` });
    labels.appendChild(d);
    return d;
  };
  clips.forEach((clip, ri) => {
    label('row', `${clip.name}  ${clip.duration.toFixed(2)} s`, 4, ri * H + 4);
    people.forEach((p, pi) => {
      // what to pose: the avatar with the baked clip, or the source mannequin with the original
      let root, mixer, action, at, feet, rest;
      if (p.source) {
        const o = p.origins[clip.name];
        const lib = o && p.libs[o.src];
        const src = lib?.clips.find((c) => c.name === o.clip);
        if (!src) return;
        ({ root, mixer, feet, rest } = lib);
        action = mixer.clipAction(src);
        at = (ph) => (o.hold ?? (o.from ?? 0) + ph * clip.duration);
      } else {
        ({ root, mixer, feet, rest } = p);
        action = p.actions.get(clip.name);
        at = (ph) => ph * clip.duration;
      }
      action.play();
      phases.forEach((ph, fi) => {
        for (const r of roots) r.visible = r === root;
        action.time = at(ph);
        mixer.update(0);
        root.updateMatrixWorld(true);
        const ci = pi * phases.length + fi;
        const y = (clips.length - 1 - ri) * H; // the viewport's origin is bottom-left
        renderer.setViewport(ci * W, y, W, H);
        renderer.setScissor(ci * W, y, W, H);
        let cam = cams[pi % cams.length];
        if (q.has('focus') && !p.source) {
          // focus=Bip01_R_Hand,0.5: look at one bone from that far, along the column's angle
          const [bone, dist] = q.get('focus').split(',');
          const at = wp(root.getObjectByName(bone));
          cam = cam.clone();
          cam.position.copy(at).add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(-Number(dist)));
          cam.lookAt(at);
        }
        renderer.render(scene, cam);
        const low = Math.min(...feet.map((f, j) => wp(f).y - rest[j]));
        const d = label('cell', `${p.name} t=${at(ph).toFixed(2)}  feet ${(low * 100).toFixed(1)} cm`, ci * W + 6, ri * H + H - 16);
        if (low < -0.03) d.classList.add('bad');
      });
      action.stop();
    });
  });
  document.title = 'READY';
} catch (e) {
  console.error(e);
  document.title = `ERROR ${e?.message ?? e}`;
}
