/** 主窗/文件窗共享窗口框配置：Windows 原生按钮，其他平台保持既有行为 */
import { describe, expect, it } from "vitest";
import {
  shouldHideMenuBar,
  windowFrameOptions,
} from "../../electron/commons/window-frame";

describe("shouldHideMenuBar", () => {
  it("Windows 开发与生产均隐藏菜单", () => {
    expect(shouldHideMenuBar("win32", "development")).toBe(true);
    expect(shouldHideMenuBar("win32", "production")).toBe(true);
  });

  it("Linux 开发保留菜单，生产隐藏", () => {
    expect(shouldHideMenuBar("linux", "development")).toBe(false);
    expect(shouldHideMenuBar("linux", "production")).toBe(true);
  });
});

describe("windowFrameOptions", () => {
  it.each(["development", "production"])(
    "macOS %s 保留隐藏标题栏与红绿灯位置",
    (nodeEnv) => {
      const options = windowFrameOptions("darwin", nodeEnv);
      expect(options).toEqual({
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 13, y: 16 },
      });
    },
  );

  it.each(["development", "production"])(
    "Windows %s 使用 hidden 且无 overlay",
    (nodeEnv) => {
      expect(windowFrameOptions("win32", nodeEnv)).toEqual({
        titleBarStyle: "hidden",
      });
    },
  );

  it("Linux 开发环境保留 default 标题栏", () => {
    expect(windowFrameOptions("linux", "development").titleBarStyle).toBe(
      "default",
    );
  });

  it("Linux 生产环境保留 hidden 与原生 overlay", () => {
    expect(windowFrameOptions("linux", "production")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#ffffff",
        symbolColor: "#000000",
        height: 44,
      },
    });
  });
});
