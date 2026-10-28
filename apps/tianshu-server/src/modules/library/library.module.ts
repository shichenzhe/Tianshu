/**
 * 资料库模块（library 批，spec 2026-10-26 §1.1）：十七端点管理面装配——
 * LibraryDiskRepository 经工厂装配（onWarn 接 LoggerFactory 日志，
 * 替代 mirror Log.warn）；LibraryService 业务面 + LibraryController
 * 路由。AppModule 显式注册。
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { PrismaService } from 'src/commons/database/prisma.service';
import { LoggerFactory } from 'src/commons/log/logger-factory';
import { LibraryDiskRepository } from 'src/core/library/library-disk.repository';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [PrismaModule],
  controllers: [LibraryController],
  providers: [
    {
      provide: LibraryDiskRepository,
      useFactory: (prisma: PrismaService, logFactory: LoggerFactory) =>
        new LibraryDiskRepository(prisma, undefined, (message, error) =>
          logFactory
            .create('LibraryDiskRepository')
            .warn(message, { error: String(error) }),
        ),
      inject: [PrismaService, LoggerFactory],
    },
    LibraryService,
  ],
})
export class LibraryModule {}
