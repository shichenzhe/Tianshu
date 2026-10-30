/**
 * 卡片式输入框(P3 spec §1):textarea(文字与内联引用 token 交叉)居首,
 * 下行左 ＋菜单/权限胶囊/模式徽标、右 模型选择 + 发送/停止。
 * 引用即文字:@ 文件 / ⚡技能 / /命令 / #待办 以 token 形式留在输入流中,
 * 镜像层渲染 pill 高亮(textarea 文字透明)——P3 期的输入流行内 chips
 * 机制已移除;#待办 的标题映射另经输入区下方"已引用"chips 行可见
 * (独立的只读展示行,非行内 chips;pill 正文保留 token 原文)。
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
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ClipboardPaste,
  Library,
  ListTodo,
  Send,
  Sparkles,
  Square,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";

import { useCreateSkillPromptStore } from "../../skills/store/create-skill.store";
import { usePlanAdvanceStore } from "../../../project/store/plan-advance.store";
import SkillApi from "../../skills/api/skill.api";
import AssistantApi from "../../api/assistant.api";
import LibraryApi from "../../library/api/library.api";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { isOversizeError } from "../../new-task/lib/attach";
import { mapIpcError } from "../lib/error-message";

import IconTooltip from "@/components/common/icon-tooltip";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/ipc";
import { detectPlatform } from "@/lib/keybindings";
import {
  currentBindings,
  eventMatchesBinding,
} from "@/lib/keybindings/dispatcher";
import type { ChatModelParams } from "../../api/chat.api";
import type { SessionMode } from "../../api/session.api";
import { useHostCaps } from "../../data-source/host.store";
import { routeInvoke, remoteConnId } from "../../data-source/host-route";
import * as remoteFiles from "../../data-source/remote-files";

/** 远程图片上限（FA-T3）：3MB——relay 单帧 4MiB 余量（与被控端
 *  files/uploadImage 的 IMAGE_MAX_BYTES 同值；本地链 10MB 保持） */
const REMOTE_IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;

/** 绝对路径判据（渲染层无 node:path）：POSIX 根、Windows 盘符或 UNC——
 *  ＋菜单「添加文件」等来源的工作空间外引用以绝对路径入 token，这类
 *  引用 read_file 读不到（工作空间守卫），须走内容注入链 */
function isAbsoluteLikePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

import {
  MENTION_LIMIT,
  SLASH_COMMANDS,
  detectMention,
  detectSlash,
  parseInlineTokens,
  renderTokenSegments,
  stripCommandTokens,
  toggleSkillToken,
} from "../lib/inline-tokens";
import type { PendingFile } from "../lib/pending-file";
import { isImagePath } from "../lib/image-file";
import {
  blobToBase64,
  categorizePastedFiles,
  collectPasteFiles,
  isOverLimit,
  type PastedFileEntry,
} from "../lib/paste-attachments";
import ModelPicker from "./ModelPicker";
import ContextUsageButton from "./context-usage-button";
import PermissionCapsule, { type AccessMode } from "./PermissionCapsule";
import PlusMenu, { type LocalTaskToggle } from "./PlusMenu";
import ExpertPromptChips from "./ExpertPromptChips";
import type { PickedLibraryFile } from "../../library/components/LibraryPickerDialog";

/** 联想候选:命令 / 技能 / 文件 / 资料库 / 待办 */
type SuggestCandidate =
  | { kind: "command"; name: string }
  | { kind: "skill"; name: string }
  | { kind: "file"; path: string }
  | { kind: "library"; name: string; storagePath: string }
  | { kind: "todo"; id: number; title: string };

/** 项目待办引用数据源(计划事项记录;ProjectChatBar 注入,AI 模块不传) */
interface TodoSuggestItem {
  id: number;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
  /** 任务描述(PlanItemRecord Markdown 原文;发送时附 [描述] 块,AI 推进的内容依据) */
  description?: string;
  /** AI 进展摘要(PlanItemRecord;空串/缺省 = 无,发送时不附 [进展] 块) */
  aiSummary?: string;
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
  /** 只读态（归档会话）：输入与发送禁用，占位提示归档只读 */
  disabled?: boolean;
  /** 专家推荐提示词胶囊（T8）：空会话（尚无 user 消息）时输入区上方展示
   *  绑定专家 quickPrompts，点击填入草稿；缺省 false 不渲染（其他消费方零改动） */
  expertPromptsVisible?: boolean;
  /** 快捷指令胶囊（T22 文件窗）：数据源由调用方解析注入（文件窗按
   *  contentKind 取矩阵，i18n 已在调用侧解析）——展示门控同专家胶囊
   *  （空会话），点击填入草稿不发送；缺省不渲染（AI 模块零改动） */
  quickPrompts?: Array<{ id: string; label: string; prompt: string }>;
  /** 拖入图片受控注入（T22 文件窗）：面板 drop 层落盘后经此并入粘贴
   *  附件体系（chips 展示/移除/发送分流）；并入完成回调消费方清空；
   *  缺省不启用 */
  pendingImageInjection?: Array<{ name: string; absPath: string }>;
  /** 注入并入完成回调（pendingImageInjection 配对，消费即清空防重复并入） */
  onPendingImageInjectionConsumed?: () => void;
  /** 草稿回灌初值（T28 文件窗 per-tab 草稿，spec §16 项 5）：切 tab 重挂
   *  时恢复上次输入；缺省空串（既有消费方零改动） */
  initialDraft?: string;
  /** 卸载草稿上报（与 initialDraft 配对）：组件卸载时以最新草稿回调一次
   *  （消费方存 tab 瞬态字段）；ref 存最新值不逐键入回调；缺省不回调 */
  onDraftUnmount?: (draft: string) => void;
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
  todoItems,
  localTask,
  onOpenMcp,
  onRunCommand,
  onSend,
  onStop,
  placeholder,
  disabled = false,
  expertPromptsVisible = false,
  quickPrompts,
  pendingImageInjection,
  onPendingImageInjectionConsumed,
  initialDraft,
  onDraftUnmount,
}: ChatInputProps) {
  const { t } = useTranslation(["chat"]);
  // 主机能力门控（HD-T4，spec §2.4）：远程主机无本地文件面——附件粘贴/
  // @ 文件与资料库联想/compact 命令整体不响应不发本地 IPC
  const filesCap = useHostCaps().files;
  const [content, setContent] = useState(initialDraft ?? "");
  const [suggest, setSuggest] = useState<{
    type: "at" | "slash" | "todo";
    startIndex: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // 资料库引用 pill（@ 联想与＋菜单共同数据源；storagePath 含空格，
  // 不走 @token——spec §6「选中挂 pill」）
  const [libraryFiles, setLibraryFiles] = useState<PickedLibraryFile[]>([]);
  // 粘贴附件 pill（Finder 复制文件/截图落盘，与资料库 pill 同链路：
  // 发送时经 readExternalFile 读取注入；path 已随粘贴时授权）
  const [pastedFiles, setPastedFiles] = useState<PastedFileEntry[]>([]);
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  // per-tab 草稿外置（T28 spec §16 项 5）：ref 存最新草稿与回调，卸载时
  // 上报一次——不逐键入回调（消费者若存 zustand 会随每次输入重渲染面板）
  const contentRef = useRef(content);
  const onDraftUnmountRef = useRef(onDraftUnmount);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  useEffect(() => {
    onDraftUnmountRef.current = onDraftUnmount;
  }, [onDraftUnmount]);
  useEffect(() => {
    return () => onDraftUnmountRef.current?.(contentRef.current);
  }, []);
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

  // 计划推进预填(计划视图「AI 推进」入口):底栏常驻仅挂载一次,挂载式
  // 消费不可达——订阅 prompt 值变化运行期消费(读后即清,二次消费得
  // null 天然防重复预填),预填后聚焦输入框
  const planPrompt = usePlanAdvanceStore((s) => s.prompt);
  useEffect(() => {
    if (planPrompt) {
      const prompt = usePlanAdvanceStore.getState().consume();
      if (prompt) {
        setContent(prompt);
        textareaRef.current?.focus();
      }
    }
  }, [planPrompt]);

  // 拖入图片受控注入（T22 文件窗）：drop 层落盘后的条目并入粘贴附件
  // （path 去重），并入即回调消费方清空（读后即清防二次并入）；随后
  // chips 展示/移除/发送分流均归既有 pastedFiles 链路（图片走多模态）
  useEffect(() => {
    if (!pendingImageInjection || pendingImageInjection.length === 0) {
      return;
    }
    setPastedFiles((prev) => [
      ...prev,
      ...pendingImageInjection
        .filter((p) => !prev.some((f) => f.path === p.absPath))
        .map((p) => ({ name: p.name, path: p.absPath })),
    ]);
    onPendingImageInjectionConsumed?.();
  }, [pendingImageInjection, onPendingImageInjectionConsumed]);

  // 工作空间文件清单（@ 文件联想数据源；5 分钟内复用缓存;未绑定时不可用）
  const workspaceFilesQuery = useQuery({
    queryKey: ["workspace-files", workspaceId],
    // FA-T3 主机路由：远程走 files/list（远端 workspace 清单，形状直传）
    queryFn: () =>
      routeInvoke(
        { ch: "file:listWorkspaceFiles", args: [workspaceId] },
        (connId) => remoteFiles.list(workspaceId as number, connId),
      ),
    // caps.files=false：不发本地 IPC（@ 联想远程已被 mention 检测门控，
    // 此处 enabled 双保险——切主机残留 suggest 态不触发拉取）
    enabled: workspaceId !== null && suggest !== null && filesCap,
    staleTime: 300_000,
  });

  // @ 联想资料库候选（跨层文件名搜索；与选择器共享 librarySearch 缓存；
  // 空 query 不拉——避免 bare @ 每击键全量搜索）
  const suggestQuery = suggest?.type === "at" ? suggest.query : "";
  // 300ms 防抖——避免每击键一发 library:search IPC
  const debouncedQuery = useDebouncedValue(suggestQuery, 300);
  const librarySearchQuery = useQuery({
    queryKey: ["librarySearch", debouncedQuery],
    queryFn: () => LibraryApi.search(debouncedQuery),
    enabled: debouncedQuery.length > 0 && filesCap,
  });

  // 已安装技能（/ 面板候选 + 输入框启用标签行；与＋菜单技能浮层共享缓存）
  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });
  const enabledSkills = (skillsQuery.data ?? []).filter((r) => r.enabled);
  // 已引用技能名（＋菜单技能子菜单勾选态依据；输入流 ⚡token 解析去重）
  const referencedSkills = useMemo(
    () => [...new Set(parseInlineTokens(content).skillTokens)],
    [content],
  );

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
      // caps.files=false：compact 命令隐藏（远端不支持 chat:compact，
      // spec §2.3 不映射清单）；技能候选保留（远程 skillsQuery 有面）
      const commands: SuggestCandidate[] = (
        filesCap
          ? SLASH_COMMANDS
          : SLASH_COMMANDS.filter((c) => c !== "compact")
      )
        .filter((cmd) => !query || cmd.includes(query))
        .map((cmd) => ({ kind: "command", name: cmd }));
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
    // 资料库组：候选按 librarySearch 结果追加（空 query 恒空——不与工作
    // 空间文件组混排，选中挂 pill 而非 @token）；不依赖工作空间绑定
    // （资料库为全局），未绑/清单未就绪时仍可 @ 到资料库
    const library: SuggestCandidate[] = query
      ? (librarySearchQuery.data ?? []).slice(0, MENTION_LIMIT).map((item) => ({
          kind: "library" as const,
          name: item.name,
          storagePath: item.storagePath ?? "",
        }))
      : [];
    const files = workspaceFilesQuery.data;
    if (!files) {
      return library;
    }
    return [
      ...(query
        ? files.filter((file) => file.toLowerCase().includes(query))
        : [...files].sort((a, b) => a.length - b.length)
      )
        .slice(0, MENTION_LIMIT)
        .map((file) => ({ kind: "file" as const, path: file })),
      ...library,
    ];
  }, [
    suggest,
    skillsQuery.data,
    workspaceFilesQuery.data,
    librarySearchQuery.data,
    todoItems,
    filesCap,
  ]);

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

  /** 标签行点击移除 = 禁用技能（＋菜单技能子菜单已改引用语义，
      此处与 ChatInput 底部标签同为桌面端快捷停用入口） */
  const handleDisableSkill = async (name: string) => {
    try {
      await SkillApi.setEnabled(name, false);
      await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** ＋菜单技能引用切换：输入流 ⚡token 增删（纯前端文本操作，
      全文发送时经 skill:readSkill 读取注入；启停收口管理页与标签行） */
  const handleToggleSkill = useCallback(
    (name: string) => {
      setContent((prev) => toggleSkillToken(prev, name));
    },
    [],
  );

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

  /** 专家推荐提示词填入（T8）：换行分隔追加到草稿末尾（模板尾接内容，
   *  与既有草稿硬拼会粘连），rAF 等受控 value 提交后聚焦并把光标移到末尾
   *  （模板占位后继续输入） */
  const fillExpertPrompt = useCallback((text: string) => {
    setContent((prev) => (prev ? `${prev}\n${text}` : text));
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      const pos = textarea.value.length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    });
  }, []);

  /**
   * 乐观清空:发送即清输入(onSend 在整个流结束后才 resolve,挂 await 会
   * 导致生成期间输入残留);早期失败由 onSend 链路与错误块兜底。
   * 解析:命令 token → onRunCommand 且从消息文本移除;文件/技能 token →
   * 读内容组注入块(读失败 token 原样留在文本,toast 一次);纯命令不发消息
   */
  const submit = useCallback(() => {
    const raw = content.trim();
    if (!raw || !hasModel || sending || disabled) {
      return;
    }
    const { fileTokens, skillTokens, commands, todoTokens } =
      parseInlineTokens(raw);
    const messageText = stripCommandTokens(raw);
    setContent("");
    setSuggest(null);
    setLibraryFiles([]);
    setPastedFiles([]);
    for (const command of commands) {
      onRunCommand(command);
    }
    void (async () => {
      const files: PendingFile[] = [];
      const failures: string[] = [];
      for (const filePath of new Set(fileTokens)) {
        // 引用式（引用式批 2026-10-21）：agent/plan 会话的工作空间相对路径
        // 引用不读全文——只注路径 + read_file 指示，AI 处理时自读（面板只
        // 显示路径行，对齐文件窗 library 首条注入语义）；ask 会话无工具集
        // （无头端/本地 ask → []），与绝对路径引用一并走下方内容注入链
        if (currentMode !== "ask" && !isAbsoluteLikePath(filePath)) {
          files.push({ path: filePath, content: "", kind: "fileRef" });
          continue;
        }
        try {
          // FA-T3 主机路由：远程走 files/read（远端 workspace 守卫读取，
          // 形状同构 {content}|{error}——出界码回退 readExternalFile 本地
          // 授权门的既有判据链保持）
          const result = await routeInvoke<
            { content: string } | { error: string }
          >(
            { ch: "file:readWorkspaceFile", args: [workspaceId, filePath] },
            async (connId) => {
              const r = await remoteFiles.read(
                filePath,
                workspaceId as number,
                connId,
              );
              return r.error !== undefined
                ? { error: r.error }
                : { content: r.content ?? "" };
            },
          );
          if ("error" in result) {
            // 出界绝对路径（＋菜单「添加文件」可选工作空间外文件）回退
            // readExternalFile 授权门：预读无沙箱、发送读取有沙箱的口径
            // 断裂曾致「先报错后照常发送、文件静默丢失」；授权来源
            // （选择器/粘贴/拖拽）放行，其余仍失败走 toast
            if (result.error === "PATH_OUTSIDE_WORKSPACE") {
              // 图片附件走多模态 image part（不读内容、不注入占位文本）
              if (isImagePath(filePath)) {
                files.push({
                  path: filePath,
                  content: "",
                  kind: "localFile",
                  image: true,
                });
                continue;
              }
              try {
                const ext = await invoke<{ content?: string }>(
                  "file:readExternalFile",
                  filePath,
                );
                files.push({
                  path: filePath,
                  content: ext.content ?? "",
                });
                continue;
              } catch {
                failures.push(filePath);
                continue;
              }
            }
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
      // 待办引用:token id 在 todoItems 命中即组摘要注入(查无 id 静默忽略);
      // aiSummary 非空时附 [进展] 块(末 10 行——长进展截尾保最新)
      for (const token of new Set(todoTokens)) {
        const item = todoItems?.find(
          (todo) => todo.id === Number(token.slice(1)),
        );
        if (item) {
          const summary = `【待办】${item.title}｜状态:${item.status}｜优先级:${item.priority}｜截止:${item.dueDate || "无"}`;
          const withDescription = item.description
            ? `${summary}\n[描述]\n${item.description}`
            : summary;
          files.push({
            path: `待办#${item.id}`,
            content: item.aiSummary
              ? `${withDescription}\n[进展]\n${item.aiSummary.split("\n").slice(-10).join("\n")}`
              : withDescription,
            kind: "todo",
          });
        }
      }
      // 资料库 pill 与粘贴附件 pill：读内容组注入块（与 dispatch.readPendingRef
      // 同口径——文本注入；图片附件不读内容，分流为多模态 image part 随消息
      // 直发）；读取失败与 @token 失败分离——failures 非空即恢复输入与 pill
      // 不发送（两类 pill 引用不在文本中，静默丢失会使「已按原样保留」谎报），
      // 专用 toast 告知
      const libFailures: string[] = [];
      for (const file of [...libraryFiles, ...pastedFiles]) {
        // 两种 pill 形状并流：资料库 storagePath / 粘贴 path（in 窄化取一）
        const storagePath =
          "storagePath" in file ? file.storagePath : file.path;
        if (isImagePath(storagePath)) {
          files.push({
            path: storagePath,
            content: "",
            kind: "localFile",
            image: true,
            // FA-T3 远程链：blob 暂存的 base64 随行（本地链缺省忽略）
            ...("base64" in file && file.base64 ? { base64: file.base64 } : {}),
          });
          continue;
        }
        try {
          const result = await invoke<{ content?: string }>(
            "file:readExternalFile",
            storagePath,
          );
          files.push({
            path: file.name,
            content: result.content ?? "",
            kind: "localFile",
          });
        } catch {
          libFailures.push(file.name);
        }
      }
      if (libFailures.length > 0) {
        toast.warning(
          t("chat:library.sendReadFailed", { names: libFailures.join(", ") }),
        );
        setContent(raw);
        setLibraryFiles(libraryFiles);
        setPastedFiles(pastedFiles);
        return;
      }
      if (failures.length > 0) {
        toast.warning(
          t("chat:mention.tokenReadFailed", { names: failures.join(", ") }),
        );
      }
      if (messageText.trim() === "" && files.length === 0) {
        if (commands.length === 0 || failures.length > 0) {
          // 既无正文也无可用注入(且非纯命令成功):恢复输入避免吞掉
          // (资料库/粘贴 pill 不在文本中,须随输入一并恢复)
          setContent(raw);
          setLibraryFiles(libraryFiles);
          setPastedFiles(pastedFiles);
        }
        return;
      }
      void onSend(messageText, files).catch(() => {
        /* 错误提示由 onSend 链路（toast+rethrow）与持久化错误块负责。
         * 早期失败（含远程图片上传失败——裁定 2026-10-21 阻断语义）时
         * 输入与 pill 已被乐观清空，此处恢复防吞输入（与上方 libFailures
         * 恢复同款；toast 仍由 ChatPane 单点负责，防双弹） */
        setContent(raw);
        setLibraryFiles(libraryFiles);
        setPastedFiles(pastedFiles);
      });
    })();
  }, [
    content,
    hasModel,
    sending,
    disabled,
    currentMode,
    workspaceId,
    todoItems,
    libraryFiles,
    pastedFiles,
    onRunCommand,
    onSend,
    t,
  ]);

  /** 资料库 pill 挂载（@ 联想与＋菜单选择器两入口共用）：挂 pill 前经
   *  readExternalFile 预检（512KB 上限/二进制/权限），失败按超限/读取失败
   *  区分 toast 且不挂 pill（同 new-task addLocalFile 口径）；图片附件跳过
   *  预检（多模态通道不走 512KB 文本上限，主进程侧 10MB 校验兜底）；通过
   *  后按 storagePath 去重合并。silent 批量场景不逐条 toast（调用方合并提示） */
  const attachLibraryFile = useCallback(
    async (name: string, storagePath: string, silent = false) => {
      if (!isImagePath(storagePath)) {
        try {
          await invoke("file:readExternalFile", storagePath);
        } catch (e) {
          if (!silent) {
            toast.error(
              t(
                isOversizeError(e)
                  ? "chat:library.oversize"
                  : "chat:library.readFailed",
              ),
            );
          }
          return false;
        }
      }
      setLibraryFiles((prev) =>
        prev.some((f) => f.storagePath === storagePath)
          ? prev
          : [...prev, { name, storagePath }],
      );
      return true;
    },
    [t],
  );

  /** 粘贴附件（WorkBuddy 剪贴板管线经验移植，spec 2026-10-10）：有文件才
   *  preventDefault（纯文本粘贴零干扰）；Finder 复制文件经 preload
   *  filePath.getPathForFile 解路径（授权随解自动登记，File 须原样传递）
   *  预检后挂 pill；截图 blob 钉字节转 base64 落盘 attachments/；macOS
   *  size-0 截图（getAsFile 拿不到字节）走主进程 clipboard 兜底；超限与
   *  读取失败分别 toast */
  const pasteAttachments = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      // 远程主机（caps.files=false）：附件链路整体不响应（不落盘不预检，
      // 纯文本粘贴零干扰语义保持——直接 return 不 preventDefault）
      if (!filesCap) {
        return;
      }
      const files = collectPasteFiles(e.clipboardData?.items);
      if (files.length === 0) {
        return;
      }
      e.preventDefault();
      // FA-T3 图片批：远程主机粘贴链走 base64 暂存（不落控制端盘，send
      // 时经 files/uploadImage 上传被控端）；上限 3MB（relay 单帧余量，
      // 本地链 10MB 保持）
      const isRemote = remoteConnId() != null;
      const { pathEntries, imageBlobs, needsClipboardFallback } =
        categorizePastedFiles(files, (file) =>
          window.filePath ? window.filePath.getPathForFile(file) : "",
        );
      const failed: string[] = [];
      const oversize: string[] = [];
      const addPasted = (entry: PastedFileEntry) => {
        setPastedFiles((prev) =>
          prev.some((f) => f.path === entry.path) ? prev : [...prev, entry],
        );
      };
      // LT-T1：远程链读控制端本地图片字节——readExternalFile 图片形态回
      // dataUrl（readWorkspaceFile image 分支），剥前缀即 base64，复用 FA
      // 发送时上传链（@token 出界图与剪贴板兜底截图两条 P1 砍掉的链补齐）
      const addLocalImageAsBase64 = async (
        absPath: string,
        fallbackName: string,
      ): Promise<boolean> => {
        try {
          const r = await invoke<{ kind?: string; dataUrl?: string }>(
            "file:readExternalFile",
            absPath,
          );
          if (r?.kind !== "image" || typeof r.dataUrl !== "string") {
            return false;
          }
          const marker = "base64,";
          const idx = r.dataUrl.indexOf(marker);
          if (idx === -1) {
            return false;
          }
          const base64 = r.dataUrl.slice(idx + marker.length);
          if ((base64.length * 3) / 4 > REMOTE_IMAGE_LIMIT_BYTES) {
            oversize.push(fallbackName);
            return true;
          }
          addPasted({ name: fallbackName, path: fallbackName, base64 });
          return true;
        } catch {
          return false;
        }
      };
      for (const entry of pathEntries) {
        // 图片跳过预检（多模态通道不受 512KB 文本注入上限）
        if (isImagePath(entry.path)) {
          if (isRemote) {
            const handled = await addLocalImageAsBase64(entry.path, entry.name);
            if (!handled) {
              failed.push(entry.name);
            }
            continue;
          }
          addPasted(entry);
          continue;
        }
        try {
          await invoke("file:readExternalFile", entry.path);
          addPasted(entry);
        } catch {
          failed.push(entry.name);
        }
      }
      for (const blob of imageBlobs) {
        if (
          isRemote
            ? blob.size > REMOTE_IMAGE_LIMIT_BYTES
            : isOverLimit(blob.size)
        ) {
          oversize.push(blob.name);
          continue;
        }
        try {
          const name = blob.name || "image.png";
          if (isRemote) {
            // base64 暂存（path 以 name 占位——pill 展示与去重键；发送
            // 链 ChatApi.send 消费 base64 上传，absPath 不用）
            addPasted({ name, path: name, base64: await blobToBase64(blob) });
          } else {
            const abs = await invoke<string>(
              "file:savePastedImage",
              name,
              await blobToBase64(blob),
            );
            addPasted({ name, path: abs });
          }
        } catch {
          failed.push(blob.name || "image.png");
        }
      }
      if (needsClipboardFallback) {
        // LT-T1：剪贴板兜底截图（mac size-0）远程同样走本地字节读取上传
        // （clipboard 兜底返回控制端本地路径 → dataUrl → base64 暂存）
        try {
          const abs = await invoke<string | null>("file:readClipboardImage");
          if (abs) {
            if (isRemote) {
              const handled = await addLocalImageAsBase64(abs, "clipboard.png");
              if (!handled) {
                toast.error(t("chat:paste.readFailed", { names: "clipboard" }));
              }
            } else {
              addPasted({ name: "clipboard.png", path: abs });
            }
          } else {
            toast.error(t("chat:paste.clipboardEmpty"));
          }
        } catch {
          toast.error(t("chat:paste.readFailed", { names: "clipboard" }));
        }
      }
      if (oversize.length > 0) {
        toast.warning(
          isRemote
            ? t("chat:paste.remoteImageTooLarge", {
                names: oversize.join(", "),
              })
            : t("chat:paste.imageTooLarge", { names: oversize.join(", ") }),
        );
      }
      if (failed.length > 0) {
        toast.warning(t("chat:paste.readFailed", { names: failed.join(", ") }));
      }
    },
    [t, filesCap],
  );

  /** 面板选中:按候选类型拼 token 插入光标处 */
  const selectCandidate = useCallback(
    (candidate: SuggestCandidate) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? content.length;
      const end = suggest
        ? Math.min(caret, suggest.startIndex + 1 + suggest.query.length)
        : caret;
      // 资料库候选不插 @token（storagePath 含空格,TOKEN_RE 不匹配会截断
      // 成碎 token）:删除 @ 触发片段（同 NewTaskInputCard 语义）后挂 pill
      if (candidate.kind === "library") {
        const next =
          content.slice(0, suggest ? suggest.startIndex : caret) +
          content.slice(end);
        setContent(next);
        setSuggest(null);
        // 挂 pill 前预检：读取失败（超限/二进制/权限）toast 且不挂 pill
        void attachLibraryFile(candidate.name, candidate.storagePath);
        requestAnimationFrame(() => {
          const pos = suggest ? suggest.startIndex : caret;
          textarea?.focus();
          textarea?.setSelectionRange(pos, pos);
        });
        return;
      }
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
    [content, suggest, attachLibraryFile],
  );

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const caret = event.target.selectionStart;
    setContent(value);
    const slash = detectSlash(value, caret);
    // 远程主机（caps.files=false）：@ 联想不进入（候选全依赖本地文件面）
    const mention = slash || !filesCap ? null : detectMention(value, caret);
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
      : !filesCap
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

  // 未绑空间的 bare @（资料库组空 query 恒空）→ needBind 引导；已输入
  // query 时资料库仍可达，走通用无匹配文案而非误导性的绑定提示
  const slashNoFiles =
    suggest?.type === "at" && workspaceId === null && !suggest.query;
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
          className="absolute bottom-full left-3 z-10 mb-1 w-72 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-lg border border-border/50 bg-card shadow-lg"
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
                      : candidate.kind === "library"
                        ? candidate.storagePath
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
                    ) : candidate.kind === "library" ? (
                      /* 分组小标签区分工作空间文件组（同 NewTaskInputCard） */
                      <>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {t("chat:library.groupLibrary")}
                        </span>
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
      {/* 快捷指令胶囊（T22 文件窗）：展示门控与专家胶囊同口径（空会话），
          点击填入草稿不发送（fillExpertPrompt 复用——换行追加语义一致） */}
      {expertPromptsVisible && (quickPrompts?.length ?? 0) > 0 && (
        <div
          data-testid="quick-prompt-chips"
          className="flex flex-wrap gap-1.5 px-1 pb-2"
        >
          {quickPrompts!.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-label={`${t("chat:experts.chips.fill")}：${p.label}`}
              title={p.label}
              onClick={() => fillExpertPrompt(p.prompt)}
              className="max-w-full truncate rounded-full border border-border/50 bg-primary-subtle/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {/* 专家推荐提示词胶囊（T8）：空会话在输入区上方展示，点击填入草稿
          （展示门控由 ChatPane 按会话消息计算；项目底栏不传恒不渲染） */}
      {expertPromptsVisible && (
        <ExpertPromptChips
          assistantId={currentAssistantId}
          visible
          onPick={fillExpertPrompt}
        />
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
          onPaste={pasteAttachments}
          rows={1}
          autoFocus
          disabled={disabled}
          placeholder={
            disabled
              ? t("chat:input.archivedPlaceholder")
              : (placeholder ??
                t(
                  hasModel
                    ? "chat:input.placeholder"
                    : "chat:input.modelRequired",
                ))
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
      {/* 附件 pill 行：粘贴附件与资料库引用共同数据源（不在输入流中），
          点击移除 */}
      {(pastedFiles.length > 0 || libraryFiles.length > 0) && (
        <div
          data-testid="attachment-pills"
          className="flex flex-wrap items-center gap-1 px-1 pb-1 pt-1"
        >
          {pastedFiles.map((file) => (
            <AttachmentPill
              key={file.path}
              testId="paste-attachment-pill"
              icon={<ClipboardPaste className="h-2.5 w-2.5 shrink-0" />}
              name={file.name}
              onRemove={() =>
                setPastedFiles((prev) =>
                  prev.filter((f) => f.path !== file.path),
                )
              }
            />
          ))}
          {libraryFiles.map((file) => (
            <AttachmentPill
              key={file.storagePath}
              testId="library-ref-pill"
              icon={<Library className="h-2.5 w-2.5 shrink-0" />}
              name={file.name}
              onRemove={() =>
                setLibraryFiles((prev) =>
                  prev.filter((f) => f.storagePath !== file.storagePath),
                )
              }
            />
          ))}
        </div>
      )}
      {/* 下行：左 ＋菜单 + 权限胶囊 + 模式徽标，右 模型 + 发送/停止。
          T27 窄容器（面板 min 320）降级：行 flex-wrap——左右组放不下同宽时
          右组换行（ml-auto 在独立行仍右对齐）；两组 min-w-0 + 模型 chip
          可收缩截断（详见 ModelPicker），宽容器同行布局零变化 */}
      <div className="flex flex-wrap items-center gap-y-1 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <PlusMenu
            sessionId={sessionId}
            currentMode={currentMode}
            currentAssistantId={currentAssistantId}
            localTask={localTask}
            onPickPaths={(paths) => {
              for (const filePath of paths) {
                insertAtCaret(`@${filePath} `);
              }
            }}
            onPickLibraryFiles={(files) => {
              // 批量预检：失败项静默收集后合并单条 toast（避免逐文件多条
              // 打扰），成功项去重挂 pill
              void (async () => {
                const failed: string[] = [];
                for (const file of files) {
                  const ok = await attachLibraryFile(
                    file.name,
                    file.storagePath,
                    true,
                  );
                  if (!ok) {
                    failed.push(file.name);
                  }
                }
                if (failed.length > 0) {
                  toast.error(
                    t("chat:library.pickAttachFailed", {
                      names: failed.join("、"),
                    }),
                  );
                }
              })();
            }}
            onOpenMcp={onOpenMcp}
            referencedSkills={referencedSkills}
            onToggleSkill={handleToggleSkill}
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
            <span className="shrink-0 text-xs text-muted-foreground">
              {currentMode === "ask" ? "ASK" : "PLAN"}
            </span>
          )}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <ContextUsageButton
            sessionId={sessionId}
            currentModelId={currentModelId}
            sending={sending}
            draft={content}
          />
          <ModelPicker sessionId={sessionId} currentModelId={currentModelId} />
          {sending ? (
            /* 停止:黑底圆钮 + 白色实心方块 */
            <IconTooltip label={t("chat:input.stop")}>
              <Button
                variant="ghost"
                size="sm"
                onClick={onStop}
                aria-label={t("chat:input.stop")}
                className="h-8 w-8 shrink-0 rounded-full bg-foreground p-0 text-background hover:bg-foreground/85"
              >
                <Square className="h-3 w-3 fill-current" />
              </Button>
            </IconTooltip>
          ) : (
            /* 发送:主色圆钮 */
            <IconTooltip label={t("chat:input.send")}>
              <Button
                size="sm"
                onClick={submit}
                disabled={disabled || !hasModel || content.trim() === ""}
                aria-label={t("chat:input.send")}
                className="h-8 w-8 shrink-0 rounded-full p-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </IconTooltip>
          )}
        </div>
      </div>
    </div>
  );
}

/** 附件 pill（粘贴附件/资料库引用共用）：图标 + 名称，点击移除；
 *  细节样式与既有 pill 一致（max-w 截断 + 悬停描边） */
function AttachmentPill({
  icon,
  name,
  onRemove,
  testId,
}: {
  icon: ReactNode;
  name: string;
  onRemove: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      title={name}
      data-testid={testId}
      onClick={onRemove}
      className="inline-flex max-w-48 items-center gap-1 rounded-full border border-border/50 bg-primary-subtle px-2 py-0.5 text-[10px] text-primary hover:border-primary/30"
    >
      {icon}
      <span className="truncate">{name}</span>
    </button>
  );
}
