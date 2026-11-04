/**
 * mermaid 图表块：```mermaid 围栏渲染成 SVG 图形（MarkdownView pre 层分流）。
 * mermaid 懒加载（动态 import 单独分包，首次遇到才拉取）；渲染失败（模型
 * 语法错误）降级普通代码块显示源码（复制源码仍可用，不炸消息流）；
 * 明暗切换跟随 data-mode 重渲染（mermaid 主题非 CSS 变量可切）。
 * 操作条：复制（SVG→PNG 入剪贴板）/ 下载（另存为 PNG，file:saveDataUrl）。
 * 展示保持 mermaid 原生自适应（svg width=100% + 内联 max-width），超复杂
 * 图表看全貌走下载 PNG（viewBox 原始尺寸 2x 导出）。
 */
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, Download } from "lucide-react";

import { invoke } from "@/lib/ipc";
import { copyImageToClipboard } from "@/lib/data-url";
import { mapIpcError } from "../lib/error-message";
import { useColorMode } from "../hooks/use-color-mode";
import { svgToPngDataUrl } from "../lib/mermaid-export";
import CodeBlock from "./CodeBlock";

/** 渲染实例 id 序号（mermaid 内部按 id 挂载临时节点，重复 id 会串图） */
let renderSeq = 0;

async function renderMermaidSvg(code: string, dark: boolean): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    // strict（默认）：labels 转义，配合 react-markdown 不配 rehype-raw 的
    // XSS 收敛口径
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
  });
  const id = `mermaid-block-${Date.now().toString(36)}-${renderSeq++}`;
  const { svg } = await mermaid.render(id, code);
  return svg;
}

function MermaidBlockImpl({ code }: { code: string }) {
  const { t } = useTranslation(["chat"]);
  const dark = useColorMode() === "dark";
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    setSvg(null);
    renderMermaidSvg(code, dark)
      .then((result) => {
        if (alive) {
          setSvg(result);
        }
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [code, dark]);

  // 失败降级：普通代码块显示源码（模型语法错误可见原文，可复制修正）
  if (failed) {
    return <CodeBlock code={code} lang="mermaid" />;
  }

  /** SVG→PNG：两条操作共用；渲染中（svg 未就绪）为不动作静默忽略 */
  const exportPng = (): Promise<string | null> =>
    svg ? svgToPngDataUrl(svg, dark) : Promise.resolve(null);

  const copyImage = async () => {
    try {
      const dataUrl = await exportPng();
      if (!dataUrl) {
        return;
      }
      await copyImageToClipboard(dataUrl);
      toast.success(t("chat:codeBlock.imageCopied"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const downloadPng = async () => {
    try {
      const dataUrl = await exportPng();
      if (!dataUrl) {
        return;
      }
      const saved = await invoke<string | null>(
        "file:saveDataUrl",
        dataUrl,
        t("chat:codeBlock.mermaidFileName"),
      );
      if (saved) {
        toast.success(t("chat:artifacts.exportSuccess"));
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const actionBtn =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/50">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/40 py-0.5 pl-3 pr-1">
        <span className="text-[11px] leading-5 text-muted-foreground select-none">
          mermaid
        </span>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => void copyImage()}
            aria-label={t("chat:codeBlock.copyImage")}
            title={t("chat:codeBlock.copyImage")}
            className={actionBtn}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void downloadPng()}
            aria-label={t("chat:codeBlock.downloadImage")}
            title={t("chat:codeBlock.downloadImage")}
            className={actionBtn}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto bg-muted/50 p-3">
        {svg ? (
          // mermaid strict 模式输出：labels 已转义，无脚本注入面
          <div
            className="w-fit min-w-full [&_svg]:block"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <p className="text-xs text-muted-foreground">…</p>
        )}
      </div>
    </div>
  );
}

export default memo(MermaidBlockImpl);
