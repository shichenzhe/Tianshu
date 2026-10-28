import { expect, it, vi } from "vitest";
import { makeDispatchMemberTool } from "../../electron/domains/ai/agent/dispatch-member-tool";

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
  expect(modelText).toHaveBeenCalledWith({
    system: "RISK_SYS",
    prompt: expect.stringContaining("评估仓位风险"),
    abortSignal,
  });
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
