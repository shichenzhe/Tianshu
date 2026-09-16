// SP3 Task 3 集成测试：runToolCall 文件判定门（block/allow/default 与
// unattended 强拒）。vi.mock 由 vitest 提升，与 import 顺序无关
// （照 tests/security/command-gate-integration.test.ts 先例）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { on: vi.fn(), getPath: vi.fn(() => "/tmp") },
}));

vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/chat/chat.service";
import { makeFileTool } from "../../electron/domains/ai/agent/file-tools";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

let WS = "";
beforeAll(() => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), "sp3-ws-"));
  fs.mkdirSync(path.join(WS, "secret"));
  fs.writeFileSync(path.join(WS, "secret", "k.pem"), "x");
  fs.writeFileSync(path.join(WS, "normal.txt"), "hello");
});
afterAll(() => fs.rmSync(WS, { recursive: true, force: true }));

function makeAgent(
  over: Partial<AgentStreamOptions>,
): AgentStreamOptions & { events: SecurityEvent[]; approvals: string[] } {
  const events: SecurityEvent[] = [];
  const approvals: string[] = [];
  return {
    sessionId: 1,
    workspacePath: WS,
    fullAccess: () => false,
    isToolAllowed: async () => false,
    requestApproval: async (id) => {
      approvals.push(id);
      return true;
    },
    onSecurityEvent: (e) => events.push(e),
    // 字面量须挂载两键，否则断言侧 agent.events/approvals 为 undefined
    events,
    approvals,
    ...over,
  } as never;
}

describe("runToolCall 文件判定门", () => {
  it("read_file 黑名单路径 fullAccess 下仍弹审批 + needs-approval 事件", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideFileAccess: () => "block",
    });
    const out = await runToolCall(makeFileTool("read_file"), agent, "f1", {
      path: "secret/k.pem",
    });
    expect(agent.approvals).toHaveLength(1);
    expect(
      agent.events.some((e) => e.eventType === "file-safety.needs-approval"),
    ).toBe(true);
    // 批准后真实读取（内容 x 带行号前缀回喂——brief 原稿误断言路径 k.pem）
    expect(out).toContain("1| x");
  });

  it("block + unattended：强制拒绝，不触审批", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      unattended: true,
      decideFileAccess: () => "block",
    });
    const out = await runToolCall(makeFileTool("read_file"), agent, "f2", {
      path: "secret/k.pem",
    });
    expect(out).toContain("无人值守");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "file-safety.rejected",
      decision: "rejected",
    });
    expect(agent.events[0].detail).toMatchObject({ reason: "unattended" });
  });

  it("write_file 白名单路径跳过审批 + allow-listed 事件", async () => {
    const agent = makeAgent({ decideFileAccess: () => "allow" });
    const out = await runToolCall(makeFileTool("write_file"), agent, "f3", {
      path: "out.txt",
      content: "hi",
    });
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("已写入");
    expect(
      agent.events.some((e) => e.eventType === "file-safety.allow-listed"),
    ).toBe(true);
  });

  it("default：write 未记忆→审批（现状）；read→直执行免审（现状）", async () => {
    const w = makeAgent({ decideFileAccess: () => "default" });
    await runToolCall(makeFileTool("write_file"), w, "f4", {
      path: "out2.txt",
      content: "x",
    });
    expect(w.approvals).toHaveLength(1);
    const r = makeAgent({ decideFileAccess: () => "default" });
    const out = await runToolCall(makeFileTool("read_file"), r, "f5", {
      path: "normal.txt",
    });
    expect(r.approvals).toHaveLength(0);
    expect(out).toContain("hello");
  });

  it("list_dir 无 path 参数不判定（直执行）", async () => {
    const agent = makeAgent({ decideFileAccess: () => "block" });
    const out = await runToolCall(makeFileTool("list_dir"), agent, "f6", {});
    expect(agent.approvals).toHaveLength(0);
    expect(out).not.toContain("错误");
  });

  it("search_files 不在文件门内（无判定不回归）", async () => {
    const agent = makeAgent({ decideFileAccess: () => "block" });
    await runToolCall(makeFileTool("search_files"), agent, "f7", {
      pattern: "hello",
    });
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events).toHaveLength(0);
  });
});
