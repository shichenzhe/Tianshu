/**
 * 文件树递归节点：目录展开懒加载（按需 listDir），文件点击进入预览。
 * 展开态与子项缓存在 WorkspaceFileTree 的树状态里（本组件纯受控）。
 */
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
} from "lucide-react";
import type { DirEntry } from "@/domains/ai/api/workspace.api";

export interface TreeState {
  expanded: Set<string>;
  children: Map<string, DirEntry[]>;
}

interface FileTreeNodeProps {
  entry: DirEntry;
  dirPath: string; // 当前目录相对工作空间根的路径（"" 为根）
  tree: TreeState;
  loading: Set<string>;
  onToggle: (dirPath: string) => void;
  onOpenFile: (relPath: string) => void;
}

export default function FileTreeNode({
  entry,
  dirPath,
  tree,
  loading,
  onToggle,
  onOpenFile,
}: FileTreeNodeProps) {
  const { t } = useTranslation(["chat"]);
  const relPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
  const isOpen = tree.expanded.has(relPath);

  if (!entry.isDir) {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(relPath)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        // 加载中禁点：防连点重复拉取（视觉减淡 + "…" 徽标同显）
        disabled={loading.has(relPath)}
        onClick={() => onToggle(relPath)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-primary-subtle hover:text-primary disabled:pointer-events-none disabled:opacity-50"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
        {loading.has(relPath) && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            …
          </span>
        )}
      </button>
      {isOpen && (
        <div className="ml-3 border-l border-border/50 pl-1">
          {(tree.children.get(relPath) ?? []).map((child) => (
            <FileTreeNode
              key={child.name}
              entry={child}
              dirPath={relPath}
              tree={tree}
              loading={loading}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
          {loading.has(relPath) && (
            <p className="px-1.5 py-1 text-[10px] text-muted-foreground">
              {t("chat:detailPanel.loadingDir")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
