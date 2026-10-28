// @vitest-environment jsdom
/**
 * ProfileGroup 交互测试：默认渲染、风格切换、开关保存、指令/称呼保存按钮
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// @/i18n（经 ui/* → @/lib/utils 引入）以最小 stub 替代真实初始化：全量
// mock 的 react-i18next 缺 initReactI18next 导出，且真实 LanguageDetector
// 在 jsdom 下读 localStorage 会告警（与 tests/ai/edit-bar.test.tsx 同款）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

const setMock = vi.fn(async () => undefined);
let mockItems: Array<{ name: string; value: string }> = [];

vi.mock("../../src-react/domains/app-settings/api/settings.api", () => ({
  SettingsApi: {
    getAll: vi.fn(async () => mockItems),
    set: (name: string, value: string) => setMock(name, value),
  },
}));

import ProfileGroup from "../../src-react/domains/app-settings/components/ProfileGroup";

function renderGroup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProfileGroup />
    </QueryClientProvider>,
  );
}

describe("ProfileGroup", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it("默认渲染：四分组标题 + 风格显示默认 + 未设置占位", async () => {
    renderGroup();
    expect(
      screen.getByText("settings:personalization.groups.basic"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.groups.instructions"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.groups.identity"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.groups.advanced"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.persona.empty"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:personalization.memory.empty"),
    ).toBeTruthy();
  });

  it("切换风格 → 立即保存 snarky", async () => {
    renderGroup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /settings:personalization.style.options.default.label/,
        }),
      ).toBeTruthy(),
    );
    // Radix 菜单触发器在 pointerDown 展开（click 不开，同 settings-dialog
    // 测试语言下拉），菜单项为 click 选中
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /style.options.default.label/ }),
    );
    fireEvent.click(
      screen.getByText("settings:personalization.style.options.snarky.label"),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.responseStyle",
        "snarky",
      ),
    );
  });

  it("切换开关 → 保存字面布尔字符串", async () => {
    renderGroup();
    const switches = await screen.findAllByRole("switch");
    // 默认：欢迎语 ON（切到 OFF）、文件详情 OFF（切到 ON）
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.welcomeLoading",
        "false",
      ),
    );
    fireEvent.click(switches[1]);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.fileChangeDetails",
        "true",
      ),
    );
  });

  it("自定义指令：输入后保存按钮可用并提交 trim 内容", async () => {
    renderGroup();
    const textarea = await screen.findByLabelText(
      "settings:personalization.customInstructions.label",
    );
    const saveButton = screen.getAllByRole("button", {
      name: "settings:personalization.editor.save",
    })[0];
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(textarea, { target: { value: "  先给结论  " } });
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.customInstructions",
        "先给结论",
      ),
    );
  });
});
