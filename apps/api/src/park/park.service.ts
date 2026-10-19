import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Attraction, AttractionSettings, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ATTRACTIONS, DEFAULT_AD_TICKETS, DEFAULT_ADS_PER_DAY, DEFAULT_COOLDOWN_HOURS, DEFAULT_PACK_SIZE, DEFAULT_TICKET_COSTS } from '../rides/attractions.js';

/** The park's switches (the park_settings row, or its defaults when the row is missing). */
export interface ParkRules {
  open: boolean;
  closedMessage: string | null;
  /** Nobody but staff in the fair at all (stricter than closed). */
  underMaintenance: boolean;
  maintenanceMessage: string | null;
  packSize: number;
  cooldownHours: number;
  /** The most a free pack tops a balance up to; null for no ceiling. */
  ticketCap: number | null;
  /** Tickets one rewarded ad gives (0: ads are off). */
  adTickets: number;
  /** How many ads one member is paid for in 24 hours. */
  adsPerDay: number;
  updatedAt: Date | null;
}

/** One attraction's settings row, or its defaults when the row is missing. */
export interface AttractionRules {
  attraction: Attraction;
  tickets: number;
  open: boolean;
  closedMessage: string | null;
  updatedAt: Date | null;
}

/** GET /park: what every visitor (guests too) needs to know before boarding anything. */
export interface PublicPark {
  open: boolean;
  /** Only while the park is closed: the sign on the gate (null for the default wording). */
  message: string | null;
  /** The whole park under maintenance: nobody but staff may come into the fair at all. */
  underMaintenance: boolean;
  /** Only while it is: its sign (null for the default wording). */
  maintenanceMessage: string | null;
  costs: Record<Attraction, number>;
  packSize: number;
  cooldownHours: number;
  /** The most a free pack tops a balance up to; null for no ceiling. */
  ticketCap: number | null;
  /** Tickets one rewarded ad gives (0: ads are off), and how many a member is paid for in 24 hours. */
  adTickets: number;
  adsPerDay: number;
  /** The attractions closed for maintenance, each with its sign (null for the default wording). Open ones are left out. */
  maintenance: Partial<Record<Attraction, string | null>>;
  /** The player-built coasters running in Creators' Valley, by plot (GET /creations/:id has each one's design). */
  creations: { plot: number; id: string; name: string; creator: string }[];
}

export const PARK_CLOSED_MESSAGE = 'The park is closed right now. Come back soon!';
export const PARK_MAINTENANCE_MESSAGE = 'The fair is under maintenance. Come back soon!';
export const RIDE_CLOSED_MESSAGE = 'Under maintenance. Back soon!';

/** Staff can board and buy while the park, or an attraction, is closed: that's how they test it. */
export const isStaff = (user: Pick<User, 'role'>) => user.role === 'admin';

/**
 * The live rules: prices, the pack, and what is open. Read from the database on every request
 * (two tiny rows), so a change in The Ringmaster's Office applies at once on every instance.
 */
@Injectable()
export class ParkService {
  constructor(private readonly prisma: PrismaService) {}

  async rules(): Promise<ParkRules> {
    const row = await this.prisma.parkSettings.findUnique({ where: { id: 1 } });
    return {
      open: row?.open ?? true,
      closedMessage: row?.closedMessage ?? null,
      underMaintenance: row?.underMaintenance ?? false,
      maintenanceMessage: row?.maintenanceMessage ?? null,
      packSize: row?.packSize ?? DEFAULT_PACK_SIZE,
      cooldownHours: row?.cooldownHours ?? DEFAULT_COOLDOWN_HOURS,
      ticketCap: row?.ticketCap ?? null,
      adTickets: row?.adTickets ?? DEFAULT_AD_TICKETS,
      adsPerDay: row?.adsPerDay ?? DEFAULT_ADS_PER_DAY,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Every attraction, in enum order, with a missing row filled in from the defaults. */
  async attractions(): Promise<AttractionRules[]> {
    const rows = await this.prisma.attractionSettings.findMany();
    const byId = new Map(rows.map((row) => [row.attraction, row]));
    return ATTRACTIONS.map((attraction) => toAttractionRules(attraction, byId.get(attraction)));
  }

  async attraction(attraction: Attraction): Promise<AttractionRules> {
    return toAttractionRules(attraction, await this.prisma.attractionSettings.findUnique({ where: { attraction } }));
  }

  /** Tickets per round for every attraction. */
  async costs(): Promise<Record<Attraction, number>> {
    return costsOf(await this.attractions());
  }

  async publicPark(): Promise<PublicPark> {
    const [rules, attractions, released] = await Promise.all([
      this.rules(),
      this.attractions(),
      this.prisma.creation.findMany({ where: { status: 'released' }, select: { id: true, plot: true, name: true, user: { select: { username: true } } }, orderBy: { plot: 'asc' } }),
    ]);
    const maintenance: PublicPark['maintenance'] = {};
    for (const a of attractions) if (!a.open) maintenance[a.attraction] = a.closedMessage;
    return {
      open: rules.open,
      message: rules.open ? null : rules.closedMessage,
      underMaintenance: rules.underMaintenance,
      maintenanceMessage: rules.underMaintenance ? rules.maintenanceMessage : null,
      costs: costsOf(attractions),
      packSize: rules.packSize,
      cooldownHours: rules.cooldownHours,
      ticketCap: rules.ticketCap,
      adTickets: rules.adTickets,
      adsPerDay: rules.adsPerDay,
      maintenance,
      creations: released.map((c) => ({ plot: c.plot!, id: c.id, name: c.name, creator: c.user.username })),
    };
  }

  /** 503 park_maintenance or park_closed unless the park is open (and not under maintenance) or `user` is staff. */
  assertParkOpen(rules: ParkRules, user: Pick<User, 'role'>): void {
    if (isStaff(user)) return;
    if (rules.underMaintenance) throw closed('park_maintenance', rules.maintenanceMessage ?? PARK_MAINTENANCE_MESSAGE);
    if (rules.open) return;
    throw closed('park_closed', rules.closedMessage ?? PARK_CLOSED_MESSAGE);
  }

  /** 503 ride_closed unless the attraction is running or `user` is staff. */
  assertAttractionOpen(rules: AttractionRules, user: Pick<User, 'role'>): void {
    if (rules.open || isStaff(user)) return;
    throw closed('ride_closed', rules.closedMessage ?? RIDE_CLOSED_MESSAGE, { ride: rules.attraction });
  }
}

export function toAttractionRules(attraction: Attraction, row: AttractionSettings | null | undefined): AttractionRules {
  return {
    attraction,
    tickets: row?.tickets ?? DEFAULT_TICKET_COSTS[attraction],
    open: row?.open ?? true,
    closedMessage: row?.closedMessage ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

function costsOf(attractions: AttractionRules[]): Record<Attraction, number> {
  return Object.fromEntries(attractions.map((a) => [a.attraction, a.tickets])) as Record<Attraction, number>;
}

/** 503 with a `code` the web client recognises, so it shows the sign rather than "server down". */
function closed(code: 'park_closed' | 'park_maintenance' | 'ride_closed', message: string, extra: Record<string, unknown> = {}) {
  return new HttpException(
    { ...HttpException.createBody(message, 'Service Unavailable', HttpStatus.SERVICE_UNAVAILABLE), code, ...extra },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
