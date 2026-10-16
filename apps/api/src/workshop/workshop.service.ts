import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type CoasterPart, type Creation, type User } from '../generated/prisma/client.js';
import { announceQuietly } from '../live/announce.js';
import { isStaff, ParkService } from '../park/park.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  toCreationJson,
  toDesignJson,
  toDesignSummaryJson,
  toMyCreationJson,
  partsOf,
  type CreationJson,
  type DesignJson,
  type DesignSummaryJson,
  type MyCreationJson,
} from './creation-json.js';
import {
  checkTrack,
  cleanDesign,
  DesignError,
  EXTRA_SLOT_PRICE_USD,
  FREE_DESIGN_SLOTS,
  layTrack,
  MAX_PART_ORDER,
  noParts,
  PART_IDS,
  PARTS,
  partsUsed,
  rideStats,
  shortfall,
  STARTER_KIT,
  SUBMISSIONS_PER_DAY,
  type Design,
  type Part,
  type Parts,
} from './design.js';

/** A coaster part as it sells today: the price set in The Ringmaster's Office, and what's left. */
export interface PartJson {
  id: Part;
  name: string;
  unit: string;
  icon: string;
  blurb: string;
  tickets: number;
  /** Units left to sell: 0 is sold out, null is no limit. */
  stock: number | null;
}

/** Everything the Coaster Workshop shows a member. */
export interface WorkshopJson {
  parts: PartJson[];
  /** Parts the member owns, and how many of them their saved designs hold. */
  owned: Parts;
  held: Parts;
  starterKit: { claimed: boolean; contents: Partial<Parts> };
  slots: { free: number; extra: number; used: number; extraPriceUsd: number; onSale: boolean };
  submissions: { perDay: number; last24h: number; nextAt: string | null };
  designs: DesignSummaryJson[];
  /** Submissions with news from staff the member hasn't seen. */
  unread: number;
}

export interface BuyPartsResult {
  balance: number;
  owned: Parts;
  part: PartJson;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The picture a submission comes with: small, and really a picture. */
export const PICTURE_MAX = 120 * 1024;
const PICTURE = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

type Tx = Prisma.TransactionClient;

/**
 * The Coaster Workshop, for members: the parts shop (paid in tickets, stock set in the office) and
 * the free starter kit, saved designs (a few free; they hold the parts they use), and sending a
 * design to staff as a snapshot. The rules themselves (pieces, parts, track, physics) are in
 * design.ts, shared with the game.
 */
@Injectable()
export class WorkshopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly park: ParkService,
  ) {}

  async workshop(user: User): Promise<WorkshopJson> {
    const userId = user.id;
    const [parts, owned, designs, recent, unread, fresh] = await Promise.all([
      this.catalog(),
      this.owned(this.prisma, userId),
      this.prisma.coasterDesign.findMany({ where: { userId }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] }),
      this.recentSubmissions(userId),
      this.prisma.creation.count({ where: { userId, unread: true } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { starterKitAt: true, extraDesignSlots: true } }),
    ]);
    const latest = await this.latestCreations(designs.map((d) => d.id));
    const held = noParts();
    for (const d of designs) addParts(held, partsOf(d.parts));
    return {
      parts,
      owned,
      held,
      starterKit: { claimed: fresh.starterKitAt !== null, contents: STARTER_KIT },
      slots: { free: FREE_DESIGN_SLOTS, extra: fresh.extraDesignSlots, used: designs.length, extraPriceUsd: EXTRA_SLOT_PRICE_USD, onSale: false },
      submissions: { perDay: SUBMISSIONS_PER_DAY, last24h: recent.length, nextAt: recent.length >= SUBMISSIONS_PER_DAY ? nextSubmissionAt(recent) : null },
      designs: designs.map((d) => toDesignSummaryJson(d, latest.get(d.id))),
      unread,
    };
  }

  /** Every part at today's price, with what's left of it. */
  async catalog(): Promise<PartJson[]> {
    const rows = new Map((await this.prisma.coasterPartSettings.findMany()).map((r) => [r.part, r]));
    return PART_IDS.map((id) => toPartJson(id, rows.get(id)));
  }

  /** The member's free box of parts, once. 409 if they've had it. */
  async claimStarterKit(user: User): Promise<WorkshopJson> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({ where: { id: user.id, starterKitAt: null }, data: { starterKitAt: new Date() } });
      if (!count) throw new ConflictException('You’ve had your starter kit already');
      for (const [part, quantity] of Object.entries(STARTER_KIT) as [Part, number][]) await this.give(tx, user.id, part, quantity);
    });
    return this.workshop(user);
  }

  /**
   * Buys `quantity` of one part. Like the booth's shop: the balance check and the payment are one
   * conditional UPDATE, and taking them from the stock another, so nothing is spent or sold twice.
   * 402 when the balance is short, 409 with code 'sold_out' when there aren't enough left.
   */
  async buyParts(user: User, part: Part, quantity: number): Promise<BuyPartsResult> {
    if (!PART_IDS.includes(part)) throw new BadRequestException('There is no such part');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PART_ORDER) throw new BadRequestException(`Buy 1 to ${MAX_PART_ORDER} at a time`);
    this.park.assertParkOpen(await this.park.rules(), user);
    const userId = user.id;
    const result = await this.prisma.$transaction(async (tx) => {
      const settings = await tx.coasterPartSettings.findUnique({ where: { part } });
      if (settings?.stock !== null && settings?.stock !== undefined && settings.stock < quantity) throw soldOut(part, settings.stock);
      const cost = (settings?.tickets ?? PARTS[part].tickets) * quantity;
      const { count } = await tx.user.updateMany({ where: { id: userId, ticketBalance: { gte: cost } }, data: { ticketBalance: { decrement: cost } } });
      if (count === 0) return { short: cost };
      if (settings && settings.stock !== null) {
        // that many off the stock: too few left now rolls the payment back
        const { count: taken } = await tx.coasterPartSettings.updateMany({ where: { part, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } });
        if (taken === 0) throw soldOut(part, 0);
      }
      await this.give(tx, userId, part, quantity);
      const { ticketBalance } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { ticketBalance: true } });
      await tx.coasterPartOrder.create({ data: { userId, part, quantity, ticketsSpent: cost, balanceAfter: ticketBalance } });
      const left = await tx.coasterPartSettings.findUnique({ where: { part } });
      return { balance: ticketBalance, owned: await this.owned(tx, userId), part: toPartJson(part, left ?? undefined), stocked: left?.stock !== null && left?.stock !== undefined };
    });
    if ('short' in result) {
      const fresh = await this.prisma.user.findUnique({ where: { id: userId }, select: { ticketBalance: true } });
      throw new HttpException(
        { ...HttpException.createBody('Not enough tickets', 'Payment Required', HttpStatus.PAYMENT_REQUIRED), needed: result.short, balance: fresh?.ticketBalance ?? 0 },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    await announceQuietly(this.prisma, { t: 'office', kind: 'purchases' });
    if (result.stocked) await announceQuietly(this.prisma, { t: 'workshop' });
    const { stocked: _stocked, ...done } = result;
    return done;
  }

  async design(userId: string, id: string): Promise<DesignJson> {
    const d = await this.prisma.coasterDesign.findFirst({ where: { id, userId } });
    if (!d) throw new NotFoundException('No such design');
    return toDesignJson(d, (await this.latestCreations([id])).get(id));
  }

  /**
   * Saves a new design. 409 with code 'no_slot' when every slot is taken, or 'parts' (with what's
   * missing) when the member's free parts don't cover it. The track needn't be finished yet.
   */
  async createDesign(user: User, raw: unknown): Promise<DesignJson> {
    const design = parseDesign(raw);
    const parts = partsUsed(design, layTrack(design.pieces));
    const row = await this.prisma.$transaction(async (tx) => {
      const { extraDesignSlots } = await lockUser(tx, user.id);
      const count = await tx.coasterDesign.count({ where: { userId: user.id } });
      if (count >= FREE_DESIGN_SLOTS + extraDesignSlots) {
        throw new HttpException(
          {
            ...HttpException.createBody(`All ${FREE_DESIGN_SLOTS + extraDesignSlots} design slots are taken. Delete a design, or get another slot.`, 'Conflict', HttpStatus.CONFLICT),
            code: 'no_slot',
          },
          HttpStatus.CONFLICT,
        );
      }
      await this.assertParts(tx, user.id, parts, null);
      return tx.coasterDesign.create({ data: { userId: user.id, name: design.name, data: design as unknown as Prisma.InputJsonObject, parts } });
    });
    return toDesignJson(row, null);
  }

  /** Saves changes to a design (a released or waiting snapshot of it is unaffected). 409 'parts' as above. */
  async updateDesign(user: User, id: string, raw: unknown): Promise<DesignJson> {
    const design = parseDesign(raw);
    const parts = partsUsed(design, layTrack(design.pieces));
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, user.id);
      const found = await tx.coasterDesign.findFirst({ where: { id, userId: user.id }, select: { id: true } });
      if (!found) throw new NotFoundException('No such design');
      await this.assertParts(tx, user.id, parts, id);
      return tx.coasterDesign.update({ where: { id }, data: { name: design.name, data: design as unknown as Prisma.InputJsonObject, parts } });
    });
    return toDesignJson(row, (await this.latestCreations([id])).get(id));
  }

  /** Deletes a design: its parts are free again. Coasters sent from it stay as they are. */
  async deleteDesign(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.coasterDesign.deleteMany({ where: { id, userId } });
    if (!count) throw new NotFoundException('No such design');
  }

  /**
   * Sends a saved design to staff, as it is now: a snapshot, with its numbers worked out here and the
   * picture the game took. The circuit has to be buildable (422 with the issues otherwise), one
   * design can only wait for staff once at a time (409 'pending'), and a member can send
   * SUBMISSIONS_PER_DAY in 24 hours (429 'submission_limit').
   */
  async submit(user: User, designId: string, picture: string | undefined): Promise<MyCreationJson> {
    const image = parsePicture(picture);
    const row = await this.prisma.coasterDesign.findFirst({ where: { id: designId, userId: user.id } });
    if (!row) throw new NotFoundException('No such design');
    const design = parseDesign(row.data);
    const track = layTrack(design.pieces);
    const issues = checkTrack(design.pieces, track);
    if (issues.length) {
      throw new HttpException(
        { ...HttpException.createBody(issues[0].message, 'Unprocessable Entity', HttpStatus.UNPROCESSABLE_ENTITY), code: 'not_buildable', issues },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const stats = rideStats(track, design.mode);

    const created = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, user.id);
      const recent = await this.recentSubmissions(user.id, tx);
      if (recent.length >= SUBMISSIONS_PER_DAY) {
        throw new HttpException(
          {
            ...HttpException.createBody(`That's ${SUBMISSIONS_PER_DAY} coasters sent in a day already. You can send another tomorrow.`, 'Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
            code: 'submission_limit',
            nextAt: nextSubmissionAt(recent),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (await tx.creation.count({ where: { designId, status: 'pending' } })) {
        throw new HttpException(
          { ...HttpException.createBody('This design is already waiting for staff. Withdraw that one first to send it again.', 'Conflict', HttpStatus.CONFLICT), code: 'pending' },
          HttpStatus.CONFLICT,
        );
      }
      return tx.creation.create({
        data: {
          designId,
          userId: user.id,
          name: design.name,
          data: design as unknown as Prisma.InputJsonObject,
          stats: stats as unknown as Prisma.InputJsonObject,
          picture: image ? new Uint8Array(image.bytes) : null,
          pictureType: image?.type ?? null,
        },
        omit: { picture: true },
      });
    });
    await announceQuietly(this.prisma, { t: 'office', kind: 'creations' });
    return toMyCreationJson(created);
  }

  /** Takes back a submission staff haven't answered yet. */
  async withdraw(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.creation.deleteMany({ where: { id, userId, status: 'pending' } });
    if (!count) {
      const exists = await this.prisma.creation.count({ where: { id, userId } });
      if (!exists) throw new NotFoundException('No such submission');
      throw new ConflictException('Staff have answered this one already');
    }
    await announceQuietly(this.prisma, { t: 'office', kind: 'creations' });
  }

  /** The member's submissions, newest first, with what their released ones have earned. */
  async mine(userId: string): Promise<{ creations: MyCreationJson[]; unread: number }> {
    const rows = await this.prisma.creation.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50, omit: { picture: true } });
    const earnings = await this.prisma.rideRound.groupBy({
      by: ['creationId'],
      where: { creationId: { in: rows.map((r) => r.id) }, royalty: { gt: 0 } },
      _count: { _all: true },
      _sum: { royalty: true },
    });
    const byId = new Map(earnings.map((e) => [e.creationId, { rides: e._count._all, earned: e._sum.royalty ?? 0 }]));
    return { creations: rows.map((r) => toMyCreationJson(r, byId.get(r.id))), unread: rows.filter((r) => r.unread).length };
  }

  /** The member has seen staff's news on their coasters (in every tab they have open). */
  async markSeen(userId: string): Promise<void> {
    const { count } = await this.prisma.creation.updateMany({ where: { userId, unread: true }, data: { unread: false } });
    if (count) await announceQuietly(this.prisma, { t: 'creations', userId });
  }

  /** A coaster to build and ride: anyone may see a released one, its creator and staff any of them. */
  async creation(viewer: User | null, id: string): Promise<CreationJson> {
    const c = await this.prisma.creation.findUnique({ where: { id }, include: { user: { select: { username: true } } }, omit: { picture: true } });
    if (!c || !canSee(viewer, c)) throw new NotFoundException('No such coaster');
    return toCreationJson(c);
  }

  async picture(viewer: User | null, id: string): Promise<{ bytes: Uint8Array; type: string; released: boolean }> {
    const c = await this.prisma.creation.findUnique({ where: { id }, select: { userId: true, status: true, picture: true, pictureType: true } });
    if (!c || !c.picture || !c.pictureType || !canSee(viewer, c)) throw new NotFoundException('No picture');
    return { bytes: c.picture, type: c.pictureType, released: c.status === 'released' };
  }

  // ---------- helpers ----------

  private async owned(db: Pick<Tx, 'coasterParts'>, userId: string): Promise<Parts> {
    const parts = noParts();
    for (const r of await db.coasterParts.findMany({ where: { userId } })) parts[r.part] = r.quantity;
    return parts;
  }

  private give(tx: Tx, userId: string, part: CoasterPart, quantity: number) {
    return tx.coasterParts.upsert({
      where: { userId_part: { userId, part } },
      create: { userId, part, quantity },
      update: { quantity: { increment: quantity } },
    });
  }

  /** 409 'parts' unless the member's parts, less what their other designs hold, cover `used`. */
  private async assertParts(tx: Tx, userId: string, used: Parts, except: string | null) {
    const [owned, others] = await Promise.all([
      this.owned(tx, userId),
      tx.coasterDesign.findMany({ where: { userId, ...(except ? { id: { not: except } } : {}) }, select: { parts: true } }),
    ]);
    const free = { ...owned };
    for (const d of others) addParts(free, partsOf(d.parts), -1);
    const missing = shortfall(used, free);
    if (Object.keys(missing).length) {
      const list = (Object.entries(missing) as [Part, number][]).map(([p, n]) => `${n} × ${PARTS[p].name}`).join(', ');
      throw new HttpException(
        { ...HttpException.createBody(`Not enough parts: you need ${list} more.`, 'Conflict', HttpStatus.CONFLICT), code: 'parts', missing },
        HttpStatus.CONFLICT,
      );
    }
  }

  private recentSubmissions(userId: string, db: Pick<Tx, 'creation'> = this.prisma) {
    return db.creation.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
      take: SUBMISSIONS_PER_DAY,
    });
  }

  /** Each design's newest submission. */
  private async latestCreations(designIds: string[]) {
    const rows = designIds.length
      ? await this.prisma.creation.findMany({
          where: { designId: { in: designIds } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          distinct: ['designId'],
          select: { id: true, designId: true, status: true, plot: true },
        })
      : [];
    return new Map(rows.map((r) => [r.designId!, r]));
  }
}

/** Takes the member's row lock (one save or submission at a time) and returns their slots. */
async function lockUser(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<{ extra_design_slots: number }[]>`SELECT extra_design_slots FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!rows.length) throw new NotFoundException('No such member');
  return { extraDesignSlots: rows[0].extra_design_slots };
}

function canSee(viewer: Pick<User, 'id' | 'role'> | null, c: Pick<Creation, 'userId' | 'status'>) {
  return c.status === 'released' || (!!viewer && (viewer.id === c.userId || isStaff(viewer)));
}

function parseDesign(raw: unknown): Design {
  try {
    return cleanDesign(raw);
  } catch (err) {
    if (err instanceof DesignError) throw new BadRequestException(err.message);
    throw err;
  }
}

function parsePicture(value: string | undefined): { bytes: Buffer; type: string } | null {
  if (value === undefined || value === '') return null;
  const m = PICTURE.exec(value);
  if (!m) throw new BadRequestException('The picture must be a WebP, PNG or JPEG data URL');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > PICTURE_MAX) throw new BadRequestException('The picture is too big');
  if (!MAGIC[m[1]](bytes)) throw new BadRequestException('The picture isn’t what it says it is');
  return { bytes, type: `image/${m[1]}` };
}

function nextSubmissionAt(recent: { createdAt: Date }[]) {
  return new Date(recent[recent.length - 1].createdAt.getTime() + DAY_MS).toISOString();
}

function addParts(into: Parts, add: Parts, sign = 1) {
  for (const p of PART_IDS) into[p] += sign * (add[p] ?? 0);
}

export function toPartJson(id: Part, row: { tickets: number; stock: number | null } | undefined): PartJson {
  const p = PARTS[id];
  return { id, name: p.name, unit: p.unit, icon: p.icon, blurb: p.blurb, tickets: row?.tickets ?? p.tickets, stock: row?.stock ?? null };
}

/** 409 with code 'sold_out', and how many are left. */
function soldOut(part: Part, left: number) {
  return new HttpException(
    {
      ...HttpException.createBody(left ? `Only ${left} × ${PARTS[part].name} left` : `${PARTS[part].name} is sold out`, 'Conflict', HttpStatus.CONFLICT),
      code: 'sold_out',
      part,
      left,
    },
    HttpStatus.CONFLICT,
  );
}

