/**
 * buildInjectedContent 纯函数单测（自 ChatPane/ProjectChatBar handleSend
 * 内联前缀拼装迁移，行为逐字节不变；新建任务 dispatch 同口径复用）。
 * 断言字符串与 tests/project/project-chat-bar.test.tsx 的发送 content 断言一致
 */
import { describe, expect, it } from "vitest";

import { buildInjectedContent } from "@/domains/ai/chat/lib/build-injected-content";

describe("buildInjectedContent", () => {
  it("无引用原样返回（不追加空行）", () => {
    expect(buildInjectedContent("正文", [])).toBe("正文");
  });

  it("文件引用（含本地文件）：逐引用前缀块 + 原文，块间 \\n\\n 分隔", () => {
    expect(
      buildInjectedContent("正文", [
        { path: "docs/a.md", content: "AAA" },
        { path: "/tmp/b.md", content: "BBB", kind: "localFile" },
      ]),
    ).toBe("[引用文件 docs/a.md]\nAAA\n\n[引用文件 /tmp/b.md]\nBBB\n\n正文");
  });

  it("技能/待办引用用专属前缀（与普通文件区分）", () => {
    expect(
      buildInjectedContent("正文", [
        { path: "联网搜索", content: "BBB", kind: "skill" },
        { path: "待办#5", content: "【待办】调研｜状态:待开始", kind: "todo" },
      ]),
    ).toBe(
      "[引用技能 联网搜索]\nBBB\n\n[引用待办 待办#5]\n【待办】调研｜状态:待开始\n\n正文",
    );
  });

  it("引用式（fileRef）：仅路径行 + read_file 指示，不拼内容、无尾随空行", () => {
    expect(
      buildInjectedContent("正文", [
        { path: "src/main.ts", content: "", kind: "fileRef" },
      ]),
    ).toBe(
      "[引用文件 src/main.ts]（请用 read_file 工具读取该文件后处理）\n\n正文",
    );
    // content 忽略（即便误传）——引用式块恒为单行
    expect(
      buildInjectedContent("正文", [
        { path: "a.ts", content: "不该出现", kind: "fileRef" },
        { path: "b.ts", content: "B" },
      ]),
    ).toBe(
      "[引用文件 a.ts]（请用 read_file 工具读取该文件后处理）\n\n" +
        "[引用文件 b.ts]\nB\n\n正文",
    );
  });
});
