import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import { resolveAutomationPermissions } from "../../electron/domains/ai/automation/automation-runner";

describe("resolveAutomationPermissions", () => {
  it("default:完全访问、写许可与写审批均拒绝(只读执行)", async () => {
    const p = resolveAutomationPermissions("default");
    expect(p.fullAccess()).toBe(false);
    expect(await p.isToolAllowed("write_file")).toBe(false);
    expect(await p.requestApproval()).toBe(false);
  });

  it("full:无人值守全放行(与现状一致)", async () => {
    const p = resolveAutomationPermissions("full");
    expect(p.fullAccess()).toBe(true);
    expect(await p.isToolAllowed("write_file")).toBe(true);
    expect(await p.requestApproval()).toBe(true);
  });
});
