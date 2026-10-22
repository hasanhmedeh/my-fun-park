// Opens the game for filming in one call: Chrome on the GPU, the film clock and the director
// installed before the game's own code, the network stubs, the world built and walked into, and
// the film settings applied. Every film script starts here.
//
//   const page = await openGame({ width: 1920, height: 1080, hour: 18.4, clean: true });
//   … __director / __film calls …
//   await page.close();

import { launch, sleep } from './chrome.mjs';
import { CLOCK_SCRIPT } from './clock.mjs';
import { DIRECTOR_SCRIPT } from './director.mjs';
import { intercept, rewrite, stubApi } from './intercept.mjs';

/**
 * The game's page on a dev server (window.__game exists only in dev builds). Until feat/real-people
 * is merged: http://localhost:5300/ (a checkout of its last commit, the full game) or :5199/ (its
 * working tree, with the customiser); once the game has moved, the page is /park. FILM_GAME_URL
 * picks another.
 */
export const GAME_URL = process.env.FILM_GAME_URL ?? 'http://localhost:5300/';

/**
 * Fixes for a dev build caught mid-change, applied on the way into the page. Each one checks the
 * file still needs it, so it does nothing once the build is fixed.
 */
export const STOPGAPS = [
  // 2026-10-22: layout.ts lists the changing room in the Main Gate district, but minimap.ts's
  // PLACES has no entry for it yet, so the park map's legend can't be built and the fair won't open.
  // The entry is only added where layout.ts has the room (older builds have neither).
  rewrite('*/src/world/minimap.ts*', (src) =>
    /\bchanging:\s*\{/.test(src)
      ? null
      : src.replace(/(\bideas:\s*\{)/, '...(ZONES.changing ? { changing: { icon: "👕", label: "Changing room", blurb: "Change your look" } } : {}),\n  $1'),
  ),
];

/**
 * Chrome at `width` × `height` (CSS pixels, `scale` device pixels each), the game at `quality`,
 * entered and ready: adaptive resolution off, rendering at `dpr`, the clock at `hour` (unless null),
 * the picture `clean` (no interface, no 3D labels) or not. `api` signs in a pretend member
 * (stubApi's options; false leaves the API calls alone: with no API running the visitor is a
 * guest). `enter`: walk in (true), stay on the intro card (false: a tutorial films the click),
 * 'guide' (walk in with the welcome guide left open) or 'dress' (the first visit's customiser
 * left open). `touch` makes Chrome a touch device (the game's joystick and buttons). `storage`
 * puts entries in the game's localStorage before it starts (the flight's assists, say). Retries
 * the load when a dev server mid-reload breaks it.
 */
export async function openGame({
  width = 1920,
  height = 1080,
  scale = 1,
  dpr = scale,
  quality = 'high',
  hour = 17.5,
  clean = true,
  api = false,
  enter = true,
  touch = false,
  storage = null,
  url: gameUrl = GAME_URL,
  stopgaps = true,
  query = '',
  attempts = 3,
  log,
} = {}) {
  const page = await launch({ width, height, scale, log });
  try {
    await page.addInitScript(CLOCK_SCRIPT);
    await page.addInitScript(DIRECTOR_SCRIPT);
    if (storage)
      await page.addInitScript(`try { for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v); } catch {}`);
    if (touch) await page.emulateTouch(true);
    const handlers = [...(stopgaps ? STOPGAPS : []), ...(api ? [stubApi(api === true ? {} : api)] : [])];
    if (handlers.length) await intercept(page, handlers);
    const url = `${gameUrl}${gameUrl.includes('?') ? '&' : '?'}quality=${quality}${query ? `&${query}` : ''}`;
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      await page.goto(url);
      await page.waitFor('__director.ready() || !!__director.failed()', { timeout: 300_000, what: 'the fair to be built' });
      const failed = await page.evaluate('__director.failed()');
      if (!failed) {
        page.loadMs = Date.now() - t0;
        break;
      }
      if (attempt >= attempts) throw new Error(`the fair didn't open: ${failed}`);
      console.warn(`the fair didn't open (${failed}); trying again`);
      await sleep(5000);
    }
    if (enter) await page.evaluate(`__director.enter(${JSON.stringify({ dress: enter === 'dress', guide: enter === 'guide' })})`);
    page.settings = await page.evaluate(`__director.prepare(${JSON.stringify({ dpr })})`);
    if (hour !== null) await page.evaluate(`__director.hour(${hour})`);
    if (clean) await page.evaluate('__director.clean(true)');
    return page;
  } catch (e) {
    await page.close();
    throw e;
  }
}
