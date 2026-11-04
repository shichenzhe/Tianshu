/**
 * 个性化设置页（profile tab 整页，spec §5.2）：基础交互（风格+两开关）/
 * 自定义指令/称呼与身份/高级人设与记忆。
 * 配置存 option 表（personalization.* 前缀）；读走 React Query
 * ["personalization"] 缓存（staleTime Infinity），保存成功后失效——
 * 聊天界面两个 UI 开关（Task 7 usePersonalizationUi）即时生效。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Pencil } from "lucide-react";

import { SettingsApi } from "../api/settings.api";
import { useSaveOrRevert } from "../model/use-save-or-revert";
import {
  DEFAULT_PERSONA,
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalizationOptions,
  parsePersonalizationOptions,
  savePersonalizationOption,
  type PersonalizationOptions,
  type ResponseStyle,
} from "../model/personalization-options";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingsGroup from "./SettingsGroup";
import SettingSwitchRow from "./SettingSwitchRow";
import LongTextEditorDialog from "./LongTextEditorDialog";

/** 风格下拉可选项（展示顺序即选项顺序） */
const STYLE_OPTIONS: ResponseStyle[] = [
  "default",
  "professional",
  "friendly",
  "direct",
  "imaginative",
  "pragmatic",
  "snarky",
  "socratic",
];

/** 高级区摘要截断长度 */
const SUMMARY_SLICE = 60;

/** 单项持久化函数类型（key 为完整 option 名，即 PERSONALIZATION_KEYS 的值） */
type PersistFn = (
  key: (typeof PERSONALIZATION_KEYS)[keyof typeof PERSONALIZATION_KEYS],
  value: string | boolean,
) => Promise<void>;

interface SectionProps {
  options: PersonalizationOptions;
  /** 静默持久化（保存 + 失效缓存，不 toast）——反馈由调用处自定 */
  persistQuiet: PersistFn;
}

export default function ProfileGroup() {
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

  /** 控件直存路径：成功 toast（失败由调用方 revert 兜底或 catch toast） */
  const persist = useCallback<PersistFn>(
    async (key, value) => {
      await persistQuiet(key, value);
      toast.success(t("settings:personalization.savedToast"));
    },
    [persistQuiet, t],
  );

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("settings:personalization.groups.basic")}>
        <StyleSection
          options={options}
          persistQuiet={persistQuiet}
          persist={persist}
          revert={revert}
        />
        <ToggleSection
          options={options}
          persistQuiet={persistQuiet}
          persist={persist}
          revert={revert}
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings:personalization.groups.instructions")}>
        <InstructionsSection options={options} persistQuiet={persistQuiet} />
      </SettingsGroup>
      <SettingsGroup title={t("settings:personalization.groups.identity")}>
        <IdentitySection options={options} persistQuiet={persistQuiet} />
      </SettingsGroup>
      <SettingsGroup title={t("settings:personalization.groups.advanced")}>
        <AdvancedSection options={options} persistQuiet={persistQuiet} />
      </SettingsGroup>
    </div>
  );
}

/** 基础交互：回复风格下拉（选中即存）+ 当前风格描述小字 */
function StyleSection({
  options,
  persist,
  revert,
}: SectionProps & {
  persist: PersistFn;
  revert: (save: Promise<void>, rollback: () => void) => void;
}) {
  const { t } = useTranslation(["settings"]);
  const [style, setStyle] = useState(options.responseStyle);
  useEffect(() => setStyle(options.responseStyle), [options.responseStyle]);

  const changeStyle = (value: ResponseStyle) => {
    const rollback = () => setStyle(options.responseStyle);
    setStyle(value);
    revert(persist(PERSONALIZATION_KEYS.responseStyle, value), rollback);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-normal">
          {t("settings:personalization.style.label")}
        </Label>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-40 justify-between font-normal hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              {t(`settings:personalization.style.options.${style}.label`)}
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 border border-border/50 rounded-lg shadow-lg"
          >
            {STYLE_OPTIONS.map((value) => (
              <DropdownMenuItem
                key={value}
                onClick={() => changeStyle(value)}
                className="cursor-pointer"
              >
                {t(`settings:personalization.style.options.${value}.label`)}
                {value === style && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(`settings:personalization.style.options.${style}.desc`)}
      </p>
    </div>
  );
}

/** 基础交互：两个开关行（乐观更新 + 失败回滚） */
function ToggleSection({
  options,
  persist,
  revert,
}: SectionProps & {
  persist: PersistFn;
  revert: (save: Promise<void>, rollback: () => void) => void;
}) {
  const [welcomeLoading, setWelcomeLoading] = useState(options.welcomeLoading);
  const [fileChangeDetails, setFileChangeDetails] = useState(
    options.fileChangeDetails,
  );
  useEffect(
    () => setWelcomeLoading(options.welcomeLoading),
    [options.welcomeLoading],
  );
  useEffect(
    () => setFileChangeDetails(options.fileChangeDetails),
    [options.fileChangeDetails],
  );

  const changeWelcome = (checked: boolean) => {
    setWelcomeLoading(checked);
    revert(persist(PERSONALIZATION_KEYS.welcomeLoading, checked), () =>
      setWelcomeLoading(!checked),
    );
  };
  const changeFileDetails = (checked: boolean) => {
    setFileChangeDetails(checked);
    revert(persist(PERSONALIZATION_KEYS.fileChangeDetails, checked), () =>
      setFileChangeDetails(!checked),
    );
  };

  return (
    <>
      <SettingSwitchRow
        label="settings:personalization.welcomeLoading.label"
        description="settings:personalization.welcomeLoading.desc"
        checked={welcomeLoading}
        onCheckedChange={changeWelcome}
      />
      <SettingSwitchRow
        label="settings:personalization.fileChangeDetails.label"
        description="settings:personalization.fileChangeDetails.desc"
        checked={fileChangeDetails}
        onCheckedChange={changeFileDetails}
      />
    </>
  );
}

/** 自定义指令：Textarea + 字数统计 + 显式保存按钮 */
function InstructionsSection({ options, persistQuiet }: SectionProps) {
  const { t } = useTranslation(["settings"]);
  const limit = PERSONALIZATION_LIMITS.customInstructions;
  const [draft, setDraft] = useState(options.customInstructions);
  const [saving, setSaving] = useState(false);
  useEffect(
    () => setDraft(options.customInstructions),
    [options.customInstructions],
  );
  const dirty = draft !== options.customInstructions;

  const save = async () => {
    setSaving(true);
    try {
      await persistQuiet(PERSONALIZATION_KEYS.customInstructions, draft);
      toast.success(t("settings:personalization.savedToast"));
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-normal">
        {t("settings:personalization.customInstructions.label")}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t("settings:personalization.customInstructions.desc")}
      </p>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={limit}
        placeholder={t(
          "settings:personalization.customInstructions.placeholder",
        )}
        aria-label={t("settings:personalization.customInstructions.label")}
        className="min-h-24"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {t("settings:personalization.charCount", {
            count: draft.length,
            max: limit,
          })}
        </span>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {t("settings:personalization.editor.save")}
        </Button>
      </div>
    </div>
  );
}

/** 称呼与身份：两个 Input + 保存按钮（一次保存两个字段，单次 toast） */
function IdentitySection({ options, persistQuiet }: SectionProps) {
  const { t } = useTranslation(["settings"]);
  const [nickname, setNickname] = useState(options.userNickname);
  const [aiName, setAiName] = useState(options.aiName);
  const [saving, setSaving] = useState(false);
  useEffect(() => setNickname(options.userNickname), [options.userNickname]);
  useEffect(() => setAiName(options.aiName), [options.aiName]);
  const dirty = nickname !== options.userNickname || aiName !== options.aiName;

  const save = async () => {
    setSaving(true);
    try {
      await persistQuiet(PERSONALIZATION_KEYS.userNickname, nickname);
      await persistQuiet(PERSONALIZATION_KEYS.aiName, aiName);
      toast.success(t("settings:personalization.savedToast"));
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-normal">
          {t("settings:personalization.userNickname.label")}
        </Label>
        <Input
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          maxLength={PERSONALIZATION_LIMITS.userNickname}
          placeholder={t("settings:personalization.userNickname.placeholder")}
          aria-label={t("settings:personalization.userNickname.label")}
          className="w-64"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-sm font-normal">
          {t("settings:personalization.aiName.label")}
        </Label>
        <Input
          value={aiName}
          onChange={(event) => setAiName(event.target.value)}
          maxLength={PERSONALIZATION_LIMITS.aiName}
          placeholder={t("settings:personalization.aiName.placeholder")}
          aria-label={t("settings:personalization.aiName.label")}
          className="w-64"
        />
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {t("settings:personalization.editor.save")}
        </Button>
      </div>
    </div>
  );
}

/** 高级人设与记忆：摘要行 + 编辑弹窗（人设未设置时预填 DEFAULT_PERSONA） */
function AdvancedSection({ options, persistQuiet }: SectionProps) {
  const { t } = useTranslation(["settings"]);
  const [editing, setEditing] = useState<"persona" | "memory" | null>(null);
  const personaEmpty = options.persona.trim() === "";
  const memoryEmpty = options.memory.trim() === "";

  const savePersona = async (value: string) => {
    await persistQuiet(PERSONALIZATION_KEYS.persona, value);
  };
  const saveMemory = async (value: string) => {
    await persistQuiet(PERSONALIZATION_KEYS.memory, value);
  };

  return (
    <>
      <SummaryRow
        label={t("settings:personalization.persona.label")}
        description={t("settings:personalization.persona.desc")}
        summary={
          personaEmpty
            ? t("settings:personalization.persona.empty")
            : options.persona.slice(0, SUMMARY_SLICE)
        }
        onEdit={() => setEditing("persona")}
      />
      <SummaryRow
        label={t("settings:personalization.memory.label")}
        description={t("settings:personalization.memory.desc")}
        summary={
          memoryEmpty
            ? t("settings:personalization.memory.empty")
            : options.memory.slice(0, SUMMARY_SLICE)
        }
        onEdit={() => setEditing("memory")}
      />
      <LongTextEditorDialog
        open={editing === "persona"}
        onOpenChange={(open) => !open && setEditing(null)}
        title={t("settings:personalization.persona.label")}
        initialValue={personaEmpty ? DEFAULT_PERSONA : options.persona}
        maxLength={PERSONALIZATION_LIMITS.persona}
        onSave={savePersona}
      />
      <LongTextEditorDialog
        open={editing === "memory"}
        onOpenChange={(open) => !open && setEditing(null)}
        title={t("settings:personalization.memory.label")}
        initialValue={options.memory}
        maxLength={PERSONALIZATION_LIMITS.memory}
        onSave={saveMemory}
      />
    </>
  );
}

/** 高级区单行：标题 + 说明 + 摘要（60 字截断）+ 编辑按钮 */
function SummaryRow({
  label,
  description,
  summary,
  onEdit,
}: {
  label: string;
  description: string;
  summary: string;
  onEdit: () => void;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-sm font-normal">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
        <p className="truncate text-xs text-foreground/80">{summary}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onEdit}
        className="shrink-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
      >
        <Pencil className="h-3.5 w-3.5" />
        {t("settings:personalization.edit")}
      </Button>
    </div>
  );
}
