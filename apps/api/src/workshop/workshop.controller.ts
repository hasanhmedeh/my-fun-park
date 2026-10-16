import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { SESSION_COOKIE } from '../auth/session.js';
import type { User } from '../generated/prisma/client.js';
import type { CreationJson, DesignJson, MyCreationJson } from './creation-json.js';
import { BuyPartsDto } from './dto/buy-parts.dto.js';
import { DesignDto } from './dto/design.dto.js';
import { SubmitDto } from './dto/submit.dto.js';
import { WorkshopService, type BuyPartsResult, type PartJson, type WorkshopJson } from './workshop.service.js';

/**
 * The Coaster Workshop: coaster parts for tickets, saved designs, and coasters sent to staff.
 * Members only, but for the parts list.
 */
@Controller('workshop')
export class WorkshopController {
  constructor(private readonly workshop: WorkshopService) {}

  /** Parts, inventory, design slots, the day's submissions and the member's designs. */
  @Get()
  @UseGuards(SessionGuard)
  state(@CurrentUser() user: User): Promise<WorkshopJson> {
    return this.workshop.workshop(user);
  }

  /** Every part at today's price, with how many are left (null: no limit). */
  @Get('parts')
  async parts(): Promise<{ parts: PartJson[] }> {
    return { parts: await this.workshop.catalog() };
  }

  /** The member's free starter kit, once (409 after that). */
  @Post('starter-kit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  starterKit(@CurrentUser() user: User): Promise<WorkshopJson> {
    return this.workshop.claimStarterKit(user);
  }

  /** 402 { needed, balance } when short, 409 code 'sold_out' (and `left`), 503 while the park is closed. */
  @Post('parts/buy')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  buy(@CurrentUser() user: User, @Body() body: BuyPartsDto): Promise<BuyPartsResult> {
    return this.workshop.buyParts(user, body.part, body.quantity);
  }

  @Get('designs/:id')
  @UseGuards(SessionGuard)
  design(@CurrentUser() user: User, @Param('id') id: string): Promise<DesignJson> {
    return this.workshop.design(user.id, id);
  }

  /** 409 code 'no_slot' (every slot taken) or 'parts' (with `missing`). */
  @Post('designs')
  @UseGuards(SessionGuard)
  create(@CurrentUser() user: User, @Body() body: DesignDto): Promise<DesignJson> {
    return this.workshop.createDesign(user, body.design);
  }

  /** 409 code 'parts' (with `missing`). */
  @Put('designs/:id')
  @UseGuards(SessionGuard)
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() body: DesignDto): Promise<DesignJson> {
    return this.workshop.updateDesign(user, id, body.design);
  }

  @Delete('designs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  remove(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    return this.workshop.deleteDesign(user.id, id);
  }

  /** Sends the saved design to staff. 422 code 'not_buildable' (with `issues`), 409 'pending', 429 'submission_limit'. */
  @Post('designs/:id/submit')
  @UseGuards(SessionGuard)
  submit(@CurrentUser() user: User, @Param('id') id: string, @Body() body: SubmitDto): Promise<MyCreationJson> {
    return this.workshop.submit(user, id, body.picture);
  }

  /** The member's coasters sent to staff, newest first. */
  @Get('creations')
  @UseGuards(SessionGuard)
  creations(@CurrentUser() user: User): Promise<{ creations: MyCreationJson[]; unread: number }> {
    return this.workshop.mine(user.id);
  }

  @Post('creations/seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  seen(@CurrentUser() user: User): Promise<void> {
    return this.workshop.markSeen(user.id);
  }

  /** Withdraws a submission staff haven't answered yet (409 once they have). */
  @Delete('creations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  withdraw(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    return this.workshop.withdraw(user.id, id);
  }
}

/**
 * Player-built coasters, to build and ride in the game: released ones for everyone, any of them for
 * their creator and for staff (who test-ride them before release).
 */
@Controller('creations')
export class CreationsController {
  constructor(
    private readonly workshop: WorkshopService,
    private readonly auth: AuthService,
  ) {}

  @Get(':id')
  @Header('cache-control', 'no-store')
  async creation(@Req() req: Request, @Param('id') id: string): Promise<CreationJson> {
    return this.workshop.creation(await this.viewer(req), id);
  }

  @Get(':id/picture')
  async picture(@Req() req: Request, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const { bytes, type, released } = await this.workshop.picture(await this.viewer(req), id);
    res.setHeader('content-type', type);
    // a submission's picture never changes; an unreleased one is only for its creator and staff
    res.setHeader('cache-control', released ? 'public, max-age=86400' : 'private, max-age=3600');
    res.end(Buffer.from(bytes));
  }

  /** Whoever is signed in, if anyone (an expired session just looks as a guest). */
  private async viewer(req: Request) {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    return typeof token === 'string' && token ? this.auth.userFromToken(token) : null;
  }
}
