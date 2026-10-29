// ApprovalCoordinator 单测：T7 一期 default 模式经 tool-gate autoDenyApprovals
// 门自动拒绝，审批挂起链（request→respond/voidAll）在 run 链路不再触达——
// 保留链的正确性由本单测钉死（二期 approve 端点接入的前提）。
import { ApprovalCoordinator } from 'src/core/tools/approval';

describe('ApprovalCoordinator（保留审批链）', () => {
  it('request 挂起 → respond(true/false) 决议，未知 id 返回 false', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending = coordinator.request('t1', 'write → a.txt');
    expect(coordinator.pendingCount).toBe(1);

    // 未知 id 不决议也不误伤在挂条目
    expect(coordinator.respond('unknown', true)).toBe(false);
    expect(coordinator.pendingCount).toBe(1);
    expect(coordinator.respond('t1', true)).toBe(true);
    expect(await pending).toBe(true);
    expect(coordinator.pendingCount).toBe(0);

    const denied = coordinator.request('t2', 'bash → rm -rf');
    expect(coordinator.respond('t2', false)).toBe(true);
    expect(await denied).toBe(false);
  });

  it('voidAll：全部未决作废（resolve false），返回作废数量', async () => {
    const coordinator = new ApprovalCoordinator();
    const first = coordinator.request('a', 's1');
    const second = coordinator.request('b', 's2');
    expect(coordinator.voidAll()).toBe(2);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(coordinator.pendingCount).toBe(0);
    expect(coordinator.respond('a', true)).toBe(false);
  });

  describe('request 超时', () => {
    it('超时自动 deny 并清理 pending', async () => {
      jest.useFakeTimers();
      const c = new ApprovalCoordinator();
      const p = c.request('tc1', 's');
      jest.advanceTimersByTime(300_001);
      await expect(p).resolves.toBe(false);
      expect(c.pendingCount).toBe(0);
      jest.useRealTimers();
    });
  });
});
