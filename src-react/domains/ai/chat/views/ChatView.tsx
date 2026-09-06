/**
 * AI 对话主界面：消息区/输入区（标准侧边栏由 AiLayout 提供）
 * 当前空间由选中任务派生（侧边栏分组树已展示全部空间），会话数据经共享
 * React Query 缓存派生，setModel/setAssistant/setMode 失效后即为最新值
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
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
import SessionApi, { type SessionRecord } from "../../api/session.api";
import ChatApi, { type ChatModelParams } from "../../api/chat.api";
import { WorkspaceApi, type WorkspaceRecord } from "../../api/workspace.api";
import MessageList from "../components/MessageList";
import ChatInput from "../components/ChatInput";
import type { PendingFile } from "../lib/pending-file";
import type { AccessMode } from "../components/PermissionCapsule";
import AgentProgress from "../components/AgentProgress";
import WorkspacePathChip from "../components/WorkspacePathChip";
import ArtifactsPanel, {
  ArtifactsPanelToggle,
} from "../components/artifacts/ArtifactsPanel";
import { useChatSend } from "../hooks/use-chat-send";
import { useChatStore } from "../store/chat.store";
import { useAiUiStore } from "../../store/ai-ui.store";
import { mapIpcError } from "../lib/error-message";

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
    <div className="flex h-full flex-col">
      {/* 顶栏：有会话时渲染；左路径 chip（绑定时）+ 右产物面板开关 */}
      {selectedSession && (
        <div className="flex items-center justify-between px-4 pt-2">
          {activeWorkspace?.directoryPath ? (
            <WorkspacePathChip workspace={activeWorkspace} />
          ) : (
            <span />
          )}
          <ArtifactsPanelToggle />
        </div>
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
  );
}

interface ChatPaneProps {
  session: SessionRecord;
  /** 会话所属工作空间（即当前选中项），供审批横幅取 id 与写授权态 */
  workspace: WorkspaceRecord | null;
  hasModel: boolean;
  onOpenSettings: (target: "providers" | "assistants" | "mcp") => void;
}

/**
 * 单会话面板：useChatSend 唯一实例在此，输入框与消息列表共享 sending
 * 状态；key 取会话 id，切换会话时重建（流监听与节流缓冲随之隔离）
 */
function ChatPane({
  session,
  workspace,
  hasModel,
  onOpenSettings,
}: ChatPaneProps) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const { sending, send, regenerate, stop } = useChatSend(session.id);
  const [accessMode, setAccessMode] = useState<AccessMode>("default");
  const artifactsOpen = useAiUiStore((s) => s.artifactsOpen);

  // 会话权限态：挂载时拉取初始化（key=session.id 保证切换会话重建）；
  // 拉取失败保持默认态，后续 setPermission 失败会 toast 兜底
  useEffect(() => {
    let cancelled = false;
    ChatApi.getPermission(session.id)
      .then((mode) => {
        if (!cancelled) {
          setAccessMode(mode);
        }
      })
      .catch(() => {
        /* 静默：胶囊保持默认权限展示 */
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  /** 胶囊决议：先落主进程权限存储，成功后更新本地态（失败保持原状并提示） */
  const handleAccessModeChange = async (mode: AccessMode) => {
    try {
      await ChatApi.setPermission(session.id, mode);
      setAccessMode(mode);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  // Agent 进度数据：选择器只返回原始值（活跃工具 id/名、步数），流式 delta
  // 不触发本面板重渲染，仅轮次切换或活跃工具变化时更新
  const activeToolId = useChatStore((state) => {
    const tools = state.streams[session.id]?.tools;
    if (!tools) {
      return undefined;
    }
    for (let i = tools.order.length - 1; i >= 0; i -= 1) {
      const id = tools.order[i];
      const entry = tools.map[id];
      if (
        entry &&
        (entry.state === "running" || entry.state === "awaiting-approval")
      ) {
        return id;
      }
    }
    return undefined;
  });
  const activeTool = useChatStore((state) => {
    if (!activeToolId) {
      return undefined;
    }
    return state.streams[session.id]?.tools.map[activeToolId]?.toolName;
  });
  // 工具执行中：步数 = 该工具在调用序中的位置（从 1 计）；
  // 纯文本生成轮：步数 = 下一轮 = 已有工具条数 + 1
  const stepCount = useChatStore((state) => {
    const tools = state.streams[session.id]?.tools;
    if (!tools) {
      return 1;
    }
    if (activeToolId) {
      const index = tools.order.indexOf(activeToolId);
      return (index === -1 ? tools.order.length : index) + 1;
    }
    return tools.order.length + 1;
  });

  /** 文件引用注入在渲染层完成（spec §5）：逐文件前缀块 + 原输入，主进程零改动 */
  const handleSend = async (
    content: string,
    files: PendingFile[],
    overrides?: ChatModelParams,
  ) => {
    const injected =
      files.length > 0
        ? `${files
            .map((file) =>
              file.kind === "skill"
                ? `[引用技能 ${file.path}]\n${file.content}`
                : `[引用文件 ${file.path}]\n${file.content}`,
            )
            .join("\n\n")}\n\n${content}`
        : content;
    try {
      await send(injected, undefined, overrides);
    } catch (e) {
      toast.error(mapIpcError(e));
      // rethrow：保持调用链 Promise 拒绝语义（ChatInput 已乐观清空，此处静默防双弹由其 catch 处理）
      throw e;
    }
  };

  /** /compact 命令:压缩完成置居中提示条并刷新消息(摘要轮已落库) */
  const handleRunCommand = (command: string) => {
    if (command !== "compact") {
      toast.info(t("chat:skills.comingSoon"));
      return;
    }
    ChatApi.compact(session.id)
      .then(() => {
        // sessions 携带 compactedUpToId(提示条随消息流定位);messages 拉压缩轮
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      })
      .catch((e: unknown) => toast.error(mapIpcError(e)));
  };

  const handleRegenerate = async (messageId?: number) => {
    try {
      await regenerate(messageId);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <div className="relative flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList
          sessionId={session.id}
          workspaceId={workspace?.id ?? null}
          compactedUpToId={session.compactedUpToId ?? null}
          onRegenerate={handleRegenerate}
        />
        {sending && (
          <AgentProgress stepCount={stepCount} activeTool={activeTool} />
        )}
        <div className="p-4">
          <ChatInput
            hasModel={hasModel}
            sending={sending}
            sessionId={session.id}
            accessMode={accessMode}
            currentMode={session.mode}
            currentAssistantId={session.assistantId}
            currentModelId={session.currentModelId}
            workspaceId={workspace?.id ?? null}
            onAccessModeChange={(mode) => void handleAccessModeChange(mode)}
            onOpenMcp={() => onOpenSettings("mcp")}
            onRunCommand={handleRunCommand}
            onSend={handleSend}
            onStop={stop}
          />
        </div>
      </div>
      {artifactsOpen && workspace && (
        <ArtifactsPanel sessionId={session.id} workspaceId={workspace.id} />
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
