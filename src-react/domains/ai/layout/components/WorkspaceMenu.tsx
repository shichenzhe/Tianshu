/**
 * 空间管理菜单（自 SessionSidebar 迁移）：新建/重命名/绑定目录/解绑/删除
 */
import { useTranslation } from "react-i18next";
import {
  FolderInput,
  FolderMinus,
  FolderPlus,
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
import type { WorkspaceRecord } from "../../api/workspace.api";

interface WorkspaceMenuProps {
  disabled: boolean;
  /** 当前激活工作空间；null（未选中）时隐藏目录管理项 */
  workspace: WorkspaceRecord | null;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
  onBindDirectory: () => void;
  onUnbindDirectory: () => void;
}

export default function WorkspaceMenu({
  disabled,
  workspace,
  onCreate,
  onRename,
  onDelete,
  onBindDirectory,
  onUnbindDirectory,
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
