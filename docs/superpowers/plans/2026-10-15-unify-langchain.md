# 统一 LLM 栈到 LangChain 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 Vercel AI SDK 五个依赖，全部模型调用（流式 agent 循环 + 非流式补全 + 连通探测）收敛到 LangChain 单栈。

**Architecture:** 模型工厂合一到 `langchain-model-factory`；工具层复用既有 `toLangChainTools` 装配器；chat 流式循环从 `streamText` 换 `createReactAgent + streamEvents`，经新映射层 `agent-chunk-emitter` 归一回现有 onChunk 协议（前端零改动）。

**Tech Stack:** @langchain/core 1.2.x、@langchain/langgraph 1.4.x（锁 minor）、zod 4、vitest。

**Spec:** `docs/superpowers/specs/2026-10-15-unify-langchain-design.md`（执行每个任务前先读 spec 对应节）

## Global Constraints

- 前端与 onChunk/blocks 协议（`electron/domains/ai/chat/blocks.ts` 五种块类型）零改动
- 工具安全门语义不变：一切工具执行经 `runToolCall`（命令门/文件门/审批/审计）
- MCP SDK（`@modelcontextprotocol/sdk`）用法与 external 化不动
- 不留 AI SDK 兼容层（A3）：类型层一并切换，禁止 re-export 过渡
- 每任务结束跑 `npm run typecheck && npm run test`，绿了才 commit
- 所有非流式补全必须保留 AbortSignal 超时（M7 判词：半开连接不得永久挂起）
- @langchain/* 锁 minor：任务中不得升级 @langchain 系列版本（spec §6），版本演进走单独评审

---

## 第一期（T1）：非流式调用迁移 + 模型工厂解耦 + 解环

### Task 1: 抽公共 provider 运行时模块

**Files:**
- Create: `electron/domains/ai/provider/provider-runtime.ts`
- Modify: `electron/domains/ai/provider/provider-factory.ts`（删除搬走的定义）
- Modify: `electron/domains/ai/orchestration/langchain-model-factory.ts:10-13`（改 import 源）
- Modify: `electron/domains/ai/provider/connectivity.ts:4-8`（`parseExtraHeaders` 改从新模块 import，`createLanguageModel` 仍从 provider-factory）

**Interfaces:**
- Produces: `electron/domains/ai/provider/provider-runtime.ts` 导出 `ProviderType`、`ProviderRuntimeInfo`、`parseExtraHeaders(json?: string | null): Record<string, string>`——后续所有任务从此处 import

- [ ] **Step 1: 新建 provider-runtime.ts**

从 `provider-factory.ts` 原样搬出以下三段（不改任何实现，只改注释指向）：

```ts
/** Provider 协议类型与运行时信息（chat/orchestration/automation 共用，
 * 自 provider-factory 抽出以便单栈收敛，见 2026-10-15 spec §4.1） */
export type ProviderType =
  "openai-compatible" | "anthropic" | "gemini" | "ollama";

export interface ProviderRuntimeInfo {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
}

/** 解析 provider.extraHeaders JSON（畸形返回空对象） */
export function parseExtraHeaders(
  json?: string | null,
): Record<string, string> {
  if (!json) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: provider-factory.ts 删除搬走的定义，改为 re-import 供既有消费方**

```ts
export { parseExtraHeaders } from "./provider-runtime";
export type { ProviderRuntimeInfo, ProviderType } from "./provider-runtime";
```

注意：Task 6（T3 期）将整体删除 provider-factory.ts，此处 re-export 仅为 Task 1-5 期间减少改动面，**不是长期兼容层**。

- [ ] **Step 3: langchain-model-factory.ts 与 connectivity.ts 的 import 改指新模块**

langchain-model-factory.ts:10-13 改为：

```ts
import { parseExtraHeaders, type ProviderRuntimeInfo } from "../provider/provider-runtime";
```

connectivity.ts 顶部 import 拆开：`parseExtraHeaders` 与类型来自 `./provider-runtime`，`createLanguageModel` 仍来自 `./provider-factory`。

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npm run test`
Expected: 全绿（纯搬移，无行为变化）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/provider/provider-runtime.ts electron/domains/ai/provider/provider-factory.ts electron/domains/ai/orchestration/langchain-model-factory.ts electron/domains/ai/provider/connectivity.ts
git commit -m "refactor(ai): provider 运行时类型/extraHeaders 解析抽公共模块（T1-1）"
```

### Task 2: connectivity 非流式探测迁 LangChain

**Files:**
- Modify: `electron/domains/ai/provider/connectivity.ts:1-8,51-73`
- Test: `tests/ai/connectivity.test.ts`（现有，改 injectModel 替身形态）

**Interfaces:**
- Consumes: Task 1 的 `provider-runtime`；`langchain-model-factory.ts` 的 `createChatModel(provider: ProviderRuntimeInfo, modelId: string, temperature?: number): BaseChatModel`
- Produces: `TestConnectionOptions.injectModel?: BaseChatModel`（类型从 AI SDK `LanguageModel` 切换）

- [ ] **Step 1: 改测试（先失败）**

`tests/ai/connectivity.test.ts` 中 llm 探测用例的注入替身从 AI SDK 形态改为 LangChain 形态（用 `@langchain/core/utils/testing` 的 `FakeListChatModel`，responses 首条即成功）：

```ts
import { FakeListChatModel } from "@langchain/core/utils/testing";

const fakeModel = new FakeListChatModel({ responses: ["hi"] });
const result = await testConnection(provider, "m", { injectModel: fakeModel });
```

断言保持 `{ success: true }` 原样。错误路径用例改为注入 `new FakeListChatModel({ responses: ["x"] })` 并令其抛错：自定义 `class ExplodingModel extends FakeListChatModel` 覆写 `_call` 抛 `Error("HTTP 401")`，断言 `errorCode` 归类不变。

Run: `npx vitest run tests/ai/connectivity.test.ts`
Expected: FAIL（生产代码仍要求 AI SDK LanguageModel，类型不匹配）

- [ ] **Step 2: 迁移 testLlmConnection**

connectivity.ts:1-8 的 import 改为：

```ts
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createChatModel } from "../orchestration/langchain-model-factory";
import { parseExtraHeaders, type ProviderRuntimeInfo } from "./provider-runtime";
```

（`createLanguageModel` 与 `from "ai"` 的 import 删除；`buildProbeRequest` 用的 `parseExtraHeaders` 已在 Task 1 指向新模块。）

connectivity.ts:20-25 与 :51-73 改为：

```ts
export interface TestConnectionOptions {
  modelType?: ModelType;
  /** 测试注入（供单测替身，仅 llm 生效） */
  injectModel?: BaseChatModel;
}

/** llm 探测：最小 invoke 请求 */
async function testLlmConnection(
  provider: ProviderRuntimeInfo,
  modelId: string,
  injectModel?: BaseChatModel,
): Promise<TestConnectionResult> {
  try {
    const model = injectModel ?? createChatModel(provider, modelId);
    // M7：非流式补全必须带超时——provider 半开连接时 IPC 永久 pending
    await model.invoke("hi", { signal: AbortSignal.timeout(10_000) });
    return { success: true, message: "" };
  } catch (error) {
    return {
      success: false,
      errorCode: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
```

注意：`invoke` 不支持 `maxOutputTokens` 参数——探测本来就是「最小请求」语义，不带该参数符合原意图（原 5 token 上限是防跑飞，"hi" 输入下各模型默认 max tokens 即最小）。若想保留约束，可在 Task 6 工厂合一后统一带 `{ maxTokens: 5 }` 构造参数。

- [ ] **Step 3: 跑测试通过**

Run: `npx vitest run tests/ai/connectivity.test.ts`
Expected: PASS

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm run typecheck && npm run test`

```bash
git add electron/domains/ai/provider/connectivity.ts tests/ai/connectivity.test.ts
git commit -m "feat(ai): 连通性 llm 探测迁 LangChain invoke（T1-2）"
```

### Task 3: handover-summary 迁 invoke

**Files:**
- Modify: `electron/domains/ai/chat/handover-summary.ts:8,177-188`
- Test: `tests/ai/handover-summary.test.ts`（现有；`HandoverModelTextFn` 注入面不变，多数用例无感，仅补一条默认实现走 LangChain 的类型编译断言）

**Interfaces:**
- Consumes: Task 1 `provider-runtime`；`createChatModel`
- Produces: 无新接口（`HandoverModelTextFn` 签名不变）

- [ ] **Step 1: 迁移 defaultModelText**

handover-summary.ts:8 的 `import { generateText } from "ai"` 与 `:180` 的 `createLanguageModel` import 删除，新增：

```ts
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel } from "../orchestration/langchain-model-factory";
```

:177-188 改为：

```ts
function defaultModelText(model: HandoverModelContext): HandoverModelTextFn {
  return async (system, prompt) => {
    const chat = createChatModel(model, model.modelId);
    const aiMessage = await chat.invoke(
      [new SystemMessage(system), new HumanMessage(prompt)],
      // M7：非流式补全必须带超时——半开连接时交接摘要 IPC 永久挂起
      { signal: AbortSignal.timeout(30_000) },
    );
    return typeof aiMessage.content === "string"
      ? aiMessage.content
      : String(aiMessage.content);
  };
}
```

说明：`HandoverModelContext`（含 type/baseUrl/apiKey/extraHeaders/modelId 字段）结构兼容 `ProviderRuntimeInfo`，直接传入；若 tsc 报字段类型不兼容（`type: string` vs `ProviderType`），以 `ProviderRuntimeInfo` 为准做显式收窄 `{ ...model, type: model.type as ProviderRuntimeInfo["type"] }`。

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/ai/handover-summary.test.ts`
Expected: PASS（测试注入 modelText 覆写默认实现，本任务主要是默认路径切换）

- [ ] **Step 3: 全量验证 + Commit**

Run: `npm run typecheck && npm run test`

```bash
git add electron/domains/ai/chat/handover-summary.ts
git commit -m "feat(ai): 交接摘要补全迁 LangChain invoke（T1-3）"
```

### Task 4: memory-compiler 迁 invoke

**Files:**
- Modify: `electron/domains/ai/personalization/memory-compiler.ts:7,280-290`
- Test: `tests/ai/memory-compiler.test.ts`（现有，同 Task 3 逻辑：注入面不变）

**Interfaces:**
- Consumes: 同 Task 3
- Produces: 无新接口（`ModelTextFn` 签名不变，含第三参 `signal`）

- [ ] **Step 1: 迁移默认 modelText**

memory-compiler.ts:7 的 `import { generateText } from "ai"` 删除，:284 的 `createLanguageModel` 改 `createChatModel`（import 自 langchain-model-factory），:282-290 改为：

```ts
const modelText: ModelTextFn =
  opts.modelText ??
  (async (system, prompt, signal) => {
    const chat = createChatModel(opts.model, opts.model.modelId);
    const aiMessage = await chat.invoke(
      [new SystemMessage(system), new HumanMessage(prompt)],
      { signal },
    );
    return typeof aiMessage.content === "string"
      ? aiMessage.content
      : String(aiMessage.content);
  });
```

（`SystemMessage`/`HumanMessage` import 同 Task 3；`MemoryModelContext` 与 `ProviderRuntimeInfo` 的兼容处理同 Task 3 说明。）

- [ ] **Step 2: 跑测试 + 全量验证**

Run: `npx vitest run tests/ai/memory-compiler.test.ts && npm run typecheck && npm run test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add electron/domains/ai/personalization/memory-compiler.ts
git commit -m "feat(ai): 记忆编译补全迁 LangChain invoke（T1-4）"
```

### Task 5: runToolCall 解环抽出 tool-gate

**Files:**
- Create: `electron/domains/ai/agent/tool-gate.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（删除搬走段，改 import）
- Modify: `electron/domains/ai/orchestration/langchain-tool-adapter.ts:12`（`runToolCall`/`AgentStreamOptions` 改从 tool-gate import——**解环完成点**）
- Test: 现有工具审批/权限测试（`tests/ai/permissions-integration.test.ts`、`tests/ai/mcp-integration.test.ts` 等）不动即回归

**Interfaces:**
- Produces: `agent/tool-gate.ts` 导出 `runToolCall`（签名与现 chat.service:644 完全一致）、`AgentStreamOptions`、审批相关常量。后续 Task 8-9 依赖此模块
- 约束：**纯搬移重构**——不改任何行为、不改函数签名；`chat.service` 从 tool-gate import 回（供自身与既有引用方），但 tool-adapter 不再依赖 chat.service

- [ ] **Step 1: 确定搬移清单**

在 chat.service.ts 中定位并整段搬往 `agent/tool-gate.ts`（搬移时连同其仅被这些段使用的私有辅助/常量）：
1. `AgentStreamOptions`（:192）
2. `runToolCall`（:644 起，至下一个顶层声明前）
3. `requestToolApproval`（:506 附近被引用的定义处）
4. `resolveCommandGate`、`emitCommandEvent`（:620-630 一带）
5. `COMMAND_BLOCKED_OUTPUT`、`COMMAND_UNATTENDED_OUTPUT` 等仅上述函数使用的常量

执行准则：搬完后 `grep -n "COMMAND_BLOCKED_OUTPUT\|requestToolApproval" electron/domains/ai/chat/chat.service.ts` 应零命中（或仅剩注释）；chat.service 内对这些符号的调用点改 import。

- [ ] **Step 2: tool-gate.ts 头部 import**

```ts
/** 工具调用安全门（自 chat.service 抽出解环，见 2026-10-15 spec §4.2）：
 * 命令门/文件门/批量删除预估/审批/审计全链收口，chat 与 orchestration
 * （经 langchain-tool-adapter）共用。语义与抽出前逐行为等价。 */
import type { ToolDefinition } from "./file-tools";
import type { ChatStreamChunk, ToolCallBlock } from "../chat/blocks";
```

（`ChatStreamChunk` 若实际定义在 chat.service 而非 blocks.ts，则它属于 chat 协议类型，随迁到 blocks.ts 或留在 chat.service 由 tool-gate 反向 import——后者会重新成环，此时选择把它挪到 blocks.ts，因为它本来就是 chunk 协议的一部分。）

- [ ] **Step 3: tool-adapter 改 import（解环完成）**

langchain-tool-adapter.ts:12 改：

```ts
import { runToolCall, type AgentStreamOptions } from "../agent/tool-gate";
```

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm run test`
Expected: 全绿（审批/权限/MCP 集成测试原样通过即证明语义未变）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/tool-gate.ts electron/domains/ai/chat/chat.service.ts electron/domains/ai/orchestration/langchain-tool-adapter.ts
git commit -m "refactor(ai): runToolCall 安全门抽 tool-gate 解 chat.service/tool-adapter 环（T1-5）"
```

**T1 期验收（额外执行一次）：** `grep -rn 'from "ai"' electron/domains/ai/provider/connectivity.ts electron/domains/ai/chat/handover-summary.ts electron/domains/ai/personalization/` 零命中。

---

## 第二期（T2）：多模态 spike（探针，一次性脚本）

### Task 6: ChatOllama / ChatGoogle 图片输入实测

**Files:**
- Create: `scripts/spike/multimodal-spike.mjs`（throwaway，产出结论后不进任何构建）
- Modify: `docs/superpowers/specs/2026-10-15-unify-langchain-design.md`（§6 风险表追加实测结论行）

**Interfaces:**
- Consumes: `createChatModel`、`@langchain/core` 消息类型
- Produces: 结论备忘（写入 spec §6），Task 9 消费——「图片走 content blocks 数组，ollama/gemini 是否可用 + 正确的消息形态」

**前置条件：** 本机 ollama 服务运行中（含多模态模型如 llama3.2-vision 或 qwen2.5vl）或具备 gemini API key。**两者皆无时**：本任务跳过，在 spec §6 记录「未实测，T3 按 A2 降级实施」，不阻塞后续。

- [ ] **Step 1: 写 spike 脚本**

```js
// scripts/spike/multimodal-spike.mjs
// 用法: node scripts/spike/multimodal-spike.mjs <ollama|gemini>
// 结论记录回 spec §6；一次性脚本，验证完即弃
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

const schema = z.object({
  provider: z.enum(["ollama", "gemini"]),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  modelId: z.string(),
});

const cfg = schema.parse({
  provider: process.argv[2],
  baseUrl: process.env.SPIKE_BASE_URL ?? "http://localhost:11434",
  apiKey: process.env.SPIKE_API_KEY,
  modelId: process.env.SPIKE_MODEL ?? "",
});

// 1x1 红色 PNG（base64）
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// 两种候选消息形态逐一探测，记录哪种返回正确描述「红色」
const shapes = {
  openaiStyle: [
    {
      type: "human",
      content: [
        { type: "text", text: "这张图是什么颜色？只答颜色词" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    },
  ],
  langchainStandard: [
    new HumanMessage({
      content: [
        { type: "text", text: "这张图是什么颜色？只答颜色词" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    }),
  ],
};

const { createChatModel } = await import(
  "../../electron/domains/ai/orchestration/langchain-model-factory.ts"
).catch(() => ({})); // ESM 直跑 ts 不行时改用 tsx: npx tsx scripts/spike/multimodal-spike.mjs

for (const [name, messages] of Object.entries(shapes)) {
  try {
    const model = createChatModel(
      { type: cfg.provider === "ollama" ? "ollama" : "gemini", baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      cfg.modelId,
    );
    const res = await model.invoke(messages, { signal: AbortSignal.timeout(30_000) });
    console.log(`[OK] ${name}:`, String(res.content).slice(0, 80));
  } catch (e) {
    console.log(`[FAIL] ${name}:`, e.message?.slice(0, 160));
  }
}
```

（实际执行时用 `npx tsx scripts/spike/multimodal-spike.mjs ollama` 运行，import 路径按 tsx 能解析的写法调整。）

- [ ] **Step 2: 跑 spike，记录结论**

每 provider 记录三态：`可用+形态名` / `不可用+错误` / `未测（无环境）`。写入 spec §6 风险表新增行：

```markdown
| 多模态 spike 实测（2026-10-XX） | ollama：可用/不可用/未测（形态：xxx）；gemini：可用/不可用/未测（形态：xxx）；不可用家按 A2 降级 |
```

- [ ] **Step 3: Commit（脚本与结论一并入库，供追溯）**

```bash
git add scripts/spike/multimodal-spike.mjs docs/superpowers/specs/2026-10-15-unify-langchain-design.md
git commit -m "chore(spike): ollama/gemini 多模态图片实测探针与结论（T2）"
```

---

## 第三期（T3）：chat 流式循环重写 + 删 AI SDK

### Task 7: runChatStream 事件序列 golden 基线测试

**Files:**
- Test: `tests/ai/chat-stream-golden.test.ts`（新建）

**Interfaces:**
- Consumes: 现 `runChatStream`（chat.service.ts:970）与其 `ChatStreamOptions`（含 `model`/`toolDefinitions`/`agent`/`onChunk` 注入口）
- Produces: golden 断言集——Task 9 换引擎后同测试必须原样通过（引擎无关的行为契约）

- [ ] **Step 1: 写基线测试（在现 AI SDK 引擎上）**

用注入 model 替身 + 注入 toolDefinitions 驱动现循环，捕获 onChunk 序列与最终 blocks，写显式断言：

```ts
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
```

注意：现引擎的 model 注入类型是 AI SDK `LanguageModel`（本任务时点尚未切换），替身用现有测试（如 `tests/ai/agent-loop.test.ts`）里已有的 AI SDK fake model 形态复制。核心用例三组：

```ts
// 用例 A 纯文本：断言 onChunk 依次收到 text-delta 且最终 blocks 含一个 text 块与 usage
// 用例 B 工具往返：注入 echo 工具，断言 chunk 序列形如
//   [tool-call(id, name, args)] → [tool-update(running)] → [tool-update(ok, output)] → 终块 usage
// 用例 C 中止：abortSignal 预先 aborted，断言无 error chunk、已生成内容保留、
//   挂起工具块终态为 interrupted（chat.service:960 行为）
```

断言写「事件序列 + 块终态」，**不写**引擎内部细节（不引用任何 SDK 事件类型名）——这是换引擎后仍成立的关键。替身直接复制 `tests/ai/agent-loop.test.ts` 里现成的 fake model 定义。用例 B 的断言骨架（其余用例同风格落全）：

```ts
const chunks: unknown[] = [];
const onChunk = (c: unknown) => chunks.push(c);
const result = await runChatStream({ ...commonOpts, onChunk });
expect(chunks.map((c) => (c as { type: string }).type)).toEqual([
  "tool-call", "tool-update", "tool-update", /* …按实际序列写死… */
]);
const toolBlocks = result.blocks.filter((b) => b.type === "tool");
expect(toolBlocks.at(-1)).toMatchObject({ state: "ok", output: "echo" });
```

Run: `npx vitest run tests/ai/chat-stream-golden.test.ts`
Expected: PASS（在现引擎上）

- [ ] **Step 2: Commit（基线先行入库，锁定行为契约）**

```bash
git add tests/ai/chat-stream-golden.test.ts
git commit -m "test(ai): runChatStream 事件序列 golden 基线（T3-1，锁定换引擎契约）"
```

### Task 8: 新建 agent-chunk-emitter 映射层

**Files:**
- Create: `electron/domains/ai/chat/agent-chunk-emitter.ts`
- Test: `tests/ai/agent-chunk-emitter.test.ts`（新建）

**Interfaces:**
- Consumes: `@langchain/core/tracers/log_stream` 的 `StreamEvent` 类型
- Produces（Task 9 消费，签名精确）:

```ts
export interface EmitterCallbacks {
  onTextDelta(text: string): void;
  onReasoningDelta(text: string): void;
  onToolCall(call: { toolCallId: string; toolName: string; args: unknown }): void;
  onToolResult(call: { toolCallId: string; output: string }): void;
  onToolError(call: { toolCallId: string; error: string }): void;
  onFinish(usage: { input: number; output: number } | undefined): void;
  onError(error: unknown): void;
}

export async function consumeAgentStream(
  eventStream: AsyncIterable<StreamEvent>,
  callbacks: EmitterCallbacks,
  isAborted: () => boolean,
): Promise<void>;
```

- [ ] **Step 1: 写失败测试**

构造合成事件流（纯对象数组转 AsyncIterable，不依赖真模型）：

```ts
const asyncOf = <T,>(xs: T[]) => (async function* () { for (const x of xs) yield x; })();

// 用例 A：on_chat_model_stream 事件 chunk.content 字符串 → onTextDelta 逐段透传
// 用例 B：chunk.additional_kwargs.reasoning_content 有值 → onReasoningDelta
// 用例 C：on_tool_start{name, run_id, data.input} → onToolCall；
//         on_tool_end{data.output} → onToolResult；tool 运行抛错经 langgraph
//         包装的 on_tool_end(output 为 Error 对象) → onToolError
// 用例 D：末个 chunk.usage_metadata{input_tokens, output_tokens} → onFinish；
//         无 usage → onFinish(undefined)
// 用例 E：事件流迭代抛异常且 isAborted() 为 false → onError；isAborted() 为
//         true → 静默吞掉（对齐现 chat.service:1079-1086 中止语义）
```

Run: `npx vitest run tests/ai/agent-chunk-emitter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现映射层**

事件分发骨架（`AIMessageChunk` 取自 `@langchain/core/messages`；写实现时以本地安装版 d.ts 核对字段名，重点核对 `tool_call_chunks`、`usage_metadata`、`additional_kwargs.reasoning_content`）：

```ts
import type { StreamEvent } from "@langchain/core/tracers/log_stream";

export async function consumeAgentStream(
  eventStream: AsyncIterable<StreamEvent>,
  cb: EmitterCallbacks,
  isAborted: () => boolean,
): Promise<void> {
  let usage: { input: number; output: number } | undefined;
  try {
    for await (const ev of eventStream) {
      if (ev.event === "on_chat_model_stream") {
        const chunk = ev.data?.chunk;
        if (!chunk) continue;
        const reasoning = chunk.additional_kwargs?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) cb.onReasoningDelta(reasoning);
        if (typeof chunk.content === "string" && chunk.content) cb.onTextDelta(chunk.content);
        else if (Array.isArray(chunk.content)) {
          for (const part of chunk.content) {
            if (part?.type === "text" && part.text) cb.onTextDelta(part.text);
          }
        }
        const um = chunk.usage_metadata;
        if (um && (um.input_tokens || um.output_tokens)) {
          usage = { input: um.input_tokens ?? 0, output: um.output_tokens ?? 0 };
        }
      } else if (ev.event === "on_tool_start") {
        cb.onToolCall({
          toolCallId: String(ev.run_id),
          toolName: String(ev.name),
          args: ev.data?.input,
        });
      } else if (ev.event === "on_tool_end") {
        if (ev.data?.output instanceof Error) {
          cb.onToolError({ toolCallId: String(ev.run_id), error: ev.data.output.message });
        } else {
          cb.onToolResult({ toolCallId: String(ev.run_id), output: stringifyOutput(ev.data?.output) });
        }
      }
    }
    cb.onFinish(usage);
  } catch (error) {
    if (isAborted()) return; // 用户中止不是错误：静默保留已生成内容
    cb.onError(error);
  }
}
```

注意两个已核对过的口径：① toolCallId 用 `ev.run_id`（langgraph 的 on_tool_start 不带 AI 侧 tool_call id；ToolCallBlock 的 id 只要求会话内唯一可关联，run_id 满足）——若与 on_chunk 前端展示冲突，以实际 streamEvents 载荷为准改用 chunk.tool_call_chunks[].id；② `stringifyOutput`：StringContent 直取 string，其余 JSON.stringify 截断 500 字符（对齐现 tool 输出口径，执行时对照 chat.service 现 finalizeToolBlock 的 output 处理）。

Run: `npx vitest run tests/ai/agent-chunk-emitter.test.ts`
Expected: PASS

- [ ] **Step 3: 全量验证 + Commit**

```bash
npm run typecheck && npm run test
git add electron/domains/ai/chat/agent-chunk-emitter.ts tests/ai/agent-chunk-emitter.test.ts
git commit -m "feat(ai): streamEvents→onChunk 映射层 agent-chunk-emitter（T3-2）"
```

### Task 9: runChatStream 换引擎（createReactAgent + streamEvents）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（:1-30 import 区、:850 buildToolSet 删除、:970-1089 循环体、`ChatStreamOptions.model` 类型）
- Modify: `electron/domains/ai/automation/automation-runner.ts:19,341-349`（model 构造改 `createChatModel`）
- Test: `tests/ai/chat-stream-golden.test.ts`（**不改断言**，替身换 `FakeListChatModel` 及其流式变体）、`tests/ai/agent-loop.test.ts` 等既有测试随类型切换调整替身

**Interfaces:**
- Consumes: Task 5 `tool-gate`、Task 8 `consumeAgentStream`、`toLangChainTools(defs, agent, opts)`、`createChatModel`、`createReactAgent`（`@langchain/langgraph/prebuilt`）
- Produces: `ChatStreamOptions.model: BaseChatModel`（类型切换，无兼容层）

- [ ] **Step 1: golden 测试替身先行切换（先失败）**

`tests/ai/chat-stream-golden.test.ts` 的注入 model 换成 LangChain 替身（`FakeListChatModel`；工具往返用例需要多轮输出时用 `responses` 数组逐轮供给，流式粒度由映射层归一，断言不变）。同时把 `ChatStreamOptions.model` 类型注解切到 `BaseChatModel`。

Run: `npx vitest run tests/ai/chat-stream-golden.test.ts`
Expected: FAIL（生产代码仍是 streamText）

- [ ] **Step 2: 重写 runChatStream 引擎段**

chat.service.ts import 区：删除 `generateText/streamText/stepCountIs/jsonSchema/FlexibleSchema/ToolSet`（`from "ai"` 整行消失），新增：

```ts
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { toLangChainTools } from "../orchestration/langchain-tool-adapter";
import { createChatModel } from "../orchestration/langchain-model-factory";
import { consumeAgentStream } from "./agent-chunk-emitter";
```

删除 `buildToolSet`（:850 起整个函数）。循环体（:1001-1086）替换为：

```ts
const tools =
  options.agent && options.toolDefinitions?.length
    ? toLangChainTools(options.toolDefinitions, options.agent, {
        abortSignal: options.abortSignal,
        // 若被删除的 buildToolSet 内部有 per-call 回调消费者（对照其原实现），
        // 在此补 onToolCall: (c) => ...；ChatStreamOptions 无此字段则不传
      })
    : undefined;

const agentExecutor = createReactAgent({
  llm: options.model,
  tools,
  prompt: options.system, // langgraph prebuilt 的系统提示注入参数，写实现时按安装版 d.ts 核对参数名（prompt/messageModifier 二选一）
});

const eventStream = agentExecutor.streamEvents(
  {
    messages: [/* system 经 prompt 注入，这里只放转换后的历史 */ ...messages],
  },
  {
    version: "v2",
    // stepCountIs(n) 的 n 步 LLM ↔ langgraph recursionLimit：一步 agent =
    // 模型 + 工具两个 super-step，2n + 2 保险余量
    recursionLimit: (options.maxSteps ?? DEFAULT_MAX_STEPS) * 2 + 2,
    signal: options.abortSignal,
  },
);

await consumeAgentStream(
  eventStream,
  {
    onTextDelta: (text) => {
      openText = appendDelta(blocks, openText, "text", text, options.onChunk);
    },
    onReasoningDelta: (text) => {
      openThinking = appendDelta(blocks, openThinking, "thinking", text, options.onChunk);
    },
    onToolCall: (call) => {
      openText = null; // 工具调用打断文本流：后续文本另起新块（原 :1046 注释语义）
      openThinking = null;
      handleToolCallPart(blocks, toolBlocks, call, options.onChunk);
    },
    onToolResult: (call) => finalizeToolBlock(toolBlocks.get(call.toolCallId), call.output, finalStates),
    onToolError: (call) => markToolError(toolBlocks.get(call.toolCallId), call.error),
    onFinish: (u) => {
      openText = null;
      openThinking = null;
      usage = u;
    },
    onError: (error) => {
      if (options.abortSignal?.aborted) return;
      errorCode = classifyError(error);
      errorMessage = error instanceof Error ? error.message : String(error);
    },
  },
  () => options.abortSignal?.aborted === true,
);
```

实现时逐点核对（写代码时以安装版 d.ts 为准）：① `handleToolCallPart` 现签名吃 AI SDK 的 tool-call part——改为吃 `{toolCallId, toolName, args}` 通用形状；② 多模态：`blocksToModelMessages` 现产出 AI SDK `ModelMessage`（图 part 为 `image` 类型）——按 Task 6 结论改成 LangChain `HumanMessage` 多模态 content（`image_url` 形态）；Task 6 结论为不可用的家在此处按 A2 短路：图片块转 `{type:"text", text:"[当前模型不支持图片输入]"}`；③ `truncateHistory`/`estimateReserveTokens` 与引擎无关，不动；④ chat.service 内部残留的 `generateText` 调用（若有）同 Task 3 模板迁 invoke。

- [ ] **Step 3: golden 与全量回归**

Run: `npx vitest run tests/ai/chat-stream-golden.test.ts && npm run typecheck && npm run test`
Expected: golden 断言零修改通过；全量绿

- [ ] **Step 4: automation-runner 构造点切换**

automation-runner.ts:19 import 改 `createChatModel`（langchain-model-factory），:341-349 的 `model: createLanguageModel(...)` 改 `model: createChatModel({...同参数}, ctx.modelSdkId)`。

Run: `npx vitest run tests/ai/automation-runner.test.ts tests/ai/automation-resolve-attachments.test.ts`
Expected: PASS（若其 fake model 替身是 AI SDK 形态，同步换 LangChain 替身）

- [ ] **Step 5: Commit**

```bash
git add -A electron/domains/ai/ tests/ai/
git commit -m "feat(ai)!: chat 流式循环迁 createReactAgent+streamEvents，onChunk 协议不变（T3-3）"
```

### Task 10: 删 provider-factory + 依赖出清

**Files:**
- Delete: `electron/domains/ai/provider/provider-factory.ts`
- Modify: `package.json`（卸 5 依赖）、`vite.config.ts:76-89`（external 收缩）
- Test: `tests/ai/langchain-model-factory.test.ts`（现有，工厂已成唯一入口，补一条 parseExtraHeaders 归属断言可选）

**Interfaces:**
- Consumes: Task 1-9 完成态（provider-factory 无剩余消费方）
- Produces: 无

- [ ] **Step 1: 确认无引用后删除**

Run: `grep -rn "provider-factory" electron/ src-react/ tests/ --include="*.ts" --include="*.tsx" | grep -v provider-runtime | grep -v "langchain-model-factory"`
Expected: 零命中（Task 1 的 re-export 早已无消费者；有命中则回改该文件 import 指向 provider-runtime / langchain-model-factory）

然后 `git rm electron/domains/ai/provider/provider-factory.ts`。同时更新 `langchain-model-factory.ts:1-4` 头注释：删除「只活在 orchestration 域（spec §0 LLM 栈边界）」表述，改为「全应用唯一模型构造入口（2026-10-15 单栈收敛）」。

- [ ] **Step 2: 卸依赖 + external 收缩**

```bash
npm uninstall ai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai-compatible ai-sdk-ollama
```

vite.config.ts external 数组删 `"ai"`、`"@ai-sdk/anthropic"`、`"@ai-sdk/google"`、`"@ai-sdk/openai-compatible"`、`"ai-sdk-ollama"` 五项，并同步改该块头注释（删除「3. ai 系列……」条目，保留 moment/better-sqlite3/MCP/node-pty 三条历史结论）。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm run test`
Expected: 绿（此步同时证明 A3：无残留兼容层引用）

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vite.config.ts
git commit -m "chore(deps)!: 移除 Vercel AI SDK 五依赖，LLM 栈统一 LangChain（T3-4）"
```

### Task 11: 产物实证 + spec §0 改写收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-langgraph-orchestration-design.md`（§0 双栈条款改单栈）
- Modify: `CLAUDE.md`（若有双栈表述则同步；当前无，核对即可）

**Interfaces:** 无代码接口；本任务是验收与文档闭环。

- [ ] **Step 1: 源码零残留验证**

Run: `grep -rEn "from \"ai\"|from 'ai'|@ai-sdk|ai-sdk-ollama" electron/ src-react/ tests/ scripts/ --include="*.ts" --include="*.tsx" --include="*.mjs" | grep -v multimodal-spike`
Expected: 零命中（spike 脚本用 @langchain，不含 AI SDK 引用，此排除仅防御）

- [ ] **Step 2: 打包 + asar 实证**

Run: `npm run build`
然后：

```bash
npx --yes @electron/asar list "release/0.1.0/mac-arm64/天枢.app/Contents/Resources/app.asar" | grep -cE "node_modules/(ai|@ai-sdk|ai-sdk-ollama|ollama)/"
```

Expected: `0`。另记录 asar/DMG 体积对比依赖大扫除基线（asar 70.6MB / DMG 120.7MB，2026-10-15）。

- [ ] **Step 3: spec §0 改写**

`2026-10-03-langgraph-orchestration-design.md` §0 中「chat/agent 域用 Vercel AI SDK、orchestration 域用 LangChain」的双栈分工表述改为：「全应用统一 LangChain 单栈（2026-10-15 spec `2026-10-15-unify-langchain-design.md` 收敛），模型构造唯一入口 `langchain-model-factory.createChatModel`」。保留该文档其余内容。

- [ ] **Step 4: 人工回归清单（请用户执行）**

打字机流式、工具进度/审批挂起弹窗、图片粘贴发送（ollama/gemini 按 Task 6 结论）、自动化任务跑一轮。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-03-langgraph-orchestration-design.md
git commit -m "docs(spec): §0 双栈边界改写为 LangChain 单栈（T3-5 收尾）"
```
