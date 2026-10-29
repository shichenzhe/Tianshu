// CRUD 批调度纯函数七 kind 全集：build/parse 双向闭环、intervalWeekdays
// 防丢透传、prompt/graph 双模式校验、编辑载荷组装透传纪律（eventJson/
// templateSlug/projectId/temperature/enabled 原样回传）。
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@tianshu/protocol";
import {
  buildEditPayload,
  buildSchedule,
  buildScheduleText,
  defaultScheduleValues,
  parseScheduleConfig,
  validationKey,
  validationKeyForTarget,
} from "./automation-schedule";

const T = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;

const TARGET = {
  name: "任务甲",
  targetKind: "graph" as const,
  graphId: 5,
  modelId: null,
  prompt: "",
};

function values(over: Record<string, unknown>) {
  return { ...defaultScheduleValues(), ...over } as ReturnType<
    typeof defaultScheduleValues
  >;
}

describe("buildSchedule/parseScheduleConfig 七 kind 双向闭环", () => {
  it.each([
    ["once", { kind: "once", date: "2026-11-01", hm: "09:30" }],
    ["daily", { kind: "daily", hm: "08:00" }],
    ["weekly", { kind: "weekly", weekdays: [2, 5], hm: "09:00" }],
    ["biweekly", { kind: "biweekly", date: "2026-11-02", hm: "10:00" }],
    ["monthly", { kind: "monthly", dayOfMonth: "15", hm: "09:00" }],
    ["yearly", { kind: "yearly", month: "3", dayOfMonth: "21", hm: "09:00" }],
  ])("%s 构造可回填（往返字段不丢）", (_kind, over) => {
    const built = buildSchedule(values(over));
    const parsed = parseScheduleConfig(built);
    expect(parsed).not.toBeNull();
    const rebuilt = buildSchedule(parsed!);
    // weekly/biweekly 的星期数组排序后等价；once runAt 含时区偏移经 ISO 往返
    expect(rebuilt).toEqual(built);
  });

  it("interval：value/unit + 可选 weekdays 并回（回填保留再构造不丢）", () => {
    const built = buildSchedule(
      values({
        kind: "interval",
        intervalValue: "15",
        intervalUnit: "minute",
        intervalWeekdays: [1, 4],
      }),
    );
    expect(built).toEqual({
      mode: "interval",
      value: 15,
      unit: "minute",
      weekdays: [1, 4],
    });
    const parsed = parseScheduleConfig(built);
    expect(parsed?.intervalWeekdays).toEqual([1, 4]);
    expect(buildSchedule(parsed!)).toEqual(built);
  });

  it("biweekly weekday 由锚点日期推导（周日=7）", () => {
    // 2026-11-01 是周日
    const built = buildSchedule(
      values({ kind: "biweekly", date: "2026-11-01", hm: "09:00" }),
    );
    expect(built).toMatchObject({ kind: "biweekly", weekday: 7 });
  });

  it("未知形态返回 null（页面只读透传分支）", () => {
    expect(parseScheduleConfig({ mode: "strange" })).toBeNull();
    expect(parseScheduleConfig("x")).toBeNull();
    expect(parseScheduleConfig(null)).toBeNull();
  });
});

describe("validationKey 双模式与七 kind 校验", () => {
  const now = new Date("2026-10-27T00:00:00");
  it("graph 模式：未选图 needGraph；prompt 模式：缺提示词/缺模型各自报", () => {
    // 调度取 daily（默认 once 需未来日期会先报 needSchedule 干扰断言）
    const daily = values({ kind: "daily" });
    expect(validationKey({ ...TARGET, graphId: null }, daily, now)).toBe(
      "orchestration:needGraph",
    );
    expect(
      validationKey(
        {
          ...TARGET,
          targetKind: "prompt",
          graphId: null,
          modelId: 3,
          prompt: "p",
        },
        daily,
        now,
      ),
    ).toBeNull();
    expect(
      validationKey(
        {
          ...TARGET,
          targetKind: "prompt",
          graphId: null,
          modelId: 3,
          prompt: " ",
        },
        daily,
        now,
      ),
    ).toBe("orchestration:needPrompt");
    expect(
      validationKey(
        {
          ...TARGET,
          targetKind: "prompt",
          graphId: null,
          modelId: null,
          prompt: "p",
        },
        daily,
        now,
      ),
    ).toBe("orchestration:needModel");
  });

  it("monthly/yearly 缺日缺月报 needSchedule；biweekly 缺锚点报 needSchedule", () => {
    expect(
      validationKey(TARGET, values({ kind: "monthly", dayOfMonth: "" }), now),
    ).toBe("orchestration:needSchedule");
    expect(
      validationKey(
        TARGET,
        values({ kind: "yearly", month: "", dayOfMonth: "1" }),
        now,
      ),
    ).toBe("orchestration:needSchedule");
    expect(
      validationKey(TARGET, values({ kind: "biweekly", date: "" }), now),
    ).toBe("orchestration:needSchedule");
  });
});

describe("buildScheduleText 三新 kind 文案插值", () => {
  it("biweekly/monthly/yearly", () => {
    expect(
      buildScheduleText(
        values({ kind: "biweekly", date: "2026-11-02", hm: "10:00" }),
        T,
      ),
    ).toContain("2026-11-02");
    expect(
      buildScheduleText(values({ kind: "monthly", dayOfMonth: "15" }), T),
    ).toContain("15");
    expect(
      buildScheduleText(
        values({ kind: "yearly", month: "3", dayOfMonth: "21" }),
        T,
      ),
    ).toContain("21");
  });
});

describe("buildEditPayload 透传纪律", () => {
  const task = {
    id: 7,
    name: "旧名",
    prompt: "",
    workspaceId: 3,
    workspaceName: "默认",
    source: "local",
    modelId: 0,
    temperature: 0.3,
    targetKind: "graph",
    graphId: 5,
    eventJson: '{"source":"appStarted"}',
    scheduleJson: '{"mode":"interval","value":10,"unit":"minute"}',
    scheduleText: "每 10 分钟",
    missedPolicy: "skip",
    accessMode: "default",
    enabled: false,
    status: "active",
    projectId: 11,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  } as TaskRecord;

  it("UI 不暴露字段原样回传；enabled 原值（不重置开关）", () => {
    const payload = buildEditPayload(
      task,
      {
        name: "新名",
        targetKind: "prompt",
        graphId: null,
        modelId: 9,
        prompt: "只回 pong",
      },
      values({ kind: "daily", hm: "09:00" }),
      T,
      { workspaceId: 3, missedPolicy: "skip", accessMode: "default" },
    );
    expect(payload).toMatchObject({
      id: 7,
      enabled: false,
      eventJson: '{"source":"appStarted"}',
      templateSlug: undefined,
      projectId: 11,
      temperature: 0.3,
    });
    expect(payload.schedule).toEqual({
      mode: "periodic",
      kind: "daily",
      time: "09:00",
    });
  });

  it("表单面字段以表单值提交（workspace/错过策略/访问模式改动生效）", () => {
    const payload = buildEditPayload(
      task,
      { ...TARGET, name: "n" },
      values({ kind: "daily", hm: "09:00" }),
      T,
      { workspaceId: 8, missedPolicy: "catchUpOnce", accessMode: "full" },
    );
    expect(payload.workspaceId).toBe(8);
    expect(payload.missedPolicy).toBe("catchUpOnce");
    expect(payload.accessMode).toBe("full");
  });

  it("未知调度形态：schedule 原样透传（null values 分支）", () => {
    const payload = buildEditPayload(
      { ...task, scheduleJson: '{"mode":"strange"}' },
      { ...TARGET, name: "n" },
      null,
      T,
      { workspaceId: 3, missedPolicy: "skip", accessMode: "default" },
    );
    expect(payload.schedule).toEqual({ mode: "strange" });
    expect(payload.scheduleText).toBe("每 10 分钟");
  });
});

describe("validationKeyForTarget 执行体独立校验", () => {
  it("空名/缺图/缺提示词/缺模型逐项报 key；齐全为 null", () => {
    expect(validationKeyForTarget({ ...TARGET, name: " " })).toBe(
      "orchestration:needName",
    );
    expect(validationKeyForTarget({ ...TARGET, graphId: null })).toBe(
      "orchestration:needGraph",
    );
    expect(
      validationKeyForTarget({
        name: "n",
        targetKind: "prompt",
        graphId: null,
        modelId: null,
        prompt: "hi",
      }),
    ).toBe("orchestration:needModel");
    expect(
      validationKeyForTarget({
        name: "n",
        targetKind: "prompt",
        graphId: null,
        modelId: 3,
        prompt: " ",
      }),
    ).toBe("orchestration:needPrompt");
    expect(validationKeyForTarget(TARGET)).toBeNull();
  });
});
