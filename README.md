# The Funfair — a 3D theme park in the browser

Walk around a low-poly funfair at dusk as a fully animated visitor:

| Attraction | What it is |
| --- | --- |
| 🎪 Entrance + physical letters | Knock over the giant **FUNFAIR** letters (Bruno Simon style) |
| 🎢 Thunder Loop | A launched steel coaster **you drive**: throttle, brakes and turbo, real physics (roll back if you're too slow), loop, zero-g roll, airtime hill, helix and tunnel |
| 🦅 Sky Falcon | A 4.25 km cliff coaster modelled on Falcons Flight: 158 m drop at 90°, 250 km/h |
| 🚀 Rocket Ride | Countdown, lift-off, stage separation: fire six stages up to orbit |
| 🥫 Crate Smash | 22 physics crates worth 10, 25 or 50 points; ram them for a high score |
| 🔔 High Striker | Timing mini-game: swing the hammer and ring the bell |
| 🦆 Duck Shoot | A shooting gallery on the Midway: 30 seconds with a cork gun to knock down tin ducks gliding along three rails (and the odd golden one) |
| 🎡 Giant Wheel | A full-size tribute to Ain Dubai, the tallest observation wheel on Earth: 250 m tall, 48 capsules, 192 cable spokes, four 126 m legs. Ride it from inside a capsule (time-lapse of the real 38-minute turn) |
| 🏎️ Turbo Speedway | Kart racing: three laps against three rivals on a circuit outside the south-west fence, with cones, hay bales, tyre stacks, oil slicks and boost pads laid out fresh every race |
| 🚙 Rally Trail | A buggy time trial on a dirt loop outside the south fence (after the circuit in Bruno Simon's portfolio): whoops, a big jump, water, mud, crate walls, a spinner and a table-top, with a ghost of your best run and a **daily leaderboard** that starts again every day at 12:00 Beirut time |
| 🌀 Sky Flip | A giant swing that goes right over the top, head over heels 125 m up |
| 🛸 Nebula 360 | A looping pendulum ship, after the 360° rides at travelling fairs |
| 🚁 Drone Flights | Rent a camera drone and fly over the whole fair |
| 🎟️ Ticket Booth | Park guide |
| 🏛️ Career Museum | Hasan Hmedeh's CV as a walk-in gallery at the end of the East Avenue: a framed picture per job, project and achievement, year by year from 2019 to today, and a guided tour. Free |

## The park's layout

The park is a round lawn 280 m across inside a fence (`PARK` in `apps/web/src/world/layout.ts`), laid out like a wheel so it's easy to find your way round:

- **The Hub**, at the centre, round the carousel. Four straight avenues lead out of it: **Main Street** south to the entrance plaza (lined with striped shops and string lights), **North Avenue** to the north gate and on down the road to the Giant Wheel, and the **East** and **West Avenues**, ending at the Career Museum's door and the Thunder Loop's station.
- **The Promenade**, an octagonal loop round the park's heart, passes every district's plaza. Each district has its own colour, set into the paving of its plaza, on a tall sign naming it and its attractions, on the fingerposts at the main crossings, and on the park map, whose legend lists the places district by district.

| District | Where | What's there |
| --- | --- | --- |
| 🎪 Main Gate | south | the entrance plaza and the FUNFAIR letters, the Ticket Booth, the Idea Box |
| 🎯 The Midway | south-east | the games' alley off the Promenade: Crate Smash, the High Striker and the Duck Shoot, ending at the Sky Falcon's station |
| 🦅 Falcon Gate | east | the Career Museum, and the Sky Falcon's station by the east fence (the Falcon Walk leads down to it from the Promenade) |
| 🚀 Cosmos | north | the Cosmic Way, with the Rocket Ride and the Nebula 360; Drone Flights by North Avenue; the Giant Wheel out of the north gate |
| 🎢 Thrill Ridge | west | the Thunder Loop and the Sky Flip |
| 🏁 Motor Town | south-west | the kart garage and, down the Rally Lane, the Rally Trail's shed (their circuits lie outside the fence) |

Lamps line every path at even spacing, avenues of trees line North Avenue and the East and West Avenues, groves fill the gardens between the paths and a green belt runs inside the fence. Scenery lays itself out from the paths and from each attraction's footprint (`FOOTPRINTS`), so moving an attraction in `LAYOUT` moves its trigger ring, its queue and the space kept clear round it too. The rides outside the fence are placed the same way: each coaster's track starts where `LAYOUT.coaster` / `LAYOUT.falcon` puts its station, and `LAYOUT.circuit` moves the kart circuit (the Rally Trail stays where it is: its ghost runs are kept in world coordinates).

Stack: **Vite + TypeScript + Three.js + cannon-es + postprocessing + N8AO** for the game, **NestJS + Prisma + PostgreSQL** for accounts, in a **pnpm + Turborepo** monorepo. The world is built procedurally and all sound is synthesized with WebAudio; the one model file is the visitor, "Casual Character" by [Quaternius](https://quaternius.com) (CC0, from [Poly Pizza](https://poly.pizza/m/kZ3DmIoGip)).

## Accounts, tickets & rides

Anyone can walk in as a guest and explore the park, knock over the letters and visit the Ticket Booth. **Every attraction needs tickets, and tickets need a free account.**

- **Ticket counter:** the 🎟️ Ticket Booth hands out packs of **20 tickets**, free for now. A pack is added to whatever you have left. You can take **one every 5 hours**, counted from your last purchase (skipped windows don't stack up).
- **The booth's shop:** press `E` at the booth to step up to the counter. The camera moves to **Rosa**, the vendor behind the kiosk window, who chats as you browse and buy, and the shop opens beside her with three aisles: **🎟️ Tickets** (the free pack, a countdown to the next, prices and your history), **🍭 Treats**, eaten on the spot (🍭 Cotton Candy: run 40% faster for 3 min · 🍿 Popcorn: kicks twice as hard for 3 min · 🥤 Fizzy Soda: +60 s on your next drone flight · 🍎 Candy Apple: just tasty), and **🎈 Souvenirs**, kept forever and worn round the fair (🎩 Top Hat, 🧢 Fair Cap, 🕶️ Star Shades, 🎈 Balloon, 👆 Foam Finger; one per spot). Everything is paid for in tickets; the catalog is `apps/api/src/shop/catalog.ts`.
- **Prices:** every ride and game costs **1 ticket**; the **Giant Wheel** and **Sky Falcon** cost **5**. Prices, the pack size and the cooldown are database rows, changed in The Ringmaster's Office without a deploy.
- **One round per ticket:** boarding spends the tickets, the attraction runs one round and ends on its own (leaving early still uses the ticket), and a results screen shows that round's statistics with personal bests. Riding again costs another ticket.
- **💡 The Idea Box:** a kiosk with a giant light bulb on the entrance plaza's west side. Press `E` and a sheet opens beside it: pick what the idea is about (rides & games, treats & souvenirs, the park, something wrong, something else), write up to 500 characters and post it (an envelope flies into the slot). **My ideas** lists everything the member has shared, with where each one stands (waiting → accepted → in development → done, or declined) and staff's answer. When staff answer, a card pops up in the fair straight away ("Staff answered your idea"), and the kiosk opens on the news. Members only; up to 5 ideas a day.
- **Saved per user:** every purchase and every round, with its statistics. Players can delete their account from the account menu in the HUD; a copy of their data is given on request by email.
- **Terms & privacy:** signing up requires accepting the [Terms of Service](apps/web/terms.html) and [Privacy Policy](apps/web/privacy.html) (served at `/terms` and `/privacy`).

## The Ringmaster's Office (staff)

The fair's back office lives at **`/ringmaster`**. Staff log in with their normal fair account; their account card in the game links to it.

- **📊 Overview:** members, active players, rounds, completion rate, tickets handed out, spent and still in wallets. Charts of rounds, players and signups per day, and rounds by hour. Per-attraction numbers (rounds, players, finish rate, average round length), top players and park records. Look back over 7, 30 or 90 days (UTC).
- **🚙 Rally Trail:** the trail's daily leaderboards. Today's board (each driver's fastest run, the gap to first, how many runs they made) with the time left until the next one; any earlier board, from a picker or the history table (who won each of the last 30 days, the best time, drivers and runs); runs and drivers per board, the average and median run, rounds started and finished, and the trail record. **Disqualify** a time that looks impossible (it comes off the board for everyone at once, and the driver's next-best run takes its place) or put it back; both land in the logbook. Boards are never deleted: the noon turnover just starts a new, empty one.
- **🎢 Attractions:** set each one's price, or switch it to **under maintenance** with an optional sign. Players see roadworks at it, a red ring, an "Under maintenance" label and the sign, and can't board. Anyone playing it when it closes is stopped and shown the sign, with the round's tickets refunded (closing the park does the same everywhere). Staff still can ride, to test it.
- **🍭 Shop:** set the price of each treat and souvenir at the Ticket Booth, and how many are in stock (or no limit). Each order takes one; at 0 it's sold out, and players see "Only 3 left!" and "Sold out" on the shelf as it happens. Quick +10 / +50 buttons for restocking, and how many of each have sold.
- **💡 Ideas:** what members left at the Idea Box, filtered by status (with counts; the tab's badge shows how many are waiting). Answer each suggestion **once** (a confirmation says so: the answer can't be changed afterwards) and set its status (waiting, accepted, in development, done, declined) as often as it moves along. The member sees both at once, live if they're in the fair. Two staff answering at the same moment can't both get through.
- **🚧 Park gates:** close the whole park with a sign on the gate (visitors can still walk around, but nobody can board or pick up tickets). Separately, put the park **under maintenance** with its own sign: nobody but staff can come into the fair at all, visitors already inside are sent back to the entrance (any round in progress is stopped and refunded), and the way in reopens by itself when it's switched off. Set the pack size and the hours between packs.
- **🔒 Private access** (in Park gates): make the whole site reachable only from a list of IP addresses (or CIDR ranges like `203.0.113.0/24`), each with an optional label. Turning it on adds **your own address automatically** (for IPv6, your network's `/64`, since devices rotate their IPv6 address within it), so you can't shut yourself out; the office also refuses to remove the last entry that lets you in. Everyone else, staff included, gets a "private" page instead of the game, the office and the API, and anyone already in the fair is turned out at once. Locked out anyway (say your home IP changed)? Switch `allowlist_only` off in `park_settings` with `pnpm studio:prod`.
- **👥 Members:** search, set a balance, reset the pack cooldown, make someone staff or a player again, delete an account.
- **🎟️ Ledger / 📜 Logbook:** every round and pack; every change made by staff, with before and after.

Changes reach players **live**, within a second: the game keeps a stream open to `GET /api/live`, which pushes the park (gates, maintenance, prices, pack rules) to everyone, and a member's own balance, role, cooldown or deletion to that member. If the stream can't connect, the game falls back to re-checking the gates every 60 s. It works the other way round too: the office keeps the same stream open, and what players do in the fair (signups, deleted accounts, packs, rounds and refunds) and what other staff change refreshes the view on screen within a couple of seconds (a **● Live** dot in the header shows it's connected, with the number of players in the fair right now; hover it for members, guests and visitors still at the entrance). A form someone is editing is never refreshed under them. Changes made outside the office (Prisma Studio, the `staff:*` scripts) aren't pushed; players pick them up the next time the game asks. To appoint the first member of staff, sign up in the fair, then:

```bash
pnpm staff:appoint you@example.com           # local database (apps/api/.env)
pnpm staff:appoint you@example.com --prod    # production (apps/api/.env.production, like studio:prod)
pnpm staff:list                              # who is staff; staff:dismiss <email> undoes it
```

The rules are enforced on the server, not just in the page: the balance, the 5-hour cooldown and ticket spending are atomic database updates, so double clicks or parallel requests can't buy twice or overspend. Round statistics are reported by the browser, so they're for fun, not for anything valuable. The session is an httpOnly cookie, so the page never sees the token. If the API is down, the fair still opens for guests.

## Run it

### Prerequisites

- **Node.js 24+**
- **pnpm 12** (the exact version is pinned in the root `package.json`)
- **PostgreSQL 16** running locally (or anywhere you can reach)

### One command

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs Turborepo, which in order:

1. creates `apps/api/.env` from `apps/api/.env.example` on the first run, with a freshly generated `JWT_SECRET` (an existing `.env` is never touched),
2. generates the Prisma client,
3. applies the database migrations (creating the database if it doesn't exist yet),
4. starts the API on **http://localhost:3000** (`nest start --watch`) and the game on **http://localhost:5173** (Vite), and opens the browser. Set `BROWSER=none` to skip that.

The Vite dev server proxies `/api` to the API, so the browser stays on one origin and the session cookie just works.

### Settings

The API reads `apps/api/.env` (variables set in the real environment win). The defaults expect PostgreSQL at `postgresql://postgres:postgres@localhost:5432/funfair`. If yours is different, edit `DATABASE_URL` and run `pnpm dev` again. To set it up by hand instead:

```bash
cp apps/api/.env.example apps/api/.env
# then set DATABASE_URL to your Postgres, and JWT_SECRET to a long random string:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs the session cookie: at least 32 characters. Changing it signs everyone out |
| `PORT` | API port (default 3000; the Vite proxy expects 3000) |
| `WEB_ORIGIN` | Comma-separated origins allowed to call the API cross-site with cookies (default `http://localhost:5173`) |
| `NODE_ENV` | `development`, `production` or `test`. In production the cookie is marked `Secure` |
| `TRUST_PROXY` | Optional Express "trust proxy" value (default `loopback`), so rate limits see the visitor's real IP behind a proxy |

If something is missing or wrong, the API lists every problem at startup and exits.

**Private access on Vercel.** The pages are served by the CDN, so `apps/web/middleware.js` (Vercel Routing Middleware, Node.js runtime) checks the allowlist before each one, reading `DATABASE_URL` like the API functions do. It and the API both take the visitor's address from `x-real-ip`, which Vercel sets and won't let the browser override. Elsewhere the API uses Express's `req.ip`, so set `TRUST_PROXY` to match your proxy. In local dev (Vite, no middleware) only the API is guarded: the game and the office show the private sign as soon as the API turns them away.

### Other scripts

Run from the repo root:

```bash
pnpm build                                  # type-check + production builds (apps/web/dist, apps/api/dist), cached by Turborepo
pnpm typecheck                              # type-check both apps
pnpm --filter @funfair/api db:migrate       # after editing prisma/schema.prisma: write and apply a migration (add --name <change>)
pnpm --filter @funfair/api db:generate      # regenerate the Prisma client (pnpm dev/build/typecheck do this for you)
pnpm studio:dev                             # Prisma Studio on the local database (apps/api/.env), port 5555
pnpm studio:prod                            # Prisma Studio on production (apps/api/.env.production), port 5556
pnpm staff:appoint <email> [--prod]         # make an account staff (opens /ringmaster); staff:dismiss, staff:list
pnpm db:snapshot [--prod]                   # save the park's setup (gates, prices, maintenance signs, shop) to apps/api/prisma/seed.json
pnpm db:seed [--prod]                       # write apps/api/prisma/seed.json back, e.g. after a database reset (also `prisma db seed`)
pnpm --filter @funfair/web preview          # serve the web production build
```

## Repository layout

```
apps/web/        the game: Vite + TypeScript + Three.js (package @funfair/web)
apps/api/        accounts and ride tickets: NestJS + Prisma + PostgreSQL (package @funfair/api)
turbo.json       the task pipeline: env:init → db:generate / db:deploy → dev, build, typecheck
package.json     root scripts: pnpm dev | build | typecheck
```

```
apps/api/
  prisma/schema.prisma      users, ticket_purchases, ride_rounds, trail_runs, attraction_settings, park_settings, admin_actions; migrations/ next to it
  prisma.config.ts          Prisma CLI config: loads apps/api/.env
  scripts/init-env.mjs      creates .env on the first `pnpm dev`
  scripts/staff.mjs         pnpm staff:appoint | dismiss | list
  scripts/seed.mjs          pnpm db:snapshot | db:seed: the park's setup, kept in prisma/seed.json
  src/main.ts               /api prefix, cookies, validation, CORS
  src/config/env.ts         validates the environment at startup
  src/auth/                 signup (terms), login, logout, me, account deletion; scrypt passwords, JWT session cookie, rate limits
  src/park/                 the live rules (prices, open/closed, maintenance, pack rules) and GET /api/park
  src/access/               private access: the IP allowlist, the global guard on every route, and the check the page middleware uses
  src/live/                 GET /api/live: the office's changes pushed to the game (Server-Sent Events over Postgres LISTEN/NOTIFY)
  src/tickets/              ticket balance, packs, cooldown, purchase history
  src/rides/                attractions + default costs, boarding (spends tickets), rounds and their stats
  src/trail/                the Rally Trail's daily leaderboard: board days (noon to noon, Beirut time), runs, rankings
  src/suggestions/          the Idea Box: members' suggestions, and staff's answers (answered in src/ringmaster/)
  src/ringmaster/           The Ringmaster's Office API: analytics, attractions, park gates, shop, ideas, members, ledger, logbook (staff only)
  src/health/               GET /api/health
  src/generated/prisma/     the generated client (not committed)
```

## API

Every route is under `/api`. While private access is on, every route but `/api/health` answers **403** `{ code: 'ip_blocked', ip }` to an address that isn't on the list (staff too: it goes by address). The session is an httpOnly, `SameSite=Lax` cookie named `funfair_session` holding a 30-day JWT. Errors use Nest's usual body, `{ statusCode, message, error }`, where `message` is a string or, for validation errors, a list of strings.

| Method | Path | Auth | Answers |
| --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | | Body `{ email, username, password, acceptTerms: true }` → **201** `{ user }` and sets the cookie. Username: 3–20 letters, digits or `_`, unique ignoring case. Password: 8–72 characters. **409** if the email or username is taken, **400** if invalid or the terms aren't accepted |
| `POST` | `/api/auth/login` | | Body `{ email, password }` → **200** `{ user }` and sets the cookie. **401** `Wrong email or password` |
| `POST` | `/api/auth/logout` | | **204**, clears the cookie |
| `GET` | `/api/auth/me` | ✔ | **200** `{ user }`, or **401** |
| `DELETE` | `/api/auth/me` | ✔ | Body `{ password }` → **204**, deletes the account and all its data. **401** `Wrong password` |
| `GET` | `/api/tickets` | ✔ | **200** `{ balance, packSize, cooldownHours, ticketCap, lastPurchaseAt, nextPurchaseAt, canBuy, costs }` |
| `GET` | `/api/shop` | | **200** `{ items }`: the booth's catalog (id, kind, name, icon, tickets, blurb, perk/minutes or slot), at today's prices, with `stock` (how many are left; `null` for no limit) |
| `GET` | `/api/shop/orders?limit=` | ✔ | **200** `{ orders, total }`: the member's own treats and souvenirs bought, newest first (shown on their account card) |
| `GET` | `/api/shop/souvenirs` | ✔ | **200** `{ souvenirs }`: what the member owns, and whether they're wearing it |
| `POST` | `/api/shop/buy` | ✔ | Body `{ item }` → **200** `{ balance, order, souvenirs }` (a new souvenir is worn straight away). **402** `{ needed, balance }` when short, **409** for a souvenir already owned, **409** `{ code: 'sold_out' }` when none are left, **503** while the park is closed |
| `PATCH` | `/api/shop/souvenirs/:item` | ✔ | Body `{ equipped }` → **200** `{ souvenirs }` (putting one on takes off whatever shares its spot) |
| `POST` | `/api/tickets/purchase` | ✔ | **201** `{ balance, purchase, nextPurchaseAt, canBuy }`; under a `ticketCap` the pack only tops the balance up to it. **409** with `nextPurchaseAt` during the cooldown, **409** `{ code: 'ticket_cap', ticketCap, balance }` when already at the cap, **503** `code: 'park_closed'` while the park is closed |
| `GET` | `/api/tickets/purchases` | ✔ | **200** `{ purchases }`, newest first (`?limit=`, default 50) |
| `POST` | `/api/rides/:ride/board` | ✔ | Spends the tickets and opens a round: **201** `{ round: { id, ride, ticketsSpent, startedAt }, balance }`. **402** `{ needed, balance }` when short, **503** `code: 'park_closed'` or `'ride_closed'` while the park or the attraction is closed (not for staff), **401** for guests, **400** for an unknown attraction |
| `POST` | `/api/rides/rounds/:id/finish` | ✔ | Body `{ completed, stats }` (up to 16 numeric stats) → **200** `{ round, history: { rounds, best } }`, where `best` is the min/max of each stat over earlier completed rounds. A completed Rally Trail round with a believable `runTimeS` (at least 25 s, and no longer than the round itself lasted) also goes on today's leaderboard, and the answer carries `trail: { day, timeMs, bestMs, rank, players, improved, resetsAt }`. **409** if already finished, **404** if not yours |
| `POST` | `/api/rides/rounds/:id/refund` | ✔ | Ends a round whose attraction (or the park) closed while it was played, and gives its tickets back → **200** `{ refunded, balance }`. The round is kept as abandoned, costing 0. **409** if it's open again, already over, older than an hour, or the caller is staff; **404** if not yours |
| `GET` | `/api/rides/stats` | ✔ | **200** `{ totalRounds, ticketsSpent, byRide }`, with every attraction listed |
| `GET` | `/api/rides/history` | ✔ | **200** `{ rounds }`, newest first (`?limit=`, default 20) |
| `GET` | `/api/suggestions` | ✔ | **200** `{ suggestions, total, unread }`: the member's own suggestions (latest 50), newest first, each `{ id, topic, message, status, statusChangedAt, reply, repliedAt, repliedBy, unread, createdAt }`; `unread` counts those with news from staff |
| `POST` | `/api/suggestions` | ✔ | Body `{ topic, message }` (`topic`: `attraction`, `shop`, `park`, `problem` or `other`; `message`: 1–500 characters) → **201** the suggestion. **429** `{ code: 'suggestion_limit', nextAt }` after 5 in 24 hours |
| `POST` | `/api/suggestions/seen` | ✔ | **204**: the member has read staff's news (nothing is `unread` any more) |
| `GET` | `/api/trail/leaderboard` | | **200** `{ day, startsAt, resetsAt, timeZone, resetHour, players, runs, entries, me }`: today's Rally Trail board (noon to noon, Beirut time; `day` is the date it opened). `entries` is the top ten, each `{ rank, username, timeMs, at }`; with a session, `me` is the caller's own place wherever it is (and their row is marked `me: true`) |
| `GET` | `/api/park` | | **200** `{ open, message, underMaintenance, maintenanceMessage, costs, packSize, cooldownHours, ticketCap, maintenance }`, where `maintenance` maps each closed attraction to its sign and `underMaintenance` keeps everyone but staff out of the fair |
| `GET` | `/api/live` | | **200** `text/event-stream`: a `park` event (as `GET /api/park`) on connect and on every change made in the office; with a session, also `account` events `{ balance, role, lastPurchaseAt }` or `{ deleted: true }`; `suggestions` events when staff answer one of the member's suggestions (the game then fetches `GET /api/suggestions`); `leaderboard` events when a Rally Trail time goes on (or comes off) today's board (the game then fetches `GET /api/trail/leaderboard`); for staff, also `office` events `{ kinds }` (`members`, `purchases`, `rounds`, `logbook`, `visitors`, `suggestions`, `access`, `trail`: what changed, never who), at most one a second; and a `blocked` event `{ message, ip }`, then the stream closes, when private access turns this address away. Closed after 4 minutes; the browser reconnects |
| `GET` | `/api/ringmaster/visitors` | staff | **200** `{ inFair, members, guests, atEntrance }`: game tabs connected to `/api/live` in the last minute (a member counts once however many tabs they have open) |
| `GET` | `/api/health` | | **200** `{ ok: true, db: 'up' }`, or **503** if the database is unreachable |
| | `/api/ringmaster/*` | staff | The office: `GET overview?days=7\|30\|90`, `GET`/`PATCH park`, `GET attractions`, `PATCH attractions/:ride` `{ tickets?, open?, closedMessage? }`, `GET shop`, `PATCH shop/:item` `{ tickets?, stock? }` (`stock: null` for no limit), `GET users?q=&limit=&offset=`, `GET`/`PATCH`/`DELETE users/:id`, `GET purchases`, `GET rounds?ride=`, `GET suggestions?status=&limit=&offset=` (→ `{ suggestions, total, counts }`), `PATCH suggestions/:id` `{ status?, reply? }` (the reply only once: **409** if it has one), `GET trail?day=YYYY-MM-DD` (one of the Rally Trail's boards, today's without `day`: `{ day, startsAt, endsAt, current, board, disqualified, stats, record, daily }`), `PATCH trail/runs/:id` `{ disqualified }` (take a run off its board, or put it back), `GET access` (→ `{ enabled, entries, you: { ip, allowed } }`), `PATCH access` `{ enabled }` (switching on adds the caller's address), `POST access/ips` `{ ip, label? }`, `DELETE access/ips/:id` (**409** for the last entry letting the caller in while it's on), `GET actions`. **401** for guests, **403** for players |

`user` is `{ id, email, username, role, createdAt }` (`role` is `player` or `admin`, i.e. staff). Attraction ids are `coaster`, `falcon`, `rocket`, `ferris`, `flip`, `ship`, `speedway`, `trail`, `drone`, `crates`, `striker` and `ducks`. Prices, maintenance, the pack size and the cooldown are rows in `attraction_settings` and `park_settings`; the defaults for a missing row live in `apps/api/src/rides/attractions.ts`. Signup, login and account deletion are each limited to 10 requests a minute per IP (**429**, with `Retry-After`).

## The coaster

The track is built like in real coaster-design tools (`apps/web/src/world/attractions/track.ts`). It's a list of elements (straights, clothoid-eased banked turns, hills, a teardrop loop, a heartline roll, a helix) that a turtle integrates into a heartline. The rails hang below it, so inversions rotate around the riders. A Hermite connector closes the circuit.

- **Physics** (`stepRide`): gravity along the track, driver motors (`W`), brakes (`S`), turbo (`Shift`), an automatic launch, station tyres, trim brakes, drag and rolling resistance. Coasting does a lap in ~35 s at up to 83 km/h, with −1 to 5.5 G and under 1.5 G sideways. Full throttle laps in ~15 s.
- **Cameras** (`C`, or the E button on touch): Driver (the horizon rolls with the track), Chase, and Trackside.
- **HUD**: speed, live G-meter (grey-out/red-out vignette at extreme G), lap timer and best lap (kept in the browser).
- A ghost train runs laps when nobody is riding.
- To change the layout, edit `LAYOUT_ELEMENTS`. Keep the end of the element list close to the station, because the closing connector fills the gap. Re-check self-intersections and ground clearance after changes.

## Sky Falcon (the mega-coaster)

A tribute to Falcon's Flight, the record-breaking cliff coaster at Six Flags Qiddiya near Riyadh. Board it from the 🦅 station in Falcon Gate, by the east fence: take the Falcon Walk down from the Promenade, or walk to the end of the Midway.

- **4,247 m of track** (`apps/web/src/world/attractions/falcon-track.ts`), laid out from the real ride's published stats and checked against a front-row POV video (4,250 m, 250 km/h, 158 m drop at 90°, 163 m hill, no inversions). Dispatch turns right onto a 39 km/h LSM lift, then a twisted drop, airtime hills and an overbanked turn near the giant hill. A **160 km/h LSM launch** fires the train up the cliff; a slow, twisting clifftop section leads to the edge. The train then drops **158 m at 90° down a channel cut into the cliff**, straight into a **keyhole tunnel portal** with a sunburst frame. An LSM launch out of the tunnel fires it at the park at **250 km/h**, over the **163 m hill on its lattice tower**, back up into a high overbanked turn, through a dive, a wave turn and airtime hills, under the overbanked turn, and along the park's edge to the brakes. Turn radii and hill shapes are fitted to the park; the exact plan isn't public.
- **Trackside scenery** (`apps/web/src/world/trackside.ts`): trees, shrubs, rocks and red-banded marker posts line the Falcon wherever it runs close to the ground, so you can feel the speed.
- **The mountain** (`apps/web/src/world/mountain.ts`) is generated from the track: a sandstone table mountain with strata, a sheer wall behind the drop, a ridge carrying the launch up the cliff, a narrow channel the drop falls down, the keyhole portal and the rock that buries the tunnel, and an earth embankment that brings the track down to the desert. Every other part of the track is guaranteed to clear the rock. The strata are painted in the shader from world height.
- Same driving controls, cameras and HUD as Thunder Loop. Both coasters share one physics model (`stepRide`) with per-ride tuning (`FALCON_PHYS`). Its trees, fence posts and support columns keep clear of both tracks (`apps/web/src/world/rides.ts`).
- A coasting lap takes ~170 s, peaking at 250 km/h with −1.6 to 4.7 G and up to 2.1 G sideways. Trains have four cars and a single-row lead car, for 14 riders.

## Turbo Speedway (kart racing)

Walk to Motor Town (west along the Promenade from Main Street) to the kart garage and press `E`. You start at the back of a four-kart grid; three red lights, then green.

- **The circuit** (`apps/web/src/world/attractions/speedway-track.ts`): a 472 m clockwise loop on the lawn outside the fence: a long main straight past the grandstand, a sweeping right-hander, a dip into the infield, an S and a long right-hander home. It's a Catmull-Rom spline through control points laid out in a frame facing the park, sampled every metre with its curvature. Red-and-white kerbs mark every corner, gravel traps sit on their outsides, and tyre walls line both sides 10 m from the centre line. Trees and the horizon hills keep clear of it.
- **Obstacles** (laid out again for every race, never on the grid or the run to turn one): 🟧 cones (lane closures, slaloms and gates) that go flying when you hit them; hay bales and tyre stacks that stop you dead; oil slicks that spin you round; and ⚡ boost pads. Bales, tyre stacks and oil only go on the gentler stretches, never on a corner's apex.
- **Driving** (`Speedway.step`): arcade physics. Engine and brakes act along the nose, steering yaw falls off with speed, and grip bleeds off sideways speed: less of it on grass, under the handbrake (`Space`, for drifting) or on oil. `W`/`S` drive and brake (and reverse), `A`/`D` steer, `Shift` fires the nitro (it refills slowly, and boost pads top it up), `R` puts you back on track, `C` cycles Chase / Driver / High cameras.
- **The rivals** drive the same karts. They follow a speed profile worked out from the curvature (with braking zones), steer by pure pursuit, and pick a lane round the next block of obstacles (the wider gap, and one that also clears whatever comes next). They skip boost pads that would fire them into a bend, and they're rubber-banded a little toward you. While nobody's racing, all four karts lap the circuit as a ghost race you can watch from the park.
- **HUD**: position, lap, nitro, race time, best lap, speed and live standings. Your best race, best lap and wins are kept in the browser.

## Rally Trail (time trial and daily leaderboard)

Take the Rally Lane south from the Promenade in Motor Town to the trail's shed and press `E` (its card, with today's top ten, opens as you step into the ring). It's a time trial in a bouncy dune buggy, after the circuit in [Bruno Simon's portfolio](https://bruno-simon.com): one lap against the clock, from the start lights to the line.

- **The trail** (`apps/web/src/world/attractions/trail-track.ts`): a 547 m clockwise dirt loop on the meadow outside the park's south fence, a Catmull-Rom spline through control points in world coordinates, fenced 8.5 m either side of the centre line. The layout never changes, so every time compares. In order: crate pyramids on the start straight; a ⚡ boost out of the first sweep into the **whoops** (rounded bumps to skip over) and the **big jump** (a kicker, a gap and a landing ramp: too slow and you case the landing); checkpoint 1; a **water splash**; **mud** on the inside of the long bottom bend; a slalom of cones; checkpoint 2; two **crate walls** to smash or weave through; the **spinner** (a striped bar sweeping round on a post in the middle of the trail); the hairpin; checkpoint 3 and a boost; three **logs** and a **table-top**; and a last boost to the line. The ground's shape (jumps, whoops, logs, table-top) is a height profile along the centre line, and the dirt ribbon is built from it.
- **Driving** (`Trail.step`): the speedway's arcade model (engine, brakes, speed-dependent steering, grip that bleeds off sideways speed, a handbrake slide on `Space`) with grip and top speed per surface (dirt, grass, mud, water), a nitro tank on `Shift`, and the vertical. The body rides on springs over the ground averaged under its axles (a log gives a little hop, three times), takes off when the ground falls away faster than gravity can follow, and lands with a thump (too hard and you're stunned). Crates, barrels and cones go flying, a crate pyramid all at once; hay bales don't budge; flying over something clears it. `R` puts you back on the trail where you are, `T` (or the HUD's button) starts the run again from the grid (the ticket covers that, until you cross the line), and `C` cycles Chase / Far / Hood cameras.
- **Splits and the ghost:** each checkpoint shows your time there against your best run's (green ahead, red behind), and a see-through buggy drives your best run beside you. Both are kept in the browser (`fair-trail`, `fair-trail-ghost`) and dropped if the trail's layout changes.
- **The daily leaderboard** (`apps/api/src/trail/`): a run that crosses the line is kept in `trail_runs` with the board day it counts for. A board runs from **12:00 to 12:00, Beirut time** (`board-day.ts`, clock changes included) and is named for the date it opened. A player's place is their fastest run on the board, ties going to whoever set it first. **Nothing is deleted at the turnover**: today's board is just today's runs, so a new one starts empty at noon and every earlier board stays in the database (staff see them in The Ringmaster's Office). Times are measured in the browser, so the server only takes a time of at least 25 s and no longer than its round lasted, and staff can disqualify one. Today's top ten is on two boards (by the shed, and at the start line), on the trail's card in the park, in its HUD, and on the results screen (your place, out of how many). All of them update live when someone posts a time, and turn over by themselves at noon.
- **HUD**: the clock to the hundredth, checkpoints passed, the split, nitro, your best and your place today, speed, today's top ten with the time to the next board, and the restart button. While nobody's driving, a demo buggy laps the trail.

## Career Museum (free)

A gallery hall under a glass roof, at the end of the East Avenue in Falcon Gate (`apps/web/src/world/attractions/museum.ts`). Hasan Hmedeh's CV hangs down both walls in order, one framed print per job, project or achievement, zig-zagging from the door (2019) to the end wall (today). A banner over the aisle and a gold bar on the red carpet mark where each year starts; each print shows its dates (with months), the year, a picture, the title and who it was for. The **Toolbox** on the end wall has every skill on the CV, and the languages. No ticket needed.

- **Walk in** and look around: the follow camera stays inside the hall (it slides in toward the visitor rather than through a wall). Step up to a frame (to its rope) and press `E` to look closer.
- **The guided tour** (`E` on the porch's ring, or at any frame): the visitor steps aside, the camera glides to the frame and a sheet beside it tells its story (`apps/web/src/world/gallery.ts`): when, where, what was done, with what, links, and where the picture comes from. `←` / `→` (or `E`, or the buttons) step through the collection, the years along the top jump to where each one starts, `Esc` leaves the tour standing in front of the last frame.
- **The collection** is one data file, `apps/web/src/data/museum.ts`: the years (`SECTIONS`), the profile on the porch's banners, the exhibits (`EXHIBITS`, in the order they hang) and the skills (`SKILLS`). Add an exhibit there and the hall re-hangs itself. Pictures live in `apps/web/public/museum/` (logos are the companies' own, from their sites; the skill icons are from devicon); an exhibit without one, or whose file fails to load, shows a "picture to come" placeholder with its emoji.

## Duck Shoot

A shooting gallery on the Midway (`apps/web/src/world/attractions/ducks.ts`): step up to the counter (`E` in its ring), take the cork gun and you have **30 seconds**. Tin ducks glide along three rails in front of a painted night sky, the higher the rail the faster and the more it's worth (10, 20 and 30 points), and now and then a **golden duck** (50) comes round. A duck you knock down tips back on its hinge and stays down until it comes round again.

- **Aim** with the mouse, or `WASD` / the arrows (the joystick on touch); **fire** with a click, `E` or `Space` (or tap a duck). The gun takes a third of a second to reload; the sight dims meanwhile. The card with how to play goes away with the first shot.
- **Results**: score, ducks down, accuracy, best streak and golden ducks, with personal bests like every other game.

## Graphics

- **Physically based sunset sky** (Preetham scattering with drifting clouds). The same sky is baked into an environment map, so every glossy surface reflects it: clearcoat paint on the rocket and letters, chrome, gilded lettering and metallic coaster rails.
- **HDR pipeline**: scene → N8AO ambient occlusion (half-res) → bloom + ACES filmic tone mapping + vignette (one merged pass) → SMAA. Marquee bulbs, lamps, string lights and engine flames render above 1.0, so they glow through the bloom.
- **Time of day**: the full day/night cycle is built in (`apps/web/src/world/environment.ts`, `apps/web/src/world/time-control.ts`), but for now the park is held at a sunny 16:00 and the clock panel is switched off (`TIME_CONTROLS` in `Game.ts`). Clouds drift across the sky and the sun is a small disc with a soft glow. In development, `?hour=13` jumps to a time.
- **Atmosphere**: fog that blends to orange toward the sun and violet away from it, layered horizon hills, stars that fade in as the rocket reaches space, and fireflies.
- **Living ground**: tens of thousands of instanced grass blades that sway in the wind and part around the visitor. A tiling detail normal map makes the sand and soil catch the low sun. Trees sway too, with soft volumetric foliage shading.
- **Real lights where they matter**: an engine light under the rocket, plus soft light pools under every lamp.

### Performance

- **Quality tiers** (`apps/web/src/world/quality.ts`) are picked from the GPU and device type: high (dedicated GPU), medium (integrated GPU / high-end phone) and low (phones, software rendering). Tiers change AO, SMAA, shadow-map size, grass density/distance, clouds and extra lights. Force one with `?quality=low|medium|high`.
- **Adaptive resolution**: if the frame rate drops below ~48 fps, render resolution scales down (to 55% minimum) and recovers when there's headroom.
- Grass is chunked with distance LOD and frustum culling. Trees, lamps, bulbs and fences are instanced. The light count is fixed at startup, so shaders never recompile mid-ride. AO switches off in space.

## Controls

`WASD`/arrows walk · `Shift` run · `Space` dodge-roll · `F` kick · `E`/`Enter` interact · `H` wave · `R` back to entrance · `M` park map · `I` info · `Esc` exit a ride. Touch devices get a joystick + action button. Mouse wheel zooms.

Info: the guide to the fair, and each ride's intro (its story and controls), open by themselves only the first time this browser meets them. After that they're behind the **ℹ️** button in the top-right corner (or `I`), which shows the guide on foot and the ride's intro while riding, and glows briefly when a ride's intro is there to read again.

Park map: click the minimap (or press `M`) to open a full-screen map. Drag to pan, scroll or pinch to zoom, pick a place on the map or in the legend, then pick it again (or press `Enter`) to fast travel there.

## Deploy (Vercel + Neon)

Everything runs as **one Vercel project**: the game is the static site, and the API runs as a Vercel Function on the same domain (`apps/web/api/index.js` wraps `apps/api/src/serverless.ts`; `apps/web/vercel.json` rewrites `/api/*` to it). One origin means the `SameSite=Lax` session cookie and per-visitor rate limits work exactly as in development.

On each deployment, `apps/web/vercel.json`'s build command runs from the repo root: it applies pending Prisma migrations (`db:deploy`), then builds the API (`nest build`) and the site. Functions run in Frankfurt (`fra1`), next to the database.

### Set up

1. **Project:** in Vercel, import the GitHub repo (or open the existing project for it) and set **Settings → Build and Deployment → Root Directory** to `apps/web`. Leave "Include files outside the root directory" on. Framework, build command and output directory come from `apps/web/vercel.json`.
2. **Database:** **Storage → Create Database → Neon**, region **AWS Frankfurt (eu-central-1)**, and connect it to the project. This sets `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED` (direct, used for migrations). Turn on Neon's preview branches if you want preview deployments to get their own database; otherwise previews migrate and use the production database.
3. **Environment variables** (Settings → Environment Variables):

   | Variable | Value |
   | --- | --- |
   | `JWT_SECRET` | a long random string: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `NODE_ENV` | `production` (makes the session cookie `Secure`) |
   | `WEB_ORIGIN` | your site's origin, e.g. `https://hasanhmedeh.vercel.app` |
   | `TRUST_PROXY` | `true` (Vercel sets the visitor's IP in `X-Forwarded-For`) |
   | `SITE_URL` | your final domain, for canonical URLs, Open Graph tags, `sitemap.xml` and `robots.txt` |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1`, so Vercel uses the pnpm version pinned in the root `package.json` |

4. **Deploy** (push to the production branch, or Redeploy), then check `https://<your-domain>/api/health` answers `{"ok":true,"db":"up"}`.
5. Submit `https://<your-domain>/sitemap.xml` in Google Search Console.

### Notes

- **Rate limits** (signup, login, account deletion) are counted in each function instance's memory, so on serverless they're per instance and looser than locally. Move the counters in `apps/api/src/auth/auth-throttler.guard.ts` to a shared store (e.g. Upstash Redis) if you need them strict.
- **Live updates** (`GET /api/live`) run in their own function, `apps/web/api/live.js`, with a 300 s limit (the API closes each stream after 4 minutes and the browser reconnects); that limit needs Fluid compute on the Hobby plan, which is on by default for new projects. Each API instance holds one Postgres connection for `LISTEN` while visitors are connected, using `DATABASE_URL_UNPOOLED` (set by the Neon integration; Neon's pooled URL can't `LISTEN`). A tab hidden for 30 s drops its stream and reconnects when it's back.
- **Elsewhere:** the API also runs as a normal Node server (`pnpm build --filter=@funfair/api`, `pnpm --filter @funfair/api db:deploy`, `pnpm --filter @funfair/api start`). Put it behind the site's origin with a rewrite of `/api/*`; a separate origin would need cross-site (`SameSite=None`) cookies.

## Content and settings

- Rocket stages and High Striker tiers: `apps/web/src/data/fair.ts`
- The Career Museum's collection (exhibits, years, skills): `apps/web/src/data/museum.ts`, pictures in `apps/web/public/museum/`
- Park layout / zone positions: `apps/web/src/world/layout.ts`: the park's size (`PARK`), where each attraction stands (`LAYOUT`), the districts (`DISTRICTS`: every zone belongs to exactly one, which the map's legend and the guide follow), the paths and plazas. Attraction zone ids must match the `Attraction` enum in `apps/api/prisma/schema.prisma`, `ATTRACTIONS` in `apps/api/src/rides/attractions.ts` and `ATTRACTION_IDS` in `apps/web/src/account/api.ts`; a new attraction also needs a row in `apps/api/prisma/seed.json`
- Colors: `PALETTE` in `apps/web/src/world/textures.ts` and CSS variables in `apps/web/src/styles.css`
- 3D font: `node apps/web/scripts/build-font.mjs` regenerates `apps/web/src/assets/lilita.typeface.json` (add characters to `CHARS` if you need more glyphs in 3D text)
- The page has Open Graph / Twitter cards (`apps/web/public/og-image.jpg`), a web manifest and icons; `sitemap.xml` and `robots.txt` are generated during the build. The 3D world is code-split and loads after the intro card has rendered.

## Game structure

All paths are under `apps/web/`:

```
index.html              page shell + intro card + HUD markup + sign-up dialog
vite.config.ts          site URL, sitemap and robots.txt, /api proxy for dev
src/main.ts             intro card (continue as guest, or sign up / log in), lazy-loads the 3D world
src/account/            api.ts (typed API client), session.ts (who's visiting), auth-dialog.ts, account-menu.ts (HUD chip)
src/data/fair.ts        rocket stages and striker tiers
src/world/Game.ts       renderer, physics, loop, camera modes, interactions, the ride gate
src/world/minimap.ts    corner minimap + the shared top-down painter of the fair
src/world/world-map.ts  full-screen park map: pan, zoom, legend and fast travel
src/world/player.ts     the visitor: walk/run/roll/kick/wave controls and physics on a crowd rig
src/world/crowd/        the park's guests: people.ts (rig, outfits, animation), pets.ts (dogs, leashes),
                        crowd.ts (parties, queues, coaster boarding, benches, kids' play), nav.ts + obstacles.ts (walking)
public/models/guests.glb       "Universal Base Characters" by Quaternius (CC0): bodies + hairstyles
public/models/guest-anims.glb  "Universal Animation Library" by Quaternius (CC0): a curated set of clips
public/models/dog-*.glb        Shiba Inu and Husky by Quaternius (CC0, via Poly Pizza)
src/world/subdivide.ts  rounds off faceted models at load: welds, one Loop subdivision, smooth normals, blended skin weights
src/world/environment.ts sky, lights, ground, trees, lamps, tents, balloons
src/world/layout.ts     the park's plan: its size, where everything stands, the districts, paths and plazas
src/world/wayfinding.ts the districts' signs and the fingerposts
src/world/attractions/  coaster, rocket, crates, striker, ducks (the Duck Shoot), ferris/carousel/booth/arch, speedway (+ speedway-track),
                        trail (+ trail-track), sky-flip, ship (Nebula 360), drone, museum (the Career Museum's hall)
src/world/gallery.ts    the Career Museum's guided tour: the sheet beside each frame
src/data/museum.ts      the museum's collection: the CV's exhibits, years and skills
src/account/leaderboard.ts  the Rally Trail's daily leaderboard as the game shows it (fetched, kept live, turned over at noon)
```

In development, `?cam=x,y,z,lookX,lookY,lookZ` pins the camera (handy for screenshots) and `window.__game` is exposed for debugging; both are stripped from production builds.
