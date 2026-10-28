/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FastifyRequest, FastifyReply } from 'fastify';
import { MetricsService } from './metrics.service';
import { Logger } from '../../../log/logger';
import { LoggerFactory } from '../../../log/logger-factory';

/**
 * Metrics拦截器
 * 自动收集HTTP请求的性能指标
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly logger: Logger;

  constructor(
    private readonly metricsService: MetricsService,
    private readonly loggerFactory: LoggerFactory,
  ) {
    this.logger = this.loggerFactory.create(MetricsInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // 如果未启用HTTP指标收集，直接跳过
    if (
      !this.metricsService.isMetricsEnabled() ||
      !this.metricsService.isHttpMetricsEnabled()
    ) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const startTime = Date.now();

    // 获取路由信息
    const method = request.method;
    const route = this.getRoutePattern(request);

    return next.handle().pipe(
      tap({
        next: () => {
          this.recordMetrics(method, route, response.statusCode, startTime);
        },
        error: (error) => {
          // 记录错误状态的指标
          const statusCode = this.getErrorStatusCode(error);
          this.recordMetrics(method, route, statusCode, startTime);
        },
      }),
    );
  }

  /**
   * 记录HTTP请求指标
   */
  private recordMetrics(
    method: string,
    route: string,
    statusCode: number,
    startTime: number,
  ) {
    try {
      const duration = Date.now() - startTime;
      this.metricsService.recordHttpRequest(
        method,
        route,
        statusCode,
        duration,
      );

      this.logger.debug(
        `记录HTTP指标: ${method} ${route} ${statusCode} ${duration}ms`,
      );
    } catch (error) {
      this.logger.error('记录HTTP指标失败', error);
    }
  }

  /**
   * 获取路由模式
   * 尝试获取路由模板而不是具体的路径
   */
  private getRoutePattern(request: FastifyRequest): string {
    // 安全访问 routeOptions
    const rawRequest = request.raw || request;
    if (
      rawRequest &&
      typeof rawRequest === 'object' &&
      'routeOptions' in rawRequest &&
      rawRequest.routeOptions
    ) {
      const routeOptions = rawRequest.routeOptions as { url?: string };
      if (routeOptions.url) {
        return routeOptions.url;
      }
    }

    // 尝试从 routeConfig 获取
    if (
      rawRequest &&
      typeof rawRequest === 'object' &&
      'routeConfig' in rawRequest &&
      rawRequest.routeConfig
    ) {
      const routeConfig = rawRequest.routeConfig as { url?: string };
      if (routeConfig.url) {
        return routeConfig.url;
      }
    }

    // 回退处理逻辑保持不变
    let url = request.url;

    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
      url = url.substring(0, queryIndex);
    }

    url = url.replace(/\/\d+/g, '/:id');
    url = url.replace(
      /\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
      '/:uuid',
    );

    return url || 'unknown';
  }

  /**
   * 从错误对象获取HTTP状态码
   */
  private getErrorStatusCode(error: any): number {
    if (error && typeof error.getStatus === 'function') {
      return error.getStatus() as number;
    }
    if (error && error.status) {
      return error.status as number;
    }
    if (error && error.statusCode) {
      return error.statusCode as number;
    }
    return 500; // 默认内部服务器错误
  }
}
