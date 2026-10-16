import path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from './access/access.module.js';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { LiveModule } from './live/live.module.js';
import { ParkModule } from './park/park.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RidesModule } from './rides/rides.module.js';
import { RingmasterModule } from './ringmaster/ringmaster.module.js';
import { ShopModule } from './shop/shop.module.js';
import { SuggestionsModule } from './suggestions/suggestions.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { TrailModule } from './trail/trail.module.js';
import { WorkshopModule } from './workshop/workshop.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // apps/api/.env, wherever the process was started from. Real env vars win over the file.
      envFilePath: path.join(import.meta.dirname, '..', '.env'),
      validate: validateEnv,
    }),
    PrismaModule,
    AccessModule,
    ParkModule,
    AuthModule,
    TicketsModule,
    RidesModule,
    TrailModule,
    ShopModule,
    SuggestionsModule,
    WorkshopModule,
    RingmasterModule,
    LiveModule,
    HealthModule,
  ],
})
export class AppModule {}
