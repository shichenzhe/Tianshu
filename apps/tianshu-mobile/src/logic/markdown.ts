/**
 * 自写 markdown 子集解析（T14 纯函数，测试先行）：会话流 assistant 文本
 * 渲染用——块级 #/##/### 标题、``` 围栏代码、- 与 1. 列表（嵌套缩进归并
 * 单节点、items 携 indent 层级）、> 引用、--- / *** 水平分隔线、段落；
 * 行内 **bold** / *italic* / `code`（标记不跨行，未闭合按字面文本）。
 * 块级标记判别统一行首缩进容错（先剥空白再匹配；纯缩进普通文本仍入段落），
 * 刻意不引第三方渲染库（Expo 原生环境包体/兼容考量），语法覆盖按
 * 天枢回答高频形态裁剪；链接/表格等暂不支持（T15+ 视需要再扩）。
 */

export type InlineSpan =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type MarkdownNode =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code"; lang: string; code: string }
  | {
      type: "list";
      ordered: boolean;
      items: Array<{ text: string; indent: number }>;
    }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "paragraph"; text: string };

/** 行内标记：按出现顺序取最早匹配（粗体优先于斜体；链接仅认 http(s)
 *  协议——渲染层才谈得上安全打开，mailto: 等按字面），内容不含换行 */
const INLINE_RE =
  /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** 行内解析：未闭合标记按字面文本（不吞星号/反引号） */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      spans.push({ type: "text", text: text.slice(last, idx) });
    }
    if (m[1] !== undefined) {
      spans.push({ type: "bold", text: m[1] });
    } else if (m[2] !== undefined) {
      spans.push({ type: "italic", text: m[2] });
    } else if (m[4] !== undefined) {
      spans.push({ type: "link", text: m[4], href: m[5] ?? "" });
    } else {
      spans.push({ type: "code", text: m[3] ?? "" });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) {
    spans.push({ type: "text", text: text.slice(last) });
  }
  return spans;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^-\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
/** 水平分隔线：整行 trim 后仅由 3+ 个 - 或 * 组成 */
const HR_RE = /^(-{3,}|\*{3,})$/;
/** 行首空白（空格/制表符，宽度按字符数计） */
const INDENT_RE = /^[ \t]*/;
/** 表格分隔行：| --- | :---: | 形态（首尾竖线可省，冒号仅成分不透出） */
const TABLE_SEP_RE = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

/** 表格行：trim 后以 | 开头（严格——行中含 | 不算） */
function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}

/** 表格行是否构成表格开头（当前行 | 开头且下一行为分隔行——GFM：
 *  无分隔行不识别，降级为普通段落文本） */
function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    isTableLine(lines[i]) &&
    TABLE_SEP_RE.test(lines[i + 1].trim())
  );
}

/** 表格行拆单元格：首尾空段丢弃 + 逐格 trim（不支持 \| 转义——子集） */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** 行首缩进剥离：indent = 空白宽度/2 取整（顶层 0），rest 为剥后内容 */
function splitIndent(line: string): { indent: number; rest: string } {
  const width = (line.match(INDENT_RE) ?? [""])[0].length;
  return { indent: Math.floor(width / 2), rest: line.slice(width) };
}

/** 行类型判别（入参为已剥缩进行；围栏内行由外层消费，不进此表） */
function lineKind(rest: string): "ul" | "ol" | "quote" | "plain" {
  if (UL_RE.test(rest)) return "ul";
  if (OL_RE.test(rest)) return "ol";
  if (QUOTE_RE.test(rest)) return "quote";
  return "plain";
}

/** 段落可续行：非空且非任何块级标记行（块级判别同缩进容错口径） */
function isPlainLine(line: string): boolean {
  const { rest } = splitIndent(line);
  return (
    line.trim() !== "" &&
    !rest.startsWith("```") &&
    !HEADING_RE.test(rest) &&
    !HR_RE.test(line.trim()) &&
    lineKind(rest) === "plain"
  );
}

/** 块级解析：行扫描状态机，连续同型行并组（列表缩进不同也并组），空行分块 */
export function parseMarkdown(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const { rest } = splitIndent(lines[i]);
    // 围栏代码：``` 开（尾随语言名），至下一 ``` 行或 EOF（未闭合容错）
    if (rest.startsWith("```")) {
      const lang = rest.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !splitIndent(lines[i]).rest.startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 越过闭合围栏（EOF 时无害 +1）
      nodes.push({ type: "code", lang, code: body.join("\n") });
      continue;
    }
    if (lines[i].trim() === "") {
      i += 1;
      continue;
    }
    if (HR_RE.test(lines[i].trim())) {
      nodes.push({ type: "hr" });
      i += 1;
      continue;
    }
    // 表格：| 开头行 + 下一行为分隔行；表体连续消费 | 开头行，遇空行/
    // 非 | 行截止（单元格存原始串，行内标记渲染层二次解析）
    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const rows: string[][] = [];
      i += 2; // 越过表头与分隔行
      while (i < lines.length && isTableLine(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      nodes.push({ type: "table", headers, rows });
      continue;
    }
    const heading = rest.match(HEADING_RE);
    if (heading) {
      nodes.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trimEnd(),
      });
      i += 1;
      continue;
    }
    const kind = lineKind(rest);
    if (kind === "ul" || kind === "ol") {
      const re = kind === "ul" ? UL_RE : OL_RE;
      const items: Array<{ text: string; indent: number }> = [];
      // 连续同型列表行并组单节点；嵌套层级随行首缩进保留在 indent
      while (i < lines.length) {
        const cur = splitIndent(lines[i]);
        if (lineKind(cur.rest) !== kind) break;
        items.push({ text: (cur.rest.match(re) ?? [])[1] ?? "", indent: cur.indent });
        i += 1;
      }
      nodes.push({ type: "list", ordered: kind === "ol", items });
      continue;
    }
    if (kind === "quote") {
      const body: string[] = [];
      while (i < lines.length) {
        const cur = splitIndent(lines[i]);
        if (lineKind(cur.rest) !== "quote") break;
        body.push((cur.rest.match(QUOTE_RE) ?? [])[1] ?? "");
        i += 1;
      }
      nodes.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    // 段落：连续 plain 行（遇块级标记/空行/围栏/表格开头即止——表格行
    // 若不构成表格开头仍视为普通段落行，保留原文含缩进）
    const body: string[] = [];
    while (
      i < lines.length &&
      isPlainLine(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      body.push(lines[i]);
      i += 1;
    }
    nodes.push({ type: "paragraph", text: body.join("\n") });
  }

  return nodes;
}
