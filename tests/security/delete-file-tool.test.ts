import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { trashItem: vi.fn(async (p: string) => void p) },
}));

import { makeFileTool } from "../../electron/domains/ai/agent/file-tools";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";
import type { BackupFileResult } from "../../electron/domains/security/file-history";

let WS = "";
beforeAll(() => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), "sp4-del-"));
});
afterAll(() => fs.rmSync(WS, { recursive: true, force: true }));

interface Ctx {
  workspacePath: string;
  sessionId: number;
  fullAccess?: boolean;
  deleteProtection?: boolean;
  onBackupFile?: (
    absPath: string,
    sessionId: number,
  ) => Promise<BackupFileResult>;
  events: SecurityEvent[];
}
function makeCtx(over: Partial<Ctx> = {}): Ctx & { events: SecurityEvent[] } {
  const events: SecurityEvent[] = [];
  return {
    workspacePath: WS,
    sessionId: 1,
    events,
    onSecurityEvent: (e: SecurityEvent) => {
      events.push(e);
    },
    ...over,
  } as Ctx & { events: SecurityEvent[] };
}
const okBackup: BackupFileResult = { ok: true, size: 1 };

describe("delete_file 工具", () => {
  it("默认（deleteProtection 缺省）→ trashItem 移入回收站 + 审计", async () => {
    const ctx = makeCtx();
    const f = path.join(WS, "t1.txt");
    fs.writeFileSync(f, "x");
    const out = await makeFileTool("delete_file").execute(ctx, {
      path: "t1.txt",
    });
    expect(out).toContain("回收站");
    expect(fs.existsSync(f)).toBe(true); // mock trashItem 不真删
    expect(ctx.events.map((e) => e.eventType)).toContain(
      "data-safety.delete-trashed",
    );
  });
  it("deleteProtection=false → 先备份后永久删除（目录递归）", async () => {
    const backups: string[] = [];
    const ctx = makeCtx({
      deleteProtection: false,
      onBackupFile: async (abs) => {
        backups.push(abs);
        return okBackup;
      },
    });
    fs.mkdirSync(path.join(WS, "d"));
    fs.writeFileSync(path.join(WS, "d", "1.txt"), "a");
    fs.writeFileSync(path.join(WS, "d", "2.txt"), "b");
    const out = await makeFileTool("delete_file").execute(ctx, { path: "d" });
    expect(out).toContain("已永久删除");
    expect(fs.existsSync(path.join(WS, "d"))).toBe(false);
    expect(backups).toHaveLength(2);
    expect(ctx.events).toContainEqual(
      expect.objectContaining({
        eventType: "data-safety.delete-permanent",
        detail: expect.objectContaining({ files: 2 }),
      }),
    );
  });
  it("不存在 → 报错文案；空路径报错", async () => {
    const ctx = makeCtx();
    const out = await makeFileTool("delete_file").execute(ctx, {
      path: "nope",
    });
    expect(out).toContain("错误");
    const out2 = await makeFileTool("delete_file").execute(ctx, { path: " " });
    expect(out2).toContain("错误");
  });
  it("备份失败不阻塞删除（fail-open）+ backup-skipped 审计", async () => {
    const ctx = makeCtx({
      deleteProtection: false,
      onBackupFile: async () => ({ ok: false, reason: "boom" }),
    });
    fs.writeFileSync(path.join(WS, "t2.txt"), "x");
    const out = await makeFileTool("delete_file").execute(ctx, {
      path: "t2.txt",
    });
    expect(out).toContain("已永久删除");
    expect(ctx.events.map((e) => e.eventType)).toContain(
      "data-safety.backup-skipped",
    );
  });
  it("trashItem 抛错 → 保留文件 + delete-failed 审计", async () => {
    const { shell } = await import("electron");
    vi.mocked(shell.trashItem).mockRejectedValueOnce(new Error("E1"));
    const ctx = makeCtx();
    fs.writeFileSync(path.join(WS, "t3.txt"), "x");
    const out = await makeFileTool("delete_file").execute(ctx, {
      path: "t3.txt",
    });
    expect(out).toContain("回收站失败");
    expect(ctx.events.map((e) => e.eventType)).toContain(
      "data-safety.delete-failed",
    );
  });
});

describe("write_file 覆盖前备份", () => {
  it("已存在文件覆盖前 onBackupFile 被调 + backup-created 审计；新文件不备份", async () => {
    const backups: string[] = [];
    const ctx = makeCtx({
      onBackupFile: async (abs) => {
        backups.push(abs);
        return okBackup;
      },
    });
    fs.writeFileSync(path.join(WS, "w1.txt"), "old");
    await makeFileTool("write_file").execute(ctx, {
      path: "w1.txt",
      content: "new",
    });
    expect(backups).toHaveLength(1);
    expect(ctx.events.map((e) => e.eventType)).toContain(
      "data-safety.backup-created",
    );
    await makeFileTool("write_file").execute(ctx, {
      path: "w2.txt",
      content: "fresh",
    });
    expect(backups).toHaveLength(1); // 新文件不备份
  });
  it("备份失败继续写入（fail-open）", async () => {
    const ctx = makeCtx({
      onBackupFile: async () => ({ ok: false, reason: "boom" }),
    });
    fs.writeFileSync(path.join(WS, "w3.txt"), "old");
    const out = await makeFileTool("write_file").execute(ctx, {
      path: "w3.txt",
      content: "new",
    });
    expect(out).toContain("已写入");
    expect(ctx.events.map((e) => e.eventType)).toContain(
      "data-safety.backup-skipped",
    );
  });
});
