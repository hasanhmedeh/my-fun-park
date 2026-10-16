import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ClientIp } from '../access/access.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ParseLimitPipe } from '../common/parse-limit.pipe.js';
import { ParseOffsetPipe } from '../common/parse-offset.pipe.js';
import { CreationStatus, SuggestionStatus, type Attraction, type User } from '../generated/prisma/client.js';
import { ParseRidePipe } from '../rides/parse-ride.pipe.js';
import { boardDay, isDay } from '../trail/board-day.js';
import { TrailService, type TrailOfficeJson } from '../trail/trail.service.js';
import { CreationsOfficeService, type AdminCreationJson, type AdminPartJson, type PlotJson } from '../workshop/creations-office.service.js';
import { ANALYTICS_DAYS, AnalyticsService, type AnalyticsDays, type Overview } from './analytics.service.js';
import { DeclineCreationDto, ReleaseCreationDto } from './dto/creation.dto.js';
import { AddAllowedIpDto, UpdateAccessDto } from './dto/update-access.dto.js';
import { UpdateAttractionDto } from './dto/update-attraction.dto.js';
import { UpdateParkDto } from './dto/update-park.dto.js';
import { UpdateShopItemDto } from './dto/update-shop-item.dto.js';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto.js';
import { UpdateTrailRunDto } from './dto/update-trail-run.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import {
  RingmasterService,
  type AccessJson,
  type AdminActionJson,
  type AdminPurchaseJson,
  type AdminRoundJson,
  type AdminShopItemJson,
  type AdminShopOrderJson,
  type AdminSuggestionJson,
  type AdminUserDetail,
  type AdminUserJson,
  type AllowedIpJson,
  type AttractionJson,
  type ParkSettingsJson,
  type VisitorsJson,
} from './ringmaster.service.js';
import { StaffGuard } from './staff.guard.js';

/**
 * The Ringmaster's Office: the park's back office, for staff only (a guest gets a 401, a player a
 * 403). Appoint staff with `pnpm staff:appoint <email>`. Every change lands in the logbook.
 */
@Controller('ringmaster')
@UseGuards(SessionGuard, StaffGuard)
export class RingmasterController {
  constructor(
    private readonly office: RingmasterService,
    private readonly analytics: AnalyticsService,
    private readonly trail: TrailService,
    private readonly creations: CreationsOfficeService,
  ) {}

  /** The numbers: members, tickets, rounds, per attraction and per day. `?days=` 7, 30 (default) or 90. */
  @Get('overview')
  overview(@Query('days') days?: string): Promise<Overview> {
    return this.analytics.overview(parseDays(days));
  }

  /** Who's in the fair right now: members, guests, and visitors still at the entrance. */
  @Get('visitors')
  visitors(): Promise<VisitorsJson> {
    return this.office.visitors();
  }

  @Get('park')
  park(): Promise<ParkSettingsJson> {
    return this.office.parkSettings();
  }

  /** Opens or closes the whole park, changes its sign or the pack rules. */
  @Patch('park')
  updatePark(@CurrentUser() actor: User, @Body() body: UpdateParkDto): Promise<ParkSettingsJson> {
    return this.office.updatePark(actor, body);
  }

  /** Private access: whether only the allowed addresses can reach the site, the list, and the caller's own address. */
  @Get('access')
  access(@ClientIp() ip: string | null): Promise<AccessJson> {
    return this.office.access(ip);
  }

  /** Switches private access on (adding the caller's address) or off. */
  @Patch('access')
  updateAccess(@CurrentUser() actor: User, @ClientIp() ip: string | null, @Body() body: UpdateAccessDto): Promise<AccessJson> {
    return this.office.updateAccess(actor, ip, body);
  }

  @Post('access/ips')
  allowIp(@CurrentUser() actor: User, @Body() body: AddAllowedIpDto): Promise<AllowedIpJson> {
    return this.office.allowIp(actor, body);
  }

  /** 409 when it's the last entry letting the caller in while private access is on. */
  @Delete('access/ips/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAllowedIp(@CurrentUser() actor: User, @ClientIp() ip: string | null, @Param('id') id: string): Promise<void> {
    return this.office.removeAllowedIp(actor, ip, id);
  }

  @Get('attractions')
  attractions(): Promise<{ attractions: AttractionJson[] }> {
    return this.office.attractions();
  }

  /** Sets an attraction's price, or closes it for maintenance (and opens it again). */
  @Patch('attractions/:ride')
  updateAttraction(
    @CurrentUser() actor: User,
    @Param('ride', ParseRidePipe) ride: Attraction,
    @Body() body: UpdateAttractionDto,
  ): Promise<AttractionJson> {
    return this.office.updateAttraction(actor, ride, body);
  }

  @Get('shop')
  shopItems(): Promise<{ items: AdminShopItemJson[] }> {
    return this.office.shopItems();
  }

  /** Sets a shop item's price, or how many are left to sell (null for no limit). */
  @Patch('shop/:item')
  updateShopItem(@CurrentUser() actor: User, @Param('item') item: string, @Body() body: UpdateShopItemDto): Promise<AdminShopItemJson> {
    return this.office.updateShopItem(actor, item, body);
  }

  @Get('users')
  users(
    @Query('q') q: string | undefined,
    @Query('limit', new ParseLimitPipe(25, 100)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ users: AdminUserJson[]; total: number }> {
    return this.office.users({ q: typeof q === 'string' ? q : undefined, limit, offset });
  }

  @Get('users/:id')
  user(@Param('id') id: string): Promise<AdminUserDetail> {
    return this.office.user(id);
  }

  @Patch('users/:id')
  updateUser(@CurrentUser() actor: User, @Param('id') id: string, @Body() body: UpdateUserDto): Promise<AdminUserJson> {
    return this.office.updateUser(actor, id, body);
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(@CurrentUser() actor: User, @Param('id') id: string): Promise<void> {
    return this.office.deleteUser(actor, id);
  }

  @Get('purchases')
  purchases(
    @Query('limit', new ParseLimitPipe(25, 100)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ purchases: AdminPurchaseJson[]; total: number }> {
    return this.office.purchases({ limit, offset });
  }

  @Get('shop-orders')
  shopOrders(
    @Query('limit', new ParseLimitPipe(25, 100)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ orders: AdminShopOrderJson[]; total: number }> {
    return this.office.shopOrders({ limit, offset });
  }

  @Get('rounds')
  rounds(
    @Query('ride') ride: string | undefined,
    @Query('limit', new ParseLimitPipe(25, 100)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ rounds: AdminRoundJson[]; total: number }> {
    const only = ride ? new ParseRidePipe().transform(ride) : undefined;
    return this.office.rounds({ ride: only, limit, offset });
  }

  /** The Idea Box, newest first. `?status=` shows one status only; `counts` has every status either way. */
  @Get('suggestions')
  suggestions(
    @Query('status') status: string | undefined,
    @Query('limit', new ParseLimitPipe(25, 100)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ suggestions: AdminSuggestionJson[]; total: number; counts: Record<SuggestionStatus, number> }> {
    return this.office.suggestions({ status: parseStatus(status), limit, offset });
  }

  /** Answers a suggestion (once: 409 if it has an answer already), or changes its status. */
  @Patch('suggestions/:id')
  updateSuggestion(@CurrentUser() actor: User, @Param('id') id: string, @Body() body: UpdateSuggestionDto): Promise<AdminSuggestionJson> {
    return this.office.updateSuggestion(actor, id, body);
  }

  /** One of the Rally Trail's daily boards (`?day=YYYY-MM-DD`, today's without one), with the trail's numbers and the last 30 boards. */
  @Get('trail')
  trailBoard(@Query('day') day?: string): Promise<TrailOfficeJson> {
    return this.trail.office(parseBoardDay(day));
  }

  /** Takes a run off its board (it's kept), or puts it back. */
  @Patch('trail/runs/:id')
  updateTrailRun(@CurrentUser() actor: User, @Param('id') id: string, @Body() body: UpdateTrailRunDto): Promise<{ id: string; disqualified: boolean }> {
    return this.office.updateTrailRun(actor, id, body.disqualified);
  }

  /** Coasters sent from the Coaster Workshop, newest first (`?status=` for one status), with the counts and Creators' Valley's plots. */
  @Get('creations')
  creationList(
    @Query('status') status: string | undefined,
    @Query('limit', new ParseLimitPipe(24, 96)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ creations: AdminCreationJson[]; total: number; counts: Record<CreationStatus, number>; plots: PlotJson[] }> {
    return this.creations.list({ status: parseCreationStatus(status), limit, offset });
  }

  @Get('creations/:id')
  creation(@Param('id') id: string): Promise<AdminCreationJson> {
    return this.creations.one(id);
  }

  /** Puts a coaster in the park: onto a free plot, or in place of the version of it running now (`replace`). */
  @Post('creations/:id/release')
  @HttpCode(HttpStatus.OK)
  releaseCreation(@CurrentUser() actor: User, @Param('id') id: string, @Body() body: ReleaseCreationDto): Promise<AdminCreationJson> {
    return this.creations.release(actor, id, body);
  }

  /** Says no to a waiting coaster, with a reply for its creator. */
  @Post('creations/:id/decline')
  @HttpCode(HttpStatus.OK)
  declineCreation(@CurrentUser() actor: User, @Param('id') id: string, @Body() body: DeclineCreationDto): Promise<AdminCreationJson> {
    return this.creations.decline(actor, id, body.reply);
  }

  /** Takes a coaster out of the park. */
  @Post('creations/:id/remove')
  @HttpCode(HttpStatus.OK)
  removeCreation(@CurrentUser() actor: User, @Param('id') id: string): Promise<AdminCreationJson> {
    return this.creations.remove(actor, id);
  }

  /** The Coaster Workshop's parts: price, stock and what's sold. */
  @Get('workshop/parts')
  workshopParts(): Promise<{ parts: AdminPartJson[] }> {
    return this.creations.parts();
  }

  /** Sets a part's price, or how many are left to sell (null for no limit). */
  @Patch('workshop/parts/:part')
  updateWorkshopPart(@CurrentUser() actor: User, @Param('part') part: string, @Body() body: UpdateShopItemDto): Promise<AdminPartJson> {
    return this.creations.updatePart(actor, part, body);
  }

  @Get('actions')
  actions(
    @Query('limit', new ParseLimitPipe(25, 100)) limit: number,
    @Query('offset', ParseOffsetPipe) offset: number,
  ): Promise<{ actions: AdminActionJson[]; total: number }> {
    return this.office.actions({ limit, offset });
  }
}

function parseDays(value: string | undefined): AnalyticsDays {
  if (value === undefined || value === '') return 30;
  const days = Number(value);
  if (!(ANALYTICS_DAYS as readonly number[]).includes(days)) throw new BadRequestException(`days must be one of ${ANALYTICS_DAYS.join(', ')}`);
  return days as AnalyticsDays;
}

/** `?status=`: one of the statuses, or nothing for all of them. */
function parseStatus(value: string | undefined): SuggestionStatus | undefined {
  if (value === undefined || value === '') return undefined;
  const statuses = Object.values(SuggestionStatus) as string[];
  if (!statuses.includes(value)) throw new BadRequestException(`status must be one of ${statuses.join(', ')}`);
  return value as SuggestionStatus;
}

/** `?status=` for the coasters' grid: one of the statuses, or nothing for all of them. */
function parseCreationStatus(value: string | undefined): CreationStatus | undefined {
  if (value === undefined || value === '') return undefined;
  const statuses = Object.values(CreationStatus) as string[];
  if (!statuses.includes(value)) throw new BadRequestException(`status must be one of ${statuses.join(', ')}`);
  return value as CreationStatus;
}

/** `?day=`: a board's day, YYYY-MM-DD, no later than today's board; nothing for today's. */
function parseBoardDay(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isDay(value)) throw new BadRequestException('day must be a date, YYYY-MM-DD');
  if (value > boardDay()) throw new BadRequestException("That board hasn't started yet");
  return value;
}
