/**
 * 助手答案的 markdown 渲染组件：
 * - remark-gfm 启用表格/删除线/任务列表等扩展语法（CommonMark 不含表格）
 * - MARKDOWN_COMPONENTS 补齐块级排版——Tailwind preflight 清零了段落/标题/
 *   列表等默认样式，不覆盖则段落挤在一起、列表无圆点、引用无边框
 * - 样式全部走主题变量（border-border/50、bg-muted 等），随主题切换
 * - 会话内搜索（hits 非空）时经 rehypeSearchMarks 插件按源偏移命中区间
 *   切分 hast 文本节点包 mark（position 通道，spike 验证）——计数与
 *   落点同一份位置级集合，围栏代码/Shiki 不高亮（命中已剔除出集合）
 */
import { isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import type { HitRange } from "../lib/hit-positions";
import { rehypeSearchMarks } from "../lib/rehype-search-marks";
import { useTypingReveal } from "../hooks/use-typing-reveal";
import { useSessionSearchStore } from "../../store/session-search.store";
import CodeBlock from "./CodeBlock";
import MermaidBlock from "./MermaidBlock";

/**
 * 递归提取 React 子树中的纯文本（code 元素内容为转义后的源码文本）
 */
function toPlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(toPlainText).join("");
  }
  if (isValidElement(node)) {
    return toPlainText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * react-markdown v9+ 移除了 code 的 inline 属性，围栏代码统一在 pre 层拦截：
 * 提取源码交给 CodeBlock（shiki 高亮，自带 pre），内联代码仍走 code 组件。
 * 不配置 rehype-raw（不渲染原始 HTML，规避 XSS 注入面）。
 */
function createMarkdownComponents(
  /** 流式中（M9）：CodeBlock 降级纯文本，免逐 flush 全量重高亮 */
  streaming = false,
): Components {
  return {
    p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
    h1: ({ children }) => (
      <h1 className="mt-5 mb-2 text-lg font-bold first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-5 mb-2 text-base font-semibold first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>
    ),
    ul: ({ children }) => (
      <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">
        {children}
      </ol>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mt-2 border-l-2 border-primary/30 bg-primary-subtle/50 px-3 py-1.5 first:mt-0">
        {children}
      </blockquote>
    ),
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 transition-base hover:text-primary-hover"
      >
        {children}
      </a>
    ),
    /* 宽表横向滚动而非撑破气泡；容器带外框，末行单元格底边框由 tbody 清理防双线 */
    table: ({ children }) => (
      <div className="mt-3 first:mt-0 overflow-x-auto rounded-md border border-border/50">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border/50 bg-muted/60 px-2.5 py-1.5 text-left font-medium whitespace-nowrap">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-border/30 px-2.5 py-1.5 align-top">
        {children}
      </td>
    ),
    tbody: ({ children }) => (
      <tbody className="[&_tr:last-child_td]:border-b-0">{children}</tbody>
    ),
    hr: () => <hr className="my-4 border-t border-border/60" />,
    img: ({ src, alt }) => (
      <img src={src} alt={alt ?? ""} className="mt-2 max-w-full rounded-md" />
    ),
    pre: ({ children }) => {
      const first = Array.isArray(children) ? children[0] : children;
      if (isValidElement(first)) {
        const { className, children: codeChildren } = first.props as {
          className?: string;
          children?: ReactNode;
        };
        const lang = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
        const code = toPlainText(codeChildren).replace(/\n$/, "");
        // mermaid 围栏 → 图形块（MermaidBlock 自带降级：语法错误回退源码
        // CodeBlock 显示）；流式中仍走 CodeBlock 纯文本——源码渐进可见，
        // 流结束一次性渲染（与 M9 高亮降级同口径）
        if (lang === "mermaid" && !streaming) {
          return <MermaidBlock code={code} />;
        }
        return <CodeBlock code={code} lang={lang} streaming={streaming} />;
      }
      return <pre>{children}</pre>;
    },
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
    ),
  };
}

/** 非搜索态复用同一 components 引用，避免无谓重渲染 */
const PLAIN_COMPONENTS = createMarkdownComponents();
/** 流式态复用同一 components 引用（CodeBlock 纯文本降级） */
const STREAMING_COMPONENTS = createMarkdownComponents(true);

/**
 * markdown 渲染（memo：流式增量重渲染时跳过历史消息的重解析）
 * hits = 该 text 块内源偏移命中区间（位置级集合，纯函数产出）；
 * hitBase = 该块首个命中的全局序号（MessageList 按消息/块序编排下发）
 * streaming = 流式实时气泡（代码块降级纯文本，流结束一次性高亮）
 */
const MarkdownView = memo(function MarkdownView({
  text,
  hits,
  hitBase,
  streaming,
}: {
  text: string;
  hits?: HitRange[];
  hitBase?: number;
  streaming?: boolean;
}) {
  const query = useSessionSearchStore((s) => s.query);
  const activeIndex = useSessionSearchStore((s) => s.activeIndex);
  // 搜索态：rehype 插件按源偏移切分文本节点包 mark（当前实底/余半透明
  // 在插件内按 activeIndex 标注）；计数与落点同一份位置级集合
  const searchPlugins = useMemo<PluggableList>(
    () =>
      query && hits && hits.length > 0
        ? [
            [
              rehypeSearchMarks,
              {
                source: text,
                ranges: hits,
                baseIndex: hitBase ?? 0,
                activeIndex,
              },
            ],
          ]
        : [],
    [query, hits, hitBase, activeIndex, text],
  );
  // 流式吐字平滑（WorkBuddy 经验移植）：网络 chunk 忽快忽慢直蹦观感差，
  // rAF + EMA 每帧平滑吐 1-6 字符；历史消息（streaming=false）零开销直通
  const revealed = useTypingReveal(text, streaming === true);

  return (
    <div className="break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={searchPlugins}
        components={streaming ? STREAMING_COMPONENTS : PLAIN_COMPONENTS}
      >
        {revealed}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownView;
