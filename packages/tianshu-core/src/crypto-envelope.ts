/**
 * 凭证静态加密信封（安全审查 2026-11-02 三批 C1，纯 node:crypto）：
 * AES-256-GCM + 随机 12B nonce + 前缀标识 `enc:v1:`——单源供双端消费
 * （mirror safeStorage 主密钥 / tianshu-server TIANSHU_MASTER_KEY env）。
 *
 * 设计要点：
 * - 前缀自描述：读取侧检测 `enc:v1:` 即解密，否则原样返回（旧明文数据
 *   零迁移成本兼容——写侧懒迁移：读到明文且已有主密钥时回写密文）
 * - AAD 绑定字段名（field）：密文挪用到其他字段列时 GCM 校验失败——
 *   防库内密文移位攻击（如把 provider A 的密文贴到 provider B）
 * - nonce 随机不计数器：静态存储无重放序问题，随机即可；同明文两次
 *   加密产不同密文（防等值比对泄露）
 * - 解密失败（密钥轮换/数据损坏）返回 null 由调用方降级为"凭证读取
 *   失败"呈现，不抛错中断业务
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENC_PREFIX = "enc:v1:";

/** 主密钥：32 字节原始密钥（hex 解码后） */
export type MasterKey = Buffer;

/** 主密钥 hex（64 字符）→ Buffer；非法长度返回 null */
export function masterKeyFromHex(hex: string): MasterKey | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** 加密单字段：返回 `enc:v1:<base64(nonce|ciphertext|tag)>` */
export function encryptField(
  key: MasterKey,
  field: string,
  plaintext: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(field, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    ENC_PREFIX +
    Buffer.concat([nonce, encrypted, tag]).toString("base64")
  );
}

/** 解密单字段：非密文形态（无前缀）原样返回（旧明文兼容）；
 *  密文但解密失败（密钥不符/损坏/AAD 不匹配）返回 null */
export function decryptField(
  key: MasterKey,
  field: string,
  stored: string,
): string | null {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  try {
    const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(field, "utf8"));
    decipher.setAuthTag(tag);
    return (
      decipher.update(ciphertext).toString("utf8") +
      decipher.final("utf8")
    );
  } catch {
    return null;
  }
}

/** 存储值是否已是密文形态（写入侧跳过重复加密的判定） */
export function isEncryptedField(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}
