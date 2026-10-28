/**
 * 代码块：shiki 双主题高亮（懒加载，语言按需注册）
 * getHighlighter：共享（CodeBlock 与 JsonConfigEditor 复用）
 *
 * shiki 4.x API 说明（已核对 node_modules 类型定义）：
 * - createHighlighter 的 langs 默认 []，后续语言用 highlighter.loadLanguage() 补充注册
 * - loadLanguage 参数类型不含裸 string，运行时先经 bundledLanguages 判存在再收窄调用
 * - codeToHtml({ themes: { light, dark } }) 为双主题形态：light 内联生效，dark 写入
 *   --shiki-dark CSS 变量（外观模块起由 skins.css 的 [data-mode=dark] 规则消费切换）
 *
 * 工具条（聊天导出批）：复制接 useCopyText（对勾 1500ms 复位）；下载走
 * Blob+<a> 纯渲染层直接落下载目录（不经主进程——文本无路径安全面）。
 */
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Download } from "lucide-react";
import type { BundledLanguage, Highlighter } from "shiki";

import { downloadBlob } from "@/lib/file-download";
import { useCopyText } from "../hooks/use-copy-text";

// shiki 特殊语言（纯文本/ansi）无语法注册需求
const SPECIAL_LANGS = new Set(["text", "plaintext", "txt", "plain", "ansi"]);

// 模块级单例：highlighter 创建一次，语言增量注册
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

/**
 * 获取共享 highlighter，并确保目标语言已注册。
 * 未知语言或初始化失败返回 null（回退纯文本渲染）；失败不缓存 rejection，下次可重试。
 */
export async function getHighlighter(
  lang: string,
): Promise<Highlighter | null> {
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

function CodeBlockImpl({
  code,
  lang,
  streaming,
}: {
  code: string;
  lang: string;
  /** 流式中（M9）：降级纯文本，流结束由历史消息路径一次性高亮 */
  streaming?: boolean;
}) {
  const { t } = useTranslation(["chat"]);
  const { copied, copyText } = useCopyText();
  const [html, setHtml] = useState("");

  useEffect(() => {
    // M9：流式期间不跑 shiki——每 30ms flush 对整块全量重高亮是
    // O(长度)×约 33 次/秒的浪费，且旧任务不取消会并发堆积
    if (streaming) {
      return;
    }
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
  }, [code, lang, streaming]);

  // 下载文件名扩展：特殊语言/异常值回退 txt（与显示标签同源）
  const ext =
    /^[a-z0-9]+$/i.test(lang) && !SPECIAL_LANGS.has(lang.toLowerCase())
      ? lang.toLowerCase()
      : "txt";
  const download = () =>
    downloadBlob(
      new Blob([code], { type: "text/plain;charset=utf-8" }),
      `code.${ext}`,
    );

  const actionBtn =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/50">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/40 py-0.5 pl-3 pr-1">
        <span className="text-[11px] leading-5 text-muted-foreground select-none">
          {lang}
        </span>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => void copyText(code)}
            aria-label={t("chat:codeBlock.copy")}
            title={t("chat:codeBlock.copy")}
            className={actionBtn}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={download}
            aria-label={t("chat:codeBlock.download")}
            title={t("chat:codeBlock.download")}
            className={actionBtn}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto bg-muted/50 p-3 text-xs [&>div>pre]:m-0 [&>div>pre]:p-0">
        {html ? (
          // shiki 输出为转义后的高亮 HTML，输入先经 react-markdown 转义链，无原始 HTML 注入面
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="whitespace-pre-wrap break-words">{code}</code>
        )}
      </pre>
    </div>
  );
}

export default memo(CodeBlockImpl);
