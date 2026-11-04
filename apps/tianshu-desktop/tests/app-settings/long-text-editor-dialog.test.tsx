// @vitest-environment jsdom
/**
 * LongTextEditorDialog 交互测试：预填与重置、字数统计、保存回调与
 * 成功/失败路径、脏态关闭二次确认
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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

import LongTextEditorDialog from "../../src-react/domains/app-settings/components/LongTextEditorDialog";
import { toast } from "sonner";

function renderDialog(
  props: Partial<Parameters<typeof LongTextEditorDialog>[0]> = {},
) {
  const onOpenChange = vi.fn();
  const onSave = vi.fn(async () => undefined);
  render(
    <LongTextEditorDialog
      open
      onOpenChange={onOpenChange}
      title="编辑人设"
      initialValue="预填内容"
      maxLength={100}
      onSave={onSave}
      {...props}
    />,
  );
  return { onOpenChange, onSave };
}

describe("LongTextEditorDialog", () => {
  afterEach(() => cleanup());

  it("打开即预填 initialValue 并显示字数统计", () => {
    renderDialog();
    expect(screen.getByDisplayValue("预填内容")).toBeTruthy();
    expect(screen.getByText(/charCount/).textContent).toContain("4");
  });

  it("无修改时保存按钮禁用；修改后可用并提交 trim 后内容", async () => {
    const { onSave } = renderDialog();
    const saveButton = screen.getByRole("button", {
      name: "settings:personalization.editor.save",
    });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "  新内容  " },
    });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("新内容"));
  });

  it("保存成功 → 成功 toast + 关闭", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "新内容" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:personalization.editor.save",
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("保存失败 → 错误 toast 且不关闭（编辑内容保留）", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const { onOpenChange } = renderDialog({ onSave });
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "新内容" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:personalization.editor.save",
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByDisplayValue("新内容")).toBeTruthy();
  });

  it("脏态关闭 → 二次确认弹窗：丢弃后关闭，继续编辑保持打开", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(screen.getByDisplayValue("预填内容"), {
      target: { value: "改了" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:personalization.editor.cancel",
      }),
    );
    expect(
      screen.getByText("settings:personalization.editor.unsavedTitle"),
    ).toBeTruthy();
    // 继续编辑：关闭确认、弹窗仍在
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:personalization.editor.keepEditing",
      }),
    );
    expect(screen.getByDisplayValue("改了")).toBeTruthy();
    // 再次取消 → 丢弃：确认后真正关闭
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:personalization.editor.cancel",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:personalization.editor.discard",
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
