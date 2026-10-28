/**
 * GraphJson 结构与校验——re-export 兼容层：GA-T2 按 controller ruling 3
 * 全量（37 zod schema + z.infer 推断类型 + validateGraph 等 5 运行时
 * 函数）物理搬入 packages/tianshu-core/src/graph-schema.ts（@tianshu/core
 * peerDep 加 zod）；渲染层大量既有 import 经此处零感过渡，老导出面不变。
 * GraphIssue 纯类型仍自 @tianshu/protocol re-export（GA-T1 收编，保留
 * ——显式具名导出优先于 export * 的同名星导，两叠加不冲突）。
 * 子路径直指源文件不走包 barrel（tests/ai/renderer-core-subpath-guard
 * 守卫）：barrel 含 e2e-crypto（纯 node:crypto），sandbox 渲染层无
 * require，会炸 ReferenceError。
 */
export * from "@tianshu/core/graph-schema";
export type { GraphIssue } from "@tianshu/protocol";
