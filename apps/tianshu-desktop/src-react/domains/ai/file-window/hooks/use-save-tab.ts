/**
 * tab 保存流（spec §5.2）：dirty→saving→写回 saved（基线更新为写回
 * mtime）；FILE_CONFLICT 转 conflict 态由 UI 确认——overwrite=免基线
 * 重写（baselineMtime:null，用户已知外部修改仍选择覆盖）/ reload=放弃
 * 本地修改重读（invalidate fw-file，基线随重读数据落回）。
 * save/resolveConflict 回传写盘结果（mtime）：内容区吸收为新基准
 * （T12 防「draft 非空+mtime 换血」守卫误判自身写回）；写回成功/
 * reload 同撤 externalChanged（磁盘已一致/重读交由用户裁决后收敛）。
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invoke } from "@/lib/ipc";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useFileWindowStore } from "../store/file-window.store";

interface WritableTabResource {
  kind: "workspace";
  workspaceId: number;
  path: string;
}

export interface WriteFileResult {
  absPath: string;
  mtime: number;
}

export function useSaveTab(tabId: string) {
  const [conflict, setConflict] = useState(false);
  const queryClient = useQueryClient();

  const write = useCallback(
    async (
      resource: WritableTabResource,
      content: string,
      baselineMtime: number | null,
    ): Promise<WriteFileResult> => {
      useFileWindowStore.getState().patchTab(tabId, { saveStatus: "saving" });
      const r = (await invoke("workspace:writeFile", {
        workspaceId: resource.workspaceId,
        path: resource.path,
        content,
        baselineMtime,
      })) as WriteFileResult;
      useFileWindowStore.getState().patchTab(tabId, {
        saveStatus: "saved",
        dirty: false,
        baselineMtime: r.mtime,
        // 写回后磁盘即本 tab 内容：外部变更条幅（若挂着）一并撤下
        externalChanged: false,
      });
      // 本窗同路径 tab 与主窗产物预览同步（fileChanged 广播之外的兜底刷新）
      void queryClient.invalidateQueries({ queryKey: ["fw-file"] });
      void queryClient.invalidateQueries({ queryKey: ["artifact-file"] });
      return r;
    },
    [queryClient, tabId],
  );

  const saveAfterConflict = useCallback(
    async (content: string): Promise<WriteFileResult | undefined> => {
      const tab = useFileWindowStore
        .getState()
        .tabs.find((t) => t.id === tabId);
      if (!tab || tab.resource.kind !== "workspace") return;
      try {
        // 免基线重写：用户已知外部修改，选择覆盖磁盘版本
        return await write(tab.resource, content, null);
      } catch (e) {
        useFileWindowStore
          .getState()
          .patchTab(tabId, { saveStatus: "unsaved" });
        toast.error(mapIpcError(e));
      }
    },
    [tabId, write],
  );

  const save = useCallback(
    async (content: string): Promise<WriteFileResult | null> => {
      const tab = useFileWindowStore
        .getState()
        .tabs.find((t) => t.id === tabId);
      if (!tab || tab.resource.kind !== "workspace") return null;
      // in-flight 门：写盘进行中再触发（连点/再 ⌘S）不重复写盘——并发
      // 双写与旧基线误判冲突都被拦截，后续修改等本轮回落后再保存
      if (tab.saveStatus === "saving") return null;
      try {
        return await write(tab.resource, content, tab.baselineMtime);
      } catch (e) {
        if (e instanceof Error && e.message.includes("FILE_CONFLICT")) {
          // 徽标不卡「保存中」：内容仍未保存，交冲突条确认
          setConflict(true);
          useFileWindowStore
            .getState()
            .patchTab(tabId, { saveStatus: "unsaved" });
          return null;
        }
        useFileWindowStore
          .getState()
          .patchTab(tabId, { saveStatus: "unsaved" });
        toast.error(mapIpcError(e));
        return null;
      }
    },
    [tabId, write],
  );

  const resolveConflict = useCallback(
    async (
      mode: "overwrite" | "reload",
      draft: string,
    ): Promise<WriteFileResult | null> => {
      setConflict(false);
      if (mode === "overwrite") {
        return (await saveAfterConflict(draft)) ?? null;
      }
      // reload：放弃本地修改，重读磁盘（新基线随数据到达由内容区落回）
      void queryClient.invalidateQueries({ queryKey: ["fw-file"] });
      useFileWindowStore.getState().patchTab(tabId, {
        dirty: false,
        saveStatus: "saved",
        // 重读即弃本地草稿，外部变更条幅一并撤下
        externalChanged: false,
      });
      return null;
    },
    [queryClient, saveAfterConflict, tabId],
  );

  return { save, conflict, resolveConflict };
}
