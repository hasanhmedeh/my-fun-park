// Downloads Rocketbox avatars from the pinned commit: each one's FBX, only the textures that FBX
// uses (minus the specular maps, which the conversion drops) and its preview PNG (for the
// customiser's portrait), into .people-cache/dl/<id>/.
//
//   node scripts/people/fetch.mjs Male_Adult_01 Female_Adult_04 …   (or --starter, --all)
//
// Already-downloaded files are kept (sizes are checked against the repo's tree). An avatar's
// download is about 60–95 MB, almost all of it 2048² TGAs, so convert.mjs deletes it as soon as
// it's converted; run-all.mjs fetches and converts one avatar at a time.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AVATARS, STARTER, avatar } from './catalogue.mjs';
import { DL, cli, download, rawUrl, repoTree } from './lib.mjs';

/** The texture file names an FBX refers to (binary FBX keeps them as plain strings, as absolute Max paths). */
function fbxTextures(fbxFile) {
  const text = readFileSync(fbxFile).toString('latin1');
  const names = new Set();
  for (const m of text.matchAll(/[\w\-. \\/:]+?\.(?:tga|png|jpg|jpeg|dds)/gi)) names.add(m[0].split(/[\\/]/).pop().toLowerCase());
  return [...names];
}

/** Fetches one avatar; returns its local paths. */
export async function fetchAvatar(id) {
  const a = avatar(id);
  const { files } = await repoTree();
  const base = `Assets/Avatars/${a.folder}/${id}/`;
  const inFolder = files.filter((f) => f.path.startsWith(base));
  if (!inFolder.length) throw new Error(`${id}: nothing at ${base}`);
  const dir = join(DL, id);
  const get = async (f) => download(rawUrl(f.path), join(dir, basename(f.path)), f.size);

  const fbxEntry = inFolder.find((f) => f.path === `${base}Export/${id}.fbx`);
  if (!fbxEntry) throw new Error(`${id}: no Export/${id}.fbx`);
  const fbx = await get(fbxEntry);

  const textures = [];
  const missing = [];
  for (const name of fbxTextures(fbx)) {
    if (/_specular\./.test(name)) continue;
    const f = inFolder.find((e) => e.path.toLowerCase() === `${base}Textures/${name}`.toLowerCase());
    if (!f) {
      missing.push(name);
      continue;
    }
    textures.push(await get(f));
  }
  const previewEntry = inFolder.find((f) => f.path === `${base}${id}.png`);
  const preview = previewEntry ? await get(previewEntry) : null;
  return { id, dir, fbx, textures, missing, preview };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('fetch.mjs')) {
  const { flags, ids } = cli();
  const list = flags.all ? AVATARS.map((a) => a.id) : flags.starter ? STARTER : ids;
  if (!list.length) {
    console.error('usage: node scripts/people/fetch.mjs <id…> | --starter | --all');
    process.exit(2);
  }
  for (const id of list) {
    const t = Date.now();
    const r = await fetchAvatar(id);
    console.log(`${id}: ${r.textures.length} textures${r.missing.length ? `, missing ${r.missing.join(', ')}` : ''} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
}
