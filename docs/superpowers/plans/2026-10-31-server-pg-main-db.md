# server 主库双引擎（SQLite ⇄ PostgreSQL）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `TIANSHU_DB_URL` 指向 `postgres://` 时 server 主库整体运行在 PostgreSQL 上（派生 schema 单源真相 + Proxy 门面双 client + 检索跟随），默认 SQLite 行为零变化。

**Architecture:** 派生脚本从主 schema 生成 PG 变体（仅换 datasource 头 + 注入独立 output）；PrismaService 保持 `extends PrismaClient` 类型面但构造器返回 Proxy 转发到按 scheme 选择的内部 client（SQLite 现状 / PG 生成物）；首启建库按 engine 选 schema（PG 经 spawn env 注入 DATABASE_URL 绕开 configuration 覆写）；检索层空 SEARCH_DB_URL 时跟随主库 scheme。

**Tech Stack:** Prisma 双 provider（prisma-client-js 双 output）、Node Proxy、jest（mock 双 client）、docker compose profile。

**Spec:** `docs/superpowers/specs/2026-10-31-server-pg-main-db-design.md`（执行者须同时读）

## Global Constraints

- **SQLite 默认零行为变化**：不设/`file:` 的 `TIANSHU_DB_URL` 走现状路径逐字节等价（jest 75 suites 基线不动是硬验收）。
- **派生单源**：`schema.prisma.postgresql` 只能由 `prisma:pg:derive` 产出（表体逐字节 = 主 schema；锚点未命中即抛错——对齐 `rewriteSchemaUrlEnv` 的 no-op 防线惯例）。
- **类型策略**：业务代码零改动——PrismaService 的 TS 类型面保持 `extends PrismaClient`（SQLite 端），运行时 Proxy 双态。
- **命名/风格**：server 单引号、trailingComma=all、中文意图注释、kebab-case 文件名。
- **回归基线**：server jest 75 suites / mirror vitest / typecheck 恰 5 条预存 / drift 双对不增长（本批不动 mirror 双份文件）。
- **dist/gitignore**：`src/generated/prisma-pg` git-ignored（`.gitignore` 登记）；生成产物不入 commit。
- **仅新部署**：无 SQLite→PG 迁移脚本（已裁定）；PG 模式 README 注明全新初始化。

---

### Task 1: 派生脚本 + 双 generate scripts + 单测

**Files:**
- Create: `apps/tianshu-server/prisma/derive-pg.mjs`
- Modify: `apps/tianshu-server/package.json`（scripts + `prisma:pg:derive`/`prisma:generate:pg`）
- Modify: `apps/tianshu-server/.gitignore`（`src/generated/`）
- Test: `apps/tianshu-server/test/core/derive-pg.spec.ts`（jest）

**Interfaces:**
- Produces: `npm run prisma:pg:derive`（产出 `prisma/schema.prisma.postgresql`：provider postgresql、`url = env("DATABASE_URL")`、generator 注入 `output = "../src/generated/prisma-pg"`，表体逐字节不变）；`npm run prisma:generate:pg`。Task 3/5/6 依赖。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/tianshu-server/test/core/derive-pg.spec.ts
/**
 * PG schema 派生：datasource 头替换（provider/url env 化）、generator
 * output 注入、表体逐字节不变、锚点失效防线、幂等重跑。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverRoot = join(__dirname, '..', '..');
const mainSchema = readFileSync(join(serverRoot, 'prisma/schema.prisma'), 'utf8');

function derive(): string {
  execFileSync('node', ['prisma/derive-pg.mjs'], { cwd: serverRoot });
  return readFileSync(join(serverRoot, 'prisma/schema.prisma.postgresql'), 'utf8');
}

describe('prisma:pg:derive 派生', () => {
  it('datasource 头替换：provider postgresql + url env(DATABASE_URL)', () => {
    const pg = derive();
    expect(pg).toContain('provider = "postgresql"');
    expect(pg).toContain('url = env("DATABASE_URL")');
    expect(pg).not.toContain('provider = "sqlite"');
    expect(pg).not.toContain('file:./local.db');
  });
  it('generator 注入独立 output（prisma-pg 目录）', () => {
    expect(derive()).toContain('output   = "../src/generated/prisma-pg"');
  });
  it('表体逐字节不变（datasource/generator 头之外与主 schema 全等）', () => {
    const pg = derive();
    const body = (s: string) => s.slice(s.indexOf('enum '));
    expect(body(pg)).toBe(body(mainSchema));
  });
  it('幂等：重跑输出全等', () => {
    expect(derive()).toBe(derive());
  });
});
```

- [ ] **Step 2: 验证失败**

Run: `cd apps/tianshu-server && npx jest test/core/derive-pg.spec.ts`
Expected: FAIL（脚本不存在）。

- [ ] **Step 3: 实现脚本**

```javascript
// apps/tianshu-server/prisma/derive-pg.mjs
/**
 * PG schema 派生（主库双引擎 spec 2026-10-31）：主 schema 单源真相，
 * 仅替换 datasource 头（provider postgresql / url env 化）并注入独立
 * generator output——表体逐字节不变，双 schema 漂移归零。锚点未命中即
 * 抛错（对齐 db-url rewriteSchemaUrlEnv 的 no-op 防线惯例）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'schema.prisma'), 'utf8');

let derived = source.replace(
  /(datasource\s+db\s*\{[\s\S]*?\})/,
  (block) =>
    block
      .replace('provider = "sqlite"', 'provider = "postgresql"')
      .replace(/url\s*=\s*"file:\.\/local\.db"/, 'url = env("DATABASE_URL")'),
);
if (derived === source || !derived.includes('provider = "postgresql"')) {
  throw new Error(
    'datasource 改写未命中（provider/url 锚点漂移）——拒绝静默产出错误变体，请同步 derive-pg.mjs',
  );
}
derived = derived.replace(
  /(generator client \{\r?\n\s*provider = "prisma-client-js"\r?\n)/,
  '$1  output   = "../src/generated/prisma-pg"\n',
);
if (!derived.includes('../src/generated/prisma-pg')) {
  throw new Error('generator output 注入未命中——prisma-client-js 锚点漂移，请同步 derive-pg.mjs');
}
writeFileSync(join(here, 'schema.prisma.postgresql'), derived);
console.log('derived: prisma/schema.prisma.postgresql（表体逐字节同主 schema）');
```

package.json scripts 加：

```json
"prisma:pg:derive": "node prisma/derive-pg.mjs",
"prisma:generate:pg": "npm run prisma:pg:derive && prisma generate --schema prisma/schema.prisma.postgresql",
```

`.gitignore` 加 `src/generated/`（无则建）。

- [ ] **Step 4: 验证通过 + 真跑 generate**

Run: `cd apps/tianshu-server && npx jest test/core/derive-pg.spec.ts && npm run prisma:generate:pg 2>&1 | tail -2`
Expected: 测试绿；generate 成功产出 `src/generated/prisma-pg/`（含 index.js，`node -e "console.log(typeof require('./src/generated/prisma-pg').PrismaClient)"` 打 function）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/prisma/derive-pg.mjs apps/tianshu-server/prisma/schema.prisma.postgresql apps/tianshu-server/package.json apps/tianshu-server/.gitignore apps/tianshu-server/test/core/derive-pg.spec.ts
git commit -m "feat(server): PG schema 派生脚本——datasource 头替换/独立 output/单源真相（表体逐字节钉死）"
```

---

### Task 2: db-url 引擎判定 + ensureDatabase PG 分支

**Files:**
- Modify: `apps/tianshu-server/src/commons/database/db-url.ts`
- Test: `apps/tianshu-server/test/core/db-url-engine.spec.ts`（新建）

**Interfaces:**
- Produces（Task 3/6 依赖）:
  - `type DbEngine = 'sqlite' | 'postgres'`
  - `engineOf(url: string | undefined): DbEngine`——未设/`file:`/裸路径 → 'sqlite'；`postgres://`/`postgresql://` → 'postgres'；其他 scheme 抛人话错
  - `dbUrlOptions()` 行为扩展：postgres url **不**过 `normalizeDbUrl`（原样透传——现有逻辑会错补 `file:` 前缀）
  - `ensureDatabase()` 行为扩展：engine postgres → `ensureDatabasePg()`（spawn `prisma db push --schema prisma/schema.prisma.postgresql --skip-generate`，env 显式注入 `DATABASE_URL` 绕开 configuration.ts 覆写；幂等每启动跑，无变更秒级）+ PG 侧目录确保跳过（SQLite 专属）

- [ ] **Step 1: 写失败测试**

```typescript
// apps/tianshu-server/test/core/db-url-engine.spec.ts
/**
 * 引擎判定（scheme 分发/非法 scheme 人话报错）与 dbUrlOptions 的
 * postgres 透传（不补 file: 前缀）。
 */
import { engineOf, dbUrlOptions } from '../../src/commons/database/db-url';

describe('engineOf', () => {
  it('未设/file:/裸路径 → sqlite；postgres 系 → postgres', () => {
    expect(engineOf(undefined)).toBe('sqlite');
    expect(engineOf('file:/tmp/x.db')).toBe('sqlite');
    expect(engineOf('/tmp/x.db')).toBe('sqlite');
    expect(engineOf('postgres://u:p@h:5432/d')).toBe('postgres');
    expect(engineOf('postgresql://u:p@h/d')).toBe('postgres');
  });
  it('其他 scheme 抛人话错', () => {
    expect(() => engineOf('mysql://h/d')).toThrow(/TIANSHU_DB_URL/);
  });
});

describe('dbUrlOptions postgres 透传', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  afterEach(() => { process.env.TIANSHU_DB_URL = OLD; });

  it('postgres url 原样透传（不补 file: 前缀）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    expect(dbUrlOptions()).toEqual({ datasources: { db: { url: 'postgres://u:p@h:5432/d' } } });
  });
  it('file url 维持 normalize 现状', () => {
    process.env.TIANSHU_DB_URL = '/tmp/x.db';
    expect(dbUrlOptions()?.datasources.db.url).toBe('file:/tmp/x.db');
  });
});
```

- [ ] **Step 2: 验证失败**

Run: `cd apps/tianshu-server && npx jest test/core/db-url-engine.spec.ts`
Expected: FAIL（engineOf 未导出；postgres url 被 normalize 破坏）。

- [ ] **Step 3: 实现**

`db-url.ts` 加（`normalizeDbUrl` 后）：

```typescript
/** 主库引擎（双引擎 spec）：未设/file:/裸路径 → sqlite；postgres 系 →
 * postgres；其他 scheme 显式抛错（防静默建错库） */
export type DbEngine = 'sqlite' | 'postgres';

export function engineOf(url: string | undefined): DbEngine {
  if (!url) {
    return 'sqlite';
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    return 'postgres';
  }
  if (url.startsWith('file:') || !url.includes('://')) {
    return 'sqlite';
  }
  throw new Error(
    `TIANSHU_DB_URL 不支持的 scheme（仅 file: 路径或 postgres:// 连接串）: ${url}`,
  );
}
```

`dbUrlOptions` 改（postgres 不 normalize）：

```typescript
export function dbUrlOptions():
  { datasources: { db: { url: string } } } | undefined {
  const url = overriddenDbUrl();
  if (!url) {
    return undefined;
  }
  // postgres 连接串原样透传（normalizeDbUrl 会错补 file: 前缀）
  const normalized = engineOf(url) === 'postgres' ? url : normalizeDbUrl(url);
  return { datasources: { db: { url: normalized } } };
}
```

`ensureDatabase()` 入口加分派 + PG 分支（spawn prisma 的形态照文件内现有 spawnSync 先例；env 显式注入）：

```typescript
// ensureDatabase 入口（原函数体前）：
export function ensureDatabase(): void {
  if (engineOf(overriddenDbUrl()) === 'postgres') {
    ensureDatabasePg();
    return;
  }
  // …原 SQLite 逻辑不动…

/** PG 首启建库：派生 schema db push（幂等，无变更秒级）。DATABASE_URL
 * 经 spawn env 显式注入——绕开 configuration.ts 对 process.env.DATABASE_URL
 * 的无条件覆写（见文件头注释）。 */
function ensureDatabasePg(): void {
  const url = overriddenDbUrl()!;
  const schemaPath = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma.postgresql');
  spawnSync(
    'npx',
    ['prisma', 'db', 'push', '--schema', schemaPath, '--skip-generate'],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}
```

（schemaPath 的相对层数按 dist 运行时布局核对——参照文件内现有 SQLite db push 的 schema 定位方式对齐；若现有逻辑已有 schema 路径解析函数则复用。）

- [ ] **Step 4: 验证 + 既有回归**

Run: `cd apps/tianshu-server && npx jest test/core/db-url-engine.spec.ts && npx jest`（全量）
Expected: 新用例绿 + 75 suites 基线全绿（不设 env 走现状路径）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/commons/database/db-url.ts apps/tianshu-server/test/core/db-url-engine.spec.ts
git commit -m "feat(server): db-url 引擎判定——engineOf 分发/postgres 透传/PG 首启建库分支"
```

---

### Task 3: PrismaService Proxy 门面双 client

**Files:**
- Modify: `apps/tianshu-server/src/commons/database/prisma.service.ts`
- Test: `apps/tianshu-server/test/core/prisma-service-engine.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `src/generated/prisma-pg`（require '../generated/prisma-pg'——从 service 文件相对路径 `../../generated/prisma-pg`）；Task 2 的 `engineOf`。
- Produces: PrismaService 构造器返回 Proxy——内部 client 按 scheme 二选一；TS 类型面保持 `extends PrismaClient`（业务代码零改动）；`@Optional() options` 注入语义保留（options 内 url 优先于 env 判 engine）。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/tianshu-server/test/core/prisma-service-engine.spec.ts
/**
 * Proxy 门面双 client：scheme 分支装载、属性转发、非法 scheme 报错、
 * options 注入（测试临时库通道）语义保留。
 */
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(function (this: any, options?: unknown) {
    return { __engine: 'sqlite', options, $connect: jest.fn(), $disconnect: jest.fn() };
  }),
}));
jest.mock('../../generated/prisma-pg', () => ({
  PrismaClient: jest.fn(function (this: any, options?: unknown) {
    return { __engine: 'postgres', options, $connect: jest.fn(), $disconnect: jest.fn() };
  }),
}), { virtual: true });

import { PrismaService } from '../../src/commons/database/prisma.service';

describe('PrismaService 双引擎门面', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  afterEach(() => { process.env.TIANSHU_DB_URL = OLD; });

  it('未设 env → SQLite client（现状）', () => {
    delete process.env.TIANSHU_DB_URL;
    const svc = new PrismaService() as any;
    expect(svc.__engine).toBe('sqlite');
  });
  it('postgres env → PG client，属性转发（model 代理/raw 事务同面）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    const svc = new PrismaService() as any;
    expect(svc.__engine).toBe('postgres');
  });
  it('非法 scheme → 人话报错', () => {
    process.env.TIANSHU_DB_URL = 'mysql://h/d';
    expect(() => new PrismaService()).toThrow(/TIANSHU_DB_URL/);
  });
  it('options 注入优先于 env（测试临时库通道保留）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    const svc = new PrismaService({ datasources: { db: { url: 'file:/tmp/test.db' } } } as any) as any;
    expect(svc.__engine).toBe('sqlite');
  });
});
```

- [ ] **Step 2: 验证失败**

Run: `cd apps/tianshu-server && npx jest test/core/prisma-service-engine.spec.ts`
Expected: FAIL（现状恒 SQLite client）。

- [ ] **Step 3: 实现（Proxy 门面，类型面不变）**

```typescript
// apps/tianshu-server/src/commons/database/prisma.service.ts
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  dbUrlOptions,
  engineOf,
  ensureDatabase,
  overriddenDbUrl,
} from './db-url';
import { ensureGraphRunNodeTable } from './ensure-graph-run-node-table';

type PrismaClientOptions = ConstructorParameters<typeof PrismaClient>[0];
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** 按 engine 装载 client 类：postgres → 派生 PG 生成物（prisma:generate:pg
 * 产出，CJS 同步 require；TS 类型面统一用 SQLite 端——同构 schema 结构兼容，
 * 业务代码零改动）。 */
function loadClientClass(engine: 'sqlite' | 'postgres'): new (options?: PrismaClientOptions) => AnyClient {
  if (engine === 'postgres') {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const pg = require('../../generated/prisma-pg');
    return pg.PrismaClient;
  }
  return PrismaClient as new (options?: PrismaClientOptions) => AnyClient;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly engineClient: AnyClient;
  // options 供测试注入临时库（datasources url 优先判 engine）；DI 无参构造
  // → env（TIANSHU_DB_URL）判定。类型面保持 extends PrismaClient（SQLite
  // 端）；运行时构造器返回 Proxy 转发到按 scheme 装载的内部 client——
  // super() 的 SQLite 实例在 PG 态仅作类型占位（未连接、无 IO）。
  constructor(@Optional() options?: PrismaClientOptions) {
    super(options ?? dbUrlOptions());
    const url = (options as any)?.datasources?.db?.url ?? overriddenDbUrl();
    const ClientClass = loadClientClass(engineOf(url));
    this.engineClient = new ClientClass(options ?? dbUrlOptions());
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'symbol' || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        const value = target.engineClient[prop];
        return typeof value === 'function' ? value.bind(target.engineClient) : value;
      },
    });
  }

  async onModuleInit() {
    ensureDatabase();
    await this.engineClient.$connect();
    await ensureGraphRunNodeTable(this as unknown as Parameters<typeof ensureGraphRunNodeTable>[0]);
  }

  async onModuleDestroy() {
    await this.engineClient.$disconnect();
  }
}
```

> 落地注意：`prop in target` 判定——`onModuleInit` 等自身成员走 target；model 代理（`user` 等）与 `$transaction` 转发 `engineClient`。`ensureGraphRunNodeTable` 参数类型如需适配按其现签名最小调整（它消费的是 PrismaService 的 Prisma 面——经 Proxy 的 `this` 已具备）。全量 jest 必须绿（既有 spec 大量实例化 PrismaService）。

- [ ] **Step 4: 验证 + 全量回归**

Run: `cd apps/tianshu-server && npx jest test/core/prisma-service-engine.spec.ts && npx jest && cd .. && cd .. && npm run typecheck`
Expected: 新用例绿；75 suites 全绿；typecheck 恰 5 条预存。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/commons/database/prisma.service.ts apps/tianshu-server/test/core/prisma-service-engine.spec.ts
git commit -m "feat(server): PrismaService Proxy 门面——双 client 按 scheme 装载/类型面零改动"
```

---

### Task 4: 检索层跟随主库

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/search-pg.ts`（`searchDbTarget` 加跟随规则）
- Test: `apps/tianshu-server/test/core/graph-search-pg.spec.ts`（追加用例）

**Interfaces:**
- Consumes: 无新接口（读 `process.env.TIANSHU_DB_URL`）。
- Produces: SEARCH_DB_URL 空且主库 postgres → `searchDbTarget()` 返回主库 URL（检索表 search-pg 幂等 DDL 在主库建 `vector_chunk`，与主库 Prisma `vectorChunk` 表并存）。

- [ ] **Step 1: 写失败测试（追加）**

```typescript
describe('searchDbTarget 跟随主库（双引擎 spec §4）', () => {
  const OLD_SEARCH = process.env.SEARCH_DB_URL;
  const OLD_MAIN = process.env.TIANSHU_DB_URL;
  afterEach(() => {
    process.env.SEARCH_DB_URL = OLD_SEARCH;
    process.env.TIANSHU_DB_URL = OLD_MAIN;
  });

  it('SEARCH_DB_URL 空且主库 postgres → 返回主库 URL', async () => {
    delete process.env.SEARCH_DB_URL;
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/main';
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    expect(searchDbTarget()).toBe('postgres://u:p@h:5432/main');
  });
  it('主库 sqlite → 维持 null（本地检索现状）', async () => {
    delete process.env.SEARCH_DB_URL;
    process.env.TIANSHU_DB_URL = 'file:/tmp/x.db';
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    expect(searchDbTarget()).toBeNull();
  });
  it('SEARCH_DB_URL 显式设置仍优先', async () => {
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/search';
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/main';
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    expect(searchDbTarget()).toBe('postgres://u:p@h:5432/search');
  });
});
```

- [ ] **Step 2: 验证失败 → Step 3: 实现**

`searchDbTarget()` 的空值分支改：

```typescript
  if (url === '') {
    // 跟随主库（双引擎 spec §4）：主库 postgres 时检索默认指向主库
    // （检索表 search-pg 幂等 DDL 自建 vector_chunk，与主库 Prisma
    // vectorChunk 表不同名并存——检索单真源原则延续）；主库 sqlite
    // 维持本地检索（null）。
    const mainUrl = process.env.TIANSHU_DB_URL ?? '';
    return POSTGRES_SCHEME.test(mainUrl) ? mainUrl : null;
  }
```

- [ ] **Step 4: 验证 + 回归**

Run: `cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts && npx jest`
Expected: 全绿（既有路由用例不设 TIANSHU_DB_URL 不受影响——若个别用例 env 残留需在该 describe 内显式清理）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/core/graph/search-pg.ts apps/tianshu-server/test/core/graph-search-pg.spec.ts
git commit -m "feat(graph): 检索层跟随主库——SEARCH_DB_URL 空且主库 postgres 时默认同库"
```

---

### Task 5: 部署面（Dockerfile/compose/README）

**Files:**
- Modify: `apps/tianshu-server/Dockerfile`（builder 双 generate 两行 + bundle 验证）
- Modify: `apps/tianshu-server/docker-compose.yml`（main-pg profile）
- Modify: `apps/tianshu-server/README.md`（双模式部署段）

- [ ] **Step 1: Dockerfile builder 双 generate**

`prisma generate` 行（`RUN cd apps/tianshu-server && npx prisma generate`）扩为：

```dockerfile
RUN cd apps/tianshu-server && npx prisma generate \
 && npm run prisma:pg:derive && npx prisma generate --schema prisma/schema.prisma.postgresql
```

**产物随行验证**：nest build 后 `src/generated/prisma-pg` 是否进 dist——`dist/generated/prisma-pg` 存在则 ✓；若 tsc 未纳入（tsconfig include 范围外），在 bundle 组装时显式拷贝：组装 RUN 加 `&& cp -r apps/tianshu-server/src/generated /bundle/generated`（runner 的 `dist/src/main.js` require 相对路径按 dist 布局核对——以镜像内 `node dist/src/main.js` + TIANSHU_DB_URL=postgres 实测为准，T6 覆盖）。bundle 的 prisma 目录已含派生版（derive 先于组装 cp）。

- [ ] **Step 2: compose main-pg profile**

```yaml
  main-pg:
    profiles: ["main-pg"]
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: tianshu
      POSTGRES_PASSWORD: tianshu_main
      POSTGRES_DB: tianshu_main
    volumes:
      - main-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tianshu -d tianshu_main"]
      interval: 5s
      timeout: 3s
      retries: 10
```

volumes 加 `main-pg-data: {}`；server 服务 `TIANSHU_DB_URL` 改 env 化默认：`TIANSHU_DB_URL: ${TIANSHU_DB_URL:-file:/app/data/local.db}`（注释：main-pg 模式 export 为 `postgres://tianshu:tianshu_main@main-pg:5432/tianshu_main`）。

- [ ] **Step 3: README 双模式段**

Docker 部署节追加（中文，同风格）：

```markdown
### 主库 PostgreSQL 模式（可选 profile）

`docker compose --profile main-pg up -d` 前先
`export TIANSHU_DB_URL=postgres://tianshu:tianshu_main@main-pg:5432/tianshu_main`——
server 主库整体切 PG（23 张业务表，首启自动 db push 建表），检索层自动跟随
（同库建检索表）。**PG 模式为全新初始化**（SQLite 存量数据不迁移）；默认不设
该 env 时为 SQLite 主库（零变化）。
```

- [ ] **Step 4: 验证 + Commit**

Run: `TIANSHU_TOKEN=x docker compose -f apps/tianshu-server/docker-compose.yml config -q && TIANSHU_TOKEN=x docker compose -f apps/tianshu-server/docker-compose.yml --profile main-pg config > /dev/null && echo VALID`
Expected: 两种形态均 VALID。

```bash
git add apps/tianshu-server/Dockerfile apps/tianshu-server/docker-compose.yml apps/tianshu-server/README.md
git commit -m "feat(server): 主库 PG 部署面——Dockerfile 双 generate/main-pg profile/README 双模式"
```

---

### Task 6: e2e 可选段 + 全量回归收尾

**Files:**
- Create: `tests/ai/server/e2e-main-pg.ts`（mirror 仓 e2e 目录）
- Modify: 根 `package.json`（script `test:e2e:mainPg`）

**Interfaces:**
- Consumes: Task 1-5 全部。env `MAIN_PG_E2E_URL` 门控（未设 SKIP exit 0——对齐既有门控模式）。
- Produces: 真 PG 主库全链路实证。

- [ ] **Step 1: 写 e2e（骨架+断言，先例对齐）**

先读 `tests/ai/server/e2e-graph-search-pg.ts` 的 spawn/env 注入/清理手法，写 `e2e-main-pg.ts`：

```typescript
// tests/ai/server/e2e-main-pg.ts
/**
 * 主库 PG e2e（可选，门控 MAIN_PG_E2E_URL）：派生 schema db push 建库 →
 * server 以 TIANSHU_DB_URL=postgres 启动（PG 主库模式）→ 健康探测 →
 * graph save/run 走 PG 主库 + hybridSearch keyword 同库检索命中（跟随规则
 * §4 实证）→ 清理（容器/临时资源）。SQLite 路径由既有 e2e/Jest 覆盖。
 */
const PG_URL = process.env.MAIN_PG_E2E_URL;
if (!PG_URL) {
  console.log('SKIP: MAIN_PG_E2E_URL 未配置（docker compose --profile main-pg 起库后设置）');
  process.exit(0);
}
// 1. 派生 schema + db push（node spawn：cd apps/tianshu-server && npm run prisma:generate:pg
//    不需要——e2e 用既有生成物；db push 直接 spawn prisma --schema 派生版，env 注入 DATABASE_URL）
// 2. spawn server 子进程：env 注入 TIANSHU_DB_URL=PG_URL + TIANSHU_TOKEN=测试值 + JWT_SECRET
//    （spawn 手法照 e2e-graph-search-pg；server 端口动态）
// 3. 健康：/actuator/health → {"status":"ok"
// 4. 主库实证：graph save 一张图 → 查询存在（PG 里 23 表已建：直接断言 server API 行为）
// 5. 检索跟随：直插 vector_chunk 检索表（PG_URL 同库，to_tsvector 手法照 e2e-graph-search-pg）
//    → hybridSearch keyword 节点 run → 断言命中「容错设计手册｜相关度」+「旅行日记」剔除
// 6. finally：child kill + 检索表 DROP（主库业务表留给 PG 卷/由外部清理）
```

（断言与工具复用 e2e-graph-search-pg 的直插/节点 JSON 手法；spawn 段照抄其 env 注入形态。）

根 package.json scripts：`"test:e2e:mainPg": "node tests/ai/server/e2e-main-pg.ts"`。

- [ ] **Step 2: 跑 e2e（SKIP + live）**

无 PG：`npm run test:e2e:mainPg` → SKIP exit 0。
有 PG（compose 起 main-pg + 端口映射临时放开，或既有 search-pg 库复用）：`MAIN_PG_E2E_URL=postgres://… TIANSHU_TOKEN=… npm run test:e2e:mainPg` → 全链路断言过。无 docker 环境则 live 段标注交付（由用户择机跑），SKIP 路径必须实测。

- [ ] **Step 3: 全量回归**

Run: 根 `npm run test`（mirror 全量）+ `cd apps/tianshu-server && npx jest`（全量）+ `npm run typecheck`（恰 5）+ `npm run check:drift`（双对不增长）
Expected: 全部达标。

- [ ] **Step 4: 终验三项**

① 派生单源：schema.prisma.postgresql 由脚本产出且表体逐字节钉死（T1 用例）；② SQLite 零变化：不设 env 全量基线绿 + e2e-graph-smoke 现状路径不受影响；③ 跟随规则：T4 用例 + e2e 第 5 段双证。

- [ ] **Step 5: Commit**

```bash
git add tests/ai/server/e2e-main-pg.ts package.json
git commit -m "test(server): 主库 PG e2e——db push/健康/同库检索跟随实证（门控 SKIP）"
```
