import { Attraction } from '../generated/prisma/client.js';

/**
 * The ticket rules' defaults. The live values are rows (attraction_settings, park_settings), read
 * through ParkService and edited in The Ringmaster's Office; these only fill in for a missing row.
 * The web client reads the live ones from GET /api/park and GET /api/tickets.
 */

/** Every attraction id, in the order of the Attraction enum in prisma/schema.prisma. */
export const ATTRACTIONS = Object.values(Attraction);

/** Tickets one round costs when an attraction has no settings row. Typed against the enum, so a new attraction can't be left without one. */
export const DEFAULT_TICKET_COSTS: Readonly<Record<Attraction, number>> = {
  coaster: 1,
  falcon: 5,
  rocket: 1,
  ferris: 5,
  flip: 1,
  ship: 1,
  speedway: 1,
  trail: 1,
  drone: 1,
  crates: 1,
  striker: 1,
  ducks: 1,
  // Creators' Valley: staff set each plot's price when they release a coaster onto it
  plot1: 1,
  plot2: 1,
  plot3: 1,
  plot4: 1,
  plot5: 1,
  plot6: 1,
  plot7: 1,
  plot8: 1,
  // Funfair Air: one round is one whole flight, boarding at the gate to the stand at the other end
  flight: 10,
  // Palm Cay's beach park
  jetski: 1,
  slides: 1,
  cannons: 1,
  volley: 1,
};

/** Tickets in one pack, and hours between two purchases, when park_settings has no row. */
export const DEFAULT_PACK_SIZE = 20;
export const DEFAULT_COOLDOWN_HOURS = 5;

/** The limits the migrations' CHECK constraints enforce, so a bad value is a 400 rather than a 500. */
export const PACK_SIZE_RANGE = { min: 1, max: 1000 } as const;
export const COOLDOWN_HOURS_RANGE = { min: 0, max: 168 } as const;
export const TICKET_CAP_RANGE = { min: 1, max: 100000 } as const;
export const TICKETS_RANGE = { min: 1, max: 1000 } as const;
/** The longest closed sign, for the park and for an attraction. */
export const CLOSED_MESSAGE_MAX = 200;

/** What purchases are recorded as while tickets are free. */
export const PACK_PRICE_CENTS = 0;
export const PACK_CURRENCY = 'EUR';
export const PACK_PROVIDER = 'free';
