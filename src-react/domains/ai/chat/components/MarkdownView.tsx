/**
 * 助手答案的 markdown 渲染组件：
 * - remark-gfm 启用表格/删除线/任务列表等扩展语法（CommonMark 不含表格）
 * - MARKDOWN_COMPONENTS 补齐块级排版——Tailwind preflight 清零了段落/标题/
 *   列表等默认样式，不覆盖则段落挤在一起、列表无圆点、引用无边框
 * - 样式全部走主题变量（border-border/50、bg-muted 等），随主题切换
 * - 会话内搜索（hitOffset 存在）时各组件 children 套 highlightChildren，
 *   markdown 结构不变、仅文本节点替换为 mark
 */
import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  createHighlightContext,
  highlightChildren,
} from "../lib/search-highlight";
import { useSessionSearchStore } from "../../store/session-search.store";
import CodeBlock from "./CodeBlock";

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
  highlight: ReturnType<typeof createHighlightContext> | null,
): Components {
  /** 命中词包 mark；无搜索时原样透传（children 引用不变） */
  const hl = (children: ReactNode): ReactNode =>
    highlight ? highlightChildren(children, highlight) : children;

  return {
    p: ({ children }) => <p className="mt-2 first:mt-0">{hl(children)}</p>,
    h1: ({ children }) => (
      <h1 className="mt-5 mb-2 text-lg font-bold first:mt-0">{hl(children)}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-5 mb-2 text-base font-semibold first:mt-0">
        {hl(children)}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">
        {hl(children)}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">
        {hl(children)}
      </h4>
    ),
    ul: ({ children }) => (
      <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">
        {hl(children)}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">
        {hl(children)}
      </ol>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mt-2 border-l-2 border-primary/30 bg-primary-subtle/50 px-3 py-1.5 first:mt-0">
        {hl(children)}
      </blockquote>
    ),
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 transition-base hover:text-primary-hover"
      >
        {hl(children)}
      </a>
    ),
    /* 宽表横向滚动而非撑破气泡；容器带外框，末行单元格底边框由 tbody 清理防双线 */
    table: ({ children }) => (
      <div className="mt-3 first:mt-0 overflow-x-auto rounded-md border border-border/50">
        <table className="w-full border-collapse text-xs">{hl(children)}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border/50 bg-muted/60 px-2.5 py-1.5 text-left font-medium whitespace-nowrap">
        {hl(children)}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-border/30 px-2.5 py-1.5 align-top">
        {hl(children)}
      </td>
    ),
    tbody: ({ children }) => (
      <tbody className="[&_tr:last-child_td]:border-b-0">{hl(children)}</tbody>
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
        return (
          <CodeBlock
            code={toPlainText(codeChildren).replace(/\n$/, "")}
            lang={lang}
          />
        );
      }
      return <pre>{children}</pre>;
    },
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 text-xs">
        {hl(children)}
      </code>
    ),
  };
}

/** 非搜索态复用同一 components 引用，避免无谓重渲染 */
const PLAIN_COMPONENTS = createMarkdownComponents(null);

/**
 * markdown 渲染（memo：流式增量重渲染时跳过历史消息的重解析）
 * hitOffset = 该 text 块首个命中的全局序号（MessageList 按消息累计下发）
 */
const MarkdownView = memo(function MarkdownView({
  text,
  hitOffset,
}: {
  text: string;
  hitOffset?: number;
}) {
  const query = useSessionSearchStore((s) => s.query);
  const activeIndex = useSessionSearchStore((s) => s.activeIndex);
  const highlight =
    query && hitOffset !== undefined
      ? createHighlightContext(query, activeIndex, hitOffset)
      : null;

  return (
    <div className="break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={
          highlight ? createMarkdownComponents(highlight) : PLAIN_COMPONENTS
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownView;
