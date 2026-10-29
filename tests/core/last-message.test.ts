// P1 未读角标批（spec §1.3）：summarizeLastMessage 纯函数全边界——
// 空/坏 JSON/text/image/tool/混合优先级/thinking-only/截断/多 text 拼接/
// createdAt Date|ISO 双形态。kind 优先级 text > image > tool > empty；
// thinking/usage 不参与摘要。经子路径 @tianshu/core/last-message 消费
//（渲染进程禁引包根入口）。
import { describe, expect, it } from "vitest";

import {
  SUMMARY_TEXT_LIMIT,
  summarizeLastMessage,
} from "@tianshu/core/last-message";
import type { SessionLastMessage } from "@tianshu/protocol";

const ISO = "2026-10-26T02:00:00.000Z";

function input(blocks: unknown, overrides = {}) {
  return {
    id: 7,
    role: "assistant",
    blocks: typeof blocks === "string" ? blocks : JSON.stringify(blocks),
    createdAt: ISO,
    ...overrides,
  };
}

describe("summarizeLastMessage（P1 未读角标批 §1.3）", () => {
  it("坏 JSON / 非数组 / 全畸形块 → kind=empty, text=''", () => {
    for (const blocks of [
      "not-json{{",
      '{"type":"text"}',
      '[{"type":"text"}]',
      "[null,42,{}]",
    ]) {
      const summary = summarizeLastMessage(input(blocks));
      expect(summary).toEqual({
        id: 7,
        role: "assistant",
        kind: "empty",
        text: "",
        createdAt: ISO,
      });
    }
  });

  it("仅 thinking/usage 块 → empty（不参与摘要）", () => {
    const summary = summarizeLastMessage(
      input([
        { type: "thinking", text: "推理中" },
        { type: "usage", input: 10, output: 20 },
      ]),
    );
    expect(summary.kind).toBe("empty");
    expect(summary.text).toBe("");
  });

  it("text：全部 text 块 \n 拼接（跨块序保持）", () => {
    const summary = summarizeLastMessage(
      input([
        { type: "text", text: "第一段" },
        { type: "thinking", text: "不参与" },
        { type: "text", text: "第二段" },
      ]),
    );
    expect(summary.kind).toBe("text");
    expect(summary.text).toBe("第一段\n第二段");
  });

  it("text：超 SUMMARY_TEXT_LIMIT 截断加省略号；恰等上限不截断", () => {
    const long = "a".repeat(SUMMARY_TEXT_LIMIT + 10);
    const truncated = summarizeLastMessage(
      input([{ type: "text", text: long }]),
    );
    expect(truncated.text).toBe("a".repeat(SUMMARY_TEXT_LIMIT) + "…");
    const exact = summarizeLastMessage(
      input([{ type: "text", text: "a".repeat(SUMMARY_TEXT_LIMIT) }]),
    );
    expect(exact.text).toBe("a".repeat(SUMMARY_TEXT_LIMIT));
  });

  it("image：text=''（本地化文案在消费端）", () => {
    const summary = summarizeLastMessage(
      input([
        { type: "image", imagePath: "attachments/a.png", mime: "image/png" },
      ]),
    );
    expect(summary.kind).toBe("image");
    expect(summary.text).toBe("");
  });

  it("tool：text=首个 tool_call 的 toolName", () => {
    const summary = summarizeLastMessage(
      input([
        {
          type: "tool_call",
          toolCallId: "tc-1",
          toolName: "write",
          state: "done",
        },
        {
          type: "tool_call",
          toolCallId: "tc-2",
          toolName: "read",
          state: "done",
        },
      ]),
    );
    expect(summary.kind).toBe("tool");
    expect(summary.text).toBe("write");
  });

  it("混合优先级：text > image > tool > empty（非块顺序优先）", () => {
    const textFirst = summarizeLastMessage(
      input([
        { type: "image", imagePath: "a.png", mime: "image/png" },
        { type: "text", text: "后置文本" },
      ]),
    );
    expect(textFirst.kind).toBe("text");
    const imageBeforeTool = summarizeLastMessage(
      input([
        {
          type: "tool_call",
          toolCallId: "tc-1",
          toolName: "write",
          state: "done",
        },
        { type: "image", imagePath: "a.png", mime: "image/png" },
      ]),
    );
    expect(imageBeforeTool.kind).toBe("image");
    expect(imageBeforeTool.text).toBe("");
  });

  it("createdAt：Date 归一 ISO；ISO 字符串直传；id/role 直传", () => {
    const fromDate = summarizeLastMessage(
      input([{ type: "text", text: "hi" }], {
        createdAt: new Date("2026-10-26T02:00:00.000Z"),
      }),
    );
    expect(fromDate.createdAt).toBe(ISO);
    const fromString = summarizeLastMessage(
      input([{ type: "text", text: "hi" }], {
        id: 42,
        role: "user",
        createdAt: ISO,
      }),
    );
    expect(fromString.id).toBe(42);
    expect(fromString.role).toBe("user");
    expect(fromString.createdAt).toBe(ISO);
  });

  it("输出形状 = SessionLastMessage wire 契约", () => {
    const summary: SessionLastMessage = summarizeLastMessage(
      input([{ type: "text", text: "hi" }]),
    );
    expect(Object.keys(summary).sort()).toEqual(
      ["createdAt", "id", "kind", "role", "text"].sort(),
    );
  });
});
