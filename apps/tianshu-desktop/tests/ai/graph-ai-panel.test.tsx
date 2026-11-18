// @vitest-environment jsdom
/**
 * GraphAiPanel 单测（Fix 5）：模型目录未加载完成时 hasModel 必须为
 * false（禁发——空目录注入会瓦解 modelId 幻觉防御）；目录就绪且空间
 * 有默认模型时放行。ChatPane 以捕获桩替代。
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => () => {},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

interface CapturedPaneProps {
  hasModel?: boolean;
  session?: { currentModelId?: number };
  onPickModel?: (modelId: number) => void;
  sessionResolver?: () => Promise<unknown>;
}
const paneProps = vi.hoisted(() => ({
  current: null as CapturedPaneProps | null,
}));
vi.mock("@/domains/ai/chat/components/ChatPane", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedPaneProps) => {
      paneProps.current = props;
      return createElement("div", { "data-testid": "chat-pane" });
    },
  };
});

import GraphAiPanel from "@/domains/ai/orchestration/components/GraphAiPanel";

const baseProps = {
  graphId: 1,
  graphName: "我的图",
  description: "",
  graphJson: "{}",
  aiSessionId: undefined as number | undefined,
  onBindingChange: () => {},
  onApplyOps: () => {},
  onApplyFull: () => {},
  onUndo: () => {},
  onCollapse: () => {},
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GraphAiPanel {...baseProps} />
    </QueryClientProvider>,
  );
}

describe("GraphAiPanel 模型目录门控", () => {
  beforeEach(() => {
    paneProps.current = null;
  });

  it("目录加载中 hasModel=false（禁发）；就绪且有默认模型后放行", async () => {
    let resolveModels: (v: unknown) => void = () => {};
    let resolveWorkspaces: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "model:listAll") {
        return new Promise((resolve) => {
          resolveModels = resolve;
        });
      }
      if (channel === "workspace:list") {
        return new Promise((resolve) => {
          resolveWorkspaces = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    renderPanel();
    await waitFor(() => expect(paneProps.current).toBeTruthy());
    // 空间先就绪（有默认模型 3）：等重渲染落地后必须仍禁发——否则注入
    // 空目录（目录在飞），瓦解 modelId 幻觉防御
    const beforeResolve = paneProps.current;
    resolveWorkspaces([{ id: 7, defaultModelId: 3 }]);
    await waitFor(() => expect(paneProps.current).not.toBe(beforeResolve));
    expect(paneProps.current!.hasModel).toBe(false);
    // 目录就绪：放行
    resolveModels([{ id: 3, modelId: "gpt-4o", name: "GPT-4o" }]);
    await waitFor(() => expect(paneProps.current!.hasModel).toBe(true));
  });

  it("目录加载失败 hasModel=false（不以空目录放行）", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "model:listAll") return Promise.reject(new Error("IPC"));
      if (channel === "workspace:list") {
        return Promise.resolve([{ id: 7, defaultModelId: 3 }]);
      }
      return Promise.resolve(undefined);
    });
    renderPanel();
    await waitFor(() => expect(paneProps.current).toBeTruthy());
    await waitFor(() => expect(paneProps.current!.hasModel).toBe(false));
  });

  it("无默认模型时可选草稿模型并发送首条：选后放行，建会话后先 setModel", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "model:listAll") {
        return Promise.resolve([{ id: 3, modelId: "gpt-4o", name: "GPT-4o" }]);
      }
      if (channel === "workspace:list") {
        return Promise.resolve([{ id: 7 }]);
      }
      if (channel === "session:create") return Promise.resolve({ id: 5 });
      return Promise.resolve(undefined);
    });
    renderPanel();
    await waitFor(() => expect(paneProps.current?.onPickModel).toBeTruthy());
    expect(paneProps.current!.hasModel).toBe(false);
    act(() => paneProps.current!.onPickModel!(3));
    expect(paneProps.current!.hasModel).toBe(true);
    expect(paneProps.current!.session?.currentModelId).toBe(3);
    await act(async () => {
      await paneProps.current!.sessionResolver!();
    });
    expect(invokeMock).toHaveBeenCalledWith("session:setModel", 5, 3);
    const createIndex = invokeMock.mock.calls.findIndex(
      (c) => c[0] === "session:create",
    );
    const setModelIndex = invokeMock.mock.calls.findIndex(
      (c) => c[0] === "session:setModel",
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(setModelIndex).toBeGreaterThan(createIndex);
  });
});
