import winston from "winston";
import "winston-daily-rotate-file";
import { ipcMain, app } from "electron";
import path from "node:path";
import { Constants } from "../Constants";

const isDevelopment = process.env.NODE_ENV === "development";
// 日志目录：开发环境写到项目根目录，生产环境写到用户数据目录（应用安装目录只读）
const logDir = isDevelopment
  ? path.join(process.cwd(), "logs")
  : path.join(app.getPath("userData"), "logs");

// 定义日志格式，包含时间戳
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), // 时间戳格式
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level}]: ${message}`;
  }),
);

const logTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, "app-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  maxSize: Constants.LOG_MAX_SIZE, // 每个日志文件最大21MB
  zippedArchive: true, // 压缩归档
  maxFiles: Constants.LOG_KEEP_DAYS, // 最多保留7天的日志文件
  format: logFormat, // 使用自定义的日志格式
});

// 创建日志记录器
const logger = winston.createLogger({
  level: "info", // 默认日志级别为 'info'
  transports: [
    logTransport,
    new winston.transports.Console({ format: logFormat }), // 控制台输出
  ],
});

export default class Log {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 单参归一：Error 取 name/message/stack——其 message/stack 为不可枚举
   * 属性，直接 JSON.stringify 只会得到 {}（失败原因丢失）；普通对象输出
   * pretty JSON（循环引用等不可序列化时回退 String）
   */
  private static format(arg: unknown): string {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}\n${arg.stack || ""}`;
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }

  static info(...args: unknown[]): void {
    logger.info(args.map(Log.format).join(" "));
  }

  static error(...args: unknown[]): void {
    logger.error(args.map(Log.format).join(" "));
  }

  static warn(...args: unknown[]): void {
    logger.warn(args.map(Log.format).join(" "));
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    const isDevelopment = process.env.NODE_ENV === "development";
    // 监听渲染进程发送的日志信息
    ipcMain.handle("log:info", (event, message) => {
      if (!isDevelopment) {
        logger.info(message);
      }
    });

    ipcMain.handle("log:warn", (event, message) => {
      if (!isDevelopment) {
        logger.warn(message);
      }
    });

    ipcMain.handle("log:error", (event, message) => {
      if (!isDevelopment) {
        logger.error(message);
      }
    });
  }
}
