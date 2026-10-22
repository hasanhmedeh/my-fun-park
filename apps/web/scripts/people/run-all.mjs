// The Rocketbox side of the people pipeline, in the order it has to run:
//
//   node scripts/people/run-all.mjs [--force]
//
//   1. convert.mjs Male_Adult_01 Female_Adult_01   the reference man and woman (the clip packs are
//                                                  calibrated on their skeletons)
//   2. clips.mjs                                   clips-m.glb, clips-f.glb, and the seated idle
//                                                  convert.mjs measures seats with
//   3. convert.mjs Male_Adult_01 Female_Adult_01 --force   their seats, now that the seated idle exists
//                                                  (quick: base.glb and the KTX2 files are kept)
//   4. convert.mjs --all                           everyone else in catalogue.mjs, one at a time
//                                                  (downloads deleted as it goes; outfit masks via masks.mjs)
//   5. build-manifest.mjs                          manifest.json and LICENSE-rocketbox.txt
//
// The other producers run on their own before step 5 if their output is wanted in the manifest:
// makehuman.mjs (MakeHuman avatars, needs step 1 for its templates) and retarget.mjs
// (clips-extra.glb). Each step skips work already done unless --force; step 3 always rebuilds.
// Needs: Node 22+, the web app's dependencies installed (FBX2glTF comes from the fbx2gltf
// package), ffmpeg (C:/ffmpeg/ffmpeg.exe, on PATH, or $FFMPEG), network access to GitHub. Takes
// about 45 minutes for the whole catalogue, most of it downloading (~5 GB in, ~0.5 GB kept).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from './lib.mjs';

const { flags } = cli();
const force = flags.force ? ['--force'] : [];
const here = dirname(fileURLToPath(import.meta.url));

function step(script, args) {
  console.log(`\n== ${script} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${script} failed (${r.status})`);
    process.exit(r.status ?? 1);
  }
}

step('convert.mjs', ['Male_Adult_01', 'Female_Adult_01', ...force]);
step('clips.mjs', force);
step('convert.mjs', ['Male_Adult_01', 'Female_Adult_01', '--force']);
step('convert.mjs', ['--all', ...force]);
step('build-manifest.mjs', []);
