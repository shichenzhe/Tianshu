// 项目工作台页（A7 批，/projects/[id]）：PageHeader（项目名,back）+ 分段
// [计划|资产|关于]。计划：激活视图 chips（parseViewConfig 条件+排序经 core
// 引擎过滤排序）→ groupBy 固定 status 分组 → 拍平为 FlatList 条目（组头行/
// 事项行/组尾「+」快速新建行——照会话组拍平虚拟化铁律：行级 memo、行上禁
// flex-1）；事项行=标题/优先级色点（P0 语义红/P1 主题色/P2/P3 中性灰）/
// 处理人昵称/截止 MM-dd；点击行进 PlanItemDialog（全字段+自定义字段+附件）。
// 资产：面包屑+用量条+行列表；图片 readAssetImage 弹层预览，文本走
// FilePreviewModal（files/read + assetWorkspaceId），其余 toast 桌面端。
// 关于：指令只读卡+成员列表+bindings 只读清单（valid=false 置灰标注）。
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Bot,
  Boxes,
  ChevronRight,
  CircleDot,
  File,
  Filter,
  Folder,
  FolderPlus,
  LayoutList,
  Link2,
  MessageCircle,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react-native";
import {
  PLAN_GROUP_BYS,
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  PLAN_VIEW_TYPES,
  type AssetEntryDto,
  type PlanItemCreatePayload,
  type PlanItemRecordDto,
  type PlanItemUpdatePayload,
  type PlanPriority,
  type PlanStatus,
  type PlanViewRecordDto,
  type PlanViewType,
  type ProjectBindingItemDto,
  type ProjectMemberItemDto,
} from "@tianshu/protocol";
import {
  filterPlanItems,
  groupPlanItems,
  isoToDateKey,
  parsePlanViewConfig,
  sortPlanItems,
  type PlanFilterCondition,
} from "@/logic/plan-view";
import {
  PLAN_FILTER_FIELDS,
  addConditionUpdater,
  patchConditionUpdater,
  removeConditionUpdater,
  setConditionOpUpdater,
  toggleConditionValueUpdater,
} from "@/logic/plan-filter";

import { AppActionSheet, ActionSheetItem } from "@/components/AppActionSheet";
import { AutomationCard } from "@/components/AutomationCard";
import { DialogShell } from "@/components/DialogShell";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { FormField, PLACEHOLDER } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { MarkdownLite } from "@/components/MarkdownLite";
import { PageHeader } from "@/components/PageHeader";
import { PlanItemDialog } from "@/components/PlanItemDialog";
import { formatSize } from "@/lib/format-size";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import { pickLibraryFile } from "@/logic/library-upload";
import { formatRelative } from "@/logic/time";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { resolveActiveView, useProjectStore } from "@/store/project.store";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useSessionsStore } from "@/store/sessions.store";
import { useThemeColors } from "@/store/theme";

type WsTab = "plan" | "assets" | "about";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTS = new Set([
  "md",
  "markdown",
  "txt",
  "text",
  "csv",
  "json",
  "log",
  "xml",
  "yaml",
  "yml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "sql",
  "html",
  "css",
]);

/** 优先级色点：P0 语义红（共享 ACTION_DANGER 同色）/P1 主题色/P2/P3 中性灰 */
const PRIORITY_DOT_COLORS: Record<PlanPriority, string> = {
  P0: "#FF3B30",
  P1: "primary",
  P2: "#8E8E93",
  P3: "#C7C7CC",
};

/** 分段栏 [计划|资产|关于] */
function WsSegments({
  tab,
  disabled,
  onSelect,
}: {
  tab: WsTab;
  disabled: boolean;
  onSelect: (tab: WsTab) => void;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();
  const options = [
    { key: "plan", label: t("planTab") },
    { key: "assets", label: t("assetsTab") },
    { key: "about", label: t("aboutTab") },
  ] as const;
  return (
    <View className="px-3 pb-2">
      <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
        {options.map((option) => {
          const active = option.key === tab;
          return (
            <Pressable
              key={option.key}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(option.key)}
              className="flex-1 items-center rounded-md px-3 py-2"
              style={{
                backgroundColor: active ? colors.primary : "transparent",
              }}
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
    </View>
  );
}

// —— 计划拍平条目（组头/事项/组尾新建——行级 memo，行上禁 flex-1 铁律） ——

type PlanGroupByKey = "status" | "priority" | "assignee";

type PlanEntry =
  | {
      kind: "header";
      key: string;
      groupBy: PlanGroupByKey;
      groupValue: string;
      label: string;
      count: number;
    }
  | { kind: "item"; key: string; item: PlanItemRecordDto; isLast: boolean }
  | { kind: "add"; key: string; status: PlanStatus };

/** 组头行：分组本地化标签 + 计数（groupBy 生效——#1 视图批） */
const PlanGroupHeaderRow = memo(function PlanGroupHeaderRow({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-1 pt-4">
      <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
        {label}
      </Text>
      <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">{count}</Text>
    </View>
  );
});

/** 组尾「+」快速新建行：预置该组状态 */
const PlanGroupAddRow = memo(function PlanGroupAddRow({
  status,
  onPress,
}: {
  status: PlanStatus;
  onPress: (status: PlanStatus) => void;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => onPress(status)}
      className="flex-row items-center gap-2 px-4 py-2.5"
      hitSlop={4}
    >
      <Plus size={14} color={colors.primary} />
      <Text className="text-xs" style={{ color: colors.primary }}>
        {t("quickCreate")}
      </Text>
    </Pressable>
  );
});

// —— 计划筛选面板（#8 桌面对齐：字段×操作符×值 AND 组合，本地会话态，
//    不随视图持久化——planView 写面属后续批） ——

/** source 值域（PlanItemSource；标签走 i18n filter 子树） */
const FILTER_SOURCE_VALUES = ["manual", "ai", "template"] as const;

/** 各字段可用操作符（唯一操作符字段不展示切换行） */
const FILTER_OPS_BY_FIELD: Record<
  PlanFilterCondition["field"],
  PlanFilterCondition["op"][]
> = {
  title: ["contains"],
  tags: ["contains"],
  status: ["in", "notIn"],
  priority: ["in", "notIn"],
  source: ["in", "notIn"],
  assigneeId: ["isMe", "notMe", "in", "notIn"],
};

/** 多选值 chip 行（status/priority/source/assignee 值选择共用） */
const FilterValueChips = memo(function FilterValueChips({
  options,
  values,
  onToggle,
}: {
  options: Array<{ value: string; label: string }>;
  values: string[];
  onToggle: (value: string) => void;
}) {
  const colors = useThemeColors();
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => {
        const active = values.includes(option.value);
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onToggle(option.value)}
            className="rounded-full border px-3 py-1.5"
            style={{
              borderColor: active ? colors.primary : "transparent",
              backgroundColor: colors.subtle,
            }}
          >
            <Text
              className="text-xs"
              style={{ color: active ? colors.primary : undefined }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
});

/** 计划筛选面板：字段添加 chips + 条件行（操作符切换 + 值编辑） */
const PlanFilterDialog = memo(function PlanFilterDialog({
  conditions,
  members,
  onChange,
  onClose,
}: {
  conditions: PlanFilterCondition[];
  members: ProjectMemberItemDto[];
  onChange: (next: PlanFilterCondition[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();

  const fieldLabel = (field: PlanFilterCondition["field"]) =>
    t(`filter.field.${field}`);
  const valueOptions = (
    field: PlanFilterCondition["field"],
  ): Array<{ value: string; label: string }> => {
    if (field === "status") {
      return PLAN_STATUSES.map((v) => ({
        value: v,
        label: t(`status.${v}`),
      }));
    }
    if (field === "priority") {
      return PLAN_PRIORITIES.map((v) => ({
        value: v,
        label: t(`priority.${v}`),
      }));
    }
    if (field === "source") {
      return FILTER_SOURCE_VALUES.map((v) => ({
        value: v,
        label: t(`filter.source${v === "ai" ? "Ai" : v === "template" ? "Template" : "Manual"}`),
      }));
    }
    return members.map((m) => ({ value: String(m.userId), label: m.nickname }));
  };

  /** 值编辑区（按字段/操作符形态分发；isMe/notMe 无值区） */
  function renderValueEditor(condition: PlanFilterCondition) {
    const { field, op, value } = condition;
    if (field === "title" || field === "tags") {
      return (
        <TextInput
          value={Array.isArray(value) ? (value[0] ?? "") : value}
          onChangeText={(text) =>
            onChange(patchConditionUpdater(field, { value: text })(conditions))
          }
          placeholder={t("filter.valuePlaceholder")}
          placeholderTextColor={PLACEHOLDER}
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
        />
      );
    }
    if (field === "assigneeId" && (op === "isMe" || op === "notMe")) {
      return null;
    }
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <FilterValueChips
        options={valueOptions(field)}
        values={list}
        onToggle={(v) =>
          onChange(toggleConditionValueUpdater(field, v)(conditions))
        }
      />
    );
  }

  return (
    <DialogShell
      title={t("filter.title")}
      busy={false}
      onClose={onClose}
      footer={
        <FormFooter
          busy={false}
          confirmDisabled={false}
          onConfirm={onClose}
          onCancel={onClose}
          auxLabel={conditions.length > 0 ? t("filter.reset") : undefined}
          onAux={conditions.length > 0 ? () => onChange([]) : undefined}
        />
      }
    >
      {/* 字段添加行：已含字段实心（再点移除），未含可添加（字段唯一） */}
      <View className="flex-row flex-wrap gap-2">
        {PLAN_FILTER_FIELDS.map((field) => {
          const active = conditions.some((c) => c.field === field);
          return (
            <Pressable
              key={field}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() =>
                onChange(
                  active
                    ? removeConditionUpdater(field)(conditions)
                    : addConditionUpdater(field)(conditions),
                )
              }
              className="rounded-full px-3 py-1.5"
              style={{ backgroundColor: active ? colors.primary : colors.subtle }}
            >
              <Text
                className="text-xs"
                style={{ color: active ? "#FFFFFF" : colors.primary }}
              >
                {fieldLabel(field)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView className="max-h-72">
        {conditions.map((condition) => {
          const ops = FILTER_OPS_BY_FIELD[condition.field];
          return (
            <View
              key={condition.field}
              className="gap-2 rounded-lg border border-sep p-2.5 dark:border-[#545458A6]"
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
                  {fieldLabel(condition.field)}
                </Text>
                <Pressable
                  onPress={() =>
                    onChange(
                      removeConditionUpdater(condition.field)(conditions),
                    )
                  }
                  hitSlop={8}
                >
                  <X size={14} color="#8E8E93" />
                </Pressable>
              </View>
              {ops.length > 1 && (
                <FilterValueChips
                  options={ops.map((op) => ({
                    value: op,
                    label: t(`filter.op.${op}`),
                  }))}
                  values={[condition.op]}
                  onToggle={(op) =>
                    onChange(
                      setConditionOpUpdater(
                        condition.field,
                        op as PlanFilterCondition["op"],
                      )(conditions),
                    )
                  }
                />
              )}
              {renderValueEditor(condition)}
            </View>
          );
        })}
      </ScrollView>
    </DialogShell>
  );
});

/** 事项行：标题/优先级色点/处理人昵称/截止 MM-dd（行上禁 flex-1——
 *  仅文本节点收 min-w-0，防 Yoga 0 高塌行）；批②：长按开操作面板
 *  （状态快捷流转+删除） */
const PlanItemRow = memo(function PlanItemRow({
  item,
  assigneeName,
  isLast,
  onOpen,
  onLongPress,
}: {
  item: PlanItemRecordDto;
  assigneeName: string;
  isLast: boolean;
  onOpen: (item: PlanItemRecordDto) => void;
  onLongPress: (item: PlanItemRecordDto) => void;
}) {
  const colors = useThemeColors();
  const dueKey = isoToDateKey(item.dueDate);
  const dotColor =
    PRIORITY_DOT_COLORS[item.priority] === "primary"
      ? colors.primary
      : PRIORITY_DOT_COLORS[item.priority];
  return (
    <Pressable
      onPress={() => onOpen(item)}
      onLongPress={() => onLongPress(item)}
      className={`flex-row items-center gap-2 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      <View
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <Text
        numberOfLines={1}
        className="min-w-0 flex-1 text-[15px] text-black dark:text-white"
      >
        {item.title}
      </Text>
      <Text
        numberOfLines={1}
        className="max-w-20 text-xs text-label3 dark:text-[#EBEBF54D]"
      >
        {assigneeName}
      </Text>
      <Text className="w-11 text-right text-xs text-label3 dark:text-[#EBEBF54D]">
        {dueKey === "" ? "" : dueKey.slice(5)}
      </Text>
    </Pressable>
  );
});

/** 图片预览弹层：readAssetImage 拼 data URL；失败占位文案 */
function AssetImageModal({
  projectId,
  path,
  visible,
  onClose,
}: {
  projectId: number;
  path: string[] | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("project");
  const [state, setState] = useState<
    { status: "loading" } | { status: "ok"; url: string } | { status: "failed" }
  >({ status: "loading" });

  useEffect(() => {
    if (!visible || !path) return;
    let cancelled = false;
    setState({ status: "loading" });
    useProjectStore
      .getState()
      .readAssetImage(projectId, path)
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "ok",
          url: `data:${result.mime};base64,${result.dataBase64}`,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, path, projectId]);

  const fileName = path?.[path.length - 1] ?? "";
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View className="flex-1 items-center justify-center bg-black/80 px-6">
        <Pressable
          accessibilityLabel={t("back")}
          hitSlop={12}
          className="absolute right-5 top-14 z-10"
          onPress={onClose}
        >
          <X size={24} color="white" />
        </Pressable>
        {state.status === "ok" ? (
          <Image
            source={{ uri: state.url }}
            resizeMode="contain"
            className="h-3/4 w-full"
          />
        ) : (
          <View className="h-48 items-center justify-center">
            {state.status === "loading" ? (
              <ActivityIndicator color="white" size="large" />
            ) : (
              <Text className="text-center text-sm text-white/80">
                {t("imageFailed")}
              </Text>
            )}
          </View>
        )}
        <Text numberOfLines={1} className="mt-3 text-xs text-white/70">
          {fileName}
        </Text>
      </View>
    </Modal>
  );
}

/** 资产行：文件夹/文件图标 + 名称 + size/相对时间 */
function AssetRow({
  entry,
  isLast,
  onOpen,
  onMenu,
}: {
  entry: AssetEntryDto;
  isLast: boolean;
  onOpen: (entry: AssetEntryDto) => void;
  onMenu: (entry: AssetEntryDto) => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation("project");
  return (
    <Pressable
      onPress={() => onOpen(entry)}
      onLongPress={() => onMenu(entry)}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      {entry.type === "folder" ? (
        <Folder size={20} color={colors.primary} />
      ) : (
        <File size={20} color={colors.primary} />
      )}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-[15px] text-black dark:text-white"
        >
          {entry.name}
        </Text>
        <Text
          numberOfLines={1}
          className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
        >
          {entry.type === "folder"
            ? relativeTimeLabel(formatRelative(entry.updatedAt), t)
            : `${formatSize(entry.size)} · ${relativeTimeLabel(formatRelative(entry.updatedAt), t)}`}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onMenu(entry)}
      >
        <MoreHorizontal size={18} color="#C7C7CC" />
      </Pressable>
    </Pressable>
  );
}

export default function ProjectWorkspaceScreen() {
  const { t } = useTranslation(["project", "chat", "common"]);
  const params = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const projectId = Number(params.id);
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((state) => state.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const supported = capabilities?.includes("project") ?? false;
  const detail = useProjectStore((state) => state.detail);
  const members = useProjectStore((state) => state.members);
  const detailFacet = useProjectStore((state) => state.detailFacet);
  const items = useProjectStore((state) => state.items);
  const fields = useProjectStore((state) => state.fields);
  const views = useProjectStore((state) => state.views);
  const activeViewId = useProjectStore((state) => state.activeViewId);
  const plan = useProjectStore((state) => state.plan);
  const entries = useProjectStore((state) => state.entries);
  const folderPath = useProjectStore((state) => state.folderPath);
  const storage = useProjectStore((state) => state.storage);
  const assets = useProjectStore((state) => state.assets);
  const currentUserId = useProjectStore((state) => state.currentUserId);
  const saving = useProjectStore((state) => state.saving);
  const [tab, setTab] = useState<WsTab>("plan");
  /** #8 筛选批：本地会话态组合筛选（不随视图持久化——planView 只读现状） */
  const [localFilters, setLocalFilters] = useState<PlanFilterCondition[]>([]);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  /** #1 视图写面批：长按视图 chip 的管理面板目标 / 新建·重命名弹窗态 */
  const [viewSheetTarget, setViewSheetTarget] =
    useState<PlanViewRecordDto | null>(null);
  const [viewDialog, setViewDialog] = useState<"create" | "rename" | null>(
    null,
  );
  const [viewName, setViewName] = useState("");
  const [viewType, setViewType] = useState<PlanViewType>("table");
  const [itemDialog, setItemDialog] = useState<
    | { mode: "create"; status?: PlanStatus }
    | { mode: "edit"; item: PlanItemRecordDto }
    | null
  >(null);
  const [assetSheetTarget, setAssetSheetTarget] =
    useState<AssetEntryDto | null>(null);
  /** 批②：计划事项长按目标（状态快捷流转+删除入口面板） */
  const [planSheetTarget, setPlanSheetTarget] =
    useState<PlanItemRecordDto | null>(null);
  const [folderDialog, setFolderDialog] = useState<"create" | "rename" | null>(
    null,
  );
  const [assetName, setAssetName] = useState("");
  const [imageTarget, setImageTarget] = useState<string[] | null>(null);
  const [textPreview, setTextPreview] = useState<{
    path: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!Number.isFinite(projectId) || !activeConnId || !supported) return;
    const store = useProjectStore.getState();
    void store.loadDetail(projectId);
    void store.loadPlan(projectId);
    void store.loadAssets(projectId);
    void store.loadStorage(projectId);
  }, [projectId, activeConnId, supported]);

  /** #13 定时任务批：本项目任务（orchestration 同源派生——启停/删除的
   *  乐观翻转在 store 生效，本区块随订阅自动刷新；桌面 ConfigPanel 同位） */
  const allTasks = useOrchestrationStore((state) => state.tasks);
  const tasksLoading = useOrchestrationStore((state) => state.tasksLoading);
  const projectTasks = useMemo(
    () => allTasks.filter((task) => task.projectId === projectId),
    [allTasks, projectId],
  );
  useEffect(() => {
    if (tab !== "about" || !activeConnId || !supported) return;
    void useOrchestrationStore.getState().loadTasks();
  }, [tab, activeConnId, supported]);

  /** 处理人昵称映射（未指派显示 -） */
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.userId, member.nickname])),
    [members],
  );

  const activeView = useMemo(
    () => resolveActiveView(views, activeViewId),
    [views, activeViewId],
  );

  /** 计划拍平：激活视图条件+排序 → 本地筛选叠加 → 视图分组依据分组
   *  （groupBy 生效——#1 视图批：status 全枚举组含空组+组尾快速新建；
   *  priority/assignee 空组不占位）→ 组头/事项/组尾条目 */
  const planEntries = useMemo<PlanEntry[]>(() => {
    const config = parsePlanViewConfig(
      activeView?.filterJson ?? "",
      activeView?.sortJson ?? "",
    );
    const viewFiltered = filterPlanItems(
      items,
      config.conditions,
      "",
      currentUserId ?? 0,
    );
    const filtered =
      localFilters.length > 0
        ? filterPlanItems(viewFiltered, localFilters, "", currentUserId ?? 0)
        : viewFiltered;
    const visible = sortPlanItems(filtered, config.sortRules);
    const viewGroupBy = activeView?.groupBy ?? "status";
    const groups = groupPlanItems(visible, viewGroupBy, members);
    const groupLabel = (groupValue: string): string => {
      if (viewGroupBy === "status") return t(`project:status.${groupValue}`);
      if (viewGroupBy === "priority") return t(`project:priority.${groupValue}`);
      return groupValue === "unassigned"
        ? t("project:unassigned")
        : (memberNames.get(Number(groupValue)) ?? "-");
    };
    const entries: PlanEntry[] = [];
    groups.forEach((group) => {
      if (viewGroupBy === "status") {
        const status = group.key as PlanStatus;
        if (!PLAN_STATUSES.includes(status)) return;
        entries.push({
          kind: "header",
          key: `h-${group.key}`,
          groupBy: "status",
          groupValue: status,
          label: groupLabel(status),
          count: group.items.length,
        });
        group.items.forEach((item, index) => {
          entries.push({
            kind: "item",
            key: `i-${item.id}`,
            item,
            isLast: index === group.items.length - 1,
          });
        });
        entries.push({ kind: "add", key: `a-${group.key}`, status });
        return;
      }
      // priority/assignee：空组不占位（成员枚举全量组会拉长列表）
      if (group.items.length === 0) return;
      entries.push({
        kind: "header",
        key: `h-${group.key}`,
        groupBy: viewGroupBy,
        groupValue: group.key,
        label: groupLabel(group.key),
        count: group.items.length,
      });
      group.items.forEach((item, index) => {
        entries.push({
          kind: "item",
          key: `i-${item.id}`,
          item,
          isLast: index === group.items.length - 1,
        });
      });
    });
    return entries;
  }, [items, activeView, members, currentUserId, localFilters, memberNames, t]);

  const openPlanItem = useCallback(
    (item: PlanItemRecordDto) => setItemDialog({ mode: "edit", item }),
    [],
  );
  const openQuickCreate = useCallback(
    (status: PlanStatus) => setItemDialog({ mode: "create", status }),
    [],
  );

  /** 批②：状态快捷流转（updateItem 不动排序——moveItem 留给真排序场景）；
   *  失败 toast，成功面板即闭（refreshPlanAfterWrite 局部重拉） */
  async function handleStatusChange(
    item: PlanItemRecordDto,
    status: PlanStatus,
  ) {
    setPlanSheetTarget(null);
    if (item.status === status) return;
    const store = useProjectStore.getState();
    const ok = await store.updateItem({ id: item.id, status });
    if (!ok) toast.error(store.hub.error || t("project:itemDialog.saveFailed"));
  }

  /** 批②：删除计划事项（Alert 二次确认——对齐资产/项目删除先例） */
  function confirmDeletePlanItem(item: PlanItemRecordDto) {
    Alert.alert(
      t("project:deleteItem"),
      t("project:deleteItemConfirm", { title: item.title }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("project:deleteItem"),
          style: "destructive",
          onPress: () => void performDeletePlanItem(item.id),
        },
      ],
      { cancelable: true },
    );
  }

  async function performDeletePlanItem(id: number) {
    const ok = await useProjectStore.getState().removeItem(id);
    if (!ok) {
      toast.error(
        useProjectStore.getState().hub.error || t("project:loadFailed"),
      );
    }
  }

  /** 视图新建/重命名提交（服务端重名自动 (n) 后缀；新建即激活） */
  async function handleViewDialogConfirm() {
    const trimmed = viewName.trim();
    if (!trimmed) return;
    const store = useProjectStore.getState();
    const ok =
      viewDialog === "create"
        ? (await store.createView(projectId, {
            name: trimmed,
            type: viewType,
          })) !== null
        : await store.updateView({
            id: viewSheetTarget?.id,
            name: trimmed,
          } as Parameters<typeof store.updateView>[0]);
    if (ok) {
      setViewDialog(null);
      setViewSheetTarget(null);
    } else {
      toast.error(store.hub.error || t("project:loadFailed"));
    }
  }

  /** 视图删除（Alert 确认；最后一个由服务端 PLAN_VIEW_LAST_ONE 拒删） */
  function confirmDeleteView(view: PlanViewRecordDto) {
    Alert.alert(
      t("project:deleteView"),
      t("project:deleteViewConfirm", { name: view.name }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("common:confirm"),
          style: "destructive",
          onPress: () => void performDeleteView(view.id),
        },
      ],
      { cancelable: true },
    );
  }

  async function performDeleteView(id: number) {
    const store = useProjectStore.getState();
    const ok = await store.removeView(id);
    if (!ok) toast.error(store.hub.error || t("project:loadFailed"));
  }

  /** 任务推进直达专属会话（桌面对齐 openTaskSession：服务端按 planItemId
   *  查重复用——一任务一会话；复用到已归档会话时先撤销归档再进） */
  async function advanceTask(item: PlanItemRecordDto) {
    const brief = await useSessionsStore
      .getState()
      .create(item.title, undefined, { projectId, planItemId: item.id });
    if (brief === null) {
      toast.error(t("project:advanceFailed"));
      return;
    }
    if (brief.archivedAt !== null) {
      await useSessionsStore.getState().update(brief.id, { archived: false });
    }
    router.push(`/session/${brief.id}`);
  }

  /** 资产上传（桌面对齐 AssetsPane 上传；复用资料库 picker→base64 链——
   *  扩展名守卫与 3MB 客户端预检同口径，服务端 ASSET_UPLOAD_INVALID 兜底）；
   *  成功不 toast——资产面与用量经 refreshAssetsAfterWrite 刷新即见 */
  async function handleUploadAsset() {
    const picked = await pickLibraryFile();
    if (picked === null) return;
    if (picked === "invalid") {
      toast.info(t("project:uploadInvalidName"));
      return;
    }
    if (picked === "tooLarge") {
      toast.info(t("project:uploadTooLarge"));
      return;
    }
    const ok = await useProjectStore
      .getState()
      .uploadAsset(projectId, picked.name, picked.base64);
    if (!ok) toast.error(t("project:uploadFailed"));
  }

  function notifyFailure() {
    const message = useProjectStore.getState().hub.error;
    toast.error(message || t("project:loadFailed"));
  }

  async function handleItemSubmit(
    payload: PlanItemCreatePayload | PlanItemUpdatePayload,
  ) {
    const store = useProjectStore.getState();
    const ok =
      itemDialog?.mode === "create"
        ? await store.createItem(payload as PlanItemCreatePayload)
        : await store.updateItem(payload as PlanItemUpdatePayload);
    if (ok) setItemDialog(null);
    else toast.error(store.hub.error || t("project:itemDialog.saveFailed"));
  }

  /** 文件点击：图片弹层 / 文本预览（files/read + assetWorkspaceId）/
   *  其余 toast 桌面端 */
  function openAsset(entry: AssetEntryDto) {
    if (entry.type === "folder") {
      void useProjectStore
        .getState()
        .loadAssets(projectId, [...folderPath, entry.name]);
      return;
    }
    const ext = entry.ext.toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      setImageTarget([...folderPath, entry.name]);
      return;
    }
    if (TEXT_EXTS.has(ext)) {
      setTextPreview({
        path: folderPath.length
          ? `${folderPath.join("/")}/${entry.name}`
          : entry.name,
        name: entry.name,
      });
      return;
    }
    toast.info(t("project:previewOnDesktop"));
  }

  function confirmDeleteAsset(entry: AssetEntryDto) {
    setAssetSheetTarget(null);
    const message =
      entry.type === "folder"
        ? t("project:deleteFolderConfirm")
        : t("common:confirm");
    Alert.alert(t("project:deleteAsset"), message, [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("common:confirm"),
        style: "destructive",
        onPress: () => void performDeleteAsset(entry),
      },
    ]);
  }

  async function performDeleteAsset(entry: AssetEntryDto) {
    const ok = await useProjectStore
      .getState()
      .removeAsset(projectId, [...folderPath, entry.name]);
    if (!ok) notifyFailure();
  }

  async function handleAssetDialogConfirm() {
    const trimmed = assetName.trim();
    if (!trimmed) return;
    const store = useProjectStore.getState();
    const ok =
      folderDialog === "create"
        ? await store.createFolder(projectId, trimmed)
        : assetSheetTarget
          ? await store.renameAsset(
              projectId,
              [...folderPath, assetSheetTarget.name],
              trimmed,
            )
          : false;
    if (ok) {
      setFolderDialog(null);
      setAssetSheetTarget(null);
    } else {
      notifyFailure();
    }
  }

  const usagePercent =
    storage && storage.quotaBytes > 0
      ? Math.min(1, storage.usedBytes / storage.quotaBytes)
      : 0;

  function renderGuide() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
        </View>
      );
    }
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("project:noProject")}
        </Text>
      </View>
    );
  }

  function renderPlan() {
    if (plan.error && !plan.initialized) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:loadFailed")}
          </Text>
          <Pressable
            onPress={() => void useProjectStore.getState().loadPlan(projectId)}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("project:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    if (planEntries.length === 0) {
      return (
        <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {localFilters.length > 0
            ? t("project:filter.empty")
            : t("project:emptyPlan")}
        </Text>
      );
    }
    return (
      <FlatList
        className="flex-1"
        data={planEntries}
        keyExtractor={(entry) => entry.key}
        renderItem={({ item: entry }) => {
          if (entry.kind === "header") {
            return (
              <PlanGroupHeaderRow label={entry.label} count={entry.count} />
            );
          }
          if (entry.kind === "add") {
            return (
              <PlanGroupAddRow
                status={entry.status}
                onPress={openQuickCreate}
              />
            );
          }
          return (
            <PlanItemRow
              item={entry.item}
              isLast={entry.isLast}
              assigneeName={
                entry.item.assigneeId === null
                  ? "-"
                  : (memberNames.get(entry.item.assigneeId) ?? "-")
              }
              onOpen={openPlanItem}
              onLongPress={setPlanSheetTarget}
            />
          );
        }}
      />
    );
  }

  function renderAssets() {
    if (assets.error && !assets.initialized) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:loadFailed")}
          </Text>
          <Pressable
            onPress={() =>
              void useProjectStore.getState().loadAssets(projectId, folderPath)
            }
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("project:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <ScrollView className="flex-1">
        {/* 面包屑：根 = 项目名 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 12,
            paddingBottom: 8,
          }}
        >
          <Pressable
            onPress={() =>
              void useProjectStore.getState().loadAssets(projectId)
            }
            hitSlop={8}
          >
            <Text className="text-sm" style={{ color: colors.primary }}>
              {detail?.project.name ?? t("project:root")}
            </Text>
          </Pressable>
          {folderPath.map((segment, index) => (
            <View
              key={`${segment}-${index}`}
              className="flex-row items-center gap-1"
            >
              <ChevronRight size={12} color="#C7C7CC" />
              <Pressable
                onPress={() =>
                  void useProjectStore
                    .getState()
                    .loadAssets(projectId, folderPath.slice(0, index + 1))
                }
                hitSlop={8}
              >
                <Text className="text-sm" style={{ color: colors.primary }}>
                  {segment}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
        {/* 用量条：超 80% 警示色 */}
        {storage && (
          <View className="gap-1 px-4 pb-2">
            <View className="h-1.5 overflow-hidden rounded-full bg-sep dark:bg-[#545458A6]">
              <View
                className="h-full rounded-full"
                style={{
                  width: `${usagePercent * 100}%`,
                  backgroundColor:
                    usagePercent > 0.8 ? "#FF9F0A" : colors.primary,
                }}
              />
            </View>
            <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
              {usagePercent > 0.8
                ? `${t("usage", {
                    used: formatSize(storage.usedBytes),
                    quota: formatSize(storage.quotaBytes),
                  })} · ${t("quotaWarning")}`
                : t("usage", {
                    used: formatSize(storage.usedBytes),
                    quota: formatSize(storage.quotaBytes),
                  })}
            </Text>
          </View>
        )}
        {/* 资产工具行：上传（picker→base64）+ 新建文件夹（桌面对齐：
            create 态弹窗逻辑本就备好，此前缺触发点致功能不可达；
            重命名后残留旧名故先清空） */}
        <View className="flex-row justify-end gap-4 px-4 pb-2">
          <Pressable
            onPress={() => void handleUploadAsset()}
            className="flex-row items-center gap-1"
            hitSlop={8}
          >
            <Upload size={14} color={colors.primary} />
            <Text className="text-xs" style={{ color: colors.primary }}>
              {t("project:upload")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setAssetName("");
              setFolderDialog("create");
            }}
            className="flex-row items-center gap-1"
            hitSlop={8}
          >
            <FolderPlus size={14} color={colors.primary} />
            <Text className="text-xs" style={{ color: colors.primary }}>
              {t("project:newFolder")}
            </Text>
          </Pressable>
        </View>
        {entries.length === 0 ? (
          <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:emptyAssets")}
          </Text>
        ) : (
          <View className="mx-3 overflow-hidden rounded-2xl">
            {entries.map((entry, index) => (
              <AssetRow
                key={entry.name}
                entry={entry}
                isLast={index === entries.length - 1}
                onOpen={openAsset}
                onMenu={setAssetSheetTarget}
              />
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  function renderAbout() {
    const bindings = detail?.bindings ?? [];
    const instructionText = detail?.project.systemPrompt?.trim() ?? "";
    const bindingIcon = (itemType: ProjectBindingItemDto["itemType"]) =>
      itemType === "assistant" ? (
        <Bot size={18} color={colors.primary} />
      ) : itemType === "skill" ? (
        <Boxes size={18} color={colors.primary} />
      ) : (
        <Link2 size={18} color={colors.primary} />
      );
    return (
      <ScrollView className="flex-1" contentContainerStyle={{ gap: 12 }}>
        <View className="mx-3 gap-2 rounded-2xl bg-card px-4 py-3 dark:bg-[#1C1C1E]">
          <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
            {t("project:instruction")}
          </Text>
          {/* 批②：指令 Markdown 子集渲染（项目指令为多段结构化提示词，
              纯文本长串可读性差——桌面同位 MarkdownView） */}
          {instructionText === "" ? (
            <Text className="text-sm leading-5 text-black dark:text-white">
              -
            </Text>
          ) : (
            <MarkdownLite text={instructionText} />
          )}
        </View>
        <View className="mx-3 gap-2">
          <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
            {t("project:members")}
          </Text>
          <View className="overflow-hidden rounded-2xl">
            {members.map((member, index) => (
              <View
                key={member.userId}
                className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
                  index === members.length - 1
                    ? ""
                    : "border-b border-sep dark:border-[#545458A6]"
                }`}
              >
                <View className="min-w-0 flex-1">
                  <Text
                    numberOfLines={1}
                    className="text-[15px] text-black dark:text-white"
                  >
                    {member.nickname}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
                  >
                    {member.username}
                  </Text>
                </View>
                <View
                  className="rounded-full px-2 py-0.5"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Text className="text-xs" style={{ color: colors.primary }}>
                    {member.role}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View className="mx-3 gap-2">
          <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
            {t("project:bindings")}
          </Text>
          <View className="overflow-hidden rounded-2xl">
            {bindings.length === 0 ? (
              <View className="bg-card px-3 py-3 dark:bg-[#1C1C1E]">
                <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                  -
                </Text>
              </View>
            ) : (
              bindings.map((binding, index) => (
                <View
                  key={binding.id}
                  className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
                    index === bindings.length - 1
                      ? ""
                      : "border-b border-sep dark:border-[#545458A6]"
                  }`}
                  style={{ opacity: binding.valid ? 1 : 0.5 }}
                >
                  {bindingIcon(binding.itemType)}
                  <Text
                    numberOfLines={1}
                    className="min-w-0 flex-1 text-[15px] text-black dark:text-white"
                  >
                    {binding.itemName}
                  </Text>
                  {!binding.valid && (
                    <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                      {t("project:bindingInvalid")}
                    </Text>
                  )}
                </View>
              ))
            )}
          </View>
        </View>
        {/* #13 定时任务批：本项目任务（AutomationCard 复用——启停/立即
            运行/点击编辑/长按历史与删除，桌面 ConfigPanel 区块③同位） */}
        <View className="mx-3 gap-2">
          <View className="flex-row items-center justify-between px-1">
            <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
              {t("project:automationTasks")}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("orchestration:newTask")}
              onPress={() => router.push(`/automation/new?projectId=${projectId}`)}
              className="flex-row items-center gap-1"
              hitSlop={8}
            >
              <Plus size={14} color={colors.primary} />
              <Text className="text-xs" style={{ color: colors.primary }}>
                {t("orchestration:newTask")}
              </Text>
            </Pressable>
          </View>
          {projectTasks.length === 0 ? (
            <Text className="bg-card px-4 py-4 text-center text-sm text-label2 dark:bg-[#1C1C1E] dark:text-[#EBEBF599]">
              {tasksLoading && allTasks.length === 0
                ? "…"
                : t("orchestration:emptyTasks")}
            </Text>
          ) : (
            <View className="overflow-hidden rounded-2xl">
              {projectTasks.map((task, index) => (
                <AutomationCard
                  key={task.id}
                  task={task}
                  isLast={index === projectTasks.length - 1}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    );
  }

  const loadingInitial = detailFacet.loading && !detailFacet.initialized;
  const projectName = detail?.project.name ?? "";

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={projectName}
        backLabel={t("project:back")}
        right={
          detail?.sessionId != null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("project:openProjectSession")}
              onPress={() => router.push(`/session/${detail.sessionId}`)}
              className="h-11 w-11 items-center justify-center rounded-full"
              style={({ pressed }) => ({
                backgroundColor: pressed ? colors.subtle : "transparent",
              })}
            >
              <MessageCircle size={22} color={colors.primary} />
            </Pressable>
          ) : undefined
        }
      />
      {!activeConnId || !supported ? (
        renderGuide()
      ) : (
        <>
          {/* 计划 Tab 工具行：视图 chips 横滚 + 筛选入口（激活条件数徽标） */}
          {tab === "plan" && views.length > 0 && (
            <View className="flex-row items-center">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                className="min-w-0 flex-1"
                style={{ flexGrow: 0, flexShrink: 0 }}
                contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}
              >
                {views.map((view) => {
                  const active = view.id === activeView?.id;
                  return (
                    <Pressable
                      key={view.id}
                      onPress={() =>
                        useProjectStore.getState().setActiveView(view.id)
                      }
                      onLongPress={() => setViewSheetTarget(view)}
                      className="rounded-full px-3 py-1.5"
                      style={{
                        backgroundColor: active
                          ? colors.primary
                          : colors.subtle,
                      }}
                    >
                      <Text
                        className="text-xs"
                        style={{ color: active ? "#FFFFFF" : colors.primary }}
                      >
                        {view.name === "" ? t("project:defaultView") : view.name}
                      </Text>
                    </Pressable>
                  );
                })}
                {/* 新建视图（#1 视图写面批）：列尾「+」 */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("project:newView")}
                  onPress={() => {
                    setViewName("");
                    setViewType("table");
                    setViewDialog("create");
                  }}
                  className="items-center justify-center rounded-full px-3 py-1.5"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Plus size={13} color={colors.primary} />
                </Pressable>
              </ScrollView>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("project:filter.title")}
                onPress={() => setFilterPanelOpen(true)}
                className="relative mr-3 h-8 w-8 items-center justify-center rounded-full"
                style={{ backgroundColor: colors.subtle }}
              >
                <Filter size={14} color={colors.primary} />
                {localFilters.length > 0 && (
                  <View
                    className="absolute -right-0.5 -top-0.5 h-4 min-w-4 items-center justify-center rounded-full px-1"
                    style={{ backgroundColor: colors.primary }}
                  >
                    <Text className="text-[10px] font-medium text-white">
                      {localFilters.length}
                    </Text>
                  </View>
                )}
              </Pressable>
            </View>
          )}
          <WsSegments tab={tab} disabled={saving} onSelect={setTab} />
          {loadingInitial ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : tab === "plan" ? (
            renderPlan()
          ) : tab === "assets" ? (
            renderAssets()
          ) : (
            renderAbout()
          )}
        </>
      )}
      {/* #1 视图写面批：长按视图 chip——重命名 / 分组依据切换 / 删除 */}
      <AppActionSheet
        visible={viewSheetTarget !== null}
        title={
          viewSheetTarget?.name === ""
            ? t("project:defaultView")
            : viewSheetTarget?.name
        }
        items={
          viewSheetTarget
            ? [
                {
                  key: "rename",
                  label: t("project:renameView"),
                  Icon: Pencil,
                  onPress: () => {
                    setViewName(viewSheetTarget.name);
                    setViewDialog("rename");
                  },
                },
                ...(PLAN_GROUP_BYS.map((groupBy) => ({
                  key: `group-${groupBy}`,
                  label:
                    groupBy === viewSheetTarget.groupBy
                      ? t("project:groupByOption", {
                          by: t(`project:groupBy.${groupBy}`),
                        })
                      : t("project:groupBySet", {
                          by: t(`project:groupBy.${groupBy}`),
                        }),
                  Icon: LayoutList,
                  onPress: () => {
                    const target = viewSheetTarget;
                    setViewSheetTarget(null);
                    void useProjectStore
                      .getState()
                      .updateView({
                        id: target.id,
                        groupBy:
                          target.groupBy === groupBy ? null : groupBy,
                      })
                      .then((ok) => {
                        if (!ok) {
                          toast.error(
                            useProjectStore.getState().hub.error ||
                              t("project:loadFailed"),
                          );
                        }
                      });
                  },
                })) as ActionSheetItem[]),
                {
                  key: "delete",
                  label: t("project:deleteView"),
                  Icon: Trash2,
                  danger: true,
                  onPress: () => {
                    const target = viewSheetTarget;
                    setViewSheetTarget(null);
                    confirmDeleteView(target);
                  },
                },
              ]
            : []
        }
        onClose={() => setViewSheetTarget(null)}
      />
      {viewDialog !== null && (
        <DialogShell
          title={t(
            viewDialog === "create"
              ? "project:newView"
              : "project:renameView",
          )}
          busy={saving}
          onClose={() => setViewDialog(null)}
          footer={
            <FormFooter
              busy={saving}
              confirmDisabled={!viewName.trim()}
              onConfirm={() => void handleViewDialogConfirm()}
              onCancel={() => setViewDialog(null)}
            />
          }
        >
          <FormField
            label={t("project:viewName")}
            value={viewName}
            onChangeText={setViewName}
          />
          {viewDialog === "create" && (
            <View className="gap-1.5">
              <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                {t("project:viewType")}
              </Text>
              <FilterValueChips
                options={PLAN_VIEW_TYPES.map((type) => ({
                  value: type,
                  label: t(`project:viewType.${type}`),
                }))}
                values={[viewType]}
                onToggle={(value) =>
                  setViewType(value as Parameters<typeof setViewType>[0])
                }
              />
            </View>
          )}
        </DialogShell>
      )}
      {/* 批②：计划事项长按面板——状态快捷流转（当前态不列）+ 删除 */}
      <AppActionSheet
        visible={planSheetTarget !== null}
        title={planSheetTarget?.title ?? undefined}
        items={
          planSheetTarget
            ? [
                {
                  key: "advance",
                  label: t("project:advanceTask"),
                  Icon: MessageCirclePlus,
                  onPress: () => {
                    const target = planSheetTarget;
                    setPlanSheetTarget(null);
                    void advanceTask(target);
                  },
                },
                ...PLAN_STATUSES.filter(
                  (status) => status !== planSheetTarget.status,
                ).map((status) => ({
                  key: `status-${status}`,
                  label: t("project:moveTo", {
                    status: t(`project:status.${status}`),
                  }),
                  Icon: CircleDot,
                  onPress: () =>
                    void handleStatusChange(planSheetTarget, status),
                })),
                {
                  key: "delete",
                  label: t("project:deleteItem"),
                  Icon: Trash2,
                  danger: true,
                  onPress: () => {
                    const target = planSheetTarget;
                    setPlanSheetTarget(null);
                    confirmDeletePlanItem(target);
                  },
                },
              ]
            : []
        }
        onClose={() => setPlanSheetTarget(null)}
      />
      <AppActionSheet
        visible={assetSheetTarget !== null}
        title={assetSheetTarget?.name}
        items={
          assetSheetTarget
            ? [
                {
                  key: "rename",
                  label: t("project:renameAsset"),
                  Icon: Pencil,
                  onPress: () => {
                    setAssetName(assetSheetTarget.name);
                    setFolderDialog("rename");
                  },
                },
                {
                  key: "delete",
                  label: t("project:deleteAsset"),
                  Icon: Trash2,
                  danger: true,
                  onPress: () => confirmDeleteAsset(assetSheetTarget),
                },
              ]
            : []
        }
        onClose={() => setAssetSheetTarget(null)}
      />
      {folderDialog !== null && (
        <DialogShell
          title={t(
            folderDialog === "create"
              ? "project:newFolder"
              : "project:renameAsset",
          )}
          busy={saving}
          onClose={() => setFolderDialog(null)}
          footer={
            <FormFooter
              busy={saving}
              confirmDisabled={!assetName.trim()}
              onConfirm={() => void handleAssetDialogConfirm()}
              onCancel={() => setFolderDialog(null)}
            />
          }
        >
          <FormField
            label={t(
              folderDialog === "create"
                ? "project:newFolder"
                : "project:renameAsset",
            )}
            value={assetName}
            onChangeText={setAssetName}
          />
        </DialogShell>
      )}
      {filterPanelOpen && (
        <PlanFilterDialog
          conditions={localFilters}
          members={members}
          onChange={setLocalFilters}
          onClose={() => setFilterPanelOpen(false)}
        />
      )}
      {itemDialog !== null && (
        <PlanItemDialog
          projectId={projectId}
          item={itemDialog.mode === "edit" ? itemDialog.item : undefined}
          defaultStatus={
            itemDialog.mode === "create" ? itemDialog.status : undefined
          }
          members={members}
          fields={fields}
          busy={saving}
          onClose={() => setItemDialog(null)}
          onSubmit={(payload) => void handleItemSubmit(payload)}
          onDelete={(item) => {
            setItemDialog(null);
            confirmDeletePlanItem(item);
          }}
        />
      )}
      <AssetImageModal
        projectId={projectId}
        path={imageTarget}
        visible={imageTarget !== null}
        onClose={() => setImageTarget(null)}
      />
      <FilePreviewModal
        visible={textPreview !== null}
        path={textPreview?.path ?? ""}
        workspaceId={detail?.assetWorkspaceId ?? null}
        onClose={() => setTextPreview(null)}
      />
    </SafeAreaView>
  );
}
