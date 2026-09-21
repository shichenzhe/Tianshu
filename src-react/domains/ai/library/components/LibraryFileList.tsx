/**
 * 资料库文件列表（列表形态）：名称（♥ 收藏 / NEW / 图标）/类型/位置/
 * 最近访问 四列 + 行尾 … 操作菜单（预览/重命名/移动/Finder/删除）。
 * 列头 name/activity 可点切换升降序；行内 folder 点击进文件夹、文件
 * 点击预览；空态与加载态由本组件渲染。
 */
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Heart,
  MoreHorizontal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LibraryItem } from "../api/library.api";
import {
  activityTimeOf,
  formatLocation,
  isNewItem,
  type SortField,
} from "../lib/library-view-model";

/** 表头与行共用的四列网格（名称加宽 / 类型 / 位置 / 最近访问 / …） */
const GRID =
  "grid grid-cols-[minmax(0,1.6fr)_110px_minmax(0,1fr)_150px_40px] items-center gap-2";

/** 类型列文案 key（fileType → chat:library.type*；null/other → typeOther） */
export const TYPE_LABEL_KEY: Record<string, string> = {
  document: "chat:library.typeDocument",
  html: "chat:library.typeHtml",
  image: "chat:library.typeImage",
  pdf: "chat:library.typePdf",
  audio: "chat:library.typeAudio",
  video: "chat:library.typeVideo",
  code: "chat:library.typeCode",
  text: "chat:library.typeText",
  archive: "chat:library.typeArchive",
  other: "chat:library.typeOther",
};

interface LibraryFileListProps {
  items: LibraryItem[];
  loading: boolean;
  /** 空态文案覆盖（如「最近」视图的专用空态）；缺省 t("chat:library.empty") */
  emptyText?: string;
  sortField: SortField;
  sortAsc: boolean;
  onToggleSort: (field: SortField) => void;
  onToggleFavorite: (item: LibraryItem) => void;
  onOpen: (item: LibraryItem) => void;
  onPreview: (item: LibraryItem) => void;
  onRename: (item: LibraryItem) => void;
  onMove: (item: LibraryItem) => void;
  onReveal: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
}

export default function LibraryFileList({
  items,
  loading,
  emptyText,
  sortField,
  sortAsc,
  onToggleSort,
  onToggleFavorite,
  onOpen,
  onPreview,
  onRename,
  onMove,
  onReveal,
  onDelete,
}: LibraryFileListProps) {
  const { t } = useTranslation(["chat"]);

  if (loading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">…</p>;
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 p-10 text-sm text-muted-foreground">
        <FolderOpen className="h-6 w-6" />
        {emptyText ?? t("chat:library.empty")}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border/50">
      <div
        className={`${GRID} border-b border-border/50 bg-primary-subtle/40 px-3 py-2 text-xs font-medium text-muted-foreground`}
      >
        <button
          type="button"
          className="flex items-center gap-1 text-left hover:text-primary"
          onClick={() => onToggleSort("name")}
        >
          <span>{t("chat:library.colName")}</span>
          {sortField === "name" && (
            <span
              aria-label={
                sortAsc ? t("chat:library.sortAsc") : t("chat:library.sortDesc")
              }
            >
              {sortAsc ? "↑" : "↓"}
            </span>
          )}
        </button>
        <span>{t("chat:library.colType")}</span>
        <span>{t("chat:library.colLocation")}</span>
        <button
          type="button"
          className="flex items-center gap-1 text-left hover:text-primary"
          onClick={() => onToggleSort("activity")}
        >
          <span>{t("chat:library.colLastViewed")}</span>
          {sortField === "activity" && (
            <span
              aria-label={
                sortAsc ? t("chat:library.sortAsc") : t("chat:library.sortDesc")
              }
            >
              {sortAsc ? "↑" : "↓"}
            </span>
          )}
        </button>
        <span />
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className={`${GRID} border-b border-border/50 px-3 py-2 text-sm last:border-b-0 hover:bg-primary-subtle/40`}
        >
          {/* 名称列：外层 div + 文件名/♥ 各自 button 平级（HTML 禁 button 嵌套） */}
          {item.kind === "folder" ? (
            <div className="flex min-w-0 items-center gap-2">
              <Folder className="h-4 w-4 shrink-0 text-primary" />
              <button
                type="button"
                className="min-w-0 truncate text-left"
                title={item.name}
                onClick={() => onOpen(item)}
              >
                {item.name}
              </button>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                aria-label={
                  item.favorite
                    ? t("chat:library.unfavoriteAction")
                    : t("chat:library.favoriteAction")
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(item);
                }}
                className="shrink-0 rounded p-0.5 hover:bg-primary-subtle"
              >
                {/* ♥ 红 = 收藏语义色（非主题色），对齐 destructive 语义用法 */}
                <Heart
                  className={`h-3.5 w-3.5 ${item.favorite ? "fill-red-500 text-red-500" : "text-muted-foreground"}`}
                />
              </button>
              <button
                type="button"
                className="min-w-0 truncate text-left"
                title={item.name}
                onClick={() => onPreview(item)}
              >
                {item.name}
              </button>
              {isNewItem(item) && (
                <span className="shrink-0 rounded-sm bg-red-500/10 px-1 py-0.5 text-[10px] font-semibold text-red-500">
                  {t("chat:library.newBadge")}
                </span>
              )}
            </div>
          )}
          <span className="truncate text-muted-foreground">
            {/* folder 行类型列渲染「—」（fileType 为 null，不落「其他」） */}
            {item.kind === "folder"
              ? "—"
              : t(
                  TYPE_LABEL_KEY[item.fileType ?? "other"] ??
                    "chat:library.typeOther",
                )}
          </span>
          <span
            className="truncate text-muted-foreground"
            title={formatLocation(item.location, t("chat:library.mine"))}
          >
            {formatLocation(item.location, t("chat:library.mine"))}
          </span>
          <span className="truncate text-muted-foreground">
            {new Date(activityTimeOf(item)).toLocaleDateString()}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                aria-label={item.name}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border border-border/50 rounded-lg shadow-lg"
            >
              <DropdownMenuItem
                disabled={item.kind === "folder"}
                onClick={() => onPreview(item)}
              >
                {t("chat:library.preview")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename(item)}>
                {t("chat:library.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(item)}>
                {t("chat:library.move")}
              </DropdownMenuItem>
              {/* folder 纯 DB 无磁盘实体，无「在 Finder 中显示」语义 */}
              <DropdownMenuItem
                disabled={item.kind === "folder"}
                onClick={() => onReveal(item)}
              >
                {t("chat:library.reveal")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(item)}
              >
                {t("chat:library.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
    </div>
  );
}
