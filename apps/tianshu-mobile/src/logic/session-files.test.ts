import { describe, expect, it } from "vitest";

import { deriveSessionFiles, type HistoryMessage } from "./session-files";
import type { RemoteStreamState } from "./remote-stream";

function msg(
  id: number,
  role: string,
  blocks: Array<Record<string, unknown>>,
): HistoryMessage {
  return { id, role, blocks: blocks as unknown as HistoryMessage["blocks"] };
}

function makeLive(tools: Record<string, unknown>, order: string[]) {
  return {
    active: true,
    status: "streaming",
    text: "",
    thinking: "",
    toolOrder: order,
    tools,
    approvals: [],
  } as unknown as RemoteStreamState;
}

describe("deriveSessionFiles", () => {
  it("write done → 产物文件 written", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write",
          args: { path: "/w/out/a.md" },
          state: "done",
        },
      ]),
    ];
    expect(deriveSessionFiles(history)).toEqual([
      {
        path: "/w/out/a.md",
        group: "artifact",
        status: "written",
        messageId: 1,
      },
    ]);
  });

  it("write denied/error 与 args 缺失不收录", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write",
          args: { path: "/w/a.md" },
          state: "denied",
        },
        {
          type: "tool_call",
          toolCallId: "t2",
          toolName: "write",
          args: {},
          state: "done",
        },
      ]),
    ];
    expect(deriveSessionFiles(history)).toEqual([]);
  });

  it("user [引用文件 x] 行 → 工作空间文件", () => {
    const history = [
      msg(2, "user", [{ type: "text", text: "[引用文件 /w/b.md]\n问题如下" }]),
    ];
    expect(deriveSessionFiles(history)).toEqual([
      {
        path: "/w/b.md",
        group: "workspace",
        status: "written",
        messageId: 2,
      },
    ]);
  });

  it("live running → writing 置顶；done → written 覆盖同 path 历史", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write",
          args: { path: "/w/a.md" },
          state: "done",
        },
      ]),
    ];
    const live = makeLive(
      {
        t2: { toolCallId: "t2", toolName: "write", args: { path: "/w/c.md" }, state: "running" },
      },
      ["t2"],
    );
    const files = deriveSessionFiles(history, live);
    expect(files[0]).toEqual({
      path: "/w/c.md",
      group: "artifact",
      status: "writing",
      messageId: -1,
    });
    expect(files).toHaveLength(2);
  });

  it("同 path 历史去重取源消息 id 较大者，按 id 降序输出", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write",
          args: { path: "/w/a.md" },
          state: "done",
        },
      ]),
      msg(5, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t2",
          toolName: "write",
          args: { path: "/w/a.md" },
          state: "done",
        },
      ]),
    ];
    expect(deriveSessionFiles(history)).toEqual([
      {
        path: "/w/a.md",
        group: "artifact",
        status: "written",
        messageId: 5,
      },
    ]);
  });

  it("空历史返回空数组", () => {
    expect(deriveSessionFiles([])).toEqual([]);
  });
});
