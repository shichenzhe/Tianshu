// src-react/domains/ai/automation/views/AutomationView.tsx
/**
 * 自动化壳(spec §5):Tab(定时任务/运行记录) + 工具栏(漏斗/搜索/
 * 刷新/批量管理/添加下拉) + 视图切换(list|market)。Tab 行与工具栏
 * 迁入顶栏（TopBar 中段，44px 行高改 pill/紧凑尺寸）；market 视图
 * 由 TemplateMarketView 自行注册顶行。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { PlusCircle, RefreshCw, SquarePen, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePageHeader } from "@/components/layout/page-header.store";
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
  // 资料库「添加到任务」入口（PRD §5.2）：路由 state 携带预填（文件夹
  // 名→任务名、说明→提示词），挂载即开创建弹窗并 replace 清掉 state
  // （防刷新/后退重复触发）
  const location = useLocation();
  const navigate = useNavigate();
  const prefill = (
    location.state as {
      libraryPrefill?: { name: string; prompt: string };
    } | null
  )?.libraryPrefill;
  useEffect(() => {
    if (prefill) {
      setCreateOpen(true);
      navigate(location.pathname, { replace: true });
    }
  }, [prefill, location.pathname, navigate]);

  // Tab + 工具栏迁入顶栏（TopBar 中段）；market 视图顶行由
  // TemplateMarketView 自行注册，此处置空避免叠加
  usePageHeader(
    view === "market"
      ? null
      : {
          title: (
            <div className="inline-flex items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-sm">
              {(["tasks", "runs"] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  className={`flex items-center rounded-md px-3 py-1 transition-colors ${
                    tab === x
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-primary"
                  }`}
                  onClick={() => setTab(x)}
                >
                  {t(`chat:automation.tabs.${x}`)}
                </button>
              ))}
            </div>
          ),
          trailing: (
            <>
              {tab === "tasks" && (
                <>
                  <FilterMenu tasks={tasks} />
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-7 w-40 pl-7 pr-7"
                      placeholder={t(
                        "chat:automation.toolbar.searchPlaceholder",
                      )}
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
                className="h-7 w-7"
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
                  className="h-7 px-2 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={enterBatchMode}
                >
                  {t("chat:automation.toolbar.batchManage")}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="h-7 px-2">
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
            </>
          ),
        },
  );

  if (view === "market") {
    return <TemplateMarketView />;
  }

  return (
    <div className="flex h-full flex-col">
      {tab === "tasks" ? (
        <TaskListView tasks={tasks} isLoading={isLoading} />
      ) : (
        <RunHistoryView />
      )}

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        prefill={prefill}
      />
    </div>
  );
}
