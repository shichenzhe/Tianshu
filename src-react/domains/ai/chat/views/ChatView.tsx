/**
 * AI 对话主界面：消息区/输入区（标准侧边栏由全局 GlobalSidebar 提供）
 * 当前空间由选中任务派生（侧边栏分组树已展示全部空间），会话数据经共享
 * React Query 缓存派生，setModel/setAssistant/setMode 失效后即为最新值
 * 单会话面板拆至 components/ChatPane（跨模块复用），本视图只做选态派生
 * 布局与项目详情右栏同构：左列（顶栏 + ChatPane）+ 右列产物面板全高
 * 挤压式旁挂（收起时整体移除，开关在顶栏右侧）
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProviderApi } from "../../api/provider.api";
import { ModelApi } from "../../api/model.api";
import SessionApi from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import MessageList from "../components/MessageList";
import ChatPane from "../components/ChatPane";
import WorkspacePathChip from "../components/WorkspacePathChip";
import ArtifactsPanel, {
  ArtifactsPanelToggle,
} from "../components/artifacts/ArtifactsPanel";
import { useAiUiStore } from "../../store/ai-ui.store";

const WORKSPACES_KEY = ["workspaces"] as const;
const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;
const PROVIDERS_ROUTE = "/module/ai/providers";
const ASSISTANTS_ROUTE = "/module/ai/experts";
const MCP_ROUTE = "/module/ai/experts?tab=connectors";

export default function ChatView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 选中任务进 URL（?session=）：刷新可恢复、全局搜索有跳转落点
  const selectedSessionId = Number(searchParams.get("session")) || null;
  const artifactsOpen = useAiUiStore((s) => s.artifactsOpen);
  // 产物面板开关为全局内存态（ChatView 与项目详情 ActivityPane 共用旁挂）：
  // 进入视图时重置收起，防止上一处（如项目详情动态流）的展开态残留
  useEffect(() => {
    useAiUiStore.getState().setArtifactsOpen(false);
  }, []);

  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: MODELS_KEY,
    queryFn: () => ModelApi.listAll(),
  });
  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => WorkspaceApi.list(),
  });
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => SessionApi.listAll(),
  });

  const providers = providersQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  const workspaces = workspacesQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  // 两个查询都成功返回且为空，才展示服务商引导（避免加载/出错期间误判）
  const needsSetup =
    providersQuery.isSuccess &&
    modelsQuery.isSuccess &&
    providers.length === 0 &&
    models.length === 0;

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;

  // 当前空间 = 选中任务所属空间，无选中取第一个（侧边栏分组树已展示全部空间）
  const activeWorkspace =
    workspaces.find(
      (workspace) => workspace.id === selectedSession?.workspaceId,
    ) ??
    workspaces[0] ??
    null;

  return (
    // relative 为产物全屏预览锚点（absolute inset-0 覆盖整个会话视图）
    <div className="relative flex h-full">
      {/* 左列：顶栏 + 消息/输入（或引导态/无会话兜底） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏（样式与项目详情 header 同构）：左路径 chip（绑定时）+ 右产物面板开关 */}
        {selectedSession && (
          <header className="flex items-center justify-between border-b border-border/50 px-4 py-1.5">
            {activeWorkspace?.directoryPath ? (
              <WorkspacePathChip workspace={activeWorkspace} />
            ) : (
              <span />
            )}
            <ArtifactsPanelToggle />
          </header>
        )}
        {needsSetup ? (
          <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />
        ) : selectedSession ? (
          <ChatPane
            key={selectedSession.id}
            session={selectedSession}
            workspace={activeWorkspace}
            hasModel={Boolean(
              selectedSession.currentModelId ?? activeWorkspace?.defaultModelId,
            )}
            onOpenSettings={(target) =>
              navigate(
                target === "providers"
                  ? PROVIDERS_ROUTE
                  : target === "assistants"
                    ? ASSISTANTS_ROUTE
                    : MCP_ROUTE,
              )
            }
          />
        ) : (
          <MessageList sessionId={null} />
        )}
      </div>

      {/* 右列产物面板（与项目详情右栏同构）：全高挤压式，收起时整体移除 */}
      {selectedSession && artifactsOpen && activeWorkspace && (
        <ArtifactsPanel
          sessionId={selectedSession.id}
          workspaceId={activeWorkspace.id}
        />
      )}
    </div>
  );
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
