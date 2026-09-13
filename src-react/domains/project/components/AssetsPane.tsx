/**
 * 资产面板（spec §6.4 骨架）：面包屑 + 容量条 + 排序/类型筛选工具栏 +
 * 文件表格。列表按 folderPath.join("/") 取数（后端 safeJoin 归一），
 * 文件夹行点击入栈、面包屑任意层级回退（均重置类型筛选）；
 * 文件行点击 openFile 系统预览，失败 toast。
 * 排序/筛选在面板内计算后传入，AssetFileTable 纯展示；
 * 新建/上传/拖拽与重命名/删除弹窗由后续任务接入（文案 key 已就位）。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FolderOpen,
  ListFilter,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import AssetApi from "../api/asset.api";
import AssetFileTable, { formatBytes } from "./AssetFileTable";
import type { AssetSortKey } from "./AssetFileTable";
import type { AssetEntry } from "../../../../electron/domains/project/asset.entity";

/** 容量条警示阈值（百分比，spec §4 软配额 UI 提示） */
const QUOTA_WARN_PERCENT = 80;

interface AssetsPaneProps {
  projectId: number;
}

/** 类型过滤（严格匹配扩展名，文件夹一并隐藏）→ 文件夹恒在前 + 键/方向排序 */
function filterAndSort(
  entries: AssetEntry[],
  typeFilter: string | null,
  sortKey: AssetSortKey,
  sortAsc: boolean,
): AssetEntry[] {
  const filtered =
    typeFilter === null
      ? entries
      : entries.filter((entry) => entry.ext === typeFilter);
  const factor = sortAsc ? 1 : -1;
  return [...filtered].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    if (sortKey === "name") {
      return factor * a.name.localeCompare(b.name);
    }
    return (
      factor *
      (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
    );
  });
}

export default function AssetsPane({ projectId }: AssetsPaneProps) {
  const { t } = useTranslation(["project"]);
  const [folderPath, setFolderPath] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<AssetSortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const currentPath = folderPath.join("/");
  const listQuery = useQuery({
    queryKey: ["projectAssets", projectId, currentPath],
    queryFn: () => AssetApi.list(projectId, currentPath),
  });
  const storageQuery = useQuery({
    queryKey: ["projectAssetStorage", projectId],
    queryFn: () => AssetApi.storage(projectId),
  });

  const entries = listQuery.data ?? [];
  /** 当前目录出现的去重扩展名（筛选下拉选项） */
  const extOptions = useMemo(
    () =>
      [
        ...new Set(
          entries
            .map((entry) => entry.ext)
            .filter((ext): ext is string => ext !== null),
        ),
      ].sort(),
    [entries],
  );
  const visibleEntries = useMemo(
    () => filterAndSort(entries, typeFilter, sortKey, sortAsc),
    [entries, typeFilter, sortKey, sortAsc],
  );

  /** 条目完整相对路径（文件夹层级 + 名称，"/" 连接与后端 safeJoin 相容） */
  const entryPath = (entry: AssetEntry) =>
    [...folderPath, entry.name].join("/");

  /** 点击已激活的排序键 → 翻转方向；切换键 → 重置为升序 */
  const applySort = (key: AssetSortKey) => {
    if (key === sortKey) {
      setSortAsc((asc) => !asc);
      return;
    }
    setSortKey(key);
    setSortAsc(true);
  };

  /** 面包屑回退到第 depth 层（-1 为根）；目录变更重置类型筛选 */
  const navigateTo = (depth: number) => {
    setFolderPath(folderPath.slice(0, depth + 1));
    setTypeFilter(null);
  };

  const handleOpen = async (entry: AssetEntry) => {
    if (entry.type === "folder") {
      setFolderPath((path) => [...path, entry.name]);
      setTypeFilter(null);
      return;
    }
    try {
      await AssetApi.openFile(projectId, entryPath(entry));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleReveal = async (entry: AssetEntry) => {
    try {
      await AssetApi.revealFile(projectId, entryPath(entry));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  // 重命名/删除：弹窗与二次确认由后续任务接入，表格操作位先行占位透传
  const handleRename = () => undefined;
  const handleDelete = () => undefined;

  const storage = storageQuery.data ?? null;
  const usedPercent =
    storage && storage.quotaBytes > 0
      ? Math.min(
          100,
          Math.round((storage.usedBytes / storage.quotaBytes) * 100),
        )
      : 0;
  const quotaWarn = usedPercent >= QUOTA_WARN_PERCENT;

  /** 排序按钮（激活态高亮 + 方向箭头） */
  const sortButtonClass =
    "h-7 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：面包屑 + 容量条 */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2">
        <nav
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm"
          aria-label={t("project:assets.title")}
        >
          <button
            type="button"
            onClick={() => navigateTo(-1)}
            className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary"
          >
            {t("project:assets.title")}
          </button>
          {folderPath.map((part, index) => (
            <span
              key={`${index}-${part}`}
              className="flex shrink-0 items-center gap-1"
            >
              <span className="text-muted-foreground/60">›</span>
              {index === folderPath.length - 1 ? (
                <span className="px-1.5 py-0.5 text-foreground">{part}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateTo(index)}
                  className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary"
                >
                  {part}
                </button>
              )}
            </span>
          ))}
        </nav>
        {storage && (
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                "text-xs",
                quotaWarn ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t("project:assets.storageUsed", {
                used: formatBytes(storage.usedBytes),
                quota: formatBytes(storage.quotaBytes),
              })}
            </span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                role="progressbar"
                aria-valuenow={usedPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                className={cn(
                  "h-full rounded-full transition-[width]",
                  quotaWarn ? "bg-destructive" : "bg-primary",
                )}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            {quotaWarn && (
              <span className="text-xs text-destructive">
                {t("project:assets.quotaExceeded")}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 工具栏：排序切换 + 类型筛选 */}
      <div className="flex items-center gap-1.5 px-4 py-2">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={sortKey === "name"}
          onClick={() => applySort("name")}
          className={cn(
            sortButtonClass,
            sortKey === "name" && "border-primary/30 text-primary",
          )}
        >
          {sortKey === "name" &&
            (sortAsc ? (
              <ArrowUp className="h-3.5 w-3.5" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5" />
            ))}
          {t("project:assets.sortName")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={sortKey === "updatedAt"}
          onClick={() => applySort("updatedAt")}
          className={cn(
            sortButtonClass,
            sortKey === "updatedAt" && "border-primary/30 text-primary",
          )}
        >
          {sortKey === "updatedAt" &&
            (sortAsc ? (
              <ArrowUp className="h-3.5 w-3.5" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5" />
            ))}
          {t("project:assets.sortTime")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("project:assets.type")}
              className={sortButtonClass}
            >
              <ListFilter className="h-3.5 w-3.5" />
              {typeFilter ?? t("project:assets.filterAll")}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="rounded-lg border border-border/50 shadow-lg"
          >
            <DropdownMenuItem
              onClick={() => setTypeFilter(null)}
              className={cn(
                typeFilter === null && "text-primary focus:text-primary",
              )}
            >
              {t("project:assets.filterAll")}
            </DropdownMenuItem>
            {extOptions.map((ext) => (
              <DropdownMenuItem
                key={ext}
                onClick={() => setTypeFilter(ext)}
                className={cn(
                  typeFilter === ext && "text-primary focus:text-primary",
                )}
              >
                {ext}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 列表 / 空态 / 错误兜底 */}
      {listQuery.isError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("project:toast.operationFailed")}
        </div>
      ) : entries.length === 0 && !listQuery.isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle text-primary">
            <FolderOpen className="h-6 w-6" />
          </span>
          <p className="text-sm">{t("project:assets.empty")}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <AssetFileTable
            entries={visibleEntries}
            sortKey={sortKey}
            onOpen={handleOpen}
            onRename={handleRename}
            onDelete={handleDelete}
            onReveal={handleReveal}
          />
        </div>
      )}
    </div>
  );
}
