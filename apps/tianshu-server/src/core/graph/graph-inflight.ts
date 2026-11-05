/**
 * 自 mirror electron/domains/ai/orchestration/graph-inflight.ts 直摘（GA-T4）。
 * 零逻辑改动（纯进程级注册表，无 prisma/Electron 依赖）；消费方：T6
 * graph 模块试运行/中止入口（mirror graph.repo runTest/cancelTestRun 语义）、
 * webhook.service runForWebhook 互斥（批1C 改进项 4）。
 */
/**
 * 图在途互斥注册表（先例 automation-inflight）。
 * - graphTestInflight：试运行在途（graphId → 本次试运行的 AbortController）。
 *   repo runTest 手动试运行共用，同一图任意时刻至多一个在途试运行（防
 *   重复会话/full 模式重复写盘）；执行收口（.finally）删除条目，悬挂 run
 *   由 scheduler 启动回收置 failed。
 * - graphWebhookInflight：webhook 触发在途（改进项 4，批1C）——runForWebhook
 *   入口 check→set 相邻占位，同图并发 POST 第二个拒 graph_inflight（试运行/
 *   任务级互斥之外的 webhook 面补齐）；收口（.finally）删除条目，中止仍走
 *   webhook.service activeRuns（runId 键）。
 */
export const graphTestInflight = new Map<number, AbortController>();

export const graphWebhookInflight = new Map<number, AbortController>();
