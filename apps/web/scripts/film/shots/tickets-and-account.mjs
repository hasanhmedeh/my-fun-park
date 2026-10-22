// Tickets and your account: a guest signs up on the intro card (Google shown, email used), walks
// in, takes the free pack of 20 tickets at Rosa's booth, buys a treat and a souvenir with them,
// spends one on Thunder Loop and opens the account panel.
//
// The server is a pretend one (lib/intercept.mjs stubApi): it starts signed out with no tickets,
// takes the sign-up, and sells at the real catalogue's prices (apps/api/src/shop/catalog.ts). The
// email typed is example.com's, as nothing is sent anywhere. Every word is a subtitle
// (content/videos.<lang>.json "tickets-and-account"), so one master serves every language.
//
// The visitor is on screen at the booth and the ride: film the final cut on the real-people build (film.md).

import { endCard, helpers, PARK_HOUR, sting } from './common.mjs';

/** A guest in a fresh browser, at the intro card; the pretend server signs them up when asked. */
const SIGNUP = { enter: false, api: { guest: true, balance: 0, username: 'Visitor' } };

export default {
  id: 'tickets-and-account',
  kind: 'tutorial',
  fps: 30,
  music: { track: 'childrens-march', from: 0, fadeIn: 1.5, fadeOut: 3, gain: 0 },
  session: SIGNUP,
  defaults: { ui: 'game', hour: PARK_HOUR, hide: 3 },
  helpers,
  poster: { shot: 'pack', at: 6 },
  // YouTube's thumbnail (youtube.mjs): a few English words over the poster frame
  thumbnail: { kicker: 'Tutorial', words: 'Free tickets' },
  shots: [
    sting('tickets-and-account'),
    {
      id: 'intro',
      duration: 8,
      // the intro card's account row: walk in as a guest, or sign up for the free tickets
      cursor: true,
      pointer: [0.5, 0.86],
      actions: [{ t: 3.6, click: { sel: '#intro-guest [data-auth="signup"]' }, glide: 1.2 }],
      cues: [
        { id: 'free', at: 0.4, end: 3.9 },
        { id: 'signup', at: 4.0, end: 7.75 },
      ],
    },
    {
      id: 'form',
      duration: 14,
      // the sign-up form, filled in as a visitor would (a pretend address: nothing is sent)
      reset: false,
      cursor: true,
      actions: [
        { t: 0.4, move: '.auth-google-btn', glide: 1.0 },
        { t: 2.4, click: '#auth-email', glide: 0.8 },
        { t: 3.3, type: 'visitor@example.com', cps: 16 },
        { t: 4.8, click: '#auth-username', glide: 0.6 },
        { t: 5.5, type: 'Visitor', cps: 12 },
        { t: 6.3, click: '#auth-password', glide: 0.6 },
        { t: 7.0, type: 'funfair-2026', cps: 16 },
        // the gender list (a native drop-down, which headless Chrome doesn't draw): chosen as the list would
        { t: 8.0, move: '#auth-gender', glide: 0.6 },
        {
          t: 8.7,
          page() {
            const s = document.getElementById('auth-gender');
            s.value = 'prefer_not_to_say';
            s.dispatchEvent(new Event('change', { bubbles: true }));
          },
        },
        { t: 9.4, click: '#auth-terms', glide: 0.7 },
        { t: 11.2, click: '.auth-submit', glide: 0.8 },
      ],
      cues: [
        { id: 'google', at: 0.3, end: 2.3 },
        { id: 'details', at: 2.4, end: 6.9 },
        { id: 'terms', at: 7.0, end: 11.0 },
        { id: 'joined', at: 11.2, end: 13.75 },
      ],
    },
    {
      id: 'walk-in',
      duration: 6,
      // the card greets the new member; in they go
      reset: false,
      cursor: true,
      actions: [{ t: 1.4, click: '#enter', glide: 1.0 }],
      cues: [{ id: 'walk-in', at: 0.3, end: 5.75 }],
    },
    {
      id: 'pack',
      duration: 15,
      chapter: 'tickets',
      // Rosa's counter by the entrance: the free pack, then what's left of the five hours
      setup() {
        __shots.guide(false);
        __shots.stand(14, 52, 0);
      },
      hints: ['KeyE'],
      cursor: true,
      pointer: [0.5, 0.5],
      actions: [
        { t: 0.4, hold: 'KeyW', for: 0.9 },
        { t: 1.8, tap: 'KeyE' },
        { t: 5.0, click: '[data-shop-pack]', glide: 1.0 },
      ],
      cues: [
        { id: 'booth', at: 0.3, end: 4.6 },
        { id: 'pack', at: 4.8, end: 9.4 },
        { id: 'carry', at: 9.6, end: 14.75 },
      ],
    },
    {
      id: 'treats',
      duration: 12,
      chapter: 'shop',
      reset: false,
      cursor: true,
      hints: null,
      actions: [
        { t: 0.6, click: '[data-aisle="treats"]', glide: 0.8 },
        { t: 4.2, click: '[data-shop-buy="popcorn"]', glide: 1.0 },
      ],
      cues: [
        { id: 'treats', at: 0.3, end: 5.6 },
        { id: 'perk', at: 5.8, end: 11.75 },
      ],
    },
    {
      id: 'souvenirs',
      duration: 12,
      reset: false,
      cursor: true,
      hints: { rows: ['Escape'], at: 'left' },
      actions: [
        { t: 0.6, click: '[data-aisle="souvenirs"]', glide: 0.8 },
        { t: 3.6, click: '[data-shop-buy="cap"]', glide: 1.0 },
        { t: 9.0, tap: 'Escape' },
      ],
      cues: [
        { id: 'souvenirs', at: 0.3, end: 5.4 },
        { id: 'wear', at: 5.6, end: 8.8 },
        { id: 'leave', at: 9.0, end: 11.75 },
      ],
    },
    {
      id: 'ride',
      duration: 12,
      chapter: 'rides',
      // Thunder Loop's ring: its price in the prompt, then the ticket counter going down by one
      async setup() {
        await __director.go('coaster');
        __game.player.enabled = true;
      },
      hints: ['KeyE'],
      actions: [{ t: 4.2, tap: 'KeyE' }],
      cues: [
        { id: 'price', at: 0.3, end: 4.0 },
        { id: 'spend', at: 4.2, end: 7.8 },
        { id: 'big', at: 8.0, end: 11.75 },
      ],
    },
    {
      id: 'account',
      duration: 13,
      chapter: 'account',
      setup() {
        __shots.stand(0, 40, 0);
      },
      cursor: true,
      pointer: [0.7, 0.4],
      actions: [{ t: 1.2, click: '#account-chip', glide: 1.0 }],
      cues: [
        { id: 'account', at: 0.3, end: 6.6 },
        { id: 'coming', at: 6.8, end: 12.75 },
      ],
    },
    endCard(),
  ],
};
