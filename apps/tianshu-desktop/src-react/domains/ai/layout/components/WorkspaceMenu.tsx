/**
 * 空间管理菜单（自 SessionSidebar 迁移）：重命名/绑定目录/解绑/删除。
 * 「新建工作空间」快捷入口在「空间」区头右侧 +（对齐 WorkBuddy 区头
 * add-btn），不在本菜单
 */
import { useTranslation } from "react-i18next";
import {
  FolderInput,
  FolderMinus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceRecord } from "../../api/workspace.api";

interface WorkspaceMenuProps {
  disabled: boolean;
  /** 当前激活工作空间；null（未选中）时隐藏目录管理项 */
  workspace: WorkspaceRecord | null;
  onRename: () => void;
  onDelete: () => void;
  onBindDirectory: () => void;
  onUnbindDirectory: () => void;
}

export default function WorkspaceMenu({
  disabled,
  workspace,
  onRename,
  onDelete,
  onBindDirectory,
  onUnbindDirectory,
}: WorkspaceMenuProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          {/* 双 Trigger asChild 链式叠加到同一 Button（FilterPopover 先例；
              side top 与任务行 ⋯ 同构——IconTooltip 默认 bottom 曾致组头
              气泡文字不可见，统一走已验证结构） */}
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
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
        <DropdownMenuItem onClick={onRename} disabled={disabled}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("chat:renameWorkspace")}
        </DropdownMenuItem>
        {workspace && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onBindDirectory}>
              <FolderInput className="mr-2 h-4 w-4" />
              {t("chat:workspace.bindDirectory")}
            </DropdownMenuItem>
            {workspace.directoryPath && (
              <DropdownMenuItem onClick={onUnbindDirectory}>
                <FolderMinus className="mr-2 h-4 w-4" />
                {t("chat:workspace.unbindDirectory")}
              </DropdownMenuItem>
            )}
          </>
        )}
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
