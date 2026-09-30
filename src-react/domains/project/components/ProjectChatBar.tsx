/**
 * 项目页快速发起条（一期会话统一 D3）：ChatInput 贯穿工作台各 Tab，发送
 * 受理即跳转 /module/ai?session=<id>——流式输出、进度与审批横幅由 ChatView
 * 的 ChatPane 承载（chat.store 全局流态；ChatPane 挂载先订阅流再经
 * chat:status 快照恢复，跨视图无内容丢失，见 use-chat-send.ts）。
 * 保留：权限胶囊/本地任务开关/#待办联想/能力挂载过滤集、计划缓存失效联动
 * （发送时挂一次性流结束监听——跳转卸载后组件 effect 不再可观测）、/compact。
 * 另导出 needsChatSetup/chatSettingsRoute（批 6 自 ActivityPane 迁入：
 * 动态 Tab 删除后该文件不再存在，ProjectWorkspaceView 消费链保持）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import ChatApi, {
  onChatStream,
  type ChatModelParams,
} from "@/domains/ai/api/chat.api";
import ChatInput from "@/domains/ai/chat/components/ChatInput";
import type { AccessMode } from "@/domains/ai/chat/components/PermissionCapsule";
import type { PendingFile } from "@/domains/ai/chat/lib/pending-file";
import { buildInjectedContent } from "@/domains/ai/chat/lib/build-injected-content";
import { useChatSend } from "@/domains/ai/chat/hooks/use-chat-send";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import PlanItemApi, {
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
} from "@/domains/project/api/plan-item.api";
import type { ProjectDetail } from "../../../../electron/domains/project/project.entity";

const PROVIDERS_ROUTE = "/module/ai/providers";
const EXPERTS_ROUTE = "/module/ai/experts";
const CONNECTORS_ROUTE = "/module/ai/experts?tab=connectors";

/** 能力管理目标 → 管理页路由（底栏 onOpenSettings 回调的映射，批 6 自
 *  ActivityPane 迁入） */
export const chatSettingsRoute = (
  target: "providers" | "assistants" | "mcp",
): string =>
  target === "providers"
    ? PROVIDERS_ROUTE
    : target === "mcp"
      ? CONNECTORS_ROUTE
      : EXPERTS_ROUTE;

/**
 * 底栏渲染判据（双查询都成功返回且为空才引导——避免加载/出错期间误判，
 * 同 ChatView）：providers/models 双空时不渲染输入框（批 6 自 ActivityPane
 * 迁入，ProjectWorkspaceView 消费）
 */
export const needsChatSetup = (
  providersQuery: { isSuccess: boolean; data?: unknown[] },
  modelsQuery: { isSuccess: boolean; data?: unknown[] },
): boolean =>
  providersQuery.isSuccess &&
  modelsQuery.isSuccess &&
  (providersQuery.data ?? []).length === 0 &&
  (modelsQuery.data ?? []).length === 0;

interface ProjectChatBarProps {
  detail: ProjectDetail;
  onOpenSettings: (target: "providers" | "assistants" | "mcp") => void;
}

/** 本地任务开关指令（T8）：开启时追加到消息末尾，引导 AI 建的待办
    落为本地任务（projectId 置空，不进项目计划） */
const LOCAL_TASK_DIRECTIVE =
  "\n\n[用户要求] 本次创建或更新的待办事项请存储为本地任务（projectId 置空，不出现在项目计划中）。";

/**
 * 流结束失效计划缓存（跨组件生命周期）：快速发起受理即跳转后本组件随
 * 路由卸载，原 prevSendingRef effect 无法再观测 sending 收尾——改为发送
 * 时挂一次性 chat:stream 监听（finish/error 时失效并自解绑）。AI 工具可
 * 能已在主进程直写计划清单（plan_* 工具），失效驱动五视图/徽标/#待办
 * 建议实时反映（spec 决策 6 渲染侧补完）
 */
function invalidatePlanCachesOnStreamEnd(options: {
  sessionId: number;
  projectId: number;
  userId: number;
  queryClient: QueryClient;
}): void {
  const { sessionId, projectId, userId, queryClient } = options;
  const off = onChatStream(sessionId, (chunk) => {
    if (chunk.type !== "finish" && chunk.type !== "error") {
      return;
    }
    off();
    void queryClient.invalidateQueries({
      queryKey: PLAN_ITEMS_KEY(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: PLAN_ITEMS_MINE_KEY(userId),
    });
  });
}

export default function ProjectChatBar({
  detail,
  onOpenSettings,
}: ProjectChatBarProps) {
  const { t } = useTranslation(["chat", "project"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = detail.session;
  const { sending, send, stop } = useChatSend(session.id);
  const [accessMode, setAccessMode] = useState<AccessMode>("default");
  // 本地任务开关（T8）：＋菜单内切换，发送时按开关态追加指令
  const [localTask, setLocalTask] = useState(false);

  // 项目计划事项（# 待办联想数据源；与计划 Tab 单表数据源同缓存，
  // 组件仅在会话可用时渲染——即探索口径的 enabled hasChat 门控）
  const { data: planItems = [] } = useQuery({
    queryKey: PLAN_ITEMS_KEY(detail.project.id),
    queryFn: () => PlanItemApi.list(detail.project.id),
  });
  const userId = useUserStore((state) => state.user.id);

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

  /**
   * 快速发起（D3）：发送受理即跳 ChatView，流式/审批由 ChatPane 承接。
   * chat:send 直至整条流结束才 resolve（chat.service.ts send 内
   * await streamAndPersist），若 await 到底再跳，用户将在无进度（本批删
   * AgentProgress）、无审批入口（本批删横幅）的项目页枯等整轮生成——
   * 故不等流结束（R1 分析：ChatPane 同 session.id 挂载后先订阅流再经
   * chat:status 快照恢复，卸载窗口的 chunk 由主进程照常持久化，不丢内容）
   */
  const handleSend = async (
    content: string,
    files: PendingFile[],
    overrides?: ChatModelParams,
  ) => {
    const injected = buildInjectedContent(content, files);
    const finalContent = localTask
      ? `${injected}${LOCAL_TASK_DIRECTIVE}`
      : injected;
    try {
      const inFlight = send(finalContent, undefined, overrides);
      invalidatePlanCachesOnStreamEnd({
        sessionId: session.id,
        projectId: detail.project.id,
        userId,
        queryClient,
      });
      navigate(`/module/ai?session=${session.id}`);
      // 等到流末仅取其拒绝语义：早期失败（并发/无模型等）时此处抛出 →
      // catch 全局 toast；卸载后继续执行不影响。原 bumpSendVersion 广播
      // 已随 ActivityPane 删除移除（消费方不复存在，批 6 清理）
      await inFlight;
    } catch (e) {
      // 早期失败（并发/无模型等）时已跳走：sonner 全局 toast 在 ChatView 仍
      // 可见；流中错误经 error chunk 由 ChatPane 侧提示
      toast.error(mapIpcError(e));
      // rethrow：保持调用链 Promise 拒绝语义（ChatInput 乐观清空后的 void catch）
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
