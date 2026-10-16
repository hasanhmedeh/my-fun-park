import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreationStatus, Prisma, type Attraction, type Creation, type User } from '../generated/prisma/client.js';
import { announce } from '../live/announce.js';
import { ParkService } from '../park/park.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { changes, defined, log } from '../ringmaster/logbook.js';
import { PART_IDS, PARTS, PLOTS, type Design, type Part, type RideStats } from './design.js';
import { toPartJson, type PartJson } from './workshop.service.js';

/** A submitted coaster as staff see it in the office's grid. */
export interface AdminCreationJson {
  id: string;
  name: string;
  user: { id: string; username: string };
  designId: string | null;
  status: CreationStatus;
  statusChangedAt: string | null;
  plot: number | null;
  reply: string | null;
  reviewedBy: string | null;
  stats: RideStats;
  mode: Design['mode'];
  cars: number;
  pieces: number;
  hasPicture: boolean;
  createdAt: string;
  releasedAt: string | null;
  removedAt: string | null;
  /** Other guests' rides on it, and the tickets its creator earned from them. */
  rides: number;
  earned: number;
  /** Another version of the same design, running in the park now: releasing this one can take its plot. */
  live: { id: string; name: string; plot: number } | null;
}

/** One of Creators' Valley's plots: what runs there, at what price, and whether it's open. */
export interface PlotJson {
  plot: number;
  attraction: Attraction;
  creation: { id: string; name: string; creator: string } | null;
  tickets: number;
  open: boolean;
}

/** A coaster part as staff see and edit it. */
export interface AdminPartJson extends PartJson {
  defaultTickets: number;
  /** Units sold, ever. */
  sold: number;
  updatedAt: string | null;
}

export const plotAttraction = (plot: number) => `plot${plot}` as Attraction;
export const plotOf = (attraction: Attraction) => (/^plot[1-8]$/.test(attraction) ? Number(attraction.slice(4)) : null);

type Row = Omit<Creation, 'picture'> & { user: { id: string; username: string } };
const withCreator = { user: { select: { id: true, username: true } } } as const;

/**
 * The office's side of the Coaster Workshop: the grid of coasters members sent, releasing one onto
 * a plot of Creators' Valley (or in place of an older version of it), declining one with a reply,
 * taking one out of the park, and the parts' prices and stock. Every change is logged, the creator
 * hears at once, and a release or removal reaches everyone in the fair (GET /park changes).
 */
@Injectable()
export class CreationsOfficeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly park: ParkService,
  ) {}

  async list({ status, limit, offset }: { status?: CreationStatus; limit: number; offset: number }) {
    const where: Prisma.CreationWhereInput = status ? { status } : {};
    const [rows, total, groups, plots] = await Promise.all([
      this.prisma.creation.findMany({ where, include: withCreator, omit: { picture: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset }),
      this.prisma.creation.count({ where }),
      this.prisma.creation.groupBy({ by: ['status'], _count: { _all: true } }),
      this.plots(),
    ]);
    const counts = Object.fromEntries(Object.values(CreationStatus).map((s) => [s, 0])) as Record<CreationStatus, number>;
    for (const g of groups) counts[g.status] = g._count._all;
    return { creations: await this.toJson(rows), total, counts, plots };
  }

  async one(id: string): Promise<AdminCreationJson> {
    const row = await this.prisma.creation.findUnique({ where: { id }, include: withCreator, omit: { picture: true } });
    if (!row) throw new NotFoundException('No such coaster');
    return (await this.toJson([row]))[0];
  }

  /** The eight plots, with what's on each. */
  async plots(): Promise<PlotJson[]> {
    const [released, attractions] = await Promise.all([
      this.prisma.creation.findMany({ where: { status: 'released' }, select: { id: true, name: true, plot: true, user: { select: { username: true } } } }),
      this.park.attractions(),
    ]);
    return Array.from({ length: PLOTS }, (_, k) => {
      const plot = k + 1;
      const c = released.find((r) => r.plot === plot);
      const rules = attractions.find((a) => a.attraction === plotAttraction(plot))!;
      return { plot, attraction: rules.attraction, creation: c ? { id: c.id, name: c.name, creator: c.user.username } : null, tickets: rules.tickets, open: rules.open };
    });
  }

  /**
   * Puts a coaster in the park, at `tickets` a ride: onto a free `plot`, or (`replace`) in place of
   * the version of the same design running now, which steps aside. From pending, declined or removed.
   * Logged as creation.release; the creator hears, and everyone in the fair sees it go up.
   */
  async release(actor: User, id: string, dto: { plot?: number; tickets?: number; replace?: boolean }): Promise<AdminCreationJson> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.creation.findUnique({ where: { id }, include: { user: { select: { email: true } } }, omit: { picture: true } });
        if (!c) throw new NotFoundException('No such coaster');
        if (c.status === 'released') throw new ConflictException(`${c.name} is in the park already, on plot ${c.plot}`);
        if (c.status === 'replaced') throw new ConflictException('A newer version of this coaster took its place; release that one');
        const now = new Date();
        let plot: number;
        let replaced: { id: string; name: string } | null = null;
        if (dto.replace) {
          const live = c.designId ? await tx.creation.findFirst({ where: { designId: c.designId, status: 'released', id: { not: id } } }) : null;
          if (!live) throw new ConflictException('No other version of this design is in the park to replace');
          await tx.creation.update({ where: { id: live.id }, data: { status: 'replaced', statusChangedAt: now, removedAt: now } });
          plot = live.plot!;
          replaced = { id: live.id, name: live.name };
        } else {
          if (!dto.plot || dto.plot < 1 || dto.plot > PLOTS) throw new BadRequestException(`Pick a plot, 1 to ${PLOTS}`);
          plot = dto.plot;
          const taken = await tx.creation.findFirst({ where: { plot, status: 'released' }, select: { name: true } });
          if (taken) throw new ConflictException(`Plot ${plot} has ${taken.name} on it`);
        }
        const { count } = await tx.creation.updateMany({
          where: { id, status: { in: ['pending', 'declined', 'removed'] } },
          data: { status: 'released', plot, releasedAt: now, removedAt: null, statusChangedAt: now, reviewedById: actor.id, reviewedByName: actor.username, unread: true },
        });
        if (!count) throw new ConflictException('Someone else just changed this coaster; have another look');
        const attraction = plotAttraction(plot);
        const tickets = dto.tickets ?? 1;
        await tx.attractionSettings.upsert({
          where: { attraction },
          create: { attraction, tickets, open: true },
          update: { tickets, open: true, closedMessage: null },
        });
        await log(tx, actor, 'creation.release', c.user.email, { name: c.name, plot, tickets, ...(replaced ? { replaced: replaced.name } : {}) });
        await announce(tx, { t: 'park' });
        await announce(tx, { t: 'creations', userId: c.userId });
        await announce(tx, { t: 'office', kind: 'creations' });
      });
    } catch (err) {
      // two releases onto one plot at once: the unique index lets the first one in
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('That plot was just taken');
      throw err;
    }
    return this.one(id);
  }

  /** Says no to a waiting coaster, with a reply its creator sees. Logged as creation.decline. */
  async decline(actor: User, id: string, reply: string): Promise<AdminCreationJson> {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.creation.findUnique({ where: { id }, include: { user: { select: { email: true } } }, omit: { picture: true } });
      if (!c) throw new NotFoundException('No such coaster');
      const now = new Date();
      const { count } = await tx.creation.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'declined', reply, statusChangedAt: now, reviewedById: actor.id, reviewedByName: actor.username, unread: true },
      });
      if (!count) throw new ConflictException('Only a coaster waiting for an answer can be declined');
      await log(tx, actor, 'creation.decline', c.user.email, { name: c.name, reply });
      await announce(tx, { t: 'creations', userId: c.userId });
      await announce(tx, { t: 'office', kind: 'creations' });
    });
    return this.one(id);
  }

  /** Takes a released coaster out of the park (anyone riding it is stopped and refunded). Logged as creation.remove. */
  async remove(actor: User, id: string): Promise<AdminCreationJson> {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.creation.findUnique({ where: { id }, include: { user: { select: { email: true } } }, omit: { picture: true } });
      if (!c) throw new NotFoundException('No such coaster');
      const now = new Date();
      const { count } = await tx.creation.updateMany({ where: { id, status: 'released' }, data: { status: 'removed', removedAt: now, statusChangedAt: now, unread: true } });
      if (!count) throw new ConflictException('This coaster isn’t in the park');
      await log(tx, actor, 'creation.remove', c.user.email, { name: c.name, plot: c.plot });
      await announce(tx, { t: 'park' });
      await announce(tx, { t: 'creations', userId: c.userId });
      await announce(tx, { t: 'office', kind: 'creations' });
    });
    return this.one(id);
  }

  /** Every coaster part, with its price, stock and how many have sold. */
  async parts(): Promise<{ parts: AdminPartJson[] }> {
    const [rows, sold] = await Promise.all([
      this.prisma.coasterPartSettings.findMany(),
      this.prisma.coasterPartOrder.groupBy({ by: ['part'], _sum: { quantity: true } }),
    ]);
    const byPart = new Map(rows.map((r) => [r.part, r]));
    const soldBy = new Map(sold.map((s) => [s.part, s._sum.quantity ?? 0]));
    return { parts: PART_IDS.map((p) => toAdminPartJson(p, byPart.get(p), soldBy.get(p) ?? 0)) };
  }

  /** Sets a part's price or stock (null for no limit). Logged as workshop.price, workshop.stock or workshop.update. */
  async updatePart(actor: User, part: string, dto: { tickets?: number; stock?: number | null }): Promise<AdminPartJson> {
    if (!PART_IDS.includes(part as Part)) throw new NotFoundException('There is no such part');
    const id = part as Part;
    const current = await this.prisma.coasterPartSettings.findUnique({ where: { part: id } });
    const before = { tickets: current?.tickets ?? PARTS[id].tickets, stock: current?.stock ?? null };
    const data = defined({ tickets: dto.tickets, stock: dto.stock });
    const changed = changes(before, data);
    const soldOf = async () => (await this.prisma.coasterPartOrder.aggregate({ where: { part: id }, _sum: { quantity: true } }))._sum.quantity ?? 0;
    if (!changed) return toAdminPartJson(id, current ?? undefined, await soldOf());
    const row = await this.prisma.$transaction(async (tx) => {
      const row = await tx.coasterPartSettings.upsert({ where: { part: id }, create: { part: id, ...before, ...data }, update: data });
      const action = 'tickets' in changed.after ? ('stock' in changed.after ? 'workshop.update' : 'workshop.price') : 'workshop.stock';
      await log(tx, actor, action, id, changed);
      await announce(tx, { t: 'workshop' });
      return row;
    });
    return toAdminPartJson(id, row, await soldOf());
  }

  private async toJson(rows: Row[]): Promise<AdminCreationJson[]> {
    const ids = rows.map((r) => r.id);
    const designIds = [...new Set(rows.flatMap((r) => (r.designId ? [r.designId] : [])))];
    const [earnings, live] = await Promise.all([
      ids.length
        ? this.prisma.rideRound.groupBy({ by: ['creationId'], where: { creationId: { in: ids }, royalty: { gt: 0 } }, _count: { _all: true }, _sum: { royalty: true } })
        : [],
      designIds.length ? this.prisma.creation.findMany({ where: { designId: { in: designIds }, status: 'released' }, select: { id: true, name: true, plot: true, designId: true } }) : [],
    ]);
    const earned = new Map(earnings.map((e) => [e.creationId, { rides: e._count._all, earned: e._sum.royalty ?? 0 }]));
    return rows.map((c) => {
      const data = c.data as unknown as Design;
      const other = live.find((l) => l.designId === c.designId && l.id !== c.id);
      return {
        id: c.id,
        name: c.name,
        user: c.user,
        designId: c.designId,
        status: c.status,
        statusChangedAt: c.statusChangedAt?.toISOString() ?? null,
        plot: c.plot,
        reply: c.reply,
        reviewedBy: c.reviewedByName,
        stats: c.stats as unknown as RideStats,
        mode: data.mode,
        cars: data.cars,
        pieces: data.pieces.length,
        hasPicture: c.pictureType !== null,
        createdAt: c.createdAt.toISOString(),
        releasedAt: c.releasedAt?.toISOString() ?? null,
        removedAt: c.removedAt?.toISOString() ?? null,
        rides: earned.get(c.id)?.rides ?? 0,
        earned: earned.get(c.id)?.earned ?? 0,
        live: other ? { id: other.id, name: other.name, plot: other.plot! } : null,
      };
    });
  }
}

function toAdminPartJson(part: Part, row: { tickets: number; stock: number | null; updatedAt: Date } | undefined, sold: number): AdminPartJson {
  return { ...toPartJson(part, row), defaultTickets: PARTS[part].tickets, sold, updatedAt: row?.updatedAt.toISOString() ?? null };
}
