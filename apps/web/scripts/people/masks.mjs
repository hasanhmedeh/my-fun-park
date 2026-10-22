// Outfit recolour masks for Rocketbox avatars: finds where the top, the bottoms, the shoes and any
// reflective trim are in the body texture, and embeds that as a texture named `outfitMask` (R top,
// G bottom, B shoes, A trim, in the body's UV space) for src/world/crowd/outfit-tint.ts to dye.
//
//   node scripts/people/masks.mjs <in.glb> <out.glb | -> [--id Male_Adult_01] [--size 512]
//        [--from <analysis.glb>] [--meta <dir> | --no-meta] [--debug <dir>] [--no-merge] [--trim]
//        [--body <material>]
//   node scripts/people/masks.mjs --all            (the meta of every .people-cache/work/<id>/base.glb)
//
// <out.glb> may be <in.glb>, or "-" to write only the meta. The id defaults to the file name up to
// its first dot. Run it on the converted avatar before mesh quantisation and texture compression: it
// reads the body's colour texture (PNG, JPEG or WebP; not KTX2) and its UVs and skin weights. If
// <in.glb> has already been compressed, `--from` names an uncompressed GLB of the same avatar (its
// base.glb) to read them from instead. From a build script: `await maskAvatar(baseDoc, id)` before
// the variants are cloned from it (see maskAvatar below). About 2 s an avatar.
//
// How it decides, per texel of the body texture:
//   1. Where it is on the body. Every body triangle is drawn into UV space with its vertices' skin
//      weights grouped by bone (trunk and arms, hands, pelvis, legs, feet, head), so each texel
//      knows whether it is on a sleeve, a trouser leg or a shoe; a UV island that is mostly one part
//      takes that part throughout (a hem weighted to the foot is still the trousers).
//   2. Whether it is skin. Skin is sampled from the hands and the head texture and compared by
//      chromaticity (log R/G and B/G, which shading doesn't change), so folds and shadows don't
//      matter but khaki, denim or leather do.
//   3. Which garment. Each part's dominant fabric colour is found (a chromaticity histogram's peak)
//      and only texels close to it join the region: a print, a logo, a belt, a zip, a white sole or
//      a hoodie under a jacket keeps its own colour. The same hue washed out (faded denim) or
//      painted deeper (a vest's folds) still counts. Very bright texels on a black, grey or white
//      fabric (a white logo on a black tee) stay out, so dyeing never blows them out. Pelvis texels
//      go to whichever garment's colour they match (a shirt that hangs over the hips stays a
//      shirt); shoes never reach above the knee. Each garment then grows into neighbours whose
//      colour drifts only a little (shading painted in, a dark fabric sliding towards grey).
//   4. Boots and one-piece outfits. 'Bottoms' only on the calves of an island, in the shoes' sort
//      of colour, are boot shafts and join the shoes. When the top's and the bottoms' fabrics are
//      the same (a dress, a thobe, a suit), the bottoms join the top, so a dress is dyed as one
//      garment (--no-merge keeps them apart).
//   5. Trim. On a fluorescent top, bright neutral bands on the vest's own panels are reflective
//      tape (A).
//   6. Clean-up: small specks closed, islands under a minimum size dropped, then the labels are
//      averaged down to the output size (soft, anti-aliased edges) and spread into the empty texels
//      round the UV islands so filtering and mipmaps don't fade the dye at seams.
//
// The mask goes in as the body material's occlusion texture with strength 0: that keeps it through
// prune and dedup (an unreferenced texture would be dropped), marks it as non-colour data for
// texture compression, and is a no-op for any viewer. outfit-tint.ts takes it off the material.
// Keep it lossless (PNG) or UASTC: ETC1S blocks smear the channels into each other. Each region's
// mean linear luminance and own colour go to <meta>/outfit-<id>.json ({ id, outfit }, the shape of
// AvatarSpec.outfit, for build-manifest) and into the body material's extras as `outfit`.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const WEB = resolve(fileURLToPath(import.meta.url), '../../..');

// ------------------------------------------------------------------------------------ bones

const TORSO = 0, ARM = 1, HAND = 2, PELVIS = 3, LEG = 4, FOOT = 5, HEAD = 6;
const GROUPS = 7;

/** A Biped bone's body part (names as FBX2glTF or GLTFLoader leave them; children's Bip02 too). */
function boneGroup(name) {
  const n = name.replace(/[_\s]+/g, ' ');
  if (/Pelvis$/i.test(n)) return PELVIS;
  if (/(Spine\d*|Neck\d*|Clavicle)$/i.test(n)) return TORSO;
  if (/(UpperArm|Forearm|ForeTwist|UpperArmTwist)\w*$/i.test(n)) return ARM;
  if (/(Hand|Finger\d*)$/i.test(n)) return HAND;
  if (/(Thigh|Calf|HorseLink)\w*$/i.test(n)) return LEG;
  if (/(Foot|Toe\d*)$/i.test(n)) return FOOT;
  return HEAD;
}

// ------------------------------------------------------------------------------------ colour

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb8 = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.max(0, l) ** (1 / 2.4) - 0.055));
const hex = (rgb) => '#' + rgb.map((l) => Math.min(255, Math.max(0, toSrgb8(l))).toString(16).padStart(2, '0')).join('');
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Shading scales all three channels alike, so these two ratios hold through folds and shadows. */
const CHROMA_EPS = 0.004;
const chromaX = (r, g) => Math.log((r + CHROMA_EPS) / (g + CHROMA_EPS));
const chromaY = (b, g) => Math.log((b + CHROMA_EPS) / (g + CHROMA_EPS));

/** Linear RGB of a texture at size×size (squashed to square: UV space doesn't care). */
async function decode(image, size) {
  const { data, info } = await sharp(Buffer.from(image)).resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  const n = size * size;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = SRGB_TO_LINEAR[data[i * 3]];
    g[i] = SRGB_TO_LINEAR[data[i * 3 + 1]];
    b[i] = SRGB_TO_LINEAR[data[i * 3 + 2]];
  }
  return { r, g, b, srgb: data };
}

// ------------------------------------------------------------------------------------ UV raster

/**
 * Draws triangles into a size×size grid in UV space (glTF's v runs down the image, like the
 * texture's rows). For each covered texel `shade(texel, w0, w1, w2, a, b, c)` gets the barycentric
 * weights of the triangle's vertices a, b, c.
 */
export function rasterise(size, uv, tris, shade) {
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ax = uv[a * 2] * size, ay = uv[a * 2 + 1] * size;
    const bx = uv[b * 2] * size, by = uv[b * 2 + 1] * size;
    const cx = uv[c * 2] * size, cy = uv[c * 2 + 1] * size;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        const w2 = 1 - w0 - w1;
        // a hair of slack so texels on shared edges aren't missed between triangles
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        shade(y * size + x, w0, w1, w2, a, b, c);
      }
    }
  }
}

/** One primitive's vertex data, flattened (works on indexed and non-indexed primitives). */
function readPrimitive(prim) {
  const pos = prim.getAttribute('POSITION');
  const uvA = prim.getAttribute('TEXCOORD_0');
  if (!uvA) throw new Error('body primitive has no TEXCOORD_0');
  const n = pos.getCount();
  const uv = new Float32Array(n * 2), y = new Float32Array(n);
  const e = [];
  for (let i = 0; i < n; i++) {
    uvA.getElement(i, e);
    uv[i * 2] = e[0];
    uv[i * 2 + 1] = e[1];
    pos.getElement(i, e);
    y[i] = e[1];
  }
  const idx = prim.getIndices();
  const tris = idx ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i)) : Uint32Array.from({ length: n }, (_, i) => i);
  return { prim, n, uv, y, tris, joints: prim.getAttribute('JOINTS_0'), weights: prim.getAttribute('WEIGHTS_0') };
}

/** 3×3 box average. */
export function boxBlur(c, size) {
  const out = new Float32Array(c.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          s += c[yy * size + xx];
          n++;
        }
      }
      out[y * size + x] = s / n;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------ morphology

/** 3×3 dilation (grow) or erosion (shrink) of a 0/1 map, `times` over. */
export function morph(m, size, grow, times) {
  let src = m;
  for (let k = 0; k < times; k++) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let any = 0, all = 1;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= size) { all = 0; continue; }
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= size) { all = 0; continue; }
            const v = src[yy * size + xx];
            any |= v;
            all &= v;
          }
        }
        dst[y * size + x] = grow ? any : all;
      }
    }
    src = dst;
  }
  return src;
}
const close = (m, size, r) => morph(morph(m, size, true, r), size, false, r);
const open = (m, size, r) => morph(morph(m, size, false, r), size, true, r);

/** Calls fn(texels) with each UV island's texels (`island` holds each texel's island id, or -1). */
function forEachIsland(island, fn) {
  const groups = new Map();
  for (let t = 0; t < island.length; t++) {
    if (island[t] < 0) continue;
    let g = groups.get(island[t]);
    if (!g) groups.set(island[t], (g = []));
    g.push(t);
  }
  for (const g of groups.values()) fn(g);
}

function unionFind() {
  const parent = [];
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  return {
    add: () => parent.push(parent.length) - 1,
    find,
    union(a, b) {
      a = find(a);
      b = find(b);
      if (a !== b) parent[a] = b;
    },
  };
}

/** Keeps the 4-connected islands of a 0/1 map that overlap `near`. */
function keepTouching(m, near, size) {
  const seen = new Uint8Array(m.length);
  const queue = new Int32Array(m.length);
  const out = new Uint8Array(m.length);
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    let head = 0, tail = 0, touches = false;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      if (near[i]) touches = true;
      const x = i % size, y = (i / size) | 0;
      for (const [ok, j] of [[x > 0, i - 1], [x < size - 1, i + 1], [y > 0, i - size], [y < size - 1, i + size]]) {
        if (ok && m[j] && !seen[j]) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    if (touches) for (let k = 0; k < tail; k++) out[queue[k]] = 1;
  }
  return out;
}

/** Drops 4-connected islands of a 0/1 map smaller than minArea texels. */
export function dropSmall(m, size, minArea) {
  const seen = new Uint8Array(m.length);
  const queue = new Int32Array(m.length);
  const out = new Uint8Array(m);
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    let head = 0, tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % size, y = (i / size) | 0;
      if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
      if (x < size - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > 0 && m[i - size] && !seen[i - size]) { seen[i - size] = 1; queue[tail++] = i - size; }
      if (y < size - 1 && m[i + size] && !seen[i + size]) { seen[i + size] = 1; queue[tail++] = i + size; }
    }
    if (tail < minArea) for (let k = 0; k < tail; k++) out[queue[k]] = 0;
  }
  return out;
}

/**
 * Small unlabelled pockets wholly inside one garment (a fold's darkest crease, a stitch, a button)
 * join it, so the dye has no freckles of the old colour. Pockets that reach the edge of a UV
 * island, touch two labels or are mostly skin are left alone.
 */
function fillHoles(label, covered, size, maxArea, isSkin) {
  const seen = new Uint8Array(label.length);
  const queue = new Int32Array(label.length);
  for (let s = 0; s < label.length; s++) {
    if (seen[s] || label[s] || !covered[s]) continue;
    let head = 0, tail = 0, around = 0, open = false, skin = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      if (isSkin(i)) skin++;
      const x = i % size, y = (i / size) | 0;
      for (const [ok, j] of [[x > 0, i - 1], [x < size - 1, i + 1], [y > 0, i - size], [y < size - 1, i + size]]) {
        if (!ok || !covered[j]) { open = true; continue; }
        if (label[j]) {
          if (around && around !== label[j]) open = true;
          around = label[j];
        } else if (!seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (!open && around && tail <= maxArea && skin < tail / 2) for (let k = 0; k < tail; k++) label[queue[k]] = around;
  }
}

// ------------------------------------------------------------------------------------ colour models

/** Mean and covariance of 2D points (with a floor so a flat colour doesn't make a needle-thin model). */
export function gaussian(xs, ys, floor) {
  const n = xs.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx = sxx / n + floor * floor;
  syy = syy / n + floor * floor;
  sxy /= n;
  const det = sxx * syy - sxy * sxy;
  return { mx, my, ixx: syy / det, iyy: sxx / det, ixy: -sxy / det, sx: Math.sqrt(sxx), sy: Math.sqrt(syy), cxx: sxx, cyy: syy, cxy: sxy, n };
}
/** Mahalanobis distance with extra isotropic spread `noise` (a dark texel's chromaticity is uncertain). */
export function noisyDistance(m, x, y, noise) {
  if (!m.cxx) return distance(m, x, y);
  const a = m.cxx + noise * noise, d = m.cyy + noise * noise, b = m.cxy;
  const det = a * d - b * b;
  const dx = x - m.mx, dy = y - m.my;
  return Math.sqrt(Math.max(0, (dx * dx * d - 2 * dx * dy * b + dy * dy * a) / det));
}
/** Mahalanobis distance of (x, y) from a model. */
export function distance(m, x, y) {
  const dx = x - m.mx, dy = y - m.my;
  return Math.sqrt(Math.max(0, dx * dx * m.ixx + 2 * dx * dy * m.ixy + dy * dy * m.iyy));
}

/**
 * The dominant fabric of a set of texels: the peak of their chromaticity histogram (smoothed), and
 * the Gaussian of the texels around it. Dark texels count less (their chromaticity is noise).
 */
export function dominant(cx, cy, lum, texels, darkLum) {
  // (saturated colours go far: pure red's log R/G is about 5)
  const B = 160, LO = -5, HI = 5, step = (HI - LO) / B;
  const hist = new Float32Array(B * B);
  const bin = (v) => Math.min(B - 1, Math.max(0, Math.floor((v - LO) / step)));
  for (const i of texels) hist[bin(cy[i]) * B + bin(cx[i])] += Math.min(1, lum[i] / darkLum);
  // 5×5 box blur so a speckled fabric still has one clear peak
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < B; y++) {
    for (let x = 0; x < B; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < B && xx >= 0 && xx < B) s += hist[yy * B + xx];
      }
      if (s > best) { best = s; bx = x; by = y; }
    }
  }
  const px = LO + (bx + 0.5) * step, py = LO + (by + 0.5) * step;
  // refine: the texels within reach of the peak, twice (the second pass with the first's spread)
  let model = { mx: px, my: py, ixx: 1 / 0.12 ** 2, iyy: 1 / 0.12 ** 2, ixy: 0 };
  for (let pass = 0; pass < 3; pass++) {
    const xs = [], ys = [];
    for (const i of texels) {
      if (lum[i] < darkLum * 0.5) continue;
      if (distance(model, cx[i], cy[i]) < 3) { xs.push(cx[i]); ys.push(cy[i]); }
    }
    if (xs.length < 20) break;
    model = gaussian(xs, ys, 0.04);
  }
  return model;
}

// ------------------------------------------------------------------------------------ the mask

/**
 * Works out the outfit mask of a document's body material.
 * Returns { size, rgba (Uint8Array, size²×4), regions, stats, debug }.
 */
export async function makeOutfitMask(doc, { size = 512, merge = true, forceTrim = false, bodyMaterial } = {}) {
  const root = doc.getRoot();
  const mats = root.listMaterials();
  // (a few avatars are one material from head to toe, a burqa's f204 say: that one is the body)
  const body = bodyMaterial
    ? mats.find((m) => m.getName() === bodyMaterial)
    : (mats.find((m) => /body$/i.test(m.getName())) ?? (mats.length === 1 ? mats[0] : undefined));
  if (!body) throw new Error(`no body material (have ${mats.map((m) => m.getName()).join(', ')})`);
  const head = mats.find((m) => /head$/i.test(m.getName()));
  const bodyTex = body.getBaseColorTexture();
  if (!bodyTex) throw new Error(`${body.getName()} has no colour texture`);
  if (!/png|jpe?g|webp/.test(bodyTex.getMimeType())) throw new Error(`can't read a ${bodyTex.getMimeType()} texture: run before compression, or pass --from`);
  const texSize = bodyTex.getSize()?.[0] ?? 1024;
  const R = Math.min(1024, texSize);
  const N = R * R;

  // ---- 1. where each texel is on the body
  const groupW = Array.from({ length: GROUPS }, () => new Float32Array(N));
  // (and how much of each texel's leg weight is the calf's or the foot's: boots reach up the calf,
  // never the thigh)
  const lowW = new Float32Array(N);
  const covered = new Uint8Array(N);
  const island = new Int32Array(N).fill(-1);
  const cornerId = new Map();
  const uf = unionFind();
  const prims = [];
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) if (p.getMaterial() === body) prims.push(readPrimitive(p));
  if (!prims.length) throw new Error('no primitive uses the body material');
  // joint names, from the skin of a node that draws this mesh
  const skinOf = new Map();
  for (const node of root.listNodes()) if (node.getMesh() && node.getSkin()) skinOf.set(node.getMesh(), node.getSkin());
  for (const p of prims) {
    const mesh = p.prim.listParents().find((x) => x.propertyType === 'Mesh');
    const skin = skinOf.get(mesh);
    if (!skin || !p.joints) throw new Error('body is not skinned');
    const jointGroup = skin.listJoints().map((j) => boneGroup(j.getName()));
    const jointLow = skin.listJoints().map((j) => /(Calf|HorseLink|Foot|Toe)w*$/i.test(j.getName().replace(/[_s]+/g, ' ')));
    const vg = new Float32Array(p.n * GROUPS);
    const vlow = new Float32Array(p.n);
    const j = [], w = [];
    for (let i = 0; i < p.n; i++) {
      p.joints.getElement(i, j);
      p.weights.getElement(i, w);
      for (let k = 0; k < j.length; k++) if (w[k] > 0) {
        vg[i * GROUPS + jointGroup[j[k]]] += w[k];
        if (jointLow[j[k]]) vlow[i] += w[k];
      }
    }
    // UV islands from the mesh, not the raster (islands can touch in the texture): triangles that
    // share a UV corner are in one island
    const corner = new Int32Array(p.n);
    for (let i = 0; i < p.n; i++) {
      const key = `${Math.round(p.uv[i * 2] * 1e5)},${Math.round(p.uv[i * 2 + 1] * 1e5)}`;
      let id = cornerId.get(key);
      if (id === undefined) cornerId.set(key, (id = uf.add()));
      corner[i] = id;
    }
    for (let k = 0; k < p.tris.length; k += 3) {
      uf.union(corner[p.tris[k]], corner[p.tris[k + 1]]);
      uf.union(corner[p.tris[k]], corner[p.tris[k + 2]]);
    }
    rasterise(R, p.uv, p.tris, (t, w0, w1, w2, a, b, c) => {
      covered[t] = 1;
      for (let g = 0; g < GROUPS; g++) groupW[g][t] = w0 * vg[a * GROUPS + g] + w1 * vg[b * GROUPS + g] + w2 * vg[c * GROUPS + g];
      island[t] = corner[a];
      lowW[t] = w0 * vlow[a] + w1 * vlow[b] + w2 * vlow[c];
    });
  }
  for (let t = 0; t < N; t++) if (covered[t]) island[t] = uf.find(island[t]);
  const part = new Uint8Array(N).fill(255);
  for (let t = 0; t < N; t++) {
    if (!covered[t]) continue;
    let best = 0;
    for (let g = 1; g < GROUPS; g++) if (groupW[g][t] > groupW[best][t]) best = g;
    part[t] = best;
  }
  // A UV island is nearly always one garment, so a stretch of it weighted to a neighbouring bone
  // belongs with the rest: a trouser hem weighted to the foot, a shirt's tail to the pelvis, a
  // dress's skirt to the thighs, a boot's shaft to the calf. Texels in an island that is mostly
  // one part (60%) take that part (hands and the head keep theirs).
  const CLOTHED = [TORSO, ARM, PELVIS, LEG, FOOT];
  forEachIsland(island, (texels) => {
    const count = new Array(GROUPS).fill(0);
    for (const t of texels) count[part[t]]++;
    const total = CLOTHED.reduce((s, g) => s + count[g], 0);
    const main = CLOTHED.reduce((a, b) => (count[b] > count[a] ? b : a));
    if (total < 50 || count[main] < total * 0.6) return;
    // (the trunk and the arms are one garment's parts anyway)
    const same = (g) => g === main || (main === TORSO && g === ARM) || (main === ARM && g === TORSO);
    for (const t of texels) if (CLOTHED.includes(part[t]) && !same(part[t])) part[t] = main;
  });

  // ---- texture colour, as chromaticity and luminance
  const tex = await decode(bodyTex.getImage(), R);
  // (chromaticity from a 3×3 average: a dark fabric's texels are only a few code values apart, so
  // their own ratios are mostly noise)
  const lum = new Float32Array(N), cx = new Float32Array(N), cy = new Float32Array(N);
  const [br, bg, bb] = [tex.r, tex.g, tex.b].map((c) => boxBlur(c, R));
  for (let t = 0; t < N; t++) {
    lum[t] = luminance(tex.r[t], tex.g[t], tex.b[t]);
    cx[t] = chromaX(br[t], bg[t]);
    cy[t] = chromaY(bb[t], bg[t]);
  }

  // ---- 2. skin: the hands' texels, and the head texture's (its face, neck and ears)
  const skinX = [], skinY = [], skinL = [];
  for (let t = 0; t < N; t++) if (covered[t] && groupW[HAND][t] > 0.9 && lum[t] > 0.02) { skinX.push(cx[t]); skinY.push(cy[t]); skinL.push(lum[t]); }
  const headX = [], headY = [], headL = [];
  if (head?.getBaseColorTexture()) {
    const ht = head.getBaseColorTexture();
    const HR = 256;
    const hc = await decode(ht.getImage(), HR);
    const hcov = new Uint8Array(HR * HR);
    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) if (p.getMaterial() === head) {
      const d = readPrimitive(p);
      rasterise(HR, d.uv, d.tris, (t) => (hcov[t] = 1));
    }
    for (let t = 0; t < HR * HR; t++) {
      if (!hcov[t]) continue;
      const l = luminance(hc.r[t], hc.g[t], hc.b[t]);
      if (l < 0.02) continue;
      headX.push(chromaX(hc.r[t], hc.g[t]));
      headY.push(chromaY(hc.b[t], hc.g[t]));
      headL.push(l);
    }
  }
  // The head's skin is its dominant colour; the hands only count when they agree with it (gloves
  // don't). Every skin tone, pale to dark, is redder than it is green and greener than it is blue
  // (about +0.6..0.9 and −0.4..−0.6 here, in linear light): a sample that isn't is a glove or a veil
  // (a burqa's blue covers head and hands), and with neither nothing is taken for skin.
  const skinTone = (m) => (m && m.mx > 0.15 && m.my < 0.05 ? m : null);
  const headModel = skinTone(headX.length > 50 ? dominant(headX, headY, headL, headX.map((_, i) => i), 0.03) : null);
  const handModel = skinTone(skinX.length > 50 ? dominant(skinX, skinY, skinL, skinX.map((_, i) => i), 0.03) : null);
  const xs = [], ys = [], ls = [];
  for (const [mx, my, ml, model] of [[headX, headY, headL, headModel], [skinX, skinY, skinL, handModel]]) {
    if (!model) continue;
    if (model === handModel && headModel && Math.hypot(handModel.mx - headModel.mx, handModel.my - headModel.my) > 0.25) continue;
    for (let i = 0; i < mx.length; i++) if (distance(model, mx[i], my[i]) < 2.5) { xs.push(mx[i]); ys.push(my[i]); ls.push(ml[i]); }
  }
  let skin = xs.length > 50 ? gaussian(xs, ys, 0.03) : null;
  // Skin is never much darker than the person's own skin (a crease's shadow, not more): brown
  // leather has skin's chromaticity and is told apart only by being several times darker. (On a
  // dark-skinned avatar the two can't be told apart; the leather then stays undyed, which is safe.)
  const skinLumLo = ls.length ? ls.sort((a, b) => a - b)[ls.length >> 1] * 0.3 : 0.02;
  // then let it learn the body's own skin, which is often a shade off the face's (a tan, a flush):
  // twice, take in the body's texels that are already close to it
  for (let round = 0; skin && round < 2; round++) {
    const bx = [...xs], by = [...ys];
    for (let t = 0; t < N; t += 3) if (covered[t] && lum[t] > skinLumLo && distance(skin, cx[t], cy[t]) < 1.8) { bx.push(cx[t]); by.push(cy[t]); }
    skin = gaussian(bx, by, 0.03);
  }
  const skinDist = new Float32Array(N).fill(99);
  if (skin) for (let t = 0; t < N; t++) if (covered[t]) skinDist[t] = distance(skin, cx[t], cy[t]);
  // skin shades across the body (redder in the folds, paler on the shins) beyond what one model
  // holds, so from every texel that clearly is skin, grow into neighbours whose colour steps only
  // a little: that follows the gradual drift and stops at a garment's edge, where the colour jumps
  const skinMap = new Uint8Array(N);
  {
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    for (let t = 0; t < N; t++) if (covered[t] && skinDist[t] < 2.6 && lum[t] > skinLumLo) { skinMap[t] = 1; queue[tail++] = t; }
    while (head < tail) {
      const i = queue[head++];
      const x = i % R, y = (i / R) | 0;
      for (const [ok, j] of [[x > 0, i - 1], [x < R - 1, i + 1], [y > 0, i - R], [y < R - 1, i + R]]) {
        if (!ok || skinMap[j] || !covered[j] || lum[j] <= skinLumLo || skinDist[j] > 6) continue;
        if (Math.abs(cx[j] - cx[i]) + Math.abs(cy[j] - cy[i]) > 0.08) continue;
        skinMap[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  const isSkinLike = (t) => skinMap[t] === 1;

  // ---- 3. each garment's fabric
  const REGION_PARTS = { top: [TORSO, ARM, HEAD], bottom: [LEG], shoes: [FOOT] };
  const models = {};
  for (const [region, parts] of Object.entries(REGION_PARTS)) {
    // (well clear of the skin, so a bare leg's fringe can't pass for the fabric)
    let texels = [];
    for (let t = 0; t < N; t++) if (covered[t] && parts.includes(part[t]) && skinDist[t] > 3.2 && !skinMap[t]) texels.push(t);
    if (texels.length < N * 0.004) texels = texels.filter(() => false).concat([...Array(N).keys()].filter((t) => covered[t] && parts.includes(part[t]) && !isSkinLike(t)));
    // a garment needs some area: a few stray texels on a bare foot are not shoes
    if (texels.length < N * 0.004) continue;
    const median = (ts) => ts.map((t) => lum[t]).sort((a, b) => a - b)[ts.length >> 1];
    const model = dominant(cx, cy, lum, texels, Math.max(0.004, median(texels) * 0.3));
    const fabric = texels.filter((t) => distance(model, cx[t], cy[t]) < 2.5);
    if (fabric.length < N * 0.002) continue;
    models[region] = { ...model, typical: median(fabric) };
  }

  /** How far a texel is from a garment's fabric, in its spreads (under about 2.7 is that fabric). */
  const DARK = 0.3;
  function fabricDistance(region, t) {
    const m = models[region];
    if (!m) return 99;
    // dark texels' chromaticity wanders: be more forgiving the darker they are than the fabric
    const dark = 1 - Math.min(1, lum[t] / (m.typical * DARK));
    // a texel a few code values off black has a chromaticity good to about ±2.5 codes over its value
    const noise = 2.5 / Math.max(4, toSrgb8(lum[t]));
    let d = noisyDistance(m, cx[t], cy[t], noise);
    // faded, worn, dusty or sheeny patches are the fabric's colour washed towards grey: anything on
    // the way from the fabric's chromaticity to neutral, at least 35% of the way to the fabric, counts.
    // So do its shadows where they were painted deeper rather than darker (a fluorescent vest's
    // folds and hems go from orange to red-orange): the same hue up to 60% stronger.
    const len2 = m.mx * m.mx + m.my * m.my;
    let faded = false;
    if (len2 > 0.01) {
      const s = Math.min(1.6, (cx[t] * m.mx + cy[t] * m.my) / len2);
      if (s > 0.35) {
        const df = noisyDistance(m, cx[t] + (1 - s) * m.mx, cy[t] + (1 - s) * m.my, noise);
        faded = s < 1 && len2 > 0.1 && df < MATCH;
        d = Math.min(d, df);
      }
    }
    d /= 1 + 2.5 * dark;
    // much brighter than the fabric: a print or a logo, keep it. (A ratio alone isn't enough on a
    // near-black fabric, where 3.5× is still dark brown: the step must also show, 48 sRGB codes.)
    // On a coloured fabric, a bright patch of its own hue is wear (stonewashed knees, a sun-faded
    // back), which is dyed with it; on a black, grey or white one, hue can't tell, so it stays out.
    if (!faded && lum[t] > m.typical * 3.5 && toSrgb8(lum[t]) - toSrgb8(m.typical) > 48) d += 99;
    return d;
  }
  const MATCH = 2.7;

  // ---- 4. one-piece outfits: the bottoms are the top's fabric (a dress, a robe, a matching suit)
  let merged = false;
  let similar = false;
  if (merge && models.top && models.bottom) {
    const a = models.top, b = models.bottom;
    // (in the fabrics' own spreads: a dark fabric's chromaticity is noisy, so its spread is wide)
    const dChroma = Math.hypot(a.mx - b.mx, a.my - b.my) / Math.hypot(Math.max(a.sx, a.sy), Math.max(b.sx, b.sy));
    const dLum = Math.abs(Math.log(a.typical / b.typical));
    if (dChroma < 1 && dLum < 0.5) merged = true;
    // (kept for the island test below: a near-black robe's two halves can differ in brightness
    // more than that, but are still one cloth)
    similar = dChroma < 2;
  }

  // labels: 0 none, 1 top, 2 bottom, 3 shoes, 4 trim
  const label = new Uint8Array(N);
  const TOP = 1, BOTTOM = 2, SHOES = 3, TRIM = 4;
  const REGION_LABEL = { top: TOP, bottom: BOTTOM, shoes: SHOES };
  const CANDIDATES = { [TORSO]: ['top'], [ARM]: ['top'], [HEAD]: ['top'], [PELVIS]: ['bottom', 'top'], [LEG]: ['bottom', 'top', 'shoes'], [FOOT]: ['shoes', 'bottom'], [HAND]: [] };
  for (let t = 0; t < N; t++) {
    if (!covered[t]) continue;
    const p = part[t];
    if (p === HAND) continue;
    // (shoes only below the knee: a dark hem high on the thigh is never a boot)
    const thigh = p === LEG && lowW[t] < 0.5;
    // the garments that can be here, the part's own first: a shirt hangs over the hips, a coat or a
    // dress goes down the legs, boots up the calves, trouser hems down over the shoes. Another
    // garment takes a texel only when its fabric is clearly the closer match.
    const options = CANDIDATES[p];
    let best = 0, bestD = 99;
    for (const [k, region] of options.entries()) {
      if (thigh && region === 'shoes') continue;
      const d = fabricDistance(region, t) + (k && p !== PELVIS ? 1 : 0);
      if (d < bestD) { bestD = d; best = REGION_LABEL[region]; }
    }
    if (bestD > MATCH) continue;
    // skin-like texels only when they're a much better match for the fabric (khaki by a pale leg)
    if (isSkinLike(t) && !(bestD < 1.2 && skinDist[t] > bestD * 1.8)) continue;
    label[t] = best;
  }
  // Fabric drifts across a garment (shading painted in, fading, a dark fabric's colour sliding
  // towards grey as it darkens) further than one colour model holds, so grow each garment into
  // neighbours whose colour and brightness step only a little from it, as long as they stay within
  // a looser reach of its fabric. That fills the drift and stops at a print's or a seam's edge.
  {
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    for (let t = 0; t < N; t++) if (label[t]) queue[tail++] = t;
    const regionOf = [null, 'top', 'bottom', 'shoes'];
    while (head < tail) {
      const i = queue[head++];
      const l = label[i];
      const x = i % R, y = (i / R) | 0;
      for (const [ok, j] of [[x > 0, i - 1], [x < R - 1, i + 1], [y > 0, i - R], [y < R - 1, i + R]]) {
        if (!ok || label[j] || !covered[j] || island[j] !== island[i] || part[j] === HAND || isSkinLike(j)) continue;
        if (Math.abs(cx[j] - cx[i]) + Math.abs(cy[j] - cy[i]) > 0.06) continue;
        if (Math.abs(Math.log((lum[j] + 0.002) / (lum[i] + 0.002))) > 0.25) continue;
        if (fabricDistance(regionOf[l], j) > MATCH * 2.2) continue;
        label[j] = l;
        queue[tail++] = j;
      }
    }
  }
  // Boots: 'bottoms' (or a leather jacket's 'top') that cover only the calves of an island (whose
  // thigh is bare or another garment) and are the shoes' sort of colour are the shafts of boots,
  // not trousers. (A long skirt, a coat or a trouser leg reaches above the knee in its island; a
  // trouser leg cut at the knee into its own island is told apart by its colour.)
  if (models.shoes) {
    forEachIsland(island, (texels) => {
      for (const l of [BOTTOM, TOP]) {
        const mine = texels.filter((t) => label[t] === l && part[t] === LEG);
        if (mine.length < 50) continue;
        const low = mine.filter((t) => lowW[t] >= 0.5);
        if (low.length < mine.length * 0.85) continue;
        const d = low.map((t) => fabricDistance('shoes', t)).sort((a, b) => a - b)[low.length >> 1];
        if (d < MATCH * 1.5) for (const t of mine) label[t] = SHOES;
      }
    });
  }
  // One garment cut across both: when a big UV island carries a good share of each (an abaya's
  // panels, a dress whose skirt is cut with its bodice), top and bottoms are the same cloth.
  if (merge && !merged && similar) {
    forEachIsland(island, (texels) => {
      if (merged || texels.length < N * 0.01) return;
      let a = 0, b = 0;
      for (const t of texels) {
        if (label[t] === TOP) a++;
        else if (label[t] === BOTTOM) b++;
      }
      if (a + b > N * 0.01 && Math.min(a, b) > 0.2 * (a + b)) merged = true;
    });
  }
  if (merged) for (let t = 0; t < N; t++) if (label[t] === BOTTOM) label[t] = TOP;

  // a UV island is nearly always one garment: a thin strip of another's label inside one (trouser
  // hems weighted to the foot bones, a cuff, a collar's edge) is that island's garment, or nothing
  forEachIsland(island, (texels) => {
    const count = [0, 0, 0, 0];
    for (const t of texels) count[label[t]]++;
    const total = count[TOP] + count[BOTTOM] + count[SHOES];
    if (total < 50) return;
    const main = [TOP, BOTTOM, SHOES].reduce((a, b) => (count[b] > count[a] ? b : a));
    if (count[main] < total * 0.6) return;
    const region = Object.keys(REGION_LABEL).find((k) => REGION_LABEL[k] === main);
    for (const t of texels) {
      const l = label[t];
      if (l === main || !l || count[l] >= total * 0.15) continue;
      label[t] = fabricDistance(region, t) < MATCH + 2 ? main : 0;
    }
  });

  // ---- 5. reflective trim on a fluorescent top: bright, colourless bands touching it
  let trimFound = false;
  const top = models.top;
  if (top) {
    // the fabric's colour from its chromaticity: r/g = e^x, b/g = e^y
    const rr = Math.exp(top.mx), bb = Math.exp(top.my);
    const mx = Math.max(rr, 1, bb), mn = Math.min(rr, 1, bb);
    const sat = (mx - mn) / mx;
    // (hue as it looks, from sRGB: safety orange is about 15°, safety yellow-green about 70°)
    const enc = (l) => toSrgb8(l) / 255;
    const hue = hueOf(enc(rr / mx), enc(1 / mx), enc(bb / mx));
    const fluorescent = sat > 0.75 && hue > 10 && hue < 100 && top.typical > 0.12;
    if (fluorescent || forceTrim) {
      const vest = new Uint8Array(N);
      for (let t = 0; t < N; t++) vest[t] = label[t] === TOP ? 1 : 0;
      const near = morph(vest, R, true, 3);
      let cand = new Uint8Array(N);
      for (let t = 0; t < N; t++) {
        if (!covered[t] || label[t] === TOP || part[t] === HAND || isSkinLike(t)) continue;
        // (the tape picks up a little of the vest's colour round its edges)
        const r = tex.r[t], g = tex.g[t], b = tex.b[t];
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        if (hi > 0.25 && (hi - lo) / hi < 0.5) cand[t] = 1;
      }
      cand = dropSmall(open(close(cand, R, 1), R, 1), R, Math.round(N * 0.0003));
      // only bands on the vest: a pale shirt collar or sole elsewhere isn't tape, and the tape is
      // sewn onto the vest's own panels (the same UV islands), not a T-shirt's neck beside it
      cand = keepTouching(cand, near, R);
      const vestIslands = new Set();
      for (let t = 0; t < N; t++) if (vest[t]) vestIslands.add(island[t]);
      for (let t = 0; t < N; t++) if (cand[t] && vestIslands.has(island[t])) { label[t] = TRIM; trimFound = true; }
      // the tape's edges blend into the vest's orange, which passes for skin: where a skin-like
      // texel lies between the tape and the vest, it's the vest
      for (let pass = 0; pass < 2; pass++) {
        const next = label.slice();
        for (let t = 0; t < N; t++) {
          if (label[t] || !covered[t] || !isSkinLike(t) || !vestIslands.has(island[t])) continue;
          const x = t % R, y = (t / R) | 0;
          let top = false, trim = false;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= R || yy >= R) continue;
            const l = label[yy * R + xx];
            if (l === TOP) top = true;
            else if (l === TRIM) trim = true;
          }
          if (top && trim) next[t] = TOP;
        }
        label.set(next);
      }
    }
  }

  // ---- 6. clean-up per label: close specks, drop crumbs
  const minArea = Math.round(N * 0.00025);
  const cleaned = new Uint8Array(N);
  for (const l of [TOP, BOTTOM, SHOES, TRIM]) {
    let m = new Uint8Array(N);
    for (let t = 0; t < N; t++) m[t] = label[t] === l ? 1 : 0;
    m = close(m, R, 1);
    m = dropSmall(m, R, minArea);
    // closing may reach over skin or another garment: only fill what was unlabelled, non-skin cloth
    for (let t = 0; t < N; t++) if (m[t] && covered[t] && (label[t] === l || (label[t] === 0 && !isSkinLike(t) && part[t] !== HAND))) cleaned[t] = l;
  }

  fillHoles(cleaned, covered, R, Math.round(N * 0.0004), isSkinLike);

  // ---- region statistics, on the texels each label ended up with
  const regions = {};
  const names = { [TOP]: 'top', [BOTTOM]: 'bottom', [SHOES]: 'shoes', [TRIM]: 'trim' };
  const counts = {};
  for (const l of [TOP, BOTTOM, SHOES, TRIM]) {
    let n = 0, sl = 0, sr = 0, sg = 0, sb = 0;
    for (let t = 0; t < N; t++) if (cleaned[t] === l) { n++; sl += lum[t]; sr += tex.r[t]; sg += tex.g[t]; sb += tex.b[t]; }
    counts[names[l]] = n;
    // a region too small to see isn't worth a colour picker
    if (n < N * 0.002) { for (let t = 0; t < N; t++) if (cleaned[t] === l) cleaned[t] = 0; continue; }
    regions[names[l]] = { mean: round(sl / n, 4), colour: hex([sr / n, sg / n, sb / n]) };
  }

  // ---- 7. down to the output size: area-averaged labels give soft edges; then pad the islands
  const S = size;
  const f = R / S;
  const out = new Float32Array(S * S * 4);
  const cov = new Float32Array(S * S);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const t = y * R + x;
      const o = Math.floor(y / f) * S + Math.floor(x / f);
      if (covered[t]) cov[o] += 1;
      const l = cleaned[t];
      if (l) out[o * 4 + (l - 1)] += 1;
    }
  }
  const has = new Uint8Array(S * S);
  for (let o = 0; o < S * S; o++) {
    if (cov[o] > 0) {
      has[o] = 1;
      for (let c = 0; c < 4; c++) out[o * 4 + c] /= cov[o];
    }
  }
  pad(out, has, S, 24);
  const rgba = new Uint8Array(S * S * 4);
  for (let i = 0; i < out.length; i++) rgba[i] = Math.round(Math.min(1, out[i]) * 255);

  return {
    size: S,
    rgba,
    regions,
    stats: { analysis: R, merged, trim: trimFound, counts, skin: skin && { x: round(skin.mx, 3), y: round(skin.my, 3) }, models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, { x: round(m.mx, 3), y: round(m.my, 3), typical: round(m.typical, 4) }])) },
    debug: { R, covered, part, cleaned, skinLike: Uint8Array.from({ length: N }, (_, t) => (covered[t] && isSkinLike(t) ? 1 : 0)), srgb: tex.srgb, lum, rgb: tex },
    body,
  };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Spreads covered texels' values into the uncovered ones round them, ring by ring. */
export function pad(v, has, S, rings) {
  let cur = has;
  for (let k = 0; k < rings; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = y * S + x;
        if (cur[o]) continue;
        let n = 0;
        const acc = [0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= S || xx < 0 || xx >= S) continue;
          const q = yy * S + xx;
          if (!cur[q]) continue;
          n++;
          for (let c = 0; c < 4; c++) acc[c] += v[q * 4 + c];
        }
        if (n) {
          for (let c = 0; c < 4; c++) v[o * 4 + c] = acc[c] / n;
          next[o] = 1;
        }
      }
    }
    cur = next;
  }
}

// ------------------------------------------------------------------------------------ CPU tint

/**
 * The same sum as outfit-tint.ts's shader, on the CPU, for previews: sRGB bytes in and out.
 * `tints` maps region → [r, g, b] linear (or null to leave it).
 */
export function tintTexels(srgb, mask, n, regions, tints) {
  const order = ['top', 'bottom', 'shoes', 'trim'];
  const out = new Uint8Array(n * 3);
  for (let t = 0; t < n; t++) {
    const r = SRGB_TO_LINEAR[srgb[t * 3]], g = SRGB_TO_LINEAR[srgb[t * 3 + 1]], b = SRGB_TO_LINEAR[srgb[t * 3 + 2]];
    const l = luminance(r, g, b);
    let res = [r, g, b];
    for (let c = 0; c < 4; c++) {
      const reg = regions[order[c]];
      const tint = tints[order[c]];
      if (!reg || !tint) continue;
      const m = smooth(0.1, 0.9, mask[t * 4 + c] / 255);
      if (!m) continue;
      const d = detailCurve(l / reg.mean, reg.mean);
      res = res.map((v, k) => v + (Math.min(1, tint[k] * d) - v) * m);
    }
    for (let k = 0; k < 3; k++) out[t * 3 + k] = Math.min(255, Math.max(0, toSrgb8(res[k])));
  }
  return out;
}
/**
 * Bilinear resize of an RGBA mask, as the GPU samples it. (Not sharp: it premultiplies alpha when
 * resizing, which wipes R, G and B wherever A, the trim, is 0, i.e. nearly everywhere.)
 */
export function upsample(rgba, S, R) {
  const out = new Uint8Array(R * R * 4);
  for (let y = 0; y < R; y++) {
    const fy = Math.min(S - 1, Math.max(0, ((y + 0.5) * S) / R - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(S - 1, y0 + 1), ky = fy - y0;
    for (let x = 0; x < R; x++) {
      const fx = Math.min(S - 1, Math.max(0, ((x + 0.5) * S) / R - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(S - 1, x0 + 1), kx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = rgba[(y0 * S + x0) * 4 + c] * (1 - kx) + rgba[(y0 * S + x1) * 4 + c] * kx;
        const b = rgba[(y1 * S + x0) * 4 + c] * (1 - kx) + rgba[(y1 * S + x1) * 4 + c] * kx;
        out[(y * R + x) * 4 + c] = Math.round(a * (1 - ky) + b * ky);
      }
    }
  }
  return out;
}

/**
 * The texel's luminance ratio to its region's mean, as the dye uses it (outfit-tint.ts's
 * detailShape): a near-black fabric's contrast is softened and its shadows lifted, and detail
 * above the mean rolls off towards 2.5× (baked highlights on a dark fabric mustn't blow out).
 */
export function detailCurve(ratio, mean) {
  const t = Math.min(1, Math.max(0, Math.log10(mean / 0.003)));
  const d = ratio ** (0.6 + 0.4 * t);
  const floor = 0.4 * (1 - t);
  return d <= 1 ? floor + (1 - floor) * d : 1 + 1.5 * (1 - Math.exp(-(d - 1) / 1.5));
}
export const linearOf = (hexColour) => [1, 3, 5].map((i) => SRGB_TO_LINEAR[parseInt(hexColour.slice(i, i + 2), 16)]);

// ------------------------------------------------------------------------------------ CLI

export function openIO() {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/**
 * The whole step for a build script: analyses an uncompressed avatar document (`from`, default
 * `doc` itself), embeds the mask in `doc`'s body material and writes <metaDir>/outfit-<id>.json
 * (metaDir null: no file). Do it on base.glb's document before the crowd and hero variants are
 * cloned from it, and leave the texture named `outfitMask` out of KTX2 packing and sharp resizing:
 * it stays a 512 px PNG in both (about 10 KB), whatever size the body texture is.
 */
export async function maskAvatar(doc, id, { size = 512, from = doc, metaDir = join(WEB, '.people-cache/meta'), merge = true, forceTrim = false, bodyMaterial } = {}) {
  const t0 = performance.now();
  const mask = await makeOutfitMask(from, { size, merge, forceTrim, bodyMaterial });
  const bytes = await embedMask(doc, mask.body.getName(), mask);
  if (metaDir) {
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, `outfit-${id}.json`), JSON.stringify({ id, outfit: { regions: mask.regions } }, null, 2) + '\n');
  }
  return { ...mask, bytes, ms: Math.round(performance.now() - t0) };
}

/** Embeds a mask in the body material (replacing any earlier one). */
export async function embedMask(doc, bodyName, mask) {
  const root = doc.getRoot();
  const body = root.listMaterials().find((m) => m.getName() === bodyName);
  if (!body) throw new Error(`no material ${bodyName} to put the mask on`);
  for (const t of root.listTextures()) if (t.getName() === 'outfitMask') t.dispose();
  const extras = { ...body.getExtras() };
  delete extras.outfit;
  if (!Object.keys(mask.regions).length) {
    body.setExtras(extras);
    return null;
  }
  const png = await sharp(Buffer.from(mask.rgba), { raw: { width: mask.size, height: mask.size, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const tex = doc.createTexture('outfitMask').setImage(new Uint8Array(png)).setMimeType('image/png').setURI('outfitMask.png');
  if (body.getOcclusionTexture()) console.warn(`${bodyName} had an occlusion texture: replaced by the outfit mask`);
  body.setOcclusionTexture(tex).setOcclusionStrength(0);
  body.setExtras({ ...extras, outfit: { regions: mask.regions } });
  return png.length;
}

async function writeDebug(dir, id, mask) {
  mkdirSync(dir, { recursive: true });
  const { R, covered, part, cleaned, skinLike, srgb } = mask.debug;
  const N = R * R;
  const PART_COLOURS = [[230, 60, 60], [240, 150, 40], [250, 230, 210], [170, 60, 200], [40, 110, 230], [40, 200, 90], [120, 120, 120]];
  const LABEL_COLOURS = [null, [235, 40, 40], [40, 90, 240], [40, 210, 80], [255, 240, 0]];
  const img = (fn) => {
    const o = Buffer.alloc(N * 3);
    for (let t = 0; t < N; t++) {
      const c = fn(t);
      o[t * 3] = c[0]; o[t * 3 + 1] = c[1]; o[t * 3 + 2] = c[2];
    }
    return sharp(o, { raw: { width: R, height: R, channels: 3 } });
  };
  const tex = (t, k) => [srgb[t * 3] * k, srgb[t * 3 + 1] * k, srgb[t * 3 + 2] * k];
  const blend = (a, b, k) => a.map((v, i) => v * (1 - k) + b[i] * k);
  await img((t) => (covered[t] ? blend(tex(t, 1), PART_COLOURS[part[t]], 0.6) : [0, 0, 0])).png().toFile(join(dir, `${id}-parts.png`));
  await img((t) => (skinLike[t] ? blend(tex(t, 1), [255, 0, 255], 0.7) : tex(t, covered[t] ? 1 : 0.3))).png().toFile(join(dir, `${id}-skin.png`));
  await img((t) => (cleaned[t] ? blend(tex(t, 1), LABEL_COLOURS[cleaned[t]], 0.55) : tex(t, covered[t] ? 0.8 : 0.25))).png().toFile(join(dir, `${id}-labels.png`));
  // the dye itself, in UV space, with the mask as embedded (scaled up to the analysis size)
  const up = upsample(mask.rgba, mask.size, R);
  for (const [name, tints] of Object.entries(DEBUG_TINTS)) {
    const lin = Object.fromEntries(Object.entries(tints).map(([k, v]) => [k, linearOf(v)]));
    const o = tintTexels(srgb, up, N, mask.regions, lin);
    await sharp(Buffer.from(o), { raw: { width: R, height: R, channels: 3 } }).png().toFile(join(dir, `${id}-tint-${name}.png`));
  }
}
const DEBUG_TINTS = { red: { top: '#c0202a', bottom: '#1b2a4a', shoes: '#f0f0f0' }, mustard: { top: '#d9a521', bottom: '#151515', shoes: '#6b3e1e' } };

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const id = opt('id', null);
  const size = Number(opt('size', '512'));
  const from = opt('from', null);
  const metaDir = flag('no-meta') ? null : opt('meta', join(WEB, '.people-cache/meta'));
  const debugDir = opt('debug', null);
  const merge = !flag('no-merge');
  const forceTrim = flag('trim');
  const bodyMaterial = opt('body', undefined);
  const io = openIO();
  const report = (avatar, mask) => {
    const regions = Object.entries(mask.regions).map(([k, v]) => `${k} ${v.colour} mean ${v.mean}`).join(', ') || 'none';
    console.log(`${avatar}: ${regions}${mask.stats.merged ? ' (one-piece)' : ''} | mask ${mask.size}px ${mask.bytes ?? 0} B | ${mask.ms} ms`);
  };

  // --all: the meta for every converted avatar (each .people-cache/work/<id>/base.glb), one at a
  // time; an avatar that fails is reported and skipped
  if (flag('all')) {
    const work = join(WEB, '.people-cache/work');
    const ids = readdirSync(work).filter((d) => existsSync(join(work, d, 'base.glb'))).sort();
    let failed = 0;
    for (const avatar of ids) {
      try {
        const doc = await io.read(join(work, avatar, 'base.glb'));
        const mask = await maskAvatar(doc, avatar, { size, metaDir, merge, forceTrim });
        if (debugDir) await writeDebug(debugDir, avatar, mask);
        report(avatar, mask);
      } catch (e) {
        failed++;
        console.error(`${avatar}: ${e.message}`);
      }
    }
    console.log(`${ids.length - failed} of ${ids.length} avatars${metaDir ? ` → ${metaDir}` : ''}`);
    return;
  }

  const [input, output] = args;
  if (!input || !output) {
    console.error('usage: node scripts/people/masks.mjs <in.glb> <out.glb | -> [--id <AvatarId>] [--size 512] [--from <analysis.glb>] [--meta <dir> | --no-meta] [--debug <dir>] [--no-merge] [--trim] [--body <material>]\n       node scripts/people/masks.mjs --all [--meta <dir>] [--debug <dir>]');
    process.exit(2);
  }
  const avatar = id ?? basename(input).split('.')[0];
  const doc = await io.read(input);
  const src = from ? await io.read(from) : doc;
  const mask = await maskAvatar(doc, avatar, { size, from: src, metaDir, merge, forceTrim, bodyMaterial });
  if (output !== '-') await io.write(output, doc);
  if (debugDir) await writeDebug(debugDir, avatar, mask);
  report(avatar, mask);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
