/**
 * 明暗模式 hook（渲染产物需 JS 重渲染的场景——CSS 变量自动切换覆盖不到，
 * 如 mermaid 主题）：读 documentElement data-mode（skin.store.applySkin
 * 写入的最终事实），MutationObserver 监听属性变化（先例 TerminalTab
 * 重读 CSS 变量，同款 data-mode 观察）。
 */
import { useEffect, useState } from "react";

export type ColorMode = "light" | "dark";

function readMode(): ColorMode {
  return document.documentElement.getAttribute("data-mode") === "dark"
    ? "dark"
    : "light";
}

export function useColorMode(): ColorMode {
  const [mode, setMode] = useState<ColorMode>(readMode);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(readMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode"],
    });
    return () => observer.disconnect();
  }, []);

  return mode;
}
