/**
 * 视图设置 Popover（子系统 A spec §UI）：齿轮触发按钮，面板两组单选——
 * 视图类型（表格/看板/列表/甘特/日历，SELECTABLE_TYPES 与 PlanViewTabs 添加菜单
 * 同策略；类型是持久化枚举，切换走 onTypeChange 立即保存、不经 draft）与
 * 分组依据（仅看板 showGroupBy 渲染；状态/优先级/处理人，变更走
 * onGroupByChange 进 draft，随覆盖保存/保存为新视图持久化）。
 * 纯受控组件：只回显 props、上抛回调，无内部状态与持久化。
 */
import { useTranslation } from "react-i18next";
import { ChevronDown, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  PLAN_GROUP_BYS,
  PLAN_VIEW_NAME_KEYS,
} from "../../../../electron/domains/project/plan-view.entity";
import type {
  PlanGroupBy,
  PlanViewType,
} from "../../../../electron/domains/project/plan-view.entity";

/** 类型菜单可选值（C 阶段终态：五类全点亮；同 ADDABLE_TYPES 策略） */
const SELECTABLE_TYPES: PlanViewType[] = [
  "table",
  "kanban",
  "list",
  "gantt",
  "calendar",
];

/** 分组依据选项 label（复用既有 plan.* 字段 key） */
const GROUP_BY_LABEL_KEYS: Record<PlanGroupBy, string> = {
  status: "project:plan.status",
  priority: "project:plan.priority",
  assignee: "project:plan.handleMan",
};

interface PlanViewSettingsPopoverProps {
  /** 当前视图类型（持久化值回显） */
  type: PlanViewType;
  /** 当前分组依据（null = 未分组） */
  groupBy: PlanGroupBy | null;
  /** 仅看板视图为 true（分组依据组仅看板渲染） */
  showGroupBy: boolean;
  /** 类型切换立即保存（usePlanViews.changeType 通道） */
  onTypeChange: (type: PlanViewType) => void;
  /** 分组变更进 draft（覆盖保存/保存为新视图时持久化） */
  onGroupByChange: (groupBy: PlanGroupBy) => void;
}

interface RadioOption {
  value: string;
  label: string;
}

/** 单选组行：label + 当前值回显触发按钮 + radio 菜单 */
function RadioGroupRow({
  label,
  value,
  items,
  onValueChange,
}: {
  label: string;
  value: string;
  items: RadioOption[];
  onValueChange: (value: string) => void;
}) {
  const current = items.find((item) => item.value === value);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={label}
            className="h-7 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {current?.label ?? items[0]?.label ?? "—"}
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
            {items.map((item) => (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function PlanViewSettingsPopover({
  type,
  groupBy,
  showGroupBy,
  onTypeChange,
  onGroupByChange,
}: PlanViewSettingsPopoverProps) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("project:planView.settings")}
          className="h-8 w-8 p-0 text-muted-foreground hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t("project:planView.settings")}
        className="w-56 rounded-lg border border-border/50 p-3 shadow-lg"
      >
        <div className="flex flex-col gap-2.5">
          <RadioGroupRow
            label={t("project:planView.settingsType")}
            value={type}
            items={SELECTABLE_TYPES.map((value) => ({
              value,
              label: t(PLAN_VIEW_NAME_KEYS[value]),
            }))}
            onValueChange={(value) => onTypeChange(value as PlanViewType)}
          />
          {showGroupBy && (
            <RadioGroupRow
              label={t("project:planView.settingsGroupBy")}
              /* null = 未设置分组：渲染实际按状态分组，回显对齐显示「状态」 */
              value={groupBy ?? "status"}
              items={PLAN_GROUP_BYS.map((value) => ({
                value,
                label: t(GROUP_BY_LABEL_KEYS[value]),
              }))}
              onValueChange={(value) => onGroupByChange(value as PlanGroupBy)}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
