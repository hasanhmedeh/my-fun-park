import { IsIn, IsInt, Max, Min } from 'class-validator';
import { MAX_PART_ORDER, PART_IDS, type Part } from '../design.js';

/** POST /workshop/parts/buy: so many of one part. */
export class BuyPartsDto {
  @IsIn(PART_IDS)
  part!: Part;

  @IsInt()
  @Min(1)
  @Max(MAX_PART_ORDER)
  quantity!: number;
}
