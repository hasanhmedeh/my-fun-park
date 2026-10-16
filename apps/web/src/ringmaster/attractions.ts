// Every attraction's price, and the maintenance switch with its sign. Creators' Valley's plots show
// while a member's coaster runs on them, under the coaster's name.
import { isPlot, plotNumber, ringmaster, type AdminPlot, type AttractionId, type AttractionSettings } from '../account/api';
import { busy, esc, num, onApiError, rideLabel, rideName, toast, when } from './util';

const MESSAGE_MAX = 200;

type Coaster = AdminPlot['creation'];

export class AttractionsView {
  private rows: AttractionSettings[] | null = null;
  /** Creators' Valley's plots, with the coaster running on each (if any). */
  private plots: AdminPlot[] = [];

  constructor(private el: HTMLElement) {
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      void this.save(form.dataset.ride as AttractionId, form);
    });
    // the switch's words follow it, before saving
    el.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name !== 'open') return;
      input.closest('form')!.querySelector('[data-switch-text]')!.textContent = input.checked ? 'Running' : 'Under maintenance';
    });
  }

  /** Live: the latest prices and switches (main.ts holds off while a card is being edited). */
  refresh() {
    void this.show();
  }

  async show() {
    if (!this.rows) this.el.innerHTML = `${head()}<p class="empty">Walking the midway…</p>`;
    try {
      // only the plots are wanted from the coasters' list (without them, no plot shows)
      const [{ attractions }, { plots }] = await Promise.all([
        ringmaster.attractions(),
        ringmaster.creations({ status: 'released', limit: 1, offset: 0 }).catch(() => ({ plots: [] as AdminPlot[] })),
      ]);
      this.rows = attractions;
      this.plots = plots;
      this.render();
    } catch (err) {
      onApiError(err);
    }
  }

  /** The coaster running on a plot: null on an empty plot, and for every other attraction. */
  private coaster(ride: AttractionId): Coaster {
    return isPlot(ride) ? (this.plots.find((p) => p.plot === plotNumber(ride))?.creation ?? null) : null;
  }

  /** "Thunder Loop", or a plot's coaster by its own name. */
  private name(ride: AttractionId) {
    return this.coaster(ride)?.name ?? rideName(ride);
  }

  private render() {
    // an empty plot is just ground: it shows once a coaster runs there
    const rows = (this.rows ?? []).filter((r) => !isPlot(r.attraction) || this.coaster(r.attraction));
    const rides = rows.filter((r) => !isPlot(r.attraction));
    const valley = rows.filter((r) => isPlot(r.attraction));
    const closed = rows.filter((r) => !r.open).length;
    this.el.innerHTML = `${head(closed)}<div class="attractions">${rides.map((r) => cardHtml(r)).join('')}</div>${
      valley.length ? `<h3 class="shop-section">Creators' Valley</h3><div class="attractions">${valley.map((r) => cardHtml(r, this.coaster(r.attraction))).join('')}</div>` : ''
    }`;
  }

  private async save(ride: AttractionId, form: HTMLFormElement) {
    const current = this.rows?.find((r) => r.attraction === ride);
    if (!current) return;
    const data = new FormData(form);
    const tickets = Number(data.get('tickets'));
    const open = (form.elements.namedItem('open') as HTMLInputElement).checked;
    const message = String(data.get('closedMessage') ?? '').trim();
    if (!Number.isInteger(tickets) || tickets < 1 || tickets > 1000) {
      toast('A round costs 1 to 1000 tickets.', true);
      (form.elements.namedItem('tickets') as HTMLInputElement).focus();
      return;
    }
    // only what changed goes to the server, so the logbook says exactly what happened
    const body: Partial<Pick<AttractionSettings, 'tickets' | 'open' | 'closedMessage'>> = {};
    if (tickets !== current.tickets) body.tickets = tickets;
    if (open !== current.open) body.open = open;
    if ((message || null) !== current.closedMessage) body.closedMessage = message || null;
    if (!Object.keys(body).length) return toast('Nothing to save.');

    const button = form.querySelector<HTMLButtonElement>('[type="submit"]');
    const saved = await busy(button, () => ringmaster.updateAttraction(ride, body));
    if (!saved) return;
    this.rows = this.rows!.map((r) => (r.attraction === ride ? saved : r));
    this.render();
    const name = this.name(ride);
    toast(body.open === false ? `🔧 ${name} is closed for maintenance.` : body.open === true ? `✅ ${name} is running again.` : `Saved ${name}.`);
    this.el.querySelector<HTMLElement>(`form[data-ride="${ride}"] [type="submit"]`)?.focus();
  }
}

const head = (closed?: number) =>
  `<div class="view-head"><div><h2 id="h-attractions">Attractions</h2><p class="muted">Prices and maintenance. Changes reach the fair at once; staff can still ride a closed attraction to test it.${
    closed ? ` <strong>${num(closed)} under maintenance.</strong>` : ''
  }</p></div></div>`;

/** `coaster`: what runs on a plot of Creators' Valley, which goes by the coaster's name. */
function cardHtml(a: AttractionSettings, coaster: Coaster = null) {
  const id = a.attraction;
  const title = coaster ? `🎢 ${coaster.name}` : rideLabel(id);
  const where = coaster && isPlot(id) ? `Plot ${plotNumber(id)} · by @${coaster.creator} · last changed` : 'Last changed';
  return `<form class="attraction${a.open ? '' : ' is-closed'}" data-ride="${id}" novalidate aria-labelledby="att-${id}">
    <div class="attraction-head"><h3 id="att-${id}">${esc(title)}</h3>${a.open ? '<span class="pill pill-good">Running</span>' : '<span class="pill pill-bad">Maintenance</span>'}</div>
    <p class="attraction-stats">${esc(where)} ${esc(when(a.updatedAt))}</p>
    <div class="price-row"><label>Tickets per round <input type="number" name="tickets" min="1" max="1000" step="1" inputmode="numeric" value="${a.tickets}" required /></label></div>
    <label class="switch"><input type="checkbox" name="open" ${a.open ? 'checked' : ''} /><span data-switch-text>${a.open ? 'Running' : 'Under maintenance'}</span></label>
    <label>Maintenance sign <textarea name="closedMessage" maxlength="${MESSAGE_MAX}" rows="2" placeholder="Under maintenance. Back soon!">${esc(a.closedMessage ?? '')}</textarea>
      <span class="hint">Shown to visitors while it's under maintenance. Leave blank for the default.</span></label>
    <div class="form-actions"><button type="submit" class="btn btn-primary btn-small">Save</button></div>
  </form>`;
}
