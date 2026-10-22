// Shared bits for the people pipeline (scripts/people/*.mjs): where things live, the pinned
// Rocketbox commit, downloads, the external tools (FBX2glTF, ffmpeg, basisu) and a glTF reader
// that understands everything the outputs use.
//
// Layout:
//   .people-cache/dl/       raw downloads (FBX, TGA, preview PNG), deleted once converted
//   .people-cache/work/     intermediates: <id>/raw.glb (FBX2glTF output, 1024 px PNGs), anim/…
//   .people-cache/meta/     sidecar JSON per producer (avatar-<id>.json, clippack-<name>.json, outfit-<id>.json)
//   .people-cache/tools/    portable tools (basisu's WASI build)
//   public/models/people/   what the game loads (manifest.json, <id>.crowd.glb, <id>.hero.glb, clips-*.glb, portraits/)

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export const WEB = fileURLToPath(new URL('../../', import.meta.url));
export const CACHE = join(WEB, '.people-cache');
export const DL = join(CACHE, 'dl');
export const WORK = join(CACHE, 'work');
export const META = join(CACHE, 'meta');
export const TOOLS = join(CACHE, 'tools');
export const OUT = join(WEB, 'public/models/people');

/**
 * The Rocketbox commit everything is fetched from (the repo's last, 2022-10-02; it's archived).
 * Pinned so a rebuild gets the same files, and recorded in the manifest and the licence file.
 */
export const ROCKETBOX = {
  repo: 'microsoft/Microsoft-Rocketbox',
  commit: '0943055db6ec570bcef9f2c8b41c9e5467c808f9',
  url: 'https://github.com/microsoft/Microsoft-Rocketbox',
};

export const FBX2GLTF = join(WEB, 'node_modules/fbx2gltf/bin', process.platform === 'win32' ? 'Windows_NT/FBX2glTF.exe' : process.platform === 'darwin' ? 'Darwin/FBX2glTF' : 'Linux/FBX2glTF');
export const FFMPEG = process.env.FFMPEG ?? (existsSync('C:/ffmpeg/ffmpeg.exe') ? 'C:/ffmpeg/ffmpeg.exe' : 'ffmpeg');

/** The switches that never take a value (so `--force Male_Adult_01` is a switch and an id). */
const SWITCHES = ['--force', '--keep', '--refetch', '--all', '--starter', '--no-tsc'];

/** `--force`, `--name value` and bare words (avatar or clip ids) from the command line. */
export function cli(argv = process.argv.slice(2)) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) rest.push(a);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !SWITCHES.includes(a)) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { flags, ids: rest };
}

export function ensureDir(d) {
  mkdirSync(d, { recursive: true });
  return d;
}

export const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
export function writeJson(f, v) {
  ensureDir(dirname(f));
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
}
export const size = (f) => (existsSync(f) ? statSync(f).size : 0);

/** Runs a tool and throws with its output if it fails. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${(r.stderr || '') + (r.stdout || '')}`.slice(0, 4000));
  return r.stdout;
}

// ---------------------------------------------------------------- GitHub

/** A raw.githubusercontent URL for a path in the pinned commit. */
export const rawUrl = (path) => `https://raw.githubusercontent.com/${ROCKETBOX.repo}/${ROCKETBOX.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The repo's file tree at the pinned commit (one GitHub API call, then cached). */
export async function repoTree() {
  const file = join(WORK, `rocketbox-tree-${ROCKETBOX.commit.slice(0, 10)}.json`);
  if (existsSync(file)) return readJson(file);
  const api = `https://api.github.com/repos/${ROCKETBOX.repo}`;
  const headers = { 'User-Agent': 'funfair-people-pipeline', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const commit = await (await fetch(`${api}/commits/${ROCKETBOX.commit}`, { headers })).json();
  if (commit.sha !== ROCKETBOX.commit) throw new Error(`pinned commit not found: ${JSON.stringify(commit).slice(0, 300)}`);
  const tree = await (await fetch(`${api}/git/trees/${commit.commit.tree.sha}?recursive=1`, { headers })).json();
  if (!tree.tree || tree.truncated) throw new Error('could not list the Rocketbox tree');
  const files = tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size }));
  writeJson(file, { commit: ROCKETBOX.commit, date: commit.commit.committer.date, files });
  return readJson(file);
}

/** Streams a URL to a file (via a .part file, so an interrupted download is never mistaken for a finished one). */
export async function download(url, file, expectSize) {
  if (existsSync(file) && (!expectSize || size(file) === expectSize)) return file;
  ensureDir(dirname(file));
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file + '.part'));
      if (expectSize && size(file + '.part') !== expectSize) throw new Error(`size mismatch for ${url}: ${size(file + '.part')} ≠ ${expectSize}`);
      renameSync(file + '.part', file);
      return file;
    } catch (e) {
      rmSync(file + '.part', { force: true });
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// ---------------------------------------------------------------- glTF

let ioPromise;
/** A NodeIO that reads and writes meshopt and KTX2 files. */
export function gltfIO() {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  })();
  return ioPromise;
}

/** GLTFLoader's node names: whitespace becomes '_', and the characters it reserves are dropped. */
export const sanitize = (name) => name.replace(/\s/g, '_').replace(/[[\]\.:\/]/g, '');

// ---------------------------------------------------------------- basisu (KTX2)

let basisModule;
/**
 * Runs Basis Universal's command-line encoder (its WASI build, so nothing is installed) with
 * `dir` as its working directory: file arguments are relative to it. Its chatter goes to a log
 * file there.
 */
export async function basisu(dir, args) {
  const wasm = join(TOOLS, 'basisu', 'basisu_st.wasm');
  if (!existsSync(wasm)) {
    // v2.10's WASI command-line build (it's committed in the repo's bin/, there's no release binary)
    await download('https://raw.githubusercontent.com/BinomialLLC/basis_universal/v2_10_final_snapshot/bin/basisu_st.wasm', wasm);
  }
  const { WASI } = await import('node:wasi');
  basisModule ??= await WebAssembly.compile(readFileSync(wasm));
  const logFd = openSync(join(dir, 'basisu.log'), 'a');
  try {
    const wasi = new WASI({ version: 'preview1', args: ['basisu', ...args], preopens: { '.': dir }, stdout: logFd, stderr: logFd, returnOnExit: true });
    const inst = await WebAssembly.instantiate(basisModule, wasi.getImportObject());
    const code = wasi.start(inst);
    if (code !== 0) throw new Error(`basisu ${args.join(' ')} exited ${code} (see ${join(dir, 'basisu.log')})`);
  } finally {
    closeSync(logFd);
  }
}
// WASI is still flagged experimental: don't print that on every run
process.removeAllListeners('warning');
