/**
 * 桌面凭证字段密封封（安全审查 2026-11-02 三批 C3）：
 * repo 读写点的薄封装——写侧有主密钥即加密（enc:v1: 信封），读侧
 * 透明解密（无前缀=旧明文原样返回，懒迁移由写侧回写完成）。
 * 主密钥不可用（safeStorage 损坏）时读写均走明文——业务不阻断。
 */
import {
  decryptField,
  encryptField,
  isEncryptedField,
} from "@tianshu/core";
import { getMasterKey } from "./master-key";

/** 写侧：加密单字段（null 透传；主密钥不可用或已是密文则原样） */
export async function sealSecret(
  field: string,
  value: string | null,
): Promise<string | null> {
  if (value === null || value === "" || isEncryptedField(value)) {
    return value;
  }
  const key = await getMasterKey();
  if (key === null) return value;
  return encryptField(key, field, value);
}

/** 读侧：解密单字段（null 透传；解密失败返回 null——凭证呈现为缺失
 *  而非业务中断；旧明文原样返回） */
export async function openSecret(
  field: string,
  stored: string | null,
): Promise<string | null> {
  if (stored === null || !isEncryptedField(stored)) return stored;
  const key = await getMasterKey();
  if (key === null) return null;
  return decryptField(key, field, stored);
}
