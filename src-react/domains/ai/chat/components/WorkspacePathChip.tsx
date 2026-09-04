/**
 * 工作空间绑定路径 chip：显示于消息区上方顶栏，展示当前绑定目录的短路径
 * （>24 字符中段省略，title 悬浮全路径）；点击弹出菜单可重新绑定/解绑
 * （解绑需确认）。未绑定时由 ChatView 不渲染
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderClosed, FolderInput, FolderMinus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceRecord } from "../../api/workspace.api";
import { mapIpcError } from "../lib/error-message";
import { shortenPath } from "../lib/shorten-path";
import { bindWorkspaceDirectory } from "../lib/workspace-actions";
import UnbindDirectoryDialog from "./UnbindDirectoryDialog";

interface WorkspacePathChipProps {
  /** 绑定目录的工作空间（仅 directoryPath 非空时渲染） */
  workspace: WorkspaceRecord;
}

function WorkspacePathChipImpl({ workspace }: WorkspacePathChipProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const [unbinding, setUnbinding] = useState(false);
  const directoryPath = workspace.directoryPath ?? "";

  /** 重新绑定：用户取消选目录时后端返回 null，静默不提示 */
  const handleRebind = async () => {
    try {
      await bindWorkspaceDirectory(queryClient, workspace.id);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <div className="flex items-center px-4 pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={directoryPath}
            aria-label={t("chat:workspace.boundPathLabel")}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            <FolderClosed className="h-3 w-3 shrink-0" />
            <span className="truncate">{shortenPath(directoryPath)}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem onClick={handleRebind}>
            <FolderInput className="mr-2 h-4 w-4" />
            {t("chat:workspace.rebindDirectory")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setUnbinding(true)}>
            <FolderMinus className="mr-2 h-4 w-4" />
            {t("chat:workspace.unbindDirectory")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <UnbindDirectoryDialog
        workspace={unbinding ? workspace : null}
        onOpenChange={(open) => {
          if (!open) {
            setUnbinding(false);
          }
        }}
        onUnbound={() => setUnbinding(false)}
      />
    </div>
  );
}

export default WorkspacePathChipImpl;
