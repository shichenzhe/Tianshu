/**
 * 记忆与进化页（展示态）：页头说明 + 记忆开关（即时生效）+ 管理记忆卡片
 * （编辑/导入/重置为占位按钮，交互由 Task 8/9 接入）+ 记忆画像四板块只读
 * 展示。读取复用 ["personalization"] React Query 缓存，开关复用乐观更新 +
 * revert 失败回滚模式（与 ProfileGroup 的 ToggleSection 同构）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, ChevronDown, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsApi } from "../api/settings.api";
import {
  MEMORY_SECTION_DEFS,
  parseMemoryMarkdown,
  type MemorySectionKey,
} from "../model/memory-markdown";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalizationOptions,
  parsePersonalizationOptions,
  savePersonalizationOption,
} from "../model/personalization-options";
import { useSaveOrRevert } from "../model/use-save-or-revert";
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

  const [enabled, setEnabled] = useState(options.memoryEnabled);
  useEffect(() => setEnabled(options.memoryEnabled), [options.memoryEnabled]);
  const changeEnabled = useCallback(
    (checked: boolean) => {
      setEnabled(checked);
      revert(persistQuiet(PERSONALIZATION_KEYS.memoryEnabled, checked), () =>
        setEnabled(!checked),
      );
    },
    [persistQuiet, revert],
  );

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
      <ManageMemoryCard />
      {options.memoryProfile.trim() === "" ? (
        <EmptyMemoryCard
          enabled={enabled}
          onEnable={() => changeEnabled(true)}
        />
      ) : (
        <MemorySectionsCard memoryProfile={options.memoryProfile} />
      )}
      {!enabled && <DisabledNotice />}
    </div>
  );
}

/** 管理记忆卡片：三按钮本任务为占位（编辑/导入/重置交互由 Task 8/9 接入） */
function ManageMemoryCard() {
  const { t } = useTranslation(["settings"]);
  return (
    <section className="space-y-3 rounded-lg border border-border/50 bg-card p-4">
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
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          {t("settings:memory.actions.edit")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          {t("settings:memory.actions.import")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
        >
          {t("settings:memory.actions.reset")}
        </Button>
      </div>
    </section>
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

/** 四板块卡片：parseMemoryMarkdown 按固定标题切分后逐节渲染 */
function MemorySectionsCard({ memoryProfile }: { memoryProfile: string }) {
  const sections = useMemo(
    () => parseMemoryMarkdown(memoryProfile),
    [memoryProfile],
  );
  return (
    <section className="space-y-5 rounded-lg border border-border/50 bg-card p-4">
      {MEMORY_SECTION_DEFS.map(({ key }) => (
        <MemorySectionBlock key={key} sectionKey={key} text={sections[key]} />
      ))}
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
