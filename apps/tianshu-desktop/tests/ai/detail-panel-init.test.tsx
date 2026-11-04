// @vitest-environment jsdom
/**
 * DetailPanel 打开右栏自动初始化产物 tab（spec §3，Task 6 fix round 1
 * 落地计划缺口）：挂载时该会话无 tabs → 自动建单「产物」tab 并激活；
 * sessionId 隔离——另一会话实例挂载只初始化各自一个 tab（互不串）。
 * mock 约定同 tests/ai/detail-tab-bar.test.tsx（t 返回 key、手动 cleanup）
 */
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// t 需稳定引用：DetailPanel 自动初始化 effect 依赖 t，每次渲染新建会
// 在关空 tab 的重渲染后再开一个产物 tab（把「关闭」吞回去）
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", async (importOriginal) => {
  // 部分_mock：DetailPanel 直用 ui/button→@/lib/utils→@/i18n 需要 initReactI18next
  // 等真实导出（同 tests/ai/edit-bar.test.tsx 约定）
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

// ArtifactsTab（拉 react-query/chat.store 重管道）stub 掉，只测外壳初始化
vi.mock(
  "../../src-react/domains/ai/chat/components/artifacts/ArtifactsPanel",
  () => ({
    default: () => null,
    ArtifactsPanelToggle: () => null,
  }),
);

import DetailPanel from "../../src-react/domains/ai/chat/components/detail-panel/DetailPanel";
import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";

afterEach(cleanup);

describe("DetailPanel 打开右栏自动初始化产物 tab", () => {
  it("无 tabs 挂载 → tab 条出现单「产物」tab 且激活", async () => {
    const { container } = render(
      <DetailPanel sessionId={101} workspaceId={1} workspace={null} />,
    );
    const tab = await within(container).findByRole("tab", {
      name: "chat:detailPanel.artifacts",
    });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(within(container).getAllByRole("tab")).toHaveLength(1);
  });

  it("sessionId 隔离：另一会话实例各自只初始化一个 tab", async () => {
    const a = render(
      <DetailPanel sessionId={201} workspaceId={1} workspace={null} />,
    );
    await within(a.container).findByRole("tab", {
      name: "chat:detailPanel.artifacts",
    });
    const b = render(
      <DetailPanel sessionId={202} workspaceId={1} workspace={null} />,
    );
    await within(b.container).findByRole("tab", {
      name: "chat:detailPanel.artifacts",
    });
    // 两个实例同 document，各自作用域内 tab 条只有一个 tab
    expect(within(a.container).getAllByRole("tab")).toHaveLength(1);
    expect(within(b.container).getAllByRole("tab")).toHaveLength(1);
    // store 侧：两会话记录各自单 tab
    expect(useDetailPanelStore.getStateOf(201).tabs).toHaveLength(1);
    expect(useDetailPanelStore.getStateOf(202).tabs).toHaveLength(1);
  });

  it("W 快捷键：长按连发（e.repeat）不关 tab，单发关闭当前", async () => {
    const { container } = render(
      <DetailPanel sessionId={301} workspaceId={1} workspace={null} />,
    );
    await within(container).findByRole("tab", {
      name: "chat:detailPanel.artifacts",
    });
    fireEvent.keyDown(window, { key: "w", repeat: true });
    fireEvent.keyDown(window, { key: "w", repeat: true });
    expect(within(container).getAllByRole("tab")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "w" });
    await waitFor(() => {
      expect(within(container).queryAllByRole("tab")).toHaveLength(0);
    });
  });
});
