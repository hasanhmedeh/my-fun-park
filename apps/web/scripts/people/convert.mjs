// Converts fetched Rocketbox avatars into the game's files:
//
//   public/models/people/<id>.crowd.glb   512 px textures, meshes LOD0 / LOD1 (~50%) / LOD2 (~20%) on one skin
//   public/models/people/<id>.hero.glb    1024 px textures (the hair atlas 512), LOD0 only (playable avatars, pilots)
//   public/models/people/portraits/<id>.webp   256 px head and shoulders, for the customiser
//   .people-cache/meta/avatar-<id>.json   what build-manifest.mjs needs (measurements, parts, sizes…)
//
//   node scripts/people/convert.mjs Male_Adult_01 …   (or --starter, --all) [--force] [--refetch] [--keep]
//
// --force rebuilds the game files from base.glb; --refetch downloads and converts the FBX again too;
// --keep keeps the downloads.
//
// Steps per avatar: the TGAs become 1024 px PNGs next to the FBX (FBX2glTF only embeds PNG/JPG
// found by base name), FBX2glTF makes a GLB, and the downloads are deleted (--keep keeps them).
// That GLB is cleaned into .people-cache/work/<id>/base.glb — uncompressed geometry, 1024 px
// textures (JPEG q92, PNG where there is real alpha), names as GLTFLoader leaves them, children's
// Bip02 renamed Bip01, joints parent-first, the Footsteps node and empty takes gone, real
// materials — which the measurements, the masks and the retargeting read. The game files are built
// from it: the hair cards turned to face outwards, the outfit mask from masks.mjs added (a PNG in
// the body material's occlusion slot) and the hair mask from hair-mask.mjs (a PNG in the head
// material's, where hair is painted into the head texture), textures to KTX2 (Basis ETC1S,
// normal maps UASTC, via basisu's WASI build; three's KTX2Loader transcodes them to BC7/ASTC/ETC2
// on the GPU), geometry meshopt-compressed.
//
// The seat measurement needs the seated clip, so run clips.mjs first (run-all.mjs does).
// Work already done is skipped unless --force.

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { cloneDocument, dedup, meshopt, prune, simplifyPrimitive, weld } from '@gltf-transform/functions';
import { AVATARS, STARTER, avatar } from './catalogue.mjs';
import { fetchAvatar } from './fetch.mjs';
import { FBX2GLTF, FFMPEG, META, OUT, WORK, basisu, cli, ensureDir, gltfIO, readJson, run, sanitize, size, writeJson } from './lib.mjs';
import { embedHairMask, HAIR_MASK_PX, hairMaskImage, makeHairMask } from './hair-mask.mjs';
import { hairTone, hairToneSpec } from './hair-tone.mjs';
import { BONES, measureBind, measureSeat, partsOf, rigOf, skinTone } from './measure.mjs';

/**
 * Texture sizes (longest side) and encoding per variant: `q` is Basis ETC1S quality (1–100),
 * `uastc` means UASTC 4×4 with that RDO lambda (zstd-compressed). The crowd is seen from a few
 * metres at most: colour at 512 and quality 55 can't be told from the 1024 source there. Normal
 * maps are UASTC: ETC1S, at any quality or size, breaks a normal map into 4×4 blocks of flat
 * shading that show as squares on the cloth (worst once it's dyed); UASTC at half the size costs
 * what ETC1S did and is clean. Heroes are seen close up; the hair atlas's strands gain nothing
 * above 512.
 */
const TEX = {
  crowd: { colour: { px: 512, q: 55 }, normal: { px: 128, uastc: 10 }, hair: { px: 512, q: 50 } },
  hero: { colour: { px: 1024, q: 75 }, normal: { px: 512, uastc: 10 }, hair: { px: 512, q: 75 } },
};
const SOURCE_TEX = 1024;
/** LOD triangle ratios (of LOD0) and the simplifier's error budget for each. */
const LODS = [
  { ratio: 0.5, error: 0.02 },
  { ratio: 0.2, error: 0.08 },
];

// ---------------------------------------------------------------- 1. download → base.glb

/** Fetches (if needed) and converts the FBX; leaves .people-cache/work/<id>/base.glb and preview.png. */
async function prepare(id, { refetch, keep }) {
  const work = ensureDir(join(WORK, id));
  const base = join(work, 'base.glb');
  if (existsSync(base) && !refetch) return base;
  const f = await fetchAvatar(id);
  if (f.missing.length) console.warn(`  ${id}: textures not in the repo: ${f.missing.join(', ')}`);
  // longest side 1024, aspect kept (helmets and hats are 2048×1024)
  const fit = `scale=w='iw*min(1,${SOURCE_TEX}/max(iw,ih))':h='ih*min(1,${SOURCE_TEX}/max(iw,ih))':flags=lanczos`;
  for (const tga of f.textures) {
    const png = tga.replace(/\.tga$/i, '.png');
    if (!existsSync(png)) run(FFMPEG, ['-v', 'error', '-y', '-i', tga, '-vf', fit, png]);
    if (!keep) rmSync(tga);
  }
  run(FBX2GLTF, ['--binary', '--keep-attribute', 'position', '--keep-attribute', 'normal', '--keep-attribute', 'uv0', '--input', f.fbx, '--output', join(work, 'raw')]);
  if (f.preview) copyFileSync(f.preview, join(work, 'preview.png'));
  if (!keep) rmSync(f.dir, { recursive: true, force: true });

  const io = await gltfIO();
  const doc = await io.read(join(work, 'raw.glb'));
  await clean(doc, id);
  await io.write(base, doc);
  rmSync(join(work, 'raw.glb'));
  return base;
}

/** FBX2glTF's output → the base document the game files are made from. */
async function clean(doc, id) {
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  for (const n of root.listNodes()) n.setName(sanitize(n.getName().replace(/^Bip02/, 'Bip01')));
  // FBX2glTF wraps everything in an identity "RootNode": lift its children into the scene
  for (const wrapper of scene.listChildren()) {
    if (wrapper.getName() !== 'RootNode') continue;
    for (const c of wrapper.listChildren()) {
      wrapper.removeChild(c);
      scene.addChild(c);
    }
    wrapper.dispose();
  }
  // the Biped's footstep helper isn't a joint, and clips' tracks for it are dropped too
  root.listNodes().find((n) => n.getName() === 'Bip01_Footsteps')?.dispose();
  for (const a of root.listAnimations()) a.dispose();

  const meshNodes = root.listNodes().filter((n) => n.getMesh());
  if (meshNodes.length !== 1 || !meshNodes[0].getSkin()) throw new Error(`${id}: expected one skinned mesh, found ${meshNodes.length}`);
  const node = meshNodes[0];
  // a skinned mesh's own transform is ignored (glTF and three agree), so clear FBX2glTF's −90° x
  node.setName('LOD0').setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  node.getMesh().setName('LOD0');
  sortJoints(node.getSkin(), root);
  if (!root.listNodes().some((n) => n.getName() === 'Bip01')) throw new Error(`${id}: no Bip01 root`);

  // Max's Phong materials: FBX2glTF guesses metallic 0.4 / roughness 0.71, but skin and cloth are
  // dielectric and fairly rough. The hair, lashes and brows atlas is alpha-tested and two-sided
  // (blending would need sorting in a crowd).
  for (const m of root.listMaterials()) {
    m.setExtras({}).setMetallicFactor(0).setRoughnessFactor(0.82).setBaseColorFactor([1, 1, 1, 1]);
    m.setEmissiveFactor([0, 0, 0]).setEmissiveTexture(null);
    if (/_opacity$/.test(m.getName()) || m.getAlphaMode() !== 'OPAQUE') m.setAlphaMode('MASK').setAlphaCutoff(0.4).setDoubleSided(true);
  }
  // FBX2glTF names textures after their files ('m002_body_color.png'); drop the extension
  for (const t of root.listTextures()) t.setName((t.getName() || t.getURI()).replace(/\.\w+$/, ''));
  await doc.transform(dedup(), prune(), weld());
  await compactTextures(doc);
}

/**
 * base.glb's opaque textures as JPEG (quality 92: well above what the KTX2 encoding keeps), the
 * hair atlas stays PNG for its alpha: a third of the size of the PNGs, for ~80 avatars' worth of
 * cache. The masks step, the measurements and the KTX2 encoding all read JPEG.
 */
export async function compactTextures(doc) {
  for (const t of doc.getRoot().listTextures()) {
    if (t.getMimeType() !== 'image/png') continue;
    const img = sharp(t.getImage());
    const { channels } = await img.metadata();
    if (channels === 4) {
      const { data } = await sharp(t.getImage()).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
      if (data.some((a) => a < 255)) continue;
    }
    const jpeg = await img.removeAlpha().jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
    t.setImage(new Uint8Array(jpeg)).setMimeType('image/jpeg').setURI(`${t.getName()}.jpg`);
  }
}

/** FBX2glTF doesn't list joints parent-first (L_Thigh before Spine); three's retargeting walks them in order. */
function sortJoints(skin, root) {
  const joints = skin.listJoints();
  const set = new Set(joints);
  const parentOf = new Map();
  for (const n of root.listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  const order = [];
  const visit = (n) => {
    if (set.has(n)) order.push(n);
    for (const c of n.listChildren()) visit(c);
  };
  for (const j of joints) if (!set.has(parentOf.get(j))) visit(j);
  if (order.length !== joints.length) throw new Error('joint sort lost joints');
  const remap = joints.map((j) => order.indexOf(j));
  const ibm = skin.getInverseBindMatrices();
  const mats = joints.map((_, i) => ibm.getElement(i, []));
  const sorted = new Float32Array(joints.length * 16);
  order.forEach((j, i) => sorted.set(mats[joints.indexOf(j)], i * 16));
  ibm.setArray(sorted);
  for (const j of joints) skin.removeJoint(j);
  for (const j of order) skin.addJoint(j);
  for (const node of root.listNodes()) {
    if (node.getSkin() !== skin) continue;
    for (const prim of node.getMesh().listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0');
      const a = J.getArray();
      for (let i = 0; i < a.length; i++) a[i] = remap[a[i]];
      J.setArray(a);
    }
  }
}

/**
 * Hair cards face both ways in the source (its renderer lit both sides of a card alike). three
 * draws a two-sided card's back with its normal reversed, so every card whose front faced into the
 * head showed as a dark patch from outside. Each hair triangle is turned to face away from the
 * middle of the skull, and its normals point that way too, bent halfway towards the radial
 * direction, which also evens out the shading between neighbouring cards. The lashes and brows
 * share the material and get the same.
 */
function fixHairNormals(doc, parts) {
  const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getMaterial()?.getName() === parts.hair);
  if (!prims.length) return;
  const head = rigOf(doc).pos(BONES.Head);
  let top = -Infinity;
  for (const p of prims) top = Math.max(top, p.getAttribute('POSITION').getMax([])[1]);
  // the skull's middle: between the head joint (at the top of the neck) and the top of the hair
  const centre = [head.x, (head.y + top) / 2, head.z];
  const outward = (p) => {
    const r = p.map((v, c) => v - centre[c]);
    const l = Math.hypot(...r) || 1;
    return r.map((v) => v / l);
  };
  const done = new Set();
  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION');
    const P = (i) => pos.getElement(i, []);
    // windings: front faces outward
    const idx = prim.getIndices();
    if (!done.has(idx)) {
      done.add(idx);
      const ix = idx.getArray();
      for (let t = 0; t < ix.length; t += 3) {
        const [a, b, c] = [P(ix[t]), P(ix[t + 1]), P(ix[t + 2])];
        const e1 = b.map((v, k) => v - a[k]);
        const e2 = c.map((v, k) => v - a[k]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const r = outward(a.map((v, k) => (v + b[k] + c[k]) / 3));
        if (n[0] * r[0] + n[1] * r[1] + n[2] * r[2] < 0) [ix[t + 1], ix[t + 2]] = [ix[t + 2], ix[t + 1]];
      }
      idx.setArray(ix);
    }
    // normals: outward, half radial
    const nor = prim.getAttribute('NORMAL');
    if (!nor || done.has(nor)) continue;
    done.add(nor);
    const n = nor.getArray();
    for (let i = 0; i < pos.getCount(); i++) {
      const r = outward(P(i));
      const k = n[i * 3] * r[0] + n[i * 3 + 1] * r[1] + n[i * 3 + 2] * r[2] < 0 ? -1 : 1;
      const m = [0, 1, 2].map((c) => k * n[i * 3 + c] + r[c]);
      const ml = Math.hypot(...m) || 1;
      for (let c = 0; c < 3; c++) n[i * 3 + c] = m[c] / ml;
    }
    nor.setArray(n);
  }
}

// ---------------------------------------------------------------- 2. textures

/**
 * A texture as KTX2 at `px` (longest side), ETC1S at quality `q` or UASTC at RDO lambda
 * `uastc`, cached in .people-cache/work/<id>/ktx/. Colour maps are sRGB; normal maps are encoded
 * for normals, linear; the hair atlas keeps its alpha, its colour spread into the transparent parts
 * (see bleed).
 */
async function ktx2(id, texture, { px, q, uastc }, kind) {
  const dir = ensureDir(join(WORK, id, 'ktx'));
  const name = `${texture.getName()}_${px}_${uastc ? `u${uastc}` : `q${q}`}`;
  const out = join(dir, `${name}.ktx2`);
  if (existsSync(out)) return readFileSync(out);
  const img = sharp(texture.getImage());
  const meta = await img.metadata();
  const scale = Math.min(1, px / Math.max(meta.width, meta.height));
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  if (kind === 'hair') {
    const { data } = await img.resize(w, h, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    bleed(data, w, h);
    await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(join(dir, `${name}.png`));
  } else await img.resize(w, h, { kernel: 'lanczos3' }).png().toFile(join(dir, `${name}.png`));
  const args = uastc ? ['-ktx2', '-uastc', '-uastc_level', '2', '-uastc_rdo_l', String(uastc), '-mipmap'] : ['-ktx2', '-etc1s', '-mipmap', '-quality', String(q), '-effort', '4'];
  if (kind === 'normal') args.push('-normal_map', '-mip_renorm');
  await basisu(dir, [...args, `${name}.png`, '-output_file', `${name}.ktx2`]);
  rmSync(join(dir, `${name}.png`));
  return readFileSync(out);
}

/**
 * Spreads the hair atlas's colours into its transparent texels (RGBA, in place). They're black in
 * the source, and filtering and mipmaps mix that into the cards' edges, which the alpha test then
 * shows as dark fringes and patches (worst along each card's straight root edge).
 */
function bleed(data, w, h) {
  const filled = new Uint8Array(w * h);
  let sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] <= 8) continue;
    filled[i] = 1;
    for (let c = 0; c < 3; c++) sum[c] += data[i * 4 + c];
    count++;
  }
  // grow the filled area a texel a pass, each new texel the mean of its filled neighbours
  for (let pass = 0; pass < 32; pass++) {
    const next = filled.slice();
    let grew = false;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        const acc = [0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || !filled[yy * w + xx]) continue;
            for (let c = 0; c < 3; c++) acc[c] += data[(yy * w + xx) * 4 + c];
            n++;
          }
        if (!n) continue;
        for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(acc[c] / n);
        next[i] = 1;
        grew = true;
      }
    filled.set(next);
    if (!grew) break;
  }
  // further out, the atlas's mean colour (what the smallest mipmaps blend towards)
  if (count) sum = sum.map((v) => Math.round(v / count));
  for (let i = 0; i < w * h; i++) if (!filled[i]) for (let c = 0; c < 3; c++) data[i * 4 + c] = sum[c];
}

/** Replaces every texture with KTX2 at its size and quality for this variant ('crowd' or 'hero'). */
async function packTextures(doc, id, variant, hairMaterial) {
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  const root = doc.getRoot();
  const normals = new Set(root.listMaterials().map((m) => m.getNormalTexture()).filter(Boolean));
  const hair = root.listMaterials().find((m) => m.getName() === hairMaterial)?.getBaseColorTexture();
  let gpu = 0;
  for (const t of root.listTextures()) {
    if (t.getName() === 'outfitMask' || t.getName() === 'hairMask') {
      // stays a PNG: ETC1S would smear its regions into each other (RGBA8 on the GPU)
      const [w, h] = t.getSize();
      gpu += w * h * 4 * (4 / 3);
      continue;
    }
    const kind = normals.has(t) ? 'normal' : t === hair ? 'hair' : 'colour';
    const spec = TEX[variant][kind];
    const before = await sharp(t.getImage()).metadata();
    const data = await ktx2(id, t, spec, kind);
    t.setImage(data).setMimeType('image/ktx2').setURI(`${t.getName()}.ktx2`);
    // what it costs once transcoded: BC7 / ASTC 4×4 are 1 byte a pixel (from ETC1S and UASTC alike), plus a third for mipmaps
    const s = Math.min(1, spec.px / Math.max(before.width, before.height));
    gpu += Math.round(before.width * s) * Math.round(before.height * s) * (4 / 3);
  }
  return Math.round(gpu);
}

// ---------------------------------------------------------------- 3. the game files

/** Adds LOD1, LOD2 meshes (simplified copies of LOD0's primitives) on the same skin. */
function addLods(doc, parts) {
  const root = doc.getRoot();
  const lod0 = root.listNodes().find((n) => n.getName() === 'LOD0');
  const scene = root.listScenes()[0];
  const tris = [];
  LODS.forEach(({ ratio, error }, i) => {
    const mesh = doc.createMesh(`LOD${i + 1}`);
    for (const src of lod0.getMesh().listPrimitives()) {
      const isHair = src.getMaterial().getName() === parts.hair;
      const prim = src.clone();
      // hair cards are tiny separate quads that simplification would eat: keep them whole on
      // LOD1, and a sparser set on LOD2 (whole cards dropped, not shrunk)
      if (isHair) {
        if (i === 1) thinCards(doc, prim, 0.5);
      } else simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error, lockBorder: false });
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(`LOD${i + 1}`).setMesh(mesh).setSkin(lod0.getSkin());
    scene.addChild(node);
  });
  for (const n of ['LOD0', 'LOD1', 'LOD2']) {
    const node = root.listNodes().find((x) => x.getName() === n);
    if (node) tris.push(node.getMesh().listPrimitives().reduce((s, p) => s + p.getIndices().getCount() / 3, 0));
  }
  return tris;
}

/** Keeps every other connected piece (a hair card, a lash strip) of a primitive. */
function thinCards(doc, prim, keep) {
  const idx = prim.getIndices().getArray();
  const n = prim.getAttribute('POSITION').getCount();
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (let i = 0; i < idx.length; i += 3) {
    const a = find(idx[i]);
    parent[find(idx[i + 1])] = a;
    parent[find(idx[i + 2])] = a;
  }
  const ids = new Map();
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    const c = find(idx[i]);
    if (!ids.has(c)) ids.set(c, ids.size);
    if (ids.get(c) % Math.round(1 / keep) === 0) out.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(out)).setBuffer(prim.getIndices().getBuffer()));
}

async function writeVariant(doc, file) {
  const io = await gltfIO();
  // UVs a hair outside [0, 1] (a few hair-card corners) would keep a primitive's UVs as floats:
  // the quantiser only packs [0, 1]. Pull them in; real tiling (beyond 2%) is left alone.
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute('TEXCOORD_0');
      const a = uv?.getArray();
      if (a && a.every((v) => v > -0.02 && v < 1.02)) uv.setArray(a.map((v) => Math.min(1, Math.max(0, v))));
    }
  await doc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'high', quantizationVolume: 'scene' }));
  await io.write(file, doc);
  return size(file);
}

/** Head and shoulders from Rocketbox's own preview render (A-pose, transparent background), 256 px. */
async function portrait(id) {
  const src = join(WORK, id, 'preview.png');
  if (!existsSync(src)) return null;
  const out = join(ensureDir(join(OUT, 'portraits')), `${id}.webp`);
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const alpha = (x, y) => data[(y * W + x) * 4 + 3] > 40;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < H && top < 0; y++) for (let x = 0; x < W; x++) if (alpha(x, y)) { top = y; break; }
  for (let y = H - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < W; x++) if (alpha(x, y)) { bottom = y; break; }
  const figure = bottom - top;
  // the head's middle, from the opaque columns in its top tenth
  let sum = 0;
  let count = 0;
  for (let y = top; y < top + figure * 0.1; y++) for (let x = 0; x < W; x++) if (alpha(x, y)) { sum += x; count++; }
  const cx = sum / count;
  const side = Math.round(figure * 0.27);
  const left = Math.max(0, Math.min(W - side, Math.round(cx - side / 2)));
  const y0 = Math.max(0, Math.round(top - figure * 0.02));
  await sharp(src).extract({ left, top: y0, width: side, height: Math.min(side, H - y0) }).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 82, alphaQuality: 90 }).toFile(out);
  return `portraits/${id}.webp`;
}

/**
 * The outfit mask, from the masks step's own code (masks.mjs): worked out once on base.glb's
 * 1024 px body texture at MASK_PX, embedded as is in the hero file and halved for the crowd (the
 * mask is RGBA8 on the GPU, ~1.4 MB at 512 with mipmaps, ~0.35 MB at 256). Returns null, with a
 * warning, when there's no masks.mjs or it fails, so an avatar still converts without one.
 */
const MASK_PX = 512;
async function outfitMask(base, parts, id) {
  try {
    const masks = await import('./masks.mjs');
    const full = await masks.makeOutfitMask(base, { size: MASK_PX, bodyMaterial: parts.body });
    if (!Object.keys(full.regions).length) return null;
    // a 2×2 box filter (not sharp: it would premultiply by A, the trim channel, and lose R, G, B)
    const s = MASK_PX / 2;
    const rgba = new Uint8Array(s * s * 4);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++)
        for (let c = 0; c < 4; c++) {
          const at = (dx, dy) => full.rgba[((2 * y + dy) * MASK_PX + 2 * x + dx) * 4 + c];
          rgba[(y * s + x) * 4 + c] = Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
        }
    return { embed: masks.embedMask, regions: full.regions, hero: full, crowd: { ...full, size: s, rgba } };
  } catch (e) {
    console.warn(`  ${id}: no outfit mask (${e.message})`);
    return null;
  }
}

/**
 * The hair masks (hair-mask.mjs) of base.glb's head texture, or null: none painted, or, with a
 * warning, when working them out fails, so an avatar still converts without them.
 */
async function hairMasks(base, parts, a, id) {
  try {
    return await makeHairMask(base, parts, { tags: a.tags, gender: a.gender, age: a.age });
  } catch (e) {
    console.warn(`  ${id}: no hair mask (${e.message})`);
    return null;
  }
}

/** Everything for one avatar. */
export async function convertAvatar(id, opts = {}) {
  const a = avatar(id);
  const sidecar = join(META, `avatar-${id}.json`);
  const crowdFile = join(OUT, `${id}.crowd.glb`);
  const heroFile = join(OUT, `${id}.hero.glb`);
  if (!opts.force && !opts.refetch && existsSync(sidecar) && existsSync(crowdFile) && (!a.hero || existsSync(heroFile))) return readJson(sidecar);
  const t0 = Date.now();
  const io = await gltfIO();
  const basePath = await prepare(id, opts);
  const base = await io.read(basePath);
  const parts = partsOf(base);
  const bind = measureBind(base);
  const hair = await hairTone(base, parts, { tags: a.tags });
  fixHairNormals(base, parts);

  // the seat, from the seated idle of this avatar's clip pack (clips.mjs leaves it in work/anim)
  const sitFile = join(WORK, 'anim', `sit-${a.gender}.json`);
  let seat = null;
  if (existsSync(sitFile)) {
    const sit = readJson(sitFile);
    seat = measureSeat(base, sit.clip, sit.refHip, bind.height);
  } else console.warn(`  ${id}: no ${sitFile} yet (run clips.mjs): seatDrop estimated`);

  const headTex = base.getRoot().listMaterials().find((m) => m.getName() === parts.head)?.getBaseColorTexture();
  const tone = headTex ? await skinTone(headTex.getImage()) : null;

  const mask = await outfitMask(base, parts, id);
  const painted = await hairMasks(base, parts, a, id);

  ensureDir(OUT);
  // crowd: LODs, 512 px
  const crowd = cloneDocument(base);
  if (mask) await mask.embed(crowd, parts.body, mask.crowd);
  if (painted) await embedHairMask(crowd, parts.head, hairMaskImage(painted, HAIR_MASK_PX.crowd), HAIR_MASK_PX.crowd);
  const tris = addLods(crowd, parts);
  const crowdGpu = await packTextures(crowd, id, 'crowd', parts.hair);
  const crowdBytes = await writeVariant(crowd, crowdFile);

  // hero: LOD0 only, 1024 px
  let heroBytes;
  let heroGpu;
  if (a.hero) {
    const hero = cloneDocument(base);
    if (mask) await mask.embed(hero, parts.body, mask.hero);
    if (painted) await embedHairMask(hero, parts.head, hairMaskImage(painted, HAIR_MASK_PX.hero), HAIR_MASK_PX.hero);
    heroGpu = await packTextures(hero, id, 'hero', parts.hair);
    heroBytes = await writeVariant(hero, heroFile);
  } else rmSync(heroFile, { force: true });

  const portraitPath = a.roles.includes('playable') || a.hero ? await portrait(id) : null;
  const hairSpec = hairToneSpec(hair, painted?.tones);
  const spec = {
    id,
    source: 'rocketbox',
    rig: 'rocketbox',
    gender: a.gender,
    age: a.age,
    skin: a.skin ?? tone?.skin ?? 3,
    roles: a.roles,
    tags: a.tags,
    files: { crowd: `${id}.crowd.glb`, ...(a.hero ? { hero: `${id}.hero.glb` } : {}) },
    bytes: { crowd: crowdBytes, ...(a.hero ? { hero: heroBytes } : {}) },
    lods: tris.length,
    height: bind.height,
    hip: bind.hip,
    seatDrop: seat?.seatDrop ?? Math.round((bind.hip * 0.53 - 0.07) * 1000) / 1000,
    anchors: bind.anchors,
    parts,
    ...(mask ? { outfit: { regions: mask.regions } } : {}),
    ...(hairSpec ? { hairTone: hairSpec } : {}),
    ...(portraitPath ? { portrait: portraitPath } : {}),
    // for the report and the review sheet, not the manifest
    stats: { tris, floor: bind.floor, extraTop: bind.extraTop, gpuBytes: { crowd: crowdGpu, ...(a.hero ? { hero: heroGpu } : {}) }, skinL: tone?.L, skinColour: tone?.colour, seat, seconds: Math.round((Date.now() - t0) / 100) / 10 },
  };
  writeJson(sidecar, spec);
  return spec;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, ids } = cli();
  const list = flags.all ? AVATARS.map((a) => a.id) : flags.starter ? STARTER : ids;
  if (!list.length) {
    console.error('usage: node scripts/people/convert.mjs <id…> | --starter | --all [--force] [--keep]');
    process.exit(2);
  }
  for (const id of list) {
    try {
      const s = await convertAvatar(id, flags);
      console.log(`${id}: crowd ${(s.bytes.crowd / 1024).toFixed(0)} KB${s.bytes.hero ? `, hero ${(s.bytes.hero / 1024).toFixed(0)} KB` : ''}, tris ${s.stats.tris.join('/')}, h ${s.height} hip ${s.hip} seat ${s.seatDrop} skin ${s.skin} (L ${s.stats.skinL}) ${s.stats.seconds ?? ''} s`);
    } catch (e) {
      console.error(`${id}: FAILED ${e.stack || e}`);
      process.exitCode = 1;
    }
  }
}
