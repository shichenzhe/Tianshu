// src-react/domains/ai/automation/views/AutomationView.tsx
/**
 * 自动化壳(spec §5):Tab(定时任务/运行记录) + 工具栏(漏斗/搜索/
 * 刷新/批量管理/添加下拉) + 视图切换(list|market)。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  PlusCircle,
  RefreshCw,
  SquarePen,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutomationStore } from "../store/automation.store";
import { useAutomationTasks } from "../lib/use-automation-tasks";
import { FilterMenu } from "../components/FilterMenu";
import { CreateTaskDialog } from "../components/CreateTaskDialog";
import TaskListView from "./TaskListView";
import RunHistoryView from "./RunHistoryView";
import TemplateMarketView from "./TemplateMarketView";

export default function AutomationView() {
  const { t } = useTranslation(["chat"]);
  const {
    tab,
    setTab,
    view,
    setView,
    search,
    setSearch,
    batchMode,
    enterBatchMode,
  } = useAutomationStore();
  const {
    data: tasks = [],
    isLoading,
    refetch,
    isFetching,
  } = useAutomationTasks();
  const [createOpen, setCreateOpen] = useState(false);

  if (view === "market") {
    return <TemplateMarketView />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab 行 + 全局操作区 */}
      <div className="flex items-center gap-1 border-b border-border/50 px-4 pt-3">
        {(["tasks", "runs"] as const).map((x) => (
          <Button
            key={x}
            variant="ghost"
            className={`rounded-none border-b-2 ${tab === x ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
            onClick={() => setTab(x)}
          >
            {t(`chat:automation.tabs.${x}`)}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1 pb-2">
          {tab === "tasks" && (
            <>
              <FilterMenu tasks={tasks} />
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 w-44 pl-7 pr-7"
                  placeholder={t("chat:automation.toolbar.searchPlaceholder")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearch("")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("chat:automation.toolbar.refresh")}
            onClick={() => void refetch()}
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
          {tab === "tasks" && !batchMode && (
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={enterBatchMode}
            >
              <SquarePen className="h-4 w-4 mr-1" />
              {t("chat:automation.toolbar.batchManage")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                {t("chat:automation.toolbar.add")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border border-border/50 rounded-lg shadow-lg"
            >
              <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                <PlusCircle className="h-4 w-4 mr-2" />
                {t("chat:automation.toolbar.addCustom")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setView("market")}>
                <SquarePen className="h-4 w-4 mr-2" />
                {t("chat:automation.toolbar.addFromTemplate")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {tab === "tasks" ? (
        <TaskListView tasks={tasks} isLoading={isLoading} />
      ) : (
        <RunHistoryView />
      )}

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
