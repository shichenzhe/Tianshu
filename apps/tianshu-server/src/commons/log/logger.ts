import * as winston from 'winston';
import { ClsService } from 'nestjs-cls';
import { BusinessException } from '../exception/bussiness-exception';

/**
 * 日志服务类
 * 提供统一的日志记录接口
 */
export class Logger {
  private readonly loggerName: string;

  constructor(
    private readonly logger: winston.Logger,
    private readonly clsService: ClsService,
    loggerName: string = 'Logger',
  ) {
    this.loggerName = loggerName;
  }

  /**
   * 获取当前Logger名称
   */
  getLoggerName(): string {
    return this.loggerName;
  }

  /**
   * 记录信息级别日志
   * 支持变量替换，如: info('User {username} logged in at {time}', { username: 'John', time: new Date().toISOString() })
   */
  info(message: string, meta?: Record<string, any>): void {
    this.logger.info(message, {
      ...meta,
      traceId: this.clsService.getId(),
    });
  }

  /**
   * 记录错误级别日志
   * 支持变量替换，如: error('Database error: {errorMessage}', { errorMessage: 'Connection failed' }, error)
   */
  error(message: string, error?: Error | BusinessException): void {
    this.logger.error(message, {
      traceId: this.clsService.getId(),
      error: error
        ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          }
        : undefined,
    });
  }

  /**
   * 记录警告级别日志
   * 支持变量替换，如: warn('Memory usage is high: {memoryUsage}%', { memoryUsage: 85 })
   */
  warn(message: string, meta?: Record<string, any>): void {
    this.logger.warn(message, {
      ...meta,
      traceId: this.clsService.getId(),
    });
  }

  /**
   * 记录调试级别日志
   * 支持变量替换，如: debug('Processing {count} items', { count: 10 })
   */
  debug(message: string, meta?: Record<string, any>): void {
    this.logger.debug(message, {
      ...meta,
      traceId: this.clsService.getId(),
    });
  }
}
