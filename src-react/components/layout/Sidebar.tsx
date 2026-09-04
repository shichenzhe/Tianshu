/**
 * 左侧模块导航栏
 * 纯导航功能，支持展开（图标+文字）和折叠（仅图标）两种模式
 */

import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Home,
  Bot,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

interface NavItem {
  icon: React.ReactNode;
  label: string;
  path: string;
}

export default function Sidebar({
  collapsed,
  onCollapsedChange,
}: SidebarProps) {
  const { t } = useTranslation(["layout"]);
  const navigate = useNavigate();
  const location = useLocation();
  const isMac = window.platform === "darwin";

  const navItems: NavItem[] = [
    {
      icon: <Home size={20} />,
      label: t("layout:sidebar.welcome"),
      path: "/module/welcome",
    },
    {
      icon: <Bot size={20} />,
      label: t("layout:sidebar.ai"),
      path: "/module/ai",
    },
    {
      icon: <Settings size={20} />,
      label: t("layout:sidebar.systemConfig"),
      path: "/module/system-config",
    },
  ];

  const isActive = (path: string) => location.pathname === path;

  return (
    <div
      className={`fixed left-0 top-9 bottom-0 z-40 bg-background flex flex-col transition-[width] duration-200 ${
        collapsed ? "w-10" : "w-[140px]"
      }`}
    >
      {/* macOS 顶部 Logo + 标题（Windows 标题在 TopBar） */}
      {isMac && (
        <div
          className={`flex items-center gap-2 h-9 border-b border-border/50 shrink-0 ${
            collapsed ? "justify-center" : "px-3"
          }`}
        >
          <img src="./pc_logo.svg" alt="mirror" className="w-5 h-5 shrink-0" />
          {!collapsed && (
            <span className="text-sm font-semibold text-foreground tracking-tight select-none truncate">
              {"mirror"}
            </span>
          )}
        </div>
      )}

      {/* 导航区 */}
      <nav className="flex flex-col gap-1 px-2 pt-3">
        {navItems.map((item) => {
          const active = isActive(item.path);

          return (
            <TooltipProvider key={item.path}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={`flex items-center h-8 rounded-md cursor-pointer transition-colors duration-200 ${
                      collapsed ? "justify-center" : "gap-2.5 px-3"
                    } ${
                      active
                        ? "bg-primary-subtle text-primary font-medium"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                    onClick={() => navigate(item.path)}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    <span
                      className={`text-sm whitespace-nowrap overflow-hidden transition-[opacity,width] duration-200 ${
                        collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
                      }`}
                    >
                      {item.label}
                    </span>
                  </div>
                </TooltipTrigger>
                {collapsed && (
                  <TooltipContent side="right">
                    <p>{item.label}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </nav>

      {/* 底部折叠/展开按钮 */}
      <div className="mt-auto p-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={`flex items-center h-8 rounded-md cursor-pointer text-muted-foreground hover:bg-accent transition-colors duration-200 ${
                  collapsed ? "justify-center" : "gap-2.5 px-3"
                }`}
                onClick={() => onCollapsedChange(!collapsed)}
              >
                <span className="shrink-0">
                  {collapsed ? (
                    <PanelLeftOpen size={20} />
                  ) : (
                    <PanelLeftClose size={20} />
                  )}
                </span>
                <span
                  className={`text-sm whitespace-nowrap overflow-hidden transition-[opacity,width] duration-200 ${
                    collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
                  }`}
                >
                  {t("layout:sidebar.collapse")}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>
                {collapsed
                  ? t("layout:sidebar.expand")
                  : t("layout:sidebar.collapse")}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
