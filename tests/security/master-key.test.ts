/**
 * master-key 单测（安全审查 2026-11-02 批外 bug 随修）：safeStorageAvailable
 * 曾递归调用自身 → RangeError 被 catch → 恒 false → 主密钥永走 hex:v1 明文
 * 降级，OS keychain 保护从未生效。本组测试锁定：可用性真实传导 + 存量
 * hex:v1 行在读到且 safeStorage 可用时升级写回 ss:v1（密钥值不变，既有
 * enc:v1 凭证零影响）。electron safeStorage 与 prisma option 表全替身。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn<boolean, []>(() => true),
    encryptString: vi.fn((plain: string) => Buffer.from(`wrapped(${plain})`)),
    decryptString: vi.fn((wrapped: Buffer) =>
      wrapped.toString("utf8").replace(/^wrapped\(/, "").replace(/\)$/, ""),
    ),
  },
  rows: new Map<string, string>(),
  prisma: {} as {
    option: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock(
  "electron",
  () => ({ safeStorage: mocks.safeStorage }),
  { virtual: true },
);

vi.mock("../../electron/commons/prisma-client", () => {
  const row = () => ({ id: "opt-1", value: [...mocks.rows.entries()][0]?.[1] ?? null });
  return {
    default: {
      option: {
        findFirst: vi.fn(async () => ([...mocks.rows.entries()][0] ? row() : null)),
        update: vi.fn(async (args: { data: { value: string } }) => {
          mocks.rows.set("security.masterKey", args.data.value);
        }),
        create: vi.fn(async (args: { data: { value: string } }) => {
          mocks.rows.set("security.masterKey", args.data.value);
        }),
      },
    },
  };
});

import {
  getMasterKey,
  isMasterKeyDegraded,
  resetMasterKeyCacheForTest,
} from "../../electron/domains/security/master-key";
import { masterKeyFromHex } from "../../packages/tianshu-core/src/crypto-envelope";

describe("master-key（safeStorage 可用性 + 读时升级）", () => {
  beforeEach(() => {
    mocks.rows.clear();
    mocks.safeStorage.isEncryptionAvailable.mockReset();
    mocks.safeStorage.encryptString.mockClear();
    mocks.safeStorage.decryptString.mockClear();
    resetMasterKeyCacheForTest();
  });

  it("safeStorage 可用 + 无行：生成密钥经 encryptString 包裹落 ss:v1:（非明文降级）", async () => {
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const key = await getMasterKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
    const stored = mocks.rows.get("security.masterKey")!;
    expect(stored.startsWith("ss:v1:")).toBe(true);
    expect(mocks.safeStorage.encryptString).toHaveBeenCalledOnce();
    // 降级标记关闭——keychain 保护生效
    expect(isMasterKeyDegraded()).toBe(false);
  });

  it("safeStorage 不可用：hex:v1 明文降级 + degraded 标记", async () => {
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const key = await getMasterKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(mocks.rows.get("security.masterKey")!.startsWith("hex:v1:")).toBe(true);
    expect(isMasterKeyDegraded()).toBe(true);
  });

  it("存量 hex:v1 行 + safeStorage 已可用：取回原密钥并升级写回 ss:v1（密钥值不变）", async () => {
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const legacyHex = "ab".repeat(32);
    mocks.rows.set("security.masterKey", `hex:v1:${legacyHex}`);
    const key = await getMasterKey();
    // 密钥值不变（既有 enc:v1 凭证零影响），仅存储形态升级
    expect(key?.toString("hex")).toBe(legacyHex);
    expect(masterKeyFromHex(legacyHex)).toBeTruthy();
    const stored = mocks.rows.get("security.masterKey")!;
    expect(stored.startsWith("ss:v1:")).toBe(true);
    // 升级后不再是降级态
    expect(isMasterKeyDegraded()).toBe(false);
  });

  it("ss:v1 行：decryptString 解出 hex 复原密钥", async () => {
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const legacyHex = "cd".repeat(32);
    mocks.rows.set(
      "security.masterKey",
      `ss:v1:${Buffer.from(`wrapped(${legacyHex})`).toString("base64")}`,
    );
    const key = await getMasterKey();
    expect(key?.toString("hex")).toBe(legacyHex);
    expect(isMasterKeyDegraded()).toBe(false);
  });
});
