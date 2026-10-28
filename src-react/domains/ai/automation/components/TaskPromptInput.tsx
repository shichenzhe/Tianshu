/**
 * 任务提示词输入卡(spec §1):ChatInput 交互骨架的无会话态变体——
 * textarea + 镜像层 pill(@文件/⚡技能 token)、@/⚡ 联想面板
 * (不支持 / 命令)、下行 +菜单/只读权限胶囊/模型选择。
 * 受控组件;Enter 换行(联想激活时 Enter 选中候选)。
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { Sparkles } from "lucide-react";

import SkillApi from "../../skills/api/skill.api";
import { renderTokenSegments } from "../../chat/lib/inline-tokens";
import PermissionCapsule from "../../chat/components/PermissionCapsule";
import TaskModelPicker from "./TaskModelPicker";
import TaskPlusMenu from "./TaskPlusMenu";

/** @token 允许字符(照 ChatInput) */
const MENTION_TOKEN_RE = /[\w\-./]/;
const MENTION_LIMIT = 8;

type SuggestCandidate =
  { kind: "skill"; name: string } | { kind: "file"; path: string };

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
  const prev = at > 0 ? upto[at - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: at, query: token };
}

/** ⚡ 触发检测(光标前最近,前须行首/空白) */
function detectSkillTrigger(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const idx = upto.lastIndexOf("⚡");
  if (idx === -1) {
    return null;
  }
  const token = upto.slice(idx + 1);
  if (token.length > 0 && !/^[\w-]*$/.test(token)) {
    return null;
  }
  const prev = idx > 0 ? upto[idx - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: idx, query: token };
}

export interface TaskPromptInputProps {
  value: string;
  onChange: (v: string) => void;
  workspaceId: number | null;
  modelId?: number;
  onModelChange: (id: number) => void;
  onOpenMcp: () => void;
  placeholder: string;
}

export default function TaskPromptInput({
  value,
  onChange,
  workspaceId,
  modelId,
  onModelChange,
  onOpenMcp,
  placeholder,
}: TaskPromptInputProps) {
  const { t } = useTranslation(["chat"]);
  const [suggest, setSuggest] = useState<{
    type: "at" | "skill";
    startIndex: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const workspaceFilesQuery = useQuery({
    queryKey: ["workspace-files", workspaceId],
    queryFn: () =>
      invoke<string[] | null>("file:listWorkspaceFiles", workspaceId),
    enabled: workspaceId !== null && suggest?.type === "at",
    staleTime: 300_000,
  });
  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });

  const suggestCandidates = useMemo<SuggestCandidate[]>(() => {
    if (!suggest) {
      return [];
    }
    const query = suggest.query.toLowerCase();
    if (suggest.type === "skill") {
      return (skillsQuery.data ?? [])
        .filter((r) => r.enabled)
        .filter((r) => !query || r.name.toLowerCase().includes(query))
        .slice(0, MENTION_LIMIT)
        .map((r) => ({ kind: "skill" as const, name: r.name }));
    }
    const files = workspaceFilesQuery.data;
    if (!files) {
      return [];
    }
    return (
      query
        ? files.filter((f) => f.toLowerCase().includes(query))
        : [...files].sort((a, b) => a.length - b.length)
    )
      .slice(0, MENTION_LIMIT)
      .map((f) => ({ kind: "file" as const, path: f }));
  }, [suggest, skillsQuery.data, workspaceFilesQuery.data]);

  const activeIndex = Math.min(
    highlightIndex,
    Math.max(suggestCandidates.length - 1, 0),
  );

  /** 在光标处插入 token(替换触发片段),光标落在 token 后 */
  const insertAtCaret = useCallback(
    (token: string) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? value.length;
      const next = `${value.slice(0, caret)}${token}${value.slice(caret)}`;
      onChange(next);
      setSuggest(null);
      requestAnimationFrame(() => {
        const pos = caret + token.length;
        textarea?.focus();
        textarea?.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );

  const selectCandidate = useCallback(
    (candidate: SuggestCandidate) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? value.length;
      const end = suggest
        ? Math.min(caret, suggest.startIndex + 1 + suggest.query.length)
        : caret;
      const token =
        candidate.kind === "file"
          ? `@${candidate.path} `
          : `⚡${candidate.name} `;
      const next =
        value.slice(0, suggest ? suggest.startIndex : caret) +
        token +
        value.slice(end);
      onChange(next);
      setSuggest(null);
      requestAnimationFrame(() => {
        const pos = (suggest ? suggest.startIndex : caret) + token.length;
        textarea?.focus();
        textarea?.setSelectionRange(pos, pos);
      });
    },
    [value, suggest, onChange],
  );

  const syncSuggestFromCaret = (target: HTMLTextAreaElement) => {
    const skill = detectSkillTrigger(target.value, target.selectionStart);
    const mention = skill
      ? null
      : detectMention(target.value, target.selectionStart);
    setSuggest(
      skill
        ? { type: "skill", ...skill }
        : mention
          ? { type: "at", ...mention }
          : null,
    );
  };

  // 光标移动(←→/Home/End/点击)不触发 onChange——在 keyup/select 上重算,
  // 光标离开触发片段即关闭面板(守卫照 ChatInput:仅面板已开时重算)
  const handleSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (suggest !== null) {
      syncSuggestFromCaret(event.currentTarget);
    }
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      suggest !== null &&
      ["Home", "End", "PageUp", "PageDown"].includes(event.key)
    ) {
      syncSuggestFromCaret(event.currentTarget);
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = event.target.value;
    onChange(v);
    const caret = event.target.selectionStart;
    const skill = detectSkillTrigger(v, caret);
    const mention = skill ? null : detectMention(v, caret);
    const next = skill
      ? { type: "skill" as const, ...skill }
      : mention
        ? { type: "at" as const, ...mention }
        : null;
    setSuggest(next);
    if (next) {
      setHighlightIndex(0);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex(
          (activeIndex + 1) % Math.max(suggestCandidates.length, 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex(
          (activeIndex - 1 + Math.max(suggestCandidates.length, 1)) %
            Math.max(suggestCandidates.length, 1),
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSuggest(null);
        return;
      }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const candidate = suggestCandidates[activeIndex];
        if (candidate) {
          selectCandidate(candidate);
        }
        return;
      }
    }
    // 表单态:Enter 不提交(Dilog 确定按钮负责),交默认换行
  };

  const segments = useMemo(() => renderTokenSegments(value), [value]);
  const showSuggestList = suggest !== null;
  const noBind = suggest?.type === "at" && workspaceId === null;
  const noCandidates = suggest !== null && suggestCandidates.length === 0;

  return (
    <div className="relative flex flex-col rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40">
      {showSuggestList && (
        <div className="absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-lg border border-border/50 bg-card shadow-lg">
          {noBind ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chat:mention.needBind")}
            </p>
          ) : noCandidates ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chat:mention.noFiles")}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {suggestCandidates.map((candidate, index) => (
                <li
                  key={`${candidate.kind}:${candidate.kind === "file" ? candidate.path : candidate.name}`}
                >
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectCandidate(candidate);
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
      <div className="relative mt-2">
        <div
          ref={mirrorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 max-h-56 overflow-hidden border-0 p-0 whitespace-pre-wrap break-words text-sm leading-relaxed"
        >
          {segments.map((segment, index) =>
            segment.isToken ? (
              <span
                key={index}
                className="rounded-md bg-primary-subtle px-0 py-0.5 text-primary"
              >
                {segment.text}
              </span>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onKeyUp={handleKeyUp}
          onBlur={() => setSuggest(null)}
          onScroll={() => {
            if (mirrorRef.current && textareaRef.current) {
              mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
            }
          }}
          rows={3}
          placeholder={placeholder}
          className="relative min-h-20 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-relaxed field-sizing-content max-h-56 outline-none text-transparent caret-foreground placeholder:text-muted-foreground [&::-webkit-scrollbar]:hidden"
        />
      </div>
      <div className="flex items-center pt-2">
        <div className="flex items-center gap-2">
          <TaskPlusMenu
            onPickPaths={(paths) => {
              // 批量一次拼接:循环 insertAtCaret 会因闭包读到过期 value,
              // 多选 2+ 文件仅落最后一个
              const suffix = paths.map((p) => `@${p} `).join("");
              const textarea = textareaRef.current;
              const caret = textarea?.selectionStart ?? value.length;
              onChange(
                `${value.slice(0, caret)}${suffix}${value.slice(caret)}`,
              );
              requestAnimationFrame(() => {
                const pos = caret + suffix.length;
                textarea?.focus();
                textarea?.setSelectionRange(pos, pos);
              });
            }}
            onOpenMcp={onOpenMcp}
            onInsertVariable={(token) => insertAtCaret(token)}
          />
          <PermissionCapsule
            sessionId={-1}
            accessMode="full"
            onChange={() => {
              /* 只读展示:点击弹 FullAccessModal 说明后维持 full */
            }}
          />
        </div>
        <div className="ml-auto">
          <TaskModelPicker modelId={modelId} onChange={onModelChange} />
        </div>
      </div>
    </div>
  );
}
