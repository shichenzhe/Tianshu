/**
 * 工作空间选择下拉（修订 spec 裁定 11：显式选择，替代默认跟随第一个）：
 * Popover 面板——顶部搜索框按名称/目录过滤；已有空间点击即写 store
 * （setter 自带 localStorage 持久化）并关闭；分割线下「+ 新建空间」（弹
 * 名称输入小对话框 → 创建 → 刷新列表 → 自动选中新空间）与「打开本地
 * 空间」（主进程目录选择 + 以目录名建空间并绑定，取消静默）。打开时
 * 以当前 workspaceId 标记 Check；数据走 ["workspaces"] 共享缓存
 * （GlobalSidebar 已预热，通常零额外 IPC）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import WorkspaceApi from "../../api/workspace.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { cn } from "@/lib/utils";
import { useNewTaskStore } from "../store/new-task-store";

/** 胶囊触发钮样式（与 chat PermissionCapsule.tsx:52 一致） */
const CAPSULE_CLASS =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full border " +
  "border-border/50 px-2.5 text-xs hover:border-primary/30 hover:bg-primary-subtle";

/** 菜单项（分割线下两个入口）统一样式 */
const ACTION_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm " +
  "text-foreground hover:bg-primary-subtle hover:text-primary";

export default function WorkspacePickerMenu() {
  const { t } = useTranslation(["newTask", "common", "chat", "ai"]);
  const queryClient = useQueryClient();
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const setWorkspaceId = useNewTaskStore((s) => s.setWorkspaceId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  // 「+ 新建空间」名称输入对话框（菜单先关避免叠层）
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const workspaces = useMemo(() => data ?? [], [data]);
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  // 每次打开重置搜索（上次过滤不带入）
  useEffect(() => {
    if (menuOpen) {
      setKeyword("");
    }
  }, [menuOpen]);

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

  /** 点击行即选中生效（无二次确认） */
  const handlePick = (id: number) => {
    setWorkspaceId(id);
    setMenuOpen(false);
  };

  /** 「+ 新建空间」：关菜单 → 名称对话框（提交见 handleCreateSubmit） */
  const openCreateDialog = () => {
    setMenuOpen(false);
    setNewName("");
    setCreateOpen(true);
  };

  const handleCreateSubmit = async () => {
    const name = newName.trim();
    if (!name || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await WorkspaceApi.create({ name });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      // 建完即选中（省一次手动选择）
      setWorkspaceId(created.id);
      setCreateOpen(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  /** 「打开本地空间」：主进程选目录 + 以目录名建空间并绑定；取消(null)静默 */
  const handleOpenLocal = async () => {
    setMenuOpen(false);
    try {
      const created = await WorkspaceApi.openLocal();
      if (created) {
        await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        setWorkspaceId(created.id);
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t("newTask:context.workspace")}
            className={CAPSULE_CLASS}
          >
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <span
              className={cn(
                "max-w-40 truncate",
                currentWorkspace ? "text-foreground" : "text-primary",
              )}
            >
              {currentWorkspace?.name ?? t("newTask:context.workspace")}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("newTask:context.searchWorkspace")}
              className="h-8 border-border/50 pl-8 text-xs"
              aria-label={t("newTask:context.searchWorkspace")}
            />
          </div>
          {/* 已有空间列表（点击即选中并关闭） */}
          {filteredWorkspaces.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t(
                trimmedKeyword
                  ? "newTask:context.noMatch"
                  : "newTask:context.noWorkspace",
              )}
            </p>
          ) : (
            <ul className="mt-1.5 max-h-64 overflow-y-auto">
              {filteredWorkspaces.map((workspace) => {
                const checked = workspace.id === workspaceId;
                return (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      onClick={() => handlePick(workspace.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-primary-subtle",
                        checked
                          ? "bg-primary-subtle text-primary"
                          : "text-foreground",
                      )}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{workspace.name}</span>
                        {workspace.directoryPath && (
                          <span
                            className="block truncate text-xs text-muted-foreground"
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
                  </li>
                );
              })}
            </ul>
          )}
          <div className="my-1.5 h-px bg-border/50" />
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={openCreateDialog}
              className={ACTION_ITEM_CLASS}
            >
              <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("newTask:context.newWorkspace")}
            </button>
            <button
              type="button"
              onClick={() => void handleOpenLocal()}
              className={ACTION_ITEM_CLASS}
            >
              <FolderInput className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("newTask:context.openLocal")}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 新建空间名称对话框（样式同 SessionTreePanel 空间新建框） */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
          }
        }}
      >
        <DialogContent
          className="rounded-lg border-border/50 shadow-lg sm:max-w-sm"
          onOpenAutoFocus={(e) => {
            // 打开即聚焦名称输入框（Radix 接管焦点后 React autoFocus 失效）
            e.preventDefault();
            nameInputRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("chat:newWorkspace")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-picker-name">
              {t("ai:provider.name")}
            </Label>
            <Input
              id="workspace-picker-name"
              ref={nameInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleCreateSubmit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            >
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => void handleCreateSubmit()}
              disabled={!newName.trim() || submitting}
            >
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
