/**
 * 顶栏 AI 动作区：主机切换器 / 侧边栏折叠 / 全局搜索 / 时间筛选（均带
 * 冒泡提示）。侧边栏收起时任务列表不可见，搜索与时间筛选无作用对象，
 * 随收起隐藏（折叠开关保留——展开侧栏唯一入口）。
 * 主机切换器挪位批（macOS）：展开态落侧栏 Logo 行右侧（GlobalSidebar），
 * 顶栏不渲染避免双入口；侧栏收起时 Logo 行随侧栏裁掉，切换器回顶栏
 * 折叠键旁——「全局数据源切换与侧栏无关、收起后仍可达」不变量保住。
 * Linux 的 logo 在 TopBar 内（非侧栏），切换器维持此处的 logo 右侧原位；
 * Windows 不渲染本组件（自绘标题栏另有实例）。
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
import HostSwitcher from "./HostSwitcher";

export default function AiTopbarActions() {
  const { t } = useTranslation(["layout"]);
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAiUiStore((s) => s.toggleSidebar);
  const setSearchOpen = useAiUiStore((s) => s.setSearchOpen);
  const isMac = window.platform === "darwin";

  return (
    <TooltipProvider>
      {(!isMac || collapsed) && <HostSwitcher />}
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
