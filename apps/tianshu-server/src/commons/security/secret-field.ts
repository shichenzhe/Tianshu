/**
 * 服务端凭证密封（安全审查 2026-11-02 三批 C4）：
 * TIANSHU_MASTER_KEY（64 位 hex）env 驱动——设置时 provider 凭证
 * AES-256-GCM 信封落库（@tianshu/core crypto-envelope 单源，AAD 字段
 * 绑定与 mirror 侧同构）；未设置保持明文（部署兼容，启动打告警提示）。
 * 读侧透明：无前缀旧明文原样返回（升级零迁移）。
 */
import {
  decryptField,
  encryptField,
  isEncryptedField,
  masterKeyFromHex,
  type MasterKey,
} from '@tianshu/core';

let cached: MasterKey | null | undefined;

/** 主密钥（env TIANSHU_MASTER_KEY，64 hex；非法/未设返回 null） */
export function serverMasterKey(): MasterKey | null {
  if (cached !== undefined) return cached;
  const hex = process.env.TIANSHU_MASTER_KEY;
  cached = hex ? masterKeyFromHex(hex) : null;
  if (hex && cached === null) {
    console.warn(
      '[安全告警] TIANSHU_MASTER_KEY 已设置但非 64 位 hex——凭证将明文落库（生成：openssl rand -hex 32）',
    );
  }
  return cached;
}

/** 写侧：有主密钥即加密（null/空串/已密文透传） */
export function sealSecret(
  field: string,
  value: string | null,
): string | null {
  if (value === null || value === '' || isEncryptedField(value)) {
    return value;
  }
  const key = serverMasterKey();
  if (key === null) return value;
  return encryptField(key, field, value);
}

/** 读侧：透明解密（旧明文原样；解密失败 null——凭证呈现为缺失） */
export function openSecret(
  field: string,
  stored: string | null,
): string | null {
  if (stored === null || !isEncryptedField(stored)) return stored;
  const key = serverMasterKey();
  if (key === null) return null;
  return decryptField(key, field, stored);
}

/** 测试隔离 */
export function resetServerMasterKeyForTest(): void {
  cached = undefined;
}
