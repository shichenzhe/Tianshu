# 模型设置页重设计（主从双栏）· 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/module/ai/providers` 从「嵌套表格」重构为主从双栏布局，并新增四协议「拉取模型列表」能力。

**Architecture:** 前端重组为 ProviderList（左列）/ProviderDetail + ModelList（右列）组件树，OllamaImportDialog 泛化为 RemoteModelImportDialog；后端 connectivity.ts 新增 `listRemoteModels`（openai-compatible/anthropic/gemini/ollama 四协议 fetch）经 `model:listRemote` IPC 暴露，返回结构化 `ListRemoteResult`（连通性失败为预期结果）。API 层其余不动。

**Tech Stack:** Electron 主进程 TypeScript + fetch、React 19 + React Query + shadcn/ui、react-i18next、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-07-provider-settings-redesign-design.md`（本计划从 spec 推导，执行者需同时阅读）

## Global Constraints

- 工作区有他人未提交改动（git status 大量 M）：**每次 commit 只 `git add` 本任务清单内的文件**，绝不 `git add -A`；共享文件（ai.json 等）带入少量他人既有改动属已接受范围
- i18n：新增用户可见文案全部 `t()`，key 放 `ai` namespace，zh-CN 与 en-US **两文件同步**；顶层 key 不得与嵌套对象重名；禁止 JSX/JS 硬编码中英文。组件任务先写 `t()` 调用，i18n key 统一在 Task 7 补齐（中间 commit 缺文案可接受，组件测试断言用 key/数字不依赖文案）
- 样式：颜色只用主题变量（`bg-primary`/`bg-primary-subtle`/`text-muted-foreground`/`bg-destructive` 等），禁止 `bg-blue-*` 等硬编码色类；卡片 `border-border/50 rounded-lg`；悬停 `hover:bg-primary-subtle hover:text-primary`
- 变量 `camelCase`、文件名 `kebab-case`；注释中文、说明「为什么」
- 测试命令：`npx vitest run <file>`；全量 `npm run test`；类型检查 `npm run typecheck`；全绿才 commit
- 样式参考基线：`src-react/domains/ai/automation/components/AutomationStatsPanel.tsx`（卡片/KPI 风格）、`src-react/domains/ai/monitor/views/MonitorView.tsx`（双栏/空态风格）
- `import type` 单独写（仓库风格：`import type { X } from ...`）

---

### Task 1: 后端 listRemoteModels（四协议）+ IPC + 前端 API

**Files:**
- Modify: `src-react/domains/ai/api/model.api.ts`（+RemoteModel/ListRemoteResult 类型 + ModelApi.listRemote）
- Modify: `electron/domains/ai/provider/connectivity.ts`（+joinUrl +listRemoteModels）
- Modify: `electron/domains/ai/provider/model.repo.ts`（+listRemote 方法 + IPC 注册）
- Modify: `electron/commons/ipc-channels.ts`（白名单 +model:listRemote）
- Test: `tests/ai/connectivity.test.ts`（扩展）

**Interfaces:**
- Consumes: `ProviderRuntimeInfo`（`{ type: string; baseUrl: string; apiKey?: string; extraHeaders?: string | null }`，provider-factory.ts:10 已导出）；`parseExtraHeaders(extraHeaders?: string | null): Record<string,string>`（provider-factory.ts 已导出，畸形返回空对象）；`this.providerRepo.getRuntimeInfo(providerId)`（返回 `ProviderRuntimeInfo | null`）与 `assertOwned(providerId, userId)`
- Produces（后续任务依赖，签名一字不差）:

```ts
// model.api.ts（类型单一事实源，主进程 import type）
export interface RemoteModel {
  modelId: string;
  ownedBy?: string;
}
export interface ListRemoteResult {
  success: boolean;
  errorCode?: string;
  message: string;
  models: RemoteModel[];
}
// ModelApi 静态方法：
static async listRemote(providerId: number): Promise<ListRemoteResult>;

// connectivity.ts
export async function listRemoteModels(
  provider: ProviderRuntimeInfo,
): Promise<RemoteModel[]>;
```

- [ ] **Step 1: 写失败测试（connectivity.test.ts 扩展）**

在 `tests/ai/connectivity.test.ts` 末尾追加（fetch stub——Node 全局 fetch 直接赋值，测试后恢复；样式照该文件现有 describe/it）：

```ts
import {
  listRemoteModels,
  type RemoteModelLike,
} from "../../electron/domains/ai/provider/connectivity";

/** fetch stub：按 URL 前缀返回预设响应；记录调用供断言 */
function stubFetch(
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = routes.find((r) => r.match(u, init));
    if (!route) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("listRemoteModels", () => {
  it("openai-compatible：Bearer 头 + extraHeaders 合并，data[].id/owned_by", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/models"),
        status: 200,
        body: { data: [{ id: "m-a", owned_by: "qwen" }, { id: "", owned_by: "x" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "openai-compatible",
        baseUrl: "https://x.com/v1",
        apiKey: "sk-1",
        extraHeaders: '{"X-Custom":"c"}',
      });
      expect(models).toEqual([{ modelId: "m-a", ownedBy: "qwen" }]);
      const init = stub.calls[0].init;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-1");
      expect(headers["X-Custom"]).toBe("c");
      expect(stub.calls[0].url).toBe("https://x.com/v1/models");
    } finally {
      stub.restore();
    }
  });

  it("anthropic：x-api-key + anthropic-version，v1/models 路径", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/models"),
        status: 200,
        body: { data: [{ id: "claude-x", display_name: "Claude X" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "anthropic",
        baseUrl: "https://x.com",
        apiKey: "k",
      });
      expect(models).toEqual([{ modelId: "claude-x", ownedBy: "Claude X" }]);
      const headers = stub.calls[0].init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("k");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      stub.restore();
    }
  });

  it("gemini：key 入 query，models[].name 剥离 models/ 前缀", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.includes("/v1beta/models") && u.includes("key=K"),
        status: 200,
        body: { models: [{ name: "models/gemini-2.0" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "gemini",
        baseUrl: "https://x.com",
        apiKey: "K",
      });
      expect(models).toEqual([{ modelId: "gemini-2.0" }]);
    } finally {
      stub.restore();
    }
  });

  it("ollama：复用 /api/tags", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/api/tags"),
        status: 200,
        body: { models: [{ name: "llama3" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "ollama",
        baseUrl: "https://x.com",
      });
      expect(models).toEqual([{ modelId: "llama3" }]);
    } finally {
      stub.restore();
    }
  });

  it("非 2xx 抛 HTTP {status}（repo 层归类）", async () => {
    const stub = stubFetch([
      { match: (u) => u.endsWith("/models"), status: 401, body: {} },
    ]);
    try {
      await expect(
        listRemoteModels({ type: "openai-compatible", baseUrl: "https://x.com/v1", apiKey: "k" }),
      ).rejects.toThrow("HTTP 401");
    } finally {
      stub.restore();
    }
  });
});
```

注意：测试中 baseUrl 末尾无斜杠（`https://x.com/v1`）仍应拼出 `/v1/models`——joinUrl 负责补斜杠；anthropic/gemini 的 baseUrl 末尾无斜杠同理。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/connectivity.test.ts`
Expected: FAIL（listRemoteModels 未导出）

- [ ] **Step 3: 实现**

3a. `src-react/domains/ai/api/model.api.ts`：在 `OllamaRemoteModel` 接口后追加：

```ts
/** 远端模型（拉取模型列表结果项，type 定义单一事实源：主进程 import type） */
export interface RemoteModel {
  modelId: string;
  ownedBy?: string;
}

/** 拉取模型列表结构化结果（与 TestConnectionResult 同模式：连通失败是预期结果） */
export interface ListRemoteResult {
  success: boolean;
  errorCode?: string;
  message: string;
  models: RemoteModel[];
}
```

`ModelApi` 类内（listOllama 方法之后）加：

```ts
  static async listRemote(providerId: number): Promise<ListRemoteResult> {
    return invoke<ListRemoteResult>("model:listRemote", providerId);
  }
```

3b. `electron/domains/ai/provider/connectivity.ts`：文件头 import 区补 `import { parseExtraHeaders, type ProviderRuntimeInfo } from "./provider-factory";`（检查现有 import 合并）与 `import type { RemoteModel } from "../../../../src-react/domains/ai/api/model.api";`。文件末尾追加：

```ts
/** 相对路径拼接：base 末段不丢（"https://x/v1" + "models" → ".../v1/models"） */
function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/** 非流式模型列表请求超时（半开连接不得永久挂起，M7 同判词） */
const LIST_TIMEOUT_MS = 10_000;

/**
 * 拉取远端模型列表（spec §4.1）：四协议分派——openai-compatible
 * GET {base}/models（Bearer）、anthropic GET {base}/v1/models（x-api-key +
 * anthropic-version）、gemini GET {base}/v1beta/models?key=（name 剥
 * models/ 前缀）、ollama 复用 listOllamaModels。非 2xx 抛
 * Error("HTTP {status}")，由 repo 层 classifyError 归类。
 */
export async function listRemoteModels(
  provider: ProviderRuntimeInfo,
): Promise<RemoteModel[]> {
  const extra = parseExtraHeaders(provider.extraHeaders);
  if (provider.type === "ollama") {
    return listOllamaModels(provider.baseUrl);
  }
  let url: string;
  const headers: Record<string, string> = { ...extra };
  if (provider.type === "openai-compatible") {
    url = joinUrl(provider.baseUrl, "models");
    if (provider.apiKey) {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
  } else if (provider.type === "anthropic") {
    url = joinUrl(provider.baseUrl, "v1/models");
    headers["x-api-key"] = provider.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  } else {
    url = `${joinUrl(provider.baseUrl, "v1beta/models")}?key=${encodeURIComponent(provider.apiKey ?? "")}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return parseRemoteModels(provider.type, data);
}

/** 各协议响应 → RemoteModel[]（过滤空 id） */
function parseRemoteModels(
  type: string,
  data: Record<string, unknown>,
): RemoteModel[] {
  if (type === "openai-compatible" || type === "anthropic") {
    const rows = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    return rows
      .map((r) => ({
        modelId: String(r.id ?? ""),
        ownedBy: r.owned_by !== undefined ? String(r.owned_by) : r.display_name !== undefined ? String(r.display_name) : undefined,
      }))
      .filter((m) => m.modelId !== "");
  }
  const rows = (data.models as Array<Record<string, unknown>> | undefined) ?? [];
  return rows
    .map((r) => ({ modelId: String(r.name ?? "").replace(/^models\//, "") }))
    .filter((m) => m.modelId !== "");
}
```

3c. `electron/domains/ai/provider/model.repo.ts`：import 区补 `listRemoteModels`（connectivity）与 `import { classifyError } from "../chat/error-classify";` 与 `import type { ListRemoteResult, RemoteModel } from "../../../../src-react/domains/ai/api/model.api";`。`registerIpcHandlers` 里 `model:listOllama` 行后加：

```ts
    handleUser("model:listRemote", (_, userId, providerId: number) =>
      this.listRemote(providerId, userId),
    );
```

类内 `listOllama` 方法后加：

```ts
  /** 拉取远端模型列表（spec §4.2）：结构化结果——连通失败是预期结果
   *  而非异常，渲染端经 ai:errors.{code} 出文案 */
  async listRemote(providerId: number, userId: number): Promise<ListRemoteResult> {
    await this.providerRepo.assertOwned(providerId, userId);
    const provider = await this.providerRepo.getRuntimeInfo(providerId);
    if (!provider) {
      throw new Error("PROVIDER_MISSING");
    }
    try {
      const models: RemoteModel[] = await listRemoteModels(provider);
      return { success: true, message: "", models };
    } catch (e) {
      return {
        success: false,
        errorCode: classifyError(e),
        message: e instanceof Error ? e.message : String(e),
        models: [],
      };
    }
  }
```

3d. `electron/commons/ipc-channels.ts`：`"model:listOllama",` 行后加 `"model:listRemote",`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/ai/connectivity.test.ts && npm run typecheck`
Expected: 全 PASS、无类型错误

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/api/model.api.ts electron/domains/ai/provider/connectivity.ts electron/domains/ai/provider/model.repo.ts electron/commons/ipc-channels.ts tests/ai/connectivity.test.ts
git commit -m "feat(provider): model:listRemote 四协议拉取模型列表（结构化结果）"
```

---

### Task 2: model-summary 纯函数（参数摘要）

**Files:**
- Create: `src-react/domains/ai/provider/lib/model-summary.ts`
- Test: `tests/ai/model-summary.test.ts`

**Interfaces:**
- Consumes: `ModelRecord`（model.api.ts，字段 temperature/topP/maxTokens/contextWindow 均 `number | undefined`）
- Produces（Task 4 ModelList 依赖）:

```ts
export type ModelSummarySegment =
  | { key: "context"; value: string }
  | { key: "output"; value: string }
  | { key: "temperature"; value: string }
  | { key: "topP"; value: string };
/** 参数摘要段（空数组 = 全默认，渲染端显示「默认参数」）；
 *  value 为已格式化数字（1024 进制 K/M 缩写），label 由渲染端 t() 拼 */
export function buildModelSummary(
  model: Pick<ModelRecord, "temperature" | "topP" | "maxTokens" | "contextWindow">,
): ModelSummarySegment[];
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/model-summary.test.ts`：

```ts
// 参数摘要纯函数：仅显示非默认项（spec §3.1 摘要规则）
import { describe, expect, it } from "vitest";
import { buildModelSummary } from "../../src-react/domains/ai/provider/lib/model-summary";

const DEFAULTS = { contextWindow: 131072, maxTokens: 65536 };

describe("buildModelSummary", () => {
  it("全默认/全空 → 空数组", () => {
    expect(buildModelSummary({})).toEqual([]);
    expect(
      buildModelSummary({
        contextWindow: DEFAULTS.contextWindow,
        maxTokens: DEFAULTS.maxTokens,
      }),
    ).toEqual([]);
  });

  it("非默认上下文/输出 → K/M 缩写段", () => {
    expect(
      buildModelSummary({ contextWindow: 32768, maxTokens: 8192 }),
    ).toEqual([
      { key: "context", value: "32K" },
      { key: "output", value: "8K" },
    ]);
    expect(buildModelSummary({ contextWindow: 1048576 })).toEqual([
      { key: "context", value: "1M" },
    ]);
  });

  it("温度/topP 任意设置即显示（无默认值概念）", () => {
    expect(buildModelSummary({ temperature: 0.7 })).toEqual([
      { key: "temperature", value: "0.7" },
    ]);
    expect(buildModelSummary({ topP: 0.9, temperature: 1 })).toEqual([
      { key: "temperature", value: "1" },
      { key: "topP", value: "0.9" },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/model-summary.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src-react/domains/ai/provider/lib/model-summary.ts
/** 模型参数摘要（spec §3.1）：仅显示非默认项——与 ModelDialog 新建
 *  缺省值同源（128K/64K）；value 格式化，label 由渲染端 i18n 拼 */
import type { ModelRecord } from "../../api/model.api";

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 65536;

export type ModelSummarySegment =
  | { key: "context"; value: string }
  | { key: "output"; value: string }
  | { key: "temperature"; value: string }
  | { key: "topP"; value: string };

/** 1024 进制 K/M 缩写（32768 → "32K"；非整千保留有效位） */
function formatTokens(n: number): string {
  if (n >= 1048576 && n % 1048576 === 0) {
    return `${n / 1048576}M`;
  }
  if (n >= 1024 && n % 1024 === 0) {
    return `${n / 1024}K`;
  }
  return String(n);
}

export function buildModelSummary(
  model: Pick<ModelRecord, "temperature" | "topP" | "maxTokens" | "contextWindow">,
): ModelSummarySegment[] {
  const segments: ModelSummarySegment[] = [];
  if (model.contextWindow !== undefined && model.contextWindow !== DEFAULT_CONTEXT_WINDOW) {
    segments.push({ key: "context", value: formatTokens(model.contextWindow) });
  }
  if (model.maxTokens !== undefined && model.maxTokens !== DEFAULT_MAX_TOKENS) {
    segments.push({ key: "output", value: formatTokens(model.maxTokens) });
  }
  if (model.temperature !== undefined) {
    segments.push({ key: "temperature", value: String(model.temperature) });
  }
  if (model.topP !== undefined) {
    segments.push({ key: "topP", value: String(model.topP) });
  }
  return segments;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/model-summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/provider/lib/model-summary.ts tests/ai/model-summary.test.ts
git commit -m "feat(provider): 模型参数摘要纯函数（仅显非默认项）"
```

---

### Task 3: ProviderList 左列组件

**Files:**
- Create: `src-react/domains/ai/provider/components/ProviderList.tsx`
- Test: `tests/ai/provider-list.test.tsx`

**Interfaces:**
- Consumes: `ProviderRecord`（provider.api.ts：id/name/type/enabled 等字段）
- Produces（Task 6 View 依赖）:

```ts
export default function ProviderList(props: {
  providers: ProviderRecord[];
  modelCounts: Map<number, number>; // providerId → 模型数
  selectedId: number | null;
  totalModels: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/provider-list.test.tsx`（`// @vitest-environment jsdom` 文件头，参照 `tests/ai/monitor-view.test.tsx` 的 mock/断言风格；i18n 未初始化时 `t()` 返回 key 本身，断言锚 key/名称/数字）：

```tsx
// @vitest-environment jsdom
// ProviderList 纯展示：选中态回调、停用降透明、模型数 pill、汇总行
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ProviderList from "../../src-react/domains/ai/provider/components/ProviderList";
import type { ProviderRecord } from "../../src-react/domains/ai/api/provider.api";

function makeProvider(over: Partial<ProviderRecord>): ProviderRecord {
  return {
    id: 1, name: "P1", type: "openai-compatible", baseUrl: "https://x",
    enabled: true, createdAt: "", updatedAt: "",
    ...over,
  } as ProviderRecord;
}

describe("ProviderList", () => {
  const providers = [
    makeProvider({ id: 1, name: "硅基流动" }),
    makeProvider({ id: 2, name: "OpenAI" }),
    makeProvider({ id: 3, name: "Ollama 本地", enabled: false }),
  ];
  const counts = new Map([[1, 12], [2, 3], [3, 5]]);

  it("渲染全部服务商 + 模型数 + 汇总", () => {
    render(
      <ProviderList providers={providers} modelCounts={counts}
        selectedId={1} totalModels={20} onSelect={() => {}} onAdd={() => {}} />,
    );
    expect(screen.getByText("硅基流动")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText(/ai:provider.summary/)).toBeTruthy();
  });

  it("点击列表项回调 id；选中项带选中类", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ProviderList providers={providers} modelCounts={counts}
        selectedId={2} totalModels={20} onSelect={onSelect} onAdd={() => {}} />,
    );
    fireEvent.click(screen.getByText("硅基流动"));
    expect(onSelect).toHaveBeenCalledWith(1);
    const selected = container.querySelector("[data-selected='true']");
    expect(selected?.textContent).toContain("OpenAI");
  });

  it("停用服务商带停用标记；添加按钮回调", () => {
    const onAdd = vi.fn();
    render(
      <ProviderList providers={providers} modelCounts={counts}
        selectedId={1} totalModels={20} onSelect={() => {}} onAdd={onAdd} />,
    );
    expect(screen.getByText("ai:provider.disabledTag")).toBeTruthy();
    fireEvent.click(screen.getByText("ai:provider.add"));
    expect(onAdd).toHaveBeenCalled();
  });
});
```

（断言中 `ai:provider.add` 若与标题「服务商」同按钮渲染冲突，改为 `getByRole("button")` 定位；以实际渲染微调，断言锚定「按钮点击触发回调」）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/provider-list.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

```tsx
// src-react/domains/ai/provider/components/ProviderList.tsx
/** 左列服务商列表（spec §3.1）：点击即切详情；停用行降透明 + 微标 */
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderRecord } from "../../api/provider.api";

export default function ProviderList({
  providers,
  modelCounts,
  selectedId,
  totalModels,
  onSelect,
  onAdd,
}: {
  providers: ProviderRecord[];
  modelCounts: Map<number, number>;
  selectedId: number | null;
  totalModels: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation(["ai"]);
  return (
    <div className="flex w-56 shrink-0 flex-col rounded-lg border border-border/50 bg-card">
      <div className="flex items-center border-b border-border/50 px-3 py-2.5">
        <span className="flex-1 text-sm font-medium text-foreground">
          {t("ai:provider.masterTitle")}
        </span>
        <Button size="sm" className="h-7 px-2" onClick={onAdd}>
          <Plus className="h-3 w-3" />
          {t("ai:provider.add")}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            data-selected={selectedId === provider.id}
            onClick={() => onSelect(provider.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
              selectedId === provider.id
                ? "bg-primary-subtle text-primary"
                : "text-foreground hover:bg-primary-subtle/60"
            } ${provider.enabled ? "" : "opacity-55"}`}
          >
            <span className="flex-1 truncate">{provider.name}</span>
            {!provider.enabled && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("ai:provider.disabledTag")}
              </span>
            )}
            <span className="shrink-0 rounded-full border border-border/50 px-1.5 text-[10px] text-muted-foreground">
              {modelCounts.get(provider.id) ?? 0}
            </span>
          </button>
        ))}
        {providers.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            {t("ai:provider.empty")}
          </p>
        )}
      </div>
      <div className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
        {t("ai:provider.summary", {
          providers: providers.length,
          models: totalModels,
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/provider-list.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/provider/components/ProviderList.tsx tests/ai/provider-list.test.tsx
git commit -m "feat(provider): 左列服务商列表组件（选中/停用态/汇总）"
```

---

### Task 4: ModelList 模型行组件

**Files:**
- Create: `src-react/domains/ai/provider/components/ModelList.tsx`
- Test: `tests/ai/model-list.test.tsx`

**Interfaces:**
- Consumes: `ModelRecord`、`buildModelSummary`/`ModelSummarySegment`（Task 2）
- Produces（Task 6 依赖）:

```ts
export default function ModelList(props: {
  models: ModelRecord[];
  testingModelId: number | null;
  onToggle: (model: ModelRecord, enabled: boolean) => void;
  onTest: (model: ModelRecord) => void;
  onEdit: (model: ModelRecord) => void;
  onDelete: (model: ModelRecord) => void;
  onAdd: () => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/model-list.test.tsx`（jsdom 文件头 + testing-library，风格同 Task 3）：

```tsx
// @vitest-environment jsdom
// ModelList 纯展示：开关回调、参数摘要渲染（key 形式）、测试/编辑/删除回调、添加行
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelList from "../../src-react/domains/ai/provider/components/ModelList";
import type { ModelRecord } from "../../src-react/domains/ai/api/model.api";

function makeModel(over: Partial<ModelRecord>): ModelRecord {
  return {
    id: 1, providerId: 1, modelId: "m-a", enabled: true,
    createdAt: "", updatedAt: "",
    ...over,
  } as ModelRecord;
}

function findSwitch(row: HTMLElement): HTMLElement {
  return row.querySelector("[role='switch']") as HTMLElement;
}

function rowOf(container: HTMLElement, modelId: string): HTMLElement {
  return [...container.querySelectorAll("[data-model-row]")].find(
    (el) => el.getAttribute("data-model-row") === modelId,
  ) as HTMLElement;
}

describe("ModelList", () => {
  const models = [
    makeModel({ id: 1, modelId: "deepseek-v3", contextWindow: 32768, maxTokens: 8192 }),
    makeModel({ id: 2, modelId: "qwen-72b", enabled: false }),
  ];

  it("渲染 modelId + 参数摘要段（key 文案）+ 空数组时默认参数", () => {
    const { container } = render(
      <ModelList models={models} testingModelId={null}
        onToggle={() => {}} onTest={() => {}} onEdit={() => {}} onDelete={() => {}} onAdd={() => {}} />,
    );
    expect(screen.getByText("deepseek-v3")).toBeTruthy();
    // 摘要段 label 为 i18n key（未初始化返回 key 本身）
    expect(screen.getByText(/ai:model.summary.context/)).toBeTruthy();
    expect(screen.getByText("32K")).toBeTruthy();
    expect(screen.getByText("ai:model.defaultParams")).toBeTruthy();
  });

  it("开关点击回调 (model, enabled)；测试/编辑/删除/添加回调", () => {
    const onToggle = vi.fn();
    const onTest = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onAdd = vi.fn();
    const { container } = render(
      <ModelList models={models} testingModelId={null}
        onToggle={onToggle} onTest={onTest} onEdit={onEdit} onDelete={onDelete} onAdd={onAdd} />,
    );
    const row = rowOf(container, "deepseek-v3");
    fireEvent.click(findSwitch(row));
    expect(onToggle).toHaveBeenCalledWith(models[0], false);
    fireEvent.click(screen.getByText("ai:model.test").closest("button")!);
    expect(onTest).toHaveBeenCalledWith(models[0]);
    fireEvent.click(screen.getByText("ai:model.editAction").closest("button")!);
    expect(onEdit).toHaveBeenCalledWith(models[0]);
    fireEvent.click(screen.getByText("ai:model.deleteAction").closest("button")!);
    expect(onDelete).toHaveBeenCalledWith(models[0]);
    fireEvent.click(screen.getByText("ai:model.addManually").closest("button")!);
    expect(onAdd).toHaveBeenCalled();
  });

  it("testingModelId 命中行禁用测试并显示测试中文案", () => {
    render(
      <ModelList models={models} testingModelId={1}
        onToggle={() => {}} onTest={() => {}} onEdit={() => {}} onDelete={() => {}} onAdd={() => {}} />,
    );
    expect(screen.getByText("ai:model.testing")).toBeTruthy();
  });
});
```

（`ai:model.editAction`/`ai:model.deleteAction` 为 Task 7 新增 key——本任务按钮用 `t("ai:model.editAction")` 文案与 aria-label 同 key，确保测试可锚定；若测试因 aria-label 定位更稳，可改 `getByRole("button", { name: "ai:model.editAction" })`）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/model-list.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

```tsx
// src-react/domains/ai/provider/components/ModelList.tsx
/** 模型卡片行列表（spec §3.1）：开关 + modelId + 参数摘要 + 操作；
 *  摘要仅显示非默认项（buildModelSummary），全默认显示「默认参数」 */
import { useTranslation } from "react-i18next";
import { Edit, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ModelRecord } from "../../api/model.api";
import { buildModelSummary } from "../lib/model-summary";

const SEGMENT_LABEL: Record<string, string> = {
  context: "ai:model.summary.context",
  output: "ai:model.summary.output",
  temperature: "ai:model.summary.temperature",
  topP: "ai:model.summary.topP",
};

export default function ModelList({
  models,
  testingModelId,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  onAdd,
}: {
  models: ModelRecord[];
  testingModelId: number | null;
  onToggle: (model: ModelRecord, enabled: boolean) => void;
  onTest: (model: ModelRecord) => void;
  onEdit: (model: ModelRecord) => void;
  onDelete: (model: ModelRecord) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation(["ai", "common"]);
  return (
    <div className="flex flex-col gap-1.5">
      {models.map((model) => {
        const segments = buildModelSummary(model);
        return (
          <div
            key={model.id}
            data-model-row={model.modelId}
            className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-card px-3 py-2"
          >
            <Switch
              checked={model.enabled}
              onCheckedChange={(enabled) => onToggle(model, enabled)}
              aria-label={t("ai:provider.enabled")}
            />
            <span
              className="w-52 shrink-0 truncate font-mono text-sm text-foreground"
              title={model.modelId}
            >
              {model.modelId}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {segments.length === 0
                ? t("ai:model.defaultParams")
                : segments
                    .map((s) => t(SEGMENT_LABEL[s.key], { value: s.value }))
                    .join(" · ")}
            </span>
            <Button
              variant="ghost" size="sm" className="h-7 hover:bg-primary-subtle hover:text-primary"
              disabled={testingModelId === model.id}
              onClick={() => onTest(model)}
            >
              <Play className="mr-1 h-3 w-3" />
              {testingModelId === model.id ? t("ai:model.testing") : t("ai:model.test")}
            </Button>
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 hover:bg-primary-subtle hover:text-primary"
              aria-label={t("ai:model.editAction")}
              onClick={() => onEdit(model)}
            >
              <Edit className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 hover:bg-primary-subtle hover:text-destructive"
              aria-label={t("ai:model.deleteAction")}
              onClick={() => onDelete(model)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary-subtle/50 hover:text-primary"
      >
        <Plus className="h-3 w-3" />
        {t("ai:model.addManually")}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/model-list.test.tsx tests/ai/model-summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/provider/components/ModelList.tsx tests/ai/model-list.test.tsx
git commit -m "feat(provider): 模型卡片行组件（开关/参数摘要/操作）"
```

---

### Task 5: RemoteModelImportDialog（Ollama 导入泛化）

**Files:**
- Create: `src-react/domains/ai/provider/components/RemoteModelImportDialog.tsx`
- Delete: `src-react/domains/ai/provider/components/OllamaImportDialog.tsx`
- Test: `tests/ai/remote-model-import.test.tsx`

**Interfaces:**
- Consumes: `ModelApi.listRemote`/`ListRemoteResult`/`RemoteModel`（Task 1）、`ProviderRecord`
- Produces（Task 6 依赖）:

```ts
export default function RemoteModelImportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderRecord | null;
  existingModelIds: string[]; // 该服务商已导入的 modelId（置灰排末尾）
}): JSX.Element;
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/remote-model-import.test.tsx`（mock ModelApi 模块——照 `tests/ai/monitor-view.test.tsx` 的 vi.mock 模式）：

```tsx
// @vitest-environment jsdom
// RemoteModelImportDialog：拉取结果勾选导入；已导入置灰排末尾；错误态重试
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listRemote = vi.fn();
const create = vi.fn();
vi.mock("../../src-react/domains/ai/api/model.api", () => ({
  default: { listRemote: (...a: unknown[]) => listRemote(...a), create: (...a: unknown[]) => create(...a) },
}));

import RemoteModelImportDialog from "../../src-react/domains/ai/provider/components/RemoteModelImportDialog";
import type { ProviderRecord } from "../../src-react/domains/ai/api/provider.api";

const provider = {
  id: 7, name: "硅基流动", type: "openai-compatible", baseUrl: "https://x",
  enabled: true, createdAt: "", updatedAt: "",
} as ProviderRecord;

function renderDialog(existing: string[] = ["qwen-72b"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RemoteModelImportDialog
        open onOpenChange={() => {}} provider={provider} existingModelIds={existing}
      />
    </QueryClientProvider>,
  );
}

describe("RemoteModelImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({});
  });

  it("渲染远端列表：未导入可勾选，已导入置灰排末尾", async () => {
    listRemote.mockResolvedValue({
      success: true, models: [
        { modelId: "deepseek-v3" },
        { modelId: "qwen-72b" },
        { modelId: "glm-4.6" },
      ],
    });
    renderDialog();
    expect(await screen.findByText("deepseek-v3")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows[rows.length - 1].textContent).toContain("qwen-72b");
    expect(rows[rows.length - 1].textContent).toContain("ai:model.imported");
  });

  it("勾选两个 → 导入按钮计数 2 → 逐个 create(providerId, modelId)", async () => {
    listRemote.mockResolvedValue({
      success: true, models: [{ modelId: "deepseek-v3" }, { modelId: "glm-4.6" }, { modelId: "qwen-72b" }],
    });
    renderDialog();
    fireEvent.click(await screen.findByText("deepseek-v3"));
    fireEvent.click(screen.getByText("glm-4.6"));
    const importBtn = screen.getByText(/ai:model.importSelected/).closest("button")!;
    expect(importBtn.textContent).toContain("2");
    fireEvent.click(importBtn);
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    expect(create).toHaveBeenCalledWith({ providerId: 7, modelId: "deepseek-v3" });
  });

  it("拉取失败 → 错误态 + 重试按钮", async () => {
    listRemote.mockResolvedValue({ success: false, errorCode: "AUTH_FAILED", message: "HTTP 401", models: [] });
    renderDialog();
    expect(await screen.findByText(/ai:errors.AUTH_FAILED/)).toBeTruthy();
    expect(screen.getByText("ai:model.retry")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/remote-model-import.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现（以 OllamaImportDialog.tsx 全文为骨架改造）**

先 Read `src-react/domains/ai/provider/components/OllamaImportDialog.tsx`（140 行），按以下差异改造为新文件 `RemoteModelImportDialog.tsx`（其余逻辑——勾选集合、导入循环、invalidate、关闭——保留原样）：

- 数据源：`ModelApi.listOllama(providerId)` → `ModelApi.listRemote(providerId)`；queryKey `["ollama-models", providerId]` → `["remote-models", providerId]`
- 结果形状：`listRemote` 返回 `ListRemoteResult`——`const remote = remoteQuery.data;` 后按 `!remote?.success` 渲染错误态（`t(`ai:errors.${remote.errorCode ?? "UNKNOWN"}`)` + 原始 message 小字 + 「重试」按钮调 `remoteQuery.refetch()`）；成功态模型列表 = `remote.models`
- props：`providerId: number` → `provider: ProviderRecord | null`（导入 create 用 `provider.id`，标题 `t("ai:model.importTitle", { name: provider.name })`）；新增 `existingModelIds: string[]`
- 列表排序：`[...models].sort((a, b) => Number(existing.has(a.modelId)) - Number(existing.has(b.modelId)))`（existing = `new Set(existingModelIds)`）
- 已导入行：`disabled` + opacity-50 + 行尾 `t("ai:model.imported")` 标签，不参与勾选与全选
- 全选：只选未导入项
- 空态：`t("ai:model.fetchEmpty")`（替代 `ollamaEmpty`）
- 导入循环：`ModelApi.create({ providerId: provider.id, modelId })`（保持原参数形状——以原文件实际调用为准）
- 标题/按钮 i18n：`importTitle`/`importSelected`（复用现有 key，count 插值）/`importSuccess`（复用）/新增 `retry`、`fetchEmpty`、`imported`

完成后删除 `OllamaImportDialog.tsx`（`grep -rn "OllamaImportDialog" src-react tests` 确认仅本任务移除引用；tests 无引用已核实）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/remote-model-import.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/provider/components/RemoteModelImportDialog.tsx tests/ai/remote-model-import.test.tsx
git rm src-react/domains/ai/provider/components/OllamaImportDialog.tsx
git commit -m "feat(provider): 拉取模型对话框泛化（四协议 + 已导入置灰 + 错误态重试）"
```

---

### Task 6: ProviderDetail + View 双栏重写 + Dialog 毛刺修复

**Files:**
- Create: `src-react/domains/ai/provider/components/ProviderDetail.tsx`
- Rewrite: `src-react/domains/ai/provider/views/ProviderSettingsView.tsx`
- Modify: `src-react/domains/ai/provider/components/ProviderDialog.tsx`（+取消按钮 +onCreated +文案）
- Modify: `src-react/domains/ai/provider/components/ModelDialog.tsx`（文案统一）
- Test: `tests/ai/provider-view-master-detail.test.tsx`

**Interfaces:**
- Consumes: `ProviderList`（Task 3）、`ModelList`（Task 4）、`RemoteModelImportDialog`（Task 5）、`buildModelSummary`（Task 2）、`ProviderApi`/`ModelApi`/`ProviderDialog`/`ModelDialog`
- Produces: `ProviderDialog` 新增可选 prop `onCreated?: (id: number) => void`（create 成功后以新 record.id 回调，随后才关弹窗）——供 View 自动选中新服务商

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/provider-view-master-detail.test.tsx`（mock 三个 api 模块 + 子组件保留真实实现——ProviderList/ModelList 是纯展示可直接渲染）：

```tsx
// @vitest-environment jsdom
// 双栏壳：默认选中首个、切换选中、模型开关乐观更新与回滚、删除服务商回落
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const providerList = vi.fn(async () => [
  { id: 1, name: "P1", type: "openai-compatible", baseUrl: "https://x/1", enabled: true, createdAt: "", updatedAt: "" },
  { id: 2, name: "P2", type: "ollama", baseUrl: "https://x/2", enabled: true, createdAt: "", updatedAt: "" },
]);
const modelListAll = vi.fn(async () => [
  { id: 11, providerId: 1, modelId: "m-a", enabled: true, createdAt: "", updatedAt: "" },
  { id: 12, providerId: 1, modelId: "m-b", enabled: false, createdAt: "", updatedAt: "" },
]);
const modelUpdate = vi.fn();
vi.mock("../../src-react/domains/ai/api/provider.api", () => ({
  default: { list: (...a: unknown[]) => providerList(...a) },
}));
vi.mock("../../src-react/domains/ai/api/model.api", () => ({
  default: { listAll: (...a: unknown[]) => modelListAll(...a), update: (...a: unknown[]) => modelUpdate(...a) },
}));

import ProviderSettingsView from "../../src-react/domains/ai/provider/views/ProviderSettingsView";

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderSettingsView />
    </QueryClientProvider>,
  );
}

describe("ProviderSettingsView 双栏", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelUpdate.mockResolvedValue({});
  });

  it("默认选中首个服务商：右栏显示其 baseUrl 与模型行", async () => {
    renderView();
    expect(await screen.findByText("https://x/1")).toBeTruthy();
    expect(screen.getByText("m-a")).toBeTruthy();
    expect(screen.getByText("m-b")).toBeTruthy();
  });

  it("点击左列切换：右栏切换为 P2（无模型 → 空态文案）", async () => {
    renderView();
    await screen.findByText("https://x/1");
    fireEvent.click(screen.getByText("P2"));
    expect(screen.getByText("https://x/2")).toBeTruthy();
    expect(screen.queryByText("m-a")).toBeNull();
  });

  it("模型开关：乐观翻转 + model:update 调用", async () => {
    const { container } = renderView();
    await screen.findByText("m-a");
    const row = [...container.querySelectorAll("[data-model-row='m-a']")][0] as HTMLElement;
    const sw = row.querySelector("[role='switch']") as HTMLElement;
    fireEvent.click(sw);
    await waitFor(() => {
      expect(modelUpdate).toHaveBeenCalledWith({ id: 11, enabled: false });
    });
  });

  it("模型开关失败：回滚 + 不抛错", async () => {
    modelUpdate.mockRejectedValue(new Error("MODEL_MISSING"));
    const { container } = renderView();
    await screen.findByText("m-a");
    const row = [...container.querySelectorAll("[data-model-row='m-a']")][0] as HTMLElement;
    fireEvent.click(row.querySelector("[role='switch']") as HTMLElement);
    await waitFor(() => {
      expect(modelUpdate).toHaveBeenCalled();
    });
    // 回滚后开关仍为开（aria-checked 不变）
    expect(row.querySelector("[role='switch']")?.getAttribute("aria-checked")).toBe("true");
  });
});
```

（usePageHeader 是 zustand store 调用，测试环境可直接运行——若报错则 vi.mock `@/components/layout/page-header.store`；ModelDialog/RemoteModelImportDialog/AlertDialog 在本测试不触发打开，无需 mock）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/provider-view-master-detail.test.tsx`
Expected: FAIL（View 仍是表格版无 data-model-row）

- [ ] **Step 3: 实现 ProviderDetail.tsx**

```tsx
// src-react/domains/ai/provider/components/ProviderDetail.tsx
/** 右栏详情（spec §3.1）：详情头（名称/类型/地址/开关/编辑/删除）+
 *  拉取行（拉取动作兼任连接测试）+ ModelList */
import { useTranslation } from "react-i18next";
import { Edit, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ProviderRecord } from "../../api/provider.api";
import type { ModelRecord } from "../../api/model.api";
import ModelList from "./ModelList";

export default function ProviderDetail({
  provider,
  models,
  testingModelId,
  onToggleEnabled,
  onEdit,
  onDelete,
  onFetchRemote,
  onToggleModel,
  onTestModel,
  onEditModel,
  onDeleteModel,
  onAddModel,
}: {
  provider: ProviderRecord;
  models: ModelRecord[];
  testingModelId: number | null;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onFetchRemote: () => void;
  onToggleModel: (model: ModelRecord, enabled: boolean) => void;
  onTestModel: (model: ModelRecord) => void;
  onEditModel: (model: ModelRecord) => void;
  onDeleteModel: (model: ModelRecord) => void;
  onAddModel: () => void;
}) {
  const { t } = useTranslation(["ai"]);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-card px-4 py-3">
        <span className="truncate text-sm font-semibold text-foreground">
          {provider.name}
        </span>
        <Badge variant="secondary">{provider.type}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {provider.baseUrl}
        </span>
        <Switch
          checked={provider.enabled}
          onCheckedChange={onToggleEnabled}
          aria-label={t("ai:provider.enabled")}
        />
        <Button
          variant="outline" size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={onEdit}
        >
          <Edit className="mr-1 h-3 w-3" />
          {t("ai:provider.editConnection")}
        </Button>
        <Button
          variant="ghost" size="sm" className="h-7 w-7 p-0 hover:bg-primary-subtle hover:text-destructive"
          aria-label={t("common:delete")}
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex items-center gap-2.5">
        <Button size="sm" onClick={onFetchRemote}>
          <RefreshCw className="mr-1 h-3 w-3" />
          {t("ai:model.fetchRemote")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("ai:model.fetchRemoteHint")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {models.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
            <span>{t("ai:provider.emptyDetail")}</span>
            <Button variant="outline" size="sm" onClick={onFetchRemote}
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30">
              {t("ai:model.fetchRemote")}
            </Button>
          </div>
        ) : (
          <ModelList
            models={models}
            testingModelId={testingModelId}
            onToggle={onToggleModel}
            onTest={onTestModel}
            onEdit={onEditModel}
            onDelete={onDeleteModel}
            onAdd={onAddModel}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 重写 ProviderSettingsView.tsx**

保留：两个 query、`usePageHeader`、`handleError`、`toggleEnabled`、`handleTest`、两个删除 AlertDialog、ProviderDialog/ModelDialog 挂载。重写主体：

```tsx
// 状态（替代原 expandedId/ollamaProviderId）：
const [selectedId, setSelectedId] = useState<number | null>(null);
const [importOpen, setImportOpen] = useState(false);
// 其余 dialog 状态保留（providerDialogOpen/editingProvider/modelDialog/deletingProvider/deletingModel/testingModelId）

const providers = providersQuery.data ?? [];
const models = modelsQuery.data ?? [];
const modelCounts = useMemo(
  () => models.reduce((m, x) => m.set(x.providerId, (m.get(x.providerId) ?? 0) + 1), new Map<number, number>()),
  [models],
);
const selected = providers.find((p) => p.id === selectedId) ?? null;

// 默认选中：数据就绪且未选中（或选中项已不存在）→ 首个
useEffect(() => {
  if (providers.length > 0 && !providers.some((p) => p.id === selectedId)) {
    setSelectedId(providers[0].id);
  }
}, [providers, selectedId]);
```

主体 JSX（`<div className="p-6">` 内）：

```tsx
{providersQuery.isPending ? (
  /* 原加载态保留 */
) : providersQuery.isError ? (
  /* 原错误态保留 */
) : providers.length === 0 ? (
  /* 原空态 Card 保留（openCreate 引导） */
) : (
  <div className="flex h-[calc(100vh-8.5rem)] gap-4">
    <ProviderList
      providers={providers}
      modelCounts={modelCounts}
      selectedId={selectedId}
      totalModels={models.length}
      onSelect={setSelectedId}
      onAdd={openCreate}
    />
    {selected ? (
      <ProviderDetail
        provider={selected}
        models={models.filter((m) => m.providerId === selected.id)}
        testingModelId={testingModelId}
        onToggleEnabled={(enabled) => toggleEnabled(selected, enabled)}
        onEdit={() => openEdit(selected)}
        onDelete={() => setDeletingProvider(selected)}
        onFetchRemote={() => setImportOpen(true)}
        onToggleModel={handleToggleModel}
        onTestModel={handleTest}
        onEditModel={openEditModel}
        onDeleteModel={setDeletingModel}
        onAddModel={() => openAddModel(selected.id)}
      />
    ) : (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
        {t("ai:provider.selectFirst")}
      </div>
    )}
  </div>
)}
```

新增乐观开关（View 内）：

```tsx
  /** 模型开关：乐观翻转 → update → 失败回滚 + toast（spec §5） */
  const handleToggleModel = async (model: ModelRecord, enabled: boolean) => {
    const snapshot = models;
    queryClient.setQueryData<ModelRecord[]>(MODELS_KEY, (rows) =>
      (rows ?? []).map((r) => (r.id === model.id ? { ...r, enabled } : r)),
    );
    try {
      await ModelApi.update({ id: model.id, enabled });
    } catch (e) {
      queryClient.setQueryData(MODELS_KEY, snapshot);
      handleError(e);
    }
  };
```

删除服务商回落：`handleDeleteProvider` 的 invalidate 后追加 `setSelectedId(null)`（useEffect 自动重选首个）。

挂载 RemoteModelImportDialog 替代 OllamaImportDialog：

```tsx
<RemoteModelImportDialog
  open={importOpen}
  onOpenChange={setImportOpen}
  provider={selected}
  existingModelIds={selected ? models.filter((m) => m.providerId === selected.id).map((m) => m.modelId) : []}
/>
```

import 清理：删除 FolderOpen 引用，新增 ProviderList/ProviderDetail/RemoteModelImportDialog、useEffect/useMemo、ModelRecord type。

- [ ] **Step 5: ProviderDialog 修复 + onCreated**

`ProviderDialog.tsx`：
- props 加 `onCreated?: (id: number) => void;`
- `handleSubmit` 的 create 分支改为 `const created = await ProviderApi.create({...});`（现有 create 调用捕获返回值——其返回 `ProviderRecord` 含 id），成功后 invalidate 完成时 `onCreated?.(created.id);` 再 `onOpenChange(false);`
- DialogFooter 改为（补取消，提交态统一）：

```tsx
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t("common:saving") : t("common:confirm")}
          </Button>
        </DialogFooter>
```

View 挂载处：`onCreated={(id) => setSelectedId(id)}`。

`ModelDialog.tsx`：提交按钮 `submitting ? t("common:saving") : t("common:confirm")`（替换 `t("common:ok")`）。

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/ai/provider-view-master-detail.test.tsx tests/ai/provider-list.test.tsx tests/ai/model-list.test.tsx tests/ai/remote-model-import.test.tsx && npm run typecheck`
Expected: 全 PASS、无类型错误（View 重写后旧表格测试若存在会暴露——`grep -rln "ProviderSettingsView" tests/` 先查，若有旧测试引用嵌套表格结构则更新为新结构断言）

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/provider/components/ProviderDetail.tsx src-react/domains/ai/provider/views/ProviderSettingsView.tsx src-react/domains/ai/provider/components/ProviderDialog.tsx src-react/domains/ai/provider/components/ModelDialog.tsx tests/ai/provider-view-master-detail.test.tsx
git commit -m "feat(provider): 主从双栏重构（选中态/乐观开关/创建自动选中/弹窗毛刺修复）"
```

---

### Task 7: i18n 双语 key + 废弃清理 + 全量回归

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/ai.json`、`src-react/i18n/locales/en-US/ai.json`

**Interfaces:**
- Consumes: Task 3-6 全部 `t()` 引用的 key
- Produces: 无（终端任务）

- [ ] **Step 1: 汇总引用 key**

`grep -rhoE 'ai:(provider|model)\.[a-zA-Z.]+' src-react/domains/ai/provider | sort -u` 列出组件实际引用的全部 key，与 ai.json 现有 `provider`/`model` 子树比对得出缺失清单。

- [ ] **Step 2: zh-CN/ai.json 补 key**

`provider` 对象内新增（保持既有缩进逗号风格；不与顶层/嵌套重名）：

```json
"masterTitle": "服务商",
"summary": "共 {{providers}} 个服务商 · {{models}} 个模型",
"disabledTag": "已停用",
"editConnection": "编辑连接",
"emptyDetail": "还没有模型，从服务商拉取或手动添加",
"selectFirst": "选择左侧服务商查看详情"
```

`model` 对象内新增：

```json
"fetchRemote": "从服务商拉取模型",
"fetchRemoteHint": "拉取成功即代表连接可用；失败会提示原因",
"addManually": "手动添加模型",
"defaultParams": "默认参数",
"fetchEmpty": "远端没有可导入的模型",
"importTitle": "从 {{name}} 拉取模型",
"imported": "已导入",
"retry": "重试",
"editAction": "编辑",
"deleteAction": "删除",
"summary": {
  "context": "上下文 {{value}}",
  "output": "输出 {{value}}",
  "temperature": "T {{value}}",
  "topP": "topP {{value}}"
}
```

- [ ] **Step 3: en-US/ai.json 同构补 key**

```json
"masterTitle": "Providers",
"summary": "{{providers}} providers · {{models}} models",
"disabledTag": "Disabled",
"editConnection": "Edit connection",
"emptyDetail": "No models yet — fetch from provider or add manually",
"selectFirst": "Select a provider to view details"
```

```json
"fetchRemote": "Fetch models from provider",
"fetchRemoteHint": "A successful fetch also verifies connectivity; failures show the reason",
"addManually": "Add model manually",
"defaultParams": "Default params",
"fetchEmpty": "No models available to import",
"importTitle": "Fetch models from {{name}}",
"imported": "Imported",
"retry": "Retry",
"editAction": "Edit",
"deleteAction": "Delete",
"summary": {
  "context": "Context {{value}}",
  "output": "Output {{value}}",
  "temperature": "T {{value}}",
  "topP": "topP {{value}}"
}
```

- [ ] **Step 4: 废弃 key 清理**

`grep -rn "manageModels\|importOllama\|ollamaEmpty" src-react` 确认零引用后，从两份 ai.json 删除 `provider.manageModels`、`model.importOllama`、`model.ollamaEmpty`（`model.importSelected`/`importSuccess` 被泛化对话框复用，保留）。

- [ ] **Step 5: 校验 + 全量回归**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-react/i18n/locales/zh-CN/ai.json'));JSON.parse(require('fs').readFileSync('src-react/i18n/locales/en-US/ai.json'));console.log('ok')"`
Run: `npm run test && npm run typecheck`
Expected: `ok` + 全量测试全绿 + 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src-react/i18n/locales/zh-CN/ai.json src-react/i18n/locales/en-US/ai.json
git commit -m "feat(provider): 双栏重构双语文案与废弃 key 清理"
```

---

## 执行注意（所有任务通用）

1. **先读后写**：修改既有文件前先 Read 目标区段；行号为计划快照，以 grep 为准
2. **工作区脏**：commit 严格按各任务 add 清单；`git rm` 仅 Task 5 一处
3. **测试先行**：每任务先写测试跑失败再实现；测试断言锚 key/数字/role，不依赖 i18n 文案值
4. 卡住时照 spec 与相邻先例（AutomationStatsPanel/MonitorView/monitor-view.test.tsx）调整实现细节，不改对外接口；仍无法解决在报告中如实标注
5. GUI 手动验收跳过（用户 `npm run dev` 自验）：验收点——双栏切换、四类协议拉取、开关乐观更新、创建后自动选中、语言切换文案跟随
