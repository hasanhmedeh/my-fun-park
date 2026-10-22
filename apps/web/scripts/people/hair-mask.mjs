// Hair masks for hair painted into the head texture: most Rocketbox men's short hair is no more
// than paint on the skull, as is the scalp under everyone's hair cards, and beards and moustaches.
// The game tints that paint with the hair cards (src/world/crowd/hair-tint.ts) only where the head
// material carries a mask: a texture named `hairMask` in the head's UV space, R the scalp's hair, G
// facial hair, parked in the head material's occlusion slot at strength 0 as the outfit mask is on
// the body (takeHairMask takes it off before three would draw it as ambient occlusion). It stays a
// lossless PNG: 256 px in crowd files, 512 in hero files. convert.mjs calls makeHairMask on each
// avatar's base document; on its own this writes check images:
//
//   node scripts/people/hair-mask.mjs [ids…] --debug <dir> [--tints '#cfae74,#16110e']
//
// <dir>/<id>-hair-mask.png: the head texture, the mask over it (red scalp, green beard, the zones'
// edges in blue), then the texture tinted each colour as the game's shader would.
//
// How it decides, per texel of the head texture:
//   1. Where it is on the head. Every head triangle is drawn into UV space with its bind-pose
//      position, taken relative to the eyes (and scaled by how far apart they are, so a child's
//      head fits the same numbers): height above the eyes, and the angle round the skull's
//      vertical axis (0° the face, 90° the ears, 180° the back). Scalp hair can be anywhere over
//      the forehead's top edge, at the temples down to the sideburns, over the ears, and behind
//      them all the way down (the nape, and long hair modelled down the back); facial hair below
//      the cheekbones, in front of the ears, down the throat. The eyeballs (skinned to the eye
//      bones), the inside of the mouth (small islands tucked behind the lips), the brows, the
//      nostrils and the lips are never hair.
//   2. Its colour against the skin's and the hair's. The skin is sampled on the cheekbones and the
//      nose; the hair on the crown and the back of the head (from below a painted hat's brim, for
//      someone in a cap or a beanie), the beard on the chin and jaw. Each is a chromaticity model
//      (log R/G, log B/G, which shading doesn't change) and a band of brightness: dark brown hair
//      has skin's own chromaticity and is told apart only by being much darker, so skin keeps a
//      wide band below its median (its painted shadows: ear folds, the jaw's underside) before a
//      texel counts as darker than skin; blonde and grey hair are told apart by their chromaticity.
//      A texel nearer the hair than the skin is hair, softly (a painted hairline fades into skin,
//      and so does the mask).
//   3. Clean-up: specks closed, crumbs dropped (a mole, a stray shadow), each mask kept to what
//      joins its main areas, edges softened, then averaged down to the output size and spread past
//      the islands' edges so filtering doesn't fade the tint at the seams.
//
// Each one's tone, for the tint to keep the paint's light and shade relative to it (as hairTone
// does for the cards): mean linear luminance and colour over its texels. None when there's too
// little: a bald head has no scalp mask, a shaven face no beard. People in a headscarf, a keffiyeh
// or a burqa get none.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { META, cli, ensureDir, gltfIO, readJson } from './lib.mjs';
import { BONES, rigOf, skinned } from './measure.mjs';
import { basePathOf } from './hair-tone.mjs';
import { boxBlur, dominant, dropSmall, gaussian, morph, noisyDistance, pad, rasterise } from './masks.mjs';

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb8 = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.max(0, l) ** (1 / 2.4) - 0.055));
const hex = (rgb) => '#' + rgb.map((l) => Math.min(255, Math.max(0, toSrgb8(l))).toString(16).padStart(2, '0')).join('');
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const EPS = 0.004;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Tags (catalogue.mjs) of people whose hair is covered: no mask. (A hood is painted round the face.) */
const COVERED = new Set(['headscarf', 'keffiyeh', 'burqa', 'hood']);
/** Tags of people in a hat: modelled (islands of its own above the head) or painted on the crown. */
const HATS = new Set(['hat', 'cap', 'beanie']);
/** Analysis size (the head textures are 1024 px). */
const ANALYSIS = 1024;
/** The nape: on the head's own skin, hair behind the ears stops this far below the eyes (metres). */
const NAPE = -0.115;

/**
 * Where scalp hair may be, as the lowest height above the eyes (metres, for an adult's head) at
 * each angle round the head (degrees from the face): over the forehead only above the brows, then
 * down the temples to the sideburns, the ears, and behind them anything (long hair hangs down the
 * back).
 */
function scalpFloor(angle) {
  if (angle <= 45) return 0.048;
  if (angle <= 72) return 0.048 + ((angle - 45) / 27) * (-0.03 - 0.048);
  // (in front of the ears the sideburns come down to the jaw: a blond man with dark sideburns
  // looks dyed)
  if (angle <= 80) return -0.03 + ((angle - 72) / 8) * (-0.075 + 0.03);
  if (angle <= 105) return -0.075;
  if (angle <= 125) return -0.075 + ((angle - 105) / 20) * (-0.4 + 0.075);
  return -0.4;
}

/**
 * The hair masks of a base document (uncompressed, bind pose): `{ size, scalp, beard, tones }`, the
 * two masks as Float32Array (0…1) at the analysis size, or null when the avatar has no head
 * texture apart from its body, no eye bones, or covered hair.
 */
export async function makeHairMask(doc, parts, { tags = [], gender = 'm', age = 'adult' } = {}) {
  const male = gender === 'm';
  const child = age === 'child' || age === 'toddler';
  if (tags.some((t) => COVERED.has(t)) || !parts.head || parts.head === parts.body) return null;
  const root = doc.getRoot();
  const head = root.listMaterials().find((m) => m.getName() === parts.head);
  const texture = head?.getBaseColorTexture();
  const lod0 = root.listNodes().find((n) => n.getName() === 'LOD0');
  const prims = lod0?.getMesh().listPrimitives().filter((p) => p.getMaterial() === head) ?? [];
  if (!texture || !prims.length || !/png|jpe?g/.test(texture.getMimeType())) return null;
  const rig = rigOf(doc);
  if (!rig.byName.has(BONES.eye_l) || !rig.byName.has(BONES.eye_r)) return null;
  const el = rig.pos(BONES.eye_l);
  const er = rig.pos(BONES.eye_r);
  const eye = el.clone().add(er).multiplyScalar(0.5);
  // a child's head is smaller, not in proportion to their height: scale by the eyes' spacing
  const k = Math.min(1.15, Math.max(0.75, el.distanceTo(er) / 0.062));
  // the skull's vertical axis: through the head bone, which sits at the skull's base
  const axisZ = (rig.pos(BONES.Head).z - eye.z) / k;

  const R = ANALYSIS;
  const N = R * R;
  const covered = new Uint8Array(N);
  const H = new Float32Array(N); // height above the eyes
  const A = new Float32Array(N); // degrees round from the face
  const X = new Float32Array(N); // sideways from the middle of the face
  const Z = new Float32Array(N); // forward of the eyes
  const off = new Uint8Array(N); // never hair: eyeballs, inside the mouth
  const islandOf = new Int32Array(N).fill(-1); // UV island, numbered across the head's primitives
  let islandBase = 0;
  for (const prim of prims) {
    const vs = skinned(rig, lod0, prim);
    const n = vs.length;
    const uvA = prim.getAttribute('TEXCOORD_0');
    const uv = new Float32Array(n * 2);
    const e = [];
    for (let i = 0; i < n; i++) {
      uvA.getElement(i, e);
      uv[i * 2] = e[0];
      uv[i * 2 + 1] = e[1];
    }
    const pos = vs.map(({ p }) => [(p.x - eye.x) / k, (p.y - eye.y) / k, (p.z - eye.z) / k]);
    const eyeVert = vs.map(({ joint }) => /Eye$/.test(joint));
    const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: n }, (_, i) => i);
    // the inside of the mouth: small UV islands lying wholly within a box behind the lips (the
    // teeth, the tongue, the mouth's lining)
    const islands = uvIslands(uv, idx, n);
    const inside = new Uint8Array(islands.count).fill(1);
    const sizes = new Int32Array(islands.count);
    for (let t = 0; t < idx.length; t += 3) {
      const isl = islands.of[t / 3];
      sizes[isl]++;
      for (let c = 0; c < 3; c++) {
        const [x, y, z] = pos[idx[t + c]];
        if (Math.abs(x) > 0.045 || y < -0.1 || y > -0.035 || z > 0.045) inside[isl] = 0;
      }
    }
    const tris = Uint32Array.from(idx);
    for (let t = 0; t < tris.length; t += 3) {
      const isl = islands.of[t / 3];
      rasterise(R, uv, tris.subarray(t, t + 3), (texel, w0, w1, w2, a, b, c) => {
        covered[texel] = 1;
        const [pa, pb, pc] = [pos[a], pos[b], pos[c]];
        const x = w0 * pa[0] + w1 * pb[0] + w2 * pc[0];
        const y = w0 * pa[1] + w1 * pb[1] + w2 * pc[1];
        const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
        X[texel] = x;
        H[texel] = y;
        Z[texel] = z;
        A[texel] = (Math.abs(Math.atan2(x, z - axisZ)) * 180) / Math.PI;
        off[texel] = (inside[isl] && sizes[isl] < 400) || eyeVert[a] || eyeVert[b] || eyeVert[c] ? 1 : 0;
        islandOf[texel] = islandBase + isl;
      });
    }
    islandBase += islands.count;
  }
  // the head's own skin is its biggest island; the others are the eyes, the mouth, modelled hair
  // (a ponytail, a bun, long hair down the back) and painted-on hats
  const islandArea = new Int32Array(islandBase);
  for (let t = 0; t < N; t++) if (islandOf[t] >= 0) islandArea[islandOf[t]]++;
  const mainIsland = islandArea.indexOf(Math.max(...islandArea));
  let mainTop = -Infinity;
  const islandH = new Float64Array(islandBase);
  for (let t = 0; t < N; t++) {
    const i = islandOf[t];
    if (i < 0) continue;
    islandH[i] += H[t];
    if (i === mainIsland) mainTop = Math.max(mainTop, H[t]);
  }
  // a hat modelled in the head's own texture: islands sitting on top of the head, a sizeable share
  // of the texture (a pilot's cap, a chef's hat); otherwise a hat is painted on the crown
  let hatIslands = 0;
  for (let i = 0; i < islandBase; i++) if (i !== mainIsland && islandArea[i] > 0 && islandH[i] / islandArea[i] > 0.05) hatIslands += islandArea[i];
  const modelledHat = hatIslands > N * 0.02;

  // ---- colour: linear RGB, chromaticity from a 3×3 average (dark texels' own ratios are noise)
  const { data } = await sharp(Buffer.from(texture.getImage())).resize(R, R, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    r[i] = SRGB_TO_LINEAR[data[i * 3]];
    g[i] = SRGB_TO_LINEAR[data[i * 3 + 1]];
    b[i] = SRGB_TO_LINEAR[data[i * 3 + 2]];
  }
  const [br, bg, bb] = [r, g, b].map((c) => boxBlur(c, R));
  const lum = new Float32Array(N), cx = new Float32Array(N), cy = new Float32Array(N), ll = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = luminance(r[i], g[i], b[i]);
    ll[i] = Math.log(luminance(br[i], bg[i], bb[i]) + 0.002);
    cx[i] = Math.log((br[i] + EPS) / (bg[i] + EPS));
    cy[i] = Math.log((bb[i] + EPS) / (bg[i] + EPS));
  }

  // ---- zones
  const hat = tags.some((t) => HATS.has(t));
  const ear = new Float32Array(N);
  const scalpZone = new Float32Array(N);
  const beardZone = new Float32Array(N);
  for (let t = 0; t < N; t++) {
    if (!covered[t] || off[t]) continue;
    const h = H[t], a = A[t], x = Math.abs(X[t]);
    // (on the head's own skin, behind the ears, hair stops at the nape: below that is neck)
    const floor = islandOf[t] === mainIsland ? Math.max(scalpFloor(a), NAPE) : scalpFloor(a);
    scalpZone[t] = smooth(-0.006, 0.006, h - floor);
    // A woman's or a child's hair can frame the face, down the temples beside the eyes to the
    // cheeks: allowed there too, but only grown down from the hair above (see `clean`), and never
    // the eyebrows or the eyelids. (A man's cheeks there are his beard's.)
    if ((!male || child) && islandOf[t] === mainIsland && h > -0.11 && !(x < 0.056 && h > -0.015)) {
      scalpZone[t] = Math.max(scalpZone[t], smooth(34, 40, a) * (1 - smooth(85, 92, a)));
    }
    // modelled hair (a fringe, a bun, a ponytail) is its own islands, wherever it hangs; but under a
    // hat those islands are the hat
    // (a MakeHuman head's skin texture is the whole body's: the body's islands lie well below the
    // head, where long hair only hangs)
    if (islandOf[t] !== mainIsland) scalpZone[t] = hat || islandH[islandOf[t]] / islandArea[islandOf[t]] < -0.25 ? 0 : 1;
    // the ears: their folds are painted darker, so there it takes more to be hair
    ear[t] = (1 - smooth(0.8, 1.1, Math.hypot((a - 92) / 17, (h + 0.017) / 0.045))) * (islandOf[t] === mainIsland ? 1 : 0);
    // facial hair: below the cheekbones and in front of the ears, down the throat; not the
    // nostrils, nor the lips
    let w = (1 - smooth(95, 110, a)) * (1 - smooth(-0.026, -0.012, h)) * smooth(-0.21, -0.18, h);
    if (x < 0.022 && h > -0.05 && Z[t] > 0.0) w = 0;
    // (the lips themselves, where they always are, in front below the nose)
    if (Math.hypot(x / 0.027, (h + 0.069) / 0.011) < 1 && Z[t] > -0.015) w = 0;
    beardZone[t] = w * (1 - scalpZone[t]);
  }

  // ---- the skin: the cheekbones under the eyes and the nose's bridge, on the head's own skin (a
  // MakeHuman mouth's lining is its own island, behind the cheeks)
  const skinTexels = [];
  for (let t = 0; t < N; t++) {
    if (!covered[t] || off[t] || A[t] > 45 || islandOf[t] !== mainIsland) continue;
    const h = H[t], x = Math.abs(X[t]);
    if ((h < -0.012 && h > -0.034 && x > 0.022 && x < 0.05) || (x < 0.012 && h < 0.0 && h > -0.03)) skinTexels.push(t);
  }
  if (skinTexels.length < 200) return null;
  const median = (ts, arr) => {
    const v = ts.map((t) => arr[t]).sort((p, q) => p - q);
    return v[v.length >> 1];
  };
  const skinChroma = dominant(cx, cy, lum, skinTexels, 0.01);
  const skinL = median(skinTexels.filter((t) => noisyDistance(skinChroma, cx[t], cy[t], 0) < 2.5), ll);
  /** How unlike skin a texel is: chromaticity in the skin's spreads, and brightness outside its band. */
  const SKIN_DARK = Math.log(0.42);
  const SKIN_LIGHT = Math.log(1.9);
  const skinDistance = (t) => {
    const noise = 2.5 / Math.max(4, toSrgb8(lum[t]));
    const dc = noisyDistance(skinChroma, cx[t], cy[t], noise);
    const dl = ll[t] - skinL;
    const dlum = dl < SKIN_DARK ? (SKIN_DARK - dl) / 0.22 : dl > SKIN_LIGHT ? (dl - SKIN_LIGHT) / 0.3 : 0;
    return Math.hypot(dc, dlum);
  };
  const dSkin = new Float32Array(N);
  for (let t = 0; t < N; t++) if (covered[t]) dSkin[t] = skinDistance(t);
  // The lips: where they always are (above), and by their colour (redder than the skin) round
  // the mouth, and a little round both: a moustache and the tuft under the lower lip are facial
  // hair, the lips never.
  let lips = new Uint8Array(N);
  for (let t = 0; t < N; t++) {
    if (!covered[t] || off[t] || Math.abs(X[t]) > 0.032 || H[t] < -0.088 || H[t] > -0.052 || Z[t] < -0.015) continue;
    if (Math.hypot(X[t] / 0.027, (H[t] + 0.069) / 0.011) < 1 || (cx[t] > skinChroma.mx + 0.3 && dSkin[t] > 2)) lips[t] = 1;
  }
  lips = morph(morph(lips, R, true, 3), R, false, 1);
  for (let t = 0; t < N; t++) if (lips[t]) beardZone[t] = 0;

  // ---- a hair model from a sample zone: the dominant colour of what clearly isn't skin
  function model(sample, minShare, unlikeSkin = 3.5, core = 1) {
    let unlike = sample.filter((t) => dSkin[t] > unlikeSkin);
    if (unlike.length < Math.max(150, sample.length * minShare)) return null;
    const share = unlike.length / sample.length;
    // (a beard modelled on its most unlike texels: the goatee, not the stubble round it)
    if (core < 1) unlike = unlike.sort((p, q) => dSkin[q] - dSkin[p]).slice(0, Math.round(unlike.length * core));
    const m = dominant(cx, cy, lum, unlike, 0.004);
    const near = unlike.filter((t) => noisyDistance(m, cx[t], cy[t], 2.5 / Math.max(4, toSrgb8(lum[t]))) < 3);
    if (near.length < 100) return null;
    const ls = near.map((t) => ll[t]).sort((p, q) => p - q);
    return { ...m, l: ls[ls.length >> 1], lLo: ls[Math.floor(ls.length * 0.05)], lHi: ls[Math.floor(ls.length * 0.95)], share };
  }
  // scalp: the crown and the back of the head; under a painted hat, only below its brim at the back
  // and the sides, and the hat's own colour is kept out
  const crown = [], below = [], chin = [];
  for (let t = 0; t < N; t++) {
    if (!covered[t] || off[t]) continue;
    const h = H[t], a = A[t];
    if (scalpZone[t] > 0.9 && ((h > 0.075) || (a > 110 && h > -0.06))) crown.push(t);
    if (scalpZone[t] > 0.9 && a > 70 && h > -0.06 && h < 0.03) below.push(t);
    if (beardZone[t] > 0.9 && A[t] < 70 && h < -0.06 && h > -0.14) chin.push(t);
  }
  let hatModel = null;
  let scalp = hat ? model(below, 0.12) : model(crown, 0.12);
  if (hat && !modelledHat && mainTop > 0.09) {
    // a hat painted on the skull (a beanie): its colour is kept out of the hair, and when it's the
    // hair's own colour the two can't be told apart, so there's no scalp mask. (Under a modelled
    // hat the crown is the hair itself, hidden.)
    hatModel = model(crown.filter((t) => H[t] > 0.08), 0.3);
    if (hatModel && scalp && Math.hypot(hatModel.mx - scalp.mx, hatModel.my - scalp.my) < 0.15 && Math.abs(hatModel.l - scalp.l) < 0.6) scalp = null;
  }
  // facial hair: men's, and only a real beard or moustache, clearly unlike the skin (stubble is
  // the skin a shade darker, and stays as it is)
  let beard = male && !child ? model(chin, 0.1, 4, 0.4) : null;
  if (beard && beard.l > skinL + Math.log(0.4) && Math.hypot(beard.mx - skinChroma.mx, beard.my - skinChroma.my) < 0.25) beard = null;
  // A white or grey beard on light skin is as bright as the skin between its hairs, so its mask
  // comes out in patches, and a dye in patches reads as blotches: such a beard stays as it is.
  if (beard && beard.l > skinL - 0.4) beard = null;

  // ---- per texel: nearer the hair than the skin
  // (measured from the hair's colour or further along from the skin to it, up to twice as far: grey
  // hair's white strands and blonde's pale ones are more unlike skin than the hair's typical colour)
  function hairDistance(m, t) {
    const noise = 2.5 / Math.max(4, toSrgb8(lum[t]));
    const ex = m.mx - skinV[0], ey = m.my - skinV[1];
    const e2 = ex * ex + ey * ey;
    let sx = 0, sy = 0;
    if (e2 > 0.15 * 0.15) {
      const along = ((cx[t] - skinV[0]) * ex + (cy[t] - skinV[1]) * ey) / e2;
      if (along > 1) {
        sx = ex * (Math.min(along, 2) - 1);
        sy = ey * (Math.min(along, 2) - 1);
      }
    }
    const dc = noisyDistance(m, cx[t] - sx, cy[t] - sy, noise);
    const lo = m.lLo - 0.4, hi = m.lHi + 0.5;
    const dl = ll[t] < lo ? (lo - ll[t]) / 0.35 : ll[t] > hi ? (ll[t] - hi) / 0.35 : 0;
    return Math.hypot(dc, dl);
  }
  // How far a texel is along the way from the skin's colour to the hair's (log brightness and
  // chromaticity): a painted hairline fades out, and so does the mask; stubble and the ears'
  // painted folds are only part of the way, and stay out.
  const skinV = [skinChroma.mx, skinChroma.my, skinL];
  // Chromaticity and brightness each count where the hair differs from the skin by them: blonde
  // and grey hair by its colour (its highlights are as bright as skin), dark hair by its darkness.
  function fraction(m, t) {
    const dx = m.mx - skinV[0], dy = m.my - skinV[1], dl = m.l - skinV[2];
    const c2 = dx * dx + dy * dy;
    const fc = c2 > 0.15 * 0.15 ? ((cx[t] - skinV[0]) * dx + (cy[t] - skinV[1]) * dy) / c2 : 0;
    const fl = Math.abs(dl) > 0.5 ? (ll[t] - skinV[2]) / dl : 0;
    return Math.max(fc, fl);
  }
  function classify(m, zone, other, ramp) {
    const p = new Float32Array(N);
    if (!m) return p;
    for (let t = 0; t < N; t++) {
      if (!zone[t]) continue;
      const dh = hairDistance(m, t);
      let s = smooth(-0.8, 0.8, dSkin[t] - dh) * smooth(1.6, 2.8, dSkin[t]) * (1 - smooth(3.5, 5, dh));
      if (other) s *= smooth(-0.5, 0.5, hairDistance(other, t) - dh);
      const f = fraction(m, t);
      s *= smooth(ramp[0], ramp[1], f);
      if (ear[t]) s *= 1 - ear[t] * (1 - smooth(0.6, 0.85, f));
      p[t] = s * zone[t];
    }
    return p;
  }
  const scalpP = classify(scalp, scalpZone, hatModel, [0.15, 0.5]);
  const beardP = classify(beard, beardZone, null, [0.25, 0.7]);

  // A modelled piece of hair (its own island) that is mostly hair is hair throughout: its
  // highlights and the shadows between its locks too.
  {
    const hairy = new Int32Array(islandBase), area = new Int32Array(islandBase);
    for (let t = 0; t < N; t++) {
      const i = islandOf[t];
      if (i < 0 || i === mainIsland || off[t]) continue;
      area[i]++;
      if (scalpP[t] > 0.5) hairy[i]++;
    }
    for (let t = 0; t < N; t++) {
      const i = islandOf[t];
      if (i >= 0 && i !== mainIsland && !off[t] && area[i] > 500 && hairy[i] > area[i] * 0.6 && dSkin[t] > 1.2) scalpP[t] = Math.max(scalpP[t], 0.95);
    }
  }

  // Clean-up: closed, then only what joins a clear stretch of hair (hysteresis: texels over 0.85
  // in `core` spread through their neighbours over 0.35), so speckles of hair-coloured skin (a
  // blonde's yellowish neck, a fold's shadow) drop out while the hair's own soft edges stay.
  const clean = (p, minShare, core) => {
    let m = new Uint8Array(N);
    for (let t = 0; t < N; t++) m[t] = p[t] > 0.35 ? 1 : 0;
    m = morph(morph(m, R, true, 2), R, false, 2); // close
    const keep = new Uint8Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    for (let t = 0; t < N; t++) if (m[t] && p[t] > 0.85 && core(t)) { keep[t] = 1; queue[tail++] = t; }
    while (head < tail) {
      const i = queue[head++];
      const x = i % R, y = (i / R) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= R || yy >= R) continue;
          const j = yy * R + xx;
          if (m[j] && !keep[j]) { keep[j] = 1; queue[tail++] = j; }
        }
    }
    m = dropSmall(keep, R, Math.round(N * minShare));
    // soft edges: the probability inside the cleaned area, and its own 1-texel fringe
    const grown = morph(m, R, true, 1);
    const out = new Float32Array(N);
    for (let t = 0; t < N; t++) if (grown[t]) out[t] = m[t] ? Math.max(p[t], 0.35 * (p[t] > 0.15)) : p[t] * 0.5;
    const soft = boxBlur(out, R);
    // and where the hair thins out to stray wisps (a hairline fading into the neck), the mask fades
    // out with it: wisps tinted one by one read as specks
    const density = boxBlurWide(boxBlurWide(Float32Array.from(m), R, 4), R, 4);
    for (let t = 0; t < N; t++) soft[t] *= covered[t] * smooth(0.2, 0.55, density[t]);
    return soft;
  };
  const scalpMask = clean(scalpP, 0.002, (t) => H[t] > 0.03 || islandOf[t] !== mainIsland || A[t] > 120);
  const beardMask = smoothBeard(clean(beardP, 0.0004, (t) => H[t] < -0.05 && H[t] > -0.13), covered, lips, R);

  const tone = (mask) => {
    let n = 0, sl = 0;
    const s = [0, 0, 0];
    for (let t = 0; t < N; t++) {
      if (mask[t] < 0.6) continue;
      n++;
      sl += lum[t];
      s[0] += r[t]; s[1] += g[t]; s[2] += b[t];
    }
    // a few hundred texels of a 1024² texture is a sideburn's worth: not worth tinting
    if (n < N * 0.0015) return null;
    return { mean: round(sl / n, 4), colour: hex(s.map((v) => v / n)), texels: n };
  };
  const tones = { scalp: tone(scalpMask), beard: tone(beardMask) };
  if (!tones.scalp) scalpMask.fill(0);
  if (!tones.beard) beardMask.fill(0);
  if (!tones.scalp && !tones.beard) return null;
  return {
    size: R,
    scalp: scalpMask,
    beard: beardMask,
    tones,
    stats: { skin: { x: round(skinChroma.mx, 3), y: round(skinChroma.my, 3), l: round(skinL, 2) }, scalp: scalp && { x: round(scalp.mx, 3), y: round(scalp.my, 3), l: round(scalp.l, 2), share: round(scalp.share, 2) }, beard: beard && { x: round(beard.mx, 3), y: round(beard.my, 3), l: round(beard.l, 2), share: round(beard.share, 2) }, hat: hatModel && { x: round(hatModel.mx, 3), y: round(hatModel.my, 3), l: round(hatModel.l, 2), same: !!hatModel.same } },
    debug: { covered, scalpZone, beardZone, rgb: data, islandOf, mainIsland, off, H, A, X, dSkin, scalpP, beardP },
  };
}

/**
 * A beard's mask, evened out: a wide blur (about 6 texels of the 1024² analysis), brought back up to
 * full strength where the beard is dense, and kept within a few texels of where it was. A beard is a
 * soft thing at a distance, and a patchy one tinted in patches looks like blotches.
 */
function smoothBeard(mask, covered, lips, R) {
  const N = R * R;
  let soft = mask;
  for (let i = 0; i < 3; i++) soft = boxBlurWide(soft, R, 3);
  let near = new Uint8Array(N);
  for (let t = 0; t < N; t++) near[t] = mask[t] > 0.2 ? 1 : 0;
  near = morph(near, R, true, 4);
  const out = new Float32Array(N);
  for (let t = 0; t < N; t++) out[t] = near[t] && covered[t] && !lips[t] ? Math.min(1, Math.max(mask[t] * 0.6, soft[t] * 1.5)) : 0;
  return out;
}

/** A box blur of radius `r`, horizontally then vertically. */
function boxBlurWide(c, R, r) {
  const tmp = new Float32Array(R * R), out = new Float32Array(R * R);
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < R) { s += c[y * R + xx]; n++; }
      }
      tmp[y * R + x] = s / n;
    }
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < R) { s += tmp[yy * R + x]; n++; }
      }
      out[y * R + x] = s / n;
    }
  return out;
}

/** Connected UV islands of a primitive (triangles sharing a UV corner): an island id per triangle. */
function uvIslands(uv, idx, n) {
  const key = new Map();
  const corner = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(uv[i * 2] * 1e5)},${Math.round(uv[i * 2 + 1] * 1e5)}`;
    if (!key.has(k)) key.set(k, key.size);
    corner[i] = key.get(k);
  }
  const parent = Int32Array.from({ length: key.size }, (_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(corner[idx[t]]);
    parent[find(corner[idx[t + 1]])] = a;
    parent[find(corner[idx[t + 2]])] = a;
  }
  const ids = new Map();
  const of = new Int32Array(idx.length / 3);
  for (let t = 0; t < idx.length; t += 3) {
    const root = find(corner[idx[t]]);
    if (!ids.has(root)) ids.set(root, ids.size);
    of[t / 3] = ids.get(root);
  }
  return { of, count: ids.size };
}

/**
 * The mask as an RGB image at `size` (R scalp, G beard): area-averaged from the analysis size,
 * then spread a few texels past the islands' edges so filtering and mipmaps don't fade it at seams.
 */
export function hairMaskImage(m, size) {
  const f = m.size / size;
  const S = size;
  const out = new Float32Array(S * S * 4);
  const cov = new Float32Array(S * S);
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++) {
      const t = y * m.size + x;
      if (!m.debug.covered[t]) continue;
      const o = Math.floor(y / f) * S + Math.floor(x / f);
      cov[o]++;
      out[o * 4] += m.scalp[t];
      out[o * 4 + 1] += m.beard[t];
    }
  const has = new Uint8Array(S * S);
  for (let o = 0; o < S * S; o++)
    if (cov[o]) {
      has[o] = 1;
      out[o * 4] /= cov[o];
      out[o * 4 + 1] /= cov[o];
    }
  pad(out, has, S, 4);
  const rgb = new Uint8Array(S * S * 3);
  for (let o = 0; o < S * S; o++) {
    rgb[o * 3] = Math.round(Math.min(1, out[o * 4]) * 255);
    rgb[o * 3 + 1] = Math.round(Math.min(1, out[o * 4 + 1]) * 255);
  }
  return rgb;
}

/** Puts a mask (hairMaskImage's RGB at `size`) in the head material's occlusion slot, as a PNG named hairMask. */
export async function embedHairMask(doc, headName, rgb, size) {
  const root = doc.getRoot();
  const head = root.listMaterials().find((m) => m.getName() === headName);
  if (!head) throw new Error(`no material ${headName} to put the hair mask on`);
  for (const t of root.listTextures()) if (t.getName() === 'hairMask') t.dispose();
  const png = await sharp(Buffer.from(rgb), { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const tex = doc.createTexture('hairMask').setImage(new Uint8Array(png)).setMimeType('image/png').setURI('hairMask.png');
  if (head.getOcclusionTexture()) console.warn(`${headName} had an occlusion texture: replaced by the hair mask`);
  head.setOcclusionTexture(tex).setOcclusionStrength(0);
  return png.length;
}

/** The game's hair tint (hair-tint.ts) on the CPU, for the check images: sRGB bytes in, out. */
function tintTexels(rgb, mask, n, mean, tint) {
  const t0 = Math.min(1, Math.max(0, Math.log10(mean / 0.003)));
  const power = 0.6 + 0.4 * t0;
  const floor = 0.4 * (1 - t0);
  const lin = [1, 3, 5].map((i) => SRGB_TO_LINEAR[parseInt(tint.slice(i, i + 2), 16)]);
  const out = new Uint8Array(n * 3);
  for (let t = 0; t < n; t++) {
    const c = [0, 1, 2].map((k) => SRGB_TO_LINEAR[rgb[t * 3 + k]]);
    const w = mask[t];
    if (w > 0.01) {
      let d = (luminance(c[0], c[1], c[2]) / mean) ** power;
      d = d < 1 ? floor + (1 - floor) * d : 1 + 1.5 * (1 - Math.exp((1 - d) / 1.5));
      for (let k = 0; k < 3; k++) c[k] = c[k] + (Math.min(1, lin[k] * d) - c[k]) * w;
    }
    for (let k = 0; k < 3; k++) out[t * 3 + k] = toSrgb8(c[k]);
  }
  return out;
}

/** The check image: texture, mask overlay, and each tint (scalp and beard both), side by side at 512. */
export async function writeHairMaskDebug(file, id, m, tints) {
  const R = m.size;
  const N = R * R;
  const { rgb, scalpZone, beardZone } = m.debug;
  const overlay = Buffer.alloc(N * 3);
  for (let t = 0; t < N; t++) {
    const s = m.scalp[t], bd = m.beard[t];
    const edge = (scalpZone[t] > 0.45 && scalpZone[t] < 0.55) || (beardZone[t] > 0.45 && beardZone[t] < 0.55);
    for (let c = 0; c < 3; c++) {
      let v = rgb[t * 3 + c] * 0.8;
      v = v * (1 - s * 0.7) + (c === 0 ? 255 : 0) * s * 0.7;
      v = v * (1 - bd * 0.7) + (c === 1 ? 255 : 0) * bd * 0.7;
      overlay[t * 3 + c] = edge ? (c === 2 ? 255 : 40) : v;
    }
  }
  const panels = [Buffer.from(rgb), overlay];
  const both = new Float32Array(N);
  for (let t = 0; t < N; t++) both[t] = Math.max(m.scalp[t], m.beard[t]);
  for (const tint of tints) {
    // the scalp and the beard each relative to its own tone
    let px = Buffer.from(rgb);
    if (m.tones.scalp) px = Buffer.from(tintTexels(px, m.scalp, N, m.tones.scalp.mean, tint));
    if (m.tones.beard) px = Buffer.from(tintTexels(px, m.beard, N, m.tones.beard.mean, tint));
    panels.push(px);
  }
  const P = 512;
  const tiles = await Promise.all(panels.map((p) => sharp(p, { raw: { width: R, height: R, channels: 3 } }).resize(P, P).png().toBuffer()));
  const label = Buffer.from(`<svg width="${P * tiles.length}" height="22"><rect width="100%" height="22" fill="#000"/><text x="6" y="16" font-size="15" font-family="sans-serif" fill="#fff">${id}  scalp ${m.tones.scalp ? `${m.tones.scalp.colour} ${m.tones.scalp.mean}` : '-'}  beard ${m.tones.beard ? `${m.tones.beard.colour} ${m.tones.beard.mean}` : '-'}  ${JSON.stringify(m.stats).replace(/[<>&"]/g, '')}</text></svg>`);
  await sharp({ create: { width: P * tiles.length, height: P + 22, channels: 3, background: '#000' } })
    .composite([...tiles.map((input, i) => ({ input, left: i * P, top: 22 })), { input: label, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, ids } = cli();
  const list = ids.length ? ids : readdirSync(META).filter((f) => /^avatar-.+\.json$/.test(f)).map((f) => f.slice(7, -5));
  const tints = String(flags.tints ?? '#cfae74,#16110e').split(',');
  const io = await gltfIO();
  if (flags.debug) ensureDir(flags.debug);
  for (const id of list) {
    const spec = readJson(join(META, `avatar-${id}.json`));
    const base = basePathOf(id, spec.source);
    if (!existsSync(base)) {
      console.warn(`${id}: no ${base}`);
      continue;
    }
    const t0 = Date.now();
    const m = await makeHairMask(await io.read(base), spec.parts, { tags: spec.tags, gender: spec.gender, age: spec.age });
    const ms = Date.now() - t0;
    if (!m) {
      console.log(`${id.padEnd(24)} no mask`);
      continue;
    }
    console.log(`${id.padEnd(24)} scalp ${m.tones.scalp ? `${m.tones.scalp.colour} ${m.tones.scalp.mean} (${m.tones.scalp.texels})` : '-'}  beard ${m.tones.beard ? `${m.tones.beard.colour} ${m.tones.beard.mean} (${m.tones.beard.texels})` : '-'}  ${ms} ms`);
    if (flags.debug) await writeHairMaskDebug(join(flags.debug, `${id}-hair-mask.png`), id, m, tints);
  }
}
