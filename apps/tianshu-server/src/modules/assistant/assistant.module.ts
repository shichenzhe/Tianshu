import { Module } from '@nestjs/common';
import { PrismaModule } from '../../commons/database/prisma.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

@Module({
  imports: [PrismaModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
