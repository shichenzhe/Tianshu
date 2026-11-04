// @vitest-environment jsdom
/**
 * 「+」新标签页占位 tab（WorkBuddy 对齐）：点 + / 按 T 直接开 kind=newTab
 * 占位 tab 并激活；内容页 NewTabPagePanel 渲染垂直选项列表，点选项将本
 * 占位 tab 原位替换（replaceTab：位置保序、换 id/kind、负载清空）为所选
 * 类型并激活；关闭占位 tab = 取消。mock 约定同 tests/ai/detail-panel-init
 * .test.tsx（t 返回 key、部分 mock i18n、ArtifactsTab/TerminalTab stub）
 */
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// t 需稳定引用：DetailPanel 自动初始化 effect 依赖 t（同 init.test 约定）
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", async (importOriginal) => {
  // 部分_mock：ui/button（DetailPanel 直用）→@/lib/utils→@/i18n 需要
  // initReactI18next 等真实导出（同 tests/ai/edit-bar.test.tsx 约定）
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

// ArtifactsTab（拉 react-query/chat.store 重管道）stub 掉，只测外壳交互
vi.mock(
  "../../src-react/domains/ai/chat/components/artifacts/ArtifactsPanel",
  () => ({
    default: () => null,
    ArtifactsPanelToggle: () => null,
  }),
);

// TerminalTab（xterm 实例 + terminal:* ipc）stub 掉，以 testid 断言挂载
vi.mock(
  "../../src-react/domains/ai/chat/components/detail-panel/TerminalTab",
  () => ({
    default: () => <div data-testid="terminal-stub" />,
  }),
);

import DetailPanel from "../../src-react/domains/ai/chat/components/detail-panel/DetailPanel";
import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";

const SID = 501;

beforeEach(() => {
  useDetailPanelStore.setState({ panels: {} });
});

afterEach(cleanup);

const openPanel = async () => {
  const r = render(
    <DetailPanel sessionId={SID} workspaceId={1} workspace={null} />,
  );
  await within(r.container).findByRole("tab", {
    name: "chat:detailPanel.artifacts",
  });
  return r;
};

const clickPlus = (container: HTMLElement) => {
  fireEvent.click(
    within(container).getByRole("button", { name: "chat:detailPanel.newTab" }),
  );
};

describe("「+」新标签页占位 tab", () => {
  it("点 + 开「新标签页」占位 tab 并激活；选项列表渲染五项", async () => {
    const { container } = await openPanel();
    clickPlus(container);
    const newTab = await within(container).findByRole("tab", {
      name: "chat:detailPanel.newTab",
    });
    expect(newTab.getAttribute("aria-selected")).toBe("true");
    // store 侧：占位 tab kind=newTab 追加在产物 tab 后
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({
      kind: "newTab",
      title: "chat:detailPanel.newTab",
    });
    // 内容页选项列表（复用 open* 词条 key）
    for (const key of [
      "openArtifacts",
      "openBrowser",
      "openWorkspaceFiles",
      "openTerminal",
      "openChanges",
    ]) {
      expect(
        within(container).getByRole("button", {
          name: `chat:detailPanel.${key}`,
        }),
      ).toBeTruthy();
    }
  });

  it("点「打开终端」选项 → 占位 tab 原位替换为终端 kind 并激活", async () => {
    const { container } = await openPanel();
    clickPlus(container);
    const placeholderId = useDetailPanelStore.getStateOf(SID).tabs[1].id;
    fireEvent.click(
      within(container).getByRole("button", {
        name: "chat:detailPanel.openTerminal",
      }),
    );
    // 原位：tab 总数不变、位置不变（第 2 个），id 已换、kind=terminal
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1].id).not.toBe(placeholderId);
    expect(state.tabs[1]).toMatchObject({
      kind: "terminal",
      title: "chat:detailPanel.terminal",
    });
    expect(state.activeTabId).toBe(state.tabs[1].id);
    // UI 侧：第 2 个 tab 显示终端标题且激活；TerminalTab 挂载
    const tabs = within(container).getAllByRole("tab");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-label")).toBe(
      "chat:detailPanel.terminal",
    );
    // 仓库无 jest-dom：以 querySelector 原生断言挂载
    expect(
      container.querySelector("[data-testid='terminal-stub']"),
    ).not.toBeNull();
    // 替换后选项列表不再渲染（newTab 页已被替换）
    expect(
      within(container).queryByRole("button", {
        name: "chat:detailPanel.openTerminal",
      }),
    ).toBeNull();
  });

  it("终端替换后再点 + 开第二个新标签页占位 tab", async () => {
    const { container } = await openPanel();
    clickPlus(container);
    fireEvent.click(
      within(container).getByRole("button", {
        name: "chat:detailPanel.openBrowser",
      }),
    );
    clickPlus(container);
    await within(container).findAllByRole("tab", {
      name: "chat:detailPanel.newTab",
    });
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs.map((t) => t.kind)).toEqual([
      "artifacts",
      "browser",
      "newTab",
    ]);
    expect(state.activeTabId).toBe(state.tabs[2].id);
    // 新占位页选项列表再现
    expect(
      within(container).getByRole("button", {
        name: "chat:detailPanel.openTerminal",
      }),
    ).toBeTruthy();
  });

  it("T 快捷键开占位 tab；W 关闭占位 tab = 取消（回到产物 tab）", async () => {
    const { container } = await openPanel();
    fireEvent.keyDown(window, { key: "t" });
    await within(container).findByRole("tab", {
      name: "chat:detailPanel.newTab",
    });
    expect(useDetailPanelStore.getStateOf(SID).tabs[1].kind).toBe("newTab");
    fireEvent.keyDown(window, { key: "w" });
    await waitFor(() => {
      expect(
        within(container).queryByRole("tab", {
          name: "chat:detailPanel.newTab",
        }),
      ).toBeNull();
    });
    const state = useDetailPanelStore.getStateOf(SID);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });
});
