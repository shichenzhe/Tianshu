/**
 * 外部写盘事件消费（spec §5.2/§6.4；窗口级单挂——FileWindowView 挂一次
 * 管全 tab）：
 * - workspace:fileChanged：同路径 tab 分流——非脏静默 invalidate
 *   ["fw-file", wsId, path] 重载（draft null 时展示随新数据收敛，防旧内
 *   容常驻）；脏 tab 置 externalChanged 由 header 复用 T8 冲突条接手
 *   （重载磁盘版本/保留我的修改），不 invalidate——重取数据不得覆盖未
 *   保存草稿。
 * - fileWindow:libraryChanged（T14 修复轮）：AI write 直改库文件
 *   （主进程 bump updatedAt 后广播）→ 同 itemId library tab 同一分流：
 *   非脏 invalidate 条目/内容两键重读（基线随新 updatedAt 吸收）；脏置
 *   externalChanged（保存时 updatedAt 基线兜底冲突）。
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useFileWindowStore } from "../store/file-window.store";

interface FileChangedPayload {
  workspaceId: number;
  path: string;
}

interface LibraryChangedPayload {
  itemId: number;
}

/** 同 itemId library tab 分流（非脏重读/脏冲突条，同 workspace 语义） */
function routeLibraryChanged(
  queryClient: QueryClient,
  payload: LibraryChangedPayload,
): void {
  const hit = useFileWindowStore
    .getState()
    .tabs.find(
      (t) =>
        t.resource.kind === "library" && t.resource.itemId === payload.itemId,
    );
  if (!hit) return;
  if (hit.dirty) {
    useFileWindowStore.getState().patchTab(hit.id, { externalChanged: true });
    return;
  }
  // 非脏：条目（updatedAt/size 元数据）+ 内容两键重取（前缀匹配，
  // 内容键尾缀 storagePath 不必逐字对齐）
  void queryClient.invalidateQueries({
    queryKey: ["fw-library-item", payload.itemId],
  });
  void queryClient.invalidateQueries({
    queryKey: ["fw-library-content", payload.itemId],
  });
}

export function useFileChanged(queryClient: QueryClient): void {
  useEffect(() => {
    const offFile = window.ipcRenderer?.on(
      "workspace:fileChanged",
      (_e, raw: unknown) => {
        const payload = raw as FileChangedPayload;
        const hit = useFileWindowStore
          .getState()
          .tabs.find(
            (t) =>
              t.resource.kind === "workspace" &&
              t.resource.workspaceId === payload.workspaceId &&
              t.resource.path === payload.path,
          );
        if (!hit) return;
        // 保存自广播亚帧：写回广播可先于写回 patch 到达（tab 仍
        // dirty+saving），误置 externalChanged 会闪一下冲突条——saving
        // 期间跳过，写回 patch 自会落 saved 并清 externalChanged
        if (hit.saveStatus === "saving") return;
        if (hit.dirty) {
          useFileWindowStore
            .getState()
            .patchTab(hit.id, { externalChanged: true });
        } else {
          void queryClient.invalidateQueries({
            queryKey: ["fw-file", payload.workspaceId, payload.path],
          });
        }
      },
    );
    const offLibrary = window.ipcRenderer?.on(
      "fileWindow:libraryChanged",
      (_e, raw: unknown) => {
        routeLibraryChanged(queryClient, raw as LibraryChangedPayload);
      },
    );
    return () => {
      offFile?.();
      offLibrary?.();
    };
  }, [queryClient]);
}
