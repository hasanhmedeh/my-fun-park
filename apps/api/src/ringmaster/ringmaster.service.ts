import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccessService, type AccessRules } from '../access/access.service.js';
import { allowlist, ownEntry, parseEntry } from '../access/allowlist.js';
import { Prisma, SuggestionStatus, type AllowedIp, type Attraction, type Gender, type Role, type Suggestion, type User } from '../generated/prisma/client.js';
import { ParkService, toAttractionRules, type AttractionRules, type ParkRules } from '../park/park.service.js';
import { accountNews, announce } from '../live/announce.js';
import { shopItem, SHOP_ITEMS, type ShopItem, type ShopItemJson } from '../shop/catalog.js';
import { toItemJson, toOrderJson, type ShopOrderJson } from '../shop/shop.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_TICKET_COSTS } from '../rides/attractions.js';
import { toRoundJson, type RoundJson } from '../rides/round-json.js';
import { toPurchaseJson, type PurchaseJson } from '../tickets/purchase-json.js';
import { toSuggestionJson, type SuggestionJson } from '../suggestions/suggestion-json.js';
import type { AddAllowedIpDto, UpdateAccessDto } from './dto/update-access.dto.js';
import type { UpdateAttractionDto } from './dto/update-attraction.dto.js';
import type { UpdateParkDto } from './dto/update-park.dto.js';
import type { UpdateShopItemDto } from './dto/update-shop-item.dto.js';
import type { UpdateSuggestionDto } from './dto/update-suggestion.dto.js';
import type { UpdateUserDto } from './dto/update-user.dto.js';
import { changes, defined, log } from './logbook.js';

export interface ParkSettingsJson {
  open: boolean;
  closedMessage: string | null;
  underMaintenance: boolean;
  maintenanceMessage: string | null;
  packSize: number;
  cooldownHours: number;
  /** The most a free pack tops a balance up to; null for no ceiling. */
  ticketCap: number | null;
  updatedAt: string | null;
}

/** One address (or range) let in while the site is private. */
export interface AllowedIpJson {
  id: string;
  ip: string;
  label: string | null;
  addedBy: string;
  createdAt: string;
}

/** Private access, as staff see it. */
export interface AccessJson {
  /** Only the addresses on the list can reach the site. */
  enabled: boolean;
  entries: AllowedIpJson[];
  /** The caller: where the site sees them connecting from, and whether the list lets them in. */
  you: { ip: string | null; allowed: boolean };
}

export interface AttractionJson {
  attraction: Attraction;
  tickets: number;
  open: boolean;
  closedMessage: string | null;
  updatedAt: string | null;
}

/** A shop item as staff see and edit it: today's price and stock, and what it has sold. */
export interface AdminShopItemJson extends ShopItemJson {
  /** The catalog's own price, which it sells at until one is set here. */
  defaultTickets: number;
  /** Orders of it, ever. */
  sold: number;
  updatedAt: string | null;
}

export interface AdminUserJson {
  id: string;
  email: string;
  username: string;
  role: Role;
  ticketBalance: number;
  lastPurchaseAt: string | null;
  createdAt: string;
  termsAcceptedAt: string | null;
  gender: Gender | null;
  /** Linked to a Google account. */
  google: boolean;
  /** False for an account made with Google (no password). */
  hasPassword: boolean;
  rounds: number;
  purchases: number;
}

export interface AdminUserDetail {
  user: AdminUserJson;
  purchases: PurchaseJson[];
  rounds: RoundJson[];
  byRide: Partial<Record<Attraction, { rounds: number; ticketsSpent: number }>>;
  /** Their latest treats and souvenirs bought at the booth, newest first. */
  shopOrders: ShopOrderJson[];
  /** How many shop orders they've made in all. */
  shopOrdersTotal: number;
}

export interface AdminPurchaseJson extends PurchaseJson {
  provider: string;
  user: { id: string; username: string; email: string };
}

export interface AdminShopOrderJson extends ShopOrderJson {
  user: { id: string; username: string };
}

export interface AdminRoundJson extends RoundJson {
  user: { id: string; username: string };
}

/** A suggestion as staff see it: who left it, too. */
export interface AdminSuggestionJson extends SuggestionJson {
  user: { id: string; username: string };
}

export interface AdminActionJson {
  id: string;
  actorName: string;
  action: string;
  target: string | null;
  details: unknown;
  createdAt: string;
}

/** Who's in the fair right now (game tabs connected in the last minute). Members count once however many tabs they have open. */
export interface VisitorsJson {
  /** Past the entrance: members plus guests. */
  inFair: number;
  members: number;
  guests: number;
  /** Looking at the entrance (the intro card), not in yet. */
  atEntrance: number;
}

/** A page of a list: `limit` rows from `offset`, and how many there are in all. */
export interface PageQuery {
  limit: number;
  offset: number;
}

const withCounts = { _count: { select: { rounds: true, purchases: true } } } as const;
type UserWithCounts = Prisma.UserGetPayload<{ include: typeof withCounts }>;

const withAuthor = { user: { select: { id: true, username: true } } } as const;

/**
 * The Ringmaster's Office: the park's switches, the attractions, the members and the logbook.
 * Every change is written to admin_actions in the same transaction as the change itself.
 */
@Injectable()
export class RingmasterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly park: ParkService,
    private readonly privateAccess: AccessService,
  ) {}

  async parkSettings(): Promise<ParkSettingsJson> {
    return toParkJson(await this.park.rules());
  }

  /**
   * Opens or closes the park, puts it under maintenance (or takes it out), or changes the pack
   * rules. Logged as park.maintenance.on / .off, park.open, park.close or settings.update.
   */
  async updatePark(actor: User, dto: UpdateParkDto): Promise<ParkSettingsJson> {
    const before = await this.park.rules();
    const data = defined({
      open: dto.open,
      closedMessage: dto.closedMessage,
      underMaintenance: dto.underMaintenance,
      maintenanceMessage: dto.maintenanceMessage,
      packSize: dto.packSize,
      cooldownHours: dto.cooldownHours,
      ticketCap: dto.ticketCap,
    });
    const changed = changes(before, data);
    if (!changed) return toParkJson(before);

    const row = await this.prisma.$transaction(async (tx) => {
      const row = await tx.parkSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      const action =
        'underMaintenance' in changed.after
          ? row.underMaintenance
            ? 'park.maintenance.on'
            : 'park.maintenance.off'
          : 'open' in changed.after
            ? row.open
              ? 'park.open'
              : 'park.close'
            : 'settings.update';
      await log(tx, actor, action, null, changed);
      await announce(tx, { t: 'park' });
      return row;
    });
    return toParkJson(row);
  }

  /** Private access: the switch, the list, and whether the caller (at `ip`) is on it. */
  async access(ip: string | null): Promise<AccessJson> {
    return toAccessJson(await this.privateAccess.rules(), ip);
  }

  /**
   * Switches private access on or off. Switching it on adds the caller's own address (their IPv6
   * network's /64) unless the list already lets them in, so nobody locks themselves out by
   * switching it on. Logged as access.on (with what was added) or access.off.
   */
  async updateAccess(actor: User, ip: string | null, dto: UpdateAccessDto): Promise<AccessJson> {
    await this.prisma.$transaction(async (tx) => {
      const settings = await tx.parkSettings.findUnique({ where: { id: 1 }, select: { allowlistOnly: true } });
      const was = settings?.allowlistOnly ?? false;
      if (was === dto.enabled) return;
      let added: string | null = null;
      if (dto.enabled) {
        if (!ip) throw new BadRequestException("Can't tell which address you're connecting from, so switching private access on would lock you out too.");
        const entries = await tx.allowedIp.findMany({ select: { ip: true } });
        if (!allowlist(entries.map((e) => e.ip))(ip)) {
          added = ownEntry(ip);
          await tx.allowedIp.create({ data: { ip: added, label: `${actor.username} (switched private access on)`, addedBy: actor.username } });
        }
      }
      await tx.parkSettings.upsert({ where: { id: 1 }, create: { id: 1, allowlistOnly: dto.enabled }, update: { allowlistOnly: dto.enabled } });
      await log(tx, actor, dto.enabled ? 'access.on' : 'access.off', null, {
        before: { enabled: was },
        after: { enabled: dto.enabled },
        ...(added ? { added } : {}),
      });
      await announce(tx, { t: 'access' });
      await announce(tx, { t: 'office', kind: 'access' });
    });
    this.privateAccess.forget();
    return this.access(ip);
  }

  /** Lets one more address (or range) in. Logged as access.ip.add. */
  async allowIp(actor: User, dto: AddAllowedIpDto): Promise<AllowedIpJson> {
    const ip = parseEntry(dto.ip);
    if (!ip) throw new BadRequestException('That isn’t an IP address, or a range like 203.0.113.0/24.');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const row = await tx.allowedIp.create({ data: { ip, label: dto.label ?? null, addedBy: actor.username } });
        await log(tx, actor, 'access.ip.add', ip, { after: { ip, label: row.label } });
        await announce(tx, { t: 'access' });
        await announce(tx, { t: 'office', kind: 'access' });
        return row;
      });
      this.privateAccess.forget();
      return toAllowedIpJson(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException(`${ip} is on the list already`);
      throw err;
    }
  }

  /**
   * Takes an address off the list. While private access is on, not the last entry that lets the
   * caller (at `ip`) in: that would shut them out mid-click. Logged as access.ip.remove.
   */
  async removeAllowedIp(actor: User, ip: string | null, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.allowedIp.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('That address isn’t on the list');
      const settings = await tx.parkSettings.findUnique({ where: { id: 1 }, select: { allowlistOnly: true } });
      if (settings?.allowlistOnly) {
        const rest = await tx.allowedIp.findMany({ where: { id: { not: id } }, select: { ip: true } });
        if (!allowlist(rest.map((r) => r.ip))(ip)) {
          throw new ConflictException(
            `That would lock you out: you're connecting from ${ip ?? 'an address the site can’t tell'}, and nothing else on the list lets you in. Add another entry first, or switch private access off.`,
          );
        }
      }
      await tx.allowedIp.delete({ where: { id } });
      await log(tx, actor, 'access.ip.remove', row.ip, { before: { ip: row.ip, label: row.label } });
      // anyone connected from that address is turned away at once
      await announce(tx, { t: 'access' });
      await announce(tx, { t: 'office', kind: 'access' });
    });
    this.privateAccess.forget();
  }

  /** Who's in the fair right now, from the live streams' presence rows (see LiveService). */
  async visitors(): Promise<VisitorsJson> {
    const [row] = await this.prisma.$queryRaw<{ members: number; guests: number; entrance: number }[]>`
      SELECT
        COUNT(DISTINCT user_id) FILTER (WHERE in_fair)::int AS members,
        COUNT(*) FILTER (WHERE in_fair AND user_id IS NULL)::int AS guests,
        COUNT(*) FILTER (WHERE NOT in_fair)::int AS entrance
      FROM live_visitors
      WHERE NOT gone AND seen_at > now() - interval '1 minute'`;
    const members = row?.members ?? 0;
    const guests = row?.guests ?? 0;
    return { inFair: members + guests, members, guests, atEntrance: row?.entrance ?? 0 };
  }

  async attractions(): Promise<{ attractions: AttractionJson[] }> {
    return { attractions: (await this.park.attractions()).map(toAttractionJson) };
  }

  /**
   * Changes an attraction's price, or closes it for maintenance (or opens it again). Logged as
   * attraction.open, attraction.close, price.update or attraction.update (just the sign).
   */
  async updateAttraction(actor: User, attraction: Attraction, dto: UpdateAttractionDto): Promise<AttractionJson> {
    const before = await this.park.attraction(attraction);
    const data = defined({ tickets: dto.tickets, open: dto.open, closedMessage: dto.closedMessage });
    const changed = changes(before, data);
    if (!changed) return toAttractionJson(before);

    const row = await this.prisma.$transaction(async (tx) => {
      const row = await tx.attractionSettings.upsert({
        where: { attraction },
        create: { attraction, tickets: DEFAULT_TICKET_COSTS[attraction], ...data },
        update: data,
      });
      const action =
        'open' in changed.after ? (row.open ? 'attraction.open' : 'attraction.close') : 'tickets' in changed.after ? 'price.update' : 'attraction.update';
      await log(tx, actor, action, attraction, changed);
      await announce(tx, { t: 'park' });
      return row;
    });
    return toAttractionJson(toAttractionRules(attraction, row));
  }

  /** Everything the booth sells, with its price, stock and how many it has sold. */
  async shopItems(): Promise<{ items: AdminShopItemJson[] }> {
    const [rows, sold] = await Promise.all([this.prisma.shopItemSettings.findMany(), this.soldCounts()]);
    const byItem = new Map(rows.map((r) => [r.item, r]));
    return { items: SHOP_ITEMS.map((i) => toAdminShopItemJson(i, byItem.get(i.id), sold.get(i.id) ?? 0)) };
  }

  /**
   * Sets a shop item's price or stock (null for no limit). Logged as shop.price, shop.stock or
   * shop.update (both), and every open shop in the fair catches up at once.
   */
  async updateShopItem(actor: User, id: string, dto: UpdateShopItemDto): Promise<AdminShopItemJson> {
    const item = shopItem(id);
    if (!item) throw new NotFoundException('There is no such item at the booth');
    const [current, sold] = await Promise.all([this.prisma.shopItemSettings.findUnique({ where: { item: id } }), this.soldCounts(id)]);
    const before = { tickets: current?.tickets ?? item.tickets, stock: current?.stock ?? null };
    const data = defined({ tickets: dto.tickets, stock: dto.stock });
    const changed = changes(before, data);
    if (!changed) return toAdminShopItemJson(item, current ?? undefined, sold.get(id) ?? 0);

    const row = await this.prisma.$transaction(async (tx) => {
      const row = await tx.shopItemSettings.upsert({ where: { item: id }, create: { item: id, ...before, ...data }, update: data });
      const action = 'tickets' in changed.after ? ('stock' in changed.after ? 'shop.update' : 'shop.price') : 'shop.stock';
      await log(tx, actor, action, id, changed);
      await announce(tx, { t: 'shop' });
      return row;
    });
    return toAdminShopItemJson(item, row, sold.get(id) ?? 0);
  }

  /** Orders per item (or just the one). */
  private async soldCounts(item?: string): Promise<Map<string, number>> {
    const groups = await this.prisma.shopOrder.groupBy({ by: ['item'], where: item ? { item } : {}, _count: { _all: true } });
    return new Map(groups.map((g) => [g.item, g._count._all]));
  }

  /** Members, newest first, optionally matching `q` in their email or username. */
  async users({ q, limit, offset }: PageQuery & { q?: string }): Promise<{ users: AdminUserJson[]; total: number }> {
    const term = q?.trim().slice(0, 100);
    const where: Prisma.UserWhereInput = term
      ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { username: { contains: term, mode: 'insensitive' } }] }
      : {};
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({ where, include: withCounts, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset }),
      this.prisma.user.count({ where }),
    ]);
    return { users: users.map(toAdminUserJson), total };
  }

  async user(id: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: withCounts });
    if (!user) throw new NotFoundException('No such member');
    const [purchases, rounds, groups, shopOrders, shopOrdersTotal] = await Promise.all([
      this.prisma.ticketPurchase.findMany({ where: { userId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 }),
      this.prisma.rideRound.findMany({ where: { userId: id }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 30 }),
      this.prisma.rideRound.groupBy({ by: ['ride'], where: { userId: id }, _count: { _all: true }, _sum: { ticketsSpent: true } }),
      this.prisma.shopOrder.findMany({ where: { userId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 }),
      this.prisma.shopOrder.count({ where: { userId: id } }),
    ]);
    const byRide: AdminUserDetail['byRide'] = {};
    for (const g of groups) byRide[g.ride] = { rounds: g._count._all, ticketsSpent: g._sum.ticketsSpent ?? 0 };
    return {
      user: toAdminUserJson(user),
      purchases: purchases.map(toPurchaseJson),
      rounds: rounds.map(toRoundJson),
      byRide,
      shopOrders: shopOrders.map(toOrderJson),
      shopOrdersTotal,
    };
  }

  /**
   * Sets a member's balance, role, or lets them buy their next pack now. Staff can't change their
   * own role, so the office never locks out the last person who can open it.
   */
  async updateUser(actor: User, id: string, dto: UpdateUserDto): Promise<AdminUserJson> {
    if (dto.role !== undefined && id === actor.id && dto.role !== actor.role) {
      throw new BadRequestException("You can't change your own role. Ask another member of staff.");
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('No such member');
      const data: Prisma.UserUpdateInput = {};
      if (dto.ticketBalance !== undefined && dto.ticketBalance !== before.ticketBalance) {
        data.ticketBalance = dto.ticketBalance;
        await log(tx, actor, 'user.tickets', before.email, { before: { tickets: before.ticketBalance }, after: { tickets: dto.ticketBalance } });
      }
      if (dto.role !== undefined && dto.role !== before.role) {
        data.role = dto.role;
        await log(tx, actor, 'user.role', before.email, { before: { role: before.role }, after: { role: dto.role } });
      }
      if (dto.resetCooldown && before.lastPurchaseAt) {
        data.lastPurchaseAt = null;
        await log(tx, actor, 'user.cooldown', before.email, { before: { lastPurchaseAt: before.lastPurchaseAt.toISOString() }, after: { lastPurchaseAt: null } });
      }
      const user = await tx.user.update({ where: { id }, data, include: withCounts });
      // the member sees their new balance, role or cool-down at once, if they're in the fair
      if (Object.keys(data).length) await announce(tx, { t: 'user', id, ...accountNews(user) });
      return user;
    });
    return toAdminUserJson(updated);
  }

  /** Deletes a member with their purchases and rounds. Not yourself: that's the account card's job. */
  async deleteUser(actor: User, id: string): Promise<void> {
    if (id === actor.id) throw new BadRequestException("You can't delete your own account from the office. Use your account card in the fair.");
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: withCounts });
      if (!user) throw new NotFoundException('No such member');
      const released = await tx.creation.count({ where: { userId: id, status: 'released' } });
      await tx.user.delete({ where: { id } });
      // signed out on the spot, if they're in the fair
      await announce(tx, { t: 'user', id, deleted: true });
      // their coasters go with them: a plot they had in Creators' Valley empties for everyone
      if (released) await announce(tx, { t: 'park' });
      await log(tx, actor, 'user.delete', user.email, {
        before: { username: user.username, tickets: user.ticketBalance, rounds: user._count.rounds, purchases: user._count.purchases },
      });
    });
  }

  async purchases({ limit, offset }: PageQuery): Promise<{ purchases: AdminPurchaseJson[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.ticketPurchase.findMany({
        include: { user: { select: { id: true, username: true, email: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.ticketPurchase.count(),
    ]);
    return { purchases: rows.map((p) => ({ ...toPurchaseJson(p), provider: p.provider, user: p.user })), total };
  }

  /** Treats and souvenirs bought at the booth's shop, newest first. */
  async shopOrders({ limit, offset }: PageQuery): Promise<{ orders: AdminShopOrderJson[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.shopOrder.findMany({
        include: { user: { select: { id: true, username: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.shopOrder.count(),
    ]);
    return { orders: rows.map((o) => ({ ...toOrderJson(o), user: o.user })), total };
  }

  async rounds({ ride, limit, offset }: PageQuery & { ride?: Attraction }): Promise<{ rounds: AdminRoundJson[]; total: number }> {
    const where: Prisma.RideRoundWhereInput = ride ? { ride } : {};
    const [rows, total] = await Promise.all([
      this.prisma.rideRound.findMany({
        where,
        include: { user: { select: { id: true, username: true } } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.rideRound.count({ where }),
    ]);
    return { rounds: rows.map((r) => ({ ...toRoundJson(r), user: r.user })), total };
  }

  /** The Idea Box, newest first (optionally one status only), and how many suggestions there are in each status. */
  async suggestions({
    status,
    limit,
    offset,
  }: PageQuery & { status?: SuggestionStatus }): Promise<{ suggestions: AdminSuggestionJson[]; total: number; counts: Record<SuggestionStatus, number> }> {
    const where: Prisma.SuggestionWhereInput = status ? { status } : {};
    const [rows, total, groups] = await Promise.all([
      this.prisma.suggestion.findMany({ where, include: withAuthor, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset }),
      this.prisma.suggestion.count({ where }),
      this.prisma.suggestion.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(Object.values(SuggestionStatus).map((s) => [s, 0])) as Record<SuggestionStatus, number>;
    for (const g of groups) counts[g.status] = g._count._all;
    return { suggestions: rows.map(toAdminSuggestionJson), total, counts };
  }

  /**
   * Answers a suggestion, or moves its status along. The answer is given once: a suggestion already
   * answered gets a 409, even when two staff send theirs at the same moment. The status can change
   * as often as needed. Either way it turns unread for its author, whose open game tabs hear at once.
   * Logged as suggestion.reply (with the status, if that changed too) or suggestion.status.
   */
  async updateSuggestion(actor: User, id: string, dto: UpdateSuggestionDto): Promise<AdminSuggestionJson> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.suggestion.findUnique({ where: { id }, include: { user: { select: { id: true, username: true, email: true } } } });
      if (!before) throw new NotFoundException('No such suggestion');
      const replying = dto.reply !== undefined;
      if (replying && before.reply !== null) throw answered();

      const now = new Date();
      const data: Prisma.SuggestionUncheckedUpdateManyInput = {};
      const changed: { before: Record<string, unknown>; after: Record<string, unknown> } = { before: {}, after: {} };
      if (dto.status !== undefined && dto.status !== before.status) {
        data.status = dto.status;
        data.statusChangedAt = now;
        changed.before.status = before.status;
        changed.after.status = dto.status;
      }
      if (replying) {
        Object.assign(data, { reply: dto.reply, repliedAt: now, repliedById: actor.id, repliedByName: actor.username });
        changed.after.reply = dto.reply;
      }
      if (!Object.keys(data).length) return toAdminSuggestionJson(before);

      // an answer only lands while there is none: of two at once, the second finds one and stops
      const { count } = await tx.suggestion.updateMany({ where: { id, ...(replying ? { reply: null } : {}) }, data: { ...data, unread: true } });
      if (!count) throw answered();
      const row = await tx.suggestion.findUniqueOrThrow({ where: { id }, include: withAuthor });
      await log(tx, actor, replying ? 'suggestion.reply' : 'suggestion.status', before.user.email, { ...changed, excerpt: excerpt(before.message) });
      // the author sees it at the Idea Box straight away, if they're in the fair; other staff in the office too
      await announce(tx, { t: 'suggestions', userId: before.userId });
      await announce(tx, { t: 'office', kind: 'suggestions' });
      return toAdminSuggestionJson(row);
    });
  }

  /**
   * Takes a Rally Trail run off its leaderboard (the player's next-best run takes its place), or
   * puts it back. The run is kept either way. Logged as trail.disqualify or trail.reinstate, and the
   * boards in the fair catch up at once.
   */
  async updateTrailRun(actor: User, id: string, disqualified: boolean): Promise<{ id: string; disqualified: boolean }> {
    const run = await this.prisma.trailRun.findUnique({ where: { id }, include: { user: { select: { email: true, username: true } } } });
    if (!run) throw new NotFoundException('There is no such run');
    await this.prisma.$transaction(async (tx) => {
      // only if it isn't so already: two staff clicking at once change (and log) it once
      const { count } = await tx.trailRun.updateMany({ where: { id, disqualified: !disqualified }, data: { disqualified } });
      if (!count) return;
      await log(tx, actor, disqualified ? 'trail.disqualify' : 'trail.reinstate', run.user.email, {
        before: { disqualified: !disqualified },
        after: { disqualified },
        username: run.user.username,
        timeMs: run.timeMs,
        day: run.day.toISOString().slice(0, 10),
      });
      await announce(tx, { t: 'leaderboard' });
      await announce(tx, { t: 'office', kind: 'trail' });
    });
    return { id, disqualified };
  }

  async actions({ limit, offset }: PageQuery): Promise<{ actions: AdminActionJson[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.adminAction.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset }),
      this.prisma.adminAction.count(),
    ]);
    return {
      actions: rows.map((a) => ({ id: a.id, actorName: a.actorName, action: a.action, target: a.target, details: a.details, createdAt: a.createdAt.toISOString() })),
      total,
    };
  }
}

function toParkJson(
  rules: Pick<ParkRules, 'open' | 'closedMessage' | 'underMaintenance' | 'maintenanceMessage' | 'packSize' | 'cooldownHours' | 'ticketCap' | 'updatedAt'>,
): ParkSettingsJson {
  return {
    open: rules.open,
    closedMessage: rules.closedMessage,
    underMaintenance: rules.underMaintenance,
    maintenanceMessage: rules.maintenanceMessage,
    packSize: rules.packSize,
    cooldownHours: rules.cooldownHours,
    ticketCap: rules.ticketCap,
    updatedAt: rules.updatedAt?.toISOString() ?? null,
  };
}

function toAccessJson(rules: AccessRules, ip: string | null): AccessJson {
  return { enabled: rules.on, entries: rules.entries.map(toAllowedIpJson), you: { ip, allowed: rules.allows(ip) } };
}

function toAllowedIpJson(row: AllowedIp): AllowedIpJson {
  return { id: row.id, ip: row.ip, label: row.label, addedBy: row.addedBy, createdAt: row.createdAt.toISOString() };
}

function toAttractionJson(rules: AttractionRules): AttractionJson {
  return { ...rules, updatedAt: rules.updatedAt?.toISOString() ?? null };
}

function toAdminShopItemJson(
  item: ShopItem,
  row: { tickets: number; stock: number | null; updatedAt: Date } | undefined,
  sold: number,
): AdminShopItemJson {
  return { ...toItemJson(item, row), defaultTickets: item.tickets, sold, updatedAt: row?.updatedAt.toISOString() ?? null };
}

function toAdminSuggestionJson(s: Suggestion & { user: { id: string; username: string } }): AdminSuggestionJson {
  return { ...toSuggestionJson(s), user: { id: s.user.id, username: s.user.username } };
}

/** 409: staff answer a suggestion once, and the answer stays as it was given. */
const answered = () => new ConflictException('This suggestion has already been answered, and an answer can’t be changed.');

/** The start of a suggestion, for the logbook. */
const excerpt = (text: string) => (text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text);

function toAdminUserJson(user: UserWithCounts): AdminUserJson {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    ticketBalance: user.ticketBalance,
    lastPurchaseAt: user.lastPurchaseAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    gender: user.gender,
    google: user.googleId !== null,
    hasPassword: user.passwordHash !== null,
    rounds: user._count.rounds,
    purchases: user._count.purchases,
  };
}
