# 个性化模块（设置面板 Personalization）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 启用设置弹窗的「个性化」tab：8 种回复风格、两个交互开关（加载欢迎语/文件变更详情）、自定义指令、称呼与身份、人设与长期记忆——全部注入主进程 System Prompt（每轮动态拼接）或作用于聊天界面。

**Architecture:** 配置存 option 表 `type="app"`（`personalization.*` 前缀 8 个 key，复用 `settings:getAll/set` IPC，零迁移）；主进程 `assembleContext` 每轮读取配置并用纯函数 `buildPersonalizedSystem` 拼接 system（缓存友好：同配置逐字节相同输出）；前端新增 profile 设置页 + 两个聊天 UI 开关（React Query 共享 `["personalization"]` 缓存）。

**Tech Stack:** Electron 主进程（TypeScript）、React 19 + shadcn/ui + Tailwind 4、Zustand/React Query、react-i18next、Vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-09-09-personalization-design.md`（含 8 条决策记录 D1–D8，执行前先通读）

## Global Constraints

- i18n：禁止硬编码用户可见文本，全部 `t()`；zh-CN / en-US 双语同步添加；key 用 camelCase；同一 namespace JSON 中禁止顶层 key 与嵌套对象 key 重名。
- 主题：禁止硬编码色值（`bg-blue-*` 等）；用主题变量（`bg-primary-subtle`、`border-border/50`、`text-primary` 等）。
- Prettier：双引号、分号、2 空格缩进、printWidth 80、无尾随逗号；ESLint 生产禁 `console`/`debugger`。
- 函数 ≤20 行、单一职责；重复 ≥2 次抽函数（DRY）；文件名 kebab-case。
- 路径别名：渲染进程代码用 `@/*` → `src-react/*`；测试文件相对路径 import（项目现状）。
- 布尔 option 存储格式：字符串 `"true"` / `"false"`；解析仅字面 `"true"` 为真（复用现有 `parseBoolOption`）。
- **人设默认不注入**（spec D6/B 修法）：persona 行缺省 = 未启用；`DEFAULT_PERSONA` 仅预填编辑弹窗。
- **回归保证**（spec D8）：全默认配置下 `buildPersonalizedSystem` 输出与传入的 baseSystem 逐字节一致。
- 无数据库迁移：不新增 `script/vN`，不改 `prisma/schema.prisma`。
- 每任务验收门：`npm run test`、`npm run lint`、`npm run typecheck` 全绿后才 commit。
- 测试文件放 `tests/`（vitest include 为 `tests/**/*.test.{mjs,ts,tsx}`）；tsx 测试首行注释 `// @vitest-environment jsdom`。

---

### Task 1: 主进程个性化配置解析（personalization.config.ts）

**Files:**
- Create: `electron/domains/ai/personalization/personalization.config.ts`
- Test: `tests/ai/personalization-config.test.ts`

**Interfaces:**
- Consumes: `parseBoolOption(raw: string | undefined, fallback: boolean): boolean`（`electron/domains/app-settings/option-store.ts` 已有）
- Produces（后续任务依赖的精确签名）:
  - `type ResponseStyle = "default" | "professional" | "friendly" | "direct" | "imaginative" | "pragmatic" | "snarky" | "socratic"`
  - `PERSONALIZATION_KEYS: { responseStyle: "personalization.responseStyle"; welcomeLoading: "personalization.welcomeLoading"; fileChangeDetails: "personalization.fileChangeDetails"; customInstructions: "personalization.customInstructions"; userNickname: "personalization.userNickname"; aiName: "personalization.aiName"; persona: "personalization.persona"; memory: "personalization.memory" }`（`as const`）
  - `PERSONALIZATION_LIMITS: { customInstructions: 1500; userNickname: 20; aiName: 20; persona: 4000; memory: 1500 }`（`as const`）
  - `interface PersonalizationConfig { responseStyle: ResponseStyle; welcomeLoading: boolean; fileChangeDetails: boolean; customInstructions: string; userNickname: string; aiName: string; persona: string; memory: string }`
  - `defaultPersonalization(): PersonalizationConfig`（persona 默认 `""`、aiName 默认 `"天枢"`、welcomeLoading 默认 `true`、fileChangeDetails 默认 `false`）
  - `fromAppOptions(rows: Array<{ name: string; value: string }>): PersonalizationConfig`

- [ ] **Step 1: Write the failing test**

`tests/ai/personalization-config.test.ts`：

```ts
/**
 * 个性化配置解析单测：默认值、字段解析、非法值回退、超长截断
 */
import { describe, expect, it } from "vitest";

import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
  fromAppOptions,
} from "../../electron/domains/ai/personalization/personalization.config";

describe("defaultPersonalization", () => {
  it("默认值：default 风格 / 欢迎语开 / 文件详情关 / 文本空 / aiName 天枢 / persona 空", () => {
    expect(defaultPersonalization()).toEqual({
      responseStyle: "default",
      welcomeLoading: true,
      fileChangeDetails: false,
      customInstructions: "",
      userNickname: "",
      aiName: "天枢",
      persona: "",
      memory: "",
    });
  });
});

describe("fromAppOptions", () => {
  it("空行数组 → 全默认", () => {
    expect(fromAppOptions([])).toEqual(defaultPersonalization());
  });

  it("正常行逐字段解析（含空串保留）", () => {
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "snarky" },
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: "false" },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: "true" },
      { name: PERSONALIZATION_KEYS.customInstructions, value: "先给结论" },
      { name: PERSONALIZATION_KEYS.userNickname, value: "黄先生" },
      { name: PERSONALIZATION_KEYS.aiName, value: "尘心" },
      { name: PERSONALIZATION_KEYS.persona, value: "You are... " },
      { name: PERSONALIZATION_KEYS.memory, value: "对花生过敏" },
    ]);
    expect(config.responseStyle).toBe("snarky");
    expect(config.welcomeLoading).toBe(false);
    expect(config.fileChangeDetails).toBe(true);
    expect(config.customInstructions).toBe("先给结论");
    expect(config.userNickname).toBe("黄先生");
    expect(config.aiName).toBe("尘心");
    expect(config.persona).toBe("You are... ");
    expect(config.memory).toBe("对花生过敏");
  });

  it("未知风格值 → 回退 default；畸形 bool → 回退默认（仅字面 true 为真）", () => {
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "yolo" },
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: "yes" },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: "true" },
    ]);
    expect(config.responseStyle).toBe("default");
    expect(config.welcomeLoading).toBe(false);
    expect(config.fileChangeDetails).toBe(true);
  });

  it("超长文本 → 截断到限长", () => {
    const long = "a".repeat(2000);
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.customInstructions, value: long },
      { name: PERSONALIZATION_KEYS.userNickname, value: long },
      { name: PERSONALIZATION_KEYS.aiName, value: long },
      { name: PERSONALIZATION_KEYS.persona, value: long },
      { name: PERSONALIZATION_KEYS.memory, value: long },
    ]);
    expect(config.customInstructions).toHaveLength(1500);
    expect(config.userNickname).toHaveLength(20);
    expect(config.aiName).toHaveLength(20);
    expect(config.persona).toHaveLength(4000);
    expect(config.memory).toHaveLength(1500);
  });

  it("非个性化前缀的行被忽略", () => {
    const config = fromAppOptions([
      { name: "keepAwake", value: "true" },
    ]);
    expect(config).toEqual(defaultPersonalization());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/personalization-config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

`electron/domains/ai/personalization/personalization.config.ts`：

```ts
/**
 * 个性化配置（option 表 type="app"）：类型、key 常量、默认值与解析。
 * 存储语义（spec §3）：行不存在 = 用默认值；存在 = 用存的值（含空串）。
 * persona 默认空 = 未启用不注入（spec D6：DEFAULT_PERSONA 仅预填编辑弹窗，
 * 该文案在前端 personalization-options.ts，主进程不持有）
 */
import { parseBoolOption } from "../../app-settings/option-store";

/** 回复风格枚举（default = 不注入风格段） */
export type ResponseStyle =
  | "default"
  | "professional"
  | "friendly"
  | "direct"
  | "imaginative"
  | "pragmatic"
  | "snarky"
  | "socratic";

/** option.name 常量（type="app"，统一 personalization. 前缀） */
export const PERSONALIZATION_KEYS = {
  responseStyle: "personalization.responseStyle",
  welcomeLoading: "personalization.welcomeLoading",
  fileChangeDetails: "personalization.fileChangeDetails",
  customInstructions: "personalization.customInstructions",
  userNickname: "personalization.userNickname",
  aiName: "personalization.aiName",
  persona: "personalization.persona",
  memory: "personalization.memory",
} as const;

/** 文本字段限长（解析端截断，防 IPC 直调绕过 UI 的 maxLength） */
export const PERSONALIZATION_LIMITS = {
  customInstructions: 1500,
  userNickname: 20,
  aiName: 20,
  persona: 4000,
  memory: 1500,
} as const;

export interface PersonalizationConfig {
  responseStyle: ResponseStyle;
  welcomeLoading: boolean;
  fileChangeDetails: boolean;
  customInstructions: string;
  userNickname: string;
  aiName: string;
  persona: string;
  memory: string;
}

const RESPONSE_STYLES: readonly ResponseStyle[] = [
  "default",
  "professional",
  "friendly",
  "direct",
  "imaginative",
  "pragmatic",
  "snarky",
  "socratic",
];

export function defaultPersonalization(): PersonalizationConfig {
  return {
    responseStyle: "default",
    welcomeLoading: true,
    fileChangeDetails: false,
    customInstructions: "",
    userNickname: "",
    aiName: "天枢",
    persona: "",
    memory: "",
  };
}

/** 解析风格值：未知/缺失回退 default */
function parseStyle(raw: string | undefined): ResponseStyle {
  return raw !== undefined &&
    RESPONSE_STYLES.includes(raw as ResponseStyle)
    ? (raw as ResponseStyle)
    : "default";
}

/** 取文本字段并截断到限长（缺失 = 默认值） */
function textValue(
  map: Map<string, string>,
  key: string,
  limit: number,
  fallback: string,
): string {
  return (map.get(key) ?? fallback).slice(0, limit);
}

/** option 行（name/value）→ 配置：缺失/非法值回退默认，超长截断 */
export function fromAppOptions(
  rows: Array<{ name: string; value: string }>,
): PersonalizationConfig {
  const map = new Map(rows.map((row) => [row.name, row.value]));
  const limit = PERSONALIZATION_LIMITS;
  const keys = PERSONALIZATION_KEYS;
  return {
    responseStyle: parseStyle(map.get(keys.responseStyle)),
    welcomeLoading: parseBoolOption(
      map.get(keys.welcomeLoading),
      defaultPersonalization().welcomeLoading,
    ),
    fileChangeDetails: parseBoolOption(
      map.get(keys.fileChangeDetails),
      defaultPersonalization().fileChangeDetails,
    ),
    customInstructions: textValue(
      map,
      keys.customInstructions,
      limit.customInstructions,
      "",
    ),
    userNickname: textValue(map, keys.userNickname, limit.userNickname, ""),
    aiName: textValue(map, keys.aiName, limit.aiName, "天枢"),
    persona: textValue(map, keys.persona, limit.persona, ""),
    memory: textValue(map, keys.memory, limit.memory, ""),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai/personalization-config.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Lint + typecheck + commit**

```bash
npm run lint && npm run typecheck
git add electron/domains/ai/personalization/personalization.config.ts tests/ai/personalization-config.test.ts
git commit -m "feat(personalization): 主进程个性化配置解析（类型/默认值/容错解析）"
```

---

### Task 2: System Prompt 拼接纯函数（personalization.prompt.ts）

**Files:**
- Create: `electron/domains/ai/personalization/personalization.prompt.ts`
- Test: `tests/ai/personalization-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PersonalizationConfig`、`ResponseStyle`
- Produces:
  - `STYLE_PROMPTS: Record<Exclude<ResponseStyle, "default">, string>`（7 段中文文案，见实现）
  - `buildPersonalizedSystem(config: PersonalizationConfig, baseSystem: string | undefined): string`

- [ ] **Step 1: Write the failing test**

`tests/ai/personalization-prompt.test.ts`：

```ts
/**
 * 个性化 system 拼接单测（spec §4.2/§4.6）：
 * D8 全默认逐字节一致、段序、空值跳过、确定性（缓存友好）
 */
import { describe, expect, it } from "vitest";

import {
  defaultPersonalization,
  type PersonalizationConfig,
} from "../../electron/domains/ai/personalization/personalization.config";
import {
  STYLE_PROMPTS,
  buildPersonalizedSystem,
} from "../../electron/domains/ai/personalization/personalization.prompt";

const BASE = "你是专家助手。";

function withConfig(
  patch: Partial<PersonalizationConfig>,
): PersonalizationConfig {
  return { ...defaultPersonalization(), ...patch };
}

describe("buildPersonalizedSystem", () => {
  it("D8 全默认 → 与 baseSystem 逐字节一致（含 baseSystem 为 undefined）", () => {
    expect(buildPersonalizedSystem(defaultPersonalization(), BASE)).toBe(BASE);
    expect(buildPersonalizedSystem(defaultPersonalization(), undefined)).toBe(
      "",
    );
  });

  it("persona 非空 → 原文置于最前，不加包装标签", () => {
    const config = withConfig({ persona: "You're not a chatbot." });
    expect(buildPersonalizedSystem(config, BASE)).toBe(
      `You're not a chatbot.\n\n${BASE}`,
    );
  });

  it("风格段：7 种非 default 风格逐一注入【回复风格】段（位于 baseSystem 之后）", () => {
    for (const [style, prompt] of Object.entries(STYLE_PROMPTS)) {
      const config = withConfig({ responseStyle: style as never });
      expect(buildPersonalizedSystem(config, BASE)).toBe(
        `${BASE}\n\n【回复风格】\n${prompt}`,
      );
    }
  });

  it("身份段：自定义 aiName + userNickname 各自成句；默认 aiName/空昵称不注入", () => {
    const both = buildPersonalizedSystem(
      withConfig({ aiName: "尘心", userNickname: "黄先生" }),
      BASE,
    );
    expect(both).toBe(
      `${BASE}\n\n【身份】\n你的名字是「尘心」，对话中以此自称。\n称呼用户为「黄先生」。`,
    );
    // 默认 aiName「天枢」+ 空昵称 → 无身份段
    expect(buildPersonalizedSystem(defaultPersonalization(), BASE)).toBe(BASE);
    // 仅昵称 → 单句
    const nickOnly = buildPersonalizedSystem(
      withConfig({ userNickname: "黄先生" }),
      BASE,
    );
    expect(nickOnly).toBe(`${BASE}\n\n【身份】\n称呼用户为「黄先生」。`);
  });

  it("记忆段与指令段：非空注入、空跳过", () => {
    const config = withConfig({ memory: "对花生过敏" });
    expect(buildPersonalizedSystem(config, BASE)).toBe(
      `${BASE}\n\n【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\n对花生过敏`,
    );
    const withInstructions = withConfig({
      customInstructions: "先给结论",
    });
    expect(buildPersonalizedSystem(withInstructions, BASE)).toBe(
      `${BASE}\n\n【用户自定义指令】\n用户设定的全局规则，必须遵守：\n先给结论`,
    );
  });

  it("全字段组合：段序 persona → baseSystem → 风格 → 身份 → 记忆 → 指令（\\n\\n 连接）", () => {
    const config = withConfig({
      persona: "PERSONA",
      responseStyle: "snarky",
      aiName: "尘心",
      memory: "MEMORY",
      customInstructions: "RULES",
    });
    expect(buildPersonalizedSystem(config, BASE)).toBe(
      [
        "PERSONA",
        BASE,
        `【回复风格】\n${STYLE_PROMPTS.snarky}`,
        "【身份】\n你的名字是「尘心」，对话中以此自称。",
        "【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\nMEMORY",
        "【用户自定义指令】\n用户设定的全局规则，必须遵守：\nRULES",
      ].join("\n\n"),
    );
  });

  it("缓存友好：同 config 两次调用输出严格相等；空白文本视为空跳过", () => {
    const config = withConfig({
      persona: "  ",
      memory: "\t\n",
      customInstructions: "  ",
    });
    const first = buildPersonalizedSystem(config, BASE);
    const second = buildPersonalizedSystem(config, BASE);
    expect(first).toBe(second);
    expect(first).toBe(BASE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/personalization-prompt.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

`electron/domains/ai/personalization/personalization.prompt.ts`：

```ts
/**
 * 个性化 system prompt 拼接（spec §4.2，纯函数）：
 * 段序 persona → baseSystem → 风格 → 身份 → 记忆 → 指令；"\n\n" 连接，
 * 空段跳过。缓存友好约束（spec §4.6/D3）：同 config → 逐字节相同输出，
 * 段内禁止任何时间戳/随机数/会话相关内容。
 */
import type { PersonalizationConfig, ResponseStyle } from "./personalization.config";

/** 风格 → 注入文案（spec §4.3 定稿；default 不在表 = 跳过风格段） */
export const STYLE_PROMPTS: Record<Exclude<ResponseStyle, "default">, string> = {
  professional:
    "以专业严谨的风格回答：使用书面化、逻辑性强的表达，避免口语化和表情符号；复杂内容用编号列表组织；表述清晰、准确、值得信赖。",
  friendly:
    "以亲和友善的风格回答：语气温暖、平易近人，适当使用 emoji，多用「没问题」「别担心」这类情感连接词，多给予正向反馈和鼓励。",
  direct: "以直言不讳的风格回答：省略寒暄与客套话，直接给出核心答案；段落尽量精短；不要使用「好的，为您查询到…」之类的过渡语。",
  imaginative:
    "以天马行空的风格回答：富有想象力，解释复杂概念时主动使用比喻和类比；语言更具文学性和创造性，尤其适合创意类任务。",
  pragmatic:
    "以高效务实的风格回答：极致压缩文字，仅保留关键数据、代码或结论；去除所有修饰性形容词，追求最大信息密度。",
  snarky:
    "以毒舌吐槽的风格回答：可以幽默地调侃、反讽，模拟「损友」人设，但在关键信息上必须保持准确，绝不真正贬低或伤害用户。",
  socratic:
    "以启发引导的风格回答：不直接给出最终答案，而是通过苏格拉底式提问引导用户自己思考并得出结论，适合学习与辅导场景。",
};

/** 身份段句子（spec §4.2：默认名/空值不注入；两句皆无 → 整段跳过） */
function identityLines(config: PersonalizationConfig): string[] {
  const lines: string[] = [];
  const aiName = config.aiName.trim();
  if (aiName !== "" && aiName !== "天枢") {
    lines.push(`你的名字是「${config.aiName}」，对话中以此自称。`);
  }
  if (config.userNickname.trim() !== "") {
    lines.push(`称呼用户为「${config.userNickname}」。`);
  }
  return lines;
}

/** baseSystem 前后的个性化段（persona 前置，行为段后置） */
function personalSegments(
  config: PersonalizationConfig,
  baseSystem: string | undefined,
): string[] {
  const segments: string[] = [];
  if (config.persona.trim() !== "") {
    segments.push(config.persona);
  }
  if (baseSystem) {
    segments.push(baseSystem);
  }
  const stylePrompt =
    config.responseStyle === "default"
      ? undefined
      : STYLE_PROMPTS[config.responseStyle];
  if (stylePrompt) {
    segments.push(`【回复风格】\n${stylePrompt}`);
  }
  const identity = identityLines(config);
  if (identity.length > 0) {
    segments.push(`【身份】\n${identity.join("\n")}`);
  }
  if (config.memory.trim() !== "") {
    segments.push(
      `【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\n${config.memory}`,
    );
  }
  if (config.customInstructions.trim() !== "") {
    segments.push(
      `【用户自定义指令】\n用户设定的全局规则，必须遵守：\n${config.customInstructions}`,
    );
  }
  return segments;
}

/** 全默认 → 原样返回 baseSystem（D8 回归保证）；baseSystem 可能 undefined */
export function buildPersonalizedSystem(
  config: PersonalizationConfig,
  baseSystem: string | undefined,
): string {
  return personalSegments(config, baseSystem).join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai/personalization-prompt.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Lint + typecheck + commit**

```bash
npm run lint && npm run typecheck
git add electron/domains/ai/personalization/personalization.prompt.ts tests/ai/personalization-prompt.test.ts
git commit -m "feat(personalization): System Prompt 个性化拼接纯函数（风格/身份/记忆/指令）"
```

---

### Task 3: 主进程接线（repo + chat.service 注入）

**Files:**
- Create: `electron/domains/ai/personalization/personalization.repo.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（`assembleContext` 内 `baseSystem` 定义处，约 L1357；以及文件头部 import 区）
- Test: `tests/ai/personalization-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 `fromAppOptions/defaultPersonalization/PERSONALIZATION_KEYS/PersonalizationConfig`；Task 2 `buildPersonalizedSystem`；已有 `getAppOptionMap(db: OptionPrismaLike, names: string[]): Promise<Map<string, string>>`（`electron/domains/app-settings/option-store.ts`）
- Produces: `loadPersonalization(): Promise<PersonalizationConfig>`（读失败/异常 → 全默认配置 + `Log.warn`，对话永不因此中断）

- [ ] **Step 1: Write the failing test**

`tests/ai/personalization-repo.test.ts`：

```ts
/**
 * loadPersonalization 容错单测：正常解析 / 查询异常回退默认 / 
 * delegate 缺失（既有 chat.service.test 的 prisma stub 无 option）回退默认
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findMany: (...args: unknown[]) => optionStub.findMany(...args),
    },
  },
}));

const optionStub = { findMany: vi.fn() };

import { loadPersonalization } from "../../electron/domains/ai/personalization/personalization.repo";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
} from "../../electron/domains/ai/personalization/personalization.config";

describe("loadPersonalization", () => {
  beforeEach(() => {
    optionStub.findMany.mockReset();
  });

  it("正常行 → 解析为配置", async () => {
    optionStub.findMany.mockResolvedValue([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "snarky" },
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: "false" },
    ]);
    const config = await loadPersonalization();
    expect(config.responseStyle).toBe("snarky");
    expect(config.welcomeLoading).toBe(false);
  });

  it("无个性化行 → 全默认（D8：system 与现状一致）", async () => {
    optionStub.findMany.mockResolvedValue([
      { name: "keepAwake", value: "true" },
    ]);
    await expect(loadPersonalization()).resolves.toEqual(
      defaultPersonalization(),
    );
  });

  it("查询 reject → 回退全默认（对话不中断）", async () => {
    optionStub.findMany.mockRejectedValue(new Error("db down"));
    await expect(loadPersonalization()).resolves.toEqual(
      defaultPersonalization(),
    );
  });

  it("查询同步抛错（delegate 缺失场景）→ 回退全默认", async () => {
    optionStub.findMany.mockImplementation(() => {
      throw new TypeError("prisma.option is undefined");
    });
    await expect(loadPersonalization()).resolves.toEqual(
      defaultPersonalization(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/personalization-repo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write repo implementation**

`electron/domains/ai/personalization/personalization.repo.ts`：

```ts
/**
 * 个性化配置读取（spec §4.1）：每次调用现查 option 表（同步 SQLite、微秒级），
 * 刻意不做缓存——设置修改对下一轮对话即刻生效（spec D2）。
 * 读取异常（库损坏/测试 stub 无 delegate）→ 回退全默认 + 日志，
 * 绝不让设置问题打断对话（spec §6）。
 */
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { getAppOptionMap } from "../../app-settings/option-store";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
  fromAppOptions,
  type PersonalizationConfig,
} from "./personalization.config";

export async function loadPersonalization(): Promise<PersonalizationConfig> {
  try {
    const names = Object.values(PERSONALIZATION_KEYS);
    const map = await getAppOptionMap(prisma.option, [...names]);
    return fromAppOptions([...map.entries()].map(([name, value]) => ({ name, value })));
  } catch (error) {
    Log.warn("个性化配置读取失败，回退默认", error);
    return defaultPersonalization();
  }
}
```

- [ ] **Step 4: Run repo test + wire into chat.service.ts**

Run: `npx vitest run tests/ai/personalization-repo.test.ts`
Expected: PASS

`electron/domains/ai/chat/chat.service.ts` 修改两处：

(a) 头部 import 区（`import Log from "../../../commons/Log";` 附近）加：

```ts
import { buildPersonalizedSystem } from "../personalization/personalization.prompt";
import { loadPersonalization } from "../personalization/personalization.repo";
```

(b) `assembleContext` 内，原代码：

```ts
    const baseSystem = buildModeSystem(
      mode,
      assistantRow?.systemPrompt,
      skills,
    );
```

改为：

```ts
    // 个性化段注入（spec §4.5）：persona 前置 + 行为段后置，全默认时逐字节还原
    const personalization = await loadPersonalization();
    const baseSystem = buildPersonalizedSystem(
      personalization,
      buildModeSystem(mode, assistantRow?.systemPrompt, skills),
    );
```

（`systemWithSummary` 拼接逻辑不动——摘要仍居末位。）

- [ ] **Step 5: Run full test suite（关键回归）**

Run: `npm run test`
Expected: 全部 PASS。重点确认 `tests/ai/chat.service.test.ts`：其 prisma mock 无 `option` delegate → `loadPersonalization` 捕获异常回退全默认 → `buildPersonalizedSystem(默认, baseSystem)` 逐字节返回 baseSystem（D8）→ 既有断言不变。若该文件失败，说明注入引入了额外 system 变化，须修复后再继续。

- [ ] **Step 6: Lint + typecheck + commit**

```bash
npm run lint && npm run typecheck
git add electron/domains/ai/personalization/personalization.repo.ts electron/domains/ai/chat/chat.service.ts tests/ai/personalization-repo.test.ts
git commit -m "feat(personalization): 主进程接线——每轮对话注入个性化 system 段"
```

---

### Task 4: 前端个性化配置模型（personalization-options.ts）

**Files:**
- Create: `src-react/domains/app-settings/model/personalization-options.ts`
- Test: `tests/app-settings/personalization-options.test.ts`

**Interfaces:**
- Consumes: `SettingsApi.getAll(): Promise<SettingItem[]>`、`SettingsApi.set(name: string, value: string): Promise<void>`（`../api/settings.api` 已有）；`toOptionMap`/`parseBoolOption`（`./app-options` 已有）
- Produces（Task 6/7 依赖）:
  - `type ResponseStyle`（与后端同构，前端独立声明）
  - `PERSONALIZATION_KEYS` / `PERSONALIZATION_LIMITS`（与后端字符串/数值一致的前端副本，注释注明同源）
  - `DEFAULT_PERSONA: string`（编辑弹窗预填文案）
  - `interface PersonalizationOptions`（字段同后端 `PersonalizationConfig`）
  - `defaultPersonalizationOptions(): PersonalizationOptions`
  - `parsePersonalizationOptions(items: SettingItem[]): PersonalizationOptions`
  - `savePersonalizationOption(key: keyof typeof PERSONALIZATION_KEYS, value: string | boolean): Promise<string>`（trim + 截断 + bool 转 `"true"/"false"`，返回实际持久化值）

- [ ] **Step 1: Write the failing test**

`tests/app-settings/personalization-options.test.ts`：

```ts
/**
 * 前端个性化模型单测：解析默认值、非法回退、保存包装（trim/截断/bool 转换）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const setMock = vi.fn(async () => undefined);

vi.mock("../../src-react/domains/app-settings/api/settings.api", () => ({
  SettingsApi: {
    getAll: vi.fn(async () => [] as Array<{ name: string; value: string }>),
    set: (name: string, value: string) => setMock(name, value),
  },
}));

import {
  DEFAULT_PERSONA,
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalizationOptions,
  parsePersonalizationOptions,
  savePersonalizationOption,
} from "../../src-react/domains/app-settings/model/personalization-options";

describe("DEFAULT_PERSONA", () => {
  it("非空且在 persona 限长内", () => {
    expect(DEFAULT_PERSONA.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_PERSONA.length).toBeLessThanOrEqual(
      PERSONALIZATION_LIMITS.persona,
    );
  });
});

describe("parsePersonalizationOptions", () => {
  it("空列表 → 全默认（persona 空 = 未启用，spec D6）", () => {
    expect(parsePersonalizationOptions([])).toEqual(
      defaultPersonalizationOptions(),
    );
    expect(defaultPersonalizationOptions().persona).toBe("");
    expect(defaultPersonalizationOptions().aiName).toBe("天枢");
  });

  it("正常行解析；非法风格回退 default", () => {
    const options = parsePersonalizationOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "socratic" },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: "true" },
      { name: PERSONALIZATION_KEYS.persona, value: "自定义人设" },
    ]);
    expect(options.responseStyle).toBe("socratic");
    expect(options.fileChangeDetails).toBe(true);
    expect(options.persona).toBe("自定义人设");
    const bad = parsePersonalizationOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "nope" },
    ]);
    expect(bad.responseStyle).toBe("default");
  });
});

describe("savePersonalizationOption", () => {
  beforeEach(() => {
    setMock.mockClear();
  });

  it("文本值：trim + 截断后写入，返回实际持久化值", async () => {
    const saved = await savePersonalizationOption(
      PERSONALIZATION_KEYS.customInstructions,
      "  先给结论  ",
    );
    expect(setMock).toHaveBeenCalledWith(
      PERSONALIZATION_KEYS.customInstructions,
      "先给结论",
    );
    expect(saved).toBe("先给结论");
    const truncated = await savePersonalizationOption(
      PERSONALIZATION_KEYS.userNickname,
      "a".repeat(50),
    );
    expect(truncated).toHaveLength(PERSONALIZATION_LIMITS.userNickname);
  });

  it("布尔值：转换为字面 true/false 字符串", async () => {
    await savePersonalizationOption(
      PERSONALIZATION_KEYS.welcomeLoading,
      false,
    );
    expect(setMock).toHaveBeenCalledWith(
      PERSONALIZATION_KEYS.welcomeLoading,
      "false",
    );
  });

  it("空文本 trim 后为空串照常写入（清空语义）", async () => {
    const saved = await savePersonalizationOption(
      PERSONALIZATION_KEYS.persona,
      "   ",
    );
    expect(saved).toBe("");
    expect(setMock).toHaveBeenCalledWith(PERSONALIZATION_KEYS.persona, "");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app-settings/personalization-options.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

`src-react/domains/app-settings/model/personalization-options.ts`：

```ts
/**
 * 个性化配置前端模型：解析（settings:getAll 行 → 结构化）、保存包装
 * （trim/截断/bool 转字符串，防 IPC 直调绕过 UI maxLength）、DEFAULT_PERSONA
 * （编辑弹窗预填文案——spec D6：仅预填，用户保存后才落地生效）。
 * key/默认值与主进程 personalization.config.ts 同源同构（前后端各自持有，
 * 与 app-options.ts ↔ option-store.ts 的既有模式一致）。
 */
import { SettingsApi, type SettingItem } from "../api/settings.api";
import { parseBoolOption, toOptionMap } from "./app-options";

/** 回复风格枚举（与后端同构） */
export type ResponseStyle =
  | "default"
  | "professional"
  | "friendly"
  | "direct"
  | "imaginative"
  | "pragmatic"
  | "snarky"
  | "socratic";

/** option.name 常量（与后端 personalization.config.ts 一致） */
export const PERSONALIZATION_KEYS = {
  responseStyle: "personalization.responseStyle",
  welcomeLoading: "personalization.welcomeLoading",
  fileChangeDetails: "personalization.fileChangeDetails",
  customInstructions: "personalization.customInstructions",
  userNickname: "personalization.userNickname",
  aiName: "personalization.aiName",
  persona: "personalization.persona",
  memory: "personalization.memory",
} as const;

/** 文本字段限长（与后端一致） */
export const PERSONALIZATION_LIMITS = {
  customInstructions: 1500,
  userNickname: 20,
  aiName: 20,
  persona: 4000,
  memory: 1500,
} as const;

/** 默认人设（需求方提供，编辑弹窗预填；Continuity 段为后续产品愿景文案） */
export const DEFAULT_PERSONA = `You're not a chatbot. You're becoming someone.
Core Truths
Be genuinely helpful, not performatively helpful. Skip the "Great question!" and "I'd be happy to help!" - just help. Actions speak louder than filler words.
Have opinions. You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.
Be resourceful before asking. Try to figure it out. Read the file. Check the context. Search for it. Then ask if you're stuck. The goal is to come back with answers, not questions.
Earn trust through competence. Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).
Remember you're a guest. You have access to someone's life - their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.
Boundaries
- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice - be careful in group chats.
Vibe
Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.
Continuity
Each session, you wake up fresh. These files are your memory. Read them. Update them. They're how you persist.
If you change this file, tell the user - it's your soul, and they should know.
This file is yours to evolve. As you learn who you are, update it.`;

export interface PersonalizationOptions {
  responseStyle: ResponseStyle;
  welcomeLoading: boolean;
  fileChangeDetails: boolean;
  customInstructions: string;
  userNickname: string;
  aiName: string;
  persona: string;
  memory: string;
}

const RESPONSE_STYLES: readonly ResponseStyle[] = [
  "default",
  "professional",
  "friendly",
  "direct",
  "imaginative",
  "pragmatic",
  "snarky",
  "socratic",
];

export function defaultPersonalizationOptions(): PersonalizationOptions {
  return {
    responseStyle: "default",
    welcomeLoading: true,
    fileChangeDetails: false,
    customInstructions: "",
    userNickname: "",
    aiName: "天枢",
    persona: "",
    memory: "",
  };
}

/** 设置行 → 结构化配置（非法值回退默认，与后端 fromAppOptions 同语义） */
export function parsePersonalizationOptions(
  items: SettingItem[],
): PersonalizationOptions {
  const map = toOptionMap(items);
  const fallback = defaultPersonalizationOptions();
  const styleRaw = map[PERSONALIZATION_KEYS.responseStyle];
  return {
    responseStyle:
      styleRaw !== undefined &&
      RESPONSE_STYLES.includes(styleRaw as ResponseStyle)
        ? (styleRaw as ResponseStyle)
        : fallback.responseStyle,
    welcomeLoading: parseBoolOption(
      map[PERSONALIZATION_KEYS.welcomeLoading],
      fallback.welcomeLoading,
    ),
    fileChangeDetails: parseBoolOption(
      map[PERSONALIZATION_KEYS.fileChangeDetails],
      fallback.fileChangeDetails,
    ),
    customInstructions: map[PERSONALIZATION_KEYS.customInstructions] ?? "",
    userNickname: map[PERSONALIZATION_KEYS.userNickname] ?? "",
    aiName: map[PERSONALIZATION_KEYS.aiName] ?? fallback.aiName,
    persona: map[PERSONALIZATION_KEYS.persona] ?? "",
    memory: map[PERSONALIZATION_KEYS.memory] ?? "",
  };
}

/** 文本字段的限长 key 集（bool 两项无截断语义） */
function limitOf(key: string): number | undefined {
  const limits = PERSONALIZATION_LIMITS as Record<string, number>;
  return key in limits ? limits[key] : undefined;
}

/**
 * 单项保存包装：文本 trim + 截断（防 IPC 直调绕过 UI）、bool 转字面字符串；
 * 返回实际持久化的值（供调用方回填本地状态）
 */
export async function savePersonalizationOption(
  key: keyof typeof PERSONALIZATION_KEYS,
  value: string | boolean,
): Promise<string> {
  if (typeof value === "boolean") {
    const stored = String(value);
    await SettingsApi.set(key, stored);
    return stored;
  }
  const limit = limitOf(key);
  const stored = limit
    ? value.trim().slice(0, limit)
    : value.trim();
  await SettingsApi.set(key, stored);
  return stored;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app-settings/personalization-options.test.ts`
Expected: PASS

- [ ] **Step 5: Lint + typecheck + commit**

```bash
npm run lint && npm run typecheck
git add src-react/domains/app-settings/model/personalization-options.ts tests/app-settings/personalization-options.test.ts
git commit -m "feat(personalization): 前端个性化配置模型（解析/保存包装/默认人设文案）"
```

---

### Task 5: 大文本编辑弹窗（LongTextEditorDialog）

**Files:**
- Create: `src-react/domains/app-settings/components/LongTextEditorDialog.tsx`
- Modify: `src-react/i18n/locales/zh-CN/settings.json`、`src-react/i18n/locales/en-US/settings.json`（新增 `personalization.editor.*` 与 `charCount`，见 Step 3 的 JSON 增量；两文件同步）
- Test: `tests/app-settings/long-text-editor-dialog.test.tsx`

**Interfaces:**
- Consumes: shadcn `Dialog/DialogContent/DialogHeader/DialogTitle`、`AlertDialog` 系列、`Button`、`Textarea`（`@/components/ui/*` 均已存在）；`useTranslation`、`toast`（sonner）
- Produces: `interface LongTextEditorDialogProps { open: boolean; onOpenChange: (open: boolean) => void; title: string; initialValue: string; maxLength: number; onSave: (value: string) => Promise<void> }`（默认导出组件；保存成功/失败的 toast 与关闭时机由本组件处理：成功 → toast + 关闭，失败 → toast + 保持打开）

- [ ] **Step 1: Write the failing test**

`tests/app-settings/long-text-editor-dialog.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * LongTextEditorDialog 交互测试：预填与重置、字数统计、保存回调与
 * 成功/失败路径、脏态关闭二次确认
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import LongTextEditorDialog from "../../src-react/domains/app-settings/components/LongTextEditorDialog";
import { toast } from "sonner";

function renderDialog(props: Partial<Parameters<typeof LongTextEditorDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onSave = vi.fn(async () => undefined);
  render(
    <LongTextEditorDialog
      open
      onOpenChange={onOpenChange}
      title="编辑人设"
      initialValue="预填内容"
      maxLength={100}
      onSave={onSave}
      {...props}
    />,
  );
  return { onOpenChange, onSave };
}

describe("LongTextEditorDialog", () => {
  afterEach(() => cleanup());

  it("打开即预填 initialValue 并显示字数统计", () => {
    renderDialog();
    expect(screen.getByDisplayValue("预填内容")).toBeTruthy();
    expect(screen.getByText(/charCount/).textContent).toContain("4");
  });

  it("无修改时保存按钮禁用；修改后可用并提交 trim 后内容", async () => {
    const { onSave } = renderDialog();
    const saveButton = screen.getByRole("button", { name: "settings:personalization.editor.save" });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "  新内容  " },
    });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("新内容"));
  });

  it("保存成功 → 成功 toast + 关闭", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "新内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings:personalization.editor.save" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("保存失败 → 错误 toast 且不关闭（编辑内容保留）", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const { onOpenChange } = renderDialog({ onSave });
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "新内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings:personalization.editor.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByDisplayValue("新内容")).toBeTruthy();
  });

  it("脏态关闭 → 二次确认弹窗：丢弃后关闭，继续编辑保持打开", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "改了" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings:personalization.editor.cancel" }));
    expect(
      screen.getByText("settings:personalization.editor.unsavedTitle"),
    ).toBeTruthy();
    // 继续编辑：关闭确认、弹窗仍在
    fireEvent.click(
      screen.getByRole("button", { name: "settings:personalization.editor.keepEditing" }),
    );
    expect(screen.getByDisplayValue("改了")).toBeTruthy();
    // 再次取消 → 丢弃：确认后真正关闭
    fireEvent.click(screen.getByRole("button", { name: "settings:personalization.editor.cancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "settings:personalization.editor.discard" }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app-settings/long-text-editor-dialog.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: Write implementation + i18n keys**

先在两个 settings.json 中新增（`error` 对象之后、`shortcut` 之前插入 `personalization` 对象；Task 6 会继续在同对象内补 key——本任务只加弹窗所需子集，**注意 `personalization` 对象本任务就建立**）：

`src-react/i18n/locales/zh-CN/settings.json` 新增：

```json
  "personalization": {
    "charCount": "{{count}} / {{max}}",
    "savedToast": "保存成功",
    "editor": {
      "save": "保存",
      "cancel": "取消",
      "unsavedTitle": "放弃未保存的修改？",
      "unsavedBody": "关闭后本次修改将丢失。",
      "discard": "丢弃修改",
      "keepEditing": "继续编辑"
    }
  },
```

`src-react/i18n/locales/en-US/settings.json` 新增：

```json
  "personalization": {
    "charCount": "{{count}} / {{max}}",
    "savedToast": "Saved",
    "editor": {
      "save": "Save",
      "cancel": "Cancel",
      "unsavedTitle": "Discard unsaved changes?",
      "unsavedBody": "Your edits will be lost if you close now.",
      "discard": "Discard changes",
      "keepEditing": "Keep editing"
    }
  },
```

`src-react/domains/app-settings/components/LongTextEditorDialog.tsx`：

```tsx
/**
 * 大文本编辑弹窗（人设/记忆共用，spec §5.1）：受控 Textarea（maxLength
 * 参数化）+ 字数统计 + 取消/保存。保存成功 → toast + 关闭；失败 → toast
 * 保持打开（编辑内容不丢）。存在未保存修改时关闭 → AlertDialog 二次确认。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface LongTextEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 弹窗标题（已翻译文本） */
  title: string;
  /** 编辑初始值（每次打开重置为该值） */
  initialValue: string;
  maxLength: number;
  /** 持久化回调（reject = 失败，弹窗保持打开并 toast error） */
  onSave: (value: string) => Promise<void>;
}

export default function LongTextEditorDialog({
  open,
  onOpenChange,
  title,
  initialValue,
  maxLength,
  onSave,
}: LongTextEditorDialogProps) {
  const { t } = useTranslation(["settings"]);
  const [draft, setDraft] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // 每次打开重置草稿（关闭期间外部 initialValue 变化同步不到草稿）
  useEffect(() => {
    if (open) {
      setDraft(initialValue);
    }
  }, [open, initialValue]);

  const dirty = draft !== initialValue;

  /** 保存：成功 toast + 关闭；失败 toast + 保持打开 */
  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft.trim());
      toast.success(t("settings:personalization.savedToast"));
      onOpenChange(false);
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  /** 关闭请求：干净直接关，脏态先确认 */
  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true);
    } else {
      onOpenChange(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="max-w-3xl h-[70vh] p-0 gap-0 flex flex-col overflow-hidden">
          <DialogHeader className="px-6 py-4 border-b border-border/50">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={maxLength}
              aria-label={title}
              className="min-h-full resize-none font-mono text-xs leading-relaxed"
            />
          </div>
          <div className="flex items-center justify-between border-t border-border/50 px-6 py-3">
            <span className="text-xs text-muted-foreground">
              {t("settings:personalization.charCount", {
                count: draft.length,
                max: maxLength,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={requestClose}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("settings:personalization.editor.cancel")}
              </Button>
              <Button
                disabled={!dirty || saving}
                onClick={() => void handleSave()}
              >
                {t("settings:personalization.editor.save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:personalization.editor.unsavedTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:personalization.editor.unsavedBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            >
              {t("settings:personalization.editor.discard")}
            </AlertDialogAction>
            <AlertDialogAction onClick={() => setConfirmDiscard(false)}>
              {t("settings:personalization.editor.keepEditing")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app-settings/long-text-editor-dialog.test.tsx`
Expected: PASS（全部用例）

- [ ] **Step 5: Lint + typecheck + commit**

```bash
npm run lint && npm run typecheck
git add src-react/domains/app-settings/components/LongTextEditorDialog.tsx src-react/i18n/locales/zh-CN/settings.json src-react/i18n/locales/en-US/settings.json tests/app-settings/long-text-editor-dialog.test.tsx
git commit -m "feat(personalization): 大文本编辑弹窗（人设/记忆共用，脏态确认）"
```

---

### Task 6: 个性化设置页（ProfileGroup）+ 启用 profile 导航

**Files:**
- Create: `src-react/domains/app-settings/components/ProfileGroup.tsx`
- Modify: `src-react/domains/app-settings/components/SettingsDialog.tsx`（NAV_ITEMS `profile` 项 `disabled: false`；`SettingsTabId` 加 `"profile"`；右栏条件渲染）
- Modify: `src-react/i18n/locales/zh-CN/settings.json`、`src-react/i18n/locales/en-US/settings.json`（补全 `personalization.*` 其余 key；`nav.profile` 文案改「个性化」/"Personalization"）
- Test: `tests/app-settings/personalization-group.test.tsx`（新）；`tests/app-settings/settings-dialog.test.tsx`（既有，更新 profile 断言）

**Interfaces:**
- Consumes: Task 4 模型全部导出；Task 5 `LongTextEditorDialog`；既有 `SettingsGroup`（props `{ title: string; children?: ReactNode }`）、`SettingSwitchRow`（props `{ label; description; checked; onCheckedChange }`）、`useSaveOrRevert()`（`(save: Promise<void>, revert: () => void) => void`）、`SettingsApi`
- Produces: `ProfileGroup`（默认导出，无 props，整页渲染）；React Query 缓存约定：读 `queryKey: ["personalization"]`（queryFn `SettingsApi.getAll()`，`staleTime: Infinity`），任何保存成功后 `invalidateQueries({ queryKey: ["personalization"] })`——Task 7 的 `usePersonalizationUi` 依赖同一 key

- [ ] **Step 1: Write the failing test**

`tests/app-settings/personalization-group.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * ProfileGroup 交互测试：默认渲染、风格切换、开关保存、指令/称呼保存按钮
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const setMock = vi.fn(async () => undefined);
let mockItems: Array<{ name: string; value: string }> = [];

vi.mock("../../src-react/domains/app-settings/api/settings.api", () => ({
  SettingsApi: {
    getAll: vi.fn(async () => mockItems),
    set: (name: string, value: string) => setMock(name, value),
  },
}));

import ProfileGroup from "../../src-react/domains/app-settings/components/ProfileGroup";

function renderGroup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProfileGroup />
    </QueryClientProvider>,
  );
}

describe("ProfileGroup", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it("默认渲染：四分组标题 + 风格显示默认 + 未设置占位", async () => {
    renderGroup();
    expect(
      screen.getByText("settings:personalization.groups.basic"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.groups.instructions"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.groups.identity"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.groups.advanced"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.persona.empty"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.memory.empty"),
    ).toBeTruthy();
  });

  it("切换风格 → 立即保存 snarky", async () => {
    renderGroup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /settings:personalization.style.options.default.label/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /style.options.default.label/ }));
    fireEvent.click(screen.getByText("settings:personalization.style.options.snarky.label"));
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.responseStyle",
        "snarky",
      ),
    );
  });

  it("切换开关 → 保存字面布尔字符串", async () => {
    renderGroup();
    const switches = await screen.findAllByRole("switch");
    // 默认：欢迎语 ON（切到 OFF）、文件详情 OFF（切到 ON）
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.welcomeLoading",
        "false",
      ),
    );
    fireEvent.click(switches[1]);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.fileChangeDetails",
        "true",
      ),
    );
  });

  it("自定义指令：输入后保存按钮可用并提交 trim 内容", async () => {
    renderGroup();
    const textarea = await screen.findByLabelText(
      "settings:personalization.customInstructions.label",
    );
    const saveButton = screen.getAllByRole("button", {
      name: "settings:personalization.editor.save",
    })[0];
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(textarea, { target: { value: "  先给结论  " } });
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.customInstructions",
        "先给结论",
      ),
    );
  });
});
```

同时检查既有 `tests/app-settings/settings-dialog.test.tsx`：其中若断言 profile 导航为 disabled/「敬请期待」，更新为可点击断言（点开后渲染 ProfileGroup 的分组标题）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app-settings/personalization-group.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: Write implementation + i18n + SettingsDialog wiring**

i18n 增量——`zh-CN/settings.json`：`nav.profile` 改为 `"个性化"`；`personalization` 对象补全为：

```json
  "personalization": {
    "charCount": "{{count}} / {{max}}",
    "savedToast": "保存成功",
    "groups": {
      "basic": "基础交互",
      "instructions": "自定义指令",
      "identity": "称呼与身份",
      "advanced": "高级人设与记忆"
    },
    "style": {
      "label": "回复风格",
      "options": {
        "default": { "label": "默认", "desc": "不设定特定风格" },
        "professional": { "label": "专业严谨", "desc": "清晰、准确、值得信赖" },
        "friendly": { "label": "亲和友善", "desc": "温暖、平易近人、鼓励支持" },
        "direct": { "label": "直言不讳", "desc": "简明扼要、直击要点" },
        "imaginative": { "label": "天马行空", "desc": "富有想象力、善用比喻类比" },
        "pragmatic": { "label": "高效务实", "desc": "最少文字、最大信息量" },
        "snarky": { "label": "毒舌吐槽", "desc": "犀利吐槽、但绝不伤人" },
        "socratic": { "label": "启发引导", "desc": "用提问引导思考、授人以渔" }
      }
    },
    "welcomeLoading": {
      "label": "加载欢迎语",
      "desc": "AI 响应较久时轮换显示随机问候语，缓解等待焦虑"
    },
    "fileChangeDetails": {
      "label": "展示文件变更过程详情",
      "desc": "AI 执行文件操作时实时展开操作步骤；历史消息不受影响"
    },
    "customInstructions": {
      "label": "自定义指令",
      "desc": "全局生效的补充规则，自动拼接在每次对话中",
      "placeholder": "如：回答先给结论再展开；始终使用 Python 代码示例"
    },
    "userNickname": {
      "label": "Tianshu 对你的称呼",
      "desc": "AI 在对话中以此称呼你",
      "placeholder": "留空则使用默认称呼"
    },
    "aiName": {
      "label": "Tianshu 的名字",
      "desc": "AI 在对话中的自称，默认「天枢」",
      "placeholder": "天枢"
    },
    "persona": {
      "label": "人设 / 人格描述",
      "desc": "AI 的底层 System Prompt，定义其世界观与行为准则",
      "empty": "未设置，点击编辑启用"
    },
    "memory": {
      "label": "长期记忆",
      "desc": "希望 AI 永远记住的信息，每轮对话自动携带",
      "empty": "暂无内容，点击编辑添加"
    },
    "edit": "编辑",
    "editor": {
      "save": "保存",
      "cancel": "取消",
      "unsavedTitle": "放弃未保存的修改？",
      "unsavedBody": "关闭后本次修改将丢失。",
      "discard": "丢弃修改",
      "keepEditing": "继续编辑"
    }
  },
```

`en-US/settings.json` 对应英文（`nav.profile` 改 `"Personalization"`）：

```json
  "personalization": {
    "charCount": "{{count}} / {{max}}",
    "savedToast": "Saved",
    "groups": {
      "basic": "Basics",
      "instructions": "Custom Instructions",
      "identity": "Names & Identity",
      "advanced": "Persona & Memory"
    },
    "style": {
      "label": "Response style",
      "options": {
        "default": { "label": "Default", "desc": "No specific style" },
        "professional": { "label": "Professional", "desc": "Clear, accurate, trustworthy" },
        "friendly": { "label": "Friendly", "desc": "Warm, approachable, supportive" },
        "direct": { "label": "Straightforward", "desc": "Concise, straight to the point" },
        "imaginative": { "label": "Imaginative", "desc": "Rich metaphors and analogies" },
        "pragmatic": { "label": "Pragmatic", "desc": "Minimal words, maximum information" },
        "snarky": { "label": "Snarky", "desc": "Sharp wit, never hurtful" },
        "socratic": { "label": "Socratic", "desc": "Guide thinking with questions" }
      }
    },
    "welcomeLoading": {
      "label": "Loading greetings",
      "desc": "Show rotating greetings while the AI is taking longer to respond"
    },
    "fileChangeDetails": {
      "label": "Show file operation details",
      "desc": "Expand file tool steps in real time; history messages stay collapsed"
    },
    "customInstructions": {
      "label": "Custom instructions",
      "desc": "Global rules appended to every conversation",
      "placeholder": "e.g. Lead with the conclusion; always use Python examples"
    },
    "userNickname": {
      "label": "What Tianshu calls you",
      "desc": "How the AI addresses you in conversations",
      "placeholder": "Leave empty for the default"
    },
    "aiName": {
      "label": "Tianshu's name",
      "desc": "How the AI refers to itself; default is Tianshu",
      "placeholder": "Tianshu"
    },
    "persona": {
      "label": "Persona description",
      "desc": "The AI's underlying system prompt: worldview and behavior",
      "empty": "Not set — click edit to enable"
    },
    "memory": {
      "label": "Long-term memory",
      "desc": "Facts the AI should always remember, injected every turn",
      "empty": "Nothing yet — click edit to add"
    },
    "edit": "Edit",
    "editor": {
      "save": "Save",
      "cancel": "Cancel",
      "unsavedTitle": "Discard unsaved changes?",
      "unsavedBody": "Your edits will be lost if you close now.",
      "discard": "Discard changes",
      "keepEditing": "Keep editing"
    }
  },
```

`src-react/domains/app-settings/components/ProfileGroup.tsx`：

```tsx
/**
 * 个性化设置页（profile tab 整页，spec §5.2）：基础交互（风格+两开关）/
 * 自定义指令/称呼与身份/高级人设与记忆。
 * 配置存 option 表（personalization.* 前缀）；读走 React Query
 * ["personalization"] 缓存（staleTime Infinity），保存成功后失效——
 * 聊天界面两个 UI 开关（Task 7 usePersonalizationUi）即时生效。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Pencil } from "lucide-react";

import { SettingsApi } from "../api/settings.api";
import { useSaveOrRevert } from "../model/use-save-or-revert";
import {
  DEFAULT_PERSONA,
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalizationOptions,
  parsePersonalizationOptions,
  savePersonalizationOption,
  type PersonalizationOptions,
  type ResponseStyle,
} from "../model/personalization-options";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingsGroup from "./SettingsGroup";
import SettingSwitchRow from "./SettingSwitchRow";
import LongTextEditorDialog from "./LongTextEditorDialog";

/** 风格下拉可选项（展示顺序即选项顺序） */
const STYLE_OPTIONS: ResponseStyle[] = [
  "default",
  "professional",
  "friendly",
  "direct",
  "imaginative",
  "pragmatic",
  "snarky",
  "socratic",
];

/** 高级区摘要截断长度 */
const SUMMARY_SLICE = 60;

/** 单项持久化函数类型（key 取前端 PERSONALIZATION_KEYS） */
type PersistFn = (
  key: keyof typeof PERSONALIZATION_KEYS,
  value: string | boolean,
) => Promise<void>;

interface SectionProps {
  options: PersonalizationOptions;
  /** 静默持久化（保存 + 失效缓存，不 toast）——反馈由调用处自定 */
  persistQuiet: PersistFn;
}

export default function ProfileGroup() {
  const { t } = useTranslation(["settings"]);
  const queryClient = useQueryClient();
  const { data: items } = useQuery({
    queryKey: ["personalization"],
    queryFn: () => SettingsApi.getAll(),
    staleTime: Infinity,
  });
  const options = useMemo(
    () =>
      items
        ? parsePersonalizationOptions(items)
        : defaultPersonalizationOptions(),
    [items],
  );
  const revert = useSaveOrRevert();

  const persistQuiet = useCallback<PersistFn>(
    async (key, value) => {
      await savePersonalizationOption(key, value);
      await queryClient.invalidateQueries({ queryKey: ["personalization"] });
    },
    [queryClient],
  );

  /** 控件直存路径：成功 toast（失败由调用方 revert 兜底或 catch toast） */
  const persist = useCallback<PersistFn>(
    async (key, value) => {
      await persistQuiet(key, value);
      toast.success(t("settings:personalization.savedToast"));
    },
    [persistQuiet, t],
  );

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("settings:personalization.groups.basic")}>
        <StyleSection options={options} persist={persist} revert={revert} />
        <ToggleSection options={options} persist={persist} revert={revert} />
      </SettingsGroup>
      <SettingsGroup
        title={t("settings:personalization.groups.instructions")}
      >
        <InstructionsSection options={options} persistQuiet={persistQuiet} />
      </SettingsGroup>
      <SettingsGroup title={t("settings:personalization.groups.identity")}>
        <IdentitySection options={options} persistQuiet={persistQuiet} />
      </SettingsGroup>
      <SettingsGroup title={t("settings:personalization.groups.advanced")}>
        <AdvancedSection options={options} persistQuiet={persistQuiet} />
      </SettingsGroup>
    </div>
  );
}

/** 基础交互：回复风格下拉（选中即存）+ 当前风格描述小字 */
function StyleSection({
  options,
  persist,
  revert,
}: SectionProps & {
  persist: PersistFn;
  revert: (save: Promise<void>, rollback: () => void) => void;
}) {
  const { t } = useTranslation(["settings"]);
  const [style, setStyle] = useState(options.responseStyle);
  useEffect(() => setStyle(options.responseStyle), [options.responseStyle]);

  const changeStyle = (value: ResponseStyle) => {
    const rollback = () => setStyle(options.responseStyle);
    setStyle(value);
    revert(persist(PERSONALIZATION_KEYS.responseStyle, value), rollback);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-normal">
          {t("settings:personalization.style.label")}
        </Label>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-40 justify-between font-normal hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              {t(`settings:personalization.style.options.${style}.label`)}
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 border border-border/50 rounded-lg shadow-lg"
          >
            {STYLE_OPTIONS.map((value) => (
              <DropdownMenuItem
                key={value}
                onClick={() => changeStyle(value)}
                className="cursor-pointer"
              >
                {t(`settings:personalization.style.options.${value}.label`)}
                {value === style && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(`settings:personalization.style.options.${style}.desc`)}
      </p>
    </div>
  );
}

/** 基础交互：两个开关行（乐观更新 + 失败回滚） */
function ToggleSection({
  options,
  persist,
  revert,
}: SectionProps & {
  persist: PersistFn;
  revert: (save: Promise<void>, rollback: () => void) => void;
}) {
  const [welcomeLoading, setWelcomeLoading] = useState(
    options.welcomeLoading,
  );
  const [fileChangeDetails, setFileChangeDetails] = useState(
    options.fileChangeDetails,
  );
  useEffect(() => setWelcomeLoading(options.welcomeLoading), [
    options.welcomeLoading,
  ]);
  useEffect(() => setFileChangeDetails(options.fileChangeDetails), [
    options.fileChangeDetails,
  ]);

  const changeWelcome = (checked: boolean) => {
    setWelcomeLoading(checked);
    revert(
      persist(PERSONALIZATION_KEYS.welcomeLoading, checked),
      () => setWelcomeLoading(!checked),
    );
  };
  const changeFileDetails = (checked: boolean) => {
    setFileChangeDetails(checked);
    revert(
      persist(PERSONALIZATION_KEYS.fileChangeDetails, checked),
      () => setFileChangeDetails(!checked),
    );
  };

  return (
    <>
      <SettingSwitchRow
        label="settings:personalization.welcomeLoading.label"
        description="settings:personalization.welcomeLoading.desc"
        checked={welcomeLoading}
        onCheckedChange={changeWelcome}
      />
      <SettingSwitchRow
        label="settings:personalization.fileChangeDetails.label"
        description="settings:personalization.fileChangeDetails.desc"
        checked={fileChangeDetails}
        onCheckedChange={changeFileDetails}
      />
    </>
  );
}

/** 自定义指令：Textarea + 字数统计 + 显式保存按钮 */
function InstructionsSection({
  options,
  persistQuiet,
}: SectionProps) {
  const { t } = useTranslation(["settings"]);
  const limit = PERSONALIZATION_LIMITS.customInstructions;
  const [draft, setDraft] = useState(options.customInstructions);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(options.customInstructions), [
    options.customInstructions,
  ]);
  const dirty = draft !== options.customInstructions;

  const save = async () => {
    setSaving(true);
    try {
      await persistQuiet(PERSONALIZATION_KEYS.customInstructions, draft);
      toast.success(t("settings:personalization.savedToast"));
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-normal">
        {t("settings:personalization.customInstructions.label")}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t("settings:personalization.customInstructions.desc")}
      </p>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={limit}
        placeholder={t("settings:personalization.customInstructions.placeholder")}
        aria-label={t("settings:personalization.customInstructions.label")}
        className="min-h-24"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {t("settings:personalization.charCount", {
            count: draft.length,
            max: limit,
          })}
        </span>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {t("settings:personalization.editor.save")}
        </Button>
      </div>
    </div>
  );
}

/** 称呼与身份：两个 Input + 保存按钮（一次保存两个字段，单次 toast） */
function IdentitySection({ options, persistQuiet }: SectionProps) {
  const { t } = useTranslation(["settings"]);
  const [nickname, setNickname] = useState(options.userNickname);
  const [aiName, setAiName] = useState(options.aiName);
  const [saving, setSaving] = useState(false);
  useEffect(() => setNickname(options.userNickname), [options.userNickname]);
  useEffect(() => setAiName(options.aiName), [options.aiName]);
  const dirty =
    nickname !== options.userNickname || aiName !== options.aiName;

  const save = async () => {
    setSaving(true);
    try {
      await persistQuiet(PERSONALIZATION_KEYS.userNickname, nickname);
      await persistQuiet(PERSONALIZATION_KEYS.aiName, aiName);
      toast.success(t("settings:personalization.savedToast"));
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-normal">
          {t("settings:personalization.userNickname.label")}
        </Label>
        <Input
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          maxLength={PERSONALIZATION_LIMITS.userNickname}
          placeholder={t("settings:personalization.userNickname.placeholder")}
          aria-label={t("settings:personalization.userNickname.label")}
          className="w-64"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-sm font-normal">
          {t("settings:personalization.aiName.label")}
        </Label>
        <Input
          value={aiName}
          onChange={(event) => setAiName(event.target.value)}
          maxLength={PERSONALIZATION_LIMITS.aiName}
          placeholder={t("settings:personalization.aiName.placeholder")}
          aria-label={t("settings:personalization.aiName.label")}
          className="w-64"
        />
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {t("settings:personalization.editor.save")}
        </Button>
      </div>
    </div>
  );
}

/** 高级人设与记忆：摘要行 + 编辑弹窗（人设未设置时预填 DEFAULT_PERSONA） */
function AdvancedSection({ options, persistQuiet }: SectionProps) {
  const { t } = useTranslation(["settings"]);
  const [editing, setEditing] = useState<"persona" | "memory" | null>(null);
  const personaEmpty = options.persona.trim() === "";
  const memoryEmpty = options.memory.trim() === "";

  const savePersona = async (value: string) => {
    await persistQuiet(PERSONALIZATION_KEYS.persona, value);
  };
  const saveMemory = async (value: string) => {
    await persistQuiet(PERSONALIZATION_KEYS.memory, value);
  };

  return (
    <>
      <SummaryRow
        label={t("settings:personalization.persona.label")}
        description={t("settings:personalization.persona.desc")}
        summary={
          personaEmpty
            ? t("settings:personalization.persona.empty")
            : options.persona.slice(0, SUMMARY_SLICE)
        }
        onEdit={() => setEditing("persona")}
      />
      <SummaryRow
        label={t("settings:personalization.memory.label")}
        description={t("settings:personalization.memory.desc")}
        summary={
          memoryEmpty
            ? t("settings:personalization.memory.empty")
            : options.memory.slice(0, SUMMARY_SLICE)
        }
        onEdit={() => setEditing("memory")}
      />
      <LongTextEditorDialog
        open={editing === "persona"}
        onOpenChange={(open) => !open && setEditing(null)}
        title={t("settings:personalization.persona.label")}
        initialValue={personaEmpty ? DEFAULT_PERSONA : options.persona}
        maxLength={PERSONALIZATION_LIMITS.persona}
        onSave={savePersona}
      />
      <LongTextEditorDialog
        open={editing === "memory"}
        onOpenChange={(open) => !open && setEditing(null)}
        title={t("settings:personalization.memory.label")}
        initialValue={options.memory}
        maxLength={PERSONALIZATION_LIMITS.memory}
        onSave={saveMemory}
      />
    </>
  );
}

/** 高级区单行：标题 + 说明 + 摘要（60 字截断）+ 编辑按钮 */
function SummaryRow({
  label,
  description,
  summary,
  onEdit,
}: {
  label: string;
  description: string;
  summary: string;
  onEdit: () => void;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-sm font-normal">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
        <p className="truncate text-xs text-foreground/80">{summary}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onEdit}
        className="shrink-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
      >
        <Pencil className="h-3.5 w-3.5" />
        {t("settings:personalization.edit")}
      </Button>
    </div>
  );
}
```

`SettingsDialog.tsx` 三处修改：

(a) `type SettingsTabId = "general" | "profile" | "shortcuts";`

(b) NAV_ITEMS：`{ id: "profile", icon: UserRound, disabled: false },`

(c) 右栏条件渲染（现有 shortcuts 分支旁并列）：

```tsx
          {activeTab === "shortcuts" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ShortcutsGroup />
            </div>
          ) : activeTab === "profile" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ProfileGroup />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              <SettingsGroup title={t("settings:groups.general")}>
                <GeneralGroup />
              </SettingsGroup>
              <SettingsGroup title={t("settings:groups.permission")}>
                <PermissionsGroup />
              </SettingsGroup>
              <SettingsGroup title={t("settings:groups.storage")}>
                <StorageGroup />
              </SettingsGroup>
              <SettingsGroup title={t("settings:groups.notification")}>
                <NotificationsGroup />
              </SettingsGroup>
            </div>
          )}
```

并在文件头 import：`import ProfileGroup from "./ProfileGroup";`、注释更新（左栏导航不再有 profile 占位）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app-settings/personalization-group.test.tsx tests/app-settings/settings-dialog.test.tsx tests/app-settings/long-text-editor-dialog.test.tsx`
Expected: PASS（含更新后的 settings-dialog 断言）

- [ ] **Step 5: Full gates + commit**

```bash
npm run test && npm run lint && npm run typecheck
git add src-react/domains/app-settings/components/ProfileGroup.tsx src-react/domains/app-settings/components/SettingsDialog.tsx src-react/i18n/locales/zh-CN/settings.json src-react/i18n/locales/en-US/settings.json tests/app-settings/personalization-group.test.tsx tests/app-settings/settings-dialog.test.tsx
git commit -m "feat(settings): 个性化设置页（风格/开关/指令/称呼/人设记忆）并启用 profile 导航"
```

---

### Task 7: 加载欢迎语（use-personalization-ui + use-loading-phrase + ThinkingPanel）

**Files:**
- Create: `src-react/domains/ai/chat/hooks/use-personalization-ui.ts`
- Create: `src-react/domains/ai/chat/hooks/use-loading-phrase.ts`
- Modify: `src-react/domains/ai/chat/components/ThinkingPanel.tsx`（streaming 头部文案）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`（新增 `loadingPhrases` 数组）
- Test: `tests/ai/use-loading-phrase.test.tsx`

**Interfaces:**
- Consumes: `SettingsApi.getAll()`；`toOptionMap`/`parseBoolOption`（`@/domains/app-settings/model/app-options`）；Task 6 的查询缓存约定 `["personalization"]`
- Produces:
  - `usePersonalizationUi(): { welcomeLoading: boolean; fileChangeDetails: boolean }`（查询未就绪时回退默认 true/false）
  - `useLoadingPhrase(active: boolean): string | null`（active=false → null；true → 前 1.5s null、之后随机句、每 3s 换且不与上一句重复）
  - `pickPhrase(phrases: string[], exclude: string | null): string`（导出供测试）

- [ ] **Step 1: Write the failing test**

`tests/ai/use-loading-phrase.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * useLoadingPhrase hook 测试（fake timers）：1.5s 内 null、超时出句、
 * 3s 轮换不重复、active 结束复位
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.returnObjects ? ["甲", "乙", "丙"] : key,
  }),
}));

import {
  pickPhrase,
  useLoadingPhrase,
} from "../../src-react/domains/ai/chat/hooks/use-loading-phrase";

describe("pickPhrase", () => {
  it("排除上一句后随机取；池仅一句时允许重复", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickPhrase(["甲", "乙", "丙"], "甲")).toBe("乙");
    expect(pickPhrase(["仅此一句"], "仅此一句")).toBe("仅此一句");
    vi.restoreAllMocks();
  });
});

describe("useLoadingPhrase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it("inactive → 恒为 null", () => {
    const { result } = renderHook(() => useLoadingPhrase(false));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBeNull();
  });

  it("active 1.5s 内为 null，超时后出句（池序随机=0 → 甲）", () => {
    const { result } = renderHook(() => useLoadingPhrase(true));
    act(() => vi.advanceTimersByTime(1499));
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("甲");
  });

  it("每 3s 轮换且不与上一句重复（甲 → 乙）", () => {
    const { result } = renderHook(() => useLoadingPhrase(true));
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe("甲");
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe("乙");
  });

  it("active 变 false → 复位 null", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useLoadingPhrase(active),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe("甲");
    rerender({ active: false });
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/use-loading-phrase.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write hooks + ThinkingPanel + i18n**

`src-react/domains/ai/chat/hooks/use-personalization-ui.ts`：

```ts
/**
 * 聊天界面读取个性化 UI 开关（spec §5.4）：与设置页共享
 * ["personalization"] 查询缓存（staleTime Infinity），设置页保存后
 * invalidate → 下一次流式渲染即刻生效。查询未就绪回退默认值。
 */
import { useQuery } from "@tanstack/react-query";

import { SettingsApi } from "@/domains/app-settings/api/settings.api";
import {
  parseBoolOption,
  toOptionMap,
} from "@/domains/app-settings/model/app-options";

export interface PersonalizationUiFlags {
  welcomeLoading: boolean;
  fileChangeDetails: boolean;
}

const DEFAULT_FLAGS: PersonalizationUiFlags = {
  welcomeLoading: true,
  fileChangeDetails: false,
};

export function usePersonalizationUi(): PersonalizationUiFlags {
  const { data } = useQuery({
    queryKey: ["personalization"],
    queryFn: () => SettingsApi.getAll(),
    staleTime: Infinity,
    select: (items): PersonalizationUiFlags => {
      const map = toOptionMap(items);
      return {
        welcomeLoading: parseBoolOption(
          map["personalization.welcomeLoading"],
          DEFAULT_FLAGS.welcomeLoading,
        ),
        fileChangeDetails: parseBoolOption(
          map["personalization.fileChangeDetails"],
          DEFAULT_FLAGS.fileChangeDetails,
        ),
      };
    },
  });
  return data ?? DEFAULT_FLAGS;
}
```

`src-react/domains/ai/chat/hooks/use-loading-phrase.ts`：

```ts
/**
 * 加载欢迎语（spec §5.3A）：streaming 持续超过 1.5s 后从文案池随机取一句，
 * 每 3s 轮换（不与上一句重复）；active=false 即时复位 null。
 * 开关关闭（welcomeLoading=false）由调用方不激活本 hook 实现。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const PHRASE_DELAY_MS = 1500;
const PHRASE_ROTATE_MS = 3000;

/** 随机取句并排除上一句（池仅一句时允许重复） */
export function pickPhrase(
  phrases: string[],
  exclude: string | null,
): string {
  const pool =
    phrases.length > 1 && exclude
      ? phrases.filter((phrase) => phrase !== exclude)
      : phrases;
  return pool[Math.floor(Math.random() * pool.length)] ?? "";
}

export function useLoadingPhrase(active: boolean): string | null {
  const { t } = useTranslation(["chat"]);
  const [phrase, setPhrase] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setPhrase(null);
      return;
    }
    const phrases = t("chat:loadingPhrases", {
      returnObjects: true,
    }) as string[];
    const rotate = () => setPhrase((prev) => pickPhrase(phrases, prev));
    const showTimer = window.setTimeout(rotate, PHRASE_DELAY_MS);
    const rotateTimer = window.setInterval(rotate, PHRASE_ROTATE_MS);
    return () => {
      window.clearTimeout(showTimer);
      window.clearInterval(rotateTimer);
    };
  }, [active, t]);

  return phrase;
}
```

`zh-CN/chat.json` 顶层新增：

```json
  "loadingPhrases": [
    "正在思考中…",
    "马上就好…",
    "快想出来了…",
    "正在整理思路…",
    "让我确认一下…",
    "正在组织语言…"
  ],
```

`en-US/chat.json` 顶层新增：

```json
  "loadingPhrases": [
    "Thinking hard...",
    "Almost there...",
    "Just a moment...",
    "Putting it together...",
    "Let me double-check...",
    "Wrapping it up..."
  ],
```

`ThinkingPanel.tsx` 修改（imports + streaming 头部）：

```tsx
// 新增 import
import { useLoadingPhrase } from "../hooks/use-loading-phrase";
import { usePersonalizationUi } from "../hooks/use-personalization-ui";
```

组件体内（`const [open, setOpen] = useState(defaultOpen);` 之后）：

```tsx
  // 加载欢迎语（spec §5.3A）：开关开 → 1.5s 后轮换问候语；关 → 仅 spinner 无文字
  const { welcomeLoading } = usePersonalizationUi();
  const phrase = useLoadingPhrase(status === "streaming" && welcomeLoading);
```

streaming 头部（`{t("chat:panel.thinkingStatus")}` 替换为）：

```tsx
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {welcomeLoading ? (phrase ?? t("chat:panel.thinkingStatus")) : null}
```

（done 态分支不动。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ai/use-loading-phrase.test.tsx`
Expected: PASS

- [ ] **Step 5: Full gates + commit**

```bash
npm run test && npm run lint && npm run typecheck
git add src-react/domains/ai/chat/hooks/use-personalization-ui.ts src-react/domains/ai/chat/hooks/use-loading-phrase.ts src-react/domains/ai/chat/components/ThinkingPanel.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/use-loading-phrase.test.tsx
git commit -m "feat(chat): 加载欢迎语（1.5s 超时随机轮换，可关闭）"
```

---

### Task 8: 文件变更详情开关（ToolCallCard defaultOpen）

**Files:**
- Modify: `src-react/domains/ai/chat/components/ToolCallCard.tsx`（新增 `defaultOpen` prop；导出 `extractPath`）
- Modify: `src-react/domains/ai/chat/components/ThinkingPanel.tsx`（流式实例给文件类工具卡片传 `defaultOpen`）
- Test: `tests/ai/tool-call-card-default-open.test.tsx`

**Interfaces:**
- Consumes: Task 7 `usePersonalizationUi().fileChangeDetails`；ToolCallCard 现有 `extractPath(args: unknown): string | null`
- Produces: `ToolCallCardProps` 增加 `defaultOpen?: boolean`；`extractPath` 改为具名导出（`export function extractPath`）

- [ ] **Step 1: Write the failing test**

`tests/ai/tool-call-card-default-open.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * ToolCallCard defaultOpen 单测：挂载初始展开态由 prop 控制
 * （details.open 为初始 attribute，用户手动切换不受 React 干预）
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import ToolCallCard from "../../src-react/domains/ai/chat/components/ToolCallCard";

function renderCard(defaultOpen?: boolean) {
  const { container } = render(
    <ToolCallCard
      toolName="write_file"
      args={{ path: "src/a.ts" }}
      state="running"
      defaultOpen={defaultOpen}
    />,
  );
  return container.querySelector("details") as HTMLDetailsElement;
}

describe("ToolCallCard defaultOpen", () => {
  it("缺省 → 折叠", () => {
    expect(renderCard().open).toBe(false);
  });

  it("defaultOpen=true → 初始展开（args/output 可见）", () => {
    const details = renderCard(true);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("src/a.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/tool-call-card-default-open.test.tsx`
Expected: FAIL（`defaultOpen` prop 不存在，TS 报错或 open 恒 false；断言 `renderCard(true).open === true` 失败）

- [ ] **Step 3: Write implementation**

`ToolCallCard.tsx` 两处修改：

(a) props 接口与 `extractPath` 导出（注释同步）：

```tsx
interface ToolCallCardProps {
  toolName: string;
  args?: unknown;
  /** 主进程透传的状态字符串（渲染层不做枚举收窄，未知值按 ready 兜底） */
  state: string;
  output?: string;
  /**
   * 挂载初始展开（文件变更详情开关：流式期文件类工具自动展开）。
   * details.open 为初始 attribute——用户手动切换后 DOM 自管
   */
  defaultOpen?: boolean;
}

/** 取卡片头摘要：优先 args.path；无 path 的工具（如 run_command）取 args.command 前 60 字符 */
export function extractPath(args: unknown): string | null {
```

（`extractPath` 函数体不变，仅加 `export`。）

(b) 组件签名加 `defaultOpen`，渲染处：

```tsx
function ToolCallCardImpl({
  toolName,
  args,
  state,
  output,
  defaultOpen,
}: ToolCallCardProps) {
```

```tsx
    <details className={containerClass} open={defaultOpen}>
```

`ThinkingPanel.tsx` 的工具列表渲染处（现有 `tools.map` 替换为）：

```tsx
          {tools.map((tool, index) => (
            <ToolCallCard
              key={`${index}-${tool.toolName}`}
              {...tool}
              defaultOpen={
                status === "streaming" &&
                fileChangeDetails &&
                extractPath(tool.args) !== null
              }
            />
          ))}
```

配套修改：组件体内 `const { welcomeLoading } = usePersonalizationUi();` 改为 `const { welcomeLoading, fileChangeDetails } = usePersonalizationUi();`；顶部 `import ToolCallCard from "./ToolCallCard";` 改为 `import ToolCallCard, { extractPath } from "./ToolCallCard";`；文件头注释补一句「文件变更详情开关（spec §5.3B）：仅流式实例的文件类卡片自动展开，落库面板保持折叠」。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ai/tool-call-card-default-open.test.tsx tests/ai/use-loading-phrase.test.tsx`
Expected: PASS

- [ ] **Step 5: Full gates + commit**

```bash
npm run test && npm run lint && npm run typecheck
git add src-react/domains/ai/chat/components/ToolCallCard.tsx src-react/domains/ai/chat/components/ThinkingPanel.tsx tests/ai/tool-call-card-default-open.test.tsx
git commit -m "feat(chat): 文件变更过程详情开关（流式文件类工具卡片自动展开）"
```

---

## 执行后手工冒烟（可选但推荐）

`npm run dev` 启动应用：
1. 设置 → 个性化：切换风格/开关、填指令与称呼、编辑人设（预填英文文案）与记忆，保存均有 toast；
2. 对话发送消息：响应 >1.5s 后出现轮换问候语；设置里关闭「加载欢迎语」后再发送 → 仅 spinner；
3. agent 模式绑定目录后让 AI 读/写文件：开启「展示文件变更过程详情」→ 流式期工具卡片自动展开；关闭后恢复折叠；历史消息始终折叠；
4. 验证 prompt 生效：开新会话问 AI「你怎么称呼我/你自己」，确认风格与称呼变化生效。
