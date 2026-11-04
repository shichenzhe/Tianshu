// tests/ai/automation-schedule-text.test.ts
import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  describeValidity,
  validateSchedule,
} from "../../src-react/domains/ai/automation/lib/schedule-text";

/** t 直通键名,断言走键拼接 */
const t = (key: string, opts?: Record<string, unknown>) =>
  key + (opts ? `:${JSON.stringify(opts)}` : "");

describe("describeSchedule", () => {
  it("daily → 每天时间", () => {
    expect(
      describeSchedule({ mode: "periodic", kind: "daily", time: "09:00" }, t),
    ).toBe('chat:automation.schedule.textDaily:{"time":"09:00"}');
  });
  it("weekly → 星期多选", () => {
    expect(
      describeSchedule(
        { mode: "periodic", kind: "weekly", weekdays: [1, 5], time: "18:00" },
        t,
      ),
    ).toBe(
      'chat:automation.schedule.textWeekly:{"weekdays":"common:weekday.1, common:weekday.5","time":"18:00"}',
    );
  });
  it("interval → 间隔 + 星期筛选(单位键走扁平 unitHour/unitMinute)", () => {
    expect(
      describeSchedule(
        { mode: "interval", value: 1, unit: "hour", weekdays: [1, 2] },
        t,
      ),
    ).toBe(
      'chat:automation.schedule.textInterval:{"weekdays":"common:weekday.1, common:weekday.2","value":1,"unit":"chat:automation.schedule.unitHour"}',
    );
    expect(
      describeSchedule({ mode: "interval", value: 30, unit: "minute" }, t),
    ).toBe(
      'chat:automation.schedule.textInterval:{"weekdays":"","value":30,"unit":"chat:automation.schedule.unitMinute"}',
    );
  });
});

describe("describeValidity", () => {
  it("长期有效 / 自定义区间", () => {
    expect(describeValidity({}, t)).toBe("chat:automation.schedule.longTerm");
    expect(
      describeValidity({ startAt: "2026-09-07", endAt: "2026-10-01" }, t),
    ).toBe(
      'chat:automation.schedule.textRange:{"start":"2026-09-07","end":"2026-10-01"}',
    );
  });
});

describe("validateSchedule", () => {
  const now = new Date("2026-09-06T10:00:00");
  it("once runAt 已过 → timeInPast", () => {
    expect(
      validateSchedule(
        { mode: "periodic", kind: "once", runAt: "2026-09-05T10:00:00.000Z" },
        {},
        now,
      ),
    ).toBe("timeInPast");
  });
  it("interval < 5 分钟 → intervalTooSmall", () => {
    expect(
      validateSchedule({ mode: "interval", value: 3, unit: "minute" }, {}, now),
    ).toBe("intervalTooSmall");
  });
  it("startAt 已过 → timeInPast;null → incomplete;正常 → ok", () => {
    expect(
      validateSchedule(
        { mode: "periodic", kind: "daily", time: "09:00" },
        { startAt: "2025-01-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("timeInPast");
    expect(validateSchedule(null, {}, now)).toBe("incomplete");
    expect(
      validateSchedule(
        { mode: "periodic", kind: "daily", time: "09:00" },
        {},
        now,
      ),
    ).toBe("ok");
  });
});
