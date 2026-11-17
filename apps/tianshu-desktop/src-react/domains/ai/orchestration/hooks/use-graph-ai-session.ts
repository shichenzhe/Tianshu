// src-react/domains/ai/orchestration/hooks/use-graph-ai-session.ts
/**
 * 图 AI 会话绑定 hook（spec §3）：每个已保存图（graphId）绑定一个持久
 * 会话（graphDefinition.aiSessionId，1:1 资源侧拥有）。
 * - ensureSession：防重入；未绑定时取默认工作空间（WorkspaceApi.list 首
 *   个，空列表自动补建「默认工作空间」是既有行为）→ session:create →
 *   GraphApi.bindAiSession 回写绑定。
 * - prepareFirstSend：ChatPane sessionResolver 实现——会话惰建 + 首条
 *   前缀（固定指令 + 当前图快照）。
 * - buildSendPrefix：每次发送注入的最新图快照（无指令）。
 * - startNewSession / handleSessionGone：清绑定（bindAiSession null）+
 *   上抛面板本地态；gone 附 toast。
 * 空会话回收不做（spec 挂账）。
 */
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { SessionResolverResult } from "@/domains/ai/chat/components/ChatPane";
import type { SessionRecord } from "@/domains/ai/api/session.api";
import WorkspaceApi from "@/domains/ai/api/workspace.api";
import { invoke } from "@/lib/ipc";
import { GraphApi } from "../api/orchestration.api";
import {
  buildGraphAiInstruction,
  buildGraphContextPrefix,
  type GraphAiModelRef,
} from "../lib/graph-ai-context";

export function isGraphSessionGoneError(e: unknown): boolean {
  return String(e).includes("SESSION_NOT_FOUND");
}

export function useGraphAiSession(p: {
  graphId: number;
  graphName: string;
  description?: string;
  graphJson: string;
  models: GraphAiModelRef[];
  boundSessionId: number | undefined;
  /** 当前选中节点 id（视图层已过滤：仅节点 id，边稳定串不得混入） */
  selectedNodeIds?: string[];
  onBindingChange: (sessionId: number | undefined) => void;
}) {
  const { t } = useTranslation(["chat"]);
  // 并发防重入：首条连点只建一个会话
  const ensuringRef = useRef<Promise<number> | null>(null);

  const snapshotPrefix = useCallback(
    (): string =>
      buildGraphContextPrefix(t, {
        graphName: p.graphName,
        description: p.description,
        graphJson: p.graphJson,
        models: p.models,
        selectedNodeIds: p.selectedNodeIds,
      }),
    [t, p.graphName, p.description, p.graphJson, p.models, p.selectedNodeIds],
  );

  const ensureSession = useCallback(async (): Promise<number> => {
    if (p.boundSessionId !== undefined) return p.boundSessionId;
    if (!ensuringRef.current) {
      ensuringRef.current = (async () => {
        const workspaces = await WorkspaceApi.list();
        const target = workspaces[0];
        if (!target) throw new Error("WORKSPACE_NOT_FOUND");
        const created = (await invoke("session:create", {
          workspaceId: target.id,
          title: p.graphName,
        })) as { id: number };
        await GraphApi.bindAiSession(p.graphId, created.id);
        p.onBindingChange(created.id);
        return created.id;
      })().finally(() => {
        ensuringRef.current = null;
      });
    }
    return ensuringRef.current;
  }, [p.graphId, p.graphName, p.boundSessionId, p.onBindingChange]);

  /** 占位会话首条发送（ChatPane sessionResolver）：会话落地 + 首条前缀。
   *  前缀只含固定指令——图快照统一由 buildSendPrefix 注入（ChatPane 哨兵
   *  路径 resolver 前缀与 sendPrefix 都拼），避免首条双份快照（评审
   *  Important 3）。失败抛错，提示归面板包装层（防双弹） */
  const prepareFirstSend =
    useCallback(async (): Promise<SessionResolverResult> => {
      const sessionId = await ensureSession();
      const stub: SessionRecord = {
        id: sessionId,
        workspaceId: 0,
        title: p.graphName,
        mode: "agent",
        createdAt: "",
        updatedAt: "",
      };
      return {
        session: stub,
        contentPrefix: buildGraphAiInstruction(t, p.models),
      };
    }, [ensureSession, p.graphName, p.models, t]);

  /** 每条发送注入的最新图快照（首条之后的常规发送） */
  const buildSendPrefix = useCallback(
    (): string => snapshotPrefix(),
    [snapshotPrefix],
  );

  /** 清绑定（新建会话入口；再发即 ensureSession 重建） */
  const clearBinding = useCallback(async () => {
    await GraphApi.bindAiSession(p.graphId, null);
    p.onBindingChange(undefined);
  }, [p.graphId, p.onBindingChange]);

  const startNewSession = useCallback(async () => {
    await clearBinding();
  }, [clearBinding]);

  /** 会话被外部删除善后：乐观清本地绑定（占位 UI 立即可再发新建，不卡
   *  「占位 + 旧绑定」态——评审 Minor 7）；落库解绑后台补，失败提示 */
  const handleSessionGone = useCallback(() => {
    p.onBindingChange(undefined);
    GraphApi.bindAiSession(p.graphId, null).catch(() => {
      toast.error(t("chat:orchestration.editor.ai.unbindFailed"));
    });
    toast.error(t("chat:orchestration.editor.ai.sessionGone"));
  }, [p.graphId, p.onBindingChange, t]);

  return {
    prepareFirstSend,
    buildSendPrefix,
    startNewSession,
    handleSessionGone,
    isSessionGoneError: isGraphSessionGoneError,
  };
}
