import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { makeFileTool } from "../../electron/domains/ai/agent/file-tools";
import { ESTIMATE_COUNT_LIMIT } from "../../electron/domains/security/backup-policy";
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
    // vi.fn 包装（2026-10-24 权限放宽批）：与另两份门测试的 makeAgent 对齐
    requestApproval: vi.fn(async (id: string) => {
      approvals.push(id);
      return true;
    }),
    onSecurityEvent: (e) => events.push(e),
    // 字面量须挂载两键，否则断言侧 agent.events/approvals 为 undefined
    // （brief 原稿漏挂——照 tests/security/file-gate-integration.test.ts 先例补）
    events,
    approvals,
    ...over,
  } as never;
}

describe("批量删除预估门", () => {
  it("目录 ≥ 阈值 + fullAccess（bypass）：直执行不弹审批——2026-10-23 三档递进裁定推翻旧不豁免裁定；needs-approval 审计事件仍发", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      bulkDeleteThreshold: 50,
    });
    const out = await runToolCall(
      makeFileTool("rm"),
      agent,
      "b1",
      { path: "." },
      undefined,
    );
    expect(agent.approvals).toHaveLength(0);
    // 审计 emit 先于档位判定：规则命中（达阈值）仍记录
    expect(
      agent.events.some(
        (e) => e.eventType === "data-safety.bulk-delete-needs-approval",
      ),
    ).toBe(true);
    expect(out).toContain("回收站"); // 直执行（mock trashItem）
  });
  it("unattended → 强拒不触审批 + rejected 事件", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      unattended: true,
      bulkDeleteThreshold: 50,
    });
    const out = await runToolCall(
      makeFileTool("rm"),
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
      makeFileTool("rm"),
      agent,
      "b3",
      { path: "small" },
      undefined,
    );
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("回收站");
  });
  it("rm 黑名单路径 → SP3 文件门 block 生效（强制审批；default 档验证面）", async () => {
    const secret = path.join(WS, "secret");
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, "k.pem"), "x");
    // full 档文件门 block 豁免（2026-10-23 三档递进）——block 审批面
    // 在 default 档验证
    const agent = makeAgent({
      decideFileAccess: () => "block",
    });
    await runToolCall(
      makeFileTool("rm"),
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
  it("其他工具不受影响（read default 直执行）", async () => {
    const agent = makeAgent({ decideFileAccess: () => "default" });
    const out = await runToolCall(
      makeFileTool("read"),
      agent,
      "b5",
      { path: "f0.txt" },
      undefined,
    );
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("x");
  });
  it("阈值 10000（钳制后上限）+ 超上限文件目录 → 仍强制审批（无 dead-zone；default 档验证面）", async () => {
    const huge = path.join(WS, "huge");
    fs.mkdirSync(huge, { recursive: true });
    const total = ESTIMATE_COUNT_LIMIT + 1; // 预估恰返回 10000 = 钳制后阈值上限
    const batch = 500; // 空文件分批并发创建
    for (let i = 0; i < total; i += batch) {
      await Promise.all(
        Array.from({ length: Math.min(batch, total - i) }, (_, j) =>
          fs.promises.writeFile(path.join(huge, `f${i + j}.txt`), ""),
        ),
      );
    }
    // full 档阈值豁免（2026-10-23 裁定：回收站/备份保护不依赖审批）——
    // 阈值审批面在 default 档验证
    const agent = makeAgent({
      bulkDeleteThreshold: ESTIMATE_COUNT_LIMIT,
    });
    const out = await runToolCall(
      makeFileTool("rm"),
      agent,
      "b6",
      { path: "huge" },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
    expect(
      agent.events.some(
        (e) => e.eventType === "data-safety.bulk-delete-needs-approval",
      ),
    ).toBe(true);
    expect(out).toContain("回收站"); // 审批通过后执行（mock trashItem）
  }, 20000);
});
