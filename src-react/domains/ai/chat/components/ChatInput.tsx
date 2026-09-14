/**
 * 卡片式输入框(P3 spec §1):textarea(文字与内联引用 token 交叉)居首,
 * 下行左 ＋菜单/权限胶囊/模式徽标、右 模型选择 + 发送/停止。
 * 引用即文字:@ 文件 / ⚡技能 / /命令 / #待办 以 token 形式留在输入流中,
 * 镜像层渲染 pill 高亮(textarea 文字透明),chips 机制已移除;#待办 的
 * 标题映射经输入区下方"已引用"chips 行可见(pill 正文保留 token 原文)。
 * 发送:命令 token 移出执行(onRunCommand);文件/技能/待办 token 读内容
 * 随 onSend 注入(消息文本保留 token 原样)。
 * 触发器:@ 文件、/ 命令+技能、# 待办(todoItems 传入时启用——项目底栏
 * 注入计划事项,AI 模块 ChatPane 不传则 # 无联想行为不变);
 * ↑↓ 移动、Enter 选中、Esc 关闭;
 * 发送/换行读快捷键生效绑定(默认 Enter 发送、Shift+Enter 换行;
 * IME 组合中的 Enter 不触发)
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ListTodo,
  Send,
  Sparkles,
  Square,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";

import { useCreateSkillPromptStore } from "../../skills/store/create-skill.store";
import SkillApi from "../../skills/api/skill.api";
import AssistantApi from "../../api/assistant.api";
import { mapIpcError } from "../lib/error-message";

import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/ipc";
import { detectPlatform } from "@/lib/keybindings";
import {
  currentBindings,
  eventMatchesBinding,
} from "@/lib/keybindings/dispatcher";
import type { ChatModelParams } from "../../api/chat.api";
import type { SessionMode } from "../../api/session.api";
import {
  SLASH_COMMANDS,
  detectSlash,
  parseInlineTokens,
  renderTokenSegments,
  stripCommandTokens,
} from "../lib/inline-tokens";
import type { PendingFile } from "../lib/pending-file";
import ModelPicker from "./ModelPicker";
import ContextUsageButton from "./context-usage-button";
import PermissionCapsule, { type AccessMode } from "./PermissionCapsule";
import PlusMenu, { type LocalTaskToggle } from "./PlusMenu";

/** @token 允许字符（@ 后连续输入的部分） */
const MENTION_TOKEN_RE = /[\w\-./]/;
const MENTION_LIMIT = 8;

/** 联想候选:命令 / 技能 / 文件 / 待办 */
type SuggestCandidate =
  | { kind: "command"; name: string }
  | { kind: "skill"; name: string }
  | { kind: "file"; path: string }
  | { kind: "todo"; id: number; title: string };

/** 项目待办引用数据源(计划事项记录;ProjectChatBar 注入,AI 模块不传) */
interface TodoSuggestItem {
  id: number;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
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
  /** 工作空间（@ 文件联想与读取）；未绑定为 null */
  workspaceId: number | null;
  /** 项目动态流：仅展示已挂载专家；未传不过滤（AI 模块行为不变） */
  boundAssistantIds?: number[];
  /** 项目动态流：仅展示已挂载技能（skillRecord.name 匹配） */
  boundSkillNames?: string[];
  /** 项目待办引用（# 联想数据源）；缺省不启用 # 触发（AI 模块行为不变） */
  todoItems?: TodoSuggestItem[];
  /** 项目底栏本地任务开关（T8）：透传 ＋菜单开关项；缺省不渲染（AI 模块行为不变） */
  localTask?: LocalTaskToggle;
  /** 跳转连接器（MCP）管理页 */
  onOpenMcp: () => void;
  /** 斜杠命令执行(/compact 等);ChatView 接压缩等实现 */
  onRunCommand: (command: string) => void;
  /** 发送链路（错误 toast 由 ChatView toast+rethrow 负责，此处静默防双弹） */
  onSend: (
    content: string,
    files: PendingFile[],
    overrides?: ChatModelParams,
  ) => Promise<void>;
  onStop: () => void;
  /** 自定义占位文案（项目底栏传项目文案）；缺省沿用 chat 默认（AI 模块不变） */
  placeholder?: string;
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

/**
 * 光标前最近的 #todo 触发片段：# 起始下标与标题过滤词（任意字符，
 * 含 CJK——待办标题非 ASCII 词法）；# 后出现空白即片段结束返回 null
 */
function detectTodo(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const hash = upto.lastIndexOf("#");
  if (hash === -1) {
    return null;
  }
  const query = upto.slice(hash + 1);
  if (/\s/.test(query)) {
    return null;
  }
  // # 前必须是行首或空白（避免 Markdown 标题等误触）
  const prev = hash > 0 ? upto[hash - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: hash, query };
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
  boundAssistantIds,
  boundSkillNames,
  todoItems,
  localTask,
  onOpenMcp,
  onRunCommand,
  onSend,
  onStop,
  placeholder,
}: ChatInputProps) {
  const { t } = useTranslation(["chat"]);
  const [content, setContent] = useState("");
  const [suggest, setSuggest] = useState<{
    type: "at" | "slash" | "todo";
    startIndex: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const consumePendingPrompt = useCreateSkillPromptStore(
    (s) => s.consumePendingPrompt,
  );

  // 跨页预填(技能页「创建技能」入口):挂载时消费引导语与预置技能引用,
  // 以内联 token 形式进入输入流(尾随空格避免吞并后续输入)
  useEffect(() => {
    const { prompt, skillRefs } = consumePendingPrompt();
    if (prompt || skillRefs.length > 0) {
      const tokens = skillRefs.map((name) => `⚡${name} `).join("");
      setContent(`${prompt ?? ""}${tokens ? ` ${tokens}` : ""}`.trim());
      textareaRef.current?.focus();
    }
  }, []);

  // 工作空间文件清单（@ 文件联想数据源；5 分钟内复用缓存;未绑定时不可用）
  const workspaceFilesQuery = useQuery({
    queryKey: ["workspace-files", workspaceId],
    queryFn: () =>
      invoke<string[] | null>("file:listWorkspaceFiles", workspaceId),
    enabled: workspaceId !== null && suggest !== null,
    staleTime: 300_000,
  });

  // 已安装技能（/ 面板候选 + 输入框启用标签行；与＋菜单技能浮层共享缓存）
  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });
  const enabledSkills = (skillsQuery.data ?? []).filter((r) => r.enabled);

  // 当前专家名（徽章展示；与专家子菜单共享缓存）
  const assistantsQuery = useQuery({
    queryKey: ["assistants"],
    queryFn: () => AssistantApi.list(),
    staleTime: 60_000,
  });
  const assistantName = assistantsQuery.data?.find(
    (a) => a.id === currentAssistantId,
  )?.name;

  // 联想候选:slash 面板 = 命令(SLASH_COMMANDS)+ 技能(名匹配,在前);
  // at 面板 = 文件(空 query 最短路径在前 / 非空 substring 匹配);
  // todo 面板 = 待办(标题大小写不敏感 substring 匹配,同面板上限)
  const suggestCandidates = useMemo<SuggestCandidate[]>(() => {
    if (!suggest) {
      return [];
    }
    const query = suggest.query.toLowerCase();
    if (suggest.type === "slash") {
      const commands: SuggestCandidate[] = SLASH_COMMANDS.filter(
        (cmd) => !query || cmd.includes(query),
      ).map((cmd) => ({ kind: "command", name: cmd }));
      const skills: SuggestCandidate[] = (skillsQuery.data ?? [])
        .filter((r) => r.enabled)
        .filter((r) => !query || r.name.toLowerCase().includes(query))
        .slice(0, MENTION_LIMIT)
        .map((r) => ({ kind: "skill", name: r.name }));
      return [...commands, ...skills];
    }
    if (suggest.type === "todo") {
      return (todoItems ?? [])
        .filter((item) => !query || item.title.toLowerCase().includes(query))
        .slice(0, MENTION_LIMIT)
        .map((item) => ({
          kind: "todo" as const,
          id: item.id,
          title: item.title,
        }));
    }
    const files = workspaceFilesQuery.data;
    if (!files) {
      return [];
    }
    return (
      query
        ? files.filter((file) => file.toLowerCase().includes(query))
        : [...files].sort((a, b) => a.length - b.length)
    )
      .slice(0, MENTION_LIMIT)
      .map((file) => ({ kind: "file" as const, path: file }));
  }, [suggest, skillsQuery.data, workspaceFilesQuery.data, todoItems]);

  // 待办标题映射:#<id> → 待办标题(已引用 chips 行数据源)
  const todoTitleById = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of todoItems ?? []) {
      map.set(item.id, item.title);
    }
    return map;
  }, [todoItems]);

  // 面板或候选变化时收敛高亮越界
  const activeIndex = Math.min(
    highlightIndex,
    Math.max(suggestCandidates.length - 1, 0),
  );

  // todo 面板无候选时不弹出（todoItems 空项目/无匹配均静默——区别于
  // at/slash 的"无匹配文件"提示文案，避免跨语义复用）；at/slash 恒等
  // 于 suggest 非空，键处理按本值门控——todo 无候选时 Enter 不被劫持
  const showSuggestList =
    suggest !== null &&
    (suggest.type !== "todo" || suggestCandidates.length > 0);

  /**
   * 光标处插入换行（换行命令命中时统一手工插行：绑定带修饰键时浏览器
   * 默认不插入，手工插入保证任意绑定行为一致；选中区间被替换）
   */
  const insertNewline = useCallback(() => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? content.length;
    const end = textarea?.selectionEnd ?? start;
    setContent(`${content.slice(0, start)}\n${content.slice(end)}`);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + 1, start + 1);
    });
  }, [content]);

  /** 标签行点击移除 = 禁用技能（与＋菜单技能浮层同口径） */
  const handleDisableSkill = async (name: string) => {
    try {
      await SkillApi.setEnabled(name, false);
      await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 在光标处插入 token 文本(替换正在输入的触发片段),光标落在 token 后空格 */
  const insertAtCaret = useCallback(
    (token: string) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? content.length;
      const next = `${content.slice(0, caret)}${token}${content.slice(caret)}`;
      setContent(next);
      setSuggest(null);
      requestAnimationFrame(() => {
        const pos = caret + token.length;
        textarea?.focus();
        textarea?.setSelectionRange(pos, pos);
      });
    },
    [content],
  );

  /**
   * 乐观清空:发送即清输入(onSend 在整个流结束后才 resolve,挂 await 会
   * 导致生成期间输入残留);早期失败由 onSend 链路与错误块兜底。
   * 解析:命令 token → onRunCommand 且从消息文本移除;文件/技能 token →
   * 读内容组注入块(读失败 token 原样留在文本,toast 一次);纯命令不发消息
   */
  const submit = useCallback(() => {
    const raw = content.trim();
    if (!raw || !hasModel || sending) {
      return;
    }
    const { fileTokens, skillTokens, commands, todoTokens } =
      parseInlineTokens(raw);
    const messageText = stripCommandTokens(raw);
    setContent("");
    setSuggest(null);
    for (const command of commands) {
      onRunCommand(command);
    }
    void (async () => {
      const files: PendingFile[] = [];
      const failures: string[] = [];
      for (const filePath of new Set(fileTokens)) {
        try {
          const result = await invoke<{ content: string } | { error: string }>(
            "file:readWorkspaceFile",
            workspaceId,
            filePath,
          );
          if ("error" in result) {
            failures.push(filePath);
          } else {
            files.push({ path: filePath, content: result.content });
          }
        } catch {
          failures.push(filePath);
        }
      }
      for (const name of new Set(skillTokens)) {
        try {
          const result = await SkillApi.readSkill(name);
          files.push({ path: name, content: result.content, kind: "skill" });
        } catch {
          failures.push(name);
        }
      }
      // 待办引用:token id 在 todoItems 命中即组摘要注入(查无 id 静默忽略)
      for (const token of new Set(todoTokens)) {
        const item = todoItems?.find(
          (todo) => todo.id === Number(token.slice(1)),
        );
        if (item) {
          files.push({
            path: `待办#${item.id}`,
            content: `【待办】${item.title}｜状态:${item.status}｜优先级:${item.priority}｜截止:${item.dueDate || "无"}`,
            kind: "todo",
          });
        }
      }
      if (failures.length > 0) {
        toast.warning(
          t("chat:mention.tokenReadFailed", { names: failures.join(", ") }),
        );
      }
      if (messageText.trim() === "" && files.length === 0) {
        if (commands.length === 0 || failures.length > 0) {
          // 既无正文也无可用注入(且非纯命令成功):恢复输入避免吞掉
          setContent(raw);
        }
        return;
      }
      void onSend(messageText, files).catch(() => {
        /* 错误提示由 onSend 链路（toast+rethrow）与持久化错误块负责 */
      });
    })();
  }, [
    content,
    hasModel,
    sending,
    workspaceId,
    todoItems,
    onRunCommand,
    onSend,
    t,
  ]);

  /** 面板选中:按候选类型拼 token 插入光标处 */
  const selectCandidate = useCallback(
    (candidate: SuggestCandidate) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? content.length;
      const end = suggest
        ? Math.min(caret, suggest.startIndex + 1 + suggest.query.length)
        : caret;
      const token =
        candidate.kind === "file"
          ? `@${candidate.path} `
          : candidate.kind === "skill"
            ? `⚡${candidate.name} `
            : candidate.kind === "todo"
              ? `#${candidate.id} `
              : `/${candidate.name} `;
      const next =
        content.slice(0, suggest ? suggest.startIndex : caret) +
        token +
        content.slice(end);
      setContent(next);
      setSuggest(null);
      requestAnimationFrame(() => {
        const pos = (suggest ? suggest.startIndex : caret) + token.length;
        textarea?.focus();
        textarea?.setSelectionRange(pos, pos);
      });
    },
    [content, suggest],
  );

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const caret = event.target.selectionStart;
    setContent(value);
    const slash = detectSlash(value, caret);
    const mention = slash ? null : detectMention(value, caret);
    // # 待办触发仅在 todoItems 注入时启用（AI 模块 ChatPane 不传则行为不变）
    const todo =
      slash || mention ? null : todoItems && detectTodo(value, caret);
    const next = slash
      ? { type: "slash" as const, ...slash }
      : mention
        ? { type: "at" as const, ...mention }
        : todo
          ? { type: "todo" as const, ...todo }
          : null;
    setSuggest(next);
    if (next) {
      setHighlightIndex(0);
    }
  };

  // 光标移动（←→/Home/End/点击）不触发 onChange——在 keyup/select 上重算,
  // 光标离开触发片段即关闭面板,避免 Enter 被残留面板劫持
  const syncSuggestFromCaret = (target: HTMLTextAreaElement) => {
    const slash = detectSlash(target.value, target.selectionStart);
    const mention = slash
      ? null
      : detectMention(target.value, target.selectionStart);
    const todo =
      slash || mention
        ? null
        : todoItems && detectTodo(target.value, target.selectionStart);
    setSuggest(
      slash
        ? { type: "slash", ...slash }
        : mention
          ? { type: "at", ...mention }
          : todo
            ? { type: "todo", ...todo }
            : null,
    );
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

  /** textarea 滚动同步镜像层(pill 高亮跟随视口) */
  const handleScroll = () => {
    if (mirrorRef.current && textareaRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleBlur = () => {
    // 点击面板外失焦：关闭（点击候选项的 mousedown 已 preventDefault 不触发）
    setSuggest(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 面板激活时优先消费导航键（todo 无候选时面板不显示，Enter 正常发送）
    if (showSuggestList) {
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
        if (candidate) {
          event.preventDefault();
          selectCandidate(candidate);
          return;
        }
        // 无候选时 Enter 不发送，交由用户删掉触发符或继续输入
        event.preventDefault();
        return;
      }
    }
    // IME 组合中的 Enter 仅确认候选：发送/换行绑定均不触发
    if (event.nativeEvent.isComposing) {
      return;
    }
    // 发送/换行读生效绑定（默认 Enter 发送、Shift+Enter 换行；
    // 每次按键即时合成，用户改绑立即生效）
    const platform = detectPlatform();
    const bindings = currentBindings();
    if (
      eventMatchesBinding(event.nativeEvent, bindings.sendMessage, platform)
    ) {
      event.preventDefault();
      submit();
      return;
    }
    if (
      eventMatchesBinding(event.nativeEvent, bindings.newlineInInput, platform)
    ) {
      event.preventDefault();
      insertNewline();
    }
  };

  const slashNoFiles = suggest?.type === "at" && workspaceId === null;
  const noCandidates = suggest !== null && suggestCandidates.length === 0;

  // 镜像层分段:token 渲染 pill(主题色),普通文本与 textarea 同度量
  const segments = useMemo(() => renderTokenSegments(content), [content]);

  // 已引用待办 chips:草稿 todo token 去重后查 todoTitleById 取标题
  // (查无 id 跳过——与 submit 注入口径一致;未传 todoItems 恒空)
  const todoChips = useMemo(() => {
    if (!todoItems) {
      return [];
    }
    const chips: Array<{ id: number; title: string }> = [];
    const seen = new Set<number>();
    for (const segment of segments) {
      if (!segment.isToken || segment.kind !== "todo") {
        continue;
      }
      const id = Number(segment.text.slice(1));
      const title = todoTitleById.get(id);
      if (title !== undefined && !seen.has(id)) {
        seen.add(id);
        chips.push({ id, title });
      }
    }
    return chips;
  }, [segments, todoItems, todoTitleById]);

  return (
    <div
      data-testid="chat-input"
      className="relative flex min-w-0 flex-1 flex-col rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40"
    >
      {/* 联想面板（向上弹出；未绑定工作空间/无匹配给出提示文案；todo 无匹配不弹出） */}
      {showSuggestList && (
        <div
          data-testid="mention-panel"
          className="absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-lg border border-border/50 bg-card shadow-lg"
        >
          {slashNoFiles ? (
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
                  key={`${candidate.kind}:${
                    candidate.kind === "file"
                      ? candidate.path
                      : candidate.kind === "todo"
                        ? candidate.id
                        : candidate.name
                  }`}
                >
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      // mousedown 先于 blur/发送键处理，阻止默认避免失焦
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
                    {candidate.kind === "command" ? (
                      <>
                        <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">/{candidate.name}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {t(`chat:mention.cmd_${candidate.name}`)}
                        </span>
                      </>
                    ) : candidate.kind === "skill" ? (
                      <>
                        <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{candidate.name}</span>
                      </>
                    ) : candidate.kind === "todo" ? (
                      <>
                        <ListTodo className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{candidate.title}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          #{candidate.id}
                        </span>
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
      {/* 已启用技能标签行：点击移除（禁用），与＋菜单技能浮层联动 */}
      {enabledSkills.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1">
          {enabledSkills.map((skill) => (
            <button
              key={skill.name}
              type="button"
              title={skill.description ?? skill.name}
              onClick={() => void handleDisableSkill(skill.name)}
              className="inline-flex max-w-48 items-center gap-1 rounded-full border border-border/50 bg-primary-subtle px-2 py-0.5 text-[10px] text-primary hover:border-primary/30"
            >
              <Zap className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{skill.name}</span>
              <X className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </button>
          ))}
        </div>
      )}
      {/* 输入区:镜像层(可见文字+pill)+ textarea(透明文字,接收输入) */}
      <div className="relative mt-2">
        <div
          ref={mirrorRef}
          aria-hidden
          data-testid="chat-input-mirror"
          className="pointer-events-none absolute inset-0 max-h-56 overflow-hidden border-0 p-0 whitespace-pre-wrap break-words text-sm leading-relaxed"
        >
          {segments.map((segment, index) =>
            segment.isToken ? (
              <span
                key={index}
                // 待办 pill 正文保留 token 原文（镜像层与透明 textarea 须逐
                // 字符同宽对齐，替换为标题会使光标错位）；标题映射走下方
                // 已引用 chips 行（镜像层 pointer-events-none 悬停不可达）
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
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onSelect={handleSelect}
          onBlur={handleBlur}
          onScroll={handleScroll}
          rows={1}
          autoFocus
          placeholder={
            placeholder ??
            t(hasModel ? "chat:input.placeholder" : "chat:input.modelRequired")
          }
          className="relative min-h-10 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-relaxed field-sizing-content max-h-56 outline-none text-transparent caret-foreground placeholder:text-muted-foreground [&::-webkit-scrollbar]:hidden"
        />
      </div>
      {/* 已引用待办 chips：草稿 #<id> token 解析出的标题可见通道
          （镜像 pill 正文须保留 token 原文保证光标对齐；查无 id 跳过） */}
      {todoChips.length > 0 && (
        <div data-testid="todo-ref-chips" className="flex flex-wrap gap-1 pt-2">
          {todoChips.map((chip) => (
            <span
              key={chip.id}
              title={chip.title}
              className="inline-flex max-w-48 items-center gap-1 rounded-full border border-border/50 bg-primary-subtle px-2 py-0.5 text-[10px] text-primary"
            >
              <ListTodo className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{chip.title}</span>
            </span>
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
            boundAssistantIds={boundAssistantIds}
            boundSkillNames={boundSkillNames}
            localTask={localTask}
            onPickPaths={(paths) => {
              for (const filePath of paths) {
                insertAtCaret(`@${filePath} `);
              }
            }}
            onOpenMcp={onOpenMcp}
          />
          <PermissionCapsule
            sessionId={sessionId}
            accessMode={accessMode}
            onChange={onAccessModeChange}
          />
          {assistantName && (
            <span
              className="max-w-32 truncate rounded-full bg-primary-subtle px-2 py-0.5 text-xs text-primary"
              title={assistantName}
            >
              {assistantName}
            </span>
          )}
          {currentMode !== "agent" && (
            <span className="text-xs text-muted-foreground">
              {currentMode === "ask" ? "ASK" : "PLAN"}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ContextUsageButton
            sessionId={sessionId}
            currentModelId={currentModelId}
            sending={sending}
            draft={content}
          />
          <ModelPicker sessionId={sessionId} currentModelId={currentModelId} />
          {sending ? (
            /* 停止:黑底圆钮 + 白色实心方块 */
            <Button
              variant="ghost"
              size="sm"
              onClick={onStop}
              aria-label={t("chat:input.stop")}
              title={t("chat:input.stop")}
              className="h-8 w-8 shrink-0 rounded-full bg-foreground p-0 text-background hover:bg-foreground/85"
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            /* 发送:主色圆钮 */
            <Button
              size="sm"
              onClick={submit}
              disabled={!hasModel || content.trim() === ""}
              aria-label={t("chat:input.send")}
              title={t("chat:input.send")}
              className="h-8 w-8 shrink-0 rounded-full p-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
