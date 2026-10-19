import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ParseLimitPipe } from '../common/parse-limit.pipe.js';
import type { User } from '../generated/prisma/client.js';
import type { PurchaseJson } from './purchase-json.js';
import { TicketsService, type AdReward, type AdStart, type PurchaseResult, type TicketStatus } from './tickets.service.js';

/** The Ticket Booth. Tickets belong to an account, so every route needs a session. */
@Controller('tickets')
@UseGuards(SessionGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  status(@CurrentUser() user: User): Promise<TicketStatus> {
    return this.tickets.status(user);
  }

  /** One pack, added to the balance. 409 with nextPurchaseAt during the cooldown, 503 park_closed while the park is closed. */
  @Post('purchase')
  purchase(@CurrentUser() user: User): Promise<PurchaseResult> {
    return this.tickets.purchase(user);
  }

  /**
   * About to play a rewarded ad (the free pack not ready). 409 'ads_off' or 'pack_ready', 429
   * 'ad_limit' (with nextAt) once the day's ads are used up, 503 park_closed.
   */
  @Post('ads')
  startAd(@CurrentUser() user: User): Promise<AdStart> {
    return this.tickets.startAd(user);
  }

  /** The ad was watched to the end: its tickets, once. 404 when expired, 409 'ad_paid' or 'ad_too_soon', 429 'ad_limit'. */
  @Post('ads/:id/reward')
  rewardAd(@CurrentUser() user: User, @Param('id') id: string): Promise<AdReward> {
    return this.tickets.rewardAd(user, id);
  }

  @Get('purchases')
  purchases(
    @CurrentUser() user: User,
    @Query('limit', new ParseLimitPipe(50, 200)) limit: number,
  ): Promise<{ purchases: PurchaseJson[] }> {
    return this.tickets.purchases(user.id, limit);
  }
}
