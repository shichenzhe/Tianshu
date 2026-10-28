import { describe, expect, it } from "vitest";

import {
  buildWidgetSrcDoc,
  parseWidgetResize,
  WIDGET_INITIAL_HEIGHT,
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
} from "./widget-srcdoc";

describe("buildWidgetSrcDoc", () => {
  it("CSP 隔离头与代码本体注入", () => {
    const doc = buildWidgetSrcDoc("<b>hi</b>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<b>hi</b>");
  });

  it("高度 clamp 常量与桌面同值", () => {
    expect(WIDGET_MIN_HEIGHT).toBe(40);
    expect(WIDGET_MAX_HEIGHT).toBe(800);
    expect(WIDGET_INITIAL_HEIGHT).toBe(120);
  });

  it("RN postMessage 桥上报脚本注入", () => {
    expect(buildWidgetSrcDoc("x")).toContain("ReactNativeWebView");
  });
});

describe("parseWidgetResize", () => {
  it("合法帧解析 + clamp", () => {
    expect(
      parseWidgetResize(JSON.stringify({ type: "widget:resize", height: 10 })),
    ).toBe(WIDGET_MIN_HEIGHT);
    expect(
      parseWidgetResize(JSON.stringify({ type: "widget:resize", height: 9000 })),
    ).toBe(WIDGET_MAX_HEIGHT);
    expect(
      parseWidgetResize(JSON.stringify({ type: "widget:resize", height: 250 })),
    ).toBe(250);
  });

  it("非 resize 帧 / 坏 JSON 返回 null", () => {
    expect(parseWidgetResize("not json")).toBeNull();
    expect(parseWidgetResize(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
