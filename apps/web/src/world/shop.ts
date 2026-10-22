// The Ticket Booth's shop: step up to the counter and Rosa serves you. The camera moves to an
// over-the-shoulder view of her kiosk, and the shop opens beside it with three aisles: the free
// pack of tickets, treats (eaten on the spot, each with a perk) and souvenirs (kept and worn).
// Rosa talks you through it: what you look at, what you buy, and what you can't afford yet.
import * as THREE from 'three';
import { ApiError, NotEnoughTicketsError, ParkClosedError, PurchaseCooldownError, SoldOutError, TicketCapError, type ShopItem } from '../account/api';
import type { AuthMode } from '../account/auth-dialog';
import { everyHours, formatWait, session } from '../account/session';
import type { Sfx } from './audio';
import { BOOTH_COUNTER, BOOTH_VENDOR, type Booth } from './attractions/landmarks';
import { plainLook, type Look } from './crowd/looks';
import type { AvatarSpec } from './crowd/people-manifest';
import { perks } from './perks';
import type { Player } from './player';
import { historyHtml, legalLinksHtml, priceListHtml, ticketsText } from './ticket-counter';
import { PALETTE } from './textures';
import { escapeHtml } from './ui';

type Aisle = 'tickets' | 'treats' | 'souvenirs';
const AISLES: Aisle[] = ['tickets', 'treats', 'souvenirs'];

/** Rosa's avatar (its hero file loads with the visitor's, before the fair opens). */
export const VENDOR_AVATAR = 'Female_Adult_09';

/**
 * Rosa: her own cardigan and trousers under the booth's teal apron, 1.68 m tall (the counter was
 * built round her), and the fair's cap from the Wardrobe (she wears the souvenir she sells).
 */
export function vendorLook(spec: AvatarSpec): Look {
  return { ...plainLook(spec, 1.68 / spec.height, 1, true), wear: { apron: PALETTE.teal } };
}

/** What Rosa says about each item when you look at it. */
const PITCH: Record<string, string> = {
  'cotton-candy': "Spun it fresh five minutes ago. One bite and you'll be zooming round the midway!",
  popcorn: "Careful, it's hot! Puts a real wallop in your kicks, too. The crates won't know what hit them.",
  soda: 'Ice cold. The drone pilots swear by it: a whole extra minute up in the sky.',
  'candy-apple': 'Just a treat. Sometimes that’s all you need, love.',
  balloon: 'Red’s the classic. Hold on tight, it pulls!',
  shades: 'Very cool. Very you. The stars are real gold paint.',
  cap: 'The fair’s own design. I’m wearing mine right now!',
  'foam-finger': 'Point the way to the next ride! Everyone will know where you’re going.',
  'top-hat': 'The Ringmaster’s own style. Don’t tell him I sold you one!',
};

/** At or below this many left, the card says so. */
const LOW_STOCK = 5;

/** How quickly Rosa's lines appear, in characters a second. */
const TYPE_RATE = 55;

export interface ShopOptions {
  root: HTMLElement;
  booth: Booth;
  player: Player;
  sfx: Sfx;
  mobile: boolean;
  /** Sign up / log in from the counter. */
  onAuth: (mode: AuthMode) => void;
  /** Leave the counter (Esc, the button). */
  onLeave: () => void;
}

export class Shop {
  isOpen = false;
  private aisle: Aisle = 'tickets';
  private busy: string | null = null;
  private lineEl: HTMLElement;
  private saidEl: HTMLElement;
  private shelf: HTMLElement;
  private wallet: HTMLElement;
  private typing: { text: string; shown: number } | null = null;
  private talkUntil = 0;
  private pitched = '';
  private pitchTimer: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private flash: { id: string; text: string } | null = null;
  private visits = 0;

  constructor(private o: ShopOptions) {
    const r = o.root;
    this.lineEl = r.querySelector('[data-shop-line]')!;
    this.saidEl = r.querySelector('[data-shop-said]')!;
    this.shelf = r.querySelector('[data-shop-shelf]')!;
    this.wallet = r.querySelector('[data-shop-wallet]')!;

    r.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>('[data-aisle], [data-shop-buy], [data-shop-pack], [data-shop-wear], [data-shop-leave], [data-auth]');
      if (!b) return;
      if (b.dataset.aisle) this.choose(b.dataset.aisle as Aisle, true);
      else if (b.dataset.shopBuy) void this.buy(b.dataset.shopBuy);
      else if (b.hasAttribute('data-shop-pack')) void this.takePack();
      else if (b.dataset.shopWear) void this.wear(b.dataset.shopWear, b.dataset.on === '1');
      else if (b.hasAttribute('data-shop-leave')) this.o.onLeave();
      else if (b.dataset.auth) this.o.onAuth(b.dataset.auth as AuthMode);
    });
    // the shop has the keyboard (the game's keys don't reach it): Esc leaves the counter
    r.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.o.onLeave();
    });
    // the aisles are tabs: arrow keys move between them
    r.querySelector('[role="tablist"]')!.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
      e.preventDefault();
      const i = AISLES.indexOf(this.aisle);
      const next = k === 'Home' ? 0 : k === 'End' ? AISLES.length - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + AISLES.length) % AISLES.length;
      this.choose(AISLES[next], true);
      r.querySelector<HTMLElement>(`[data-aisle="${AISLES[next]}"]`)?.focus();
    });
    // Rosa pitches whatever you look at (pointer or keyboard)
    const pitch = (e: Event) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]');
      if (!card || card.dataset.card === this.pitched) return;
      if (this.pitchTimer) clearTimeout(this.pitchTimer);
      this.pitchTimer = setTimeout(() => {
        this.pitched = card.dataset.card!;
        this.pitch(card.dataset.card!);
      }, 280);
    };
    this.shelf.addEventListener('pointerover', pitch);
    this.shelf.addEventListener('focusin', pitch);

    session.onChange(() => this.isOpen && this.render());
    // a price or the stock changed: what's on the shelf catches up while you're at the counter
    session.onShop(() => this.isOpen && void session.loadCatalog(true));
    session.onPark(() => {
      if (!this.isOpen) return;
      this.render();
      if (this.closed) this.say('Oh! The park’s just closed, so I have to stop selling for now. Sorry, love. Come back soon!');
    });
  }

  // ---------- Stepping up and leaving ----------

  /** The visitor is at the counter: open the shop, and Rosa says hello. */
  open() {
    this.isOpen = true;
    this.visits++;
    this.o.root.hidden = false;
    this.flash = null;
    this.pitched = '';
    this.aisle = session.user && !session.tickets?.canBuy && this.visits > 1 ? 'treats' : 'tickets';
    this.render();
    // prices and stock may have changed since the last visit
    void session.loadCatalog(true).then(() => this.isOpen && this.render());
    if (session.user) {
      void session.loadTickets();
      void session.loadSouvenirs();
      void session.loadPurchases();
      void session.loadStats();
    }
    this.clock = setInterval(() => this.tickClock(), 1000);
    const vendor = this.o.booth.vendorRig;
    vendor?.wave(1.6);
    this.o.sfx.chime();
    this.say(this.greeting());
    this.o.root.querySelector<HTMLElement>(`[data-aisle="${this.aisle}"]`)?.focus({ preventScroll: true });
  }

  /** Back to the fair. Rosa waves you off. */
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.o.root.hidden = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    this.typing = null;
    const vendor = this.o.booth.vendorRig;
    vendor?.setBase('stand');
    vendor?.wave(1.4);
  }

  /** Where the camera looks from at the counter: over the visitor's right shoulder, at Rosa. */
  shot() {
    return {
      pos: new THREE.Vector3(BOOTH_COUNTER.x + 1.15, 2.05, BOOTH_COUNTER.z + 2.3),
      look: new THREE.Vector3(BOOTH_VENDOR.x - 0.15, 1.62, BOOTH_VENDOR.z),
    };
  }

  /** Where the visitor stands at the counter, facing it. */
  get counterSpot() {
    return { x: BOOTH_COUNTER.x - 0.25, z: BOOTH_COUNTER.z, heading: 0 };
  }

  /**
   * How far to shift the picture so the counter shows beside the shop, not under it: the sheet takes
   * the right of a wide screen, the bottom of a narrow one.
   */
  viewOffset(w: number, h: number) {
    const sheet = this.o.root.querySelector<HTMLElement>('.shop-sheet');
    if (!sheet) return { x: 0, y: 0 };
    const r = sheet.getBoundingClientRect();
    return w > 720 ? { x: Math.round(Math.min(r.width, w * 0.6) / 2), y: 0 } : { x: 0, y: Math.round(Math.min(r.height, h * 0.7) / 2) };
  }

  /** Every frame at the counter: Rosa's line types out, and she talks while it does. */
  update(_dt: number) {
    const vendor = this.o.booth.vendorRig;
    if (this.typing) {
      const t = this.typing;
      t.shown = Math.min(t.text.length, t.shown + _dt * TYPE_RATE);
      this.lineEl.textContent = t.text.slice(0, Math.ceil(t.shown));
      if (t.shown >= t.text.length) this.typing = null;
    }
    const talking = !!this.typing || performance.now() < this.talkUntil;
    vendor?.setBase(talking ? 'talk' : 'stand');
  }

  // ---------- Rosa ----------

  private say(text: string) {
    this.typing = { text, shown: 0 };
    this.saidEl.textContent = text;
    this.talkUntil = performance.now() + (text.length / TYPE_RATE) * 1000 + 700;
  }

  private greeting() {
    const name = session.user?.username;
    if (this.closed) return `Hello${name ? `, ${name}` : ''}! I'm afraid the booth's closed while the park is. Have a look around, though.`;
    if (!name) return "Hello there, welcome to the booth! Have a browse. Tickets and treats come with a free account, and your first pack's on the house.";
    if (this.visits > 1) return `Back again, ${name}? Lovely to see you. What'll it be?`;
    const ready = session.tickets?.canBuy !== false;
    return ready ? `Evening, ${name}! Your free pack's ready whenever you are. And the cotton candy's fresh!` : `Evening, ${name}! What can I get you today?`;
  }

  private pitch(id: string) {
    if (id === 'pack') {
      const wait = session.msUntilPurchase();
      return this.say(
        !session.user
          ? `A free account gets you ${session.packSize} tickets ${everyHours(session.cooldownHours)}. Takes a minute to sign up!`
          : wait
            ? `Your next free pack will be ready in ${formatWait(wait)}. I'll keep it warm for you.`
            : session.packNow === 0
              ? `You've got all the free tickets you can hold, ${session.ticketCap}. Go spend a few first!`
              : `${ticketsText(session.packNow)}, on the house. Go on, take them!`,
      );
    }
    const line = PITCH[id];
    if (line) this.say(line);
  }

  // ---------- The aisles ----------

  private choose(aisle: Aisle, spoken: boolean) {
    if (aisle === this.aisle) return;
    this.aisle = aisle;
    this.pitched = '';
    this.render();
    this.shelf.scrollTop = 0;
    if (spoken)
      this.say(
        aisle === 'tickets'
          ? 'Tickets! Every ride and game takes some.'
          : aisle === 'treats'
            ? 'All made fresh here at the booth. Each one does a little something, too!'
            : "Souvenirs are yours to keep, and you'll wear them round the fair.",
      );
  }

  private get closed() {
    return !session.isStaff && (!session.parkOpen || session.parkUnderMaintenance);
  }

  private render() {
    for (const b of this.o.root.querySelectorAll<HTMLElement>('[data-aisle]')) {
      const on = b.dataset.aisle === this.aisle;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.shelf.setAttribute('aria-labelledby', `aisle-${this.aisle}`);
    this.wallet.innerHTML = this.walletHtml();
    const focusedId = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-card]')?.dataset.card;
    const focusedAction = (document.activeElement as HTMLElement | null)?.closest?.('button') ? document.activeElement : null;
    this.shelf.innerHTML =
      (this.closed ? `<p class="shop-note shop-note-closed" role="status">🚧 The booth is closed while the park is. You can look, but nothing's for sale until it opens again.</p>` : '') +
      (this.aisle === 'tickets' ? this.ticketsHtml() : this.itemsHtml(this.aisle === 'treats' ? 'treat' : 'souvenir'));
    // keep the keyboard where it was across a redraw
    if (focusedId && focusedAction && this.shelf.contains(focusedAction) === false)
      this.shelf.querySelector<HTMLElement>(`[data-card="${focusedId}"] button:not([disabled])`)?.focus({ preventScroll: true });
  }

  private walletHtml() {
    if (!session.user) return '<span>Your tickets</span><b>Guest</b>';
    const t = session.tickets;
    return `<span>Your tickets</span><b data-bump>🎟️ ${t ? t.balance : '…'}</b>`;
  }

  private ticketsHtml() {
    const user = session.user;
    const t = session.tickets;
    let pack: string;
    if (!user) {
      pack = `<p>A free account gets you <strong>${session.packSize} tickets</strong> ${everyHours(session.cooldownHours)}, and the first pack's on the house.</p>
        <p class="shop-actions"><button type="button" class="btn btn-primary" data-auth="signup">Sign up, it's free</button><button type="button" class="btn btn-outline" data-auth="login">Log in</button></p>`;
    } else if (!t) {
      pack = '<p class="shop-note">Counting your tickets…</p>';
    } else {
      const wait = session.msUntilPurchase() ?? 0;
      const cap = session.ticketCap;
      const full = session.packNow === 0;
      const label =
        this.busy === 'pack'
          ? 'Printing your tickets…'
          : wait > 0
            ? `Next pack in <span data-clock>${formatWait(wait)}</span>`
            : full
              ? `Wallet full · ${cap} max`
              : `Take ${ticketsText(session.packNow)} · free`;
      const capNote = cap === null ? '' : ` Free packs top you up to <strong>${ticketsText(cap)}</strong> at most.`;
      pack = `<p>One free pack of <strong>${ticketsText(t.packSize)}</strong> ${everyHours(t.cooldownHours)}. Leftover tickets carry over.${capNote}</p>
        <p class="shop-actions"><button type="button" class="btn btn-primary" data-shop-pack ${wait > 0 || full || this.closed ? 'disabled' : ''} ${this.busy === 'pack' ? 'aria-busy="true"' : ''}>${label}</button></p>`;
    }
    const flash = this.flash?.id === 'pack' ? `<p class="shop-flash" role="status">${escapeHtml(this.flash.text)}</p>` : '';
    return `<article class="shop-pack" data-card="pack">
        <div class="shop-pack-art" aria-hidden="true">🎟️</div>
        <div class="shop-pack-body"><h3>Free ticket pack</h3>${pack}${flash}</div>
      </article>
      <div class="shop-columns">
        <div class="shop-block">${priceListHtml()}</div>
        ${user ? `<div class="shop-block">${historyHtml()}</div>` : ''}
      </div>
      ${legalLinksHtml()}`;
  }

  private itemsHtml(kind: ShopItem['kind']) {
    const catalog = session.catalog;
    if (!catalog) return '<p class="shop-note">Rosa’s fetching the stock…</p>';
    const items = catalog.filter((i) => i.kind === kind);
    return `<div class="shop-grid">${items.map((i) => this.cardHtml(i)).join('')}</div>${
      kind === 'treat'
        ? '<p class="shop-note">Treats are eaten right here at the counter: the perk starts straight away and shows at the top of your screen.</p>'
        : '<p class="shop-note">Souvenirs are yours for good. Wear one per spot: a hat, shades, and one thing in each hand.</p>'
    }`;
  }

  private cardHtml(i: ShopItem) {
    const user = session.user;
    const balance = session.tickets?.balance ?? null;
    const owned = i.kind === 'souvenir' && session.owns(i.id);
    const wearing = owned && session.wearing.includes(i.id);
    const soldOut = !owned && i.stock === 0;
    const few = !owned && typeof i.stock === 'number' && i.stock > 0 && i.stock <= LOW_STOCK;
    const perk = i.kind === 'treat' ? (i.perk ? `⚡ ${perkText(i)}` : '😋 Just delicious') : `👕 Worn ${slotText(i)}`;
    let action: string;
    if (!user) action = `<button type="button" class="btn btn-outline btn-small" data-auth="signup">Sign up to buy</button>`;
    else if (owned)
      action = `<button type="button" class="btn ${wearing ? 'btn-outline' : 'btn-primary'} btn-small" data-shop-wear="${i.id}" data-on="${wearing ? 0 : 1}" ${this.busy === i.id ? 'aria-busy="true"' : ''}>${
        wearing ? 'Take it off' : 'Wear it'
      }</button>`;
    else if (soldOut) action = `<button type="button" class="btn btn-outline btn-small" disabled>Sold out</button>`;
    else {
      const short = balance !== null && balance < i.tickets;
      action = `<button type="button" class="btn btn-primary btn-small" data-shop-buy="${i.id}" ${this.closed ? 'disabled' : ''} ${this.busy === i.id ? 'aria-busy="true"' : ''} ${
        short ? `aria-describedby="short-${i.id}"` : ''
      }>${this.busy === i.id ? 'Coming right up…' : `Buy · ${i.tickets} 🎟️`}</button>${short ? `<span class="shop-short" id="short-${i.id}">${balance} of ${i.tickets} 🎟️</span>` : ''}`;
    }
    const flash = this.flash?.id === i.id ? `<p class="shop-flash" role="status">${escapeHtml(this.flash.text)}</p>` : '';
    const stock = soldOut ? '<p class="shop-stock is-out">Sold out: Rosa’s waiting on a delivery</p>' : few ? `<p class="shop-stock">Only ${i.stock} left!</p>` : '';
    return `<article class="shop-item${owned ? ' is-owned' : ''}${wearing ? ' is-worn' : ''}${soldOut ? ' is-sold-out' : ''}" data-card="${i.id}">
        <div class="shop-item-art" aria-hidden="true">${i.icon}</div>
        <h3>${escapeHtml(i.name)}</h3>
        <p class="shop-item-blurb">${escapeHtml(i.blurb)}</p>
        <p class="shop-item-perk">${owned ? (wearing ? '✓ Yours · wearing it' : '✓ Yours') : escapeHtml(perk)}</p>
        ${stock}
        <div class="shop-item-buy">${owned ? '' : `<span class="shop-price">${i.tickets} 🎟️</span>`}${action}</div>
        ${flash}
      </article>`;
  }

  private tickClock() {
    const clock = this.shelf.querySelector('[data-clock]');
    if (!clock) return;
    const wait = session.msUntilPurchase();
    if (wait === null) return;
    if (wait > 0) clock.textContent = formatWait(wait);
    else {
      void session.loadTickets();
      this.render();
    }
  }

  // ---------- Buying ----------

  private async takePack() {
    const wait = session.msUntilPurchase();
    if (this.busy || !session.user || (wait !== null && wait > 0)) return;
    this.busy = 'pack';
    this.render();
    try {
      const { purchase, balance } = await session.buy();
      this.o.booth.vendorRig?.play('Interact', 1.1);
      this.o.sfx.ding();
      this.flash = { id: 'pack', text: `+${ticketsText(purchase.quantity)}! You now have ${balance}.` };
      this.say(`There you go: ${ticketsText(purchase.quantity)}, fresh off the roll. Enjoy the rides!`);
    } catch (err) {
      this.o.sfx.beep();
      this.say(this.problem(err, 'pack'));
    } finally {
      this.busy = null;
      this.render();
      this.bump();
    }
  }

  private async buy(id: string) {
    const item = session.catalog?.find((i) => i.id === id);
    if (!item || this.busy || !session.user) return;
    if (item.stock === 0) {
      this.o.sfx.beep();
      return this.say(soldOutLine(item));
    }
    // short of tickets: Rosa says so, no need to ask the server
    const balance = session.balance;
    if (balance !== null && balance < item.tickets) {
      this.o.sfx.beep();
      return this.say(shortLine(item, item.tickets - balance));
    }
    this.busy = id;
    this.render();
    try {
      await session.buyItem(id);
      const vendor = this.o.booth.vendorRig;
      vendor?.play('Interact', 1.1);
      this.o.sfx.ding();
      if (item.kind === 'treat') {
        if (item.perk) perks.grant(item.perk, item.minutes ?? 3);
        // and down it goes
        setTimeout(() => {
          this.o.player.rig.play('Interact', 1.3);
          this.o.sfx.pop();
        }, 650);
        this.flash = { id, text: item.perk ? `Yum! ${perkText(item)} 🎉` : 'Yum! 😋' };
        this.say(`One ${item.name.toLowerCase()}, coming right up! ${item.perk ? 'Enjoy the boost!' : 'Enjoy!'}`);
      } else {
        this.flash = { id, text: `It's yours! You're wearing it now.` };
        this.say(`There you go. Oh, that looks wonderful on you! Wear it with pride.`);
      }
    } catch (err) {
      this.o.sfx.beep();
      this.say(this.problem(err, id));
    } finally {
      this.busy = null;
      this.render();
      this.bump();
    }
  }

  private async wear(id: string, on: boolean) {
    const item = session.catalog?.find((i) => i.id === id);
    if (!item || this.busy) return;
    this.busy = id;
    this.render();
    try {
      await session.wear(id, on);
      this.say(on ? `Looking sharp with that ${item.name.toLowerCase()}!` : `Saving the ${item.name.toLowerCase()} for later? Fair enough.`);
    } catch (err) {
      this.o.sfx.beep();
      this.say(err instanceof ApiError ? err.message : 'Hmm, that didn’t work. Try again in a moment?');
    } finally {
      this.busy = null;
      this.render();
    }
  }

  /** What Rosa says when something went wrong. */
  private problem(err: unknown, id: string) {
    const item = session.catalog?.find((i) => i.id === id);
    if (err instanceof SoldOutError && item) return soldOutLine(item);
    if (err instanceof NotEnoughTicketsError && item) return shortLine(item, (err.needed ?? item.tickets) - (err.balance ?? 0));
    if (err instanceof ParkClosedError) return err.underMaintenance ? 'The whole fair’s under maintenance, love. I have to close up.' : 'The park’s just closed, so I can’t sell anything right now. Sorry!';
    if (err instanceof TicketCapError) return `You've got all the free tickets you can hold, ${err.ticketCap ?? session.ticketCap}. Spend a few on the rides first!`;
    if (err instanceof PurchaseCooldownError) return 'You’ve had this round’s free pack already. The next one’s on the clock!';
    if (err instanceof ApiError && err.status === 409 && item) return `You’ve already got the ${item.name.toLowerCase()}! Have a look at the others.`;
    if (err instanceof ApiError && err.status === 401) return 'Looks like your session ran out. Log in again and I’ll serve you!';
    return 'Oh dear, the till’s not answering. Your tickets are safe: try again in a moment?';
  }

  private bump() {
    const b = this.wallet.querySelector<HTMLElement>('[data-bump]');
    if (!b) return;
    b.classList.remove('is-bumped');
    void b.offsetWidth;
    b.classList.add('is-bumped');
  }
}

function perkText(i: ShopItem) {
  if (i.perk === 'speed') return `Run 40% faster for ${i.minutes} min`;
  if (i.perk === 'kick') return `Kicks twice as hard for ${i.minutes} min`;
  if (i.perk === 'drone') return '+60 s on your next drone flight';
  return '';
}

function slotText(i: ShopItem) {
  return i.slot === 'head' ? 'on your head' : i.slot === 'face' ? 'on your face' : i.slot === 'leftHand' ? 'in your left hand' : 'in your right hand';
}

function soldOutLine(item: ShopItem) {
  return `Oh, I'm so sorry, love: the ${item.name.toLowerCase()} is all sold out. More's on the way, I promise!`;
}

function shortLine(item: ShopItem, missing: number) {
  return `Ah, you're ${ticketsText(missing)} short for the ${item.name.toLowerCase()}. Pick up your free pack in the Tickets aisle, then come back!`;
}
