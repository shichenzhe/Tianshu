# 移动端用量监控批（A6）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.
> Spec: `docs/superpowers/specs/2026-10-25-mobile-monitor-batch.md`（已评审通过）

**Goal:** 移动端经被控面协议遥控读取桌面端用量监控（今日 KPI/7 天趋势/模型分布/工具排行）。

**Architecture:** 协议包收编 MonitorStats 类型 + `monitor/stats` 端点 + `monitor` 能力位 → 桌面 server-face 注册只读路由（复用 MonitorRepository.getStats）→ 移动端我的页 capability 门禁入口 + 全屏 /monitor 页。无头端无事件表，不在本批。

## Global Constraints

- 工作分支 main，直接提交（用户长期裁定，不开 worktree/分支）。
- 移动端 lint 环境态不可用：mobile 侧验收固定 typecheck + vitest + prettier；mirror 根侧验收 `npm run typecheck` + 根 vitest（server-face 相关）。
- **禁止根目录 npm install**（nativewind 本地树铁律）；协议包 dist 用 `npm --prefix packages/tianshu-protocol run build` 重建。
- i18n：移动端新增文案必须 zh-CN + en-US 同步，禁止顶层/嵌套 key 重名。
- 移动端样式禁硬编码主题色（label2/sep/card/field 等语义类除外，主题色必须走 `useThemeColors()`）。
- 协议包零运行时依赖，只放类型 + 常量。
- server-face 双份文件漂移守护：`npm run check:drift` 不涉本批文件（routes.ts/deps.ts/ipc.ts/Application.ts 均 mirror 独有）。

---

### Task 1: 协议包收编监控类型与端点

**Files:**
- Modify: `packages/tianshu-protocol/src/server-event.ts`
- Create: `packages/tianshu-protocol/src/monitor-contract.ts`
- Modify: `packages/tianshu-protocol/src/index.ts`
- Modify: `src-react/domains/ai/monitor/api/monitor.api.ts`
- Modify: `electron/domains/ai/monitor/monitor.repo.ts`

**Interfaces:**
- Produces: `@tianshu/protocol` 导出 `MonitorScene`、`MonitorStats`（形状逐字照抄桌面 monitor.api.ts 现状：today/trend/byModel/tools 四块）、`ENDPOINTS.monitor.stats === "monitor/stats"`、`DESKTOP_CAPABILITIES` 含 `"monitor"`。

- [ ] **Step 1:** `packages/tianshu-protocol/src/monitor-contract.ts` 新文件，逐字迁移 `src-react/domains/ai/monitor/api/monitor.api.ts` 的 `MonitorScene` 与 `MonitorStats`（含全部注释），文件头注释注明「A6 批自桌面 monitor.api.ts 收编（单份权威源）」。
- [ ] **Step 2:** `src/index.ts` 聚合 export 增 `./monitor-contract`（保持六模块注释更新为七模块）。
- [ ] **Step 3:** `server-event.ts`：`DESKTOP_CAPABILITIES` 数组增 `"monitor"`（加注释「A6 监控读面」）；`ENDPOINTS` 增 `monitor: { stats: "monitor/stats" }`（放在 mcp 组后，注释「A6：只读聚合面」）。
- [ ] **Step 4:** 桌面 `monitor.api.ts`：删除本地 interface 定义，改为 `import type { MonitorScene, MonitorStats } from "@tianshu/protocol"; export type { MonitorScene, MonitorStats };`——`MonitorApi` 与其余内容不动。
- [ ] **Step 5:** `electron/domains/ai/monitor/monitor.repo.ts`：类型 import 从 `../../../../src-react/domains/ai/monitor/api/monitor.api` 改为 `@tianshu/protocol`。
- [ ] **Step 6:** 重建协议 dist：`npm --prefix packages/tianshu-protocol run build`（mobile/server 经 dist 消费）。
- [ ] **Step 7:** 验证：根 `npm run typecheck` 绿 + 根 vitest 中 monitor 相关用例绿（`npx vitest run src-react/domains/ai/monitor electron/domains/ai/monitor` 若存在，否则全量相关域）。
- [ ] **Step 8:** 提交：`feat(protocol): A6 监控收编——MonitorStats/Scene 类型单份入协议包、ENDPOINTS.monitor.stats、DESKTOP_CAPABILITIES+monitor`

---

### Task 2: 桌面被控面 monitor/stats 路由

**Files:**
- Modify: `electron/domains/server-face/deps.ts`
- Modify: `electron/domains/server-face/ipc.ts`
- Modify: `electron/domains/server-face/routes.ts`
- Modify: `electron/Application.ts`

**Interfaces:**
- Consumes: Task 1 的 `MonitorStats`/`MonitorScene`（`@tianshu/protocol`）、既有 `MonitorRepository.getStats(userId, scene?)`。
- Produces: `POST monitor/stats` 路由（body `{scene?: "chat"|"graph"|"automation"}`，非法/缺省 scene 归 undefined）；`ServerFaceDeps.monitor?: { stats(userId, scene?) }`（可选——未装配报未装配，对齐 mcps/files 既有口径）；`attachServerFace` 新可选参 `monitorRepo?: Pick<MonitorRepository, "getStats">`。

- [ ] **Step 1:** `deps.ts`：`ServerFaceDeps` 增可选成员（放在 `files?` 后）：
  ```ts
  /** A6 监控读面（可选——未装配时 monitor/stats 报未装配） */
  monitor?: {
    stats(userId: number, scene?: MonitorScene): Promise<MonitorStats>;
  };
  ```
  顶部从 `@tianshu/protocol` import 两个类型。
- [ ] **Step 2:** `ipc.ts` `attachServerFace` deps 参数增 `monitorRepo?: Pick<MonitorRepository, "getStats">`；`setServerFaceDeps({...})` 对象增：
  ```ts
  ...(deps.monitorRepo
    ? { monitor: { stats: (userId, scene) => deps.monitorRepo!.getStats(userId, scene) } }
    : {}),
  ```
- [ ] **Step 3:** `Application.ts`：`new MonitorRepository();`（约 245 行）改为 `const monitorRepo = new MonitorRepository();`，`attachServerFace({...})` 调用增 `monitorRepo,`。
- [ ] **Step 4:** `routes.ts` 仿 `handleMcpQuery` 的未装配写法新增：
  ```ts
  /** monitor/stats：用量监控只读聚合（A6 批——scene 非法归 undefined，对齐桌面 IPC 口径） */
  async function handleMonitorStats(body: unknown): Promise<RouteResult> {
    const scene = (body as { scene?: unknown })?.scene;
    const deps = faceDeps().monitor;
    if (!deps) return notAssembled("monitor"); // 未装配口径对齐 mcp 批实际写法
    return withUserId(async (userId) =>
      ok(await deps.stats(userId, SCENE_LIST.includes(scene as never) ? (scene as MonitorScene) : undefined)),
    );
  }
  ```
  路由表增 `"POST monitor/stats": handleMonitorStats,`（放在 mcp 组后）。`SCENE_LIST` 用局部常量 `["chat","graph","automation"] as const`。
- [ ] **Step 5:** 若有 server-face 路由既有测试（`tests/` 下 face 相关），补 monitor/stats 用例：装配内存 deps 断言 scene 透传/非法归 undefined/未装配报错；无既有测试文件则跳过不新建（E2E 冒烟不在本批）。
- [ ] **Step 6:** 验证：根 `npm run typecheck` 绿；server-face 相关 vitest 绿。
- [ ] **Step 7:** 提交：`feat(server-face): A6 monitor/stats 只读路由——deps 注入 MonitorRepository.getStats，scene 白名单归一，未装配报错对齐 mcp 口径`

---

### Task 3: 移动端监控页

**Files:**
- Create: `apps/tianshu-mobile/src/store/monitor.store.ts`
- Create: `apps/tianshu-mobile/src/store/monitor.store.test.ts`
- Create: `apps/tianshu-mobile/src/logic/monitor-trend.ts`
- Create: `apps/tianshu-mobile/src/logic/monitor-trend.test.ts`
- Create: `apps/tianshu-mobile/src/app/monitor.tsx`
- Create: `apps/tianshu-mobile/src/i18n/locales/zh-CN/monitor.json` 与 `en-US/monitor.json`
- Modify: `apps/tianshu-mobile/src/i18n/index.ts`（命名空间注册）
- Modify: `apps/tianshu-mobile/src/app/_layout.tsx`（Stack 注册）
- Modify: `apps/tianshu-mobile/src/app/(tabs)/settings.tsx`（入口行）

**Interfaces:**
- Consumes: Task 1 的 `ENDPOINTS.monitor.stats` + `MonitorStats` 类型（mobile 经 workspace 依赖消费 **dist**，Task 1 已重建）；`useConnectionCapabilities(activeConnId)`（`@/store/connections.store`）；`request` 模式参照 `src/store/sessions.store.ts`（`activeTransport`/`wireRequest`）。
- Produces: `/monitor` 路由页；`useMonitorStore`（scene/stats/loading/error/load(scene)）。

- [ ] **Step 1（先写失败测试）:** `src/logic/monitor-trend.test.ts` + 实现 `src/logic/monitor-trend.ts`：纯函数 `trendBarHeights(trend: Array<{ inputTokens: number; outputTokens: number }>, maxHeight: number): Array<{ input: number; output: number }>`——窗口内最大 token 值归一到 maxHeight，最小 2px 保可见，全零返回全 2px。TDD：先测试后实现。
- [ ] **Step 2（store + 测试）:** `monitor.store.ts` 仿 sessions.store 测试替身模式（vi.mock connections.store）：state `{scene: MonitorScene | "all", stats: MonitorStats | null, loading, error}`；`load()` 经 `activeTransport().request("POST", ENDPOINTS.monitor.stats, scene === "all" ? {} : { scene })`，wire 判空→error；scene 切换自动 load。测试覆盖：成功解包、失败 error、scene 载荷。命名空间 key 不存在时端到端类型会红——Step 1 后再跑。
- [ ] **Step 3（i18n）:** 新命名空间 `monitor`（zh/en 同步注册进 `src/i18n/index.ts` namespaces）：key 含 `title`、`sceneAll/sceneChat/sceneGraph/sceneAutomation`、`todayTitle`、`inputTokens/outputTokens/llmCalls/toolCalls/successRate`、`trendTitle/trendInput/trendOutput`、`byModelTitle/callsLabel`、`toolsTitle/avgDuration/denied/error/done`、`empty`、`loadFailed/retry`、`noConnection`（复用既有 common/chat key 时不重复造）。
- [ ] **Step 4（页面）:** `src/app/monitor.tsx`：ScrollView 页（SafeArea + 顶栏大标题「用量监控」，无 headerRight）——场景四段 segmented（选中 `colors.primary` 下划线/圆角高亮）；今日 KPI 2×2 组卡（label2 小字 + 数值）；趋势卡：`trendBarHeights` 自绘双柱（input 主题色 solid、output 主题色 40% 透明度，宽度均分，底部日期 MM-DD 小字）；按模型卡（前 10：名称 + calls + ↑in ↓out）；工具排行卡（前 10：名称 + 成功率% + 均耗 ms + 总/拒/错）；三态（loading 指示/error+重试/空数据文案；无连接引导跳 /connections）。样式全语义类 + `useThemeColors()`。
- [ ] **Step 5（注册与入口）:** 根 `_layout.tsx` Stack 增 `<Stack.Screen name="monitor" options={{ headerShown: false }} />`（页面自绘顶栏，同 index 惯例——按现有文件实际写法对齐）；`settings.tsx` 我的页在通知组后新增「用量监控」行：`useConnectionCapabilities(activeConnId)?.includes("monitor")` 才渲染（对齐 McpSection 门禁惯例），点击 `router.push("/monitor")`。
- [ ] **Step 6:** 三件套：mobile `npm run typecheck` + `npm run test` + prettier --check 全绿（259+ 既有测试不得红）。
- [ ] **Step 7:** 提交：`feat(mobile): A6 用量监控页——我的页 capability 门禁入口+全屏 /monitor（场景分段/KPI/7 天趋势自绘双柱/模型分布/工具排行），monitor.store+趋势纯函数带单测`

---

## 依赖与冲突扫描（Pre-flight）

| 检查对 | 结论 |
|---|---|
| T1 → T2（协议类型/能力位） | T2 的 deps/routes import `@tianshu/protocol` 新类型，T1 必须先合入 |
| T2 → T3（ENDPOINTS.monitor + 能力位） | mobile 消费协议 **dist**，T1 已重建 dist；T3 依赖 T1 产物 |
| T2 与 T3 文件不相交（electron vs apps/tianshu-mobile） | 无冲突 |
| T2 routes.ts「未装配」写法 | 实现期对齐 mcp 批实际写法（`handleMcpQuery` 开头），勿凭记忆造 |
| drift 巡检 | 本批四文件均 mirror 独有，`npm run check:drift` 不受影响 |
