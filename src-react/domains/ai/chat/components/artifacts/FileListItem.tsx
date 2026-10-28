/**
 * 产物面板文件项：类型图标 + 截断文件名（Tooltip 全名）+ hover "..." 菜单
 * （预览/另存为副本/在 Finder 中显示/复制路径）；写入中禁用预览
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ArtifactApi from "../../../api/artifact.api";
import type { SessionFile } from "../../lib/artifacts";
import { mapIpcError } from "../../lib/error-message";
import { fileIconFor } from "./file-icon";

interface FileListItemProps {
  file: SessionFile;
  workspaceId: number;
  onPreview: (file: SessionFile) => void;
}

function FileListItem({ file, workspaceId, onPreview }: FileListItemProps) {
  const { t } = useTranslation(["chat"]);
  const Icon = fileIconFor(file.path);
  const writing = file.status === "writing";

  const handleExport = async () => {
    try {
      const saved = await ArtifactApi.exportFile(workspaceId, file.path);
      if (saved) toast.success(t("chat:artifacts.exportSuccess"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleReveal = async () => {
    try {
      await ArtifactApi.revealFile(workspaceId, file.path);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      toast.success(t("chat:artifacts.copyPathSuccess"));
    } catch {
      toast.error(t("chat:artifacts.copyPathFailed"));
    }
  };

  return (
    <li
      className="group relative flex items-center gap-2 rounded-md px-2 py-1.5"
      role="button"
      tabIndex={0}
      aria-disabled={writing}
      onClick={() => !writing && onPreview(file)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!writing) onPreview(file);
        }
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm">{file.path}</span>
              {writing && (
                <span className="shrink-0 rounded-full bg-primary-subtle px-1.5 py-0.5 text-[10px] text-primary">
                  {t("chat:artifacts.writing")}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{file.path}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("chat:artifacts.moreActions")}
            className="absolute right-1 rounded p-0.5 text-muted-foreground opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto hover:text-primary"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem disabled={writing} onClick={() => onPreview(file)}>
            {t("chat:artifacts.actionPreview")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleExport()}>
            {t("chat:artifacts.actionExport")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleReveal()}>
            {t("chat:artifacts.actionReveal")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleCopyPath()}>
            {t("chat:artifacts.actionCopyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export default FileListItem;
