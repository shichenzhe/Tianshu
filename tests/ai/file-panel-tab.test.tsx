// @vitest-environment jsdom
/**
 * file tab（WorkBuddy 对齐，内嵌预览形态移除）：FilePanelTab 单元
 *（FilePreview stub 收 filePath、无返回按钮）+ DetailPanel 集成——
 * 工作空间树点文件开独立 kind="file" tab（标题= basename、FilePreview
 * 渲染该路径）、同路径复用激活不重开、关闭卸载。
 * mock 约定同 tests/ai/detail-panel-newtab.test.tsx（t 返回 key、部分
 * mock i18n、ArtifactsTab stub）+ WorkspaceApi/FilePreview stub。
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// t 需稳定引用：DetailPanel 自动初始化 effect 依赖 t（同 init.test 约定）
const t = vi.hoisted(() => (key: string) => key);
const api = vi.hoisted(() => ({ listDir: vi.fn() }));
vi.mock("react-i18next", async (importOriginal) => {
  // 部分_mock：ui/button（DetailPanel 直用）→@/lib/utils→@/i18n 需要
  // initReactI18next 等真实导出（同 tests/ai/edit-bar.test.tsx 约定）
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

// ArtifactsTab（拉 react-query/chat.store 重管道）stub 掉，只测外壳联动
vi.mock(
  "../../src-react/domains/ai/chat/components/artifacts/ArtifactsPanel",
  () => ({
    default: () => null,
    ArtifactsPanelToggle: () => null,
  }),
);

// FilePreview stub：路径/返回按钮有无/「在新窗口打开」回调透出（重管道不入本测）
vi.mock(
  "../../src-react/domains/ai/chat/components/artifacts/FilePreview",
  () => ({
    default: ({
      file,
      onBack,
      onOpenInNewWindow,
    }: {
      file: { path: string };
      onBack?: () => void;
      onOpenInNewWindow?: () => void;
    }) => (
      <div>
        <span data-testid="fp-path">{file.path}</span>
        <span data-testid="fp-has-back">{onBack ? "true" : "false"}</span>
        {onOpenInNewWindow && (
          <button data-testid="fp-open-new" onClick={onOpenInNewWindow}>
            open
          </button>
        )}
      </div>
    ),
  }),
);

vi.mock("../../src-react/domains/ai/api/workspace.api", () => ({
  default: api,
  WorkspaceApi: api,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../src-react/domains/ai/chat/lib/error-message", () => ({
  mapIpcError: (e: unknown) => String(e),
}));

import DetailPanel from "../../src-react/domains/ai/chat/components/detail-panel/DetailPanel";
import FilePanelTab from "../../src-react/domains/ai/chat/components/detail-panel/FilePanelTab";
import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";
import type {
  DirEntry,
  WorkspaceRecord,
} from "../../src-react/domains/ai/api/workspace.api";

const WS = { id: 1, name: "ws", directoryPath: "/ws" } as WorkspaceRecord;
const SID = 601;

beforeEach(() => {
  useDetailPanelStore.setState({ panels: {} });
  api.listDir.mockReset();
  api.listDir.mockResolvedValue([
    { name: "a.ts", isDir: false } as DirEntry,
    { name: "docs", isDir: true } as DirEntry,
  ]);
});

afterEach(cleanup);

describe("FilePanelTab 单元", () => {
  it("FilePreview 渲染 filePath、无返回按钮（tab 形态无返回语义）", () => {
    render(
      <FilePanelTab
        workspaceId={1}
        filePath="docs/a.ts"
        sessionId={SID}
        tabId="t-x"
      />,
    );
    expect(screen.getByTestId("fp-path").textContent).toBe("docs/a.ts");
    expect(screen.getByTestId("fp-has-back").textContent).toBe("false");
  });

  it("「在新窗口打开」回调 → 关主窗 file tab（移动语义，store 直读）", () => {
    useDetailPanelStore.setState({ panels: {} });
    const tabId = useDetailPanelStore.getState().openTab(SID, "file", "a.ts");
    render(
      <FilePanelTab
        workspaceId={1}
        filePath="a.ts"
        sessionId={SID}
        tabId={tabId}
      />,
    );
    fireEvent.click(screen.getByTestId("fp-open-new"));
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs.map((t) => t.id)).not.toContain(tabId);
  });
});

describe("DetailPanel 打开文件独立 file tab", () => {
  /** 渲染面板并开工作空间 tab（树即挂载，文件可点） */
  const openPanelWithTree = async () => {
    const r = render(
      <DetailPanel sessionId={SID} workspaceId={1} workspace={WS} />,
    );
    await within(r.container).findByRole("tab", {
      name: "chat:detailPanel.artifacts",
    });
    useDetailPanelStore
      .getState()
      .openTab(SID, "workspace", "chat:detailPanel.workspace");
    await within(r.container).findByRole("tab", {
      name: "chat:detailPanel.workspace",
    });
    return r;
  };

  it("树点文件 → 新 kind=file tab（标题 basename、激活、FilePreview 渲染）", async () => {
    const { container } = await openPanelWithTree();
    // 树内文件行是 button（file tab 是 role=tab、预览 stub 是 span，不串）；
    // 根目录异步加载，首点用 findByRole 等挂载
    fireEvent.click(
      await within(container).findByRole("button", { name: "a.ts" }),
    );
    const fileTab = await within(container).findByRole("tab", {
      name: "a.ts",
    });
    expect(fileTab.getAttribute("aria-selected")).toBe("true");
    // 产物 + 工作空间 + file 三个 tab；file 为末位（标题 basename、负载全路径）
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs).toHaveLength(3);
    expect(state.tabs[2]).toMatchObject({
      kind: "file",
      title: "a.ts",
      filePath: "a.ts",
    });
    expect(within(container).getByTestId("fp-path").textContent).toBe("a.ts");
  });

  it("同路径再点：不重开，激活既有 file tab（切走再点回也复用）", async () => {
    const { container } = await openPanelWithTree();
    fireEvent.click(
      await within(container).findByRole("button", { name: "a.ts" }),
    );
    await within(container).findByRole("tab", { name: "a.ts" });
    // 切走（点产物 tab）后再回工作空间点同一文件：复用激活、tab 总数不变。
    // 注：非 active tab 容器 display:none，树按钮不可见——点回树所在 tab
    fireEvent.click(
      within(container).getByRole("tab", {
        name: "chat:detailPanel.artifacts",
      }),
    );
    fireEvent.click(
      within(container).getByRole("tab", {
        name: "chat:detailPanel.workspace",
      }),
    );
    fireEvent.click(within(container).getByRole("button", { name: "a.ts" }));
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs).toHaveLength(3);
    const fileTab = within(container).getByRole("tab", { name: "a.ts" });
    expect(fileTab.getAttribute("aria-selected")).toBe("true");
    expect(state.activeTabId).toBe(state.tabs[2].id);
  });

  it("不同路径 → 各开各的 file tab；关闭卸载预览回到相邻 tab", async () => {
    api.listDir.mockImplementation((_wsId: number, rel: string) =>
      rel === ""
        ? Promise.resolve([
            { name: "a.ts", isDir: false } as DirEntry,
            { name: "docs", isDir: true } as DirEntry,
          ])
        : Promise.resolve([{ name: "b.md", isDir: false } as DirEntry]),
    );
    const { container } = await openPanelWithTree();
    // 工作空间 tab active 时先展开嵌套目录（切走后树容器 display:none）
    fireEvent.click(
      await within(container).findByRole("button", { name: /docs/ }),
    );
    fireEvent.click(
      await within(container).findByRole("button", { name: "a.ts" }),
    );
    await within(container).findByRole("tab", { name: "a.ts" });
    // 嵌套文件（点回工作空间 tab 让树可见）：标题仍为 basename、负载带父级前缀
    fireEvent.click(
      within(container).getByRole("tab", {
        name: "chat:detailPanel.workspace",
      }),
    );
    fireEvent.click(within(container).getByRole("button", { name: "b.md" }));
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs).toHaveLength(4);
    expect(state.tabs[3]).toMatchObject({
      kind: "file",
      title: "b.md",
      filePath: "docs/b.md",
    });
    // 关闭 file tab：预览卸载（余 a.ts 一个）、激活回到相邻 file tab
    const fileTab = within(container).getByRole("tab", { name: "b.md" });
    fireEvent.click(
      within(fileTab).getByRole("button", {
        name: "chat:detailPanel.closeTab",
      }),
    );
    await waitFor(() => {
      expect(within(container).queryByRole("tab", { name: "b.md" })).toBeNull();
    });
    expect(container.querySelectorAll("[data-testid='fp-path']")).toHaveLength(
      1,
    );
  });

  it("file tab「在新窗口打开」→ 主窗 tab 关闭（DetailPanel 传 sessionId/tabId 接线）", async () => {
    const { container } = await openPanelWithTree();
    fireEvent.click(
      await within(container).findByRole("button", { name: "a.ts" }),
    );
    const fileTab = await within(container).findByRole("tab", { name: "a.ts" });
    expect(fileTab.getAttribute("aria-selected")).toBe("true");
    const fileTabId = useDetailPanelStore.getStateOf(SID).tabs[2].id;
    // stub 的「在新窗口打开」按钮即 FilePanelTab 透传的移动语义回调：
    // 点击后主窗 file tab 关闭、预览卸载
    fireEvent.click(within(container).getByTestId("fp-open-new"));
    await waitFor(() => {
      expect(within(container).queryByRole("tab", { name: "a.ts" })).toBeNull();
    });
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs.map((t) => t.id)).not.toContain(fileTabId);
    expect(container.querySelectorAll("[data-testid='fp-path']")).toHaveLength(
      0,
    );
  });
});
