// ApprovalCoordinator 单测：T7 一期 default 模式经 tool-gate autoDenyApprovals
// 门自动拒绝，审批挂起链（request→respond/voidAll）在 run 链路不再触达——
// 保留链的正确性由本单测钉死（二期 approve 端点接入的前提）。
import { ApprovalCoordinator } from 'src/core/tools/approval';

describe('ApprovalCoordinator 会话隔离作废', () => {
  it('voidAll(sessionId) 只作废该会话未决审批，他会的仍可决议', async () => {
    const c = new ApprovalCoordinator();
    const pA = c.request(1, 'tc-a', '摘要A');
    const pB = c.request(2, 'tc-b', '摘要B');
    expect(c.voidAll(1)).toBe(1);
    await expect(pA).resolves.toBe(false);
    expect(c.pendingCount).toBe(1);
    // 会话 2 的挂起不受会话 1 收尾影响，仍可正常决议
    expect(c.respond('tc-b', true)).toBe(true);
    await expect(pB).resolves.toBe(true);
  });

  it('voidAll(sessionId) 未命中返回 0', () => {
    const c = new ApprovalCoordinator();
    expect(c.voidAll(999)).toBe(0);
  });
});

describe('ApprovalCoordinator（保留审批链）', () => {
  it('request 挂起 → respond(true/false) 决议，未知 id 返回 false', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending = coordinator.request(1, 't1', 'write → a.txt');
    expect(coordinator.pendingCount).toBe(1);

    // 未知 id 不决议也不误伤在挂条目
    expect(coordinator.respond('unknown', true)).toBe(false);
    expect(coordinator.pendingCount).toBe(1);
    expect(coordinator.respond('t1', true)).toBe(true);
    expect(await pending).toBe(true);
    expect(coordinator.pendingCount).toBe(0);

    const denied = coordinator.request(1, 't2', 'bash → rm -rf');
    expect(coordinator.respond('t2', false)).toBe(true);
    expect(await denied).toBe(false);
  });

  it('voidAll：本会话未决全部作废（resolve false），返回作废数量', async () => {
    const coordinator = new ApprovalCoordinator();
    const first = coordinator.request(1, 'a', 's1');
    const second = coordinator.request(1, 'b', 's2');
    expect(coordinator.voidAll(1)).toBe(2);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(coordinator.pendingCount).toBe(0);
    expect(coordinator.respond('a', true)).toBe(false);
  });

  describe('request 超时', () => {
    it('超时自动 deny 并清理 pending', async () => {
      jest.useFakeTimers();
      const c = new ApprovalCoordinator();
      const p = c.request(1, 'tc1', 's');
      jest.advanceTimersByTime(300_001);
      await expect(p).resolves.toBe(false);
      expect(c.pendingCount).toBe(0);
      jest.useRealTimers();
    });
  });
});
