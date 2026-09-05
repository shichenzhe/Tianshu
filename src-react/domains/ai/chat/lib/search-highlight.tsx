/**
 * 会话内搜索的高亮工具：
 * - splitByQuery/countHits/hitOffsets 为纯函数（有单测）；
 * - highlightChildren 递归遍历 ReactNode 把字符串子节点切成
 *   <mark data-hit-index>，供 MarkdownView 各组件与 user 气泡复用。
 * 当前命中项实底主题色、其余半透明，均随主题切换
 */
import { cloneElement, Fragment, isValidElement, type ReactNode } from "react";

import { cn } from "@/lib/utils";

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

/** 高亮渲染上下文：counter 跨子树累计全局命中序号（起始 offset-1） */
interface HighlightContext {
  query: string;
  activeIndex: number;
  counter: { value: number };
}

export function createHighlightContext(
  query: string,
  activeIndex: number,
  offset: number,
): HighlightContext {
  return { query, activeIndex, counter: { value: offset - 1 } };
}

/** 命中词渲染：data-hit-index 供定位滚动查询；当前项实底主题色 */
function renderSegments(text: string, ctx: HighlightContext): ReactNode[] {
  return splitByQuery(text, ctx.query).map((segment, index) => {
    if (!segment.hit) {
      return segment.text;
    }
    ctx.counter.value += 1;
    const hitIndex = ctx.counter.value;
    const active = hitIndex === ctx.activeIndex;
    return (
      <mark
        key={index}
        data-hit-index={hitIndex}
        className={cn(
          "rounded-sm px-0.5",
          active
            ? "bg-primary text-primary-foreground"
            : "bg-primary/25 text-foreground",
        )}
      >
        {segment.text}
      </mark>
    );
  });
}

/** 递归高亮：字符串→切分渲染；数组/元素→下钻（结构不变，仅文本替换） */
export function highlightChildren(
  node: ReactNode,
  ctx: HighlightContext,
): ReactNode {
  if (typeof node === "string") {
    return renderSegments(node, ctx);
  }
  if (typeof node === "number") {
    return renderSegments(String(node), ctx);
  }
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <Fragment key={index}>{highlightChildren(child, ctx)}</Fragment>
    ));
  }
  if (isValidElement(node)) {
    return cloneElement(
      node,
      undefined,
      highlightChildren((node.props as { children?: ReactNode }).children, ctx),
    );
  }
  return node;
}
