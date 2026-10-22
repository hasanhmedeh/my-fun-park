// The visitor's own look (which person they play, their outfit's colours, hair tint, height and
// build), as made in the customiser. Guests keep it in this browser; members keep it on their
// account too (PATCH /auth/me), so it follows them to any browser. The rules:
// - a member's look on the account wins over the browser's when they log in (and is copied here,
//   so the next visit shows it before the server answers);
// - a member with none on the account gets the browser's, uploaded once as they log in;
// - logging out keeps the browser's copy, so the visitor stays who they were.
//
// get() can be null (nothing saved yet), and a saved look can name an avatar the manifest no longer
// lists as playable: the game then starts from defaultLook(). Nothing here loads any avatar.
import { api, ApiError, type Gender } from '../account/api';
import { session } from '../account/session';
import { VISITOR_LOOK_LIMITS, type AvatarSpec, type VisitorLook } from './crowd/people-manifest';

const STORAGE_KEY = 'funfair.visitorLook';
/** Changes made while dragging a slider are saved once it rests this long (or when the page is hidden). */
const SAVE_MS = 1000;
const COLOURS = ['top', 'bottom', 'shoes', 'hair'] as const;
const KEYS: readonly string[] = ['v', 'avatar', ...COLOURS, 'height', 'build'];

/**
 * A clean copy of a look, or null when it isn't one the server would take (the same limits as
 * VISITOR_LOOK_LIMITS, which the API mirrors). Colours may come in any case and are lowercased;
 * height and build are rounded to 1/1000 first, so a slider's float noise doesn't put 1.08 out of
 * range. Any other key, a missing one, or a wrong type makes it null.
 */
export function cleanLook(raw: unknown): VisitorLook | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== KEYS.length || keys.some((k) => !KEYS.includes(k))) return null;
  if (o.v !== 1 || typeof o.avatar !== 'string' || !VISITOR_LOOK_LIMITS.avatarId.test(o.avatar)) return null;
  const colour = (v: unknown) => {
    if (v === null) return null;
    const c = typeof v === 'string' ? v.toLowerCase() : '';
    return VISITOR_LOOK_LIMITS.colour.test(c) ? c : undefined;
  };
  const scale = (v: unknown, [min, max]: readonly [number, number]) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    const r = Math.round(v * 1000) / 1000;
    return r >= min && r <= max ? r : undefined;
  };
  const [top, bottom, shoes, hair] = COLOURS.map((k) => colour(o[k]));
  const height = scale(o.height, VISITOR_LOOK_LIMITS.height);
  const build = scale(o.build, VISITOR_LOOK_LIMITS.build);
  if (top === undefined || bottom === undefined || shoes === undefined || hair === undefined) return null;
  if (height === undefined || build === undefined) return null;
  return { v: 1, avatar: o.avatar, top, bottom, shoes, hair, height, build };
}

/**
 * A look to start from when there is none (or its avatar is no longer playable): a random playable
 * avatar of the member's gender when they told us one, otherwise any, in its own colours at its
 * own size. Pass a seeded `random` (world/random.ts) to give the same visitor the same pick on
 * every visit. Null only when `playable` is empty.
 */
export function defaultLook(
  gender: Gender | null | undefined,
  playable: readonly Pick<AvatarSpec, 'id' | 'gender'>[],
  random: () => number = Math.random,
): VisitorLook | null {
  const want = gender === 'female' ? 'f' : gender === 'male' ? 'm' : null;
  const theirs = want ? playable.filter((a) => a.gender === want) : [];
  const pool = theirs.length ? theirs : playable;
  if (!pool.length) return null;
  const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return { v: 1, avatar: pick.id, top: null, bottom: null, shoes: null, hair: null, height: 1, build: 1 };
}

const same = (a: VisitorLook | null, b: VisitorLook | null) => JSON.stringify(a) === JSON.stringify(b);

function load(): VisitorLook | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? cleanLook(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function store(look: VisitorLook) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(look));
  } catch {
    /* storage blocked: it lasts until the page closes (and on the account, for a member) */
  }
}

class VisitorLookStore {
  private look: VisitorLook | null = load();
  private listeners = new Set<(look: VisitorLook | null) => void>();
  /** The member whose account the look was last matched with (null for a guest); undefined before the first check. */
  private userId: string | null | undefined = undefined;
  /** A change not written yet: to this browser, and to `account`'s account (a member's id) when not null. */
  private unsaved: { account: string | null } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;

  constructor() {
    session.onChange(() => this.follow());
    this.follow();
    // the tab closing (or going to the background, where it may be closed unseen) saves at once
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush(true));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.flush(true);
      });
    }
  }

  /** The look to wear: the account's for a member who has one, else this browser's; null when none was ever made. */
  get(): VisitorLook | null {
    return this.look;
  }

  /**
   * Wears a new look (listeners hear of it straight away) and saves it shortly after: in this
   * browser, and on the account when a member is logged in. Throws a RangeError for a look the
   * server wouldn't take (see cleanLook).
   */
  set(look: VisitorLook) {
    const clean = cleanLook(look);
    if (!clean) throw new RangeError(`Not a visitor look: ${JSON.stringify(look)?.slice(0, 200)}`);
    if (same(clean, this.look)) return;
    this.look = clean;
    this.unsaved = { account: this.accountId() };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_MS);
    this.emit();
  }

  /** Saves a waiting change now instead of after the debounce (the customiser closing, say). */
  saveNow() {
    this.flush();
  }

  /** Calls `fn` with the new look whenever it changes: set() here, or a member's own look arriving as they log in. Returns an unsubscribe. */
  onChange(fn: (look: VisitorLook | null) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The member logged in now whose account can keep a look (an older server can't), or null. */
  private accountId() {
    const user = session.user;
    return user && user.visitorLook !== undefined ? user.id : null;
  }

  /** Someone logged in or out (or the session was first heard): match the look with the account. */
  private follow() {
    const user = session.user;
    const id = user?.id ?? null;
    if (id === this.userId) return;
    this.userId = id;
    // a change waiting for whoever was here before can't go to this account: it stays in the browser
    if (this.unsaved?.account && this.unsaved.account !== id) this.unsaved = { account: null };
    if (!user || user.visitorLook === undefined) return;
    const theirs = cleanLook(user.visitorLook);
    if (theirs) {
      // the account's look wins, and this browser remembers it too
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.unsaved = null;
      store(theirs);
      if (same(theirs, this.look)) return;
      this.look = theirs;
      this.emit();
    } else if (this.look) {
      // a member without one takes this browser's, once
      this.unsaved = { account: id };
      this.flush();
    }
  }

  /** Writes what's waiting: to this browser, and to the account (as a keepalive request when the page is going). */
  private flush(leaving = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.unsaved;
    const look = this.look;
    if (!pending || !look) return;
    this.unsaved = null;
    store(look);
    // only ever to the member it was made for: never to someone who logged in since
    const account = pending.account;
    if (!account || account !== session.user?.id) return;
    if (leaving) return api.saveLookOnExit(look);
    session.updateProfile({ visitorLook: look }).catch((err: unknown) => {
      // the server is away: try again with the next change, or as the page closes
      if (err instanceof ApiError && err.unavailable) {
        this.unsaved ??= { account };
        return;
      }
      // a 401 has already dropped back to a guest; anything else means the server disagrees with cleanLook
      if (!(err instanceof ApiError && err.status === 401) && !this.warned) {
        this.warned = true;
        console.warn('The Funfair: the account could not keep the visitor’s look, so it stays in this browser.', err);
      }
    });
  }

  private emit() {
    for (const fn of this.listeners) fn(this.look);
  }
}

/** The visitor's look: get(), set(look), onChange(fn). */
export const visitorLook = new VisitorLookStore();
