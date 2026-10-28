// T17 审批队列派生：pendingApprovals（FIFO / 同 id 去重刷新 /
// tool-update 离开 awaiting-approval 出队 / finish-error 清空——入队与
// 状态迁移经 applyRemoteChunk 收口，此处验证派生口径）+
// unrespondedApprovals（本端已应答过滤，队列推进不等 tool-update 往返）
import { describe, expect, it } from "vitest";

import type { ChatStreamChunk } from "../../../src-react/domains/ai/api/chat.api";
import {
  applyRemoteChunk,
  failRemoteStream,
  startRemoteStream,
} from "../../../src-react/domains/ai/server/lib/remote-stream";
import {
  pendingApprovals,
  unrespondedApprovals,
} from "../../../src-react/domains/ai/server/lib/approval-queue";

type ToolStateValue = Extract<
  ChatStreamChunk,
  { type: "tool-update" }
>["state"];

const approval = (toolCallId: string, argSummary: string): ChatStreamChunk => ({
  type: "approval-request",
  toolCallId,
  toolName: "write_file",
  argSummary,
});

const toolUpdate = (
  toolCallId: string,
  state: ToolStateValue,
): ChatStreamChunk => ({
  type: "tool-update",
  toolCallId,
  toolName: "write_file",
  state,
});

describe("pendingApprovals 队列派生", () => {
  it("FIFO 入队；同 toolCallId 重发刷新 argSummary 不重复排队", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, approval("w1", "写入 a.txt"));
    state = applyRemoteChunk(state, approval("w2", "写入 b.txt"));
    state = applyRemoteChunk(state, approval("w1", "写入 a.txt（重发）"));
    expect(pendingApprovals(state)).toEqual([
      {
        toolCallId: "w1",
        toolName: "write_file",
        argSummary: "写入 a.txt（重发）",
      },
      { toolCallId: "w2", toolName: "write_file", argSummary: "写入 b.txt" },
    ]);
  });

  it("tool-update 离开 awaiting-approval 即出队（running 与终态同口径）；无关 id 不动", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, approval("w1", "写 a"));
    state = applyRemoteChunk(state, approval("w2", "写 b"));
    // 无关工具（未经审批的普通工具）不扰动队列
    state = applyRemoteChunk(state, toolUpdate("r1", "running"));
    expect(pendingApprovals(state).map((i) => i.toolCallId)).toEqual([
      "w1",
      "w2",
    ]);
    // 本端已应答（running）即刻收起，不等工具跑完
    state = applyRemoteChunk(state, toolUpdate("w1", "running"));
    expect(pendingApprovals(state).map((i) => i.toolCallId)).toEqual(["w2"]);
    // 超时自动拒/他端拒绝（denied 终态）出队
    state = applyRemoteChunk(state, toolUpdate("w2", "denied"));
    expect(pendingApprovals(state)).toEqual([]);
  });

  it("finish / error chunk / session.error 事件清空（流收场后挂起审批不可再应答）", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, approval("w1", "写 a"));
    state = applyRemoteChunk(state, { type: "finish" });
    expect(pendingApprovals(state)).toEqual([]);

    state = startRemoteStream();
    state = applyRemoteChunk(state, approval("w2", "写 b"));
    state = applyRemoteChunk(state, {
      type: "error",
      errorCode: "E",
      message: "执行失败",
    });
    expect(pendingApprovals(state)).toEqual([]);

    state = startRemoteStream();
    state = applyRemoteChunk(state, approval("w3", "写 c"));
    state = failRemoteStream(state, "会话执行失败");
    expect(pendingApprovals(state)).toEqual([]);
  });

  it("空闲（null）与无挂起审批的流不出队面", () => {
    expect(pendingApprovals(null)).toEqual([]);
    let state = startRemoteStream();
    state = applyRemoteChunk(state, toolUpdate("r1", "done"));
    expect(pendingApprovals(state)).toEqual([]);
  });
});

describe("unrespondedApprovals 本端已应答过滤", () => {
  it("滤除已应答 toolCallId，队列下一项即刻顶上", () => {
    const pending = [
      { toolCallId: "w1", toolName: "write_file", argSummary: "a" },
      { toolCallId: "w2", toolName: "write_file", argSummary: "b" },
    ];
    expect(unrespondedApprovals(pending, new Set(["w1"]))).toEqual([
      pending[1],
    ]);
    expect(unrespondedApprovals(pending, new Set())).toEqual(pending);
  });
});
