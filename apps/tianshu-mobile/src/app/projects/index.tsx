// 项目 hub 页（A7 批）：PageHeader + 搜索框 + 分段 [项目|我的任务]。
// 项目 Tab：项目卡列表（名称/指令摘要一行/相对更新时间）——点击 push
// 工作台，长按/⋯ 出操作面板（重命名/编辑指令/删除——Alert 二键确认，
// 文案明示级联删资产/会话/计划/视图/自动化）；「+」DialogShell 新建
// （名称+指令可选）。我的任务 Tab：范围/来源 chips + 标题过滤（store 内
// 纯前端）+ 行列表（状态点/优先级色点/所属项目名——本地显示「本地」），
// 点击行 → PlanItemDialog（本地任务 projectId=null，隐藏项目字段与附件）。
// 页内双重门禁：无连接/无 project 能力 → 降级引导页（照 library.tsx）。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  FolderGit2,
  MoreHorizontal,
  Pencil,
  Plus,
  ScanText,
  Trash2,
} from "lucide-react-native";

import { AppActionSheet } from "@/components/AppActionSheet";
import { DialogShell } from "@/components/DialogShell";
import { FormField, PLACEHOLDER } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { PageHeader } from "@/components/PageHeader";
import { PlanItemDialog } from "@/components/PlanItemDialog";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import { formatRelative } from "@/logic/time";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { filterMine, useProjectStore } from "@/store/project.store";
import type { TaskScope, TaskSource } from "@/store/project.store";
import { useThemeColors } from "@/store/theme";
import type {
  PlanItemCreatePayload,
  PlanItemRecordDto,
  PlanItemUpdatePayload,
  ProjectRecordDto,
} from "@tianshu/protocol";

type HubTab = "projects" | "tasks";

const PRIORITY_DOT_COLORS = {
  P0: "#FF3B30",
  P1: undefined, // 主题色（useThemeColors 注入）
  P2: "#8E8E93",
  P3: "#C7C7CC",
} as const;

/** 分段栏 [项目|我的任务] */
function HubSegments({
  tab,
  disabled,
  onSelect,
}: {
  tab: HubTab;
  disabled: boolean;
  onSelect: (tab: HubTab) => void;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();
  const options = [
    { key: "projects", label: t("projectsTab") },
    { key: "tasks", label: t("tasksTab") },
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

/** 项目卡：名称 + 指令摘要一行 + 相对更新时间 */
function ProjectCard({
  project,
  isLast,
  onOpen,
  onMenu,
}: {
  project: ProjectRecordDto;
  isLast: boolean;
  onOpen: (project: ProjectRecordDto) => void;
  onMenu: (project: ProjectRecordDto) => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation("project");
  return (
    <Pressable
      onPress={() => onOpen(project)}
      onLongPress={() => onMenu(project)}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      <FolderGit2 size={20} color={colors.primary} />
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-[15px] text-black dark:text-white"
        >
          {project.name}
        </Text>
        <Text
          numberOfLines={1}
          className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
        >
          {project.systemPrompt?.trim()
            ? `${project.systemPrompt.trim().split("\n")[0]} · ${relativeTimeLabel(formatRelative(project.updatedAt), t)}`
            : relativeTimeLabel(formatRelative(project.updatedAt), t)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onMenu(project)}
      >
        <MoreHorizontal size={18} color="#C7C7CC" />
      </Pressable>
    </Pressable>
  );
}

/** 我的任务行：状态点 + 优先级色点 + 标题 + 来源（项目名/本地） */
function TaskRow({
  item,
  projectName,
  isLast,
  onOpen,
}: {
  item: PlanItemRecordDto;
  projectName: string;
  isLast: boolean;
  onOpen: (item: PlanItemRecordDto) => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => onOpen(item)}
      className={`flex-row items-center gap-2 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      <View
        className="h-2 w-2 rounded-full"
        style={{
          backgroundColor:
            item.status === "done"
              ? "#C7C7CC"
              : item.status === "in_progress"
                ? colors.primary
                : "#8E8E93",
        }}
      />
      <View
        className="h-2 w-2 rounded-full"
        style={{
          backgroundColor:
            PRIORITY_DOT_COLORS[item.priority] ?? colors.primary,
        }}
      />
      <Text
        numberOfLines={1}
        className="min-w-0 flex-1 text-[15px] text-black dark:text-white"
      >
        {item.title}
      </Text>
      <Text
        numberOfLines={1}
        className="max-w-24 text-xs text-label3 dark:text-[#EBEBF54D]"
      >
        {projectName}
      </Text>
    </Pressable>
  );
}

/** chips 行（范围/来源筛选共用） */
function FilterChips<T extends string>({
  options,
  value,
  onSelect,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onSelect: (value: T) => void;
}) {
  const colors = useThemeColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onSelect(option.value)}
            className="rounded-full px-3 py-1.5"
            style={{
              backgroundColor: active ? colors.primary : colors.subtle,
            }}
          >
            <Text
              className="text-xs"
              style={{ color: active ? "#FFFFFF" : colors.primary }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export default function ProjectsScreen() {
  const { t } = useTranslation(["project", "chat", "common"]);
  const router = useRouter();
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((state) => state.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const supported = capabilities?.includes("project") ?? false;
  const projects = useProjectStore((state) => state.projects);
  const hub = useProjectStore((state) => state.hub);
  const mine = useProjectStore((state) => state.mine);
  const tasks = useProjectStore((state) => state.tasks);
  const scope = useProjectStore((state) => state.scope);
  const source = useProjectStore((state) => state.source);
  const tasksKeyword = useProjectStore((state) => state.tasksKeyword);
  const currentUserId = useProjectStore((state) => state.currentUserId);
  const saving = useProjectStore((state) => state.saving);
  const [tab, setTab] = useState<HubTab>("projects");
  const [query, setQuery] = useState("");
  const [sheetTarget, setSheetTarget] = useState<ProjectRecordDto | null>(null);
  const [dialog, setDialog] = useState<
    "create" | "rename" | "instruction" | null
  >(null);
  const [itemDialogItem, setItemDialogItem] = useState<
    PlanItemRecordDto | "new" | null
  >(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (activeConnId && supported) {
      void useProjectStore.getState().load();
      void useProjectStore.getState().loadMine();
    }
  }, [activeConnId, supported]);

  /** 项目名映射（任务行来源展示；缺名兜底「项目」） */
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const visibleProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return projects.filter(
      (project) =>
        keyword === "" || project.name.toLowerCase().includes(keyword),
    );
  }, [projects, query]);

  const visibleTasks = useMemo(
    () => filterMine(mine, scope, source, tasksKeyword, currentUserId),
    [mine, scope, source, tasksKeyword, currentUserId],
  );

  function notifyFailure() {
    const message = useProjectStore.getState().hub.error;
    toast.error(message || t("project:loadFailed"));
  }

  function openCreate() {
    setName("");
    setInstruction("");
    setDialog("create");
  }

  function openRename(project: ProjectRecordDto) {
    setSheetTarget(null);
    setName(project.name);
    setDialog("rename");
  }

  function openInstruction(project: ProjectRecordDto) {
    setSheetTarget(null);
    setInstruction(project.systemPrompt ?? "");
    setDialog("instruction");
  }

  function confirmDelete(project: ProjectRecordDto) {
    setSheetTarget(null);
    Alert.alert(
      t("project:deleteProject"),
      t("project:deleteCascadeConfirm", { name: project.name }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("common:confirm"),
          style: "destructive",
          onPress: () => void performDelete(project.id),
        },
      ],
    );
  }

  async function performDelete(id: number) {
    const ok = await useProjectStore.getState().remove(id);
    if (!ok) notifyFailure();
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await useProjectStore.getState().create({
      name: trimmed,
      systemPrompt: instruction.trim() || undefined,
    });
    if (ok) setDialog(null);
    else notifyFailure();
  }

  async function handleRename() {
    if (!sheetTarget) return;
    const ok = await useProjectStore
      .getState()
      .rename(sheetTarget.id, name.trim());
    if (ok) setDialog(null);
    else notifyFailure();
  }

  async function handleInstruction() {
    if (!sheetTarget) return;
    const ok = await useProjectStore
      .getState()
      .updateInstruction(sheetTarget.id, instruction.trim());
    if (ok) setDialog(null);
    else notifyFailure();
  }

  /** 任务弹窗提交：新建（本地任务）/编辑分流 */
  async function handleItemSubmit(
    payload: PlanItemCreatePayload | PlanItemUpdatePayload,
  ) {
    const store = useProjectStore.getState();
    const ok = itemDialogItem === "new"
      ? await store.createItem(payload as PlanItemCreatePayload)
      : await store.updateItem(payload as PlanItemUpdatePayload);
    if (ok) setItemDialogItem(null);
    else toast.error(store.hub.error || t("project:itemDialog.saveFailed"));
  }

  const loadingInitial =
    (tab === "projects" ? hub.loading : tasks.loading) &&
    !(tab === "projects" ? hub.initialized : tasks.initialized);
  const loadError =
    tab === "projects" ? (hub.initialized ? null : hub.error) : tasks.error;
  const scopeOptions: Array<{ value: TaskScope; label: string }> = [
    { value: "all", label: t("project:tasks.scopeAll") },
    { value: "assigned", label: t("project:tasks.scopeAssigned") },
    { value: "created", label: t("project:tasks.scopeCreated") },
  ];
  const sourceOptions: Array<{ value: TaskSource; label: string }> = [
    { value: "all", label: t("project:tasks.sourceAll") },
    { value: "local", label: t("project:tasks.sourceLocal") },
    { value: "project", label: t("project:tasks.sourceProject") },
  ];

  function renderGuide() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
          <Pressable
            onPress={() => router.push("/connections")}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">
              {t("common:nav.toConnections")}
            </Text>
          </Pressable>
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

  function renderTasks() {
    if (tasks.error && !tasks.initialized) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:loadFailed")}
          </Text>
          <Text className="text-center text-xs text-label3 dark:text-[#EBEBF54D]">
            {tasks.error}
          </Text>
          <Pressable
            onPress={() => void useProjectStore.getState().loadMine()}
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
        <View className="gap-2 pb-2">
          <FilterChips
            options={scopeOptions}
            value={scope}
            onSelect={(value) => useProjectStore.getState().setScope(value)}
          />
          <FilterChips
            options={sourceOptions}
            value={source}
            onSelect={(value) => useProjectStore.getState().setSource(value)}
          />
        </View>
        {visibleTasks.length === 0 ? (
          <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:emptyTasks")}
          </Text>
        ) : (
          <View className="mx-3 overflow-hidden rounded-2xl">
            {visibleTasks.map((item, index) => (
              <TaskRow
                key={item.id}
                item={item}
                isLast={index === visibleTasks.length - 1}
                projectName={
                  item.projectId === null
                    ? t("project:tasks.local")
                    : (projectNames.get(item.projectId) ??
                      t("project:tasks.sourceProject"))
                }
                onOpen={setItemDialogItem}
              />
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  function renderProjects() {
    if (loadError) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:loadFailed")}
          </Text>
          <Text className="text-center text-xs text-label3 dark:text-[#EBEBF54D]">
            {loadError}
          </Text>
          <Pressable
            onPress={() => void useProjectStore.getState().load()}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("project:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    if (visibleProjects.length === 0) {
      return (
        <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("project:emptyProjects")}
        </Text>
      );
    }
    return (
      <ScrollView className="flex-1">
        <View className="mx-3 overflow-hidden rounded-2xl">
          {visibleProjects.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              isLast={index === visibleProjects.length - 1}
              onOpen={(row) => router.push(`/projects/${row.id}`)}
              onMenu={setSheetTarget}
            />
          ))}
        </View>
      </ScrollView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={t("project:title")}
        backLabel={t("project:back")}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("project:createProject")}
            disabled={!supported || saving}
            onPress={() => (tab === "projects" ? openCreate() : setItemDialogItem("new"))}
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={({ pressed }) => ({
              backgroundColor: pressed ? colors.subtle : undefined,
              opacity: !supported || saving ? 0.4 : 1,
            })}
          >
            <Plus size={18} color={colors.primary} />
          </Pressable>
        }
      />
      {!activeConnId || !supported ? (
        renderGuide()
      ) : (
        <>
          {tab === "projects" && (
            <View className="px-3 pb-2">
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t("project:searchPlaceholder")}
                placeholderTextColor={PLACEHOLDER}
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
              />
            </View>
          )}
          <HubSegments tab={tab} disabled={saving} onSelect={setTab} />
          {loadingInitial ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : tab === "projects" ? (
            renderProjects()
          ) : (
            renderTasks()
          )}
        </>
      )}
      <AppActionSheet
        visible={sheetTarget !== null}
        title={sheetTarget?.name}
        items={
          sheetTarget
            ? [
                {
                  key: "rename",
                  label: t("project:rename"),
                  Icon: Pencil,
                  onPress: () => openRename(sheetTarget),
                },
                {
                  key: "instruction",
                  label: t("project:editInstruction"),
                  Icon: ScanText,
                  onPress: () => openInstruction(sheetTarget),
                },
                {
                  key: "delete",
                  label: t("project:deleteProject"),
                  Icon: Trash2,
                  danger: true,
                  onPress: () => confirmDelete(sheetTarget),
                },
              ]
            : []
        }
        onClose={() => setSheetTarget(null)}
      />
      {dialog !== null && (
        <DialogShell
          title={t(
            dialog === "create"
              ? "project:createProject"
              : dialog === "rename"
                ? "project:renameProject"
                : "project:editInstruction",
          )}
          busy={saving}
          onClose={() => setDialog(null)}
          footer={
            <FormFooter
              busy={saving}
              confirmDisabled={
                dialog !== "instruction" ? !name.trim() : false
              }
              onConfirm={() => {
                if (dialog === "create") void handleCreate();
                else if (dialog === "rename") void handleRename();
                else void handleInstruction();
              }}
              onCancel={() => setDialog(null)}
            />
          }
        >
          {dialog !== "instruction" && (
            <FormField
              label={t("project:projectName")}
              value={name}
              onChangeText={setName}
            />
          )}
          {dialog !== "rename" && (
            <FormField
              label={t(
                dialog === "create"
                  ? "project:instructionOptional"
                  : "project:instruction",
              )}
              value={instruction}
              onChangeText={setInstruction}
              multiline
            />
          )}
        </DialogShell>
      )}
      {itemDialogItem !== null && (
        <PlanItemDialog
          projectId={null}
          item={itemDialogItem === "new" ? undefined : itemDialogItem}
          members={[]}
          fields={[]}
          busy={saving}
          onClose={() => setItemDialogItem(null)}
          onSubmit={(payload) => void handleItemSubmit(payload)}
        />
      )}
    </SafeAreaView>
  );
}
