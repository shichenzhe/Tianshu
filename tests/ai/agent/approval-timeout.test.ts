import { describe, expect, it, vi } from "vitest";
import { ApprovalCoordinator } from "../../../electron/domains/ai/agent/approval";

describe("ApprovalCoordinator 超时", () => {
  it("超时自动 deny（缺省 10 分钟）", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc1", "摘要");
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await expect(p).resolves.toBe(false);
    expect(c.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("respond 清理定时器，不重复触发", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc2", "摘要");
    expect(c.respond("tc2", true)).toBe(true);
    await expect(p).resolves.toBe(true);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(c.respond("tc2", true)).toBe(false); // 已决议，二次应答 false
    vi.useRealTimers();
  });

  it("自定义超时可立即到期", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc3", "摘要", 50);
    vi.advanceTimersByTime(51);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });
});
