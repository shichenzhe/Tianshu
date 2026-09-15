/**
 * 列表视图（子系统 C spec §2，Todo 式紧凑清单）：引擎 groupItems 按状态四组
 * 折叠（组头 = 折叠箭头 + 状态名 + 计数 + 组内 +，空组保留）；行 = 完成
 * checkbox + 标题（点击编辑）+ 标签（2+N）+ 优先级色点 + 截止日（超期
 * destructive）+ 处理人头像点 + 行尾 AI 推进 hover 渐显按钮（子系统 F：
 * onAiAdvance 通道，AssetFileTable hover 先例）+ aiSummary 常驻 Sparkles
 * 徽标（title=末行进展）+ source ai 标题前 AI Badge；组内 + 展开行内
 * Input 回车快速新增（预置该组状态）。纯展示+回调，变更逻辑在 PlanPane；
 * 折叠态本地 useState。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";
import { groupItems } from "../model/plan-view-engine";
import { isoToDateKey, toDateKey } from "../model/plan-date";
import { STATUS_LABEL_KEYS } from "./PlanItemDialog";

/** 优先级行内色点（色板与表格/看板一致） */
const PRIORITY_DOT_CLASSES: Record<PlanPriority, string> = {
  P0: "bg-destructive",
  P1: "bg-primary",
  P2: "bg-muted-foreground/60",
  P3: "bg-border",
};

/** 行内标签展示上限，超出折叠为 "+N" */
const MAX_ROW_TAGS = 2;

/** aiSummary 末行（徽标 tooltip = 最新一条进展；跳过空行） */
function lastSummaryLine(summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : summary.trim();
}

interface PlanListViewProps {
  /** 过滤排序后的可见事项（PlanPane 计算传入） */
  items: PlanItemRecord[];
  /** 项目成员（处理人头像昵称查找） */
  members: ProjectMemberItem[];
  /** 当前用户 id（按契约保留，供后续 isMe 高亮等扩展；同看板先例暂不消费） */
  currentUserId: number;
  /** 完成 checkbox → 父层 move 通道（done ? "done" : "not_started"） */
  onToggleDone: (id: number, done: boolean) => void;
  /** 组内回车快速新增（携带该组状态，父层 create） */
  onQuickCreate: (status: PlanStatus, title: string) => void;
  /** 点击标题 → 父层打开编辑弹窗 */
  onEdit: (item: PlanItemRecord) => void;
  /** 行尾「AI 推进」→ 父层写底栏预填（子系统 F） */
  onAiAdvance: (item: PlanItemRecord) => void;
}

/** 单行：紧凑布局（纯展示） */
function ListRow({
  item,
  members,
  onToggleDone,
  onEdit,
  onAiAdvance,
}: {
  item: PlanItemRecord;
  members: ProjectMemberItem[];
  onToggleDone: (id: number, done: boolean) => void;
  onEdit: (item: PlanItemRecord) => void;
  onAiAdvance: (item: PlanItemRecord) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const done = item.status === "done";
  const dueKey = isoToDateKey(item.dueDate);
  const overdue = dueKey !== "" && dueKey < toDateKey(new Date()) && !done;
  const assignee = members.find((m) => m.userId === item.assigneeId);
  return (
    <div className="group/row flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-subtle/40">
      <Checkbox
        checked={done}
        onCheckedChange={(checked) => onToggleDone(item.id, checked === true)}
        aria-label={t("project:plan.statusDone")}
        className="h-4 w-4"
      />
      {item.source === "ai" && (
        <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
          AI
        </Badge>
      )}
      <button
        type="button"
        onClick={() => onEdit(item)}
        title={item.title}
        className={cn(
          "flex-1 truncate text-left text-sm",
          done && "text-muted-foreground line-through",
        )}
      >
        {item.title}
      </button>
      {item.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
        <Badge key={tag} variant="secondary" className="px-1.5 text-[10px]">
          {tag}
        </Badge>
      ))}
      {item.tags.length > MAX_ROW_TAGS && (
        <Badge
          variant="outline"
          className="px-1.5 text-[10px] text-muted-foreground"
        >
          +{item.tags.length - MAX_ROW_TAGS}
        </Badge>
      )}
      <span
        aria-label={item.priority}
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          PRIORITY_DOT_CLASSES[item.priority],
        )}
      />
      {dueKey && (
        <span
          className={cn(
            "shrink-0 text-xs",
            overdue ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {dueKey}
        </span>
      )}
      {item.aiSummary !== "" && (
        // 进展徽标（常驻非渐显）：title 携带最新一条进展末行
        <span
          title={lastSummaryLine(item.aiSummary)}
          className="shrink-0 text-primary"
        >
          <Sparkles className="h-3 w-3" />
        </span>
      )}
      <span
        title={assignee?.nickname ?? t("project:plan.unassigned")}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[10px] font-medium text-primary"
      >
        {assignee ? assignee.nickname.charAt(0) : "?"}
      </span>
      {/* AI 推进入口：hover 渐显（AssetFileTable 先例） */}
      <button
        type="button"
        aria-label={t("project:plan.aiAdvance")}
        onClick={() => onAiAdvance(item)}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <Sparkles className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function PlanListView({
  items,
  members,
  onToggleDone,
  onQuickCreate,
  onEdit,
  onAiAdvance,
}: PlanListViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [addingIn, setAddingIn] = useState<PlanStatus | null>(null);
  const [addingTitle, setAddingTitle] = useState("");
  const groups = groupItems(items, "status");

  /** 组内回车快速新增（IME 组合中回车不触发） */
  const handleAddKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    status: PlanStatus,
  ) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const title = addingTitle.trim();
    if (title) {
      onQuickCreate(status, title);
    }
    setAddingTitle("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      {groups.map((group) => (
        <section key={group.key} className="mt-2 first:mt-0">
          <div className="flex items-center gap-1.5 border-b border-border/50 py-1.5">
            <button
              type="button"
              aria-label={t(STATUS_LABEL_KEYS[group.key as PlanStatus])}
              onClick={() =>
                setCollapsed((prev) => ({
                  ...prev,
                  [group.key]: !prev[group.key],
                }))
              }
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary"
            >
              {collapsed[group.key] ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {t(STATUS_LABEL_KEYS[group.key as PlanStatus])}
              <Badge variant="secondary" className="px-1.5 text-[10px]">
                {group.items.length}
              </Badge>
            </button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("project:plan.add")}
              onClick={() =>
                setAddingIn(
                  addingIn === group.key ? null : (group.key as PlanStatus),
                )
              }
              className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {!collapsed[group.key] && (
            <div className="flex flex-col">
              {group.items.map((item) => (
                <ListRow
                  key={item.id}
                  item={item}
                  members={members}
                  onToggleDone={onToggleDone}
                  onEdit={onEdit}
                  onAiAdvance={onAiAdvance}
                />
              ))}
              {addingIn === group.key && (
                <Input
                  autoFocus
                  value={addingTitle}
                  onChange={(event) => setAddingTitle(event.target.value)}
                  onKeyDown={(event) =>
                    handleAddKeyDown(event, group.key as PlanStatus)
                  }
                  placeholder={t("project:plan.quickAddPlaceholder")}
                  aria-label={t("project:plan.quickAddPlaceholder")}
                  className="my-1 h-8 text-sm"
                />
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
