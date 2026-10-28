import { describe, expect, it } from "vitest";

import type { SessionLastMessage } from "@tianshu/protocol";

import { lastMessageSummary } from "./last-message-summary";

/** key 回显 t：断言本地化 key 与插值（真实文案见 locales chat namespace） */
const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const base: SessionLastMessage = {
  id: 1,
  role: "assistant",
  kind: "empty",
  text: "",
  createdAt: "2026-10-26T01:00:00.000Z",
};

describe("lastMessageSummary（P1 未读角标批）", () => {
  it("text：直显原文（截断由渲染层 numberOfLines 承担）", () => {
    expect(
      lastMessageSummary({ ...base, kind: "text", text: "末条答复" }, t),
    ).toBe("末条答复");
  });

  it("image/tool/empty：本地化前缀映射（tool 带 toolName 插值）", () => {
    expect(lastMessageSummary({ ...base, kind: "image" }, t)).toBe(
      "chat:lastMsgImage",
    );
    expect(
      lastMessageSummary({ ...base, kind: "tool", text: "run_command" }, t),
    ).toBe('chat:lastMsgTool:{"name":"run_command"}');
    expect(lastMessageSummary({ ...base, kind: "empty" }, t)).toBe(
      "chat:lastMsgEmpty",
    );
  });
});
