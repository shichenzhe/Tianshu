/**
 * 资料库文件列表（列表形态）：名称/类型/大小/添加时间 四列 + 行尾 …
 * 操作菜单（预览/重命名/移动/Finder/删除）。行点击进文件夹、文件点击
 * 预览；空态与加载态由本组件渲染。
 */
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
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
import { formatSize } from "../lib/library-view-model";

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
        {t("chat:library.empty")}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border/50">
      <div className="grid grid-cols-[minmax(0,1fr)_110px_90px_150px_40px] items-center gap-2 border-b border-border/50 bg-primary-subtle/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <span>{t("chat:library.colName")}</span>
        <span>{t("chat:library.colType")}</span>
        <span>{t("chat:library.colSize")}</span>
        <span>{t("chat:library.colAddedAt")}</span>
        <span />
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className="grid grid-cols-[minmax(0,1fr)_110px_90px_150px_40px] items-center gap-2 border-b border-border/50 px-3 py-2 text-sm last:border-b-0 hover:bg-primary-subtle/40"
        >
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() =>
              item.kind === "folder" ? onOpen(item) : onPreview(item)
            }
          >
            {item.kind === "folder" ? (
              <Folder className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
            {item.kind === "folder" && (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
          </button>
          <span className="truncate text-muted-foreground">
            {/* folder 行类型列渲染「—」（fileType 为 null，不落「其他」） */}
            {item.kind === "folder"
              ? "—"
              : t(
                  TYPE_LABEL_KEY[item.fileType ?? "other"] ??
                    "chat:library.typeOther",
                )}
          </span>
          <span className="text-muted-foreground">{formatSize(item.size)}</span>
          <span className="truncate text-muted-foreground">
            {new Date(item.createdAt).toLocaleDateString()}
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
              <DropdownMenuItem onClick={() => onReveal(item)}>
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
