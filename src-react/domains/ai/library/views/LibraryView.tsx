/**
 * 资料库「我的资料」（spec §5）：左树形栏（搜索入口/「最近」+「本地
 * 产物」+「我的资料」快捷项/文件夹树；本地产物视图或收起态整体隐藏
 * 含搜索入口，不留窄条）+ 主区。TopBar 中段按两垂直面板对齐：
 * leading=树栏同宽的「资料库」（竖线恰落树栏右缘），其后（开关+动态
 * 标题+列表态工具栏）均属主面板正上方；产物态仅「返回资料库」按钮
 * （TopBar 左侧，列表/预览统一），不显示「资料库/本地产物」标题。
 * 列表态/详情态两态：列表（排序在列头）/详情（文件预览 + 元信息 +
 * 行操作）。
 * 搜索态已收敛为命令面板（⌘K 或树栏搜索入口唤起，空输入最近浏览/
 * 输入实时检索）；视图路由 recent（默认）/ folder（null=根），Tab
 * 优先于视图（收藏=全局收藏）；排序与类型筛选前端本地（单层数据量
 * 小，skill 页先例）；拖拽入库（拖到页面任意处）；「最近」视图全部
 * Tab 列表下方附推荐卡片区（快速上手引导，纯展示）。
 */
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { usePageHeader } from "@/components/layout/page-header.store";
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
import type { AddFilesResult } from "../api/library.api";
import LibraryArtifactsView from "../components/LibraryArtifactsView";
import LibraryRecommendSection from "../components/LibraryRecommendSection";
import type {
  LibraryNodeAction,
  LibraryPlusAction,
  LibraryTreeNodeRef,
} from "../components/LibrarySidebarTree";
import LibrarySidebarTree, { PlusMenu } from "../components/LibrarySidebarTree";
import {
  filterByType,
  sortItems,
  type LibraryViewRoute,
  type SortField,
} from "../lib/library-view-model";
import LibraryFileList, { TYPE_LABEL_KEY } from "../components/LibraryFileList";
import LibraryItemDialogs from "../components/LibraryItemDialogs";
import LibraryLinkDialog from "../components/LibraryLinkDialog";
import LibraryMoveDialog from "../components/LibraryMoveDialog";
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
  const navigate = useNavigate();
  // 主区视图路由（spec §5）：默认「最近」；folder 为文件夹层（null=根）
  const [view, setView] = useState<LibraryViewRoute>({ type: "recent" });
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [commandOpen, setCommandOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("activity");
  // activity 默认降序（最近优先），与 handleToggleSort 的 name→升序约定一致
  const [sortAsc, setSortAsc] = useState(false);
  const [dialog, setDialog] = useState<{
    mode: "createFolder" | "rename" | "addLink";
    item?: LibraryItem;
    /** 弹窗发起时锁定的目标层（树栏 hover「+」指定文件夹时非空） */
    targetFolderId?: number | null;
  } | null>(null);
  const [moveIds, setMoveIds] = useState<number[] | null>(null);
  const [deleteItem, setDeleteItem] = useState<LibraryItem | null>(null);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 左栏收起态 + 主区详情态选中文件
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
  // （返回形态联合，显式泛型避免 useQuery 推断失败）；
  // artifacts 视图自带独立查询（LibraryArtifactsView），此处挂起不发
  const listQuery = useQuery<ListQueryData>({
    queryKey:
      tab === "favorites"
        ? ["libraryFavorites"]
        : view.type === "recent"
          ? ["libraryRecent"]
          : view.type === "folder"
            ? ["libraryItems", view.id]
            : ["libraryArtifactsView"],
    queryFn: () =>
      tab === "favorites"
        ? LibraryApi.listFavorites()
        : view.type === "recent"
          ? LibraryApi.listRecent()
          : view.type === "folder"
            ? LibraryApi.list(view.id ?? undefined)
            : Promise.resolve({ items: [], breadcrumbs: [] }),
    enabled: view.type !== "artifacts",
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
      : view.type === "artifacts"
        ? t("chat:library.localArtifacts")
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

  // 树栏收/展开关（唯一入口，随收/展换图标）；注册进 TopBar 顶行
  const sidebarToggle = (
    <button
      type="button"
      title={
        treeCollapsed
          ? t("chat:library.expandSidebar")
          : t("chat:library.collapseSidebar")
      }
      aria-label={
        treeCollapsed
          ? t("chat:library.expandSidebar")
          : t("chat:library.collapseSidebar")
      }
      className="rounded-md p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
      onClick={() => setTreeCollapsed((v) => !v)}
    >
      {treeCollapsed ? (
        <PanelLeftOpen className="h-4 w-4" />
      ) : (
        <PanelLeftClose className="h-4 w-4" />
      )}
    </button>
  );

  // TopBar 中段按两垂直面板对齐：leading 占与树栏同宽（w-56 减中段
  // px-3 前衬）的「资料库」标题——竖分隔线恰落在树栏右缘，其后
  // （开关+动态标题+列表态工具栏）均属主面板正上方。树栏收起时标题
  // 与竖线随之隐藏（面板分界不存在，不占空间）。产物态树栏隐藏：
  // 左侧仅「返回资料库」按钮（列表/预览统一），不显示「资料库/本地
  // 产物」标题（用户裁定）
  usePageHeader({
    leading:
      view.type === "artifacts" ? (
        <button
          type="button"
          onClick={() => handleSelectView({ type: "recent" })}
          className="flex items-center gap-1 rounded-md p-1 text-sm text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("chat:library.backToLibrary")}
        </button>
      ) : !treeCollapsed ? (
        <span className="flex w-[212px] items-center pl-3 text-sm font-semibold text-foreground">
          {t("chat:library.title")}
        </span>
      ) : undefined,
    title:
      view.type === "artifacts" ? undefined : (
        // 竖线 = 树栏右缘/主面板左缘（收起态无分界不渲染），其后属主面板
        <>
          {!treeCollapsed && (
            <span className="h-4 w-px bg-border" aria-hidden="true" />
          )}
          {sidebarToggle}
          <span className="truncate text-sm font-medium text-foreground">
            {pageTitle}
          </span>
        </>
      ),
    trailing:
      view.type !== "artifacts" && viewMode === "list" ? (
        <>
          {(["all", "favorites"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                tab === key
                  ? "text-primary"
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
          {/* 快速添加（PRD §4.2A）：主区侧右端，菜单同「+」 */}
          <PlusMenu trigger="button" onAction={(a) => handlePlusAction(a)} />
        </>
      ) : undefined,
  });

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
   *  打点失败不阻断预览）；link 不进详情——外开浏览器并打点进「最近」 */
  const openDetail = (item: LibraryItem) => {
    if (item.kind === "link") {
      void LibraryApi.openLink(item.id)
        .then(async () => {
          await LibraryApi.markViewed(item.id).catch(() => undefined);
          await invalidate();
        })
        .catch((e) => toast.error(mapIpcError(e)));
      return;
    }
    setDetailItem(item);
    if (item.kind === "file") {
      void LibraryApi.markViewed(item.id)
        .then(() => invalidate())
        .catch(() => undefined);
    }
  };

  /** 上传：系统选择器多选 → addFiles 到目标层 */
  const handleUpload = async (target: number | null) => {
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
    await ingest(paths, target);
  };

  const ingest = async (paths: string[], target: number | null) => {
    try {
      const result = await LibraryApi.addFiles(paths, target ?? undefined);
      reportIngest(result);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 入库结果 toast（addFiles / importFolder 共用）：成功计数 + 重名编号 + 失败段 */
  const reportIngest = (result: AddFilesResult) => {
    if (result.added.length === 0 && result.failed.length === 0) {
      return;
    }
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
  };

  /** 上传文件夹：系统目录选择器 → importFolder（以目录名建根，子层递归） */
  const handleUploadFolder = async (target: number | null) => {
    let dirPath: string | null;
    try {
      dirPath = await invoke<string | null>("file:pickLocalFolder");
    } catch {
      toast.error(t("chat:library.pickFailed"));
      return;
    }
    if (!dirPath) {
      return;
    }
    try {
      reportIngest(await LibraryApi.importFolder(dirPath, target ?? undefined));
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 新建空文件（+菜单「新建文档/表格」）：默认名同层自动编号 */
  const handleCreateFile = async (fileName: string, target: number | null) => {
    try {
      const item = await LibraryApi.createFile(fileName, target ?? undefined);
      toast.success(t("chat:library.createdToast", { name: item.name }));
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 树栏/主区「+」菜单动作编排：文档/表格直接建、文件夹与链接走弹窗
   *  （目标层随弹窗锁定）、上传走系统选择器；folderId 显式传入（文件夹
   *  行 hover「+」）优先，缺省=当前 folder 视图层（recent 落根） */
  const handlePlusAction = (action: LibraryPlusAction, folderId?: number) => {
    const target = folderId ?? activeFolderId ?? null;
    switch (action) {
      case "newFolder":
        setDialog({ mode: "createFolder", targetFolderId: target });
        return;
      case "addLink":
        setDialog({ mode: "addLink", targetFolderId: target });
        return;
      case "newDoc":
        void handleCreateFile(`${t("chat:library.untitledDoc")}.md`, target);
        return;
      case "newSheet":
        void handleCreateFile(`${t("chat:library.untitledSheet")}.csv`, target);
        return;
      case "uploadFile":
        void handleUpload(target);
        return;
      case "uploadFolder":
        void handleUploadFolder(target);
        return;
    }
  };

  /** 树栏树行「...」菜单编排：移动/删除复用既有弹窗（删除确认按真实
   *  kind 区分文件/文件夹文案）；添加到任务跳自动化创建并预填（名称→
   *  任务名，说明→提示词，PRD §5.2） */
  const handleNodeAction = (
    action: LibraryNodeAction,
    node: LibraryTreeNodeRef,
  ) => {
    if (action === "move") {
      setMoveIds([node.id]);
      return;
    }
    if (action === "delete") {
      // openDelete 仅消费 id/name/kind（子树计数主进程算）——构造最小对象
      openDelete({
        id: node.id,
        name: node.name,
        kind: node.kind,
      } as LibraryItem);
      return;
    }
    navigate("/module/ai/automation", {
      state: {
        libraryPrefill: {
          name: node.name,
          prompt: t("chat:library.addToTaskPrompt", { name: node.name }),
        },
      },
    });
  };

  /** 树栏点击文件/链接行：树缓存查全量行进详情预览（link 外开浏览器，
   *  口径与主区列表一致）；缓存缺失（删除竞态）静默不动作 */
  const handleOpenTreeItem = (id: number) => {
    const row = treeQuery.data?.find((item) => item.id === id);
    if (row) {
      openDetail(row);
    }
  };

  /** 树栏/详情标题行内重命名提交（folder/link 纯 DB，file 后端双写盘；
   *  详情开着同条目时同步新行——标题/元信息即时更新；失败 toast 不阻断） */
  const handleSubmitItemRename = async (id: number, name: string) => {
    try {
      const updated = await LibraryApi.rename(id, name);
      setDetailItem((prev) => (prev?.id === id ? updated : prev));
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
      await ingest(paths, activeFolderId ?? null);
    }
  };

  /** 添加链接提交（+菜单弹窗）：地址 http(s) 后端终校验；目标层为弹窗
   *  发起时锁定值（缺省=当前 folder 视图层） */
  const handleSubmitLink = async (url: string, title: string | null) => {
    setSubmitting(true);
    try {
      await LibraryApi.addLink(
        url,
        title,
        dialog?.targetFolderId ?? activeFolderId ?? undefined,
      );
      setDialog(null);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitName = async (name: string) => {
    if (!dialog) {
      return;
    }
    setSubmitting(true);
    try {
      if (dialog.mode === "createFolder") {
        await LibraryApi.createFolder(
          name,
          dialog.targetFolderId ?? activeFolderId ?? undefined,
        );
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
      {/* 树形栏：本地产物视图或收起态整体不渲染（含搜索入口，收起不留
          窄条——彻底隐藏，用户裁定）；开关在主区顶行，点开展开恢复 */}
      {view.type !== "artifacts" && !treeCollapsed && (
        <LibrarySidebarTree
          view={view}
          onSelectView={handleSelectView}
          onOpenSearch={() => setCommandOpen(true)}
          onOpenItem={handleOpenTreeItem}
          onPlusAction={handlePlusAction}
          onNodeAction={handleNodeAction}
          onSubmitRename={(id, name) => void handleSubmitItemRename(id, name)}
        />
      )}
      {/* 产物视图顶行仅注册标题（自带返回行/工具栏）——主区顶部收紧更甚 */}
      <div
        className={`flex min-w-0 flex-1 flex-col overflow-hidden px-8 ${
          view.type === "artifacts" ? "py-2" : "py-4"
        }`}
      >
        {/* 标题行与工具栏已迁 TopBar 顶行（usePageHeader）——主区直接
            从滚动内容开始，上方留白最小化 */}
        {view.type === "artifacts" ? (
          // 本地产物视图：自带工具栏+树状列表+预览三态（预览不走
          // detailItem，那是 libraryItem 语义）；Tab/上传无文件夹语境不渲染
          <LibraryArtifactsView />
        ) : viewMode === "detail" && detailItem ? (
          <div className="min-h-0 flex-1">
            <LibraryDetailPanel
              item={detailItem}
              onBack={() => {
                // 详情关闭时刷新一次列表（md/csv 实时保存的 size/时间
                // 变更落地；编辑中不逐次 invalidate 防高频重拉）
                setDetailItem(null);
                void invalidate();
              }}
              onItemUpdate={(updated) => setDetailItem(updated)}
              onSubmitRename={(id, name) =>
                void handleSubmitItemRename(id, name)
              }
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
            {/* 排序在列表列头，新建在树栏「+」与顶行「快速添加」 */}
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
                    tab === "favorites"
                      ? t("chat:library.favoritesEmpty")
                      : view.type === "recent"
                        ? t("chat:library.recentEmpty")
                        : undefined
                  }
                  emptyGuide={
                    view.type === "folder"
                      ? {
                          title: t("chat:library.folderEmptyTitle"),
                          hint: t("chat:library.folderEmptyHint"),
                        }
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
              {/* 推荐卡片区：仅「最近」视图 + 全部 Tab + 列表非错误态展示 */}
              {view.type === "recent" &&
                tab === "all" &&
                !listQuery.isError && <LibraryRecommendSection />}
            </div>
          </>
        )}
      </div>

      <LibraryItemDialogs
        open={dialog !== null && dialog.mode !== "addLink"}
        mode={dialog?.mode === "rename" ? "rename" : "createFolder"}
        initialName={dialog?.item?.name ?? ""}
        submitting={submitting}
        onClose={() => setDialog(null)}
        onSubmit={(name) => void handleSubmitName(name)}
      />
      <LibraryLinkDialog
        open={dialog?.mode === "addLink"}
        submitting={submitting}
        onClose={() => setDialog(null)}
        onSubmit={(url, title) => void handleSubmitLink(url, title)}
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
