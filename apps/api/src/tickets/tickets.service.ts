import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Attraction, User } from '../generated/prisma/client.js';
import { ParkService, type ParkRules } from '../park/park.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { announceQuietly } from '../live/announce.js';
import { AD_PROVIDER, PACK_CURRENCY, PACK_PRICE_CENTS, PACK_PROVIDER } from '../rides/attractions.js';
import { toPurchaseJson, type PurchaseJson } from './purchase-json.js';

export interface TicketStatus {
  balance: number;
  packSize: number;
  cooldownHours: number;
  /** The most a pack tops the balance up to (null for no ceiling): at or above it, a pack gives nothing. */
  ticketCap: number | null;
  lastPurchaseAt: string | null;
  /** Null when a purchase is allowed now (by the clock; the cap is checked against the balance). */
  nextPurchaseAt: string | null;
  canBuy: boolean;
  costs: Record<Attraction, number>;
  /** Tickets one rewarded ad gives (0: ads are off), and how many a member is paid for in 24 hours. */
  adTickets: number;
  adsPerDay: number;
  /** Ads the member can still be paid for in the last 24 hours. */
  adsLeft: number;
  /** While none are left: when the next one frees up. Null otherwise. */
  nextAdAt: string | null;
}

/** A rewarded ad about to play: POST /tickets/ads/:id/reward once it has been watched. */
export interface AdStart {
  id: string;
  tickets: number;
}

export interface AdReward {
  balance: number;
  purchase: Pick<PurchaseJson, 'id' | 'quantity' | 'priceCents' | 'currency' | 'provider' | 'createdAt'>;
  adsLeft: number;
  nextAdAt: string | null;
}

export interface PurchaseResult {
  balance: number;
  purchase: Pick<PurchaseJson, 'id' | 'quantity' | 'priceCents' | 'currency' | 'createdAt'>;
  nextPurchaseAt: string;
  canBuy: false;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly park: ParkService,
  ) {}

  /**
   * Balance, prices and whether a pack can be bought now (by the clock: a closed park still turns
   * the purchase away). `user` is fresh: SessionGuard just loaded it.
   */
  async status(user: User): Promise<TicketStatus> {
    const [rules, costs] = await Promise.all([this.park.rules(), this.park.costs()]);
    const next = nextPurchaseAt(user.lastPurchaseAt, rules.cooldownHours, new Date());
    const ads = await adsLeft(this.prisma, user.id, rules.adsPerDay, new Date());
    return {
      balance: user.ticketBalance,
      packSize: rules.packSize,
      cooldownHours: rules.cooldownHours,
      ticketCap: rules.ticketCap,
      lastPurchaseAt: user.lastPurchaseAt?.toISOString() ?? null,
      nextPurchaseAt: next?.toISOString() ?? null,
      canBuy: next === null,
      costs,
      adTickets: rules.adTickets,
      adsPerDay: rules.adsPerDay,
      adsLeft: ads.left,
      nextAdAt: ads.nextAt?.toISOString() ?? null,
    };
  }

  /**
   * Adds one pack (park_settings.pack_size) to the balance, at most once per cooldown, and not while
   * the park is closed (staff excepted). Under a ticket cap the pack only tops the balance up to it
   * (40 held under a cap of 45 gets 5), and a balance already at the cap is turned away without
   * starting the cooldown. The cooldown and cap checks, the increment and
   * the new lastPurchaseAt are a single conditional UPDATE: of two concurrent purchases, the second
   * waits on the row lock, then re-checks the condition against the updated row and matches nothing.
   * The purchase row is written in the same transaction, so the two never disagree.
   */
  async purchase(user: User): Promise<PurchaseResult> {
    const rules = await this.park.rules();
    this.park.assertParkOpen(rules, user);
    const userId = user.id;
    const { packSize, ticketCap } = rules;
    const cooldownMs = hoursMs(rules.cooldownHours);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: {
          id: userId,
          OR: [{ lastPurchaseAt: null }, { lastPurchaseAt: { lte: new Date(now.getTime() - cooldownMs) } }],
          ...(ticketCap === null ? {} : { ticketBalance: { lt: ticketCap } }),
        },
        data: { ticketBalance: { increment: packSize }, lastPurchaseAt: now },
      });
      if (count === 0) return null;
      // Still inside the transaction that holds the row lock, so this is the balance this purchase produced.
      let { ticketBalance } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { ticketBalance: true } });
      // the whole pack went on: take back what overshoots the cap (the balance was under it, so some stays)
      const over = ticketCap === null ? 0 : ticketBalance - ticketCap;
      if (over > 0) {
        await tx.user.update({ where: { id: userId }, data: { ticketBalance: { decrement: over } } });
        ticketBalance -= over;
      }
      const purchase = await tx.ticketPurchase.create({
        data: {
          userId,
          quantity: packSize - Math.max(0, over),
          priceCents: PACK_PRICE_CENTS,
          currency: PACK_CURRENCY,
          provider: PACK_PROVIDER,
          balanceAfter: ticketBalance,
          createdAt: now,
        },
      });
      return { purchase, balance: ticketBalance };
    });

    if (!result) {
      const fresh = await this.prisma.user.findUnique({ where: { id: userId }, select: { lastPurchaseAt: true, ticketBalance: true } });
      const due = nextPurchaseAt(fresh?.lastPurchaseAt ?? null, rules.cooldownHours, new Date());
      // the clock allows it, so it was the cap that said no
      if (!due && ticketCap !== null && fresh && fresh.ticketBalance >= ticketCap)
        throw new ConflictException({
          ...ConflictException.createBody(`You have the most free tickets you can hold (${ticketCap}). Spend some first!`, 'Conflict', HttpStatus.CONFLICT),
          code: 'ticket_cap',
          ticketCap,
          balance: fresh.ticketBalance,
        });
      const next = due ?? new Date();
      throw new ConflictException({
        ...ConflictException.createBody('You can buy your next pack later', 'Conflict', HttpStatus.CONFLICT),
        nextPurchaseAt: next.toISOString(),
      });
    }

    await announceQuietly(this.prisma, { t: 'office', kind: 'purchases' });
    const { purchase, balance } = result;
    return {
      balance,
      purchase: {
        id: purchase.id,
        quantity: purchase.quantity,
        priceCents: purchase.priceCents,
        currency: purchase.currency,
        createdAt: purchase.createdAt.toISOString(),
      },
      nextPurchaseAt: new Date(now.getTime() + cooldownMs).toISOString(),
      canBuy: false,
    };
  }

  /**
   * Starts a rewarded ad: the row its tickets are paid against once it has been watched. Only while
   * ads are on, the park is open (staff excepted) and the free pack isn't ready: still cooling down,
   * or the balance at the ticket cap (ad tickets go on top of it). 409 'ads_off' or 'pack_ready',
   * 429 'ad_limit' (with nextAt) after park_settings.ads_per_day ads in 24 hours.
   */
  async startAd(user: User): Promise<AdStart> {
    const rules = await this.park.rules();
    this.park.assertParkOpen(rules, user);
    assertAdsOn(rules);
    const now = new Date();
    const packReady =
      !nextPurchaseAt(user.lastPurchaseAt, rules.cooldownHours, now) && (rules.ticketCap === null || user.ticketBalance < rules.ticketCap);
    if (packReady)
      throw new ConflictException({
        ...ConflictException.createBody('Your free pack is ready at the Ticket Booth: take that first!', 'Conflict', HttpStatus.CONFLICT),
        code: 'pack_ready',
      });
    const ads = await adsLeft(this.prisma, user.id, rules.adsPerDay, now);
    if (ads.left === 0) throw adLimit(rules.adsPerDay, ads.nextAt);
    // ads started an hour or more ago and never finished can't be paid any more
    await this.prisma.adView.deleteMany({ where: { userId: user.id, rewardedAt: null, startedAt: { lt: new Date(now.getTime() - AD_EXPIRY_MS) } } });
    const view = await this.prisma.adView.create({ data: { userId: user.id, startedAt: now } });
    return { id: view.id, tickets: rules.adTickets };
  }

  /**
   * Pays out an ad the member watched to the end: park_settings.ad_tickets added to the balance, over
   * the ticket cap if need be, and recorded as a purchase (provider "ad", price 0). Once per ad, at
   * least AD_MIN_SECONDS after it started and within the hour. The user's row is locked while the
   * day's ads are counted, so two claims at once can't both slip under ads_per_day. 404 for an ad
   * that isn't theirs (or has expired), 409 'ad_paid' or 'ad_too_soon', 429 'ad_limit'.
   */
  async rewardAd(user: User, id: string): Promise<AdReward> {
    const rules = await this.park.rules();
    assertAdsOn(rules);
    const userId = user.id;
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const view = await tx.adView.findFirst({ where: { id, userId } });
      const age = view ? now.getTime() - view.startedAt.getTime() : Infinity;
      if (!view || age > AD_EXPIRY_MS) throw new NotFoundException('That ad has expired. Watch another one!');
      if (view.rewardedAt)
        throw new ConflictException({
          ...ConflictException.createBody('You already got the tickets for that ad.', 'Conflict', HttpStatus.CONFLICT),
          code: 'ad_paid',
        });
      if (age < AD_MIN_SECONDS * 1000)
        throw new ConflictException({
          ...ConflictException.createBody('That ad finished a bit too quickly. Try another one!', 'Conflict', HttpStatus.CONFLICT),
          code: 'ad_too_soon',
        });
      const ads = await adsLeft(tx, userId, rules.adsPerDay, now);
      if (ads.left === 0) throw adLimit(rules.adsPerDay, ads.nextAt);
      const tickets = rules.adTickets;
      await tx.adView.update({ where: { id }, data: { rewardedAt: now, tickets } });
      const { ticketBalance } = await tx.user.update({ where: { id: userId }, data: { ticketBalance: { increment: tickets } }, select: { ticketBalance: true } });
      const purchase = await tx.ticketPurchase.create({
        data: { userId, quantity: tickets, priceCents: 0, currency: PACK_CURRENCY, provider: AD_PROVIDER, balanceAfter: ticketBalance, createdAt: now },
      });
      // with this one counted
      return { purchase, balance: ticketBalance, ads: await adsLeft(tx, userId, rules.adsPerDay, now) };
    });

    await announceQuietly(this.prisma, { t: 'office', kind: 'purchases' });
    const { purchase, balance, ads } = result;
    return {
      balance,
      purchase: {
        id: purchase.id,
        quantity: purchase.quantity,
        priceCents: purchase.priceCents,
        currency: purchase.currency,
        provider: purchase.provider,
        createdAt: purchase.createdAt.toISOString(),
      },
      adsLeft: ads.left,
      nextAdAt: ads.nextAt?.toISOString() ?? null,
    };
  }

  /** The user's latest purchases, newest first. */
  async purchases(userId: string, limit: number): Promise<{ purchases: PurchaseJson[] }> {
    const purchases = await this.prisma.ticketPurchase.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return { purchases: purchases.map(toPurchaseJson) };
  }
}

const hoursMs = (hours: number) => hours * 60 * 60 * 1000;

/** The window park_settings.ads_per_day counts over. */
const DAY_MS = hoursMs(24);
/** An ad started longer ago than this can't be paid out any more. */
const AD_EXPIRY_MS = hoursMs(1);
/** The least time between starting an ad and claiming its tickets: no rewarded ad is shorter. */
const AD_MIN_SECONDS = 5;

/**
 * How many more ads the user can be paid for in the last 24 hours and, when none, when the oldest
 * one that counts drops out of the window.
 */
async function adsLeft(db: Pick<PrismaService, 'adView'>, userId: string, perDay: number, now: Date) {
  const paid = await db.adView.findMany({
    where: { userId, rewardedAt: { gte: new Date(now.getTime() - DAY_MS) } },
    orderBy: { rewardedAt: 'asc' },
    select: { rewardedAt: true },
  });
  const left = Math.max(0, perDay - paid.length);
  // with ads_per_day lowered below what's been watched, more than one has to drop out first
  const freeing = left === 0 ? paid[paid.length - perDay]?.rewardedAt : null;
  return { left, nextAt: freeing ? new Date(freeing.getTime() + DAY_MS) : null };
}

/** 409 'ads_off' while park_settings.ad_tickets is 0. */
function assertAdsOn(rules: ParkRules) {
  if (rules.adTickets > 0) return;
  throw new ConflictException({
    ...ConflictException.createBody('There are no ads to watch for tickets right now.', 'Conflict', HttpStatus.CONFLICT),
    code: 'ads_off',
  });
}

/** 429 'ad_limit', with when the next ad frees up. */
function adLimit(perDay: number, nextAt: Date | null) {
  return new HttpException(
    {
      ...HttpException.createBody(`That's ${perDay} ads in a day already. More tomorrow!`, 'Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
      code: 'ad_limit',
      nextAt: nextAt?.toISOString() ?? null,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** When the cooldown after `lastPurchaseAt` ends, or null if it already has (or there was no purchase). */
function nextPurchaseAt(lastPurchaseAt: Date | null, cooldownHours: number, now: Date): Date | null {
  if (!lastPurchaseAt) return null;
  const next = new Date(lastPurchaseAt.getTime() + hoursMs(cooldownHours));
  return next > now ? next : null;
}
