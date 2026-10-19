import { Injectable } from '@nestjs/common';
import { Prisma, type Attraction } from '../generated/prisma/client.js';
import { ParkService } from '../park/park.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AD_PROVIDER, ATTRACTIONS } from '../rides/attractions.js';
import type { ParkSettingsJson } from './ringmaster.service.js';

/** Days the overview can look back over. */
export const ANALYTICS_DAYS = [7, 30, 90] as const;
export type AnalyticsDays = (typeof ANALYTICS_DAYS)[number];

export interface RideAnalytics {
  /** Rounds ever started (each one paid for). */
  rounds: number;
  roundsInRange: number;
  /** Ran to their end. */
  completed: number;
  /** Left early (or replaced by boarding something else). */
  abandoned: number;
  ticketsSpent: number;
  ticketsSpentInRange: number;
  /** Members who ever played it. */
  players: number;
  /** Average length of a completed round, in seconds; null before the first one. */
  avgSeconds: number | null;
  price: number;
  open: boolean;
}

/** The best (and worst) value ever reported for one stat of one attraction, and who set it. */
export interface StatRecord {
  value: number;
  username: string;
  at: string | null;
}

export interface Overview {
  generatedAt: string;
  /** How far back the "InRange" numbers, `daily`, `hours` and `topPlayers` look. */
  days: AnalyticsDays;
  /** The first day of the range (UTC), YYYY-MM-DD. */
  since: string;
  /** `google`: signed up with Google (no password); `googleLinked`: signed up with email, then continued with Google. */
  users: { total: number; admins: number; google: number; googleLinked: number; newToday: number; newInRange: number; activeToday: number; activeInRange: number };
  tickets: {
    purchases: number;
    purchasesToday: number;
    purchasesInRange: number;
    ticketsSold: number;
    ticketsSoldInRange: number;
    ticketsSpent: number;
    ticketsSpentInRange: number;
    /** Rewarded ads watched to the end (each one a purchase with provider "ad", counted in `purchases` too). */
    adsWatched: number;
    adsWatchedToday: number;
    adsWatchedInRange: number;
    /** Sum of every member's balance: tickets bought (or granted) and not spent yet. */
    inCirculation: number;
  };
  rounds: { total: number; today: number; inRange: number; completed: number; abandoned: number; open: number };
  byRide: Record<Attraction, RideAnalytics>;
  /** One row per day of the range (UTC), oldest first, today included and zero-filled. */
  daily: { date: string; signups: number; purchases: number; ticketsSold: number; rounds: number; players: number; ticketsSpent: number }[];
  /** Rounds started in the range per hour of the day (UTC), 0 to 23. */
  hours: number[];
  /** The ten members with the most rounds in the range. */
  topPlayers: { id: string; username: string; rounds: number; ticketsSpent: number; favourite: Attraction | null }[];
  /** Per attraction and stat key, the highest and lowest value over every completed round. */
  records: Partial<Record<Attraction, Record<string, { max: StatRecord; min: StatRecord }>>>;
  park: ParkSettingsJson;
}

interface RideRow {
  ride: Attraction;
  rounds: number;
  roundsInRange: number;
  completed: number;
  abandoned: number;
  open: number;
  ticketsSpent: number;
  ticketsSpentInRange: number;
  players: number;
  avgSeconds: number | null;
}

interface RecordRow {
  ride: Attraction;
  key: string;
  value: number;
  username: string;
  at: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The office's numbers, across every member. Each count is one aggregate query in Postgres, run
 * side by side. Days are UTC days: the timestamps are stored in UTC, and compared as text literals
 * cast to `timestamp` so the database's own time zone never shifts them.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly park: ParkService,
  ) {}

  async overview(days: AnalyticsDays): Promise<Overview> {
    const now = new Date();
    const today = utcMidnight(now);
    const start = new Date(today.getTime() - (days - 1) * DAY_MS);
    const todayTs = sqlTimestamp(today);
    const since = sqlTimestamp(start);
    const db = this.prisma;

    const [
      users,
      admins,
      googleSignups,
      googleLinked,
      newToday,
      newInRange,
      active,
      purchaseTotals,
      balances,
      rideRows,
      signupDays,
      purchaseDays,
      roundDays,
      hourRows,
      topPlayers,
      maxRows,
      minRows,
      rules,
      attractions,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { role: 'admin' } }),
      db.user.count({ where: { passwordHash: null } }),
      db.user.count({ where: { passwordHash: { not: null }, googleId: { not: null } } }),
      db.user.count({ where: { createdAt: { gte: today } } }),
      db.user.count({ where: { createdAt: { gte: start } } }),
      db.$queryRaw<[{ today: number; inRange: number }]>`
        SELECT (COUNT(DISTINCT user_id) FILTER (WHERE started_at >= ${todayTs}::timestamp))::int AS today,
               (COUNT(DISTINCT user_id))::int AS "inRange"
        FROM ride_rounds WHERE started_at >= ${since}::timestamp`,
      db.$queryRaw<[{ purchases: number; today: number; inRange: number; sold: number; soldInRange: number; ads: number; adsToday: number; adsInRange: number }]>`
        SELECT (COUNT(*))::int AS purchases,
               (COUNT(*) FILTER (WHERE created_at >= ${todayTs}::timestamp))::int AS today,
               (COUNT(*) FILTER (WHERE created_at >= ${since}::timestamp))::int AS "inRange",
               (COALESCE(SUM(quantity), 0))::int AS sold,
               (COALESCE(SUM(quantity) FILTER (WHERE created_at >= ${since}::timestamp), 0))::int AS "soldInRange",
               (COUNT(*) FILTER (WHERE provider = ${AD_PROVIDER}))::int AS ads,
               (COUNT(*) FILTER (WHERE provider = ${AD_PROVIDER} AND created_at >= ${todayTs}::timestamp))::int AS "adsToday",
               (COUNT(*) FILTER (WHERE provider = ${AD_PROVIDER} AND created_at >= ${since}::timestamp))::int AS "adsInRange"
        FROM ticket_purchases`,
      db.user.aggregate({ _sum: { ticketBalance: true } }),
      db.$queryRaw<RideRow[]>`
        SELECT ride::text AS ride,
               (COUNT(*))::int AS rounds,
               (COUNT(*) FILTER (WHERE started_at >= ${since}::timestamp))::int AS "roundsInRange",
               (COUNT(*) FILTER (WHERE completed))::int AS completed,
               (COUNT(*) FILTER (WHERE NOT completed AND ended_at IS NOT NULL))::int AS abandoned,
               (COUNT(*) FILTER (WHERE ended_at IS NULL))::int AS open,
               (COALESCE(SUM(tickets_spent), 0))::int AS "ticketsSpent",
               (COALESCE(SUM(tickets_spent) FILTER (WHERE started_at >= ${since}::timestamp), 0))::int AS "ticketsSpentInRange",
               (COUNT(DISTINCT user_id))::int AS players,
               (AVG(EXTRACT(EPOCH FROM ended_at - started_at)) FILTER (WHERE completed))::float8 AS "avgSeconds"
        FROM ride_rounds GROUP BY ride`,
      db.$queryRaw<{ date: string; n: number }[]>`
        SELECT to_char(created_at, 'YYYY-MM-DD') AS date, (COUNT(*))::int AS n
        FROM users WHERE created_at >= ${since}::timestamp GROUP BY 1`,
      db.$queryRaw<{ date: string; n: number; tickets: number }[]>`
        SELECT to_char(created_at, 'YYYY-MM-DD') AS date, (COUNT(*))::int AS n, (SUM(quantity))::int AS tickets
        FROM ticket_purchases WHERE created_at >= ${since}::timestamp GROUP BY 1`,
      db.$queryRaw<{ date: string; n: number; players: number; tickets: number }[]>`
        SELECT to_char(started_at, 'YYYY-MM-DD') AS date, (COUNT(*))::int AS n,
               (COUNT(DISTINCT user_id))::int AS players, (SUM(tickets_spent))::int AS tickets
        FROM ride_rounds WHERE started_at >= ${since}::timestamp GROUP BY 1`,
      db.$queryRaw<{ hour: number; n: number }[]>`
        SELECT (EXTRACT(HOUR FROM started_at))::int AS hour, (COUNT(*))::int AS n
        FROM ride_rounds WHERE started_at >= ${since}::timestamp GROUP BY 1`,
      db.$queryRaw<Overview['topPlayers']>`
        SELECT u.id, u.username, (COUNT(*))::int AS rounds, (SUM(r.tickets_spent))::int AS "ticketsSpent",
               mode() WITHIN GROUP (ORDER BY r.ride::text) AS favourite
        FROM ride_rounds r JOIN users u ON u.id = r.user_id
        WHERE r.started_at >= ${since}::timestamp
        GROUP BY u.id, u.username
        ORDER BY rounds DESC, "ticketsSpent" DESC, u.username
        LIMIT 10`,
      this.records('max'),
      this.records('min'),
      this.park.rules(),
      this.park.attractions(),
    ]);

    const byRide = Object.fromEntries(
      attractions.map((a): [Attraction, RideAnalytics] => [
        a.attraction,
        {
          rounds: 0,
          roundsInRange: 0,
          completed: 0,
          abandoned: 0,
          ticketsSpent: 0,
          ticketsSpentInRange: 0,
          players: 0,
          avgSeconds: null,
          price: a.tickets,
          open: a.open,
        },
      ]),
    ) as Record<Attraction, RideAnalytics>;
    const rounds = { total: 0, today: 0, inRange: 0, completed: 0, abandoned: 0, open: 0 };
    let ticketsSpent = 0;
    let ticketsSpentInRange = 0;
    for (const { ride, open, ...row } of rideRows) {
      Object.assign(byRide[ride], row);
      rounds.total += row.rounds;
      rounds.inRange += row.roundsInRange;
      rounds.completed += row.completed;
      rounds.abandoned += row.abandoned;
      rounds.open += open;
      ticketsSpent += row.ticketsSpent;
      ticketsSpentInRange += row.ticketsSpentInRange;
    }

    const signups = new Map(signupDays.map((d) => [d.date, d.n]));
    const purchases = new Map(purchaseDays.map((d) => [d.date, d]));
    const played = new Map(roundDays.map((d) => [d.date, d]));
    const daily: Overview['daily'] = [];
    for (let t = start.getTime(); t <= today.getTime(); t += DAY_MS) {
      const date = new Date(t).toISOString().slice(0, 10);
      daily.push({
        date,
        signups: signups.get(date) ?? 0,
        purchases: purchases.get(date)?.n ?? 0,
        ticketsSold: purchases.get(date)?.tickets ?? 0,
        rounds: played.get(date)?.n ?? 0,
        players: played.get(date)?.players ?? 0,
        ticketsSpent: played.get(date)?.tickets ?? 0,
      });
    }
    rounds.today = daily.at(-1)?.rounds ?? 0;

    const hours = Array.from({ length: 24 }, () => 0);
    for (const row of hourRows) hours[row.hour] = row.n;

    const records: Overview['records'] = {};
    for (const [rows, side] of [[maxRows, 'max'], [minRows, 'min']] as const) {
      for (const row of rows) {
        if (!(ATTRACTIONS as string[]).includes(row.ride)) continue;
        const forRide = (records[row.ride] ??= {});
        const entry = (forRide[row.key] ??= {} as { max: StatRecord; min: StatRecord });
        entry[side] = { value: row.value, username: row.username, at: row.at?.toISOString() ?? null };
      }
    }

    const [totals] = purchaseTotals;
    const [activeRow] = active;
    return {
      generatedAt: now.toISOString(),
      days,
      since: start.toISOString().slice(0, 10),
      users: { total: users, admins, google: googleSignups, googleLinked, newToday, newInRange, activeToday: activeRow.today, activeInRange: activeRow.inRange },
      tickets: {
        purchases: totals.purchases,
        purchasesToday: totals.today,
        purchasesInRange: totals.inRange,
        ticketsSold: totals.sold,
        ticketsSoldInRange: totals.soldInRange,
        ticketsSpent,
        ticketsSpentInRange,
        adsWatched: totals.ads,
        adsWatchedToday: totals.adsToday,
        adsWatchedInRange: totals.adsInRange,
        inCirculation: balances._sum.ticketBalance ?? 0,
      },
      rounds,
      byRide,
      daily,
      hours,
      topPlayers,
      records,
      park: {
        open: rules.open,
        closedMessage: rules.closedMessage,
        underMaintenance: rules.underMaintenance,
        maintenanceMessage: rules.maintenanceMessage,
        packSize: rules.packSize,
        cooldownHours: rules.cooldownHours,
        ticketCap: rules.ticketCap,
        adTickets: rules.adTickets,
        adsPerDay: rules.adsPerDay,
        updatedAt: rules.updatedAt?.toISOString() ?? null,
      },
    };
  }

  /**
   * The highest (or lowest) value of every stat key per attraction over all completed rounds, with
   * who set it (the earliest round to reach it). Like RidesService.bestRows, rounds without a stats
   * object are skipped inside the jsonb_each call itself.
   */
  private records(side: 'max' | 'min'): Promise<RecordRow[]> {
    // one of two fixed words, never user input
    const order = Prisma.raw(side === 'max' ? 'DESC' : 'ASC');
    return this.prisma.$queryRaw<RecordRow[]>`
      SELECT DISTINCT ON (r.ride, s.key) r.ride::text AS ride, s.key, (s.value)::float8 AS value, u.username, r.ended_at AS at
      FROM ride_rounds r
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.stats) = 'object' THEN r.stats END) AS s(key, value)
      JOIN users u ON u.id = r.user_id
      WHERE r.completed AND jsonb_typeof(s.value) = 'number'
      ORDER BY r.ride, s.key, (s.value)::float8 ${order}, r.ended_at ASC`;
  }
}

function utcMidnight(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** "2026-10-08 00:00:00.000": a timestamp literal without a zone, read as UTC like the stored values. */
function sqlTimestamp(d: Date) {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
