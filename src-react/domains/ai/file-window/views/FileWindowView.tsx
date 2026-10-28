/**
 * 文件独立窗口视图（#/file-window?windowId=…，与 /login 平级无侧边栏）：
 * - 登录守卫（语义同 MainLayout：isLoginValid → verifyToken（cancelled
 *   标志防卸载后晚到 falsy 误 reset/跳登录）→ 失效 reset+跳登录；守卫
 *   静默跳转，不弹 toast——独立窗口非用户主入口，token 过期时主进程
 *   会拒后续 invoke，brief 注明可接受）；挂载即 close-ready
 * - 窗口组装（T9/T15）：顶行 FileWindowTabBar（NewTabMenu「+」菜单 +
 *   TabContextMenu 右键菜单）+ 内容区渲染全部 tab（display 隐藏非
 *   active——webview/编辑草稿常驻保状态，脏 tab 切走不丢草稿；照
 *   DetailPanel 同款先例，webview 内存顾虑留 T16 isActive 门）+
 *   key=tab.id（切 tab 不串 draft/query）；无 tab 居中提示「打开文件
 *   以开始」
 * - 最近打开接线（T15）：store 订阅捕获新增 tab → pushRecent（接线点
 *   选视图层——store 不沾 localStorage；快照恢复/deliver 投递同路覆盖）
 * - 会话历史映射接线（T18）：同款订阅——新 tab 无 sessionId seed 映射
 *   最近会话 / sessionId 从无到有（建成/移窗带入）pushSession 置顶
 * - ⌘⇧]/⌘⇧[ 循环切 tab（T17）：全局 keydown，首尾环回，输入框聚焦忽略
 * - 右栏 AI 面板（T10）：仅 active tab 且 aiPanelOpen 时渲染
 *   FileChatPanel（收起/拖宽/头部按钮，会话 T11）
 * - 窗口标题（T21，spec §13 项 1）：挂载即同步 document.title =「天枢
 *   {fileWindow.title}」——页面 <title>天枢</title> 加载后会盖掉主进程
 *   BrowserWindow 的「天枢 文件浏览器」，须渲染层再落一次（语言切换
 *   经 t 依赖重跑）
 * - 关闭握手：close-request → 逐 dirty tab CloseConfirmBar 确认（保存并
 *   关闭/放弃/取消）；确认 asker 经 close-confirm 注册表供 TabContextMenu
 *   （关闭/移动语义）复用；快照：bootstrap 恢复 + 变更防抖落盘（hooks
 *   头注释）
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FileX } from "lucide-react";
import { toast } from "sonner";

import { useUserStore } from "@/domains/user/store/user.store";
import UserApi from "@/domains/user/api/user.api";
import FileWindowApi from "../api/file-window.api";
import {
  useFileWindowStore,
  type FileWindowTab,
} from "../store/file-window.store";
import { useCloseBridge } from "../hooks/use-window-close-bridge";
import { useFileChanged } from "../hooks/use-file-changed";
import {
  bootstrapWindow,
  useSessionSnapshot,
} from "../hooks/use-session-snapshot";
import {
  registerCloseConfirmAsk,
  resolveTabClosures,
  unregisterCloseConfirmAsk,
} from "../lib/close-confirm";
import { pushRecent } from "../lib/recent-files";
import { pushSession, recentSessionOf } from "../lib/session-map";
import { recycleIfEmpty } from "../lib/session-recycle";
import { markFileWindowScope } from "../lib/window-scope";
import FileWindowTabBar from "../components/FileWindowTabBar";
import FileTabContent from "../components/FileTabContent";
import FileChatPanel from "../components/FileChatPanel";
import CloseConfirmBar, {
  type CloseConfirmAnswer,
} from "../components/CloseConfirmBar";

interface ConfirmRequest {
  tab: FileWindowTab;
  resolve: (answer: CloseConfirmAnswer) => void;
}

export default function FileWindowView() {
  const { t } = useTranslation(["chat"]);
  const { user, isLoginValid, reset } = useUserStore();
  // hash 路由下 query 在 hash 内，useSearchParams 不可用，直接解析
  const windowId =
    new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(
      "windowId",
    ) ?? "";
  const tabs = useFileWindowStore((s) => s.tabs);
  const activeTabId = useFileWindowStore((s) => s.activeTabId);
  const activeTab = useFileWindowStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    // 窗口域标记（T22）：捕获 windowId 供主窗路由守卫跳回（hash 导航后
    // query 丢失，模块级单例是唯一来源；见 lib/window-scope）
    markFileWindowScope(windowId);
    if (!isLoginValid()) {
      window.location.hash = "#/login";
      return;
    }
    let cancelled = false;
    const redirectToLogin = () => {
      if (cancelled) return;
      reset();
      window.location.hash = "#/login";
    };
    void UserApi.verifyToken(user.token)
      .then((decoded) => {
        if (!decoded) redirectToLogin();
      })
      .catch(redirectToLogin);
    void FileWindowApi.markCloseReady(windowId);
    return () => {
      cancelled = true;
    };
  }, [isLoginValid, reset, user.token, windowId]);

  // 窗口标题（T21）：主进程建窗 title=「天枢 文件浏览器」会被页面
  // <title>天枢</title> 覆盖——挂载即按当前语言重设（spec §13 项 1）
  useEffect(() => {
    document.title = `天枢 ${t("chat:fileWindow.title")}`;
  }, [t]);

  // 窗口入口编排：快照恢复/deliver 投递 + 防抖落盘
  useEffect(() => bootstrapWindow(windowId), [windowId]);
  useSessionSnapshot(windowId);
  // fileChanged 联动（T12）：外部写盘 → 非脏 tab 静默重载/脏 tab 冲突条
  const queryClient = useQueryClient();
  useFileChanged(queryClient);

  // 最近打开接线（T15）：新增 tab（openTab 成功）→ pushRecent 置顶去重
  useEffect(
    () =>
      useFileWindowStore.subscribe((s, prev) => {
        const prevIds = new Set(prev.tabs.map((x) => x.id));
        s.tabs
          .filter((x) => !prevIds.has(x.id))
          .forEach((x) => pushRecent(x.resource));
      }),
    [],
  );

  // 会话历史映射接线（T18，spec §12 项 4；recent-files 同款订阅——store
  // 不沾 localStorage）：新 tab 无 sessionId 且映射有最近会话 → patchTab
  // seed（seed 的会话可能已被删：发送报 SESSION_NOT_FOUND 时
  // use-file-session 清 tab 绑定 + 摘映射，用户再发即新建）；新 tab 带入
  // sessionId（移窗）与既有 tab sessionId 从无到有（seed/ensureSession
  // 建成）→ pushSession 置顶去重。「新建任务」只解绑不触发（无新 tab、
  // 无从无到有）；快照恢复经 setState 同路覆盖
  useEffect(
    () =>
      useFileWindowStore.subscribe((s, prev) => {
        const prevById = new Map(prev.tabs.map((x) => [x.id, x]));
        s.tabs.forEach((tab) => {
          const before = prevById.get(tab.id);
          if (!before) {
            if (tab.sessionId === undefined) {
              const recent = recentSessionOf(tab.resource);
              if (recent !== null)
                useFileWindowStore
                  .getState()
                  .patchTab(tab.id, { sessionId: recent });
            } else {
              pushSession(tab.resource, tab.sessionId);
            }
            return;
          }
          if (before.sessionId === undefined && tab.sessionId !== undefined)
            pushSession(tab.resource, tab.sessionId);
        });
      }),
    [],
  );

  // ⌘⇧]/⌘⇧[ 循环切 tab（T17，WorkBuddy 同款）：] 下一、[ 上一，首尾
  // 环回；Ctrl 口径同效（Windows）。键形双匹配（审查 I1）：US 布局
  // Shift+] / Shift+[ 在 Chromium 的 e.key 实为 } / {（Windows/Linux 必走
  // }/{；mac Cmd 虽抑制 shift 映射仍发 ]/[，两形都收）；不用 e.code——
  // 非 QWERTY 布局下 code 语义漂移。焦点在 input/textarea/contentEditable
  // 时忽略（DetailPanel T/W 守卫口径，编辑场景不抢键）；无 tab 自然空转
  // 不特判（restored 前恒无 tab）。getState 直读防过期闭包（同上口径）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const forward = e.key === "]" || e.key === "}";
      const backward = e.key === "[" || e.key === "{";
      if (!forward && !backward) return;
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      e.preventDefault();
      const { tabs, activeTabId, activate } = useFileWindowStore.getState();
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((x) => x.id === activeTabId);
      const next = forward
        ? tabs[(idx + 1) % tabs.length]
        : tabs[(idx - 1 + tabs.length) % tabs.length];
      activate(next.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 关闭确认状态机：Promise 由 CloseConfirmBar 按钮落子；新确认替换旧浮
  // 层时先按「取消」落子上一个未裁决的 Promise（X 键确认与 tab 菜单确认
  // 叠加时不留孤儿——等待方 resolveTabClosures/close bridge 不粘死 busy）
  const askConfirm = useCallback(
    (tab: FileWindowTab) =>
      new Promise<CloseConfirmAnswer>((resolve) => {
        setConfirming((prev) => {
          prev?.resolve("cancel");
          return { tab, resolve };
        });
      }),
    [],
  );

  // 确认 asker 注册：tab 菜单（TabContextMenu 关闭/移动语义）复用同一浮层
  useEffect(() => {
    registerCloseConfirmAsk(askConfirm);
    return () => unregisterCloseConfirmAsk();
  }, [askConfirm]);

  const resolveDirtyTabs = useCallback(async (): Promise<
    "ok" | "cancelled"
  > => {
    const result = await resolveTabClosures(
      useFileWindowStore.getState().tabs.map((x) => x.id),
      false,
      () => toast.error(t("chat:fileWindow.saveFailed")),
    );
    // 空会话回收第二挂点（T26，spec §15 项 2）：整窗关闭对非脏 tab 不
    // 逐个 closeTab——ok 后对剩余 tabs 同款判空回收扫描（本窗惰建标记）；
    // cancelled 时窗口未关不扫
    if (result === "ok") {
      for (const tab of useFileWindowStore.getState().tabs) {
        if (tab.sessionCreatedHere && tab.sessionId && tab.busy !== "moving") {
          void recycleIfEmpty(tab.sessionId);
        }
      }
    }
    return result;
  }, [t]);

  useCloseBridge({ windowId, resolveDirtyTabs });

  const handleAnswer = useCallback(
    (answer: CloseConfirmAnswer) => {
      confirming?.resolve(answer);
      setConfirming(null);
    },
    [confirming],
  );

  return (
    <div className="flex h-screen flex-col bg-background">
      <FileWindowTabBar />
      {tabs.length > 0 ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1">
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className="flex h-full min-h-0 flex-col"
                  style={{ display: active ? "flex" : "none" }}
                >
                  <FileTabContent tabId={tab.id} />
                </div>
              );
            })}
          </div>
          {activeTab && activeTab.aiPanelOpen && (
            <FileChatPanel tabId={activeTab.id} />
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <FileX className="h-8 w-8" />
          <p className="text-xs">{t("chat:fileWindow.emptyHint")}</p>
        </div>
      )}
      {confirming && (
        <CloseConfirmBar tab={confirming.tab} onAnswer={handleAnswer} />
      )}
    </div>
  );
}
