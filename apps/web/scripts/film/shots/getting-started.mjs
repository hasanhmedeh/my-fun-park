// Getting started: from the intro screen to a first ride. A guest walks in, learns to walk, run,
// roll, kick and wave, turns the camera, tries the joystick on a touch screen, opens the map and
// fast travels to Thunder Loop, where the ring explains tickets; then a member presses E and drives.
//
// The real interface throughout (HUD, prompts, cards, minimap), with the language-neutral keycaps
// over it. Every word is a subtitle (content/videos.<lang>.json "getting-started"), none is in the
// picture, so one master serves every language.
//
// The visitor is on screen in most shots: film the final cut on the real-people build (film.md).

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A guest in a fresh browser: the intro screen first, as a new visitor sees it. */
const GUEST = { enter: false };
/** The same guest on a phone: the joystick and the E button on screen. */
const TOUCH = { enter: true, touch: true };
/** A member with the free pack (a pretend server: lib/intercept.mjs). */
const MEMBER = { enter: true, api: { username: 'Visitor', balance: 20 } };

export default {
  id: 'getting-started',
  kind: 'tutorial',
  fps: 30,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: GUEST,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'walk', at: 4.5 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'First steps' },
  shots: [
    sting('getting-started'),
    {
      id: 'intro',
      duration: 6,
      // the intro card as a first visit shows it; the pointer goes to its button and walks in
      cursor: true,
      pointer: [0.62, 0.78],
      actions: [{ t: 1.0, click: '#enter', glide: 1.4 }],
      cues: [{ id: 'intro', at: 0.4, end: 5.6 }],
    },
    {
      id: 'guide',
      duration: 7,
      setup() {
        // (a real-people build opens the first visit's customiser here: the your-look tutorial shows it)
        __director.skipDressing();
        __shots.guide(true);
      },
      hints: { rows: ['Escape', '|', 'KeyI'], at: 'left' },
      actions: [{ t: 4.2, tap: 'Escape' }],
      cues: [
        { id: 'guide', at: 0.3, end: 4.0 },
        { id: 'guide-close', at: 4.1, end: 6.75 },
      ],
    },
    {
      id: 'walk',
      duration: 10,
      chapter: 'moving',
      // up the avenue from the letters towards the carousel, past a fingerpost (the camera starts clear of the letters)
      setup() {
        __shots.stand(0, 30, 0);
      },
      hints: ['wasd', '|', 'ShiftLeft', 'Space'],
      actions: [
        { t: 0.5, hold: 'KeyW', for: 7.4 },
        { t: 3.6, hold: 'ShiftLeft', for: 2.6 },
        { t: 6.6, tap: 'Space' },
      ],
      cues: [
        { id: 'walk', at: 0.4, end: 3.5 },
        { id: 'run', at: 3.6, end: 6.4 },
        { id: 'roll', at: 6.5, end: 9.75 },
      ],
    },
    {
      id: 'kick',
      duration: 7,
      // up to the A of the giant FUNFAIR letters (they're loose: a kick sends them flying)
      setup() {
        __shots.stand(2.02, 48.2, 0);
      },
      hints: ['KeyF', '|', 'KeyH'],
      actions: [
        { t: 0.8, hold: 'KeyW', for: 0.6 },
        { t: 2.0, tap: 'KeyF' },
        { t: 4.6, tap: 'KeyH' },
      ],
      cues: [
        { id: 'kick', at: 1.6, end: 4.4 },
        { id: 'wave', at: 4.5, end: 6.75 },
      ],
    },
    {
      id: 'look',
      duration: 9,
      setup() {
        __shots.stand(0, 30, 0);
      },
      cursor: true,
      pointer: [0.56, 0.45],
      hints: ['Mouse', '|', 'Wheel'],
      actions: [
        { t: 0.8, drag: { by: [-0.2, 0], seconds: 2.2 } },
        { t: 3.3, drag: { by: [0.26, 0.04], seconds: 1.8 } },
        { t: 5.8, wheel: 120, times: 6, every: 3 },
        { t: 7.2, wheel: -120, times: 4, every: 3 },
      ],
      cues: [
        { id: 'look', at: 0.6, end: 5.2 },
        { id: 'zoom', at: 5.5, end: 8.75 },
      ],
    },
    {
      id: 'touch',
      duration: 11,
      session: TOUCH,
      setup() {
        __shots.stand(0, 30, 0);
      },
      fingers: true,
      actions: [
        { t: 0.6, touch: { from: '#stick', by: [0, -40], seconds: 0.4, hold: 3.2 } },
        { t: 4.6, touch: { from: '#stick', by: [0, -90], seconds: 0.3, hold: 2.6 } },
        { t: 8.0, touch: { from: [0.72, 0.42], by: [-380, 0], seconds: 1.4 } },
      ],
      cues: [
        { id: 'touch', at: 0.4, end: 4.4 },
        { id: 'touch-run', at: 4.5, end: 7.8 },
        { id: 'touch-look', at: 7.9, end: 10.75 },
      ],
    },
    {
      id: 'map',
      duration: 14,
      chapter: 'map',
      setup() {
        __shots.stand(0, 52, 0);
      },
      cursor: true,
      pointer: [0.5, 0.62],
      hints: ['KeyM', '|', 'Mouse', 'Enter'],
      actions: [
        { t: 0.6, tap: 'KeyM' },
        // a place from the list (the map zooms to it), then its Fast travel button
        { t: 2.0, click: { sel: '.wm-legend ul li button', text: 'Thunder Loop' }, glide: 1.2 },
        { t: 6.0, click: '.wm-travel', glide: 0.9 },
      ],
      cues: [
        { id: 'map', at: 0.4, end: 3.3 },
        { id: 'pick', at: 3.4, end: 6.8 },
        { id: 'travel', at: 7.0, end: 10.3 },
        { id: 'arrive', at: 10.4, end: 13.75 },
      ],
    },
    {
      id: 'ring',
      duration: 12,
      chapter: 'rides',
      // still in Thunder Loop's ring, where the map left the guest
      hints: ['KeyE', '|', 'Escape', '|', 'KeyR'],
      actions: [
        { t: 1.0, tap: 'KeyE' },
        { t: 6.9, tap: 'Escape' },
        { t: 8.0, tap: 'KeyR' },
      ],
      cues: [
        { id: 'members', at: 1.4, end: 6.8 },
        { id: 'reset', at: 7.6, end: 11.75 },
      ],
    },
    {
      id: 'play',
      duration: 13,
      session: MEMBER,
      async setup() {
        await __director.go('coaster');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      actions: [
        { t: 1.0, tap: 'KeyE' },
        { t: 3.6, hints: ['KeyW', 'KeyS', 'ShiftLeft', '|', 'KeyC'] },
        { t: 4.0, hold: 'KeyW', for: 7 },
      ],
      cues: [
        { id: 'play', at: 0.3, end: 3.5 },
        { id: 'drive', at: 3.6, end: 7.8 },
        { id: 'more', at: 7.9, end: 12.75 },
      ],
    },
    endCard(),
  ],
};
