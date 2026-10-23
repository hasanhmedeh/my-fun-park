// Assembles public/models/people/manifest.json (the PeopleManifest in
// src/world/crowd/people-manifest.ts) from what the other steps left behind, checks it, and
// writes LICENSE-rocketbox.txt next to the GLBs.
//
//   node scripts/people/build-manifest.mjs [--no-tsc]
//
// Inputs:
//   .people-cache/meta/avatar-<id>.json    one AvatarSpec per avatar (convert.mjs for Rocketbox, the
//                                          MakeHuman step for its own); a `stats` field is left out,
//                                          an optional `sets: string[]` adds the avatar to those sets
//   .people-cache/meta/outfit-<id>.json    { id, outfit }: the recolouring regions (the masks step)
//   .people-cache/work/anim/pack-<g>.json  the native clip packs 'm' and 'f' (clips.mjs)
//   .people-cache/meta/clippack-<name>.json other clip packs, keyed <name> (the retargeting step)
//   .people-cache/meta/rig-<name>.json     extra RigSpecs, keyed <name> (if a source brings its own skeleton)
//   catalogue.mjs                          the sets
//
// Checks: every file the manifest names exists and its size is recorded as it is on disk, each
// GLB has the materials, LOD nodes and bones the manifest says, every avatar's rig and every
// set's avatars exist; then the manifest is type-checked against the real contract with tsc
// (excess fields are errors), unless --no-tsc. Two clips an avatar could play under one name (in
// its gender's pack and an 'any' pack of its rig, or twice in one pack) stop the build.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SETS } from './catalogue.mjs';
import { META, OUT, ROCKETBOX, WEB, WORK, cli, ensureDir, readJson, run, size, writeJson } from './lib.mjs';
import { RIG } from './measure.mjs';

const AVATAR_KEYS = ['id', 'source', 'rig', 'gender', 'age', 'skin', 'roles', 'tags', 'files', 'bytes', 'lods', 'height', 'hip', 'seatDrop', 'anchors', 'parts', 'outfit', 'hairTone', 'portrait'];
const PACK_KEYS = ['file', 'rig', 'gender', 'refHeight', 'refHip', 'clips', 'bytes'];
const CANONICAL = new Set(Object.keys(RIG.bones));

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const metaFiles = (prefix) => (existsSync(META) ? readdirSync(META).filter((f) => f.startsWith(prefix) && f.endsWith('.json')) : []);

/** The JSON chunk of a GLB. */
function glbJson(file) {
  const b = readFileSync(file);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}

export function buildManifest() {
  const problems = [];
  const warn = (m) => problems.push(m);

  // ---- rigs
  const rigs = { rocketbox: RIG };
  for (const f of metaFiles('rig-')) rigs[f.slice(4, -5)] = readJson(join(META, f));

  // ---- clip packs
  const clipPacks = {};
  for (const g of ['m', 'f']) {
    const f = join(WORK, 'anim', `pack-${g}.json`);
    if (existsSync(f)) clipPacks[g] = pick(readJson(f), PACK_KEYS);
    else warn(`no native clip pack '${g}' (run clips.mjs)`);
  }
  for (const f of metaFiles('clippack-')) clipPacks[f.slice(9, -5)] = pick(readJson(join(META, f)), PACK_KEYS);
  for (const [key, p] of Object.entries(clipPacks)) {
    const file = join(OUT, p.file);
    if (!existsSync(file)) {
      warn(`clip pack ${key}: ${p.file} is missing`);
      continue;
    }
    p.bytes = size(file);
    if (!rigs[p.rig]) warn(`clip pack ${key}: unknown rig ${p.rig}`);
  }

  // an avatar plays the packs of its rig made for its gender or for 'any': within those, a name
  // must mean one clip (the men's and the women's Walk_Loop are the same move, never both loaded)
  const clashes = new Set();
  for (const rig of new Set(Object.values(clipPacks).map((p) => p.rig)))
    for (const g of ['m', 'f']) {
      const seen = new Map();
      for (const [key, p] of Object.entries(clipPacks)) {
        if (p.rig !== rig || (p.gender !== g && p.gender !== 'any')) continue;
        for (const c of p.clips) {
          if (seen.has(c.name)) clashes.add(`${c.name} (packs ${seen.get(c.name)} and ${key}, rig ${rig})`);
          else seen.set(c.name, key);
        }
      }
    }
  if (clashes.size) throw new Error(`clip names must be unique per rig and gender: ${[...clashes].join('; ')}`);

  // ---- avatars
  const avatars = [];
  const extraSets = {};
  for (const f of metaFiles('avatar-').sort()) {
    const raw = readJson(join(META, f));
    const a = pick(raw, AVATAR_KEYS);
    // the outfit regions: the masks step's sidecar unless the avatar's own has them (convert.mjs
    // embeds the mask itself); either way the GLB's own record wins, below
    const outfit = join(META, `outfit-${a.id}.json`);
    if (!a.outfit && existsSync(outfit)) a.outfit = readJson(outfit).outfit;
    for (const s of raw.sets ?? []) (extraSets[s] ??= []).push(a.id);
    const rig = rigs[a.rig];
    if (!rig) warn(`${a.id}: unknown rig ${a.rig}`);
    for (const [k, anchor] of Object.entries(a.anchors ?? {})) if (!CANONICAL.has(anchor.bone)) warn(`${a.id}: anchor ${k} on unknown bone ${anchor.bone}`);
    let ok = true;
    for (const kind of ['crowd', 'hero']) {
      const rel = a.files?.[kind];
      if (!rel) continue;
      const file = join(OUT, rel);
      if (!existsSync(file)) {
        warn(`${a.id}: ${rel} is missing`);
        ok = false;
        continue;
      }
      a.bytes[kind] = size(file);
      const j = glbJson(file);
      const mats = new Set((j.materials ?? []).map((m) => m.name));
      const nodes = new Set((j.nodes ?? []).map((n) => n.name));
      for (const m of [a.parts.body, a.parts.head, a.parts.hair, ...Object.values(a.parts.extras ?? {})].filter(Boolean)) if (!mats.has(m)) warn(`${a.id}: ${rel} has no material ${m}`);
      // masks.mjs records the regions on the body material next to the mask it embeds: that's what
      // the file really carries
      const recorded = (j.materials ?? []).find((m) => m.name === a.parts.body)?.extras?.outfit;
      if (recorded && kind === 'crowd') a.outfit = recorded;
      const named = (name) => [...(j.textures ?? []), ...(j.images ?? [])].some((t) => t.name === name);
      if (a.outfit && !named('outfitMask')) warn(`${a.id}: ${rel} has outfit regions but no outfitMask texture`);
      if ((a.hairTone?.scalp || a.hairTone?.beard) && !named('hairMask')) warn(`${a.id}: ${rel} has painted hair tones but no hairMask texture`);
      const lods = kind === 'crowd' ? a.lods : 1;
      for (let i = 0; i < lods; i++) if (!nodes.has(`LOD${i}`)) warn(`${a.id}: ${rel} has no LOD${i}`);
      if (rig) {
        for (const b of [...Object.values(rig.bones), rig.root]) if (!nodes.has(b)) warn(`${a.id}: ${rel} has no bone ${b}`);
      }
    }
    if (a.portrait && !existsSync(join(OUT, a.portrait))) warn(`${a.id}: portrait ${a.portrait} is missing`);
    if (ok) avatars.push(a);
  }
  const ids = new Set(avatars.map((a) => a.id));

  // ---- sets (the catalogue's, plus any a sidecar asked to join)
  const sets = {};
  for (const [name, list] of Object.entries(SETS)) {
    const missing = list.filter((id) => !ids.has(id));
    if (missing.length) warn(`set ${name}: not converted yet: ${missing.join(', ')}`);
    sets[name] = list.filter((id) => ids.has(id));
  }
  for (const [name, list] of Object.entries(extraSets)) sets[name] = [...new Set([...(sets[name] ?? []), ...list])];

  // ---- sources and their licences
  const sources = [{ id: 'rocketbox', name: 'Microsoft Rocketbox Avatar Library', licence: 'MIT', url: ROCKETBOX.url, commit: ROCKETBOX.commit }];
  if (avatars.some((a) => a.source === 'makehuman')) sources.push({ id: 'makehuman', name: 'MakeHuman (assets and MPFB2 system assets)', licence: 'CC0-1.0', url: 'https://static.makehumancommunity.org/' });
  if (metaFiles('clippack-').length) sources.push({ id: 'quaternius-ual', name: 'Quaternius Universal Animation Library (retargeted)', licence: 'CC0-1.0', url: 'https://quaternius.com/' });

  return { manifest: { version: 1, sources, rigs, clipPacks, avatars, sets }, problems };
}

/** The Rocketbox notice that has to travel with the GLBs (its MIT licence's one condition). */
function licence() {
  return `Microsoft Rocketbox Avatar Library
Copyright (c) 2020 Microsoft

The people in this folder (*.crowd.glb, *.hero.glb, clips-m.glb, clips-f.glb and the portraits of
Rocketbox avatars) are converted from the Microsoft Rocketbox Avatar Library:
  ${ROCKETBOX.url}
  commit ${ROCKETBOX.commit} (2022-10-02)
They were converted to glTF, their textures resized and recompressed, their meshes simplified and
their animations trimmed. Any MakeHuman-based avatars (MH_*) are CC0 and not covered by this notice.

MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

/** Type-checks the manifest against the contract: a throwaway .ts that assigns it to PeopleManifest. */
function typeCheck(manifest) {
  const dir = ensureDir(join(WORK, 'tsc'));
  const file = join(dir, 'manifest-check.ts');
  const contract = relative(dir, join(WEB, 'src/world/crowd/people-manifest')).replace(/\\/g, '/');
  writeFileSync(file, `import type { PeopleManifest } from '${contract}';\nexport const manifest: PeopleManifest = ${JSON.stringify(manifest, null, 1)};\n`);
  const tsc = join(WEB, 'node_modules/typescript/bin/tsc');
  try {
    run(process.execPath, [tsc, '--ignoreConfig', '--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags } = cli();
  const { manifest, problems } = buildManifest();
  for (const p of problems) console.warn(`  ! ${p}`);
  if (!flags['no-tsc']) typeCheck(manifest);
  ensureDir(OUT);
  writeJson(join(OUT, 'manifest.json'), manifest);
  writeFileSync(join(OUT, 'LICENSE-rocketbox.txt'), licence());
  const bytes = (ids) => ids.reduce((s, id) => s + (manifest.avatars.find((a) => a.id === id)?.bytes.crowd ?? 0), 0);
  console.log(`manifest.json: ${manifest.avatars.length} avatars, ${Object.keys(manifest.clipPacks).length} clip packs (${Object.values(manifest.clipPacks).reduce((s, p) => s + p.bytes, 0)} bytes), sets ${Object.entries(manifest.sets).map(([k, v]) => `${k} ${v.length} (${(bytes(v) / 1048576).toFixed(2)} MB)`).join(', ')}`);
  if (problems.length) console.log(`${problems.length} problem(s), see above`);
}
