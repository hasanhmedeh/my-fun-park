import { randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { announceQuietly } from '../live/announce.js';
import type { GoogleSignupDto } from './dto/google-signup.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SignupDto } from './dto/signup.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import type { GoogleSignupPayload, SessionPayload } from './session.js';
import { TERMS_VERSION } from './terms.js';
import { usernameProblem } from './username-policy.js';
import { toVisitorLook } from './visitor-look.js';

/** Who Google says someone is. Only verified emails get this far. */
export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async signup({ email, username, password, gender }: SignupDto): Promise<User> {
    assertUsernameAllowed(username);
    const usernameKey = username.toLowerCase();
    await this.assertAvailable(email, usernameKey);
    const passwordHash = await hashPassword(password);
    // SignupDto only lets acceptTerms === true through, so reaching here means they were accepted.
    return this.create({ email, username, usernameKey, passwordHash, gender, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION });
  }

  async login({ login, password }: LoginDto): Promise<User> {
    // usernames can't hold an @, so one means an email
    const key = login.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: key.includes('@') ? { email: key } : { usernameKey: key } });
    // Unknown emails still pay for a hash check, so timing doesn't reveal which accounts exist.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH));
    // (Signup already tells a taken email apart, so saying this one uses Google gives nothing away.)
    if (user && !user.passwordHash) throw new UnauthorizedException('This account signs in with Google: use “Continue with Google”');
    if (!user || !ok) throw new UnauthorizedException('Wrong email, username or password');
    return user;
  }

  /**
   * The account for a Google identity: the one already linked to it, or else the one with its
   * (verified) email, which gets linked now. Null when there is none yet: they finish signing up.
   */
  async userForGoogle({ googleId, email }: GoogleIdentity): Promise<User | null> {
    const linked = await this.prisma.user.findUnique({ where: { googleId } });
    if (linked) return linked;
    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (!byEmail) return null;
    if (byEmail.googleId) throw new ConflictException('That email belongs to an account linked to a different Google account');
    try {
      return await this.prisma.user.update({ where: { id: byEmail.id }, data: { googleId } });
    } catch (error) {
      // the same Google account was linked a moment ago (two tabs): use that
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const now = await this.prisma.user.findUnique({ where: { googleId } });
        if (now) return now;
      }
      throw error;
    }
  }

  /** Creates the account for a Google identity that had none, with what the finishing form asked. */
  async googleSignup(google: GoogleSignupPayload, { username, gender }: GoogleSignupDto): Promise<User> {
    assertUsernameAllowed(username);
    const usernameKey = username.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { googleId: google.googleId }, select: { id: true } }))
      throw new ConflictException('That Google account already has an account here: continue with Google to log in');
    await this.assertAvailable(google.email, usernameKey);
    // GoogleSignupDto only lets acceptTerms === true through, as SignupDto does.
    return this.create({
      email: google.email,
      username,
      usernameKey,
      passwordHash: null,
      googleId: google.googleId,
      gender,
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    });
  }

  /** Fills in what the account is missing (asked after logging in), or saves (null: forgets) the visitor's look. */
  async updateProfile(user: User, { gender, acceptTerms, visitorLook }: UpdateProfileDto): Promise<User> {
    const data: Prisma.UserUpdateInput = {};
    if (gender) data.gender = gender;
    if (acceptTerms) Object.assign(data, { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION });
    // DbNull empties the column (JsonNull would store a JSON null, which the table refuses)
    if (visitorLook !== undefined) data.visitorLook = visitorLook === null ? Prisma.DbNull : (toVisitorLook(visitorLook) as unknown as Prisma.InputJsonObject);
    if (Object.keys(data).length === 0) return user;
    return this.prisma.user.update({ where: { id: user.id }, data });
  }

  /**
   * A free username to offer someone finishing a Google signup, made from their name (or their
   * email): "Ada Lovelace" -> "Ada_Lovelace", or "Ada_Lovelace42" if that one is taken.
   */
  async suggestUsername(name: string | null, email: string): Promise<string> {
    const allowed = (s: string | null) => (s && !usernameProblem(s) ? s : null);
    const base = allowed(toUsername(name)) ?? allowed(toUsername(email.split('@')[0])) ?? 'visitor';
    for (let i = 0; i < 6; i++) {
      const candidate = i === 0 ? base : `${base.slice(0, 16)}${randomInt(10, 10_000)}`;
      const taken = await this.prisma.user.findUnique({ where: { usernameKey: candidate.toLowerCase() }, select: { id: true } });
      if (!taken) return candidate;
    }
    return base;
  }

  /** Signs a session token for the user. Expiry and algorithm come from the JwtModule config. */
  issueToken(user: User): Promise<string> {
    return this.jwt.signAsync({ sub: user.id } satisfies SessionPayload);
  }

  /** The user a session token belongs to, or null if it is invalid, expired or the user is gone. */
  async userFromToken(token: string): Promise<User | null> {
    let payload: SessionPayload & { typ?: unknown };
    try {
      payload = await this.jwt.verifyAsync<SessionPayload>(token);
    } catch {
      return null;
    }
    // the Google cookies are signed with the same secret, but typed: never a session
    if (typeof payload.sub !== 'string' || payload.typ !== undefined) return null;
    return this.prisma.user.findUnique({ where: { id: payload.sub } });
  }

  private async create(data: Prisma.UserCreateInput & { usernameKey: string }): Promise<User> {
    try {
      const user = await this.prisma.user.create({ data });
      await announceQuietly(this.prisma, { t: 'office', kind: 'members' });
      return user;
    } catch (error) {
      // Someone grabbed the email or username between the check and the insert.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.assertAvailable(data.email, data.usernameKey);
      }
      throw error;
    }
  }

  private async assertAvailable(email: string, usernameKey: string): Promise<void> {
    // At most two rows: one owning the email, one owning the username.
    const taken = await this.prisma.user.findMany({
      where: { OR: [{ email }, { usernameKey }] },
      select: { email: true },
      take: 2,
    });
    if (taken.length === 0) return;
    throw new ConflictException(
      taken.some((u) => u.email === email) ? 'That email is already registered' : 'That username is taken',
    );
  }
}

/** 400 for a username that passes for staff or is offensive (see username-policy.ts). */
function assertUsernameAllowed(username: string) {
  const problem = usernameProblem(username);
  if (problem) throw new BadRequestException(problem);
}

/** Letters, numbers and underscores only, 3 to 20 of them (accents dropped, spaces as _), or null. */
function toUsername(raw: string | null | undefined): string | null {
  const clean = (raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
    .replace(/_+$/, '');
  return clean.length >= 3 ? clean : null;
}
