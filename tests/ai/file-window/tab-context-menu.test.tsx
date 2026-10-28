// @vitest-environment jsdom
/**
 * TabContextMenu（tab 右键菜单，Task 15）：
 * - 在新窗口打开=移动语义：busy=moving → 关闭确认前置（脏 tab）→
 *   fileWindow:open 携 sessionId → 本窗 closeTab；确认取消/保存失败不动
 * - 关闭：非脏直关；脏走确认（discard 关 / cancel 留）
 * - 关闭其他 / 关闭右侧：非脏直接关，仅目标保留（脏确认路径复用
 *   resolveTabClosures，由 close-confirm 注册表测试联动覆盖）
 * - 复制路径：workspace=相对路径 / library=条目名 + toast
 * mock 骨架同 new-tab-menu.test.tsx；关闭确认 asker 经注册表注入桩。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
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

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import TabContextMenu from "../../../src-react/domains/ai/file-window/components/TabContextMenu";
import {
  registerCloseConfirmAsk,
  unregisterCloseConfirmAsk,
} from "../../../src-react/domains/ai/file-window/lib/close-confirm";
import type { CloseConfirmAnswer } from "../../../src-react/domains/ai/file-window/components/CloseConfirmBar";

const clipboardMock = vi.hoisted(() => ({ writeText: vi.fn() }));

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: clipboardMock,
    configurable: true,
  });
});

/** 三 tab 就位 [a.md, b.md, c.md]，返回各自 id */
function seedTabs() {
  const s = useFileWindowStore.getState();
  const a = s.openTab({
    kind: "workspace",
    workspaceId: 7,
    path: "a.md",
  }).tabId;
  const b = s.openTab({
    kind: "workspace",
    workspaceId: 7,
    path: "b.md",
  }).tabId;
  const c = s.openTab({
    kind: "workspace",
    workspaceId: 7,
    path: "c.md",
  }).tabId;
  return { a, b, c };
}

const openCalls = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "fileWindow:open");
const tabIds = () => useFileWindowStore.getState().tabs.map((t) => t.id);
const pathOf = (tabId: string) => {
  const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
  return tab && tab.resource.kind === "workspace" ? tab.resource.path : "";
};

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  clipboardMock.writeText.mockClear();
  unregisterCloseConfirmAsk();
  useFileWindowStore.getState().reset();
});

describe("TabContextMenu 移动语义", () => {
  it("非脏 tab：fileWindow:open 携 sessionId → 本窗移除", async () => {
    const { a } = seedTabs();
    useFileWindowStore.getState().patchTab(a, { sessionId: 42 });
    const onClose = vi.fn();
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={onClose} />);
    fireEvent.click(screen.getByText("chat:fileWindow.openInNewWindow"));
    await waitFor(() => expect(openCalls()).toHaveLength(1));
    expect(openCalls()[0]?.[1]).toEqual({
      resources: [
        { kind: "workspace", workspaceId: 7, path: "a.md", sessionId: 42 },
      ],
      targetWindowId: undefined,
    });
    await waitFor(() => expect(tabIds()).not.toContain(a));
    // 移动期间 busy=moving（防重入），落定后复位
    expect(onClose).toHaveBeenCalled();
  });

  it("脏 tab：确认 discard 后才移动（保存流不触发）", async () => {
    const { a } = seedTabs();
    useFileWindowStore.getState().patchTab(a, { dirty: true, sessionId: 9 });
    registerCloseConfirmAsk(() =>
      Promise.resolve("discard" as CloseConfirmAnswer),
    );
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.openInNewWindow"));
    await waitFor(() => expect(openCalls()).toHaveLength(1));
    await waitFor(() => expect(tabIds()).not.toContain(a));
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "workspace:writeFile"),
    ).toBe(false);
  });

  it("脏 tab：确认取消 → 不移动不写盘，tab 保留", async () => {
    const { a } = seedTabs();
    useFileWindowStore.getState().patchTab(a, { dirty: true });
    registerCloseConfirmAsk(() =>
      Promise.resolve("cancel" as CloseConfirmAnswer),
    );
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.openInNewWindow"));
    await waitFor(() => expect(toastMock.error).not.toHaveBeenCalled());
    expect(openCalls()).toHaveLength(0);
    expect(tabIds()).toContain(a);
    // busy 复位（取消后可再操作）
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === a)?.busy,
    ).toBeNull();
  });

  it("busy 防重入：moving 中再点不重复发起", async () => {
    const { a } = seedTabs();
    useFileWindowStore.getState().patchTab(a, { busy: "moving" });
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.openInNewWindow"));
    expect(openCalls()).toHaveLength(0);
    expect(tabIds()).toHaveLength(3);
  });
});

describe("TabContextMenu 关闭族", () => {
  it("关闭：非脏 tab 直接移除", async () => {
    const { b } = seedTabs();
    render(<TabContextMenu tabId={b} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.close"));
    await waitFor(() => expect(tabIds()).not.toContain(b));
  });

  it("关闭：脏 tab 确认取消 → 保留", async () => {
    const { b } = seedTabs();
    useFileWindowStore.getState().patchTab(b, { dirty: true });
    registerCloseConfirmAsk(() =>
      Promise.resolve("cancel" as CloseConfirmAnswer),
    );
    render(<TabContextMenu tabId={b} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.close"));
    expect(tabIds()).toHaveLength(3);
  });

  it("关闭其他：仅目标保留", async () => {
    const { a, b, c } = seedTabs();
    render(<TabContextMenu tabId={b} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.closeOthers"));
    await waitFor(() => expect(tabIds()).toEqual([b]));
    expect(pathOf(b)).toBe("b.md");
    void a;
    void c;
  });

  it("关闭右侧：目标及其左侧保留", async () => {
    const { b, c } = seedTabs();
    render(<TabContextMenu tabId={b} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.closeRight"));
    await waitFor(() => expect(tabIds()).toHaveLength(2));
    expect(tabIds()).not.toContain(c);
  });

  it("关闭其他/右侧禁用边界：单 tab 无其他可关", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
    }).tabId;
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={() => {}} />);
    expect(
      (
        screen.getByText(
          "chat:fileWindow.menu.closeOthers",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByText("chat:fileWindow.menu.closeRight") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("TabContextMenu 复制路径", () => {
  it("workspace：写相对路径 + 成功 toast", async () => {
    const { a } = seedTabs();
    clipboardMock.writeText.mockResolvedValue(undefined);
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.copyPath"));
    await waitFor(() =>
      expect(clipboardMock.writeText).toHaveBeenCalledWith("a.md"),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "chat:fileWindow.toast.copied",
      ),
    );
  });

  it("library：写条目名（title，T14 载入后即条目名）", async () => {
    const l = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 }).tabId;
    useFileWindowStore.getState().patchTab(l, { title: "产品白皮书.pdf" });
    clipboardMock.writeText.mockResolvedValue(undefined);
    render(<TabContextMenu tabId={l} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.copyPath"));
    await waitFor(() =>
      expect(clipboardMock.writeText).toHaveBeenCalledWith("产品白皮书.pdf"),
    );
  });

  it("复制失败 toast 兜底", async () => {
    const { a } = seedTabs();
    clipboardMock.writeText.mockRejectedValue(new Error("denied"));
    render(<TabContextMenu tabId={a} x={8} y={8} onClose={() => {}} />);
    fireEvent.click(screen.getByText("chat:fileWindow.menu.copyPath"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "chat:fileWindow.toast.copyFailed",
      ),
    );
  });
});
