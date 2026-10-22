// The park's crowd (world/crowd/crowd.ts) on the new people, with the two coasters and the High
// Striker it plays round, on the park's own ground; and what travellers carry (world/crowd/luggage.ts).
//
//   ?scene=crowd&hour=14                          the crowd after `warm` seconds of its day (default 90)
//   ?scene=crowd&follow=bench&pose=sit            …the camera on the first guest doing that: a party's
//                                                  activity (bench, coaster:0, coaster:1, watch, chat, play,
//                                                  striker, tickets, stroll), 'riding' or 'toddler'; and
//                                                  their pose if given (sit, wait, foldArms, text, listen…)
//        &side=1 (side on) &back=1 &dist=3 &h=1.4    where the camera stands, from that guest
//        &count=80 &seed (the first guest found, skipping `skip` of them)
//   ?scene=crowd&mode=bench                       someone of every size on the crowd's bench, side on
//   ?scene=crowd&mode=luggage[&turn=0|90|180]     backpacks, totes, a pulled case, sun hats and caps on a
//                                                  man, a woman and two children; turn=0 faces the camera
//   ?scene=crowd&mode=frames                      logs the spine and head bones' frames in the bind pose
import * as THREE from 'three';
import type { PreviewScene } from '../main';
import { downloadPeople, PeopleFactory } from '../../world/crowd/people-factory';
import type { PersonRig } from '../../world/crowd/person-rig';
import { plainLook } from '../../world/crowd/looks';
import { benchFrame, benchFront, benchGeometry, Crowd } from '../../world/crowd/crowd';
import { backpackOn, hatOnHead, Luggage, pulledCase, toteOn, type CaseState, type PropItem, type PropKind } from '../../world/crowd/luggage';
import { Coaster } from '../../world/attractions/coaster';
import { Striker } from '../../world/attractions/striker';
import { FALCON_TRACK, STACK_TRACK } from '../../world/rides';
import { PHYS } from '../../world/attractions/track';
import { FALCON_PHYS } from '../../world/attractions/falcon-track';
import { PALETTE } from '../../world/textures';
import type { Tier } from '../../world/quality';

const DT = 1 / 30;

const scene: PreviewScene = async (p) => {
  const q = p.params;
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const mode = q.get('mode') ?? 'crowd';
  const { ctx } = p;
  const tier = (q.get('tier') as Tier | null) ?? ctx.quality.tier;
  const people = await PeopleFactory.create(ctx.renderer, downloadPeople({ sets: ['park'], tier }), { tier });

  if (mode === 'frames') return frames(people);
  if (mode === 'bench') return bench(p, people);
  if (mode === 'luggage') return luggage(p, people);

  // ---- the crowd, with what it queues for
  const stack = new Coaster(ctx, {
    id: 'stack',
    name: 'Thunder Loop',
    track: STACK_TRACK,
    phys: PHYS,
    station: { title: 'THUNDER LOOP', sub: '', side: -1 },
    colors: { rail: PALETTE.candy, spine: PALETTE.mustard, cars: [PALETTE.mustard, PALETTE.candy, PALETTE.teal] },
    cars: 3,
    trackside: [],
    intro: () => '',
  });
  const falcon = new Coaster(ctx, {
    id: 'falcon',
    name: 'Sky Falcon',
    track: FALCON_TRACK,
    phys: FALCON_PHYS,
    station: { title: 'SKY FALCON', sub: '', side: -1 },
    colors: { rail: PALETTE.teal, spine: '#e6c08a', cars: ['#e6c08a', PALETTE.teal, '#e6c08a', PALETTE.teal] },
    cars: 4,
    leadRows: 1,
    tunnel: 'rock',
    trackside: [],
    intro: () => '',
  });
  const striker = new Striker(ctx);
  const crowd = new Crowd(ctx, people, null, [stack, falcon], striker, { count: num('count', 80), shadows: ctx.quality.shadows, exclude: q.get('exclude')?.split(',') });
  const step = (dt: number) => {
    stack.update(dt);
    falcon.update(dt);
    striker.update(dt);
    crowd.update(dt);
  };
  // (the camera far off while the day runs: nobody's animated, so it's quick)
  ctx.camera.position.set(0, 2000, 0);
  ctx.camera.updateMatrixWorld();
  for (let t = 0; t < num('warm', 90); t += DT) step(DT);
  const follow = q.get('follow');
  const pose = (q.get('pose') as never) ?? undefined;
  // (and on, up to ten minutes more, until someone's doing what's to be followed: benches are rare)
  for (let t = 0; follow && t < 600 && !crowd.whereIs(follow, pose); t += DT) step(DT);
  // (then a moment more, to settle: a sitter glides back into the seat)
  for (let t = 0; follow && t < num('settle', 1); t += DT) step(DT);
  console.warn(`crowd: ${JSON.stringify(crowd.debug())}`);

  const at = follow ? crowd.whereIs(follow, pose) : null;
  if (follow && !at) console.warn(`crowd: nobody doing "${follow}" (${pose ?? 'any pose'})`);
  const aim = () => {
    const g = follow ? crowd.whereIs(follow, pose) : null;
    if (!g) return;
    const f = new THREE.Vector3(-Math.sin(g.heading), 0, -Math.cos(g.heading));
    const r = new THREE.Vector3(Math.cos(g.heading), 0, -Math.sin(g.heading));
    // (or a world direction, dx/dz: a rider's heading is the one they boarded with, not the car's)
    const dir = q.has('dx') ? new THREE.Vector3(num('dx', 0), 0, num('dz', 0)).normalize() : q.get('side') === '1' ? r : q.get('back') === '1' ? f.clone().negate() : f;
    const d = num('dist', 3);
    p.view({ x: g.x + dir.x * d, y: g.y + num('h', 1.4), z: g.z + dir.z * d }, { x: g.x, y: g.y + num('ly', 0.8), z: g.z });
  };
  if (at) {
    console.warn(`crowd: following ${JSON.stringify(at)}`);
    aim();
  } else p.view({ x: num('cx', 0), y: num('cy', 30), z: num('cz', 40) }, { x: 0, y: 0, z: 0 });
  p.onFrame((dt) => {
    step(dt);
    if (q.get('track') === '1') aim();
  });
};
export default scene;

/** World up and forward in the spine's and the head's bone frames, in the bind pose (before any update). */
function frames(people: PeopleFactory) {
  const v = new THREE.Vector3();
  const qq = new THREE.Quaternion();
  for (const id of people.manifest.sets.park) {
    const spec = people.spec(id)!;
    const r = people.create(plainLook(spec));
    r.root.updateMatrixWorld(true);
    const out: string[] = [];
    for (const b of ['spine_03', 'Head', 'clavicle_l'] as const) {
      const bone = r.bone(b);
      bone.getWorldQuaternion(qq).invert();
      const up = v.set(0, 1, 0).applyQuaternion(qq).toArray().map((x) => x.toFixed(3)).join(',');
      // the person faces -z
      const fwd = v.set(0, 0, -1).applyQuaternion(qq).toArray().map((x) => x.toFixed(3)).join(',');
      const left = v.set(-1, 0, 0).applyQuaternion(qq).toArray().map((x) => x.toFixed(3)).join(',');
      out.push(`${b}: up ${up} fwd ${fwd} left ${left}`);
    }
    console.warn(`frames ${id}: ${out.join(' | ')}; anchors ${JSON.stringify(spec.anchors)}`);
    r.dispose();
  }
}

/** Someone of every size on the crowd's bench (as Crowd.sitOnBench seats them), side on, each on a bench of their own. */
function bench(p: Parameters<PreviewScene>[0], people: PeopleFactory) {
  const ids = p.params.get('ids')?.split(',') ?? ['Male_Adult_04', 'Male_Adult_01', 'Female_Adult_03', 'MH_Older_Woman_01', 'Female_Child_01', 'MH_Child_Boy_01', 'MH_Toddler_Girl_01'];
  const wood = new THREE.MeshStandardMaterial({ color: '#a4683b', roughness: 0.8 });
  const iron = new THREE.MeshStandardMaterial({ color: '#2b2b30', roughness: 0.45, metalness: 0.6 });
  const seat = benchGeometry();
  const frame = benchFrame();
  const fwd = Number(p.params.get('fwd') ?? 0);
  const origin = new THREE.Vector3(0, 0, 800);
  const rigs: PersonRig[] = [];
  ids.forEach((id, i) => {
    const spec = people.spec(id);
    if (!spec) return;
    const z = origin.z - i * 1.7;
    const b = new THREE.Group();
    b.add(new THREE.Mesh(seat, wood), new THREE.Mesh(frame, iron));
    b.traverse((o) => (o.castShadow = o.receiveShadow = true));
    // a bench whose sitter faces +z (heading π), as the crowd places them
    b.rotation.y = Math.PI;
    b.position.set(origin.x, 0, z);
    p.ctx.scene.add(b);
    const r = people.create(plainLook(spec));
    r.root.rotation.y = Math.PI;
    r.root.position.set(origin.x, 0.47 - r.seatDrop, z + benchFront(r.height) + fwd);
    r.setBase('sit');
    p.ctx.scene.add(r.root);
    rigs.push(r);
  });
  for (let t = 0; t < 3; t += DT) for (const r of rigs) r.update(DT, 0);
  const mid = origin.z - ((ids.length - 1) * 1.7) / 2;
  p.view({ x: origin.x + 40, y: 0.7, z: mid }, { x: origin.x, y: 0.6, z: mid });
  p.onFrame((dt) => {
    for (const r of rigs) r.update(dt, 0);
  });
}

/** Rows of people (a man, a woman, two children) with each kind of luggage, walking on the spot or standing. */
function luggage(p: Parameters<PreviewScene>[0], people: PeopleFactory) {
  const q = p.params;
  const ids = q.get('ids')?.split(',') ?? ['Male_Adult_08', 'Female_Adult_03', 'Female_Child_01', 'MH_Child_Boy_01'];
  const turn = THREE.MathUtils.degToRad(Number(q.get('turn') ?? 0));
  // the people face the camera (+z) at turn 0
  const heading = Math.PI + turn;
  const kit: { kinds: PropKind[]; speed: number }[] = [
    { kinds: ['suitcase', 'backpack', 'strawHat'], speed: 1.2 },
    { kinds: ['tote', 'pilotCap'], speed: 0 },
    { kinds: ['backpack', 'strawHat'], speed: 0 },
    { kinds: ['tote'], speed: 1.1 },
  ];
  const counts: Record<PropKind, number> = { suitcase: 0, backpack: 0, tote: 0, strawHat: 0, pilotCap: 0 };
  for (const k of kit) for (const kind of k.kinds) counts[kind] += ids.length;
  const bags = new Luggage(counts, p.ctx.quality.shadows);
  p.ctx.scene.add(bags.group);
  const origin = new THREE.Vector3(0, 0, 800);
  const who: { rig: PersonRig; items: PropItem[]; speed: number; st: CaseState }[] = [];
  const colours: Record<PropKind, string> = { suitcase: '#2a4d7a', backpack: '#ff4d6d', tote: '#2ec4b6', strawHat: '#e4c98a', pilotCap: '#1b2033' };
  ids.forEach((id, row) => {
    const spec = people.spec(id);
    if (!spec) return;
    kit.forEach((k, col) => {
      const r = people.create(plainLook(spec));
      r.root.position.set(origin.x + (col - (kit.length - 1) / 2) * 1.5, 0, origin.z - row * 1.6);
      r.root.rotation.y = heading;
      p.ctx.scene.add(r.root);
      const items = k.kinds.map((kind) => bags.add(kind, colours[kind], kind === 'strawHat' && r.look.child ? 0.85 : 1));
      who.push({ rig: r, items, speed: k.speed, st: { pull: k.speed > 0 ? 1 : 0 } });
    });
  });
  const m = new THREE.Matrix4();
  const place = () => {
    for (const w of who)
      for (const it of w.items) {
        if (it.kind === 'suitcase') bags.set(it, pulledCase(w.rig, heading, 0, w.st, it.scale, true, m));
        else if (it.kind === 'backpack') bags.set(it, backpackOn(w.rig, heading, m));
        else if (it.kind === 'tote') bags.set(it, toteOn(w.rig, heading, m));
        else bags.set(it, hatOnHead(w.rig, heading, it.scale, m));
      }
    bags.flush();
  };
  for (let t = 0; t < Number(q.get('t') ?? 2); t += DT) {
    for (const w of who) w.rig.update(DT, w.speed);
    place();
  }
  p.view({ x: origin.x, y: 1.6, z: origin.z + 7.5 }, { x: origin.x, y: 0.9, z: origin.z - 2.2 });
  p.onFrame((dt) => {
    if (q.get('hold') === '1') return;
    for (const w of who) w.rig.update(dt, w.speed);
    place();
  });
}
