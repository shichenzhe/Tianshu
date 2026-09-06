/**
 * 自动化调度配置(zod discriminated union,spec §3)。
 * 放前端目录供后端 repo 校验复用(后端引前端类型有先例);
 * 前端 SchedulePicker/表单直接消费类型。
 * 星期约定 ISO:1=周一 … 7=周日。
 */
import { z } from "zod";

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 间隔模式下限(分钟),防高频打爆资源(PRD《执行频率》§4) */
export const INTERVAL_MIN_MINUTES = 5;

const time = z.string().regex(TIME_RE);
const isoDate = z.string().regex(DATE_RE);
const isoDateTime = z.string().datetime({ offset: true });

// zod 4 的 discriminatedUnion 禁止重复判别值(periodic 有 6 个变体),
// 故 periodic 按 kind 组内层 union,外层仍按 mode 判别,推断类型不变
const periodicSchema = z.discriminatedUnion("kind", [
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("once"),
    runAt: isoDateTime,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("daily"),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("biweekly"),
    anchorDate: isoDate,
    weekday: z.number().int().min(1).max(7),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("yearly"),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    time,
  }),
]);

export const scheduleSchema = z.discriminatedUnion("mode", [
  periodicSchema,
  z.object({
    mode: z.literal("interval"),
    value: z.number().int().positive(),
    unit: z.enum(["minute", "hour"]),
    // min(1) 双保险:空数组在 computeNextRun 视同不限制,但配置侧直接拒收
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  }),
]);

export type ScheduleConfig = z.infer<typeof scheduleSchema>;
/** 间隔分钟数换算(校验下限用) */
export function intervalMinutes(
  cfg: Extract<ScheduleConfig, { mode: "interval" }>,
): number {
  return cfg.unit === "hour" ? cfg.value * 60 : cfg.value;
}
