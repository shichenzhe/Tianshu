/**
 * 计划表格视图（纯展示 + 行内交互回调，spec §6 计划 Tab）：
 * 表头行上方快速新增行（Input 回车 → onQuickCreate，空标题忽略、触发后清空）+
 * shadcn 表格——标题（点击 onOpenItem）| 状态行内 Select 四态（→ onMoveItem，
 * 走 move 通道由父层重算目标列内序）| 处理人（单成员恒「我」）| 优先级行内
 * Select + 色徽标（P0 destructive / P1 primary / P2 muted → onSetPriority）|
 * 标签 Badge 组 | fields 动态列（值缺失 --）| 表头自定义字段列尾 +
 * （onOpenFieldEditor）| 行尾 ... 菜单（编辑 onOpenItem / 删除 onDeleteItem，
 * 二次确认与 API 调用在 PlanPane 统一处理）。
 * 过滤/排序由父层（PlanPane）计算后传入；本组件只触发回调不持有数据。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PRIORITY_BADGE_VARIANTS,
  PRIORITY_LABEL_KEYS,
  PRIORITY_OPTIONS,
  STATUS_LABEL_KEYS,
  STATUS_OPTIONS,
} from "./PlanItemDialog";
import type {
  PlanFieldDef,
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

interface PlanTableViewProps {
  /** 过滤排序后的事项（PlanPane 计算传入） */
  items: PlanItemRecord[];
  /** 项目自定义字段定义（动态列） */
  fields: PlanFieldDef[];
  /** 点击标题/行尾编辑 → 父层打开编辑弹窗 */
  onOpenItem: (item: PlanItemRecord) => void;
  /** 行内状态切换 → 父层 move 通道（含乐观更新） */
  onMoveItem: (id: number, status: PlanStatus) => void;
  /** 行内优先级切换 → 父层 update 通道 */
  onSetPriority: (id: number, priority: PlanPriority) => void;
  /** 快速新增（回车） */
  onQuickCreate: (title: string) => void;
  /** 表头字段列尾 + → 父层打开字段定义管理 */
  onOpenFieldEditor: () => void;
  /** 行尾删除 → 父层二次确认后 remove */
  onDeleteItem: (item: PlanItemRecord) => void;
}

/** 自定义字段单元格缺值占位 */
const MISSING_VALUE = "--";

export default function PlanTableView({
  items,
  fields,
  onOpenItem,
  onMoveItem,
  onSetPriority,
  onQuickCreate,
  onOpenFieldEditor,
  onDeleteItem,
}: PlanTableViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const [quickAdd, setQuickAdd] = useState("");

  /** 回车快速新增：trim 后空标题忽略；父层 create 后清空输入 */
  const handleQuickAddKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    // IME 组合中的 Enter 仅确认候选：不触发快速新增
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const title = quickAdd.trim();
    if (!title) {
      return;
    }
    onQuickCreate(title);
    setQuickAdd("");
  };

  return (
    <div className="flex flex-col">
      {/* 快速新增行：与弹窗新增共用 create 链（缺省状态/优先级） */}
      <Input
        value={quickAdd}
        onChange={(event) => setQuickAdd(event.target.value)}
        onKeyDown={handleQuickAddKeyDown}
        placeholder={t("project:plan.quickAddPlaceholder")}
        aria-label={t("project:plan.quickAddPlaceholder")}
        className="mb-2 h-8 text-sm"
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("project:plan.title")}</TableHead>
            <TableHead className="w-28">{t("project:plan.status")}</TableHead>
            <TableHead className="w-16">
              {t("project:plan.handleMan")}
            </TableHead>
            <TableHead className="w-32">{t("project:plan.priority")}</TableHead>
            <TableHead className="w-32">{t("project:plan.tags")}</TableHead>
            {fields.map((field) => (
              <TableHead key={field.name}>{field.name}</TableHead>
            ))}
            {/* 自定义字段列尾 + ：字段定义管理入口 */}
            <TableHead className="w-10">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("project:plan.manageFields")}
                onClick={onOpenFieldEditor}
                className="h-6 w-6 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TableHead>
            <TableHead className="w-12" aria-label={t("common:operation")} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="max-w-0">
                <button
                  type="button"
                  onClick={() => onOpenItem(item)}
                  title={item.title}
                  className="block max-w-full truncate text-left transition-colors hover:text-primary"
                >
                  {item.title}
                </button>
              </TableCell>
              <TableCell>
                <Select
                  value={item.status}
                  onValueChange={(value) =>
                    onMoveItem(item.id, value as PlanStatus)
                  }
                >
                  <SelectTrigger
                    aria-label={t("project:plan.status")}
                    className="h-7 w-24 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(STATUS_LABEL_KEYS[option])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              {/* 单成员预留：处理人恒当前用户 */}
              <TableCell className="text-xs text-muted-foreground">
                {t("project:plan.me")}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <Select
                    value={item.priority}
                    onValueChange={(value) =>
                      onSetPriority(item.id, value as PlanPriority)
                    }
                  >
                    <SelectTrigger
                      aria-label={t("project:plan.priority")}
                      className="h-7 w-16 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRIORITY_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {t(PRIORITY_LABEL_KEYS[option])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* 色徽标：P0 destructive / P1 primary / P2 muted */}
                  <Badge
                    variant={PRIORITY_BADGE_VARIANTS[item.priority]}
                    className="px-1.5 text-[10px]"
                  >
                    {t(PRIORITY_LABEL_KEYS[item.priority])}
                  </Badge>
                </div>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  {item.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </span>
              </TableCell>
              {fields.map((field) => {
                const value = item.customFields[field.name];
                return (
                  <TableCell
                    key={field.name}
                    className="text-xs text-muted-foreground"
                  >
                    {value === undefined ||
                    value === null ||
                    String(value).trim() === ""
                      ? MISSING_VALUE
                      : String(value)}
                  </TableCell>
                );
              })}
              {/* 与表头 + 列对齐的占位单元格 */}
              <TableCell />
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("common:operation")}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="rounded-lg border border-border/50 shadow-lg"
                  >
                    <DropdownMenuItem onClick={() => onOpenItem(item)}>
                      {t("project:plan.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onDeleteItem(item)}
                      className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    >
                      {t("project:plan.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
