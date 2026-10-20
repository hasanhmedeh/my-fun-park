// Small helpers shared by the office's views: names, formatting, the toast and the tooltip.
import { ApiError, type AttractionId } from '../account/api';
import { rideTitle } from '../world/layout';

export const ICONS: Record<AttractionId, string> = {
  coaster: '🎢',
  falcon: '🦅',
  rocket: '🚀',
  ferris: '🎡',
  flip: '🌀',
  ship: '🛸',
  speedway: '🏎️',
  trail: '🚙',
  drone: '🚁',
  crates: '🥫',
  striker: '🔔',
  ducks: '🦆',
  // Creators' Valley's plots, each running a coaster a member built (or nothing yet)
  plot1: '🎢',
  plot2: '🎢',
  plot3: '🎢',
  plot4: '🎢',
  plot5: '🎢',
  plot6: '🎢',
  plot7: '🎢',
  plot8: '🎢',
  // the airport and Palm Cay
  flight: '✈️',
  jetski: '🚤',
  slides: '🌊',
  cannons: '🏴‍☠️',
  volley: '🏐',
};

/** "Thunder Loop" for "coaster", "Plot 3" for "plot3". */
export const rideName = (id: AttractionId) => rideTitle(id);
export const rideLabel = (id: AttractionId) => `${ICONS[id]} ${rideName(id)}`;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const num = (n: number) => n.toLocaleString();
export const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;
export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** "8 Oct, 14:05" in the viewer's time zone. */
export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** "8 Oct" for a UTC day "2026-10-08". */
export const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** 151 → "2:31". */
export const duration = (s: number | null) => {
  if (s === null || !Number.isFinite(s)) return '—';
  const t = Math.round(s);
  return t >= 3600 ? `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** What to tell staff about a failed request. */
export const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short note at the bottom of the screen. */
export function toast(message: string, error = false) {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 6000 : 3000);
}

/** Wires a button to an async action: busy while it runs, and a toast if it fails. */
export async function busy<T>(button: HTMLButtonElement | null, run: () => Promise<T>): Promise<T | undefined> {
  if (button?.getAttribute('aria-busy') === 'true') return undefined;
  button?.setAttribute('aria-busy', 'true');
  try {
    return await run();
  } catch (err) {
    onApiError(err);
    return undefined;
  } finally {
    button?.removeAttribute('aria-busy');
  }
}

/** Set by main.ts: a 401 or 403 sends staff back to the door; anything else is a toast. */
/**
 * True while staff are in the middle of something in `el`: a field has the focus, or holds a
 * change that isn't saved yet. Live updates wait rather than wipe it (the members search excepted).
 */
export function isEditing(el: HTMLElement) {
  const fields = 'input:not([name="q"]), textarea, select';
  const active = document.activeElement;
  if (active instanceof HTMLElement && el.contains(active) && active.matches(fields)) return true;
  for (const f of el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([name="q"]), textarea')) {
    if (f instanceof HTMLInputElement && (f.type === 'checkbox' || f.type === 'radio') ? f.checked !== f.defaultChecked : f.value !== f.defaultValue) return true;
  }
  for (const s of el.querySelectorAll('select')) if ([...s.options].some((o) => o.selected !== o.defaultSelected)) return true;
  return false;
}

export let onApiError: (err: unknown) => void = (err) => toast(errorText(err), true);
export const setApiErrorHandler = (fn: (err: unknown) => void) => (onApiError = fn);

/** A pager under a list: "21–40 of 132", with previous and next. */
export function pagerHtml(offset: number, limit: number, total: number) {
  if (total <= limit && offset === 0) return total ? `<div class="pager"><span>${plural(total, 'row', 'rows')}</span></div>` : '';
  const from = total ? offset + 1 : 0;
  const to = Math.min(total, offset + limit);
  return `<div class="pager"><span class="num">${num(from)}–${num(to)} of ${num(total)}</span><span class="pager-buttons">
    <button type="button" class="btn btn-ghost btn-small" data-page="${Math.max(0, offset - limit)}" ${offset === 0 ? 'disabled' : ''}>← Newer</button>
    <button type="button" class="btn btn-ghost btn-small" data-page="${offset + limit}" ${to >= total ? 'disabled' : ''}>Older →</button>
  </span></div>`;
}
