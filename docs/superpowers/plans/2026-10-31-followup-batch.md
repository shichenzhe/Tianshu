# 跨批遗留收尾实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿三批（hybridSearch / PG 检索 / Docker 治理）终审与评审沉淀的 follow-up 小项——部署硬化两项、server 检索健壮性四项、测试与文档杂项。

**Architecture:** 全部为已裁定内容的执行项（各批 review 已定做法），无新设计。分三任务按领域隔离：Docker 部署面 / server 检索代码 / 测试与文档。

**Tech Stack:** docker compose、jest（mock pg）、vitest。

**Spec:** 无单一 spec——各来源：docker 治理批 ledger 归档（`.superpowers/sdd-archive/docker-deploy-progress.md`）、PG 检索批 ledger 归档、hybridSearch 批 ledger 归档的 deferred 项。

## Global Constraints

- 既有回归基线不动：mirror vitest（实测口径 4460 passed/9 skipped）、server jest 74 suites 全绿；typecheck 恰 5 条预存 electron/ 基线。
- 遵循各文件既有风格（server 单引号、mirror 双引号、中文注释）。
- 每任务一 commit（或按逻辑分两个），中文 conventional。
- 不扩范围：e2e infra 三副本抽取、drift 预存债、Phase 2（主库双引擎/rerank）明确不在本批。

---

### Task 1: Docker 部署硬化两项

**Files:**
- Modify: `apps/tianshu-server/Dockerfile`（transform 钉版一行）
- Modify: `apps/tianshu-server/docker-compose.yml`（server healthcheck）

- [ ] **Step 1: `@prisma/client` 随 prisma 钉版**

Dockerfile 的 transform `node -e` 里，在 `p.dependencies.prisma=ver(...)` 同款位置加：

```javascript
p.dependencies['@prisma/client']=ver('apps/tianshu-server/node_modules/@prisma/client/package.json')||ver('node_modules/@prisma/client/package.json')||p.dependencies['@prisma/client'];
```

（防 bundle lock 重新解析把 6.x 新运行时与 6.19.3 生成物错配——终审 Minor #4。）

- [ ] **Step 2: server 容器 healthcheck**

compose server 服务加（alpine busybox wget 可用）：

```yaml
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/actuator/health > /dev/null 2>&1 || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
```

- [ ] **Step 3: 验证**

`TIANSHU_TOKEN=x docker compose -f apps/tianshu-server/docker-compose.yml config -q && echo VALID`；镜像重建到 transform 层确认钉版生效（`docker build` 至 bundle 组装层后 `docker run --rm --entrypoint sh <img> -c "node -e \"console.log(require('/app/package.json').dependencies['@prisma/client'], require('/app/package.json').dependencies.prisma)\""` 两值均为 6.x 精确版本号）。

- [ ] **Step 4: Commit**

`fix(server): Docker 收尾——@prisma/client 随 CLI 钉版 + server healthcheck 自愈`

---

### Task 2: search-pg 健壮性四项

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/search-pg.ts`（metachar 过滤 + release(err)）
- Test: `apps/tianshu-server/test/core/graph-search-pg.spec.ts`（metachar 用例 + 三函数分派表驱动用例）
- Create: `apps/tianshu-server/test/core/db-client-postgres.spec.ts`（db-client pg 路径回归）

- [ ] **Step 1: buildFtsQuery metachar 防御（TDD）**

失败测试先行：

```typescript
it('含 tsquery 语法字符的混合词元被剔除（防御 simple config 语法错误）', () => {
  expect(buildFtsQuery(['容', 'a&b', '设计'])).toBe('容 | 设计');
  expect(buildFtsQuery(['x|y'])).toBe('');
});
```

实现：`buildFtsQuery` 过滤严格词元（`/^[\p{Script=Han}\p{L}\p{N}]+$/u` 全串匹配）后再 join；中文注释说明「tokenize 白名单是包含性测试，混合 metachar 词元仍可能通过——此处全串白名单剔除，防 to_tsquery 语法错误面」。

- [ ] **Step 2: upsert 错误路径 release(err)（丢弃坏连接）**

`upsertChunksPg` 的 catch 分支：ROLLBACK 失败（`.catch` 捕获）时置 `errored = true`；`finally` 里 `client.release(errored ? (e as Error) : undefined)`——pg 语义：带 err 的 release 把连接从池中废弃。补 mock 用例断言 ROLLBACK 失败路径 release 收到 err。

- [ ] **Step 3: 三函数 PG 分派表驱动测试**

照既有 searchFts 分派用例手法，补 `upsertChunks/searchChunks/countCollection` 三条（SEARCH_DB_URL 设值 + `jest.resetModules()` + 断言走 `__query`/`__connect` mock 面而非本地 runtime）。

- [ ] **Step 4: db-client postgres 引擎回归（新 spec）**

`test/core/db-client-postgres.spec.ts`：`jest.mock('pg')`（Client 形态——db-client 用 `new Client` + connect/query/end），测 `runDatabaseQuery({engine:'postgres', sql, params, ...})` 的连接配置、参数透传、rows/rowCount 两路、错误包装（connect 类 vs query 类码）。ctx 用最小桩（workspacePath 不需要——postgres 引擎不走 openSqlite）。

- [ ] **Step 5: 验证 + Commit**

`cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts test/core/db-client-postgres.spec.ts` 全绿 → 全量 jest 74 suites 确认零回归。
`fix(graph): search-pg 收尾——tsquery metachar 防御/坏连接废弃/三函数分派测试/db-client pg 回归`

---

### Task 3: 测试与文档杂项

**Files:**
- Modify: `tests/ai/graph-hybrid.test.ts`（collection 空串分支用例）
- Modify: `tests/ai/model-picker-type-filter.test.tsx`（hybridSearch 只列 embedding 一行用例）
- Modify: `packages/tianshu-core/tsconfig.json`（注释如实化）
- Modify: `docs/superpowers/plans/2026-10-31-server-docker-deploy.md`（基线口径注记）

- [ ] **Step 1: searchFts collection 空串分支用例**

`tests/ai/graph-hybrid.test.ts` 补（T4 遗留 deferred）：

```typescript
it('collection 空串：where 不含 collection 键（全集合语义）', async () => {
  prisma.vectorChunk.findMany.mockResolvedValue([
    { id: 1, collection: 'c1', sourceName: 's1', text: '容错设计的原文' },
  ]);
  const hits = await searchFts({ userId: 1, collection: '', queryTokens: ['容', '设计'], limit: 3 });
  expect(hits.length).toBeGreaterThan(0);
  expect(prisma.vectorChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { userId: 1 }, // 无 collection 键
  }));
});
```

- [ ] **Step 2: model-picker hybridSearch 用例**

`tests/ai/model-picker-type-filter.test.tsx` 照 :165 的 vectorSearch 用例形态补 hybridSearch 同款断言（filterType="embedding" 路径只列 embedding 模型）。

- [ ] **Step 3: core tsconfig 注释如实化**

现注释「DOM 系保留」与事实不符（lib 行系本分支新增）——改为如实描述：lib 为 Intl.Segmenter 类型新增 ES2022.Intl；DOM/DOM.Iterable 系跟随根 tsconfig 混配的保守选择（非实证必需，expert-market 的 window 命中是字符串字面量）。

- [ ] **Step 4: plan 基线口径注记**

`docs/superpowers/plans/2026-10-31-server-docker-deploy.md` Global Constraints 的「mirror vitest 4465」处加注：（实测口径 4460 passed + 9 skipped，环境 delta 非失败——2026-10-31 验收记录）。

- [ ] **Step 5: 验证 + Commit**

`npx vitest run tests/ai/graph-hybrid.test.ts tests/ai/model-picker-type-filter.test.tsx tests/core` 全绿；core tsconfig 改后 `npm --prefix packages/tianshu-core run build` 确认零影响（dist git-ignored 不入 commit）。
`test(graph): 跨批杂项收尾——collection 空串/model-picker 用例/tsconfig 注释如实化/基线口径注记`
