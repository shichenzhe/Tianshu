/**
 * 资料库详情面板（主区详情态）：顶栏（返回列表 + 文件名 + 行操作
 * Finder/重命名/移动/删除）+ 元信息行（类型/大小/添加时间/原路径）+
 * 内嵌预览（LibraryPreviewContent 五级渲染）。行操作经回调复用
 * LibraryView 既有编排（弹窗/删除确认/toast/刷新）。
 */
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  FolderInput,
  FolderSearch,
  PenLine,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LibraryItem } from "../api/library.api";
import { formatSize } from "../lib/library-view-model";
import { TYPE_LABEL_KEY } from "./LibraryFileList";
import LibraryPreviewContent from "./LibraryPreviewContent";

interface LibraryDetailPanelProps {
  item: LibraryItem;
  onBack: () => void;
  onRename: (item: LibraryItem) => void;
  onMove: (item: LibraryItem) => void;
  onReveal: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
}

const ACTION_BTN =
  "h-7 w-7 shrink-0 rounded-md p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30";

export default function LibraryDetailPanel({
  item,
  onBack,
  onRename,
  onMove,
  onReveal,
  onDelete,
}: LibraryDetailPanelProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <div data-testid="library-detail" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("chat:library.backToList")}
          title={t("chat:library.backToList")}
          className="h-7 w-7 shrink-0 rounded-md p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={item.name}
        >
          {item.name}
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("chat:library.reveal")}
          title={t("chat:library.reveal")}
          className={ACTION_BTN}
          onClick={() => onReveal(item)}
        >
          <FolderSearch className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("chat:library.rename")}
          title={t("chat:library.rename")}
          className={ACTION_BTN}
          onClick={() => onRename(item)}
        >
          <PenLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("chat:library.move")}
          title={t("chat:library.move")}
          className={ACTION_BTN}
          onClick={() => onMove(item)}
        >
          <FolderInput className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("chat:library.delete")}
          title={t("chat:library.delete")}
          className={`${ACTION_BTN} hover:text-destructive hover:border-destructive/30`}
          onClick={() => onDelete(item)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
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
        <LibraryPreviewContent item={item} />
      </div>
    </div>
  );
}
