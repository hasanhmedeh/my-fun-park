import { Type } from 'class-transformer';
import { Equals, IsEnum, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { Gender } from '../../generated/prisma/client.js';
import { GENDER_MESSAGE, TERMS_MESSAGE } from './signup.dto.js';
import { VisitorLookDto } from './visitor-look.dto.js';

/**
 * PATCH /auth/me: fills in what an older (or Google-linked) account is missing, and saves the
 * visitor's look from the game's customiser. Left out means unchanged.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsEnum(Gender, { message: GENDER_MESSAGE })
  gender?: Gender;

  /** Accepting the current Terms and Privacy Policy, for an account that never did. */
  @IsOptional()
  @Equals(true, { message: TERMS_MESSAGE })
  acceptTerms?: true;

  /** The whole look (see visitor-look.ts); null forgets it, and the game picks one again. */
  // IsObject first: ValidateNested alone would take an array of looks.
  @IsOptional()
  @IsObject({ message: 'visitorLook must be an object, or null' })
  @ValidateNested()
  @Type(() => VisitorLookDto)
  visitorLook?: VisitorLookDto | null;
}
