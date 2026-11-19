// src-react/domains/ai/orchestration/components/GraphAiPanel.tsx
/**
 * 图 AI 编排面板（spec §2）：右栏「AI 编排」tab 内容，仿 FileChatPanel
 * 精简版——组合通用 ChatPane（消息流 + 输入框 + 流式），图上下文经
 * buildSystemContext/sessionResolver 注入（lib/graph-ai-context），AI 改动
 * 经 GraphEditCard（renderMessageExtra 插槽）自动应用回画布。
 * - 会话：graphDefinition.aiSessionId 绑定（useGraphAiSession），占位
 *   哨兵 id=-1 + 首条惰建；会话已删善后清绑定再发即新建。
 * - 模型目录注入 ModelApi.listAll（AI 不得臆造 modelId，spec 复审裁定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PanelRightClose, SquarePen, Wand2 } from "lucide-react";

import ChatPane, {
  type SessionResolverResult,
} from "@/domains/ai/chat/components/ChatPane";
import SessionApi, { type SessionRecord } from "@/domains/ai/api/session.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { ModelApi, modelDisplayName } from "@/domains/ai/api/model.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import IconTooltip from "@/components/common/icon-tooltip";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";
import type { GraphOp } from "@/domains/ai/orchestration/lib/graph-ai-ops";
import { useGraphAiSession } from "../hooks/use-graph-ai-session";
import GraphEditCard from "./GraphEditCard";

const HEADER_BTN =
  "rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary";

/** ChatPane 设置类入口 → 主窗路由（照 FileChatPanel 映射表） */
const SETTINGS_ROUTE: Record<"providers" | "assistants" | "mcp", string> = {
  providers: "/module/ai/providers",
  assistants: "/module/ai/experts",
  mcp: "/module/ai/experts?tab=connectors",
};

export default function GraphAiPanel(p: {
  graphId: number;
  graphName: string;
  description?: string;
  graphJson: string;
  /** 当前选中节点 id（视图层过滤后；注入快照供 AI 定位改动对象） */
  selectedNodeIds?: string[];
  aiSessionId: number | undefined;
  onBindingChange: (sessionId: number | undefined) => void;
  onApplyOps: (ops: GraphOp[]) => void;
  onApplyFull: (json: GraphJson) => void;
  onUndo: () => void;
  onCollapse: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const boundSessionId = p.aiSessionId;

  // 会话记录（绑定在飞/已绑定时拉取；失效口径同 FileChatPanel）
  const sessionQuery = useQuery({
    queryKey: ["sessions", "graph-ai", boundSessionId],
    queryFn: () => SessionApi.getById(boundSessionId as number),
    enabled: boundSessionId !== undefined && boundSessionId > 0,
    retry: false,
  });
  const sessionRecord = sessionQuery.data ?? null;

  // 模型目录注入（AI 只能用目录内 modelId 或 0 占位）
  const modelsQuery = useQuery({
    queryKey: ["models", "graph-ai"],
    queryFn: () => ModelApi.listAll(),
    staleTime: 300_000,
    retry: false,
  });
  const models = useMemo(
    () =>
      (modelsQuery.data ?? []).map((m) => ({
        id: m.id,
        name: modelDisplayName(m),
      })),
    [modelsQuery.data],
  );

  // 工作空间列表：hasModel 解析（会话当前模型 → 空间默认模型）
  const workspacesQuery = useQuery({
    queryKey: ["workspaces", "graph-ai"],
    queryFn: () => WorkspaceApi.list(),
    staleTime: 30_000,
    retry: false,
  });
  const workspaces = workspacesQuery.data;

  const {
    prepareFirstSend,
    buildSystemContext,
    startNewSession,
    handleSessionGone,
    isSessionGoneError,
  } = useGraphAiSession({
    graphId: p.graphId,
    graphName: p.graphName,
    description: p.description,
    graphJson: p.graphJson,
    models,
    boundSessionId,
    selectedNodeIds: p.selectedNodeIds,
    onBindingChange: p.onBindingChange,
  });

  // 会话已删（外部删除）：善后清绑定 + 提示，面板回占位再发即新建
  const sessionGone =
    sessionQuery.isError && isSessionGoneError(sessionQuery.error);
  useEffect(() => {
    if (sessionGone) handleSessionGone();
  }, [sessionGone, handleSessionGone]);

  // 占位会话的模型草稿：ModelPicker 哨兵分支只入草稿，不直接写不存在的
  // 会话；首条发送建会话后在 resolver 内落库（新建任务 dispatch 同链路）
  const [draftModelId, setDraftModelId] = useState<number | null>(null);

  // 占位哨兵会话（未绑定时 ChatPane 恒渲染，首条经 resolver 惰建）
  const placeholderSession = useMemo<SessionRecord>(
    () => ({
      id: -1,
      workspaceId: workspaces?.[0]?.id ?? -1,
      title: "",
      mode: "agent",
      currentModelId: draftModelId ?? undefined,
      createdAt: "",
      updatedAt: "",
    }),
    [workspaces, draftModelId],
  );
  const paneSession = sessionRecord ?? placeholderSession;

  const paneWorkspace = useMemo(
    () =>
      sessionRecord
        ? { id: sessionRecord.workspaceId }
        : workspaces?.[0]
          ? { id: workspaces[0].id }
          : null,
    [sessionRecord, workspaces],
  );

  // 模型目录未就绪（在飞/失败）时禁发：空目录注入会瓦解 modelId 幻觉
  // 防御（评审 Important 5）——复用 hasModel 门，ChatPane 无模型态引导配置
  const hasModel =
    Boolean(
      sessionRecord?.currentModelId ??
      draftModelId ??
      workspaces?.find((w) => w.id === paneWorkspace?.id)?.defaultModelId,
    ) && modelsQuery.isSuccess;

  // 快捷指令（纯问答，不改图）
  const quickPrompts = useMemo(
    () => [
      {
        id: "explain-graph",
        label: t("chat:orchestration.editor.ai.quickExplain"),
        prompt: t("chat:orchestration.editor.ai.quickExplainPrompt"),
      },
      {
        id: "suggest-graph",
        label: t("chat:orchestration.editor.ai.quickSuggest"),
        prompt: t("chat:orchestration.editor.ai.quickSuggestPrompt"),
      },
    ],
    [t],
  );

  // 本轮会话起点：只有晚于该时刻生成的 AI 回复才可自动应用——持久
  // 会话重开编辑器/翻页重挂载历史卡片时绝不重复改画布
  const sessionStartRef = useRef(Date.now());

  // resolver 失败提示归面板（单点 toast，防双弹）
  const handleResolveSession =
    useCallback(async (): Promise<SessionResolverResult> => {
      try {
        const resolved = await prepareFirstSend();
        // 模型草稿必须在 chat:send 前落到真会话：发送链起流即读会话模型
        if (draftModelId !== null) {
          await SessionApi.setModel(resolved.session.id, draftModelId);
        }
        return resolved;
      } catch (e) {
        toast.error(mapIpcError(e));
        throw e;
      }
    }, [prepareFirstSend, draftModelId]);

  const handleSessionResolved = useCallback(
    (s: SessionRecord) => {
      p.onBindingChange(s.id);
      void queryClient.invalidateQueries({
        queryKey: ["sessions", "graph-ai", s.id],
      });
    },
    [p, queryClient],
  );

  const handleOpenSettings = useCallback(
    (target: "providers" | "assistants" | "mcp") => {
      navigate(SETTINGS_ROUTE[target]);
    },
    [navigate],
  );

  const handleNewSession = useCallback(() => {
    startNewSession().catch((e: unknown) => {
      toast.error(mapIpcError(e));
    });
  }, [startNewSession]);

  const paneLoading =
    boundSessionId !== undefined &&
    boundSessionId > 0 &&
    !sessionRecord &&
    !sessionQuery.isError;
  const paneLoadFailed =
    boundSessionId !== undefined &&
    boundSessionId > 0 &&
    !sessionRecord &&
    sessionQuery.isError &&
    !sessionGone;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 items-center gap-1 border-b border-border/50 px-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Wand2 className="h-3.5 w-3.5 text-primary" />
          {t("chat:orchestration.editor.ai.panelTitle")}
        </span>
        <IconTooltip label={t("chat:orchestration.editor.ai.newSession")}>
          <button
            type="button"
            aria-label={t("chat:orchestration.editor.ai.newSession")}
            onClick={handleNewSession}
            className={HEADER_BTN}
          >
            <SquarePen className="h-4 w-4" />
          </button>
        </IconTooltip>
        <IconTooltip label={t("chat:orchestration.editor.ai.collapse")}>
          <button
            type="button"
            aria-label={t("chat:orchestration.editor.ai.collapse")}
            onClick={p.onCollapse}
            className={`ml-auto ${HEADER_BTN}`}
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </IconTooltip>
      </div>
      {paneLoading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {t("common:loading")}
        </div>
      ) : paneLoadFailed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-muted-foreground">
          <p className="text-xs">
            {t("chat:orchestration.editor.ai.sendFailed")}
          </p>
          <button
            type="button"
            onClick={() => void sessionQuery.refetch()}
            className="rounded-full border border-border/50 px-3 py-1 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:retry")}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatPane
            key={paneSession.id}
            session={paneSession}
            workspace={paneWorkspace}
            hasModel={hasModel}
            onOpenSettings={handleOpenSettings}
            quickPrompts={quickPrompts}
            sessionResolver={handleResolveSession}
            onSessionResolved={handleSessionResolved}
            buildSystemContext={buildSystemContext}
            onPickModel={setDraftModelId}
            renderMessageExtra={(message) =>
              message.role === "assistant" ? (
                <GraphEditCard
                  message={message}
                  graphJson={p.graphJson}
                  autoApplyAfter={sessionStartRef.current}
                  onApplyOps={p.onApplyOps}
                  onApplyFull={p.onApplyFull}
                  onUndo={p.onUndo}
                />
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}
