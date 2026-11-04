/**
 * 属性胶囊行（子系统 D spec §2.3）：状态/处理人/优先级/标签/时间规划五胶囊，
 * 各点开 Popover 收纳原控件；胶囊显示当前值摘要（无值显示字段名 muted）。
 * 摘要规则：状态/优先级 = t(labelKey)；处理人 = 昵称/未指派；标签 = 首标签(+n)；
 * 时间 = 双端 `a ~ b`、单端 `→ b`/`a →`、无值空（formatShort = `Number(m+1).Number(d)`）。
 * 本地任务（projectIdIsNull）：处理人渲染单个只读『我』触发按钮（非 Capsule、
 * 不可开），时间规划胶囊不渲染（本地任务无日期语义）。
 * 纯受控：一切修改经 onChange(patch) 上抛。
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CalendarRange } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import RemovableTag from "./RemovableTag";
import { PRIORITY_LABEL_KEYS, STATUS_LABEL_KEYS } from "./PlanItemDialog";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
} from "../../../../electron/domains/project/plan-item.entity";
import type {
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

/** 胶囊可上抛的字段集合（startDate/dueDate 为 yyyy-MM-dd 本地串） */
export interface CapsulePatch {
  status: PlanStatus;
  priority: PlanPriority;
  tags: string[];
  assigneeId: number | null;
  startDate: string;
  dueDate: string;
}

type CapsuleChange = (patch: Partial<CapsulePatch>) => void;

interface PlanItemCapsuleRowProps {
  status: PlanStatus;
  priority: PlanPriority;
  tags: string[];
  assigneeId: number | null;
  startDate: string;
  dueDate: string;
  members: ProjectMemberItem[];
  /** 候选标签（弹窗侧 planItems 缓存聚合；已选中项由本组件排除） */
  candidateTags: string[];
  /** 本地任务（projectId null）：处理人只读『我』、不渲染时间规划胶囊 */
  projectIdIsNull: boolean;
  onChange: CapsuleChange;
}

/** 单胶囊外壳：触发按钮（摘要，无值显示字段名 muted）+ Popover 内容插槽（可收起） */
function Capsule({
  label,
  summary,
  filled,
  icon,
  children,
}: {
  label: string;
  summary: string;
  filled: boolean;
  icon?: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          className="h-7 gap-1 px-2 text-xs font-normal hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          {icon}
          <span
            className={cn(filled ? "text-foreground" : "text-muted-foreground")}
          >
            {summary || label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="w-64 rounded-lg border border-border/50 p-3 shadow-lg"
      >
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

/** 选项行按钮：选中态主题高亮（胶囊在 onSelect 后收起） */
function OptionButton({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onSelect}
      className={cn(
        "h-7 w-full justify-start px-2 text-xs font-normal",
        selected &&
          "bg-primary-subtle text-primary hover:bg-primary-subtle hover:text-primary",
      )}
    >
      {label}
    </Button>
  );
}

/** 状态胶囊：四态按钮列（选中即上抛并收起） */
function StatusCapsule({
  status,
  onChange,
}: {
  status: PlanStatus;
  onChange: CapsuleChange;
}) {
  const { t } = useTranslation(["project"]);
  return (
    <Capsule
      label={t("project:plan.status")}
      summary={t(STATUS_LABEL_KEYS[status])}
      filled
    >
      {(close) => (
        <div className="flex flex-col gap-0.5">
          {PLAN_STATUSES.map((option) => (
            <OptionButton
              key={option}
              label={t(STATUS_LABEL_KEYS[option])}
              selected={option === status}
              onSelect={() => {
                onChange({ status: option });
                close();
              }}
            />
          ))}
        </div>
      )}
    </Capsule>
  );
}

/** 优先级胶囊：P0-P3 按钮列 */
function PriorityCapsule({
  priority,
  onChange,
}: {
  priority: PlanPriority;
  onChange: CapsuleChange;
}) {
  const { t } = useTranslation(["project"]);
  return (
    <Capsule
      label={t("project:plan.priority")}
      summary={t(PRIORITY_LABEL_KEYS[priority])}
      filled
    >
      {(close) => (
        <div className="flex flex-col gap-0.5">
          {PLAN_PRIORITIES.map((option) => (
            <OptionButton
              key={option}
              label={t(PRIORITY_LABEL_KEYS[option])}
              selected={option === priority}
              onSelect={() => {
                onChange({ priority: option });
                close();
              }}
            />
          ))}
        </div>
      )}
    </Capsule>
  );
}

/** 处理人选项列：「未指派」+ 成员按钮 */
function AssigneeOptions({
  assigneeId,
  members,
  onChange,
  close,
}: {
  assigneeId: number | null;
  members: ProjectMemberItem[];
  onChange: CapsuleChange;
  close: () => void;
}) {
  const { t } = useTranslation(["project"]);
  return (
    <div className="flex flex-col gap-0.5">
      <OptionButton
        label={t("project:plan.unassigned")}
        selected={assigneeId === null}
        onSelect={() => {
          onChange({ assigneeId: null });
          close();
        }}
      />
      {members.map((member) => (
        <OptionButton
          key={member.userId}
          label={member.nickname}
          selected={member.userId === assigneeId}
          onSelect={() => {
            onChange({ assigneeId: member.userId });
            close();
          }}
        />
      ))}
    </div>
  );
}

/** 处理人胶囊：摘要 昵称/未指派（成员未到达时显示字段名） */
function AssigneeCapsule({
  assigneeId,
  members,
  onChange,
}: {
  assigneeId: number | null;
  members: ProjectMemberItem[];
  onChange: CapsuleChange;
}) {
  const { t } = useTranslation(["project"]);
  const current = members.find((member) => member.userId === assigneeId);
  const summary =
    assigneeId === null
      ? t("project:plan.unassigned")
      : (current?.nickname ?? "");
  return (
    <Capsule
      label={t("project:plan.handleMan")}
      summary={summary}
      filled={Boolean(current)}
    >
      {(close) => (
        <AssigneeOptions
          assigneeId={assigneeId}
          members={members}
          onChange={onChange}
          close={close}
        />
      )}
    </Capsule>
  );
}

/** 本地任务处理人：恒当前用户只读『我』（非 Capsule，点击无 Popover） */
function ReadonlyAssigneeTrigger({ label }: { label: string }) {
  const { t } = useTranslation(["project"]);
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      className="h-7 cursor-default gap-1 px-2 text-xs font-normal text-muted-foreground hover:bg-transparent"
    >
      {t("project:plan.me")}
    </Button>
  );
}

/** 标签摘要：首标签(+n)；无标签空串 */
const tagSummary = (tags: string[]): string =>
  tags.length === 0
    ? ""
    : tags.length === 1
      ? tags[0]
      : `${tags[0]}(+${tags.length - 1})`;

/** 标签输入态 + 回车添加（IME 组合中的回车仅确认候选）；trim/去重/清空 */
function useTagEntry(tags: string[], onChange: CapsuleChange) {
  const [tagInput, setTagInput] = useState("");
  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) {
      return;
    }
    onChange({ tags: [...tags, tag] });
    setTagInput("");
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    addTag(tagInput);
  };
  return { tagInput, setTagInput, addTag, handleKeyDown };
}

/** 标签编辑体：回车添加输入框 + RemovableTag 列 + 候选 chips（自弹窗原实现搬移） */
function TagsPopoverBody({
  tagInput,
  onTagInputChange,
  onTagKeyDown,
  tags,
  selectableTags,
  onAddTag,
  onRemoveTag,
}: {
  tagInput: string;
  onTagInputChange: (value: string) => void;
  onTagKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  tags: string[];
  selectableTags: string[];
  onAddTag: (raw: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const { t } = useTranslation(["project"]);
  return (
    <div className="space-y-2">
      <Input
        value={tagInput}
        onChange={(event) => onTagInputChange(event.target.value)}
        onKeyDown={onTagKeyDown}
        aria-label={t("project:plan.tags")}
        placeholder={t("project:plan.tagPlaceholder")}
        className="h-8 text-xs"
      />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <RemovableTag
              key={tag}
              name={tag}
              onRemove={() => onRemoveTag(tag)}
            />
          ))}
        </div>
      )}
      {selectableTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectableTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onAddTag(tag)}
              className="rounded-md border border-border/50 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 标签胶囊：摘要 首标签(+n)；Popover 内编辑（连续操作不收起） */
function TagsCapsule({
  tags,
  candidateTags,
  onChange,
}: {
  tags: string[];
  candidateTags: string[];
  onChange: CapsuleChange;
}) {
  const { t } = useTranslation(["project"]);
  const { tagInput, setTagInput, addTag, handleKeyDown } = useTagEntry(
    tags,
    onChange,
  );
  return (
    <Capsule
      label={t("project:plan.tags")}
      summary={tagSummary(tags)}
      filled={tags.length > 0}
    >
      {() => (
        <TagsPopoverBody
          tagInput={tagInput}
          onTagInputChange={setTagInput}
          onTagKeyDown={handleKeyDown}
          tags={tags}
          selectableTags={candidateTags.filter((tag) => !tags.includes(tag))}
          onAddTag={addTag}
          onRemoveTag={(tag) =>
            onChange({ tags: tags.filter((entry) => entry !== tag) })
          }
        />
      )}
    </Capsule>
  );
}

/** 日历日 key → 短格式 `9.14`（Number(m+1).Number(d)，月不加前导零） */
const formatShort = (key: string): string => {
  const [, month, day] = key.split("-").map(Number);
  return `${month}.${day}`;
};

/** 时间摘要：双端 `a ~ b`、仅截止 `→ b`、仅开始 `a →`、无值空串 */
const timeSummary = (startDate: string, dueDate: string): string => {
  if (startDate && dueDate) {
    return `${formatShort(startDate)} ~ ${formatShort(dueDate)}`;
  }
  if (dueDate) {
    return `→ ${formatShort(dueDate)}`;
  }
  if (startDate) {
    return `${formatShort(startDate)} →`;
  }
  return "";
};

/** 时间规划胶囊：开始/截止双 date Input（保持展开便于连续调整） */
function TimeCapsule({
  startDate,
  dueDate,
  onChange,
}: {
  startDate: string;
  dueDate: string;
  onChange: CapsuleChange;
}) {
  const { t } = useTranslation(["project"]);
  return (
    <Capsule
      label={t("project:plan.timeRange")}
      summary={timeSummary(startDate, dueDate)}
      filled={Boolean(startDate || dueDate)}
      icon={<CalendarRange className="h-3 w-3" />}
    >
      {() => (
        <div className="space-y-2">
          <Input
            type="date"
            value={startDate}
            aria-label={t("project:plan.startDate")}
            onChange={(event) => onChange({ startDate: event.target.value })}
            className="h-8 text-xs"
          />
          <Input
            type="date"
            value={dueDate}
            aria-label={t("project:plan.dueDate")}
            onChange={(event) => onChange({ dueDate: event.target.value })}
            className="h-8 text-xs"
          />
        </div>
      )}
    </Capsule>
  );
}

/** 属性胶囊行：状态/处理人/优先级/标签/时间规划（本地任务缺时间胶囊） */
export default function PlanItemCapsuleRow({
  status,
  priority,
  tags,
  assigneeId,
  startDate,
  dueDate,
  members,
  candidateTags,
  projectIdIsNull,
  onChange,
}: PlanItemCapsuleRowProps) {
  const { t } = useTranslation(["project"]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusCapsule status={status} onChange={onChange} />
      {projectIdIsNull ? (
        <ReadonlyAssigneeTrigger label={t("project:plan.handleMan")} />
      ) : (
        <AssigneeCapsule
          assigneeId={assigneeId}
          members={members}
          onChange={onChange}
        />
      )}
      <PriorityCapsule priority={priority} onChange={onChange} />
      <TagsCapsule
        tags={tags}
        candidateTags={candidateTags}
        onChange={onChange}
      />
      {!projectIdIsNull && (
        <TimeCapsule
          startDate={startDate}
          dueDate={dueDate}
          onChange={onChange}
        />
      )}
    </div>
  );
}
