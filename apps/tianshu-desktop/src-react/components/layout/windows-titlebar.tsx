/** Windows 独立自绘标题栏：透明透出应用背景，空白处拖拽，右侧窗口操作 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Copy, Minus, Square, X } from "lucide-react";
import { toast } from "sonner";
import AiTopbarActions from "@/domains/ai/layout/components/AiTopbarActions";
import { on } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAiUiStore } from "@/domains/ai/store/ai-ui.store";
import WindowApi, { type WindowControlState } from "./windows-titlebar.api";

interface TitlebarButtonProps {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}

function TitlebarButton({
  label,
  onClick,
  danger = false,
  children,
}: TitlebarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-[46px] items-center justify-center bg-transparent text-foreground transition-colors [-webkit-app-region:no-drag]",
        danger
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-primary-subtle hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

export default function WindowsTitleBar() {
  const { t } = useTranslation(["common"]);
  const location = useLocation();
  const sidebarCollapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const hasSidebar = location.pathname.startsWith("/module");
  const [maximized, setMaximized] = useState(false);
  const isWindows = window.platform === "win32";
  const reportError = useCallback(() => {
    toast.error(t("common:windowControlFailed"));
  }, [t]);

  useEffect(() => {
    if (!isWindows) return;
    let active = true;
    WindowApi.getState()
      .then((state) => {
        if (active) setMaximized(state.maximized);
      })
      .catch(reportError);
    const off = on("window:stateChanged", (_event, state) => {
      setMaximized((state as WindowControlState).maximized);
    });
    return () => {
      active = false;
      off();
    };
  }, [isWindows, reportError]);

  const toggleMaximize = useCallback(() => {
    WindowApi.toggleMaximize()
      .then((state) => setMaximized(state.maximized))
      .catch(reportError);
  }, [reportError]);

  if (!isWindows) return null;
  return (
    <header
      data-windows-titlebar=""
      className="relative z-[70] flex h-8 shrink-0 items-center justify-between bg-transparent text-foreground [-webkit-app-region:drag]"
    >
      {hasSidebar && (
        <div
          data-titlebar-sidebar-bg=""
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-200",
            sidebarCollapsed ? "w-0" : "w-64",
          )}
          style={{
            backgroundColor:
              "var(--skin-sidebar-bg, color-mix(in oklab, var(--color-muted) 40%, transparent))",
          }}
        />
      )}
      <div className="relative flex items-center gap-1 pl-2 text-xs select-none [-webkit-app-region:no-drag]">
        {hasSidebar && <AiTopbarActions />}
      </div>
      <div className="relative flex h-full items-center">
        <TitlebarButton
          label={t("common:windowMinimize")}
          onClick={() => WindowApi.minimize().catch(reportError)}
        >
          <Minus size={15} />
        </TitlebarButton>
        <TitlebarButton
          label={t(
            maximized ? "common:windowRestore" : "common:windowMaximize",
          )}
          onClick={toggleMaximize}
        >
          {maximized ? <Copy size={14} /> : <Square size={14} />}
        </TitlebarButton>
        <TitlebarButton
          label={t("common:close")}
          onClick={() => WindowApi.close().catch(reportError)}
          danger
        >
          <X size={16} />
        </TitlebarButton>
      </div>
    </header>
  );
}
