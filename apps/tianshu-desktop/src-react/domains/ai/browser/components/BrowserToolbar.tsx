/**
 * 导航工具栏：返回/前进/刷新（webview DOM 命令）+ 地址栏 + `...` 更多菜单
 * （WorkBuddy 对齐：查找/缩放/设备工具栏/截图/清数据/外开）。地址栏编辑态
 * 是组件本地 state（编辑中的输入不被页面重定向打断，仅 url 变化时经
 * useEffect 回显）。查找条/设备栏为工具栏下方的条件行。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { copyImageToClipboard } from "@/lib/data-url";
import { invoke } from "@/lib/ipc";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useBrowserStore } from "../store/browser.store";
import type { BrowserTab } from "../store/browser.store";
import { resolveAddressInput } from "../lib/url-input";
import { readWebContentsId, webviewApi } from "../lib/webview-api";
import BrowserMoreMenu from "./BrowserMoreMenu";
import BrowserFindBar from "./BrowserFindBar";
import BrowserDeviceBar from "./BrowserDeviceBar";

interface BrowserToolbarProps {
  tab: BrowserTab;
  /**
   * 惰性取 active webview 节点。刻意不传 HTMLElement 本身：React dev 的
   * logComponentRender 遍历 props 时会读 webview 元素（guest 加载后为跨源
   * frame）→ 同步 SecurityError 炸断 commit 流程 → 宿主整窗点击失效
   * （2026-10-09 卡死排查实锤，勿改回直接传节点）
   */
  getWebviewNode: () => HTMLElement | null;
  /** url 提交通道：缺省回落全局 browser store（/module/ai/browser 页行为不变）；
   *  DetailPanel 内嵌时传右栏 tab 负载回写 */
  onSync?: (partial: Partial<BrowserTab>) => void;
  /** 空页面时地址栏自动聚焦（WorkBuddy：打开浏览器 tab 直接输入网址）。
   *  仅挂载时生效：面板多 tab 常驻（display 隐藏非 active）由调用方传
   *  isActive 防隐藏 tab 抢焦点；浏览器页工具栏只随 activeTab 渲染，缺省 true */
  autoFocusAddress?: boolean;
}

export default function BrowserToolbar({
  tab,
  getWebviewNode,
  onSync,
  autoFocusAddress = true,
}: BrowserToolbarProps) {
  const { t } = useTranslation(["chat"]);
  const [input, setInput] = useState(tab.url);
  const [hint, setHint] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [deviceBarVisible, setDeviceBarVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // url 真变化时回显（重定向/页内导航）；本地编辑中不覆盖
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setInput(tab.url);
  }, [tab.url]);

  const syncTabState = (partial: Partial<BrowserTab>) => {
    if (onSync) {
      onSync(partial);
    } else {
      useBrowserStore.getState().syncTab(tab.id, partial);
    }
  };

  const submit = () => {
    const url = resolveAddressInput(input);
    if (url === null) {
      // 行内提示不 toast（spec §6）
      setHint(true);
      return;
    }
    setHint(false);
    if (url !== tab.url) {
      // 经 store 驱动：空态提交挂 webview，已挂 webview 变更 src 导航。
      // 刻意不手动 blur()：submit 后 guest attach 抢焦点，手动 blur 与之竞争
      // 在 macOS 上有 IME(TSM/IMK) 会话异常风险（排查期观察到 IMK 报错，
      // 保守不恢复）
      syncTabState({ url });
    } else {
      webviewApi(getWebviewNode())?.reload();
    }
  };

  const clearData = (type: "cookies" | "cache") => {
    invoke("browser:clearData", type)
      .then(() => toast.success(t("chat:browser.clearSuccess")))
      .catch((e) => toast.error(mapIpcError(e)));
  };

  const captureScreenshot = () => {
    const wcId = readWebContentsId(getWebviewNode());
    if (wcId === null) {
      toast.error(t("chat:browser.pageNotReady"));
      return;
    }
    invoke<string>("browser:captureScreenshot", wcId)
      .then(async (dataUrl) => {
        // Electron 44 主进程 clipboard 无 writeImage：渲染层 W3C 剪贴板写入
        // （共享件 data-url，聊天导出批收编——mime 从 data: 头提取）
        await copyImageToClipboard(dataUrl);
        toast.success(t("chat:browser.screenshotCopied"));
      })
      .catch((e) => toast.error(mapIpcError(e)));
  };

  const openExternal = () => {
    invoke("browser:openExternal", tab.url).catch((e) =>
      toast.error(mapIpcError(e)),
    );
  };

  const navBtn =
    "rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

  return (
    // 外层 flex-col 包加载条 + 工具栏行 + 条件行（查找/设备）+ 行内提示行
    <div className="flex flex-col border-b border-border/50">
      {/* 加载指示（消费 store.isLoading）：2px 进度条脉冲 */}
      {tab.isLoading && (
        <div className="h-0.5 animate-pulse bg-gradient-to-r from-primary/40 via-primary to-primary/40" />
      )}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <IconTooltip label={t("chat:browser.back")}>
          <button
            type="button"
            className={navBtn}
            aria-label={t("chat:browser.back")}
            disabled={!tab.canGoBack}
            onClick={() => webviewApi(getWebviewNode())?.goBack()}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </IconTooltip>
        <IconTooltip label={t("chat:browser.forward")}>
          <button
            type="button"
            className={navBtn}
            aria-label={t("chat:browser.forward")}
            disabled={!tab.canGoForward}
            onClick={() => webviewApi(getWebviewNode())?.goForward()}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
        </IconTooltip>
        <IconTooltip label={t("chat:browser.reload")}>
          <button
            type="button"
            className={navBtn}
            aria-label={t("chat:browser.reload")}
            onClick={() => webviewApi(getWebviewNode())?.reload()}
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </IconTooltip>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setHint(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          onBlur={() => setInput(tab.url)}
          placeholder={t("chat:browser.addressPlaceholder")}
          autoFocus={autoFocusAddress && tab.url === ""}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 text-xs outline-none focus:border-primary/30"
        />
        <BrowserMoreMenu
          pageReady={tab.url !== ""}
          zoomFactor={tab.zoomFactor ?? 1}
          onZoomChange={(factor) => syncTabState({ zoomFactor: factor })}
          onFindInPage={() => setFindOpen(true)}
          deviceBarVisible={deviceBarVisible}
          onToggleDeviceBar={() => setDeviceBarVisible((v) => !v)}
          onScreenshot={captureScreenshot}
          onClearData={clearData}
          onOpenExternal={openExternal}
        />
      </div>
      {findOpen && (
        <BrowserFindBar
          getWebviewNode={getWebviewNode}
          onClose={() => setFindOpen(false)}
        />
      )}
      {deviceBarVisible && (
        <BrowserDeviceBar
          getWebviewNode={getWebviewNode}
          onClose={() => setDeviceBarVisible(false)}
        />
      )}
      {hint && (
        <p className="px-2 pb-1 text-[10px] text-muted-foreground">
          {t("chat:browser.notUrlHint")}
        </p>
      )}
    </div>
  );
}
