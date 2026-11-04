// @vitest-environment jsdom
/**
 * PickerDialog 通用多选弹窗交互测试（jsdom + testing-library，mock 骨架同
 * tests/app-settings/memory-dialogs.test.tsx，t 直接返回 key）：
 * - 勾选两项后确认，回传选中 id 集合（初始选中 + 用户勾选合并）
 * - 搜索关键字客户端过滤列表（name/tags/description 包含匹配）
 * - 点击取消不触发 onConfirm 并回调 onOpenChange(false) 关闭
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import PickerDialog from "../../src-react/domains/project/components/PickerDialog";

afterEach(cleanup);

const ITEMS = [
  { id: 1, name: "专家A", description: "写作" },
  { id: 2, name: "专家B", tags: ["产品"] },
];

describe("PickerDialog", () => {
  it("勾选两项后确认，回传选中 id 集合", () => {
    const onConfirm = vi.fn();
    render(
      <PickerDialog
        open
        onOpenChange={vi.fn()}
        title="选择专家"
        items={ITEMS}
        selectedIds={[1]}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("专家B"));
    fireEvent.click(
      screen.getByRole("button", { name: "project:picker.confirm" }),
    );
    expect(onConfirm).toHaveBeenCalledWith([1, 2]);
  });

  it("搜索关键字过滤列表", () => {
    render(
      <PickerDialog
        open
        onOpenChange={vi.fn()}
        title="选择专家"
        items={ITEMS}
        selectedIds={[]}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "专家A" },
    });
    expect(screen.getByText("专家A")).toBeTruthy();
    expect(screen.queryByText("专家B")).toBeNull();
  });

  it("点击取消不触发 onConfirm 并关闭", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PickerDialog
        open
        onOpenChange={onOpenChange}
        title="选择专家"
        items={ITEMS}
        selectedIds={[]}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "project:picker.cancel" }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
