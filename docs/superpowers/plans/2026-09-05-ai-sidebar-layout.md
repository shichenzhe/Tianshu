# AI 模块标准侧边栏布局改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除系统菜单、默认进 AI 模块，将 AI 左侧改为桌面客户端标准侧边栏（功能入口 + 空间分组任务树 + 顶栏全局搜索/筛选），置顶/归档/时间筛选真实持久化。

**Architecture:** 新建 `AiLayout`（标准侧边栏 + Outlet 子路由）替换系统 Sidebar + SessionSidebar；任务选中态进 URL（`?session=`）；折叠/筛选/搜索开关放 AI 域 zustand store `ai-ui.store`；session 表加 `pinnedAt`/`archivedAt`（DB v5 迁移）；welcome/system-config 前端域删除。

**Tech Stack:** Electron 44 + React 19 + TypeScript + Zustand + React Query + React Router 7 + Prisma 7 + SQLite + Vitest

**Spec:** `docs/superpowers/specs/2026-09-05-ai-sidebar-layout-design.md`

## Global Constraints

- i18n：禁止 JSX/逻辑中硬编码用户可见文案；新 key 双语（zh-CN + en-US）同步添加；key camelCase 分层嵌套；禁止顶层 key 与嵌套对象 key 重名
- 主题色禁止硬编码蓝/红等具体色，用 `bg-primary-subtle`、`text-primary`、`border-primary/20` 等主题变量
- 弹出层（Popover/Dropdown/Dialog）：`border-border/50 rounded-lg shadow-lg`
- 代码风格：双引号、分号、tabWidth=2、printWidth=80；函数 ≤20 行；生产环境禁 console
- 组件/视图文件名 PascalCase（跟随现状），非组件文件 kebab-case
- 测试命令：`npm run test`（Vitest，include `tests/**/*.test.{mjs,ts}` 与 `scripts/**/*.test.mjs`，**不含 tsx**，前端仅纯逻辑可测）；质量门：`npm run test` + `npm run lint` + `npm run typecheck`
- DB 迁移：`electron/Constants.ts` 的 `DATABASE_VERSION` 当前为 **4**，本次升 **5**；脚本放 `electron/infrastructure/script/v5/upgrade-table.sql`，幂等用 `--/ignore` 前缀（重复执行吞 duplicate column 错误，见 `sql-file-executor` 与 `tests/ai/v3-migration.test.ts` 模式）
- 后端 `option` 域（`electron/domains/option/`）**保留不删**——被 `user.repo`/`chat.service`/`file-tools`/`command-tool`/`Application.ts` 引用；只删前端 system-config 域
- 旧路由 `/module/ai/assistants`、`/module/ai/mcp` 的全部前端跳转点统一改指 `/module/ai/experts`（LoginView→`/module/ai`）

---

### Task 1: DB v5 迁移（session 加 pinnedAt/archivedAt）

**Files:**
- Create: `electron/infrastructure/script/v5/upgrade-table.sql`
- Modify: `electron/Constants.ts:8`（`DATABASE_VERSION: 4` → `5`）
- Modify: `prisma/schema.prisma`（session model）
- Test: `tests/ai/v5-migration.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: session 表新增 `pinnedAt DATETIME NULL`、`archivedAt DATETIME NULL`；Prisma Client 重新生成后 `prisma.session` 类型含两可空 DateTime 字段（后续任务依赖）

- [ ] **Step 1: 写迁移幂等测试（失败态）**

创建 `tests/ai/v5-migration.test.ts`（仿 `tests/ai/v3-migration.test.ts` 的 statements 解析模式）：

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V5_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v5/upgrade-table.sql",
  ),
  "utf8",
);

/** 去掉注释标记行后按分号拆分语句（模拟 sql-file-executor 的最小语义） */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** v4 起点的 session 表（含 v3 加的 mode 列） */
function createV4SessionTable(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE session (id INTEGER PRIMARY KEY, workspaceId INTEGER NOT NULL, " +
      "assistantId INTEGER, currentModelId INTEGER, title TEXT NOT NULL, mode TEXT, " +
      "createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, lastMessageAt DATETIME)",
  );
}

describe("v5 迁移脚本幂等", () => {
  it("重复执行两次：pinnedAt/archivedAt 列存在且旧行默认 null", () => {
    const db = new DatabaseSync(":memory:");
    createV4SessionTable(db);
    db.exec(
      "INSERT INTO session (workspaceId, title, createdAt, updatedAt) VALUES (1, '旧任务', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    );
    for (let round = 0; round < 2; round++) {
      for (const stmt of statements(V5_SQL)) {
        try {
          db.exec(stmt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("duplicate column")) {
            throw e;
          }
        }
      }
    }
    const cols = db.prepare("PRAGMA table_info(session)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("pinnedAt");
    expect(cols.map((c) => c.name)).toContain("archivedAt");
    const row = db
      .prepare("SELECT pinnedAt, archivedAt FROM session WHERE id = 1")
      .get() as { pinnedAt: unknown; archivedAt: unknown };
    expect(row.pinnedAt).toBeNull();
    expect(row.archivedAt).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/v5-migration.test.ts`
Expected: FAIL（文件不存在读取报错 ENOENT）

- [ ] **Step 3: 写迁移脚本与 schema**

创建 `electron/infrastructure/script/v5/upgrade-table.sql`：

```sql
--/ignore
ALTER TABLE session ADD COLUMN pinnedAt DATETIME;

--/ignore
ALTER TABLE session ADD COLUMN archivedAt DATETIME;
```

修改 `prisma/schema.prisma` 的 session model（在 `lastMessageAt` 后加两行）：

```prisma
model session {
  id             Int       @id @default(autoincrement())
  workspaceId    Int
  assistantId    Int?
  currentModelId Int?
  title          String    @default("新会话")
  mode           String?
  pinnedAt       DateTime?
  archivedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  lastMessageAt  DateTime?
}
```

修改 `electron/Constants.ts:8`：

```ts
  static readonly DATABASE_VERSION: number = 5;
```

- [ ] **Step 4: 重新生成 Prisma Client 并跑测试**

Run: `npx prisma generate && npm run test -- tests/ai/v5-migration.test.ts`
Expected: PASS（1 test）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add electron/infrastructure/script/v5 electron/Constants.ts prisma/schema.prisma electron/generated tests/ai/v5-migration.test.ts
git commit -m "feat(db): session 表新增 pinnedAt/archivedAt（v5 迁移）"
```

---

### Task 2: SessionRepository 扩展 + IPC + 前端 api

**Files:**
- Modify: `electron/domains/ai/chat/session.repo.ts`
- Modify: `src-react/lib/ipc.ts`（IPCChannel 联合类型）
- Modify: `src-react/domains/ai/api/session.api.ts`
- Test: `tests/ai/session-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 Prisma `session.pinnedAt`/`archivedAt` 字段
- Produces（后续任务依赖的精确签名）:
  - `SessionRecord` 新增 `pinnedAt?: string; archivedAt?: string`（ISO 串，null 归一 undefined）
  - `SessionApi.listAll(): Promise<SessionRecord[]>`（全部未归档，按 `lastMessageAt desc`）
  - `SessionApi.pin(id: number, pinned: boolean): Promise<void>`
  - `SessionApi.archive(id: number, archived: boolean): Promise<void>`
  - `SessionApi.searchByTitle(keyword: string): Promise<SessionRecord[]>`（空关键词返回最近 20 条）
  - `SessionRepository.listAllSessions()/pinSession(id, pinned)/archiveSession(id, archived)/searchSessionsByTitle(keyword)/openWorkspaceDirectory(workspaceId)`（Task 6 的 IPC `workspace:openDirectory` 调 `openWorkspaceDirectory`）

- [ ] **Step 1: 写 repo 测试（失败态）**

创建 `tests/ai/session-repo.test.ts`：

```ts
/**
 * v5 任务管理扩展单测：listAll 过滤归档、pin/archive 落库参数、
 * searchByTitle 的 LIKE/排序/take 语义、toSession 的新字段序列化。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用
 * permissions-integration.test.ts 的 mock 模式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaStub = vi.hoisted(() => ({
  workspace: { count: vi.fn(async () => 1) },
  session: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";
import type { SessionRow } from "../../electron/domains/ai/chat/session.repo";

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 1,
    workspaceId: 2,
    assistantId: null,
    currentModelId: null,
    title: "任务A",
    mode: null,
    pinnedAt: null,
    archivedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-04T00:00:00Z"),
    lastMessageAt: null,
    ...overrides,
  } as SessionRow;
}

describe("SessionRepository v5 扩展", () => {
  let repo: SessionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.workspace.count.mockResolvedValue(1);
    repo = new SessionRepository();
  });

  it("listAllSessions 只查未归档并按 lastMessageAt 倒序", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ pinnedAt: new Date("2026-09-03T00:00:00Z") }),
    ]);
    const rows = await repo.listAllSessions();
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null },
      orderBy: { lastMessageAt: "desc" },
    });
    expect(rows[0].pinnedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(rows[0].archivedAt).toBeUndefined();
  });

  it("pinSession(true) 写当前时间、pinSession(false) 写 null", async () => {
    await repo.pinSession(1, true);
    const data = prismaStub.session.update.mock.calls[0][0].data;
    expect(data.pinnedAt).toBeInstanceOf(Date);
    await repo.pinSession(1, false);
    expect(prismaStub.session.update.mock.calls[1][0].data).toEqual({
      pinnedAt: null,
    });
  });

  it("archiveSession 同理切换 archivedAt", async () => {
    await repo.archiveSession(1, true);
    expect(
      prismaStub.session.update.mock.calls[0][0].data.archivedAt,
    ).toBeInstanceOf(Date);
    await repo.archiveSession(1, false);
    expect(prismaStub.session.update.mock.calls[1][0].data).toEqual({
      archivedAt: null,
    });
  });

  it("searchSessionsByTitle 关键词模式：LIKE + 未归档 + 倒序 + take 20", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.searchSessionsByTitle("金价");
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { title: { contains: "金价" }, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
  });

  it("searchSessionsByTitle 空关键词：最近任务模式", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.searchSessionsByTitle("");
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
  });

  it("listSessions 补过滤 archivedAt: null", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.listSessions(2);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 2, archivedAt: null },
      orderBy: { lastMessageAt: "desc" },
    });
  });
});
```

注：若 `SessionRow` 未导出（当前未导出），本步骤同时把它导出——在 `session.repo.ts` 的 `type SessionRow = ...` 行加 `export`。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/session-repo.test.ts`
Expected: FAIL（`listAllSessions is not a function` 等）

- [ ] **Step 3: 实现 repo 扩展**

修改 `electron/domains/ai/chat/session.repo.ts`：

3a. import 行改为（加 `shell`）：

```ts
import { ipcMain, shell } from "electron";
```

3b. 导出 SessionRow 类型：`type SessionRow` → `export type SessionRow`

3c. `toSession` 返回对象补两行（在 `lastMessageAt` 行后）：

```ts
      pinnedAt: row.pinnedAt?.toISOString() ?? undefined,
      archivedAt: row.archivedAt?.toISOString() ?? undefined,
```

3d. `registerIpcHandlers` 内追加（在 `session:setMode` 注册之后）：

```ts
    ipcMain.handle("session:listAll", () => this.listAllSessions());
    ipcMain.handle(
      "session:pin",
      (_, id: number, pinned: boolean) => this.pinSession(id, pinned),
    );
    ipcMain.handle(
      "session:archive",
      (_, id: number, archived: boolean) => this.archiveSession(id, archived),
    );
    ipcMain.handle("session:searchByTitle", (_, keyword: string) =>
      this.searchSessionsByTitle(keyword),
    );
    ipcMain.handle("workspace:openDirectory", (_, workspaceId: number) =>
      this.openWorkspaceDirectory(workspaceId),
    );
```

3e. `listSessions` 的 where 改为 `{ workspaceId, archivedAt: null }`

3f. 类内新增方法（放 `renameSession` 之前）：

```ts
  /** v5：全部未归档任务（标准侧边栏分组树数据源） */
  async listAllSessions(): Promise<SessionRecord[]> {
    return (
      await prisma.session.findMany({
        where: { archivedAt: null },
        orderBy: { lastMessageAt: "desc" },
      })
    ).map((row) => this.toSession(row));
  }

  /** v5 置顶：置 true 记时间戳（前端按其倒序排列），false 清空 */
  async pinSession(id: number, pinned: boolean): Promise<void> {
    await prisma.session.update({
      where: { id },
      data: { pinnedAt: pinned ? new Date() : null },
    });
  }

  /** v5 归档：归档任务从列表/搜索消失，撤销即清空 */
  async archiveSession(id: number, archived: boolean): Promise<void> {
    await prisma.session.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  /** v5 任务标题搜索：空关键词退化为最近任务（spec §4.1） */
  async searchSessionsByTitle(keyword: string): Promise<SessionRecord[]> {
    const trimmed = keyword.trim();
    const where = trimmed
      ? { title: { contains: trimmed }, archivedAt: null }
      : { archivedAt: null };
    return (
      await prisma.session.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 20,
      })
    ).map((row) => this.toSession(row));
  }

  /** v5 打开空间绑定目录（上下文菜单「打开文件夹」） */
  async openWorkspaceDirectory(workspaceId: number): Promise<void> {
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace?.directoryPath) {
      await shell.openPath(workspace.directoryPath);
    }
  }
```

- [ ] **Step 4: 跑 repo 测试通过**

Run: `npm run test -- tests/ai/session-repo.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 前端 IPC channel 与 api 层**

修改 `src-react/lib/ipc.ts` 的 IPCChannel 联合类型——`"session:setMode"` 行后加：

```ts
  | "session:listAll"
  | "session:pin"
  | "session:archive"
  | "session:searchByTitle"
```

`"workspace:unbindDirectory"` 行后加：

```ts
  | "workspace:openDirectory"
```

修改 `src-react/domains/ai/api/session.api.ts`：`SessionRecord` 接口加（`lastMessageAt` 后）：

```ts
  pinnedAt?: string;
  archivedAt?: string;
```

`SessionApi` 类加（`delete` 方法后）：

```ts
  /** v5：全部未归档任务（标准侧边栏分组树） */
  static async listAll(): Promise<SessionRecord[]> {
    return invoke<SessionRecord[]>("session:listAll");
  }

  static async pin(id: number, pinned: boolean): Promise<void> {
    return invoke<void>("session:pin", id, pinned);
  }

  static async archive(id: number, archived: boolean): Promise<void> {
    return invoke<void>("session:archive", id, archived);
  }

  /** 空关键词返回最近 20 条（最近任务模式） */
  static async searchByTitle(keyword: string): Promise<SessionRecord[]> {
    return invoke<SessionRecord[]>("session:searchByTitle", keyword);
  }
```

- [ ] **Step 6: 全量测试 + typecheck**

Run: `npm run test && npm run typecheck`
Expected: 全部 PASS、无类型错误

- [ ] **Step 7: Commit**

```bash
git add electron/domains/ai/chat/session.repo.ts src-react/lib/ipc.ts src-react/domains/ai/api/session.api.ts tests/ai/session-repo.test.ts
git commit -m "feat(ai): 任务置顶/归档/标题搜索后端与 api 层（v5）"
```

---

### Task 3: 任务列表纯函数（排序 + 时间筛选）

**Files:**
- Create: `src-react/domains/ai/chat/lib/session-list.ts`
- Test: `tests/ai/session-list.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type TimeFilter = "all" | "today" | "week" | "month";`
  - `export interface SessionTimeFields { pinnedAt?: string; lastMessageAt?: string; updatedAt: string; }`
  - `export function sortSessions<T extends SessionTimeFields>(sessions: T[]): T[]`（置顶 `pinnedAt` 倒序在前，其余 `lastMessageAt ?? updatedAt` 倒序；不修改入参）
  - `export function filterSessionsByTime<T extends SessionTimeFields>(sessions: T[], filter: TimeFilter, now?: Date): T[]`

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/session-list.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  filterSessionsByTime,
  sortSessions,
  type SessionTimeFields,
} from "../../src-react/domains/ai/chat/lib/session-list";

function item(overrides: Partial<SessionTimeFields> & { id: number }) {
  return {
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("sortSessions 置顶在前", () => {
  it("置顶项按 pinnedAt 倒序排最前，其余按最近活动倒序", () => {
    const now = "2026-09-05T00:00:00.000Z";
    const sorted = sortSessions([
      item({ id: 1, lastMessageAt: "2026-09-03T00:00:00.000Z" }),
      item({ id: 2, pinnedAt: "2026-09-01T00:00:00.000Z" }),
      item({ id: 3, pinnedAt: "2026-09-04T00:00:00.000Z" }),
      item({ id: 4, lastMessageAt: "2026-09-04T12:00:00.000Z" }),
      item({ id: 5 }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual([3, 2, 4, 1, 5]);
    expect(now).toBeTruthy();
  });

  it("不修改入参数组", () => {
    const input = [
      item({ id: 1, lastMessageAt: "2026-09-03T00:00:00.000Z" }),
      item({ id: 2, pinnedAt: "2026-09-01T00:00:00.000Z" }),
    ];
    sortSessions(input);
    expect(input[0].id).toBe(1);
  });
});

describe("filterSessionsByTime 时间筛选", () => {
  const now = new Date("2026-09-05T15:00:00.000Z");

  it("all 全部通过", () => {
    const sessions = [
      item({ id: 1, lastMessageAt: "2020-01-01T00:00:00.000Z" }),
      item({ id: 2 }),
    ];
    expect(filterSessionsByTime(sessions, "all", now)).toHaveLength(2);
  });

  it("today 仅保留当日 00:00 起的活动", () => {
    const sessions = [
      item({ id: 1, lastMessageAt: "2026-09-04T23:59:59.000Z" }),
      item({ id: 2, lastMessageAt: "2026-09-05T00:00:00.000Z" }),
      item({ id: 3, lastMessageAt: "2026-09-05T08:00:00.000Z" }),
    ];
    expect(filterSessionsByTime(sessions, "today", now).map((s) => s.id)).toEqual(
      [2, 3],
    );
  });

  it("week 以当日 00:00 回溯 7 天为界，lastMessageAt 缺省回退 updatedAt", () => {
    const sessions = [
      item({ id: 1, lastMessageAt: "2026-08-29T00:00:00.000Z" }), // 界外
      item({ id: 2, lastMessageAt: "2026-08-29T00:00:01.000Z" }), // 界内
      item({ id: 3, updatedAt: "2026-09-01T00:00:00.000Z" }), // 无 lastMessageAt
    ];
    expect(filterSessionsByTime(sessions, "week", now).map((s) => s.id)).toEqual([
      2, 3,
    ]);
  });

  it("month 以当日 00:00 回溯 30 天为界", () => {
    const sessions = [
      item({ id: 1, lastMessageAt: "2026-08-06T00:00:00.000Z" }), // 界外
      item({ id: 2, lastMessageAt: "2026-08-06T00:00:01.000Z" }), // 界内
    ];
    expect(filterSessionsByTime(sessions, "month", now).map((s) => s.id)).toEqual(
      [2],
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/session-list.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src-react/domains/ai/chat/lib/session-list.ts`：

```ts
/**
 * 标准侧边栏任务列表的排序与时间筛选（纯函数，ISO 串字典序即时间序）
 */

/** 时间筛选维度（顶栏筛选 Popover） */
export type TimeFilter = "all" | "today" | "week" | "month";

export interface SessionTimeFields {
  pinnedAt?: string;
  lastMessageAt?: string;
  updatedAt: string;
}

/** 任务排序：置顶（pinnedAt 倒序）在前，其余按最近活动倒序 */
export function sortSessions<T extends SessionTimeFields>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const pinnedDiff = (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "");
    if (pinnedDiff !== 0) {
      return pinnedDiff;
    }
    const timeA = a.lastMessageAt ?? a.updatedAt;
    const timeB = b.lastMessageAt ?? b.updatedAt;
    return timeB.localeCompare(timeA);
  });
}

/** 当日 00:00 时间戳（筛选阈值基准） */
function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 时间筛选：活动时间（lastMessageAt ?? updatedAt）不早于阈值 */
export function filterSessionsByTime<T extends SessionTimeFields>(
  sessions: T[],
  filter: TimeFilter,
  now = new Date(),
): T[] {
  if (filter === "all") {
    return sessions;
  }
  const days = filter === "today" ? 0 : filter === "week" ? 7 : 30;
  const threshold = startOfDay(now) - days * 86400000;
  return sessions.filter(
    (session) =>
      new Date(session.lastMessageAt ?? session.updatedAt).getTime() >=
      threshold,
  );
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm run test -- tests/ai/session-list.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/lib/session-list.ts tests/ai/session-list.test.ts
git commit -m "feat(ai): 任务列表排序与时间筛选纯函数"
```

---

### Task 4: ChatView 选中态 URL 化

**Files:**
- Modify: `src-react/domains/ai/chat/views/ChatView.tsx:44-107`（组件头部与状态管理段）

**Interfaces:**
- Consumes: 无
- Produces: 选中任务经 URL `?session=<id>` 表达（`/module/ai?session=12`）；`handleSelectSession`/`handleSelectWorkspace` 签名不变（SessionSidebar 无感）；后续任务（AiSidebar/全局搜索）通过 `navigate("/module/ai?session=<id>", { replace: true })` 选中任务

- [ ] **Step 1: 改造 ChatView 状态流**

修改 `src-react/domains/ai/chat/views/ChatView.tsx`：

1a. import 行：`useNavigate` 所在行改为

```ts
import { useNavigate, useSearchParams } from "react-router-dom";
```

1b. 组件内 `const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(null);` 与 `const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);` 两行替换为：

```ts
  const [searchParams, setSearchParams] = useSearchParams();
  // 选中任务进 URL（?session=）：刷新可恢复、全局搜索有跳转落点
  const selectedSessionId = Number(searchParams.get("session")) || null;
```

1c. 原 `handleSelectWorkspace` 替换为（切空间清空任务选中，与原语义一致）：

```ts
  const handleSelectWorkspace = (workspaceId: number | null) => {
    setActiveWorkspaceId(workspaceId);
    setSearchParams({}, { replace: true });
  };
```

1d. `onSelectSession={setSelectedSessionId}` 替换为：

```tsx
        onSelectSession={(id) =>
          setSearchParams(id ? { session: String(id) } : {}, { replace: true })
        }
```

注意：`activeWorkspaceId` 的 `useState` 与「首启自动选中第一个空间」的 `useEffect`（83-87 行）**保持不变**——本任务只 URL 化任务选中，空间派生在 Task 5 完成。

- [ ] **Step 2: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误

- [ ] **Step 3: 手动验证**

Run: `npm run dev`
验证清单：
1. 登录 → AI 页，点选任务后地址栏出现 `#module/ai?session=<id>`
2. 刷新页面，选中任务保持
3. 切换工作空间，`?session=` 被清除，会话区回到空态
4. 新建会话后 URL 带新 id 且自动选中

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/chat/views/ChatView.tsx
git commit -m "feat(ai): 任务选中态 URL 化（?session=）"
```

---

### Task 5: AiLayout + AiSidebar 基础版 + 路由与旧域清理

**Files:**
- Create: `src-react/domains/ai/store/ai-ui.store.ts`
- Create: `src-react/domains/ai/layout/views/AiLayout.tsx`
- Create: `src-react/domains/ai/layout/components/AiSidebar.tsx`
- Create: `src-react/domains/ai/layout/components/WorkspaceMenu.tsx`（自 SessionSidebar 迁移）
- Modify: `src-react/routes/index.tsx`（整文件重写）
- Modify: `src-react/components/layout/MainLayout.tsx`（删 Sidebar/边距）
- Modify: `src-react/domains/ai/chat/views/ChatView.tsx`（listAll + 派生空间 + 删 SessionSidebar）
- Modify: `src-react/domains/user/views/LoginView.tsx:85,180`（`/module/welcome` → `/module/ai`）
- Modify: `src-react/domains/ai/chat/components/PlusMenu.tsx:41`（ASSISTANTS_ROUTE → `"/module/ai/experts"`，Task 8 挂路由前先指向，中间态 404 可接受——或本任务保持原值，Task 8 一并改。**采用后者**：本任务不动 PlusMenu）
- Modify: `src-react/i18n/index.ts`（删 welcome/system-config 引用）
- Delete: `src-react/components/layout/Sidebar.tsx`、`src-react/domains/ai/chat/components/SessionSidebar.tsx`、`src-react/domains/welcome/`（整目录）、`src-react/domains/system-config/`（整目录）、`src-react/i18n/locales/{zh-CN,en-US}/welcome.json`、`src-react/i18n/locales/{zh-CN,en-US}/system-config.json`
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/layout.json`（删 `sidebar.welcome/ai/systemConfig` 三个 key，保留 `sidebar.collapse/expand`）

**Interfaces:**
- Consumes: Task 2 `SessionApi.listAll`；Task 3 `sortSessions`/`filterSessionsByTime`/`TimeFilter`；现有 `UnbindDirectoryDialog`、`bindWorkspaceDirectory`
- Produces:
  - `useAiUiStore`：`{ sidebarCollapsed: boolean; timeFilter: TimeFilter; searchOpen: boolean; toggleSidebar(): void; setTimeFilter(f: TimeFilter): void; resetFilter(): void; setSearchOpen(open: boolean): void }`（Task 6/7 依赖）
  - `AiLayout` 挂在 `/module/ai`，子路由 index=ChatView、providers=ProviderSettingsView（Task 8 再加三条）
  - 当前空间派生：`selectedSession?.workspaceId ?? workspaces[0]?.id ?? null`

- [ ] **Step 1: 建 ai-ui store**

创建 `src-react/domains/ai/store/ai-ui.store.ts`：

```ts
/**
 * AI 模块跨组件 UI 状态（侧边栏折叠 / 顶栏筛选 / 全局搜索面板开关）。
 * 折叠态沿用旧 sidebar-collapsed localStorage key（JSON 布尔），
 * 其余为内存态（刷新重置）。
 */

import { create } from "zustand";
import type { TimeFilter } from "../chat/lib/session-list";

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return JSON.parse(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ?? "false") === true;
  } catch {
    return false;
  }
}

interface AiUiState {
  sidebarCollapsed: boolean;
  timeFilter: TimeFilter;
  searchOpen: boolean;
  toggleSidebar: () => void;
  setTimeFilter: (filter: TimeFilter) => void;
  resetFilter: () => void;
  setSearchOpen: (open: boolean) => void;
}

export const useAiUiStore = create<AiUiState>((set) => ({
  sidebarCollapsed: readCollapsed(),
  timeFilter: "all",
  searchOpen: false,
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_KEY,
          JSON.stringify(next),
        );
      } catch {
        /* 持久化失败静默（隐私模式等） */
      }
      return { sidebarCollapsed: next };
    }),
  setTimeFilter: (filter) => set({ timeFilter: filter }),
  resetFilter: () => set({ timeFilter: "all" }),
  setSearchOpen: (open) => set({ searchOpen: open }),
}));
```

- [ ] **Step 2: 建 AiLayout**

创建 `src-react/domains/ai/layout/views/AiLayout.tsx`：

```tsx
/**
 * AI 模块布局：标准侧边栏 + 主内容区（Outlet 挂子路由）
 */

import { Outlet } from "react-router-dom";

import AiSidebar from "../components/AiSidebar";

export default function AiLayout() {
  return (
    <div className="flex h-full">
      <AiSidebar />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 建 WorkspaceMenu（自 SessionSidebar 迁移）**

创建 `src-react/domains/ai/layout/components/WorkspaceMenu.tsx`——将 `SessionSidebar.tsx:524-597` 的 `WorkspaceMenu` 组件及其 import（DropdownMenu 系列、Button、图标、`WorkspaceRecord` 类型）原样搬入，文件头注释：

```tsx
/**
 * 空间管理菜单（自 SessionSidebar 迁移）：新建/重命名/绑定目录/解绑/删除
 */
```

Props 接口保持不变（`disabled`/`workspace`/`onCreate`/`onRename`/`onDelete`/`onBindDirectory`/`onUnbindDirectory`）。

- [ ] **Step 4: 建 AiSidebar（基础版）**

创建 `src-react/domains/ai/layout/components/AiSidebar.tsx`（本任务交付分组树/选中/新建/空间管理/折叠；任务项悬停菜单与置顶归档在 Task 6 强化）：

```tsx
/**
 * 标准侧边栏：功能入口（新建任务/专家/自动化/资料库）+ 空间分组任务树。
 * 任务选中态在 URL（?session=），当前空间由选中任务派生。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  FolderInput,
  FolderMinus,
  FolderPlus,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";

import { getDateFnsLocale } from "@/i18n";
import { cn } from "@/lib/utils";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import WorkspaceApi, { type WorkspaceRecord } from "../../api/workspace.api";
import SessionApi, { type SessionRecord } from "../../api/session.api";
import {
  filterSessionsByTime,
  sortSessions,
} from "../../chat/lib/session-list";
import { mapIpcError } from "../../chat/lib/error-message";
import { bindWorkspaceDirectory } from "../../chat/lib/workspace-actions";
import { useChatStore } from "../../chat/store/chat.store";
import { useAiUiStore } from "../../store/ai-ui.store";
import UnbindDirectoryDialog from "../../chat/components/UnbindDirectoryDialog";
import WorkspaceMenu from "./WorkspaceMenu";

const WORKSPACES_KEY = ["workspaces"] as const;

interface WorkspaceDialogState {
  mode: "create" | "rename";
  name: string;
}

export default function AiSidebar() {
  const { t } = useTranslation(["chat", "common", "layout"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAiUiStore((s) => s.toggleSidebar);
  const timeFilter = useAiUiStore((s) => s.timeFilter);
  const isMac = window.platform === "darwin";

  const selectedSessionId = Number(searchParams.get("session")) || null;

  const [spacesOpen, setSpacesOpen] = useState(true);
  const [collapsedSpaces, setCollapsedSpaces] = useState<Record<number, boolean>>({});
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogState | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<WorkspaceRecord | null>(null);
  const [unbindingWorkspace, setUnbindingWorkspace] = useState<WorkspaceRecord | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [deletingSession, setDeletingSession] = useState<SessionRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => WorkspaceApi.list(),
  });
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => SessionApi.listAll(),
  });
  const workspaces = workspacesQuery.data ?? [];
  const sessions = useMemo(
    () =>
      sortSessions(filterSessionsByTime(sessionsQuery.data ?? [], timeFilter)),
    [sessionsQuery.data, timeFilter],
  );

  const handleError = (e: unknown) => {
    toast.error(mapIpcError(e));
  };

  const invalidateSessions = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };

  const selectSession = (id: number | null) => {
    navigate(
      id ? `/module/ai?session=${id}` : "/module/ai",
      { replace: true },
    );
  };

  // 当前空间 = 选中任务所属空间，无选中取第一个（spec §2.3）
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;
  const currentWorkspaceId =
    selectedSession?.workspaceId ?? workspaces[0]?.id ?? null;

  const handleCreateSession = async (workspaceId: number | null) => {
    if (workspaceId === null) {
      return;
    }
    try {
      const created = await SessionApi.create({ workspaceId });
      await invalidateSessions();
      selectSession(created.id);
    } catch (e) {
      handleError(e);
    }
  };

  const handleWorkspaceDialogSubmit = async () => {
    if (!workspaceDialog || submitting) {
      return;
    }
    const name = workspaceDialog.name.trim();
    setSubmitting(true);
    try {
      if (workspaceDialog.mode === "create") {
        const created = await WorkspaceApi.create({ name });
        await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
        handleCreateSession(created.id);
      } else if (currentWorkspaceId !== null) {
        await WorkspaceApi.update({ id: currentWorkspaceId, name });
        await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
      }
      setWorkspaceDialog(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!deletingWorkspace || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await WorkspaceApi.delete(deletingWorkspace.id);
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
      await invalidateSessions();
      if (deletingWorkspace.id === currentWorkspaceId) {
        selectSession(null);
      }
      setDeletingWorkspace(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** 绑定目录：用户取消选目录时后端返回 null，静默不提示 */
  const handleBindDirectory = async (workspaceId: number) => {
    try {
      await bindWorkspaceDirectory(queryClient, workspaceId);
    } catch (e) {
      handleError(e);
    }
  };

  const handleRenameSession = async () => {
    const title = sessionTitle.trim();
    if (!renamingSession || !title || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await SessionApi.rename(renamingSession.id, title);
      await invalidateSessions();
      setRenamingSession(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!deletingSession || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await SessionApi.delete(deletingSession.id);
      await invalidateSessions();
      if (deletingSession.id === selectedSessionId) {
        selectSession(null);
      }
      setDeletingSession(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const navEntries = [
    {
      icon: <Bot size={16} />,
      label: t("chat:sidebar.experts"),
      onClick: () => navigate("/module/ai/experts"),
    },
    {
      icon: <Clock size={16} />,
      label: t("chat:sidebar.automation"),
      onClick: () => navigate("/module/ai/automation"),
    },
    {
      icon: <FileText size={16} />,
      label: t("chat:sidebar.library"),
      onClick: () => navigate("/module/ai/library"),
    },
  ];

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border/50 bg-card transition-[width] duration-200",
        collapsed ? "w-12" : "w-64",
      )}
    >
      {/* macOS 顶部 Logo（Windows 标题在 TopBar） */}
      {isMac && (
        <div
          className={cn(
            "flex h-9 shrink-0 items-center border-b border-border/50",
            collapsed ? "justify-center" : "gap-2 px-3",
          )}
        >
          <img src="./pc_logo.svg" alt="mirror" className="h-5 w-5 shrink-0" />
          {!collapsed && (
            <span className="truncate text-sm font-semibold tracking-tight text-foreground select-none">
              {"mirror"}
            </span>
          )}
        </div>
      )}

      {/* 功能入口区 */}
      <div className="flex flex-col gap-1 p-2">
        <Button
          size="sm"
          className={cn(
            "w-full justify-start hover:bg-primary hover:text-primary-foreground",
            collapsed && "justify-center px-0",
          )}
          onClick={() => handleCreateSession(currentWorkspaceId)}
        >
          <Plus className="h-4 w-4" />
          {!collapsed && t("chat:sidebar.newTask")}
        </Button>
        {navEntries.map((entry) => (
          <SidebarNavButton
            key={entry.label}
            collapsed={collapsed}
            icon={entry.icon}
            label={entry.label}
            onClick={entry.onClick}
          />
        ))}
      </div>

      {/* 空间分组任务树 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setSpacesOpen((open) => !open)}
        >
          {spacesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t("chat:sidebar.spaces")} ({workspaces.length})
        </button>
        {spacesOpen &&
          workspaces.map((workspace) => (
            <WorkspaceGroup
              key={workspace.id}
              workspace={workspace}
              collapsed={collapsed}
              collapsedGroup={collapsedSpaces[workspace.id] ?? false}
              sessions={sessions.filter((s) => s.workspaceId === workspace.id)}
              selectedSessionId={selectedSessionId}
              onToggleGroup={() =>
                setCollapsedSpaces((prev) => ({
                  ...prev,
                  [workspace.id]: !(prev[workspace.id] ?? false),
                }))
              }
              onSelect={selectSession}
              onCreate={() => handleCreateSession(workspace.id)}
              onManageRename={() =>
                setWorkspaceDialog({ mode: "rename", name: workspace.name })
              }
              onManageDelete={() => setDeletingWorkspace(workspace)}
              onManageBind={() => handleBindDirectory(workspace.id)}
              onManageUnbind={() => setUnbindingWorkspace(workspace)}
              onSessionRename={(session) => {
                setSessionTitle(session.title);
                setRenamingSession(session);
              }}
              onSessionDelete={(session) => setDeletingSession(session)}
            />
          ))}
      </div>

      {/* 底部折叠按钮 */}
      <div className="border-t border-border/50 p-2">
        <SidebarNavButton
          collapsed={collapsed}
          icon={
            collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />
          }
          label={
            collapsed
              ? t("layout:sidebar.expand")
              : t("layout:sidebar.collapse")
          }
          onClick={toggleSidebar}
        />
      </div>

      {/* 空间新建/重命名对话框 */}
      <Dialog
        open={workspaceDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWorkspaceDialog(null);
          }
        }}
      >
        <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {workspaceDialog?.mode === "create"
                ? t("chat:newWorkspace")
                : t("chat:renameWorkspace")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name">{t("ai:provider.name")}</Label>
            <Input
              id="workspace-name"
              value={workspaceDialog?.name ?? ""}
              onChange={(e) =>
                setWorkspaceDialog((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleWorkspaceDialogSubmit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWorkspaceDialog(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleWorkspaceDialogSubmit} disabled={submitting}>
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 任务重命名对话框 */}
      <Dialog
        open={renamingSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingSession(null);
          }
        }}
      >
        <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("chat:renameSession")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="session-title">{t("ai:provider.name")}</Label>
            <Input
              id="session-title"
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRenameSession();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingSession(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleRenameSession} disabled={submitting}>
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnbindDirectoryDialog
        workspace={unbindingWorkspace}
        onOpenChange={(open) => {
          if (!open) {
            setUnbindingWorkspace(null);
          }
        }}
        onUnbound={() => setUnbindingWorkspace(null)}
      />

      <AlertDialog
        open={deletingWorkspace !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingWorkspace(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:deleteWorkspace")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingWorkspace
                ? `${deletingWorkspace.name} · ${t("chat:deleteWorkspaceDesc")}`
                : t("chat:deleteWorkspaceDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteWorkspace}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deletingSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingSession(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:deleteSession")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingSession
                ? `${deletingSession.title} · ${t("chat:deleteSessionDesc")}`
                : t("chat:deleteSessionDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSession}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

interface SidebarNavButtonProps {
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

/** 侧边栏入口行（展开=图标+文字，折叠=仅图标+Tooltip） */
function SidebarNavButton({
  collapsed,
  icon,
  label,
  onClick,
}: SidebarNavButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-8 cursor-pointer items-center rounded-md text-sm text-muted-foreground transition-colors duration-200 hover:bg-primary-subtle hover:text-primary",
              collapsed ? "justify-center" : "gap-2.5 px-3",
            )}
            onClick={onClick}
          >
            <span className="shrink-0">{icon}</span>
            {!collapsed && <span className="truncate">{label}</span>}
          </div>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right">
            <p>{label}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}

interface WorkspaceGroupProps {
  workspace: WorkspaceRecord;
  collapsed: boolean;
  collapsedGroup: boolean;
  sessions: SessionRecord[];
  selectedSessionId: number | null;
  onToggleGroup: () => void;
  onSelect: (sessionId: number) => void;
  onCreate: () => void;
  onManageRename: () => void;
  onManageDelete: () => void;
  onManageBind: () => void;
  onManageUnbind: () => void;
  onSessionRename: (session: SessionRecord) => void;
  onSessionDelete: (session: SessionRecord) => void;
}

/** 单空间分组：标题行（折叠钮 + 空间名 + 悬停 +/...）+ 任务列表 */
function WorkspaceGroup({
  workspace,
  collapsed,
  collapsedGroup,
  sessions,
  selectedSessionId,
  onToggleGroup,
  onSelect,
  onCreate,
  onManageRename,
  onManageDelete,
  onManageBind,
  onManageUnbind,
  onSessionRename,
  onSessionDelete,
}: WorkspaceGroupProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <div className="group/workspace mt-1">
      <div className="relative flex items-center">
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pl-1 text-left text-sm text-foreground/90 hover:bg-primary-subtle/60",
            collapsed && "justify-center",
          )}
          onClick={onToggleGroup}
          title={workspace.name}
        >
          {collapsedGroup ? (
            <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          )}
          {!collapsed && (
            <span className="truncate">{workspace.name}</span>
          )}
        </button>
        {!collapsed && (
          <div className="absolute right-0 hidden items-center group-hover/workspace:flex">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              onClick={onCreate}
              aria-label={t("chat:sidebar.newTaskInWorkspace")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <WorkspaceMenu
              disabled={false}
              workspace={workspace}
              onCreate={onCreate}
              onRename={onManageRename}
              onDelete={onManageDelete}
              onBindDirectory={onManageBind}
              onUnbindDirectory={onManageUnbind}
            />
          </div>
        )}
      </div>
      {!collapsedGroup && !collapsed && (
        <div className="ml-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t("chat:sidebar.emptyTask")}
            </p>
          ) : (
            sessions.map((session) => (
              <TaskTreeItem
                key={session.id}
                session={session}
                selected={session.id === selectedSessionId}
                onSelect={() => onSelect(session.id)}
                onRename={() => onSessionRename(session)}
                onDelete={() => onSessionDelete(session)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface TaskTreeItemProps {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** 任务项（基础版）：标题 + 相对时间 + 选中态；悬停菜单/绿点/置顶在 Task 6 强化 */
function TaskTreeItem({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: TaskTreeItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const locale = getDateFnsLocale();
  const timeText = formatDistanceToNow(
    new Date(session.lastMessageAt ?? session.updatedAt),
    { addSuffix: true, locale },
  );

  return (
    <div
      className={cn(
        "group/task relative mb-0.5 rounded-md",
        selected
          ? "bg-primary-subtle text-primary"
          : "hover:bg-primary-subtle/60",
      )}
    >
      <button
        type="button"
        className="block w-full py-1.5 pl-2 pr-8 text-left"
        onClick={onSelect}
      >
        <span className="block truncate text-sm" title={session.title}>
          {session.title}
        </span>
        <span className="block text-xs text-muted-foreground">{timeText}</span>
      </button>
      <div className="absolute right-1 top-1.5 opacity-0 transition-opacity group-hover/task:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 focus:opacity-100"
              aria-label={t("common:operation")}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="rounded-lg border border-border/50 shadow-lg"
          >
            <DropdownMenuItem onClick={onRename}>
              <Pencil className="mr-2 h-4 w-4" />
              {t("chat:renameSession")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("chat:deleteSession")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

（Task 6 会把 `TaskTreeItem` 升级为完整版——悬停三快捷图标、绿点、Pin 标、完整上下文菜单；并给 `WorkspaceGroup`/`AiSidebar` 传入 pin/archive/openDirectory 回调。本任务先用 import 预留 `Pin`/`Archive` 图标会导致 lint unused——若 typecheck/lint 报 unused import，先从 import 列表移除 `Pin`、`Archive`、`FolderInput`、`FolderMinus`、`FolderPlus`，Task 6 再按需加回。）

- [ ] **Step 5: 重写路由**

`src-react/routes/index.tsx` 整文件替换为：

```tsx
/**
 * 路由配置：登录 + AI 模块（标准侧边栏布局）
 */

import { lazy, Suspense } from "react";
import { createHashRouter, Navigate } from "react-router-dom";

import MainLayout from "@/components/layout/MainLayout";
import LoginView from "@/domains/user/views/LoginView";

// 懒加载其他模块
// AI 服务商/模型管理
const ProviderSettingsView = lazy(
  () => import("@/domains/ai/provider/views/ProviderSettingsView"),
);
// AI 对话主界面
const ChatView = lazy(() => import("@/domains/ai/chat/views/ChatView"));
// AI 标准侧边栏布局
const AiLayout = lazy(() => import("@/domains/ai/layout/views/AiLayout"));

// 加载中组件
function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-gray-500">加载中...</div>
    </div>
  );
}

// 包装懒加载组件
function LazyWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingFallback />}>{children}</Suspense>;
}

export const router = createHashRouter([
  {
    path: "/",
    element: <Navigate to="/module/ai" replace />,
  },
  {
    path: "/login",
    element: <LoginView />,
  },
  {
    path: "/module",
    element: <MainLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="/module/ai" replace />,
      },
      {
        path: "ai",
        element: (
          <LazyWrapper>
            <AiLayout />
          </LazyWrapper>
        ),
        children: [
          {
            index: true,
            element: (
              <LazyWrapper>
                <ChatView />
              </LazyWrapper>
            ),
          },
          {
            path: "providers",
            element: (
              <LazyWrapper>
                <ProviderSettingsView />
              </LazyWrapper>
            ),
          },
        ],
      },
    ],
  },
]);

export default router;
```

（LoadingFallback 的 i18n 化在 Task 9 统一处理。）

- [ ] **Step 6: MainLayout 删 Sidebar**

修改 `src-react/components/layout/MainLayout.tsx`：
- 删 `import Sidebar from "./Sidebar";`
- 删 `sidebarCollapsed` 的 `useLocalStorage`（`useLocalStorage` import 若无他用一并删）
- 删 `sidebarWidth`/`marginLeft` 变量，`main-content` 的 `style` 只留 `{ marginTop: shouldShowNav ? 36 : 0, transition: "margin-top 0.2s" }`
- `<Sidebar ... />` 渲染删除（`shouldShowNav &&` 块内只留 `<TopBar />`）

- [ ] **Step 7: ChatView 切 listAll + 删 SessionSidebar**

修改 `src-react/domains/ai/chat/views/ChatView.tsx`：

7a. 删 `import SessionSidebar from "../components/SessionSidebar";`

7b. `sessionsQuery` 替换为：

```ts
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => SessionApi.listAll(),
  });
```

7c. 删 `activeWorkspaceId` 的 `useState` 与首启自动选中的 `useEffect`（83-87 行），改为派生：

```ts
  // 当前空间 = 选中任务所属空间，无选中取第一个（侧边栏分组树已展示全部空间）
  const activeWorkspace =
    workspaces.find(
      (workspace) => workspace.id === selectedSession?.workspaceId,
    ) ?? workspaces[0] ?? null;
```

（`selectedSession` 的 find 改从全量 `sessions` 查找，删除 `handleSelectWorkspace` 与传给 SessionSidebar 的 props。）

7d. `return` 块替换为：

```tsx
  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：已绑定工作空间目录时展示路径 chip（重绑/解绑入口） */}
      {activeWorkspace?.directoryPath && (
        <WorkspacePathChip workspace={activeWorkspace} />
      )}
      {needsSetup ? (
        <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />
      ) : selectedSession ? (
        <ChatPane
          key={selectedSession.id}
          session={selectedSession}
          workspace={activeWorkspace}
          hasModel={Boolean(
            selectedSession.currentModelId ?? activeWorkspace?.defaultModelId,
          )}
          onOpenSettings={(target) =>
            navigate(
              target === "providers"
                ? PROVIDERS_ROUTE
                : target === "assistants"
                  ? ASSISTANTS_ROUTE
                  : MCP_ROUTE,
            )
          }
        />
      ) : (
        <MessageList sessionId={null} />
      )}
    </div>
  );
```

7e. 常量区改：`const ASSISTANTS_ROUTE = "/module/ai/experts";`、`const MCP_ROUTE = "/module/ai/experts";`（experts 路由 Task 8 上线；ChatView 内 `useSearchParams`/`selectedSessionId` 已在 Task 4 就绪）

- [ ] **Step 8: 删除文件与引用清理**

```bash
git rm src-react/components/layout/Sidebar.tsx \
  src-react/domains/ai/chat/components/SessionSidebar.tsx \
  src-react/i18n/locales/zh-CN/welcome.json \
  src-react/i18n/locales/en-US/welcome.json \
  src-react/i18n/locales/zh-CN/system-config.json \
  src-react/i18n/locales/en-US/system-config.json
git rm -r src-react/domains/welcome src-react/domains/system-config
```

- `src-react/i18n/index.ts`：删 4 个 import（zhSystemConfig/zhWelcome/enSystemConfig/enWelcome）与 resources 中对应条目；`ns` 数组删 `"system-config"`、`"welcome"`
- `src-react/i18n/locales/{zh-CN,en-US}/layout.json`：删 `sidebar.welcome`、`sidebar.ai`、`sidebar.systemConfig` 三 key
- `src-react/domains/user/views/LoginView.tsx:85,180`：`navigate("/module/welcome", ...)` → `navigate("/module/ai", ...)`

- [ ] **Step 9: i18n 新增 key（chat 命名空间，zh/en 同步）**

`zh-CN/chat.json` 顶层新增（en-US 对应：New Task / Experts·Skills·Connectors / Automation / Library / Spaces / New task in this space / No tasks yet）：

```json
"sidebar": {
  "newTask": "新建任务",
  "experts": "专家·技能·连接器",
  "automation": "自动化",
  "library": "资料库",
  "spaces": "空间",
  "newTaskInWorkspace": "在此空间新建任务",
  "emptyTask": "暂无任务"
},
```

同时删除旧内嵌搜索相关 key `search.placeholder`/`search.noResults`（搜索框随 SessionSidebar 移除，Task 7 加全局搜索新 key）。

- [ ] **Step 10: typecheck + lint + test**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: 全绿（重点确认无残留 SessionSidebar/welcome/system-config 引用）

- [ ] **Step 11: 手动验证**

Run: `npm run dev`
验证清单：
1. 登录后直达 `/module/ai`，无系统菜单，新侧边栏展示功能入口 + 空间分组
2. 点任务 → `?session=` 生效、聊天区切换；多空间任务分组正确
3. 空间行悬停出 + 与 ... 菜单；新建/重命名/删除/绑定目录可用
4. 顶部「新建任务」落在当前空间；底部折叠按钮收成窄条且刷新保持
5. `/module/ai/providers` 可从模型菜单进入且侧边栏常驻

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(ai): 标准侧边栏布局（AiLayout 分组树）并移除系统菜单与 welcome/system-config"
```

---

### Task 6: 任务项交互强化（悬停快捷/上下文菜单/置顶/归档/绿点/打开文件夹）

**Files:**
- Modify: `src-react/domains/ai/layout/components/AiSidebar.tsx`（TaskTreeItem 升级 + 回调）
- Modify: `src-react/domains/ai/api/workspace.api.ts`（openDirectory）

**Interfaces:**
- Consumes: Task 2 的 `SessionApi.pin/archive`、`workspace:openDirectory` IPC；`useChatStore.isStreaming`
- Produces: 最终形态任务项（悬停三快捷图标、流式绿点、Pin 标、完整菜单）

- [ ] **Step 1: WorkspaceApi.openDirectory**

`src-react/domains/ai/api/workspace.api.ts` 的 WorkspaceApi 类加：

```ts
  /** 打开空间绑定目录（任务上下文菜单「打开文件夹」） */
  static async openDirectory(workspaceId: number): Promise<void> {
    await invoke<void>("workspace:openDirectory", workspaceId);
  }
```

- [ ] **Step 2: AiSidebar 加 pin/archive/openDirectory 回调**

`AiSidebar.tsx` 组件内加（`handleDeleteSession` 后）：

```ts
  const handlePin = async (session: SessionRecord) => {
    try {
      await SessionApi.pin(session.id, !session.pinnedAt);
      await invalidateSessions();
    } catch (e) {
      handleError(e);
    }
  };

  const handleUnarchive = async (sessionId: number) => {
    try {
      await SessionApi.archive(sessionId, false);
      await invalidateSessions();
    } catch (e) {
      handleError(e);
    }
  };

  /** 归档后 5s 内可撤销（sonner action）；归档当前任务同步清空选中 */
  const handleArchive = async (session: SessionRecord) => {
    try {
      await SessionApi.archive(session.id, true);
      await invalidateSessions();
      if (session.id === selectedSessionId) {
        selectSession(null);
      }
      toast.success(t("chat:task.archived"), {
        duration: 5000,
        action: {
          label: t("chat:task.undo"),
          onClick: () => void handleUnarchive(session.id),
        },
      });
    } catch (e) {
      handleError(e);
    }
  };

  const handleOpenFolder = async (workspaceId: number) => {
    try {
      await WorkspaceApi.openDirectory(workspaceId);
    } catch (e) {
      handleError(e);
    }
  };
```

`WorkspaceGroupProps` 接口加三行（`onSessionDelete` 后）：

```ts
  onSessionPin: (session: SessionRecord) => void;
  onSessionArchive: (session: SessionRecord) => void;
  onOpenFolder: () => void;
```

`WorkspaceGroup` 解构参数与解构体同步加 `onSessionPin`/`onSessionArchive`/`onOpenFolder`，任务列表渲染处 `TaskTreeItem` 传参改为：

```tsx
              <TaskTreeItem
                key={session.id}
                session={session}
                workspaceDirectoryPath={workspace.directoryPath}
                selected={session.id === selectedSessionId}
                onSelect={() => onSelect(session.id)}
                onRename={() => onSessionRename(session)}
                onDelete={() => onSessionDelete(session)}
                onPin={() => onSessionPin(session)}
                onArchive={() => onSessionArchive(session)}
                onOpenFolder={onOpenFolder}
              />
```

`AiSidebar` 渲染 `WorkspaceGroup` 处补传：`onSessionPin={(s) => void handlePin(s)}`、`onSessionArchive={(s) => void handleArchive(s)}`、`onOpenFolder={() => void handleOpenFolder(workspace.id)}`、`workspaceDirectoryPath={workspace.directoryPath}`（`WorkspaceGroup` 内已有 `workspace`，directoryPath 由其直接下传，无需单独 prop）。

- [ ] **Step 3: TaskTreeItem 升级为最终版**

替换 `AiSidebar.tsx` 中的 `TaskTreeItem`（保留基础版的位置，新增 props）：

```tsx
interface TaskTreeItemProps {
  session: SessionRecord;
  workspaceDirectoryPath?: string;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onPin: () => void;
  onArchive: () => void;
  onOpenFolder: () => void;
}

/** 任务项：标题+相对时间；悬停出 .../归档/置顶 快捷钮；流式中显示绿点 */
function TaskTreeItem({
  session,
  workspaceDirectoryPath,
  selected,
  onSelect,
  onRename,
  onDelete,
  onPin,
  onArchive,
  onOpenFolder,
}: TaskTreeItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const locale = getDateFnsLocale();
  const timeText = formatDistanceToNow(
    new Date(session.lastMessageAt ?? session.updatedAt),
    { addSuffix: true, locale },
  );
  // 绿点：该任务流式进行中（chat.store 前端派生）
  const streaming = useChatStore((s) => Boolean(s.isStreaming[session.id]));
  const pinned = Boolean(session.pinnedAt);

  const quickActions = (
    <div className="absolute right-1 top-1.5 flex items-center opacity-0 transition-opacity group-hover/task:opacity-100">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 focus:opacity-100"
            aria-label={t("common:operation")}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="mr-2 h-4 w-4" />
            {t("chat:renameSession")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPin}>
            <Pin className="mr-2 h-4 w-4" />
            {pinned ? t("chat:task.unpin") : t("chat:task.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>
            <Archive className="mr-2 h-4 w-4" />
            {t("chat:task.archive")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onOpenFolder}
            disabled={!workspaceDirectoryPath}
          >
            <FolderInput className="mr-2 h-4 w-4" />
            {t("chat:task.openFolder")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => toast.info(t("chat:task.comingSoon"))}>
            <Share2 className="mr-2 h-4 w-4" />
            {t("chat:task.share")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toast.info(t("chat:task.comingSoon"))}>
            <ListChecks className="mr-2 h-4 w-4" />
            {t("chat:task.batchOps")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("chat:deleteSession")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
        onClick={onArchive}
        aria-label={t("chat:task.archive")}
      >
        <Archive className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
        onClick={onPin}
        aria-label={pinned ? t("chat:task.unpin") : t("chat:task.pin")}
      >
        {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );

  return (
    <div
      className={cn(
        "group/task relative mb-0.5 rounded-md",
        selected
          ? "bg-primary-subtle text-primary"
          : "hover:bg-primary-subtle/60",
      )}
    >
      <button
        type="button"
        className="block w-full py-1.5 pl-2 pr-24 text-left"
        onClick={onSelect}
      >
        <span className="flex items-center gap-1">
          {pinned && <Pin className="h-3 w-3 shrink-0" />}
          <span className="truncate text-sm" title={session.title}>
            {session.title}
          </span>
          {streaming && (
            <span className="ml-auto mr-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{timeText}</span>
      </button>
      {quickActions}
    </div>
  );
}
```

import 调整：加 `Archive`、`Pin`、`PinOff`、`Share2`、`ListChecks`、`FolderInput`（lucide-react）。绿点用 `bg-emerald-500`：属"活跃进行中"语义状态色（与 `destructive` 同类），非主题主色，跨主题保持一致的辨识度。

- [ ] **Step 4: i18n 新增 key（chat 命名空间，zh/en 同步）**

zh-CN：

```json
"task": {
  "pin": "置顶",
  "unpin": "取消置顶",
  "archive": "归档",
  "archived": "已归档",
  "undo": "撤销",
  "openFolder": "打开文件夹",
  "share": "分享任务",
  "batchOps": "批量操作",
  "comingSoon": "功能开发中"
},
```

en-US：Pin to top / Unpin / Archive / Archived / Undo / Open Folder / Share Task / Batch Actions / Coming soon

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误（含 unused import 清理）

- [ ] **Step 6: 手动验证**

Run: `npm run dev`
验证清单：
1. 悬停任务出三个快捷图标；`...` 菜单七项齐全（打开文件夹在未绑定目录时禁用）
2. 置顶 → 任务带 Pin 标移到空间内最前；再点取消
3. 归档 → 立即消失，toast 5 秒内点「撤销」恢复；归档当前任务时聊天区回空态
4. 发送消息（流式期间）任务行出现绿点，结束后消失
5. 「打开文件夹」打开空间绑定目录（先绑定一个目录）

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/layout/components/AiSidebar.tsx src-react/domains/ai/api/workspace.api.ts src-react/i18n/locales
git commit -m "feat(ai): 任务悬停快捷操作/上下文菜单/置顶归档/流式绿点"
```

---

### Task 7: 顶栏注入 + 全局搜索 Modal + 筛选 Popover

**Files:**
- Create: `src-react/domains/ai/layout/components/AiTopbarActions.tsx`
- Create: `src-react/domains/ai/layout/components/GlobalSearchDialog.tsx`
- Create: `src-react/domains/ai/layout/components/FilterPopover.tsx`
- Modify: `src-react/components/layout/TopBar.tsx`（加 leftSlot）
- Modify: `src-react/components/layout/MainLayout.tsx`（注入）

**Interfaces:**
- Consumes: Task 2 `SessionApi.searchByTitle`、`WorkspaceApi.list`；Task 5 `useAiUiStore`
- Produces: 顶栏三按钮（折叠/搜索/筛选）；筛选实时作用于侧边栏（Task 5 已接线 `timeFilter`）

- [ ] **Step 1: TopBar 加 leftSlot**

`TopBar.tsx` 改：

```tsx
interface TopBarProps {
  /** 左侧插槽（AI 路由下注入折叠/搜索/筛选按钮） */
  leftSlot?: React.ReactNode;
}

export default function TopBar({ leftSlot }: TopBarProps) {
```

布局改动：外层 `justify-end`（mac）/`justify-between`（win）统一为 `justify-between`；左侧区域：

```tsx
      {/* 左侧：Logo（Windows）+ 插槽；macOS 让出红绿灯区域 */}
      <div
        className={`flex items-center gap-1 ${isMac ? "pl-20" : "pl-2"}`}
        style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
      >
        {!isMac && (
          <div className="flex items-center gap-2 mr-1">
            <img src="./pc_logo.svg" alt="mirror" className="w-5 h-5" />
            <span className="text-sm font-semibold text-foreground tracking-tight select-none">
              {"mirror"}
            </span>
          </div>
        )}
        {leftSlot}
      </div>
```

（右侧主题/语言/用户菜单区域不动。）

- [ ] **Step 2: 建 FilterPopover**

创建 `src-react/domains/ai/layout/components/FilterPopover.tsx`：

```tsx
/**
 * 顶栏筛选漏斗：时间维度四选一 + 一键重置（作用于侧边栏任务列表）
 */
import { useTranslation } from "react-i18next";
import { Check, Filter } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TimeFilter } from "../../chat/lib/session-list";
import { useAiUiStore } from "../../store/ai-ui.store";

const OPTIONS: Array<{ value: TimeFilter; labelKey: string }> = [
  { value: "all", labelKey: "chat:filter.all" },
  { value: "today", labelKey: "chat:filter.today" },
  { value: "week", labelKey: "chat:filter.week" },
  { value: "month", labelKey: "chat:filter.month" },
];

export default function FilterPopover() {
  const { t } = useTranslation(["chat", "common"]);
  const timeFilter = useAiUiStore((s) => s.timeFilter);
  const setTimeFilter = useAiUiStore((s) => s.setTimeFilter);
  const resetFilter = useAiUiStore((s) => s.resetFilter);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 w-7 p-0",
            timeFilter !== "all" && "text-primary",
          )}
          aria-label={t("chat:filter.title")}
        >
          <Filter className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 rounded-lg border border-border/50 shadow-lg">
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          {t("chat:filter.title")}
        </p>
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-primary-subtle hover:text-primary"
            onClick={() => setTimeFilter(option.value)}
          >
            {t(option.labelKey)}
            {timeFilter === option.value && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full text-muted-foreground"
          onClick={resetFilter}
        >
          {t("chat:filter.reset")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: 建 GlobalSearchDialog**

创建 `src-react/domains/ai/layout/components/GlobalSearchDialog.tsx`：

```tsx
/**
 * 全局搜索任务：居中 Modal，空关键词展示最近任务，输入实时过滤（300ms 防抖）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import WorkspaceApi from "../../api/workspace.api";
import SessionApi from "../../api/session.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { useAiUiStore } from "../../store/ai-ui.store";

const SEARCH_DEBOUNCE_MS = 300;

export default function GlobalSearchDialog() {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const searchOpen = useAiUiStore((s) => s.searchOpen);
  const setSearchOpen = useAiUiStore((s) => s.setSearchOpen);
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(keyword.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [keyword]);

  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
    enabled: searchOpen,
  });
  const resultsQuery = useQuery({
    queryKey: ["session-search", debounced],
    queryFn: () => SessionApi.searchByTitle(debounced),
    enabled: searchOpen,
  });
  const results = resultsQuery.data ?? [];
  const workspaceName = (id: number) =>
    workspacesQuery.data?.find((w) => w.id === id)?.name ?? "";

  const handleSelect = (sessionId: number) => {
    setSearchOpen(false);
    setKeyword("");
    navigate(`/module/ai?session=${sessionId}`, { replace: true });
  };

  return (
    <Dialog
      open={searchOpen}
      onOpenChange={(open) => {
        if (!open) {
          setSearchOpen(false);
        }
      }}
    >
      <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="sr-only">
            {t("chat:search.placeholder")}
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("chat:search.placeholder")}
        />
        <div className="max-h-72 overflow-y-auto">
          <p className="px-1 pb-1 text-xs text-muted-foreground">
            {debounced ? t("common:search") : t("chat:search.recent")}
          </p>
          {resultsQuery.isPending ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t("common:loading")}
            </p>
          ) : resultsQuery.error ? (
            <p className="px-2 py-4 text-sm text-destructive">
              {mapIpcError(resultsQuery.error)}
            </p>
          ) : results.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t("chat:search.noResults")}
            </p>
          ) : (
            results.map((session) => (
              <button
                key={session.id}
                type="button"
                className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-primary-subtle/60"
                onClick={() => handleSelect(session.id)}
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{session.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {workspaceName(session.workspaceId)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 建 AiTopbarActions**

创建 `src-react/domains/ai/layout/components/AiTopbarActions.tsx`：

```tsx
/**
 * 顶栏 AI 动作区：侧边栏折叠 / 全局搜索 / 时间筛选
 */
import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAiUiStore } from "../../store/ai-ui.store";
import FilterPopover from "./FilterPopover";
import GlobalSearchDialog from "./GlobalSearchDialog";

export default function AiTopbarActions() {
  const { t } = useTranslation(["layout"]);
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAiUiStore((s) => s.toggleSidebar);
  const setSearchOpen = useAiUiStore((s) => s.setSearchOpen);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={toggleSidebar}
        aria-label={
          collapsed ? t("layout:sidebar.expand") : t("layout:sidebar.collapse")
        }
      >
        {collapsed ? (
          <PanelLeftOpen className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => setSearchOpen(true)}
        aria-label={t("layout:sidebar.search")}
      >
        <Search className="h-4 w-4" />
      </Button>
      <FilterPopover />
      <GlobalSearchDialog />
    </>
  );
}
```

- [ ] **Step 5: MainLayout 注入**

`MainLayout.tsx` 加 import 与注入：

```tsx
import AiTopbarActions from "@/domains/ai/layout/components/AiTopbarActions";
```

```tsx
  const isAiRoute = location.pathname.startsWith("/module/ai");
```

`<TopBar />` 改为：

```tsx
          <TopBar leftSlot={isAiRoute ? <AiTopbarActions /> : undefined} />
```

- [ ] **Step 6: i18n key（zh/en 同步）**

`chat.json`：search 对象重写为 `"search": { "placeholder": "搜索任务", "recent": "最近任务", "noResults": "没有匹配的任务" }`（en：Search tasks / Recent tasks / No matching tasks）；新增 `"filter": { "title": "筛选时间", "all": "全部时间", "today": "今天", "week": "最近 7 天", "month": "最近 30 天", "reset": "重置筛选条件" }`（en：Filter by time / All time / Today / Last 7 days / Last 30 days / Reset filters）。`layout.json` 的 `sidebar` 加 `"search": "搜索"`（en：Search）。

- [ ] **Step 7: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误

- [ ] **Step 8: 手动验证**

Run: `npm run dev`
验证清单：
1. `/module/ai` 下顶栏左侧出现折叠/搜索/漏斗三钮（红绿灯右侧）；`/login` 无此区域
2. 搜索 Modal：打开即见最近任务；输入关键词 300ms 后过滤；点击结果跳转并选中
3. 筛选：选「今天」侧边栏只剩今天活跃任务、漏斗高亮；重置恢复；刷新后筛选重置（内存态）

- [ ] **Step 9: Commit**

```bash
git add src-react/domains/ai/layout/components src-react/components/layout src-react/i18n/locales
git commit -m "feat(ai): 顶栏折叠/搜索/筛选注入与全局任务搜索、时间筛选"
```

---

### Task 8: ExpertsView / LibraryView / AutomationView + 路由挂载

**Files:**
- Create: `src-react/domains/ai/experts/views/ExpertsView.tsx`
- Create: `src-react/domains/ai/library/views/LibraryView.tsx`
- Create: `src-react/domains/ai/automation/views/AutomationView.tsx`
- Modify: `src-react/routes/index.tsx`（挂三条子路由）
- Modify: `src-react/domains/ai/chat/components/PlusMenu.tsx:41`（`ASSISTANTS_ROUTE = "/module/ai/experts"`）
- Modify: `src-react/domains/ai/provider/views/ProviderSettingsView.tsx:49`（`MCP_ROUTE = "/module/ai/experts"`）

**Interfaces:**
- Consumes: 现有 `AssistantSettingsView`、`McpSettingsView`（原样嵌入）、`skill:openDir` IPC
- Produces: `/module/ai/experts|library|automation` 三路由（侧边栏入口与 ChatView/PlusMenu/ProviderSettingsView 跳转的落点）

- [ ] **Step 1: 建 ExpertsView**

创建 `src-react/domains/ai/experts/views/ExpertsView.tsx`：

```tsx
/**
 * 专家·技能·连接器统一管理：Tab 切换（专家=助手预设 / 技能=本地技能目录 / 连接器=MCP）
 * 专家与连接器 Tab 复用既有设置视图（自带 PageTitle 作为区块标题）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Bot, Plug, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { invoke } from "@/lib/ipc";
import AssistantSettingsView from "../../assistant/views/AssistantSettingsView";
import McpSettingsView from "../../mcp/views/McpSettingsView";

type ExpertTab = "assistants" | "skills" | "connectors";

export default function ExpertsView() {
  const { t } = useTranslation(["chat", "common"]);
  const [tab, setTab] = useState<ExpertTab>("assistants");

  const tabs: Array<{ value: ExpertTab; icon: React.ReactNode; label: string }> = [
    {
      value: "assistants",
      icon: <Bot className="h-4 w-4" />,
      label: t("chat:experts.tabAssistants"),
    },
    {
      value: "skills",
      icon: <Sparkles className="h-4 w-4" />,
      label: t("chat:experts.tabSkills"),
    },
    {
      value: "connectors",
      icon: <Plug className="h-4 w-4" />,
      label: t("chat:experts.tabConnectors"),
    },
  ];

  const openSkillDir = async () => {
    try {
      await invoke("skill:openDir");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-1 border-b border-border/50">
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              tab === item.value
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(item.value)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
      {tab === "assistants" && <AssistantSettingsView />}
      {tab === "skills" && (
        <Card className="rounded-lg border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>{t("chat:experts.tabSkills")}</CardTitle>
            <CardDescription>{t("chat:experts.skillsDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void openSkillDir()} className="hover:bg-primary-hover">
              {t("chat:experts.openSkillDir")}
            </Button>
          </CardContent>
        </Card>
      )}
      {tab === "connectors" && <McpSettingsView />}
    </div>
  );
}
```

- [ ] **Step 2: 建 LibraryView**

创建 `src-react/domains/ai/library/views/LibraryView.tsx`（完整骨架、静态空数据）：

```tsx
/**
 * 资料库（占位骨架）：搜索框 + 最近/本地产物 chips + 我的资料/团队空间可折叠分组。
 * 内容管理为占位（按钮 toast 开发中），数据接入后续迭代。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  Plus,
  Share2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import PageTitle from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mapIpcError } from "../../chat/lib/error-message";

export default function LibraryView() {
  const { t } = useTranslation(["chat", "common"]);
  const [keyword, setKeyword] = useState("");
  const [mineOpen, setMineOpen] = useState(true);
  const [teamOpen, setTeamOpen] = useState(true);

  const comingSoon = () => {
    toast.info(t("chat:task.comingSoon"));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <PageTitle title={t("chat:library.title")}>
        <Button
          variant="ghost"
          size="sm"
          className="text-white/90 hover:bg-white/20 hover:text-white"
          onClick={comingSoon}
          aria-label={t("chat:library.export")}
        >
          <Share2 className="h-4 w-4" />
        </Button>
      </PageTitle>

      <div className="flex items-center gap-2 py-3">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("chat:library.searchPlaceholder")}
          className="max-w-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={comingSoon}
        >
          <Clock className="mr-1 h-4 w-4" />
          {t("chat:library.recent")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={comingSoon}
        >
          <FolderOpen className="mr-1 h-4 w-4" />
          {t("chat:library.localOutputs")}
        </Button>
      </div>

      <LibraryGroup
        open={mineOpen}
        title={t("chat:library.mine")}
        onToggle={() => setMineOpen((open) => !open)}
        onAdd={comingSoon}
        emptyText={t("chat:library.empty")}
      />
      <LibraryGroup
        open={teamOpen}
        title={t("chat:library.team")}
        onToggle={() => setTeamOpen((open) => !open)}
        onAdd={comingSoon}
        emptyText={t("chat:library.empty")}
      />
    </div>
  );
}

interface LibraryGroupProps {
  open: boolean;
  title: string;
  onToggle: () => void;
  onAdd: () => void;
  emptyText: string;
}

/** 资料分组：标题行（折叠钮 + + 按钮）+ 空态列表 */
function LibraryGroup({
  open,
  title,
  onToggle,
  onAdd,
  emptyText,
}: LibraryGroupProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1 py-1 text-sm font-medium text-foreground/90 hover:bg-primary-subtle/60"
          onClick={onToggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
          onClick={onAdd}
          aria-label={t("chat:library.add")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {open && (
        <div className="ml-2 mt-1 rounded-md border border-border/50 p-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="h-4 w-4" />
            {emptyText}
          </p>
        </div>
      )}
    </div>
  );
}
```

（若 `mapIpcError` 未用到则不 import。）

- [ ] **Step 3: 建 AutomationView**

创建 `src-react/domains/ai/automation/views/AutomationView.tsx`：

```tsx
/**
 * 自动化（占位页）：定时/触发式任务后续迭代
 */
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";

export default function AutomationView() {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Clock className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-base font-medium text-foreground">
        {t("chat:automation.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("chat:task.comingSoon")}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: 挂路由**

`src-react/routes/index.tsx`：lazy import 区加

```tsx
// 专家·技能·连接器统一管理
const ExpertsView = lazy(
  () => import("@/domains/ai/experts/views/ExpertsView"),
);
// 资料库（占位骨架）
const LibraryView = lazy(
  () => import("@/domains/ai/library/views/LibraryView"),
);
// 自动化（占位）
const AutomationView = lazy(
  () => import("@/domains/ai/automation/views/AutomationView"),
);
```

`ai` children 的 `providers` 后追加：

```tsx
          {
            path: "experts",
            element: (
              <LazyWrapper>
                <ExpertsView />
              </LazyWrapper>
            ),
          },
          {
            path: "library",
            element: (
              <LazyWrapper>
                <LibraryView />
              </LazyWrapper>
            ),
          },
          {
            path: "automation",
            element: (
              <LazyWrapper>
                <AutomationView />
              </LazyWrapper>
            ),
          },
```

- [ ] **Step 5: 旧路由跳转点改指 experts**

- `src-react/domains/ai/chat/components/PlusMenu.tsx:41`：`const ASSISTANTS_ROUTE = "/module/ai/experts";`
- `src-react/domains/ai/provider/views/ProviderSettingsView.tsx:49`：`const MCP_ROUTE = "/module/ai/experts";`

- [ ] **Step 6: i18n key（zh/en 同步）**

zh-CN/chat.json 新增：

```json
"experts": {
  "tabAssistants": "专家",
  "tabSkills": "技能",
  "tabConnectors": "连接器",
  "skillsDesc": "技能存放在本地技能目录中，可编辑 Markdown 技能文件",
  "openSkillDir": "打开技能目录"
},
"library": {
  "title": "资料库",
  "searchPlaceholder": "搜索",
  "recent": "最近",
  "localOutputs": "本地产物",
  "mine": "我的资料",
  "team": "团队空间",
  "empty": "还没有资料",
  "add": "新增资料",
  "export": "导出/分享"
},
"automation": {
  "title": "自动化"
},
```

en-US 对应：Experts/Skills/Connectors；"Skills live in the local skill directory as editable Markdown files" / "Open skill directory"；Library/Search/Recent/Local outputs/My files/Team spaces/No files yet/Add file/Export & share；Automation。

- [ ] **Step 7: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误

- [ ] **Step 8: 手动验证**

Run: `npm run dev`
验证清单：
1. 侧边栏「专家·技能·连接器」→ Tab 三块；专家/连接器 Tab 内容与原设置页一致；技能 Tab 打开技能目录按钮可用
2. 「资料库」页骨架完整：标题+导出按钮、搜索框、两个 chips、可折叠分组、+ 按钮 toast 开发中
3. 「自动化」占位页正常
4. ChatInput 加号菜单「专家预设」、ProviderSettingsView「MCP 管理」跳转都到 experts 页

- [ ] **Step 9: Commit**

```bash
git add src-react/domains/ai/experts src-react/domains/ai/library src-react/domains/ai/automation src-react/routes/index.tsx src-react/domains/ai/chat/components/PlusMenu.tsx src-react/domains/ai/provider/views/ProviderSettingsView.tsx src-react/i18n/locales
git commit -m "feat(ai): 专家/资料库/自动化视图与路由（占位功能就位）"
```

---

### Task 9: 收尾（LoadingFallback i18n / CLAUDE.md 版本 / 全量验证）

**Files:**
- Modify: `src-react/routes/index.tsx`（LoadingFallback）
- Modify: `CLAUDE.md`（数据库版本描述 1 → 5）

**Interfaces:**
- Consumes: Task 1-8 全部产出
- Produces: 无（收尾任务）

- [ ] **Step 1: LoadingFallback i18n 化**

`src-react/routes/index.tsx`：

```tsx
import { useTranslation } from "react-i18next";
```

```tsx
// 加载中组件
function LoadingFallback() {
  const { t } = useTranslation(["common"]);
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-muted-foreground">{t("common:loading")}</div>
    </div>
  );
}
```

- [ ] **Step 2: CLAUDE.md 数据库版本更新**

`CLAUDE.md` 中「当前数据库版本：1」改为「当前数据库版本：5」。

- [ ] **Step 3: 全量验证**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: 全绿

Run: `npm run dev`
完整回归清单（对照 spec）：
1. 登录直达 `/module/ai`；无系统菜单；welcome/system-config 路由 404 符合预期（已删）
2. 标准侧边栏：功能入口四项、空间分组树、任务项全部交互（选中/悬停/菜单/置顶/归档撤销/绿点/打开文件夹）
3. 顶栏三钮（折叠/搜索/筛选）仅 AI 路由出现；搜索 Modal、筛选 Popover 行为符合 spec §4
4. experts/library/automation 三页可用；providers 页侧边栏常驻
5. 重启应用验证 DB v4→v5 迁移（旧库含数据时旧任务正常展示、可置顶归档）
6. 中英文切换全页面无缺 key（i18next 控制台无 missing key 警告）

- [ ] **Step 4: Commit**

```bash
git add src-react/routes/index.tsx CLAUDE.md
git commit -m "chore(ai): LoadingFallback i18n 化与文档版本号收尾"
```
