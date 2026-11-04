/**
 * 资产面板（spec §6.4）：面包屑 + 容量条 + 排序/类型筛选/上传/新建文件夹
 * 工具栏 + 文件表格。列表按 folderPath.join("/") 取数（后端 safeJoin 归一），
 * 文件夹行点击入栈、面包屑任意层级回退（均重置类型筛选）；文件行点击
 * openFile 系统预览，失败 toast。
 * 排序/筛选在面板内计算后传入（类型筛选仅作用于文件——文件夹是导航入口
 * 恒显示；时间排序默认降序最新在前），AssetFileTable 纯展示。
 * 操作交互：上传（按钮 pickFiles 多选 / 拖拽 DropZone）→ upload → 列表+
 * 容量双失效 → 结果 toast（部分失败警示、用量打满警示）；新建文件夹/
 * 重命名 Dialog（后端 sanitize+unique 后返回最终名，toast 展示）；删除
 * AlertDialog 二次确认。整体由 DropZone 包裹承接拖放。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  ListFilter,
  Loader2,
  Upload,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import AssetApi from "../api/asset.api";
import AssetFileTable, { formatBytes } from "./AssetFileTable";
import AssetUploadDropZone from "./AssetUploadDropZone";
import type { AssetSortKey } from "./AssetFileTable";
import type { AssetEntry } from "../../../../electron/domains/project/asset.entity";

/** 容量条警示阈值（百分比，spec §4 软配额 UI 提示） */
const QUOTA_WARN_PERCENT = 80;

/** 切换排序键时的缺省方向：名称升序、时间降序（最新在前，文件管理器惯例） */
const defaultSortAsc = (key: AssetSortKey) => key === "name";

/** 类型过滤仅作用于文件（文件夹是导航入口不可隐藏）→ 文件夹恒在前 + 键/方向排序 */
function filterAndSort(
  entries: AssetEntry[],
  typeFilter: string | null,
  sortKey: AssetSortKey,
  sortAsc: boolean,
): AssetEntry[] {
  const filtered =
    typeFilter === null
      ? entries
      : entries.filter(
          (entry) => entry.type === "folder" || entry.ext === typeFilter,
        );
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

interface AssetsPaneProps {
  projectId: number;
}

export default function AssetsPane({ projectId }: AssetsPaneProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const [folderPath, setFolderPath] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<AssetSortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderCreating, setFolderCreating] = useState(false);
  const [renaming, setRenaming] = useState<AssetEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [deleting, setDeleting] = useState<AssetEntry | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

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

  /** 点击已激活的排序键 → 翻转方向；切换键 → 该键的缺省方向 */
  const applySort = (key: AssetSortKey) => {
    if (key === sortKey) {
      setSortAsc((asc) => !asc);
      return;
    }
    setSortKey(key);
    setSortAsc(defaultSortAsc(key));
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

  /** 上传公共链路：upload → 列表+容量双失效 → 结果 toast → 用量打满警示 */
  const uploadFiles = async (absPaths: string[]) => {
    if (uploading) {
      return;
    }
    setUploading(true);
    try {
      const result = await AssetApi.upload(projectId, currentPath, absPaths);
      await queryClient.invalidateQueries({
        queryKey: ["projectAssets", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["projectAssetStorage", projectId],
      });
      if (result.failed.length > 0) {
        toast.warning(
          t("project:assets.uploadPartial", {
            uploaded: result.uploaded.length,
            failed: result.failed.length,
          }),
        );
      } else if (result.uploaded.length > 0) {
        toast.success(
          t("project:assets.uploadSuccess", { count: result.uploaded.length }),
        );
      }
      // 上传后重拉用量：软配额打满 → 警示（不硬拦截，spec §4）
      const storage = await AssetApi.storage(projectId);
      if (storage.quotaBytes > 0 && storage.usedBytes >= storage.quotaBytes) {
        toast.warning(t("project:assets.quotaExceeded"));
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = async () => {
    try {
      const paths = await AssetApi.pickFiles();
      if (paths && paths.length > 0) {
        await uploadFiles(paths);
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const openNewFolder = () => {
    setFolderName("");
    setNewFolderOpen(true);
  };

  const handleCreateFolder = async () => {
    const name = folderName.trim();
    if (!name || folderCreating) {
      return;
    }
    setFolderCreating(true);
    try {
      // 重名由后端 unique 序号处理，返回最终名并提示
      const finalName = await AssetApi.createFolder(
        projectId,
        currentPath,
        name,
      );
      await queryClient.invalidateQueries({
        queryKey: ["projectAssets", projectId],
      });
      toast.success(t("project:assets.folderCreated", { name: finalName }));
      setNewFolderOpen(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setFolderCreating(false);
    }
  };

  const openRename = (entry: AssetEntry) => {
    setRenaming(entry);
    setRenameValue(entry.name);
  };

  const handleRenameConfirm = async () => {
    const name = renameValue.trim();
    if (!renaming || !name || name === renaming.name || renamingBusy) {
      return;
    }
    setRenamingBusy(true);
    try {
      const finalName = await AssetApi.rename(
        projectId,
        entryPath(renaming),
        name,
      );
      await queryClient.invalidateQueries({
        queryKey: ["projectAssets", projectId],
      });
      toast.success(t("project:assets.renamed", { name: finalName }));
      setRenaming(null);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setRenamingBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleting || deletingBusy) {
      return;
    }
    setDeletingBusy(true);
    try {
      await AssetApi.remove(projectId, entryPath(deleting));
      // 删除释放空间：列表与容量缓存一并失效
      await queryClient.invalidateQueries({
        queryKey: ["projectAssets", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["projectAssetStorage", projectId],
      });
      toast.success(t("project:assets.deleted"));
      setDeleting(null);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeletingBusy(false);
    }
  };

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

  /** Dialog 取消按钮（新建文件夹/重命名共用样式） */
  const dialogCancelClass =
    "hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

  return (
    <AssetUploadDropZone onFiles={uploadFiles}>
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

        {/* 工具栏：排序切换 + 类型筛选 + 上传/新建文件夹 */}
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
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={handleUpload}
              disabled={uploading}
              className={sortButtonClass}
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {t("project:assets.upload")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={openNewFolder}
              className={sortButtonClass}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              {t("project:assets.newFolder")}
            </Button>
          </div>
        </div>

        {/* 列表 / 加载 / 空态 / 无匹配 / 错误兜底 */}
        {listQuery.isError ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t("project:toast.operationFailed")}
          </div>
        ) : listQuery.isLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common:loading")}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <FolderOpen className="h-6 w-6" />
            </span>
            <p className="text-sm">{t("project:assets.empty")}</p>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t("project:assets.noMatch")}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
            <AssetFileTable
              entries={visibleEntries}
              sortKey={sortKey}
              onOpen={handleOpen}
              onRename={openRename}
              onDelete={(entry) => setDeleting(entry)}
              onReveal={handleReveal}
            />
          </div>
        )}
      </div>

      {/* 新建文件夹：重名序号由后端处理，toast 展示返回最终名 */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="rounded-lg border-border/50 shadow-lg sm:max-w-sm"
        >
          <DialogHeader>
            <DialogTitle>{t("project:assets.newFolder")}</DialogTitle>
          </DialogHeader>
          <Input
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            aria-label={t("project:assets.name")}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewFolderOpen(false)}
              className={dialogCancelClass}
            >
              {t("common:cancel")}
            </Button>
            <Button
              onClick={handleCreateFolder}
              disabled={folderCreating || folderName.trim() === ""}
            >
              {folderCreating ? t("common:saving") : t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名：预填当前名，未修改（后端会得 "原名 (2)"）或清空禁用确认 */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null);
          }
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="rounded-lg border-border/50 shadow-lg sm:max-w-sm"
        >
          <DialogHeader>
            <DialogTitle>{t("project:assets.rename")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            aria-label={t("project:assets.name")}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenaming(null)}
              className={dialogCancelClass}
            >
              {t("common:cancel")}
            </Button>
            <Button
              onClick={handleRenameConfirm}
              disabled={
                renamingBusy ||
                renameValue.trim() === "" ||
                renameValue.trim() === renaming?.name
              }
            >
              {renamingBusy ? t("common:saving") : t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认：通用文案（文件夹懒统计为字节数，不硬凑条目数） */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("project:assets.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("project:assets.deleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingBusy}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AssetUploadDropZone>
  );
}
