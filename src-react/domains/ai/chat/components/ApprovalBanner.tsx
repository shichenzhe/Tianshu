/**
 * 工具审批横幅：渲染于 awaiting-approval 的工具卡片下方（接线由后续任务完成）
 * 任一按钮先回调 onDecided（父级立即隐藏横幅，终态 chunk 由主进程推）再 invoke；
 * 失败经 mapIpcError 映射后 toast 提示
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import ChatApi from "../../api/chat.api";
import WorkspaceApi from "../../api/workspace.api";
import { mapIpcError } from "../lib/error-message";

const WORKSPACES_KEY = ["workspaces"] as const;

interface ApprovalBannerProps {
  sessionId: number;
  workspaceId: number;
  toolCallId: string;
  /** 卡片头部已展示工具名，此处仅保留上下文（决议只需 toolCallId） */
  toolName: string;
  argSummary: string;
  rememberAvailable: boolean;
  /** 决议回调：先于 invoke 调用，父级立即隐藏横幅 */
  onDecided: () => void;
}

function ApprovalBannerImpl({
  workspaceId,
  toolCallId,
  argSummary,
  rememberAvailable,
  onDecided,
}: ApprovalBannerProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();

  const handleApprove = async () => {
    onDecided();
    try {
      await ChatApi.approveToolCall(toolCallId, true);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleDeny = async () => {
    onDecided();
    try {
      await ChatApi.approveToolCall(toolCallId, false);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 允许并记住：先落工作空间写授权（工具执行时校验），再放行挂起调用 */
  const handleApproveRemember = async () => {
    onDecided();
    try {
      await WorkspaceApi.approveWrite(workspaceId);
      await ChatApi.approveToolCall(toolCallId, true);
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <div className="my-1 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2">
      <p className="break-words text-xs text-foreground">
        {argSummary || t("chat:tool.argSummaryFallback")}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <Button variant="default" size="sm" onClick={handleApprove}>
          {t("chat:tool.approve")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          onClick={handleDeny}
        >
          {t("chat:tool.deny")}
        </Button>
        {rememberAvailable && (
          <Button
            variant="outline"
            size="sm"
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            onClick={handleApproveRemember}
          >
            {t("chat:tool.approveRemember")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default memo(ApprovalBannerImpl);
