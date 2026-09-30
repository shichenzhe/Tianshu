/**
 * 资料库详情面板（主区详情态）：顶栏（返回列表 + 文件名（点击就地重
 * 命名：回车提交 Esc 取消，空名/未变不提交）+ 行操作 Finder/移动/删除）
 * + 元信息行（类型/大小/添加时间/原路径）+ 内嵌预览
 * （LibraryPreviewContent 五级渲染）。行操作经回调复用 LibraryView
 * 既有编排（弹窗/删除确认/toast/刷新）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  FolderInput,
  FolderSearch,
  PenLine,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LibraryItem } from "../api/library.api";
import { formatSize, splitFileName } from "../lib/library-view-model";
import { TYPE_LABEL_KEY } from "./LibraryFileList";
import LibraryPreviewContent from "./LibraryPreviewContent";
import IconTooltip from "./icon-tooltip";

interface LibraryDetailPanelProps {
  item: LibraryItem;
  onBack: () => void;
  /** 编辑保存回传（md/csv 写盘成功后的新行——更新 detailItem 元信息） */
  onItemUpdate: (item: LibraryItem) => void;
  /** 标题就地重命名提交（空名/未变由本组件拦截不提交） */
  onSubmitRename: (id: number, name: string) => void;
  onMove: (item: LibraryItem) => void;
  onReveal: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
}

const ACTION_BTN =
  "h-7 w-7 shrink-0 rounded-md p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30";

export default function LibraryDetailPanel({
  item,
  onBack,
  onItemUpdate,
  onSubmitRename,
  onMove,
  onReveal,
  onDelete,
}: LibraryDetailPanelProps) {
  const { t } = useTranslation(["chat"]);
  // 扩展名锁定不可编辑：输入框只露主干，提交时原样拼回（类型不可改）
  const { stem, ext } = splitFileName(item.name);
  // 标题行内重命名中（true=文件名换 input）
  const [editingName, setEditingName] = useState(false);
  // 本次编辑已终结（Enter/Esc 先落，卸载触发的 blur 再来即短路——防重复
  // 提交/Esc 被覆盖）
  const renameDoneRef = useRef(false);

  // 切换条目退出编辑态（非受控 input 的旧值不能提交到新条目 id；切换
  //  瞬间的 blur 仍走旧闭包按旧条目提交——失焦保存语义，正确）
  useEffect(() => {
    setEditingName(false);
  }, [item.id]);

  /** 行内重命名终结（只跑一次）：value=null 取消；空主干/全名未变不提交 */
  const finishRename = (value: string | null) => {
    if (renameDoneRef.current) {
      return;
    }
    renameDoneRef.current = true;
    setEditingName(false);
    const stemNext = value?.trim();
    if (stemNext && `${stemNext}${ext}` !== item.name) {
      onSubmitRename(item.id, `${stemNext}${ext}`);
    }
  };

  return (
    <TooltipProvider>
      <div
        data-testid="library-detail"
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
          <IconTooltip label={t("chat:library.backToList")}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("chat:library.backToList")}
              className="h-7 w-7 shrink-0 rounded-md p-0 hover:bg-primary-subtle hover:text-primary"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </IconTooltip>
          {editingName ? (
            <input
              autoFocus
              defaultValue={stem}
              aria-label={t("chat:library.rename")}
              className="mr-1 min-w-0 flex-1 rounded border border-primary/30 bg-background px-1.5 py-0.5 text-sm outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  finishRename(e.currentTarget.value);
                }
                if (e.key === "Escape") {
                  finishRename(null);
                }
              }}
              onBlur={(e) => {
                // 失焦兜底（=提交）；Enter/Esc 已终结时被 done 标记短路
                finishRename(e.currentTarget.value);
              }}
            />
          ) : (
            <button
              type="button"
              aria-label={t("chat:library.rename")}
              onClick={() => {
                renameDoneRef.current = false;
                setEditingName(true);
              }}
              className="group flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-primary-subtle"
            >
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={item.name}
              >
                {item.name}
              </span>
              <PenLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <IconTooltip label={t("chat:library.reveal")}>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("chat:library.reveal")}
              className={ACTION_BTN}
              onClick={() => onReveal(item)}
            >
              <FolderSearch className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("chat:library.move")}>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("chat:library.move")}
              className={ACTION_BTN}
              onClick={() => onMove(item)}
            >
              <FolderInput className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("chat:library.delete")}>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("chat:library.delete")}
              className={`${ACTION_BTN} hover:text-destructive hover:border-destructive/30`}
              onClick={() => onDelete(item)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
        </div>
        {/* 元信息行：类型/大小/添加时间/原路径（file 专属字段 null 占位 —） */}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            {t("chat:library.colType")}：
            {t(
              TYPE_LABEL_KEY[item.fileType ?? "other"] ??
                "chat:library.typeOther",
            )}
          </span>
          <span>
            {t("chat:library.colSize")}：{formatSize(item.size)}
          </span>
          <span>
            {t("chat:library.colAddedAt")}：
            {new Date(item.createdAt).toLocaleDateString()}
          </span>
          {item.originalPath && (
            <span
              className="min-w-0 basis-full truncate"
              title={item.originalPath}
            >
              {t("chat:library.originalPath")}：{item.originalPath}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 p-3">
          <LibraryPreviewContent item={item} onItemUpdate={onItemUpdate} />
        </div>
      </div>
    </TooltipProvider>
  );
}
