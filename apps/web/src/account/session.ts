import {
  AdLimitError,
  api,
  ApiError,
  LIVE_URL,
  COOLDOWN_HOURS,
  onAccessBlocked,
  DEFAULT_COSTS,
  NotEnoughTicketsError,
  PACK_SIZE,
  PLOT_IDS,
  ParkClosedError,
  PurchaseCooldownError,
  TicketCapError,
  RideClosedError,
  SoldOutError,
  type AccountNews,
  type AttractionId,
  type FinishedRound,
  type Gender,
  type MyCreation,
  type Park,
  type ParkCreation,
  type Purchase,
  type RideStats,
  type RoundStats,
  type ShopItem,
  type ShopOrder,
  type Souvenir,
  type Suggestion,
  type SuggestionTopic,
  type Tickets,
  type User,
} from './api';

type Listener = () => void;

/** If the server can't be reached at boot, look again after these delays (it may still be starting). */
const RETRY_MS = [3_000, 10_000];
/** How many purchases the booth and the account card show. */
const RECENT_PURCHASES = 5;
/** How many shop orders the account card shows. */
const RECENT_ORDERS = 5;
/** While the visitor is in the fair and the live stream is down, the gates are checked this often. */
const PARK_POLL_MS = 60_000;
/** A tab hidden this long lets go of its live stream; it reconnects, and catches up, when it's back. */
const HIDDEN_MS = 30_000;
/** This tab's own id on the live stream, so the office can count who's in the fair (nothing else is in it). */
const VISITOR_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** "every 5 hours", "every hour", "any time" (a cool-down of 0 means no wait at all). */
export const everyHours = (h: number) => (h <= 0 ? 'any time' : h === 1 ? 'every hour' : `every ${h} hours`);

/**
 * Who's visiting: a member (`user`) or a guest (`null`), and the member's tickets. Everything
 * here is best effort: when the accounts server is down the fair still opens, and the visitor
 * simply walks in as a guest.
 */
class Session {
  private _user: User | null = null;
  private _known = false;
  private _tickets: Tickets | null = null;
  private _stats: RideStats | null = null;
  private _purchases: Purchase[] | null = null;
  private listeners = new Set<Listener>();
  private warned = false;
  private ticketsLoading: { id: string; p: Promise<Tickets | null> } | null = null;
  private _park: Park | null = null;
  private parkLoading: Promise<Park | null> | null = null;
  private parkListeners = new Set<(park: Park | null) => void>();
  private parkTimer: ReturnType<typeof setInterval> | null = null;
  private parkCheckedAt = 0;
  private live: EventSource | null = null;
  private _catalog: ShopItem[] | null = null;
  private catalogLoading: Promise<ShopItem[] | null> | null = null;
  private _souvenirs: Souvenir[] | null = null;
  private _orders: { orders: ShopOrder[]; total: number } | null = null;
  private shopListeners = new Set<Listener>();
  private leaderboardListeners = new Set<Listener>();
  private _suggestions: { suggestions: Suggestion[]; total: number; unread: number } | null = null;
  private suggestionListeners = new Set<Listener>();
  private creationListeners = new Set<Listener>();
  private workshopListeners = new Set<Listener>();
  private _myCreations: { creations: MyCreation[]; unread: number } | null = null;
  private myCreationListeners = new Set<Listener>();
  private _inFair = false;
  private liveHidden: ReturnType<typeof setTimeout> | null = null;
  private _blocked: { message: string; ip: string | null } | null = null;

  constructor() {
    onAccessBlocked((err) => this.noteBlocked(err.message, err.ip));
  }

  get user() {
    return this._user;
  }

  /** Staff: they can open the Ringmaster's Office, and ride while the park is closed. */
  get isStaff() {
    return this._user?.role === 'admin';
  }

  /** The gates and the rules from GET /park; null until it answers (or while the server is away). */
  get park() {
    return this._park;
  }

  /** Open unless the server says otherwise: an unreachable server never shuts the fair. */
  get parkOpen() {
    return this._park?.open ?? true;
  }

  /** The whole park is under maintenance: nobody but staff in the fair (stricter than closed). */
  get parkUnderMaintenance() {
    return this._park?.underMaintenance ?? false;
  }

  /**
   * The site is private and this visitor's address isn't on the list (staff or not): the private
   * sign, and the address the server saw. Null otherwise. It lasts until the page is reloaded.
   */
  get blocked() {
    return this._blocked;
  }

  /** Kept out of the fair: the site is private to other addresses, or it's under maintenance and this visitor isn't staff. */
  get shutOut() {
    return !!this._blocked || (this.parkUnderMaintenance && !this.isStaff);
  }

  /** Turned away by private access (a request, or the live stream): out of the fair, and the stream stays closed. */
  private noteBlocked(message: string, ip: string | null) {
    if (this._blocked) return;
    this._blocked = { message, ip };
    this.closeLive();
    for (const fn of this.parkListeners) fn(this._park);
    this.emit();
  }

  /**
   * The sign on an attraction closed for maintenance (null for the default wording), or undefined
   * while it is running.
   */
  maintenance(ride: AttractionId): string | null | undefined {
    const m = this._park?.maintenance;
    return m && ride in m ? (m[ride] ?? null) : undefined;
  }

  /** Tickets in one pack (the live rule once known). */
  get packSize() {
    return this._tickets?.packSize ?? this._park?.packSize ?? PACK_SIZE;
  }

  /** Hours between two packs (the live rule once known). */
  get cooldownHours() {
    return this._tickets?.cooldownHours ?? this._park?.cooldownHours ?? COOLDOWN_HOURS;
  }

  /** The most a free pack tops a balance up to (the live rule once known); null for no ceiling. */
  get ticketCap() {
    return this._tickets?.ticketCap ?? this._park?.ticketCap ?? null;
  }

  /** Tickets the next pack gives: the whole pack, or only what tops the balance up to the cap (0 when at it). */
  get packNow() {
    const cap = this.ticketCap;
    const balance = this._tickets?.balance;
    if (cap === null || balance === undefined) return this.packSize;
    return Math.max(0, Math.min(this.packSize, cap - balance));
  }

  /** Tickets one rewarded ad gives (the live rule once known); 0 while ads are off. */
  get adTickets() {
    return this._tickets?.adTickets ?? this._park?.adTickets ?? 0;
  }

  /** Ads the member can still be paid for in the last 24 hours (null until the wallet is in). */
  get adsLeft() {
    return this._tickets?.adsLeft ?? null;
  }

  /** Milliseconds until another ad can be paid for, once all of the day's are used up; null otherwise. */
  msUntilAd(now = Date.now()) {
    const t = this._tickets;
    if (!t || t.adsLeft !== 0) return null;
    const next = Date.parse(t.nextAdAt ?? '');
    return Number.isNaN(next) ? null : Math.max(0, next - now);
  }

  /**
   * Where watching an ad for tickets stands: 'ready' when the member can watch one now, 'used-up'
   * once the day's are watched, or null when ads aren't offered: they're off, the wallet isn't in,
   * the park is closed, or the free pack is ready (that comes first). Whether an ad is actually
   * there to play is up to the ad network (see ads.ts).
   */
  get adState(): 'ready' | 'used-up' | null {
    const t = this._tickets;
    if (!this._user || !t || this.adTickets <= 0 || t.adsLeft === undefined) return null;
    if (!this.isStaff && (!this.parkOpen || this.parkUnderMaintenance)) return null;
    const packReady = (this.msUntilPurchase() ?? 0) === 0 && this.packNow > 0;
    if (packReady) return null;
    return t.adsLeft > 0 ? 'ready' : 'used-up';
  }

  /** False until the first check against the server has settled (either way). */
  get known() {
    return this._known;
  }

  /** The member's wallet, once loaded (see `loadTickets`). */
  get tickets() {
    return this._tickets;
  }

  /** How many tickets the member holds, if known yet. */
  get balance() {
    return this._tickets?.balance ?? null;
  }

  /** The member's rounds and bests per attraction, once loaded (see `loadStats`). */
  get stats() {
    return this._stats;
  }

  /** The member's latest purchases, newest first, once loaded (see `loadPurchases`). */
  get purchases() {
    return this._purchases;
  }

  /** What one round of `ride` costs (the server's table once it's in, the usual prices until then). */
  cost(ride: AttractionId) {
    return this._tickets?.costs?.[ride] ?? this._park?.costs?.[ride] ?? DEFAULT_COSTS[ride];
  }

  /** Calls `fn` whenever the park or an attraction opens or closes, the park goes under maintenance or comes out, or a sign changes. Returns an unsubscribe. */
  onPark(fn: (park: Park | null) => void) {
    this.parkListeners.add(fn);
    return () => void this.parkListeners.delete(fn);
  }

  /**
   * Asks the server whether the park is open, and for the prices and pack rules. Never throws:
   * when the server can't be reached the park counts as open (the fair still opens for guests).
   * At boot (`retry`), an unreachable server is asked again a couple of times.
   */
  loadPark(retry = false): Promise<Park | null> {
    if (this.parkLoading) return this.parkLoading;
    const p = this.fetchPark(retry ? 0 : RETRY_MS.length).finally(() => {
      if (this.parkLoading === p) this.parkLoading = null;
    });
    return (this.parkLoading = p);
  }

  private async fetchPark(attempt: number): Promise<Park | null> {
    this.parkCheckedAt = Date.now();
    try {
      this.setPark(normalisePark(await api.park()));
    } catch (err) {
      if (err instanceof ApiError && err.unavailable) {
        this.warnOnce(err);
        // the gates stay open; the prices and rules last heard are kept
        if (this._park && (!this._park.open || this._park.underMaintenance))
          this.setPark({ ...this._park, open: true, message: null, underMaintenance: false, maintenanceMessage: null });
        if (attempt < RETRY_MS.length) setTimeout(() => void this.loadPark(), RETRY_MS[attempt]);
      }
    }
    return this._park;
  }

  /** A board or a purchase was turned away at the gate: the park closed since we last looked. */
  noteParkClosed(err: ParkClosedError) {
    if (err.underMaintenance) this.setPark({ ...this.parkOrDefaults(), underMaintenance: true, maintenanceMessage: err.message });
    else this.setPark({ ...this.parkOrDefaults(), open: false, message: err.message });
  }

  /** A board was turned away: the attraction went under maintenance since we last looked. */
  noteRideClosed(ride: AttractionId, err: RideClosedError) {
    const park = this.parkOrDefaults();
    this.setPark({ ...park, maintenance: { ...park.maintenance, [ride]: err.message } });
  }

  private parkOrDefaults(): Park {
    return (
      this._park ?? {
        open: true,
        message: null,
        underMaintenance: false,
        maintenanceMessage: null,
        costs: {},
        packSize: this.packSize,
        cooldownHours: this.cooldownHours,
        ticketCap: this.ticketCap,
        adTickets: this.adTickets,
        adsPerDay: this._tickets?.adsPerDay ?? 0,
        maintenance: {},
      }
    );
  }

  /**
   * Keeps the gates, the prices, the pack rules and the member's own wallet and role live while the
   * visitor is in the fair: GET /live pushes every change made in The Ringmaster's Office. While
   * the stream is down, the gates are checked every minute instead (and when the tab comes back).
   */
  watchPark() {
    if (this.parkTimer) return;
    const check = () => {
      if (document.hidden || this.live?.readyState === EventSource.OPEN) return;
      if (Date.now() - this.parkCheckedAt >= PARK_POLL_MS - 1000) void this.loadPark();
    };
    this.parkTimer = setInterval(check, PARK_POLL_MS);
    // a hidden tab lets go of the stream after a while; coming back reconnects (with a fresh snapshot)
    document.addEventListener('visibilitychange', () => {
      if (this.liveHidden) clearTimeout(this.liveHidden);
      this.liveHidden = null;
      if (document.hidden) this.liveHidden = setTimeout(() => this.closeLive(), HIDDEN_MS);
      else if (!this.live) this.openLive();
      check();
    });
    if (!document.hidden) this.openLive();
  }

  /**
   * Past the entrance (true) or back at it: the office counts who's in the fair, so the stream
   * reconnects to say so.
   */
  setInFair(inFair: boolean) {
    if (inFair === this._inFair) return;
    this._inFair = inFair;
    if (this.live) this.openLive();
  }

  /** Opens the live stream. It says who's listening by the session cookie, so a new member reopens it. */
  private openLive() {
    if (typeof EventSource === 'undefined' || this._blocked) return;
    this.closeLive();
    const live = new EventSource(`${LIVE_URL}?visitor=${encodeURIComponent(VISITOR_ID)}&in=${this._inFair ? 1 : 0}`, { withCredentials: true });
    live.addEventListener('park', (e) => {
      const park = parseEvent<Park>(e);
      if (!park) return;
      this.parkCheckedAt = Date.now();
      this.setPark(normalisePark(park));
    });
    // a price or the stock changed at the booth (in the office, or someone bought the last one)
    live.addEventListener('shop', () => {
      for (const fn of this.shopListeners) fn();
    });
    // staff answered one of the member's suggestions (or another of their tabs read the answer)
    live.addEventListener('suggestions', () => void this.loadSuggestions());
    // a coaster part's price or stock changed (in the office, or someone bought the last one)
    live.addEventListener('workshop', () => {
      for (const fn of this.workshopListeners) fn();
    });
    // staff released, declined or removed one of the member's coasters (or another of their tabs read the news)
    live.addEventListener('creations', () => void this.loadMyCreations());
    // someone posted a time on the Rally Trail (or staff took one off): the boards look again; and
    // on every (re)connect, for anything posted while the stream was down or the tab was hidden
    const boardNews = () => {
      for (const fn of this.leaderboardListeners) fn();
    };
    live.addEventListener('leaderboard', boardNews);
    live.addEventListener('open', boardNews);
    live.addEventListener('account', (e) => {
      const news = parseEvent<AccountNews>(e);
      if (news) this.applyAccount(news);
    });
    // private access was switched on (or this address taken off the list) in the office
    live.addEventListener('blocked', (e) => {
      const b = parseEvent<{ message?: unknown; ip?: unknown }>(e);
      this.noteBlocked(typeof b?.message === 'string' ? b.message : 'The fair is private right now.', typeof b?.ip === 'string' ? b.ip : null);
    });
    // EventSource reconnects on its own (the server closes each stream after a few minutes)
    this.live = live;
  }

  private closeLive() {
    this.live?.close();
    this.live = null;
  }

  /** The member's account changed elsewhere: tickets given or taken, staff appointed, the cool-down reset, or the account deleted. */
  private applyAccount(news: AccountNews) {
    const user = this._user;
    if (!user) return;
    if ('deleted' in news) return this.expire();
    if (news.role !== (user.role ?? 'player')) this.set({ ...user, role: news.role });
    const t = this._tickets;
    if (!t) return;
    // a new cool-down (or none): the server works out when the next pack is due
    if (Date.parse(news.lastPurchaseAt ?? '') !== Date.parse(t.lastPurchaseAt ?? '') && (news.lastPurchaseAt || t.lastPurchaseAt)) {
      void this.loadTickets();
    } else if (news.balance !== t.balance) {
      this._tickets = { ...t, balance: news.balance };
      this.emit();
    }
  }

  private setPark(park: Park) {
    const before = this._park;
    this._park = park;
    // a member's wallet carries the same rules: keep it in step with the latest word
    if (this._tickets)
      this._tickets = {
        ...this._tickets,
        costs: { ...this._tickets.costs, ...park.costs },
        packSize: park.packSize,
        cooldownHours: park.cooldownHours,
        ticketCap: park.ticketCap,
        adTickets: park.adTickets,
        adsPerDay: park.adsPerDay,
      };
    if (JSON.stringify(before) === JSON.stringify(park)) return;
    // a new cool-down moves the member's next pack, and a new day's limit their ads left: the server works out both
    if (before && (before.cooldownHours !== park.cooldownHours || before.adsPerDay !== park.adsPerDay) && this._tickets) void this.loadTickets();
    if (
      before?.open !== park.open ||
      before?.message !== park.message ||
      before?.underMaintenance !== park.underMaintenance ||
      before?.maintenanceMessage !== park.maintenanceMessage ||
      JSON.stringify(before?.maintenance) !== JSON.stringify(park.maintenance)
    )
      for (const fn of this.parkListeners) fn(park);
    if (JSON.stringify(before?.creations ?? []) !== JSON.stringify(park.creations ?? [])) for (const fn of this.creationListeners) fn();
    this.emit();
  }

  /** Milliseconds until the next pack can be bought: 0 when it can be now, null when unknown. */
  msUntilPurchase(now = Date.now()) {
    const t = this._tickets;
    if (!t) return null;
    const next = t.nextPurchaseAt ? Date.parse(t.nextPurchaseAt) : NaN;
    if (Number.isNaN(next)) return t.canBuy || !t.nextPurchaseAt ? 0 : null;
    return Math.max(0, next - now);
  }

  // ---------- The booth's shop ----------

  /** What the booth sells, once loaded (see `loadCatalog`). */
  get catalog() {
    return this._catalog;
  }

  /** The member's souvenirs, once loaded: [] for a guest. */
  get souvenirs() {
    return this._souvenirs ?? [];
  }

  /** False until the member's souvenirs have been fetched. */
  get souvenirsKnown() {
    return this._souvenirs !== null;
  }

  /** The souvenirs being worn, by catalog id. */
  get wearing() {
    return this.souvenirs.filter((s) => s.equipped).map((s) => s.item);
  }

  owns(item: string) {
    return this.souvenirs.some((s) => s.item === item);
  }

  /** The member's latest shop orders (newest first) and how many in all, once loaded (see `loadOrders`). */
  get orders() {
    return this._orders;
  }

  /** Calls `fn` when the booth's prices or stock change (GET /shop has the new ones). Returns an unsubscribe. */
  onShop(fn: Listener) {
    this.shopListeners.add(fn);
    return () => void this.shopListeners.delete(fn);
  }

  /** Calls `fn` when the Rally Trail's leaderboard changes (GET /trail/leaderboard has the new one). Returns an unsubscribe. */
  onLeaderboard(fn: Listener) {
    this.leaderboardListeners.add(fn);
    return () => void this.leaderboardListeners.delete(fn);
  }

  /**
   * Fetches the shop's catalog: once, or again with `fresh` (prices and stock change). Resolves to
   * null when the server is away, keeping the last one heard.
   */
  loadCatalog(fresh = false) {
    if (this._catalog && !fresh) return Promise.resolve(this._catalog);
    this.catalogLoading ??= api
      .shop()
      .then(({ items }) => {
        this._catalog = items;
        this.emit();
        return items;
      })
      .catch(() => null)
      .finally(() => (this.catalogLoading = null));
    return this.catalogLoading;
  }

  /** Fetches the member's souvenirs (what they wear shows on them in the fair). */
  async loadSouvenirs() {
    const id = this._user?.id;
    if (!id) return null;
    const res = await this.guard(api.souvenirs());
    if (!res || this._user?.id !== id) return null;
    this._souvenirs = res.souvenirs;
    this.emit();
    return res.souvenirs;
  }

  /** Fetches the member's latest shop orders. Resolves to null for guests or when the server is away. */
  async loadOrders() {
    const id = this._user?.id;
    if (!id) return null;
    const res = await this.guard(api.orders(RECENT_ORDERS));
    if (!res || this._user?.id !== id) return null;
    this._orders = res;
    this.emit();
    return res;
  }

  /**
   * Buys one item from the shop. Throws an ApiError: a NotEnoughTicketsError when the wallet is
   * short (which also corrects the balance here), a SoldOutError when none are left, a
   * ParkClosedError while the park is closed.
   */
  async buyItem(item: string) {
    try {
      const res = await api.buyItem(item);
      if (this._tickets) this._tickets = { ...this._tickets, balance: res.balance };
      else void this.loadTickets();
      this._souvenirs = res.souvenirs;
      if (this._orders) this._orders = { orders: [res.order, ...this._orders.orders].slice(0, RECENT_ORDERS), total: this._orders.total + 1 };
      this.setStock(item, (n) => n - 1);
      this.emit();
      return res;
    } catch (err) {
      if (err instanceof SoldOutError) {
        this.setStock(item, () => 0);
        this.emit();
      }
      if (err instanceof ParkClosedError) this.noteParkClosed(err);
      if (err instanceof NotEnoughTicketsError && err.balance !== null && this._tickets) {
        this._tickets = { ...this._tickets, balance: err.balance };
        this.emit();
      }
      if (err instanceof ApiError && err.status === 401) this.expire();
      throw err;
    }
  }

  /** What's left of an item, until the catalog is fetched again (a limited one only). */
  private setStock(item: string, next: (n: number) => number) {
    this._catalog = this._catalog?.map((i) => (i.id === item && typeof i.stock === 'number' ? { ...i, stock: Math.max(0, next(i.stock)) } : i)) ?? null;
  }

  /** Puts a souvenir on (whatever shared its slot comes off) or takes it off. Throws an ApiError. */
  async wear(item: string, equipped: boolean) {
    const { souvenirs } = await api.wear(item, equipped);
    this._souvenirs = souvenirs;
    this.emit();
    return souvenirs;
  }

  // ---------- The Idea Box ----------

  /** The member's suggestions (newest first), how many in all and how many have unread news, once loaded. */
  get suggestions() {
    return this._suggestions;
  }

  /** Calls `fn` when the member's suggestions change: one left, or news from staff. Returns an unsubscribe. */
  onSuggestions(fn: Listener) {
    this.suggestionListeners.add(fn);
    return () => void this.suggestionListeners.delete(fn);
  }

  /** Fetches the member's suggestions. Resolves to null for guests or when the server is away. */
  async loadSuggestions() {
    const id = this._user?.id;
    if (!id) return null;
    const res = await this.guard(api.suggestions());
    if (!res || this._user?.id !== id) return null;
    this._suggestions = res;
    this.emitSuggestions();
    return res;
  }

  /** Leaves a suggestion. Throws an ApiError (a SuggestionLimitError after a few in a day). */
  async suggest(topic: SuggestionTopic, message: string) {
    try {
      const created = await api.suggest({ topic, message });
      const s = this._suggestions;
      this._suggestions = s
        ? { suggestions: [created, ...s.suggestions], total: s.total + 1, unread: s.unread }
        : { suggestions: [created], total: 1, unread: 0 };
      this.emitSuggestions();
      return created;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.expire();
      throw err;
    }
  }

  /** The member has read staff's news: nothing is unread, here and on the server. */
  markSuggestionsSeen() {
    const s = this._suggestions;
    if (!s?.unread) return;
    this._suggestions = { ...s, unread: 0, suggestions: s.suggestions.map((x) => (x.unread ? { ...x, unread: false } : x)) };
    this.emitSuggestions();
    void this.guard(api.suggestionsSeen());
  }

  private emitSuggestions() {
    for (const fn of this.suggestionListeners) fn();
  }

  /** Calls `fn` whenever the user, their tickets or their stats change. Returns an unsubscribe. */
  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Asks the server who we are. Never throws: a 401, or no server at all, means a guest. */
  async refresh(attempt = 0): Promise<User | null> {
    try {
      const { user } = await api.me();
      this.set(user);
    } catch (err) {
      if (err instanceof ApiError && err.unavailable) {
        this.warnOnce(err);
        if (attempt < RETRY_MS.length && !this._user) setTimeout(() => void this.refresh(attempt + 1), RETRY_MS[attempt]);
      }
      if (!this._known || (err instanceof ApiError && err.status === 401)) this.set(null);
    }
    return this._user;
  }

  /** Signing up means accepting the Terms and the Privacy Policy (the dialog's checkbox). */
  async signup(body: { email: string; username: string; password: string; gender: Gender }) {
    const { user } = await api.signup({ ...body, acceptTerms: true });
    this.set(user);
    return user;
  }

  /** Finishes signing up with Google: what Google doesn't tell us. Accepting the Terms, as above. */
  async googleSignup(body: { username: string; gender: Gender }) {
    const { user } = await api.googleSignup({ ...body, acceptTerms: true });
    this.set(user);
    return user;
  }

  /** Fills in what the member's account is missing (asked after logging in). */
  async updateProfile(body: { gender?: Gender; acceptTerms?: true }) {
    try {
      const { user } = await api.updateProfile(body);
      this.set(user);
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.expire();
      throw err;
    }
  }

  /** `login` is the email address or the username. */
  async login(body: { login: string; password: string }) {
    const { user } = await api.login(body);
    this.set(user);
    return user;
  }

  /** Logs out here even if the server can't be told (the cookie then expires on its own). */
  async logout() {
    try {
      await api.logout();
    } catch (err) {
      if (err instanceof ApiError) this.warnOnce(err);
    }
    this.set(null);
  }

  /** The server no longer accepts our cookie: carry on as a guest. */
  expire() {
    this.set(null);
  }

  /** Fetches the member's wallet. Resolves to null for guests or when the server is away. */
  loadTickets() {
    const user = this._user;
    if (!user) return Promise.resolve(null);
    // the booth, the HUD and a gate may all ask at once: one request answers them all
    if (this.ticketsLoading?.id === user.id) return this.ticketsLoading.p;
    const p = this.guard(api.tickets())
      .then((tickets) => {
        if (!tickets || this._user?.id !== user.id) return null;
        this._tickets = tickets;
        this.emit();
        return tickets;
      })
      .finally(() => {
        if (this.ticketsLoading?.p === p) this.ticketsLoading = null;
      });
    this.ticketsLoading = { id: user.id, p };
    return p;
  }

  /** Fetches the member's rounds and bests. Resolves to null for guests or when the server is away. */
  async loadStats() {
    const id = this._user?.id;
    if (!id) return null;
    const stats = await this.guard(api.stats());
    if (!stats || this._user?.id !== id) return null;
    this._stats = stats;
    this.emit();
    return stats;
  }

  /** Fetches the member's latest purchases. Resolves to null for guests or when the server is away. */
  async loadPurchases() {
    const id = this._user?.id;
    if (!id) return null;
    const res = await this.guard(api.purchases(RECENT_PURCHASES));
    if (!res || this._user?.id !== id) return null;
    this._purchases = res.purchases.slice(0, RECENT_PURCHASES);
    this.emit();
    return this._purchases;
  }

  /**
   * Buys a pack. Throws an ApiError (a PurchaseCooldownError if the next pack isn't due yet, which
   * also updates the countdown here).
   */
  async buy() {
    try {
      const res = await api.purchase();
      const prev = this._tickets;
      this._tickets = {
        // the ads' rules and count
        ...prev,
        balance: res.balance,
        packSize: prev?.packSize ?? this._park?.packSize ?? res.purchase.quantity,
        cooldownHours: prev?.cooldownHours ?? this.cooldownHours,
        ticketCap: this.ticketCap,
        lastPurchaseAt: res.purchase.createdAt,
        nextPurchaseAt: res.nextPurchaseAt,
        canBuy: res.canBuy,
        costs: prev?.costs ?? { ...DEFAULT_COSTS, ...this._park?.costs },
      };
      this._purchases = [{ ...res.purchase, balanceAfter: res.balance }, ...(this._purchases ?? [])].slice(0, RECENT_PURCHASES);
      this.emit();
      return res;
    } catch (err) {
      if (err instanceof ParkClosedError) this.noteParkClosed(err);
      if (err instanceof PurchaseCooldownError && this._tickets) {
        this._tickets = { ...this._tickets, canBuy: false, nextPurchaseAt: err.nextPurchaseAt ?? this._tickets.nextPurchaseAt };
        this.emit();
      }
      if (err instanceof TicketCapError && this._tickets) {
        this._tickets = { ...this._tickets, balance: err.balance ?? this._tickets.balance, ticketCap: err.ticketCap ?? this._tickets.ticketCap };
        this.emit();
      }
      if (err instanceof ApiError && err.status === 401) this.expire();
      throw err;
    }
  }

  /** Tells the server a rewarded ad is about to play (ads.ts plays it). Throws an ApiError (an AdLimitError once the day's are used up). */
  async startAd() {
    try {
      return await api.startAd();
    } catch (err) {
      this.noteAdError(err);
      throw err;
    }
  }

  /** The ad was watched to the end: its tickets go on the balance. Throws an ApiError. */
  async rewardAd(id: string) {
    try {
      const res = await api.rewardAd(id);
      if (this._tickets) this._tickets = { ...this._tickets, balance: res.balance, adsLeft: res.adsLeft, nextAdAt: res.nextAdAt };
      else void this.loadTickets();
      this._purchases = [{ ...res.purchase, balanceAfter: res.balance }, ...(this._purchases ?? [])].slice(0, RECENT_PURCHASES);
      this.emit();
      return res;
    } catch (err) {
      this.noteAdError(err);
      throw err;
    }
  }

  private noteAdError(err: unknown) {
    if (err instanceof ParkClosedError) this.noteParkClosed(err);
    if (err instanceof AdLimitError && this._tickets) {
      this._tickets = { ...this._tickets, adsLeft: 0, nextAdAt: err.nextAt };
      this.emit();
    }
    // the free pack came ready, or ads were switched off, since we last looked
    else if (err instanceof ApiError && err.status === 409) void this.loadTickets();
    if (err instanceof ApiError && err.status === 401) this.expire();
  }

  /**
   * Pays for a round of `ride` and opens it. Throws an ApiError (a NotEnoughTicketsError when the
   * wallet is short, which also corrects the balance here).
   */
  async board(ride: AttractionId) {
    try {
      const res = await api.board(ride);
      if (this._tickets) this._tickets = { ...this._tickets, balance: res.balance };
      else void this.loadTickets();
      this.emit();
      return res;
    } catch (err) {
      if (err instanceof ParkClosedError) this.noteParkClosed(err);
      if (err instanceof RideClosedError) this.noteRideClosed(ride, err);
      if (err instanceof NotEnoughTicketsError && err.balance !== null && this._tickets) {
        this._tickets = { ...this._tickets, balance: err.balance };
        this.emit();
      }
      throw err;
    }
  }

  /** Closes a round with its stats. Throws an ApiError when it can't be saved. */
  async finish(roundId: string, completed: boolean, stats: RoundStats): Promise<FinishedRound> {
    const res = await api.finish(roundId, { completed, stats });
    // the totals and bests changed: refresh them quietly if anything shows them
    if (this._stats) void this.loadStats();
    return res;
  }

  /** Closes a round as the page goes away (the tab closing): sent without waiting for an answer. */
  finishOnExit(roundId: string, completed: boolean, stats: RoundStats) {
    api.finishOnExit(roundId, { completed, stats });
  }

  /**
   * The round's attraction (or the park) closed while it was played: ends it and puts its tickets
   * back. Resolves to how many came back, or null if the server wouldn't (it opened again, say).
   */
  async refund(roundId: string): Promise<number | null> {
    const res = await this.guard(api.refund(roundId));
    if (!res) return null;
    if (this._tickets) this._tickets = { ...this._tickets, balance: res.balance };
    else void this.loadTickets();
    this.emit();
    return res.refunded;
  }


  /**
   * Deletes the account for good, then carries on as a guest. Confirmed with the password, or for an
   * account made with Google, the username. Throws an ApiError (401 = wrong password).
   */
  async deleteAccount(confirmation: { password: string } | { confirm: string }) {
    await api.deleteAccount(confirmation);
    this.set(null);
  }

  /** Resolves a member-only request, or null when it fails (a 401 also drops back to guest). */
  private async guard<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.expire();
      return null;
    }
  }

  // ---------- Creators' Valley and the Coaster Workshop ----------

  /** The player-built coasters running in Creators' Valley (from the park's state; none until it's known). */
  get creations(): readonly ParkCreation[] {
    return this._park?.creations ?? [];
  }

  /** The coaster running on plot n, if any. */
  creationOn(plot: number) {
    return this.creations.find((c) => c.plot === plot) ?? null;
  }

  /** Calls `fn` when a coaster is released into Creators' Valley, replaced or taken out. Returns an unsubscribe. */
  onCreations(fn: Listener) {
    this.creationListeners.add(fn);
    return () => void this.creationListeners.delete(fn);
  }

  /** Calls `fn` when a coaster part's price or stock changes. Returns an unsubscribe. */
  onWorkshop(fn: Listener) {
    this.workshopListeners.add(fn);
    return () => void this.workshopListeners.delete(fn);
  }

  /** The coasters the member sent to staff (newest first) and how many have unseen news, once loaded. */
  get myCreations() {
    return this._myCreations;
  }

  /** Calls `fn` when the member's coasters change (news from staff). Returns an unsubscribe. */
  onMyCreations(fn: Listener) {
    this.myCreationListeners.add(fn);
    return () => void this.myCreationListeners.delete(fn);
  }

  /** Fetches the member's coasters. Resolves to null for guests or when the server is away. */
  async loadMyCreations() {
    const id = this._user?.id;
    if (!id) return null;
    const res = await this.guard(api.myCreations());
    if (!res || this._user?.id !== id) return null;
    this._myCreations = res;
    for (const fn of this.myCreationListeners) fn();
    return res;
  }

  /** The member read staff's news about their coasters. */
  async creationsSeen() {
    const c = this._myCreations;
    if (!c?.unread) return;
    this._myCreations = { creations: c.creations.map((x) => ({ ...x, unread: false })), unread: 0 };
    for (const fn of this.myCreationListeners) fn();
    await this.guard(api.creationsSeen());
  }

  /** The wallet after paying for coaster parts in the Coaster Workshop. */
  setBalance(balance: number) {
    if (this._tickets) this._tickets = { ...this._tickets, balance };
    else void this.loadTickets();
    this.emit();
  }

  private set(user: User | null) {
    const switched = user?.id !== this._user?.id;
    const changed = !this._known || switched || user?.username !== this._user?.username || user?.role !== this._user?.role;
    if (switched) {
      this._tickets = null;
      this._stats = null;
      this._purchases = null;
      this._souvenirs = null;
      this._orders = null;
      this._suggestions = null;
      this._myCreations = null;
    }
    this._user = user;
    this._known = true;
    // the stream knows who's listening by the cookie: a new member (or a guest again) reconnects
    if (switched && this.live) this.openLive();
    if (changed) this.emit();
    // a new member: their wallet shows in the HUD straight away, and their souvenirs on them
    if (switched && user) {
      void this.loadTickets();
      void this.loadSouvenirs();
      // staff may have answered one of their ideas while they were away
      void this.loadSuggestions();
      // …and released (or declined) one of their coasters
      void this.loadMyCreations();
    }
    if (switched) this.emitSuggestions();
    if (switched) for (const fn of this.myCreationListeners) fn();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private warnOnce(err: ApiError) {
    if (this.warned) return;
    this.warned = true;
    console.warn(`The Funfair: the accounts server is unavailable (${err.status || 'offline'}), so the attractions are closed for now.`);
  }
}

export const session = new Session();

/** The JSON in a server-sent event, or null if it isn't any. */
function parseEvent<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/** GET /park's answer, with anything missing or malformed falling back to the usual rules. */
function normalisePark(raw: Park): Park {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  const cap = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  const costs: Park['costs'] = {};
  for (const id of Object.keys(DEFAULT_COSTS) as AttractionId[]) {
    const c = raw?.costs?.[id];
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) costs[id] = c;
  }
  const open = raw?.open !== false;
  const message = !open && typeof raw?.message === 'string' && raw.message.trim() ? raw.message.trim() : null;
  const maintenance: Park['maintenance'] = {};
  const closed = raw?.maintenance && typeof raw.maintenance === 'object' ? raw.maintenance : {};
  for (const id of Object.keys(DEFAULT_COSTS) as AttractionId[]) {
    if (!(id in closed)) continue;
    const sign = closed[id];
    maintenance[id] = typeof sign === 'string' && sign.trim() ? sign.trim() : null;
  }
  const underMaintenance = raw?.underMaintenance === true;
  const maintenanceMessage =
    underMaintenance && typeof raw?.maintenanceMessage === 'string' && raw.maintenanceMessage.trim() ? raw.maintenanceMessage.trim() : null;
  // the coasters running in Creators' Valley: one per plot, each with its id, name and creator
  const creations: ParkCreation[] = [];
  for (const c of Array.isArray(raw?.creations) ? raw.creations : []) {
    const plot = c?.plot;
    if (!Number.isInteger(plot) || plot < 1 || plot > PLOT_IDS.length || creations.some((x) => x.plot === plot)) continue;
    if (typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.creator !== 'string') continue;
    creations.push({ plot, id: c.id, name: c.name, creator: c.creator });
  }
  return {
    open,
    message,
    underMaintenance,
    maintenanceMessage,
    costs,
    packSize: num(raw?.packSize, PACK_SIZE),
    cooldownHours: num(raw?.cooldownHours, COOLDOWN_HOURS),
    ticketCap: cap(raw?.ticketCap),
    // an older server without ads: none
    adTickets: Math.floor(num(raw?.adTickets, 0)),
    adsPerDay: Math.floor(num(raw?.adsPerDay, 0)),
    maintenance,
    creations,
  };
}

/** "03:12:45" for a wait of that long (the booth's countdown to the next pack). */
export function formatWait(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
