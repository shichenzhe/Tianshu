// @vitest-environment jsdom
/**
 * BrowserPanelTab：工具栏常驻形态回归（WorkBuddy 实态纠正）——tab 内容
 * = BrowserToolbar（地址栏/返回/前进/刷新）+ BrowserWebview；url 空 →
 * 页面区空白占位（居中输入页 NewTabPage 已删，地址栏即输入口）且地址栏
 * 自动聚焦（autoFocusAddress=isActive，隐藏 tab 不抢焦点）。i18n 经传递
 * 依赖已初始化（zh-CN），据真实文案断言工具栏元素。另含面板
 * 联动复用路径回归——store 负载 url 被联动桥（use-detail-panel-bridge）
 * 外部改写时，本地 browserTab 须吸收新值（BrowserWebview 以 url prop 变化
 * 派发 loadURL）。W5 冒烟实锤：不吸收则 browse 复用既有浏览器 tab
 * 只改 store 不导航。mock BrowserWebview（隔离其派发内部，由 tests/browser
 * 覆盖）只断言 url 传导；DetailPanel 侧以 store 重取 tab 重渲染模拟。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webviewUrls: string[] = [];
let lastUrl = "";
// 只记录 url 变化的渲染（对齐 BrowserWebview 的 dispatched 守卫语义：
// effect 仅在 url prop 变化时派发 loadURL，同值重渲染不派发）
vi.mock("@/domains/ai/browser/components/BrowserWebview", () => ({
  default: (props: { tab: { url: string } }) => {
    if (props.tab.url !== lastUrl) {
      lastUrl = props.tab.url;
      webviewUrls.push(props.tab.url);
    }
    return null;
  },
}));

import BrowserPanelTab from "../../src-react/domains/ai/chat/components/detail-panel/BrowserPanelTab";
import {
  useDetailPanelStore,
  type DetailTab,
} from "../../src-react/domains/ai/chat/store/detail-panel.store";

const S1 = 301;

function seedBrowserTab(url?: string): DetailTab {
  const { openTab, syncTab } = useDetailPanelStore.getState();
  const id = openTab(S1, "browser", "浏览器");
  if (url) syncTab(S1, id, { url });
  return useDetailPanelStore.getStateOf(S1).tabs.find((t) => t.id === id)!;
}

/** 模拟 DetailPanel 订阅 store 重渲染：每次以 store 当前 tab 对象渲染 */
const tabNow = (id: string): DetailTab =>
  useDetailPanelStore.getStateOf(S1).tabs.find((t) => t.id === id)!;

beforeEach(() => {
  useDetailPanelStore.setState({ panels: {} });
  webviewUrls.length = 0;
  lastUrl = "";
});

afterEach(cleanup);

describe("BrowserPanelTab 工具栏常驻（WorkBuddy 实态纠正回归）", () => {
  it("渲染地址栏与返回/前进/刷新按钮（6fc7211 误删工具栏回归）", () => {
    const tab = seedBrowserTab("https://example.com/a");
    render(<BrowserPanelTab sessionId={S1} tab={tab} isActive={true} />);
    expect(screen.getByPlaceholderText("输入网址")).toBeTruthy();
    expect(screen.getByRole("button", { name: "后退" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "前进" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });

  it("url 空：地址栏自动聚焦可直接输入（打开浏览器 tab 即输入口）", () => {
    const tab = seedBrowserTab();
    render(<BrowserPanelTab sessionId={S1} tab={tab} isActive={true} />);
    expect(screen.getByPlaceholderText("输入网址")).toBe(
      document.activeElement,
    );
  });

  it("url 空：非 active（display 隐藏）挂载不抢焦点", () => {
    const tab = seedBrowserTab();
    render(<BrowserPanelTab sessionId={S1} tab={tab} isActive={false} />);
    expect(screen.getByPlaceholderText("输入网址")).not.toBe(
      document.activeElement,
    );
  });

  it("url 空：页面区空白占位，无居中输入框（NewTabPage 已删）", async () => {
    // BrowserWebview 被文件级 mock（url 传导隔离），空态形态以真身直验：
    // 居中提示（参照 WorkBuddy）——无输入框、有提示文案、不挂 webview
    const actual = await vi.importActual<
      typeof import("@/domains/ai/browser/components/BrowserWebview")
    >("@/domains/ai/browser/components/BrowserWebview");
    const tab = seedBrowserTab();
    const { container } = render(
      <actual.default
        tab={{
          id: tab.id,
          url: "",
          title: "",
          favicon: "",
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        }}
        isActive={true}
        registerRef={vi.fn()}
        onSync={vi.fn()}
      />,
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("在上方地址栏输入网址");
    expect(container.querySelector("webview")).toBeNull();
  });
});

describe("BrowserPanelTab url 吸收（browse 复用回归）", () => {
  it("挂载取初值；联动桥外部改写 store url → webview 收到新 url", () => {
    const tab = seedBrowserTab("https://example.com/a");
    const { rerender } = render(
      <BrowserPanelTab sessionId={S1} tab={tab} isActive={true} />,
    );
    expect(webviewUrls.at(-1)).toBe("https://example.com/a");

    // 联动桥复用路径：syncTab 改写负载 + DetailPanel 重渲染下发新 tab
    act(() =>
      useDetailPanelStore
        .getState()
        .syncTab(S1, tab.id, { url: "https://www.iana.org" }),
    );
    rerender(
      <BrowserPanelTab sessionId={S1} tab={tabNow(tab.id)} isActive={true} />,
    );
    expect(webviewUrls.at(-1)).toBe("https://www.iana.org");
  });

  it("同值重渲染不重复派发（did-navigate 回写路径无环）", () => {
    const tab = seedBrowserTab("https://example.com/a");
    const { rerender } = render(
      <BrowserPanelTab sessionId={S1} tab={tab} isActive={true} />,
    );
    const before = webviewUrls.length;
    rerender(
      <BrowserPanelTab sessionId={S1} tab={tabNow(tab.id)} isActive={true} />,
    );
    expect(webviewUrls.length).toBe(before);
  });
});
