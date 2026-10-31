# Phase 2 rerank 节点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `rerank` 工作流节点——cross-encoder 重排，消费上游 hybridSearch 的 hits 旁路，对接业界事实标准 `POST /rerank` 端点（Cohere/Jina/vLLM 同形）。

**Architecture:** schema 入 core 单份；executor handler 双份（mirror+server）照 embedTexts 的 fetch 模式；模型挂接走 provider/model 体系（`model.type=reranker` 类型位已预留，`loadModelRuntime` 补 `modelType` 字段）；消费 `state.nodes[sourceNodeId].hits`（Phase 1 已埋）；输出文本 + hits 旁路（FusedHit 形态沿用）。

**Tech Stack:** zod、fetch、vitest（mock fetch）、既有 filterType 组件（`"reranker"`）。

**Spec:** `docs/superpowers/specs/2026-10-30-hybrid-search-node-design.md` 的 **Phase 2 章节**（设计定稿——执行者读该章节为需求源）

## Global Constraints

- **双份铁律**：`graph-executor.ts` mirror↔server 同步改（dispatch/`ModelRuntime.modelType`/handler），drift 容差内（graph-executor 基线 217，增量预计 ~90 行，超容差则定向过账并注明）；`vector-store.ts` 本批不动。
- **签名/契约**：`rerankNodeSchema` 字段逐字对齐 spec Phase 2.1；错误码 `rerank_model_type`/`rerank_source_invalid`/`rerank_api_error`（snake_case 人话中文）。
- **行为边界（spec Phase 2.2 逐条）**：来源节点不存在或 hits 字段 undefined（未连线/非检索节点）→ `rerank_source_invalid`；hits 存在但空数组 → **透传空输出**（空串 + 空 hits，不报错）；候选 250 上限（超限截断 trace 标注）；单文档 2000 字符截断；API 失败显式报错**不静默降级**。
- **输出形态**：`【sourceName｜相关度 0.87】text` 多段 `\n\n`（relevance_score 0~1）；hits 旁路 FusedHit（score=relevance_score、rank=重排名次）。
- 回归基线：mirror vitest（4460+9 skipped 口径）、server jest 75 suites、typecheck 恰 5 条预存、drift graph-vector-store 24 不动。
- 提交纪律：中文 conventional；dist git-ignored 不入 commit（core 改后 worktree 内重建）。

---

### Task 1: core schema（rerankNodeSchema）

**Files:**
- Modify: `packages/tianshu-core/src/graph-schema.ts`
- Test: `tests/core/graph-schema.test.ts`（若无既有文件则并入 `tests/core/retrieval.test.ts` 旁新建——先查；schema union parse 断言放 mirror vitest 既有 graph 相关测试文件）

**Interfaces:**
- Produces: `rerankNodeSchema`、`export type RerankNode = z.infer<typeof rerankNodeSchema>`（T2/T4 依赖）。

- [ ] **Step 1: schema 定义**（hybridSearchNodeSchema 之后、union 与类型导出区同款三落点）

```typescript
/** 重排节点（kind:rerank）：消费上游 hybridSearch 的 hits 旁路做
 * cross-encoder 重排（业界事实标准 POST /rerank，Cohere/Jina/vLLM 同形）；
 * 模型须 model.type=reranker（provider/model 体系已预留类型位）。
 * sourceNodeId 须经图边保证先执行——未连线时 hits 缺失报
 * rerank_source_invalid 系预期行为而非 bug（对齐 Dify 变量引用惯例）。 */
export const rerankNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("rerank"),
  query: z.string().min(1),
  sourceNodeId: z.string().min(1),
  modelId: z.number().int(),
  topN: z.number().int().min(1).max(50).default(5),
  timeoutMs: z.number().int().optional(),
});
```

- [ ] **Step 2: 验证 + Commit**

`npx vitest run tests/core tests/ai/graph-hybrid.test.ts` 全绿（union 扩容不破既有 parse）；重建 core dist。
`feat(core): rerank 节点 schema 入包——sourceNodeId 显式引用/topN/modelId 必填`

---

### Task 2: mirror executor（ModelRuntime.modelType + handler + 单测）

**Files:**
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`
- Test: `tests/ai/graph-hybrid.test.ts`（追加 rerank describe 块）

**Interfaces:**
- Consumes: T1 `RerankNode`；core `FusedHit`；既有 `loadModelRuntime`/`embedTexts` 错误链路模式；`state.nodes[id].hits`（NodeResult.hits）。
- Produces: `makeRerankNodeHandler`（dispatch 注册 kind "rerank"）；`ModelRuntime` 增加 `modelType: string`（`modelRow.type ?? "llm"`——loadModelRuntime 返回处一行，embedTexts 等既有消费零影响）。

- [ ] **Step 1: 失败测试（追加）**

```typescript
describe("rerank 节点", () => {
  const rerankNode = {
    id: "rr1", kind: "rerank", name: "重排",
    query: "容错 设计", sourceNodeId: "hs1",
    modelId: 9, topN: 3,
  };
  const seedHits = (n = 2) => Array.from({ length: n }, (_, i) => ({
    chunkId: i + 1, sourceName: `s${i + 1}`, collection: "c",
    text: `原文片段${i + 1}`, score: 0.5, rank: i + 1,
  }));

  it("模型非 reranker 报 rerank_model_type", async () => {
    prisma.model.findUnique.mockResolvedValue({ id: 9, providerId: 2, modelId: "m", type: "llm" });
    await expect(runRerank(rerankNode, { nodes: { hs1: { output: "x", hits: seedHits() } } }))
      .rejects.toMatchObject({ code: "rerank_model_type" });
  });
  it("来源无 hits 字段（未连线/非检索）报 rerank_source_invalid；空数组透传空", async () => {
    mockRerankerModel();
    await expect(runRerank(rerankNode, { nodes: { other: { output: "x" } } }))
      .rejects.toMatchObject({ code: "rerank_source_invalid" });
    const update = await runRerank(rerankNode, { nodes: { hs1: { output: "", hits: [] } } });
    expect(update.nodes.rr1.output).toBe("");
    expect(update.nodes.rr1.hits).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rerank API 全链路：请求体形态/index 回挂/降序切 topN/hits 旁路", async () => {
    mockRerankerModel();
    fetchMock.mockResolvedValue(jsonResponse({
      results: [{ index: 1, relevance_score: 0.91 }, { index: 0, relevance_score: 0.42 }],
    }));
    const update = await runRerank(rerankNode, { nodes: { hs1: { output: "x", hits: seedHits() } } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain("/rerank");
    expect(body).toMatchObject({ model: "m", query: "容错 设计", top_n: 3 });
    expect(body.documents).toEqual(["原文片段1", "原文片段2"]);
    expect(update.nodes.rr1.hits[0]).toMatchObject({ sourceName: "s2", score: 0.91, rank: 1 });
    expect(update.nodes.rr1.output).toContain("【s2｜相关度 0.91】原文片段2");
  });
  it("候选 250 上限截断 + 单文档 2000 字符截断 + API 失败显式 rerank_api_error", async () => {
    mockRerankerModel();
    const many = seedHits(260).map((h, i) => ({ ...h, text: "长".repeat(2100) + i }));
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    await runRerank(rerankNode, { nodes: { hs1: { output: "x", hits: many } } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.documents).toHaveLength(250);
    expect(body.documents[0].length).toBe(2000);
    fetchMock.mockResolvedValue(new Response("err", { status: 502 }));
    await expect(runRerank(rerankNode, { nodes: { hs1: { output: "x", hits: seedHits() } } }))
      .rejects.toMatchObject({ code: "rerank_api_error" });
  });
});
```

（`runRerank`/`mockRerankerModel`/`jsonResponse` 辅助照该文件既有 mock 面：`prisma.model.findUnique` 返回 `{id, providerId, modelId:"m", type:"reranker"}`、`prisma.provider.findUnique` 返回既有 provider 桩、`fetchMock` 全局 fetch 桩。）

- [ ] **Step 2: 验证 RED → 实现（handler 对齐 spec Phase 2.2 与上述行为边界）→ GREEN**

handler 骨架（错误链路全对齐 embedTexts：Bearer/extraHeaders/AbortSignal.any/非 2xx 带 payload 摘要）：

```typescript
function makeRerankNodeHandler(node: RerankNode, ctx: NodeContext): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const render = (text: string) => renderNodePrompt(text, { inputs: state.inputs, nodes: state.nodes, now: ctx.now });
      const query = render(node.query);
      const runtime = await loadModelRuntime(node.modelId);
      if ((runtime.modelType ?? "llm") !== "reranker") {
        throw new GraphNodeFailure(node.id, "rerank_model_type",
          "重排节点须选择 reranker 类型模型（模型管理里的类型标记）");
      }
      const source = state.nodes[node.sourceNodeId];
      if (!source || source.hits === undefined) {
        throw new GraphNodeFailure(node.id, "rerank_source_invalid",
          `来源节点未执行或无结构化候选：须将「${node.sourceNodeId}」（hybridSearch 节点）连线至本节点上游`);
      }
      if (source.hits.length === 0) {
        const output = "";
        await writeNodeRecord(ctx, node, query, output, startedAt);
        ctx.trace.push(traceSuccess(node, startedAt, { output }));
        return toNodeUpdate(node.id, { output, hits: [] });
      }
      const candidates = source.hits.slice(0, 250)
        .map((h) => ({ ...h, text: h.text.slice(0, 2000) }));
      const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(node.timeoutMs ?? 120_000)]);
      const { parseExtraHeaders } = await import("../provider/provider-runtime");
      const base = runtime.provider.baseUrl.replace(/\/+$/, "");
      let response: Response;
      try {
        response = await fetch(`${base}/rerank`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(runtime.provider.apiKey ? { Authorization: `Bearer ${runtime.provider.apiKey}` } : {}),
            ...parseExtraHeaders(runtime.provider.extraHeaders),
          },
          body: JSON.stringify({
            model: runtime.sdkId, query,
            documents: candidates.map((c) => c.text), top_n: node.topN,
          }),
          signal,
        });
      } catch (e) {
        throw new GraphRunFailure("rerank_api_error", `重排请求失败: ${errorMessage(e)}`);
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new GraphRunFailure("rerank_api_error",
          `重排接口返回 HTTP ${response.status}: ${JSON.stringify(payload)?.slice(0, 200)}`);
      }
      const results = (payload as { results?: Array<{ index?: number; relevance_score?: number }> })?.results ?? [];
      const fused: FusedHit[] = results
        .filter((r) => typeof r.index === "number" && candidates[r.index])
        .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
        .slice(0, node.topN)
        .map((r, i) => ({ ...candidates[r.index!], score: r.relevance_score ?? 0, rank: i + 1 }));
      const output = fused.map((h) => `【${h.sourceName}｜相关度 ${h.score.toFixed(2)}】${h.text}`).join("\n\n");
      await writeNodeRecord(ctx, node, query, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, {
        output, hitsPreview: JSON.stringify(fused).slice(0, 2000),
      }));
      return toNodeUpdate(node.id, { output, hits: fused });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.query, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}
```

（`loadModelRuntime` 返回对象补 `modelType: modelRow.type ?? "llm"`；dispatch 加 `if (node.kind === "rerank") return makeRerankNodeHandler(node, ctx);`——位置照 hybridSearch 分支后。）

- [ ] **Step 3: 回归 + Commit**

`npx vitest run tests/ai tests/core` 全绿。
`feat(graph): rerank 节点 handler——/rerank 端点/hits 消费与旁路/三错误码/边界四条`

---

### Task 3: server 双份同步

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/graph-executor.ts`（T2 同段：ModelRuntime.modelType、dispatch、handler；`traceSuccess` payload 形态按 server 侧签名适配）

**Interfaces:**
- Consumes: T2 mirror 成品（parity 移植）；T1 schema（core dist 重建后 server 经 overlay 消费——worktree 环境先重建 dist + 确认 `apps/node_modules/@tianshu/*` overlay 在场）。
- Produces: server 无头端同能力；drift graph-executor 增量核算（预计 ~90 行超容差 → 定向过账基线 217→约 310 并注明，或按实际核算）。

- [ ] **Step 1: 移植（逻辑段 parity，风格随 server 文件）**
- [ ] **Step 2: 验证**：worktree 重建 core dist + overlay 确认 → `npm run typecheck`（恰 5 预存）→ mirror vitest 相关文件绿 → `npm run check:drift`（graph-executor 超容差则 `--rebase` 前先确认只影响本对，定向过账）
- [ ] **Step 3: Commit**：`feat(graph): server 侧 rerank 双份同步 + drift 基线过账`

---

### Task 4: 前端 + i18n

**Files:**
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts`（kind 三落点 + `newRerankNode` 工厂：query ""、sourceNodeId ""、modelId 照 newLlmNode 先例默认、topN 5）
- Modify: `src-react/domains/ai/orchestration/lib/graph-canvas-model.ts`（grep vectorSearch 同构落点）
- Modify: `AddNodeMenu` / `NodePropertiesPanel` / `NodeCard`（hybridSearch 同款注册）
- Modify: `GraphNodeEditor.tsx`（rerank 表单分支：query 输入、sourceNodeId 下拉——列图中 kind=hybridSearch 节点（排除自身）、模型选择器 `filterType="reranker"`、topN）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`（kindRerank/nodeDesc/字段 label/rerankHint——「来源检索节点须经连线接至本节点上游」提示）
- Test: `tests/ai/graph-editor-model.test.ts` 或既有 model 测试补工厂默认断言

- [ ] **Step 1-4: i18n 双语 → 注册与工厂 → 表单 → 验证（typecheck 保持恰 5、JSON 双文件合法、相关 vitest 绿）→ Commit**
`feat(graph): rerank 编辑器接入——注册/来源下拉/reranker 模型过滤/i18n 双语`

---

### Task 5: 收尾（e2e 决策 + 全量回归）

- [ ] **Step 1: e2e 裁定执行**：rerank 需真 reranker 端点，e2e 不加段（协议形态已由 T2 单测 mock fetch 钉死；真端到端待有 reranker 模型配置时人工验证）——在本计划文件末尾追加一行注明该裁定与理由。
- [ ] **Step 2: 全量回归**：`npm run test`（mirror 全量）+ `cd apps/tianshu-server && npx jest`（75 suites 基线）+ `npm run typecheck`（恰 5）+ `npm run check:drift`（graph-vector-store 24 不动、graph-executor 过账后持平）。
- [ ] **Step 3: 终验三项**：① 三错误码双份一致；② hits 消费/旁路链（source.hits → fused hits → toNodeUpdate）双份齐全；③ rerank handler 输出 update 形态双份一致（归一化引号对照）。
- [ ] **Step 4: Commit（如仅计划注记）**：`docs(plan): rerank e2e 裁定注记——协议形态单测钉死，真端点待模型配置`

---

**e2e 裁定（2026-10-31）**：rerank 不加 e2e 段——真 reranker 端点不可得（需配置 reranker 类型模型），协议形态（请求体/index 回挂/截断/三错误码）已由 Task 2 mock fetch 单测钉死；真端到端验证待有 reranker 模型配置时人工进行（spec Phase 2.3 的「e2e 补段」按真模型门控语义理解）。

**终审收尾（2026-10-31）**：全分支终审两 Important 修复已随收尾 commit 落地——① HTTP 200 返回体 `results` 非数组不再 `?? []` 静默空成功，改报 `rerank_api_error`（embedTexts `Array.isArray` 先例）；② 候选超 250 截断不再静默，trace 落 `hitsTruncated: "原数→250"` 标注（另含 top_n clamp 至候选数、i18n 措辞对齐、双份注释更新与 spec minScore 关账/DashScope 措辞）。
