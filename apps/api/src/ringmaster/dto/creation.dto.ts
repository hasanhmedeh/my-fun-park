import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TICKETS_RANGE } from '../../rides/attractions.js';
import { tidyText } from '../../suggestions/dto/text.js';
import { PLOTS } from '../../workshop/design.js';

/** The longest reply to a declined coaster (a CHECK constraint backs it up). */
export const CREATION_REPLY_MAX = 500;

/** POST /ringmaster/creations/:id/release: onto a free plot, or (`replace`) in place of the version running now. */
export class ReleaseCreationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PLOTS)
  plot?: number;

  /** Tickets a ride (1 when left out). */
  @IsOptional()
  @IsInt()
  @Min(TICKETS_RANGE.min)
  @Max(TICKETS_RANGE.max)
  tickets?: number;

  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

/** POST /ringmaster/creations/:id/decline: why, for the creator. */
export class DeclineCreationDto {
  @Transform(tidyText)
  @IsString()
  @IsNotEmpty({ message: 'Write the reply first' })
  @MaxLength(CREATION_REPLY_MAX, { message: `Keep the reply to ${CREATION_REPLY_MAX} characters` })
  reply!: string;
}
