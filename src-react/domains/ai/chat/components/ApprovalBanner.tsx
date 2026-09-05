/**
 * 工具审批横幅：渲染于 awaiting-approval 的工具卡片下方
 * 任一按钮先回调 onDecided（父级立即隐藏横幅，终态 chunk 由主进程推）再 invoke；
 * 失败经 mapIpcError 映射后 toast 提示。
 * P4 反馈 2：「允许并记住」= 工作空间级持久记忆（toolPermission 表，
 * 参照 Claude Code allowed-tools），后续同工具免审
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import ChatApi from "../../api/chat.api";
import { mapIpcError } from "../lib/error-message";

interface ApprovalBannerProps {
  toolCallId: string;
  toolName: string;
  argSummary: string;
  /** 工作空间记忆（P4）：null（未选中/未绑定）时隐藏「允许并记住」 */
  workspaceId: number | null;
  /** 决议回调：先于 invoke 调用，父级立即隐藏横幅 */
  onDecided: () => void;
}

function ApprovalBannerImpl({
  toolCallId,
  toolName,
  argSummary,
  workspaceId,
  onDecided,
}: ApprovalBannerProps) {
  const { t } = useTranslation(["chat"]);

  const handleApprove = async () => {
    onDecided();
    try {
      await ChatApi.approveToolCall(toolCallId, true);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 允许并记住：先写工作空间记忆（持久），再放行本次（顺序防竞态） */
  const handleApproveRemember = async () => {
    onDecided();
    try {
      if (workspaceId !== null) {
        await ChatApi.rememberTool(workspaceId, toolName);
      }
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

  return (
    <div className="my-1 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2">
      <p className="break-words text-xs text-foreground">
        {argSummary || t("chat:tool.argSummaryFallback")}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <Button variant="default" size="sm" onClick={handleApprove}>
          {t("chat:tool.approve")}
        </Button>
        {workspaceId !== null && (
          <Button
            variant="outline"
            size="sm"
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            onClick={handleApproveRemember}
          >
            {t("chat:tool.approveRemember")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          onClick={handleDeny}
        >
          {t("chat:tool.deny")}
        </Button>
      </div>
    </div>
  );
}

export default memo(ApprovalBannerImpl);
