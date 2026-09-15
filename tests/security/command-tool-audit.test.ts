import { describe, expect, it } from "vitest";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

const CTX = { workspacePath: "/tmp/ws", sessionId: 1 };

describe("run_command 安全事件", () => {
  it("危险命令命中 → blocked 事件 + commandPreview/commandHash", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { ...CTX, onSecurityEvent: (e) => events.push(e) },
      { command: "rm -rf /Users/x/data" },
    );
    expect(out).toContain("安全策略拦截");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "command-safety.blocked",
      decision: "blocked",
    });
    expect(events[0].commandPreview).toContain("rm -rf");
    expect(events[0].commandHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cwd 越界回退 → cwd-fallback info 事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      { ...CTX, onSecurityEvent: (e) => events.push(e) },
      { command: "echo hi", cwd: "/etc" },
    );
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "command-safety.cwd-fallback",
        decision: "info",
      }),
    ]);
  });

  it("正常命令无事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      { ...CTX, onSecurityEvent: (e) => events.push(e) },
      { command: "echo hi" },
    );
    expect(events).toHaveLength(0);
  });
});
