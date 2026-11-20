/**
 * AI 对话路由壳：普通会话沿用原面板；固定任务/图入口按 run 查看检查点。
 * 普通会话的项目面包屑、产物旁栏与转办入口仍由 OrdinaryChatView 持有。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Settings2 } from "lucide-react";
import type { RunOwner } from "@tianshu/core/run-session";
import IconTooltip from "@/components/common/icon-tooltip";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePageHeader } from "@/components/layout/page-header.store";
import HandoverDialog from "@/domains/project/components/HandoverDialog";
import SessionApi from "../../api/session.api";
import MessageList from "../components/MessageList";
import ChatPane from "../components/ChatPane";
import WorkspacePathChip from "../components/WorkspacePathChip";
import ProjectBreadcrumb from "../components/ProjectBreadcrumb";
import TaskOverview from "../components/artifacts/TaskOverview";
import { useProjectSessionData } from "../lib/project-session";
import SessionSearchBox from "../../layout/components/SessionSearchBox";
import { ArtifactsPanelToggle } from "../components/artifacts/ArtifactsPanel";
import DetailPanel from "../components/detail-panel/DetailPanel";
import { useAiUiStore } from "../../store/ai-ui.store";
import { useHostStore } from "../../data-source/host.store";
import { useDetailPanelBridge } from "../hooks/use-detail-panel-bridge";
import RunSessionView from "../../automation/views/RunSessionView";
import { canonicalRunSessionPath } from "../../automation/lib/run-session-route";
import {
  sessionSettingsPath,
  useSessionPaneData,
} from "../hooks/use-session-pane-data";

const PROVIDERS_ROUTE = "/module/ai/providers";

export default function ChatView() {
  const [searchParams] = useSearchParams();
  const owner = runOwnerFromParams(searchParams);
  return owner ? <RunSessionView owner={owner} /> : <OrdinaryChatView />;
}

function OrdinaryChatView() {
  const navigate = useNavigate();
  const { t } = useTranslation(["chat"]);
  const [searchParams] = useSearchParams();
  // 选中任务进 URL（?session=）：刷新可恢复、全局搜索有跳转落点
  const selectedSessionId = Number(searchParams.get("session")) || null;
  const artifactsOpen = useAiUiStore((state) => state.artifactsOpen);
  // 产物面板与最大化态进入普通会话时归位，避免其他视图残留。
  useEffect(() => {
    useAiUiStore.getState().setArtifactsOpen(false);
    useAiUiStore.getState().setPanelMaximized(false);
  }, []);

  const sessionsQuery = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => SessionApi.listAll(),
  });
  const sessions = sessionsQuery.data ?? [];
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const runSessionsEnabled = useHostStore((state) => state.caps.runSessions);
  const canonicalPath =
    selectedSession && runSessionsEnabled
      ? canonicalRunSessionPath(selectedSession)
      : null;
  useEffect(() => {
    if (canonicalPath) navigate(canonicalPath, { replace: true });
  }, [canonicalPath, navigate]);

  const {
    activeWorkspace,
    workspace: paneWorkspace,
    hasModel,
    needsSetup,
  } = useSessionPaneData(selectedSession);
  // 项目会话上下文：面包屑/任务概览共用项目名与任务事项缓存。
  const { projectId, projectName, planItem } =
    useProjectSessionData(selectedSession);
  const [handoverOpen, setHandoverOpen] = useState(false);
  useDetailPanelBridge(selectedSession?.id ?? null);

  usePageHeader(
    selectedSession
      ? {
          leading: (
            <>
              {projectId != null && projectName != null && (
                <ProjectBreadcrumb
                  projectId={projectId}
                  projectName={projectName}
                  taskTitle={planItem?.title ?? null}
                />
              )}
              {activeWorkspace?.directoryPath && (
                <WorkspacePathChip workspace={activeWorkspace} />
              )}
            </>
          ),
          trailing: (
            <>
              <SessionSearchBox />
              {projectId != null && (
                <IconTooltip label={t("chat:handover.action")}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("chat:handover.action")}
                    onClick={() => setHandoverOpen(true)}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                  </Button>
                </IconTooltip>
              )}
              <ArtifactsPanelToggle />
            </>
          ),
        }
      : null,
  );

  return (
    <div className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {needsSetup ? (
          <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />
        ) : selectedSession ? (
          <ChatPane
            key={selectedSession.id}
            session={selectedSession}
            workspace={paneWorkspace}
            hasModel={hasModel}
            onOpenSettings={(target) => navigate(sessionSettingsPath(target))}
          />
        ) : (
          <MessageList sessionId={null} />
        )}
      </div>

      {selectedSession && artifactsOpen && paneWorkspace && (
        <DetailPanel
          sessionId={selectedSession.id}
          workspaceId={paneWorkspace.id}
          workspace={activeWorkspace}
          topSection={
            projectId != null && planItem ? (
              <TaskOverview planItem={planItem} projectId={projectId} />
            ) : undefined
          }
        />
      )}

      {selectedSession && projectId != null && (
        <HandoverDialog
          open={handoverOpen}
          onOpenChange={setHandoverOpen}
          projectId={projectId}
          sessionId={selectedSession.id}
          assetWorkspaceId={paneWorkspace?.id}
        />
      )}
    </div>
  );
}

function runOwnerFromParams(searchParams: URLSearchParams): RunOwner | null {
  const automationId = positiveId(searchParams.get("automation"));
  if (automationId !== undefined) {
    return { kind: "task", ownerId: automationId };
  }
  const graphId = positiveId(searchParams.get("graphRun"));
  return graphId === undefined ? null : { kind: "graph", ownerId: graphId };
}

function positiveId(raw: string | null): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

interface SetupGuideProps {
  onGoSetup: () => void;
}

function SetupGuide({ onGoSetup }: SetupGuideProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md border-border/50 rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            {t("chat:setupProviders")}
          </CardTitle>
          <CardDescription>{t("chat:setupProvidersTip")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onGoSetup} className="hover:bg-primary-hover">
            {t("chat:goSetup")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
