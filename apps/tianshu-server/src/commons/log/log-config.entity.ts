import { LogLevel } from './log-level.enum';

/**
 * 日志配置
 */
export class LogConfig {
  // 日志级别
  level: string;
  // 日志格式
  format: string;
  // 日志文件路径
  dir: string;
  // 日志文件最大大小
  maxFileSize: string;
  // 日志文件最大数量
  maxFiles: number;
  // 日志文件最大保留天数
  maxDays: number;
  // 日志文件日期格式
  datePattern: string;

  static getDefault(): LogConfig {
    return {
      level: LogLevel.INFO,
      format: 'YYYY-MM-DD HH:mm:ss,SSS',
      dir: './logs',
      maxFileSize: '50MB',
      maxFiles: 10,
      maxDays: 7,
      datePattern: 'YYYY-MM-DD',
    };
  }
}
