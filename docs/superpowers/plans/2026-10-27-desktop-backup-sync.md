# 桌面端数据备份/下载（双向同步）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端全量数据（SQLite 快照 + 资产目录）打成 tar.gz 整包，分块上传至无头服务端存档、下载恢复——方向双向的备份/下载能力。

**Architecture:** server 端新 `modules/backup/`（六端点 JSON+base64 分块协议 + 二层 token 守卫 + `TIANSHU_BACKUP_DIR` 可配备份根）；桌面端新 `electron/domains/backup/`（手写 ustar+gzip 打包器 → better-sqlite3 在线快照 → 分块 HTTP 客户端 → staging 原子切换恢复）；契约类型收 `@tianshu/protocol`。UI 挂设置面板 SettingsDialog 新 BackupGroup。

**Tech Stack:** NestJS/Fastify（server）、Electron 主进程 Node 24 fetch、better-sqlite3（已在 dependencies）、Node zlib gzip（零新依赖）、Vitest/Jest。

**Spec:** `docs/superpowers/specs/2026-10-27-desktop-backup-sync-batch-design.md`

## Global Constraints

- **零新依赖**：依赖白名单互锁不动（better-sqlite3 ^12.6.2 已在 dependencies；gzip 用 Node 内置 zlib）
- **代码风格**：mirror 双引号、无尾随逗号；apps/tianshu-server 单引号、trailingComma=all；文件名一律 kebab-case
- **分块协议**：原始字节 ≤4MB/块（`BACKUP_CHUNK_BYTES`），base64 in JSON（~5.3MB < Fastify bodyLimit 16MB）；全端点 POST
- **备份内容**：`database/local.db` 快照 + `skills/ library/ attachments/ workflow-assets/ projects/` + `.jwt-secret`；**排除** `logs/ file-history/`
- **备份根解析**：`TIANSHU_BACKUP_DIR` env > `<server 数据根>/backups`（server 数据根= `TIANSHU_DATA_ROOT` env > `~/.tianshu-server`，files.service resolveDataRoot 同源）
- **鉴权**：全局 StaticTokenGuard 自动第一层；`TIANSHU_BACKUP_TOKEN` env 设置时 BackupGuard 只认它（timingSafeEqual 定长摘要，token.guard.ts 同款）
- **ustar 约束**：路径（prefix+name）超 255 **报错中止**，不静默跳过
- **i18n**：UI 文本禁硬编码，zh-CN/en-US 双语同任务落；样式只用主题变量
- **vitest 原生模块替身法**：better-sqlite3 在 vitest（node ABI）不可加载——snapshot 的 db 快照函数必须注入化设计，单测注入替身（保留策略批先例）
- **server 侧测试**：jest，`npm run test -w apps/tianshu-server`；mirror 侧 `npm run test -- tests/ai/backup`
- **提交纪律**：每任务一提交，conventional commit；改协议包后 server 侧需 `npm run sync:core` 重建 dist

---

### Task 1: 协议包 backup-contract（双端契约先行）

**Files:**
- Create: `packages/tianshu-protocol/src/backup-contract.ts`
- Modify: `packages/tianshu-protocol/src/index.ts`（追加 `export * from "./backup-contract";`，按字母序插在 agent-runner 之后）
- Test: `tests/ai/backup/backup-contract.test.ts`

**Interfaces:**
- Consumes: 无（纯类型+常量包，零运行时依赖）
- Produces: 后续所有任务引用的类型与常量（下述完整定义——Task 2/3/6/8 直接 import）

- [ ] **Step 1: 写失败测试** `tests/ai/backup/backup-contract.test.ts`

```ts
// backup 契约编译期断言（protocol-package 契约测试同位惯例）：
// 常量值锁定 + 类型结构编译通过
import { describe, expect, it } from "vitest";
import {
  BACKUP_CHUNK_BYTES,
  DEFAULT_BACKUP_MAX_KEEP,
  DEFAULT_BACKUP_MAX_SIZE_BYTES,
  type BackupMeta,
  type BackupCreateRequest,
  type BackupChunkRequest,
  type BackupDownloadRequest,
  type BackupDownloadResult,
  type BackupCommitResult
} from "@tianshu/protocol";

describe("backup-contract", () => {
  it("分块与上限常量锁定（协议演化须显式改这里）", () => {
    expect(BACKUP_CHUNK_BYTES).toBe(4 * 1024 * 1024);
    expect(DEFAULT_BACKUP_MAX_KEEP).toBe(10);
    expect(DEFAULT_BACKUP_MAX_SIZE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
  it("BackupMeta 结构编译期断言（status 含 uploading/ready 两态）", () => {
    const meta: BackupMeta = {
      id: "b1",
      createdAt: "2026-10-27T00:00:00.000Z",
      appVersion: "1.0.0",
      schemaVersion: 1,
      fileSize: 100,
      sha256: "a".repeat(64),
      chunkCount: 1,
      status: "ready"
    };
    expect(meta.id).toBe("b1");
  });
  it("分块请求形状编译期断言", () => {
    const chunk: BackupChunkRequest = {
      id: "b1",
      seq: 0,
      data: "aGk=",
      chunkSha256: "b".repeat(64)
    };
    const dl: BackupDownloadRequest = { id: "b1", seq: 0 };
    const res: BackupDownloadResult = { data: "aGk=", totalChunks: 1 };
    const commit: BackupCommitResult = { fileSize: 100, sha256: "a".repeat(64) };
    expect([chunk, dl, res, commit]).toHaveLength(4);
  });
  it("create 请求形状编译期断言", () => {
    const req: BackupCreateRequest = {
      appVersion: "1.0.0",
      schemaVersion: 1,
      fileSize: 100,
      sha256: "a".repeat(64),
      chunkCount: 1,
      note: "首档",
      deviceName: "mac"
    };
    expect(req.chunkCount).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）

Run: `npm run test -- tests/ai/backup/backup-contract.test.ts`
Expected: FAIL（`@tianshu/protocol` 无此导出）

- [ ] **Step 3: 实现** `packages/tianshu-protocol/src/backup-contract.ts`

```ts
/**
 * 备份/下载批契约（spec 2026-10-27）：桌面端全量数据备份上传/下载恢复
 * 六端点 DTO + 常量。server DTO 与桌面端请求体均自本包引用，防双端漂移。
 */
/** 分块原始字节上限（4MB；base64 后 ~5.3MB < server bodyLimit 16MB） */
export const BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
/** 默认保留份数（server option 表 type="app" name="backupMaxKeep" 可配） */
export const DEFAULT_BACKUP_MAX_KEEP = 10;
/** 单备份大小上限（默认 2GB） */
export const DEFAULT_BACKUP_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** 备份元数据（list 返回行 + 落盘 meta.json 同构） */
export interface BackupMeta {
  id: string;
  /** ISO 时间戳 */
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  fileSize: number;
  /** 整包 sha256（hex） */
  sha256: string;
  chunkCount: number;
  note?: string;
  deviceName?: string;
  /** uploading=分块未 commit；ready=定稿可下载 */
  status: "uploading" | "ready";
}

export interface BackupCreateRequest {
  appVersion: string;
  schemaVersion: number;
  fileSize: number;
  sha256: string;
  chunkCount: number;
  note?: string;
  deviceName?: string;
}

export interface BackupChunkRequest {
  id: string;
  /** 0 起，须连续提交 */
  seq: number;
  /** 原始字节 base64（≤ BACKUP_CHUNK_BYTES） */
  data: string;
  chunkSha256: string;
}

export interface BackupDownloadRequest {
  id: string;
  seq: number;
}

export interface BackupDownloadResult {
  data: string;
  totalChunks: number;
}

export interface BackupCommitResult {
  fileSize: number;
  sha256: string;
}

export interface BackupListResult {
  backups: BackupMeta[];
}

export interface BackupDeleteResult {
  deleted: true;
}
```

`packages/tianshu-protocol/src/index.ts` 头注释「十六模块聚合」补 backup-contract 一行 + `export * from "./backup-contract";`（按字母序插在 agent-runner 与 chat-contract 之间）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- tests/ai/backup/backup-contract.test.ts`
Expected: PASS（3+ 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/tianshu-protocol/src/backup-contract.ts packages/tianshu-protocol/src/index.ts tests/ai/backup/backup-contract.test.ts
git commit -m "feat(protocol): backup-contract 备份分块契约——六端点 DTO+常量"
```

---

### Task 2: server 端 backup-root + BackupService（TDD service 面直测）

**Files:**
- Create: `apps/tianshu-server/src/commons/util/path.util.ts`（expandHome/resolveDataRoot 自 files.service:30-45 提取，DRY 收口）
- Modify: `apps/tianshu-server/src/modules/files/files.service.ts:30-45`（删私有实现改引 commons）
- Create: `apps/tianshu-server/src/modules/backup/backup-root.ts`
- Create: `apps/tianshu-server/src/modules/backup/backup.service.ts`
- Test: `apps/tianshu-server/test/modules/backup.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `@tianshu/protocol` 类型（`BackupMeta` 等）；PrismaService（option 表读写 backupMaxKeep）
- Produces:
  - `resolveBackupRoot(): string`（backup-root.ts）
  - `BackupService.create(req: BackupCreateRequest): Promise<{ id: string }>`
  - `BackupService.putChunk(req: BackupChunkRequest): Promise<{ received: number }>`
  - `BackupService.commit(id: string): Promise<BackupCommitResult>`
  - `BackupService.list(): Promise<BackupListResult>`
  - `BackupService.download(req: BackupDownloadRequest): Promise<BackupDownloadResult>`
  - `BackupService.remove(id: string): Promise<BackupDeleteResult>`
  - 业务异常码：`BACKUP_NOT_FOUND` / `BACKUP_BAD_SEQ` / `BACKUP_CHUNK_HASH` / `BACKUP_HASH_MISMATCH` / `BACKUP_TOO_LARGE` / `BACKUP_UPLOADING_CONFLICT` / `BACKUP_BAD_STATE`（BusinessException，files.service FILES_* 先例）

- [ ] **Step 1: 写失败测试** `apps/tianshu-server/test/modules/backup.spec.ts`（files.spec.ts 样板：env 注入临时目录、prisma stub、service 直测）

```ts
// 无头端 backup 模块（spec 2026-10-27 §2）：create/chunk/commit/list/
// download/delete service 面单测（controller 薄，HTTP 面由 starter 管道保障）。
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from 'src/modules/backup/backup.service';

const prismaStub = {
  option: { findUnique: jest.fn(), upsert: jest.fn() },
};
jest.mock('src/commons/database/prisma.service', () => ({
  PrismaService: jest.fn(() => prismaStub),
}));

// 备份根注入：TIANSHU_BACKUP_DIR 指临时目录（容器卷映射同口径）
const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'backup-svc-'));
process.env.TIANSHU_BACKUP_DIR = backupRoot;
delete process.env.TIANSHU_DATA_ROOT;
prismaStub.option.findUnique.mockResolvedValue(null); // maxKeep 走默认 10

const svc = () => new BackupService(prismaStub as never);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('BackupService', () => {
  const payload = Buffer.alloc(5 * 1024 * 1024, 7); // 5MB → 2 块
  const chunks = [
    payload.subarray(0, 4 * 1024 * 1024),
    payload.subarray(4 * 1024 * 1024),
  ];

  it('create→chunks→commit 全链路：终验落盘 + meta 定稿', async () => {
    const { id } = await svc().create({
      appVersion: '1.0.0', schemaVersion: 1,
      fileSize: payload.length, sha256: sha256(payload), chunkCount: 2,
    });
    expect(id).toBeTruthy();
    for (let seq = 0; seq < 2; seq++) {
      await svc().putChunk({
        id, seq, data: chunks[seq].toString('base64'),
        chunkSha256: sha256(chunks[seq]),
      });
    }
    const committed = await svc().commit(id);
    expect(committed.fileSize).toBe(payload.length);
    expect(committed.sha256).toBe(sha256(payload));
    // 落盘对拍
    const onDisk = readFileSync(path.join(backupRoot, id, 'data.tar.gz'));
    expect(onDisk.equals(payload)).toBe(true);
    expect(existsSync(path.join(backupRoot, id, 'meta.json'))).toBe(true);
  });

  it('seq 跳号拒绝 BACKUP_BAD_SEQ', async () => {
    const { id } = await svc().create({
      appVersion: '1', schemaVersion: 1, fileSize: 10,
      sha256: '0'.repeat(64), chunkCount: 2,
    });
    await svc().putChunk({ id, seq: 0, data: Buffer.from('a').toString('base64'), chunkSha256: sha256(Buffer.from('a')) });
    await expect(svc().putChunk({ id, seq: 2, data: 'YQ==', chunkSha256: sha256(Buffer.from('a')) })).rejects.toMatchObject({ code: 'BACKUP_BAD_SEQ' });
  });

  it('块 hash 不符拒绝 BACKUP_CHUNK_HASH（可重传本块）', async () => {
    const { id } = await svc().create({ appVersion: '1', schemaVersion: 1, fileSize: 1, sha256: '0'.repeat(64), chunkCount: 1 });
    await expect(svc().putChunk({ id, seq: 0, data: 'YQ==', chunkSha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'BACKUP_CHUNK_HASH' });
  });

  it('整包 sha256 不符 commit 拒绝 BACKUP_HASH_MISMATCH', async () => {
    const buf = Buffer.from('hello');
    const { id } = await svc().create({ appVersion: '1', schemaVersion: 1, fileSize: 5, sha256: 'd'.repeat(64), chunkCount: 1 });
    await svc().putChunk({ id, seq: 0, data: buf.toString('base64'), chunkSha256: sha256(buf) });
    await expect(svc().commit(id)).rejects.toMatchObject({ code: 'BACKUP_HASH_MISMATCH' });
  });

  it('超单备份上限拒绝 BACKUP_TOO_LARGE', async () => {
    await expect(svc().create({ appVersion: '1', schemaVersion: 1, fileSize: 3 * 1024 * 1024 * 1024, sha256: '0'.repeat(64), chunkCount: 1 })).rejects.toMatchObject({ code: 'BACKUP_TOO_LARGE' });
  });

  it('download 分块下行：块大小对齐上行 + totalChunks', async () => {
    const list = await svc().list();
    const ready = list.backups.find((b) => b.status === 'ready');
    expect(ready).toBeTruthy();
    const r = await svc().download({ id: ready!.id, seq: 0 });
    expect(r.totalChunks).toBe(2);
    expect(Buffer.from(r.data, 'base64').equals(chunks[0])).toBe(true);
  });

  it('同 id 重复 create 清空重传（幂等重建）', async () => {
    const one = await svc().create({ appVersion: '1', schemaVersion: 1, fileSize: 1, sha256: '0'.repeat(64), chunkCount: 1 });
    await svc().putChunk({ id: one.id, seq: 0, data: 'YQ==', chunkSha256: sha256(Buffer.from('a')) });
    await svc().create({ appVersion: '1', schemaVersion: 1, fileSize: 1, sha256: '0'.repeat(64), chunkCount: 1 }); // 同 id 复用
    // 重新从 seq 0 开始（旧 .part 已清空）
    await svc().putChunk({ id: one.id, seq: 0, data: 'YQ==', chunkSha256: sha256(Buffer.from('a')) });
  });

  it('delete 后 list 不见 + 目录移除', async () => {
    const list0 = await svc().list();
    const target = list0.backups.find((b) => b.status === 'ready')!;
    await svc().remove(target.id);
    const list1 = await svc().list();
    expect(list1.backups.find((b) => b.id === target.id)).toBeUndefined();
    expect(existsSync(path.join(backupRoot, target.id))).toBe(false);
  });

  it('未知 id 报 BACKUP_NOT_FOUND', async () => {
    await expect(svc().remove('nope')).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
  });

  it('保留策略：maxKeep=2 时 commit 定稿裁最旧', async () => {
    prismaStub.option.findUnique.mockResolvedValue({ value: '2' });
    const mk = async (tag: string) => {
      const buf = Buffer.from(tag);
      const { id } = await svc().create({ appVersion: '1', schemaVersion: 1, fileSize: buf.length, sha256: sha256(buf), chunkCount: 1 });
      await svc().putChunk({ id, seq: 0, data: buf.toString('base64'), chunkSha256: sha256(buf) });
      await svc().commit(id);
      return id;
    };
    const ids = [await mk('a'), await mk('b'), await mk('c')];
    const list = await svc().list();
    expect(list.backups).toHaveLength(2);
    expect(list.backups.find((b) => b.id === ids[0])).toBeUndefined();
    prismaStub.option.findUnique.mockResolvedValue(null);
  });
});
```

注意：BusinessException 的 code 字段形态执行者以 `src/commons/exception` 实际定义为准（`rejects.toMatchObject({ code })` 若实际字段为 `businessCode` 则同步改断言，先看 files.spec.ts 的既有断言写法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w apps/tianshu-server -- backup`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`apps/tianshu-server/src/commons/util/path.util.ts`（从 files.service 原样提取，头注释注明提取动机）：

```ts
import os from 'node:os';
import path from 'node:path';

/** ~ 展开为 home（files.service 原实现提取，backup-root 同源消费） */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** 数据根解析：TIANSHU_DATA_ROOT 环境变量 > 配置值 */
export function resolveDataRoot(configured: string): string {
  return process.env.TIANSHU_DATA_ROOT
    ? process.env.TIANSHU_DATA_ROOT
    : expandHome(configured);
}
```

files.service.ts 删私有 expandHome/resolveDataRoot 改 `import { resolveDataRoot } from 'src/commons/util/path.util'`（行为零变化，跑既有 files.spec.ts 护航）。

`apps/tianshu-server/src/modules/backup/backup-root.ts`：

```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveDataRoot } from 'src/commons/util/path.util';

/** 备份根 env 名（容器部署 -e 映射宿主机卷；TIANSHU_* 同族命名，
 *  不走 config.yml 覆写链——db-url.ts 头注释 DATABASE_URL 冲掉坑） */
export const BACKUP_DIR_ENV = 'TIANSHU_BACKUP_DIR';

/** 备份根目录单一解析出口（防调用方散拼字符串）：
 * TIANSHU_BACKUP_DIR > <server 数据根>/backups */
export function resolveBackupRoot(): string {
  const root = process.env[BACKUP_DIR_ENV]?.trim()
    ? path.resolve(process.env[BACKUP_DIR_ENV]!.trim())
    : path.join(resolveDataRoot('~/.tianshu-server'), 'backups');
  mkdirSync(root, { recursive: true });
  return root;
}
```

`apps/tianshu-server/src/modules/backup/backup.service.ts` 核心结构（完整实现，执行者对齐 BusinessException 实际签名）：

```ts
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { resolveBackupRoot } from './backup-root';
import {
  BACKUP_CHUNK_BYTES, DEFAULT_BACKUP_MAX_KEEP, DEFAULT_BACKUP_MAX_SIZE_BYTES,
  type BackupCreateRequest, type BackupChunkRequest, type BackupCommitResult,
  type BackupDeleteResult, type BackupDownloadRequest, type BackupDownloadResult,
  type BackupListResult, type BackupMeta,
} from '@tianshu/protocol';

@Injectable()
export class BackupService {
  /** 同 id 上传互斥 */
  private readonly inflight = new Set<string>();
  /** 已收块游标（id → 期望下一 seq） */
  private readonly cursor = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  private dir(id: string) { return path.join(resolveBackupRoot(), id); }
  private partPath(id: string) { return path.join(this.dir(id), 'data.tar.gz.part'); }
  private metaPath(id: string) { return path.join(this.dir(id), 'meta.json'); }

  /** 创建=清空重传（幂等）；uuid 服务端生成，客户端仅回传引用 */
  async create(req: BackupCreateRequest): Promise<{ id: string }> {
    if (req.fileSize > DEFAULT_BACKUP_MAX_SIZE_BYTES) throw new BusinessException('BACKUP_TOO_LARGE');
    // id 复用：客户端重试 create 时回传 id 则幂等重建（无 id 字段——恒新生成；
    // 同设备断点续传=同 meta 再 create 新 id，旧 uploading 档由保留策略/手动清）
    const id = randomUUID();
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    rmSync(this.partPath(id), { force: true });
    const meta: BackupMeta = { id, createdAt: new Date().toISOString(), status: 'uploading', ...req };
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
    this.cursor.set(id, 0);
    return { id };
  }

  async putChunk(req: BackupChunkRequest): Promise<{ received: number }> {
    const expect = this.cursor.get(req.id) ?? 0;
    if (req.seq !== expect) throw new BusinessException('BACKUP_BAD_SEQ');
    const buf = Buffer.from(req.data, 'base64');
    if (buf.length > BACKUP_CHUNK_BYTES) throw new BusinessException('BACKUP_CHUNK_HASH');
    if (createHash('sha256').update(buf).digest('hex') !== req.chunkSha256) {
      throw new BusinessException('BACKUP_CHUNK_HASH');
    }
    // 追加写（fs.appendFileSync；测试/生产同态）
    const { appendFileSync } = await import('node:fs');
    appendFileSync(this.partPath(req.id), buf);
    this.cursor.set(req.id, req.seq + 1);
    return { received: req.seq };
  }

  async commit(id: string): Promise<BackupCommitResult> {
    const meta = this.readMeta(id);
    if (meta.status !== 'uploading') throw new BusinessException('BACKUP_BAD_STATE');
    if ((this.cursor.get(id) ?? 0) !== meta.chunkCount) throw new BusinessException('BACKUP_BAD_SEQ');
    const part = this.partPath(id);
    const size = statSync(part).size;
    if (size !== meta.fileSize) throw new BusinessException('BACKUP_HASH_MISMATCH');
    const digest = createHash('sha256').update(readFileSync(part)).digest('hex');
    if (digest !== meta.sha256) throw new BusinessException('BACKUP_HASH_MISMATCH');
    const { renameSync } = await import('node:fs');
    renameSync(part, path.join(this.dir(id), 'data.tar.gz'));
    const ready: BackupMeta = { ...meta, status: 'ready' };
    writeFileSync(this.metaPath(id), JSON.stringify(ready, null, 2));
    this.cursor.delete(id);
    await this.trimOldBackups();
    return { fileSize: ready.fileSize, sha256: ready.sha256 };
  }

  async list(): Promise<BackupListResult> {
    const root = resolveBackupRoot();
    const ids = existsSync(root) ? readdirSync(root).filter((d) => existsSync(this.metaPath(d))) : [];
    const backups = ids
      .map((id) => this.readMeta(id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { backups };
  }

  async download(req: BackupDownloadRequest): Promise<BackupDownloadResult> {
    const meta = this.readMeta(req.id);
    if (meta.status !== 'ready') throw new BusinessException('BACKUP_BAD_STATE');
    const fd = createReadStream(path.join(this.dir(req.id), 'data.tar.gz'), {
      start: req.seq * BACKUP_CHUNK_BYTES,
      end: Math.min((req.seq + 1) * BACKUP_CHUNK_BYTES, meta.fileSize) - 1,
    });
    const chunks: Buffer[] = [];
    for await (const c of fd) chunks.push(c as Buffer);
    return { data: Buffer.concat(chunks).toString('base64'), totalChunks: meta.chunkCount };
  }

  async remove(id: string): Promise<BackupDeleteResult> {
    this.readMeta(id); // 未知 id → BACKUP_NOT_FOUND
    rmSync(this.dir(id), { recursive: true, force: true });
    this.cursor.delete(id);
    return { deleted: true };
  }

  /** 保留策略：超 maxKeep 删最旧（option 表 app/backupMaxKeep，坏值回落默认） */
  private async trimOldBackups(): Promise<void> {
    const row = await this.prisma.option.findUnique({
      where: { type_name: { type: 'app', name: 'backupMaxKeep' } },
    });
    const maxKeep = Math.max(1, Number.parseInt(row?.value ?? '', 10) || DEFAULT_BACKUP_MAX_KEEP);
    const all = (await this.list()).backups.filter((b) => b.status === 'ready');
    for (const victim of all.slice(maxKeep)) {
      rmSync(this.dir(victim.id), { recursive: true, force: true });
    }
  }

  private readMeta(id: string): BackupMeta {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !existsSync(this.metaPath(id))) {
      throw new BusinessException('BACKUP_NOT_FOUND');
    }
    return JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as BackupMeta;
  }
}
```

（BusinessException 构造签名/错误码注册形态执行者按 `src/commons/exception` 实际形态对齐；`cursor`/`inflight` 进程内存态即可——server 单进程。）

- [ ] **Step 4: 跑测试确认通过 + files 回归**

Run: `npm run test -w apps/tianshu-server -- backup` 与 `npm run test -w apps/tianshu-server -- files`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/commons/util/path.util.ts apps/tianshu-server/src/modules/files/files.service.ts apps/tianshu-server/src/modules/backup/ apps/tianshu-server/test/modules/backup.spec.ts
git commit -m "feat(server): backup service——分块落盘/commit 终验/保留策略 + path.util 提取"
```

---

### Task 3: server 端 BackupGuard + controller + module 挂接

**Files:**
- Create: `apps/tianshu-server/src/modules/backup/backup.guard.ts`
- Create: `apps/tianshu-server/src/modules/backup/backup.controller.ts`
- Create: `apps/tianshu-server/src/modules/backup/backup.module.ts`
- Modify: `apps/tianshu-server/src/app.module.ts`（imports 数组加 BackupModule）
- Test: `apps/tianshu-server/test/modules/backup-guard.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `BackupService` 方法面；全局 StaticTokenGuard（第一层，自动）
- Produces: HTTP 端点 `POST backup/create | backup/:id/chunk | backup/:id/commit | backup/list | backup/:id/download | backup/:id/delete`（Task 6 客户端调用目标）；`BACKUP_TOKEN_ENV = 'TIANSHU_BACKUP_TOKEN'`

- [ ] **Step 1: 写失败测试** `apps/tianshu-server/test/modules/backup-guard.spec.ts`

```ts
// BackupGuard 单测：二层专用 token 语义（spec §3）——
// 设置 TIANSHU_BACKUP_TOKEN 时备份端点只认它；未设置回落放行
// （第一层 TIANSHU_TOKEN 由全局 StaticTokenGuard 把关，本测只测第二层）。
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { BackupGuard } from 'src/modules/backup/backup.guard';

const ctx = (authorization?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  }) as unknown as ExecutionContext;

describe('BackupGuard', () => {
  const ORIG = process.env.TIANSHU_BACKUP_TOKEN;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.TIANSHU_BACKUP_TOKEN;
    else process.env.TIANSHU_BACKUP_TOKEN = ORIG;
  });

  it('未设置 BACKUP_TOKEN：放行（回落仅第一层 TIANSHU_TOKEN）', () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    expect(new BackupGuard().canActivate(ctx('Bearer anything'))).toBe(true);
  });
  it('设置了 BACKUP_TOKEN：token 匹配放行', () => {
    process.env.TIANSHU_BACKUP_TOKEN = 'sekrit';
    expect(new BackupGuard().canActivate(ctx('Bearer sekrit'))).toBe(true);
  });
  it('设置了 BACKUP_TOKEN：TIANSHU_TOKEN 值被拒（最小权限）', () => {
    process.env.TIANSHU_BACKUP_TOKEN = 'sekrit';
    expect(() => new BackupGuard().canActivate(ctx('Bearer tianshu-daily'))).toThrow(UnauthorizedException);
  });
  it('空 header 拒绝', () => {
    process.env.TIANSHU_BACKUP_TOKEN = 'sekrit';
    expect(() => new BackupGuard().canActivate(ctx(undefined))).toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w apps/tianshu-server -- backup-guard`
Expected: FAIL（guard 不存在）

- [ ] **Step 3: 实现**（guard 沿 token.guard.ts 同款 timingSafeEqual 定长摘要；controller 全 POST + ValidationPipe DTO；module 照 InfoModule 极简模板 + providers: [BackupService]）

`backup.guard.ts`：

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

/** 二层备份专用 token（spec §3）：设置时备份端点只认它——日常远控
 *  token 泄漏不暴露整机备份面；未设置回落仅全局 TIANSHU_TOKEN。 */
export const BACKUP_TOKEN_ENV = 'TIANSHU_BACKUP_TOKEN';

@Injectable()
export class BackupGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env[BACKUP_TOKEN_ENV];
    if (!expected) return true;
    const req = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const provided = req.headers?.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length).trim()
      : undefined;
    if (provided && this.isEqual(provided, expected)) return true;
    throw new UnauthorizedException('无效的备份 token');
  }

  /** 定长摘要后 timingSafeEqual（token.guard.ts 同款，防时序侧信道） */
  private isEqual(a: string, b: string): boolean {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(digest(a), digest(b));
  }
}
```

`backup.controller.ts`（DTO 直接内联 class-validator 装饰 + `@tianshu/protocol` 类型 import；路径参数 id、body 承载 chunk/download 参数）：

```ts
import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { IsBase64, IsHexadecimal, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { BackupGuard } from './backup.guard';

class ChunkDto {
  @IsInt() @Min(0) seq: number;
  @IsBase64() data: string;
  @IsString() @Length(64, 64) @IsHexadecimal() chunkSha256: string;
}
class DownloadDto {
  @IsInt() @Min(0) seq: number;
}

@ApiTags('备份')
@UseGuards(BackupGuard)
@Controller('backup')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Post('create') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: '登记备份（服务端生成 id）' })
  create(@Body() dto: Record<string, unknown>) { return this.backupService.create(dto as never); }

  @Post(':id/chunk') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: '上传分块（收块即验 hash）' })
  chunk(@Param('id') id: string, @Body() dto: ChunkDto) {
    return this.backupService.putChunk({ id, ...dto });
  }

  @Post(':id/commit') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: '终验定稿' })
  commit(@Param('id') id: string) { return this.backupService.commit(id); }

  @Post('list') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: '备份列表' })
  list() { return this.backupService.list(); }

  @Post(':id/download') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: '分块下载' })
  download(@Param('id') id: string, @Body() dto: DownloadDto) {
    return this.backupService.download({ id, seq: dto.seq });
  }

  @Post(':id/delete') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: '删除备份' })
  delete(@Param('id') id: string) { return this.backupService.remove(id); }
}
```

（create 的 DTO class 含 appVersion/schemaVersion/fileSize/sha256/chunkCount/note?/deviceName? 校验装饰，执行者补全——字段清单即 Task 1 `BackupCreateRequest`；swagger 包装照 files.controller.ts `ApiWrappedOk` 先例。）

`backup.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/** 备份模块（spec 2026-10-27）：桌面端全量数据备份存档/下载 */
@Module({
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
```

`app.module.ts` imports 数组加 `BackupModule`（与 FilesModule 等业务模块并列）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npm run test -w apps/tianshu-server`
Expected: 全 PASS（含既有 modules 回归）

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/modules/backup/ apps/tianshu-server/src/app.module.ts apps/tianshu-server/test/modules/backup-guard.spec.ts
git commit -m "feat(server): backup 六端点 controller + BackupGuard 二层 token——模块挂接"
```

---

### Task 4: 桌面端 ustar-tar 打包/解包器（纯函数 TDD）

**Files:**
- Create: `electron/domains/backup/ustar-tar.ts`
- Test: `tests/ai/backup/ustar-tar.test.ts`

**Interfaces:**
- Consumes: Node `zlib`（createGzip/createGunzip）、`node:fs`
- Produces:
  - `packTarGz(entries: TarEntry[], outFile: string): Promise<void>`——`TarEntry = { relPath: string; absPath: string; size: number }`
  - `unpackTarGz(archiveFile: string, destDir: string): Promise<void>`（先校验 entry 目标不越出 destDir）
  - 错误：relPath 超 255 / 空字节名 / 越界路径均**抛错中止**
  - Task 5/7 直接消费

- [ ] **Step 1: 写失败测试** `tests/ai/backup/ustar-tar.test.ts`

```ts
// ustar 手写打包/解包器单测：GNU tar 互验（标准格式权威对拍）+ 边界。
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packTarGz, unpackTarGz } from "@/../electron/domains/backup/ustar-tar";
// mirror 消费形态：alias @/* 指 src-react；electron 直引按 tests/ 既有
// import 照 tests/ai/automation-event-bus.test.ts 的相对路径写法对齐执行。

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ustar-"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("ustar-tar", () => {
  it("基本往返：文件+目录树 → 解包内容一致", async () => {
    const src = tmp();
    mkdirSync(path.join(src, "database"), { recursive: true });
    writeFileSync(path.join(src, "database", "local.db"), Buffer.alloc(1024, 3));
    writeFileSync(path.join(src, ".jwt-secret"), "secret");
    const out = path.join(tmp(), "a.tar.gz");
    await packTarGz(
      [
        { relPath: "database", absPath: path.join(src, "database"), size: 0 },
        { relPath: "database/local.db", absPath: path.join(src, "database", "local.db"), size: 1024 },
        { relPath: ".jwt-secret", absPath: path.join(src, ".jwt-secret"), size: 6 },
      ],
      out
    );
    // GNU tar 互验：标准工具可列出并解开（格式权威对拍）
    const listing = execSync(`tar -tzf ${out}`).toString().trim().split("\n").sort();
    expect(listing).toEqual([".jwt-secret", "database/", "database/local.db"]);
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(sha(readFileSync(path.join(dest, "database", "local.db")))).toBe(
      sha(readFileSync(path.join(src, "database", "local.db")))
    );
  });

  it("长路径（100~255）：prefix 字段生效，GNU tar 互验可解", async () => {
    const src = tmp();
    const deep = path.join(src, "a".repeat(120), "b".repeat(120), "c.txt");
    mkdirSync(path.dirname(deep), { recursive: true });
    writeFileSync(deep, "deep");
    const out = path.join(tmp(), "b.tar.gz");
    await packTarGz([{ relPath: `${"a".repeat(120)}/${"b".repeat(120)}/c.txt`, absPath: deep, size: 4 }], out);
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(readFileSync(path.join(dest, "a".repeat(120), "b".repeat(120), "c.txt"), "utf8")).toBe("deep");
  });

  it("超 255 路径：报错中止（备份不静默丢数据）", async () => {
    const src = tmp();
    const p = path.join(src, "f");
    writeFileSync(p, "x");
    await expect(
      packTarGz([{ relPath: `${"x".repeat(200)}/y${"z".repeat(100)}`, absPath: p, size: 1 }], path.join(tmp(), "c.tar.gz"))
    ).rejects.toThrow(/255/);
  });

  it("空文件与多文件混合", async () => {
    const src = tmp();
    writeFileSync(path.join(src, "empty"), "");
    writeFileSync(path.join(src, "two"), "22");
    const out = path.join(tmp(), "d.tar.gz");
    await packTarGz(
      [
        { relPath: "empty", absPath: path.join(src, "empty"), size: 0 },
        { relPath: "two", absPath: path.join(src, "two"), size: 2 },
      ],
      out
    );
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(statSync(path.join(dest, "empty")).size).toBe(0);
    expect(readFileSync(path.join(dest, "two"), "utf8")).toBe("22");
  });

  it("解包越界路径（../）：拒绝", async () => {
    // 手工构造恶意 tar.gz：用本包打包合法文件后改名 entry 不易——改为
    // 直接断言 unpackTarGz 对含 .. 的 header 抛错：构造经 GNU tar 打包
    const src = tmp();
    writeFileSync(path.join(src, "ok"), "v");
    execSync(`cd ${src} && tar -czf evil.tar.gz ok`);
    // 正常包能解；越界包需要手工 header——此处断言防御函数行为：
    // 由实现导出的内部防御在 unpack 时对每个 entry 做校验，负样用
    // node:zlib 手写 header 注入（实现导出 assertSafeEntry 便于直测）
    const { assertSafeEntry } = await import("@/../electron/domains/backup/ustar-tar");
    expect(() => assertSafeEntry("../escape")).toThrow();
    expect(() => assertSafeEntry("a/../../b")).toThrow();
    expect(() => assertSafeEntry("a/b/c")).not.toThrow();
  });
});
```

（import 路径形态执行时对齐 `tests/ai/` 既有用例的写法；`tar` 命令 macOS 自带 bsdtar，兼容 ustar。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/backup/ustar-tar.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `electron/domains/backup/ustar-tar.ts`

核心结构（512 字节 ustar header、八进制字段、prefix 155+name 100、typeflag '0' 文件/'5' 目录、checksum 置空格求和、结尾双零块；gzip 经 zlib 管道流式写）：

```ts
/**
 * ustar tar.gz 手写打包/解包器（spec 2026-10-27 §1）：零新依赖
 * （依赖白名单互锁不动），标准 ustar 格式（GNU/bsdtar 可互验互解）。
 * 约束：relPath（prefix+name）超 255 抛错中止——备份不静默丢数据；
 * 解包 entry 路径越出 destDir 抛错（防路径穿越）。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export interface TarEntry {
  relPath: string;
  absPath: string;
  size: number;
}

const BLOCK = 512;
const encode = (s: string) => Buffer.from(s, "utf8");

/** entry 路径防御（绝对路径 / .. / 反斜杠 / 空段一律拒绝） */
export function assertSafeEntry(relPath: string): void {
  if (!relPath || relPath.includes("\\") || relPath.startsWith("/") ||
      relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`unsafe tar entry: ${relPath}`);
  }
}

/** 八进制字段（len-2 位数字 + NUL 填充） */
function octal(value: number, len: number): Buffer {
  const s = value.toString(8).padStart(len - 1, "0");
  if (s.length > len - 1) throw new Error(`field overflow: ${value}`);
  const buf = Buffer.alloc(len);
  buf.write(s + "\0", 0, "utf8");
  return buf;
}

function header(entry: TarEntry): Buffer {
  assertSafeEntry(entry.relPath);
  let name = entry.relPath;
  let prefix = "";
  if (encode(name).length > 100) {
    // 从右向左找最长 prefix（≤155）+ name（≤100）切分
    const idx = name.slice(0, 156).lastIndexOf("/");
    if (idx <= 0 || encode(name.slice(idx + 1)).length > 100) {
      throw new Error(`tar path >255 unsupported: ${entry.relPath}`);
    }
    prefix = name.slice(0, idx);
    name = name.slice(idx + 1);
    if (encode(prefix).length > 155) throw new Error(`tar path >255 unsupported: ${entry.relPath}`);
  }
  const isDir = entry.size === 0 && statSync(entry.absPath).isDirectory();
  const h = Buffer.alloc(BLOCK);
  const put = (off: number, b: Buffer) => b.copy(h, off);
  put(0, encode(name)); h.fill(0, encode(name).length, 100);
  put(100, octal(isDir ? 0o755 : 0o644, 8));   // mode
  put(108, octal(0, 8));                        // uid
  put(116, octal(0, 8));                        // gid
  put(124, octal(entry.size, 12));              // size
  put(136, octal(Math.floor(Date.now() / 1000), 12)); // mtime
  h.fill(" ", 148, 156);                        // chksum 先置空格
  h.write(isDir ? "5" : "0", 156, "utf8");      // typeflag
  put(257, encode("ustar\0" + "00"));           // magic + version
  put(345, encode(prefix));
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  return h;
}

export async function packTarGz(entries: TarEntry[], outFile: string): Promise<void> {
  const out = createWriteStream(outFile);
  const gz = createGzip();
  gz.pipe(out);
  for (const entry of entries) {
    // 目录条目 size=0 且目标是目录；文件条目流式拷贝 + 512 对齐 pad
    await new Promise<void>((resolve, reject) => {
      gz.write(header(entry), (err) => (err ? reject(err) : resolve()));
    });
    if (entry.size > 0) {
      await pipeline(createReadStream(entry.absPath), gz, { end: false } as never)
        .catch(() => undefined); // pipeline 与复用流：见下方实现注记
    }
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (pad) await new Promise<void>((r) => gz.write(Buffer.alloc(pad), () => r()));
  }
  await new Promise<void>((r) => gz.write(Buffer.alloc(BLOCK * 2), () => r()));
  await new Promise<void>((r) => gz.end(() => r()));
  await new Promise<void>((r) => out.on("close", () => r()));
}
```

**实现注记**（执行者必须处理，上面骨架故意留了流拼接难点）：`pipeline` 传入已被 pipe 的流会提前 end——正确做法是不用 `stream/promises.pipeline` 复用 gz，而是对每个文件用 `createReadStream(absPath).on("data", ...)` 手动 `gz.write(chunk)` 并统计背压（`if (!gz.write(chunk)) await once(gz, "drain")`），读完补 pad。核心不变量：**header + size 字节 + pad 到 512 倍数，尾部双零块**。解包 `unpackTarGz` 对称：gunzip → 逐 512 块读 header → `assertSafeEntry` → `path.join(destDir, prefix ? prefix + "/" : "", name)`（先 `path.dirname` mkdir recursive）→ 按 size 截取数据流 → 跳 pad；遇全零块终止。写完后建议补一条自检：与 `execSync("tar -tzf")` 在测试内互验（已含）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- tests/ai/backup/ustar-tar.test.ts`
Expected: PASS（5 用例，含 GNU tar 互验）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/backup/ustar-tar.ts tests/ai/backup/ustar-tar.test.ts
git commit -m "feat(backup): ustar tar.gz 手写打包/解包器——零依赖+GNU tar 互验+越界防御"
```

---

### Task 5: 桌面端 snapshot（db 快照 + 资产收集 + 打包落盘）

**Files:**
- Create: `electron/domains/backup/snapshot.ts`
- Test: `tests/ai/backup/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 4 `packTarGz/TarEntry`；`electron/commons/paths.ts` 的 `appDataHome/databaseDir/skillsDir/libraryDir/attachmentsDir/workflowAssetsDir/projectsDir/jwtSecretPath`；`electron/Constants.ts` 的 `DB_VERSION`
- Produces:
  - `createBackupArchive(opts: { tempDir: string; appVersion: string; snapshotDatabase?: (dbPath: string, destPath: string) => void }): Promise<{ archivePath: string; meta: BackupCreateRequest; sha256: string; fileCount: number }>`
  - `snapshotDatabaseDefault(dbPath: string, destPath: string): void`（better-sqlite3 真身；vitest 注入替身——原生模块 ABI 不可加载铁律）
  - `BACKUP_ASSET_DIRS = ["skills", "library", "attachments", "workflow-assets", "projects"] as const`（Task 7 恢复消费同一常量）

- [ ] **Step 1: 写失败测试** `tests/ai/backup/snapshot.test.ts`

```ts
// snapshot 单测：TIANSHU_DATA_ROOT 注入临时数据根（tests/setup.ts 全局
// 隔离同口径）；better-sqlite3 真身以替身注入（node ABI 铁律——保留策略批先例）。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }), { virtual: true });
// paths.ts 的 appDataHome 依赖 electron app.isPackaged——vi.mock 后走 app/ 分组

const { createBackupArchive, BACKUP_ASSET_DIRS } = await import(
  "@/../electron/domains/backup/snapshot"
);

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "snap-"));
process.env.TIANSHU_DATA_ROOT = dataRoot;

describe("snapshot", () => {
  it("db 快照（替身）+ 资产目录收集 + tar.gz 产出与 meta", async () => {
    // 造数据根：app 分组下 database/local.db + skills 一个文件 + .jwt-secret
    const group = path.join(dataRoot, "app");
    mkdirSync(path.join(group, "database"), { recursive: true });
    writeFileSync(path.join(group, "database", "local.db"), "FAKE-DB");
    mkdirSync(path.join(group, "skills", "demo"), { recursive: true });
    writeFileSync(path.join(group, "skills", "demo", "SKILL.md"), "s");
    writeFileSync(path.join(group, ".jwt-secret"), "jwt");
    // 应排除项：logs / file-history
    mkdirSync(path.join(group, "logs"), { recursive: true });
    writeFileSync(path.join(group, "logs", "x.log"), "l");
    mkdirSync(path.join(group, "file-history"), { recursive: true });

    let snapCalled = false;
    const result = await createBackupArchive({
      tempDir: mkdtempSync(path.join(os.tmpdir(), "snapout-")),
      appVersion: "1.2.3",
      snapshotDatabase: (dbPath, destPath) => {
        snapCalled = true;
        expect(dbPath.endsWith("database/local.db")).toBe(true);
        writeFileSync(destPath, "SNAPSHOT-DB");
      },
    });
    expect(snapCalled).toBe(true);
    expect(existsSync(result.archivePath)).toBe(true);
    // tar 清单断言：含 database/skills/.jwt-secret；不含 logs/file-history
    const listing = execSync(`tar -tzf ${result.archivePath}`).toString().trim().split("\n");
    expect(listing.some((l) => l === "database/local.db")).toBe(true);
    expect(listing.some((l) => l.startsWith("skills/"))).toBe(true);
    expect(listing.some((l) => l === ".jwt-secret")).toBe(true);
    expect(listing.some((l) => l.startsWith("logs/"))).toBe(false);
    expect(listing.some((l) => l.startsWith("file-history/"))).toBe(false);
    expect(result.meta.sha256).toBe(result.sha256);
    expect(result.meta.schemaVersion).toBeGreaterThan(0);
    expect(result.meta.chunkCount).toBeGreaterThanOrEqual(1);
  });
});
```

（`DB_VERSION` 实际常量名/取值以 `electron/Constants.ts` 为准，断言只查 `>0`；import 形态对齐 tests/ 既有用例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/backup/snapshot.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** `electron/domains/backup/snapshot.ts`

```ts
/**
 * 备份快照装配（spec 2026-10-27 §4）：db 在线快照（better-sqlite3 .backup()，
 * 单开连接不打扰运行中 Prisma）+ 资产目录收集 → tar.gz（ustar-tar）→
 * sha256 + BackupCreateRequest meta。快照函数注入化：vitest（node ABI）
 * 不可加载 better-sqlite3，替身注入（保留策略批先例）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appDataHome, attachmentsDir, databaseDir, jwtSecretPath,
  libraryDir, projectsDir, skillsDir, workflowAssetsDir,
} from "../../commons/paths";
import { DB_VERSION } from "../../Constants";
import { packTarGz, type TarEntry } from "./ustar-tar";
import type { BackupCreateRequest } from "@tianshu/protocol";

export const BACKUP_ASSET_DIRS = ["skills", "library", "attachments", "workflow-assets", "projects"] as const;
export const BACKUP_EXCLUDED_DIRS = ["logs", "file-history"] as const;

/** better-sqlite3 真身（主进程 Electron ABI 可用；vitest 替身注入） */
export function snapshotDatabaseDefault(dbPath: string, destPath: string): void {
  // 动态 require：保 vitest 收集期不触原生模块
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  try {
    db.backup(destPath);
  } finally {
    db.close();
  }
}

/** 递归收集目录内全部条目（相对 relPath 递推） */
function walk(absDir: string, rel: string, out: TarEntry[]): void {
  for (const name of readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push({ relPath, absPath: abs, size: 0 });
      walk(abs, relPath, out);
    } else {
      out.push({ relPath, absPath: abs, size: st.size });
    }
  }
}

export async function createBackupArchive(opts: {
  tempDir: string;
  appVersion: string;
  snapshotDatabase?: (dbPath: string, destPath: string) => void;
}): Promise<{ archivePath: string; meta: BackupCreateRequest; sha256: string; fileCount: number }> {
  const snapshot = opts.snapshotDatabase ?? snapshotDatabaseDefault;
  const work = mkdtempSync(path.join(opts.tempDir, "pack-"));
  // 1. db 快照
  const dbSnapshot = path.join(work, "local.db.snapshot");
  snapshot(path.join(databaseDir(), "local.db"), dbSnapshot);
  // 2. 收集 entries：database/local.db + 资产目录 + .jwt-secret（存在才收）
  const entries: TarEntry[] = [{ relPath: "database/local.db", absPath: dbSnapshot, size: statSync(dbSnapshot).size }];
  const assetRoots: Record<(typeof BACKUP_ASSET_DIRS)[number], string> = {
    skills: skillsDir(), library: libraryDir(), attachments: attachmentsDir(),
    "workflow-assets": workflowAssetsDir(), projects: projectsDir(),
  };
  for (const dir of BACKUP_ASSET_DIRS) {
    const root = assetRoots[dir];
    if (existsSyncSafe(root)) walk(root, dir, entries);
  }
  if (existsSyncSafe(jwtSecretPath())) {
    const size = statSync(jwtSecretPath()).size;
    entries.push({ relPath: ".jwt-secret", absPath: jwtSecretPath(), size });
  }
  // 3. 打包 + 哈希
  const archivePath = path.join(opts.tempDir, `backup-${Date.now()}.tar.gz`);
  await packTarGz(entries, archivePath);
  const sha256 = await hashFile(archivePath);
  const { size: fileSize } = statSync(archivePath);
  const { BACKUP_CHUNK_BYTES } = await import("@tianshu/protocol");
  const meta: BackupCreateRequest = {
    appVersion: opts.appVersion,
    schemaVersion: DB_VERSION,
    fileSize,
    sha256,
    chunkCount: Math.max(1, Math.ceil(fileSize / BACKUP_CHUNK_BYTES)),
  };
  return { archivePath, meta, sha256, fileCount: entries.length };
}
// existsSyncSafe/hashFile 小工具实现（fs.existsSync 包装 + 流式 sha256）
```

（`existsSyncSafe`/`hashFile`（createReadStream 增量喂 createHash）实现补全；`require` 在 ESM/打包态的形态照 prisma-client 等 Electron 主进程既有动态加载先例，vitest 路径因替身注入不会触达。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- tests/ai/backup/snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/backup/snapshot.ts tests/ai/backup/snapshot.test.ts
git commit -m "feat(backup): 快照装配——db 在线快照+资产收集+排除项+meta 产出"
```

---

### Task 6: 桌面端 backup-client（分块上传/下载 HTTP 客户端）

**Files:**
- Create: `electron/domains/backup/backup-client.ts`
- Test: `tests/ai/backup/backup-client.test.ts`

**Interfaces:**
- Consumes: Task 1 契约常量与类型；连接的 `baseUrl`（含 contextPath）与 `token`（ConnectionConfig 直取——connections.ts `ConnectionConfig` 形态）
- Produces:
  - `class BackupClient { constructor(opts: { baseUrl: string; token?: string; fetchImpl?: typeof fetch }) }`
  - `uploadArchive(archivePath: string, meta: BackupCreateRequest, onProgress?: (uploadedBytes: number, totalBytes: number) => void): Promise<BackupCommitResult>`
  - `downloadArchive(id: string, destPath: string, onProgress?: (downloadedBytes: number, totalBytes: number) => void): Promise<{ sha256: string }>`
  - `list(): Promise<BackupMeta[]>`、`remove(id: string): Promise<void>`
  - 单块失败重试 ≤3 次（幂等：块 hash 校验使重传安全）

- [ ] **Step 1: 写失败测试** `tests/ai/backup/backup-client.test.ts`

```ts
// backup-client 单测：fetch 替身注入（序列断言/重试/进度/starter 包装体判错）
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BackupClient } from "@/../electron/domains/backup/backup-client";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function makeFetch(seqs: { calls: string[]; failOnce?: Map<string, number> }) {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seqs.calls.push(`${init?.method ?? "POST"} ${url}`);
    const route = (p: string) => url.endsWith(p);
    if (route("/backup/create")) {
      return json200({ id: "b1" });
    }
    if (route("/backup/chunk")) {
      const key = `/backup/chunk:${body.id}:${body.seq}`;
      const fails = seqs.failOnce?.get(key) ?? 0;
      if (fails > 0) {
        seqs.failOnce?.set(key, fails - 1);
        return new Response(JSON.stringify({ code: "5000", success: false, message: "boom" }), { status: 500 });
      }
      return json200({ received: body.seq });
    }
    if (route("/backup/commit")) return json200({ fileSize: 5, sha256: body.sha256 ?? "x" });
    if (route("/backup/list")) return json200({ backups: [{ id: "b1", status: "ready" }] });
    if (url.includes("/download")) {
      return json200({ data: Buffer.from("hello").toString("base64"), totalChunks: 1 });
    }
    if (url.includes("/delete")) return json200({ deleted: true });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
const json200 = (data: unknown) =>
  new Response(JSON.stringify({ code: "0", success: true, data, message: "ok" }), { status: 200 });

describe("BackupClient", () => {
  it("uploadArchive：create→按序 chunk→commit，携带 Bearer token 与 base64 块", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const payload = Buffer.from("hello");
    const archive = path.join(tmp, "a.tar.gz");
    writeFileSync(archive, payload);
    const calls: string[] = [];
    const client = new BackupClient({ baseUrl: "http://x/api", token: "t1", fetchImpl: makeFetch({ calls }) });
    const progress: number[] = [];
    const r = await client.uploadArchive(archive, {
      appVersion: "1", schemaVersion: 1, fileSize: 5,
      sha256: sha256(payload), chunkCount: 1,
    }, (u, t) => progress.push(u / t));
    expect(r.sha256).toBe(sha256(payload));
    expect(calls[0]).toContain("http://x/api/backup/create");
    expect(calls.some((c) => c.includes("/backup/b1/chunk"))).toBe(true);
    expect(calls[calls.length - 1]).toContain("commit");
    expect(progress.at(-1)).toBe(1);
  });

  it("单块 500 重试≤3 后成功", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const payload = Buffer.from("hello");
    const archive = path.join(tmp, "a.tar.gz");
    writeFileSync(archive, payload);
    const failOnce = new Map([["/backup/chunk:b1:0", 1]]);
    const client = new BackupClient({ baseUrl: "http://x", fetchImpl: makeFetch({ calls: [], failOnce }) });
    const r = await client.uploadArchive(archive, { appVersion: "1", schemaVersion: 1, fileSize: 5, sha256: sha256(payload), chunkCount: 1 });
    expect(r.fileSize).toBe(5);
  });

  it("连续 3 次失败抛错（不无限重试）", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const payload = Buffer.alloc(4 * 1024 * 1024 + 1, 1); // 2 块
    const archive = path.join(tmp, "a.tar.gz");
    writeFileSync(archive, payload);
    const failOnce = new Map([
      ["/backup/chunk:b1:0", 99], ["/backup/chunk:b1:1", 99],
    ]);
    const client = new BackupClient({ baseUrl: "http://x", fetchImpl: makeFetch({ calls: [], failOnce }) });
    await expect(client.uploadArchive(archive, {
      appVersion: "1", schemaVersion: 1, fileSize: payload.length,
      sha256: sha256(payload), chunkCount: 2,
    })).rejects.toThrow();
  });

  it("downloadArchive：拼块落盘 + 全量 sha256 复核", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const dest = path.join(tmp, "down.tar.gz");
    const client = new BackupClient({ baseUrl: "http://x", fetchImpl: makeFetch({ calls: [] }) });
    const r = await client.downloadArchive("b1", dest);
    expect(readFileSync(dest).toString()).toBe("hello");
    expect(r.sha256).toBe(sha256(Buffer.from("hello")));
  });

  it("starter 包装体判错：success=false 抛错（HTTP 200 也是错）", async () => {
    const fail = (async () => json200Fail()) as unknown as typeof fetch;
    const json200Fail = () => new Response(JSON.stringify({ code: "4001", success: false, message: "无效的备份 token" }), { status: 200 });
    const client = new BackupClient({ baseUrl: "http://x", fetchImpl: fail });
    await expect(client.list()).rejects.toThrow(/备份 token|4001/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/backup/backup-client.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** `electron/domains/backup/backup-client.ts`

```ts
/**
 * 备份 HTTP 客户端（spec 2026-10-27 §4）：独立 fetch（不走 transport 15s
 * 超时窗——大块传输按块设超时）；starter 包装体判错（body.success——
 * transport.ts 头注释契约同口径）；单块失败重试 ≤3（块 hash 使重传安全）。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { statSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { BACKUP_CHUNK_BYTES } from "@tianshu/protocol";
import type {
  BackupCommitResult, BackupCreateRequest, BackupMeta, BackupListResult,
} from "@tianshu/protocol";

const CHUNK_TIMEOUT_MS = 120_000;

export class BackupClient {
  constructor(private readonly opts: {
    baseUrl: string;
    token?: string;
    fetchImpl?: typeof fetch;
  }) {}

  private async post(pathSuffix: string, body: unknown): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.baseUrl}${pathSuffix}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    });
    const wrapped = (await res.json()) as { code: string; success: boolean; data: unknown; message: string };
    if (!res.ok || !wrapped.success) {
      throw new Error(`backup 请求失败（${pathSuffix}）：HTTP ${res.status} code=${wrapped.code} ${wrapped.message}`);
    }
    return wrapped.data;
  }

  async list(): Promise<BackupMeta[]> {
    const r = (await this.post("/backup/list", {})) as BackupListResult;
    return r.backups;
  }

  async remove(id: string): Promise<void> {
    await this.post(`/backup/${id}/delete`, {});
  }

  async uploadArchive(
    archivePath: string,
    meta: BackupCreateRequest,
    onProgress?: (uploaded: number, total: number) => void
  ): Promise<BackupCommitResult> {
    const { id } = (await this.post("/backup/create", meta)) as { id: string };
    const buf = await readFileBuffer(archivePath);
    for (let seq = 0; seq < meta.chunkCount; seq++) {
      const chunk = buf.subarray(seq * BACKUP_CHUNK_BYTES, (seq + 1) * BACKUP_CHUNK_BYTES);
      const chunkSha256 = createHash("sha256").update(chunk).digest("hex");
      await this.retry(async () => {
        await this.post(`/backup/${id}/chunk`, {
          seq, data: chunk.toString("base64"), chunkSha256,
        });
      });
      onProgress?.((seq + 1) * BACKUP_CHUNK_BYTES, meta.fileSize);
    }
    return (await this.post(`/backup/${id}/commit`, {})) as BackupCommitResult;
  }

  async downloadArchive(
    id: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<{ sha256: string }> {
    rmSync(destPath, { force: true });
    let downloaded = 0;
    let total = Infinity;
    let seq = 0;
    for (;;) {
      const r = (await this.retry(async () =>
        (await this.post(`/backup/${id}/download`, { seq })) as { data: string; totalChunks: number }
      ))!;
      total = r.totalChunks * BACKUP_CHUNK_BYTES;
      const chunk = Buffer.from(r.data, "base64");
      appendFileSync(destPath, chunk);
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
      seq += 1;
      if (seq >= r.totalChunks) break;
    }
    const buf = await readFileBuffer(destPath);
    return { sha256: createHash("sha256").update(buf).digest("hex") };
  }

  private async retry(fn: () => Promise<unknown>, max = 3): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < max; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
// readFileBuffer：fs/promises readFile 返 Buffer 小工具
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- tests/ai/backup/backup-client.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/backup/backup-client.ts tests/ai/backup/backup-client.test.ts
git commit -m "feat(backup): 分块上传/下载客户端——块级重试+进度+包装体判错"
```

---

### Task 7: 桌面端 restore（保护副本 + staging 原子切换）

**Files:**
- Create: `electron/domains/backup/restore.ts`
- Test: `tests/ai/backup/restore.test.ts`

**Interfaces:**
- Consumes: Task 4 `unpackTarGz`、Task 5 `BACKUP_ASSET_DIRS`（同一常量——恢复范围=备份范围）；paths.ts 具名目录
- Produces:
  - `createLocalSafetyCopy(destDir: string): Promise<string>`——恢复前保护副本（本地 backups-local，不走网络）
  - `restoreArchive(archivePath: string): Promise<void>`——staging 解包 → 三步 rename 原子切换 → 失败自动回滚
  - 常量 `SAFETY_COPY_DIR_NAME = "backups-local"`（数据根直下、分组外——恢复切换波及不到）

- [ ] **Step 1: 写失败测试** `tests/ai/backup/restore.test.ts`

```ts
// restore 单测：真实 fs 演练（临时数据根注入）；原子切换 + 中途失败回滚。
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }), { virtual: true });

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "restore-"));
process.env.TIANSHU_DATA_ROOT = dataRoot;

const { restoreArchive, createLocalSafetyCopy } = await import(
  "@/../electron/domains/backup/restore"
);

/** 造一个合法备份包（用 GNU tar 打，双实现互验） */
function makeArchive(): string {
  const src = mkdtempSync(path.join(os.tmpdir(), "arch-"));
  mkdirSync(path.join(src, "database"), { recursive: true });
  writeFileSync(path.join(src, "database", "local.db"), "NEW-DB");
  mkdirSync(path.join(src, "skills", "s1"), { recursive: true });
  writeFileSync(path.join(src, "skills", "s1", "SKILL.md"), "new-skill");
  writeFileSync(path.join(src, ".jwt-secret"), "new-jwt");
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "out-")), "b.tar.gz");
  execSync(`cd ${src} && tar -czf ${out} .`);
  return out;
}

describe("restore", () => {
  it("三步原子切换：新数据就位，旧数据移入暂存后清除", async () => {
    const group = path.join(dataRoot, "app");
    mkdirSync(path.join(group, "database"), { recursive: true });
    writeFileSync(path.join(group, "database", "local.db"), "OLD-DB");
    writeFileSync(path.join(group, "logs", "keep-or-not.log"), "log"); // logs 不在备份范围——原样保留
    await restoreArchive(makeArchive());
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe("NEW-DB");
    expect(readFileSync(path.join(group, "skills", "s1", "SKILL.md"), "utf8")).toBe("new-skill");
    expect(readFileSync(path.join(group, ".jwt-secret"), "utf8")).toBe("new-jwt");
    expect(existsSync(path.join(group, "logs", "keep-or-not.log"))).toBe(true); // 范围外不动
  });

  it("备份范围内的旧残留（包中没有的文件）被清除", async () => {
    const group = path.join(dataRoot, "app");
    writeFileSync(path.join(group, "database", "stale.db-journal"), "stale");
    await restoreArchive(makeArchive());
    expect(existsSync(path.join(group, "database", "stale.db-journal"))).toBe(false);
  });

  it("坏包（非 tar.gz）：抛错且现有数据零损伤", async () => {
    const group = path.join(dataRoot, "app");
    const before = readFileSync(path.join(group, "database", "local.db"), "utf8");
    const bad = path.join(mkdtempSync(path.join(os.tmpdir(), "out-")), "bad.tar.gz");
    writeFileSync(bad, "not-a-tarball");
    await expect(restoreArchive(bad)).rejects.toThrow();
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe(before);
  });

  it("切换中途失败注入：自动回滚（rename 第二步炸→旧数据还原）", async () => {
    // 通过对 backup 范围内某项预置「目录堵位」制造 rename 冲突……
    // 更直接：vi.mock 移动函数使第二步抛错——注入 failOnStep
    const { __setFailOnStep } = await import("@/../electron/domains/backup/restore");
    __setFailOnStep(2);
    const group = path.join(dataRoot, "app");
    writeFileSync(path.join(group, "database", "local.db"), "KEEP-DB");
    await expect(restoreArchive(makeArchive())).rejects.toThrow();
    __setFailOnStep(0);
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe("KEEP-DB");
  });

  it("保护副本：产出于数据根 backups-local/ 下", async () => {
    const p = await createLocalSafetyCopy(mkdtempSync(path.join(os.tmpdir(), "sc-")));
    expect(p.startsWith(path.join(dataRoot, "backups-local"))).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/backup/restore.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** `electron/domains/backup/restore.ts`

```ts
/**
 * 恢复装配（spec 2026-10-27 §4）：解包到 staging → 备份范围内逐项
 * 三步 rename 原子切换（旧→.old 暂存、staging→正式、清暂存），任一步
 * 失败反向恢复已动项；范围=BACKUP_ASSET_DIRS + database + .jwt-secret，
 * 范围外（logs 等）原样不动。staging 与暂存都放数据根直下（同卷保证
 * rename 原子）。测试失败注入：__setFailOnStep(1|2|3)。
 */
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDataHome, tianshuRoot } from "../../commons/paths";
import { BACKUP_ASSET_DIRS } from "./snapshot";
import { packTarGz, unpackTarGz } from "./ustar-tar";
import { createBackupArchive } from "./snapshot";

export const SAFETY_COPY_DIR_NAME = "backups-local";

/** 测试失败注入：>0 时对应切换步抛错（1=旧→暂存 2=staging→正式 3=清暂存） */
let failOnStep = 0;
export function __setFailOnStep(step: number): void {
  failOnStep = step;
}

/** 切换单元：备份范围内的具名目标（相对 appDataHome） */
function switchTargets(): string[] {
  return ["database", ...BACKUP_ASSET_DIRS, ".jwt-secret"];
}

export async function restoreArchive(archivePath: string): Promise<void> {
  // staging 解包（同卷：数据根直下）
  const staging = mkdtempSync(path.join(tianshuRoot(), ".restore-staging-"));
  try {
    await unpackTarGz(archivePath, staging);
    const home = appDataHome();
    const stamp = Date.now();
    const moved: Array<{ current: string; parked: string }> = [];
    try {
      for (const target of switchTargets()) {
        const current = path.join(home, target);
        const staged = path.join(staging, target);
        if (failOnStep === 1 || !existsSync(staged)) continue; // 包中无此项且本地有→保留？否——
        // 语义裁定：包中无 = 该项不在本备份中→本地保留不动（换机场景旧库可能无 workflow-assets）
        if (existsSync(current)) {
          if (failOnStep === 1) throw new Error("injected fail step 1");
          const parked = path.join(tianshuRoot(), `.restore-old-${stamp}`, target);
          renameSync(current, parked);
          moved.push({ current, parked });
        }
        if (failOnStep === 2) throw new Error("injected fail step 2");
        renameSync(staged, current);
      }
      if (failOnStep === 3) throw new Error("injected fail step 3");
      rmSync(path.join(tianshuRoot(), `.restore-old-${stamp}`), { recursive: true, force: true });
    } catch (err) {
      // 回滚：已挪的旧项归位，已就位的新项移除（恢复完整性：不留半新半旧）
      for (const m of moved.reverse()) {
        rmSync(m.current, { recursive: true, force: true });
        renameSync(m.parked, m.current);
      }
      throw err;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(path.join(tianshuRoot(), `.restore-old-${stamp ?? 0}`), { recursive: true, force: true });
  }
}

/** 恢复前保护副本：当前数据打 tar.gz 存数据根 backups-local/（不走网络） */
export async function createLocalSafetyCopy(tempDir: string): Promise<string> {
  const outDir = path.join(tianshuRoot(), SAFETY_COPY_DIR_NAME);
  const result = await createBackupArchive({ tempDir, appVersion: "safety-copy" });
  renameSync(result.archivePath, path.join(outDir, `safety-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`));
  return path.join(outDir, "PLACEHOLDER");
}
```

**实现注记**（上面骨架两处执行者必须修正）：
1. `restoreArchive` 里 `stamp` 变量作用域与 finally 清理需理顺（stamp 提到 try 外、finally 只清实际存在者）；
2. `createLocalSafetyCopy` 的最终路径应取 rename 后的真实文件名（先拼 `const dest = path.join(outDir, name)` 再 renameSync(src, dest) 再 `return dest`），且 `mkdirSync(outDir, { recursive: true })` 兜底；
3. 「包中无该项→本地保留」的语义裁定已注释在代码中——与测试用例「logs 原样不动」和「stale.db-journal 清除」对齐：stale 清除是因为 database 目录整体被切换；包中无 skills 目录时本地 skills 保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- tests/ai/backup/restore.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/backup/restore.ts tests/ai/backup/restore.test.ts
git commit -m "feat(backup): 恢复装配——staging 三步原子切换+失败回滚+本地保护副本"
```

---

### Task 8: IPC 面 + UI BackupGroup + i18n

**Files:**
- Create: `electron/domains/backup/ipc.ts`
- Modify: `electron/Application.ts`（import + 装配 registerBackupIpc——照 registerServerIpc 挂接位）
- Create: `src-react/domains/app-settings/components/BackupGroup.tsx`
- Modify: `src-react/domains/app-settings/components/SettingsDialog.tsx`（挂 BackupGroup）
- Modify: `src-react/i18n/locales/zh-CN/settings.json`、`src-react/i18n/locales/en-US/settings.json`
- Test: `tests/ai/backup/backup-ipc.test.ts`（handler 面直测，ipcMain mock）

**Interfaces:**
- Consumes: Task 5 `createBackupArchive`、Task 6 `BackupClient`、Task 7 `restoreArchive/createLocalSafetyCopy`；server 域 connections（取 direct 连接 baseUrl+token——`ConnectionConfig.mode === "direct"`）；electron `app.getVersion()`
- Produces: 前端 invoke 通道 `backup:list|backup:create|backup:restore|backup:delete`（入参含连接 id）+ 事件通道 `backup:progress`（payload `{ phase: "packing" | "uploading" | "downloading" | "restoring"; current: number; total: number }`）

- [ ] **Step 1: 写失败测试** `tests/ai/backup/backup-ipc.test.ts`（ipcMain/ipcRenderer mock + 依赖替身注入，registerBackupIpc(deps) 工厂式设计——与 face 域 ipc 同法）

核心用例（代码骨架，执行者补全断言）：
- `backup:create`：拿连接（stub 注入返回 direct 连接）→ 调 createBackupArchive（替身）→ BackupClient.uploadArchive（替身记录调用）→ 返回 commit 结果
- `backup:progress` 事件在 upload 阶段被 webContents.send 推送
- `backup:restore`：downloadArchive（替身落一个真 tar.gz 临时文件）→ restoreArchive（替身记录）→ 返回 `{ relaunchRequired: true }`
- 非 direct 连接（relay）→ 拒绝（错误信息含「仅支持直连」）
- 连接不存在 → 报错

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/backup/backup-ipc.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`electron/domains/backup/ipc.ts`（工厂注入依赖，头注释注明「构造即注册全部 handler，face 侧严禁二次构造」照 server/ipc.ts 惯例）：

```ts
/**
 * 备份域 IPC 面（spec 2026-10-27 §4）：四 invoke 通道 + progress 事件。
 * 依赖工厂注入（测试替身）；连接信息经注入的 connections 取 direct 连接
 * 的 baseUrl+token（relay 不开放——spec §1 裁定）。
 */
import { ipcMain, type BrowserWindow } from "electron";
import os from "node:os";
import { BackupClient } from "./backup-client";
import { createBackupArchive } from "./snapshot";
import { createLocalSafetyCopy, restoreArchive } from "./restore";

export interface BackupIpcDeps {
  getConnection(connId: string): { baseUrl?: string; token?: string; mode: string } | undefined;
  windows(): BrowserWindow[];
  makeClient?: (baseUrl: string, token?: string) => BackupClient;
  archive?: typeof createBackupArchive;
  safety?: typeof createLocalSafetyCopy;
  restore?: typeof restoreArchive;
}

export function registerBackupIpc(deps: BackupIpcDeps): void {
  const emit = (payload: { phase: string; current: number; total: number }) => {
    for (const w of deps.windows()) w.webContents.send("backup:progress", payload);
  };
  const clientFor = (connId: string) => {
    const conn = deps.getConnection(connId);
    if (!conn) throw new Error(`连接不存在：${connId}`);
    if (conn.mode !== "direct" || !conn.baseUrl) throw new Error("备份仅支持直连连接（relay 未开放）");
    return (deps.makeClient ?? ((u, t) => new BackupClient({ baseUrl: u, token: t })))(conn.baseUrl, conn.token);
  };

  ipcMain.handle("backup:list", (_e, connId: string) => clientFor(connId).list());
  ipcMain.handle("backup:delete", (_e, connId: string, backupId: string) => clientFor(connId).remove(backupId));

  ipcMain.handle("backup:create", async (_e, connId: string, note?: string) => {
    const { app } = await import("electron");
    emit({ phase: "packing", current: 0, total: 0 });
    const { mkdtempSync } = await import("node:fs");
    const osMod = await import("node:os");
    const tempDir = mkdtempSync(`${osMod.tmpdir()}/backup-`);
    try {
      const archive = await (deps.archive ?? createBackupArchive)({
        tempDir, appVersion: app.getVersion(),
      });
      emit({ phase: "uploading", current: 0, total: archive.meta.fileSize });
      const committed = await clientFor(connId).uploadArchive(
        archive.archivePath,
        { ...archive.meta, note, deviceName: os.hostname() },
        (current, total) => emit({ phase: "uploading", current, total })
      );
      return committed;
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  ipcMain.handle("backup:restore", async (_e, connId: string, backupId: string) => {
    const client = clientFor(connId);
    const { mkdtempSync, rmSync } = await import("node:fs");
    const osMod = await import("node:os");
    const tempDir = mkdtempSync(`${osMod.tmpdir()}/restore-`);
    try {
      const dest = `${tempDir}/download.tar.gz`;
      emit({ phase: "downloading", current: 0, total: 0 });
      await client.downloadArchive(backupId, dest, (current, total) => emit({ phase: "downloading", current, total }));
      emit({ phase: "restoring", current: 0, total: 0 });
      await (deps.safety ?? createLocalSafetyCopy)(tempDir);
      await (deps.restore ?? restoreArchive)(dest);
      return { relaunchRequired: true };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
```

（动态 import 收敛为顶部静态 import——执行者按文件顶部常规 import 整理；Application.ts 装配点照 registerServerIpc 旁注入 `getConnection`（server 域 connections 查询 API 以 connections.ts 实际导出为准）与 `windows()`（this.windows 或等价）。）

`BackupGroup.tsx`（消费 `invoke` from `@/lib/ipc`；连接下拉数据经 server 域既有连接列表 IPC；进度条用主题变量类名；删除/恢复按钮 `variant="outline"` + `hover:bg-primary-subtle` 悬停三件套；恢复成功弹二次确认 Dialog——文案含「将自动保留保护副本」与「应用将重启」；文本全部 `t("settings:backupXxx")`）：

```tsx
export function BackupGroup() {
  const { t } = useTranslation(["settings"]);
  // state：connections(Direct)、selectedConnId、backups、progress、busy
  // useEffect：加载连接列表（server 域连接 IPC）→ 选默认 direct → backup:list
  // 「立即备份」：invoke("backup:create", connId, note) → 完成 toast + 刷新 list
  // 列表行：时间/版本/大小（formatBytes）/note + 恢复/删除按钮
  // 进度条：on("backup:progress") 订阅（phase 分文案），百分比 current/total
  // 恢复：确认 Dialog → invoke("backup:restore") → 成功后提示即将重启
}
```

（组件完整实现执行者按 StorageGroup.tsx 同域样板写——分组标题/行布局/Dialog 形态全部照抄现有 Group 结构；i18n key 清单：`settings:backupTitle` `backupTargetHost` `backupNow` `backupNote` `backupProgress` `backupPhasePacking/Uploading/Downloading/Restoring` `backupListEmpty` `backupRestore` `backupRestoreConfirmTitle` `backupRestoreConfirmBody`（含保护副本+重启说明）`backupDelete` `backupDeleteConfirm` `backupOnlyDirect` `backupRelaunching`，zh-CN/en-US 两文件同批落。）

`SettingsDialog.tsx`：在 StorageGroup 之后插入 `<BackupGroup />`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npm run test -- tests/ai/backup/` 与 `npx tsc --noEmit -p tsconfig.json`（或项目 typecheck 脚本名）
Expected: 全 PASS、类型零错

- [ ] **Step 5: Commit**

```bash
git add electron/domains/backup/ipc.ts electron/Application.ts src-react/domains/app-settings/components/BackupGroup.tsx src-react/domains/app-settings/components/SettingsDialog.tsx src-react/i18n/locales/ tests/ai/backup/backup-ipc.test.ts
git commit -m "feat(backup): IPC 四通道+progress 事件——设置面板 BackupGroup 挂接+i18n 双语"
```

---

### Task 9: 收尾——协议包重建、README、整批验收

**Files:**
- Modify: `apps/tianshu-server/README.md`（能力段补备份端点一行：六端点 + TIANSHU_BACKUP_DIR/TIANSHU_BACKUP_TOKEN 配置说明）
- 无新代码文件

**Interfaces:**
- Consumes: 全部前序任务产物
- Produces: 可交付整批

- [ ] **Step 1: 协议包重建 dist（server 消费 dist 产物铁律）**

Run: `npm run sync:core -w apps/tianshu-server`（或根 `npm --prefix packages/tianshu-protocol run build`）
Expected: build 成功、dist 含 backup-contract

- [ ] **Step 2: 全量测试**

Run: `npm run test -w apps/tianshu-server` 与 `npm run test -- tests/ai/backup/`
Expected: 全 PASS

- [ ] **Step 3: README 更新 + drift 守护确认**

apps/tianshu-server/README 能力段补备份说明（六端点、TIANSHU_BACKUP_DIR 卷映射示例 `-e TIANSHU_BACKUP_DIR=/data/backups -v /host/backups:/data/backups`、TIANSHU_BACKUP_TOKEN 最小权限说明）；根仓 `npm run check:drift` 确认无新增双份漂移（本批全部新文件、无收编面）。

- [ ] **Step 4: 真机验收（用户手测清单——不自行起服务）**

给用户验收命令与步骤：
1. `npm run start:dev -w apps/tianshu-server`（终端 1）
2. `npm run dev`（终端 2，桌面端）
3. 设置面板 → 备份与恢复：选 direct 连接 → 立即备份 → 观察进度条 → list 出现新档
4. 服务端侧核对：`ls ~/.tianshu-server/backups/<id>/`（meta.json + data.tar.gz）、`tar -tzf` 人工抽查
5. 恢复演练：在测试机上改一条数据 → 恢复刚备份的档 → relaunch 后数据回到备份时点 + `~/.tianshu/backups-local/` 有保护副本

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/README.md
git commit -m "docs(server): README 补备份六端点与 TIANSHU_BACKUP_DIR/BACKUP_TOKEN 配置说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 备份内容/打包器/通道/schema 零变更（Task 4/5）、§2 六端点+存储+保留策略+防线（Task 2/3）、§3 鉴权两层+完整性+明文留档（Task 3+各任务 hash 链）、§4 桌面端备份/恢复/保护副本/原子切换/UI（Task 5/6/7/8）、§5 协议包契约（Task 1）、§6 测试策略（各任务 Step 1 + Task 9）、§7 非目标未越界（未做实体同步/relay/加密/移动端/定时）、§8 风险均有对应防线（better-sqlite3 ABI 替身法 Task 5、15s 窗绕行 Task 6 独立 fetch、rename 目录级切换 Task 7、.jwt-secret 属预期 Task 5 收录）。
- **类型一致性**：`BackupCreateRequest/BackupChunkRequest/BackupMeta/BackupCommitResult` 等全链引用 Task 1 定义；`BACKUP_ASSET_DIRS` Task 5 定义 Task 7 消费；`TarEntry` Task 4 定义 Task 5 消费。
- **已知留白（执行者现场对齐项，非设计缺口）**：BusinessException 构造签名（Task 2 注记）、tests 内 import 路径形态（Task 4/5 注记）、connections.ts 取连接的准确 API 名（Task 8 注记）、BackupGroup 完整 JSX（Task 8 给样板指向+i18n key 全集）。
