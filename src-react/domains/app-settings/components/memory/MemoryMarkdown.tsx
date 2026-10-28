/**
 * 记忆板块正文 markdown 渲染（修订 B：记忆永远只读）：react-markdown +
 * remark-gfm 均为项目既有依赖，不新增。不复用 chat 域 MarkdownView——其
 * 绑定会话搜索高亮（session-search store）与 shiki 代码块（CodeBlock），
 * 设置页只需轻量排版。组件仅覆盖段落/列表/引用/链接/行内码样式（Tailwind
 * preflight 清零了块级默认样式），全部走主题变量随主题切换；不配置
 * rehype-raw（不渲染原始 HTML，规避 XSS 注入面）。
 */
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const MEMORY_COMPONENTS: Components = {
  p: ({ children }) => <p className="mt-1.5 first:mt-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 first:mt-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 first:mt-0">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-1.5 border-l-2 border-primary/30 bg-primary-subtle/50 px-2 py-1 first:mt-0">
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
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5">{children}</code>
  ),
};

/** 只读正文渲染（memo：指令落库刷新前跳过未变节的重解析） */
const MemoryMarkdown = memo(function MemoryMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <div className="break-words text-xs leading-relaxed text-foreground/80">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MEMORY_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default MemoryMarkdown;
