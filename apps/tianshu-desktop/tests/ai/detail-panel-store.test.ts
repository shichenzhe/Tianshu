import { beforeEach, describe, expect, it } from "vitest";
import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";

const S1 = 1;
const S2 = 2;

beforeEach(() => {
  // zustand setState 为浅合并，空对象不会清 panels；以空 panels 覆盖实现整表重置
  useDetailPanelStore.setState({ panels: {} });
  useAiUiStore.setState({ artifactsOpen: true });
});

describe("detail-panel store（sessionId 隔离）", () => {
  it("openTab 新建并激活；getStateOf 未初始化返回空态", () => {
    expect(useDetailPanelStore.getStateOf(S1).tabs).toEqual([]);
    const id = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ kind: "artifacts", title: "产物" });
    expect(state.activeTabId).toBe(id);
  });

  it("两个会话互不影响", () => {
    useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().openTab(S2, "browser", "浏览器");
    expect(useDetailPanelStore.getStateOf(S1).tabs).toHaveLength(1);
    expect(useDetailPanelStore.getStateOf(S1).tabs[0].kind).toBe("terminal");
    expect(useDetailPanelStore.getStateOf(S2).tabs[0].kind).toBe("browser");
  });

  it("closeTab 关 active 切相邻；关最后一个联动收起右栏", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().closeTab(S1, b);
    let state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs.map((t) => t.id)).toEqual([a]);
    expect(state.activeTabId).toBe(a);
    useDetailPanelStore.getState().closeTab(S1, a);
    state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toEqual([]);
    expect(useAiUiStore.getState().artifactsOpen).toBe(false);
  });

  it("closeTab 关非 active 不改变 active", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().closeTab(S1, a);
    expect(useDetailPanelStore.getStateOf(S1).activeTabId).toBe(b);
  });

  it("syncTab 回写 url/terminalId 负载", () => {
    const id = useDetailPanelStore.getState().openTab(S1, "browser", "浏览器");
    useDetailPanelStore
      .getState()
      .syncTab(S1, id, { url: "https://example.com" });
    expect(useDetailPanelStore.getStateOf(S1).tabs[0].url).toBe(
      "https://example.com",
    );
  });

  it("file tab：openTab + syncTab 回写 filePath 负载（同路径复用判据）", () => {
    const id = useDetailPanelStore.getState().openTab(S1, "file", "a.ts");
    useDetailPanelStore.getState().syncTab(S1, id, { filePath: "docs/a.ts" });
    expect(useDetailPanelStore.getStateOf(S1).tabs[0]).toMatchObject({
      kind: "file",
      title: "a.ts",
      filePath: "docs/a.ts",
    });
    // 同路径判定走 tabs.find(kind=file && filePath)：命中即复用激活
    const dup = useDetailPanelStore
      .getStateOf(S1)
      .tabs.find((t) => t.kind === "file" && t.filePath === "docs/a.ts");
    expect(dup?.id).toBe(id);
  });

  it("setActive 切换", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().setActive(S1, a);
    expect(useDetailPanelStore.getStateOf(S1).activeTabId).toBe(a);
    expect(b).toBeTruthy();
  });

  it("reorderTab 拖到目标上 = 放到目标位置（目标及其后顺移）：from>to", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    const c = useDetailPanelStore.getState().openTab(S1, "browser", "浏览器");
    useDetailPanelStore.getState().reorderTab(S1, c, b);
    expect(useDetailPanelStore.getStateOf(S1).tabs.map((t) => t.id)).toEqual([
      a,
      c,
      b,
    ]);
    // 相邻自身/to 不存在：no-op
    useDetailPanelStore.getState().reorderTab(S1, c, c);
    useDetailPanelStore.getState().reorderTab(S1, a, "nope");
    expect(useDetailPanelStore.getStateOf(S1).tabs.map((t) => t.id)).toEqual([
      a,
      c,
      b,
    ]);
  });

  it("reorderTab from<to：拖 a 到 c 上得 [b,a,c]（删除后插 to-1）", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    const c = useDetailPanelStore.getState().openTab(S1, "browser", "浏览器");
    useDetailPanelStore.getState().reorderTab(S1, a, c);
    expect(useDetailPanelStore.getStateOf(S1).tabs.map((t) => t.id)).toEqual([
      b,
      a,
      c,
    ]);
  });

  it("reorderTab from>to 跨两位：拖 c 到 a 上得 [c,a,b]", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    const c = useDetailPanelStore.getState().openTab(S1, "browser", "浏览器");
    useDetailPanelStore.getState().reorderTab(S1, c, a);
    expect(useDetailPanelStore.getStateOf(S1).tabs.map((t) => t.id)).toEqual([
      c,
      a,
      b,
    ]);
    expect(b).toBeTruthy();
  });

  it("replaceTab 原位替换：新 id、新 kind/title、清空负载、激活、保序", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "newTab", "新标签页");
    const c = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore
      .getState()
      .syncTab(S1, b, { url: "https://example.com", terminalId: "t-old" });
    // 替换非 active 的占位 tab 也要激活（点选项 = 选定该 tab）
    useDetailPanelStore.getState().setActive(S1, a);
    const newId = useDetailPanelStore
      .getState()
      .replaceTab(S1, b, "browser", "浏览器");
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(b);
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs.map((t) => t.id)).toEqual([a, newId, c]);
    expect(state.tabs[1]).toMatchObject({ kind: "browser", title: "浏览器" });
    expect(state.tabs[1].url).toBeUndefined();
    expect(state.tabs[1].terminalId).toBeUndefined();
    expect(state.activeTabId).toBe(newId);
  });

  it("replaceTab 未知 tabId / 未初始化会话 no-op 返回空串（状态引用不变）", () => {
    useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const before = useDetailPanelStore.getStateOf(S1);
    expect(
      useDetailPanelStore.getState().replaceTab(S1, "nope", "terminal", "终端"),
    ).toBe("");
    expect(
      useDetailPanelStore
        .getState()
        .replaceTab(404, "nope", "terminal", "终端"),
    ).toBe("");
    expect(useDetailPanelStore.getStateOf(S1)).toBe(before);
    expect(useDetailPanelStore.getState().panels[404]).toBeUndefined();
  });
});

describe("detail-panel store（空态与守卫分支）", () => {
  it("getStateOf 未初始化会话返回冻结空态：外部 push/改写抛 TypeError", () => {
    const empty = useDetailPanelStore.getStateOf(999);
    expect(() =>
      empty.tabs.push({
        id: "x",
        kind: "artifacts",
        title: "x",
        createdAt: 0,
      }),
    ).toThrow(TypeError);
    expect(() => {
      (empty as { activeTabId: string }).activeTabId = "hack";
    }).toThrow(TypeError);
    // 冻结不影响正常流转：openTab 在空态上派生新数组追加
    const id = useDetailPanelStore.getState().openTab(999, "artifacts", "产物");
    expect(useDetailPanelStore.getStateOf(999).tabs).toHaveLength(1);
    expect(useDetailPanelStore.getStateOf(999).tabs[0].id).toBe(id);
    // 单例被 freeze 后其余未初始化会话仍拿到干净空态
    expect(useDetailPanelStore.getStateOf(998).tabs).toEqual([]);
  });

  it("closeTab/syncTab 未知 tabId 与未初始化会话 no-op（状态引用不变）", () => {
    useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const before = useDetailPanelStore.getStateOf(S1);
    useDetailPanelStore.getState().closeTab(S1, "nope");
    useDetailPanelStore
      .getState()
      .syncTab(S1, "nope", { url: "https://example.com" });
    useDetailPanelStore.getState().closeTab(404, "nope");
    useDetailPanelStore.getState().syncTab(404, "nope", { terminalId: "t" });
    expect(useDetailPanelStore.getStateOf(S1)).toBe(before);
    expect(useDetailPanelStore.getState().panels[404]).toBeUndefined();
    // 右栏联动不受未知 id 误触发
    expect(useAiUiStore.getState().artifactsOpen).toBe(true);
  });
});
