import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AD_TICKETS_RANGE, ADS_PER_DAY_RANGE, CLOSED_MESSAGE_MAX, COOLDOWN_HOURS_RANGE, PACK_SIZE_RANGE, TICKET_CAP_RANGE } from '../../rides/attractions.js';
import { closedMessage } from './closed-message.js';

/** PATCH /ringmaster/park: any of the park's switches. Left out means unchanged. */
export class UpdateParkDto {
  @IsOptional()
  @IsBoolean()
  open?: boolean;

  /** The sign on the gate while closed. Blank (or null) means the default wording. */
  @Transform(closedMessage)
  @IsOptional()
  @IsString()
  @MaxLength(CLOSED_MESSAGE_MAX)
  closedMessage?: string | null;

  /** True keeps everyone but staff out of the fair altogether (stricter than closing it). */
  @IsOptional()
  @IsBoolean()
  underMaintenance?: boolean;

  /** The sign while under maintenance. Blank (or null) means the default wording. */
  @Transform(closedMessage)
  @IsOptional()
  @IsString()
  @MaxLength(CLOSED_MESSAGE_MAX)
  maintenanceMessage?: string | null;

  @IsOptional()
  @IsInt()
  @Min(PACK_SIZE_RANGE.min)
  @Max(PACK_SIZE_RANGE.max)
  packSize?: number;

  @IsOptional()
  @IsInt()
  @Min(COOLDOWN_HOURS_RANGE.min)
  @Max(COOLDOWN_HOURS_RANGE.max)
  cooldownHours?: number;

  /** The most a free pack tops a balance up to. Null takes the ceiling off. */
  @IsOptional()
  @IsInt()
  @Min(TICKET_CAP_RANGE.min)
  @Max(TICKET_CAP_RANGE.max)
  ticketCap?: number | null;

  /** Tickets one rewarded ad gives. 0 switches the ads off. */
  @IsOptional()
  @IsInt()
  @Min(AD_TICKETS_RANGE.min)
  @Max(AD_TICKETS_RANGE.max)
  adTickets?: number;

  /** How many ads one member is paid for in 24 hours. */
  @IsOptional()
  @IsInt()
  @Min(ADS_PER_DAY_RANGE.min)
  @Max(ADS_PER_DAY_RANGE.max)
  adsPerDay?: number;
}
