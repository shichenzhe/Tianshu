/**
 * 资料库「我的资料」（spec §5）：工具栏（面包屑/搜索/类型筛选/新建
 * 文件夹/上传）+ 列表。搜索跨层走 library:search；排序与类型筛选前端
 * 本地（单层数据量小，skill 页先例）；拖拽入库（拖到页面任意处）。
 * 预览在 Task 7 接入（本版行内点击暂不预览）。
 */
import { useMemo, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, FolderPlus, Search, Upload } from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import LibraryApi, { type LibraryItem } from "../api/library.api";
import {
  filterByType,
  sortItems,
  type SortField,
} from "../lib/library-view-model";
import LibraryFileList, { TYPE_LABEL_KEY } from "../components/LibraryFileList";
import LibraryItemDialogs from "../components/LibraryItemDialogs";
import LibraryMoveDialog from "../components/LibraryMoveDialog";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { invoke } from "@/lib/ipc";

const TYPE_FILTERS = ["all", ...Object.keys(TYPE_LABEL_KEY)];

export default function LibraryView() {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const [folderId, setFolderId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("updatedAt");
  const [dialog, setDialog] = useState<{
    mode: "createFolder" | "rename";
    item?: LibraryItem;
  } | null>(null);
  const [moveIds, setMoveIds] = useState<number[] | null>(null);
  const [deleteItem, setDeleteItem] = useState<LibraryItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const searching = keyword.trim().length > 0;
  const listQuery = useQuery({
    queryKey: ["libraryItems", folderId],
    queryFn: () => LibraryApi.list(folderId ?? undefined),
  });
  const searchQuery = useQuery({
    queryKey: ["librarySearch", keyword.trim()],
    queryFn: () => LibraryApi.search(keyword.trim()),
    enabled: searching,
  });

  const rawItems = searching
    ? (searchQuery.data ?? [])
    : (listQuery.data?.items ?? []);
  const items = useMemo(
    () => sortItems(filterByType(rawItems, typeFilter), sortField, "desc"),
    [rawItems, typeFilter, sortField],
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["libraryItems"] });
    await queryClient.invalidateQueries({ queryKey: ["librarySearch"] });
  };

  /** 上传：系统选择器多选 → addFiles 到当前层 */
  const handleUpload = async () => {
    let paths: string[] | null;
    try {
      paths = await invoke<string[] | null>("file:pickLocalFiles");
    } catch {
      toast.error(t("chat:library.loadFailed"));
      return;
    }
    if (!paths) {
      return;
    }
    await ingest(paths);
  };

  const ingest = async (paths: string[]) => {
    try {
      const result = await LibraryApi.addFiles(paths, folderId ?? undefined);
      if (result.added.length > 0 || result.failed.length > 0) {
        // 重名自动编号告知（spec 裁定 7）：入库后名与源文件名不同的条目计数
        const renamedCount = result.added.filter(
          (item, index) => item.name !== paths[index]?.split(/[\\/]/).pop(),
        ).length;
        toast.success(
          t("chat:library.uploadToast", {
            success: result.added.length,
            renamedSection: renamedCount
              ? t("chat:library.uploadRenamed", { count: renamedCount })
              : "",
            failedSection: result.failed.length
              ? t("chat:library.uploadFailedSection", {
                  count: result.failed.length,
                })
              : "",
          }),
        );
      }
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 拖拽入库：dataTransfer 文件经 preload filePath.getPathForFile 取路径
   *  （window.filePath 全局类型已有声明：src-react/vite-env.d.ts:8） */
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.filePath.getPathForFile(file))
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length > 0) {
      await ingest(paths);
    }
  };

  const handleSubmitName = async (name: string) => {
    if (!dialog) {
      return;
    }
    setSubmitting(true);
    try {
      if (dialog.mode === "createFolder") {
        await LibraryApi.createFolder(name, folderId ?? undefined);
      } else if (dialog.item) {
        await LibraryApi.rename(dialog.item.id, name);
      }
      setDialog(null);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteItem) {
      return;
    }
    setSubmitting(true);
    try {
      await LibraryApi.delete([deleteItem.id]);
      setDeleteItem(null);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const breadcrumbs = listQuery.data?.breadcrumbs ?? [];

  return (
    <div
      className="flex h-full flex-col overflow-y-auto p-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void handleDrop(e)}
    >
      <PageTitle title={t("chat:library.title")} />
      <div className="flex flex-wrap items-center gap-2 py-3">
        {!searching && (
          <nav className="flex items-center gap-1 text-sm">
            <button
              type="button"
              className="rounded-md px-1.5 py-1 hover:bg-primary-subtle hover:text-primary"
              onClick={() => setFolderId(null)}
            >
              {t("chat:library.mine")}
            </button>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.id} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 hover:bg-primary-subtle hover:text-primary"
                  onClick={() => setFolderId(crumb.id)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        {searching && (
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            onClick={() => setKeyword("")}
          >
            {t("chat:library.searchBack")}
          </Button>
        )}
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("chat:library.searchPlaceholder")}
            className="w-56 pl-8"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger
            className="w-32"
            aria-label={t("chat:library.colType")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border border-border/50 rounded-lg shadow-lg">
            {TYPE_FILTERS.map((type) => (
              <SelectItem key={type} value={type}>
                {t(
                  type === "all"
                    ? "chat:library.typeAll"
                    : (TYPE_LABEL_KEY[type] ?? "chat:library.typeOther"),
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => setDialog({ mode: "createFolder" })}
        >
          <FolderPlus className="mr-1 h-4 w-4" />
          {t("chat:library.newFolder")}
        </Button>
        <Button size="sm" onClick={() => void handleUpload()}>
          <Upload className="mr-1 h-4 w-4" />
          {t("chat:library.upload")}
        </Button>
      </div>
      <div
        className="flex items-center gap-3 pb-2 text-xs text-muted-foreground"
        onClick={() =>
          setSortField(sortField === "updatedAt" ? "name" : "updatedAt")
        }
      >
        <button type="button" className="hover:text-primary">
          {sortField === "updatedAt"
            ? t("chat:library.recent")
            : t("chat:library.colName")}
        </button>
      </div>
      {searching && searchQuery.data?.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("chat:library.noSearchResult")}
        </p>
      ) : (
        <LibraryFileList
          items={items}
          loading={searching ? searchQuery.isLoading : listQuery.isLoading}
          onOpen={(item) => setFolderId(item.id)}
          onPreview={() => {
            /* Task 7 接预览 */
          }}
          onRename={(item) => setDialog({ mode: "rename", item })}
          onMove={(item) => setMoveIds([item.id])}
          onReveal={(item) => void LibraryApi.revealItem(item.id)}
          onDelete={(item) => setDeleteItem(item)}
        />
      )}

      <LibraryItemDialogs
        open={dialog !== null}
        mode={dialog?.mode ?? "createFolder"}
        initialName={dialog?.item?.name ?? ""}
        submitting={submitting}
        onClose={() => setDialog(null)}
        onSubmit={(name) => void handleSubmitName(name)}
      />
      <LibraryMoveDialog
        open={moveIds !== null}
        itemIds={moveIds ?? []}
        onClose={() => setMoveIds(null)}
        onMoved={() => void invalidate()}
      />
      <AlertDialog
        open={deleteItem !== null}
        onOpenChange={(next) => !next && setDeleteItem(null)}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:library.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteItem?.kind === "folder"
                ? t("chat:library.deleteFolderHint")
                : t("chat:library.deleteFileHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {t("chat:library.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
