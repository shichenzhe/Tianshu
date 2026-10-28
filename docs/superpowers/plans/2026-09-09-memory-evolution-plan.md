# 记忆与进化模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置面板新增「记忆与进化」页：单字段 markdown 存储的四分类画像记忆，支持每晚 AI 定时整理、启动补跑、编辑态 AI 指令增删、重置与跨 AI 导入。

**Architecture:** 记忆正文存 option 表单 key（markdown 纯文本，四节固定标题），存储格式 = AI 输出格式 = 导入粘贴格式。主进程 `memory-compiler`（AI 管线，可注入模型调用）+ `memory-scheduler`（30s tick 决策 + 启动补跑）+ `memory.service`（2 个 IPC 通道）；渲染进程 `MemoryGroup` 整页挂在 SettingsDialog 左栏第 5 项。共享解析器放 src-react 侧由 electron import（沿用 `automation/api/schedule.schema.ts` 的反向引用模式）。

**Tech Stack:** Electron 44 主进程、React 19 + React Query、AI SDK `generateText`、Prisma（option/message/session/workspace 表）、Vitest + Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-09-memory-evolution-design.md`（含 8 条已确认决策 D1–D8，执行前先读）

## Global Constraints

- Prettier：双引号、分号、tabWidth=2、printWidth=80；`npm run lint` 必须通过（生产禁 `console`，日志用 `commons/Log`）。
- i18n：zh-CN 与 en-US 的 `settings.json` 同步添加 key；JSX/JS 禁止硬编码用户可见文本；`useCallback` 内用 `t` 须入依赖数组。
- 主题：禁止 `bg-blue-*` 等硬编码颜色类；弹层 `border-border/50 rounded-lg shadow-lg`；触发按钮 hover 用 `hover:bg-primary-subtle hover:text-primary hover:border-primary/30`。
- 文件名 kebab-case；函数 ≤20 行；所有异常必须处理。
- 测试命令：`npm run test`（Vitest）；单文件 `npx vitest run <path>`。
- 与 spec §4 的唯一偏差（已确认合理）：`memory-markdown.ts` 放 `src-react/domains/app-settings/model/`（前端展示切分与主进程解析共用，沿用 electron 反向 import src-react 的既有模式），不放 `electron/domains/ai/personalization/`。

---

### Task 1: memory-markdown 共享解析器（纯函数）

**Files:**
- Create: `src-react/domains/app-settings/model/memory-markdown.ts`
- Test: `tests/app-settings/memory-markdown.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯函数）。
- Produces（后续所有任务依赖）:
  - `interface MemorySections { work: string; personal: string; current: string; recent: string }`
  - `const MEMORY_PROFILE_LIMIT = 8000`
  - `function stripCodeFence(text: string): string`
  - `function parseMemoryMarkdown(md: string): MemorySections`
  - `function buildMemoryMarkdown(sections: MemorySections): string`
  - `function truncateMemoryMarkdown(md: string, limit?: number): string`
  - `function sortRecentEntries(text: string): string`
  - `function mergeMemoryMarkdown(current: string, incoming: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/app-settings/memory-markdown.test.ts
import { describe, expect, it } from "vitest";

import {
  MEMORY_PROFILE_LIMIT,
  buildMemoryMarkdown,
  mergeMemoryMarkdown,
  parseMemoryMarkdown,
  sortRecentEntries,
  stripCodeFence,
  truncateMemoryMarkdown,
} from "../../src-react/domains/app-settings/model/memory-markdown";

const FULL = [
  "## 工作背景",
  "用户参与 Tianshu 项目",
  "",
  "## 个人背景",
  "用户位于福建厦门",
  "",
  "## 当前关注",
  "[2026-09-08] - UI 界面复刻",
  "",
  "## 近期动态",
  "[2026-09-08] - 推进 Tianshu 工作",
  "[2026-09-07] - 查询厦门天气",
].join("\n");

describe("stripCodeFence", () => {
  it("剥离 ``` 围栏保留内部", () => {
    expect(stripCodeFence("```\n## 工作背景\nx\n```")).toBe(
      "## 工作背景\nx",
    );
  });
  it("无围栏原样返回", () => {
    expect(stripCodeFence("## 工作背景")).toBe("## 工作背景");
  });
});

describe("parseMemoryMarkdown", () => {
  it("四节标准切分", () => {
    const s = parseMemoryMarkdown(FULL);
    expect(s.work).toBe("用户参与 Tianshu 项目");
    expect(s.personal).toBe("用户位于福建厦门");
    expect(s.current).toBe("[2026-09-08] - UI 界面复刻");
    expect(s.recent).toBe(
      "[2026-09-08] - 推进 Tianshu 工作\n[2026-09-07] - 查询厦门天气",
    );
  });
  it("缺节为空串", () => {
    const s = parseMemoryMarkdown("## 个人背景\n厦门");
    expect(s.work).toBe("");
    expect(s.personal).toBe("厦门");
  });
  it("完全无标题 → 全部进 work", () => {
    expect(parseMemoryMarkdown("只是一段文本").work).toBe("只是一段文本");
  });
  it("未知标题行视为普通文本留在当前节", () => {
    const s = parseMemoryMarkdown("## 工作背景\na\n## 其他\nb");
    expect(s.work).toBe("a\n## 其他\nb");
  });
  it("空输入四节皆空", () => {
    expect(parseMemoryMarkdown("")).toEqual({
      work: "",
      personal: "",
      current: "",
      recent: "",
    });
  });
});

describe("buildMemoryMarkdown", () => {
  it("固定节序拼接、空节跳过", () => {
    expect(
      buildMemoryMarkdown({ work: "a", personal: "", current: "c", recent: "r" }),
    ).toBe("## 工作背景\na\n\n## 当前关注\nc\n\n## 近期动态\nr");
  });
});

describe("truncateMemoryMarkdown", () => {
  it("超限从头部截断保尾部", () => {
    const md = "a".repeat(100);
    expect(truncateMemoryMarkdown(md, 10)).toHaveLength(10);
    expect(truncateMemoryMarkdown(md, 10)).toBe(md.slice(90));
  });
  it("未超限原样返回", () => {
    expect(truncateMemoryMarkdown("abc", 10)).toBe("abc");
  });
  it("默认限长 MEMORY_PROFILE_LIMIT", () => {
    expect(MEMORY_PROFILE_LIMIT).toBe(8000);
    expect(
      truncateMemoryMarkdown("x".repeat(9000)).length,
    ).toBe(MEMORY_PROFILE_LIMIT);
  });
});

describe("sortRecentEntries", () => {
  it("按日期倒序、无日期行沉底且保序", () => {
    const text = ["无日期行", "[2026-09-07] - b", "[2026-09-08] - a"].join("\n");
    expect(sortRecentEntries(text)).toBe(
      "[2026-09-08] - a\n[2026-09-07] - b\n无日期行",
    );
  });
});

describe("mergeMemoryMarkdown", () => {
  it("三节追加、近期动态合并按日期倒序", () => {
    const merged = mergeMemoryMarkdown(FULL, "## 个人背景\n新条目\n\n## 近期动态\n[2026-09-09] - 新动态");
    expect(merged).toContain("用户位于福建厦门");
    expect(merged).toContain("新条目");
    expect(parseMemoryMarkdown(merged).recent.split("\n")[0]).toBe(
      "[2026-09-09] - 新动态",
    );
  });
  it("incoming 无标题 → 全部并入 work", () => {
    const merged = mergeMemoryMarkdown(FULL, "散装文本");
    expect(parseMemoryMarkdown(merged).work).toContain("散装文本");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/app-settings/memory-markdown.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src-react/domains/app-settings/model/memory-markdown.ts
/**
 * 记忆画像 markdown 解析/拼接/合并（spec §3.1）：存储格式 = AI 输出格式 =
 * 导入粘贴格式，前端展示切分与主进程解析共用本模块（electron 反向
 * import src-react，沿用 automation/api/schedule.schema.ts 模式）。
 * 四节固定标题精确匹配；未知 "## " 行视为普通文本；无任何标题 → 全进 work。
 */

/** 四节 key 与中文标题的映射（节顺序即输出顺序） */
export const MEMORY_SECTION_DEFS = [
  { key: "work", title: "工作背景" },
  { key: "personal", title: "个人背景" },
  { key: "current", title: "当前关注" },
  { key: "recent", title: "近期动态" },
] as const;

export type MemorySectionKey = (typeof MEMORY_SECTION_DEFS)[number]["key"];

export interface MemorySections {
  work: string;
  personal: string;
  current: string;
  recent: string;
}

export const MEMORY_PROFILE_LIMIT = 8000;

const EMPTY_SECTIONS: MemorySections = {
  work: "",
  personal: "",
  current: "",
  recent: "",
};

const TITLE_TO_KEY = new Map<string, MemorySectionKey>(
  MEMORY_SECTION_DEFS.map(({ key, title }) => [title, key]),
);

/** 剥离 ``` 代码块围栏（导入粘贴与 AI 输出都可能带围栏） */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/** 按四标题切分；缺节空串；无任何已知标题 → 全部进 work */
export function parseMemoryMarkdown(md: string): MemorySections {
  const sections: MemorySections = { ...EMPTY_SECTIONS };
  if (md.trim() === "") {
    return sections;
  }
  let current: MemorySectionKey | null = null;
  let fallbackOnly = true;
  const lines = md.split("\n");
  for (const line of lines) {
    const key = TITLE_TO_KEY.get(line.trim().replace(/^##\s*/, ""));
    if (key) {
      current = key;
      fallbackOnly = false;
      continue;
    }
    const target = current ?? "work";
    sections[target] =
      sections[target] === "" ? line : `${sections[target]}\n${line}`;
  }
  if (fallbackOnly && sections.work !== "") {
    return { ...EMPTY_SECTIONS, work: md.trim() };
  }
  // 去除各节首尾空行
  for (const { key } of MEMORY_SECTION_DEFS) {
    sections[key] = sections[key].replace(/^\n+|\n+$/g, "");
  }
  return sections;
}

/** 固定节序拼接；空节跳过 */
export function buildMemoryMarkdown(sections: MemorySections): string {
  return MEMORY_SECTION_DEFS.filter(({ key }) => sections[key].trim() !== "")
    .map(({ key, title }) => `## ${title}\n${sections[key].trim()}`)
    .join("\n\n");
}

/** 超限从头部截断（尾部为最新内容） */
export function truncateMemoryMarkdown(
  md: string,
  limit: number = MEMORY_PROFILE_LIMIT,
): string {
  return md.length > limit ? md.slice(md.length - limit) : md;
}

/** 近期动态节内排序：有日期条目倒序在前，无日期行沉底保序 */
export function sortRecentEntries(text: string): string {
  if (text.trim() === "") {
    return "";
  }
  const lines = text.split("\n");
  const dated = lines
    .filter((l) => /^\[\d{4}-\d{2}-\d{2}\]/.test(l.trim()))
    .sort((a, b) => b.localeCompare(a));
  const undated = lines.filter(
    (l) => !/^\[\d{4}-\d{2}-\d{2}\]/.test(l.trim()),
  );
  return [...dated, ...undated].join("\n");
}

/** 导入合并（spec §6.4）：三节文本追加、近期动态合并重排 */
export function mergeMemoryMarkdown(
  current: string,
  incoming: string,
): string {
  const cur = parseMemoryMarkdown(current);
  const inc = parseMemoryMarkdown(incoming);
  const appendText = (a: string, b: string): string =>
    [a.trim(), b.trim()].filter((s) => s !== "").join("\n");
  return truncateMemoryMarkdown(
    buildMemoryMarkdown({
      work: appendText(cur.work, inc.work),
      personal: appendText(cur.personal, inc.personal),
      current: appendText(cur.current, inc.current),
      recent: sortRecentEntries(appendText(cur.recent, inc.recent)),
    }),
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/app-settings/memory-markdown.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/app-settings/model/memory-markdown.ts tests/app-settings/memory-markdown.test.ts
git commit -m "feat(memory): 记忆 markdown 共享解析器（切分/拼接/截断/合并）"
```

---

### Task 2: option key 扩展 + system prompt 注入【用户画像记忆】

**Files:**
- Modify: `electron/domains/ai/personalization/personalization.config.ts`
- Modify: `electron/domains/ai/personalization/personalization.prompt.ts:69-72`（【用户长期记忆】段之后插入新段）
- Test: `tests/ai/personalization-repo.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `PERSONALIZATION_KEYS` / `fromAppOptions` / `buildPersonalizedSystem`。
- Produces:
  - `PERSONALIZATION_KEYS` 新增 `memoryProfile: "personalization.memoryProfile"`、`memoryEnabled: "personalization.memoryEnabled"`、`memoryLastCompiledAt: "personalization.memoryLastCompiledAt"`
  - `PERSONALIZATION_LIMITS.memoryProfile = 8000`
  - `PersonalizationConfig` 新增 `memoryProfile: string`（默认 ""）、`memoryEnabled: boolean`（默认 true）、`memoryLastCompiledAt: string`（默认 ""）
  - `buildPersonalizedSystem` 输出含 `【用户画像记忆】` 段（memoryProfile 非空时）

- [ ] **Step 1: 写失败测试（追加到 tests/ai/personalization-repo.test.ts）**

```ts
describe("记忆画像字段（memory-evolution spec §3）", () => {
  it("默认值：memoryProfile 空、memoryEnabled true、lastCompiledAt 空", () => {
    const config = fromAppOptions([]);
    expect(config.memoryProfile).toBe("");
    expect(config.memoryEnabled).toBe(true);
    expect(config.memoryLastCompiledAt).toBe("");
  });

  it("option 行解析三字段并截断 memoryProfile", () => {
    const long = "x".repeat(9000);
    const config = fromAppOptions([
      { name: "personalization.memoryProfile", value: long },
      { name: "personalization.memoryEnabled", value: "false" },
      { name: "personalization.memoryLastCompiledAt", value: "2026-09-08T18:00:00.000Z" },
    ]);
    expect(config.memoryProfile).toHaveLength(8000);
    expect(config.memoryEnabled).toBe(false);
    expect(config.memoryLastCompiledAt).toBe("2026-09-08T18:00:00.000Z");
  });

  it("buildPersonalizedSystem 注入【用户画像记忆】段且位于长期记忆与自定义指令之间", () => {
    const config = {
      ...defaultPersonalization(),
      memory: "手动记忆",
      memoryProfile: "## 工作背景\n画像",
      customInstructions: "规则",
    };
    const system = buildPersonalizedSystem(config, "base");
    const idxMemory = system!.indexOf("【用户长期记忆】");
    const idxProfile = system!.indexOf("【用户画像记忆】");
    const idxInstr = system!.indexOf("【用户自定义指令】");
    expect(idxProfile).toBeGreaterThan(0);
    expect(idxMemory).toBeLessThan(idxProfile);
    expect(idxProfile).toBeLessThan(idxInstr);
    expect(system).toContain("以下是系统从对话中提炼的用户画像，请在对话中参考：");
  });

  it("memoryProfile 空 → 不注入画像段（D8 线级行为不回归）", () => {
    const system = buildPersonalizedSystem(defaultPersonalization(), "base");
    expect(system).not.toContain("【用户画像记忆】");
  });
});
```

（文件顶部按需补 import：`fromAppOptions`、`defaultPersonalization` 来自 `electron/domains/ai/personalization/personalization.config`，`buildPersonalizedSystem` 来自 `personalization.prompt`——先读该测试文件确认既有 import 再追加。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/personalization-repo.test.ts`
Expected: FAIL（`memoryProfile` 属性不存在）

- [ ] **Step 3: 实现 config 扩展**

`personalization.config.ts` 三处修改：

```ts
// PERSONALIZATION_KEYS 追加
  memoryProfile: "personalization.memoryProfile",
  memoryEnabled: "personalization.memoryEnabled",
  memoryLastCompiledAt: "personalization.memoryLastCompiledAt",

// PERSONALIZATION_LIMITS 追加
  memoryProfile: 8000,

// PersonalizationConfig 接口追加
  memoryProfile: string;
  memoryEnabled: boolean;
  memoryLastCompiledAt: string;

// defaultPersonalization() 返回值追加
    memoryProfile: "",
    memoryEnabled: true,
    memoryLastCompiledAt: "",

// fromAppOptions() 返回值追加
    memoryProfile: textValue(
      map,
      keys.memoryProfile,
      limit.memoryProfile,
      "",
    ),
    memoryEnabled: parseBoolOption(
      map.get(keys.memoryEnabled),
      defaultPersonalization().memoryEnabled,
    ),
    memoryLastCompiledAt: textValue(
      map,
      keys.memoryLastCompiledAt,
      40,
      "",
    ),
```

- [ ] **Step 4: 实现 prompt 注入**

`personalization.prompt.ts` 的 `personalSegments` 中，紧跟【用户长期记忆】`if` 块之后插入：

```ts
  if (config.memoryProfile.trim() !== "") {
    segments.push(
      `【用户画像记忆】\n以下是系统从对话中提炼的用户画像，请在对话中参考：\n${config.memoryProfile}`,
    );
  }
```

- [ ] **Step 5: 运行确认通过 + 全量回归**

Run: `npx vitest run tests/ai/personalization-repo.test.ts && npm run test`
Expected: PASS（含既有 D8 线级用例不回归）

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/personalization/personalization.config.ts electron/domains/ai/personalization/personalization.prompt.ts tests/ai/personalization-repo.test.ts
git commit -m "feat(memory): option 三 key 扩展与 system prompt 注入用户画像记忆段"
```

---

### Task 3: memory-compiler（AI 管线，可注入）

**Files:**
- Create: `electron/domains/ai/personalization/memory-compiler.ts`
- Test: `tests/ai/memory-compiler.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `stripCodeFence`/`truncateMemoryMarkdown`；Task 2 的 `loadPersonalization`；`createLanguageModel`（`provider/provider-factory`）、`ProviderRepository.getRuntimeInfo`、`parseBlocks`（`chat/blocks`）、`setAppOption`/`getAppOptionMap`（`app-settings/option-store`）、`prisma`。
- Produces（Task 4/5 依赖）:
  - `type ModelTextFn = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>`
  - `const MEMORY_COMPILER_SYSTEM_PROMPT: string`
  - `function buildCompileUserPrompt(currentMemory: string, material: string): string`
  - `function buildInstructionUserPrompt(currentMemory: string, instruction: string): string`
  - `function validateMemoryOutput(raw: string): string | null`
  - `function fetchRecentConversation(prismaLike: ConversationPrismaLike, days?: number, charLimit?: number): Promise<string>`
  - `function resolveMemoryModel(providerRepo: ProviderRuntimeSource): Promise<MemoryModelContext | null>`
  - `async function compileMemory(opts: CompileMemoryOptions): Promise<string>`
  - `interface MemoryModelContext { type: string; baseUrl: string; apiKey?: string; extraHeaders?: string | null; modelId: string }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/memory-compiler.test.ts
import { describe, expect, it } from "vitest";

import {
  MEMORY_COMPILER_SYSTEM_PROMPT,
  buildCompileUserPrompt,
  buildInstructionUserPrompt,
  fetchRecentConversation,
  validateMemoryOutput,
} from "../../electron/domains/ai/personalization/memory-compiler";

describe("prompt 构建", () => {
  it("系统提示词含四标题与硬性约束", () => {
    for (const title of ["工作背景", "个人背景", "当前关注", "近期动态"]) {
      expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain(title);
    }
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("只输出");
  });
  it("整理 prompt 含当前记忆与材料", () => {
    const p = buildCompileUserPrompt("当前记忆", "对话材料");
    expect(p).toContain("当前记忆");
    expect(p).toContain("对话材料");
  });
  it("指令 prompt 含当前记忆与用户指令", () => {
    const p = buildInstructionUserPrompt("当前记忆", "删掉天气");
    expect(p).toContain("当前记忆");
    expect(p).toContain("删掉天气");
  });
});

describe("validateMemoryOutput", () => {
  it("剥围栏 + 截断后返回", () => {
    const raw = "```\n## 工作背景\nabc\n```";
    expect(validateMemoryOutput(raw)).toBe("## 工作背景\nabc");
  });
  it("无任何已知标题 → null（彻底失败）", () => {
    expect(validateMemoryOutput("我无法完成这个任务")).toBeNull();
    expect(validateMemoryOutput("")).toBeNull();
  });
});

describe("fetchRecentConversation", () => {
  const mkRow = (id: number, role: string, text: string) => ({
    id,
    role,
    blocks: JSON.stringify([{ type: "text", text }]),
  });
  it("拼接 用户/助手 前缀，跳过空文本与非文本块", async () => {
    const prismaLike = {
      message: {
        findMany: async () => [
          mkRow(1, "user", "你好"),
          { id: 2, role: "assistant", blocks: JSON.stringify([{ type: "usage", input: 1, output: 2 }]) },
          mkRow(3, "assistant", "在的"),
        ],
      },
    };
    const text = await fetchRecentConversation(
      prismaLike as never,
      7,
      30000,
    );
    expect(text).toBe("用户：你好\n助手：在的");
  });
  it("超 charLimit 保最新（丢弃最旧）", async () => {
    const rows = [
      mkRow(1, "user", "旧".repeat(100)),
      mkRow(2, "user", "新内容"),
    ];
    const prismaLike = { message: { findMany: async () => rows } };
    const text = await fetchRecentConversation(prismaLike as never, 7, 10);
    expect(text).toContain("新内容");
    expect(text).not.toContain("旧");
  });
  it("无消息返回空串", async () => {
    const prismaLike = { message: { findMany: async () => [] } };
    expect(await fetchRecentConversation(prismaLike as never, 7, 30000)).toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/memory-compiler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/personalization/memory-compiler.ts
/**
 * 记忆 AI 管线（spec §5.3）：读近期对话/用户指令 → 调默认模型 →
 * 输出新记忆 markdown。模型调用经 ModelTextFn 注入（测试覆写，
 * 参考 chat.service titleModelText 模式）。无可用模型/无对话材料时
 * 由调用方（scheduler/service）决策跳过。
 */
import { generateText } from "ai";

import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { parseBlocks } from "../chat/blocks";
import { createLanguageModel } from "../provider/provider-factory";
import type { ProviderRepository } from "../provider/provider.repo";
import {
  MEMORY_PROFILE_LIMIT,
  stripCodeFence,
  truncateMemoryMarkdown,
} from "../../../../src-react/domains/app-settings/model/memory-markdown";

export interface MemoryModelContext {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
  modelId: string;
}

export type ModelTextFn = (
  system: string,
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

export const MEMORY_COMPILER_SYSTEM_PROMPT = [
  "你是记忆管理器。给定当前记忆与新材料（近期对话或用户指令），输出完整的新记忆 markdown。",
  "硬性要求：",
  "1. 分类标题固定为四节且顺序为：## 工作背景、## 个人背景、## 当前关注、## 近期动态；",
  "2. 条目每行一条，格式 [YYYY-MM-DD] - 条目内容，日期未知可省略；",
  "3. 近期动态最多 20 条，按日期倒序（新的在上）；",
  "4. 单条不超过 500 字；总长不超过 8000 字；",
  "5. 保留仍然有效的旧记忆，合并去重，删除过时条目；用户指令只影响指令提到的内容；",
  "6. 只输出 markdown 本体，不要解释，不要代码块围栏。",
].join("\n");

export function buildCompileUserPrompt(
  currentMemory: string,
  material: string,
): string {
  return `当前记忆：\n${currentMemory || "（空）"}\n\n近期对话材料：\n${material}`;
}

export function buildInstructionUserPrompt(
  currentMemory: string,
  instruction: string,
): string {
  return `当前记忆：\n${currentMemory || "（空）"}\n\n用户指令（应用增删改后输出完整新记忆）：\n${instruction}`;
}

/** 校验 AI 输出：剥围栏、截断；无任何四标题 → null */
export function validateMemoryOutput(raw: string): string | null {
  const text = stripCodeFence(raw ?? "");
  if (
    text === "" ||
    !["工作背景", "个人背景", "当前关注", "近期动态"].some((t) =>
      text.includes(`## ${t}`),
    )
  ) {
    return null;
  }
  return truncateMemoryMarkdown(text, MEMORY_PROFILE_LIMIT);
}

/** prisma.message 最小查询面（测试注入用） */
export interface ConversationPrismaLike {
  message: {
    findMany: (args: unknown) => Promise<
      Array<{ id: number; role: string; blocks: string }>
    >;
  };
}

function rowToLine(row: { role: string; blocks: string }): string {
  const text = parseBlocks(row.blocks)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (text === "") {
    return "";
  }
  return `${row.role === "user" ? "用户" : "助手"}：${text}`;
}

/** 近 7 天 user/assistant 消息 → "用户：…\n助手：…" 文本；保最新 charLimit 字符 */
export async function fetchRecentConversation(
  prismaLike: ConversationPrismaLike,
  days: number = 7,
  charLimit: number = 30000,
): Promise<string> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prismaLike.message.findMany({
    where: {
      role: { in: ["user", "assistant"] },
      createdAt: { gte: cutoff },
      session: { archivedAt: null },
    },
    orderBy: { id: "asc" },
  });
  const lines = rows.map(rowToLine).filter((l) => l !== "");
  let kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > charLimit) {
      break;
    }
    kept.unshift(lines[i]);
    size += lines[i].length;
  }
  return kept.join("\n");
}

/** 默认模型解析：workspace.defaultModelId 优先，回退任意启用模型 */
export async function resolveMemoryModel(
  providerRepo: ProviderRepository,
  modelRepo: { getById(id: number): Promise<{ id: number; providerId: number; modelId: string; enabled: boolean } | null> },
  listModels: () => Promise<Array<{ id: number; providerId: number; modelId: string; enabled: boolean }>>,
): Promise<MemoryModelContext | null> {
  const workspaces = await prisma.workspace.findMany({
    orderBy: { id: "asc" },
    select: { defaultModelId: true },
  });
  const candidates = [
    ...workspaces
      .map((w) => w.defaultModelId)
      .filter((id): id is number => id !== null),
    ...(await listModels())
      .filter((m) => m.enabled)
      .map((m) => m.id),
  ];
  for (const modelId of candidates) {
    const model = await modelRepo.getById(modelId);
    if (!model || !model.enabled) {
      continue;
    }
    const provider = await providerRepo.getRuntimeInfo(model.providerId);
    if (provider) {
      return { ...provider, modelId: model.modelId };
    }
  }
  return null;
}

/** 真实模型调用（默认 ModelTextFn） */
async function defaultModelText(
  system: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  // model 上下文由 compileMemory 闭包注入；见下方 compileMemory 组装
  throw new Error("UNBOUND");
}

export interface CompileMemoryOptions {
  currentMemory: string;
  material: string;
  instructionMode: boolean;
  model: MemoryModelContext;
  modelText?: ModelTextFn;
  signal?: AbortSignal;
}

/** 执行一次记忆整理/指令应用；失败 throw，输出非法 throw */
export async function compileMemory(
  opts: CompileMemoryOptions,
): Promise<string> {
  const modelText: ModelTextFn =
    opts.modelText ??
    (async (system, prompt, signal) => {
      const result = await generateText({
        model: createLanguageModel(opts.model, opts.model.modelId),
        system,
        prompt,
        abortSignal: signal,
      });
      return result.text;
    });
  const prompt = opts.instructionMode
    ? buildInstructionUserPrompt(opts.currentMemory, opts.material)
    : buildCompileUserPrompt(opts.currentMemory, opts.material);
  const raw = await modelText(MEMORY_COMPILER_SYSTEM_PROMPT, prompt, opts.signal);
  const validated = validateMemoryOutput(raw);
  if (validated === null) {
    Log.warn("记忆整理输出无法解析", raw.slice(0, 200));
    throw new Error("MEMORY_COMPILE_FAILED");
  }
  return validated;
}
```

（实现时删去 `defaultModelText` 占位函数——`compileMemory` 内联的默认闭包即真实实现；上面两段合一即可。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ai/memory-compiler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/personalization/memory-compiler.ts tests/ai/memory-compiler.test.ts
git commit -m "feat(memory): AI 记忆整理管线（对话提取/模型解析/输出校验，可注入）"
```

---

### Task 4: memory-scheduler（定时 + 启动补跑）

**Files:**
- Create: `electron/domains/ai/personalization/memory-scheduler.ts`
- Modify: `electron/Application.ts`（`private scheduler` 附近加成员 + start/stop 接线）
- Test: `tests/ai/memory-scheduler.test.ts`

**Interfaces:**
- Consumes: Task 3 `compileMemory`/`fetchRecentConversation`/`resolveMemoryModel`；Task 2 config keys；`option-store` 的 `getAppOptionMap`/`setAppOption`。
- Produces:
  - `interface MemoryTickState { enabled: boolean; inflight: boolean; lastCompiledAt: string; catchUpPending: boolean }`
  - `type MemoryTickDecision = "compile" | "catchUp" | "noop"`
  - `function decideMemoryTick(state: MemoryTickState, now: Date): MemoryTickDecision`
  - `default class MemoryScheduler`（`start()` / `stop()`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/memory-scheduler.test.ts
import { describe, expect, it } from "vitest";

import { decideMemoryTick } from "../../electron/domains/ai/personalization/memory-scheduler";

const base = {
  enabled: true,
  inflight: false,
  lastCompiledAt: "",
  catchUpPending: false,
};

const at = (h: number, m = 0): Date => new Date(2026, 8, 9, h, m);

describe("decideMemoryTick（spec §5.2）", () => {
  it("窗口内且当日未整理 → compile", () => {
    expect(decideMemoryTick({ ...base }, at(2, 30))).toBe("compile");
    expect(decideMemoryTick({ ...base }, at(3, 59))).toBe("compile");
  });
  it("窗口外 → noop", () => {
    expect(decideMemoryTick({ ...base }, at(1, 59))).toBe("noop");
    expect(decideMemoryTick({ ...base }, at(4, 0))).toBe("noop");
  });
  it("当日已整理 → noop", () => {
    const today = at(12).toISOString();
    expect(
      decideMemoryTick({ ...base, lastCompiledAt: today }, at(2, 30)),
    ).toBe("noop");
  });
  it("昨日整理 → 窗口内 compile", () => {
    const yesterday = new Date(2026, 8, 8, 3).toISOString();
    expect(
      decideMemoryTick({ ...base, lastCompiledAt: yesterday }, at(2, 30)),
    ).toBe("compile");
  });
  it("开关关 / 在途 → noop", () => {
    expect(decideMemoryTick({ ...base, enabled: false }, at(2, 30))).toBe("noop");
    expect(decideMemoryTick({ ...base, inflight: true }, at(2, 30))).toBe("noop");
  });
  it("补跑标志 + 从未整理 → catchUp", () => {
    expect(
      decideMemoryTick({ ...base, catchUpPending: true }, at(10)),
    ).toBe("catchUp");
  });
  it("补跑标志 + 距上次 <24h → noop", () => {
    const recent = new Date(at(10).getTime() - 12 * 3600 * 1000).toISOString();
    expect(
      decideMemoryTick({ ...base, catchUpPending: true, lastCompiledAt: recent }, at(10)),
    ).toBe("noop");
  });
  it("补跑标志 + 距上次 >24h → catchUp", () => {
    const old = new Date(at(10).getTime() - 25 * 3600 * 1000).toISOString();
    expect(
      decideMemoryTick({ ...base, catchUpPending: true, lastCompiledAt: old }, at(10)),
    ).toBe("catchUp");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/memory-scheduler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/personalization/memory-scheduler.ts
/**
 * 记忆定时器（spec §5.2）：30s tick 决策 + 启动补跑（>24h 延迟 90s）。
 * 进程级 inflight 互斥（与手动触发共享）；失败静默记日志等下一轮。
 */
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { getAppOptionMap, setAppOption } from "../../app-settings/option-store";
import {
  compileMemory,
  fetchRecentConversation,
  resolveMemoryModel,
} from "./memory-compiler";
import { loadPersonalization } from "./personalization.repo";
import { ProviderRepository } from "../provider/provider.repo";
import { ModelRepository } from "../provider/model.repo";

const TICK_MS = 30_000;
const CATCHUP_DELAY_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryTickState {
  enabled: boolean;
  inflight: boolean;
  lastCompiledAt: string;
  catchUpPending: boolean;
}

export type MemoryTickDecision = "compile" | "catchUp" | "noop";

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 决策纯函数（注入时钟可测） */
export function decideMemoryTick(
  state: MemoryTickState,
  now: Date,
): MemoryTickDecision {
  if (!state.enabled || state.inflight) {
    return "noop";
  }
  if (state.catchUpPending) {
    const last = state.lastCompiledAt ? new Date(state.lastCompiledAt) : null;
    const overdue = last === null || now.getTime() - last.getTime() > DAY_MS;
    return overdue ? "catchUp" : "noop";
  }
  const hour = now.getHours();
  if (hour < 2 || hour >= 4) {
    return "noop";
  }
  const last = state.lastCompiledAt ? new Date(state.lastCompiledAt) : null;
  return last && isSameLocalDay(last, now) ? "noop" : "compile";
}

export default class MemoryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private catchUpTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private catchUpPending = true;

  constructor(private deps?: { tickMs?: number }) {}

  start(): void {
    this.catchUpTimer = setTimeout(
      () => void this.tick(),
      CATCHUP_DELAY_MS,
    );
    this.timer = setInterval(
      () => void this.tick(),
      this.deps?.tickMs ?? TICK_MS,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
    }
    this.abort?.abort();
  }

  private async loadState(): Promise<MemoryTickState> {
    const config = await loadPersonalization();
    return {
      enabled: config.memoryEnabled,
      inflight: this.abort !== null,
      lastCompiledAt: config.memoryLastCompiledAt,
      catchUpPending: this.catchUpPending,
    };
  }

  private async tick(): Promise<void> {
    try {
      const state = await this.loadState();
      const decision = decideMemoryTick(state, new Date());
      if (decision === "noop") {
        return;
      }
      await this.run();
    } catch (error) {
      Log.warn("记忆定时 tick 异常", error);
    }
  }

  /** 执行一次整理（inflight 互斥；补跑标志消费后不复位） */
  private async run(): Promise<void> {
    if (this.abort) {
      return;
    }
    this.catchUpPending = false;
    this.abort = new AbortController();
    try {
      const config = await loadPersonalization();
      const material = await fetchRecentConversation(prisma);
      if (material === "") {
        return; // 无对话材料直接跳过（spec §5.3）
      }
      const model = await resolveMemoryModel(
        new ProviderRepository(),
        new ModelRepository(new ProviderRepository()),
        () => new ModelRepository(new ProviderRepository()).listAll(),
      );
      if (!model) {
        return; // 无可用模型静默跳过
      }
      const memory = await compileMemory({
        currentMemory: config.memoryProfile,
        material,
        instructionMode: false,
        model,
        signal: this.abort.signal,
      });
      await setAppOption(prisma.option, "personalization.memoryProfile", memory);
      await setAppOption(
        prisma.option,
        "personalization.memoryLastCompiledAt",
        new Date().toISOString(),
      );
    } catch (error) {
      Log.warn("记忆整理失败（等待下一轮）", error);
    } finally {
      this.abort = null;
    }
  }
}
```

（`setAppOption`/`getAppOptionMap` 的真实签名以 `electron/domains/app-settings/option-store.ts` 为准，接线前先读该文件——`settings.service.ts` 中已有 `setAppOption(this.db, name, value)` 用法可对照。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ai/memory-scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Application 接线**

`electron/Application.ts`：import `MemoryScheduler`；`private scheduler` 声明附近加 `private memoryScheduler = new MemoryScheduler();`；`this.scheduler.start()` 之后加 `this.memoryScheduler.start();`；`this.scheduler.stop()` 之后加 `this.memoryScheduler.stop();`。

- [ ] **Step 6: typecheck + Commit**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add electron/domains/ai/personalization/memory-scheduler.ts electron/Application.ts tests/ai/memory-scheduler.test.ts
git commit -m "feat(memory): 每晚定时整理与启动补跑调度器（30s tick 决策 + inflight 互斥）"
```

---

### Task 5: memory.service IPC + 前端 API

**Files:**
- Create: `electron/domains/ai/personalization/memory.service.ts`
- Modify: `electron/Application.ts`（注册 service，与 scheduler 同区）
- Create: `src-react/domains/app-settings/api/memory.api.ts`
- Test: `tests/ai/memory-service.test.ts`

**Interfaces:**
- Consumes: Task 3 全部；`option-store`。
- Produces（Task 8 依赖）:
  - IPC `personalization:applyMemoryInstruction (instruction: string) => MemoryServiceResult`
  - IPC `personalization:compileMemory () => MemoryServiceResult`
  - `interface MemoryServiceResult { ok: boolean; memory?: string; error?: "MEMORY_DISABLED" | "MEMORY_MODEL_MISSING" | "MEMORY_COMPILE_FAILED" | "MEMORY_NO_MATERIAL" }`
  - 前端 `MemoryApi.applyInstruction(instruction)` / `MemoryApi.compileNow()`（错误码原样透传，渲染层映射 i18n）

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/memory-service.test.ts
import { describe, expect, it, vi } from "vitest";

import { createMemoryHandlers } from "../../electron/domains/ai/personalization/memory.service";

function mkHandlers(overrides: {
  enabled?: boolean;
  model?: object | null;
  material?: string;
  compiled?: string;
}) {
  return createMemoryHandlers({
    loadConfig: async () => ({
      memoryEnabled: overrides.enabled ?? true,
      memoryProfile: "",
      memoryLastCompiledAt: "",
    }),
    fetchMaterial: async () => overrides.material ?? "对话材料",
    resolveModel: async () => (overrides.model === undefined
      ? { type: "openai-compatible", baseUrl: "http://x", modelId: "m1" }
      : overrides.model) as never,
    compile: async () => overrides.compiled ?? "## 工作背景\n新记忆",
    save: async () => {},
  });
}

describe("applyMemoryInstruction", () => {
  it("成功返回新记忆", async () => {
    const h = mkHandlers({});
    const result = await h.applyInstruction("记住我在厦门");
    expect(result).toEqual({ ok: true, memory: "## 工作背景\n新记忆" });
  });
  it("开关关 → MEMORY_DISABLED", async () => {
    const h = mkHandlers({ enabled: false });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_DISABLED",
    });
  });
  it("无模型 → MEMORY_MODEL_MISSING", async () => {
    const h = mkHandlers({ model: null });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_MODEL_MISSING",
    });
  });
  it("编译输出非法 → MEMORY_COMPILE_FAILED 且不落库", async () => {
    const save = vi.fn(async () => {});
    const h = createMemoryHandlers({
      loadConfig: async () => ({ memoryEnabled: true, memoryProfile: "", memoryLastCompiledAt: "" }),
      fetchMaterial: async () => "m",
      resolveModel: async () => ({ type: "x", baseUrl: "y", modelId: "z" }) as never,
      compile: async () => "完全不是记忆格式",
      save,
    });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_COMPILE_FAILED",
    });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("compileMemory", () => {
  it("无对话材料 → MEMORY_NO_MATERIAL 不报错", async () => {
    const h = mkHandlers({ material: "" });
    expect(await h.compileNow()).toEqual({
      ok: false,
      error: "MEMORY_NO_MATERIAL",
    });
  });
  it("成功写 LastCompiledAt", async () => {
    const saved: string[] = [];
    const h = createMemoryHandlers({
      loadConfig: async () => ({ memoryEnabled: true, memoryProfile: "", memoryLastCompiledAt: "" }),
      fetchMaterial: async () => "材料",
      resolveModel: async () => ({ type: "x", baseUrl: "y", modelId: "z" }) as never,
      compile: async () => "## 近期动态\n[2026-09-09] - a",
      save: async (name: string) => void saved.push(name),
    });
    expect((await h.compileNow()).ok).toBe(true);
    expect(saved).toContain("personalization.memoryProfile");
    expect(saved).toContain("personalization.memoryLastCompiledAt");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/memory-service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/personalization/memory.service.ts
/**
 * 记忆 IPC 服务（spec §4）：编辑指令应用 + 手动整理触发。
 * 错误以错误码返回（不 throw 到渲染端），渲染层映射 i18n。
 * 依赖全部注入（createMemoryHandlers 纯逻辑可测），MemoryService
 * 仅做 IPC 注册与生产依赖组装。
 */
import { ipcMain } from "electron";

import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { setAppOption } from "../../app-settings/option-store";
import {
  compileMemory,
  fetchRecentConversation,
  resolveMemoryModel,
  type MemoryModelContext,
} from "./memory-compiler";
import { loadPersonalization } from "./personalization.repo";
import { PERSONALIZATION_KEYS } from "./personalization.config";
import { ProviderRepository } from "../provider/provider.repo";
import { ModelRepository } from "../provider/model.repo";

export interface MemoryServiceResult {
  ok: boolean;
  memory?: string;
  error?:
    | "MEMORY_DISABLED"
    | "MEMORY_MODEL_MISSING"
    | "MEMORY_COMPILE_FAILED"
    | "MEMORY_NO_MATERIAL";
}

export interface MemoryHandlerDeps {
  loadConfig: () => Promise<{
    memoryEnabled: boolean;
    memoryProfile: string;
    memoryLastCompiledAt: string;
  }>;
  fetchMaterial: () => Promise<string>;
  resolveModel: () => Promise<MemoryModelContext | null>;
  compile: (currentMemory: string, material: string, instructionMode: boolean) => Promise<string>;
  save: (name: string, value: string) => Promise<void>;
}

export function createMemoryHandlers(deps: MemoryHandlerDeps) {
  const run = async (
    material: string,
    instructionMode: boolean,
  ): Promise<MemoryServiceResult> => {
    const config = await deps.loadConfig();
    if (!config.memoryEnabled) {
      return { ok: false, error: "MEMORY_DISABLED" };
    }
    if (!instructionMode && material === "") {
      return { ok: false, error: "MEMORY_NO_MATERIAL" };
    }
    const model = await deps.resolveModel();
    if (!model) {
      return { ok: false, error: "MEMORY_MODEL_MISSING" };
    }
    let memory: string;
    try {
      memory = await deps.compile(config.memoryProfile, material, instructionMode);
    } catch {
      return { ok: false, error: "MEMORY_COMPILE_FAILED" };
    }
    await deps.save(PERSONALIZATION_KEYS.memoryProfile, memory);
    if (!instructionMode) {
      await deps.save(PERSONALIZATION_KEYS.memoryLastCompiledAt, new Date().toISOString());
    }
    return { ok: true, memory };
  };
  return {
    applyInstruction: (instruction: string) => run(instruction, true),
    compileNow: () => run(await deps.fetchMaterial(), false),
  };
}

/** 生产依赖组装 + IPC 注册 */
export class MemoryService {
  registerIpc(): void {
    const handlers = createMemoryHandlers({
      loadConfig: () => loadPersonalization(),
      fetchMaterial: () => fetchRecentConversation(prisma),
      resolveModel: async () => {
        const providerRepo = new ProviderRepository();
        const modelRepo = new ModelRepository(providerRepo);
        return resolveMemoryModel(providerRepo, modelRepo, () => modelRepo.listAll());
      },
      compile: (currentMemory, material, instructionMode) => {
        // 模型解析一次即可；compileMemory 内部 createLanguageModel
        return resolveAndCompile(currentMemory, material, instructionMode);
      },
      save: (name, value) => setAppOption(prisma.option, name, value),
    });
    ipcMain.handle(
      "personalization:applyMemoryInstruction",
      (_, instruction: string) => handlers.applyInstruction(instruction),
    );
    ipcMain.handle("personalization:compileMemory", () => handlers.compileNow());
  }
}

/** 生产 compile：解析模型后调用 compileMemory（失败抛出由 createMemoryHandlers 捕获） */
async function resolveAndCompile(
  currentMemory: string,
  material: string,
  instructionMode: boolean,
): Promise<string> {
  const providerRepo = new ProviderRepository();
  const modelRepo = new ModelRepository(providerRepo);
  const model = await resolveMemoryModel(
    providerRepo,
    modelRepo,
    () => modelRepo.listAll(),
  );
  if (!model) {
    throw new Error("MEMORY_MODEL_MISSING");
  }
  return compileMemory({ currentMemory, material, instructionMode, model });
}

// 避免 Log 未使用的 lint 报错：注册失败记日志
Log.debug?.("memory service module loaded");
```

（实现时移除末尾 `Log.debug` 行——仅当 lint 报 unused 时才需要；正常应直接删掉该行与 Log import。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ai/memory-service.test.ts`
Expected: PASS

注意：`compileNow` 里 `run(await deps.fetchMaterial(), false)` 是顶层 await 混在非 async 箭头——实现时把 `compileNow` 写成 `async () => { const material = await deps.fetchMaterial(); return run(material, false); }`。

- [ ] **Step 5: 前端 API + Application 注册**

```ts
// src-react/domains/app-settings/api/memory.api.ts
/**
 * 记忆 AI 操作 API：错误码透传，渲染层映射 i18n 文案。
 */
import { invoke } from "@/lib/ipc";

export type MemoryErrorCode =
  | "MEMORY_DISABLED"
  | "MEMORY_MODEL_MISSING"
  | "MEMORY_COMPILE_FAILED"
  | "MEMORY_NO_MATERIAL";

export interface MemoryServiceResult {
  ok: boolean;
  memory?: string;
  error?: MemoryErrorCode;
}

export class MemoryApi {
  /** 编辑态 AI 指令：返回应用后的新记忆 markdown（已落库） */
  static async applyInstruction(instruction: string): Promise<MemoryServiceResult> {
    return invoke<MemoryServiceResult>(
      "personalization:applyMemoryInstruction",
      instruction,
    );
  }

  /** 手动触发一次整理（调试/补跑入口） */
  static async compileNow(): Promise<MemoryServiceResult> {
    return invoke<MemoryServiceResult>("personalization:compileMemory");
  }
}
```

`electron/Application.ts`：import `MemoryService`，成员区加 `private memoryService = new MemoryService();`，在 `registerIpc` 类初始化区（对照 SettingsService 的注册位置，先读 Application.ts 找到既有 service 注册处）调用 `this.memoryService.registerIpc();`。

- [ ] **Step 6: typecheck + Commit**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add electron/domains/ai/personalization/memory.service.ts electron/Application.ts src-react/domains/app-settings/api/memory.api.ts tests/ai/memory-service.test.ts
git commit -m "feat(memory): 记忆 IPC 服务（指令应用/手动整理）与前端 API"
```

---

### Task 6: i18n 文案与导入提示词

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/settings.json`
- Modify: `src-react/i18n/locales/en-US/settings.json`
- Create: `src-react/domains/app-settings/model/import-prompt.ts`
- Test: `tests/app-settings/memory-i18n.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（Task 7–9 依赖）: `settings:memory.*` 全部 key；`getImportPrompt(locale: "zh-CN" | "en-US"): string`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/app-settings/memory-i18n.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getImportPrompt } from "../../src-react/domains/app-settings/model/import-prompt";

const zh = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../src-react/i18n/locales/zh-CN/settings.json"),
    "utf8",
  ),
);
const en = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../src-react/i18n/locales/en-US/settings.json"),
    "utf8",
  ),
);

function flatKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) {
    return [prefix];
  }
  return Object.entries(obj).flatMap(([k, v]) => flatKeys(v, `${prefix}${k}.`));
}

describe("memory i18n（zh/en key 对齐）", () => {
  it("zh memory 子树与 en memory 子树 key 完全一致", () => {
    expect(flatKeys(en.memory).sort()).toEqual(flatKeys(zh.memory).sort());
  });
  it("存在关键 key", () => {
    for (const key of [
      "title",
      "description",
      "toggle.label",
      "toggle.desc",
      "manage.title",
      "manage.subtitle",
      "sections.work",
      "sections.personal",
      "sections.current",
      "sections.recent",
      "edit.save",
      "edit.cancel",
      "resetDialog.title",
      "resetDialog.confirm",
      "importDialog.title",
      "importDialog.step1.title",
      "importDialog.step2.title",
      "empty.title",
      "empty.enable",
      "toast.reset",
      "toast.imported",
      "toast.importFallback",
      "toast.instructionFailed",
      "disabledNotice",
      "error.MEMORY_DISABLED",
      "error.MEMORY_MODEL_MISSING",
      "error.MEMORY_COMPILE_FAILED",
      "error.MEMORY_NO_MATERIAL",
    ]) {
      expect(flatKeys(zh.memory)).toContain(`${key}.`);
    }
  });
});

describe("导入提示词", () => {
  it("zh 提示词含四分类标题与日期格式", () => {
    const p = getImportPrompt("zh-CN");
    for (const t of ["工作背景", "个人背景", "当前关注", "近期动态"]) {
      expect(p).toContain(t);
    }
    expect(p).toContain("[YYYY-MM-DD]");
  });
  it("en 提示词存在且非空", () => {
    expect(getImportPrompt("en-US").length).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/app-settings/memory-i18n.test.ts`
Expected: FAIL（`memory` 子树不存在）

- [ ] **Step 3: 实现 locale 与提示词**

`zh-CN/settings.json` 顶层加（en-US 同结构，值译英文；逐 key 对照）：

```json
"memory": {
  "title": "记忆与进化",
  "description": "开启后，Tianshu 会从对话中提取上下文信息，生成关于您的个性化记忆，以便提供更贴合您需求的回应。详见隐私政策。",
  "toggle": {
    "label": "生成对话记忆",
    "desc": "允许 Tianshu 从对话中提取上下文，生成个性化记忆，提供更精准的回应。"
  },
  "manage": {
    "title": "管理记忆",
    "subtitle": "记忆每晚自动整理更新"
  },
  "actions": {
    "reset": "重置",
    "edit": "编辑",
    "import": "导入"
  },
  "sections": {
    "work": "工作背景",
    "personal": "个人背景",
    "current": "当前关注",
    "recent": "近期动态"
  },
  "expand": "展开",
  "edit": {
    "save": "保存",
    "cancel": "取消",
    "instructionPlaceholder": "输入指令调整记忆，如：记住我在厦门 / 删掉天气相关记忆",
    "applying": "应用中…"
  },
  "resetDialog": {
    "title": "重置记忆",
    "warning1": "此操作将清空全部记忆且不可恢复。",
    "warning2": "若「生成对话记忆」功能已开启，后续仍会生成新记忆。",
    "warning3": "如需彻底停用，请关闭记忆功能。",
    "confirm": "重置记忆"
  },
  "importDialog": {
    "title": "导入其他记忆",
    "step1": {
      "title": "复制以下提示词到其他 AI 对话中",
      "copy": "复制",
      "copied": "已复制"
    },
    "step2": {
      "title": "将结果粘贴到下方，添加到 Tianshu 记忆",
      "placeholder": "在此粘贴你的记忆"
    },
    "confirm": "导入"
  },
  "empty": {
    "title": "开启对话记忆后，AI 将自动为您整理使用偏好与背景信息",
    "pending": "记忆将在每晚自动整理时生成",
    "enable": "去开启"
  },
  "disabledNotice": "已关闭对话记忆生成，记忆内容将不再自动更新",
  "toast": {
    "reset": "记忆已重置",
    "imported": "记忆导入成功",
    "importFallback": "未能识别分类标记，全部内容已存入工作背景",
    "instructionFailed": "记忆指令应用失败",
    "copyFailed": "复制失败，请手动选择复制",
    "saved": "记忆已保存"
  },
  "error": {
    "MEMORY_DISABLED": "记忆功能已关闭",
    "MEMORY_MODEL_MISSING": "暂无可用模型，请先在服务商设置中配置",
    "MEMORY_COMPILE_FAILED": "记忆整理失败，请稍后重试",
    "MEMORY_NO_MATERIAL": "暂无可整理的对话内容"
  }
}
```

`en-US/settings.json` 同结构英译（如 `"title": "Memory & Evolution"`、`"resetDialog.confirm": "Reset Memory"` 等，注意 `resetDialog.warning2` 中「生成对话记忆」对应 `toggle.label` 英译名）。

```ts
// src-react/domains/app-settings/model/import-prompt.ts
/**
 * 跨 AI 导入预置提示词（spec D2：四分类输出，与记忆 markdown 格式一致）。
 * 前端持有，主进程不依赖。
 */
export type ImportPromptLocale = "zh-CN" | "en-US";

const ZH_PROMPT = `请帮我整理一份我的个人使用画像，用途是让我在不同 AI 工具之间保持一致的协作体验。请基于你当前能访问到的、与我相关的长期信息和本次会话上下文进行整理。在涉及我的指令和偏好时，请尽量保留我原本的表述方式，不要过度改写。

分类（按以下顺序输出，标题精确使用）
## 工作背景
我的职业、所在团队、参与的项目及关键决策。仅包含实际参与的内容，每行一条。

## 个人背景
所在地、语言能力、个人兴趣等（仅包含我主动分享过的非敏感信息，不输出证件号、联系方式、账号等隐私数据）。

## 当前关注
我近期的主要关注点和正在推进的事项。

## 近期动态
最近发生的事件与变化，每行一条。

格式
使用上述分类标题作为节标题。每个类别内每行一条记录，按日期从早到晚排列。每行格式：

[YYYY-MM-DD] - 条目内容

如果日期未知，省略日期前缀。

输出
将整个画像包裹在一个代码块中，方便我复制。代码块之后简要说明覆盖度。`;

const EN_PROMPT = `Please compile a personal usage profile of me so that I can keep a consistent collaboration experience across AI tools. Base it on the long-term information about me you currently have access to plus this session's context. When quoting my instructions and preferences, preserve my original wording as much as possible.

Categories (output in this exact order, using these exact headings)
## 工作背景
...`;

export function getImportPrompt(locale: ImportPromptLocale): string {
  return locale === "zh-CN" ? ZH_PROMPT : EN_PROMPT;
}
```

（实现时把 `EN_PROMPT` 补全为 ZH 的完整英文对应版——四节标题保留中文（与解析器匹配），说明文字用英文。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/app-settings/memory-i18n.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/i18n/locales/zh-CN/settings.json src-react/i18n/locales/en-US/settings.json src-react/domains/app-settings/model/import-prompt.ts tests/app-settings/memory-i18n.test.ts
git commit -m "feat(memory): i18n 文案（zh/en 对齐）与跨 AI 导入预置提示词"
```

---

### Task 7: MemoryGroup 展示态 + 导航接入

**Files:**
- Create: `src-react/domains/app-settings/components/MemoryGroup.tsx`
- Modify: `src-react/domains/app-settings/components/SettingsDialog.tsx`（NAV_ITEMS + SettingsTabId + 右栏分支）
- Test: `tests/app-settings/memory-group.test.tsx`

**Interfaces:**
- Consumes: Task 1 `parseMemoryMarkdown`；Task 6 i18n key；`SettingsApi`/`useSaveOrRevert` 既有模式；`SettingSwitchRow`。
- Produces（Task 8/9 依赖）:
  - `default function MemoryGroup()`：整页组件（本任务交付展示态 + 开关 + 空状态；编辑态/弹窗由 Task 8/9 扩展）
  - 内部结构约定：`const [editing, setEditing] = useState(false)`、`sections` memo、`persistQuiet`（Task 8 复用）

- [ ] **Step 1: 写失败测试（参考 personalization-group.test.tsx 的既有 mock 模式——先读该文件复制 i18n/query mock 骨架）**

```tsx
// tests/app-settings/memory-group.test.tsx 核心用例（mock 骨架从 personalization-group.test.tsx 复制）
// 1. renders four sections from memoryProfile
//    mock SettingsApi.getAll 返回 [{ name: "personalization.memoryProfile", value: "## 工作背景\nabc" }, ...]
//    断言屏幕出现「工作背景」标题与「abc」正文
// 2. empty state when memoryProfile 缺失：断言 empty.title 文案与「去开启」按钮
// 3. toggle off → disabledNotice 出现
//    mock memoryEnabled="false"，断言提示条文案出现
// 4. nav item：SettingsDialog 渲染后左栏出现「记忆与进化」（settings-dialog.test.tsx 追加一例或并入本文件）
```

（具体测试代码实现时按 personalization-group.test.tsx 的 mock 方式写全——该文件已有 React Query wrapper、i18n 初始化、SettingsApi stub 三件套可复制。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/app-settings/memory-group.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

`SettingsDialog.tsx`：
- import `Lightbulb`（lucide-react）与 `MemoryGroup`
- `type SettingsTabId = "general" | "profile" | "memory" | "shortcuts"`
- `NAV_ITEMS` 在 `profile` 之后插入 `{ id: "memory", icon: Lightbulb, disabled: false }`
- 右栏分支加：`activeTab === "memory" ? <div className="flex-1 overflow-y-auto p-6"><MemoryGroup /></div> : ...`

`MemoryGroup.tsx` 展示态骨架：

```tsx
/**
 * 记忆与进化页（spec §6）：开关 + 四分类记忆卡片（本组件为展示态；
 * 编辑态/AI 指令/弹窗由子模块扩展）。读写沿用 ["personalization"]
 * React Query 缓存 + SettingsApi。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lightbulb } from "lucide-react";

import { SettingsApi } from "../api/settings.api";
import {
  PERSONALIZATION_KEYS,
  parsePersonalizationOptions,
  defaultPersonalizationOptions,
} from "../model/personalization-options";
import { parseMemoryMarkdown } from "../model/memory-markdown";
import SettingSwitchRow from "./SettingSwitchRow";
import { Button } from "@/components/ui/button";
import { useSaveOrRevert } from "../model/use-save-or-revert";

/** 单条 >500 字折叠的正文行渲染（展示态） */
function SectionBody({ text }: { text: string }) {
  // 按行渲染；超 500 字的行折叠 + 展开按钮（spec §6.2）
  // 实现时用 useState(openLineIds) 控制，展开按钮 t("settings:memory.expand")
}

export default function MemoryGroup() {
  // useQuery(["personalization"]) + select 出 memoryProfile/memoryEnabled
  // 开关行：SettingSwitchRow + persist(memoryEnabled)（复用 ProfileGroup 的 persistQuiet/revert 模式）
  // 空状态：memoryProfile 空 → 图标 + empty.title/pending + 「去开启」（开关关时才显示按钮）
  // 管理卡：标题/副标题/三按钮（本任务仅展示态：编辑按钮 disabled 或留空 onClick，Task 8 接）
  // 四板块：parseMemoryMarkdown(memoryProfile) → 标题 + SectionBody
  // 开关关 → 底部提示条 disabledNotice
}
```

（实现按注释展开为完整 JSX；样式遵守 Global Constraints——板块标题 `text-sm font-medium text-foreground`，正文 `text-xs leading-relaxed text-foreground/80`，卡片圆角边框用 `border-border/50`。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/app-settings/memory-group.test.tsx tests/app-settings/settings-dialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/app-settings/components/MemoryGroup.tsx src-react/domains/app-settings/components/SettingsDialog.tsx tests/app-settings/memory-group.test.tsx
git commit -m "feat(memory): 记忆与进化页展示态（开关/四板块/空状态/折叠）与设置导航接入"
```

---

### Task 8: 编辑模式 + AI 指令输入框

**Files:**
- Modify: `src-react/domains/app-settings/components/MemoryGroup.tsx`
- Test: `tests/app-settings/memory-group.test.tsx`（追加用例）

**Interfaces:**
- Consumes: Task 5 `MemoryApi.applyInstruction`；Task 6 i18n；Task 1 `buildMemoryMarkdown`。
- Produces: 无对外新增（UI 行为闭环）。

- [ ] **Step 1: 追加失败测试**

```tsx
// 追加到 tests/app-settings/memory-group.test.tsx
// 1. clicking 编辑 → four textareas appear（aria-label 为四节标题）
// 2. clicking 取消 → textarea 修改被丢弃恢复展示态原文
// 3. clicking 保存 → SettingsApi.set called with ("personalization.memoryProfile", 含修改后文本的 markdown)
// 4. AI 指令：mock MemoryApi.applyInstruction resolves { ok: true, memory: "## 工作背景\n新" }
//    输入框键入"记住我在厦门" → 点发送 → textarea 值更新为「新」且 loading 消失
// 5. 指令失败：mock resolves { ok: false, error: "MEMORY_MODEL_MISSING" }
//    → toast.error 被调用（mock sonner）且 textarea 保留原草稿
// 6. 编辑态把开关关掉 → 退出编辑态转只读 + disabledNotice 出现
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/app-settings/memory-group.test.tsx`
Expected: FAIL（新用例红）

- [ ] **Step 3: 实现**

MemoryGroup 内扩展（要点）：
- `const [editing, setEditing] = useState(false)`、`const [draft, setDraft] = useState<MemorySections>(sections)`、`const [instruction, setInstruction] = useState("")`、`const [applying, setApplying] = useState(false)`
- 编辑态渲染：头部按钮 重置/取消/保存（导入隐藏）；四节 `<Textarea aria-label={t("settings:memory.sections.work")} value={draft.work} onChange={(e) => setDraft({ ...draft, work: e.target.value })} />`
- 保存：`await persistQuiet(PERSONALIZATION_KEYS.memoryProfile, buildMemoryMarkdown(draft))` + `toast.success(t("settings:memory.toast.saved"))` + `setEditing(false)`
- 取消：`setDraft(sections)` + `setEditing(false)`
- AI 指令：`onSubmit` → `setApplying(true)` → `const r = await MemoryApi.applyInstruction(instruction)` → `r.ok ? (setDraft(parseMemoryMarkdown(r.memory!)), queryClient.invalidateQueries(["personalization"])) : toast.error(t(\`settings:memory.error.${r.error}\`))` → finally `setApplying(false)`、清空输入框；纸飞机图标 `Send`（lucide），Enter 提交
- 开关联动：`onChangeMemoryEnabled(false)` 且 `editing` → 先 `setEditing(false)` 再 persist（D3：退出编辑转只读，无确认弹窗）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/app-settings/memory-group.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/app-settings/components/MemoryGroup.tsx tests/app-settings/memory-group.test.tsx
git commit -m "feat(memory): 编辑模式（四文本域取消/保存）与 AI 指令增删输入框"
```

---

### Task 9: 重置弹窗 + 导入弹窗

**Files:**
- Create: `src-react/domains/app-settings/components/memory/ResetMemoryDialog.tsx`
- Create: `src-react/domains/app-settings/components/memory/ImportMemoryDialog.tsx`
- Modify: `src-react/domains/app-settings/components/MemoryGroup.tsx`（接线三按钮）
- Test: `tests/app-settings/memory-dialogs.test.tsx`

**Interfaces:**
- Consumes: Task 1 `mergeMemoryMarkdown`/`parseMemoryMarkdown`；Task 6 `getImportPrompt` + i18n；`SettingsApi.set`。
- Produces:
  - `ResetMemoryDialogProps { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }`
  - `ImportMemoryDialogProps { open: boolean; onOpenChange: (open: boolean) => void; currentMemory: string; onImported: (merged: string) => Promise<void> }`

- [ ] **Step 1: 写失败测试**

```tsx
// tests/app-settings/memory-dialogs.test.tsx
// （mock 骨架同 memory-group.test.tsx）
// ResetMemoryDialog：
// 1. 渲染三行警告文案与 取消/重置记忆 按钮
// 2. 取消 → onOpenChange(false) 且 onConfirm 未调用
// 3. 重置记忆 → onConfirm 调用
// ImportMemoryDialog：
// 4. 渲染步骤 1/2 标题与预置提示词文本（getImportPrompt("zh-CN") 内容可见）
// 5. 复制按钮：mock navigator.clipboard.writeText resolves → 按钮文案短暂变「已复制」
// 6. 导入按钮初始 disabled；输入内容后 enabled
// 7. 点击导入（含四标题内容）→ onImported 收到 mergeMemoryMarkdown(current, 输入) 的结果
// 8. 点击导入（无标题内容）→ onImported 收到全进 work 的结果
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/app-settings/memory-dialogs.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现两个弹窗**

`ResetMemoryDialog.tsx`：Dialog + 三行 `resetDialog.warning1/2/3`（`text-sm text-muted-foreground` 列表）+ 按钮 取消（outline）与 重置记忆（`variant="destructive"`）；确认后 `await onConfirm()` → Toast「记忆已重置」→ 关闭。

`ImportMemoryDialog.tsx`：Dialog（`sm:max-w-lg`）内两步区块：
- 步骤 ①：`div` 序号方块（`bg-primary-subtle text-primary rounded-md w-6 h-6` 内数字 1）+ 标题 + 复制按钮（`bg-primary text-primary-foreground`）；预置提示词 `<pre className="whitespace-pre-wrap text-xs ...">`；复制用 `navigator.clipboard.writeText(getImportPrompt(locale))`，成功 `setCopied(true)` + 2s 复位，catch → `toast.error(t("settings:memory.toast.copyFailed"))`
- 步骤 ②：序号 2 + 标题 + `<Textarea placeholder={...step2.placeholder} />` + 底部 取消/导入（`disabled={value.trim() === ""}`，有内容时 `bg-primary`）
- 导入点击：`const parsed = value.trim()`；`const merged = mergeMemoryMarkdown(currentMemory, parsed)`；判断 `parseMemoryMarkdown(parsed)` 是否识别到标题（四 key 任一非空）→ 无标题时先 `toast.info(t("settings:memory.toast.importFallback"))`；`await onImported(merged)` → `toast.success(t("settings:memory.toast.imported"))` → 关闭清空

`MemoryGroup.tsx` 接线：`resetOpen`/`importOpen` state；重置 `onConfirm = () => persistQuiet(PERSONALIZATION_KEYS.memoryProfile, "")`；导入 `onImported = (merged) => persistQuiet(PERSONALIZATION_KEYS.memoryProfile, merged)`；头部三按钮（编辑态下 重置保留、编辑↔取消/保存、导入隐藏）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/app-settings/memory-dialogs.test.tsx tests/app-settings/memory-group.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/app-settings/components/memory/ src-react/domains/app-settings/components/MemoryGroup.tsx tests/app-settings/memory-dialogs.test.tsx
git commit -m "feat(memory): 重置确认弹窗与跨 AI 导入弹窗（复制提示词/合并解析）"
```

---

### Task 10: 全量验证与手动验收

**Files:**
- 无新文件（验证任务）

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: 验收记录（对话中报告）。

- [ ] **Step 1: 全量自动化验证**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: 三项全绿（既有用例零回归）

- [ ] **Step 2: 手动验收（npm run dev）**

按 PRD 场景走查并在对话中报告结果：
1. 设置面板左栏出现「记忆与进化」（灯泡图标），位于个性化之后
2. 开关默认开；关闭后管理卡出现灰色提示条、记忆只读
3. 空状态（新 profile）：图标 + 引导文案 + 去开启
4. 手动造数据：DB 中 `personalization.memoryProfile` 写入四节 markdown → 展示切分正确、>500 字条目折叠可展开
5. 编辑：改文本保存 → 重开面板持久；取消 → 恢复
6. AI 指令（需已配模型）：输入「记住我在厦门」发送 → 草稿刷新
7. 重置：确认弹窗三行警告 → 清空 → 空状态 + Toast
8. 导入：复制按钮变「已复制」；粘贴四节文本导入 → 合并追加；粘贴散文本 → 全进工作背景 + 提示
9. 定时：把系统时间或 DB `memoryLastCompiledAt` 调到 >24h 前，重启应用，90s 后观察日志与记忆更新（开发验证项）
10. 对话注入：配好记忆后新开会话提问「你知道我的工作背景吗」验证【用户画像记忆】生效

- [ ] **Step 3: Commit（如有验收修复）**

```bash
git add -A
git commit -m "fix(memory): 手动验收修复"
```

（无修复则跳过；最终报告所有验证结果。）

---

## Self-Review 记录

- **Spec 覆盖**：§3 数据模型（Task 2）、§3.1 格式（Task 1）、§3.2 注入（Task 2）、§4 模块与 IPC（Task 3/5）、§5 管线与调度（Task 3/4）、§6 前端交互（Task 7/8/9）、§7 错误处理（Task 5/8/9）、§8 i18n（Task 6）、§9 测试（各任务 TDD + Task 10）、§10 不做项（无任务，正确）。无缺口。
- **占位符扫描**：Task 7 Step 3 组件骨架以注释标注实现要点（组件测试 mock 骨架指向既有文件复制）——实现者需读 `personalization-group.test.tsx`；其余任务代码完整。Task 5 的 `Log.debug` 行与 `compileNow` await 写法已在文中显式标注修正方式。
- **类型一致性**：`MemorySections`（Task 1）在 Task 7/8/9 复用一致；`MemoryServiceResult`（Task 5）前后端字段一致；`PERSONALIZATION_KEYS` 新 key（Task 2）在 Task 4/5/8/9 引用拼写一致；`decideMemoryTick` 签名（Task 4）与测试一致。
