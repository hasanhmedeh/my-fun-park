// The landing page's stills: 24 pictures of the park, recaptured from the game itself from a list of
// named camera setups (SHOTS), then encoded for the web. Scenery only: nobody near the lens (people
// within `hide` metres of the camera aren't drawn; a few shots keep a distant crowd), golden hour or
// dusk for most, the night shot with the lights on.
//
//   node scripts/film/stills.mjs                       every shot, then encode them all
//   node scripts/film/stills.mjs --only hero,coaster   just these (encodes just these too)
//   node scripts/film/stills.mjs --encode-only         no game: encode the masters already there
//   node scripts/film/stills.mjs --masters <dir>       where the PNG masters go (default: $FILM_STILLS,
//                                                      else film-stills in the system's temp folder)
//
// Capture: a 1920 × 1080 page with the game drawn at twice that (dpr 2), so the browser's downscale
// smooths every edge; the clock is frozen (lib/clock.mjs) and every shot is set up on film time, so
// the moving things (trains, the rocket, the Sky Flip) are where the setup puts them. Needs the
// game's dev server (lib/session.mjs GAME_URL).
//
// Encode: public/media/stills/<name>-<w>.avif and .webp for w = 640, 1280, 1920 (AVIF about q55,
// lowered for the 1920 one until it's under 250 KB; WebP q78), and src/landing/stills.json with
// each still's size, widths, people ("none" or "distant") and where it is.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openGame } from './lib/session.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(WEB, 'public/media/stills');
const MANIFEST = join(WEB, 'src/landing/stills.json');
const WIDTHS = [640, 1280, 1920];
const AVIF_QUALITY = 55;
const AVIF_FLOOR = 35;
const AVIF_MAX_BYTES = 250 * 1024;
const WEBP_QUALITY = 78;

// ---------------------------------------------------------------------------------------------
// The shots. Each runs in the page: `setup` (an async function, sent to the page as its source, so
// it can only use what the page has: __game, __director, __film and __stills below) puts things in
// place and may return { pos, look } for a camera that depends on where something got to; otherwise
// `cam` is used. Then the camera is pinned, the clock set to `hour`, and `settle` frames are drawn
// (trees and map tiles finish loading round the spot), and the picture is taken.
// ---------------------------------------------------------------------------------------------

/** @typedef {{ name: string, where: string, people: 'none' | 'distant', hour: number, fov: number, hide?: number, settle?: number, cam?: { pos: number[], look: number[] }, setup?: () => Promise<{ pos: number[], look: number[] } | void> }} Shot */

/** @type {Shot[]} */
export const SHOTS = [
  {
    name: 'hero',
    where: 'Across the park at dusk: the Giant Wheel, the Sky Flip, Thunder Loop, the Sky Falcon and the Rocket Ride climbing on its smoke',
    people: 'distant',
    hour: 17.7,
    fov: 48,
    cam: { pos: [-160, 22, 20], look: [-40, 45, -140] },
    async setup() {
      await __director.go('rocket');
      __director.ride('rocket', { fade: false });
      // up to its second stop (about 90 m), then held there while the Thunder Loop's train comes round
      const r = __game.rocket;
      __stills.until(() => __stills.at(r.rocket)[1] > 85, 1800);
      if (__stills.at(r.rocket)[1] <= 85) throw new Error('the rocket never reached its second stop');
      __stills.freeze(r);
      __stills.run(__game.stack, (s) => s.trainPosition.y > 15 && s.trainPosition.x < -100);
      __stills.freeze(__game.stack);
    },
  },
  {
    name: 'coaster',
    where: 'Thunder Loop: the train in its vertical loop, the Giant Wheel and the Sky Flip behind',
    people: 'distant',
    hour: 17.7,
    fov: 40,
    cam: { pos: [-150, 8, 18], look: [-104, 13, -32] },
    async setup() {
      await __director.go('coaster');
      __stills.run(__game.stack, (s) => s.trainPosition.y > 15 && s.trainPosition.x < -100);
      __stills.freeze(__game.stack);
    },
  },
  {
    name: 'falcon',
    where: 'Sky Falcon: the train cresting a hill on its tall white supports, the cliff and the sea beyond',
    people: 'none',
    hour: 17.6,
    fov: 55,
    cam: { pos: [120, 185, -150], look: [178, 158, -228] },
    async setup() {
      await __director.go('falcon');
      __stills.run(__game.falcon, (f) => f.trainPosition.y > 160 && Math.abs(f.trainPosition.x - 176) < 4);
      __stills.freeze(__game.falcon);
    },
  },
  {
    name: 'rocket',
    where: 'The Rocket Ride lifting off from its pad on a column of smoke, the Giant Wheel and the Sky Falcon behind',
    people: 'none',
    hour: 17.65,
    fov: 42,
    cam: { pos: [-8, 4, -110], look: [30, 18, -150] },
    async setup() {
      await __director.go('rocket');
      __director.ride('rocket', { fade: false });
      __film.advance(5.2);
      __stills.freeze(__game.rocket);
    },
  },
  {
    name: 'ferris',
    where: 'The Giant Wheel over the midway tents, Thunder Loop and the Sky Falcon beside it',
    people: 'distant',
    hour: 17.65,
    fov: 50,
    cam: { pos: [-60, 12, 70], look: [0, 118, -262] },
    async setup() {
      await __director.go('ferris');
    },
  },
  {
    name: 'flip',
    where: 'The Sky Flip swinging over the top, the Giant Wheel and Thunder Loop round it',
    people: 'none',
    hour: 17.65,
    fov: 52,
    cam: { pos: [-165, 8, -15], look: [-78, 58, -110] },
    async setup() {
      await __director.go('flip');
      // its own demo cycle (rest, pump, loop…), on to the arm swinging up past the horizontal
      __stills.run(__game.flip, (f) => f.phase === 'loop' && Math.cos(f.theta) < -0.5 && Math.sin(f.theta) * f.omega > 0);
      __stills.freeze(__game.flip);
    },
  },
  {
    name: 'ship',
    where: 'Nebula 360 swinging in front of the Sky Falcon, its riders far off',
    people: 'distant',
    hour: 17.65,
    fov: 45,
    settle: 20,
    cam: { pos: [40, 4, -106], look: [72, 11, -125] },
    async setup() {
      await __director.go('ship');
    },
  },
  {
    name: 'speedway',
    where: 'Turbo Speedway: karts racing through a bend, the park behind',
    people: 'distant',
    hour: 17.65,
    fov: 45,
    async setup() {
      __director.place(-120, 120, 0);
      __director.follow({ target: 'speedway.karts.0.root.position', offset: [7, 6, 16], relative: true, smooth: 0, look: [0, 1, 0] });
      __film.advance(0.5);
      return null;
    },
  },
  {
    name: 'trail',
    where: 'Rally Trail: the buggy kicking up dust by the splash, the park behind',
    people: 'none',
    hour: 17.65,
    fov: 48,
    async setup() {
      __director.place(30, 170, 0);
      // the demo buggy laps the trail: on to the bend by the splash
      const car = __game.trail.car;
      __stills.until(() => Math.hypot(car.x - 76.5, car.z - 228.3) < 3, 5400);
      if (Math.hypot(car.x - 76.5, car.z - 228.3) >= 3) throw new Error('the buggy never came round');
      __stills.freeze(__game.trail);
      return { pos: [car.x - 6, 7, car.z + 18], look: [car.x, 1, car.z - 6] };
    },
  },
  {
    name: 'crates',
    where: 'Crate Smash on the midway, the Giant Wheel and the Sky Falcon behind',
    people: 'distant',
    hour: 17.65,
    fov: 48,
    cam: { pos: [59, 3, 25], look: [68, 3.5, 3] },
    async setup() {
      await __director.go('crates');
    },
  },
  {
    name: 'striker',
    where: 'The High Striker on the midway, the Giant Wheel and the Sky Falcon behind',
    people: 'none',
    hour: 17.65,
    fov: 48,
    cam: { pos: [83, 2.5, 23], look: [90, 5.5, 9] },
    async setup() {
      await __director.go('striker');
    },
  },
  {
    name: 'ducks',
    where: 'The Duck Shoot stall with its lights on',
    people: 'none',
    hour: 17.65,
    fov: 50,
    cam: { pos: [71, 3, 19], look: [79, 2, 32] },
    async setup() {
      await __director.go('ducks');
    },
  },
  {
    name: 'drone',
    where: 'A drone flight over the park: the Rocket Ride, Nebula 360, the Sky Falcon and the airport far off',
    people: 'none',
    hour: 17.65,
    fov: 50,
    settle: 1,
    async setup() {
      await __director.go('drone');
      __director.ride('drone', { fade: false });
      __director.hold('Space', 6);
      __film.advance(6.2);
      __director.hold('KeyW', 1.5);
      __film.advance(1.6);
      __stills.freeze(__game.drone);
      const p = __game.drone.pos;
      return { pos: [p.x - 5, p.y + 0.8, p.z - 4], look: [p.x + 6, p.y - 3, p.z + 10] };
    },
  },
  {
    name: 'workshop',
    where: "The Coaster Workshop's Builder's Yard: a visitor's coaster with a lift hill and a loop on its plot",
    people: 'none',
    hour: 17.65,
    fov: 45,
    cam: { pos: [42, 20, 6], look: [-2, 5, -52] },
    async setup() {
      // the workshop is for members: a stand-in account for this page only (no server is asked)
      const { session } = await import('/src/account/session.ts');
      session._user = { id: 'film', email: 'film@example.invalid', username: 'Visitor', createdAt: '2026-01-01T00:00:00Z', role: 'player' };
      __stills.restore.push(() => (session._user = null));
      await __director.go('workshop');
      __director.fades(false);
      __game.enterWorkshop();
      __director.fades(true);
      // a small circuit that passes every check: lift hill, drop, loop, and home along the front
      const w = __game.workshop;
      w.design.pieces.length = 0;
      w.selected = null;
      const add = (t, edit) => {
        w.addPiece(t);
        if (edit) Object.assign(w.design.pieces[w.selected], edit);
      };
      add('curve', { angle: -90, radius: 10, bank: 20 });
      add('straight', { len: 4, kind: 'lift' });
      add('slope', { angle: 30, radius: 10, kind: 'lift' });
      add('straight', { len: 22, kind: 'lift' });
      add('slope', { angle: -30, radius: 10 });
      add('curve', { angle: -90, radius: 10, bank: 30 });
      add('slope', { angle: -45, radius: 10 });
      add('straight', { len: 8 });
      add('slope', { angle: 45, radius: 10 });
      add('loop', { size: 14, side: 1 });
      add('curve', { angle: -90, radius: 8, bank: 40 });
      add('straight', { len: 33 });
      add('curve', { angle: -90, radius: 8, bank: 40 });
      w.change(() => {});
      w.select(null);
      __film.advance(0.5);
      if (w.issues.length) throw new Error(`the workshop's circuit has issues: ${JSON.stringify(w.issues)}`);
    },
  },
  {
    name: 'museum',
    where: 'The Career Museum at the end of its path, the Sky Falcon behind',
    people: 'none',
    hour: 17.65,
    fov: 50,
    cam: { pos: [58, 4, -38], look: [95, 5, -50] },
    async setup() {
      await __director.go('museum');
    },
  },
  {
    name: 'skylink',
    where: 'A SkyLink train on its viaduct over the Rally Trail, heading for the park',
    people: 'none',
    hour: 17.65,
    fov: 45,
    settle: 1,
    async setup() {
      await __director.go('skylink');
      __director.place(22, 200, 0);
      const lanes = __game.skylink.lanes;
      __stills.until(() => lanes.some((l) => l.mode === 'run' && l.dir < 0 && l.z > 240 && l.z < 260), 3600);
      const car = lanes.find((l) => l.mode === 'run' && l.dir < 0 && l.z > 240 && l.z < 260);
      if (!car) throw new Error('no SkyLink car came along');
      __stills.freeze(__game.skylink);
      return { pos: [-32, 9, car.z + 45], look: [22, 12, car.z - 10] };
    },
  },
  {
    name: 'airport',
    where: 'Funfair International: the terminal, its gates with A320s, the tower and the Sky Falcon far off',
    people: 'none',
    hour: 17.65,
    fov: 45,
    cam: { pos: [-260, 35, 650], look: [-40, 8, 560] },
    async setup() {
      await __director.go('airport');
    },
  },
  {
    name: 'a320',
    where: 'A Funfair Air A320 lined up on the runway at dusk, engines running',
    people: 'none',
    hour: 17.65,
    fov: 34,
    settle: 2,
    async setup() {
      await __director.go('flight');
      __game.flight.booking = { from: 'home', timeOfDay: 'dusk' };
      __director.ride('flight', { fade: false });
      __film.advance(2);
      // the first officer's "skip to the runway" (N): lined up, engines running
      __director.tap('KeyN');
      __film.advance(3);
      const f = __game.flight.focus;
      const yaw = __game.flight.yaw;
      const fwd = [-Math.sin(yaw), -Math.cos(yaw)];
      // abeam it on the runway's south side: the whole livery in profile
      const s = [-fwd[1], fwd[0]];
      if (s[1] < 0) [s[0], s[1]] = [-s[0], -s[1]];
      return { pos: [f.x + fwd[0] * 22 + s[0] * 48, 4, f.z + fwd[1] * 22 + s[1] * 48], look: [f.x - fwd[0] * 4, 9, f.z - fwd[1] * 4] };
    },
  },
  {
    name: 'palmcay',
    where: "Palm Cay's lagoon: the jet-ski dock, the beach and its umbrellas",
    people: 'none',
    hour: 17.2,
    fov: 48,
    cam: { pos: [240, 22, 41720], look: [20, 2, 41470] },
    async setup() {
      await __director.go('palmcay');
    },
  },
  {
    name: 'jetski',
    where: 'The Palm Cay Jet-Ski Race: riders jumping a ramp in the lagoon, the race arch behind',
    people: 'distant',
    hour: 17.3,
    fov: 35,
    hide: 30,
    settle: 1,
    async setup() {
      await __director.go('jetski');
      __director.ride('jetski', { fade: false });
      __film.advance(11.4);
      // the pack (everyone but the visitor's own ski): the camera ahead of it and to its side
      const pack = () => {
        const ps = __game.jetski.rigs.slice(1).map((r) => r.root.position);
        return [ps.reduce((a, p) => a + p.x, 0) / ps.length, ps.reduce((a, p) => a + p.z, 0) / ps.length];
      };
      const a = pack();
      __film.advance(0.2);
      const c = pack();
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const f = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
      return { pos: [c[0] + f[0] * 40 - f[1] * 25, 4, c[1] + f[1] * 40 + f[0] * 25], look: [c[0], 1, c[1]] };
    },
  },
  {
    name: 'slides',
    where: "Palm Cay's Splash Tower: three slides into the pool",
    people: 'none',
    hour: 17.2,
    fov: 55,
    cam: { pos: [-262, 7, 41230], look: [-222, 13, 41160] },
    async setup() {
      await __director.go('slides');
    },
  },
  {
    name: 'cannons',
    where: "Pirate Cannons: the fort's guns facing the pirate ships in Palm Cay's lagoon",
    people: 'none',
    hour: 17.3,
    fov: 45,
    cam: { pos: [-386, 8.2, 41428], look: [-400, 3, 41720] },
    async setup() {
      await __director.go('cannons');
    },
  },
  {
    name: 'volley',
    where: 'Beach Volley on Palm Cay: players on the court, the Coconut Shy beside it',
    people: 'distant',
    hour: 17.3,
    fov: 40,
    hide: 0,
    cam: { pos: [182, 6, 41438], look: [204, 3, 41400] },
    async setup() {
      await __director.go('volley');
    },
  },
  {
    name: 'night',
    where: 'The park at night: the midway tents and the carousel lit, the Sky Flip and the Giant Wheel in lights',
    people: 'distant',
    hour: 20.2,
    fov: 50,
    settle: 12,
    cam: { pos: [60, 28, 40], look: [-20, 20, -140] },
    async setup() {
      await __director.go('entrance');
    },
  },
];

/** Helpers the shots' setups use, defined in the page once. */
export function installStills() {
  const step = 1 / 30;
  window.__stills = {
    /** What puts back what freeze() and the setups changed. */
    restore: [],
    /** Stops something moving (its update does nothing) until release(). */
    freeze(o) {
      const update = o.update;
      o.update = () => {};
      this.restore.push(() => (o.update = update));
    },
    release() {
      for (const fn of this.restore.splice(0).reverse()) fn();
    },
    /** Draws frames of film until `cond()` holds (at most `max`); returns how many. */
    until(cond, max = 3600) {
      let n = 0;
      while (n < max && !cond()) {
        __film.step(1000 / 30);
        n++;
      }
      return n;
    },
    /** Runs one thing on alone, without drawing (fast), until `cond(it)` holds: a train round its track. */
    run(it, cond, max = 20_000) {
      let t = __game.time.t;
      let n = 0;
      for (; n < max && !cond(it); n++) {
        t += step;
        it.update(step, t);
      }
      if (n >= max) throw new Error('never got there');
      return n;
    },
    /** Where an object is in the world, [x, y, z]. */
    at(o) {
      const v = __game.camera.position.clone();
      o.getWorldPosition(v);
      return [v.x, v.y, v.z];
    },
  };
}

/** Back on foot with the camera handed back and everything that was frozen moving again. */
async function reset(page) {
  await page.evaluate(() => {
    window.__stills.release();
    const g = __game;
    __director.still();
    __director.camera(null);
    __director.fades(false);
    if (g.mode === 'workshop') g.leaveWorkshop(true);
    else if (g.mode !== 'drive') __director.leave({ fade: false });
    __director.fades(true);
    __film.advance(0.5);
  });
}

/** Sets one shot up in the page, ready to capture. */
export async function stage(page, shot) {
  await reset(page);
  await page.evaluate(
    ({ hour, hide }) => {
      __director.hour(hour);
      __director.hidePeople(hide);
      __director.clean(true);
    },
    { hour: shot.hour, hide: shot.hide ?? 60 },
  );
  const cam = (shot.setup ? await page.evaluate(`(${shot.setup.toString().replace(/^async setup\(\)/, 'async function ()')})()`) : null) ?? shot.cam;
  return page.evaluate(
    ({ cam, fov, hour, settle }) => {
      if (cam) __director.camera(cam.pos, cam.look);
      __director.fov(fov);
      __director.hour(hour);
      __director.visitor(false);
      for (let i = 0; i < settle; i++) __film.step(1000 / 30);
      return __director.status();
    },
    { cam, fov: shot.fov, hour: shot.hour, settle: shot.settle ?? 8 },
  );
}

/** Captures `shots` into `masters` as <name>.png. */
async function capture(shots, masters) {
  const page = await openGame({ width: 1920, height: 1080, dpr: 2, quality: 'high', hour: 17.65, log: () => {} });
  try {
    console.log(`the game is up (${Math.round(page.loadMs / 1000)} s, ${JSON.stringify(page.settings)})`);
    await page.evaluate(`(${installStills})()`);
    await page.evaluate('__film.freeze()');
    for (const shot of shots) {
      const t0 = Date.now();
      const status = await stage(page, shot);
      const png = await page.screenshot({ format: 'png' });
      writeFileSync(join(masters, `${shot.name}.png`), png);
      console.log(`${shot.name}: ${Math.round(png.length / 1024)} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s, camera ${status.camera}`);
    }
    await reset(page);
  } finally {
    await page.close();
  }
}

/** Encodes the masters into the web sizes, and writes the manifest. */
async function encode(shots, masters) {
  mkdirSync(OUT, { recursive: true });
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  for (const shot of shots) {
    const src = join(masters, `${shot.name}.png`);
    if (!existsSync(src)) throw new Error(`no master for ${shot.name} (${src})`);
    const meta = await sharp(src).metadata();
    const sizes = [];
    for (const w of WIDTHS) {
      const base = sharp(src).resize({ width: w, kernel: 'lanczos3' });
      let q = AVIF_QUALITY;
      let avif = await base.clone().avif({ quality: q, effort: 6, chromaSubsampling: '4:2:0' }).toBuffer();
      while (w === 1920 && avif.length > AVIF_MAX_BYTES && q > AVIF_FLOOR) {
        q -= 5;
        avif = await base.clone().avif({ quality: q, effort: 6, chromaSubsampling: '4:2:0' }).toBuffer();
      }
      const webp = await base.clone().webp({ quality: WEBP_QUALITY, effort: 6 }).toBuffer();
      writeFileSync(join(OUT, `${shot.name}-${w}.avif`), avif);
      writeFileSync(join(OUT, `${shot.name}-${w}.webp`), webp);
      sizes.push(`${w}: avif ${Math.round(avif.length / 1024)} KB (q${q}), webp ${Math.round(webp.length / 1024)} KB`);
    }
    manifest[shot.name] = { width: meta.width, height: meta.height, widths: WIDTHS, people: shot.people, where: shot.where };
    console.log(`${shot.name}: ${sizes.join(' · ')}`);
  }
  // in SHOTS order, whatever order they were made in
  const ordered = Object.fromEntries(SHOTS.filter((s) => manifest[s.name]).map((s) => [s.name, manifest[s.name]]));
  writeFileSync(MANIFEST, `${JSON.stringify(ordered, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : (args[i + 1] ?? '');
  };
  const only = flag('--only')?.split(',').filter(Boolean);
  const unknown = only?.filter((n) => !SHOTS.some((s) => s.name === n)) ?? [];
  if (unknown.length) throw new Error(`no shot called ${unknown.join(', ')}`);
  const shots = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  const masters = resolve(flag('--masters') ?? process.env.FILM_STILLS ?? join(tmpdir(), 'film-stills'));
  mkdirSync(masters, { recursive: true });
  if (!args.includes('--encode-only')) await capture(shots, masters);
  else if (!readdirSync(masters).some((f) => f.endsWith('.png'))) throw new Error(`no masters in ${masters}`);
  await encode(shots, masters);
  console.log(`masters in ${masters}; web files in ${OUT}; manifest ${MANIFEST}`);
}

// (run as a script, not when another script imports SHOTS or stage)
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();
