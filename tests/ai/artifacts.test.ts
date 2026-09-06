/**
 * 产物面板文件派生测试:write_file 收录/引用前缀解析/去重/流式合并
 */
import { describe, expect, it } from "vitest";

import { deriveSessionFiles } from "@/domains/ai/chat/lib/artifacts";
import {
  serializeBlocks,
  type MessageBlock,
  type ToolCallBlock,
} from "@/domains/ai/chat/model/blocks";
import type { MessageRecord } from "@/domains/ai/api/session.api";
import type { ToolStreamMap } from "@/domains/ai/chat/store/chat.store";

function msg(
  id: number,
  role: "user" | "assistant",
  blocks: MessageBlock[],
): MessageRecord {
  return {
    id,
    sessionId: 1,
    role,
    blocks: serializeBlocks(blocks),
    createdAt: "2026-09-06T00:00:00.000Z",
  };
}

function writeCall(
  path: string,
  state: ToolCallBlock["state"] = "done",
): ToolCallBlock {
  return {
    type: "tool_call",
    toolCallId: `call-${path}-${state}`,
    toolName: "write_file",
    args: { path, content: "x" },
    state,
  };
}

function streamTools(
  entries: Array<{ state: string; path?: string; toolName?: string }>,
): ToolStreamMap {
  return {
    order: entries.map((_, i) => `t${i}`),
    map: Object.fromEntries(
      entries.map((e, i) => [
        `t${i}`,
        {
          toolName: e.toolName ?? "write_file",
          args: e.path === undefined ? undefined : { path: e.path },
          state: e.state,
        },
      ]),
    ),
  };
}

describe("deriveSessionFiles", () => {
  it("无消息返回空数组", () => {
    expect(deriveSessionFiles([])).toEqual([]);
  });

  it("write_file done 收录为产物文件", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [writeCall("src/a.ts")]),
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", group: "artifact", status: "written", messageId: 1 },
    ]);
  });

  it("write_file denied/error 不收录（未写成功）", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [
        writeCall("a.ts", "denied"),
        writeCall("b.ts", "error"),
      ]),
    ]);
    expect(files).toEqual([]);
  });

  it("非 write_file 工具忽略", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "read_file",
          args: { path: "a.ts" },
          state: "done",
        },
      ]),
    ]);
    expect(files).toEqual([]);
  });

  it("user 消息引用前缀解析为工作空间文件（多文件）", () => {
    const files = deriveSessionFiles([
      msg(2, "user", [
        {
          type: "text",
          text: "[引用文件 readme.md]\n内容A\n\n[引用文件 docs/guide.md]\n内容B\n\n正题",
        },
      ]),
    ]);
    expect(files).toEqual([
      {
        path: "docs/guide.md",
        group: "workspace",
        status: "written",
        messageId: 2,
      },
      {
        path: "readme.md",
        group: "workspace",
        status: "written",
        messageId: 2,
      },
    ]);
  });

  it("引用技能前缀与 assistant 文本不解析", () => {
    const files = deriveSessionFiles([
      msg(1, "user", [{ type: "text", text: "[引用技能 skill-a]\n正文" }]),
      msg(2, "assistant", [{ type: "text", text: "[引用文件 fake.md]\n回复" }]),
    ]);
    expect(files).toEqual([]);
  });

  it("同 path 跨组去重取源消息最新者", () => {
    const files = deriveSessionFiles([
      msg(1, "user", [{ type: "text", text: "[引用文件 a.md]\n旧" }]),
      msg(3, "assistant", [writeCall("a.md")]),
    ]);
    expect(files).toEqual([
      { path: "a.md", group: "artifact", status: "written", messageId: 3 },
    ]);
  });

  it("同组同 path 重复写入取最新消息", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [writeCall("a.ts")]),
      msg(5, "assistant", [writeCall("a.ts")]),
    ]);
    expect(files).toEqual([
      { path: "a.ts", group: "artifact", status: "written", messageId: 5 },
    ]);
  });

  it("流式 running 合并为 writing 且置顶", () => {
    const files = deriveSessionFiles(
      [msg(1, "assistant", [writeCall("old.ts")])],
      streamTools([{ state: "running", path: "new.ts" }]),
    );
    expect(files).toEqual([
      { path: "new.ts", group: "artifact", status: "writing", messageId: -1 },
      { path: "old.ts", group: "artifact", status: "written", messageId: 1 },
    ]);
  });

  it("流式 done 覆盖历史同 path 为 written", () => {
    const files = deriveSessionFiles(
      [msg(1, "user", [{ type: "text", text: "[引用文件 a.md]\n旧" }])],
      streamTools([{ state: "done", path: "a.md" }]),
    );
    expect(files).toEqual([
      { path: "a.md", group: "artifact", status: "written", messageId: -1 },
    ]);
  });

  it("流式 denied/error 与 args 缺 path 忽略", () => {
    const files = deriveSessionFiles(
      [],
      streamTools([
        { state: "denied", path: "a.ts" },
        { state: "error", path: "b.ts" },
        { state: "running" },
        { state: "running", path: "", toolName: "write_file" },
      ]),
    );
    expect(files).toEqual([]);
  });
});
