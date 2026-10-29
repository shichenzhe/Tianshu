import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENDPOINTS, type MonitorStats } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
}));

import { useMonitorStore } from "./monitor.store";

const stats: MonitorStats = {
  today: {
    inputTokens: 1200,
    outputTokens: 800,
    llmCalls: 12,
    toolCalls: 7,
    toolSuccessRate: 6 / 7,
  },
  trend: [
    {
      date: "2026-10-25",
      inputTokens: 1200,
      outputTokens: 800,
      llmCalls: 12,
      toolCalls: 7,
    },
  ],
  byModel: [
    {
      modelId: 1,
      name: "model-a",
      calls: 12,
      inputTokens: 1200,
      outputTokens: 800,
    },
  ],
  tools: [
    {
      toolName: "read",
      total: 7,
      done: 6,
      denied: 1,
      error: 0,
      avgDurationMs: 25,
      successRate: 6 / 7,
    },
  ],
};

function makeTransport() {
  return { request: vi.fn() };
}

function ok(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

describe("monitor store", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    transport = makeTransport();
    connMock.activeTransport.mockReset().mockReturnValue(transport);
    useMonitorStore.setState({
      scene: "all",
      stats: null,
      loading: false,
      error: null,
    });
  });

  it("load：POST monitor/stats 成功解包 data 并清除错误", async () => {
    transport.request.mockResolvedValue(ok(stats));

    await useMonitorStore.getState().load();

    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.monitor.stats,
      {},
    );
    expect(useMonitorStore.getState()).toMatchObject({
      scene: "all",
      stats,
      loading: false,
      error: null,
    });
  });

  it("load：wire 业务失败或空数据时进入 error 态", async () => {
    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "failed" },
    });
    await useMonitorStore.getState().load();
    expect(useMonitorStore.getState()).toMatchObject({
      stats: null,
      loading: false,
      error: "loadFailed",
    });

    transport.request.mockResolvedValueOnce(ok(null));
    await useMonitorStore.getState().load();
    expect(useMonitorStore.getState().error).toBe("loadFailed");
  });

  it("load(scene)：切换场景自动请求并仅对 all 省略 scene 载荷", async () => {
    transport.request.mockResolvedValue(ok(stats));

    await useMonitorStore.getState().load("graph");
    expect(useMonitorStore.getState().scene).toBe("graph");
    expect(transport.request).toHaveBeenLastCalledWith(
      "POST",
      ENDPOINTS.monitor.stats,
      { scene: "graph" },
    );

    await useMonitorStore.getState().load("all");
    expect(transport.request).toHaveBeenLastCalledWith(
      "POST",
      ENDPOINTS.monitor.stats,
      {},
    );
  });
});
