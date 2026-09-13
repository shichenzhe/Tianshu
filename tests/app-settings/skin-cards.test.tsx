// @vitest-environment jsdom
/**
 * 皮肤卡片渲染测试（外观模块 Task 4）：
 * - ThemePreviewCard：根元素 data-mode/data-theme/data-wallpaper 三元组属性
 *   （局部作用域换肤绑定——skins.css 属性选择器作用于卡片子树、CSS 变量继承；
 *   jsdom 不计算 CSS，颜色跟随以属性断言兜底，真实渲染走手动验收）
 * - 类型胶囊 basicType/premiumType 文案分流；主界面模拟元素（侧栏条/壁纸图案/
 *   user/assistant 气泡/输入条）存在
 * - SkinCard：名称 zh/en 按 i18n.language 分流；选中类名 + aria-pressed；
 *   onSelect 回调带皮肤 id；premium 角标 vs basic 无角标；sr-only 选中文案
 * - SKINS 十款全量渲染冒烟
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// i18n.language 可变 mock：useTranslation 惰性读取（调用时取值），module body
// 赋值发生在 factory 执行之后，无 TDZ 风险（同款手法见 personalization-group）
let mockLanguage = "zh-CN";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: mockLanguage },
  }),
}));
// @/i18n（经 @/lib/utils 的 cn 引入）以最小 stub 替代真实初始化（同款处理见
// tests/app-settings/personalization-group.test.tsx）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import SkinCard from "@/domains/app-settings/components/SkinCard";
import ThemePreviewCard from "@/domains/app-settings/components/ThemePreviewCard";
import {
  getSkin,
  SKINS,
  type SkinDef,
} from "@/domains/app-settings/model/skins";

/** 按 id 取皮肤；元数据缺失即测试环境错误，直接抛错 */
function skinOf(id: string): SkinDef {
  const skin = getSkin(id);
  if (!skin) {
    throw new Error(`unknown skin id in fixture: ${id}`);
  }
  return skin;
}

afterEach(() => {
  cleanup();
  mockLanguage = "zh-CN";
});

describe("ThemePreviewCard 局部换肤绑定", () => {
  it.each([
    { id: "dark", mode: "dark", hue: "blue", wallpaper: null },
    { id: "ink", mode: "dark", hue: "blue", wallpaper: "ink" },
    { id: "field", mode: "light", hue: "green", wallpaper: "field" },
  ])(
    "$id：根元素三元组属性与皮肤一致（wallpaper=null 时属性省略）",
    ({ id, mode, hue, wallpaper }) => {
      render(<ThemePreviewCard skin={skinOf(id)} />);
      const root = screen.getByRole("img");
      expect(root.getAttribute("data-mode")).toBe(mode);
      expect(root.getAttribute("data-theme")).toBe(hue);
      expect(root.getAttribute("data-wallpaper")).toBe(wallpaper);
    },
  );

  it("基础皮肤省略 data-wallpaper 属性（无空串残留）", () => {
    render(<ThemePreviewCard skin={skinOf("light")} />);
    expect(screen.getByRole("img").hasAttribute("data-wallpaper")).toBe(false);
  });

  it("aria-label 为预览文案 + 皮肤名（名称随 locale 分流）", () => {
    render(<ThemePreviewCard skin={skinOf("ink")} />);
    expect(
      screen.getByRole("img", { name: "settings:appearance.preview 墨韵" }),
    ).toBeTruthy();
    cleanup();
    mockLanguage = "en-US";
    render(<ThemePreviewCard skin={skinOf("ink")} />);
    expect(
      screen.getByRole("img", { name: "settings:appearance.preview Ink" }),
    ).toBeTruthy();
  });

  it("类型胶囊：basic → basicType，premium → premiumType", () => {
    render(<ThemePreviewCard skin={skinOf("light")} />);
    expect(screen.getByText("settings:appearance.basicType")).toBeTruthy();
    expect(screen.queryByText("settings:appearance.premiumType")).toBeNull();
    cleanup();
    render(<ThemePreviewCard skin={skinOf("dusk")} />);
    expect(screen.getByText("settings:appearance.premiumType")).toBeTruthy();
  });

  it("主界面模拟元素齐备：侧栏条/壁纸图案（skin 变量）/双气泡/输入条", () => {
    render(<ThemePreviewCard skin={skinOf("ripple")} />);
    expect(screen.getByTestId("preview-sidebar")).toBeTruthy();
    // 壁纸图案区 inline style 消费 skins.css 的 --skin-sidebar-image 装饰变量
    const wallpaper = screen.getByTestId("preview-sidebar-wallpaper");
    expect(wallpaper.style.backgroundImage).toContain("--skin-sidebar-image");
    expect(screen.getByTestId("preview-bubble-user")).toBeTruthy();
    expect(screen.getByTestId("preview-bubble-assistant")).toBeTruthy();
    expect(screen.getByTestId("preview-input-bar")).toBeTruthy();
  });
});

describe("SkinCard", () => {
  const onSelect = vi.fn();

  afterEach(() => onSelect.mockClear());

  it("名称按 locale 分流：zh → name，en → nameEn", () => {
    render(
      <SkinCard skin={skinOf("dark")} selected={false} onSelect={onSelect} />,
    );
    expect(screen.getByText("深色")).toBeTruthy();
    cleanup();
    mockLanguage = "en-US";
    render(
      <SkinCard skin={skinOf("dark")} selected={false} onSelect={onSelect} />,
    );
    expect(screen.getByText("Dark")).toBeTruthy();
  });

  it("选中态：border-primary + ring 高亮类名、aria-pressed、sr-only 选中文案", () => {
    render(
      <SkinCard skin={skinOf("light")} selected={true} onSelect={onSelect} />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("border-primary");
    expect(button.className).toContain("ring-primary/30");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("settings:appearance.selected")).toBeTruthy();
  });

  it("未选中态：border-border/50 + hover 抬升类、无 ring、无选中文案", () => {
    render(
      <SkinCard skin={skinOf("light")} selected={false} onSelect={onSelect} />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("border-border/50");
    expect(button.className).toContain("hover:shadow-md");
    expect(button.className).not.toContain("ring-2");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("settings:appearance.selected")).toBeNull();
  });

  it("点击回调 onSelect 携带皮肤 id", () => {
    render(
      <SkinCard skin={skinOf("ink")} selected={false} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("ink");
  });

  it("premium 有精选角标、basic 无角标", () => {
    render(
      <SkinCard
        skin={skinOf("dawn-mist")}
        selected={false}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("settings:appearance.premiumType")).toBeTruthy();
    cleanup();
    render(
      <SkinCard skin={skinOf("dark")} selected={false} onSelect={onSelect} />,
    );
    expect(screen.queryByText("settings:appearance.premiumType")).toBeNull();
  });

  it("缩略块同法局部三元组绑定：wallpaper 皮肤带属性、基础皮肤省略", () => {
    const { container } = render(
      <SkinCard skin={skinOf("pine")} selected={false} onSelect={onSelect} />,
    );
    const thumbnail = container.querySelector("[data-mode]");
    expect(thumbnail?.getAttribute("data-mode")).toBe("dark");
    expect(thumbnail?.getAttribute("data-theme")).toBe("green");
    expect(thumbnail?.getAttribute("data-wallpaper")).toBe("pine");
    cleanup();
    const basic = render(
      <SkinCard skin={skinOf("light")} selected={false} onSelect={onSelect} />,
    );
    expect(
      basic.container
        .querySelector("[data-mode]")
        ?.hasAttribute("data-wallpaper"),
    ).toBe(false);
  });
});

describe("SKINS 全量渲染冒烟", () => {
  it("十款 SkinCard 全量渲染无错，按钮与名称齐备", () => {
    render(
      <div>
        {SKINS.map((skin) => (
          <SkinCard
            key={skin.id}
            skin={skin}
            selected={skin.id === "light"}
            onSelect={vi.fn()}
          />
        ))}
      </div>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(10);
    for (const skin of SKINS) {
      expect(screen.getByText(skin.name)).toBeTruthy();
    }
  });
});
