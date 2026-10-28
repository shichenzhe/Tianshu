# imageGen 节点适配 ComfyUI workflow API 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作流 imageGen 节点新增 ComfyUI workflow API 协议（与 openai 并存），provider 化管理地址，运行轨迹内生成图片可视化。

**Architecture:** `packages/tianshu-core` 的 graph schema 平铺加 `protocol` 字段（superRefine 互斥，旧图零迁移）；electron 与 apps/tianshu-server 两份同构 executor 各加 comfyui 执行链（`/prompt` 提交 → 1s 轮询 `/history` → `/view` 取图）；前端编辑器协议切换 + 复用 chat 域 `MessageImage` 展示产物。

**Tech Stack:** zod（schema）、原生 fetch（无新依赖）、React 19 + react-query、Vitest（mirror）/ Jest（server）。

**Spec:** `docs/superpowers/specs/2026-10-23-imagegen-comfyui-design.md`

## Global Constraints

- **不开分支**：所有 commit 直接落在 main（用户裁定，勿 checkout/开分支/worktree）
- 代码风格：mirror 侧双引号/分号/无尾随逗号；**apps/tianshu-server 侧单引号/trailingComma=all**（两仓 Prettier 配置不同，双份 executor 各随其主）
- 文件名 kebab-case；i18n 的 zh-CN 与 en-US 同任务双改；变量/函数 camelCase
- 改 `packages/tianshu-core` 源码后必须重建 dist：`npm --prefix packages/tianshu-core run build`（server 消费 dist；mirror/前端经 alias 直引源码即时生效）
- 双份 executor（`electron/domains/ai/orchestration/graph-executor.ts` ↔ `apps/tianshu-server/src/core/graph/graph-executor.ts`）保持同构，行级 diff 由 `npm run check:drift` 守护，基线变化用 `npm run check:drift -- --rebase` 重置后人工复核
- 函数不超过 20 行（executor 内 helper 拆分）；错误码走 `GraphNodeFailure(node.id, code, message)` 既有通道
- commit message 用中文 conventional commits（仓库现行风格）

---

### Task 1: tianshu-core schema 扩展

**Files:**
- Modify: `packages/tianshu-core/src/graph-schema.ts:355-364`（imageGenNodeSchema）、`:619`（类型导出区）
- Test: `tests/ai/graph-schema.test.ts`（文件尾追加 describe）

**Interfaces:**
- Consumes: 现有 `nodeBase`、`graphNodeSchema`（z.union 成员）
- Produces:
  - `imageGenNodeSchema`：新增字段 `protocol: "openai"|"comfyui"`（default "openai"）、`modelId?: number`（原必填改 optional）、`providerId?: number`、`workflowJson?: string`、`randomizeSeed: boolean`（default true）、`timeoutMs: number`（5_000–600_000，default 300_000）
  - `ImageGenNode = z.infer<typeof imageGenNodeSchema>`（名不变，modelId 变 optional）
  - `export type ComfyImageGenNode = ImageGenNode & { protocol: "comfyui"; providerId: number; workflowJson: string }`
  - `export function isComfyUIImageGen(node: ImageGenNode): node is ComfyImageGenNode`

- [ ] **Step 1: 写失败测试**（`tests/ai/graph-schema.test.ts` 文件尾追加；import 区已有所需函数则不重复）

```ts
import {
  imageGenNodeSchema,
  isComfyUIImageGen,
} from "../../src-react/domains/ai/orchestration/api/graph.schema";

describe("imageGen 协议分流", () => {
  const comfyNode = {
    id: "gen",
    name: "生图",
    kind: "imageGen",
    protocol: "comfyui",
    providerId: 2,
    workflowJson: '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}',
    prompt: "a cat",
    size: "1024x1024",
    randomizeSeed: true,
    timeoutMs: 300_000,
  };

  it("旧图无 protocol → 默认 openai + 默认值注入", () => {
    const node = imageGenNodeSchema.parse({
      id: "gen",
      name: "",
      kind: "imageGen",
      modelId: 1,
      prompt: "p",
    });
    expect(node.protocol).toBe("openai");
    expect(node.randomizeSeed).toBe(true);
    expect(node.timeoutMs).toBe(300_000);
  });

  it("openai 协议缺 modelId 拒绝", () => {
    const result = imageGenNodeSchema.safeParse({
      id: "g",
      name: "",
      kind: "imageGen",
      protocol: "openai",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("comfyui 协议缺 providerId/workflowJson 拒绝", () => {
    const result = imageGenNodeSchema.safeParse({
      id: "g",
      name: "",
      kind: "imageGen",
      protocol: "comfyui",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("comfyui 完整通过 + isComfyUIImageGen 判定", () => {
    const node = imageGenNodeSchema.parse(comfyNode);
    expect(isComfyUIImageGen(node)).toBe(true);
    expect(
      isComfyUIImageGen(
        imageGenNodeSchema.parse({
          id: "g",
          name: "",
          kind: "imageGen",
          modelId: 1,
          prompt: "p",
        }),
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-schema.test.ts`
Expected: FAIL（`imageGenNodeSchema` 无 `protocol` 字段 → parse 结果 protocol undefined / import isComfyUIImageGen 报 not exported）

- [ ] **Step 3: 实现 schema**

`packages/tianshu-core/src/graph-schema.ts` 替换 355-364 行的 `imageGenNodeSchema`（注释同步更新）：

```ts
/** 图像生成节点（kind:imageGen）双协议：openai（默认，OpenAI 兼容
 * images/generations，b64_json/url 双兼容）/ comfyui（workflow API——
 * POST /prompt 提交 + /history 轮询 + /view 取图，workflowJson 占位符
 * 注入见 executor）。平铺 + superRefine 互斥而非 discriminatedUnion——
 * 旧图数据无 protocol 字段，union 分发两分支皆失败会打翻整图解析 */
export const imageGenNodeSchema = z
  .object({
    ...nodeBase,
    kind: z.literal("imageGen"),
    protocol: z.enum(["openai", "comfyui"]).default("openai"),
    modelId: z.number().int().positive().optional(),
    providerId: z.number().int().positive().optional(),
    workflowJson: z.string().optional(),
    prompt: z.string().min(1),
    size: z.string().default("1024x1024"),
    randomizeSeed: z.boolean().default(true),
    timeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(300_000),
  })
  .superRefine((node, ctx) => {
    if (node.protocol === "openai" && !node.modelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelId"],
        message: "openai 协议必须选择模型",
      });
    }
    if (
      node.protocol === "comfyui" &&
      (!node.providerId || !node.workflowJson)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerId"],
        message: "comfyui 协议必须配置服务商与 workflow JSON",
      });
    }
  });

/** comfyui 形收窄（executor/UI 分流用，字段非空保证来自 superRefine） */
export type ComfyImageGenNode = ImageGenNode & {
  protocol: "comfyui";
  providerId: number;
  workflowJson: string;
};

export function isComfyUIImageGen(
  node: ImageGenNode,
): node is ComfyImageGenNode {
  return (
    node.protocol === "comfyui" &&
    typeof node.providerId === "number" &&
    typeof node.workflowJson === "string"
  );
}
```

注意：`ComfyImageGenNode` 与 `isComfyUIImageGen` 放在 619 行 `export type ImageGenNode = ...` 之后（依赖该类型）。`ImageGenNode` 导出行本身不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-schema.test.ts`
Expected: PASS（全文件含既有用例）

- [ ] **Step 5: 重建共享包 dist**

Run: `npm --prefix packages/tianshu-core run build`
Expected: 构建成功无报错（后续 server 侧任务依赖）

- [ ] **Step 6: Commit**

```bash
git add packages/tianshu-core/src/graph-schema.ts packages/tianshu-core/dist tests/ai/graph-schema.test.ts
git commit -m "feat(core): imageGen 节点协议字段扩展——openai/comfyui 平铺+互斥校验，旧图零迁移"
```

---

### Task 2: electron 执行器 ComfyUI 链 + 轨迹图片路径

**Files:**
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（四处：TraceEntry 接口 ~96 行、NodeOutput 接口 ~196 行、traceSuccess ~1654 行、makeImageGenNodeHandler ~2906 行 + generateImage ~2943 行区间新增函数群）
- Test: Create `tests/ai/graph-imagegen-comfyui.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isComfyUIImageGen`、`ComfyImageGenNode`（import 自 tianshu-core，跟随该文件现有 graph-schema import 路径）；既有 `renderNodePrompt`、`GraphNodeFailure`、`GraphRunFailure`、`workflowAssetsDir()`
- Produces（server 同构依据，签名两边一致）:
  - `interface TraceEntry { ...; outputImage?: string }` — 相对数据根路径（`workflow-assets/xxx.png`），GraphRunTraceView.tsx 镜像类型同步加
  - `interface NodeOutput { ...; outputImage?: string }`
  - `traceSuccess(node, startedAt, done)` 透传 `done.outputImage`
  - `loadProviderRuntime(providerId): Promise<{ baseUrl: string; apiKey?: string; extraHeaders?: string }>`
  - `generateImageComfyUI(node: ComfyImageGenNode, ctx: NodeContext, renderCtx: PromptRenderContext, prompt: string): Promise<string>`（返回落盘绝对路径）
  - 错误码：`comfyui_workflow_invalid` / `comfyui_invalid_size` / `comfyui_request_failed` / `comfyui_api_error` / `comfyui_timeout` / `comfyui_no_output` / `comfyui_download_failed`、`provider_missing`

- [ ] **Step 1: 写失败测试**（新建 `tests/ai/graph-imagegen-comfyui.test.ts`，mock 头抄自 `tests/ai/graph-executor.test.ts:1-45`）

```ts
// tests/ai/graph-imagegen-comfyui.test.ts
// imageGen 双协议执行链：comfyui 提交/轮询/取图 + openai 回归 + trace outputImage
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    session: { create: vi.fn(async () => ({ id: 42 })) },
    message: { create: vi.fn() },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
    model: { findUnique: vi.fn() },
    provider: {
      findUnique: vi.fn(async () => ({
        id: 2,
        type: "comfyui",
        baseUrl: "http://localhost:8188",
        apiKey: "k",
        extraHeaders: null,
      })),
    },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));

import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";
// prisma mock 句柄照抄 tests/ai/graph-executor.test.ts 的 import 方式
// （该文件经 vi.mock("../../electron/commons/prisma-client") 后直接
// import 同路径取 default，此处同款）：
import prisma from "../../electron/commons/prisma-client";

const workflowJson = JSON.stringify({
  "3": {
    class_type: "KSampler",
    inputs: { seed: 5, steps: 20, sampler_name: "euler" },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "masterpiece, {{prompt}}, best quality" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: "{{width}}", height: "{{height}}" },
  },
});

const comfyGraphJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      {
        id: "gen",
        name: "生图",
        kind: "imageGen",
        protocol: "comfyui",
        providerId: 2,
        workflowJson,
        prompt: "a cat of {{input.topic}}",
        size: "768x512",
        ...extra,
      },
    ],
    edges: [{ from: "gen", to: "END" }],
  });

const graph = {
  id: 1,
  userId: 1,
  name: "g",
  graphJson: comfyGraphJson(),
};

const runParams = (inputs: Record<string, string> = { topic: "cats" }) => ({
  graph,
  task: null,
  inputs,
  triggerType: "manual" as const,
  attempt: 1,
  abort: new AbortController().signal,
  workspace: { id: 9, directoryPath: null },
});

type FetchCall = { url: string; init?: RequestInit };
const pngBytes = () => Buffer.from("fake-png-bytes");

/** ComfyUI 三端点路由 stub；submitStatus/history 序列可编程 */
function stubComfyFetch(opts: {
  submitBody?: unknown;
  submitStatus?: number;
  history: unknown[];
}) {
  const calls: FetchCall[] = [];
  const submitted: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith("/prompt")) {
        submitted.push(JSON.parse(String(init?.body)));
        return {
          ok: (opts.submitStatus ?? 200) < 400,
          status: opts.submitStatus ?? 200,
          json: async () =>
            opts.submitBody ?? { prompt_id: "p1", node_errors: {} },
        } as Response;
      }
      if (u.includes("/history/")) {
        return {
          ok: true,
          status: 200,
          json: async () => opts.history.shift() ?? {},
        } as Response;
      }
      if (u.includes("/view?")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => pngBytes().buffer,
        } as Response;
      }
      if (u.endsWith("/images/generations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ b64_json: pngBytes().toString("base64") }] }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return { calls, submitted };
}

const historyDone = {
  p1: {
    outputs: {
      "9": {
        images: [
          { filename: "ComfyUI_0001_.png", subfolder: "", type: "output" },
        ],
      },
    },
  },
};

const lastTrace = () => {
  const update = vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
  return JSON.parse(update.data.graphTrace as string);
};

describe("imageGen comfyui 执行链", () => {
  it("成功链路：占位注入+seed 随机+落盘+trace outputImage", async () => {
    const { submitted } = stubComfyFetch({ history: [{}, historyDone] });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("success");
    const wf = submitted[0].prompt as Record<string, any>;
    expect(wf["6"].inputs.text).toBe("masterpiece, a cat of cats, best quality");
    expect(wf["5"].inputs.width).toBe(768);
    expect(wf["5"].inputs.height).toBe(512);
    const seed = wf["3"].inputs.seed;
    expect(seed).not.toBe(5); // 随机化生效
    expect(Number.isInteger(seed)).toBe(true);
    expect(lastTrace()[0].outputImage).toMatch(
      /^workflow-assets\/image-\d+\.png$/,
    );
  });

  it("randomizeSeed=false 保留静态 seed", async () => {
    graph.graphJson = comfyGraphJson({ randomizeSeed: false });
    const { submitted } = stubComfyFetch({ history: [historyDone] });
    await executeGraphRun(runParams());
    expect((submitted[0].prompt as any)["3"].inputs.seed).toBe(5);
  });

  it("node_errors 非空 → comfyui_api_error", async () => {
    stubComfyFetch({
      submitStatus: 400,
      submitBody: {
        error: { type: "prompt_outputs_failed_validation" },
        node_errors: { "3": { errors: [{ type: "value_overflow" }] } },
      },
      history: [],
    });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    const trace = lastTrace();
    expect(trace[0].error.code).toBe("comfyui_api_error");
  });

  it("workflowJson 渲染后非法 JSON → comfyui_workflow_invalid", async () => {
    graph.graphJson = comfyGraphJson({ workflowJson: "{oops" });
    stubComfyFetch({ history: [] });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    expect(lastTrace()[0].error.code).toBe("comfyui_workflow_invalid");
  });

  it("轮询超时 → comfyui_timeout", async () => {
    graph.graphJson = comfyGraphJson({ timeoutMs: 5_000 });
    stubComfyFetch({ history: [] }); // history 永远空
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    expect(lastTrace()[0].error.code).toBe("comfyui_timeout");
  }, 20_000);

  it("openai 回归：默认协议 + trace outputImage 同样填充", async () => {
    graph.graphJson = JSON.stringify({
      version: 1,
      inputSchema: { topic: "string" },
      nodes: [
        {
          id: "gen",
          name: "生图",
          kind: "imageGen",
          modelId: 1,
          prompt: "p",
          size: "1024x1024",
        },
      ],
      edges: [{ from: "gen", to: "END" }],
    });
    vi.mocked(prisma.model.findUnique).mockResolvedValueOnce({
      id: 1,
      providerId: 2,
      modelId: "dall-e-3",
    } as never);
    stubComfyFetch({ history: [] }); // fetch 路由含 /images/generations
    const out = await executeGraphRun(runParams());
    expect(out).toBe("success");
    expect(lastTrace()[0].outputImage).toMatch(
      /^workflow-assets\/image-\d+\.png$/,
    );
  });
});
```

注意：每个用例开头重设 `graph.graphJson`（模块级 graph 对象可变，用例间不隔离——与现有 graph-executor.test.ts 的 toolsGraph 处理方式一致）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-imagegen-comfyui.test.ts`
Expected: FAIL（`protocol` 字段被 executor 忽略 → 走 openai 路径 fetch `/images/generations` → `image_api_error`；或 trace 无 `outputImage` 字段）

- [ ] **Step 3: 实现执行器**（`electron/domains/ai/orchestration/graph-executor.ts`）

3a. `TraceEntry` 接口（~96 行 `outputPreview?: string;` 后）加：

```ts
  outputPreview?: string;
  /** 生成图片（imageGen 节点产物，相对数据根路径）→ 轨迹内缩略图展示 */
  outputImage?: string;
```

3b. `NodeOutput` 接口（~196 行）加同名字段：

```ts
interface NodeOutput {
  output: string;
  /** 循环节点死信（continue 模式失败项清单） */
  errorOutput?: string;
  /** 生成图片相对数据根路径（imageGen 专用，trace 透传） */
  outputImage?: string;
  route?: string;
  usage?: NodeResult["usage"];
  toolCalls?: TraceEntry["toolCalls"];
}
```

3c. `traceSuccess`（~1667 行 outputPreview 行后）加：

```ts
    outputPreview: done.output.slice(0, 200),
    ...(done.outputImage ? { outputImage: done.outputImage } : {}),
```

3d. `makeImageGenNodeHandler`（~2906 行）：`const output = await generateImage(node, ctx, prompt);` 改为分流，`traceSuccess` 调用补 `outputImage`：

```ts
      const output = isComfyUIImageGen(node)
        ? await generateImageComfyUI(node, ctx, {
            inputs: state.inputs,
            nodes: state.nodes,
            now: ctx.now,
          }, prompt)
        : await generateImage(node, ctx, prompt);
      await writeNodeMessages(
        ctx,
        node,
        prompt.slice(0, 100),
        output,
        startedAt,
      );
      ctx.trace.push(
        traceSuccess(node, startedAt, {
          output,
          outputImage: relativeAssetPath(output),
        }),
      );
```

3e. `generateImage` 尾部落盘三行（~3012-3015）抽成 helper 供两协议复用（openai 路径换调用）：

```ts
/** 生图产物落盘 workflow-assets，返回绝对路径（两协议共用） */
async function writeWorkflowImage(buffer: Buffer): Promise<string> {
  const dir = workflowAssetsDir();
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const file = path.join(dir, `image-${Date.now()}.png`);
  await (await import("node:fs/promises")).writeFile(file, buffer);
  return file;
}

/** 产物绝对路径 → 相对数据根路径（workflow-assets/xxx.png，MessageImage
 * 展示通道）；不在 workflow-assets 下（理论不可达）→ undefined */
function relativeAssetPath(output: string): string | undefined {
  const dir = workflowAssetsDir();
  return output.startsWith(dir + path.sep)
    ? `workflow-assets/${path.basename(output)}`
    : undefined;
}
```

3f. `generateImage` 函数后新增 comfyui 函数群（import 区补 `isComfyUIImageGen`/`ComfyImageGenNode`（自 graph-schema 现有 import 处）、`PromptRenderContext`（自 graph-prompt 现有 import 处））：

```ts
/** ComfyUI 服务商直取（comfyui 协议无 model 行，providerId 即引用） */
async function loadProviderRuntime(providerId: number) {
  const row = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!row) {
    throw new GraphRunFailure(
      "provider_missing",
      `节点服务商不存在: ${providerId}`,
    );
  }
  return {
    baseUrl: row.baseUrl,
    apiKey: row.apiKey ?? undefined,
    extraHeaders: row.extraHeaders,
  };
}

/** "1024x1024" → [w, h]；非法格式报 comfyui_invalid_size（防御性，UI
 * Select 已限定格式） */
function parseImageSize(size: string): [number, number] {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!m) {
    throw new GraphRunFailure(
      "comfyui_invalid_size",
      `尺寸格式非法: ${size}`,
    );
  }
  return [Number(m[1]), Number(m[2])];
}

/** 深度遍历应用本地占位：{{prompt}} 字符串内嵌入替换（可多次出现）；
 * {{width}}/{{height}}/{{seed}} 整值匹配替换保数值类型。返回是否已显式
 * 占位 {{seed}} */
function applyPlaceholders(
  value: unknown,
  vars: { prompt: string; width: number; height: number; seed: number },
): { value: unknown; seedPlaced: boolean } {
  if (typeof value === "string") {
    const withPrompt = value.split("{{prompt}}").join(vars.prompt);
    const m = /^\{\{(width|height|seed)\}\}$/.exec(withPrompt);
    if (m) {
      const key = m[1] as "width" | "height" | "seed";
      return { value: vars[key], seedPlaced: key === "seed" };
    }
    return { value: withPrompt, seedPlaced: false };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((v) => applyPlaceholders(v, vars).value),
      seedPlaced: false,
    };
  }
  if (value && typeof value === "object") {
    let seedPlaced = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = applyPlaceholders(v, vars);
      out[k] = r.value;
      seedPlaced = seedPlaced || r.seedPlaced;
    }
    return { value: out, seedPlaced };
  }
  return { value, seedPlaced: false };
}

/** randomizeSeed 且未显式占位时，替换 inputs 中 seed/noise_seed/rand_seed
 * 为随机 int——防 ComfyUI 缓存命中同 prompt 出同图 */
function randomizeSeedsInPlace(
  workflow: Record<string, unknown>,
  seed: number,
): void {
  for (const node of Object.values(workflow)) {
    const inputs = (node as { inputs?: Record<string, unknown> })?.inputs;
    if (!inputs) continue;
    for (const key of ["seed", "noise_seed", "rand_seed"]) {
      if (key in inputs) inputs[key] = seed;
    }
  }
}

/** workflowJson 两段渲染：renderNodePrompt 注入上游变量（JSON 串层）→
 * parse → 深度应用本地占位 → 按需 seed 随机化 */
function buildComfyWorkflow(
  node: ComfyImageGenNode,
  renderCtx: PromptRenderContext,
  prompt: string,
): Record<string, unknown> {
  const [width, height] = parseImageSize(node.size);
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const upstream = renderNodePrompt(node.workflowJson, renderCtx);
  let parsed: unknown;
  try {
    parsed = JSON.parse(upstream);
  } catch {
    throw new GraphRunFailure(
      "comfyui_workflow_invalid",
      "workflowJson 渲染后不是合法 JSON",
    );
  }
  const { value: applied, seedPlaced } = applyPlaceholders(parsed, {
    prompt,
    width,
    height,
    seed,
  });
  const workflow = applied as Record<string, unknown>;
  if (node.randomizeSeed && !seedPlaced) {
    randomizeSeedsInPlace(workflow, seed);
  }
  return workflow;
}

/** comfyui 请求头（Bearer 可选 + provider extraHeaders） */
async function comfyHeaders(runtime: {
  apiKey?: string;
  extraHeaders?: string;
}): Promise<Record<string, string>> {
  const { parseExtraHeaders } = await import("../provider/provider-runtime");
  return {
    "Content-Type": "application/json",
    ...(runtime.apiKey
      ? { Authorization: `Bearer ${runtime.apiKey}` }
      : {}),
    ...parseExtraHeaders(runtime.extraHeaders),
  };
}

/** 轮询 sleep（abort 立即醒） */
function sleepMs(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abort.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** ComfyUI workflow API 生图：/prompt 提交 → 1s 轮询 /history → /view
 * 取第一张 output 图落盘（多图只取第一张，对齐 n:1 语义） */
async function generateImageComfyUI(
  node: ComfyImageGenNode,
  ctx: NodeContext,
  renderCtx: PromptRenderContext,
  prompt: string,
): Promise<string> {
  const runtime = await loadProviderRuntime(node.providerId);
  const base = runtime.baseUrl.replace(/\/+$/, "");
  const headers = await comfyHeaders(runtime);
  const workflow = buildComfyWorkflow(node, renderCtx, prompt);
  const promptId = await submitComfyPrompt(node, base, headers, workflow, ctx);
  const historyEntry = await pollComfyHistory(
    node,
    base,
    headers,
    promptId,
    ctx,
  );
  const image = firstComfyImage(node, historyEntry);
  const buffer = await downloadComfyImage(node, base, headers, image, ctx);
  return writeWorkflowImage(buffer);
}

/** POST /prompt；非 200 或 node_errors 非空 → comfyui_api_error */
async function submitComfyPrompt(
  node: ComfyImageGenNode,
  base: string,
  headers: Record<string, string>,
  workflow: Record<string, unknown>,
  ctx: NodeContext,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: workflow,
        client_id: `tianshu-${Date.now()}`,
      }),
      signal: ctx.abort,
    });
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      "comfyui_request_failed",
      `ComfyUI 提交失败: ${errorMessage(e)}`,
    );
  }
  const payload = (await res.json().catch(() => null)) as {
    prompt_id?: string;
    node_errors?: Record<string, unknown>;
  } | null;
  if (!res.ok || !payload?.prompt_id || hasEntries(payload.node_errors)) {
    throw new GraphNodeFailure(
      node.id,
      "comfyui_api_error",
      `ComfyUI 提交被拒 HTTP ${res.status}: ${JSON.stringify(payload)?.slice(0, 200)}`,
    );
  }
  return payload.prompt_id;
}

function hasEntries(obj: Record<string, unknown> | undefined): boolean {
  return Boolean(obj && Object.keys(obj).length > 0);
}

/** 轮询 GET /history/{id}，1s 间隔，超 timeoutMs → comfyui_timeout */
async function pollComfyHistory(
  node: ComfyImageGenNode,
  base: string,
  headers: Record<string, string>,
  promptId: string,
  ctx: NodeContext,
): Promise<Record<string, unknown>> {
  const timeoutMs = node.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.abort.aborted) break;
    let payload: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`${base}/history/${promptId}`, {
        headers,
        signal: ctx.abort,
      });
      payload = res.ok ? await res.json().catch(() => null) : null;
    } catch {
      payload = null; // 单轮网络抖动吞掉，靠 deadline 兜底
    }
    const entry = payload?.[promptId];
    if (entry) return entry as Record<string, unknown>;
    await sleepMs(1_000, ctx.abort);
  }
  throw new GraphNodeFailure(
    node.id,
    "comfyui_timeout",
    `ComfyUI 生图超时（${timeoutMs}ms）`,
  );
}

/** history entry.outputs 取第一张 type=output 图 */
function firstComfyImage(
  node: ComfyImageGenNode,
  entry: Record<string, unknown>,
): { filename: string; subfolder: string; type: string } {
  const outputs = (
    entry as {
      outputs?: Record<
        string,
        { images?: Array<{ filename: string; subfolder: string; type: string }> }
      >;
    }
  ).outputs;
  for (const out of Object.values(outputs ?? {})) {
    const img = out.images?.find((i) => i.type === "output");
    if (img) return img;
  }
  throw new GraphNodeFailure(
    node.id,
    "comfyui_no_output",
    "ComfyUI 未产出图片",
  );
}

/** GET /view 下载图 */
async function downloadComfyImage(
  node: ComfyImageGenNode,
  base: string,
  headers: Record<string, string>,
  image: { filename: string; subfolder: string; type: string },
  ctx: NodeContext,
): Promise<Buffer> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  try {
    const res = await fetch(`${base}/view?${query}`, {
      headers,
      signal: ctx.abort,
    });
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      "comfyui_download_failed",
      `ComfyUI 取图失败: ${errorMessage(e)}`,
    );
  }
}
```

注：`errorMessage` 为该文件既有 helper（generateImage 在用）；`renderNodePrompt` 已 import。若 lint 报函数超行，优先保持现拆分不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-imagegen-comfyui.test.ts`
Expected: PASS（6 用例全绿；超时用例约 5s）

- [ ] **Step 5: 跑 executor 相关全量回归**

Run: `npx vitest run tests/ai/graph-executor.test.ts tests/ai/graph-http-node.test.ts tests/ai/graph-schema.test.ts tests/ai/graph-imagegen-comfyui.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/orchestration/graph-executor.ts tests/ai/graph-imagegen-comfyui.test.ts
git commit -m "feat(orchestration): imageGen ComfyUI workflow API 执行链+轨迹图片相对路径透出"
```

---

### Task 3: server 执行器同构 + drift 基线

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/graph-executor.ts`（与 Task 2 同构：TraceEntry、NodeOutput、traceSuccess、handler 分流、函数群；单引号风格；prisma 换 `graphExecutorRuntime().db`、`workflowAssetsDir()` 换 `graphExecutorRuntime().workflowAssetsDir()`）
- Test: Create `apps/tianshu-server/test/core/graph-imagegen-comfyui.spec.ts`

**Interfaces:**
- Consumes: Task 1 schema（经 `@tianshu/core` dist）；`installGraphExecutorRuntime` seam（`db`/`runs`/`publishRunUpdated`/`workflowAssetsDir`）；Task 2 的函数签名（双份同名同构）
- Produces: server 侧与 electron 侧行为一致的 comfyui 执行链

- [ ] **Step 1: 写失败测试**（新建 spec；组装抄自 `apps/tianshu-server/test/core/graph-executor.spec.ts:140-208`）

```ts
// apps/tianshu-server/test/core/graph-imagegen-comfyui.spec.ts
// imageGen comfyui 副本核心链路（真库 + fetch spy），同构 electron 测试
import { compileStateGraph } from '@tianshu/core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import {
  executeGraphRun,
  type GraphRow,
} from 'src/core/graph/graph-executor';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
  type GraphRunStore,
} from 'src/core/graph/executor-runtime';
import { createTestDb, type TestDb } from '../support/test-db';

const workflowJson = JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: 5 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: '{{width}}', height: '{{height}}' },
  },
});

function comfyGraphJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { topic: 'string' },
    nodes: [
      {
        id: 'gen',
        name: '生图',
        kind: 'imageGen',
        protocol: 'comfyui',
        providerId: 0, // beforeAll 里回填真实 id
        workflowJson,
        prompt: 'cat {{input.topic}}',
        size: '768x512',
        ...extra,
      },
    ],
    edges: [{ from: 'gen', to: 'END' }],
  });
}

describe('graph-executor imageGen comfyui（副本同构）', () => {
  let db: TestDb;
  let repo: GraphRepository;
  let ws: { id: number };
  let graphRow: GraphRow;
  let assetsDir: string;
  let providerId: number;

  const submitted: Array<Record<string, any>> = [];
  /** 轮询队列：shift 出队，空则 {}（模拟未完成） */
  const historyQueue: unknown[] = [];

  beforeAll(async () => {
    db = await createTestDb();
    repo = new GraphRepository(db.prisma);
    ws = await db.prisma.workspace.create({
      data: { name: 'comfy-ws', userId: 1 },
    });
    const provider = await db.prisma.provider.create({
      data: {
        name: 'comfy',
        type: 'comfyui',
        baseUrl: 'http://localhost:8188',
        userId: 1,
      },
    });
    providerId = provider.id;
    graphRow = await db.prisma.graphDefinition.create({
      data: {
        name: 'comfy 图',
        graphJson: comfyGraphJson().replace(
          '"providerId":0',
          `"providerId":${providerId}`,
        ),
        userId: 1,
      },
    });
    assetsDir = await mkdtemp(join(tmpdir(), 'comfy-assets-'));
    const statefulRuns: GraphRunStore = {
      createRun: (p) => repo.createRun(p),
      finishRun: (p) => repo.finishRun(p),
    };
    installGraphExecutorRuntime({
      db: db.prisma,
      runs: statefulRuns,
      publishRunUpdated: () => undefined,
      workflowAssetsDir: () => assetsDir,
    });
    jest.spyOn(global, 'fetch').mockImplementation(
      (async (url: any, init?: any) => {
        const u = String(url);
        if (u.endsWith('/prompt')) {
          submitted.push(JSON.parse(String(init?.body)));
          return { ok: true, status: 200, json: async () => ({ prompt_id: 'p1', node_errors: {} }) };
        }
        if (u.includes('/history/')) {
          return { ok: true, status: 200, json: async () => historyQueue.shift() ?? {} };
        }
        if (u.includes('/view?')) {
          return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('srv-png').buffer };
        }
        throw new Error(`unexpected fetch: ${u}`);
      }) as never,
    );
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await rm(assetsDir, { recursive: true, force: true });
    await db.cleanup();
  });

  const runParams = () => ({
    graph: graphRow,
    task: null,
    inputs: { topic: 'cats' },
    triggerType: 'manual' as const,
    attempt: 1,
    abort: new AbortController().signal,
    workspace: { id: ws.id, directoryPath: null },
  });

  const makeDeps = () => ({
    createChatModel: () => {
      throw new Error('comfyui 图不应触达 LLM');
    },
    toLangChainTools: () => [],
    compileStateGraph,
  });

  it('成功链路：占位注入+产物落盘+trace outputImage', async () => {
    historyQueue.push(
      {},
      {
        p1: {
          outputs: {
            '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
          },
        },
      },
    );
    const outcome = await executeGraphRun(runParams(), makeDeps());
    expect(outcome).toBe('success');
    expect(submitted.at(-1)!.prompt['6'].inputs.text).toBe('cat cats');
    expect(submitted.at(-1)!.prompt['5'].inputs.width).toBe(768);
    expect(submitted.at(-1)!.prompt['3'].inputs.seed).not.toBe(5);
    const run = await db.prisma.automationRun.findFirst({
      where: { graphId: graphRow.id },
      orderBy: { id: 'desc' },
    });
    const trace = JSON.parse(run!.graphTrace!);
    expect(trace[0].outputImage).toMatch(/^workflow-assets\/image-\d+\.png$/);
    const abs = join(assetsDir, trace[0].outputImage.replace('workflow-assets/', ''));
    expect((await readFile(abs)).toString()).toBe('srv-png');
  }, 20_000);

  it('node_errors 非空 → comfyui_api_error', async () => {
    jest.spyOn(global, 'fetch').mockImplementationOnce(
      (async () =>
        ({ ok: false, status: 400, json: async () => ({ error: {}, node_errors: { '3': { errors: [{}] } } }) })) as never,
    );
    const outcome = await executeGraphRun(runParams(), makeDeps());
    expect(outcome).toBe('failed');
    const run = await db.prisma.automationRun.findFirst({
      where: { graphId: graphRow.id },
      orderBy: { id: 'desc' },
    });
    const trace = JSON.parse(run!.graphTrace!);
    expect(trace[0].error.code).toBe('comfyui_api_error');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/tianshu-server && npx jest test/core/graph-imagegen-comfyui.spec.ts`
Expected: FAIL（server executor 无 protocol 分流 → 走 openai 路径 → `image_api_error`；或超时用例 300s 默认——先看失败形态确认走错分支）

- [ ] **Step 3: 同构移植**（`apps/tianshu-server/src/core/graph/graph-executor.ts`）

按 Task 2 Step 3 的 3a–3f 逐块移植，仅三处适配：
1. `loadProviderRuntime` 里 `prisma.provider.findUnique` → `const db = graphExecutorRuntime().db; await db.provider.findUnique(...)`（对齐 server `loadModelRuntime` 1524 行写法）
2. `writeWorkflowImage`/`relativeAssetPath` 里 `workflowAssetsDir()` → `graphExecutorRuntime().workflowAssetsDir()`（对齐 server 3139 行写法）
3. 全部字符串单引号、尾随逗号 all（server Prettier）

server 侧 `import { isComfyUIImageGen } from '@tianshu/core'` 加入现有 `@tianshu/core` import（Task 1 已重建 dist，类型即生效）。`PromptRenderContext` 同自 `@tianshu/core`（graph-prompt 子路径——跟随该文件现有 `renderNodePrompt` 的 import 处）。

**另核对一处**（spec §6）：server 侧 provider 写面若有 type 白名单校验（DTO/repository/create 链），同步加 `'comfyui'`——检索 `apps/tianshu-server/src` 中 provider 模块对 `type` 的枚举/校验；若无校验（DB String 列透传）则零改动，在 commit message 无需提及。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/tianshu-server && npx jest test/core/graph-imagegen-comfyui.spec.ts`
Expected: PASS

- [ ] **Step 5: server 全量回归 + drift 基线重置**

Run: `cd apps/tianshu-server && npx jest`
Expected: PASS（无既有用例回归）

Run: `npm run check:drift`
Expected: 大概率 FAIL（双份执行器新增行数超容差）→ 执行 `npm run check:drift -- --rebase` 重置基线，然后 `git diff packages/tianshu-core/scripts/drift-manifest.json` 人工复核新增差异段确为本次同构代码（两份新增行应基本对齐，差异仅 prisma/seam 三处适配）。

- [ ] **Step 6: Commit**

```bash
git add apps/tianshu-server/src/core/graph/graph-executor.ts apps/tianshu-server/test/core/graph-imagegen-comfyui.spec.ts packages/tianshu-core/scripts/drift-manifest.json
git commit -m "feat(server): 移植 imageGen ComfyUI 执行链——无头端同构双份+drift 基线入册"
```

---

### Task 4: 前端节点编辑器协议切换 + i18n

**Files:**
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts:602-612`（newImageGenNode）
- Modify: `src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx:2661-2708`（ImageGenNodeFields + 新增 ComfyProviderSelect）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`（orchestration.editor 分层）
- Test: `tests/ai/graph-editor-model.test.ts`（文件尾追加）

**Interfaces:**
- Consumes: Task 1 的 `isComfyUIImageGen`（前端经 `@/` alias → tianshu-core 源码）；`GraphNodePatch`（展开覆盖语义：显式 `undefined` 可清字段）；`HighlightTextarea`（language="prompt"——`{{...}}` 变量 chip 高亮正合 workflow 占位编辑）；`@/components/ui/switch`；`ProviderApi.list()`
- Produces: `newImageGenNode` 默认值含 `protocol: "openai"`；UI 上 imageGen 节点可切协议

- [ ] **Step 1: 写失败测试**（`tests/ai/graph-editor-model.test.ts` 尾追加；import 区补 `newImageGenNode`）

```ts
describe("newImageGenNode", () => {
  it("默认 openai 协议 + 显式默认值（与 schema 同口径）", () => {
    const node = newImageGenNode("gen");
    expect(node.protocol).toBe("openai");
    expect(node.modelId).toBe(0);
    expect(node.randomizeSeed).toBe(true);
    expect(node.timeoutMs).toBe(300_000);
    expect(node.size).toBe("1024x1024");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-editor-model.test.ts`
Expected: FAIL（`node.protocol` 为 undefined）

- [ ] **Step 3: 实现**

3a. `newImageGenNode`（graph-editor-model.ts）：

```ts
/** 图像生成节点默认：openai 协议、modelId 0 占位（zod 拦保存引导先选
 * 模型）、1024 方图；comfyui 默认值同口径（randomizeSeed/timeoutMs） */
export function newImageGenNode(id: string): ImageGenNode {
  return {
    id,
    name: "",
    kind: "imageGen",
    protocol: "openai",
    modelId: 0,
    prompt: "",
    size: "1024x1024",
    randomizeSeed: true,
    timeoutMs: 300_000,
  };
}
```

3b. i18n（两份 chat.json 的 `orchestration.editor` 对象内同步加，key 一致）：

zh-CN：
```json
"imageProtocol": "接口协议",
"comfyProvider": "ComfyUI 服务",
"comfyNoProvider": "暂无 ComfyUI 服务商，请先在「AI 服务商」页添加",
"comfyWorkflow": "Workflow JSON",
"comfyWorkflowHint": "从 ComfyUI 导出（API 格式）后粘贴，用 {{prompt}}/{{width}}/{{height}}/{{seed}} 占位；支持上游 {{}} 变量",
"comfyRandomSeed": "随机种子"
```
en-US：
```json
"imageProtocol": "Protocol",
"comfyProvider": "ComfyUI service",
"comfyNoProvider": "No ComfyUI provider yet — add one in AI Providers first",
"comfyWorkflow": "Workflow JSON",
"comfyWorkflowHint": "Paste the ComfyUI export (API format); use {{prompt}}/{{width}}/{{height}}/{{seed}} placeholders; upstream {{}} variables supported",
"comfyRandomSeed": "Random seed"
```

3c. `ImageGenNodeFields` 重写（GraphNodeEditor.tsx 2661-2708；import 区补 `isComfyUIImageGen`（自 graph.schema 或 graph-editor-model 类型同源处，跟随文件现有 schema import）、`Switch`、`ProviderApi`——ProviderApi 文件内 ModelSelect 已在用则已 import）：

```tsx
export function ImageGenNodeFields({
  node,
  onPatch,
}: {
  node: ImageGenNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const comfy = isComfyUIImageGen(node);
  return (
    <>
      <Field label={t("chat:orchestration.editor.imageProtocol")}>
        <Select
          value={comfy ? "comfyui" : "openai"}
          onValueChange={(value) =>
            onPatch(
              value === "comfyui"
                ? {
                    protocol: "comfyui",
                    modelId: undefined,
                    providerId: undefined,
                    workflowJson: "",
                  }
                : {
                    protocol: "openai",
                    modelId: 0,
                    providerId: undefined,
                    workflowJson: undefined,
                  },
            )
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="openai">OpenAI 兼容</SelectItem>
            <SelectItem value="comfyui">ComfyUI</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {comfy ? (
        <>
          <ComfyProviderSelect node={node} onPatch={onPatch} />
          <Field
            label={t("chat:orchestration.editor.comfyWorkflow")}
            hint={t("chat:orchestration.editor.comfyWorkflowHint")}
            className="col-span-full"
          >
            <HighlightTextarea
              value={node.workflowJson}
              onChange={(next) => onPatch({ workflowJson: next })}
              language="prompt"
              height={200}
            />
          </Field>
          <Field label={t("chat:orchestration.editor.comfyRandomSeed")}>
            <Switch
              checked={node.randomizeSeed}
              onCheckedChange={(v) => onPatch({ randomizeSeed: v })}
            />
          </Field>
        </>
      ) : (
        <Field label={t("chat:orchestration.editor.model")}>
          <ModelSelect
            modelId={node.modelId ?? 0}
            onSelect={(modelId) => onPatch({ modelId })}
          />
        </Field>
      )}
      <Field label={t("chat:orchestration.editor.imageSize")}>
        {/* size Select 原样保留（2677-2693 行整块不动） */}
      </Field>
      <Field
        label={t("chat:orchestration.editor.imagePrompt")}
        hint={t("chat:orchestration.editor.imagePromptHint")}
        className="col-span-full"
      >
        {/* HighlightTextarea prompt 原样保留（2699-2704 行不动） */}
      </Field>
    </>
  );
}
```

注意两点：① `comfyRandomSeed` 的 Field 重复挂 `comfyWorkflowHint` 不对——去掉 hint 属性（仅 label）。② size/prompt 两个 Field 块从原 2677-2705 行原样搬入（不要真的留注释占位）。③ `node.modelId ?? 0` 与 `node.workflowJson` 在 comfy 分支外/内的收窄由 `isComfyUIImageGen` 守卫保证——但 JSX 里 TS 收窄跨表达式可能失效：`comfy` 为 const 布尔 + 三元结构可收窄；若 typecheck 报错，用 `(node as ComfyImageGenNode).workflowJson` 显式断言（import 类型）。

3d. `ComfyProviderSelect`（GraphNodeEditor.tsx 内 ModelSelect 旁新增）：

```tsx
/** ComfyUI 服务商选择（过滤 type=comfyui；空集引导去设置页添加）。
 * props 收 ImageGenNode 宽类型（JSX 三元里 TS 收窄跨 const 布尔失效），
 * providerId 直接读 optional 字段 */
function ComfyProviderSelect({
  node,
  onPatch,
}: {
  node: ImageGenNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const { data: providers = [] } = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const comfy = providers.filter(
    (p) => p.type === "comfyui" && p.enabled,
  );
  const current = comfy.find((p) => p.id === node.providerId);
  return (
    <Field
      label={t("chat:orchestration.editor.comfyProvider")}
      className="col-span-full"
    >
      <div className="flex flex-col gap-1">
        <Select
          value={current ? String(node.providerId) : ""}
          onValueChange={(value) => onPatch({ providerId: Number(value) })}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue placeholder={t("chat:orchestration.editor.comfyProvider")} />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            {comfy.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {comfy.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("chat:orchestration.editor.comfyNoProvider")}
          </p>
        )}
      </div>
    </Field>
  );
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/ai/graph-editor-model.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: 无错误（若 GraphNodeEditor 报 `providerId: undefined` 类型不兼容——`Partial` 交叉类型下 `undefined` 赋给 `number | undefined` 合法，不应报错；报错则检查 schema 是否漏 optional）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration/lib/graph-editor-model.ts src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/graph-editor-model.test.ts
git commit -m "feat(orchestration): imageGen 编辑器协议切换+ComfyUI 配置面——服务商选择/workflow 编辑/随机种子"
```

---

### Task 5: NodeCard 摘要 ComfyUI 态

**Files:**
- Modify: `src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx:48-52`（providers query）、`:297-306`（imageGen 摘要分支）

**Interfaces:**
- Consumes: `ProviderApi.list()`；Task 1 类型（node.protocol 判别）
- Produces: 画布节点卡片 imageGen 摘要 comfyui 态显示 `provider.name · ComfyUI`

- [ ] **Step 1: 实现**（纯展示，无独立测试——跟随 NodeCard 现状无测试文件的惯例；由 typecheck 守护）

```tsx
// 48 行区（models query 旁）加：
  const { data: providers = [] } = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
```

297-306 行 imageGen 分支替换为：

```tsx
    case "imageGen":
      if (node.protocol === "comfyui") {
        const provider = providers.find((p) => p.id === node.providerId);
        return (
          <div className="mt-1">
            <span className={provider ? dim : dimEmpty}>
              {provider
                ? `${provider.name} · ComfyUI`
                : t("chat:orchestration.editor.comfyNoProvider")}
            </span>
          </div>
        );
      }
      return (
        <div className="mt-1">
          <span className={model ? dim : dimEmpty}>
            {model
              ? model.name || model.modelId
              : t("chat:orchestration.editor.selectModel")}
          </span>
        </div>
      );
```

- [ ] **Step 2: 类型检查 + 相关测试回归**

Run: `npm run typecheck && npx vitest run tests/ai/graph-canvas-model.test.ts`
Expected: 通过（`ProviderApi` import 补入文件头；`model` 变量在 openai 态沿用）

- [ ] **Step 3: Commit**

```bash
git add src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx
git commit -m "feat(orchestration): 节点卡片 imageGen ComfyUI 态摘要显示服务商"
```

---

### Task 6: provider 面——类型/预设/连通测试

**Files:**
- Modify: `src-react/domains/ai/api/provider.api.ts:12-19`（PROVIDER_TYPES）
- Modify: `src-react/domains/ai/provider/model/presets.ts:12-53`（加预设）
- Modify: `electron/domains/ai/provider/connectivity.ts:30-47`（testConnection comfyui 分支）
- Test: `tests/ai/connectivity.test.ts`（追加用例）

**Interfaces:**
- Consumes: `ProviderType` 联合类型（PROVIDER_TYPES 派生）；`TestConnectionResult` 既有形状 `{ success, errorCode?, message }`
- Produces: `"comfyui"` 进入 `ProviderType` 联合；ProviderDialog 的 type 下拉（179 行 map PROVIDER_TYPES）与预设下拉（153 行 map PROVIDER_PRESETS）自动出现 ComfyUI，Dialog 零代码改动；`testConnection` 对 `type === "comfyui"` 走 `GET /system_stats`

- [ ] **Step 1: 写失败测试**（`tests/ai/connectivity.test.ts` 的 describe 内追加）

```ts
describe("comfyui", () => {
  it("system_stats 200 → 连通", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    );
    const result = await testConnection(
      { type: "comfyui", baseUrl: "http://127.0.0.1:8188", apiKey: undefined },
      "",
    );
    expect(result.success).toBe(true);
    expect(String(vi.mocked(global.fetch).mock.calls[0][0])).toBe(
      "http://127.0.0.1:8188/system_stats",
    );
    vi.unstubAllGlobals();
  });

  it("HTTP 500 → 失败带状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );
    const result = await testConnection(
      { type: "comfyui", baseUrl: "http://127.0.0.1:8188", apiKey: undefined },
      "",
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("500");
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/connectivity.test.ts`
Expected: FAIL（type "comfyui" 不在 ProviderType → TS 编译错或运行时走 UNSUPPORTED_TYPE_TEST 分支）

- [ ] **Step 3: 实现**

3a. provider.api.ts：

```ts
export const PROVIDER_TYPES = [
  "openai-compatible",
  "anthropic",
  "gemini",
  "ollama",
  "comfyui",
] as const;
```

3b. presets.ts 尾部追加：

```ts
  {
    label: "ComfyUI（本地）",
    type: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
  },
```

3c. connectivity.ts `testConnection`（39-46 行区）在 `if (provider.type !== "openai-compatible")` 之前插入：

```ts
  if (provider.type === "comfyui") {
    return testComfyConnection(provider);
  }
```

文件内新增（对齐既有探测函数风格）：

```ts
/** comfyui 探测：GET /system_stats（无模型概念，modelId 不消费） */
async function testComfyConnection(
  provider: ProviderRuntimeInfo,
): Promise<TestConnectionResult> {
  try {
    const base = provider.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/system_stats`, {
      ...(provider.apiKey
        ? { headers: { Authorization: `Bearer ${provider.apiKey}` } }
        : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        success: false,
        errorCode: "ENDPOINT_ERROR",
        message: `HTTP ${res.status}`,
      };
    }
    return { success: true, message: "" };
  } catch (error) {
    // 对齐文件内既有 catch 的错误映射风格（ENDPOINT_ERROR / AUTH_FAILED 等）
    return { success: false, errorCode: "ENDPOINT_ERROR", message: String(error) };
  }
}
```

（`errorCode` 取值若文件内已有更贴切枚举如 `CONNECTION_FAILED`，跟随既有命名——以文件内实际存在的 errorCode 全集为准。）

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/ai/connectivity.test.ts tests/ai/provider-list.test.tsx`
Expected: PASS

Run: `npm run typecheck`
Expected: 无错误（`remote-catalog.ts` 的 `toProviderRecord` 若对 type 做 `as ProviderType` 收窄会自然兼容 string；报错则把该 cast 改为直传 string）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/api/provider.api.ts src-react/domains/ai/provider/model/presets.ts electron/domains/ai/provider/connectivity.ts tests/ai/connectivity.test.ts
git commit -m "feat(provider): ComfyUI 服务商类型+本地预设+system_stats 连通测试"
```

---

### Task 7: 运行轨迹生成图片可视化

**Files:**
- Modify: `src-react/domains/ai/orchestration/components/GraphRunTraceView.tsx:18-38`（TraceEntry 镜像类型）、`:142-163`（TraceDetail）
- Test: `tests/ai/graph-run-trace-view.test.tsx`（追加用例）

**Interfaces:**
- Consumes: Task 2 产出的 trace `outputImage` 字段（镜像类型同步）；chat 域 `MessageImage`（`src-react/domains/ai/chat/components/MessageImage.tsx`，props `{ imagePath: string; name?: string }`，内部 IPC `file:readMessageImage` + queryKey 缓存 + lightbox + 失效降级）
- Produces: 轨迹详情有 `outputImage` 渲染缩略图（替代路径文本 pre），无则保持纯文本

- [ ] **Step 1: 写失败测试**（`tests/ai/graph-run-trace-view.test.tsx` 追加；先看该文件现有 wrapper/mock 方式——MessageImage 依赖 `@/lib/ipc` invoke 与 react-query，需 mock + QueryClientProvider 包装，跟随文件内现有组件测试装配）

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async () => "data:image/png;base64,AAA"),
}));

it("outputImage 存在 → 渲染缩略图且不显示路径文本 pre", async () => {
  const trace: TraceEntry[] = [
    {
      id: "gen",
      name: "生图",
      status: "success",
      startedAt: "2026-10-23T00:00:00Z",
      durationMs: 1000,
      outputPreview: "/abs/path/image-1.png",
      outputImage: "workflow-assets/image-1.png",
    },
  ];
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <GraphRunTraceView trace={trace} />
    </QueryClientProvider>,
  );
  // 展开行
  await userEvent.click(screen.getByText("生图"));
  const img = await screen.findByRole("img");
  expect(img).toHaveAttribute("src", "data:image/png;base64,AAA");
  // 有图时不再显示路径文本块
  expect(
    screen.queryByText("/abs/path/image-1.png"),
  ).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-run-trace-view.test.tsx`
Expected: FAIL（无 img 元素 / 路径 pre 仍渲染）

- [ ] **Step 3: 实现**

3a. `TraceEntry`（18-38 行）加字段：

```ts
  outputPreview?: string;
  /** 生成图片（imageGen 产物，相对数据根路径）——展示走 MessageImage */
  outputImage?: string;
```

3b. `TraceDetail` 里 `outputPreview` 块（154-163 行）替换为：

```tsx
      {entry.outputImage ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t("chat:orchestration.trace.output")}
          </p>
          <MessageImage imagePath={entry.outputImage} />
        </div>
      ) : (
        entry.outputPreview && (
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t("chat:orchestration.trace.output")}
            </p>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {entry.outputPreview}
            </pre>
          </div>
        )
      )}
```

3c. 文件头 import：

```tsx
import { MessageImage } from "@/domains/ai/chat/components/MessageImage";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-run-trace-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration/components/GraphRunTraceView.tsx tests/ai/graph-run-trace-view.test.tsx
git commit -m "feat(orchestration): 运行轨迹生成图片可视化——outputImage 缩略图+lightbox 复用消息图片链路"
```

---

### Task 8: 全量回归收尾

**Files:** 无新改动（纯验证；若前序任务有遗漏在此暴露修复）

- [ ] **Step 1: 根全量测试**

Run: `npm run test`
Expected: PASS（含既有全量回归——重点关注 settings/chat 等宽面用例无涟漪）

- [ ] **Step 2: server 全量测试**

Run: `npm run test -w apps/tianshu-server`
Expected: PASS

- [ ] **Step 3: 类型检查 + lint + drift 终验**

Run: `npm run typecheck && npm run lint && npm run check:drift`
Expected: 全绿（drift 已在 Task 3 rebase）

- [ ] **Step 4: 手动冒烟（可选但推荐）**

`npm run dev` 起应用：编排页加 imageGen 节点 → 切 ComfyUI 协议 → 选/新建 ComfyUI 服务商 → 贴导出的 workflow JSON（正向词替换为 `{{prompt}}`）→ 试运行 → 展开轨迹查看图片。无本地 ComfyUI 时至少验证 UI 三态（协议切换/空服务商提示/workflow 编辑）与错误码展示。

- [ ] **Step 5: 收尾 commit（若有修复）**

```bash
git add -A && git commit -m "test(orchestration): imageGen ComfyUI 批全量回归收尾"
```
