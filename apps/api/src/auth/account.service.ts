import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { announceQuietly } from '../live/announce.js';
import type { DeleteAccountDto } from './dto/delete-account.dto.js';
import { verifyPassword } from './password.js';

/** The user's right to delete their account (a copy of their data is given on request, by email). */
@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deletes the account after checking the password (or, for an account made with Google, that the
   * username was typed). Purchases and rounds go with it (ON DELETE CASCADE).
   */
  async delete(user: User, { password, confirm }: DeleteAccountDto): Promise<void> {
    if (user.passwordHash) {
      if (!password || !(await verifyPassword(password, user.passwordHash))) throw new UnauthorizedException('Wrong password');
    } else if (confirm?.trim().toLowerCase() !== user.usernameKey) {
      throw new BadRequestException('Type your username to confirm');
    }
    // their coasters go too: if one was running in Creators' Valley, everyone sees its plot empty
    const released = await this.prisma.creation.count({ where: { userId: user.id, status: 'released' } });
    // deleteMany: a concurrent delete of the same account is not an error, the outcome is the same.
    await this.prisma.user.deleteMany({ where: { id: user.id } });
    await announceQuietly(this.prisma, { t: 'office', kind: 'members' });
    if (released) await announceQuietly(this.prisma, { t: 'park' });
  }
}
