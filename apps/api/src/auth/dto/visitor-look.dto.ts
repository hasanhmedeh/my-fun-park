import { Equals, IsNumber, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { VISITOR_LOOK_LIMITS, type VisitorLook } from '../visitor-look.js';

const COLOUR_MESSAGE = (part: string) => `${part} must be a colour like #1a2b3c (lowercase), or null for its own`;
const [HEIGHT_MIN, HEIGHT_MAX] = VISITOR_LOOK_LIMITS.height;
const [BUILD_MIN, BUILD_MAX] = VISITOR_LOOK_LIMITS.build;

/**
 * The visitor's look, inside PATCH /auth/me (see visitor-look.ts). Every field is required (a
 * colour may be null, never missing), and the app's ValidationPipe refuses any other key.
 */
export class VisitorLookDto implements VisitorLook {
  @Equals(1, { message: 'v must be 1' })
  v: 1;

  @IsString()
  @MaxLength(48)
  @Matches(VISITOR_LOOK_LIMITS.avatarId, { message: 'avatar must be an avatar id (letters, digits and underscores)' })
  avatar: string;

  @ValidateIf((o: VisitorLookDto) => o.top !== null)
  @Matches(VISITOR_LOOK_LIMITS.colour, { message: COLOUR_MESSAGE('top') })
  top: string | null;

  @ValidateIf((o: VisitorLookDto) => o.bottom !== null)
  @Matches(VISITOR_LOOK_LIMITS.colour, { message: COLOUR_MESSAGE('bottom') })
  bottom: string | null;

  @ValidateIf((o: VisitorLookDto) => o.shoes !== null)
  @Matches(VISITOR_LOOK_LIMITS.colour, { message: COLOUR_MESSAGE('shoes') })
  shoes: string | null;

  @ValidateIf((o: VisitorLookDto) => o.hair !== null)
  @Matches(VISITOR_LOOK_LIMITS.colour, { message: COLOUR_MESSAGE('hair') })
  hair: string | null;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(HEIGHT_MIN)
  @Max(HEIGHT_MAX)
  height: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(BUILD_MIN)
  @Max(BUILD_MAX)
  build: number;
}
