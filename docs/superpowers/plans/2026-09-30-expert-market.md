# 专家市场重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 专家 Tab 重构为「专家市场首页 + 我的专家双态 + 对话式创建引导」，参照 `docs/superpowers/specs/2026-09-30-expert-market-design.md`。

**Architecture:** 市场数据为前端静态目录（`data/marketplace.ts`，无 IPC）；「我的专家」= 现有 `assistant` 表（+3 列 description/tags/sourceSlug）；创建流复用「创建技能」的预填跳聊天页模式；视图挂载进 `ExpertsView` 的 assistants 分支（`?view=market|mine`）。

**Tech Stack:** React 19 + React Query + Zustand + Tailwind 4（主题变量）+ react-i18next + Prisma 7 / SQLite（better-sqlite3）+ Vitest。

**Spec:** `docs/superpowers/specs/2026-09-30-expert-market-design.md`

## Global Constraints

- 用户可见文案必须走 `t()`（i18n），专家条目内容数据（名称/描述/标签）除外——直接中文。
- 主题色只用 CSS 变量类（`bg-primary-subtle`/`text-primary` 等），禁 `bg-blue-*` 等硬编码色。
- 弹窗边框 `border-border/50 rounded-lg shadow-lg`；触发按钮 hover 三件套（`hover:bg-primary-subtle hover:text-primary hover:border-primary/30`）。
- 文件名 kebab-case；变量/函数 camelCase；函数 ≤20 行；重复 ≥2 次抽函数。
- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号。
- 数据库：发布前直接改 v1 快照（`DATABASE_VERSION` 恒 1），`prisma generate` 再生 `electron/generated/prisma`。
- 完成口径：`npm run test` + `npm run typecheck` + `npm run lint` 全绿。
- commit 消息中文域前缀（如 `feat(专家市场)`），conventional 风格。

---

### Task 1: 数据层——assistant 表扩展与 repo 改造

**Files:**
- Modify: `prisma/schema.prisma`（assistant 模型，67-81 行附近）
- Modify: `electron/infrastructure/script/v1/upgrade-table.sql:74-86`（assistant 建表）
- Modify: `src-react/domains/ai/api/assistant.api.ts`
- Modify: `electron/domains/ai/chat/assistant.repo.ts`
- Modify: `electron/generated/prisma/*`（`npx prisma generate` 再生，不入步骤代码）
- Test: `tests/ai/assistant-repo.test.ts`（新建）

**Interfaces:**
- Produces（后续任务依赖的精确类型）：
  - `AssistantRecord` 增加 `description?: string; tags?: string[]; sourceSlug?: string;`
  - `AssistantCreateParams` 增加 `description?: string; tags?: string[]; sourceSlug?: string;`
  - `AssistantUpdateParams` 增加 `description?: string | null; tags?: string[] | null;`（`sourceSlug` 不可更新）

- [ ] **Step 1: 写失败的 repo 测试**

新建 `tests/ai/assistant-repo.test.ts`，照搬 `tests/ai/automation-repo.test.ts` 的 mock 三件套（repo 顶层 import prisma-client/Log/electron 在 vitest 里 import 即崩）：

```ts
/**
 * assistant.repo 单测：新字段透传(tags JSON 序列化/description/sourceSlug)、
 * 去播种回归、builtin 删除限制回归。IPC/DB 副作用 mock 三件套隔离
 * （同 automation-repo.test.ts）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    assistant: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { AssistantRepository } from "../../electron/domains/ai/chat/assistant.repo";
import prisma from "../../electron/commons/prisma-client";

const UID = 1;
const repo = new AssistantRepository();

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "通用助手",
  icon: "🤖",
  systemPrompt: "prompt",
  temperature: null,
  topP: null,
  maxTokens: null,
  builtin: false,
  description: null,
  tags: null,
  sourceSlug: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  userId: UID,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list（去播种回归）", () => {
  it("空用户不再播种，直接返回空数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    const result = await repo.list(UID);
    expect(result).toEqual([]);
    expect(prisma.assistant.count).not.toHaveBeenCalled();
  });

  it("toRecord 解析 tags JSON 字符串为数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ tags: '["a","b"]' }),
    ]);
    const result = await repo.list(UID);
    expect(result[0].tags).toEqual(["a", "b"]);
  });

  it("toRecord 对坏 JSON tags 回退空数组不抛错", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ tags: "{broken" }),
    ]);
    const result = await repo.list(UID);
    expect(result[0].tags).toEqual([]);
  });
});

describe("create（新字段透传）", () => {
  it("tags 序列化为 JSON 字符串，description/sourceSlug 落库", async () => {
    (prisma.assistant.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({
        description: "d",
        tags: '["x"]',
        sourceSlug: "general",
      }),
    );
    await repo.create(
      {
        name: "通用助手",
        systemPrompt: "prompt",
        description: "d",
        tags: ["x"],
        sourceSlug: "general",
      },
      UID,
    );
    expect(prisma.assistant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: "d",
        tags: '["x"]',
        sourceSlug: "general",
      }),
    });
  });
});

describe("update（可空清空语义）", () => {
  it("tags null 清空、undefined 不出现在 data", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update({ id: 1, name: "n", tags: null }, UID);
    const data = (prisma.assistant.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0].data;
    expect(data.tags).toBeNull();
    await repo.update({ id: 1, description: "new" }, UID);
    const data2 = (prisma.assistant.update as ReturnType<typeof vi.fn>).mock
      .calls[1][0].data;
    expect("tags" in data2).toBe(false);
    expect(data2.description).toBe("new");
  });
});

describe("delete（builtin 限制回归）", () => {
  it("builtin 行拒绝删除", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ builtin: true }),
    );
    await expect(repo.delete(1, UID)).rejects.toThrow("ASSISTANT_BUILTIN");
    expect(prisma.assistant.delete).not.toHaveBeenCalled();
  });
});
```

注意：现 repo 未导出类（`export class AssistantRepository` 已有，确认 import 路径可用）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/assistant-repo.test.ts`
Expected: FAIL——`tags` 字段不存在（TS 类型报错）或播种调用 count。

- [ ] **Step 3: 改 schema + v1 快照 + api 类型 + repo**

`prisma/schema.prisma` assistant 模型（`builtin Boolean @default(false)` 行后）加：

```prisma
  description String?
  tags        String?
  sourceSlug  String?
```

`electron/infrastructure/script/v1/upgrade-table.sql` assistant 表（`builtin BOOLEAN NOT NULL DEFAULT 0,` 行后）加：

```sql
    description TEXT NULL,
    tags TEXT NULL,
    sourceSlug TEXT NULL,
```

并在表后注释行（仿既有 `--/p` 风格）：`--/p 专家市场：描述/标签(JSON数组字符串)/市场来源slug`

`src-react/domains/ai/api/assistant.api.ts`：
- `AssistantRecord` 加 `description?: string; tags?: string[]; sourceSlug?: string;`
- `AssistantCreateParams` 加 `description?: string; tags?: string[]; sourceSlug?: string;`
- `AssistantUpdateParams` 加 `description?: string | null; tags?: string[] | null;`

`electron/domains/ai/chat/assistant.repo.ts`：

1. 删除 `BUILTIN_ASSISTANTS` 常量与 `seedIfEmptyFor` 方法；`list` 去掉 `await this.seedIfEmptyFor(userId);`。
2. 加 tags 解析私有方法：

```ts
  /** tags 列为 JSON 数组字符串；坏数据回退空数组不抛错（展示字段） */
  private parseTags(raw: string | null): string[] {
    if (!raw) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
```

3. `toRecord` 返回对象加：

```ts
      description: row.description ?? undefined,
      tags: this.parseTags(row.tags),
      sourceSlug: row.sourceSlug ?? undefined,
```

4. `create` 的 `data` 加：

```ts
        description: p.description,
        tags: p.tags ? JSON.stringify(p.tags) : undefined,
        sourceSlug: p.sourceSlug,
```

5. `update` 的 `data` 加（可空清空语义，同 icon）：

```ts
        description: p.description,
        tags:
          p.tags === undefined
            ? undefined
            : p.tags === null
              ? null
              : JSON.stringify(p.tags),
```

- [ ] **Step 4: 再生 Prisma 客户端并跑测试**

Run: `npx prisma generate && npx vitest run tests/ai/assistant-repo.test.ts tests/ai/v1-fullschema.test.ts`
Expected: 全 PASS（fullschema 只断言表存在与 userId 列，加列不影响）。

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma electron/infrastructure/script/v1/upgrade-table.sql src-react/domains/ai/api/assistant.api.ts electron/domains/ai/chat/assistant.repo.ts electron/generated/prisma tests/ai/assistant-repo.test.ts
git commit -m "feat(专家市场): assistant 表加 description/tags/sourceSlug 三列——repo 透传与 tags JSON 序列化，去内置助手播种"
```

---

### Task 2: 市场数据模块 + 过滤排序纯函数

**Files:**
- Create: `src-react/domains/ai/experts/data/marketplace.ts`
- Create: `src-react/domains/ai/experts/lib/market-filter.ts`
- Test: `tests/ai/market-filter.test.ts`（新建）

**Interfaces:**
- Produces（Task 5/6 依赖）：

```ts
export interface ExpertMarketItem {
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  systemPrompt: string;
  category: string; // EXPERT_CATEGORIES 的 key
  tags: string[];
  badge?: string;
  type: "expert" | "team";
  score: number;
  downloads: number;
  createdAt: string; // ISO 日期
}
export interface ExpertScenario {
  slug: string;
  titleKey: string; // i18n key 段，如 "back-to-school"
  icon: string;     // emoji
  gradient: string; // Tailwind 主题渐变类，如 "from-primary/15 to-primary-active/10"
  expertSlugs: string[];
}
export const EXPERT_CATEGORIES: ReadonlyArray<{ key: string; labelKey: string }>;
export const SCENARIOS: ExpertScenario[];
export const MARKET_EXPERTS: ExpertMarketItem[];
// lib/market-filter.ts
export type ExpertSortBy = "comprehensive" | "hot" | "newest";
export function filterExperts(
  items: ExpertMarketItem[],
  filter: {
    keyword?: string;
    type?: "expert" | "team";
    category?: string;
    scenarioSlugs?: Set<string>;
  },
): ExpertMarketItem[];
export function sortExperts(
  items: ExpertMarketItem[],
  sortBy: ExpertSortBy,
): ExpertMarketItem[];
```

- [ ] **Step 1: 写失败的纯函数测试**

新建 `tests/ai/market-filter.test.ts`：

```ts
/**
 * 市场过滤/排序纯函数单测：关键词(name/subtitle/description/tags 命中、
 * 大小写不敏感)、type/分类/场景过滤、三种排序与稳定性、组合叠加
 */
import { describe, expect, it } from "vitest";

import {
  filterExperts,
  sortExperts,
  type ExpertMarketItem,
} from "../../src-react/domains/ai/experts/lib/market-filter";

const item = (overrides: Partial<ExpertMarketItem>): ExpertMarketItem => ({
  slug: "a",
  name: "微信小程序开发者",
  subtitle: "小程序达人",
  description: "精通微信小程序开发框架和生态",
  icon: "🤖",
  systemPrompt: "p",
  category: "tech",
  tags: ["小程序开发", "全栈开发"],
  type: "expert",
  score: 90,
  downloads: 100,
  createdAt: "2026-08-01",
  ...overrides,
});

const ITEMS = [
  item({ slug: "a", name: "Alpha", score: 90, downloads: 100, createdAt: "2026-08-01" }),
  item({ slug: "b", name: "Beta", subtitle: "trader", score: 80, downloads: 300, createdAt: "2026-09-01", type: "team" }),
  item({ slug: "c", description: "GODOT engine", category: "product", score: 85, downloads: 200, createdAt: "2026-07-01" }),
];

describe("filterExperts", () => {
  it("空过滤条件返回全量", () => {
    expect(filterExperts(ITEMS, {})).toHaveLength(3);
  });

  it("关键词命中 name/subtitle/description/tags，大小写不敏感", () => {
    expect(filterExperts(ITEMS, { keyword: "alpha" })).toHaveLength(1);
    expect(filterExperts(ITEMS, { keyword: "TRADER" })).toHaveLength(1);
    expect(filterExperts(ITEMS, { keyword: "godot" })).toHaveLength(1);
    expect(filterExperts(ITEMS, { keyword: "小程序开发" })).toHaveLength(1);
    expect(filterExperts(ITEMS, { keyword: "不存在" })).toHaveLength(0);
  });

  it("type 筛选专家团", () => {
    const teams = filterExperts(ITEMS, { type: "team" });
    expect(teams).toHaveLength(1);
    expect(teams[0].slug).toBe("b");
  });

  it("分类过滤", () => {
    expect(filterExperts(ITEMS, { category: "product" })[0].slug).toBe("c");
  });

  it("场景 slug 集合过滤", () => {
    const slugs = new Set(["a", "b"]);
    expect(filterExperts(ITEMS, { scenarioSlugs: slugs })).toHaveLength(2);
  });

  it("组合叠加（交集）", () => {
    expect(
      filterExperts(ITEMS, { type: "expert", keyword: "alpha" }),
    ).toHaveLength(1);
    expect(
      filterExperts(ITEMS, { type: "team", keyword: "alpha" }),
    ).toHaveLength(0);
  });
});

describe("sortExperts", () => {
  it("comprehensive 按 score 降序", () => {
    expect(sortExperts(ITEMS, "comprehensive").map((i) => i.slug)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("hot 按 downloads 降序", () => {
    expect(sortExperts(ITEMS, "hot").map((i) => i.slug)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("newest 按 createdAt 降序", () => {
    expect(sortExperts(ITEMS, "newest").map((i) => i.slug)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("相等键保持稳定（不重排）", () => {
    const same = [
      item({ slug: "x", score: 1 }),
      item({ slug: "y", score: 1 }),
    ];
    expect(sortExperts(same, "comprehensive").map((i) => i.slug)).toEqual([
      "x",
      "y",
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/market-filter.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现数据模块与纯函数**

新建 `src-react/domains/ai/experts/lib/market-filter.ts`：

```ts
/**
 * 市场过滤/排序纯函数（内存数据，无 IPC）
 */
import type { ExpertMarketItem } from "../data/marketplace";

export type ExpertSortBy = "comprehensive" | "hot" | "newest";

/** 关键词匹配：名称/身份标签/描述/标签，大小写不敏感 includes */
function matchesKeyword(item: ExpertMarketItem, keyword: string): boolean {
  const haystacks = [item.name, item.subtitle, item.description, ...item.tags];
  return haystacks.some((text) => text.toLowerCase().includes(keyword));
}

export function filterExperts(
  items: ExpertMarketItem[],
  filter: {
    keyword?: string;
    type?: "expert" | "team";
    category?: string;
    scenarioSlugs?: Set<string>;
  },
): ExpertMarketItem[] {
  const keyword = filter.keyword?.trim().toLowerCase();
  return items.filter((item) => {
    if (keyword && !matchesKeyword(item, keyword)) {
      return false;
    }
    if (filter.type && item.type !== filter.type) {
      return false;
    }
    if (filter.category && item.category !== filter.category) {
      return false;
    }
    if (filter.scenarioSlugs && !filter.scenarioSlugs.has(item.slug)) {
      return false;
    }
    return true;
  });
}

export function sortExperts(
  items: ExpertMarketItem[],
  sortBy: ExpertSortBy,
): ExpertMarketItem[] {
  const keyOf = (item: ExpertMarketItem): number | string =>
    sortBy === "comprehensive"
      ? item.score
      : sortBy === "hot"
        ? item.downloads
        : item.createdAt;
  // 同分稳定：sort 已是稳定实现，相等键不重排
  return [...items].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) {
      return 0;
    }
    return ka < kb ? 1 : -1;
  });
}
```

新建 `src-react/domains/ai/experts/data/marketplace.ts`。结构如下，**收录条目给全量规格与示例，其余按验收标准补齐**：

```ts
/**
 * 专家市场内置目录（静态运营数据，无 IPC）：分类/场景/专家清单。
 * 名称/描述/标签为内容数据直接中文（同 BUILTIN_ASSISTANTS 先例），
 * 不走 i18n；分类与场景标题走 i18n（experts.categories/scenarios）。
 */

export interface ExpertMarketItem {
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  systemPrompt: string;
  category: string;
  tags: string[];
  badge?: string;
  type: "expert" | "team";
  score: number;
  downloads: number;
  createdAt: string;
}

export interface ExpertScenario {
  slug: string;
  titleKey: string;
  icon: string;
  gradient: string;
  expertSlugs: string[];
}

export const EXPERT_CATEGORIES = [
  { key: "tech", labelKey: "tech" },
  { key: "product", labelKey: "product" },
  { key: "finance", labelKey: "finance" },
  { key: "data", labelKey: "data" },
  { key: "content", labelKey: "content" },
  { key: "marketing", labelKey: "marketing" },
  { key: "sales", labelKey: "sales" },
  { key: "ops", labelKey: "ops" },
  { key: "education", labelKey: "education" },
  { key: "legal", labelKey: "legal" },
] as const;

export const SCENARIOS: ExpertScenario[] = [
  {
    slug: "back-to-school",
    titleKey: "back-to-school",
    icon: "🎓",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: ["campus-coach", "thesis-mentor", "campus-event-planner"],
  },
  {
    slug: "content-creation",
    titleKey: "content-creation",
    icon: "✍️",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: ["content-team", "content-strategist", "redbook-operator"],
  },
  {
    slug: "investment",
    titleKey: "investment",
    icon: "📈",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: ["trading-analysis-team", "stock-researcher", "tax-compliance-team"],
  },
  {
    slug: "legal",
    titleKey: "legal",
    icon: "⚖️",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: ["legal-retrieval", "contract-legal", "tax-compliance-team"],
  },
  {
    slug: "small-business",
    titleKey: "small-business",
    icon: "🏪",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: ["sales-coach", "wechat-mp-operator", "startup-partner"],
  },
  {
    slug: "ecommerce",
    titleKey: "ecommerce",
    icon: "🛒",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: ["ecommerce-operator", "cross-border-ecommerce", "content-monetization"],
  },
];

export const MARKET_EXPERTS: ExpertMarketItem[] = [
  // —— 收录的原内置助手（systemPrompt 原文照搬，旧用户体感连续）——
  {
    slug: "general-assistant",
    name: "通用助手",
    subtitle: "全能问答",
    description: "乐于助人的通用 AI 助手，回答简洁准确，适合日常各类问题。",
    icon: "🤖",
    systemPrompt: "你是一个乐于助人的通用 AI 助手，回答简洁准确。",
    category: "tech",
    tags: ["通用问答", "日常助手"],
    type: "expert",
    score: 95,
    downloads: 1200,
    createdAt: "2026-06-01",
  },
  {
    slug: "translator",
    name: "翻译助手",
    subtitle: "中英互译",
    description: "专业翻译：中文输入译成英文，其他语言译成中文，只输出译文。",
    icon: "🌍",
    systemPrompt:
      "你是一名专业翻译。用户输入什么语言，就翻译成另一种语言：中文输入译成英文，其他语言输入译成中文。只输出译文，不解释。",
    category: "education",
    tags: ["翻译", "中英互译"],
    type: "expert",
    score: 88,
    downloads: 800,
    createdAt: "2026-06-01",
  },
  {
    slug: "code-reviewer",
    name: "代码审查",
    subtitle: "资深审查员",
    description: "针对代码指出正确性、可读性与潜在风险，按严重程度排序并给修改建议。",
    icon: "🔍",
    systemPrompt:
      "你是一名资深代码审查员。针对用户给出的代码，指出正确性问题、可读性问题与潜在风险，按严重程度排序，并给出修改建议。",
    category: "tech",
    tags: ["代码审查", "工程质量"],
    badge: "特邀",
    type: "expert",
    score: 92,
    downloads: 950,
    createdAt: "2026-06-01",
  },
  // —— 常规条目示例（各分类补齐至验收标准）——
  {
    slug: "wechat-miniprogram-dev",
    name: "微信小程序开发者",
    subtitle: "小程序达人",
    description: "精通微信小程序开发框架和生态，从零到上线全流程护航。",
    icon: "📱",
    systemPrompt:
      "你是一名精通微信小程序开发的工程师，熟悉 WXML/WXSS、组件库与云开发，能给出可落地的开发方案与代码。",
    category: "tech",
    tags: ["小程序开发", "全栈开发"],
    type: "expert",
    score: 90,
    downloads: 700,
    createdAt: "2026-08-15",
  },
  {
    slug: "godot-script-engineer",
    name: "Godot 游戏脚本工程师",
    subtitle: "GDScript 专家",
    description: "精通 GDScript 2.0 与 Godot 引擎节点系统，游戏玩法快速原型。",
    icon: "🎮",
    systemPrompt:
      "你是一名 Godot 游戏开发工程师，精通 GDScript 2.0 与节点/信号体系，给出结构清晰可运行的游戏脚本。",
    category: "tech",
    tags: ["Godot", "GDScript", "游戏开发"],
    type: "expert",
    score: 78,
    downloads: 300,
    createdAt: "2026-09-10",
  },
  // —— 专家团示例 ——
  {
    slug: "content-team",
    name: "内容创作专家团",
    subtitle: "选题·撰写·运营",
    description: "选题策划、爆款撰写、平台运营三角色协作，一站式内容生产。",
    icon: "👥",
    systemPrompt:
      "你是内容创作专家团，由选题策划、文案撰写、平台运营三个角色协作，按用户需求分工输出完整内容方案。",
    category: "content",
    tags: ["内容创作", "选题策划", "平台运营"],
    badge: "官方",
    type: "team",
    score: 96,
    downloads: 1500,
    createdAt: "2026-07-20",
  },
  // …（其余条目按下方验收标准补齐）
];
```

**数据验收标准（执行时逐条核对）：**
- 总数 ≥ 20（专家 ≥ 17 + 专家团 ≥ 2 + 收录内置 3 个已含其中）。
- 每个分类（10 个 key）至少 2 个条目。
- SCENARIOS 的 `expertSlugs` 引用的每个 slug 都存在于 MARKET_EXPERTS（TS 层面在文件尾加断言式校验，见下）。
- 每条 systemPrompt 是可直接使用的完整角色提示词（≥ 40 字）。
- 收录 3 个内置助手的 name/icon/systemPrompt 与 `BUILTIN_ASSISTANTS` 原文一致（Task 1 已删，以本计划上方原文为准）。
- 数据多样性：score 60-96、downloads 100-1500、createdAt 分布 2026-06 至 2026-09，三种排序在「综合」默认页有区分度。

文件尾加引用完整性校验（编译期跑一次）：

```ts
/** 场景引用完整性：编译期确保 expertSlugs 均存在于目录 */
const ALL_SLUGS = new Set(MARKET_EXPERTS.map((e) => e.slug));
for (const scenario of SCENARIOS) {
  for (const slug of scenario.expertSlugs) {
    if (!ALL_SLUGS.has(slug)) {
      throw new Error(`scenario ${scenario.slug} 引用了不存在的专家 ${slug}`);
    }
  }
}
```

（注意：SCENARIOS 中先引用、数据里补齐的 slug——校园求职教练 `campus-coach`、论文写作导师 `thesis-mentor`、校园活动策划 `campus-event-planner`、内容策略 `content-strategist`、小红书运营 `redbook-operator`、交易分析团队 `trading-analysis-team`、股票研究 `stock-researcher`、财税合规专家团 `tax-compliance-team`、法律检索 `legal-retrieval`、资深合同法务 `contract-legal`、销售教练 `sales-coach`、公众号运营 `wechat-mp-operator`、创业伙伴 `startup-partner`、电商运营 `ecommerce-operator`、跨境电商 `cross-border-ecommerce`、内容变现 `content-monetization`——共 16 个场景引用专家必须在数据中定义。）

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/ai/market-filter.test.ts`
Expected: PASS（11 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/experts/data/marketplace.ts src-react/domains/ai/experts/lib/market-filter.ts tests/ai/market-filter.test.ts
git commit -m "feat(专家市场): 内置市场目录（分类/场景/专家清单）与过滤排序纯函数"
```

---

### Task 3: i18n 文案

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/chat.json`（experts 节）
- Modify: `src-react/i18n/locales/en-US/chat.json`（experts 节）

**Interfaces:**
- Produces: `chat:experts.market.*` / `chat:experts.myExperts.*` / `chat:experts.createPrompt` / `chat:experts.scenarios.<slug>` / `chat:experts.categories.<key>`（Task 4-7 全部 `t()` 引用以下 key，两文件 key 集合必须一致）。

- [ ] **Step 1: zh-CN/chat.json 的 experts 节整体替换为**

```json
{
  "tabAssistants": "专家",
  "tabSkills": "技能",
  "tabConnectors": "连接器",
  "skillsDesc": "技能存放在本地技能目录中，可编辑 Markdown 技能文件",
  "openSkillDir": "打开技能目录",
  "createPrompt": "帮我创建一个专家，擅长 [专家方向]。我的经验是：[请补充你的行业背景、相关经验]",
  "market": {
    "searchPlaceholder": "搜索专家职称或描述",
    "myExperts": "我的专家",
    "myExpertsCount": "我的专家 {{count}}",
    "scenarios": "精选场景",
    "allExperts": "全部专家",
    "typeExpert": "专家",
    "typeTeam": "专家团",
    "sortComprehensive": "综合",
    "sortHot": "最热",
    "sortNewest": "最新",
    "allCategories": "全部",
    "add": "添加",
    "added": "已添加",
    "addSuccess": "已添加到我的专家",
    "addToMine": "添加到我的专家",
    "addAndChat": "添加并对话",
    "goChat": "去对话",
    "systemPromptPreview": "提示词预览",
    "noResult": "没有符合条件的专家"
  },
  "myExperts": {
    "create": "创建专家",
    "emptyTitle": "还没有创建任何专家",
    "emptySubtitle": "创建属于你的专家，分享专业知识",
    "browseMarket": "去市场逛逛",
    "openChat": "开对话",
    "chatFailed": "创建会话失败"
  },
  "scenarios": {
    "back-to-school": "开学季",
    "content-creation": "内容创作",
    "investment": "投资分析",
    "legal": "法律咨询",
    "small-business": "小微企业",
    "ecommerce": "电商运营"
  },
  "categories": {
    "tech": "技术工程",
    "product": "产品设计",
    "finance": "金融投资",
    "data": "数据智能",
    "content": "内容创作",
    "marketing": "营销增长",
    "sales": "销售商务",
    "ops": "运营人力",
    "education": "教育学习",
    "legal": "法务安全"
  }
}
```

- [ ] **Step 2: en-US/chat.json 的 experts 节对应替换为**

```json
{
  "tabAssistants": "Experts",
  "tabSkills": "Skills",
  "tabConnectors": "Connectors",
  "skillsDesc": "Skills live in the local skill directory as editable Markdown files",
  "openSkillDir": "Open skill directory",
  "createPrompt": "Help me create an expert skilled in [expert field]. My experience: [add your industry background and relevant experience]",
  "market": {
    "searchPlaceholder": "Search expert title or description",
    "myExperts": "My Experts",
    "myExpertsCount": "My Experts ({{count}})",
    "scenarios": "Featured Scenarios",
    "allExperts": "All Experts",
    "typeExpert": "Experts",
    "typeTeam": "Teams",
    "sortComprehensive": "Recommended",
    "sortHot": "Popular",
    "sortNewest": "Newest",
    "allCategories": "All",
    "add": "Add",
    "added": "Added",
    "addSuccess": "Added to My Experts",
    "addToMine": "Add to My Experts",
    "addAndChat": "Add & Chat",
    "goChat": "Chat",
    "systemPromptPreview": "System Prompt",
    "noResult": "No matching experts"
  },
  "myExperts": {
    "create": "Create Expert",
    "emptyTitle": "No experts created yet",
    "emptySubtitle": "Create your own expert and share professional knowledge",
    "browseMarket": "Browse Marketplace",
    "openChat": "Chat",
    "chatFailed": "Failed to create session"
  },
  "scenarios": {
    "back-to-school": "Back to School",
    "content-creation": "Content Creation",
    "investment": "Investment Analysis",
    "legal": "Legal Advice",
    "small-business": "Small Business",
    "ecommerce": "E-commerce"
  },
  "categories": {
    "tech": "Engineering",
    "product": "Product Design",
    "finance": "Finance",
    "data": "Data & AI",
    "content": "Content",
    "marketing": "Marketing",
    "sales": "Sales",
    "ops": "Operations & HR",
    "education": "Education",
    "legal": "Legal & Compliance"
  }
}
```

- [ ] **Step 3: 校验 JSON 合法且 key 集合一致**

Run: `node -e "const z=require('./src-react/i18n/locales/zh-CN/chat.json').experts,e=require('./src-react/i18n/locales/en-US/chat.json').experts;const f=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'?f(v,p+k+'.'):[p+k]);const a=f(z),b=f(e);console.log(a.length===b.length&&a.every(k=>b.includes(k))?'OK':'MISMATCH:'+a.filter(k=>!b.includes(k)).concat(b.filter(k=>!a.includes(k))))"`
Expected: 输出 `OK`。

- [ ] **Step 4: Commit**

```bash
git add src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(专家市场): 市场/我的专家/场景/分类 i18n 文案（zh-CN/en-US）"
```

---

### Task 4: AssistantDialog 表单扩展（描述 + 标签）

**Files:**
- Modify: `src-react/domains/ai/assistant/components/AssistantDialog.tsx`

**Interfaces:**
- Consumes: Task 1 的 `AssistantCreateParams.description/tags`、`AssistantUpdateParams.description/tags`。
- Produces: 表单支持编辑描述（Textarea）与标签（逗号分隔 Input），提交时 create 传数组、update 差量（同值 undefined / 清空 null）。

- [ ] **Step 1: 加表单状态与字段**

在 `AssistantDialog.tsx`：

1. state 区（`const [maxTokens, setMaxTokens] = useState("");` 后）加：

```tsx
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
```

2. `useEffect` 初始化块（`setMaxTokens(...)` 后）加：

```tsx
      setDescription(editing?.description ?? "");
      setTagsInput((editing?.tags ?? []).join(", "));
```

3. 提交参数构造（`params` 对象内 `maxTokens` 后）加：

```tsx
        description: description.trim() || undefined,
        tags: parseTagsInput(tagsInput),
```

4. `handleSubmit` 编辑分支（`maxTokens: diffOptionalValue(...)` 后）加差量（tags 数组无现成 diff 工具，比较 join 串）：

```tsx
          description: diffOptionalString(description, editing.description),
          tags: diffTagsInput(tagsInput, editing.tags),
```

5. 文件内（组件外）加两个小函数（复用 `parse-number.ts` 同目录风格，不必新建文件）：

```tsx
/** 标签输入解析：逗号分隔 → 去空白去空项的数组 */
function parseTagsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 标签差量：与原值一致 undefined（不改），空数组 null（清空），否则新数组 */
function diffTagsInput(
  raw: string,
  original: string[] | undefined,
): string[] | null | undefined {
  const next = parseTagsInput(raw);
  const joined = next.join(",");
  if (joined === (original ?? []).join(",")) {
    return undefined;
  }
  return joined ? next : null;
}
```

6. JSX：systemPrompt 的 Textarea 区块后、`ai:model.optionalHint` 提示行**之前**加：

```tsx
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.description")}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.tags")}</Label>
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </div>
```

7. `ai.json`（zh-CN 与 en-US 两份，`assistant` 节内 `systemPrompt` key 后）加：

```json
"description": "描述",
"tags": "标签"
```

en-US 对应 `"description": "Description"`、`"tags": "Tags"`。

- [ ] **Step 2: 类型与 lint 校验**

Run: `npm run typecheck && npx eslint src-react/domains/ai/assistant/components/AssistantDialog.tsx`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src-react/domains/ai/assistant/components/AssistantDialog.tsx src-react/i18n/locales/zh-CN/ai.json src-react/i18n/locales/en-US/ai.json
git commit -m "feat(专家市场): 助手表单加描述/标签字段——编辑态差量提交（同值不改/清空传 null）"
```

---

### Task 5: 市场卡片与详情弹窗组件

**Files:**
- Create: `src-react/domains/ai/experts/components/ExpertCard.tsx`
- Create: `src-react/domains/ai/experts/components/ExpertDetailDialog.tsx`

**Interfaces:**
- Consumes: Task 2 的 `ExpertMarketItem`；Task 3 的 i18n keys。
- Produces（Task 6 使用，props 签名固定）：

```ts
// ExpertCard
export default function ExpertCard(props: {
  item: ExpertMarketItem;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
  onOpenDetail: () => void;
}): JSX.Element;
// ExpertDetailDialog（open 由 item 非 null 表达）
export default function ExpertDetailDialog(props: {
  item: ExpertMarketItem | null;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
  onAddAndChat: () => void;
  onOpenChange: (open: boolean) => void;
}): JSX.Element;
```

- [ ] **Step 1: 实现 ExpertCard.tsx**

```tsx
/**
 * 市场专家卡：emoji 头像/名称/徽章/身份标签/描述截断/标签胶囊 +
 * 添加三态按钮（同 SkillHubCard 范式）；点卡片主体开详情弹窗
 */
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ExpertMarketItem } from "../data/marketplace";

export default function ExpertCard({
  item,
  added,
  adding,
  onAdd,
  onOpenDetail,
}: {
  item: ExpertMarketItem;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
  onOpenDetail: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <Card
      className="flex cursor-pointer flex-col border-border/50 rounded-lg shadow-sm transition-colors hover:border-primary/30"
      onClick={onOpenDetail}
    >
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-xl leading-none">
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-medium text-foreground">
                {item.name}
              </p>
              {item.badge && (
                <Badge
                  variant="secondary"
                  className="h-4 shrink-0 px-1.5 text-[10px]"
                >
                  {item.badge}
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {item.subtitle}
            </p>
          </div>
          {added ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              aria-label={t("chat:experts.market.added")}
            >
              <Check className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={adding}
              aria-label={t("chat:experts.market.add")}
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
          {item.description}
        </p>
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: 实现 ExpertDetailDialog.tsx**

```tsx
/**
 * 市场专家详情弹窗：完整描述 + 提示词折叠预览 +
 * 「添加到我的专家」（已添加时禁用）/「添加并对话」双动作
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ExpertMarketItem } from "../data/marketplace";

export default function ExpertDetailDialog({
  item,
  added,
  adding,
  onAdd,
  onAddAndChat,
  onOpenChange,
}: {
  item: ExpertMarketItem | null;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
  onAddAndChat: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [promptOpen, setPromptOpen] = useState(false);
  if (!item) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    );
  }
  const typeLabel =
    item.type === "team"
      ? t("chat:experts.market.typeTeam")
      : t("chat:experts.market.typeExpert");
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-xl leading-none">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.badge && <Badge variant="secondary">{item.badge}</Badge>}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {`${item.subtitle} · ${typeLabel}`}
          </p>
          <p className="text-sm text-foreground">{item.description}</p>
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            onClick={() => setPromptOpen((v) => !v)}
          >
            {promptOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {t("chat:experts.market.systemPromptPreview")}
          </button>
          <p
            className={cn(
              "whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs text-muted-foreground",
              !promptOpen && "hidden",
            )}
          >
            {item.systemPrompt}
          </p>
        </div>
        <DialogFooter>
          {added ? (
            <Button variant="outline" disabled className="gap-1">
              <Check className="h-4 w-4" />
              {t("chat:experts.market.added")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={adding}
                onClick={onAdd}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("chat:experts.market.addToMine")}
              </Button>
              <Button disabled={adding} onClick={onAddAndChat}>
                {t("chat:experts.market.addAndChat")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: 类型校验 + Commit**

Run: `npm run typecheck`
Expected: 无错误。

```bash
git add src-react/domains/ai/experts/components/ExpertCard.tsx src-react/domains/ai/experts/components/ExpertDetailDialog.tsx
git commit -m "feat(专家市场): 专家卡片与详情弹窗组件——添加三态/提示词折叠预览"
```

---

### Task 6: 市场首页视图（场景横滑 + 筛选 + 网格 + 添加流）

**Files:**
- Create: `src-react/domains/ai/experts/components/ScenarioCard.tsx`
- Create: `src-react/domains/ai/experts/views/ExpertMarketView.tsx`

**Interfaces:**
- Consumes: Task 2 的 `MARKET_EXPERTS`/`SCENARIOS`/`EXPERT_CATEGORIES`/`filterExperts`/`sortExperts`；Task 5 组件；Task 1 `AssistantApi.create`；`SessionApi.create({workspaceId, assistantId})`；`useCreateSkillPromptStore` 不用（创建流在 Task 7）。
- Produces（Task 8 使用）：`export default function ExpertMarketView(props: { onOpenMine: () => void }): JSX.Element;`

- [ ] **Step 1: 实现 ScenarioCard.tsx**

```tsx
/**
 * 精选场景卡：渐变背景 + 标题 + 推荐专家（头像+名称，取前 3）。
 * 点卡片背景进场景聚合（onOpenScenario）；点专家行开该专家详情
 */
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { ExpertMarketItem, ExpertScenario } from "../data/marketplace";

export default function ScenarioCard({
  scenario,
  experts,
  onOpenScenario,
  onOpenExpert,
}: {
  scenario: ExpertScenario;
  experts: ExpertMarketItem[];
  onOpenScenario: () => void;
  onOpenExpert: (item: ExpertMarketItem) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <div
      className={cn(
        "w-56 shrink-0 cursor-pointer rounded-lg border border-border/50 bg-gradient-to-br p-3 transition-colors hover:border-primary/30",
        scenario.gradient,
      )}
      onClick={onOpenScenario}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-lg leading-none">{scenario.icon}</span>
        <p className="text-sm font-medium text-foreground">
          {t(`chat:experts.scenarios.${scenario.titleKey}`)}
        </p>
      </div>
      <div className="mt-2 space-y-1">
        {experts.slice(0, 3).map((expert) => (
          <button
            key={expert.slug}
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-primary-subtle"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExpert(expert);
            }}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs">
              {expert.icon}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {expert.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 实现 ExpertMarketView.tsx**

结构照 `SkillDiscoverView.tsx`（同目录参照：`../../skills/views/SkillDiscoverView.tsx`）。完整实现：

```tsx
/**
 * 专家市场首页：搜索 + 我的专家入口｜精选场景横滑（聚合态收起换返回）｜
 * 专家/专家团 + 排序 + 分类横滚筛选｜卡片网格（添加/详情/添加并对话）
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Search, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mapIpcError } from "../../chat/lib/error-message";
import AssistantApi from "../../api/assistant.api";
import SessionApi from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import {
  EXPERT_CATEGORIES,
  MARKET_EXPERTS,
  SCENARIOS,
  type ExpertMarketItem,
} from "../data/marketplace";
import {
  filterExperts,
  sortExperts,
  type ExpertSortBy,
} from "../lib/market-filter";
import ExpertCard from "../components/ExpertCard";
import ExpertDetailDialog from "../components/ExpertDetailDialog";
import ScenarioCard from "../components/ScenarioCard";

const ASSISTANTS_KEY = ["assistants"] as const;

export default function ExpertMarketView({
  onOpenMine,
}: {
  onOpenMine: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<"expert" | "team">("expert");
  const [sortBy, setSortBy] = useState<ExpertSortBy>("comprehensive");
  const [category, setCategory] = useState<string | null>(null);
  const [scenarioSlug, setScenarioSlug] = useState<string | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [addingSlug, setAddingSlug] = useState<string | null>(null);
  const searchTimerRef = useRef<number>(undefined);

  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  const addedSlugs = useMemo(
    () =>
      new Set(
        (assistantsQuery.data ?? [])
          .map((a) => a.sourceSlug)
          .filter((s): s is string => s !== undefined),
      ),
    [assistantsQuery.data],
  );

  /** 市场搜索防抖 300ms（清空即回浏览态，同技能市场） */
  const onSearchChange = (value: string) => {
    setKeywordInput(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setKeyword(value.trim());
    }, 300);
  };

  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.slug === scenarioSlug) ?? null,
    [scenarioSlug],
  );

  const visible = useMemo(() => {
    const filtered = filterExperts(MARKET_EXPERTS, {
      keyword: keyword || undefined,
      type,
      category: category ?? undefined,
      scenarioSlugs: scenario
        ? new Set(scenario.expertSlugs)
        : undefined,
    });
    return sortExperts(filtered, sortBy);
  }, [keyword, type, category, scenario, sortBy]);

  const detailItem = useMemo(
    () => MARKET_EXPERTS.find((e) => e.slug === detailSlug) ?? null,
    [detailSlug],
  );

  /** 添加 = 以市场专家为模板建一条自己的专家 */
  const handleAdd = async (item: ExpertMarketItem) => {
    setAddingSlug(item.slug);
    try {
      await AssistantApi.create({
        name: item.name,
        icon: item.icon,
        systemPrompt: item.systemPrompt,
        description: item.description,
        tags: item.tags,
        sourceSlug: item.slug,
      });
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
      toast.success(t("chat:experts.market.addSuccess"));
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setAddingSlug(null);
    }
  };

  /** 添加并对话：添加后新会话绑定专家直达聊天页 */
  const handleAddAndChat = async (item: ExpertMarketItem) => {
    setAddingSlug(item.slug);
    try {
      const created = await AssistantApi.create({
        name: item.name,
        icon: item.icon,
        systemPrompt: item.systemPrompt,
        description: item.description,
        tags: item.tags,
        sourceSlug: item.slug,
      });
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        return;
      }
      const session = await SessionApi.create({
        workspaceId,
        assistantId: created.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/module/ai?session=${session.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setAddingSlug(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-2">
        {scenario ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setScenarioSlug(null)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("chat:experts.market.allExperts")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={onOpenMine}
          >
            <Users className="mr-1 h-3.5 w-3.5" />
            {t("chat:experts.market.myExpertsCount", {
              count: addedSlugs.size > 0 || (assistantsQuery.data?.length ?? 0),
            })}
          </Button>
        )}
        <div className="relative ml-auto w-56">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("chat:experts.market.searchPlaceholder")}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>

      {/* 精选场景横滑（聚合态收起） */}
      {!scenario && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-foreground">
            {t("chat:experts.market.scenarios")}
          </h3>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {SCENARIOS.map((s) => (
              <ScenarioCard
                key={s.slug}
                scenario={s}
                experts={s.expertSlugs
                  .map(
                    (slug) =>
                      MARKET_EXPERTS.find((e) => e.slug === slug) ??
                      null,
                  )
                  .filter((e): e is ExpertMarketItem => e !== null)}
                onOpenScenario={() => setScenarioSlug(s.slug)}
                onOpenExpert={(item) => setDetailSlug(item.slug)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 筛选行：类型 + 排序 + 分类横滚 */}
      <div className="flex items-center gap-2">
        <div className="inline-flex items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-xs">
          {(
            [
              ["expert", t("chat:experts.market.typeExpert")],
              ["team", t("chat:experts.market.typeTeam")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors",
                type === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-primary",
              )}
              onClick={() => setType(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {(
          [
            ["comprehensive", t("chat:experts.market.sortComprehensive")],
            ["hot", t("chat:experts.market.sortHot")],
            ["newest", t("chat:experts.market.sortNewest")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={cn(
              "text-xs transition-colors",
              sortBy === value
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setSortBy(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 pb-1 [&::-webkit-scrollbar]:hidden">
        <CategoryPill
          active={category === null}
          label={t("chat:experts.market.allCategories")}
          onClick={() => setCategory(null)}
        />
        {EXPERT_CATEGORIES.map((c) => (
          <CategoryPill
            key={c.key}
            active={category === c.key}
            label={t(`chat:experts.categories.${c.labelKey}`)}
            onClick={() => setCategory(c.key)}
          />
        ))}
      </div>

      {/* 网格 */}
      {visible.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("chat:experts.market.noResult")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((item) => (
            <ExpertCard
              key={item.slug}
              item={item}
              added={addedSlugs.has(item.slug)}
              adding={addingSlug === item.slug}
              onAdd={() => void handleAdd(item)}
              onOpenDetail={() => setDetailSlug(item.slug)}
            />
          ))}
        </div>
      )}

      {/* 详情弹窗 */}
      <ExpertDetailDialog
        item={detailItem}
        added={detailItem ? addedSlugs.has(detailItem.slug) : false}
        adding={detailItem ? addingSlug === detailItem.slug : false}
        onAdd={() => detailItem && void handleAdd(detailItem)}
        onAddAndChat={() => detailItem && void handleAddAndChat(detailItem)}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSlug(null);
          }
        }}
      />
    </div>
  );
}

function CategoryPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors",
        active
          ? "bg-primary-subtle text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
```

注意：「我的专家」计数展示应为**全部个人专家数**（含自建），即 `assistantsQuery.data?.length ?? 0`——上方 `myExpertsCount` 传参直接用该值（`addedSlugs.size > 0 || ...` 写法冗余，落地时用 `assistantsQuery.data?.length ?? 0`）。

- [ ] **Step 3: 类型校验 + Commit**

Run: `npm run typecheck`
Expected: 无错误。

```bash
git add src-react/domains/ai/experts/components/ScenarioCard.tsx src-react/domains/ai/experts/views/ExpertMarketView.tsx
git commit -m "feat(专家市场): 市场首页——场景横滑/聚合态、类型排序分类筛选、添加与添加并对话流"
```

---

### Task 7: 我的专家双态视图 + 创建流 + 删旧视图

**Files:**
- Create: `src-react/domains/ai/experts/views/MyExpertsView.tsx`
- Delete: `src-react/domains/ai/assistant/views/AssistantSettingsView.tsx`（能力迁入本视图，仅 ExpertsView 引用过）

**Interfaces:**
- Consumes: Task 1 `AssistantApi`（新字段）；Task 4 `AssistantDialog`；`useCreateSkillPromptStore`（`../../skills/store/create-skill.store`）；Task 3 i18n keys。
- Produces（Task 8 使用）：`export default function MyExpertsView(props: { onBack: () => void; onBrowseMarket: () => void }): JSX.Element;`

- [ ] **Step 1: 实现 MyExpertsView.tsx**

非空态迁移 `AssistantSettingsView.tsx`（74-214 行）的卡片/编辑/删除逻辑并加「开对话」；空态按 PRD 4.2：

```tsx
/**
 * 我的专家：非空=管理网格（编辑/删除/开对话）+创建入口；
 * 空=PRD 引导页（返回全部专家/插画/主副标题/创建按钮/去市场）。
 * 创建流复用「创建技能」预填桥：新会话+预填模板→跳聊天页
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bot,
  Edit,
  GraduationCap,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AssistantApi, { type AssistantRecord } from "../../api/assistant.api";
import SessionApi from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { useCreateSkillPromptStore } from "../../skills/store/create-skill.store";
import AssistantDialog from "../../assistant/components/AssistantDialog";

const ASSISTANTS_KEY = ["assistants"] as const;

export default function MyExpertsView({
  onBack,
  onBrowseMarket,
}: {
  onBack: () => void;
  onBrowseMarket: () => void;
}) {
  const { t } = useTranslation(["ai", "chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setPendingPrompt = useCreateSkillPromptStore(
    (s) => s.setPendingPrompt,
  );
  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  const assistants = assistantsQuery.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AssistantRecord>();
  const [deleting, setDeleting] = useState<AssistantRecord | null>(null);

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  /** 对话式创建：新开会话+预填模板→跳聊天页（同创建技能流） */
  const handleChatCreate = async () => {
    try {
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        toast.info(t("chat:skills.comingSoon"));
        return;
      }
      const created = await SessionApi.create({ workspaceId });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setPendingPrompt(t("chat:experts.createPrompt"));
      navigate(`/module/ai?session=${created.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 表单创建（AI 草稿人工闭环路径） */
  const handleFormCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  /** 开对话：新会话绑定该专家直达聊天页 */
  const handleOpenChat = async (assistant: AssistantRecord) => {
    try {
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        toast.error(t("chat:experts.myExperts.chatFailed"));
        return;
      }
      const session = await SessionApi.create({
        workspaceId,
        assistantId: assistant.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/module/ai?session=${session.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await AssistantApi.delete(deleting.id);
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeleting(null);
    }
  };

  if (assistantsQuery.isPending) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {t("common:loading")}
      </p>
    );
  }
  if (assistantsQuery.isError) {
    return (
      <p className="py-16 text-center text-sm text-destructive">
        {assistantsQuery.error instanceof Error
          ? assistantsQuery.error.message
          : t("ai:errors.UNKNOWN")}
      </p>
    );
  }

  return (
    <div className="p-6">
      {assistants.length === 0 ? (
        <EmptyState
          onBack={onBack}
          onCreate={() => void handleChatCreate()}
          onBrowseMarket={onBrowseMarket}
        />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              onClick={onBack}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("chat:experts.market.allExperts")}
            </Button>
            <Button size="sm" className="ml-auto" onClick={() => void handleChatCreate()}>
              <Plus className="mr-1 h-4 w-4" />
              {t("chat:experts.myExperts.create")}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {assistants.map((assistant) => (
              <ExpertCardMine
                key={assistant.id}
                assistant={assistant}
                onEdit={() => {
                  setEditing(assistant);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(assistant)}
                onOpenChat={() => void handleOpenChat(assistant)}
              />
            ))}
          </div>
        </>
      )}

      <AssistantDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:assistant.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.name} · ${t("ai:assistant.deleteConfirmDesc")}`
                : t("ai:assistant.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** PRD 4.2 空状态：返回 + 毕业帽插画 + 主副标题 + 创建/去市场 */
function EmptyState({
  onBack,
  onCreate,
  onBrowseMarket,
}: {
  onBack: () => void;
  onCreate: () => void;
  onBrowseMarket: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="flex flex-col items-center gap-4 py-24">
      <Button
        variant="ghost"
        size="sm"
        className="absolute left-4 top-4 gap-1 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        onClick={onBack}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t("chat:experts.market.allExperts")}
      </Button>
      <GraduationCap className="h-16 w-16 text-muted-foreground/40" />
      <div className="text-center">
        <p className="text-base font-medium text-foreground">
          {t("chat:experts.myExperts.emptyTitle")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("chat:experts.myExperts.emptySubtitle")}
        </p>
      </div>
      <Button variant="outline" className="gap-1" onClick={onCreate}>
        <Plus className="h-4 w-4" />
        {t("chat:experts.myExperts.create")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        onClick={onBrowseMarket}
      >
        {t("chat:experts.myExperts.browseMarket")}
      </Button>
    </div>
  );
}

interface ExpertCardMineProps {
  assistant: AssistantRecord;
  onEdit: () => void;
  onDelete: () => void;
  onOpenChat: () => void;
}

/** 我的专家卡：迁移自 AssistantCard，描述优先 description 回退 systemPrompt 截断 */
function ExpertCardMine({
  assistant,
  onEdit,
  onDelete,
  onOpenChat,
}: ExpertCardMineProps) {
  const { t } = useTranslation(["ai", "chat", "common"]);
  const description =
    assistant.description ||
    assistant.systemPrompt.slice(0, 60) + (assistant.systemPrompt.length > 60 ? "…" : "");
  return (
    <Card className="flex flex-col border-border/50 rounded-lg shadow-sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-2xl leading-none">
            {assistant.icon ? (
              assistant.icon
            ) : (
              <Bot className="h-5 w-5 text-primary" />
            )}
          </span>
          <CardTitle className="min-w-0 flex-1 truncate text-base">
            {assistant.name}
          </CardTitle>
          {assistant.builtin && (
            <Badge variant="secondary" className="shrink-0">
              {t("ai:assistant.builtin")}
            </Badge>
          )}
        </div>
        <CardDescription className="line-clamp-2 min-h-10">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={onOpenChat}
          aria-label={t("chat:experts.myExperts.openChat")}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={onEdit}
          aria-label={t("common:edit")}
        >
          <Edit className="h-3 w-3" />
        </Button>
        {!assistant.builtin && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
            onClick={onDelete}
            aria-label={t("common:delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

注意：上面保留了未使用的 `handleFormCreate`（与 `openCreate` 重复）——落地时**删除 `handleFormCreate`**，仅保留 `openCreate`（如后续需要表单创建入口再加）；空态 `absolute` 定位的返回按钮需父容器 `relative`，落地时给最外层 `div` 加 `relative`。

- [ ] **Step 2: 删除旧视图**

```bash
git rm src-react/domains/ai/assistant/views/AssistantSettingsView.tsx
```

删前确认无其他引用（已知仅 ExpertsView 引用，Task 8 将移除该 import）：

Run: `grep -rn "AssistantSettingsView" src-react/ --include="*.tsx" --include="*.ts"`
Expected: 仅 `src-react/domains/ai/experts/views/ExpertsView.tsx`（Task 8 处理）与被删文件自身。若出现其他引用，停下向用户报告。

- [ ] **Step 3: 类型校验（预期有 ExpertsView 引用错误，属正常）**

Run: `npm run typecheck`
Expected: 仅 `ExpertsView.tsx` 报 `AssistantSettingsView` 模块缺失——Task 8 修复。若还有其他错误，先修复。

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/experts/views/MyExpertsView.tsx src-react/i18n/locales 2>/dev/null; git rm --cached src-react/domains/ai/assistant/views/AssistantSettingsView.tsx 2>/dev/null; git add -A src-react/domains/ai/assistant/views/
git commit -m "feat(专家市场): 我的专家双态视图——空态引导/管理网格/开对话，迁移并移除 AssistantSettingsView"
```

---

### Task 8: ExpertsView 接线 + 全局验证

**Files:**
- Modify: `src-react/domains/ai/experts/views/ExpertsView.tsx`

**Interfaces:**
- Consumes: Task 6 `ExpertMarketView({onOpenMine})`、Task 7 `MyExpertsView({onBack, onBrowseMarket})`。
- Produces: 路由态 `?tab=assistants&view=market|mine`（`view` 参数在 skills 分支仍表 installed/discover，互不影响）。

- [ ] **Step 1: 改造 ExpertsView**

`ExpertsView.tsx` 修改点：

1. import 替换：删 `import AssistantSettingsView from "../../assistant/views/AssistantSettingsView";`，加：

```tsx
import ExpertMarketView from "./ExpertMarketView";
import MyExpertsView from "./MyExpertsView";
```

加 router 导入（`useSearchParams` 已有）无需变。

2. `assistants` 分支渲染（`{tab === "assistants" && <AssistantSettingsView />}` 替换为）：

```tsx
        {tab === "assistants" &&
          (viewParam === "mine" ? (
            <MyExpertsView
              onBack={navigateToMarket}
              onBrowseMarket={navigateToMarket}
            />
          ) : (
            <ExpertMarketView onOpenMine={navigateToMine} />
          ))}
```

3. 组件内加导航回调（`usePageHeader` 调用之前）：

```tsx
  // 专家子视图路由态：?tab=assistants&view=market|mine（skills 分支不受影响）
  const [searchParams, setSearchParams] = useSearchParams();
  const navigateToMine = () => {
    setSearchParams({ tab: "assistants", view: "mine" });
  };
  const navigateToMarket = () => {
    setSearchParams({ tab: "assistants", view: "market" });
  };
```

注意：现有代码 `const [searchParams] = useSearchParams();` 解构改为带 `setSearchParams`。

4. 头部注释（文件首 JSDoc）更新为双视图说明：

```tsx
/**
 * 专家·技能·连接器统一管理：Tab 切换（专家=市场+我的专家双视图 /
 * 技能=技能管理 / 连接器=MCP）；专家 Tab 由 ?view=market|mine 驱动；
 * Tab 行挂 TopBar（usePageHeader pill 组），页面内容相应上移
 */
```

- [ ] **Step 2: 全量验证**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿。

- [ ] **Step 3: 手动冒烟（npm run dev）**

- `/module/ai/experts` 默认进市场：场景横滑 6 卡、类型/排序/分类筛选、搜索防抖。
- 点场景卡背景 → 聚合态 +「< 全部专家」返回；点场景内专家 → 详情弹窗。
- 市场卡片「+」→ 添加成功 toast + 按钮变 Check；详情弹窗「添加并对话」→ 跳聊天页且会话已绑专家。
- 「我的专家 (n)」→ 管理网格（开对话/编辑/删除）；删除全部后 → 空状态引导。
- 空态「+ 创建专家」→ 新会话 + 输入框预填模板文案。
- 全新数据库（删 `tianshu.db` 重启，快照守卫自动重建）→ 我的专家为空（无播种）。
- 中英文切换文案完整。

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/experts/views/ExpertsView.tsx
git commit -m "feat(专家市场): ExpertsView 接线双视图——?view=market|mine 路由态驱动"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 信息架构→Task 6/7/8；§2 市场首页→Task 2/5/6；§3 数据规格→Task 2；§4 我的专家→Task 7；§5 创建流→Task 7；§6 数据库→Task 1；§7 表单→Task 4；§8 i18n→Task 3；§9 测试→Task 1/2 + Task 8 全量口径；§10 PRD 偏差→设计已定，无实现项。spec 文件清单中「修改 expert-sub-menu.tsx（空列表引导）」**取消**：核实其底部已有「召唤更多专家」常驻入口（expert-sub-menu.tsx:150-153），空列表体验已达标，无需改动。
- **占位符**：市场数据 20+ 条目无法全量铺开，以规格 + 6 条完整示例 + 16 个场景引用 slug 清单 + 逐条验收标准代替（Task 2 Step 3）。
- **类型一致性**：`ExpertMarketItem`/`filterExperts`/`sortExperts` 签名 Task 2 定义、Task 5/6 引用一致；`AssistantRecord.tags: string[]`（repo 解析后）与表单/卡片消费一致；props 签名 `onOpenMine`/`onBack`/`onBrowseMarket` Task 6/7 产出与 Task 8 消费一致。
