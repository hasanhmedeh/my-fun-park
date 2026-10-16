import type { Prisma, User } from '../generated/prisma/client.js';
import { announce } from '../live/announce.js';

/** Writes one line in the logbook, and tells every open office (other staff see it at once). */
export async function log(tx: Prisma.TransactionClient, actor: User, action: string, target: string | null, details: object) {
  await tx.adminAction.create({
    data: { actorId: actor.id, actorName: actor.username, action, target, details: details as Prisma.InputJsonObject },
  });
  await announce(tx, { t: 'office', kind: 'logbook' });
}

/** `obj` without its undefined keys (the fields a PATCH left out). */
export function defined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** The fields of `data` that differ from `current`, before and after; null when nothing changes. */
export function changes(current: object, data: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const was = (current as Record<string, unknown>)[key];
    if (was === value) continue;
    before[key] = was;
    after[key] = value;
  }
  return Object.keys(after).length ? { before, after } : null;
}
