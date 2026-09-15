// tests/ai/task-form.test.ts
import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
  buildInitialValues,
  serializeForm,
  buildTaskParams,
  canSubmitForm,
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
  projectId: null,
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
    // 时区可移植:断言与实现同式(date-fns format 本地时区)。取
    // 16:00Z 使 UTC+8 下本地日期(09-11)≠ slice(0,10)(09-10),
    // 从构造上区分"本地化格式化"与"字符串截断"
    const v = buildInitialValues(
      { task: { ...task, startAt: "2026-09-10T16:00:00Z" } },
      t,
    );
    expect(v.name).toBe("早报");
    expect(v.accessMode).toBe("full");
    expect(v.validity.startAt).toBe(
      format(new Date("2026-09-10T16:00:00Z"), "yyyy-MM-dd"),
    );
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

describe("项目预设（子系统 E）", () => {
  it("buildTaskParams：projectId 透传；缺省 null", () => {
    const base = buildInitialValues({ task }, t);
    expect(buildTaskParams({ ...base, projectId: 11 }, t).projectId).toBe(11);
    expect(buildTaskParams(base, t).projectId).toBeNull();
  });

  it("buildInitialValues：project 预设锁定空初值空间与归属；task 回填优先；未传零变化", () => {
    // 空初值 + project：workspaceId/projectId 双锁定
    const locked = buildInitialValues(
      { project: { id: 11, workspaceId: 30 } },
      t,
    );
    expect(locked.workspaceId).toBe(30);
    expect(locked.projectId).toBe(11);
    // 未传 project：初值与 AI 模块原路径一致（零 diff 回归）
    const empty = buildInitialValues({}, t);
    expect(empty.workspaceId).toBeNull();
    expect(empty.projectId).toBeNull();
    // task 回填优先于 project 预设（编辑路径取任务自身归属）
    const fromTask = buildInitialValues(
      { task, project: { id: 11, workspaceId: 30 } },
      t,
    );
    expect(fromTask.workspaceId).toBe(task.workspaceId);
    expect(fromTask.projectId).toBe(task.projectId);
  });
});

describe("canSubmitForm", () => {
  // 基线取自 task 夹具:name/prompt/modelId/workspaceId/daily schedule 均合法
  const base = buildInitialValues({ task }, t);
  // now 用本地时刻字面量,配合远端日期(2020/2030)使"过去/未来"判定
  // 与运行时区无关(任何时区下 2020-01-01 本地零点都早于 now 当日零点)
  const now = new Date("2026-09-06T10:00:00");

  it("name 为空白 → false", () => {
    expect(canSubmitForm({ ...base, name: " " }, now, false)).toBe(false);
  });

  it("字段齐备且调度合法 → true", () => {
    expect(canSubmitForm(base, now, false)).toBe(true);
  });

  it("过去 startAt:startAtUnchanged 维持原生命周期放行,否则防倒流拦截", () => {
    const past = { ...base, validity: { startAt: "2020-01-01" } };
    expect(canSubmitForm(past, now, true)).toBe(true);
    expect(canSubmitForm(past, now, false)).toBe(false);
    // 未来 startAt 不受防倒流影响
    expect(
      canSubmitForm(
        { ...base, validity: { startAt: "2030-01-01" } },
        now,
        false,
      ),
    ).toBe(true);
  });
});
