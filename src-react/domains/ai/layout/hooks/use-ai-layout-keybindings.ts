/**
 * AI 布局级快捷键动作接线（17 条命令中的布局级 12 条 → 功能落点）：
 * - 设置面板/会话内搜索/侧栏/产物面板：各 Zustand store 的 getState 直调
 *   （分发层不订阅、不引起重渲染）
 * - 新建任务与上/下一任务：会话与空间数据从 React Query 缓存按需读取
 *   （SessionTreePanel 挂载即预热），切换经 URL ?session= 导航
 * - 停止生成：URL 会话 + chat.store 流式态判定后调 ChatApi.stop
 * - 全屏：主进程 IPC 窗口翻转；字号三档递进/重置走 font-scale
 * 其余 5 条不在此层：发送/换行在输入框内部（ChatInput/EditBar 读绑定）、
 * 唤起窗口为主进程 globalShortcut（⇧⌥W）、@// 为输入触发符
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  applyFontScale,
  readFontScale,
  stepFontScale,
} from "@/domains/app-settings/model/font-scale";
import { useSettingsUiStore } from "@/domains/app-settings/store/settings-ui.store";
import { invoke } from "@/lib/ipc";
import ChatApi from "../../api/chat.api";
import type { SessionRecord } from "../../api/session.api";
import type { WorkspaceRecord } from "../../api/workspace.api";
import {
  createSessionAndSelect,
  deriveCurrentWorkspaceId,
  neighborSessionId,
} from "../../chat/lib/session-actions";
import { useChatStore } from "../../chat/store/chat.store";
import { useKeybindingDispatcher } from "./use-keybinding-dispatcher";
import { useAiUiStore } from "../../store/ai-ui.store";
import { useSessionSearchStore } from "../../store/session-search.store";

export function useAiLayoutKeybindings(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  // 与 ChatView/SessionTreePanel 同源：当前任务在 URL ?session=
  const currentSessionId = Number(searchParams.get("session")) || null;

  const cachedSessions = () =>
    queryClient.getQueryData<SessionRecord[]>(["sessions", "all"]) ?? [];

  /** 上/下一任务：按任务排序定位后移动，边界（null）不动 */
  const switchToNeighborTask = (delta: 1 | -1) => {
    const targetId = neighborSessionId(
      cachedSessions(),
      currentSessionId,
      delta,
    );
    if (targetId !== null) {
      navigate(`/module/ai?session=${targetId}`, { replace: true });
    }
  };

  /** 新建任务：目标空间与侧边栏「新建任务」同口径（选中任务所属 ∪ 第一个） */
  const createConversation = () => {
    const workspaces =
      queryClient.getQueryData<WorkspaceRecord[]>(["workspaces"]) ?? [];
    void createSessionAndSelect({
      queryClient,
      navigate,
      workspaceId: deriveCurrentWorkspaceId(
        cachedSessions(),
        workspaces,
        currentSessionId,
      ),
    });
  };

  /** 停止生成：仅当前会话有进行中流时调用（失败留渲染层日志：流收尾由主进程侧保障） */
  const stopGeneration = () => {
    if (
      currentSessionId !== null &&
      useChatStore.getState().isStreaming[currentSessionId]
    ) {
      void ChatApi.stop(currentSessionId).catch((error) =>
        console.error("快捷键停止生成失败:", error),
      );
    }
  };

  useKeybindingDispatcher({
    openSettings: () => useSettingsUiStore.getState().openSettings(),
    sessionSearch: () => useSessionSearchStore.getState().setOpen(true),
    newConversation: createConversation,
    stopGeneration,
    previousTask: () => switchToNeighborTask(-1),
    nextTask: () => switchToNeighborTask(1),
    toggleSidebar: () => useAiUiStore.getState().toggleSidebar(),
    toggleArtifacts: () => useAiUiStore.getState().toggleArtifacts(),
    // 主进程未注册通道时（如旧版 dev 窗口）失败仅留渲染层日志，不打扰用户
    toggleFullscreen: () =>
      invoke("window:toggleFullScreen").catch((error) =>
        console.error("快捷键切换全屏失败:", error),
      ),
    zoomIn: () => applyFontScale(stepFontScale(readFontScale(), 1)),
    zoomOut: () => applyFontScale(stepFontScale(readFontScale(), -1)),
    zoomReset: () => applyFontScale("default"),
  });
}
