// A contact sheet of every avatar's outfit mask and one dye, rendered in 3D, to look the masks over
// in one go: per avatar, its own clothes, the mask (top magenta, bottoms blue, shoes green, trim
// yellow) and a dye, front on (and with --back from behind too).
//
//   node scripts/people/masks-review.mjs [id…] [--dir models/people/] [--suffix .crowd]
//        [--tint red|mustard|teal|redAll] [--per 3] [--back] [--out <sheet.jpg>] [--port 5199]
//
// Without ids it takes every <dir>/*<suffix>.glb (under public/) that carries an `outfitMask`.
// Renders go through scripts/shot.mjs and the preview scene people-tint, so the dev server must be
// running (npx vite --port 5199); the sheet is a JPEG (default .people-cache/work/masks/review.jpg).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const WEB = resolve(fileURLToPath(import.meta.url), '../../..');

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
const dir = opt('dir', 'models/people/').replace(/\/?$/, '/');
const suffix = opt('suffix', '.crowd');
const tint = opt('tint', 'red');
const per = Number(opt('per', '3'));
const port = opt('port', '5199');
const out = resolve(opt('out', join(WEB, '.people-cache/work/masks/review.jpg')));
const back = flag('back');

/** Whether a GLB carries the outfit mask (an image named outfitMask in its JSON). */
function hasMask(file) {
  const b = readFileSync(file);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  return (json.images ?? []).some((i) => i.name === 'outfitMask') || (json.textures ?? []).some((t) => t.name === 'outfitMask');
}

let names = [...args];
if (!names.length) {
  const abs = join(WEB, 'public', dir);
  names = readdirSync(abs)
    .filter((f) => f.endsWith(`${suffix}.glb`) && hasMask(join(abs, f)))
    .map((f) => f.slice(0, -4 - suffix.length))
    .sort();
}
if (!names.length) {
  console.error(`no avatars with an outfit mask in public/${dir}*${suffix}.glb`);
  process.exit(1);
}

const SHOT_W = 2400, SHOT_H = 760;
const tmp = mkdtempSync(join(tmpdir(), 'masks-review-'));
const shots = [];
const t0 = Date.now();
try {
  for (let i = 0; i < names.length; i += per) {
    const group = names.slice(i, i + per);
    for (const turn of back ? [0, 180] : [0]) {
      const file = join(tmp, `${shots.length}.png`);
      const query = `?scene=people-tint&env=0&dir=${encodeURIComponent(dir)}&suffix=${encodeURIComponent(suffix)}&avatars=${group.join(',')}&variants=own,mask,${tint}&turn=${turn}`;
      // (a wide frame: a row of figures fills it without a band of sky and floor)
      execFileSync(process.execPath, [join(WEB, 'scripts/shot.mjs'), query, file, '--size', `${SHOT_W}x${SHOT_H}`, '--port', port], { stdio: ['ignore', 'ignore', 'inherit'] });
      if (!existsSync(file)) throw new Error(`no render for ${group.join(', ')}`);
      shots.push(file);
      console.log(`${group.join(', ')}${turn ? ' (back)' : ''}: rendered`);
    }
  }
  // one render a row at full size, or two at half size for a long sheet
  const COLS = shots.length > 12 ? 2 : 1;
  const W = SHOT_W / COLS, H = SHOT_H / COLS;
  const rows = Math.ceil(shots.length / COLS);
  const tiles = await Promise.all(shots.map(async (f, k) => ({ input: await sharp(f).resize(W, H).toBuffer(), left: (k % COLS) * W, top: Math.floor(k / COLS) * H })));
  mkdirSync(resolve(out, '..'), { recursive: true });
  await sharp({ create: { width: W * COLS, height: H * rows, channels: 3, background: '#202024' } }).composite(tiles).jpeg({ quality: 86 }).toFile(out);
  console.log(`${names.length} avatars, ${shots.length} renders → ${out} (${Math.round((Date.now() - t0) / 1000)} s)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
