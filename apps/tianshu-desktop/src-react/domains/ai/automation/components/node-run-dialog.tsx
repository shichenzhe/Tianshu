// src-react/domains/ai/automation/components/node-run-dialog.tsx
/**
 * 节点运行详情弹框（spec 2026-11-23 §3，Task 5）：拓扑/步骤视图点击节点
 * 打开的居中大检查器——摘要/输入/输出/工具调用/错误五页（空内容页禁用，
 * failed 默认定位错误页）；全文优先 graphRunNode 完整 input/output——行按
 * runId+nodeId 唯一，仅该节点末次 occurrence 有匹配行，较早 occurrence
 * 回落 trace 预览并显示 occurrence 提示，不冒充末次全文（设计者裁定
 * 2026-11-23）；逐区块复制走 W3C 剪贴板 + sonner toast；底部上一节点/
 * 下一节点/下一失败节点按 trace 顺序导航。节点行查询复用
 * GraphRunTraceView 同款 queryKey（同 run 缓存共享）。受控组件：
 * occurrence === null 不渲染，onClose/onNavigate 回写父层 occurrence 态
 * （Task 6 由 RunSessionView 集成）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, ChevronLeft, ChevronRight, Copy } from "lucide-react";

import type { AutomationRunDetail } from "@tianshu/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageImage } from "@/domains/ai/chat/components/MessageImage";
import type { TraceEntry } from "@/domains/ai/orchestration/components/GraphRunTraceView";
import { GraphApi } from "@/domains/ai/orchestration/api/orchestration.api";
import { RunStatusBadge } from "./RunSelector";
import { formatDateTime, formatDuration } from "../lib/run-display";

type NodeTab = "summary" | "input" | "output" | "tools" | "error";

const TAB_ORDER: NodeTab[] = ["summary", "input", "output", "tools", "error"];

const TAB_KEYS: Record<NodeTab, string> = {
  summary: "chat:runSession.node.tabs.summary",
  input: "chat:runSession.node.tabs.input",
  output: "chat:runSession.node.tabs.output",
  tools: "chat:runSession.node.tabs.tools",
  error: "chat:runSession.node.tabs.error",
};

/** 该 nodeId 在 trace 中最后一次出现的下标是否等于 index（graphRunNode
 * 行按 runId+nodeId 唯一，仅末次 occurrence 有匹配全文行） */
export function isLastOccurrence(trace: TraceEntry[], index: number): boolean {
  const id = trace[index]?.id;
  if (id === undefined) {
    return false;
  }
  for (let i = trace.length - 1; i > index; i -= 1) {
    if (trace[i].id === id) {
      return false;
    }
  }
  return true;
}

/** 同 nodeId 已出现次数（含当前下标）——occurrence 提示序号 */
function occurrenceOrdinal(trace: TraceEntry[], index: number): number {
  const id = trace[index]?.id ?? "";
  let ordinal = 0;
  for (let i = 0; i <= index; i += 1) {
    if (trace[i].id === id) {
      ordinal += 1;
    }
  }
  return ordinal;
}

/** 向后首个 failed occurrence 下标；无则 null（下一失败节点禁用口径） */
function nextFailedIndex(trace: TraceEntry[], from: number): number | null {
  for (let i = from + 1; i < trace.length; i += 1) {
    if (trace[i].status === "failed") {
      return i;
    }
  }
  return null;
}

/** 复制按钮（逐区块）：写 W3C 剪贴板 + toast；写失败由浏览器剪贴板
 * 权限兜底，不阻断浏览 */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation(["chat"]);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    toast.success(t("chat:runSession.node.copySuccess"));
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={copy}
      className="shrink-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
    >
      <Copy className="h-3.5 w-3.5" />
      {t("chat:runSession.node.copy")}
    </Button>
  );
}

/** 全文区块：右上一枚复制按钮 + 等宽全文（弹框内容区独立滚动） */
function TextBlock({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <CopyButton text={text} />
      </div>
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 font-mono text-xs text-foreground">
        {text}
      </pre>
    </div>
  );
}

/** 摘要页：状态徽标 + 开始时间 + 耗时 + tokens（有则显示） */
function SummaryPanel({ entry }: { entry: TraceEntry }) {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <RunStatusBadge status={entry.status} />
      <span className="text-sm text-muted-foreground">
        {formatDateTime(entry.startedAt)}
      </span>
      <span className="text-sm text-muted-foreground">
        {formatDuration(entry.durationMs)}
      </span>
      {entry.tokens && (
        <span className="text-sm text-muted-foreground">
          {t("chat:automation.runs.tokens", {
            in: entry.tokens.promptTokens,
            out: entry.tokens.completionTokens,
          })}
        </span>
      )}
    </div>
  );
}

/** 输出页：图片产物走 MessageImage（替代路径文本），否则全文优先、
 * 无节点行回落 outputPreview */
function OutputPanel({
  entry,
  fullOutput,
}: {
  entry: TraceEntry;
  fullOutput?: string | null;
}) {
  if (entry.outputImage) {
    return <MessageImage imagePath={entry.outputImage} />;
  }
  const text = fullOutput ?? entry.outputPreview;
  return text ? <TextBlock text={text} /> : null;
}

/** 工具页：name + 耗时，ok=false 标红 */
function ToolsPanel({ toolCalls }: { toolCalls: TraceEntry["toolCalls"] }) {
  return (
    <ul className="flex flex-col gap-1">
      {toolCalls?.map((call, index) => (
        <li
          key={`${call.name}-${index}`}
          className={`text-sm ${
            call.ok ? "text-muted-foreground" : "text-destructive"
          }`}
        >
          {call.name} · {formatDuration(call.durationMs)}
        </li>
      ))}
    </ul>
  );
}

/** 错误页：code（+toolName）/message/detail（完整失败全貌）+ 复制 */
function ErrorPanel({ error }: { error: NonNullable<TraceEntry["error"]> }) {
  const heading = `${error.code}${error.toolName ? ` · ${error.toolName}` : ""}`;
  const copyText = [heading, error.message, error.detail]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="flex flex-col gap-2 rounded-md bg-destructive/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-destructive">{heading}</p>
        <CopyButton text={copyText} />
      </div>
      <p className="text-sm text-destructive/80">{error.message}</p>
      {error.detail && (
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-background/60 p-2 font-mono text-xs text-foreground/80">
          {error.detail}
        </pre>
      )}
    </div>
  );
}

export default function NodeRunDialog({
  run,
  trace,
  occurrence,
  onClose,
  onNavigate,
}: {
  run: AutomationRunDetail;
  trace: TraceEntry[];
  /** 当前查看的 occurrence（trace 下标）；null 不渲染 */
  occurrence: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const entry = occurrence !== null ? trace[occurrence] : undefined;
  // 节点行查询：queryKey 与 GraphRunTraceView 相同（同 run 缓存共享），
  // 仅弹框打开时发起
  const { data: nodeRows } = useQuery({
    queryKey: ["orchestration", "runNodes", run.id],
    queryFn: () => GraphApi.runNodes(run.id),
    enabled: occurrence !== null,
    staleTime: Infinity,
  });
  const last =
    occurrence !== null && !!entry && isLastOccurrence(trace, occurrence);
  // 非末次 occurrence 不读节点行（不冒充末次全文，设计者裁定）
  const full = last
    ? nodeRows?.find((row) => row.nodeId === entry?.id)
    : undefined;
  const hasError = entry?.status === "failed" && !!entry.error;
  const tabEnabled: Record<NodeTab, boolean> = {
    summary: true,
    input: !!full?.input,
    output:
      !!entry &&
      (!!entry.outputImage || !!full?.output || !!entry.outputPreview),
    tools: !!entry?.toolCalls?.length,
    error: hasError,
  };
  const defaultTab: NodeTab = hasError ? "error" : "summary";
  // Tab 态按 occurrence 分组（渲染期重置，graph-run-detail viewState 先例）：
  // 导航到另一 occurrence 回落该条目默认页（failed → 错误页）
  const [tabState, setTabState] = useState<{
    occurrence: number | null;
    tab: NodeTab;
  }>({ occurrence: null, tab: "summary" });
  if (tabState.occurrence !== occurrence) {
    setTabState({ occurrence, tab: defaultTab });
  }
  if (occurrence === null || !entry) {
    return null;
  }
  const nextFailed = nextFailedIndex(trace, occurrence);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden border border-border/50 rounded-lg p-0 shadow-lg"
      >
        <DialogHeader className="border-b border-border/50 px-6 py-4">
          <DialogTitle className="truncate pr-8 text-base">
            {entry.name}
          </DialogTitle>
        </DialogHeader>
        <div
          role="tablist"
          className="flex items-center gap-1 border-b border-border/50 px-4"
        >
          {TAB_ORDER.map((tabId) => (
            <button
              key={tabId}
              type="button"
              role="tab"
              aria-selected={tabState.tab === tabId}
              disabled={!tabEnabled[tabId]}
              onClick={() => setTabState({ occurrence, tab: tabId })}
              className={[
                "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                tabState.tab === tabId
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-primary",
                "disabled:pointer-events-none disabled:opacity-40",
              ].join(" ")}
            >
              {t(TAB_KEYS[tabId])}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        >
          {!last && (
            <p className="mb-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t("chat:runSession.detail.occurrenceNote", {
                n: occurrenceOrdinal(trace, occurrence),
              })}
            </p>
          )}
          {tabState.tab === "summary" && <SummaryPanel entry={entry} />}
          {tabState.tab === "input" && full?.input && (
            <TextBlock text={full.input} />
          )}
          {tabState.tab === "output" && (
            <OutputPanel entry={entry} fullOutput={full?.output} />
          )}
          {tabState.tab === "tools" && (
            <ToolsPanel toolCalls={entry.toolCalls} />
          )}
          {tabState.tab === "error" && entry.error && (
            <ErrorPanel error={entry.error} />
          )}
        </div>
        <DialogFooter className="items-center border-t border-border/50 px-6 py-3 sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={occurrence === 0}
            onClick={() => onNavigate(occurrence - 1)}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t("chat:runSession.node.prev")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={occurrence >= trace.length - 1}
              onClick={() => onNavigate(occurrence + 1)}
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              {t("chat:runSession.node.next")}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={nextFailed === null}
              onClick={() => {
                if (nextFailed !== null) {
                  onNavigate(nextFailed);
                }
              }}
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              {t("chat:runSession.node.nextFailed")}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
