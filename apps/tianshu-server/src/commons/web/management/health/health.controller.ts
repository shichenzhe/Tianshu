import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  DiskHealthIndicator,
  HealthCheck,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { ManagementConfig } from '../management-config.entity';
import { HealthConfig } from './health-config.entity';

/**
 * 健康检查控制器
 * 参照 SpringBoot Actuator 健康检查模式实现
 */
@ApiTags('健康检查')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly disk: DiskHealthIndicator,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 综合健康检查 - 类似 SpringBoot /actuator/health
   * @returns 应用健康状态信息
   */
  @Get('/actuator/health')
  @Public()
  @ApiOperation({
    summary: '应用健康检查',
    description: '检查应用整体健康状态，包括磁盘、系统信息等',
  })
  @ApiResponse({ status: 200, description: '健康检查成功' })
  @ApiResponse({ status: 503, description: '健康检查失败' })
  @HealthCheck()
  async healthCheck() {
    try {
      const managementConfig = this.configService.get<ManagementConfig>(
        'management',
        ManagementConfig.getDefault(),
      );

      const healthConfig: HealthConfig =
        managementConfig.health || HealthConfig.getDefault();
      const healthChecks: (() =>
        Promise<HealthIndicatorResult> | HealthIndicatorResult)[] = [];

      // 根据配置动态添加磁盘检查
      if (healthConfig.diskSpace.enabled) {
        healthChecks.push(() =>
          this.disk.checkStorage('diskSpace', {
            path: process.platform === 'win32' ? 'C:\\' : '/',
            thresholdPercent: healthConfig.diskSpace.thresholdPercent,
          }),
        );
      }

      // 根据配置动态添加内存检查
      if (healthConfig.memory.enabled) {
        healthChecks.push(() =>
          this.checkMemoryUsage('memory', healthConfig.memory.thresholdPercent),
        );
      }

      // 始终添加系统信息检查
      healthChecks.push(() => this.checkApplicationInfo());

      const result = await this.health.check(healthChecks);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        status: 'down',
        details: {
          error: message,
        },
      };
    }
  }

  /**
   * 检查内存使用情况
   * @param key 检查项名称
   * @param thresholdPercent 内存使用阈值百分比（0-1之间）
   * @returns 内存健康检查结果
   */
  private checkMemoryUsage(
    key: string,
    thresholdPercent: number,
  ): HealthIndicatorResult {
    const memoryUsage = process.memoryUsage();
    const totalMemory = memoryUsage.heapTotal + memoryUsage.external;
    const usedMemory = memoryUsage.heapUsed;
    const memoryUsagePercent = usedMemory / totalMemory;

    const isHealthy = memoryUsagePercent <= thresholdPercent;

    return {
      [key]: {
        status: isHealthy ? 'up' : 'down',
        details: {
          memoryUsagePercent: Number((memoryUsagePercent * 100).toFixed(2)),
          thresholdPercent: Number((thresholdPercent * 100).toFixed(2)),
          heapUsed: this.formatBytes(memoryUsage.heapUsed),
          heapTotal: this.formatBytes(memoryUsage.heapTotal),
          external: this.formatBytes(memoryUsage.external),
          rss: this.formatBytes(memoryUsage.rss),
        },
      },
    };
  }

  /**
   * 格式化字节数为可读格式
   * @param bytes 字节数
   * @returns 格式化后的字符串
   */
  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * 获取应用信息
   */
  private checkApplicationInfo(): HealthIndicatorResult {
    return {
      components: {
        status: 'up',
        details: {
          name: process.env.npm_package_name,
          version: process.env.npm_package_version,
          description: process.env.npm_package_description,
          environment: process.env.NODE_ENV || 'development',
        },
      },
    };
  }
}
