import { describe, expect, it } from "vitest";
import {
  applyRemoteChunk,
  failRemoteStream,
  idleRemoteStream,
  liveBlocks,
  startRemoteStream,
} from "./remote-stream";

/**
 * 「applyRemoteChunk 纯归并」两用例搬迁自 mirror tests/ai/server/
 * remote-session.test.tsx（该文件主体为 jsdom 组件测试，不适用移动端，
 * 仅摘纯函数段）；liveBlocks / approval-request 为按源函数行为补的
 * 最小用例（T15 审批入口消费 approval 态）。
 */

describe("applyRemoteChunk 纯归并", () => {
  it("text/thinking/tool-update 增量归并；finish 后迟到 chunk 忽略", () => {
    let state = startRemoteStream();
    state = applyRemoteStream(state, [
      { type: "reasoning-delta", text: "想" },
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "read",
        state: "running",
      },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "read",
        state: "done",
        output: "ok",
      },
    ]);
    expect(state).toMatchObject({
      active: true,
      status: "streaming",
      thinking: "想",
      text: "你好",
      toolOrder: ["t1"],
    });
    expect(state.tools.t1).toMatchObject({ state: "done", output: "ok" });

    state = applyRemoteChunk(state, { type: "finish" });
    expect(state.active).toBe(false);
    expect(state.status).toBe("done");
    // finish 后迟到 delta 不再累积
    state = applyRemoteChunk(state, { type: "text-delta", text: "迟到" });
    expect(state.text).toBe("你好");
  });

  it("failRemoteStream 置错保留部分内容；idle 可直接派生", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, { type: "text-delta", text: "部分" });
    state = failRemoteStream(state, "会话执行失败");
    expect(state).toMatchObject({
      active: false,
      status: "error",
      errorMessage: "会话执行失败",
      text: "部分",
    });
    expect(idleRemoteStream().active).toBe(false);
  });

  it("approval-request 登记 awaiting-approval 条目；后续 tool-update 复用不丢 argSummary", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w1",
      toolName: "write",
      argSummary: "写入 a.txt",
    });
    expect(state.toolOrder).toEqual(["w1"]);
    expect(state.tools.w1).toMatchObject({
      toolCallId: "w1",
      toolName: "write",
      state: "awaiting-approval",
      argSummary: "写入 a.txt",
    });

    state = applyRemoteChunk(state, {
      type: "tool-update",
      toolCallId: "w1",
      toolName: "write",
      state: "done",
      output: "ok",
    });
    expect(state.tools.w1).toMatchObject({
      state: "done",
      argSummary: "写入 a.txt",
    });
  });
});

describe("approvals 审批队列（T15 ApprovalBanner 数据源）", () => {
  it("approval-request FIFO 入队；同 id 重发刷新摘要不重复排队", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w1",
      toolName: "write",
      argSummary: "写入 a.txt",
    });
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w2",
      toolName: "shell",
      argSummary: "rm -rf /tmp/x",
    });
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w1",
      toolName: "write",
      argSummary: "写入 a.txt（重试）",
    });
    expect(state.approvals).toEqual([
      { toolCallId: "w1", toolName: "write", argSummary: "写入 a.txt（重试）" },
      { toolCallId: "w2", toolName: "shell", argSummary: "rm -rf /tmp/x" },
    ]);
  });

  it("tool-update 离开 awaiting-approval 即出队（running=已应答；denied=超时/拒绝）；无关 id 不动队列", () => {
    let state = startRemoteStream();
    for (const [id, tool] of [
      ["w1", "write"],
      ["w2", "shell"],
    ] as const) {
      state = applyRemoteChunk(state, {
        type: "approval-request",
        toolCallId: id,
        toolName: tool,
        argSummary: "s",
      });
    }
    // 本端批准 → running：首项出队，下一项顶上
    state = applyRemoteChunk(state, {
      type: "tool-update",
      toolCallId: "w1",
      toolName: "write",
      state: "running",
    });
    expect(state.approvals.map((a) => a.toolCallId)).toEqual(["w2"]);
    // 他端先应（后到方 banner 收口）→ denied 同样出队
    state = applyRemoteChunk(state, {
      type: "tool-update",
      toolCallId: "w2",
      toolName: "shell",
      state: "denied",
    });
    expect(state.approvals).toEqual([]);
  });

  it("finish/error/failRemoteStream 清空队列；awaiting-approval 的 tool-update 不出队", () => {
    let state = startRemoteStream();
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w1",
      toolName: "write",
      argSummary: "s",
    });
    state = applyRemoteChunk(state, {
      type: "tool-update",
      toolCallId: "w1",
      toolName: "write",
      state: "awaiting-approval",
    });
    expect(state.approvals).toHaveLength(1);

    state = applyRemoteChunk(state, { type: "finish" });
    expect(state.approvals).toEqual([]);

    state = startRemoteStream();
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w2",
      toolName: "shell",
      argSummary: "s",
    });
    state = applyRemoteChunk(state, {
      type: "error",
      errorCode: "5000",
      message: "x",
    });
    expect(state.approvals).toEqual([]);

    state = startRemoteStream();
    state = applyRemoteChunk(state, {
      type: "approval-request",
      toolCallId: "w3",
      toolName: "shell",
      argSummary: "s",
    });
    expect(failRemoteStream(state, "断线").approvals).toEqual([]);
  });
});

describe("liveBlocks 流式块组装", () => {
  it("thinking → tools（按 toolOrder）→ text 顺序组装；缺省字段补空", () => {
    let state = startRemoteStream();
    state = applyRemoteStream(state, [
      { type: "reasoning-delta", text: "思考" },
      {
        type: "tool-update",
        toolCallId: "t2",
        toolName: "search",
        args: { q: "x" },
        state: "running",
      },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "read",
        state: "done",
        output: "ok",
      },
      { type: "text-delta", text: "答案" },
    ]);
    expect(liveBlocks(state)).toEqual([
      { type: "thinking", text: "思考" },
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "search",
        args: { q: "x" },
        state: "running",
      },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read",
        args: {},
        state: "done",
        output: "ok",
      },
      { type: "text", text: "答案" },
    ]);
  });

  it("空闲态无任何块；空段落省略", () => {
    expect(liveBlocks(idleRemoteStream())).toEqual([]);
    // 仅 tool 的流：thinking/text 空串不产块
    let state = startRemoteStream();
    state = applyRemoteChunk(state, {
      type: "tool-update",
      toolCallId: "t1",
      toolName: "read",
      state: "running",
    });
    expect(liveBlocks(state)).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read",
        args: {},
        state: "running",
      },
    ]);
  });
});

/** 批量顺序应用 chunks（纯函数单测便利） */
function applyRemoteStream(
  state: ReturnType<typeof startRemoteStream>,
  chunks: Parameters<typeof applyRemoteChunk>[1][],
) {
  return chunks.reduce((acc, chunk) => applyRemoteChunk(acc, chunk), state);
}
