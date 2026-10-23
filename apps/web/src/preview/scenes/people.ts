// The people (world/crowd/people-factory.ts, person-rig.ts) on their own, to look at and to measure.
//
//   ?scene=people                                   the park set in a line-up, standing about
//   ?scene=people&base=talk                         …talking (dance, sit on a bench, listen, phone…)
//   ?scene=people&speed=1.4                         …walking on the spot at 1.4 m/s
//   ?scene=people&dye=1&seed=3                      …in random dyes (the chance of a dye)
//   ?scene=people&mode=gaits&ids=Male_Adult_01      one avatar at each pace, stroll to sprint, side on
//   ?scene=people&mode=bench                        people on the park's 0.47 m bench, side on
//   ?scene=people&mode=bench&measure=1              logs where their hips are seated and crouched
//   ?scene=people&mode=hair&ids=Female_Adult_03     own hair and the shades it takes (hairShades); all=1: five fixed tints
//   ?scene=people&mode=hat                          a cap with and without the hat clip
//   ?scene=people&mode=lod&at=14                    LOD0 next to LOD1 at the first switch distance (34: LOD1, LOD2)
//   ?scene=people&mode=crowd                        80 guests walking about; logs update() ms a frame
//   ?scene=people&mode=roles                        roleLook for each role (pilot, cabin, ground… traveller)
//   ?scene=people&mode=gestures                     wave standing and walking, armsUp, kick, Interact, phone, carry
//   ?scene=people&mode=check                        logs the factory's API at work: stand-ins, coloursOf, applyLook, roleLook
//   ?scene=people&mode=wear                         Rosa (the hero Female_Adult_09) in her apron and the fair's cap, then cabin
//                                                   crew in their scarves (rosa=0, crew=0, cap=0, colour=#rrggbb, each=4)
//   ?scene=people&mode=night&hour=22                the same people after dark under the old flat grey glow, then setGlow's own colours
//   ?scene=people&mode=selftest                     logs PASS/FAIL: stand-in warnings, concurrent loads, garments (late textures,
//                                                   LODs, shadows, recolour, on and off), applyLook mid-gesture, dispose,
//                                                   a missing manifest; then fidgets and freeing the GPU's copies
//
// glow=k sets every rig's setGlow(k) (default: the hour's, from the environment). mask=<url> borrows
// hair masks for avatars whose files don't carry one yet: <url><id>.png (R scalp, G beard) and
// <url>tones.json ({ id: { scalp: {mean, colour}, beard: … } }), e.g. from hair-mask.mjs.
//
// A long row is seen at an angle at its ends: fov=12 frames it from further off, nearly flat on.
// hold=1 stops the clock at the shot (on for gestures, so a gesture is caught mid-way).
//
// Common parameters: ids (avatar ids), set (default park), t (seconds played before the shot,
// default 3), turn (degrees; 0 faces the camera), seed, labels=0, tier (the factory's tier, default the detected one).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PreviewApi, PreviewScene } from '../main';
import type { Tier } from '../../world/quality';
import { downloadPeople, PeopleFactory } from '../../world/crowd/people-factory';
import { LOD_DISTANCES, type Base, type PersonRig } from '../../world/crowd/person-rig';
import type { LookRole } from '../../world/crowd/people-factory';
import { AIRLINE, dyeLook, hairShades, plainLook, type Look } from '../../world/crowd/looks';
import { PALETTE } from '../../world/textures';

/** What walking about needs of a rig. */
interface AnyRig {
  root: THREE.Object3D;
  update(dt: number, speed: number): void;
}

const DT = 1 / 30;

const scene: PreviewScene = async (p) => {
  const q = p.params;
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const mode = q.get('mode') ?? 'lineup';
  const { scene: sc, renderer } = p.ctx;
  const origin = new THREE.Vector3(0, 0, p.env ? 800 : 0);
  const rnd = mulberry(num('seed', 1));
  const labels = q.get('labels') !== '0';
  stage(p, origin);

  // ---- the people: download first (no renderer needed), then parse
  const t0 = performance.now();
  const tier = (q.get('tier') as Tier | null) ?? p.ctx.quality.tier;
  // (dltier=0: a download that doesn't know the tier, as when the game starts it before the renderer)
  const dl = downloadPeople({ sets: [q.get('set') ?? 'park'], tier: q.get('dltier') === '0' ? undefined : tier });
  const people = await PeopleFactory.create(renderer, dl, { tier });
  const ready = performance.now() - t0;
  const s = people.stats;
  console.warn(
    `people: ${s.templates} avatars (tier ${tier}), ${(dl.bytes / 1e6).toFixed(1)} MB downloaded in ${s.downloadMs.toFixed(0)} ms, parsed in ${s.parseMs.toFixed(0)} ms, ready after ${ready.toFixed(0)} ms; textures ${(s.textureBytes / 1048576).toFixed(1)} MiB on the GPU`,
  );
  const ids = q.get('ids')?.split(',').filter(Boolean);
  for (const id of ids ?? []) if (!people.has(id)) await people.load(id);
  // mask=<url/>: hair masks made outside the GLBs (<url><id>.png, R scalp and G beard, and their tones
  // in <url>tones.json), put on the loaded avatars as if their files carried them
  if (q.has('mask')) await borrowHairMasks(people, q.get('mask')!, ids ?? []);

  const play = (rigs: AnyRig[], seconds: number, speed = 0) => {
    for (let i = 0; i < seconds / DT; i++) for (const r of rigs) r.update(DT, speed);
  };

  if (mode === 'crowd') return crowd(p, people, origin, rnd);

  if (mode === 'check') {
    // the factory's API, logged: a stand-in for an avatar not loaded, coloursOf, applyLook, anchors
    const log = (s: string) => console.warn(`check: ${s}`);
    const pilotSpec = people.spec('Pilot_Male_01');
    if (pilotSpec) {
      const r = people.create(plainLook(pilotSpec));
      log(`Pilot_Male_01 before loadSet('airport'): built from ${r.spec.id}; look.avatar ${r.look.avatar}`);
      await people.loadSet('airport');
      log(`after loadSet('airport'): ${people.create(plainLook(pilotSpec)).spec.id}; isSetLoaded ${people.isSetLoaded('airport')}`);
    }
    for (const id of ['Male_Adult_01', 'Female_Adult_03', 'MH_Toddler_Girl_01']) {
      const spec = people.spec(id);
      if (!spec) continue;
      const look = plainLook(spec);
      const r = people.create(look);
      const dyed = dyeLook(plainLook(spec), spec, rnd, 1);
      const same = r.applyLook(dyed);
      const other = r.applyLook(plainLook(people.spec('Female_Adult_01')!));
      const head = r.anchor('headTop');
      log(`${id}: own colours ${JSON.stringify(people.coloursOf(look))}; dyed ${JSON.stringify(people.coloursOf(dyed))}`);
      log(`${id}: applyLook same avatar ${same}, other avatar ${other}; canTint top ${r.canTint('top')} bottom ${r.canTint('bottom')} shoes ${r.canTint('shoes')} hair ${r.canTint('hair')}; hairShades ${hairShades(spec).length}`);
      log(`${id}: height ${r.height.toFixed(2)}, headTop y ${head.y.toFixed(2)}, seatDrop ${r.seatDrop.toFixed(3)}, seatPoint ${r.seatPoint().toArray().map((v) => v.toFixed(2)).join(' ')}; ${r.clipNames().length} clips, Wave ${r.has('Wave')}, Interact ${r.has('Interact')}; parts ${Object.keys(r.parts.extras).join(',') || '-'}${r.parts.hair ? ' +hair' : ''}`);
      r.dispose();
    }
    const roles = (['pilot', 'cabin', 'ground', 'mechanic', 'security', 'swim', 'beach', 'traveller'] as LookRole[]).map((role) => `${role} ${people.roleLook(role, rnd).avatar}`);
    log(`roleLook (airport loaded, island not): ${roles.join('; ')}`);
    log(`randomLook: ${Array.from({ length: 8 }, () => people.randomLook(rnd).avatar).join(', ')}; old: ${Array.from({ length: 4 }, () => people.randomLook(rnd, { age: 'old' }).avatar).join(', ')}; children: ${Array.from({ length: 4 }, () => people.randomLook(rnd, { child: true }).avatar).join(', ')}`);
    return;
  }

  if (mode === 'selftest') {
    await robustness(p, people, rnd);
    // regressions, logged: a fidget mustn't freeze the legs of someone who sets off; disposing frees the GPU's copies
    const log = (s: string) => console.warn(`selftest: ${s}`);
    const specs = (people.manifest.sets.park ?? []).map((id) => people.spec(id)!).filter((s) => people.has(s.id));
    const rigs = specs.map((s) => people.create(plainLook(s)));
    type Peek = { shots: { kind: string; w: number }[]; gaits: { action: THREE.AnimationAction }[] };
    const peek = (r: PersonRig) => r as unknown as Peek;
    let fidgeting = 0;
    let frozen = 0;
    for (const r of rigs) {
      // stand until a fidget is under way, then set off walking
      for (let i = 0; i < 40 / DT && !peek(r).shots.some((s) => s.kind === 'fidget' && s.w > 0.9); i++) r.update(DT, 0);
      if (!peek(r).shots.some((s) => s.kind === 'fidget')) continue;
      fidgeting++;
      play([r], 0.6, 1.4);
      const legs = peek(r).gaits.reduce((s, g) => s + g.action.getEffectiveWeight(), 0);
      if (legs < 0.8) frozen++;
    }
    log(`${fidgeting} of ${rigs.length} were fidgeting when they set off walking; legs walking 0.6 s later on all but ${frozen}`);
    // GPU memory: build, draw and dispose 20 people, twice
    const tex = () => renderer.info.memory.textures;
    const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    cam.position.set(0, 1.5, 6);
    const looks = Array.from({ length: 20 }, () => people.randomLook(rnd));
    const round = () => {
      const batch = looks.map((look, i) => {
        const r = people.create(look);
        r.root.position.x = i * 0.5 - 5;
        r.update(DT, 0);
        sc.add(r.root);
        return r;
      });
      renderer.render(sc, cam);
      for (const r of batch) r.dispose();
      renderer.render(sc, cam);
    };
    round();
    const t1 = tex();
    round();
    round();
    log(`textures on the GPU: ${t1} after 20 people came and went, ${tex()} after the same 20 came and went twice more`);
    // every person has their own materials, but they should share a handful of compiled programs
    const programs = () => renderer.info.programs?.length ?? 0;
    const p0 = programs();
    for (const r of rigs) (r.root.position.x = (rigs.indexOf(r) % 13) * 0.6 - 4), sc.add(r.root);
    renderer.render(sc, cam);
    let materials = 0;
    for (const r of rigs) materials += r.skinnedMeshes.length;
    log(`shader programs: ${p0} before the ${rigs.length} park people were drawn, ${programs()} after (${materials} skinned meshes)`);
    for (const r of rigs) r.dispose();
    return;
  }

  if (mode === 'hairfit') {
    // where the hair cards and the scalp are in the head bone's frame (x up to the crown, +y forward, +z left)
    for (const id of ids ?? ['Male_Adult_01', 'Female_Adult_03']) {
      const spec = people.spec(id);
      if (!spec) continue;
      const r = people.create(plainLook(spec));
      const sk = r.parts.body.skeleton;
      const hi = sk.bones.indexOf(r.bone('Head') as THREE.Bone);
      const toHead = new THREE.Matrix4();
      const stats = (m: THREE.SkinnedMesh | null) => {
        if (!m) return null;
        toHead.multiplyMatrices(sk.boneInverses[hi], m.bindMatrix);
        const pos = m.geometry.getAttribute('position');
        const si = m.geometry.getAttribute('skinIndex');
        const sw = m.geometry.getAttribute('skinWeight');
        const v = new THREE.Vector3();
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++) {
          let head = 0;
          for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) head += sw.getComponent(i, k);
          if (head < 0.5) continue;
          pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(toHead).clone());
        }
        const top = Math.max(...pts.map((p) => p.x));
        const band = (lo: number) => {
          const b = pts.filter((p) => p.x > top - lo);
          return `below top ${lo}: fwd ${Math.max(...b.map((p) => p.y)).toFixed(3)} back ${Math.min(...b.map((p) => p.y)).toFixed(3)} side ${Math.max(...b.map((p) => Math.abs(p.z))).toFixed(3)}`;
        };
        return `${pts.length} verts, top x ${top.toFixed(3)}; ${[0.04, 0.08, 0.11, 0.14].map(band).join('; ')}`;
      };
      console.warn(`hairfit ${id}: headTop ${spec.anchors.headTop.at.join(',')}\n  head: ${stats(r.parts.head)}\n  hair: ${stats(r.parts.hair)}`);
      r.dispose();
    }
    return;
  }

  if (mode === 'lod') {
    // two of the same person side by side at a switch distance: the nearer LOD and the farther
    const at = num('at', LOD_DISTANCES[0]);
    const id = ids?.[0] ?? 'Male_Adult_01';
    const lods = at >= LOD_DISTANCES[1] ? [1, 2] : [0, 1];
    const rigs = lods.map((lod, i) => {
      const r = people.create(plainLook(people.spec(id)!));
      r.root.position.set(origin.x + (i - 0.5) * 1.1, 0, origin.z - at);
      r.root.rotation.y = Math.PI * 0.85;
      r.setDistance([0, 24, 100][lod]);
      sc.add(r.root);
      if (labels) r.root.add(tag(`LOD${lod}`, r.height));
      return r;
    });
    play(rigs, num('t', 3), num('speed', 0));
    p.onFrame((dt) => rigs.forEach((r) => r.update(dt, num('speed', 0))));
    const tris = (r: PersonRig) => {
      const out: number[] = [];
      for (const lod of [0, 1, 2]) {
        r.setDistance([0, 24, 100][lod]);
        let n = 0;
        for (const m of r.skinnedMeshes) {
          let shown = true;
          for (let o: THREE.Object3D | null = m; o && o !== r.root; o = o.parent) shown &&= o.visible;
          if (shown) n += (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
        }
        out.push(n);
      }
      return out;
    };
    const probe = people.create(plainLook(people.spec(id)!));
    console.warn(`lod: ${id} triangles LOD0/1/2 = ${tris(probe).join(' / ')}; switches at ${LOD_DISTANCES.join(', ')} m (for 1.75 m)`);
    probe.dispose();
    p.view({ x: origin.x, y: 1.6, z: origin.z }, { x: origin.x, y: 0.9, z: origin.z - at });
    return;
  }

  // the avatars in the row
  const set = q.get('set') ?? 'park';
  const avatarIds = ids ?? people.manifest.sets[set]?.filter((id) => people.has(id)) ?? [];
  const turn = (num('turn', 0) * Math.PI) / 180;
  const base = (q.get('base') ?? 'stand') as Base;

  if (mode === 'bench') {
    // side on: each sitter on their own bench, one behind another, so the hips can be compared
    const who: { rig: PersonRig; label: string }[] = [];
    for (const id of ids ?? ['Male_Adult_01', 'Female_Adult_01', 'Business_Female_01', 'MH_Older_Woman_01', 'Female_Child_01', 'MH_Toddler_Girl_01']) {
      const spec = people.spec(id);
      if (!spec) continue;
      if (!people.has(id)) await people.load(id);
      const r = people.create(plainLook(spec));
      who.push({ rig: r, label: `${id} ${r.height.toFixed(2)}` });
    }
    const pose = (q.get('base') ?? 'sit') as 'sit' | 'crouch';
    const benchGeo = benchGeometry();
    const wood = new THREE.MeshStandardMaterial({ color: '#a4683b', roughness: 0.8 });
    const iron = new THREE.MeshStandardMaterial({ color: '#2b2b30', roughness: 0.45, metalness: 0.6 });
    const frameGeo = benchFrame();
    who.forEach((w, i) => {
      const z = origin.z - i * 1.7;
      if (pose === 'sit') {
        const bench = new THREE.Group();
        bench.add(new THREE.Mesh(benchGeo, wood), new THREE.Mesh(frameGeo, iron));
        bench.traverse((o) => (o.castShadow = o.receiveShadow = true));
        // the bench faces +z (its backrest on the -z side), like a park bench with heading π
        bench.rotation.y = Math.PI;
        bench.position.set(origin.x, 0, z);
        sc.add(bench);
        // as the crowd seats someone: the root 6 cm in front of the bench's middle, seatDrop below the seat
        // (fwd=…: that much further forward, to try a fix for the backrest)
        w.rig.root.position.set(origin.x, 0.47 - w.rig.seatDrop, z + 0.06 + num('fwd', 0));
      } else w.rig.root.position.set(origin.x, 0, z);
      w.rig.root.rotation.y = Math.PI;
      w.rig.setBase(pose);
      sc.add(w.rig.root);
      if (labels) w.rig.root.add(tag(w.label, w.rig.height));
    });
    const rigs = who.map((w) => w.rig);
    if (q.get('measure') === '1') {
      // the hips relative to the root, in the root's frame (+z behind the person), averaged over the loop
      const hipsOf = (w: (typeof who)[number]) => {
        const sum = new THREE.Vector3();
        const feet = new THREE.Vector3();
        const v = new THREE.Vector3();
        const n = 120;
        const node = (name: 'pelvis' | 'foot_l' | 'foot_r') => w.rig.bone(name);
        for (let i = 0; i < n; i++) {
          play([w.rig], 0.1);
          w.rig.root.updateMatrixWorld(true);
          sum.add(w.rig.root.worldToLocal(node('pelvis').getWorldPosition(v)));
          feet.add(w.rig.root.worldToLocal(node('foot_l').getWorldPosition(v)).multiplyScalar(0.5));
          feet.add(w.rig.root.worldToLocal(node('foot_r').getWorldPosition(v)).multiplyScalar(0.5));
        }
        return { hips: sum.divideScalar(n), feet: feet.divideScalar(n) };
      };
      play(rigs, 2);
      for (const w of who) {
        const { hips: h, feet } = hipsOf(w);
        const k = w.rig.height;
        console.warn(`${pose} ${w.label}: hips x ${h.x.toFixed(3)} y ${h.y.toFixed(3)} z ${h.z.toFixed(3)} m; per metre of height x ${(h.x / k).toFixed(4)} z ${(h.z / k).toFixed(4)}; hips above the seat ${(h.y + w.rig.root.position.y - 0.47).toFixed(3)} m; seatDrop ${w.rig.seatDrop.toFixed(3)}; feet x ${feet.x.toFixed(3)} y ${feet.y.toFixed(3)} z ${feet.z.toFixed(3)} (z per metre ${(feet.z / k).toFixed(4)})`);
      }
    } else play(rigs, num('t', 3));
    p.onFrame((dt) => rigs.forEach((r) => r.update(dt, 0)));
    // from the person's right, level with the seat
    const midZ = origin.z - ((who.length - 1) * 1.7) / 2;
    const cam = p.ctx.camera;
    const halfW = Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
    p.view({ x: origin.x + (who.length * 1.7) / 2 / halfW + 1, y: 0.75, z: midZ }, { x: origin.x, y: 0.7, z: midZ });
    return;
  }

  // ---- rows of people: the line-up, the gaits, dyes, hair, the hat
  interface Fig {
    look: Look;
    label: string;
    base?: Base;
    speed?: number;
    hat?: 'cap' | 'clip';
    /** Done `after` seconds before the shot: 'wave', 'armsUp', 'kick', or a clip name to play(). */
    act?: string;
    after?: number;
    /** Degrees, instead of the row's turn. */
    turn?: number;
    /** After dark: 'own' is setGlow (the person's own colours), 'flat' the old rig's flat grey emissive. */
    glow?: 'own' | 'flat';
  }
  const figs: Fig[] = [];
  let heads = false;
  if (mode === 'gaits') {
    for (const id of ids ?? ['Male_Adult_01', 'Female_Adult_01']) {
      const spec = people.spec(id);
      if (!spec) continue;
      for (const v of [0, 0.7, 1.0, 1.4, 1.9, 2.4, 3.1, 4.5, 5.8]) figs.push({ look: plainLook(spec), label: `${id.replace(/_Adult/, '')} ${v.toFixed(1)} m/s`, speed: v });
    }
  } else if (mode === 'dyes') {
    for (const id of ids ?? ['Male_Adult_04', 'Female_Adult_04', 'Business_Female_01', 'Male_Child_01']) {
      const spec = people.spec(id);
      if (!spec) continue;
      figs.push({ look: plainLook(spec), label: `${id} own` });
      for (let i = 0; i < 4; i++) {
        const look = dyeLook(plainLook(spec), spec, rnd, 1);
        figs.push({ look, label: [look.top, look.bottom, look.hair].filter(Boolean).join(' ') || 'own' });
      }
    }
  } else if (mode === 'hair') {
    heads = true;
    const fixed: [string, string | null][] = [
      ['black', '#16110e'],
      ['brown', '#4a3020'],
      ['blonde', '#cfae74'],
      ['grey', '#b9b6b0'],
      ['auburn', '#a2502a'],
    ];
    for (const id of ids ?? ['Female_Adult_03']) {
      const spec = people.spec(id);
      if (!spec) continue;
      const tints: [string, string | null][] = [['own', null], ...(q.get('all') === '1' ? fixed : hairShades(spec).map((c): [string, string] => [c, c]))];
      for (const [name, c] of tints) figs.push({ look: { ...plainLook(spec), hair: c }, label: `${id.replace('_Adult', '')} ${name}` });
    }
  } else if (mode === 'roles') {
    await people.loadSet('airport');
    await people.loadSet('island');
    const roles: LookRole[] = ['pilot', 'cabin', 'ground', 'mechanic', 'security', 'swim', 'beach', 'traveller'];
    for (const role of roles)
      for (let i = 0; i < num('each', 2); i++) {
        const look = people.roleLook(role, rnd);
        figs.push({ look, label: `${role}: ${look.avatar}` });
      }
  } else if (mode === 'gestures') {
    for (const id of ids ?? ['Male_Adult_01', 'Female_Adult_01']) {
      const spec = people.spec(id);
      if (!spec) continue;
      const look = () => plainLook(spec);
      figs.push(
        { look: look(), label: 'wave (clip)', act: 'wave', after: num('after', 1.3) },
        { look: look(), label: 'wave walking', act: 'wave', after: 1.1, speed: 1.3 },
        { look: look(), label: 'armsUp', act: 'armsUp', after: 1 },
        { look: look(), label: 'kick', act: 'kick', after: 0.24 },
        { look: look(), label: 'Interact walking', act: 'Interact', after: 0.7, speed: 1.3 },
        { look: look(), label: 'Interact seated', act: 'Interact', after: 0.7, base: 'sit' },
        { look: look(), label: 'phone walking', base: 'phone', speed: 1.3 },
        { look: look(), label: 'carry', base: 'carry', speed: 1.2 },
      );
    }
  } else if (mode === 'wear') {
    // Rosa in her apron and the fair's cap (front, side, back, talking, serving, waving), then cabin
    // crew in the airline's suit and scarf (roleLook, as the airport dresses them), front and back
    const rosa = people.spec('Female_Adult_09');
    if (rosa && q.get('rosa') !== '0') {
      await people.load(rosa.id, { hero: true });
      const look = () => ({ ...plainLook(rosa, 1, 1, true), wear: { apron: q.get('colour') ?? PALETTE.teal } });
      const cap = q.get('cap') === '0' ? undefined : 'clip';
      figs.push(
        { look: look(), label: 'Rosa', hat: cap },
        { look: look(), label: 'Rosa, side', hat: cap, turn: 90 },
        { look: look(), label: 'Rosa, back', hat: cap, turn: 180 },
        { look: look(), label: 'Rosa talking', hat: cap, base: 'talk' },
        { look: look(), label: 'Rosa serving', hat: cap, act: 'Interact', after: 0.9 },
        { look: look(), label: 'Rosa waving', hat: cap, act: 'wave', after: 1.3 },
        { look: look(), label: 'Rosa walking', hat: cap, speed: 1.2, turn: 60 },
      );
    }
    if (q.get('crew') !== '0') {
      await people.loadSet('airport');
      const crew = Array.from({ length: num('each', 4) }, () => people.roleLook('cabin', rnd));
      for (const look of crew) figs.push({ look, label: `cabin: ${look.avatar}` });
      for (const look of crew.slice(0, 2)) figs.push({ look: { ...look }, label: `${look.avatar}, back`, turn: 180 });
      figs.push({ look: { ...crew[0] }, label: `${crew[0].avatar} walking`, speed: 1.3, turn: 45 });
    }
  } else if (mode === 'night') {
    // the same dyed people twice after dark: lit by the old rig's flat grey glow, then by their own colours
    const pool = ids ?? ['Male_Adult_04', 'Female_Adult_04', 'Business_Female_01', 'Male_Adult_12', 'Female_Adult_12'];
    const looks: Look[] = [];
    for (const id of pool) {
      const spec = people.spec(id);
      if (!spec) continue;
      looks.push(plainLook(spec), dyeLook(plainLook(spec), spec, rnd, 1));
    }
    const rosa = people.spec('Female_Adult_09');
    if (rosa) {
      await people.load(rosa.id, { hero: true });
      looks.push({ ...plainLook(rosa, 1, 1, true), wear: { apron: PALETTE.teal } });
    }
    for (const look of looks) figs.push({ look, label: `${look.avatar.replace('_Adult', '')} flat`, glow: 'flat' });
    for (const look of looks) figs.push({ look: { ...look }, label: `${look.avatar.replace('_Adult', '')} own`, glow: 'own' });
  } else if (mode === 'hat') {
    heads = true;
    for (const id of ids ?? ['Male_Adult_01', 'Female_Adult_03']) {
      const spec = people.spec(id);
      if (!spec) continue;
      figs.push({ look: plainLook(spec), label: `${id}` }, { look: plainLook(spec), label: 'cap, no clip', hat: 'cap' }, { look: plainLook(spec), label: 'cap + hat clip', hat: 'clip' });
    }
  } else {
    for (const id of avatarIds) {
      const spec = people.spec(id);
      if (!spec) continue;
      const look = plainLook(spec);
      if (num('dye', 0) > 0) dyeLook(look, spec, rnd, num('dye', 0));
      figs.push({ look, label: id });
    }
  }

  const rigs: (AnyRig & { wave(seconds: number): void })[] = [];
  let x = 0;
  let last = 0;
  const speeds: number[] = [];
  const sit = base === 'sit';
  for (const f of figs) {
    const r = people.create(f.look);
    const gap = r.look.child ? 0.62 : 0.85;
    x += rigs.length ? gap / 2 : 0;
    last = x;
    const seated = (f.base ?? base) === 'sit';
    r.root.position.set(origin.x + x, seated ? 0.47 - r.seatDrop : 0, origin.z + (seated ? 0.06 : 0));
    if (seated && !sit) {
      // a bench of their own
      const bench = new THREE.Mesh(benchGeometry(0.4), new THREE.MeshStandardMaterial({ color: '#a4683b', roughness: 0.8 }));
      bench.rotation.y = Math.PI;
      bench.position.set(origin.x + x, 0, origin.z);
      bench.castShadow = bench.receiveShadow = true;
      sc.add(bench);
    }
    r.root.rotation.y = Math.PI + (f.turn !== undefined ? (f.turn * Math.PI) / 180 : turn);
    r.setBase(f.base ?? base);
    if (f.hat) wearCap(r, f.hat === 'clip');
    if (f.hat === 'clip' && q.has('hatr')) {
      // try another clip: hatr=rx,ry,rz (and hatc=cx,cy,cz), in the head bone's frame
      const d = r.defaultHatClip();
      const v = (k: string, def: number[]) => (q.get(k)?.split(',').map(Number) ?? def) as [number, number, number];
      r.setHatClip({ ...d, centre: v('hatc', d.centre), radii: v('hatr', d.radii) });
    }
    sc.add(r.root);
    if (labels) r.root.add(tag(f.label, r.height));
    rigs.push(r);
    speeds.push(f.speed ?? num('speed', 0));
    x += gap / 2;
  }
  if (sit) {
    // one long bench under the row
    const bench = new THREE.Group();
    const geo = benchGeometry((last + 1.4) / 1.8);
    bench.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#a4683b', roughness: 0.8 })));
    bench.rotation.y = Math.PI;
    bench.position.set(origin.x + (last + 0.9) / 2, 0, origin.z);
    bench.traverse((o) => (o.castShadow = o.receiveShadow = true));
    sc.add(bench);
  }
  // played t seconds before the first frame; the page renders `frames` (30) more before the shot.
  // hold=1 (on for gestures) stops the clock there, so an act `after` seconds before the shot is
  // caught at that moment however long the screenshot takes.
  const t = num('t', 3);
  const frames = num('frames', 30);
  const hold = q.get('hold') === '1' || ((mode === 'gestures' || mode === 'wear') && q.get('hold') !== '0');
  const shotAt = t + (hold ? frames * DT : 0);
  const acts = figs.map((f) => (f.act ? shotAt - (f.after ?? 1) : Infinity));
  // after dark everyone glows as the game has them (glow=k overrides the environment's night)
  const glowK = () => (q.has('glow') ? num('glow', 0) : (p.env?.night ?? 0));
  const glow = (r: PersonRig, how: Fig['glow'], k: number) => {
    if (how !== 'flat') return r.setGlow(k);
    // the old rig's: a flat grey added to every material, dyes or not
    r.setGlow(0);
    const mats = [...r.skinnedMeshes, r.garment('apron'), r.garment('scarf')].map((m) => m?.material as THREE.MeshStandardMaterial | undefined);
    for (const m of mats) m?.emissive.setScalar(0.09 * k);
  };
  let clock = 0;
  const step = (dt: number) => {
    const k = glowK();
    for (let j = 0; j < figs.length; j++) glow(rigs[j] as PersonRig, figs[j].glow, k);
    rigs.forEach((r, j) => {
      if (j < figs.length && clock >= acts[j]) {
        acts[j] = Infinity;
        const rig = r as PersonRig;
        const act = figs[j].act!;
        if (act === 'wave') rig.wave(2.2);
        else if (act === 'armsUp') rig.armsUp = 1;
        else if (act === 'kick') rig.kick();
        else rig.play(act);
      }
      r.update(dt, speeds[j]);
    });
    clock += dt;
  };
  for (let i = 0; i < t / DT; i++) step(DT);
  p.onFrame((dt) => {
    if (!hold || clock < shotAt - 1e-6) step(dt);
  });
  if (q.get('wave') === '1') rigs.forEach((r) => r.wave(2.2));

  // frame the row (heads and shoulders for the hair and the hat)
  const width = Math.max(1, last + 0.8);
  const mid = origin.x + last / 2;
  const cam = p.ctx.camera;
  const halfH = Math.tan((cam.fov * Math.PI) / 360);
  if (heads) {
    const dist = Math.max((width / 2 + 0.15) / (halfH * cam.aspect), 0.45 / halfH);
    p.view({ x: mid, y: 1.55, z: origin.z + dist }, { x: mid, y: 1.45, z: origin.z });
  } else {
    const dist = Math.max((width / 2 + 0.5) / (halfH * cam.aspect), 1.15 / halfH);
    p.view({ x: mid, y: 1.0, z: origin.z + dist }, { x: mid, y: 0.9, z: origin.z });
  }
};
export default scene;

/** Lights, a ground and (with the real environment) the sky brought out here. */
function stage(p: PreviewApi, origin: THREE.Vector3) {
  const { scene: sc, renderer } = p.ctx;
  if (!p.env) {
    const pm = new THREE.PMREMGenerator(renderer);
    sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    sc.environmentIntensity = 0.45;
    sc.add(new THREE.HemisphereLight('#e8f0ff', '#6a6250', 1.0));
    const sun = new THREE.DirectionalLight('#fff4e6', 2.4);
    sun.position.set(origin.x - 12, 22, origin.z + 14);
    sun.target.position.copy(origin);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -30;
    c.right = c.top = 30;
    c.near = 1;
    c.far = 80;
    sun.shadow.bias = -0.0005;
    sc.add(sun, sun.target);
  } else {
    const sky = sc.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);
    p.onFrame(() => sky?.position.copy(p.ctx.camera.position));
  }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(120, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#8d8b84', roughness: 0.95 }));
  ground.position.copy(origin).setY(0.001);
  ground.receiveShadow = true;
  p.ctx.scene.add(ground);
}

/**
 * 80 guests walking about a 70 m square, the crowd's LOD and update rate by distance (crowd.ts:
 * every frame within 30 m, every 2nd within 70, every 4th beyond). Logs the CPU time of the rigs' update() and the draw calls and triangles.
 */
function crowd(p: PreviewApi, people: PeopleFactory, origin: THREE.Vector3, rnd: () => number) {
  const q = p.params;
  const count = Number(q.get('count') ?? 80);
  const frames = Number(q.get('frames') ?? 30);
  const half = 35;
  interface Walker {
    rig: AnyRig;
    lod: (d: number) => void;
    x: number;
    z: number;
    tx: number;
    tz: number;
    v: number;
    acc: number;
  }
  const walkers: Walker[] = [];
  const spot = () => [origin.x + (rnd() * 2 - 1) * half, origin.z + (rnd() * 2 - 1) * half];
  for (let i = 0; i < count; i++) {
    const child = rnd() < 0.15;
    const rig = people.create(people.randomLook(rnd, { child }));
    const lod = (d: number) => rig.setDistance(d);
    const [x, z] = spot();
    const [tx, tz] = spot();
    walkers.push({ rig, lod, x, z, tx, tz, v: 0.9 + rnd() * 0.6, acc: 0 });
    p.ctx.scene.add(rig.root);
  }
  // a guest's-eye view over the crowd, as the game's camera behind the visitor
  const eye = new THREE.Vector3(origin.x, 5, origin.z + half + 6);
  p.view(eye, { x: origin.x, y: 0, z: origin.z + 4 });
  let frame = 0;
  const times: number[] = [];
  let updates = 0;
  const warm = Math.min(60, Math.floor(frames / 3));
  const due: Walker[] = [];
  const dist: number[] = [];
  p.onFrame((dt) => {
    frame++;
    due.length = 0;
    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i];
      const dx = w.tx - w.x;
      const dz = w.tz - w.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) [w.tx, w.tz] = spot();
      else {
        w.x += (dx / d) * w.v * dt;
        w.z += (dz / d) * w.v * dt;
        w.rig.root.rotation.y = Math.atan2(-dx, -dz);
      }
      w.rig.root.position.set(w.x, 0, w.z);
      dist[i] = eye.distanceTo(w.rig.root.position);
      w.acc += dt;
      const every = dist[i] < 30 ? 1 : dist[i] < 70 ? 2 : 4;
      if ((frame + i) % every === 0) due.push(w);
    }
    // timed as one block (performance.now is coarse: summing 80 tiny intervals would mostly add up its rounding)
    const t0 = performance.now();
    for (let i = 0; i < walkers.length; i++) walkers[i].lod(dist[i]);
    for (const w of due) {
      w.rig.update(w.acc, w.v);
      w.acc = 0;
    }
    const spent = performance.now() - t0;
    if (frame > warm) {
      times.push(spent);
      updates += due.length;
    }
    if (frame === frames - 1) {
      const sorted = [...times].sort((a, b) => a - b);
      const mean = times.reduce((s, v) => s + v, 0) / Math.max(1, times.length);
      console.warn(
        `crowd: ${count} walking, LOD + update() ${mean.toFixed(3)} ms a frame mean, ${sorted[Math.floor(sorted.length / 2)].toFixed(3)} median (${times.length} frames, ${(updates / times.length).toFixed(1)} rigs updated a frame)`,
      );
    }
  });
}

/**
 * Hair masks from elsewhere (before the GLBs carry them): each avatar's <url><id>.png goes on its
 * loaded templates as the 'hairMask' GLTFLoader would have read, and its tones (<url>tones.json:
 * { id: { scalp, beard } }) into its spec's hairTone, as the manifest will give them.
 */
async function borrowHairMasks(people: PeopleFactory, url: string, ids: string[]) {
  const tones = (await (await fetch(`${url}tones.json`)).json()) as Record<string, { scalp: unknown; beard: unknown }>;
  const templates = (people as unknown as { templates: Map<string, { hairMask: THREE.Texture | null }> }).templates;
  const loader = new THREE.TextureLoader();
  for (const id of ids) {
    const spec = people.spec(id);
    if (!spec || !tones[id]) continue;
    const tex = await loader.loadAsync(`${url}${id}.png`);
    // (as glTF textures load: unflipped, and data rather than colour)
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.name = 'hairMask';
    for (const file of ['crowd', 'hero']) {
      const t = templates.get(`${id}|${file}`);
      if (t) t.hairMask = tex;
    }
    spec.hairTone = { ...(spec.hairTone ?? { mean: 0.045, colour: '#2f2117' }), ...tones[id] } as typeof spec.hairTone;
    console.warn(`mask: ${id} ${JSON.stringify(tones[id])}`);
  }
}

/**
 * What the game will lean on when it switches to these people, each logged PASS or FAIL: warnings
 * once per avatar, loads shared between callers, garments put on, recoloured, taken off and freed,
 * a person disposed or re-dressed mid-gesture, the glow, and a factory whose manifest is missing.
 */
async function robustness(p: PreviewApi, people: PeopleFactory, rnd: () => number) {
  const { renderer, scene: sc } = p.ctx;
  let fails = 0;
  const ok = (pass: boolean, what: string) => {
    if (!pass) fails++;
    console.warn(`selftest: ${pass ? 'PASS' : 'FAIL'} ${what}`);
  };
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  cam.position.set(0, 1.5, 6);
  const fetched = (file: string) => performance.getEntriesByType('resource').filter((e) => e.name.endsWith(`/${file}`)).length;
  // dev warnings, counted
  const warnings: string[] = [];
  const warn = console.warn;
  const listen = () => (console.warn = (...a: unknown[]) => (warnings.push(a.map(String).join(' ')), warn.apply(console, a)));
  const unhandled: string[] = [];
  const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(String(e.reason));
  addEventListener('unhandledrejection', onUnhandled);

  // 1. a stand-in warns once per avatar asked for, however often it's asked
  const absent = people.manifest.avatars.find((a) => a.files.crowd && !people.has(a.id) && !people.manifest.sets.park?.includes(a.id) && !people.manifest.sets.island?.includes(a.id));
  if (absent) {
    listen();
    const stand = [0, 1, 2].map(() => people.create(plainLook(absent)));
    console.warn = warn;
    const about = warnings.filter((w) => w.includes(absent.id));
    ok(about.length === 1 && stand.every((r) => r.look.avatar !== absent.id), `stand-in for ${absent.id} built 3 times, ${about.length} warning (by ${stand[0].look.avatar})`);
    for (const r of stand) r.dispose();
  }

  // 2. loadSet: two callers at once share one load, each file fetched once; again later, nothing new
  const island = people.manifest.sets.island ?? [];
  const files = island.map((id) => people.spec(id)!.files.crowd!);
  const before = files.map(fetched);
  const a = people.loadSet('island');
  const b = people.loadSet('island');
  await Promise.all([a, b]);
  const once = files.every((f, i) => fetched(f) - before[i] === 1);
  await people.loadSet('island');
  const again = files.every((f, i) => fetched(f) - before[i] === 1);
  ok(a === b && once && again && people.isSetLoaded('island'), `loadSet('island') twice at once: same promise ${a === b}, each of ${files.length} files fetched once ${once}, a third call fetched nothing ${again}`);

  // 3. load(id, { hero }) from two callers at once: one download
  const heroId = people.manifest.avatars.find((a) => a.files.hero && !people.has(a.id, true))?.id;
  if (heroId) {
    const file = people.spec(heroId)!.files.hero!;
    const n0 = fetched(file);
    await Promise.all([people.load(heroId, { hero: true }), people.load(heroId, { hero: true })]);
    ok(fetched(file) - n0 === 1 && people.has(heroId, true), `load('${heroId}', { hero }) twice at once: fetched ${fetched(file) - n0} time(s)`);
  }

  // 4. garments: built with the person, worn at every LOD, recoloured, taken off; shadows, glow, dispose
  const rosaSpec = people.spec('Female_Adult_09')!;
  await people.load(rosaSpec.id, { hero: true });
  // (a colour no garment has had yet: its texture is drawn while the person is built, and must reach the GPU on the first frame)
  const fresh = '#7a3b9e';
  const rosa = people.create({ ...plainLook(rosaSpec, 1, 1, true), wear: { apron: fresh } });
  sc.add(rosa.root);
  rosa.update(DT, 0);
  renderer.render(sc, cam);
  const apron = rosa.garment('apron');
  const map = (apron?.material as THREE.MeshStandardMaterial | undefined)?.map;
  const uploaded = !!map && !!(renderer.properties.get(map) as { __webglTexture?: unknown }).__webglTexture;
  const info = apron?.userData.garment as { ms: number; triangles: number } | undefined;
  ok(!!apron && apron.parent !== null && uploaded, `Rosa built with an apron (${info?.triangles} triangles, ${info?.ms.toFixed(1)} ms), in a new colour drawn and on the GPU after one frame: ${uploaded}`);
  let shown = true;
  for (const d of [5, 25, 60]) {
    rosa.setDistance(d);
    for (let o: THREE.Object3D | null = apron!; o; o = o.parent) shown &&= o.visible;
  }
  ok(shown, 'the apron shows at every LOD (5, 25 and 60 m)');
  rosa.setShadows(false);
  const shadowOff = apron!.castShadow === false;
  rosa.setShadows(true);
  ok(shadowOff && apron!.castShadow, 'setShadows takes the apron along');
  rosa.setGlow(1);
  const glowUniform = (renderer.properties.get(apron!.material) as { uniforms?: Record<string, { value: number }> }).uniforms?.uGlow;
  const bodyGlow = (renderer.properties.get(rosa.parts.body.material) as { uniforms?: Record<string, { value: number }> }).uniforms?.uGlow;
  ok(!!glowUniform && glowUniform === bodyGlow && glowUniform.value > 0, `setGlow(1): the apron and the body share one glow uniform (${glowUniform?.value})`);
  rosa.setGlow(0);
  // recolour in place: the same mesh, another texture
  rosa.applyLook({ ...rosa.look, wear: { apron: PALETTE.teal } });
  const same = rosa.garment('apron') === apron && (apron!.material as THREE.MeshStandardMaterial).map !== map;
  ok(same, 'applyLook with another apron colour recolours the same apron');
  // the garments' memory: put on and taken off 5 times, the GPU's geometry count comes back
  renderer.render(sc, cam);
  const geos = renderer.info.memory.geometries;
  for (let i = 0; i < 5; i++) {
    rosa.applyLook({ ...rosa.look, wear: { apron: PALETTE.teal, scarf: AIRLINE.gold } });
    renderer.render(sc, cam);
    rosa.applyLook({ ...rosa.look, wear: { apron: PALETTE.teal } });
    renderer.render(sc, cam);
  }
  ok(renderer.info.memory.geometries === geos && !rosa.garment('scarf'), `a scarf put on and taken off 5 times: geometries ${geos} → ${renderer.info.memory.geometries}`);

  // 5. re-dressed mid-gesture: the gesture carries on; disposed mid-gesture: nothing throws, and later calls are harmless
  rosa.play('Interact');
  for (let i = 0; i < 10; i++) rosa.update(DT, 0);
  const busy0 = rosa.busy;
  const taller = { ...rosa.look, top: '#c0202a', height: rosa.look.height * 1.03, wear: undefined };
  const applied = rosa.applyLook(taller);
  for (let i = 0; i < 10; i++) rosa.update(DT, 0);
  ok(busy0 && applied && rosa.busy && !rosa.garment('apron') && Math.abs(rosa.height - taller.height) < 1e-6, `applyLook during Interact: applied ${applied}, still busy ${rosa.busy}, apron off ${!rosa.garment('apron')}`);
  const crew = people.create(people.roleLook('cabin', rnd));
  sc.add(crew.root);
  crew.update(DT, 0);
  renderer.render(sc, cam);
  const scarf = crew.garment('scarf');
  // (the avatar's own geometry is the template's, shared and kept: what must go is the scarf's)
  let freed = 0;
  scarf?.geometry.addEventListener('dispose', () => freed++);
  (scarf?.material as THREE.Material | undefined)?.addEventListener('dispose', () => freed++);
  crew.play('Interact');
  crew.wave();
  for (let i = 0; i < 6; i++) crew.update(DT, 1.2);
  let threw = '';
  try {
    crew.dispose();
    crew.update(DT, 1);
    crew.play('Wave');
    crew.wave();
    crew.setBase('talk');
    crew.setGlow(1);
    crew.setDistance(10);
    ok(!crew.applyLook({ ...crew.look, top: '#ffffff' }), 'applyLook on a disposed person says no (build another)');
    crew.dispose();
    renderer.render(sc, cam);
  } catch (e) {
    threw = String(e);
  }
  ok(!!scarf && !threw && freed === 2 && !scarf.parent, `cabin crew (${crew.look.avatar}) with a scarf disposed mid-gesture, then updated, played, waved, re-dressed and disposed again: ${threw || 'nothing threw'}; the scarf's geometry and material freed once each: ${freed === 2}`);
  rosa.dispose();

  // 6. a factory whose manifest is missing rejects, saying what's wrong (and nothing goes unhandled)
  let message = '';
  try {
    await PeopleFactory.create(renderer, downloadPeople({ sets: ['park'], url: `${import.meta.env.BASE_URL}models/no-people-here/` }));
  } catch (e) {
    message = (e as Error).message;
  }
  await new Promise((r) => setTimeout(r, 50));
  ok(/manifest\.json/.test(message) && !unhandled.length, `PeopleFactory.create with no manifest rejects: "${message}"; unhandled rejections: ${unhandled.length}`);
  removeEventListener('unhandledrejection', onUnhandled);
  console.warn(`selftest: robustness ${fails ? `${fails} FAILED` : 'all passed'}`);
}

/** A plain cap on the head bone; `clip`: hide the hair under it with the rig's hat clip. */
function wearCap(r: PersonRig, clip: boolean) {
  const spec = r.spec;
  // in the head bone's frame: x runs up the neck to the crown, +y is forward, +z the person's left
  // (in the bind pose world up is (0.99, -0.15, 0) there, and forward (0.15, 0.99, 0), on every avatar)
  const top = new THREE.Vector3(...spec.anchors.headTop.at);
  const up = top.clone().normalize();
  const fwd = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  const left = new THREE.Vector3().crossVectors(up, fwd);
  // (from the avatar's own height, like defaultHatClip: a child of the head bone already takes the look's scale)
  const s = THREE.MathUtils.clamp(Math.sqrt(spec.height / 1.75), 0.8, 1.05);
  const cap = new THREE.Group();
  cap.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd));
  cap.position.copy(top).addScaledVector(up, -0.1 * s);
  const cloth = new THREE.MeshStandardMaterial({ color: '#1f3f73', roughness: 0.85, side: THREE.DoubleSide });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), cloth);
  dome.scale.set(0.1 * s, 0.104 * s, 0.118 * s);
  dome.position.z = 0.004 * s;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.006, 24, 1, false, -Math.PI / 2, Math.PI), cloth);
  brim.scale.set(0.095 * s, 1, 0.18 * s);
  brim.rotation.x = 0.12;
  brim.position.y = 0.004;
  cap.add(dome, brim);
  cap.traverse((o) => (o.castShadow = true));
  r.bone('Head').add(cap);
  r.setHatClip(clip ? r.defaultHatClip() : null);
}

/** The park bench's slats (crowd.ts), `k` times as long. */
function benchGeometry(k = 1) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) parts.push(new THREE.BoxGeometry(1.8 * k, 0.04, 0.09).translate(0, 0.45, -0.17 + i * 0.11));
  for (let i = 0; i < 3; i++) parts.push(new THREE.BoxGeometry(1.8 * k, 0.09, 0.03).translate(0, 0.62 + i * 0.12, 0.25));
  return mergeGeometries(parts)!;
}

/** Its iron frame (crowd.ts). */
function benchFrame() {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-0.78, 0.78]) {
    parts.push(new THREE.BoxGeometry(0.06, 0.45, 0.06).translate(x, 0.225, -0.18));
    parts.push(new THREE.BoxGeometry(0.06, 0.9, 0.06).translate(x, 0.45, 0.25));
    parts.push(new THREE.BoxGeometry(0.06, 0.05, 0.5).translate(x, 0.43, 0.03));
  }
  return mergeGeometries(parts)!;
}

/** A small caption over a figure's head. */
function tag(text: string, height: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,20,24,0.72)';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#fff';
  g.font = '600 24px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 33, 500);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(0.8, 0.1, 1);
  sp.position.set(0, height + 0.2, 0);
  sp.renderOrder = 10;
  return sp;
}

/** A small seeded random (the same seed, the same crowd). */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
