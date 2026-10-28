// 专家页（A2 批）：页内分段 [我的|市场]（spec §2 裁定统一单页）。
// 我的：assistant/query 概要列表 → detail 取全量进编辑器（name/systemPrompt/
// description/tags/profession/quickPrompts/icon/调参 + 专家团成员——
// expertType 单专家/专家团切换，team 态成员四字段行动态增删 ≤13 行，
// buildPayload 三态经 applyTeamFields：team 提交完整 members、编辑态
// team→agent 显式 members:null 清列、新建 agent 两键省略）。内置专家禁
// 改名/删除（表单置灰+无删除槽，服务端 ASSISTANT_BUILTIN 双保险）。市场：
// marketList 概要（不带 systemPrompt）本地分类/搜索/排序 → marketDetail
// 按 slug 取全文预览 →「添加并启用」marketDetail→assistant/save 新建。
// 错误码经 EXPERT_ERROR_CODES 映射 toast。
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Import, MessageSquarePlus, Plus, Trash2 } from "lucide-react-native";
import type {
  AssistantDetailResult,
  AssistantSavePayload,
  ExpertMarketDetail,
  ExpertMarketSummary,
  ExpertTeamMemberDto,
} from "@tianshu/protocol";

import { DialogShell } from "@/components/DialogShell";
import { FormField, PLACEHOLDER } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { PageHeader } from "@/components/PageHeader";
import { toast } from "@/lib/toast-bus";
import {
  ExpertImportFileError,
  parseExpertImportPreview,
  pickExpertJsonFile,
} from "@/logic/expert-import";
import {
  TEAM_MEMBERS_MAX,
  applyTeamFields,
  memberRowsReducer,
  validateTeamRows,
  type ExpertType,
  type TeamMemberRow,
} from "@/logic/expert-team";
import { useConnectionsStore } from "@/store/connections.store";
import { useCreateExpertPromptStore } from "@/store/create-expert-prompt.store";
import { useSessionsStore } from "@/store/sessions.store";
import { useExpertsStore, type ExpertMineRow } from "@/store/experts.store";
import { useThemeColors } from "@/store/theme";

type Segment = "mine" | "market";
/** 市场排序三档（体验精修批，桌面 market-filter 同口径） */
type MarketSort = "comprehensive" | "hot" | "newest";

const MARKET_SORTS: MarketSort[] = ["comprehensive", "hot", "newest"];
const MARKET_SORT_LABEL_KEYS: Record<MarketSort, string> = {
  comprehensive: "experts:sortComprehensive",
  hot: "experts:sortHot",
  newest: "experts:sortNewest",
};

const SEARCH_DEBOUNCE_MS = 300;

/** 错误 toast：EXPERT_ERROR_CODES 码表映射，未知码回退通用文案 */
function toastStoreError(
  t: (key: string | string[], vars?: Record<string, unknown>) => string,
  code: string | null,
) {
  const err = useExpertsStore.getState().error;
  const value = code ?? err ?? "";
  if (!value) return;
  toast.error(
    t([`experts:error.${value}`, "experts:error.fallback"], {
      message: value,
    }),
  );
}

/** 分段条（对齐 monitor SceneSegments 形态） */
function SegmentTabs({
  segment,
  onSelect,
}: {
  segment: Segment;
  onSelect: (segment: Segment) => void;
}) {
  const { t } = useTranslation("experts");
  const colors = useThemeColors();
  const items: Array<{ key: Segment; label: string }> = [
    { key: "mine", label: t("segmentMine") },
    { key: "market", label: t("segmentMarket") },
  ];
  return (
    <View className="mx-3 mb-2 flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
      {items.map(({ key, label }) => {
        const active = segment === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(key)}
            className="flex-1 items-center rounded-md py-2"
            style={{ backgroundColor: active ? colors.primary : "transparent" }}
          >
            <Text
              className="text-sm font-medium"
              style={{ color: active ? "#FFFFFF" : colors.primary }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 数值调参输入解析：空 → 缺省；非法 → null（调用方再决定语义） */
function parseParam(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 专家编辑/新建表单（DialogShell 三件套）。编辑态三态语义：可空字段
 *  清空 → null；新建态缺省字段省略不传。专家团：expertType 切换 +
 *  成员行（reducer 管理，≤13），提交前纯函数校验（失败 toast 拦截），
 *  团队字段三态经 applyTeamFields 落到载荷 */
function ExpertEditorDialog({
  initial,
  busy,
  onSave,
  onDelete,
  onExport,
  onClose,
}: {
  /** null/undefined = 新建；否则编辑（builtin 禁改名/删除） */
  initial: AssistantDetailResult | null | undefined;
  busy: boolean;
  onSave: (payload: AssistantSavePayload) => void;
  onDelete?: () => void;
  /** 导出（A2 尾）：编辑态导出 JSON 到剪贴板，builtin 同样可导 */
  onExport?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["experts", "common"]);
  const colors = useThemeColors();
  const isNew = initial == null;
  const builtin = initial?.builtin === true;
  const [name, setName] = useState(initial?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [profession, setProfession] = useState(initial?.profession ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [quickPrompts, setQuickPrompts] = useState(
    (initial?.quickPrompts ?? []).join("\n"),
  );
  const [temperature, setTemperature] = useState(
    initial?.temperature?.toString() ?? "",
  );
  const [topP, setTopP] = useState(initial?.topP?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(
    initial?.maxTokens?.toString() ?? "",
  );
  // 专家类型（默认单专家）与成员行（reducer 管理；agent 态隐藏不展示，
  // 行数据保留便于误切回退；清列语义在提交时按 expertType 三态处理）
  const [expertType, setExpertType] = useState<ExpertType>(
    initial?.expertType === "team" ? "team" : "agent",
  );
  const [memberRows, dispatchMembers] = useReducer(
    memberRowsReducer,
    (initial?.members ?? []) as TeamMemberRow[],
  );

  const confirmDisabled = name.trim() === "" || systemPrompt.trim() === "";
  const membersFull = memberRows.length >= TEAM_MEMBERS_MAX;

  function buildPayload(members?: ExpertTeamMemberDto[]): AssistantSavePayload {
    const nullable = (value: string) => {
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    };
    const listValue = (value: string) =>
      value
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter((item) => item !== "");
    const linesValue = (value: string) =>
      value
        .split("\n")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    const param = (raw: string): number | null | undefined => {
      const parsed = parseParam(raw);
      // 编辑态显式清空 = null（清空语义）；新建态缺省 = undefined（省略）
      if (parsed === undefined) return isNew ? undefined : null;
      return parsed;
    };
    const payload: AssistantSavePayload = {
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
      description: nullable(description),
      profession: nullable(profession),
      icon: nullable(icon),
      tags: listValue(tags),
      quickPrompts: linesValue(quickPrompts),
      temperature: param(temperature),
      topP: param(topP),
      maxTokens: param(maxTokens),
    };
    if (!isNew) payload.id = initial.id;
    if (builtin) delete payload.name; // 内置禁改名：不传 name 即保留
    applyTeamFields(payload, {
      expertType,
      members: members ?? [],
      isNew,
      hadMembers: (initial?.members?.length ?? 0) > 0,
    });
    return payload;
  }

  /** 确认提交：team 态先过纯函数校验（失败 toast 拦截，不上送半成品） */
  function handleConfirm() {
    if (expertType === "team") {
      const result = validateTeamRows(memberRows);
      if (!result.ok) {
        toast.error(t(`experts:teamError.${result.code}`));
        return;
      }
      onSave(buildPayload(result.members));
      return;
    }
    onSave(buildPayload());
  }

  return (
    <DialogShell
      title={t(isNew ? "newExpert" : "editExpert")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={confirmDisabled}
          onConfirm={handleConfirm}
          onCancel={onClose}
          auxLabel={!isNew ? t("export") : undefined}
          onAux={!isNew ? onExport : undefined}
          deleteLabel={!isNew && !builtin ? t("delete") : undefined}
          onDelete={!isNew && !builtin ? onDelete : undefined}
        />
      }
    >
      {builtin && (
        <Text className="text-xs leading-4 text-label2 dark:text-[#EBEBF599]">
          {t("builtinReadonly")}
        </Text>
      )}
      <FormField
        label={t("name")}
        value={name}
        onChangeText={setName}
        placeholder={t("nameRequired")}
        editable={!builtin}
      />
      {/* 专家类型切换（视觉同桌面口径：分段条双态） */}
      <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
        {(["agent", "team"] as const).map((type) => {
          const active = expertType === type;
          return (
            <Pressable
              key={type}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setExpertType(type)}
              className="flex-1 items-center rounded-md py-2"
              style={{
                backgroundColor: active ? colors.primary : "transparent",
              }}
            >
              <Text
                className="text-sm font-medium"
                style={{ color: active ? "#FFFFFF" : colors.primary }}
              >
                {t(type === "agent" ? "typeAgent" : "typeTeam")}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FormField
        label={t("systemPrompt")}
        value={systemPrompt}
        onChangeText={setSystemPrompt}
        placeholder={t("systemPromptRequired")}
        multiline
      />
      {expertType === "team" && (
        <View className="gap-3">
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("membersTitle")}
          </Text>
          {memberRows.map((row, index) => (
            <View
              key={index}
              className="gap-2 rounded-lg border border-sep p-3 dark:border-[#545458A6]"
            >
              <View className="flex-row gap-2">
                <View className="min-w-0 flex-1">
                  <FormField
                    label={t("memberName")}
                    value={row.name}
                    onChangeText={(value) =>
                      dispatchMembers({
                        type: "update",
                        index,
                        patch: { name: value },
                      })
                    }
                  />
                </View>
                <View className="min-w-0 flex-1">
                  <FormField
                    label={t("memberId")}
                    value={row.id}
                    onChangeText={(value) =>
                      dispatchMembers({
                        type: "update",
                        index,
                        patch: { id: value },
                      })
                    }
                    placeholder={t("memberIdHint")}
                  />
                </View>
              </View>
              <View className="flex-row items-end gap-2">
                <View className="min-w-0 flex-1">
                  <FormField
                    label={t("memberProfession")}
                    value={row.profession}
                    onChangeText={(value) =>
                      dispatchMembers({
                        type: "update",
                        index,
                        patch: { profession: value },
                      })
                    }
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("delete")}
                  onPress={() => dispatchMembers({ type: "remove", index })}
                  hitSlop={8}
                  className="h-10 w-10 items-center justify-center"
                >
                  <Trash2 size={18} color={colors.primary} />
                </Pressable>
              </View>
              <FormField
                label={t("memberPrompt")}
                value={row.systemPrompt}
                onChangeText={(value) =>
                  dispatchMembers({
                    type: "update",
                    index,
                    patch: { systemPrompt: value },
                  })
                }
                multiline
              />
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: membersFull }}
            disabled={membersFull}
            onPress={() => dispatchMembers({ type: "add" })}
            className="items-center rounded-lg border border-sep py-2.5 dark:border-[#545458A6]"
            style={{ opacity: membersFull ? 0.4 : 1 }}
          >
            <Text
              className="text-sm font-medium"
              style={{ color: colors.primary }}
            >
              {t("addMember")}
            </Text>
          </Pressable>
        </View>
      )}
      <FormField
        label={t("description")}
        value={description}
        onChangeText={setDescription}
      />
      <FormField
        label={t("profession")}
        value={profession}
        onChangeText={setProfession}
      />
      <FormField label={t("tags")} value={tags} onChangeText={setTags} />
      <FormField
        label={t("icon")}
        value={icon}
        onChangeText={setIcon}
        placeholder="🤖"
      />
      <FormField
        label={t("quickPrompts")}
        value={quickPrompts}
        onChangeText={setQuickPrompts}
        multiline
      />
      <View className="flex-row gap-3">
        <View className="min-w-0 flex-1">
          <FormField
            label={t("temperature")}
            value={temperature}
            onChangeText={setTemperature}
            placeholder={t("paramPlaceholder")}
            keyboardType="decimal-pad"
          />
        </View>
        <View className="min-w-0 flex-1">
          <FormField
            label={t("topP")}
            value={topP}
            onChangeText={setTopP}
            placeholder={t("paramPlaceholder")}
            keyboardType="decimal-pad"
          />
        </View>
        <View className="min-w-0 flex-1">
          <FormField
            label={t("maxTokens")}
            value={maxTokens}
            onChangeText={setMaxTokens}
            placeholder={t("paramPlaceholder")}
            keyboardType="number-pad"
          />
        </View>
      </View>
    </DialogShell>
  );
}

/** 市场条目详情/安装弹层：marketDetail 全文预览 + 添加并启用 */
function MarketDetailDialog({
  summary,
  busy,
  onInstall,
  onClose,
}: {
  summary: ExpertMarketSummary;
  busy: boolean;
  onInstall: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["experts", "common"]);
  const colors = useThemeColors();
  const [full, setFull] = useState<ExpertMarketDetail | null>(null);

  // 详情经 store 拉取（防迟到内建）；full 本地持有本弹层实例
  useEffect(() => {
    let cancelled = false;
    void useExpertsStore
      .getState()
      .loadMarketDetail(summary.slug)
      .then((result) => {
        if (!cancelled) setFull(result);
      });
    return () => {
      cancelled = true;
    };
  }, [summary.slug]);

  const params =
    full == null
      ? []
      : [
          full.temperature != null && `temperature ${full.temperature}`,
          full.topP != null && `topP ${full.topP}`,
          full.maxTokens != null && `maxTokens ${full.maxTokens}`,
        ].filter(
          (item): item is string => typeof item === "string" && item !== "",
        );

  return (
    <DialogShell
      title={summary.name}
      busy={busy}
      onClose={onClose}
      footer={
        <View className="mt-5 flex-row items-center justify-end gap-6 border-t border-sep px-5 py-4 dark:border-[#545458A6]">
          <Pressable disabled={busy} onPress={onClose} hitSlop={8}>
            <Text className="text-[15px] text-label2 dark:text-[#EBEBF599]">
              {t("common:cancel")}
            </Text>
          </Pressable>
          <Pressable
            disabled={busy || full == null}
            onPress={onInstall}
            hitSlop={8}
            style={{ opacity: full == null ? 0.4 : 1 }}
          >
            <Text
              className="text-[15px] font-medium"
              style={{ color: colors.primary }}
            >
              {busy ? t("installing") : t("install")}
            </Text>
          </Pressable>
        </View>
      }
    >
      <View className="flex-row flex-wrap gap-1.5">
        {summary.isTeam && (
          <View className="rounded-md bg-primary-subtle px-2 py-0.5">
            <Text className="text-xs text-black dark:text-white">
              {t("teamBadge")}
            </Text>
          </View>
        )}
        {summary.tags.map((tag) => (
          <View key={tag} className="rounded-md bg-primary-subtle px-2 py-0.5">
            <Text className="text-xs text-black dark:text-white">{tag}</Text>
          </View>
        ))}
      </View>
      {summary.profession !== "" && (
        <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
          {summary.profession}
        </Text>
      )}
      <Text className="text-sm leading-5 text-black dark:text-white">
        {summary.description}
      </Text>
      {full == null ? (
        <ActivityIndicator />
      ) : (
        <>
          <View className="gap-1.5">
            <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
              {t("promptPreview")}
            </Text>
            <ScrollView className="max-h-48 rounded-lg border border-sep bg-field px-3 py-2 dark:border-[#545458A6] dark:bg-[#2C2C2E]">
              <Text className="text-xs leading-4 text-black dark:text-white">
                {full.systemPrompt}
              </Text>
            </ScrollView>
          </View>
          {params.length > 0 && (
            <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
              {params.join(" · ")}
            </Text>
          )}
        </>
      )}
    </DialogShell>
  );
}

/** 导入预览弹层（A2 尾）：预检解析透出名称/描述，确认后透传原文 JSON——
 * 服务端 parseExpertJson 为权威校验（重名 dedupeName 后缀） */
function ImportPreviewDialog({
  preview,
  busy,
  onConfirm,
  onClose,
}: {
  preview: { name: string; description: string | null };
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["experts", "common"]);
  return (
    <DialogShell
      title={t("experts:importPreviewTitle")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={false}
          onConfirm={onConfirm}
          onCancel={onClose}
        />
      }
    >
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("experts:name")}
        </Text>
        <Text className="text-[15px] font-medium text-black dark:text-white">
          {preview.name}
        </Text>
      </View>
      {preview.description != null && (
        <View className="gap-1.5">
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("experts:description")}
          </Text>
          <Text className="text-sm leading-5 text-black dark:text-white">
            {preview.description}
          </Text>
        </View>
      )}
    </DialogShell>
  );
}

export default function ExpertsScreen() {
  const { t } = useTranslation(["experts", "common", "chat"]);
  const colors = useThemeColors();
  const router = useRouter();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const mine = useExpertsStore((s) => s.mine);
  const loading = useExpertsStore((s) => s.loading);
  const initialized = useExpertsStore((s) => s.initialized);
  const saving = useExpertsStore((s) => s.saving);
  const marketList = useExpertsStore((s) => s.marketList);
  const marketLoading = useExpertsStore((s) => s.marketLoading);
  const marketInitialized = useExpertsStore((s) => s.marketInitialized);

  const [segment, setSegment] = useState<Segment>("mine");
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<MarketSort>("comprehensive");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 编辑目标：null 弹层关；undefined 新建；否则编辑该详情 */
  const [editorTarget, setEditorTarget] = useState<
    AssistantDetailResult | null | undefined
  >(null);
  const [detailFetching, setDetailFetching] = useState(false);
  const [marketTarget, setMarketTarget] = useState<ExpertMarketSummary | null>(
    null,
  );
  const [installing, setInstalling] = useState(false);
  /** 导入预览态：预检通过的原文 JSON + 预览字段（确认后透传 import） */
  const [importDraft, setImportDraft] = useState<{
    json: string;
    name: string;
    description: string | null;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  /** 对话式创建会话进行中（防连点双建会话） */
  const [chatCreating, setChatCreating] = useState(false);

  useEffect(() => {
    if (!activeConnId) return;
    void useExpertsStore.getState().loadMine();
    void useExpertsStore.getState().loadMarket();
  }, [activeConnId]);

  const onSearchChange = useCallback((value: string) => {
    setKeywordInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(
      () => setKeyword(value.trim()),
      SEARCH_DEBOUNCE_MS,
    );
  }, []);

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    [],
  );

  const categories = useMemo(
    () => Array.from(new Set(marketList.map((item) => item.categoryId))),
    [marketList],
  );

  const filteredMarket = useMemo(() => {
    const lowered = keyword.toLowerCase();
    const filtered = marketList.filter((item) => {
      if (category !== null && item.categoryId !== category) return false;
      if (lowered === "") return true;
      return (
        item.name.toLowerCase().includes(lowered) ||
        item.description.toLowerCase().includes(lowered) ||
        item.profession.toLowerCase().includes(lowered) ||
        item.tags.some((tag) => tag.toLowerCase().includes(lowered))
      );
    });
    // 排序三档（体验精修批，桌面 market-filter 同口径）：综合=score /
    // 热门=downloads / 最新=createdAt，键倒序；同键稳定不重排。旧被控端
    // 字段全缺时回退名称排序（防旧端）；部分缺省沉底
    const keyOf = (item: ExpertMarketSummary): number | string | undefined =>
      sort === "comprehensive"
        ? item.score
        : sort === "hot"
          ? item.downloads
          : item.createdAt;
    const nameSort = (a: ExpertMarketSummary, b: ExpertMarketSummary) =>
      a.name.localeCompare(b.name);
    if (!filtered.some((item) => keyOf(item) != null)) {
      return [...filtered].sort(nameSort);
    }
    return [...filtered].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka == null && kb == null) return nameSort(a, b);
      if (ka == null) return 1;
      if (kb == null) return -1;
      if (ka === kb) return 0;
      return ka < kb ? 1 : -1;
    });
  }, [marketList, keyword, category, sort]);

  /** 分类 chip 文案：契约 categoryTitleKey（经 EXPERT_CATEGORIES 查得的
   *  i18n 键）→ experts ns 本地化；旧端未下发/未知键回退 categoryId 原值 */
  function categoryLabel(categoryId: string): string {
    const item = marketList.find((entry) => entry.categoryId === categoryId);
    const titleKey = item?.categoryTitleKey;
    if (titleKey == null) return categoryId;
    return t(`experts:categories.${titleKey}`, {
      defaultValue: categoryId,
    });
  }

  /** 打开编辑器：现有专家先拉详情（列表概要不带调参全文） */
  async function openEditor(row: ExpertMineRow) {
    setDetailFetching(true);
    setEditorTarget(null);
    const detail = await useExpertsStore.getState().loadDetail(row.id);
    setDetailFetching(false);
    if (!detail) {
      toastStoreError(t, null);
      return;
    }
    setEditorTarget(detail);
  }

  async function handleSave(payload: AssistantSavePayload) {
    const ok = await useExpertsStore.getState().save(payload);
    if (ok) {
      setEditorTarget(null);
    } else {
      toastStoreError(t, null);
    }
  }

  /** 对话式创建（体验精修批）：首个 workspace 建会话 → 跨页桥带访谈式
   *  引导语 → 跳会话页挂载自动发送（对齐桌面「创建专家」同入口流） */
  async function handleChatCreate() {
    if (chatCreating) return;
    setChatCreating(true);
    try {
      const sessions = useSessionsStore.getState();
      // 工作空间概要按需单拉（失败/空表——与桌面 noWorkspace 同语义）
      if (sessions.workspaces.length === 0) {
        await sessions.loadWorkspaces();
      }
      const first = useSessionsStore.getState().workspaces[0];
      if (first === undefined) {
        toast.error(t("experts:noWorkspace"));
        return;
      }
      const brief = await useSessionsStore
        .getState()
        .create(undefined, first.id);
      if (brief == null) {
        toast.error(t("experts:chatFailed"));
        return;
      }
      useCreateExpertPromptStore
        .getState()
        .setPendingPrompt(t("experts:createPrompt"));
      router.push(`/session/${brief.id}`);
    } finally {
      setChatCreating(false);
    }
  }

  function confirmDelete(target: AssistantDetailResult) {
    Alert.alert(
      t("experts:delete"),
      t("experts:confirmDelete", { name: target.name }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("experts:delete"),
          style: "destructive",
          onPress: () => void performDelete(target.id),
        },
      ],
    );
  }

  async function performDelete(id: number) {
    const ok = await useExpertsStore.getState().remove(id);
    if (ok) setEditorTarget(null);
    else toastStoreError(t, null);
  }

  async function handleInstall(summary: ExpertMarketSummary) {
    setInstalling(true);
    const ok = await useExpertsStore.getState().installFromMarket(summary.slug);
    setInstalling(false);
    if (ok) {
      setMarketTarget(null);
      toast.info(t("experts:installSuccess", { name: summary.name }));
      setSegment("mine");
    } else {
      toastStoreError(t, null);
    }
  }

  /** 导入（A2 尾）：文件选择 → 读文本 → 客户端预检（失败 toast
   *  ASSISTANT_INVALID 有用文案）→ 预览确认 */
  async function handleImportPick() {
    let picked: Awaited<ReturnType<typeof pickExpertJsonFile>>;
    try {
      picked = await pickExpertJsonFile();
    } catch (error) {
      const reason =
        error instanceof ExpertImportFileError
          ? error.reason
          : ("read" as const);
      toast.error(t(`experts:importFile.${reason}`));
      return;
    }
    if (!picked) return; // 取消静默
    const parsed = parseExpertImportPreview(picked.content);
    if (!parsed.ok) {
      toast.error(
        t("experts:importInvalid", {
          reason: t(`experts:importReject.${parsed.reason}`),
        }),
      );
      return;
    }
    setImportDraft({
      json: picked.content,
      name: parsed.name,
      description: parsed.description,
    });
  }

  async function handleImportConfirm() {
    if (!importDraft) return;
    setImporting(true);
    const ok = await useExpertsStore.getState().importExpert(importDraft.json);
    setImporting(false);
    if (ok) {
      toast.info(t("experts:importSuccess", { name: importDraft.name }));
      setImportDraft(null);
    } else {
      // 服务端权威校验失败：ASSISTANT_INVALID 等码表映射
      toastStoreError(t, null);
    }
  }

  /** 导出（A2 尾）：assistant/export 取 JSON 文本 → 剪贴板 + toast */
  async function handleExport(target: AssistantDetailResult) {
    const json = await useExpertsStore.getState().exportExpert(target.id);
    if (json == null) {
      toastStoreError(t, null);
      return;
    }
    await Clipboard.setStringAsync(json);
    toast.info(t("experts:exportSuccess", { name: target.name }));
  }

  function renderMineRow({ item }: { item: ExpertMineRow }) {
    return (
      <Pressable
        onPress={() => void openEditor(item)}
        className="flex-row items-center gap-3 border-b border-sep px-3 py-3 dark:border-[#545458A6]"
      >
        <Text className="text-xl">{item.icon ?? "🤖"}</Text>
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className="text-[15px] text-black dark:text-white"
          >
            {item.name}
          </Text>
          <Text
            numberOfLines={1}
            className="mt-0.5 text-[13px] text-label2 dark:text-[#EBEBF599]"
          >
            {item.description ?? item.profession ?? ""}
          </Text>
        </View>
      </Pressable>
    );
  }

  function renderMarketRow({ item }: { item: ExpertMarketSummary }) {
    return (
      <Pressable
        onPress={() => setMarketTarget(item)}
        className="flex-row items-center gap-3 border-b border-sep px-3 py-3 dark:border-[#545458A6]"
      >
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 text-[15px] text-black dark:text-white"
            >
              {item.name}
            </Text>
            {item.isTeam && (
              <Text className="text-[11px] text-label3 dark:text-[#EBEBF54D]">
                {t("experts:teamBadge")}
              </Text>
            )}
          </View>
          <Text
            numberOfLines={2}
            className="mt-0.5 text-[13px] text-label2 dark:text-[#EBEBF599]"
          >
            {item.description}
          </Text>
        </View>
      </Pressable>
    );
  }

  function renderContent() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
        </View>
      );
    }
    if (segment === "mine") {
      if (loading && !initialized) {
        return (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator color={colors.primary} />
          </View>
        );
      }
      if (mine.length === 0) {
        return (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
              {t("experts:empty")}
            </Text>
          </View>
        );
      }
      return (
        <FlatList
          data={mine}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderMineRow}
        />
      );
    }
    // 市场分段：搜索 + 排序 + 分类横滚（ListHeaderComponent 承载）
    return (
      <FlatList
        data={filteredMarket}
        keyExtractor={(item) => item.slug}
        renderItem={renderMarketRow}
        ListHeaderComponent={
          <View className="gap-2 px-3 pb-2">
            <TextInput
              value={keywordInput}
              onChangeText={onSearchChange}
              placeholder={t("experts:marketSearchPlaceholder")}
              placeholderTextColor={PLACEHOLDER}
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
            />
            <View className="flex-row items-center gap-2">
              <View className="flex-1 flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
                {MARKET_SORTS.map((key) => {
                  const active = sort === key;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => setSort(key)}
                      className="flex-1 items-center rounded-md py-1.5"
                      style={{
                        backgroundColor: active
                          ? colors.primary
                          : "transparent",
                      }}
                    >
                      <Text
                        className="text-xs font-medium"
                        style={{ color: active ? "#FFFFFF" : colors.primary }}
                      >
                        {t(MARKET_SORT_LABEL_KEYS[key])}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, flexShrink: 0 }}
              contentContainerStyle={{ gap: 6 }}
            >
              <Pressable
                onPress={() => setCategory(null)}
                className="rounded-full px-3 py-1"
                style={{
                  backgroundColor:
                    category === null ? colors.primary : colors.subtle,
                }}
              >
                <Text
                  className="text-xs"
                  style={{
                    color: category === null ? "#FFFFFF" : colors.primary,
                  }}
                >
                  {t("experts:allCategories")}
                </Text>
              </Pressable>
              {categories.map((key) => {
                const active = category === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setCategory(active ? null : key)}
                    className="rounded-full px-3 py-1"
                    style={{
                      backgroundColor: active ? colors.primary : colors.subtle,
                    }}
                  >
                    <Text
                      className="text-xs"
                      style={{
                        color: active ? "#FFFFFF" : colors.primary,
                      }}
                    >
                      {categoryLabel(key)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          marketLoading && !marketInitialized ? (
            <View className="items-center py-8">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <Text className="py-8 text-center text-sm text-label2 dark:text-[#EBEBF599]">
              {t("experts:marketEmpty")}
            </Text>
          )
        }
      />
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
      <PageHeader
        title={t("experts:title")}
        right={
          <View className="mr-1 flex-row items-center gap-1">
            {segment === "mine" && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("experts:import")}
                onPress={() => void handleImportPick()}
                hitSlop={12}
                className="h-9 w-9 items-center justify-center"
              >
                <Import size={22} color={colors.primary} />
              </Pressable>
            )}
            {segment === "mine" && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("experts:chatCreate")}
                accessibilityState={{ busy: chatCreating }}
                onPress={() => void handleChatCreate()}
                hitSlop={12}
                className="h-9 w-9 items-center justify-center"
                style={{ opacity: chatCreating ? 0.4 : 1 }}
              >
                <MessageSquarePlus size={22} color={colors.primary} />
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("experts:newExpert")}
              onPress={() => setEditorTarget(undefined)}
              hitSlop={12}
              className="h-9 w-9 items-center justify-center"
            >
              <Plus size={22} color={colors.primary} />
            </Pressable>
          </View>
        }
      />
      <SegmentTabs segment={segment} onSelect={setSegment} />
      <View className="flex-1">{renderContent()}</View>
      {detailFetching && (
        <View className="absolute inset-0 items-center justify-center bg-black/20">
          <ActivityIndicator color={colors.primary} />
        </View>
      )}
      {editorTarget !== null && (
        <ExpertEditorDialog
          initial={editorTarget}
          busy={saving}
          onSave={(payload) => void handleSave(payload)}
          onDelete={
            editorTarget && !editorTarget.builtin
              ? () => confirmDelete(editorTarget)
              : undefined
          }
          onExport={
            editorTarget ? () => void handleExport(editorTarget) : undefined
          }
          onClose={() => setEditorTarget(null)}
        />
      )}
      {importDraft && (
        <ImportPreviewDialog
          preview={importDraft}
          busy={importing}
          onConfirm={() => void handleImportConfirm()}
          onClose={() => setImportDraft(null)}
        />
      )}
      {marketTarget && (
        <MarketDetailDialog
          summary={marketTarget}
          busy={installing}
          onInstall={() => void handleInstall(marketTarget)}
          onClose={() => setMarketTarget(null)}
        />
      )}
    </SafeAreaView>
  );
}
