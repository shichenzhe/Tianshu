import { describe, expect, it } from "vitest";
import {
  decryptField,
  encryptField,
  isEncryptedField,
  masterKeyFromHex,
} from "../../../../packages/tianshu-core/src/crypto-envelope";

/** 凭证静态加密信封（三批 C1）：AES-256-GCM + 前缀标识 + AAD 字段绑定 */
describe("crypto-envelope", () => {
  const key = masterKeyFromHex("a".repeat(64))!;
  const key2 = masterKeyFromHex("b".repeat(64))!;

  it("往返一致；密文带 enc:v1: 前缀；同明文两次加密密文不同", () => {
    const ct = encryptField(key, "provider.apiKey", "sk-live-123");
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(isEncryptedField(ct)).toBe(true);
    expect(decryptField(key, "provider.apiKey", ct)).toBe("sk-live-123");
    // nonce 随机：同明文两次加密产不同密文（防等值比对）
    expect(encryptField(key, "provider.apiKey", "sk-live-123")).not.toBe(ct);
  });

  it("旧明文零前缀原样返回（懒迁移兼容）；空串与非字符串边界", () => {
    expect(decryptField(key, "provider.apiKey", "sk-plain")).toBe(
      "sk-plain",
    );
    expect(decryptField(key, "provider.apiKey", "")).toBe("");
    expect(isEncryptedField("sk-plain")).toBe(false);
  });

  it("AAD 字段绑定：密文挪用到其他字段名解密失败（null）", () => {
    const ct = encryptField(key, "provider.apiKey", "sk-live-123");
    expect(decryptField(key, "mcp.env", ct)).toBeNull();
  });

  it("密钥不符（轮换后旧密文）解密失败返回 null 不抛错", () => {
    const ct = encryptField(key, "provider.apiKey", "sk-live-123");
    expect(decryptField(key2, "provider.apiKey", ct)).toBeNull();
  });

  it("masterKeyFromHex：64 位 hex 有效；其他长度/非 hex 拒绝", () => {
    expect(masterKeyFromHex("ab".repeat(32))).toBeInstanceOf(Buffer);
    expect(masterKeyFromHex("ab".repeat(31))).toBeNull();
    expect(masterKeyFromHex("z".repeat(64))).toBeNull();
  });
});
