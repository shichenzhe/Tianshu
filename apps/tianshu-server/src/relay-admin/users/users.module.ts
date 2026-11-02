import { Module } from '@nestjs/common';
import { RaUsersController } from './ra-users.controller';
import { RaUsersService } from './ra-users.service';

/** relay-admin 用户管理模块（Task 10）：RaPrismaService/RaAuditService 均
 * @Global 提供，无需显式 import */
@Module({
  controllers: [RaUsersController],
  providers: [RaUsersService],
})
export class RaUsersModule {}
