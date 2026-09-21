# 资料库布局交互对齐 PRD 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 PRD 重排资料库布局——目录树（标题/搜索入口/最近+我的资料快捷入口）、主区（全部|收藏 Tab + 动态标题 + 四列列表 + ♥/NEW）、居中搜索命令面板（键盘全程驱动）；新增 favorite/lastViewedAt 字段（DB v14）。

**Architecture:** 渐进改造：保留 `LibraryView` 组件骨架与既有防御性细节（拖拽入库/重名计数），主区「搜索态」删除收敛为「列表/详情」两态；搜索移入新建的命令面板组件（仿 `GlobalSearchDialog`）；位置列由后端 `buildBreadcrumbChain` 逐项拼装。

**Tech Stack:** Electron 44 IPC（handleUser + channel 白名单）、Prisma 7 + SQLite 迁移脚本（v14）、React 19 + React Query、Vitest（内存表 mock prisma 模式 / jsdom 组件测试）。

**Spec:** `docs/superpowers/specs/2026-09-21-library-layout-design.md`

## Global Constraints

- 所有用户可见文本必须走 `t()`（i18n），zh-CN 与 en-US 的 `chat.json` **同步**新增键；禁止硬编码文案。
- 主题色只用 CSS 变量类（`bg-primary-subtle` / `text-primary` / `border-border/50` 等），禁止 `bg-blue-*` 等硬编码色。
- 弹出层统一 `border border-border/50 rounded-lg shadow-lg`。
- DB 迁移：`electron/Constants.ts` 的 `DATABASE_VERSION` 13 → 14；新脚本目录 `electron/infrastructure/script/v14/`（含 `upgrade-table.sql` 与 `upgrade-data.sql` 两个文件，参照 v13 格式：首行 `-- /electron/infrastructure/script/v14/upgrade-*.sql` 注释）。
- IPC 两处同步：handler 挂 `library.repo.ts` 的 `registerHandlers()`（`handleUser(channel, (_, userId, ...) => ...)` 签名），channel 加白名单 `electron/commons/ipc-channels.ts` 的 `// 资料库` 段。
- 变量 camelCase、文件名 kebab-case、Prettier 双引号分号 printWidth 80。
- 测试命令：`npm run test`（vitest run）；类型检查 `npm run typecheck`；lint `npm run lint`。
- 每个 Task 结束必须 `npm run typecheck` 通过并 commit。

---

### Task 1: DB v14 迁移——libraryItem 新增 favorite / lastViewedAt

**Files:**
- Modify: `prisma/schema.prisma:338-354`（libraryItem model）
- Create: `electron/infrastructure/script/v14/upgrade-table.sql`
- Create: `electron/infrastructure/script/v14/upgrade-data.sql`
- Modify: `electron/Constants.ts:11`（DATABASE_VERSION）

**Interfaces:**
- Produces: DB 列 `libraryItem.favorite BOOLEAN NOT NULL DEFAULT 0`、`libraryItem."lastViewedAt" DATETIME`（NULL）；Prisma client 字段 `favorite: boolean`、`lastViewedAt: Date | null`——Task 2 的 repo 方法与 LibraryRowInput 依赖。

- [ ] **Step 1: schema.prisma 加字段**

在 `model libraryItem` 的 `originalPath String?` 行后、`userId Int?` 行前插入（对齐现有对齐风格）：

```prisma
  favorite     Boolean  @default(false)
  lastViewedAt DateTime?
```

- [ ] **Step 2: 写 v14 迁移脚本**

`electron/infrastructure/script/v14/upgrade-table.sql`（SQLite 的 ALTER ADD COLUMN 不能加非默认值的 NOT NULL；lastViewedAt 含大写须引号）：

```sql
-- /electron/infrastructure/script/v14/upgrade-table.sql
--/p 资料库收藏与最近访问（布局交互 PRD）：favorite（收藏 Tab 与 ♥ 切换）、lastViewedAt（「最近」入口排序 / NEW 判定 / 命令面板最近浏览，folder 恒 NULL）
--/ignore
ALTER TABLE libraryItem ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE libraryItem ADD COLUMN "lastViewedAt" DATETIME;
```

`electron/infrastructure/script/v14/upgrade-data.sql`：

```sql
-- /electron/infrastructure/script/v14/upgrade-data.sql
-- v14 仅新增列（favorite 默认 false / lastViewedAt 默认 NULL），无存量数据迁移
```

> 注意：先读 `electron/infrastructure/script/v13/` 两个文件核对 `--/p`、`--/ignore` 标记的确切用法，照抄格式。

- [ ] **Step 3: 升版本号并重新生成 client**

`electron/Constants.ts:11`：`static readonly DATABASE_VERSION: number = 13;` → `14`。

Run: `npx prisma generate`（项目文档 guide.md 确认的流程，输出到 `electron/generated/prisma`）

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: PASS（schema 扩列不破坏现有类型；generated client 已含新字段）

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma electron/infrastructure/script/v14 electron/Constants.ts
git commit -m "feat(资料库): libraryItem v14 迁移——favorite/lastViewedAt 两列"
```

---

### Task 2: 后端四方法 + 位置链 + channel 白名单

**Files:**
- Modify: `electron/domains/ai/library/library.utils.ts`（+`locationChainOf`）
- Modify: `electron/domains/ai/library/library.repo.ts`（+4 方法、出口拼 location、白名单）
- Modify: `electron/commons/ipc-channels.ts:104-114`（`// 资料库` 段加 4 channel）
- Modify: `src-react/domains/ai/library/api/library.api.ts`（LibraryItem 契约 +3 字段；此文件被 repo 反向 import，属本任务的前端契约面）
- Test: `tests/ai/library-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 Prisma 字段 `favorite` / `lastViewedAt`；现有 `buildBreadcrumbChain(rows, leafId)`（library.utils.ts，链含 leaf、`ItemRow[]` 返回）、`toClientItem(row, libraryRoot)`、`mustGet(id, userId)`。
- Produces:
  - `locationChainOf(folderRows: readonly ItemRow[], parentId: number | null): string[]`
  - repo 方法：`toggleFavorite(id: number, userId: number): Promise<LibraryItem>`、`markViewed(id: number, userId: number): Promise<LibraryItem>`、`listRecent(userId: number): Promise<LibraryItem[]>`、`listFavorites(userId: number): Promise<LibraryItem[]>`
  - IPC channel：`library:toggleFavorite` / `library:markViewed` / `library:listRecent` / `library:listFavorites`
  - `LibraryItem` 新字段：`favorite: boolean`、`lastViewedAt: string | null`、`location: string[]`（祖代 folder 名，根→父序；根层为 `[]`；单条出口 createFolder/rename 等返回 `location: []`，前端不消费）

- [ ] **Step 1: 写失败测试（内存表 mock 扩展 + 新用例）**

`tests/ai/library-repo.test.ts`：先读全文核对 mock 骨架。在 `vi.mock("../../electron/commons/prisma-client")` 的 findMany 实现里，把等值匹配替换为支持 `{ not: null }` 谓词（其余 where 键仍等值）：

```ts
findMany: vi.fn(
  async ({ where }: { where?: Record<string, unknown> } = {}) =>
    table.filter((row) =>
      Object.entries(where ?? {}).every(([key, value]) => {
        if (
          value !== null &&
          typeof value === "object" &&
          "not" in (value as Record<string, unknown>)
        ) {
          return row[key] !== (value as { not: unknown }).not;
        }
        return row[key] === value;
      }),
    ),
),
```

> mock 的 `update` / `create` 若不支持 `data` 透传新字段，同样按现有骨架补齐（读文件后对齐）。内存表行插入时补 `favorite: false, lastViewedAt: null` 默认值。

追加用例（describe 块命名与文件现有风格一致）：

```ts
describe("收藏 / 最近访问 / 位置链", () => {
  beforeEach(() => {
    table.length = 0;
    nextId = 1;
  });

  it("toggleFavorite 切换并返回最新项", async () => {
    const repo = new LibraryRepository();
    const file = await repo.addFiles(["/tmp/a.txt"], null, 1);
    const on = await repo.toggleFavorite(file.added[0].id, 1);
    expect(on.favorite).toBe(true);
    const off = await repo.toggleFavorite(file.added[0].id, 1);
    expect(off.favorite).toBe(false);
  });

  it("markViewed 置 lastViewedAt（ISO 字符串）", async () => {
    const repo = new LibraryRepository();
    const file = await repo.addFiles(["/tmp/a.txt"], null, 1);
    const viewed = await repo.markViewed(file.added[0].id, 1);
    expect(typeof viewed.lastViewedAt).toBe("string");
    expect(new Date(viewed.lastViewedAt).getTime()).toBeGreaterThan(0);
  });

  it("listRecent 仅已访问 file，按 lastViewedAt 倒序", async () => {
    const repo = new LibraryRepository();
    const folder = await repo.createFolder("F", null, 1);
    const a = await repo.addFiles(["/tmp/a.txt"], null, 1);
    const b = await repo.addFiles(["/tmp/b.txt"], folder.id, 1);
    await repo.markViewed(a.added[0].id, 1);
    await new Promise((r) => setTimeout(r, 5));
    await repo.markViewed(b.added[0].id, 1);
    const recent = await repo.listRecent(1);
    expect(recent.map((i) => i.name)).toEqual(["b.txt", "a.txt"]);
    expect(recent.every((i) => i.kind === "file")).toBe(true);
  });

  it("listFavorites 仅收藏 file", async () => {
    const repo = new LibraryRepository();
    const a = await repo.addFiles(["/tmp/a.txt"], null, 1);
    await repo.createFolder("F", null, 1);
    await repo.toggleFavorite(a.added[0].id, 1);
    const favorites = await repo.listFavorites(1);
    expect(favorites).toHaveLength(1);
    expect(favorites[0].name).toBe("a.txt");
  });

  it("search 项含 location 祖代名序列（根→父）", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("F1", null, 1);
    const f2 = await repo.createFolder("F2", f1.id, 1);
    await repo.addFiles(["/tmp/a.txt"], f2.id, 1);
    const results = await repo.search("a", 1);
    expect(results[0].location).toEqual(["F1", "F2"]);
    // 根层文件 location 为空数组
    await repo.addFiles(["/tmp/b.txt"], null, 1);
    const rootResults = await repo.search("b", 1);
    expect(rootResults[0].location).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/library-repo.test.ts`
Expected: FAIL——`repo.toggleFavorite is not a function` / `location` undefined

- [ ] **Step 3: utils 加 locationChainOf**

`electron/domains/ai/library/library.utils.ts` 的 `buildBreadcrumbChain` 之后：

```ts
/** 项的位置链：祖代 folder 名序列（根→父；file 的 parent 必为 folder，
 *  根层/孤儿返回 []）——「位置」列与命令面板路径显示共用 */
export function locationChainOf(
  folderRows: readonly ItemRow[],
  parentId: number | null,
): string[] {
  if (parentId === null) {
    return [];
  }
  return buildBreadcrumbChain(folderRows, parentId).map((row) => row.name);
}
```

- [ ] **Step 4: 前端契约扩字段**

`src-react/domains/ai/library/api/library.api.ts` 的 `LibraryItem` 接口，`originalPath` 行后加：

```ts
  favorite: boolean;
  lastViewedAt: string | null;
  /** 祖代文件夹名（根→父）；根层为 []；单条出口（create/rename 等）恒 [] */
  location: string[];
```

并在 `LibraryApi` 对象追加（invoke 签名与现有一致）：

```ts
  toggleFavorite: (id: number) =>
    invoke<LibraryItem>("library:toggleFavorite", id),
  markViewed: (id: number) => invoke<LibraryItem>("library:markViewed", id),
  listRecent: () => invoke<LibraryItem[]>("library:listRecent"),
  listFavorites: () => invoke<LibraryItem[]>("library:listFavorites"),
```

- [ ] **Step 5: repo 实现**

`library.repo.ts`：

5a. import 补 `locationChainOf`（utils import 列表）。

5b. `LibraryRowInput` 类型加两行（`size?: number | null;` 之后）：

```ts
  favorite?: boolean;
  lastViewedAt?: Date | null;
```

5c. `toClientItem` 返回对象补三字段（`storagePath` 之前）：

```ts
    favorite: row.favorite ?? false,
    lastViewedAt:
      row.lastViewedAt instanceof Date
        ? row.lastViewedAt.toISOString()
        : row.lastViewedAt ?? null,
    location: [],
```

5d. 类内加位置拼装与四方法（`list` 方法之前插入；`withLocation` 全量 folder 行——个人库量级小，list 的面包屑全量拉取同口径）：

```ts
  /** 出口统一拼位置链：rows → LibraryItem[]（含 location） */
  private async withLocation(
    rows: Array<{
      id: number;
      parentId: number | null;
      favorite: boolean;
      lastViewedAt: Date | null;
    }>,
    userId: number,
  ): Promise<LibraryItem[]> {
    const folderRows = await this.prismaClient.libraryItem.findMany({
      where: { kind: "folder", userId },
    });
    const chain = folderRows.map((row) => ({
      ...row,
      kind: row.kind as "folder" | "file",
    }));
    return rows.map((row) => ({
      ...toClientItem(row, this.libraryRoot),
      location: locationChainOf(chain, row.parentId ?? null),
    }));
  }

  /** 收藏切换（file 专属语义，folder 不显示入口；DB 不设限） */
  async toggleFavorite(id: number, userId: number): Promise<LibraryItem> {
    const row = await this.mustGet(id, userId);
    const updated = await this.prismaClient.libraryItem.update({
      where: { id: row.id },
      data: { favorite: !row.favorite },
    });
    return toClientItem(updated, this.libraryRoot);
  }

  /** 预览/打开打点：置 lastViewedAt（NEW 标记随之消失；幂等） */
  async markViewed(id: number, userId: number): Promise<LibraryItem> {
    await this.mustGet(id, userId);
    const updated = await this.prismaClient.libraryItem.update({
      where: { id },
      data: { lastViewedAt: new Date() },
    });
    return toClientItem(updated, this.libraryRoot);
  }

  /** 最近访问：file 且已看过，lastViewedAt 倒序限 50（JS 排序——
   *  个人库量级小，与 list 的 compareLibraryItems 同口径） */
  async listRecent(userId: number): Promise<LibraryItem[]> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { kind: "file", lastViewedAt: { not: null }, userId },
    });
    const sorted = rows
      .sort(
        (a, b) =>
          (b.lastViewedAt?.getTime() ?? 0) -
          (a.lastViewedAt?.getTime() ?? 0),
      )
      .slice(0, 50);
    return this.withLocation(sorted, userId);
  }

  /** 全局收藏：favorite 的 file，updatedAt 倒序 */
  async listFavorites(userId: number): Promise<LibraryItem[]> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { kind: "file", favorite: true, userId },
    });
    const sorted = rows.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    return this.withLocation(sorted, userId);
  }
```

5e. `list` 与 `search` 的出口改走位置拼装——`list` 中 `const items = rows.map(...).sort(...)` 改为：

```ts
    const items = (
      await this.withLocation(
        rows.sort(compareLibraryItems),
        userId,
      )
    );
```

（`compareLibraryItems` 若需 DB 行结构，确认其签名后排序位置放 withLocation 之前于 rows 上进行。）`search` 的 `return rows.map(...)` 改为 `return this.withLocation(rows, userId);`。

> 注意：`compareLibraryItems` / `mustGet` 的确切签名以文件现文为准，读后适配。

5f. `registerHandlers()` 的 `handleUser("library:tree", ...)` 之后追加：

```ts
    handleUser("library:toggleFavorite", (_, userId, id: number) =>
      this.toggleFavorite(id, userId),
    );
    handleUser("library:markViewed", (_, userId, id: number) =>
      this.markViewed(id, userId),
    );
    handleUser("library:listRecent", (_, userId) => this.listRecent(userId));
    handleUser("library:listFavorites", (_, userId) =>
      this.listFavorites(userId),
    );
```

- [ ] **Step 6: channel 白名单**

`electron/commons/ipc-channels.ts` 的 `// 资料库` 段、`"library:tree",` 之后：

```ts
  "library:toggleFavorite",
  "library:markViewed",
  "library:listRecent",
  "library:listFavorites",
```

- [ ] **Step 7: 跑测试与类型检查**

Run: `npm run test -- tests/ai/library-repo.test.ts && npm run typecheck`
Expected: 全 PASS（现有 library-*.test.ts 若因契约新字段失败——如快照/字面量构造 LibraryItem——按最小改动补默认值修复）

- [ ] **Step 8: Commit**

```bash
git add electron/domains/ai/library src-react/domains/ai/library/api/library.api.ts electron/commons/ipc-channels.ts tests/ai/library-repo.test.ts
git commit -m "feat(资料库): 后端收藏/最近访问四方法+列表逐项位置链（buildBreadcrumbChain 复用）"
```

---

### Task 3: 前端纯函数——NEW 判定/活动时间/位置格式化/双向排序

**Files:**
- Modify: `src-react/domains/ai/library/lib/library-view-model.ts`
- Test: `tests/ai/library-view-model.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LibraryItem.favorite/lastViewedAt/location`。
- Produces（Task 4/5/6 依赖）:
  - `isNewItem(item: Pick<LibraryItem, "kind" | "lastViewedAt">): boolean`
  - `activityTimeOf(item: Pick<LibraryItem, "lastViewedAt" | "createdAt">): string`
  - `formatLocation(location: string[], rootLabel: string): string`（rootLabel 由调用方传 `t("chat:library.mine")`，模块不耦合 i18n）
  - `SortField` 改为 `"name" | "activity"`（删除 `"updatedAt"`——排序按钮移列头后无消费方）

- [ ] **Step 1: 写失败测试**

`tests/ai/library-view-model.test.ts` 追加（先读文件核对现有 describe 风格）：

```ts
describe("isNewItem", () => {
  it("file 且从未访问 → true；访问过或 folder → false", () => {
    expect(
      isNewItem({ kind: "file", lastViewedAt: null }),
    ).toBe(true);
    expect(
      isNewItem({ kind: "file", lastViewedAt: "2026-01-01T00:00:00Z" }),
    ).toBe(false);
    expect(isNewItem({ kind: "folder", lastViewedAt: null })).toBe(false);
  });
});

describe("activityTimeOf", () => {
  it("lastViewedAt 优先，缺省回落 createdAt", () => {
    expect(
      activityTimeOf({
        lastViewedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe("2026-02-01T00:00:00Z");
    expect(
      activityTimeOf({ lastViewedAt: null, createdAt: "2026-01-01T00:00:00Z" }),
    ).toBe("2026-01-01T00:00:00Z");
  });
});

describe("formatLocation", () => {
  it("空链显示根名；非空以「 / 」连接（根名不打头）", () => {
    expect(formatLocation([], "我的资料")).toBe("我的资料");
    expect(formatLocation(["F1", "F2"], "我的资料")).toBe("F1 / F2");
  });
});

describe("sortItems activity", () => {
  it("folder 恒置前，file 按 activityTimeOf 升降序", () => {
    const items = [
      { kind: "file", name: "a", createdAt: "2026-01-01", lastViewedAt: null },
      { kind: "folder", name: "z", createdAt: "2026-03-01", lastViewedAt: null },
      { kind: "file", name: "b", createdAt: "2026-02-01", lastViewedAt: null },
    ] as LibraryItem[];
    expect(sortItems(items, "activity", "asc").map((i) => i.name)).toEqual([
      "z", "a", "b",
    ]);
    expect(sortItems(items, "activity", "desc").map((i) => i.name)).toEqual([
      "z", "b", "a",
    ]);
  });
});
```

> 文件头 import 补 `isNewItem` / `activityTimeOf` / `formatLocation` 与 `type LibraryItem`（若未引）。`updatedAt` 相关旧用例（若存在 SortField "updatedAt" 用例）同步改为 "activity" 或删除。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tests/ai/library-view-model.test.ts`
Expected: FAIL——三个函数未定义

- [ ] **Step 3: 实现**

`library-view-model.ts`：

```ts
export type SortField = "name" | "activity";
```

`sortItems` 的字段比较分支改为：

```ts
    if (field === "name") {
      return a.name.localeCompare(b.name) * factor;
    }
    return activityTimeOf(a).localeCompare(activityTimeOf(b)) * factor;
```

文件末尾（`buildFolderTree` 之后）追加：

```ts
/** NEW 判定（spec §3）：file 且从未预览过（lastViewedAt 为 null）；
 *  rename/move 触碰 updatedAt 不影响判定 */
export function isNewItem(
  item: Pick<LibraryItem, "kind" | "lastViewedAt">,
): boolean {
  return item.kind === "file" && item.lastViewedAt === null;
}

/** 「最近访问」列与排序的显示值：lastViewedAt ?? createdAt */
export function activityTimeOf(
  item: Pick<LibraryItem, "lastViewedAt" | "createdAt">,
): string {
  return item.lastViewedAt ?? item.createdAt;
}

/** 位置列显示：空链（根层）显示根名；非空「名 / 名」连接（不打根名前缀） */
export function formatLocation(location: string[], rootLabel: string): string {
  return location.length === 0 ? rootLabel : location.join(" / ");
}
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `npm run test -- tests/ai/library-view-model.test.ts && npm run typecheck`
Expected: typecheck 会暴露 `LibraryView.tsx` 现有 `sortField` state 用 `"updatedAt"` 初始化的类型错误——**本任务顺手把 `LibraryView.tsx:56` 的 `useState<SortField>("updatedAt")` 改为 `useState<SortField>("activity")`、`:280-288` 工具栏按钮的 `"updatedAt"` 分支改为 `"activity"`**（文案逻辑不变，Task 5 再删该按钮）。全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/library/lib/library-view-model.ts src-react/domains/ai/library/views/LibraryView.tsx tests/ai/library-view-model.test.ts
git commit -m "feat(资料库): NEW 判定/活动时间/位置格式化纯函数+排序改 activity 字段"
```

---

### Task 4: 列表换四列——名称(♥/NEW/彩色图标)/类型/位置/最近访问 + 列头排序

**Files:**
- Modify: `src-react/domains/ai/library/components/LibraryFileList.tsx`（全文重写列结构）
- Modify: `src-react/domains/ai/library/views/LibraryView.tsx`（最小接线：sortAsc state、toggleFavorite/markViewed 调用、传参）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`（library 节）

**Interfaces:**
- Consumes: Task 2 的 `LibraryItem.location/favorite/lastViewedAt`、Task 3 的 `isNewItem/activityTimeOf/formatLocation/SortField`。
- Produces: `LibraryFileListProps` 新签名（Task 5/6 的 View 接线沿用）：

```ts
interface LibraryFileListProps {
  items: LibraryItem[];
  loading: boolean;
  sortField: SortField;
  sortAsc: boolean;
  onToggleSort: (field: SortField) => void;
  onToggleFavorite: (item: LibraryItem) => void;
  onOpen: (item: LibraryItem) => void;
  onPreview: (item: LibraryItem) => void;
  onRename: (item: LibraryItem) => void;
  onMove: (item: LibraryItem) => void;
  onReveal: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
}
```

- [ ] **Step 1: i18n 键**

zh-CN/chat.json 的 `library` 节加（en-US 同步加英文，键序一致）：

```json
  "colLocation": "位置",
  "colLastViewed": "最近访问",
  "newBadge": "NEW",
  "favoriteAction": "收藏",
  "unfavoriteAction": "取消收藏",
  "sortAsc": "升序",
  "sortDesc": "降序"
```

en-US：`"Location"`、`"Last viewed"`、`"NEW"`、`"Favorite"`、`"Unfavorite"`、`"Ascending"`、`"Descending"`。

- [ ] **Step 2: 重写 LibraryFileList**

保留文件头注释（更新为四列描述）与 `TYPE_LABEL_KEY` 导出（View 引用）。类型图标彩色化按 fileType 映射主题内安全色（`text-primary`/`text-muted-foreground` 等 CSS 变量类；不引入硬编码色——青/紫用 `text-teal-*` 属于 Tailwind 内置色板，主题切换不跟随，**不采用**，统一 `text-primary` file / folder 现有口径）。列结构：

```tsx
const GRID =
  "grid grid-cols-[minmax(0,1.6fr)_110px_minmax(0,1fr)_150px_40px] items-center gap-2";

// 表头（列头排序：name / activity 可点，其余静态）
<div className={`${GRID} border-b border-border/50 bg-primary-subtle/40 px-3 py-2 text-xs font-medium text-muted-foreground`}>
  <button type="button" className="flex items-center gap-1 text-left hover:text-primary" onClick={() => onToggleSort("name")}>
    <span>{t("chat:library.colName")}</span>
    {sortField === "name" && <span aria-label={sortAsc ? t("chat:library.sortAsc") : t("chat:library.sortDesc")}>{sortAsc ? "↑" : "↓"}</span>}
  </button>
  <span>{t("chat:library.colType")}</span>
  <span>{t("chat:library.colLocation")}</span>
  <button type="button" className="flex items-center gap-1 text-left hover:text-primary" onClick={() => onToggleSort("activity")}>
    <span>{t("chat:library.colLastViewed")}</span>
    {sortField === "activity" && <span aria-label={sortAsc ? t("chat:library.sortAsc") : t("chat:library.sortDesc")}>{sortAsc ? "↑" : "↓"}</span>}
  </button>
  <span />
</div>
```

行主体（名称列内）：folder 行保持现状（Folder 图标 + 名 + ChevronRight）；file 行为：

```tsx
<button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => onPreview(item)}>
  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
  {item.kind === "file" && (
    <button
      type="button"
      aria-label={item.favorite ? t("chat:library.unfavoriteAction") : t("chat:library.favoriteAction")}
      onClick={(e) => { e.stopPropagation(); onToggleFavorite(item); }}
      className="shrink-0 rounded p-0.5 hover:bg-primary-subtle"
    >
      <Heart
        className={`h-3.5 w-3.5 ${item.favorite ? "fill-red-500 text-red-500" : "text-muted-foreground"}`}
      />
    </button>
  )}
  <span className="truncate" title={item.name}>{item.name}</span>
  {isNewItem(item) && (
    <span className="shrink-0 rounded-sm bg-red-500/10 px-1 py-0.5 text-[10px] font-semibold text-red-500">
      {t("chat:library.newBadge")}
    </span>
  )}
</button>
```

> ♥ 与 NEW 的红色：语义色（收藏/新）非主题色，`red-500` 合规（参照项目 destructive 语义用法；若 grep 到现有红色用法口径不同则对齐之）。**注意**：♥ 是嵌套 button——HTML 不允许 button 嵌套，名称列的容器改 `<div className="flex min-w-0 items-center gap-2">`，文件名部分单独 `<button onClick={onPreview}>`（♥ 按钮与名按钮平级），folder 行同理拆分。

类型/位置/时间三列：

```tsx
<span className="truncate text-muted-foreground">
  {item.kind === "folder" ? "—" : t(TYPE_LABEL_KEY[item.fileType ?? "other"] ?? "chat:library.typeOther")}
</span>
<span className="truncate text-muted-foreground" title={formatLocation(item.location, t("chat:library.mine"))}>
  {formatLocation(item.location, t("chat:library.mine"))}
</span>
<span className="truncate text-muted-foreground">
  {new Date(activityTimeOf(item)).toLocaleDateString()}
</span>
```

空态分支加 `recentEmpty` 区分由 props 外处理（Task 5 的 View 按 queryKey 判断，本任务先保留现有 `empty`）。`…` 操作菜单整块原样保留。import 增 `Heart`、`isNewItem`、`activityTimeOf`、`formatLocation`、`type SortField`。

- [ ] **Step 3: View 最小接线**

`LibraryView.tsx`：

- `const [sortAsc, setSortAsc] = useState(true);`
- `sortItems(filterByType(rawItems, typeFilter), sortField, sortAsc ? "asc" : "desc")`（替换现有硬编码 `"desc"`）。
- 切换回调：

```ts
const handleToggleSort = (field: SortField) => {
  if (field === sortField) {
    setSortAsc((v) => !v);
  } else {
    setSortField(field);
    setSortAsc(field === "name");
  }
};
```

- 收藏切换（对齐现有直调 + invalidate 风格）：

```ts
const handleToggleFavorite = async (item: LibraryItem) => {
  try {
    await LibraryApi.toggleFavorite(item.id);
    await invalidate();
  } catch (e) {
    toast.error(mapIpcError(e));
  }
};
```

- 预览打点：`setDetailItem(item)` 的三处调用点（列表 onPreview 回调与详情态入口）收敛为一个 `openDetail`：

```ts
const openDetail = (item: LibraryItem) => {
  setDetailItem(item);
  if (item.kind === "file") {
    void LibraryApi.markViewed(item.id)
      .then(() => invalidate())
      .catch(() => undefined); // 打点失败不阻断预览
  }
};
```

（`invalidate` 现有实现会重拉 `libraryItems`/`librarySearch`/`libraryTree`——Task 5 再补 `libraryRecent`/`libraryFavorites` key。）
- 工具栏排序按钮（`:275-288`）**删除**（职责已移列头）；`LibraryFileList` 调用处传齐新 props。
- `markViewed` 后 NEW 消失依赖 invalidate 重拉——确认 `rawItems` 来自 query 缓存即满足。

- [ ] **Step 4: 验证**

Run: `npm run test && npm run typecheck`
Expected: 全 PASS（`library-sidebar-collapse.test.tsx` 渲染 LibraryView 全链路——若因按钮删除挂掉，将测试里定位排序按钮的断言/交互删去，保留收起/展开主链路）。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/library src-react/i18n/locales
git commit -m "feat(资料库): 列表换四列——♥收藏/NEW/位置/最近访问+列头排序，预览打点 markViewed"
```

---

### Task 5: 视图骨架——目录树重排 + 最近/我的资料入口 + 全部|收藏 Tab + 动态标题

**Files:**
- Modify: `src-react/domains/ai/library/components/LibrarySidebarTree.tsx`（重排）
- Modify: `src-react/domains/ai/library/views/LibraryView.tsx`（状态收敛）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`
- Test: `tests/ai/library-sidebar-collapse.test.tsx`（更新）

**Interfaces:**
- Consumes: Task 2/3/4 全部产出。
- Produces（Task 6 依赖）:
  - View 状态：`type LibraryViewRoute = { type: "recent" } | { type: "folder"; id: number | null }`（放 view-model 导出）；`const [view, setView] = useState<LibraryViewRoute>({ type: "recent" })`（默认「最近」）；`const [tab, setTab] = useState<"all" | "favorites">("all")`；`const [commandOpen, setCommandOpen] = useState(false)`（本任务先建 state 与树栏 onOpenSearch 接线，面板组件 Task 6 建——本任务 onOpenSearch 先置空函数 `{/* Task 6 接命令面板 */}` 会违反 No Placeholders，故本任务直接把 commandOpen state 建好，树栏点击 `setCommandOpen(true)`，View 末尾渲染 `<LibraryCommandDialog open={commandOpen} onClose={...} onSelect={...} />` 的**组件文件本任务一并创建为可运行最小实现**？——否，见下方调整）。
  - 树栏 props（新签名，Task 6 只读不改）：

```ts
interface LibrarySidebarTreeProps {
  collapsed: boolean;
  view: LibraryViewRoute;
  onSelectView: (view: LibraryViewRoute) => void;
  onOpenSearch: () => void;
  onCreateFolder: () => void;
  treeCollapsed 的 onToggleCollapse 移除——收起按钮移交主区标题行（本任务实现）
}
```

  > 依赖说明：为保每个任务独立可交付，**本任务同时创建 `LibraryCommandDialog.tsx` 的可用占位**（渲染 null 的 1 行组件 + props 类型定义，Task 6 替换为实现）——这不算计划占位符，是分任务交付的最小可用实现。

- [ ] **Step 1: i18n 键**

zh-CN（en-US 对应 `Recent` / `All` / `Favorites` / `No files viewed yet — open a file to see it here` / `Search library`）：

```json
  "recentEntry": "最近",
  "tabAll": "全部",
  "tabFavorites": "收藏",
  "recentEmpty": "还没有访问过的文件，先打开一个文件试试"
```

- [ ] **Step 2: view-model 导出路由类型**

`library-view-model.ts` 末尾：

```ts
/** 资料库主区视图路由（spec §5）：「最近」快捷入口 or 文件夹层（null=根） */
export type LibraryViewRoute =
  | { type: "recent" }
  | { type: "folder"; id: number | null };
```

- [ ] **Step 3: 创建 LibraryCommandDialog 占位组件**

`src-react/domains/ai/library/components/LibraryCommandDialog.tsx`：

```tsx
/**
 * 资料库搜索命令面板（spec §4）：居中浮层、键盘全程驱动
 * （↑↓ 切换 / Enter 打开 / Esc 关闭）、空输入显示最近浏览。
 * 占位实现：Task 6 替换为完整实现（props 契约先行）。
 */
import type { LibraryItem } from "../api/library.api";

export interface LibraryCommandDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: LibraryItem) => void;
}

export default function LibraryCommandDialog({
  open,
}: LibraryCommandDialogProps) {
  return open ? null : null;
}
```

- [ ] **Step 4: 重排 LibrarySidebarTree**

新结构（展开态，自上而下；折叠窄条**原样保留**含置顶展开按钮——但 `onToggleCollapse` prop 删除后窄条展开按钮改调 `onExpand`？——窄条展开按钮需要通知外部展开。收起/展开按钮统一移交主区后，窄条自身仍有展开按钮（0eccb50 修复），故 props 保留 `onToggleCollapse`，仅展开态顶部行的收起按钮删除）：

```tsx
interface LibrarySidebarTreeProps {
  collapsed: boolean;
  onToggleCollapse: () => void; // 窄条展开按钮 + 主区标题行共用
  view: LibraryViewRoute;
  onSelectView: (view: LibraryViewRoute) => void;
  onOpenSearch: () => void;
  onCreateFolder: () => void;
}
```

展开态 JSX 骨架：

```tsx
<aside data-testid="library-sidebar" className="flex w-56 shrink-0 flex-col border-r border-border/50">
  {/* 标题行（spec §2.1）：大号标题，砍分享/导出 */}
  <div className="px-3 pb-1 pt-3">
    <h2 className="text-base font-semibold">{t("chat:library.title")}</h2>
  </div>
  {/* 搜索框：点击唤起命令面板（非输入框） */}
  <div className="px-2 pb-2">
    <button
      type="button"
      onClick={onOpenSearch}
      className="flex w-full items-center gap-2 rounded-md border border-border/50 px-2 py-1.5 text-sm text-muted-foreground hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
    >
      <Search className="h-3.5 w-3.5" />
      <span>{t("chat:library.commandPlaceholder")}</span>
    </button>
  </div>
  {/* 快捷入口：最近 / 我的资料（后者带「+」新建） */}
  <div className="space-y-0.5 px-1.5">
    <button type="button" onClick={() => onSelectView({ type: "recent" })}
      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm ${view.type === "recent" ? "bg-primary-subtle text-primary" : "text-foreground hover:bg-primary-subtle hover:text-primary"}`}>
      <Clock className="h-4 w-4 shrink-0" />
      <span className="truncate">{t("chat:library.recentEntry")}</span>
    </button>
    <div className={`flex items-center rounded-md text-sm ${view.type === "folder" ? "bg-primary-subtle text-primary" : "text-foreground hover:bg-primary-subtle hover:text-primary"}`}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
        onClick={() => onSelectView({ type: "folder", id: null })}>
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="truncate">{t("chat:library.mine")}</span>
      </button>
      <button type="button" aria-label={t("chat:library.newFolder")} title={t("chat:library.newFolder")}
        className="mr-1 shrink-0 rounded p-1 hover:text-primary" onClick={onCreateFolder}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
  {/* 文件夹树：根的子层（根行即上方「我的资料」） */}
  <div className="flex-1 overflow-y-auto p-1.5">
    {nodes.map((node) => (
      <TreeNodeRow key={node.id} node={node} depth={1} expanded={expanded}
        selectedFolderId={view.type === "folder" ? view.id : undefined}
        onToggleExpand={toggleExpand} onSelectFolder={(id) => onSelectView({ type: "folder", id })} />
    ))}
  </div>
</aside>
```

`TreeNodeRow` 的 `folderId` prop 改 `selectedFolderId: number | undefined`（recent 态无选中）；祖先链自动展开 effect 的 `folderId` 改 `view.type === "folder" ? view.id : null`。删除：`searchOpen` state、内嵌 Input 搜索、`keyword`/`onKeywordChange`/`onBackToList`/`backEnabled` props、顶部按钮行的收起按钮（窄条仍保留 `onToggleCollapse`）。import 增 `Clock`、`Plus`，删 `Input`、`ListTree`、`PanelLeftClose`（窄条用 `PanelLeftOpen` 保留）、`X`。

- [ ] **Step 5: LibraryView 状态收敛**

`LibraryView.tsx`：

- `folderId` state 替换为 `view` + `tab` + `commandOpen`（见 Interfaces）。
- 数据源（Tab 优先于视图）：

```ts
const listQuery = useQuery({
  queryKey:
    tab === "favorites"
      ? ["libraryFavorites"]
      : view.type === "recent"
        ? ["libraryRecent"]
        : ["libraryItems", view.id],
  queryFn: () =>
    tab === "favorites"
      ? LibraryApi.listFavorites()
      : view.type === "recent"
        ? LibraryApi.listRecent()
        : LibraryApi.list(view.id ?? undefined),
});
```

- 删除：`keyword`/`searching`/`searchQuery` 及搜索态分支；`invalidate()` 补两个 key：

```ts
await queryClient.invalidateQueries({ queryKey: ["libraryRecent"] });
await queryClient.invalidateQueries({ queryKey: ["libraryFavorites"] });
```

- `viewMode` 简化为 `detailItem ? "detail" : "list"`。
- 空态区分：`items.length === 0` 时列表组件外层（或 FileList 的 empty 分支传 prop）——给 `LibraryFileList` 加可选 prop `emptyText?: string`，View 在 `view.type === "recent" && tab === "all"` 时传 `t("chat:library.recentEmpty")`（默认仍 `t("chat:library.empty")`）。
- 动态标题（folder 名取自 treeQuery）：

```ts
const treeRows = treeQueryForName?.data ?? []; // 复用 libraryTree query（本文件新增 useQuery(["libraryTree"], LibraryApi.tree)）
const folderName = (id: number) => treeRows.find((r) => r.id === id)?.name;
const pageTitle =
  tab === "favorites"
    ? t("chat:library.tabFavorites")
    : view.type === "recent"
      ? t("chat:library.recentEntry")
      : (view.type === "folder" && view.id !== null
          ? folderName(view.id)
          : undefined) ?? t("chat:library.mine");
```

- 标题行左側加侧栏切换按钮（`PageTitle` 的 `children` 槽——`PageTitle` 结构是 `justify-between` 的 flex，把切换按钮放 children 左侧需包一层；直接在 `PageTitle` 上方/内部插 `<div className="flex items-center gap-2">` 传 children）：

```tsx
<PageTitle title={pageTitle}>
  <div className="flex items-center gap-1">
    <button type="button" title={t("chat:library.collapseSidebar")} aria-label={t("chat:library.collapseSidebar")}
      className="rounded-md p-1 hover:bg-primary-foreground/20" onClick={() => setTreeCollapsed(true)}>
      <PanelLeftClose className="h-4 w-4" />
    </button>
  </div>
</PageTitle>
```

（`treeCollapsed` state 保留；窄条的 `onToggleCollapse={() => setTreeCollapsed(false)}`。）

- Tab 胶囊组（工具栏行左側，工具栏只剩上传按钮在右）：

```tsx
<div className="inline-flex items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-sm">
  {(["all", "favorites"] as const).map((key) => (
    <button key={key} type="button"
      className={`rounded-md px-3 py-1 ${tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-primary"}`}
      onClick={() => setTab(key)}>
      {t(key === "all" ? "chat:library.tabAll" : "chat:library.tabFavorites")}
    </button>
  ))}
</div>
```

- 工具栏：删 `FolderPlus` 新建按钮（移树栏「+」）与 `Select` 排序相关残留，保留类型 Select 与上传 Button；`onCreateFolder` 接树栏 → `setDialog({ mode: "createFolder" })`（注意：现在根行「+」只建根层文件夹，`folderId` 语境消失后 createFolder 的 parent 取 `view.type === "folder" ? view.id : null`）。
- 树栏/命令面板接线：

```tsx
<LibrarySidebarTree
  collapsed={treeCollapsed}
  onToggleCollapse={() => setTreeCollapsed(false)}
  view={view}
  onSelectView={(next) => { setView(next); setTab("all"); setDetailItem(null); }}
  onOpenSearch={() => setCommandOpen(true)}
  onCreateFolder={() => setDialog({ mode: "createFolder" })}
/>
...
<LibraryCommandDialog
  open={commandOpen}
  onClose={() => setCommandOpen(false)}
  onSelect={(item) => {
    setCommandOpen(false);
    openDetail(item);
  }}
/>
```

- `onOpen`（列表点 folder）改 `onSelectView({ type: "folder", id: item.id })` 语义（清 detail）。

- [ ] **Step 6: 更新组件回归测试**

`tests/ai/library-sidebar-collapse.test.tsx`：读全文后按新交互更新——收起按钮现在位于主区标题行（PageTitle children），测试流：渲染 → 点主区收起按钮（按 `title`/`aria-label` 定位 `t` mock 直返的 key `chat:library.collapseSidebar`）→ 断言 `data-testid="library-sidebar-collapsed"` 出现 → 点窄条展开按钮（`chat:library.expandSidebar`）→ 断言 `data-testid="library-sidebar"` 回来。mock 骨架（i18n 直返 key、LibraryApi stub）不变，stub 补 `tree: () => []`、`listRecent: () => []` 等新方法。默认视图「最近」下树栏无选中——断言按需调整。

- [ ] **Step 7: 验证**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add src-react/domains/ai/library tests/ai/library-sidebar-collapse.test.tsx src-react/i18n/locales
git commit -m "feat(资料库): 目录树重排——标题/搜索入口/最近+我的资料快捷项/根行+；主区全部|收藏 Tab+动态标题+视图路由收敛"
```

---

### Task 6: 搜索命令面板完整实现

**Files:**
- Modify: `src-react/domains/ai/library/components/LibraryCommandDialog.tsx`（替换占位）
- Modify: `src-react/domains/ai/library/views/LibraryView.tsx`（⌘K 注册）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`
- Test: `tests/ai/library-command-dialog.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 5 的 `LibraryCommandDialogProps`（签名不变）、`LibraryApi.search/listRecent`（Task 2）、`formatLocation`（Task 3）、View 的 `onSelect` → `openDetail`（Task 4）。
- Produces: 完整命令面板（props 契约与 Task 5 占位完全一致，View 接线零改动除 ⌘K）。

- [ ] **Step 1: i18n 键**

zh-CN（en-US：`Recently viewed` / `No results found` / `Navigate` / `Open` / `Close`；`commandPlaceholder` Task 5 已加 `搜索资料库`/`Search library`）：

```json
  "commandRecent": "最近浏览",
  "commandNoResult": "未找到相关内容",
  "commandHintNavigate": "切换",
  "commandHintOpen": "打开",
  "commandHintClose": "关闭"
```

- [ ] **Step 2: 写失败组件测试**

`tests/ai/library-command-dialog.test.tsx`（mock 骨架照 `library-sidebar-collapse.test.tsx`：i18n 直返 key、`@/lib/ipc` 的 invoke stub 或直接 mock `../api/library.api` default）：

```tsx
// @vitest-environment jsdom
/**
 * 命令面板：空输入显示最近浏览（listRecent）、键盘 ↑↓ 选中、Enter
 * 触发 onSelect、Esc 关闭走 Dialog onOpenChange。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const searchMock = vi.fn(async () => []);
const listRecentMock = vi.fn(async () => [
  { id: 1, name: "a.md", kind: "file", location: [], favorite: false, lastViewedAt: "2026-01-01T00:00:00Z" },
  { id: 2, name: "b.md", kind: "file", location: ["F1"], favorite: false, lastViewedAt: "2026-01-02T00:00:00Z" },
]);
vi.mock("@/domains/ai/library/api/library.api", () => ({
  default: { search: (...a: unknown[]) => searchMock(...a), listRecent: () => listRecentMock() },
}));
// react-i18next 直返 key 的 mock 同 library-sidebar-collapse.test.tsx

import LibraryCommandDialog from "@/domains/ai/library/components/LibraryCommandDialog";

afterEach(cleanup);

describe("LibraryCommandDialog", () => {
  it("空输入显示最近浏览两项", async () => {
    render(<LibraryCommandDialog open onClose={() => {}} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText("b.md")).toBeTruthy());
    expect(screen.getByText("a.md")).toBeTruthy();
  });

  it("ArrowDown 移动选中，Enter 上报选中项", async () => {
    const onSelect = vi.fn();
    render(<LibraryCommandDialog open onClose={() => {}} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("b.md")).toBeTruthy());
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // 0 -> 1
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2 }),
      ),
    );
  });

  it("输入触发 search，无结果显示未找到", async () => {
    searchMock.mockResolvedValueOnce([]);
    render(<LibraryCommandDialog open onClose={() => {}} onSelect={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "zzz" } });
    await waitFor(() =>
      expect(screen.getByText("chat:library.commandNoResult")).toBeTruthy(),
    );
  });
});
```

（i18n mock 直返 key，故断言用 key 文本。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test -- tests/ai/library-command-dialog.test.tsx`
Expected: FAIL——占位组件渲染 null，找不到 `b.md`

- [ ] **Step 4: 实现组件**

```tsx
/**
 * 资料库搜索命令面板（spec §4）：居中浮层，键盘全程驱动——↑↓ 切换
 * 选中、Enter 打开、Esc 关闭（Dialog 内建）；空输入显示最近浏览
 * （listRecent），输入实时检索（search，300ms 防抖）；每项 = 图标 +
 * 加粗名 + 灰色位置。打开后 markViewed 由调用方 onSelect 处理。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import LibraryApi, { type LibraryItem } from "../api/library.api";
import { formatLocation } from "../lib/library-view-model";

export interface LibraryCommandDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: LibraryItem) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export default function LibraryCommandDialog({ open, onClose, onSelect }: LibraryCommandDialogProps) {
  const { t } = useTranslation(["chat"]);
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  const searching = debounced.length > 0;
  const resultsQuery = useQuery({
    queryKey: searching ? ["libraryCommandSearch", debounced] : ["libraryRecent"],
    queryFn: () => (searching ? LibraryApi.search(debounced) : LibraryApi.listRecent()),
    enabled: open,
  });
  const results = useMemo(() => resultsQuery.data ?? [], [resultsQuery.data]);

  useEffect(() => setSelectedIndex(0), [debounced]);

  // 选中项滚入可视区
  useEffect(() => {
    listRef.current
      ?.querySelectorAll("[data-command-item]")
      [selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = results[selectedIndex];
      if (item) {
        e.preventDefault();
        onSelect(item);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="sr-only">{t("chat:library.commandPlaceholder")}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={keyword} onKeyDown={handleKeyDown}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("chat:library.commandPlaceholder")}
            className="bg-primary-subtle/30 pl-8" />
        </div>
        <div ref={listRef} className="max-h-72 overflow-y-auto">
          <p className="px-1 pb-1 text-xs text-muted-foreground">
            {searching ? t("common:search") : t("chat:library.commandRecent")}
          </p>
          {resultsQuery.isPending ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">{t("common:loading")}</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">{t("chat:library.commandNoResult")}</p>
          ) : (
            results.map((item, index) => (
              <button key={item.id} type="button" data-command-item
                className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${index === selectedIndex ? "bg-primary-subtle" : "hover:bg-primary-subtle/60"}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onSelect(item)}>
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatLocation(item.location, t("chat:library.mine"))}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        {/* 底部快捷键操作栏（横线分隔） */}
        <div className="flex items-center gap-4 border-t border-border/50 pt-2 text-xs text-muted-foreground">
          <span>↑ ↓ {t("chat:library.commandHintNavigate")}</span>
          <span>↵ {t("chat:library.commandHintOpen")}</span>
          <span>Esc {t("chat:library.commandHintClose")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

（本任务整文件替换 Task 5 的占位——props 接口在文件内定义并导出，签名与占位完全一致。）

- [ ] **Step 5: View 注册 ⌘K**

`LibraryView.tsx`（组件体顶部）：

```ts
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setCommandOpen(true);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```

（组件挂载即注册——资料库路由独占，卸载自动移除，不与全局冲突。）

- [ ] **Step 6: 跑测试与验证**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/library tests/ai/library-command-dialog.test.tsx src-react/i18n/locales
git commit -m "feat(资料库): 搜索命令面板——键盘全程驱动+最近浏览+300ms 防抖+⌘K 唤起"
```

---

### Task 7: 收尾——废弃键清理 + 全量验证

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`（删废弃键）
- Modify: `src-react/domains/ai/library/views/LibraryView.tsx`（文件头注释更新）

**Interfaces:**
- Consumes: 前 6 个任务的全部产出。

- [ ] **Step 1: 清理废弃 i18n 键**

grep 确认以下键在 `src-react/` 内已无引用（`grep -rn "searchPlaceholder\|searchLabel\|backToList\|colSize\|colAddedAt" src-react/`，注意排除 `LibraryPickerDialog` 等其他消费者）后，从两个 chat.json 的 library 节删除：`searchPlaceholder`、`searchLabel`、`backToList`、`colSize`、`colAddedAt`。**仍有引用的键保留**并在 commit message 注明。

- [ ] **Step 2: 更新 LibraryView 头注释**

文件头 `/** ... */` 重写为收敛后的两态描述（列表/详情 + Tab/类型筛选 + 命令面板），对齐现有注释风格（中文、含 spec 引用）。

- [ ] **Step 3: 全量验证**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 三项全 PASS

- [ ] **Step 4: 手工验证清单（npm run dev）**

- 首次进入资料库 → 默认「最近」视图（空态显示 recentEmpty）
- 上传文件 → 列表 NEW 标记 → 点文件预览 → 返回列表 NEW 消失且「最近」出现该项
- 点 ♥ → 变红 → 切「收藏」Tab → 出现该项
- 树栏点「我的资料」→ 文件夹层列表 → 建子文件夹 → 子层上传 → 「位置」列显示父链
- 点搜索框 / ⌘K → 面板弹出 → 空输入最近浏览 → 输入过滤 → ↑↓ 高亮移动 → Enter 进详情
- 主区标题行收起按钮 → 窄条 → 窄条展开按钮 → 恢复
- 深浅主题各过一遍（主题切换无硬编码色残留）

- [ ] **Step 5: Commit**

```bash
git add src-react
git commit -m "chore(资料库): 布局交互对齐收尾——废弃 i18n 键清理+头注释更新"
```

---

## Self-Review 结论

- **Spec 覆盖**：§1 数据层（Task 1/2）、§2 目录树（Task 5）、§3 主区（Task 4/5）、§4 命令面板（Task 6）、§5 状态收敛（Task 5）、§6 边界（Task 4 recentEmpty/Task 6 无结果）、§7 文件清单与 i18n（各任务+Task 7）——全覆盖。
- **占位符**：Task 5 Step 3 的"占位组件"是分任务交付的最小可用实现（非未完成描述），props 契约与 Task 6 完全一致；无 TBD/TODO。
- **类型一致性**：`LibraryViewRoute`（Task 5 定义，Task 5 内消费）、`LibraryCommandDialogProps`（Task 5 定义，Task 6 同签名实现）、`SortField = "name" | "activity"`（Task 3 起）、`location: string[]`（Task 2 契约）——已交叉核对。
