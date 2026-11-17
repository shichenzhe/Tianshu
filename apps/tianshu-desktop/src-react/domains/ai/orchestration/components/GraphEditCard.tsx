// src-react/domains/ai/orchestration/components/GraphEditCard.tsx
/**
 * 图 AI 消息级回执卡片（spec「变更清单卡片」+ 自动应用模式）：
 * 渲染在 assistant 消息下方（ChatPane renderMessageExtra 插槽），
 * 生命周期：解析消息文本 → 构造候选图 → normalizeGraph + validateGraph
 * 校验链 → 通过则自动应用（回调进 GraphEditorView commitGraph 撤销栈）
 * 并转为「已执行回执」（改动条目 + 撤销入口）；不通过则红色列出候选
 * 问题供追问修正。按 message.id 守卫单次应用，防 StrictMode 双跑。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Unlink,
  XCircle,
} from "lucide-react";

import type { MessageRecord } from "@/domains/ai/api/session.api";
import {
  normalizeGraph,
  validateGraph,
  type GraphIssue,
  type GraphJson,
} from "@/domains/ai/orchestration/api/graph.schema";
import {
  localizeGraphIssue,
  parseOrKeep,
  serializeGraph,
} from "@/domains/ai/orchestration/lib/graph-editor-model";
import { parseBlocks } from "@/domains/ai/chat/model/blocks";
import {
  applyGraphOps,
  mergeSurvivingPositions,
  type GraphOp,
} from "@/domains/ai/orchestration/lib/graph-ai-ops";
import {
  extractGraphEdit,
  type GraphEditExtraction,
} from "@/domains/ai/orchestration/lib/graph-ai-context";

const AI_KEY = "chat:orchestration.editor.ai";

/** assistant 消息文本提取：只拼 text 块（thinking/工具块不进解析），
 *  blocks 非法 JSON 返回空串（历史数据容错） */
export function extractTextOfMessage(blocksJson: string): string {
  try {
    return parseBlocks(blocksJson)
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");
  } catch {
    return "";
  }
}

/** 回执撤销可用性：应用后画布未被再改（canonicalJson 相等）才可撤销——
 *  否则撤销回退的是用户后续手改而非 AI 应用 */
export function canUndoReceipt(
  appliedAtJson: string,
  currentJson: string,
): boolean {
  return appliedAtJson === currentJson;
}

/** 候选图构造：ops 形态折叠到当前图；full 形态先做坐标合并（spec 5b） */
function candidateOf(
  extraction: NonNullable<GraphEditExtraction>,
  current: GraphJson,
): GraphJson {
  const raw =
    extraction.kind === "ops"
      ? applyGraphOps(current, extraction.changeSet.ops)
      : mergeSurvivingPositions(current, extraction.json);
  return normalizeGraph(raw);
}

interface GraphEditCardProps {
  message: MessageRecord;
  /** 当前画布 canonicalJson（卡片据此构造候选图与撤销可用性） */
  graphJson: string;
  onApplyOps: (ops: GraphOp[]) => void;
  onApplyFull: (json: GraphJson) => void;
  onUndo: () => void;
}

export default function GraphEditCard({
  message,
  graphJson,
  onApplyOps,
  onApplyFull,
  onUndo,
}: GraphEditCardProps) {
  const { t } = useTranslation(["chat"]);
  const [state, setState] = useState<"applied" | "failed" | null>(null);
  const [issues, setIssues] = useState<GraphIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [appliedAtJson, setAppliedAtJson] = useState<string | null>(null);
  const triedRef = useRef(false);

  const extraction = useMemo(
    () => extractGraphEdit(extractTextOfMessage(message.blocks)),
    [message.blocks],
  );

  // 自动应用（单次守卫）：解析成功即跑校验链，通过自动落画布
  useEffect(() => {
    if (!extraction || triedRef.current) return;
    triedRef.current = true;
    const current = parseOrKeep(graphJson).parsed;
    if (!current) {
      setError("current graph unparseable");
      setState("failed");
      return;
    }
    try {
      const candidate = candidateOf(extraction, current);
      const validated = validateGraph(candidate);
      if (!validated.ok) {
        setIssues(validated.issues);
        setState("failed");
        return;
      }
      if (extraction.kind === "ops") {
        onApplyOps(extraction.changeSet.ops);
      } else {
        onApplyFull(validated.value);
      }
      setAppliedAtJson(serializeGraph(validated.value));
      setState("applied");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("failed");
    }
    // 有意单次执行：triedRef 守卫 + 回调/图快照以渲染时点为准
  }, [extraction, message.id]);

  // 变更条目的人类可读标签（ops 逐条；full 单条汇总）
  const itemLabels = useMemo(() => {
    if (!extraction) return [];
    if (extraction.kind === "full") {
      return [
        t(`${AI_KEY}.itemFullReplace`, {
          nodes: extraction.json.nodes.length,
          edges: extraction.json.edges.length,
        }),
      ];
    }
    const current = parseOrKeep(graphJson).parsed;
    return extraction.changeSet.ops.map((op) => {
      switch (op.op) {
        case "addNode":
          return t(`${AI_KEY}.itemAddNode`, {
            id: op.node.id,
            kind: op.node.kind,
          });
        case "updateNode":
          return t(`${AI_KEY}.itemUpdateNode`, { id: op.id });
        case "removeNode": {
          const cascade =
            current?.edges.filter((e) => e.from === op.id || e.to === op.id)
              .length ?? 0;
          return cascade > 0
            ? t(`${AI_KEY}.itemRemoveNodeCascade`, {
                id: op.id,
                count: cascade,
              })
            : t(`${AI_KEY}.itemRemoveNode`, { id: op.id });
        }
        case "renameNode":
          return t(`${AI_KEY}.itemRenameNode`, {
            from: op.from,
            to: op.to,
          });
        case "addEdge":
          return t(`${AI_KEY}.itemAddEdge`, {
            from: op.edge.from,
            to: op.edge.to,
          });
        case "removeEdge":
          return t(`${AI_KEY}.itemRemoveEdge`, {
            from: op.from,
            to: op.to,
          });
      }
    });
  }, [extraction, graphJson, t]);

  if (!extraction) return null;

  const canUndo =
    appliedAtJson !== null && canUndoReceipt(appliedAtJson, graphJson);

  return (
    <div
      data-testid="graph-edit-card"
      className="mt-2 rounded-lg border border-border/50 bg-primary-subtle/40 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5">
        {state === "applied" ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="font-medium text-foreground">
              {t(`${AI_KEY}.receiptApplied`)}
            </span>
          </>
        ) : (
          <>
            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
            <span className="font-medium text-destructive">
              {t(`${AI_KEY}.receiptFailed`)}
            </span>
          </>
        )}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
        {itemLabels.map((label, index) => (
          <li key={index} className="flex items-center gap-1.5">
            <OpIcon extraction={extraction} index={index} />
            <span className="break-all">{label}</span>
          </li>
        ))}
      </ul>
      {state === "failed" && (
        <div className="mt-1.5 space-y-0.5">
          {issues.length > 0 ? (
            issues.map((issue, index) => (
              <p key={index} className="text-destructive">
                · {localizeGraphIssue(issue, t)}
              </p>
            ))
          ) : (
            <p className="text-destructive">
              · {t(`${AI_KEY}.opsError`, { message: error ?? "?" })}
            </p>
          )}
          <p className="text-muted-foreground">
            {t(`${AI_KEY}.receiptFailedHint`)}
          </p>
        </div>
      )}
      {state === "applied" && (
        <button
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          className="mt-1.5 inline-flex items-center gap-1 rounded border border-border/50 px-2 py-0.5 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" />
          {t(`${AI_KEY}.receiptUndo`)}
        </button>
      )}
    </div>
  );
}

/** 逐项图标：ops 按操作类型；full 恒 Replace（用 Pencil 兜底位） */
function OpIcon({
  extraction,
  index,
}: {
  extraction: NonNullable<GraphEditExtraction>;
  index: number;
}) {
  if (extraction.kind === "full")
    return <Pencil className="h-3 w-3 shrink-0" />;
  const op = extraction.changeSet.ops[index];
  switch (op.op) {
    case "addNode":
      return <Plus className="h-3 w-3 shrink-0" />;
    case "updateNode":
      return <Pencil className="h-3 w-3 shrink-0" />;
    case "removeNode":
      return <Trash2 className="h-3 w-3 shrink-0" />;
    case "renameNode":
      return <Pencil className="h-3 w-3 shrink-0" />;
    case "addEdge":
      return <Link2 className="h-3 w-3 shrink-0" />;
    case "removeEdge":
      return <Unlink className="h-3 w-3 shrink-0" />;
  }
}
