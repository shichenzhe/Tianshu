/**
 * 右栏浏览器 tab：BrowserToolbar + BrowserWebview 组合（WorkBuddy 实态：
 * 工具栏一行——返回/前进/刷新 + 地址栏，地址栏即输入口，页面区 url 空 →
 * 空白占位）。props 驱动复用 ai/browser 域组件，不接全局 browser.store——
 * tab 负载 url 存 detail-panel.store，其余瞬时状态本地持有；重挂按 url 恢复。
 * partition 与浏览器页共享（登录态/安全守卫自动生效，spec §4）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserTab } from "@/domains/ai/browser/store/browser.store";
import BrowserToolbar from "@/domains/ai/browser/components/BrowserToolbar";
import BrowserWebview from "@/domains/ai/browser/components/BrowserWebview";
import { readWebContentsId } from "@/domains/ai/browser/lib/webview-api";
import { send } from "@/lib/ipc";
import {
  useDetailPanelStore,
  type DetailTab,
} from "../../store/detail-panel.store";

interface BrowserPanelTabProps {
  sessionId: number;
  tab: DetailTab;
  isActive: boolean;
}

export default function BrowserPanelTab({
  sessionId,
  tab,
  isActive,
}: BrowserPanelTabProps) {
  const syncTab = useDetailPanelStore((s) => s.syncTab);
  // 完整 BrowserTab 形状本地持有（title/favicon 等瞬时态）；url 以 store
  // 负载为源（syncTab 回写后经 props 回流保持一致）
  const [browserTab, setBrowserTab] = useState<BrowserTab>(() => ({
    id: tab.id,
    url: tab.url ?? "",
    title: "",
    favicon: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  }));
  const webviewRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node) webviewRefs.current.set(id, node);
    else webviewRefs.current.delete(id);
  }, []);

  // browser_use 绑定上报：dom-ready 后取 guest id 绑定会话（AI 操控目标）
  const handleDomReady = useCallback(() => {
    const wcId = readWebContentsId(webviewRefs.current.get(tab.id) ?? null);
    if (wcId !== null) {
      send("browser:bindSession", wcId, sessionId);
    }
  }, [tab.id, sessionId]);

  const handleSync = useCallback(
    (partial: Partial<BrowserTab>) => {
      setBrowserTab((prev) => ({ ...prev, ...partial }));
      // url 变化回写 store 负载（重挂恢复凭据）
      if (typeof partial.url === "string" && partial.url !== (tab.url ?? "")) {
        syncTab(sessionId, tab.id, { url: partial.url });
      }
    },
    [sessionId, tab.id, tab.url, syncTab],
  );

  // 面板联动（browse 复用 tab）吸收路径：store 负载 url 被联动桥
  // 外部改写时同步进本地 browserTab——BrowserWebview 以 url prop 变化派发
  // loadURL，本地态不吸收则复用路径不导航（挂载路径 initial state 已覆盖，
  // W5 冒烟实锤）。同值 no-op：did-navigate 回写（onSync→store→props 回流）
  // 与本效应互不成环
  useEffect(() => {
    setBrowserTab((prev) =>
      prev.url === (tab.url ?? "") ? prev : { ...prev, url: tab.url ?? "" },
    );
  }, [tab.url]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <BrowserToolbar
        tab={browserTab}
        getWebviewNode={() => webviewRefs.current.get(tab.id) ?? null}
        onSync={handleSync}
        autoFocusAddress={isActive}
      />
      <div className="min-h-0 flex-1">
        <BrowserWebview
          tab={browserTab}
          isActive={isActive}
          registerRef={registerRef}
          onSync={handleSync}
          onDomReady={handleDomReady}
        />
      </div>
    </div>
  );
}
