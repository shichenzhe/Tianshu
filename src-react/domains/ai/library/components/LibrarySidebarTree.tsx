/**
 * 资料库树形栏（左，spec §2.1 重排版）：搜索按钮（点击唤起命令面板；
 * 样式对齐「最近」行；「资料库」模块标题在 TopBar 顶行，栏内不占行）+
 * 快捷入口（「最近」/「本地产物」）+「我的资料」树根节点（展开/收起
 * 整棵文件夹树，点行进根层；行尾「+」菜单：新建文档/表格/文件夹、
 * 上传和导入（文件/文件夹）、添加链接）。
 * 文件夹行 hover 显示「+ 快速新建」（目标层=该文件夹）与「... 更多」
 * （添加到任务/重命名（行内编辑）/移动/删除红字）。树数据
 * libraryTree 全量平铺（folder+file+link）经 buildFolderTree 组嵌套——
 * 文件/链接作叶子挂文件夹下（点击预览/外开，行内重命名/移动/删除同
 * 文件夹）；选中文件夹即主区导航；folder 视图祖先链自动展开保证选中
 * 项可见。收/展单按钮在 TopBar 顶行（唯一入口，随收/展换图标）；
 * 收起态由 LibraryView 整体隐藏本栏（无窄条）。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Clock,
  FilePlus2,
  FileText,
  FileUp,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link2,
  ListTodo,
  MoreHorizontal,
  Package,
  PenLine,
  Plus,
  Search,
  Table,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import LibraryApi from "../api/library.api";
import {
  buildFolderTree,
  splitFileName,
  type FolderTreeNode,
  type LibraryViewRoute,
} from "../lib/library-view-model";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import IconTooltip from "./icon-tooltip";

/** 「+」菜单动作（LibraryView 编排：弹窗/选择器/直接建） */
export type LibraryPlusAction =
  | "newDoc"
  | "newSheet"
  | "newFolder"
  | "uploadFile"
  | "uploadFolder"
  | "addLink";

/** 树行「...」菜单动作（编排均在 LibraryView） */
export type LibraryNodeAction = "move" | "delete" | "addToTask";

/** 树行节点标识（... 菜单/预览回传；kind 供删除确认/预览分流） */
export type LibraryTreeNodeRef = {
  id: number;
  name: string;
  kind: "folder" | "file" | "link";
};

interface LibrarySidebarTreeProps {
  /** 主区当前视图路由；folder 态选中项高亮，recent 态无选中 */
  view: LibraryViewRoute;
  onSelectView: (view: LibraryViewRoute) => void;
  /** 唤起搜索命令面板（Task 6 完整实现） */
  onOpenSearch: () => void;
  /** 点击文件/链接行：预览详情 / 外开浏览器（LibraryView 查全量行分发） */
  onOpenItem: (id: number) => void;
  /** 「+」菜单动作分发；folderId 显式传入=该文件夹为目标层（hover +），
   *  缺省=调用方语境层（根节点 +，即当前 folder 视图层） */
  onPlusAction: (action: LibraryPlusAction, folderId?: number) => void;
  /** 树行「...」菜单动作编排（移动/删除/添加到任务） */
  onNodeAction: (action: LibraryNodeAction, node: LibraryTreeNodeRef) => void;
  /** 行内重命名提交（空名/未变由本组件拦截不提交） */
  onSubmitRename: (id: number, name: string) => void;
}

export default function LibrarySidebarTree({
  view,
  onSelectView,
  onOpenSearch,
  onOpenItem,
  onPlusAction,
  onNodeAction,
  onSubmitRename,
}: LibrarySidebarTreeProps) {
  const { t } = useTranslation(["chat"]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // 「我的资料」树根节点展开态（默认展开；与子节点 expanded 集合分开）
  const [rootOpen, setRootOpen] = useState(true);
  // 行内重命名中的节点 id（null=无）
  const [editingId, setEditingId] = useState<number | null>(null);

  const treeQuery = useQuery({
    queryKey: ["libraryTree"],
    queryFn: () => LibraryApi.tree(),
  });
  const nodes = useMemo(
    () => buildFolderTree(treeQuery.data ?? []),
    [treeQuery.data],
  );
  // id → parentId（祖先链自动展开用）
  const parentOf = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const row of treeQuery.data ?? []) {
      map.set(row.id, row.parentId);
    }
    return map;
  }, [treeQuery.data]);

  // 主区当前选中文件夹（recent 态无选中）
  const folderId = view.type === "folder" ? view.id : null;

  // 选中变化：沿 parentId 链补展开（深层选中项在树上可见）
  useEffect(() => {
    if (folderId === null) {
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      let cursor = parentOf.get(folderId) ?? null;
      while (cursor !== null && !next.has(cursor)) {
        next.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
      return next.size === prev.size ? prev : next;
    });
  }, [folderId, parentOf]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <TooltipProvider>
      <aside
        data-testid="library-sidebar"
        className="flex w-56 shrink-0 flex-col border-r border-border/50"
      >
        {/* 「资料库」模块标题已迁 TopBar 顶行——栏内直接从搜索开始 */}
        {/* 搜索按钮：点击唤起命令面板（样式对齐「最近」快捷行） */}
        <div className="px-1.5 pb-1 pt-1">
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("chat:library.searchEntry")}</span>
          </button>
        </div>
        {/* 快捷入口：最近 / 本地产物 / 我的资料（树根节点） */}
        <div className="space-y-0.5 px-1.5">
          <button
            type="button"
            onClick={() => onSelectView({ type: "recent" })}
            className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm ${
              view.type === "recent"
                ? "bg-primary-subtle text-primary"
                : "text-foreground hover:bg-primary-subtle hover:text-primary"
            }`}
          >
            <Clock className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("chat:library.recentEntry")}</span>
          </button>
          {/* 本地产物：跨会话 write_file 聚合（自带列表+预览，无文件夹语义） */}
          <button
            type="button"
            onClick={() => onSelectView({ type: "artifacts" })}
            className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm ${
              view.type === "artifacts"
                ? "bg-primary-subtle text-primary"
                : "text-foreground hover:bg-primary-subtle hover:text-primary"
            }`}
          >
            <Package className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("chat:library.localArtifacts")}</span>
          </button>
          {/* 「我的资料」树根节点：箭头收/展整棵树，点行进根层；行尾「+」菜单 */}
          <div
            className={`flex items-center rounded-md text-sm ${
              view.type === "folder"
                ? "bg-primary-subtle text-primary"
                : "text-foreground hover:bg-primary-subtle hover:text-primary"
            }`}
          >
            <IconTooltip label={t("chat:library.mine")}>
              <button
                type="button"
                aria-label={t("chat:library.mine")}
                onClick={() => setRootOpen((v) => !v)}
                className="shrink-0 rounded p-1 hover:text-primary"
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                    rootOpen ? "rotate-90" : ""
                  }`}
                />
              </button>
            </IconTooltip>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-1 text-left"
              onClick={() => onSelectView({ type: "folder", id: null })}
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="truncate">{t("chat:library.mine")}</span>
            </button>
            <PlusMenu onAction={(a) => onPlusAction(a)} />
          </div>
        </div>
        {/* 文件夹树：「我的资料」的子层，随根节点展开/收起 */}
        <div className="flex-1 overflow-y-auto p-1.5">
          {rootOpen &&
            nodes.map((node) => (
              <TreeNodeRow
                key={node.id}
                node={node}
                depth={1}
                expanded={expanded}
                selectedFolderId={folderId ?? undefined}
                editingId={editingId}
                onToggleExpand={toggleExpand}
                onSelectFolder={(id) => onSelectView({ type: "folder", id })}
                onOpenItem={onOpenItem}
                onStartRename={setEditingId}
                onSubmitRename={onSubmitRename}
                onPlusAction={onPlusAction}
                onNodeAction={onNodeAction}
              />
            ))}
        </div>
      </aside>
    </TooltipProvider>
  );
}

/**
 * 「+」快速新建菜单（根节点行尾 / 文件夹行 hover / 主区「快速添加」）：
 * 新建三类 / 上传和导入（子菜单）/ 添加链接。trigger icon=树栏圆钮，
 * button=主区带文字描边按钮。
 */
export function PlusMenu({
  onAction,
  trigger = "icon",
}: {
  onAction: (a: LibraryPlusAction) => void;
  trigger?: "icon" | "button";
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <DropdownMenu>
      {trigger === "button" ? (
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("chat:library.quickAdd")}
          </Button>
        </DropdownMenuTrigger>
      ) : (
        // 图标钮冒泡提示：TooltipTrigger 与 DropdownMenuTrigger 双 asChild
        // 链式叠加到同一 button（FilterPopover 先例）
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("chat:library.newMenuLabel")}
                className="mr-1 shrink-0 rounded p-1 hover:bg-primary-subtle hover:text-primary"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("chat:library.newMenuLabel")}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent
        align="start"
        className="border border-border/50 rounded-lg shadow-lg"
      >
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => onAction("newDoc")}
        >
          <FilePlus2 className="mr-2 h-4 w-4" />
          {t("chat:library.newDoc")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => onAction("newSheet")}
        >
          <Table className="mr-2 h-4 w-4" />
          {t("chat:library.newSheet")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => onAction("newFolder")}
        >
          <FolderPlus className="mr-2 h-4 w-4" />
          {t("chat:library.newFolder")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <Upload className="mr-2 h-4 w-4" />
            {t("chat:library.uploadImport")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="border border-border/50 rounded-lg shadow-lg">
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => onAction("uploadFile")}
            >
              <FileUp className="mr-2 h-4 w-4" />
              {t("chat:library.uploadFile")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => onAction("uploadFolder")}
            >
              <FolderUp className="mr-2 h-4 w-4" />
              {t("chat:library.uploadFolder")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => onAction("addLink")}
        >
          <Link2 className="mr-2 h-4 w-4" />
          {t("chat:library.addLink")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 递归树节点行：文件夹行 = 展开箭头（旋转）+ 文件夹名 + hover 操作组
 * （+ 快速新建于本层 / ... 更多：添加到任务、重命名（行内编辑，回车
 * 提交 Esc 取消）、移动、删除红字）；文件/链接行 = 叶子（箭头位占位
 * 对齐 + 类型图标，点击预览/外开，... 菜单同文件夹减「+」）；子层缩进
 * 渲染。
 */
function TreeNodeRow({
  node,
  depth,
  expanded,
  selectedFolderId,
  editingId,
  onToggleExpand,
  onSelectFolder,
  onOpenItem,
  onStartRename,
  onSubmitRename,
  onPlusAction,
  onNodeAction,
}: {
  node: FolderTreeNode;
  depth: number;
  expanded: Set<number>;
  selectedFolderId: number | undefined;
  editingId: number | null;
  onToggleExpand: (id: number) => void;
  onSelectFolder: (id: number) => void;
  onOpenItem: (id: number) => void;
  onStartRename: (id: number | null) => void;
  onSubmitRename: (id: number, name: string) => void;
  onPlusAction: (action: LibraryPlusAction, folderId?: number) => void;
  onNodeAction: (action: LibraryNodeAction, node: LibraryTreeNodeRef) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const isFolder = node.kind === "folder";
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedFolderId === node.id;
  const isEditing = editingId === node.id;
  return (
    <div>
      <div
        className={`group flex items-center rounded-md text-sm ${
          isSelected
            ? "bg-primary-subtle text-primary"
            : "hover:bg-primary-subtle hover:text-primary"
        }`}
        style={{ paddingLeft: depth * 12 }}
      >
        {isFolder ? (
          <IconTooltip label={node.name}>
            <button
              type="button"
              aria-label={node.name}
              onClick={() => onToggleExpand(node.id)}
              className="shrink-0 rounded p-1 hover:text-primary"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                  isExpanded ? "rotate-90" : ""
                }`}
              />
            </button>
          </IconTooltip>
        ) : (
          // 叶子行箭头位占位（与文件夹行图标起点对齐）
          <span className="w-[22px] shrink-0" aria-hidden="true" />
        )}
        {isEditing ? (
          <input
            autoFocus
            defaultValue={splitFileName(node.name).stem}
            aria-label={t("chat:library.rename")}
            className="mr-1 min-w-0 flex-1 rounded border border-primary/30 bg-background px-1 py-0.5 text-sm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // 扩展名锁定：输入框只露主干，提交原样拼回（类型不可改）
                const { ext } = splitFileName(node.name);
                const stem = e.currentTarget.value.trim();
                if (stem && `${stem}${ext}` !== node.name) {
                  onSubmitRename(node.id, `${stem}${ext}`);
                }
                onStartRename(null);
              }
              if (e.key === "Escape") {
                onStartRename(null);
              }
            }}
            onBlur={() => onStartRename(null)}
          />
        ) : (
          <button
            type="button"
            onClick={() =>
              isFolder ? onSelectFolder(node.id) : onOpenItem(node.id)
            }
            className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-1 text-left"
          >
            {isFolder ? (
              <Folder className="h-3.5 w-3.5 shrink-0" />
            ) : node.kind === "link" ? (
              <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
        )}
        {!isEditing && (
          <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {isFolder && (
              <PlusMenu onAction={(a) => onPlusAction(a, node.id)} />
            )}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("chat:library.moreActions")}
                      className="rounded p-1 hover:bg-primary-subtle hover:text-primary"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("chat:library.moreActions")}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="start"
                className="border border-border/50 rounded-lg shadow-lg"
              >
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => onNodeAction("addToTask", node)}
                >
                  <ListTodo className="mr-2 h-4 w-4" />
                  {t("chat:library.addToTask")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => onStartRename(node.id)}
                >
                  <PenLine className="mr-2 h-4 w-4" />
                  {t("chat:library.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => onNodeAction("move", node)}
                >
                  <FolderInput className="mr-2 h-4 w-4" />
                  {t("chat:library.move")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer text-destructive focus:text-destructive"
                  onClick={() => onNodeAction("delete", node)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("chat:library.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <TreeNodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selectedFolderId={selectedFolderId}
            editingId={editingId}
            onToggleExpand={onToggleExpand}
            onSelectFolder={onSelectFolder}
            onOpenItem={onOpenItem}
            onStartRename={onStartRename}
            onSubmitRename={onSubmitRename}
            onPlusAction={onPlusAction}
            onNodeAction={onNodeAction}
          />
        ))}
    </div>
  );
}
