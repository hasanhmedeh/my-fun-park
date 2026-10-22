import { Body, Controller, Get, HttpException, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { AuthThrottlerGuard } from './auth-throttler.guard.js';
import { AuthService } from './auth.service.js';
import { GoogleSignupDto } from './dto/google-signup.dto.js';
import { GoogleService, GoogleSignInError } from './google.service.js';
import {
  GOOGLE_SIGNUP_COOKIE,
  GOOGLE_SIGNUP_TTL_SECONDS,
  GOOGLE_STATE_COOKIE,
  GOOGLE_STATE_TTL_SECONDS,
  googleCookieOptions,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
} from './session.js';
import { toUserJson, type UserJson } from './user-json.js';

/**
 * How a trip to Google ended, as the game reads it (from the popup's message, or from `?google=`):
 * logged in, a new Google account that still has to pick a username, closed on Google's side, or
 * an error to show.
 */
type Outcome = { google: 'login' | 'signup' | 'cancelled' } | { google: 'error'; message: string };

/** The channel the popup tells the game on (apps/web/src/account/auth-dialog.ts listens). */
const CHANNEL = 'funfair-google';

/** Where the game lives (apps/web/park.html, served as /park): the landing page has / now. */
const GAME_PATH = '/park';

/**
 * "Continue with Google". GET /auth/google sends the visitor to Google (in a popup, or the whole
 * page), and Google sends them back to /auth/google/callback: a known Google account (or one whose
 * email matches an account, which gets linked) is logged in; a new one is held in a short-lived
 * cookie until POST /auth/google/signup gives it a username, a gender and the Terms.
 */
@Controller('auth/google')
export class GoogleController {
  private readonly production: boolean;

  constructor(
    private readonly google: GoogleService,
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /** Whether the button shows. */
  @Get('enabled')
  enabled(): { enabled: boolean } {
    return { enabled: this.google.enabled };
  }

  @Get()
  async start(@Query('popup') popup: string | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    const inPopup = popup === '1';
    if (!this.google.enabled) return this.finish(res, inPopup, { google: 'error', message: 'Signing in with Google isn’t available yet.' });
    const { url, state } = await this.google.start(this.google.redirectUri(req), inPopup);
    res.cookie(GOOGLE_STATE_COOKIE, state, { ...googleCookieOptions(this.production), maxAge: GOOGLE_STATE_TTL_SECONDS * 1000 });
    res.redirect(url);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') stateParam: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const state = await this.google.readState(req.cookies?.[GOOGLE_STATE_COOKIE]);
    res.clearCookie(GOOGLE_STATE_COOKIE, googleCookieOptions(this.production));
    const popup = state?.popup ?? false;
    // they closed Google's page or said no: nothing to report
    if (error === 'access_denied') return this.finish(res, popup, { google: 'cancelled' });
    if (!state || typeof stateParam !== 'string' || stateParam !== state.state || typeof code !== 'string' || !code)
      return this.finish(res, popup, { google: 'error', message: 'That sign-in took too long or came from somewhere else. Please try again.' });

    try {
      const identity = await this.google.identify(code, state);
      const user = await this.auth.userForGoogle(identity);
      res.clearCookie(GOOGLE_SIGNUP_COOKIE, googleCookieOptions(this.production));
      if (user) {
        await this.startSession(res, user);
        return this.finish(res, popup, { google: 'login' });
      }
      const pending = await this.google.signSignup(identity);
      res.cookie(GOOGLE_SIGNUP_COOKIE, pending, { ...googleCookieOptions(this.production), maxAge: GOOGLE_SIGNUP_TTL_SECONDS * 1000 });
      return this.finish(res, popup, { google: 'signup' });
    } catch (err) {
      // ours, or the API's own answers (e.g. the email is linked to another Google account), are shown as they are
      const known = err instanceof GoogleSignInError || err instanceof HttpException;
      if (!known) console.error(err);
      const message = known ? err.message : 'Something went wrong signing in with Google. Please try again.';
      return this.finish(res, popup, { google: 'error', message });
    }
  }

  /** The Google account waiting to finish signing up: its email, and a free username to offer. */
  @Get('pending')
  async pending(@Req() req: Request): Promise<{ email: string; name: string | null; username: string }> {
    const google = await this.pendingSignup(req);
    return { email: google.email, name: google.name, username: await this.auth.suggestUsername(google.name, google.email) };
  }

  @Post('signup')
  @UseGuards(AuthThrottlerGuard)
  async signup(@Body() body: GoogleSignupDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: UserJson }> {
    const google = await this.pendingSignup(req);
    const user = await this.auth.googleSignup(google, body);
    res.clearCookie(GOOGLE_SIGNUP_COOKIE, googleCookieOptions(this.production));
    await this.startSession(res, user);
    return { user: toUserJson(user) };
  }

  private async pendingSignup(req: Request) {
    const google = await this.google.readSignup(req.cookies?.[GOOGLE_SIGNUP_COOKIE]);
    if (!google) throw new UnauthorizedException('Your Google sign-in has expired. Please continue with Google again.');
    return google;
  }

  private async startSession(res: Response, user: User) {
    const token = await this.auth.issueToken(user);
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(this.production), maxAge: SESSION_TTL_SECONDS * 1000 });
  }

  /**
   * Back to the game. From a popup: a tiny page that tells the game (on a BroadcastChannel, which
   * works even when Google's pages have cut the popup off from its opener) and closes, or, if the
   * browser won't close it, carries on to the game itself. Otherwise: straight back to the game.
   */
  private finish(res: Response, popup: boolean, outcome: Outcome): void {
    const query = new URLSearchParams(outcome).toString();
    if (!popup) return res.redirect(`${GAME_PATH}?${query}`);
    // < escaped, so nothing in the message can close the script
    const data = JSON.stringify(outcome).replace(/</g, '\\u003c');
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The Funfair</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:600 18px system-ui,sans-serif;background:#2a1a4f;color:#fff">
<p>Back to the fair…</p>
<script>
const outcome = ${data};
try { const ch = new BroadcastChannel(${JSON.stringify(CHANNEL)}); ch.postMessage(outcome); ch.close(); } catch {}
window.close();
setTimeout(() => location.replace(${JSON.stringify(`${GAME_PATH}?${query}`)}), 500);
</script>
</body></html>`);
  }
}
