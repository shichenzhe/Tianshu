import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

// 批③：WorkspaceService 注入 EventBusService 发 workspace.changed——
// EventBusModule 虽 @Global（生产 app.module 挂载一次即处处可用），单模块
// 测试 app 不经 app.module，显式 import 保证依赖自声明、双态可解析
@Module({
  imports: [PrismaModule, EventBusModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
