/**
 * 消息编辑条（EditBar）：编辑既有 user 消息并重发（在 MessageItem 内原位
 * 替换 user 气泡，宽度与气泡同口径 75%）。
 * 卡片样式与 ChatInput 一致（无联想/镜像层，独立轻量组件）：
 * 顶部提示行说明重发后果；textarea 回填 initialText，挂载即 focus 且
 * 光标置文末；底部右侧 取消/重发（内容 trim 为空时禁用）。
 * 键盘：Enter（非 IME 组合、非 Shift）提交、Shift+Enter 换行、Escape 取消。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";

interface EditBarProps {
  /** 待编辑的原消息文本（回填进 textarea） */
  initialText: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}

export default function EditBar({
  initialText,
  onCancel,
  onSubmit,
}: EditBarProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 挂载后聚焦并把光标置于文末（方便追加编辑）。空依赖仅挂载时执行：
  // 编辑对象直接切换（A→B 不经过取消）时 EditBar 移入另一条消息的
  // MessageItem（外层 key=message.id 不同实例），自然重挂载，state 随新
  // initialText 重建，避免 textarea 残留上一条的文本
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(initialText.length, initialText.length);
  }, []);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-testid="edit-bar"
      className="relative flex w-full max-w-[75%] min-w-0 flex-col rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40"
    >
      <div className="flex items-center gap-1.5 pt-1">
        <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {t("chat:message.editHint")}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        className="mt-2 min-h-16 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-relaxed field-sizing-content max-h-56 outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          {t("common:cancel")}
        </Button>
        <Button size="sm" onClick={submit} disabled={text.trim() === ""}>
          {t("chat:message.resend")}
        </Button>
      </div>
    </div>
  );
}
