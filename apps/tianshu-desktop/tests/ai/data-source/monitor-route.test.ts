// P0-1（spec monitoring.md §6）：监控页主机路由化——monitor.api 双通道
// （本地 invoke monitor:stats 参数逐字零行为变化；远程 ServerApi.monitorStats
// → server:monitorStats 透传 POST monitor/stats）。UI 组件（MonitorView/
// MonitorTrendChart）不感知路由——MonitorApi 形状不变。
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const serverApi = vi.hoisted(() => ({
  monitorStats: vi.fn(),
}));
vi.mock("../../../src-react/domains/ai/server/api/server.api", () => ({
  default: serverApi,
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
}));

import { useHostStore } from "../../../src-react/domains/ai/data-source/host.store";
import { MonitorApi } from "../../../src-react/domains/ai/monitor/api/monitor.api";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
  });
});

describe("MonitorApi.stats 主机路由（P0-1）", () => {
  it("本地主机：invoke monitor:stats 参数逐字一致（scene 有值/undefined 均原样）", async () => {
    serverApi.monitorStats.mockResolvedValue({ today: {} });
    await MonitorApi.stats("chat");
    expect(invoke).toHaveBeenCalledWith("monitor:stats", "chat");
    expect(serverApi.monitorStats).not.toHaveBeenCalled();

    invoke.mockClear();
    await MonitorApi.stats(undefined);
    expect(invoke).toHaveBeenCalledWith("monitor:stats", undefined);
  });

  it("远程主机：走 ServerApi.monitorStats（scene + connId），不触本地通道", async () => {
    const fixture = { today: { inputTokens: 5 } };
    serverApi.monitorStats.mockResolvedValue(fixture);
    useHostStore.getState().switchHost({ kind: "remote", connId: "mon-c1" });

    await expect(MonitorApi.stats("graph")).resolves.toBe(fixture);
    expect(serverApi.monitorStats).toHaveBeenCalledWith("graph", "mon-c1");
    expect(invoke).not.toHaveBeenCalled();

    serverApi.monitorStats.mockClear();
    await MonitorApi.stats(undefined);
    expect(serverApi.monitorStats).toHaveBeenCalledWith(undefined, "mon-c1");
  });
});
