// @vitest-environment jsdom
/**
 * SettingsDialog 骨架测试（jsdom + testing-library）：
 * - 打开面板：渲染标题与四个分组标题（常规/权限/存储/通知，后者为待填充容器）
 * - 导航占位：个人主页/外观/快捷键 disabled，通用可交互
 * - 常规组-语言：下拉选择调用 i18n.changeLanguage
 * - 常规组-字体：滑条三档与刻度点击即时改 html fontSize 并持久化
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SettingsDialog from "../../src-react/domains/app-settings/components/SettingsDialog";

// localStorage stub：与 tests/ai/chat-view-edit-optimistic.test.tsx 同款内存
// stub（常规组字体档位读写 localStorage）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：与 tests/ai/edit-bar.test.tsx 同套——t 直接返回 key（断言不依赖
// 具体文案）；语言切换经 changeLanguage spy 断言，language 固定 zh-CN
const changeLanguage = vi.hoisted(() => vi.fn());
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN", changeLanguage },
    }),
  };
});

/** 渲染打开态设置面板 */
function renderDialog() {
  render(<SettingsDialog open onOpenChange={vi.fn()} />);
}

// vitest 未开 globals，RTL 自动清理不生效，显式清理
afterEach(cleanup);

beforeEach(() => {
  changeLanguage.mockClear();
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("SettingsDialog 骨架", () => {
  it("打开面板：渲染标题与四分组标题", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("settings:title")).toBeTruthy();
    expect(screen.getByText("settings:groups.general")).toBeTruthy();
    expect(screen.getByText("settings:groups.permission")).toBeTruthy();
    expect(screen.getByText("settings:groups.storage")).toBeTruthy();
    expect(screen.getByText("settings:groups.notification")).toBeTruthy();
  });

  it("导航占位：个人主页/外观/快捷键禁用，通用可交互", () => {
    renderDialog();
    const general = screen.getByRole("button", {
      name: "settings:nav.general",
    }) as HTMLButtonElement;
    expect(general.disabled).toBe(false);
    for (const id of ["profile", "appearance", "shortcuts"]) {
      const item = screen.getByRole("button", {
        name: new RegExp(`settings:nav.${id}`),
      }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(item.title).toBe("settings:nav.comingSoon");
    }
  });

  it("常规组-语言：下拉选择调用 i18n.changeLanguage", () => {
    renderDialog();
    // 当前语言 zh-CN，触发器即以其标签命名；pointerDown 展开菜单
    const trigger = screen.getByRole("button", {
      name: "settings:general.zhCN",
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByText("settings:general.enUS"));
    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith("en-US");
  });

  it("常规组-字体：滑条三档即时生效并持久化", () => {
    renderDialog();
    const slider = screen.getByRole("slider", {
      name: "settings:general.fontSize",
    }) as HTMLInputElement;
    expect(slider.value).toBe("1"); // 缺省 default（下标 1）

    fireEvent.change(slider, { target: { value: "2" } });
    expect(document.documentElement.style.fontSize).toBe("18px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("large");

    fireEvent.change(slider, { target: { value: "0" } });
    expect(document.documentElement.style.fontSize).toBe("14px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("small");
  });

  it("常规组-字体：刻度点击直达对应档位", () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "settings:general.fontLarge" }),
    );
    expect(document.documentElement.style.fontSize).toBe("18px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("large");
  });
});
