// @vitest-environment jsdom
/**
 * PlusMenu 组件交互测试（jsdom + testing-library）：
 * - 点击 ＋ 触发按钮后扩展菜单应打开（回归：b68d536 将 TooltipProvider
 *   插入 DropdownMenuTrigger asChild 与 Button 之间，asChild 的 Slot 只把
 *   事件 props merge 到直接子元素，TooltipProvider 不透传 DOM props，
 *   导致点击无反应；正确嵌套见 context-usage-button.tsx 两 Trigger 直连）
 * - 本地任务开关（T8）：localTask 可选 props——未传不渲染（AI 模块零改动
 *   回归）；传入时项出现（label 由调用方传入，断言不经 i18n）、点击调
 *   onToggle(!enabled)、勾选 Check 随 enabled 显隐
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// i18n mock：t 直接返回 key（菜单项名即 key），断言不依赖具体文案
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

// PlusMenu 仅用 useQueryClient 失效缓存，mock 成空操作
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

// 二级浮层与导入/资料库选择弹窗拖入较重依赖，mock 为空组件，
// 本测试只关心菜单开合
vi.mock(
  "../../src-react/domains/ai/skills/components/SkillImportDialog",
  () => ({ default: () => null }),
);
vi.mock(
  "../../src-react/domains/ai/library/components/LibraryPickerDialog",
  () => ({ default: () => null }),
);
vi.mock("../../src-react/domains/ai/chat/components/expert-sub-menu", () => ({
  default: () => null,
}));
vi.mock("../../src-react/domains/ai/chat/components/skill-sub-menu", () => ({
  default: () => null,
}));

import PlusMenu from "../../src-react/domains/ai/chat/components/PlusMenu";

const BASE_PROPS = {
  sessionId: 1,
  currentMode: "agent" as const,
  onPickPaths: () => undefined,
  onPickLibraryFiles: () => undefined,
  onOpenMcp: () => undefined,
};

/** 开根菜单：Radix DropdownMenuTrigger 经 pointerDown(主键)+click 打开 */
async function openPlusMenu(): Promise<void> {
  const trigger = screen.getByRole("button", {
    name: "chat:input.addMenuHint",
  });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.getByText("chat:plus.addFile")).toBeTruthy();
  });
}

/** 菜单项内 Check 勾选图标（lucide-check）：enabled 态断言锚点 */
function checkIconOf(itemName: string): Element | null {
  const item = screen.getByRole("menuitem", { name: itemName });
  return item.querySelector("svg.lucide-check");
}

afterEach(cleanup);

describe("PlusMenu", () => {
  it("点击 ＋ 按钮应打开扩展菜单", async () => {
    render(<PlusMenu {...BASE_PROPS} />);
    await openPlusMenu();
    // 资料库项（Task 9）：位于添加文件之后
    expect(
      screen.getByRole("menuitem", { name: "chat:plus.library" }),
    ).toBeTruthy();
    expect(screen.getByText("chat:plus.connector")).toBeTruthy();
  });

  it("未传 localTask → 菜单无本地任务项（AI 模块零改动回归）", async () => {
    render(<PlusMenu {...BASE_PROPS} />);
    await openPlusMenu();
    expect(screen.queryByText("本地任务")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "本地任务" })).toBeNull();
  });

  it("传入 localTask → 项以调用方 label 渲染；点击调 onToggle(!enabled)；无 Check", async () => {
    const onToggle = vi.fn();
    render(
      <PlusMenu
        {...BASE_PROPS}
        localTask={{ enabled: false, label: "本地任务", onToggle }}
      />,
    );
    await openPlusMenu();
    expect(screen.getByRole("menuitem", { name: "本地任务" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "本地任务" }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(checkIconOf("本地任务")).toBeNull();
  });

  it("localTask.enabled=true → 勾选 Check 出现", async () => {
    render(
      <PlusMenu
        {...BASE_PROPS}
        localTask={{
          enabled: true,
          label: "本地任务",
          onToggle: () => undefined,
        }}
      />,
    );
    await openPlusMenu();
    expect(checkIconOf("本地任务")).not.toBeNull();
  });
});
