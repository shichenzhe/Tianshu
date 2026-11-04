/**
 * 内置浏览器主视图：tab 条挂 TopBar 中段（usePageHeader，照 ExpertsView
 * 先例——TopBar 不再空置、内容上移）+ 页内导航工具栏 + 内容区（每 tab
 * 常驻 webview）。webview ref map 供 toolbar 下发 DOM 导航命令。
 */
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePageHeader } from "@/components/layout/page-header.store";
import { on } from "@/lib/ipc";
import { useBrowserStore } from "../store/browser.store";
import BrowserTabBar from "../components/BrowserTabBar";
import BrowserToolbar from "../components/BrowserToolbar";
import BrowserWebview from "../components/BrowserWebview";

/** 主→渲染开新 tab 事件名（主进程 browser-session.ts 同名常量） */
const OPEN_IN_NEW_TAB_EVENT = "browser:openInNewTab";

function BrowserView() {
  const { t } = useTranslation(["chat"]);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const addTab = useBrowserStore((s) => s.addTab);
  const syncTab = useBrowserStore((s) => s.syncTab);
  // webview 节点登记（导航工具栏按 activeTabId 取节点下命令）
  const webviewRefs = useRef<Map<string, HTMLElement>>(new Map());

  // 首次进入保证至少一个 tab（store 为模块级，重复进入不重置）；判空实时
  // 读 store——dev StrictMode 下 effect 双触发，同闭包 tabs.length 会开出
  // 2 个 tab
  useEffect(() => {
    if (useBrowserStore.getState().tabs.length === 0) addTab();
  }, [tabs.length, addTab]);

  // guest 站内开窗（target=_blank / window.open）由主进程 deny 后转发，
  // 此处以新 tab 打开（浏览器产品行为）
  useEffect(
    () =>
      on(OPEN_IN_NEW_TAB_EVENT, (_event, url) => {
        if (typeof url === "string" && url) {
          useBrowserStore.getState().addTab(url);
        }
      }),
    [],
  );

  // tab 条迁入 TopBar 中段（tab/active 变化由 BrowserTabBar 自订阅 store
  // 驱动重渲染；title 每渲染新引用覆盖写为 page-header 设计内行为）
  usePageHeader({ title: <BrowserTabBar /> });

  const registerRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node) webviewRefs.current.set(id, node);
    else webviewRefs.current.delete(id);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label={t("chat:sidebar.browser")}
    >
      {/* 工具栏在内容区上方（对齐 WorkBuddy 与浏览器惯例，R3 裁定）。
          webview 节点经惰性取值函数传递（直接传节点会被 React dev 的
          props 遍历跨源访问炸断 commit，见 BrowserToolbar 注释） */}
      {activeTab && (
        <BrowserToolbar
          tab={activeTab}
          getWebviewNode={() => webviewRefs.current.get(activeTabId) ?? null}
        />
      )}
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <BrowserWebview
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            registerRef={registerRef}
            onSync={(partial) => syncTab(tab.id, partial)}
          />
        ))}
      </div>
    </div>
  );
}

export default BrowserView;
