/**
 * 自 mirror electron/domains/ai/orchestration/graph-inflight.ts 直摘（GA-T4）。
 * 零逻辑改动（纯进程级注册表，无 prisma/Electron 依赖）；消费方：T6
 * graph 模块试运行/中止入口（mirror graph.repo runTest/cancelTestRun 语义）。
 */
/**
 * 图试运行在途互斥注册表（先例 automation-inflight）：graphId → 本次
 * 试运行的 AbortController。repo runTest 手动试运行共用，同一图任意
 * 时刻至多一个在途试运行（防重复会话/full 模式重复写盘）；执行收口
 * （.finally）删除条目，悬挂 run 由 scheduler 启动回收置 failed。
 */
export const graphTestInflight = new Map<number, AbortController>();
