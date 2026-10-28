/**
 * CM6 语言映射（T24，spec §14 项 1）：文件扩展名 → 语言扩展懒加载
 * （dynamic import → Vite 自动分包，未用语言不进主 chunk）；text 无语言
 * 扩展。workspace 资源按 resource.path 判定；library 条目无路径，同口径
 * 按条目文件名扩展判定。
 */
import type { Extension } from "@codemirror/state";

export type CmLanguage =
  "markdown" | "json" | "html" | "css" | "javascript" | "python" | "text";

const LANG_EXT: Record<Exclude<CmLanguage, "text">, RegExp> = {
  markdown: /\.(md|markdown)$/i,
  json: /\.json$/i,
  html: /\.(html?|vue)$/i,
  css: /\.(css|scss)$/i,
  javascript: /\.(m?[jt]sx?)$/i,
  python: /\.py$/i,
};

/** 扩展名 → 语言（未收录回落 text 可编辑）；参数为文件名或含目录的路径 */
export function cmLanguageOfPath(path: string): CmLanguage {
  const name = path.split(/[\\/]/).pop() ?? path;
  for (const [lang, ext] of Object.entries(LANG_EXT)) {
    if (ext.test(name)) return lang as CmLanguage;
  }
  return "text";
}

/** 语言扩展懒加载（text 返回 null——挂无语言视图） */
export async function loadCmLanguage(
  lang: CmLanguage,
): Promise<Extension | null> {
  switch (lang) {
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "javascript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript();
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    default:
      return null;
  }
}
