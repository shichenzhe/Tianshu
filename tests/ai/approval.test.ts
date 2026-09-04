import { describe, expect, it } from "vitest";
import { ApprovalCoordinator } from "../../electron/domains/ai/agent/approval";

describe("ApprovalCoordinator", () => {
  it("request 挂起，respond true 后 resolve true", async () => {
    const c = new ApprovalCoordinator();
    const p = c.request("t1", "写入 a.txt");
    expect(c.pendingCount).toBe(1);
    c.respond("t1", true);
    await expect(p).resolves.toBe(true);
    expect(c.pendingCount).toBe(0);
  });
  it("respond false → resolve false", async () => {
    const c = new ApprovalCoordinator();
    const p = c.request("t1", "x");
    c.respond("t1", false);
    await expect(p).resolves.toBe(false);
  });
  it("未知 toolCallId respond 返回 false 且无副作用", () => {
    const c = new ApprovalCoordinator();
    expect(c.respond("ghost", true)).toBe(false);
  });
  it("voidAll 作废全部 pending（resolve false）并返回数量", async () => {
    const c = new ApprovalCoordinator();
    const p1 = c.request("a", "x");
    const p2 = c.request("b", "y");
    expect(c.voidAll()).toBe(2);
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false);
    expect(c.pendingCount).toBe(0);
  });
});
