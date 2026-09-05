/**
 * 工具调用卡片：折叠容器（沿用 thinking 块视觉语言），头部为工具名 + 状态标签
 * +（args.path 存在时的）路径摘要，展开区显完整参数与输出
 * 历史块（blocks 解析）与流式态（store）共用同一组件，props 平铺传入
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";

/** 状态值 → i18n key 映射（兼容 kebab-case 与 camelCase；未知值含空串按 ready 兜底） */
const STATE_I18N_KEYS: Record<string, string> = {
  ready: "ready",
  "awaiting-approval": "awaitingApproval",
  awaitingApproval: "awaitingApproval",
  running: "running",
  done: "done",
  denied: "denied",
  error: "error",
};

/** 状态 → 主题文字色（其余状态用默认色） */
const STATE_COLORS: Record<string, string> = {
  awaitingApproval: "text-primary",
  done: "text-muted-foreground",
  denied: "text-destructive",
  error: "text-destructive",
};

/** 输出最大展示行数，超出截断并提示 */
const OUTPUT_MAX_LINES = 100;

interface ToolCallCardProps {
  toolName: string;
  args?: unknown;
  /** 主进程透传的状态字符串（渲染层不做枚举收窄，未知值按 ready 兜底） */
  state: string;
  output?: string;
}

/** 取卡片头摘要：优先 args.path；无 path 的工具（如 run_command）取 args.command 前 60 字符 */
function extractPath(args: unknown): string | null {
  if (typeof args !== "object" || args === null) {
    return null;
  }
  const record = args as Record<string, unknown>;
  const path = record.path;
  if (typeof path === "string" && path.length > 0) {
    return path;
  }
  const command = record.command;
  return typeof command === "string" && command.length > 0
    ? command.slice(0, 60)
    : null;
}

/** 输出超行数时仅保留前 N 行 */
function truncateOutput(output: string): { text: string; truncated: boolean } {
  const lines = output.split("\n");
  if (lines.length <= OUTPUT_MAX_LINES) {
    return { text: output, truncated: false };
  }
  return {
    text: lines.slice(0, OUTPUT_MAX_LINES).join("\n"),
    truncated: true,
  };
}

function ToolCallCardImpl({
  toolName,
  args,
  state,
  output,
}: ToolCallCardProps) {
  const { t } = useTranslation(["chat"]);

  const stateKey = STATE_I18N_KEYS[state] ?? "ready";
  const stateColor = STATE_COLORS[stateKey] ?? "";
  const path = extractPath(args);
  const shownOutput = output ? truncateOutput(output) : null;
  // error 态加左侧橙色竖线（PRD §2.3.B「插曲」语义色，同流式绿点先例）
  const containerClass = `my-1 rounded-md border border-border/50 bg-muted/30${
    stateKey === "error" ? " border-l-2 border-l-orange-400/80" : ""
  }`;

  return (
    <details className={containerClass}>
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground">
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className="shrink-0">🔧 {toolName}</span>
          <span className={`shrink-0 ${stateColor}`}>
            {t(`chat:tool.state.${stateKey}`)}
          </span>
          {path && <span className="truncate">→ {path}</span>}
        </span>
      </summary>
      <div className="px-3 pb-2">
        <pre className="overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
          {JSON.stringify(args ?? {}, null, 2)}
        </pre>
        {shownOutput && (
          <>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
              {shownOutput.text}
            </pre>
            {shownOutput.truncated && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("chat:tool.outputTruncated", { count: OUTPUT_MAX_LINES })}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

export default memo(ToolCallCardImpl);
