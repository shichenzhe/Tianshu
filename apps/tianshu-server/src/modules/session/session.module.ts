import { Module } from '@nestjs/common';
import { PrismaModule } from '../../commons/database/prisma.module';
import { ChatCoreModule } from '../../core/chat-core.module';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { SessionRepository } from './session.repository';

// ChatCoreModule 供 send/abort 消费 ChatRunnerService；EventBusModule 为
// 全局模块（EventBusService 直接注入，无需显式 import）
@Module({
  imports: [PrismaModule, ChatCoreModule],
  controllers: [SessionController],
  providers: [SessionService, SessionRepository],
})
export class SessionModule {}
