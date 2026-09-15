/**
 * 项目工作台底部全局操作栏（spec §6.3/§3）：ChatInput 提升为工作台级——
 * 贯穿动态/计划/任务/资产四 Tab，由 ProjectWorkspaceView 在 Tab 内容区
 * 下方渲染（providers/models 双空引导态不渲染，判据与 ActivityPane 的
 * SetupGuide 同源）。
 * 发送状态块自 ChatPane 复制（useChatSend/accessMode + getPermission 初始化
 * + handleSend 文件引用前缀注入 + handleRunCommand /compact——项目模块
 * 不经私有导入改动 AI 域）；全工作台仅此一个 useChatSend 实例：流订阅与
 * sending 单一来源，动态流消息区（ChatMessages，由 ActivityPane 渲染）的
 * 编辑/重发接线经 ChatApi 直调，不在此二次订阅。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import ChatApi, { type ChatModelParams } from "@/domains/ai/api/chat.api";
import ChatInput from "@/domains/ai/chat/components/ChatInput";
import AgentProgress from "@/domains/ai/chat/components/AgentProgress";
import ApprovalBanner from "@/domains/ai/chat/components/ApprovalBanner";
import type { AccessMode } from "@/domains/ai/chat/components/PermissionCapsule";
import type { PendingFile } from "@/domains/ai/chat/lib/pending-file";
import { useChatSend } from "@/domains/ai/chat/hooks/use-chat-send";
import { useChatStore } from "@/domains/ai/chat/store/chat.store";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import PlanItemApi, {
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
} from "@/domains/project/api/plan-item.api";
import type { ProjectDetail } from "../../../../electron/domains/project/project.entity";

/** 挂起审批的工具（输入区上方横幅数据源，与 MessageList 的门控同口径） */
function usePendingApprovals(
  sessionId: number,
): Array<{ toolCallId: string; toolName: string; argSummary: string }> {
  const tools = useChatStore((state) => state.streams[sessionId]?.tools);
  return useMemo(() => {
    if (!tools) {
      return [];
    }
    return tools.order.flatMap((toolCallId) => {
      const tool = tools.map[toolCallId];
      if (tool?.state !== "awaiting-approval" || !tool.argSummary) {
        return [];
      }
      return [
        { toolCallId, toolName: tool.toolName, argSummary: tool.argSummary },
      ];
    });
  }, [tools]);
}

/** 审批横幅行：write 工具挂起时于底栏输入区上方渲染（可见性跟输入框走） */
function BarApprovalBanner({
  sessionId,
  workspaceId,
}: {
  sessionId: number;
  workspaceId: number | null;
}) {
  const pending = usePendingApprovals(sessionId);
  if (pending.length === 0) {
    return null;
  }
  return (
    <div className="px-4 pt-3">
      {pending.map((entry) => (
        <ApprovalBanner
          key={entry.toolCallId}
          toolCallId={entry.toolCallId}
          toolName={entry.toolName}
          argSummary={entry.argSummary}
          workspaceId={workspaceId}
          onDecided={() => {}}
        />
      ))}
    </div>
  );
}

interface ProjectChatBarProps {
  detail: ProjectDetail;
  onOpenSettings: (target: "providers" | "assistants" | "mcp") => void;
}

/** 本地任务开关指令（T8）：开启时追加到消息末尾，引导 AI 建的待办
    落为本地任务（projectId 置空，不进项目计划） */
const LOCAL_TASK_DIRECTIVE =
  "\n\n[用户要求] 本次创建或更新的待办事项请存储为本地任务（projectId 置空，不出现在项目计划中）。";

/** 引用注入前缀：技能/待办/文件各自专属前缀（待办为 T7 收尾——
    与普通文件区分，便于模型分辨引用来源语义） */
function referencePrefix(file: PendingFile): string {
  if (file.kind === "skill") {
    return `[引用技能 ${file.path}]`;
  }
  if (file.kind === "todo") {
    return `[引用待办 ${file.path}]`;
  }
  return `[引用文件 ${file.path}]`;
}

export default function ProjectChatBar({
  detail,
  onOpenSettings,
}: ProjectChatBarProps) {
  const { t } = useTranslation(["chat", "project"]);
  const queryClient = useQueryClient();
  const session = detail.session;
  const { sending, send, stop } = useChatSend(session.id);
  // 发送版本广播（引用稳定）：成功发送后 +1，动态流面板据此丢弃过期编辑态
  const bumpSendVersion = useChatStore((state) => state.bumpSendVersion);
  const [accessMode, setAccessMode] = useState<AccessMode>("default");
  // 本地任务开关（T8）：＋菜单内切换，发送时按开关态追加指令
  const [localTask, setLocalTask] = useState(false);

  // 项目计划事项（# 待办联想数据源；与计划 Tab 单表数据源同缓存，
  // 组件仅在会话可用时渲染——即探索口径的 enabled hasChat 门控）
  const { data: planItems = [] } = useQuery({
    queryKey: PLAN_ITEMS_KEY(detail.project.id),
    queryFn: () => PlanItemApi.list(detail.project.id),
  });

  // AI 工具可能已在主进程直写计划清单（plan_* 工具）——发送结束失效
  // 计划缓存，驱动五视图/徽标/#待办建议实时反映（spec 决策 6 渲染侧补完）
  const userId = useUserStore((state) => state.user.id);
  const prevSendingRef = useRef(false);
  useEffect(() => {
    if (prevSendingRef.current && !sending) {
      void queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(detail.project.id),
      });
      void queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_MINE_KEY(userId),
      });
    }
    prevSendingRef.current = sending;
  }, [sending, queryClient, detail.project.id, userId]);

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
  // 不触发本组件重渲染，仅轮次切换或活跃工具变化时更新
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

  /** 文件引用注入在渲染层完成（spec §5）：逐文件前缀块 + 原输入，主进程零改动；
      本地任务开关开启时末尾追加指令 */
  const handleSend = async (
    content: string,
    files: PendingFile[],
    overrides?: ChatModelParams,
  ) => {
    const injected =
      files.length > 0
        ? `${files
            .map((file) => `${referencePrefix(file)}\n${file.content}`)
            .join("\n\n")}\n\n${content}`
        : content;
    const finalContent = localTask
      ? `${injected}${LOCAL_TASK_DIRECTIVE}`
      : injected;
    try {
      await send(finalContent, undefined, overrides);
      // 防呆（跨组件版 ChatPane handleSend 的 setEditing(null)）：成功发出
      // 新消息后广播版本 +1——ActivityPane 持有的编辑态随之过期，否则随后
      // 提交的编辑重发会经 editAndResend 截断其后的全部消息（刚发的往来
      // 静默丢失）。发送与编辑态分属两组件，经 store 版本号传递信号
      bumpSendVersion(session.id);
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

  return (
    <div className="flex flex-col border-t border-border/50">
      {sending && (
        <AgentProgress stepCount={stepCount} activeTool={activeTool} />
      )}
      {/* 审批可见性跟输入框走：write 工具挂起审批时横幅渲染于输入区上方，
          否则非动态 Tab（无 MessageList）下流将永久挂起（sending 卡死） */}
      <BarApprovalBanner
        sessionId={session.id}
        workspaceId={detail.assetWorkspaceId}
      />
      <div className="p-4 pt-3">
        <ChatInput
          hasModel={Boolean(session.currentModelId)}
          sending={sending}
          sessionId={session.id}
          accessMode={accessMode}
          currentMode={session.mode}
          currentAssistantId={session.assistantId}
          currentModelId={session.currentModelId}
          workspaceId={detail.assetWorkspaceId}
          boundAssistantIds={detail.bindings
            .filter((b) => b.itemType === "assistant" && b.valid)
            .map((b) => b.itemId)}
          boundSkillNames={detail.bindings
            .filter((b) => b.itemType === "skill" && b.valid)
            .map((b) => b.itemName)}
          todoItems={planItems}
          localTask={{
            enabled: localTask,
            label: t("project:chatBar.localTask"),
            onToggle: setLocalTask,
          }}
          onAccessModeChange={(mode) => void handleAccessModeChange(mode)}
          onOpenMcp={() => onOpenSettings("mcp")}
          onRunCommand={handleRunCommand}
          onSend={handleSend}
          onStop={stop}
          placeholder={
            // 无生效模型时不传项目文案：ChatInput 自身回退 modelRequired
            // 占位提示（placeholder ?? t(hasModel ? ... : modelRequired)），
            // 项目文案不得压制"未选模型"引导
            session.currentModelId
              ? t("project:chatBar.placeholder")
              : undefined
          }
        />
      </div>
    </div>
  );
}
