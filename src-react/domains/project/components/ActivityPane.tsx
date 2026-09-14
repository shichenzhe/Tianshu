/**
 * 项目动态流（spec §6.3）：providers/models 双空 → 简版服务商引导卡
 * （照 ChatView.SetupGuide 形态，跳 /module/ai/providers）；否则渲染
 * ChatMessages 消息区——底部输入已提升为工作台级 ProjectChatBar（由
 * ProjectWorkspaceView 渲染贯穿四 Tab），本面板只承载消息与产物旁挂。
 * 消息编辑接线（editing 态 + 重新生成/编辑重发）由本面板自持，语义自
 * ChatPane 复制；发送链 useChatSend 唯一实例在 ProjectChatBar（流订阅
 * 单一来源），此处经 ChatApi 直调 + chat.store 标记流式态，不二次订阅。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { ProviderApi } from "@/domains/ai/api/provider.api";
import { ModelApi } from "@/domains/ai/api/model.api";
import ChatApi from "@/domains/ai/api/chat.api";
import type { MessageRecord } from "@/domains/ai/api/session.api";
import ChatMessages from "@/domains/ai/chat/components/ChatMessages";
import { parseBlocks } from "@/domains/ai/chat/model/blocks";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { truncateMessagesForEdit } from "@/domains/ai/chat/lib/truncate-messages-for-edit";
import { useChatStore } from "@/domains/ai/chat/store/chat.store";
import { useAiUiStore } from "@/domains/ai/store/ai-ui.store";
import type { ProjectDetail } from "../../../../electron/domains/project/project.entity";

const PROVIDERS_ROUTE = "/module/ai/providers";
const EXPERTS_ROUTE = "/module/ai/experts";
const CONNECTORS_ROUTE = "/module/ai/experts?tab=connectors";

/** 能力管理目标 → 管理页路由（底栏 onOpenSettings 与 SetupGuide 同源映射） */
export const chatSettingsRoute = (
  target: "providers" | "assistants" | "mcp",
): string =>
  target === "providers"
    ? PROVIDERS_ROUTE
    : target === "mcp"
      ? CONNECTORS_ROUTE
      : EXPERTS_ROUTE;

/**
 * 动态流引导判据（双查询都成功返回且为空才引导——避免加载/出错期间误判，
 * 同 ChatView）：底栏渲染（ProjectWorkspaceView）与本面板 SetupGuide 分支
 * 共用同一判据取反，保证引导态下不出输入框
 */
export const needsChatSetup = (
  providersQuery: { isSuccess: boolean; data?: unknown[] },
  modelsQuery: { isSuccess: boolean; data?: unknown[] },
): boolean =>
  providersQuery.isSuccess &&
  modelsQuery.isSuccess &&
  (providersQuery.data ?? []).length === 0 &&
  (modelsQuery.data ?? []).length === 0;

interface ActivityPaneProps {
  detail: ProjectDetail;
}

export default function ActivityPane({ detail }: ActivityPaneProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = detail.session;
  // 消息编辑态：messageId 定位待编辑 user 消息，text 为其原文回填；经
  // MessageList 透传到对应 MessageItem，气泡原位替换为 EditBar
  const [editing, setEditing] = useState<{
    messageId: number;
    text: string;
  } | null>(null);
  const artifactsOpen = useAiUiStore((s) => s.artifactsOpen);
  // 流式标记（startStream/finishStream 引用稳定）：发送链在 ProjectChatBar，
  // 此处仅为重发/重新生成标记 sending 态与失败收尾，不订阅流事件
  const startStream = useChatStore((s) => s.startStream);
  const finishStream = useChatStore((s) => s.finishStream);

  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
  });

  if (needsChatSetup(providersQuery, modelsQuery)) {
    return <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />;
  }

  // P2：动态流会话挂在项目资产空间（getDetail 自愈重绑），资产空间被
  // workspace:list 过滤（projectId 非空）——不经全局空间列表解析，直接按
  // assetWorkspaceId 传 id（@ 引用/产物面板据此定位资产目录，spec §3.6）
  const workspace = { id: detail.assetWorkspaceId };

  /**
   * 进入编辑：从消息缓存取该 user 消息的 text 块拼接原文（与消息渲染
   * 同口径）回填 EditBar；缓存缺失时回退空文本（仅禁用态重发按钮）
   */
  const handleEdit = (messageId: number) => {
    const messages = queryClient.getQueryData<MessageRecord[]>([
      "messages",
      session.id,
    ]);
    const target = messages?.find((message) => message.id === messageId);
    const text = target
      ? parseBlocks(target.blocks)
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n")
      : "";
    setEditing({ messageId, text });
  };

  /** 重新生成（任意 assistant 消息）：标记流式后直调 ChatApi（语义同 useChatSend.regenerate + ChatPane 兜底） */
  const handleRegenerate = async (messageId?: number) => {
    startStream(session.id);
    try {
      await ChatApi.regenerate(session.id, messageId);
    } catch (e) {
      finishStream(session.id);
      void queryClient.invalidateQueries({
        queryKey: ["messages", session.id],
      });
      toast.error(mapIpcError(e));
    }
  };

  /**
   * 编辑重发：乐观退出编辑态并同步消息缓存（目标消息换新文本、其后历史
   * 立即截掉，与后端 editAndResend 删尾对齐；流结束 invalidate 拿回真值）；
   * 失败 toast 兜底 + invalidate 恢复服务器真值；messageId 在清空 editing
   * 前捕获（onSubmit 仅在编辑态触发，必然存在）
   */
  const handleEditSubmit = async (text: string) => {
    const messageId = editing?.messageId;
    setEditing(null);
    if (messageId === undefined) {
      return;
    }
    const messagesKey = ["messages", session.id];
    queryClient.setQueryData<MessageRecord[]>(messagesKey, (old) =>
      old ? truncateMessagesForEdit(old, messageId, text) : old,
    );
    startStream(session.id);
    try {
      await ChatApi.editAndResend(session.id, messageId, text);
    } catch (e) {
      finishStream(session.id);
      toast.error(mapIpcError(e));
      void queryClient.invalidateQueries({ queryKey: messagesKey });
    }
  };

  const handleEditCancel = () => setEditing(null);

  return (
    // 内容列全宽（与普通聊天面板同口径——验收反馈：两聊天面板宽度一致）
    <div className="flex min-h-0 w-full flex-1">
      <ChatMessages
        key={session.id}
        session={session}
        workspace={workspace}
        artifactsOpen={artifactsOpen}
        editing={editing}
        onRegenerate={handleRegenerate}
        onEdit={handleEdit}
        onEditSubmit={handleEditSubmit}
        onEditCancel={handleEditCancel}
      />
    </div>
  );
}

interface SetupGuideProps {
  onGoSetup: () => void;
}

/** 简版服务商引导卡（形态同 ChatView.SetupGuide，项目模块内联实现） */
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
