/**
 * 消息区，无发送依赖——发送状态与输入在组合壳或调用方（ChatPane）：本组件
 * 只承载 MessageList（编辑态接线由组合壳以 props 透传）；底部插槽
 * （children）渲染于消息列表之后，组合壳据此注入 AgentProgress 与
 * ChatInput，DOM 结构与拆分前一致。产物面板由调用方旁挂为全高右列
 * （ChatView/ActivityPane 层渲染，与项目详情右栏同构）。
 */
import type { ReactNode } from "react";

import type { SessionRecord } from "../../api/session.api";
import type { WorkspaceRecord } from "../../api/workspace.api";
import MessageList from "./MessageList";

interface ChatMessagesProps {
  session: SessionRecord;
  /** 会话所属工作空间（@ 文件联想按 id 定位，与 ChatPane 同口径） */
  workspace: Pick<WorkspaceRecord, "id"> | null;
  /** 消息编辑态（组合壳持有）：经 MessageList 透传到被编辑气泡原位替换 EditBar */
  editing: { messageId: number; text: string } | null;
  /** 重新生成回调（任意 assistant 消息），组合壳透传 */
  onRegenerate: (messageId?: number) => void | Promise<void>;
  /** 进入编辑回调（user 消息 hover 操作栏），组合壳透传 */
  onEdit: (messageId: number) => void;
  /** 原位编辑提交（重发）回调，组合壳透传 */
  onEditSubmit: (text: string) => void | Promise<void>;
  /** 原位编辑取消回调，组合壳透传 */
  onEditCancel: () => void;
  /** 底部插槽：组合壳/调用方注入进度条与输入区（AgentProgress + ChatInput） */
  children?: ReactNode;
}

export default function ChatMessages({
  session,
  workspace,
  editing,
  onRegenerate,
  onEdit,
  onEditSubmit,
  onEditCancel,
  children,
}: ChatMessagesProps) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList
          sessionId={session.id}
          workspaceId={workspace?.id ?? null}
          compactedUpToId={session.compactedUpToId ?? null}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          editing={editing}
          onEditSubmit={onEditSubmit}
          onEditCancel={onEditCancel}
        />
        {children}
      </div>
    </div>
  );
}
