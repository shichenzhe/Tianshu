/**
 * 确认卡协调器（confirm_form 工具挂起等待渲染层决议，ApprovalCoordinator
 * 同构先例）：键控 sessionId——聊天流内 execute 阻塞整条流，一次会话同时
 * 至多一张待确认卡（天然单飞，新请求覆盖旧挂起）；超时自动取消（10 分钟
 * 同审批口径，防流悬挂）；决议载荷带用户编辑后的表单值（区别于审批的
 * 布尔）。模块级单例（graph-inflight 先例——chat.service 的 IPC 决议与
 * 工具 execute 共享，纯 Node 零 electron 依赖，vitest 直测。
 */
import type { ToolContext } from "./file-tools";

/** 待确认卡载荷（渲染层 ConfirmFormCard 消费；凭据类内容勿入——
 *  confirm_form 只用于工作流输入参数确认） */
export interface ConfirmFormPayload {
  workflowId: number;
  workflowName: string;
  title?: string;
  fields: Array<{ key: string; label: string; value: string; hint?: string }>;
}

/** 决议：confirm 携带编辑后的字段值（key → string）；cancel 即弃 */
export type ConfirmFormDecision =
  { action: "confirm"; values: Record<string, string> } | { action: "cancel" };

/** 缺省挂起上限：10 分钟无应答自动取消（对齐 ApprovalCoordinator） */
export const CONFIRM_FORM_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingEntry {
  resolve: (decision: ConfirmFormDecision) => void;
  timer: NodeJS.Timeout;
}

/** 决议参数（渲染层 IPC → chat.service 转发） */
export interface ConfirmRespondParams {
  sessionId: number;
  decision: ConfirmFormDecision;
}

export class ConfirmFormCoordinator {
  private pending = new Map<number, PendingEntry>();

  get pendingCount(): number {
    return this.pending.size;
  }

  request(
    sessionId: number,
    payload: ConfirmFormPayload,
    timeoutMs: number = CONFIRM_FORM_TIMEOUT_MS,
  ): Promise<ConfirmFormDecision> {
    void payload;
    return new Promise((resolve) => {
      // 同会话旧挂起先作废（覆盖式单飞；流中止另有 voidAll 兜底）
      this.settle(sessionId, { action: "cancel" });
      const timer = setTimeout(
        () => this.settle(sessionId, { action: "cancel" }),
        timeoutMs,
      );
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(sessionId, { resolve, timer });
    });
  }

  respond(sessionId: number, decision: ConfirmFormDecision): boolean {
    return this.settle(sessionId, decision);
  }

  /** 决议单一出口：命中即清定时器并出队，未命中返回 false */
  private settle(sessionId: number, decision: ConfirmFormDecision): boolean {
    const entry = this.pending.get(sessionId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    entry.resolve(decision);
    return true;
  }

  /** 中断/窗口销毁：作废全部（resolve cancel），返回作废数量 */
  voidAll(): number {
    const count = this.pending.size;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ action: "cancel" });
    }
    this.pending.clear();
    return count;
  }
}

/** 上下文工具签名（execute 消费；与 file-tools ToolDefinition 对齐） */
export type ToolCtx = ToolContext;

/** 进程级单例（工具 execute 与 chat.service IPC 决议共享） */
export const confirmForms = new ConfirmFormCoordinator();
