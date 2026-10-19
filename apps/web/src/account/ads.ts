// Free tickets for watching an ad, through Google's H5 Games Ads (the Ad Placement API, part of
// AdSense). Once the free pack isn't ready, the member can ask for one ("Watch an ad · +5 🎟️"):
// the server opens an ad view, Google plays a rewarded ad, and once it has been watched to the end
// the server pays its tickets (session.rewardAd).
//
// VITE_ADSENSE_CLIENT (the AdSense publisher id, ca-pub-…) switches the ads on; VITE_ADSENSE_TEST=on
// serves Google's test ads. Without a publisher id there are no ads, except under `pnpm dev`, where
// a stand-in ad plays so the whole flow can be tried. Google's script only loads once a member asks
// for an ad: guests, and members who never do, don't load it at all.
import { ADSENSE_CLIENT as CLIENT, ADSENSE_TEST as TEST, adsEnabled, STAND_IN_ADS as STAND_IN } from './ads-config';
import { AdLimitError, ApiError, ParkClosedError } from './api';
import { session } from './session';

export { adsEnabled };

/** How long the stand-in ad runs. */
const STAND_IN_SECONDS = 6;
/** Waiting this long for Google to start an ad, it counts as none available. */
const NO_AD_MS = 12_000;

/** How the ad break ended (Google's placementInfo.breakStatus). */
type BreakStatus = 'notReady' | 'timeout' | 'invalid' | 'error' | 'noAdPreloaded' | 'frequencyCapped' | 'ignored' | 'other' | 'dismissed' | 'viewed';

interface RewardBreak {
  type: 'reward';
  name: string;
  beforeAd: () => void;
  afterAd: () => void;
  beforeReward: (showAdFn: () => void) => void;
  adDismissed: () => void;
  adViewed: () => void;
  adBreakDone: (placementInfo: { breakStatus: BreakStatus }) => void;
}

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

/** Google's adBreak() and adConfig() are both a push onto its queue. */
const push = (o: object) => (window.adsbygoogle ??= []).push(o);

let loading: Promise<boolean> | null = null;

/** Loads Google's ad script, once. False when it can't (an ad blocker, say). */
function loadGoogle(): Promise<boolean> {
  return (loading ??= new Promise<boolean>((resolve) => {
    window.adsbygoogle ??= [];
    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CLIENT)}`;
    if (TEST) script.dataset.adbreakTest = 'on';
    script.onload = () => {
      push({ preloadAdBreaks: 'on' });
      resolve(true);
    };
    script.onerror = () => {
      // let the next ask try again
      script.remove();
      loading = null;
      resolve(false);
    };
    document.head.append(script);
  }));
}

export type AdOutcome =
  /** Watched to the end, and paid: `tickets` added, `balance` now. */
  | { kind: 'paid'; tickets: number; balance: number }
  /** Closed before the end: no tickets. */
  | { kind: 'dismissed' }
  /** No ad to show right now (none ready, or Google's frequency cap). */
  | { kind: 'none' }
  /** Google's script didn't load, most likely an ad blocker. */
  | { kind: 'blocked' }
  /** The server said no (the day's ads used up, the pack ready, the park closed…): `message` says why. */
  | { kind: 'refused'; message: string; error: unknown };

/**
 * Plays one rewarded ad and, if it was watched to the end, collects its tickets. `hush` quiets the
 * fair while the ad plays (and brings it back after); `muted` is whether the visitor turned the
 * sound off, which the ad follows.
 */
export async function watchAd(o: { hush: (on: boolean) => void; muted: boolean }): Promise<AdOutcome> {
  if (!adsEnabled) return { kind: 'none' };
  if (CLIENT && !(await loadGoogle())) return { kind: 'blocked' };
  let view: { id: string; tickets: number };
  try {
    view = await session.startAd();
  } catch (err) {
    return refused(err);
  }
  const status = STAND_IN ? await standIn(o.hush) : await googleAd(o);
  if (status === 'dismissed') return { kind: 'dismissed' };
  if (status !== 'viewed') return { kind: 'none' };
  try {
    const { purchase, balance } = await session.rewardAd(view.id);
    return { kind: 'paid', tickets: purchase.quantity, balance };
  } catch (err) {
    return refused(err);
  }
}

/** One of Google's rewarded ads, shown at once (the member already asked for it). */
function googleAd(o: { hush: (on: boolean) => void; muted: boolean }): Promise<BreakStatus> {
  return new Promise((resolve) => {
    let playing = false;
    let done = false;
    const finish = (status: BreakStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(status);
    };
    // nothing at all from Google (not even adBreakDone): no ad
    const timer = setTimeout(() => {
      if (!playing) finish('timeout');
    }, NO_AD_MS);
    push({ sound: o.muted ? 'off' : 'on' });
    const ad: RewardBreak = {
      type: 'reward',
      name: 'free-tickets',
      beforeReward: (showAdFn) => showAdFn(),
      beforeAd: () => {
        playing = true;
        o.hush(true);
      },
      afterAd: () => o.hush(false),
      adViewed: () => finish('viewed'),
      adDismissed: () => finish('dismissed'),
      adBreakDone: ({ breakStatus }) => finish(breakStatus),
    };
    push(ad);
  });
}

/** What to tell the member when an ad didn't pay out. */
export function adMessage(r: Exclude<AdOutcome, { kind: 'paid' }>) {
  switch (r.kind) {
    case 'dismissed':
      return 'Closed before the end, so no tickets for that one. Watch an ad all the way through and they’re yours.';
    case 'none':
      return 'No ads ready just now. Try again in a minute!';
    case 'blocked':
      return 'The ad couldn’t load: is an ad blocker on? Let ads through for the fair to get tickets for them.';
    case 'refused':
      return r.message;
  }
}

/** What the member is told when the server turned the ad (or its tickets) down. */
function refused(err: unknown): AdOutcome {
  const code = err instanceof ApiError ? (err.data as { code?: unknown } | null)?.code : undefined;
  const message =
    err instanceof AdLimitError
      ? `That's all the ads for today. ${err.nextAt ? `The next one's ready at ${new Date(err.nextAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.` : 'Come back tomorrow!'}`
      : err instanceof ParkClosedError
        ? err.message
        : code === 'pack_ready'
          ? 'Your free pack is ready at the Ticket Booth: take that first!'
          : code === 'ads_off'
            ? 'There are no ads to watch for tickets right now.'
            : err instanceof ApiError && err.status === 401
              ? 'Your session ran out. Log in again to get tickets.'
              : err instanceof ApiError && !err.unavailable
                ? err.message
                : 'The ticket office isn’t answering. Try again in a moment?';
  return { kind: 'refused', message, error: err };
}

/** Under `pnpm dev`: a few seconds of "ad" over the game, with a close button that forfeits the tickets. */
function standIn(hush: (on: boolean) => void): Promise<BreakStatus> {
  return new Promise((resolve) => {
    hush(true);
    const el = document.createElement('div');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Ad');
    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(10,12,24,.92);color:#fff;font:600 18px/1.4 system-ui,sans-serif;text-align:center';
    el.innerHTML = `<div style="max-width:420px;padding:24px"><p style="opacity:.6;font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 12px">Stand-in ad · pnpm dev</p>
      <p style="font-size:28px;margin:0 0 8px">🍿 Your ad here</p>
      <p style="margin:0 0 24px">Tickets in <b data-left>${STAND_IN_SECONDS}</b> s</p>
      <button type="button" style="font:inherit;padding:8px 16px;border-radius:999px;border:1px solid #fff6;background:none;color:#fff;cursor:pointer">Close (no tickets)</button></div>`;
    document.body.append(el);
    const left = el.querySelector<HTMLElement>('[data-left]')!;
    let s = STAND_IN_SECONDS;
    const end = (status: BreakStatus) => {
      clearInterval(tick);
      el.remove();
      hush(false);
      resolve(status);
    };
    const tick = setInterval(() => {
      s -= 1;
      left.textContent = String(s);
      if (s <= 0) end('viewed');
    }, 1000);
    el.querySelector('button')!.addEventListener('click', () => end('dismissed'));
  });
}
