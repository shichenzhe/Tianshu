/**
 * 搜索态 hast 变换（markdown 源位置追踪批）：按块内源偏移命中区间
 * 切分 hast 文本节点，命中段包 <mark data-hit-index>（当前实底主题色、
 * 余半透明，与旧 highlightChildren 视觉一致）。映射经 spike 验证的
 * position.start/end.offset 通道；围栏内 text 节点无 position 天然
 * 不切分（命中已在纯函数层剔除出集合）。
 *
 * data-hit-index 全局序由调用方按块序编排（hitBase + 序数），
 * MessageList 的 scrollIntoView 选择器口径不变。
 */
import { visit, SKIP } from "unist-util-visit";
import type { Element, Root, Text } from "hast";

import { textValueBase, type HitRange } from "./hit-positions";

export interface SearchMarkOptions {
  /** 块 markdown 源文本（行内代码值区段对齐用，与纯函数同口径） */
  source: string;
  /** 块内源偏移命中区间（升序、互不重叠——纯函数产出口径） */
  ranges: HitRange[];
  /** 该块首个命中的全局序号（data-hit-index 编排基） */
  baseIndex: number;
  /** 当前导航位（实底高亮） */
  activeIndex: number;
}

/** 命中词 mark 样式：与旧 search-highlight 渲染逐字一致 */
const MARK_BASE = "rounded-sm px-0.5";
const MARK_ACTIVE = "bg-primary text-primary-foreground";
const MARK_INACTIVE = "bg-primary/25 text-foreground";

/**
 * rehype 插件：unified .use(rehypeSearchMarks, options)。对带 position
 * 的文本节点，取完整落于其值区段（valueBase 口径，与纯函数一致）内的
 * 命中区间，按渲染文本切片包 mark；围栏内 text 节点无 position 天然
 * 不切分（命中已在纯函数层剔除出集合）。
 */
export function rehypeSearchMarks(options: SearchMarkOptions) {
  return (tree: Root) => {
    const { source, ranges, baseIndex, activeIndex } = options;
    if (ranges.length === 0) {
      return;
    }
    // 全局序号编排器：文本节点按文档序访问，命中区间升序——序数自增即块内序
    let counter = baseIndex - 1;
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || parent.type !== "element" || !node.position) {
        return undefined;
      }
      const spanStart = node.position.start.offset as number;
      const spanEnd = node.position.end.offset as number;
      const value = node.value;
      // 与纯函数同一 valueBase 口径（行内代码跳过定界符；不可对齐节点不切分）
      const valueBase = textValueBase(
        source,
        spanStart,
        spanEnd,
        value,
        parent.tagName === "code",
      );
      if (valueBase < 0) {
        return undefined;
      }
      const local = ranges.filter(
        (range) =>
          range.start >= valueBase &&
          range.start + range.length <= valueBase + value.length,
      );
      if (local.length === 0) {
        return undefined;
      }
      const parts: Array<Text | Element> = [];
      let cursor = 0;
      for (const range of local) {
        const valueStart = Math.min(
          Math.max(range.start - valueBase, 0),
          value.length,
        );
        const valueEnd = Math.min(
          Math.max(range.start + range.length - valueBase, valueStart),
          value.length,
        );
        if (valueStart > cursor) {
          parts.push({ type: "text", value: value.slice(cursor, valueStart) });
        }
        if (valueEnd > valueStart) {
          counter += 1;
          const hitIndex = counter;
          parts.push({
            type: "element",
            tagName: "mark",
            properties: {
              dataHitIndex: String(hitIndex),
              className: [
                MARK_BASE,
                hitIndex === activeIndex ? MARK_ACTIVE : MARK_INACTIVE,
              ],
            },
            children: [
              { type: "text", value: value.slice(valueStart, valueEnd) },
            ],
          });
        }
        cursor = valueEnd;
      }
      if (cursor < value.length) {
        parts.push({ type: "text", value: value.slice(cursor) });
      }
      parent.children.splice(
        index as number,
        1,
        ...(parts as (typeof parent.children)[number][]),
      );
      // 切出的 mark/text 子节点无需再访问，跳到下一兄弟
      return [SKIP, (index as number) + parts.length];
    });
  };
}
