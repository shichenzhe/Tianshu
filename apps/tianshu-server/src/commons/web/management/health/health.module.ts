import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import configuration from '../../../config/configuration';

/**
 * 健康检查模块
 * 使用 NestJS Terminus 提供专业的健康检查功能
 * 支持基于配置的动态健康检查
 */
@Module({
  imports: [
    TerminusModule,
    HttpModule, // 用于 HTTP 健康检查
    ConfigModule.forRoot({
      isGlobal: false,
      load: [configuration], // 加载配置文件
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
