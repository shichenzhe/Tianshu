import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // 安全批：密封链引 safeStorage（降级形态——master-key 走 hex 路径）
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
    decryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
  }, ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** toolPermission.findMany/update 可控替身（rememberedToolOf 查表链——
 *  参数级审批批改 findMany 投影 + lastUsedAt fire-and-forget 回写）——
 *  vi.hoisted：vi.mock 工厂被提升到文件顶执行，裸顶层 const 在工厂内
 *  引用即 TDZ ReferenceError（reset 重放遗留，2026-11-02 修） */
const rows = vi.hoisted(() => ({
  current: [] as Array<{ id: number; pattern: string | null }>,
}));
const findMany = vi.hoisted(() =>
  vi.fn(async () => rows.current),
);
const update = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: { toolPermission: { findMany, update } },
}));

import {
  rememberedToolOf,
  resolveAutomationPermissions,
} from "../../electron/domains/ai/automation/automation-runner";

describe("resolveAutomationPermissions", () => {
  it("default:完全访问、写许可与写审批均拒绝(只读执行)", async () => {
    const p = resolveAutomationPermissions("default");
    expect(p.fullAccess()).toBe(false);
    expect(await p.isToolAllowed("write")).toBe(false);
    expect(await p.requestApproval()).toBe(false);
  });

  it("full:无人值守全放行(与现状一致)", async () => {
    const p = resolveAutomationPermissions("full");
    expect(p.fullAccess()).toBe(true);
    expect(await p.isToolAllowed("write")).toBe(true);
    expect(await p.requestApproval()).toBe(true);
  });

  it("审批记忆查表（2026-11-01 审查批 F3 收口）：default 命中已记忆工具直执行", async () => {
    const remembered = vi.fn(async (toolName: string) => toolName === "write");
    const p = resolveAutomationPermissions("default", remembered);
    expect(await p.isToolAllowed("write")).toBe(true);
    expect(await p.isToolAllowed("bash")).toBe(false);
    // full 恒放行，查表不触达
    const fullP = resolveAutomationPermissions("full", remembered);
    expect(await fullP.isToolAllowed("any")).toBe(true);
    expect(remembered).toHaveBeenCalledTimes(2);
  });
});

describe("rememberedToolOf（查表闭包）", () => {
  it("workspaceId 缺席恒 false；命中 toolPermission 行 true（chat 链同款查询形态）", async () => {
    expect(await rememberedToolOf(null)("write")).toBe(false);
    expect(await rememberedToolOf(undefined)("write")).toBe(false);
    rows.current = [{ id: 7, pattern: null }];
    expect(await rememberedToolOf(5)("write")).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 5, toolName: "write" },
      select: { id: true, pattern: true },
    });
    // 命中行 lastUsedAt fire-and-forget 回写（记忆治理数据源）
    expect(update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { lastUsedAt: expect.any(Date) },
    });
    rows.current = [];
    expect(await rememberedToolOf(5)("bash")).toBe(false);
  });

  it("参数级 pattern 行按参数匹配（isRememberedPermission 单源语义）", async () => {
    rows.current = [{ id: 8, pattern: "git *" }];
    expect(await rememberedToolOf(5)("bash", { command: "git push" })).toBe(
      true,
    );
    expect(await rememberedToolOf(5)("bash", { command: "npm i" })).toBe(
      false,
    );
  });
});
