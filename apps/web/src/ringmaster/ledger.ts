// Every pack picked up, every round played and everything bought at the booth's shop, newest first.
import { api, ATTRACTION_IDS, isAttraction, isPlot, PLOT_IDS, ringmaster, type AttractionId, type ShopItem } from '../account/api';
import { formatStat, statLabel } from '../account/stats';
import { esc, num, onApiError, pagerHtml, rideLabel, when } from './util';

const LIMIT = 25;
type Book = 'rounds' | 'purchases' | 'shop';
const BOOKS: [Book, string][] = [
  ['rounds', '🎢 Rounds'],
  ['purchases', '🎟️ Packs'],
  ['shop', '🛍️ Shop'],
];

export class LedgerView {
  private book: Book = 'rounds';
  private ride: AttractionId | null = null;
  private offset = 0;
  /** The shop's catalog, for item names and icons (fetched once). */
  private catalog: ShopItem[] | null = null;

  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const book = t.closest<HTMLButtonElement>('[data-book]');
      if (book) {
        this.book = book.dataset.book as Book;
        this.offset = 0;
        return void this.load();
      }
      const page = t.closest<HTMLButtonElement>('[data-page]');
      if (page) {
        this.offset = Number(page.dataset.page);
        void this.load();
      }
    });
    el.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      if (select.name !== 'ride') return;
      this.ride = isAttraction(select.value) ? select.value : null;
      this.offset = 0;
      void this.load();
    });
  }

  show() {
    void this.load();
  }

  /** Live: the newest rounds and packs, without the "turning the pages" placeholder. */
  refresh() {
    void this.load(true);
  }

  private head() {
    const tabs = BOOKS.map(([b, label]) => `<button type="button" data-book="${b}" aria-pressed="${b === this.book}">${label}</button>`).join('');
    const option = (id: AttractionId) => `<option value="${id}" ${id === this.ride ? 'selected' : ''}>${esc(rideLabel(id))}</option>`;
    const filter =
      this.book === 'rounds'
        ? `<select name="ride" aria-label="Attraction"><option value="">Every attraction</option>${ATTRACTION_IDS.filter((id) => !isPlot(id))
            .map(option)
            .join('')}<optgroup label="Creators' Valley">${PLOT_IDS.map(option).join('')}</optgroup></select>`
        : '';
    return `<div class="view-head"><div><h2 id="h-ledger">Ledger</h2><p class="muted">Every round played, every pack picked up and every treat and souvenir bought at the booth, newest first.</p></div>
      <div class="view-tools"><div class="segmented" role="group" aria-label="Book">${tabs}</div>${filter}</div></div>`;
  }

  private async load(quiet = false) {
    if (!quiet || !this.el.querySelector('#ledger-body'))
      this.el.innerHTML = `${this.head()}<div class="card" id="ledger-body"><p class="empty">Turning the pages…</p></div>`;
    try {
      const body = this.el.querySelector('#ledger-body')!;
      if (this.book === 'rounds') {
        const { rounds, total } = await ringmaster.rounds({ ride: this.ride, limit: LIMIT, offset: this.offset });
        const rows = rounds
          .map((r) => {
            const state = r.completed ? '<span class="pill pill-good">Finished</span>' : r.endedAt ? '<span class="pill pill-muted">Left early</span>' : '<span class="pill pill-staff">Playing</span>';
            const stats = Object.entries(r.stats ?? {})
              .slice(0, 3)
              .map(([k, v]) => `${statLabel(k)} ${formatStat(k, v)}`)
              .join(' · ');
            return `<tr><td>${esc(when(r.startedAt))}</td><td><a href="#members/${encodeURIComponent(r.user.id)}">${esc(r.user.username)}</a></td><td>${esc(rideLabel(r.ride))}</td><td>${state}</td><td class="r">${num(r.ticketsSpent)}</td><td class="muted">${esc(stats)}</td></tr>`;
          })
          .join('');
        body.innerHTML = rows
          ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Member</th><th>Attraction</th><th>Result</th><th class="r">Tickets</th><th>Stats</th></tr></thead><tbody>${rows}</tbody></table></div>${pagerHtml(this.offset, LIMIT, total)}`
          : '<p class="empty">No rounds yet.</p>';
      } else if (this.book === 'shop') {
        const [{ orders, total }, catalog] = await Promise.all([ringmaster.shopOrders({ limit: LIMIT, offset: this.offset }), this.loadCatalog()]);
        const rows = orders
          .map((o) => {
            const item = catalog.find((i) => i.id === o.item);
            const kind = item ? (item.kind === 'treat' ? '<span class="pill pill-muted">Treat</span>' : '<span class="pill pill-staff">Souvenir</span>') : '';
            return `<tr><td>${esc(when(o.createdAt))}</td><td><a href="#members/${encodeURIComponent(o.user.id)}">${esc(o.user.username)}</a></td><td>${esc(item ? `${item.icon} ${item.name}` : o.item)}</td><td>${kind}</td><td class="r">${num(o.ticketsSpent)}</td><td class="r">${num(o.balanceAfter)}</td></tr>`;
          })
          .join('');
        body.innerHTML = rows
          ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Member</th><th>Item</th><th>Kind</th><th class="r">Tickets</th><th class="r">Balance after</th></tr></thead><tbody>${rows}</tbody></table></div>${pagerHtml(this.offset, LIMIT, total)}`
          : '<p class="empty">Nothing bought at the shop yet.</p>';
      } else {
        const { purchases, total } = await ringmaster.purchases({ limit: LIMIT, offset: this.offset });
        const rows = purchases
          .map(
            (p) =>
              `<tr><td>${esc(when(p.createdAt))}</td><td><a href="#members/${encodeURIComponent(p.user.id)}">${esc(p.user.username)}</a><span class="cell-sub">${esc(p.user.email)}</span></td><td class="r">+${num(p.quantity)}</td><td class="r">${p.balanceAfter === undefined ? '—' : num(p.balanceAfter)}</td><td>${p.priceCents ? `${(p.priceCents / 100).toFixed(2)} ${esc(p.currency)}` : 'Free'}</td></tr>`,
          )
          .join('');
        body.innerHTML = rows
          ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Member</th><th class="r">Tickets</th><th class="r">Balance after</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></div>${pagerHtml(this.offset, LIMIT, total)}`
          : '<p class="empty">No packs picked up yet.</p>';
      }
    } catch (err) {
      onApiError(err);
    }
  }

  private async loadCatalog() {
    if (!this.catalog) this.catalog = (await api.shop().catch(() => ({ items: [] as ShopItem[] }))).items;
    return this.catalog;
  }
}
