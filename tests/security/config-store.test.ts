import { describe, expect, it } from "vitest";
import {
  normalizeFileBackupMaxSizeMB,
  normalizeBulkDeleteThreshold,
  pickCommandRuleArray,
  pickStringArray,
  parseSecurityConfig,
  serializeSecurityValue,
  setSecurityOption,
  stripBuiltinItems,
  mergeRuleList,
} from "../../electron/domains/security/config-store";
import {
  SECURITY_DEFAULTS,
  defaultFileBlocklist,
} from "../../electron/domains/security/defaults";

describe("normalize 族", () => {
  it("备份配额钳制 ≥1000 并取整", () => {
    expect(normalizeFileBackupMaxSizeMB(500)).toBe(1000);
    expect(normalizeFileBackupMaxSizeMB(2500.7)).toBe(2501);
    expect(normalizeFileBackupMaxSizeMB("3000")).toBe(3000);
  });
  it("批量删除阈值：1–10000 保留，>10000 钳至预估计数上限，非法回落 50", () => {
    expect(normalizeBulkDeleteThreshold(120)).toBe(120);
    expect(normalizeBulkDeleteThreshold(10000)).toBe(10000);
    expect(normalizeBulkDeleteThreshold(0)).toBe(50);
    expect(normalizeBulkDeleteThreshold(20000)).toBe(10000); // 钳制：封堵 >10000 静默失效区
    expect(normalizeBulkDeleteThreshold(100000)).toBe(10000);
    expect(normalizeBulkDeleteThreshold(20000.5)).toBe(50); // 非整数仍非法
    expect(normalizeBulkDeleteThreshold("abc")).toBe(50);
  });
  it("命令规则：剔除空 token、剔除非法条目", () => {
    expect(
      pickCommandRuleArray([
        { prefix: ["git", "", "push"] },
        { prefix: [] },
        "x",
      ]),
    ).toEqual([{ prefix: ["git", "push"] }]);
  });
  it("字符串名单：仅保留非空字符串", () => {
    expect(pickStringArray(["a", "", 1, "b"])).toEqual(["a", "b"]);
  });
});

describe("parseSecurityConfig（read-time fallback）", () => {
  it("空行集 → 全默认", () => {
    expect(parseSecurityConfig([])).toEqual(SECURITY_DEFAULTS);
  });
  it("畸形 JSON → 该项回退默认，不抛错", () => {
    const rows = [{ name: "fileAllowlist", value: "{broken" }];
    expect(parseSecurityConfig(rows).fileAllowlist).toEqual([]);
  });
  it("合法行覆盖默认", () => {
    const rows = [
      { name: "sandboxEnabled", value: "false" },
      { name: "programBlacklist", value: '["rm","mkfs"]' },
    ];
    const parsed = parseSecurityConfig(rows);
    expect(parsed.sandboxEnabled).toBe(false);
    expect(parsed.programBlacklist).toEqual(["rm", "mkfs"]);
  });
});

describe("序列化与内置项处理", () => {
  it("serializeSecurityValue：bool/number 转字符串，数组转 JSON", () => {
    expect(serializeSecurityValue("sandboxEnabled", false)).toBe("false");
    expect(serializeSecurityValue("bulkDeleteThreshold", 80)).toBe("80");
    expect(serializeSecurityValue("domainDeny", ["a.com"])).toBe('["a.com"]');
  });
  it("stripBuiltinItems 剔除与内置相同的项", () => {
    expect(stripBuiltinItems(["/tmp", "~/.ssh/"], ["~/.ssh/"])).toEqual([
      "/tmp",
    ]);
  });
  it("mergeRuleList：内置在前、去重", () => {
    expect(mergeRuleList(["~/.ssh/"], ["/tmp", "~/.ssh/"])).toEqual([
      "~/.ssh/",
      "/tmp",
    ]);
  });
});

describe("defaults 平台差异与 upsert 兜底", () => {
  it("win32 过滤内置清单", () => {
    const win = defaultFileBlocklist("win32");
    expect(win).not.toContain("~/Library/Keychains/");
    expect(defaultFileBlocklist("darwin")).toContain("~/Library/Keychains/");
  });
  it("setSecurityOption upsert：未命中则 create", async () => {
    const calls: string[] = [];
    const db = {
      findMany: async () => [],
      updateMany: async () => {
        calls.push("updateMany");
        return { count: 0 };
      },
      create: async ({ data }: { data: { name: string; value: string } }) => {
        calls.push("create:" + data.name);
        return {};
      },
    };
    await setSecurityOption(db as never, "sandboxEnabled", "true");
    expect(calls).toEqual(["updateMany", "create:sandboxEnabled"]);
  });
});

describe("SP2 默认值演进", () => {
  it("cmdAsk 默认 curl/wget，cmdAllow 默认 git push/npm install", () => {
    expect(SECURITY_DEFAULTS.cmdAsk).toEqual([
      { prefix: ["curl"] },
      { prefix: ["wget"] },
    ]);
    expect(SECURITY_DEFAULTS.cmdAllow).toEqual([
      { prefix: ["git", "push"] },
      { prefix: ["npm", "install"] },
    ]);
  });
});
