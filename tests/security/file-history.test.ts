/**
 * FileHistoryService 单测（SP4 Task 2）：快照落盘 + manifest 追加 + 内容寻址
 * 去重 + 超限/非文件 fail-open + manifest 损坏重建 + 跨会话配额 LRU（共享
 * 快照不误删）+ countFilesForEstimate 目录树计数。
 * file-history 传递依赖 Log（→ electron），经 vi.mock 替换（仓库既有模式）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { on: vi.fn(), getPath: vi.fn(() => "/tmp") },
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countFilesForEstimate,
  FileHistoryService,
} from "../../electron/domains/security/file-history";
import {
  snapshotName,
  type BackupEntry,
} from "../../electron/domains/security/backup-policy";

let ROOT = "";
let WS = "";
beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sp4-fh-root-"));
  WS = fs.mkdtempSync(path.join(os.tmpdir(), "sp4-fh-ws-"));
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });
});

const svc = (maxBytes: number) => new FileHistoryService(ROOT, () => maxBytes);

function writeManifest(sessionId: number, entries: BackupEntry[]): void {
  const dir = path.join(ROOT, String(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    fs.writeFileSync(path.join(dir, e.hash), `snap-${e.hash}`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(entries));
}
function readManifest(sessionId: number): BackupEntry[] {
  return JSON.parse(
    fs.readFileSync(
      path.join(ROOT, String(sessionId), "manifest.json"),
      "utf8",
    ),
  );
}

describe("backupFile", () => {
  it("落快照 + manifest 条目；同内容复用不重复写", async () => {
    const target = path.join(WS, "a.txt");
    fs.writeFileSync(target, "hello");
    const r = await svc(1 << 30).backupFile(target, 7);
    expect(r).toEqual({ ok: true, size: 5 });
    const snap = path.join(ROOT, "7", snapshotName(Buffer.from("hello")));
    expect(fs.existsSync(snap)).toBe(true);
    expect(readManifest(7)).toMatchObject([
      { path: target, size: 5, hash: snapshotName(Buffer.from("hello")) },
    ]);
    // 同内容再次备份（另一路径）：快照复用，manifest 各记一行
    const t2 = path.join(WS, "b.txt");
    fs.writeFileSync(t2, "hello");
    await svc(1 << 30).backupFile(t2, 7);
    expect(readManifest(7)).toHaveLength(2);
    expect(fs.readdirSync(path.join(ROOT, "7"))).toContain(
      snapshotName(Buffer.from("hello")),
    );
  });
  it("不存在 / 目录 / 超限 → ok:false 带原因", async () => {
    const s = svc(1 << 30);
    expect(await s.backupFile(path.join(WS, "nope"), 7)).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
    expect(await s.backupFile(WS, 7)).toMatchObject({ ok: false });
    const big = path.join(WS, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(101 * 1024 * 1024));
    expect(await s.backupFile(big, 7)).toEqual({
      ok: false,
      reason: "oversize",
    });
    fs.rmSync(big);
  });
  it("manifest 损坏 → 丢弃重建不致损", async () => {
    fs.mkdirSync(path.join(ROOT, "9"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "9", "manifest.json"), "{broken");
    const target = path.join(WS, "c.txt");
    fs.writeFileSync(target, "x");
    expect(await svc(1 << 30).backupFile(target, 9)).toEqual({
      ok: true,
      size: 1,
    });
    expect(readManifest(9)).toHaveLength(1);
  });
});

describe("配额 LRU（跨会话）", () => {
  it("超配额淘汰最旧条目并删 orphan 快照；共享 hash 不误删", async () => {
    writeManifest(11, [
      { path: "/old1", hash: "h_old", at: 1000, size: 600 },
      { path: "/shared1", hash: "h_shared", at: 2000, size: 200 },
    ]);
    writeManifest(12, [
      { path: "/shared2", hash: "h_shared", at: 3000, size: 200 },
      { path: "/new", hash: "h_new", at: 4000, size: 200 },
    ]);
    // 总量 1200 > 1000：淘汰 /old1(600) 即达标
    await svc(1000).enforceNow();
    expect(readManifest(11).map((e) => e.path)).toEqual(["/shared1"]);
    expect(fs.existsSync(path.join(ROOT, "11", "h_old"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "11", "h_shared"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "12", "h_shared"))).toBe(true);
  });
});

describe("countFilesForEstimate", () => {
  it("目录树文件计数；达 10000 上限即停", async () => {
    fs.mkdirSync(path.join(WS, "tree", "sub"), { recursive: true });
    fs.writeFileSync(path.join(WS, "tree", "1.txt"), "a");
    fs.writeFileSync(path.join(WS, "tree", "sub", "2.txt"), "b");
    expect(await countFilesForEstimate(path.join(WS, "tree"))).toBe(2);
    expect(await countFilesForEstimate(path.join(WS, "tree", "1.txt"))).toBe(1);
    expect(await countFilesForEstimate(path.join(WS, "nope"))).toBe(0);
  });
});
