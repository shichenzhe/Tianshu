/**
 * 资产文件表格（纯展示，spec §6.4）：图标按类型/扩展名映射，名称列
 * （文件夹主色）、类型/大小/相对时间列，行悬停浮出 打开/定位/重命名/删除
 * 图标按钮（回调经 props 注入，弹窗与二次确认由 AssetsPane 侧接入）。
 * 排序/筛选由父层（AssetsPane）完成，此处仅按 sortKey 高亮活动列表头。
 */
import { useTranslation } from "react-i18next";
import { formatDistanceToNow } from "date-fns";
import {
  Eye,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderSearch,
  Image as ImageIcon,
  Pencil,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { getDateFnsLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AssetEntry } from "../../../../electron/domains/project/asset.entity";

/** 排序键（与 AssetsPane 状态同口径） */
export type AssetSortKey = "name" | "updatedAt";

/** 文件扩展名 → 图标（未命中回退 File） */
const EXT_ICONS: Record<string, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  txt: FileText,
  md: FileText,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  gif: ImageIcon,
  zip: FileArchive,
};

/** 字节 → B/KB/MB/GB（1 位小数；大小列与容量条共用） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** 相对时间（locale 跟随界面语言，ProjectCard 同款惯例） */
function formatRelative(iso: string): string {
  return formatDistanceToNow(new Date(iso), {
    addSuffix: true,
    locale: getDateFnsLocale(),
  });
}

/** 条目图标：文件夹 Folder；文件按扩展名映射 */
function iconOf(entry: AssetEntry): LucideIcon {
  if (entry.type === "folder") {
    return Folder;
  }
  return (entry.ext !== null && EXT_ICONS[entry.ext]) || File;
}

interface AssetFileTableProps {
  entries: AssetEntry[];
  sortKey: AssetSortKey;
  onOpen: (entry: AssetEntry) => void;
  onRename: (entry: AssetEntry) => void;
  onDelete: (entry: AssetEntry) => void;
  onReveal: (entry: AssetEntry) => void;
}

export default function AssetFileTable({
  entries,
  sortKey,
  onOpen,
  onRename,
  onDelete,
  onReveal,
}: AssetFileTableProps) {
  const { t } = useTranslation(["project"]);
  /** 活动排序列表头高亮（方向状态在父层，表格只做展示标注） */
  const headClass = (key: AssetSortKey) =>
    cn(sortKey === key && "text-primary");

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={headClass("name")}>
            {t("project:assets.name")}
          </TableHead>
          <TableHead className="w-28">{t("project:assets.type")}</TableHead>
          <TableHead className="w-24">{t("project:assets.size")}</TableHead>
          <TableHead className={cn("w-28", headClass("updatedAt"))}>
            {t("project:assets.updatedAt")}
          </TableHead>
          <TableHead className="w-40" aria-label={t("project:assets.open")} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const Icon = iconOf(entry);
          const isFolder = entry.type === "folder";
          return (
            <TableRow
              key={entry.name}
              className="group/row cursor-pointer"
              onClick={() => onOpen(entry)}
            >
              <TableCell className="max-w-0">
                <span className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isFolder ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn("truncate", isFolder && "text-primary")}
                    title={entry.name}
                  >
                    {entry.name}
                  </span>
                </span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {isFolder
                  ? t("project:assets.folder")
                  : (entry.ext ?? t("project:assets.file"))}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatBytes(entry.size)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatRelative(entry.updatedAt)}
              </TableCell>
              <TableCell>
                {/* 悬停浮出操作区；拦截冒泡避免误触整行 onOpen */}
                <span
                  className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("project:assets.open")}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                    onClick={() => onOpen(entry)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("project:assets.reveal")}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                    onClick={() => onReveal(entry)}
                  >
                    <FolderSearch className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("project:assets.rename")}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                    onClick={() => onRename(entry)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("project:assets.delete")}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(entry)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
