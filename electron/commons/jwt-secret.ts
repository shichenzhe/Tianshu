/**
 * JWT 密钥管理：首启随机生成并持久化到 userData（文件权限 600），
 * 取代历史硬编码常量（开源仓库中可见的密钥等于没有密钥）。
 * 文件读写失败降级为进程内存随机串（本会话内 token 有效，重启失效），
 * 不阻塞启动。进程内惰性单例。
 */
import { app } from "electron";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SECRET_FILE_NAME = ".jwt-secret";

let cached: string | null = null;

/** 密钥文件路径（userData 下，与 SQLite 库同目录族，随应用数据备份） */
function secretFilePath(): string {
  return join(app.getPath("userData"), SECRET_FILE_NAME);
}

/** 读不到就用进程内存随机串兜底（读写失败时保持可用，重启后 token 重签） */
function fallbackSecret(): string {
  return randomBytes(48).toString("base64url");
}

/** 读取或生成并落盘 JWT 密钥 */
function loadOrCreate(): string {
  try {
    const filePath = secretFilePath();
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    const secret = fallbackSecret();
    // userData 常态已存在，mkdir 仅为异常环境（测试/便携模式）兜底
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(filePath, secret, { encoding: "utf8", mode: 0o600 });
    chmodSync(filePath, 0o600); // Windows 无效，POSIX 确保 600
    return secret;
  } catch {
    return fallbackSecret();
  }
}

/** 取当前 JWT 密钥（进程内单例，首次调用时读取/生成） */
export function getJwtSecret(): string {
  if (cached === null) {
    cached = loadOrCreate();
  }
  return cached;
}

/** 清除进程内缓存（仅测试用：换 userData 后重新加载） */
export function resetJwtSecretCache(): void {
  cached = null;
}
