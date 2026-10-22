// The page's network, as filming needs it (CDP's Fetch domain: nothing in the page changes):
//  - stubApi answers the game's /api/* calls with a pretend member, so tutorials can show the
//    ticket counter, the "Press E · 3 🎟️" prompts, boarding, the booth's shop, the Coaster
//    Workshop and the results screen without the API (apps/api) running. Its data is plainly made
//    up: the member is "demo" (visitor@example.com), the leaderboard and the idea box come back
//    empty, and the history counts only what was played on film.
//  - rewrite edits a file on its way into the page (a stopgap while a dev build has a bug the film
//    must not wait for; never needed for a clean build).
//
//   await intercept(page, [stubApi({ username: 'demo', balance: 20 }), rewrite('*/src/world/minimap.ts*', (src) => …)]);

/** Each ride's price in tickets unless the stub is told otherwise: the game's own defaults (account/api.ts DEFAULT_COSTS). */
const COSTS = { coaster: 1, falcon: 5, rocket: 1, ferris: 5, flip: 1, ship: 1, speedway: 1, trail: 1, drone: 1, crates: 1, striker: 1, ducks: 1, flight: 10, jetski: 1, slides: 1, cannons: 1, volley: 1 };
for (let n = 1; n <= 8; n++) COSTS[`plot${n}`] = 1;

/**
 * Pauses the page's matching requests and hands each to the first handler that wants it:
 * { match(url, stage) → boolean, request?(req) → reply | null, response?(req, body) → string | null }.
 * A reply is { status, json } or { status, body, contentType }; null lets the request go on as it was.
 */
export async function intercept(page, handlers) {
  const patterns = [];
  for (const h of handlers) patterns.push(...h.patterns);
  await page.send('Fetch.enable', { patterns });
  page.on('Fetch.requestPaused', async (e) => {
    const stage = e.responseStatusCode === undefined && !e.responseErrorReason ? 'request' : 'response';
    const h = handlers.find((x) => x.match(e.request.url, stage));
    try {
      if (h && stage === 'request' && h.request) {
        const reply = await h.request(e.request);
        if (reply) return await fulfill(page, e.requestId, reply);
      }
      if (h && stage === 'response' && h.response && !e.responseErrorReason) {
        const r = await page.send('Fetch.getResponseBody', { requestId: e.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        const edited = h.response(e.request, body);
        if (edited !== null && edited !== undefined) {
          const headers = (e.responseHeaders ?? []).filter((x) => !/^(content-length|content-encoding|etag)$/i.test(x.name));
          return await page.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: e.responseStatusCode, responseHeaders: headers, body: Buffer.from(edited).toString('base64') });
        }
      }
      await page.send('Fetch.continueRequest', { requestId: e.requestId });
    } catch {
      // the page went away mid-request (a reload): nothing to answer
    }
  });
}

function fulfill(page, requestId, { status = 200, json, body = '', contentType = 'application/json' }) {
  const text = json === undefined ? body : JSON.stringify(json);
  return page.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: status,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: Buffer.from(text).toString('base64'),
  });
}

/**
 * The booth's catalog as the API sells it by default (apps/api/src/shop/catalog.ts SHOP_ITEMS, the
 * prices in tickets), so the shop on film is the real one.
 */
const SHOP_ITEMS = [
  { id: 'cotton-candy', kind: 'treat', name: 'Cotton Candy', icon: '🍭', tickets: 3, perk: 'speed', minutes: 3, blurb: 'Spun fresh while you wait. Sugar rush: you run 40% faster for 3 minutes.' },
  { id: 'popcorn', kind: 'treat', name: 'Popcorn', icon: '🍿', tickets: 2, perk: 'kick', minutes: 3, blurb: 'Hot and buttery. Power kick: crates and letters fly twice as far for 3 minutes.' },
  { id: 'soda', kind: 'treat', name: 'Fizzy Soda', icon: '🥤', tickets: 2, perk: 'drone', minutes: 60, blurb: 'Ice cold and fizzing. Your next drone flight in the hour gets 60 extra seconds of battery.' },
  { id: 'candy-apple', kind: 'treat', name: 'Candy Apple', icon: '🍎', tickets: 1, blurb: 'A crunchy fairground classic. No superpowers, just delicious.' },
  { id: 'balloon', kind: 'souvenir', slot: 'leftHand', name: 'Balloon', icon: '🎈', tickets: 4, blurb: 'A shiny red balloon on a string, bobbing along wherever you go.' },
  { id: 'shades', kind: 'souvenir', slot: 'face', name: 'Star Shades', icon: '🕶️', tickets: 5, blurb: 'Gold star-shaped sunglasses. Too cool for the queue.' },
  { id: 'cap', kind: 'souvenir', slot: 'head', name: 'Fair Cap', icon: '🧢', tickets: 6, blurb: "The fair's own cap, in candy red with a cream peak." },
  { id: 'foam-finger', kind: 'souvenir', slot: 'rightHand', name: 'Foam Finger', icon: '👆', tickets: 8, blurb: 'Giant, golden and pointing at the next ride.' },
  { id: 'top-hat', kind: 'souvenir', slot: 'head', name: "Ringmaster's Top Hat", icon: '🎩', tickets: 12, blurb: 'Black silk with a red band. Look like you run the place.' },
].map((i) => ({ ...i, stock: null }));

/** The Coaster Workshop's parts and the free starter kit (apps/api/src/workshop/design.ts PARTS, STARTER_KIT). */
const PARTS = {
  steel: { name: 'Steel track', unit: '10 m', icon: '🛤️', tickets: 1, blurb: 'Straights, curves, slopes, helices and the way home' },
  lift: { name: 'Lift hill', unit: '10 m', icon: '⛓️', tickets: 2, blurb: 'Pulls the train up at a steady speed' },
  launch: { name: 'Launch track', unit: '10 m', icon: '🚀', tickets: 3, blurb: 'Linear motors that fire the train forward' },
  brakes: { name: 'Brake run', unit: '10 m', icon: '🛑', tickets: 1, blurb: 'Slows the train to a set speed' },
  loop: { name: 'Loop kit', unit: 'kit', icon: '➰', tickets: 5, blurb: 'One vertical loop, steel included' },
  corkscrew: { name: 'Corkscrew kit', unit: 'kit', icon: '🌀', tickets: 4, blurb: 'One corkscrew roll, steel included' },
  station: { name: 'Station', unit: 'each', icon: '🚉', tickets: 3, blurb: 'Every coaster starts and ends at one' },
  car: { name: 'Train car', unit: 'each', icon: '🚃', tickets: 2, blurb: 'Four seats each; trains have 2 to 6' },
};
const STARTER_KIT = { steel: 15, station: 1, lift: 2, brakes: 2, car: 2 };
const noParts = () => Object.fromEntries(Object.keys(PARTS).map((p) => [p, 0]));

/**
 * A pretend member for the game's account calls (apps/web/src/account/api.ts), with plainly made-up
 * demo data: signed in as `username` ("demo", visitor@example.com) with `balance` tickets, the park
 * open. `guest` starts signed out: the sign-up and log-in forms then sign the demo member in,
 * whatever is typed. Boarding takes the ride's tickets and opens a round; finishing it keeps it, and
 * the account's history counts only the rounds played on film. The booth sells its real catalog
 * for tickets, and the Coaster Workshop has its real parts and starter kit (`starterKit`: already
 * claimed). Calls it doesn't know get a 404, which the game treats as "the ticket office is closed"
 * (as it does with no API at all). Nothing is sent anywhere: the requests stop at Chrome.
 */
export function stubApi({ username = 'demo', balance = 20, packSize = 20, cooldownHours = 5, costs = COSTS, canBuy = true, user = null, guest = false, starterKit = false, souvenirs = [] } = {}) {
  const now = () => new Date().toISOString();
  const me = user ?? {
    id: 'film-demo',
    email: 'visitor@example.com',
    username,
    createdAt: '2026-01-01T00:00:00.000Z',
    role: 'player',
    gender: 'prefer_not_to_say',
    hasPassword: true,
    google: false,
    termsAcceptedAt: '2026-01-01T00:00:00.000Z',
    visitorLook: null,
  };
  let signedIn = !guest;
  const wallet = { balance, lastPurchaseAt: null };
  /** The rounds played on film: ride → { rounds, ticketsSpent }. */
  const played = {};
  let rounds = 0;
  const owned = souvenirs.map((item) => ({ item, equipped: true, acquiredAt: '2026-01-01T00:00:00.000Z' }));
  const orders = [];
  const parts = { owned: noParts(), claimed: starterKit };
  if (starterKit) for (const [p, n] of Object.entries(STARTER_KIT)) parts.owned[p] += n;
  const designs = new Map();
  /** The coasters sent to the staff on film (newest first). */
  const sent = [];
  const slotOf = (id) => SHOP_ITEMS.find((i) => i.id === id)?.slot;
  const nextPurchaseAt = () => (wallet.lastPurchaseAt ? new Date(Date.parse(wallet.lastPurchaseAt) + cooldownHours * 3_600_000).toISOString() : null);
  const tickets = () => ({ balance: wallet.balance, packSize, cooldownHours, ticketCap: null, lastPurchaseAt: wallet.lastPurchaseAt, nextPurchaseAt: nextPurchaseAt(), canBuy: canBuy && !wallet.lastPurchaseAt, costs });
  const park = () => ({ open: true, message: null, underMaintenance: false, maintenanceMessage: null, costs, packSize, cooldownHours, ticketCap: null, maintenance: {}, creations: [] });
  const partList = () => Object.entries(PARTS).map(([id, p]) => ({ id, ...p, stock: null }));
  const summary = (d) => ({ id: d.id, name: d.data.name ?? 'My coaster', pieces: d.data.pieces?.length ?? 0, parts: noParts(), updatedAt: d.updatedAt, latest: d.latest });
  const saved = (d) => ({ ...summary(d), data: d.data, createdAt: d.createdAt });
  const workshop = () => ({
    parts: partList(),
    owned: parts.owned,
    held: noParts(),
    starterKit: { claimed: parts.claimed, contents: STARTER_KIT },
    slots: { free: 3, extra: 0, used: designs.size, extraPriceUsd: 4.99, onSale: false },
    submissions: { perDay: 3, last24h: [...designs.values()].filter((d) => d.latest).length, nextAt: null },
    designs: [...designs.values()].map(summary),
    unread: 0,
  });
  const stats = () => {
    const byRide = {};
    let total = 0;
    let spent = 0;
    for (const [ride, s] of Object.entries(played)) {
      byRide[ride] = { rounds: s.rounds, ticketsSpent: s.ticketsSpent, best: {}, last: { stats: null, endedAt: now() } };
      total += s.rounds;
      spent += s.ticketsSpent;
    }
    return { totalRounds: total, ticketsSpent: spent, byRide };
  };
  const signedOut = () => ({ status: 401, json: { message: 'Not signed in' } });
  const signIn = () => {
    signedIn = true;
    return { json: { user: me } };
  };
  const design = (m) => designs.get(decodeURIComponent(m[1]));
  const noDesign = { status: 404, json: { message: 'No such design' } };
  /** method + path (after /api) → reply; the ones marked 'open' answer a guest too. */
  const routes = [
    ['GET', /^\/auth\/me$/, () => (signedIn ? { json: { user: me } } : signedOut()), 'open'],
    ['POST', /^\/auth\/(signup|login|google\/signup)$/, signIn, 'open'],
    ['POST', /^\/auth\/logout$/, () => ((signedIn = false), { status: 204, body: '' }), 'open'],
    ['GET', /^\/auth\/google\/enabled$/, () => ({ json: { enabled: true } }), 'open'],
    ['PATCH', /^\/auth\/me$/, (m, body) => ({ json: { user: { ...me, ...(body ?? {}) } } })],
    ['GET', /^\/park$/, () => ({ json: park() }), 'open'],
    ['GET', /^\/tickets$/, () => ({ json: tickets() })],
    [
      'POST',
      /^\/tickets\/purchase$/,
      () => {
        wallet.balance += packSize;
        wallet.lastPurchaseAt = now();
        return { json: { balance: wallet.balance, purchase: { id: 'film-purchase', quantity: packSize, priceCents: 0, currency: 'USD', createdAt: now() }, nextPurchaseAt: nextPurchaseAt(), canBuy: false } };
      },
    ],
    ['GET', /^\/tickets\/purchases/, () => ({ json: { purchases: wallet.lastPurchaseAt ? [{ id: 'film-purchase', quantity: packSize, priceCents: 0, currency: 'USD', createdAt: wallet.lastPurchaseAt }] : [] } })],
    [
      'POST',
      /^\/rides\/([a-z0-9]+)\/board$/,
      (m) => {
        const ride = m[1];
        const spent = costs[ride] ?? 1;
        if (wallet.balance < spent) return { status: 402, json: { message: 'Not enough tickets', needed: spent, balance: wallet.balance } };
        wallet.balance -= spent;
        const s = (played[ride] ??= { rounds: 0, ticketsSpent: 0 });
        s.rounds++;
        s.ticketsSpent += spent;
        return { json: { round: { id: `film-round-${++rounds}-${ride}`, ride, ticketsSpent: spent, startedAt: now() }, balance: wallet.balance } };
      },
    ],
    [
      'POST',
      /^\/rides\/rounds\/([^/]+)\/finish$/,
      (m, body) => {
        const ride = m[1].replace(/^film-round-\d+-/, '');
        return { json: { round: { id: m[1], ride, ticketsSpent: costs[ride] ?? 1, startedAt: now(), endedAt: now(), completed: !!body?.completed, stats: body?.stats ?? {} }, history: { rounds: played[ride]?.rounds ?? 1, best: {} } } };
      },
    ],
    ['POST', /^\/rides\/rounds\/([^/]+)\/refund$/, () => ({ json: { refunded: 0, balance: wallet.balance } })],
    ['GET', /^\/rides\/stats$/, () => ({ json: stats() })],
    ['GET', /^\/rides\/history/, () => ({ json: { rounds: [] } })],
    ['GET', /^\/trail\/leaderboard$/, () => ({ json: { day: now().slice(0, 10), startsAt: now(), resetsAt: new Date(Date.now() + 864e5).toISOString(), timeZone: 'Asia/Beirut', resetHour: 12, players: 0, runs: 0, entries: [], me: null, now: now() } }), 'open'],
    ['GET', /^\/suggestions$/, () => ({ json: { suggestions: [], total: 0, unread: 0 } })],
    // the booth's shop
    ['GET', /^\/shop$/, () => ({ json: { items: SHOP_ITEMS } }), 'open'],
    ['GET', /^\/shop\/souvenirs$/, () => ({ json: { souvenirs: owned } })],
    ['GET', /^\/shop\/orders/, () => ({ json: { orders: orders.slice().reverse(), total: orders.length } })],
    [
      'POST',
      /^\/shop\/buy$/,
      (m, body) => {
        const item = SHOP_ITEMS.find((i) => i.id === body?.item);
        if (!item) return { status: 404, json: { message: 'No such item' } };
        if (wallet.balance < item.tickets) return { status: 402, json: { message: 'Not enough tickets', needed: item.tickets, balance: wallet.balance } };
        wallet.balance -= item.tickets;
        if (item.kind === 'souvenir' && !owned.some((s) => s.item === item.id)) {
          // one souvenir worn per spot: the new one takes its spot
          for (const s of owned) if (slotOf(s.item) === item.slot) s.equipped = false;
          owned.push({ item: item.id, equipped: true, acquiredAt: now() });
        }
        const order = { id: `film-order-${orders.length + 1}`, item: item.id, ticketsSpent: item.tickets, balanceAfter: wallet.balance, createdAt: now() };
        orders.push(order);
        return { json: { balance: wallet.balance, order, souvenirs: owned } };
      },
    ],
    [
      'PATCH',
      /^\/shop\/souvenirs\/([^/]+)$/,
      (m, body) => {
        const id = decodeURIComponent(m[1]);
        for (const s of owned) {
          if (s.item === id) s.equipped = !!body?.equipped;
          else if (body?.equipped && slotOf(s.item) === slotOf(id)) s.equipped = false;
        }
        return { json: { souvenirs: owned } };
      },
    ],
    // the Coaster Workshop
    ['GET', /^\/workshop$/, () => ({ json: workshop() })],
    ['GET', /^\/workshop\/parts$/, () => ({ json: { parts: partList() } }), 'open'],
    [
      'POST',
      /^\/workshop\/starter-kit$/,
      () => {
        if (parts.claimed) return { status: 409, json: { message: 'Already claimed' } };
        parts.claimed = true;
        for (const [p, n] of Object.entries(STARTER_KIT)) parts.owned[p] += n;
        return { json: workshop() };
      },
    ],
    [
      'POST',
      /^\/workshop\/parts\/buy$/,
      (m, body) => {
        const part = PARTS[body?.part];
        const qty = Math.max(1, Number(body?.quantity) || 1);
        if (!part) return { status: 404, json: { message: 'No such part' } };
        if (wallet.balance < part.tickets * qty) return { status: 402, json: { message: 'Not enough tickets', needed: part.tickets * qty, balance: wallet.balance } };
        wallet.balance -= part.tickets * qty;
        parts.owned[body.part] += qty;
        return { json: { balance: wallet.balance, owned: parts.owned, part: { id: body.part, ...part, stock: null } } };
      },
    ],
    [
      'POST',
      /^\/workshop\/designs$/,
      (m, body) => {
        const d = { id: `film-design-${designs.size + 1}`, data: body?.design ?? {}, createdAt: now(), updatedAt: now(), latest: null };
        designs.set(d.id, d);
        return { json: saved(d) };
      },
    ],
    ['GET', /^\/workshop\/designs\/([^/]+)$/, (m) => (design(m) ? { json: saved(design(m)) } : noDesign)],
    [
      'PUT',
      /^\/workshop\/designs\/([^/]+)$/,
      (m, body) => {
        const d = design(m);
        if (!d) return noDesign;
        Object.assign(d, { data: body?.design ?? d.data, updatedAt: now() });
        return { json: saved(d) };
      },
    ],
    [
      'POST',
      /^\/workshop\/designs\/([^/]+)\/submit$/,
      (m) => {
        const d = design(m);
        if (!d) return noDesign;
        d.latest = { id: `film-creation-${d.id}`, status: 'pending', plot: null };
        const creation = { id: d.latest.id, designId: d.id, name: d.data.name ?? 'My coaster', status: 'pending', statusChangedAt: null, plot: null, reply: null, reviewedBy: null, stats: {}, rides: 0, earned: 0, unread: false, createdAt: now() };
        sent.unshift(creation);
        return { json: creation };
      },
    ],
    // (the Sent tab: what was sent on film, waiting for the staff)
    ['GET', /^\/workshop\/creations$/, () => ({ json: { creations: sent, unread: 0 } })],
    ['POST', /^\/workshop\/creations\/seen$/, () => ({ status: 204, body: '' })],
  ];
  return {
    patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }],
    match: (url, stage) => stage === 'request' && new URL(url).pathname.startsWith('/api/'),
    request(req) {
      const path = new URL(req.url).pathname.slice(4);
      let body = null;
      try {
        body = req.postData ? JSON.parse(req.postData) : null;
      } catch {
        /* not JSON */
      }
      for (const [method, re, fn, open] of routes) {
        const m = req.method === method && path.match(re);
        if (!m) continue;
        // a guest's calls that need an account get what the API gives a guest
        if (!signedIn && open !== 'open') return signedOut();
        return fn(m, body);
      }
      // the live park stream and anything else: as if the API weren't there
      return { status: 404, json: { message: 'Not here while filming' } };
    },
  };
}

/** Edits the text of the files whose URL matches `glob` (CDP's wildcards: * and ?) on their way into the page. */
export function rewrite(glob, edit) {
  const re = new RegExp(`^${glob.split('*').map((part) => part.split('?').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`);
  return {
    patterns: [{ urlPattern: glob, requestStage: 'Response' }],
    match: (url, stage) => stage === 'response' && re.test(url),
    response: (_req, body) => edit(body),
  };
}
