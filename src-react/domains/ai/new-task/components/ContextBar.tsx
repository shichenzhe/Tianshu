/**
 * 新建任务配置栏（spec §4 输入卡下方）：左——任务级工作空间下拉，
 * workspaceId 为 null（首次进入）时 effect 自动跟随列表第一个（与
 * deriveCurrentWorkspaceId 兜底口径一致）；右——权限档位胶囊两档：
 * standard 直写 default；full 开 FullAccessModal 免责确认后才写 full
 * （同 ChatPane/PermissionCapsule 口径）。空列表降级灰字 noWorkspace。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FolderOpen, ShieldCheck, Unlock } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import WorkspaceApi from "../../api/workspace.api";
import FullAccessModal from "../../chat/components/FullAccessModal";
import { cn } from "@/lib/utils";
import { useNewTaskStore } from "../store/new-task-store";

/** 胶囊触发钮样式（与 chat PermissionCapsule.tsx:52 一致） */
const CAPSULE_CLASS =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full border " +
  "border-border/50 px-2.5 text-xs hover:border-primary/30 hover:bg-primary-subtle";

/** data 空时稳定引用，避免 effect 依赖数组随渲染抖动 */
const NO_WORKSPACES: never[] = [];

export default function ContextBar() {
  const { t } = useTranslation(["newTask"]);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const setWorkspaceId = useNewTaskStore((s) => s.setWorkspaceId);
  const accessMode = useNewTaskStore((s) => s.accessMode);
  const setAccessMode = useNewTaskStore((s) => s.setAccessMode);
  const [modalOpen, setModalOpen] = useState(false);

  // 只消费 data（列表/空态均由 data 有无推导）
  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const workspaces = data ?? NO_WORKSPACES;

  // 首次进入（未配置）默认跟随全局 = 列表第一个；列表空保持 null
  // （空列表下 setWorkspaceId(null) 本就是空操作，跳过免触发一次无谓持久化）
  useEffect(() => {
    if (workspaceId === null && workspaces.length > 0) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaceId, workspaces, setWorkspaceId]);

  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);
  const isFull = accessMode === "full";

  return (
    <div className="flex items-center justify-center gap-2">
      {workspaces.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={t("newTask:context.workspace")}
              className={CAPSULE_CLASS}
            >
              <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
              <span
                className={cn(
                  "max-w-40 truncate",
                  currentWorkspace
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {currentWorkspace?.name ?? t("newTask:context.noWorkspace")}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-52 border border-border/50 rounded-lg shadow-lg"
          >
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onClick={() => setWorkspaceId(workspace.id)}
              >
                <span className="truncate">{workspace.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("newTask:context.noWorkspace")}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={t("newTask:context.permission")}
            className={CAPSULE_CLASS}
          >
            {isFull ? (
              <Unlock className="h-3.5 w-3.5 text-primary" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className={isFull ? "text-primary" : "text-muted-foreground"}>
              {isFull
                ? t("newTask:context.full")
                : t("newTask:context.standard")}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-52 border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem onClick={() => setAccessMode("default")}>
            <ShieldCheck />
            {t("newTask:context.standard")}
          </DropdownMenuItem>
          <DropdownMenuItem
            title={t("newTask:context.fullDesc")}
            onClick={() => setModalOpen(true)}
          >
            <Unlock />
            {t("newTask:context.full")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FullAccessModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConfirm={() => setAccessMode("full")}
      />
    </div>
  );
}
