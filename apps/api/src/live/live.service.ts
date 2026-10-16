import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import pg from 'pg';
import { AccessService, IP_BLOCKED_MESSAGE } from '../access/access.service.js';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { isStaff, ParkService } from '../park/park.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accountNews, announceQuietly, LIVE_CHANNEL, type LiveNotice, type OfficeKind } from './announce.js';

/**
 * A stream is closed after this long, and the browser opens a new one (EventSource does that on
 * its own). Serverless functions can't run forever: keep it under the function's maxDuration.
 */
const STREAM_MS = 240_000;
/** A comment line this often keeps proxies from dropping a quiet stream. */
const HEARTBEAT_MS = 20_000;
/** The LISTEN connection is kept this long after the last visitor leaves, for reconnects. */
const IDLE_MS = 30_000;
/** Changes landing this close together are sent as one. */
const DEBOUNCE_MS = 100;
/** The office hears what players do at most this often per kind: a busy fair isn't a firehose. */
const OFFICE_MS = 1_000;
/** A game tab that left is announced this long after, so a reconnect (2 s) doesn't flicker the office's count. */
const LEFT_MS = 3_000;
/** Presence rows nobody has seen for this long are cleared out (a tab whose instance vanished). */
const PRESENCE_TTL = '10 minutes';

/** A game tab's presence: its own random id, and whether it's past the entrance. */
export interface Presence {
  visitor: string;
  inFair: boolean;
}

interface Stream {
  res: Response;
  userId: string | null;
  /** Where it's connected from, so private access can turn it away when that changes. */
  ip: string | null;
  /** Staff also hear what happens in the game and the office, for The Ringmaster's Office. */
  staff: boolean;
  /** A game tab, counted in the office's "in the fair" (the office's own stream isn't). */
  presence: (Presence & { token: string }) | null;
}

/**
 * Live updates, as Server-Sent Events: the park (open or closed, maintenance, prices, the pack
 * rules) and word that the shop's prices or stock (or the Rally Trail's leaderboard) changed for everyone, their own account (and word of
 * staff answering their suggestions) for members, and for staff, what's going on (signups,
 * packs, rounds, the logbook, who's in the fair) so The Ringmaster's Office keeps up. Changes are
 * announced with Postgres NOTIFY (see announce.ts), so one made through any API instance reaches
 * every stream. One LISTEN connection per instance, held only while someone is connected. Game
 * tabs also keep a presence row (live_visitors) fresh, which is how the office counts them.
 */
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveService.name);
  private readonly streams = new Set<Stream>();
  private listener: Promise<pg.Client> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private shopTimer: ReturnType<typeof setTimeout> | null = null;
  private boardTimer: ReturnType<typeof setTimeout> | null = null;
  private workshopTimer: ReturnType<typeof setTimeout> | null = null;
  private officeKinds = new Set<OfficeKind>();
  private officeTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly park: ParkService,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /**
   * Opens a stream: the park as it is now (and the member's account), then every change. A game
   * tab passes its `presence`, and counts as a visitor while it's connected. `ip` is where it
   * connects from (it got past private access: AccessGuard runs first).
   */
  async open(res: Response, user: User | null, ip: string | null, presence: Presence | null = null): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const stream: Stream = { res, userId: user?.id ?? null, ip, staff: !!user && isStaff(user), presence: presence && { ...presence, token: randomUUID() } };
    this.streams.add(stream);
    if (stream.presence) void this.arrived(stream.userId, stream.presence);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const lifetime = setTimeout(() => res.end(), STREAM_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      this.streams.delete(stream);
      if (stream.presence) void this.left(stream.presence);
      if (!this.streams.size) this.idleTimer ??= setTimeout(() => void this.stopListening(), IDLE_MS);
    });

    let listening = true;
    try {
      await this.listen();
    } catch (err) {
      listening = false;
      this.logger.warn(`Live updates are off, can't LISTEN: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.writableEnded) return;
    // reconnect soon; without LISTEN, only every half minute (the game also polls in the meantime)
    res.write(`retry: ${listening ? 2_000 : 30_000}\n\n`);
    // the snapshot comes after LISTEN, so nothing that changes in between is missed
    send(res, 'park', await this.park.publicPark());
    if (user) send(res, 'account', accountNews(user));
    if (!listening) res.end();
  }

  // ---------- Presence ----------

  /** A game tab connected (or reconnected): it's here, as of now. */
  private async arrived(userId: string | null, p: Presence & { token: string }) {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO live_visitors (id, user_id, in_fair, stream, gone, seen_at)
        VALUES (${p.visitor}, ${userId}, ${p.inFair}, ${p.token}, false, now())
        ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, in_fair = EXCLUDED.in_fair, stream = EXCLUDED.stream, gone = false, seen_at = now()`;
      this.presenceTimer ??= setInterval(() => void this.stillHere(), HEARTBEAT_MS);
      await announceQuietly(this.prisma, { t: 'office', kind: 'visitors' });
    } catch (err) {
      this.logger.warn(`Couldn't note a visitor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A game tab's stream closed. Unless it has reconnected since (a newer stream owns the row), it's gone. */
  private async left(p: Presence & { token: string }) {
    try {
      await this.prisma.$executeRaw`UPDATE live_visitors SET gone = true WHERE id = ${p.visitor} AND stream = ${p.token}`;
      setTimeout(() => void announceQuietly(this.prisma, { t: 'office', kind: 'visitors' }), LEFT_MS);
    } catch {
      // the row stops counting a minute after it was last seen anyway
    }
  }

  /** Every heartbeat: this instance's game tabs are still here, and long-gone rows are cleared out. */
  private async stillHere() {
    const tokens = [...this.streams].flatMap((s) => (s.presence ? [s.presence.token] : []));
    if (!tokens.length) {
      if (this.presenceTimer) clearInterval(this.presenceTimer);
      this.presenceTimer = null;
      return;
    }
    try {
      await this.prisma.$executeRaw`UPDATE live_visitors SET seen_at = now() WHERE stream = ANY(${tokens}) AND NOT gone`;
      await this.prisma.$executeRaw`DELETE FROM live_visitors WHERE seen_at < now() - ${PRESENCE_TTL}::interval`;
    } catch {
      // next beat
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const { res } of this.streams) res.end();
    await this.stopListening();
  }

  private listen(): Promise<pg.Client> {
    this.listener ??= (async () => {
      const client = new pg.Client({ connectionString: this.config.get('DATABASE_URL_UNPOOLED', { infer: true }), connectionTimeoutMillis: 5_000 });
      // a dropped connection ends every stream; the browsers reconnect, and that listens again
      const drop = (err?: Error) => {
        if (err) this.logger.warn(`Live updates connection lost: ${err.message}`);
        if (this.listener === pending) this.listener = null;
        for (const { res } of this.streams) res.end();
        client.removeAllListeners();
        void client.end().catch(() => undefined);
      };
      client.on('error', drop);
      client.on('end', () => drop());
      client.on('notification', (msg) => this.onNotice(msg.payload));
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      return client;
    })();
    const pending = this.listener;
    pending.catch(() => {
      if (this.listener === pending) this.listener = null;
    });
    return pending;
  }

  private async stopListening() {
    this.idleTimer = null;
    if (this.streams.size || !this.listener) return;
    const pending = this.listener;
    this.listener = null;
    try {
      const client = await pending;
      client.removeAllListeners();
      await client.end();
    } catch {
      // already gone
    }
  }

  private onNotice(payload: string | undefined) {
    let notice: LiveNotice;
    try {
      notice = JSON.parse(payload ?? '') as LiveNotice;
    } catch {
      return;
    }
    if (notice.t === 'park') {
      // a save in the office touches a couple of rows: read the park once for all of them
      this.parkTimer ??= setTimeout(() => {
        this.parkTimer = null;
        void this.broadcastPark();
      }, DEBOUNCE_MS);
    } else if (notice.t === 'access') {
      this.access.forget();
      void this.turnAway();
    } else if (notice.t === 'shop') {
      // just the word: tabs with the shop open fetch GET /shop, the rest when they next open it
      this.shopTimer ??= setTimeout(() => {
        this.shopTimer = null;
        for (const { res } of this.streams) send(res, 'shop', {});
      }, DEBOUNCE_MS);
    } else if (notice.t === 'leaderboard') {
      // just the word: the trail's boards and HUD fetch GET /trail/leaderboard (a burst of times is one look)
      this.boardTimer ??= setTimeout(() => {
        this.boardTimer = null;
        for (const { res } of this.streams) send(res, 'leaderboard', {});
      }, DEBOUNCE_MS);
    } else if (notice.t === 'workshop') {
      // just the word: tabs with the Coaster Workshop open fetch GET /workshop/parts
      this.workshopTimer ??= setTimeout(() => {
        this.workshopTimer = null;
        for (const { res } of this.streams) send(res, 'workshop', {});
      }, DEBOUNCE_MS);
    } else if (notice.t === 'office') {
      this.officeKinds.add(notice.kind);
      this.officeTimer ??= setTimeout(() => {
        this.officeTimer = null;
        const kinds = [...this.officeKinds];
        this.officeKinds.clear();
        for (const s of this.streams) if (s.staff) send(s.res, 'office', { kinds });
      }, OFFICE_MS);
    } else if (notice.t === 'suggestions') {
      // just the word: the member's tabs fetch GET /suggestions (staff answered, or another tab read it)
      for (const s of this.streams) if (s.userId === notice.userId) send(s.res, 'suggestions', {});
    } else if (notice.t === 'creations') {
      // just the word: the member's tabs fetch GET /workshop/creations (staff released or declined one)
      for (const s of this.streams) if (s.userId === notice.userId) send(s.res, 'creations', {});
    } else if (notice.t === 'user') {
      const { t: _t, id, ...news } = notice;
      for (const s of this.streams) {
        if (s.userId !== id) continue;
        // made staff or a player again (or deleted): the office's news follows the role at once
        s.staff = 'role' in news && news.role === 'admin';
        send(s.res, 'account', news);
      }
    }
  }

  /**
   * Private access was switched on, or an address taken off the list: the streams from anywhere no
   * longer allowed are told (the page shows the private sign) and closed. Their reconnects get a 403.
   */
  private async turnAway() {
    if (!this.streams.size) return;
    try {
      const rules = await this.access.rules();
      if (!rules.on) return;
      for (const s of this.streams) {
        if (rules.allows(s.ip)) continue;
        send(s.res, 'blocked', { message: IP_BLOCKED_MESSAGE, ip: s.ip });
        s.res.end();
      }
    } catch (err) {
      this.logger.warn(`Couldn't read private access for live updates: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async broadcastPark() {
    if (!this.streams.size) return;
    try {
      const park = await this.park.publicPark();
      for (const { res } of this.streams) send(res, 'park', park);
    } catch (err) {
      this.logger.warn(`Couldn't read the park for live updates: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function send(res: Response, event: string, data: unknown) {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
