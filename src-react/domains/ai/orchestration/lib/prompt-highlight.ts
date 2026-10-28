// src-react/domains/ai/orchestration/lib/prompt-highlight.ts
/**
 * 提示词/脚本高亮分段（纯函数）：变量表达式（与 graph-prompt.ts 的
 * VAR_RE 保持同步——只高亮运行期会被替换的合法占位符，模板替换是
 * 文本级，字符串/注释内同样生效照常高亮）+ bash/python/nodejs 简易
 * tokenizer（关键字/字符串/注释/数字，够用零依赖；非完整语法分析，
 * 未闭合字符串宽匹配）。分段为相邻不重叠切片，渲染层直接 span 串联。
 */

/** 高亮分段种类：plain 之外的每个 kind 对应一个着色类 */
export type HighlightKind =
  "plain" | "variable" | "keyword" | "string" | "comment" | "number";

export interface HighlightSegment {
  text: string;
  kind: HighlightKind;
}

export type CodeLanguage = "bash" | "python" | "nodejs";
/** prompt 语言：仅变量表达式高亮，不做代码着色 */
export type HighlightLanguage = CodeLanguage | "prompt";

/** 变量占位符（合法集合才高亮：input.x / nodes.<id>.output / 日期时间） */
const VARIABLE_RE =
  /\{\{(input\.[A-Za-z0-9_]+|nodes\.[a-z0-9-]+\.output|date|weekday|time)\}\}/g;

const KEYWORDS: Record<CodeLanguage, Set<string>> = {
  bash: new Set(
    (
      "if then else elif fi for while until do done case esac in function select " +
      "time coproc local export readonly declare return exit break continue echo printf read cd"
    ).split(" "),
  ),
  python: new Set(
    (
      "def if elif else for while return import from as class pass with try except " +
      "finally raise lambda yield global nonlocal assert del in is not and or True False None print"
    ).split(" "),
  ),
  nodejs: new Set(
    (
      "const let var function return if else for while do switch case break continue " +
      "import export from as default async await class extends new typeof instanceof try catch " +
      "finally throw this super null undefined true false of in delete void yield"
    ).split(" "),
  ),
};

/** 行注释前缀（多行块注释不做：python """ 属字符串、js 块注释从简并 //） */
const LINE_COMMENT: Record<CodeLanguage, string> = {
  bash: "#",
  python: "#",
  nodejs: "//",
};

export function highlightSegments(
  text: string,
  language: HighlightLanguage,
): HighlightSegment[] {
  if (text === "") {
    return [];
  }
  if (language === "prompt") {
    return splitByVariable(text, "plain");
  }
  return tokenize(text, language);
}

/** 提示词路径：仅按合法变量占位符切分，其余全部 base（plain） */
function splitByVariable(
  text: string,
  base: HighlightKind,
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  VARIABLE_RE.lastIndex = 0;
  for (const matched of text.matchAll(VARIABLE_RE)) {
    const at = matched.index;
    if (at > cursor) {
      segments.push({ text: text.slice(cursor, at), kind: base });
    }
    segments.push({ text: matched[0], kind: "variable" });
    cursor = at + matched[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), kind: base });
  }
  return segments;
}

function tokenize(text: string, language: CodeLanguage): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const push = (piece: string, kind: HighlightKind) => {
    if (piece !== "") {
      // 字符串/注释内变量运行期同样替换，嵌套拆分保持 variable 高亮
      segments.push(
        ...(kind === "string" || kind === "comment"
          ? splitByVariable(piece, kind)
          : [{ text: piece, kind }]),
      );
    }
  };
  // plain 贪心停顿字符：引号 + 注释首字符 + $ 数字 字母 _ {
  const pauses = new Set([
    "'",
    '"',
    "`",
    "$",
    "_",
    "{",
    ...LINE_COMMENT[language],
  ]);
  const isPause = (ch: string) => pauses.has(ch) || /[0-9A-Za-z]/.test(ch);
  const keywords = KEYWORDS[language];
  const commentPrefix = LINE_COMMENT[language];
  let cursor = 0;

  while (cursor < text.length) {
    // 变量优先（模板替换是文本级，先于注释/字符串判定）
    VARIABLE_RE.lastIndex = cursor;
    const variable = VARIABLE_RE.exec(text);
    if (variable && variable.index === cursor) {
      push(variable[0], "variable");
      cursor += variable[0].length;
      continue;
    }
    if (text.startsWith(commentPrefix, cursor)) {
      const lineEnd = text.indexOf("\n", cursor);
      const end = lineEnd === -1 ? text.length : lineEnd;
      push(text.slice(cursor, end), "comment");
      cursor = end;
      continue;
    }
    const quote = ["'", '"', "`"].find((q) => text[cursor] === q);
    if (quote) {
      const end = matchStringEnd(text, cursor, quote);
      push(text.slice(cursor, end), "string");
      cursor = end;
      continue;
    }
    if (/[0-9]/.test(text[cursor])) {
      let end = cursor + 1;
      while (end < text.length && /[0-9a-fA-FxX._]/.test(text[end])) {
        end += 1;
      }
      push(text.slice(cursor, end), "number");
      cursor = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(text[cursor])) {
      let end = cursor + 1;
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) {
        end += 1;
      }
      const word = text.slice(cursor, end);
      segments.push({
        text: word,
        kind: keywords.has(word) ? "keyword" : "plain",
      });
      cursor = end;
      continue;
    }
    let end = cursor + 1;
    while (end < text.length && !isPause(text[end])) {
      end += 1;
    }
    push(text.slice(cursor, end), "plain");
    cursor = end;
  }
  return segments;
}

/** 从 start（引号位置）找闭合引号（无闭合吞到串尾）；跳过反斜杠转义 */
function matchStringEnd(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) {
      return i + 1;
    }
    if (text[i] === "\n" && quote !== "`") {
      // 未闭合跨行：单双引号不允许裸换行——截到行尾按字符串宽匹配
      return i;
    }
  }
  return text.length;
}
