import { ApiError, isGame, type AttractionId, type FinishedRound, type RoundStats } from './api';
import { session } from './session';
import { ATTRACTION_STATS, formatStat, HIDDEN_STATS, isPersonalBest, statLabel, trailTime } from './stats';
import { msUntil, resetIn } from './leaderboard';
import { escapeHtml } from '../world/ui';

/** What the visitor picked on the way out: another round, the way to more tickets, or neither. */
export type ResultsChoice = 'again' | 'booth' | null;

export interface RoundResult {
  ride: AttractionId;
  /** The attraction's name, as on its sign. */
  title: string;
  /** True when the round ran to its end; false when the visitor left early. */
  completed: boolean;
  stats: RoundStats;
  /** How the round ended, when it ended some other way than finishing or hopping off (a coaster that stalled). */
  ending?: { headline: string; lead: string };
  /** The visitor is across the sea from the Ticket Booth (on Palm Cay): its button says the way there. */
  boothAway?: boolean;
}

type Saved = { state: 'saving' } | { state: 'saved'; res: FinishedRound } | { state: 'failed'; message: string };

const ordinal = (n: number) => {
  const r = n % 100;
  return `${n}${r >= 11 && r <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/**
 * The results screen after a round, on a native <dialog> like the sign-up form: the round's stats
 * with personal bests, how many rounds of this attraction are done, the tickets left, and a way
 * to go again. It opens straight away; the saved round (and its bests) fills in when the server
 * answers, and if it can't be reached the stats measured here still show.
 */
class ResultsDialog {
  private el = document.getElementById('results') as HTMLDialogElement;
  private body = this.el.querySelector<HTMLElement>('.results-body')!;
  private result: RoundResult | null = null;
  private status: Saved = { state: 'saving' };
  private resolve: ((choice: ResultsChoice) => void) | null = null;
  private choice: ResultsChoice = null;
  private returnFocus: HTMLElement | null = null;
  private shown = false;
  private toggles = new Set<(open: boolean) => void>();

  constructor() {
    this.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-results]');
      if (!b) return;
      const action = b.dataset.results;
      this.close(action === 'again' || action === 'booth' ? action : null);
    });
    // like the sign-up form: a click that starts and ends on the backdrop closes it
    let downOnBackdrop = false;
    this.el.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === this.el));
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && downOnBackdrop) this.close(null);
    });
    this.el.addEventListener('close', () => this.onClosed());
    // the tickets left (and whether another round is affordable) follow the wallet
    session.onChange(() => this.el.open && this.render());
  }

  get isOpen() {
    return this.el.open;
  }

  /** Called with true when the screen opens and false when it closes (the game pauses its keys). */
  onToggle(fn: (open: boolean) => void) {
    this.toggles.add(fn);
  }

  /** Shows a round's results. Resolves with what the visitor picked once the screen closes. */
  open(result: RoundResult): Promise<ResultsChoice> {
    // a screen still up from the round before is simply replaced
    if (this.el.open) this.close(null);
    this.result = result;
    this.status = { state: 'saving' };
    this.choice = null;
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    this.render();
    this.el.showModal();
    this.shown = true;
    this.body.querySelector<HTMLElement>('.results-actions .btn')?.focus();
    for (const fn of this.toggles) fn(true);
    return new Promise((r) => (this.resolve = r));
  }

  /** The server has kept the round: fills in the bests and the round count. */
  saved(result: RoundResult, res: FinishedRound) {
    if (!this.el.open || this.result !== result) return;
    this.status = { state: 'saved', res };
    this.render();
  }

  /** The round couldn't be saved: the stats measured here stay, with a word about why. */
  failed(result: RoundResult, err: unknown) {
    if (!this.el.open || this.result !== result) return;
    const message = err instanceof ApiError && !err.unavailable ? err.message : "We couldn't reach the ticket office, so this round isn't in your history.";
    this.status = { state: 'failed', message };
    this.render();
  }

  close(choice: ResultsChoice) {
    if (!this.el.open) return;
    this.choice = choice;
    this.el.close();
    // settle now rather than on the (later) close event, so a screen opened straight after is its own
    this.onClosed();
  }

  /** Runs once per opening: from close(), or from the close event when Esc shut the dialog. */
  private onClosed() {
    if (!this.shown || this.el.open) return;
    this.shown = false;
    const resolve = this.resolve;
    this.resolve = null;
    for (const fn of this.toggles) fn(false);
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected && !back.closest('[inert], [hidden]') && (!document.activeElement || document.activeElement === document.body))
      back.focus({ preventScroll: true });
    resolve?.(this.choice);
  }

  private render() {
    const r = this.result;
    if (!r) return;
    const best = this.status.state === 'saved' ? this.status.res.history?.best : null;
    const keys = [...ATTRACTION_STATS[r.ride], ...Object.keys(r.stats).filter((k) => !ATTRACTION_STATS[r.ride].includes(k))].filter(
      (k) => r.stats[k] !== undefined && !HIDDEN_STATS.has(k),
    );
    // bests only count for rounds that ran to the end (the server keeps them the same way)
    const rows = keys
      .map((k) => {
        const v = r.stats[k];
        const pb = r.completed && isPersonalBest(k, v, best, r.ride);
        return `<div class="results-stat${pb ? ' is-best' : ''}"><dt>${escapeHtml(statLabel(k))}</dt><dd>${escapeHtml(formatStat(k, v))}${
          pb ? '<span class="results-best">🏆 New personal best</span>' : ''
        }</dd></div>`;
      })
      .join('');
    const pbs = r.completed ? keys.filter((k) => isPersonalBest(k, r.stats[k], best, r.ride)).length : 0;
    const headline = r.ending ? escapeHtml(r.ending.headline) : !rows ? 'Thanks for riding! 🎪' : !r.completed ? 'You hopped off early' : pbs ? 'New personal best! 🏆' : 'Round complete! 🎉';
    const lead = r.ending
      ? escapeHtml(r.ending.lead)
      : !r.completed
        ? `You left before the end, so this round counts as used.${rows ? ' Here’s how far you got.' : ' Come back any time!'}`
        : rows
          ? 'Here’s how your round went.'
          : 'Hope you enjoyed it. Come back any time!';
    // redrawn in place when the round is saved: keep the focus on the same button
    const buttons = () => [...this.body.querySelectorAll<HTMLElement>('[data-results]')];
    const focused = buttons().indexOf(document.activeElement as HTMLElement);
    this.body.innerHTML = `<button type="button" class="auth-close" data-results aria-label="Close" title="Close (Esc)">✕</button><p class="auth-kicker">${escapeHtml(r.title)} · ${
      r.completed ? 'Round complete' : 'Round over'
    }</p><h2 id="results-title">${headline}</h2><p class="auth-lead" id="results-lead">${lead}</p>${rows ? `<dl class="results-stats">${rows}</dl>` : ''}${this.boardHtml(r)}<p class="results-meta" aria-live="polite">${this.metaHtml(r)}</p><div class="results-actions">${this.actionsHtml(r)}</div>`;
    if (focused >= 0) {
      const now = buttons();
      now[Math.min(focused, now.length - 1)]?.focus({ preventScroll: true });
    }
  }

  /** A Rally Trail run on today's leaderboard: where it put the member, once the server has it. */
  private boardHtml(r: RoundResult) {
    if (r.ride !== 'trail' || r.stats.runTimeS === undefined) return '';
    if (this.status.state !== 'saved') return '';
    const t = this.status.res.trail;
    if (!t) return `<p class="results-board">This time couldn't go on the leaderboard.</p>`;
    const best = t.improved ? '' : ` (with your best ${t.closed ? 'on it' : 'today'}, ${escapeHtml(trailTime(t.bestMs))})`;
    // over the line just before noon: it counts on the board that has just closed
    if (t.closed) return `<p class="results-board">${t.rank === 1 ? '👑' : '🏁'} Just in time: you crossed the line before noon, so you're <strong>#${t.rank}</strong> of ${t.players} on the board that has just closed${best}. Today's new board has started.</p>`;
    const where = `<strong>#${t.rank}</strong> of ${t.players} on today's leaderboard`;
    const left = resetIn(msUntil(t.resetsAt));
    return `<p class="results-board">${t.rank === 1 ? '👑' : '🏁'} You're ${where}${best}. A new board starts in ${escapeHtml(left)}.</p>`;
  }

  /** Saving… / "Your 3rd completed round of the Sky Falcon · 🎟️ 12 left" / why it couldn't be saved. */
  private metaHtml(r: RoundResult) {
    const balance = session.balance;
    const left = balance === null ? '' : `🎟️ <strong>${balance}</strong> ${balance === 1 ? 'ticket' : 'tickets'} left`;
    if (this.status.state === 'saving') return `Saving your round…${left ? ` · ${left}` : ''}`;
    if (this.status.state === 'failed') return `${escapeHtml(this.status.message)}${left ? ` · ${left}` : ''}`;
    const n = this.status.res.history?.rounds ?? 0;
    // (a round left early or crashed is not one of them: say how many there are so far, not "your Nth")
    const rounds = !n
      ? `No completed rounds of ${escapeHtml(r.title)} yet`
      : r.completed
        ? `Your ${ordinal(n)} completed round of ${escapeHtml(r.title)}`
        : `${n} completed ${n === 1 ? 'round' : 'rounds'} of ${escapeHtml(r.title)} so far`;
    return `${rounds}${left ? ` · ${left}` : ''}`;
  }

  private actionsHtml(r: RoundResult) {
    const close = '<button type="button" class="btn btn-outline" data-results>Close</button>';
    if (!session.user) return close;
    const cost = session.cost(r.ride);
    const balance = session.balance;
    if (balance !== null && balance < cost) return `<button type="button" class="btn btn-primary" data-results="booth">${r.boothAway ? 'Get tickets at the fair ✈️' : 'Get tickets at the booth 🎟️'}</button>${close}`;
    return `<button type="button" class="btn btn-primary" data-results="again">${isGame(r.ride) ? 'Play again' : 'Ride again'} (${cost} 🎟️)</button>${close}`;
  }
}

export const results = new ResultsDialog();
