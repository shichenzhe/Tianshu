# 技能管理 P-A 实施计划(skillRecord + 我安装的 + 批量管理)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立技能管理地基——`skillRecord` 状态表(v6 迁移)、目录↔DB 自愈对账、禁用即时生效、"我安装的"管理页(开关 + 批量管理)。

**Architecture:** 目录为文件事实源、DB 为状态事实源;`SkillRepository`(IPC)持有对账与启停/卸载;`chat.service` 组装时按 DB 过滤禁用技能;技能 Tab 重构为管理页。方案细节与决策见 spec。

**Tech Stack:** Electron 44 + Prisma 7(better-sqlite3)+ React 19 + React Query + Tailwind 4 + react-i18next + Vitest(node 环境)。

**Spec:** `docs/superpowers/specs/2026-09-05-skill-manager-pa-design.md`(含对 spec §3 的补充:`skillRecord` 增加 `description` 列,供卡片渲染与搜索)

## Global Constraints

- 命名:变量/函数 camelCase,类 PascalCase,文件 kebab-case;CSS 用主题变量(`border-border/50`、`text-muted-foreground`、`bg-primary-subtle`),禁止硬编码颜色
- i18n:用户可见文本一律 `t()`,zh-CN 与 en-US 的 `chat.json` 同时添加;禁止顶层 key 与嵌套对象重名
- Prettier:双引号、分号、tabWidth=2、printWidth=80、无尾随逗号
- 单测放 `tests/ai/*.test.ts`(vitest 纯 Node;import electron 的模块需 `vi.mock("electron", ...)`;`@/` 别名已在 vitest.config 配好)
- 每个任务结束:`npm run test`、`npm run lint`、`npm run typecheck` 全绿再 commit
- SQL 脚本沿用 `--/p`(注释说明)与 `--/ignore`(幂等忽略错误)标记惯例

---

### Task 1: skillRecord 模型 + v6 迁移

**Files:**
- Modify: `prisma/schema.prisma`(文件末尾追加模型)
- Create: `electron/infrastructure/script/v6/upgrade-table.sql`
- Modify: `electron/Constants.ts`(databaseVerson 5→6)
- Test: `tests/ai/v6-migration.test.ts`
- Modify: `docs/superpowers/specs/2026-09-05-skill-manager-pa-design.md`(§3 模型补 description 列)

**Interfaces:**
- Produces: Prisma 模型 `skillRecord`(后续任务经 `electron/generated/prisma` 使用 `prismaClient.skillRecord.*`)

- [ ] **Step 1: schema.prisma 追加模型**

在 `prisma/schema.prisma` 的 `toolPermission` 模型后追加:

```prisma
model skillRecord {
  id          Int      @id @default(autoincrement())
  name        String   @unique
  slug        String?
  version     String?
  source      String
  dir         String
  description String?
  enabled     Boolean  @default(true)
  installedAt DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 2: 写 v6 迁移测试(先红)**

参照 `tests/ai/v5-migration.test.ts` 的 `DatabaseSync` 模式,新建 `tests/ai/v6-migration.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V6_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v6/upgrade-table.sql",
  ),
  "utf8",
);

/** 去掉注释标记行后按分号拆分语句(模拟 sql-file-executor 的最小语义) */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("v6 迁移:skillRecord 表", () => {
  it("建表可插入且 name 唯一约束生效", () => {
    const db = new DatabaseSync(":memory:");
    for (const stmt of statements(V6_SQL)) {
      db.exec(stmt);
    }
    db.exec(
      "INSERT INTO skillRecord (name, source, dir) VALUES ('greeting', 'local', '/tmp/skills/greeting')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO skillRecord (name, source, dir) VALUES ('greeting', 'local', '/tmp/x')",
      ),
    ).toThrow();
    const row = db
      .prepare("SELECT name, enabled, description FROM skillRecord")
      .get() as { name: string; enabled: number; description: unknown };
    expect(row).toEqual({
      name: "greeting",
      enabled: 1,
      description: null,
    });
  });

  it("重复执行幂等(IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i += 1) {
      for (const stmt of statements(V6_SQL)) {
        db.exec(stmt);
      }
    }
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'skillRecord'")
        .get(),
    ).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run tests/ai/v6-migration.test.ts`
Expected: FAIL(ENOENT: v6/upgrade-table.sql 不存在)

- [ ] **Step 4: 写迁移 SQL**

新建 `electron/infrastructure/script/v6/upgrade-table.sql`:

```sql
--/p 新建技能安装记录表(P-A 技能管理:目录为文件源、DB 为状态源,自愈对账)
CREATE TABLE IF NOT EXISTS skillRecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NULL,
    version TEXT NULL,
    source TEXT NOT NULL,
    dir TEXT NOT NULL,
    description TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    installedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/ai/v6-migration.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 6: 版本号 5→6 并重新生成 Prisma Client**

`electron/Constants.ts` 中 `public readonly databaseVerson: number = 5;` 改为 `= 6;`(注意:该字段名沿用既有拼写 `databaseVerson`,不要"修正"它,Application.ts 依赖此名)。

Run: `npx prisma generate`(生成含 skillRecord 的 client 到 electron/generated/prisma)

- [ ] **Step 7: 全量验证**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: 全绿

- [ ] **Step 8: 回写 spec §3(补 description 列)**

`docs/superpowers/specs/2026-09-05-skill-manager-pa-design.md` §3 的 prisma 模型中 `dir` 行后插入一行:

```prisma
  description String?           // 一句话描述(对账时取自 frontmatter,卡片渲染/搜索用)
```

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma electron/infrastructure/script/v6/ electron/Constants.ts tests/ai/v6-migration.test.ts docs/superpowers/specs/2026-09-05-skill-manager-pa-design.md
git commit -m "feat(skill): skillRecord 模型与 v6 迁移"
```

---

### Task 2: 对账纯函数 syncSkillRecords(TDD)

**Files:**
- Create: `electron/domains/ai/skill/skill-sync.ts`
- Test: `tests/ai/skill-sync.test.ts`

**Interfaces:**
- Consumes: `SkillInfo`(`../agent/skill-loader` 导出:`{ name, description, dir, bodyPath, source: "user" | "workspace" }`)
- Produces:

```ts
export interface SkillRecordRow {
  id: number;
  name: string;
  source: string;
  dir: string;
  version: string | null;
}
export interface SkillInsert {
  name: string;
  source: string;
  dir: string;
  description: string;
}
export interface SkillUpdate {
  id: number;
  dir: string;
  description: string;
}
export interface SkillSyncPlan {
  toInsert: SkillInsert[]; // source 固定 "local"(P-A 手放;market 由 P-B 安装时写入)
  toDeleteIds: number[];
  toUpdate: SkillUpdate[]; // dir 或 description 变化时刷新,保留 enabled/installedAt/version/slug
}
export function syncSkillRecords(
  scanned: Array<{ name: string; description: string; dir: string }>,
  records: SkillRecordRow[],
): SkillSyncPlan;
export function filterDisabledSkills<T extends { name: string; source: string }>(
  skills: T[],
  disabled: Set<string>,
): T[]; // 仅过滤 source === "user" 的禁用项(workspace 级不受管理)
export function isInsideDir(target: string, root: string): boolean; // 卸载路径防越界(绝对路径前缀校验)
```

- [ ] **Step 1: 写失败测试**

新建 `tests/ai/skill-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  filterDisabledSkills,
  isInsideDir,
  syncSkillRecords,
} from "../../electron/domains/ai/skill/skill-sync";

describe("syncSkillRecords 目录↔DB 对账", () => {
  it("目录有、DB 无 → 新增(local 源)", () => {
    const plan = syncSkillRecords(
      [
        {
          name: "greeting",
          description: "打招呼",
          dir: "/ud/skills/greeting",
        },
      ],
      [],
    );
    expect(plan).toEqual({
      toInsert: [
        {
          name: "greeting",
          source: "local",
          dir: "/ud/skills/greeting",
          description: "打招呼",
        },
      ],
      toDeleteIds: [],
      toUpdate: [],
    });
  });

  it("DB 有、目录无 → 删除(孤儿清理)", () => {
    const plan = syncSkillRecords([], [
      {
        id: 7,
        name: "gone",
        source: "local",
        dir: "/ud/skills/gone",
        version: null,
        description: null,
      },
    ]);
    expect(plan.toDeleteIds).toEqual([7]);
    expect(plan.toInsert).toEqual([]);
  });

  it("双方都有且 dir/description 一致 → 无操作(保留 enabled 等状态)", () => {
    const plan = syncSkillRecords(
      [{ name: "a", description: "d", dir: "/ud/skills/a" }],
      [
        {
          id: 1,
          name: "a",
          source: "market",
          dir: "/ud/skills/a",
          version: "1.0.0",
          description: "d",
        },
      ],
    );
    expect(plan).toEqual({ toInsert: [], toDeleteIds: [], toUpdate: [] });
  });

  it("双方都有但 description 变化 → 刷新 dir/description,不动 version/source", () => {
    const plan = syncSkillRecords(
      [{ name: "a", description: "新描述", dir: "/ud/skills/a" }],
      [
        {
          id: 1,
          name: "a",
          source: "market",
          dir: "/ud/skills/a",
          version: "1.0.0",
          description: "旧描述",
        },
      ],
    );
    expect(plan.toUpdate).toEqual([
      { id: 1, dir: "/ud/skills/a", description: "新描述" },
    ]);
  });

  it("混合场景:各分支互不影响", () => {
    const plan = syncSkillRecords(
      [
        { name: "keep", description: "k", dir: "/ud/skills/keep" },
        { name: "new", description: "n", dir: "/ud/skills/new" },
        { name: "moved", description: "m", dir: "/ud/skills/moved2" },
      ],
      [
        {
          id: 1,
          name: "keep",
          source: "local",
          dir: "/ud/skills/keep",
          version: null,
          description: "k",
        },
        {
          id: 2,
          name: "orphan",
          source: "local",
          dir: "/ud/skills/orphan",
          version: null,
          description: "o",
        },
        {
          id: 3,
          name: "moved",
          source: "local",
          dir: "/ud/skills/moved1",
          version: null,
          description: "m",
        },
      ],
    );
    expect(plan.toInsert).toEqual([
      { name: "new", source: "local", dir: "/ud/skills/new", description: "n" },
    ]);
    expect(plan.toDeleteIds).toEqual([2]);
    expect(plan.toUpdate).toEqual([
      { id: 3, dir: "/ud/skills/moved2", description: "m" },
    ]);
  });
});

describe("filterDisabledSkills 禁用过滤", () => {
  const skills = [
    { name: "a", source: "user" },
    { name: "b", source: "user" },
    { name: "c", source: "workspace" },
  ];

  it("仅过滤 user 级禁用项", () => {
    expect(filterDisabledSkills(skills, new Set(["b"]))).toEqual([
      { name: "a", source: "user" },
      { name: "c", source: "workspace" },
    ]);
  });

  it("禁用的 workspace 同名技能不受影响;空禁用集原样返回", () => {
    expect(filterDisabledSkills(skills, new Set(["c"]))).toEqual(skills);
    expect(filterDisabledSkills(skills, new Set())).toEqual(skills);
  });
});

describe("isInsideDir 路径防越界", () => {
  it("子目录在根内", () => {
    expect(isInsideDir("/ud/skills/a", "/ud/skills")).toBe(true);
  });
  it("同前缀字符串但不在根内(../ 逃逸与兄弟目录)", () => {
    expect(isInsideDir("/ud/skills-evil/a", "/ud/skills")).toBe(false);
    expect(isInsideDir("/ud/skills/../etc", "/ud/skills")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/skill-sync.test.ts`
Expected: FAIL(Cannot find module .../skill-sync)

- [ ] **Step 3: 实现 skill-sync.ts**

新建 `electron/domains/ai/skill/skill-sync.ts`(纯函数,禁止 import electron/fs):

```ts
/**
 * 技能对账纯函数(P-A spec §4):目录为文件源、DB 为状态源。
 * key = frontmatter name(与 skill-loader 去重键一致);无 electron/fs 依赖,可直测
 */
import path from "node:path";

export interface SkillRecordRow {
  id: number;
  name: string;
  source: string;
  dir: string;
  version: string | null;
  description: string | null;
}

export interface SkillInsert {
  name: string;
  source: string;
  dir: string;
  description: string;
}

export interface SkillUpdate {
  id: number;
  dir: string;
  description: string;
}

export interface SkillSyncPlan {
  toInsert: SkillInsert[];
  toDeleteIds: number[];
  toUpdate: SkillUpdate[];
}

export function syncSkillRecords(
  scanned: Array<{ name: string; description: string; dir: string }>,
  records: SkillRecordRow[],
): SkillSyncPlan {
  const byName = new Map(records.map((row) => [row.name, row]));
  const seen = new Set<string>();
  const toInsert: SkillInsert[] = [];
  const toUpdate: SkillUpdate[] = [];
  for (const item of scanned) {
    seen.add(item.name);
    const row = byName.get(item.name);
    if (!row) {
      toInsert.push({
        name: item.name,
        source: "local",
        dir: item.dir,
        description: item.description,
      });
    } else if (
      row.dir !== item.dir ||
      row.description !== item.description
    ) {
      toUpdate.push({ id: row.id, dir: item.dir, description: item.description });
    }
  }
  const toDeleteIds = records
    .filter((row) => !seen.has(row.name))
    .map((row) => row.id);
  return { toInsert, toDeleteIds, toUpdate };
}
```

```ts
export function filterDisabledSkills<T extends { name: string; source: string }>(
  skills: T[],
  disabled: Set<string>,
): T[] {
  return skills.filter((s) => !(s.source === "user" && disabled.has(s.name)));
}

/** target 是否位于 root 目录内(path.resolve 归一后前缀校验,防 ../ 逃逸) */
export function isInsideDir(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ai/skill-sync.test.ts`
Expected: PASS(8 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/skill/skill-sync.ts tests/ai/skill-sync.test.ts
git commit -m "feat(skill): 目录↔DB 对账/禁用过滤/路径防越界纯函数"
```

---

### Task 3: skill.api 共享类型 + SkillRepository(IPC)

**Files:**
- Create: `src-react/domains/ai/skills/api/skill.api.ts`
- Create: `electron/domains/ai/skill/skill.repo.ts`
- Modify: `electron/Application.ts:107` 附近(ChatService 装配 + repo 实例化)

**Interfaces:**
- Consumes: Task 1 的 `prisma.skillRecord`;Task 2 的 `syncSkillRecords/SkillRecordRow`;`loadSkills`(skill-loader)
- Produces: `SkillApi`(渲染进程);`SkillRepository`,其中 `getDisabledNames(): Promise<Set<string>>`(Task 4 消费)、构造即注册 5 个 IPC 通道

- [ ] **Step 1: 前端 API 与共享类型**

新建 `src-react/domains/ai/skills/api/skill.api.ts`(invoke 用法对照 `src-react/domains/ai/api/mcp.api.ts`):

```ts
/**
 * 技能管理 API(IPC 封装)。类型由后端 SkillRepository 反向复用
 */
import { invoke } from "@/lib/ipc";

export interface SkillRecord {
  id: number;
  name: string;
  slug: string | null;
  version: string | null;
  source: string;
  dir: string;
  description: string | null;
  enabled: boolean;
  installedAt: string;
}

export interface BatchUninstallResult {
  succeeded: string[];
  failed: Array<{ name: string; reason: string }>;
}

const SkillApi = {
  list: () => invoke<SkillRecord[]>("skill:list"),
  setEnabled: (name: string, enabled: boolean) =>
    invoke<null>("skill:setEnabled", { name, enabled }),
  batchSetEnabled: (names: string[], enabled: boolean) =>
    invoke<null>("skill:batchSetEnabled", { names, enabled }),
  uninstall: (name: string) => invoke<null>("skill:uninstall", { name }),
  batchUninstall: (names: string[]) =>
    invoke<BatchUninstallResult>("skill:batchUninstall", { names }),
};

export default SkillApi;
```

- [ ] **Step 2: 实现 SkillRepository**

新建 `electron/domains/ai/skill/skill.repo.ts`(模式对照 `electron/domains/ai/mcp/mcp.repo.ts`):

```ts
/**
 * skillRecord 仓储:skill:list 自愈对账(扫描→比对→落库→返回)+
 * 启停/批量/卸载。卸载仅允许 userData/skills 内路径(防越界)。
 */
import { ipcMain, app } from "electron";
import { rmSync } from "node:fs";
import path from "node:path";
import prisma from "../../commons/prisma-client";
import type { PrismaClient } from "../../generated/prisma/client";
import { loadSkills } from "../agent/skill-loader";
import {
  isInsideDir,
  syncSkillRecords,
  type SkillRecordRow,
} from "./skill-sync";
import type {
  BatchUninstallResult,
  SkillRecord,
} from "../../../../src-react/domains/ai/skills/api/skill.api";

export class SkillRepository {
  constructor(private readonly prismaClient: PrismaClient = prisma) {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("skill:list", () => this.list());
    ipcMain.handle(
      "skill:setEnabled",
      (_e, p: { name: string; enabled: boolean }) =>
        this.setEnabled(p.name, p.enabled),
    );
    ipcMain.handle(
      "skill:batchSetEnabled",
      (_e, p: { names: string[]; enabled: boolean }) =>
        this.batchSetEnabled(p.names, p.enabled),
    );
    ipcMain.handle("skill:uninstall", (_e, p: { name: string }) =>
      this.uninstall(p.name),
    );
    ipcMain.handle("skill:batchUninstall", (_e, p: { names: string[] }) =>
      this.batchUninstall(p.names),
    );
  }

  private skillsRoot(): string {
    return path.join(app.getPath("userData"), "skills");
  }

  /** 扫描→对账→落库→返回全量记录(name 升序) */
  async list(): Promise<SkillRecord[]> {
    const root = this.skillsRoot();
    const scanned = loadSkills([{ dir: root, source: "user" }]);
    const rows = await this.prismaClient.skillRecord.findMany();
    const plan = syncSkillRecords(scanned, rows);
    if (plan.toDeleteIds.length > 0) {
      await this.prismaClient.skillRecord.deleteMany({
        where: { id: { in: plan.toDeleteIds } },
      });
    }
    for (const item of plan.toInsert) {
      await this.prismaClient.skillRecord.create({ data: item });
    }
    for (const item of plan.toUpdate) {
      await this.prismaClient.skillRecord.update({
        where: { id: item.id },
        data: { dir: item.dir, description: item.description },
      });
    }
    const fresh = await this.prismaClient.skillRecord.findMany({
      orderBy: { name: "asc" },
    });
    return fresh.map((row) => ({
      ...row,
      installedAt: row.installedAt.toISOString(),
    }));
  }

  async setEnabled(name: string, enabled: boolean): Promise<null> {
    await this.prismaClient.skillRecord.updateMany({
      where: { name },
      data: { enabled },
    });
    return null;
  }

  async batchSetEnabled(names: string[], enabled: boolean): Promise<null> {
    if (names.length > 0) {
      await this.prismaClient.skillRecord.updateMany({
        where: { name: { in: names } },
        data: { enabled },
      });
    }
    return null;
  }

  /** chat.service 消费:禁用技能名集合(组装时过滤) */
  async getDisabledNames(): Promise<Set<string>> {
    const rows = await this.prismaClient.skillRecord.findMany({
      where: { enabled: false },
      select: { name: true },
    });
    return new Set(rows.map((r) => r.name));
  }

  /** 卸载 = 删目录 + 删记录;路径越界拒绝;目录删除失败时记录保留(可重试) */
  async uninstall(name: string): Promise<null> {
    const row = await this.prismaClient.skillRecord.findUnique({
      where: { name },
    });
    if (!row) {
      return null;
    }
    if (!isInsideDir(row.dir, this.skillsRoot())) {
      throw new Error(`技能目录不在管理范围内: ${row.dir}`);
    }
    rmSync(row.dir, { recursive: true, force: true });
    await this.prismaClient.skillRecord.delete({ where: { id: row.id } });
    return null;
  }

  async batchUninstall(names: string[]): Promise<BatchUninstallResult> {
    const result: BatchUninstallResult = { succeeded: [], failed: [] };
    for (const name of names) {
      try {
        await this.uninstall(name);
        result.succeeded.push(name);
      } catch (e) {
        result.failed.push({
          name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
  }
}
```

- [ ] **Step 3: Application 装配**

`electron/Application.ts`:`import { SkillRepository } from "./domains/ai/skill/skill.repo";`
在 `registerServices()` 中,把 `new ChatService(sessionRepo);`(L107 附近)改为:

```ts
const skillRepo = new SkillRepository(prisma);
new ChatService(sessionRepo, skillRepo);
```

(注意:Task 4 才给 ChatService 构造加第二参数;本任务先只做 `new SkillRepository(prisma)` + 独立实例化,ChatService 改造留到 Task 4,避免中间态编译失败。即本步骤此处只加一行 `new SkillRepository(prisma);`,放在 `new McpRepository(prisma, mcpManager);` 之后。)

- [ ] **Step 4: 验证 + Commit**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: 全绿

```bash
git add src-react/domains/ai/skills/api/skill.api.ts electron/domains/ai/skill/skill.repo.ts electron/Application.ts
git commit -m "feat(skill): SkillRepository(对账/启停/批量/卸载 IPC)"
```

---

### Task 4: chat.service 禁用即时生效

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`(构造函数 ~L624、collectSkills ~L987、调用点 ~L1064)
- Modify: `electron/Application.ts`(装配传参,Task 3 已建实例)
- Test: `tests/ai/skill-sync.test.ts`(filterDisabledSkills 已在 Task 2 覆盖,本任务无新增测试文件)

**Interfaces:**
- Consumes: `SkillRepository.getDisabledNames(): Promise<Set<string>>`(Task 3);`filterDisabledSkills`(Task 2)
- Produces: `ChatService` 构造第二可选参数 `skillRepo?: { getDisabledNames(): Promise<Set<string>> }`

- [ ] **Step 1: 构造注入**

`chat.service.ts` 构造改为(类型收窄为最小接口,便于测试替换):

```ts
/** 最小依赖接口:仅用到禁用名单(测试可注入 stub) */
type SkillDisabledLookup = { getDisabledNames(): Promise<Set<string>> };

constructor(
  private sessions: SessionRepository,
  private skillRepo?: SkillDisabledLookup,
) {
  this.registerHandlers();
}
```

- [ ] **Step 2: 新增 collectEnabledSkills(collectSkills 保留不动)**

紧挨 `collectSkills`(约 L987)后追加:

```ts
/**
 * 禁用即时生效(P-A spec §4.2):user 级按 DB 启用态过滤(禁用对模型=
 * 不存在);repo 缺席(测试)时不过滤,行为与 P2 一致
 */
private async collectEnabledSkills(workspaceDir?: string) {
  const all = this.collectSkills(workspaceDir);
  if (!this.skillRepo) {
    return all;
  }
  const disabled = await this.skillRepo.getDisabledNames();
  return filterDisabledSkills(all, disabled);
}
```

并在文件头部 import 区补:

```ts
import { filterDisabledSkills } from "../skill/skill-sync";
```

- [ ] **Step 3: 替换调用点**

`streamAndPersist` 内(约 L1064)`const skills = this.collectSkills(agent.workspacePath);`
改为 `const skills = await this.collectEnabledSkills(agent.workspacePath);`
(该函数为 async,`skills` 随后同时供 system prompt 与 `collectToolDefinitions` 使用,两处自动生效。)

- [ ] **Step 4: Application 装配传参**

Task 3 建的实例接入:`new ChatService(sessionRepo, skillRepo);`

- [ ] **Step 5: 验证既有测试不受影响**

Run: `npm run test`
Expected: 全绿(chat.service.test.ts 构造不传第二参数 → 不过滤,P2 行为不变)

Run: `npm run lint && npm run typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/chat/chat.service.ts electron/Application.ts
git commit -m "feat(skill): 禁用技能对模型即时失效(system+read_skill 同源过滤)"
```

---

### Task 5: 前端本地搜索过滤(TDD)

**Files:**
- Create: `src-react/domains/ai/skills/lib/skill-filter.ts`
- Test: `tests/ai/skill-filter.test.ts`

**Interfaces:**
- Consumes: `SkillRecord`(Task 3)
- Produces: `filterSkillRecords(records: SkillRecord[], keyword: string): SkillRecord[]`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";

import { filterSkillRecords } from "../../src-react/domains/ai/skills/lib/skill-filter";
import type { SkillRecord } from "../../src-react/domains/ai/skills/api/skill.api";

const base: SkillRecord = {
  id: 1,
  name: "TencentDocs",
  slug: "tencent-docs",
  version: null,
  source: "local",
  dir: "/ud/skills/tencent-docs",
  description: "腾讯文档操作",
  enabled: true,
  installedAt: "2026-09-05T00:00:00.000Z",
};

describe("filterSkillRecords 技能本地搜索", () => {
  it("空关键字原样返回", () => {
    expect(filterSkillRecords([base], "")).toEqual([base]);
    expect(filterSkillRecords([base], "   ")).toEqual([base]);
  });

  it("按 name/slug/description 不区分大小写匹配", () => {
    const records = [base, { ...base, id: 2, name: "zip", slug: null, description: "压缩" }];
    expect(filterSkillRecords(records, "tencent")).toHaveLength(2);
    expect(filterSkillRecords(records, "DOCS")).toHaveLength(1);
    expect(filterSkillRecords(records, "压缩")).toEqual([records[1]]);
  });

  it("无命中返回空数组", () => {
    expect(filterSkillRecords([base], "不存在")).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/skill-filter.test.ts`
Expected: FAIL(Cannot find module)

- [ ] **Step 3: 实现**

新建 `src-react/domains/ai/skills/lib/skill-filter.ts`:

```ts
/**
 * 技能列表本地搜索过滤(纯函数):匹配 name/slug/description,不区分大小写
 */
import type { SkillRecord } from "../api/skill.api";

export function filterSkillRecords(
  records: SkillRecord[],
  keyword: string,
): SkillRecord[] {
  const q = keyword.trim().toLowerCase();
  if (!q) {
    return records;
  }
  return records.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.slug ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q),
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ai/skill-filter.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/skills/lib/skill-filter.ts tests/ai/skill-filter.test.ts
git commit -m "feat(skill): 技能列表本地搜索过滤纯函数"
```

---

### Task 6: SkillCard + SkillManagerView + Tab 挂载 + i18n

**Files:**
- Create: `src-react/domains/ai/skills/components/SkillCard.tsx`
- Create: `src-react/domains/ai/skills/views/SkillManagerView.tsx`
- Modify: `src-react/domains/ai/experts/views/ExpertsView.tsx`(技能 Tab 换挂载;删除原 skills Card 与 openSkillDir)
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`(新增 `skills` 子树)

**Interfaces:**
- Consumes: `SkillApi`(Task 3)、`filterSkillRecords`(Task 5)、`mapIpcError`(`../../chat/lib/error-message`)、`invoke`(`@/lib/ipc`,空态打开目录)、UI 基件 `Button/Card/Switch/Checkbox/AlertDialog/Input`

- [ ] **Step 1: i18n key(先加文案,组件直接用)**

`zh-CN/chat.json` 顶层新增(注意顶层不得与既有 key 重名;`experts.skillsDesc` 保留不动):

```json
"skills": {
  "searchPlaceholder": "搜索技能",
  "batchManage": "批量管理",
  "selected": "已选 {{count}} 项",
  "selectAll": "全选",
  "clear": "清空",
  "enable": "开启",
  "disable": "关闭",
  "uninstall": "卸载",
  "cancelBatch": "取消",
  "uninstallTitle": "卸载技能",
  "uninstallDesc": "将删除 {{names}} 的技能文件与记录,该操作不可恢复。",
  "empty": "还没有技能",
  "emptyTip": "将含 SKILL.md 的技能文件夹放入技能目录即可自动识别",
  "openDir": "打开技能目录",
  "batchDone": "已处理 {{count}} 项",
  "batchFailed": "失败:{{names}}",
  "source": { "builtin": "内置", "market": "市场", "local": "本地" }
}
```

`en-US/chat.json` 对应:

```json
"skills": {
  "searchPlaceholder": "Search skills",
  "batchManage": "Batch manage",
  "selected": "{{count}} selected",
  "selectAll": "Select all",
  "clear": "Clear",
  "enable": "Enable",
  "disable": "Disable",
  "uninstall": "Uninstall",
  "cancelBatch": "Cancel",
  "uninstallTitle": "Uninstall skills",
  "uninstallDesc": "This will delete skill files and records of {{names}}. This cannot be undone.",
  "empty": "No skills yet",
  "emptyTip": "Put a skill folder containing SKILL.md into the skills directory",
  "openDir": "Open skills directory",
  "batchDone": "{{count}} processed",
  "batchFailed": "Failed: {{names}}",
  "source": { "builtin": "Built-in", "market": "Market", "local": "Local" }
}
```

- [ ] **Step 2: SkillCard 组件**

新建 `src-react/domains/ai/skills/components/SkillCard.tsx`:

```tsx
/**
 * 单个技能卡片:图标(名称首字符占位)/名称/描述/来源标签;
 * 普通模式右上角 Toggle,批量模式左上角 Checkbox(互斥展示)
 */
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type { SkillRecord } from "../api/skill.api";

interface SkillCardProps {
  record: SkillRecord;
  batchMode: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
}

export default function SkillCard({
  record,
  batchMode,
  checked,
  onCheckedChange,
  onEnabledChange,
}: SkillCardProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <Card
      className={cn(
        "flex flex-col border-border/50 rounded-lg shadow-sm",
        batchMode && checked && "border-primary/50 bg-primary-subtle/40",
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          {batchMode ? (
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => onCheckedChange(v === true)}
              className="mt-1"
              aria-label={record.name}
            />
          ) : (
            <Switch
              checked={record.enabled}
              onCheckedChange={(v) => onEnabledChange(v === true)}
              aria-label={record.name}
            />
          )}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-sm font-semibold text-primary">
            {record.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {record.name}
            </p>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
              {record.description ?? ""}
            </p>
          </div>
          {record.source in { builtin: 1, market: 1 } && (
            <Badge variant="secondary" className="shrink-0">
              {t(`chat:skills.source.${record.source}`)}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

(注:`record.source in {...}` 写法如未通过 lint,改为 `["builtin", "market"].includes(record.source)`;local 是 P-A 唯一来源,不显示标签。)

- [ ] **Step 3: SkillManagerView**

新建 `src-react/domains/ai/skills/views/SkillManagerView.tsx`:

```tsx
/**
 * "我安装的"技能管理页:搜索 + 卡片网格 + 批量管理模式(全选/清空/开启/
 * 关闭/卸载/取消)。卸载 AlertDialog 二次确认,批量结果 toast 汇总
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { invoke } from "@/lib/ipc";
import SkillApi from "../api/skill.api";
import { filterSkillRecords } from "../lib/skill-filter";
import { mapIpcError } from "../../chat/lib/error-message";
import SkillCard from "../components/SkillCard";

export default function SkillManagerView() {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const recordsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
  });
  const records = recordsQuery.data ?? [];
  const visible = useMemo(
    () => filterSkillRecords(records, keyword),
    [records, keyword],
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
  };

  const toggleChecked = (name: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  };

  const handleEnabledChange = async (name: string, enabled: boolean) => {
    try {
      await SkillApi.setEnabled(name, enabled);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const runBatch = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleUninstall = async () => {
    const names = [...selected];
    setConfirmOpen(false);
    try {
      const result = await SkillApi.batchUninstall(names);
      await invalidate();
      if (result.failed.length === 0) {
        toast.success(t("chat:skills.batchDone", { count: names.length }));
      } else {
        toast.warning(
          t("chat:skills.batchDone", {
            count: result.succeeded.length,
          }),
          {
            description: t("chat:skills.batchFailed", {
              names: result.failed.map((f) => f.name).join(", "),
            }),
          },
        );
      }
      setSelected(new Set());
      setBatchMode(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const openSkillDir = async () => {
    try {
      await invoke("skill:openDir");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部操作条:搜索 + 批量管理(添加技能下拉 P-B 接入) */}
      {!batchMode ? (
        <div className="flex items-center gap-2">
          <div className="relative w-56">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("chat:skills.searchPlaceholder")}
              className="h-8 pl-7 text-sm"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => {
              setBatchMode(true);
              setSelected(new Set());
            }}
          >
            {t("chat:skills.batchManage")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <span className="text-xs text-muted-foreground">
            {t("chat:skills.selected", { count: selected.size })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setSelected(new Set(visible.map((r) => r.name)))}
          >
            {t("chat:skills.selectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setSelected(new Set())}
          >
            {t("chat:skills.clear")}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={selected.size === 0}
              onClick={() =>
                runBatch(() => SkillApi.batchSetEnabled([...selected], true))
              }
            >
              {t("chat:skills.enable")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={selected.size === 0}
              onClick={() =>
                runBatch(() => SkillApi.batchSetEnabled([...selected], false))
              }
            >
              {t("chat:skills.disable")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive hover:border-destructive/30"
              disabled={selected.size === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {t("chat:skills.uninstall")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setBatchMode(false);
                setSelected(new Set());
              }}
            >
              {t("chat:skills.cancelBatch")}
            </Button>
          </div>
        </div>
      )}

      {recordsQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : recordsQuery.isError ? (
        <p className="py-16 text-center text-sm text-destructive">
          {t("common:failed")}
        </p>
      ) : visible.length === 0 && records.length === 0 ? (
        <Card className="border-border/50 rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">
              {t("chat:skills.empty")}
            </CardTitle>
            <CardDescription>{t("chat:skills.emptyTip")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void openSkillDir()}>
              <FolderOpen className="mr-1 h-4 w-4" />
              {t("chat:skills.openDir")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((record) => (
            <SkillCard
              key={record.id}
              record={record}
              batchMode={batchMode}
              checked={selected.has(record.name)}
              onCheckedChange={(checked) =>
                toggleChecked(record.name, checked)
              }
              onEnabledChange={(enabled) =>
                void handleEnabledChange(record.name, enabled)
              }
            />
          ))}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:skills.uninstallTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:skills.uninstallDesc", {
                names: [...selected].join(", "),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleUninstall()}
            >
              {t("chat:skills.uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 4: ExpertsView 技能 Tab 换挂载**

`src-react/domains/ai/experts/views/ExpertsView.tsx`:
- 删除 `invoke`、`toast`、`Card/CardContent/CardDescription/CardHeader/CardTitle`、`openSkillDir` 等仅服务于旧技能卡的 import 与代码(保留 Tab 结构)
- `{tab === "skills" && ...}` 整块替换为:

```tsx
      {tab === "skills" && <SkillManagerView />}
```

- 头部补 `import SkillManagerView from "../../skills/views/SkillManagerView";`
- 组件头注释更新为「专家与连接器 Tab 复用既有设置视图;技能 Tab 挂 SkillManagerView(P-A)」

- [ ] **Step 5: 验证 + Commit**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: 全绿(UI 无组件测试基建,靠手测清单 Task 7)

```bash
git add src-react/domains/ai/skills/ src-react/domains/ai/experts/views/ExpertsView.tsx src-react/i18n/locales/
git commit -m "feat(skill): 我安装的管理页(开关/搜索/批量管理模式)"
```

---

### Task 7: 全量验证 + DoD 手测

**Files:** 无新增(验证任务)

- [ ] **Step 1: 自动化全量**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: 全绿

- [ ] **Step 2: 手测清单(npm run dev,逐条核对 spec §9 DoD)**

1. 手放 `userData/skills/<name>/SKILL.md`(frontmatter 含 name/description)→ 技能页刷新出现,标"本地"或无标签,Toggle 默认开
2. Toggle 关闭 → 新会话让模型列技能 → 该技能不在清单;`read_skill(该名)` → "错误: 技能不存在";重启 App 状态保持
3. 批量:进批量管理勾 3 项 → 关闭 → 全部置灰;卸载 → 确认框列出名称 → 确认后卡片消失、目录删除(文件管理器核对)
4. 手删技能目录 → 技能页刷新 → 条目消失
5. 用旧库(v5 数据)启动 → 自动升 v6,既有会话/服务商数据无损
6. 顶部搜索输入关键字 → 实时过滤;清空 → 恢复

- [ ] **Step 3: Commit(如有手测修复)**

```bash
git add -A
git commit -m "fix(skill): P-A 手测修复收尾"
```
