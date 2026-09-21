/**
 * 资料库树形栏（左，spec §2.1 重排版）：标题行 + 搜索框（点击唤起
 * 命令面板，非输入框）+ 快捷入口（「最近」/「我的资料」，后者带「+」
 * 新建）+ 根的子层文件夹树。树数据 libraryTree 全量平铺经
 * buildFolderTree 组嵌套；选中文件夹即主区导航；folder 视图祖先链
 * 自动展开保证选中项可见。收起按钮移交主区标题行；窄条仅保留置顶
 * 展开按钮与搜索入口。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Clock,
  Folder,
  FolderOpen,
  PanelLeftOpen,
  Plus,
  Search,
} from "lucide-react";

import LibraryApi from "../api/library.api";
import {
  buildFolderTree,
  type FolderTreeNode,
  type LibraryViewRoute,
} from "../lib/library-view-model";

interface LibrarySidebarTreeProps {
  collapsed: boolean;
  /** 窄条置顶展开按钮（收起按钮已移交主区标题行） */
  onToggleCollapse: () => void;
  /** 主区当前视图路由；folder 态选中项高亮，recent 态无选中 */
  view: LibraryViewRoute;
  onSelectView: (view: LibraryViewRoute) => void;
  /** 唤起搜索命令面板（Task 6 完整实现） */
  onOpenSearch: () => void;
  /** 「我的资料」行「+」新建文件夹 */
  onCreateFolder: () => void;
}

const ICON_BTN =
  "rounded-md p-1.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary disabled:pointer-events-none disabled:opacity-40";

export default function LibrarySidebarTree({
  collapsed,
  onToggleCollapse,
  view,
  onSelectView,
  onOpenSearch,
  onCreateFolder,
}: LibrarySidebarTreeProps) {
  const { t } = useTranslation(["chat"]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

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

  if (collapsed) {
    return (
      <aside
        data-testid="library-sidebar-collapsed"
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border/50 py-2"
      >
        {/* 展开按钮置顶：贴底（mt-auto）时用户收起后找不到入口，
            误以为无法展开 */}
        <button
          type="button"
          title={t("chat:library.expandSidebar")}
          aria-label={t("chat:library.expandSidebar")}
          className={ICON_BTN}
          onClick={onToggleCollapse}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("chat:library.searchLabel")}
          aria-label={t("chat:library.searchLabel")}
          className={ICON_BTN}
          onClick={onOpenSearch}
        >
          <Search className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="library-sidebar"
      className="flex w-56 shrink-0 flex-col border-r border-border/50"
    >
      {/* 标题行（spec §2.1）：大号标题，砍分享/导出 */}
      <div className="px-3 pb-1 pt-3">
        <h2 className="text-base font-semibold">{t("chat:library.title")}</h2>
      </div>
      {/* 搜索框：点击唤起命令面板（非输入框） */}
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2 rounded-md border border-border/50 px-2 py-1.5 text-sm text-muted-foreground hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <Search className="h-3.5 w-3.5" />
          <span>{t("chat:library.commandPlaceholder")}</span>
        </button>
      </div>
      {/* 快捷入口：最近 / 我的资料（后者带「+」新建） */}
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
        <div
          className={`flex items-center rounded-md text-sm ${
            view.type === "folder"
              ? "bg-primary-subtle text-primary"
              : "text-foreground hover:bg-primary-subtle hover:text-primary"
          }`}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
            onClick={() => onSelectView({ type: "folder", id: null })}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("chat:library.mine")}</span>
          </button>
          <button
            type="button"
            aria-label={t("chat:library.newFolder")}
            title={t("chat:library.newFolder")}
            className="mr-1 shrink-0 rounded p-1 hover:text-primary"
            onClick={onCreateFolder}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* 文件夹树：根的子层（根行即上方「我的资料」） */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {nodes.map((node) => (
          <TreeNodeRow
            key={node.id}
            node={node}
            depth={1}
            expanded={expanded}
            selectedFolderId={folderId ?? undefined}
            onToggleExpand={toggleExpand}
            onSelectFolder={(id) => onSelectView({ type: "folder", id })}
          />
        ))}
      </div>
    </aside>
  );
}

/** 递归树节点行：展开箭头（旋转）+ 文件夹名；子层缩进渲染 */
function TreeNodeRow({
  node,
  depth,
  expanded,
  selectedFolderId,
  onToggleExpand,
  onSelectFolder,
}: {
  node: FolderTreeNode;
  depth: number;
  expanded: Set<number>;
  selectedFolderId: number | undefined;
  onToggleExpand: (id: number) => void;
  onSelectFolder: (id: number) => void;
}) {
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedFolderId === node.id;
  return (
    <div>
      <div
        className={`flex items-center rounded-md text-sm ${
          isSelected
            ? "bg-primary-subtle text-primary"
            : "hover:bg-primary-subtle hover:text-primary"
        }`}
        style={{ paddingLeft: depth * 12 }}
      >
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
        <button
          type="button"
          onClick={() => onSelectFolder(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-1 text-left"
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <TreeNodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selectedFolderId={selectedFolderId}
            onToggleExpand={onToggleExpand}
            onSelectFolder={onSelectFolder}
          />
        ))}
    </div>
  );
}
