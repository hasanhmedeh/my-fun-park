// Reads a converted Rocketbox avatar and writes its Biped skeleton as JSON: the bind pose that the
// MakeHuman people are posed into (makehuman-build.py) and rebuilt on (makehuman-post.mjs), so they
// play Rocketbox's own clips unchanged.
//
//   node scripts/people/makehuman-template.mjs <rocketbox.glb> <out.json>
//
// Any Rocketbox GLB from FBX2glTF (metres) or from FBXLoader + GLTFExporter (centimetres under a
// 0.01 root) works; spaces or underscores in the bone names both come out as the FBX's spaces.
// Only the skeleton is read. Out: { source, joints: [{ name, parent, t, r, wp, wq }] } parent-first,
// in metres and glTF axes (+Y up, the person faces +Z), starting with the `Bip01` root (not a joint).

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function readBipedTemplate(file) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(file);
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) throw new Error(`${file}: no skin`);
  const joints = new Set(skin.listJoints());
  const bip = doc.getRoot().listNodes().find((n) => n.getName() === 'Bip01');
  if (!bip) throw new Error(`${file}: no Bip01`);
  // FBXLoader exports keep centimetres under a scaled root: fold that scale into the translations.
  let unit = 1;
  for (let p = bip.getParentNode(); p; p = p.getParentNode()) unit *= p.getScale()[0];
  const name = (n) => n.getName().replace(/_/g, ' ');

  const out = [];
  const walk = (node, parent, parentWorld) => {
    const t = node.getTranslation().map((v) => v * unit);
    const r = node.getRotation();
    const local = new Matrix4().compose(new Vector3(...t), new Quaternion(...r), new Vector3(1, 1, 1));
    const world = parentWorld ? parentWorld.clone().multiply(local) : local;
    const wp = new Vector3(), wq = new Quaternion();
    world.decompose(wp, wq, new Vector3());
    out.push({ name: name(node), parent, t, r: [...r], wp: wp.toArray(), wq: wq.toArray(), joint: joints.has(node) });
    for (const c of node.listChildren()) if (joints.has(c)) walk(c, name(node), world);
  };
  walk(bip, null, null);
  if (out.length < 54) throw new Error(`${file}: only ${out.length} Biped nodes`);
  return { source: basename(file), joints: out };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) {
    console.error('usage: node scripts/people/makehuman-template.mjs <rocketbox.glb> <out.json>');
    process.exit(2);
  }
  const tpl = await readBipedTemplate(src);
  writeFileSync(dst, JSON.stringify(tpl, null, 1));
  const hip = tpl.joints[0].wp[1];
  console.log(`${dst}: ${tpl.joints.length} nodes, Bip01 at ${hip.toFixed(3)} m`);
}
