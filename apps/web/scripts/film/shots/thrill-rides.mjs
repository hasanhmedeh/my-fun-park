// Thrill rides: the keys that make each ride yours. A member drives Thunder Loop, boards the Sky
// Falcon and switches cameras over its hill, fast-forwards the Giant Wheel, swings on the Sky
// Flip and Nebula 360, and fires the Rocket Ride's stages.
//
// Where a ride is boarded on film it's with E in its ring, as a visitor does (the pretend server's
// tickets, lib/intercept.mjs). The long middles (the Falcon's climb, a swing ride's first swings)
// are cut: those shots start the ride straight away (director.ride, no ticket asked) and run it on
// to its best moment first. Every word is a subtitle (content/videos.<lang>.json "thrill-rides").

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A member with the free pack (a pretend server: lib/intercept.mjs). */
const MEMBER = { enter: true, api: { username: 'Visitor', balance: 20 } };

export default {
  id: 'thrill-rides',
  kind: 'tutorial',
  fps: 30,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: MEMBER,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'falcon-hill', at: 1.5 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'Thrill rides' },
  shots: [
    sting('thrill-rides'),
    {
      id: 'coaster',
      duration: 16,
      // Thunder Loop: E in its ring, then power, turbo and the camera
      async setup() {
        await __director.go('coaster');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['KeyW', 'KeyS', 'ShiftLeft', '|', 'KeyC'] },
        { t: 3.4, hold: 'KeyW', for: 9 },
        { t: 7.2, hold: 'ShiftLeft', for: 2.2 },
        { t: 12.8, tap: 'KeyC' },
      ],
      cues: [
        { id: 'coaster', at: 0.3, end: 3.2 },
        { id: 'power', at: 3.4, end: 7.0 },
        { id: 'turbo', at: 7.2, end: 12.4 },
        { id: 'camera', at: 12.6, end: 15.75 },
      ],
    },
    {
      id: 'falcon',
      duration: 8,
      chapter: 'falcon',
      // the Sky Falcon's ring: 5 tickets, and on board
      async setup() {
        await __director.go('falcon');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      actions: [{ t: 1.6, tap: 'KeyE' }],
      cues: [
        { id: 'falcon', at: 0.3, end: 3.8 },
        { id: 'climb', at: 4.0, end: 7.75 },
      ],
    },
    {
      id: 'falcon-hill',
      duration: 10,
      // later in the ride: over the 163 m hill by the park (the train run on to its crest first)
      async setup() {
        await __director.go('falcon');
        __director.ride('falcon', { fade: false });
        __film.advance(1);
        __stills.run(__game.falcon, (f) => f.trainPosition.y > 158 && Math.abs(f.trainPosition.x - 176) < 4 && Math.abs(f.trainPosition.z + 243) < 8);
        // just over the top, so the driver's view tips into the drop rather than at the sky
        __film.advance(0.5);
      },
      settle: 4,
      hints: ['KeyE', 'KeyC'],
      // driver, then chase (the third camera, trackside, sits too far off for this stretch)
      actions: [{ t: 3.4, tap: 'KeyC' }],
      cues: [
        { id: 'views', at: 0.3, end: 5.0 },
        { id: 'speed', at: 5.2, end: 9.75 },
      ],
    },
    {
      id: 'wheel',
      duration: 13,
      chapter: 'wheel',
      // the Giant Wheel: E in its ring, then W to fast-forward the turn and A / D to look round
      async setup() {
        await __director.go('ferris');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.6, hints: ['KeyW', '|', 'KeyA', 'KeyD'] },
        { t: 4.0, hold: 'KeyW', for: 4.5 },
        { t: 9.2, hold: 'KeyA', for: 1.6 },
      ],
      cues: [
        { id: 'wheel', at: 0.3, end: 3.6 },
        { id: 'fast', at: 3.8, end: 8.8 },
        { id: 'look', at: 9.0, end: 12.75 },
      ],
    },
    {
      id: 'flip',
      duration: 11,
      chapter: 'swings',
      // the Sky Flip in full swing (run on to its loops first), its cameras switched
      async setup() {
        await __director.go('flip');
        __director.ride('flip', { fade: false });
        __film.advance(1);
        __stills.run(__game.flip, (f) => f.phase === 'loop' && Math.cos(f.theta) < 0.2);
      },
      settle: 15,
      hints: ['KeyE', 'KeyC', '|', 'Escape'],
      actions: [
        { t: 3.2, tap: 'KeyC' },
        { t: 7.0, tap: 'KeyC' },
      ],
      cues: [
        { id: 'flip', at: 0.3, end: 5.4 },
        { id: 'switch', at: 5.6, end: 10.75 },
      ],
    },
    {
      id: 'ship',
      duration: 10,
      // Nebula 360 looping right round
      async setup() {
        await __director.go('ship');
        __director.ride('ship', { fade: false });
        __film.advance(1);
        __stills.run(__game.ship, (s) => s.phase === 'loop' && s.phaseT > 1);
      },
      settle: 15,
      hints: ['KeyE', 'KeyC', '|', 'Escape'],
      actions: [{ t: 4.6, tap: 'KeyC' }],
      cues: [
        { id: 'ship', at: 0.3, end: 5.0 },
        { id: 'off', at: 5.2, end: 9.75 },
      ],
    },
    {
      id: 'rocket',
      duration: 15,
      chapter: 'rocket',
      // the Rocket Ride: E in its ring, then E fires each stage (the next fires by itself after 9 s)
      async setup() {
        await __director.go('rocket');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 4.4, tap: 'KeyE' },
        { t: 8.0, tap: 'KeyE' },
        { t: 11.4, tap: 'KeyE' },
      ],
      cues: [
        { id: 'rocket', at: 0.3, end: 4.2 },
        { id: 'stages', at: 4.4, end: 9.6 },
        { id: 'orbit', at: 9.8, end: 14.75 },
      ],
    },
    endCard(),
  ],
};
