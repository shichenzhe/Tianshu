/**
 * 输入框：Enter 发送 / Shift+Enter 换行（IME 组合中的 Enter 不触发发送）
 * 发送中切换为停止按钮；未选模型时禁用发送并以占位符提示
 * 参数覆盖（spec §4.2 单次请求级）：Popover 内留空 = 不覆盖，随会话生命周期保留
 */
import { useCallback, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Send, SlidersHorizontal, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { ChatModelParams } from "../../api/chat.api";
import { parseOptionalInt, parseOptionalNumber } from "../../lib/parse-number";

interface ChatInputProps {
  /** 会话是否有生效模型（会话当前模型 → 工作空间默认），决定禁用与提示 */
  hasModel: boolean;
  sending: boolean;
  onSend: (content: string, overrides?: ChatModelParams) => void;
  onStop: () => void;
}

export default function ChatInput({
  hasModel,
  sending,
  onSend,
  onStop,
}: ChatInputProps) {
  const { t } = useTranslation(["chat", "ai"]);
  const [content, setContent] = useState("");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxTokens, setMaxTokens] = useState("");

  /** 解析三个可选字段；全空返回 undefined（该请求不携带覆盖） */
  const buildOverrides = useCallback((): ChatModelParams | undefined => {
    const overrides: ChatModelParams = {
      temperature: parseOptionalNumber(temperature),
      topP: parseOptionalNumber(topP),
      maxTokens: parseOptionalInt(maxTokens),
    };
    const hasAny =
      overrides.temperature !== undefined ||
      overrides.topP !== undefined ||
      overrides.maxTokens !== undefined;
    return hasAny ? overrides : undefined;
  }, [temperature, topP, maxTokens]);

  const submit = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed || !hasModel || sending) {
      return;
    }
    let overrides: ChatModelParams | undefined;
    try {
      overrides = buildOverrides();
    } catch {
      toast.error(t("ai:model.invalidNumber"));
      return;
    }
    onSend(trimmed, overrides);
    setContent("");
  }, [content, hasModel, sending, onSend, buildOverrides, t]);

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
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            aria-label={t("chat:input.paramOverrides")}
            title={t("chat:input.paramOverrides")}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-64 border border-border/50 rounded-lg shadow-lg"
        >
          <p className="mb-2 text-sm font-medium">
            {t("chat:input.paramOverrides")}
          </p>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="chat-override-temperature">
                {t("chat:input.temp")}
              </Label>
              <Input
                id="chat-override-temperature"
                type="number"
                step="0.1"
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chat-override-top-p">
                {t("chat:input.topP")}
              </Label>
              <Input
                id="chat-override-top-p"
                type="number"
                step="0.1"
                value={topP}
                onChange={(event) => setTopP(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chat-override-max-tokens">
                {t("chat:input.maxTokens")}
              </Label>
              <Input
                id="chat-override-max-tokens"
                type="number"
                step="1"
                min="1"
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
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
