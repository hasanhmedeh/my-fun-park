import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Attraction, type User } from '../generated/prisma/client.js';
import { isStaff, ParkService } from '../park/park.service.js';
import { accountNews, announce, announceQuietly } from '../live/announce.js';
import { plotOf } from '../workshop/creations-office.service.js';
import { royalty as royaltyOf } from '../workshop/design.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrailService, type TrailPlacement } from '../trail/trail.service.js';
import { ATTRACTIONS } from './attractions.js';
import type { FinishRoundDto } from './dto/finish-round.dto.js';
import { toRoundJson, type RoundJson } from './round-json.js';
import type { StatBests, Stats } from './stats.js';

export interface BoardResult {
  round: Pick<RoundJson, 'id' | 'ride' | 'ticketsSpent' | 'startedAt'>;
  /** Tickets left after paying for this round. */
  balance: number;
}

export interface FinishResult {
  round: RoundJson;
  history: {
    /** Completed rounds of this ride, this one included. */
    rounds: number;
    /** Over the user's previous completed rounds of this ride, this one excluded, so the client can spot new records. */
    best: StatBests;
  };
  /** A Rally Trail run that went on today's leaderboard: where it left the player. */
  trail?: TrailPlacement;
}

export interface RefundResult {
  /** Tickets given back: what the round cost. */
  refunded: number;
  /** The balance with them back in it. */
  balance: number;
}

/** A round can be refunded this long after it started: no attraction runs anywhere near an hour. */
const REFUND_WINDOW_MS = 60 * 60_000;

export interface RideSummary {
  /** Rounds started (each one paid for), finished or not. */
  rounds: number;
  ticketsSpent: number;
  /** Over every completed round. */
  best: StatBests;
  /** The latest round the game reported stats for, completed or not. */
  last: { stats: Stats; endedAt: string } | null;
}

export interface RideStats {
  totalRounds: number;
  ticketsSpent: number;
  byRide: Record<Attraction, RideSummary>;
}

/** One row of the per-key min/max aggregation. */
interface BestRow {
  ride: Attraction;
  key: string;
  min: number;
  max: number;
}

interface LastRow {
  ride: Attraction;
  stats: Stats;
  endedAt: Date;
}

@Injectable()
export class RidesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly park: ParkService,
    private readonly trail: TrailService,
  ) {}

  /**
   * Pays for one round and opens it, at the attraction's current price. A closed park or an
   * attraction under maintenance turns players away with a 503 (staff board anyway, to test it). The balance check and the decrement are one conditional UPDATE,
   * so concurrent boardings can't spend the same tickets twice; it also locks the user's row, which
   * queues a user's boardings one behind the other. Any round still open is closed as abandoned:
   * a visitor plays one thing at a time.
   */
  async board(user: User, ride: Attraction): Promise<BoardResult> {
    const [park, attraction] = await Promise.all([this.park.rules(), this.park.attraction(ride)]);
    this.park.assertParkOpen(park, user);
    this.park.assertAttractionOpen(attraction, user);
    const userId = user.id;
    const cost = attraction.tickets;
    const now = new Date();
    // a Creators' Valley plot runs whichever player-built coaster is released onto it, if any; its
    // creator earns a royalty from everyone else's rides
    const plot = plotOf(ride);
    const creation = plot ? await this.prisma.creation.findFirst({ where: { plot, status: 'released' }, select: { id: true, userId: true } }) : null;
    if (plot && !creation) {
      throw new HttpException({ ...HttpException.createBody('Nothing is running on this plot yet', 'Conflict', HttpStatus.CONFLICT), code: 'plot_empty' }, HttpStatus.CONFLICT);
    }
    const royalty = creation && creation.userId !== userId ? royaltyOf(cost) : 0;
    const result = await this.prisma.$transaction(async (tx) => {
      // both wallets locked in one order, so two creators riding each other's coasters can't deadlock
      if (royalty) await tx.$queryRaw`SELECT id FROM users WHERE id IN (${userId}, ${creation!.userId}) ORDER BY id FOR UPDATE`;
      const { count } = await tx.user.updateMany({
        where: { id: userId, ticketBalance: { gte: cost } },
        data: { ticketBalance: { decrement: cost } },
      });
      if (count === 0) return null;
      await tx.rideRound.updateMany({ where: { userId, endedAt: null }, data: { endedAt: now, completed: false } });
      const round = await tx.rideRound.create({ data: { userId, ride, ticketsSpent: cost, startedAt: now, creationId: creation?.id ?? null, royalty } });
      if (royalty) {
        const creator = await tx.user.update({ where: { id: creation!.userId }, data: { ticketBalance: { increment: royalty } } });
        // the creator sees their wallet go up, if they're in the fair
        await announce(tx, { t: 'user', id: creator.id, ...accountNews(creator) });
      }
      const { ticketBalance } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { ticketBalance: true } });
      return { round, balance: ticketBalance };
    });

    if (!result) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { ticketBalance: true } });
      throw new HttpException(
        {
          ...HttpException.createBody('Not enough tickets', 'Payment Required', HttpStatus.PAYMENT_REQUIRED),
          needed: cost,
          balance: user?.ticketBalance ?? 0,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    await announceQuietly(this.prisma, { t: 'office', kind: 'rounds' });
    const { round, balance } = result;
    return {
      round: { id: round.id, ride: round.ride, ticketsSpent: round.ticketsSpent, startedAt: round.startedAt.toISOString() },
      balance,
    };
  }

  /**
   * Records how a round went. Only its owner can, and only once: the update matches open rounds of
   * this user, so a second (or concurrent) finish finds nothing to update. A Rally Trail run that
   * crossed the line also goes on the daily leaderboard (see TrailService.record).
   */
  async finish(userId: string, roundId: string, { completed, stats }: FinishRoundDto): Promise<FinishResult> {
    const { count } = await this.prisma.rideRound.updateMany({
      where: { id: roundId, userId, endedAt: null },
      data: { endedAt: new Date(), completed, stats: stats ?? {} },
    });
    if (count === 0) {
      const exists = await this.prisma.rideRound.count({ where: { id: roundId, userId } });
      // Someone else's round gets the same answer as a missing one.
      if (!exists) throw new NotFoundException('Round not found');
      throw new ConflictException('This round is already over');
    }
    await announceQuietly(this.prisma, { t: 'office', kind: 'rounds' });

    const round = await this.prisma.rideRound.findUniqueOrThrow({ where: { id: roundId } });
    const [rounds, bestRows, trail] = await Promise.all([
      this.prisma.rideRound.count({ where: { userId, ride: round.ride, completed: true } }),
      this.bestRows(userId, { ride: round.ride, excludeRoundId: round.id }),
      // a Rally Trail run that crossed the line goes on the daily leaderboard
      round.ride === 'trail' ? this.trail.recordQuietly(round) : null,
    ]);
    return { round: toRoundJson(round), history: { rounds, best: toBests(bestRows) }, ...(trail ? { trail } : {}) };
  }

  /**
   * Ends a round cut short because its attraction (or the whole park) closed, or the park went
   * under maintenance, while it was being
   * played, and gives its tickets back. Only while it really is closed, not for staff (they ride
   * through closures), only for a round still open and started within the hour, and only once:
   * the update matches open rounds, so a second (or concurrent) refund finds nothing. The round
   * is kept, as abandoned and costing nothing.
   */
  async refund(user: User, roundId: string): Promise<RefundResult> {
    const round = await this.prisma.rideRound.findFirst({ where: { id: roundId, userId: user.id } });
    if (!round) throw new NotFoundException('Round not found');
    if (round.endedAt) throw new ConflictException('This round is already over');
    const [park, attraction, creation] = await Promise.all([
      this.park.rules(),
      this.park.attraction(round.ride),
      round.creationId ? this.prisma.creation.findUnique({ where: { id: round.creationId }, select: { status: true } }) : null,
    ]);
    // a player-built coaster taken out of the park mid-ride counts as closed (its royalty stays paid)
    const removed = !!round.creationId && creation?.status !== 'released';
    if (isStaff(user) || (park.open && !park.underMaintenance && attraction.open && !removed) || Date.now() - round.startedAt.getTime() > REFUND_WINDOW_MS) {
      throw new ConflictException('This round can only be finished, not refunded');
    }
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rideRound.updateMany({
        where: { id: roundId, userId: user.id, endedAt: null },
        data: { endedAt: new Date(), completed: false, stats: {}, ticketsSpent: 0 },
      });
      if (count === 0) throw new ConflictException('This round is already over');
      const { ticketBalance } = await tx.user.update({
        where: { id: user.id },
        data: { ticketBalance: { increment: round.ticketsSpent } },
        select: { ticketBalance: true },
      });
      await announce(tx, { t: 'office', kind: 'rounds' });
      return { refunded: round.ticketsSpent, balance: ticketBalance };
    });
  }

  /** Lifetime numbers per attraction, with every attraction present. */
  async stats(userId: string): Promise<RideStats> {
    const [groups, bestRows, lastRows] = await Promise.all([
      this.prisma.rideRound.groupBy({
        by: ['ride'],
        where: { userId },
        _count: { _all: true },
        _sum: { ticketsSpent: true },
      }),
      this.bestRows(userId, null),
      // The newest round with stats, per ride.
      this.prisma.$queryRaw<LastRow[]>`
        SELECT DISTINCT ON (ride) ride::text AS ride, stats, ended_at AS "endedAt"
        FROM ride_rounds
        WHERE user_id = ${userId} AND jsonb_typeof(stats) = 'object' AND ended_at IS NOT NULL
        ORDER BY ride, ended_at DESC`,
    ]);

    const byRide = Object.fromEntries(
      ATTRACTIONS.map((ride): [Attraction, RideSummary] => [ride, { rounds: 0, ticketsSpent: 0, best: {}, last: null }]),
    ) as Record<Attraction, RideSummary>;
    let totalRounds = 0;
    let ticketsSpent = 0;
    for (const group of groups) {
      const spent = group._sum.ticketsSpent ?? 0;
      byRide[group.ride].rounds = group._count._all;
      byRide[group.ride].ticketsSpent = spent;
      totalRounds += group._count._all;
      ticketsSpent += spent;
    }
    for (const row of bestRows) byRide[row.ride].best[row.key] = { min: row.min, max: row.max };
    for (const row of lastRows) byRide[row.ride].last = { stats: row.stats, endedAt: row.endedAt.toISOString() };
    return { totalRounds, ticketsSpent, byRide };
  }

  /** The user's latest rounds, newest first. */
  async history(userId: string, limit: number): Promise<{ rounds: RoundJson[] }> {
    const rounds = await this.prisma.rideRound.findMany({
      where: { userId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return { rounds: rounds.map(toRoundJson) };
  }

  /**
   * Lowest and highest value of every stat over the user's completed rounds, per ride, aggregated in
   * Postgres: jsonb_each unpacks each round's stats into (key, value) rows and GROUP BY folds them, so
   * a few rows come back (at most 16 keys per ride) however many rounds there are, and nothing has to
   * be capped. Rounds without a stats object are skipped inside the jsonb_each call itself (it throws
   * on non-objects, and a WHERE clause is not guaranteed to run first). `only` narrows it to one ride
   * and leaves one round out (the one just finished).
   */
  private bestRows(userId: string, only: { ride: Attraction; excludeRoundId: string } | null): Promise<BestRow[]> {
    const scope = only
      ? Prisma.sql`AND r.ride = ${only.ride}::"attraction" AND r.id <> ${only.excludeRoundId}`
      : Prisma.empty;
    return this.prisma.$queryRaw<BestRow[]>`
      SELECT r.ride::text AS ride, s.key, MIN(s.value::float8) AS min, MAX(s.value::float8) AS max
      FROM ride_rounds r
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.stats) = 'object' THEN r.stats END) AS s(key, value)
      WHERE r.user_id = ${userId} AND r.completed AND jsonb_typeof(s.value) = 'number' ${scope}
      GROUP BY r.ride, s.key`;
  }
}

function toBests(rows: BestRow[]): StatBests {
  return Object.fromEntries(rows.map((row) => [row.key, { min: row.min, max: row.max }]));
}
