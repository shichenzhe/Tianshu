// tests/ai/graph-prompt.test.ts
import { describe, expect, it } from "vitest";
import { renderNodePrompt } from "../../electron/domains/ai/orchestration/graph-prompt";

const now = new Date("2026-10-03T09:05:00");

describe("renderNodePrompt", () => {
  it("input / nodes / 日期变量全替换", () => {
    expect(
      renderNodePrompt(
        "{{input.topic}} + {{nodes.research.output}} @ {{date}} {{weekday}} {{time}}",
        {
          inputs: { topic: "日报" },
          nodes: { research: { output: "结论" } },
          now,
        },
      ),
    ).toBe("日报 + 结论 @ 2026-10-03 六 09:05");
  });
  it("未定义 input 引用抛 template_ref_missing", () => {
    expect(() =>
      renderNodePrompt("{{input.nope}}", { inputs: {}, nodes: {}, now }),
    ).toThrowError(/input\.nope/);
  });
  it("未定义 nodes 引用抛 template_ref_missing", () => {
    expect(() =>
      renderNodePrompt("{{nodes.ghost.output}}", {
        inputs: {},
        nodes: {},
        now,
      }),
    ).toThrowError(/nodes\.ghost\.output/);
  });
  it("无变量原样返回", () => {
    expect(renderNodePrompt("plain", { inputs: {}, nodes: {}, now })).toBe(
      "plain",
    );
  });
  it("{{nodes.x.errorOutput}} 渲染死信输出；无失败未设时抛错", () => {
    expect(
      renderNodePrompt("{{nodes.a.errorOutput}}", {
        inputs: {},
        nodes: { a: { output: "ok", errorOutput: "#1 boom" } },
        now,
      }),
    ).toBe("#1 boom");
    expect(() =>
      renderNodePrompt("{{nodes.a.errorOutput}}", {
        inputs: {},
        nodes: { a: { output: "ok" } },
        now,
      }),
    ).toThrowError(/nodes\.a\.errorOutput/);
  });
});
