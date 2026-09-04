/**
 * 审批协调器：write 工具挂起等待渲染层决议（P1 spec §1 审批挂起）
 */
type Resolver = (approved: boolean) => void;

export class ApprovalCoordinator {
  private pending = new Map<string, Resolver>();

  get pendingCount(): number {
    return this.pending.size;
  }

  request(toolCallId: string, _argSummary: string): Promise<boolean> {
    // _argSummary 供后续渲染层审批弹窗展示，协调器自身不存储
    void _argSummary;
    return new Promise<boolean>((resolve) => {
      this.pending.set(toolCallId, resolve);
    });
  }

  respond(toolCallId: string, approved: boolean): boolean {
    const resolve = this.pending.get(toolCallId);
    if (!resolve) {
      return false;
    }
    this.pending.delete(toolCallId);
    resolve(approved);
    return true;
  }

  /** 中断/窗口销毁：作废全部（resolve false），返回作废数量 */
  voidAll(): number {
    const count = this.pending.size;
    for (const resolve of this.pending.values()) {
      resolve(false);
    }
    this.pending.clear();
    return count;
  }
}
