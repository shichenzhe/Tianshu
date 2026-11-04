// @vitest-environment jsdom
/**
 * BrowserWebview 导航模型（uncontrolled src）：
 * - 挂载：src 属性只写一次（首个非空 url），不额外 loadURL；
 * - 页面同步回写（did-navigate → onSync(url) → store url 变化）：不重写
 *   src、不触发导航——受控 src 回写会令 Electron 对属性变化调 loadURL，
 *   中止在途导航（GUEST_VIEW_MANAGER_CALL ERR_ABORTED，2026-10-10 baidu
 *   双重加载实锤）；
 * - 地址栏提交新地址：命令式 loadURL。
 * jsdom 无 webview 元素：createElement 桩注入 loadURL 假体；页面同步经
 * 真实 did-navigate DOM 事件链路模拟（listener → onSync → rerender）。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import BrowserWebview from "@/domains/ai/browser/components/BrowserWebview";
import type { BrowserTab } from "@/domains/ai/browser/store/browser.store";

/** webview 元素假体（loadURL 记录调用） */
interface WebviewStub extends HTMLElement {
  loadURL: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
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
      stub.loadURL = vi.fn(() => Promise.resolve());
      stub.canGoBack = vi.fn(() => false);
      stub.canGoForward = vi.fn(() => false);
      created.push(stub);
    }
    return el;
  }) as typeof document.createElement;
});

afterEach(() => {
  document.createElement = originalCreate;
});

function makeTab(url: string): BrowserTab {
  return {
    id: "tab-1",
    url,
    title: "",
    favicon: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  };
}

function mount(url: string, onSync: ReturnType<typeof vi.fn> = vi.fn()) {
  const view = render(
    <BrowserWebview
      tab={makeTab(url)}
      isActive
      registerRef={vi.fn()}
      onSync={onSync}
    />,
  );
  return { view, onSync };
}

/** 模拟页面导航提交（重定向/页内）：did-navigate DOM 事件（Electron 把
 *  url 直接挂在 event 对象上，非 detail——生产同步链路同此形态） */
function emitDidNavigate(url: string) {
  const event = new CustomEvent("did-navigate");
  Object.defineProperty(event, "url", { value: url });
  created[0].dispatchEvent(event);
}

describe("BrowserWebview 导航模型", () => {
  it("挂载：src 属性写首个非空 url，不调 loadURL（属性即导航）", () => {
    mount("https://baidu.com");
    expect(created).toHaveLength(1);
    expect(created[0].getAttribute("src")).toBe("https://baidu.com");
    expect(created[0].loadURL).not.toHaveBeenCalled();
  });

  it("页面同步回写（重定向后 url 变化）：不重写 src、不触发 loadURL", () => {
    const { view, onSync } = mount("https://baidu.com");
    // 301 落定 www.baidu.com：did-navigate → onSync
    emitDidNavigate("https://www.baidu.com/");
    expect(onSync).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.baidu.com/" }),
    );
    // store url 已更新（重渲染）
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://www.baidu.com/")}
        isActive
        registerRef={vi.fn()}
        onSync={onSync}
      />,
    );
    expect(created[0].getAttribute("src")).toBe("https://baidu.com");
    expect(created[0].loadURL).not.toHaveBeenCalled();
  });

  it("地址栏提交新地址：命令式 loadURL，src 属性保持初值", () => {
    const { view, onSync } = mount("https://baidu.com");
    emitDidNavigate("https://www.baidu.com/");
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://www.baidu.com/")}
        isActive
        registerRef={vi.fn()}
        onSync={onSync}
      />,
    );
    // 地址栏提交 example.org（store url 变化，页面尚在 www.baidu.com）
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://example.org/")}
        isActive
        registerRef={vi.fn()}
        onSync={onSync}
      />,
    );
    expect(created[0].getAttribute("src")).toBe("https://baidu.com");
    expect(created[0].loadURL).toHaveBeenCalledTimes(1);
    expect(created[0].loadURL).toHaveBeenCalledWith("https://example.org/");
  });

  it("回到此前到达过的地址（页面已离开）：仍能命令式导航", () => {
    const { view, onSync } = mount("https://baidu.com");
    emitDidNavigate("https://www.baidu.com/");
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://www.baidu.com/")}
        isActive
        registerRef={vi.fn()}
        onSync={onSync}
      />,
    );
    emitDidNavigate("https://example.org/");
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://example.org/")}
        isActive
        registerRef={vi.fn()}
        onSync={onSync}
      />,
    );
    // 地址栏再回 baidu.com（dispatched=example.org，页面不在 baidu）
    view.rerender(
      <BrowserWebview
        tab={makeTab("https://baidu.com")}
        isActive
        registerRef={vi.fn()}
        onSync={onSync}
      />,
    );
    expect(created[0].loadURL).toHaveBeenCalledTimes(1);
    expect(created[0].loadURL).toHaveBeenCalledWith("https://baidu.com");
  });
});
