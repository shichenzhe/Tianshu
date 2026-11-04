/**
 * 会话内搜索的高亮工具：
 * - splitByQuery/countHits/hitOffsets 为纯函数（有单测；countHits/splitByQuery
 *   留作单文本计数/切分工具，命中位置级产出见 hit-positions.ts）；
 * - renderHitMarks 按位置级命中区间把纯文本切成 <mark data-hit-index>，
 *   供 user 气泡（纯文本、无 markdown 解析）复用；助手正文经 MarkdownView
 *   的 rehypeSearchMarks 按 hast position 映射落 mark。
 * 当前命中项实底主题色、其余半透明，均随主题切换
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { HitRange } from "./hit-positions";

/** 单条消息正文的命中段：text 原文片段，hit 是否命中关键字 */
export interface QuerySegment {
  text: string;
  hit: boolean;
}

/** 大小写不敏感切分（非重叠命中；空关键字整段未命中） */
export function splitByQuery(text: string, query: string): QuerySegment[] {
  if (!query) {
    return [{ text, hit: false }];
  }
  const lowerQuery = query.toLowerCase();
  const segments: QuerySegment[] = [];
  let rest = text;
  while (rest) {
    const index = rest.toLowerCase().indexOf(lowerQuery);
    if (index === -1) {
      segments.push({ text: rest, hit: false });
      break;
    }
    if (index > 0) {
      segments.push({ text: rest.slice(0, index), hit: false });
    }
    segments.push({ text: rest.slice(index, index + query.length), hit: true });
    rest = rest.slice(index + query.length);
  }
  return segments;
}

/** 一段文本内的命中次数（空关键字为 0） */
export function countHits(text: string, query: string): number {
  return splitByQuery(text, query).filter((segment) => segment.hit).length;
}

/** 各消息首命中的全局序号（前缀和；无命中消息的值无意义，调用方忽略） */
export function hitOffsets(hitCounts: number[]): number[] {
  const offsets: number[] = [];
  let total = 0;
  for (const count of hitCounts) {
    offsets.push(total);
    total += count;
  }
  return offsets;
}

/**
 * 位置级命中区间渲染（user 气泡纯文本高亮）：ranges 为升序、互不重叠、
 * 完整落于 text 内的源偏移区间（hit-positions 产出口径），按序编
 * data-hit-index（baseIndex + 序数）——与 MarkdownView 的 rehype 通道
 * 编号规则一致，MessageList scrollIntoView 选择器口径不变。
 */
export function renderHitMarks(
  text: string,
  ranges: HitRange[],
  baseIndex: number,
  activeIndex: number,
): ReactNode {
  if (ranges.length === 0) {
    return text;
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      nodes.push(text.slice(cursor, range.start));
    }
    const hitIndex = baseIndex + index;
    nodes.push(
      <mark
        key={index}
        data-hit-index={hitIndex}
        className={cn(
          "rounded-sm px-0.5",
          hitIndex === activeIndex
            ? "bg-primary text-primary-foreground"
            : "bg-primary/25 text-foreground",
        )}
      >
        {text.slice(range.start, range.start + range.length)}
      </mark>,
    );
    cursor = range.start + range.length;
  });
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}
