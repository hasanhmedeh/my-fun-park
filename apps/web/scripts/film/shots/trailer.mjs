// The trailer: about 78 s cut to "Flags" (168 BPM). No interface and no words in the picture
// (the park's own signs aside): it opens on the logo over the park, builds to the rocket's
// lift-off, cuts on every bar from the drop (the coasters, the thrill rides, the races and games,
// the workshop, the SkyLink, a take-off at dusk and Palm Cay), pulls back over the park for the
// music's outro and ends on the card: the logo, "free in your browser" as icons, the address.
//
// Everything is real gameplay filmed in the park. The park is at its own hour (16:00, as every
// visitor sees it); only the flight is at dusk, a time its booking card offers. The subtitles
// (content/videos.<lang>.json "trailer") describe the music and name what's on screen.
//
// The shots are exported one by one (SHOTS) for the vertical teaser (teaser.mjs).

import { endCard, helpers, PARK_HOUR } from './common.mjs';

/** One beat of the music (s). */
export const BEAT = 60 / 168;
/** Where the film starts in the track: bar 8 (beat 32), so the drop (bar 24) lands 64 beats in. */
export const MUSIC_FROM = 0.025 + 32 * BEAT;

/** The trailer's crossfades in the opening: two beats. */
const XF = { xfade: 2 * BEAT };

/** Every shot, by id (the order of the cut is the list's, below). */
export const SHOTS = {
  aerial: {
    id: 'aerial',
    beats: 24,
    chapter: 'park',
    in: { fade: 1.2 },
    // over the south of the park, gliding in towards the gates, the wheel and the coasters ahead
    async setup() {
      await __director.go('entrance');
      __director.shadows([0, 0, -40], 260);
    },
    camera: {
      path: [
        { t: 0, pos: [-40, 105, 230], look: [0, 40, -70] },
        { t: 24 * (60 / 168), pos: [0, 62, 125], look: [0, 70, -200] },
      ],
      ease: true,
    },
    overlay: { title: { seconds: 6.2, delay: 0.6 } },
    cues: [{ id: 'music', at: 0.6, end: 4.6 }],
    vertical: {
      fov: 70,
      camera: {
        path: [
          { t: 0, pos: [-20, 120, 210], look: [0, 50, -90] },
          { t: 16 * (60 / 168), pos: [0, 70, 120], look: [0, 80, -200] },
        ],
        ease: true,
      },
      overlay: { title: { seconds: 4.4, delay: 0.4 } },
    },
  },
  wheel: {
    id: 'wheel',
    beats: 16,
    in: XF,
    // the Giant Wheel over the midway's tents, from the plaza
    async setup() {
      await __director.go('entrance');
    },
    fov: 50,
    camera: {
      path: [
        { t: 0, pos: [-72, 10, 76], look: [0, 118, -262] },
        { t: 16 * (60 / 168), pos: [-46, 15, 62], look: [0, 118, -262] },
      ],
    },
    cues: [{ id: 'park', at: 0.8, end: 5.2 }],
  },
  midway: {
    id: 'midway',
    beats: 14,
    in: XF,
    // down the midway's games, the wheel and the Sky Falcon behind
    async setup() {
      await __director.go('crates');
    },
    fov: 48,
    hide: 25,
    camera: {
      path: [
        { t: 0, pos: [50, 3.4, 32], look: [76, 4.5, 6] },
        { t: 14 * (60 / 168), pos: [61, 3.6, 31], look: [88, 5.5, 8] },
      ],
    },
    cues: [{ id: 'free', at: 0.8, end: 4.4 }],
  },
  climb: {
    id: 'climb',
    beats: 16,
    in: XF,
    // the Rocket Ride's countdown on the pad, lifting off on its smoke just before the drop
    async setup() {
      await __director.go('rocket');
      __director.ride('rocket', { fade: false });
      __film.advance(0.6);
    },
    fov: 42,
    camera: { fixed: { pos: [-8, 4, -110], look: [30, 18, -150] } },
    vertical: { fov: 66, camera: { fixed: { pos: [-14, 3, -100], look: [30, 30, -150] } } },
  },
  loop: {
    id: 'loop',
    beats: 16,
    chapter: 'rides',
    // Thunder Loop's train out of its launch and round the vertical loop
    async setup() {
      await __director.go('coaster');
      __stills.run(__game.stack, (s) => s.speed > 1 && s.trainPosition.x < -72 && s.trainPosition.x > -76, 3600);
    },
    camera: { follow: { target: 'stack.trainPosition', offset: [8, 7, 26], look: [0, 2, 0], smooth: 2.5 } },
    cues: [{ id: 'drive', at: 0.5, end: 4.6 }],
    vertical: { fov: 72, camera: { follow: { target: 'stack.trainPosition', offset: [10, 10, 32], look: [0, 4, 0], smooth: 2.5 } } },
  },
  falcon: {
    id: 'falcon',
    beats: 8,
    // the Sky Falcon's train over the crest of its 163 m hill and into the drop, from above the
    // crest (two bars: later the lens looks straight down and the train is lost in the track)
    async setup() {
      await __director.go('falcon');
      // (the track climbs the mesa too: the crest by the park is the one at z ≈ -243)
      __stills.run(__game.falcon, (f) => f.trainPosition.y > 158 && Math.abs(f.trainPosition.x - 176) < 4 && Math.abs(f.trainPosition.z + 243) < 8);
    },
    fov: 55,
    camera: { follow: { target: 'falcon.trainPosition', at: [120, 185, -150], look: [0, 0, 0], smooth: 0, lookSmooth: 4 } },
    cues: [{ id: 'falcon', at: 0.2, end: 2.8 }],
    vertical: { fov: 80 },
  },
  flip: {
    id: 'flip',
    beats: 12,
    // the Sky Flip's arm swinging up and over the top
    async setup() {
      await __director.go('flip');
      __stills.run(__game.flip, (f) => f.phase === 'loop' && Math.cos(f.theta) < -0.2 && Math.sin(f.theta) * f.omega > 0);
    },
    fov: 52,
    camera: {
      path: [
        { t: 0, pos: [-165, 8, -15], look: [-78, 58, -110] },
        { t: 12 * (60 / 168), pos: [-150, 9.5, -29], look: [-78, 61, -110] },
      ],
    },
    cues: [{ id: 'thrills', at: 0.2, end: 5.5 }],
    vertical: { fov: 78 },
  },
  ship: {
    id: 'ship',
    beats: 12,
    // Nebula 360 looping right round, the Sky Falcon behind
    async setup() {
      await __director.go('ship');
      __stills.run(__game.ship, (s) => s.phase === 'loop' && s.phaseT > 2);
    },
    fov: 45,
    hide: 25,
    camera: { fixed: { pos: [40, 4, -106], look: [72, 11, -125] } },
  },
  speedway: {
    id: 'speedway',
    beats: 12,
    chapter: 'games',
    // the karts racing through a bend, alongside the leader
    async setup() {
      __director.place(-120, 120, 0);
      // past the start gantry (52 m round) with the lens too (16 m behind), so it doesn't pass under it
      const k = __game.speedway.karts[0];
      __stills.until(() => k.s > 72 && k.s < 84, 2400);
    },
    fov: 45,
    camera: { follow: { target: 'speedway.karts.0.root.position', offset: [7, 6, 16], relative: true, smooth: 0, look: [0, 1, 0] } },
    cues: [{ id: 'race', at: 0.3, end: 4.0 }],
    vertical: { fov: 70, camera: { follow: { target: 'speedway.karts.0.root.position', offset: [5, 7, 14], relative: true, smooth: 0, look: [0, 1, 0] } } },
  },
  trail: {
    id: 'trail',
    beats: 8,
    // the Rally Trail's buggy through the splash, behind it
    async setup() {
      __director.place(30, 170, 0);
      const car = __game.trail.car;
      __stills.until(() => Math.hypot(car.x - 76.5, car.z - 228.3) < 3, 5400);
    },
    fov: 50,
    camera: { follow: { target: 'trail.car.root.position', offset: [5, 4, 13], relative: true, look: [0, 1, 0], smooth: 3 } },
    cues: [{ id: 'trail', at: 0.2, end: 2.8 }],
  },
  ducks: {
    id: 'ducks',
    beats: 8,
    // the Duck Shoot down the cork gun's sights
    async setup() {
      await __director.go('ducks');
      __director.ride('ducks', { fade: false });
      __film.advance(1.5);
    },
    actions: [
      { t: 0.2, hold: 'KeyD', for: 0.6 },
      { t: 0.9, tap: 'Space' },
      { t: 1.4, hold: 'KeyA', for: 0.5 },
      { t: 2.0, tap: 'Space' },
    ],
    cues: [{ id: 'games', at: 0.2, end: 2.8 }],
  },
  drone: {
    id: 'drone',
    beats: 8,
    // a drone flight over the park, on its own chase camera
    async setup() {
      await __director.go('drone');
      __director.ride('drone', { fade: false });
      __director.hold('Space', 6);
      __film.advance(6.2);
    },
    actions: [{ t: 0, hold: 'KeyW', for: 3 }],
    cues: [{ id: 'drone', at: 0.2, end: 2.8 }],
  },
  workshop: {
    id: 'workshop',
    beats: 8,
    chapter: 'build-and-fly',
    // a coaster going up piece by piece in the Builder's Yard
    async setup() {
      await __shots.member();
      await __director.go('workshop');
      __shots.workshop();
      __shots.build(3);
    },
    fov: 45,
    camera: {
      path: [
        { t: 0, pos: [46, 22, 10], look: [-2, 5, -52] },
        { t: 8 * (60 / 168), pos: [38, 18, 2], look: [-2, 5, -52] },
      ],
    },
    actions: [5, 7, 9, 11, 13].map((n, i) => ({ t: 0.25 + i * 0.5, page: (k) => __shots.build(k), args: [n] })),
    cues: [{ id: 'build', at: 0.2, end: 2.8 }],
  },
  skylink: {
    id: 'skylink',
    beats: 8,
    // a SkyLink train on its viaduct over the Rally Trail
    async setup() {
      await __director.go('skylink');
      __director.place(22, 200, 0);
      const lanes = __game.skylink.lanes;
      __stills.until(() => lanes.some((l) => l.mode === 'run' && l.dir < 0 && l.z > 292 && l.z < 304), 3600);
    },
    fov: 45,
    camera: { fixed: { pos: [-32, 9, 292], look: [22, 12, 240] } },
    cues: [{ id: 'skylink', at: 0.2, end: 2.8 }],
  },
  takeoff: {
    id: 'takeoff',
    beats: 12,
    // Flight FA101 at dusk: the A320neo's take-off roll, rotation and lift-off, flown by the game's
    // own scripted crew (world/flight/crew.ts: TOGA, the centreline, rotate at VR), from the runway's side
    hour: null,
    hide: 0,
    async setup() {
      const { Crew } = await import('/src/world/flight/crew.ts');
      const { A320 } = await import('/src/aviation/a320.ts');
      await __director.go('flight');
      const fl = __game.flight;
      fl.booking = { from: 'home', timeOfDay: 'dusk' };
      __director.ride('flight', { fade: false });
      __film.advance(2);
      // the first officer's skip to the runway (N), once the runway is free to line up on
      __stills.until(() => !fl.sim.traffic?.runwayBusy(fl.sim.from).busy, 1800);
      __director.tap('KeyN');
      __film.advance(2);
      // lined up: on until the tower clears it for takeoff
      __stills.run(fl, () => fl.sim.atc.clearance.takeoff, 2400);
      fl.pilotOverride = new Crew(fl.sim, {}).frame;
      fl.sim.pilot.throttle = A320.detents.toga;
      // on to just before rotation (VR is 142 kt): it rotates a second in and lifts off about 3 s in
      __stills.until(() => fl.sim.state.ias > 138, 1500);
      // running alongside on the runway's south side, low in the grass, the park behind the jet
      // (flight.focus stays on the ground, so the jet climbs out of the frame's middle)
      const fwd = [-Math.sin(fl.yaw), -Math.cos(fl.yaw)];
      const right = fwd[0] >= 0 ? 1 : -1;
      // (upright, for the teaser: farther out and looking at the jet itself, so all of it fits the
      // narrow frame, and higher, so it starts low and climbs up through the tall one)
      const tall = innerHeight > innerWidth;
      const ahead = tall ? 2 : 14;
      return { camera: { follow: { target: 'flight.focus', offset: [(tall ? 72 : 55) * right, 1.5, 0], relative: true, look: [fwd[0] * ahead, tall ? 20 : 9, fwd[1] * ahead], smooth: 0 } } };
    },
    fov: 40,
    cues: [{ id: 'fly', at: 0.3, end: 4.1 }],
    vertical: { fov: 64 },
  },
  jetski: {
    id: 'jetski',
    beats: 8,
    // the Palm Cay Jet-Ski Race's pack over the lagoon, the camera running ahead of the leader
    async setup() {
      await __director.go('jetski');
      __director.ride('jetski', { fade: false });
      __film.advance(11.4);
      const pack = () => {
        const ps = __game.jetski.rigs.slice(1).map((r) => r.root.position);
        return [ps.reduce((a, p) => a + p.x, 0) / ps.length, ps.reduce((a, p) => a + p.z, 0) / ps.length];
      };
      const a = pack();
      __film.advance(0.2);
      const c = pack();
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const f = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
      // the one out in front (rig 0 is the visitor's, still on the start line)
      let lead = 1;
      let most = -Infinity;
      __game.jetski.rigs.forEach((r, i) => {
        const d = (r.root.position.x - c[0]) * f[0] + (r.root.position.z - c[1]) * f[1];
        if (i > 0 && d > most) [lead, most] = [i, d];
      });
      // 16 m ahead of it and 12 to the side, looking back past it at the rest of the pack
      const offset = [f[0] * 16 - f[1] * 12, 3.5, f[1] * 16 + f[0] * 12];
      return { camera: { follow: { target: `jetski.rigs.${lead}.root.position`, offset, look: [-f[0] * 6, 0.5, -f[1] * 6], smooth: 1.5 } } };
    },
    fov: 40,
    // (nobody hidden: the racers are people, and hiding them near the lens leaves their jet-skis
    // riderless; the visitor is left out anyway)
    hide: 0,
    cues: [{ id: 'island', at: 0.3, end: 5.4 }],
  },
  cannons: {
    id: 'cannons',
    beats: 8,
    // Pirate Cannons: the fort's guns firing at the pirate ships
    async setup() {
      await __director.go('cannons');
      __director.ride('cannons', { fade: false });
      __film.advance(1.5);
    },
    actions: [
      { t: 0.3, tap: 'Space' },
      { t: 1.5, hold: 'KeyD', for: 0.4 },
      { t: 2.0, tap: 'Space' },
    ],
  },
  finale: {
    id: 'finale',
    beats: 12,
    // back over the whole park for the music's outro
    async setup() {
      await __director.go('entrance');
      __director.shadows([0, 0, -60], 300);
    },
    camera: {
      path: [
        { t: 0, pos: [30, 26, 60], look: [-10, 40, -150] },
        { t: 12 * (60 / 168), pos: [70, 85, 185], look: [0, 40, -140] },
      ],
      ease: true,
    },
  },
};

export default {
  id: 'trailer',
  kind: 'trailer',
  fps: 30,
  music: { track: 'flags', from: MUSIC_FROM, fadeIn: 0.4, fadeOut: 3 },
  session: { enter: true },
  defaults: { ui: 'clean', hour: PARK_HOUR, visitor: false, hide: 20 },
  helpers,
  poster: { shot: 'loop', at: 2.6 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Free in your browser', words: 'Ride. Race. Fly.' },
  // the hero's silent loop: the wheel, the coaster's loop, the falcon (lib/media.mjs loop())
  loop: [
    { shot: 'wheel', from: 0.6, seconds: 3.2 },
    { shot: 'loop', from: 1.4, seconds: 3.4 },
    { shot: 'falcon', from: 0.1, seconds: 2.7 },
  ],
  shots: [
    SHOTS.aerial,
    SHOTS.wheel,
    SHOTS.midway,
    SHOTS.climb,
    // the drop: hard cuts on the bar from here
    SHOTS.loop,
    SHOTS.falcon,
    SHOTS.flip,
    SHOTS.ship,
    SHOTS.speedway,
    SHOTS.trail,
    SHOTS.ducks,
    SHOTS.drone,
    SHOTS.workshop,
    SHOTS.skylink,
    SHOTS.takeoff,
    SHOTS.jetski,
    SHOTS.cannons,
    // the music's outro
    SHOTS.finale,
    { ...endCard({ seconds: 16 * BEAT, xfade: 2 * BEAT }), cues: [{ id: 'end', at: 1.6, end: 5.4 }] },
  ],
};
