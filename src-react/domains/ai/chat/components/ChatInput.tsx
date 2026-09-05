/**
 * 卡片式输入框（P3 spec §1）：上行 ＋扩展菜单 + 权限胶囊 + 模式徽标，
 * 中行 textarea（field-sizing 自适应），引用文件 chips 暂存，
 * 下行右 参数覆盖 + 模型选择 + 发送/停止
 * Enter 发送 / Shift+Enter 换行（IME 组合中的 Enter 不触发发送）
 * 发送中切换为停止按钮；未选模型时禁用发送并以占位符提示
 * 发送失败（onSend reject）时输入与 chips 保留可重试，成功后才清空
 * 参数覆盖（spec §4.2 单次请求级）：Popover 内留空 = 不覆盖，随会话生命周期保留
 */
import { useCallback, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Send, SlidersHorizontal, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ChatModelParams } from "../../api/chat.api";
import type { SessionMode } from "../../api/session.api";
import { parseOptionalInt, parseOptionalNumber } from "../../lib/parse-number";
import ModelPicker from "./ModelPicker";
import PermissionCapsule, { type AccessMode } from "./PermissionCapsule";
import PlusMenu from "./PlusMenu";

/** 待引用文件：＋菜单选取暂存于此，发送时随 onSend 带出（渲染层拼注入块） */
export interface PendingFile {
  path: string;
  content: string;
}

/** 路径尾段（跨平台分隔符），chips 展示用 */
function pathBasename(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : filePath;
}

interface FileChipProps {
  path: string;
  onRemove: () => void;
}

/** 引用文件 chip：📎 + 文件名（title 悬浮全路径）+ 移除按钮 */
function FileChip({ path, onRemove }: FileChipProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <span className="inline-flex max-w-64 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      <span aria-hidden>{"📎"}</span>
      <span className="truncate" title={path}>
        {pathBasename(path)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("chat:attach.remove")}
        className="shrink-0 rounded-sm hover:text-primary"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

interface ChatInputProps {
  /** 会话是否有生效模型（会话当前模型 → 工作空间默认），决定禁用与提示 */
  hasModel: boolean;
  sending: boolean;
  /** 权限胶囊（T5）：权限 state 留 ChatPane，本组件受控展示 */
  sessionId: number;
  accessMode: AccessMode;
  onAccessModeChange: (mode: AccessMode) => void;
  /** ＋扩展菜单（T7）：模式徽标数据源 + 专家/技能/连接器接线 */
  currentMode: SessionMode;
  currentAssistantId?: number;
  currentModelId?: number;
  /** 打开技能目录（ChatPane 复用齿轮菜单同款 handler） */
  onOpenSkills: () => void;
  /** 跳转连接器（MCP）管理页 */
  onOpenMcp: () => void;
  /** reject 即发送失败：输入与 chips 保留可重试（错误 toast 由调用链负责） */
  onSend: (
    content: string,
    files: PendingFile[],
    overrides?: ChatModelParams,
  ) => Promise<void>;
  onStop: () => void;
}

export default function ChatInput({
  hasModel,
  sending,
  sessionId,
  accessMode,
  onAccessModeChange,
  currentMode,
  currentAssistantId,
  currentModelId,
  onOpenSkills,
  onOpenMcp,
  onSend,
  onStop,
}: ChatInputProps) {
  const { t } = useTranslation(["chat", "ai"]);
  const [content, setContent] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
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

  /** ＋菜单选中的文件并入 chips（同路径去重，避免 chip key 冲突） */
  const handlePickFiles = useCallback((files: PendingFile[]) => {
    setPendingFiles((prev) => {
      const knownPaths = new Set(prev.map((file) => file.path));
      return [...prev, ...files.filter((file) => !knownPaths.has(file.path))];
    });
  }, []);

  /** 成功后才清空输入与 chips；失败（reject）保留可重试 */
  const submit = useCallback(async () => {
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
    try {
      await onSend(trimmed, pendingFiles, overrides);
      setContent("");
      setPendingFiles([]);
    } catch {
      /* 失败保留输入与 chips；错误提示由 onSend 链路（toast+rethrow）负责 */
    }
  }, [content, hasModel, sending, pendingFiles, onSend, buildOverrides, t]);

  const removeFile = useCallback((path: string) => {
    setPendingFiles((prev) => prev.filter((file) => file.path !== path));
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div
      data-testid="chat-input"
      className="flex min-w-0 flex-1 flex-col rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40"
    >
      {/* 上行：＋扩展菜单 + 权限胶囊 + 模式徽标（非默认模式时） */}
      <div className="flex items-center gap-2">
        <div data-plus-slot>
          <PlusMenu
            sessionId={sessionId}
            currentMode={currentMode}
            currentAssistantId={currentAssistantId}
            onPickFiles={handlePickFiles}
            onOpenSkills={onOpenSkills}
            onOpenMcp={onOpenMcp}
          />
        </div>
        <PermissionCapsule
          sessionId={sessionId}
          accessMode={accessMode}
          onChange={onAccessModeChange}
        />
        {currentMode !== "agent" && (
          <span className="text-xs text-muted-foreground">
            {currentMode === "ask" ? "ASK" : "PLAN"}
          </span>
        )}
      </div>
      {/* 中行：输入区（field-sizing 自适应，封顶 10 行左右） */}
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        autoFocus
        placeholder={t(
          hasModel ? "chat:input.placeholder" : "chat:input.modelRequired",
        )}
        className="mt-2 min-h-6 w-full resize-none overflow-y-auto bg-transparent text-sm field-sizing-content max-h-40 outline-none placeholder:text-muted-foreground"
      />
      {/* 引用文件 chips（有待引用时展示，可逐个移除） */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1 pt-2">
          {pendingFiles.map((file) => (
            <FileChip
              key={file.path}
              path={file.path}
              onRemove={() => removeFile(file.path)}
            />
          ))}
        </div>
      )}
      {/* 下行右：参数覆盖 + 模型 + 发送/停止 */}
      <div className="flex items-center justify-end gap-2 pt-2">
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
        <ModelPicker sessionId={sessionId} currentModelId={currentModelId} />
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
          <Button
            onClick={() => void submit()}
            disabled={!hasModel || content.trim() === ""}
          >
            <Send className="mr-1 h-4 w-4" />
            {t("chat:input.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
