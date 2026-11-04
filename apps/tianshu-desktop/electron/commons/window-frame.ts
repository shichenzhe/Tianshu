import type { BrowserWindowConstructorOptions } from "electron";

type WindowFrameOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
>;

/** Windows 任何环境都隐藏菜单；其他平台沿用生产隐藏、开发保留 */
export function shouldHideMenuBar(
  platform: NodeJS.Platform,
  nodeEnv?: string,
): boolean {
  return platform === "win32" || nodeEnv !== "development";
}

/** 主窗/文件窗共用窗口框：Windows 原生按钮，其余平台保持既有原生行为 */
export function windowFrameOptions(
  platform: NodeJS.Platform,
  nodeEnv?: string,
): WindowFrameOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 13, y: 16 },
    };
  }
  if (platform === "win32") return { titleBarStyle: "hidden" };
  return {
    titleBarStyle: nodeEnv === "development" ? "default" : "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#000000",
      height: 44,
    },
  };
}
