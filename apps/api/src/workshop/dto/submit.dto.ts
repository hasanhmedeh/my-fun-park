import { IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /workshop/designs/:id/submit: the picture the game took of the coaster, as a data URL. */
export class SubmitDto {
  @IsOptional()
  @IsString()
  @MaxLength(170_000)
  picture?: string;
}
