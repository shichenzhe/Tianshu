/**
 * 顶栏 AI 动作区：侧边栏折叠 / 全局搜索 / 时间筛选
 */
import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAiUiStore } from "../../store/ai-ui.store";
import FilterPopover from "./FilterPopover";
import GlobalSearchDialog from "./GlobalSearchDialog";

export default function AiTopbarActions() {
  const { t } = useTranslation(["layout"]);
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAiUiStore((s) => s.toggleSidebar);
  const setSearchOpen = useAiUiStore((s) => s.setSearchOpen);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={toggleSidebar}
        aria-label={
          collapsed ? t("layout:sidebar.expand") : t("layout:sidebar.collapse")
        }
      >
        {collapsed ? (
          <PanelLeftOpen className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => setSearchOpen(true)}
        aria-label={t("layout:sidebar.search")}
      >
        <Search className="h-4 w-4" />
      </Button>
      <FilterPopover />
      <GlobalSearchDialog />
    </>
  );
}
