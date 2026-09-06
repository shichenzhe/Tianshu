import { describe, expect, it } from "vitest";
import { computeNextRun } from "../../electron/domains/ai/automation/schedule";

/** 基准:2026-09-06 是周日(ISO weekday 7) */
const at = (s: string) => new Date(`2026-09-06T${s}:00`);

describe("computeNextRun:periodic", () => {
  it("once:未来时刻返回原值,已过返回 null", () => {
    const cfg = {
      mode: "periodic",
      kind: "once",
      runAt: "2026-09-07T08:00:00.000Z",
    } as const;
    expect(computeNextRun(cfg, new Date("2026-09-06T00:00:00Z"))).toEqual(
      new Date("2026-09-07T08:00:00.000Z"),
    );
    expect(computeNextRun(cfg, new Date("2026-09-08T00:00:00Z"))).toBeNull();
  });

  it("daily:当天未到取今天,已过取明天", () => {
    const cfg = { mode: "periodic", kind: "daily", time: "09:00" } as const;
    expect(computeNextRun(cfg, at("08:00"))).toEqual(at("09:00"));
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-09-07T09:00:00"),
    );
  });

  it("weekly:星期多选取最近的未来匹配(跨周)", () => {
    // 周日 from,候选 周一(1)/周五(5) → 明天周一 18:00
    const cfg = {
      mode: "periodic",
      kind: "weekly",
      weekdays: [1, 5],
      time: "18:00",
    } as const;
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-09-07T18:00:00"),
    );
    // 周一 19:00 已过周一时刻 → 下一个候选周五
    expect(computeNextRun(cfg, new Date("2026-09-07T19:00:00"))).toEqual(
      new Date("2026-09-11T18:00:00"),
    );
  });

  it("biweekly:保持 anchor 相位,取下一个未来双周点", () => {
    // anchor 9-07(周一) 10:00;from=9-13(下周日) → 9-21 10:00
    const cfg = {
      mode: "periodic",
      kind: "biweekly",
      anchorDate: "2026-09-07",
      weekday: 1,
      time: "10:00",
    } as const;
    expect(computeNextRun(cfg, new Date("2026-09-13T12:00:00"))).toEqual(
      new Date("2026-09-21T10:00:00"),
    );
    // from 在 anchor 当天之前 → anchor 本身
    expect(computeNextRun(cfg, new Date("2026-09-01T00:00:00"))).toEqual(
      new Date("2026-09-07T10:00:00"),
    );
  });

  it("monthly:正常推进,当月无 31 号则跳过该月", () => {
    const cfg = {
      mode: "periodic",
      kind: "monthly",
      dayOfMonth: 31,
      time: "09:00",
    } as const;
    // from 2026-09-06 → 10-31(9 月只有 30 天,跳过)
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-10-31T09:00:00"),
    );
    // 12-31 存在
    expect(computeNextRun(cfg, new Date("2026-11-15T10:00:00"))).toEqual(
      new Date("2026-12-31T09:00:00"),
    );
  });

  it("yearly:2/29 非闰年跳过", () => {
    const cfg = {
      mode: "periodic",
      kind: "yearly",
      month: 2,
      day: 29,
      time: "10:00",
    } as const;
    // from 2027-01-01 → 2028-02-29(2027 非闰年)
    expect(computeNextRun(cfg, new Date("2027-01-01T00:00:00"))).toEqual(
      new Date("2028-02-29T10:00:00"),
    );
  });
});

describe("computeNextRun:interval", () => {
  it("以 lastRunAt 为相位基准累加", () => {
    const cfg = {
      mode: "interval",
      value: 90,
      unit: "minute",
    } as const;
    // lastRun 08:00,from 11:30 → 相位 08:00+90min 序列:9:30/11:00/12:30 → 12:30
    expect(computeNextRun(cfg, at("11:30"), at("08:00"))).toEqual(at("12:30"));
  });

  it("无 lastRunAt 时以 from 为基准(首次)", () => {
    const cfg = { mode: "interval", value: 30, unit: "minute" } as const;
    expect(computeNextRun(cfg, at("09:00"))).toEqual(at("09:30"));
  });

  it("落在未选星期则顺延至下一个允许日 00:00", () => {
    // 仅周一;from 周日 10:00,30 分钟 → 周日 10:30 不在集合 → 周一 00:00
    const cfg = {
      mode: "interval",
      value: 30,
      unit: "minute",
      weekdays: [1],
    } as const;
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-09-07T00:00:00"),
    );
  });
});
