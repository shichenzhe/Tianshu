/**
 * 工具审批横幅：渲染于 awaiting-approval 的工具卡片下方
 * 任一按钮先回调 onDecided（父级立即隐藏横幅，终态 chunk 由主进程推）再 invoke；
 * 失败经 mapIpcError 映射后 toast 提示。
 * P4 反馈 2：「允许并记住」= 工作空间级持久记忆（toolPermission 表，
 * 参照 Claude Code allowed-tools），后续同工具免审
 * 参数级审批批（security P1-3）：「允许并记住」带下拉——bash/文件类工具
 * 出「参数前缀」选项（`git *` / `src/**`，suggestRememberPattern 与执行侧
 * 匹配同源），整工具选项语义不变；其余工具维持单按钮（无参数级语义）
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { suggestRememberPattern } from "@tianshu/core/permission-pattern";
import ChatApi from "../../api/chat.api";
import { useHostStore } from "../../data-source/host.store";
import { mapIpcError } from "../lib/error-message";

interface ApprovalBannerProps {
  /** 决议归属会话（远程 approveSession 定位用；本地通道不消费） */
  sessionId: number;
  toolCallId: string;
  toolName: string;
  argSummary: string;
  /** 当次工具调用入参（参数级前缀建议来源——与执行侧匹配同源） */
  args?: unknown;
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
  args,
  workspaceId,
  onDecided,
}: ApprovalBannerProps) {
  const { t } = useTranslation(["chat"]);
  // 远程态（审批记住批）：经 approve 载荷 remember 上送，被控端写
  // 工作空间记忆——「允许并记住」不再因远程而隐藏
  const remoteHost = useHostStore((s) => s.activeHost.kind === "remote");
  // 参数前缀建议（与执行侧 matchPermissionPattern 同源）：bash 取命令
  // 首 token、write/rm 取所在目录；含 shell 元字符的命令不提供（防误扩）
  const patternSuggestion = suggestRememberPattern(toolName, args);

  const handleApprove = async () => {
    onDecided();
    try {
      await ChatApi.approveToolCall(sessionId, toolCallId, true);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 允许并记住（pattern 缺席 = 整工具记忆）：先写工作空间记忆（持久），
   *  再放行本次（顺序防竞速）；远程态（workspaceId null）经 approve 载荷
   *  remember 单次上送——被控端归属校验后写 toolPermission（审批记住批
   *  解锁远程记住；pattern 随载荷上送——参数级审批批） */
  const handleApproveRemember = async (pattern?: string) => {
    onDecided();
    try {
      if (workspaceId !== null) {
        await ChatApi.rememberTool(
          workspaceId,
          toolName,
          pattern != null ? pattern : undefined,
        );
      }
      await ChatApi.approveToolCall(
        sessionId,
        toolCallId,
        true,
        workspaceId == null ? toolName : undefined,
        workspaceId == null && pattern != null ? pattern : undefined,
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

  /** 允许并记住按钮组：有参数前缀建议时下拉两档（前缀/整工具），否则单按钮 */
  const rememberControl =
    patternSuggestion != null ? (
      <div className="flex items-center">
        <Button
          variant="outline"
          size="sm"
          className="rounded-r-none border-r-0 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          onClick={() => handleApproveRemember(patternSuggestion)}
        >
          {t("chat:tool.approveRememberPrefix", {
            pattern: patternSuggestion,
          })}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="rounded-l-none px-1.5 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
              aria-label={t("chat:tool.approveRememberMore")}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="border border-border/50 rounded-lg shadow-lg"
          >
            <DropdownMenuItem
              onClick={() => handleApproveRemember(undefined)}
              className="text-xs"
            >
              {t("chat:tool.approveRememberWhole", { toolName })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) : (
      <Button
        variant="outline"
        size="sm"
        className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        onClick={() => handleApproveRemember(undefined)}
      >
        {t("chat:tool.approveRemember")}
      </Button>
    );

  return (
    <div className="my-1 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2">
      <p className="break-words text-xs text-foreground">
        {argSummary || t("chat:tool.argSummaryFallback")}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button variant="default" size="sm" onClick={handleApprove}>
          {t("chat:tool.approve")}
        </Button>
        {(workspaceId !== null || remoteHost) && rememberControl}
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
