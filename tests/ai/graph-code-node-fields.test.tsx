// @vitest-environment jsdom
/**
 * CodeNodeFields 的 pythonCommand 下拉：仅 python 语言渲染「Python 命令」
 * 选择器（缺省 python / 可切 python3），点选经 onPatch 落节点字段；
 * bash 不渲染。执行侧语义（门禁/spawn 用哪个命令）见
 * tests/ai/graph-code-node.test.ts。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CodeNodeFields } from "@/domains/ai/orchestration/components/GraphNodeEditor";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  on: () => () => {},
}));

afterEach(cleanup);

const pyNode = {
  id: "p1",
  name: "py",
  kind: "code",
  language: "python",
  pythonCommand: "python",
  script: "print(1)",
  timeoutMs: 30_000,
  outputMode: "text",
  retries: 0,
} as const;

function pickPythonCommand() {
  // 语言下拉在前、「Python 命令」第二个 combobox
  fireEvent.pointerDown(screen.getAllByRole("combobox")[1], {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("CodeNodeFields pythonCommand 下拉", () => {
  it("python 节点渲染命令选择器；bash 节点不渲染", () => {
    render(<CodeNodeFields node={pyNode} onPatch={vi.fn()} />);
    expect(
      screen.getByText("chat:orchestration.editor.pythonCommand"),
    ).toBeTruthy();

    cleanup();
    render(
      <CodeNodeFields
        node={{ ...pyNode, id: "b1", language: "bash", pythonCommand: undefined }}
        onPatch={vi.fn()}
      />,
    );
    expect(
      screen.queryByText("chat:orchestration.editor.pythonCommand"),
    ).toBeNull();
  });

  it("切到 python3 → onPatch({ pythonCommand: 'python3' })", async () => {
    const onPatch = vi.fn();
    render(<CodeNodeFields node={pyNode} onPatch={onPatch} />);
    pickPythonCommand();
    fireEvent.click(await screen.findByRole("option", { name: /python3/ }));
    expect(onPatch).toHaveBeenCalledWith({ pythonCommand: "python3" });
  });
});
