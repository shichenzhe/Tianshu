/**
 * 自动化调度配置——re-export 兼容层：GA-T2 随 schedule.ts 闭包入包
 * （ScheduleConfig 类型唯一源，packages/tianshu-core/src/schedule-schema.ts），
 * 此处 re-export 兼容，前端 SchedulePicker/表单等老 import 链与导出
 * 名不变（scheduleSchema/ScheduleConfig/TIME_RE/intervalMinutes 等）。
 * 子路径直指源文件不走包 barrel（tests/ai/renderer-core-subpath-guard
 * 守卫）：barrel 含 e2e-crypto（纯 node:crypto），sandbox 渲染层无
 * require，会炸 ReferenceError。
 */
export * from "@tianshu/core/schedule-schema";
