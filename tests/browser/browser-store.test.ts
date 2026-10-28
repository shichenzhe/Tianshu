// tests/browser/browser-store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserStore } from "../../src-react/domains/ai/browser/store/browser.store";

beforeEach(() => {
  useBrowserStore.setState({ tabs: [], activeTabId: "" });
  useBrowserStore.getState().addTab();
});

describe("browser store", () => {
  it("初始为一个空 url tab（新标签页形态）", () => {
    const { tabs, activeTabId } = useBrowserStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe("");
    expect(activeTabId).toBe(tabs[0].id);
  });

  it("addTab 新增并切 active，返回新 id", () => {
    const id = useBrowserStore.getState().addTab();
    const { tabs, activeTabId } = useBrowserStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.id === id)?.url).toBe("");
    expect(activeTabId).toBe(id);
  });

  it("closeTab 中间 tab 不影响 active", () => {
    const first = useBrowserStore.getState().tabs[0].id;
    useBrowserStore.getState().addTab();
    useBrowserStore.getState().setActive(first);
    useBrowserStore.getState().closeTab(first);
    const { tabs, activeTabId } = useBrowserStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).not.toBe(first);
  });

  it("closeTab 关闭非 active 的 tab，activeTabId 保持", () => {
    const first = useBrowserStore.getState().tabs[0].id;
    useBrowserStore.getState().addTab();
    const { activeTabId } = useBrowserStore.getState(); // active=第二个
    useBrowserStore.getState().closeTab(first); // 关非 active 的第一个
    expect(useBrowserStore.getState().activeTabId).toBe(activeTabId);
  });

  it("closeTab 最后一个 tab 重置为新标签页（新 id）", () => {
    const only = useBrowserStore.getState().tabs[0].id;
    useBrowserStore.getState().closeTab(only);
    const { tabs } = useBrowserStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).not.toBe(only);
    expect(tabs[0].url).toBe("");
  });

  it("syncTab 部分更新指定 tab", () => {
    const id = useBrowserStore.getState().tabs[0].id;
    useBrowserStore
      .getState()
      .syncTab(id, { url: "https://example.com", title: "Example" });
    const tab = useBrowserStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.url).toBe("https://example.com");
    expect(tab.title).toBe("Example");
    expect(tab.isLoading).toBe(false); // 未触碰字段保持默认
  });
});

describe("addTab(url) 站内新页签", () => {
  it("带初始 url 的 tab 直接进入加载形态", () => {
    useBrowserStore.setState({ tabs: [], activeTabId: "" });
    const id = useBrowserStore.getState().addTab("https://example.com/x");
    const tab = useBrowserStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.url).toBe("https://example.com/x");
    expect(useBrowserStore.getState().activeTabId).toBe(id);
  });
});
