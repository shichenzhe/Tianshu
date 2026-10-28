/**
 * tab 右键菜单（Task 15，spec §7）：在新窗口打开=移动语义（busy=moving
 * → 脏 tab 经 close-confirm 注册表确认 → fileWindow:open 携 sessionId →
 * 本窗 closeTab；先开新窗后关本窗——open 失败 tab 保留不丢；关的是最后
 * 一个 tab 时空窗自动关由 T9 close bridge 接管）、关闭 / 关闭其他 /
 * 关闭右侧（非脏直关，脏逐个确认，取消即中止）、复制路径（workspace=
 * 相对路径 / library=条目名）。
 * 流式中移窗：sessionId 随 resource 走（新窗 use-file-session 复用同一
 * 会话续聊），grant 幂等重注（T14）——本层无需额外处理。
 * 自绘 fixed 弹层（右键挂点无 Radix Trigger 锚位；样式对齐 dropdown-menu
 * z-[75]/border-border/50/rounded-lg 口径），外点/Esc 关闭。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import FileWindowApi from "../api/file-window.api";
import { confirmBeforeClose, resolveTabClosures } from "../lib/close-confirm";
import type { FileWindowResource } from "../model/resource";
import {
  useFileWindowStore,
  type FileWindowTab,
} from "../store/file-window.store";

const ITEM_CLS =
  "flex w-full cursor-pointer items-center rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-primary-subtle hover:text-primary disabled:pointer-events-none disabled:opacity-50";

/** sessionId 随 resource 搬运（liftSessionId 上提的逆操作） */
function resourceWithSession(tab: FileWindowTab): FileWindowResource {
  if (tab.sessionId == null) return tab.resource;
  return { ...tab.resource, sessionId: tab.sessionId };
}

export default function TabContextMenu({
  tabId,
  x,
  y,
  onClose,
}: {
  tabId: string;
  /** 打开菜单的右键坐标（fixed 定位落点） */
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const tabs = useFileWindowStore((s) => s.tabs);
  const tab = tabs.find((t0) => t0.id === tabId);

  // 外点/Esc/滚动 关闭（菜单内点击不冒泡到 document 关单；scroll 不冒泡
  // 但 capture 可捕内容区 overflow-auto 的内层滚动）
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest("[data-fw-tab-menu]")) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  if (!tab) return null;
  const idx = tabs.findIndex((t0) => t0.id === tabId);
  const hasOthers = tabs.length > 1;
  const hasRight = idx < tabs.length - 1;

  const moveToNewWindow = async () => {
    const store = useFileWindowStore.getState();
    const current = store.tabs.find((t0) => t0.id === tabId);
    if (!current || current.busy) return;
    useFileWindowStore.getState().patchTab(tabId, { busy: "moving" });
    // 脏确认前置（不关 tab——落子由移动流程决定；cancel/存失败即中止）
    const ok = await confirmBeforeClose(tabId, () =>
      toast.error(t("chat:fileWindow.saveFailed")),
    );
    if (!ok) {
      useFileWindowStore.getState().patchTab(tabId, { busy: null });
      return;
    }
    const latest = useFileWindowStore
      .getState()
      .tabs.find((t0) => t0.id === tabId);
    if (!latest) return; // 确认期间已被他路关闭
    try {
      // 先开新窗（失败 tab 保留）→ 后关本窗；关最后一个 tab 时空窗自动关
      await FileWindowApi.open([resourceWithSession(latest)]);
      useFileWindowStore.getState().closeTab(tabId);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      useFileWindowStore.getState().patchTab(tabId, { busy: null });
    }
  };

  const closeTab = async () => {
    const ok = await confirmBeforeClose(tabId, () =>
      toast.error(t("chat:fileWindow.saveFailed")),
    );
    if (ok) useFileWindowStore.getState().closeTab(tabId);
  };

  const closeOthers = async () => {
    await resolveTabClosures(
      tabs.filter((t0) => t0.id !== tabId).map((t0) => t0.id),
      true,
      () => toast.error(t("chat:fileWindow.saveFailed")),
    );
  };

  const closeRight = async () => {
    await resolveTabClosures(
      tabs.slice(idx + 1).map((t0) => t0.id),
      true,
      () => toast.error(t("chat:fileWindow.saveFailed")),
    );
  };

  const copyPath = async () => {
    const resource = tab!.resource;
    const value = resource.kind === "workspace" ? resource.path : tab!.title;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("chat:fileWindow.toast.copied"));
    } catch {
      toast.error(t("chat:fileWindow.toast.copyFailed"));
    }
  };

  // item 点击即收菜单（异步动作照跑——store getState 不依赖挂载）
  const runAction = (fn: () => Promise<void>) => () => {
    onClose();
    void fn();
  };

  // 边界防溢出：菜单宽高约 200/180，贴边收拢
  const left = Math.min(x, Math.max(window.innerWidth - 210, 0));
  const top = Math.min(y, Math.max(window.innerHeight - 190, 0));

  return (
    <div
      data-fw-tab-menu
      role="menu"
      style={{ left, top }}
      className="fixed z-[75] min-w-[10rem] rounded-lg border border-border/50 bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLS}
        onClick={runAction(moveToNewWindow)}
      >
        {t("chat:fileWindow.openInNewWindow")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLS}
        onClick={runAction(closeTab)}
      >
        {t("chat:fileWindow.menu.close")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLS}
        disabled={!hasOthers}
        onClick={runAction(closeOthers)}
      >
        {t("chat:fileWindow.menu.closeOthers")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLS}
        disabled={!hasRight}
        onClick={runAction(closeRight)}
      >
        {t("chat:fileWindow.menu.closeRight")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLS}
        onClick={runAction(copyPath)}
      >
        {t("chat:fileWindow.menu.copyPath")}
      </button>
    </div>
  );
}
