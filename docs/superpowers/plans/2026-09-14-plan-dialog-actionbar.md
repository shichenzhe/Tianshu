# 项目计划模块 · 子系统 D：弹窗增强 + 底部全局操作栏 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** planItem 增描述与附件（v6 + planItemAttachment）、PlanItemDialog 胶囊化/Markdown 预览/全屏/附件、ChatInput 提升为工作台级底栏（@ 项目待办 + 本地任务开关）。

**Architecture:** v6 迁移加 description 列与 planItemAttachment 表（附件=关联记录，文件实体走 asset 域 attachments/ 子目录，删事项级联删关联保留文件）；PlanItemDialog 表单 grid 改五胶囊 Popover + 描述预览 + 全屏；ChatPane 拆出 ChatMessages（消息区，无发送依赖）而 ChatPane 变组合壳（AI 模块零改动），新 ProjectChatBar 持全部发送状态渲染 ChatInput 贯穿四 Tab；@ 待办引用以 `#<id>` token 文法实现（id 解析、pill 查缓存显示标题）。

**Tech Stack:** 既有栈零新依赖（MarkdownView/asset 域/PlusMenu 先例复用）；Vitest（node:sqlite 测 v6、jsdom 测组件）。

**Spec:** `docs/superpowers/specs/2026-09-14-plan-dialog-actionbar-design.md`

## Global Constraints

- 文案走 `t()`，zh-CN 与 en-US 同步新增；key camelCase。
- 颜色主题变量；弹层 `border border-border/50 rounded-lg shadow-lg`；hover 三件套。
- IPC 通道小驼峰：`planItem:attachments:list/create/delete`。
- 数据库迁移：`electron/infrastructure/script/v6/upgrade-table.sql` + `Constants.DATABASE_VERSION` 5→6；`npx prisma generate` 输出 TRACKED 随任务提交。
- 附件语义（spec 裁决）：删事项级联删关联**保留实体文件**；上传后取消新建的孤儿文件可接受；新建态附件本地暂存、保存成功后批量 create。
- ChatPane 拆分约束：**AI 模块（ChatView）零改动零行为变化**——ChatPane 保持原 props 导出为组合壳；AgentProgress 跟随输入框（ChatPane 壳与 ProjectChatBar 各自内嵌），ChatMessages 无发送依赖。
- 待办 token 文法：`#<id>`（TOKEN_RE 分支 `#\d+`，id 解析；pill 显示查 planItems 缓存标题；`PendingFile.kind` 联合加 `"todo"`）。
- 验证命令：`npm run test` / `npm run typecheck` / `npm run lint`——每任务三绿后 commit。

---

### Task 1: v6 迁移（description 列 + planItemAttachment 表）

**Files:**
- Create: `electron/infrastructure/script/v6/upgrade-table.sql`
- Modify: `prisma/schema.prisma`（planItem 加 description；末尾追加 planItemAttachment model）
- Modify: `electron/Constants.ts`（DATABASE_VERSION 5→6）
- Test: `tests/project/plan-item-v6-schema.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: DB 列 `planItem.description TEXT NULL`；表 `planItemAttachment(id, planItemId, fileName, assetPath, createdAt)` + 索引 `plan_item_attachment_planItemId_index`；`prisma.planItemAttachment` 客户端（T2 用）

- [ ] **Step 1: 写失败的 schema 测试**（照抄 v5 测试模式：node:sqlite + `--/ignore` 语义 helper，按序执行 v4+v5+v6——v5 含 planView 建表，v6 依赖 planItem（v4 建））

```ts
// tests/project/plan-item-v6-schema.test.ts
// @vitest-environment node
/** v6 增量脚本测试（沿用 v5 测试的 node:sqlite + --/ignore 语义 helper）：
 * description 列存在且 NULL 默认；planItemAttachment 建表幂等 + planItemId 索引 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const scriptDir = (version: string) =>
  path.resolve(__dirname, `../../electron/infrastructure/script/v${version}/upgrade-table.sql`);

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
  for (const version of ["4", "5", "6"]) {
    for (const stmt of statements(readFileSync(scriptDir(version), "utf8"))) {
      db.exec(stmt);
    }
  }
  return db;
}

describe("v6 增量脚本（description 列 + planItemAttachment 表）", () => {
  it("planItem 新增 description 列，默认 NULL", () => {
    const db = createDb();
    const columns = (
      db.prepare("PRAGMA table_info(planItem)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("description");
    db.exec(
      `INSERT INTO planItem (title, createdById, updatedAt) VALUES ('t', 1, '2026-09-14 00:00:00')`,
    );
    expect(
      db.prepare("SELECT description FROM planItem WHERE id = 1").get(),
    ).toEqual({ description: null });
  });

  it("planItemAttachment 建表幂等 + planItemId 索引存在", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO planItemAttachment (planItemId, fileName, assetPath, createdAt)
       VALUES (1, 'a.pdf', 'attachments/a.pdf', '2026-09-14 00:00:00')`,
    );
    const indexes = (
      db.prepare("PRAGMA index_list(planItemAttachment)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("plan_item_attachment_planItemId_index");
    for (const stmt of statements(readFileSync(scriptDir("6"), "utf8"))) {
      expect(() => db.exec(stmt)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-item-v6-schema.test.ts`
Expected: FAIL（script/v6 不存在，ENOENT）

- [ ] **Step 3: 写 v6 脚本 + schema + 版本号**

```sql
-- electron/infrastructure/script/v6/upgrade-table.sql
--/p 计划事项描述（子系统 D：Markdown 原文，弹窗内编辑/预览）
--/ignore
ALTER TABLE planItem ADD COLUMN description TEXT NULL;
--/p 计划事项附件关联表（子系统 D：文件实体在项目资产空间 attachments/ 子目录，删事项级联删关联保留文件）
CREATE TABLE IF NOT EXISTS planItemAttachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planItemId INTEGER NOT NULL,
    fileName TEXT NOT NULL,
    assetPath TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_attachment_planItemId_index ON planItemAttachment (planItemId);
```

`prisma/schema.prisma` planItem 模型 `source` 列后加 `description String? // Markdown 原文（弹窗编辑/预览）`；文件末尾追加：

```prisma
model planItemAttachment {
  id        Int      @id @default(autoincrement())
  planItemId Int
  fileName  String
  assetPath String
  createdAt DateTime @default(now())

  @@index([planItemId], map: "plan_item_attachment_planItemId_index")
}
```

`electron/Constants.ts`：`DATABASE_VERSION = 6`。跑 `npx prisma generate`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/project/plan-item-v6-schema.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/infrastructure/script/v6 prisma/schema.prisma electron/Constants.ts electron/generated tests/project/plan-item-v6-schema.test.ts
git commit -m "feat(project): 数据库 v6——planItem 加 description 列、新建 planItemAttachment 附件关联表"
```

---

### Task 2: entity/repo 扩展（description 透传 + attachments 三通道 + 级联）

**Files:**
- Modify: `electron/domains/project/plan-item.entity.ts`
- Modify: `electron/domains/project/plan-item.repo.ts`
- Modify: `electron/domains/project/project.repo.ts`（remove 级联补一行）
- Test: `tests/project/plan-item-repo.test.ts`、`tests/project/project-repo.test.ts`

**Interfaces:**
- Consumes: T1 的 `prisma.planItemAttachment`
- Produces:
  - `PlanItemRecord.description: string`（null 容错归一空串）；`PlanItemCreateParams/UpdateParams` 加 `description?: string | null`（update null = 清空）
  - `PlanItemAttachmentRecord { id: number; planItemId: number; fileName: string; assetPath: string; createdAt: string }`
  - repo 方法：`listAttachments(planItemId): Promise<PlanItemAttachmentRecord[]>`、`createAttachment(planItemId, { fileName, assetPath }): Promise<PlanItemAttachmentRecord>`、`removeAttachment(id): Promise<void>`
  - 通道：`planItem:attachments:list|create|delete`

- [ ] **Step 1: 追加失败的测试**（plan-item-repo.test.ts：prismaStub 补 `planItemAttachment: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() }`）

```ts
describe("PlanItemRepository.description 透传", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create 透传 description；缺省空串语义经 DB null 由 toRecord 归一", async () => {
    prismaStub.planItem.create.mockResolvedValue({ ...projectRow, id: 9 });
    await repo.create({ createdById: 1, projectId: 11, title: "t", description: "# 计划" });
    expect(prismaStub.planItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: "# 计划" }),
    });
  });

  it("toRecord：DB null → 空串（list 断言）", async () => {
    prismaStub.planItem.findMany.mockResolvedValue([{ ...projectRow, description: null }]);
    const rows = await repo.list(11);
    expect(rows[0].description).toBe("");
  });

  it("update description null = 清空", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await repo.update({ id: 1, description: null });
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { description: null },
    });
  });
});

describe("PlanItemRepository.attachments 三通道", () => {
  const attRow = {
    id: 5, planItemId: 1, fileName: "a.pdf",
    assetPath: "attachments/a.pdf", createdAt: now,
  };

  beforeEach(() => vi.clearAllMocks());

  it("list 按 planItemId 查询并转 ISO", async () => {
    prismaStub.planItemAttachment.findMany.mockResolvedValue([attRow]);
    const rows = await repo.listAttachments(1);
    expect(prismaStub.planItemAttachment.findMany).toHaveBeenCalledWith({
      where: { planItemId: 1 },
      orderBy: { id: "asc" },
    });
    expect(rows[0]).toEqual({ ...attRow, createdAt: now.toISOString() });
  });

  it("create 建关联；delete 按 id 删", async () => {
    prismaStub.planItemAttachment.create.mockResolvedValue(attRow);
    const created = await repo.createAttachment(1, { fileName: "a.pdf", assetPath: "attachments/a.pdf" });
    expect(prismaStub.planItemAttachment.create).toHaveBeenCalledWith({
      data: { planItemId: 1, fileName: "a.pdf", assetPath: "attachments/a.pdf" },
    });
    expect(created.id).toBe(5);
    await repo.removeAttachment(5);
    expect(prismaStub.planItemAttachment.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  it("remove 事项级联删附件关联（保留文件）", async () => {
    await repo.remove(1);
    expect(prismaStub.planItemAttachment.deleteMany).toHaveBeenCalledWith({
      where: { planItemId: 1 },
    });
  });
});
```

project-repo.test.ts 的 remove 级联断言追加（prismaStub 补 planItemAttachment.deleteMany）：

```ts
    expect(prismaStub.planItemAttachment.deleteMany).toHaveBeenCalledWith({
      where: { planItemId: 11 },
    });
```

（自注册 describe 的通道断言数组补三个 `planItem:attachments:*`。）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-item-repo.test.ts tests/project/project-repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`plan-item.entity.ts`：

```ts
/** 附件关联记录（文件实体在项目资产空间，删事项级联删关联保留文件） */
export interface PlanItemAttachmentRecord {
  id: number;
  planItemId: number;
  /** 展示名（含扩展） */
  fileName: string;
  /** 项目 workspace 相对路径（attachments/xxx 或资产树已有文件） */
  assetPath: string;
  createdAt: string;
}
```

`PlanItemRecord` 加 `description: string;`（JSDoc：Markdown 原文，空串=无）；Create/Update 加 `description?: string | null`（update null = 清空）。

`plan-item.repo.ts`：
1. import 补 `type PlanItemAttachmentRecord`。
2. `registerHandlers` 加三通道：

```ts
    ipcMain.handle("planItem:attachments:list", (_, planItemId: number) =>
      this.listAttachments(planItemId),
    );
    ipcMain.handle(
      "planItem:attachments:create",
      (_, planItemId: number, input: { fileName: string; assetPath: string }) =>
        this.createAttachment(planItemId, input),
    );
    ipcMain.handle("planItem:attachments:delete", (_, id: number) =>
      this.removeAttachment(id),
    );
```

3. `create` data 加 `description: params.description ?? null`；`buildUpdateData` 加 `...(params.description !== undefined && { description: params.description })`；`toRecord` 加 `description: row.description ?? ""`。
4. `remove` 在 `planItem.delete` 前加：

```ts
    await prisma.planItemAttachment.deleteMany({ where: { planItemId: id } });
```

5. 附件三方法（toAttachmentRecord 私有转 ISO）：

```ts
  /** 事项附件关联列表（id asc） */
  async listAttachments(planItemId: number): Promise<PlanItemAttachmentRecord[]> {
    const rows = await prisma.planItemAttachment.findMany({
      where: { planItemId },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => this.toAttachmentRecord(row));
  }

  /** 建附件关联（上传/挑选同构：一行关联记录） */
  async createAttachment(
    planItemId: number,
    input: { fileName: string; assetPath: string },
  ): Promise<PlanItemAttachmentRecord> {
    const fileName = input.fileName.trim();
    const assetPath = input.assetPath.trim();
    if (!fileName || !assetPath) {
      throw new Error("附件名与路径不能为空");
    }
    const row = await prisma.planItemAttachment.create({
      data: { planItemId, fileName, assetPath },
    });
    return this.toAttachmentRecord(row);
  }

  /** 删附件关联（文件实体保留在资产空间） */
  async removeAttachment(id: number): Promise<void> {
    await prisma.planItemAttachment.delete({ where: { id } });
  }

  private toAttachmentRecord(row: {
    id: number; planItemId: number; fileName: string; assetPath: string; createdAt: Date;
  }): PlanItemAttachmentRecord {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }
```

`project.repo.ts` remove()：planView.deleteMany 行后加 `await prisma.planItemAttachment.deleteMany({});`——**注意**：项目删除时 planItem 按 projectId 删但附件表无 projectId 列，需先按事项 id 集删：

```ts
    const itemIds = await prisma.planItem.findMany({
      where: { projectId: id },
      select: { id: true },
    });
    await prisma.planItemAttachment.deleteMany({
      where: { planItemId: { in: itemIds.map((item) => item.id) } },
    });
```

（放在 planItem.deleteMany 之前。）

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/project/plan-item-repo.test.ts tests/project/project-repo.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/project/plan-item.entity.ts electron/domains/project/plan-item.repo.ts electron/domains/project/project.repo.ts tests/project/plan-item-repo.test.ts tests/project/project-repo.test.ts
git commit -m "feat(project): planItem description 透传 + planItemAttachment 三通道与事项/项目级联（删关联保留文件）"
```

---

### Task 3: 弹窗改版·布局（胶囊化 + 描述预览 + 全屏 + ISO 构造器合并）

**Files:**
- Create: `src-react/domains/project/components/PlanItemCapsuleRow.tsx`（五胶囊行）
- Modify: `src-react/domains/project/components/PlanItemDialog.tsx`（布局重构）
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/project/plan-item-dialog.test.tsx`

**Interfaces:**
- Consumes: 既有五属性控件逻辑（Select/成员/标签 chips/双 date Input）；`MarkdownView`（`@/domains/ai/chat/components/MarkdownView`，props `{ text: string }`）；T2 的 `description` 参数。
- Produces:
  - `PlanItemCapsuleRow` props：`{ status; priority; tags; assigneeId; startDate; dueDate; members; projectIdIsNull; onChange: (patch: Partial<{ status: PlanStatus; priority: PlanPriority; tags: string[]; assigneeId: number | null; startDate: string; dueDate: string }>) => void }`（startDate/dueDate 为 yyyy-MM-dd 本地串）
  - PlanItemDialog 增 `maximized` 本地态与 `previewing` 本地态；props 不变。

- [ ] **Step 1: 追加失败的测试**（既有 mock 骨架；用例清单）

1. 「描述输入 Markdown → 点『预览』出现 MarkdownView 渲染（断言其容器/文本），再点回编辑态 textarea」
2. 「五胶囊渲染：各显示字段名或当前值摘要；点『状态』胶囊 → Popover 内出现四态选项，选中 → 胶囊摘要变为所选」
3. 「时间规划胶囊：Popover 内两个 date Input，改截止日 → onChange 链保存 payload dueDate 正确」
4. 「处理人胶囊：项目任务弹成员列表；本地任务（projectId null）胶囊只读『我』且不可开」
5. 「全屏切换：点右上按钮 → DialogContent class 含 `w-screen`；再点还原」
6. 「描述保存：create/update 携带 description」
7. 「回归：标题校验/标签/成员/日期回填/Enter 提交既有用例全过」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-item-dialog.test.tsx`
Expected: FAIL（新用例）

- [ ] **Step 3: 实现 PlanItemCapsuleRow**

```tsx
/**
 * 属性胶囊行（子系统 D spec §2.3）：状态/处理人/优先级/标签/时间规划五胶囊，
 * 各点开 Popover 收纳原控件；胶囊显示当前值摘要（无值显示字段名 muted）。
 * 纯受控：一切修改经 onChange(patch) 上抛。
 */
import { useTranslation } from "react-i18next";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import type { PlanItemRecord, PlanPriority, PlanStatus } from "../../../../electron/domains/project/plan-item.entity";
import { PLAN_PRIORITIES, PLAN_STATUSES } from "../../../../electron/domains/project/plan-item.entity";
import { PRIORITY_LABEL_KEYS, STATUS_LABEL_KEYS } from "./PlanItemDialog";

interface CapsulePatch {
  status: PlanStatus;
  priority: PlanPriority;
  tags: string[];
  assigneeId: number | null;
  startDate: string;
  dueDate: string;
}

interface PlanItemCapsuleRowProps {
  status: PlanStatus;
  priority: PlanPriority;
  tags: string[];
  assigneeId: number | null;
  startDate: string;
  dueDate: string;
  members: ProjectMemberItem[];
  /** 本地任务：处理人胶囊只读 */
  projectIdIsNull: boolean;
  onChange: (patch: Partial<CapsulePatch>) => void;
}

/** 单胶囊外壳：触发按钮（摘要）+ Popover 内容插槽 */
function Capsule({
  label,
  summary,
  filled,
  children,
}: {
  label: string;
  summary: string;
  filled: boolean;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          className="h-7 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <span className={cn(filled ? "text-foreground" : "text-muted-foreground")}>
            {summary || label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-lg border border-border/50 p-3 shadow-lg">
        {children}
      </PopoverContent>
    </Popover>
  );
}
```

（其余四个 Capsule 组装 + 主组件 `PlanItemCapsuleRow`：状态胶囊 = 四态按钮列；优先级 = P0-P3 按钮列；处理人 = 成员按钮列（本地任务渲染单个只读触发按钮代替 Capsule）；标签 = 输入回车添加 + RemovableTag 列（逻辑同弹窗原实现，搬移）；时间规划 = 两个 `Input type="date"` + CalendarRange 图标摘要 `9.14 ~ 9.20`（formatShort：`Number(m+1).Number(d)`）。摘要规则：状态/优先级 = t(labelKey)；处理人 = 昵称/未指派；标签 = 首标签(+n)；时间 = 双端齐全 `a ~ b`、单端 `→ b`/`a →`、无值空。）

- [ ] **Step 4: PlanItemDialog 布局重构**

结构（替换现 grid 段与标签/处理人/日期区）：

```tsx
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="plan-item-title">{t("project:plan.title")}</Label>
            <Input id="plan-item-title" ... />
            {titleError && ...}
          </div>
          {/* 描述：textarea ⇄ MarkdownView 预览 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="plan-item-description">{t("project:plan.description")}</Label>
              <Button variant="ghost" size="sm" onClick={() => setPreviewing((v) => !v)}
                className="h-6 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary">
                {previewing ? t("project:plan.editMode") : t("project:plan.preview")}
              </Button>
            </div>
            {previewing ? (
              <div className="min-h-24 rounded-md border border-border/50 p-2">
                <MarkdownView text={description} />
              </div>
            ) : (
              <textarea id="plan-item-description" value={description}
                onChange={(e) => setDescription(e.target.value)} rows={4}
                aria-label={t("project:plan.description")}
                className="w-full resize-y rounded-md border border-border/50 bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
            )}
          </div>
          {/* 属性胶囊行（替代表单 grid 与标签/处理人/日期区） */}
          <PlanItemCapsuleRow status={status} priority={priority} tags={tags}
            assigneeId={assigneeId} startDate={startDate} dueDate={dueDate}
            members={members} projectIdIsNull={projectId === null}
            onChange={(patch) => {
              if (patch.status !== undefined) setStatus(patch.status);
              if (patch.priority !== undefined) setPriority(patch.priority);
              if (patch.tags !== undefined) setTags(patch.tags);
              if (patch.assigneeId !== undefined) setAssigneeId(patch.assigneeId);
              if (patch.startDate !== undefined) setStartDate(patch.startDate);
              if (patch.dueDate !== undefined) setDueDate(patch.dueDate);
            }} />
          {/* 自定义字段动态区（原样保留） */}
          ...
        </div>
```

其他改动：`const [description, setDescription] = useState("");` + 回填 `setDescription(item?.description ?? "")`；保存 payload `description: description || null`（空串存 null，读侧归一空串）；右上全屏按钮（DialogHeader 行内，Maximize2/Minimize2 图标）切 `maximized`，DialogContent className 三元：`maximized ? "h-[100dvh] w-screen max-w-none rounded-none sm:max-w-none" : "max-h-[85vh] overflow-y-auto rounded-lg border-border/50 shadow-lg sm:max-w-lg"`；**Esc 分层**（radix onOpenChange 只有关闭语义——用 DialogContent onKeyDown 捕获：`maximized && e.key === "Escape" && !previewing 时 e.preventDefault() + setMaximized(false)`，radix 关闭在前者之后判定，全屏态 Esc 仅退全屏）；`toIsoOrNull` 删除改用 `dateKeyToIso`（import from `../model/plan-date`）。头注释同步。

- [ ] **Step 5: i18n**

zh：`"description": "描述"`、`"preview": "预览"`、`"editMode": "编辑"`、`"timeRange": "时间规划"`、`"attachments": "附件"`（T4 备用）；en：`"Description"`、`"Preview"`、`"Edit"`、`"Schedule"`、`"Attachments"`。

- [ ] **Step 6: 运行确认通过**

Run: `npm run test -- tests/project/plan-item-dialog.test.tsx && npm run typecheck && npm run lint`
Expected: PASS（含全部回归）

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/project/components/PlanItemCapsuleRow.tsx src-react/domains/project/components/PlanItemDialog.tsx src-react/i18n/locales tests/project/plan-item-dialog.test.tsx
git commit -m "feat(project): 弹窗改版——五属性胶囊 Popover 行 + Markdown 描述预览 + 全屏模式 + ISO 构造器合并 dateKeyToIso"
```

---

### Task 4: 弹窗附件（上传/挑选/暂存-批量挂/删除）

**Files:**
- Create: `src-react/domains/project/components/PlanItemAttachments.tsx`
- Modify: `src-react/domains/project/components/PlanItemDialog.tsx`（挂附件区 + 保存后批量挂）
- Modify: `src-react/domains/project/api/plan-item.api.ts`（attachments 三方法 + key）
- Modify: `src-react/lib/ipc.ts`（三通道类型）
- Test: `tests/project/plan-item-attachments.test.tsx`、`tests/project/plan-item-api.test.ts`（追加）

**Interfaces:**
- Consumes: T2 通道；`AssetApi.upload(projectId, folderPath, absPaths) → { uploaded: string[]; failed: string[] }`、`AssetApi.pickFiles() → string[] | null`、ai 侧 `file:listWorkspaceFiles(workspaceId) → string[] | null`（经 `@/domains/ai/api/file.api`——执行时核对实际导出名与通道封装）。
- Produces:
  - `PlanItemAttachments` props：`{ projectId: number | null; workspaceId?: number; planItemId?: number; value: PendingAttachment[]; onChange: (next: PendingAttachment[]) => void }`，`PendingAttachment = { id?: number; fileName: string; assetPath: string }`（id 有 = 已挂库记录，删走通道；无 = 暂存/待建）
  - `PlanItemApi.listAttachments/createAttachment/removeAttachment` + `PLAN_ITEM_ATTACHMENTS_KEY(planItemId)`

- [ ] **Step 1: api 封装（先薄层 + 测试）**

```ts
// plan-item.api.ts 追加
export const PLAN_ITEM_ATTACHMENTS_KEY = (planItemId: number) =>
  ["planItemAttachments", planItemId] as const;

  /** 事项附件关联列表 */
  static async listAttachments(planItemId: number): Promise<PlanItemAttachmentRecord[]> {
    return invoke<PlanItemAttachmentRecord[]>("planItem:attachments:list", planItemId);
  }
  /** 建附件关联（上传/挑选同构） */
  static async createAttachment(
    planItemId: number,
    input: { fileName: string; assetPath: string },
  ): Promise<PlanItemAttachmentRecord> {
    return invoke<PlanItemAttachmentRecord>("planItem:attachments:create", planItemId, input);
  }
  /** 删附件关联（保留实体文件） */
  static async removeAttachment(id: number): Promise<void> {
    return invoke<void>("planItem:attachments:delete", id);
  }
```

（entity 类型 import 补；ipc.ts 三通道；plan-item-api.test.ts 追加三通道透传断言，照抄既有模式。）

- [ ] **Step 2: 写失败的组件测试**（用例清单）

1. 「回形针菜单两项：上传文件 / 从资产挑选；本地任务（projectId null）附件区隐藏」
2. 「上传：mock AssetApi.pickFiles 返回 ['/tmp/a.pdf']、upload 返回 { uploaded: ['a.pdf'], failed: [] } → onChange 收到 { fileName: 'a.pdf', assetPath: 'attachments/a.pdf' }（暂存无 id）」
3. 「挑选：mock listWorkspaceFiles 返回 ['docs/b.md', 'attachments/a.pdf'] → 列表出现两项（过滤搜索框），点选 → onChange 追加 { fileName: 'b.md', assetPath: 'docs/b.md' }」
4. 「chips：value 渲染文件名 + 删除 ×；已挂（有 id）删除 → removeAttachment 调用 + onChange 移除；暂存删除仅 onChange」
5. 「上传失败（failed 非空）→ toast.error」

- [ ] **Step 3: 实现 PlanItemAttachments**

```tsx
/**
 * 事项附件区（子系统 D spec §2.5）：回形针菜单（上传文件 = pickFiles→
 * AssetApi.upload 至 attachments/ 子目录 / 从资产挑选 = listWorkspaceFiles
 * 列表选择）；chips = 文件名 + 删除（已挂记录删走 removeAttachment 通道并
 * 上抛移除，暂存项仅上抛）。本地任务（projectId null）不渲染。
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import AssetApi from "../api/asset.api";
import PlanItemApi, { PLAN_ITEM_ATTACHMENTS_KEY } from "../api/plan-item.api";

export interface PendingAttachment {
  id?: number;
  fileName: string;
  assetPath: string;
}

const ATTACHMENT_FOLDER = "attachments";
```

（组件主体：`Paperclip` Popover 触发 + 两菜单项；上传 handler：`pickFiles → upload(projectId, ATTACHMENT_FOLDER, paths) → uploaded.map(name => ({ fileName: name, assetPath: `${ATTACHMENT_FOLDER}/${name}` })) 追加 onChange`，failed 非空 toast；挑选 handler：懒开 Popover 内 Input 过滤 + listWorkspaceFiles(workspaceId) 列表（fileName = path 最后段），点选追加；chips 行：`value.map` → Badge 式 span（border-border/50）+ X 按钮（有 id → `void PlanItemApi.removeAttachment(id)` + invalidate key + 上抛移除；无 id 仅上抛）。）

- [ ] **Step 4: PlanItemDialog 接线**

props 加 `assetWorkspaceId?: number`；state `const [attachments, setAttachments] = useState<PendingAttachment[]>([])`；打开回填：编辑态 `useQuery(PLAN_ITEM_ATTACHMENTS_KEY(item.id), () => PlanItemApi.listAttachments(item.id), { enabled: open && !!item })` → effect 同步到 state；新建态清空。附件区渲染（自定义字段区之后）：`<PlanItemAttachments projectId={projectId} workspaceId={assetWorkspaceId} value={attachments} onChange={setAttachments} />`。保存 handler：create/update 成功拿到事项 id（create 返回 record；update 用 item.id）后 `await Promise.all(attachments.filter(a => !a.id).map(a => PlanItemApi.createAttachment(id, a)))`，失败 toast 但不阻断关闭（附件可重挂）；handleSave 增量：`description: description || null`。PlanPane 调用处传 `assetWorkspaceId={detailQuery.data?.assetWorkspaceId}`——**PlanPane 现无 detail**：PlanPane props 加 `assetWorkspaceId?: number`，由 ProjectWorkspaceView 传入 `detail.assetWorkspaceId`（改动这两个文件各一行 + workspace 测试 props 断言同步）。

- [ ] **Step 5: 运行确认通过**

Run: `npm run test -- tests/project/plan-item-attachments.test.tsx tests/project/plan-item-api.test.ts tests/project/plan-item-dialog.test.tsx && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/project/components/PlanItemAttachments.tsx src-react/domains/project/components/PlanItemDialog.tsx src-react/domains/project/api/plan-item.api.ts src-react/domains/project/components/PlanPane.tsx src-react/domains/project/views/ProjectWorkspaceView.tsx src-react/lib/ipc.ts src-react/i18n/locales tests
git commit -m "feat(project): 弹窗附件——上传入资产空间/资产挑选/新建暂存保存后批量挂/chips 删除（删关联保留文件）"
```

---

### Task 5: ChatPane 拆分（ChatMessages 导出 + 组合壳，AI 模块零改动）

**Files:**
- Create: `src-react/domains/ai/chat/components/ChatMessages.tsx`
- Modify: `src-react/domains/ai/chat/components/ChatPane.tsx`（改组合壳）
- Test: `tests/ai/chat-view-edit-optimistic.test.tsx`（回归）、`tests/ai/chat-messages.test.tsx`（新建）

**Interfaces:**
- Consumes: ChatPane 现有结构与 props（探索报告 §2：15 props 传 ChatInput；`useChatSend` 唯一实例注释）。
- Produces:
  - `ChatMessages`（新导出）：props = `ChatPaneProps`（原样）——**消息区子树**（MessageList + artifacts 面板），无发送依赖、无 ChatInput。
  - `ChatPane`（组合壳，**props 签名与导出名完全不变**）：内部持有 useChatSend/accessMode/handleSend/handleRunCommand（原逻辑原位置不动）→ 渲染 `<ChatMessages {...原props} />` + 底部 `AgentProgress（sending 时）+ div.p-4 > ChatInput`。AI 模块（ChatView）零改动零行为变化。

- [ ] **Step 1: 写失败的测试**

`tests/ai/chat-messages.test.tsx`（新建，jsdom；mock 骨架参照 chat-view-edit-optimistic.test.tsx：MessageList stub 等）：
1. 「ChatMessages 渲染消息区（MessageList stub 出现）且**无 ChatInput**（无 textarea/发送按钮）」
2. 「ChatMessages 接收原 ChatPaneProps（session 等）透传 MessageList」
3. 「组合壳 ChatPane 完整性回归：既有 chat-view-edit-optimistic.test.tsx 全过（ChatInput 仍在 ChatPane 内、行为不变）」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/chat-messages.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现拆分**

1. 新建 `ChatMessages.tsx`：从 ChatPane.tsx 剪切「内列 div.flex.min-w-0.flex-1.flex-col 的 MessageList 部分 + artifacts 旁挂」为独立组件（文件头中文 JSDoc：消息区，无发送依赖，发送状态与输入在组合壳/调用方）；props = ChatPaneProps 原样透传 MessageList 所需（session 等）。
2. `ChatPane.tsx` 改为：原 props/状态/hooks（useChatSend/accessMode effect/handleSend/handleRunCommand）**全部保留原位**；return 渲染 `<ChatMessages {...chatPaneProps} />` + 输入区（AgentProgress + p-4 > ChatInput 15 props 原样）——即「原 return 的消息区子树替换为 `<ChatMessages/>`，其余不动」。头注释补一句拆分说明。

- [ ] **Step 4: 运行确认通过（含 AI 模块回归）**

Run: `npm run test -- tests/ai/chat-messages.test.tsx tests/ai/chat-view-edit-optimistic.test.tsx tests/ai/context-usage.test.ts && npm run typecheck`
Expected: PASS（组合壳行为不变）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/components/ChatMessages.tsx src-react/domains/ai/chat/components/ChatPane.tsx tests/ai/chat-messages.test.tsx
git commit -m "refactor(ai): ChatPane 拆出 ChatMessages 消息区组件——组合壳保持原 props 与行为（AI 模块零改动），为项目底栏提升铺路"
```

---

### Task 6: ProjectChatBar 底栏（ChatInput 工作台级贯穿）

**Files:**
- Create: `src-react/domains/project/components/ProjectChatBar.tsx`
- Modify: `src-react/domains/project/views/ProjectWorkspaceView.tsx`（flex-col + 底栏）
- Modify: `src-react/domains/project/components/ActivityPane.tsx`（ChatPane → ChatMessages）
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/project/project-chat-bar.test.tsx`（新建）、`tests/project/project-workspace.test.tsx`（更新）

**Interfaces:**
- Consumes: T5 的 `ChatMessages`；`ChatInput`（15 props，见 ChatInput.tsx:62-91）；`useChatSend(sessionId)`；`ChatApi.getPermission/setPermission`（accessMode 初始化与落库——从 ChatPane 复制语义）；`detail: ProjectDetail`（session/assetWorkspaceId/bindings）。
- Produces:
  - `ProjectChatBar` props：`{ detail: ProjectDetail; onOpenSettings: (target: "providers" | "assistants" | "mcp") => void }`——自持 useChatSend/accessMode/handleSend（文件引用前缀注入语义同 ChatPane 原实现）/handleRunCommand；渲染 AgentProgress（sending）+ ChatInput（placeholder 为项目文案）。
  - ActivityPane 改渲染 `ChatMessages`（原 ChatPane props 减发送相关）。
  - ProjectWorkspaceView 布局：左列内容区 flex-1 + 底栏 `border-t border-border/50` 常驻（providers/models 双空时底栏不渲染——与 ActivityPane 的 SetupGuide 条件一致）。

- [ ] **Step 1: 写失败的测试**

`tests/project/project-chat-bar.test.tsx`（jsdom；ChatInput/MessageList stub 为 props 捕获）：
1. 「渲染 ChatInput（stub 出现）且传入 detail.session.id 对应 sessionId、workspaceId=assetWorkspaceId、boundAssistantIds/boundSkillNames 过滤（同 ActivityPane 现逻辑）」
2. 「placeholder = project:chatBar.placeholder 文案 key」
3. 「handleSend：ChatInput stub 触发 onSend('hi', []) → ChatApi.send 被调（经 useChatSend 真实例或 stub send）」
4. 「sending 时 AgentProgress stub 出现」

`project-workspace.test.tsx` 更新（现 mock ChatPane 为 props stub——改 mock ChatMessages + ProjectChatBar）：
5. 「四 Tab 任意切换底栏 ProjectChatBar 恒在（计划 Tab 下输入框存在）」
6. 「动态流 Tab：ChatMessages 在、无第二 ChatInput（ProjectChatBar 的 ChatInput 唯一）」
7. 「providers/models 双空：SetupGuide 且无底栏」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/project-chat-bar.test.tsx tests/project/project-workspace.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

1. `ProjectChatBar.tsx`：从 ChatPane 复制发送状态块（useChatSend/accessMode state + getPermission 初始化 effect + handleAccessModeChange 落库 + handleSend 文件引用前缀注入 + handleRunCommand /compact）；props 解构 detail（session/workspace=assetWorkspaceId/bindings 过滤同 ActivityPane 现代码）；渲染：

```tsx
  return (
    <div className="flex flex-col border-t border-border/50">
      {sending && <AgentProgress sessionId={detail.session.id} />}
      <div className="p-4 pt-3">
        <ChatInput ...15 props（onSend={handleSend} 等，同 ChatPane 原传参）/>
      </div>
    </div>
  );
```

（AgentProgress 的实际 props 以 ChatPane 现用法为准复制；placeholder 经 ChatInput 既有 prop 或就近常量——若 ChatInput placeholder 硬编码则加可选 prop `placeholder?: string` 透传。）
2. `ActivityPane.tsx`：`<ChatPane .../>` → `<ChatMessages ... />`（去掉仅发送链需要的 onOpenSettings 若 ChatMessages 不消费——保留透传亦可）；SetupGuide 分支不动。
3. `ProjectWorkspaceView.tsx`：Tab 内容区容器 `flex-1 min-h-0`；其后加 `{hasChat ? <ProjectChatBar detail={detail} onOpenSettings={...} /> : null}`（hasChat = providers/models 非双空，与 ActivityPane 的 SetupGuide 条件取反一致——抽小函数或直接复制条件表达式；onOpenSettings 映射同 ActivityPane 现三路由）。
4. i18n：project.json `chatBar.placeholder` zh「今天帮你做些什么？@ 引用资产文件、项目待办或调用技能」/ en「What can I do for you today? @ to reference assets, plan items, or skills」。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿（含 ai 域回归）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/ProjectChatBar.tsx src-react/domains/project/views/ProjectWorkspaceView.tsx src-react/domains/project/components/ActivityPane.tsx src-react/i18n/locales tests/project/project-chat-bar.test.tsx tests/project/project-workspace.test.tsx
git commit -m "feat(project): 底部全局操作栏——ProjectChatBar 持发送状态渲染 ChatInput 贯穿四 Tab（ChatMessages 退化为动态流消息区）"
```

---

### Task 7: @ 项目待办引用（#<id> token 文法）

**Files:**
- Modify: `src-react/domains/ai/chat/lib/inline-tokens.ts`（TOKEN_RE + parse + render）
- Modify: `src-react/domains/ai/chat/lib/pending-file.ts`（kind 联合加 "todo"）
- Modify: `src-react/domains/ai/chat/components/ChatInput.tsx`（SuggestCandidate + 数据源 + selectCandidate + submit 读取）
- Test: `tests/ai/inline-tokens.test.ts`（追加）、`tests/ai/chat-input-todo.test.tsx`（新建）

**Interfaces:**
- Consumes: T6 后 ChatInput 在底栏可用；项目 planItems 缓存 `PLAN_ITEMS_KEY(projectId)`。
- Produces:
  - `SuggestCandidate` 增分支 `{ kind: "todo"; id: number; title: string }`；触发符 `#`。
  - token 文法：TOKEN_RE 增 `#\d+` 分支（`(?![\d])` 右边界防 `#1234` 截断）；`parseInlineTokens` 返回增 `todoTokens: string[]`（既有 consumers 的解构不受影响——返回对象加键向后兼容）。
  - `PendingFile.kind?: "file" | "skill" | "todo"`；`renderTokenSegments` 对 `#id` 渲染 pill（标题由消费方传入映射或就近显示 token 原文——ChatInput 内 pill 段查 items 缓存映射标题，未命中显示原文）。
  - ChatInput props 增可选 `todoItems?: Array<{ id: number; title: string; status: string; priority: string; dueDate: string }>`（ProjectChatBar 传 `PLAN_ITEMS_KEY` 缓存数据；缺省不启用 # 联想——AI 模块 ChatPane 不传则行为不变）。

- [ ] **Step 1: 追加失败的测试**

`tests/ai/inline-tokens.test.ts` 追加：

```ts
describe("todo token（#<id>）", () => {
  it("解析与边界：#12 独立成 token；#1234 不被截断；普通文本 # 不误伤", () => {
    const { todoTokens, text } = parseInlineTokens("看 #12 和 #1234，还有 # 号");
    expect(todoTokens).toEqual(["#12", "#1234"]);
    expect(text).not.toContain("#12");
  });

  it("renderTokenSegments：#12 渲染为 pill 段（kind todo）", () => {
    const segments = renderTokenSegments("看 #12");
    expect(segments.some((s) => s.kind === "todo")).toBe(true);
  });
});
```

（以 inline-tokens.ts 实际导出签名为准对齐断言形状；现有 file/skill 用例不回归。）

`tests/ai/chat-input-todo.test.tsx`（jsdom，ChatInput 直渲染 + todoItems fixture）：
1. 「输入 `#需` → 联想面板出现标题含『需』的待办项」
2. 「选中 → content 含 `#<id> `，pill 镜像层出现」
3. 「submit：onSend 收到 PendingFile kind "todo" 且 content 含【待办】摘要（title/status/priority/dueDate）」
4. 「未传 todoItems → # 无联想（AI 模块回归）」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/inline-tokens.test.ts tests/ai/chat-input-todo.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现（探索报告 §4 的 5 处照抄点）**

1. `inline-tokens.ts`：TOKEN_RE 加分支 `#\d+`（右边界 `(?!\d)`）；parse 返回加 `todoTokens`；render 段类型加 `kind: "todo"`。
2. `pending-file.ts`：kind 联合加 `"todo"`。
3. `ChatInput.tsx`：
   - `SuggestCandidate` 加 `{ kind: "todo"; id: number; title: string }`；联想 memo：触发符为 `#` 且 `todoItems` 传入时，按标题（大小写不敏感）过滤生成候选（上限同既有面板）。
   - `selectCandidate`：todo 分支插入 `` `#${candidate.id} ` ``。
   - 镜像 pill 渲染段：`#id` 段查 `todoItems` 映射标题显示（未命中显示原文）。
   - `submit()`：解析 todoTokens → 逐个从 `todoItems` 找 id → 组 `PendingFile { path: `待办#${id}`, content: `【待办】${title}｜状态:${status}｜优先级:${priority}｜截止:${dueDate || "无"}`, kind: "todo" }` 进 files（查无 id 的 token 忽略）。
4. `ProjectChatBar`：`const { data: planItems = [] } = useQuery(PLAN_ITEMS_KEY(detail.project.id), ...)`（enabled hasChat）→ `todoItems={planItems}` 传 ChatInput（detail.project.id 字段名以 ProjectDetail 实体为准——project 记录 id）。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/ai/inline-tokens.test.ts tests/ai/chat-input-todo.test.tsx tests/project/project-chat-bar.test.tsx && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/lib/inline-tokens.ts src-react/domains/ai/chat/lib/pending-file.ts src-react/domains/ai/chat/components/ChatInput.tsx src-react/domains/project/components/ProjectChatBar.tsx tests/ai/inline-tokens.test.ts tests/ai/chat-input-todo.test.tsx
git commit -m "feat(project): @ 项目待办引用——#<id> token 文法（id 解析/pill 查缓存标题/待办摘要入 prompt），todoItems 可选注入不影响 AI 模块"
```

---

### Task 8: 本地任务开关（PlusMenu toggle + handleSend 注入）+ 收尾

**Files:**
- Modify: `src-react/domains/ai/chat/components/PlusMenu.tsx`（可选 toggle props）
- Modify: `src-react/domains/project/components/ProjectChatBar.tsx`（state + 注入）
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/ai/plus-menu.test.tsx`（追加）、`tests/project/project-chat-bar.test.tsx`（追加）

**Interfaces:**
- Consumes: PlusMenu 现结构（探索 §5：模式子菜单 Check 先例）；T6 的 ProjectChatBar.handleSend。
- Produces:
  - PlusMenu 增可选 props：`localTask?: { enabled: boolean; onToggle: (next: boolean) => void }`——传入时渲染「本地任务」菜单项（`enabled && <Check className="ml-auto" />`；onClick 调 onToggle 取反；`onSelect preventDefault` 保持浮层）。未传不渲染（AI 模块零改动）。
  - ProjectChatBar：`const [localTask, setLocalTask] = useState(false)`；handleSend 在调用 send 前注入：

```ts
  const LOCAL_TASK_DIRECTIVE =
    "\n\n[用户要求] 本次创建或更新的待办事项请存储为本地任务（projectId 置空，不出现在项目计划中）。";
  // handleSend 内：
  const finalContent = localTask ? `${content}${LOCAL_TASK_DIRECTIVE}` : content;
```

- [ ] **Step 1: 追加失败的测试**

`tests/ai/plus-menu.test.tsx`：
1. 「未传 localTask → 无『本地任务』项（回归）」
2. 「传入 localTask → 项出现；点击 → onToggle(!enabled)；勾选态 Check 随 enabled」

`tests/project/project-chat-bar.test.tsx` 追加：
3. 「开关关闭发送 → ChatApi.send content 无 [用户要求]」
4. 「开关开启发送 → content 末尾含 LOCAL_TASK_DIRECTIVE」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/plus-menu.test.tsx tests/project/project-chat-bar.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

1. PlusMenu：props 加可选 `localTask`；菜单「模式」子菜单后插该项（`localTask && <DropdownMenuItem onSelect={(e) => { e.preventDefault(); localTask.onToggle(!localTask.enabled); }}>…`）；i18n key 在 ai 域或 project 域——PlusMenu 属 ai 域共享：文案 key 放 `ai.json`？**裁决：放 project.json `chatBar.localTask`（zh「本地任务」/ en「Local tasks」），PlusMenu 经可选 `localTask.label` 由调用方传入文案**（PlusMenu 不直接依赖 project 命名空间，保持 ai 域纯净）：props 形状改为 `localTask?: { enabled: boolean; label: string; onToggle: (next: boolean) => void }`。
2. ProjectChatBar：state + PlusMenu 调用点传 `localTask={{ enabled: localTask, label: t("project:chatBar.localTask"), onToggle: setLocalTask }}`；handleSend 注入（Step 3 代码块）。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/components/PlusMenu.tsx src-react/domains/project/components/ProjectChatBar.tsx src-react/i18n/locales tests/ai/plus-menu.test.tsx tests/project/project-chat-bar.test.tsx
git commit -m "feat(project): 本地任务开关——PlusMenu 可选 toggle（label 调用方传入）+ 底栏发送注入本地任务指令"
```

---

## 手动验收清单（spec §4）

1. 弹窗：Markdown 描述预览切换；五胶囊配置；全屏撰写（Esc 先退全屏）；上传/挑选附件 → 保存重开一致；删事项后资产树文件仍在。
2. 底栏：四 Tab 恒在；`#` 联想项目待办成 pill、发送 prompt 含待办摘要；PlusMenu「本地任务」开启 → AI 建待办落任务 Tab 本地；权限胶囊照常。
3. 动态流：消息区占满、单输入源；AI 模块聊天页行为不变。

## 自审记录（writing-plans Self-Review）

1. **Spec coverage**：§1 数据模型（T1/T2）；§2 弹窗（T3 布局/T4 附件）；§3 操作栏（T5 拆分/T6 底栏/T7 @待办/T8 本地任务）；§4 测试（各任务 TDD + 回归面）。孤儿裁决/级联语义/新建暂存均在 T1/T2/T4 落实。
2. **占位符**：T3 CapsuleRow 与 T4 附件组件给了骨架+精确行为描述（控件逻辑从弹窗既有实现搬移，非新发明）；T5 拆分是「剪切-组合」结构性指令（原代码即规格）；其余含完整代码/断言。无 TBD。
3. **类型一致性**：PlanItemAttachmentRecord/PendingAttachment/CapsulePatch/SuggestCandidate todo 分支/PendingFile kind/PlusMenu localTask（label 由调用方传入的最终形状在 T8 Step 3 统一）各任务间签名一致；T8 对 T3 备用的 attachments i18n key 与 T4 对齐。


