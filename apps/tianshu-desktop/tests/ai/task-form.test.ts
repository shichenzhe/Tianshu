// tests/ai/task-form.test.ts
import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
  buildInitialValues,
  serializeForm,
  buildTaskParams,
  canSubmitForm,
  validateTaskForm,
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

describe("编排图执行体（targetKind=graph，Task 15）", () => {
  it("buildTaskParams：graph 任务 prompt 清空、modelId=0、附 targetKind/graphId", () => {
    const v = {
      ...buildInitialValues({ task }, t),
      targetKind: "graph",
      graphId: 7,
      prompt: "残留提示词",
      modelId: null,
    } as const;
    const p = buildTaskParams(v, t);
    expect(p.targetKind).toBe("graph");
    expect(p.graphId).toBe(7);
    expect(p.prompt).toBe("");
    expect(p.modelId).toBe(0);
  });

  it("buildTaskParams：prompt 任务 targetKind=prompt 且不带 graphId", () => {
    const p = buildTaskParams(buildInitialValues({ task }, t), t);
    expect(p.targetKind).toBe("prompt");
    expect(p.graphId).toBeUndefined();
  });

  it("buildInitialValues：graph 任务回填 targetKind/graphId/eventTrigger", () => {
    const v = buildInitialValues(
      {
        task: {
          ...task,
          targetKind: "graph",
          graphId: 5,
          prompt: "",
          modelId: 0,
          eventJson: JSON.stringify({
            source: "taskFinished",
            targetType: "graph",
            targetId: 2,
            on: "any",
          }),
        },
      },
      t,
    );
    expect(v.targetKind).toBe("graph");
    expect(v.graphId).toBe(5);
    expect(v.eventTrigger).toEqual({
      source: "taskFinished",
      targetType: "graph",
      targetId: 2,
      on: "any",
    });
  });

  it("buildInitialValues：非法/缺失 eventJson 回落 null（编辑态不炸）", () => {
    expect(
      buildInitialValues({ task: { ...task, eventJson: "not json" } }, t)
        .eventTrigger,
    ).toBeNull();
    expect(
      buildInitialValues(
        { task: { ...task, eventJson: JSON.stringify({ source: "xxx" }) } },
        t,
      ).eventTrigger,
    ).toBeNull();
    expect(buildInitialValues({ task }, t).eventTrigger).toBeNull();
  });

  it("serializeForm 覆盖 targetKind/graphId/eventTrigger（脏检测）", () => {
    const v = buildInitialValues({}, t);
    expect(serializeForm(v)).not.toBe(
      serializeForm({ ...v, targetKind: "graph" }),
    );
    expect(serializeForm(v)).not.toBe(
      serializeForm({ ...v, graphId: 3, targetKind: "graph" }),
    );
    expect(serializeForm(v)).not.toBe(
      serializeForm({ ...v, eventTrigger: { source: "appStarted" } }),
    );
  });
});

describe("事件触发序列化（eventJson，Task 15）", () => {
  it("eventTrigger null → eventJson 缺省；appStarted → 序列化", () => {
    const base = buildInitialValues({}, t);
    expect(buildTaskParams(base, t).eventJson).toBeUndefined();
    const p = buildTaskParams(
      { ...base, eventTrigger: { source: "appStarted" } },
      t,
    );
    expect(JSON.parse(p.eventJson!)).toEqual({ source: "appStarted" });
  });

  it("taskFinished 补齐目标才序列化（targetId 暂缺不落 eventJson）", () => {
    const base = buildInitialValues({}, t);
    const draft = {
      source: "taskFinished",
      targetType: "task",
      on: "success",
    } as const;
    expect(
      buildTaskParams({ ...base, eventTrigger: draft }, t).eventJson,
    ).toBeUndefined();
    const done = { ...draft, targetId: 3 };
    expect(
      JSON.parse(
        buildTaskParams({ ...base, eventTrigger: done }, t).eventJson!,
      ),
    ).toEqual(done);
  });
});

describe("执行体/事件校验（canSubmitForm/validateTaskForm 扩展）", () => {
  const base = buildInitialValues({ task }, t);
  const now = new Date("2026-09-06T10:00:00");

  it("graph 任务：graphId 未选禁提交，选中后免 prompt/modelId", () => {
    const g = {
      ...base,
      targetKind: "graph",
      graphId: null,
      prompt: "",
      modelId: null,
    } as const;
    expect(canSubmitForm(g, now, false)).toBe(false);
    expect(validateTaskForm(g)).toBe("graphMissing");
    const ready = { ...g, graphId: 4 };
    expect(canSubmitForm(ready, now, false)).toBe(true);
    expect(validateTaskForm(ready)).toBe("ok");
  });

  it("taskFinished 目标未选禁提交", () => {
    const ev = {
      ...base,
      eventTrigger: { source: "taskFinished", targetType: "graph", on: "any" },
    } as const;
    expect(canSubmitForm(ev, now, false)).toBe(false);
    expect(validateTaskForm(ev)).toBe("eventTargetMissing");
    const done = {
      ...ev,
      eventTrigger: { ...ev.eventTrigger, targetId: 9 },
    };
    expect(canSubmitForm(done, now, false)).toBe(true);
  });

  it("编辑态自引用拦截：目标任务=任务自身禁提交，他任务放行", () => {
    const self = {
      ...base,
      eventTrigger: {
        source: "taskFinished",
        targetType: "task",
        targetId: 1,
        on: "any",
      },
    } as const;
    // 新建（无 selfTaskId）不拦；编辑任务 id=1 拦（后端同口径 EVENT_SELF_REFERENCE）
    expect(canSubmitForm(self, now, false)).toBe(true);
    expect(canSubmitForm(self, now, false, 1)).toBe(false);
    expect(validateTaskForm(self, 1)).toBe("eventSelfReference");
    expect(canSubmitForm(self, now, false, 2)).toBe(true);
  });

  it("图自引用拦截：目标图=本任务执行图禁提交（create/edit 同拦）", () => {
    const graphSelf = {
      ...base,
      targetKind: "graph",
      graphId: 7,
      eventTrigger: {
        source: "taskFinished",
        targetType: "graph",
        targetId: 7,
        on: "any",
      },
    } as const;
    expect(canSubmitForm(graphSelf, now, false)).toBe(false);
    expect(validateTaskForm(graphSelf)).toBe("eventSelfReference");
    expect(canSubmitForm({ ...graphSelf, graphId: 8 }, now, false)).toBe(true);
  });

  it("目标类型切换清空 targetId 后重新要求选择（防跨域误配）", () => {
    const v = {
      ...base,
      eventTrigger: {
        source: "taskFinished",
        targetType: "task",
        targetId: 3,
        on: "success",
      },
    } as const;
    // 任务域已选 targetId=3 合法;弹窗切 targetType=graph 必须同步清空
    // 目标(patchFinished({targetType,targetId:undefined})),否则旧域
    // targetId 残留被误配到图域,Select 不显示但 validate 因非空放行
    expect(validateTaskForm(v)).toBe("ok");
    const cleared = {
      ...v,
      eventTrigger: {
        ...v.eventTrigger,
        targetType: "graph",
        targetId: undefined,
      },
    };
    expect(validateTaskForm(cleared)).toBe("eventTargetMissing");
    expect(canSubmitForm(cleared, now, false)).toBe(false);
    expect(buildTaskParams(cleared, t).eventJson).toBeUndefined();
  });

  it("appStarted 无目标要求，不触发事件校验", () => {
    const ev = { ...base, eventTrigger: { source: "appStarted" } } as const;
    expect(validateTaskForm(ev)).toBe("ok");
    expect(canSubmitForm(ev, now, false)).toBe(true);
  });
});
