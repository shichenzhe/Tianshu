import { describe, expect, it } from "vitest";

import { deriveAgentProgress } from "./agent-progress";
import type { RemoteStreamState } from "./remote-stream";

function makeLive(overrides: Partial<RemoteStreamState>): RemoteStreamState {
  return {
    active: true,
    status: "streaming",
    text: "",
    thinking: "",
    toolOrder: [],
    tools: {},
    approvals: [],
    ...overrides,
  } as RemoteStreamState;
}

describe("deriveAgentProgress", () => {
  it("null live → 准备中 stepCount 1", () => {
    expect(deriveAgentProgress(null)).toEqual({
      preparing: true,
      stepCount: 1,
    });
  });

  it("空产出 live → 准备中", () => {
    expect(deriveAgentProgress(makeLive({}))).toEqual({
      preparing: true,
      stepCount: 1,
    });
  });

  it("仅有文本 → 回复中 stepCount 1", () => {
    expect(deriveAgentProgress(makeLive({ text: "hi" }))).toEqual({
      preparing: false,
      stepCount: 1,
    });
  });

  it("running 工具 → 步数=调用序位次+工具名（最新 running 优先）", () => {
    const live = makeLive({
      toolOrder: ["t1", "t2"],
      tools: {
        t1: { toolCallId: "t1", toolName: "read_file", state: "done" },
        t2: { toolCallId: "t2", toolName: "write_file", state: "running" },
      },
    });
    expect(deriveAgentProgress(live)).toEqual({
      preparing: false,
      stepCount: 2,
      activeTool: "write_file",
    });
  });

  it("首工具 running → 步数=indexOf+1（桌面 MessageList 同口径）", () => {
    const live = makeLive({
      toolOrder: ["t1", "t2"],
      tools: {
        t1: { toolCallId: "t1", toolName: "read_file", state: "running" },
        t2: { toolCallId: "t2", toolName: "write_file", state: "done" },
      },
    });
    expect(deriveAgentProgress(live)).toEqual({
      preparing: false,
      stepCount: 1,
      activeTool: "read_file",
    });
  });

  it("工具全终态 → 回复中（无 activeTool）", () => {
    const live = makeLive({
      thinking: "…",
      toolOrder: ["t1"],
      tools: { t1: { toolCallId: "t1", toolName: "read_file", state: "done" } },
    });
    expect(deriveAgentProgress(live)).toEqual({
      preparing: false,
      stepCount: 2,
    });
  });
});
