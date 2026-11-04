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
import { useHostStore } from "../../data-source/host.store";
import { mapIpcError } from "../lib/error-message";

interface ApprovalBannerProps {
  /** 决议归属会话（远程 approveSession 定位用；本地通道不消费） */
  sessionId: number;
  toolCallId: string;
  toolName: string;
  argSummary: string;
  /** 工作空间记忆（P4）：null（未选中/未绑定/远程主机——空间概念不
   *  跨主机）时隐藏「允许并记住」 */
  workspaceId: number | null;
  /** 决议回调：先于 invoke 调用，父级立即隐藏横幅 */
  onDecided: () => void;
}

function ApprovalBannerImpl({
  sessionId,
  toolCallId,
  toolName,
  argSummary,
  workspaceId,
  onDecided,
}: ApprovalBannerProps) {
  const { t } = useTranslation(["chat"]);
  // 远程态（审批记住批）：经 approve 载荷 remember 上送，被控端写
  // 工作空间记忆——「允许并记住」不再因远程而隐藏
  const remoteHost = useHostStore((s) => s.activeHost.kind === "remote");

  const handleApprove = async () => {
    onDecided();
    try {
      await ChatApi.approveToolCall(sessionId, toolCallId, true);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 允许并记住：先写工作空间记忆（持久），再放行本次（顺序防竞态）；
   *  远程态（workspaceId null）经 approve 载荷 remember 单次上送——被控
   *  端归属校验后写 toolPermission（审批记住批解锁远程记住） */
  const handleApproveRemember = async () => {
    onDecided();
    try {
      if (workspaceId !== null) {
        await ChatApi.rememberTool(workspaceId, toolName);
      }
      await ChatApi.approveToolCall(
        sessionId,
        toolCallId,
        true,
        workspaceId == null ? toolName : undefined,
      );
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleDeny = async () => {
    onDecided();
    try {
      await ChatApi.approveToolCall(sessionId, toolCallId, false);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <div className="my-1 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2">
      <p className="break-words text-xs text-foreground">
        {argSummary || t("chat:tool.argSummaryFallback")}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button variant="default" size="sm" onClick={handleApprove}>
          {t("chat:tool.approve")}
        </Button>
        {(workspaceId !== null || remoteHost) && (
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
