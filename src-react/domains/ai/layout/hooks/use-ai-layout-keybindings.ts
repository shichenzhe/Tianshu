/**
 * AI 布局级快捷键动作接线（17 条命令中的布局级 12 条 → 功能落点）：
 * - 设置面板/会话内搜索/侧栏/产物面板：各 Zustand store 的 getState 直调
 *   （分发层不订阅、不引起重渲染）
 * - 新建任务：导航 /module/ai/new 落地页（发送时才创建会话）；
 *   上/下一任务：会话数据从 React Query 缓存按需读取
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
import { neighborSessionId } from "../../chat/lib/session-actions";
import { useChatStore } from "../../chat/store/chat.store";
import {
  isTextEntryFocused,
  useKeybindingDispatcher,
} from "./use-keybinding-dispatcher";
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

  /** 新建任务：导航 /module/ai/new 落地页（发送时才创建会话） */
  const createConversation = () => navigate("/module/ai/new");

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

  /**
   * 会话内搜索（⌘F，二期批 7）：仅 AI 会话视图且 URL 有选中会话时唤起
   * （搜索对象是当前会话消息；无选中会话不动作，避免 open 残留到下次
   * 进 ChatView 时空开）。输入框聚焦时不劫持——焦点上下文优先，避免
   * 打断输入（分发层的裸键守卫不拦修饰键组合，此处按命令单独收严）
   */
  const openSessionSearch = () => {
    if (currentSessionId === null || isTextEntryFocused()) {
      return;
    }
    useSessionSearchStore.getState().setOpen(true);
  };

  useKeybindingDispatcher({
    openSettings: () => useSettingsUiStore.getState().openSettings(),
    sessionSearch: openSessionSearch,
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
