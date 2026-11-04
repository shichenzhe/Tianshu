/**
 * 天枢用户数据目录解析（供 prisma-client / 各 repo / 安全门等共用）。
 * 数据统一收敛 ~/.tianshu：跨平台经 os.homedir()（macOS/Linux 为 ~、
 * Windows 为 C:\Users\<user>），path.join 自动处理分隔符，无需平台分支。
 * app/ 为生产数据、dev/ 为开发数据——开发期 snapshot-guard 可能 drop
 * 重建库等破坏性操作只应波及开发数据，与生产数据物理隔离。
 * 依赖 electron app（主进程专用；单测经 vi.mock 注入，file-history 先例）。
 */
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { readConfiguredDataRoot } from "./data-root-config";

/** 默认数据根 ~/.tianshu（未配置/未覆盖时的基准） */
export function defaultTianshuRoot(): string {
  return path.join(os.homedir(), ".tianshu");
}

/**
 * 数据根：所有用户数据统一收敛于此，便于查找与备份。
 * 优先级 TIANSHU_DATA_ROOT 环境变量（测试隔离/开发者显式覆盖）>
 * userData/data-root.json 用户配置（设置面板「数据目录」，重启生效）>
 * 默认 ~/.tianshu。跨平台经 os.homedir()（macOS/Linux 为 ~、Windows 为
 * C:\Users\<user>），path.join 自动处理分隔符。
 */
export function tianshuRoot(): string {
  return (
    process.env.TIANSHU_DATA_ROOT ??
    readConfiguredDataRoot() ??
    defaultTianshuRoot()
  );
}

/** 应用数据分组根：生产 ~/.tianshu/app、开发 ~/.tianshu/dev */
export function appDataHome(): string {
  return path.join(tianshuRoot(), app.isPackaged ? "app" : "dev");
}

/** 分组下子目录（各具名目录的唯一出口，防调用方散拼字符串） */
function appDataDir(sub: string): string {
  return path.join(appDataHome(), sub);
}

export function databaseDir(): string {
  return appDataDir("database");
}

export function skillsDir(): string {
  return appDataDir("skills");
}

export function libraryDir(): string {
  return appDataDir("library");
}

export function logsDir(): string {
  return appDataDir("logs");
}

export function attachmentsDir(): string {
  return appDataDir("attachments");
}

export function workflowAssetsDir(): string {
  return appDataDir("workflow-assets");
}

export function projectsDir(): string {
  return appDataDir("projects");
}

export function fileHistoryDir(): string {
  return appDataDir("file-history");
}

/** JWT 密钥文件（数据分组根直下，随应用数据备份） */
export function jwtSecretPath(): string {
  return path.join(appDataHome(), ".jwt-secret");
}
