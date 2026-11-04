/**
 * close bridge 渲染层（spec §4.4）：订阅 close-request → resolveDirtyTabs
 * （调用方逐 dirty tab 弹确认，见 FileWindowView CloseConfirmBar）→
 * ok=confirmClose / cancelled=cancelClose；空窗自动关——restored 完成后
 * tabs 归零即关（WorkBuddy 同款；restored 前不触发，防 bootstrap 竞态误关）。
 */
import { useEffect } from "react";
import FileWindowApi from "../api/file-window.api";
import { useFileWindowStore } from "../store/file-window.store";

export function useCloseBridge(opts: {
  windowId: string;
  resolveDirtyTabs: () => Promise<"ok" | "cancelled">;
}): void {
  const { windowId, resolveDirtyTabs } = opts;
  useEffect(() => {
    // 防重入：确认期间再收 close-request（15s 内重复点 X）不重弹
    let inFlight = false;
    const off = FileWindowApi.onCloseRequest(() => {
      if (inFlight) return;
      inFlight = true;
      void resolveDirtyTabs()
        .then((r) =>
          r === "ok"
            ? FileWindowApi.confirmClose(windowId)
            : FileWindowApi.cancelClose(windowId),
        )
        .catch(() => {
          // confirm/cancel 失败交主进程 15s 超时复位，静默即可
        })
        .finally(() => {
          inFlight = false;
        });
    });
    return off;
  }, [windowId, resolveDirtyTabs]);

  // 空窗自动关：prev>0 → 0 且已 restored（恢复到空/初始空窗不触发）
  useEffect(() => {
    const unsub = useFileWindowStore.subscribe((s, prev) => {
      if (prev.tabs.length > 0 && s.tabs.length === 0 && s.restored) {
        void FileWindowApi.confirmClose(windowId).catch(() => {});
      }
    });
    return unsub;
  }, [windowId]);
}
