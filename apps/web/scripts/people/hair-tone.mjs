// The hair's own tone (AvatarSpec.hairTone): the mean linear luminance and the colour of the hair
// cards in the hair material's texture, which the game's hair tint keeps the strands' detail
// relative to, as outfit-tint.ts does for clothes. convert.mjs and makehuman-post.mjs call
// hairTone() on each avatar's base document; on its own this fills in the sidecars from the
// base.glb files already built:
//
//   node scripts/people/hair-tone.mjs [ids…] [--debug dir]   (no ids: every avatar with a sidecar)
//
// --debug writes <id>-hair.png per avatar: the hair texture with the texels that count lit, the
// lashes, brows and eyes left out in red, and everything else dimmed, with the tone as a swatch.
//
// The hair material holds more than hair: Rocketbox's lashes and brows are cards in it too, and
// MakeHuman's atlas also has the eyeballs. Those are the separate pieces of the mesh that lie
// wholly in a box around the eyes (scaled by how far apart the eyes are, so children's fit), and
// they're left out. Of the rest, the texels the triangles cover in UV space and that are
// opaque enough to be drawn (alpha over a half) are averaged. A person whose hair material has no
// cards left after that (bald, or a hat with nothing showing) has no tone, and nor has anyone in a
// headscarf, a keffiyeh or a burqa: their hair material holds the cloth's fringe and tassels.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { CACHE, META, WORK, cli, ensureDir, gltfIO, readJson, writeJson } from './lib.mjs';
import { BONES, rigOf, skinned } from './measure.mjs';

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb8 = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.max(0, l) ** (1 / 2.4) - 0.055));
const hex = (rgb) => '#' + rgb.map((l) => Math.min(255, Math.max(0, toSrgb8(l))).toString(16).padStart(2, '0')).join('');

/** Tags (catalogue.mjs, makehuman-cast.mjs) of people whose hair is covered. */
const COVERED = new Set(['headscarf', 'keffiyeh', 'burqa']);
/** Below this many opaque hair texels (of a 1024² atlas, scaled to the real size) there's no hair to speak of. */
const MIN_TEXELS = 400;
/** The eye box around an adult's eyes (metres, for eyes 6.4 cm apart): sideways past each eye, below and above their centres, and behind them. */
const EYE_BOX = { side: 0.045, below: 0.03, above: 0.05, behind: 0.035 };

/** Connected pieces of an indexed triangle list: a piece id per triangle. */
function pieces(idx, count) {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  const ids = new Map();
  const out = new Int32Array(idx.length / 3);
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    if (!ids.has(r)) ids.set(r, ids.size);
    out[t / 3] = ids.get(r);
  }
  return { of: out, count: ids.size };
}

/**
 * The hair tone of a base document (bind pose, uncompressed textures), or null when it has no
 * hair cards; `tags` are the avatar's. `debug`: a PNG path for the check image.
 */
export async function hairTone(doc, parts, { tags = [], debug } = {}) {
  if (!parts.hair || tags.some((t) => COVERED.has(t))) return null;
  const root = doc.getRoot();
  const material = root.listMaterials().find((m) => m.getName() === parts.hair);
  const texture = material?.getBaseColorTexture();
  const lod0 = root.listNodes().find((n) => n.getName() === 'LOD0');
  const prims = lod0?.getMesh().listPrimitives().filter((p) => p.getMaterial() === material) ?? [];
  if (!texture || !prims.length) return null;

  // the eye box, in the bind pose (the avatar faces +z, its left at +x)
  const rig = rigOf(doc);
  const has = (b) => rig.byName.has(b);
  let box = null;
  if (has(BONES.eye_l) && has(BONES.eye_r)) {
    const l = rig.pos(BONES.eye_l);
    const r = rig.pos(BONES.eye_r);
    const k = Math.min(1.2, Math.max(0.7, l.distanceTo(r) / 0.064));
    box = {
      x0: Math.min(l.x, r.x) - EYE_BOX.side * k,
      x1: Math.max(l.x, r.x) + EYE_BOX.side * k,
      y0: (l.y + r.y) / 2 - EYE_BOX.below * k,
      y1: (l.y + r.y) / 2 + EYE_BOX.above * k,
      z0: Math.min(l.z, r.z) - EYE_BOX.behind * k,
    };
  }

  const { data: px, info } = await sharp(Buffer.from(texture.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const used = new Uint8Array(W * H); // 1 counted, 2 left out (lashes, brows, eyes)
  for (const prim of prims) {
    const pos = skinned(rig, lod0, prim).map((v) => v.p);
    const uvA = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.length }, (_, i) => i);
    const piece = pieces(idx, pos.length);
    // a piece is face fuzz when every vertex of it is in the eye box
    const inBox = new Uint8Array(piece.count).fill(box ? 1 : 0);
    if (box)
      for (let t = 0; t < idx.length; t += 3)
        for (let c = 0; c < 3; c++) {
          const p = pos[idx[t + c]];
          if (p.x < box.x0 || p.x > box.x1 || p.y < box.y0 || p.y > box.y1 || p.z < box.z0) inBox[piece.of[t / 3]] = 0;
        }
    const uv = [];
    const e = [];
    for (let i = 0; i < uvA.getCount(); i++) uv.push(uvA.getElement(i, e).map((v) => Math.min(1, Math.max(0, v))));
    for (let t = 0; t < idx.length; t += 3) {
      const mark = inBox[piece.of[t / 3]] ? 2 : 1;
      const [a, b, c] = [uv[idx[t]], uv[idx[t + 1]], uv[idx[t + 2]]].map(([u, v]) => [u * W, v * H]);
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const [qx, qy] = [x + 0.5, y + 0.5];
          const w0 = ((b[0] - qx) * (c[1] - qy) - (b[1] - qy) * (c[0] - qx)) / area;
          const w1 = ((c[0] - qx) * (a[1] - qy) - (c[1] - qy) * (a[0] - qx)) / area;
          if (w0 < -1e-4 || w1 < -1e-4 || 1 - w0 - w1 < -1e-4) continue;
          // a texel a hair card and a lash share stays out (the atlas packs them tightly)
          const i = y * W + x;
          if (used[i] !== 2) used[i] = mark;
        }
    }
  }

  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < W * H; i++) {
    if (used[i] !== 1 || px[i * 4 + 3] <= 127) continue;
    n++;
    for (let c = 0; c < 3; c++) sum[c] += SRGB_TO_LINEAR[px[i * 4 + c]];
  }
  const enough = n >= MIN_TEXELS * ((W * H) / (1024 * 1024));
  const rgb = sum.map((s) => s / Math.max(1, n));
  const tone = enough ? { mean: Math.round((0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) * 10000) / 10000, colour: hex(rgb) } : null;

  if (debug) {
    const out = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const a = px[i * 4 + 3] > 127;
      for (let c = 0; c < 3; c++) {
        const v = px[i * 4 + c];
        out[i * 3 + c] = used[i] === 1 && a ? v : used[i] === 2 && a ? (c === 0 ? 255 : v >> 2) : (v >> 3) + 24;
      }
    }
    // the tone as a swatch in the top left corner
    const sw = Math.round(W / 8);
    if (tone) for (let y = 0; y < sw; y++) for (let x = 0; x < sw; x++) for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = parseInt(tone.colour.slice(1 + c * 2, 3 + c * 2), 16);
    await sharp(out, { raw: { width: W, height: H, channels: 3 } }).resize(512, 512, { fit: 'fill' }).png().toFile(debug);
  }
  return tone ? { ...tone, texels: n } : null;
}

/**
 * AvatarSpec.hairTone from the cards' tone (hairTone(); null without cards) and the painted hair's
 * (hair-mask.mjs's `tones`, or a sidecar's hairTone: its `scalp` and `beard`, each missing or null
 * where the head has no mask for it). An avatar without cards takes the painted scalp's tone, or
 * else the beard's, as its own. Undefined when there's no tone at all.
 */
export function hairToneSpec(cards, painted) {
  const own = (t) => (t ? { mean: t.mean, colour: t.colour } : null);
  const scalp = own(painted?.scalp);
  const beard = own(painted?.beard);
  const main = own(cards) ?? scalp ?? beard;
  return main ? { ...main, ...(scalp && { scalp }), ...(beard && { beard }) } : undefined;
}

/** Where an avatar's base document is: the Rocketbox pipeline's or the MakeHuman step's. */
export function basePathOf(id, source) {
  return source === 'makehuman' ? join(CACHE, 'makehuman', 'work', id, 'base.glb') : join(WORK, id, 'base.glb');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, ids } = cli();
  const list = ids.length ? ids : readdirSync(META).filter((f) => /^avatar-.+\.json$/.test(f)).map((f) => f.slice(7, -5));
  const io = await gltfIO();
  if (flags.debug) ensureDir(flags.debug);
  for (const id of list) {
    const file = join(META, `avatar-${id}.json`);
    const spec = readJson(file);
    const base = basePathOf(id, spec.source);
    if (!existsSync(base)) {
      console.warn(`${id}: no ${base}`);
      continue;
    }
    const tone = await hairTone(await io.read(base), spec.parts, { tags: spec.tags, debug: flags.debug ? join(flags.debug, `${id}-hair.png`) : undefined });
    // (the painted hair's tones, which convert.mjs records with the masks it embeds, are kept)
    const next = hairToneSpec(tone, spec.hairTone);
    if (next) spec.hairTone = next;
    else delete spec.hairTone;
    writeJson(file, spec);
    console.log(`${id.padEnd(24)} ${tone ? `${tone.colour} mean ${tone.mean} (${tone.texels} texels)` : 'no hair'}`);
  }
}
