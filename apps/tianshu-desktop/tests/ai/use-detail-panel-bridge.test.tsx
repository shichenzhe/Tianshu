// @vitest-environment jsdom
/**
 * use-detail-panel-bridge：detailPanel:openBrowser 事件 → 开/复用浏览器 tab
 * 并回写 url；跨会话静默。mock ipc on 捕获监听器手动触发。
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let listener: ((payload: { sessionId: number; url: string }) => void) | null =
  null;
vi.mock("@/lib/ipc", () => ({
  on: vi.fn((_channel: string, cb: (e: unknown, payload: unknown) => void) => {
    listener = (payload) => cb({}, payload);
    return () => {
      listener = null;
    };
  }),
}));
// react-i18next 照 tests/ai/detail-panel-init.test.tsx 的部分 mock（返回 key）
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";
import { useDetailPanelBridge } from "../../src-react/domains/ai/chat/hooks/use-detail-panel-bridge";

function Probe({ sessionId }: { sessionId: number | null }) {
  useDetailPanelBridge(sessionId);
  return null;
}

function fire(payload: { sessionId: number; url: string }) {
  act(() => listener?.(payload));
}

const S1 = 101;

beforeEach(() => {
  useDetailPanelStore.setState({ panels: {} });
  useAiUiStore.setState({ artifactsOpen: false });
});

describe("useDetailPanelBridge", () => {
  it("当前会话事件：右栏未开自动开；新建 browser tab 并回写 url", () => {
    render(<Probe sessionId={S1} />);
    fire({ sessionId: S1, url: "https://example.com/a" });
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      kind: "browser",
      url: "https://example.com/a",
    });
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(useAiUiStore.getState().artifactsOpen).toBe(true);
  });

  it("已有 browser tab：复用最后一个回写 url，不开新 tab", () => {
    render(<Probe sessionId={S1} />);
    fire({ sessionId: S1, url: "https://example.com/a" });
    fire({ sessionId: S1, url: "https://example.com/b" });
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].url).toBe("https://example.com/b");
  });

  it("其他会话事件：静默不动", () => {
    render(<Probe sessionId={S1} />);
    fire({ sessionId: 999, url: "https://example.com/x" });
    expect(useDetailPanelStore.getStateOf(S1).tabs).toHaveLength(0);
    expect(useAiUiStore.getState().artifactsOpen).toBe(false);
  });

  it("activeSessionId 切换后按新会话过滤", () => {
    const { rerender } = render(<Probe sessionId={S1} />);
    rerender(<Probe sessionId={102} />);
    fire({ sessionId: 102, url: "https://example.com/c" });
    expect(useDetailPanelStore.getStateOf(102).tabs).toHaveLength(1);
    fire({ sessionId: S1, url: "https://example.com/d" });
    expect(useDetailPanelStore.getStateOf(S1).tabs).toHaveLength(0);
  });
});
