// The booth's shop: every item's price, and how many are left to sell.
import { ringmaster, type AdminShopItem } from '../account/api';
import { busy, esc, num, onApiError, plural, toast, when } from './util';

export const STOCK_MAX = 100_000;
/** At or below this, an item's stock shows as running low. */
const LOW_STOCK = 5;

export class ShopView {
  private rows: AdminShopItem[] | null = null;

  constructor(private el: HTMLElement) {
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      void this.save(form.dataset.item!, form);
    });
    el.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name !== 'limited') return;
      // the switch's words and the stock field follow it, before saving
      const form = input.closest('form')!;
      form.querySelector('[data-switch-text]')!.textContent = input.checked ? 'Limited stock' : 'No limit';
      for (const f of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-stock]')) f.disabled = !input.checked;
      if (input.checked) form.querySelector<HTMLInputElement>('input[name="stock"]')!.focus();
    });
    // restocking: +10 or +50 on what the field says
    el.addEventListener('click', (e) => {
      const add = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-add]');
      if (!add) return;
      const input = add.closest('form')!.querySelector<HTMLInputElement>('input[name="stock"]')!;
      input.value = String(Math.min(STOCK_MAX, (Number(input.value) || 0) + Number(add.dataset.add)));
      input.focus();
    });
  }

  /** Live: the latest prices, stock and sales (main.ts holds off while a card is being edited). */
  refresh() {
    void this.show();
  }

  async show() {
    if (!this.rows) this.el.innerHTML = `${head()}<p class="empty">Counting the shelves…</p>`;
    try {
      this.rows = (await ringmaster.shopItems()).items;
      this.render();
    } catch (err) {
      onApiError(err);
    }
  }

  private render() {
    const rows = this.rows ?? [];
    const soldOut = rows.filter((r) => r.stock === 0).length;
    const section = (kind: AdminShopItem['kind'], title: string) => {
      const items = rows.filter((r) => r.kind === kind);
      return items.length ? `<h3 class="shop-section">${title}</h3><div class="attractions">${items.map(cardHtml).join('')}</div>` : '';
    };
    this.el.innerHTML = `${head(soldOut)}${section('treat', 'Treats')}${section('souvenir', 'Souvenirs')}`;
  }

  private async save(id: string, form: HTMLFormElement) {
    const current = this.rows?.find((r) => r.id === id);
    if (!current) return;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const tickets = Number(field('tickets').value);
    const limited = field('limited').checked;
    const stock = limited ? Number(field('stock').value) : null;
    if (!Number.isInteger(tickets) || tickets < 1 || tickets > 1000) {
      toast('An item costs 1 to 1000 tickets.', true);
      field('tickets').focus();
      return;
    }
    if (stock !== null && (field('stock').value.trim() === '' || !Number.isInteger(stock) || stock < 0 || stock > STOCK_MAX)) {
      toast(`Stock is a whole number from 0 to ${num(STOCK_MAX)}.`, true);
      field('stock').focus();
      return;
    }
    // only what changed goes to the server, so the logbook says exactly what happened
    const body: { tickets?: number; stock?: number | null } = {};
    if (tickets !== current.tickets) body.tickets = tickets;
    if (stock !== current.stock) body.stock = stock;
    if (!Object.keys(body).length) return toast('Nothing to save.');

    const button = form.querySelector<HTMLButtonElement>('[type="submit"]');
    const saved = await busy(button, () => ringmaster.updateShopItem(id, body));
    if (!saved) return;
    this.rows = this.rows!.map((r) => (r.id === id ? saved : r));
    this.render();
    const name = `${saved.icon} ${saved.name}`;
    toast(
      'stock' in body
        ? saved.stock === null
          ? `${name}: no stock limit.`
          : saved.stock === 0
            ? `${name} is sold out.`
            : `${name}: ${num(saved.stock)} in stock.`
        : `Saved ${name}.`,
    );
    this.el.querySelector<HTMLElement>(`form[data-item="${id}"] [type="submit"]`)?.focus();
  }
}

const head = (soldOut?: number) =>
  `<div class="view-head"><div><h2 id="h-shop">Shop</h2><p class="muted">Prices and stock at the Ticket Booth. Each order takes one from the stock; at 0 it's sold out. Changes reach the fair at once.${
    soldOut ? ` <strong>${plural(soldOut, 'item', 'items')} sold out.</strong>` : ''
  }</p></div></div>`;

/** No limit, sold out, or how many are left (the Coaster Workshop's parts use it too). */
export function stockPill(stock: number | null) {
  if (stock === null) return '<span class="pill pill-muted">No limit</span>';
  if (stock === 0) return '<span class="pill pill-bad">Sold out</span>';
  return `<span class="pill ${stock <= LOW_STOCK ? 'pill-staff' : 'pill-good'}">${num(stock)} left</span>`;
}

function cardHtml(i: AdminShopItem) {
  const id = esc(i.id);
  const limited = i.stock !== null;
  const off = limited ? '' : 'disabled';
  return `<form class="attraction${i.stock === 0 ? ' is-closed' : ''}" data-item="${id}" novalidate aria-labelledby="shop-${id}">
    <div class="attraction-head"><h3 id="shop-${id}">${esc(`${i.icon} ${i.name}`)}</h3>${stockPill(i.stock)}</div>
    <p class="attraction-stats">${i.kind === 'treat' ? 'Treat' : 'Souvenir'} · ${num(i.sold)} sold · last changed ${esc(when(i.updatedAt))}</p>
    <div class="price-row"><label>Tickets each <input type="number" name="tickets" min="1" max="1000" step="1" inputmode="numeric" value="${i.tickets}" required />
      ${i.tickets !== i.defaultTickets ? `<span class="hint">Catalog price: ${num(i.defaultTickets)}</span>` : ''}</label></div>
    <label class="switch"><input type="checkbox" name="limited" ${limited ? 'checked' : ''} /><span data-switch-text>${limited ? 'Limited stock' : 'No limit'}</span></label>
    <div class="price-row"><label>In stock <input type="number" name="stock" min="0" max="${STOCK_MAX}" step="1" inputmode="numeric" value="${i.stock ?? 0}" data-stock ${off} /></label>
      <button type="button" class="btn btn-ghost btn-small" data-add="10" data-stock ${off}>+10</button>
      <button type="button" class="btn btn-ghost btn-small" data-add="50" data-stock ${off}>+50</button></div>
    <div class="form-actions"><button type="submit" class="btn btn-primary btn-small">Save</button></div>
  </form>`;
}
