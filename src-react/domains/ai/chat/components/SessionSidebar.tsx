/**
 * 会话侧边栏：工作空间切换/管理 + 会话列表（选中态由 ChatView 提升）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { FolderPlus, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";

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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import WorkspaceApi, { type WorkspaceRecord } from "../../api/workspace.api";
import SessionApi, { type SessionRecord } from "../../api/session.api";

const WORKSPACES_KEY = ["workspaces"] as const;

interface SessionSidebarProps {
  /** 工作空间选中态由 ChatView 提升（输入区需据此解析会话生效模型） */
  activeWorkspaceId: number | null;
  onSelectWorkspace: (workspaceId: number | null) => void;
  selectedSessionId: number | null;
  onSelectSession: (sessionId: number | null) => void;
}

interface WorkspaceDialogState {
  mode: "create" | "rename";
  name: string;
}

export default function SessionSidebar({
  activeWorkspaceId,
  onSelectWorkspace,
  selectedSessionId,
  onSelectSession,
}: SessionSidebarProps) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => WorkspaceApi.list(),
  });
  const workspaces = workspacesQuery.data ?? [];

  const [workspaceDialog, setWorkspaceDialog] =
    useState<WorkspaceDialogState | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] =
    useState<WorkspaceRecord | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(
    null,
  );
  const [sessionTitle, setSessionTitle] = useState("");
  const [deletingSession, setDeletingSession] = useState<SessionRecord | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: ["sessions", activeWorkspaceId],
    queryFn: () => SessionApi.listByWorkspace(activeWorkspaceId as number),
    enabled: activeWorkspaceId !== null,
  });
  const sessions = sessionsQuery.data ?? [];
  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const handleError = (e: unknown) => {
    toast.error(e instanceof Error ? e.message : String(e));
  };

  const invalidateSessions = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };

  // 切换工作空间时由 ChatView 同步清空会话选中态
  const handleSwitchWorkspace = (id: string) => {
    onSelectWorkspace(Number(id));
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
        onSelectWorkspace(created.id);
      } else if (activeWorkspaceId !== null) {
        await WorkspaceApi.update({ id: activeWorkspaceId, name });
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
      if (deletingWorkspace.id === activeWorkspaceId) {
        const rest = workspaces.filter((w) => w.id !== deletingWorkspace.id);
        onSelectWorkspace(rest[0]?.id ?? null);
      }
      setDeletingWorkspace(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateSession = async () => {
    if (activeWorkspaceId === null) {
      return;
    }
    try {
      const created = await SessionApi.create({
        workspaceId: activeWorkspaceId,
      });
      await invalidateSessions();
      onSelectSession(created.id);
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
        onSelectSession(null);
      }
      setDeletingSession(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/50 bg-card">
      <div className="border-b border-border/50 p-3">
        <div className="flex items-center gap-1">
          <Select
            value={
              activeWorkspaceId === null ? undefined : String(activeWorkspaceId)
            }
            onValueChange={handleSwitchWorkspace}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("common:loading")} />
            </SelectTrigger>
            <SelectContent className="border border-border/50 rounded-lg shadow-lg">
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={String(workspace.id)}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <WorkspaceMenu
            disabled={activeWorkspaceId === null}
            onCreate={() =>
              setWorkspaceDialog({
                mode: "create",
                name: t("chat:defaultWorkspaceName"),
              })
            }
            onRename={() =>
              setWorkspaceDialog({
                mode: "rename",
                name: activeWorkspace?.name ?? "",
              })
            }
            onDelete={() => setDeletingWorkspace(activeWorkspace)}
          />
        </div>
        <Button
          size="sm"
          className="mt-2 w-full hover:bg-primary hover:text-primary-foreground"
          onClick={handleCreateSession}
          disabled={activeWorkspaceId === null}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("chat:newSession")}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sessionsQuery.isPending ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {t("common:loading")}
          </p>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {t("chat:noSession")}
          </p>
        ) : (
          <>
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {t("chat:sessionCount", { count: sessions.length })}
            </p>
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                selected={session.id === selectedSessionId}
                onSelect={() => onSelectSession(session.id)}
                onRename={() => {
                  setSessionTitle(session.title);
                  setRenamingSession(session);
                }}
                onDelete={() => setDeletingSession(session)}
              />
            ))}
          </>
        )}
      </div>

      <Dialog
        open={workspaceDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWorkspaceDialog(null);
          }
        }}
      >
        <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-sm">
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

      <Dialog
        open={renamingSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingSession(null);
          }
        }}
      >
        <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-sm">
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

      <AlertDialog
        open={deletingWorkspace !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingWorkspace(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
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
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
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

interface WorkspaceMenuProps {
  disabled: boolean;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function WorkspaceMenu({
  disabled,
  onCreate,
  onRename,
  onDelete,
}: WorkspaceMenuProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-9 shrink-0 px-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          aria-label={t("common:operation")}
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="border border-border/50 rounded-lg shadow-lg"
      >
        <DropdownMenuItem onClick={onCreate}>
          <FolderPlus className="mr-2 h-4 w-4" />
          {t("chat:newWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRename} disabled={disabled}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("chat:renameWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDelete}
          disabled={disabled}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("chat:deleteWorkspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SessionItemProps {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function SessionItem({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: SessionItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const locale = getDateFnsLocale();
  const timeText = formatDistanceToNow(
    new Date(session.lastMessageAt ?? session.createdAt),
    { addSuffix: true, locale },
  );

  return (
    <div
      className={cn(
        "group relative mb-1 rounded-md",
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
      <div className="absolute right-1 top-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 opacity-0 focus:opacity-100 group-hover:opacity-100"
              aria-label={t("common:operation")}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="border border-border/50 rounded-lg shadow-lg"
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
