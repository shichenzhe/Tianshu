/**
 * 输入框：Enter 发送 / Shift+Enter 换行（IME 组合中的 Enter 不触发发送）
 * 发送中切换为停止按钮；未选模型时禁用发送并以占位符提示
 */
import { useCallback, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatInputProps {
  /** 会话是否有生效模型（会话当前模型 → 工作空间默认），决定禁用与提示 */
  hasModel: boolean;
  sending: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

export default function ChatInput({
  hasModel,
  sending,
  onSend,
  onStop,
}: ChatInputProps) {
  const { t } = useTranslation(["chat"]);
  const [content, setContent] = useState("");

  const submit = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed || !hasModel || sending) {
      return;
    }
    onSend(trimmed);
    setContent("");
  }, [content, hasModel, sending, onSend]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
      data-testid="chat-input"
      className="flex min-w-0 flex-1 items-end gap-2"
    >
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        autoFocus
        placeholder={t(
          hasModel ? "chat:input.placeholder" : "chat:input.modelRequired",
        )}
        className="max-h-40 min-h-0 flex-1 resize-none overflow-y-auto"
      />
      {sending ? (
        <Button
          variant="outline"
          onClick={onStop}
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          <Square className="mr-1 h-4 w-4" />
          {t("chat:input.stop")}
        </Button>
      ) : (
        <Button onClick={submit} disabled={!hasModel || content.trim() === ""}>
          <Send className="mr-1 h-4 w-4" />
          {t("chat:input.send")}
        </Button>
      )}
    </div>
  );
}
