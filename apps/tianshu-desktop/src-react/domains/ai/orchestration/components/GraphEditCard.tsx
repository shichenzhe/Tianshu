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
import { toast } from "sonner";
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

/** 当前草稿解析：新建图的占位节点尚未满足严格 schema（name/modelId/
 *  prompt 空），不能因此拒绝合法全量替换；宽松回退仅用于构造候选图，
 *  最终仍必须过 normalizeGraph + validateGraph */
function currentGraphOf(graphJson: string): GraphJson | null {
  const strict = parseOrKeep(graphJson).parsed;
  if (strict) return strict;
  try {
    const raw = JSON.parse(graphJson) as {
      nodes?: unknown;
      edges?: unknown;
    };
    return Array.isArray(raw.nodes) && Array.isArray(raw.edges)
      ? (raw as GraphJson)
      : null;
  } catch {
    return null;
  }
}

interface GraphEditCardProps {
  message: MessageRecord;
  /** 当前画布 canonicalJson（卡片据此构造候选图与撤销可用性） */
  graphJson: string;
  /** 本轮会话起点（epoch ms）：早于该时刻的历史消息只展示不自动应用——
   *  持久会话重开/翻页重挂载时，旧回复绝不可再改当前画布（数据损坏
   *  防线）；新回复（createdAt 在起点之后）走自动应用 */
  autoApplyAfter: number;
  onApplyOps: (ops: GraphOp[]) => void;
  onApplyFull: (json: GraphJson) => void;
  onUndo: () => void;
}

/** 消息是否本轮新生成（5s 容差吸收序列化/时钟抖动） */
function isFreshMessage(createdAt: string, autoApplyAfter: number): boolean {
  const ts = Date.parse(createdAt);
  return Number.isFinite(ts) && ts >= autoApplyAfter - 5_000;
}

/** 应用器错误码 → i18n key（graph-ai-ops 抛 code:detail 形态；未识别码
 *  回落通用键，detail 原样带出） */
const OP_ERROR_KEYS: Record<string, string> = {
  "node-missing": "errNodeMissing",
  "node-exists": "errNodeExists",
  "id-kind-immutable": "errIdKindImmutable",
  "edge-self-loop": "errEdgeSelfLoop",
  "edge-duplicate": "errEdgeDuplicate",
  "edge-missing": "errEdgeMissing",
};

type Translate = (key: string, opts?: Record<string, unknown>) => string;

function localizeApplyError(e: unknown, t: Translate): string {
  const raw = e instanceof Error ? e.message : String(e);
  const sep = raw.indexOf(":");
  const code = sep > 0 ? raw.slice(0, sep) : "";
  const detail = sep > 0 ? raw.slice(sep + 1) : raw;
  const key = OP_ERROR_KEYS[code];
  return key
    ? t(`${AI_KEY}.${key}`, { detail })
    : t(`${AI_KEY}.errUnknown`, { detail: raw });
}

export default function GraphEditCard({
  message,
  graphJson,
  autoApplyAfter,
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

  // 自动应用（单次守卫）：仅本轮新回复；历史消息重挂载绝不触发
  useEffect(() => {
    if (!extraction || triedRef.current) return;
    if (!isFreshMessage(message.createdAt, autoApplyAfter)) return;
    triedRef.current = true;
    const current = currentGraphOf(graphJson);
    if (!current) {
      setError(t(`${AI_KEY}.currentUnparseable`));
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
      toast.success(t(`${AI_KEY}.applyOk`));
    } catch (e) {
      setError(localizeApplyError(e, t));
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
    const current = currentGraphOf(graphJson);
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
  // 历史消息：无持久化应用记录可查，不渲染卡片（AI 原文中的代码块仍
  // 可见，但不会再次改画布）
  if (!isFreshMessage(message.createdAt, autoApplyAfter)) return null;

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
              · {error ?? t(`${AI_KEY}.errUnknown`, { detail: "?" })}
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
