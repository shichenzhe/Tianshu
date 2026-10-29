/**
 * 面板联动桥（web 工具 browse）：订阅 detailPanel:openBrowser——
 * 仅当前选中会话响应（他话不抢视图）；复用该会话最后一个浏览器 tab 回写
 * url（无则新建并激活）；右栏未开自动展开。tab 标题词条复用
 * detailPanel.browser。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { on } from "@/lib/ipc";
import { useAiUiStore } from "../../store/ai-ui.store";
import { useDetailPanelStore } from "../store/detail-panel.store";

export function useDetailPanelBridge(activeSessionId: number | null): void {
  const { t } = useTranslation(["chat"]);
  useEffect(() => {
    return on("detailPanel:openBrowser", (_event, payload) => {
      if (
        activeSessionId == null ||
        !payload ||
        typeof payload !== "object" ||
        (payload as { sessionId?: unknown }).sessionId !== activeSessionId ||
        typeof (payload as { url?: unknown }).url !== "string" ||
        !(payload as { url: string }).url
      ) {
        return;
      }
      const url = (payload as { url: string }).url;
      const store = useDetailPanelStore.getState();
      const state = useDetailPanelStore.getStateOf(activeSessionId);
      const existing = [...state.tabs]
        .reverse()
        .find((tab) => tab.kind === "browser");
      if (existing) {
        store.syncTab(activeSessionId, existing.id, { url });
        store.setActive(activeSessionId, existing.id);
      } else {
        store.openTab(
          activeSessionId,
          "browser",
          t("chat:detailPanel.browser"),
        );
        const created = useDetailPanelStore
          .getStateOf(activeSessionId)
          .tabs.at(-1);
        if (created) store.syncTab(activeSessionId, created.id, { url });
      }
      useAiUiStore.getState().setArtifactsOpen(true);
    });
  }, [activeSessionId, t]);
}
