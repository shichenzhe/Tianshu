/**
 * 标准侧边栏：功能入口（新建任务/专家/自动化/资料库）+ 空间分组任务树。
 * 任务选中态在 URL（?session=），当前空间由选中任务派生。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { getDateFnsLocale } from "@/i18n";
import { cn } from "@/lib/utils";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import WorkspaceApi, { type WorkspaceRecord } from "../../api/workspace.api";
import SessionApi, { type SessionRecord } from "../../api/session.api";
import {
  filterSessionsByTime,
  sortSessions,
} from "../../chat/lib/session-list";
import { mapIpcError } from "../../chat/lib/error-message";
import { bindWorkspaceDirectory } from "../../chat/lib/workspace-actions";
import { useAiUiStore } from "../../store/ai-ui.store";
import UnbindDirectoryDialog from "../../chat/components/UnbindDirectoryDialog";
import WorkspaceMenu from "./WorkspaceMenu";

const WORKSPACES_KEY = ["workspaces"] as const;

interface WorkspaceDialogState {
  mode: "create" | "rename";
  name: string;
}

export default function AiSidebar() {
  const { t } = useTranslation(["chat", "common", "layout"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAiUiStore((s) => s.toggleSidebar);
  const timeFilter = useAiUiStore((s) => s.timeFilter);
  const isMac = window.platform === "darwin";

  const selectedSessionId = Number(searchParams.get("session")) || null;

  const [spacesOpen, setSpacesOpen] = useState(true);
  const [collapsedSpaces, setCollapsedSpaces] = useState<
    Record<number, boolean>
  >({});
  const [workspaceDialog, setWorkspaceDialog] =
    useState<WorkspaceDialogState | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] =
    useState<WorkspaceRecord | null>(null);
  const [unbindingWorkspace, setUnbindingWorkspace] =
    useState<WorkspaceRecord | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(
    null,
  );
  const [sessionTitle, setSessionTitle] = useState("");
  const [deletingSession, setDeletingSession] = useState<SessionRecord | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => WorkspaceApi.list(),
  });
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => SessionApi.listAll(),
  });
  const workspaces = workspacesQuery.data ?? [];
  const sessions = useMemo(
    () =>
      sortSessions(filterSessionsByTime(sessionsQuery.data ?? [], timeFilter)),
    [sessionsQuery.data, timeFilter],
  );

  const handleError = (e: unknown) => {
    toast.error(mapIpcError(e));
  };

  const invalidateSessions = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };

  const selectSession = (id: number | null) => {
    navigate(id ? `/module/ai?session=${id}` : "/module/ai", {
      replace: true,
    });
  };

  // 当前空间 = 选中任务所属空间，无选中取第一个（spec §2.3）
  const selectedSession =
    sessions.find((s) => s.id === selectedSessionId) ?? null;
  const currentWorkspaceId =
    selectedSession?.workspaceId ?? workspaces[0]?.id ?? null;

  const handleCreateSession = async (workspaceId: number | null) => {
    if (workspaceId === null) {
      return;
    }
    try {
      const created = await SessionApi.create({ workspaceId });
      await invalidateSessions();
      selectSession(created.id);
    } catch (e) {
      handleError(e);
    }
  };

  const handleWorkspaceDialogSubmit = async () => {
    if (!workspaceDialog || submitting) {
      return;
    }
    const name = workspaceDialog.name.trim();
    setSubmitting(true);
    try {
      if (workspaceDialog.mode === "create") {
        const created = await WorkspaceApi.create({ name });
        await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
        handleCreateSession(created.id);
      } else if (currentWorkspaceId !== null) {
        await WorkspaceApi.update({ id: currentWorkspaceId, name });
        await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
      }
      setWorkspaceDialog(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!deletingWorkspace || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await WorkspaceApi.delete(deletingWorkspace.id);
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
      await invalidateSessions();
      if (deletingWorkspace.id === currentWorkspaceId) {
        selectSession(null);
      }
      setDeletingWorkspace(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** 绑定目录：用户取消选目录时后端返回 null，静默不提示 */
  const handleBindDirectory = async (workspaceId: number) => {
    try {
      await bindWorkspaceDirectory(queryClient, workspaceId);
    } catch (e) {
      handleError(e);
    }
  };

  const handleRenameSession = async () => {
    const title = sessionTitle.trim();
    if (!renamingSession || !title || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await SessionApi.rename(renamingSession.id, title);
      await invalidateSessions();
      setRenamingSession(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!deletingSession || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await SessionApi.delete(deletingSession.id);
      await invalidateSessions();
      if (deletingSession.id === selectedSessionId) {
        selectSession(null);
      }
      setDeletingSession(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const navEntries = [
    {
      icon: <Bot size={16} />,
      label: t("chat:sidebar.experts"),
      onClick: () => navigate("/module/ai/experts"),
    },
    {
      icon: <Clock size={16} />,
      label: t("chat:sidebar.automation"),
      onClick: () => navigate("/module/ai/automation"),
    },
    {
      icon: <FileText size={16} />,
      label: t("chat:sidebar.library"),
      onClick: () => navigate("/module/ai/library"),
    },
  ];

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border/50 bg-card transition-[width] duration-200",
        collapsed ? "w-12" : "w-64",
      )}
    >
      {/* macOS 顶部 Logo（Windows 标题在 TopBar） */}
      {isMac && (
        <div
          className={cn(
            "flex h-9 shrink-0 items-center border-b border-border/50",
            collapsed ? "justify-center" : "gap-2 px-3",
          )}
        >
          <img src="./pc_logo.svg" alt="mirror" className="h-5 w-5 shrink-0" />
          {!collapsed && (
            <span className="truncate text-sm font-semibold tracking-tight text-foreground select-none">
              {"mirror"}
            </span>
          )}
        </div>
      )}

      {/* 功能入口区 */}
      <div className="flex flex-col gap-1 p-2">
        <Button
          size="sm"
          className={cn(
            "w-full justify-start hover:bg-primary hover:text-primary-foreground",
            collapsed && "justify-center px-0",
          )}
          onClick={() => handleCreateSession(currentWorkspaceId)}
        >
          <Plus className="h-4 w-4" />
          {!collapsed && t("chat:sidebar.newTask")}
        </Button>
        {navEntries.map((entry) => (
          <SidebarNavButton
            key={entry.label}
            collapsed={collapsed}
            icon={entry.icon}
            label={entry.label}
            onClick={entry.onClick}
          />
        ))}
      </div>

      {/* 空间分组任务树 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setSpacesOpen((open) => !open)}
        >
          {spacesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t("chat:sidebar.spaces")} ({workspaces.length})
        </button>
        {spacesOpen &&
          workspaces.map((workspace) => (
            <WorkspaceGroup
              key={workspace.id}
              workspace={workspace}
              collapsed={collapsed}
              collapsedGroup={collapsedSpaces[workspace.id] ?? false}
              sessions={sessions.filter((s) => s.workspaceId === workspace.id)}
              selectedSessionId={selectedSessionId}
              onToggleGroup={() =>
                setCollapsedSpaces((prev) => ({
                  ...prev,
                  [workspace.id]: !(prev[workspace.id] ?? false),
                }))
              }
              onSelect={selectSession}
              onCreate={() => handleCreateSession(workspace.id)}
              onManageRename={() =>
                setWorkspaceDialog({ mode: "rename", name: workspace.name })
              }
              onManageDelete={() => setDeletingWorkspace(workspace)}
              onManageBind={() => handleBindDirectory(workspace.id)}
              onManageUnbind={() => setUnbindingWorkspace(workspace)}
              onSessionRename={(session) => {
                setSessionTitle(session.title);
                setRenamingSession(session);
              }}
              onSessionDelete={(session) => setDeletingSession(session)}
            />
          ))}
      </div>

      {/* 底部折叠按钮 */}
      <div className="border-t border-border/50 p-2">
        <SidebarNavButton
          collapsed={collapsed}
          icon={
            collapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )
          }
          label={
            collapsed
              ? t("layout:sidebar.expand")
              : t("layout:sidebar.collapse")
          }
          onClick={toggleSidebar}
        />
      </div>

      {/* 空间新建/重命名对话框 */}
      <Dialog
        open={workspaceDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWorkspaceDialog(null);
          }
        }}
      >
        <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {workspaceDialog?.mode === "create"
                ? t("chat:newWorkspace")
                : t("chat:renameWorkspace")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name">{t("ai:provider.name")}</Label>
            <Input
              id="workspace-name"
              value={workspaceDialog?.name ?? ""}
              onChange={(e) =>
                setWorkspaceDialog((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleWorkspaceDialogSubmit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWorkspaceDialog(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleWorkspaceDialogSubmit} disabled={submitting}>
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 任务重命名对话框 */}
      <Dialog
        open={renamingSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingSession(null);
          }
        }}
      >
        <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("chat:renameSession")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="session-title">{t("ai:provider.name")}</Label>
            <Input
              id="session-title"
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRenameSession();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingSession(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleRenameSession} disabled={submitting}>
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnbindDirectoryDialog
        workspace={unbindingWorkspace}
        onOpenChange={(open) => {
          if (!open) {
            setUnbindingWorkspace(null);
          }
        }}
        onUnbound={() => setUnbindingWorkspace(null)}
      />

      <AlertDialog
        open={deletingWorkspace !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingWorkspace(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:deleteWorkspace")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingWorkspace
                ? `${deletingWorkspace.name} · ${t("chat:deleteWorkspaceDesc")}`
                : t("chat:deleteWorkspaceDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteWorkspace}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deletingSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingSession(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:deleteSession")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingSession
                ? `${deletingSession.title} · ${t("chat:deleteSessionDesc")}`
                : t("chat:deleteSessionDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSession}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

interface SidebarNavButtonProps {
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

/** 侧边栏入口行（展开=图标+文字，折叠=仅图标+Tooltip） */
function SidebarNavButton({
  collapsed,
  icon,
  label,
  onClick,
}: SidebarNavButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-8 cursor-pointer items-center rounded-md text-sm text-muted-foreground transition-colors duration-200 hover:bg-primary-subtle hover:text-primary",
              collapsed ? "justify-center" : "gap-2.5 px-3",
            )}
            onClick={onClick}
          >
            <span className="shrink-0">{icon}</span>
            {!collapsed && <span className="truncate">{label}</span>}
          </div>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right">
            <p>{label}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}

interface WorkspaceGroupProps {
  workspace: WorkspaceRecord;
  collapsed: boolean;
  collapsedGroup: boolean;
  sessions: SessionRecord[];
  selectedSessionId: number | null;
  onToggleGroup: () => void;
  onSelect: (sessionId: number) => void;
  onCreate: () => void;
  onManageRename: () => void;
  onManageDelete: () => void;
  onManageBind: () => void;
  onManageUnbind: () => void;
  onSessionRename: (session: SessionRecord) => void;
  onSessionDelete: (session: SessionRecord) => void;
}

/** 单空间分组：标题行（折叠钮 + 空间名 + 悬停 +/...）+ 任务列表 */
function WorkspaceGroup({
  workspace,
  collapsed,
  collapsedGroup,
  sessions,
  selectedSessionId,
  onToggleGroup,
  onSelect,
  onCreate,
  onManageRename,
  onManageDelete,
  onManageBind,
  onManageUnbind,
  onSessionRename,
  onSessionDelete,
}: WorkspaceGroupProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <div className="group/workspace mt-1">
      <div className="relative flex items-center">
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pl-1 text-left text-sm text-foreground/90 hover:bg-primary-subtle/60",
            collapsed && "justify-center",
          )}
          onClick={onToggleGroup}
          title={workspace.name}
        >
          {collapsedGroup ? (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          )}
          {!collapsed && <span className="truncate">{workspace.name}</span>}
        </button>
        {!collapsed && (
          <div className="absolute right-0 hidden items-center group-hover/workspace:flex">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              onClick={onCreate}
              aria-label={t("chat:sidebar.newTaskInWorkspace")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <WorkspaceMenu
              disabled={false}
              workspace={workspace}
              onCreate={onCreate}
              onRename={onManageRename}
              onDelete={onManageDelete}
              onBindDirectory={onManageBind}
              onUnbindDirectory={onManageUnbind}
            />
          </div>
        )}
      </div>
      {!collapsedGroup && !collapsed && (
        <div className="ml-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t("chat:sidebar.emptyTask")}
            </p>
          ) : (
            sessions.map((session) => (
              <TaskTreeItem
                key={session.id}
                session={session}
                selected={session.id === selectedSessionId}
                onSelect={() => onSelect(session.id)}
                onRename={() => onSessionRename(session)}
                onDelete={() => onSessionDelete(session)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface TaskTreeItemProps {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** 任务项（基础版）：标题 + 相对时间 + 选中态；悬停菜单/绿点/置顶在 Task 6 强化 */
function TaskTreeItem({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: TaskTreeItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const locale = getDateFnsLocale();
  const timeText = formatDistanceToNow(
    new Date(session.lastMessageAt ?? session.updatedAt),
    { addSuffix: true, locale },
  );

  return (
    <div
      className={cn(
        "group/task relative mb-0.5 rounded-md",
        selected
          ? "bg-primary-subtle text-primary"
          : "hover:bg-primary-subtle/60",
      )}
    >
      <button
        type="button"
        className="block w-full py-1.5 pl-2 pr-8 text-left"
        onClick={onSelect}
      >
        <span className="block truncate text-sm" title={session.title}>
          {session.title}
        </span>
        <span className="block text-xs text-muted-foreground">{timeText}</span>
      </button>
      <div className="absolute right-1 top-1.5 opacity-0 transition-opacity group-hover/task:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 focus:opacity-100"
              aria-label={t("common:operation")}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="rounded-lg border border-border/50 shadow-lg"
          >
            <DropdownMenuItem onClick={onRename}>
              <Pencil className="mr-2 h-4 w-4" />
              {t("chat:renameSession")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("chat:deleteSession")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
