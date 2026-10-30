# 混合检索 Phase 1（hybridSearch 节点）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `hybridSearch` 工作流节点——SQLite FTS5 BM25 全文检索 + 向量检索 + RRF 融合，单节点三模式（semantic/keyword/hybrid），并预埋 hits 旁路供 Phase 2 rerank 消费。

**Architecture:** 检索纯逻辑（分词/FTS 查询串/RRF）下沉 `tianshu-core/src/retrieval.ts`（单份三端，零依赖）；FTS5 虚表 `vectorChunkFts` 为 `vectorChunk` 的全表镜像（独立存储双文本列，`ensure` 幂等建表 + count 对比回填 + upsert 增量同步），挂在天枢 local.db 上走 `prisma.$executeRawUnsafe/$queryRaw`（不进 prisma schema、不走 v1 快照）；executor 新增 handler 按 mode 分路。`vector-store.ts` 与 `graph-executor.ts` 是 mirror ↔ server 双份守护文件，必须同步双改。

**Tech Stack:** SQLite FTS5（better-sqlite3 内建）、Intl.Segmenter（Node/Chromium 内建 ICU）、Prisma raw 查询、zod、vitest（mirror）/ jest（server）。

**Spec:** `docs/superpowers/specs/2026-10-30-hybrid-search-node-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- **双份铁律**：`electron/domains/ai/orchestration/{vector-store,graph-executor}.ts` 与 `apps/tianshu-server/src/core/graph/` 下对应副本必须同步改（drift 活跃对，基线差 217 行）；两边文件已有意分叉（server 版 import 路径、个别结构不同），同步的是「逻辑段」，逐段对照插入而非整文件覆盖。
- **core 准入**：`packages/tianshu-core` 包内模块零运行时依赖（Intl.Segmenter 是内建 API，准入合规）；改 core 后必须重建 dist：`npm --prefix packages/tianshu-protocol run build && npm --prefix packages/tianshu-core run build`（server 消费 dist，mirror 经 alias 直读 src 不受影响）。
- **命名规范**：camelCase 变量/函数、kebab-case 文件名、错误码 snake_case（对齐现有 `vector_empty_text`/`embed_api_error` 风格）。
- **i18n 铁律**：所有用户可见文案走 `t()`，zh-CN 与 en-US 两个 JSON 同步加 key；禁止硬编码中文。
- **测试环境约束**：mirror 侧 vitest 无法加载真 better-sqlite3（Electron ABI 编译）——真表交互测试只能写 server 侧 jest（node ABI）；mirror 侧一律 mock prisma（先例 `tests/ai/graph-vector.test.ts`）。
- **worktree 环境**（如执行环境为 worktree）：跑 server jest 前需补 node_modules 双软链；若 jest 因 TS paths 不跟随目录级 symlink 大面积起不来（已知坑），fallback：`git diff main > /tmp/hs.patch` 后在主树 `git apply /tmp/hs.patch` 跑 server jest 验收，验收完主树 `git checkout -- .` 恢复（worktree 是唯一真源，勿在主树提交）。
- **提交纪律**：每 Task 结束即 commit（sub-agent 分段自提交保命）；commit message 中文 conventional 格式（如 `feat(graph): …`）。
- **业界主流取向**（用户授权遇疑时的裁决基准）：RRF k=60 不做成参数；FTS 查询词 OR 连接；bm25 负值转正展示；显式失败不做静默降级。

---

### Task 1: Spike——FTS5 与 Intl.Segmenter 实证（server 侧 jest）

**Files:**
- Create: `apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts`（spike 用例后续 Task 6 扩为正式 FTS 测试，不弃）

**Interfaces:**
- Produces: 实证结论（FTS5 虚表可建、`Intl.Segmenter` 可用、`bm25()`/`rank` 可查）。**任一失败 → 停止后续任务，报告用户**（兜底路线 trigram 需回 spec 重新设计）。

- [ ] **Step 1: 写实证 spec**

先读 `apps/tianshu-server/test/commons/ensure-graph-run-node-table.spec.ts` 学习 server jest 建临时 SQLite 库的模式（env 隔离变量等），照它开库。写以下用例（核心断言给全，建库细节按先例文件对齐）：

```typescript
// apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts
/**
 * Spike + 正式 FTS 数据面测试：FTS5 虚表可用性、Intl.Segmenter 可用性、
 * bm25 排序与中文预分词召回（GA 系混合检索）。
 */
import { tokenize, joinFtsDocument, joinFtsQuery } from "@tianshu/core";

describe("spike: FTS5 + Intl.Segmenter 可用性", () => {
  it("Intl.Segmenter 中文分词可用", () => {
    const tokens = tokenize("天枢混合检索支持中文全文匹配");
    expect(tokens.length).toBeGreaterThan(2);
    expect(tokens.join("")).toContain("检索");
  });

  it("FTS5 虚表可建、中文预分词 BM25 召回、OR 查询生效", () => {
    // 按先例建临时库 db（better-sqlite3 直连）
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(
      text, originalText UNINDEXED, userId UNINDEXED, collection UNINDEXED,
      sourceName UNINDEXED, chunkId UNINDEXED, tokenize = 'unicode61')`);
    const insert = db.prepare(
      "INSERT INTO t(text, originalText, userId, collection, sourceName, chunkId) VALUES (?,?,?,?,?,?)");
    insert.run(joinFtsDocument(tokenize("分布式系统的容错设计与故障恢复")), "分布式系统的容错设计与故障恢复", 1, "c1", "s1", 1);
    insert.run(joinFtsDocument(tokenize("前端组件的状态管理最佳实践")), "前端组件的状态管理最佳实践", 1, "c1", "s2", 2);
    // AND 词都命中 → 排第一
    const both = db.prepare(
      "SELECT chunkId, bm25(t) AS rank FROM t WHERE t MATCH ? AND userId = 1 ORDER BY rank"
    ).all(joinFtsQuery(tokenize("容错 故障")));
    expect(both[0].chunkId).toBe(1);
    // OR：只含一个词也召回
    const either = db.prepare(
      "SELECT chunkId FROM t WHERE t MATCH ? ORDER BY rank"
    ).all(joinFtsQuery(tokenize("容错 状态管理")));
    expect(either.map((r: any) => r.chunkId)).toContain(2);
    // bm25 为负、越小越相关
    expect(both[0].rank).toBeLessThan(0);
  });
});
```

注意：`tokenize/joinFts*` 此时还不存在——Task 1 内先在 `packages/tianshu-core/src/retrieval.ts` 落最小实现（Task 2 会补全与单测），并重建 dist（见 Global Constraints 命令）。

- [ ] **Step 2: 跑 spec 验证**

Run: `cd apps/tianshu-server && npx jest test/core/graph-vector-store-fts.spec.ts`
Expected: PASS。若 `CREATE VIRTUAL TABLE` 报 `no such module: fts5` 或 Segmenter undefined → **终止计划**，向用户报告（spec 兜底：trigram）。

- [ ] **Step 3: 版本一致性确认**

Run: `node -e "console.log(require('/Users/hjx/workspace/mirror/node_modules/better-sqlite3/package.json').version, require('/Users/hjx/workspace/mirror/apps/tianshu-server/node_modules/better-sqlite3/package.json').version)"`
Expected: 两版本号一致（server 侧实证结论可外推 mirror 侧）。不一致则记录并在 Task 6 补 mirror 侧 Electron 环境实证说明。

- [ ] **Step 4: Commit**

```bash
git add apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts packages/tianshu-core/src/retrieval.ts packages/tianshu-core/dist
git commit -m "feat(graph): FTS5/Intl.Segmenter spike 实证通过——混合检索前置"
```

---

### Task 2: core retrieval.ts 纯函数完整实现 + 单测

**Files:**
- Modify: `packages/tianshu-core/src/retrieval.ts`（Task 1 的最小版补全为正式版）
- Modify: `packages/tianshu-core/src/index.ts`（barrel 导出）
- Test: `tests/core/retrieval.test.ts`（mirror vitest，先例 `tests/core/workspace-files-scan.test.ts`）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `interface FusedHit { chunkId: number; sourceName: string; collection: string; text: string; score: number; rank: number }`
  - `tokenize(text: string): string[]`
  - `joinFtsDocument(tokens: string[]): string`
  - `joinFtsQuery(tokens: string[]): string`
  - `rrfFuse(vecHits: FusedHit[], ftsHits: FusedHit[], k?: number): FusedHit[]`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/retrieval.test.ts
/**
 * 检索纯函数：tokenize（中英混合/专有名词/空串/纯符号/FTS 语法字符剥离）、
 * joinFts*、rrfFuse（同 chunk 累加/rank 重排/空输入）。
 */
import { describe, expect, it } from "vitest";
import { tokenize, joinFtsDocument, joinFtsQuery, rrfFuse, type FusedHit } from "@tianshu/core";

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
    const tokens = tokenize("SQLite FTS5 支持 BM25 排序 v2");
    expect(tokens).toContain("SQLite");
    expect(tokens).toContain("BM25");
    expect(tokens).toContain("v2");
  });
  it("空串与纯符号产出空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("！？…—")).toEqual([]);
  });
  it("FTS5 查询语法字符被剥离（注入面自愈）", () => {
    const tokens = tokenize('容错" AND (NEAR) * :');
    expect(tokens.join(" ")).not.toMatch(/AND|NEAR|\*|:|"/);
    expect(tokens).toContain("容错");
  });
});

describe("joinFtsDocument / joinFtsQuery", () => {
  it("入库侧空格连接、查询侧 OR 连接", () => {
    expect(joinFtsDocument(["容错", "设计"])).toBe("容错 设计");
    expect(joinFtsQuery(["容错", "设计"])).toBe("容错 OR 设计");
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
    const fused = rrfFuse([hit(5, "x")], [], 60);
    expect(fused[0].rank).toBe(1);
  });
  it("空输入返回空数组", () => {
    expect(rrfFuse([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npm run test -- tests/core/retrieval.test.ts`（或 `npx vitest run tests/core/retrieval.test.ts`）
Expected: FAIL（`tokenize` 未导出/`@tianshu/core` 无该导出）。

- [ ] **Step 3: 写正式实现**

```typescript
// packages/tianshu-core/src/retrieval.ts
/**
 * 检索纯逻辑（GA 系单份三端）：中文分词（Intl.Segmenter——Node 16+/
 * Chromium 内建 ICU 词典，零依赖）、FTS5 查询串生成、RRF 融合。分词器
 * 单点抽象：质量升级（jieba 等）只动 tokenize 一处。
 */
export interface FusedHit {
  chunkId: number;
  sourceName: string;
  collection: string;
  text: string;
  score: number;
  rank: number;
}

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const TOKEN_RE = /[\p{Script=Han}\p{L}\p{N}]/u;

/** 分词：仅保留含文字/数字的词元（FTS5 查询语法字符与关键字形态天然
 * 剥离，MATCH 注入面自愈）；导出供测试 */
export function tokenize(text: string): string[] {
  return [...segmenter.segment(text)]
    .map((seg) => seg.segment.trim())
    .filter((token) => token.length > 0 && TOKEN_RE.test(token));
}

/** 入库侧：词元空格连接（FTS5 unicode61 按空格切） */
export function joinFtsDocument(tokens: string[]): string {
  return tokens.join(" ");
}

/** 查询侧：词元 OR 连接（对齐 ES 默认 OR 宽召回，靠 BM25 排序） */
export function joinFtsQuery(tokens: string[]): string {
  return tokens.join(" OR ");
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
    .sort((a, b) => b.score - a.score)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}
```

在 `packages/tianshu-core/src/index.ts` 末尾（`export * from "./tool-alias";` 后）加：

```typescript
// GA 系：混合检索纯逻辑（分词/FTS 查询串/RRF 融合，零依赖）
export * from "./retrieval";
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/core/retrieval.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 重建 dist + Commit**

```bash
npm --prefix packages/tianshu-protocol run build && npm --prefix packages/tianshu-core run build
git add packages/tianshu-core/src/retrieval.ts packages/tianshu-core/src/index.ts packages/tianshu-core/dist tests/core/retrieval.test.ts
git commit -m "feat(core): 检索纯逻辑入包——tokenize/joinFts*/rrfFuse（混合检索 GA 系）"
```

---

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

### Task 4: mirror vector-store.ts FTS 数据面

**Files:**
- Modify: `electron/domains/ai/orchestration/vector-store.ts`
- Test: `tests/ai/graph-hybrid.test.ts`（新建，本 Task 先写 FTS 侧 mock 断言；Task 5 扩 handler 用例）

**Interfaces:**
- Consumes: Task 2 的 `tokenize/joinFtsDocument/joinFtsQuery`、Task 3 无关（本文件不 import schema）。
- Produces（Task 5 与 Task 6 依赖）:
  - `ensureVectorFtsTable(): Promise<void>`
  - `searchFts(params: { userId: number; collection: string; queryTokens: string[]; limit: number }): Promise<FusedHit[]>`（内部 ensure+回填检测；空词元直接返回 `[]`；返回按相关度降序、`score` 为 `-bm25` 正值）
  - `upsertChunks` 行为扩展：事务内同步删/插 FTS 行（签名不变）
  - `interface FtsRow { chunkId: number; userId: number; collection: string; sourceName: string; originalText: string }`（回填扫描用）

- [ ] **Step 1: 写失败测试（FTS 侧 mock 断言）**

`tests/ai/graph-hybrid.test.ts` 顶部照 `tests/ai/graph-vector.test.ts` 的 `vi.mock("electron")` + `vi.mock("../../electron/commons/prisma-client")` 替身模式，mock 对象在 vector 先例基础上扩 raw 方法（`$executeRawUnsafe: vi.fn()`、`$queryRaw: vi.fn()`、`$transaction: vi.fn(async (fn) => fn(tx))` 交互式形态，tx 同 mock 面）。用例：

```typescript
describe("vector-store FTS 数据面", () => {
  it("searchFts：空词元短路返回空（不发 MATCH）", async () => {
    const hits = await searchFts({ userId: 1, collection: "", queryTokens: [], limit: 5 });
    expect(hits).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it("searchFts：count 一致时不回填、MATCH 串为 OR 连接", async () => {
    prisma.vectorChunk.count.mockResolvedValue(10);
    // FTS count 走 $queryRaw 第一跳返回 10（按实现约定的调用序 mock）
    prisma.$queryRaw.mockResolvedValueOnce([{ n: 10 }]).mockResolvedValueOnce([
      { chunkId: 1, sourceName: "s", collection: "c", text: "原文", rank: -1.2 },
    ]);
    const hits = await searchFts({ userId: 1, collection: "c", queryTokens: ["容错", "设计"], limit: 5 });
    expect(hits[0]).toMatchObject({ chunkId: 1, text: "原文", score: 1.2 });
  });
});
```

（mock 约定：FTS 行数 count 用 `$queryRaw` 查 `SELECT COUNT(*) AS n`；具体断言以实现落地的调用形态为准，sub-agent 写实现时保持「count 两跳 → 必要时回填 → MATCH 一跳」的调用序，测试按此 mock。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/ai/graph-hybrid.test.ts`
Expected: FAIL（`searchFts` 未导出）。

- [ ] **Step 3: 写实现**

`electron/domains/ai/orchestration/vector-store.ts` 追加（import 区补 `tokenize/joinFtsDocument/joinFtsQuery` 自 `@tianshu/core`，mirror 经 alias 直读 src）：

```typescript
const FTS_TABLE = "vectorChunkFts";
/** 回填单飞：并发首查复用同一次回填（automation 并发跑图防重） */
let ftsBackfillInFlight: Promise<void> | null = null;

/** FTS5 虚表幂等建表（vectorChunk 全表镜像；不进 prisma schema/不走
 * v1 快照——对齐 ensureGraphRunNodeTable 先例）。text=分词形态（MATCH
 * 索引面），originalText=原文（输出/hits 用）。 */
export async function ensureVectorFtsTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
    text, originalText UNINDEXED, userId UNINDEXED, collection UNINDEXED,
    sourceName UNINDEXED, chunkId UNINDEXED, tokenize = 'unicode61')`);
}

/** 全清全量回填 + optimize 段合并（万级亚秒；count 对比不一致时触发） */
async function rebuildFtsIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM ${FTS_TABLE}`);
  // select 限定列——不拉 vector JSON 大字段（回填只需文本与键）
  const rows: Array<{
    id: number; userId: number | null; collection: string;
    sourceName: string; text: string;
  }> = await prisma.vectorChunk.findMany({
    select: { id: true, userId: true, collection: true, sourceName: true, text: true },
  });
  for (const row of rows) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${FTS_TABLE}(text, originalText, userId, collection, sourceName, chunkId)
       VALUES (?, ?, ?, ?, ?, ?)`,
      joinFtsDocument(tokenize(row.text)), row.text,
      row.userId ?? 0, row.collection, row.sourceName, row.id,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('optimize')`);
}

/** 回填检测（单飞）：vectorChunk 与 FTS 行数不一致时全量重建 */
async function ensureFtsSynced(): Promise<void> {
  const [chunkCount] = await prisma.$queryRaw<[{ n: number }>](
    `SELECT COUNT(*) AS n FROM vectorChunk`);
  const [ftsCount] = await prisma.$queryRaw<[{ n: number }>](
    `SELECT COUNT(*) AS n FROM ${FTS_TABLE}`);
  if (chunkCount.n === ftsCount.n) {
    return;
  }
  if (!ftsBackfillInFlight) {
    ftsBackfillInFlight = (async () => {
      await ensureVectorFtsTable();
      await rebuildFtsIndex();
    })().finally(() => {
      ftsBackfillInFlight = null;
    });
  }
  await ftsBackfillInFlight;
}

/** BM25 全文检索：空词元短路；返回 -bm25 正值（越大越相关，与余弦同向） */
export async function searchFts(params: {
  userId: number;
  collection: string;
  queryTokens: string[];
  limit: number;
}): Promise<FusedHit[]> {
  if (params.queryTokens.length === 0) {
    return [];
  }
  await ensureVectorFtsTable();
  await ensureFtsSynced();
  const query = joinFtsQuery(params.queryTokens);
  const rows = await prisma.$queryRaw<
    Array<{ chunkId: number; sourceName: string; collection: string; text: string; rank: number }>
  >(`SELECT chunkId, sourceName, collection, originalText AS text,
       bm25(${FTS_TABLE}) AS rank
     FROM ${FTS_TABLE}
     WHERE ${FTS_TABLE} MATCH '${query.replace(/'/g, "''")}'
       AND userId = ${params.userId}
       ${params.collection ? `AND collection = '${params.collection.replace(/'/g, "''")}'` : ""}
     ORDER BY rank LIMIT ${params.limit}`);
  return rows.map((row) => ({
    chunkId: row.chunkId, sourceName: row.sourceName, collection: row.collection,
    text: row.text, score: -Number(row.rank), rank: 0,
  }));
}
```

> 注：`$queryRaw` tagged-template 才支持参数绑定，但条件拼接（collection 可空）用 tagged template 要 `Prisma.sql/Prisma.empty` 组合；上面选择了「词元已过白名单过滤 + 引号转义」的拼接式（`$queryRaw` 普通调用即整串）。两派业界都有——实现时若团队倾向参数化，改写为 `prisma.$queryRaw\`...\${Prisma.sql\`AND collection = \${...}\`}\`` 等价，断言不变。

**改造 `upsertChunks`**：数组式 `$transaction` 改交互式（混 model 与 raw），事务内现有关联后追加 FTS 删/插（分词）：

```typescript
export async function upsertChunks(params: {
  userId: number; collection: string; sourceName: string; model: string;
  chunks: VectorChunkRow[];
}): Promise<void> {
  await ensureVectorFtsTable();
  await prisma.$transaction(async (tx) => {
    await tx.vectorChunk.deleteMany({
      where: { userId: params.userId, collection: params.collection, sourceName: params.sourceName },
    });
    for (const chunk of params.chunks) {
      await tx.vectorChunk.create({
        data: {
          userId: params.userId, collection: params.collection,
          sourceName: params.sourceName, seq: chunk.seq, text: chunk.text,
          vector: JSON.stringify(chunk.vector), model: params.model,
        },
      });
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM ${FTS_TABLE} WHERE userId = ? AND collection = ? AND sourceName = ?`,
      params.userId, params.collection, params.sourceName);
    for (const chunk of params.chunks) {
      // create 返回整行含自增 id——直接用 created.id 作 FTS 行 chunkId
      await tx.$executeRawUnsafe(
        `INSERT INTO ${FTS_TABLE}(text, originalText, userId, collection, sourceName, chunkId)
         VALUES (?, ?, ?, ?, ?, ?)`,
        joinFtsDocument(tokenize(chunk.text)), chunk.text,
        params.userId, params.collection, params.sourceName, created.id);
    }
  });
}
```

> 注：上面 `created` 即循环里 `const created = await tx.vectorChunk.create({...})`（create 段与现版一致）；既有调用方（vectorize handler）签名零变化。

- [ ] **Step 4: 扩既有测试并验证全绿**

`tests/ai/graph-vector.test.ts` 若对 `upsertChunks` 的 `$transaction` 有数组式断言，按交互式 mock 更新（`$transaction: vi.fn(async (fn) => fn(tx))`）。跑：

Run: `npx vitest run tests/ai/graph-vector.test.ts tests/ai/graph-hybrid.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/orchestration/vector-store.ts tests/ai/graph-hybrid.test.ts tests/ai/graph-vector.test.ts
git commit -m "feat(graph): vector-store FTS 数据面——vectorChunkFts 虚表 ensure/回填单飞/BM25 检索/upsert 增量同步"
```

---

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
  prisma.$queryRaw.mockResolvedValue([{ n: 0 }]); // count 一致
  prisma.$queryRaw.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([
    { chunkId: 1, sourceName: "s1", collection: "c", text: "原文片段", rank: -0.8 },
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
  // embedding fetch 打桩为确定性向量（先例）；向量路命中 chunk 1，
  // FTS 路命中 chunk 1 与 chunk 2 —— 融合后 chunkId 1 第一
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

### Task 6: server 侧双份同步 + 真表 jest 测试

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/vector-store.ts`（Task 4 同逻辑段）
- Modify: `apps/tianshu-server/src/core/graph/graph-executor.ts`（Task 5 同逻辑段：分发注册 670 行区、handler 3716 行 `makeVectorSearchNodeHandler` 后、`NodeOutput` 类型、`toNodeUpdate`）
- Modify: `apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts`（Task 1 spike 扩为正式真表测试）

**Interfaces:**
- Consumes: Task 1–5 全部产物（core dist 已含 retrieval/schema）。
- Produces: server 无头端同能力（GraphPanel 遥控跑图时 hybridSearch 可用）。

- [ ] **Step 1: 双份同步 vector-store**

读 mirror 侧 Task 4 成品，将 `FTS_TABLE/ensureVectorFtsTable/rebuildFtsIndex/ensureFtsSynced/searchFts` 与 `upsertChunks` 改造段移植到 server 副本（server 版 import 风格保持该文件现状——单引号/路径差异按文件内既有惯例；`@tianshu/core` 在 server 走 dist）。`searchChunks` 同步加 chunkId。

- [ ] **Step 2: 双份同步 graph-executor**

移植分发注册（670 行区）、`makeHybridSearchNodeHandler`（3716 行后）、`NodeOutput` 加 hits、`toNodeUpdate` 透传。server 版对应工具函数（`GraphNodeFailure`/`traceSuccess`/`writeNodeRecord`）以 server 文件内既有形态为准（grep 同名定位，签名一致则照用）。

- [ ] **Step 3: 扩真表测试**

`graph-vector-store-fts.spec.ts` 追加真表用例（真 better-sqlite3 临时库直连——注意 server 生产代码走 prisma，测试里真表交互用 better-sqlite3 直连验证「SQL 语义正确性」，另配 handler 级 mock 测试走 server jest 既有 graph-executor.spec.ts 模式）：

```typescript
describe("FTS 数据面真表交互", () => {
  it("增量 upsert 同步：同键重跑幂等、FTS 行数不翻倍", async () => {
    // 经 server 侧 upsertChunks（prisma 指向测试库）两次同参调用
    // 断言 vectorChunk 与 FTS 表行数一致且等于 chunk 数
  });
  it("count 不一致触发全量回填且中文查询召回", async () => {
    // 直接 SQL 插 vectorChunk 行（绕过 upsert，制造 FTS 落后）
    // 调 searchFts —— 断言回填后命中原文（originalText 而非分词形态）
  });
  it("bm25 排序：双词命中排单词命中前", async () => {
    // 复用 Task 1 断言形态，经 searchFts 走通
  });
});
```

（测试建库方式照 `ensure-graph-run-node-table.spec.ts` 先例；prisma 测试实例的 env 隔离按先例文件的模式。）

- [ ] **Step 4: 跑 server jest 验证**

Run: `cd apps/tianshu-server && npx jest test/core/graph-vector-store-fts.spec.ts test/core/graph-executor.spec.ts`
Expected: PASS。若环境起不来（worktree TS paths 坑）→ 按 Global Constraints 的 fallback 流程主树对照验收。

- [ ] **Step 5: drift 核算**

Run: `npm run check:drift`
Expected: exit 0（双份同步后差异行不增长；若超容差，评估后 `npm run check:drift -- --rebase` 重置基线并在 commit message 注明）。

- [ ] **Step 6: Commit**

```bash
git add apps/tianshu-server/src/core/graph/ apps/tianshu-server/test/core/graph-vector-store-fts.spec.ts packages/tianshu-core/scripts/drift-manifest.json
git commit -m "feat(graph): server 侧混合检索双份同步 + FTS 真表 jest 测试"
```

---

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
