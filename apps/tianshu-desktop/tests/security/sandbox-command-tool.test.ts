// OS 沙箱嵌入层测试（spec §10）：ctx 桩测（wrap 调用条件与审计）+
// runner 三条件合成 + runToolCall 判定链不变集成 + 中止收割行为。
// vi.mock 由 vitest 提升，与下方 import 顺序无关（照 command-gate-integration 先例）
import { describe, afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/agent/tool-gate";
import {
  getSandboxRunner,
  installSandboxRunner,
  resetSandboxRunnerForTest,
} from "../../electron/domains/security/sandbox/runner";
import type { SecurityConfig, SecurityEvent } from "../../src-react/domains/security/model/types";

const CTX_BASE = { workspacePath: "/tmp/ws", sessionId: 1 };

function baseConfig(over: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    sandboxEnabled: true,
    osSandboxEnabled: true,
    fileAllowlist: [],
    fileBlocklist: [],
    cmdAllow: [],
    cmdAsk: [],
    programBlacklist: [],
    domainAllow: [],
    domainDeny: [],
    blockAllNetwork: false,
    maliciousDomainProtection: true,
    fileBackupEnabled: true,
    fileBackupMaxSizeMB: 3000,
    deleteProtection: true,
    bulkDeleteThreshold: 50,
    disabledTools: [],
    ...over,
  };
}

describe("command-tool 沙箱注入面（ctx 桩测）", () => {
  it("sandboxed 包装执行 → wrap 收到正确 opts + command-sandbox 审计事件", async () => {
    const events: SecurityEvent[] = [];
    const wrap = vi.fn((command: string) => ({
      command: `wrapped(${command})`,
      sandboxed: true,
    }));
    // wrap 后命令仍可执行：桩只包一个无害 echo
    wrap.mockImplementation((command: string) => ({
      command,
      sandboxed: true,
    }));
    const tool = makeRunCommandTool();
    await tool.execute(
      {
        ...CTX_BASE,
        fullAccess: false,
        onSecurityEvent: (e) => events.push(e),
        osSandbox: { wrap },
      },
      { command: "echo sandboxed" },
    );
    expect(wrap).toHaveBeenCalledWith("echo sandboxed", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(
      events.filter((e) => e.eventType === "command-safety.sandbox"),
    ).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: "info" });
    expect(events[0].detail).toMatchObject({
      mode: "workspace-write",
      workspace: "/tmp/ws",
    });
  });

  it("wrap 透传（sandboxed=false）→ 零沙箱事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      {
        ...CTX_BASE,
        onSecurityEvent: (e) => events.push(e),
        osSandbox: {
          wrap: (command) => ({ command, sandboxed: false }),
        },
      },
      { command: "echo passthrough" },
    );
    expect(
      events.filter((e) => e.eventType === "command-safety.sandbox"),
    ).toHaveLength(0);
  });

  it("缺席 osSandbox → 零开销透传（旧装配/纯桩兼容）", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { ...CTX_BASE, onSecurityEvent: (e) => events.push(e) },
      { command: "echo plain" },
    );
    expect(out).toContain("退出码 0");
    expect(events).toHaveLength(0);
  });
});

describe("runner 三条件合成（enabled × available × 非 full）", () => {
  afterEach(() => resetSandboxRunnerForTest());

  it("未安装 → fail-open 透传（vitest/装配前零行为）", () => {
    const r = getSandboxRunner().wrap("echo x", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r).toEqual({ command: "echo x", sandboxed: false });
  });

  it("配置关 → 透传", () => {
    installSandboxRunner(() => baseConfig({ osSandboxEnabled: false }));
    const r = getSandboxRunner().wrap("echo x", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r).toEqual({ command: "echo x", sandboxed: false });
  });

  it("配置读抛异常 → fail-open 透传", () => {
    installSandboxRunner(() => {
      throw new Error("boom");
    });
    const r = getSandboxRunner().wrap("echo x", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r).toEqual({ command: "echo x", sandboxed: false });
  });

  it("full 档 → 恒等返回（裁定假设 #1）", () => {
    installSandboxRunner(() => baseConfig());
    const r = getSandboxRunner().wrap("echo x", {
      workspacePath: "/tmp/ws",
      fullAccess: true,
    });
    expect(r).toEqual({ command: "echo x", sandboxed: false });
  });

  it("开启 × 非 full × darwin → Seatbelt 包装；非 darwin → no-op 透传", () => {
    installSandboxRunner(() => baseConfig());
    const r = getSandboxRunner().wrap("echo x", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    if (process.platform === "darwin") {
      expect(r.sandboxed).toBe(true);
      expect(r.command).toMatch(/^sandbox-exec -p '/);
    } else {
      expect(r).toEqual({ command: "echo x", sandboxed: false });
    }
  });
});

describe("runToolCall 判定链不变集成（spec §7/§10）", () => {
  afterEach(() => resetSandboxRunnerForTest());

  function makeAgent(
    over: Partial<AgentStreamOptions>,
  ): AgentStreamOptions & { events: SecurityEvent[] } {
    const events: SecurityEvent[] = [];
    return {
      sessionId: 1,
      workspacePath: "/tmp/ws",
      fullAccess: () => false,
      isToolAllowed: async () => false,
      requestApproval: vi.fn(async () => true),
      onSecurityEvent: (e) => events.push(e),
      events,
      ...over,
    } as never;
  }

  it("沙箱开启：block 拒面不变（不触审批不执行）", async () => {
    installSandboxRunner(() => baseConfig());
    const agent = makeAgent({ decideCommand: () => "block" });
    const out = await runToolCall(makeRunCommandTool(), agent, "s1", {
      command: "echo hi",
    });
    expect(out).toContain("程序黑名单");
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("沙箱开启：default 档普通命令仍直执行（退出码 0）", async () => {
    installSandboxRunner(() => baseConfig());
    const agent = makeAgent({ decideCommand: () => "default" });
    const out = await runToolCall(makeRunCommandTool(), agent, "s2", {
      command: "echo hi",
    });
    expect(out).toContain("退出码 0");
    expect(agent.requestApproval).not.toHaveBeenCalled();
    if (process.platform === "darwin") {
      expect(
        agent.events.some((e) => e.eventType === "command-safety.sandbox"),
      ).toBe(true);
    }
  });

  it("沙箱开启：ask 档仍走审批", async () => {
    installSandboxRunner(() => baseConfig());
    const agent = makeAgent({ decideCommand: () => "ask" });
    await runToolCall(makeRunCommandTool(), agent, "s3", {
      command: "echo hi",
    });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("沙箱开启：危险命令硬拦截前置（wrap 前拒，不产生沙箱事件）", async () => {
    installSandboxRunner(() => baseConfig());
    const agent = makeAgent({ decideCommand: () => "default" });
    const out = await runToolCall(makeRunCommandTool(), agent, "s4", {
      command: "rm -rf /Users/x/data",
    });
    expect(out).toContain("安全策略拦截");
    expect(
      agent.events.some((e) => e.eventType === "command-safety.sandbox"),
    ).toBe(false);
  });

  it("中止收割：abort 后长命令快速了结（不挂满 60s 超时）", async () => {
    installSandboxRunner(() => baseConfig());
    const tool = makeRunCommandTool();
    const controller = new AbortController();
    const startedAt = Date.now();
    const settle = tool.execute(
      {
        ...CTX_BASE,
        osSandbox: getSandboxRunner(),
        abortSignal: controller.signal,
      },
      { command: "sleep 30" },
    );
    setTimeout(() => controller.abort(), 150);
    await settle;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);
});
