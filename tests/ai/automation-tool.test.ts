/**
 * create_automation_task 工具单测：deps 注入 createTask mock（create-expert
 * 先例）；workspaceId/modelId 从 ctx 透传（防模型幻觉填参）——缺席返回
 * 引导文案不落库；缺省值与表单口径对齐（missedPolicy=skip、
 * accessMode=default、targetKind=prompt）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_TOOL_NAME,
  makeAutomationTool,
  validateAutomationTaskArgs,
} from "../../electron/domains/ai/agent/automation-tool";

const baseArgs = {
  name: "每日报告整理",
  prompt: "汇总工作区日志，输出 daily-report.md",
  schedule: { mode: "periodic", kind: "daily", time: "09:00" },
  scheduleText: "每天 09:00",
};

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 1,
    userId: 7,
    workspaceId: 3,
    modelId: 11,
    ...overrides,
  } as never;
}

describe("validateAutomationTaskArgs", () => {
  it("合法参数通过", () => {
    const r = validateAutomationTaskArgs(baseArgs);
    expect(r.ok).toBe(true);
  });

  it("name 为空拒绝", () => {
    const r = validateAutomationTaskArgs({ ...baseArgs, name: "  " });
    expect(r.ok).toBe(false);
  });

  it("interval 低于 5 分钟拒绝（与表单防呆同口径）", () => {
    const r = validateAutomationTaskArgs({
      ...baseArgs,
      schedule: { mode: "interval", value: 1, unit: "minute" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("5");
    }
  });

  it("once 的 runAt 在过去拒绝", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const r = validateAutomationTaskArgs({
      ...baseArgs,
      schedule: { mode: "periodic", kind: "once", runAt: past },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("过去");
    }
  });

  it("time 非法格式拒绝", () => {
    const r = validateAutomationTaskArgs({
      ...baseArgs,
      schedule: { mode: "periodic", kind: "daily", time: "25:00" },
    });
    expect(r.ok).toBe(false);
  });
});

describe("makeAutomationTool", () => {
  const createTask = vi.fn().mockResolvedValue({
    id: 42,
    nextRunAt: "2026-10-17T01:00:00.000Z",
  });
  const tool = makeAutomationTool({
    createTask,
    graphFirst: vi.fn().mockResolvedValue(null),
  });
  beforeEach(() => vi.clearAllMocks());

  it("落库透传 ctx 的 workspaceId/modelId/userId，缺省值与表单口径对齐", async () => {
    const out = await tool.execute(ctx(), { ...baseArgs } as never);
    expect(out).not.toContain("错误");
    expect(out).toContain("42");
    expect(createTask).toHaveBeenCalledTimes(1);
    const [params, userId] = createTask.mock.calls[0];
    expect(userId).toBe(7);
    expect(params).toMatchObject({
      name: "每日报告整理",
      workspaceId: 3,
      modelId: 11,
      targetKind: "prompt",
      missedPolicy: "skip",
      accessMode: "default",
      schedule: { mode: "periodic", kind: "daily", time: "09:00" },
      scheduleText: "每天 09:00",
    });
  });

  it("成功文案含下次触发时间", async () => {
    const out = await tool.execute(ctx(), { ...baseArgs } as never);
    expect(out).toContain("2026-10-17T01:00:00.000Z");
  });

  it("missedPolicy 显式传 catchUpOnce 透传", async () => {
    await tool.execute(ctx(), {
      ...baseArgs,
      missedPolicy: "catchUpOnce",
    } as never);
    const [params] = createTask.mock.calls[0];
    expect(params.missedPolicy).toBe("catchUpOnce");
  });

  it("ctx 缺 workspaceId：返回引导文案且不落库", async () => {
    const out = await tool.execute(ctx({ workspaceId: undefined }), {
      ...baseArgs,
    } as never);
    expect(out).toContain("错误");
    expect(out).toContain("工作空间");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("ctx 缺 modelId：返回引导文案且不落库", async () => {
    const out = await tool.execute(ctx({ modelId: undefined }), {
      ...baseArgs,
    } as never);
    expect(out).toContain("错误");
    expect(out).toContain("模型");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("ctx 缺 userId：返回错误文案且不落库", async () => {
    const out = await tool.execute(ctx({ userId: undefined }), {
      ...baseArgs,
    } as never);
    expect(out).toContain("错误");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("参数校验失败不落库", async () => {
    const out = await tool.execute(ctx(), {
      ...baseArgs,
      schedule: { mode: "interval", value: 1, unit: "minute" },
    } as never);
    expect(out).toContain("错误");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("创建成功 → notify(新任务 id) 广播渲染层失效；失败路径不 notify", async () => {
    const notify = vi.fn();
    const toolWithNotify = makeAutomationTool({
      createTask,
      graphFirst: vi.fn().mockResolvedValue(null),
      notify,
    });
    const out = await toolWithNotify.execute(ctx(), { ...baseArgs } as never);
    expect(out).toContain("已创建");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(42);
    // 校验失败（不落库）不通知
    const bad = await toolWithNotify.execute(ctx(), {
      ...baseArgs,
      schedule: { mode: "interval", value: 1, unit: "minute" },
    } as never);
    expect(bad).toContain("错误");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("工具名与 kind 符合预期", () => {
    expect(tool.name).toBe(AUTOMATION_TOOL_NAME);
    expect(tool.kind).toBe("write");
  });
});

describe("makeAutomationTool（graphId 直连工作流）", () => {
  const createTask = vi.fn().mockResolvedValue({ id: 43 });
  const graphFirst = vi.fn().mockResolvedValue({ id: 1, userId: 7 });
  const tool = makeAutomationTool({ createTask, graphFirst });
  beforeEach(() => vi.clearAllMocks());

  const graphArgs = {
    name: "每日 Git 批量更新",
    graphId: 1,
    schedule: { mode: "periodic", kind: "daily", time: "09:00" },
    scheduleText: "每天 09:00",
  };

  it("graphId 单独给（无 prompt）→ 校验通过", () => {
    expect(validateAutomationTaskArgs(graphArgs).ok).toBe(true);
  });

  it("graphId 与 prompt 同时给拒绝（二选一）", () => {
    const r = validateAutomationTaskArgs({
      ...graphArgs,
      prompt: "跑一下",
    });
    expect(r.ok).toBe(false);
  });

  it("两者都缺拒绝", () => {
    const { prompt: _prompt, ...noPrompt } = {
      ...graphArgs,
      prompt: undefined,
    };
    const r = validateAutomationTaskArgs({
      name: "x",
      schedule: graphArgs.schedule,
      scheduleText: graphArgs.scheduleText,
    });
    expect(r.ok).toBe(false);
    expect(noPrompt).toBeDefined();
  });

  it("graphId 直连 → 归属校验后落库 targetKind=graph；modelId 缺席不拦截", async () => {
    const out = await tool.execute(
      ctx({ modelId: undefined }),
      graphArgs as never,
    );
    expect(out).not.toContain("错误");
    expect(graphFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, userId: 7 } }),
    );
    const [params] = createTask.mock.calls[0];
    expect(params).toMatchObject({
      targetKind: "graph",
      graphId: 1,
      prompt: "",
      modelId: 0,
      accessMode: "default",
    });
  });

  it("回执含受限模式引导（代码/写文件节点提示）", async () => {
    const out = await tool.execute(ctx(), graphArgs as never);
    expect(out).toContain("完全访问");
  });

  it("graphId 不存在或不归属 → 错误不落库", async () => {
    graphFirst.mockResolvedValueOnce(null);
    const out = await tool.execute(ctx(), graphArgs as never);
    expect(out).toContain("错误");
    expect(out).toContain("list_workflows");
    expect(createTask).not.toHaveBeenCalled();
  });
});
