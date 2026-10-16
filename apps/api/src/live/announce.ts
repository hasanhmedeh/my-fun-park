import type { Prisma, User } from '../generated/prisma/client.js';

/** The Postgres channel The Ringmaster's Office announces its changes on; every API instance's LiveService listens. */
export const LIVE_CHANNEL = 'funfair';

/** What a member hears about their own account: their wallet and role, or that it's gone. */
export type AccountNews = { balance: number; role: User['role']; lastPurchaseAt: string | null } | { deleted: true };

/**
 * Which of the office's lists something touched: new or deleted accounts, ticket packs, rounds
 * played, the logbook (a change made in the office), who's in the fair right now, the Idea Box
 * (a new suggestion, or one answered), private access (the switch or the list), the Rally
 * Trail's leaderboard (a new time, or one taken off), or coasters sent from the Coaster Workshop
 * (a new one, or one withdrawn). Only the kind: nothing about who.
 */
export type OfficeKind = 'members' | 'purchases' | 'rounds' | 'logbook' | 'visitors' | 'suggestions' | 'access' | 'trail' | 'creations';

/**
 * "The park changed" (everyone gets the new GET /park), "the shop's prices or stock changed"
 * (everyone is told to look at GET /shop again), "the Rally Trail's leaderboard changed" (everyone
 * is told to look at GET /trail/leaderboard again), news for one member (their account, or "staff answered
 * one of your suggestions": they look at GET /suggestions again; "staff released or declined one of
 * your coasters": GET /workshop/creations), "the Coaster Workshop's parts changed" (price or stock:
 * everyone is told to look at GET /workshop/parts again), "private access changed" (every
 * instance reads the list again, and turns away the streams no longer allowed), or "something
 * happened" for the office (staff only, so it can refresh what's on screen).
 */
export type LiveNotice =
  | { t: 'park' }
  | { t: 'access' }
  | { t: 'shop' }
  | { t: 'leaderboard' }
  | ({ t: 'user'; id: string } & AccountNews)
  | { t: 'suggestions'; userId: string }
  | { t: 'creations'; userId: string }
  | { t: 'workshop' }
  | { t: 'office'; kind: OfficeKind };

type Db = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Tells every API instance's live streams about a change. Inside a transaction, Postgres sends it
 * on commit (identical ones once), and never on rollback.
 */
export function announce(db: Db, notice: LiveNotice) {
  return db.$executeRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${JSON.stringify(notice)})`;
}

/** For what players do in the game, once it's saved: best effort, so the news can never fail the action itself. */
export async function announceQuietly(db: Db, notice: LiveNotice): Promise<void> {
  try {
    await announce(db, notice);
  } catch {
    // the office just catches up on its next look
  }
}

export function accountNews(user: Pick<User, 'ticketBalance' | 'role' | 'lastPurchaseAt'>): AccountNews {
  return { balance: user.ticketBalance, role: user.role, lastPurchaseAt: user.lastPurchaseAt?.toISOString() ?? null };
}
