// src-react/domains/project/model/plan-view-engine.ts
/**
 * 计划视图筛选引擎——A7 批实现已下沉 @tianshu/core（plan-view-engine，
 * 双端复用单份权威源）。本文件保留为 re-export 兼容层：既有消费方
 * （五视图组件/PlanPane/use-plan-views）与测试的 import 路径零改动。
 * 注意 core 侧条目类型为协议 PlanItemRecordDto，与桌面 PlanItemRecord
 * 结构同形，双向可赋值。
 * 渲染进程须用子路径导入（@tianshu/core/plan-view-engine）——包入口聚合
 * 含 run-chat-stream/e2e-crypto 等 Node 侧模块，根导入会把 node:fs 等
 * 内置模块拖进 renderer（graph-schema/schedule-schema 同先例）。
 */
export {
  filterItems,
  groupItems,
  parseViewConfig,
  sortItems,
} from "@tianshu/core/plan-view-engine";
export type {
  FilterCondition,
  GroupByField,
  ItemGroup,
  SortField,
  SortRule,
} from "@tianshu/core/plan-view-engine";
