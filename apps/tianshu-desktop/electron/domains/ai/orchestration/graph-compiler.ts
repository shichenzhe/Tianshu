/**
 * GraphJson → LangGraph StateGraph 编译器——re-export 兼容层：
 * 实现随 GA-T2 物理搬入 packages/tianshu-core/src/graph-compiler.ts
 * （@tianshu/core），此处 re-export 兼容，老 import 链与导出名不变
 * （compileStateGraph/buildEdgePlan/GRAPH_RECURSION_LIMIT 等）。
 */
export * from "@tianshu/core";
