// Bakes CC0 Quaternius clips onto the Rocketbox Biped skeleton, for the moves Rocketbox's own
// library lacks (jumps, the roll, swimming, riding a jet-ski, eating, folded arms, leaning on a
// rail, carrying, being knocked back, a thumbs-up…). It runs offline so the game never retargets at
// runtime: three's retarget() calls skeleton.pose(), which misplaces Biped's Bip01 root (it isn't
// a joint) and leaves scale on the bones of meshopt-quantized avatars.
//
//   node scripts/people/retarget.mjs [--target avatar.glb] [--out public/models/people/clips-extra.glb]
//                                    [--only Jump_Start,Roll] [--try ual1:Walk_Loop] [--fps 30]
//                                    [--compare other-avatar.glb]
//
// --target   a converted Rocketbox adult male in metres (FBX2glTF output with spaced names, or the
//            pipeline's own GLBs with GLTFLoader's Bip01_L_Thigh names). The default is the
//            pipeline's public/models/people/Male_Adult_01.hero.glb, else the skeleton the last
//            run saved to .people-cache/work/retarget/rig-target.glb.
// --compare  bakes again on a second rig (e.g. a woman) and prints how far that bake's hands and
//            feet land from the shared pack's, to decide whether one pack suits both.
// --only     bakes just those clips, --try source clips that aren't in the list (for trying things;
//            write those to another --out, as the meta sidecar is named after it).
//
// Writes the pack (skeleton nodes and animations only: no mesh, no textures, meshopt-compressed
// with 16-bit quaternions) and .people-cache/meta/clippack-extra.json in the manifest's ClipPack
// shape, for build-manifest to merge, and .people-cache/work/retarget/origins.json (which source
// clip each came from, for the contact sheet). Prints a table per clip: its share of the pack's
// bytes, keys, how far the feet sink or float, ground speed for locomotion. The contact sheets
// that check the result come from retarget-check.mjs.
//
// Track names are GLTFLoader's (`Bip01_L_Thigh.quaternion`, `Bip01.position`), so the clips bind
// to any Rocketbox avatar the pipeline builds. Bip01's position is the hip height for this rig
// (refHip in the sidecar): the runtime scales it by avatar.hip / refHip for other bodies.
//
// How the bake works (proven on Walk_Loop in the research spike):
//  1. Map the UE-mannequin bones to Biped bones by name (fingers too; face bones keep their rest).
//  2. Pose the source's T-pose into the target's A-pose, parent first, swinging each limb onto the
//     target bone's direction (hands and pelvis by a full frame, so palms and hips twist right too).
//  3. Per bone, offset = (aligned source world rotation)⁻¹ × (target rest world rotation).
//  4. Each frame: target world rotation = source world rotation × offset, turned back into local
//     rotations parent first. Bip01 carries the pelvis turn (as Rocketbox's own clips do) and the
//     hip height: the hip joints follow the source's, scaled by leg length; X/Z travel is removed.
//  5. Near the floor, Bip01 is nudged up or down so the lowest foot joint stands as high as the
//     source's does (the two rigs' shins and feet differ by a few centimetres).
//  6. Loops are closed and lose any drift; `blend` and `reach` (see CLIPS) finish a few by hand.
//
// Sources (CC0 1.0, by Quaternius). itch.io downloads need a click, so the script expects them in
// .people-cache/sources/ already:
//   ual1/AnimationLibrary_Godot_Standard.glb  "Universal Animation Library [Standard]", Godot/ folder
//                                             https://quaternius.itch.io/universal-animation-library
//   ual2/UAL2_Standard.glb                    "Universal Animation Library 2 [Standard]", Unreal-Godot/ folder
//                                             https://quaternius.itch.io/universal-animation-library-2
// Both share one skeleton; UAL1's Godot file names its bones the Rigify way (DEF-upper_arm.L),
// UAL2's the UE way (upperarm_l). The game's old guest-anims.glb was a subset of UAL1.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import * as THREE from 'three';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = join(WEB, '.people-cache');
const SOURCES = {
  ual1: join(CACHE, 'sources/ual1/AnimationLibrary_Godot_Standard.glb'),
  ual2: join(CACHE, 'sources/ual2/UAL2_Standard.glb'),
};
const RIG_SAVE = join(CACHE, 'work/retarget/rig-target.glb');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const FPS = Number(opt('fps', '30'));
const OUT = resolve(WEB, opt('out', 'public/models/people/clips-extra.glb'));
// build-manifest merges every meta/clippack-*.json, so only a pack inside public/ gets a sidecar there
const PUBLIC = join(WEB, 'public/models/people');
const META = relative(PUBLIC, OUT).startsWith('..')
  ? OUT.replace(/\.glb$/, '.meta.json')
  : join(CACHE, `meta/clippack-${OUT.match(/([^\\/]+)\.glb$/)[1].replace(/^clips-/, '')}.json`);
const ONLY = opt('only', '')?.split(',').filter(Boolean);
// --try ual1:Walk_Loop,ual2:Farm_Watering bakes source clips that aren't in the list, to look at them
const TRY = (opt('try', '') ?? '').split(',').filter(Boolean).map((t) => {
  const [src, clip] = t.split(':');
  return { name: clip, src, clip, loop: /_Loop$/.test(clip), locomotion: true, ground: false };
});
const COMPARE = opt('compare', null);
// who the pack is for: 'any' when one pack serves both, else the --target's gender (m/f packs)
const GENDER = opt('gender', 'any');
if (!['any', 'm', 'f'].includes(GENDER)) throw new Error('--gender is any, m or f');
const TARGET =
  opt('target', null) ??
  [join(WEB, 'public/models/people/Male_Adult_01.hero.glb'), join(WEB, 'public/models/people/Male_Adult_01.crowd.glb'), RIG_SAVE].find((p) =>
    existsSync(p),
  );
if (!TARGET) throw new Error('no target rig: pass --target <a converted Rocketbox male .glb>');

// ------------------------------------------------------------------------------------ clip list

/**
 * What to bake. `name` is the game's name for it (the old library's names where the game already
 * plays them); `src`/`clip` where it comes from. `from`/`to` (seconds) cut a stretch out of it;
 * `hold` freezes one moment into a still pose (the runtime layers breathing or a head turn on top);
 * `blend` (seconds) eases a loop's last stretch back into its first frame where the source doesn't
 * loop; `reach` bends an arm by IK so its hand comes to the mouth while the source raises it.
 * `ground: false` marks clips whose feet aren't meant to stay on the floor (the checks note it).
 */
const CLIPS = [
  // already played by the game (people.ts, crowd.ts, player.ts, volley-players.ts)
  { name: 'Jump_Start', src: 'ual1', clip: 'Jump_Start' },
  { name: 'Jump_Loop', src: 'ual1', clip: 'Jump_Loop', loop: true, ground: false },
  { name: 'Jump_Land', src: 'ual1', clip: 'Jump_Land' },
  { name: 'Roll', src: 'ual1', clip: 'Roll', ground: false },
  { name: 'Crouch_Idle_Loop', src: 'ual1', clip: 'Crouch_Idle_Loop', loop: true },
  { name: 'Punch_Cross', src: 'ual1', clip: 'Punch_Cross' },
  { name: 'Interact', src: 'ual1', clip: 'Interact' },
  // the sea: a crawl (face down along +z, hips 0.75 m up: the runtime sets the depth) and treading water
  { name: 'Swim_Fwd_Loop', src: 'ual1', clip: 'Swim_Fwd_Loop', loop: true, ground: false },
  { name: 'Swim_Idle_Loop', src: 'ual1', clip: 'Swim_Idle_Loop', loop: true, ground: false },
  // seated on nothing with both fists forward on a wheel: jet-ski riders (IK puts the hands on the bars)
  { name: 'Driving_Loop', src: 'ual1', clip: 'Driving_Loop', loop: true, ground: false },
  // UAL2's "Consume" holds the left hand out, palm up, the right on the hip: handing something over.
  // Eat is the same clip with the left hand brought to the mouth instead.
  { name: 'Offer', src: 'ual2', clip: 'Consume' },
  { name: 'Eat', src: 'ual2', clip: 'Consume', reach: 'L' },
  { name: 'Idle_FoldArms_Loop', src: 'ual2', clip: 'Idle_FoldArms_Loop', loop: true },
  // leaning forward on both forearms (a rail at about 1.1 m), and the same with a wave and a call
  { name: 'Idle_Rail_Loop', src: 'ual2', clip: 'Idle_Rail_Loop', loop: true },
  { name: 'Idle_Rail_Call', src: 'ual2', clip: 'Idle_Rail_Call', loop: true },
  // a slow walk with a box held low in both hands
  { name: 'Walk_Carry_Loop', src: 'ual2', clip: 'Walk_Carry_Loop', loop: true, locomotion: true },
  // knocked flying and down onto the back (ends as Lie_To_Stand starts); two short flinches
  { name: 'Hit_Knockback', src: 'ual2', clip: 'Hit_Knockback' },
  { name: 'Hit_Chest', src: 'ual1', clip: 'Hit_Chest' },
  { name: 'Hit_Head', src: 'ual1', clip: 'Hit_Head' },
  // UAL2's "Yes" is a left thumbs-up with a small nod; "No" shakes the head and drops it
  { name: 'Thumbs_Up', src: 'ual2', clip: 'Yes' },
  { name: 'Shake_No', src: 'ual2', clip: 'Idle_No_Loop' },
  // reaching forward to waist height with the right hand: taking something from a counter
  { name: 'Pick_Up', src: 'ual1', clip: 'PickUp_Table' },
  // down on one knee working at the ground with both hands (mechanics, ground crew, gardeners)
  { name: 'Kneel_Fix_Loop', src: 'ual1', clip: 'Fixing_Kneeling', from: 1, to: 4.2, blend: 0.6, loop: true },
  // a wind-up and a big overarm throw: the nearest thing to a volleyball serve or spike
  { name: 'Throw_Overhand', src: 'ual2', clip: 'OverhandThrow' },
  // getting up from lying on the back; its first moment held as lying flat (sunbathing), and a
  // moment from it as sitting on the ground leaning back on the hands, knees up
  { name: 'Lie_To_Stand', src: 'ual2', clip: 'LayToIdle', ground: false },
  { name: 'Lie_Loop', src: 'ual2', clip: 'LayToIdle', hold: 0, loop: true, ground: false },
  { name: 'Sit_Ground_Loop', src: 'ual2', clip: 'LayToIdle', hold: 0.46, loop: true, ground: false },
];

// ------------------------------------------------------------------------------------ bone map

/** UAL1's Godot file uses Rigify names; turn them into the UE names UAL2 (and the game) use. */
function ueName(n) {
  const side = (s) => (s === 'L' ? 'l' : 'r');
  const simple = {
    'DEF-hips': 'pelvis', 'DEF-spine.001': 'spine_01', 'DEF-spine.002': 'spine_02', 'DEF-spine.003': 'spine_03',
    'DEF-neck': 'neck_01', 'DEF-head': 'Head',
  };
  if (simple[n]) return simple[n];
  let m = n.match(/^DEF-(shoulder|upper_arm|forearm|hand|thigh|shin|foot|toe)\.([LR])$/);
  if (m) {
    const part = { shoulder: 'clavicle', upper_arm: 'upperarm', forearm: 'lowerarm', hand: 'hand', thigh: 'thigh', shin: 'calf', foot: 'foot', toe: 'ball' }[m[1]];
    return `${part}_${side(m[2])}`;
  }
  m = n.match(/^DEF-(?:f_)?(index|middle|ring|pinky|thumb)\.0(\d)\.([LR])$/);
  if (m) return `${m[1]}_0${m[2]}_${side(m[3])}`;
  return n;
}

/** Biped bone (spaces as in the FBX) → UE-mannequin bone. */
const MAP = {
  'Bip01 Pelvis': 'pelvis', 'Bip01 Spine': 'spine_01', 'Bip01 Spine1': 'spine_02', 'Bip01 Spine2': 'spine_03',
  'Bip01 Neck': 'neck_01', 'Bip01 Head': 'Head',
};
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
  Object.assign(MAP, {
    [`Bip01 ${S} Clavicle`]: `clavicle_${s}`, [`Bip01 ${S} UpperArm`]: `upperarm_${s}`, [`Bip01 ${S} Forearm`]: `lowerarm_${s}`,
    [`Bip01 ${S} Hand`]: `hand_${s}`, [`Bip01 ${S} Thigh`]: `thigh_${s}`, [`Bip01 ${S} Calf`]: `calf_${s}`,
    [`Bip01 ${S} Foot`]: `foot_${s}`, [`Bip01 ${S} Toe0`]: `ball_${s}`,
  });
  FINGERS.forEach((f, i) => [`${i}`, `${i}1`, `${i}2`].forEach((suf, j) => (MAP[`Bip01 ${S} Finger${suf}`] = `${f}_0${j + 1}_${s}`)));
}

/**
 * The source is swung into the target's rest pose bone by bone, parent first: [target bone, the
 * target joint its direction points at, and for a full frame two joints across it (right → left)].
 * Source joints are found through MAP. (The last finger bones keep their own rest: UAL1 has no
 * fingertip joints to aim them by.)
 */
const ALIGN = [
  ['Bip01 Pelvis', 'Bip01 Spine', ['Bip01 R Thigh', 'Bip01 L Thigh']],
  ['Bip01 Spine', 'Bip01 Spine1'],
  ['Bip01 Spine1', 'Bip01 Spine2'],
  ['Bip01 Spine2', 'Bip01 Neck'],
  ['Bip01 Neck', 'Bip01 Head'],
];
for (const S of ['L', 'R']) {
  ALIGN.push(
    [`Bip01 ${S} Clavicle`, `Bip01 ${S} UpperArm`],
    [`Bip01 ${S} UpperArm`, `Bip01 ${S} Forearm`],
    [`Bip01 ${S} Forearm`, `Bip01 ${S} Hand`],
    // the palm: towards the middle finger, across from the pinky to the index finger
    [`Bip01 ${S} Hand`, `Bip01 ${S} Finger2`, [`Bip01 ${S} Finger4`, `Bip01 ${S} Finger1`]],
  );
  for (let f = 0; f < 5; f++) ALIGN.push([`Bip01 ${S} Finger${f}`, `Bip01 ${S} Finger${f}1`], [`Bip01 ${S} Finger${f}1`, `Bip01 ${S} Finger${f}2`]);
  ALIGN.push([`Bip01 ${S} Thigh`, `Bip01 ${S} Calf`], [`Bip01 ${S} Calf`, `Bip01 ${S} Foot`], [`Bip01 ${S} Foot`, `Bip01 ${S} Toe0`]);
}

// ------------------------------------------------------------------------------------ loading

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/** A glTF's node tree as plain three.js objects (names optionally renamed), for the maths. */
function buildTree(doc, rename = (n) => n) {
  const root = new THREE.Group();
  const nodes = new Map();
  const add = (n, parent) => {
    const o = new THREE.Object3D();
    o.name = rename(n.getName());
    o.position.fromArray(n.getTranslation());
    o.quaternion.fromArray(n.getRotation());
    o.scale.fromArray(n.getScale());
    parent.add(o);
    nodes.set(n, o);
    for (const c of n.listChildren()) add(c, o);
  };
  for (const n of doc.getRoot().listScenes()[0].listChildren()) add(n, root);
  root.updateMatrixWorld(true);
  return { root, nodes, byName: (name) => root.getObjectByName(name) };
}

/** Rest TRS of every object, to put a tree back after posing it. */
function snapshot(root) {
  const s = [];
  root.traverse((o) => s.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  return () => {
    for (const [o, p, q, sc] of s) o.position.copy(p), o.quaternion.copy(q), o.scale.copy(sc);
    root.updateMatrixWorld(true);
  };
}

const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
const wp = (o) => o.getWorldPosition(new THREE.Vector3());
const mid = (a, b) => wp(a).add(wp(b)).multiplyScalar(0.5);

/** The source library: its node tree and each clip as three.js tracks over that tree. */
async function loadSource(path) {
  if (!existsSync(path)) throw new Error(`missing source ${relative(WEB, path)}: see this script's header for where to get it`);
  const doc = await io.read(path);
  const tree = buildTree(doc, ueName);
  const clips = new Map();
  for (const a of doc.getRoot().listAnimations()) {
    const tracks = [];
    for (const ch of a.listChannels()) {
      const node = tree.nodes.get(ch.getTargetNode());
      if (!node) continue;
      const s = ch.getSampler();
      const interp = s.getInterpolation();
      if (interp === 'CUBICSPLINE') throw new Error(`${a.getName()}: cubic-spline tracks not handled`);
      const times = Float32Array.from(s.getInput().getArray());
      const values = Float32Array.from(s.getOutput().getArray());
      const path = ch.getTargetPath();
      const T = path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      const prop = { rotation: 'quaternion', translation: 'position', scale: 'scale' }[path];
      if (!prop) continue;
      const tr = new T(`${node.name}.${prop}`, times, values, interp === 'STEP' ? THREE.InterpolateDiscrete : THREE.InterpolateLinear);
      tracks.push({ node, prop, interpolant: tr.createInterpolant() });
    }
    const duration = Math.max(...a.listChannels().map((c) => c.getSampler().getInput().getMax([])[0]));
    clips.set(a.getName(), { tracks, duration });
  }
  return { tree, clips };
}

/** Pose a source tree at time t of one of its clips. */
function poseAt(clip, t) {
  for (const { node, prop, interpolant } of clip.tracks) node[prop].fromArray(interpolant.evaluate(t));
}

/**
 * The target rig: its node tree, its skeleton in parent-first order and its measurements. When it
 * comes from a full avatar, the height is read off the skinned mesh in its bind pose.
 */
async function loadTarget(path) {
  const doc = await io.read(path);
  // the pipeline's GLBs already carry GLTFLoader's names (Bip01_L_Thigh); work in Biped's own
  const tree = buildTree(doc, (n) => (/^Bip01/.test(n) ? n.replace(/_/g, ' ') : n));
  const bip = tree.byName('Bip01');
  if (!bip) throw new Error(`${path}: no Bip01 node (not a Rocketbox Biped rig?)`);
  const bones = [];
  bip.traverse((o) => {
    if (!/Footsteps/.test(o.name)) bones.push(o);
  });
  let height = doc.getRoot().getExtras()?.height;
  const skin = doc.getRoot().listSkins()[0];
  if (skin) {
    // bind pose: every joint's world matrix × its inverse bind matrix is the same; use joint 0's
    const ibm = new THREE.Matrix4().fromArray(skin.getInverseBindMatrices().getElement(0, []));
    const m = tree.nodes.get(skin.listJoints()[0]).matrixWorld.clone().multiply(ibm);
    let top = -Infinity;
    let bottom = Infinity;
    const v = new THREE.Vector3();
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        for (let i = 0; i < pos.getCount(); i++) {
          v.fromArray(pos.getElement(i, [])).applyMatrix4(m);
          top = Math.max(top, v.y);
          bottom = Math.min(bottom, v.y);
        }
      }
    height = top - Math.max(0, bottom);
  }
  return { doc, tree, bip, bones, height, hip: bip.position.y };
}

/** Keep just the skeleton (with its measured height) so later runs work without the avatar. */
async function saveRig(target, path) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene();
  const add = (o) => {
    const n = doc.createNode(o.name).setTranslation(o.position.toArray()).setRotation(o.quaternion.toArray()).setScale(o.scale.toArray());
    for (const c of o.children) if (!/Footsteps/.test(c.name)) n.addChild(add(c));
    return n;
  };
  scene.addChild(add(target.bip));
  doc.getRoot().setExtras({ height: target.height });
  mkdirSync(dirname(path), { recursive: true });
  await io.write(path, doc);
}

// ------------------------------------------------------------------------------------ retarget

const facing = (l, r) => {
  const d = wp(l).sub(wp(r)).cross(new THREE.Vector3(0, 1, 0));
  d.y = 0;
  return d.normalize();
};

/** Turn `bone` (world space) by the rotation taking frame (dir, side) of the source onto the target's. */
function turnOnto(bone, from, to) {
  const q = new THREE.Quaternion();
  if (from.side) {
    const basis = (d, s) => {
      const x = d.clone().normalize();
      const z = new THREE.Vector3().crossVectors(x, s).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      return new THREE.Matrix4().makeBasis(x, y, z);
    };
    const m = basis(to.dir, to.side).multiply(basis(from.dir, from.side).invert());
    q.setFromRotationMatrix(m);
  } else q.setFromUnitVectors(from.dir.clone().normalize(), to.dir.clone().normalize());
  const world = q.multiply(wq(bone));
  bone.quaternion.copy(wq(bone.parent).invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * Everything that doesn't change per frame: which source bone drives which target bone, the
 * rotation offsets, and the leg-length scale for hip height.
 */
function prepare(source, target) {
  const S = source.tree;
  const T = target.tree;
  const tByName = (n) => T.byName(n);
  const sFor = (tName) => (MAP[tName] ? S.byName(MAP[tName]) : null);
  const restoreS = snapshot(S.root);

  // face the source the way the target faces (both should face +z, left at +x)
  const fs = facing(S.byName('thigh_l'), S.byName('thigh_r'));
  const ft = facing(tByName('Bip01 L Thigh'), tByName('Bip01 R Thigh'));
  S.root.rotation.y = Math.atan2(ft.x, ft.z) - Math.atan2(fs.x, fs.z);
  S.root.updateMatrixWorld(true);
  const restS = snapshot(S.root);

  // hip joints at rest, before any posing, set the scale for hip motion
  const sHip0 = mid(S.byName('thigh_l'), S.byName('thigh_r'));
  const tHip0 = mid(tByName('Bip01 L Thigh'), tByName('Bip01 R Thigh'));
  const k = tHip0.y / sHip0.y;
  // and the foot joints' standing heights, for keeping feet on the floor
  const sFeet = ['foot_l', 'foot_r', 'ball_l', 'ball_r'].map((n) => [S.byName(n), wp(S.byName(n)).y]);
  const tFeet = ['Bip01 L Foot', 'Bip01 R Foot', 'Bip01 L Toe0', 'Bip01 R Toe0'].map((n) => [tByName(n), wp(tByName(n)).y]);

  // pose the source into the target's A-pose, parent first
  for (const [a, b, side] of ALIGN) {
    const Sa = sFor(a), Sb = sFor(b), Ta = tByName(a), Tb = tByName(b);
    if (!Sa || !Sb || !Ta || !Tb) continue;
    const from = { dir: wp(Sb).sub(wp(Sa)) };
    const to = { dir: wp(Tb).sub(wp(Ta)) };
    if (side) {
      from.side = wp(sFor(side[1])).sub(wp(sFor(side[0])));
      to.side = wp(tByName(side[1])).sub(wp(tByName(side[0])));
    }
    turnOnto(Sa, from, to);
  }

  const drive = [];
  for (const tb of target.bones) {
    const sb = sFor(tb.name);
    if (sb) drive.push({ tb, sb, offset: wq(sb).invert().multiply(wq(tb)) });
  }
  restoreS();
  restS();
  return { k, sHip0, tHip0, sFeet, tFeet, drive: new Map(drive.map((d) => [d.tb, d])) };
}

/**
 * One frame: pose the target from the source's current pose. Returns local rotations for every
 * driven bone (Bip01 carries the pelvis turn; Pelvis keeps its rest, as in Rocketbox's own clips)
 * and Bip01's position.
 */
function retargetFrame(source, target, prep, restoreT) {
  restoreT();
  const S = source.tree;
  S.root.updateMatrixWorld(true);
  const { bip, bones } = target;
  const pelvis = bones.find((b) => b.name === 'Bip01 Pelvis');
  const out = new Map();
  for (const tb of bones) {
    const d = prep.drive.get(tb);
    if (tb === bip) {
      // Bip01's world turn = pelvis world turn × (pelvis rest local)⁻¹
      const p = prep.drive.get(pelvis);
      const want = wq(p.sb).multiply(p.offset).multiply(pelvis.quaternion.clone().invert());
      bip.quaternion.copy(wq(bip.parent).invert().multiply(want));
    } else if (d && tb !== pelvis) {
      const want = wq(d.sb).multiply(d.offset);
      tb.quaternion.copy(wq(tb.parent).invert().multiply(want));
    } else {
      // undriven (face, nubs) and Pelvis: rest local; nothing to write
      tb.updateMatrixWorld(false);
      continue;
    }
    tb.updateMatrixWorld(true);
    out.set(tb, tb.quaternion.clone());
  }
  // hips: put the target's hip joints where the source's are, scaled by leg length
  const sHip = mid(S.byName('thigh_l'), S.byName('thigh_r'));
  const want = new THREE.Vector3(prep.tHip0.x + (sHip.x - prep.sHip0.x) * prep.k, sHip.y * prep.k, prep.tHip0.z + (sHip.z - prep.sHip0.z) * prep.k);
  const have = mid(target.tree.byName('Bip01 L Thigh'), target.tree.byName('Bip01 R Thigh'));
  const shift = want.sub(have);
  // into Bip01's parent space (the rig's root is unscaled in FBX2glTF output, but don't assume)
  const parentInv = new THREE.Matrix4().copy(bip.parent.matrixWorld).invert();
  bip.position.copy(wp(bip).add(shift).applyMatrix4(parentInv));
  target.tree.root.updateMatrixWorld(true);
  // Near the floor, the lowest foot joint stands as high off it as the source's: the two rigs'
  // shins and feet differ by a few centimetres, enough to sink a tiptoe or float a crouch.
  const low = (feet, k) => Math.min(...feet.map(([o, y0]) => wp(o).y - y0)) * k;
  const sLow = low(prep.sFeet, prep.k);
  const w = THREE.MathUtils.clamp(1 - (sLow - 0.03) / 0.05, 0, 1);
  if (w > 0) {
    const lift = new THREE.Vector3(0, w * (sLow - low(prep.tFeet, 1)), 0);
    bip.position.copy(wp(bip).add(lift).applyMatrix4(parentInv));
    target.tree.root.updateMatrixWorld(true);
  }
  return { rot: out, pos: bip.position.clone() };
}

/** Bake one clip: frames of local rotations and Bip01 positions, plus checks measured on the target. */
function bake(spec, source, target, prep) {
  const clip = source.clips.get(spec.clip);
  if (!clip) throw new Error(`${spec.src} has no clip "${spec.clip}"`);
  const restoreS = snapshot(source.tree.root);
  const restoreT = snapshot(target.tree.root);
  const t0 = spec.from ?? 0;
  const t1 = spec.to ?? clip.duration;
  const hold = spec.hold !== undefined;
  const span = hold ? 1 : t1 - t0;
  const n = hold ? 1 : Math.max(1, Math.round(span * FPS));
  const times = [];
  const frames = [];
  const tb = target.tree.byName;
  const feet = ['Bip01 L Foot', 'Bip01 R Foot', 'Bip01 L Toe0', 'Bip01 R Toe0'].map(tb);
  const rest = feet.map((f) => wp(f).y);
  const sink = { min: Infinity, maxOfMin: -Infinity };
  const contact = [];
  for (let i = 0; i <= n; i++) {
    const t = hold ? spec.hold : t0 + (span * i) / n;
    restoreS();
    poseAt(clip, t);
    const f = retargetFrame(source, target, prep, restoreT);
    times.push(hold ? i : (span * i) / n);
    frames.push(f);
    // ground check: the lowest foot joint against its standing height
    const lows = feet.map((o, j) => wp(o).y - rest[j]);
    const low = Math.min(...lows);
    sink.min = Math.min(sink.min, low);
    sink.maxOfMin = Math.max(sink.maxOfMin, low);
    const j = lows[0] < lows[1] ? 0 : 1;
    contact.push({ j, p: wp(feet[j]), down: lows[j] < 0.02 });
  }
  restoreS();
  if (spec.blend && !hold) {
    // ease the last stretch into the first frame, so a cut from the middle of a clip loops
    const from = span - spec.blend;
    for (let i = 0; i <= n; i++) {
      if (times[i] <= from) continue;
      const w = THREE.MathUtils.smoothstep(times[i], from, span);
      for (const [o, q] of frames[i].rot) q.slerp(frames[0].rot.get(o), w);
      frames[i].pos.lerp(frames[0].pos, w);
    }
  }
  if (spec.reach) reachMouth(frames, target, restoreT, spec.reach);
  restoreT();
  if (spec.loop && !hold) {
    // close the loop exactly, and take out any drift of the hips over a cycle
    const a = frames[0].pos, b = frames[n].pos;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      frames[i].pos.x -= (b.x - a.x) * k;
      frames[i].pos.z -= (b.z - a.z) * k;
    }
    frames[n] = { rot: new Map([...frames[0].rot].map(([o, q]) => [o, q.clone()])), pos: frames[0].pos.clone() };
  }
  // locomotion: ground speed from the planted foot sliding back under the in-place body
  let speed;
  if (spec.locomotion) {
    let dist = 0, dt = 0;
    for (let i = 1; i <= n; i++) {
      const a = contact[i - 1], c = contact[i];
      const v = a.p.z - c.p.z;
      // only while the same foot stays on the ground
      if (a.j === c.j && a.down && c.down && v > 0) (dist += v), (dt += times[i] - times[i - 1]);
    }
    speed = dt > 0 ? +(dist / dt).toFixed(3) : undefined;
  }
  return { spec, times, frames, duration: hold ? 1 : span, sink, speed };
}

/**
 * Bring one hand to the mouth by IK while the source moves it (UAL2's Consume raises the left hand
 * as if offering something; this turns it into eating from it). How far the source's hand has moved
 * from where it started, relative to the chest, sets how much of the way it goes: none at rest, all
 * of it at the top of the gesture. The wrist goes a little below and in front of the mouth, the
 * elbow down and out, the hand turned so the fingers come up to the lips.
 */
function reachMouth(frames, target, restoreT, side) {
  const T = (n) => target.tree.byName(n);
  const upper = T(`Bip01 ${side} UpperArm`), fore = T(`Bip01 ${side} Forearm`), hand = T(`Bip01 ${side} Hand`);
  const finger = T(`Bip01 ${side} Finger2`), chest = T('Bip01 Spine2'), lip = T('Bip01 MUpperLip');
  const clavL = T('Bip01 L Clavicle'), clavR = T('Bip01 R Clavicle');
  const pose = (f) => {
    restoreT();
    for (const [o, q] of f.rot) o.quaternion.copy(q);
    target.bip.position.copy(f.pos);
    target.tree.root.updateMatrixWorld(true);
  };
  // the source hand's travel, in the chest's frame
  const inChest = () => chest.worldToLocal(wp(hand));
  pose(frames[0]);
  const start = inChest();
  const travel = frames.map((f) => (pose(f), inChest().distanceTo(start)));
  const most = Math.max(...travel);
  if (most < 0.05) return;
  const up = new THREE.Vector3(0, 1, 0);
  const swing = (bone, from, to) => {
    const q = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()).multiply(wq(bone));
    bone.quaternion.copy(wq(bone.parent).invert().multiply(q));
    bone.updateMatrixWorld(true);
  };
  frames.forEach((f, i) => {
    const w = THREE.MathUtils.smoothstep(travel[i] / most, 0.15, 0.85);
    if (w === 0) return;
    pose(f);
    const fk = [upper, fore, hand].map((o) => o.quaternion.clone());
    const left = wp(clavL).sub(wp(clavR)).normalize();
    const out = side === 'L' ? left : left.clone().negate();
    const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
    const mouth = wp(lip);
    const goal = mouth.clone().addScaledVector(fwd, 0.11).addScaledVector(up, -0.07).addScaledVector(out, 0.02);
    const lips = mouth.clone().addScaledVector(fwd, 0.03);
    // two-bone IK: the elbow on the circle the two lengths allow, towards the pole
    const S = wp(upper), E = wp(fore), W = wp(hand);
    const a = E.distanceTo(S), b = W.distanceTo(E);
    const d = goal.clone().sub(S);
    const dist = THREE.MathUtils.clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
    d.normalize();
    const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
    const pole = up.clone().negate().addScaledVector(out, 0.6);
    pole.addScaledVector(d, -pole.dot(d)).normalize();
    const elbow = S.clone().addScaledVector(d, a * cosA).addScaledVector(pole, a * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
    swing(upper, E.clone().sub(S), elbow.clone().sub(S));
    swing(fore, wp(hand).sub(wp(fore)), goal.clone().sub(wp(fore)));
    swing(hand, wp(finger).sub(wp(hand)), lips.sub(wp(hand)));
    [upper, fore, hand].forEach((o, j) => f.rot.set(o, fk[j].clone().slerp(o.quaternion, w)));
  });
}

// ------------------------------------------------------------------------------------ writing

/** A document with the target's skeleton nodes (no mesh) and the given baked clips. */
function writePack(target, baked) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const nodeOf = new Map();
  const add = (o) => {
    // named as GLTFLoader names them, like the pipeline's own packs and avatars
    const n = doc.createNode(o.name.replace(/ /g, '_')).setTranslation(o.position.toArray()).setRotation(o.quaternion.toArray()).setScale(o.scale.toArray());
    nodeOf.set(o, n);
    for (const c of o.children) if (!/Footsteps/.test(c.name)) n.addChild(add(c));
    return n;
  };
  const top = target.bip.parent && target.bip.parent !== target.tree.root ? target.bip.parent : null;
  if (top) {
    const n = doc.createNode(top.name).setTranslation(top.position.toArray()).setRotation(top.quaternion.toArray()).setScale(top.scale.toArray());
    n.addChild(add(target.bip));
    scene.addChild(n);
  } else scene.addChild(add(target.bip));

  for (const b of baked) {
    const anim = doc.createAnimation(b.spec.name);
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(b.times)).setBuffer(buffer);
    const channel = (node, path, type, array) => {
      const output = doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
    };
    for (const bone of b.frames[0].rot.keys()) {
      const arr = new Float32Array(b.frames.length * 4);
      let prev = null;
      b.frames.forEach((f, i) => {
        const q = f.rot.get(bone).clone();
        // keep neighbours in the same hemisphere so interpolation and compression stay smooth
        if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        q.toArray(arr, i * 4);
        prev = q;
      });
      channel(nodeOf.get(bone), 'rotation', 'VEC4', arr);
    }
    const pos = new Float32Array(b.frames.length * 3);
    b.frames.forEach((f, i) => f.pos.toArray(pos, i * 3));
    channel(nodeOf.get(target.bip), 'translation', 'VEC3', pos);
  }
  return doc;
}

async function compress(doc) {
  // Every channel of a clip keeps every frame and shares the clip's one time accessor: glTF's JSON
  // per accessor costs more than the keys a resample would drop, and meshopt packs the repeats.
  await doc.transform(dedup(), prune({ keepLeaves: true }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  return doc;
}

// ------------------------------------------------------------------------------------ run

const target = await loadTarget(TARGET);
console.log(`target ${relative(WEB, TARGET)}: height ${target.height?.toFixed(3)} m, hip (Bip01) ${target.hip.toFixed(3)} m, ${target.bones.length} nodes`);
// the saved skeleton is the default target's, the man's
if (resolve(TARGET) !== RIG_SAVE && GENDER !== 'f') await saveRig(target, RIG_SAVE);

const sources = {};
for (const [key, path] of Object.entries(SOURCES)) sources[key] = await loadSource(path);
const preps = {};
for (const key of Object.keys(sources)) preps[key] = prepare(sources[key], target);

const list = [...CLIPS.filter((c) => !(ONLY?.length || TRY.length) || ONLY?.includes(c.name)), ...TRY];
const baked = list.map((spec) => bake(spec, sources[spec.src], target, preps[spec.src]));

// per-clip sizes: each clip compressed alone, less the skeleton every pack carries once
const base = (await io.writeBinary(await compress(writePack(target, [])))).byteLength;
const rows = [];
for (const b of baked) {
  const one = await compress(writePack(target, [b]));
  const bytes = (await io.writeBinary(one)).byteLength - base;
  const keys = one.getRoot().listAccessors().filter((a) => a.getType() === 'SCALAR').reduce((n, a) => Math.max(n, a.getCount()), 0);
  rows.push({ b, bytes, keys });
}
const pack = await compress(writePack(target, baked));
mkdirSync(dirname(OUT), { recursive: true });
await io.write(OUT, pack);
const bytes = statSync(OUT).size;

console.log(`\n${'clip'.padEnd(20)} ${'src'.padEnd(26)} ${'secs'.padStart(5)} loop ${'keys'.padStart(4)} ${'bytes'.padStart(7)}  feet low…high (cm)  speed`);
for (const { b, bytes: by, keys } of rows) {
  const s = b.spec;
  const feet = `${(b.sink.min * 100).toFixed(1).padStart(6)} … ${(b.sink.maxOfMin * 100).toFixed(1).padStart(6)}${s.ground === false ? ' (air)' : ''}`;
  console.log(
    `${s.name.padEnd(20)} ${`${s.src}:${s.clip}${s.hold !== undefined ? `@${s.hold}` : ''}`.padEnd(26)} ${b.duration.toFixed(2).padStart(5)} ${(s.loop ? 'yes' : 'no').padEnd(4)} ${String(keys).padStart(4)} ${String(by).padStart(7)}  ${feet.padEnd(18)} ${b.speed ?? ''}`,
  );
}
console.log(`\nwrote ${relative(WEB, OUT)}: ${bytes} bytes, ${baked.length} clips (the skeleton alone is ${base})`);

const meta = {
  file: relative(PUBLIC, OUT).replace(/\\/g, '/'),
  rig: 'rocketbox',
  gender: GENDER,
  refHeight: +target.height.toFixed(3),
  refHip: +target.hip.toFixed(3),
  clips: baked.map((b) => ({ name: b.spec.name, duration: +b.duration.toFixed(3), loop: !!b.spec.loop, ...(b.speed ? { speed: b.speed } : {}) })),
  bytes,
};
mkdirSync(dirname(META), { recursive: true });
writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
console.log(`wrote ${relative(WEB, META)}`);
// where each clip came from, for the contact sheet's source column (retarget-web/)
const origins = Object.fromEntries(baked.map(({ spec: s }) => [s.name, { src: s.src, clip: s.clip, from: s.from, to: s.to, hold: s.hold }]));
writeFileSync(join(CACHE, 'work/retarget/origins.json'), JSON.stringify(origins, null, 1) + '\n');

// ------------------------------------------------------------------------------------ compare

if (COMPARE) {
  // Bake again on the other rig and play the shared pack's rotations on it too: if the hands and
  // feet land within a few centimetres either way, one pack suits both.
  const other = await loadTarget(resolve(WEB, COMPARE));
  const restoreO = snapshot(other.tree.root);
  const ends = ['Bip01 L Hand', 'Bip01 R Hand', 'Bip01 L Foot', 'Bip01 R Foot', 'Bip01 Head'];
  console.log(`\ncompare on ${COMPARE} (hip ${other.hip.toFixed(3)} m): own bake vs shared pack, worst distance (cm) per end`);
  for (const key of Object.keys(sources)) preps[`o:${key}`] = prepare(sources[key], other);
  for (const b of baked) {
    const own = bake(b.spec, sources[b.spec.src], other, preps[`o:${b.spec.src}`]);
    const worst = Object.fromEntries(ends.map((e) => [e, 0]));
    for (let i = 0; i < b.frames.length; i++) {
      const apply = (f, scale) => {
        restoreO();
        for (const [bone, q] of f.rot) other.tree.byName(bone.name).quaternion.copy(q);
        other.bip.position.copy(f.pos).multiplyScalar(scale);
        other.tree.root.updateMatrixWorld(true);
        return ends.map((e) => wp(other.tree.byName(e)));
      };
      const a = apply(own.frames[Math.min(i, own.frames.length - 1)], 1);
      const p = apply(b.frames[i], other.hip / target.hip);
      ends.forEach((e, j) => (worst[e] = Math.max(worst[e], a[j].distanceTo(p[j]))));
    }
    console.log(`${b.spec.name.padEnd(20)} ${ends.map((e) => `${e.replace('Bip01 ', '')} ${(worst[e] * 100).toFixed(1)}`).join('  ')}`);
  }
  restoreO();
}
