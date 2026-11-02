/**
 * 资料库模块（library 批，spec 2026-10-26 §1.1）：十七端点管理面装配——
 * LibraryDiskRepository 经工厂装配（onWarn 接 LoggerFactory 日志，
 * 替代 mirror Log.warn）；LibraryService 业务面 + LibraryController
 * 路由。AppModule 显式注册。
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { PrismaService } from 'src/commons/database/prisma.service';
import { LoggerFactory } from 'src/commons/log/logger-factory';
import { tianshuDataRoot } from 'src/commons/config/tianshu-data-root';
import { LibraryDiskRepository } from 'src/core/library/library-disk.repository';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [PrismaModule],
  controllers: [LibraryController],
  providers: [
    {
      provide: LibraryDiskRepository,
      useFactory: (
        prisma: PrismaService,
        logFactory: LoggerFactory,
        configService: ConfigService,
      ) =>
        new LibraryDiskRepository(
          prisma,
          // libraryRoot 显式注入 config 数据根派生（chat 同口径；构造缺省
          // 只认 env，config.yml 调 dataRoot 时资料库盘面与 chat 分裂）
          path.join(tianshuDataRoot(configService), 'library'),
          (message, error) =>
            logFactory
              .create('LibraryDiskRepository')
              .warn(message, { error: String(error) }),
        ),
      inject: [PrismaService, LoggerFactory, ConfigService],
    },
    // LibraryService 工厂化（2026-11-02 向量化批）：vectorize deps 显式
    // 装配（prisma 查缺省 embedding 模型 + onWarn 观测日志）——构造可选
    // 参若走 Nest 自动 DI 会按类型 token 解析失败，工厂先例同 repo
    {
      provide: LibraryService,
      useFactory: (
        repo: LibraryDiskRepository,
        prisma: PrismaService,
        logFactory: LoggerFactory,
      ) =>
        new LibraryService(repo, {
          db: prisma,
          onSkip: (reason, detail) =>
            logFactory.create('LibraryVectorize').warn(reason, {
              detail: typeof detail === 'object' ? JSON.stringify(detail) : String(detail),
            }),
        }),
      inject: [LibraryDiskRepository, PrismaService, LoggerFactory],
    },
  ],
})
export class LibraryModule {}
