/**
 * 桌面凭证主密钥管理（安全审查 2026-11-02 三批 C2）：
 * 随机 32B 主密钥经 Electron safeStorage（OS keychain：macOS Keychain /
 * Windows DPAPI / Linux libsecret）加密后落 option 表 `security.masterKey`；
 * 运行时解密缓存。凭证值用主密钥经 @tianshu/core crypto-envelope
 * AES-256-GCM 加密落库——库文件/备份档外流时凭证为密文。
 *
 * 降级链：safeStorage 不可用（Linux 无 keychain 服务等）→ 主密钥明文
 * 落 option 表（仍有 enc:v1 信封——挡"拿到库文件"不挡"拿到同机用户
 * 上下文"；与现状明文凭证相比仍是收紧）。
 */
import { safeStorage } from "electron";

/** safeStorage 可用性（缺 export 的测试替身/异常环境按不可用降级） */
function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
import { randomBytes } from "node:crypto";
import prisma from "../../commons/prisma-client";
import { masterKeyFromHex, type MasterKey } from "@tianshu/core";

const OPTION_KEY = "security.masterKey";
/** option 表 name/type 列口径（与 connections 的 serverConnections 行同款） */
const OPTION_NAME = "security";
const OPTION_TYPE = "app";

let cached: MasterKey | null | undefined;
/** 初始化失败哨兵（防每调用重试 DB 写放大——下次进程重启自然重试） */
let initFailed = false;

/** 主密钥明文形态是否直接落库（safeStorage 不可用的降级标记） */
let degradedPlaintext = false;

async function readOptionValue(): Promise<string | null> {
  try {
    const row = await prisma.option.findFirst({
      where: { name: OPTION_NAME, type: OPTION_TYPE },
      select: { value: true },
    });
    return row?.value ?? null;
  } catch {
    // 表不可用（测试替身缺面/启动早期）——按未初始化处理，写侧走
    // 明文兼容（fail-safe：凭证功能不因安全层故障而中断）
    return null;
  }
}

async function writeOptionValue(value: string): Promise<boolean> {
  try {
    const row = await prisma.option.findFirst({
      where: { name: OPTION_NAME, type: OPTION_TYPE },
      select: { id: true },
    });
    if (row) {
      await prisma.option.update({ where: { id: row.id }, data: { value } });
    } else {
      await prisma.option.create({
        data: { name: OPTION_NAME, type: OPTION_TYPE, value },
      });
    }
    return true;
  } catch {
    // 写失败（表不可用/测试替身缺面）——返回 false，调用方降级明文
    // （不得用临时密钥密封：重启后新密钥解不开旧密文=凭证永久丢失）
    return false;
  }
}

/**
 * 取主密钥（首次调用加载/生成并缓存）：
 * - 无行：生成随机 32B，safeStorage 可用则加密后 base64 落表，否则 hex
 *   明文落表（降级标记）
 * - 有行：safeStorage 密文解密 / hex 明文直取
 * 返回 null = 完全不可用（safeStorage 有行但解密失败——keychain 数据
 * 损坏或系统迁移；此时凭证读写走明文兼容，不阻断业务）
 */
export async function getMasterKey(): Promise<MasterKey | null> {
  if (cached !== undefined) return cached;
  if (initFailed) return null;
  const stored = await readOptionValue();
  if (stored === null) {
    const fresh = randomBytes(32);
    let persisted = true;
    if (safeStorageAvailable()) {
      const wrapped = safeStorage.encryptString(fresh.toString("hex"));
      persisted = await writeOptionValue(`ss:v1:${wrapped.toString("base64")}`);
    } else {
      degradedPlaintext = true;
      persisted = await writeOptionValue(`hex:v1:${fresh.toString("hex")}`);
    }
    // 持久化失败 → 无主密钥（明文兼容）：临时密钥密封的值重启后
    // 不可解=凭证永久丢失，宁可明文
    if (!persisted) {
      initFailed = true;
      return null;
    }
    cached = fresh;
    return cached;
  }
  if (stored.startsWith("ss:v1:")) {
    if (!safeStorageAvailable()) {
      // keychain 在生成后失效（Linux 服务卸载等）——旧密文不可解
      cached = null;
      return cached;
    }
    try {
      const hex = safeStorage.decryptString(
        Buffer.from(stored.slice("ss:v1:".length), "base64"),
      );
      cached = masterKeyFromHex(hex);
      return cached;
    } catch {
      cached = null;
      return cached;
    }
  }
  if (stored.startsWith("hex:v1:")) {
    const key = masterKeyFromHex(stored.slice("hex:v1:".length));
    // 读时升级：存量明文形态 + safeStorage 现已可用（批外 bug 修复前
    // 生成的行）→ 包裹写回 ss:v1（密钥值不变，既有 enc:v1 凭证零影响；
    // 写失败维持降级读取不阻断——密钥本身仍有效）
    if (safeStorageAvailable() && key) {
      const wrapped = safeStorage.encryptString(key.toString("hex"));
      const persisted = await writeOptionValue(
        `ss:v1:${wrapped.toString("base64")}`,
      );
      if (persisted) {
        cached = key;
        return cached;
      }
    }
    degradedPlaintext = true;
    cached = key;
    return cached;
  }
  // 未知形态（未来版本写入）——按不可用处理
  cached = null;
  return cached;
}

/** 降级状态查询（诊断/日志用） */
export function isMasterKeyDegraded(): boolean {
  return degradedPlaintext;
}

/**
 * 加密状态查询（批1A 设置页透出用）：先确保密钥已加载再读降级标记——
 * degradedPlaintext 只在 getMasterKey() 加载/生成路径上置位，冷进程
 * 直接读恒 false 会漏报。degraded=true = 主密钥 hex 明文落表
 * （safeStorage 不可用的降级形态，仍有 enc:v1 信封）。
 */
export async function getMasterKeyStatus(): Promise<{
  degraded: boolean;
}> {
  await getMasterKey();
  return { degraded: isMasterKeyDegraded() };
}

/** 测试隔离：清缓存 */
export function resetMasterKeyCacheForTest(): void {
  cached = undefined;
  degradedPlaintext = false;
  initFailed = false;
}
