import { describe, expect, it } from "vitest";
import {
  groupBlocks,
  summarizeThinking,
} from "../../src-react/domains/ai/chat/lib/group-blocks";
import type { MessageBlock } from "../../src-react/domains/ai/chat/model/blocks";

describe("groupBlocks 过程/结论分组", () => {
  it("thinking 块按序拼接、tool_call 保序、text 保序、usage 保留在 texts", () => {
    const blocks: MessageBlock[] = [
      { type: "thinking", text: "先想第一步" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
        args: { path: "/tmp/a.md" },
        state: "done",
      },
      { type: "thinking", text: "再想第二步" },
      { type: "text", text: "最终答案" },
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "run_command",
        args: { command: "ls" },
        state: "error",
        output: "boom",
      },
      { type: "text", text: "补充说明" },
      { type: "usage", input: 10, output: 20 },
    ];

    const grouped = groupBlocks(blocks);
    expect(grouped.thinkingText).toBe("先想第一步\n\n再想第二步");
    expect(grouped.tools.map((tool) => tool.toolName)).toEqual([
      "read_file",
      "run_command",
    ]);
    expect(grouped.tools[1]).toMatchObject({ state: "error", output: "boom" });
    expect(grouped.texts.map((b) => b.text)).toEqual(["最终答案", "补充说明"]);
    expect(grouped.usage).toMatchObject({ input: 10, output: 20 });
  });

  it("无 thinking/tools 时 thinkingText 为空串、tools 为空数组", () => {
    const grouped = groupBlocks([
      { type: "text", text: "只有正文" },
      { type: "usage", input: 1, output: 2 },
    ]);
    expect(grouped.thinkingText).toBe("");
    expect(grouped.tools).toEqual([]);
    expect(grouped.hasProcess).toBe(false);
  });

  it("含过程块时 hasProcess 为 true", () => {
    expect(
      groupBlocks([{ type: "thinking", text: "想一想" }]).hasProcess,
    ).toBe(true);
    expect(
      groupBlocks([
        {
          type: "tool_call",
          toolCallId: "t",
          toolName: "x",
          args: {},
          state: "done",
        },
      ]).hasProcess,
    ).toBe(true);
  });
});

describe("summarizeThinking 折叠摘要", () => {
  it("短文本原样返回", () => {
    expect(summarizeThinking("我来梳理一下思路。")).toBe(
      "我来梳理一下思路。",
    );
  });

  it("按首个句末标点截断(。!?英文句号)", () => {
    const text =
      "我先看看资料库里的文件。接下来读取配置并逐项核对每一条细节内容";
    expect(summarizeThinking(text)).toBe("我先看看资料库里的文件。");
  });

  it("无句读长文本硬截 96 字符加省略号", () => {
    const text = "字".repeat(200);
    const summary = summarizeThinking(text);
    expect(summary).toHaveLength(97); // 96 字符 + …
    expect(summary.endsWith("…")).toBe(true);
  });
});
