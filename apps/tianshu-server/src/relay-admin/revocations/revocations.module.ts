import { Module } from '@nestjs/common';
import { RevocationsController } from './revocations.controller';

/** relay-admin CRL 名单模块（Task 12）：RaPrismaService @Global、
 * ConfigService 全局 ConfigModule——均免显式 import */
@Module({
  controllers: [RevocationsController],
})
export class RevocationsModule {}
