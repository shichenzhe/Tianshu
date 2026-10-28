// @vitest-environment jsdom
/**
 * 外观设置页测试（外观模块 Task 5）：真实 skin store 驱动（每例 reset 回
 * light/orange），jsdom 不计算 CSS，颜色跟随以三元组属性断言兜底：
 * - 渲染：页标题 + 预览卡（当前皮肤）+ 「全部皮肤」标题 + 十款 SkinCard
 *   窄 2 列网格（md 3 列 / xl 5 列响应）
 * - 点击 SkinCard → useSkinStore.setSkin 调用 → store.skin 切换 + 选中样式
 *   （aria-pressed/边框类名）转移到新卡 + 预览卡 data-mode 即时换肤
 * - 预览卡随 store 外部变化同步（如顶栏色相选择器同源 store）
 * - SettingsDialog 集成（外观项解禁）见 settings-dialog.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// localStorage stub：与 tests/app-settings/skin-store.test.ts 同款内存
// stub（消除 Node 原生全局的 ExperimentalWarning 噪音；skin.store 在模块
// 加载期即创建 persist store 读写 localStorage）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：与 tests/app-settings/skin-cards.test.tsx 同套——t 直接返回 key；
// 皮肤名为静态双语字段（不走 i18n），按 i18n.language 分流
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh-CN" },
  }),
}));
// @/i18n（经 @/lib/utils 的 cn 引入）以最小 stub 替代真实初始化
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import AppearanceSettings from "@/domains/app-settings/components/AppearanceSettings";
import { SKINS } from "@/domains/app-settings/model/skins";
import { useSkinStore } from "@/stores/skin.store";

/** 按皮肤名取卡片按钮（名称为按钮内容即其可访问名） */
function cardOf(name: string) {
  return screen.getByRole("button", { name: new RegExp(name) });
}

beforeEach(() => {
  useSkinStore.setState({ skin: "light", hue: "orange" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppearanceSettings 渲染", () => {
  it("页标题 + 预览卡 + 全部皮肤标题 + 十款皮肤卡齐备", () => {
    render(<AppearanceSettings />);
    expect(screen.getByText("settings:appearance.title")).toBeTruthy();
    expect(screen.getByText("settings:appearance.allSkins")).toBeTruthy();
    expect(screen.getByRole("img")).toBeTruthy(); // ThemePreviewCard
    expect(screen.getAllByRole("button")).toHaveLength(SKINS.length);
    for (const skin of SKINS) {
      expect(screen.getByText(skin.name)).toBeTruthy();
    }
  });

  it("皮肤网格：窄 2 列（md 3 列 / xl 5 列响应）+ gap-3", () => {
    const { container } = render(<AppearanceSettings />);
    const grid = screen.getByText("深色").closest(".grid");
    expect(grid).toBeTruthy();
    expect(grid?.className).toContain("grid-cols-2");
    expect(grid?.className).toContain("md:grid-cols-3");
    expect(grid?.className).toContain("xl:grid-cols-5");
    expect(grid?.className).toContain("gap-3");
    expect(container.querySelectorAll(".grid > button")).toHaveLength(
      SKINS.length,
    );
  });

  it("预览卡初始渲染当前 store 皮肤（light → data-mode light、无壁纸）", () => {
    render(<AppearanceSettings />);
    const preview = screen.getByRole("img");
    expect(preview.getAttribute("data-mode")).toBe("light");
    expect(preview.hasAttribute("data-wallpaper")).toBe(false);
  });

  it("选中态读 store.skin：light 卡 aria-pressed + 选中类名，其余未选", () => {
    render(<AppearanceSettings />);
    const light = cardOf("浅色");
    expect(light.getAttribute("aria-pressed")).toBe("true");
    expect(light.className).toContain("border-primary");
    expect(light.className).toContain("ring-primary/30");
    const dark = cardOf("深色");
    expect(dark.getAttribute("aria-pressed")).toBe("false");
    expect(dark.className).toContain("border-border/50");
  });
});

describe("AppearanceSettings 即点即切（真实 store）", () => {
  it("点击 dark 卡 → store.setSkin 调用、skin 切换 + 选中样式转移", () => {
    render(<AppearanceSettings />);
    fireEvent.click(cardOf("深色"));
    expect(useSkinStore.getState().skin).toBe("dark");
    expect(useSkinStore.getState().hue).toBe("blue"); // 皮肤完整预设带自带色相
    expect(cardOf("深色").getAttribute("aria-pressed")).toBe("true");
    expect(cardOf("浅色").getAttribute("aria-pressed")).toBe("false");
  });

  it("点击后预览卡即时换肤：data-mode/data-theme 随新皮肤切换", () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole("img").getAttribute("data-mode")).toBe("light");
    fireEvent.click(cardOf("深色"));
    const preview = screen.getByRole("img");
    expect(preview.getAttribute("data-mode")).toBe("dark");
    expect(preview.getAttribute("data-theme")).toBe("blue");
  });

  it("预览卡随 store 外部 setSkin 同步（含壁纸三元组）", () => {
    render(<AppearanceSettings />);
    act(() => useSkinStore.getState().setSkin("pine"));
    const preview = screen.getByRole("img");
    expect(preview.getAttribute("data-mode")).toBe("dark");
    expect(preview.getAttribute("data-theme")).toBe("green");
    expect(preview.getAttribute("data-wallpaper")).toBe("pine");
    // 选中样式同步转移到 pine 卡（选中态读 store.skin 单一数据源）
    expect(cardOf("松林").getAttribute("aria-pressed")).toBe("true");
  });
});
