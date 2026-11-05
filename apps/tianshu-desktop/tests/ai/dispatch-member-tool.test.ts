import { describe, expect, it, vi } from "vitest";
import {
  makeDispatchMemberTool,
  makeMemberCallRecorder,
  withMemberReportBlocks,
} from "../../electron/domains/ai/agent/dispatch-member-tool";
import type { MessageBlock } from "@tianshu/protocol";

const members = [
  {
    id: "macro-analyst",
    name: "顾大局",
    profession: "宏观分析师",
    systemPrompt: "MACRO_SYS",
  },
  {
    id: "risk-officer",
    name: "严守仓",
    profession: "风控官",
    systemPrompt: "RISK_SYS",
  },
];

function makeDeps() {
  const modelText = vi.fn().mockResolvedValue("成员产出");
  const abortSignal = new AbortController().signal;
  return { modelText, abortSignal };
}

it("调度成员：modelText 收到成员 systemPrompt 与任务上下文，返回产出", async () => {
  const { modelText, abortSignal } = makeDeps();
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  const out = await tool.execute(
    {} as never,
    {
      member: "risk-officer",
      task: "评估仓位风险",
      context: "前情结论",
    } as never,
  );
  expect(out).toBe("成员产出");
  expect(modelText).toHaveBeenCalledWith(
    expect.objectContaining({
      system: "RISK_SYS",
      prompt: expect.stringContaining("评估仓位风险"),
      abortSignal,
    }),
  );
  expect(modelText.mock.calls[0][0].prompt).toContain("前情结论");
});

it("成员不存在返回错误文案（含可用 id）", async () => {
  const { modelText, abortSignal } = makeDeps();
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  const out = await tool.execute(
    {} as never,
    { member: "nope", task: "x" } as never,
  );
  expect(out).toContain("错误");
  expect(out).toContain("macro-analyst");
  expect(modelText).not.toHaveBeenCalled();
});

it("modelText 异常 catch 为错误文案不抛出", async () => {
  const { modelText, abortSignal } = makeDeps();
  modelText.mockRejectedValue(new Error("超时"));
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  const out = await tool.execute(
    {} as never,
    {
      member: "macro-analyst",
      task: "x",
    } as never,
  );
  expect(out).toContain("顾大局").toContain("超时");
});

it("kind read（免审批）", () => {
  const { modelText, abortSignal } = makeDeps();
  expect(makeDispatchMemberTool({ members, modelText, abortSignal }).kind).toBe(
    "read",
  );
});

it("modelText 入参携带 onUsage 回调（用量回报注入面）", async () => {
  const { modelText, abortSignal } = makeDeps();
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  await tool.execute(
    {} as never,
    { member: "risk-officer", task: "x" } as never,
  );
  const args = modelText.mock.calls[0][0] as {
    onUsage?: (u: { inputTokens: number; outputTokens: number }) => void;
  };
  expect(typeof args.onUsage).toBe("function");
});

describe("onMemberCall 埋点（专家团可观测性批）", () => {
  it("成功补全上报成员名/轮次/耗时，onUsage 用量随报", async () => {
    const { modelText, abortSignal } = makeDeps();
    const onMemberCall = vi.fn();
    const tool = makeDispatchMemberTool({
      members,
      modelText,
      abortSignal,
      onMemberCall,
    });
    await tool.execute(
      {} as never,
      { member: "risk-officer", task: "评估" } as never,
    );
    const event = onMemberCall.mock.calls[0][0];
    expect(event.memberId).toBe("risk-officer");
    expect(event.memberName).toBe("严守仓");
    expect(event.round).toBe(1);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    // modelText stub 未回报用量 → usage 缺席（不造假 0）
    expect(event.inputTokens).toBeUndefined();
  });

  it("onUsage 回报后随事件携带 usage", async () => {
    const { modelText, abortSignal } = makeDeps();
    const onMemberCall = vi.fn();
    modelText.mockImplementation(async (args: { onUsage?: (u: unknown) => void }) => {
      args.onUsage?.({ inputTokens: 120, outputTokens: 80 });
      return "成员产出";
    });
    const tool = makeDispatchMemberTool({
      members,
      modelText,
      abortSignal,
      onMemberCall,
    });
    await tool.execute(
      {} as never,
      { member: "macro-analyst", task: "x" } as never,
    );
    const event = onMemberCall.mock.calls[0][0];
    expect(event.inputTokens).toBe(120);
    expect(event.outputTokens).toBe(80);
  });

  it("同一工具实例多次调度轮次递增（每请求构造计数器）", async () => {
    const { modelText, abortSignal } = makeDeps();
    const onMemberCall = vi.fn();
    const tool = makeDispatchMemberTool({
      members,
      modelText,
      abortSignal,
      onMemberCall,
    });
    await tool.execute(
      {} as never,
      { member: "macro-analyst", task: "a" } as never,
    );
    await tool.execute(
      {} as never,
      { member: "risk-officer", task: "b" } as never,
    );
    expect(onMemberCall.mock.calls.map((c) => c[0].round)).toEqual([1, 2]);
    expect(onMemberCall.mock.calls.map((c) => c[0].memberName)).toEqual([
      "顾大局",
      "严守仓",
    ]);
  });

  it("成员不存在/补全异常不上报（失败经 toolCallEvent 通用路径）", async () => {
    const { modelText, abortSignal } = makeDeps();
    const onMemberCall = vi.fn();
    const tool = makeDispatchMemberTool({
      members,
      modelText,
      abortSignal,
      onMemberCall,
    });
    await tool.execute({} as never, { member: "nope", task: "x" } as never);
    modelText.mockRejectedValue(new Error("超时"));
    await tool.execute(
      {} as never,
      { member: "macro-analyst", task: "x" } as never,
    );
    expect(onMemberCall).not.toHaveBeenCalled();
  });

  it("onMemberCall 缺席时正常调度（埋点可选）", async () => {
    const { modelText, abortSignal } = makeDeps();
    const out = await makeDispatchMemberTool({
      members,
      modelText,
      abortSignal,
    }).execute({} as never, { member: "macro-analyst", task: "x" } as never);
    expect(out).toBe("成员产出");
  });
});

describe("makeMemberCallRecorder（llmCallEvent meta 行构造）", () => {
  it("usage 在场才记，meta 含成员名/轮次", async () => {
    const create = vi.fn(async () => ({}));
    const recorder = makeMemberCallRecorder({
      prisma: { llmCallEvent: { create } },
      userId: 7,
      sessionId: 3,
      modelId: 5,
    });
    recorder({
      memberId: "macro-analyst",
      memberName: "顾大局",
      round: 2,
      durationMs: 900,
      inputTokens: 100,
      outputTokens: 40,
    });
    // usage 缺席不记（不造假 0 token）
    recorder({
      memberId: "risk-officer",
      memberName: "严守仓",
      round: 3,
      durationMs: 10,
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      userId: 7,
      sessionId: 3,
      modelId: 5,
      scene: "chat",
      inputTokens: 100,
      outputTokens: 40,
    });
    expect(JSON.parse(String(data.meta))).toEqual({
      kind: "member",
      member: "顾大局",
      round: 2,
    });
  });
});

describe("withMemberReportBlocks（成员产出落块）", () => {
  const dispatchBlock = (
    toolCallId: string,
    args: Record<string, unknown>,
    output: string,
    state: "done" | "error" = "done",
  ): MessageBlock => ({
    type: "tool_call",
    toolCallId,
    toolName: "dispatch",
    args,
    state,
    output,
  });

  it("done 态 dispatch 块后插 memberReport（成员名经清单解析，轮次递增）", () => {
    const blocks = withMemberReportBlocks(
      [
        { type: "text", text: "分头调研" },
        dispatchBlock(
          "t1",
          { member: "macro-analyst", task: "看宏观" },
          "宏观结论",
        ),
        { type: "text", text: "继续" },
        dispatchBlock(
          "t2",
          { member: "risk-officer", task: "查风险" },
          "风险结论",
        ),
      ],
      members,
    );
    expect(blocks).toEqual([
      { type: "text", text: "分头调研" },
      dispatchBlock(
        "t1",
        { member: "macro-analyst", task: "看宏观" },
        "宏观结论",
      ),
      {
        type: "memberReport",
        memberName: "顾大局",
        task: "看宏观",
        content: "宏观结论",
        round: 1,
      },
      { type: "text", text: "继续" },
      dispatchBlock(
        "t2",
        { member: "risk-officer", task: "查风险" },
        "风险结论",
      ),
      {
        type: "memberReport",
        memberName: "严守仓",
        task: "查风险",
        content: "风险结论",
        round: 2,
      },
    ]);
  });

  it("error 态与非 dispatch 工具块不落 memberReport", () => {
    const blocks = withMemberReportBlocks(
      [
        dispatchBlock(
          "t1",
          { member: "macro-analyst", task: "x" },
          "错误: 成员执行失败",
          "error",
        ),
        {
          type: "tool_call" as const,
          toolCallId: "t2",
          toolName: "read",
          args: {},
          state: "done" as const,
          output: "内容",
        },
      ],
      members,
    );
    expect(blocks.filter((b) => b.type === "memberReport")).toEqual([]);
  });

  it("成员 id 不在清单回退 id 原文；无 output 的 done 块跳过", () => {
    const blocks = withMemberReportBlocks(
      [
        dispatchBlock("t1", { member: "ghost", task: "y" }, "产出"),
        dispatchBlock("t2", { member: "macro-analyst", task: "z" }, undefined),
      ],
      members,
    );
    const reports = blocks.filter(
      (b): b is Extract<MessageBlock, { type: "memberReport" }> =>
        b.type === "memberReport",
    );
    expect(reports).toEqual([
      {
        type: "memberReport",
        memberName: "ghost",
        task: "y",
        content: "产出",
        round: 1,
      },
    ]);
  });

  it("无 dispatch 块原样返回（新数组，不改入参）", () => {
    const input: MessageBlock[] = [{ type: "text", text: "纯回答" }];
    const blocks = withMemberReportBlocks(input, members);
    expect(blocks).toEqual(input);
    expect(blocks).not.toBe(input);
  });
});
