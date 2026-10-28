/**
 * tab 状态机：去重激活不重开 / 关闭邻位激活 / busy 防重入 / 快照序列化
 * 往返（saveStatus 按可编辑性重算）/ 关闭时空会话回收（T26：本窗创建
 * 标记 → lib/session-recycle，mock 隔离 IPC）。纯逻辑 store 测试，无
 * jsdom 需求（同 detail-panel-store.test.ts 形态——本 store 窗口本地
 * 单例，无 sessionId 分层，beforeEach reset 即隔离）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recycleMock = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../src-react/domains/ai/file-window/lib/session-recycle",
  () => ({
    recycleIfEmpty: recycleMock,
  }),
);

import {
  dedupeKeyOf,
  useFileWindowStore,
} from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { libraryContentKindOf } from "../../../src-react/domains/ai/file-window/lib/content-kind";
import {
  restoreTabs,
  serializeTabs,
} from "../../../src-react/domains/ai/file-window/lib/tab-snapshot";

const wsRes = (path: string) =>
  ({ kind: "workspace", workspaceId: 7, path }) as const;

beforeEach(() => {
  useFileWindowStore.getState().reset();
  recycleMock.mockReset();
});

describe("去重键", () => {
  it("workspace 按空间+路径归一；library 按条目", () => {
    expect(
      dedupeKeyOf({ kind: "workspace", workspaceId: 7, path: "a.md" }),
    ).toBe("w:7:a.md");
    expect(dedupeKeyOf({ kind: "library", itemId: 3 })).toBe("l:3");
  });

  it("路径归一（T28 spec §16 项 3）：./ 前缀与重复分隔符收敛；../ 语义不动", () => {
    expect(
      dedupeKeyOf({ kind: "workspace", workspaceId: 7, path: "./a.md" }),
    ).toBe("w:7:a.md");
    expect(
      dedupeKeyOf({ kind: "workspace", workspaceId: 7, path: "././a.md" }),
    ).toBe("w:7:a.md");
    expect(
      dedupeKeyOf({ kind: "workspace", workspaceId: 7, path: "a//b.md" }),
    ).toBe("w:7:a/b.md");
    // ../ 不归一（越界语义归后端沙箱判定，键保持原样）
    expect(
      dedupeKeyOf({ kind: "workspace", workspaceId: 7, path: "../a.md" }),
    ).toBe("w:7:../a.md");
  });
});

describe("openTab/closeTab", () => {
  it("同资源重复打开激活既有 tab", () => {
    const s = useFileWindowStore.getState();
    const first = s.openTab(wsRes("a.md"));
    const second = s.openTab(wsRes("a.md"));
    expect(second.tabId).toBe(first.tabId);
    expect(second.created).toBe(false);
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
  });

  it("路径归一同资源收敛同 tab：./a.md 与 a.md 不重复开", () => {
    const s = useFileWindowStore.getState();
    const first = s.openTab(wsRes("a.md"));
    const second = s.openTab(wsRes("./a.md"));
    expect(second.tabId).toBe(first.tabId);
    expect(second.created).toBe(false);
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
  });

  it("openTab 命中既有 tab：resource.sessionId 非空且不同 → 覆盖（移窗接管）", () => {
    const s = useFileWindowStore.getState();
    const { tabId } = s.openTab(wsRes("a.md"));
    useFileWindowStore.getState().patchTab(tabId, { sessionId: 42 });
    // 移窗投递：同资源（归一形态不同）携带新会话 id
    s.openTab({ ...wsRes("./a.md"), sessionId: 99 });
    const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.sessionId).toBe(99);
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
  });

  it("openTab 命中：resource 不带 sessionId → 保留现值不覆盖；相同幂等", () => {
    const s = useFileWindowStore.getState();
    const { tabId } = s.openTab(wsRes("a.md"));
    useFileWindowStore.getState().patchTab(tabId, { sessionId: 42 });
    s.openTab(wsRes("a.md"));
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId)?.sessionId,
    ).toBe(42);
    s.openTab({ ...wsRes("a.md"), sessionId: 42 });
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId)?.sessionId,
    ).toBe(42);
  });

  it("关闭激活 tab 后邻位补位；关空清空", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab(wsRes("a.md")).tabId;
    const b = s.openTab(wsRes("b.md")).tabId;
    s.activate(b);
    s.closeTab(b);
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
    s.closeTab(a);
    expect(useFileWindowStore.getState().tabs).toHaveLength(0);
  });

  it("patchTab 局部更新（dirty/saveStatus/sessionId）", () => {
    const s = useFileWindowStore.getState();
    const id = s.openTab(wsRes("a.md")).tabId;
    s.patchTab(id, { dirty: true, saveStatus: "unsaved" });
    const tab = useFileWindowStore.getState().tabs[0];
    expect(tab.dirty).toBe(true);
    expect(tab.saveStatus).toBe("unsaved");
  });

  it("关中间右侧补位、关尾左侧补位、关首右侧补位；关非激活不动", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab(wsRes("a.md")).tabId;
    const b = s.openTab(wsRes("b.md")).tabId;
    const c = s.openTab(wsRes("c.md")).tabId;
    s.activate(b);
    s.closeTab(b); // 关中间：右侧 c 补位
    expect(useFileWindowStore.getState().activeTabId).toBe(c);
    s.closeTab(c); // 关尾（激活中）：左侧 a 补位
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
    const d = s.openTab(wsRes("d.md")).tabId;
    s.activate(a);
    s.closeTab(d); // 关非激活（当前激活 a）：激活不动
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
    s.closeTab(a); // 关首（激活中）：右侧补位——仅剩自身，关空落 ""
    expect(useFileWindowStore.getState().activeTabId).toBe("");
  });

  it("关首（激活中）多 tab 下右侧补位", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab(wsRes("a.md")).tabId;
    const b = s.openTab(wsRes("b.md")).tabId;
    s.activate(a);
    s.closeTab(a);
    expect(useFileWindowStore.getState().activeTabId).toBe(b);
  });

  it("关闭后重开同资源：created 且新 id（nextId 单调不复用）", () => {
    const s = useFileWindowStore.getState();
    const first = s.openTab(wsRes("a.md")).tabId;
    s.closeTab(first);
    const again = s.openTab(wsRes("a.md"));
    expect(again.created).toBe(true);
    expect(again.tabId).not.toBe(first);
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
  });

  it("resource.sessionId 上提为 tab.sessionId 并从 resource 剥离", () => {
    const s = useFileWindowStore.getState();
    const { tabId } = s.openTab({ ...wsRes("a.md"), sessionId: 42 });
    const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.sessionId).toBe(42);
    expect(tab?.resource).toEqual(wsRes("a.md"));
  });

  it("patchTab busy 防重入标记", () => {
    const s = useFileWindowStore.getState();
    const { tabId } = s.openTab(wsRes("a.md"));
    s.patchTab(tabId, { busy: "closing" });
    expect(useFileWindowStore.getState().tabs[0].busy).toBe("closing");
  });

  it("reset 清空 tabs/激活并归零计数与 restored", () => {
    const s = useFileWindowStore.getState();
    s.openTab(wsRes("a.md"));
    s.setRestored();
    useFileWindowStore.getState().reset();
    const st = useFileWindowStore.getState();
    expect(st.tabs).toHaveLength(0);
    expect(st.activeTabId).toBe("");
    expect(st.nextId).toBe(1);
    expect(st.restored).toBe(false);
  });
});

describe("reorderTabs", () => {
  it("reorderTabs 落点=目标原位（DetailTabBar onDrop 契约），未知 id no-op", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab(wsRes("a.md")).tabId;
    const b = s.openTab(wsRes("b.md")).tabId;
    const c = s.openTab(wsRes("c.md")).tabId;
    const ids = () => useFileWindowStore.getState().tabs.map((t) => t.id);
    s.reorderTabs(a, c); // 右拖 a 到 c 上：a 落目标原位，c 顺移
    expect(ids()).toEqual([b, a, c]);
    s.reorderTabs(c, b); // 左拖 c 到 b 上：直接插目标位
    expect(ids()).toEqual([c, b, a]);
    s.reorderTabs(a, "nope");
    expect(ids()).toEqual([c, b, a]);
  });
});

describe("contentKind/saveStatus 派生", () => {
  it("library：text 占位可编辑基线（Task 14 由 libraryContentKindOf 细化）", () => {
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "library", itemId: 3 });
    const tab = useFileWindowStore.getState().tabs[0];
    expect(tab.contentKind).toBe("text");
    expect(tab.saveStatus).toBe("saved");
    expect(tab.aiPanelOpen).toBe(true);
  });

  it("只读扩展名（image/pdf）saveStatus=hidden；标题按资源派生", () => {
    const s = useFileWindowStore.getState();
    s.openTab(wsRes("docs/p.png"));
    s.openTab(wsRes("q.pdf"));
    s.openTab({ kind: "library", itemId: 5 });
    const st = useFileWindowStore.getState();
    expect(st.tabs[0].contentKind).toBe("image");
    expect(st.tabs[0].saveStatus).toBe("hidden");
    expect(st.tabs[0].title).toBe("p.png"); // workspace 取 basename
    expect(st.tabs[1].contentKind).toBe("pdf");
    expect(st.tabs[2].title).toBe("#5"); // library 先 #itemId 占位
  });

  it("未收录图片格式（.bmp/.ico）对齐 chat 口径归 text（终审 I3：IMAGE_EXT 删 bmp/ico）", () => {
    const s = useFileWindowStore.getState();
    const bmp = s.openTab(wsRes("x.bmp")).tabId;
    const ico = s.openTab(wsRes("y.ico")).tabId;
    const st = useFileWindowStore.getState();
    const bmpTab = st.tabs.find((t) => t.id === bmp);
    const icoTab = st.tabs.find((t) => t.id === ico);
    expect(bmpTab?.contentKind).toBe("text");
    expect(icoTab?.contentKind).toBe("text");
    // text 可编辑基线（非 image 的 hidden 只读）
    expect(bmpTab?.saveStatus).toBe("saved");
    expect(bmpTab?.aiPanelOpen).toBe(true);
  });
});

describe("libraryContentKindOf（Task 14 消费）", () => {
  it("按 fileType/mimeType 映射，未知/null 归 text", () => {
    expect(libraryContentKindOf("text/markdown")).toBe("md");
    expect(libraryContentKindOf("text/csv")).toBe("csv");
    expect(libraryContentKindOf("image/png")).toBe("image");
    expect(libraryContentKindOf("application/pdf")).toBe("pdf");
    expect(libraryContentKindOf("text/html")).toBe("html");
    expect(libraryContentKindOf("audio/mpeg")).toBe("audiovideo");
    expect(libraryContentKindOf("video/mp4")).toBe("audiovideo");
    expect(libraryContentKindOf(null)).toBe("text");
  });
});

describe("快照序列化", () => {
  it("serialize→restore 往返保留 resource/sessionId/dirty", () => {
    const s = useFileWindowStore.getState();
    // openTab 返回 {tabId, created}——brief 原稿漏 .tabId，patch 打到对象上静默失效
    const id = s.openTab({ ...wsRes("a.md"), sessionId: 42 }).tabId;
    useFileWindowStore.getState().patchTab(id, { dirty: true });
    const snap = serializeTabs(useFileWindowStore.getState().tabs);
    const restored = restoreTabs(snap);
    expect(restored[0].resource).toEqual(wsRes("a.md"));
    expect(restored[0].sessionId).toBe(42);
    expect(restored[0].dirty).toBe(true);
  });

  it("sessionCreatedHere 瞬态不入快照（T26，spec §15 项 2）：白名单排除钉住", () => {
    const s = useFileWindowStore.getState();
    const id = s.openTab(wsRes("a.md")).tabId;
    useFileWindowStore
      .getState()
      .patchTab(id, { sessionId: 42, sessionCreatedHere: true });
    const snap = serializeTabs(useFileWindowStore.getState().tabs);
    // 白名单序列化：字段集不含 sessionCreatedHere（跨窗恢复不带本窗标记）
    expect(Object.keys(snap[0])).not.toContain("sessionCreatedHere");
    expect(restoreTabs(snap)[0].sessionCreatedHere).toBeUndefined();
  });

  it("inputDraft 瞬态不入快照（T28 spec §16 项 5）：切窗/重启不搬运草稿", () => {
    const s = useFileWindowStore.getState();
    const id = s.openTab(wsRes("a.md")).tabId;
    useFileWindowStore.getState().patchTab(id, { inputDraft: "未发草稿" });
    const snap = serializeTabs(useFileWindowStore.getState().tabs);
    expect(Object.keys(snap[0])).not.toContain("inputDraft");
    expect(JSON.stringify(snap)).not.toContain("未发草稿");
    expect(restoreTabs(snap)[0].inputDraft).toBeUndefined();
  });

  it("restore 重建 id/清运行态，saveStatus 按可编辑性重算", () => {
    const restored = restoreTabs([
      {
        resource: wsRes("b.md"),
        title: "b.md",
        contentKind: "md",
        dirty: false,
        aiPanelOpen: true,
      },
      {
        resource: wsRes("p.png"),
        title: "p.png",
        contentKind: "image",
        dirty: true, // 畸形快照：只读类不得给出保存态
        aiPanelOpen: false,
      },
    ]);
    expect(restored[0].id).toBe("fw-tab-1");
    expect(restored[0].saveStatus).toBe("saved");
    expect(restored[1].id).toBe("fw-tab-2");
    expect(restored[1].saveStatus).toBe("hidden");
    expect(restored[1].busy).toBeNull();
    expect(restored[1].baselineMtime).toBeNull();
    expect(restored[1].aiPanelOpen).toBe(false);
  });
});

describe("关闭空会话回收（T26，spec §15 项 2）", () => {
  /** 开 tab 并按需标记本窗创建 + 会话绑定 */
  function openTab(opts: {
    sessionId?: number;
    createdHere?: boolean;
    busy?: null | "closing" | "moving";
  }) {
    const s = useFileWindowStore.getState();
    const { tabId } = s.openTab(wsRes("a.md"));
    if (opts.sessionId !== undefined || opts.createdHere !== undefined) {
      s.patchTab(tabId, {
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.createdHere ? { sessionCreatedHere: true } : {}),
      });
    }
    if (opts.busy) s.patchTab(tabId, { busy: opts.busy });
    return tabId;
  }

  it("本窗创建且有会话：closeTab fire-and-forget 回收", () => {
    const tabId = openTab({ sessionId: 42, createdHere: true });
    useFileWindowStore.getState().closeTab(tabId);
    expect(recycleMock).toHaveBeenCalledWith(42);
  });

  it("非本窗创建（seed/移窗带入）：不回收", () => {
    const tabId = openTab({ sessionId: 42 });
    useFileWindowStore.getState().closeTab(tabId);
    expect(recycleMock).not.toHaveBeenCalled();
  });

  it("无会话绑定：不回收", () => {
    const tabId = openTab({ createdHere: true });
    useFileWindowStore.getState().closeTab(tabId);
    expect(recycleMock).not.toHaveBeenCalled();
  });

  it("移窗接管（busy=moving）：会话随 resource 迁往新窗，禁止删", () => {
    const tabId = openTab({ sessionId: 42, createdHere: true, busy: "moving" });
    useFileWindowStore.getState().closeTab(tabId);
    expect(recycleMock).not.toHaveBeenCalled();
  });
});
