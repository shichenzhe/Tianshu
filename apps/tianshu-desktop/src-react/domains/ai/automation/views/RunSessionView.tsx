import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { canFollowUpRun, type RunOwner } from "@tianshu/core/run-session";
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
import GraphRunTraceView, {
  parseTrace,
} from "../../orchestration/components/GraphRunTraceView";
import { AutomationApi } from "../api/automation.api";
import { localizeRunError } from "../lib/run-display";
import { runSessionPath } from "../lib/run-session-route";
import RunSelector, {
  queryRunPage,
  runPageQueryKey,
  RunStatusBadge,
} from "../components/RunSelector";
import RunWorkspaceDialog from "../components/RunWorkspaceDialog";

interface RunSessionViewProps {
  owner: RunOwner;
}

/** 固定入口右栏：URL 中的显式 run 永远优先，缺省时才跟随第一页最新项。 */
export default function RunSessionView({ owner }: RunSessionViewProps) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const explicitRunId = positiveId(searchParams.get("run"));
  const latestQuery = useQuery({
    queryKey: runPageQueryKey(owner, 1),
    queryFn: () => queryRunPage(owner, 1),
  });
  const selectedRunId = explicitRunId ?? latestQuery.data?.items[0]?.id;
  const runQuery = useQuery({
    queryKey: ["automation", "run", selectedRunId],
    queryFn: () => AutomationApi.runById(selectedRunId!),
    enabled: selectedRunId !== undefined,
  });
  const listedRun = latestQuery.data?.items.find(
    (run) => run.id === selectedRunId,
  );
  const selectRun = useCallback(
    (runId: number) => navigate(runSessionPath(owner, runId)),
    [navigate, owner],
  );

  usePageHeader({
    trailing: (
      <>
        <RunSelector
          owner={owner}
          currentRun={runQuery.data ?? listedRun}
          onSelect={selectRun}
        />
        <SessionSearchBox />
      </>
    ),
  });

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {runQuery.data ? (
        <RunConversation key={runQuery.data.id} run={runQuery.data} />
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
    />
  ) : null;
  const isGraph = run.graphId !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isGraph && <GraphRunResult run={run} trace={trace} />}
      {!canFollowUp && <TerminalRunStatus run={run} />}
      {canFollowUp && !isGraph && !session && run.error && (
        <p className="border-b border-border/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {localizeRunError(run.error, t)}
        </p>
      )}
      {chatPane}
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

function GraphRunResult({
  run,
  trace,
}: {
  run: AutomationRunDetail;
  trace: ReturnType<typeof parseTrace>;
}) {
  const { t } = useTranslation(["chat"]);
  const finalOutput = trace
    .slice()
    .reverse()
    .find((entry) => entry.outputPreview)?.outputPreview;
  return (
    <section className="max-h-[55%] shrink-0 overflow-y-auto border-b border-border/50 px-4 py-3">
      <details open className="mb-3 rounded-lg border border-border/50 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("chat:runSession.resultSummary")}
        </summary>
        {(run.error || finalOutput) && (
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            {localizeRunError(run.error, t) || finalOutput}
          </pre>
        )}
      </details>
      <GraphRunTraceView trace={trace} runId={run.id} />
    </section>
  );
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

function isWorkspaceRequired(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("RUN_WORKSPACE_REQUIRED")
  );
}

function isWorkspaceCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "RUN_WORKSPACE_CANCELLED";
}
