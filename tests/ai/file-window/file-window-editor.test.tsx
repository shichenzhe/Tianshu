// @vitest-environment jsdom
/**
 * FileWindowEditor（T24，spec §14）：CM6 承载（.cm-content role=textbox）、
 * 受控桥接（本地输入→onChange 上抛；外部 value 变化→视图全量替换且不回
 * 环 onChange——外部 reload 不得误标 dirty；本地输入未回声不被覆写）、
 * 光标同 offset 保留（越界截断）、readOnly 禁输入（loading 期间外部值仍
 * 可同步）、⌘S 不入 keymap（冒泡 window 且不拦默认）、语言懒加载
 * reconfigure（markdown 语法树就位）。T25 收尾：外部替换重置 undo 链
 * （Mod-z 不复活弃稿、替换后本地编辑照常可撤销）、ariaLabel 响应式。
 * jsdom 无真实击键：本地输入经
 * view.dispatch + userEvent=input 注解（受控桥接本地路径，见 cm-test-utils）。
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
import { useState } from "react";
import { syntaxTree } from "@codemirror/language";
import { undo } from "@codemirror/commands";

import FileWindowEditor from "../../../src-react/domains/ai/file-window/components/FileWindowEditor";
import { cmDocOf, cmType, cmViewOf } from "./cm-test-utils";

afterEach(() => cleanup());

type EditorProps = Parameters<typeof FileWindowEditor>[0];

function renderEditor(props: Partial<EditorProps> = {}) {
  const onChange = vi.fn();
  const view = render(
    <FileWindowEditor
      value="原文"
      onChange={onChange}
      language="text"
      {...props}
    />,
  );
  return { onChange, container: view.container, rerender: view.rerender };
}

/** 受控宿主（回声 value——组件真实使用形态） */
function Harness({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  return <FileWindowEditor value={text} onChange={setText} language="text" />;
}

describe("FileWindowEditor（CM6 受控桥接）", () => {
  it("挂载 .cm-content（role=textbox），初始 doc=外部 value", () => {
    renderEditor({ value: "hello" });
    const box = screen.getByRole("textbox");
    expect(box.className).toContain("cm-content");
    expect(cmDocOf()).toBe("hello");
  });

  it("本地输入 → onChange 上抛新值（userEvent=input 本地来源）", () => {
    const { onChange } = renderEditor({ value: "a" });
    act(() => cmType(cmViewOf(), "b"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("受控回声闭环：宿主回传 value 后 doc 稳定不重复上抛", () => {
    render(<Harness initial="a" />);
    act(() => cmType(cmViewOf(), "ab"));
    // onChange→setState 回声→外部同步 no-op，doc 停在输入值
    expect(cmDocOf()).toBe("ab");
    expect(cmViewOf().state.doc.toString()).toBe("ab");
  });

  it("外部 value 变化（重载）→ 视图全量替换且不回环 onChange", () => {
    const { onChange, rerender } = renderEditor({ value: "old" });
    act(() => {
      rerender(
        <FileWindowEditor value="磁盘新" onChange={onChange} language="text" />,
      );
    });
    expect(cmDocOf()).toBe("磁盘新");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("本地输入后外部携旧 value 回灌（父未回声）→ 不覆写本地输入、不再上抛", () => {
    // 非回声宿主（onChange=vi.fn 不回灌 value）：本地输入后宿主 rerender
    // 仍携旧 value——localAhead 守卫窗口，外部覆写分支不得触发
    const { onChange, rerender } = renderEditor({ value: "原文" });
    act(() => cmType(cmViewOf(), "本地输入"));
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => {
      rerender(
        <FileWindowEditor value="原文" onChange={onChange} language="text" />,
      );
    });
    expect(cmDocOf()).toBe("本地输入"); // 旧值不撤用户输入
    expect(onChange).toHaveBeenCalledTimes(1); // 不回环上抛
    // 真外部变更（value 前进≠上次值）仍照常覆写
    act(() => {
      rerender(
        <FileWindowEditor
          value="外部新文"
          onChange={onChange}
          language="text"
        />,
      );
    });
    expect(cmDocOf()).toBe("外部新文");
  });

  it("外部全量替换重置 undo 链：Mod-z 不复活弃稿（替换后本地编辑照常可撤销）", () => {
    const { onChange, rerender } = renderEditor({ value: "旧草稿" });
    act(() => cmType(cmViewOf(), "旧草稿+本地改")); // 本地编辑入 undo 链
    act(() => {
      rerender(
        <FileWindowEditor
          value="磁盘新文"
          onChange={onChange}
          language="text"
        />,
      );
    });
    expect(cmDocOf()).toBe("磁盘新文");
    act(() => {
      undo(cmViewOf()); // Mod-z 等价命令
    });
    expect(cmDocOf()).toBe("磁盘新文"); // undo 链已重置，弃稿不复活
    // 替换后的本地编辑不受影响：可撤销回替换基线
    act(() => cmType(cmViewOf(), "磁盘新文+新改"));
    act(() => {
      undo(cmViewOf());
    });
    expect(cmDocOf()).toBe("磁盘新文");
  });

  it("外部替换光标同 offset 保留（越界截断）", () => {
    const { rerender, onChange } = renderEditor({ value: "abcdef" });
    const view = cmViewOf();
    act(() => {
      view.dispatch({ selection: { anchor: 4, head: 4 } });
    });
    act(() => {
      rerender(
        <FileWindowEditor value="xy" onChange={onChange} language="text" />,
      );
    });
    expect(cmViewOf().state.selection.main.head).toBe(2); // 4 越界截断
    act(() => {
      rerender(
        <FileWindowEditor
          value="abcdefgh"
          onChange={onChange}
          language="text"
        />,
      );
    });
    expect(cmViewOf().state.selection.main.head).toBe(2); // 同 offset 保持
  });

  it("readOnly：contenteditable=false + aria-readonly（禁输入）", () => {
    renderEditor({ readOnly: true });
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("contenteditable")).toBe("false");
    expect(box.getAttribute("aria-readonly")).toBe("true");
  });

  it("ariaLabel 响应式更新（locale 切换不滞留旧标签）", () => {
    const { rerender, onChange } = renderEditor({ ariaLabel: "编辑区" });
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe(
      "编辑区",
    );
    act(() => {
      rerender(
        <FileWindowEditor
          value="原文"
          onChange={onChange}
          language="text"
          ariaLabel="Edit area"
        />,
      );
    });
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe(
      "Edit area",
    );
    // 置空回退：属性摘除
    act(() => {
      rerender(
        <FileWindowEditor value="原文" onChange={onChange} language="text" />,
      );
    });
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBeNull();
  });

  it("readOnly（loading）期间外部 value 到位仍同步进视图（防半值≠空窗）", () => {
    const { rerender, onChange } = renderEditor({
      readOnly: true,
      value: "",
    });
    act(() => {
      rerender(
        <FileWindowEditor
          value="就绪内容"
          onChange={onChange}
          language="text"
          readOnly
        />,
      );
    });
    expect(cmDocOf()).toBe("就绪内容");
  });

  it("⌘S 在 CM6 内按下冒泡 window 且不被 preventDefault", () => {
    const onKey = vi.fn();
    window.addEventListener("keydown", onKey);
    renderEditor();
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "s",
      metaKey: true,
    });
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0][0].defaultPrevented).toBe(false);
    window.removeEventListener("keydown", onKey);
  });

  it("语言懒加载：markdown 到位后语法树 reconfigure", async () => {
    renderEditor({ value: "# hi", language: "markdown" });
    await waitFor(() => {
      expect(syntaxTree(cmViewOf().state).topNode.firstChild?.name).toBe(
        "ATXHeading1",
      );
    });
  });

  it("语言切换：markdown → text 摘除语言扩展", async () => {
    const { rerender, onChange } = renderEditor({
      value: "# hi",
      language: "markdown",
    });
    await waitFor(() => {
      expect(syntaxTree(cmViewOf().state).topNode.firstChild?.name).toBe(
        "ATXHeading1",
      );
    });
    act(() => {
      rerender(
        <FileWindowEditor value="# hi" onChange={onChange} language="text" />,
      );
    });
    await waitFor(() => {
      expect(syntaxTree(cmViewOf().state).topNode.firstChild).toBeNull();
    });
  });
});
