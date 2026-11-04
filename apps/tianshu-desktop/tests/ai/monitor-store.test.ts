// 场景筛选 store：缺省 all、setScene 可往返
import { beforeEach, describe, expect, it } from "vitest";
import { useMonitorStore } from "../../src-react/domains/ai/monitor/store/monitor.store";

describe("useMonitorStore", () => {
  beforeEach(() => {
    useMonitorStore.getState().setScene("all");
  });
  it("缺省 all", () => {
    expect(useMonitorStore.getState().scene).toBe("all");
  });
  it("setScene 往返", () => {
    useMonitorStore.getState().setScene("graph");
    expect(useMonitorStore.getState().scene).toBe("graph");
    useMonitorStore.getState().setScene("all");
    expect(useMonitorStore.getState().scene).toBe("all");
  });
});
