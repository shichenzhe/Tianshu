/**
 * 记忆与进化页：页头说明 + 记忆开关（即时生效）+ 管理记忆卡片（spec §6.1
 * 单卡结构：头部按钮 + 卡内四板块内容区，超高右侧滚动）。展示态四板块
 * 只读（单条 >500 字折叠）；编辑态四板块变 Textarea + 底部 AI 指令输入框
 * （指令仅刷新草稿不落库，用户点「保存」才持久化，spec §5.4）。读取复用
 * ["personalization"] React Query 缓存，开关复用乐观更新 + revert 失败
 * 回滚模式（与 ProfileGroup 的 ToggleSection 同构）。
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
import { Brain, ChevronDown, Info, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MemoryApi } from "../api/memory.api";
import { SettingsApi } from "../api/settings.api";
import {
  MEMORY_SECTION_DEFS,
  buildMemoryMarkdown,
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
import ResetMemoryDialog from "./memory/ResetMemoryDialog";
import SettingSwitchRow from "./SettingSwitchRow";

/** 单条（单行）超过该字数折叠，点「展开」查看全文（spec §6.2 单条粒度） */
const LINE_COLLAPSE_LIMIT = 500;

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

  const persistQuiet = useCallback<PersistFn>(
    async (key, value) => {
      await savePersonalizationOption(key, value);
      await queryClient.invalidateQueries({ queryKey: ["personalization"] });
    },
    [queryClient],
  );

  /** 展示态四节（当前持久化内容切分）：编辑初值 / 取消回滚基准 */
  const sections = useMemo(
    () => parseMemoryMarkdown(options.memoryProfile),
    [options.memoryProfile],
  );

  const [enabled, setEnabled] = useState(options.memoryEnabled);
  useEffect(() => setEnabled(options.memoryEnabled), [options.memoryEnabled]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MemorySections>(sections);
  const [draftTouched, setDraftTouched] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [applying, setApplying] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // 草稿跟随展示态四节（含数据晚到/失效刷新），用户改过草稿后不再覆盖
  // （防数据慢到时以空草稿覆写记忆）
  useEffect(() => {
    if (!editing || !draftTouched) {
      setDraft(sections);
    }
  }, [editing, draftTouched, sections]);

  /** 用户改草稿（textarea 输入 / AI 指令刷新）即标记，退出编辑时复位 */
  const changeDraft = useCallback(
    (updater: (previous: MemorySections) => MemorySections) => {
      setDraftTouched(true);
      setDraft(updater);
    },
    [],
  );

  const enterEdit = useCallback(() => {
    setDraftTouched(false);
    setEditing(true);
  }, []);

  const cancelEdit = useCallback(() => {
    setDraftTouched(false);
    setEditing(false);
  }, []);

  const saveEdit = useCallback(async () => {
    try {
      await persistQuiet(
        PERSONALIZATION_KEYS.memoryProfile,
        buildMemoryMarkdown(draft),
      );
      toast.success(t("settings:memory.toast.saved"));
      setEditing(false);
    } catch {
      toast.error(t("settings:error.saveFailed"));
    }
  }, [draft, persistQuiet, t]);

  /** 重置确认（spec §6.3）：编辑态点重置先退出编辑丢弃草稿，再清空记忆 */
  const confirmReset = useCallback(async () => {
    setDraftTouched(false);
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
        // 指令模式不落库（spec §5.4）：返回草稿刷新文本域，保存才持久化
        changeDraft(() => parseMemoryMarkdown(result.memory ?? ""));
        setInstruction("");
      } else {
        toast.error(t(`settings:memory.error.${result.error}`));
      }
    } catch {
      toast.error(t("settings:memory.toast.instructionFailed"));
    } finally {
      setApplying(false);
    }
  }, [changeDraft, instruction, t]);

  const changeEnabled = useCallback(
    (checked: boolean) => {
      if (!checked) {
        // D3 裁决：编辑态关开关 → 退出编辑转只读（草稿由上方 effect 丢弃），
        // 无确认弹窗
        setDraftTouched(false);
        setEditing(false);
      }
      setEnabled(checked);
      revert(persistQuiet(PERSONALIZATION_KEYS.memoryEnabled, checked), () =>
        setEnabled(!checked),
      );
    },
    [persistQuiet, revert],
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
      </section>
      <ManageMemoryCard
        editing={editing}
        sections={sections}
        draft={draft}
        onDraftChange={changeDraft}
        instruction={instruction}
        onInstructionChange={setInstruction}
        applying={applying}
        onSubmitInstruction={submitInstruction}
        onEnterEdit={enterEdit}
        onCancelEdit={cancelEdit}
        onSaveEdit={saveEdit}
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

interface ManageMemoryCardProps {
  editing: boolean;
  sections: MemorySections;
  draft: MemorySections;
  onDraftChange: (
    updater: (previous: MemorySections) => MemorySections,
  ) => void;
  instruction: string;
  onInstructionChange: Dispatch<SetStateAction<string>>;
  applying: boolean;
  onSubmitInstruction: () => Promise<void>;
  onEnterEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => Promise<void>;
  onReset: () => void;
  onImport: () => void;
  showContent: boolean;
}

/**
 * 管理记忆卡片（spec §6.1 单卡结构）：头部按钮（展示态 重置/编辑/导入，
 * 编辑态 重置/取消/保存、导入隐藏）+ 卡内四板块内容区（超高右侧滚动）。
 * AI 指令应用中取消/保存禁用，防指令未落定就退出/覆盖编辑。
 */
function ManageMemoryCard(props: ManageMemoryCardProps) {
  const { t } = useTranslation(["settings"]);
  const {
    editing,
    sections,
    draft,
    onDraftChange,
    instruction,
    onInstructionChange,
    applying,
    onSubmitInstruction,
    onEnterEdit,
    onCancelEdit,
    onSaveEdit,
    onReset,
    onImport,
    showContent,
  } = props;
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
          {editing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onCancelEdit}
                disabled={applying}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("settings:memory.edit.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => void onSaveEdit()}
                disabled={applying}
              >
                {t("settings:memory.edit.save")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onEnterEdit}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("settings:memory.actions.edit")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onImport}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("settings:memory.actions.import")}
              </Button>
            </>
          )}
        </div>
      </div>
      {showContent && (
        <div className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {editing ? (
            <EditableMemorySections
              draft={draft}
              onDraftChange={onDraftChange}
              instruction={instruction}
              onInstructionChange={onInstructionChange}
              applying={applying}
              onSubmitInstruction={onSubmitInstruction}
            />
          ) : (
            MEMORY_SECTION_DEFS.map(({ key }) => (
              <MemorySectionBlock
                key={key}
                sectionKey={key}
                text={sections[key]}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

interface EditableMemorySectionsProps {
  draft: MemorySections;
  onDraftChange: (
    updater: (previous: MemorySections) => MemorySections,
  ) => void;
  instruction: string;
  onInstructionChange: Dispatch<SetStateAction<string>>;
  applying: boolean;
  onSubmitInstruction: () => Promise<void>;
}

/** 编辑态内容区：四板块 Textarea（draft 受控）+ 底部 AI 指令输入行 */
function EditableMemorySections(props: EditableMemorySectionsProps) {
  const { t } = useTranslation(["settings"]);
  const {
    draft,
    onDraftChange,
    instruction,
    onInstructionChange,
    applying,
    onSubmitInstruction,
  } = props;

  const changeSection = (key: MemorySectionKey, value: string) => {
    onDraftChange((previous) => {
      const next: MemorySections = { ...previous };
      next[key] = value;
      return next;
    });
  };

  /** Enter 提交指令（空指令不触发），Shift 无换行语义（单行输入框） */
  const handleInstructionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !applying && instruction.trim() !== "") {
      event.preventDefault();
      void onSubmitInstruction();
    }
  };

  return (
    <div className="space-y-5">
      {MEMORY_SECTION_DEFS.map(({ key }) => (
        <div key={key} className="space-y-1.5">
          <h4 className="text-sm font-medium text-foreground">
            {t(`settings:memory.sections.${key}`)}
          </h4>
          <Textarea
            aria-label={t(`settings:memory.sections.${key}`)}
            value={draft[key]}
            onChange={(event) => changeSection(key, event.target.value)}
            className="min-h-[80px] text-xs leading-relaxed"
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          onKeyDown={handleInstructionKeyDown}
          placeholder={t("settings:memory.edit.instructionPlaceholder")}
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

/** 单节：标题 + 逐行正文（近期动态行首加 "- "）；单条 >500 字折叠可展开 */
function MemorySectionBlock({
  sectionKey,
  text,
}: {
  sectionKey: MemorySectionKey;
  text: string;
}) {
  const { t } = useTranslation(["settings"]);
  const [expandedLines, setExpandedLines] = useState<number[]>([]);
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  const expandLine = (index: number) =>
    setExpandedLines((previous) => [...previous, index]);

  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium text-foreground">
        {t(`settings:memory.sections.${sectionKey}`)}
      </h4>
      <div className="space-y-1 text-xs leading-relaxed text-foreground/80">
        {lines.map((line, index) => {
          const collapsed =
            line.length > LINE_COLLAPSE_LIMIT && !expandedLines.includes(index);
          const content = collapsed ? line.slice(0, LINE_COLLAPSE_LIMIT) : line;
          return (
            <p key={index}>
              {sectionKey === "recent" ? `- ${content}` : content}
              {collapsed && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => expandLine(index)}
                  className="ml-1 h-6 px-2 align-middle text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                >
                  <ChevronDown size={12} />
                  {t("settings:memory.expand")}
                </Button>
              )}
            </p>
          );
        })}
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
