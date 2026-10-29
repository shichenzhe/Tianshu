// SP2 Task 4 集成测试：runToolCall 命令判定门（block/ask/allow/default）
// + bash source 标注与子进程黑名单挂载前置。vi.mock 由 vitest 提升，
// 与下方 import 顺序无关（照 tests/ai/chat.service.test.ts 先例）
import { mkdirSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log/prisma-client 顶层读取 app.getPath("userData")/getAppPath/isPackaged
  // 计算日志与数据目录（data-root 冷迁移链路；chat.service 传递依赖）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/agent/tool-gate";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import {
  makeFileTool,
  type ToolDefinition,
} from "../../electron/domains/ai/agent/file-tools";
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
    // vi.fn 包装（2026-10-24 权限放宽批）：新用例走 mockResolvedValue/
    // toHaveBeenCalled 断言；实现保留 approvals 推送，既有用例断言不变
    requestApproval: vi.fn(async (id: string) => {
      approvals.push(id);
      return true;
    }),
    onSecurityEvent: (e) => events.push(e),
    // brief 原稿字面量漏挂两键（as never 掩盖），断言侧 agent.events/approvals 会 undefined
    events,
    approvals,
    ...over,
  } as never;
}

const CMD = { command: "echo hi" };

// 权限放宽批（2026-10-24）用例的工具 def：命令/写/删三件真身 +
// AUTO_EXEMPT 免审面验证的最小 write stub（name 由用例覆写）
const runCommandDef = makeRunCommandTool();
const writeFileDef = makeFileTool("write");
const deleteFileDef = makeFileTool("rm");
const writeDefBase: ToolDefinition = {
  name: "stub_write",
  description: "stub",
  parameters: {},
  kind: "write",
  execute: async () => "ok",
};

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

  it("ask + fullAccess（bypass）：直执行不弹审批——2026-10-23 三档递进；needs-approval 审计事件仍发", async () => {
    const agent = makeAgent({
      decideCommand: () => "ask",
      fullAccess: () => true,
    });
    await runToolCall(makeRunCommandTool(), agent, "t2", CMD);
    expect(agent.approvals).toHaveLength(0);
    // 审计 emit 先于档位判定：规则命中（ask 名单）仍记录
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

  it("default：普通命令直执行（兜底审批移除，2026-10-24 权限放宽）；fullAccess→直执行", async () => {
    const gated = makeAgent({ decideCommand: () => "default" });
    const out = await runToolCall(makeRunCommandTool(), gated, "t5", CMD);
    expect(gated.approvals).toHaveLength(0);
    expect(out).toContain("退出码 0");
    const full = makeAgent({
      decideCommand: () => "default",
      fullAccess: () => true,
    });
    await runToolCall(makeRunCommandTool(), full, "t6", CMD);
    expect(full.approvals).toHaveLength(0);
  });
});

describe("bash 危险命令 source 标注", () => {
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

// ===== 权限放宽（2026-10-24 spec §3/§4.4/§4.5）=====
// default 档审批面从「一切 write 询问」收窄为「高危询问」：普通命令/
// write 工作空间内/DB 写直执行；危险分级 HIGH/CRITICAL 两档均审批
// （full 亦不豁免，对齐 WorkBuddy bypass）
describe("runToolCall 权限放宽", () => {
  it("default 档普通命令直执行（不再兜底审批）", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    const out = await runToolCall(runCommandDef, agent, "c1", {
      command: "ls -la",
    });
    // 成功输出断言照同文件既有用例（t4）：真实执行退出码 0
    expect(out).toContain("退出码 0");
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("危险分级命中 default 档强制审批", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    agent.requestApproval.mockResolvedValue(true);
    await runToolCall(runCommandDef, agent, "c2", { command: "sudo rm -r x" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("危险分级命中 full 档仍审批（对齐 WorkBuddy bypass）", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideCommand: () => "default",
    });
    agent.requestApproval.mockResolvedValue(true);
    await runToolCall(runCommandDef, agent, "c3", {
      command: "git reset --hard",
    });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("cmdAsk 命中 full 档放行（full=免责+内置硬线）", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideCommand: () => "ask",
    });
    await runToolCall(runCommandDef, agent, "c4", { command: "mytool x" });
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("cmdAsk 命中 default 档仍审批（full 短路豁免的对照面）", async () => {
    const agent = makeAgent({ decideCommand: () => "ask" });
    agent.requestApproval.mockResolvedValue(true);
    await runToolCall(runCommandDef, agent, "c4b", { command: "echo hi" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("危险分级命中 unattended 强拒", async () => {
    const agent = makeAgent({
      unattended: true,
      decideCommand: () => "default",
    });
    const out = await runToolCall(runCommandDef, agent, "c5", {
      command: "sudo reboot",
    });
    expect(out).toContain("无人值守");
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("write default 档直执行并上报 auto-allowed", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    const events: SecurityEvent[] = [];
    agent.onSecurityEvent = (e) => events.push(e);
    await runToolCall(writeFileDef, agent, "c6", {
      path: "a.txt",
      content: "x",
    });
    expect(agent.requestApproval).not.toHaveBeenCalled();
    expect(events.some((e) => e.eventType === "file-safety.auto-allowed")).toBe(
      true,
    );
  });

  it("write 敏感路径（fileGate block）仍审批", async () => {
    const agent = makeAgent({
      decideCommand: () => "default",
      decideFileAccess: () => "block",
    });
    agent.requestApproval.mockResolvedValue(false);
    await runToolCall(writeFileDef, agent, "c7", {
      path: "secret",
      content: "x",
    });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("rm default 档仍审批（delete=ask 裁定）", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    agent.requestApproval.mockResolvedValue(false);
    await runToolCall(deleteFileDef, agent, "c8", { path: "a.txt" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it.each(["todo_write", "create_skill", "create_expert"])(
    "DB 写工具 %s 直执行",
    async (name) => {
      const agent = makeAgent({ decideCommand: () => "default" });
      await runToolCall({ ...writeDefBase, name }, agent, "c9-" + name, {});
      expect(agent.requestApproval).not.toHaveBeenCalled();
    },
  );
});

describe("网络域免审（2026-10-24 裁定重落：任何档位直执行）", () => {
  it.each([
    "fetch",
    "browse",
    "browser_snapshot",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "mcp__anyServer_anyTool",
  ])("%s kind=write 直执行不审批", async (name) => {
    const agent = makeAgent({ decideCommand: () => "default" });
    await runToolCall({ ...writeDefBase, name }, agent, "net-" + name, {});
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });
});
