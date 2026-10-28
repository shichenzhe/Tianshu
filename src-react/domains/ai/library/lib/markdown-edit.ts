/**
 * Markdown 编辑器文本变换纯函数（单测覆盖）：包裹 toggle（加粗/斜体/
 * 删除线/行内代码）、行首前缀 toggle（引用/列表）、标题级别切换、片段
 * 插入（链接/围栏代码/表格/分隔线）、Enter 列表续行、Tab 缩进。
 * 统一返回 { text, selection }——调用方 setState 后恢复光标选区。
 */

/** 编辑变换结果：新文本 + 完成后的光标选区 [start, end]（end=start 纯光标） */
export interface TextEditResult {
  text: string;
  selection: [number, number];
}

/** 光标/选区涉及的行区间（选区跨行时含首尾整行） */
function lineBoundsOf(
  text: string,
  start: number,
  end: number,
): [number, number] {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) {
    lineEnd = text.length;
  }
  return [lineStart, lineEnd];
}

/** 包裹 toggle：选区两侧恰为 marker 则去包裹，否则包裹（无选中插占位
 *  文本并选中占位）；加粗 `**` / 斜体 `*` / 删除线 `~~` / 行内代码 `` ` `` */
export function toggleWrap(
  text: string,
  start: number,
  end: number,
  marker: string,
  placeholder: string,
): TextEditResult {
  const sel = text.slice(start, end);
  if (
    sel !== "" &&
    text.slice(0, start).endsWith(marker) &&
    text.slice(end).startsWith(marker)
  ) {
    return {
      text:
        text.slice(0, start - marker.length) +
        sel +
        text.slice(end + marker.length),
      selection: [start - marker.length, end - marker.length],
    };
  }
  const inner = sel || placeholder;
  const innerStart = start + marker.length;
  return {
    text: text.slice(0, start) + marker + inner + marker + text.slice(end),
    selection: [innerStart, innerStart + inner.length],
  };
}

/** 行首前缀批量 toggle：涉及行已全部带 prefix 则全删，否则全加；
 *  prefixMaker 按行序号定制（有序列表 1. 2. 3. …）。完成后选中整批行 */
export function toggleLinePrefix(
  text: string,
  start: number,
  end: number,
  prefix: string | ((row: number) => string),
): TextEditResult {
  const [lineStart, lineEnd] = lineBoundsOf(text, start, end);
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const prefixOf = (row: number) =>
    typeof prefix === "string" ? prefix : prefix(row);
  const hasAll = lines.every((line) =>
    line.startsWith(typeof prefix === "string" ? prefix : ""),
  );
  // 有序前缀（函数式）时统一按「行首是否存在数字. 」判定删除
  const removeMode =
    typeof prefix === "string"
      ? hasAll
      : lines.every((line) => /^\s*\d+\.\s/.test(line));
  const mapped = removeMode
    ? lines.map((line) =>
        typeof prefix === "string"
          ? line.slice(prefix.length)
          : line.replace(/^(\s*)\d+\.\s/, "$1"),
      )
    : lines.map((line, row) => `${prefixOf(row)}${line}`);
  const next = [
    text.slice(0, lineStart),
    mapped.join("\n"),
    text.slice(lineEnd),
  ].join("");
  return {
    text: next,
    selection: [lineStart, lineStart + mapped.join("\n").length],
  };
}

/** 标题级别切换：涉及行已全为该级则降级移除，否则剥任意既有级别后升级 */
export function toggleHeading(
  text: string,
  start: number,
  end: number,
  level: 1 | 2 | 3,
): TextEditResult {
  const [lineStart, lineEnd] = lineBoundsOf(text, start, end);
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const marker = `${"#".repeat(level)} `;
  const allThisLevel = lines.every((line) => line.startsWith(marker));
  const mapped = lines.map((line) => {
    const stripped = line.replace(/^#{1,6}\s*/, "");
    return allThisLevel ? stripped : marker + stripped;
  });
  const body = mapped.join("\n");
  const next = `${text.slice(0, lineStart)}${body}${text.slice(lineEnd)}`;
  return { text: next, selection: [lineStart, lineStart + body.length] };
}

/** 片段插入：以 snippet 替换选区，selInSnippet 为完成后选区相对片段
 *  起点的偏移区间 */
export function insertSnippet(
  text: string,
  start: number,
  end: number,
  snippet: string,
  selInSnippet: [number, number],
): TextEditResult {
  const next = `${text.slice(0, start)}${snippet}${text.slice(end)}`;
  return {
    text: next,
    selection: [start + selInSnippet[0], start + selInSnippet[1]],
  };
}

/** 光标处插入独立成行片段（围栏代码/表格/分隔线）：按上下文补前后
 *  换行（block 已以换行结尾则不再补尾——防双空行）；selInBlock 相对
 *  片段体首字符 */
export function insertBlock(
  text: string,
  caret: number,
  block: string,
  selInBlock: [number, number],
): TextEditResult {
  const prefix = caret > 0 && text[caret - 1] !== "\n" ? "\n" : "";
  const suffix =
    caret < text.length && text[caret] !== "\n" && !block.endsWith("\n")
      ? "\n"
      : "";
  const snippet = `${prefix}${block}${suffix}`;
  const snippetStart = caret + prefix.length;
  return {
    text: `${text.slice(0, caret)}${snippet}${text.slice(caret)}`,
    selection: [snippetStart + selInBlock[0], snippetStart + selInBlock[1]],
  };
}

/** 链接：选中文字作链接文本（无选中用占位），光标选中新插的 url 占位 */
export function insertLink(
  text: string,
  start: number,
  end: number,
): TextEditResult {
  const label = text.slice(start, end) || "链接";
  const snippet = `[${label}](url)`;
  const labelStart = start;
  const urlStart = labelStart + label.length + 3;
  return insertSnippet(text, start, end, snippet, [
    urlStart - start,
    urlStart - start + "url".length,
  ]);
}

/** 围栏代码块：空体光标停围栏内首行 */
export function insertCodeBlock(text: string, caret: number): TextEditResult {
  return insertBlock(text, caret, "```\n\n```", [4, 4]);
}

/** 3×2 表格模板：光标停首列表头 */
export function insertTable(text: string, caret: number): TextEditResult {
  const table = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |";
  return insertBlock(text, caret, table, [2, 4]);
}

/** 分隔线：光标停下一行行首 */
export function insertHr(text: string, caret: number): TextEditResult {
  return insertBlock(text, caret, "---\n", [4, 4]);
}

/** 行首列表/引用标记匹配：捕获 缩进、标记原文（有序含点）、内容 */
const LIST_RE = /^(\s*)(?:([-*+])|(\d+\.))(\s+)(.*)$/;
const QUOTE_RE = /^(\s*)>( ?)(.*)$/;

/**
 * Enter 列表/引用续行（返回 null=非列表语境走默认回车）：
 * - 空项（光标停标记后且行尾无内容）→ 删除行首标记退出
 * - 否则 → 换行后续同缩进同标记（有序序号 +1），光标后内容随之带下
 */
export function continueList(
  text: string,
  caret: number,
): TextEditResult | null {
  const lineEnd =
    text.indexOf("\n", caret) === -1 ? text.length : text.indexOf("\n", caret);
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, lineEnd);

  /** 空项退出：清标记整行只留缩进；非空 → 在 caret 处换行续标记 */
  const apply = (
    prefixLen: number,
    content: string,
    insert: string,
  ): TextEditResult => {
    const prefixEnd = lineStart + prefixLen;
    if (caret === prefixEnd && caret === lineEnd && content === "") {
      const indent = line.slice(0, prefixLen).replace(/\S.*$/, "");
      const keep = lineStart + indent.length;
      const next = `${text.slice(0, lineStart)}${indent}${text.slice(lineEnd)}`;
      return { text: next, selection: [keep, keep] };
    }
    return {
      text: `${text.slice(0, caret)}${insert}${text.slice(caret)}`,
      selection: [caret + insert.length, caret + insert.length],
    };
  };

  const listMatch = LIST_RE.exec(line);
  if (listMatch) {
    const [, indent, bullet, ordered, , content] = listMatch;
    const prefixLen = indent.length + (ordered ?? bullet).length + 1;
    const marker = ordered ? `${Number(ordered) + 1}.` : bullet;
    return apply(prefixLen, content, `\n${indent}${marker} `);
  }
  const quoteMatch = QUOTE_RE.exec(line);
  if (quoteMatch) {
    const [, indent, , content] = quoteMatch;
    // 续行统一规范「> 」（标记后带空格）
    return apply(
      indent.length + quoteMatch[2].length + 1,
      content,
      `\n${indent}> `,
    );
  }
  return null;
}

/** Tab/Shift+Tab：跨行选区逐行行首 ±2 空格；单点 Tab 于光标处插 2 空格 */
export function indentSelection(
  text: string,
  start: number,
  end: number,
  outdent: boolean,
): TextEditResult {
  if (!outdent && (start === end || !text.slice(start, end).includes("\n"))) {
    // 单点 Tab：光标处直接插两个空格
    return {
      text: `${text.slice(0, start)}  ${text.slice(start)}`,
      selection: [start + 2, start + 2],
    };
  }
  const [lineStart, lineEnd] = lineBoundsOf(text, start, end);
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const mapped = lines.map((line) =>
    outdent ? line.replace(/^ {1,2}/, "") : `  ${line}`,
  );
  const body = mapped.join("\n");
  return {
    text: `${text.slice(0, lineStart)}${body}${text.slice(lineEnd)}`,
    selection: [lineStart, lineStart + body.length],
  };
}
