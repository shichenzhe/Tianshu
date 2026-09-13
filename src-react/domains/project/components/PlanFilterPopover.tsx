/**
 * 组合筛选面板（子系统 A spec §UI）：条件式组合筛选（AND），
 * 字段（标题/状态/处理人/来源/优先级/标签）× 操作符 × 值控件；
 * 顶部 `...` 菜单：保存为新视图（PlanViewNameDialog 命名弹窗）/ 覆盖保存 /
 * 重置；isDirty 圆点。值控件：标题/标签 = Input；状态/优先级/来源 = 枚举
 * 多选 checkbox；处理人 = isMe 无值控件 + in 成员多选（成员候选父层传入）。
 * conditions 受控：一切增删改经 onChange(updater) 上抛，由 PlanPane 写入 draft。
 */
import { forwardRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";
import { ListFilter, MoreHorizontal, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import {
  PLAN_PRIORITIES,
  PLAN_SOURCES,
  PLAN_STATUSES,
} from "../../../../electron/domains/project/plan-item.entity";
import type { PlanItemSource } from "../../../../electron/domains/project/plan-item.entity";
import type { FilterCondition } from "../model/plan-view-engine";
import PlanViewNameDialog from "./PlanViewNameDialog";
import { PRIORITY_LABEL_KEYS, STATUS_LABEL_KEYS } from "./PlanItemDialog";

type ConditionField = FilterCondition["field"];
type ConditionOp = FilterCondition["op"];
type Translate = (key: string) => string;

interface PlanFilterPopoverProps {
  conditions: FilterCondition[];
  isDirty: boolean;
  members: ProjectMemberItem[];
  currentUserId: number;
  onChange: (updater: (prev: FilterCondition[]) => FilterCondition[]) => void;
  onReset: () => void;
  onSaveOverwrite: () => void;
  onSaveAsNew: (name: string) => void;
}

interface ConditionRowProps {
  condition: FilterCondition;
  members: ProjectMemberItem[];
  currentUserId: number;
  onChange: PlanFilterPopoverProps["onChange"];
}

/** 六个可筛选字段（添加菜单顺序） */
const FILTER_FIELDS: ConditionField[] = [
  "title",
  "status",
  "assigneeId",
  "source",
  "priority",
  "tags",
];

const FIELD_LABEL_KEYS: Record<ConditionField, string> = {
  title: "project:planView.fieldTitle",
  status: "project:planView.fieldStatus",
  assigneeId: "project:planView.fieldAssignee",
  source: "project:planView.fieldSource",
  priority: "project:planView.fieldPriority",
  tags: "project:planView.fieldTags",
};

const OP_LABEL_KEYS: Record<ConditionOp, string> = {
  contains: "project:planView.opContains",
  in: "project:planView.opIn",
  notIn: "project:planView.opNotIn",
  isMe: "project:planView.opIsMe",
};

/** 字段可用操作符（title/tags 固定 contains；枚举 in|notIn；处理人 isMe|in） */
const FIELD_OPS: Record<ConditionField, ConditionOp[]> = {
  title: ["contains"],
  tags: ["contains"],
  status: ["in", "notIn"],
  priority: ["in", "notIn"],
  source: ["in", "notIn"],
  assigneeId: ["isMe", "in"],
};

/** 新增条件的缺省操作符 */
const DEFAULT_OPS: Record<ConditionField, ConditionOp> = {
  title: "contains",
  tags: "contains",
  status: "in",
  priority: "in",
  source: "in",
  assigneeId: "isMe",
};

const SOURCE_LABEL_KEYS: Record<PlanItemSource, string> = {
  manual: "project:planView.sourceManual",
  ai: "project:planView.sourceAi",
  template: "project:planView.sourceTemplate",
};

/** 操作符对应的空值（列表操作符空数组，其余空串） */
const emptyValueOf = (op: ConditionOp): string | string[] =>
  op === "in" || op === "notIn" ? [] : "";

/** onChange updater 工厂（纯函数）：新增条件（缺省操作符 + 空值） */
const addConditionUpdater =
  (field: ConditionField) =>
  (prev: FilterCondition[]): FilterCondition[] => [
    ...prev,
    { field, op: DEFAULT_OPS[field], value: emptyValueOf(DEFAULT_OPS[field]) },
  ];

/** 删除指定字段的条件（字段在面板内唯一） */
const removeConditionUpdater =
  (field: ConditionField) =>
  (prev: FilterCondition[]): FilterCondition[] =>
    prev.filter((condition) => condition.field !== field);

/** 局部补丁指定字段条件（操作符切换时重置值） */
const patchConditionUpdater =
  (field: ConditionField, patch: Partial<FilterCondition>) =>
  (prev: FilterCondition[]): FilterCondition[] =>
    prev.map((condition) =>
      condition.field === field ? { ...condition, ...patch } : condition,
    );

/** 多选值切换（checkbox 组勾选/取消；非数组遗留值容错为空） */
const toggleConditionValueUpdater =
  (field: ConditionField, value: string) =>
  (prev: FilterCondition[]): FilterCondition[] =>
    prev.map((condition) => {
      if (condition.field !== field) {
        return condition;
      }
      const list = Array.isArray(condition.value) ? condition.value : [];
      return {
        ...condition,
        value: list.includes(value)
          ? list.filter((v) => v !== value)
          : [...list, value],
      };
    });

/** 值选项（枚举/成员多选共用形状） */
interface ValueOption {
  value: string;
  label: string;
}

const statusValueOptions = (t: Translate): ValueOption[] =>
  PLAN_STATUSES.map((status) => ({
    value: status,
    label: t(STATUS_LABEL_KEYS[status]),
  }));

const priorityValueOptions = (t: Translate): ValueOption[] =>
  PLAN_PRIORITIES.map((priority) => ({
    value: priority,
    label: t(PRIORITY_LABEL_KEYS[priority]),
  }));

const sourceValueOptions = (t: Translate): ValueOption[] =>
  PLAN_SOURCES.map((source) => ({
    value: source,
    label: t(SOURCE_LABEL_KEYS[source]),
  }));

/** 成员选项：当前用户昵称追加「我」标记（值 = userId 字符串化） */
const memberValueOptions = (
  members: ProjectMemberItem[],
  currentUserId: number,
  t: Translate,
): ValueOption[] =>
  members.map((member) => ({
    value: String(member.userId),
    label:
      member.userId === currentUserId
        ? `${member.nickname}（${t("project:plan.me")}）`
        : member.nickname,
  }));

/** 触发按钮：漏斗图标 + 已选条件计数徽标（透传 PopoverTrigger 注入属性） */
const FilterTriggerButton = forwardRef<
  HTMLButtonElement,
  { label: string; count: number } & ComponentPropsWithoutRef<"button">
>(function FilterTriggerButton({ label, count, ...triggerProps }, ref) {
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      aria-label={label}
      {...triggerProps}
      className="h-8 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
    >
      <ListFilter className="h-3.5 w-3.5" />
      {count > 0 && (
        <Badge className="h-4 min-w-4 px-1 text-[10px] leading-none">
          {count}
        </Badge>
      )}
    </Button>
  );
});

/** 面板右上角 `...` 菜单（保存为新视图/覆盖保存/重置）+ isDirty 圆点 */
function PanelActionsMenu({
  isDirty,
  onReset,
  onSaveOverwrite,
  onOpenSaveDialog,
}: {
  isDirty: boolean;
  onReset: () => void;
  onSaveOverwrite: () => void;
  onOpenSaveDialog: () => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <div
      className="flex items-center gap-1"
      data-dirty={isDirty ? "true" : undefined}
    >
      {isDirty && (
        <span
          title={t("project:planView.unsaved")}
          className="h-1.5 w-1.5 rounded-full bg-primary"
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("common:operation")}
            className="h-6 w-6 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          <DropdownMenuItem onSelect={onOpenSaveDialog}>
            {t("project:planView.saveAsNew")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onSaveOverwrite}>
            {t("project:planView.overwriteSave")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onReset}>
            {t("project:planView.reset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 「+ 添加筛选条件」字段菜单（已存在字段禁用） */
function AddConditionMenu({
  usedFields,
  onAdd,
}: {
  usedFields: ConditionField[];
  onAdd: (field: ConditionField) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 gap-1 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("project:planView.addCondition")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-lg border border-border/50 shadow-lg"
      >
        {FILTER_FIELDS.map((field) => (
          <DropdownMenuItem
            key={field}
            disabled={usedFields.includes(field)}
            onSelect={() => onAdd(field)}
          >
            {t(FIELD_LABEL_KEYS[field])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 字段 Select：禁改（换字段 = 删除后重加），仅回显当前字段名 */
function FieldSelect({ condition }: { condition: FilterCondition }) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <Select disabled value={condition.field}>
      <SelectTrigger
        aria-label={t(FIELD_LABEL_KEYS[condition.field])}
        className="h-7 flex-1 border-transparent bg-secondary/40 text-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FILTER_FIELDS.map((field) => (
          <SelectItem key={field} value={field}>
            {t(FIELD_LABEL_KEYS[field])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 操作符 Select：单操作符字段（标题/标签 contains）固定不可改 */
function OpSelect({
  condition,
  onChange,
}: {
  condition: FilterCondition;
  onChange: PlanFilterPopoverProps["onChange"];
}) {
  const { t } = useTranslation(["project", "common"]);
  const ops = FIELD_OPS[condition.field];
  const handleValueChange = (op: string) =>
    onChange(
      patchConditionUpdater(condition.field, {
        op: op as ConditionOp,
        value: emptyValueOf(op as ConditionOp),
      }),
    );
  return (
    <Select
      value={condition.op}
      onValueChange={handleValueChange}
      disabled={ops.length === 1}
    >
      <SelectTrigger
        aria-label={t(OP_LABEL_KEYS[condition.op])}
        className="h-7 w-28 shrink-0 text-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ops.map((op) => (
          <SelectItem key={op} value={op}>
            {t(OP_LABEL_KEYS[op])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 文本值输入（标题/标签 contains；遗留数组值逗号拼接回显） */
function TextValueControl({
  condition,
  label,
  onChange,
}: {
  condition: FilterCondition;
  label: string;
  onChange: PlanFilterPopoverProps["onChange"];
}) {
  const value = Array.isArray(condition.value)
    ? condition.value.join(",")
    : condition.value;
  return (
    <Input
      value={value}
      aria-label={label}
      onChange={(event) =>
        onChange(
          patchConditionUpdater(condition.field, { value: event.target.value }),
        )
      }
      className="h-7 text-xs"
    />
  );
}

/** 多选值 checkbox 组（状态/优先级/来源/成员 in 值控件） */
function CheckboxValueControl({
  condition,
  options,
  onChange,
}: {
  condition: FilterCondition;
  options: ValueOption[];
  onChange: PlanFilterPopoverProps["onChange"];
}) {
  const selected = Array.isArray(condition.value) ? condition.value : [];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground"
        >
          <Checkbox
            checked={selected.includes(option.value)}
            onCheckedChange={() =>
              onChange(
                toggleConditionValueUpdater(condition.field, option.value),
              )
            }
            className="h-3.5 w-3.5"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** 单条件值控件分发：isMe 无控件，处理人 in = 成员多选，其余按字段映射 */
function ConditionValueControl({
  condition,
  members,
  currentUserId,
  onChange,
}: ConditionRowProps) {
  const { t } = useTranslation(["project", "common"]);
  const shared = { condition, onChange };
  switch (condition.field) {
    case "title":
      return <TextValueControl {...shared} label={t(FIELD_LABEL_KEYS.title)} />;
    case "tags":
      return <TextValueControl {...shared} label={t(FIELD_LABEL_KEYS.tags)} />;
    case "status":
      return (
        <CheckboxValueControl {...shared} options={statusValueOptions(t)} />
      );
    case "priority":
      return (
        <CheckboxValueControl {...shared} options={priorityValueOptions(t)} />
      );
    case "source":
      return (
        <CheckboxValueControl {...shared} options={sourceValueOptions(t)} />
      );
    case "assigneeId":
      return condition.op === "isMe" ? null : (
        <CheckboxValueControl
          {...shared}
          options={memberValueOptions(members, currentUserId, t)}
        />
      );
  }
}

/** 条件行：字段 Select（禁改）+ 操作符 Select + 值控件 + 行删除 */
function ConditionRow({
  condition,
  members,
  currentUserId,
  onChange,
}: ConditionRowProps) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/50 p-2">
      <div className="flex items-center gap-1.5">
        <FieldSelect condition={condition} />
        <OpSelect condition={condition} onChange={onChange} />
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("common:delete")}
          onClick={() => onChange(removeConditionUpdater(condition.field))}
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ConditionValueControl
        condition={condition}
        members={members}
        currentUserId={currentUserId}
        onChange={onChange}
      />
    </div>
  );
}

export default function PlanFilterPopover({
  conditions,
  isDirty,
  members,
  currentUserId,
  onChange,
  onReset,
  onSaveOverwrite,
  onSaveAsNew,
}: PlanFilterPopoverProps) {
  const { t } = useTranslation(["project", "common"]);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const handleSaveAsNew = (name: string) => {
    onSaveAsNew(name);
    setNameDialogOpen(false);
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <FilterTriggerButton
            label={t("project:planView.filter")}
            count={conditions.length}
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label={t("project:planView.filter")}
          className="w-80 rounded-lg border border-border/50 p-3 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("project:planView.filter")}
            </span>
            <PanelActionsMenu
              isDirty={isDirty}
              onReset={onReset}
              onSaveOverwrite={onSaveOverwrite}
              onOpenSaveDialog={() => setNameDialogOpen(true)}
            />
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {conditions.map((condition) => (
              <ConditionRow
                key={condition.field}
                condition={condition}
                members={members}
                currentUserId={currentUserId}
                onChange={onChange}
              />
            ))}
          </div>
          <AddConditionMenu
            usedFields={conditions.map((condition) => condition.field)}
            onAdd={(field) => onChange(addConditionUpdater(field))}
          />
        </PopoverContent>
      </Popover>
      <PlanViewNameDialog
        open={nameDialogOpen}
        title={t("project:planView.saveAsNewTitle")}
        initialName=""
        onOpenChange={setNameDialogOpen}
        onConfirm={handleSaveAsNew}
      />
    </>
  );
}
