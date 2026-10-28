// @vitest-environment jsdom
/**
 * DetailPanel 放大/还原（R25）：tab 条尾部按钮切换 ai-ui panelMaximized，
 * 最大化面板本体 fixed inset-0 z-[60] 覆盖全窗，
 * 还原回到 fixed right-0 z-[55] 340px 穿透旁挂（R26：顶到窗口顶盖 TopBar
 * 右段空带）；Esc 退出最大化（与 T/W 守卫链并列，无聚焦守卫）。
 * 外层 wrapper（w-[340px] shrink-0）仅占位保左列挤压，面板本体带
 * data-detail-panel 供锚定（替代旧 firstElementChild 约定——外壳已两层）。
 * mock 约定同 tests/ai/detail-panel-init.test.tsx
 *（t 返回 key、手动 cleanup）
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// t 需稳定引用：DetailPanel effect 依赖 t（同 detail-panel-init 约定）
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

// ArtifactsTab（拉 react-query/chat.store 重管道）stub 掉，只测外壳交互
vi.mock(
  "../../src-react/domains/ai/chat/components/artifacts/ArtifactsPanel",
  () => ({
    default: () => null,
    ArtifactsPanelToggle: () => null,
  }),
);

import DetailPanel from "../../src-react/domains/ai/chat/components/detail-panel/DetailPanel";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";

afterEach(() => {
  cleanup();
  // 内存态归位，防用例间串台（panelMaximized）
  useAiUiStore.setState({ panelMaximized: false });
});

/** 面板本体容器（穿透 fixed z-[55] / 最大化 fixed inset-0 z-[60]）；
    外层尚有挤压占位 wrapper，用 data 属性锚定替代 firstElementChild */
const shellOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-detail-panel]") as HTMLElement;

const openPanel = async () => {
  const r = render(
    <DetailPanel sessionId={401} workspaceId={1} workspace={null} />,
  );
  await within(r.container).findByRole("tab", {
    name: "chat:detailPanel.artifacts",
  });
  return r;
};

describe("DetailPanel 放大/还原", () => {
  it("正常态：wrapper 占位挤压 + 面板本体 fixed 穿透顶到窗口顶", async () => {
    const { container } = await openPanel();
    // wrapper（firstElementChild）保挤压占位；面板本体 fixed 右挂贴顶
    const wrapperClass = (container.firstElementChild as HTMLElement).className;
    expect(wrapperClass).toContain("w-[340px]");
    expect(wrapperClass).toContain("shrink-0");
    const cls = shellOf(container).className;
    expect(cls).toContain("fixed");
    expect(cls).toContain("right-0");
    expect(cls).toContain("top-0");
    expect(cls).toContain("z-[55]");
    expect(cls).not.toContain("inset-0");
  });

  it("点击放大 → store true + 面板本体 fixed inset-0 全窗覆盖", async () => {
    const { container } = await openPanel();
    fireEvent.click(
      within(container).getByRole("button", {
        name: "chat:detailPanel.maximize",
      }),
    );
    expect(useAiUiStore.getState().panelMaximized).toBe(true);
    const cls = shellOf(container).className;
    expect(cls).toContain("fixed");
    expect(cls).toContain("inset-0");
    expect(cls).toContain("z-[60]");
    expect(cls).not.toContain("w-[340px]");
  });

  it("最大化后再点还原 → store false + 回到 right-0 z-[55] 穿透旁挂", async () => {
    const { container } = await openPanel();
    fireEvent.click(
      within(container).getByRole("button", {
        name: "chat:detailPanel.maximize",
      }),
    );
    // 最大化后按钮转「还原」（Minimize2 图标 + restore 文案）
    fireEvent.click(
      within(container).getByRole("button", {
        name: "chat:detailPanel.restore",
      }),
    );
    expect(useAiUiStore.getState().panelMaximized).toBe(false);
    const cls = shellOf(container).className;
    expect(cls).not.toContain("inset-0");
    expect(cls).toContain("right-0");
    expect(cls).toContain("w-[340px]");
    expect(cls).toContain("z-[55]");
  });

  it("最大化态 Esc → 退出最大化；未最大化时 Esc 无副作用", async () => {
    const { container } = await openPanel();
    fireEvent.click(
      within(container).getByRole("button", {
        name: "chat:detailPanel.maximize",
      }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAiUiStore.getState().panelMaximized).toBe(false);
    // 守卫语义：Esc 只退出不进入
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAiUiStore.getState().panelMaximized).toBe(false);
  });
});

describe("ai-ui panelMaximized 内存态", () => {
  it("默认 false；setPanelMaximized 切换", () => {
    expect(useAiUiStore.getState().panelMaximized).toBe(false);
    useAiUiStore.getState().setPanelMaximized(true);
    expect(useAiUiStore.getState().panelMaximized).toBe(true);
    useAiUiStore.getState().setPanelMaximized(false);
    expect(useAiUiStore.getState().panelMaximized).toBe(false);
  });
});
