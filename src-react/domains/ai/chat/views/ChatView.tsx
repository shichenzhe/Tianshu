/**
 * AI 对话主界面：消息区/输入区（标准侧边栏由全局 GlobalSidebar 提供）
 * 当前空间由选中任务派生（侧边栏分组树已展示全部空间），会话数据经共享
 * React Query 缓存派生，setModel/setAssistant/setMode 失效后即为最新值
 * 单会话面板拆至 components/ChatPane（跨模块复用），本视图只做选态派生
 * 布局与项目详情右栏同构：左列（顶行迁入 TopBar 中段）+ 右列产物面板
 * 全高挤压式旁挂（收起时整体移除，开关在顶行 trailing，会话内搜索在
 * 开关左边——原 TopBar 右侧孤零零的搜索按钮并入）
 * 项目会话（projectId 非空）附「转办」入口（批 12）：顶行搜索与产物
 * 开关之间 → AI 交接摘要弹框（HandoverDialog，实例本视图持有）
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Settings2 } from "lucide-react";

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
import { ProviderApi } from "../../api/provider.api";
import { ModelApi } from "../../api/model.api";
import SessionApi from "../../api/session.api";
import { WorkspaceApi, type WorkspaceRecord } from "../../api/workspace.api";
import MessageList from "../components/MessageList";
import ChatPane from "../components/ChatPane";
import WorkspacePathChip from "../components/WorkspacePathChip";
import ProjectBreadcrumb from "../components/ProjectBreadcrumb";
import TaskOverview from "../components/artifacts/TaskOverview";
import { useProjectSessionData } from "../lib/project-session";
import SessionSearchBox from "../../layout/components/SessionSearchBox";
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
  const { t } = useTranslation(["chat"]);
  const [searchParams] = useSearchParams();
  // 选中任务进 URL（?session=）：刷新可恢复、全局搜索有跳转落点
  const selectedSessionId = Number(searchParams.get("session")) || null;
  const artifactsOpen = useAiUiStore((s) => s.artifactsOpen);
  // 产物面板开关为全局内存态（批 6 后仅本视图渲染旁挂；进入时重置收起，
  // 防止其他视图/入口的展开态残留）
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

  // 项目会话上下文（批 4）：面包屑/任务概览共用项目名与任务事项缓存
  const { projectId, projectName, planItem } =
    useProjectSessionData(selectedSession);

  // 当前空间 = 选中任务所属空间（列表解析完整记录，目录 chip/默认模型用）
  const activeWorkspace =
    workspaces.find(
      (workspace) => workspace.id === selectedSession?.workspaceId,
    ) ?? null;
  // 面板生效空间：项目会话（资产空间不在全局列表）以会话自身 workspaceId
  // 兜底传 id，语义同项目动态流（ChatPane spec §3.6——资产空间不经列表
  // 解析）；普通会话无选中取第一个（侧边栏分组树已展示全部空间）
  const paneWorkspace: Pick<WorkspaceRecord, "id"> | null =
    activeWorkspace ??
    (selectedSession?.projectId != null
      ? { id: selectedSession.workspaceId }
      : (workspaces[0] ?? null));

  // 转办弹框开关（批 12）：仅项目会话顶行入口可打开
  const [handoverOpen, setHandoverOpen] = useState(false);

  // 页面顶行（TopBar 中段，原页内 header 迁入）：项目会话面包屑在前 +
  // 左路径 chip（绑定时）+ 右侧会话内搜索与产物面板开关（搜索在开关左边，
  // 用户裁定）；无选中会话置空（SessionSearchBox 自身亦有空态隐藏）
  usePageHeader(
    selectedSession
      ? {
          leading: (
            <>
              {/* 项目会话面包屑（批 4 D4）：项目名未就绪不渲染（projects
                  缓存侧边栏常驻预热，窗口极短） */}
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
              {/* 转办（批 12）：仅项目会话；位置在搜索与产物开关之间，
                  按钮口径照 ArtifactsPanelToggle（h-7 w-7 ghost） */}
              {projectId != null && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("chat:handover.action")}
                  title={t("chat:handover.action")}
                  onClick={() => setHandoverOpen(true)}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                >
                  <ArrowRightLeft className="h-4 w-4" />
                </Button>
              )}
              <ArtifactsPanelToggle />
            </>
          ),
        }
      : null,
  );

  return (
    // relative 为产物全屏预览锚点（absolute inset-0 覆盖整个会话视图）
    <div className="relative flex h-full">
      {/* 左列：消息/输入（或引导态/无会话兜底），顶行已迁入 TopBar */}
      <div className="flex min-w-0 flex-1 flex-col">
        {needsSetup ? (
          <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />
        ) : selectedSession ? (
          <ChatPane
            key={selectedSession.id}
            session={selectedSession}
            workspace={paneWorkspace}
            hasModel={Boolean(
              selectedSession.currentModelId ?? activeWorkspace?.defaultModelId,
            )}
            // 项目挂载集是预设而非过滤边界（二期 §3.7 修正）：联想/专家
            // 切换子菜单不做挂载过滤，预设外能力会话中按需可选
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

      {/* 右列产物面板（与项目详情右栏同构）：全高挤压式，收起时整体移除；
          任务会话顶部挂「任务概览」折叠区（批 4，仅 planItemId 非空） */}
      {selectedSession && artifactsOpen && paneWorkspace && (
        <ArtifactsPanel
          sessionId={selectedSession.id}
          workspaceId={paneWorkspace.id}
          topSection={
            projectId != null && planItem ? (
              <TaskOverview planItem={planItem} projectId={projectId} />
            ) : undefined
          }
        />
      )}

      {/* 转办弹框（批 12）：仅项目会话挂实例；打开即调 AI 交接摘要，
          确认后另存为项目待办 */}
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
