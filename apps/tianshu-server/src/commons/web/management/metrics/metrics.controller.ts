import { Controller, Get, Res, HttpStatus, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { MetricsService } from './metrics.service';
import { Public } from '../../../auth/decorator/public.decorator';
import { Logger } from '../../../log/logger';
import { LoggerFactory } from '../../../log/logger-factory';
import { ActuatorGuard } from './actuator.guard';

/**
 * Metrics控制器
 * 提供性能指标暴露接口，参照SpringBoot Actuator模式实现
 * 支持/actuator/metrics和/actuator/prometheus端点
 */
@ApiTags('性能指标')
@Controller()
@UseGuards(ActuatorGuard)
@ApiBearerAuth()
@ApiSecurity('basic')
export class MetricsController {
  private readonly logger: Logger;

  constructor(
    private readonly metricsService: MetricsService,
    private readonly loggerFactory: LoggerFactory,
  ) {
    this.logger = this.loggerFactory.create(MetricsController.name);
  }

  /**
   * 获取Prometheus格式的性能指标
   * @param res Fastify响应对象
   * @returns Prometheus格式的指标数据
   */
  @Get('/actuator/prometheus')
  @Public()
  @ApiOperation({
    summary: '获取Prometheus格式指标',
    description:
      '返回Prometheus格式的应用性能指标数据，包括HTTP请求、系统资源、自定义指标等',
  })
  @ApiResponse({
    status: 200,
    description: '成功返回指标数据',
    content: {
      'text/plain': {
        schema: {
          type: 'string',
          example:
            '# HELP http_server_requests_total Total number of HTTP requests\n# TYPE http_server_requests_total counter\nhttp_server_requests_total{method="GET",uri="/api/users",status="200"} 42\n',
        },
      },
    },
  })
  @ApiResponse({ status: 500, description: '获取指标数据失败' })
  @ApiResponse({ status: 503, description: 'Metrics功能未启用' })
  async getPrometheusMetrics(@Res() res: FastifyReply): Promise<void> {
    try {
      if (!this.metricsService.isMetricsEnabled()) {
        this.logger.warn('Metrics功能未启用');
        res.status(HttpStatus.SERVICE_UNAVAILABLE).send({
          error: 'Metrics功能未启用',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const startTime = Date.now();
      const metrics = await this.metricsService.getMetrics();
      const duration = Date.now() - startTime;

      this.logger.debug(`获取Prometheus指标数据耗时: ${duration}ms`);

      // 设置正确的Content-Type
      res.header('Content-Type', 'text/plain; charset=utf-8');
      res.status(HttpStatus.OK).send(metrics);
    } catch (error) {
      this.logger.error('获取Prometheus指标数据失败', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: '获取指标数据失败',
        message: error instanceof Error ? error.message : '未知错误',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 获取JSON格式的性能指标（兼容旧版本）
   * @param res Fastify响应对象
   * @returns JSON格式的指标数据
   */
  @Get('/actuator/metrics')
  @Public()
  @ApiOperation({
    summary: '获取JSON格式指标',
    description: '返回JSON格式的应用性能指标数据，兼容旧版本API',
  })
  @ApiResponse({ status: 200, description: '成功返回指标数据' })
  @ApiResponse({ status: 500, description: '获取指标数据失败' })
  @ApiResponse({ status: 503, description: 'Metrics功能未启用' })
  async getMetrics(@Res() res: FastifyReply): Promise<void> {
    try {
      if (!this.metricsService.isMetricsEnabled()) {
        this.logger.warn('Metrics功能未启用');
        res.status(HttpStatus.SERVICE_UNAVAILABLE).send({
          error: 'Metrics功能未启用',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const startTime = Date.now();
      const metrics = await this.metricsService.getMetrics();
      const duration = Date.now() - startTime;

      this.logger.debug(`获取JSON指标数据耗时: ${duration}ms`);

      // 返回JSON格式
      res.header('Content-Type', 'application/json');
      res.status(HttpStatus.OK).send({
        status: 'success',
        data: {
          metrics: metrics,
          timestamp: new Date().toISOString(),
          duration: `${duration}ms`,
        },
      });
    } catch (error) {
      this.logger.error('获取JSON指标数据失败', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: '获取指标数据失败',
        message: error instanceof Error ? error.message : '未知错误',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 重置所有指标数据
   * @returns 重置结果
   */
  @Get('/actuator/metrics/reset')
  @Public()
  @ApiOperation({
    summary: '重置指标数据',
    description: '重置所有收集的指标数据，通常用于测试或调试',
  })
  @ApiResponse({ status: 200, description: '成功重置指标数据' })
  @ApiResponse({ status: 503, description: 'Metrics功能未启用' })
  resetMetrics() {
    try {
      if (!this.metricsService.isMetricsEnabled()) {
        return {
          status: 'error',
          message: 'Metrics功能未启用',
          timestamp: new Date().toISOString(),
        };
      }

      this.metricsService.resetMetrics();
      this.logger.info('指标数据已重置');

      return {
        status: 'success',
        message: '指标数据已重置',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('重置指标数据失败', error);
      throw error;
    }
  }
}
