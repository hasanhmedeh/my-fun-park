// Builds the MakeHuman people (makehuman-cast.mjs) as Rocketbox-rigged avatars: Blender with MPFB
// makes each one and poses it into the Biped's bind pose (makehuman-build.py), then
// makehuman-post.mjs rebuilds it on the Biped skeleton and writes the crowd GLB and its sidecar.
//
//   node scripts/people/makehuman.mjs setup                 Blender 4.5 LTS (portable), MPFB 2, the CC0 assets
//   node scripts/people/makehuman.mjs template              the Biped bind poses, from converted Rocketbox avatars
//   node scripts/people/makehuman.mjs <id…> | --all [--keep]
//   node scripts/people/makehuman.mjs prune                 deletes the downloaded assets the cast doesn't use
//
// Everything goes under .people-cache/: tools/blender-<v>-windows-x64/ (with a `portable` folder,
// so Blender keeps its settings and MPFB there, not in the user's profile), makehuman/data/ (the
// system assets), makehuman/extra/<pack>/ (the clothes packs), makehuman/template-<m|f>.json and
// makehuman/work/ (Blender's export and the uncompressed base.glb per person; --keep keeps them).
// Downloads are checked against their published SHA-256 and deleted once unpacked.
//
// The templates: the bind pose of a converted Rocketbox man and woman (.people-cache/work/
// Male_Adult_01/base.glb and Female_Adult_01's, from convert.mjs). Boys are posed as the man,
// girls and women as the woman, so they play the clip pack of their gender as Rocketbox people do.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DL, TOOLS, WORK, cli, download, ensureDir, run, writeJson } from './lib.mjs';
import { CAST, PACKS } from './makehuman-cast.mjs';
import { MH, postProcess } from './makehuman-post.mjs';
import { readBipedTemplate } from './makehuman-template.mjs';

const BLENDER_VERSION = '4.5.15';
const BLENDER_DIR = join(TOOLS, `blender-${BLENDER_VERSION}-windows-x64`);
const BLENDER = join(BLENDER_DIR, 'blender.exe');
const BLENDER_URL = `https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-windows-x64.zip`;
// MPFB 2.0.18 from the Blender extensions platform, which names its downloads by their SHA-256
const MPFB_SHA = 'c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad';
const MPFB_URL = `https://extensions.blender.org/download/sha256:${MPFB_SHA}/add-on-mpfb-v2.0.18.zip`;
const MPFB_DIR = join(BLENDER_DIR, 'portable', 'extensions', 'user_default', 'mpfb');
const ASSETS = (pack) => `https://files.makehumancommunity.org/asset_packs/${pack}/${pack}_cc0.zip`;
const DATA = join(MH, 'data');
const EXTRA = join(MH, 'extra');
const SCRIPT = fileURLToPath(new URL('./makehuman-build.py', import.meta.url));

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Unpacks a zip into `dir` (Git for Windows' unzip, or Windows' own tar, which reads zips too). */
function unzip(zip, dir) {
  ensureDir(dir);
  const r = spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { encoding: 'utf8' });
  if (r.status === 0) return;
  run(process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar', ['-xf', zip, '-C', dir]);
}

async function setup() {
  if (!existsSync(BLENDER)) {
    const zip = join(DL, 'blender', `blender-${BLENDER_VERSION}-windows-x64.zip`);
    await download(BLENDER_URL, zip);
    const sums = await (await fetch(`https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}.sha256`)).text();
    const want = sums.split('\n').find((l) => l.includes(`blender-${BLENDER_VERSION}-windows-x64.zip`))?.split(/\s+/)[0];
    if (!want || want !== sha256(zip)) throw new Error(`${zip}: SHA-256 doesn't match blender.org's`);
    unzip(zip, TOOLS);
    rmSync(zip);
    // the interface's translations are a tenth of it, and nothing here has an interface
    rmSync(join(BLENDER_DIR, BLENDER_VERSION.split('.').slice(0, 2).join('.'), 'datafiles', 'locale'), { recursive: true, force: true });
  }
  // a `portable` folder next to blender.exe keeps its config and extensions inside the cache
  ensureDir(join(BLENDER_DIR, 'portable'));
  if (!existsSync(join(MPFB_DIR, 'blender_manifest.toml'))) {
    const zip = join(DL, 'mpfb', 'add-on-mpfb-v2.0.18.zip');
    await download(MPFB_URL, zip);
    if (sha256(zip) !== MPFB_SHA) throw new Error(`${zip}: SHA-256 doesn't match extensions.blender.org's`);
    unzip(zip, MPFB_DIR);
    rmSync(zip);
  }
  for (const pack of ['makehuman_system_assets', ...PACKS]) {
    const dir = pack === 'makehuman_system_assets' ? DATA : join(EXTRA, pack);
    if (existsSync(join(dir, 'packs'))) continue;
    // the asset server publishes no checksums: these are CC0 data files, unpacked, never run
    const zip = join(DL, `mh-${pack}`, `${pack}_cc0.zip`);
    await download(ASSETS(pack), zip);
    unzip(zip, dir);
    rmSync(zip);
  }
  console.log(`Blender ${BLENDER_VERSION}, MPFB 2.0.18 and ${PACKS.length + 1} asset packs ready`);
}

async function templates() {
  for (const [g, id] of [['m', 'Male_Adult_01'], ['f', 'Female_Adult_01']]) {
    const src = join(WORK, id, 'base.glb');
    if (!existsSync(src)) {
      console.warn(`template-${g}: ${src} missing (run convert.mjs ${id} --keep)`);
      continue;
    }
    const tpl = await readBipedTemplate(src);
    writeJson(join(MH, `template-${g}.json`), tpl);
    console.log(`template-${g}: ${tpl.joints.length} nodes from ${id}, Bip01 at ${tpl.joints[0].wp[1].toFixed(3)} m`);
  }
}

/** Where a named asset is: the system assets first, then the packs. */
function asset(kind, name) {
  if (kind === 'skin') return join(DATA, 'skins', name, `${name}.mhmat`);
  if (kind === 'eyeColour') return join(DATA, 'eyes', 'materials', `${name}.mhmat`);
  const candidates = [join(DATA, kind, name, `${name}.mhclo`), ...(existsSync(EXTRA) ? readdirSync(EXTRA).map((p) => join(EXTRA, p, kind, name, `${name}.mhclo`)) : [])];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`no ${kind} asset ${name} (run setup)`);
  return found;
}

async function build(person, keep) {
  const work = ensureDir(join(MH, 'work'));
  const tplFile = join(MH, `template-${person.gender}.json`);
  if (!existsSync(tplFile)) throw new Error(`${tplFile} missing (run template)`);
  const job = {
    ...person,
    skin: asset('skin', person.skin),
    eyes: asset('eyes', 'low-poly'),
    eyesMaterial: asset('eyeColour', person.eyes),
    eyebrows: asset('eyebrows', person.eyebrows),
    eyelashes: asset('eyelashes', person.eyelashes),
    hair: asset('hair', person.hair),
    clothes: person.clothes.map((c) => asset('clothes', c)),
    roles: person.roles ?? ['guest'],
    template: tplFile,
    out: join(work, `${person.id}.raw.glb`),
  };
  const jobFile = join(work, `${person.id}.job.json`);
  writeJson(jobFile, job);
  const t0 = Date.now();
  const log = run(BLENDER, ['--background', '--factory-startup', '--python', SCRIPT, '--', jobFile]);
  const ok = log.split('\n').find((l) => l.startsWith('MH-BUILD-OK'));
  if (!ok) throw new Error(`${person.id}: Blender didn't finish:\n${log.slice(-3000)}`);
  console.log(`  ${ok.replace('MH-BUILD-OK ', 'blender: ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const spec = await postProcess(person.id);
  if (!keep) for (const f of [`${person.id}.raw.glb`, `${person.id}.raw.json`]) rmSync(join(work, f), { force: true });
  return spec;
}

/** Deletes the clothes, hair and skins no one in the cast wears (their pack listings stay, for the credits). */
function prune() {
  const used = new Set(CAST.flatMap((p) => [p.skin, p.hair, p.eyebrows, p.eyelashes, ...p.clothes]));
  let freed = 0;
  const du = (d) => readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? du(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
  const dirs = [
    ...['clothes', 'hair', 'eyebrows', 'eyelashes', 'skins'].map((k) => join(DATA, k)),
    ...(existsSync(EXTRA) ? readdirSync(EXTRA).map((p) => join(EXTRA, p, 'clothes')) : []),
  ].filter(existsSync);
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (used.has(name) || !statSync(join(dir, name)).isDirectory()) continue;
      freed += du(join(dir, name));
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  for (const d of ['proxymeshes', 'teeth', 'tongue']) {
    if (!existsSync(join(DATA, d))) continue;
    freed += du(join(DATA, d));
    rmSync(join(DATA, d), { recursive: true, force: true });
  }
  console.log(`pruned ${(freed / 1e6).toFixed(0)} MB of unused assets`);
}

const { flags, ids } = cli();
if (ids[0] === 'setup') await setup();
else if (ids[0] === 'template') await templates();
else if (ids[0] === 'prune') prune();
else {
  const list = flags.all ? CAST : ids.map((id) => CAST.find((p) => p.id === id) ?? (() => { throw new Error(`no cast member ${id}`); })());
  if (!list.length) {
    console.error('usage: node scripts/people/makehuman.mjs setup | template | prune | <id…> | --all [--keep]');
    process.exit(2);
  }
  for (const person of list) {
    try {
      const s = await build(person, flags.keep);
      console.log(`${s.id}: crowd ${(s.bytes.crowd / 1024).toFixed(0)} KB, tris ${s.stats.tris.join('/')}, h ${s.height} hip ${s.hip} seat ${s.seatDrop} (${s.stats.seconds} s)`);
    } catch (e) {
      console.error(`${person.id}: FAILED ${e.stack || e}`);
      process.exitCode = 1;
    }
  }
}
