# 项目计划模块 · 子系统 A：数据基础 + 多视图框架 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为项目计划模块落地视图持久化（planView 表）、planItem 字段扩展（日期/来源/P3/处理人多人指派）与前端筛选引擎、视图 Tab 框架。

**Architecture:** 独立 `planView` 表持久化「类型 + 筛选/排序/分组配置」（一项目多视图，懒播种默认两条）；数据获取维持全量拉取，筛选/排序/分组由前端纯函数引擎统一执行；PlanPane 改造为视图驱动（`?viewId=` 路由 + draft 未保存态 + 显式保存两个动作）；看板泛化分组依据（状态/优先级/处理人）。

**Tech Stack:** Electron 44 + Prisma 7 + better-sqlite3（主进程 entity+repo 模式）、React 19 + React Query + dnd-kit、Vitest（node:sqlite 测 SQL 脚本；vi.mock 测 repo；jsdom + testing-library 测组件）。

**Spec:** `docs/superpowers/specs/2026-09-14-plan-multi-view-design.md`

## Global Constraints

- 所有用户可见文案必须走 `t()`，zh-CN 与 en-US 的 `src-react/i18n/locales/*/project.json` 同步新增；key 用 camelCase。
- 颜色一律主题变量（`bg-primary-subtle` 等），禁止硬编码 `blue-*` 等；弹层 `border border-border/50 rounded-lg shadow-lg`；工具栏按钮 hover 三件套 `hover:border-primary/30 hover:bg-primary-subtle hover:text-primary`。
- Prettier：双引号、分号、tabWidth 2、printWidth 80、无尾随逗号；文件名 kebab-case。
- IPC 通道命名跟随现有惯例：小驼峰域前缀（`planView:*`，同 `planItem:*`）。
- 数据库迁移：新增 `electron/infrastructure/script/vN/upgrade-table.sql` + `Constants.DATABASE_VERSION` 递增；升级器按版本循环自动执行，无需注册。
- `npx prisma generate` 输出 `electron/generated/prisma` 受 git 跟踪，生成后随任务提交。
- 主进程错误直接 `throw new Error(中文可读消息)`（IPC 层转给前端 toast）。
- 验证命令：`npm run test`（vitest run）、`npm run typecheck`、`npm run lint`。

## 与 spec 的已批准偏差（探索代码后修正）

| spec 原文 | 实际采用 | 原因 |
|---|---|---|
| IPC 通道 `plan-view:*` | `planView:*` | 现有通道均小驼峰（`planItem:list`） |
| planView.id `@default(cuid())` String | `Int @default(autoincrement())` | 全库统一自增整型 id |
| 数据库版本 1→2 | **4→5**（v5） | CLAUDE.md 信息过时，script/ 已有 v1–v4 |
| 视图默认排序 createdAt desc | 空排序规则 → 现状序（状态序→sortOrder→id） | 与现有表格/看板行为平滑一致 |
| `plan-view.store.ts` Zustand | `use-plan-views.ts` 自定义 hook | 视图态与 React Query 深度绑定；automation 域 `use-automation-tasks.ts` hook 先例 |
| 默认视图名后端存中文 | 播种 name 存空串，UI 显示 `name \|\| t(typeLabelKey)` | i18n 规范禁止后端存死中文文案 |

---

### Task 1: 数据库 v5 迁移（planItem 加列 + planView 建表）

**Files:**
- Create: `electron/infrastructure/script/v5/upgrade-table.sql`
- Modify: `prisma/schema.prisma:249-265`（planItem 模型）、文件末尾追加 planView 模型
- Modify: `electron/Constants.ts:11`（DATABASE_VERSION 4→5）
- Test: `tests/project/plan-view-v5-schema.test.ts`

**Interfaces:**
- Consumes: 无（纯新增）
- Produces: DB 列 `planItem.startDate/dueDate/source`、表 `planView`；`prisma.planView` 客户端（后续 repo 用）；`Prisma.planView` 类型

- [ ] **Step 1: 写失败的 schema 测试**

```ts
// tests/project/plan-view-v5-schema.test.ts
// @vitest-environment node
/** v5 增量脚本测试（沿用 tests/ai/v1-fullschema.test.ts 的 node:sqlite 模式）：
 * 依赖 v4 建 planItem，故按序执行 v4+v5；断言新列、建表幂等、唯一约束、source 默认值 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const scriptDir = (version: string) =>
  path.resolve(__dirname, `../../electron/infrastructure/script/v${version}/upgrade-table.sql`);

/** 去注释行后按分号拆分（模拟 sql-file-executor 最小语义，含 --/p --/ignore 标记行） */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const version of ["4", "5"]) {
    for (const stmt of statements(readFileSync(scriptDir(version), "utf8"))) {
      db.exec(stmt);
    }
  }
  return db;
}

describe("v5 增量脚本（planItem 排期/来源列 + planView 视图表）", () => {
  it("planItem 新增 startDate/dueDate/source 列，source 默认 manual", () => {
    const db = createDb();
    const columns = (
      db.prepare("PRAGMA table_info(planItem)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining(["startDate", "dueDate", "source"]),
    );
    db.exec(
      `INSERT INTO planItem (title, createdById, updatedAt)
       VALUES ('t', 1, '2026-09-14 00:00:00')`,
    );
    const row = db
      .prepare("SELECT source, startDate, dueDate FROM planItem WHERE id = 1")
      .get() as { source: string; startDate: unknown; dueDate: unknown };
    expect(row.source).toBe("manual");
    expect(row.startDate).toBeNull();
    expect(row.dueDate).toBeNull();
  });

  it("重复执行 v5 幂等（IF NOT EXISTS；ALTER 报重复列说明已建）", () => {
    const db = createDb();
    for (const stmt of statements(readFileSync(scriptDir("5"), "utf8"))) {
      expect(() => db.exec(stmt)).not.toThrow();
    }
  });

  it("planView 表 (projectId, name) 唯一约束生效", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO planView (projectId, name, type, filterJson, sortJson, sortOrder, createdAt, updatedAt)
       VALUES (1, '我的看板', 'kanban', '{}', '[]', 0, '2026-09-14 00:00:00', '2026-09-14 00:00:00')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO planView (projectId, name, type, filterJson, sortJson, sortOrder, createdAt, updatedAt)
         VALUES (1, '我的看板', 'table', '{}', '[]', 1, '2026-09-14 00:00:00', '2026-09-14 00:00:00')`,
      ),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/project/plan-view-v5-schema.test.ts`
Expected: FAIL（`script/v5/upgrade-table.sql` 不存在，readFileSync 抛 ENOENT）

- [ ] **Step 3: 写 v5 脚本 + prisma schema + 版本号**

```sql
-- electron/infrastructure/script/v5/upgrade-table.sql
--/p 计划事项排期与来源（子系统 A：甘特/日历地基；source = manual|ai|template）
--/ignore
ALTER TABLE planItem ADD COLUMN startDate DATETIME NULL;
--/ignore
ALTER TABLE planItem ADD COLUMN dueDate DATETIME NULL;
--/ignore
ALTER TABLE planItem ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
--/p 计划视图配置表（子系统 A：视图 = 类型 + 筛选/排序/分组配置；name 空串 = 播种的默认视图，UI 按 type 显示本地化名）
CREATE TABLE IF NOT EXISTS planView (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'table',
    groupBy TEXT NULL,
    filterJson TEXT NOT NULL DEFAULT '{}',
    sortJson TEXT NOT NULL DEFAULT '[]',
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_view_project_name ON planView (projectId, name);
--/ignore
CREATE INDEX IF NOT EXISTS plan_view_projectId_index ON planView (projectId);
```

`prisma/schema.prisma` 的 planItem 模型（249 行起）在 `customFields` 后加三列：

```prisma
  startDate   DateTime? // 排期开始（甘特/日历视图）
  dueDate     DateTime? // 截止日期
  source      String   @default("manual") // manual|ai|template
```

文件末尾（planItem 模型后）追加：

```prisma
model planView {
  id         Int      @id @default(autoincrement())
  projectId  Int
  name       String   @default("") // 空串 = 播种默认视图（UI 显示本地化类型名）
  type       String   @default("table") // table|kanban|list|gantt|calendar
  groupBy    String? // status|priority|assignee（看板分组依据）
  filterJson String   @default("{}")
  sortJson   String   @default("[]")
  sortOrder  Int      @default(0)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([projectId, name], map: "idx_plan_view_project_name")
  @@index([projectId], map: "plan_view_projectId_index")
}
```

`electron/Constants.ts:11`：`static readonly DATABASE_VERSION: number = 5;`

然后重新生成 Prisma 客户端：`npx prisma generate`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/project/plan-view-v5-schema.test.ts && npm run typecheck`
Expected: 3 个用例 PASS；typecheck 通过

- [ ] **Step 5: Commit**

```bash
git add electron/infrastructure/script/v5 prisma/schema.prisma electron/Constants.ts electron/generated tests/project/plan-view-v5-schema.test.ts
git commit -m "feat(project): 数据库 v5——planItem 加 startDate/dueDate/source 列、新建 planView 视图配置表"
```

---

### Task 2: planItem 实体与仓储扩展（P3/source/日期透传 + 成员资格校验）

**Files:**
- Modify: `electron/domains/project/plan-item.entity.ts`
- Modify: `electron/domains/project/plan-item.repo.ts`
- Test: `tests/project/plan-item-repo.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `startDate/dueDate/source` 列与 `prisma.projectMember`
- Produces（后续任务依赖的精确签名）:
  - `PLAN_PRIORITIES = ["P0","P1","P2","P3"] as const`（加 P3）
  - `PLAN_SOURCES = ["manual","ai","template"] as const`；`export type PlanItemSource = (typeof PLAN_SOURCES)[number]`
  - `PlanItemRecord` 增：`source: PlanItemSource; startDate: string; dueDate: string;`（ISO 或空串）
  - `PlanItemCreateParams` / `PlanItemUpdateParams` 增：`source?: PlanItemSource; startDate?: string | null; dueDate?: string | null;`（update 传 `null` = 清空）

- [ ] **Step 1: 追加失败的 repo 测试**

在 `tests/project/plan-item-repo.test.ts` 追加（沿用现有 prismaStub mock 模式；`prismaStub` 需补 `projectMember: { findFirst: vi.fn() }`）：

```ts
describe("PlanItemRepository.字段扩展（子系统 A）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create 透传 source/startDate/dueDate：ISO 字符串转 Date，缺省 source=manual", async () => {
    prismaStub.planItem.create.mockResolvedValue({ ...projectRow, id: 9 });
    await repo.create({
      createdById: 1,
      projectId: 11,
      title: "t",
      startDate: "2026-09-14T00:00:00.000Z",
      dueDate: "2026-09-20T00:00:00.000Z",
    });
    expect(prismaStub.planItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "manual",
        startDate: new Date("2026-09-14T00:00:00.000Z"),
        dueDate: new Date("2026-09-20T00:00:00.000Z"),
      }),
    });
  });

  it("create 非法 source → 抛「无效的来源」", async () => {
    await expect(
      repo.create({
        createdById: 1,
        title: "t",
        source: "magic" as never,
      }),
    ).rejects.toThrow("无效的来源");
  });

  it("update 传 null 清空 startDate；合法 assigneeId（项目成员）通过", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    prismaStub.projectMember.findFirst.mockResolvedValue({ id: 1 });
    await repo.update({ id: 1, startDate: null, assigneeId: 7 });
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { startDate: null, assigneeId: 7 },
    });
  });

  it("update 指派非项目成员 → 抛「处理人必须是项目成员」不落库", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    prismaStub.projectMember.findFirst.mockResolvedValue(null);
    await expect(repo.update({ id: 1, assigneeId: 99 })).rejects.toThrow(
      "处理人必须是项目成员",
    );
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/project/plan-item-repo.test.ts`
Expected: FAIL（PLAN_SOURCES 不存在 / 字段未透传）

- [ ] **Step 3: 实现 entity 与 repo**

`plan-item.entity.ts`：

```ts
/** 事项优先级枚举：P0 最高 / P1 默认 / P2 低 / P3 最低 */
export const PLAN_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/** 事项来源枚举：manual 手动创建 / ai AI 生成 / template 模版导入 */
export const PLAN_SOURCES = ["manual", "ai", "template"] as const;
export type PlanItemSource = (typeof PLAN_SOURCES)[number];
```

`PlanItemRecord` 加字段（含 JSDoc）：

```ts
  /** 开始日期（ISO，空串 = 无） */
  startDate: string;

  /** 截止日期（ISO，空串 = 无） */
  dueDate: string;

  /** 来源 */
  source: PlanItemSource;
```

`PlanItemCreateParams` / `PlanItemUpdateParams` 加：

```ts
  source?: PlanItemSource;
  /** ISO 日期；null = 清空（仅 update） */
  startDate?: string | null;
  dueDate?: string | null;
```

`plan-item.repo.ts` 改动点：

1. import 增加 `PLAN_SOURCES`、`type PlanItemSource`。
2. `create`：枚举校验后 data 加三键：

```ts
        source: params.source ?? "manual",
        startDate: this.toDateOrNull(params.startDate),
        dueDate: this.toDateOrNull(params.dueDate),
```

3. `ensureUpdatable` 加 `this.ensureEnumOrThrow(params.source, PLAN_SOURCES, "无效的来源");`
4. `buildUpdateData` 加三键（`startDate: this.toDateOrNull(params.startDate)`——注意 `buildUpdateData` 里 `undefined` 时不得写入该列，沿用 `...(params.xxx !== undefined && {...})` 模式）。
5. 新增成员资格校验私有方法，`create`/`update` 在写库前调用：

```ts
  /** 指派校验：assigneeId 非空时必须是该项目成员（本地任务无项目，跳过校验） */
  private async ensureAssigneeIsMember(
    projectId: number | null,
    assigneeId: number | null | undefined,
  ): Promise<void> {
    if (projectId === null || assigneeId === undefined || assigneeId === null) {
      return;
    }
    const member = await prisma.projectMember.findFirst({
      where: { projectId, userId: assigneeId },
    });
    if (!member) {
      throw new Error("处理人必须是项目成员");
    }
  }
```

6. `toRecord` 加：

```ts
      startDate: this.toIso(row.startDate),
      dueDate: this.toIso(row.dueDate),
      source: row.source as PlanItemSource,
```

7. 新增私有工具（`undefined` 透传不写列、`null` 清空、ISO 字符串转 Date）：

```ts
  /** ISO 字符串 → Date；null → null（清空）；undefined → undefined（不写该列） */
  private toDateOrNull(value: string | null | undefined): Date | null | undefined {
    return value === undefined ? undefined : value === null ? null : new Date(value);
  }
```

- [ ] **Step 4: 运行测试确认通过 + 全量回归**

Run: `npm run test -- tests/project/plan-item-repo.test.ts`
Expected: 全部 PASS。随后单独运行 `npm run typecheck`：P3 加入 PLAN_PRIORITIES 会引起前端 `Record<PlanPriority, ...>` 缺键编译错——本任务只改后端文件，typecheck 若仅报 PlanItemDialog/PlanKanbanView/PlanTableView/TasksPane 的 P3 缺键属预期中间态（Task 3 修复后回归）；出现其他任何编译错则不可接受，需修复。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/project/plan-item.entity.ts electron/domains/project/plan-item.repo.ts tests/project/plan-item-repo.test.ts
git commit -m "feat(project): planItem 仓储扩展——P3/source/排期字段透传与处理人成员资格校验"
```

---

### Task 3: 成员列表通道 + 前端全字段贯通（弹窗日期/处理人/P3）

**Files:**
- Modify: `electron/domains/project/project.entity.ts`（加 `ProjectMemberItem`）
- Modify: `electron/domains/project/project.repo.ts`（加 `project:listMembers` 通道）
- Modify: `src-react/domains/project/api/project.api.ts`（加 `listMembers`）
- Modify: `src-react/domains/project/components/PlanItemDialog.tsx`
- Modify: `src-react/domains/project/components/PlanKanbanView.tsx:48-52`（P3 色条）
- Modify: `src-react/i18n/locales/zh-CN/project.json`、`src-react/i18n/locales/en-US/project.json`
- Test: `tests/project/project-repo.test.ts`、`tests/project/plan-item-dialog.test.tsx`、`tests/project/plan-kanban.test.tsx`（追加/更新）

**Interfaces:**
- Consumes: Task 2 的 `PLAN_SOURCES`、`startDate/dueDate/source` 参数
- Produces:
  - `ProjectMemberItem { userId: number; nickname: string; username: string; role: string }`（前后端共享）
  - `ProjectApi.listMembers(projectId: number): Promise<ProjectMemberItem[]>`
  - `PlanItemDialog` 可编辑 `startDate/dueDate/assigneeId`（编辑态 update 传 ISO/null）
  - `PRIORITY_OPTIONS = ["P0","P1","P2","P3"]`、`PRIORITY_LABEL_KEYS.priorityP3 = "project:plan.priorityP3"`、`PRIORITY_BADGE_VARIANTS.P3 = "outline"`

- [ ] **Step 1: 追加失败的后端测试**

`tests/project/project-repo.test.ts` 追加（沿用 prismaStub 模式，stub 补 `user: { findMany: vi.fn() }`、`projectMember: { findMany: vi.fn() }`；具体 mock 形状对照该文件现有 beforeEach）：

```ts
describe("ProjectRepository.listMembers", () => {
  it("返回成员列表（joinedAt 序）并 join user 取昵称（缺昵称回退用户名）", async () => {
    prismaStub.projectMember.findMany.mockResolvedValue([
      { projectId: 11, userId: 2, role: "member", joinedAt: now },
      { projectId: 11, userId: 1, role: "owner", joinedAt: now },
    ]);
    prismaStub.user.findMany.mockResolvedValue([
      { id: 1, nickname: "黄", username: "hjx" },
      { id: 2, nickname: "", username: "ai_bot" },
    ]);
    const members = await repo.listMembers(11);
    expect(members).toEqual([
      { userId: 2, nickname: "ai_bot", username: "ai_bot", role: "member" },
      { userId: 1, nickname: "黄", username: "hjx", role: "owner" },
    ]);
  });
});
```

（`repo` 实例化方式与该文件现有写法保持一致；`now` 用文件中已有的时间 stub 或 `new Date()`。）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/project-repo.test.ts`
Expected: FAIL（`repo.listMembers` 不是函数）

- [ ] **Step 3: 实现通道与实体**

`project.entity.ts` 追加：

```ts
/**
 * 项目成员列表项（计划模块处理人选择器用，子系统 A）
 */
export interface ProjectMemberItem {
  /** 用户 id */
  userId: number;

  /** 昵称（缺省回退用户名） */
  nickname: string;

  /** 用户名 */
  username: string;

  /** 角色：owner | member */
  role: string;
}
```

`project.repo.ts`：`registerHandlers` 追加通道 + 实现（import 补 `type ProjectMemberItem`）：

```ts
    ipcMain.handle("project:listMembers", (_, projectId: number) =>
      this.listMembers(projectId),
    );
```

```ts
  /**
   * 项目成员列表（joinedAt asc，owner 在前不保证——按加入序），
   * join user 取昵称（缺昵称回退用户名）
   */
  async listMembers(projectId: number): Promise<ProjectMemberItem[]> {
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { joinedAt: "asc" },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return members.map((m) => {
      const user = byId.get(m.userId);
      return {
        userId: m.userId,
        nickname: user?.nickname || user?.username || "",
        username: user?.username ?? "",
        role: m.role,
      };
    });
  }
```

`project.api.ts` 追加（import 补 `ProjectMemberItem`）：

```ts
  /** 项目成员列表（处理人选择器） */
  static async listMembers(projectId: number): Promise<ProjectMemberItem[]> {
    return invoke<ProjectMemberItem[]>("project:listMembers", projectId);
  }
```

- [ ] **Step 4: 运行后端测试确认通过**

Run: `npm run test -- tests/project/project-repo.test.ts`
Expected: PASS

- [ ] **Step 5: 前端弹窗改造（P3 + 日期 + 处理人 Select）**

`PlanItemDialog.tsx`：

1. `PRIORITY_OPTIONS` 改 `["P0", "P1", "P2", "P3"]`；`PRIORITY_LABEL_KEYS` 加 `P3: "project:plan.priorityP3"`；`PRIORITY_BADGE_VARIANTS` 加 `P3: "outline"`。
2. import `ProjectApi`（`../api/project.api`）与 `ProjectMemberItem`。
3. state 增：

```ts
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
```

4. 打开重置/回填 useEffect 增：`setStartDate(item?.startDate ? item.startDate.slice(0, 10) : "");`（dueDate 同理）、`setAssigneeId(item?.assigneeId ?? user.id);`
5. 成员查询（弹窗打开且项目任务时拉取）：

```ts
  const { data: members = [] } = useQuery({
    queryKey: ["projectMembers", projectId],
    queryFn: () => ProjectApi.listMembers(projectId as number),
    enabled: open && projectId !== null,
  });
```

6. 处理人区（`plan-item-assignee` 一段）替换只读 Input 为 Select：`projectId === null` 时保留只读「我」；否则渲染成员 Select（value=String(assigneeId ?? "")，空值项 `t("project:plan.unassigned")`，选项显示 `nickname`，`onValueChange={(v) => setAssigneeId(v === "" ? null : Number(v))}`）。
7. 状态/优先级 grid 之后加日期 grid（两个 `Input type="date"`，Label 用 `t("project:plan.startDate")` / `t("project:plan.dueDate")`，aria-label 同）。
8. `handleSave` 载荷增：

```ts
  const toIsoOrNull = (value: string): string | null =>
    value ? new Date(`${value}T00:00:00`).toISOString() : null;
```

   - update：`assigneeId`、`startDate: toIsoOrNull(startDate)`、`dueDate: toIsoOrNull(dueDate)`（本地任务不传日期——本地任务无日期语义，条件 `projectId !== null` 时才带上）
   - create：`assigneeId: assigneeId ?? user.id`；日期同上仅在项目任务时传

`PlanKanbanView.tsx:48-52` 加：`P3: "border-l-border/40"`（比 P2 更弱）。

i18n `zh-CN/project.json` 的 `plan` 段加（en-US 同步加英文值）：

```json
    "priorityP3": "P3",
    "startDate": "开始日期",
    "dueDate": "截止日期",
    "unassigned": "未指派"
```

en-US 对应：`"P3"`、`"Start date"`、`"Due date"`、`"Unassigned"`。

- [ ] **Step 6: 更新组件测试并全量回归**

`tests/project/plan-item-dialog.test.tsx` 追加用例（mock 骨架沿用该文件现有 vi.mock；补 `ProjectApi.listMembers` mock 返回两名成员）：
- 「编辑回填日期与处理人；提交 update 携带 ISO/null 与 assigneeId」
- 「优先级下拉含 P3；选 P3 提交 create 带 priority P3」

`tests/project/plan-kanban.test.tsx`：现有断言不受影响（P3 仅加映射）；补一条「P3 卡片左色条 class 含 border-l-border/40」。

Run: `npm run test && npm run typecheck`
Expected: 全部 PASS（Task 2 遗留的 P3 缺键编译错在此消除）

- [ ] **Step 7: Commit**

```bash
git add electron/domains/project/project.entity.ts electron/domains/project/project.repo.ts src-react/domains/project/api/project.api.ts src-react/domains/project/components/PlanItemDialog.tsx src-react/domains/project/components/PlanKanbanView.tsx src-react/i18n/locales tests/project/project-repo.test.ts tests/project/plan-item-dialog.test.tsx tests/project/plan-kanban.test.tsx
git commit -m "feat(project): 处理人多人指派与排期录入——project:listMembers 通道 + 弹窗日期/成员选择器 + P3 全链路"
```

---

### Task 4: planView 实体与仓储（播种/重名后缀/最后视图拒删/JSON 容错）

**Files:**
- Create: `electron/domains/project/plan-view.entity.ts`
- Create: `electron/domains/project/plan-view.repo.ts`
- Modify: `electron/Application.ts:22` 附近 import、`:143` 附近实例化
- Test: `tests/project/plan-view-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `prisma.planView`
- Produces（Task 5/7/8 依赖）:
  - `PLAN_VIEW_TYPES = ["table","kanban","list","gantt","calendar"] as const`；`export type PlanViewType`
  - `PLAN_GROUP_BYS = ["status","priority","assignee"] as const`；`export type PlanGroupBy`
  - `PLAN_VIEW_NAME_KEYS: Record<PlanViewType, string>`（值 `"project:planView.typeTable"` 等）
  - `PLAN_VIEW_LAST_ONE = "PLAN_VIEW_LAST_ONE"`（错误码）
  - `PlanViewRecord { id: number; projectId: number; name: string; type: PlanViewType; groupBy: PlanGroupBy | null; filterJson: string; sortJson: string; sortOrder: number; createdAt: string; updatedAt: string; }`
  - `PlanViewCreateParams { projectId: number; name?: string; type: PlanViewType; groupBy?: PlanGroupBy | null; filterJson?: string; sortJson?: string; }`
  - `PlanViewUpdateParams { id: number; name?: string; type?: PlanViewType; groupBy?: PlanGroupBy | null; filterJson?: string; sortJson?: string; }`
  - 通道：`planView:list|create|update|delete|reorder`；`PlanViewRepository` 方法 `list/create/update/remove/reorder`

- [ ] **Step 1: 写失败的仓储测试**

```ts
// tests/project/plan-view-repo.test.ts
/** 计划视图仓储单测（子系统 A spec §主进程）：懒播种（空列表事务插两条默认视图，
 * name 空串）、list 排序、create 重名自动 (n) 后缀、update 局部键、
 * 最后一个视图拒删（PLAN_VIEW_LAST_ONE）、reorder 批量、
 * 读取时畸形 filterJson 降级 "{}"；5 通道自注册 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const prismaStub = vi.hoisted(() => ({
  planView: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("../../electron/commons/prisma-client", () => ({ default: prismaStub }));

import PlanViewRepository from "../../electron/domains/project/plan-view.repo";
import { PLAN_VIEW_LAST_ONE } from "../../electron/domains/project/plan-view.entity";
import { ipcMain } from "electron";

const repo = new PlanViewRepository();
const now = new Date("2026-09-14T00:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  projectId: 11,
  name: "",
  type: "table",
  groupBy: null,
  filterJson: "{}",
  sortJson: "[]",
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe("PlanViewRepository.list 懒播种", () => {
  beforeEach(() => vi.clearAllMocks());

  it("空列表 → $transaction 数组式 create×2 播种表格/看板两条（name 空串）再返回", async () => {
    prismaStub.planView.findMany
      .mockResolvedValueOnce([]) // 播种前
      .mockResolvedValueOnce([row(), row({ id: 2, type: "kanban", sortOrder: 1 })]); // 播种后重查
    const views = await repo.list(11);
    expect(prismaStub.$transaction).toHaveBeenCalledTimes(1);
    expect(Array.isArray((prismaStub.$transaction as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe(true);
    expect(prismaStub.planView.create).toHaveBeenCalledTimes(2);
    expect(prismaStub.planView.create).toHaveBeenNthCalledWith(1, {
      data: { projectId: 11, name: "", type: "table", sortOrder: 0 },
    });
    expect(prismaStub.planView.create).toHaveBeenNthCalledWith(2, {
      data: { projectId: 11, name: "", type: "kanban", sortOrder: 1 },
    });
    expect(views).toHaveLength(2);
    expect(views[1].type).toBe("kanban");
  });

  it("非空列表不播种；畸形 filterJson 降级为 {}", async () => {
    prismaStub.planView.findMany.mockResolvedValue([
      row({ filterJson: "not-json{" }),
    ]);
    const views = await repo.list(11);
    expect(prismaStub.$transaction).not.toHaveBeenCalled();
    expect(views[0].filterJson).toBe("{}");
  });
});

describe("PlanViewRepository.create 重名后缀", () => {
  beforeEach(() => vi.clearAllMocks());

  it("同名存在 → 自动加 (n) 后缀找到第一个可用名", async () => {
    prismaStub.planView.findFirst
      .mockResolvedValueOnce(row({ name: "我的看板" }))
      .mockResolvedValueOnce(row({ name: "我的看板(2)" }))
      .mockResolvedValueOnce(null);
    prismaStub.planView.findMany.mockResolvedValue([]);
    prismaStub.planView.create.mockResolvedValue(row({ name: "我的看板(3)" }));
    const created = await repo.create({ projectId: 11, name: "我的看板", type: "kanban" });
    expect(prismaStub.planView.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "我的看板(3)", type: "kanban" }),
    });
    expect(created.name).toBe("我的看板(3)");
  });
});

describe("PlanViewRepository.remove 最后视图保护", () => {
  beforeEach(() => vi.clearAllMocks());

  it("项目仅剩一条 → 抛 PLAN_VIEW_LAST_ONE 不删除", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    prismaStub.planView.count.mockResolvedValue(1);
    await expect(repo.remove(1)).rejects.toThrow(PLAN_VIEW_LAST_ONE);
    expect(prismaStub.planView.delete).not.toHaveBeenCalled();
  });

  it("多于一条 → 正常删除", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    prismaStub.planView.count.mockResolvedValue(3);
    await repo.remove(1);
    expect(prismaStub.planView.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

describe("PlanViewRepository.update/reorder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("update 局部键：仅 name/type/groupBy/filterJson 传入者写入", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    await repo.update({ id: 1, name: "高优", groupBy: "priority" });
    expect(prismaStub.planView.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: "高优", groupBy: "priority" },
    });
  });

  it("reorder 按 [{id, sortOrder}] 逐条更新", async () => {
    prismaStub.planView.update.mockResolvedValue(row());
    await repo.reorder([
      { id: 2, sortOrder: 0 },
      { id: 1, sortOrder: 1 },
    ]);
    expect(prismaStub.planView.update).toHaveBeenCalledTimes(2);
  });

  it("update 不存在的视图 → 抛「视图不存在」", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(null);
    await expect(repo.update({ id: 99, name: "x" })).rejects.toThrow(
      "视图不存在",
    );
  });
});

describe("planView 通道自注册", () => {
  it("注册 5 通道", () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        "planView:list",
        "planView:create",
        "planView:update",
        "planView:delete",
        "planView:reorder",
      ]),
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-view-repo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 entity 与 repo**

`plan-view.entity.ts`：

```ts
/**
 * 计划视图数据接口（前后端共享，子系统 A spec §数据模型）
 * 视图 = 展示类型 + 筛选/排序/分组配置；不复制数据，共享项目 planItem
 */

/** 视图类型枚举：table 表格 / kanban 看板 / list 列表 / gantt 甘特 / calendar 日历（list/gantt/calendar 为 C 阶段预留，本期 UI 仅 table/kanban 可选） */
export const PLAN_VIEW_TYPES = [
  "table",
  "kanban",
  "list",
  "gantt",
  "calendar",
] as const;
export type PlanViewType = (typeof PLAN_VIEW_TYPES)[number];

/** 看板分组依据：status 状态 / priority 优先级 / assignee 处理人 */
export const PLAN_GROUP_BYS = ["status", "priority", "assignee"] as const;
export type PlanGroupBy = (typeof PLAN_GROUP_BYS)[number];

/** 视图类型本地化名 key（默认视图 name 为空串时 UI 兜底显示） */
export const PLAN_VIEW_NAME_KEYS: Record<PlanViewType, string> = {
  table: "project:planView.typeTable",
  kanban: "project:planView.typeKanban",
  list: "project:planView.typeList",
  gantt: "project:planView.typeGantt",
  calendar: "project:planView.typeCalendar",
};

/** 错误码：最后一个视图不可删（项目至少保留一个视图） */
export const PLAN_VIEW_LAST_ONE = "PLAN_VIEW_LAST_ONE";

/** 视图记录（DateTime 已转 ISO 字符串） */
export interface PlanViewRecord {
  id: number;
  projectId: number;
  /** 空串 = 播种默认视图（UI 显示本地化类型名） */
  name: string;
  type: PlanViewType;
  groupBy: PlanGroupBy | null;
  filterJson: string;
  sortJson: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 创建参数：type 必填；name 缺省空串（默认视图语义）；重名自动 (n) 后缀 */
export interface PlanViewCreateParams {
  projectId: number;
  name?: string;
  type: PlanViewType;
  groupBy?: PlanGroupBy | null;
  filterJson?: string;
  sortJson?: string;
}

/** 局部更新参数：仅传入字段写入（未传键不覆盖） */
export interface PlanViewUpdateParams {
  id: number;
  name?: string;
  type?: PlanViewType;
  groupBy?: PlanGroupBy | null;
  filterJson?: string;
  sortJson?: string;
}
```

`plan-view.repo.ts`（关键方法签名与逻辑；JSON 容错读取 + 播种事务 + 重名后缀）：

```ts
/**
 * 计划视图仓储（子系统 A spec §主进程）：list（空则懒播种两条默认视图）、
 * create（重名自动 (n) 后缀、sortOrder 列尾）、update（局部键）、
 * remove（最后一个视图拒删）、reorder（批量）。
 * filterJson/sortJson 读取时解析失败静默降级默认值并 console.warn。
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import {
  PLAN_GROUP_BYS,
  PLAN_VIEW_LAST_ONE,
  PLAN_VIEW_TYPES,
  type PlanGroupBy,
  type PlanViewCreateParams,
  type PlanViewRecord,
  type PlanViewType,
  type PlanViewUpdateParams,
} from "./plan-view.entity";

type PlanViewRow = NonNullable<
  Awaited<ReturnType<typeof prisma.planView.findFirst>>
>;

/** JSON 列读取容错：畸形 JSON → fallback 并 warn */
function parseJsonOr(raw: string | null, fallback: string): string {
  if (raw === null) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return raw;
    }
  } catch {
    // 落入下方降级
  }
  console.warn("planView JSON 列畸形已降级", raw);
  return fallback;
}

export default class PlanViewRepository {
  constructor() {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("planView:list", (_, projectId: number) =>
      this.list(projectId),
    );
    ipcMain.handle("planView:create", (_, params: PlanViewCreateParams) =>
      this.create(params),
    );
    ipcMain.handle("planView:update", (_, params: PlanViewUpdateParams) =>
      this.update(params),
    );
    ipcMain.handle("planView:delete", (_, id: number) => this.remove(id));
    ipcMain.handle(
      "planView:reorder",
      (_, items: Array<{ id: number; sortOrder: number }>) =>
        this.reorder(items),
    );
  }

  /** 项目全部视图（sortOrder asc + id asc）；空列表懒播种默认两条（事务幂等） */
  async list(projectId: number): Promise<PlanViewRecord[]> {
    let rows = await prisma.planView.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    if (rows.length === 0) {
      await prisma.$transaction([
        prisma.planView.create({
          data: { projectId, name: "", type: "table", sortOrder: 0 },
        }),
        prisma.planView.create({
          data: { projectId, name: "", type: "kanban", sortOrder: 1 },
        }),
      ]);
      rows = await prisma.planView.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
    }
    return rows.map((row) => this.toRecord(row));
  }

  /** 创建视图：type 枚举校验 + 重名自动 (n) 后缀 + sortOrder 列尾 */
  async create(params: PlanViewCreateParams): Promise<PlanViewRecord> {
    this.ensureEnumOrThrow(params.type, PLAN_VIEW_TYPES, "无效的视图类型");
    if (
      params.groupBy !== undefined &&
      params.groupBy !== null
    ) {
      this.ensureEnumOrThrow(params.groupBy, PLAN_GROUP_BYS, "无效的分组依据");
    }
    const name = params.name?.trim() ?? "";
    const row = await prisma.planView.create({
      data: {
        projectId: params.projectId,
        name: await this.uniqueName(params.projectId, name),
        type: params.type,
        groupBy: params.groupBy ?? null,
        filterJson: params.filterJson ?? "{}",
        sortJson: params.sortJson ?? "[]",
        sortOrder: await this.nextSortOrder(params.projectId),
      },
    });
    return this.toRecord(row);
  }

  /** 局部更新：仅写入传入键；groupBy 传 null = 清除分组 */
  async update(params: PlanViewUpdateParams): Promise<void> {
    const row = await prisma.planView.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error("视图不存在");
    }
    const data = this.buildUpdateData(params);
    await prisma.planView.update({ where: { id: params.id }, data });
  }

  /** 删除：最后一个视图拒删（单一不变量：项目至少保留一个视图） */
  async remove(id: number): Promise<void> {
    const row = await prisma.planView.findUnique({ where: { id } });
    if (!row) {
      return;
    }
    const count = await prisma.planView.count({ where: { projectId: row.projectId } });
    if (count <= 1) {
      throw new Error(PLAN_VIEW_LAST_ONE);
    }
    await prisma.planView.delete({ where: { id } });
  }

  /** Tab 顺序批量更新 */
  async reorder(items: Array<{ id: number; sortOrder: number }>): Promise<void> {
    for (const item of items) {
      await prisma.planView.update({
        where: { id: item.id },
        data: { sortOrder: item.sortOrder },
      });
    }
  }

  /** 枚举校验（同 plan-item.repo 模式） */
  private ensureEnumOrThrow(
    value: string | undefined,
    allowed: readonly string[],
    message: string,
  ): void {
    if (value !== undefined && !allowed.includes(value)) {
      throw new Error(message);
    }
  }

  /** 重名 (n) 后缀：name 空串恒可用（默认视图语义不参与后缀） */
  private async uniqueName(projectId: number, name: string): Promise<string> {
    if (name === "") {
      return name;
    }
    let candidate = name;
    for (let n = 2; n < 100; n += 1) {
      const exists = await prisma.planView.findFirst({
        where: { projectId, name: candidate },
        select: { id: true },
      });
      if (!exists) {
        return candidate;
      }
      candidate = `${name}(${n})`;
    }
    return candidate;
  }

  private async nextSortOrder(projectId: number): Promise<number> {
    const last = await prisma.planView.findFirst({
      where: { projectId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }

  private buildUpdateData(params: PlanViewUpdateParams) {
    return {
      ...(params.name !== undefined && { name: params.name.trim() }),
      ...(params.type !== undefined && { type: params.type }),
      ...(params.groupBy !== undefined && { groupBy: params.groupBy }),
      ...(params.filterJson !== undefined && {
        filterJson: params.filterJson,
      }),
      ...(params.sortJson !== undefined && { sortJson: params.sortJson }),
    };
  }

  private toRecord(row: PlanViewRow): PlanViewRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      type: row.type as PlanViewType,
      groupBy: (row.groupBy as PlanGroupBy | null) ?? null,
      filterJson: parseJsonOr(row.filterJson, "{}"),
      sortJson: parseJsonOr(row.sortJson, "[]"),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt ? row.createdAt.toISOString() : "",
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : "",
    };
  }
}
```

注意：`list` 播种用 `$transaction([create, create])`（数组式），测试 mock 的 `$transaction` 断言与实现一致（数组参数）。

`electron/Application.ts`：import 区加 `import PlanViewRepository from "./domains/project/plan-view.repo";`，`new PlanItemRepository();` 之后加 `new PlanViewRepository();`

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `npm run test -- tests/project/plan-view-repo.test.ts && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/project/plan-view.entity.ts electron/domains/project/plan-view.repo.ts electron/Application.ts tests/project/plan-view-repo.test.ts
git commit -m "feat(project): planView 视图仓储——懒播种/重名后缀/最后视图拒删/JSON 容错 + 5 IPC 通道"
```

---

### Task 5: 项目级联删视图 + 前端 plan-view API

**Files:**
- Modify: `electron/domains/project/project.repo.ts:143`（remove 级联段）
- Create: `src-react/domains/project/api/plan-view.api.ts`
- Test: `tests/project/project-repo.test.ts`（remove 断言）、`tests/project/plan-view-api.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `PlanViewRecord/PlanViewCreateParams/PlanViewUpdateParams` 与通道
- Produces（Task 7 依赖）:
  - `PLAN_VIEWS_KEY = (projectId: number) => ["planViews", projectId] as const`
  - `PlanViewApi.list/create/update/remove/reorder` 静态方法（签名同仓储方法）

- [ ] **Step 1: 写失败的前端 API 测试**

```ts
// tests/project/plan-view-api.test.ts
/** PlanViewApi 薄封装测试（沿用 tests/project/plan-item-api.test.ts 的 invoke mock 模式）：
 * 通道名小驼峰 + 参数透传 + query key 工厂形状 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import PlanViewApi, { PLAN_VIEWS_KEY } from "../../src-react/domains/project/api/plan-view.api";

describe("PlanViewApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list 透传 planView:list", async () => {
    invokeMock.mockResolvedValue([]);
    await PlanViewApi.list(11);
    expect(invokeMock).toHaveBeenCalledWith("planView:list", 11);
  });

  it("create/update/remove/reorder 通道与参数", async () => {
    invokeMock.mockResolvedValue(undefined);
    await PlanViewApi.create({ projectId: 11, name: "看板", type: "kanban" });
    await PlanViewApi.update({ id: 1, name: "改名" });
    await PlanViewApi.remove(1);
    await PlanViewApi.reorder([{ id: 1, sortOrder: 0 }]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "planView:create", {
      projectId: 11,
      name: "看板",
      type: "kanban",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "planView:update", {
      id: 1,
      name: "改名",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "planView:delete", 1);
    expect(invokeMock).toHaveBeenNthCalledWith(4, "planView:reorder", [
      { id: 1, sortOrder: 0 },
    ]);
  });

  it("PLAN_VIEWS_KEY 工厂", () => {
    expect(PLAN_VIEWS_KEY(11)).toEqual(["planViews", 11]);
  });
});
```

同时在 `tests/project/project-repo.test.ts` 的 remove 级联用例中断言追加（找现有「级联」相关 it，在最后加一行）：

```ts
    expect(prismaStub.planView.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
```

（`prismaStub` 需补 `planView: { deleteMany: vi.fn() }`；projectId 取该用例实际值。）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-view-api.test.ts tests/project/project-repo.test.ts`
Expected: FAIL（api 文件不存在 / deleteMany 未被调用）

- [ ] **Step 3: 实现**

`project.repo.ts` remove() 中，`planItem.deleteMany` 之后加一行：

```ts
    // 级联清项目视图配置（子系统 A）
    await prisma.planView.deleteMany({ where: { projectId: id } });
```

`src-react/domains/project/api/plan-view.api.ts`：

```ts
/**
 * 计划视图 API
 * IPC 通道由主进程 PlanViewRepository 提供（electron/domains/project/plan-view.repo.ts）
 */
import { invoke } from "@/lib/ipc";
import type {
  PlanViewCreateParams,
  PlanViewRecord,
  PlanViewUpdateParams,
} from "../../../../electron/domains/project/plan-view.entity";

/** 项目视图列表 query key */
export const PLAN_VIEWS_KEY = (projectId: number) =>
  ["planViews", projectId] as const;

export default abstract class PlanViewApi {
  /** 项目全部视图（首次返回空时后端懒播种默认两条） */
  static async list(projectId: number): Promise<PlanViewRecord[]> {
    return invoke<PlanViewRecord[]>("planView:list", projectId);
  }

  /** 创建视图（重名后端自动加 (n) 后缀） */
  static async create(
    params: PlanViewCreateParams,
  ): Promise<PlanViewRecord> {
    return invoke<PlanViewRecord>("planView:create", params);
  }

  /** 局部更新（改名/改类型/覆盖保存配置） */
  static async update(params: PlanViewUpdateParams): Promise<void> {
    return invoke<void>("planView:update", params);
  }

  /** 删除视图（最后一个后端拒绝） */
  static async remove(id: number): Promise<void> {
    return invoke<void>("planView:delete", id);
  }

  /** Tab 顺序批量更新（本期通道就绪，UI 后置） */
  static async reorder(
    items: Array<{ id: number; sortOrder: number }>,
  ): Promise<void> {
    return invoke<void>("planView:reorder", items);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/project/plan-view-api.test.ts tests/project/project-repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/project/project.repo.ts src-react/domains/project/api/plan-view.api.ts tests/project/plan-view-api.test.ts tests/project/project-repo.test.ts
git commit -m "feat(project): 项目删除级联清视图 + PlanViewApi 前端封装"
```

---

### Task 6: 前端筛选引擎（filterItems/sortItems/groupItems 纯函数）

**Files:**
- Create: `src-react/domains/project/model/plan-view-engine.ts`
- Test: `tests/project/plan-view-engine.test.ts`

**Interfaces:**
- Consumes: `PlanItemRecord`（Task 2 后含 source/startDate/dueDate）、`PLAN_STATUSES/PLAN_PRIORITIES`、`ProjectMemberItem`（Task 3）
- Produces（Task 7/8/12 依赖）:

```ts
export interface FilterCondition {
  field: "title" | "status" | "assigneeId" | "source" | "priority" | "tags";
  op: "contains" | "in" | "notIn" | "isMe";
  value: string | string[];
}

export type SortField = "status" | "priority" | "dueDate" | "createdAt" | "title";
export interface SortRule { field: SortField; dir: "asc" | "desc"; }

export type GroupByField = "status" | "priority" | "assignee";
export interface ItemGroup { key: string; items: PlanItemRecord[] }

export function filterItems(
  items: PlanItemRecord[],
  conditions: FilterCondition[],
  searchKeyword: string,
  currentUserId: number,
): PlanItemRecord[];

export function sortItems(items: PlanItemRecord[], rules: SortRule[]): PlanItemRecord[];

export function groupItems(
  items: PlanItemRecord[],
  groupBy: GroupByField,
  assigneeOptions?: ProjectMemberItem[],
): ItemGroup[];

export function parseViewConfig(
  filterJson: string,
  sortJson: string,
): { conditions: FilterCondition[]; sortRules: SortRule[] };
```

- [ ] **Step 1: 写失败的引擎测试（重头 TDD，先全量写用例）**

```ts
// tests/project/plan-view-engine.test.ts
/** 筛选引擎纯函数测试（子系统 A spec §前端）：filterItems 六字段×操作符、
 * AND 组合、搜索叠加、非法条件防御性忽略；sortItems 空规则缺省序（状态→
 * sortOrder→id）与多规则；groupItems 三种分组（空组保留、assignee 含
 * unassigned 与候选成员空组）；parseViewConfig 畸形 JSON 降级 */
import { describe, expect, it } from "vitest";
import {
  filterItems,
  groupItems,
  parseViewConfig,
  sortItems,
} from "../../src-react/domains/project/model/plan-view-engine";
import type { PlanItemRecord } from "../../electron/domains/project/plan-item.entity";

const item = (over: Partial<PlanItemRecord>): PlanItemRecord => ({
  id: 1,
  projectId: 11,
  title: "标题",
  status: "not_started",
  priority: "P1",
  assigneeId: 7,
  tags: [],
  customFields: {},
  sortOrder: 1,
  createdById: 1,
  source: "manual",
  startDate: "",
  dueDate: "",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

const items = [
  item({ id: 1, title: "写技术方案", status: "in_progress", priority: "P0", assigneeId: 7, tags: ["前端"] }),
  item({ id: 2, title: "评审 PRD", status: "not_started", priority: "P2", assigneeId: 8, tags: ["产品"], source: "ai" }),
  item({ id: 3, title: "修复登录", status: "done", priority: "P1", assigneeId: null, tags: [] }),
];

describe("filterItems", () => {
  it("空条件 + 空搜索 → 全量直通", () => {
    expect(filterItems(items, [], "", 7)).toHaveLength(3);
  });

  it("title contains 大小写不敏感子串", () => {
    expect(filterItems(items, [{ field: "title", op: "contains", value: "PRD" }], "", 7)).toEqual([items[1]]);
  });

  it("status in 多选命中", () => {
    expect(
      filterItems(items, [{ field: "status", op: "in", value: ["in_progress", "done"] }], "", 7),
    ).toEqual([items[0], items[2]]);
  });

  it("status notIn 排除", () => {
    expect(filterItems(items, [{ field: "status", op: "notIn", value: ["done"] }], "", 7)).toEqual([
      items[0],
      items[1],
    ]);
  });

  it("assigneeId isMe 只留当前用户的（含未指派排除）", () => {
    expect(filterItems(items, [{ field: "assigneeId", op: "isMe", value: "" }], "", 7)).toEqual([items[0]]);
  });

  it("assigneeId in 按 id 字符串匹配", () => {
    expect(filterItems(items, [{ field: "assigneeId", op: "in", value: ["8"] }], "", 7)).toEqual([
      items[1],
    ]);
  });

  it("source / priority in", () => {
    expect(filterItems(items, [{ field: "source", op: "in", value: ["ai"] }], "", 7)).toEqual([items[1]]);
    expect(filterItems(items, [{ field: "priority", op: "in", value: ["P0", "P1"] }], "", 7)).toEqual([
      items[0],
      items[2],
    ]);
  });

  it("tags contains 含任一指定标签即命中（value 数组）", () => {
    expect(filterItems(items, [{ field: "tags", op: "contains", value: ["前端"] }], "", 7)).toEqual([
      items[0],
    ]);
  });

  it("多条件 AND 交集 + 搜索关键词叠加（仅匹配标题）", () => {
    const result = filterItems(
      items,
      [
        { field: "status", op: "in", value: ["in_progress", "not_started"] },
        { field: "priority", op: "in", value: ["P0", "P2"] },
      ],
      "评审",
      7,
    );
    expect(result).toEqual([items[1]]);
  });

  it("非法条件（未知 field/op）防御性忽略不抛错", () => {
    expect(
      filterItems(items, [
        { field: "hacker" as never, op: "in", value: ["x"] },
        { field: "status", op: "explode" as never, value: "x" },
      ], "", 7),
    ).toHaveLength(3);
  });
});

describe("sortItems", () => {
  it("空规则 → 缺省序：状态序 → sortOrder → id", () => {
    const shuffled = [
      item({ id: 5, status: "not_started", sortOrder: 2 }),
      item({ id: 4, status: "done", sortOrder: 1 }),
      item({ id: 3, status: "not_started", sortOrder: 1 }),
    ];
    expect(sortItems(shuffled, []).map((i) => i.id)).toEqual([3, 5, 4]);
  });

  it("priority asc 按 P0<P1<P2<P3；title desc 倒序", () => {
    expect(sortItems(items, [{ field: "priority", dir: "asc" }]).map((i) => i.priority)).toEqual([
      "P0",
      "P1",
      "P2",
    ]);
    expect(sortItems(items, [{ field: "title", dir: "desc" }]).map((i) => i.title)).toEqual([
      "评审 PRD",
      "修复登录",
      "写技术方案",
    ]);
  });

  it("dueDate asc：空日期排最后", () => {
    const withDates = [
      item({ id: 1, dueDate: "" }),
      item({ id: 2, dueDate: "2026-09-20T00:00:00.000Z" }),
      item({ id: 3, dueDate: "2026-09-15T00:00:00.000Z" }),
    ];
    expect(sortItems(withDates, [{ field: "dueDate", dir: "asc" }]).map((i) => i.id)).toEqual([
      3,
      2,
      1,
    ]);
  });
});

describe("groupItems", () => {
  it("status 分组：四组全保留（含空组）", () => {
    const groups = groupItems(items, "status");
    expect(groups.map((g) => g.key)).toEqual([
      "not_started",
      "in_progress",
      "paused",
      "done",
    ]);
    expect(groups.find((g) => g.key === "paused")?.items).toEqual([]);
    expect(groups.find((g) => g.key === "in_progress")?.items).toEqual([items[0]]);
  });

  it("priority 分组：P0-P3 四组", () => {
    expect(groupItems(items, "priority").map((g) => g.key)).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
    ]);
  });

  it("assignee 分组：unassigned + 候选成员组（无事项成员也保留空组）", () => {
    const members = [
      { userId: 7, nickname: "黄", username: "hjx", role: "owner" },
      { userId: 9, nickname: "九", username: "u9", role: "member" },
    ];
    const groups = groupItems(items, "assignee", members);
    expect(groups.map((g) => g.key)).toEqual(["unassigned", "7", "9"]);
    expect(groups.find((g) => g.key === "unassigned")?.items).toEqual([items[2]]);
    expect(groups.find((g) => g.key === "9")?.items).toEqual([]);
  });

  it("assignee 分组：无候选时按数据内出现的 assigneeId 生成组", () => {
    expect(groupItems(items, "assignee").map((g) => g.key)).toEqual([
      "unassigned",
      "7",
      "8",
    ]);
  });
});

describe("parseViewConfig 容错", () => {
  it("合法 JSON 解析；畸形/形状不符降级空配置", () => {
    expect(parseViewConfig("{}", "[]")).toEqual({ conditions: [], sortRules: [] });
    expect(
      parseViewConfig(
        JSON.stringify({ conditions: [{ field: "status", op: "in", value: ["done"] }] }),
        JSON.stringify([{ field: "dueDate", dir: "asc" }]),
      ),
    ).toEqual({
      conditions: [{ field: "status", op: "in", value: ["done"] }],
      sortRules: [{ field: "dueDate", dir: "asc" }],
    });
    expect(parseViewConfig("not-json{", "[[")).toEqual({
      conditions: [],
      sortRules: [],
    });
    expect(parseViewConfig(JSON.stringify({ nope: 1 }), "42")).toEqual({
      conditions: [],
      sortRules: [],
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-view-engine.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现引擎**

```ts
// src-react/domains/project/model/plan-view-engine.ts
/**
 * 计划视图筛选引擎（子系统 A spec §前端）：视图配置（filterJson/sortJson/
 * groupBy）的解释执行层，三纯函数 + 容错解析。所有视图（表格/看板及 C 阶段
 * 列表/甘特/日历）共用；非法条件/规则防御性忽略（单视图坏配置不打崩计划 Tab）。
 */
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type PlanItemRecord,
} from "../../../../electron/domains/project/plan-item.entity";

export interface FilterCondition {
  field: "title" | "status" | "assigneeId" | "source" | "priority" | "tags";
  op: "contains" | "in" | "notIn" | "isMe";
  value: string | string[];
}

export type SortField = "status" | "priority" | "dueDate" | "createdAt" | "title";
export interface SortRule {
  field: SortField;
  dir: "asc" | "desc";
}

export type GroupByField = "status" | "priority" | "assignee";
export interface ItemGroup {
  key: string;
  items: PlanItemRecord[];
}

const FILTER_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "status",
  "assigneeId",
  "source",
  "priority",
  "tags",
]);
const FILTER_OPS: ReadonlySet<string> = new Set([
  "contains",
  "in",
  "notIn",
  "isMe",
]);
const SORT_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "priority",
  "dueDate",
  "createdAt",
  "title",
]);

/** 值规整为数组（contains 单值也归一） */
const valueList = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

/** 单条件匹配（未知 field/op 恒真 = 忽略） */
function matchCondition(
  item: PlanItemRecord,
  condition: FilterCondition,
  currentUserId: number,
): boolean {
  const values = valueList(condition.value).map(String);
  switch (`${condition.field}:${condition.op}`) {
    case "title:contains":
      return item.title.toLowerCase().includes(values[0]?.toLowerCase() ?? "");
    case "status:in":
      return values.includes(item.status);
    case "status:notIn":
      return !values.includes(item.status);
    case "priority:in":
      return values.includes(item.priority);
    case "priority:notIn":
      return !values.includes(item.priority);
    case "source:in":
      return values.includes(item.source);
    case "source:notIn":
      return !values.includes(item.source);
    case "assigneeId:in":
      return item.assigneeId !== null && values.includes(String(item.assigneeId));
    case "assigneeId:notIn":
      return item.assigneeId === null || !values.includes(String(item.assigneeId));
    case "assigneeId:isMe":
      return item.assigneeId === currentUserId;
    case "tags:contains":
      return values.some((tag) => item.tags.includes(tag));
    default:
      return true;
  }
}

/** 筛选 + 搜索（标题子串，大小写不敏感）：条件 AND；搜索为独立参数叠加 */
export function filterItems(
  items: PlanItemRecord[],
  conditions: FilterCondition[],
  searchKeyword: string,
  currentUserId: number,
): PlanItemRecord[] {
  const keyword = searchKeyword.trim().toLowerCase();
  const valid = conditions.filter(
    (condition) =>
      FILTER_FIELDS.has(condition.field) &&
      FILTER_OPS.has(condition.op) &&
      condition.value !== undefined &&
      condition.value !== null,
  );
  return items.filter(
    (item) =>
      valid.every((condition) => matchCondition(item, condition, currentUserId)) &&
      (keyword === "" || item.title.toLowerCase().includes(keyword)),
  );
}

/** 缺省序（视图无排序规则时沿用现状）：状态序 → sortOrder → id */
function compareDefault(a: PlanItemRecord, b: PlanItemRecord): number {
  const statusGap =
    PLAN_STATUSES.indexOf(a.status) - PLAN_STATUSES.indexOf(b.status);
  if (statusGap !== 0) {
    return statusGap;
  }
  return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id - b.id;
}

/** 规则字段取值（用于比较器） */
function sortValue(item: PlanItemRecord, field: SortField): string | number {
  if (field === "status") {
    return PLAN_STATUSES.indexOf(item.status);
  }
  if (field === "priority") {
    return PLAN_PRIORITIES.indexOf(item.priority);
  }
  if (field === "dueDate" || field === "createdAt") {
    return item[field] || "";
  }
  return item[field].toLowerCase();
}

/** 排序：规则数组按序比较；空规则走缺省序；空字符串日期恒排最后 */
export function sortItems(
  items: PlanItemRecord[],
  rules: SortRule[],
): PlanItemRecord[] {
  const valid = rules.filter(
    (rule) => SORT_FIELDS.has(rule.field) && (rule.dir === "asc" || rule.dir === "desc"),
  );
  if (valid.length === 0) {
    return [...items].sort(compareDefault);
  }
  return [...items].sort((a, b) => {
    for (const rule of valid) {
      const va = sortValue(a, rule.field);
      const vb = sortValue(b, rule.field);
      const aEmpty = va === "";
      const bEmpty = vb === "";
      if (aEmpty !== bEmpty) {
        return aEmpty ? 1 : -1;
      }
      if (va !== vb) {
        const gap = va < vb ? -1 : 1;
        return rule.dir === "asc" ? gap : -gap;
      }
    }
    return compareDefault(a, b);
  });
}

/** 分组：全枚举组保留（看板空列也显示）；assignee = unassigned + 候选成员 + 数据内出现者 */
export function groupItems(
  items: PlanItemRecord[],
  groupBy: GroupByField,
  assigneeOptions?: ProjectMemberItem[],
): ItemGroup[] {
  if (groupBy === "assignee") {
    const groups = new Map<string, PlanItemRecord[]>([["unassigned", []]]);
    assigneeOptions?.forEach((member) =>
      groups.set(String(member.userId), []),
    );
    items.forEach((item) => {
      const key = item.assigneeId === null ? "unassigned" : String(item.assigneeId);
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    });
    const order = ["unassigned", ...(assigneeOptions?.map((m) => String(m.userId)) ?? [])];
    const extras = [...groups.keys()].filter((key) => !order.includes(key)).sort((a, b) => Number(a) - Number(b));
    return [...order, ...extras].map((key) => ({ key, items: groups.get(key) ?? [] }));
  }
  const keys =
    groupBy === "status" ? PLAN_STATUSES : PLAN_PRIORITIES;
  return keys.map((key) => ({
    key,
    items: items.filter((item) =>
      groupBy === "status" ? item.status === key : item.priority === key,
    ),
  }));
}

/** 视图配置容错解析：畸形 JSON / 形状不符 → 空配置 */
export function parseViewConfig(
  filterJson: string,
  sortJson: string,
): { conditions: FilterCondition[]; sortRules: SortRule[] } {
  let conditions: FilterCondition[] = [];
  let sortRules: SortRule[] = [];
  try {
    const parsed: unknown = JSON.parse(filterJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { conditions?: unknown }).conditions)
    ) {
      conditions = (parsed as { conditions: FilterCondition[] }).conditions;
    }
  } catch {
    // 降级空配置
  }
  try {
    const parsed: unknown = JSON.parse(sortJson);
    if (Array.isArray(parsed)) {
      sortRules = parsed as SortRule[];
    }
  } catch {
    // 降级空规则
  }
  return { conditions, sortRules };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/project/plan-view-engine.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/model/plan-view-engine.ts tests/project/plan-view-engine.test.ts
git commit -m "feat(project): 计划视图筛选引擎——filter/sort/group 三纯函数 + 视图配置容错解析"
```

---

### Task 7: usePlanViews hook（视图查询 + draft 态 + 保存动作）

**Files:**
- Create: `src-react/domains/project/model/use-plan-views.ts`
- Test: `tests/project/use-plan-views.test.ts`（纯函数部分）+ 组件集成测试在 Task 8/9

**Interfaces:**
- Consumes: Task 5 的 `PlanViewApi/PLAN_VIEWS_KEY`、Task 6 的 `parseViewConfig/FilterCondition/SortRule`、Task 4 的 `PlanViewRecord/PlanViewType/PlanGroupBy`
- Produces（Task 8/9/10/11 依赖）:

```ts
export interface PlanViewDraft {
  conditions: FilterCondition[];
  sortRules: SortRule[];
  groupBy: PlanGroupBy | null;
}

/** 纯函数：初始激活视图解析（可独立单测） */
export function resolveInitialViewId(
  views: PlanViewRecord[],
  viewIdParam: string | null,
  legacyViewParam: string | null,
): number | null;

/** hook：PlanPane 顶层调用 */
export function usePlanViews(projectId: number): {
  views: PlanViewRecord[];
  isLoading: boolean;
  isError: boolean;
  activeView: PlanViewRecord | undefined;
  activeViewId: number | null;
  setActiveViewId: (id: number) => void;
  draft: PlanViewDraft;
  setDraft: (updater: (prev: PlanViewDraft) => PlanViewDraft) => void;
  isDirty: boolean;
  resetDraft: () => void;
  saveOverwrite: () => Promise<void>;
  saveAsNew: (name: string) => Promise<void>;
  addView: (type: PlanViewType) => Promise<void>;
  renameView: (id: number, name: string) => Promise<void>;
  removeView: (id: number) => Promise<void>;
  changeType: (type: PlanViewType) => Promise<void>;
};
```

- [ ] **Step 1: 写失败的纯函数测试**

```ts
// tests/project/use-plan-views.test.ts
/** usePlanViews 纯函数部分测试：resolveInitialViewId 的 viewId 直取 /
 * 旧 ?view= 按 type 映射 / 失效回退首个 */
import { describe, expect, it } from "vitest";
import { resolveInitialViewId } from "../../src-react/domains/project/model/use-plan-views";
import type { PlanViewRecord } from "../../electron/domains/project/plan-view.entity";

const view = (over: Partial<PlanViewRecord>): PlanViewRecord => ({
  id: 1,
  projectId: 11,
  name: "",
  type: "table",
  groupBy: null,
  filterJson: "{}",
  sortJson: "[]",
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("resolveInitialViewId", () => {
  const views = [
    view({ id: 10, type: "table", sortOrder: 0 }),
    view({ id: 11, type: "kanban", sortOrder: 1 }),
  ];

  it("viewId 参数命中 → 直取", () => {
    expect(resolveInitialViewId(views, "11", null)).toBe(11);
  });

  it("旧参数 ?view=kanban → 按 type 映射（平滑兼容）", () => {
    expect(resolveInitialViewId(views, null, "kanban")).toBe(11);
    expect(resolveInitialViewId(views, null, "table")).toBe(10);
  });

  it("viewId 失效/无参数 → 回退首个", () => {
    expect(resolveInitialViewId(views, "999", null)).toBe(10);
    expect(resolveInitialViewId(views, null, null)).toBe(10);
    expect(resolveInitialViewId([], null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/use-plan-views.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 hook**

```ts
// src-react/domains/project/model/use-plan-views.ts
/**
 * 计划视图状态 hook（子系统 A spec §前端）：视图列表 React Query（首次
 * 懒播种在后端）+ 激活视图（?viewId= 路由参数，兼容旧 ?view=）+ draft
 * 未保存调整态（切换视图/刷新即丢弃）+ 保存两动作（saveAsNew 命名新建 /
 * saveOverwrite 覆盖回写）+ 视图增删改名与类型切换（立即保存）。
 * 变更走乐观更新 setQueryData、失败 invalidate 回滚 + toast（PlanPane 惯例）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import PlanViewApi, { PLAN_VIEWS_KEY } from "../api/plan-view.api";
import type {
  PlanGroupBy,
  PlanViewRecord,
  PlanViewType,
} from "../../../../electron/domains/project/plan-view.entity";
import type {
  FilterCondition,
  SortRule,
} from "./plan-view-engine";
import { parseViewConfig } from "./plan-view-engine";

export interface PlanViewDraft {
  conditions: FilterCondition[];
  sortRules: SortRule[];
  groupBy: PlanGroupBy | null;
}

/** 初始激活视图：viewId 参数直取 → 旧 ?view= 按 type 映射 → 回退首个 */
export function resolveInitialViewId(
  views: PlanViewRecord[],
  viewIdParam: string | null,
  legacyViewParam: string | null,
): number | null {
  const byId = Number(viewIdParam);
  if (viewIdParam && views.some((v) => v.id === byId)) {
    return byId;
  }
  if (legacyViewParam) {
    const matched = views.find((v) => v.type === legacyViewParam);
    if (matched) {
      return matched.id;
    }
  }
  return views[0]?.id ?? null;
}

/** 视图记录 → draft 初值（容错解析） */
function toDraft(view: PlanViewRecord): PlanViewDraft {
  const { conditions, sortRules } = parseViewConfig(view.filterJson, view.sortJson);
  return { conditions, sortRules, groupBy: view.groupBy };
}

/** draft 与视图持久化配置是否一致（不一致 = 已修改） */
function isSameDraft(a: PlanViewDraft, b: PlanViewDraft): boolean {
  return (
    JSON.stringify([a.conditions, a.sortRules, a.groupBy]) ===
    JSON.stringify([b.conditions, b.sortRules, b.groupBy])
  );
}

export function usePlanViews(projectId: number) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const viewsQuery = useQuery({
    queryKey: PLAN_VIEWS_KEY(projectId),
    queryFn: () => PlanViewApi.list(projectId),
  });
  const views = useMemo(() => viewsQuery.data ?? [], [viewsQuery.data]);

  const initialId = resolveInitialViewId(
    views,
    searchParams.get("viewId"),
    searchParams.get("view"),
  );
  const [activeViewId, setActiveViewIdState] = useState<number | null>(null);

  // 初次解析或参数指向失效视图时对齐（参数优先，回退首个）
  useEffect(() => {
    if (initialId !== null && initialId !== activeViewId) {
      setActiveViewIdState(initialId);
    }
  }, [initialId, activeViewId]);

  const activeView = views.find((v) => v.id === activeViewId);

  // draft：激活视图变化时重置为该视图配置（未保存调整随之丢弃）
  const [draft, setDraftState] = useState<PlanViewDraft>({
    conditions: [],
    sortRules: [],
    groupBy: null,
  });
  useEffect(() => {
    if (activeView) {
      setDraftState(toDraft(activeView));
    }
  }, [activeView?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = activeView ? !isSameDraft(draft, toDraft(activeView)) : false;

  /** 合并式写入 ?viewId=（清掉旧 ?view=，保留 ?tab= 等） */
  const setActiveViewId = useCallback(
    (id: number) => {
      setActiveViewIdState(id);
      setSearchParams(
        (prev) => {
          prev.set("viewId", String(id));
          prev.delete("view");
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setDraft = useCallback(
    (updater: (prev: PlanViewDraft) => PlanViewDraft) => {
      setDraftState((prev) => updater(prev));
    },
    [],
  );

  const resetDraft = useCallback(() => {
    if (activeView) {
      setDraftState(toDraft(activeView));
    }
  }, [activeView]);

  /** draft → 序列化配置（保存动作共用） */
  const serializeDraft = (current: PlanViewDraft): string => {
    return JSON.stringify({ conditions: current.conditions });
  };

  /** 视图写通道统一容错：失败 invalidate 回滚 + toast；成功返回 true */
  const runViewMutation = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        await queryClient.invalidateQueries({
          queryKey: PLAN_VIEWS_KEY(projectId),
        });
        toast.error(mapIpcError(error));
        return false;
      } finally {
        await queryClient.invalidateQueries({
          queryKey: PLAN_VIEWS_KEY(projectId),
        });
      }
    },
    [projectId, queryClient],
  );

  /** 覆盖保存：draft 回写当前视图 */
  const saveOverwrite = useCallback(async () => {
    if (!activeView) {
      return;
    }
    await runViewMutation(() =>
      PlanViewApi.update({
        id: activeView.id,
        groupBy: draft.groupBy,
        filterJson: serializeDraft(draft),
        sortJson: JSON.stringify(draft.sortRules),
      }),
    );
  }, [activeView, draft, runViewMutation]);

  /** 保存为新视图：克隆当前视图类型与 draft 配置（重名后端自动后缀） */
  const saveAsNew = useCallback(
    async (name: string) => {
      const created = await PlanViewApi.create({
        projectId,
        name,
        type: activeView?.type ?? "table",
        groupBy: draft.groupBy,
        filterJson: serializeDraft(draft),
        sortJson: JSON.stringify(draft.sortRules),
      }).catch(async (error) => {
        toast.error(mapIpcError(error));
        return null;
      });
      if (!created) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: PLAN_VIEWS_KEY(projectId),
      });
      setActiveViewId(created.id);
    },
    [activeView, draft, projectId, queryClient, setActiveViewId],
  );

  /** 新建视图（+ 菜单）：type 直接建，激活之 */
  const addView = useCallback(
    async (type: PlanViewType) => {
      const created = await PlanViewApi.create({ projectId, type }).catch(
        async (error) => {
          toast.error(mapIpcError(error));
          return null;
        },
      );
      if (!created) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: PLAN_VIEWS_KEY(projectId),
      });
      setActiveViewId(created.id);
    },
    [projectId, queryClient, setActiveViewId],
  );

  /** 重命名 / 删除 / 类型切换（立即保存，不走 draft） */
  const renameView = useCallback(
    async (id: number, name: string) => {
      await runViewMutation(() => PlanViewApi.update({ id, name }));
    },
    [runViewMutation],
  );

  const removeView = useCallback(
    async (id: number) => {
      const ok = await runViewMutation(() => PlanViewApi.remove(id));
      if (ok) {
        const rest = views.filter((v) => v.id !== id);
        if (rest.length > 0 && activeViewId === id) {
          setActiveViewId(rest[0].id);
        }
      }
    },
    [runViewMutation, views, activeViewId, setActiveViewId],
  );

  const changeType = useCallback(
    async (type: PlanViewType) => {
      if (!activeView || activeView.type === type) {
        return;
      }
      await runViewMutation(() =>
        PlanViewApi.update({ id: activeView.id, type }),
      );
    },
    [activeView, runViewMutation],
  );

  return {
    views,
    isLoading: viewsQuery.isLoading,
    isError: viewsQuery.isError,
    activeView,
    activeViewId,
    setActiveViewId,
    draft,
    setDraft,
    isDirty,
    resetDraft,
    saveOverwrite,
    saveAsNew,
    addView,
    renameView,
    removeView,
    changeType,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/project/use-plan-views.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/model/use-plan-views.ts tests/project/use-plan-views.test.ts
git commit -m "feat(project): usePlanViews 视图状态 hook——激活解析/draft 态/保存两动作/增删改名"
```

---

### Task 8: PlanPane 接入视图数据流（?viewId + 引擎替换 + 极简 Tab）

**Files:**
- Modify: `src-react/domains/project/components/PlanPane.tsx`
- Test: `tests/project/plan-table.test.tsx`、`tests/project/plan-kanban.test.tsx`（集成 mock 更新）

**Interfaces:**
- Consumes: Task 7 的 `usePlanViews`、Task 6 的 `filterItems/sortItems`、Task 3 的 `ProjectApi.listMembers`
- Produces:
  - PlanPane 渲染 `visibleItems = sortItems(filterItems(items, draft.conditions, search, user.id), draft.sortRules)`
  - 工具栏旧三组 `FilterMenu` 的 `onToggle` 改写 `draft.conditions`（同字段 `in` 条件；本任务仅换数据流，UI 面板 Task 10 替换）
  - 顶部视图 Tab 行（极简：激活切换；完整交互 Task 9）

**注意**：本任务是「数据流换轨」——UI 外观基本不变（旧筛选菜单保留），风险集中在 mock 与回归。

- [ ] **Step 1: 更新集成测试的 mock（先改测试定义预期）**

`tests/project/plan-table.test.tsx` 与 `tests/project/plan-kanban.test.tsx` 的 mock 区追加（放在现有 `PlanItemApi` mock 旁；mock 形状对照两文件现有写法）：

```ts
const planViewMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
}));
vi.mock("../../src-react/domains/project/api/plan-view.api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src-react/domains/project/api/plan-view.api")>();
  return { ...actual, default: planViewMock, PLAN_VIEWS_KEY: actual.PLAN_VIEWS_KEY };
});

const projectApiMock = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock("../../src-react/domains/project/api/project.api", () => ({
  default: projectApiMock,
}));
```

beforeEach 中给默认数据：

```ts
planViewMock.list.mockResolvedValue([
  { id: 10, projectId: 11, name: "", type: "table", groupBy: null, filterJson: "{}", sortJson: "[]", sortOrder: 0, createdAt: "", updatedAt: "" },
  { id: 11, projectId: 11, name: "", type: "kanban", groupBy: null, filterJson: "{}", sortJson: "[]", sortOrder: 1, createdAt: "", updatedAt: "" },
]);
projectApiMock.listMembers.mockResolvedValue([
  { userId: 1, nickname: "我", username: "me", role: "owner" },
]);
```

追加一条集成断言（plan-table）：「`?view=kanban`（旧参数）初始渲染看板视图（resolveInitialViewId 映射）」——render 路由 initialEntries 带 `?tab=plan&view=kanban`，断言看板列元素出现。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-table.test.tsx tests/project/plan-kanban.test.tsx`
Expected: FAIL（PlanPane 未消费 PlanViewApi，新增断言不成立）

- [ ] **Step 3: 改造 PlanPane**

`PlanPane.tsx` 关键改动（保持既有行内变更/弹窗/删除逻辑不动）：

1. import 换血：删 `PlanView` type 与 `switchView`/`viewButtonClass`（工具栏双按钮视图切换块删除）；加：

```ts
import { usePlanViews } from "../model/use-plan-views";
import ProjectApi from "../api/project.api";
import { filterItems, sortItems } from "../model/plan-view-engine";
import type { FilterCondition } from "../model/plan-view-engine";
import { useQuery } from "@tanstack/react-query"; // 已有则不重复
```

2. 组件体内替换筛选 state 与视图推导：

```ts
  const { views, activeView, activeViewId, setActiveViewId, draft, setDraft } =
    usePlanViews(projectId);

  /** 成员列表（处理人筛选/看板 assignee 分组候选） */
  const { data: members = [] } = useQuery({
    queryKey: ["projectMembers", projectId],
    queryFn: () => ProjectApi.listMembers(projectId),
  });

  const [search, setSearch] = useState("");
```

（删除 `statusFilter/priorityFilter/tagFilter` 三个 useState 与 `view` 推导。）

3. 旧三组 FilterMenu 的 `onToggle` 改写 draft（同字段互斥为单条 `in` 条件）：

```ts
  /** 多选维度 → draft 单条件（in）切换 */
  const toggleDraftIn = (field: "status" | "priority", value: string) => {
    setDraft((prev) => {
      const condition = prev.conditions.find((c) => c.field === field);
      const current = condition && Array.isArray(condition.value) ? condition.value : [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      const rest = prev.conditions.filter((c) => c.field !== field);
      return {
        ...prev,
        conditions: next.length > 0
          ? [...rest, { field, op: "in" as const, value: next }]
          : rest,
      };
    });
  };
```

标签 FilterMenu 同理（field `tags`、op `contains`、value 数组）。FilterMenu 的 `selected` 入参改为从 `draft.conditions` 取对应条件 value 数组（`selectedStatus` 等局部变量）。

4. `visibleItems` 替换为引擎（删除 matchesFilter 链与 compareItems——compareItems 移入引擎为缺省序，删除本地副本）：

```ts
  const visibleItems = useMemo(
    () =>
      sortItems(
        filterItems(items, draft.conditions, search, user.id),
        draft.sortRules,
      ),
    [items, draft.conditions, draft.sortRules, search, user.id],
  );
```

5. 工具栏双按钮视图切换块替换为极简 Tab 行（放在工具栏上方一行，完整交互 Task 9 替换该块）：

```tsx
      {/* 视图 Tab（子系统 A：完整交互在 PlanViewTabs 任务替换） */}
      <div className="flex items-center gap-1 border-b border-border/50 px-4 py-1.5">
        {views.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={entry.id === activeViewId}
            onClick={() => setActiveViewId(entry.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              entry.id === activeViewId
                ? "bg-primary-subtle font-medium text-primary"
                : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
            )}
          >
            {entry.name || t(`project:planView.type${entry.type.charAt(0).toUpperCase()}${entry.type.slice(1)}`)}
          </button>
        ))}
      </div>
```

6. 内容区 `view === "kanban"` 改 `activeView?.type === "kanban"`。

7. i18n：`zh-CN/project.json` 加 `planView` 段（en-US 同步英文值）：

```json
  "planView": {
    "typeTable": "表格",
    "typeKanban": "看板",
    "typeList": "列表",
    "typeGantt": "甘特",
    "typeCalendar": "日历"
  },
```

- [ ] **Step 4: 运行全部计划相关测试 + typecheck**

Run: `npm run test -- tests/project && npm run typecheck`
Expected: 全部 PASS（旧用例在新数据流下行为不变）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/PlanPane.tsx src-react/i18n/locales tests/project/plan-table.test.tsx tests/project/plan-kanban.test.tsx
git commit -m "refactor(project): PlanPane 换轨视图驱动——usePlanViews + 引擎过滤 + ?viewId 路由（旧 ?view= 兼容）"
```

---

### Task 9: PlanViewTabs 完整交互（增删改名 + 保存为新视图 + 已修改圆点）

**Files:**
- Create: `src-react/domains/project/components/PlanViewTabs.tsx`
- Create: `src-react/domains/project/components/PlanViewNameDialog.tsx`（重命名与「保存为新视图」共用的命名弹窗）
- Modify: `src-react/domains/project/components/PlanPane.tsx`（Task 8 的极简 Tab 行替换为本组件）
- Modify: `src-react/i18n/locales/zh-CN/project.json`、`en-US/project.json`
- Test: `tests/project/plan-view-tabs.test.tsx`

**Interfaces:**
- Consumes: Task 7 hook 的 `views/activeViewId/setActiveViewId/isDirty/addView/renameView/removeView/saveAsNew`、Task 4 的 `PLAN_VIEW_TYPES/PLAN_VIEW_NAME_KEYS`
- Produces:

```ts
// PlanViewTabs.tsx
export default function PlanViewTabs(props: {
  views: PlanViewRecord[];
  activeViewId: number | null;
  isDirty: boolean;
  onSelect: (id: number) => void;
  onAdd: (type: PlanViewType) => void;       // A 阶段仅 "kanban" 会触发
  onRename: (id: number, name: string) => void;
  onRemove: (id: number) => void;
}): JSX.Element;

// PlanViewNameDialog.tsx
export default function PlanViewNameDialog(props: {
  open: boolean;
  title: string;                              // i18n 后的标题
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败的组件测试**

```ts
// tests/project/plan-view-tabs.test.tsx
// @vitest-environment jsdom
/** PlanViewTabs 测试（mock 骨架沿用 plan-kanban.test.tsx：t 返回 key、
 * ResizeObserver/scrollIntoView 桩、react-i18next mock）：
 * Tab 渲染（默认视图 name 空串 → type 本地化 key）、激活态、+ 菜单仅看板、
 * hover ... 重命名/删除（最后一个视图无删除项）、isDirty 圆点、
 * PlanViewNameDialog 命名确认与空名禁用 */
```

（文件骨架：beforeAll 桩、`vi.mock("react-i18next")`、`vi.mock("sonner")` 与 plan-kanban.test.tsx:43-68 一致；用例列表如下，实现方式对照该文件 fireEvent 惯例）

- 「渲染两个默认 Tab：文案为 `project:planView.typeTable` / `typeKanban`（name 空串兜底）」
- 「点击第二个 Tab → onSelect(11)」
- 「`+` 菜单仅含「看板」项（A 阶段无列表/甘特/日历）；点击 → onAdd("kanban")」
- 「Tab hover `...` 菜单含重命名与删除；当 views.length === 1 时删除项不渲染」
- 「重命名 → PlanViewNameDialog 打开，初始名为当前名，确认 → onRename(id, "新名")；空名时确认按钮禁用」
- 「isDirty=true 时激活 Tab 显示已修改圆点（data-dirty 属性断言）」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-view-tabs.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

`PlanViewNameDialog.tsx`（shadcn Dialog + Input，风格对照 PlanItemDialog 的标题校验：trim 非空才可确认）：

```tsx
/**
 * 视图命名弹窗（重命名 / 保存为新视图共用）：标题与初始名外部传入，
 * trim 非空才可确认；Esc/取消关闭不动数据。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface PlanViewNameDialogProps {
  open: boolean;
  title: string;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}

export default function PlanViewNameDialog({
  open,
  title,
  initialName,
  onOpenChange,
  onConfirm,
}: PlanViewNameDialogProps) {
  const { t } = useTranslation(["project", "common"]);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) {
      setName(initialName);
    }
  }, [open, initialName]);

  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="rounded-lg border-border/50 shadow-lg sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={title}
          autoFocus
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button disabled={!trimmed} onClick={() => onConfirm(trimmed)}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`PlanViewTabs.tsx`（DropdownMenu 做 `+` 与 Tab `...` 菜单；样式遵守 hover 三件套与 `border-border/50`）：

```tsx
/**
 * 视图 Tab 栏（子系统 A spec §UI）：Tab 切换（激活高亮、默认视图 name
 * 空串显示本地化类型名）、+ 添加视图（A 阶段仅看板）、Tab hover ... 菜单
 * （重命名/删除；最后一个视图不显示删除）、isDirty 圆点。
 * 命名弹窗（重命名）内聚在本组件；「保存为新视图」入口在筛选面板（Task 10）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import PlanViewNameDialog from "./PlanViewNameDialog";
import { PLAN_VIEW_NAME_KEYS } from "../../../../electron/domains/project/plan-view.entity";
import type {
  PlanViewRecord,
  PlanViewType,
} from "../../../../electron/domains/project/plan-view.entity";

interface PlanViewTabsProps {
  views: PlanViewRecord[];
  activeViewId: number | null;
  isDirty: boolean;
  onSelect: (id: number) => void;
  onAdd: (type: PlanViewType) => void;
  onRename: (id: number, name: string) => void;
  onRemove: (id: number) => void;
}

/** A 阶段可添加的视图类型（列表/甘特/日历 C 阶段点亮） */
const ADDABLE_TYPES: PlanViewType[] = ["kanban"];

export default function PlanViewTabs({
  views,
  activeViewId,
  isDirty,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: PlanViewTabsProps) {
  const { t } = useTranslation(["project"]);
  const [renaming, setRenaming] = useState<PlanViewRecord | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null);

  return (
    <div className="flex items-center gap-1 border-b border-border/50 px-4 py-1.5">
      {views.map((view) => (
        <div key={view.id} className="group/tab relative flex items-center">
          <button
            type="button"
            aria-pressed={view.id === activeViewId}
            data-dirty={view.id === activeViewId && isDirty ? "true" : undefined}
            onClick={() => onSelect(view.id)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors",
              view.id === activeViewId
                ? "bg-primary-subtle font-medium text-primary"
                : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
            )}
          >
            {view.name || t(PLAN_VIEW_NAME_KEYS[view.type])}
            {view.id === activeViewId && isDirty && (
              <span
                title={t("project:planView.unsaved")}
                className="h-1.5 w-1.5 rounded-full bg-primary"
              />
            )}
          </button>
          <DropdownMenu
            open={menuOpenFor === view.id}
            onOpenChange={(open) => setMenuOpenFor(open ? view.id : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("project:planView.tabMenu")}
                className={cn(
                  "ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity",
                  "hover:bg-primary-subtle hover:text-primary group-hover/tab:opacity-100",
                )}
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="rounded-lg border border-border/50 shadow-lg"
            >
              <DropdownMenuItem
                onSelect={() => {
                  setRenaming(view);
                  setMenuOpenFor(null);
                }}
              >
                {t("project:planView.rename")}
              </DropdownMenuItem>
              {views.length > 1 && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => {
                    onRemove(view.id);
                    setMenuOpenFor(null);
                  }}
                >
                  {t("common:delete")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("project:planView.addView")}
            className="h-7 gap-0.5 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          {ADDABLE_TYPES.map((type) => (
            <DropdownMenuItem key={type} onSelect={() => onAdd(type)}>
              {t(PLAN_VIEW_NAME_KEYS[type])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <PlanViewNameDialog
        open={renaming !== null}
        title={t("project:planView.rename")}
        initialName={renaming?.name ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null);
          }
        }}
        onConfirm={(name) => {
          if (renaming) {
            onRename(renaming.id, name);
          }
          setRenaming(null);
        }}
      />
    </div>
  );
}
```

`PlanPane.tsx`：把 Task 8 的极简 Tab 行整块替换为：

```tsx
      <PlanViewTabs
        views={views}
        activeViewId={activeViewId}
        isDirty={isDirty}
        onSelect={setActiveViewId}
        onAdd={(type) => void addView(type)}
        onRename={(id, name) => void renameView(id, name)}
        onRemove={(id) => void removeView(id)}
      />
```

（hook 解构补 `isDirty/addView/renameView/removeView`。）

i18n `zh-CN/project.json` 的 `planView` 段补（en-US 同步）：

```json
    "rename": "重命名",
    "addView": "添加视图",
    "tabMenu": "视图操作",
    "unsaved": "有未保存的修改"
```

en-US：`"Rename"`、`"Add view"`、`"View actions"`、`"Unsaved changes"`。

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `npm run test -- tests/project/plan-view-tabs.test.tsx tests/project/plan-table.test.tsx tests/project/plan-kanban.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/PlanViewTabs.tsx src-react/domains/project/components/PlanViewNameDialog.tsx src-react/domains/project/components/PlanPane.tsx src-react/i18n/locales tests/project/plan-view-tabs.test.tsx
git commit -m "feat(project): 视图 Tab 栏——切换/添加看板/重命名/删除保护/已修改圆点/命名弹窗"
```

---

### Task 10: 组合筛选面板（条件增删 + 保存两动作 + 重置）

**Files:**
- Create: `src-react/domains/project/components/PlanFilterPopover.tsx`
- Modify: `src-react/domains/project/components/PlanPane.tsx`（删三组 FilterMenu，挂新面板 + 保存为新视图弹窗）
- Modify: `src-react/i18n/locales/zh-CN/project.json`、`en-US/project.json`
- Test: `tests/project/plan-filter-popover.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `draft/setDraft/isDirty/resetDraft/saveOverwrite/saveAsNew`、Task 3 的 `members`（`ProjectMemberItem[]`）
- Produces:

```ts
export default function PlanFilterPopover(props: {
  conditions: FilterCondition[];
  isDirty: boolean;
  members: ProjectMemberItem[];
  currentUserId: number;
  onChange: (updater: (prev: FilterCondition[]) => FilterCondition[]) => void;
  onReset: () => void;
  onSaveOverwrite: () => void;
  onSaveAsNew: (name: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败的组件测试**

```ts
// tests/project/plan-filter-popover.test.tsx
// @vitest-environment jsdom
/** 组合筛选面板测试（mock 骨架同 plan-view-tabs.test.tsx）：
 * 触发按钮（漏斗 + 已选条件计数徽标）；「+ 添加筛选条件」字段菜单六项；
 * 添加 status 条件 → 默认 op=in 值空；条件行删除；
 * title 条件值 Input 输入 → onChange 回调携带更新数组；
 * 状态/优先级/来源值控件为多选 checkbox（勾选即更新）；
 * 处理人条件可选 isMe（切换后值控件消失）；
 * ... 菜单三动作（保存为新视图打开命名弹窗 → onConfirm 走 onSaveAsNew；
 * 覆盖保存；重置）；isDirty 圆点显示 */
```

用例清单（fireEvent 对照现有测试惯例）：
- 「打开面板：显示 6 个可添加字段（标题/状态/处理人/来源/优先级/标签）」
- 「添加「状态」→ 条件行出现，勾选「进行中」→ onChange 回调的 conditions 含 `{field:"status",op:"in",value:["in_progress"]}`」
- 「「标题」条件输入「方案」→ onChange 含 `{field:"title",op:"contains",value:"方案"}`」
- 「「处理人」添加后默认 isMe；切到「指定成员」出现成员 checkbox」
- 「条件行删除按钮 → onChange 后该条件消失」
- 「`...` 菜单显示三项；「保存为新视图」打开命名弹窗，确认 → onSaveAsNew("高优")」
- 「isDirty=true 时 `...` 旁显示圆点；「重置」→ onReset 被调用」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-filter-popover.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现面板**

`PlanFilterPopover.tsx` 结构（Popover + DropdownMenu + 条件行渲染；每个字段一个值控件小组件，保持函数 ≤20 行拆分）：

```tsx
/**
 * 组合筛选面板（子系统 A spec §UI）：条件式组合筛选（AND），
 * 字段（标题/状态/处理人/来源/优先级/标签）× 操作符 × 值控件；
 * 顶部 ... 菜单：保存为新视图（命名弹窗）/ 覆盖保存 / 重置；
 * isDirty 圆点。值控件：标题=Input；状态/优先级/来源=多选 checkbox；
 * 处理人=isMe 切换 + 成员多选；标签=候选多选（成员与标签候选由父层传入）。
 */
```

实现要点（完整 JSX 按 PlanViewTabs 风格写，此处列关键约定）：
- 触发按钮：`ListFilter` 图标 + `conditions.length > 0` 时 Badge 计数，hover 三件套样式。
- `Popover`（`@/components/ui/popover`）内：条件行列表（每行：字段 Select（禁改，删了重加）、操作符 Select（title=contains 固定；assigneeId=isMe|in；枚举字段=in|notIn；tags=contains 固定）、值控件、行删除按钮）+ 底部 `+ 添加筛选条件` DropdownMenu（六字段，已存在字段禁用）。
- 值控件映射：`title/tags` → Input；`status` → PLAN_STATUSES checkbox 组（label 用 STATUS_LABEL_KEYS）；`priority` → PLAN_PRIORITIES checkbox 组；`source` → PLAN_SOURCES checkbox 组（label 新 i18n key `sourceManual/sourceAi/sourceTemplate`）；`assigneeId` → isMe 时无控件，in 时 members checkbox 组（label 用 nickname）。
- `...` 菜单（面板右上角）：`保存为新视图`（打开内聚的 PlanViewNameDialog，确认调 `onSaveAsNew`）、`覆盖保存`、`重置`（onReset）。isDirty 圆点：`data-dirty` 标记 + `bg-primary` 圆点 span。

`PlanPane.tsx`：删除三个 `FilterMenu` 调用与 `FilterMenu` 组件定义、`toggleDraftIn` 及标签切换逻辑，工具栏挂：

```tsx
        <PlanFilterPopover
          conditions={draft.conditions}
          isDirty={isDirty}
          members={members}
          currentUserId={user.id}
          onChange={(updater) =>
            setDraft((prev) => ({ ...prev, conditions: updater(prev.conditions) }))
          }
          onReset={resetDraft}
          onSaveOverwrite={() => void saveOverwrite()}
          onSaveAsNew={(name) => void saveAsNew(name)}
        />
```

i18n `planView` 段补（en-US 同步）：

```json
    "filter": "筛选",
    "addCondition": "添加筛选条件",
    "fieldTitle": "标题",
    "fieldStatus": "状态",
    "fieldAssignee": "处理人",
    "fieldSource": "来源",
    "fieldPriority": "优先级",
    "fieldTags": "标签",
    "opIsMe": "是我",
    "opIn": "是以下任一",
    "opNotIn": "不是以下任一",
    "opContains": "包含",
    "sourceManual": "手动创建",
    "sourceAi": "AI 生成",
    "sourceTemplate": "模版导入",
    "saveAsNew": "保存为新视图",
    "saveAsNewTitle": "保存为新视图",
    "overwriteSave": "覆盖保存",
    "reset": "重置"
```

（en-US 依次：`Filter`、`Add filter`、`Title`、`Status`、`Assignee`、`Source`、`Priority`、`Tags`、`Is me`、`Is any of`、`Is not`、`Contains`、`Manual`、`AI generated`、`From template`、`Save as new view`、`Save as new view`、`Overwrite`、`Reset`。）

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `npm run test -- tests/project && npm run typecheck && npm run lint`
Expected: 全部 PASS（PlanPane 旧 FilterMenu 相关用例已在 Task 8 改造过，此处确认无残留断言）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/PlanFilterPopover.tsx src-react/domains/project/components/PlanPane.tsx src-react/i18n/locales tests/project/plan-filter-popover.test.tsx
git commit -m "feat(project): 组合筛选面板——六字段条件增删 + 保存为新视图/覆盖保存/重置"
```

---

### Task 11: 视图设置 Popover（类型切换 + 分组依据 + 筛选入口）

**Files:**
- Create: `src-react/domains/project/components/PlanViewSettingsPopover.tsx`
- Modify: `src-react/domains/project/components/PlanPane.tsx`
- Modify: `src-react/i18n/locales/zh-CN/project.json`、`en-US/project.json`
- Test: `tests/project/plan-view-settings.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `changeType/draft/setDraft/activeView`、Task 10 的筛选面板打开态
- Produces:

```ts
export default function PlanViewSettingsPopover(props: {
  type: PlanViewType;
  groupBy: PlanGroupBy | null;
  showGroupBy: boolean;                 // 仅看板为 true
  onTypeChange: (type: PlanViewType) => void;   // 立即保存
  onGroupByChange: (groupBy: PlanGroupBy) => void; // 进 draft
}): JSX.Element;
```

- [ ] **Step 1: 写失败的组件测试**

用例清单（骨架同前）：
- 「触发按钮齿轮；面板含视图类型切换四选项（表格/看板/列表/甘特/日历中 A 阶段全部可选——类型值是持久化枚举，切换即 onTypeChange）」
- 「showGroupBy=false（表格）不渲染分组依据；true（看板）渲染 状态/优先级/处理人 三选项」
- 「选分组「优先级」→ onGroupByChange("priority")」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-view-settings.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`PlanViewSettingsPopover.tsx`：Popover + 两组 DropdownMenuSelectItem（shadcn `DropdownMenuRadioGroup` 可选）；类型组 label `project:planView.settingsType`、分组组 label `project:planView.settingsGroupBy`，分组依据选项 label：`plan.fieldStatus/plan.priority/plan.handleMan`（复用既有 key）。触发按钮 `Settings2` 图标 hover 三件套。

`PlanPane.tsx` 工具栏（搜索框与 `+ 添加` 之间）挂：

```tsx
        <PlanViewSettingsPopover
          type={activeView?.type ?? "table"}
          groupBy={draft.groupBy}
          showGroupBy={activeView?.type === "kanban"}
          onTypeChange={(type) => void changeType(type)}
          onGroupByChange={(groupBy) =>
            setDraft((prev) => ({ ...prev, groupBy }))
          }
        />
```

（视图类型枚举展示 A 阶段全列——`PLAN_VIEW_TYPES` 是持久化枚举且切换立即保存，选择 list/gantt/calendar 后内容区渲染回落 table 分支：`activeView?.type === "kanban" ? 看板 : 表格` 的既有写法天然回落。为避免误导，类型菜单只展示 `["table","kanban"]`：组件内用 `const SELECTABLE_TYPES: PlanViewType[] = ["table", "kanban"];` 与 Tab 添加菜单同策略。）

i18n 补：`"settings": "视图设置"`、`"settingsType": "视图类型"`、`"settingsGroupBy": "分组依据"`（en：`View settings` / `View type` / `Group by`）。

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `npm run test -- tests/project/plan-view-settings.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/PlanViewSettingsPopover.tsx src-react/domains/project/components/PlanPane.tsx src-react/i18n/locales tests/project/plan-view-settings.test.tsx
git commit -m "feat(project): 视图设置 Popover——类型切换立即保存 + 看板分组依据入 draft"
```

---

### Task 12: 看板分组化（groupBy 泛化 + 拖拽写回 + 成员头像）

**Files:**
- Modify: `src-react/domains/project/components/PlanKanbanView.tsx`
- Modify: `src-react/domains/project/components/PlanItemDialog.tsx`（加 `defaultPriority?: PlanPriority`）
- Modify: `src-react/domains/project/components/PlanPane.tsx`（handleMove 泛化分发）
- Test: `tests/project/plan-kanban.test.tsx`（computeDrop 泛化断言 + 新用例）

**Interfaces:**
- Consumes: Task 6 的 `groupItems/ItemGroup`、Task 7 的 `draft.groupBy`、Task 3 的 `members`
- Produces:

```ts
// PlanKanbanView.tsx 导出签名变化
export interface KanbanColumnData { key: string; items: PlanItemRecord[] }
export interface KanbanDropResult { columnKey: string; afterId?: number }
export function computeDrop(
  activeId: number,
  overId: string,
  columns: KanbanColumnData[],
): KanbanDropResult | null;

// 组件 props
{
  items: PlanItemRecord[];
  groupBy: PlanGroupBy;
  members: ProjectMemberItem[];
  currentUserId: number;
  onMoveItem: (id: number, columnKey: string, afterId?: number) => void;
  onQuickCreate: (preset: { status?: PlanStatus; priority?: PlanPriority }) => void;
  onEdit: (item: PlanItemRecord) => void;
}
```

**语义约定（spec 已批准的简化）**：`groupBy=status` 保留完整拖拽落点（跨列流转 + 列内重排，走 `planItem:move`）；`groupBy=priority/assignee` 拖拽跨列仅写回对应字段（`planItem:update`），列内不重排（afterId 忽略）——sortOrder 只属于状态列。

- [ ] **Step 1: 更新 computeDrop 测试（泛化列 key）**

`tests/project/plan-kanban.test.tsx` 的 computeDrop describe 更新：
- 列 id 匹配从 `PLAN_STATUSES.includes` 改为 `columns.some((c) => c.key === overId)`——现用例传 `status` 字段的 columns 改传 `{ key: status, items }` 形状，断言不变（返回值 `status` 改名 `columnKey`）。
- 追加：「priority 分组：跨列（P1 卡拖到 P0 列）→ `{ columnKey: "P0", afterId: ... }`」「assignee 分组：拖到 unassigned 列背景 → `{ columnKey: "unassigned" }`」。

追加组件级用例：
- 「groupBy=priority 渲染 P0-P3 四列（空列含计数 0）」
- 「groupBy=priority 拖拽结束（fireEvent DndContext 不可行——沿用纯函数覆盖语义，组件断言列渲染与列头 + 调用 onQuickCreate({ priority: "P1" })）」
- 「卡片头像：assigneeId=成员 8 → 成员昵称首字符；null → 未指派样式」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-kanban.test.tsx`
Expected: FAIL（props/形状不匹配）

- [ ] **Step 3: 实现泛化**

`PlanKanbanView.tsx` 关键改动：

1. `computeDrop` 列匹配泛化（`overId` 与 `column.key` 比较），返回 `{ columnKey, afterId }`；「同列原位」判定沿用（`activeColumn.key === overColumn.key`）。
2. 组件 props 换新签名；`columns` 由 `groupItems(items, groupBy, members)` 生成（import 引擎与成员类型）。
3. 列头 label 映射抽小组件函数：

```ts
function columnLabel(
  key: string,
  groupBy: PlanGroupBy,
  members: ProjectMemberItem[],
  t: TFunction,
): string {
  if (groupBy === "status") {
    return t(STATUS_LABEL_KEYS[key as PlanStatus]);
  }
  if (groupBy === "priority") {
    return t(PRIORITY_LABEL_KEYS[key as PlanPriority]);
  }
  if (key === "unassigned") {
    return t("project:plan.unassigned");
  }
  return members.find((m) => String(m.userId) === key)?.nickname ?? key;
}
```

4. 列头 `+`：`onQuickCreate(groupBy === "status" ? { status: key as PlanStatus } : groupBy === "priority" ? { priority: key as PlanPriority } : {})`。
5. 卡片头像：`item.assigneeId` 在 members 找昵称首字符，找不到/null → 灰点 + `t("project:plan.unassigned")` title（替换现「我」逻辑）。
6. `handleDragEnd` → `onMoveItem(Number(active.id), drop.columnKey, drop.afterId)`。

`PlanItemDialog.tsx`：props 加 `defaultPriority?: PlanPriority`（新建态预置优先级，编辑态忽略；回填 useEffect 加 `setPriority(item?.priority ?? defaultPriority ?? "P1")`，依赖数组补 `defaultPriority`）。

`PlanPane.tsx`：
- `handleMove` 改名 `handleMoveStatus`（原逻辑不动），新增分发：

```ts
  /** 看板拖拽分发：status 分组走 move（sortOrder 语义）；其余仅写字段 */
  const handleMoveItem = (id: number, columnKey: string, afterId?: number) => {
    if (draft.groupBy === "status") {
      return handleMoveStatus(id, columnKey as PlanStatus, afterId);
    }
    if (draft.groupBy === "priority") {
      return handleSetPriority(id, columnKey as PlanPriority);
    }
    if (draft.groupBy === "assignee") {
      return handleSetAssignee(id, columnKey === "unassigned" ? null : Number(columnKey));
    }
  };
```

- 新增 `handleSetAssignee`（乐观 patch + `PlanItemApi.update({ id, assigneeId })` + 失败回滚，照抄 `handleSetPriority` 模式）。
- 看板渲染处：`groupBy={draft.groupBy ?? "status"}`、`members={members}`、`currentUserId={user.id}`、`onMoveItem={handleMoveItem}`、`onQuickCreate={(preset) => { setEditingItem(undefined); setDialogDefaultStatus(preset.status ?? "not_started"); setDialogDefaultPriority(preset.priority); setDialogOpen(true); }}`（state 加 `dialogDefaultPriority`，打开重置处同步；PlanItemDialog 传入 `defaultPriority`）。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/PlanKanbanView.tsx src-react/domains/project/components/PlanItemDialog.tsx src-react/domains/project/components/PlanPane.tsx tests/project/plan-kanban.test.tsx
git commit -m "feat(project): 看板分组化——状态/优先级/处理人三泳道 + 拖拽写回对应字段 + 成员头像"
```

---

## 收尾验收（手动）

1. `npm run dev` 启动应用，进入任一项目 → 计划 Tab：
   - 视图 Tab 显示「表格」「看板」，URL `?tab=plan&viewId=10`；旧链接 `?view=kanban` 自动映射。
   - 首次进入老项目自动播种两条默认视图。
2. 筛选面板加条件（状态=进行中）→ Tab 出现已修改圆点 → `...` 保存为新视图「进行中事项」→ 新 Tab 出现且激活；切回原视图筛选已还原。
   - 覆盖保存 → 圆点消失，刷新后保持。
3. `+` 添加看板 → 新 Tab「看板(2)」；设置 Popover 分组依据切「优先级」→ P0-P3 四列；拖卡片跨列 → 优先级变化。
   - 处理人分组 → 成员列 + 未指派列；弹窗指派成员后卡片头像变化。
4. 删到只剩一个视图 → `...` 菜单无删除项（后端也拒删）。
5. 新建事项弹窗：开始/截止日期、P3、处理人成员选择；任务 Tab 本地任务仍为「我」。
6. 删除项目 → planView 级联清理（重进项目列表无残留，数据库检查 `SELECT * FROM planView WHERE projectId=<已删id>` 为空）。

## 自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：数据模型（T1/T2）、五通道+播种/重名/拒删/容错（T4）、级联（T5）、planItem 透传+成员校验（T2）、引擎三函数（T6）、draft+保存两动作（T7/T10）、视图 Tab+圆点（T8/T9）、类型切换立即保存/分组依据（T11）、看板分组与拖拽写回（T12）、路由兼容（T7/T8）、i18n 与主题合规（T3/T8/T9/T10/T11）——spec 各节均有对应任务；spec 后置项（排序 UI/Tab 拖拽/列配置/甘特日历列表渲染）未混入。
2. **占位符**：无 TBD/TODO；组件测试以用例清单+骨架引用形式给出（mock 骨架逐字引用既有文件行段，避免重复 60 行样板），其余均含完整代码。
3. **类型一致性**：`FilterCondition/SortRule/ItemGroup/PlanViewDraft` 在 T6/T7/T10/T12 间签名一致；`computeDrop` 返回值 T12 统一为 `columnKey`；`onQuickCreate` 泛化为 preset 对象在 T12 内闭环（PlanItemDialog `defaultPriority` 同任务配套）。


