// RC-T7 漂移巡检 manifest 结构守护（不跑比对本身，比对走 npm run check:drift）：
// 1. manifest JSON 合法——pairs 非空、id 唯一、必填字段齐（id/mirrorPath/
//    serverPath/note）；非 skip 条目 baselineLines 必为数字（首跑已固化基线）、
//    baselineDiff 为布尔；skip 条目 skip===true 且 note 说明理由；
// 2. 路径存在——mirrorPath 相对 mirror 仓根必须存在；serverPath 相对
//    manifest.serverRoot（环境变量 TIANSHU_SERVER_ROOT 可覆盖）存在——
//    server 仓缺失的独立 CI 环境下 soft-skip（mirror 单仓仍可全绿）；
// 3. 巡检脚本与 npm scripts 接线在位（check-drift.mjs + check:drift）。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mirrorRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const scriptsDir = path.join(mirrorRoot, "packages", "tianshu-core", "scripts");
const manifestPath = path.join(scriptsDir, "drift-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  serverRoot?: string;
  pairs?: Array<{
    id: string;
    mirrorPath: string;
    serverPath: string;
    baselineDiff?: boolean;
    baselineLines?: number | null;
    skip?: boolean;
    note?: string;
  }>;
};
const serverRoot = process.env.TIANSHU_SERVER_ROOT
  ? path.resolve(process.env.TIANSHU_SERVER_ROOT)
  : path.resolve(mirrorRoot, manifest.serverRoot || "apps/tianshu-server");

describe("RC-T7 漂移巡检 manifest", () => {
  it("manifest JSON 合法：pairs 非空、id 唯一、必填字段齐", () => {
    expect(Array.isArray(manifest.pairs)).toBe(true);
    expect(manifest.pairs!.length).toBeGreaterThan(0);
    const ids = manifest.pairs!.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pair of manifest.pairs!) {
      expect(typeof pair.id).toBe("string");
      expect(pair.id.length).toBeGreaterThan(0);
      expect(typeof pair.mirrorPath).toBe("string");
      expect(typeof pair.serverPath).toBe("string");
      expect(typeof pair.note).toBe("string");
      expect(pair.note!.length).toBeGreaterThan(0);
    }
  });

  it("非 skip 条目：baselineLines 数字（首跑已固化）+ baselineDiff 布尔", () => {
    const compared = manifest.pairs!.filter((p) => !p.skip);
    expect(compared.length).toBeGreaterThan(0);
    for (const pair of compared) {
      expect(
        typeof pair.baselineLines === "number" &&
          Number.isFinite(pair.baselineLines),
        `${pair.id} baselineLines 应为数字`,
      ).toBe(true);
      expect(pair.baselineLines).toBeGreaterThanOrEqual(0);
      expect(typeof pair.baselineDiff).toBe("boolean");
    }
  });

  it("skip 条目：至少 1 个守位 + skip===true 且留有理由", () => {
    // 防空转：全下线 skip 时本用例会空转通过——至少 1 个守位
    // （现库 prisma-schema 一对，结构上确保 skip 分支有真实样本）
    const skipped = manifest.pairs!.filter((p) => "skip" in p);
    expect(skipped.length).toBeGreaterThan(0);
    for (const pair of skipped) {
      expect(pair.skip).toBe(true);
      expect(pair.note!.length).toBeGreaterThan(0);
    }
  });

  it("mirror 侧路径全部存在", () => {
    for (const pair of manifest.pairs!) {
      expect(
        existsSync(path.join(mirrorRoot, pair.mirrorPath)),
        `mirror 缺失：${pair.mirrorPath}（${pair.id}）`,
      ).toBe(true);
    }
  });

  it(
    "server 侧路径存在（server 仓缺席时 soft-skip）",
    { skipIf: !existsSync(serverRoot) },
    () => {
      for (const pair of manifest.pairs!) {
        expect(
          existsSync(path.join(serverRoot, pair.serverPath)),
          `server 缺失：${pair.serverPath}（${pair.id}）`,
        ).toBe(true);
      }
    },
  );

  it("巡检脚本与 npm scripts 接线在位", () => {
    expect(existsSync(path.join(scriptsDir, "check-drift.mjs"))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(path.join(mirrorRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["check:drift"]).toContain("check-drift.mjs");
  });
});
