// Turns a MakeHuman person exported by makehuman-build.py (Blender, posed into the Biped's bind
// pose, skinned to MakeHuman's game_engine rig) into a Rocketbox-style avatar: the same Biped
// skeleton (names, hierarchy, rest rotations), so the game plays Rocketbox's clips on it as on any
// Rocketbox person (rig 'rocketbox'), and the same file layout as convert.mjs's.
//
//   node scripts/people/makehuman-post.mjs <id>        (normally run by makehuman.mjs)
//
// Reads .people-cache/makehuman/work/<id>.raw.glb + .raw.json + .job.json; writes
//   .people-cache/makehuman/work/<id>/base.glb   uncompressed, 1024 px PNG atlases, LOD0..2
//   public/models/people/<id>.crowd.glb          512 px KTX2, meshopt
//   .people-cache/meta/avatar-<id>.json          AvatarSpec (+ stats and the assets' licences)
//
// The skeleton: every Biped node keeps the Rocketbox rest rotation and only moves to where
// MakeHuman's matching joint is (the arms, legs, spine and fingers have one each). The 27 face
// bones have no MakeHuman counterpart: they're placed from the Rocketbox head scaled to this one
// (the eyes sit in the eyeballs, which they drive) and hold no skin. Weights carry over by bone.
//
// The materials follow Rocketbox's three: `<id>_head` the skin (MakeHuman's body-and-face
// texture), `<id>_body` an atlas of the clothes and shoes (where the outfit mask goes),
// `<id>_opacity` an atlas of the hair, brows, lashes and eyes, alpha-tested and two-sided.

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import sharp from 'sharp';
import { Document } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { cloneDocument, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { CACHE, META, OUT, basisu, ensureDir, gltfIO, readJson, sanitize, size, writeJson } from './lib.mjs';
import { BONES, rigOf, skinned } from './measure.mjs';
import { embedMask } from './masks.mjs';
import { hairTone } from './hair-tone.mjs';

export const MH = join(CACHE, 'makehuman');
const WORKDIR = join(MH, 'work');
const BASE_TEX = 1024;
const CROWD_TEX = 512;
/**
 * The clothes' normal map in the crowd file: UASTC (zstd), as convert.mjs's are, since ETC1S breaks
 * a normal map into 4×4 blocks that the lighting shows as a chequer on the cloth. At 256, as the
 * clothes atlas packs every garment into one map.
 */
const CROWD_NORMAL_TEX = 256;
const MASK_SIZE = 512;

/** Biped body bone → MakeHuman game_engine bone. */
const BIPED_TO_MH = { 'Bip01 Pelvis': 'pelvis', 'Bip01 Spine': 'spine_01', 'Bip01 Spine1': 'spine_02', 'Bip01 Spine2': 'spine_03', 'Bip01 Neck': 'neck_01', 'Bip01 Head': 'head' };
for (const [s, S] of [['l', 'L'], ['r', 'R']]) {
  Object.assign(BIPED_TO_MH, {
    [`Bip01 ${S} Clavicle`]: `clavicle_${s}`, [`Bip01 ${S} UpperArm`]: `upperarm_${s}`, [`Bip01 ${S} Forearm`]: `lowerarm_${s}`, [`Bip01 ${S} Hand`]: `hand_${s}`,
    [`Bip01 ${S} Thigh`]: `thigh_${s}`, [`Bip01 ${S} Calf`]: `calf_${s}`, [`Bip01 ${S} Foot`]: `foot_${s}`, [`Bip01 ${S} Toe0`]: `ball_${s}`,
  });
  ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((f, n) => {
    BIPED_TO_MH[`Bip01 ${S} Finger${n}`] = `${f}_01_${s}`;
    BIPED_TO_MH[`Bip01 ${S} Finger${n}1`] = `${f}_02_${s}`;
    BIPED_TO_MH[`Bip01 ${S} Finger${n}2`] = `${f}_03_${s}`;
  });
}
const MH_TO_BIPED = Object.fromEntries(Object.entries(BIPED_TO_MH).map(([b, m]) => [m, b]));
MH_TO_BIPED.Root = 'Bip01 Pelvis';

/**
 * LOD triangle budgets, about a Rocketbox person's (7.4k, then convert.mjs's halves): LOD0 is
 * simplified too, as MakeHuman's body alone is 17k triangles. `error` is meshoptimizer's limit,
 * relative to the person's size.
 */
const LODS = [
  { name: 'LOD0', tris: 9000, error: 0.01 },
  { name: 'LOD1', tris: 4500, error: 0.03 },
  { name: 'LOD2', tris: 1800, error: 0.08 },
];
const SIMPLIFIED = new Set(['skin', 'clothes', 'hair']);

const v3 = (a) => new THREE.Vector3(...a);
const q4 = (a) => new THREE.Quaternion(...a);
const r4 = (v) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------- reading the Blender export

/** Each mesh part as plain arrays, its MakeHuman joint names, and the joints' bind positions. */
async function readRaw(id) {
  const io = await gltfIO();
  const doc = await io.read(join(WORKDIR, `${id}.raw.glb`));
  await doc.transform(weld());
  const info = readJson(join(WORKDIR, `${id}.raw.json`));
  const root = doc.getRoot();
  const joints = new Map();
  for (const n of root.listNodes()) {
    const m = new THREE.Matrix4().fromArray(n.getWorldMatrix());
    joints.set(n.getName(), new THREE.Vector3().setFromMatrixPosition(m));
  }
  const parts = [];
  for (const n of root.listNodes()) {
    if (!n.getMesh()) continue;
    const meta = info.parts.find((p) => p.node === n.getName());
    if (!meta) throw new Error(`${id}: no part info for ${n.getName()}`);
    const names = n.getSkin().listJoints().map((j) => j.getName());
    for (const prim of n.getMesh().listPrimitives()) {
      const get = (s) => prim.getAttribute(s)?.getArray();
      const J = prim.getAttribute('JOINTS_0');
      const W = prim.getAttribute('WEIGHTS_0');
      const count = prim.getAttribute('POSITION').getCount();
      const joint = new Array(count * 4);
      const weight = new Float32Array(count * 4);
      const j = [], w = [];
      for (let i = 0; i < count; i++) {
        J.getElement(i, j);
        W.getElement(i, w);
        for (let c = 0; c < 4; c++) {
          joint[i * 4 + c] = names[j[c]];
          weight[i * 4 + c] = w[c];
        }
      }
      parts.push({ ...meta, pos: Float32Array.from(get('POSITION')), nrm: Float32Array.from(get('NORMAL')), uv: Float32Array.from(get('TEXCOORD_0')), joint, weight, idx: Uint32Array.from(prim.getIndices().getArray()) });
    }
  }
  return { info, parts, joints };
}

/** The bits of a MakeHuman .mhmat the atlas needs (texture paths are next to it). */
export function readMhmat(file) {
  const out = { file, dir: file.replace(/[\\/][^\\/]+$/, '') };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^(\w+)\s+(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'diffuseTexture') out.diffuse = join(out.dir, v.trim());
    else if (k === 'normalmapTexture') out.normal = join(out.dir, v.trim());
    else if (k === 'aomapTexture') out.ao = join(out.dir, v.trim());
    else if (k === 'backfaceCull') out.backfaceCull = !/false/i.test(v);
    else if (k === 'name') out.name = v.trim();
  }
  return out;
}

/**
 * Author and licence of a MakeHuman asset (.mhclo or .mhmat), from the listing in its pack's
 * `packs/` folder: every asset pack ships one, keyed by the asset's folder name (or, for the eye
 * colours in eyes/materials/, the file's own name).
 */
function licenceOf(file) {
  const dir = file.replace(/[\\/][^\\/]+$/, '');
  let name = dir.split(/[\\/]/).pop();
  if (name === 'materials') name = file.split(/[\\/]/).pop().replace(/\.\w+$/, '');
  const packs = join(dir.replace(/[\\/](clothes|hair|eyebrows|eyelashes|eyes|skins)([\\/].*)?$/, ''), 'packs');
  for (const f of existsSync(packs) ? readdirSync(packs).filter((f) => f.endsWith('.json')) : []) {
    const entry = readJson(join(packs, f))[name];
    if (entry) return { asset: name, author: entry.author, licence: entry.license, source: entry.source, pack: f.replace(/\.json$/, '') };
  }
  return { asset: name, author: 'unknown', licence: 'unknown' };
}

// ---------------------------------------------------------------- the skeleton

/**
 * The Biped, fitted: world positions from MakeHuman's joints (scaled and grounded like the mesh),
 * local rotations straight from the Rocketbox template. Returns nodes parent-first.
 */
function fitSkeleton(tpl, mhJoint, eyes) {
  const byName = new Map(tpl.joints.map((j) => [j.name, j]));
  const out = [];
  const world = new Map();
  // face bones: the Rocketbox head's layout, scaled by eye height above the head joint
  const tHead = v3(byName.get('Bip01 Head').wp);
  const tEyes = v3(byName.get('Bip01 LEye').wp).add(v3(byName.get('Bip01 REye').wp)).multiplyScalar(0.5);
  const mHead = mhJoint('head');
  const mEyes = eyes ? eyes.l.clone().add(eyes.r).multiplyScalar(0.5) : null;
  const faceScale = mEyes ? mEyes.distanceTo(mHead) / tEyes.distanceTo(tHead) : 0.8;
  const residual = {};
  for (const j of tpl.joints) {
    const parent = j.parent ? world.get(j.parent) : null;
    const pq = parent ? parent.q : new THREE.Quaternion();
    const q = pq.clone().multiply(q4(j.r));
    let p;
    if (j.name === 'Bip01') p = mhJoint('pelvis');
    else if (j.name === 'Bip01 Pelvis') p = parent.p.clone();
    else if (BIPED_TO_MH[j.name]) p = mhJoint(BIPED_TO_MH[j.name]);
    else if (eyes && j.name === 'Bip01 LEye') p = eyes.l.clone();
    else if (eyes && j.name === 'Bip01 REye') p = eyes.r.clone();
    else p = parent.p.clone().add(v3(j.t).multiplyScalar(faceScale).applyQuaternion(pq));
    const t = parent ? p.clone().sub(parent.p).applyQuaternion(pq.clone().invert()) : p.clone();
    world.set(j.name, { p, q });
    // how far off the Biped's own bone direction the fitted offset ended up (should be ~0)
    if (BIPED_TO_MH[j.name] && parent && j.t[0] > 0.01 && Math.abs(j.t[1]) + Math.abs(j.t[2]) < 0.2 * j.t[0]) {
      const a = v3(j.t).normalize();
      residual[j.name] = Math.round(THREE.MathUtils.radToDeg(a.angleTo(t.clone().normalize())) * 10) / 10;
    }
    out.push({ name: j.name, parent: j.parent, joint: j.joint, t: t.toArray().map(r4), r: j.r, world: new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)) });
  }
  return { nodes: out, residual, faceScale };
}

// ---------------------------------------------------------------- geometry

/** Simplifies a part's triangles (keeping UV and normal seams) and drops the vertices left unused. */
function simplifyPart(part, ratio, error) {
  const target = Math.max(3, Math.floor((part.idx.length / 3) * ratio) * 3);
  if (ratio >= 1 || target >= part.idx.length) return part;
  const n = part.pos.length / 3;
  const attrs = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) {
    attrs.set(part.nrm.subarray(i * 3, i * 3 + 3), i * 5);
    attrs.set(part.uv.subarray(i * 2, i * 2 + 2), i * 5 + 3);
  }
  const [idx] = MeshoptSimplifier.simplifyWithAttributes(part.idx, part.pos, 3, attrs, 5, [0.3, 0.3, 0.3, 1, 1], null, target, error, []);
  return compact({ ...part, idx });
}

function compact(part) {
  const map = new Int32Array(part.pos.length / 3).fill(-1);
  let k = 0;
  for (const i of part.idx) if (map[i] < 0) map[i] = k++;
  const take = (arr, w) => {
    const o = new arr.constructor(k * w);
    for (let i = 0; i < map.length; i++) if (map[i] >= 0) for (let c = 0; c < w; c++) o[map[i] * w + c] = arr[i * w + c];
    return o;
  };
  const joint = new Array(k * 4);
  for (let i = 0; i < map.length; i++) if (map[i] >= 0) for (let c = 0; c < 4; c++) joint[map[i] * 4 + c] = part.joint[i * 4 + c];
  return { ...part, pos: take(part.pos, 3), nrm: take(part.nrm, 3), uv: take(part.uv, 2), weight: take(part.weight, 4), joints: part.joints && take(part.joints, 4), joint, idx: part.idx.map((i) => map[i]) };
}

/** Area of a part's surface (m²), to share an atlas out by. */
function area(part) {
  let s = 0;
  const p = part.pos;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < part.idx.length; i += 3) {
    a.fromArray(p, part.idx[i] * 3);
    b.fromArray(p, part.idx[i + 1] * 3).sub(a);
    c.fromArray(p, part.idx[i + 2] * 3).sub(a);
    s += b.cross(c).length() / 2;
  }
  return s;
}

// ---------------------------------------------------------------- atlases

/** Splits a rectangle among weighted items, guillotine-style, on a 1/32 grid. */
function layout(items, x = 0, y = 0, w = 1, h = 1) {
  if (items.length === 1) return [{ key: items[0].key, x, y, w, h }];
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  const A = [], B = [];
  let wa = 0;
  for (const it of sorted) (wa <= total / 2 - it.weight / 2 ? (A.push(it), (wa += it.weight)) : B.push(it));
  if (!B.length) B.push(A.pop());
  const k = A.reduce((s, i) => s + i.weight, 0) / total;
  const snap = (v) => Math.min(0.97, Math.max(0.03, Math.round(v * 32) / 32));
  if (w >= h) {
    const wa2 = snap(k) * w;
    return [...layout(A, x, y, wa2, h), ...layout(B, x + wa2, y, w - wa2, h)];
  }
  const ha2 = snap(k) * h;
  return [...layout(A, x, y, w, ha2), ...layout(B, x, y + ha2, w, h - ha2)];
}

/**
 * Builds an atlas S px square from rects of source images: each image is squeezed into its rect,
 * less a few pixels of its own edge colour round it (so mipmaps don't bleed neighbours together).
 * Returns the PNG and the UV map.
 */
async function atlas(S, rects, sources, { channels = 3, background } = {}) {
  const pad = Math.max(2, Math.round(S / 256));
  const comps = [];
  const uvRect = {};
  for (const r of rects) {
    const src = sources[r.key];
    const px = { x: Math.round(r.x * S), y: Math.round(r.y * S), w: Math.round(r.w * S), h: Math.round(r.h * S) };
    const inner = { w: px.w - 2 * pad, h: px.h - 2 * pad };
    let img = src.image ? sharp(src.image, src.raw ? { raw: src.raw } : undefined) : sharp({ create: { width: 4, height: 4, channels: 4, background: src.fill } });
    const buf = await sharp(await img.png().toBuffer())
      .resize(inner.w, inner.h, { fit: 'fill', kernel: 'lanczos3' })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'copy' })
      .png()
      .toBuffer();
    comps.push({ input: buf, left: px.x, top: px.y });
    uvRect[r.key] = { x: (px.x + pad) / S, y: (px.y + pad) / S, w: inner.w / S, h: inner.h / S };
  }
  const base = sharp({ create: { width: S, height: S, channels: 4, background: background ?? { r: 128, g: 128, b: 128, alpha: 1 } } }).composite(comps);
  const png = channels === 4 ? await base.png().toBuffer() : await base.removeAlpha().png().toBuffer();
  return { png, uvRect };
}

/** MakeHuman UVs are 0..1 with v up (Blender's exporter already flipped v): squeeze into a rect. */
function remapUV(part, r) {
  const uv = new Float32Array(part.uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = r.x + Math.min(1, Math.max(0, part.uv[i])) * r.w;
    uv[i + 1] = r.y + Math.min(1, Math.max(0, part.uv[i + 1])) * r.h;
  }
  return { ...part, uv };
}

/**
 * A garment's colour map at the base size, its ambient occlusion multiplied in (people have no AO
 * map in the game) and any cut-outs (lace hems) filled with the nearest fabric colour, since the
 * body material is opaque: a lacy edge becomes a plain one.
 */
async function garmentColour(mat) {
  const size = Math.min(BASE_TEX, (await sharp(mat.diffuse).metadata()).width);
  const { data, info } = await sharp(mat.diffuse).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  fillCutOuts(data, info.width, info.height);
  let img = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).removeAlpha();
  if (mat.ao && existsSync(mat.ao)) {
    const base = await img.png().toBuffer();
    // softened: MakeHuman's AO maps are strong, and the scene's lighting adds its own
    const ao = await sharp(mat.ao).removeAlpha().greyscale().resize(size, size, { fit: 'fill' }).linear(0.6, 255 * 0.4).toColourspace('srgb').png().toBuffer();
    img = sharp(base).composite([{ input: ao, blend: 'multiply' }]);
  }
  return img.png().toBuffer();
}

/** Gives every see-through texel (alpha < 128) the colour of the nearest opaque one, in place. */
function fillCutOuts(rgba, w, h) {
  const queue = new Int32Array(w * h);
  const seen = new Uint8Array(w * h);
  let head = 0, tail = 0;
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] >= 128) { seen[i] = 1; queue[tail++] = i; }
  if (tail === w * h || tail === 0) return;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || seen[j]) continue;
      seen[j] = 1;
      rgba[j * 4] = rgba[i * 4]; rgba[j * 4 + 1] = rgba[i * 4 + 1]; rgba[j * 4 + 2] = rgba[i * 4 + 2]; rgba[j * 4 + 3] = 255;
      queue[tail++] = j;
    }
  }
}

/**
 * Greys, whitens or blackens hair ('grey', 'white', 'black'): each strand texel keeps its place
 * between the texture's darkest and lightest strands (5th to 95th percentile of luminance), mapped
 * onto that range with a faint warm cast, as real grey and black hair have.
 */
const HAIR_TINTS = { white: [150, 238], grey: [88, 200], black: [12, 62] };
async function tintHair(png, tint) {
  if (!tint) return png;
  if (!HAIR_TINTS[tint]) throw new Error(`unknown hair tint ${tint}`);
  const { data, info } = await sharp(png).resize(BASE_TEX, BASE_TEX, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const seen = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 128) seen.push(lum(i));
  seen.sort((x, y) => x - y);
  const lo = seen[Math.floor(seen.length * 0.05)] ?? 0;
  const hi = seen[Math.floor(seen.length * 0.95)] ?? 255;
  const [dark, light] = HAIR_TINTS[tint];
  for (let i = 0; i < data.length; i += 4) {
    const k = Math.min(1, Math.max(0, (lum(i) - lo) / Math.max(1, hi - lo)));
    const v = dark + k * (light - dark);
    data[i] = v;
    data[i + 1] = v * 0.985;
    data[i + 2] = v * 0.95;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** sRGB byte → linear light, and back. */
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (l) => Math.min(255, Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)));

/**
 * Iris colours that MakeHuman gets wrong for a crowd, as sharp modulate() settings by eye material:
 * its "brown" is a red-brown that reads as red eyes, turned to a natural dark brown.
 */
const EYE_FIX = { brown: { hue: 20, saturation: 0.6 } };

/**
 * Brows the crowd file can draw. MakeHuman's are fine strands on a card that the atlas shrinks
 * fourfold, where the alpha test breaks them into a jagged black line, so their alpha is blurred
 * into a soft band (raised so the band stays whole) and they take the hair's colour, darker, as
 * real brows do: a fair child doesn't get black ones, nor a white-haired woman white ones. `hair` is the hair
 * texture as it ships (tinted); without one the brows keep their own colour.
 */
async function softBrows(png, hair) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(data, { raw: info }).extractChannel(3).blur((3 * info.width) / 512).raw().toBuffer();
  let colour = null;
  const mean = hair && (await hairMean(hair));
  if (mean) {
    // brows are denser than a head of hair and catch less light: 60 % of its mean, in linear light,
    // and no lighter than a dark grey, as grey and white heads of hair keep darker brows
    const k = Math.min(0.6, 0.1 / Math.max(1e-4, 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]));
    colour = mean.map((v) => toSrgb(k * v));
  }
  for (let i = 0; i < alpha.length; i++) {
    data[i * 4 + 3] = Math.min(255, alpha[i] * 1.6);
    if (colour) for (let c = 0; c < 3; c++) data[i * 4 + c] = colour[c];
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

/** The mean colour (linear RGB) of a hair texture's strands (alpha over a half), or null. */
async function hairMean(png) {
  const h = await sharp(png).ensureAlpha().raw().toBuffer();
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < h.length; i += 4) {
    if (h[i + 3] < 128) continue;
    n++;
    for (let c = 0; c < 3; c++) sum[c] += lin(h[i + c]);
  }
  return n ? sum.map((v) => v / n) : null;
}

/**
 * Paints the scalp under the hair in the hair's colour, as Rocketbox's heads have it. MakeHuman's
 * skins are bare there, so wherever the head showed through the hair (a parting, the gaps between
 * strands, the holes that simplifying it for LOD1 and LOD2 opens) it showed as bright patches of
 * scalp. A head or neck vertex facing out of the head is under the hair when a ray out along its
 * normal meets a hair triangle within SCALP_REACH where the hair's texture is opaque (its alpha
 * blurred, so the gaps between strands count but the clear margin round a hair cap doesn't); the
 * weights are smoothed over neighbouring vertices so the painted edge is soft, and the texels take
 * the hair's mean colour, darker, as the scalp is in the hair's shade.
 *
 * `skin`, `hairs`: parts in the bind pose with their final weights (`joints` are skin joint
 * indices); `atlas`: the hair atlas the hairs' UVs point into; `heads`: the head and neck joints.
 */
const SCALP_REACH = 0.025;
async function paintScalp(skinPng, skin, hairs, atlas, hairPng, heads) {
  const colour = hairs.length && hairPng && (await hairMean(hairPng));
  if (!colour) return skinPng;
  const shade = colour.map((v) => v * 0.7);
  const { width: aw } = await sharp(atlas).metadata();
  const { data: a, info: ai } = await sharp(atlas).ensureAlpha().extractChannel(3).blur(aw / 128).raw().toBuffer({ resolveWithObject: true });
  const coverAt = (u, v) => a[Math.min(ai.height - 1, Math.max(0, Math.floor(v * ai.height))) * ai.width + Math.min(ai.width - 1, Math.max(0, Math.floor(u * ai.width)))] / 255;

  // the hair's triangles, for the rays
  const tris = [];
  for (const h of hairs)
    for (let t = 0; t < h.idx.length; t += 3) {
      const [i, j, k] = [h.idx[t], h.idx[t + 1], h.idx[t + 2]];
      const p0 = new THREE.Vector3().fromArray(h.pos, i * 3);
      tris.push({ p0, e1: new THREE.Vector3().fromArray(h.pos, j * 3).sub(p0), e2: new THREE.Vector3().fromArray(h.pos, k * 3).sub(p0), uv: [i, j, k].map((v) => [h.uv[v * 2], h.uv[v * 2 + 1]]) });
    }

  // which skin vertices belong to the head and neck, and the head's middle
  const n = skin.pos.length / 3;
  const onHead = new Uint8Array(n);
  const centre = new THREE.Vector3();
  let count = 0;
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (let c = 0; c < 4; c++) if (heads.has(skin.joints[i * 4 + c])) w += skin.weight[i * 4 + c];
    if (w < 0.5) continue;
    onHead[i] = 1;
    centre.add(new THREE.Vector3().fromArray(skin.pos, i * 3));
    count++;
  }
  if (!count) return skinPng;
  centre.divideScalar(count);

  // a ray out along each head vertex's normal (Möller–Trumbore), weighted by the hair's cover where it lands
  const weight = new Float32Array(n);
  const o = new THREE.Vector3(), d = new THREE.Vector3(), out = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (!onHead[i]) continue;
    o.fromArray(skin.pos, i * 3);
    d.fromArray(skin.nrm, i * 3).normalize();
    if (d.dot(out.copy(o).sub(centre).normalize()) <= 0) continue;
    let best = SCALP_REACH;
    let cover = 0;
    for (const t of tris) {
      pv.crossVectors(d, t.e2);
      const det = t.e1.dot(pv);
      if (Math.abs(det) < 1e-12) continue;
      tv.copy(o).sub(t.p0);
      const u = tv.dot(pv) / det;
      if (u < 0 || u > 1) continue;
      qv.crossVectors(tv, t.e1);
      const v = d.dot(qv) / det;
      if (v < 0 || u + v > 1) continue;
      const dist = t.e2.dot(qv) / det;
      if (dist < 0 || dist >= best) continue;
      best = dist;
      const w0 = 1 - u - v;
      cover = coverAt(w0 * t.uv[0][0] + u * t.uv[1][0] + v * t.uv[2][0], w0 * t.uv[0][1] + u * t.uv[1][1] + v * t.uv[2][1]);
    }
    weight[i] = THREE.MathUtils.smoothstep(cover, 0.15, 0.55);
  }
  // soften the edge: two passes of averaging each vertex with its neighbours
  const nbrs = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < skin.idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      nbrs[skin.idx[t + k]].add(skin.idx[t + ((k + 1) % 3)]);
      nbrs[skin.idx[t + k]].add(skin.idx[t + ((k + 2) % 3)]);
    }
  for (let pass = 0; pass < 2; pass++) {
    const prev = weight.slice();
    for (let i = 0; i < n; i++) {
      if (!onHead[i]) continue;
      let s = prev[i];
      for (const j of nbrs[i]) s += prev[j];
      weight[i] = s / (nbrs[i].size + 1);
    }
  }

  // paint: each skin triangle with any weight, its texels blended towards the shade by the weight there
  const { data, info } = await sharp(skinPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const S = info.width;
  const paint = new Float32Array(S * info.height);
  for (let t = 0; t < skin.idx.length; t += 3) {
    const [i, j, k] = [skin.idx[t], skin.idx[t + 1], skin.idx[t + 2]];
    if (!(weight[i] || weight[j] || weight[k])) continue;
    const P = [i, j, k].map((v) => [skin.uv[v * 2] * S, skin.uv[v * 2 + 1] * info.height]);
    const area2 = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(area2) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
    const x1 = Math.min(S - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
    const y1 = Math.min(info.height - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const [px, py] = [x + 0.5, y + 0.5];
        const b0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area2;
        const b1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area2;
        const b2 = 1 - b0 - b1;
        // a texel's width of slack, so seams between triangles get painted too
        if (b0 < -0.02 || b1 < -0.02 || b2 < -0.02) continue;
        const w = Math.max(0, b0 * weight[i] + b1 * weight[j] + b2 * weight[k]);
        paint[y * S + x] = Math.max(paint[y * S + x], w);
      }
  }
  for (let p = 0; p < paint.length; p++) {
    const w = Math.min(0.95, paint[p]);
    if (w <= 0) continue;
    for (let c = 0; c < 3; c++) data[p * 3 + c] = toSrgb(lin(data[p * 3 + c]) * (1 - w) + shade[c] * w);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

/**
 * Scales the skin texture's channels (in linear light) so its middle tones average `target`
 * ('#rrggbb'), keeping its own shading and detail. MakeHuman's darker skins are far redder than
 * Rocketbox's people under the same light (old_african_female's red is five times its green,
 * Rocketbox's deep browns about two and a half) and its light ones a little paler and pinker. The
 * middle tones are the texels between the 35th and 75th percentiles of brightness: the body's
 * skin, not the hair painted on the scalp, the lips or the nails.
 */
async function matchSkin(png, target) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  if (!target) return png;
  const hist = new Uint32Array(766);
  for (let i = 0; i < n; i++) hist[data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2]]++;
  const at = (q) => {
    let seen = 0;
    for (let b = 0; b < hist.length; b++) if ((seen += hist[b]) >= n * q) return b;
    return hist.length - 1;
  };
  const [lo, hi] = [at(0.35), at(0.75)];
  const mean = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const s = data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2];
    if (s < lo || s > hi) continue;
    for (let c = 0; c < 3; c++) mean[c] += lin(data[i * 3 + c]);
    count++;
  }
  const lut = [1, 3, 5].map((k, c) => {
    const gain = lin(parseInt(target.slice(k, k + 2), 16)) / (mean[c] / count);
    return Uint8Array.from({ length: 256 }, (_, v) => toSrgb(lin(v) * gain));
  });
  for (let i = 0; i < n * 3; i++) data[i] = lut[i % 3][data[i]];
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

// ---------------------------------------------------------------- outfit mask

const REGION_INDEX = { top: 0, bottom: 1, shoes: 2, trim: 3 };

/** Which region a garment triangle belongs to, by the body part its vertices hang off. */
function regionOfTriangle(part, t) {
  let top = 0, bottom = 0, shoes = 0;
  for (let k = 0; k < 3; k++) {
    const v = part.idx[t + k];
    for (let c = 0; c < 4; c++) {
      const j = part.joint[v * 4 + c];
      const w = part.weight[v * 4 + c];
      if (!w || !j) continue;
      if (/^(foot|ball)_/.test(j)) shoes += w;
      else if (/^(pelvis|Root|thigh|calf)/.test(j)) bottom += w;
      else top += w;
    }
  }
  return shoes > top && shoes > bottom ? 'shoes' : bottom > top ? 'bottom' : 'top';
}

/**
 * The outfit mask in the body atlas's UV space: whole garments for tops, bottoms and shoes; a
 * one-piece outfit ('auto', e.g. dungarees over a tee, a blouse sewn to a skirt) split by UV
 * island, each island going to the region most of its triangles hang off. Also each region's mean
 * linear luminance and colour in the atlas, as masks.mjs reports them.
 */
async function outfitMask(garments, atlasPng) {
  const S = MASK_SIZE;
  const label = new Int8Array(S * S).fill(-1);
  const covered = new Uint8Array(S * S);
  for (const g of garments) {
    const islands = g.region === 'auto' ? islandsOf(g.part) : null;
    const islandRegion = new Map();
    if (islands) {
      const votes = new Map();
      for (let t = 0; t < g.part.idx.length; t += 3) {
        const isl = islands[g.part.idx[t]];
        const v = votes.get(isl) ?? { top: 0, bottom: 0, shoes: 0 };
        v[regionOfTriangle(g.part, t)]++;
        votes.set(isl, v);
      }
      for (const [isl, v] of votes) islandRegion.set(isl, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]);
    }
    for (let t = 0; t < g.part.idx.length; t += 3) {
      const region = islands ? islandRegion.get(islands[g.part.idx[t]]) : g.region;
      raster(g.part, t, S, (o) => {
        label[o] = REGION_INDEX[region];
        covered[o] = 1;
      });
    }
    // single-region garments own their whole rect (gutters too, for filtering)
    if (!islands) {
      const r = g.rect;
      for (let y = Math.floor(r.y * S); y < Math.ceil((r.y + r.h) * S); y++) for (let x = Math.floor(r.x * S); x < Math.ceil((r.x + r.w) * S); x++) label[y * S + x] = REGION_INDEX[g.region];
    }
  }
  // grow labels into the uncovered texels round the islands
  for (let ring = 0; ring < 12; ring++) {
    const next = label.slice();
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const o = y * S + x;
      if (label[o] >= 0) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < S && yy < S && label[yy * S + xx] >= 0) { next[o] = label[yy * S + xx]; break; }
      }
    }
    label.set(next);
  }
  const rgba = new Uint8Array(S * S * 4);
  for (let o = 0; o < S * S; o++) if (label[o] >= 0) rgba[o * 4 + label[o]] = 255;

  // region stats from the colour atlas, on covered texels only
  const { data } = await sharp(atlasPng).removeAlpha().resize(S, S, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
  const regions = {};
  for (const [name, i] of Object.entries(REGION_INDEX)) {
    let n = 0, sl = 0, sr = 0, sg = 0, sb = 0;
    for (let o = 0; o < S * S; o++) {
      if (label[o] !== i || !covered[o]) continue;
      const r = lin(data[o * 3]), g = lin(data[o * 3 + 1]), b = lin(data[o * 3 + 2]);
      n++; sl += 0.2126 * r + 0.7152 * g + 0.0722 * b; sr += r; sg += g; sb += b;
    }
    if (n < S * S * 0.002) continue;
    regions[name] = { mean: r4(sl / n), colour: '#' + [sr, sg, sb].map((v) => Math.min(255, toSrgb(v / n)).toString(16).padStart(2, '0')).join('') };
  }
  return { size: S, rgba, regions };
}

/** Connected UV islands (by shared vertices) of a part: island id per vertex. */
function islandsOf(part) {
  const n = part.pos.length / 3;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (let i = 0; i < part.idx.length; i += 3) {
    const a = find(part.idx[i]);
    parent[find(part.idx[i + 1])] = a;
    parent[find(part.idx[i + 2])] = a;
  }
  return Int32Array.from({ length: n }, (_, i) => find(i));
}

/** Calls `fill(texel)` for the texels a triangle covers in UV space. */
function raster(part, t, S, fill) {
  const P = [0, 1, 2].map((k) => [part.uv[part.idx[t + k] * 2] * S, part.uv[part.idx[t + k] * 2 + 1] * S]);
  const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
  const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
  const area2 = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
  if (Math.abs(area2) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area2;
    const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area2;
    const w2 = 1 - w0 - w1;
    if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) fill(y * S + x);
  }
}

// ---------------------------------------------------------------- KTX2 (as convert.mjs does)

/**
 * The outfit mask at half size for the crowd file, as convert.mjs's crowd masks are: it is RGBA8
 * on the GPU (1.4 MB at 512 with mipmaps, 0.35 MB at 256). A 2×2 box filter, not sharp's resize,
 * which would premultiply by A (the trim channel) and lose R, G and B where it is 0.
 */
async function halveMask(png) {
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const size = W / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++) {
        const at = (dx, dy) => data[((2 * y + dy) * W + 2 * x + dx) * 4 + c];
        out[(y * size + x) * 4 + c] = Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
      }
  return { size, png: new Uint8Array(await sharp(out, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer()) };
}

async function ktx2(dir, name, png, kind, px) {
  const out = join(dir, `${name}_${px}.ktx2`);
  const src = join(dir, `${name}_${px}.png`);
  await sharp(png).resize(px, px, { kernel: 'lanczos3' }).png().toFile(src);
  // colour: ETC1S at basisu's best (its -quality tops out at 100); normals: UASTC, rate-distortion
  // tuned as convert.mjs's are
  const args = kind === 'normal'
    ? ['-ktx2', '-uastc', '-uastc_level', '2', '-uastc_rdo_l', '10', '-mipmap', '-normal_map', '-mip_renorm']
    : ['-ktx2', '-etc1s', '-mipmap', '-quality', '100', '-effort', '4'];
  await basisu(dir, [...args, `${name}_${px}.png`, '-output_file', `${name}_${px}.ktx2`]);
  rmSync(src);
  const data = readFileSync(out);
  rmSync(out);
  return data;
}

// ---------------------------------------------------------------- the whole thing

export async function postProcess(id) {
  await MeshoptSimplifier.ready;
  const t0 = Date.now();
  const job = readJson(join(WORKDIR, `${id}.job.json`));
  const tpl = readJson(job.template);
  const { info, parts: rawParts, joints } = await readRaw(id);

  // ---- scale to the cast's height and stand on the floor
  const s = job.height ? job.height / info.height : 1;
  let floor = Infinity;
  for (const p of rawParts) if (p.kind === 'skin' || p.kind === 'clothes') for (let i = 1; i < p.pos.length; i += 3) floor = Math.min(floor, p.pos[i] * s);
  const place = (v) => v.clone().multiplyScalar(s).add(new THREE.Vector3(0, -floor, 0));
  for (const p of rawParts) for (let i = 0; i < p.pos.length; i += 3) {
    p.pos[i] *= s;
    p.pos[i + 1] = p.pos[i + 1] * s - floor;
    p.pos[i + 2] *= s;
  }
  const mhJoint = (name) => {
    const v = joints.get(name);
    if (!v) throw new Error(`${id}: MakeHuman joint ${name} missing`);
    return place(v);
  };
  const eyes = info.eyes?.l ? { l: place(v3(info.eyes.l)), r: place(v3(info.eyes.r)) } : null;
  const skel = fitSkeleton(tpl, mhJoint, eyes);
  const jointNames = skel.nodes.filter((n) => n.joint).map((n) => n.name);
  const jointIndex = new Map(jointNames.map((n, i) => [n, i]));

  // ---- weights onto the Biped (eyeballs onto the eye bones, for look-at)
  for (const p of rawParts) {
    const n = p.pos.length / 3;
    p.joints = new Uint16Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (p.kind === 'eyes') {
        p.joints[i * 4] = jointIndex.get(p.pos[i * 3] > 0 ? 'Bip01 LEye' : 'Bip01 REye');
        p.weight.set([1, 0, 0, 0], i * 4);
        continue;
      }
      const acc = new Map();
      for (let c = 0; c < 4; c++) {
        const w = p.weight[i * 4 + c];
        if (!w) continue;
        const b = MH_TO_BIPED[p.joint[i * 4 + c]];
        if (!b) throw new Error(`${id}: no Biped bone for ${p.joint[i * 4 + c]}`);
        const k = jointIndex.get(b);
        acc.set(k, (acc.get(k) ?? 0) + w);
      }
      const list = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = list.reduce((t, [, w]) => t + w, 0) || 1;
      for (let c = 0; c < 4; c++) {
        p.joints[i * 4 + c] = list[c]?.[0] ?? 0;
        p.weight[i * 4 + c] = list[c] ? list[c][1] / sum : 0;
      }
    }
  }

  // ---- materials and atlases (1024 px; the crowd file shrinks them)
  for (const p of rawParts) p.mat = readMhmat(p.mhmat);
  const skinPart = rawParts.find((p) => p.kind === 'skin');
  const garments = rawParts.filter((p) => p.kind === 'clothes');
  const fuzz = rawParts.filter((p) => ['hair', 'eyebrows', 'eyelashes', 'eyes'].includes(p.kind));
  for (const g of garments) {
    const name = g.mhclo.replace(/[\\/][^\\/]+$/, '').split(/[\\/]/).pop();
    g.region = job.regions?.[name] ?? (/shoe|flat|boot|t-bar|sandal/i.test(name) ? 'shoes' : 'auto');
    g.key = name;
  }

  const workDir = ensureDir(join(WORKDIR, id));
  const bodyRects = layout(garments.map((g) => ({ key: g.key, weight: area(g) ** 0.85 + (g.region === 'shoes' ? 0.02 : 0) })));
  const bodySrc = {};
  for (const g of garments) bodySrc[g.key] = { image: await garmentColour(g.mat) };
  const bodyAtlas = await atlas(BASE_TEX, bodyRects, bodySrc);
  const hasNormals = garments.some((g) => g.mat.normal && existsSync(g.mat.normal));
  const bodyNormal = hasNormals
    ? await atlas(BASE_TEX, bodyRects, Object.fromEntries(garments.map((g) => [g.key, g.mat.normal && existsSync(g.mat.normal) ? { image: g.mat.normal } : { fill: { r: 128, g: 128, b: 255, alpha: 1 } }])))
    : null;
  for (const g of garments) Object.assign(g, remapUV(g, bodyAtlas.uvRect[g.key]));

  // hair takes most of its atlas; brows, lashes and eyes share a column
  const fuzzRects = [
    { key: 'hair', x: 0, y: 0, w: 0.75, h: 1 },
    { key: 'eyes', x: 0.75, y: 0, w: 0.25, h: 0.25 },
    { key: 'eyebrows', x: 0.75, y: 0.25, w: 0.25, h: 0.25 },
    { key: 'eyelashes', x: 0.75, y: 0.5, w: 0.25, h: 0.5 },
  ].filter((r) => fuzz.some((p) => p.kind === r.key));
  const fuzzSrc = {};
  for (const p of fuzz) {
    let img = sharp(p.mat.diffuse).ensureAlpha();
    // the eyeballs are solid: their texture's alpha is for MakeHuman's cornea blending
    if (p.kind === 'eyes') {
      const fix = EYE_FIX[p.mhmat.split(/[\\/]/).pop().replace(/\.mhmat$/, '')];
      const solid = await sharp(p.mat.diffuse).removeAlpha().png().toBuffer();
      img = sharp(fix ? await sharp(solid).modulate(fix).png().toBuffer() : solid).ensureAlpha(1);
    }
    fuzzSrc[p.kind] = { image: p.kind === 'hair' ? await tintHair(await img.png().toBuffer(), job.hairTint) : await img.png().toBuffer() };
  }
  if (fuzzSrc.eyebrows) fuzzSrc.eyebrows.image = await softBrows(fuzzSrc.eyebrows.image, fuzzSrc.hair?.image);
  const fuzzAtlas = await atlas(BASE_TEX, fuzzRects, fuzzSrc, {
    channels: 4,
    background: { r: 60, g: 45, b: 35, alpha: 0 },
  });
  for (const p of fuzz) Object.assign(p, remapUV(p, fuzzAtlas.uvRect[p.kind]));
  // MakeHuman's skins brought to the colour of Rocketbox people of the same tone (see matchSkin)
  const matched = await matchSkin(await sharp(skinPart.mat.diffuse).removeAlpha().resize(BASE_TEX, BASE_TEX, { kernel: 'lanczos3' }).png().toBuffer(), job.skinColour);
  // and the scalp under the hair painted the hair's colour (see paintScalp)
  const heads = new Set(['Bip01 Head', 'Bip01 Neck'].map((b) => jointIndex.get(b)));
  const skinPng = await paintScalp(matched, skinPart, fuzz.filter((p) => p.kind === 'hair'), fuzzAtlas.png, fuzzSrc.hair?.image, heads);

  // ---- the document
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  const nodes = new Map();
  for (const n of skel.nodes) {
    const node = doc.createNode(sanitize(n.name)).setTranslation(n.t).setRotation(n.r);
    nodes.set(n.name, node);
    if (n.parent) nodes.get(n.parent).addChild(node);
    else scene.addChild(node);
  }
  const ibm = new Float32Array(jointNames.length * 16);
  skel.nodes.filter((n) => n.joint).forEach((n, i) => ibm.set(n.world.clone().invert().elements, i * 16));
  const skin = doc.createSkin('skin').setSkeleton(nodes.get('Bip01 Pelvis'));
  for (const n of jointNames) skin.addJoint(nodes.get(n));
  skin.setInverseBindMatrices(doc.createAccessor('ibm').setType('MAT4').setArray(ibm).setBuffer(buffer));

  const tex = (name, png) => doc.createTexture(name).setImage(new Uint8Array(png)).setMimeType('image/png').setURI(`${name}.png`);
  const material = (name) => doc.createMaterial(name).setMetallicFactor(0).setRoughnessFactor(0.82).setBaseColorFactor([1, 1, 1, 1]);
  const mats = {
    head: material(`${id}_head`).setBaseColorTexture(tex(`${id}_skin`, skinPng)),
    body: material(`${id}_body`).setBaseColorTexture(tex(`${id}_clothes`, bodyAtlas.png)).setDoubleSided(garments.some((g) => g.mat.backfaceCull === false)),
    opacity: material(`${id}_opacity`).setBaseColorTexture(tex(`${id}_hair`, fuzzAtlas.png)).setAlphaMode('MASK').setAlphaCutoff(0.4).setDoubleSided(true),
  };
  if (bodyNormal) mats.body.setNormalTexture(tex(`${id}_clothes_normal`, bodyNormal.png));

  const groupOf = (p) => (p.kind === 'skin' ? 'head' : p.kind === 'clothes' ? 'body' : 'opacity');
  const tris = [];
  const partTris = {};
  const lodParts = [];
  for (const lod of LODS) {
    const mesh = doc.createMesh(lod.name);
    // one ratio for the body, the clothes and the hair (a little more of the hair: it's the
    // silhouette) to land on the budget; eyes, brows and lashes are too small to simplify
    const kept = rawParts.filter((p) => p.kind !== 'seat' && !(lod.name === 'LOD2' && p.kind === 'eyelashes'));
    const small = kept.filter((p) => !SIMPLIFIED.has(p.kind)).reduce((t, p) => t + p.idx.length / 3, 0);
    const big = kept.filter((p) => SIMPLIFIED.has(p.kind)).reduce((t, p) => t + (p.idx.length / 3) * (p.kind === 'hair' ? 1.3 : 1), 0);
    let ratio = Math.min(1, (lod.tris - small) / big);
    let lp;
    // the simplifier stops short of the target where its error limit holds it: aim lower and retry
    for (let tries = 0; tries < 4; tries++) {
      lp = kept.map((p) => (SIMPLIFIED.has(p.kind) ? simplifyPart(p, Math.min(1, ratio * (p.kind === 'hair' ? 1.3 : 1)), lod.error) : p));
      const total = lp.reduce((t, p) => t + p.idx.length / 3, 0);
      if (total <= lod.tris * 1.03) break;
      ratio *= (lod.tris - small) / (total - small);
    }
    lodParts.push(lp);
    for (const p of lp) (partTris[p.key ?? p.kind] ??= []).push(p.idx.length / 3);
    let count = 0;
    for (const group of ['body', 'head', 'opacity']) {
      const members = lp.filter((p) => groupOf(p) === group);
      if (!members.length) continue;
      const nv = members.reduce((t, p) => t + p.pos.length / 3, 0);
      const ni = members.reduce((t, p) => t + p.idx.length, 0);
      const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), J = new Uint16Array(nv * 4), W = new Float32Array(nv * 4), I = new Uint32Array(ni);
      let vo = 0, io = 0;
      for (const p of members) {
        const n = p.pos.length / 3;
        P.set(p.pos, vo * 3); N.set(p.nrm, vo * 3); U.set(p.uv, vo * 2); J.set(p.joints, vo * 4); W.set(p.weight, vo * 4);
        for (let k = 0; k < p.idx.length; k++) I[io + k] = p.idx[k] + vo;
        vo += n;
        io += p.idx.length;
      }
      const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', acc('VEC3', P)).setAttribute('NORMAL', acc('VEC3', N)).setAttribute('TEXCOORD_0', acc('VEC2', U))
        .setAttribute('JOINTS_0', acc('VEC4', J)).setAttribute('WEIGHTS_0', acc('VEC4', W))
        .setIndices(acc('SCALAR', I)).setMaterial(mats[group]);
      mesh.addPrimitive(prim);
      count += ni / 3;
    }
    tris.push(count);
    scene.addChild(doc.createNode(lod.name).setMesh(mesh).setSkin(skin));
  }

  // ---- outfit mask (on LOD0's garments)
  const lod0Garments = lodParts[0].filter((p) => p.kind === 'clothes').map((p) => ({ part: p, region: garments.find((g) => g.key === p.key).region, rect: bodyAtlas.uvRect[p.key] }));
  const mask = await outfitMask(lod0Garments, bodyAtlas.png);
  await embedMask(doc, `${id}_body`, mask);

  const io = await gltfIO();
  const basePath = join(workDir, 'base.glb');
  await io.write(basePath, doc);

  // ---- measurements
  const bind = measure(doc);
  const hair = await hairTone(doc, { hair: `${id}_opacity` }, { tags: job.tags });
  const sitFile = join(CACHE, 'work', 'anim', `sit-${job.gender}.json`);
  let seat = null;
  if (existsSync(sitFile)) {
    const sit = readJson(sitFile);
    seat = measureSeatBare(doc, sit.clip, sit.refHip, rawParts.find((p) => p.kind === 'seat'));
  }

  // ---- the crowd file: KTX2 at 512 (the mask stays a lossless PNG, halved), meshopt
  const crowd = cloneDocument(doc);
  crowd.createExtension(KHRTextureBasisu).setRequired(true);
  const ktxDir = ensureDir(join(workDir, 'ktx'));
  let gpu = 0;
  const normals = new Set(crowd.getRoot().listMaterials().map((m) => m.getNormalTexture()).filter(Boolean));
  for (const t of crowd.getRoot().listTextures()) {
    if (t.getName() === 'outfitMask') {
      const mask = await halveMask(t.getImage());
      t.setImage(mask.png);
      gpu += mask.size * mask.size * 4 * (4 / 3);
      continue;
    }
    const px = normals.has(t) ? CROWD_NORMAL_TEX : CROWD_TEX;
    const data = await ktx2(ktxDir, t.getName(), Buffer.from(t.getImage()), normals.has(t) ? 'normal' : 'colour', px);
    t.setImage(data).setMimeType('image/ktx2').setURI(`${t.getName()}.ktx2`);
    gpu += px * px * (4 / 3);
  }
  await crowd.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'high', quantizationVolume: 'scene' }));
  ensureDir(OUT);
  const crowdFile = join(OUT, `${id}.crowd.glb`);
  await io.write(crowdFile, crowd);
  rmSync(ktxDir, { recursive: true, force: true });

  const assets = [
    { kind: 'body', asset: 'makehuman base mesh, targets and game_engine rig (MPFB 2)', author: 'MakeHuman team', licence: 'CC0' },
    ...rawParts.filter((p) => p.kind !== 'seat').map((p) => ({ kind: p.kind, ...licenceOf(p.mhclo ?? p.mhmat) })),
    ...rawParts.filter((p) => p.kind === 'eyes').map((p) => ({ kind: 'eye colour', ...licenceOf(p.mhmat) })),
  ];
  const spec = {
    id,
    source: 'makehuman',
    rig: 'rocketbox',
    gender: job.gender,
    age: job.age,
    skin: job.skinTone,
    roles: job.roles,
    tags: job.tags,
    files: { crowd: `${id}.crowd.glb` },
    bytes: { crowd: size(crowdFile) },
    lods: LODS.length,
    height: bind.height,
    hip: bind.hip,
    seatDrop: seat?.seatDrop ?? Math.round((bind.hip * 0.53 - 0.07) * 1000) / 1000,
    anchors: bind.anchors,
    parts: { body: `${id}_body`, head: `${id}_head`, hair: `${id}_opacity` },
    outfit: { regions: mask.regions },
    ...(hair ? { hairTone: { mean: hair.mean, colour: hair.colour } } : {}),
    ...(existsSync(join(OUT, 'portraits', `${id}.webp`)) ? { portrait: `portraits/${id}.webp` } : {}),
    // for the report, the credits and the review sheet, not the manifest
    stats: {
      tris,
      partTris,
      floor: bind.floor,
      gpuBytes: { crowd: Math.round(gpu) },
      seat,
      ageYears: job.ageYears,
      scale: r4(s),
      faceScale: r4(skel.faceScale),
      boneResidualDeg: skel.residual,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    },
    assets,
  };
  writeJson(join(META, `avatar-${id}.json`), spec);
  return spec;
}

/**
 * measure.mjs's seat (the lowest point of the buttocks and upper thighs in the seated idle), taken
 * on the bare body: Blender exports a copy of it with the skin under the clothes kept. Skirts and
 * dresses follow the thighs rigidly, so seated their hems hang far below where the person sits,
 * and MakeHuman deletes the skin under them; trousers add only a few millimetres.
 */
function measureSeatBare(doc, clip, refHip, body) {
  const rig = rigOf(doc);
  const hip = rig.pos('Bip01').y;
  rig.pose(clip, 0, hip / refHip);
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices();
  const mats = joints.map((j, i) => new THREE.Matrix4().fromArray(ibm.getElement(i, [])).premultiply(rig.world(j)));
  const pelvis = rig.pos(BONES.pelvis);
  const knees = rig.pos(BONES.calf_l).add(rig.pos(BONES.calf_r)).multiplyScalar(0.5);
  const fwd = knees.clone().sub(pelvis).setY(0).normalize();
  const v = new THREE.Vector3(), p = new THREE.Vector3(), t = new THREE.Vector3();
  let seat = Infinity;
  for (let i = 0; i < body.pos.length / 3; i++) {
    const main = joints[body.joints[i * 4]].getName();
    if (!/Pelvis|Spine$|Thigh/.test(main)) continue;
    v.fromArray(body.pos, i * 3);
    p.set(0, 0, 0);
    for (let c = 0; c < 4; c++) if (body.weight[i * 4 + c]) p.addScaledVector(t.copy(v).applyMatrix4(mats[body.joints[i * 4 + c]]), body.weight[i * 4 + c]);
    const d = p.clone().sub(pelvis).setY(0);
    const along = d.dot(fwd);
    const side = d.addScaledVector(fwd, -along).length();
    if (along > -0.2 && along < 0.15 && side < 0.2) seat = Math.min(seat, p.y);
  }
  return { seatDrop: r4(seat), sitPelvis: r4(pelvis.y), hipForward: r4(pelvis.clone().setY(0).dot(fwd)) };
}

/**
 * measure.mjs's bind measurements, with the back and shoulder found on skin as well as clothes
 * (a halter dress leaves the shoulders bare, where Rocketbox's measure only looks at the clothes).
 */
function measure(doc) {
  const rig = rigOf(doc);
  const lod0 = doc.getRoot().listNodes().find((n) => n.getName() === 'LOD0');
  const verts = { body: [], head: [], hair: [] };
  for (const prim of lod0.getMesh().listPrimitives()) {
    const key = prim.getMaterial().getName().replace(/^.*_(\w+)$/, '$1');
    verts[key === 'opacity' ? 'hair' : key].push(...skinned(rig, lod0, prim));
  }
  const person = [...verts.body, ...verts.head, ...verts.hair];
  const minY = Math.min(...person.map((v) => v.p.y));
  const maxY = Math.max(...person.map((v) => v.p.y));
  const anchor = (canonical, point) => {
    const p = point.clone().applyMatrix4(rig.world(BONES[canonical]).clone().invert());
    return { bone: canonical, at: [r4(p.x), r4(p.y), r4(p.z)] };
  };
  const head = rig.pos(BONES.Head);
  const headR = Math.max(0.045, 0.07 * (maxY - minY) / 1.75);
  let top = -Infinity;
  for (const { p } of person) if (Math.hypot(p.x - head.x, p.z - head.z) < headR) top = Math.max(top, p.y);
  const torso = [...verts.body, ...verts.head];
  const s3 = rig.pos(BONES.spine_03);
  const neck = rig.pos(BONES.neck_01);
  const by = THREE.MathUtils.lerp(s3.y, neck.y, 0.4);
  let backZ = Infinity;
  for (const { p } of torso) if (Math.abs(p.x - s3.x) < 0.04 && Math.abs(p.y - by) < 0.03) backZ = Math.min(backZ, p.z);
  const ua = rig.pos(BONES.upperarm_l);
  const sx = THREE.MathUtils.lerp(neck.x, ua.x, 0.55);
  const sz = THREE.MathUtils.lerp(neck.z, ua.z, 0.55);
  let sy = -Infinity;
  for (const { p } of torso) if (Math.hypot(p.x - sx, p.z - sz) < 0.03 && p.y < neck.y + 0.05) sy = Math.max(sy, p.y);
  const palm = (side) => {
    const hand = rig.pos(BONES[`hand_${side}`]);
    const mid = rig.pos(BONES[`middle_01_${side}`]);
    const thumb = rig.pos(`Bip01_${side.toUpperCase()}_Finger0`);
    const axis = mid.clone().sub(hand).normalize();
    const toThumb = thumb.clone().sub(hand);
    toThumb.addScaledVector(axis, -toThumb.dot(axis)).normalize();
    return anchor(`hand_${side}`, hand.clone().lerp(mid, 0.5).addScaledVector(toThumb, 0.012));
  };
  return {
    height: r4(maxY - minY),
    floor: r4(minY),
    hip: r4(rig.pos('Bip01').y),
    anchors: {
      headTop: anchor('Head', new THREE.Vector3(head.x, top, head.z)),
      back: anchor('spine_03', new THREE.Vector3(s3.x, by, backZ)),
      shoulderL: anchor('clavicle_l', new THREE.Vector3(sx, sy, sz)),
      palmL: palm('l'),
      palmR: palm('r'),
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = process.argv.slice(2);
  if (!ids.length) {
    console.error('usage: node scripts/people/makehuman-post.mjs <id…>');
    process.exit(2);
  }
  for (const id of ids) {
    const s = await postProcess(id);
    console.log(`${id}: crowd ${(s.bytes.crowd / 1024).toFixed(0)} KB, tris ${s.stats.tris.join('/')}, h ${s.height} hip ${s.hip} seat ${s.seatDrop}, residual ${JSON.stringify(s.stats.boneResidualDeg)}`);
  }
}
