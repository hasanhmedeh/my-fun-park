// The whole park's switches (open or closed, and maintenance), their signs, the free-ticket rules
// (packs, and tickets for watching ads), and private access (only the addresses on a list can reach the site).
import { adsEnabled } from '../account/ads-config';
import { ringmaster, type Access, type ParkSettings } from '../account/api';
import { ask } from './dialog';
import { busy, esc, onApiError, toast, when } from './util';

const LABEL_MAX = 60;

export class GatesView {
  private park: ParkSettings | null = null;
  private access: Access | null = null;

  constructor(private el: HTMLElement) {
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.matches('.access-add')) void this.addIp(form);
      else void this.save(form);
    });
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const toggle = target.closest<HTMLButtonElement>('[data-access-toggle]');
      if (toggle) return void this.toggleAccess(toggle);
      const remove = target.closest<HTMLButtonElement>('[data-remove-ip]');
      if (remove) return void this.removeIp(remove);
      // fills in the visitor's own address, to add with a label (or widen to a range first)
      if (target.closest('[data-fill-mine]') && this.access?.you.ip) {
        const form = el.querySelector<HTMLFormElement>('.access-add')!;
        (form.elements.namedItem('ip') as HTMLInputElement).value = this.access.you.ip;
        (form.elements.namedItem('label') as HTMLInputElement).focus();
      }
    });
    el.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === 'open') el.querySelector('[data-switch-text="open"]')!.textContent = input.checked ? 'Open to visitors' : 'Closed';
      if (input.name === 'underMaintenance')
        el.querySelector('[data-switch-text="works"]')!.textContent = input.checked ? 'Under maintenance' : 'Off';
    });
  }

  /** Live: the latest switches and rules (main.ts holds off while the form is being edited). */
  refresh() {
    void this.show();
  }

  async show() {
    if (!this.park) this.el.innerHTML = `${head()}<p class="empty">Checking the gates…</p>`;
    try {
      [this.park, this.access] = await Promise.all([ringmaster.park(), ringmaster.access()]);
      this.render();
    } catch (err) {
      onApiError(err);
    }
  }

  private render() {
    const p = this.park!;
    const [icon, status] = p.underMaintenance
      ? ['🛠️', 'The park is under maintenance']
      : p.open
        ? ['🎪', 'The park is open']
        : ['🚧', 'The park is closed'];
    this.el.innerHTML = `${head()}<div class="card"><form class="gates-form" novalidate>
      <div class="big-status"><span aria-hidden="true" style="font-size:2rem">${icon}</span><div><strong>${status}</strong><p class="hint">Last changed ${esc(when(p.updatedAt))}</p></div></div>
      <h3>Open or closed</h3>
      <label class="switch"><input type="checkbox" name="open" ${p.open ? 'checked' : ''} /><span data-switch-text="open">${p.open ? 'Open to visitors' : 'Closed'}</span></label>
      <p class="hint">Closed: visitors can still walk in and look around, but nobody can board or pick up tickets (staff excepted).</p>
      <label>Sign on the gate <textarea name="closedMessage" maxlength="200" rows="2" placeholder="The park is closed right now. Come back soon!">${esc(p.closedMessage ?? '')}</textarea>
        <span class="hint">Shown while the park is closed. Leave blank for the default.</span></label>
      <h3>Maintenance</h3>
      <label class="switch"><input type="checkbox" name="underMaintenance" ${p.underMaintenance ? 'checked' : ''} /><span data-switch-text="works">${p.underMaintenance ? 'Under maintenance' : 'Off'}</span></label>
      <p class="hint">Stricter than closed: nobody but staff can come into the fair at all. Visitors already in it are sent back to the entrance at once, and any round they're playing is stopped and refunded. Accounts keep working, so staff can still log in and go in.</p>
      <label>Maintenance sign <textarea name="maintenanceMessage" maxlength="200" rows="2" placeholder="The fair is under maintenance. Come back soon!">${esc(p.maintenanceMessage ?? '')}</textarea>
        <span class="hint">Shown at the entrance while the park is under maintenance. Leave blank for the default.</span></label>
      <h3>Free tickets</h3>
      <div class="gates-pair">
        <label>Tickets in a pack <input type="number" name="packSize" min="1" max="1000" step="1" inputmode="numeric" value="${p.packSize}" /></label>
        <label>Hours between packs <input type="number" name="cooldownHours" min="0" max="168" step="1" inputmode="numeric" value="${p.cooldownHours}" />
          <span class="hint">0 means no wait.</span></label>
      </div>
      <label>Most free tickets a member can hold <input type="number" name="ticketCap" min="1" max="100000" step="1" inputmode="numeric" placeholder="No limit" value="${p.ticketCap ?? ''}" />
        <span class="hint">A pack only tops a member up to this: with 45, someone holding 40 gets 5, and someone at 45 gets none until they spend some. Leave blank for no limit.</span></label>
      <h3>Tickets for ads</h3>
      <p class="hint">While their free pack isn't ready, members can watch a short ad for tickets, at the Ticket Booth or when they're short at a ride. Ad tickets go on top of the limit above.${
        p.adTickets > 0 && !adsEnabled ? ' <strong>This build has no AdSense publisher ID (VITE_ADSENSE_CLIENT), so players don’t see the ads yet.</strong>' : ''
      }</p>
      <div class="gates-pair">
        <label>Tickets per ad <input type="number" name="adTickets" min="0" max="1000" step="1" inputmode="numeric" value="${p.adTickets}" />
          <span class="hint">0 switches the ads off.</span></label>
        <label>Ads per member a day <input type="number" name="adsPerDay" min="1" max="100" step="1" inputmode="numeric" value="${p.adsPerDay}" />
          <span class="hint">Counted over the last 24 hours.</span></label>
      </div>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div>
    </form></div><div class="card" id="access-card"></div>`;
    this.renderAccess();
  }

  /** Private access has a card of its own: its buttons act at once, without touching the form above. */
  private renderAccess() {
    const a = this.access;
    const card = this.el.querySelector('#access-card');
    if (!a || !card) return;
    const [icon, status, sub] = a.enabled
      ? ['🔒', 'The fair is private', 'Only the addresses below can open the site.']
      : ['🌍', 'Open to everyone', 'Anyone can visit. Switch this on to let in only the addresses below.'];
    const you = a.you.ip
      ? `<code>${esc(a.you.ip)}</code> ${a.you.allowed ? '<span class="pill pill-good">On the list</span>' : '<span class="pill pill-muted">Not on the list</span>'}`
      : '<span class="hint">The site can’t tell.</span>';
    const rows = a.entries
      .map(
        (e) => `<tr><td><code>${esc(e.ip)}</code></td><td>${esc(e.label ?? '—')}</td><td><span class="cell-sub">${esc(when(e.createdAt))} · ${esc(e.addedBy)}</span></td>
          <td class="r"><button type="button" class="btn btn-small btn-danger" data-remove-ip="${esc(e.id)}" data-ip="${esc(e.ip)}">Remove</button></td></tr>`,
      )
      .join('');
    card.innerHTML = `<div class="gates-form">
      <h3>Private access</h3>
      <div class="big-status"><span aria-hidden="true" style="font-size:2rem">${icon}</span><div><strong>${status}</strong><p class="hint">${sub}</p></div></div>
      <p class="hint">While it's on, every visitor whose address isn't listed gets a “private” page instead of the fair: the game, this office and the API, staff included. Switching it on adds your own address first (for IPv6, your whole home network, as its /64), so you can't shut yourself out.</p>
      <p>Your address: ${you}</p>
      <div class="form-actions"><button type="button" class="btn ${a.enabled ? 'btn-danger' : 'btn-primary'}" data-access-toggle>${a.enabled ? 'Open the fair to everyone' : 'Make the fair private'}</button></div>
      <h3>Allowed addresses</h3>
      ${
        rows
          ? `<div class="table-wrap"><table><thead><tr><th>Address</th><th>Whose</th><th>Added</th><th class="r" aria-label="Remove"></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<p class="empty">Nobody yet. Your own address is added when you make the fair private.</p>'
      }
      <form class="access-add gates-pair" novalidate>
        <label>Address or range <input type="text" name="ip" maxlength="64" placeholder="203.0.113.7 or 203.0.113.0/24" autocapitalize="off" spellcheck="false" required />
          ${a.you.ip ? '<span class="hint"><button type="button" class="btn btn-ghost btn-small" data-fill-mine>Use my address</button></span>' : ''}</label>
        <label>Whose <input type="text" name="label" maxlength="${LABEL_MAX}" placeholder="e.g. Sam at home" />
          <span class="hint">Optional, to remember who it lets in.</span></label>
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-small">Add</button></div>
      </form>
    </div>`;
  }

  private async toggleAccess(button: HTMLButtonElement) {
    const a = this.access!;
    const enabled = !a.enabled;
    const confirmed = enabled
      ? await ask({
          icon: '🔒',
          title: 'Make the fair private?',
          body: `Only the addresses on the list can reach the site, and everyone else is turned away at once, staff included. ${
            a.you.allowed ? 'Your address is on the list already.' : `Your address (${a.you.ip ?? 'unknown'}) is added now, so you stay in.`
          }`,
          confirm: 'Make it private',
        })
      : await ask({
          icon: '🌍',
          title: 'Open the fair to everyone?',
          body: 'Anyone can visit again. The list is kept for next time.',
          confirm: 'Open it',
        });
    if (!confirmed) return;
    const saved = await busy(button, () => ringmaster.updateAccess(enabled));
    if (!saved) return;
    this.access = saved;
    this.renderAccess();
    toast(enabled ? '🔒 The fair is private: only the listed addresses can come in.' : '🌍 The fair is open to everyone again.');
  }

  private async addIp(form: HTMLFormElement) {
    const data = new FormData(form);
    const ip = String(data.get('ip') ?? '').trim();
    const label = String(data.get('label') ?? '').trim() || null;
    if (!ip) {
      toast('Type an address, like 203.0.113.7, or a range like 203.0.113.0/24.', true);
      return (form.elements.namedItem('ip') as HTMLInputElement).focus();
    }
    const added = await busy(form.querySelector<HTMLButtonElement>('[type="submit"]'), () => ringmaster.allowIp({ ip, label }));
    if (!added) return;
    // the caller's own status may have changed too: the list is read again
    await this.reloadAccess();
    toast(`✅ ${added.ip} can come in.`);
  }

  private async removeIp(button: HTMLButtonElement) {
    const ip = button.dataset.ip ?? '';
    const confirmed = await ask({
      icon: '🗑️',
      title: `Remove ${ip}?`,
      body: this.access?.enabled ? 'Anyone connecting from it is turned away at once.' : 'It won’t be let in when the fair is next made private.',
      confirm: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    const done = await busy(button, async () => {
      await ringmaster.removeAllowedIp(button.dataset.removeIp!);
      return true;
    });
    if (!done) return;
    await this.reloadAccess();
    toast(`Removed ${ip}.`);
  }

  private async reloadAccess() {
    try {
      this.access = await ringmaster.access();
      this.renderAccess();
    } catch (err) {
      onApiError(err);
    }
  }

  private async save(form: HTMLFormElement) {
    const p = this.park!;
    const data = new FormData(form);
    const open = (form.elements.namedItem('open') as HTMLInputElement).checked;
    const message = String(data.get('closedMessage') ?? '').trim() || null;
    const underMaintenance = (form.elements.namedItem('underMaintenance') as HTMLInputElement).checked;
    const maintenanceMessage = String(data.get('maintenanceMessage') ?? '').trim() || null;
    const packSize = Number(data.get('packSize'));
    const cooldownHours = Number(data.get('cooldownHours'));
    if (!Number.isInteger(packSize) || packSize < 1 || packSize > 1000) return toast('A pack holds 1 to 1000 tickets.', true);
    if (!Number.isInteger(cooldownHours) || cooldownHours < 0 || cooldownHours > 168) return toast('The wait is 0 to 168 hours.', true);
    const capText = String(data.get('ticketCap') ?? '').trim();
    const ticketCap = capText ? Number(capText) : null;
    if (ticketCap !== null && (!Number.isInteger(ticketCap) || ticketCap < 1 || ticketCap > 100000))
      return toast('The most a member can hold is 1 to 100000 tickets, or blank for no limit.', true);
    const adTickets = Number(data.get('adTickets'));
    const adsPerDay = Number(data.get('adsPerDay'));
    if (!Number.isInteger(adTickets) || adTickets < 0 || adTickets > 1000) return toast('An ad gives 0 to 1000 tickets (0 switches ads off).', true);
    if (!Number.isInteger(adsPerDay) || adsPerDay < 1 || adsPerDay > 100) return toast('A member can watch 1 to 100 ads a day.', true);

    const body: Parameters<typeof ringmaster.updatePark>[0] = {};
    if (open !== p.open) body.open = open;
    if (message !== p.closedMessage) body.closedMessage = message;
    if (underMaintenance !== p.underMaintenance) body.underMaintenance = underMaintenance;
    if (maintenanceMessage !== p.maintenanceMessage) body.maintenanceMessage = maintenanceMessage;
    if (packSize !== p.packSize) body.packSize = packSize;
    if (cooldownHours !== p.cooldownHours) body.cooldownHours = cooldownHours;
    if (ticketCap !== (p.ticketCap ?? null)) body.ticketCap = ticketCap;
    if (adTickets !== p.adTickets) body.adTickets = adTickets;
    if (adsPerDay !== p.adsPerDay) body.adsPerDay = adsPerDay;
    if (!Object.keys(body).length) return toast('Nothing to save.');
    if (
      body.underMaintenance === true &&
      !(await ask({
        icon: '🛠️',
        title: 'Put the park under maintenance?',
        body: 'Everyone but staff is sent out of the fair right away, and any round they are playing is stopped and refunded. Nobody else can come in until you switch it off.',
        confirm: 'Start maintenance',
      }))
    )
      return;
    if (
      body.open === false &&
      !(await ask({
        icon: '🚧',
        title: 'Close the whole park?',
        body: 'Visitors can still walk around, but nobody except staff can board anything or pick up tickets until you open it again.',
        confirm: 'Close the park',
      }))
    )
      return;

    const saved = await busy(form.querySelector<HTMLButtonElement>('[type="submit"]'), () => ringmaster.updatePark(body));
    if (!saved) return;
    this.park = saved;
    this.render();
    toast(
      body.underMaintenance === true
        ? '🛠️ The park is under maintenance.'
        : body.underMaintenance === false
          ? '🎪 Maintenance is over: visitors can come back in.'
          : body.open === false
            ? '🚧 The park is closed.'
            : body.open === true
              ? '🎪 The park is open!'
              : 'Saved.',
    );
  }
}

const head = () =>
  `<div class="view-head"><div><h2 id="h-gates">Park gates</h2><p class="muted">Open or close the whole fair, put it under maintenance, set the free-ticket rules (packs and ads), and make the fair private. Visitors see changes at once.</p></div></div>`;
