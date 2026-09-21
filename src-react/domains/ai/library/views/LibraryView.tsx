/**
 * 资料库「我的资料」（spec §5 + 树改迭代）：左树形栏（标题/搜索入口/
 * 最近+我的资料快捷项/文件夹树，可收起成窄条；收起按钮在主区标题行）+
 * 主区两态——列表态（全部|收藏 Tab + 当前数据源文件 + 工具栏：类型筛选/
 * 上传；排序在列表列头，新建文件夹在树栏「+」）/ 详情态（选中文件预览 +
 * 元信息 + 行操作，LibraryDetailPanel）。视图路由三态（recent 默认 /
 * folder），Tab 优先于视图（收藏=全局收藏）；排序与类型筛选前端本地
 * （单层数据量小，skill 页先例）；拖拽入库（拖到页面任意处）。
 */
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PanelLeftClose, Upload } from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/button";
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
  type LibraryViewRoute,
  type SortField,
} from "../lib/library-view-model";
import LibraryFileList, { TYPE_LABEL_KEY } from "../components/LibraryFileList";
import LibraryItemDialogs from "../components/LibraryItemDialogs";
import LibraryMoveDialog from "../components/LibraryMoveDialog";
import LibrarySidebarTree from "../components/LibrarySidebarTree";
import LibraryDetailPanel from "../components/LibraryDetailPanel";
import LibraryCommandDialog from "../components/LibraryCommandDialog";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { invoke } from "@/lib/ipc";

const TYPE_FILTERS = ["all", ...Object.keys(TYPE_LABEL_KEY)];

/** 列表数据源返回形态：list（分页对象）或 recent/favorites（平铺数组） */
type ListQueryData =
  LibraryItem[] | { items: LibraryItem[]; breadcrumbs: LibraryItem[] };

export default function LibraryView() {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  // 主区视图路由（spec §5）：默认「最近」；folder 为文件夹层（null=根）
  const [view, setView] = useState<LibraryViewRoute>({ type: "recent" });
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [commandOpen, setCommandOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("activity");
  // activity 默认降序（最近优先），与 handleToggleSort 的 name→升序约定一致
  const [sortAsc, setSortAsc] = useState(false);
  const [dialog, setDialog] = useState<{
    mode: "createFolder" | "rename";
    item?: LibraryItem;
  } | null>(null);
  const [moveIds, setMoveIds] = useState<number[] | null>(null);
  const [deleteItem, setDeleteItem] = useState<LibraryItem | null>(null);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 树改迭代：左栏收起态 + 主区详情态选中文件
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [detailItem, setDetailItem] = useState<LibraryItem | null>(null);

  // ⌘K/Ctrl+K 唤起搜索命令面板：组件挂载即注册（资料库路由独占，
  // 卸载自动移除，不与全局冲突）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tab 优先于视图：收藏为全局收藏，其余按视图路由取数
  // （返回形态联合，显式泛型避免 useQuery 推断失败）
  const listQuery = useQuery<ListQueryData>({
    queryKey:
      tab === "favorites"
        ? ["libraryFavorites"]
        : view.type === "recent"
          ? ["libraryRecent"]
          : ["libraryItems", view.id],
    queryFn: () =>
      tab === "favorites"
        ? LibraryApi.listFavorites()
        : view.type === "recent"
          ? LibraryApi.listRecent()
          : LibraryApi.list(view.id ?? undefined),
  });
  // 动态标题的文件夹名来源（与树栏共用 libraryTree 缓存）
  const treeQuery = useQuery({
    queryKey: ["libraryTree"],
    queryFn: () => LibraryApi.tree(),
  });

  // list（分页对象）与 recent/favorites（平铺数组）返回形态不同，统一为列表
  const rawItems = useMemo(() => {
    const data = listQuery.data;
    if (!data) {
      return [];
    }
    return Array.isArray(data) ? data : data.items;
  }, [listQuery.data]);
  const items = useMemo(
    () =>
      sortItems(
        filterByType(rawItems, typeFilter),
        sortField,
        sortAsc ? "asc" : "desc",
      ),
    [rawItems, typeFilter, sortField, sortAsc],
  );

  // 主区两态互斥：详情态优先，默认列表态（搜索态已由命令面板取代）
  const viewMode = detailItem ? "detail" : "list";

  // 新建/上传目标层：folder 视图即当前层，recent 无层语境落根
  const activeFolderId = view.type === "folder" ? view.id : null;

  // 动态标题：Tab 名 > 视图名（folder 取树数据实时名，缺失回退根名）
  const folderName = (id: number) =>
    treeQuery.data?.find((row) => row.id === id)?.name;
  const pageTitle =
    tab === "favorites"
      ? t("chat:library.tabFavorites")
      : view.type === "recent"
        ? t("chat:library.recentEntry")
        : ((view.type === "folder" && view.id !== null
            ? folderName(view.id)
            : undefined) ?? t("chat:library.mine"));

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["libraryItems"] });
    await queryClient.invalidateQueries({ queryKey: ["libraryRecent"] });
    await queryClient.invalidateQueries({ queryKey: ["libraryFavorites"] });
    await queryClient.invalidateQueries({ queryKey: ["libraryTree"] });
  };

  /** 树栏/列表的视图导航统一入口：切视图回落「全部」Tab 并关详情 */
  const handleSelectView = (next: LibraryViewRoute) => {
    setView(next);
    setTab("all");
    setDetailItem(null);
  };

  /** 列头排序：同列点切换升降；换列回落该列默认向（name 升 / activity 降） */
  const handleToggleSort = (field: SortField) => {
    if (field === sortField) {
      setSortAsc((v) => !v);
    } else {
      setSortField(field);
      setSortAsc(field === "name");
    }
  };

  /** 收藏切换：直调 + invalidate 重拉（失败 toast 不阻断） */
  const handleToggleFavorite = async (item: LibraryItem) => {
    try {
      await LibraryApi.toggleFavorite(item.id);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 进入详情态的唯一入口：file 顺带 markViewed 打点（NEW 徽标随重拉消失，
   *  打点失败不阻断预览） */
  const openDetail = (item: LibraryItem) => {
    setDetailItem(item);
    if (item.kind === "file") {
      void LibraryApi.markViewed(item.id)
        .then(() => invalidate())
        .catch(() => undefined);
    }
  };

  /** 上传：系统选择器多选 → addFiles 到目标层 */
  const handleUpload = async () => {
    let paths: string[] | null;
    try {
      paths = await invoke<string[] | null>("file:pickLocalFiles");
    } catch {
      toast.error(t("chat:library.pickFailed"));
      return;
    }
    if (!paths) {
      return;
    }
    await ingest(paths);
  };

  const ingest = async (paths: string[]) => {
    try {
      const result = await LibraryApi.addFiles(
        paths,
        activeFolderId ?? undefined,
      );
      if (result.added.length > 0 || result.failed.length > 0) {
        // 重名自动编号告知（spec 裁定 7）：按 added 条目自身口径比对——
        // 入库后名与源文件名（originalPath 尾段）不同的条目计数；不按
        // paths 索引配对（混合成功/失败批次会错位）
        const renamedCount = result.added.filter((item) => {
          const origin = item.originalPath?.split(/[\\/]/).pop();
          return origin !== undefined && item.name !== origin;
        }).length;
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
        await LibraryApi.createFolder(name, activeFolderId ?? undefined);
      } else if (dialog.item) {
        await LibraryApi.rename(dialog.item.id, name);
      }
      setDialog(null);
      // 重命名后详情态的本地对象已过期——回列表态（数据经 invalidate 重拉）
      setDetailItem(null);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  /** 打开删除确认：folder 顺带拉子树内容数（spec §5 删除提示含内容数）；
   *  拉取失败退回通用文案，不阻断确认 */
  const openDelete = (item: LibraryItem) => {
    setDeleteItem(item);
    setDeleteCount(null);
    if (item.kind === "folder") {
      LibraryApi.subtreeCount(item.id)
        .then(setDeleteCount)
        .catch(() => setDeleteCount(null));
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
      setDeleteCount(null);
      // 删除的就是详情本体——回列表态
      setDetailItem(null);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="flex h-full"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void handleDrop(e)}
    >
      <LibrarySidebarTree
        collapsed={treeCollapsed}
        onToggleCollapse={() => setTreeCollapsed(false)}
        view={view}
        onSelectView={handleSelectView}
        onOpenSearch={() => setCommandOpen(true)}
        onCreateFolder={() => setDialog({ mode: "createFolder" })}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-4">
        <PageTitle title={pageTitle}>
          {/* 收起按钮（Task 5 移入主区标题行；展开态树栏顶部行不再有） */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={t("chat:library.collapseSidebar")}
              aria-label={t("chat:library.collapseSidebar")}
              className="rounded-md p-1 hover:bg-primary-foreground/20"
              onClick={() => setTreeCollapsed(true)}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
        </PageTitle>
        {viewMode === "detail" && detailItem ? (
          <div className="min-h-0 flex-1">
            <LibraryDetailPanel
              item={detailItem}
              onBack={() => setDetailItem(null)}
              onRename={(item) => setDialog({ mode: "rename", item })}
              onMove={(item) => setMoveIds([item.id])}
              onReveal={(item) =>
                void LibraryApi.revealItem(item.id).catch((e) =>
                  toast.error(mapIpcError(e)),
                )
              }
              onDelete={openDelete}
            />
          </div>
        ) : (
          <>
            {/* 工具栏：全部|收藏 Tab（左）+ 类型筛选/上传（右）；
                排序在列表列头，新建文件夹在树栏「+」 */}
            <div className="flex flex-wrap items-center gap-2 py-3">
              <div className="inline-flex items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-sm">
                {(["all", "favorites"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`rounded-md px-3 py-1 ${
                      tab === key
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-primary"
                    }`}
                    onClick={() => setTab(key)}
                  >
                    {t(
                      key === "all"
                        ? "chat:library.tabAll"
                        : "chat:library.tabFavorites",
                    )}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
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
                            : (TYPE_LABEL_KEY[type] ??
                                "chat:library.typeOther"),
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={() => void handleUpload()}>
                  <Upload className="mr-1 h-4 w-4" />
                  {t("chat:library.upload")}
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {listQuery.isError ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t("chat:library.loadFailed")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                    onClick={() => void listQuery.refetch()}
                  >
                    {t("chat:library.retry")}
                  </Button>
                </div>
              ) : (
                <LibraryFileList
                  items={items}
                  loading={listQuery.isLoading}
                  emptyText={
                    view.type === "recent" && tab === "all"
                      ? t("chat:library.recentEmpty")
                      : undefined
                  }
                  sortField={sortField}
                  sortAsc={sortAsc}
                  onToggleSort={handleToggleSort}
                  onToggleFavorite={(item) => void handleToggleFavorite(item)}
                  onOpen={(item) =>
                    handleSelectView({ type: "folder", id: item.id })
                  }
                  onPreview={openDetail}
                  onRename={(item) => setDialog({ mode: "rename", item })}
                  onMove={(item) => setMoveIds([item.id])}
                  onReveal={(item) =>
                    void LibraryApi.revealItem(item.id).catch((e) =>
                      toast.error(mapIpcError(e)),
                    )
                  }
                  onDelete={openDelete}
                />
              )}
            </div>
          </>
        )}
      </div>

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
        onMoved={() => {
          // 移动后详情态的本地对象层级已过期——回列表态
          setDetailItem(null);
          void invalidate();
        }}
      />
      <AlertDialog
        open={deleteItem !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteItem(null);
            setDeleteCount(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:library.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteItem?.kind === "folder"
                ? deleteCount
                  ? t("chat:library.deleteFolderCountHint", {
                      name: deleteItem.name,
                      count: deleteCount,
                    })
                  : t("chat:library.deleteFolderHint")
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
      <LibraryCommandDialog
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onSelect={(item) => {
          setCommandOpen(false);
          openDetail(item);
        }}
      />
    </div>
  );
}
