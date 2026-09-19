/**
 * 工作空间选择弹框（修订 spec 裁定 11：显式选择，替代默认跟随第一个）：
 * 单选 Dialog——搜索框按名称/目录过滤；行 = FolderOpen + 名称 + 绑定目录
 * （未绑不显示）；点击行置选中高亮（不立即生效），确定才写 store
 * （setter 自带 localStorage 持久化），取消不动。打开时以当前 workspaceId
 * 播种选中态；空列表 noWorkspace / 搜索无匹配 noMatch。数据走 ["workspaces"]
 * 共享缓存（GlobalSidebar 已预热，通常零额外 IPC）。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, FolderOpen, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import WorkspaceApi from "../../api/workspace.api";
import { cn } from "@/lib/utils";
import { useNewTaskStore } from "../store/new-task-store";

interface WorkspacePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function WorkspacePickerDialog({
  open,
  onOpenChange,
}: WorkspacePickerDialogProps) {
  const { t } = useTranslation(["newTask", "common"]);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const setWorkspaceId = useNewTaskStore((s) => s.setWorkspaceId);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const workspaces = data ?? [];

  // 打开时重置搜索并以当前选择播种；关闭即弃（未确定不落 store）
  useEffect(() => {
    if (open) {
      setKeyword("");
      setSelected(workspaceId);
    }
  }, [open, workspaceId]);

  const trimmedKeyword = keyword.trim().toLowerCase();
  const filteredWorkspaces = useMemo(
    () =>
      trimmedKeyword
        ? workspaces.filter(
            (workspace) =>
              workspace.name.toLowerCase().includes(trimmedKeyword) ||
              (workspace.directoryPath ?? "")
                .toLowerCase()
                .includes(trimmedKeyword),
          )
        : workspaces,
    [workspaces, trimmedKeyword],
  );

  const handleConfirm = () => {
    if (selected === null) {
      return;
    }
    setWorkspaceId(selected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="rounded-lg border-border/50 shadow-lg sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t("newTask:context.workspace")}</DialogTitle>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("newTask:context.searchWorkspace")}
              className="pl-9"
              aria-label={t("newTask:context.searchWorkspace")}
            />
          </div>
        </DialogHeader>

        {/* 单选行列表（整行可点选中，确定才生效） */}
        {filteredWorkspaces.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t(
              trimmedKeyword
                ? "newTask:context.noMatch"
                : "newTask:context.noWorkspace",
            )}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label={t("newTask:context.workspace")}
            className="max-h-[320px] space-y-2 overflow-y-auto pr-1"
          >
            {filteredWorkspaces.map((workspace) => {
              const checked = workspace.id === selected;
              return (
                <button
                  type="button"
                  key={workspace.id}
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setSelected(workspace.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border border-border/50 p-3 text-left transition-colors hover:border-primary/30 hover:bg-primary-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    checked && "border-primary/50 bg-primary-subtle",
                  )}
                >
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {workspace.name}
                    </span>
                    {workspace.directoryPath && (
                      <span
                        className="mt-0.5 block truncate text-xs text-muted-foreground"
                        title={workspace.directoryPath}
                      >
                        {workspace.directoryPath}
                      </span>
                    )}
                  </span>
                  {checked && (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <div className="flex w-full justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            >
              {t("common:cancel")}
            </Button>
            <Button onClick={handleConfirm} disabled={selected === null}>
              {t("common:confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
