// @vitest-environment jsdom
/**
 * TopBar 右段底部分隔线测试：右侧面板标题（slot.right，如项目配置面板，
 * 面板自身无 header 行）注册时右段背景层画 border-b 细线——与左侧侧栏
 * Logo 行 / 面板内自带头部行（ArtifactsPanel/RunHistoryPanel）的分隔线
 * 呼应；未注册（空态页，或会话产物面板——头部行在面板内部）不画线，
 * 避免与面板自带线形成双线。中段（页面顶行）用户裁定不画线
 * mock 骨架同 tests/layout/main-layout.test.tsx：i18n 直返 key、
 * __APP_VERSION__ / window.platform 构建注入全局、AppLogo stub
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "__APP_VERSION__", {
    value: "0.0.0-test",
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "platform", {
    value: "darwin",
    configurable: true,
    writable: true,
  });
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("@/components/common/AppLogo", () => ({ default: () => null }));

import TopBar from "../../src-react/components/layout/TopBar";
import { usePageHeaderStore } from "../../src-react/components/layout/page-header.store";

/** 右段背景层（TopBar 三段背景的第三段）class 列表 */
const rightClassList = () =>
  document.querySelector("[data-topbar-right-bg]")!.classList;

afterEach(() => {
  cleanup();
  act(() => usePageHeaderStore.getState().setPageHeader(null));
});

describe("TopBar 右段底部分隔线", () => {
  it("未注册 slot.right → 无 border-b（面板自带头部行场景，避免双线）", () => {
    render(<TopBar panelClass="bg-background" />);
    expect(rightClassList().contains("border-b")).toBe(false);
  });

  it("注册 slot.right → 右段背景带 border-b 细线（右侧面板顶部工具栏分隔线）", () => {
    render(<TopBar panelClass="bg-background" />);
    act(() =>
      usePageHeaderStore.getState().setPageHeader({
        right: <span>panel-title</span>,
      }),
    );
    expect(rightClassList().contains("border-b")).toBe(true);
    expect(rightClassList().contains("border-foreground/15")).toBe(true);
  });

  it("slot.right 清空 → 细线随行移除", () => {
    render(<TopBar panelClass="bg-background" />);
    act(() =>
      usePageHeaderStore.getState().setPageHeader({
        right: <span>panel-title</span>,
      }),
    );
    act(() => usePageHeaderStore.getState().setPageHeader(null));
    expect(rightClassList().contains("border-b")).toBe(false);
  });
});
