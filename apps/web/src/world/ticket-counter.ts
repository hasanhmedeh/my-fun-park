// Bits of the ticket counter shared by the game's cards and the booth's shop (shop.ts): ticket
// wording, the sign-up buttons, the countdown to the next pack, the price list and a member's history.
import { ATTRACTION_IDS, type AttractionId } from '../account/api';
import { everyHours, formatWait, session } from '../account/session';
import { MAP_PLACES, onMap } from './minimap';
import { escapeHtml } from './ui';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 ticket", "5 tickets". */
export const ticketsText = (n: number) => plural(n, 'ticket', 'tickets');

/** "a pack of 20 at the Ticket Booth every 5 hours", with the park's live rules. */
export const packText = () => `a pack of ${session.packSize} at the Ticket Booth ${everyHours(session.cooldownHours)}`;

/** Sign up / log in buttons for a card; with a `ride`, signing in boards it straight after. */
export function accountButtons(ride?: AttractionId) {
  const r = ride ? ` data-ride="${ride}"` : '';
  return `<p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-auth="signup"${r}>Sign up — it's free</button><button class="btn btn-outline btn-small" type="button" data-auth="login"${r}>Log in</button></p>`;
}

/** The Terms and Privacy links every ticket card carries. */
export const legalLinksHtml = () =>
  '<p class="legal-links"><a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a> · <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a></p>';

/** "Next pack in 03:12:45": the clock ticks while the card is open (see Game.tickCountdowns). */
export function waitHtml(ms: number, id = '') {
  const attrs = `class="ticket-wait"${id ? ` id="${id}"` : ''}`;
  return ms > 0
    ? `<p ${attrs}>Your next free pack is ready in <b data-countdown>${formatWait(ms)}</b>.</p>`
    : session.packNow === 0
      ? `<p ${attrs}>You hold the most free tickets allowed (${session.ticketCap}).</p>`
      : `<p ${attrs}>Your free pack of ${session.packNow} is ready at the Ticket Booth.</p>`;
}

/** Every attraction and what a round costs (the server's prices once they're in); a plot only while a coaster runs there. */
export function priceListHtml() {
  const rows = ATTRACTION_IDS.filter(onMap).map((id) => {
    const p = MAP_PLACES.find((m) => m.id === id)!;
    const price = session.maintenance(id) === undefined ? ticketsText(session.cost(id)) : '🚧 Under maintenance';
    return `<li><span>${p.icon} ${escapeHtml(p.label)}</span><b>${price}</b></li>`;
  }).join('');
  return `<h3>Price list · one round each</h3><ul class="ticket-list">${rows}</ul>`;
}

/** The member's rounds so far and their latest purchases. */
export function historyHtml() {
  const stats = session.stats;
  const rounds = stats
    ? stats.totalRounds
      ? `${plural(stats.totalRounds, 'round', 'rounds')} played · ${ticketsText(stats.ticketsSpent)} spent`
      : 'No rounds yet: pick an attraction!'
    : 'Counting your rounds…';
  const purchases = session.purchases;
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const list =
    purchases === null
      ? '<p class="sub">Looking up your purchases…</p>'
      : purchases.length
        ? `<ul class="ticket-list">${purchases
            .map((p) => `<li><span>${escapeHtml(when(p.createdAt))}</span><b>+${ticketsText(p.quantity)}${p.priceCents ? '' : ' · free'}</b></li>`)
            .join('')}</ul>`
        : '<p>No purchases yet: your first pack is on the house.</p>';
  return `<h3>Your fair so far</h3><p>🎢 ${rounds}</p><h3>Latest purchases</h3>${list}`;
}
