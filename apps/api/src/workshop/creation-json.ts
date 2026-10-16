import type { CoasterDesign, Creation, CreationStatus } from '../generated/prisma/client.js';
import { noParts, type Design, type Parts, type RideStats } from './design.js';

/** A coaster sent to staff, as its creator sees it in the Coaster Workshop. */
export interface MyCreationJson {
  id: string;
  /** The design it was sent from (null once that's deleted). */
  designId: string | null;
  name: string;
  status: CreationStatus;
  statusChangedAt: string | null;
  /** The plot it stands on (while released), or stood on. */
  plot: number | null;
  /** Staff's answer, when they declined it. */
  reply: string | null;
  reviewedBy: string | null;
  stats: RideStats;
  /** Other guests' rides on it, and the tickets they've earned its creator. */
  rides: number;
  earned: number;
  unread: boolean;
  createdAt: string;
}

/** A saved design in the list: what it is, the parts it holds, and its latest submission. */
export interface DesignSummaryJson {
  id: string;
  name: string;
  pieces: number;
  parts: Parts;
  updatedAt: string;
  /** Its newest submission, if any. */
  latest: { id: string; status: CreationStatus; plot: number | null } | null;
}

export interface DesignJson extends DesignSummaryJson {
  data: Design;
  createdAt: string;
}

/** A released (or, for its creator and staff, any) coaster, enough to build and ride it. */
export interface CreationJson {
  id: string;
  name: string;
  /** The creator's username. */
  creator: string;
  status: CreationStatus;
  plot: number | null;
  data: Design;
  stats: RideStats;
  hasPicture: boolean;
  createdAt: string;
}

export const partsOf = (json: unknown): Parts => ({ ...noParts(), ...((json ?? {}) as Partial<Parts>) });

export function toMyCreationJson(c: Omit<Creation, 'picture'>, earnings?: { rides: number; earned: number }): MyCreationJson {
  return {
    id: c.id,
    designId: c.designId,
    name: c.name,
    status: c.status,
    statusChangedAt: c.statusChangedAt?.toISOString() ?? null,
    plot: c.plot,
    reply: c.reply,
    reviewedBy: c.reviewedByName,
    stats: c.stats as unknown as RideStats,
    rides: earnings?.rides ?? 0,
    earned: earnings?.earned ?? 0,
    unread: c.unread,
    createdAt: c.createdAt.toISOString(),
  };
}

type Latest = Pick<Creation, 'id' | 'status' | 'plot'>;

export function toDesignSummaryJson(d: CoasterDesign, latest?: Latest | null): DesignSummaryJson {
  return {
    id: d.id,
    name: d.name,
    pieces: ((d.data as unknown as Design).pieces ?? []).length,
    parts: partsOf(d.parts),
    updatedAt: d.updatedAt.toISOString(),
    latest: latest ? { id: latest.id, status: latest.status, plot: latest.plot } : null,
  };
}

export function toDesignJson(d: CoasterDesign, latest?: Latest | null): DesignJson {
  return { ...toDesignSummaryJson(d, latest), data: d.data as unknown as Design, createdAt: d.createdAt.toISOString() };
}

export function toCreationJson(c: Omit<Creation, 'picture'> & { user: { username: string } }): CreationJson {
  return {
    id: c.id,
    name: c.name,
    creator: c.user.username,
    status: c.status,
    plot: c.plot,
    data: c.data as unknown as Design,
    stats: c.stats as unknown as RideStats,
    hasPicture: c.pictureType !== null,
    createdAt: c.createdAt.toISOString(),
  };
}
