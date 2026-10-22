// Builds the native Rocketbox clip packs: public/models/people/clips-m.glb (men's motion capture,
// the m_* files) and clips-f.glb (women's, f_*), from the FBX animations in the repo's
// Assets/Animations. They're on the avatars' own skeleton, so they play without retargeting.
//
//   node scripts/people/clips.mjs [m|f] [--force]
//   node scripts/people/clips.mjs --try f:s:f_sit_chair_idle_neutral_02:sitIdle,…   (gender:folder:file:kind)
//
// --try reads source clips that aren't in the table and prints how they'd come out (length, travel,
// speed, where the feet go) without building anything: for choosing between takes.
//
// Per clip: download the FBX, FBX2glTF it (30 fps) into .people-cache/work/anim/raw/, delete the
// FBX. Then, into the pack:
//   - rotations of the body's bones only (face bones are left to the avatar: blinks and looks are
//     procedural, and the clips' face rest poses don't match every head); no scale tracks, no
//     Footsteps, no Nub ends, no bone translations (each avatar keeps its own proportions)
//   - Bip01's translation, which carries hip height: locomotion has its X/Z travel taken out (the
//     speed it moved at goes in the manifest), in-place clips are centred on the origin, and sitting
//     down / standing up keep their travel relative to the standing spot (the origin)
//   - loops get their last quarter second eased into the first frame so they wrap seamlessly
//   - clips over 6 s drop to 15 fps (fingers 7.5); then keys that interpolation rebuilds are dropped
//   - all clips on one timeline in a single glTF animation (see buildPack), rotations as 16-bit
//     integers, meshopt compression (quaternion filter)
// Its ClipPack (refHeight, refHip, clips with durations and speeds) goes to
// .people-cache/work/anim/pack-<g>.json for build-manifest.mjs, and the seated idle, uncompressed,
// to work/anim/sit-<g>.json for convert.mjs's seat measurement.
//
// refHip is calibrated on a reference avatar (Male_Adult_01 / Female_Adult_01, converted first):
// the hip scale that keeps its feet on the floor through the standing idle. To fit another body
// the game scales Bip01's height by avatar.hip / refHip.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { Document } from '@gltf-transform/core';
import { MeshoptEncoder } from 'meshoptimizer';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { DL, FBX2GLTF, META, OUT, WORK, cli, download, ensureDir, gltfIO, rawUrl, readJson, repoTree, run, sanitize, size, writeJson } from './lib.mjs';
import { BONES, rigOf } from './measure.mjs';

const FOLDER = { s: 'all_animations_max_motextr_static', xy: 'all_animations_max_motextr_xy', xyz: 'all_animations_max_motextr_xyz' };

/**
 * The game's name, then the men's and women's source (folder:file, without .max.fbx), how its
 * root is treated, whether it loops, (for the long ones) how many seconds of it to keep, and
 * whether its hips are lifted wherever a foot would go through the floor (see liftFeet).
 * Kinds: 'idle' and 'still' (in place), 'move' (locomotion: travel removed, speed recorded),
 * 'sitDown', 'sitIdle', 'standUp'.
 *
 * Names are unique across every pack an avatar can play (build-manifest.mjs checks it): the
 * game's own Interact (a quick press) and Crouch_Idle_Loop come from clips-extra.glb, so the
 * library's takes of those are named for what they are.
 */
const CLIPS = [
  // stand-ins for the old library's clips
  ['Idle_Loop', 's:m_idle_neutral_01', 's:f_idle_neutral_01', 'idle', true],
  ['Walk_Loop', 'xy:m_walk_neutral', 'xy:f_walk_neutral', 'move', true],
  ['Jog_Fwd_Loop', 'xy:m_run_slow_01', 'xy:f_run_slow_01', 'move', true],
  ['Sprint_Loop', 'xy:m_run_fast_01', 'xy:f_run_fast_01', 'move', true, 0, 'lift'],
  ['Sitting_Enter', 'xyz:m_sit_down_chair_01', 'xyz:f_sit_down_chair_01', 'sitDown', false],
  ['Sitting_Idle_Loop', 's:m_sit_chair_idle_neutral_01', 's:f_sit_chair_idle_neutral_01', 'sitIdle', true, 16],
  ['Sitting_Exit', 'xyz:m_sit_stand_up_chair_01', 'xyz:f_sit_stand_up_chair_01', 'standUp', false],
  ['Idle_Talking_Loop', 's:m_gestic_talk_neutral_01', 's:f_gestic_talk_neutral_01', 'still', true, 14],
  ['Dance_Loop', 's:m_dancing_neutral', 's:f_dancing_neutral', 'still', true, 12],
  // squatting, one foot flat and the other on its toes (lifted 1–2 cm where a toe dips under)
  ['Squat_Idle_Loop', 's:m_crouch_idle', 's:f_crouch_idle', 'still', true, 0, 'lift'],
  // reaching forward for papers held out, then reading them (a ticket, a boarding pass)
  ['Take_Papers', 's:m_documents_take', 's:f_documents_take', 'still', false],
  // more idles
  ['Idle_Breathe', 's:m_idle_breathe_01', 's:f_idle_breathe_01', 'idle', true],
  ['Idle_Look_Around', 's:m_idle_look_around_01', 's:f_idle_look_around_01', 'idle', true],
  ['Idle_Look_Around_2', 's:m_idle_look_around_02', 's:f_idle_look_around_02', 'idle', true],
  ['Idle_Weight_Shift', 's:m_idle_neutral_02', 's:f_idle_neutral_02', 'idle', true, 16],
  ['Idle_Waiting', 's:m_idle_waiting_01', 's:f_idle_waiting_01', 'idle', true, 16],
  ['Idle_Scratch_Head', 's:m_idle_scratch_head_01', 's:f_idle_scratch_head_01', 'still', false],
  ['Idle_Stretch', 's:m_idle_stretch_arms_01', 's:f_idle_stretch_arms_01', 'still', false],
  ['Idle_Yawn', 's:m_idle_yawn_01', 's:f_idle_yawn_01', 'still', false],
  // more walks and a run
  ['Walk_Slow_Loop', 'xy:m_walk_slow_01', 'xy:f_walk_slow_01', 'move', true],
  ['Walk_Fast_Loop', 'xy:m_walk_fast_01', 'xy:f_walk_fast_01', 'move', true],
  ['Walk_Stroll_Loop', 'xy:m_walk_stroll_01', 'xy:f_walk_stroll_01', 'move', true],
  ['Run_Loop', 'xy:m_run_neutral', 'xy:f_run_neutral', 'move', true],
  // seated variety
  ['Sitting_Look_Around', 's:m_sit_chair_idle_look_around', 's:f_sit_chair_idle_look_around', 'sitIdle', false],
  // conversation
  ['Talk_2', 's:m_gestic_talk_neutral_02', 's:f_gestic_talk_neutral_02', 'still', true, 12],
  ['Talk_3', 's:m_gestic_talk_relaxed_01', 's:f_gestic_talk_relaxed_01', 'still', true, 12],
  ['Talk_4', 's:m_gestic_talk_excited_01', 's:f_gestic_talk_excited_01', 'still', true, 12],
  ['Talk_5', 's:m_gestic_talk_relaxed_02', 's:f_gestic_talk_relaxed_02', 'still', true, 12],
  ['Talk_6', 's:m_gestic_talk_cool', 's:f_gestic_talk_cool', 'still', true, 12],
  ['Listen', 's:m_gestic_listen_neutral_01', 's:f_gestic_listen_neutral_01', 'idle', true, 14],
  ['Listen_2', 's:m_gestic_listen_relaxed_01', 's:f_gestic_listen_relaxed_01', 'idle', true, 14],
  ['Listen_3', 's:m_gestic_listen_excited_01', 's:f_gestic_listen_excited_01', 'idle', true, 12],
  ['Nod', 's:m_gestic_listen_accept_01', 's:f_gestic_listen_accept_01', 'still', false],
  ['Head_Shake', 's:m_gestic_listen_deny_01', 's:f_gestic_listen_deny_01', 'still', false],
  ['Shrug', 's:m_gestic_shrug_01', 's:f_gestic_shrug_01', 'still', false],
  ['Laugh', 's:m_gestic_laugh_loud', 's:f_gestic_laugh_loud', 'still', false, 8],
  // at the fair
  ['Wave', 's:m_wave_01', 's:f_wave_01', 'still', false],
  ['Wave_2', 's:m_wave_02', 's:f_wave_02', 'still', false],
  ['Cheer', 's:m_cheer_01', 's:f_cheer_01', 'still', false, 8],
  ['Cheer_2', 's:m_cheer_03', 's:f_cheer_03', 'still', false],
  ['Clap', 's:m_claphands_01', 's:f_claphands_01', 'still', true],
  ['Take_Photo', 's:m_take_picture', 's:f_take_picture', 'still', false],
  ['Phone_Call', 's:m_cell_phone_talk_01', 'xyz:f_cell_phone_talk_01', 'idle', true, 14],
  ['Phone_Text', 's:m_cell_phone_textmessage', 's:f_cell_phone_textmessage', 'idle', true, 14],
  ['Drink', 's:m_drink_drinking', 's:f_drink_drinking', 'still', false, 12],
  ['Hold_Bag', 's:m_hold_bag_idle', 's:f_hold_bag_idle_01', 'idle', true, 12],
  ['Trolley_Idle', 's:m_trolley_idle', 's:f_trolley_idle', 'idle', true, 12],
  ['Dance_2', 's:m_dancing_silly', 's:f_dancing_silly', 'still', true, 12],
];

/** Body bones whose rotations the packs carry (the face's 27 and the Nub ends are left out). */
const BODY = new Set([
  'Bip01',
  ...['Pelvis', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].map((b) => `Bip01_${b}`),
  ...['L', 'R'].flatMap((s) => [
    ...['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'Toe0'].map((b) => `Bip01_${s}_${b}`),
    ...[0, 1, 2, 3, 4].flatMap((f) => [`${f}`, `${f}1`, `${f}2`].map((k) => `Bip01_${s}_Finger${k}`)),
  ]),
]);

/** Seconds over which a loop's end is eased into its start (longer where a clip was cut short). */
const LOOP_EASE = 0.25;
const CUT_EASE = 0.6;
/** Clips longer than this (after cutting) drop from 30 to 15 fps, and their fingers to 7.5. */
const LONG = 6;

// ---------------------------------------------------------------- reading a clip

/** Downloads and converts one source clip; returns its tracks by node name as plain arrays. */
async function loadClip(src) {
  const [folder, file] = src.split(':');
  const rawDir = ensureDir(join(WORK, 'anim', 'raw'));
  const glb = join(rawDir, `${file}.glb`);
  if (!existsSync(glb)) {
    const path = `Assets/Animations/${FOLDER[folder]}/${file}.max.fbx`;
    const entry = (await repoTree()).files.find((f) => f.path === path);
    if (!entry) throw new Error(`no ${path} in the repo`);
    const fbx = await download(rawUrl(path), join(DL, 'anim', `${file}.fbx`), entry.size);
    run(FBX2GLTF, ['--binary', '--anim-framerate', 'bake30', '--input', fbx, '--output', glb.replace(/\.glb$/, '')]);
    rmSync(fbx);
  }
  const io = await gltfIO();
  const doc = await io.read(glb);
  const anim = doc.getRoot().listAnimations()[0];
  const tracks = {};
  let duration = 0;
  for (const ch of anim.listChannels()) {
    const name = sanitize(ch.getTargetNode().getName());
    const path = ch.getTargetPath();
    if (!BODY.has(name) || path === 'scale' || (path === 'translation' && name !== 'Bip01')) continue;
    const s = ch.getSampler();
    const times = Array.from(s.getInput().getArray());
    duration = Math.max(duration, times[times.length - 1]);
    (tracks[name] ??= {})[path] = { times, values: Array.from(s.getOutput().getArray()) };
  }
  // the skeleton's rest pose (for the pack's node tree)
  const nodes = doc.getRoot().listNodes().map((n) => ({ name: sanitize(n.getName()), t: n.getTranslation(), r: n.getRotation(), children: n.listChildren().map((c) => sanitize(c.getName())) }));
  // FBX2glTF writes no channel for a bone the take holds still: its pose for the whole take is
  // that node's own transform in this file. Left out, the bone would take another clip's pose (or
  // the avatar's bind pose) instead: the crouches' pelvis 18–28° off, so one foot sank 8 cm and
  // the other floated; open fingers on the runs, the bag and the trolley. So they're held here.
  for (const n of nodes) {
    if (!BODY.has(n.name)) continue;
    const tr = (tracks[n.name] ??= {});
    tr.rotation ??= { times: [0, duration], values: [...n.r, ...n.r] };
    if (n.name === 'Bip01') tr.translation ??= { times: [0, duration], values: [...n.t, ...n.t] };
  }
  return { duration, tracks, nodes };
}

// ---------------------------------------------------------------- root handling

const sampleAt = (tr, t, size) => {
  const { times, values } = tr;
  let i = 0;
  while (i < times.length - 2 && times[i + 1] <= t) i++;
  const k = THREE.MathUtils.clamp((t - times[i]) / (times[i + 1] - times[i] || 1), 0, 1);
  return Array.from({ length: size }, (_, c) => THREE.MathUtils.lerp(values[i * size + c], values[Math.min(i + 1, times.length - 1) * size + c], k));
};

/**
 * Bip01's X/Z for this kind of clip. Returns the clip's ground speed (locomotion) and where the
 * hips end up (sitting down), and rewrites the translation track in place.
 */
function fixRoot(clip, kind) {
  const tr = clip.tracks.Bip01?.translation;
  if (!tr) return {};
  const v = tr.values;
  const n = tr.times.length;
  const T = clip.duration;
  const x0 = v[0];
  const z0 = v[2];
  const x1 = v[(n - 1) * 3];
  const z1 = v[(n - 1) * 3 + 2];
  const info = { travel: Math.hypot(x1 - x0, z1 - z0) };
  if (kind === 'move') {
    // in place: take out the steady travel, then centre what's left (the hips' sway)
    info.speed = info.travel / T;
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < n; i++) {
      const k = tr.times[i] / T;
      v[i * 3] -= x0 + (x1 - x0) * k;
      v[i * 3 + 2] -= z0 + (z1 - z0) * k;
      mx += v[i * 3] / n;
      mz += v[i * 3 + 2] / n;
    }
    for (let i = 0; i < n; i++) {
      v[i * 3] -= mx;
      v[i * 3 + 2] -= mz;
    }
  } else if (kind === 'sitDown' || kind === 'standUp') {
    // relative to the standing spot: the start of sitting down, the end of standing up
    const [ox, oz] = kind === 'sitDown' ? [x0, z0] : [x1, z1];
    for (let i = 0; i < n; i++) {
      v[i * 3] -= ox;
      v[i * 3 + 2] -= oz;
    }
    // where the hips are once seated (x, y, z): the end of sitting down, the start of standing up
    info.seated = Array.from(kind === 'sitDown' ? v.slice((n - 1) * 3, n * 3) : v.slice(0, 3));
  } else {
    // in place: centred on the origin (the seated idles' hips are then replaced, see seatedBase)
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < n; i++) {
      mx += v[i * 3] / n;
      mz += v[i * 3 + 2] / n;
    }
    for (let i = 0; i < n; i++) {
      v[i * 3] -= mx;
      v[i * 3 + 2] -= mz;
    }
  }
  return info;
}

/**
 * The seated idles were captured apart from sitting down and standing up, on a higher seat: with
 * the hips where sitting down leaves them, the men's feet went ~5 cm into the floor and the
 * women's ~12 cm (every take in the library). So they keep only their upper body: Bip01, the
 * pelvis, the lowest spine bone (the thighs hang off it) and the legs hold where sitting down
 * ends, which is where standing up starts. That ends the pop between the three clips too.
 */
const SEATED_BASE = ['Bip01', 'Bip01_Pelvis', 'Bip01_Spine', ...['L', 'R'].flatMap((s) => ['Thigh', 'Calf', 'Foot', 'Toe0'].map((b) => `Bip01_${s}_${b}`))];

/** The last frame of sitting down, for the SEATED_BASE bones. */
function seatedBase(sitDown) {
  const base = {};
  for (const node of SEATED_BASE) {
    const tr = sitDown.tracks[node];
    if (!tr) continue;
    base[node] = {};
    for (const [path, { values }] of Object.entries(tr)) {
      const size = path === 'rotation' ? 4 : 3;
      base[node][path] = values.slice(values.length - size);
    }
  }
  return base;
}

/** Holds a seated clip's SEATED_BASE bones in the seated base pose. */
function holdSeated(clip, base) {
  for (const [node, paths] of Object.entries(base)) {
    clip.tracks[node] = {};
    for (const [path, v] of Object.entries(paths)) clip.tracks[node][path] = { times: [0, clip.duration], values: [...v, ...v] };
  }
}

/** Eases the last `secs` of every track into its first frame, so the loop wraps without a pop. */
function easeLoop(clip, secs) {
  const T = clip.duration;
  const q0 = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (const tr of Object.values(clip.tracks)) {
    for (const [path, { times, values }] of Object.entries(tr)) {
      const size = path === 'rotation' ? 4 : 3;
      for (let i = 0; i < times.length; i++) {
        const w = THREE.MathUtils.smoothstep(times[i], T - secs, T);
        if (w <= 0) continue;
        if (size === 4) {
          q0.fromArray(values, 0);
          q.fromArray(values, i * 4);
          if (q.dot(q0) < 0) q0.set(-q0.x, -q0.y, -q0.z, -q0.w);
          q.slerp(q0, w).toArray(values, i * 4);
        } else for (let c = 0; c < 3; c++) values[i * 3 + c] = THREE.MathUtils.lerp(values[i * 3 + c], values[c], w);
      }
    }
  }
}

/** Keeps every `step`th key (and the last) of the tracks of nodes matching `only`. */
function thin(clip, step, only = /./) {
  for (const [node, tr] of Object.entries(clip.tracks)) {
    if (!only.test(node)) continue;
    for (const t of Object.values(tr)) {
      const size = t.values.length / t.times.length;
      const keep = t.times.map((_, i) => i % step === 0 || i === t.times.length - 1);
      t.values = t.values.filter((_, j) => keep[Math.floor(j / size)]);
      t.times = t.times.filter((_, i) => keep[i]);
    }
  }
}

/** Keeps the first `secs` of a clip (an interpolated key at the cut). */
function cut(clip, secs) {
  if (clip.duration <= secs) return;
  for (const tr of Object.values(clip.tracks)) {
    for (const [path, t] of Object.entries(tr)) {
      const size = path === 'rotation' ? 4 : 3;
      const end = sampleAt(t, secs, size);
      if (size === 4) new THREE.Quaternion().fromArray(end).normalize().toArray(end);
      const n = t.times.findIndex((x) => x >= secs - 1e-4);
      t.times = [...t.times.slice(0, n), secs];
      t.values = [...t.values.slice(0, n * size), ...end];
    }
  }
  clip.duration = secs;
}

// ---------------------------------------------------------------- calibration

/**
 * The hip height these clips were made for: the scale on Bip01's height that keeps the reference
 * avatar's soles on the floor through the standing idle, turned into a hip height.
 */
/** The reference avatar's skeleton, and its ankle and toe joints' heights in the bind pose. */
async function refRig(gender) {
  const refId = gender === 'm' ? 'Male_Adult_01' : 'Female_Adult_01';
  const file = join(WORK, refId, 'base.glb');
  if (!existsSync(file)) throw new Error(`the packs need ${refId} converted first (node scripts/people/convert.mjs ${refId})`);
  const rig = rigOf(await (await gltfIO()).read(file));
  rig.rest();
  return { rig, bind: Object.fromEntries(FEET.map((b) => [b, rig.pos(b).y])) };
}
const FEET = [BONES.foot_l, BONES.foot_r, BONES.ball_l, BONES.ball_r];

/**
 * Raises Bip01 wherever the clip takes the lowest ankle or toe joint below where it stands in the
 * bind pose on the reference avatar, so no frame puts a sole through the floor (the sprints sank
 * ~3 cm for a frame where the loop's easing meets the footfall; the squats 1–2 cm).
 * Each frame's lift is spread over LIFT_SPREAD frames either side with a raised cosine, never
 * below what a frame needs, so the hips rise into it and settle out of it rather than jumping for
 * one frame; a loop's spread wraps round. Runs on the 30 fps keys, before any thinning. Returns
 * the largest lift (metres).
 */
const LIFT_SPREAD = 3;
function liftFeet(ref, clip, loop) {
  const tr = clip.tracks.Bip01?.translation;
  if (!tr) return 0;
  const need = tr.times.map((t) => {
    ref.rig.pose(clip, t);
    let low = Infinity;
    for (const b of FEET) low = Math.min(low, ref.rig.pos(b).y - ref.bind[b]);
    return Math.max(0, -low);
  });
  const n = need.length;
  // a loop's first and last keys are the same pose (easeLoop), so its frames repeat every n - 1
  const period = n - 1;
  const lifts = need.map((_, i) => {
    let m = 0;
    for (let k = -LIFT_SPREAD; k <= LIFT_SPREAD; k++) {
      let j = i + k;
      if (loop && period > 0) j = ((j % period) + period) % period;
      else if (j < 0 || j >= n) continue;
      m = Math.max(m, need[j] * Math.cos((Math.PI * k) / (2 * (LIFT_SPREAD + 1))) ** 2);
    }
    return m;
  });
  lifts.forEach((d, i) => (tr.values[i * 3 + 1] += d));
  return Math.max(...lifts);
}

/**
 * How far a clip takes the feet below where they stand in the bind pose, on the reference avatar
 * (metres; negative sinks into the floor): the lowest ankle or toe joint over the whole clip.
 */
function feetLow(ref, clip) {
  let low = Infinity;
  for (let t = 0; t <= clip.duration; t += 1 / 15) {
    ref.rig.pose(clip, t);
    for (const b of FEET) low = Math.min(low, ref.rig.pos(b).y - ref.bind[b]);
  }
  return Math.round(low * 1000) / 1000;
}

async function calibrate(gender, idle) {
  const refId = gender === 'm' ? 'Male_Adult_01' : 'Female_Adult_01';
  const meta = join(WORK, refId, 'base.glb');
  if (!existsSync(meta)) throw new Error(`calibration needs ${refId} converted first (node scripts/people/convert.mjs ${refId})`);
  const io = await gltfIO();
  const doc = await io.read(meta);
  const rig = rigOf(doc);
  const hip = rig.pos('Bip01').y;
  // ankle heights in the bind pose (feet flat), then the scale that gives the same in the idle
  const bindAnkle = (rig.pos(BONES.foot_l).y + rig.pos(BONES.foot_r).y) / 2;
  let lo = 0.8;
  let hi = 1.2;
  for (let it = 0; it < 30; it++) {
    const s = (lo + hi) / 2;
    let sum = 0;
    let k = 0;
    for (let t = 0; t < idle.duration; t += idle.duration / 24, k++) {
      rig.pose(idle, t, s);
      sum += Math.min(rig.pos(BONES.foot_l).y, rig.pos(BONES.foot_r).y);
    }
    if (sum / k > bindAnkle) hi = s;
    else lo = s;
  }
  const s = (lo + hi) / 2;
  const height = readJson(join(META, `avatar-${refId}.json`)).height;
  return { refHip: Math.round((hip / s) * 1000) / 1000, refHeight: Math.round((height / s) * 1000) / 1000, refId, scale: s };
}


// ---------------------------------------------------------------- key reduction

/**
 * Drops the keys that interpolating their neighbours rebuilds to within `tol` (radians for
 * rotations, metres for the root), always keeping the first and last.
 */
function reduceKeys({ times, values }, size, tol) {
  const n = times.length;
  if (n <= 2) return { times, values };
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const qi = new THREE.Quaternion();
  const fits = (a, b) => {
    for (let i = a + 1; i < b; i++) {
      const k = (times[i] - times[a]) / (times[b] - times[a]);
      if (size === 4) {
        qa.fromArray(values, a * 4);
        qb.fromArray(values, b * 4);
        qi.fromArray(values, i * 4);
        if (qa.slerp(qb, k).angleTo(qi) > tol) return false;
      } else {
        for (let c = 0; c < size; c++) if (Math.abs(THREE.MathUtils.lerp(values[a * size + c], values[b * size + c], k) - values[i * size + c]) > tol) return false;
      }
    }
    return true;
  };
  const keep = [0];
  let a = 0;
  for (let b = 2; b < n; b++) {
    if (!fits(a, b)) {
      keep.push(b - 1);
      a = b - 1;
    }
  }
  keep.push(n - 1);
  return { times: keep.map((i) => times[i]), values: keep.flatMap((i) => values.slice(i * size, i * size + size)) };
}

// ---------------------------------------------------------------- the pack

/** Seconds at least between clips on the pack's timeline (each clip starts on a whole second). */
const GAP = 0.5;

/**
 * Builds a pack. All its clips go on ONE timeline in one glTF animation ('clips'), each starting
 * on a whole second (ClipInfo.start) with keys on every channel at its start and end: a glTF
 * animation per clip would cost ~110 bytes of JSON per channel per clip (about 0.7 MB a pack).
 */
async function buildPack(gender, { force }) {
  const out = join(OUT, `clips-${gender}.glb`);
  const packJson = join(WORK, 'anim', `pack-${gender}.json`);
  if (!force && existsSync(out) && existsSync(packJson)) return readJson(packJson);
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('Root Scene');
  const nodes = new Map();
  const rest = new Map();
  const infos = [];
  const segments = [];
  const ref = await refRig(gender);
  let seated = null;
  let sitIdle = null;
  let idle = null;
  let start = 0;

  for (const [name, mSrc, fSrc, kind, loop, max, lift] of CLIPS) {
    const src = gender === 'm' ? mSrc : fSrc;
    const clip = await loadClip(src);
    // the skeleton, once, from the first clip (Biped bones, without the Nub ends and Footsteps)
    if (!nodes.size) {
      const keep = clip.nodes.filter((n) => /^Bip01(_|$)/.test(n.name) && !/Nub$|Footsteps/.test(n.name));
      for (const n of keep) {
        nodes.set(n.name, doc.createNode(n.name).setTranslation(n.t).setRotation(n.r));
        rest.set(n.name, { rotation: n.r, translation: n.t });
      }
      for (const n of keep) for (const c of n.children) if (nodes.has(c)) nodes.get(n.name).addChild(nodes.get(c));
      scene.addChild(nodes.get('Bip01'));
    }
    const full = clip.duration;
    if (max) cut(clip, max);
    const root = fixRoot(clip, kind);
    if (kind === 'sitDown') seated = seatedBase(clip);
    if (kind === 'sitIdle') holdSeated(clip, seated);
    if (loop) easeLoop(clip, Math.min(max && full > max ? CUT_EASE : LOOP_EASE, clip.duration / 4));
    // after the easing, which can itself take a foot down (the women's sprint), and with the loop
    // closed: its first and last frames are the same pose, so they get the same lift
    if (lift) root.lift = liftFeet(ref, clip, loop);
    if (clip.duration > LONG && kind !== 'move') {
      thin(clip, 2);
      thin(clip, 2, /Finger/);
    }
    if (name === 'Sitting_Idle_Loop') sitIdle = structuredClone(clip);
    if (name === 'Idle_Loop') idle = structuredClone(clip);

    const duration = Math.round(clip.duration * 1000) / 1000;
    segments.push({ start, duration, clip });
    const info = { name, duration, loop, ...(root.speed ? { speed: Math.round(root.speed * 1000) / 1000 } : {}), start };
    infos.push({ ...info, source: src.split(':')[1], kind, travel: Math.round((root.travel ?? 0) * 1000) / 1000, feet: feetLow(ref, clip), ...(root.seated ? { seated: root.seated.map((x) => Math.round(x * 1000) / 1000) } : {}), ...(root.lift !== undefined ? { lift: Math.round(root.lift * 1000) / 1000 } : {}) });
    start = Math.ceil(start + duration + GAP);
  }

  // one channel per animated bone and path across all the clips; where a clip leaves a bone
  // alone, it holds the skeleton's rest pose
  const channels = new Set();
  for (const { clip } of segments) for (const [node, tr] of Object.entries(clip.tracks)) for (const path of Object.keys(tr)) channels.add(`${node}|${path}`);
  const anim = doc.createAnimation('clips');
  for (const key of channels) {
    const [node, path] = key.split('|');
    const size = path === 'rotation' ? 4 : 3;
    const times = [];
    const values = [];
    for (const { start: s, duration, clip } of segments) {
      let tr = clip.tracks[node]?.[path];
      if (!tr) tr = { times: [0, duration], values: [...rest.get(node)[path], ...rest.get(node)[path]] };
      // a key at exactly the clip's end, so cutting it out needs no interpolation
      const last = tr.times.length - 1;
      if (Math.abs(tr.times[last] - duration) > 1e-4) tr = { times: [...tr.times.slice(0, last), duration], values: tr.values };
      const r = reduceKeys(tr, size, size === 4 ? 0.003 : 0.001);
      for (const t of r.times) times.push(s + t);
      values.push(...r.values);
    }
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times));
    const output = doc.createAccessor().setType(size === 4 ? 'VEC4' : 'VEC3');
    // rotations as normalised 16-bit integers (KHR_mesh_quantization allows it): half the bytes
    if (size === 4) output.setArray(Int16Array.from(values, (v) => Math.round(THREE.MathUtils.clamp(v, -1, 1) * 32767))).setNormalized(true);
    else output.setArray(new Float32Array(values));
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes.get(node)).setTargetPath(path).setSampler(sampler));
  }
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const io = await gltfIO();
  await io.write(out, doc);

  const cal = await calibrate(gender, idle);
  const pack = {
    file: `clips-${gender}.glb`,
    rig: 'rocketbox',
    gender,
    refHeight: cal.refHeight,
    refHip: cal.refHip,
    clips: infos.map(({ name, duration, loop, speed, start: s }) => ({ name, duration, loop, ...(speed ? { speed } : {}), start: s })),
    bytes: size(out),
    // for the report, not the manifest
    detail: { calibration: cal, clips: infos },
  };
  writeJson(packJson, pack);
  writeJson(join(WORK, 'anim', `sit-${gender}.json`), { refHip: cal.refHip, clip: sitIdle });
  return pack;
}

/** --try: how source clips that aren't in the table would come out. */
async function tryClips(list) {
  for (const spec of list.split(',')) {
    const [g, folder, file, kind = 'still'] = spec.split(':');
    const ref = await refRig(g);
    const clip = await loadClip(`${folder}:${file}`);
    const root = fixRoot(clip, kind);
    if (kind === 'sitIdle') {
      const row = CLIPS.find((c) => c[3] === 'sitDown');
      const sitDown = await loadClip(g === 'm' ? row[1] : row[2]);
      fixRoot(sitDown, 'sitDown');
      holdSeated(clip, seatedBase(sitDown));
    }
    console.log(`${file}: ${clip.duration.toFixed(2)} s, travel ${(root.travel ?? 0).toFixed(3)}${root.speed ? `, ${root.speed.toFixed(3)} m/s` : ''}, feet ${feetLow(ref, clip)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, ids } = cli();
  if (flags.try) {
    await tryClips(flags.try);
    process.exit(0);
  }
  for (const g of ids.length ? ids : ['m', 'f']) {
    const p = await buildPack(g, flags);
    console.log(`clips-${g}.glb: ${(p.bytes / 1024).toFixed(0)} KB, ${p.clips.length} clips, refHip ${p.refHip}, refHeight ${p.refHeight}`);
    for (const c of p.detail.clips) console.log(`  ${c.name.padEnd(20)} ${c.duration.toFixed(2).padStart(6)} s ${c.loop ? 'loop' : '    '} ${c.speed ? `${c.speed} m/s` : ''} ${c.seated ? `seated at ${c.seated}` : ''}${c.lift ? `lifted ${c.lift} ` : ''}(${c.source}, travel ${c.travel}, feet ${c.feet}${c.feet < -0.03 ? ' SINK' : ''})`);
  }
}
