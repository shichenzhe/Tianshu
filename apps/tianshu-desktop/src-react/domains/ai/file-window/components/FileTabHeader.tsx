/**
 * tab 头行（工具栏）：文件名 + 保存状态徽标 + 保存/另存为/Finder/
 * AI 对话开关（AI 面板本体 Task 10 接入，开关先落 store）；冲突确认条
 * 内嵌（conflict 由 FileTabContent 从 useSaveTab 传入；T12 externalChanged
 * 复用同一条）。
 */
import { useTranslation } from "react-i18next";
import { FolderSearch, MessageSquare, Save, SaveAll } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { toast } from "sonner";
import ArtifactApi from "@/domains/ai/api/artifact.api";
import LibraryApi from "@/domains/ai/library/api/library.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useFileWindowStore } from "../store/file-window.store";

const ACTION_BTN =
  "rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary";

export default function FileTabHeader({
  tabId,
  onSave,
  conflict,
  onResolveConflict,
}: {
  tabId: string;
  onSave: () => void;
  conflict: boolean;
  onResolveConflict: (mode: "overwrite" | "reload" | "keepMine") => void;
}) {
  const { t } = useTranslation(["chat"]);
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));
  if (!tab) return null;
  // library tab（T14）：标题=条目名（tab.title 由 LibraryTabBody 落库）、
  // Finder 走 library:revealItem、无另存为；workspace 走原 resource.path
  const workspace = tab.resource.kind === "workspace" ? tab.resource : null;
  const title = workspace ? workspace.path : tab.title;
  const statusKey =
    tab.saveStatus === "hidden"
      ? ""
      : `chat:fileWindow.saveStatus.${tab.saveStatus}`;
  return (
    <div className="flex flex-col border-b border-border/50">
      <div className="flex h-9 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {title}
        </span>
        {statusKey && (
          <span className="text-xs text-muted-foreground">{t(statusKey)}</span>
        )}
        {tab.dirty && (
          <IconTooltip label={t("chat:fileWindow.action.save")}>
            <button
              type="button"
              aria-label={t("chat:fileWindow.action.save")}
              onClick={onSave}
              className={ACTION_BTN}
            >
              <Save className="h-4 w-4" />
            </button>
          </IconTooltip>
        )}
        {/* 另存为：exportFile 副本到任意位置（不动原文件，WorkBuddy
            office.action.saveAs 同语义）；用户取消返回 null 静默——library
            无导出 IPC 不渲染 */}
        {workspace && (
          <IconTooltip label={t("chat:fileWindow.action.saveAs")}>
            <button
              type="button"
              aria-label={t("chat:fileWindow.action.saveAs")}
              onClick={() =>
                void ArtifactApi.exportFile(
                  workspace.workspaceId,
                  workspace.path,
                )
                  .then((savedAs) => {
                    if (savedAs)
                      toast.success(t("chat:artifacts.exportSuccess"));
                  })
                  .catch((e) => toast.error(mapIpcError(e)))
              }
              className={ACTION_BTN}
            >
              <SaveAll className="h-4 w-4" />
            </button>
          </IconTooltip>
        )}
        <IconTooltip label={t("chat:fileWindow.action.reveal")}>
          <button
            type="button"
            aria-label={t("chat:fileWindow.action.reveal")}
            onClick={() => {
              // 事件时反查 resource（闭包不经窄化）：workspace 走产物空间、
              // library 走条目 revealItem
              const resource = useFileWindowStore
                .getState()
                .tabs.find((x) => x.id === tabId)?.resource;
              if (resource?.kind === "workspace") {
                void ArtifactApi.revealFile(
                  resource.workspaceId,
                  resource.path,
                ).catch((e) => toast.error(mapIpcError(e)));
              } else if (resource?.kind === "library") {
                void LibraryApi.revealItem(resource.itemId).catch((e) =>
                  toast.error(mapIpcError(e)),
                );
              }
            }}
            className={ACTION_BTN}
          >
            <FolderSearch className="h-4 w-4" />
          </button>
        </IconTooltip>
        <IconTooltip label={t("chat:fileWindow.action.aiChat")}>
          <button
            type="button"
            aria-label={t("chat:fileWindow.action.aiChat")}
            onClick={() =>
              useFileWindowStore.getState().patchTab(tabId, {
                aiPanelOpen: !tab.aiPanelOpen,
              })
            }
            className={ACTION_BTN}
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        </IconTooltip>
      </div>
      {
        /* 冲突条复用（T8 保存冲突 / T12 externalChanged 外部变更）：
          保存冲突优先（保存已被拒，须立即裁决）；external 场景换变体按钮
          ——keepMine 不写盘仅撤条幅（保存时基线兜底），语义与「覆盖磁盘
          版本」的立即写盘不同，故分键 */
        (conflict || tab.externalChanged) && (
          <div className="flex items-center gap-2 border-t border-border/50 bg-primary-subtle/50 px-3 py-1.5 text-xs">
            <span className="flex-1">
              {t("chat:fileWindow.conflict.title")}
            </span>
            {conflict ? (
              <>
                <button
                  type="button"
                  onClick={() => onResolveConflict("overwrite")}
                  className="rounded border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary"
                >
                  {t("chat:fileWindow.conflict.overwrite")}
                </button>
                <button
                  type="button"
                  onClick={() => onResolveConflict("reload")}
                  className="rounded border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary"
                >
                  {t("chat:fileWindow.conflict.reload")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onResolveConflict("keepMine")}
                  className="rounded border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary"
                >
                  {t("chat:fileWindow.conflict.keepMine")}
                </button>
                <button
                  type="button"
                  onClick={() => onResolveConflict("reload")}
                  className="rounded border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary"
                >
                  {t("chat:fileWindow.conflict.reloadDisk")}
                </button>
              </>
            )}
          </div>
        )
      }
    </div>
  );
}
