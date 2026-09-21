/**
 * 记忆与进化页：页头说明 + 记忆开关（即时生效）+ 管理记忆卡片（spec §6.1
 * 单卡结构：头部按钮 + 卡内四板块内容区，超高右侧滚动）。修订 B：四板块
 * 正文永远只读 markdown 渲染；「编辑」按钮切换 AI 指令模式——底部出现指令
 * 框，指令由主进程直接应用并落库，成功后失效 ["personalization"] 缓存刷新
 * 展示（无草稿/保存/取消概念）；导入按钮常驻；管理卡头部显示上次整理时间
 * 与失败原因（memoryLastCompiledAt / memoryLastError，失败可观测）。
 * 开关复用乐观更新 + revert 失败回滚模式（与 ProfileGroup 的
 * ToggleSection 同构）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Brain, Info, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { getDateFnsLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelApi } from "@/domains/ai/api/model.api";
import { MemoryApi } from "../api/memory.api";
import { SettingsApi } from "../api/settings.api";
import {
  MEMORY_SECTION_DEFS,
  parseMemoryMarkdown,
  type MemorySectionKey,
  type MemorySections,
} from "../model/memory-markdown";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalizationOptions,
  parsePersonalizationOptions,
  savePersonalizationOption,
} from "../model/personalization-options";
import { useSaveOrRevert } from "../model/use-save-or-revert";
import ImportMemoryDialog from "./memory/ImportMemoryDialog";
import MemoryMarkdown from "./memory/MemoryMarkdown";
import ResetMemoryDialog from "./memory/ResetMemoryDialog";
import SettingSwitchRow from "./SettingSwitchRow";

/** AI 指令输入框限长（M1 前端侧；主进程入口另有 2000 截断兜底） */
const INSTRUCTION_MAX_LENGTH = 500;

/** 保存函数签名（与 ProfileGroup 的 PersistFn 同构） */
type PersistFn = (
  key: (typeof PERSONALIZATION_KEYS)[keyof typeof PERSONALIZATION_KEYS],
  value: string | boolean,
) => Promise<void>;

export default function MemoryGroup() {
  const { t } = useTranslation(["settings"]);
  const queryClient = useQueryClient();
  const { data: items } = useQuery({
    queryKey: ["personalization"],
    queryFn: () => SettingsApi.getAll(),
    staleTime: Infinity,
  });
  const options = useMemo(
    () =>
      items
        ? parsePersonalizationOptions(items)
        : defaultPersonalizationOptions(),
    [items],
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
  const [resetOpen, setResetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  /** 编辑按钮 = 进入指令模式 / 完成按钮 = 退出 */
  const toggleEditing = useCallback(() => {
    setEditing((previous) => !previous);
  }, []);

  /** 重置确认（spec §6.3）：退出指令模式并清空记忆 */
  const confirmReset = useCallback(async () => {
    setEditing(false);
    await persistQuiet(PERSONALIZATION_KEYS.memoryProfile, "");
  }, [persistQuiet]);

  /** 导入落库（spec §6.4）：合并结果追加持久化（弹窗侧已 merge） */
  const importMemory = useCallback(
    async (merged: string) => {
      await persistQuiet(PERSONALIZATION_KEYS.memoryProfile, merged);
    },
    [persistQuiet],
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
        onSubmitInstruction={submitInstruction}
        onToggleEditing={toggleEditing}
        onReset={() => setResetOpen(true)}
        onImport={() => setImportOpen(true)}
        showContent={editing || hasProfile}
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
              {model.name?.trim() !== "" ? model.name : model.modelId}
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
  onSubmitInstruction: () => Promise<void>;
  onToggleEditing: () => void;
  onReset: () => void;
  onImport: () => void;
  showContent: boolean;
}

/**
 * 管理记忆卡片（spec §6.1 单卡结构）：头部按钮（重置 + 编辑/完成 + 导入，
 * 导入常驻修订 B）+ 整理状态行（上次整理时间 / 失败原因）+ 卡内四板块
 * 只读内容区（超高右侧滚动）。指令模式底部追加 AI 指令框，应用中「完成」
 * 禁用，防指令未落定就退出。
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
    onSubmitInstruction,
    onToggleEditing,
    onReset,
    onImport,
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
        </div>
      </div>
      {showContent && (
        <div className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {MEMORY_SECTION_DEFS.map(({ key }) => (
            <MemorySectionBlock
              key={key}
              sectionKey={key}
              text={sections[key]}
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

/** 指令模式底部输入行：Input + 发送按钮 + 应用中提示 */
function InstructionBar(props: InstructionBarProps) {
  const { t } = useTranslation(["settings"]);
  const { instruction, onInstructionChange, applying, onSubmitInstruction } =
    props;

  /** Enter 提交指令（空指令不触发），Shift 无换行语义（单行输入框） */
  const handleInstructionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !applying && instruction.trim() !== "") {
      event.preventDefault();
      void onSubmitInstruction();
    }
  };

  return (
    <div className="mt-4 flex items-center gap-2">
      <Input
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        onKeyDown={handleInstructionKeyDown}
        placeholder={t("settings:memory.edit.instructionPlaceholder")}
        maxLength={INSTRUCTION_MAX_LENGTH}
        disabled={applying}
        className="h-8 text-xs"
      />
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
      {applying && (
        <span className="shrink-0 text-xs text-muted-foreground">
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
 * 单节（只读）：标题 + 正文 markdown 渲染。近期动态条目行首加 "- "
 * 列表化；非列表行以空行分隔保证逐行成段（markdown 单换行会被合并成段）
 */
function MemorySectionBlock({
  sectionKey,
  text,
}: {
  sectionKey: MemorySectionKey;
  text: string;
}) {
  const { t } = useTranslation(["settings"]);
  const body = useMemo(() => {
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    const items = lines.map((line) =>
      sectionKey === "recent" ? `- ${line}` : line,
    );
    // 列表行紧邻组成同一列表，普通行空行分隔逐行成段
    return items.join(sectionKey === "recent" ? "\n" : "\n\n");
  }, [sectionKey, text]);

  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium text-foreground">
        {t(`settings:memory.sections.${sectionKey}`)}
      </h4>
      {body !== "" && <MemoryMarkdown text={body} />}
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
