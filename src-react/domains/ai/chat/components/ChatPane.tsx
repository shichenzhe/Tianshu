/**
 * 单会话面板（从 ChatView 抽出复用，逻辑与抽取前一致）：useChatSend
 * 唯一实例在此，输入框与消息列表共享 sending 状态；key 取会话 id，
 * 切换会话时重建（流监听与节流缓冲随之隔离）。
 * 项目模块复用时可通过可选过滤集限定＋菜单可选能力（未传不过滤）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { MessageRecord, SessionRecord } from "../../api/session.api";
import ChatApi, { type ChatModelParams } from "../../api/chat.api";
import type { WorkspaceRecord } from "../../api/workspace.api";
import MessageList from "./MessageList";
import ChatInput from "./ChatInput";
import { parseBlocks } from "../model/blocks";
import type { PendingFile } from "../lib/pending-file";
import type { AccessMode } from "./PermissionCapsule";
import AgentProgress from "./AgentProgress";
import ArtifactsPanel from "./artifacts/ArtifactsPanel";
import { useChatSend } from "../hooks/use-chat-send";
import { useChatStore } from "../store/chat.store";
import { useAiUiStore } from "../../store/ai-ui.store";
import { mapIpcError } from "../lib/error-message";
import { truncateMessagesForEdit } from "../lib/truncate-messages-for-edit";

interface ChatPaneProps {
  session: SessionRecord;
  /** 会话所属工作空间（即当前选中项），@ 文件联想/产物面板/审批均按 id 定位。
   *  P2 起仅需 id：AI 视图传完整记录，项目动态流传资产空间
   *  `{ id: assetWorkspaceId }`——资产空间被 workspace:list 过滤，项目侧
   *  不经全局空间列表解析（spec §3.6） */
  workspace: Pick<WorkspaceRecord, "id"> | null;
  hasModel: boolean;
  onOpenSettings: (target: "providers" | "assistants" | "mcp") => void;
  /** 项目动态流：仅展示已挂载专家；未传不过滤（AI 模块行为不变） */
  boundAssistantIds?: number[];
  /** 项目动态流：仅展示已挂载技能（skillRecord.name 匹配） */
  boundSkillNames?: string[];
}

/**
 * 单会话面板：useChatSend 唯一实例在此，输入框与消息列表共享 sending
 * 状态；key 取会话 id，切换会话时重建（流监听与节流缓冲随之隔离）
 */
export default function ChatPane({
  session,
  workspace,
  hasModel,
  onOpenSettings,
  boundAssistantIds,
  boundSkillNames,
}: ChatPaneProps) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const { sending, send, regenerate, editResend, stop } = useChatSend(
    session.id,
  );
  const [accessMode, setAccessMode] = useState<AccessMode>("default");
  // 消息编辑态：messageId 定位待编辑 user 消息，text 为其原文回填；经
  // MessageList 透传到对应 MessageItem，气泡原位替换为 EditBar；进入编辑
  // 由 user 消息 hover 操作栏的编辑按钮（MessageList onEdit）触发
  const [editing, setEditing] = useState<{
    messageId: number;
    text: string;
  } | null>(null);
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
      // 防呆：成功发出新消息后退出编辑态，避免随后的编辑重发静默截断刚发的消息
      setEditing(null);
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

  const handleRegenerate = async (messageId?: number) => {
    try {
      await regenerate(messageId);
    } catch (e) {
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
    try {
      await editResend(messageId, text);
    } catch (e) {
      toast.error(mapIpcError(e));
      void queryClient.invalidateQueries({ queryKey: messagesKey });
    }
  };

  const handleEditCancel = () => setEditing(null);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList
          sessionId={session.id}
          workspaceId={workspace?.id ?? null}
          compactedUpToId={session.compactedUpToId ?? null}
          onRegenerate={handleRegenerate}
          onEdit={handleEdit}
          editing={editing}
          onEditSubmit={handleEditSubmit}
          onEditCancel={handleEditCancel}
        />
        {sending && (
          <AgentProgress stepCount={stepCount} activeTool={activeTool} />
        )}
        {/* 底部输入区常驻（编辑态在消息区原位，与发送态互不干扰） */}
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
            boundAssistantIds={boundAssistantIds}
            boundSkillNames={boundSkillNames}
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
