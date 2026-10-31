import { describe, expect, it, vi } from "vitest";
import { ApprovalCoordinator } from "../../../electron/domains/ai/agent/approval";

describe("ApprovalCoordinator 会话隔离作废", () => {
  it("voidAll(sessionId) 只作废该会话的未决审批，他会的仍可决议", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const pA = c.request(1, "tc-a", "摘要A");
    const pB = c.request(2, "tc-b", "摘要B");
    const voided = c.voidAll(1);
    expect(voided).toBe(1);
    await expect(pA).resolves.toBe(false);
    expect(c.pendingCount).toBe(1);
    // 会话 2 的审批不受会话 1 收尾影响，仍可正常决议
    expect(c.respond("tc-b", true)).toBe(true);
    await expect(pB).resolves.toBe(true);
    vi.useRealTimers();
  });

  it("voidAll(sessionId) 未命中返回 0", () => {
    const c = new ApprovalCoordinator();
    expect(c.voidAll(999)).toBe(0);
  });
});

describe("ApprovalCoordinator 超时", () => {
  it("超时自动 deny（缺省 10 分钟）", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request(1, "tc1", "摘要");
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await expect(p).resolves.toBe(false);
    expect(c.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("respond 清理定时器，不重复触发", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request(1, "tc2", "摘要");
    expect(c.respond("tc2", true)).toBe(true);
    await expect(p).resolves.toBe(true);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(c.respond("tc2", true)).toBe(false); // 已决议，二次应答 false
    vi.useRealTimers();
  });

  it("自定义超时可立即到期", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request(1, "tc3", "摘要", 50);
    vi.advanceTimersByTime(51);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });
});
