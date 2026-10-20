import { ApiError, ATTRACTION_IDS } from './api';
import { authDialog } from './auth-dialog';
import { formatWait, session } from './session';
import { rideTitle } from '../world/layout';
import { escapeHtml } from '../world/ui';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "8 Oct, 14:05" in the visitor's time zone. */
const orderDate = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The HUD account chip. Guests get a shortcut to sign up; members see their tickets on the chip
 * and open a big centred card (over a dimmed park) with the souvenirs they wear, their rounds, their latest orders at the shop,
 * the way to delete the account and a log-out button.
 */
export class AccountMenu {
  private chip = document.getElementById('account-chip') as HTMLButtonElement;
  private panel = document.getElementById('account-panel')!;
  private backdrop = document.querySelector<HTMLElement>('.account-backdrop')!;
  private nameEl = this.panel.querySelector<HTMLElement>('.account-name')!;
  private ticketsEl = this.panel.querySelector<HTMLElement>('.account-tickets')!;
  private ridesEl = this.panel.querySelector<HTMLElement>('#account-rides-head')!;
  private listEl = this.panel.querySelector<HTMLElement>('.account-ride-list')!;
  private ordersHead = this.panel.querySelector<HTMLElement>('.account-orders-head')!;
  private ordersEl = this.panel.querySelector<HTMLElement>('.account-orders')!;
  private wearHead = this.panel.querySelector<HTMLElement>('.account-wear-head')!;
  private wearEl = this.panel.querySelector<HTMLElement>('.account-wear')!;
  /** The souvenir being put on or taken off right now. */
  private changing: string | null = null;
  private staffLink = this.panel.querySelector<HTMLAnchorElement>('.account-staff')!;
  private noteEl = this.panel.querySelector<HTMLElement>('.account-note')!;
  private logoutBtn = this.panel.querySelector<HTMLButtonElement>('[data-account-logout]')!;
  private deleteLink = this.panel.querySelector<HTMLButtonElement>('[data-account-delete]')!;
  private deleteForm = this.panel.querySelector<HTMLFormElement>('.account-delete')!;
  private deleteInput = this.deleteForm.querySelector<HTMLInputElement>('input')!;
  private deleteLabel = this.deleteForm.querySelector<HTMLLabelElement>('label')!;
  private deleteError = this.deleteForm.querySelector<HTMLElement>('.account-delete-error')!;
  private deleteBtn = this.deleteForm.querySelector<HTMLButtonElement>('[type="submit"]')!;
  private statsFailed = false;
  private ordersFailed = false;
  private busy = false;

  /** `notify` puts a message on the game's card (e.g. once the account is gone). */
  constructor(private notify: (title: string, text: string) => void = () => {}) {
    this.chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (session.user) this.toggle();
      else void authDialog.open('signup');
    });
    this.panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => this.toggle(false));
    this.panel.querySelector('[data-account-close]')!.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (this.panel.hidden) return;
      if (e.key === 'Tab') this.trapFocus(e);
      if (e.key !== 'Escape' || this.busy) return;
      this.close();
    });
    this.logoutBtn.addEventListener('click', async () => {
      this.logoutBtn.disabled = true;
      this.logoutBtn.textContent = 'Logging out…';
      await session.logout();
      this.logoutBtn.disabled = false;
      this.logoutBtn.textContent = 'Log out';
    });
    // put a souvenir on, or take it off (whatever shares its spot comes off: the server says what's worn)
    this.wearEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-wear]');
      if (b) void this.wear(b.dataset.wear!, b.dataset.on === '1');
    });
    this.deleteLink.addEventListener('click', () => this.askDelete(true));
    this.deleteForm.querySelector('[data-account-delete-cancel]')!.addEventListener('click', () => this.askDelete(false));
    this.deleteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.deleteAccount();
    });
    this.deleteInput.addEventListener('input', () => (this.deleteError.textContent = ''));
    session.onChange(() => this.render());
    // the countdown to the next pack ticks while the card is open
    setInterval(() => !this.panel.hidden && this.renderTickets(), 1000);
    this.render();
  }

  private toggle(open = this.panel.hidden) {
    if (open && !session.user) open = false;
    if (this.busy && !open) return;
    if (open === !this.panel.hidden) return;
    this.panel.hidden = !open;
    this.backdrop.hidden = !open;
    if (session.user) this.chip.setAttribute('aria-expanded', String(open));
    if (!open) {
      this.askDelete(false, false);
      this.note('');
      return;
    }
    // the card takes the focus so the game's keys (E, Esc) don't fire while it's open
    this.panel.focus({ preventScroll: true });
    this.statsFailed = false;
    this.ordersFailed = false;
    this.renderStats();
    this.renderOrders();
    void session.loadTickets();
    void session.loadStats().then((stats) => {
      if (stats || session.stats) return;
      this.statsFailed = true;
      this.renderStats();
    });
    // the item names and icons come from the catalog
    void session.loadCatalog();
    void session.loadSouvenirs();
    this.renderWear();
    void session.loadOrders().then((orders) => {
      if (orders || session.orders) return;
      this.ordersFailed = true;
      this.renderOrders();
    });
  }

  /** Closes the card and hands the focus back to the chip if it was inside. */
  private close() {
    const inside = this.panel.contains(document.activeElement);
    this.toggle(false);
    if (inside && this.panel.hidden) this.chip.focus({ preventScroll: true });
  }

  /** Tab and Shift+Tab cycle inside the card while it's open (it's modal). */
  private trapFocus(e: KeyboardEvent) {
    const focusable = [...this.panel.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === this.panel || !this.panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !this.panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  private render() {
    const user = session.user;
    if (user) {
      // the name drops out on narrow screens, like the other pills' labels (it's in the card)
      const balance = session.balance;
      this.chip.innerHTML = `👤 <span>${escapeHtml(user.username)}${balance === null ? '' : ' · '}</span>${balance === null ? '' : `🎟️ ${balance}`}`;
      this.chip.title = `Signed in as ${user.username}${balance === null ? '' : ` · ${plural(balance, 'ticket', 'tickets')}`}`;
      this.chip.setAttribute('aria-label', `Your account: ${user.username}${balance === null ? '' : `, ${plural(balance, 'ticket', 'tickets')}`}`);
      this.chip.setAttribute('aria-haspopup', 'dialog');
      this.chip.setAttribute('aria-controls', 'account-panel');
      this.chip.setAttribute('aria-expanded', String(!this.panel.hidden));
      this.nameEl.textContent = user.username;
      this.staffLink.hidden = !session.isStaff;
      this.renderTickets();
      this.renderStats();
      this.renderOrders();
      this.renderWear();
    } else {
      this.busy = false;
      this.toggle(false);
      // "Guest ·" drops out on narrow screens, like the other pills' labels
      this.chip.innerHTML = '👤 <span>Guest · </span>Sign up';
      this.chip.title = 'Sign up for a free account and free tickets';
      this.chip.setAttribute('aria-label', 'Guest: sign up for free tickets');
      this.chip.setAttribute('aria-haspopup', 'dialog');
      this.chip.removeAttribute('aria-controls');
      this.chip.removeAttribute('aria-expanded');
    }
  }

  private renderTickets() {
    if (this.panel.hidden) return;
    const t = session.tickets;
    if (!t) {
      this.ticketsEl.textContent = 'Counting your tickets…';
      return;
    }
    const wait = session.msUntilPurchase() ?? 0;
    const next = wait > 0 ? `next free pack in ${formatWait(wait)}` : session.packNow === 0 ? 'the most free tickets you can hold' : 'a free pack is waiting at the Ticket Booth';
    this.ticketsEl.innerHTML = `🎟️ <strong>${plural(t.balance, 'ticket', 'tickets')}</strong> · ${next}`;
  }

  private renderStats() {
    if (this.panel.hidden) return;
    const stats = session.stats;
    this.ridesEl.textContent = stats
      ? stats.totalRounds
        ? `🎢 ${plural(stats.totalRounds, 'round', 'rounds')} played · ${plural(stats.ticketsSpent, 'ticket', 'tickets')} spent`
        : '🎢 No rounds yet: pick an attraction!'
      : this.statsFailed
        ? 'Your rounds are unavailable right now.'
        : 'Counting your rounds…';
    const byRide = stats?.byRide;
    const rows = byRide ? ATTRACTION_IDS.filter((id) => byRide[id]?.rounds > 0).sort((a, b) => byRide[b].rounds - byRide[a].rounds) : [];
    // each bar is that attraction's share of the favourite's rounds
    const top = rows.length ? byRide![rows[0]].rounds : 1;
    this.listEl.innerHTML = rows
      .map((id) => `<li style="--share:${(byRide![id].rounds / top).toFixed(3)}"><span>${escapeHtml(rideTitle(id))}</span><b>${byRide![id].rounds}</b></li>`)
      .join('');
    this.listEl.hidden = !rows.length;
  }

  /** The latest treats and souvenirs bought at the booth, newest first. */
  private renderOrders() {
    if (this.panel.hidden) return;
    const o = session.orders;
    this.ordersHead.textContent = o
      ? o.total
        ? `🛍️ ${plural(o.total, 'order', 'orders')} at the shop`
        : '🛍️ No orders yet: Rosa’s at the Ticket Booth!'
      : this.ordersFailed
        ? 'Your orders are unavailable right now.'
        : 'Fetching your orders…';
    const rows = o?.orders ?? [];
    const catalog = session.catalog;
    this.ordersEl.innerHTML =
      rows
        .map((order) => {
          const item = catalog?.find((i) => i.id === order.item);
          return `<li><span class="account-order-icon" aria-hidden="true">${escapeHtml(item?.icon ?? '🛍️')}</span><span class="account-order-text">${escapeHtml(item?.name ?? order.item)} <small>${escapeHtml(orderDate(order.createdAt))}</small></span><b>${order.ticketsSpent} 🎟️</b></li>`;
        })
        .join('') + (o && o.total > rows.length ? `<li class="account-orders-more">and ${plural(o.total - rows.length, 'more', 'more')}</li>` : '');
    this.ordersEl.hidden = !rows.length;
  }

  /** The member's souvenirs, each worn or not, with the button to change it. */
  private renderWear() {
    if (this.panel.hidden) return;
    const owned = session.souvenirs;
    const catalog = session.catalog;
    const worn = owned.filter((s) => s.equipped).length;
    this.wearHead.textContent = !session.souvenirsKnown
      ? 'Looking in your bag…'
      : owned.length
        ? `🎈 Your souvenirs · wearing ${worn} of ${owned.length}`
        : '🎈 No souvenirs yet: Rosa sells them at the Ticket Booth.';
    // keep the keyboard on the same souvenir across the redraw
    const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-wear]')?.dataset.wear;
    this.wearEl.innerHTML = owned
      .map((s) => {
        const item = catalog?.find((i) => i.id === s.item);
        const busy = this.changing === s.item;
        const label = busy ? (s.equipped ? 'Taking off…' : 'Putting on…') : s.equipped ? 'Take off' : 'Put on';
        return `<li class="${s.equipped ? 'is-worn' : ''}"><span class="account-wear-icon" aria-hidden="true">${escapeHtml(item?.icon ?? '🎁')}</span><span class="account-wear-name">${escapeHtml(item?.name ?? s.item)}</span><small>${s.equipped ? '✓ Wearing' : 'In your bag'}</small><button type="button" class="account-wear-btn" data-wear="${escapeHtml(s.item)}" data-on="${s.equipped ? 0 : 1}" aria-label="${escapeHtml(`${label}: ${item?.name ?? s.item}`)}" ${busy ? 'aria-busy="true" disabled' : ''}>${label}</button></li>`;
      })
      .join('');
    this.wearEl.hidden = !owned.length;
    if (focused) this.wearEl.querySelector<HTMLElement>(`[data-wear="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  private async wear(item: string, on: boolean) {
    if (this.changing) return;
    this.changing = item;
    this.renderWear();
    try {
      await session.wear(item, on);
      this.note('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) session.expire();
      this.note(err instanceof ApiError ? err.message : 'That didn’t work. Please try again.');
    } finally {
      this.changing = null;
      this.renderWear();
    }
  }

  private note(text: string) {
    this.noteEl.textContent = text;
    this.noteEl.hidden = !text;
  }

  /** An account made with Google has no password: it types its username to confirm instead. */
  private get confirmsByName() {
    return session.user?.hasPassword === false;
  }

  /** Shows (or hides) the "are you sure? enter your password" step. */
  private askDelete(show: boolean, focus = true) {
    if (this.busy) return;
    const byName = this.confirmsByName;
    this.deleteLabel.textContent = byName ? `Type your username (${session.user?.username ?? ''}), to confirm` : 'Your password, to confirm';
    this.deleteInput.type = byName ? 'text' : 'password';
    this.deleteInput.autocomplete = byName ? 'off' : 'current-password';
    this.deleteInput.spellcheck = false;
    this.deleteForm.hidden = !show;
    this.deleteLink.setAttribute('aria-expanded', String(show));
    this.deleteForm.reset();
    this.deleteError.textContent = '';
    this.deleteInput.removeAttribute('aria-invalid');
    if (!focus) return;
    if (show) this.deleteInput.focus();
    else this.deleteLink.focus({ preventScroll: true });
  }

  private async deleteAccount() {
    if (this.busy) return;
    const value = this.deleteInput.value;
    const name = session.user?.username ?? '';
    const byName = this.confirmsByName;
    const problem = byName
      ? value.trim().toLowerCase() !== name.toLowerCase()
        ? 'Type your username exactly to confirm.'
        : ''
      : !value
        ? 'Enter your password to confirm.'
        : '';
    if (problem) {
      this.deleteError.textContent = problem;
      this.deleteInput.setAttribute('aria-invalid', 'true');
      this.deleteInput.focus();
      return;
    }
    this.busy = true;
    this.deleteBtn.disabled = true;
    this.deleteBtn.textContent = 'Deleting…';
    this.deleteInput.readOnly = true;
    try {
      await session.deleteAccount(byName ? { confirm: value.trim() } : { password: value });
      this.busy = false;
      // the session is a guest's now, which closes this card
      this.chip.focus({ preventScroll: true });
      this.notify('Account deleted', `Goodbye${name ? `, ${name}` : ''}: your account, tickets and ride history are gone for good. You can keep exploring the fair as a guest.`);
    } catch (err) {
      this.busy = false;
      // a 401 here is the password being wrong (the server says so); anything else is shown as is
      const wrong = err instanceof ApiError && err.status === 401 && /password/i.test(err.message);
      if (err instanceof ApiError && err.status === 401 && !wrong) {
        session.expire();
        return;
      }
      this.deleteError.textContent = wrong ? 'That password isn’t right.' : err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
      this.deleteInput.setAttribute('aria-invalid', 'true');
      this.deleteInput.focus();
      this.deleteInput.select();
    } finally {
      this.deleteBtn.disabled = false;
      this.deleteBtn.textContent = 'Delete for good';
      this.deleteInput.readOnly = false;
    }
  }
}
