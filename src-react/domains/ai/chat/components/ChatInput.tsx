/**
 * 卡片式输入框（P3 spec §1，P4 布局下移）：textarea 居首（@ 触发工作空间
 * 文件联想），引用文件 chips 暂存，下行左 ＋菜单/权限胶囊/模式徽标、
 * 右 模型选择 + 发送/停止
 * Enter 发送 / Shift+Enter 换行（IME 组合中的 Enter 不触发发送）
 * 发送中切换为停止按钮；未选模型时禁用发送并以占位符提示
 * 发送即清空（乐观），失败由 onSend 链路 toast 与消息流错误块兜底
 * @ 联想：光标前最近的 @token（[\w\-./]*）触发；↑↓ 移动、Enter 选中、Esc 关闭
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send, Sparkles, Square, X } from "lucide-react";

import { useCreateSkillPromptStore } from "../../skills/store/create-skill.store";
import SkillApi from "../../skills/api/skill.api";

import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/ipc";
import type { ChatModelParams } from "../../api/chat.api";
import type { SessionMode } from "../../api/session.api";
import ModelPicker from "./ModelPicker";
import PermissionCapsule, { type AccessMode } from "./PermissionCapsule";
import PlusMenu from "./PlusMenu";

/** 待引用文件/技能:＋菜单/@ 联想选取暂存于此,发送时随 onSend 带出(渲染层拼注入块) */
export interface PendingFile {
  /** 文件相对路径;kind="skill" 时为技能名 */
  path: string;
  content: string;
  /** 引用来源:工作空间文件(默认)或已安装技能 */
  kind?: "file" | "skill";
}

/** 路径尾段（跨平台分隔符），chips 展示用 */
function pathBasename(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : filePath;
}

/** @token 允许字符（@ 后连续输入的部分） */
const MENTION_TOKEN_RE = /[\w\-./]/;
const MENTION_LIMIT = 8;

/** @ 联想候选:已安装技能或工作空间文件 */
type MentionCandidate =
  { kind: "skill"; name: string } | { kind: "file"; path: string };

interface FileChipProps {
  path: string;
  kind?: "file" | "skill";
  onRemove: () => void;
}

/** 引用 chip:📎 文件 / ⚡ 技能 + 名称(title 悬浮全名)+ 移除按钮 */
function FileChip({ path, kind, onRemove }: FileChipProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <span className="inline-flex max-w-64 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      <span aria-hidden>{kind === "skill" ? "⚡" : "📎"}</span>
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

/** 光标前最近的 @token：返回 @ 起始下标与 token 文本；无有效 token 返回 null */
function detectMention(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  const token = upto.slice(at + 1);
  if (
    token.length > 0 &&
    ![...token].every((ch) => MENTION_TOKEN_RE.test(ch))
  ) {
    return null;
  }
  // @ 前必须是行首或空白（避免邮箱等误触）
  const prev = at > 0 ? upto[at - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: at, query: token };
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
  /** 工作空间（@ 联想数据源与文件读取）；未绑定为 null */
  workspaceId: number | null;
  /** 打开技能目录（ChatPane 复用同款 handler） */
  onOpenSkills: () => void;
  /** 跳转连接器（MCP）管理页 */
  onOpenMcp: () => void;
  /** 发送链路（错误 toast 由 ChatView toast+rethrow 负责，此处静默防双弹） */
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
  workspaceId,
  onOpenSkills,
  onOpenMcp,
  onSend,
  onStop,
}: ChatInputProps) {
  const { t } = useTranslation(["chat"]);
  const [content, setContent] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [mention, setMention] = useState<{
    startIndex: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const consumePendingPrompt = useCreateSkillPromptStore(
    (s) => s.consumePendingPrompt,
  );

  // 跨页预填(技能页「创建技能」入口):挂载时消费引导语填入输入框,
  // 预置技能引用读正文入 chips(如 skill-creator,模型免 read_skill 一跳)
  useEffect(() => {
    const { prompt, skillRefs } = consumePendingPrompt();
    if (prompt) {
      setContent(prompt);
      textareaRef.current?.focus();
    }
    for (const name of skillRefs) {
      SkillApi.readSkill(name)
        .then((result) =>
          handlePickFiles([
            { path: name, content: result.content, kind: "skill" },
          ]),
        )
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : String(e)),
        );
    }
  }, []);

  // 工作空间文件清单（@ 联想数据源；5 分钟内复用缓存;未绑定时不可用,技能候选不受影响）
  const workspaceFilesQuery = useQuery({
    queryKey: ["workspace-files", workspaceId],
    queryFn: () =>
      invoke<string[] | null>("file:listWorkspaceFiles", workspaceId),
    enabled: workspaceId !== null && mention !== null,
    staleTime: 300_000,
  });

  // 已安装技能（@ 联想技能候选;仅启用项对模型有意义）
  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    enabled: mention !== null,
    staleTime: 60_000,
  });

  // 联想候选:技能在前（数量少且常为目标,按名大小写不敏感匹配）,文件沿用
  // 「空 query 最短路径在前 / 非空 substring 匹配」,各自截断后合并
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!mention) {
      return [];
    }
    const query = mention.query.toLowerCase();
    const skills: MentionCandidate[] = (skillsQuery.data ?? [])
      .filter((r) => r.enabled)
      .filter((r) => !query || r.name.toLowerCase().includes(query))
      .slice(0, MENTION_LIMIT)
      .map((r) => ({ kind: "skill", name: r.name }));
    const files = workspaceFilesQuery.data;
    const fileCandidates: MentionCandidate[] = !files
      ? []
      : (query
          ? files.filter((file) => file.toLowerCase().includes(query))
          : [...files].sort((a, b) => a.length - b.length)
        )
          .slice(0, MENTION_LIMIT)
          .map((file) => ({ kind: "file", path: file }));
    return [...skills, ...fileCandidates];
  }, [mention, skillsQuery.data, workspaceFilesQuery.data]);

  // mention 或候选变化时收敛高亮越界
  const activeIndex = Math.min(
    highlightIndex,
    Math.max(mentionCandidates.length - 1, 0),
  );

  /** ＋菜单选中的文件并入 chips（同路径去重，避免 chip key 冲突） */
  const handlePickFiles = useCallback((files: PendingFile[]) => {
    setPendingFiles((prev) => {
      const knownPaths = new Set(prev.map((file) => file.path));
      return [...prev, ...files.filter((file) => !knownPaths.has(file.path))];
    });
  }, []);

  /**
   * 乐观清空：发送即清输入与 chips（Claude Code 同款行为）。
   * onSend 在整个流结束后才 resolve（chat:send invoke 的既有语义），
   * 若挂 await 后清空会导致生成期间输入一直残留。
   * 早期失败（会话不存在等）由 onSend 链路 toast + 消息流错误块兜底
   */
  const submit = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed || !hasModel || sending) {
      return;
    }
    setContent("");
    setPendingFiles([]);
    setMention(null);
    void onSend(trimmed, pendingFiles).catch(() => {
      /* 错误提示由 onSend 链路（toast+rethrow）与持久化错误块负责 */
    });
  }, [content, hasModel, sending, pendingFiles, onSend]);

  const removeFile = useCallback((path: string) => {
    setPendingFiles((prev) => prev.filter((file) => file.path !== path));
  }, []);

  /** @ 选中：删除 token 文本 → 读内容入 chips（技能走 skill:readSkill，文件读工作空间）；读取失败 toast 且保留 @ 文本 */
  const selectMention = useCallback(
    async (candidate: MentionCandidate) => {
      if (!mention) {
        return;
      }
      const textarea = textareaRef.current;
      const caret =
        textarea?.selectionStart ??
        mention.startIndex + 1 + mention.query.length;
      const next =
        content.slice(0, mention.startIndex) +
        content.slice(
          Math.min(caret, mention.startIndex + 1 + mention.query.length),
        );
      try {
        if (candidate.kind === "skill") {
          const result = await SkillApi.readSkill(candidate.name);
          handlePickFiles([
            {
              path: candidate.name,
              content: result.content,
              kind: "skill",
            },
          ]);
          setContent(next);
          setMention(null);
          return;
        }
        const result = await invoke<{ content: string } | { error: string }>(
          "file:readWorkspaceFile",
          workspaceId,
          candidate.path,
        );
        if ("error" in result) {
          toast.error(
            t("chat:attach.readFailed", {
              path: candidate.path,
              reason: result.error,
            }),
          );
          return;
        }
        handlePickFiles([{ path: candidate.path, content: result.content }]);
        setContent(next);
        setMention(null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [mention, content, workspaceId, handlePickFiles, t],
  );

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setContent(value);
    const next = detectMention(value, event.target.selectionStart);
    setMention(next);
    if (next) {
      setHighlightIndex(0);
    }
  };

  // 光标移动（←→/Home/End/点击）不触发 onChange——在 keyup/select 上重算 mention，
  // 光标离开 @token 即关闭弹窗，避免 Enter 被残留弹窗劫持
  const syncMentionFromCaret = (target: HTMLTextAreaElement) => {
    setMention(detectMention(target.value, target.selectionStart));
  };

  const handleSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (mention !== null) {
      syncMentionFromCaret(event.currentTarget);
    }
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 导航键由 onKeyDown 消费并 preventDefault，不会到达这里；
    // 其余可移动光标的键（Home/End 等）在此重算
    if (
      mention !== null &&
      ["Home", "End", "PageUp", "PageDown"].includes(event.key)
    ) {
      syncMentionFromCaret(event.currentTarget);
    }
  };

  const handleBlur = () => {
    // 点击弹窗外失焦：关闭（点击候选项的 mousedown 已 preventDefault 不触发）
    setMention(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // @ 联想激活时优先消费导航键
    if (mention) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex(
          (activeIndex + 1) % Math.max(mentionCandidates.length, 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex(
          (activeIndex - 1 + Math.max(mentionCandidates.length, 1)) %
            Math.max(mentionCandidates.length, 1),
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        const candidate = mentionCandidates[activeIndex];
        if (candidate) {
          event.preventDefault();
          void selectMention(candidate);
          return;
        }
        // 无候选时 Enter 不发送，交由用户删掉 @ 或继续输入
        event.preventDefault();
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  const showMentionList = mention !== null;
  const workspaceUnbound = workspaceId === null;
  const noCandidates = mention !== null && mentionCandidates.length === 0;

  return (
    <div
      data-testid="chat-input"
      className="relative flex min-w-0 flex-1 flex-col rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40"
    >
      {/* @ 联想下拉（向上弹出；未绑定工作空间/无匹配给出提示文案） */}
      {showMentionList && (
        <div className="absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-lg border border-border/50 bg-card shadow-lg">
          {workspaceUnbound ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chat:mention.needBind")}
            </p>
          ) : noCandidates ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chat:mention.noFiles")}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {mentionCandidates.map((candidate, index) => (
                <li
                  key={`${candidate.kind}:${candidate.kind === "skill" ? candidate.name : candidate.path}`}
                >
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      // mousedown 先于 blur/发送键处理，阻止默认避免失焦
                      event.preventDefault();
                      void selectMention(candidate);
                    }}
                    onMouseEnter={() => setHighlightIndex(index)}
                    className={`flex w-full items-center gap-1.5 truncate px-2 py-1.5 text-left text-xs ${
                      index === activeIndex
                        ? "bg-primary-subtle text-primary"
                        : "text-foreground"
                    }`}
                  >
                    {candidate.kind === "skill" ? (
                      <>
                        <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{candidate.name}</span>
                      </>
                    ) : (
                      <span className="truncate">{candidate.path}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* 输入区（field-sizing 自适应，封顶 10 行左右） */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onSelect={handleSelect}
        onBlur={handleBlur}
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
              kind={file.kind}
              onRemove={() => removeFile(file.path)}
            />
          ))}
        </div>
      )}
      {/* 下行：左 ＋菜单 + 权限胶囊 + 模式徽标，右 模型 + 发送/停止 */}
      <div className="flex items-center pt-2">
        <div className="flex items-center gap-2">
          <PlusMenu
            sessionId={sessionId}
            currentMode={currentMode}
            currentAssistantId={currentAssistantId}
            onPickFiles={handlePickFiles}
            onOpenSkills={onOpenSkills}
            onOpenMcp={onOpenMcp}
          />
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
        <div className="ml-auto flex items-center gap-2">
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
              onClick={submit}
              disabled={!hasModel || content.trim() === ""}
            >
              <Send className="mr-1 h-4 w-4" />
              {t("chat:input.send")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
