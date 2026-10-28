/**
 * 任务树主体（原 AiSidebar 主体拆出，全局侧边栏 GlobalSidebar 的 AI 侧内容）：
 * 空间分组任务树 + 项目分组（一期会话统一 D4：项目/任务会话进会话域，
 * 渲染在空间组之后）+ 批量管理 + 空间/任务对话框。
 * 任务选中态在 URL（?session=），当前空间由选中任务派生。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Share2,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";

import { getDateFnsLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { invoke } from "@/lib/ipc";
import { useUserStore } from "@/domains/user/store/user.store";
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
import IconTooltip from "@/components/common/icon-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import WorkspaceApi, { type WorkspaceRecord } from "../../api/workspace.api";
import SessionApi, { type SessionRecord } from "../../api/session.api";
import ProjectApi from "@/domains/project/api/project.api";
import {
  canCollapseVisible,
  filterSessionsByTime,
  projectSessionGroups,
  remainingVisible,
  sortSessions,
  splitArchived,
  unreadBadgeText,
} from "../../chat/lib/session-list";
import { mapIpcError } from "../../chat/lib/error-message";
import { bindWorkspaceDirectory } from "../../chat/lib/workspace-actions";
import {
  createRemoteSessionAndSelect,
  deriveCurrentWorkspaceId,
} from "../../chat/lib/session-actions";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";
import {
  projectGroupKey,
  spaceGroupKey,
  useSidebarExpand,
} from "../hooks/use-sidebar-expand";
import { useHostStore } from "../../data-source/host.store";
import { useChatStore } from "../../chat/store/chat.store";
import { useAiUiStore } from "../../store/ai-ui.store";
import { sessionResourceIndex } from "../../file-window/lib/session-map";
import type { FileWindowResource } from "../../file-window/model/resource";
import UnbindDirectoryDialog from "../../chat/components/UnbindDirectoryDialog";
import BatchActionBar from "./BatchActionBar";
import WorkspaceMenu from "./WorkspaceMenu";

const WORKSPACES_KEY = ["workspaces"] as const;

/** rename 携带目标空间 id（来源行，非当前选中空间）；create 建新后自动进入 */
type WorkspaceDialogState =
  | { mode: "create"; name: string }
  | { mode: "rename"; name: string; workspaceId: number };

export default function SessionTreePanel() {
  const { t } = useTranslation(["chat", "common", "project"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const timeFilter = useAiUiStore((s) => s.timeFilter);

  const selectedSessionId = Number(searchParams.get("session")) || null;

  // 展开态持久化（对齐 WorkBuddy expanded-state）：空间区开关/组折叠/
  // 组收缩可见条数（活跃保底 syncActiveVisible 事件落盘）
  const {
    spacesOpen,
    isSpaceCollapsed,
    isProjectCollapsed,
    visibleCountOf,
    syncActiveVisible,
    toggleSpaces,
    toggleSpaceGroup,
    toggleProjectGroup,
    showMoreGroup,
    collapseGroup,
  } = useSidebarExpand();
  const [workspaceDialog, setWorkspaceDialog] =
    useState<WorkspaceDialogState | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] =
    useState<WorkspaceRecord | null>(null);
  const [unbindingWorkspace, setUnbindingWorkspace] =
    useState<WorkspaceRecord | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(
    null,
  );
  // 项目组操作（⋯ 菜单）：重命名/删除（存 id+name 即够，避免类型穿透）
  const [renamingProject, setRenamingProject] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [deletingProject, setDeletingProject] = useState<{
    id: number;
    name: string;
  } | null>(null);
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
  // 项目组组名来源：与 hub 共用 ["projects", ownerId] 缓存
  // （GlobalSidebar 常驻预热，「我的项目」区移除后由本体兼任，批 7）；失败/加载中不阻塞
  // 空间组——组名兜底「已删除项目」，查询就绪后自然纠正
  const user = useUserStore((state) => state.user);
  const projectsQuery = useQuery({
    queryKey: ["projects", user.id],
    queryFn: () => ProjectApi.list(),
  });
  const workspaces = workspacesQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  // 渲染列表 = 时间筛选 + 排序 + 归档拆分（归档单独成「已归档」分组；
  // 仅用于渲染，不参与空间派生——派生仍用 sessionsQuery 原始数据）
  const { active: sessions, archived: archivedSessions } = useMemo(
    () =>
      splitArchived(
        sortSessions(
          filterSessionsByTime(sessionsQuery.data ?? [], timeFilter),
        ),
      ),
    [sessionsQuery.data, timeFilter],
  );
  // 项目分组（D4）：项目/任务会话按项目聚合，渲染在空间组之后
  const projectGroups = useMemo(
    () =>
      projectSessionGroups(
        sessions,
        projects.map((p) => p.id),
      ),
    [sessions, projects],
  );
  // 主窗→文件窗跳转（spec §19 项 1）：反转文件窗 session-map（文件窗写
  // localStorage，主窗同 partition 可读）得 session→resource 索引；构建
  // 轻量（一次读+反转），mount 时一次即够——跨窗写变动靠重新挂载刷新
  const fileWindowSessions = useMemo(() => sessionResourceIndex(), []);

  /** 组名解析：项目已删（或项目查询未就绪）时兜底 i18n 文案——项目删除
   *  正常会级联删会话，此为并发窗口与查询未就绪的防御 */
  const projectNameOf = (projectId: number) =>
    projects.find((p) => p.id === projectId)?.name ??
    t("project:sidebar.deletedProject");

  const handleError = useCallback((e: unknown) => {
    toast.error(mapIpcError(e));
  }, []);

  const invalidateSessions = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }, [queryClient]);

  const selectSession = useCallback(
    (id: number | null) => {
      navigate(id ? `/module/ai?session=${id}` : "/module/ai", {
        replace: true,
      });
    },
    [navigate],
  );
  // 折叠/新建/打开目录：稳定入参签名（跨 WorkspaceGroup/ProjectGroup memo
  // 边界引用不变；内部按钮以组件内闭包按 id 调用）；折叠 toggle 来自
  // useSidebarExpand（持久化）
  /** 组头 + → 「新建任务」详情页：预选本空间，发送时才创建会话
   *  （不直接建空会话——与 /module/ai 默认重定向 /new 同一语义） */
  const openNewTaskInWorkspace = useCallback(
    (workspaceId: number) => {
      useNewTaskStore.getState().setWorkspaceId(workspaceId);
      navigate("/module/ai/new");
    },
    [navigate],
  );
  /** 项目组头 + ：跳项目详情任务页签（新建任务入口在项目域——
   *  PlanItemDialog 推进落点，new 页不支持项目会话） */
  const openProjectTasks = useCallback(
    (projectId: number) => navigate(`/module/project/${projectId}?tab=tasks`),
    [navigate],
  );
  // 远程主机（HD 方案 B）：workspace 概念不跨主机——空间/项目分组退役，
  // 全部会话单区直出；新建不挂空间（远端 sessionCreate 自管归属）
  const isRemoteHost = useHostStore((s) => s.activeHost.kind === "remote");
  const createRemoteSession = useCallback(
    () => void createRemoteSessionAndSelect({ queryClient, navigate }),
    [queryClient, navigate],
  );
  const openWorkspaceFolder = useCallback(
    (workspaceId: number) => void handleOpenFolder(workspaceId),
    [],
  );

  // 当前空间 = 选中任务所属空间，无选中取第一个（spec §2.3）。
  // 派生用原始数据：时间筛选只影响渲染，不得改变新建任务的目标空间
  // （逻辑与布局快捷键分发共用 session-actions）
  const currentWorkspaceId = deriveCurrentWorkspaceId(
    sessionsQuery.data ?? [],
    workspaces,
    selectedSessionId,
  );

  // 活跃保底（事件驱动落盘，对齐 WorkBuddy）：选中会话所在组收缩界外
  // 时扩档落盘，保证当前会话可见；渲染纯读存储——用户显式「收起」
  // 不被派生推翻（收起后选中行接受被藏）
  useEffect(() => {
    if (selectedSessionId == null) {
      return;
    }
    const active = sessions.find((s) => s.id === selectedSessionId);
    if (!active) {
      return;
    }
    if (active.projectId != null) {
      const group = projectGroups.find((g) => g.projectId === active.projectId);
      if (group) {
        syncActiveVisible(
          projectGroupKey(group.projectId),
          group.sessions.findIndex((s) => s.id === selectedSessionId),
        );
      }
      return;
    }
    const groupSessions = sessions.filter(
      (s) => s.projectId == null && s.workspaceId === active.workspaceId,
    );
    syncActiveVisible(
      spaceGroupKey(active.workspaceId),
      groupSessions.findIndex((s) => s.id === selectedSessionId),
    );
  }, [selectedSessionId, sessions, projectGroups, syncActiveVisible]);

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
        // 建空间即引导建任务：预选新空间跳「新建任务」页（不建空会话）
        openNewTaskInWorkspace(created.id);
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
  const handleBindDirectory = useCallback(
    async (workspaceId: number) => {
      try {
        await bindWorkspaceDirectory(queryClient, workspaceId);
      } catch (e) {
        handleError(e);
      }
    },
    [queryClient, handleError],
  );

  /** 项目列表缓存失效（与 GlobalSidebar/面包屑共用 key） */
  const invalidateProjects = useCallback(
    async () =>
      queryClient.invalidateQueries({ queryKey: ["projects", user.id] }),
    [queryClient, user.id],
  );

  const handleRenameProjectSubmit = async () => {
    if (!renamingProject || submitting) {
      return;
    }
    const name = renamingProject.name.trim();
    if (!name) {
      return;
    }
    setSubmitting(true);
    try {
      await ProjectApi.update({ id: renamingProject.id, name });
      await invalidateProjects();
      setRenamingProject(null);
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** 删除项目（级联删成员/挂载/动态流会话）：选中会话属该项目时清空选中 */
  const handleDeleteProject = async () => {
    if (!deletingProject || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await ProjectApi.remove(deletingProject.id);
      await invalidateProjects();
      await invalidateSessions();
      const selectedInProject = (sessionsQuery.data ?? []).some(
        (s) => s.projectId === deletingProject.id && s.id === selectedSessionId,
      );
      if (selectedInProject) {
        selectSession(null);
      }
      setDeletingProject(null);
      toast.success(t("project:toast.deleted"));
    } catch (e) {
      handleError(e);
    } finally {
      setSubmitting(false);
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

  const handlePin = useCallback(
    async (session: SessionRecord) => {
      try {
        await SessionApi.pin(session.id, !session.pinnedAt);
        await invalidateSessions();
      } catch (e) {
        handleError(e);
      }
    },
    [invalidateSessions, handleError],
  );

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

  const toggleBatchIds = useCallback((ids: number[], on: boolean) => {
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
  }, []);

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
  const handleUnarchive = useCallback(
    async (sessionId: number) => {
      try {
        await SessionApi.archive(sessionId, false);
        await invalidateSessions();
      } catch (e) {
        handleError(e);
      }
    },
    [invalidateSessions, handleError],
  );

  /** 归档后 5s 内可撤销（sonner action）；归档当前任务同步清空选中 */
  const handleArchive = useCallback(
    async (session: SessionRecord) => {
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
    },
    [invalidateSessions, handleError, selectedSessionId, selectSession, t],
  );

  const handleOpenFolder = useCallback(
    async (workspaceId: number) => {
      try {
        await WorkspaceApi.openDirectory(workspaceId);
      } catch (e) {
        handleError(e);
      }
    },
    [handleError],
  );

  // 行级/组级稳定回调（跨 memo 边界）：入参签名见各 Props
  const enterBatchMode = useCallback(() => setBatchMode(true), []);
  const openCreateWorkspaceDialog = useCallback(
    () =>
      setWorkspaceDialog({
        mode: "create",
        name: t("chat:defaultWorkspaceName"),
      }),
    [t],
  );
  const openRenameWorkspaceDialog = useCallback(
    (workspace: WorkspaceRecord) =>
      setWorkspaceDialog({
        mode: "rename",
        name: workspace.name,
        workspaceId: workspace.id,
      }),
    [],
  );
  const openSessionRenameDialog = useCallback((session: SessionRecord) => {
    setSessionTitle(session.title);
    setRenamingSession(session);
  }, []);
  // 项目组操作（稳定签名跨 memo 边界）
  const openRenameProjectDialog = useCallback(
    (projectId: number, name: string) =>
      setRenamingProject({ id: projectId, name }),
    [],
  );
  const requestDeleteProject = useCallback(
    (projectId: number, name: string) =>
      setDeletingProject({ id: projectId, name }),
    [],
  );
  const pinSession = useCallback(
    (session: SessionRecord) => void handlePin(session),
    [],
  );
  const archiveSession = useCallback(
    (session: SessionRecord) => void handleArchive(session),
    [],
  );

  return (
    <>
      {/* 空间分组任务树（收起时由 GlobalSidebar aside 宽度裁切整体隐藏，
          内容常驻不随折叠切换——避免收展动画期间列表闪动）。
          远程主机（HD 方案 B）：本地空间/项目分组退役——单一「远程会话」
          区直出（远程行 workspaceId 恒 0 不匹配任何本地空间）。
          布局：「空间」区头在滚动容器外固定（不随会话列表滚动、不被组头
          吸顶占位），组列表独占滚动——组头 sticky 在滚动容器内钉顶 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 「空间」区头（shrink-0 固定；group/spaces 悬浮显隐快捷钮） */}
        <div className="group/spaces shrink-0 border-t border-border/50 px-2 pb-1 pt-2">
          <div className="flex w-full items-center gap-1 rounded-md px-1 py-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-0 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={toggleSpaces}
            >
              {/* 区头不放图标（组头文件夹图标已表层级），点击整行折叠 */}
              <span className="truncate">
                {isRemoteHost
                  ? t("chat:sidebar.remoteSessions")
                  : t("chat:sidebar.spaces")}
              </span>{" "}
              ({workspaces.length})
            </button>
            {isRemoteHost && spacesOpen && (
              <IconTooltip label={t("chat:sidebar.newRemoteSession")}>
                <button
                  type="button"
                  data-testid="remote-new-session"
                  aria-label={t("chat:sidebar.newRemoteSession")}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                  onClick={createRemoteSession}
                >
                  <Plus size={14} />
                </button>
              </IconTooltip>
            )}
            {/* 新建工作空间（对齐 WorkBuddy 区头 add-btn：区头悬浮右侧
                显现，FolderPlus 图标；原组头「...」菜单项已撤） */}
            {!isRemoteHost && (
              <div className="flex items-center opacity-0 transition-opacity group-hover/spaces:opacity-100 focus-within:opacity-100">
                <IconTooltip label={t("chat:newWorkspace")} side="top">
                  <button
                    type="button"
                    aria-label={t("chat:newWorkspace")}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                    onClick={openCreateWorkspaceDialog}
                  >
                    <FolderPlus size={14} />
                  </button>
                </IconTooltip>
              </div>
            )}
          </div>
        </div>
        {/* 组列表滚动区（组头吸顶钉此容器顶，会话行从组头下滚过） */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {spacesOpen && isRemoteHost
            ? [
                // 远端空间分组树（HD-A2：WorkspaceApi.list 远程态经路由化即
                // 远端概要；workspace 概念归数据源侧，管理菜单/空间内新建
                // 等本地操作面不跨主机）
                ...workspaces.map((workspace) => ({
                  key: `rw-${workspace.id}`,
                  name: workspace.name,
                  workspaceId: workspace.id,
                  sessions: sessions.filter(
                    (s) =>
                      s.projectId == null && s.workspaceId === workspace.id,
                  ),
                })),
                // 未归属兜底组：workspaceId 匹配不到任何远端空间（远端空间
                // 后建/列表窗口期）——兜底显示不丢数据
                ...(sessions.some(
                  (s) =>
                    s.projectId == null &&
                    !workspaces.some((w) => w.id === s.workspaceId),
                )
                  ? [
                      {
                        key: "rw-unassigned",
                        name: t("chat:sidebar.unassignedGroup"),
                        workspaceId: -1,
                        sessions: sessions.filter(
                          (s) =>
                            s.projectId == null &&
                            !workspaces.some((w) => w.id === s.workspaceId),
                        ),
                      },
                    ]
                  : []),
              ].map((group) => {
                // 组收缩（远程态同构）：默认 5 条；批量模式全量平铺
                // （可勾选集与可见行一致）
                const groupKey = spaceGroupKey(group.workspaceId);
                const visible = visibleCountOf(groupKey);
                const shown = batchMode
                  ? group.sessions
                  : group.sessions.slice(0, visible);
                return (
                  <div key={group.key} className="pl-1">
                    <button
                      type="button"
                      className="sidebar-sticky-header flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-foreground/90 hover:bg-primary-subtle/60"
                      onClick={() => toggleSpaceGroup(group.workspaceId)}
                      aria-expanded={!isSpaceCollapsed(group.workspaceId)}
                    >
                      {isSpaceCollapsed(group.workspaceId) ? (
                        <ChevronRight
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <ChevronDown
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="truncate">{group.name}</span>
                    </button>
                    <div
                      className={cn(
                        "ml-2 grid transition-[grid-template-rows] duration-[280ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
                        isSpaceCollapsed(group.workspaceId) && "invisible",
                      )}
                      style={{
                        gridTemplateRows: isSpaceCollapsed(group.workspaceId)
                          ? "0fr"
                          : "1fr",
                      }}
                    >
                      <div className="min-h-0 overflow-hidden">
                        {shown.map((session) => (
                          <TaskTreeItem
                            key={session.id}
                            session={session}
                            selected={session.id === selectedSessionId}
                            fileWindowResource={fileWindowSessions.get(
                              session.id,
                            )}
                            batchMode={batchMode}
                            batchChecked={selectedIds.has(session.id)}
                            batchDisabled={
                              session.id === selectedSessionId ||
                              Boolean(isStreaming[session.id])
                            }
                            onBatchToggle={toggleBatchIds}
                            onBatchEnter={enterBatchMode}
                            onSelect={selectSession}
                            onRename={openSessionRenameDialog}
                            onDelete={setDeletingSession}
                            onPin={pinSession}
                            onArchive={archiveSession}
                          />
                        ))}
                        {!batchMode && (
                          <GroupShowMoreRow
                            groupKey={groupKey}
                            visibleCount={visible}
                            total={group.sessions.length}
                            onShowMore={showMoreGroup}
                            onCollapse={collapseGroup}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            : spacesOpen &&
              workspaces.map((workspace) => {
                // projectId 判空守卫：项目会话（资产空间）不进空间组，
                // 由下方项目组承接（资产空间本就不在 listWorkspaces 内，双保险）
                const groupSessions = sessions.filter(
                  (s) => s.projectId == null && s.workspaceId === workspace.id,
                );
                const groupKey = spaceGroupKey(workspace.id);
                return (
                  <WorkspaceGroup
                    key={workspace.id}
                    workspace={workspace}
                    collapsedGroup={isSpaceCollapsed(workspace.id)}
                    sessions={groupSessions}
                    groupKey={groupKey}
                    visibleCount={visibleCountOf(groupKey)}
                    selectedSessionId={selectedSessionId}
                    batchMode={batchMode}
                    batchSelectedIds={selectedIds}
                    isStreaming={isStreaming}
                    fileWindowSessions={fileWindowSessions}
                    onBatchToggleIds={toggleBatchIds}
                    onBatchEnter={enterBatchMode}
                    onToggleGroup={toggleSpaceGroup}
                    onSelect={selectSession}
                    onCreateTask={openNewTaskInWorkspace}
                    onManageRename={openRenameWorkspaceDialog}
                    onManageDelete={setDeletingWorkspace}
                    onManageBind={handleBindDirectory}
                    onManageUnbind={setUnbindingWorkspace}
                    onSessionRename={openSessionRenameDialog}
                    onSessionDelete={setDeletingSession}
                    onSessionPin={pinSession}
                    onSessionArchive={archiveSession}
                    onOpenFolder={openWorkspaceFolder}
                    onShowMore={showMoreGroup}
                    onCollapse={collapseGroup}
                  />
                );
              })}
          {/* 项目分组（一期会话统一 D4）：项目/任务会话按项目聚合，
            排在空间组之后，不改变空间组现有排序（远程态项目概念不跨
            主机，projectId 恒缺省自然为空——不出组） */}
          {spacesOpen &&
            !isRemoteHost &&
            projectGroups.map((group) => {
              const groupKey = projectGroupKey(group.projectId);
              return (
                <ProjectGroup
                  key={`project-${group.projectId}`}
                  projectId={group.projectId}
                  name={projectNameOf(group.projectId)}
                  sessions={group.sessions}
                  groupKey={groupKey}
                  visibleCount={visibleCountOf(groupKey)}
                  collapsedGroup={isProjectCollapsed(group.projectId)}
                  selectedSessionId={selectedSessionId}
                  batchMode={batchMode}
                  batchSelectedIds={selectedIds}
                  isStreaming={isStreaming}
                  fileWindowSessions={fileWindowSessions}
                  onBatchToggleIds={toggleBatchIds}
                  onBatchEnter={enterBatchMode}
                  onToggleGroup={toggleProjectGroup}
                  onOpenProject={() =>
                    navigate(`/module/project/${group.projectId}`)
                  }
                  onCreateTask={openProjectTasks}
                  onRenameProject={openRenameProjectDialog}
                  onDeleteProject={requestDeleteProject}
                  onSelect={selectSession}
                  onSessionRename={openSessionRenameDialog}
                  onSessionDelete={setDeletingSession}
                  onSessionPin={pinSession}
                  onSessionArchive={archiveSession}
                  onShowMore={showMoreGroup}
                  onCollapse={collapseGroup}
                />
              );
            })}
          {/* 已归档分组（归档可查看只读）：默认收起，行点击进会话查看，
            hover 恢复钮一键取消归档（无完整操作菜单——归档态语义收口） */}
          {archivedSessions.length > 0 && (
            <ArchivedGroup
              sessions={archivedSessions}
              selectedSessionId={selectedSessionId}
              onSelect={selectSession}
              onUnarchive={handleUnarchive}
            />
          )}
        </div>

        {/* 批量管理底部操作栏（shrink-0 在滚动区外，常驻侧栏底部） */}
        {batchMode && (
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

      {/* 项目重命名对话框（项目组 ⋯ 菜单） */}
      <Dialog
        open={renamingProject !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingProject(null);
          }
        }}
      >
        <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("project:sidebar.renameProject")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="project-name">{t("ai:provider.name")}</Label>
            <Input
              id="project-name"
              value={renamingProject?.name ?? ""}
              onChange={(e) =>
                setRenamingProject((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRenameProjectSubmit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingProject(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleRenameProjectSubmit} disabled={submitting}>
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 项目删除确认（级联删成员/挂载/动态流会话） */}
      <AlertDialog
        open={deletingProject !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingProject(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project:hub.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingProject
                ? `${deletingProject.name} · ${t("project:hub.deleteDesc")}`
                : t("project:hub.deleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </>
  );
}

interface WorkspaceGroupProps {
  workspace: WorkspaceRecord;
  collapsedGroup: boolean;
  sessions: SessionRecord[];
  /** 组收缩键（useSidebarExpand 持久化键） */
  groupKey: string;
  /** 组内可见条数（父级算好：默认 5 + 活跃保底扩档） */
  visibleCount: number;
  selectedSessionId: number | null;
  /** 批量管理：模式开关与选中集合（组复选框按组内可选集联动） */
  batchMode: boolean;
  batchSelectedIds: Set<number>;
  isStreaming: Record<string, boolean>;
  /** session→文件窗 resource 反向索引（主窗→文件窗跳转入口判定） */
  fileWindowSessions: Map<number, FileWindowResource>;
  onBatchToggleIds: (ids: number[], on: boolean) => void;
  /** 菜单「批量操作」入口：进入批量模式 */
  onBatchEnter: () => void;
  /** 以下回调均为稳定签名（分组/空间入参），跨 memo 边界引用不变 */
  onToggleGroup: (workspaceId: number) => void;
  onSelect: (sessionId: number) => void;
  /** 行内 + ：预选本空间跳「新建任务」详情页 */
  onCreateTask: (workspaceId: number) => void;
  onManageRename: (workspace: WorkspaceRecord) => void;
  onManageDelete: (workspace: WorkspaceRecord) => void;
  onManageBind: (workspaceId: number) => void;
  onManageUnbind: (workspace: WorkspaceRecord) => void;
  onSessionRename: (session: SessionRecord) => void;
  onSessionDelete: (session: SessionRecord) => void;
  onSessionPin: (session: SessionRecord) => void;
  onSessionArchive: (session: SessionRecord) => void;
  onOpenFolder: (workspaceId: number) => void;
  /** 组尾「展开更多」：key + 当前渲染值（保底态继续步进）+ 组内总数 */
  onShowMore: (groupKey: string, current: number, total: number) => void;
  /** 组尾「收起」：回默认条数 */
  onCollapse: (groupKey: string) => void;
}

interface GroupBatchCheckboxProps {
  sessions: SessionRecord[];
  selectedSessionId: number | null;
  batchSelectedIds: Set<number>;
  isStreaming: Record<string, boolean>;
  /** 组名（复选框无障碍标签） */
  label: string;
  onToggleIds: (ids: number[], on: boolean) => void;
}

/** 组级批量复选框（空间/项目组共用）：勾选=组内可选会话全选，半选=部分（PRD 3.1） */
function GroupBatchCheckbox({
  sessions,
  selectedSessionId,
  batchSelectedIds,
  isStreaming,
  label,
  onToggleIds,
}: GroupBatchCheckboxProps) {
  const selectableIds = sessions
    .filter((s) => s.id !== selectedSessionId && !isStreaming[s.id])
    .map((s) => s.id);
  const selectedCount = selectableIds.filter((id) =>
    batchSelectedIds.has(id),
  ).length;
  const checked: boolean | "indeterminate" =
    selectableIds.length > 0 && selectedCount === selectableIds.length
      ? true
      : selectedCount > 0
        ? "indeterminate"
        : false;
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={() =>
        onToggleIds(selectableIds, selectedCount !== selectableIds.length)
      }
      disabled={selectableIds.length === 0}
      aria-label={label}
      className="mr-1.5 shrink-0"
    />
  );
}

interface GroupShowMoreRowProps {
  groupKey: string;
  visibleCount: number;
  total: number;
  onShowMore: (groupKey: string, current: number, total: number) => void;
  onCollapse: (groupKey: string) => void;
}

/** 组尾「展开更多 (N)/收起」行（样式基于 WorkBuddy ShowMoreButton，
 *  布局定制为整行水平居中）：展开（N=剩余条数，点击当前值 +20 步进
 *  封顶总数）与收起（回默认 5）并排、竖线分隔，纯文字 12px/600、
 *  hover 仅文字变色无背景。剩余 >0 显示展开；已展开超默认显示收起；
 *  皆无不渲染。批量模式由调用方不渲染（组内全量平铺）。两钮均带
 *  Tooltip 冒泡提示（步进/收起语义） */
function GroupShowMoreRow({
  groupKey,
  visibleCount,
  total,
  onShowMore,
  onCollapse,
}: GroupShowMoreRowProps) {
  const { t } = useTranslation(["chat"]);
  const remaining = remainingVisible(visibleCount, total);
  const canCollapse = canCollapseVisible(visibleCount, total);
  if (remaining <= 0 && !canCollapse) {
    return null;
  }
  return (
    <div className="flex items-center justify-center py-0.5">
      {remaining > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex items-center rounded-lg py-1.5 pl-3 pr-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => onShowMore(groupKey, visibleCount, total)}
              >
                {t("chat:sidebar.showMore", { count: remaining })}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("chat:sidebar.showMoreTooltip")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {canCollapse && (
        <>
          {remaining > 0 && <span className="mr-2 h-3 w-px bg-border" />}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex items-center rounded-lg py-1.5 pl-2 pr-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => onCollapse(groupKey)}
                >
                  {t("chat:sidebar.showLess")}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t("chat:sidebar.showLessTooltip")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>
      )}
    </div>
  );
}

/** 单空间分组：标题行（折叠钮 + 空间名 + 悬停 +/...）+ 任务列表。
 *  memo：父级悬停/折叠/对话框等状态变化不重渲染全部分组（回调 props
 *  均为稳定签名，见 TaskTreeItemProps 注释）；折叠为 grid-rows 高度过渡
 *  （WorkBuddy cr-collapse 同款 280ms cubic-bezier(0.33,1,0.68,1)），
 *  内容常驻 DOM、折叠态 0 高度 + invisible 断交互；标题行吸顶
 *  （sidebar-sticky-header，sticky 亦是 positioned——absolute 悬停钮
 *  以其为包含块）；组内收缩默认 5 条（批量模式全量平铺——勾选集
 *  与显示一致），组尾「展开更多 (N)/收起」 */
const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace,
  collapsedGroup,
  sessions,
  groupKey,
  visibleCount,
  selectedSessionId,
  batchMode,
  batchSelectedIds,
  isStreaming,
  fileWindowSessions,
  onBatchToggleIds,
  onBatchEnter,
  onToggleGroup,
  onSelect,
  onCreateTask,
  onManageRename,
  onManageDelete,
  onManageBind,
  onManageUnbind,
  onSessionRename,
  onSessionDelete,
  onSessionPin,
  onSessionArchive,
  onOpenFolder,
  onShowMore,
  onCollapse,
}: WorkspaceGroupProps) {
  const { t } = useTranslation(["chat", "common"]);
  // 批量模式不截断（可勾选集与可见行一致），否则按可见条数截断
  const shown = batchMode ? sessions : sessions.slice(0, visibleCount);

  return (
    // pl-1 轻缩进：与顶层「空间」标题保留微弱层级（任务行在其内再缩 ml-2）
    <div className="group/workspace mt-1 pl-1">
      <div className="sidebar-sticky-header flex items-center">
        {batchMode && (
          <GroupBatchCheckbox
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            batchSelectedIds={batchSelectedIds}
            isStreaming={isStreaming}
            label={workspace.name}
            onToggleIds={onBatchToggleIds}
          />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pl-1 text-left text-sm text-foreground/90 hover:bg-primary-subtle/60"
          onClick={() => onToggleGroup(workspace.id)}
          title={workspace.name}
          aria-expanded={!collapsedGroup}
          aria-controls={`workspace-group-${workspace.id}`}
        >
          {/* 图标即折叠状态：闭合 Folder / 展开 FolderOpen（无箭头） */}
          {collapsedGroup ? (
            <Folder size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{workspace.name}</span>
        </button>
        {/* 悬停显现快捷钮（组头右缘）：操作「...」在左、新建任务 + 在右 */}
        <div className="absolute right-0 flex items-center opacity-0 transition-opacity group-hover/workspace:opacity-100 focus-within:opacity-100">
          <WorkspaceMenu
            disabled={false}
            workspace={workspace}
            onRename={() => onManageRename(workspace)}
            onDelete={() => onManageDelete(workspace)}
            onBindDirectory={() => onManageBind(workspace.id)}
            onUnbindDirectory={() => onManageUnbind(workspace)}
          />
          <IconTooltip label={t("chat:sidebar.newTaskInWorkspace")} side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              onClick={() => onCreateTask(workspace.id)}
              aria-label={t("chat:sidebar.newTaskInWorkspace")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
        </div>
      </div>
      <div
        id={`workspace-group-${workspace.id}`}
        aria-hidden={collapsedGroup}
        className={cn(
          "ml-2 grid transition-[grid-template-rows] duration-[280ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
          collapsedGroup && "invisible",
        )}
        style={{ gridTemplateRows: collapsedGroup ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          {sessions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t("chat:sidebar.emptyTask")}
            </p>
          ) : (
            <>
              {shown.map((session) => (
                <TaskTreeItem
                  key={session.id}
                  session={session}
                  workspaceDirectoryPath={workspace.directoryPath}
                  workspaceId={workspace.id}
                  selected={session.id === selectedSessionId}
                  fileWindowResource={fileWindowSessions.get(session.id)}
                  batchMode={batchMode}
                  batchChecked={batchSelectedIds.has(session.id)}
                  batchDisabled={
                    session.id === selectedSessionId ||
                    Boolean(isStreaming[session.id])
                  }
                  onBatchToggle={onBatchToggleIds}
                  onBatchEnter={onBatchEnter}
                  onSelect={onSelect}
                  onRename={onSessionRename}
                  onDelete={onSessionDelete}
                  onPin={onSessionPin}
                  onArchive={onSessionArchive}
                  onOpenFolder={onOpenFolder}
                />
              ))}
              {!batchMode && (
                <GroupShowMoreRow
                  groupKey={groupKey}
                  visibleCount={visibleCount}
                  total={sessions.length}
                  onShowMore={onShowMore}
                  onCollapse={onCollapse}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

interface ProjectGroupProps {
  projectId: number;
  /** 组名（项目名；已删/查询未就绪时为兜底文案，由父组件解析） */
  name: string;
  collapsedGroup: boolean;
  sessions: SessionRecord[];
  /** 组收缩键（useSidebar-expand 持久化键） */
  groupKey: string;
  /** 组内可见条数（父级算好：默认 5 + 活跃保底扩档） */
  visibleCount: number;
  selectedSessionId: number | null;
  batchMode: boolean;
  batchSelectedIds: Set<number>;
  isStreaming: Record<string, boolean>;
  /** session→文件窗 resource 反向索引（主窗→文件窗跳转入口判定） */
  fileWindowSessions: Map<number, FileWindowResource>;
  onBatchToggleIds: (ids: number[], on: boolean) => void;
  /** 菜单「批量操作」入口：进入批量模式 */
  onBatchEnter: () => void;
  onToggleGroup: (projectId: number) => void;
  /** ⋯ 菜单「进入项目」→ 项目页 */
  onOpenProject: () => void;
  /** 组头 + ：跳项目详情任务页签（新建任务入口在项目域） */
  onCreateTask: (projectId: number) => void;
  /** ⋯ 菜单「重命名项目」：打开对话框 */
  onRenameProject: (projectId: number, name: string) => void;
  /** ⋯ 菜单「删除项目」：打开级联删除确认框 */
  onDeleteProject: (projectId: number, name: string) => void;
  onSelect: (sessionId: number) => void;
  onSessionRename: (session: SessionRecord) => void;
  onSessionDelete: (session: SessionRecord) => void;
  onSessionPin: (session: SessionRecord) => void;
  onSessionArchive: (session: SessionRecord) => void;
  /** 组尾「展开更多」：key + 当前渲染值 + 组内总数 */
  onShowMore: (groupKey: string, current: number, total: number) => void;
  /** 组尾「收起」：回默认条数 */
  onCollapse: (groupKey: string) => void;
}

/**
 * 项目分组（一期会话统一 D4）：与空间组同构可折叠（组名区整块点击
 * 展开/收缩），行操作复用 TaskTreeItem；悬停快捷钮 [⋯][+]——⋯ 菜单
 * （进入项目/重命名/删除）、+ 跳项目详情任务页签（新建任务入口在
 * 项目域）；标题行吸顶 + 组内收缩与空间组同构
 */
const ProjectGroup = memo(function ProjectGroup({
  projectId,
  name,
  collapsedGroup,
  sessions,
  groupKey,
  visibleCount,
  selectedSessionId,
  batchMode,
  batchSelectedIds,
  isStreaming,
  fileWindowSessions,
  onBatchToggleIds,
  onBatchEnter,
  onToggleGroup,
  onOpenProject,
  onCreateTask,
  onRenameProject,
  onDeleteProject,
  onSelect,
  onSessionRename,
  onSessionDelete,
  onSessionPin,
  onSessionArchive,
  onShowMore,
  onCollapse,
}: ProjectGroupProps) {
  const { t } = useTranslation(["chat", "common", "project"]);
  // 批量模式不截断（可勾选集与可见行一致）
  const shown = batchMode ? sessions : sessions.slice(0, visibleCount);
  return (
    <div className="group/project mt-1 pl-1">
      <div className="sidebar-sticky-header flex items-center">
        {batchMode && (
          <GroupBatchCheckbox
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            batchSelectedIds={batchSelectedIds}
            isStreaming={isStreaming}
            label={name}
            onToggleIds={onBatchToggleIds}
          />
        )}
        {/* 组名区整块点击折叠/展开（与空间组同构）；进项目页入口在 ⋯ 菜单 */}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pl-1 text-left text-sm text-foreground/90 hover:bg-primary-subtle/60"
          onClick={() => onToggleGroup(projectId)}
          aria-expanded={!collapsedGroup}
          aria-controls={`project-group-${projectId}`}
        >
          <FolderKanban
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="truncate">{name}</span>
          {/* 折叠箭头随名称右侧（与空间组左侧箭头样式互异） */}
          {collapsedGroup ? (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          )}
        </button>
        {/* 悬停显现快捷钮（组头右缘）：⋯ 操作在左、+ 新建在右（与空间组同构） */}
        <div className="absolute right-0 flex items-center opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100">
          <DropdownMenu>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="project-more-trigger"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                      aria-label={t("common:more")}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">{t("common:more")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent
              align="end"
              className="border border-border/50 rounded-lg shadow-lg"
            >
              <DropdownMenuItem onClick={onOpenProject}>
                <SquareArrowOutUpRight className="mr-2 h-4 w-4" />
                {t("project:sidebar.enterProject")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onRenameProject(projectId, name)}
              >
                <Pencil className="mr-2 h-4 w-4" />
                {t("project:hub.menuRename")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDeleteProject(projectId, name)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("project:hub.menuDelete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconTooltip label={t("project:sidebar.newTaskInProject")} side="top">
            <Button
              variant="ghost"
              size="sm"
              data-testid="project-new-session"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              onClick={() => onCreateTask(projectId)}
              aria-label={t("project:sidebar.newTaskInProject")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
        </div>
      </div>
      <div
        id={`project-group-${projectId}`}
        aria-hidden={collapsedGroup}
        className={cn(
          "ml-2 grid transition-[grid-template-rows] duration-[280ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
          collapsedGroup && "invisible",
        )}
        style={{ gridTemplateRows: collapsedGroup ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          {shown.map((session) => (
            <TaskTreeItem
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              fileWindowResource={fileWindowSessions.get(session.id)}
              batchMode={batchMode}
              batchChecked={batchSelectedIds.has(session.id)}
              batchDisabled={
                session.id === selectedSessionId ||
                Boolean(isStreaming[session.id])
              }
              onBatchToggle={onBatchToggleIds}
              onBatchEnter={onBatchEnter}
              onSelect={onSelect}
              onRename={onSessionRename}
              onDelete={onSessionDelete}
              onPin={onSessionPin}
              onArchive={onSessionArchive}
            />
          ))}
          {!batchMode && (
            <GroupShowMoreRow
              groupKey={groupKey}
              visibleCount={visibleCount}
              total={sessions.length}
              onShowMore={onShowMore}
              onCollapse={onCollapse}
            />
          )}
        </div>
      </div>
    </div>
  );
});

interface TaskTreeItemProps {
  session: SessionRecord;
  workspaceDirectoryPath?: string;
  /** 行所属空间 id（打开目录回调入参）；项目组行不传（菜单项随之禁用） */
  workspaceId?: number;
  selected: boolean;
  /** 批量管理：勾选态与切换（批量模式下行点击即切换选择，不再导航） */
  batchMode: boolean;
  batchChecked: boolean;
  /** 当前选中会话/流式进行中：复选框禁用（PRD 4.3） */
  batchDisabled: boolean;
  /** 回调均为稳定签名（id/记录入参）：组件 memo 后跨渲染引用不变，
   *  悬停/折叠/选择等父级状态变化不再全树重渲染（空间树流畅度优化） */
  onBatchToggle: (ids: number[], on: boolean) => void;
  /** 菜单「批量操作」入口 */
  onBatchEnter: () => void;
  onSelect: (sessionId: number) => void;
  onRename: (session: SessionRecord) => void;
  onDelete: (session: SessionRecord) => void;
  onPin: (session: SessionRecord) => void;
  onArchive: (session: SessionRecord) => void;
  /** 打开空间绑定目录（入参空间 id） */
  onOpenFolder?: (workspaceId: number) => void;
  /** 文件窗 session-map 反向索引命中（该会话曾在文件窗绑定文件/资料）：
   *  传入才渲染「在文件窗口打开」跳转钮（spec §19 项 1） */
  fileWindowResource?: FileWindowResource;
}

/** 任务项：标题+相对时间；悬停出 .../归档/置顶 快捷钮；流式中显示绿点；
 *  批量模式：行首复选框，整行点击切换勾选，快捷钮隐藏 */
const TaskTreeItem = memo(function TaskTreeItem({
  session,
  workspaceDirectoryPath,
  workspaceId,
  selected,
  fileWindowResource,
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
  // P1 尾未读角标：标题行尾未读计数点（主色调圆点白字；≥100 显 99+；
  // 归档行不显——归档行由 ArchivedSessionRow 单独渲染，天然不含角标，
  // 此处 archivedAt 守卫为双保险；unreadCount 缺省（旧数据源）不显）
  const unreadBadge = session.archivedAt
    ? null
    : unreadBadgeText(session.unreadCount);

  // 主窗→文件窗跳转（spec §19 项 1）：invoke fileWindow:open 携 sessionId
  // （文件窗去重聚焦/命中覆盖 sessionId——T28 项 3）；成功不导航（主窗
  // 纯聊仍合法，不强劫持点会话本体），失败 toast 原因
  const openInFileWindow = () => {
    if (!fileWindowResource) return;
    invoke("fileWindow:open", {
      resources: [{ ...fileWindowResource, sessionId: session.id }],
    }).catch((e) => toast.error(mapIpcError(e)));
  };

  const quickActions = (
    <div className="absolute right-1 top-1.5 flex items-center opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100">
      <DropdownMenu>
        <TooltipProvider>
          <Tooltip>
            {/* 双 Trigger asChild 链式叠加到同一 Button（FilterPopover 先例） */}
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 focus:opacity-100"
                  aria-label={t("common:more")}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{t("common:more")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent
          align="end"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          <DropdownMenuItem onClick={() => onRename(session)}>
            <Pencil className="mr-2 h-4 w-4" />
            {t("chat:renameSession")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onPin(session)}>
            <Pin className="mr-2 h-4 w-4" />
            {pinned ? t("chat:task.unpin") : t("chat:task.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onArchive(session)}>
            <Archive className="mr-2 h-4 w-4" />
            {t("chat:task.archive")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              workspaceId !== undefined && onOpenFolder?.(workspaceId)
            }
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
            onClick={() => onDelete(session)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("chat:deleteSession")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              onClick={() => onArchive(session)}
              aria-label={t("chat:task.archive")}
            >
              <Archive className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("chat:task.archive")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              onClick={() => onPin(session)}
              aria-label={pinned ? t("chat:task.unpin") : t("chat:task.pin")}
            >
              {pinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {pinned ? t("chat:task.unpin") : t("chat:task.pin")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {fileWindowResource && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                onClick={(e) => {
                  // 与选中钮为兄弟节点（quickActions 悬浮层在行按钮外）事件
                  // 天然不冒泡进选中；stopPropagation 双保险防穿透
                  e.stopPropagation();
                  openInFileWindow();
                }}
                aria-label={t("chat:fileWindow.openSessionInFileWindow")}
              >
                <SquareArrowOutUpRight className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("chat:fileWindow.openSessionInFileWindow")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
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
              onBatchToggle([session.id], !batchChecked);
            }
            return;
          }
          onSelect(session.id);
        }}
      >
        <span className="flex items-center gap-1">
          {batchMode && (
            <Checkbox
              checked={batchChecked}
              disabled={batchDisabled}
              onCheckedChange={() => onBatchToggle([session.id], !batchChecked)}
              aria-label={session.title}
              className="mr-0.5 shrink-0"
            />
          )}
          {pinned && <Pin className="h-3 w-3 shrink-0" />}
          <span className="truncate text-sm" title={session.title}>
            {session.title}
          </span>
          {/* 角标插 title 行尾（禁破两行结构）：truncate 标题后紧跟计数点，
              流式绿点仍居右缘（ml-auto）；shrink-0 防数字被压缩 */}
          {unreadBadge !== null && (
            <span
              data-testid="unread-badge"
              className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground"
            >
              {unreadBadge}
            </span>
          )}
          {streaming && (
            <span className="ml-auto mr-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{timeText}</span>
      </button>
      {!batchMode && quickActions}
    </div>
  );
});
export { TaskTreeItem };

interface ArchivedGroupProps {
  sessions: SessionRecord[];
  selectedSessionId: number | null;
  onSelect: (sessionId: number) => void;
  onUnarchive: (sessionId: number) => void;
}

/** 已归档分组：默认收起（state 本地），grid-rows 折叠动画与空间/项目组同款 */
function ArchivedGroup({
  sessions,
  selectedSessionId,
  onSelect,
  onUnarchive,
}: ArchivedGroupProps) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(false);
  return (
    <div className="group/archived mt-2 border-t border-border/50 pt-1">
      <button
        type="button"
        className="sidebar-sticky-header flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls="archived-group"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0" />
        ) : (
          <ChevronRight size={14} className="shrink-0" />
        )}
        <Archive className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {t("chat:sidebar.archivedGroup")} ({sessions.length})
        </span>
      </button>
      <div
        id="archived-group"
        aria-hidden={!open}
        className={cn(
          "ml-2 grid transition-[grid-template-rows] duration-[280ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
          !open && "invisible",
        )}
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          {sessions.map((session) => (
            <ArchivedSessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              onSelect={onSelect}
              onUnarchive={onUnarchive}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 归档行：标题+时间，点击进会话（只读查看），hover 恢复钮（memo+稳定签名） */
const ArchivedSessionRow = memo(function ArchivedSessionRow({
  session,
  selected,
  onSelect,
  onUnarchive,
}: {
  session: SessionRecord;
  selected: boolean;
  onSelect: (sessionId: number) => void;
  onUnarchive: (sessionId: number) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const locale = getDateFnsLocale();
  const timeText = formatDistanceToNow(
    new Date(session.lastMessageAt ?? session.updatedAt),
    { addSuffix: true, locale },
  );
  return (
    <div
      className={cn(
        "group/archived-row relative mb-0.5 rounded-md",
        selected
          ? "bg-primary-subtle text-primary"
          : "hover:bg-primary-subtle/60",
      )}
    >
      <button
        type="button"
        className="block w-full py-1.5 pl-2 pr-20 text-left"
        onClick={() => onSelect(session.id)}
      >
        <span className="flex items-center gap-1">
          <Archive className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm" title={session.title}>
            {session.title}
          </span>
        </span>
        <span className="block text-xs text-muted-foreground">{timeText}</span>
      </button>
      <div className="absolute right-1 top-1.5 flex items-center opacity-0 transition-opacity group-hover/archived-row:opacity-100 focus-within:opacity-100">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                onClick={() => onUnarchive(session.id)}
                aria-label={t("chat:task.restore")}
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("chat:task.restore")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
});
