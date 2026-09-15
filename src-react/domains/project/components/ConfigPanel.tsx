/**
 * 项目配置面板（spec §6.3，工作台右列）：
 * - 指令：MarkdownView 只读渲染 systemPrompt（空 → 占位文案）+ 编辑弹窗
 * - 能力挂载：三行（连接器/专家/技能）CapabilityRow + PickerDialog；
 *   失效挂载灰显 + X 显式移除，Picker 确认只替换该类型 valid 集，
 *   失效项原样保留（Task 6 裁定：编辑不静默丢弃）
 * - 定时任务：本项目任务行列表（名称/频率/状态/上次运行/启停/立即运行，
 *   projectId 前端过滤）+ 新建（CreateTaskDialog 项目预设：资产空间锁定）
 *   + 前往自动化入口 + 空态文案
 * - 成员：头像占位（昵称首字符）+ 昵称 + owner 徽标 + me 标记（单成员）
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Bot, Pencil, Play, Plug, Plus, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getDateFnsLocale } from "@/i18n";
import MarkdownView from "@/domains/ai/chat/components/MarkdownView";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { AssistantApi } from "@/domains/ai/api/assistant.api";
import { McpServerApi } from "@/domains/ai/api/mcp.api";
import SkillApi from "@/domains/ai/skills/api/skill.api";
import {
  AutomationApi,
  type AutomationStatus,
  type TaskRecord,
} from "@/domains/ai/automation/api/automation.api";
import { CreateTaskDialog } from "@/domains/ai/automation/components/CreateTaskDialog";
import { useUserStore } from "@/domains/user/store/user.store";
import ProjectApi from "../api/project.api";
import CapabilityRow from "./CapabilityRow";
import InstructionEditDialog from "./InstructionEditDialog";
import PickerDialog, { type PickerItem } from "./PickerDialog";
import type {
  ProjectBindingInput,
  ProjectBindingItem,
  ProjectBindingType,
  ProjectDetail,
} from "../../../../electron/domains/project/project.entity";

const AUTOMATION_ROUTE = "/module/ai/automation";

const CAPABILITY_ROWS: Array<{
  kind: ProjectBindingType;
  icon: LucideIcon;
  labelKey: string;
}> = [
  { kind: "mcpServer", icon: Plug, labelKey: "project:create.connectors" },
  { kind: "assistant", icon: Bot, labelKey: "project:create.experts" },
  { kind: "skill", icon: Sparkles, labelKey: "project:create.skills" },
];

interface ConfigPanelProps {
  detail: ProjectDetail;
}

export default function ConfigPanel({ detail }: ConfigPanelProps) {
  const { t } = useTranslation(["project", "chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useUserStore((state) => state.user);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<ProjectBindingType | null>(null);
  const [savingBindings, setSavingBindings] = useState(false);

  const { data: assistants = [] } = useQuery({
    queryKey: ["assistants"],
    queryFn: () => AssistantApi.list(),
  });
  const { data: skills = [] } = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
  });
  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcpServers"],
    queryFn: () => McpServerApi.list(),
  });
  const { data: allTasks = [] } = useQuery({
    queryKey: ["automation", "tasks"],
    queryFn: () => AutomationApi.list(),
  });
  /** 本项目任务（projectId 前端过滤） */
  const projectTasks = useMemo(
    () => allTasks.filter((task) => task.projectId === detail.project.id),
    [allTasks, detail.project.id],
  );
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);

  // Picker 条目映射（同 CreateProjectDialog 三源口径）
  const pickerItemsByKind: Record<ProjectBindingType, PickerItem[]> = {
    assistant: assistants.map((item) => ({ id: item.id, name: item.name })),
    skill: skills.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? undefined,
    })),
    mcpServer: mcpServers.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.url ?? item.command,
    })),
  };

  const bindingsOfKind = (kind: ProjectBindingType): ProjectBindingItem[] =>
    detail.bindings.filter((binding) => binding.itemType === kind);

  // Picker 初始勾选 = 各类型 valid 集（useMemo 稳定引用：PickerDialog 的
  // 打开重置 effect 以 selectedIds 为依赖，避免父级重渲染清掉搜索词）
  const selectedIdsByKind = useMemo(() => {
    const map: Record<ProjectBindingType, number[]> = {
      assistant: [],
      skill: [],
      mcpServer: [],
    };
    for (const binding of detail.bindings) {
      if (binding.valid) {
        map[binding.itemType].push(binding.itemId);
      }
    }
    return map;
  }, [detail.bindings]);

  /** setBindings 为全量覆盖：其他类型原样透传，本类型 = picker 集 + 失效集保留 */
  const handlePickerConfirm = async (
    kind: ProjectBindingType,
    ids: number[],
  ) => {
    const toInput = ({ itemType, itemId }: ProjectBindingItem) => ({
      itemType,
      itemId,
    });
    const items: ProjectBindingInput[] = [
      ...detail.bindings
        .filter((binding) => binding.itemType !== kind)
        .map(toInput),
      ...ids.map((itemId) => ({ itemType: kind, itemId })),
      ...bindingsOfKind(kind)
        .filter((binding) => !binding.valid)
        .map(toInput),
    ];
    await persistBindings(items);
  };

  /** 失效挂载 X 移除：直接 setBindings 去掉该项（其他挂载原样） */
  const handleRemoveInvalid = async (
    kind: ProjectBindingType,
    itemId: number,
  ) => {
    const items = detail.bindings
      .filter(
        (binding) => !(binding.itemType === kind && binding.itemId === itemId),
      )
      .map(({ itemType, itemId }) => ({ itemType, itemId }));
    await persistBindings(items);
  };

  const persistBindings = async (items: ProjectBindingInput[]) => {
    if (savingBindings) {
      return;
    }
    setSavingBindings(true);
    try {
      await ProjectApi.setBindings(detail.project.id, items);
      await queryClient.invalidateQueries({
        queryKey: ["project", detail.project.id],
      });
    } catch {
      toast.error(t("project:toast.operationFailed"));
    } finally {
      setSavingBindings(false);
    }
  };

  const nickname = user.nickname || user.username;
  const isOwner = detail.project.ownerId === user.id;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border/50 px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">
          {t("project:panel.title")}
        </h2>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        {/* 区块1 指令：只读 markdown + 编辑入口 */}
        <section
          aria-label={t("project:panel.instruction")}
          className="space-y-2"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              {t("project:panel.instruction")}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("project:panel.editInstruction")}
              onClick={() => setInstructionOpen(true)}
              className="h-7 gap-1 px-2 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t("project:panel.editInstruction")}
            </Button>
          </div>
          {detail.project.systemPrompt ? (
            <MarkdownView text={detail.project.systemPrompt} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("project:panel.instructionEmpty")}
            </p>
          )}
        </section>

        {/* 区块2 能力挂载：三行 Tag 列表 + Picker 添加 */}
        {CAPABILITY_ROWS.map(({ kind, icon, labelKey }) => (
          <CapabilityRow
            key={kind}
            label={t(labelKey)}
            icon={icon}
            bindings={bindingsOfKind(kind)}
            addingDisabled={savingBindings}
            onAdd={() => setPickerKind(kind)}
            onRemoveInvalid={(itemId) => void handleRemoveInvalid(kind, itemId)}
          />
        ))}

        {/* 区块3 定时任务：本项目任务列表 + 新建/前往自动化 */}
        <section
          aria-label={t("project:panel.automation")}
          className="space-y-2"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("project:panel.automation")}
            </h3>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTaskDialogOpen(true)}
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("project:panel.automationNew")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => navigate(AUTOMATION_ROUTE)}
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              >
                {t("project:panel.goAutomation")}
              </Button>
            </div>
          </div>
          {projectTasks.length === 0 ? (
            <p className="rounded-lg border border-border/50 p-3 text-xs text-muted-foreground">
              {t("project:panel.automationEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {projectTasks.map((task) => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  onOpen={() =>
                    navigate(`/module/ai/automation/task/${task.id}`)
                  }
                />
              ))}
            </ul>
          )}
        </section>

        {/* 区块4 成员：单成员（当前用户）+ owner/me 标记 */}
        <section aria-label={t("project:panel.members")} className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            {t("project:panel.members")}
          </h3>
          <div className="flex items-center gap-2.5 rounded-lg border border-border/50 p-3">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-sm font-medium text-primary"
            >
              {nickname.charAt(0).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {nickname}
              </span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {t("project:panel.me")}
              </Badge>
              {isOwner && (
                <Badge className="px-1.5 py-0 text-[10px] font-normal">
                  {t("project:panel.owner")}
                </Badge>
              )}
            </span>
          </div>
        </section>
      </div>

      {/* 指令编辑弹窗 + 能力选择器（同一时刻至多一个） */}
      <InstructionEditDialog
        project={detail.project}
        open={instructionOpen}
        onOpenChange={setInstructionOpen}
      />
      {/* 新建任务弹窗（项目预设：资产空间锁定 + projectId 注入保存载荷） */}
      <CreateTaskDialog
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        project={{
          id: detail.project.id,
          workspaceId: detail.assetWorkspaceId,
          workspaceName: t("project:panel.projectWorkspace"),
        }}
      />
      {pickerKind && (
        <PickerDialog
          open
          onOpenChange={(next) => {
            if (!next) setPickerKind(null);
          }}
          title={t(
            CAPABILITY_ROWS.find((row) => row.kind === pickerKind)?.labelKey ??
              "",
          )}
          items={pickerItemsByKind[pickerKind]}
          selectedIds={selectedIdsByKind[pickerKind]}
          onConfirm={(ids) => void handlePickerConfirm(pickerKind, ids)}
        />
      )}
    </div>
  );
}

/** 相对时间（locale 跟随界面语言，TasksPane 同款惯例） */
const formatRelative = (iso: string) =>
  formatDistanceToNow(new Date(iso), {
    addSuffix: true,
    locale: getDateFnsLocale(),
  });

/** 状态显示：error/expired 走徽标，运行中/暂停为纯文本（TaskRow 同口径） */
function TaskStatus({
  status,
  enabled,
}: {
  status: AutomationStatus;
  enabled: boolean;
}) {
  const { t } = useTranslation(["chat"]);
  if (status === "error") {
    return (
      <Badge variant="destructive">{t("chat:automation.status.error")}</Badge>
    );
  }
  if (status === "expired") {
    return (
      <Badge variant="secondary">{t("chat:automation.status.expired")}</Badge>
    );
  }
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {enabled
        ? t("chat:automation.status.running")
        : t("chat:automation.status.paused")}
    </span>
  );
}

interface TaskListItemProps {
  task: TaskRecord;
  onOpen: () => void;
}

/** 单行项目任务：名称（点击进详情）+ 频率 + 上次运行 + 状态 + 启停/立即运行 */
function TaskListItem({ task, onOpen }: TaskListItemProps) {
  const { t } = useTranslation(["project", "chat"]);
  const queryClient = useQueryClient();

  async function handleToggle(next: boolean) {
    try {
      await AutomationApi.toggle(task.id, next);
      await queryClient.invalidateQueries({
        queryKey: ["automation", "tasks"],
      });
      toast.success(
        t(
          next
            ? "chat:automation.toast.enabled"
            : "chat:automation.toast.disabled",
        ),
      );
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  }

  async function handleRun() {
    try {
      await AutomationApi.runNow(task.id);
      await queryClient.invalidateQueries({
        queryKey: ["automation", "tasks"],
      });
      toast.success(t("chat:automation.detail.playing"));
    } catch (e) {
      // runNow 互斥拒发（TASK_ALREADY_RUNNING）单独文案，其余 mapIpcError 透传
      const message = mapIpcError(e);
      toast.error(
        message.includes("TASK_ALREADY_RUNNING")
          ? t("project:panel.taskRunning")
          : message,
      );
    }
  }

  return (
    <li className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm font-medium text-foreground">
          {task.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {task.scheduleText}
        </span>
        {task.lastRunAt && (
          <span className="block truncate text-xs text-muted-foreground">
            {t("chat:automation.list.lastRun", {
              time: formatRelative(task.lastRunAt),
            })}
          </span>
        )}
      </button>
      <TaskStatus status={task.status} enabled={task.enabled} />
      <Switch
        checked={task.enabled}
        onCheckedChange={(next) => void handleToggle(next)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("chat:automation.detail.play")}
        onClick={() => void handleRun()}
        className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
      >
        <Play className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}
