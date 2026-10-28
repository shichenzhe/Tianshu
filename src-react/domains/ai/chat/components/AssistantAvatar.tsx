/**
 * assistant 头像（消息头像列与流式状态行共用）：28px 圆形，专家 icon
 * （emoji 字符）居中；无专家/无 icon 时 Sparkles 图标兜底（主题色底）。
 * 布局参照 WorkBuddy 消息流头像列
 */
import { memo } from "react";
import { Sparkles } from "lucide-react";

function AssistantAvatarImpl({ icon }: { icon?: string }) {
  return (
    <div
      aria-hidden
      className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full border border-border/50 bg-primary-subtle text-primary"
    >
      {icon ? (
        <span className="text-sm leading-none">{icon}</span>
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
    </div>
  );
}

export default memo(AssistantAvatarImpl);
