# 混合检索 Phase 1（hybridSearch 节点）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `hybridSearch` 工作流节点——内存 BM25 全文检索 + 向量检索 + RRF 融合，单节点三模式（semantic/keyword/hybrid），并预埋 hits 旁路供 Phase 2 rerank 消费。

**Architecture:** 检索纯逻辑（分词/BM25 评分/RRF 融合）下沉 `tianshu-core/src/retrieval.ts`（单份三端，零依赖）；全文检索为纯 JS 内存 BM25（2026-10-30 pivot：FTS5 因 server Prisma 内置 engine 不支持且双端驱动异构而否决），与现有 `searchChunks`「全表读出+内存余弦」同构——无虚表/无迁移/无索引生命周期；executor 新增 handler 按 mode 分路。`vector-store.ts` 与 `graph-executor.ts` 是 mirror ↔ server 双份守护文件，必须同步双改。

**Tech Stack:** Intl.Segmenter（Node/Chromium 内建 ICU）、纯 JS Okapi BM25（k1=1.5/b=0.75）、zod、vitest。

**Spec:** `docs/superpowers/specs/2026-10-30-hybrid-search-node-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- **双份铁律**：`electron/domains/ai/orchestration/{vector-store,graph-executor}.ts` 与 `apps/tianshu-server/src/core/graph/` 下对应副本必须同步改（drift 活跃对，基线差 217 行）；两边文件已有意分叉（server 版 import 路径、个别结构不同），同步的是「逻辑段」，逐段对照插入而非整文件覆盖。
- **core 准入**：`packages/tianshu-core` 包内模块零运行时依赖（Intl.Segmenter 是内建 API，准入合规）；改 core 后必须重建 dist：`npm --prefix packages/tianshu-protocol run build && npm --prefix packages/tianshu-core run build`（server 消费 dist，mirror 经 alias 直读 src 不受影响）。
- **命名规范**：camelCase 变量/函数、kebab-case 文件名、错误码 snake_case（对齐现有 `vector_empty_text`/`embed_api_error` 风格）。
- **i18n 铁律**：所有用户可见文案走 `t()`，zh-CN 与 en-US 两个 JSON 同步加 key；禁止硬编码中文。
- **测试环境约束（2026-10-30 pivot 后）**：全文检索为纯 JS 内存 BM25（零 SQLite 特性依赖）——无真表交互测试需求，全部测试走 mirror vitest（core 纯函数直测 + handler 级 mock prisma/fetch，先例 `tests/ai/graph-vector.test.ts`）。server 侧只做双份源码同步，不新增 jest spec；既有 suite 回归在 Task 8（若 worktree 内 jest 因 TS paths symlink 坑起不来：`git diff main > /tmp/hs.patch` → 主树 `git apply /tmp/hs.patch` 跑完 → `git checkout -- .` 恢复，worktree 是唯一真源，勿在主树提交）。
- **提交纪律**：每 Task 结束即 commit（sub-agent 分段自提交保命）；commit message 中文 conventional 格式（如 `feat(graph): …`）。
- **业界主流取向**（用户授权遇疑时的裁决基准）：RRF k=60 不做成参数；BM25 k1=1.5/b=0.75 固定业界默认；显式失败不做静默降级。

---

### Task 1: core retrieval.ts 纯函数完整实现 + 单测（tokenize/rankBm25/rrfFuse）

> **2026-10-30 pivot**：原 Task 1（FTS5 spike）实证 server 无 better-sqlite3（Prisma `prisma-client-js` 内置 engine 不编译 FTS5，alpine/musl 补装撞依赖铁律），全文检索改为**纯 JS 内存 BM25**（spec 综述段已更新）；原 Task 2 已并入本任务。
> **worktree 遗留**（前序 spike 尝试，未提交）：`packages/tianshu-core/src/retrieval.ts`（tokenize 最小版——保留并扩展）、`src/index.ts`（barrel 行已加——保留）、`tsconfig.json`（lib ES2022.Intl——保留，Intl.Segmenter 类型所需）、`apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts`（旧 spike spec——**删除**）。

**Files:**
- Modify: `packages/tianshu-core/src/retrieval.ts`（补 rankBm25/rrfFuse；若存在 joinFts* 则删除）
- Modify: `packages/tianshu-core/src/index.ts`（确认 barrel 已有 `export * from "./retrieval";`）
- Modify: `packages/tianshu-core/tsconfig.json`（lib 含 ES2022.Intl）
- Delete: `apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts`
- Test: `tests/core/retrieval.test.ts`（mirror vitest，先例 `tests/core/workspace-files-scan.test.ts`）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `interface Bm25Doc { chunkId: number; sourceName: string; collection: string; text: string }`
  - `interface Bm25Hit extends Bm25Doc { score: number }`
  - `interface FusedHit { chunkId: number; sourceName: string; collection: string; text: string; score: number; rank: number }`
  - `tokenize(text: string): string[]`
  - `rankBm25(queryTokens: string[], docs: Bm25Doc[], topK: number, k1?: number, b?: number): Bm25Hit[]`
  - `rrfFuse(vecHits: FusedHit[], ftsHits: FusedHit[], k?: number): FusedHit[]`
  - 常量 `BM25_K1 = 1.5`、`BM25_B = 0.75`（Okapi 业界默认，rank-bm25/LangChain 同参）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/retrieval.test.ts
/**
 * 检索纯函数：tokenize（中英混合/专有名词/空串/纯符号）、rankBm25
 * （排序语义/IDF 平滑/零命中剔除/空输入短路）、rrfFuse（同 chunk 累加/
 * rank 重排/空输入）。
 */
import { describe, expect, it } from "vitest";
import {
  tokenize, rankBm25, rrfFuse, BM25_K1, BM25_B,
  type Bm25Doc, type FusedHit,
} from "@tianshu/core";

const doc = (chunkId: number, text: string): Bm25Doc => ({
  chunkId, sourceName: `s${chunkId}`, collection: "c", text,
});
const hit = (chunkId: number, text: string): FusedHit => ({
  chunkId, sourceName: `s${chunkId}`, collection: "c", text, score: 0.9, rank: 0,
});

describe("tokenize", () => {
  it("中文按词典切词且词元可拼接", () => {
    const tokens = tokenize("天枢支持混合检索");
    expect(tokens.length).toBeGreaterThan(2);
    expect(tokens.join("")).toBe("天枢支持混合检索");
  });
  it("中英混合与数字保留", () => {
    const tokens = tokenize("SQLite 支持 BM25 排序 v2");
    expect(tokens).toContain("SQLite");
    expect(tokens).toContain("BM25");
    expect(tokens).toContain("v2");
  });
  it("空串与纯符号产出空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("！？…—")).toEqual([]);
  });
});

describe("rankBm25", () => {
  const docs = [
    doc(1, "分布式系统的容错设计与故障恢复"),       // 双词都含
    doc(2, "容错相关的其它讨论"),                   // 单词命中
    doc(3, "前端组件的状态管理最佳实践"),           // 零命中
  ];
  it("双词命中 > 单词命中；零命中剔除；限 topK", () => {
    const hits = rankBm25(tokenize("容错 设计"), docs, 2);
    expect(hits[0].chunkId).toBe(1);
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2]); // topK=2 且零命中的 3 剔除
  });
  it("IDF 平滑：高频词单独命中分数为正（+1 平滑防负）", () => {
    const hits = rankBm25(tokenize("容错"), docs, 3);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });
  it("空词元或空文档短路返回空数组", () => {
    expect(rankBm25([], docs, 5)).toEqual([]);
    expect(rankBm25(["容错"], [], 5)).toEqual([]);
  });
  it("默认参数为业界值", () => {
    expect(BM25_K1).toBe(1.5);
    expect(BM25_B).toBe(0.75);
  });
});

describe("rrfFuse", () => {
  it("两路同 chunkId 分数累加且排前", () => {
    const fused = rrfFuse([hit(1, "a"), hit(2, "b")], [hit(3, "c"), hit(1, "a")], 60);
    expect(fused[0].chunkId).toBe(1);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 61, 10);
    expect(fused.map((f) => f.chunkId)).toEqual([1, 2, 3]);
  });
  it("融合后 rank 从 1 重编", () => {
    expect(rrfFuse([hit(5, "x")], [], 60)[0].rank).toBe(1);
  });
  it("空输入返回空数组", () => {
    expect(rrfFuse([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/core/retrieval.test.ts`
Expected: FAIL（`rankBm25`/`rrfFuse` 未导出）。

- [ ] **Step 3: 写正式实现**

`packages/tianshu-core/src/retrieval.ts` 完整版（tokenize 已有则保留）：

```typescript
// packages/tianshu-core/src/retrieval.ts
/**
 * 检索纯逻辑（GA 系单份三端）：中文分词（Intl.Segmenter——Node 16+/
 * Chromium 内建 ICU 词典，零依赖）、内存 BM25（FTS5 否决后 pivot，
 * LangChain BM25Retriever 形态）、RRF 融合。分词器单点抽象：质量升级
 * （jieba 等）只动 tokenize 一处。
 */
export interface Bm25Doc {
  chunkId: number;
  sourceName: string;
  collection: string;
  text: string;
}

export interface Bm25Hit extends Bm25Doc {
  score: number;
}

export interface FusedHit {
  chunkId: number;
  sourceName: string;
  collection: string;
  text: string;
  score: number;
  rank: number;
}

/** Okapi BM25 业界默认参数（rank-bm25/LangChain BM25Retriever 同参） */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const TOKEN_RE = /[\p{Script=Han}\p{L}\p{N}]/u;

/** 分词：仅保留含文字/数字的词元（标点/符号剥离）；导出供测试 */
export function tokenize(text: string): string[] {
  return [...segmenter.segment(text)]
    .map((seg) => seg.segment.trim())
    .filter((token) => token.length > 0 && TOKEN_RE.test(token));
}

/** 内存 BM25 评分：Lucene 式 +1 平滑 IDF（防负），每查询全量分词评分
 * （与 searchChunks 全表余弦同构，万级毫秒级）；零命中剔除、降序切 topK */
export function rankBm25(
  queryTokens: string[],
  docs: Bm25Doc[],
  topK: number,
  k1 = BM25_K1,
  b = BM25_B,
): Bm25Hit[] {
  if (queryTokens.length === 0 || docs.length === 0) {
    return [];
  }
  const docTokens = docs.map((d) => tokenize(d.text));
  const avgLen =
    docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docTokens.length;
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string) => {
    const n = df.get(term) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  const hits: Bm25Hit[] = [];
  docs.forEach((doc, i) => {
    const tokens = docTokens[i];
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const term of new Set(queryTokens)) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) {
        continue;
      }
      score +=
        (idf(term) * (freq * (k1 + 1))) /
        (freq + k1 * (1 - b + (b * tokens.length) / avgLen));
    }
    if (score > 0) {
      hits.push({ ...doc, score });
    }
  });
  hits.sort((a, x) => x.score - a.score);
  return hits.slice(0, topK);
}

/** RRF 融合（k=60 论文值/ES rank_constant 默认）：按 chunkId 累加
 * 1/(k+rank)，只看排名不看原始分（量纲免疫）；融合后 rank 从 1 重编 */
export function rrfFuse(
  vecHits: FusedHit[],
  ftsHits: FusedHit[],
  k = 60,
): FusedHit[] {
  const merged = new Map<number, FusedHit>();
  const absorb = (hits: FusedHit[]) => {
    hits.forEach((h, i) => {
      const contribution = 1 / (k + i + 1);
      const prev = merged.get(h.chunkId);
      if (prev) {
        prev.score += contribution;
      } else {
        merged.set(h.chunkId, { ...h, score: contribution });
      }
    });
  };
  absorb(vecHits);
  absorb(ftsHits);
  return [...merged.values()]
    .sort((a, b2) => b2.score - a.score)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}
```

- [ ] **Step 4: 跑测试验证通过 + 既有回归**

Run: `npx vitest run tests/core tests/ai/graph-vector.test.ts`
Expected: PASS。

- [ ] **Step 5: 重建 dist + 清理旧 spike + Commit**

```bash
npm --prefix packages/tianshu-protocol run build && npm --prefix packages/tianshu-core run build
rm apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts
git add packages/tianshu-core/src/retrieval.ts packages/tianshu-core/src/index.ts packages/tianshu-core/tsconfig.json packages/tianshu-core/dist tests/core/retrieval.test.ts
git add -A apps/tianshu-server/test
git commit -m "feat(core): 检索纯逻辑入包——tokenize/rankBm25/rrfFuse（FTS5 否决 pivot 内存 BM25）"
```

### Task 2: （已并入 Task 1，跳过）

> 原「core retrieval.ts 纯函数完整实现 + 单测」已随 FTS5 pivot 并入 Task 1（含 rankBm25/rrfFuse 全部代码与用例）。执行器遇到本任务直接标记完成，勿重复实现。

### Task 3: core graph-schema 加 hybridSearch 节点 schema

**Files:**
- Modify: `packages/tianshu-core/src/graph-schema.ts`（在 `vectorSearchNodeSchema` 段后、节点 union 处、类型导出区三处落点）

**Interfaces:**
- Produces: `hybridSearchNodeSchema`、`export type HybridSearchNode = z.infer<typeof hybridSearchNodeSchema>`（Task 5 executor 与 Task 7 前端 import）。

- [ ] **Step 1: 加 schema 定义**

在 `vectorSearchNodeSchema`（约 593 行）定义之后加：

```typescript
/** 混合检索节点（kind:hybridSearch）：BM25 全文 + 向量语义 + RRF 融合，
 * 单节点三模式（semantic/keyword/hybrid，对齐 Dify 知识检索心智）。FTS
 * 数据面见 vector-store（vectorChunkFts 虚表镜像 vectorChunk）；
 * state 另挂 hits 旁路（FusedHit 数组）供 rerank 消费。modelId 在
 * semantic/hybrid 模式必填（executor 校验），keyword 模式零模型门槛。 */
export const hybridSearchNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("hybridSearch"),
  searchQuery: z.string().min(1),
  collection: z.string().optional(),
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  topK: z.number().int().min(1).max(50).default(5),
  modelId: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
});
```

- [ ] **Step 2: 接入 union 与类型导出**

在节点 z.union 数组（约 622 行，`vectorSearchNodeSchema,` 之后）插入 `hybridSearchNodeSchema,`；在类型导出区（约 669 行 `export type VectorSearchNode = ...` 之后）加：

```typescript
export type HybridSearchNode = z.infer<typeof hybridSearchNodeSchema>;
```

检查 schema 文件内是否还有 kind 联合（如 `GraphNodeKind`/编辑器用的 kind 列表，grep `vectorSearch` 在本文件的其余落点），同处补 `hybridSearch`。

- [ ] **Step 3: 验证编译与既有测试**

Run: `npm --prefix packages/tianshu-core run build && npx vitest run tests/core tests/ai/graph-vector.test.ts`
Expected: build 成功、既有测试全 PASS（schema 加节点不破坏既有 union parse）。

- [ ] **Step 4: Commit**

```bash
git add packages/tianshu-core/src/graph-schema.ts packages/tianshu-core/dist
git commit -m "feat(core): hybridSearch 节点 schema 入包（三模式/topK/modelId 可选）"
```

---

### Task 4: mirror vector-store.ts 内存 BM25 检索

**Files:**
- Modify: `electron/domains/ai/orchestration/vector-store.ts`
- Test: `tests/ai/graph-hybrid.test.ts`（新建，本 Task 写 searchFts 侧；Task 5 扩 handler 用例）

**Interfaces:**
- Consumes: Task 1 的 `tokenize/rankBm25`、`Bm25Doc/Bm25Hit`（mirror 经 alias 直读 core src）。
- Produces（Task 5 依赖）:
  - `searchFts(params: { userId: number; collection: string; queryTokens: string[]; limit: number }): Promise<FusedHit[]>`（空词元直接 `[]` 不查库；返回按相关度降序、rank 从 1 编）
  - `searchChunks` 返回值增加 `chunkId` 字段（`findMany` 整行已有 `id`，hits.map 带上 `row.id`；既有字段不变，现有消费方不破坏）
  - `upsertChunks` **完全不动**（BM25 每查询实时读行，无索引同步——pivot 后无 DDL/无迁移/无生命周期）

- [ ] **Step 1: 写失败测试（searchFts mock 断言）**

`tests/ai/graph-hybrid.test.ts` 顶部照 `tests/ai/graph-vector.test.ts` 的 `vi.mock("electron")` + `vi.mock("../../electron/commons/prisma-client")` 替身模式（mock 面以本任务所需为限：`vectorChunk.findMany` 即可，无需 raw 方法）。用例：

```typescript
import { searchFts } from "../../electron/domains/ai/orchestration/vector-store";

describe("vector-store searchFts（内存 BM25）", () => {
  it("空词元短路返回空（不查库）", async () => {
    const hits = await searchFts({ userId: 1, collection: "", queryTokens: [], limit: 5 });
    expect(hits).toEqual([]);
    expect(prisma.vectorChunk.findMany).not.toHaveBeenCalled();
  });
  it("findMany 限定 select 且命中行经 rankBm25 排序返回 FusedHit 形态", async () => {
    prisma.vectorChunk.findMany.mockResolvedValue([
      { id: 1, collection: "c", sourceName: "s1", text: "分布式系统的容错设计与故障恢复" },
      { id: 2, collection: "c", sourceName: "s2", text: "容错相关的其它讨论" },
      { id: 3, collection: "c", sourceName: "s3", text: "前端组件的状态管理最佳实践" },
    ]);
    const hits = await searchFts({ userId: 1, collection: "c", queryTokens: ["容错", "设计"], limit: 2 });
    expect(prisma.vectorChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 1, collection: "c" },
      select: { id: true, collection: true, sourceName: true, text: true },
    }));
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2]); // 双词命中 > 单词命中，零命中剔除
    expect(hits[0]).toMatchObject({ sourceName: "s1", rank: 1 });
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/ai/graph-hybrid.test.ts`
Expected: FAIL（`searchFts` 未导出）。

- [ ] **Step 3: 写实现**

`electron/domains/ai/orchestration/vector-store.ts` 追加（import 区补 `rankBm25` 与 `FusedHit` 类型自 `@tianshu/core`）：

```typescript
/** BM25 全文检索（内存，与 searchChunks 全表余弦同构——FTS5 否决后
 * pivot，LangChain BM25Retriever 形态）：空词元短路；不过滤 model（全文
 * 与 embedding 模型无关）；万级毫秒级，与全表余弦成本同量级 */
export async function searchFts(params: {
  userId: number;
  collection: string;
  queryTokens: string[];
  limit: number;
}): Promise<FusedHit[]> {
  if (params.queryTokens.length === 0) {
    return [];
  }
  const rows = await prisma.vectorChunk.findMany({
    where: {
      userId: params.userId,
      ...(params.collection ? { collection: params.collection } : {}),
    },
    select: { id: true, collection: true, sourceName: true, text: true },
  });
  const hits = rankBm25(
    params.queryTokens,
    rows.map((row) => ({
      chunkId: row.id,
      sourceName: row.sourceName,
      collection: row.collection,
      text: row.text,
    })),
    params.limit,
  );
  return hits.map((hit, index) => ({ ...hit, rank: index + 1 }));
}
```

同文件 `searchChunks` 的 `hits.map` 里补 `chunkId: row.id`（返回类型 `VectorHit` 加 `chunkId: number` 字段——现有消费方只用 sourceName/score/text，不破坏）。

- [ ] **Step 4: 跑测试验证通过 + 既有回归**

Run: `npx vitest run tests/ai/graph-hybrid.test.ts tests/ai/graph-vector.test.ts`
Expected: PASS（既有 vector 测试不因 VectorHit 加字段而破）。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/orchestration/vector-store.ts tests/ai/graph-hybrid.test.ts
git commit -m "feat(graph): vector-store 内存 BM25 全文检索——searchFts/searchChunks 加 chunkId"
```

### Task 5: mirror graph-executor.ts——hits 旁路类型 + hybridSearch handler

**Files:**
- Modify: `packages/tianshu-core/src/graph-compiler.ts`（`NodeResult` 加 hits）
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（`NodeOutput` 加 hits、`toNodeUpdate` 透传、handler、分发注册）
- Test: `tests/ai/graph-hybrid.test.ts`（扩 handler 用例）

**Interfaces:**
- Consumes: Task 2 `FusedHit/rrfFuse/tokenize`、Task 3 `HybridSearchNode`、Task 4 `searchFts/searchChunks`、既有 `embedTexts`（graph-executor.ts:3467）。
- Produces: 节点执行后 `state.nodes[nodeId].hits?: FusedHit[]`（Phase 2 rerank 消费）；`output` 文本形态 `【条目名｜相关度 0.87】片段`。

- [ ] **Step 1: 类型扩展**

`packages/tianshu-core/src/graph-compiler.ts` 的 `NodeResult`（25 行区）加字段并 import 类型：

```typescript
import type { FusedHit } from "./retrieval";
export interface NodeResult {
  output: string;
  errorOutput?: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** 检索类节点结构化候选（GA 系 rerank 消费）；模板取值不受影响 */
  hits?: FusedHit[];
}
```

`electron/domains/ai/orchestration/graph-executor.ts` 的 `NodeOutput`（203 行区）加 `hits?: FusedHit[];`（import 自 `@tianshu/core`）；`toNodeUpdate`（724 行）的 nodes 展开里加 `...(done.hits !== undefined ? { hits: done.hits } : {})`。

重建 dist（Global Constraints 命令）。

- [ ] **Step 2: 写失败测试（handler 三模式）**

`tests/ai/graph-hybrid.test.ts` 追加（mock 面已具备：`embedTexts` 走 fetch 打桩先例、`searchFts`/`searchChunks` 经 prisma mock 生效）。构造 `HybridSearchNode` 跑 handler 级断言（参照 graph-vector.test.ts 现有的 handler 端到端跑法——组装 node + ctx + state 调 `makeVectorSearchNodeHandler` 同款入口；若该函数未导出，走图中执行入口或临时导出，与先例测试保持同构）：

```typescript
const baseNode = {
  id: "hs1", kind: "hybridSearch", name: "混合检索",
  searchQuery: "容错 设计", collection: "c", mode: "hybrid" as const,
  topK: 3, modelId: 1,
};

it("keyword 模式：不调 embedding、输出相关度文案、挂 hits", async () => {
  prisma.vectorChunk.findMany.mockResolvedValue([
    { id: 1, collection: "c", sourceName: "s1", text: "原文片段" },
  ]);
  const update = await runHybrid({ ...baseNode, mode: "keyword", modelId: undefined });
  expect(fetch).not.toHaveBeenCalled();
  expect(update.nodes.hs1.output).toContain("【s1｜相关度");
  expect(update.nodes.hs1.hits?.[0]).toMatchObject({ chunkId: 1, text: "原文片段" });
});

it("semantic 模式缺 modelId 报 hybrid_model_missing", async () => {
  await expect(runHybrid({ ...baseNode, mode: "semantic", modelId: undefined }))
    .rejects.toMatchObject({ code: "hybrid_model_missing" });
});

it("hybrid 模式：两路并行 RRF 融合（同 chunk 累加居首）", async () => {
  // embedding fetch 打桩为确定性向量（先例）；prisma.vectorChunk.findMany
  // mock 行同时携带 vector（余弦路 JSON.parse）与 text（BM25 路评分）——
  // 向量路命中 chunk 1，BM25 路命中 chunk 1 与 chunk 2，融合后 chunkId 1 第一
  const update = await runHybrid(baseNode);
  expect(update.nodes.hs1.hits?.[0].chunkId).toBe(1);
  expect(update.nodes.hs1.output).toContain("【s1｜相关度");
});

it("空查询词元：keyword 短路输出空串不炸图", async () => {
  const update = await runHybrid({ ...baseNode, mode: "keyword", searchQuery: "！！" });
  expect(update.nodes.hs1.output).toBe("");
  expect(update.nodes.hs1.hits).toEqual([]);
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `npx vitest run tests/ai/graph-hybrid.test.ts`
Expected: FAIL（handler 未实现/未注册）。

- [ ] **Step 4: 写 handler 与注册**

分发点（585 行 `if (node.kind === "vectorSearch")` 旁）加：

```typescript
if (node.kind === "hybridSearch") {
  return makeHybridSearchNodeHandler(node, ctx);
}
```

import 区补 `HybridSearchNode` 与 `rrfFuse, tokenize, type FusedHit`（`@tianshu/core`）。handler 放 `makeVectorSearchNodeHandler`（3597 行）之后（写完 Task 4 的 `searchFts` import 自 `./vector-store` 懒加载，对齐先例 `await import("./vector-store")`）：

```typescript
/** 混合检索节点 handler：三模式分路——keyword（FTS BM25）/semantic
 * （余弦）/hybrid（两路并行 RRF 融合，候选池 max(50, topK×5)）；空词元
 * FTS 路短路；hits 旁路落 state（rerank 消费）。任一路失败即节点失败
 * （不静默降级）。 */
function makeHybridSearchNodeHandler(
  node: HybridSearchNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      const query = render(node.searchQuery);
      const collection = render(node.collection ?? "");
      const needsEmbedding = node.mode !== "keyword";
      if (needsEmbedding && node.modelId === undefined) {
        throw new GraphNodeFailure(
          node.id, "hybrid_model_missing",
          "semantic/hybrid 模式须选择 embedding 模型（keyword 模式无需）",
        );
      }
      const signal = AbortSignal.any([
        ctx.abort,
        AbortSignal.timeout(node.timeoutMs ?? 120_000),
      ]);
      const { searchFts, searchChunks } = await import("./vector-store");
      const poolSize = Math.max(50, (node.topK ?? 5) * 5);
      const queryTokens = tokenize(query);

      let ftsHits: FusedHit[] = [];
      let vecHits: FusedHit[] = [];
      if (node.mode === "keyword") {
        ftsHits = await searchFts({
          userId: ctx.userId, collection, queryTokens, limit: node.topK ?? 5,
        });
      } else {
        const embedPromise = embedTexts(node.modelId!, [query], signal);
        const ftsPromise = node.mode === "hybrid"
          ? searchFts({ userId: ctx.userId, collection, queryTokens, limit: poolSize })
          : Promise.resolve([] as FusedHit[]);
        const [queryVector] = await embedPromise; // 任一 reject 即节点失败
        ftsHits = await ftsPromise;
        vecHits = (await searchChunks({
          userId: ctx.userId, collection, model: String(node.modelId!),
          queryVector, topK: node.mode === "hybrid" ? poolSize : (node.topK ?? 5),
        })).map((hit) => ({ ...hit, chunkId: hit.chunkId, rank: 0 }));
      }

      const fused = node.mode === "hybrid"
        ? rrfFuse(vecHits, ftsHits).slice(0, node.topK ?? 5)
        : (node.mode === "keyword" ? ftsHits : vecHits)
            .slice(0, node.topK ?? 5)
            .map((hit, i) => ({ ...hit, rank: i + 1 }));
      const label = node.mode === "semantic" ? "相似度" : "相关度";
      const output = fused
        .map((hit) => `【${hit.sourceName}｜${label} ${hit.score.toFixed(2)}】${hit.text}`)
        .join("\n\n");
      await writeNodeRecord(ctx, node, query, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, {
        output,
        hitsPreview: JSON.stringify(fused).slice(0, 2000),
      }));
      return toNodeUpdate(node.id, { output, hits: fused });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.searchQuery, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}
```

> 注意：`searchChunks`（Task 4 同文件）返回值加 `chunkId` 字段——在 `searchChunks` 的 `hits.map` 里带上 `row.id as chunkId`（`findMany` 返回整行含 id），保持既有字段不变。
> `GraphNodeFailure`/`toNodeFailure`/`traceSuccess` 形态对照 `makeVectorizeNodeHandler`（3530 行）既有用法；`traceSuccess` 若 payload 形态是自由对象则直接带 `hitsPreview`，否则按其签名适配。

- [ ] **Step 5: 跑测试验证通过 + 既有回归**

Run: `npx vitest run tests/ai/graph-hybrid.test.ts tests/ai/graph-vector.test.ts tests/core`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/tianshu-core/src/graph-compiler.ts packages/tianshu-core/dist electron/domains/ai/orchestration/graph-executor.ts tests/ai/graph-hybrid.test.ts
git commit -m "feat(graph): hybridSearch 节点 handler——三模式分路/RRF 融合/hits 旁路"
```

---

### Task 6: server 侧双份同步

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/vector-store.ts`（Task 4 同逻辑段：searchFts + searchChunks 加 chunkId）
- Modify: `apps/tianshu-server/src/core/graph/graph-executor.ts`（Task 5 同逻辑段：分发注册、`makeHybridSearchNodeHandler`、`NodeOutput` 加 hits、`toNodeUpdate` 透传）

**Interfaces:**
- Consumes: Task 1–5 全部产物（core dist 已含 retrieval/schema——注意 worktree 内 server 的 `@tianshu/core` 经软链解析到**主树** dist，移植后用 typecheck 验证解析到的新类型；若类型缺失，确认 Task 1/3/5 的 dist 重建已在 worktree 执行过）。
- Produces: server 无头端同能力（GraphPanel 遥控跑图时 hybridSearch 三模式可用——BM25 纯函数双端同形，无 SQLite 特性依赖）。

- [ ] **Step 1: 双份同步 vector-store**

读 mirror 侧 Task 4 成品，将 `searchFts` 与 `searchChunks` 的 chunkId 改动移植到 server 副本（server 版 import 风格保持该文件现状——单引号/路径差异按文件内既有惯例；`rankBm25`/`FusedHit` 自 `@tianshu/core` 走 dist）。

- [ ] **Step 2: 双份同步 graph-executor**

移植分发注册（`if (node.kind === "vectorSearch")` 旁）、`makeHybridSearchNodeHandler`（`makeVectorSearchNodeHandler` 后）、`NodeOutput` 加 hits、`toNodeUpdate` 透传。server 版对应工具函数（`GraphNodeFailure`/`traceSuccess`/`writeNodeRecord`/`embedTexts`/`loadModelRuntime`）以 server 文件内既有形态为准（grep 同名定位，签名一致则照用）。

- [ ] **Step 3: 验证**

Run: `npm run typecheck`（worktree 根；若 server 侧有独立 typecheck 脚本则一并跑）
Expected: 零错误。
Run: `npx vitest run tests/core tests/ai/graph-hybrid.test.ts tests/ai/graph-vector.test.ts`
Expected: PASS（mirror 侧不回归）。
server 既有 jest suite 回归放 Task 8 统一执行（环境坑与 fallback 见 Global Constraints）。

- [ ] **Step 4: drift 核算**

Run: `npm run check:drift`
Expected: exit 0（双份同步后差异行不增长；若超容差，评估后 `npm run check:drift -- --rebase` 重置基线并在 commit message 注明）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/core/graph/ packages/tianshu-core/scripts/drift-manifest.json
git commit -m "feat(graph): server 侧混合检索双份同步（内存 BM25，无 FTS5 依赖）"
```

### Task 7: 前端节点编辑 + i18n

**Files:**
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts`（kind 联合 149 行、kind 清单 647 行、节点工厂 784 行 `newVectorSearchNode` 旁）
- Modify: `src-react/domains/ai/orchestration/lib/graph-canvas-model.ts`（grep `vectorSearch` 全部落点）
- Modify: `src-react/domains/ai/orchestration/components/AddNodeMenu.tsx`（128 行区）
- Modify: `src-react/domains/ai/orchestration/components/NodePropertiesPanel.tsx`（kind 数组 239 行区 + SelectItem 310 行区）
- Modify: `src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx`（grep `vectorSearch` 图标映射处）
- Modify: `src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx`（vectorSearch 表单段旁加 hybridSearch 表单；模型下拉用既有 `filterType` 机制传 `"embedding"`）
- Modify: `src-react/i18n/locales/zh-CN/chat.json` 与 `en-US/chat.json`
- Test: `tests/ai/graph-canvas-model.test.ts`（若覆盖 kind 清单则补断言）

**Interfaces:**
- Consumes: Task 3 `HybridSearchNode` schema。
- Produces: 编辑器可选/可配/可连线 hybridSearch 节点。

- [ ] **Step 1: i18n 双语 key**

grep `kindVectorSearch` 在 zh-CN/chat.json 的全部落点（`orchestration.editor.kindVectorSearch`、`kindDesc.vectorSearch`、vectorSearch 表单字段 label/hint 段），在每个同层位置补 hybridSearch 对应 key（双语同步）：

zh-CN 示例（en-US 同步翻译）：
```json
"kindHybridSearch": "混合检索",
"kindDesc.hybridSearch": "BM25 全文+向量语义+RRF 融合三模式检索",
"hybridSearchHint": "semantic/hybrid 模式须选 embedding 模型；keyword 免模型；输出「【条目名｜相关度】片段」接 AI 节点",
"hybridSearchMode": "检索模式", "hybridModeSemantic": "语义", "hybridModeKeyword": "全文", "hybridModeHybrid": "混合"
```

（key 命名以 vectorSearch 现有字段 key 的同构模式为准——先 grep 再定名，禁止顶层 key 与嵌套对象重名。）

- [ ] **Step 2: 注册与工厂**

`graph-editor-model.ts`：149 行 kind 联合加 `"hybridSearch"`；647 行清单加；784 行区照 `newVectorSearchNode` 写：

```typescript
export function newHybridSearchNode(): HybridSearchNode {
  return {
    id: newNodeId(),
    kind: "hybridSearch",
    name: "混合检索",
    searchQuery: "",
    collection: "",
    mode: "hybrid",
    topK: 5,
  };
}
```

（`newNodeId`/nodeBase 必填字段以 `newVectorSearchNode` 实际实现为准照抄。）`graph-canvas-model.ts` 与 `NodeCard.tsx` 的 vectorSearch 落点同构补（图标用现有检索类同款或 `SearchCheck` 等 Lucide 图标，对齐文件内 import 惯例）。

- [ ] **Step 3: 属性面板与编辑表单**

`NodePropertiesPanel.tsx`：239 行 kind 数组加 `"hybridSearch"`（位置紧随 `"vectorSearch"`）；310 行区加 `<SelectItem value="hybridSearch">{t("chat:orchestration.editor.kindHybridSearch")}</SelectItem>`。
`GraphNodeEditor.tsx`：找 vectorSearch 表单段（`node.kind === "vectorSearch"` 分支），旁加 hybridSearch 分支——searchQuery/collection/topK 字段复用同款输入组件；mode 三态单选（Tabs 或 Select，对齐文件内既有单选形态）：

```tsx
{node.kind === "hybridSearch" && (
  <>
    {/* searchQuery/collection/topK 同 vectorSearch 字段模式 */}
    {/* mode 单选 */}
    <Tabs value={node.mode} onValueChange={(v) => update({ mode: v as HybridSearchNode["mode"] })}>
      <TabsTrigger value="semantic">{t("chat:orchestration.editor.hybridModeSemantic")}</TabsTrigger>
      <TabsTrigger value="keyword">{t("chat:orchestration.editor.hybridModeKeyword")}</TabsTrigger>
      <TabsTrigger value="hybrid">{t("chat:orchestration.editor.hybridModeHybrid")}</TabsTrigger>
    </Tabs>
    {node.mode !== "keyword" && (
      <ModelSelect filterType="embedding" modelId={node.modelId ?? 0}
        onSelect={(id) => update({ modelId: id })} />  {/* 组件名/props 以文件内 300 行区既有实现为准 */}
    )}
    <p className="text-xs text-muted-foreground">{t("chat:orchestration.editor.hybridSearchHint")}</p>
  </>
)}
```

（`ModelSelect`/`filterType` 组件真实名与 props 以 `GraphNodeEditor.tsx` 300–340 行既有实现为准——那是现成的 embedding 过滤下拉，直接复用；keyword 模式不渲染模型下拉即「禁用」语义。）

- [ ] **Step 4: 验证**

Run: `npx vitest run tests/ai/graph-canvas-model.test.ts tests/ai/graph-editor-model.test.ts 2>/dev/null; npm run typecheck`
Expected: 测试 PASS（或该文件不存在则跳过）、typecheck 零错误。i18n JSON 用 `node -e "JSON.parse(require('fs').readFileSync('src-react/i18n/locales/zh-CN/chat.json'))"` 双文件验合法性。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration src-react/i18n/locales tests/ai
git commit -m "feat(graph): hybridSearch 编辑器接入——注册/属性面板/三模式表单/模型过滤/i18n 双语"
```

---

### Task 8: 端到端冒烟 + 全量回归收尾

**Files:**
- Modify: `tests/ai/server/e2e-graph-smoke.ts`（按文件内既有节点冒烟段模式补 hybridSearch）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: e2e 级验证——真实 server 子进程跑图，keyword 模式中文查询命中。

- [ ] **Step 1: 补 e2e 冒烟段**

读 `tests/ai/server/e2e-graph-smoke.ts` 既有结构（它跑真 server 子进程 + 断言节点输出）。补一段：预置数据（绕过 vectorize 直接向测试库 `vectorChunk` 插中文行——照文件内既有预置数据手段）→ 跑含 hybridSearch 节点（keyword 模式、中文 query）的图 → 断言输出含目标条目名与「相关度」字样。节点 JSON：

```json
{
  "id": "hs1",
  "kind": "hybridSearch",
  "name": "混合检索",
  "searchQuery": "容错 设计",
  "collection": "e2e-hybrid",
  "mode": "keyword",
  "topK": 3
}
```

- [ ] **Step 2: 跑 e2e**

Run: `npm run test:e2e:graph`
Expected: PASS（含新段）。

- [ ] **Step 3: 全量回归**

Run: `npm run test && npm run typecheck && cd apps/tianshu-server && npx jest`
Expected: mirror vitest 全绿、typecheck 零错误、server jest 全绿（含既有 11 suite 基线）。

- [ ] **Step 4: 终验清单（跨段终验三项对照）**

按跨段协议双端终验纪律自查：① 错误码存在性——`hybrid_model_missing`/`fts_unavailable` 双份 executor 一致；② 载荷字段接线——`hits` 在 NodeOutput→toNodeUpdate→NodeResult 链路双份齐全；③ 状态联合同形——server/mirror 的 handler 输出 update 形态一致。

- [ ] **Step 5: 最终 Commit**

```bash
git add tests/ai/server/e2e-graph-smoke.ts
git commit -m "test(graph): e2e 冒烟补 hybridSearch keyword 段——中文 BM25 端到端命中"
```
