import { Global, Module } from '@nestjs/common';
import { RaPrismaService } from './prisma.service';

/** relay-admin 独立库模块（业务库 commons PrismaModule 同款 @Global 形态；
 * 提供的是 RaPrismaService——ra_* 表族，与业务库 PrismaService 无涉） */
@Global()
@Module({
  providers: [RaPrismaService],
  exports: [RaPrismaService],
})
export class RaPrismaModule {}
