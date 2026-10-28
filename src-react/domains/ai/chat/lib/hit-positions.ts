/**
 * 位置级命中计算（markdown 源位置追踪批）：
 * 与渲染同一 parser（remark-parse + remark-gfm + remark-rehype）解析
 * 源文本建 hast 源偏移 span 表——候选命中（大小写不敏感、非重叠）须
 * 完整落于「可映射文本节点 span」（围栏 pre 之外、span 长度与文本值
 * 等长）才产出。围栏代码/Shiki/mermaid 源区、链接 URL/图片/纯标记
 * 天然无 hast 文本节点落点，命中即被剔除——计数与可滚动 mark 数
 * 天然一致（验收铁律）。hast 即渲染管线中间态，排除口径与落点零漂移，
 * 优于手写 markdown 状态机（链接/强调/表格边界情况由 parser 裁定）。
 *
 * 围栏内容 text 节点无 position（spike 实证），围栏源区取祖先 pre
 * 元素 span（含 fence 标记行本身）。
 *
 * 语义契约与移动端 message-search.ts 同形：blockIdx 为原始 blocks
 * 数组下标，start/length 为块内原始文本偏移；文件引用前缀段剔除后
 * 偏移换算回原始块坐标。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { visit, SKIP } from "unist-util-visit";
import type { Root } from "hast";

import { splitFileRefPrefix } from "./file-ref-lines";
import { detectPseudoToolCallText } from "./pseudo-tool-call";

/** 源文本内一段命中区间（start 为偏移、length=关键字长度） */
export interface HitRange {
  start: number;
  length: number;
}

/** 位置级命中项：blockIdx（原始 blocks 下标）+ 块内偏移区间 */
export interface BlockHit extends HitRange {
  blockIdx: number;
}

/** hast 可映射文本节点源 span：
 *  - valueBase/valueLength：渲染文本值在源文本中的对应区段（多数节点
 *    即 span 本体；行内代码 text 节点 span 含反引号定界符，值区段自
 *    定界符之后起——两侧统一按 valueBase 换算，保证切片零漂移）；
 *  - valueBase = -1：span 与值不等长且不可对齐（实体/转义/CR 归一化
 *    等），该区段内命中不产出 */
interface TextSpan {
  start: number;
  end: number;
  valueBase: number;
  valueLength: number;
}

interface ParsedSpans {
  textSpans: TextSpan[];
  /** 围栏 pre 元素源区（含 fence 标记行；内容 text 节点无 position，
   *  排除区间以 pre span 为准） */
  preSpans: Array<{ start: number; end: number }>;
}

/** (text, query) → 解析 span 表/命中区间的 memo 缓存上限（防长会话
 *  多消息累积无界增长；超限整体清空，重建成本可接受） */
const CACHE_LIMIT = 300;

/** 单文本的候选命中区间：大小写不敏感、非重叠（与移动端
 *  findKeywordRanges 同口径扫描——每次命中后按关键字长度跳过） */
export function findKeywordRanges(text: string, keyword: string): HitRange[] {
  if (!keyword) {
    return [];
  }
  const lowerKeyword = keyword.toLowerCase();
  const ranges: HitRange[] = [];
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

/** 行内代码 text 节点值区段起点：span 以反引号定界符开头，值本体自定
 *  界符串之后起（定界符串长度 = 前导反引号 run）；切片不符则不可对齐 */
function codeValueBase(
  source: string,
  value: string,
  spanStart: number,
): number {
  let pad = 0;
  while (source[spanStart + pad] === "`") {
    pad += 1;
  }
  const base = spanStart + pad;
  return source.slice(base, base + value.length) === value ? base : -1;
}

/**
 * 文本节点值区段源起点（纯函数与 rehype 插件共用同一口径）：
 * 等长 span 即本体；行内代码（父元素 code）按定界符对齐；其余不等长
 * 构造（实体/转义/CR 归一化）返回 -1——命中落在其中不产出/不切分。
 */
export function textValueBase(
  source: string,
  spanStart: number,
  spanEnd: number,
  value: string,
  parentIsCode: boolean,
): number {
  if (spanEnd - spanStart === value.length) {
    return spanStart;
  }
  if (parentIsCode) {
    return codeValueBase(source, value, spanStart);
  }
  return -1;
}

const spansCache = new Map<string, ParsedSpans>();

/** 解析 markdown 建源偏移 span 表（memo：按文本内容缓存） */
function spansFor(markdown: string): ParsedSpans {
  const cached = spansCache.get(markdown);
  if (cached) {
    return cached;
  }
  if (spansCache.size >= CACHE_LIMIT) {
    spansCache.clear();
  }
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  const textSpans: TextSpan[] = [];
  const preSpans: Array<{ start: number; end: number }> = [];
  visit(tree, (node, _index, parent) => {
    if (node.type === "element" && node.tagName === "pre") {
      if (node.position) {
        preSpans.push({
          start: node.position.start.offset as number,
          end: node.position.end.offset as number,
        });
      }
      return SKIP;
    }
    if (node.type === "text" && node.position) {
      const start = node.position.start.offset as number;
      const end = node.position.end.offset as number;
      const valueBase = textValueBase(
        markdown,
        start,
        end,
        node.value,
        parent?.type === "element" && parent.tagName === "code",
      );
      textSpans.push({ start, end, valueBase, valueLength: node.value.length });
    }
    return undefined;
  });
  const parsed: ParsedSpans = { textSpans, preSpans };
  spansCache.set(markdown, parsed);
  return parsed;
}

const rangesCache = new Map<string, Map<string, HitRange[]>>();

/**
 * 可渲染命中区间：候选命中须完整落于一个等长可映射文本节点 span，
 * 且不与围栏 pre 源区相交——排除项（围栏代码/Shiki/mermaid、链接
 * URL、图片、纯标记、实体/转义内偏移）不产出。memo：按 (text, query)。
 */
export function findRenderableRanges(text: string, query: string): HitRange[] {
  const keyword = query.trim();
  if (!keyword) {
    return [];
  }
  let byQuery = rangesCache.get(text);
  if (byQuery) {
    const hit = byQuery.get(keyword);
    if (hit) {
      return hit;
    }
  } else {
    if (rangesCache.size >= CACHE_LIMIT) {
      rangesCache.clear();
    }
    byQuery = new Map();
    rangesCache.set(text, byQuery);
  }
  const { textSpans, preSpans } = spansFor(text);
  const ranges = findKeywordRanges(text, keyword).filter((range) => {
    const rangeEnd = range.start + range.length;
    if (preSpans.some((p) => range.start < p.end && rangeEnd > p.start)) {
      return false;
    }
    return textSpans.some(
      (span) =>
        span.valueBase >= 0 &&
        range.start >= span.valueBase &&
        rangeEnd <= span.valueBase + span.valueLength,
    );
  });
  byQuery.set(keyword, ranges);
  return ranges;
}

/** 消息的可搜索 text 块（携带原始 blockIdx，供命中换算回块坐标） */
export interface SearchableTextBlock {
  blockIdx: number;
  text: string;
}

/**
 * 消息级位置级命中（history 时序内单条消息）：text 块 `\n` 拼接 +
 * 头部文件引用前缀段剔除（前缀段命中无落点）→ 可渲染区间 → 换算回
 * 原始块坐标；伪工具调用折叠条块命中无落点一并剔除。块间 `\n` 分隔，
 * 命中永不跨块；命中按块序/偏移序产出。
 */
export function searchMessageBlockHits(
  textBlocks: SearchableTextBlock[],
  query: string,
): BlockHit[] {
  const keyword = query.trim();
  if (!keyword || textBlocks.length === 0) {
    return [];
  }
  const joined = textBlocks.map((block) => block.text).join("\n");
  const { rest } = splitFileRefPrefix(joined);
  const prefixLength = joined.length - rest.length;
  // 块跨度表（joined 坐标；块间 "\n" 占 1 字符）
  let offset = 0;
  const spans = textBlocks.map((block) => {
    const span = {
      blockIdx: block.blockIdx,
      start: offset,
      length: block.text.length,
    };
    offset += block.text.length + 1;
    return span;
  });
  // 伪工具调用折叠条（无正文落点）块剔除
  const pseudoBlockIdx = new Set(
    textBlocks
      .filter((block) => detectPseudoToolCallText(block.text))
      .map((block) => block.blockIdx),
  );
  const hits: BlockHit[] = [];
  for (const range of findRenderableRanges(rest, keyword)) {
    const globalStart = range.start + prefixLength;
    const span = spans.find(
      (s) =>
        globalStart >= s.start &&
        globalStart + range.length <= s.start + s.length,
    );
    // 命中不跨块且前缀按段切——理论上必命中某跨度；防御：不可映射即丢弃
    if (!span || pseudoBlockIdx.has(span.blockIdx)) {
      continue;
    }
    hits.push({
      blockIdx: span.blockIdx,
      start: globalStart - span.start,
      length: range.length,
    });
  }
  return hits;
}
