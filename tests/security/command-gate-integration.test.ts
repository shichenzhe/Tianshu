// SP2 Task 4 集成测试：runToolCall 命令判定门（block/ask/allow/default）
// + run_command source 标注与子进程黑名单挂载前置。vi.mock 由 vitest 提升，
// 与下方 import 顺序无关（照 tests/ai/chat.service.test.ts 先例）
import { mkdirSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData")（chat.service 传递依赖）
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/chat/chat.service";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

// exec cwd 落在 /tmp/ws：t4 断言「退出码 0」须真实执行成功；
// recursive 幂等，留置不清理（/tmp 系统级回收，避免并发测试文件互扰）
beforeAll(() => {
  mkdirSync("/tmp/ws", { recursive: true });
});

function makeAgent(
  over: Partial<AgentStreamOptions>,
): AgentStreamOptions & { events: SecurityEvent[]; approvals: string[] } {
  const events: SecurityEvent[] = [];
  const approvals: string[] = [];
  return {
    sessionId: 1,
    workspacePath: "/tmp/ws",
    fullAccess: () => false,
    isToolAllowed: async () => false,
    requestApproval: async (id) => {
      approvals.push(id);
      return true;
    },
    onSecurityEvent: (e) => events.push(e),
    // brief 原稿字面量漏挂两键（as never 掩盖），断言侧 agent.events/approvals 会 undefined
    events,
    approvals,
    ...over,
  } as never;
}

const CMD = { command: "echo hi" };

describe("runToolCall 命令判定门", () => {
  it("block：直接拒绝 + blocked 审计（source=blacklist），不触审批", async () => {
    const agent = makeAgent({ decideCommand: () => "block" });
    const out = await runToolCall(makeRunCommandTool(), agent, "t1", CMD);
    expect(out).toContain("程序黑名单");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "command-safety.blocked",
      decision: "blocked",
    });
    expect(agent.events[0].detail).toMatchObject({ source: "blacklist" });
  });

  it("ask + fullAccess：审批仍被强制触发（不被完全访问短路）", async () => {
    const agent = makeAgent({
      decideCommand: () => "ask",
      fullAccess: () => true,
    });
    await runToolCall(makeRunCommandTool(), agent, "t2", CMD);
    expect(agent.approvals).toHaveLength(1);
    expect(
      agent.events.some((e) => e.eventType === "command-safety.needs-approval"),
    ).toBe(true);
  });

  it("ask + unattended：强制拒绝（reason=unattended），不触审批", async () => {
    const agent = makeAgent({
      decideCommand: () => "ask",
      unattended: true,
      fullAccess: () => true,
    });
    const out = await runToolCall(makeRunCommandTool(), agent, "t3", CMD);
    expect(out).toContain("无人值守");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "command-safety.rejected",
      decision: "rejected",
    });
    expect(agent.events[0].detail).toMatchObject({ reason: "unattended" });
  });

  it("allow：跳过审批直执行 + allow-listed 审计", async () => {
    const agent = makeAgent({ decideCommand: () => "allow" });
    const out = await runToolCall(makeRunCommandTool(), agent, "t4", CMD);
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("退出码 0");
    expect(
      agent.events.some((e) => e.eventType === "command-safety.allow-listed"),
    ).toBe(true);
  });

  it("default：行为与 SP1 一致（未记忆→审批；fullAccess→直执行）", async () => {
    const gated = makeAgent({ decideCommand: () => "default" });
    await runToolCall(makeRunCommandTool(), gated, "t5", CMD);
    expect(gated.approvals).toHaveLength(1);
    const full = makeAgent({
      decideCommand: () => "default",
      fullAccess: () => true,
    });
    await runToolCall(makeRunCommandTool(), full, "t6", CMD);
    expect(full.approvals).toHaveLength(0);
  });
});

describe("run_command 危险命令 source 标注", () => {
  it("危险命令拦截事件 detail.source=dangerous", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      {
        workspacePath: "/tmp/ws",
        sessionId: 1,
        onSecurityEvent: (e) => events.push(e),
      },
      { command: "rm -rf /Users/x/data" },
    );
    expect(out).toContain("安全策略拦截");
    expect(events[0].detail).toMatchObject({ source: "dangerous" });
  });

  it("无 commandWatchBlacklist 时正常执行零事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      {
        workspacePath: "/tmp/ws",
        sessionId: 1,
        onSecurityEvent: (e) => events.push(e),
      },
      { command: "echo ok" },
    );
    expect(events).toHaveLength(0);
  });
});
