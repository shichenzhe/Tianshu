import { Injectable } from '@nestjs/common';
import * as winston from 'winston';
// esModuleInterop 开启后 export= 类的命名空间导入不可 construct——默认导入
// 取构造器，TransportOptions 类型经 ConstructorParameters 反推（免 require 形态）
import DailyRotateFile from 'winston-daily-rotate-file';

type DailyRotateFileTransportOptions = ConstructorParameters<
  typeof DailyRotateFile
>[0];
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import * as path from 'path';
import { LogConfig } from './log-config.entity';
import { AppConfig } from '../config/app-config.entity';
import { LogLevel } from './log-level.enum';
import { Logger } from './logger';

/**
 * Winston日志配置类
 */
@Injectable()
export class LoggerFactory {
  private readonly loggerCache = new Map<string, winston.Logger>();

  constructor(
    private readonly configService: ConfigService,
    private readonly clsService: ClsService,
  ) {}

  /**
   * 获取日志配置
   */
  private getLogConfig(): LogConfig {
    return this.configService.get<LogConfig>('log', LogConfig.getDefault());
  }

  private getAppConfig(): AppConfig {
    return this.configService.get<AppConfig>('app', AppConfig.getDefault());
  }

  /**
   * 创建日志格式
   */
  private createLogFormat(
    config: LogConfig,
    loggerName: string,
  ): winston.Logform.Format {
    return winston.format.combine(
      winston.format.timestamp({
        format: config.format,
      }),
      winston.format.printf((info) => {
        const { timestamp, level, message, context, traceId } = info;
        const trace = (traceId as string) || 'N/A';
        const category = (context as string) || loggerName;
        const ts = timestamp as string;
        const msg = message as string;
        const ctx = (context as string) || 'main';

        return `${ts} [${ctx}] [${trace}] ${level.toUpperCase().padEnd(5)} ${category} - ${msg}`;
      }),
    );
  }

  /**
   * 创建传输器
   */
  private createTransports(
    config: LogConfig,
    appConfig: AppConfig,
  ): winston.transport[] {
    const transports: winston.transport[] = [];

    // Info级别日志文件传输器
    const infoTransportOptions: DailyRotateFileTransportOptions = {
      filename: path.join(config.dir, appConfig.name + '-info.log'),
      datePattern: config.datePattern,
      maxSize: config.maxFileSize,
      maxFiles: `${config.maxDays}d`,
      level: LogLevel.INFO,
      zippedArchive: true,
    };
    transports.push(new DailyRotateFile(infoTransportOptions));

    // Error级别日志文件传输器
    const errorTransportOptions: DailyRotateFileTransportOptions = {
      filename: path.join(config.dir, appConfig.name + '-error.log'),
      datePattern: config.datePattern,
      maxSize: config.maxFileSize,
      maxFiles: `${config.maxDays}d`,
      level: LogLevel.ERROR, // 修正为ERROR级别
      zippedArchive: true,
    };
    transports.push(new DailyRotateFile(errorTransportOptions));

    // 开发环境添加控制台输出
    if (process.env.NODE_ENV === 'development') {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
          ),
        }),
      );
    }

    return transports;
  }

  /**
   * 获取或创建指定名称的winston Logger实例
   */
  private createRealLogger(loggerName: string = 'Logger'): winston.Logger {
    if (this.loggerCache.has(loggerName)) {
      return this.loggerCache.get(loggerName)!;
    }

    const logConfig = this.getLogConfig();
    const logger = winston.createLogger({
      level: logConfig.level,
      format: this.createLogFormat(logConfig, loggerName),
      transports: this.createTransports(logConfig, this.getAppConfig()),
      exitOnError: false,
    });

    this.loggerCache.set(loggerName, logger);
    return logger;
  }

  /**
   * 创建Logger实例
   * @param loggerName Logger名称
   */
  create(loggerName: string = 'Logger'): Logger {
    // 动态导入避免循环依赖
    return new Logger(
      this.createRealLogger(loggerName),
      this.clsService,
      loggerName,
    );
  }

  /**
   * 清除Logger缓存
   */
  clearCache(): void {
    this.loggerCache.clear();
  }
}
