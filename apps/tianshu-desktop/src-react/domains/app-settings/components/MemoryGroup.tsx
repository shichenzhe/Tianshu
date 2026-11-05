/**
 * 记忆与进化页：页头说明 + 记忆开关（即时生效）+ 管理记忆卡片（spec §6.1
 * 单卡结构：头部按钮 + 卡内四板块内容区，超高右侧滚动）。修订 B：四板块
 * 正文永远只读 markdown 渲染；「编辑」按钮切换 AI 指令模式——底部出现指令
 * 框，指令由主进程直接应用并落库，成功后失效 ["personalization"] 缓存刷新
 * 展示（无草稿/保存/取消概念）；导入按钮常驻；管理卡头部显示上次整理时间
 * 与失败原因（memoryLastCompiledAt / memoryLastError，失败可观测）。
 * 批9（2026-11-05）：画像随登录用户命名空间读写（memoryProfileKeyFor）；
 * 条目行升级——逐条删除 + 来源会话跳转（[日期|#msgId] 溯源）；记忆
 * 导出/导入 JSON（本地文件面，ImportMemoryDialog 合并语义复用）。
 * 开关复用乐观更新 + revert 失败回滚模式（与 ProfileGroup 的
 * ToggleSection 同构）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Brain,
  Download,
  Info,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { toast } from "sonner";

import { getDateFnsLocale } from "@/i18n";
import { downloadBlob } from "@/lib/file-download";
import { useUserStore } from "@/domains/user/store/user.store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelApi, modelDisplayName } from "@/domains/ai/api/model.api";
import { MemoryApi } from "../api/memory.api";
import { SettingsApi } from "../api/settings.api";
import {
  MEMORY_SECTION_DEFS,
  mergeMemoryMarkdown,
  parseMemoryEntry,
  parseMemoryMarkdown,
  removeMemoryEntryLine,
  stripCodeFence,
  type MemorySectionKey,
  type MemorySections,
} from "../model/memory-markdown";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalizationOptions,
  memoryProfileKeyFor,
  parsePersonalizationOptions,
  savePersonalizationOption,
} from "../model/personalization-options";
import { useSettingsUiStore } from "../store/settings-ui.store";
import { useSaveOrRevert } from "../model/use-save-or-revert";
import ImportMemoryDialog from "./memory/ImportMemoryDialog";
import MemoryMarkdown from "./memory/MemoryMarkdown";
import ResetMemoryDialog from "./memory/ResetMemoryDialog";
import SettingSwitchRow from "./SettingSwitchRow";

/** AI 指令输入框限长（M1 前端侧；主进程入口另有 2000 截断兜底） */
const INSTRUCTION_MAX_LENGTH = 500;

/** 保存函数签名（与 ProfileGroup 的 PersistFn 同构；批9 接受 per-user 键） */
type PersistFn = (key: string, value: string | boolean) => Promise<void>;

/** 记忆 JSON 导出格式（version 供未来演进；导入侧只认 memoryProfile 字段） */
interface MemoryExportPayload {
  version: 1;
  exportedAt: string;
  memoryProfile: string;
  memory: string;
}

export default function MemoryGroup() {
  const { t } = useTranslation(["settings"]);
  const queryClient = useQueryClient();
  // 批9：画像随登录用户命名空间（未登录态 id=0 → 全局键，与旧行为一致）
  const userId = useUserStore((s) => s.user.id);
  const scopedUserId = userId > 0 ? userId : undefined;
  const profileKey =
    scopedUserId !== undefined
      ? memoryProfileKeyFor(scopedUserId)
      : PERSONALIZATION_KEYS.memoryProfile;
  const { data: items } = useQuery({
    queryKey: ["personalization"],
    queryFn: () => SettingsApi.getAll(),
    staleTime: Infinity,
  });
  const options = useMemo(
    () =>
      items
        ? parsePersonalizationOptions(items, scopedUserId)
        : defaultPersonalizationOptions(),
    [items, scopedUserId],
  );
  const revert = useSaveOrRevert();

  // M2 数据新鲜度：mount 即失效刷新——夜间整理落库后打开设置页能拉到
  // 新值（staleTime Infinity 保持不变，沿用域内「写后 invalidate」模式）
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["personalization"] });
  }, [queryClient]);

  const persistQuiet = useCallback<PersistFn>(
    async (key, value) => {
      await savePersonalizationOption(key, value);
      await queryClient.invalidateQueries({ queryKey: ["personalization"] });
    },
    [queryClient],
  );

  /** 四节（当前持久化内容切分）：只读展示唯一数据源 */
  const sections = useMemo(
    () => parseMemoryMarkdown(options.memoryProfile),
    [options.memoryProfile],
  );

  const [enabled, setEnabled] = useState(options.memoryEnabled);
  useEffect(() => setEnabled(options.memoryEnabled), [options.memoryEnabled]);
  // 强指定记忆整理模型（空 = 自动解析：默认模型优先，回退启用池）
  const [modelId, setModelId] = useState(options.memoryModelId);
  useEffect(() => setModelId(options.memoryModelId), [options.memoryModelId]);
  // 指令模式开关：开 = 卡片底部显示 AI 指令框（记忆正文始终只读）
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [applying, setApplying] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const importJsonInputRef = useRef<HTMLInputElement>(null);

  /** 编辑按钮 = 进入指令模式 / 完成按钮 = 退出 */
  const toggleEditing = useCallback(() => {
    setEditing((previous) => !previous);
  }, []);

  /** 重置确认（spec §6.3）：退出指令模式并清空记忆（当前用户命名空间） */
  const confirmReset = useCallback(async () => {
    setEditing(false);
    await persistQuiet(profileKey, "");
  }, [persistQuiet, profileKey]);

  /** 导入落库（spec §6.4）：合并结果追加持久化（弹窗侧已 merge） */
  const importMemory = useCallback(
    async (merged: string) => {
      await persistQuiet(profileKey, merged);
    },
    [persistQuiet, profileKey],
  );

  /** 批9 逐条删除：按节内行序移除条目行（IA 从「AI 指令」升级为逐条管理） */
  const deleteEntry = useCallback(
    async (sectionKey: MemorySectionKey, lineIndex: number) => {
      const next = removeMemoryEntryLine(
        options.memoryProfile,
        sectionKey,
        lineIndex,
      );
      if (next === options.memoryProfile) {
        return;
      }
      await persistQuiet(profileKey, next);
      toast.success(t("settings:memory.toast.entryDeleted"));
    },
    [options.memoryProfile, persistQuiet, profileKey, t],
  );

  /** 批9 条目溯源跳转：msgId → 来源会话（关闭设置面板直达会话）。
   *  router 动态 import——避免设置页静态拖入整棵路由树（测试面与打包
   *  分片同样受益） */
  const jumpToSource = useCallback(
    async (msgId: number) => {
      try {
        const sources = await MemoryApi.resolveSources([msgId]);
        const hit = sources[0];
        if (!hit) {
          toast.error(t("settings:memory.toast.sourceMissing"));
          return;
        }
        useSettingsUiStore.getState().setSettingsOpen(false);
        const { router } = await import("@/routes");
        void router.navigate(`/module/ai?session=${hit.sessionId}`);
      } catch {
        toast.error(t("settings:memory.toast.sourceMissing"));
      }
    },
    [t],
  );

  /** 批9 记忆导出 JSON（本地文件；画像 + 手动记忆一并带走） */
  const exportMemory = useCallback(() => {
    const payload: MemoryExportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      memoryProfile: options.memoryProfile,
      memory: options.memory,
    };
    const day = new Date().toISOString().slice(0, 10);
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
      `tianshu-memory-${day}.json`,
    );
    toast.success(t("settings:memory.toast.exported"));
  }, [options.memory, options.memoryProfile, t]);

  /** 批9 记忆导入 JSON：画像走 mergeMemoryMarkdown 合并追加（与粘贴导入
   *  同语义）；手动记忆非空时换行追加；格式非法整体拒绝不动库 */
  const importJsonFile = useCallback(
    async (file: File) => {
      try {
        const raw = JSON.parse(
          await file.text(),
        ) as Partial<MemoryExportPayload>;
        if (typeof raw.memoryProfile !== "string") {
          throw new Error("INVALID_MEMORY_JSON");
        }
        const mergedProfile =
          raw.memoryProfile.trim() === ""
            ? options.memoryProfile
            : mergeMemoryMarkdown(
                options.memoryProfile,
                stripCodeFence(raw.memoryProfile),
              );
        const incomingMemory =
          typeof raw.memory === "string" ? raw.memory.trim() : "";
        if (incomingMemory !== "") {
          await persistQuiet(
            PERSONALIZATION_KEYS.memory,
            [options.memory, incomingMemory].filter((s) => s !== "").join("\n"),
          );
        }
        await persistQuiet(profileKey, mergedProfile);
        toast.success(t("settings:memory.toast.importedFile"));
      } catch {
        toast.error(t("settings:memory.toast.importInvalid"));
      }
    },
    [options.memory, options.memoryProfile, persistQuiet, profileKey, t],
  );

  const submitInstruction = useCallback(async () => {
    const text = instruction.trim();
    if (text === "") {
      return;
    }
    setApplying(true);
    try {
      const result = await MemoryApi.applyInstruction(text);
      if (result.ok) {
        // 主进程已应用并落库（修订 B）：失效缓存拉新值，展示随刷新
        await queryClient.invalidateQueries({ queryKey: ["personalization"] });
        setInstruction("");
      } else {
        toast.error(t(`settings:memory.error.${result.error}`));
      }
    } catch {
      toast.error(t("settings:memory.toast.instructionFailed"));
    } finally {
      setApplying(false);
    }
  }, [instruction, queryClient, t]);

  /**
   * 立即整理（对齐 WorkBuddy 主动触发更新）：手动跑一次夜间同款编译
   * 管线；成功刷新展示 + toast，错误码映射与指令路径同构。与定时整理
   * 共享 inflight 互斥，冲突时后端返回 MEMORY_BUSY
   */
  const compileNow = useCallback(async () => {
    setCompiling(true);
    try {
      const result = await MemoryApi.compileNow();
      if (result.ok) {
        await queryClient.invalidateQueries({ queryKey: ["personalization"] });
        toast.success(t("settings:memory.toast.compiled"));
      } else {
        toast.error(t(`settings:memory.error.${result.error}`));
      }
    } catch {
      toast.error(t("settings:memory.error.MEMORY_COMPILE_FAILED"));
    } finally {
      setCompiling(false);
    }
  }, [queryClient, t]);

  const changeEnabled = useCallback(
    (checked: boolean) => {
      if (!checked) {
        // 开关关：退出指令模式（记忆转只读，指令会被后端
        // MEMORY_DISABLED 拒绝，编辑入口同步禁用），无确认弹窗（D3 裁决）
        setEditing(false);
      }
      setEnabled(checked);
      revert(persistQuiet(PERSONALIZATION_KEYS.memoryEnabled, checked), () =>
        setEnabled(!checked),
      );
    },
    [persistQuiet, revert],
  );

  const changeModelId = useCallback(
    (value: string) => {
      const previous = modelId;
      setModelId(value);
      revert(persistQuiet(PERSONALIZATION_KEYS.memoryModelId, value), () =>
        setModelId(previous),
      );
    },
    [modelId, persistQuiet, revert],
  );

  const hasProfile = options.memoryProfile.trim() !== "";

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          {t("settings:memory.title")}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings:memory.description")}
        </p>
      </header>
      <section className="rounded-lg border border-border/50 bg-card p-4">
        <SettingSwitchRow
          label="settings:memory.toggle.label"
          description="settings:memory.toggle.desc"
          checked={enabled}
          onCheckedChange={changeEnabled}
        />
        <MemoryModelRow value={modelId} onChange={changeModelId} />
      </section>
      <ManageMemoryCard
        editing={editing}
        editDisabled={!enabled}
        sections={sections}
        lastCompiledAt={options.memoryLastCompiledAt}
        lastError={options.memoryLastError}
        instruction={instruction}
        onInstructionChange={setInstruction}
        applying={applying}
        compiling={compiling}
        onSubmitInstruction={submitInstruction}
        onCompileNow={compileNow}
        onToggleEditing={toggleEditing}
        onReset={() => setResetOpen(true)}
        onImport={() => setImportOpen(true)}
        onExportJson={exportMemory}
        onImportJsonPick={() => importJsonInputRef.current?.click()}
        onEntryDelete={(sectionKey, lineIndex) =>
          void deleteEntry(sectionKey, lineIndex)
        }
        onEntryJump={(msgId) => void jumpToSource(msgId)}
        showContent={editing || hasProfile}
      />
      {/* 批9 导入 JSON：原生文件选择器（accept 收口 .json），选择即导入 */}
      <input
        ref={importJsonInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // 同文件可重复选择
          if (file) {
            void importJsonFile(file);
          }
        }}
      />
      <ResetMemoryDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        onConfirm={confirmReset}
      />
      <ImportMemoryDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        currentMemory={options.memoryProfile}
        onImported={importMemory}
      />
      {!editing && !hasProfile && (
        <EmptyMemoryCard
          enabled={enabled}
          onEnable={() => changeEnabled(true)}
        />
      )}
      {!enabled && <DisabledNotice />}
    </div>
  );
}

/** Radix Select 禁止空串 value：空（自动）选项用哨兵值 */
const AUTO_MODEL_VALUE = "auto";

/**
 * 记忆整理模型选择行：自动（默认/启用池解析）或强指定某模型。
 * 即时生效（乐观更新 + revert 回滚，与开关行同构）；指定模型被删除/
 * 禁用时主进程解析会自动回退，不阻塞记忆整理
 */
function MemoryModelRow({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(["settings"]);
  const { data: models } = useQuery({
    queryKey: ["models", "all"],
    queryFn: () => ModelApi.listAll(),
  });

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-border/50 pt-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-normal">
          {t("settings:memory.model.label")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("settings:memory.model.desc")}
        </p>
      </div>
      <Select
        value={value === "" ? AUTO_MODEL_VALUE : value}
        onValueChange={(next) =>
          onChange(next === AUTO_MODEL_VALUE ? "" : next)
        }
      >
        <SelectTrigger
          aria-label={t("settings:memory.model.label")}
          className="w-[220px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-lg border-border/50 shadow-lg">
          <SelectItem value={AUTO_MODEL_VALUE}>
            {t("settings:memory.model.auto")}
          </SelectItem>
          {(models ?? []).map((model) => (
            <SelectItem key={model.id} value={String(model.id)}>
              {modelDisplayName(model)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface ManageMemoryCardProps {
  editing: boolean;
  editDisabled: boolean;
  sections: MemorySections;
  lastCompiledAt: string;
  lastError: string;
  instruction: string;
  onInstructionChange: Dispatch<SetStateAction<string>>;
  applying: boolean;
  compiling: boolean;
  onSubmitInstruction: () => Promise<void>;
  onCompileNow: () => Promise<void>;
  onToggleEditing: () => void;
  onReset: () => void;
  onImport: () => void;
  /** 批9：记忆导出 JSON / 导入 JSON 文件选择 */
  onExportJson: () => void;
  onImportJsonPick: () => void;
  /** 批9 逐条删除 / 来源会话跳转 */
  onEntryDelete: (sectionKey: MemorySectionKey, lineIndex: number) => void;
  onEntryJump: (msgId: number) => void;
  showContent: boolean;
}

/**
 * 管理记忆卡片（spec §6.1 单卡结构）：头部按钮（重置 + 立即整理 +
 * 编辑/完成 + 导入 + 导出/导入 JSON，导入常驻修订 B）+ 整理状态行（上次
 * 整理时间 / 失败原因）+ 卡内四板块只读内容区（超高右侧滚动；批9：条目
 * 行 hover 出逐条删除与来源会话跳转）。指令模式底部追加 AI 指令框，
 * 应用中「完成」禁用，防指令未落定就退出。
 */
function ManageMemoryCard(props: ManageMemoryCardProps) {
  const { t } = useTranslation(["settings"]);
  const {
    editing,
    editDisabled,
    sections,
    lastCompiledAt,
    lastError,
    instruction,
    onInstructionChange,
    applying,
    compiling,
    onSubmitInstruction,
    onCompileNow,
    onToggleEditing,
    onReset,
    onImport,
    onExportJson,
    onImportJsonPick,
    onEntryDelete,
    onEntryJump,
    showContent,
  } = props;

  const compiledDate = new Date(lastCompiledAt);
  const lastCompiledText =
    lastCompiledAt.trim() !== "" && !Number.isNaN(compiledDate.getTime())
      ? t("settings:memory.status.lastCompiledAt", {
          time: formatDistanceToNow(compiledDate, {
            addSuffix: true,
            locale: getDateFnsLocale(),
          }),
        })
      : t("settings:memory.status.neverCompiled");

  return (
    <section className="rounded-lg border border-border/50 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-foreground">
            {t("settings:memory.manage.title")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("settings:memory.manage.subtitle")}
          </p>
          <p className="text-xs text-muted-foreground">{lastCompiledText}</p>
          {lastError.trim() !== "" && (
            <p className="break-words text-xs text-destructive">
              {t("settings:memory.status.errorPrefix")}
              {lastError}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            className="border-destructive/50 text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {t("settings:memory.actions.reset")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onCompileNow}
            disabled={compiling || editDisabled}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {compiling ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {t("settings:memory.actions.compileNow")}
          </Button>
          <Button
            variant={editing ? "default" : "outline"}
            size="sm"
            onClick={onToggleEditing}
            disabled={editing ? applying : editDisabled}
            className={
              editing
                ? undefined
                : "hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            }
          >
            {editing
              ? t("settings:memory.edit.done")
              : t("settings:memory.actions.edit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onImport}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("settings:memory.actions.import")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onExportJson}
            aria-label={t("settings:memory.actions.exportJson")}
            title={t("settings:memory.actions.exportJson")}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            <Download size={14} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onImportJsonPick}
            aria-label={t("settings:memory.actions.importJson")}
            title={t("settings:memory.actions.importJson")}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            <Upload size={14} />
          </Button>
        </div>
      </div>
      {showContent && (
        <div className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {MEMORY_SECTION_DEFS.map(({ key }) => (
            <MemorySectionBlock
              key={key}
              sectionKey={key}
              text={sections[key]}
              onEntryDelete={onEntryDelete}
              onEntryJump={onEntryJump}
            />
          ))}
        </div>
      )}
      {editing && (
        <InstructionBar
          instruction={instruction}
          onInstructionChange={onInstructionChange}
          applying={applying}
          onSubmitInstruction={onSubmitInstruction}
        />
      )}
    </section>
  );
}

interface InstructionBarProps {
  instruction: string;
  onInstructionChange: Dispatch<SetStateAction<string>>;
  applying: boolean;
  onSubmitInstruction: () => Promise<void>;
}

/** 指令模式底部输入行：多行 Textarea + 发送按钮 + 应用中提示 */
function InstructionBar(props: InstructionBarProps) {
  const { t } = useTranslation(["settings"]);
  const { instruction, onInstructionChange, applying, onSubmitInstruction } =
    props;

  /**
   * Enter 提交指令（空指令不触发），Shift+Enter 换行（多行输入框；
   * 对齐 WorkBuddy 修改建议框的聊天式输入体验）
   */
  const handleInstructionKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !applying &&
      instruction.trim() !== ""
    ) {
      event.preventDefault();
      void onSubmitInstruction();
    }
  };

  return (
    <div className="mt-4 flex items-end gap-2">
      <Textarea
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        onKeyDown={handleInstructionKeyDown}
        placeholder={t("settings:memory.edit.instructionPlaceholder")}
        maxLength={INSTRUCTION_MAX_LENGTH}
        disabled={applying}
        rows={2}
        className="min-h-[52px] resize-none text-xs"
      />
      <IconTooltip label={t("settings:memory.edit.send")}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => void onSubmitInstruction()}
          disabled={applying || instruction.trim() === ""}
          aria-label={t("settings:memory.edit.send")}
        >
          {applying ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Send size={14} />
          )}
        </Button>
      </IconTooltip>
      {applying && (
        <span className="shrink-0 pb-2 text-xs text-muted-foreground">
          {t("settings:memory.edit.applying")}
        </span>
      )}
    </div>
  );
}

/** 空状态：开关开 → 等待首次编译文案；开关关 → 「去开启」按钮引导 */
function EmptyMemoryCard({
  enabled,
  onEnable,
}: {
  enabled: boolean;
  onEnable: () => void;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <section className="rounded-lg border border-dashed border-border/50 bg-card p-4">
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <Brain size={24} className="text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t("settings:memory.empty.title")}
        </p>
        {enabled ? (
          <p className="text-xs text-muted-foreground">
            {t("settings:memory.empty.pending")}
          </p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onEnable}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("settings:memory.empty.enable")}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * 单节（只读 + 逐条管理）：标题 + 逐条目行渲染。条目行即
 * "[YYYY-MM-DD|#msgId] - 内容" 格式（自带分隔符），逐行成段（markdown
 * 单换行会被合并成段）；批9：条目行 hover 出「查看来源会话」（有
 * |#msgId 溯源时）与「删除」操作（对齐 ChatGPT Memories 列表体验）
 */
function MemorySectionBlock({
  sectionKey,
  text,
  onEntryDelete,
  onEntryJump,
}: {
  sectionKey: MemorySectionKey;
  text: string;
  onEntryDelete: (sectionKey: MemorySectionKey, lineIndex: number) => void;
  onEntryJump: (msgId: number) => void;
}) {
  const { t } = useTranslation(["settings"]);
  const lines = useMemo(
    () =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    [text],
  );

  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium text-foreground">
        {t(`settings:memory.sections.${sectionKey}`)}
      </h4>
      {lines.length > 0 && (
        <div className="space-y-1">
          {lines.map((line, index) => (
            <MemoryEntryRow
              key={`${index}-${line}`}
              line={line}
              onDelete={() => onEntryDelete(sectionKey, index)}
              onJump={onEntryJump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单条目行：正文 markdown 只读 + hover 操作（来源跳转 / 删除） */
function MemoryEntryRow({
  line,
  onDelete,
  onJump,
}: {
  line: string;
  onDelete: () => void;
  onJump: (msgId: number) => void;
}) {
  const { t } = useTranslation(["settings"]);
  const entry = parseMemoryEntry(line);

  return (
    <div className="group/entry flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <MemoryMarkdown text={line} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/entry:opacity-100">
        {entry.msgId !== null && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onJump(entry.msgId as number)}
            aria-label={t("settings:memory.entry.jump")}
            title={t("settings:memory.entry.jump")}
            className="h-6 w-6 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <MessageSquare size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          aria-label={t("settings:memory.entry.delete")}
          title={t("settings:memory.entry.delete")}
          className="h-6 w-6 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

/** 开关关闭时的底部提示条：记忆转为只读，不再自动更新 */
function DisabledNotice() {
  const { t } = useTranslation(["settings"]);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/50 p-3 text-xs text-muted-foreground">
      <Info size={14} className="shrink-0" />
      {t("settings:memory.disabledNotice")}
    </div>
  );
}
