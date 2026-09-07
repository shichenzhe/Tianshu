// tests/ai/task-form.test.ts
import { describe, expect, it } from "vitest";
import {
  buildInitialValues,
  serializeForm,
  buildTaskParams,
} from "../../src-react/domains/ai/automation/lib/task-form";
import type { TaskRecord } from "../../src-react/domains/ai/automation/api/automation.api";

const t = (key: string) => key; // 文案占位,仅验证透传给 describeSchedule
const task = {
  id: 1,
  name: "早报",
  prompt: "总结",
  workspaceId: 2,
  workspaceName: "w",
  source: "local",
  modelId: 3,
  temperature: 0.5,
  scheduleJson: JSON.stringify({
    mode: "periodic",
    kind: "daily",
    time: "09:00",
  }),
  scheduleText: "每天 09:00",
  missedPolicy: "skip",
  enabled: true,
  status: "active",
  accessMode: "full",
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
} as TaskRecord;

describe("task-form 纯函数", () => {
  it("buildInitialValues 按 task 回填并本地化日期", () => {
    const v = buildInitialValues(
      { task: { ...task, startAt: "2026-09-10T00:00:00Z" } },
      t,
    );
    expect(v.name).toBe("早报");
    expect(v.accessMode).toBe("full");
    expect(v.validity.startAt).toBe("2026-09-10"); // 本地时区格式化,不 slice(0,10)
  });

  it("serializeForm 相同值同串、改值变串(脏检测依据)", () => {
    const v = buildInitialValues({ task }, t);
    expect(serializeForm(v)).toBe(serializeForm({ ...v }));
    expect(serializeForm(v)).not.toBe(serializeForm({ ...v, name: "x" }));
  });

  it("buildTaskParams 组装含 accessMode 与本地零点日期", () => {
    const v = buildInitialValues({ task }, t);
    v.validity = { startAt: "2026-09-10", endAt: "2026-09-20" };
    const p = buildTaskParams(v, t);
    expect(p.accessMode).toBe("full");
    expect(p.startAt).toBe(new Date("2026-09-10T00:00:00").toISOString());
    expect(p.endAt).toBe(new Date("2026-09-20T23:59:59").toISOString());
  });

  it("buildInitialValues 无源给默认 schedule", () => {
    const v = buildInitialValues({}, t);
    expect(v.schedule).toEqual({
      mode: "periodic",
      kind: "daily",
      time: "09:00",
    });
    expect(v.accessMode).toBe("default");
  });
});
