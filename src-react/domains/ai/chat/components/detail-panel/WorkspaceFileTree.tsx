/**
 * 工作空间 tab：纯目录树（懒加载），回归列表/树本体——点击文件由
 * onOpenFile 上抛 DetailPanel 开独立 file tab（WorkBuddy 对齐，内嵌
 * 预览形态已移除）。未绑定目录时空态引导（绑定入口在左侧空间菜单）。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderSearch } from "lucide-react";
import { WorkspaceApi, type WorkspaceRecord } from "../../../api/workspace.api";
import { mapIpcError } from "../../lib/error-message";
import FileTreeNode, { type TreeState } from "./FileTreeNode";

interface WorkspaceFileTreeProps {
  workspace: WorkspaceRecord;
  /** 点击文件：开独立 file tab（relPath 相对工作空间根） */
  onOpenFile: (relPath: string) => void;
}

export default function WorkspaceFileTree({
  workspace,
  onOpenFile,
}: WorkspaceFileTreeProps) {
  const { t } = useTranslation(["chat"]);
  const [tree, setTree] = useState<TreeState>({
    expanded: new Set(),
    children: new Map(),
  });
  const [loading, setLoading] = useState<Set<string>>(new Set());
  // 根（""）首拉失败且无缓存：树区顶部给错误行 + 内联重试（toast 保留
  // 作失败原因提示；有缓存的后续失败不打扰，仍展示旧树）
  const [rootFailed, setRootFailed] = useState(false);

  const loadDir = useCallback(
    async (relPath: string) => {
      setLoading((prev) => new Set(prev).add(relPath));
      try {
        const entries = await WorkspaceApi.listDir(workspace.id, relPath);
        setTree((prev) => {
          const children = new Map(prev.children).set(relPath, entries);
          const expanded = new Set(prev.expanded).add(relPath);
          return { expanded, children };
        });
        if (relPath === "") setRootFailed(false);
      } catch (e) {
        if (relPath === "") setRootFailed(true);
        toast.error(mapIpcError(e) || t("chat:detailPanel.loadDirFailed"));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(relPath);
          return next;
        });
      }
    },
    [workspace.id, t],
  );

  // 首拉根目录：仅已绑定目录（未绑定走空态引导，不触发 IPC 误报）；
  // directoryPath 入依赖——面板开着时首次绑定即拉取
  useEffect(() => {
    if (workspace.directoryPath) void loadDir("");
  }, [loadDir, workspace.directoryPath]);

  const handleToggle = useCallback(
    (relPath: string) => {
      if (tree.expanded.has(relPath)) {
        setTree((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.delete(relPath);
          return { ...prev, expanded };
        });
        return;
      }
      if (tree.children.has(relPath)) {
        setTree((prev) => {
          const expanded = new Set(prev.expanded).add(relPath);
          return { ...prev, expanded };
        });
      } else {
        void loadDir(relPath);
      }
    },
    [tree.expanded, tree.children, loadDir],
  );

  if (!workspace.directoryPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
        <FolderSearch className="h-8 w-8" />
        <p className="text-xs">{t("chat:detailPanel.workspaceBindHint")}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      {rootFailed && !tree.children.has("") && (
        <div className="mb-1 flex items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-xs text-muted-foreground">
          <span className="truncate">{t("chat:workspace.rootFailed")}</span>
          <button
            type="button"
            onClick={() => void loadDir("")}
            className="ml-auto shrink-0 rounded-md border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("chat:workspace.retryRoot")}
          </button>
        </div>
      )}
      {(tree.children.get("") ?? []).map((entry) => (
        <FileTreeNode
          key={entry.name}
          entry={entry}
          dirPath=""
          tree={tree}
          loading={loading}
          onToggle={handleToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}
