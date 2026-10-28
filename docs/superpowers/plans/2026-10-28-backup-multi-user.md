# 备份多用户批（邀请码申领 + owner 隔离）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多客户端桌面端向同一服务端备份：邀请码自助申领专属 token，六端点按 owner 隔离（列表/恢复/删除/保留额），admin 全局可见可管理。

**Architecture:** BackupGuard 升级双身份识别（客户端注册表 token / admin token），guard 注入 identity 贯穿 service 全端点；邀请码与客户端注册表存 server option 表（单进程锁原子核销）；桌面端 ConnectionConfig 加 backupToken 字段解双身份冲突，BackupGroup 加申领入口与管理面板。

**Tech Stack:** NestJS/Fastify（server）、Electron 主进程、@tianshu/protocol 契约、Jest/Vitest。

**Spec:** `docs/superpowers/specs/2026-10-28-backup-multi-user-design.md`

## Global Constraints

- **执行方式：本批代码在 git worktree 隔离分支实施**（用户 2026-10-28 裁定「默认 worktree，仅明示才走 main」）——worktree 由控制器在执行期创建，任务内提交照常进行
- 零新依赖；server 侧 Prettier 单引号 trailingComma=all、mirror 侧双引号无尾随逗号（electron 侧随上一批现状）；文件名 kebab-case
- 他人档/越权一律 `BACKUP_NOT_FOUND`（**非 403**——防存在性探测，spec §3）
- `BackupCreateRequest` **不加** owner——服务端鉴权注入，客户端自报字段忽略
- 存量无 owner 档读取期兜底 `__admin__`（不回写盘、无迁移脚本）
- clientToken 只在 claim 响应明文回显一次；注册表只存 sha256
- 邀请码 `TS-` + 8 位防混淆字符集（`ABCDEFGHJKMNPQRSTUVWXYZ23456789`），一次性核销、无过期
- claim 端点豁免 BackupGuard（token.guard.ts webhook 前缀豁免同款），其鉴权=StaticTokenGuard 大门 token+邀请码
- i18n zh-CN/en-US 同任务同构落，禁硬编码文案；样式主题变量
- 测试跑法：server `npm run test -w apps/tianshu-server`；mirror `npm run test -- tests/ai/backup/`；改协议包后 server 侧需 `npm run sync:core -w apps/tianshu-server` 重建 dist
- 上一批产物（本批基底）：`backup.guard.ts`（单 token BackupGuard）、`backup.service.ts`（六方法，trim 全局）、`backup.controller.ts`（六端点+controller 级 @UseGuards(BackupGuard)）、`backup-contract.ts`（DTO）、桌面 `backup/ipc.ts`（五通道+progress）、`BackupGroup.tsx`、`ConnectionConfig`（electron/domains/server/connections.ts，含 token 字段）

---

### Task 1: 协议契约扩展——owner 与 claim/invites/clients DTO

**Files:**
- Modify: `packages/tianshu-protocol/src/backup-contract.ts`
- Test: `tests/ai/backup/backup-contract.test.ts`（追加用例）

**Interfaces:**
- Consumes: 既有 BackupMeta/BackupListResult 等（本文件）
- Produces（后续任务全部自这里 import）:
  - `BACKUP_ADMIN_OWNER = "__admin__"`
  - `BackupMeta` 增加 `owner: string`（必填）
  - `BackupListResult` 改为 `{ backups: BackupMeta[]; viewer: BackupViewer }`
  - `BackupViewer = { kind: "client" | "admin"; clientId?: string }`
  - `BackupClaimRequest = { inviteCode: string; deviceName: string }`、`BackupClaimResult = { clientId: string; clientToken: string }`
  - `BackupInviteRecord = { code: string; note?: string; createdAt: string; usedAt?: string; usedBy?: string }`
  - `BackupCreateInvitesRequest = { count?: number; note?: string }`、`BackupCreateInvitesResult = { invites: BackupInviteRecord[] }`
  - `BackupClientRecord = { clientId: string; createdAt: string; invitedNote?: string }`
  - 错误码字符串常量 `BACKUP_CLIENT_NAME_TAKEN = "BACKUP_CLIENT_NAME_TAKEN"`、`BACKUP_INVITE_INVALID = "BACKUP_INVITE_INVALID"`、`BACKUP_ADMIN_ONLY = "BACKUP_ADMIN_ONLY"`
  - 常量 `BACKUP_INVITE_PREFIX = "TS-"`、`BACKUP_INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"`、`BACKUP_INVITE_LENGTH = 8`

- [ ] **Step 1: 追加失败测试**（既有文件追加 describe）：

```ts
import {
  BACKUP_ADMIN_OWNER, BACKUP_INVITE_PREFIX, BACKUP_INVITE_ALPHABET,
  BACKUP_INVITE_LENGTH, BACKUP_CLIENT_NAME_TAKEN, BACKUP_INVITE_INVALID,
  BACKUP_ADMIN_ONLY, type BackupMeta, type BackupListResult,
  type BackupClaimRequest, type BackupClaimResult, type BackupInviteRecord,
  type BackupCreateInvitesRequest, type BackupCreateInvitesResult,
  type BackupClientRecord
} from "@tianshu/protocol";

describe("backup-contract 多用户扩展", () => {
  it("常量锁定", () => {
    expect(BACKUP_ADMIN_OWNER).toBe("__admin__");
    expect(BACKUP_INVITE_PREFIX).toBe("TS-");
    expect(BACKUP_INVITE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
    expect(BACKUP_INVITE_LENGTH).toBe(8);
    expect([BACKUP_CLIENT_NAME_TAKEN, BACKUP_INVITE_INVALID, BACKUP_ADMIN_ONLY])
      .toEqual(["BACKUP_CLIENT_NAME_TAKEN", "BACKUP_INVITE_INVALID", "BACKUP_ADMIN_ONLY"]);
  });
  it("BackupMeta.owner 必填 + viewer 结构编译期断言", () => {
    const meta: BackupMeta = {
      id: "b1", createdAt: "2026-10-28T00:00:00.000Z", appVersion: "1.0.0",
      schemaVersion: 1, fileSize: 1, sha256: "a".repeat(64),
      chunkCount: 1, status: "ready", owner: "zhangsan-imac"
    };
    const list: BackupListResult = {
      backups: [meta], viewer: { kind: "client", clientId: "zhangsan-imac" }
    };
    const adminView: BackupListResult["viewer"] = { kind: "admin" };
    expect([list, adminView]).toHaveLength(2);
  });
  it("claim/invites/clients DTO 编译期断言", () => {
    const claimReq: BackupClaimRequest = { inviteCode: "TS-ABCD2345", deviceName: "imac" };
    const claimRes: BackupClaimResult = { clientId: "imac", clientToken: "t".repeat(32) };
    const invite: BackupInviteRecord = { code: "TS-ABCD2345", note: "n", createdAt: "2026-10-28T00:00:00.000Z" };
    const mk: BackupCreateInvitesRequest = { count: 3, note: "n" };
    const mkRes: BackupCreateInvitesResult = { invites: [invite] };
    const client: BackupClientRecord = { clientId: "imac", createdAt: "2026-10-28T00:00:00.000Z" };
    expect([claimReq, claimRes, mk, mkRes, client]).toHaveLength(5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**——Run: `npm run test -- tests/ai/backup/backup-contract.test.ts`，Expected: FAIL（新导出不存在）
- [ ] **Step 3: 实现**——backup-contract.ts 追加上述常量与类型；`BackupMeta` 加 `owner: string`（注释注明「存量档读取期由 server 兜底 BACKUP_ADMIN_OWNER」）；`BackupListResult` 改形 `{ backups; viewer }`（同步更新头注释）
- [ ] **Step 4: 跑测试确认通过**——同 Step 1 命令，Expected: PASS
- [ ] **Step 5: Commit**——`git add packages/tianshu-protocol/src/backup-contract.ts tests/ai/backup/backup-contract.test.ts && git commit -m "feat(protocol): backup 契约多用户扩展——owner/viewer/claim/invites/clients DTO"`

---

### Task 2: server 端 BackupRegistry（注册表+邀请码，原子核销）

**Files:**
- Create: `apps/tianshu-server/src/modules/backup/backup-registry.ts`
- Test: `apps/tianshu-server/test/modules/backup-registry.spec.ts`

**Interfaces:**
- Consumes: PrismaService（option 表 upsert 读写 `type='app'`）；Task 1 常量（BACKUP_INVITE_* / BACKUP_CLIENT_NAME_TAKEN / BACKUP_INVITE_INVALID）；BusinessException `(message, code)` 双参
- Produces（Task 3/5 消费）:
  - `interface StoredBackupClient { clientId: string; tokenHash: string; createdAt: string; invitedNote?: string }`
  - `class BackupRegistry { constructor(prisma: PrismaService) }`
  - `findClientByToken(token: string): Promise<StoredBackupClient | undefined>`——sha256 摘 timingSafeEqual 逐条比对
  - `listClients(): Promise<BackupClientRecord[]>`（永不返回 tokenHash）
  - `removeClient(clientId: string): Promise<{ removed: true }>`（不存在抛 BACKUP_NOT_FOUND）
  - `claimInvite(inviteCode: string, deviceName: string): Promise<BackupClaimResult>`（核销+注册一步原子）
  - `createInvites(count: number, note?: string): Promise<BackupCreateInvitesResult>`
  - `listInvites(): Promise<BackupInviteRecord[]>`、`removeInvite(code: string): Promise<{ removed: true }>`

- [ ] **Step 1: 写失败测试** `test/modules/backup-registry.spec.ts`（files.spec 样板：prisma stub 内存 option 表 + env 注入）：

```ts
// BackupRegistry 单测：注册表/邀请码 option 表读写 + claim 原子核销 + token 只存 hash。
// prisma stub 用内存 Map 模拟 option 表 upsert/findUnique（type+name 复合键）。
import { createHash } from 'node:crypto';
import { BackupRegistry } from 'src/modules/backup/backup-registry';

const optionRows = new Map<string, string>(); // key: `${type}/${name}` → value(JSON 字符串)
const prismaStub = {
  option: {
    findUnique: jest.fn(async ({ where }: { where: { type: string; name: string } }) => {
      const v = optionRows.get(`${where.type}/${where.name}`);
      return v === undefined ? null : { type: where.type, name: where.name, value: v };
    }),
    upsert: jest.fn(async ({ where, update, create }: any) => {
      const key = `${where.type_name.type}/${where.type_name.name}`;
      optionRows.set(key, (update ?? create).value);
      return { type: where.type_name.type, name: where.type_name.name };
    }),
  },
};
jest.mock('src/commons/database/prisma.service', () => ({
  PrismaService: jest.fn(() => prismaStub),
}));

const registry = () => new BackupRegistry(prismaStub as never);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('BackupRegistry', () => {
  it('createInvites：TS- 前缀 8 位防混淆字符集，note 透传', async () => {
    const r = await registry().createInvites(3, '团队发放');
    expect(r.invites).toHaveLength(3);
    for (const inv of r.invites) {
      expect(inv.code).toMatch(/^TS-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      expect(inv.note).toBe('团队发放');
    }
  });

  it('claim：核销邀请码 + 注册设备 + token 明文仅此一次 + 落库仅 hash', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    const claimed = await reg.claimInvite(code, 'zhangsan-imac');
    expect(claimed.clientId).toBe('zhangsan-imac');
    expect(claimed.clientToken).toMatch(/^[0-9a-f]{32}$/);
    // findClientByToken 能认；落库行不含明文
    const stored = await reg.findClientByToken(claimed.clientToken);
    expect(stored?.clientId).toBe('zhangsan-imac');
    expect(JSON.stringify([...optionRows.values()])).not.toContain(claimed.clientToken);
    expect(stored?.tokenHash).toBe(sha256(claimed.clientToken));
  });

  it('claim：同码二次核销拒绝 BACKUP_INVITE_INVALID', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    await reg.claimInvite(code, 'a-imac');
    await expect(reg.claimInvite(code, 'b-imac')).rejects.toMatchObject({ code: 'BACKUP_INVITE_INVALID' });
  });

  it('claim：并发同码仅一次成功（原子核销）', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    const results = await Promise.allSettled([
      reg.claimInvite(code, 'c1'), reg.claimInvite(code, 'c2'), reg.claimInvite(code, 'c3'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(2);
    for (const r of bad) expect((r as PromiseRejectedResult).reason.code).toBe('BACKUP_INVITE_INVALID');
  });

  it('claim：设备名已注册拒绝 BACKUP_CLIENT_NAME_TAKEN', async () => {
    const reg = registry();
    const [i1, i2] = (await reg.createInvites(2)).invites;
    await reg.claimInvite(i1.code, 'dup-imac');
    await expect(reg.claimInvite(i2.code, 'dup-imac')).rejects.toMatchObject({ code: 'BACKUP_CLIENT_NAME_TAKEN' });
  });

  it('removeClient 后设备名可重新申领 + findClientByToken 失效', async () => {
    const reg = registry();
    const [i1, i2] = (await reg.createInvites(2)).invites;
    const first = await reg.claimInvite(i1.code, 're-imac');
    await reg.removeClient('re-imac');
    expect(await reg.findClientByToken(first.clientToken)).toBeUndefined();
    const second = await reg.claimInvite(i2.code, 're-imac');
    expect(second.clientToken).not.toBe(first.clientToken);
  });

  it('listClients/listInvites：不含敏感字段；remove 不存在抛 BACKUP_NOT_FOUND', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    await reg.claimInvite(code, 'vis-imac');
    expect(await reg.listClients()).toEqual([
      expect.objectContaining({ clientId: 'vis-imac' }),
    ]);
    expect(JSON.stringify(await reg.listClients())).not.toContain('tokenHash');
    await expect(reg.removeClient('ghost')).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    await expect(reg.removeInvite('TS-XXXXXXXX')).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
  });
});
```

（各用例独立注册表状态——prisma stub 的 optionRows 为文件级共享，用例按唯一设备名隔离；若 flaky 可 beforeEach 清 Map。）

- [ ] **Step 2: 跑测试确认失败**——Run: `npm run test -w apps/tianshu-server -- backup-registry`，Expected: FAIL
- [ ] **Step 3: 实现** `backup-registry.ts` 核心结构：

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import {
  BACKUP_CLIENT_NAME_TAKEN, BACKUP_INVITE_ALPHABET, BACKUP_INVITE_INVALID,
  BACKUP_INVITE_LENGTH, BACKUP_INVITE_PREFIX, type BackupClaimResult,
  type BackupClientRecord, type BackupCreateInvitesResult, type BackupInviteRecord,
} from '@tianshu/protocol';

const CLIENTS_KEY = { type: 'app', name: 'backupClients' } as const;
const INVITES_KEY = { type: 'app', name: 'backupInvites' } as const;

export interface StoredBackupClient { clientId: string; tokenHash: string; createdAt: string; invitedNote?: string; }

/** 单进程互斥：claim/create/remove 的读改写全程串行（server 单进程——
 *  backup.service cursor Map 同先例） */
let registryLock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = registryLock.then(fn, fn);
  registryLock = next.catch(() => undefined);
  return next;
}

function randomInviteCode(): string {
  const bytes = randomBytes(BACKUP_INVITE_LENGTH);
  let code = '';
  for (let i = 0; i < BACKUP_INVITE_LENGTH; i++) {
    code += BACKUP_INVITE_ALPHABET[bytes[i] % BACKUP_INVITE_ALPHABET.length];
  }
  return `${BACKUP_INVITE_PREFIX}${code}`;
}

@Injectable()
export class BackupRegistry {
  constructor(private readonly prisma: PrismaService) {}

  async findClientByToken(token: string): Promise<StoredBackupClient | undefined> {
    for (const c of await this.readClients()) {
      if (this.hashEq(token, c.tokenHash)) return c;
    }
    return undefined;
  }

  async claimInvite(inviteCode: string, deviceName: string): Promise<BackupClaimResult> {
    return serialized(async () => {
      const invites = await this.readInvites();
      const invite = invites.find((i) => i.code === inviteCode);
      if (!invite || invite.usedAt) throw new BusinessException('邀请码无效或已被使用', BACKUP_INVITE_INVALID);
      const clients = await this.readClients();
      if (clients.some((c) => c.clientId === deviceName)) {
        throw new BusinessException('设备名已被注册，请更换', BACKUP_CLIENT_NAME_TAKEN);
      }
      const clientToken = randomBytes(16).toString('hex'); // 32 hex
      clients.push({ clientId: deviceName, tokenHash: sha256hex(clientToken), createdAt: new Date().toISOString(), invitedNote: invite.note });
      invite.usedAt = new Date().toISOString();
      invite.usedBy = deviceName;
      await this.writeClients(clients);
      await this.writeInvites(invites);
      return { clientId: deviceName, clientToken };
    });
  }
  // createInvites/listInvites/removeInvite/listClients/removeClient 同法：
  // 读改写经 serialized；removeInvite 拒删已用码？——不拒（撤销语义含清理已用），不存在才抛
  // readClients/writeClients/readInvites/writeInvites：prisma.option findUnique/upsert JSON 序列化
  // hashEq：双 sha256 摘 timingSafeEqual（token.guard.ts isEqual 同款）
}
```

- [ ] **Step 4: 跑测试确认通过**——Run: 同 Step 2，Expected: PASS（7 用例）
- [ ] **Step 5: Commit**——`git add apps/tianshu-server/src/modules/backup/backup-registry.ts apps/tianshu-server/test/modules/backup-registry.spec.ts && git commit -m "feat(server): BackupRegistry——客户端注册表+邀请码原子核销，token 仅存 sha256"`

---

### Task 3: BackupGuard 双身份升级（identity 注入 + claim 豁免）

**Files:**
- Modify: `apps/tianshu-server/src/modules/backup/backup.guard.ts`
- Modify: `apps/tianshu-server/test/modules/backup-guard.spec.ts`（重写扩充）
- Modify: `apps/tianshu-server/src/modules/backup/backup.module.ts`（providers 加 BackupRegistry）

**Interfaces:**
- Consumes: Task 2 `BackupRegistry.findClientByToken`；既有 token.guard.ts timingSafeEqual 款式
- Produces（Task 4/5 消费）:
  - `export interface BackupIdentity { kind: "client" | "admin"; clientId?: string }`
  - `const BACKUP_CLAIM_PATH = 'backup/claim'`（豁免前缀判定用）
  - guard 注入 `request.backupIdentity: BackupIdentity`（controller 经 `@Req()` 读取——Task 4/5 以 `(req as { backupIdentity: BackupIdentity }).backupIdentity` 取）
  - `BackupGuard` 构造签名变 `constructor(private readonly registry: BackupRegistry)`（DI）

- [ ] **Step 1: 重写失败测试**（原四用例语义保留 + 新增六态）：

```ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { BackupGuard } from 'src/modules/backup/backup.guard';

const registryStub = { findClientByToken: jest.fn() };
jest.mock('src/modules/backup/backup-registry', () => ({
  BackupRegistry: jest.fn(() => registryStub),
}));

const ctx = (authorization?: string, url = '/api/backup/list') =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization }, url }) }) }) as unknown as ExecutionContext;
const identityOf = (c: ExecutionContext) =>
  (c.switchToHttp().getRequest() as { backupIdentity?: unknown }).backupIdentity;

describe('BackupGuard 双身份', () => {
  const ORIG_BACKUP = process.env.TIANSHU_BACKUP_TOKEN;
  afterEach(() => {
    if (ORIG_BACKUP === undefined) delete process.env.TIANSHU_BACKUP_TOKEN;
    else process.env.TIANSHU_BACKUP_TOKEN = ORIG_BACKUP;
    registryStub.findClientByToken.mockReset();
  });

  it('客户端 token 命中注册表 → identity client + clientId 注入', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    registryStub.findClientByToken.mockResolvedValue({ clientId: 'imac-1', tokenHash: 'h' });
    const c = ctx('Bearer client-token');
    await expect(new BackupGuard(registryStub as never).canActivate(c)).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'client', clientId: 'imac-1' });
  });
  it('客户端 token 未命中 → 401（即便它等于 TIANSHU_TOKEN 也先按注册表查、未命中回落 admin 判定）', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    registryStub.findClientByToken.mockResolvedValue(undefined);
    await expect(new BackupGuard(registryStub as never).canActivate(ctx('Bearer nope'))).rejects.toThrow(UnauthorizedException);
  });
  it('admin：TIANSHU_TOKEN 匹配（未设 BACKUP_TOKEN）→ identity admin', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    process.env.TIANSHU_TOKEN = 'global-tok';
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx('Bearer global-tok');
    await expect(new BackupGuard(registryStub as never).canActivate(c)).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'admin' });
  });
  it('admin：BACKUP_TOKEN 设置时只认它（TIANSHU_TOKEN 被拒——现状语义不变）', async () => {
    process.env.TIANSHU_BACKUP_TOKEN = 'sekrit';
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx('Bearer sekrit');
    await expect(new BackupGuard(registryStub as never).canActivate(c)).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'admin' });
    await expect(new BackupGuard(registryStub as never).canActivate(ctx('Bearer global-tok'))).rejects.toThrow(UnauthorizedException);
  });
  it('claim 路径豁免（不设 identity——其鉴权=大门 token+邀请码本身）', async () => {
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx(undefined, '/api/backup/claim');
    expect(new BackupGuard(registryStub as never).canActivate(c)).toBe(true);
    expect(identityOf(c)).toBeUndefined();
  });
  it('未设任何 token（本地开发）→ admin identity 放行（现状回落）', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    delete process.env.TIANSHU_TOKEN;
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx(undefined);
    await expect(new BackupGuard(registryStub as never).canActivate(c)).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'admin' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**——Run: `npm run test -w apps/tianshu-server -- backup-guard`，Expected: FAIL（构造签名/identity 不存在）
- [ ] **Step 3: 实现升级**：guard canActivate 序——①url 判 `backup/claim` 前缀（剥 query、contextPath 归一——token.guard.ts isWebhookPath 同款写法）→ 放行不注入；②`registry.findClientByToken(bearer)` 命中 → 注入 client identity；③admin 判定（BACKUP_TOKEN ?? TIANSHU_TOKEN，双判 timingSafeEqual sha256 摘）→ 注入 admin；④401。backup.module.ts providers 加 `BackupRegistry`
- [ ] **Step 4: 跑测试确认通过**——Run: 同 Step 2 + `npm run test -w apps/tianshu-server -- backup`（service 既有回归），Expected: PASS
- [ ] **Step 5: Commit**——`git add apps/tianshu-server/src/modules/backup/backup.guard.ts apps/tianshu-server/src/modules/backup/backup.module.ts apps/tianshu-server/test/modules/backup-guard.spec.ts && git commit -m "feat(server): BackupGuard 双身份——注册表客户端/admin 注入 identity，claim 豁免"`

---

### Task 4: BackupService owner 隔离（六方法全签名升级 + trim 分组 + 旧档兜底）

**Files:**
- Modify: `apps/tianshu-server/src/modules/backup/backup.service.ts`
- Modify: `apps/tianshu-server/test/modules/backup.spec.ts`（追加用例组）
- Modify: `apps/tianshu-server/src/modules/backup/backup.controller.ts`（identity 透传——仅改传参，端点逻辑 Task 5 扩）

**Interfaces:**
- Consumes: Task 1 `BACKUP_ADMIN_OWNER`/`BackupIdentity`（guard 注入）、`BackupViewer`；Task 3 `BackupIdentity`
- Produces（Task 5 controller 消费）:
  - 六方法加末参 `identity: BackupIdentity`：`create(req, identity)`、`putChunk(req, identity)`、`commit(id, identity)`、`list(identity): Promise<BackupListResult>`（含 viewer）、`download(req, identity)`、`remove(id, identity)`
  - `putChunk`/`commit` 对 client 非己档抛 `BACKUP_NOT_FOUND`（uploading 档归属校验）
  - `readMeta` 返回 `{...meta, owner: meta.owner ?? BACKUP_ADMIN_OWNER}`（读取期兜底，不回写）

- [ ] **Step 1: 追加失败测试**（既有 15 用例先改为传 `IDENTITY_ADMIN` 常量 `{kind:"admin"}` 保持绿，再追加）：

```ts
import { BACKUP_ADMIN_OWNER } from '@tianshu/protocol';
const IDENTITY_ADMIN = { kind: 'admin' } as const;
const IDENTITY_A = { kind: 'client', clientId: 'client-a' } as const;
const IDENTITY_B = { kind: 'client', clientId: 'client-b' } as const;

describe('BackupService owner 隔离', () => {
  async function makeReadyBackup(owner: string): Promise<string> {
    const buf = Buffer.from(`payload-${owner}`);
    const { id } = await service.create({ appVersion: '1', schemaVersion: 1, fileSize: buf.length, sha256: sha256(buf), chunkCount: 1, note: owner }, { kind: 'client', clientId: owner });
    await service.putChunk({ id, seq: 0, data: buf.toString('base64'), chunkSha256: sha256(buf) }, { kind: 'client', clientId: owner });
    await service.commit(id, { kind: 'client', clientId: owner });
    return id;
  }

  it('create：owner 随 identity 注入 meta（自报 owner 字段被忽略）', async () => {
    const buf = Buffer.from('x');
    const { id } = await service.create({ appVersion: '1', schemaVersion: 1, fileSize: 1, sha256: sha256(buf), chunkCount: 1 }, IDENTITY_A);
    const meta = (await service.list(IDENTITY_A)).backups.find((b) => b.id === id);
    expect(meta?.owner).toBe('client-a');
  });
  it('list：客户端仅见自己 + viewer 回显；admin 全量', async () => {
    await makeReadyBackup('client-a');
    await makeReadyBackup('client-b');
    const a = await service.list(IDENTITY_A);
    expect(a.backups.every((b) => b.owner === 'client-a')).toBe(true);
    expect(a.viewer).toEqual({ kind: 'client', clientId: 'client-a' });
    const admin = await service.list(IDENTITY_ADMIN);
    expect(admin.backups.map((b) => b.owner)).toEqual(expect.arrayContaining(['client-a', 'client-b']));
    expect(admin.viewer).toEqual({ kind: 'admin' });
  });
  it('download/remove：他人档 BACKUP_NOT_FOUND（防存在性探测）', async () => {
    const id = await makeReadyBackup('client-a');
    await expect(service.download({ id, seq: 0 }, IDENTITY_B)).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    await expect(service.remove(id, IDENTITY_B)).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    // 档还在（B 的尝试不动 A 的数据）
    await expect(service.download({ id, seq: 0 }, IDENTITY_A)).resolves.toBeTruthy();
  });
  it('putChunk/commit：client 对他人 uploading 档 NOT_FOUND；admin 可操作任意', async () => {
    const buf = Buffer.from('y');
    const { id } = await service.create({ appVersion: '1', schemaVersion: 1, fileSize: 1, sha256: sha256(buf), chunkCount: 1 }, IDENTITY_A);
    await expect(service.putChunk({ id, seq: 0, data: 'YQ==', chunkSha256: sha256(Buffer.from('a')) }, IDENTITY_B)).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    await expect(service.commit(id, IDENTITY_B)).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
  });
  it('旧档兜底 __admin__：手写无 owner meta.json 读取期补齐，admin 可见', async () => {
    // 手工落一份无 owner 的旧档（照 backup-root 结构）——断言 list(admin) 行 owner === BACKUP_ADMIN_OWNER
    // 且 identity 为 client 时不可见（owner 不是自己）
  });
  it('保留策略按 owner 分组：A 满额被裁不影响 B 的档', async () => {
    prismaStub.option.findUnique.mockResolvedValueOnce({ value: '1' }); // maxKeep=1 仅本用例
    await makeReadyBackup('client-a'); await makeReadyBackup('client-a'); // A 第二档裁掉第一档
    const bId = await makeReadyBackup('client-b'); // B 唯一档保留
    const a = await service.list(IDENTITY_A);
    expect(a.backups).toHaveLength(1);
    const b = await service.list(IDENTITY_B);
    expect(b.backups.map((x) => x.id)).toContain(bId);
  });
});
```

（「旧档兜底」用例：`writeFileSync(metaPath, JSON.stringify({...合法meta, 无 owner}))` + 空 data.tar.gz 后 list 断言——具体照既有 spec 文件工具函数形态落。）

- [ ] **Step 2: 跑测试确认失败**——Run: `npm run test -w apps/tianshu-server -- backup.spec`，Expected: 新组 FAIL（旧组先随签名改动同步）
- [ ] **Step 3: 实现**：六方法加 identity 末参；`create` 写 meta 时 `owner: identity.kind === 'admin' ? BACKUP_ADMIN_OWNER : identity.clientId`（req 中若带 owner 字段不透传——显式挑选字段落 meta，顺手关闭上一批 deferred 的「spread 穿透」）；`readMeta` 兜底；`list` 过滤+viewer；`download`/`remove`/`putChunk`/`commit` 归属校验（client 且 owner≠clientId → NOT_FOUND）；`trimOldBackups` 改 `groupBy owner` 后逐组裁；controller 六端点透传 `(req as {backupIdentity}).backupIdentity`
- [ ] **Step 4: 跑测试确认通过 + 全量**——Run: `npm run test -w apps/tianshu-server`，Expected: 全 PASS
- [ ] **Step 5: Commit**——`git add apps/tianshu-server/src/modules/backup/backup.service.ts apps/tianshu-server/src/modules/backup/backup.controller.ts apps/tianshu-server/test/modules/backup.spec.ts && git commit -m "feat(server): backup owner 隔离——identity 贯穿六端点+trim 分组+旧档兜底"`

---

### Task 5: claim/invites/clients 端点

**Files:**
- Modify: `apps/tianshu-server/src/modules/backup/backup.controller.ts`
- Modify: `apps/tianshu-server/src/modules/backup/backup.module.ts`（无新增 provider 时不动）
- Test: `apps/tianshu-server/test/modules/backup-endpoints.spec.ts`（controller 面直测：registry stub + identity 注入）

**Interfaces:**
- Consumes: Task 2 BackupRegistry 全方法面；Task 3 BackupIdentity；Task 1 DTO
- Produces（Task 7 客户端消费）:
  - `POST backup/claim {inviteCode, deviceName}` → BackupClaimResult（guard 豁免路径）
  - `POST backup/invites/create {count?, note?}` → BackupCreateInvitesResult（admin only）
  - `POST backup/invites/list` → `{invites: BackupInviteRecord[]}`（admin only）
  - `POST backup/invites/:code/delete`（admin only）
  - `POST backup/clients/list` → `{clients: BackupClientRecord[]}`（admin only）
  - `POST backup/clients/:clientId/delete`（admin only）
  - 非 admin 调管理端点 → BusinessException `BACKUP_ADMIN_ONLY`

- [ ] **Step 1: 写失败测试**（controller 直测：`new BackupController(registryStub, serviceStub as never)`；管理端点传 client identity 断言拒、传 admin 断言透传 registry）：

核心用例（骨架，断言补全）：
- claim：`controller.claim({inviteCode, deviceName})` → registry.claimInvite 同参透传、结果直返（claim 无 identity 要求）
- invites/create：identity admin → registry.createInvites(count, note)；identity client → rejects `{code: 'BACKUP_ADMIN_ONLY'}`
- invites/list、invites/:code/delete、clients/list、clients/:clientId/delete：同 admin/client 双态
- 参数校验 DTO：inviteCode `@IsString @Matches(/^TS-[A-Z2-9]{8}$/)`、deviceName `@IsString @MinLength(1) @MaxLength(64) @Matches(/^[a-zA-Z0-9_-]+$/)`（clientId 用作目录无关、仅 JSON——仍收敛字符防奇怪值）、count `@IsOptional @IsInt @Min(1) @Max(50)`

- [ ] **Step 2: 跑测试确认失败**——Run: `npm run test -w apps/tianshu-server -- backup-endpoints`，Expected: FAIL
- [ ] **Step 3: 实现**：controller 加六方法 + DTO class（`ClaimDto`/`CreateInvitesDto`）；`requireAdmin(identity)` 私有助手（非 admin 抛 BusinessException('仅管理员可操作', BACKUP_ADMIN_ONLY)）；claim 方法直调 registry（identity 不要求）；controller 构造注入 `BackupRegistry`
- [ ] **Step 4: 跑测试确认通过 + 全量**——Run: `npm run test -w apps/tianshu-server`，Expected: 全 PASS
- [ ] **Step 5: Commit**——`git add apps/tianshu-server/src/modules/backup/backup.controller.ts apps/tianshu-server/test/modules/backup-endpoints.spec.ts && git commit -m "feat(server): backup claim/invites/clients 六端点——邀请码申领与管理面"`

---

### Task 6: 桌面端 backupToken 字段与 ipc 优先级

**Files:**
- Modify: `electron/domains/server/connections.ts`（`ConnectionConfig` 加 `backupToken?: string`——接口字段 + 持久化形状自然透传（option JSON 整体读写，无 schema 校验阻碍；执行者核实 save/load 无白名单挑选）
- Modify: `electron/domains/backup/ipc.ts`（`clientFor` 取 `conn.backupToken ?? conn.token` 作 BackupClient token；claim 相关 Task 7）
- Test: `tests/ai/backup/backup-ipc.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 3/5 server 端点（claim 形态）；ConnectionConfig
- Produces（Task 7 UI 消费）:
  - `ConnectionConfig.backupToken?: string`（可选；主机页连接编辑表单 Task 7 加输入）
  - ipc `clientFor` 语义：备份请求的 Bearer token = `backupToken ?? token`

- [ ] **Step 1: 追加失败测试**：

```ts
it("backupToken 优先：连接配了 backupToken 时 makeClient 收到它而非远控 token", async () => {
  const conn = { id: "c1", name: "直连A", mode: "direct" as const, baseUrl: "http://x", token: "remote-tok", backupToken: "backup-tok" };
  const { deps } = makeDeps(conn);  // 既有替身工厂——getConnection 返回 conn
  registerBackupIpc(deps);
  await call("backup:list", "c1");
  expect(deps.makeClient).toHaveBeenCalledWith("http://x", "backup-tok");
});
it("未配 backupToken 回落 token（现状兼容）", async () => {
  const { deps } = makeDeps(DIRECT); // DIRECT 无 backupToken
  registerBackupIpc(deps);
  await call("backup:list", "c1");
  expect(deps.makeClient).toHaveBeenCalledWith("http://127.0.0.1:3999", "tok-1");
});
```

（makeDeps 替身工厂签名放宽 conn 形状含 backupToken?。）

- [ ] **Step 2: 跑测试确认失败**——Run: `npm run test -- tests/ai/backup/backup-ipc.test.ts`，Expected: 新用例 FAIL
- [ ] **Step 3: 实现**：ConnectionConfig 加字段（注释注明「备份专用 token：申领所得 clientToken；缺省回落 token=现状单用户」）；ipc.ts `clientFor` 改 `const token = conn.backupToken ?? conn.token`
- [ ] **Step 4: 跑测试确认通过 + tests/ai/backup/ 全量**——Expected: PASS
- [ ] **Step 5: Commit**——`git add electron/domains/server/connections.ts electron/domains/backup/ipc.ts tests/ai/backup/backup-ipc.test.ts && git commit -m "feat(backup): ConnectionConfig.backupToken——备份身份独立凭据，ipc 优先取用"`

---

### Task 7: claim 通道 + BackupGroup 申领/管理 UI + i18n

**Files:**
- Modify: `electron/domains/backup/ipc.ts`（`backup:claim` handler + `deps.saveConnection`）
- Modify: `electron/commons/ipc-channels.ts`（invoke 清单加 `backup:claim`）
- Modify: `electron/Application.ts`（装配 saveConnection——server 域连接保存 API 注入；执行者以 connections.ts 实际保存通道定位）
- Modify: `electron/domains/backup/backup-client.ts`（加 `claim(inviteCode, deviceName)` 方法——POST `/backup/claim`，注意该调用**不带** backupToken、带大门 token：方法签名 `claim(inviteCode, deviceName, gatewayToken)` 或独立薄函数，计划取前者）
- Modify: `src-react/domains/app-settings/components/BackupGroup.tsx`（申领表单 + owner 徽标 + admin 邀请码/客户端管理小节）
- Modify: `src-react/domains/ai/server/` 连接编辑表单组件（加「备份专用 token（可选）」输入——以含 token 输入的连接表单现状定位；保存链透传 backupToken）
- Modify: `src-react/i18n/locales/zh-CN/settings.json`、`en-US/settings.json`（新 key 双语同构）
- Test: `tests/ai/backup/backup-ipc.test.ts`（claim 用例）

**Interfaces:**
- Consumes: Task 5 claim 端点；Task 6 backupToken；Task 1 `BackupListResult.viewer`（UI admin 面板显隐判定）
- Produces:
  - IPC `backup:claim(connId, inviteCode, deviceName) → {clientId}`——成功即把 clientToken 写回该连接 backupToken（经 deps.saveConnection）
  - `BackupClient.claim(inviteCode: string, deviceName: string): Promise<BackupClaimResult>`（内部以构造 opts 的 gatewayToken 发起——**BackupClient 构造加 `gatewayToken?: string`**：claim 用 gatewayToken ?? token，其余端点用 backupToken 语义 token——落地：构造 opts 加 `{gatewayToken}`，claim 方法发请求时 header 用 gatewayToken ?? this.opts.token）
  - `BackupIpcDeps` 加 `saveConnection?(connId: string, patch: { backupToken: string }): Promise<void>`

- [ ] **Step 1: 追加失败测试**（backup-ipc.test.ts）：

```ts
it("backup:claim：大门 token 调 claim → clientToken 写回连接 backupToken", async () => {
  const { deps, client } = makeDeps(DIRECT);
  client.claim = vi.fn(async () => ({ clientId: "new-imac", clientToken: "ct-123" }));
  registerBackupIpc(deps);
  const r = await call("backup:claim", "c1", "TS-ABCD2345", "new-imac");
  expect(r).toEqual({ clientId: "new-imac" });
  expect(client.claim).toHaveBeenCalledWith("TS-ABCD2345", "new-imac");
  expect(deps.saveConnection).toHaveBeenCalledWith("c1", { backupToken: "ct-123" });
});
it("backup:claim 失败（邀请码无效）透错且不写回", async () => {
  const { deps, client } = makeDeps(DIRECT);
  client.claim = vi.fn(async () => { throw new Error("业务错 code=BACKUP_INVITE_INVALID 邀请码无效或已被使用"); });
  await expect(call("backup:claim", "c1", "TS-BADCODE0", "x")).rejects.toThrow(/BACKUP_INVITE_INVALID|邀请码无效/);
  expect(deps.saveConnection).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**——Expected: FAIL
- [ ] **Step 3: 实现**：
  - backup-client.ts：opts 加 `gatewayToken?`；`claim` 方法（POST `/backup/claim`，authorization 用 gatewayToken ?? token——**不**用 backupToken，因申领时还没有客户端身份）
  - ipc.ts：deps 加 `saveConnection?`（默认抛「未装配」）；`backup:claim` handler——clientFor 拿连接（direct 校验同现状）→ 以 conn.token 为 gatewayToken 调 claim → `saveConnection(connId, {backupToken: clientToken})` → 返回 `{clientId}`
  - ipc-channels.ts invoke 清单加 `backup:claim`；Application.ts 装配 saveConnection（server 域连接更新 API——update/save 形态以 connections.ts 实际导出为准，只 patch backupToken 不动其余字段）
  - BackupGroup：①申领小节（未配 backupToken 的连接显示：邀请码+设备名输入 → invoke backup:claim → 成功 toast「已自动填入备份 token」+ 刷新连接）；②列表行 owner 徽标（`meta.owner`，admin 视角 viewer.kind==='admin' 时显示，区分 `__admin__` 显示「管理员」）；③admin 小节（viewer.kind==='admin'）：邀请码生成（数量+备注）列表（复制/撤销）+ 客户端列表（踢除）——数据经新增 IPC 透传？**管理端点复用 BackupClient**：list 面已有；invites/clients 调用在 BackupClient 加三个薄方法（`createInvites/listInvites/removeInvite/listClients/removeClient`——直透 HTTP）+ IPC 通道 `backup:invites:list` 等。为控批量：IPC 加 `backup:admin`（action, payload）单通道多 action 或逐通道——**裁定逐通道五条**（`backup:invites:create|list|delete`、`backup:clients:list|delete`），与既有通道风格一致
  - 连接编辑表单：backupToken 可选输入（i18n key `server:backupTokenField` 等——以连接表单 i18n namespace 现状为准）；保存链透传
  - i18n：BackupGroup 新 key（申领表单/徽标/管理面板/结果 toast/错误文案）zh+en 同构
- [ ] **Step 4: 跑测试确认通过 + tests/ai/backup/ 全量 + typecheck**——Expected: PASS
- [ ] **Step 5: Commit**——`git add electron/domains/backup/ electron/domains/server/connections.ts electron/commons/ipc-channels.ts electron/Application.ts src-react/domains/app-settings/components/BackupGroup.tsx src-react/domains/ai/server/ src-react/i18n/locales/ && git commit -m "feat(backup): 邀请码申领闭环——claim 通道自动回填+管理面板+owner 徽标+i18n"`

---

### Task 8: 收尾——sync:core、README、全量验收

**Files:**
- Modify: `apps/tianshu-server/README.md`（备份段补多用户说明）
- 无新代码

- [ ] **Step 1**: `npm run sync:core -w apps/tianshu-server` 重建协议包 dist（含 owner/claim 新类型）
- [ ] **Step 2**: 全量测试：server 全量 + `npm run test -- tests/ai/backup/` + `npm run typecheck` + 根仓 `npm run check:drift`
- [ ] **Step 3**: README 备份段补：多客户端流程（admin 生成邀请码 → 桌面端申领自动填 token）、隔离语义（互相不可见/防探测 NOT_FOUND/保留额分组）、`BACKUP_TOKEN`=admin 通道说明、claim 豁免鉴权说明
- [ ] **Step 4**: 真机验收清单（用户手测，不自行起服务）：admin 生成邀请码 → 桌面端 A 申领备份 → 桌面端 B 申领备份 → A/B list 互不可见 → A 恢复 B 的档 id（从 server 文件系统拿到）得 NOT_FOUND → 各备份 11 档验证互不挤占 → admin 连接全局可见+踢除 B 后 B 失效
- [ ] **Step 5**: Commit——`git add apps/tianshu-server/README.md && git commit -m "docs(server): README 补备份多用户——邀请码申领与 owner 隔离"`

---

## Self-Review 记录

- **Spec 覆盖**：§1 双身份+claim 豁免（T3）、§2 邀请码全链（T2/T5/T7）、§3 隔离表+trim 分组+旧档兜底+契约（T1/T4）、§4 桌面端 backupToken+申领回填+徽标+管理面板+i18n（T6/T7）、§5 测试矩阵逐条落各任务 Step 1、§5 worktree 执行（Global Constraints）、§6 非目标未越界、§7 风险四条各有对应（原子核销 T2 serialized、saveConnection 注入回调 T7、读取期兜底 T4、admin 双源判定顺序 T3）。
- **类型一致性**：`BackupIdentity {kind, clientId?}` T3 定义 T4/T5 消费；`StoredBackupClient` T2 定义 T3 消费；`saveConnection(connId, patch)` T7 内自洽；`BackupListResult.viewer` T1 定义 T4 产出 T7 消费；claim 双 token 语义（gatewayToken vs backupToken）T7 内注明。
- **已知留白（执行者现场对齐，非设计缺口）**：连接编辑表单组件文件与 i18n namespace（T7 注记）、saveConnection 对 connections.ts 实际保存 API 名（T7 注记）、BackupGroup 管理面板完整 JSX（样板指向+i18n key 集由实现者按 StorageGroup/既有小节形态落）、T4 旧档兜底用例的具体手工落盘工具形态。
