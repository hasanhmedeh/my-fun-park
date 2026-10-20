// A small typed client for the fair's accounts API. The session lives in an httpOnly cookie,
// so every request goes out with credentials and the page never sees the token.
import type { Design, Issue, Part, Parts, RideStats as CoasterStats } from '../workshop/rules';

/** Creators' Valley's plots: each runs the player-built coaster staff released onto it (if any). */
export const PLOT_IDS = ['plot1', 'plot2', 'plot3', 'plot4', 'plot5', 'plot6', 'plot7', 'plot8'] as const;
export type PlotId = (typeof PLOT_IDS)[number];

/**
 * Every attraction that costs tickets (they match the zone ids in world/layout.ts), in the order of
 * the server's enum: the park's, Creators' Valley's plots, then Funfair Air's flight (one round is
 * one flight, gate to gate, either way) and Palm Cay's beach park.
 */
export const ATTRACTION_IDS = [
  'coaster',
  'falcon',
  'rocket',
  'ferris',
  'flip',
  'ship',
  'speedway',
  'trail',
  'drone',
  'crates',
  'striker',
  'ducks',
  ...PLOT_IDS,
  'flight',
  'jetski',
  'slides',
  'cannons',
  'volley',
] as const;
export type AttractionId = (typeof ATTRACTION_IDS)[number];

export const isAttraction = (id: string | null | undefined): id is AttractionId => !!id && (ATTRACTION_IDS as readonly string[]).includes(id);

/**
 * The attractions that are played rather than ridden: the Midway's games, and Palm Cay's jet-ski
 * race, pirate cannons and beach volley. The flight and the water slides are rides ("Ride again"),
 * even though the visitor flies the plane.
 */
export const isGame = (id: AttractionId) =>
  id === 'crates' || id === 'striker' || id === 'ducks' || id === 'jetski' || id === 'cannons' || id === 'volley';

export const isPlot = (id: string | null | undefined): id is PlotId => !!id && (PLOT_IDS as readonly string[]).includes(id);
/** plot3 → 3. */
export const plotNumber = (id: PlotId) => Number(id.slice(4));
export const plotId = (n: number) => `plot${n}` as PlotId;

/** Tickets per round, until the server's own table arrives (GET /tickets sends the live one). */
export const DEFAULT_COSTS: Record<AttractionId, number> = {
  coaster: 1,
  falcon: 5,
  rocket: 1,
  ferris: 5,
  flip: 1,
  ship: 1,
  speedway: 1,
  trail: 1,
  drone: 1,
  crates: 1,
  striker: 1,
  ducks: 1,
  plot1: 1,
  plot2: 1,
  plot3: 1,
  plot4: 1,
  plot5: 1,
  plot6: 1,
  plot7: 1,
  plot8: 1,
  flight: 10,
  jetski: 1,
  slides: 1,
  cannons: 1,
  volley: 1,
};
/** One free pack per purchase, and one purchase per cool-down (until GET /park sends the live rules). */
export const PACK_SIZE = 20;
export const COOLDOWN_HOURS = 5;

/** Staff (`admin`) can open the Ringmaster's Office and can still ride while the park is closed. */
export type Role = 'player' | 'admin';

/** What a member said they are, at signup. */
export type Gender = 'female' | 'male' | 'other' | 'prefer_not_to_say';
export const GENDERS: { id: Gender; label: string }[] = [
  { id: 'female', label: 'Female' },
  { id: 'male', label: 'Male' },
  { id: 'other', label: 'Other' },
  { id: 'prefer_not_to_say', label: 'Prefer not to say' },
];

export interface User {
  id: string;
  email: string;
  username: string;
  createdAt: string;
  /** Missing from an older server: a player. */
  role?: Role;
  /** Null for an account made before signup asked: the game asks after logging in. */
  gender?: Gender | null;
  /** False for an account made with Google (it confirms with its username instead). Missing from an older server: true. */
  hasPassword?: boolean;
  /** Linked to a Google account. */
  google?: boolean;
  /** Null for an account that never accepted the Terms: the game asks after logging in. */
  termsAcceptedAt?: string | null;
}

/** What the member still has to tell us (asked after logging in): nothing, once it's all there. */
export function missingInfo(user: User): { gender: boolean; terms: boolean } | null {
  const gender = user.gender === null;
  const terms = user.termsAcceptedAt === null;
  return gender || terms ? { gender, terms } : null;
}

/** "Continue with Google": the result of a trip there (see apps/api/src/auth/google.controller.ts). */
export type GoogleOutcome = { google: 'login' | 'signup' | 'cancelled' } | { google: 'error'; message: string };

/** GET /park: whether the gates are open, and the rules every visitor sees (guests too). */
export interface Park {
  open: boolean;
  /** Only when closed: what the sign on the gate says (null for the default wording). */
  message: string | null;
  /** The whole park under maintenance: nobody but staff may come into the fair at all (stricter than closed). */
  underMaintenance: boolean;
  /** Only while it is: its sign (null for the default wording). */
  maintenanceMessage: string | null;
  /** Tickets per round; an attraction without a price yet is left out. */
  costs: Partial<Record<AttractionId, number>>;
  packSize: number;
  cooldownHours: number;
  /** The most a free pack tops a balance up to (null for no ceiling). */
  ticketCap: number | null;
  /** Attractions closed for maintenance, each with its sign (null for the default wording). Open ones are left out. */
  maintenance: Partial<Record<AttractionId, string | null>>;
  /** The player-built coasters running in Creators' Valley, by plot. Missing from an older server: none. */
  creations?: ParkCreation[];
}

/** A player-built coaster running on one of Creators' Valley's plots (GET /creations/:id has its design). */
export interface ParkCreation {
  plot: number;
  id: string;
  name: string;
  /** The creator's username. */
  creator: string;
}

// ---------- The Coaster Workshop ----------

/** Where a coaster sent to staff stands. `replaced`: a newer version of it took its plot. */
export type CreationStatus = 'pending' | 'released' | 'declined' | 'removed' | 'replaced';
export const CREATION_STATUSES: readonly CreationStatus[] = ['pending', 'released', 'declined', 'removed', 'replaced'];

/** A coaster part as it sells today (apps/api/src/workshop/workshop.service.ts). */
export interface CoasterPartItem {
  id: Part;
  name: string;
  unit: string;
  icon: string;
  blurb: string;
  tickets: number;
  /** Units left to sell: 0 is sold out, null is no limit. */
  stock: number | null;
}

/** A saved design in the list: what it is, the parts it holds, and its latest submission. */
export interface DesignSummary {
  id: string;
  name: string;
  pieces: number;
  parts: Parts;
  updatedAt: string;
  latest: { id: string; status: CreationStatus; plot: number | null } | null;
}

export interface SavedDesign extends DesignSummary {
  data: Design;
  createdAt: string;
}

/** Everything the Coaster Workshop shows a member. */
export interface Workshop {
  parts: CoasterPartItem[];
  /** Parts the member owns, and how many of them their saved designs hold. */
  owned: Parts;
  held: Parts;
  starterKit: { claimed: boolean; contents: Partial<Parts> };
  /** Free design slots, extra ones bought, how many are in use; extra slots aren't on sale yet. */
  slots: { free: number; extra: number; used: number; extraPriceUsd: number; onSale: boolean };
  submissions: { perDay: number; last24h: number; nextAt: string | null };
  designs: DesignSummary[];
  /** Submissions with news from staff the member hasn't seen. */
  unread: number;
}

/** A coaster the member sent to staff, and what became of it. */
export interface MyCreation {
  id: string;
  designId: string | null;
  name: string;
  status: CreationStatus;
  statusChangedAt: string | null;
  plot: number | null;
  reply: string | null;
  reviewedBy: string | null;
  stats: CoasterStats;
  /** Other guests' rides on it, and the tickets they've earned the member. */
  rides: number;
  earned: number;
  unread: boolean;
  createdAt: string;
}

/** A player-built coaster, enough to build and ride it (GET /creations/:id). */
export interface CreationDetail {
  id: string;
  name: string;
  creator: string;
  status: CreationStatus;
  plot: number | null;
  data: Design;
  stats: CoasterStats;
  hasPicture: boolean;
  createdAt: string;
}

/** A submitted coaster as staff see it in the office's grid. */
export interface AdminCreation {
  id: string;
  name: string;
  user: { id: string; username: string };
  designId: string | null;
  status: CreationStatus;
  statusChangedAt: string | null;
  plot: number | null;
  reply: string | null;
  reviewedBy: string | null;
  stats: CoasterStats;
  mode: Design['mode'];
  cars: number;
  pieces: number;
  hasPicture: boolean;
  createdAt: string;
  releasedAt: string | null;
  removedAt: string | null;
  rides: number;
  earned: number;
  /** Another version of the same design running in the park now: releasing this one can take its plot. */
  live: { id: string; name: string; plot: number } | null;
}

/** One of Creators' Valley's plots, as staff see it. */
export interface AdminPlot {
  plot: number;
  attraction: PlotId;
  creation: { id: string; name: string; creator: string } | null;
  tickets: number;
  open: boolean;
}

/** A coaster part as the office edits it. */
export interface AdminCoasterPart extends CoasterPartItem {
  defaultTickets: number;
  /** Units sold, ever. */
  sold: number;
  updatedAt: string | null;
}

// ---------- The Ticket Booth's shop ----------

export type ShopKind = 'treat' | 'souvenir';
/** Where a souvenir is worn: one at a time per slot. */
export type SouvenirSlot = 'head' | 'face' | 'leftHand' | 'rightHand';
/** What a treat does in the game. */
export type Perk = 'speed' | 'kick' | 'drone';

/** One thing for sale at the booth, for tickets (apps/api/src/shop/catalog.ts). */
export interface ShopItem {
  id: string;
  kind: ShopKind;
  name: string;
  icon: string;
  tickets: number;
  blurb: string;
  perk?: Perk;
  minutes?: number;
  slot?: SouvenirSlot;
  /** How many are left: 0 is sold out, null is no limit. Missing from an older server: no limit. */
  stock?: number | null;
}

/** A souvenir the member owns, and whether they're wearing it. */
export interface Souvenir {
  item: string;
  equipped: boolean;
  acquiredAt: string;
}

export interface ShopOrder {
  id: string;
  item: string;
  ticketsSpent: number;
  balanceAfter: number;
  createdAt: string;
}

// ---------- The Idea Box ----------

/** What a suggestion is about (see account/ideas.ts for the words and icons). */
export type SuggestionTopic = 'attraction' | 'shop' | 'park' | 'problem' | 'other';
/** Where it stands, as staff set it in The Ringmaster's Office. */
export type SuggestionStatus = 'pending' | 'accepted' | 'in_development' | 'done' | 'declined';

/** A suggestion left at the Idea Box, and staff's answer (given once). */
export interface Suggestion {
  id: string;
  topic: SuggestionTopic;
  message: string;
  status: SuggestionStatus;
  statusChangedAt: string | null;
  reply: string | null;
  repliedAt: string | null;
  /** The username of the member of staff who answered. */
  repliedBy: string | null;
  /** Staff answered or changed the status since the member last looked. */
  unread: boolean;
  createdAt: string;
}

/** The most a suggestion (or an answer) can say. */
export const SUGGESTION_MAX = 500;

/** The member's ticket wallet. `nextPurchaseAt` is null when a pack can be bought right now. */
export interface Tickets {
  balance: number;
  packSize: number;
  cooldownHours: number;
  /** The most a pack tops the balance up to (null for no ceiling): at or above it, a pack gives nothing. */
  ticketCap: number | null;
  lastPurchaseAt: string | null;
  nextPurchaseAt: string | null;
  canBuy: boolean;
  costs: Record<AttractionId, number>;
}

export interface Purchase {
  id: string;
  quantity: number;
  priceCents: number;
  currency: string;
  /** Only in the purchase history (GET /tickets/purchases). */
  balanceAfter?: number;
  createdAt: string;
}

/** A round's numbers, keyed as in account/stats.ts. */
export type RoundStats = Record<string, number>;
/** The best value of each stat over the member's earlier completed rounds of one attraction. */
export type Bests = Record<string, { min: number; max: number }>;

export interface Round {
  id: string;
  ride: AttractionId;
  ticketsSpent: number;
  startedAt: string;
  endedAt?: string | null;
  completed?: boolean | null;
  stats?: RoundStats | null;
}

export interface FinishedRound {
  round: Round;
  /** `rounds` counts the completed rounds of this attraction, this one included; `best` leaves it out. */
  history: { rounds: number; best: Bests };
  /** A Rally Trail run that made it onto today's leaderboard: where the member stands now. Missing otherwise. */
  trail?: TrailPlacement;
}

// ---------- The Rally Trail's daily leaderboard ----------

/** One player on a leaderboard: their best time on that board. */
export interface TrailEntry {
  rank: number;
  username: string;
  timeMs: number;
  /** When they set it. */
  at: string;
  /** The member asking. */
  me?: boolean;
}

/**
 * GET /trail/leaderboard: today's board. Boards run from noon to noon in `timeZone` (Beirut), and a
 * new one starts empty at `resetsAt`; the old ones stay on the server.
 */
export interface TrailBoard {
  /** The board's day: the date its noon-to-noon window started on, YYYY-MM-DD. */
  day: string;
  startsAt: string;
  resetsAt: string;
  timeZone: string;
  resetHour: number;
  /** Players with a time on it, and runs finished on it. */
  players: number;
  runs: number;
  /** The top ten. */
  entries: TrailEntry[];
  /** The member asking, wherever they are on it (null without a time today, or for a guest). */
  me: TrailEntry | null;
  /** The server's clock as it answered (countdowns follow it). Missing from an older server. */
  now?: string;
}

/** Where a finished run left the member on today's board. */
export interface TrailPlacement {
  day: string;
  timeMs: number;
  /** The member's best today (this run, or an earlier faster one) and its rank. */
  bestMs: number;
  rank: number;
  players: number;
  /** This run is the member's best on its board. */
  improved: boolean;
  resetsAt: string;
  /** It crossed the line just before noon: it counts on the board that has closed since, not today's. */
  closed?: boolean;
}

export interface AttractionStats {
  rounds: number;
  ticketsSpent: number;
  best: Bests;
  last: { stats: RoundStats | null; endedAt: string } | null;
}

export interface RideStats {
  totalRounds: number;
  ticketsSpent: number;
  byRide: Record<AttractionId, AttractionStats>;
}

// ---------- The Ringmaster's Office (staff only) ----------

/** Who's in the fair right now. Members count once however many tabs they have open. */
export interface Visitors {
  /** Past the entrance: members plus guests. */
  inFair: number;
  members: number;
  guests: number;
  /** Looking at the entrance (the intro card), not in yet. */
  atEntrance: number;
}

/** The park's settings row, as staff see and edit it. */
export interface ParkSettings {
  open: boolean;
  closedMessage: string | null;
  underMaintenance: boolean;
  maintenanceMessage: string | null;
  packSize: number;
  cooldownHours: number;
  /** The most a free pack tops a balance up to; null for no ceiling. */
  ticketCap: number | null;
  updatedAt: string | null;
}

/** One address (or CIDR range) let in while the site is private. */
export interface AllowedIp {
  id: string;
  ip: string;
  label: string | null;
  addedBy: string;
  createdAt: string;
}

/** Private access, as staff see it: only the addresses on the list can reach the site while it's on. */
export interface Access {
  enabled: boolean;
  entries: AllowedIp[];
  /** Where the site sees the caller connecting from, and whether the list lets them in. */
  you: { ip: string | null; allowed: boolean };
}

/** Days the overview can look back over. */
export const OVERVIEW_DAYS = [7, 30, 90] as const;
export type OverviewDays = (typeof OVERVIEW_DAYS)[number];

export interface RideAnalytics {
  rounds: number;
  roundsInRange: number;
  completed: number;
  abandoned: number;
  ticketsSpent: number;
  ticketsSpentInRange: number;
  /** Members who ever played it. */
  players: number;
  /** Average length of a completed round, in seconds. */
  avgSeconds: number | null;
  price: number;
  open: boolean;
}

export interface StatRecord {
  value: number;
  username: string;
  at: string | null;
}

/** GET /ringmaster/overview: the numbers across every member. Days are UTC days. */
export interface Overview {
  generatedAt: string;
  days: OverviewDays;
  /** First day of the range, YYYY-MM-DD. */
  since: string;
  /** `google`: signed up with Google (no password); `googleLinked`: signed up with email, then continued with Google. Missing from an older server. */
  users: { total: number; admins: number; google?: number; googleLinked?: number; newToday: number; newInRange: number; activeToday: number; activeInRange: number };
  tickets: {
    purchases: number;
    purchasesToday: number;
    purchasesInRange: number;
    ticketsSold: number;
    ticketsSoldInRange: number;
    ticketsSpent: number;
    ticketsSpentInRange: number;
    inCirculation: number;
  };
  rounds: { total: number; today: number; inRange: number; completed: number; abandoned: number; open: number };
  byRide: Record<AttractionId, RideAnalytics>;
  /** One row per day of the range, oldest first, today included and zero-filled. */
  daily: { date: string; signups: number; purchases: number; ticketsSold: number; rounds: number; players: number; ticketsSpent: number }[];
  /** Rounds started in the range per hour of the day (UTC), 0 to 23. */
  hours: number[];
  topPlayers: { id: string; username: string; rounds: number; ticketsSpent: number; favourite: AttractionId | null }[];
  /** Per attraction and stat key, the highest and lowest value ever reported. */
  records: Partial<Record<AttractionId, Record<string, { max: StatRecord; min: StatRecord }>>>;
  park: ParkSettings;
}

/** An attraction's settings: its price, and whether it is running. */
export interface AttractionSettings {
  attraction: AttractionId;
  tickets: number;
  open: boolean;
  /** The sign while it is closed (null for the default wording). */
  closedMessage: string | null;
  updatedAt: string | null;
}

/** A member as the Ringmaster's Office lists them. */
export interface AdminUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  ticketBalance: number;
  lastPurchaseAt: string | null;
  createdAt: string;
  termsAcceptedAt: string | null;
  gender?: Gender | null;
  google?: boolean;
  hasPassword?: boolean;
  rounds: number;
  purchases: number;
}

export interface AdminUserDetail {
  user: AdminUser;
  purchases: Purchase[];
  rounds: Round[];
  byRide: Partial<Record<AttractionId, { rounds: number; ticketsSpent: number }>>;
  /** Their latest treats and souvenirs bought at the booth, newest first. */
  shopOrders: ShopOrder[];
  /** How many shop orders they've made in all. */
  shopOrdersTotal: number;
}

/** A shop item as the office edits it: today's price and stock, and what it has sold. */
export interface AdminShopItem extends ShopItem {
  stock: number | null;
  /** The catalog's own price, which it sells at until one is set in the office. */
  defaultTickets: number;
  /** Orders of it, ever. */
  sold: number;
  updatedAt: string | null;
}

/** A treat or souvenir bought at the booth, as the office's ledger lists it. */
export interface AdminShopOrder extends ShopOrder {
  user: { id: string; username: string };
}

export interface AdminPurchase extends Purchase {
  provider: string;
  user: { id: string; username: string; email: string };
}

export interface AdminRound extends Round {
  user: { id: string; username: string };
}

export interface AdminSuggestion extends Suggestion {
  user: { id: string; username: string };
}

export interface AdminAction {
  id: string;
  actorName: string;
  action: string;
  target: string | null;
  details: unknown;
  createdAt: string;
}

/** A player's best run on one of the Rally Trail's boards, as the office lists it. */
export interface TrailOfficeEntry {
  /** The run that set it (the one to disqualify). */
  runId: string;
  rank: number;
  userId: string;
  username: string;
  timeMs: number;
  at: string;
  /** Their runs on this board, the slower ones too. */
  runs: number;
}

/** A run taken off a board by staff (kept, and can be put back). */
export interface TrailDisqualifiedRun {
  id: string;
  userId: string;
  username: string;
  timeMs: number;
  at: string;
}

/** GET /ringmaster/trail?day=: one of the Rally Trail's daily boards, and how the trail does. */
export interface TrailOffice {
  day: string;
  startsAt: string;
  endsAt: string;
  /** The board players see right now (`day` is `today`). */
  current: boolean;
  /** Today's board's day. */
  today: string;
  timeZone: string;
  resetHour: number;
  /** Every player's best on the board, fastest first (top 100). */
  board: TrailOfficeEntry[];
  disqualified: TrailDisqualifiedRun[];
  stats: {
    runs: number;
    players: number;
    /** Rally Trail rounds started in the board's window, and those that ran to the end. */
    rounds: number;
    completed: number;
    avgMs: number | null;
    medianMs: number | null;
  };
  /** The fastest run ever (not disqualified). */
  record: { timeMs: number; username: string; at: string; day: string } | null;
  /** The last 30 boards, oldest first, zero-filled. */
  daily: { day: string; runs: number; players: number; bestMs: number | null; winner: string | null }[];
}

/** One page of a list: `limit` rows from `offset`. */
export interface Page {
  limit: number;
  offset: number;
}

const BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

/** GET /live: the park's (and the member's own account's) live updates, as Server-Sent Events. */
export const LIVE_URL = `${BASE}/live`;

/** Where "Continue with Google" starts (a page to go to, not a fetch). `popup` answers with a page that tells the game and closes. */
export const googleStartUrl = (popup: boolean) => `${BASE}/auth/google${popup ? '?popup=1' : ''}`;

/** A member's own account, as GET /live tells it: their wallet and role, or that it was deleted. */
export type AccountNews = { balance: number; role: Role; lastPurchaseAt: string | null } | { deleted: true };
/** Long enough for a cold server, short enough that a button never stays "busy" for good. */
const TIMEOUT_MS = 12_000;

const OFFLINE = "Can't reach the ticket office right now. Check your connection and try again.";

/** A failed request. `status` is 0 when the server couldn't be reached at all; `data` is the error body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The server is down, missing or unreachable (as opposed to saying no). */
  get unavailable() {
    return this.status === 0 || this.status === 404 || this.status >= 500;
  }

  /** The error body's `code`, when the server gave one (e.g. 'no_slot', 'parts', 'not_buildable'). */
  get code() {
    const c = (this.data as { code?: unknown } | null)?.code;
    return typeof c === 'string' ? c : null;
  }

  /** 409 'parts': what's missing to save the design. */
  get missingParts(): Partial<Parts> | null {
    const m = (this.data as { missing?: unknown } | null)?.missing;
    return this.code === 'parts' && m && typeof m === 'object' ? (m as Partial<Parts>) : null;
  }

  /** 422 'not_buildable': why the circuit can't be built. */
  get issues(): Issue[] {
    const list = (this.data as { issues?: unknown } | null)?.issues;
    return this.code === 'not_buildable' && Array.isArray(list) ? (list as Issue[]) : [];
  }
}

const numberIn = (data: unknown, key: string) => {
  const v = (data as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** 402: the round costs more tickets than the member has left. */
export class NotEnoughTicketsError extends ApiError {
  readonly needed: number | null;
  readonly balance: number | null;

  constructor(message: string, data: unknown) {
    super(402, message, data);
    this.name = 'NotEnoughTicketsError';
    this.needed = numberIn(data, 'needed');
    this.balance = numberIn(data, 'balance');
  }
}

/** 409 on a purchase: the next pack isn't due yet. */
export class PurchaseCooldownError extends ApiError {
  readonly nextPurchaseAt: string | null;

  constructor(message: string, data: unknown) {
    super(409, message, data);
    this.name = 'PurchaseCooldownError';
    const at = (data as { nextPurchaseAt?: unknown } | null)?.nextPurchaseAt;
    this.nextPurchaseAt = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
  }
}

/** 409 with code 'ticket_cap' on a purchase: the member already holds the most free tickets allowed. */
export class TicketCapError extends ApiError {
  readonly ticketCap: number | null;
  readonly balance: number | null;

  constructor(message: string, data: unknown) {
    super(409, message, data);
    this.name = 'TicketCapError';
    this.ticketCap = numberIn(data, 'ticketCap');
    this.balance = numberIn(data, 'balance');
  }
}

/**
 * 503 with code 'park_closed' (the park is closed, so no boarding and no packs) or, with
 * `underMaintenance`, 'park_maintenance' (nobody in the fair at all). Staff are let through both.
 */
export class ParkClosedError extends ApiError {
  constructor(
    message: string,
    data: unknown,
    readonly underMaintenance = false,
  ) {
    super(503, message, data);
    this.name = 'ParkClosedError';
  }

  /** The server answered on purpose: it isn't down. */
  override get unavailable() {
    return false;
  }
}

/** 409 with code 'sold_out': none of that item left at the booth. */
export class SoldOutError extends ApiError {
  readonly item: string | null;

  constructor(message: string, data: unknown) {
    super(409, message, data);
    this.name = 'SoldOutError';
    const item = (data as { item?: unknown } | null)?.item;
    this.item = typeof item === 'string' ? item : null;
  }
}

/** 503 with code 'ride_closed': the attraction is closed for maintenance (staff excepted). */
export class RideClosedError extends ApiError {
  readonly ride: AttractionId | null;

  constructor(message: string, data: unknown) {
    super(503, message, data);
    this.name = 'RideClosedError';
    const ride = (data as { ride?: unknown } | null)?.ride;
    this.ride = typeof ride === 'string' && isAttraction(ride) ? ride : null;
  }

  override get unavailable() {
    return false;
  }
}

/** 429 with code 'suggestion_limit': the member has left as many suggestions as a day allows. */
export class SuggestionLimitError extends ApiError {
  /** When the box takes another one from them. */
  readonly nextAt: string | null;

  constructor(message: string, data: unknown) {
    super(429, message, data);
    this.name = 'SuggestionLimitError';
    const at = (data as { nextAt?: unknown } | null)?.nextAt;
    this.nextAt = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
  }

  override get unavailable() {
    return false;
  }
}

/**
 * 403 with code 'ip_blocked': the site is private (switched on in the office) and this visitor's
 * address isn't on the list. Staff too: it goes by address, not by account.
 */
export class AccessBlockedError extends ApiError {
  /** The address the server saw, so the visitor can ask to be let in. */
  readonly ip: string | null;

  constructor(message: string, data: unknown) {
    super(403, message, data);
    this.name = 'AccessBlockedError';
    const ip = (data as { ip?: unknown } | null)?.ip;
    this.ip = typeof ip === 'string' ? ip : null;
  }

  override get unavailable() {
    return false;
  }
}

/** The fair turned this visitor away (private access): the page shows the private sign. */
const blockedListeners = new Set<(err: AccessBlockedError) => void>();
export const onAccessBlocked = (fn: (err: AccessBlockedError) => void) => void blockedListeners.add(fn);

const closedCode = (status: number, data: unknown) => (status === 503 ? (data as { code?: unknown } | null)?.code : undefined);

/** The server's own words, as they are (the closed sign is written by staff). */
const rawMessage = (data: unknown) => {
  const m = (data as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : null;
};

/** Nest's error body carries `message` as a string or, for validation, a list of strings. */
function messageOf(body: unknown, status: number) {
  const raw = (body as { message?: unknown } | null)?.message;
  const list = (Array.isArray(raw) ? raw : [raw]).filter((m): m is string => typeof m === 'string' && m.trim() !== '');
  if (status === 429) return 'Too many tries. Take a breather and try again in a minute.';
  if (status === 0 || status === 404 || status >= 500) return OFFLINE;
  if (!list.length) return 'Something went wrong. Please try again.';
  return list.map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join('. ');
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, OFFLINE);
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 403 && (data as { code?: unknown } | null)?.code === 'ip_blocked') {
      const err = new AccessBlockedError(rawMessage(data) ?? 'The fair is private right now.', data);
      for (const fn of blockedListeners) fn(err);
      throw err;
    }
    const code = closedCode(res.status, data);
    if (code === 'park_closed') throw new ParkClosedError(rawMessage(data) ?? 'The park is closed right now.', data);
    if (code === 'park_maintenance') throw new ParkClosedError(rawMessage(data) ?? 'The fair is under maintenance.', data, true);
    if (code === 'ride_closed') throw new RideClosedError(rawMessage(data) ?? 'Under maintenance. Back soon!', data);
    if (res.status === 429 && (data as { code?: unknown } | null)?.code === 'suggestion_limit')
      throw new SuggestionLimitError(rawMessage(data) ?? 'That’s enough ideas for today. Come back tomorrow!', data);
    if (res.status === 429 && (data as { code?: unknown } | null)?.code === 'submission_limit')
      throw new ApiError(429, rawMessage(data) ?? 'That’s enough coasters sent for today. Come back tomorrow!', data);
    const message = messageOf(data, res.status);
    if (res.status === 409 && (data as { code?: unknown } | null)?.code === 'sold_out') throw new SoldOutError(message, data);
    throw res.status === 402 ? new NotEnoughTicketsError(message, data) : new ApiError(res.status, message, data);
  }
  // a static host may answer 200 with its own HTML page: that isn't the API either
  if (data === null) throw new ApiError(0, OFFLINE);
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>('GET', '/auth/me'),
  signup: (body: { email: string; username: string; password: string; gender: Gender; acceptTerms: true }) => request<{ user: User }>('POST', '/auth/signup', body),
  /** `login` is the email address or the username. */
  login: (body: { login: string; password: string }) => request<{ user: User }>('POST', '/auth/login', body),
  logout: () => request<void>('POST', '/auth/logout'),
  /** Fills in what the account is missing (asked after logging in). */
  updateProfile: (body: { gender?: Gender; acceptTerms?: true }) => request<{ user: User }>('PATCH', '/auth/me', body),
  /**
   * Deletes the account and all its purchases and rounds: with the password (a wrong one is a 401),
   * or, for an account made with Google, the username typed out (`confirm`).
   */
  deleteAccount: (body: { password: string } | { confirm: string }) => request<void>('DELETE', '/auth/me', body),

  /** Whether "Continue with Google" is set up on the server. */
  googleEnabled: () => request<{ enabled: boolean }>('GET', '/auth/google/enabled'),
  /** The Google account waiting to finish signing up, and a free username to offer it. A 401 once it has expired. */
  googlePending: () => request<{ email: string; name: string | null; username: string }>('GET', '/auth/google/pending'),
  googleSignup: (body: { username: string; gender: Gender; acceptTerms: true }) => request<{ user: User }>('POST', '/auth/google/signup', body),

  tickets: () => request<Tickets>('GET', '/tickets'),
  purchase: () =>
    request<{ balance: number; purchase: Purchase; nextPurchaseAt: string | null; canBuy: boolean }>('POST', '/tickets/purchase').catch((err: unknown) => {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
      throw (err.data as { code?: unknown } | null)?.code === 'ticket_cap' ? new TicketCapError(err.message, err.data) : new PurchaseCooldownError(err.message, err.data);
    }),
  purchases: (limit = 50) => request<{ purchases: Purchase[] }>('GET', `/tickets/purchases?limit=${limit}`),

  /** Pays for one round (the tickets are spent now) and opens it. */
  board: (ride: AttractionId) => request<{ round: Round; balance: number }>('POST', `/rides/${ride}/board`),
  finish: (id: string, body: { completed: boolean; stats: RoundStats }) => request<FinishedRound>('POST', `/rides/rounds/${encodeURIComponent(id)}/finish`, body),
  /** The same, sent as the page closes: a keepalive request that outlives the tab, with nothing waiting for its answer. */
  finishOnExit: (id: string, body: { completed: boolean; stats: RoundStats }) =>
    void fetch(`${BASE}/rides/rounds/${encodeURIComponent(id)}/finish`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {}),
  /** Ends a round whose attraction (or the park) closed while it was played, and gives its tickets back. */
  refund: (id: string) => request<{ refunded: number; balance: number }>('POST', `/rides/rounds/${encodeURIComponent(id)}/refund`),
  stats: () => request<RideStats>('GET', '/rides/stats'),
  history: (limit = 20) => request<{ rounds: Round[] }>('GET', `/rides/history?limit=${limit}`),

  /** Open or closed, what is under maintenance, the prices and the pack rules. No account needed. */
  park: () => request<Park>('GET', '/park'),

  /** The Rally Trail's leaderboard for today (anyone; a member also hears where they stand). */
  trailBoard: () => request<TrailBoard>('GET', '/trail/leaderboard'),

  /** The booth's shop: what's for sale (anyone), the member's souvenirs, buying and wearing. */
  shop: () => request<{ items: ShopItem[] }>('GET', '/shop'),
  souvenirs: () => request<{ souvenirs: Souvenir[] }>('GET', '/shop/souvenirs'),
  /** The member's own orders, newest first, and how many there are in all. */
  orders: (limit = 10) => request<{ orders: ShopOrder[]; total: number }>('GET', `/shop/orders?limit=${limit}`),
  buyItem: (item: string) => request<{ balance: number; order: ShopOrder; souvenirs: Souvenir[] }>('POST', '/shop/buy', { item }),
  wear: (item: string, equipped: boolean) => request<{ souvenirs: Souvenir[] }>('PATCH', `/shop/souvenirs/${encodeURIComponent(item)}`, { equipped }),

  /** The Idea Box: the member's own suggestions, and how many have news from staff. */
  suggestions: () => request<{ suggestions: Suggestion[]; total: number; unread: number }>('GET', '/suggestions'),
  /** Throws a SuggestionLimitError after a few in a day. */
  suggest: (body: { topic: SuggestionTopic; message: string }) => request<Suggestion>('POST', '/suggestions', body),
  suggestionsSeen: () => request<void>('POST', '/suggestions/seen'),

  /** The Coaster Workshop: parts, inventory, design slots, the day's submissions and the member's designs. */
  workshop: () => request<Workshop>('GET', '/workshop'),
  /** Every coaster part at today's price (anyone). */
  coasterParts: () => request<{ parts: CoasterPartItem[] }>('GET', '/workshop/parts'),
  /** The free starter kit, once (a 409 after that). */
  claimStarterKit: () => request<Workshop>('POST', '/workshop/starter-kit'),
  /** 402 when short of tickets, 409 'sold_out' (a SoldOutError). */
  buyParts: (part: Part, quantity: number) => request<{ balance: number; owned: Parts; part: CoasterPartItem }>('POST', '/workshop/parts/buy', { part, quantity }),
  design: (id: string) => request<SavedDesign>('GET', `/workshop/designs/${encodeURIComponent(id)}`),
  /** 409 'no_slot' (every slot taken) or 'parts' (see ApiError.missingParts). */
  createDesign: (design: Design) => request<SavedDesign>('POST', '/workshop/designs', { design }),
  updateDesign: (id: string, design: Design) => request<SavedDesign>('PUT', `/workshop/designs/${encodeURIComponent(id)}`, { design }),
  deleteDesign: (id: string) => request<void>('DELETE', `/workshop/designs/${encodeURIComponent(id)}`),
  /** Sends the saved design to staff with its picture (a data: URL). 422 'not_buildable', 409 'pending', 429 'submission_limit'. */
  submitDesign: (id: string, picture?: string) => request<MyCreation>('POST', `/workshop/designs/${encodeURIComponent(id)}/submit`, picture ? { picture } : {}),
  myCreations: () => request<{ creations: MyCreation[]; unread: number }>('GET', '/workshop/creations'),
  creationsSeen: () => request<void>('POST', '/workshop/creations/seen'),
  /** Withdraws a submission staff haven't answered yet. */
  withdrawCreation: (id: string) => request<void>('DELETE', `/workshop/creations/${encodeURIComponent(id)}`),
  /** A player-built coaster's design: released ones for anyone, any for its creator and for staff. */
  creation: (id: string) => request<CreationDetail>('GET', `/creations/${encodeURIComponent(id)}`),
};

/** A submitted coaster's picture (an <img> src). */
export const creationPictureUrl = (id: string) => `${BASE}/creations/${encodeURIComponent(id)}/picture`;

/** `?a=1&b=x` from the values that are set. */
const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** The Ringmaster's Office: staff only (a guest gets a 401, a player a 403). The server logs every change. */
export const ringmaster = {
  overview: (days: OverviewDays) => request<Overview>('GET', `/ringmaster/overview${query({ days })}`),
  park: () => request<ParkSettings>('GET', '/ringmaster/park'),
  visitors: () => request<Visitors>('GET', '/ringmaster/visitors'),
  updatePark: (body: Partial<Pick<ParkSettings, 'open' | 'closedMessage' | 'underMaintenance' | 'maintenanceMessage' | 'packSize' | 'cooldownHours' | 'ticketCap'>>) => request<ParkSettings>('PATCH', '/ringmaster/park', body),
  /** Private access: the switch, the list, and the caller's own address. */
  access: () => request<Access>('GET', '/ringmaster/access'),
  /** Switching it on adds the caller's own address (their IPv6 network) if the list doesn't let them in yet. */
  updateAccess: (enabled: boolean) => request<Access>('PATCH', '/ringmaster/access', { enabled }),
  allowIp: (body: { ip: string; label?: string | null }) => request<AllowedIp>('POST', '/ringmaster/access/ips', body),
  /** A 409 for the last entry that lets the caller in, while private access is on. */
  removeAllowedIp: (id: string) => request<void>('DELETE', `/ringmaster/access/ips/${encodeURIComponent(id)}`),
  attractions: () => request<{ attractions: AttractionSettings[] }>('GET', '/ringmaster/attractions'),
  updateAttraction: (attraction: AttractionId, body: Partial<Pick<AttractionSettings, 'tickets' | 'open' | 'closedMessage'>>) =>
    request<AttractionSettings>('PATCH', `/ringmaster/attractions/${attraction}`, body),
  shopItems: () => request<{ items: AdminShopItem[] }>('GET', '/ringmaster/shop'),
  updateShopItem: (item: string, body: { tickets?: number; stock?: number | null }) =>
    request<AdminShopItem>('PATCH', `/ringmaster/shop/${encodeURIComponent(item)}`, body),
  users: (p: Page & { q?: string }) =>
    request<{ users: AdminUser[]; total: number }>('GET', `/ringmaster/users${query({ q: p.q?.trim(), limit: p.limit, offset: p.offset })}`),
  user: (id: string) => request<AdminUserDetail>('GET', `/ringmaster/users/${encodeURIComponent(id)}`),
  updateUser: (id: string, body: { ticketBalance?: number; role?: Role; resetCooldown?: true }) =>
    request<AdminUser>('PATCH', `/ringmaster/users/${encodeURIComponent(id)}`, body),
  deleteUser: (id: string) => request<void>('DELETE', `/ringmaster/users/${encodeURIComponent(id)}`),
  purchases: (p: Page) => request<{ purchases: AdminPurchase[]; total: number }>('GET', `/ringmaster/purchases${query({ limit: p.limit, offset: p.offset })}`),
  shopOrders: (p: Page) => request<{ orders: AdminShopOrder[]; total: number }>('GET', `/ringmaster/shop-orders${query({ limit: p.limit, offset: p.offset })}`),
  rounds: (p: Page & { ride?: AttractionId | null }) =>
    request<{ rounds: AdminRound[]; total: number }>('GET', `/ringmaster/rounds${query({ ride: p.ride, limit: p.limit, offset: p.offset })}`),
  actions: (p: Page) => request<{ actions: AdminAction[]; total: number }>('GET', `/ringmaster/actions${query({ limit: p.limit, offset: p.offset })}`),
  suggestions: (p: Page & { status?: SuggestionStatus | null }) =>
    request<{ suggestions: AdminSuggestion[]; total: number; counts: Record<SuggestionStatus, number> }>(
      'GET',
      `/ringmaster/suggestions${query({ status: p.status, limit: p.limit, offset: p.offset })}`,
    ),
  /** The reply is given once: a second one gets a 409. */
  updateSuggestion: (id: string, body: { status?: SuggestionStatus; reply?: string }) =>
    request<AdminSuggestion>('PATCH', `/ringmaster/suggestions/${encodeURIComponent(id)}`, body),
  /** One of the Rally Trail's daily boards (today's without a day). */
  trail: (day?: string | null) => request<TrailOffice>('GET', `/ringmaster/trail${query({ day })}`),
  /** Takes a run off its board, or puts it back. */
  updateTrailRun: (id: string, disqualified: boolean) =>
    request<{ id: string; disqualified: boolean }>('PATCH', `/ringmaster/trail/runs/${encodeURIComponent(id)}`, { disqualified }),
  /** The coasters members sent, newest first, with how many there are of each status and Creators' Valley's plots. */
  creations: (p: Page & { status?: CreationStatus | null }) =>
    request<{ creations: AdminCreation[]; total: number; counts: Record<CreationStatus, number>; plots: AdminPlot[] }>(
      'GET',
      `/ringmaster/creations${query({ status: p.status, limit: p.limit, offset: p.offset })}`,
    ),
  creation: (id: string) => request<AdminCreation>('GET', `/ringmaster/creations/${encodeURIComponent(id)}`),
  /** Onto a free `plot`, or (`replace`) in place of the version of the same design running now; at `tickets` a ride. */
  releaseCreation: (id: string, body: { plot?: number; tickets?: number; replace?: boolean }) =>
    request<AdminCreation>('POST', `/ringmaster/creations/${encodeURIComponent(id)}/release`, body),
  declineCreation: (id: string, reply: string) => request<AdminCreation>('POST', `/ringmaster/creations/${encodeURIComponent(id)}/decline`, { reply }),
  /** Takes a released coaster out of the park: its riders are stopped and refunded. */
  removeCreation: (id: string) => request<AdminCreation>('POST', `/ringmaster/creations/${encodeURIComponent(id)}/remove`),
  coasterParts: () => request<{ parts: AdminCoasterPart[] }>('GET', '/ringmaster/workshop/parts'),
  updateCoasterPart: (part: Part, body: { tickets?: number; stock?: number | null }) =>
    request<AdminCoasterPart>('PATCH', `/ringmaster/workshop/parts/${encodeURIComponent(part)}`, body),
};
