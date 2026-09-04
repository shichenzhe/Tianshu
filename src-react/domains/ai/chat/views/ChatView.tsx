/**
 * AI 对话主界面：左侧会话侧边栏 + 右侧消息区/输入区
 * 工作空间选中态在此提升（输入区需解析会话生效模型），会话数据经共享
 * React Query 缓存派生，setModel/setAssistant 失效后即为最新值
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProviderApi } from "../../api/provider.api";
import { ModelApi } from "../../api/model.api";
import SessionApi, { type SessionRecord } from "../../api/session.api";
import type { ChatModelParams } from "../../api/chat.api";
import { WorkspaceApi, type WorkspaceRecord } from "../../api/workspace.api";
import SessionSidebar from "../components/SessionSidebar";
import MessageList from "../components/MessageList";
import ChatInput from "../components/ChatInput";
import ModelPicker from "../components/ModelPicker";
import AssistantPicker from "../components/AssistantPicker";
import AgentProgress from "../components/AgentProgress";
import WorkspacePathChip from "../components/WorkspacePathChip";
import { useChatSend } from "../hooks/use-chat-send";
import { useChatStore } from "../store/chat.store";
import { mapIpcError } from "../lib/error-message";

const WORKSPACES_KEY = ["workspaces"] as const;
const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;
const PROVIDERS_ROUTE = "/module/ai/providers";
const ASSISTANTS_ROUTE = "/module/ai/assistants";

export default function ChatView() {
  const navigate = useNavigate();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(
    null,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );

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
    queryKey: ["sessions", activeWorkspaceId],
    queryFn: () => SessionApi.listByWorkspace(activeWorkspaceId as number),
    enabled: activeWorkspaceId !== null,
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

  // 后端保证至少有一个默认工作空间，首次加载后自动选中
  useEffect(() => {
    if (activeWorkspaceId === null && workspaces.length > 0) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [activeWorkspaceId, workspaces]);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;

  // 切换工作空间时同步清空会话选中态
  const handleSelectWorkspace = (workspaceId: number | null) => {
    setActiveWorkspaceId(workspaceId);
    setSelectedSessionId(null);
  };

  return (
    <div className="flex h-full">
      <SessionSidebar
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        selectedSessionId={selectedSessionId}
        onSelectSession={setSelectedSessionId}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：已绑定工作空间目录时展示路径 chip（重绑/解绑入口） */}
        {activeWorkspace?.directoryPath && (
          <WorkspacePathChip workspace={activeWorkspace} />
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
            onOpenAssistants={() => navigate(ASSISTANTS_ROUTE)}
          />
        ) : (
          <MessageList sessionId={null} />
        )}
      </div>
    </div>
  );
}

interface ChatPaneProps {
  session: SessionRecord;
  /** 会话所属工作空间（即当前选中项），供审批横幅取 id 与写授权态 */
  workspace: WorkspaceRecord | null;
  hasModel: boolean;
  onOpenAssistants: () => void;
}

/**
 * 单会话面板：useChatSend 唯一实例在此，输入框与消息列表共享 sending
 * 状态；key 取会话 id，切换会话时重建（流监听与节流缓冲随之隔离）
 */
function ChatPane({
  session,
  workspace,
  hasModel,
  onOpenAssistants,
}: ChatPaneProps) {
  const { t } = useTranslation(["chat", "ai"]);
  const { sending, send, regenerate, stop } = useChatSend(session.id);

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

  const handleSend = async (content: string, overrides?: ChatModelParams) => {
    try {
      await send(content, undefined, overrides);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleRegenerate = async () => {
    try {
      await regenerate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <>
      <MessageList
        sessionId={session.id}
        workspaceId={workspace?.id ?? null}
        rememberAvailable={workspace ? !workspace.writeApprovedAt : false}
        onRegenerate={handleRegenerate}
      />
      {sending && (
        <AgentProgress stepCount={stepCount} activeTool={activeTool} />
      )}
      <div className="border-t border-border/50 p-4">
        <div className="flex items-end gap-2">
          <ModelPicker
            sessionId={session.id}
            currentModelId={session.currentModelId}
          />
          <AssistantPicker
            sessionId={session.id}
            currentAssistantId={session.assistantId}
          />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
                  onClick={onOpenAssistants}
                  aria-label={t("ai:assistant.pageTitle")}
                >
                  <Settings2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("ai:assistant.pageTitle")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <ChatInput
            hasModel={hasModel}
            sending={sending}
            onSend={handleSend}
            onStop={stop}
          />
        </div>
      </div>
    </>
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
