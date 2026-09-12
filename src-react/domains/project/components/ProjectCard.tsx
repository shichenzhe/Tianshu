/**
 * 项目卡片（spec §6.1）：模版图标 + 名称 + 创建时间（相对时间）+
 * 「...」菜单（重命名 → 小 Dialog 预填 Input；删除 → AlertDialog 二次确认）。
 * 重命名/删除成功后 invalidate ["projects"]（前缀匹配 hub 的 ["projects", ownerId]）；
 * 弹层与可点击卡片区为兄弟节点、菜单触发器外层拦截冒泡，均不误触整卡导航。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";

import { getDateFnsLocale } from "@/i18n";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
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
import ProjectApi from "../api/project.api";
import { getTemplate, getTemplateIcon } from "../model/project-templates";
import type { ProjectRecord } from "../../../../electron/domains/project/project.entity";

/** 项目列表查询前缀（hub 实际 key 为 ["projects", ownerId]，前缀失效即可） */
const PROJECTS_KEY = ["projects"] as const;

/**
 * 重名错误码：与 electron/domains/project/project.entity 的同名常量保持
 * 同值（渲染进程镜像声明，参照 CreateProjectDialog 先例）
 */
const PROJECT_NAME_EXISTS = "PROJECT_NAME_EXISTS";

/** 项目名称长度上限（与 CreateProjectDialog 同口径） */
const NAME_MAX_LENGTH = 15;

interface ProjectCardProps {
  project: ProjectRecord;
}

export default function ProjectCard({ project }: ProjectCardProps) {
  const { t } = useTranslation(["project", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const Icon = getTemplateIcon(getTemplate(project.templateKey ?? "")?.icon);
  const createdAtText = t("project:hub.createdAt", {
    date: formatDistanceToNow(new Date(project.createdAt), {
      addSuffix: true,
      locale: getDateFnsLocale(),
    }),
  });

  const handleRename = async () => {
    const name = renameName.trim();
    // 与新建弹窗同口径：≤15 字客户端拦截，超出不发 IPC
    if (!name || name.length > NAME_MAX_LENGTH || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await ProjectApi.update({ id: project.id, name });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      toast.success(t("project:toast.renamed"));
      setRenameOpen(false);
    } catch (e) {
      // 重名由后端校验拦截（不做前端预校验）：已知码给文案，其余透传
      if (e instanceof Error && e.message.includes(PROJECT_NAME_EXISTS)) {
        toast.error(t("project:create.nameExists"));
      } else {
        toast.error(mapIpcError(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await ProjectApi.remove(project.id);
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      toast.success(t("project:toast.deleted"));
      setDeleteOpen(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const openRename = () => {
    setRenameName(project.name);
    setRenameError(null);
    setRenameOpen(true);
  };

  return (
    <>
      <div
        className="group/card flex cursor-pointer flex-col gap-3 rounded-lg border border-border/50 bg-card p-4 shadow-sm transition-colors hover:border-primary/30 hover:bg-primary-subtle"
        onClick={() => navigate(`/module/project/${project.id}`)}
      >
        <div className="flex items-start justify-between">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-subtle text-primary">
            <Icon size={18} />
          </span>
          {/* 拦截冒泡：portal 内菜单项点击不触发整卡导航 */}
          <span
            className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                  aria-label={t("common:operation")}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="rounded-lg border border-border/50 shadow-lg"
              >
                <DropdownMenuItem onClick={openRename}>
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("project:hub.menuRename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setDeleteOpen(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("project:hub.menuDelete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        <div className="min-w-0">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={project.name}
          >
            {project.name}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{createdAtText}</p>
        </div>
      </div>

      {/* 重命名弹窗（与可点击卡片区为兄弟节点，事件不冒泡进卡片） */}
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => !open && setRenameOpen(false)}
      >
        <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("project:hub.menuRename")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`rename-project-${project.id}`}>
              {t("project:create.nameLabel")}
            </Label>
            <Input
              id={`rename-project-${project.id}`}
              value={renameName}
              onChange={(e) => {
                setRenameName(e.target.value);
                // 实时长度校验（与新建弹窗同口径，reuse create 命名空间文案）
                setRenameError(
                  e.target.value.trim().length > NAME_MAX_LENGTH
                    ? t("project:create.nameTooLong")
                    : null,
                );
              }}
              aria-invalid={renameError !== null}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRename();
                }
              }}
            />
            {renameError && (
              <p className="text-xs text-destructive">{renameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            >
              {t("common:cancel")}
            </Button>
            <Button onClick={handleRename} disabled={submitting}>
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认 */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => !open && setDeleteOpen(false)}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project:hub.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {`${project.name} · ${t("project:hub.deleteDesc")}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
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
