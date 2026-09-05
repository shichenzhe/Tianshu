/**
 * skill-stats 单测(P-E Task 2):聚合纯函数(计数/升序/lastActiveAt)+
 * recorder swallow 语义(埋点失败不影响主流程)。Log 以模块 mock 隔离
 * (winston/electron 副作用不进纯函数测试)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Log from "../../electron/commons/Log";
import {
  aggregateSkillStats,
  recordSkillEvent,
  type SkillStatRow,
} from "../../electron/domains/ai/skill/skill-stats";

vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const d1 = new Date("2026-09-01T10:00:00Z");
const d2 = new Date("2026-09-02T10:00:00Z");
const d3 = new Date("2026-09-03T10:00:00Z");
const d4 = new Date("2026-09-04T10:00:00Z");

/** 零值快照断言辅助(少写字段) */
function zeroCounters(overrides: Partial<SkillStatRow>): SkillStatRow {
  return { event: "install", createdAt: d1, ...overrides };
}

describe("aggregateSkillStats", () => {
  it("多事件聚合:计数分桶、name 升序、batch_* 合计 batchOps", () => {
    const rows: SkillStatRow[] = [
      { name: "zeta", event: "install", createdAt: d1 },
      { name: "alpha", event: "install", createdAt: d1 },
      { name: "alpha", event: "install", createdAt: d2 },
      { name: "alpha", event: "enable", createdAt: d2 },
      { name: "alpha", event: "disable", createdAt: d3 },
      { name: "beta", event: "batch_enable", createdAt: d2 },
      { name: "beta", event: "batch_disable", createdAt: d2 },
      { name: "beta", event: "uninstall", createdAt: d1 },
    ];
    expect(aggregateSkillStats(rows)).toEqual([
      {
        name: "alpha",
        installs: 2,
        creates: 0,
        enables: 1,
        disables: 1,
        uninstalls: 0,
        batchOps: 0,
        lastActiveAt: d3,
      },
      {
        name: "beta",
        installs: 0,
        creates: 0,
        enables: 0,
        disables: 0,
        uninstalls: 1,
        batchOps: 2,
        lastActiveAt: d2,
      },
      {
        name: "zeta",
        installs: 1,
        creates: 0,
        enables: 0,
        disables: 0,
        uninstalls: 0,
        batchOps: 0,
        lastActiveAt: d1,
      },
    ]);
  });

  it("未知事件忽略(不计数也不推 lastActiveAt)", () => {
    const rows = [
      zeroCounters({ name: "alpha", createdAt: d1 }),
      zeroCounters({ name: "alpha", event: "mystery", createdAt: d4 }),
    ];
    expect(aggregateSkillStats(rows)).toEqual([
      {
        name: "alpha",
        installs: 1,
        creates: 0,
        enables: 0,
        disables: 0,
        uninstalls: 0,
        batchOps: 0,
        lastActiveAt: d1,
      },
    ]);
  });

  it("lastActiveAt 取最大 createdAt(与输入顺序无关)", () => {
    const rows = [
      { name: "a", event: "install", createdAt: d3 },
      { name: "a", event: "enable", createdAt: d1 },
      { name: "a", event: "uninstall", createdAt: d2 },
    ];
    expect(aggregateSkillStats(rows)[0]?.lastActiveAt).toEqual(d3);
  });

  it("create 事件计入 creates;空输入返回空数组", () => {
    expect(
      aggregateSkillStats([{ name: "a", event: "create", createdAt: d1 }]),
    ).toEqual([
      {
        name: "a",
        installs: 0,
        creates: 1,
        enables: 0,
        disables: 0,
        uninstalls: 0,
        batchOps: 0,
        lastActiveAt: d1,
      },
    ]);
    expect(aggregateSkillStats([])).toEqual([]);
  });
});

describe("recordSkillEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("调用 delegate create 并传 name/event", async () => {
    const create = vi.fn().mockResolvedValue({});
    await recordSkillEvent({ create }, "greeting", "install");
    expect(create).toHaveBeenCalledWith({
      data: { name: "greeting", event: "install" },
    });
  });

  it("prisma 抛错 → resolve 不 reject(swallow + Log.warn)", async () => {
    const create = vi.fn().mockRejectedValue(new Error("table locked"));
    await expect(
      recordSkillEvent({ create }, "greeting", "install"),
    ).resolves.toBeUndefined();
    expect(vi.mocked(Log.warn)).toHaveBeenCalled();
  });

  it("delegate 缺席 → 静默跳过(可选依赖,测试/独立形态不记录)", async () => {
    await expect(
      recordSkillEvent(undefined, "greeting", "install"),
    ).resolves.toBeUndefined();
    expect(vi.mocked(Log.warn)).not.toHaveBeenCalled();
  });
});
