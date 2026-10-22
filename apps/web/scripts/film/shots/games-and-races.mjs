// Games and races: a round of each midway game, a lap's worth of the Turbo Speedway and the Rally
// Trail, and the four games on Palm Cay, each started with E in its ring as a visitor does (the
// pretend server's tickets, lib/intercept.mjs), with its keys on the keycaps.
//
// The rounds are cut short: each shot is the start of a round, where the keys are explained. Every
// word is a subtitle (content/videos.<lang>.json "games-and-races"), so one master serves every language.

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A member with the free pack (a pretend server: lib/intercept.mjs). */
const MEMBER = { enter: true, api: { username: 'Visitor', balance: 20 } };

/** Each shot's setup: the visitor in the ring of the game named by the shot's `args` (page code). */
const ring = async (zone) => {
  await __director.go(zone);
  __game.player.enabled = true;
};

export default {
  id: 'games-and-races',
  kind: 'tutorial',
  fps: 30,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: MEMBER,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'speedway', at: 8 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'Games & races' },
  shots: [
    sting('games-and-races'),
    {
      id: 'ducks',
      duration: 12,
      args: 'ducks',
      setup: ring,
      hints: ['KeyE'],
      cursor: true,
      pointer: [0.5, 0.5],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['wasd', '|', 'Mouse', '|', 'KeyE', 'Space'] },
        { t: 4.0, click: [0.38, 0.42], glide: 0.6 },
        { t: 5.4, click: [0.55, 0.5], glide: 0.6 },
        { t: 6.8, click: [0.66, 0.36], glide: 0.6 },
        { t: 8.4, hold: 'KeyA', for: 0.8 },
        { t: 9.4, tap: 'Space' },
        { t: 10.6, tap: 'Space' },
      ],
      cues: [
        { id: 'ducks', at: 0.3, end: 3.8 },
        { id: 'aim', at: 4.0, end: 8.2 },
        { id: 'golden', at: 8.4, end: 11.75 },
      ],
    },
    {
      id: 'striker',
      duration: 10,
      args: 'striker',
      setup: ring,
      hints: ['KeyE', 'Space'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.4, tap: 'Space' },
        { t: 6.6, tap: 'Space' },
      ],
      cues: [
        { id: 'striker', at: 0.3, end: 3.2 },
        { id: 'meter', at: 3.4, end: 9.75 },
      ],
    },
    {
      id: 'crates',
      duration: 11,
      args: 'crates',
      setup: ring,
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['wasd', 'ShiftLeft', '|', 'Space', 'KeyF'] },
        { t: 3.4, hold: 'KeyW', for: 2.8 },
        { t: 3.4, hold: 'ShiftLeft', for: 2.0 },
        { t: 5.2, tap: 'Space' },
        { t: 7.6, tap: 'KeyF' },
      ],
      cues: [
        { id: 'crates', at: 0.3, end: 3.2 },
        { id: 'smash', at: 3.4, end: 10.75 },
      ],
    },
    {
      id: 'speedway',
      duration: 15,
      chapter: 'tracks',
      args: 'speedway',
      setup: ring,
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['wasd', '|', 'ShiftLeft', 'Space', '|', 'KeyR'] },
        { t: 4.0, hold: 'KeyW', for: 10.8 },
        { t: 8.0, hold: 'ShiftLeft', for: 1.0 },
        { t: 11.0, hold: 'Space', for: 1.2 },
        { t: 11.0, hold: 'KeyA', for: 1.4 },
        // off into the tyres at the first bend: R puts the kart back on the track
        { t: 12.8, tap: 'KeyR' },
      ],
      cues: [
        { id: 'speedway', at: 0.3, end: 3.8 },
        { id: 'drive', at: 4.0, end: 7.8 },
        { id: 'nitro', at: 8.0, end: 14.75 },
      ],
    },
    {
      id: 'trail',
      duration: 13,
      args: 'trail',
      setup: ring,
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['wasd', '|', 'ShiftLeft', 'Space', '|', 'KeyR', 'KeyT'] },
        { t: 3.6, hold: 'KeyW', for: 9.2 },
      ],
      cues: [
        { id: 'trail', at: 0.3, end: 4.4 },
        { id: 'ghost', at: 4.6, end: 8.6 },
        { id: 'top', at: 8.8, end: 12.75 },
      ],
    },
    {
      id: 'jetski',
      duration: 12,
      chapter: 'island',
      args: 'jetski',
      setup: ring,
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['wasd', '|', 'ShiftLeft', 'KeyE', 'Space'] },
        { t: 4.0, hold: 'KeyW', for: 7.8 },
        { t: 7.0, hold: 'ShiftLeft', for: 1.4 },
        { t: 9.6, tap: 'Space' },
      ],
      cues: [
        { id: 'island', at: 0.3, end: 3.8 },
        { id: 'jetski', at: 4.0, end: 11.75 },
      ],
    },
    {
      id: 'slides',
      duration: 10,
      args: 'slides',
      setup: ring,
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        // (E again skips the climb up the tower; at the top, pick a slide and go)
        { t: 2.4, tap: 'KeyE' },
        { t: 3.0, hints: ['Digit1', 'Digit2', 'Digit3', '|', 'KeyE'] },
        { t: 4.0, tap: 'Digit2' },
        { t: 5.6, tap: 'KeyE' },
      ],
      cues: [{ id: 'slides', at: 0.3, end: 9.75 }],
    },
    {
      id: 'cannons',
      duration: 10,
      args: 'cannons',
      setup: ring,
      hints: ['KeyE'],
      cursor: true,
      pointer: [0.5, 0.6],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['Mouse', '|', 'KeyE', 'Space'] },
        { t: 3.6, click: [0.42, 0.44], glide: 0.6 },
        { t: 5.6, click: [0.6, 0.45], glide: 0.6 },
        { t: 7.6, click: [0.5, 0.43], glide: 0.6 },
      ],
      cues: [{ id: 'cannons', at: 0.3, end: 9.75 }],
    },
    {
      id: 'volley',
      duration: 9,
      args: 'volley',
      setup: ring,
      hints: ['KeyE'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 3.0, hints: ['wasd', '|', 'KeyE', 'Space'] },
        { t: 4.4, tap: 'Space' },
        { t: 5.2, tap: 'Space' },
      ],
      cues: [{ id: 'volley', at: 0.3, end: 8.75 }],
    },
    endCard(),
  ],
};
