/**
 * 资料库树形栏（左）：顶部按钮行（搜索 / 切回文件列表 / 收起）+
 * 文件夹树。树数据 library:tree 全量平铺经 buildFolderTree 组嵌套；
 * 选中文件夹即主区导航（替代面包屑）；当前层祖先链自动展开保证
 * 选中项可见。收起成窄条（仅图标列）；搜索输入内嵌于顶部行——
 * 输入即主区切搜索态，清空/Esc 回列表态。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import LibraryApi from "../api/library.api";
import {
  buildFolderTree,
  type FolderTreeNode,
} from "../lib/library-view-model";

interface LibrarySidebarTreeProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 主区当前层（null = 根）；选中文件夹即导航 */
  folderId: number | null;
  onSelectFolder: (id: number | null) => void;
  /** 搜索词（主区三态判据之一；由本栏输入驱动） */
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  /** 切回文件列表（清搜索词 + 关详情） */
  onBackToList: () => void;
  /** 详情/搜索态时可用（列表态已在列表，禁用） */
  backEnabled: boolean;
}

const ICON_BTN =
  "rounded-md p-1.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary disabled:pointer-events-none disabled:opacity-40";

export default function LibrarySidebarTree({
  collapsed,
  onToggleCollapse,
  folderId,
  onSelectFolder,
  keyword,
  onKeywordChange,
  onBackToList,
  backEnabled,
}: LibrarySidebarTreeProps) {
  const { t } = useTranslation(["chat"]);
  const [searchOpen, setSearchOpen] = useState(false);
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

  const closeSearch = () => {
    setSearchOpen(false);
    onKeywordChange("");
  };

  if (collapsed) {
    return (
      <aside
        data-testid="library-sidebar-collapsed"
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border/50 py-2"
      >
        <button
          type="button"
          title={t("chat:library.searchLabel")}
          aria-label={t("chat:library.searchLabel")}
          className={ICON_BTN}
          onClick={() => {
            onToggleCollapse();
            setSearchOpen(true);
          }}
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("chat:library.backToList")}
          aria-label={t("chat:library.backToList")}
          className={ICON_BTN}
          disabled={!backEnabled}
          onClick={onBackToList}
        >
          <ListTree className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("chat:library.expandSidebar")}
          aria-label={t("chat:library.expandSidebar")}
          className={`${ICON_BTN} mt-auto`}
          onClick={onToggleCollapse}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="library-sidebar"
      className="flex w-56 shrink-0 flex-col border-r border-border/50"
    >
      {/* 顶部按钮行：搜索（点开内嵌输入）/ 切回列表 / 收起 */}
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        {searchOpen ? (
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              autoFocus
              onChange={(e) => onKeywordChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  closeSearch();
                }
              }}
              placeholder={t("chat:library.searchPlaceholder")}
              className="h-7 pl-7 pr-7 text-xs"
            />
            {keyword !== "" && (
              <button
                type="button"
                aria-label={t("common:cancel")}
                onClick={closeSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ) : (
          <>
            <button
              type="button"
              title={t("chat:library.searchLabel")}
              aria-label={t("chat:library.searchLabel")}
              className={ICON_BTN}
              onClick={() => setSearchOpen(true)}
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t("chat:library.backToList")}
              aria-label={t("chat:library.backToList")}
              className={ICON_BTN}
              disabled={!backEnabled}
              onClick={onBackToList}
            >
              <ListTree className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t("chat:library.collapseSidebar")}
              aria-label={t("chat:library.collapseSidebar")}
              className={`${ICON_BTN} ml-auto`}
              onClick={onToggleCollapse}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      {/* 树：根「我的资料」+ 递归层 */}
      <div className="flex-1 overflow-y-auto p-1.5">
        <button
          type="button"
          onClick={() => onSelectFolder(null)}
          className={`mb-0.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium ${
            folderId === null
              ? "bg-primary-subtle text-primary"
              : "text-foreground hover:bg-primary-subtle hover:text-primary"
          }`}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("chat:library.mine")}</span>
        </button>
        {nodes.map((node) => (
          <TreeNodeRow
            key={node.id}
            node={node}
            depth={1}
            expanded={expanded}
            folderId={folderId}
            onToggleExpand={toggleExpand}
            onSelectFolder={onSelectFolder}
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
  folderId,
  onToggleExpand,
  onSelectFolder,
}: {
  node: FolderTreeNode;
  depth: number;
  expanded: Set<number>;
  folderId: number | null;
  onToggleExpand: (id: number) => void;
  onSelectFolder: (id: number | null) => void;
}) {
  const isExpanded = expanded.has(node.id);
  const isSelected = folderId === node.id;
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
            folderId={folderId}
            onToggleExpand={onToggleExpand}
            onSelectFolder={onSelectFolder}
          />
        ))}
    </div>
  );
}
