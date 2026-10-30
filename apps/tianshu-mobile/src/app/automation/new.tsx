import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Check, ChevronRight } from "lucide-react-native";
import type {
  AccessMode,
  GraphRecord,
  MissedPolicy,
  TaskRecord,
} from "@tianshu/protocol";

import { ModelPicker } from "@/components/ModelPicker";
import { PageHeader } from "@/components/PageHeader";
import {
  SCHEDULE_KINDS,
  WEEKDAY_KEYS,
  buildEditPayload,
  buildSchedule,
  buildScheduleText,
  defaultScheduleValues,
  parseScheduleConfig,
  validationKey,
  validationKeyForTarget,
  type IntervalUnit,
  type ScheduleKind,
  type ScheduleValues,
} from "@/logic/automation-schedule";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useSessionsStore } from "@/store/sessions.store";
import { useThemeColors } from "@/store/theme";
import { automationSave } from "@/transport/graph-api";

interface SegmentOption<T> {
  value: T;
  label: string;
}

const HOURS = Array.from({ length: 24 }, (_, hour) =>
  String(hour).padStart(2, "0"),
);
const MINUTES = Array.from({ length: 12 }, (_, index) =>
  String(index * 5).padStart(2, "0"),
);
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const PLACEHOLDER = "#8E8E93";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function nextDates(): Array<{ value: string; weekday: number }> {
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    return {
      value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      weekday: date.getDay() === 0 ? 7 : date.getDay(),
    };
  });
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
        {title}
      </Text>
      <View className="gap-3 rounded-2xl border border-sep bg-card p-4 dark:border-[#545458A6] dark:bg-[#1C1C1E]">
        {children}
      </View>
    </View>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
}) {
  const colors = useThemeColors();
  return (
    <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            className="flex-1 items-center rounded-md px-1 py-2"
            style={{ backgroundColor: active ? colors.primary : "transparent" }}
          >
            <Text
              className={`text-xs ${active ? "font-medium text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ChoiceChip({
  label,
  subtitle,
  selected,
  onPress,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="items-center rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]"
      // 选中底色必须对象式 style：nativewind v4 与 className 共存时函数式
      // style 的 backgroundColor 被静默丢弃（web 复现实测选中 chip 透明底
      // +text-white 白字隐形即此因）；按压态反馈随之舍弃，与 SegmentedControl
      // 选中态同款写法
      style={{
        backgroundColor: selected ? colors.primary : "transparent",
      }}
    >
      <Text
        className={`text-xs ${selected ? "font-medium text-white" : "text-black dark:text-white"}`}
      >
        {label}
      </Text>
      {subtitle && (
        <Text
          className={`mt-0.5 text-[11px] ${selected ? "text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
        >
          {subtitle}
        </Text>
      )}
    </Pressable>
  );
}

function ChipRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ alignItems: "flex-start", gap: 8 }}
      >
        {options.map((option) => (
          <ChoiceChip
            key={option}
            label={option}
            selected={option === value}
            onPress={() => onChange(option)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function DatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("orchestration");
  const dates = useMemo(nextDates, []);
  return (
    <View className="gap-1.5">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
        {t("date")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ alignItems: "flex-start", gap: 8 }}
      >
        {dates.map((date) => (
          <ChoiceChip
            key={date.value}
            label={date.value}
            subtitle={t(WEEKDAY_KEYS[date.weekday - 1])}
            selected={date.value === value}
            onPress={() => onChange(date.value)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function TimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("orchestration");
  const hour = value.slice(0, 2);
  const minute = value.slice(3, 5);
  return (
    <View className="gap-2">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
        {t("time")}
      </Text>
      <ChipRow
        label={t("hour")}
        options={HOURS}
        value={hour}
        onChange={(next) => onChange(`${next}:${minute}`)}
      />
      <ChipRow
        label={t("minute")}
        options={MINUTES}
        value={minute}
        onChange={(next) => onChange(`${hour}:${next}`)}
      />
    </View>
  );
}

function WeekdayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const { t } = useTranslation("orchestration");
  function toggle(day: number) {
    onChange(
      value.includes(day)
        ? value.filter((current) => current !== day)
        : [...value, day].sort(),
    );
  }
  return (
    <View className="gap-1.5">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
        {t("weekdays")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {WEEKDAY_KEYS.map((key, index) => (
          <ChoiceChip
            key={key}
            label={t(key)}
            selected={value.includes(index + 1)}
            onPress={() => toggle(index + 1)}
          />
        ))}
      </View>
    </View>
  );
}

function IntervalFields({
  value,
  unit,
  onValueChange,
  onUnitChange,
}: {
  value: string;
  unit: IntervalUnit;
  onValueChange: (value: string) => void;
  onUnitChange: (unit: IntervalUnit) => void;
}) {
  const { t } = useTranslation("orchestration");
  const numeric = Number(value);
  const belowMinimum =
    Number.isFinite(numeric) &&
    numeric > 0 &&
    (unit === "hour" ? numeric * 60 : numeric) < 5;
  return (
    <View className="gap-3">
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("intervalValue")}
        </Text>
        <TextInput
          value={value}
          onChangeText={onValueChange}
          keyboardType="number-pad"
          placeholder={t("intervalValue")}
          placeholderTextColor={PLACEHOLDER}
          className="rounded-lg border border-sep bg-field px-3 py-2.5 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("intervalUnit")}
        </Text>
        <SegmentedControl
          options={[
            { value: "minute", label: t("minute") },
            { value: "hour", label: t("hour") },
          ]}
          value={unit}
          onChange={onUnitChange}
        />
      </View>
      {belowMinimum && (
        <Text className="text-xs text-red-500">{t("intervalMin5")}</Text>
      )}
    </View>
  );
}

function ChoiceRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="flex-row items-center rounded-xl border border-sep bg-field px-3 py-3 dark:border-[#545458A6] dark:bg-[#2C2C2E]"
      style={{ borderColor: selected ? colors.primary : undefined }}
    >
      <Text className="flex-1 text-sm text-black dark:text-white">{label}</Text>
      {selected && <Check size={17} color={colors.primary} />}
    </Pressable>
  );
}

function GraphPickerModal({
  open,
  graphs,
  loading,
  selectedId,
  onSelect,
  onClose,
}: {
  open: boolean;
  graphs: GraphRecord[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["orchestration", "common"]);
  const colors = useThemeColors();
  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(event) => event.stopPropagation()}
          className="max-h-[75%] overflow-hidden rounded-t-3xl border border-sep bg-grouped dark:border-[#545458A6] dark:bg-black"
        >
          <View className="flex-row items-center px-5 pb-3 pt-5">
            <Text className="flex-1 text-lg font-semibold text-black dark:text-white">
              {t("orchestration:selectGraph")}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text className="text-sm" style={{ color: colors.primary }}>
                {t("common:cancel")}
              </Text>
            </Pressable>
          </View>
          {loading && graphs.length === 0 ? (
            <View className="items-center py-12">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <FlatList
              data={graphs}
              keyExtractor={(graph) => String(graph.id)}
              contentContainerStyle={{ paddingBottom: 24 }}
              ListEmptyComponent={
                <Text className="px-5 py-10 text-center text-sm text-label2 dark:text-[#EBEBF599]">
                  {t("orchestration:emptyGraphs")}
                </Text>
              }
              renderItem={({ item, index }) => (
                <Pressable
                  onPress={() => onSelect(item.id)}
                  className={`flex-row items-center gap-3 bg-card px-5 py-3 dark:bg-[#1C1C1E] ${
                    index === graphs.length - 1
                      ? ""
                      : "border-b border-sep dark:border-[#545458A6]"
                  }`}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? colors.subtle : undefined,
                  })}
                >
                  <View className="min-w-0 flex-1">
                    <Text
                      numberOfLines={1}
                      className="text-[15px] text-black dark:text-white"
                    >
                      {item.name}
                    </Text>
                    <Text className="mt-0.5 text-xs text-label2 dark:text-[#EBEBF599]">
                      {t("orchestration:graphNodes", {
                        count: item.nodeCount,
                      })}
                    </Text>
                  </View>
                  {item.id === selectedId && (
                    <Check size={17} color={colors.primary} />
                  )}
                </Pressable>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** 双模式表单（CRUD 批）：无参=新建（targetKind 切换 prompt/graph）、
 *  ?id= 编辑（TaskRecord 回填；透传字段 eventJson/templateSlug/projectId/
 *  temperature/interval weekdays 原样回传防全量 save 丢配置——纯函数层
 *  buildEditPayload 钉死）。调度七 kind 全集（biweekly/monthly/yearly 新增）。
 */
export default function NewAutomationScreen() {
  const { t } = useTranslation(["orchestration", "common"]);
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId =
    params.id != null && params.id !== "" ? Number(params.id) : null;

  const graphs = useOrchestrationStore((state) => state.graphs);
  const graphsLoading = useOrchestrationStore((state) => state.graphsLoading);
  const loadGraphs = useOrchestrationStore((state) => state.loadGraphs);
  const tasks = useOrchestrationStore((state) => state.tasks);
  const tasksLoading = useOrchestrationStore((state) => state.tasksLoading);
  const loadTasks = useOrchestrationStore((state) => state.loadTasks);
  const workspaces = useSessionsStore((state) => state.workspaces);
  const loadFirst = useSessionsStore((state) => state.loadFirst);
  const [targetKind, setTargetKind] = useState<"prompt" | "graph">("graph");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [graphId, setGraphId] = useState<number | null>(null);
  const [graphPickerOpen, setGraphPickerOpen] = useState(false);
  const [values, setValues] = useState<ScheduleValues>(defaultScheduleValues);
  const [missed, setMissed] = useState<MissedPolicy>("skip");
  const [access, setAccess] = useState<AccessMode>("default");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 编辑目标：列表缓存命中即回填；深链进入未拉过先拉（拉完仍无=已删）
  const editing: TaskRecord | null =
    editId === null ? null : (tasks.find((task) => task.id === editId) ?? null);

  useEffect(() => {
    if (editId === null) return;
    const state = useOrchestrationStore.getState();
    if (state.tasks.length === 0 && !state.tasksLoading) void loadTasks();
  }, [editId, loadTasks, tasksLoading]);

  // 一次性回填（editing 就绪时）：表单值 + 透传字段驻留 editing 对象
  // （提交时 buildEditPayload 原样带走）；调度未知形态 → values 置 null
  // 语义（unparsed 标记，调度区只读、提交透传原 scheduleJson）
  const [unparsed, setUnparsed] = useState(false);
  const [filledId, setFilledId] = useState<number | null>(null);
  useEffect(() => {
    if (editing === null || filledId === editing.id) return;
    setFilledId(editing.id);
    setName(editing.name);
    setTargetKind(editing.targetKind);
    setPrompt(editing.prompt);
    setModelId(editing.targetKind === "prompt" ? editing.modelId : null);
    setWorkspaceId(editing.workspaceId);
    setGraphId(editing.graphId);
    setMissed(editing.missedPolicy);
    setAccess(editing.accessMode);
    try {
      const parsed = parseScheduleConfig(JSON.parse(editing.scheduleJson));
      if (parsed === null) {
        setUnparsed(true);
      } else {
        setUnparsed(false);
        setValues(parsed);
      }
    } catch {
      setUnparsed(true);
    }
  }, [editing, filledId]);

  const selectedGraph = graphs.find((graph) => graph.id === graphId) ?? null;
  const target = {
    name,
    targetKind,
    graphId,
    modelId,
    prompt,
  };
  // 校验单源（canSubmit/提交共用同口径——2026-10-29 修复：此前提交分支漏传
  // allowPastOnce，编辑存量 once 已过任务按钮亮可点、点击被静默拦截）；
  // unparsed 调度只透传原值不参与校验（否则默认 values 恒 needSchedule、
  // 保存按钮永不解锁）
  function currentErrorKey(): string | null {
    if (unparsed) return validationKeyForTarget(target);
    return validationKey(target, values, undefined, editing !== null);
  }
  // 编辑模式 once 已过时间是合法存量（保存后自然 expired），不做过去校验
  const errorKey = currentErrorKey();
  const canSubmit =
    !submitting &&
    (editing !== null || workspaceId !== null) &&
    errorKey === null;
  const visibleFormError =
    formError ?? (errorKey === "orchestration:timeInPast" ? t(errorKey) : null);

  useEffect(() => {
    const graphState = useOrchestrationStore.getState();
    if (graphState.graphs.length === 0 && !graphState.graphsLoading) {
      void loadGraphs();
    }
    if (useSessionsStore.getState().workspaces.length === 0) void loadFirst();
  }, [loadFirst, loadGraphs]);

  // workspace 缺省取 id 升序首项（与会话侧栏回退一致）；编辑以回填为准
  useEffect(() => {
    if (workspaceId === null && workspaces.length > 0) {
      setWorkspaceId(workspaces[0]?.id ?? null);
    }
  }, [workspaces, workspaceId]);

  function patchValues(patch: Partial<ScheduleValues>) {
    setValues((current) => ({ ...current, ...patch }));
  }

  async function handleSubmit() {
    if (submitting) return;
    const submitErrorKey = currentErrorKey();
    if (submitErrorKey || (editing === null && workspaceId === null)) {
      if (submitErrorKey) setFormError(t(submitErrorKey));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const failedKey =
      editing === null
        ? "orchestration:createFailed"
        : "orchestration:saveFailed";
    try {
      const result =
        editing !== null
          ? await automationSave(
              // 表单面字段（workspace/错过策略/访问模式）随保存提交——
              // 2026-10-29 修复：此前误传任务原值，编辑这三项静默不生效
              buildEditPayload(editing, target, unparsed ? null : values, t, {
                workspaceId: workspaceId ?? editing.workspaceId,
                missedPolicy: missed,
                accessMode: access,
              }),
            )
          : await automationSave({
              name: name.trim(),
              prompt: targetKind === "graph" ? "" : prompt,
              workspaceId: workspaceId ?? 0,
              modelId: targetKind === "graph" ? 0 : (modelId ?? 0),
              targetKind,
              graphId:
                targetKind === "graph" ? (graphId ?? undefined) : undefined,
              schedule: buildSchedule(values),
              scheduleText: buildScheduleText(values, t),
              missedPolicy: missed,
              accessMode: access,
              enabled: true,
            });
      if (result.ok) router.back();
      else {
        setFormError(
          t(failedKey, {
            message: result.message || t("orchestration:networkError"),
          }),
        );
      }
    } catch (error) {
      setFormError(
        t(failedKey, {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  // 编辑目标已删（列表拉完仍无）：提示返回，禁提交
  if (editId !== null && editing === null && !tasksLoading) {
    return (
      <SafeAreaView
        className="flex-1 items-center justify-center bg-grouped dark:bg-black"
        edges={["top", "bottom"]}
      >
        <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
          {t("orchestration:taskGone")}
        </Text>
        <Pressable
          onPress={() => router.back()}
          className="mt-4 rounded-lg px-4 py-2"
          style={{ backgroundColor: colors.primary }}
        >
          <Text className="text-sm text-white">{t("common:back")}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={
          editing === null
            ? t("orchestration:newTask")
            : t("orchestration:editTask")
        }
        backLabel={t("common:cancel")}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("orchestration:save")}
            disabled={!canSubmit}
            onPress={() => void handleSubmit()}
            hitSlop={12}
            className="h-9 justify-center px-1"
            style={{ opacity: canSubmit ? 1 : 0.4 }}
          >
            <Text
              className="text-[15px] font-medium"
              style={{ color: colors.primary }}
            >
              {t("orchestration:save")}
            </Text>
          </Pressable>
        }
      />

      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 16 }}
      >
        <SectionCard title={t("orchestration:taskName")}>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={255}
            placeholder={t("orchestration:taskNamePlaceholder")}
            placeholderTextColor={PLACEHOLDER}
            returnKeyType="done"
            className="rounded-lg border border-sep bg-field px-3 py-2.5 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
          />
        </SectionCard>

        <SectionCard title={t("orchestration:workspace")}>
          {workspaces.length === 0 ? (
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("orchestration:workspaceEmpty")}
            </Text>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, flexShrink: 0 }}
              contentContainerStyle={{ alignItems: "flex-start", gap: 8 }}
            >
              {workspaces.map((workspace) => (
                <ChoiceChip
                  key={workspace.id}
                  label={workspace.name}
                  selected={workspace.id === workspaceId}
                  onPress={() => setWorkspaceId(workspace.id)}
                />
              ))}
            </ScrollView>
          )}
        </SectionCard>

        <SectionCard title={t("orchestration:executionTarget")}>
          <SegmentedControl
            options={[
              { value: "graph", label: t("orchestration:kindGraph") },
              { value: "prompt", label: t("orchestration:kindPrompt") },
            ]}
            value={targetKind}
            onChange={setTargetKind}
          />
        </SectionCard>

        {targetKind === "graph" ? (
          <SectionCard title={t("orchestration:selectGraph")}>
            <Pressable
              accessibilityRole="button"
              // 开面板即重拉：协议无 graph 变更事件（会话里新建的工作流
              // 不会推送），挂载只在缓存为空时拉——不重拉则下拉恒为旧表
              onPress={() => {
                setGraphPickerOpen(true);
                void loadGraphs();
              }}
              className="flex-row items-center gap-3 rounded-xl border border-sep bg-field px-3 py-3 dark:border-[#545458A6] dark:bg-[#2C2C2E]"
            >
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  className={`text-sm ${selectedGraph ? "text-black dark:text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
                >
                  {selectedGraph?.name ?? t("orchestration:pleaseSelect")}
                </Text>
                {selectedGraph && (
                  <Text className="mt-0.5 text-xs text-label2 dark:text-[#EBEBF599]">
                    {t("orchestration:graphNodes", {
                      count: selectedGraph.nodeCount,
                    })}
                  </Text>
                )}
              </View>
              <ChevronRight size={16} color={PLACEHOLDER} />
            </Pressable>
          </SectionCard>
        ) : (
          <SectionCard title={t("orchestration:promptSection")}>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              multiline
              placeholder={t("orchestration:promptPlaceholder")}
              placeholderTextColor={PLACEHOLDER}
              className="min-h-24 rounded-lg border border-sep bg-field px-3 py-2.5 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
            />
            <View className="items-start pt-1">
              <ModelPicker modelId={modelId} onPick={setModelId} />
            </View>
          </SectionCard>
        )}

        <SectionCard title={t("orchestration:schedule")}>
          {unparsed ? (
            // 未知调度形态：只读回显原文案，提交透传原 scheduleJson（防丢）
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {editing?.scheduleText ?? t("orchestration:schedule")}
            </Text>
          ) : (
            <>
              <ChipRow
                label={t("orchestration:schedule")}
                options={SCHEDULE_KINDS.map((kind) =>
                  t(`orchestration:${kind}`),
                )}
                value={t(`orchestration:${values.kind}`)}
                onChange={(next) => {
                  const kind = SCHEDULE_KINDS.find(
                    (candidate) => t(`orchestration:${candidate}`) === next,
                  );
                  if (kind) patchValues({ kind });
                }}
              />
              {values.kind === "once" && (
                <>
                  <DatePicker
                    value={values.date}
                    onChange={(date) => patchValues({ date })}
                  />
                  <TimePicker
                    value={values.hm}
                    onChange={(hm) => patchValues({ hm })}
                  />
                </>
              )}
              {values.kind === "daily" && (
                <TimePicker
                  value={values.hm}
                  onChange={(hm) => patchValues({ hm })}
                />
              )}
              {values.kind === "weekly" && (
                <>
                  <WeekdayPicker
                    value={values.weekdays}
                    onChange={(weekdays) => patchValues({ weekdays })}
                  />
                  <TimePicker
                    value={values.hm}
                    onChange={(hm) => patchValues({ hm })}
                  />
                </>
              )}
              {values.kind === "biweekly" && (
                <>
                  <DatePicker
                    value={values.date}
                    onChange={(date) => patchValues({ date })}
                  />
                  <TimePicker
                    value={values.hm}
                    onChange={(hm) => patchValues({ hm })}
                  />
                </>
              )}
              {values.kind === "monthly" && (
                <>
                  <ChipRow
                    label={t("orchestration:dayOfMonth")}
                    options={DAY_OPTIONS}
                    value={values.dayOfMonth}
                    onChange={(dayOfMonth) => patchValues({ dayOfMonth })}
                  />
                  <TimePicker
                    value={values.hm}
                    onChange={(hm) => patchValues({ hm })}
                  />
                </>
              )}
              {values.kind === "yearly" && (
                <>
                  <ChipRow
                    label={t("orchestration:monthLabel")}
                    options={MONTH_OPTIONS}
                    value={values.month}
                    onChange={(month) => patchValues({ month })}
                  />
                  <ChipRow
                    label={t("orchestration:dayOfMonth")}
                    options={DAY_OPTIONS}
                    value={values.dayOfMonth}
                    onChange={(dayOfMonth) => patchValues({ dayOfMonth })}
                  />
                  <TimePicker
                    value={values.hm}
                    onChange={(hm) => patchValues({ hm })}
                  />
                </>
              )}
              {values.kind === "interval" && (
                <IntervalFields
                  value={values.intervalValue}
                  unit={values.intervalUnit}
                  onValueChange={(intervalValue) =>
                    patchValues({ intervalValue })
                  }
                  onUnitChange={(intervalUnit) => patchValues({ intervalUnit })}
                />
              )}
            </>
          )}
        </SectionCard>

        <SectionCard title={t("orchestration:missedPolicy")}>
          <ChoiceRow
            label={t("orchestration:skip")}
            selected={missed === "skip"}
            onPress={() => setMissed("skip")}
          />
          <ChoiceRow
            label={t("orchestration:catchUpOnce")}
            selected={missed === "catchUpOnce"}
            onPress={() => setMissed("catchUpOnce")}
          />
        </SectionCard>

        <SectionCard title={t("orchestration:accessMode")}>
          <ChoiceRow
            label={t("orchestration:default")}
            selected={access === "default"}
            onPress={() => setAccess("default")}
          />
          <ChoiceRow
            label={t("orchestration:full")}
            selected={access === "full"}
            onPress={() => setAccess("full")}
          />
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("orchestration:accessModeHint")}
          </Text>
        </SectionCard>
      </ScrollView>

      <View className="min-h-11 border-t border-sep px-4 py-2 dark:border-[#545458A6]">
        {visibleFormError && (
          <Text className="text-xs text-red-500">{visibleFormError}</Text>
        )}
      </View>
      <GraphPickerModal
        open={graphPickerOpen}
        graphs={graphs}
        loading={graphsLoading}
        selectedId={graphId}
        onSelect={(id) => {
          setGraphId(id);
          setGraphPickerOpen(false);
        }}
        onClose={() => setGraphPickerOpen(false)}
      />
    </SafeAreaView>
  );
}
