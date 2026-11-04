import type { ReactNode } from "react";
import WindowsTitleBar from "./windows-titlebar";

/** Windows 在路由外统一提供独立标题栏；其他平台保持原组件树 */
export default function AppShell({ children }: { children: ReactNode }) {
  if (window.platform !== "win32") return children;
  return (
    <div data-app-shell="" className="flex h-screen flex-col">
      <WindowsTitleBar />
      <div data-app-shell-content="" className="min-h-0 flex-1">
        {children}
      </div>
    </div>
  );
}
