// @vitest-environment jsdom
/**
 * useGraphAiSession 单测（Fix 3 契约）：首条 contentPrefix 只含固定指令，
 * 图快照统一由 buildSendPrefix 注入——首条不得双份快照（大图时上下文
 * 直接翻倍）。会话惰建 + 绑定回写经 mock invoke 验证。
 */
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => key + JSON.stringify(opts ?? {}),
    i18n: { language: "zh" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

import { useGraphAiSession } from "@/domains/ai/orchestration/hooks/use-graph-ai-session";

const baseParams = {
  graphId: 1,
  graphName: "我的图",
  description: "描述",
  graphJson: '{"version":1}',
  models: [{ id: 1, name: "GPT-4o" }],
  boundSessionId: undefined as number | undefined,
  selectedNodeIds: undefined as string[] | undefined,
  onBindingChange: () => {},
};

describe("useGraphAiSession", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockImplementation((channel: string) => {
      switch (channel) {
        case "workspace:list":
          return Promise.resolve([{ id: 7, name: "默认工作空间" }]);
        case "session:create":
          return Promise.resolve({ id: 5 });
        default:
          return Promise.resolve(undefined);
      }
    });
  });

  it("首条 contentPrefix 只含指令（无快照），快照由 buildSendPrefix 提供且恰好一份", async () => {
    const { result } = renderHook(() => useGraphAiSession(baseParams));
    let resolved: Awaited<
      ReturnType<typeof result.current.prepareFirstSend>
    > | null = null;
    await act(async () => {
      resolved = await result.current.prepareFirstSend();
    });
    expect(resolved!.session.id).toBe(5);
    // 指令在、快照不在
    expect(resolved!.contentPrefix).toContain("ai.instruction");
    expect(resolved!.contentPrefix).not.toContain("ai.prefixFull");
    // 绑定已回写
    expect(invokeMock).toHaveBeenCalledWith(
      "orchestration:bindAiSession",
      1,
      5,
    );
    // 快照恰由 buildSendPrefix 出一份
    const prefix = result.current.buildSendPrefix();
    expect(prefix).toContain("ai.prefixFull");
    const prefixOpts = JSON.parse(prefix.slice(prefix.indexOf("{")));
    expect(prefixOpts.graph).toBe('{"version":1}');
  });

  it("选中节点注入快照（selectedNodeIds 直传边串不得混入由视图层过滤）", async () => {
    const { result } = renderHook(() =>
      useGraphAiSession({
        ...baseParams,
        boundSessionId: 9,
        selectedNodeIds: ["node-1"],
      }),
    );
    await act(async () => {
      await result.current.prepareFirstSend();
    });
    const prefix = result.current.buildSendPrefix();
    const prefixOpts = JSON.parse(prefix.slice(prefix.indexOf("{")));
    expect(prefixOpts.selected).toBe("node-1");
  });

  it("会话被删善后：清绑定失败也乐观解除本地绑定（不卡占位态）", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "orchestration:bindAiSession") {
        return Promise.reject(new Error("IPC_DOWN"));
      }
      return Promise.resolve(undefined);
    });
    const onBindingChange = vi.fn();
    const { result } = renderHook(() =>
      useGraphAiSession({ ...baseParams, onBindingChange }),
    );
    await act(async () => {
      result.current.handleSessionGone();
    });
    await waitFor(() =>
      expect(onBindingChange).toHaveBeenCalledWith(undefined),
    );
  });

  it("已绑定会话直接复用，不再 create/bind", async () => {
    const { result } = renderHook(() =>
      useGraphAiSession({ ...baseParams, boundSessionId: 9 }),
    );
    let id = 0;
    await act(async () => {
      id = await result.current.prepareFirstSend().then((r) => r.session.id);
    });
    expect(id).toBe(9);
    expect(invokeMock.mock.calls.some((c) => c[0] === "session:create")).toBe(
      false,
    );
  });
});
