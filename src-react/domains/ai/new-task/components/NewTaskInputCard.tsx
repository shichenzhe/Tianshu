/**
 * 新建任务输入卡（spec §4）：纯 textarea + 上方引用 pill 行 + 底部工具栏
 * （无镜像层——引用以 pending pill 呈现，不留在输入流）。@ 触发文件联想
 * 面板（工作空间文件 substring 匹配 + 资料库跨层搜索两组候选，技能不进
 * @ 面板——技能引用经胶囊/QuickMenu）；↑↓/Enter/Esc 键盘语义与
 * ChatInput:564-603 一致；选中转 pending 并从文本删除 @query 片段。拖拽
 * 本地文件经 getPathForFile 取绝对路径入 pending（readExternalFile 校验）。
 * Enter→onSubmit（面板激活时除外）发送矩阵（spec §6）：空文本/敏感词命中/
 * 未绑空间/无可用模型/发送中——按矩阵置灰且 Enter 不触发；敏感词与无模型
 * 提示文案渲染于发送按钮旁
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Bot, Send, X, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MENTION_LIMIT, detectMention } from "../../chat/lib/inline-tokens";
import AssistantApi from "../../api/assistant.api";
import LibraryApi from "../../library/api/library.api";
import { MODES } from "../../chat/components/PlusMenu";
import { checkSensitive } from "../lib/sensitive-check";
import { useLocalFileAttach } from "../hooks/use-local-file-attach";
import { useWorkspaceFiles } from "../hooks/use-workspace-files";
import { useNewTaskStore } from "../store/new-task-store";
import AttachMenu from "./AttachMenu";
import PolishButton from "./polish-button";
import QuickMenu from "./QuickMenu";

/** @ 联想候选：工作空间文件 + 资料库文件（分组渲染，选中转 pending） */
interface MentionCandidate {
  label: string;
  ref: string;
  kind: "file" | "localFile";
  group: "workspace" | "library";
}

interface NewTaskInputCardProps {
  /** 矩阵放行后由 Enter/发送按钮触发（NewTaskView 绑 dispatch 编排） */
  onSubmit?: () => void;
  /** 可用模型判定（ModelPicker 同口径，NewTaskView 双查询后传入）；缺省 true 保持独立渲染可用 */
  hasUsableModel?: boolean;
  /** 发送进行中（防重复提交）；缺省 false */
  sending?: boolean;
  /** 外部光标控制锚点（NewTaskView 模板胶囊填充后聚焦置选区）；缺省不外接 */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export default function NewTaskInputCard({
  onSubmit,
  hasUsableModel = true,
  sending = false,
  inputRef,
}: NewTaskInputCardProps) {
  const { t } = useTranslation(["newTask", "chat"]);
  const content = useNewTaskStore((s) => s.content);
  const setContent = useNewTaskStore((s) => s.setContent);
  const pending = useNewTaskStore((s) => s.pending);
  const addPending = useNewTaskStore((s) => s.addPending);
  const removePending = useNewTaskStore((s) => s.removePending);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const mode = useNewTaskStore((s) => s.mode);
  const assistantId = useNewTaskStore((s) => s.assistantId);
  const setAssistantId = useNewTaskStore((s) => s.setAssistantId);
  const addLocalFile = useLocalFileAttach();

  // 专家名徽章：+ 菜单草稿选中态的可见反馈（ExpertSubMenu 同缓存键
  // ["assistants"]，与专家子菜单共享查询缓存）
  const assistantsQuery = useQuery({
    queryKey: ["assistants"],
    queryFn: () => AssistantApi.list(),
  });
  const assistantName = useMemo(
    () => (assistantsQuery.data ?? []).find((a) => a.id === assistantId)?.name,
    [assistantsQuery.data, assistantId],
  );
  const modeLabelKey = MODES.find((m) => m.value === mode)?.labelKey;
  const [suggest, setSuggest] = useState<{
    startIndex: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // @ 联想数据源：suggest 激活时拉取（按 workspaceId 缓存）；未绑定空间
  // （null）不拉取——面板不可用，Enter 按普通输入提交
  const workspaceFiles = useWorkspaceFiles(workspaceId, suggest !== null);

  // 资料库候选：suggest 激活时按 query 跨层搜索（空 query 后端返 []，
  // bare @ 不出资料库组）
  const libraryQuery = useQuery({
    queryKey: ["librarySearch", suggest?.query ?? ""],
    queryFn: () => LibraryApi.search(suggest?.query ?? ""),
    enabled: suggest !== null,
  });
  const suggestCandidates = useMemo<MentionCandidate[]>(() => {
    if (!suggest || !workspaceFiles) {
      return [];
    }
    const query = suggest.query.toLowerCase();
    const workspace: MentionCandidate[] = workspaceFiles
      .filter((file) => file.toLowerCase().includes(query))
      .slice(0, MENTION_LIMIT)
      .map((file) => ({
        label: file,
        ref: file,
        kind: "file",
        group: "workspace",
      }));
    const library: MentionCandidate[] = (libraryQuery.data ?? [])
      .slice(0, MENTION_LIMIT)
      .map((item) => ({
        label: item.name,
        ref: item.storagePath ?? "",
        kind: "localFile",
        group: "library",
      }));
    return [...workspace, ...library];
  }, [suggest, workspaceFiles, libraryQuery.data]);

  const activeIndex = Math.min(
    highlightIndex,
    Math.max(suggestCandidates.length - 1, 0),
  );

  // 面板激活（键盘劫持判据）：@ 片段中且已绑工作空间；清单加载中/无匹配
  // 面板给出无匹配提示（同 ChatInput 语义，Enter 不被劫持提交）
  const panelActive = suggest !== null && workspaceId !== null;
  const showSuggestList = panelActive;

  /** 面板选中：候选转 pending pill（file=工作空间相对路径，localFile=库内绝对路径），并从文本删除 @query 触发片段 */
  const selectCandidate = (candidate: MentionCandidate) => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? content.length;
    const fragmentEnd = suggest
      ? Math.min(caret, suggest.startIndex + 1 + suggest.query.length)
      : caret;
    const startIndex = suggest ? suggest.startIndex : caret;
    setContent(
      content.slice(0, startIndex) +
        content.slice(Math.max(fragmentEnd, startIndex)),
    );
    setSuggest(null);
    addPending({
      label: candidate.label,
      ref: candidate.ref,
      kind: candidate.kind,
    });
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(startIndex, startIndex);
    });
  };

  // 发送矩阵（spec §6）：敏感词对草稿全文预检（与 dispatch 同词表）
  const sensitiveHit = useMemo(() => checkSensitive(content), [content]);
  const sendDisabled =
    !content.trim() ||
    sensitiveHit !== null ||
    workspaceId === null ||
    !hasUsableModel ||
    sending;

  const submit = () => {
    if (sendDisabled) {
      return;
    }
    onSubmit?.();
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setContent(value);
    const mention = detectMention(value, event.target.selectionStart);
    setSuggest(mention);
    if (mention) {
      setHighlightIndex(0);
    }
  };

  // 光标移动（←→/Home/End/点击）不触发 onChange——在 select/keyup 上重算,
  // 光标离开触发片段即关闭面板，避免 Enter 被残留面板劫持
  const syncSuggestFromCaret = (target: HTMLTextAreaElement) => {
    const mention = detectMention(target.value, target.selectionStart);
    setSuggest(mention);
  };

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

  const handleBlur = () => {
    // 点击面板外失焦：关闭（点击候选项的 mousedown 已 preventDefault 不触发）
    setSuggest(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 面板激活时优先消费导航键
    if (panelActive) {
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
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        const candidate = suggestCandidates[activeIndex];
        event.preventDefault();
        // 无候选时 Enter 不提交，交由用户删掉触发符或继续输入
        if (candidate) {
          selectCandidate(candidate);
        }
        return;
      }
    }
    // IME 组合中的 Enter 仅确认候选，不提交
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  /** 拖拽本地文件：getPathForFile 取绝对路径 → 校验入 pending（失败 toast） */
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    for (const file of Array.from(event.dataTransfer.files)) {
      const absPath = window.filePath.getPathForFile(file);
      void addLocalFile(absPath);
    }
  };

  return (
    <div
      data-testid="new-task-input-card"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
      className="relative rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40"
    >
      {/* 联想面板（向上弹出；清单加载完成前不显示，无匹配给出提示文案） */}
      {showSuggestList && (
        <div
          data-testid="mention-panel"
          className="absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-lg border border-border/50 bg-card shadow-lg"
        >
          {suggestCandidates.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("newTask:attach.noFiles")}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {suggestCandidates.map((candidate, index) => (
                <li key={candidate.ref}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      // mousedown 先于 blur/提交键处理，阻止默认避免失焦
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
                    {/* 分组小标签：工作空间文件 / 资料库 */}
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {candidate.group === "library"
                        ? t("chat:library.groupLibrary")
                        : t("chat:library.groupWorkspace")}
                    </span>
                    <span className="truncate">{candidate.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* 引用 pill 行 */}
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1">
          {pending.map((ref) => (
            <span
              key={ref.ref}
              className="mb-1 inline-flex max-w-48 items-center gap-1 rounded-full border border-border/50 bg-primary-subtle px-2 py-0.5 text-[10px] text-primary"
            >
              {ref.kind === "skill" && <Zap className="h-2.5 w-2.5" />}
              <span className="truncate">{ref.label}</span>
              <button
                type="button"
                aria-label={ref.label}
                title={ref.label}
                onClick={() => removePending(ref.ref)}
                className="shrink-0"
              >
                <X className="h-2.5 w-2.5 opacity-60 hover:opacity-100" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        // 内部 textareaRef（联想面板选区回写）与外部 inputRef（NewTaskView
        // 模板胶囊光标控制）合并挂载
        ref={(node) => {
          textareaRef.current = node;
          if (inputRef) {
            inputRef.current = node;
          }
        }}
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onSelect={handleSelect}
        onBlur={handleBlur}
        placeholder={t("newTask:inputPlaceholder")}
        className="min-h-24 w-full resize-none border-0 bg-transparent p-0 text-sm leading-relaxed field-sizing-content max-h-[50vh] outline-none placeholder:text-muted-foreground"
      />
      {/* 字数（textarea 下右对齐）：>1800 才显示（Math.min 封顶 2000）；
          ≥2000 追加红字截断提示 */}
      {content.length > 1800 && (
        <div className="flex items-center justify-end gap-1.5 pt-0.5 text-xs text-muted-foreground">
          <span>
            {t("newTask:charCount", {
              current: String(Math.min(content.length, 2000)),
            })}
          </span>
          {content.length >= 2000 && (
            <span className="text-destructive">
              {t("newTask:truncateHint")}
            </span>
          )}
        </div>
      )}
      {/* 底部工具栏：左 ＋引用菜单 + 草稿选中态徽章（专家名可清除、
          非 agent 模式——ChatInput 底行 assistantName/ASK|PLAN 同形态）；
          右 敏感词/模型提示 + 魔法棒/快速 + 发送 */}
      <div className="flex items-center pt-2">
        <AttachMenu />
        {assistantName && (
          <span className="ml-1 inline-flex max-w-40 items-center gap-1 rounded-full border border-border/50 bg-primary-subtle px-2 py-0.5 text-[10px] text-primary">
            <Bot className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{assistantName}</span>
            <button
              type="button"
              aria-label={t("newTask:attach.clearExpert")}
              title={t("newTask:attach.clearExpert")}
              onClick={() => setAssistantId(null)}
              className="shrink-0"
            >
              <X className="h-2.5 w-2.5 opacity-60 hover:opacity-100" />
            </button>
          </span>
        )}
        {mode !== "agent" && modeLabelKey && (
          <span className="ml-1 rounded-full border border-primary/30 bg-primary-subtle px-2 py-0.5 text-[10px] font-medium text-primary">
            {t(modeLabelKey)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {sensitiveHit !== null && (
            <span className="text-destructive text-xs">
              {t("newTask:sensitiveHit", { word: sensitiveHit })}
            </span>
          )}
          {!hasUsableModel && (
            <span className="text-xs text-muted-foreground">
              {t("newTask:modelRequired")}
            </span>
          )}
          <PolishButton />
          <QuickMenu />
          <Button
            size="sm"
            onClick={submit}
            disabled={sendDisabled}
            aria-label={t("newTask:send")}
            title={t("newTask:send")}
            className="h-8 w-8 shrink-0 rounded-full p-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
