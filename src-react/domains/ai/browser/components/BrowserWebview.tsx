/**
 * 单 tab 内容区：url 空 → 居中提示（无输入框，输入走工具栏地址栏，参照
 * WorkBuddy）；有 url → <webview>（spec §3.3/3.4）。
 * 事件原生 addEventListener（React 合成事件不支持 webview 事件，照
 * FilePreview.tsx 先例）；webview 常驻不随 active 切换卸载（display 隐藏，
 * 保滚动/表单状态，spec §4.2）。错误态覆盖层（absolute 盖 webview 上，
 * 不卸载 webview——重试走 reload 保 tab 状态）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, RotateCw, ShieldAlert, TriangleAlert } from "lucide-react";
import type { BrowserTab } from "../store/browser.store";
import {
  classifyLoadError,
  applyZoomFactor,
  webviewApi,
} from "../lib/webview-api";

/**
 * allowpopups 经 spread 传：@types/react 内置 W3C WebView 规范的 webview
 * 标签（allowpopups?: boolean）与本项目声明合并后仍是 boolean，但 React
 * 运行时对非标准 boolean 属性会丢弃——必须给字符串字面量让属性进 DOM
 * （Electron 按存在性判定）。开窗由主进程 handler 恒 deny 转新 tab。
 */
const WEBVIEW_POPUPS_PROPS = { allowpopups: "true" } as Record<string, string>;

interface BrowserWebviewProps {
  tab: BrowserTab;
  isActive: boolean;
  registerRef: (id: string, node: HTMLElement | null) => void;
  onSync: (partial: Partial<BrowserTab>) => void;
  /** guest 就绪（dom-ready 后 getWebContentsId 可用；browser_use 绑定上报） */
  onDomReady?: () => void;
}

export default function BrowserWebview({
  tab,
  isActive,
  registerRef,
  onSync,
  onDomReady,
}: BrowserWebviewProps) {
  const { t } = useTranslation(["chat"]);
  const webviewRef = useRef<HTMLElement>(null);
  // dom-ready 最新回调经 ref 转发：监听随 deps [tab.id, tab.url] 的 effect
  // 注册/重绑（两者任一变化重挂事件），不因回调身份变化重绑（依赖膨胀防扩散）
  const onDomReadyRef = useRef(onDomReady);
  useEffect(() => {
    onDomReadyRef.current = onDomReady;
  }, [onDomReady]);
  // 最新缩放经 ref 转发：事件 effect deps 不含 zoomFactor（防重绑扩散），
  // dom-ready 重放时取 ref（照 onDomReadyRef 先例）
  const zoomFactorRef = useRef(tab.zoomFactor ?? 1);
  useEffect(() => {
    zoomFactorRef.current = tab.zoomFactor ?? 1;
    // 变化即应用（菜单 +/- 提交）；guest 未就绪静默，dom-ready 重放兜底
    applyZoomFactor(webviewRef.current, tab.zoomFactor ?? 1);
  }, [tab.zoomFactor]);
  // "blocked"（主进程门拦截）/ "failed"（普通失败）分文案；导航成功即清除
  const [errorKind, setErrorKind] = useState<"blocked" | "failed" | null>(null);

  // ── webview 导航模型（uncontrolled src）──
  // src 属性终生只写挂载初值：受控重写（含 Electron 导航后自同步属性与
  // React props 的交互）会令 Electron 对属性变化调 loadURL → 冗余导航中止
  // 在途导航（GUEST_VIEW_MANAGER_CALL ERR_ABORTED + 页面双重加载，
  // 2026-10-10 baidu setAttribute 陷阱栈实锤）。dispatched 记「webview 已
  // 到达/正在去往的 url」：挂载初值渲染期锁定，did-navigate 回写记账，
  // 地址栏提交时更新并 loadURL——刻意不用 getURL() 判重（guest attach +
  // dom-ready 前调用会抛错炸掉 ErrorBoundary）
  const navRef = useRef<{ mountSrc: string; dispatched: string }>({
    mountSrc: "",
    dispatched: "",
  });
  if (tab.url !== "" && navRef.current.mountSrc === "") {
    navRef.current.mountSrc = tab.url;
    navRef.current.dispatched = tab.url;
  }
  useEffect(() => {
    if (tab.url === "") return;
    if (navRef.current.dispatched === tab.url) return; // 挂载派发中/页面已回写到达
    navRef.current.dispatched = tab.url;
    // 快速连发导航的竞争中止（ERR_ABORTED）为正常语义，静默
    const api = webviewApi(webviewRef.current);
    if (api) void api.loadURL(tab.url).catch(() => {});
  }, [tab.url]);

  useEffect(() => {
    setErrorKind(null);
    const node = webviewRef.current;
    registerRef(tab.id, node);
    if (!node) {
      return;
    }
    const api = webviewApi(node);
    const onDidNavigate = (event: Event) => {
      const e = event as { url?: string };
      setErrorKind(null);
      // 页面已到达此 url（重定向终值/页内导航）：记账防 effect 误判外部提交
      const arrived = typeof e.url === "string" ? e.url : tab.url;
      navRef.current.dispatched = arrived;
      // did-navigate DOM 事件 detail 仅含 url；canGoBack/canGoForward 经
      // 元素方法查询同步（按钮 disabled 依据）
      onSync({
        url: arrived,
        canGoBack: api?.canGoBack() === true,
        canGoForward: api?.canGoForward() === true,
      });
    };
    const onTitle = (event: Event) => {
      const title = (event as { title?: string }).title;
      if (typeof title === "string" && title.trim()) onSync({ title });
    };
    const onFavicon = (event: Event) => {
      const favicons = (event as { favicons?: string[] }).favicons;
      const first = Array.isArray(favicons) ? favicons[0] : "";
      if (typeof first === "string" && first) onSync({ favicon: first });
    };
    const onStartLoading = () => onSync({ isLoading: true });
    const onStopLoading = () => onSync({ isLoading: false });
    const onFail = (event: Event) => {
      // 仅主 frame 失败才整页降级；子 frame（广告/失效嵌入）失败不盖页面
      if ((event as { isMainFrame?: boolean }).isMainFrame === false) return;
      const kind = classifyLoadError(
        (event as { errorCode?: number }).errorCode ?? 0,
      );
      if (kind !== "ignored") setErrorKind(kind);
    };
    const onDomReadyEvent = () => {
      onDomReadyRef.current?.();
      // 跨域导航 Chromium 按域重置缩放：dom-ready 重放 tab 缩放（tab 态为
      // 权威值，不读回 getZoomFactor——菜单所见即页面所得）
      applyZoomFactor(node, zoomFactorRef.current);
    };
    node.addEventListener("did-navigate", onDidNavigate);
    node.addEventListener("did-navigate-in-page", onDidNavigate);
    node.addEventListener("page-title-updated", onTitle);
    node.addEventListener("page-favicon-updated", onFavicon);
    node.addEventListener("did-start-loading", onStartLoading);
    node.addEventListener("did-stop-loading", onStopLoading);
    node.addEventListener("did-fail-load", onFail);
    node.addEventListener("dom-ready", onDomReadyEvent);
    return () => {
      node.removeEventListener("did-navigate", onDidNavigate);
      node.removeEventListener("did-navigate-in-page", onDidNavigate);
      node.removeEventListener("page-title-updated", onTitle);
      node.removeEventListener("page-favicon-updated", onFavicon);
      node.removeEventListener("did-start-loading", onStartLoading);
      node.removeEventListener("did-stop-loading", onStopLoading);
      node.removeEventListener("did-fail-load", onFail);
      node.removeEventListener("dom-ready", onDomReadyEvent);
      registerRef(tab.id, null);
    };
    // tab.id 变化 = webview 重挂（tab 新建/销毁），重绑事件
  }, [tab.id, tab.url]);

  if (tab.url === "") {
    // 居中提示形态（参照 WorkBuddy）：页面区只提示，不含输入框——
    // 网址输入统一走 BrowserToolbar 地址栏（空页 autoFocus，见其
    // autoFocusAddress）；多空 tab 常驻时非 active 隐藏
    return (
      <div
        className="h-full min-h-0"
        style={{ display: isActive ? "flex" : "none" }}
      >
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-subtle">
            <Globe className="h-7 w-7 text-primary" />
          </div>
          <p className="text-sm">{t("chat:browser.emptyHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-0"
      style={{ display: isActive ? "block" : "none" }}
    >
      {errorKind && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          {errorKind === "blocked" ? (
            <ShieldAlert className="h-8 w-8" />
          ) : (
            <TriangleAlert className="h-8 w-8" />
          )}
          <p className="text-xs">
            {errorKind === "blocked"
              ? t("chat:browser.blockedByPolicy")
              : t("chat:browser.loadFailed")}
          </p>
          <p className="max-w-[80%] truncate text-xs opacity-70">{tab.url}</p>
          <button
            type="button"
            onClick={() => {
              setErrorKind(null);
              webviewApi(webviewRef.current)?.reload();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t("chat:browser.retry")}
          </button>
        </div>
      )}
      {/* allowpopups 开：站内 target=_blank 请求需到达主进程决策点（无此
          属性时 guest 内部直接抑制，handler 拦不到）；实际开窗由主进程
          setWindowOpenHandler 恒 deny 并转新 tab（见 browser-session.ts） */}
      <webview
        ref={webviewRef}
        src={navRef.current.mountSrc || tab.url}
        partition="persist:browser-webview"
        webpreferences="contextIsolation=yes,sandbox=yes"
        {...WEBVIEW_POPUPS_PROPS}
        className="h-full min-h-0 w-full"
      />
    </div>
  );
}
