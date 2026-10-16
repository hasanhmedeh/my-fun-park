// Creators' Valley: the coasters members built in the Coaster Workshop and sent in. Staff test-ride
// one in the game, then release it onto one of the valley's eight plots (or in place of the version
// of it running now), decline it with a reply, or take it out of the park again; its creator hears
// at once. The Workshop's parts are priced and stocked here too, like the shop's items.
import { ApiError, CREATION_STATUSES, creationPictureUrl, ringmaster, type AdminCoasterPart, type AdminCreation, type AdminPlot, type CreationStatus } from '../account/api';
import { royalty, type Part } from '../workshop/rules';
import { ask } from './dialog';
import { STOCK_MAX, stockPill } from './shop';
import { busy, duration, errorText, esc, num, onApiError, pagerHtml, plural, toast, when } from './util';

const LIMIT = 24;
/** The longest reply to a declined coaster (the API's CREATION_REPLY_MAX). */
const REPLY_MAX = 500;

type Book = 'coasters' | 'parts';
const BOOKS: [Book, string][] = [
  ['coasters', '🎢 Coasters'],
  ['parts', '🧰 Parts'],
];

const STATUSES: Record<CreationStatus, { icon: string; label: string; pill: string }> = {
  pending: { icon: '⏳', label: 'Waiting', pill: 'pill-staff' },
  released: { icon: '🎢', label: 'Released', pill: 'pill-good' },
  declined: { icon: '✋', label: 'Declined', pill: 'pill-bad' },
  removed: { icon: '📦', label: 'Removed', pill: 'pill-muted' },
  replaced: { icon: '🔁', label: 'Replaced', pill: 'pill-muted' },
};

/** The ride mode's name, and what it means. */
const MODES: Record<AdminCreation['mode'], [string, string]> = {
  passive: ['Passive', 'Rides on its own'],
  driven: ['Driven', 'Riders drive it'],
};
const modeOf = (c: AdminCreation) => MODES[c.mode] ?? MODES.passive;

/** What the dialog last said: the toast sits behind its backdrop. */
type Note = { text: string; error: boolean };

export class CreationsView {
  private book: Book = 'coasters';
  private status: CreationStatus | null = 'pending';
  private offset = 0;
  private rows: AdminCreation[] | null = null;
  private total = 0;
  private counts: Record<CreationStatus, number> | null = null;
  private plots: AdminPlot[] = [];
  private parts: AdminCoasterPart[] | null = null;
  /** The coaster being looked at, in its dialog. */
  private open: AdminCreation | null = null;
  private dialog: HTMLDialogElement | null = null;
  private note: Note | null = null;

  /** `onCounts` hears how many coasters are in each status (the tab's badge shows those waiting). */
  constructor(
    private el: HTMLElement,
    private onCounts: (counts: Record<CreationStatus, number>) => void = () => {},
  ) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const book = t.closest<HTMLButtonElement>('[data-book]');
      if (book) {
        this.book = book.dataset.book as Book;
        return void this.load();
      }
      const filter = t.closest<HTMLButtonElement>('[data-status]');
      if (filter) {
        this.status = (filter.dataset.status || null) as CreationStatus | null;
        this.offset = 0;
        return void this.load();
      }
      const page = t.closest<HTMLButtonElement>('[data-page]');
      if (page) {
        this.offset = Number(page.dataset.page);
        return void this.load();
      }
      const open = t.closest<HTMLButtonElement>('[data-open]');
      if (open) return void this.inspect(open.dataset.open!, open);
      // restocking a part: +10 or +50 on what the field says
      const add = t.closest<HTMLButtonElement>('[data-add]');
      if (!add) return;
      const input = add.closest('form')!.querySelector<HTMLInputElement>('input[name="stock"]')!;
      input.value = String(Math.min(STOCK_MAX, (Number(input.value) || 0) + Number(add.dataset.add)));
      input.focus();
    });
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      void this.savePart(form.dataset.part as Part, form);
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
  }

  show() {
    void this.load();
  }

  /** Live: a coaster sent in or answered, a plot changed, a part sold (main.ts holds off while a dialog is open or a part is being edited). */
  refresh() {
    void this.load(true);
    // the parts don't carry the counts: the badge looks for itself
    if (this.book === 'parts') void this.loadCounts();
  }

  /** Just the counts, for the tab's badge while another view is on screen. */
  async loadCounts() {
    try {
      const { counts } = await ringmaster.creations({ limit: 1, offset: 0 });
      this.counts = counts;
      this.onCounts(counts);
    } catch {
      // the badge waits for the next look; the view reports its own errors
    }
  }

  private load(quiet = false) {
    return this.book === 'parts' ? this.loadParts(quiet) : this.loadCoasters(quiet);
  }

  private async loadCoasters(quiet = false): Promise<void> {
    if (this.book === 'coasters' && (!quiet || !this.el.querySelector('#creations-body')))
      this.el.innerHTML = `${this.top()}<div id="creations-body"><p class="empty">Climbing the lift hill…</p></div>`;
    try {
      const res = await ringmaster.creations({ status: this.status, limit: LIMIT, offset: this.offset });
      // a page emptied by answering its last coaster: back one
      if (!res.creations.length && this.offset > 0) {
        this.offset = Math.max(0, this.offset - LIMIT);
        return this.loadCoasters(quiet);
      }
      this.rows = res.creations;
      this.total = res.total;
      this.counts = res.counts;
      this.plots = res.plots;
      this.onCounts(res.counts);
      if (this.book === 'coasters') this.render();
    } catch (err) {
      onApiError(err);
    }
  }

  private async loadParts(quiet = false) {
    if (!quiet || !this.el.querySelector('#parts-body')) this.el.innerHTML = `${this.head()}<p class="empty">Counting the parts…</p>`;
    try {
      this.parts = (await ringmaster.coasterParts()).parts;
      if (this.book === 'parts') this.render();
    } catch (err) {
      onApiError(err);
    }
  }

  private head() {
    const books = BOOKS.map(([b, label]) => `<button type="button" data-book="${b}" aria-pressed="${b === this.book}">${label}</button>`).join('');
    const c = this.counts;
    const soldOut = (this.parts ?? []).filter((p) => p.stock === 0).length;
    const sub =
      this.book === 'parts'
        ? `The Coaster Workshop's parts: what each costs, and how many are left to sell. Each order takes from the stock; at 0 it's sold out. Changes reach the fair at once.${
            soldOut ? ` <strong>${plural(soldOut, 'part', 'parts')} sold out.</strong>` : ''
          }`
        : `Coasters members built in the Coaster Workshop and sent in. Test-ride one, then release it onto a plot in Creators' Valley or decline it with a reply: its creator hears straight away.${
            c?.pending ? ` <strong>${plural(c.pending, 'coaster is', 'coasters are')} waiting for a look.</strong>` : ''
          }`;
    return `<div class="view-head"><div><h2 id="h-creations">Creations</h2><p class="muted">${sub}</p></div>
      <div class="view-tools"><div class="segmented" role="group" aria-label="Show">${books}</div></div></div>`;
  }

  /** The head, the valley's plots and the status filter: everything above the grid. */
  private top() {
    const c = this.counts;
    const all = c ? Object.values(c).reduce((a, b) => a + b, 0) : null;
    const count = (n: number | null | undefined) => (n === null || n === undefined ? '' : ` <span class="num">${num(n)}</span>`);
    const filters = [
      `<button type="button" data-status="" aria-pressed="${this.status === null}">All${count(all)}</button>`,
      ...CREATION_STATUSES.map((s) => `<button type="button" data-status="${s}" aria-pressed="${this.status === s}">${STATUSES[s].icon} ${STATUSES[s].label}${count(c?.[s])}</button>`),
    ].join('');
    return `${this.head()}${plotsHtml(this.plots)}<div class="segmented creations-filter" role="group" aria-label="Status">${filters}</div>`;
  }

  private render() {
    if (this.book === 'parts') {
      this.el.innerHTML = `${this.head()}<div class="attractions" id="parts-body">${(this.parts ?? []).map(partHtml).join('')}</div>`;
      return;
    }
    const rows = this.rows ?? [];
    const label = this.status ? `“${STATUSES[this.status].label}”` : '';
    const body = rows.length
      ? `<div class="creations">${rows.map(cardHtml).join('')}</div>${pagerHtml(this.offset, LIMIT, this.total)}`
      : `<div class="card"><p class="empty">${this.status === 'pending' ? 'All caught up: no coaster is waiting for a look. 🎉' : `No coasters ${label ? `marked ${label}` : 'sent in yet'}.`}</p></div>`;
    this.el.innerHTML = `${this.top()}<div id="creations-body">${body}</div>`;
  }

  // ---------- One coaster, in a dialog ----------

  /** Opens a coaster's dialog (or shows another one in it): from the grid, a plot, or another version of it. */
  private async inspect(id: string, button?: HTMLButtonElement) {
    const c = this.rows?.find((r) => r.id === id) ?? (await busy(button ?? null, () => ringmaster.creation(id)));
    if (!c) return;
    this.open = c;
    this.note = null;
    this.dialog ??= this.makeDialog();
    this.renderDialog();
  }

  private makeDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'office-dialog creation-dialog';
    dialog.setAttribute('aria-labelledby', 'creation-dialog-title');
    dialog.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      // a click on the backdrop (the dialog itself, outside its sheet) closes it, as does a link to another view
      if (t === dialog || t.closest('[data-close]') || t.closest('a[href^="#"]')) return dialog.close();
      const open = t.closest<HTMLButtonElement>('[data-open]');
      if (open) return void this.inspect(open.dataset.open!, open);
      const remove = t.closest<HTMLButtonElement>('[data-remove]');
      if (remove) void this.remove(remove);
    });
    dialog.addEventListener('input', () => this.syncDialog());
    dialog.addEventListener('change', () => this.syncDialog());
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.dataset.form === 'release') void this.release(form);
      else if (form.dataset.form === 'decline') void this.decline(form);
    });
    dialog.addEventListener('close', () => {
      const id = this.open?.id;
      dialog.remove();
      this.dialog = null;
      this.open = null;
      this.note = null;
      // back on its card (the grid may have been drawn again meanwhile)
      if (id) this.el.querySelector<HTMLElement>(`.creation [data-open="${CSS.escape(id)}"]`)?.focus();
    });
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  private renderDialog() {
    const c = this.open;
    const d = this.dialog;
    if (!c || !d) return;
    d.innerHTML = this.sheetHtml(c);
    this.syncDialog();
    d.querySelector<HTMLElement>('[data-close]')!.focus();
    if (this.note) d.querySelector('[data-note]')?.scrollIntoView({ block: 'nearest' });
  }

  /** Says something inside the dialog (a toast would sit behind its backdrop). */
  private say(text: string, error = false) {
    this.note = { text, error };
    const el = this.dialog?.querySelector<HTMLElement>('[data-note]');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle('is-error', error);
    el.scrollIntoView({ block: 'nearest' });
  }

  /** The release button wakes up once there's a plot (or a choice to make), the decline button once there's a reply. */
  private syncDialog() {
    const c = this.open;
    const d = this.dialog;
    if (!c || !d) return;
    const release = d.querySelector<HTMLFormElement>('form[data-form="release"]');
    if (release) {
      const where = release.querySelector<HTMLInputElement>('input[name="where"]:checked')?.value ?? (c.live ? '' : 'new');
      const plot = release.elements.namedItem('plot') as HTMLSelectElement;
      const tickets = Number((release.elements.namedItem('tickets') as HTMLInputElement).value);
      plot.disabled = where !== 'new';
      const button = release.querySelector<HTMLButtonElement>('[type="submit"]')!;
      button.disabled = !where || (where === 'new' && !plot.value);
      button.textContent = where === 'replace' && c.live ? `🎢 Replace on plot ${c.live.plot}` : where === 'new' && plot.value ? `🎢 Release onto plot ${plot.value}` : '🎢 Release';
      release.querySelector('[data-royalty]')!.textContent =
        Number.isInteger(tickets) && tickets >= 1 && tickets <= 1000
          ? `It opens at once. ${c.user.username} gets ${plural(royalty(tickets), 'ticket', 'tickets')} from each ride by someone else.`
          : 'A ride costs 1 to 1000 tickets.';
    }
    const decline = d.querySelector<HTMLFormElement>('form[data-form="decline"]');
    if (decline) {
      const reply = decline.querySelector<HTMLTextAreaElement>('textarea[name="reply"]')!;
      const chars = decline.querySelector<HTMLElement>('[data-chars]')!;
      const left = REPLY_MAX - reply.value.length;
      chars.textContent = left < 60 ? `${num(left)} characters left` : `${num(reply.value.length)} / ${num(REPLY_MAX)}`;
      chars.classList.toggle('is-low', left < 60);
      decline.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = !reply.value.trim();
    }
  }

  /** busy(), with a failure also said in the dialog. */
  private act(button: HTMLButtonElement | null, run: () => Promise<AdminCreation>) {
    return busy(button, async () => {
      try {
        return await run();
      } catch (err) {
        // a lost session or role: main.ts shows the door, so the dialog gets out of its way
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) this.dialog?.close();
        else {
          this.say(errorText(err), true);
          // changed by someone else meanwhile, or gone: show it as it is now
          if (err instanceof ApiError && (err.status === 404 || err.status === 409)) void this.reload();
        }
        throw err;
      }
    });
  }

  /** The coaster in the dialog and the plots, as they are now. */
  private async reload() {
    const id = this.open?.id;
    if (!id) return;
    try {
      const [c] = await Promise.all([ringmaster.creation(id), this.loadCoasters(true)]);
      if (this.open?.id !== id) return;
      this.open = c;
      this.renderDialog();
    } catch {
      // the dialog keeps what it showed; its note says what went wrong
    }
  }

  /** After a release, a decline or a removal: the toast, the grid, the badge and the plots, then the dialog. */
  private async done(saved: AdminCreation, message: string) {
    toast(message);
    this.note = { text: message, error: false };
    this.open = saved;
    await this.loadCoasters(true);
    if (this.open?.id === saved.id) this.renderDialog();
  }

  private async release(form: HTMLFormElement) {
    const c = this.open;
    if (!c) return;
    const where = form.querySelector<HTMLInputElement>('input[name="where"]:checked')?.value ?? (c.live ? null : 'new');
    if (!where) return this.say('Choose first: replace the version running now, or put it on a new plot.', true);
    const ticketsField = form.elements.namedItem('tickets') as HTMLInputElement;
    const tickets = Number(ticketsField.value);
    if (!Number.isInteger(tickets) || tickets < 1 || tickets > 1000) {
      this.say('A ride costs 1 to 1000 tickets.', true);
      return ticketsField.focus();
    }
    const plot = Number((form.elements.namedItem('plot') as HTMLSelectElement).value);
    if (where === 'new' && !plot) return this.say('Pick a free plot first.', true);
    const replacing = where === 'replace' ? c.live : null;
    const saved = await this.act(form.querySelector('[type="submit"]'), () =>
      ringmaster.releaseCreation(c.id, replacing ? { replace: true, tickets } : { plot, tickets }),
    );
    if (!saved) return;
    await this.done(saved, replacing ? `🎢 ${saved.name} took ${replacing.name}'s place on plot ${saved.plot}.` : `🎢 ${saved.name} is open on plot ${saved.plot}.`);
  }

  private async decline(form: HTMLFormElement) {
    const c = this.open;
    if (!c) return;
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name="reply"]')!;
    const reply = field.value.trim();
    if (!reply) {
      this.say(`Write the reply first: ${c.user.username} sees it.`, true);
      return field.focus();
    }
    if (reply.length > REPLY_MAX) return this.say(`Keep the reply to ${num(REPLY_MAX)} characters.`, true);
    const saved = await this.act(form.querySelector('[type="submit"]'), () => ringmaster.declineCreation(c.id, reply));
    if (saved) await this.done(saved, `Declined ${saved.name}: ${saved.user.username} sees your reply.`);
  }

  private async remove(button: HTMLButtonElement) {
    const c = this.open;
    if (!c) return;
    const sure = await ask({
      icon: '📦',
      title: `Take ${c.name} out of the park?`,
      body: `Riders on it are stopped and get their tickets back, and plot ${c.plot} is left empty. ${c.user.username} hears at once. It can be released again later.`,
      confirm: 'Remove from the park',
      danger: true,
    });
    if (!sure || this.open?.id !== c.id) return;
    const saved = await this.act(button, () => ringmaster.removeCreation(c.id));
    if (saved) await this.done(saved, `📦 ${saved.name} is out of the park: plot ${c.plot} is empty.`);
  }

  private sheetHtml(c: AdminCreation) {
    const s = c.stats;
    const fact = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const facts = [
      fact('Length', `${num(s.lengthM)} m`),
      fact('Highest point', `${num(s.maxHeightM)} m`),
      fact('Biggest drop', `${num(s.dropM)} m`),
      fact('Top speed', `${num(s.topSpeedKmh)} km/h`),
      fact('Inversions', num(s.inversions)),
      fact('Max G', `${s.maxG.toFixed(1)} g`),
      fact('Min G', `${s.minG.toFixed(1)} g`),
      fact('Ride time', s.completes ? duration(s.durationS) : '—'),
      fact('Cars', num(c.cars)),
      fact('Pieces', num(c.pieces)),
      fact('Rides by others', num(c.rides)),
      fact('Royalties earned', `${num(c.earned)} 🎟️`),
    ].join('');
    const dates = [
      fact('Sent', esc(when(c.createdAt))),
      fact('Reviewed by', esc(c.reviewedBy ?? '—')),
      c.releasedAt ? fact('Released', esc(when(c.releasedAt))) : '',
      c.removedAt ? fact(c.status === 'replaced' ? 'Replaced' : 'Removed', esc(when(c.removedAt))) : '',
      c.statusChangedAt ? fact('Last change', esc(when(c.statusChangedAt))) : '',
    ].join('');
    const pic = c.hasPicture ? `<img src="${esc(creationPictureUrl(c.id))}" alt="${esc(`${c.name}, as ${c.user.username} pictured it`)}" />` : '<span aria-hidden="true">🎢</span>';
    const live = c.live
      ? `<div class="notice notice-info"><p>🔁 Another version of this design, <strong>${esc(c.live.name)}</strong>, runs on plot ${c.live.plot} now.
          <button type="button" class="btn btn-ghost btn-small" data-open="${esc(c.live.id)}">Open it</button></p></div>`
      : '';
    const reply = c.reply
      ? `<div class="idea-reply"><p class="idea-reply-who">💌 Reply to ${esc(c.user.username)} from ${esc(c.reviewedBy ?? 'staff')}</p><p class="idea-text">${esc(c.reply)}</p></div>`
      : '';
    const actions = [
      c.status === 'pending' || c.status === 'declined' || c.status === 'removed' ? this.releaseHtml(c) : '',
      c.status === 'pending' ? declineHtml(c) : '',
      c.status === 'released'
        ? `<div class="creation-action"><h4>📦 Take it out of the park</h4><p class="hint">Riders on it are stopped and get their tickets back, and plot ${c.plot} is left empty. It can be released again later.</p>
            <div class="form-actions"><button type="button" class="btn btn-danger btn-small" data-remove>Remove from the park…</button></div></div>`
        : '',
      c.status === 'replaced'
        ? `<div class="creation-action"><h4>🔁 Replaced</h4><p class="hint">A newer version of this design took its place in the park, so this one can't be released again. Open the newer one to change what runs there.</p></div>`
        : '',
    ].join('');
    const note = this.note;
    return `<div class="creation-sheet">
      <div class="creation-sheet-head"><div><h2 id="creation-dialog-title">${esc(c.name)}</h2>
        <p>by <a href="#members/${encodeURIComponent(c.user.id)}">@${esc(c.user.username)}</a> · sent ${esc(when(c.createdAt))}</p></div>
        <button type="button" class="btn btn-ghost btn-small" data-close aria-label="Close">✕</button></div>
      <div class="creation-pic creation-hero">${pic}</div>
      <div class="creation-pills">${pillsHtml(c)}</div>
      <div class="form-actions"><a class="btn btn-ghost btn-small" href="/?coaster=${encodeURIComponent(c.id)}" target="_blank" rel="noopener">🎢 Test-ride in the game</a>
        <span class="hint">Opens the Builder's Yard in a new tab, where staff ride it for free.</span></div>
      ${live}
      <dl class="creation-facts">${facts}</dl>
      <dl class="creation-facts is-quiet">${dates}</dl>
      ${reply}
      <p class="creation-note${note?.error ? ' is-error' : ''}" data-note role="status" aria-live="polite" ${note ? '' : 'hidden'}>${esc(note?.text ?? '')}</p>
      ${actions ? `<div class="creation-actions">${actions}</div>` : ''}
    </div>`;
  }

  /** Onto a free plot, or (when another version runs now) in its place: staff choose every time. */
  private releaseHtml(c: AdminCreation) {
    const free = this.plots.filter((p) => !p.creation).length;
    const options = this.plots
      .map((p) =>
        p.creation
          ? `<option value="${p.plot}" disabled>Plot ${p.plot} · ${esc(p.creation.name)} by @${esc(p.creation.creator)}</option>`
          : `<option value="${p.plot}">Plot ${p.plot} · empty</option>`,
      )
      .join('');
    const live = c.live;
    const now = live ? this.plots.find((p) => p.plot === live.plot) : undefined;
    const choice = live
      ? `<fieldset class="creation-choice"><legend>Another version is on plot ${live.plot}</legend>
          <label class="radio"><input type="radio" name="where" value="replace" /><span>Replace <strong>${esc(live.name)}</strong> on plot ${live.plot}${
            now ? ` <span class="hint">(${plural(now.tickets, 'ticket', 'tickets')} a ride now)</span>` : ''
          }</span></label>
          <label class="radio"><input type="radio" name="where" value="new" /><span>Put it on a new plot</span></label></fieldset>`
      : '';
    return `<form class="creation-action" data-form="release" novalidate>
      <h4>🎢 Release into Creators' Valley</h4>
      ${choice}
      <div class="creation-release-row">
        <label>Plot <select name="plot"><option value="" selected>${free ? 'Pick a plot…' : 'Every plot is taken'}</option>${options}</select></label>
        <label>Tickets a ride <input type="number" name="tickets" min="1" max="1000" step="1" inputmode="numeric" value="1" required /></label>
      </div>
      <p class="hint" data-royalty></p>
      <div class="form-actions"><button type="submit" class="btn btn-primary btn-small" disabled>🎢 Release</button></div>
    </form>`;
  }

  // ---------- The Coaster Workshop's parts ----------

  private async savePart(id: Part, form: HTMLFormElement) {
    const current = this.parts?.find((p) => p.id === id);
    if (!current) return;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const tickets = Number(field('tickets').value);
    const limited = field('limited').checked;
    const stock = limited ? Number(field('stock').value) : null;
    if (!Number.isInteger(tickets) || tickets < 1 || tickets > 1000) {
      toast('A part costs 1 to 1000 tickets.', true);
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
    const saved = await busy(button, () => ringmaster.updateCoasterPart(id, body));
    if (!saved) return;
    this.parts = this.parts!.map((p) => (p.id === id ? saved : p));
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
    this.el.querySelector<HTMLElement>(`form[data-part="${id}"] [type="submit"]`)?.focus();
  }
}

/** "Stalls at 312 m": the train doesn't make it back to the station. */
const stalls = (s: AdminCreation['stats']) => (s.stallAtM === null ? 'Doesn’t make it back' : `Stalls at ${num(s.stallAtM)} m`);

function pillsHtml(c: AdminCreation) {
  const st = STATUSES[c.status];
  return [
    `<span class="pill ${st.pill}">${st.icon} ${st.label}</span>`,
    c.status === 'released' && c.plot ? `<span class="pill pill-good">Plot ${c.plot}</span>` : '',
    `<span class="pill pill-muted" title="${modeOf(c)[1]}">${modeOf(c)[0]}</span>`,
    `<span class="pill pill-muted">${plural(c.stats.inversions, 'inversion', 'inversions')}</span>`,
    c.stats.completes ? '' : `<span class="pill pill-bad">${stalls(c.stats)}</span>`,
  ].join('');
}

function cardHtml(c: AdminCreation) {
  const id = esc(c.id);
  const s = c.stats;
  const pic = c.hasPicture ? `<img src="${esc(creationPictureUrl(c.id))}" alt="" loading="lazy" decoding="async" />` : '<span aria-hidden="true">🎢</span>';
  return `<article class="creation is-${c.status}">
    <div class="creation-pic">${pic}</div>
    <div class="creation-body">
      <h3><button type="button" class="creation-open" data-open="${id}">${esc(c.name)}</button></h3>
      <p class="attraction-stats">by @${esc(c.user.username)} · ${esc(when(c.createdAt))}</p>
      <dl class="creation-stats"><div><dt>Length</dt><dd>${num(s.lengthM)} m</dd></div><div><dt>Height</dt><dd>${num(s.maxHeightM)} m</dd></div><div><dt>Top speed</dt><dd>${num(s.topSpeedKmh)} km/h</dd></div></dl>
      <div class="creation-pills">${pillsHtml(c)}</div>
    </div>
  </article>`;
}

function declineHtml(c: AdminCreation) {
  return `<form class="creation-action" data-form="decline" novalidate>
    <h4>✋ Decline</h4>
    <label>Reply to ${esc(c.user.username)} <span class="hint">Required: they see it in the Coaster Workshop. A declined coaster can still be released later.</span>
      <textarea name="reply" rows="3" maxlength="${REPLY_MAX}" placeholder="Thanks for sending it in! …"></textarea></label>
    <span class="idea-chars" data-chars aria-live="polite"></span>
    <div class="form-actions"><button type="submit" class="btn btn-danger btn-small" disabled>Decline</button></div>
  </form>`;
}

/** Creators' Valley's eight plots: what runs on each, at what price, and whether it's open. */
function plotsHtml(plots: AdminPlot[]) {
  if (!plots.length) return '';
  const free = plots.filter((p) => !p.creation).length;
  const items = plots
    .map((p) => {
      const c = p.creation;
      const what = c
        ? `<button type="button" class="plot-name" data-open="${esc(c.id)}">${esc(c.name)}</button><span class="plot-by">by @${esc(c.creator)}</span>`
        : '<span class="plot-name">Empty</span><span class="plot-by">Ready for a coaster</span>';
      return `<li class="plot${c ? '' : ' is-empty'}${p.open ? '' : ' is-closed'}"><span class="plot-no">Plot ${p.plot}</span>${what}
        <span class="plot-meta">${plural(p.tickets, 'ticket', 'tickets')} · ${p.open ? '<span class="plot-open">Running</span>' : '<span class="plot-closed">Maintenance</span>'}</span></li>`;
    })
    .join('');
  return `<div class="plots-head"><h3>Creators' Valley</h3><p class="hint">${
    free ? `${plural(free, 'plot is', 'plots are')} free.` : 'Every plot is taken: take a coaster out of the park to make room.'
  } Prices and maintenance are set in <a href="#attractions">Attractions</a>.</p></div><ul class="plots" aria-label="Creators' Valley's plots">${items}</ul>`;
}

function partHtml(p: AdminCoasterPart) {
  const id = esc(p.id);
  const limited = p.stock !== null;
  const off = limited ? '' : 'disabled';
  const per = p.unit === 'each' ? 'each' : `per ${p.unit}`;
  return `<form class="attraction${p.stock === 0 ? ' is-closed' : ''}" data-part="${id}" novalidate aria-labelledby="part-${id}">
    <div class="attraction-head"><h3 id="part-${id}">${esc(`${p.icon} ${p.name}`)}</h3>${stockPill(p.stock)}</div>
    <p class="attraction-stats">${esc(p.blurb)} · ${num(p.sold)} sold${p.updatedAt ? ` · last changed ${esc(when(p.updatedAt))}` : ''}</p>
    <div class="price-row"><label>Tickets ${esc(per)} <input type="number" name="tickets" min="1" max="1000" step="1" inputmode="numeric" value="${p.tickets}" required />
      ${p.tickets !== p.defaultTickets ? `<span class="hint">Catalog price: ${num(p.defaultTickets)}</span>` : ''}</label></div>
    <label class="switch"><input type="checkbox" name="limited" ${limited ? 'checked' : ''} /><span data-switch-text>${limited ? 'Limited stock' : 'No limit'}</span></label>
    <div class="price-row"><label>In stock <input type="number" name="stock" min="0" max="${STOCK_MAX}" step="1" inputmode="numeric" value="${p.stock ?? 0}" data-stock ${off} /></label>
      <button type="button" class="btn btn-ghost btn-small" data-add="10" data-stock ${off}>+10</button>
      <button type="button" class="btn btn-ghost btn-small" data-add="50" data-stock ${off}>+50</button></div>
    <div class="form-actions"><button type="submit" class="btn btn-primary btn-small">Save</button></div>
  </form>`;
}
