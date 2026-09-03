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
import { ProviderApi } from "../../api/provider.api";
import { ModelApi } from "../../api/model.api";
import SessionApi, { type SessionRecord } from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import SessionSidebar from "../components/SessionSidebar";
import MessageList from "../components/MessageList";
import ChatInput from "../components/ChatInput";
import ModelPicker from "../components/ModelPicker";
import AssistantPicker from "../components/AssistantPicker";
import { useChatSend } from "../hooks/use-chat-send";

const WORKSPACES_KEY = ["workspaces"] as const;
const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;
const PROVIDERS_ROUTE = "/module/ai/providers";

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
        {needsSetup ? (
          <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />
        ) : selectedSession ? (
          <ChatPane
            key={selectedSession.id}
            session={selectedSession}
            hasModel={Boolean(
              selectedSession.currentModelId ?? activeWorkspace?.defaultModelId,
            )}
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
  hasModel: boolean;
}

/**
 * 单会话面板：useChatSend 唯一实例在此，输入框与消息列表共享 sending
 * 状态；key 取会话 id，切换会话时重建（流监听与节流缓冲随之隔离）
 */
function ChatPane({ session, hasModel }: ChatPaneProps) {
  const { sending, send, regenerate, stop } = useChatSend(session.id);

  const handleSend = async (content: string) => {
    try {
      await send(content);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRegenerate = async () => {
    try {
      await regenerate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <MessageList sessionId={session.id} onRegenerate={handleRegenerate} />
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
