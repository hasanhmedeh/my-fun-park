import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { AccountService } from './account.service.js';
import { AuthThrottlerGuard } from './auth-throttler.guard.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { DeleteAccountDto } from './dto/delete-account.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookieOptions } from './session.js';
import { SessionGuard } from './session.guard.js';
import { toUserJson, type UserJson } from './user-json.js';

@Controller('auth')
export class AuthController {
  private readonly production: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
    config: ConfigService<Env, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  @Post('signup')
  @UseGuards(AuthThrottlerGuard)
  async signup(@Body() body: SignupDto, @Res({ passthrough: true }) res: Response): Promise<{ user: UserJson }> {
    const user = await this.auth.signup(body);
    await this.startSession(res, user);
    return { user: toUserJson(user) };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottlerGuard)
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): Promise<{ user: UserJson }> {
    const user = await this.auth.login(body);
    await this.startSession(res, user);
    return { user: toUserJson(user) };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.production));
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: User): { user: UserJson } {
    return { user: toUserJson(user) };
  }

  /** Fills in what the account is missing (gender, the Terms), asked after logging in; or saves the visitor's look. */
  @Patch('me')
  @UseGuards(SessionGuard)
  async updateProfile(@CurrentUser() user: User, @Body() body: UpdateProfileDto): Promise<{ user: UserJson }> {
    return { user: toUserJson(await this.auth.updateProfile(user, body)) };
  }

  /**
   * Deletes the account and everything attached to it, then signs out. Needs the password again
   * (or, for an account made with Google, the username typed out).
   */
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthThrottlerGuard, SessionGuard)
  async deleteAccount(
    @CurrentUser() user: User,
    @Body() body: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.account.delete(user, body);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.production));
  }

  private async startSession(res: Response, user: User): Promise<void> {
    const token = await this.auth.issueToken(user);
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(this.production), maxAge: SESSION_TTL_SECONDS * 1000 });
  }
}
