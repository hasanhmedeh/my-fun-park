// Contact sheets for the retargeted clips: renders scripts/people/retarget-web/ in headless Chrome
// (through scripts/shot.mjs and the dev server) a few clips per sheet, each clip on Quaternius'
// mannequin (the source) and on the given Rocketbox avatars at three moments.
//
//   node scripts/people/retarget-check.mjs <outDir> [--pack /models/people/clips-extra.glb]
//        [--avatars <url>,<url>] [--clips A,B,C] [--per 5] [--t 0.1,0.45,0.8] [--angles 40,-40] [--port 5199]
//
// Avatar and pack paths are URLs on the dev server (public/ is its root for /models/…; the cache is
// at /.people-cache/…). Writes <outDir>/retarget-01.png … and prints each sheet's path.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const pack = opt('pack', '/models/people/clips-extra.glb');
const avatars = opt('avatars', '/.people-cache/work/retarget/avatars/male01.glb,/.people-cache/work/retarget/avatars/female01.glb');
const per = Number(opt('per', '5'));
const t = opt('t', '0.1,0.45,0.8');
const angles = opt('angles', '40,-40');
const port = opt('port', '5199');
let clips = opt('clips', '')?.split(',').filter(Boolean);
const [outDir] = args;
if (!outDir) {
  console.error('usage: node scripts/people/retarget-check.mjs <outDir> [--pack url] [--avatars url,url] [--clips A,B] [--per 5]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (!clips.length) {
  // every clip in the pack, read from the file the URL points at
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const file = pack.startsWith('/models/') ? join(WEB, 'public', pack) : join(WEB, pack);
  clips = (await io.read(file)).getRoot().listAnimations().map((a) => a.getName());
}

const W = 180;
const H = 250;
const cols = (avatars.split(',').length + 1) * t.split(',').length;
for (let i = 0; i < clips.length; i += per) {
  const some = clips.slice(i, i + per);
  const out = join(outDir, `retarget-${String(i / per + 1).padStart(2, '0')}.png`);
  const url = `http://localhost:${port}/scripts/people/retarget-web/index.html?pack=${pack}&avatars=${avatars}&clips=${some.join(',')}&t=${t}&angles=${angles}&cell=${W}x${H}`;
  const r = spawnSync(process.execPath, [join(WEB, 'scripts/shot.mjs'), url, out, '--size', `${cols * W}x${some.length * H}`, '--port', port], { encoding: 'utf8' });
  const lines = (r.stdout + r.stderr).split('\n').filter((l) => l && !/X4122/.test(l));
  console.log(`${some.join(', ')}\n  ${lines.slice(-2).join('\n  ')}`);
}
