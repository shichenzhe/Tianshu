/**
 * 当前时间上下文注入：模型无内置时钟，问答与计划工具（dueDate
 * yyyy-MM-dd）都需要「今天」基准——assembleContext 每次请求重跑，注入
 * 的时间随请求刷新（长会话跨天不陈旧）。
 * 注入位置选最后一条 user 消息 blocks 头部而非 system：前缀缓存按从头
 * 逐 token 匹配，分钟级变化的时间行放 system 头部会让整个对话历史的
 * 缓存周期性作废；最后一条 user 消息本就是每请求唯一无缓存的新增部分，
 * 时间放这里不破坏任何前缀匹配（system 与历史保持逐字节稳定）。
 * 纯函数（now 注入可测，禁 import electron/fs）。
 */

import { parseBlocks, serializeBlocks } from "./blocks";

/** 周几中文（getDay() 0=周日） */
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 本地时区偏移（分钟，getTimezoneOffset 取负）→ UTC±HH:mm */
function timezoneLabel(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** 时间行：2026-09-23 09:30 周二 UTC+08:00（本地时区） */
export function formatTimeContext(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${date} ${time} ${WEEKDAY_LABELS[now.getDay()]} ${timezoneLabel(-now.getTimezoneOffset())}`;
}

/**
 * 时间行作为独立 text block 插到 blocks 头部（user 消息原文不动）；
 * 所有模式一致注入——时间属环境上下文，非工具/技能能力声明，不破坏
 * ask 模式的工具隔离语义。畸形/空 blocks 经 parseBlocks 归一为空数组
 * → 结果仅时间 block（历史数据容错）
 */
export function withTimeBlock(blocks: string, now: Date): string {
  return serializeBlocks([
    { type: "text", text: `当前时间：${formatTimeContext(now)}` },
    ...parseBlocks(blocks),
  ]);
}
