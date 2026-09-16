# 安全中心 SP4（数据安全执行层）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数据安全真实生效：`write_file` 覆盖前内容寻址快照（manifest + 3000MB LRU 配额）+ `delete_file` 结构化删除（trashItem/备份后永久删）+ 批量删除目录预估强制审批。

**Architecture:** backup-policy 纯函数（快照名/LRU 淘汰/orphan 判定）→ FileHistoryService（文件系统副作用，构造注入 rootDir 与配额 getter）→ delete_file 工具 + write_file 备份接入（ToolContext 注入回调）→ runToolCall 批量预估门（AgentStreamOptions 注入阈值）→ i18n + 守卫。

**Tech Stack:** Electron 44 主进程（node:fs/crypto + shell.trashItem）+ React 19 + i18next + Vitest。

**Spec:** `docs/superpowers/specs/2026-09-17-security-center-sp4-design.md`（执行者须先读）

## Global Constraints

- 遵循仓库 CLAUDE.md：文件名 kebab-case；函数 ≤20 行；生产禁 console（主进程用 `Log`，`electron/domains/security/` 下 import 路径 `../../commons/Log`）；用户可见文本一律 `t()`，模型可见工具文案用中文（照既有工具）。
- 排版以 `npm run lint` 零错误为准（prettier v3 默认尾逗号 all）。
- i18n zh-CN/en-US 同步逐 key；eventType → i18n key **全点换下划线**（`data-safety.backup-created` → `data-safety_backup-created`）；新事件 key 三处登记（双语 JSON + 守卫测试 known 列表）。
- **行为兼容硬约束**：非 delete_file 工具且两门均 null 时现有链路逐字节不变；既有测试全绿。
- 备份 fail-open：备份失败不阻塞写操作（返回 reason + 审计 `data-safety.backup-skipped`）。
- 跨树 import：`electron/domains/security/` 引 src-react 用 `../../../src-react/...`；`electron/domains/ai/chat|agent|automation/` 引 security 域用 `../../security/...`。
- 取证原始输出（rtk proxy）。每任务一 commit，conventional 中文，无 footer。

---

### Task 1: backup-policy 纯函数

**Files:**
- Create: `electron/domains/security/backup-policy.ts`
- Test: `tests/security/backup-policy.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 2 依赖，签名逐字）:
  - `export const BACKUP_FILE_LIMIT = 100 * 1024 * 1024`
  - `export const ESTIMATE_COUNT_LIMIT = 10000`
  - `interface BackupEntry { path: string; hash: string; at: number; size: number }`
  - `snapshotName(content: Buffer): string`
  - `appendEntry(entries: BackupEntry[], entry: BackupEntry): BackupEntry[]`
  - `totalSize(entries: BackupEntry[]): number`
  - `selectEvictions(entries: BackupEntry[], maxBytes: number): BackupEntry[]`
  - `orphanedHashes(remaining: BackupEntry[], evicted: BackupEntry[]): string[]`

- [ ] **Step 1: 写失败测试** — `tests/security/backup-policy.test.ts`：

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendEntry,
  ESTIMATE_COUNT_LIMIT,
  orphanedHashes,
  selectEvictions,
  snapshotName,
  totalSize,
  type BackupEntry,
} from "../../electron/domains/security/backup-policy";

const entry = (over: Partial<BackupEntry> = {}): BackupEntry => ({
  path: "/tmp/ws/a.ts",
  hash: "h1",
  at: 1000,
  size: 100,
  ...over,
});

describe("snapshotName", () => {
  it("sha256 前 32 hex，同内容稳定", () => {
    const expectHex = createHash("sha256").update("hello").digest("hex").slice(0, 32);
    expect(snapshotName(Buffer.from("hello"))).toBe(expectHex);
    expect(snapshotName(Buffer.from("hello"))).toBe(
      snapshotName(Buffer.from("hello")),
    );
    expect(snapshotName(Buffer.from("world"))).not.toBe(expectHex);
  });
});

describe("appendEntry / totalSize", () => {
  it("追加不改原数组（不可变）；totalSize 求和", () => {
    const a = [entry()];
    const next = appendEntry(a, entry({ hash: "h2", size: 50 }));
    expect(a).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(totalSize(next)).toBe(150);
  });
});

describe("selectEvictions", () => {
  it("未超配额返回空；超则按 at 升序淘汰最旧直至达标", () => {
    const es = [
      entry({ hash: "new", at: 3000, size: 100 }),
      entry({ hash: "old", at: 1000, size: 100 }),
      entry({ hash: "mid", at: 2000, size: 100 }),
    ];
    expect(selectEvictions(es, 300)).toEqual([]);
    expect(selectEvictions(es, 250)).toEqual([
      entry({ hash: "old", at: 1000, size: 100 }),
    ]);
    expect(selectEvictions(es, 150)).toEqual([
      entry({ hash: "old", at: 1000, size: 100 }),
      entry({ hash: "mid", at: 2000, size: 100 }),
    ]);
  });
  it("maxBytes=0 全淘汰；空表返回空", () => {
    const es = [entry({ hash: "a" }), entry({ hash: "b" })];
    expect(selectEvictions(es, 0)).toHaveLength(2);
    expect(selectEvictions([], 0)).toEqual([]);
  });
});

describe("orphanedHashes", () => {
  it("被淘汰 hash 仍被剩余引用则不删；evicted 内去重", () => {
    const remaining = [entry({ path: "/x", hash: "shared" })];
    const evicted = [
      entry({ path: "/y", hash: "shared" }),
      entry({ path: "/z", hash: "gone" }),
      entry({ path: "/w", hash: "gone" }),
    ];
    expect(orphanedHashes(remaining, evicted)).toEqual(["gone"]);
    expect(orphanedHashes([], [])).toEqual([]);
  });
});

describe("常量", () => {
  it("单文件 100MB / 预估上限 10000", () => {
    expect(ESTIMATE_COUNT_LIMIT).toBe(10000);
  });
});
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/backup-policy.test.ts`；Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现** — `electron/domains/security/backup-policy.ts`：

```ts
/**
 * 备份决策纯函数层（SP4 spec §3）：快照命名（内容寻址）、manifest 追加、
 * 配额 LRU 淘汰选择与 orphan 快照判定。无 I/O，Vitest 直测。
 * totalSize 按条目求和——共享快照时保守高估（配额略提前触发，方向安全）。
 */
import { createHash } from "node:crypto";

/** 单文件备份上限（WorkBuddy 同构语义） */
export const BACKUP_FILE_LIMIT = 100 * 1024 * 1024;
/** 目录预估计数上限（达限即停——≥ 阈值即触发，无需精确数） */
export const ESTIMATE_COUNT_LIMIT = 10000;

/** manifest 条目：原路径 + 快照名 + 备份时间戳(ms) + 字节 */
export interface BackupEntry {
  path: string;
  hash: string;
  at: number;
  size: number;
}

/** 快照文件名 = sha256(content) 前 32 hex（内容寻址，同内容天然去重） */
export function snapshotName(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** manifest 追加（不可变——不去重：同内容多时间点各记一行，LRU 需要最新 at） */
export function appendEntry(
  entries: BackupEntry[],
  entry: BackupEntry,
): BackupEntry[] {
  return [...entries, entry];
}

/** 全局已用字节 = 条目 size 之和 */
export function totalSize(entries: BackupEntry[]): number {
  return entries.reduce((sum, e) => sum + e.size, 0);
}

/** LRU 淘汰选择：按 at 升序累计，返回需删除条目（至总量 ≤ maxBytes） */
export function selectEvictions(
  entries: BackupEntry[],
  maxBytes: number,
): BackupEntry[] {
  if (totalSize(entries) <= maxBytes) return [];
  const evicted: BackupEntry[] = [];
  let size = totalSize(entries);
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (size <= maxBytes) break;
    evicted.push(e);
    size -= e.size;
  }
  return evicted;
}

/** 淘汰条目中 hash 不再被剩余条目引用的（→ 可删快照文件） */
export function orphanedHashes(
  remaining: BackupEntry[],
  evicted: BackupEntry[],
): string[] {
  const live = new Set(remaining.map((e) => e.hash));
  return [...new Set(evicted.map((e) => e.hash))].filter((h) => !live.has(h));
}
```

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/backup-policy.test.ts`；Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/backup-policy.ts tests/security/backup-policy.test.ts
git commit -m "feat(安全中心): 备份决策纯函数——内容寻址快照名/manifest 追加/LRU 淘汰选择/orphan 判定"
```

---

### Task 2: FileHistoryService + countFilesForEstimate

**Files:**
- Create: `electron/domains/security/file-history.ts`
- Test: `tests/security/file-history.test.ts`

**Interfaces:**
- Consumes: Task 1 全部导出
- Produces（Task 3/4 依赖，签名逐字）:
  - `export type BackupFileResult = { ok: true; size: number } | { ok: false; reason: string }`
  - `class FileHistoryService { constructor(rootDir: string, getMaxBytes: () => number); async backupFile(absPath: string, sessionId: number): Promise<BackupFileResult>; async enforceNow(): Promise<void> }`
  - `export async function countFilesForEstimate(root: string): Promise<number>`

- [ ] **Step 1: 写失败测试** — `tests/security/file-history.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countFilesForEstimate,
  FileHistoryService,
} from "../../electron/domains/security/file-history";
import { snapshotName, type BackupEntry } from "../../electron/domains/security/backup-policy";

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
    fs.readFileSync(path.join(ROOT, String(sessionId), "manifest.json"), "utf8"),
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
    expect(await svc(1 << 30).backupFile(target, 9)).toEqual({ ok: true, size: 1 });
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
```

**测试修正说明（写测试时落实）**：`FileHistoryService` 另导出 `async enforceNow(): Promise<void>`（public，backupFile 内部也调它；测试直接调它驱动配额检查）。

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/file-history.test.ts`；Expected: FAIL。
- [ ] **Step 3: 实现** — `electron/domains/security/file-history.ts`：

```ts
/**
 * 文件历史备份服务（SP4 spec §4）：write_file 覆盖前 / delete_file 永久
 * 删除前的内容寻址快照。目录：rootDir/<sessionId>/{manifest.json, <sha256-32>}。
 * 快照与 manifest 均临时名 + rename 原子落盘；manifest 损坏丢弃重建。
 * 配额 LRU 跨会话全局淘汰（总量按条目 size 求和，共享快照保守高估）。
 * fail-open：一切异常以 { ok:false, reason } 返回，调用方决定审计与是否继续。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import Log from "../../commons/Log";
import {
  appendEntry,
  BACKUP_FILE_LIMIT,
  orphanedHashes,
  selectEvictions,
  snapshotName,
  totalSize,
  type BackupEntry,
} from "./backup-policy";

export type BackupFileResult =
  | { ok: true; size: number }
  | { ok: false; reason: string };

/** manifest 读：损坏/缺失返回 []（保守丢弃重建） */
async function readManifest(sessionDir: string): Promise<BackupEntry[]> {
  try {
    const raw = await fsp.readFile(path.join(sessionDir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackupEntry[]) : [];
  } catch {
    return [];
  }
}

/** 临时名 + rename 原子写（单写者主进程，tmp 名固定无并发） */
async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/** 批量预估（模块级函数，无状态）：walk 计数，达 ESTIMATE_COUNT_LIMIT 即停 */
export async function countFilesForEstimate(root: string): Promise<number> {
  let count = 0;
  const stack = [root];
  while (stack.length > 0 && count < 10000) {
    const cur = stack.pop() as string;
    const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (count >= 10000) break;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) count += 1;
    }
  }
  return count;
}

export class FileHistoryService {
  constructor(
    private readonly rootDir: string,
    private readonly getMaxBytes: () => number,
  ) {}

  /** 覆盖/永久删除前调用：>100MB 或非文件 skip；成功 → 落快照 + manifest + 配额 */
  async backupFile(
    absPath: string,
    sessionId: number,
  ): Promise<BackupFileResult> {
    try {
      const stat = await fsp.stat(absPath);
      if (!stat.isFile()) return { ok: false, reason: "not-file" };
      if (stat.size > BACKUP_FILE_LIMIT) return { ok: false, reason: "oversize" };
      const content = await fsp.readFile(absPath);
      const hash = snapshotName(content);
      const dir = path.join(this.rootDir, String(sessionId));
      await fsp.mkdir(dir, { recursive: true });
      const snap = path.join(dir, hash);
      if (!(await fsp.stat(snap).then(() => true, () => false))) {
        await atomicWrite(snap, content);
      }
      const next = appendEntry(await readManifest(dir), {
        path: absPath,
        hash,
        at: Date.now(),
        size: stat.size,
      });
      await atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(next));
      await this.enforceNow();
      return { ok: true, size: stat.size };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 配额 LRU：跨会话收集全部 manifest → 淘汰最旧 → 写回剩余 → 删 orphan 快照 */
  async enforceNow(): Promise<void> {
    try {
      const sids = await fsp.readdir(this.rootDir).catch(() => [] as string[]);
      const perSession: { dir: string; entries: BackupEntry[] }[] = [];
      for (const sid of sids) {
        const dir = path.join(this.rootDir, sid);
        const entries = await readManifest(dir);
        if (entries.length > 0) perSession.push({ dir, entries });
      }
      const merged = perSession.flatMap((s) => s.entries);
      const evicted = selectEvictions(merged, this.getMaxBytes());
      if (evicted.length === 0) return;
      const evictSet = new Set(evicted);
      const orphans = orphanedHashes(
        merged.filter((e) => !evictSet.has(e)),
        evicted,
      );
      for (const { dir, entries } of perSession) {
        const rest = entries.filter((e) => !evictSet.has(e));
        if (rest.length !== entries.length) {
          await atomicWrite(
            path.join(dir, "manifest.json"),
            JSON.stringify(rest),
          );
        }
      }
      for (const hash of orphans) {
        for (const { dir, entries } of perSession) {
          if (entries.some((e) => e.hash === hash)) {
            await fsp.rm(path.join(dir, hash), { force: true });
          }
        }
      }
    } catch (e) {
      Log.error("备份配额清理失败", e);
    }
  }
}
```

注意两点（实现时落实，代码里已体现）：`countFilesForEstimate` 内上限字面量 `10000` 换用 `ESTIMATE_COUNT_LIMIT`（import 补）；orphan 删除按"该会话 manifest 曾含此 hash"定位会话目录（上例实现即此语义——共享快照在两个会话目录各有一份文件，各自独立存在，删除只删本会话内不再引用的那份）。

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/file-history.test.ts`；Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/file-history.ts tests/security/file-history.test.ts
git commit -m "feat(安全中心): FileHistoryService——内容寻址快照+原子 manifest+跨会话配额 LRU+预估计数"
```

---

### Task 3: delete_file 工具 + write_file 备份接入（file-tools.ts）

**Files:**
- Modify: `electron/domains/ai/agent/file-tools.ts`（ToolContext 加 2 字段、write_file 备份、delete_file 工具、makeFileTool 联合扩展）
- Test: `tests/security/delete-file-tool.test.ts`

**Interfaces:**
- Consumes: Task 2 `BackupFileResult`
- Produces（Task 4 依赖）:
  - `ToolContext.deleteProtection?: boolean`（缺省 true）
  - `ToolContext.onBackupFile?: (absPath: string, sessionId: number) => Promise<BackupFileResult>`
  - FILE_TOOLS 含 `delete_file`；`makeFileTool` name 联合加 `"delete_file"`

- [ ] **Step 1: 写失败测试** — `tests/security/delete-file-tool.test.ts`：

```ts
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
  onBackupFile?: (absPath: string, sessionId: number) => Promise<BackupFileResult>;
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
    const out = await makeFileTool("delete_file").execute(ctx, { path: "t1.txt" });
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
    const out = await makeFileTool("delete_file").execute(ctx, { path: "nope" });
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
    const out = await makeFileTool("delete_file").execute(ctx, { path: "t2.txt" });
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
    const out = await makeFileTool("delete_file").execute(ctx, { path: "t3.txt" });
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
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/delete-file-tool.test.ts`；Expected: FAIL（makeFileTool 无 "delete_file"、字段不存在）。

- [ ] **Step 3: 实现** — `electron/domains/ai/agent/file-tools.ts` 三处修改：

3a. ToolContext 加字段（`commandWatchBlacklist` 字段后）+ 顶部 import 与审计 helper：

```ts
import type { BackupFileResult } from "../../security/file-history";
import { shell } from "electron";
```

（`ToolContext` 内追加：）

```ts
  /** 删除保护（SP4）：true=trashItem 进系统回收站；装配注入，缺省 true 与默认配置一致 */
  deleteProtection?: boolean;
  /** 备份回调（SP4）：write_file 覆盖前 / delete_file 永久删除前调用；缺省不备份 */
  onBackupFile?: (
    absPath: string,
    sessionId: number,
  ) => Promise<BackupFileResult>;
```

（模块级 helper——emitDataEvent 照 chat.service emitFileEvent 的 path 截 200 风格：）

```ts
/** 数据安全审计事件（detail.path 截 200） */
function emitDataEvent(
  ctx: ToolContext,
  eventType: string,
  decision: "info" | "failed",
  detail: Record<string, unknown>,
): void {
  if ("path" in detail && typeof detail.path === "string") {
    detail.path = detail.path.slice(0, 200);
  }
  ctx.onSecurityEvent?.({
    eventType,
    decision,
    detail,
    sessionId: ctx.sessionId,
  });
}

/** 备份并审计（SP4）：成功 backup-created；失败 backup-skipped（reason=disabled 静默）；返回是否成功 */
async function backupAndAudit(
  ctx: ToolContext,
  absPath: string,
): Promise<boolean> {
  if (!ctx.onBackupFile) return false;
  const r = await ctx.onBackupFile(absPath, ctx.sessionId);
  if (r.ok) {
    emitDataEvent(ctx, "data-safety.backup-created", "info", {
      path: absPath,
      size: r.size,
    });
    return true;
  }
  if (r.reason !== "disabled") {
    emitDataEvent(ctx, "data-safety.backup-skipped", "info", {
      path: absPath,
      reason: r.reason.slice(0, 200),
    });
  }
  return false;
}
```

3b. write_file execute 内、`resolveSafePath` 成功后 `mkdir` 前插入（目标已存在才备份）：

```ts
      if (
        (await fs.stat(target).then(
          (s) => s.isFile(),
          () => false,
        )) &&
        ctx.onBackupFile
      ) {
        await backupAndAudit(ctx, target); // fail-open：失败不中断写入
      }
```

3c. 新工具（search_files 之后、FILE_TOOLS 装配处加 `deleteFileTool`）：

```ts
// ---------- delete_file ----------

const deleteFileSchema = z.object({
  path: z.string().describe("要删除的文件或目录（工作空间内相对路径；目录递归删除）"),
});

/** 目录树收集全部文件绝对路径（预估走门层 countFilesForEstimate；此处供备份遍历） */
async function listFilesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) files.push(full);
    }
  }
  return files;
}

const deleteFileTool: ToolDefinition<z.infer<typeof deleteFileSchema>> = {
  name: "delete_file",
  description:
    "删除文件或目录（目录递归）。默认移入系统回收站（可在安全中心-数据安全调整）；大目录会请求确认。优先使用本工具而非 rm 命令。",
  parameters: deleteFileSchema,
  kind: "write",
  execute: async (ctx, args) => {
    try {
      if (!args.path.trim()) return fail("路径不能为空");
      const target = resolveSafePath(ctx.workspacePath, args.path, ctx.fullAccess);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) return fail("文件不存在");
      const rel = args.path;
      if (ctx.deleteProtection !== false) {
        try {
          await shell.trashItem(target);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          emitDataEvent(ctx, "data-safety.delete-failed", "failed", {
            path: rel,
            error: error.slice(0, 200),
          });
          return fail(`移入回收站失败: ${error}（文件已保留）`);
        }
        emitDataEvent(ctx, "data-safety.delete-trashed", "info", { path: rel });
        return `已将 ${rel} 移入回收站`;
      }
      const files = stat.isDirectory() ? await listFilesUnder(target) : [target];
      let backed = 0;
      for (const f of files) {
        if (await backupAndAudit(ctx, f)) backed += 1;
      }
      await fs.rm(target, { recursive: true, force: false });
      emitDataEvent(ctx, "data-safety.delete-permanent", "info", {
        path: rel,
        files: files.length,
      });
      return `已永久删除 ${rel}（${files.length} 个文件，已备份 ${backed} 个）`;
    } catch (e) {
      return toToolResult(e);
    }
  },
};
```

`makeFileTool` 的 name 联合加 `"delete_file"`。

**注意**：`listFilesUnder` 与 backupAndAudit 若使某函数超 20 行上限，照仓库既有惯例提取（execute 主流程 ≤20 行为目标，超出则把永久删除分支提取为 `permanentDelete(ctx, target, rel)` 私有函数——实现者自行落位，测试已锁定行为）。

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/delete-file-tool.test.ts`；Expected: PASS。再跑 `npx vitest run tests/security/ tests/ai/`；Expected: 全绿（回归——file-tools 被广泛引用）。
- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/file-tools.ts tests/security/delete-file-tool.test.ts
git commit -m "feat(安全中心): delete_file 工具（trashItem/备份后永久删）+ write_file 覆盖前备份接入"
```

---

### Task 4: 门层接入 + 装配（chat.service / automation-runner / Application）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`
- Modify: `electron/domains/ai/automation/automation-runner.ts`
- Modify: `electron/Application.ts`
- Test: `tests/security/bulk-delete-gate.test.ts`

**Interfaces:**
- Consumes: Task 2 `countFilesForEstimate`；Task 3 工具与 ToolContext 字段
- Produces:
  - `AgentStreamOptions.bulkDeleteThreshold?: number`（缺省 50）
  - `AgentStreamOptions.deleteProtection?: boolean`
  - `AgentStreamOptions.onBackupFile?: (absPath: string, sessionId: number) => Promise<BackupFileResult>`
  - `interface ChatDataSafety { backupFile: (absPath: string, sessionId: number) => Promise<BackupFileResult>; deleteProtection: () => boolean; bulkDeleteThreshold: () => number }`（chat.service export）
  - ChatService 构造可选第 5 参 `dataSafety?: ChatDataSafety`

- [ ] **Step 1: 写失败测试** — `tests/security/bulk-delete-gate.test.ts`：

```ts
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
      agent.events.some((e) => e.eventType === "data-safety.bulk-delete-needs-approval"),
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
    await runToolCall(makeFileTool("delete_file"), agent, "b4", { path: "secret" }, undefined);
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
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/bulk-delete-gate.test.ts`；Expected: FAIL（bulkDeleteThreshold 字段/门不存在）。

- [ ] **Step 3: 实现**

3a. `chat.service.ts`：
- import 补：`import { countFilesForEstimate } from "../../security/file-history";`、`import type { BackupFileResult } from "../../security/file-history";`
- `AgentStreamOptions` 加 3 可选字段（decideFileAccess 旁，JSDoc 标注 SP4 与缺省值——bulkDeleteThreshold 缺省 50、deleteProtection 缺省 true）
- export `ChatDataSafety` 接口；`ChatService` 构造第 5 可选参 `dataSafety?: ChatDataSafety`（存私有字段）
- 模块级（FILE_GATE_TOOLS 旁）：

```ts
const FILE_GATE_TOOLS = new Set(["read_file", "write_file", "list_dir", "delete_file"]);
const BULK_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可执行批量删除，请调整安全中心阈值或改为人工会话执行";
const BULK_DELETE_THRESHOLD_DEFAULT = 50;

/** 批量删除预估（SP4）：delete_file 且目录预估 ≥ 阈值 → 估值；不涉及返回 null */
async function resolveBulkDelete(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): Promise<number | null> {
  if (toolName !== "delete_file" || !agent.workspacePath) return null;
  const rel = (input as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || rel === "") return null;
  try {
    const abs = resolveSafePath(agent.workspacePath, rel, agent.fullAccess());
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) return null;
    const threshold = agent.bulkDeleteThreshold ?? BULK_DELETE_THRESHOLD_DEFAULT;
    const count = await countFilesForEstimate(abs);
    return count >= threshold ? count : null;
  } catch {
    return null;
  }
}
```

（若 `fs` 未 import 则补 `import fs from "node:fs";`——以现状为准。）

- `runToolCall` 文件门 block/allow 段之后、`needsApproval` 之前插入：

```ts
  const bulkEstimate = await resolveBulkDelete(agent, def.name, input);
  if (bulkEstimate !== null && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: BULK_UNATTENDED_OUTPUT,
    });
    emitFileEvent(agent, input, "data-safety.bulk-delete-rejected", "rejected", {
      estimated: bulkEstimate,
      reason: "unattended",
    });
    return BULK_UNATTENDED_OUTPUT;
  }
  if (bulkEstimate !== null) {
    emitFileEvent(agent, input, "data-safety.bulk-delete-needs-approval", "info", {
      estimated: bulkEstimate,
    });
  }
```

- `needsApproval` 表达式最前追加 `bulkEstimate !== null ||`（其余不动）
- `executeToolSafe` 的 ToolContext 字面量加：

```ts
        // SP4 数据安全：删除保护与备份回调（装配快照，每流一次）
        deleteProtection: agent.deleteProtection,
        onBackupFile: agent.onBackupFile,
```

- `resolveAgentOptions` 返回字面量加（requestApproval 旁）：

```ts
      // SP4 数据安全：闭包实时读配置（运行中改配置即生效）
      deleteProtection: this.dataSafety?.deleteProtection() ?? true,
      bulkDeleteThreshold:
        this.dataSafety?.bulkDeleteThreshold() ?? BULK_DELETE_THRESHOLD_DEFAULT,
      onBackupFile: this.dataSafety
        ? (absPath, sid) => this.dataSafety!.backupFile(absPath, sid)
        : undefined,
```

3b. `automation-runner.ts`：装配字面量（decideFileAccess: fileGate 旁）加同款 3 字段——数据源：automation-runner 现无 SecurityService/FileHistoryService 依赖，**裁定**：automation 的 agent options 里 `onBackupFile/deleteProtection/bulkDeleteThreshold` 从其构造新增可选参 `dataSafety?: ChatDataSafety`（import from `../../chat/chat.service`——automation-runner 已 import chat.service 的类型/函数，以现状 import 路径为准）透传，缺省 undefined（automation 无备份与批量门——unattended 流已有强拒兜底）。

3c. `Application.ts`（installFileGate 之后、new ChatService 之前）：

```ts
    // SP4 数据安全：备份服务 + ChatService 数据安全装配（闭包实时读配置）
    const fileHistory = new FileHistoryService(
      path.join(app.getPath("userData"), "file-history"),
      () =>
        securityService.getConfigValue().fileBackupMaxSizeMB * 1024 * 1024,
    );
```

`new ChatService(...)` 加第 5 参：

```ts
    new ChatService(sessionRepo, skillRepo, projectRepo, (event) =>
      auditLogService.append(event),
      {
        backupFile: (absPath, sessionId) => {
          if (!securityService.getConfigValue().fileBackupEnabled) {
            return Promise.resolve({ ok: false, reason: "disabled" });
          }
          return fileHistory.backupFile(absPath, sessionId);
        },
        deleteProtection: () =>
          securityService.getConfigValue().deleteProtection,
        bulkDeleteThreshold: () =>
          securityService.getConfigValue().bulkDeleteThreshold,
      },
    );
```

（import 补 `FileHistoryService`；`path` 已有 import 则复用。）

- [ ] **Step 4: 全量验证** — Run: `npm run test && npm run typecheck && npm run lint`；Expected: 全绿（回归——非 delete_file 路径逐字节不变）。
- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/chat/chat.service.ts electron/domains/ai/automation/automation-runner.ts electron/Application.ts tests/security/bulk-delete-gate.test.ts
git commit -m "feat(安全中心): 批量删除预估门——目录 ≥ 阈值强制审批（unattended 强拒）+ delete_file 进文件门 + 备份/删除保护装配"
```

---

### Task 5: i18n 双语 7 key + AuditCenter 兜底变量 + 守卫测试

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/security.json`、`en-US/security.json`（audit.events 加 7 key）
- Modify: `src-react/domains/security/components/AuditCenter.tsx`（entryText 兜底变量加 size/reason/files/error/estimated）
- Modify: `tests/security/audit-event-message.test.ts`（known 列表 +7）

- [ ] **Step 1: zh-CN `audit.events` 追加**：

```json
"data-safety_backup-created": "文件已备份: {{path}}（{{size}} 字节）",
"data-safety_backup-skipped": "文件备份跳过: {{path}}（{{reason}}）",
"data-safety_delete-trashed": "已移入回收站: {{path}}",
"data-safety_delete-permanent": "已永久删除: {{path}}（{{files}} 个文件）",
"data-safety_delete-failed": "删除失败: {{path}}（{{error}}）",
"data-safety_bulk-delete-needs-approval": "批量删除需审批: {{path}}（预估 {{estimated}} 个文件）",
"data-safety_bulk-delete-rejected": "批量删除已拒绝: {{path}}（预估 {{estimated}} 个文件）"
```

en-US 同 key 镜像（插值变量一致），示例：
`"File backed up: {{path}} ({{size}} bytes)"`、`"File backup skipped: {{path}} ({{reason}})"`、`"Moved to trash: {{path}}"`、`"Permanently deleted: {{path}} ({{files}} files)"`、`"Delete failed: {{path}} ({{error}})"`、`"Bulk delete needs approval: {{path}} (~{{estimated}} files)"`、`"Bulk delete rejected: {{path}} (~{{estimated}} files)"`。

- [ ] **Step 2: AuditCenter entryText 兜底变量**——在 path 兜底旁补 `size`、`reason`、`files`、`error`、`estimated`（`String(detail.xxx ?? "")` 形态，照 path 先例）。
- [ ] **Step 3: 守卫测试** known 列表按事件族归位追加 7 项：`data-safety.backup-created`、`data-safety.backup-skipped`、`data-safety.delete-trashed`、`data-safety.delete-permanent`、`data-safety.delete-failed`、`data-safety.bulk-delete-needs-approval`、`data-safety.bulk-delete-rejected`。
- [ ] **Step 4: 验证** — Run: `npx vitest run tests/security/audit-event-message.test.ts && npm run typecheck && npm run lint`；双语 key 脚本比对一致（zh/en 扁平化逐 key 相等）。
- [ ] **Step 5: Commit**

```bash
git add src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json src-react/domains/security/components/AuditCenter.tsx tests/security/audit-event-message.test.ts
git commit -m "feat(安全中心): data-safety 7 审计事件双语文案 + 兜底变量 + 守卫测试登记"
```

---

### Task 6: 手工验收 + 收尾

**Files:**
- Create: `docs/superpowers/acceptance/2026-09-17-security-center-sp4.md`

- [ ] **Step 1: 全量验证** — `npm run test && npm run typecheck && npm run lint` 三绿。
- [ ] **Step 2: 验收清单**（样式照 SP3，含自动化验证数字）：
  - 备份目录结构走查：会话目录/快照名 = sha256 前 32/manifest.json 可读且 path 为绝对路径；「打开备份目录」直达
  - default 模式让 AI 覆盖写入既有文件 → 审批通过后 file-history 出现快照 + 审计中心「文件已备份」双语渲染
  - 关闭自动备份开关 → 覆盖写入不再产生快照（审计无 backup-skipped 噪音）
  - `delete_file` 默认移入回收站（Finder 可找回）+ 审计「已移入回收站」
  - 关闭删除保护 → 永久删除前快照 + 审计「已永久删除（N 个文件）」
  - 批量阈值：造 ≥ 阈值目录让 AI 删 → 完全访问模式也弹审批；automation（unattended）同任务 → 强拒
  - en-US 切换后 7 事件渲染正确（插值 path/size/files/estimated）
  - SP3 回归：命令门/文件门行为不变（read_file 黑名单审批等抽查）
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/acceptance/2026-09-17-security-center-sp4.md
git commit -m "docs(安全中心): SP4 手工验收清单"
```

---

## 收尾验证

- [ ] 全量三绿（新增 tests/security/backup-policy|file-history|delete-file-tool|bulk-delete-gate）
- [ ] spec §1 不做清单未越界（无恢复 UI/无 rm 侧预估/无时间清理）
- [ ] 非 delete_file 工具且两门 null 时链路逐字节不变（既有测试全绿佐证）

## Self-Review 记录

- Spec 覆盖：§3 纯函数（T1）、§4 服务（T2）、§5 工具与接入（T3）、§6 门层与装配（T4）、§7 审计与 i18n（T3 事件源 + T5 词条）、§8 错误处理（T2/T3 内嵌 fail-open/原子写/损坏重建）、§9 测试（各任务）——无缺口
- **spec 勘误（计划期裁定，随本计划记录）**：
  1. `onBackupFile` 回调签名从 spec 的 `=> void` 改为 `=> Promise<BackupFileResult>`——工具层需备份成败判定统计"已备份 N 个"并发 backup-skipped 审计
  2. `BackupFileResult` ok 分支补 `size: number`——spec §7 backup-created detail 含 size，工具层从结果取
  3. spec §4 `enforceQuota(maxBytes)` 内部签名落地为 `enforceNow()` public 方法 + 构造注入 `getMaxBytes` 闭包（配置实时读；测试可直驱配额）
  4. spec §5 "deleteProtection 装配时快照、运行中改配置下个会话生效"升级为 **resolveAgentOptions 每流装配时闭包实时读**（Automation 同理）——改配置即时生效，成本为零
  5. ChatService 构造加可选第 5 参 `dataSafety?: ChatDataSafety`（backupFile/deleteProtection()/bulkDeleteThreshold() 三闭包）；automation-runner 侧可选注入、缺省 undefined（unattended 流已有强拒兜底）
  6. 备份关闭时装配闭包返回 `{ ok: false, reason: "disabled" }`，工具层对 disabled 静默（不产生 backup-skipped 审计噪音）
- 类型一致性：BackupEntry/snapshotName 等（T1→T2）、BackupFileResult/countFilesForEstimate/FileHistoryService（T2→T3/T4）、ToolContext.deleteProtection/onBackupFile + makeFileTool("delete_file")（T3→T4）、AgentStreamOptions 3 字段 + ChatDataSafety（T4 内自洽）
- 已知注记：T3 `listFilesUnder` 若致超行按私有函数提取；共享快照的磁盘双份（两会话各一份）与 totalSize 保守求和已记 spec §4
