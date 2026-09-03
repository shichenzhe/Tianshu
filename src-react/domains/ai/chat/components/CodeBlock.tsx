/**
 * 代码块：shiki 双主题高亮（懒加载，语言按需注册）
 *
 * shiki 4.x API 说明（已核对 node_modules 类型定义）：
 * - createHighlighter 的 langs 默认 []，后续语言用 highlighter.loadLanguage() 补充注册
 * - loadLanguage 参数类型不含裸 string，运行时先经 bundledLanguages 判存在再收窄调用
 * - codeToHtml({ themes: { light, dark } }) 为双主题形态：light 内联生效，dark 写入
 *   --shiki-dark CSS 变量（本项目无暗色模式，dark 变量暂不消费，保留供未来切换）
 */
import { memo, useEffect, useState } from "react";
import type { BundledLanguage, Highlighter } from "shiki";

// shiki 特殊语言（纯文本/ansi）无语法注册需求
const SPECIAL_LANGS = new Set(["text", "plaintext", "txt", "plain", "ansi"]);

// 模块级单例：highlighter 创建一次，语言增量注册
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

/**
 * 获取共享 highlighter，并确保目标语言已注册。
 * 未知语言或初始化失败返回 null（回退纯文本渲染）；失败不缓存 rejection，下次可重试。
 */
async function getHighlighter(lang: string): Promise<Highlighter | null> {
  try {
    const { createHighlighter, bundledLanguages } = await import("shiki");
    highlighterPromise ??= createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    });
    const highlighter = await highlighterPromise;
    if (!loadedLangs.has(lang)) {
      if (lang in bundledLanguages) {
        await highlighter.loadLanguage(lang as BundledLanguage);
        loadedLangs.add(lang);
      } else if (!SPECIAL_LANGS.has(lang)) {
        return null;
      }
    }
    return highlighter;
  } catch (e) {
    highlighterPromise = null;
    throw e;
  }
}

/**
 * 高亮为 HTML；无法高亮（未知语言/初始化失败）返回 null
 */
async function highlight(code: string, lang: string): Promise<string | null> {
  const highlighter = await getHighlighter(lang);
  if (!highlighter) {
    return null;
  }
  return highlighter.codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
  });
}

function CodeBlockImpl({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let alive = true;
    const safeLang = /^[a-z0-9-]+$/i.test(lang) ? lang.toLowerCase() : "text";
    highlight(code, safeLang)
      .then((result) => {
        if (alive) {
          setHtml(result ?? "");
        }
      })
      .catch(() => {
        /* 高亮失败保持纯文本 */
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  return (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border/50 bg-muted/50 p-3 text-xs [&>div>pre]:m-0 [&>div>pre]:p-0">
      {html ? (
        // shiki 输出为转义后的高亮 HTML，输入先经 react-markdown 转义链，无原始 HTML 注入面
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="whitespace-pre-wrap break-words">{code}</code>
      )}
    </pre>
  );
}

export default memo(CodeBlockImpl);
