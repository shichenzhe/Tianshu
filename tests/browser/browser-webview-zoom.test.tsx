// @vitest-environment jsdom
/**
 * BrowserWebview 缩放链路：zoomFactor 为 tab 权威值——
 * - zoomFactor prop 变化 → 立即 setZoomFactor；
 * - dom-ready → 重放当前缩放（跨域导航 Chromium 按域重置后恢复）；
 * - guest 未就绪（挂载即变/重放抛错）静默，不炸组件。
 * jsdom 无 webview 元素：createElement 桩注入 setZoomFactor 假体（照
 * browser-webview-nav.test.tsx 先例）。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import BrowserWebview from "@/domains/ai/browser/components/BrowserWebview";
import type { BrowserTab } from "@/domains/ai/browser/store/browser.store";

interface WebviewStub extends HTMLElement {
  setZoomFactor: ReturnType<typeof vi.fn>;
}

let created: WebviewStub[] = [];
let originalCreate: typeof document.createElement;

beforeEach(() => {
  created = [];
  originalCreate = document.createElement.bind(document);
  document.createElement = ((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const el = originalCreate(tagName, options);
    if (tagName.toLowerCase() === "webview") {
      const stub = el as WebviewStub;
      stub.setZoomFactor = vi.fn();
      created.push(stub);
    }
    return el;
  }) as typeof document.createElement;
});

afterEach(() => {
  document.createElement = originalCreate;
});

function makeTab(url: string, zoomFactor?: number): BrowserTab {
  return {
    id: "tab-1",
    url,
    title: "",
    favicon: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    zoomFactor,
  };
}

function mount(tab: BrowserTab) {
  return render(
    <BrowserWebview
      tab={tab}
      isActive
      registerRef={vi.fn()}
      onSync={vi.fn()}
    />,
  );
}

/** 模拟页面加载完成（Electron dom-ready DOM 事件） */
function emitDomReady() {
  created[0].dispatchEvent(new CustomEvent("dom-ready"));
}

describe("BrowserWebview 缩放", () => {
  it("zoomFactor prop 变化 → setZoomFactor 即时应用", () => {
    const view = mount(makeTab("https://example.com/"));
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://example.com/", 1.5)}
        isActive
        registerRef={vi.fn()}
        onSync={vi.fn()}
      />,
    );
    expect(created[0].setZoomFactor).toHaveBeenCalledWith(1.5);
  });

  it("dom-ready 重放当前缩放（跨域导航被 Chromium 重置后恢复）", () => {
    const view = mount(makeTab("https://example.com/"));
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://example.com/", 0.8)}
        isActive
        registerRef={vi.fn()}
        onSync={vi.fn()}
      />,
    );
    created[0].setZoomFactor.mockClear();
    emitDomReady();
    expect(created[0].setZoomFactor).toHaveBeenCalledWith(0.8);
  });

  it("guest 未就绪（setZoomFactor 抛错）静默不炸组件", () => {
    const view = mount(makeTab("https://example.com/"));
    created[0].setZoomFactor.mockImplementation(() => {
      throw new Error("The WebView must be attached to the DOM");
    });
    expect(() =>
      view.rerender(
        <BrowserWebview
          tab={makeTab("https://example.com/", 1.2)}
          isActive
          registerRef={vi.fn()}
          onSync={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });
});
