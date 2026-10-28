import type { MessageBlock, TextBlock } from "./blocks";
import { splitFileRefPrefix } from "./file-refs";

/**
 * 会话内消息搜索纯逻辑（体验精修批升级为位置级）：规则与桌面一致
 * （src-react MessageList.searchableText + search-highlight splitByQuery）——
 * 仅 text blocks `\n` 拼接后剔除文件引用前缀段（引用段已拆出渲染卡片，
 * 命中无落点；技能前缀桌面也不剔除，保持原样）、大小写不敏感、非重叠
 * 匹配、排除 system 消息。防抖在组件层（300ms）。
 *
 * 位置级语义（桌面 <mark data-hit-index> 的 RN 等价）：每条命中给出
 * 消息索引 + text 块下标 + 块内偏移——跨块命中按块内各给位置（块间
 * `\n` 分隔，命中永不跨块）；导航逐位循环，计数=位置数。
 */

/** 可搜索消息的最小结构（stream.store ChatMessage 结构子集——logic 层
 *  不反向依赖 store；调用方传 history 全量即可） */
export interface SearchableMessage {
  role: string;
  blocks: MessageBlock[];
}

/** 消息的可搜索文本：text 块 \n 拼接 + 剔除头部文件引用前缀段 */
export function searchableMessageText(message: SearchableMessage): string {
  const joined = message.blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return splitFileRefPrefix(joined).rest;
}

/** 单文本内命中次数：大小写不敏感、非重叠（桌面 countHits 同口径——
 *  每次命中后按关键字长度跳过，重叠部分不计）；空关键字为 0 */
export function countKeywordHits(text: string, keyword: string): number {
  if (!keyword) {
    return 0;
  }
  const lowerKeyword = keyword.toLowerCase();
  let count = 0;
  let rest = text;
  while (rest !== "") {
    const index = rest.toLowerCase().indexOf(lowerKeyword);
    if (index === -1) {
      break;
    }
    count += 1;
    rest = rest.slice(index + keyword.length);
  }
  return count;
}

/** 单文本内命中区间（start 为 text 内偏移、length=关键字长度；
 *  大小写不敏感、非重叠——与 countKeywordHits 同口径扫描） */
export function findKeywordRanges(
  text: string,
  keyword: string,
): Array<{ start: number; length: number }> {
  if (!keyword) {
    return [];
  }
  const lowerKeyword = keyword.toLowerCase();
  const ranges: Array<{ start: number; length: number }> = [];
  let consumed = 0;
  let rest = text;
  while (rest !== "") {
    const index = rest.toLowerCase().indexOf(lowerKeyword);
    if (index === -1) {
      break;
    }
    ranges.push({ start: consumed + index, length: keyword.length });
    consumed += index + keyword.length;
    rest = rest.slice(index + keyword.length);
  }
  return ranges;
}

/** 位置级命中项：messageIdx（history 时序序）+ blockIdx（text 块在
 *  message.blocks 中的下标）+ 块内偏移区间 */
export interface MessageSearchHit {
  messageIdx: number;
  blockIdx?: number;
  start: number;
  length: number;
}

/**
 * 会话内搜索（位置级）：返回全部命中位置（history 时序序、同消息按
 * 块序/偏移序）。规则：空/纯空白关键字返回 []；system 消息排除；
 * 头部文件引用前缀段剔除（段内命中无落点）；一条消息多次命中各计一位。
 */
export function searchMessagePositions(
  messages: SearchableMessage[],
  keyword: string,
): MessageSearchHit[] {
  const query = keyword.trim();
  if (query === "") {
    return [];
  }
  const hits: MessageSearchHit[] = [];
  messages.forEach((message, messageIdx) => {
    if (message.role === "system") {
      return;
    }
    // text 块 \n 拼接（与 searchableMessageText 同口径）+ 块跨度表
    const textBlocks: Array<{ blockIdx: number; text: string }> = [];
    message.blocks.forEach((block, blockIdx) => {
      if (block.type === "text") {
        textBlocks.push({ blockIdx, text: block.text });
      }
    });
    const joined = textBlocks.map((t) => t.text).join("\n");
    let offset = 0;
    const spans = textBlocks.map((t) => {
      const span = {
        blockIdx: t.blockIdx,
        start: offset,
        length: t.text.length,
      };
      offset += t.text.length + 1; // + 块间 "\n"
      return span;
    });
    // 剔除头部引用前缀段（前缀按空行整段切——rest 恒为 joined 后缀，
    // 前缀长度 = 拼接串长度差）
    const { rest } = splitFileRefPrefix(joined);
    const prefixLength = joined.length - rest.length;
    for (const range of findKeywordRanges(rest, query)) {
      const globalStart = range.start + prefixLength;
      const span = spans.find(
        (s) =>
          globalStart >= s.start &&
          globalStart + range.length <= s.start + s.length,
      );
      // 命中不跨块（块间 \n 分隔）且前缀按段切——理论上必命中某跨度；
      // 防御：不可映射即丢弃
      if (!span) {
        continue;
      }
      hits.push({
        messageIdx,
        blockIdx: span.blockIdx,
        start: globalStart - span.start,
        length: range.length,
      });
    }
  });
  return hits;
}

/** 命中导航（上/下逐位循环）：total<=0 恒 0；否则 (current+delta) 取模
 *  环绕——桌面 session-search store navigate 同语义，抽纯函数钉测试 */
export function nextHitPosition(
  current: number,
  total: number,
  delta: 1 | -1,
): number {
  if (total <= 0) {
    return 0;
  }
  return (current + delta + total) % total;
}
