import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TrailModule } from '../trail/trail.module.js';
import { WorkshopModule } from '../workshop/workshop.module.js';
import { AnalyticsService } from './analytics.service.js';
import { RingmasterController } from './ringmaster.controller.js';
import { RingmasterService } from './ringmaster.service.js';
import { StaffGuard } from './staff.guard.js';

@Module({
  imports: [AuthModule, TrailModule, WorkshopModule],
  controllers: [RingmasterController],
  providers: [RingmasterService, AnalyticsService, StaffGuard],
})
export class RingmasterModule {}
