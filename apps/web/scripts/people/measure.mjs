// Measurements on a converted avatar (its base.glb, uncompressed): height, hip height, where the
// anchors sit in their bones' space, how far the seated clip puts the seat below the hips, and the
// skin tone of the face. Used by convert.mjs; also runnable on its own to print them:
//
//   node scripts/people/measure.mjs Male_Adult_01
//
// Everything is computed the glTF way (a vertex's world position is the weighted sum of
// jointWorld × inverseBind × position), with three.js's maths, so it matches what the game sees.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import sharp from 'sharp';
import { WORK, gltfIO, readJson } from './lib.mjs';
import { AVATARS } from './catalogue.mjs';

/** Canonical bone → Rocketbox node name, as GLTFLoader leaves it (spaces become '_'). */
export const BONES = {
  pelvis: 'Bip01_Pelvis',
  spine_01: 'Bip01_Spine',
  spine_02: 'Bip01_Spine1',
  spine_03: 'Bip01_Spine2',
  neck_01: 'Bip01_Neck',
  Head: 'Bip01_Head',
  clavicle_l: 'Bip01_L_Clavicle',
  upperarm_l: 'Bip01_L_UpperArm',
  lowerarm_l: 'Bip01_L_Forearm',
  hand_l: 'Bip01_L_Hand',
  middle_01_l: 'Bip01_L_Finger2',
  clavicle_r: 'Bip01_R_Clavicle',
  upperarm_r: 'Bip01_R_UpperArm',
  lowerarm_r: 'Bip01_R_Forearm',
  hand_r: 'Bip01_R_Hand',
  middle_01_r: 'Bip01_R_Finger2',
  thigh_l: 'Bip01_L_Thigh',
  calf_l: 'Bip01_L_Calf',
  foot_l: 'Bip01_L_Foot',
  ball_l: 'Bip01_L_Toe0',
  thigh_r: 'Bip01_R_Thigh',
  calf_r: 'Bip01_R_Calf',
  foot_r: 'Bip01_R_Foot',
  ball_r: 'Bip01_R_Toe0',
  eye_l: 'Bip01_LEye',
  eye_r: 'Bip01_REye',
};
export const RIG = { bones: BONES, root: 'Bip01' };

const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * A posable copy of a document's node tree: `pose(clip, t)` applies a clip's rotations and root
 * translation (by node name), `world(name)` gives a node's world matrix.
 */
export function rigOf(doc) {
  const nodes = doc.getRoot().listNodes();
  const parent = new Map();
  for (const n of nodes) for (const c of n.listChildren()) parent.set(c, n);
  const byName = new Map(nodes.map((n) => [n.getName(), n]));
  const local = new Map();
  const rest = () => {
    for (const n of nodes) local.set(n, { t: new THREE.Vector3(...n.getTranslation()), r: new THREE.Quaternion(...n.getRotation()), s: new THREE.Vector3(...n.getScale()) });
  };
  rest();
  const cache = new Map();
  const world = (n) => {
    if (typeof n === 'string') n = byName.get(n);
    if (!n) return null;
    let m = cache.get(n);
    if (m) return m;
    const l = local.get(n);
    m = new THREE.Matrix4().compose(l.t, l.r, l.s);
    const p = parent.get(n);
    if (p) m.premultiply(world(p));
    cache.set(n, m);
    return m;
  };
  return {
    byName,
    world,
    pos: (name) => new THREE.Vector3().setFromMatrixPosition(world(name)),
    rest() {
      rest();
      cache.clear();
    },
    /** Poses the rig with a clip (from clips.mjs's sampleClip) at time t; `hipScale` scales the root's height. */
    pose(clip, t, hipScale = 1) {
      rest();
      for (const [name, tr] of Object.entries(clip.tracks)) {
        const n = byName.get(name);
        if (!n) continue;
        const l = local.get(n);
        if (tr.rotation) l.r.fromArray(sample(tr.rotation, t, 4, true));
        if (tr.translation) {
          const v = sample(tr.translation, t, 3, false);
          l.t.set(v[0], v[1] * hipScale, v[2]);
        }
      }
      cache.clear();
    },
  };
}

/** Linear (slerp for quaternions) sampling of a {times, values} track. */
function sample(track, t, size, quat) {
  const { times, values } = track;
  let i = 0;
  while (i < times.length - 2 && times[i + 1] <= t) i++;
  const span = times[i + 1] - times[i] || 1;
  const k = THREE.MathUtils.clamp((t - times[i]) / span, 0, 1);
  if (quat) {
    const a = new THREE.Quaternion().fromArray(values, i * 4);
    const b = new THREE.Quaternion().fromArray(values, Math.min(i + 1, times.length - 1) * 4);
    return a.slerp(b, k).toArray();
  }
  const out = [];
  for (let c = 0; c < size; c++) out.push(THREE.MathUtils.lerp(values[i * size + c], values[Math.min(i + 1, times.length - 1) * size + c], k));
  return out;
}

/** World positions of a primitive's vertices under the rig's current pose, with each vertex's dominant joint name. */
export function skinned(rig, node, prim) {
  const skin = node.getSkin();
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices();
  const mats = joints.map((j, i) => new THREE.Matrix4().fromArray(ibm.getElement(i, [])).premultiply(rig.world(j)));
  const P = prim.getAttribute('POSITION');
  const J = prim.getAttribute('JOINTS_0');
  const W = prim.getAttribute('WEIGHTS_0');
  const out = [];
  const v = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const p = [];
  const j = [];
  const w = [];
  for (let i = 0; i < P.getCount(); i++) {
    P.getElement(i, p);
    J.getElement(i, j);
    W.getElement(i, w);
    v.fromArray(p);
    acc.set(0, 0, 0);
    let best = 0;
    for (let c = 0; c < 4; c++) {
      if (!w[c]) continue;
      acc.addScaledVector(tmp.copy(v).applyMatrix4(mats[j[c]]), w[c]);
      if (w[c] > w[best]) best = c;
    }
    out.push({ p: acc.clone(), joint: joints[j[best]].getName() });
  }
  return out;
}

/** Which primitives are which: by material name (`<code>_body`, `_head`, `_opacity`, anything else an extra). */
export function partsOf(doc) {
  const mats = doc.getRoot().listMaterials().map((m) => m.getName());
  const find = (re) => mats.find((n) => re.test(n));
  const body = find(/_body$/) ?? mats[0];
  const head = find(/_head$/) ?? body;
  const hair = find(/_opacity$/);
  const extras = {};
  for (const n of mats) if (n !== body && n !== head && n !== hair) extras[n.replace(/^[a-z]+\d+_?/i, '') || n] = n;
  return { body, head, ...(hair ? { hair } : {}), ...(Object.keys(extras).length ? { extras } : {}) };
}

/** A point in world space → the bone's local space (metres), as an Anchor. */
function anchor(rig, canonical, point) {
  const inv = rig.world(BONES[canonical]).clone().invert();
  const p = point.clone().applyMatrix4(inv);
  return { bone: canonical, at: [r4(p.x), r4(p.y), r4(p.z)] };
}

/**
 * Bind-pose measurements and anchors. The avatar faces +z with its left at +x.
 * Hats and helmets (extras) are left out of the height and the head top, so a hat can sit on the hair.
 */
export function measureBind(doc) {
  const rig = rigOf(doc);
  const parts = partsOf(doc);
  const lod0 = doc.getRoot().listNodes().find((n) => n.getName() === 'LOD0');
  const verts = { body: [], head: [], hair: [], extra: [] };
  // what a strap or a backpack rests on: the outermost surface, whatever covers the body there (a
  // keffiyeh over the shoulders, long hair down the back, a one-material model's robe). Found by
  // casting rays at its triangles, not by picking vertices: a low-poly robe has none near the point.
  const surface = [];
  for (const prim of lod0.getMesh().listPrimitives()) {
    const name = prim.getMaterial().getName();
    const key = name === parts.body ? 'body' : name === parts.head ? 'head' : name === parts.hair ? 'hair' : 'extra';
    const vs = skinned(rig, lod0, prim);
    verts[key].push(...vs);
    const idx = prim.getIndices();
    for (let i = 0; i + 2 < idx.getCount(); i += 3) surface.push([vs[idx.getScalar(i)].p, vs[idx.getScalar(i + 1)].p, vs[idx.getScalar(i + 2)].p]);
  }
  const person = [...verts.body, ...verts.head, ...verts.hair];
  /** The first point a ray meets on the surface (or null). */
  const cast = (from, dir) => {
    const ray = new THREE.Ray(from, dir);
    const hit = new THREE.Vector3();
    let best = null;
    let bestD = Infinity;
    for (const [a, b, c] of surface) {
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const d = hit.distanceTo(from);
      if (d < bestD) [bestD, best] = [d, hit.clone()];
    }
    return best;
  };
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { p } of person) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const hip = rig.pos('Bip01').y;

  // the top of the head (hair included), straight above the head bone
  const head = rig.pos(BONES.Head);
  let top = -Infinity;
  for (const { p } of person) if (Math.hypot(p.x - head.x, p.z - head.z) < 0.07) top = Math.max(top, p.y);
  // Under a keffiyeh the skull is cut away (only the face is modelled), so nothing of the person
  // reaches more than a few centimetres above the head joint: the cloth on the head is its top then,
  // and counts in the height (a hat is left out because there's a head under it).
  if (top < head.y + 0.1) {
    let cloth = -Infinity;
    for (const { p } of verts.extra) if (Math.hypot(p.x - head.x, p.z - head.z) < 0.07) cloth = Math.max(cloth, p.y);
    if (cloth > top) {
      top = cloth;
      maxY = Math.max(maxY, cloth);
    }
  }
  const headTop = anchor(rig, 'Head', new THREE.Vector3(head.x, top, head.z));

  // between the shoulder blades: the back's surface (−z), 40% of the way from Spine2 up to the neck
  const s3 = rig.pos(BONES.spine_03);
  const neck = rig.pos(BONES.neck_01);
  const by = THREE.MathUtils.lerp(s3.y, neck.y, 0.4);
  const backAt = cast(new THREE.Vector3(s3.x, by, s3.z - 1), new THREE.Vector3(0, 0, 1)) ?? new THREE.Vector3(s3.x, by, s3.z - 0.1);
  const back = anchor(rig, 'spine_03', backAt);

  // the top of the left shoulder, where a strap sits: halfway from the neck to the shoulder joint
  const ua = rig.pos(BONES.upperarm_l);
  const sx = THREE.MathUtils.lerp(neck.x, ua.x, 0.55);
  const sz = THREE.MathUtils.lerp(neck.z, ua.z, 0.55);
  // (from just above the neck joint, so the jaw and a hat brim are above the ray's start). Under a
  // headscarf or a keffiyeh that falls from the head like a tent the ray starts inside it and meets
  // nothing at shoulder height (the body is cut away beneath): then the highest point of the cloth
  // near there, from its vertices.
  const above = neck.y + 0.05;
  const below = neck.y - 0.15;
  let shoulderAt = cast(new THREE.Vector3(sx, above, sz), new THREE.Vector3(0, -1, 0));
  if (!shoulderAt || shoulderAt.y < below) {
    let sy = -Infinity;
    for (const { p } of [...person, ...verts.extra]) if (Math.hypot(p.x - sx, p.z - sz) < 0.035 && p.y < above && p.y > below) sy = Math.max(sy, p.y);
    shoulderAt = new THREE.Vector3(sx, Number.isFinite(sy) ? sy : neck.y - 0.02, sz);
  }
  const shoulderL = anchor(rig, 'clavicle_l', shoulderAt);

  // the palm: halfway from the wrist to the middle finger's knuckle, 1.5 cm towards the thumb's side
  const palm = (side) => {
    const hand = rig.pos(BONES[`hand_${side}`]);
    const mid = rig.pos(BONES[`middle_01_${side}`]);
    const thumb = rig.pos(`Bip01_${side.toUpperCase()}_Finger0`);
    const axis = mid.clone().sub(hand).normalize();
    const toThumb = thumb.clone().sub(hand);
    toThumb.addScaledVector(axis, -toThumb.dot(axis)).normalize();
    return anchor(rig, `hand_${side}`, hand.clone().lerp(mid, 0.5).addScaledVector(toThumb, 0.015));
  };

  return {
    parts,
    height: r4(maxY - minY),
    floor: r4(minY),
    hip: r4(hip),
    anchors: { headTop, back, shoulderL, palmL: palm('l'), palmR: palm('r') },
    extraTop: verts.extra.length ? r4(Math.max(...verts.extra.map((v) => v.p.y))) : null,
  };
}

/**
 * The furthest the seat goes below the pelvis joint, for a body 1.8 m tall: trousered adults
 * measure 0.14–0.155 m (men) and 0.15–0.178 m (women) (see measureSeat).
 */
const SEAT_DEPTH = 0.18;

/**
 * How high the seat is under someone sitting in `clip` (the seated idle), above the rig's origin:
 * the lowest point of the buttocks and upper thighs near the hips. The clip's hip height is
 * scaled to this avatar, as the game does. `height` is the avatar's (measureBind's).
 */
export function measureSeat(doc, clip, refHip, height) {
  const rig = rigOf(doc);
  const hip = rig.pos('Bip01').y;
  rig.pose(clip, 0, hip / refHip);
  const lod0 = doc.getRoot().listNodes().find((n) => n.getName() === 'LOD0');
  const parts = partsOf(doc);
  const pelvis = rig.pos(BONES.pelvis);
  const knees = rig.pos(BONES.calf_l).add(rig.pos(BONES.calf_r)).multiplyScalar(0.5);
  // forward along the thighs, from the hips towards the knees
  const fwd = knees.clone().sub(pelvis).setY(0).normalize();
  let low = Infinity;
  for (const prim of lod0.getMesh().listPrimitives()) {
    if (prim.getMaterial().getName() !== parts.body) continue;
    for (const { p, joint } of skinned(rig, lod0, prim)) {
      if (!/Pelvis|Spine$|Thigh/.test(joint)) continue;
      const d = p.clone().sub(pelvis).setY(0);
      const along = d.dot(fwd);
      const side = d.addScaledVector(fwd, -along).length();
      if (along > -0.2 && along < 0.15 && side < 0.2) low = Math.min(low, p.y);
    }
  }
  // the lowest point round the hips is the seat for trousers and shorts, but on a skirt or a long
  // dress it's the cloth hanging under the thighs (Female_Adult_06 came out 9 cm low): the seat is
  // never deeper below the pelvis joint than SEAT_DEPTH, scaled to the body
  const seat = Math.max(low, pelvis.y - SEAT_DEPTH * (height / 1.8));
  return { seatDrop: r4(seat), sitPelvis: r4(pelvis.y), hipForward: r4(pelvis.clone().setY(0).dot(fwd)), clothBelow: r4(seat - low) };
}

/**
 * The face's skin tone, from the head texture (the layout is shared by all Rocketbox heads): the
 * median colour of patches on both cheeks and the forehead, as CIE L* (0 black … 100 white).
 */
export async function skinTone(pngBuffer) {
  const img = sharp(pngBuffer).removeAlpha().resize(256, 256);
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const patches = [
    [0.4, 0.39],
    [0.6, 0.39],
    [0.5, 0.25],
    [0.44, 0.47],
    [0.56, 0.47],
  ];
  const ls = [];
  const rgbs = [];
  for (const [u, v] of patches) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = Math.round(u * 256) + dx;
        const y = Math.round(v * 256) + dy;
        const i = (y * 256 + x) * 3;
        const c = new THREE.Color().setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, THREE.SRGBColorSpace);
        // relative luminance (linear) → L*
        const Y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        ls.push(Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
        rgbs.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  ls.sort((a, b) => a - b);
  const L = ls[ls.length >> 1];
  const mid = rgbs.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]))[rgbs.length >> 1];
  const skin = L > 68 ? 1 : L > 60 ? 2 : L > 50 ? 3 : L > 38 ? 4 : 5;
  return { L: Math.round(L * 10) / 10, skin, colour: '#' + mid.map((x) => x.toString(16).padStart(2, '0')).join('') };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io = await gltfIO();
  for (const id of process.argv.slice(2)) {
    const file = join(WORK, id, 'base.glb');
    if (!existsSync(file)) {
      console.error(`${id}: no ${file} (run convert.mjs)`);
      continue;
    }
    const doc = await io.read(file);
    const m = measureBind(doc);
    const gender = AVATARS.find((x) => x.id === id)?.gender ?? (/Female|Girl/.test(id) ? 'f' : 'm');
    const seat = join(WORK, 'anim', `sit-${gender}.json`);
    const s = existsSync(seat) ? measureSeat(doc, readJson(seat).clip, readJson(seat).refHip, m.height) : null;
    console.log(id, JSON.stringify({ ...m, ...s }));
  }
}
