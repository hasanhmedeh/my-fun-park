import type { TicketPurchase } from '../generated/prisma/client.js';

/** A purchase as the web client sees it. */
export interface PurchaseJson {
  id: string;
  quantity: number;
  priceCents: number;
  currency: string;
  /** "free" for a pack, "ad" for tickets given for watching an ad. */
  provider: string;
  balanceAfter: number;
  createdAt: string;
}

export function toPurchaseJson(purchase: TicketPurchase): PurchaseJson {
  return {
    id: purchase.id,
    quantity: purchase.quantity,
    priceCents: purchase.priceCents,
    currency: purchase.currency,
    provider: purchase.provider,
    balanceAfter: purchase.balanceAfter,
    createdAt: purchase.createdAt.toISOString(),
  };
}
