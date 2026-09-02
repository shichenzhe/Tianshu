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

  static info(...args: unknown[]): void {
    const message = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    logger.info(message);
  }

  static error(...args: unknown[]): void {
    const message = args
      .map((a) => {
        if (a instanceof Error) {
          // 特殊处理 Error 对象
          return `${a.name}: ${a.message}\n${a.stack || ""}`;
        }
        return typeof a === "object" ? JSON.stringify(a, null, 2) : String(a);
      })
      .join(" ");
    logger.error(message);
  }

  static warn(...args: unknown[]): void {
    const message = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    logger.warn(message);
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
