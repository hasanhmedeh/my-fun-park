// The people pipeline's contact sheet: each avatar of the manifest posed in a few clips, in a grid,
// with the floor and (for seated clips) a seat at the avatar's seatDrop, as the game would use them.
// Served by the dev server, screenshotted by scripts/shot.mjs:
//
//   node scripts/shot.mjs "http://localhost:5199/scripts/people/view/sheet.html?set=starter" sheet.png --size 1600x1500
//
// Query: ids=A,B or set=<manifest set>|starter|all; variant=crowd|hero; rows=Clip@seconds:view:lod,…
// (view front|side|three|head|crown|waist|feet; lod 0–2); cell=WxH; src=<url> loads that GLB for the (one)
// avatar instead, e.g. src=/.people-cache/work/Male_Adult_01/base.glb (the uncompressed source);
// anchors=1 marks the avatar's anchors (red head top, green back, blue shoulder, yellow palms) on
// their bones, as the game would attach things. It plays nothing: each cell is frozen at its time, so
// the sheet is reproducible. On the console (shot.mjs prints warnings): per avatar, the lowest
// skinned vertex in every cell (feet on the floor: about 0; seated: the seat's height or more), its
// texture memory on the GPU, and anything that failed to load.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const STARTER = ['Male_Adult_01', 'Male_Adult_08', 'Female_Adult_01', 'Female_Adult_04', 'Male_Adult_05', 'Business_Female_02', 'Male_Child_01', 'Female_Child_01'];
const q = new URLSearchParams(location.search);
const ROWS = (q.get('rows') ?? 'Idle_Loop@1.5:front:0,Walk_Loop@0.35:three:0,Sitting_Idle_Loop@2:side:0,Idle_Loop@1.5:three:1,Idle_Loop@1.5:three:2').split(',').map((r) => {
  const [clip, rest = ''] = r.split('@');
  const [t = '0', view = 'front', lod = '0'] = rest.split(':');
  return { clip, t: Number(t), view, lod: Number(lod) };
});
const VARIANT = q.get('variant') ?? 'crowd';
const [CW, CH] = (q.get('cell') ?? '200x290').split('x').map(Number);
const BASE = '/models/people/';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.setScissorTest(true);
document.getElementById('wrap').prepend(renderer.domElement);

const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

/** The pack's clips, cut out of its one 'clips' timeline (ClipInfo.start) or taken by name. */
async function loadPack(pack) {
  const gltf = await loader.loadAsync(BASE + pack.file);
  const clips = new Map();
  for (const info of pack.clips) {
    let clip;
    if (info.start !== undefined) {
      const all = gltf.animations.find((a) => a.name === 'clips');
      const tracks = all.tracks.map((t) => t.clone().trim(info.start - 0.01, info.start + info.duration + 0.01).shift(-info.start));
      clip = new THREE.AnimationClip(info.name, info.duration, tracks);
    } else clip = gltf.animations.find((a) => a.name === info.name);
    if (clip) clips.set(info.name, clip);
  }
  return { pack, clips };
}

/** A clip for this body: the root's position track scaled by its hip height over the pack's. */
function fitClip(clip, avatar, pack) {
  const k = avatar.hip / pack.refHip;
  const c = clip.clone();
  for (const t of c.tracks) if (t.name === `${pack.rootName}.position`) t.values = t.values.map((v) => v * k);
  return c;
}

/** GPU bytes of a loaded scene's textures (compressed mip chains as they are; others RGBA8 plus a third). */
function textureBytes(root) {
  const seen = new Set();
  let bytes = 0;
  root.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats)
      for (const v of Object.values(m)) {
        if (!v?.isTexture || seen.has(v)) continue;
        seen.add(v);
        if (v.isCompressedTexture) bytes += v.mipmaps.reduce((s, mm) => s + mm.data.byteLength, 0);
        else if (v.image?.width) bytes += v.image.width * v.image.height * 4 * (4 / 3);
      }
  });
  return Math.round(bytes);
}

const VIEWS = {
  front: (h) => [new THREE.Vector3(0, h * 0.55, h * 2.1), new THREE.Vector3(0, h * 0.5, 0)],
  three: (h) => [new THREE.Vector3(h * 1.5, h * 0.6, h * 1.5), new THREE.Vector3(0, h * 0.5, 0)],
  side: (h) => [new THREE.Vector3(h * 2.1, h * 0.45, -0.25), new THREE.Vector3(0, h * 0.4, -0.25)],
  // head and shoulders, for the texture quality close up
  head: (h) => [new THREE.Vector3(0.25, h * 0.92, h * 0.42), new THREE.Vector3(0, h * 0.9, 0)],
  // hips and hands, for how the fingers hold a bag, a cup or a trolley
  waist: (h) => [new THREE.Vector3(h * 0.35, h * 0.6, h * 0.75), new THREE.Vector3(0, h * 0.5, 0)],
  // the head from above and behind, as the game's camera sees the crowd
  crown: (h) => [new THREE.Vector3(h * 0.2, h * 1.3, -h * 0.35), new THREE.Vector3(0, h * 0.9, 0)],
  // at floor level, close to the feet: do they stand on it, sink, float?
  feet: () => [new THREE.Vector3(1.1, 0.06, 0.2), new THREE.Vector3(0, 0.12, -0.05)],
};

function cellScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9dde3);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8070, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(1.5, 4, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  Object.assign(sun.shadow.camera, { left: -1.5, right: 1.5, top: 2.5, bottom: -1, near: 0.1, far: 10 });
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(6, 24, 0x777777, 0x999999);
  grid.position.y = 0.001;
  scene.add(grid);
  return scene;
}

async function main() {
  const manifest = await (await fetch(BASE + 'manifest.json')).json();
  const set = q.get('set');
  const ids = q.get('ids')?.split(',') ?? (set === 'starter' ? STARTER : set === 'all' || !set ? manifest.avatars.map((a) => a.id) : manifest.sets[set]);
  const avatars = ids.map((id) => manifest.avatars.find((a) => a.id === id)).filter(Boolean);
  const packs = {};
  for (const [key, p] of Object.entries(manifest.clipPacks)) packs[key] = await loadPack({ ...p, rootName: manifest.rigs[p.rig]?.root ?? 'Bip01' });

  const W = CW * avatars.length;
  const H = CH * ROWS.length;
  renderer.setSize(W, H);
  const labels = document.getElementById('labels');
  labels.style.width = `${W}px`;
  const cells = [];
  const report = [];

  for (const [col, avatar] of avatars.entries()) {
    let gltf;
    try {
      gltf = await loader.loadAsync(q.get('src') ?? BASE + (avatar.files[VARIANT] ?? avatar.files.crowd));
    } catch (e) {
      console.error(`${avatar.id}: ${e.message}`);
      continue;
    }
    const pack = packs[avatar.gender];
    const lows = [];
    for (const [row, r] of ROWS.entries()) {
      const scene = cellScene();
      const model = cloneSkinned(gltf.scene);
      scene.add(model);
      // a LOD node is a Group of SkinnedMeshes (one per material) or, with one material, the mesh itself
      model.traverse((o) => {
        if (/^LOD\d$/.test(o.name)) o.visible = o.name === `LOD${r.lod}`;
      });
      const meshes = [];
      model.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        o.castShadow = true;
        // debug=unlit: textures only, no lighting (tells shading problems from texture ones)
        if (q.get('debug') === 'unlit') o.material = new THREE.MeshBasicMaterial({ map: o.material.map, alphaTest: o.material.alphaTest, side: o.material.side });
        if (q.get('debug') === 'normals') o.material = new THREE.MeshNormalMaterial({ side: o.material.side });
        o.frustumCulled = false;
        let shown = true;
        for (let p = o; p; p = p.parent) shown &&= p.visible;
        if (shown) meshes.push(o);
      });
      if (q.get('anchors')) {
        const COLOURS = { headTop: 0xff2020, back: 0x20c020, shoulderL: 0x2060ff, palmL: 0xffd000, palmR: 0xffd000 };
        for (const [name, a] of Object.entries(avatar.anchors)) {
          const bone = model.getObjectByName(manifest.rigs[avatar.rig].bones[a.bone]);
          if (!bone) continue;
          // drawn on top, so a mark inside the body still shows
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8), new THREE.MeshBasicMaterial({ color: COLOURS[name], depthTest: false }));
          dot.renderOrder = 10;
          dot.position.fromArray(a.at);
          bone.add(dot);
        }
      }
      const clip = pack?.clips.get(r.clip);
      if (clip) {
        const mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(fitClip(clip, avatar, pack.pack)).play();
        mixer.update(r.t);
      } else console.warn(`${avatar.id}: no clip ${r.clip}`);
      model.updateMatrixWorld(true);
      let low = Infinity;
      for (const m of meshes) {
        m.computeBoundingBox();
        low = Math.min(low, m.boundingBox.min.y);
      }
      lows.push(`${r.clip}@${r.t}/LOD${r.lod} ${low.toFixed(3)}`);
      if (/^Sitting_Idle/.test(r.clip)) {
        // the seat the game would use: its top seatDrop above the rig's origin, under the hips
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, avatar.seatDrop, 0.45), new THREE.MeshStandardMaterial({ color: 0x6d5a45 }));
        const hip = model.getObjectByName(pack.pack.rootName);
        seat.position.set(0, avatar.seatDrop / 2, hip ? hip.getWorldPosition(new THREE.Vector3()).z : -0.4);
        seat.receiveShadow = true;
        scene.add(seat);
      }
      const camera = new THREE.PerspectiveCamera(30, CW / CH, 0.05, 30);
      // (the head and crown views frame the real head; the others keep a toddler from filling the cell)
      const [eye, at] = VIEWS[r.view](r.view === 'head' || r.view === 'crown' ? avatar.height : Math.max(avatar.height, 1.2));
      camera.position.copy(eye);
      camera.lookAt(at);
      cells.push({ scene, camera, x: col * CW, y: row * CH });
    }
    const gpu = textureBytes(gltf.scene);
    report.push(`${avatar.id} ${VARIANT}: gpu textures ${(gpu / 1024).toFixed(0)} KB | lowest vertex: ${lows.join(', ')}`);
    const label = document.createElement('div');
    label.textContent = `${avatar.id} · ${avatar.height.toFixed(2)} m · skin ${avatar.skin}`;
    label.style.cssText = `position:absolute;left:${col * CW}px;top:0;width:${CW}px`;
    labels.appendChild(label);
  }
  for (const [row, r] of ROWS.entries()) {
    const label = document.createElement('div');
    label.textContent = `${r.clip} ${r.t}s · LOD${r.lod}`;
    label.className = 'row';
    label.style.cssText = `position:absolute;left:0;top:${row * CH + CH - 18}px`;
    labels.appendChild(label);
  }

  for (const c of cells) {
    renderer.setViewport(c.x, H - c.y - CH, CW, CH);
    renderer.setScissor(c.x, H - c.y - CH, CW, CH);
    renderer.render(c.scene, c.camera);
  }
  for (const line of report) console.warn(line);
  console.warn(`renderer: ${renderer.info.memory.textures} textures, ${renderer.info.memory.geometries} geometries, ${renderer.info.render.triangles} triangles in the last cell`);
  document.title = 'READY';
}

main().catch((e) => {
  console.error(e);
  document.title = `ERROR ${e.message}`;
});
