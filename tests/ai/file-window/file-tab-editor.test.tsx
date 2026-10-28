// @vitest-environment jsdom
/**
 * FileTabEditor（受控化，draft 在 FileTabContent）：md 用
 * FileWindowMdEditor（CM6+分栏预览，MarkdownView 轻桩）、text/代码用
 * FileWindowEditor（CM6，语言按扩展名懒加载映射），value/onChange 双向
 * 透传（dirty/unsaved 落 store 由上层负责，见 file-tab-content 测试）；
 * ⌘S（meta/ctrl+s）仅在 dirty 时触发无参 onSave（保存值上层自取 draft）。
 * CM6 输入模拟经 view.dispatch+userEvent 注解（jsdom 无真实击键，见
 * cm-test-utils）；mock 骨架同 tests/ai/file-window/file-tab-content.test.tsx。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../src-react/domains/ai/chat/components/MarkdownView", () => ({
  default: ({ text }: { text: string }) => (
    <div data-testid="md-preview">{text}</div>
  ),
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileTabEditor from "../../../src-react/domains/ai/file-window/components/FileTabEditor";
import { cmDocOf, cmType, cmViewOf } from "./cm-test-utils";

afterEach(() => {
  cleanup();
  useFileWindowStore.getState().reset();
});

/** 经 store 打 tab 再挂受控编辑器（组件按 tabId 反查 contentKind/dirty） */
function setup(path: string, value = "原文", loading = false) {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path });
  const onSave = vi.fn();
  const onChange = vi.fn();
  const view = render(
    <FileTabEditor
      tabId={tabId}
      value={value}
      onChange={onChange}
      onSave={onSave}
      loading={loading}
    />,
  );
  return { tabId, onSave, onChange, container: view.container };
}

describe("FileTabEditor（受控）", () => {
  it("text → CM6 承载（.cm-content），value 受控直通", () => {
    const { container } = setup("a.txt");
    expect(screen.getByRole("textbox").className).toContain("cm-content");
    expect(cmDocOf(container)).toBe("原文");
  });

  it("md → CM6 md 编辑器 + 分栏预览（受控 value 透传）", () => {
    const { container } = setup("a.md");
    expect(cmDocOf(container)).toBe("原文");
    expect(screen.getByTestId("md-preview").textContent).toBe("原文");
  });

  it("md Eye 开关：关预览编辑独占，再开恢复", () => {
    const { container } = setup("a.md");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:library.mdHidePreview" }),
    );
    expect(screen.queryByTestId("md-preview")).toBeNull();
    expect(cmDocOf(container)).toBe("原文"); // 编辑器不随开关卸载
    fireEvent.click(
      screen.getByRole("button", { name: "chat:library.mdShowPreview" }),
    );
    expect(screen.getByTestId("md-preview").textContent).toBe("原文");
  });

  it("编辑（text）→ onChange 上抛，不落 store（dirty 归上层）", () => {
    const { tabId, onChange, container } = setup("a.txt");
    act(() => cmType(cmViewOf(container), "改"));
    expect(onChange).toHaveBeenCalledWith("改");
    const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.dirty).toBe(false);
  });

  it("编辑（md 编辑器 onChange）同样上抛", () => {
    const { onChange, container } = setup("a.md");
    act(() => cmType(cmViewOf(container), "# 改"));
    expect(onChange).toHaveBeenCalledWith("# 改");
  });

  it("loading → 编辑器禁输入（防半值编辑）", () => {
    setup("a.txt", "原文", true);
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe(
      "false",
    );
  });

  it("语言映射：a.py → python 语言扩展懒加载到位", async () => {
    const { container } = setup("a.py", "def f(): pass");
    // lang-python 注册行注释 #（语言扩展经懒加载 reconfigure 生效的凭证）
    await waitFor(() =>
      expect(
        cmViewOf(container).state.languageDataAt("commentTokens", 0),
      ).toContainEqual({ line: "#" }),
    );
  });

  it("⌘S 未 dirty 不触发；dirty 后触发无参 onSave", () => {
    const { tabId, onSave } = setup("a.txt");
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(onSave).not.toHaveBeenCalled();
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith();
  });

  it("ctrl+s 同义触发（Windows/Linux）", () => {
    const { tabId, onSave } = setup("a.txt");
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("两脏 tab 并存 ⌘S 只保存激活者（全挂载激活门），切激活随门走", () => {
    const a = setup("a.txt");
    const b = setup("b.txt"); // 后开者激活
    act(() => {
      useFileWindowStore.getState().patchTab(a.tabId, { dirty: true });
      useFileWindowStore.getState().patchTab(b.tabId, { dirty: true });
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(a.onSave).not.toHaveBeenCalled(); // 后台脏 tab 不随激活者写盘
    expect(b.onSave).toHaveBeenCalledTimes(1);
    act(() => {
      useFileWindowStore.getState().activate(a.tabId);
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(a.onSave).toHaveBeenCalledTimes(1); // 门随激活切换生效
    expect(b.onSave).toHaveBeenCalledTimes(1);
  });
});
