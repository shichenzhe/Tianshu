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
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  FolderInput,
  ListChecks,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Share2,
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
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenuSeparator,
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
import { useChatStore } from "../../chat/store/chat.store";
import { useAiUiStore } from "../../store/ai-ui.store";
import UnbindDirectoryDialog from "../../chat/components/UnbindDirectoryDialog";
import BatchActionBar from "./BatchActionBar";
import WorkspaceMenu from "./WorkspaceMenu";

const WORKSPACES_KEY = ["workspaces"] as const;

/** rename 携带目标空间 id（来源行，非当前选中空间）；create 建新后自动进入 */
type WorkspaceDialogState =
  | { mode: "create"; name: string }
  | { mode: "rename"; name: string; workspaceId: number };

export default function AiSidebar() {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
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
  // 批量管理：选中集合按会话 id（Set 天然对父/子混合选择去重）
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => WorkspaceApi.list(),
  });
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => SessionApi.listAll(),
  });
  const workspaces = workspacesQuery.data ?? [];
  // 渲染列表 = 时间筛选 + 排序（仅用于渲染，不参与空间派生）
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

  // 当前空间 = 选中任务所属空间，无选中取第一个（spec §2.3）。
  // 派生用原始数据：时间筛选只影响渲染，不得改变新建任务的目标空间
  const selectedSession =
    (sessionsQuery.data ?? []).find((s) => s.id === selectedSessionId) ?? null;
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
      } else {
        await WorkspaceApi.update({
          id: workspaceDialog.workspaceId,
          name,
        });
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

  const handlePin = async (session: SessionRecord) => {
    try {
      await SessionApi.pin(session.id, !session.pinnedAt);
      await invalidateSessions();
    } catch (e) {
      handleError(e);
    }
  };

  // ============ 批量管理 ============
  // 流式进行中的会话对象引用（store 更新才变；用于排除不可选项）
  const isStreaming = useChatStore((s) => s.isStreaming);
  // 可选集 = 渲染列表（含折叠组）排除当前选中会话与流式进行中（PRD 4.3）
  const selectableIds = useMemo(
    () =>
      sessions
        .filter((s) => s.id !== selectedSessionId && !isStreaming[s.id])
        .map((s) => s.id),
    [sessions, selectedSessionId, isStreaming],
  );
  const selectedInSelectable = selectableIds.filter((id) =>
    selectedIds.has(id),
  );
  const allChecked: boolean | "indeterminate" =
    selectableIds.length > 0 &&
    selectedInSelectable.length === selectableIds.length
      ? true
      : selectedInSelectable.length > 0
        ? "indeterminate"
        : false;

  const toggleBatchIds = (ids: number[], on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  };

  const toggleAll = () => {
    toggleBatchIds(
      selectableIds,
      selectedInSelectable.length !== selectableIds.length,
    );
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  /** 批量执行（allSettled 防部分失败短路）：成功全数轻提示，否则部分成功警示 */
  const runBatchAction = async (
    action: (id: number) => Promise<unknown>,
    successKey: string,
  ) => {
    const ids = [...selectedIds];
    if (ids.length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    const results = await Promise.allSettled(ids.map(action));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    await invalidateSessions();
    if (ok === ids.length) {
      toast.success(t(successKey, { count: ok }));
    } else {
      toast.warning(t("chat:task.batchPartial", { ok, total: ids.length }));
    }
    setSubmitting(false);
    exitBatchMode();
  };

  const handleBatchDelete = () =>
    void runBatchAction(
      (id) => SessionApi.delete(id),
      "chat:task.batchDeleted",
    );

  const handleBatchArchive = () =>
    void runBatchAction(
      (id) => SessionApi.archive(id, true),
      "chat:task.batchArchived",
    );

  // ============ 单会话操作 ============
  const handleUnarchive = async (sessionId: number) => {
    try {
      await SessionApi.archive(sessionId, false);
      await invalidateSessions();
    } catch (e) {
      handleError(e);
    }
  };

  /** 归档后 5s 内可撤销（sonner action）；归档当前任务同步清空选中 */
  const handleArchive = async (session: SessionRecord) => {
    try {
      await SessionApi.archive(session.id, true);
      await invalidateSessions();
      if (session.id === selectedSessionId) {
        selectSession(null);
      }
      toast.success(t("chat:task.archived"), {
        duration: 5000,
        action: {
          label: t("chat:task.undo"),
          onClick: () => void handleUnarchive(session.id),
        },
      });
    } catch (e) {
      handleError(e);
    }
  };

  const handleOpenFolder = async (workspaceId: number) => {
    try {
      await WorkspaceApi.openDirectory(workspaceId);
    } catch (e) {
      handleError(e);
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
        "flex h-full shrink-0 flex-col border-r border-border/50 bg-muted/40 transition-[width] duration-200",
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

      {/* 空间分组任务树（收缩态整体隐藏：折叠/展开入口在顶栏 AiTopbarActions） */}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setSpacesOpen((open) => !open)}
          >
            {spacesOpen ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
            {t("chat:sidebar.spaces")} ({workspaces.length})
          </button>
          {spacesOpen &&
            workspaces.map((workspace) => (
              <WorkspaceGroup
                key={workspace.id}
                workspace={workspace}
                collapsed={collapsed}
                collapsedGroup={collapsedSpaces[workspace.id] ?? false}
                sessions={sessions.filter(
                  (s) => s.workspaceId === workspace.id,
                )}
                selectedSessionId={selectedSessionId}
                batchMode={batchMode}
                batchSelectedIds={selectedIds}
                isStreaming={isStreaming}
                onBatchToggleIds={toggleBatchIds}
                onBatchEnter={() => setBatchMode(true)}
                onToggleGroup={() =>
                  setCollapsedSpaces((prev) => ({
                    ...prev,
                    [workspace.id]: !(prev[workspace.id] ?? false),
                  }))
                }
                onSelect={selectSession}
                onCreateTask={() => handleCreateSession(workspace.id)}
                onCreateWorkspace={() =>
                  setWorkspaceDialog({
                    mode: "create",
                    name: t("chat:defaultWorkspaceName"),
                  })
                }
                onManageRename={() =>
                  setWorkspaceDialog({
                    mode: "rename",
                    name: workspace.name,
                    workspaceId: workspace.id,
                  })
                }
                onManageDelete={() => setDeletingWorkspace(workspace)}
                onManageBind={() => handleBindDirectory(workspace.id)}
                onManageUnbind={() => setUnbindingWorkspace(workspace)}
                onSessionRename={(session) => {
                  setSessionTitle(session.title);
                  setRenamingSession(session);
                }}
                onSessionDelete={(session) => setDeletingSession(session)}
                onSessionPin={(s) => void handlePin(s)}
                onSessionArchive={(s) => void handleArchive(s)}
                onOpenFolder={() => void handleOpenFolder(workspace.id)}
              />
            ))}
        </div>
      )}

      {/* 批量管理底部操作栏（批量模式固定悬浮于侧边栏底部） */}
      {batchMode && !collapsed && (
        <BatchActionBar
          selectedCount={selectedIds.size}
          allChecked={allChecked}
          onToggleAll={toggleAll}
          onDelete={() => setConfirmingBatchDelete(true)}
          onArchive={handleBatchArchive}
          onExit={exitBatchMode}
          submitting={submitting}
        />
      )}

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
      <AlertDialog
        open={confirmingBatchDelete}
        onOpenChange={setConfirmingBatchDelete}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:task.batchDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:task.batchDeleteConfirm", { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingBatchDelete(false);
                handleBatchDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
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
  /** 批量管理：模式开关与选中集合（组复选框按组内可选集联动） */
  batchMode: boolean;
  batchSelectedIds: Set<number>;
  isStreaming: Record<string, boolean>;
  onBatchToggleIds: (ids: number[], on: boolean) => void;
  /** 菜单「批量操作」入口：进入批量模式 */
  onBatchEnter: () => void;
  onToggleGroup: () => void;
  onSelect: (sessionId: number) => void;
  /** 行内 + ：在本空间新建任务 */
  onCreateTask: () => void;
  /** 管理菜单：新建工作空间（打开对话框） */
  onCreateWorkspace: () => void;
  onManageRename: () => void;
  onManageDelete: () => void;
  onManageBind: () => void;
  onManageUnbind: () => void;
  onSessionRename: (session: SessionRecord) => void;
  onSessionDelete: (session: SessionRecord) => void;
  onSessionPin: (session: SessionRecord) => void;
  onSessionArchive: (session: SessionRecord) => void;
  onOpenFolder: () => void;
}

/** 单空间分组：标题行（折叠钮 + 空间名 + 悬停 +/...）+ 任务列表 */
function WorkspaceGroup({
  workspace,
  collapsed,
  collapsedGroup,
  sessions,
  selectedSessionId,
  batchMode,
  batchSelectedIds,
  isStreaming,
  onBatchToggleIds,
  onBatchEnter,
  onToggleGroup,
  onSelect,
  onCreateTask,
  onCreateWorkspace,
  onManageRename,
  onManageDelete,
  onManageBind,
  onManageUnbind,
  onSessionRename,
  onSessionDelete,
  onSessionPin,
  onSessionArchive,
  onOpenFolder,
}: WorkspaceGroupProps) {
  const { t } = useTranslation(["chat", "common"]);
  // 组级复选框（PRD 3.1 父级联动）：勾选=组内可选会话全选；半选=部分
  const groupSelectableIds = sessions
    .filter((s) => s.id !== selectedSessionId && !isStreaming[s.id])
    .map((s) => s.id);
  const groupSelectedCount = groupSelectableIds.filter((id) =>
    batchSelectedIds.has(id),
  ).length;
  const groupChecked: boolean | "indeterminate" =
    groupSelectableIds.length > 0 &&
    groupSelectedCount === groupSelectableIds.length
      ? true
      : groupSelectedCount > 0
        ? "indeterminate"
        : false;

  return (
    <div className="group/workspace mt-1">
      <div className="relative flex items-center">
        {batchMode && (
          <Checkbox
            checked={groupChecked}
            onCheckedChange={() =>
              onBatchToggleIds(
                groupSelectableIds,
                groupSelectedCount !== groupSelectableIds.length,
              )
            }
            disabled={groupSelectableIds.length === 0}
            aria-label={workspace.name}
            className="mr-1.5 shrink-0"
          />
        )}
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
              onClick={onCreateTask}
              aria-label={t("chat:sidebar.newTaskInWorkspace")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <WorkspaceMenu
              disabled={false}
              workspace={workspace}
              onCreateWorkspace={onCreateWorkspace}
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
                workspaceDirectoryPath={workspace.directoryPath}
                selected={session.id === selectedSessionId}
                batchMode={batchMode}
                batchChecked={batchSelectedIds.has(session.id)}
                batchDisabled={
                  session.id === selectedSessionId ||
                  Boolean(isStreaming[session.id])
                }
                onBatchToggle={() =>
                  onBatchToggleIds(
                    [session.id],
                    !batchSelectedIds.has(session.id),
                  )
                }
                onBatchEnter={() => onBatchEnter()}
                onSelect={() => onSelect(session.id)}
                onRename={() => onSessionRename(session)}
                onDelete={() => onSessionDelete(session)}
                onPin={() => onSessionPin(session)}
                onArchive={() => onSessionArchive(session)}
                onOpenFolder={onOpenFolder}
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
  workspaceDirectoryPath?: string;
  selected: boolean;
  /** 批量管理：勾选态与切换（批量模式下行点击即切换选择，不再导航） */
  batchMode: boolean;
  batchChecked: boolean;
  /** 当前选中会话/流式进行中：复选框禁用（PRD 4.3） */
  batchDisabled: boolean;
  onBatchToggle: () => void;
  /** 菜单「批量操作」入口 */
  onBatchEnter: () => void;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onPin: () => void;
  onArchive: () => void;
  onOpenFolder: () => void;
}

/** 任务项：标题+相对时间；悬停出 .../归档/置顶 快捷钮；流式中显示绿点；
 *  批量模式：行首复选框，整行点击切换勾选，快捷钮隐藏 */
function TaskTreeItem({
  session,
  workspaceDirectoryPath,
  selected,
  batchMode,
  batchChecked,
  batchDisabled,
  onBatchToggle,
  onBatchEnter,
  onSelect,
  onRename,
  onDelete,
  onPin,
  onArchive,
  onOpenFolder,
}: TaskTreeItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const locale = getDateFnsLocale();
  const timeText = formatDistanceToNow(
    new Date(session.lastMessageAt ?? session.updatedAt),
    { addSuffix: true, locale },
  );
  // 绿点：该任务流式进行中（chat.store 前端派生）
  const streaming = useChatStore((s) => Boolean(s.isStreaming[session.id]));
  const pinned = Boolean(session.pinnedAt);

  const quickActions = (
    <div className="absolute right-1 top-1.5 flex items-center opacity-0 transition-opacity group-hover/task:opacity-100">
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
          <DropdownMenuItem onClick={onPin}>
            <Pin className="mr-2 h-4 w-4" />
            {pinned ? t("chat:task.unpin") : t("chat:task.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>
            <Archive className="mr-2 h-4 w-4" />
            {t("chat:task.archive")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onOpenFolder}
            disabled={!workspaceDirectoryPath}
          >
            <FolderInput className="mr-2 h-4 w-4" />
            {t("chat:task.openFolder")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => toast.info(t("chat:task.comingSoon"))}
          >
            <Share2 className="mr-2 h-4 w-4" />
            {t("chat:task.share")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onBatchEnter}>
            <ListChecks className="mr-2 h-4 w-4" />
            {t("chat:task.batchOps")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("chat:deleteSession")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
        onClick={onArchive}
        aria-label={t("chat:task.archive")}
      >
        <Archive className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
        onClick={onPin}
        aria-label={pinned ? t("chat:task.unpin") : t("chat:task.pin")}
      >
        {pinned ? (
          <PinOff className="h-3.5 w-3.5" />
        ) : (
          <Pin className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );

  return (
    <div
      className={cn(
        "group/task relative mb-0.5 rounded-md",
        batchChecked
          ? "bg-primary-subtle"
          : selected
            ? "bg-primary-subtle text-primary"
            : "hover:bg-primary-subtle/60",
        batchDisabled && batchMode && "opacity-60",
      )}
    >
      <button
        type="button"
        className={cn(
          "block w-full py-1.5 pl-2 pr-24 text-left",
          batchDisabled && batchMode && "cursor-not-allowed",
        )}
        onClick={() => {
          if (batchMode) {
            if (!batchDisabled) {
              onBatchToggle();
            }
            return;
          }
          onSelect();
        }}
      >
        <span className="flex items-center gap-1">
          {batchMode && (
            <Checkbox
              checked={batchChecked}
              disabled={batchDisabled}
              onCheckedChange={onBatchToggle}
              aria-label={session.title}
              className="mr-0.5 shrink-0"
            />
          )}
          {pinned && <Pin className="h-3 w-3 shrink-0" />}
          <span className="truncate text-sm" title={session.title}>
            {session.title}
          </span>
          {streaming && (
            <span className="ml-auto mr-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{timeText}</span>
      </button>
      {!batchMode && quickActions}
    </div>
  );
}
