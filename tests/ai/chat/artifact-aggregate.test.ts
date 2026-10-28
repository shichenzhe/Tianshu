/**
 * 全局产物聚合单测（资料库「本地产物」视图）：write_file(state=done)
 * 提取、状态过滤、同文件跨会话去重取最新、相对/绝对路径 resolve、
 * 无目录工作空间跳过、排序（写入时间降序）、畸形 blocks 容错。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  aggregateArtifacts,
  type ArtifactMessageRow,
} from "../../../electron/domains/ai/chat/artifact-aggregate";

const WS = new Map([
  [1, { name: "空间一", directoryPath: "/tmp/ws-a" }],
  [2, { name: "空间二", directoryPath: null }],
]);
const TITLES = new Map([
  [10, "会话甲"],
  [11, "会话乙"],
]);

function row(partial: Partial<ArtifactMessageRow>): ArtifactMessageRow {
  return {
    id: 1,
    sessionId: 10,
    workspaceId: 1,
    role: "assistant",
    createdAt: "2026-09-20T10:00:00.000Z",
    ...partial,
  };
}

function writeCall(path: string, state = "done"): string {
  return JSON.stringify([
    {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "write_file",
      args: { path },
      state,
    },
  ]);
}

describe("aggregateArtifacts", () => {
  it("提取 write_file(state=done) 的产物，带工作空间/会话来源", () => {
    const out = aggregateArtifacts(
      [row({ id: 1, blocks: writeCall("report.md") })],
      WS,
      TITLES,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: "/tmp/ws-a/report.md",
      relPath: "report.md",
      name: "report.md",
      workspaceId: 1,
      workspaceName: "空间一",
      sessionId: 10,
      sessionTitle: "会话甲",
    });
  });

  it("非 write_file 与未完成状态（running/denied/error）不收录", () => {
    const blocks = JSON.stringify([
      {
        type: "tool_call",
        toolCallId: "a",
        toolName: "read_file",
        args: { path: "x.md" },
        state: "done",
      },
      {
        type: "tool_call",
        toolCallId: "b",
        toolName: "write_file",
        args: { path: "running.md" },
        state: "running",
      },
      {
        type: "tool_call",
        toolCallId: "c",
        toolName: "write_file",
        args: { path: "denied.md" },
        state: "denied",
      },
      {
        type: "tool_call",
        toolCallId: "d",
        toolName: "write_file",
        args: { path: "error.md" },
        state: "error",
      },
      { type: "text", text: "hi" },
    ]);
    expect(aggregateArtifacts([row({ blocks })], WS, TITLES)).toHaveLength(0);
  });

  it("args.path 非字符串或空串的畸形块跳过", () => {
    const blocks = JSON.stringify([
      {
        type: "tool_call",
        toolCallId: "a",
        toolName: "write_file",
        args: {},
        state: "done",
      },
      {
        type: "tool_call",
        toolCallId: "b",
        toolName: "write_file",
        args: { path: "  " },
        state: "done",
      },
    ]);
    expect(aggregateArtifacts([row({ blocks })], WS, TITLES)).toHaveLength(0);
  });

  it("同文件跨会话去重：归属最新写入（时间、来源取后者）", () => {
    const out = aggregateArtifacts(
      [
        row({
          id: 1,
          sessionId: 10,
          createdAt: "2026-09-20T10:00:00Z",
          blocks: writeCall("shared.md"),
        }),
        row({
          id: 2,
          sessionId: 11,
          createdAt: "2026-09-21T10:00:00Z",
          blocks: writeCall("shared.md"),
        }),
      ],
      WS,
      TITLES,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sessionId: 11,
      writtenAt: "2026-09-21T10:00:00.000Z",
    });
  });

  it("绝对路径直接使用（不经工作空间目录拼接）", () => {
    const out = aggregateArtifacts(
      [
        row({
          sessionId: 11,
          workspaceId: 2,
          blocks: writeCall("/data/out/abs.md"),
        }),
      ],
      WS,
      TITLES,
    );
    expect(out[0]?.path).toBe(path.resolve("/data/out/abs.md"));
    expect(out[0]?.workspaceName).toBe("空间二"); // 无目录工作空间 + 绝对路径仍可用
  });

  it("相对路径 + 工作空间无目录 → 跳过", () => {
    expect(
      aggregateArtifacts(
        [row({ sessionId: 11, workspaceId: 2, blocks: writeCall("rel.md") })],
        WS,
        TITLES,
      ),
    ).toHaveLength(0);
  });

  it("输出按写入时间降序", () => {
    const out = aggregateArtifacts(
      [
        row({
          id: 1,
          createdAt: "2026-09-20T10:00:00Z",
          blocks: writeCall("old.md"),
        }),
        row({
          id: 2,
          createdAt: "2026-09-22T10:00:00Z",
          blocks: writeCall("new.md"),
        }),
        row({
          id: 3,
          createdAt: "2026-09-21T10:00:00Z",
          blocks: writeCall("mid.md"),
        }),
      ],
      WS,
      TITLES,
    );
    expect(out.map((a) => a.name)).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("畸形 blocks JSON / system 消息容错跳过，不抛异常", () => {
    expect(() =>
      aggregateArtifacts(
        [
          row({ role: "system", blocks: writeCall("sys.md") }),
          row({ blocks: "not-json" }),
        ],
        WS,
        TITLES,
      ),
    ).not.toThrow();
  });
});
