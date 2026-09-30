/**
 * 顶栏 AI 动作区：侧边栏折叠 / 全局搜索 / 时间筛选（均带冒泡提示）。
 * 侧边栏收起时任务列表不可见，搜索与时间筛选无作用对象，随收起隐藏
 * （折叠开关保留——展开侧边栏的唯一入口）。
 */
import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAiUiStore } from "../../store/ai-ui.store";
import FilterPopover from "./FilterPopover";
import GlobalSearchDialog from "./GlobalSearchDialog";

export default function AiTopbarActions() {
  const { t } = useTranslation(["layout"]);
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAiUiStore((s) => s.toggleSidebar);
  const setSearchOpen = useAiUiStore((s) => s.setSearchOpen);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={toggleSidebar}
            aria-label={
              collapsed
                ? t("layout:sidebar.expand")
                : t("layout:sidebar.collapse")
            }
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {collapsed
            ? t("layout:sidebar.expand")
            : t("layout:sidebar.collapse")}
        </TooltipContent>
      </Tooltip>
      {!collapsed && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setSearchOpen(true)}
                aria-label={t("layout:sidebar.search")}
              >
                <Search className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("layout:sidebar.search")}
            </TooltipContent>
          </Tooltip>
          <FilterPopover />
        </>
      )}
      <GlobalSearchDialog />
    </TooltipProvider>
  );
}
