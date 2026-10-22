// Your look: the first visit's customiser, as a new visitor meets it. Pick a person from the cast,
// dye their clothes and hair, change height and build, try Random, and walk into the park.
//
// NEEDS A RE-CHECK before it's filmed for real: the customiser is the real-people work in progress
// (uncommitted when this was scripted), so this list is written against that build as it stood
// (world/customiser.ts: data-cust-*), and filmed from the dev server that runs it
// (FILM_LOOK_URL, http://localhost:5199/ by default). Film it with --check first and fix
// what has moved (film.md). Every word is a subtitle (content/videos.<lang>.json "your-look").

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A first visit on the real-people build: in with the customiser left open. */
const FIRST_VISIT = { enter: 'dress', url: process.env.FILM_LOOK_URL ?? 'http://localhost:5199/' };

export default {
  id: 'your-look',
  kind: 'tutorial',
  fps: 30,
  recheck: true,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: FIRST_VISIT,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'colours', at: 8 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'Your look' },
  shots: [
    sting('your-look'),
    {
      id: 'pick',
      duration: 15,
      // the cast: two people tried, the second kept (reset would shut the customiser the session opened)
      reset: false,
      cursor: true,
      pointer: [0.7, 0.5],
      actions: [
        { t: 1.4, click: '.cust-person:nth-child(3)', glide: 1.0 },
        { t: 5.6, click: '.cust-person:nth-child(8)', glide: 1.0 },
        { t: 10.4, click: '[data-cust-filter="f"]', glide: 0.9 },
        { t: 12.4, click: '[data-cust-filter="all"]', glide: 0.6 },
      ],
      cues: [
        { id: 'first', at: 0.3, end: 5.2 },
        { id: 'pick', at: 5.4, end: 10.2 },
        { id: 'filter', at: 10.4, end: 14.75 },
      ],
    },
    {
      id: 'colours',
      duration: 15,
      chapter: 'colours',
      // (reset would shut the customiser: each shot carries on where the last left it)
      reset: false,
      cursor: true,
      actions: [
        { t: 0.6, click: '[data-cust-tab="colours"]', glide: 0.8 },
        { t: 2.6, click: '.cust-sw[data-cust-row="top"]:nth-child(4)', glide: 0.8 },
        { t: 5.0, click: '.cust-sw[data-cust-row="bottom"]:nth-child(6)', glide: 0.8 },
        { t: 7.6, page: () => document.querySelector('.cust-sw[data-cust-row="hair"]')?.scrollIntoView({ block: 'center' }) },
        { t: 8.0, click: '.cust-sw[data-cust-row="hair"]:nth-child(5)', glide: 0.8 },
        { t: 11.2, click: '[data-cust-undo]', glide: 0.9 },
      ],
      cues: [
        { id: 'dye', at: 0.3, end: 7.4 },
        { id: 'undo', at: 7.6, end: 14.75 },
      ],
    },
    {
      id: 'body',
      duration: 12,
      chapter: 'body',
      reset: false,
      cursor: true,
      actions: [
        { t: 0.6, click: '[data-cust-tab="body"]', glide: 0.8 },
        { t: 2.2, drag: { from: '#cust-height', by: [0.05, 0], seconds: 1.2 } },
        { t: 4.4, drag: { from: '#cust-build', by: [-0.04, 0], seconds: 1.0 } },
        { t: 8.6, click: '[data-cust-random]', glide: 0.9 },
      ],
      cues: [
        { id: 'size', at: 0.3, end: 6.6 },
        { id: 'random', at: 8.6, end: 11.75 },
      ],
    },
    {
      id: 'done',
      duration: 12,
      chapter: 'done',
      reset: false,
      cursor: true,
      hints: ['wasd'],
      actions: [
        { t: 1.0, click: '[data-cust-done]', glide: 0.9 },
        { t: 4.0, hold: 'KeyW', for: 6 },
      ],
      cues: [
        { id: 'done', at: 0.3, end: 3.8 },
        { id: 'saved', at: 4.0, end: 7.8 },
        { id: 'room', at: 8.0, end: 11.75 },
      ],
    },
    endCard(),
  ],
};
