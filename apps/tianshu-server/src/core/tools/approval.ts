/**
 * 审批协调器（自 mirror electron/domains/ai/agent/approval.ts 同构移植）：
 * write 工具挂起等待审批决议——服务端语境下决议由 session/approve 端点
 * （远程控制端应答）经 respond 注入。超时自动 deny（移动端 spec §4.3：
 * manual 模式应答方不在线时防永久挂死）；缺省 5 分钟，chat-runner 按
 * config approvalTimeoutMs 传值覆盖。挂起按会话维度隔离——会话收尾
 * 作废只及本会话，跨会话并发流互不影响（同 mirror 2026-10 修复）。
 */
type Resolver = (approved: boolean) => void;

/** 缺省审批挂起上限：5 分钟无应答自动拒绝 */
export const APPROVAL_TIMEOUT_MS = 300_000;

interface PendingEntry {
  /** 挂起所属会话（收尾作废按会话过滤） */
  sessionId: number;
  resolve: Resolver;
  timer: NodeJS.Timeout;
}

export class ApprovalCoordinator {
  private pending = new Map<string, PendingEntry>();

  get pendingCount(): number {
    return this.pending.size;
  }

  request(
    sessionId: number,
    toolCallId: string,
    _argSummary: string,
    timeoutMs: number = APPROVAL_TIMEOUT_MS,
  ): Promise<boolean> {
    // _argSummary 供审批展示（tool-gate approval-request chunk 已带），协调器自身不存储
    void _argSummary;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(toolCallId, false), timeoutMs);
      // promise resolve 后不保活进程（远控长挂起场景不阻退出）
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.pending.set(toolCallId, { sessionId, resolve, timer });
    });
  }

  respond(toolCallId: string, approved: boolean): boolean {
    return this.settle(toolCallId, approved);
  }

  /** 决议单一出口：命中即清定时器并出队，未命中返回 false */
  private settle(toolCallId: string, approved: boolean): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    entry.resolve(approved);
    return true;
  }

  /** 会话收尾：作废该会话全部未决审批（resolve false），返回作废数量 */
  voidAll(sessionId: number): number {
    let count = 0;
    for (const [toolCallId, entry] of this.pending) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(entry.timer);
      entry.resolve(false);
      this.pending.delete(toolCallId);
      count += 1;
    }
    return count;
  }
}
