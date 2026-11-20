import type { AutomationRunDetail } from "@tianshu/protocol";

const DEFAULT_RUN_CONTEXT_CHARS = 16000;

type TraceEntry = Record<string, unknown>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseTrace(raw: string | undefined): TraceEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TraceEntry =>
        typeof entry === "object" && entry !== null,
    );
  } catch {
    return [];
  }
}

function metadata(run: AutomationRunDetail): string {
  return [
    "【运行上下文】",
    `名称: ${run.taskName || "-"}`,
    `运行 ID: ${run.id}`,
    `执行时间: ${run.startedAt}`,
    `触发类型: ${run.triggerType}`,
    `状态: ${run.status}`,
    run.error ? `错误: ${run.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function finalOutput(trace: TraceEntry[]): string {
  for (let index = trace.length - 1; index >= 0; index--) {
    const entry = trace[index];
    if (entry.status !== "success") continue;
    const output =
      stringValue(entry.output) || stringValue(entry.outputPreview);
    if (output) return `【最终输出】\n${output}`;
  }
  return "";
}

function failureText(entry: TraceEntry): string {
  const error =
    typeof entry.error === "object" && entry.error !== null
      ? (entry.error as Record<string, unknown>)
      : {};
  const id = stringValue(entry.id) || "unknown";
  const name = stringValue(entry.name);
  const code = stringValue(error.code);
  const message = stringValue(error.message);
  const detail = stringValue(error.detail);
  return [`${id}${name ? ` (${name})` : ""}`, code, message, detail]
    .filter(Boolean)
    .join(": ");
}

function failedNodes(trace: TraceEntry[]): string {
  const failures = trace
    .filter((entry) => entry.status === "failed")
    .map(failureText);
  return failures.length > 0 ? `【失败节点】\n${failures.join("\n")}` : "";
}

function nodeSummary(entry: TraceEntry): string {
  const id = stringValue(entry.id) || "unknown";
  const name = stringValue(entry.name);
  const status = stringValue(entry.status) || "unknown";
  const output = stringValue(entry.outputPreview);
  return `${id}${name ? ` (${name})` : ""} [${status}]${output ? `: ${output}` : ""}`;
}

function traceSummary(trace: TraceEntry[]): string {
  if (trace.length === 0) return "";
  return `【节点摘要】\n${trace.map(nodeSummary).join("\n")}`;
}

function fitMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const marker = "\n…\n";
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const contentChars = maxChars - marker.length;
  const headChars = Math.ceil(contentChars / 2);
  const tailChars = contentChars - headChars;
  return `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

/** 单次运行的固定追问摘要；不读取消息或其他运行，输出始终有界。 */
export function buildRunFollowupContext(
  run: AutomationRunDetail,
  maxChars = DEFAULT_RUN_CONTEXT_CHARS,
): string {
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : DEFAULT_RUN_CONTEXT_CHARS;
  const trace = parseTrace(run.graphTrace);
  const essential = [metadata(run), finalOutput(trace), failedNodes(trace)]
    .filter(Boolean)
    .join("\n\n");
  const bounded = fitMiddle(essential, limit);
  if (bounded.length >= limit || trace.length === 0) return bounded;
  const suffix = `\n\n${traceSummary(trace)}`;
  return bounded + suffix.slice(0, limit - bounded.length);
}
