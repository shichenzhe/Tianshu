// src-react/domains/ai/orchestration/components/GraphRunTraceView.tsx
/**
 * 图运行节点轨迹时间线(spec §4 三层下钻第二层,Task 14):每节点一行——
 * 状态色点+节点名+耗时+tokens(有则显示);success/failed 行点击展开
 * 详情(开始时间+输出;failed 另含 error.code/message(+toolName)),
 * toolCalls 摘要(ok=false 标红);skipped 行灰、无详情。imageGen 节点
 * trace 带 outputImage(相对数据根)时输出区改渲染 MessageImage 缩略图
 * (复用消息图片链路:IPC 读盘+lightbox+失效降级),替代路径文本。TraceEntry 与
 * electron graph-executor.ts 同构(节点字段为 id 非 nodeId),渲染进程不
 * import 主进程模块,就地镜像类型。
 * 行展开下钻全文(去会话化 2026-10-28):runId 在场(运行历史/弹窗)时按需
 * 经 orchestration:runNodes 拉该 run 的 graphRunNode 节点详情行,命中同
 * nodeId 行则输入/输出区展示完整文本(输入块置于输出区上方);老 run 无
 * 节点行回落 outputPreview 预览。runId 不传(单节点测试等即席场景)维持
 * 纯预览渲染,不发起查询。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  formatDateTime,
  formatDuration,
} from "@/domains/ai/automation/lib/run-display";
import { MessageImage } from "@/domains/ai/chat/components/MessageImage";
import { GraphApi, type GraphRunNodeRow } from "../api/orchestration.api";

export interface TraceEntry {
  id: string;
  name: string;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  durationMs: number;
  tokens?: { promptTokens: number; completionTokens: number };
  error?: {
    code: string;
    message: string;
    toolName?: string;
    /** 失败全貌（完整 stderr/响应体/堆栈，executor 构造点 clip 4KB） */
    detail?: string;
  };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
  outputPreview?: string;
  /** 生成图片（imageGen 产物，相对数据根路径）——展示走 MessageImage */
  outputImage?: string;
  /** 降级继续标记（llm 节点 onError=defaultValue），与 executor 同构 */
  fallback?: { code: string; message: string };
  /** 循环节点死信（onItemError=continue 的失败项清单），与 executor 同构 */
  errorOutput?: string;
}

const DOT_CLASSES: Record<TraceEntry["status"], string> = {
  success: "bg-primary",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
};
const TEXT_CLASSES: Record<TraceEntry["status"], string> = {
  success: "text-primary",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

/** graphTrace JSON 列 → 轨迹数组;空/非法容错为空集(老 run 无 trace) */
export function parseTrace(raw: string | undefined): TraceEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TraceEntry[]) : [];
  } catch {
    return [];
  }
}

export default function GraphRunTraceView({
  trace,
  runId,
}: {
  trace: TraceEntry[];
  /** 行展开下钻 graphRunNode 全文（去会话化 2026-10-28）；单节点测试等
   * 即席场景不传——纯预览渲染，不发起查询 */
  runId?: number;
}) {
  const { t } = useTranslation(["chat"]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (trace.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("chat:orchestration.trace.empty")}
      </p>
    );
  }
  return (
    <ol className="flex flex-col divide-y divide-border/30">
      {trace.map((entry) => (
        <TraceRow
          key={entry.id}
          entry={entry}
          runId={runId}
          expanded={expandedId === entry.id}
          onToggle={() =>
            setExpandedId(expandedId === entry.id ? null : entry.id)
          }
        />
      ))}
    </ol>
  );
}

function TraceRow({
  entry,
  runId,
  expanded,
  onToggle,
}: {
  entry: TraceEntry;
  runId?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  // 行展开详情全文（去会话化 2026-10-28）：runId 在场（运行历史/弹窗）
  // 且行展开时按需拉节点行（enabled 守卫——不展开不拉）；老 run 无节点行
  // 回落 outputPreview。同 run 各行共用查询缓存（queryKey 按 runId）
  const { data: nodeRows } = useQuery({
    queryKey: ["orchestration", "runNodes", runId],
    queryFn: () => GraphApi.runNodes(runId!),
    enabled: expanded && runId !== undefined,
    staleTime: Infinity,
  });
  const full = nodeRows?.find((row) => row.nodeId === entry.id);
  const failed = entry.status === "failed";
  // success 有输出预览、failed 有错误详情，都可下钻；skipped 无内容
  const expandable = entry.status !== "skipped";
  return (
    <li
      className={`py-1.5 ${expandable ? "cursor-pointer" : ""}`}
      onClick={expandable ? onToggle : undefined}
    >
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASSES[entry.status]}`}
        />
        <span className={TEXT_CLASSES[entry.status]}>{entry.name}</span>
        <span className="text-xs text-muted-foreground">
          {formatDuration(entry.durationMs)}
        </span>
        {entry.tokens && (
          <span className="text-xs text-muted-foreground">
            {t("chat:automation.runs.tokens", {
              in: entry.tokens.promptTokens,
              out: entry.tokens.completionTokens,
            })}
          </span>
        )}
        {expandable &&
          (expanded ? (
            <ChevronDown
              className={`h-3.5 w-3.5 ${failed ? "text-destructive" : "text-muted-foreground"}`}
            />
          ) : (
            <ChevronRight
              className={`h-3.5 w-3.5 ${failed ? "text-destructive" : "text-muted-foreground"}`}
            />
          ))}
      </div>
      {expandable && expanded && <TraceDetail entry={entry} full={full} />}
    </li>
  );
}

/** 行展开详情：开始时间 + 输出（graphRunNode 全文优先，老 run 无节点行
 * 回落 200 字预览；failed 另含错误码与消息）；full.input 有值时输出区
 * 上方追加「输入」块；两类共用 toolCalls 摘要 */
function TraceDetail({
  entry,
  full,
}: {
  entry: TraceEntry;
  /** graphRunNode 命中行（同 nodeId）；老 run/查询未及 → undefined 走预览 */
  full?: GraphRunNodeRow;
}) {
  const { t } = useTranslation(["chat"]);
  const failed = entry.status === "failed";
  const outputText = full?.output ?? entry.outputPreview;
  return (
    <div
      className={`mt-1 ml-4 flex flex-col gap-1 rounded-md p-2 ${
        failed ? "bg-destructive/5" : "bg-muted/40"
      }`}
    >
      <p className="text-xs text-muted-foreground">
        {formatDateTime(entry.startedAt)}
      </p>
      {full?.input && (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t("chat:orchestration.trace.input")}
          </p>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground/80">
            {full.input}
          </pre>
        </div>
      )}
      {entry.outputImage ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t("chat:orchestration.trace.output")}
          </p>
          {/* 点 chip 开 lightbox：阻断冒泡防行折叠（chip 与行展开点击互斥，
              MessageImage 2026-10-24 chip 化后必须） */}
          <div onClick={(e) => e.stopPropagation()}>
            <MessageImage imagePath={entry.outputImage} />
          </div>
        </div>
      ) : (
        outputText && (
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-muted-foreground">
              {full?.output
                ? t("chat:orchestration.trace.outputFull")
                : t("chat:orchestration.trace.output")}
            </p>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {outputText}
            </pre>
          </div>
        )
      )}
      {entry.fallback && (
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/60 p-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t("chat:orchestration.trace.fallback")}
          </p>
          <p className="text-xs text-muted-foreground">
            {entry.fallback.code}: {entry.fallback.message}
          </p>
        </div>
      )}
      {entry.errorOutput && (
        <div className="flex flex-col gap-0.5 rounded-md bg-destructive/5 p-1.5">
          <p className="text-xs font-medium text-destructive">
            {t("chat:orchestration.trace.deadLetter")}
          </p>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-destructive/80">
            {entry.errorOutput}
          </pre>
        </div>
      )}
      {failed && (
        <>
          <p className="text-xs font-medium text-destructive">
            {entry.error?.code}
            {entry.error?.toolName ? ` · ${entry.error.toolName}` : ""}
          </p>
          <p className="text-xs text-destructive/80">{entry.error?.message}</p>
          {entry.error?.detail && (
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("chat:orchestration.trace.errorDetail")}
              </p>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-destructive/5 p-1.5 font-mono text-xs text-foreground/80">
                {entry.error.detail}
              </pre>
            </div>
          )}
        </>
      )}
      {entry.toolCalls && entry.toolCalls.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">
            {t("chat:orchestration.trace.toolCalls")}
          </p>
          <ul className="flex flex-col gap-0.5">
            {entry.toolCalls.map((call) => (
              <li
                key={call.name}
                className={`text-xs ${
                  call.ok ? "text-muted-foreground" : "text-destructive"
                }`}
              >
                {call.name} · {formatDuration(call.durationMs)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
