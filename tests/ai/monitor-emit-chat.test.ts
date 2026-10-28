// chat 链路监控埋点单测（token/工具监控 spec §4.1 #3）：runToolCall 终态
// 回调（done/error 带 durationMs、denied 无时长、agent 缺席不抛错）；
// usageFromBlocks 落库提取（spec §4.1 #1）为 streamAndPersist 接线处一行
// 调用，类型正确性由 typecheck 保障（monitor-events.test.ts 已覆盖纯函数）
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    on: vi.fn(),
    getPath: vi.fn(() => "/tmp"),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  shell: { trashItem: vi.fn(async (p: string) => void p) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/agent/tool-gate";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

type ToolStatsEvent = Parameters<
  NonNullable<AgentStreamOptions["toolStats"]>
>[0];

/** agent 最小注入集（照 tests/security/bulk-delete-gate.test.ts 先例，
 *  runToolCall 只消费这四个必填键 + 按需的可选回调） */
function makeAgent(over: Partial<AgentStreamOptions> = {}): AgentStreamOptions {
  return {
    sessionId: 1,
    fullAccess: () => false,
    isToolAllowed: async () => false,
    requestApproval: async () => true,
    ...over,
  };
}

/** 工具定义 stub：execute 固定输出；runToolCall 不触 description/parameters */
function makeDef(
  output: string,
  over: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: "read_file",
    description: "monitor emit stub",
    parameters: {},
    kind: "read",
    execute: async () => output,
    ...over,
  };
}

describe("runToolCall toolStats 回调", () => {
  it("执行成功 → done + durationMs", async () => {
    const events: ToolStatsEvent[] = [];
    await runToolCall(
      makeDef("done output"),
      makeAgent({ toolStats: (e) => events.push(e) }),
      "call-1",
      {},
      undefined,
    );
    expect(events).toEqual([
      { toolName: "read_file", state: "done", durationMs: expect.any(Number) },
    ]);
  });

  it("输出以「错误:」开头 → error + durationMs", async () => {
    const events: ToolStatsEvent[] = [];
    await runToolCall(
      makeDef("错误: boom"),
      makeAgent({ toolStats: (e) => events.push(e) }),
      "call-2",
      {},
      undefined,
    );
    expect(events).toEqual([
      { toolName: "read_file", state: "error", durationMs: expect.any(Number) },
    ]);
  });

  it("审批拒绝 → denied、无 durationMs（write 工具默认走审批门）", async () => {
    const events: ToolStatsEvent[] = [];
    await runToolCall(
      // kind=write 且非 fullAccess → 挂起审批；requestApproval=false 即拒绝
      makeDef("用户拒绝了此操作", { kind: "write" }),
      makeAgent({
        requestApproval: async () => false,
        toolStats: (e) => events.push(e),
      }),
      "call-3",
      {},
      undefined,
    );
    expect(events).toEqual([{ toolName: "read_file", state: "denied" }]);
  });

  it("agent 未传 toolStats → 不抛错（缺席静默，spec §4 吞错原则）", async () => {
    await expect(
      runToolCall(makeDef("ok"), makeAgent(), "call-4", {}, undefined),
    ).resolves.toBeTruthy();
  });
});
