import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  SetMetadata,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Reflector } from '@nestjs/core';
import { OperationLogService } from './operation-log.service';
import { OperateContext } from 'src/commons/entity/operate-context.entity';
import { OperationLog } from './operation-log.entity';

const DISABLE_LOG: boolean = true;
/**
 * 操作日志拦截器
 * 自动记录用户操作日志
 */
@Injectable()
export class OperationLogInterceptor implements NestInterceptor {
  constructor(
    private readonly operationLogService: OperationLogService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    //先写死不记录操作日志
    if (DISABLE_LOG) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const startTime = Date.now();

    const skipLog = this.reflector.getAllAndOverride<boolean>(
      SKIP_OPERATION_LOG,
      [context.getHandler(), context.getClass()],
    );
    if (skipLog) {
      return next.handle();
    }

    // 获取操作信息
    const operation = this.getOperationType(request);
    const userId = this.getUserId(request);

    // 如果没有用户ID或操作类型，跳过日志记录
    if (!userId || !operation) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        // 成功响应时记录日志
        const executionTime = Date.now() - startTime;
        this.recordLog({
          userId,
          operation,
          request,
          response,
          executionTime,
          status: 'SUCCESS',
        });
      }),
      catchError((error) => {
        // 错误响应时记录日志
        const executionTime = Date.now() - startTime;
        this.recordLog({
          userId,
          operation,
          request,
          response,
          executionTime,
          status: 'ERROR',
        });
        throw error;
      }),
    );
  }

  /**
   * 获取操作类型
   */
  private getOperationType(request: FastifyRequest): string | null {
    const { url } = request;
    const path = url ? url.split('?')[0] : ''; // 移除查询参数

    return path;
  }

  /**
   * 获取用户ID
   */
  private getUserId(request: FastifyRequest): string | null {
    // 从JWT token中获取用户ID
    const user = (request as any).operateContext as OperateContext;
    return user?.operator.code || null;
  }

  /**
   * 获取客户端IP地址
   */
  private getClientIp(request: FastifyRequest): string {
    return (
      request.headers['x-forwarded-for']?.toString()?.split(',')[0] ||
      request.headers['x-real-ip']?.toString() ||
      request.ip ||
      ''
    ).replace('::ffff:', '');
  }

  /**
   * 获取用户代理
   */
  private getUserAgent(request: FastifyRequest): string {
    return request.headers['user-agent']?.toString() || '';
  }

  /**
   * 记录操作日志
   */
  private async recordLog(params: {
    userId: string;
    operation: string;
    request: FastifyRequest;
    response: FastifyReply;
    executionTime: number;
    status: string;
  }) {
    try {
      const { userId, operation, request, executionTime, status } = params;

      const logDto: OperationLog = {
        userId,
        operation,
        details: {},
        // details: {
        //   method: request.method,
        //   url: request.url,
        //   params: request.params,
        //   query: request.query,
        // },
        ipAddress: this.getClientIp(request),
        userAgent: this.getUserAgent(request),
        executionTime,
        createdAt: new Date(),
        status,
      };

      await this.operationLogService.create(logDto);
    } catch (error) {
      // 日志记录失败不应影响正常业务流程
      console.error('Failed to record operation log:', error);
    }
  }
}

/**
 * 跳过操作日志记录装饰器
 */

export const SKIP_OPERATION_LOG = 'skipOperationLog';
export const SkipOperationLog = () => SetMetadata(SKIP_OPERATION_LOG, true);
