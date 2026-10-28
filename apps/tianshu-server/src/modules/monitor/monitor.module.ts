import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { MonitorController } from './monitor.controller';
import { MonitorService } from './monitor.service';

@Module({
  imports: [PrismaModule],
  controllers: [MonitorController],
  providers: [MonitorService],
})
export class MonitorModule {}
