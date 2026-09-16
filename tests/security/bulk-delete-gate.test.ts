import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { on: vi.fn(), getPath: vi.fn(() => "/tmp") },
  shell: { trashItem: vi.fn(async (p: string) => void p) },
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
  WS = fs.mkdtempSync(path.join(os.tmpdir(), "sp4-gate-"));
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(WS, `f${i}.txt`), "x");
  }
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
    // （brief 原稿漏挂——照 tests/security/file-gate-integration.test.ts 先例补）
    events,
    approvals,
    ...over,
  } as never;
}

describe("批量删除预估门", () => {
  it("目录 ≥ 阈值：fullAccess 下仍强制弹审批 + needs-approval 事件", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      bulkDeleteThreshold: 50,
    });
    const out = await runToolCall(
      makeFileTool("delete_file"),
      agent,
      "b1",
      { path: "." },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
    expect(
      agent.events.some(
        (e) => e.eventType === "data-safety.bulk-delete-needs-approval",
      ),
    ).toBe(true);
    expect(out).toContain("回收站"); // 审批通过后执行（mock trashItem）
  });
  it("unattended → 强拒不触审批 + rejected 事件", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      unattended: true,
      bulkDeleteThreshold: 50,
    });
    const out = await runToolCall(
      makeFileTool("delete_file"),
      agent,
      "b2",
      { path: "." },
      undefined,
    );
    expect(out).toContain("无人值守");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "data-safety.bulk-delete-rejected",
      decision: "rejected",
    });
  });
  it("低于阈值：fullAccess 直执行不弹审批（write 审批语义不变）", async () => {
    const small = path.join(WS, "small");
    fs.mkdirSync(small);
    fs.writeFileSync(path.join(small, "a.txt"), "x");
    const agent = makeAgent({
      fullAccess: () => true,
      bulkDeleteThreshold: 50,
    });
    const out = await runToolCall(
      makeFileTool("delete_file"),
      agent,
      "b3",
      { path: "small" },
      undefined,
    );
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("回收站");
  });
  it("delete_file 黑名单路径 → SP3 文件门 block 生效（强制审批）", async () => {
    const secret = path.join(WS, "secret");
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, "k.pem"), "x");
    const agent = makeAgent({
      fullAccess: () => true,
      decideFileAccess: () => "block",
    });
    await runToolCall(
      makeFileTool("delete_file"),
      agent,
      "b4",
      { path: "secret" },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
    expect(
      agent.events.some((e) => e.eventType === "file-safety.needs-approval"),
    ).toBe(true);
  });
  it("其他工具不受影响（read_file default 直执行）", async () => {
    const agent = makeAgent({ decideFileAccess: () => "default" });
    const out = await runToolCall(
      makeFileTool("read_file"),
      agent,
      "b5",
      { path: "f0.txt" },
      undefined,
    );
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("x");
  });
});
