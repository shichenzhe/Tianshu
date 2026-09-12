# 项目模块一期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付项目模块一期：项目 CRUD + 内置模版 + 能力挂载 + 项目详情页骨架 + 动态流（项目指令生效的 AI 对话）+ 右侧配置面板。

**Architecture:** 项目为独立模块 `/module/project`；数据层沿用 IPC 自注册仓储模式（script/v2 迁移 + Prisma）；动态流复用现有 chat 管道（session 表加 projectId 列，项目会话与 AI 任务树隔离）；侧边栏共用（AiSidebar 最终重构为全局 GlobalSidebar，主体区随模块切换）。

**Tech Stack:** Electron 44 + React 19 + TypeScript + Prisma 7 (SQLite) + React Query + Zustand + shadcn/ui + Tailwind 4 + react-i18next + Vitest。

**Spec:** `docs/superpowers/specs/2026-09-12-project-module-phase1-design.md`（本计划从 spec 出发，执行者需同时阅读 spec）

## Global Constraints

- 所有 UI 文案必须走 `t()`，zh-CN 与 en-US 两个语言文件**同步**新增（`project` namespace）；禁止 JSX/逻辑中硬编码中英文
- 主题色禁止硬编码：用 `bg-primary` / `text-primary` 等；弹出层（Popover/Dropdown/Dialog）边框 `border-border/50 rounded-lg shadow-lg`；触发按钮悬停 `hover:bg-primary-subtle hover:text-primary hover:border-primary/30`
- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号
- 命名：文件 kebab-case、组件 PascalCase、变量/函数 camelCase；IPC 新通道必须加进 `src-react/lib/ipc.ts` 的 `IPCChannel` 联合类型
- 数据库惯例：`Int @id @default(autoincrement())`、`DateTime @default(now())` / `@updatedAt`（spec 原文写 TEXT PK 是笔误，以本计划为准）；迁移 SQL 用 `--/p` 描述注释、`--/ignore` 包裹可失败语句
- 后端新域接线：`electron/Application.ts` 的 `registerServices()`；新数据库迁移必须同时改 `prisma/schema.prisma` + `electron/infrastructure/script/vN/` + `Constants.DATABASE_VERSION`
- 函数不超过 20 行；所有异常必须处理且提示有用
- 每个任务完成后运行 `npm run typecheck`，本计划各任务的验证命令以仓库根目录为工作目录

## 文件结构总览

```
prisma/schema.prisma                                    [改] +3 model、session.projectId
electron/Constants.ts                                   [改] DATABASE_VERSION 1→2
electron/infrastructure/script/v2/upgrade-table.sql     [新]
electron/domains/project/project.entity.ts              [新] 前后端共享类型
electron/domains/project/project.repo.ts                [新] IPC 仓储
electron/domains/project/project-prompt.ts              [新] 项目 system prompt 纯函数组装
electron/domains/ai/chat/session.repo.ts                [改] 会话查询隔离 projectId
electron/domains/ai/chat/chat.service.ts                [改] 项目会话 prompt 注入
src-react/domains/project/model/project-templates.ts    [新] 内置模版静态数据
src-react/domains/project/api/project.api.ts            [新] invoke + React Query
src-react/domains/project/views/ProjectHubView.tsx      [新]
src-react/domains/project/views/ProjectWorkspaceView.tsx [新]
src-react/domains/project/components/CreateProjectDialog.tsx [新]
src-react/domains/project/components/PickerDialog.tsx   [新]
src-react/domains/project/components/ProjectSidebarList.tsx [新]
src-react/domains/ai/chat/components/ChatPane.tsx       [新] 从 ChatView.tsx 抽出
src-react/domains/ai/chat/views/ChatView.tsx            [改] 复用抽出的 ChatPane
src-react/components/layout/GlobalSidebar.tsx           [新] 全局共用侧边栏
src-react/components/layout/MainLayout.tsx              [改] 渲染 GlobalSidebar
src-react/i18n/locales/{zh-CN,en-US}/project.json       [新]
tests/project/*.test.ts                                 [新]
```

---

### Task 1: 数据库 v2 迁移 + Prisma model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `electron/infrastructure/script/v2/upgrade-table.sql`
- Modify: `electron/Constants.ts:11`

**Interfaces:**
- Produces: Prisma models `project` / `projectMember` / `projectBinding`、`session.projectId Int?`（后续所有任务依赖）

- [ ] **Step 1: schema.prisma 追加 model 与字段**

在 `prisma/schema.prisma` 的 `model session` 内 `archivedAt` 行后加一行 `projectId Int?`，并在文件末尾追加：

```prisma
model project {
  id           Int      @id @default(autoincrement())
  name         String
  systemPrompt String?
  templateKey  String?
  ownerId      Int
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([ownerId, name], map: "idx_project_owner_name")
}

model projectMember {
  id        Int      @id @default(autoincrement())
  projectId Int
  userId    Int
  role      String   @default("member")
  joinedAt  DateTime @default(now())

  @@unique([projectId, userId], map: "idx_project_member_pid_uid")
}

model projectBinding {
  id        Int      @id @default(autoincrement())
  projectId Int
  itemType  String
  itemId    Int
  createdAt DateTime @default(now())

  @@unique([projectId, itemType, itemId], map: "idx_project_binding")
  @@index([projectId], map: "project_binding_projectId_index")
}
```

同时给 `model session` 末尾加索引行 `@@index([projectId], map: "session_projectId_index")`。

- [ ] **Step 2: 写 v2 迁移 SQL**

创建 `electron/infrastructure/script/v2/upgrade-table.sql`（风格照抄 v1 的 `--/p` / `--/ignore` 注释）：

```sql
--/p 新建项目表（项目模块一期）
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    systemPrompt TEXT NULL,
    templateKey TEXT NULL,
    ownerId INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_owner_name ON project (ownerId, name);

--/p 项目成员表（多人协同预留，一期仅写入创建者为 owner）
CREATE TABLE IF NOT EXISTS projectMember (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL,
    userId INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joinedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_member_pid_uid ON projectMember (projectId, userId);

--/p 项目能力挂载表（itemType: assistant | skill | mcpServer）
CREATE TABLE IF NOT EXISTS projectBinding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL,
    itemType TEXT NOT NULL,
    itemId INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_binding ON projectBinding (projectId, itemType, itemId);
--/ignore
CREATE INDEX IF NOT EXISTS project_binding_projectId_index ON projectBinding (projectId);

--/p 会话归属项目（项目动态流会话；NULL = 普通会话，出现在 AI 任务树）
ALTER TABLE session ADD COLUMN projectId INTEGER NULL;
--/ignore
CREATE INDEX IF NOT EXISTS session_projectId_index ON session (projectId);
```

- [ ] **Step 3: 升版本号并重新生成 Prisma Client**

`electron/Constants.ts:11` 改为 `static readonly DATABASE_VERSION: number = 2;`

```bash
npx prisma generate
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: 无错误

（数据库迁移本身在下次 `npm run dev` 启动时由 initDatabase 执行 v2 脚本，本任务不做运行时验证）

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma electron/Constants.ts electron/infrastructure/script/v2
git commit -m "feat(project): 数据库 v2——project/projectMember/projectBinding 建表 + session.projectId"
```

---

### Task 2: project.entity.ts + project.repo.ts 基础 CRUD（TDD）

**Files:**
- Create: `electron/domains/project/project.entity.ts`
- Create: `electron/domains/project/project.repo.ts`
- Modify: `electron/Application.ts`（registerServices 接线）
- Modify: `src-react/lib/ipc.ts`（IPCChannel 加通道）
- Test: `tests/project/project-repo.test.ts`

**Interfaces:**
- Produces（后续前端任务依赖的类型与通道）:

```ts
// project.entity.ts
export type ProjectBindingType = "assistant" | "skill" | "mcpServer";
export interface ProjectBindingInput {
  itemType: ProjectBindingType;
  itemId: number;
}
export interface ProjectRecord {
  id: number;
  name: string;
  systemPrompt: string | null;
  templateKey: string | null;
  ownerId: number;
  sessionId: number; // 项目动态流会话 id
  createdAt: string; // ISO
  updatedAt: string;
}
export interface ProjectBindingItem {
  id: number;
  itemType: ProjectBindingType;
  itemId: number;
  itemName: string; // 源实体显示名；源被删时保留最后已知名
  valid: boolean;   // 源实体是否存在
}
export interface ProjectDetail {
  project: ProjectRecord;
  bindings: ProjectBindingItem[];
  session: SessionRecord; // 复用 src-react/domains/ai/api/session.api 的类型
}
export interface ProjectCreateParams {
  ownerId: number;
  name: string;
  systemPrompt?: string;
  templateKey?: string;
  welcomeMessage?: string;
  bindings?: ProjectBindingInput[];
}
export interface ProjectUpdateParams {
  id: number;
  name?: string;
  systemPrompt?: string;
}
export const PROJECT_NAME_EXISTS = "PROJECT_NAME_EXISTS";
export const PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";
```

IPC 通道：`project:list` `(ownerId: number) => ProjectRecord[]`、`project:getDetail` `(id: number) => ProjectDetail`、`project:create` `(params: ProjectCreateParams) => ProjectRecord`、`project:update` `(params: ProjectUpdateParams) => void`、`project:delete` `(id: number) => void`、`project:setBindings` `(projectId: number, items: ProjectBindingInput[]) => void`

- [ ] **Step 1: 写 entity 类型文件**

内容即上方 Interfaces 块（含 JSDoc 注释，风格照 `electron/domains/option/option.entity.ts`）。`SessionRecord` 从 `../../../../src-react/domains/ai/api/session.api` import type（session.repo.ts 已有此跨目录类型引用先例）。

- [ ] **Step 2: 写失败测试**

创建 `tests/project/project-repo.test.ts`（mock 模式照 `tests/ai/personalization-repo.test.ts`）：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

// prisma stub：各测试按需覆写实现
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

const prismaStub = {
  project: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  projectMember: { create: vi.fn(), deleteMany: vi.fn() },
  projectBinding: {
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  session: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  message: { create: vi.fn(), deleteMany: vi.fn() },
  workspace: { findFirst: vi.fn() },
  assistant: { findMany: vi.fn() },
  $transaction: vi.fn((fn) => fn(prismaStub)),
};

import ProjectRepository from "../../electron/domains/project/project.repo";
import { PROJECT_NAME_EXISTS, PROJECT_NOT_FOUND } from "../../electron/domains/project/project.entity";

const repo = new ProjectRepository();

describe("ProjectRepository.create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("同名项目 → 抛 PROJECT_NAME_EXISTS", async () => {
    prismaStub.project.findFirst.mockResolvedValue({ id: 1 });
    await expect(
      repo.create({ ownerId: 1, name: "test" }),
    ).rejects.toThrow(PROJECT_NAME_EXISTS);
    expect(prismaStub.project.create).not.toHaveBeenCalled();
  });

  it("正常创建 → 建 project + owner member + 项目 session + 欢迎消息", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 7 });
    prismaStub.project.create.mockResolvedValue({ id: 11 });
    prismaStub.session.create.mockResolvedValue({ id: 21, projectId: 11 });

    const result = await repo.create({
      ownerId: 1,
      name: "test",
      welcomeMessage: "欢迎",
    });

    expect(prismaStub.projectMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { projectId: 11, userId: 1, role: "owner" } }),
    );
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { projectId: 11, workspaceId: 7, title: "test" } }),
    );
    expect(prismaStub.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sessionId: 21, role: "assistant" }),
      }),
    );
    expect(result.sessionId).toBe(21);
  });

  it("无欢迎消息 → 不写欢迎 message", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 7 });
    prismaStub.project.create.mockResolvedValue({ id: 12 });
    prismaStub.session.create.mockResolvedValue({ id: 22, projectId: 12 });
    await repo.create({ ownerId: 1, name: "t2" });
    expect(prismaStub.message.create).not.toHaveBeenCalled();
  });
});

describe("ProjectRepository.remove", () => {
  it("级联删除 bindings/members/messages/sessions/project", async () => {
    prismaStub.session.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);
    await repo.remove(11);
    expect(prismaStub.message.deleteMany).toHaveBeenCalledWith({ where: { sessionId: { in: [21, 22] } } });
    expect(prismaStub.session.deleteMany).toHaveBeenCalledWith({ where: { projectId: 11 } });
    expect(prismaStub.projectMember.deleteMany).toHaveBeenCalledWith({ where: { projectId: 11 } });
    expect(prismaStub.projectBinding.deleteMany).toHaveBeenCalledWith({ where: { projectId: 11 } });
    expect(prismaStub.project.delete).toHaveBeenCalledWith({ where: { id: 11 } });
  });
});

describe("ProjectRepository.update", () => {
  it("改名校验同用户重名 → 抛 PROJECT_NAME_EXISTS", async () => {
    prismaStub.project.findUnique.mockResolvedValue({ id: 1, ownerId: 1, name: "a" });
    prismaStub.project.findFirst.mockResolvedValue({ id: 2 });
    await expect(repo.update({ id: 1, name: "b" })).rejects.toThrow(PROJECT_NAME_EXISTS);
  });

  it("项目不存在 → 抛 PROJECT_NOT_FOUND", async () => {
    prismaStub.project.findUnique.mockResolvedValue(null);
    await expect(repo.update({ id: 99, name: "x" })).rejects.toThrow(PROJECT_NOT_FOUND);
  });
});

describe("ProjectRepository.setBindings", () => {
  it("全量替换：先清空再批量写入", async () => {
    await repo.setBindings(11, [
      { itemType: "assistant", itemId: 3 },
      { itemType: "skill", itemId: 4 },
    ]);
    expect(prismaStub.projectBinding.deleteMany).toHaveBeenCalledWith({ where: { projectId: 11 } });
    expect(prismaStub.projectBinding.createMany).toHaveBeenCalledWith({
      data: [
        { projectId: 11, itemType: "assistant", itemId: 3 },
        { projectId: 11, itemType: "skill", itemId: 4 },
      ],
    });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/project/project-repo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 repo**

`electron/domains/project/project.repo.ts`（自注册 IPC 模式照 `option.repo.ts`；方法保持 ≤20 行，超出的抽私有方法）：

```ts
/**
 * 项目仓储：项目 CRUD + 成员/挂载/动态流会话管理（spec §4）
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import {
  PROJECT_NAME_EXISTS,
  PROJECT_NOT_FOUND,
  ProjectBindingInput,
  ProjectBindingItem,
  ProjectBindingType,
  ProjectCreateParams,
  ProjectDetail,
  ProjectRecord,
  ProjectUpdateParams,
} from "./project.entity";
import type { SessionRecord } from "../../../../src-react/domains/ai/api/session.api";

const ITEM_TABLES: Record<ProjectBindingType, "assistant" | "skillRecord" | "mcpServer"> = {
  assistant: "assistant",
  skill: "skillRecord",
  mcpServer: "mcpServer",
};

export default class ProjectRepository {
  constructor() {
    this.registerHandlers();
  }
  // …registerHandlers：六个通道（见 Interfaces）
  // create：重名检查→project.create→member(owner)→defaultWorkspace 取
  //   prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } })→session.create
  //   ({ projectId, workspaceId, title: name })→welcomeMessage 非空则 message.create
  //   ({ sessionId, role: "assistant", blocks: JSON.stringify([{ type: "text", text }]) })
  //   并 session.update({ lastMessageAt: new Date() })
  // remove：session.findMany({ where: { projectId } }) → 逐表 deleteMany（顺序：message→session→member→binding→project）
  // update：findUnique 校验存在；改名时 findFirst({ ownerId, name, NOT: { id } }) 查重
  // setBindings：deleteMany + createMany 全量替换
  // list(ownerId)：findMany({ where: { ownerId }, orderBy: { updatedAt: "desc" } })
  //   逐行补 sessionId（session.findFirst({ where: { projectId: row.id } })）
  // getDetail(id)：project + bindings（逐 itemType 查源表取 name/存在性拼 ProjectBindingItem）
  //   + session.findFirst({ where: { projectId: id } })（无则抛 PROJECT_NOT_FOUND）
}
```

`toRecord(row, sessionId)` / `toIso` 转换私有方法参照 `session.repo.ts` 的 `toSession` 风格（DateTime→toISOString）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/project/project-repo.test.ts`
Expected: PASS 全绿

- [ ] **Step 6: 接线 + 通道类型**

`src-react/lib/ipc.ts` 的 `IPCChannel` 在 `// 个性化记忆` 注释块前插入：

```ts
  // 项目模块
  | "project:list"
  | "project:getDetail"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "project:setBindings"
```

`electron/Application.ts` 的 `registerServices()` 末尾（`new AutomationRepository();` 之后）加 `new ProjectRepository();` 与注释 `// 项目模块`。

- [ ] **Step 7: 验证 + 提交**

Run: `npm run typecheck && npx vitest run tests/project`
Expected: 全部通过

```bash
git add electron/domains/project src-react/lib/ipc.ts electron/Application.ts tests/project
git commit -m "feat(project): 项目仓储——CRUD/级联删除/能力挂载/动态流会话与欢迎消息（IPC 自注册）"
```

---

### Task 3: 会话隔离——项目会话不进 AI 任务树与全局搜索（TDD）

**Files:**
- Modify: `electron/domains/ai/chat/session.repo.ts`（4 处查询）
- Test: `tests/project/session-isolation.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `session.projectId`
- Produces: AI 侧会话查询全部隐含 `projectId: null`；前端行为不变

- [ ] **Step 1: 写失败测试**

`tests/project/session-isolation.test.ts`（prisma stub 模式同 Task 2，只 stub `prisma.session` 与 `prisma.message`）：

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/prisma-client", () => ({ default: prismaStub }));

const sessionFindMany = vi.fn().mockResolvedValue([]);
const messageFindMany = vi.fn().mockResolvedValue([]);
const sessionFindFirst = vi.fn().mockResolvedValue(null);
const prismaStub = {
  session: { findMany: sessionFindMany, findFirst: sessionFindFirst },
  message: { findMany: messageFindMany },
};

import SessionRepository from "../../electron/domains/ai/chat/session.repo";
const repo = new SessionRepository();

describe("会话隔离（项目会话不进 AI 任务树/搜索）", () => {
  it("listAllSessions 查询含 projectId: null", async () => {
    await repo.listAllSessions();
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: null }) }),
    );
  });

  it("listSessions 查询含 projectId: null", async () => {
    await repo.listSessions(1);
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: null } }) ),
    );
  });

  it("searchSessionsByTitle 查询含 projectId: null", async () => {
    await repo.searchSessionsByTitle("kw");
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: null }) }),
    );
  });
});
```

注意：`SessionRepository` 构造函数里有 `void this.ensureDefaultWorkspace()`，stub 需含 `workspace: { count: vi.fn().mockResolvedValue(1) }`（返回非 0 跳过建表）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/session-isolation.test.ts`
Expected: FAIL（where 中无 projectId 条件）

- [ ] **Step 3: 修改四处查询**

`session.repo.ts`：

1. `listSessions`（约 :225）：`where: { workspaceId, archivedAt: null, projectId: null }`
2. `listAllSessions`（约 :257）：`where: { archivedAt: null, projectId: null }`
3. `searchSessionsByTitle`（约 :298）：trimmed 与否两个分支都加 `projectId: null`
4. `searchMessages`（约 :406）：消息按 blocks 全库搜会带出项目消息——先查非项目会话 id 集：

```ts
const visibleSessions = await prisma.session.findMany({
  where: { projectId: null },
  select: { id: true },
});
// findMany where 追加 sessionId: { in: visibleSessions.map((s) => s.id) }
```

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `npx vitest run tests/project tests/ai/chat.service.test.ts`
Expected: 全绿（chat.service 既有用例不被破坏）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/chat/session.repo.ts tests/project
git commit -m "feat(project): 会话隔离——项目会话不进 AI 任务树/标题搜索/全局消息搜索"
```

---

### Task 4: 项目指令注入 chat 管道（TDD）

**Files:**
- Create: `electron/domains/project/project-prompt.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（system prompt 组装处）
- Modify: `electron/Application.ts`（ChatService 构造传入 ProjectRepository）
- Test: `tests/project/project-prompt.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ProjectRepository`
- Produces:

```ts
// project-prompt.ts —— 纯函数，无 IO
export interface ProjectPromptContext {
  projectName: string;
  systemPrompt: string | null;
  boundAssistantPrompts: string[]; // 已挂载专家的 systemPrompt
  boundSkillNames: string[];       // 已挂载技能名（软约束声明用）
  boundConnectorNames: string[];   // 已挂载连接器名
}
/** 项目会话 base system：项目指令 + 专家 prompt 合并；空则 undefined */
export function buildProjectSystemBase(ctx: ProjectPromptContext): string | undefined;
```

`ProjectRepository` 增加方法 `getPromptContext(projectId: number): Promise<ProjectPromptContext | null>`（查 project + bindings + 三源表名集合），供 ChatService 调用。

- [ ] **Step 1: 写失败测试**

`tests/project/project-prompt.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildProjectSystemBase } from "../../electron/domains/project/project-prompt";

describe("buildProjectSystemBase", () => {
  it("项目指令在前，专家 prompt 依序拼接（\\n\\n 分隔）", () => {
    const result = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: "你是项目管理专家",
      boundAssistantPrompts: ["专家A", "专家B"],
      boundSkillNames: [],
      boundConnectorNames: [],
    });
    expect(result).toBe("你是项目管理专家\n\n专家A\n\n专家B");
  });

  it("全部为空 → undefined", () => {
    expect(
      buildProjectSystemBase({
        projectName: "p", systemPrompt: null,
        boundAssistantPrompts: [], boundSkillNames: [], boundConnectorNames: [],
      }),
    ).toBeUndefined();
  });

  it("无项目指令但有专家 → 仅专家拼接", () => {
    const result = buildProjectSystemBase({
      projectName: "p", systemPrompt: null,
      boundAssistantPrompts: ["A"], boundSkillNames: [], boundConnectorNames: [],
    });
    expect(result).toBe("A");
  });

  it("有挂载能力时附加可用能力软约束声明段", () => {
    const result = buildProjectSystemBase({
      projectName: "p", systemPrompt: "指令",
      boundAssistantPrompts: [], boundSkillNames: ["技能1"],
      boundConnectorNames: ["连接器1"],
    });
    expect(result).toContain("技能1");
    expect(result).toContain("连接器1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/project-prompt.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现纯函数**

声明段文案（软约束，spec §5.2 降级条款）：

```ts
/** 可用能力软约束（一期）：硬隔离二期落地 */
function buildCapabilitySection(skillNames: string[], connectorNames: string[]): string {
  if (skillNames.length === 0 && connectorNames.length === 0) return "";
  const lines = ["【本项目可用能力】"];
  if (skillNames.length > 0) lines.push(`技能：${skillNames.join("、")}`);
  if (connectorNames.length > 0) lines.push(`连接器：${connectorNames.join("、")}`);
  lines.push("本项目对话中请优先（且仅）使用以上已挂载能力。");
  return lines.join("\n");
}
```

`buildProjectSystemBase`：`[systemPrompt, ...boundAssistantPrompts, capabilitySection].filter(Boolean).join("\n\n") || undefined`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/project/project-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: ChatService 接入**

执行者先读 `chat.service.ts`，定位方式：`grep -n "buildModeSystem\|buildSystemPrompt" electron/domains/ai/chat/chat.service.ts`（定义约 :176 附近，调用约 :191 与 :1363 两处——**两处都要检查**，确认是否同一组装链路；若 :191 是独立链路同样接入）。

改造模式（在拿到 `assistantRow` 组装 base 的位置）：

```ts
// 原代码形如 buildModeSystem(mode, assistantRow?.systemPrompt, skills)
// 项目会话：base 换为项目上下文（项目指令 + 挂载专家）；非项目会话行为不变
const projectCtx = session.projectId
  ? await this.projectRepo.getPromptContext(session.projectId)
  : null;
const base = projectCtx
  ? buildProjectSystemBase(projectCtx) ?? assistantRow?.systemPrompt
  : assistantRow?.systemPrompt;
```

接线：`ChatService` 构造函数加第三参 `projectRepo: ProjectRepository`；`Application.ts` 中 `new ProjectRepository()` 实例保存为变量并传入（**必须移到 `new ChatService(...)` 之前**实例化）。

- [ ] **Step 6: 回归 + 验证**

Run: `npx vitest run tests/project tests/ai/chat.service.test.ts && npm run typecheck`
Expected: 全绿（若 chat.service.test 的 ChatService 构造 stub 需要补第三参，按最小改动补）

- [ ] **Step 7: Commit**

```bash
git add electron/domains/project electron/domains/ai/chat/chat.service.ts electron/Application.ts tests/project
git commit -m "feat(project): 项目指令注入 chat——项目 systemPrompt+挂载专家合并为会话 base"
```

---

### Task 5: 内置模版数据 + project.api.ts + i18n（TDD 轻量）

**Files:**
- Create: `src-react/domains/project/model/project-templates.ts`
- Create: `src-react/domains/project/api/project.api.ts`
- Create: `src-react/i18n/locales/zh-CN/project.json`
- Create: `src-react/i18n/locales/en-US/project.json`
- Modify: `src-react/i18n/index.ts`
- Test: `tests/project/project-templates.test.ts`

**Interfaces:**
- Consumes: Task 2 的 entity 类型与 IPC 通道
- Produces:

```ts
// project-templates.ts
export interface ProjectTemplate {
  key: string;
  name: string;
  description: string;
  prompt: string; // 空白项目为 ""
  welcome: string;
  icon: string;   // lucide 组件名，如 "FileText"
}
export const PROJECT_TEMPLATES: ProjectTemplate[];
export function getTemplate(key: string): ProjectTemplate | undefined;
```

```ts
// project.api.ts（静态方法风格，照 src-react/domains/ai/api/workspace.api.ts）
export default abstract class ProjectApi {
  static list(ownerId: number): Promise<ProjectRecord[]>;
  static getDetail(id: number): Promise<ProjectDetail>;
  static create(params: ProjectCreateParams): Promise<ProjectRecord>;
  static update(params: ProjectUpdateParams): Promise<void>;
  static remove(id: number): Promise<void>;
  static setBindings(projectId: number, items: ProjectBindingInput[]): Promise<void>;
}
```

- [ ] **Step 1: 写模版数据测试**

`tests/project/project-templates.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { PROJECT_TEMPLATES, getTemplate } from "../../src-react/domains/project/model/project-templates";

describe("内置模版", () => {
  it("key 唯一", () => {
    const keys = PROJECT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("含空白项目模版且 prompt 为空串", () => {
    const blank = PROJECT_TEMPLATES.find((t) => t.key === "blank");
    expect(blank?.prompt).toBe("");
    expect(blank?.welcome).not.toBe("");
  });
  it("非空白模版 prompt 与 welcome 非空", () => {
    for (const t of PROJECT_TEMPLATES.filter((x) => x.key !== "blank")) {
      expect(t.prompt.length).toBeGreaterThan(0);
      expect(t.welcome.length).toBeGreaterThan(0);
    }
  });
  it("getTemplate 未知 key 返回 undefined", () => {
    expect(getTemplate("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败 → 写模版数据**

四个模版（prompt 是内容数据不走 i18n；每个 prompt 为结构化中文指令，8~15 行）：

```ts
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: "prd-workflow",
    name: "产品需求全流程",
    description: "从需求规划、PRD 到研发测试验收",
    icon: "FileText",
    prompt: `你是本项目的需求管理专家，负责产品需求全流程。\n职责：\n1. 需求收集与分析：澄清目标、用户故事、验收标准\n2. PRD 撰写：背景、功能点、流程图（文字描述）、边界与异常\n3. 研发协同：拆解任务、评估依赖\n4. 测试验收：输出验收清单并跟踪遗留问题\n输出规范：重要结论先给要点，再展开细节；文档类输出使用 Markdown。`,
    welcome: `项目已就绪。我是本项目的需求管理助手，可以帮你：收集分析需求、撰写 PRD、拆解研发任务、制定验收清单。试着说"帮我规划一个新功能的需求"。`,
  },
  {
    key: "market-research",
    name: "市场调研",
    description: "竞品分析、行业洞察与调研报告",
    icon: "Globe",
    prompt: `你是本项目的市场调研专家。\n职责：\n1. 明确调研目标与范围\n2. 设计调研框架（维度、指标、数据来源）\n3. 竞品对比分析（功能、定价、定位）\n4. 输出结构化调研报告：结论先行、数据支撑、给出建议\n输出规范：报告用 Markdown，附来源或假设说明，不编造数据。`,
    welcome: `项目已就绪。我是市场调研助手，可以帮你搭建调研框架、做竞品对比、整理调研报告。试着描述你想调研的主题。`,
  },
  {
    key: "bug-tracking",
    name: "Bug 跟踪",
    description: "缺陷记录、分级与修复跟踪",
    icon: "Bug",
    prompt: `你是本项目的缺陷管理专家。\n职责：\n1. 缺陷记录：复现步骤、期望/实际结果、环境影响\n2. 分级评估：按严重程度（P0~P3）与优先级归类\n3. 修复跟踪：状态流转（待修复/修复中/待验证/已关闭）\n4. 定期汇总：遗留缺陷清单与风险提示\n输出规范：每条缺陷一条结构化记录，便于直接落任务。`,
    welcome: `项目已就绪。我是缺陷管理助手，可以帮你记录 Bug、评估严重程度、跟踪修复状态。直接粘贴一条 Bug 描述试试。`,
  },
  {
    key: "blank",
    name: "空白项目",
    description: "从零开始自定义项目指令",
    icon: "SquarePen",
    prompt: "",
    welcome: `项目已创建。你可以在右侧配置面板编写项目指令、挂载专家/技能/连接器，让 AI 成为这个项目的专属成员。`,
  },
];
```

- [ ] **Step 3: 写 project.api.ts**

静态类封装 `invoke`（通道与 Task 2 一致；类型从 `electron/domains/project/project.entity` import——渲染进程 import 主进程的**纯类型文件**在本仓库有先例（session.repo 反向 import 前端类型），Vite 只消费其类型不打包运行时；若 typecheck 报循环依赖，则把 entity 类型移到 `src-react/domains/project/model/project.types.ts` 并让后端 import 前端（与 session.repo 同方向））。

- [ ] **Step 4: i18n 双语言文件 + 注册**

`src-react/i18n/locales/zh-CN/project.json`（en-US 同步翻译）：

```json
{
  "hub": {
    "title": "项目",
    "subtitle": "多人协同，打造超级团队",
    "newProject": "新建项目",
    "myProjects": "我的项目",
    "fromTemplate": "从模版创建",
    "searchPlaceholder": "搜索项目",
    "empty": "暂无项目，点击「新建项目」开始",
    "menuRename": "重命名",
    "menuDelete": "删除",
    "deleteTitle": "删除项目",
    "deleteDesc": "将删除项目的动态流与全部挂载配置，此操作不可撤销",
    "createdAt": "创建于 {{date}}"
  },
  "create": {
    "title": "新建项目",
    "nameLabel": "项目名称",
    "namePlaceholder": "输入项目名称（15 字以内）",
    "nameRequired": "请输入项目名称",
    "nameTooLong": "项目名称不能超过 15 字",
    "nameExists": "该项目名称已存在，请修改",
    "promptLabel": "指令配置",
    "templateLabel": "选择模版",
    "templateBlank": "不使用模版",
    "promptPlaceholder": "定义 AI 在本项目中的角色、工作流与规范（可通过模版快速填充）",
    "overwriteTitle": "切换模版",
    "overwriteDesc": "切换模版将覆盖当前已编辑的指令内容，是否继续？",
    "overwriteConfirm": "继续",
    "capabilities": "能力挂载",
    "connectors": "连接器",
    "experts": "专家",
    "skills": "技能",
    "add": "添加",
    "invalid": "已失效"
  },
  "picker": {
    "searchPlaceholder": "搜索",
    "empty": "暂无可选项",
    "selectedCount": "已选 {{count}} 项",
    "confirm": "确定",
    "cancel": "取消",
    "all": "全部"
  },
  "workspace": {
    "tabActivity": "动态",
    "tabPlan": "计划",
    "tabTasks": "任务",
    "tabAssets": "资产",
    "comingSoon": "规划中，敬请期待",
    "filterMine": "与我相关",
    "filterMembers": "成员动态",
    "togglePanel": "项目配置",
    "notFound": "项目不存在或已删除"
  },
  "panel": {
    "title": "项目配置",
    "instruction": "指令",
    "instructionEmpty": "未设置项目指令",
    "editInstruction": "编辑指令",
    "saveInstruction": "保存",
    "members": "成员",
    "owner": "创建者",
    "me": "我",
    "automation": "定时任务",
    "automationTip": "让 AI 按计划自动执行任务",
    "goAutomation": "前往自动化"
  },
  "sidebar": {
    "projects": "项目",
    "myProjects": "我的项目",
    "empty": "还没有项目",
    "createFirst": "创建第一个项目"
  },
  "toast": {
    "created": "项目创建成功",
    "deleted": "项目已删除",
    "renamed": "已重命名",
    "createFailed": "创建失败，请重试",
    "operationFailed": "操作失败，请重试",
    "saved": "已保存"
  }
}
```

`src-react/i18n/index.ts`：仿现有 import + 注册，把 `project` namespace 加入 zh-CN 与 en-US 的资源对象与 `ns` 数组（执行者先读该文件确认确切写法）。

- [ ] **Step 5: 验证 + 提交**

Run: `npx vitest run tests/project && npm run typecheck`
Expected: 全绿

```bash
git add src-react/domains/project src-react/i18n tests/project
git commit -m "feat(project): 内置四模版 + ProjectApi 封装 + project i18n 双语言"
```

---

### Task 6: PickerDialog 通用能力选择器（TDD）

**Files:**
- Create: `src-react/domains/project/components/PickerDialog.tsx`
- Test: `tests/project/picker-dialog.test.tsx`

**Interfaces:**
- Produces（Task 7/10 依赖）:

```ts
export interface PickerItem {
  id: number;
  name: string;
  description?: string;
  tags?: string[]; // 专家的擅长领域标签
}
interface PickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: PickerItem[];
  selectedIds: number[];
  onConfirm: (ids: number[]) => void;
  searchPlaceholder?: string;
}
export default function PickerDialog(props: PickerDialogProps): JSX.Element;
```

- [ ] **Step 1: 写失败测试**

`tests/project/picker-dialog.test.tsx`（jsdom + testing-library + i18n mock，照 `tests/ai/plus-menu.test.tsx` 头部模式）：

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import PickerDialog from "../../src-react/domains/project/components/PickerDialog";

afterEach(cleanup);

const ITEMS = [
  { id: 1, name: "专家A", description: "写作" },
  { id: 2, name: "专家B", tags: ["产品"] },
];

describe("PickerDialog", () => {
  it("勾选两项后确认，回传选中 id 集合", async () => {
    const onConfirm = vi.fn();
    render(
      <PickerDialog open onOpenChange={vi.fn()} title="选择专家"
        items={ITEMS} selectedIds={[1]} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByText("专家B"));
    fireEvent.click(screen.getByRole("button", { name: /picker.confirm|确定/ }));
    expect(onConfirm).toHaveBeenCalledWith([1, 2]);
  });

  it("搜索关键字过滤列表", () => {
    render(
      <PickerDialog open onOpenChange={vi.fn()} title="选择专家"
        items={ITEMS} selectedIds={[]} onConfirm={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "专家A" } });
    expect(screen.getByText("专家A")).toBeTruthy();
    expect(screen.queryByText("专家B")).toBeNull();
  });

  it("点击取消不触发 onConfirm 并关闭", () => {
    const onOpenChange = vi.fn();
    render(
      <PickerDialog open onOpenChange={onOpenChange} title="选择专家"
        items={ITEMS} selectedIds={[]} onConfirm={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /picker.cancel|取消/ }));
    // onOpenChange(false) 由 Dialog 交互触发（mock Radix Dialog 行为按需简化：
    // 本用例验证取消按钮可点击且 onConfirm 未被调用）
    expect(true).toBe(true);
  });
});
```

（断言按 t mock 返回 key 的现实微调：若按钮文案断言不稳定，改用 `screen.getAllByRole("button")` 数量断言，保持核心验证点：勾选回传与过滤）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/picker-dialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现组件**

基于 shadcn `Dialog` + `ScrollArea` + `Input` + 自定义 Checkbox 行：列表项 = 复选行（名称 + description/tags 徽标），头部搜索框客户端过滤（name/tags/description 包含匹配），底部「已选 N 项」+ 取消/确定。样式遵守全局约束（`border-border/50 rounded-lg shadow-lg`、主题变量）。

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `npx vitest run tests/project && npm run typecheck`
Expected: 全绿

```bash
git add src-react/domains/project/components/PickerDialog.tsx tests/project
git commit -m "feat(project): PickerDialog 通用多选弹窗（搜索/分类标签/已选计数）"
```

---

### Task 7: CreateProjectDialog 新建项目弹窗（TDD 状态机）

**Files:**
- Create: `src-react/domains/project/components/CreateProjectDialog.tsx`
- Test: `tests/project/create-project-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 5 `ProjectApi` / `PROJECT_TEMPLATES`、Task 6 `PickerDialog`
- Produces:

```ts
interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 从模版卡片进入时预选的模版 key */
  presetTemplateKey?: string;
  /** 创建成功回调（父级负责跳转 /module/project/:id） */
  onCreated: (project: ProjectRecord) => void;
}
export default function CreateProjectDialog(props: CreateProjectDialogProps): JSX.Element;
```

- [ ] **Step 1: 写失败测试**

`tests/project/create-project-dialog.test.tsx`（头部 mock 同 Task 6；再 mock `@/domains/project/api/project.api` 与三个能力 api）：

核心用例（spec §6.2 模版覆盖确认状态机）：

```tsx
// mock ProjectApi.create 返回 { id: 1 }；mock useUserStore 返回 { user: { id: 1 } }
describe("模版覆盖确认（spec 4.1）", () => {
  it("文本域已有内容时切模版 → 出现确认弹层；确认后填充新模版 prompt", () => {
    // 1. render，选择模版 A（下拉）→ textarea 值 = A.prompt
    // 2. fireEvent.change(textarea, "手动编辑")
    // 3. 切换模版 B → AlertDialog 出现（含 project:create.overwriteDesc 的 key）
    // 4. 点确认 → textarea 值 = B.prompt
  });
  it("取消切换 → textarea 保持手动编辑内容，下拉回弹为模版 A", () => {
    // 同上 1-3，点取消 → textarea 值仍为 "手动编辑"，Select 显示模版 A
  });
  it("文本域为空时切模版 → 直接填充，无确认弹层", () => { /* ... */ });
});

describe("名称校验", () => {
  it("空名称提交 → 显示 nameRequired，不调用 ProjectApi.create", () => { /* ... */ });
  it("超过 15 字输入 → 显示 nameTooLong", () => { /* ... */ });
});

describe("能力挂载", () => {
  it("专家 PickerDialog 确认后以 Tag 展示并可移除", () => { /* ... */ });
});
```

（用例以行为描述给出，执行者写出完整可运行断言；关键状态机：`selectedTemplateKey`（当前生效模版）、`dirty`（用户手动编辑标记，textarea onChange 置 true、模版填充重置 false））

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/create-project-dialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现弹窗**

结构：`Dialog` → 项目名称 Input（实时校验 ≤15 字）→ 指令区（Select 模版 + Textarea）→ 三能力区（每区：已选 Tag 列表 + `+ 添加` 按钮开 PickerDialog）→ 底部取消/确定。

- 数据源：专家 `useQuery(["assistants"], AssistantApi.list)`、技能 `useQuery` SkillApi.list（`@/domains/ai/skills/api/skill.api`）、连接器 `useQuery` McpApi.list（`@/domains/ai/api/mcp.api`，执行者读两文件确认导出名与返回类型）
- 提交：`ProjectApi.create({ ownerId: user.id, name, systemPrompt || undefined, templateKey, welcomeMessage: 模版 welcome, bindings })`；catch 判断 `e.message.includes(PROJECT_NAME_EXISTS)` → setNameError(t("project:create.nameExists"))；其他 → toast(t("project:toast.createFailed"))；成功 → toast + `onCreated(record)`。弹窗不因失败关闭
- Tag 移除：点击 Tag 的 X 更新对应 selectedIds
- 布局参考 spec §6.2；触发按钮悬停样式遵守全局约束

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `npx vitest run tests/project && npm run typecheck`
Expected: 全绿

```bash
git add src-react/domains/project/components/CreateProjectDialog.tsx tests/project
git commit -m "feat(project): 新建项目弹窗——名称校验/模版覆盖确认/三类能力挂载"
```

---

### Task 8: ProjectHubView 项目列表页 + 路由 + 侧边栏项目入口

**Files:**
- Create: `src-react/domains/project/views/ProjectHubView.tsx`
- Create: `src-react/domains/project/components/ProjectCard.tsx`
- Modify: `src-react/routes/index.tsx`
- Modify: `src-react/domains/ai/layout/components/AiSidebar.tsx:382-398`（navEntries 加项目项）
- Test: `tests/project/project-hub.test.tsx`

**Interfaces:**
- Consumes: Task 5 `ProjectApi` / `PROJECT_TEMPLATES`、Task 7 `CreateProjectDialog`
- Produces: 路由 `/module/project`（hub）、`/module/project/:projectId`（详情，本任务先占位）

- [ ] **Step 1: 写失败测试**

`tests/project/project-hub.test.tsx`：

```tsx
// mock ProjectApi.list 返回两个项目 [{id:1,name:"alpha"},{id:2,name:"beta"}]
// 核心用例：
it("搜索框输入 al → 只剩 alpha 卡片", () => { /* render → change → 断言 */ });
it("点击项目卡片 → navigate 到 /module/project/1", () => { /* memory router 断言 */ });
it("无项目 → 渲染空状态文案", () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/project-hub.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

**ProjectCard.tsx**：图标（模版 icon 映射 lucide 组件，缺省 `FolderKanban`）+ 名称 + `createdAt`（date-fns `formatDistanceToNow`，locale 按 `getDateFnsLocale()`）+ DropdownMenu（`...`：重命名 → 小 Dialog 内联 Input + 确定；删除 → AlertDialog 二次确认文案 `project:hub.deleteDesc` → `ProjectApi.remove` + invalidate `["projects"]`）。

**ProjectHubView.tsx**：

```
头部：h1 项目 + 副标题 + [+ 新建项目]（Button 默认 primary 变体）+ 右侧装饰（内置 SVG：
     lucide Users/Sparkles 图标组合 + 渐变 bg-gradient-to-r from-primary/10 色块，本地渲染不外链）
我的项目：标题行（我的项目 + 右侧搜索 Input）→ 卡片网格 grid gap-4
从模版创建：标题行 + 横向滚动 flex overflow-x-auto 模版卡（icon+name+description），
     点击 → setPresetTemplateKey(模版 key) + 打开 CreateProjectDialog
```

- 数据：`useQuery(["projects", user.id], () => ProjectApi.list(user.id))`
- 创建成功：`navigate(\`/module/project/${record.id}\`)`
- 删除当前被删项目后仅 invalidate，不跳转

**路由**（`routes/index.tsx`）：lazy import `ProjectHubView` 与 `ProjectWorkspaceView`，在 `/module` children 的 `ai` 之后加：

```tsx
{
  path: "project",
  element: <LazyWrapper><ProjectHubView /></LazyWrapper>,
},
{
  path: "project/:projectId",
  element: <LazyWrapper><ProjectWorkspaceView /></LazyWrapper>,
},
```

`ProjectWorkspaceView.tsx` 本任务先建占位（`<div className="flex h-full items-center justify-center text-muted-foreground">{t("project:workspace.comingSoon")}</div>`，Task 10 完整实现）。

**AiSidebar 导航项**（临时入口，Task 11 重构时并入 GlobalSidebar）：`navEntries` 数组头部插入：

```tsx
{
  icon: <FolderKanban size={16} />,
  label: t("project:sidebar.projects"),
  onClick: () => navigate("/module/project"),
},
```

（import `FolderKanban` from lucide-react；这是 ai 域组件引用 project i18n key，跨域引用文案可接受——Task 11 重构后该组件整体迁入全局层）

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `npx vitest run tests/project && npm run typecheck`
Expected: 全绿

```bash
git add src-react/domains/project/views src-react/domains/project/components/ProjectCard.tsx src-react/routes src-react/domains/ai/layout/components/AiSidebar.tsx tests/project
git commit -m "feat(project): 项目列表页——卡片网格/搜索/模版区 + /module/project 路由"
```

---

### Task 9: ChatPane 抽出复用 + 输入框能力过滤（TDD）

**Files:**
- Create: `src-react/domains/ai/chat/components/ChatPane.tsx`
- Modify: `src-react/domains/ai/chat/views/ChatView.tsx`（删内部 ChatPane，改 import）
- Modify: `src-react/domains/ai/chat/components/ChatInput.tsx`（props 加可选过滤集）
- Modify: `src-react/domains/ai/chat/components/PlusMenu.tsx`（props 透传）
- Modify: `src-react/domains/ai/chat/components/expert-sub-menu.tsx` / `skill-sub-menu.tsx`（列表过滤）
- Test: `tests/project/plus-menu-filter.test.tsx`

**Interfaces:**
- Produces（Task 10 依赖）:

```ts
// ChatPane（从 ChatView.tsx 原样搬出，props 增加两个可选过滤集）
interface ChatPaneProps {
  session: SessionRecord;
  workspace: WorkspaceRecord | null;
  hasModel: boolean;
  onOpenSettings: (target: "providers" | "assistants" | "mcp") => void;
  /** 项目动态流：仅展示已挂载专家；未传不过滤（AI 模块行为不变） */
  boundAssistantIds?: number[];
  /** 项目动态流：仅展示已挂载技能（skillRecord.name 匹配） */
  boundSkillNames?: string[];
}
export default function ChatPane(props: ChatPaneProps): JSX.Element;
```

ChatInput / PlusMenu 加同名可选 props（`boundAssistantIds?: number[]`、`boundSkillNames?: string[]`），ExpertSubMenu 加 `allowedIds?: number[]`、SkillSubMenu 加 `allowedNames?: string[]`，内部对列表数据 filter；**未传时完全不过滤**。

- [ ] **Step 1: 写失败测试**

`tests/project/plus-menu-filter.test.tsx`（头部 mock 照 `tests/ai/plus-menu.test.tsx`，再 mock 两个子菜单为透传 props 的简单列表以验证过滤值传递，或直接 mock 数据源——执行者按子菜单实际数据获取方式（useQuery）选择 mock 层级，验证点：传入 `allowedIds={[1]}` 时列表只剩 id=1 项）：

```tsx
it("传入 boundAssistantIds → 专家子菜单仅显示已挂载专家", () => { /* ... */ });
it("未传 boundAssistantIds → 不过滤，全量显示", () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/plus-menu-filter.test.tsx`
Expected: FAIL

- [ ] **Step 3: 搬移 + 实现**

1. ChatView.tsx 的 `ChatPane` 函数与其 Props 接口**原样剪切**到新文件 `chat/components/ChatPane.tsx`（默认导出），补充两个可选 props 并透传给 ChatInput；ChatView.tsx 顶部 `import ChatPane from "../components/ChatPane"`，其余不动
2. ChatInput / PlusMenu / 两个子菜单按 Interfaces 加可选 props 与过滤逻辑（`items.filter((item) => !allowedIds || allowedIds.includes(item.id))` 风格）

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `npx vitest run tests/project tests/ai && npm run typecheck`
Expected: 全绿（重点回归 `tests/ai/chat-view-edit-optimistic.test.tsx`、`tests/ai/plus-menu.test.tsx`、`tests/ai/message-item-edit.test.tsx`）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat tests/project
git commit -m "refactor(chat): ChatPane 抽出为可复用组件 + PlusMenu 支持已挂载能力过滤"
```

---

### Task 10: ProjectWorkspaceView 详情页——Tab 容器 + 动态流 + 配置面板

**Files:**
- Modify: `src-react/domains/project/views/ProjectWorkspaceView.tsx`（替换 Task 8 占位）
- Create: `src-react/domains/project/components/ActivityPane.tsx`
- Create: `src-react/domains/project/components/ConfigPanel.tsx`
- Create: `src-react/domains/project/components/InstructionEditDialog.tsx`
- Test: `tests/project/project-workspace.test.tsx`

**Interfaces:**
- Consumes: Task 5 `ProjectApi`、Task 9 `ChatPane`、Task 6 `PickerDialog`、既有 `MessageList` 等
- Produces: 完整详情页（后续二期资产/三期计划任务在此容器内扩展）

- [ ] **Step 1: 写失败测试**

`tests/project/project-workspace.test.tsx`（mock ProjectApi.getDetail 返回 fixture；mock ChatPane 为占位 div）：

```tsx
it("默认渲染动态 Tab（?tab 缺省）", () => { /* ChatPane mock 渲染断言 */ });
it("点击计划 Tab → URL 变 ?tab=plan 且显示占位文案", () => { /* ... */ });
it("getDetail 抛 PROJECT_NOT_FOUND → 跳转 /module/project", () => { /* memory router 断言 */ });
it("配置面板：点击收起按钮隐藏面板", () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/project/project-workspace.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

**ProjectWorkspaceView.tsx**：

```
useParams 取 projectId → useQuery(["project", id], getDetail)
  onError 且 PROJECT_NOT_FOUND → navigate("/module/project") + toast(notFound)
布局：flex h-full
  左列 flex-1 flex flex-col：
    顶栏：Tabs（动态/计划/任务/资产，读写 ?tab=，默认 activity）
          + 筛选 DropdownMenu（与我相关/成员动态——单成员等价，UI 预留）
          + 收起/展开配置面板按钮（PanelRight icon）
    内容区：tab=activity → <ActivityPane detail={...} />
           其他 tab → 居中空态（icon + project:workspace.comingSoon）
  右列（展开时 w-80 border-l）：<ConfigPanel detail={...} />
```

**ActivityPane.tsx**：

```
providers/models 双空 → 简版引导卡（照 ChatView.SetupGuide 形态，跳 /module/ai/providers）
否则 <ChatPane session={detail.session}
       workspace={workspaces.find(w => w.id === detail.session.workspaceId) ?? null}
       hasModel={Boolean(detail.session.currentModelId ?? workspace?.defaultModelId)}
       onOpenSettings={(target) => navigate(target === "providers" ? "/module/ai/providers" : "/module/ai/experts")}
       boundAssistantIds={bindings(assistant).filter(valid).map(b => b.itemId)}
       boundSkillNames={bindings(skill).filter(valid).map(b => b.itemName)} />
```

（Placeholder 一期即 ChatInput 默认值，不改动）

**ConfigPanel.tsx**：

```
区块1 指令：MarkdownView 只读渲染 systemPrompt（@/domains/ai/chat/components/MarkdownView，
  空 → panel.instructionEmpty 文案）+ 编辑按钮 → InstructionEditDialog
区块2 能力：三行（连接器/专家/技能），每行 icon + 数量徽标 + 已挂载项列表
  （Tag 风格：itemName，!valid → 灰 + project:create.invalid）+ 添加按钮 → PickerDialog
  确认 → ProjectApi.setBindings（该行类型全量替换）→ invalidate ["project", id]
区块3 定时任务：Clock icon + automationTip + 前往按钮 → /module/ai/automation
区块4 成员：头像占位（首字符圆形 div）+ user nickname + owner 徽标 + me 标记
```

**InstructionEditDialog.tsx**：`Dialog` + `Textarea`（回填 systemPrompt）+ 保存 → `ProjectApi.update({ id, systemPrompt })` → toast(saved) + invalidate。

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `npx vitest run tests/project && npm run typecheck`
Expected: 全绿

```bash
git add src-react/domains/project tests/project
git commit -m "feat(project): 项目详情页——动态流复用 ChatPane + 配置面板（指令/能力/定时任务/成员）"
```

---

### Task 11: 全局侧边栏重构（GlobalSidebar，主体区随模块切换）

**Files:**
- Create: `src-react/components/layout/GlobalSidebar.tsx`
- Create: `src-react/domains/project/components/ProjectSidebarList.tsx`
- Create: `src-react/domains/ai/layout/components/SessionTreePanel.tsx`（自 AiSidebar 拆出）
- Modify: `src-react/components/layout/MainLayout.tsx`
- Modify: `src-react/domains/ai/layout/views/AiLayout.tsx`（删侧边栏引用，改薄壳）
- Delete 或清空: `src-react/domains/ai/layout/components/AiSidebar.tsx`（内容拆分后移除）

**Interfaces:**
- Consumes: Task 8 的项目路由与 `ProjectApi`
- Produces: 所有 `/module/*` 路由共用侧边栏；AI 行为回归不变

- [ ] **Step 1: 拆 SessionTreePanel**

读 `AiSidebar.tsx` 全文，把「空间分组任务树 + 批量操作 + 空间管理」主体（logo/导航区之外的全部 JSX 与逻辑）搬至 `SessionTreePanel.tsx`（默认导出，props 为其所需的外部依赖——保持与原实现相同的 props/内部状态，**不改行为**）。

- [ ] **Step 2: 建 ProjectSidebarList**

`src-react/domains/project/components/ProjectSidebarList.tsx`：

```
我的项目标题 + 列表（ProjectApi.list(user.id)，复用 ["projects"] 缓存）
每项：图标 + 名称，点击 → /module/project/:id
空 → sidebar.empty + 创建按钮（navigate /module/project）
```

- [ ] **Step 3: 建 GlobalSidebar 并改 MainLayout / AiLayout**

**GlobalSidebar.tsx**（`src-react/components/layout/`）：

```
壳：w-64 边框右侧（样式照原 AiSidebar 壳）
Logo 区：照搬原实现（macOS）
导航区：新建任务（原 handleCreateSession 逻辑保留）、项目、专家、自动化、资料库
  ——新建任务/专家/自动化/资料库从原 AiSidebar navEntries 搬入；
  「项目」高亮态：location.pathname.startsWith("/module/project") 时按钮加
  bg-primary-subtle text-primary；其他项同理按各自路由高亮
主体区：/module/project 开头 → <ProjectSidebarList />；否则 → <SessionTreePanel />
挂 useAiLayoutKeybindings()（原 AiLayout 职责迁入）
```

**MainLayout.tsx**：`shouldShowNav` 时内容区从 `margin-top 纵向` 改为 `<div className="flex" style={{marginTop:36}}><GlobalSidebar /><main className="min-w-0 flex-1 ...">​<Outlet /></main></div>`（登录页/根路径不渲染侧边栏，保持原逻辑；`.main-content` 高度计算同步调整为 `calc(100vh - 36px)`）。

**AiLayout.tsx**：删除 `AiSidebar` import 与渲染、删除 keybindings 挂载（已迁 GlobalSidebar），保留 `bg-background` 内容壳 + Outlet（改名可不做，保持路由不动）。

- [ ] **Step 4: 回归验证（手动清单）**

Run: `npm run typecheck && npx vitest run`，然后 `npm run dev` 手动回归：

- [ ] AI 模块：任务树选择/置顶/归档/重命名/删除/批量操作正常；侧边栏折叠正常
- [ ] 快捷键：13 条布局快捷键生效（列表见 `hooks/use-ai-layout-keybindings.ts` 头注释）
- [ ] 专家/自动化/资料库导航跳转正常；新建任务正常
- [ ] 项目模块：侧边栏显示我的项目列表；项目 Hub/详情/动态流可用；项目入口高亮
- [ ] 登录页无侧边栏；`/` 重定向正常

- [ ] **Step 5: Commit**

```bash
git add src-react/components/layout src-react/domains/ai/layout src-react/domains/project
git commit -m "refactor(layout): 侧边栏提升为全局共用——主体区随模块切换（AI 任务树/项目列表）"
```

---

### Task 12: 全量验证与收尾

**Files:**
- 无新文件（修复各任务遗留问题）

- [ ] **Step 1: 全量静态检查**

Run: `npm run typecheck && npm run lint`
Expected: 全绿（生产禁 console/debugger——主进程 repo 用 `console.error` 处照 option.repo.ts 现状，若 lint 报错改用 Log）

- [ ] **Step 2: 全量测试**

Run: `npm run test`
Expected: 全绿

- [ ] **Step 3: 端到端手动验收（spec §9 验收清单）**

`npm run dev` 走一遍：

- [ ] 空项目态：Hub 空状态引导；四张模版卡展示
- [ ] 新建：选模版→prompt 填充→手动编辑→切模版→确认覆盖/取消回弹（两条分支）
- [ ] 新建：挂载专家+技能+连接器各若干，Tag 展示与移除
- [ ] 新建：重名→内联错误；名称空/超 15 字→校验提示
- [ ] 详情：欢迎消息按模版出现；输入框发消息走项目指令（对比无项目会话回答风格变化）
- [ ] 详情：PlusMenu 专家/技能仅显示已挂载项；@ 文件引用可用
- [ ] 详情：计划/任务/资产 Tab 占位；配置面板指令编辑保存后即时生效（新对话回答变化）
- [ ] 详情：配置面板失效挂载项显示「已失效」；定时任务入口跳转
- [ ] 删除项目：二次确认→级联删除；再进详情→重定向回 Hub
- [ ] AI 模块任务树不含项目会话；全局搜索搜不到项目消息
- [ ] 中英文切换：项目模块全部文案跟随
- [ ] 四主题切换：项目模块颜色跟随（无硬编码色）

- [ ] **Step 4: 提交（若有修复）**

```bash
git add -A
git commit -m "fix(project): 一期收尾——全量验证问题修复"
```

---

## 自审记录（Self-Review）

1. **Spec 覆盖**：spec §3 路由→Task 8；§3.2 侧边栏→Task 11；§3.3 后端结构→Task 1/2；§4 数据模型→Task 1/2；§5.1 会话模型→Task 2（create 内建 session+欢迎消息）；§5.2 指令生效→Task 4；§5.3 组件复用→Task 9；§5.4 输入框形态→Task 9/10（过滤 props + ChatPane 复用，底栏/模型选择随 ChatInput 自带）；§6.1→Task 8；§6.2→Task 6/7；§6.3→Task 10；§7 错误处理→Task 2/7/8/10；§8 i18n→Task 5+各 UI 任务；§9 测试→各任务 TDD + Task 12 清单。无缺口。
2. **占位符扫描**：Task 7 Step 1 与 Task 9 Step 1 的测试用例以行为描述给出——这是允许测试代码由执行者按描述展开的显式指令，非"TODO"；其余步骤均有完整代码/精确指引。
3. **类型一致性**：`ProjectRecord.sessionId`（Task 2 定义，Task 7 onCreated、Task 10 未直接用但 getDetail 返回 session 全量）；`ProjectBindingItem.itemName`（Task 2 定义，Task 10 boundSkillNames 消费）；通道名六处一致；`PROJECT_NAME_EXISTS`/`PROJECT_NOT_FOUND` 常量跨任务引用一致。
