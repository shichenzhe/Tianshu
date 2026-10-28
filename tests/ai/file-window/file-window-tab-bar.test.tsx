// @vitest-environment jsdom
/**
 * FileWindowTabBar：contentKind→图标映射、选择/关闭/重排回调透传 store、
 * 行尾「+」挂 NewTabMenu（T15：pointerDown 展开菜单）、tab 右键挂
 * TabContextMenu（onTabContextMenu 透传）、平台让位类（darwin pl-20 让
 * 红绿灯 / 非 darwin pr-[146px] 让窗口按钮区）；X 键关闭走 beforeClose
 * 拦截（终审 C1）：非脏直接关、脏 tab 经 close-confirm 注册表确认
 * （asker 桩渲染 CloseConfirmBar 模拟 FileWindowView 确认浮层）后落子。
 * 附 DetailTabBar 泛化新 prop 直测（tabs 项最小 {id,title} 形状、iconOf
 * 缺省 KIND_ICON 路径、beforeClose 拦截、onTabContextMenu 右键挂点）。
 * T17：busy 文案（busyLabel 注入替代 title + aria-busy + 禁交互——
 * 点击不切/X 不可关/拖拽不起）与「打开的文档」溢出下拉（列全部 tab、
 * 点击激活、激活高亮、busy 项禁用）。审查修复轮：M1 busy 落点不重排、
 * M2 tabIndex -1。
 * mock 骨架同 tests/ai/chat/file-preview.test.tsx（t 返回 key；Button→
 * @/lib/utils→@/i18n 链需 react-i18next 真实导出，故部分 mock）；
 * window.platform 用 vi.stubGlobal 按用例注入（jsdom 原缺）；Radix/jsdom
 * 桩与 ipc mock 因 NewTabMenu（+菜单，T15）挂入新增（同 tasks-pane.test.tsx）。
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileWindowTabBar from "../../../src-react/domains/ai/file-window/components/FileWindowTabBar";
import DetailTabBar from "../../../src-react/domains/ai/chat/components/detail-panel/DetailTabBar";
import CloseConfirmBar, {
  type CloseConfirmAnswer,
} from "../../../src-react/domains/ai/file-window/components/CloseConfirmBar";
import {
  registerCloseConfirmAsk,
  unregisterCloseConfirmAsk,
} from "../../../src-react/domains/ai/file-window/lib/close-confirm";

// Radix DropdownMenu 在 jsdom 的最小桩（popper/触发器 pointerDown 依赖）；
// ResizeObserver 桩走 beforeEach 反复挂——afterEach unstubAllGlobals 会一并
// 清掉（防 platform 用例的 stubGlobal 泄漏到后续用例），故每例重建
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  invokeMock.mockReset();
  unregisterCloseConfirmAsk();
  useFileWindowStore.getState().reset();
});

/** 根顶行 div（平台让位类落点） */
const rowClassOf = (container: HTMLElement) =>
  (container.firstElementChild as HTMLElement).className;

/** 关闭按钮（DetailTabBar 内嵌，悬停显形但 jsdom 可直接点） */
const closeButtons = () =>
  screen.getAllByRole("button", { name: "chat:detailPanel.closeTab" });

describe("FileWindowTabBar", () => {
  it("渲染 tab 并点击切换激活", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
    }).tabId;
    s.openTab({ kind: "workspace", workspaceId: 7, path: "b.md" });
    render(<FileWindowTabBar />);
    const second = screen.getByRole("tab", { name: /b\.md/ });
    fireEvent.click(second);
    expect(useFileWindowStore.getState().activeTabId).not.toBe(a);
  });

  it("图标按 contentKind 映射（csv→Table / md→FileText）", () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    s.openTab({ kind: "workspace", workspaceId: 7, path: "b.csv" });
    const { container } = render(<FileWindowTabBar />);
    // 无 iconOf 时 FileWindowTab 无 kind 字段会全部落 FileText 兜底，
    // Table 恰可证 iconOf 注入生效
    expect(container.querySelectorAll(".lucide-file-text").length).toBe(1);
    expect(container.querySelectorAll(".lucide-table").length).toBe(1);
  });

  it("关闭按钮：非脏 tab 直接关（不经确认 asker）——X 键透传 closeTab", async () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    const b = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.md",
    }).tabId;
    const asker = vi.fn();
    registerCloseConfirmAsk(asker);
    render(<FileWindowTabBar />);
    fireEvent.click(closeButtons()[1]);
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs).toHaveLength(1),
    );
    expect(useFileWindowStore.getState().tabs.map((t) => t.id)).not.toContain(
      b,
    );
    // 非脏直接放行：确认浮层 never
    expect(asker).not.toHaveBeenCalled();
  });

  it("X 键（终审 C1）：脏 tab 先弹确认条（注册表 asker），discard 后才关", async () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    const b = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.md",
    }).tabId;
    useFileWindowStore.getState().patchTab(b, { dirty: true });
    // asker 桩同 FileWindowView：渲染 CloseConfirmBar，按钮落子回抛
    registerCloseConfirmAsk(
      (tab) =>
        new Promise<CloseConfirmAnswer>((resolve) => {
          const { unmount } = render(
            <CloseConfirmBar
              tab={tab}
              onAnswer={(answer) => {
                resolve(answer);
                unmount();
              }}
            />,
          );
        }),
    );
    render(<FileWindowTabBar />);
    fireEvent.click(closeButtons()[1]);
    // 确认条渲染（确认流已接入）；确认未落子前 tab 保留
    expect(
      await screen.findByText("chat:fileWindow.closeConfirm.title"),
    ).toBeTruthy();
    expect(useFileWindowStore.getState().tabs).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.closeConfirm.discard",
      }),
    );
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs.map((t) => t.id)).not.toContain(
        b,
      ),
    );
  });

  it("X 键（终审 C1）：脏 tab 确认取消 → 不关，tab 保留", async () => {
    const s = useFileWindowStore.getState();
    const b = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.md",
    }).tabId;
    useFileWindowStore.getState().patchTab(b, { dirty: true });
    registerCloseConfirmAsk(
      (tab) =>
        new Promise<CloseConfirmAnswer>((resolve) => {
          const { unmount } = render(
            <CloseConfirmBar
              tab={tab}
              onAnswer={(answer) => {
                resolve(answer);
                unmount();
              }}
            />,
          );
        }),
    );
    render(<FileWindowTabBar />);
    fireEvent.click(closeButtons()[0]);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.closeConfirm.cancel",
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(useFileWindowStore.getState().tabs.map((t) => t.id)).toContain(b);
  });

  it("拖拽重排透传（dragStart→drop → onReorder → store 落点修正）", () => {
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
      path: "c.csv",
    }).tabId;
    const { container } = render(<FileWindowTabBar />);
    const tabs = container.querySelectorAll('[role="tab"]');
    // 拖首落尾：落点语义「放到目标位、目标后顺移」（store T3 契约）→
    // [a,b,c] 拖 a 落 c 得 [b,a,c]；注意拖到紧邻右邻（to-1 回插）为视觉
    // no-op，须三 tab 才能显形
    fireEvent.dragStart(tabs[0]);
    fireEvent.drop(tabs[2]);
    expect(useFileWindowStore.getState().tabs.map((t) => t.id)).toEqual([
      b,
      a,
      c,
    ]);
  });

  it("行尾「+」即 NewTabMenu 触发器：pointerDown 展开新建/打开菜单", async () => {
    render(<FileWindowTabBar />);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "chat:fileWindow.tab.new" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(
      await screen.findByText("chat:fileWindow.file.newMarkdown"),
    ).toBeTruthy();
  });

  it("tab 右键透传挂 TabContextMenu（移动/关闭其他等菜单项）", () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    s.openTab({ kind: "workspace", workspaceId: 7, path: "b.md" });
    const { container } = render(<FileWindowTabBar />);
    fireEvent.contextMenu(container.querySelectorAll('[role="tab"]')[0]);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("chat:fileWindow.openInNewWindow")).toBeTruthy();
    expect(screen.getByText("chat:fileWindow.menu.closeOthers")).toBeTruthy();
  });

  it("平台让位类：darwin pl-20 让红绿灯；非 darwin pr-[146px] 让窗口按钮", () => {
    vi.stubGlobal("platform", "darwin");
    const mac = render(<FileWindowTabBar />);
    expect(rowClassOf(mac.container)).toContain("pl-20");
    expect(rowClassOf(mac.container)).not.toContain("pr-[146px]");
    cleanup();

    vi.stubGlobal("platform", "win32");
    const win = render(<FileWindowTabBar />);
    expect(rowClassOf(win.container)).toContain("pr-[146px]");
    expect(rowClassOf(win.container)).not.toContain("pl-20");
  });

  it("顶行可拖动窗口：drag 区 + 交互块 no-drag 隔离", () => {
    vi.stubGlobal("platform", "darwin");
    const { container } = render(<FileWindowTabBar />);
    // 顶行整体 drag：titleBarStyle hidden 后窗口拖动的唯一来源（红绿灯/
    // overlay 为原生行为不冲突）；缺它则整条工具栏拖不动窗口
    expect(rowClassOf(container)).toContain("[-webkit-app-region:drag]");
    // 交互块（tab 条 + 打开文档 + 「+」）no-drag：drag 区内点击/拖排不失效
    const interactive = (container.firstElementChild as HTMLElement)
      .firstElementChild as HTMLElement;
    expect(interactive.className).toContain("[-webkit-app-region:no-drag]");
  });
});

describe("DetailTabBar 泛化新 prop", () => {
  it("tabs 项最小 {id,title} 形状可渲染，缺 kind 图标落 FileText 兜底", () => {
    render(
      <DetailTabBar
        tabs={[{ id: "x1", title: "外部 tab" }]}
        activeTabId="x1"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(screen.getByRole("tab", { name: "外部 tab" })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "外部 tab" })
        .querySelector(".lucide-file-text"),
    ).toBeTruthy();
  });

  it("iconOf 缺省时沿用 KIND_ICON（kind=browser → Globe）", () => {
    render(
      <DetailTabBar
        tabs={[{ id: "x1", kind: "browser", title: "浏览", createdAt: 0 }]}
        activeTabId="x1"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "浏览" }).querySelector(".lucide-globe"),
    ).toBeTruthy();
  });

  it("beforeClose 返回 false 阻止关闭；放行/缺省则照常 onClose", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <DetailTabBar
        tabs={[{ id: "x1", title: "甲" }]}
        activeTabId="x1"
        onSelect={() => {}}
        onClose={onClose}
        onReorder={() => {}}
        beforeClose={() => false}
      />,
    );
    fireEvent.click(closeButtons()[0]);
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <DetailTabBar
        tabs={[{ id: "x1", title: "甲" }]}
        activeTabId="x1"
        onSelect={() => {}}
        onClose={onClose}
        onReorder={() => {}}
        beforeClose={() => true}
      />,
    );
    fireEvent.click(closeButtons()[0]);
    expect(onClose).toHaveBeenCalledWith("x1");
  });

  it("onTabContextMenu：tab 右键回调携 tabId；缺省不拦系统菜单", () => {
    const onTabContextMenu = vi.fn();
    const { container } = render(
      <DetailTabBar
        tabs={[
          { id: "x1", title: "甲" },
          { id: "x2", title: "乙" },
        ]}
        activeTabId="x1"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onTabContextMenu={onTabContextMenu}
      />,
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    const sysMenu = fireEvent.contextMenu(tabs[1]);
    // 挂点存在：系统菜单被 preventDefault 拦下并回调
    expect(sysMenu).toBe(false);
    expect(onTabContextMenu).toHaveBeenCalledWith("x2", expect.anything());

    // 缺省 prop：不拦系统菜单（contextMenu 默认行为未被取消）
    cleanup();
    onTabContextMenu.mockClear();
    const bare = render(
      <DetailTabBar
        tabs={[{ id: "x1", title: "甲" }]}
        activeTabId="x1"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(
      fireEvent.contextMenu(bare.container.querySelector('[role="tab"]')),
    ).toBe(true);
    expect(onTabContextMenu).not.toHaveBeenCalled();
  });
});

describe("busy 文案（T17）", () => {
  it("closing/moving 映射 busyLabel：替代标题 + aria-busy + 点击不切走", () => {
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
    }).tabId; // 后开者激活
    useFileWindowStore.getState().patchTab(a, { busy: "closing" });
    render(<FileWindowTabBar />);
    const busyTab = screen.getByRole("tab", {
      name: "chat:fileWindow.tab.closing",
    });
    expect(busyTab.getAttribute("aria-busy")).toBe("true");
    // 标题被 busy 文案替代（tab 条不再渲染原标题）
    expect(screen.queryByText("a.md")).toBeNull();
    fireEvent.click(busyTab);
    expect(useFileWindowStore.getState().activeTabId).toBe(b);
    // closing → moving 热切换：文案随 busy 态更新
    act(() => useFileWindowStore.getState().patchTab(a, { busy: "moving" }));
    expect(
      screen.getByRole("tab", { name: "chat:fileWindow.tab.moving" }),
    ).toBeTruthy();
    expect(screen.queryByText("a.md")).toBeNull();
  });

  it("busy tab X 键不可关：确认流不触发、tab 保留", () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    useFileWindowStore
      .getState()
      .patchTab(useFileWindowStore.getState().tabs[0].id, {
        dirty: true,
        busy: "moving",
      });
    const asker = vi.fn();
    registerCloseConfirmAsk(asker);
    render(<FileWindowTabBar />);
    fireEvent.click(closeButtons()[0]);
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
    expect(asker).not.toHaveBeenCalled();
  });

  it("DetailTabBar busyLabel 直测：替代 title 渲染、点/关/拖（拾起与落点）全禁", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onReorder = vi.fn();
    const { container } = render(
      <DetailTabBar
        tabs={[
          { id: "x1", title: "甲", busyLabel: "正在关闭…" },
          { id: "x2", title: "乙" },
        ]}
        activeTabId="x1"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={onReorder}
      />,
    );
    const busy = screen.getByRole("tab", { name: "正在关闭…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("甲")).toBeNull();
    // 不可点（点击/Enter 键均不选）
    fireEvent.click(busy);
    fireEvent.keyDown(busy, { key: "Enter" });
    // 不可关（X 键不落 onClose）
    fireEvent.click(closeButtons()[0]);
    // 不可拖（dragStart 不拾起，drop 无源无重排）
    const tabs = container.querySelectorAll('[role="tab"]');
    fireEvent.dragStart(tabs[0]);
    fireEvent.drop(tabs[1]);
    // 不可作拖拽落点（审查 M1：他 tab 在途 drop 到 busy tab 不重排——
    // jsdom 直派发事件的可达路径，真实浏览器 pointer-events-none 先拦）
    fireEvent.dragStart(tabs[1]);
    fireEvent.drop(tabs[0]);
    // tabIndex -1：移出 Tab 序列（审查 M2），非 busy 保持 0
    expect(busy.tabIndex).toBe(-1);
    expect((tabs[1] as HTMLElement).tabIndex).toBe(0);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
    // 非 busy tab 照常可选
    fireEvent.click(screen.getByRole("tab", { name: "乙" }));
    expect(onSelect).toHaveBeenCalledWith("x2");
  });
});

describe("「打开的文档」溢出下拉（T17）", () => {
  /** pointerDown 展开 + 菜单就位（NewTabMenu 同款） */
  const openDocumentsMenu = async () => {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "chat:fileWindow.tab.openDocuments" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    return within(await screen.findByRole("menu"));
  };

  it("无 tab 不渲染按钮；有 tab 列全部、点击激活、激活态高亮", async () => {
    render(<FileWindowTabBar />);
    expect(
      screen.queryByRole("button", {
        name: "chat:fileWindow.tab.openDocuments",
      }),
    ).toBeNull();
    cleanup();

    const s = useFileWindowStore.getState();
    const a = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
    }).tabId;
    s.openTab({ kind: "workspace", workspaceId: 7, path: "b.md" }); // 后开者激活
    render(<FileWindowTabBar />);
    const menu = await openDocumentsMenu();
    // 列全部 tab（横滚溢出场景从下拉仍可达）
    expect(menu.getByText("a.md")).toBeTruthy();
    expect(menu.getByText("b.md")).toBeTruthy();
    // 激活 tab 高亮
    const activeItem = menu
      .getByText("b.md")
      .closest('[role="menuitem"]') as HTMLElement;
    expect(activeItem.className).toContain("bg-primary-subtle");
    // 点击激活
    fireEvent.click(menu.getByText("a.md"));
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
  });

  it("busy tab 菜单项禁用 + busy 文案替代标题", async () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    useFileWindowStore
      .getState()
      .patchTab(useFileWindowStore.getState().tabs[0].id, {
        busy: "moving",
      });
    render(<FileWindowTabBar />);
    const menu = await openDocumentsMenu();
    const item = menu
      .getByText("chat:fileWindow.tab.moving")
      .closest('[role="menuitem"]') as HTMLElement;
    expect(item.getAttribute("data-disabled")).toBe("");
    expect(menu.queryByText("a.md")).toBeNull();
  });
});
