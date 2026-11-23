// src-react/domains/ai/automation/lib/run-draft-store.ts
/**
 * 按次运行追问草稿（spec 2026-11-23 §2 设计者裁定）：未发送草稿按
 * runId 各自保存——切走再切回可恢复，但绝不携带到另一运行（避免误发
 * 到错误的运行上下文）。模块级 Map 进程内驻留（不落库、不跨窗口）；
 * FIFO 上限 50 条（第 51 条写入淘汰最旧插入的 runId）；空串删除条目
 * （与 ChatPane/ChatInput 的 onDraftUnmount 卸载上报语义对齐：清空即弃）。
 */
const MAX_DRAFTS = 50;

const drafts = new Map<number, string>();

/** 读取该运行的未发送草稿；未写入返回空串（ChatInput initialDraft 缺省口径） */
export function getRunDraft(runId: number): string {
  return drafts.get(runId) ?? "";
}

/** 回写该运行的草稿：空串删除条目；超上限时淘汰最旧插入的条目（纯
 * FIFO——重写已有 runId 不刷新其插入位，Map 迭代序即淘汰序） */
export function setRunDraft(runId: number, text: string): void {
  if (text === "") {
    drafts.delete(runId);
    return;
  }
  if (!drafts.has(runId) && drafts.size >= MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest !== undefined) {
      drafts.delete(oldest);
    }
  }
  drafts.set(runId, text);
}
