import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { BackupRegistry } from './backup-registry';

/** 备份模块（spec 2026-10-27）：桌面端全量数据备份存档/下载——
 *  PrismaModule 全局供给（starter 装配，files.module 同款）；
 *  BackupRegistry 供 BackupGuard 客户端身份识别（spec 2026-10-28 多用户） */
@Module({
  controllers: [BackupController],
  providers: [BackupService, BackupRegistry],
})
export class BackupModule {}
