// @vitest-environment jsdom
/**
 * DetailTabBar 交互：渲染/切换/关闭回调/拖拽重排。kind→图标映射内部消化不测视觉。
 * 仓库无 jest-dom，aria-selected 用原生 getAttribute 断言；i18n mock t
 * 返回 key（关闭按钮 aria-label 即 key 串），多 tab 关闭按钮同名以
 * within(tab) 作用域定位；vitest 未开 globals，手动 cleanup（同
 * tests/ai/prompt-chips.test.tsx 约定）
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // tooltip import 链拉入 @/lib/utils → i18n（use initReactI18next）
  initReactI18next: { type: "3rd-party", init: () => {} },
}));

import DetailTabBar from "../../src-react/domains/ai/chat/components/detail-panel/DetailTabBar";

const TABS = [
  { id: "a", kind: "artifacts", title: "产物", createdAt: 1 },
  { id: "b", kind: "terminal", title: "终端", createdAt: 2 },
] as const;

// jsdom 30 未实现 scrollIntoView：原型层挂 mock（仅本文件影响），
// 供「激活 tab 滚入视野」用例 spy 断言
const scrollIntoViewMock = vi.fn();
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(cleanup);
beforeEach(() => scrollIntoViewMock.mockClear());

describe("DetailTabBar", () => {
  it("渲染各 tab 标题，active 高亮 aria-selected", () => {
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    const tabA = screen.getByRole("tab", { name: /产物/ });
    expect(tabA.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tab", { name: /终端/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("点击 tab 触发 onSelect，点关闭触发 onClose 且不冒泡 onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /终端/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
    const closeB = within(screen.getByRole("tab", { name: /终端/ })).getByRole(
      "button",
      { name: "chat:detailPanel.closeTab" },
    );
    fireEvent.click(closeB);
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("拖到其他 tab 触发 onReorder(from,to)；拖到自身 no-op", () => {
    const onReorder = vi.fn();
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={onReorder}
      />,
    );
    const tabA = screen.getByRole("tab", { name: /产物/ });
    const tabB = screen.getByRole("tab", { name: /终端/ });
    fireEvent.dragStart(tabA);
    // dragOver preventDefault 是浏览器 drop 生效前提：dispatchEvent 对
    // cancelable 事件 preventDefault 后返回 false
    expect(fireEvent.dragOver(tabB)).toBe(false);
    fireEvent.drop(tabB);
    expect(onReorder).toHaveBeenCalledWith("a", "b");
    // 拖到自身：dragOver 不 preventDefault、drop 不回调
    fireEvent.dragStart(tabB);
    expect(fireEvent.dragOver(tabB)).toBe(true);
    fireEvent.drop(tabB);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(tabA.getAttribute("draggable")).toBe("true");
  });

  it("滚动容器隐藏滚动条：scrollbar-width none + webkit-scrollbar hidden + overscroll contain", () => {
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    const cls = screen.getByRole("tablist").className;
    expect(cls).toContain("[scrollbar-width:none]");
    expect(cls).toContain("[&::-webkit-scrollbar]:hidden");
    expect(cls).toContain("overscroll-x-contain");
    expect(cls).toContain("overflow-x-auto");
  });

  it("激活 tab 滚入视野：mount 与 activeTabId 变化时对选中 tab 调 scrollIntoView(nearest)", () => {
    const props = {
      tabs: [...TABS],
      onSelect: () => {},
      onClose: () => {},
      onReorder: () => {},
    };
    const { rerender } = render(<DetailTabBar {...props} activeTabId="a" />);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(
      screen.getByRole("tab", { name: /产物/ }),
    );
    rerender(<DetailTabBar {...props} activeTabId="b" />);
    expect(scrollIntoViewMock.mock.contexts[1]).toBe(
      screen.getByRole("tab", { name: /终端/ }),
    );
  });

  it("scrollIntoView 缺失的环境（jsdom 无布局实现）渲染不抛错", () => {
    const desc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView =
      undefined;
    try {
      render(
        <DetailTabBar
          tabs={[...TABS]}
          activeTabId="a"
          onSelect={() => {}}
          onClose={() => {}}
          onReorder={() => {}}
        />,
      );
      expect(screen.getByRole("tablist")).toBeTruthy();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", desc);
    }
  });

  it("onWheel 把 deltaY+deltaX 叠加进 scrollLeft（jsdom scrollLeft 可写，直接断言数值）", () => {
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    const list = screen.getByRole("tablist");
    expect(list.scrollLeft).toBe(0);
    fireEvent.wheel(list, { deltaY: 100 });
    expect(list.scrollLeft).toBe(100);
    // 触控板横向 deltaX 与纵向 deltaY 叠加
    fireEvent.wheel(list, { deltaX: 40, deltaY: 10 });
    expect(list.scrollLeft).toBe(150);
  });
});
