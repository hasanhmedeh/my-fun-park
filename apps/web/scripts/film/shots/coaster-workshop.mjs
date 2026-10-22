// The Coaster Workshop: a member goes in with E, opens the free starter kit, lays a small circuit
// (a lift hill, a drop, a loop and home), checks it can be built, test-rides it, buys the loop kit
// it needs in the Parts tab, saves it and sends it to staff; the Designs tab shows the extra slot's
// "Payments coming soon".
//
// The first pieces are added with the Add buttons on film; the rest of the circuit is laid by page
// code a few pieces at a time (__shots.build, the stills' design that passes every check) so the
// shot doesn't spend a minute on sliders. The server is a pretend one (lib/intercept.mjs): it sells
// parts at the API's prices and takes the design. Every word is a subtitle
// (content/videos.<lang>.json "coaster-workshop").

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A member with the free pack and the starter kit still to open (a pretend server). */
const MEMBER = { enter: true, api: { username: 'Visitor', balance: 20 } };

export default {
  id: 'coaster-workshop',
  kind: 'tutorial',
  fps: 30,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: MEMBER,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'build', at: 13 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'Build a coaster' },
  shots: [
    sting('coaster-workshop'),
    {
      id: 'enter',
      duration: 11,
      // the Workshop's ring in Creators' Valley; inside, the starter kit card
      async setup() {
        await __director.go('workshop');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      cursor: true,
      pointer: [0.8, 0.5],
      actions: [
        { t: 0.8, tap: 'KeyE' },
        { t: 6.0, click: '[data-ws-act="kit"]', glide: 1.0 },
      ],
      cues: [
        { id: 'enter', at: 0.3, end: 5.4 },
        { id: 'kit', at: 5.6, end: 10.75 },
      ],
    },
    {
      id: 'build',
      duration: 16,
      chapter: 'build',
      reset: false,
      cursor: true,
      actions: [
        // the first three with the Add buttons, given the design's settings as the sliders would
        { t: 0.6, click: '[data-ws-add="curve"]', glide: 0.8 },
        { t: 1.8, click: '[data-ws-add="straight"]', glide: 0.6 },
        { t: 3.0, click: '[data-ws-add="slope"]', glide: 0.6 },
        { t: 3.8, page: () => __shots.tune() },
        // then the rest of the circuit, a few pieces at a time
        { t: 5.4, page: () => __shots.build(5) },
        { t: 7.0, page: () => __shots.build(7) },
        { t: 8.6, page: () => __shots.build(9) },
        { t: 10.2, page: () => __shots.build(11) },
        { t: 11.8, page: () => __shots.build(13) },
      ],
      cues: [
        { id: 'add', at: 0.3, end: 5.2 },
        { id: 'circuit', at: 5.4, end: 10.6 },
        { id: 'home', at: 10.8, end: 15.75 },
      ],
    },
    {
      id: 'check',
      duration: 13,
      reset: false,
      cursor: true,
      actions: [
        // the loop (piece 10): its settings in the editor
        { t: 0.6, click: '[data-ws-select="9"]', glide: 0.9 },
        { t: 5.4, click: '[data-ws-act="done"]', glide: 0.8 },
        { t: 6.6, page: () => document.querySelector('[data-ws-checks]')?.scrollIntoView({ block: 'center' }) },
      ],
      cues: [
        { id: 'piece', at: 0.3, end: 5.2 },
        { id: 'check', at: 6.6, end: 12.75 },
      ],
    },
    {
      id: 'test',
      duration: 15,
      chapter: 'test',
      reset: false,
      cursor: true,
      hints: { rows: ['Escape'], at: 'left' },
      actions: [
        { t: 0.6, click: '[data-ws-act="test"]', glide: 0.9 },
        { t: 13.4, tap: 'Escape' },
      ],
      cues: [
        { id: 'test', at: 0.3, end: 5.4 },
        { id: 'physics', at: 5.6, end: 10.6 },
        { id: 'back', at: 10.8, end: 14.75 },
      ],
    },
    {
      id: 'parts',
      duration: 14,
      chapter: 'save',
      reset: false,
      cursor: true,
      actions: [
        { t: 0.6, click: '[data-ws-tab="parts"]', glide: 0.9 },
        // what the design still needs, bought one part at a time (each purchase redraws the list, so a
        // second apart): the hills it's short of, then the loop kit
        { t: 4.2, click: '.ws-part.is-needed [data-ws-buy]', glide: 1.0 },
        ...[6.4, 7.4, 8.4, 9.4].map((t) => ({ t, page: () => document.querySelector('.ws-part.is-needed [data-ws-buy]:not(:disabled)')?.click() })),
        { t: 10.4, click: '[data-ws-act="save"]', glide: 1.0 },
      ],
      cues: [
        { id: 'parts', at: 0.3, end: 4.0 },
        { id: 'needs', at: 4.2, end: 9.8 },
        { id: 'save', at: 10.0, end: 13.75 },
      ],
    },
    {
      id: 'send',
      duration: 15,
      reset: false,
      cursor: true,
      actions: [
        { t: 0.6, click: '[data-ws-tab="designs"]', glide: 0.9 },
        { t: 2.0, page: () => document.querySelector('.ws-slot')?.scrollIntoView({ block: 'center' }) },
        { t: 6.0, click: '[data-ws-act="send"]', glide: 1.0 },
        { t: 8.0, click: '[data-ws-yes]', glide: 0.7 },
        { t: 10.4, click: '[data-ws-tab="sent"]', glide: 0.8 },
      ],
      cues: [
        { id: 'slots', at: 0.3, end: 5.6 },
        { id: 'send', at: 5.8, end: 10.2 },
        { id: 'valley', at: 10.4, end: 14.75 },
      ],
    },
    endCard(),
  ],
};
