// The Ringmaster's Office (/ringmaster): the fair's back office. Staff sign in with their fair
// account; the server checks the role on every request (a player gets a 403), this page only
// decides what to show. While staff are in, the page keeps a live stream open (GET /api/live):
// what players do in the fair, and what other staff change here, refreshes the view on screen.
import './ringmaster.css';
import { AccessBlockedError, api, ApiError, LIVE_URL, onAccessBlocked, ringmaster, type AccountNews, type User, type Visitors } from '../account/api';
import { AttractionsView } from './attractions';
import { CreationsView } from './creations';
import { GatesView } from './gates';
import { IdeasView } from './ideas';
import { LedgerView } from './ledger';
import { LogbookView } from './logbook';
import { MembersView } from './members';
import { OverviewView } from './overview';
import { ShopView } from './shop';
import { TrailView } from './trail';
import { errorText, isEditing, num, setApiErrorHandler, toast } from './util';

type Tab = 'overview' | 'attractions' | 'trail' | 'shop' | 'ideas' | 'creations' | 'gates' | 'members' | 'ledger' | 'logbook';
const TABS: Tab[] = ['overview', 'attractions', 'trail', 'shop', 'ideas', 'creations', 'gates', 'members', 'ledger', 'logbook'];
type Gate = 'loading' | 'login' | 'denied' | 'offline' | 'private';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsNav = $('tabs');
const whoami = $('whoami');
const logoutBtn = $<HTMLButtonElement>('logout');
const loginForm = $<HTMLFormElement>('login-form');
const loginError = $('login-error');

let me: User | null = null;
let current: Tab = 'overview';

const views = {
  overview: new OverviewView($('view-overview')),
  attractions: new AttractionsView($('view-attractions')),
  trail: new TrailView($('view-trail')),
  shop: new ShopView($('view-shop')),
  ideas: new IdeasView($('view-ideas'), (counts) => renderIdeasBadge(counts.pending)),
  creations: new CreationsView($('view-creations'), (counts) => renderCreationsBadge(counts.pending)),
  gates: new GatesView($('view-gates')),
  members: new MembersView($('view-members'), () => me),
  ledger: new LedgerView($('view-ledger')),
  logbook: new LogbookView($('view-logbook')),
};

// ---------- Live ----------

/** What each kind of news touches. Only the view on screen is refreshed: the others load fresh when opened. */
const AFFECTS: Record<string, Tab[]> = {
  members: ['overview', 'members'],
  // the Coaster Workshop's parts sell as purchases too
  purchases: ['overview', 'members', 'ledger', 'shop', 'creations'],
  rounds: ['overview', 'members', 'ledger', 'trail'],
  logbook: ['logbook', 'overview', 'members'],
  // a plot's price or switch, or a coaster going up or coming down
  park: ['overview', 'attractions', 'gates', 'creations'],
  shop: ['shop'],
  suggestions: ['ideas'],
  access: ['gates'],
  trail: ['trail', 'logbook'],
  creations: ['creations'],
  workshop: ['creations'],
};
/** News is gathered this long, then the view is refreshed once. */
const SETTLE_MS = 800;
/** The overview runs the heaviest queries: at most once this often. */
const OVERVIEW_MS = 5_000;
/** While staff are editing, the refresh waits and looks again this often. */
const EDITING_MS = 3_000;
/** Who's in the fair is also looked up this often (a tab that vanished stops counting after a minute, without a word). */
const VISITORS_MS = 30_000;

const livePill = $('live');
let live: EventSource | null = null;
let lastPark = '';
const stale = new Set<Tab>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let overviewAt = 0;
let visitors: Visitors | null = null;
let visitorsTimer: ReturnType<typeof setInterval> | null = null;
let visitorsLoading = false;

function openLive() {
  if (live || typeof EventSource === 'undefined') return;
  const source = new EventSource(LIVE_URL, { withCredentials: true });
  source.addEventListener('open', () => {
    renderLive();
    void loadVisitors();
  });
  source.addEventListener('error', renderLive);
  source.addEventListener('office', (e) => {
    const kinds = parse<{ kinds?: unknown }>(e)?.kinds;
    if (!Array.isArray(kinds)) return;
    if (kinds.includes('visitors')) void loadVisitors();
    touched(kinds.filter((k): k is string => typeof k === 'string'));
  });
  // the park comes on every (re)connect: only a real change counts
  source.addEventListener('park', (e) => {
    const data = (e as MessageEvent<string>).data;
    if (lastPark && data !== lastPark) touched(['park']);
    lastPark = data;
  });
  // a price or the stock changed (here, or an item sold)
  source.addEventListener('shop', () => touched(['shop']));
  // the same for the Coaster Workshop's parts
  source.addEventListener('workshop', () => touched(['workshop']));
  // private access was switched on, or this address taken off the list, by another member of staff
  source.addEventListener('blocked', (e) => {
    const b = parse<{ message?: unknown; ip?: unknown }>(e);
    shutOut(typeof b?.message === 'string' ? b.message : null, typeof b?.ip === 'string' ? b.ip : null);
  });
  // made a player (or deleted) by another member of staff: the door closes at once
  source.addEventListener('account', (e) => {
    const news = parse<AccountNews>(e);
    if (!news || !me) return;
    if ('deleted' in news) {
      setUser(null);
      toast('Your account was deleted.', true);
      return showGate('login');
    }
    if (news.role !== 'admin') {
      me = { ...me, role: news.role };
      deny(me);
    }
  });
  live = source;
  visitorsTimer ??= setInterval(() => void loadVisitors(), VISITORS_MS);
  renderLive();
}

function closeLive() {
  live?.close();
  live = null;
  lastPark = '';
  visitors = null;
  if (visitorsTimer) clearInterval(visitorsTimer);
  visitorsTimer = null;
  livePill.hidden = true;
}

/** The header: whether the office is live, and how many players are in the fair right now. */
function renderLive() {
  if (!live) return;
  const on = live.readyState === EventSource.OPEN;
  livePill.hidden = false;
  livePill.classList.toggle('is-on', on);
  if (!on) {
    livePill.textContent = 'Reconnecting…';
    livePill.title = 'Live updates paused: reconnecting';
    return;
  }
  if (!visitors) {
    livePill.textContent = 'Live';
    livePill.title = 'Changes in the fair show up here as they happen';
    return;
  }
  const v = visitors;
  livePill.textContent = `Live · ${v.inFair.toLocaleString()} in the fair`;
  livePill.title = `${v.inFair.toLocaleString()} ${v.inFair === 1 ? 'player' : 'players'} in the fair right now: ${v.members.toLocaleString()} ${
    v.members === 1 ? 'member' : 'members'
  } and ${v.guests.toLocaleString()} ${v.guests === 1 ? 'guest' : 'guests'}${v.atEntrance ? `, plus ${v.atEntrance.toLocaleString()} at the entrance` : ''}.`;
}

async function loadVisitors() {
  if (visitorsLoading || !live || document.hidden) return;
  visitorsLoading = true;
  try {
    visitors = await ringmaster.visitors();
    renderLive();
  } catch {
    // the count waits for the next look; the rest of the office reports its own errors
  } finally {
    visitorsLoading = false;
  }
}

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/** Something happened: the view on screen catches up shortly (the rest when they're opened). */
function touched(kinds: string[]) {
  // the Ideas and Creations tabs' badges keep count wherever staff are in the office
  if (kinds.includes('suggestions') && current !== 'ideas') void views.ideas.loadCounts();
  if (kinds.includes('creations') && current !== 'creations') void views.creations.loadCounts();
  for (const k of kinds) for (const tab of AFFECTS[k] ?? []) stale.add(tab);
  scheduleRefresh(SETTLE_MS);
}

function scheduleRefresh(ms: number) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshCurrent();
  }, ms);
}

function refreshCurrent() {
  const tab = current;
  if (!stale.has(tab) || !me || me.role !== 'admin' || tabsNav.hidden) return;
  if (document.hidden) return; // caught up when the page is looked at again
  const el = $(`view-${tab}`);
  // never under someone's fingers: a field being typed in, a change not saved yet, or a question being asked
  if (isEditing(el) || document.querySelector('dialog[open]')) return scheduleRefresh(EDITING_MS);
  if (tab === 'overview') {
    const wait = overviewAt + OVERVIEW_MS - Date.now();
    if (wait > 0) return scheduleRefresh(wait);
    overviewAt = Date.now();
  }
  stale.delete(tab);
  void views[tab].refresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refreshCurrent();
  void loadVisitors();
});

/** The Ideas tab's badge: how many suggestions are waiting for an answer. */
function renderIdeasBadge(waiting: number) {
  const badge = $('ideas-badge');
  badge.hidden = !waiting;
  badge.textContent = num(waiting);
  badge.title = `${num(waiting)} waiting for an answer`;
}

/** The Creations tab's badge: how many coasters are waiting for a look. */
function renderCreationsBadge(waiting: number) {
  const badge = $('creations-badge');
  badge.hidden = !waiting;
  badge.textContent = num(waiting);
  badge.title = `${num(waiting)} waiting for a look`;
}

/** Shows one of the doors (or none, once staff are in). */
function showGate(gate: Gate | null) {
  if (gate === null) {
    openLive();
    void views.ideas.loadCounts();
    void views.creations.loadCounts();
  } else closeLive();
  for (const g of ['loading', 'login', 'denied', 'offline', 'private'] as const) $(`gate-${g}`).hidden = g !== gate;
  tabsNav.hidden = gate !== null;
  if (gate !== null) for (const v of document.querySelectorAll<HTMLElement>('.view')) v.hidden = true;
}

function setUser(user: User | null) {
  me = user;
  whoami.hidden = !user;
  logoutBtn.hidden = !user;
  whoami.textContent = user ? `${user.role === 'admin' ? '🎩 ' : ''}${user.username}` : '';
}

/** Who's at the door: staff go in, players are turned away, guests get the login form. */
async function knock() {
  showGate('loading');
  try {
    const { user } = await api.me();
    setUser(user);
    if (user.role !== 'admin') return deny(user);
    showGate(null);
    route();
  } catch (err) {
    if (err instanceof AccessBlockedError) return; // the private door is showing
    setUser(null);
    if (err instanceof ApiError && err.status === 401) return showGate('login');
    $('offline-text').textContent = errorText(err);
    showGate('offline');
  }
}

/** Private access turned this address away (staff or not): the private door, for good until a reload. */
function shutOut(message: string | null, ip: string | null) {
  if (message) $('private-text').textContent = message;
  const note = $('private-ip');
  note.hidden = !ip;
  note.textContent = ip ? `This address: ${ip}. Another member of staff can add it in Park gates, or switch private access off.` : '';
  showGate('private');
}
onAccessBlocked((err) => shutOut(err.message, err.ip));

function deny(user: User) {
  $('denied-text').textContent = `You're signed in as ${user.username}, a player. This door is for the people who run the fair.`;
  showGate('denied');
}

/** #overview, #members, #members/<id>… */
function route() {
  if (!me || me.role !== 'admin') return;
  const [rawTab, param] = location.hash.replace(/^#/, '').split('/');
  const tab: Tab = (TABS as string[]).includes(rawTab) ? (rawTab as Tab) : 'overview';
  for (const a of tabsNav.querySelectorAll<HTMLAnchorElement>('a[data-tab]')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  current = tab;
  stale.delete(tab); // it loads fresh now
  for (const v of document.querySelectorAll<HTMLElement>('.view')) v.hidden = v.dataset.view !== tab;
  document.title = `${tabsNav.querySelector(`a[data-tab="${tab}"]`)?.firstChild?.textContent?.trim().replace(/^\S+\s/, '') ?? 'Office'} · The Ringmaster's Office`;
  if (tab === 'members') views.members.show(param ? decodeURIComponent(param) : undefined);
  else views[tab].show();
}

// A lost session or role mid-visit sends staff back to the door; anything else is a toast.
setApiErrorHandler((err) => {
  if (err instanceof AccessBlockedError) return; // the private door is showing
  if (err instanceof ApiError && err.status === 401) {
    setUser(null);
    toast('Your session ended. Log in again.', true);
    return showGate('login');
  }
  if (err instanceof ApiError && err.status === 403 && me) {
    me = { ...me, role: 'player' };
    return deny(me);
  }
  toast(errorText(err), true);
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(loginForm);
  const login = String(data.get('login') ?? '').trim();
  const password = String(data.get('password') ?? '');
  if (!login || !password) {
    loginError.textContent = 'Enter your email or username, and your password.';
    return;
  }
  const button = loginForm.querySelector<HTMLButtonElement>('[type="submit"]')!;
  button.disabled = true;
  loginError.textContent = '';
  try {
    const { user } = await api.login({ login, password });
    loginForm.reset();
    setUser(user);
    if (user.role !== 'admin') return deny(user);
    showGate(null);
    route();
    $('main').focus();
  } catch (err) {
    // an account made with Google has no password: it logs in at the fair, and the office shares that session
    const google = err instanceof ApiError && /google/i.test(err.message);
    loginError.textContent = google
      ? 'This account signs in with Google: continue with Google in the fair, then come back here.'
      : err instanceof ApiError && err.status === 401
        ? 'Those details don’t match.'
        : errorText(err);
  } finally {
    button.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  try {
    await api.logout();
  } catch {
    // the cookie expires on its own
  }
  logoutBtn.disabled = false;
  setUser(null);
  showGate('login');
});

$('retry').addEventListener('click', () => void knock());
window.addEventListener('hashchange', route);
void knock();
