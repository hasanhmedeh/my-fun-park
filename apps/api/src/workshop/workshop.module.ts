import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CreationsOfficeService } from './creations-office.service.js';
import { CreationsController, WorkshopController } from './workshop.controller.js';
import { WorkshopService } from './workshop.service.js';

/** The Coaster Workshop (members), the coasters it makes (everyone), and the office's side of it (exported). */
@Module({
  imports: [AuthModule],
  controllers: [WorkshopController, CreationsController],
  providers: [WorkshopService, CreationsOfficeService],
  exports: [CreationsOfficeService],
})
export class WorkshopModule {}
