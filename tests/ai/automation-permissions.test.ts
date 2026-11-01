import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** toolPermission.findUnique 可控替身（rememberedToolOf 查表链） */
const findUnique = vi.fn(async () => null);
vi.mock("../../electron/commons/prisma-client", () => ({
  default: { toolPermission: { findUnique } },
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
    findUnique.mockResolvedValueOnce({ id: 7 });
    expect(await rememberedToolOf(5)("write")).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId_toolName: { workspaceId: 5, toolName: "write" } },
      select: { id: true },
    });
    expect(await rememberedToolOf(5)("bash")).toBe(false);
  });
});
