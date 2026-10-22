// Fly to Palm Cay: the SkyLink to the airport, booking FA101 at Gate 3, then the take-off, the
// cruise and the landing on the island, and a first look round Palm Cay.
//
// The flying is the game's own scripted crew (world/flight/crew.ts, as the flight checks use): it
// presses nothing, so the keycaps a visitor would press are lit in time with what it does (Y for
// TOGA, S to rotate, G for the gear, T for time warp). Between the shots the flight is run on
// without drawing (__stills.run) to the next part worth seeing. The booking card is the real one;
// the flight itself starts lined up (the "Skip to the runway" assist), at the time picked on the card.
// Every word is a subtitle (content/videos.<lang>.json "fly-to-palm-cay").

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A member with the free pack (a pretend server: lib/intercept.mjs): the flight costs 10. */
const MEMBER = { enter: true, api: { username: 'Visitor', balance: 20 } };

/** The keycaps of the take-off, lit by actions as the crew flies. */
const TAKEOFF_KEYS = ['KeyY', '|', 'KeyS', '|', 'KeyG'];

export default {
  id: 'fly-to-palm-cay',
  kind: 'tutorial',
  fps: 30,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: MEMBER,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'rotate', at: 5 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'Fly the A320neo' },
  shots: [
    sting('fly-to-palm-cay'),
    {
      id: 'skylink',
      duration: 12,
      // the SkyLink's station by the south gate: E boards, E again skips the ride
      async setup() {
        await __director.go('skylink');
        __game.player.enabled = true;
      },
      hints: ['KeyE', '|', 'Escape'],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 8.2, tap: 'KeyE' },
      ],
      cues: [
        { id: 'skylink', at: 0.3, end: 4.0 },
        { id: 'guideway', at: 4.2, end: 8.0 },
        { id: 'skip', at: 8.2, end: 11.75 },
      ],
    },
    {
      id: 'gate',
      duration: 16,
      chapter: 'booking',
      // the Gate 3 desk and its booking card: a time of day, the assists, Board
      async setup() {
        await __director.go('flight');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      cursor: true,
      pointer: [0.75, 0.5],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 4.4, click: '[data-fl-tod="dusk"]', glide: 1.0 },
        { t: 7.4, page: () => document.querySelector('[data-fl-assist="skip"]')?.closest('label')?.scrollIntoView({ block: 'center' }) },
        { t: 7.8, click: '[data-fl-assist="skip"]', glide: 0.9 },
        { t: 11.0, page: () => document.querySelector('[data-flight-board]')?.scrollIntoView({ block: 'center' }) },
        { t: 11.4, move: '[data-flight-board]', glide: 1.0 },
      ],
      cues: [
        { id: 'gate', at: 0.3, end: 4.2 },
        { id: 'time', at: 4.4, end: 7.4 },
        { id: 'assists', at: 7.6, end: 11.2 },
        { id: 'board', at: 11.4, end: 15.75 },
      ],
    },
    {
      id: 'takeoff',
      duration: 11,
      chapter: 'takeoff',
      // lined up on runway 09, dusk; the crew's thrust levers to TOGA
      hour: null,
      hide: 0,
      async setup() {
        await __shots.flight('dusk');
      },
      settle: 20,
      hints: TAKEOFF_KEYS,
      actions: [
        { t: 1.2, page: () => (__director.light('KeyY', true), __shots.toga()) },
        { t: 2.0, page: () => __director.light('KeyY', false) },
      ],
      cues: [
        { id: 'lined-up', at: 0.3, end: 3.2 },
        { id: 'toga', at: 3.4, end: 7.0 },
        { id: 'yours', at: 7.2, end: 10.75 },
      ],
    },
    {
      id: 'rotate',
      duration: 12,
      // on to just before rotation speed, then the pull back and the gear
      hour: null,
      hide: 0,
      reset: false,
      setup() {
        const fl = __game.flight;
        __stills.run(fl, () => fl.sim.state.ias > 134, 3000);
      },
      settle: 20,
      hints: TAKEOFF_KEYS,
      actions: [
        { t: 1.6, page: () => __director.light('KeyS', true) },
        { t: 4.4, page: () => __director.light('KeyS', false) },
        { t: 7.6, page: () => __director.light('KeyG', true) },
        { t: 8.3, page: () => __director.light('KeyG', false) },
      ],
      cues: [
        { id: 'rotate', at: 0.6, end: 6.6 },
        { id: 'gear', at: 7.0, end: 11.75 },
      ],
    },
    {
      id: 'cruise',
      duration: 12,
      chapter: 'cruise',
      hour: null,
      hide: 0,
      reset: false,
      setup() {
        const fl = __game.flight;
        // up to the cruise at 5,000 ft (the crew's autopilot climbs it there)
        __stills.run(fl, () => fl.sim.nav.phase === 'cruise', 30000);
      },
      settle: 30,
      hints: ['KeyP', '|', 'KeyT'],
      actions: [
        { t: 4.6, page: () => __director.light('KeyT', true) },
        { t: 5.2, page: () => __director.light('KeyT', false) },
      ],
      cues: [
        { id: 'cruise', at: 0.3, end: 4.4 },
        { id: 'warp', at: 4.6, end: 11.75 },
      ],
    },
    {
      id: 'landing',
      duration: 15,
      chapter: 'landing',
      hour: null,
      hide: 0,
      reset: false,
      setup() {
        const fl = __game.flight;
        // on to short final at Palm Cay, low enough that the touchdown comes about 10 s in (the
        // crew lands by hand from 200 ft)
        __stills.run(fl, () => fl.sim.nav.phase === 'final' && fl.sim.state.radioAltFt < 100, 60000);
      },
      settle: 30,
      hints: null,
      cues: [
        { id: 'approach', at: 0.3, end: 5.4 },
        { id: 'land', at: 5.6, end: 10.4 },
        { id: 'stars', at: 10.6, end: 14.75 },
      ],
    },
    {
      id: 'island',
      duration: 11,
      chapter: 'island',
      // out of the island terminal: the beach park
      async setup() {
        await __director.go('palmcay');
        __game.player.enabled = true;
      },
      hints: ['wasd'],
      actions: [{ t: 0.6, hold: 'KeyW', for: 8 }],
      cues: [
        { id: 'island', at: 0.3, end: 5.4 },
        { id: 'home', at: 5.6, end: 10.75 },
      ],
    },
    endCard(),
  ],
};
