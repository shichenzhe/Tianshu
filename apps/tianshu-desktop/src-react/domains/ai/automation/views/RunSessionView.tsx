import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  canFollowUpRun,
  runOwnerOf,
  type RunOwner,
} from "@tianshu/core/run-session";
import type { AutomationRunDetail } from "@tianshu/protocol";
import { toast } from "sonner";
import { usePageHeader } from "@/components/layout/page-header.store";
import SessionSearchBox from "../../layout/components/SessionSearchBox";
import ChatPane from "../../chat/components/ChatPane";
import SessionApi, { type SessionRecord } from "../../api/session.api";
import { mapIpcError } from "../../chat/lib/error-message";
import {
  sessionSettingsPath,
  useSessionPaneData,
} from "../../chat/hooks/use-session-pane-data";
import { parseTrace } from "../../orchestration/components/GraphRunTraceView";
import { AutomationApi } from "../api/automation.api";
import { localizeRunError } from "../lib/run-display";
import { getRunDraft, setRunDraft } from "../lib/run-draft-store";
import { runSessionPath } from "../lib/run-session-route";
import {
  queryRunPage,
  runPageQueryKey,
  RunStatusBadge,
} from "../components/RunSelector";
import RunBoard from "../components/run-board";
import GraphRunDetail from "../components/graph-run-detail";
import NodeRunDialog from "../components/node-run-dialog";
import RunWorkspaceDialog from "../components/RunWorkspaceDialog";
import { useHostStore } from "../../data-source/host.store";

interface RunSessionViewProps {
  owner: RunOwner;
}

/** 固定入口右栏：URL 中的显式 run 永远优先，缺省时才跟随第一页最新项。 */
export default function RunSessionView({ owner }: RunSessionViewProps) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const explicitRunId = positiveId(searchParams.get("run"));
  const runSessionsEnabled = useHostStore((state) => state.caps.runSessions);
  const latestQuery = useQuery({
    queryKey: runPageQueryKey(owner, 1),
    queryFn: () => queryRunPage(owner, 1),
    enabled: runSessionsEnabled,
  });
  const selectedRunId = explicitRunId ?? latestQuery.data?.items[0]?.id;
  const runQuery = useQuery({
    queryKey: ["automation", "run", selectedRunId],
    queryFn: () => AutomationApi.runById(selectedRunId!),
    enabled: runSessionsEnabled && selectedRunId !== undefined,
  });
  const ownerMismatch =
    explicitRunId !== undefined &&
    runQuery.data != null &&
    !runMatchesOwner(runQuery.data, owner);
  const canonicalizeExplicitRun =
    explicitRunId !== undefined &&
    (ownerMismatch ||
      (runQuery.isSuccess && runQuery.data == null) ||
      (runQuery.isError && isRunNotFound(runQuery.error)));
  useEffect(() => {
    if (canonicalizeExplicitRun) {
      navigate(runSessionPath(owner), { replace: true });
    }
  }, [canonicalizeExplicitRun, navigate, owner]);
  const displayRun = ownerMismatch ? null : runQuery.data;
  const listedRun = latestQuery.data?.items.find(
    (run) => run.id === selectedRunId,
  );
  const selectRun = useCallback(
    (runId: number) => navigate(runSessionPath(owner, runId)),
    [navigate, owner],
  );

  usePageHeader(
    runSessionsEnabled
      ? {
          trailing: <SessionSearchBox />,
        }
      : null,
  );

  if (!runSessionsEnabled) {
    return <CenteredMessage text={t("chat:runSession.empty")} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {displayRun ? (
          <RunConversation key={displayRun.id} run={displayRun} />
        ) : selectedRunId !== undefined && runQuery.isLoading ? (
          <CenteredMessage text={t("common:loading")} />
        ) : runQuery.isError ? (
          <CenteredMessage text={mapIpcError(runQuery.error)} />
        ) : latestQuery.isLoading ? (
          <CenteredMessage text={t("common:loading")} />
        ) : latestQuery.isError ? (
          <CenteredMessage text={mapIpcError(latestQuery.error)} />
        ) : (
          <CenteredMessage text={t("chat:runSession.empty")} />
        )}
      </div>
      {runSessionsEnabled && (
        <RunBoard
          key={`${owner.kind}:${owner.ownerId}`}
          owner={owner}
          selectedRunId={selectedRunId}
          currentRun={displayRun ?? listedRun}
          onSelect={selectRun}
        />
      )}
    </div>
  );
}

function RunConversation({ run }: { run: AutomationRunDetail }) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [resolvedSession, setResolvedSession] = useState<SessionRecord | null>(
    null,
  );
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const resolvedRef = useRef<SessionRecord | null>(null);
  const resolvingRef = useRef<Promise<SessionRecord> | null>(null);
  const workspaceChoiceRef = useRef<WorkspaceChoice | null>(null);
  const canFollowUp = canFollowUpRun(run.status);
  const sessionQuery = useQuery({
    queryKey: ["sessions", "byId", run.sessionId],
    queryFn: () => SessionApi.getById(run.sessionId!),
    enabled: canFollowUp && run.sessionId != null,
  });
  const session = resolvedSession ?? sessionQuery.data ?? null;
  const placeholder = useMemo(() => runPlaceholder(run), [run]);
  const paneSession = session ?? placeholder;
  const { workspaces, workspace, hasModel } = useSessionPaneData(paneSession, {
    fallBackToFirstWorkspace: false,
  });
  const trace = useMemo(() => parseTrace(run.graphTrace), [run.graphTrace]);
  // 节点弹框选中态（occurrence = trace 下标）由本容器持有：双视图点击
  // 与弹框导航共用同一份（spec §2/§3）。RunConversation 按 run.id keyed
  // 重挂载，切运行自然清空
  const [selectedOccurrence, setSelectedOccurrence] = useState<number | null>(
    null,
  );
  // 按次草稿（spec §2 设计者裁定）：挂载时捕获本 run 既有草稿回灌
  // ChatPane（initialDraft 仅作 ChatInput 初值）；卸载（切运行）经
  // onDraftUnmount 回写本 run——绝不携带到另一运行
  const initialDraft = useMemo(() => getRunDraft(run.id), [run.id]);

  const resolveSession = useCallback(
    async (workspaceId?: number): Promise<SessionRecord> => {
      const result = await AutomationApi.ensureRunSession(run.id, workspaceId);
      const resolved = await SessionApi.getById(result.sessionId);
      resolvedRef.current = resolved;
      setResolvedSession(resolved);
      await invalidateRunSessionQueries(queryClient, run.id);
      return resolved;
    },
    [queryClient, run.id],
  );
  const requestWorkspace = useCallback(() => {
    setWorkspaceDialogOpen(true);
    return new Promise<number>((resolve, reject) => {
      workspaceChoiceRef.current = { resolve, reject };
    });
  }, []);
  const sessionResolver = useCallback(async () => {
    if (resolvedRef.current) return { session: resolvedRef.current };
    if (!resolvingRef.current) {
      resolvingRef.current = resolveWithWorkspace(
        resolveSession,
        requestWorkspace,
      );
    }
    try {
      return { session: await resolvingRef.current };
    } catch (error) {
      if (!isWorkspaceCancelled(error)) toast.error(mapIpcError(error));
      throw error;
    } finally {
      resolvingRef.current = null;
    }
  }, [requestWorkspace, resolveSession]);
  const handleSessionResolved = useCallback((resolved: SessionRecord) => {
    resolvedRef.current = resolved;
    setResolvedSession(resolved);
  }, []);
  const confirmWorkspace = useCallback((workspaceId: number) => {
    setWorkspaceDialogOpen(false);
    workspaceChoiceRef.current?.resolve(workspaceId);
    workspaceChoiceRef.current = null;
  }, []);
  const cancelWorkspace = useCallback(() => {
    setWorkspaceDialogOpen(false);
    workspaceChoiceRef.current?.reject(new Error("RUN_WORKSPACE_CANCELLED"));
    workspaceChoiceRef.current = null;
  }, []);
  useEffect(() => cancelWorkspace, [cancelWorkspace]);

  const openSettings = useCallback(
    (target: "providers" | "assistants" | "mcp") =>
      navigate(sessionSettingsPath(target)),
    [navigate],
  );
  const chatPane = canFollowUp ? (
    <ChatPane
      key={paneSession.id}
      session={paneSession}
      workspace={workspace}
      hasModel={hasModel}
      onOpenSettings={openSettings}
      sessionResolver={sessionResolver}
      onSessionResolved={handleSessionResolved}
      initialDraft={initialDraft}
      onDraftUnmount={(draft) => setRunDraft(run.id, draft)}
    />
  ) : null;
  const isGraph = run.graphId !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isGraph && (
        <GraphRunDetail
          run={run}
          trace={trace}
          selectedOccurrence={selectedOccurrence}
          onSelectOccurrence={setSelectedOccurrence}
        />
      )}
      {!canFollowUp && <TerminalRunStatus run={run} />}
      {canFollowUp && !isGraph && !session && run.error && (
        <p className="border-b border-border/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {localizeRunError(run.error, t)}
        </p>
      )}
      {chatPane}
      {isGraph && (
        <NodeRunDialog
          run={run}
          trace={trace}
          occurrence={selectedOccurrence}
          onClose={() => setSelectedOccurrence(null)}
          onNavigate={setSelectedOccurrence}
        />
      )}
      <RunWorkspaceDialog
        open={workspaceDialogOpen}
        workspaces={workspaces}
        onConfirm={confirmWorkspace}
        onCancel={cancelWorkspace}
      />
    </div>
  );
}

interface WorkspaceChoice {
  resolve: (workspaceId: number) => void;
  reject: (error: Error) => void;
}

async function resolveWithWorkspace(
  resolveSession: (workspaceId?: number) => Promise<SessionRecord>,
  requestWorkspace: () => Promise<number>,
): Promise<SessionRecord> {
  try {
    return await resolveSession();
  } catch (error) {
    if (!isWorkspaceRequired(error)) throw error;
    return resolveSession(await requestWorkspace());
  }
}

function runPlaceholder(run: AutomationRunDetail): SessionRecord {
  return {
    id: -run.id,
    workspaceId: run.workspaceId ?? 0,
    title: run.taskName,
    mode: "agent",
    createdAt: run.startedAt,
    updatedAt: run.finishedAt ?? run.startedAt,
    automationTaskId: run.taskId,
    runGraphId: run.taskId === null ? (run.graphId ?? null) : null,
    automationRunId: run.id,
  };
}

async function invalidateRunSessionQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: number,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    queryClient.invalidateQueries({ queryKey: ["automation", "runGroups"] }),
    queryClient.invalidateQueries({ queryKey: ["automation", "run", runId] }),
    queryClient.invalidateQueries({
      queryKey: ["automation", "runSessionRuns"],
    }),
  ]);
}

function TerminalRunStatus({ run }: { run: AutomationRunDetail }) {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <RunStatusBadge status={run.status} />
      {run.error && (
        <p className="max-w-lg whitespace-pre-wrap text-sm text-muted-foreground">
          {localizeRunError(run.error, t)}
        </p>
      )}
    </div>
  );
}

function CenteredMessage({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function positiveId(raw: string | null): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function runMatchesOwner(run: AutomationRunDetail, owner: RunOwner): boolean {
  const actual = runOwnerOf(run);
  return actual?.kind === owner.kind && actual.ownerId === owner.ownerId;
}

function isRunNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("RUN_NOT_FOUND");
}

function isWorkspaceRequired(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("RUN_WORKSPACE_REQUIRED")
  );
}

function isWorkspaceCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "RUN_WORKSPACE_CANCELLED";
}
