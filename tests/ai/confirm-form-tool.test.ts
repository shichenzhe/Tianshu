// tests/ai/confirm-form-tool.test.ts
/**
 * confirm_form 内置工具（工作流执行前的人确认卡）：
 * - 挂起决议流：execute 阻塞 → confirmForms.respond 决议（confirm 带编辑
 *   值触发 run_workflow 执行体；cancel 不执行回取消回执）
 * - 表单值按声明键收口（决议夹带未声明键丢弃；缺失键回退预填值）
 * - 前置校验：无会话上下文/工作流不存在结构化拒绝
 * - ConfirmFormCoordinator：覆盖式单飞、voidAll 作废、超时自动取消
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: {}, ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/domains/ai/agent/tool-registry", () => ({
  registry: { find: vi.fn(() => undefined) },
}));

import {
  makeConfirmFormTool,
  type RunWorkflowExecutor,
} from "../../electron/domains/ai/agent/confirm-form-tool";
import {
  ConfirmFormCoordinator,
  confirmForms,
} from "../../electron/domains/ai/agent/confirm-registry";
import { CONFIRM_FORM_TOOL_NAME } from "../../src-react/domains/ai/chat/lib/group-blocks";

const CTX = { workspacePath: "/ws", sessionId: 42, userId: 7 };

const stubs = {
  graphDefinition: {
    findFirst: vi.fn(async () => ({ id: 3, name: "记账·记一笔" })),
  },
  session: {
    findUnique: vi.fn(async () => ({ userId: 7 })),
  },
};

const fields = [
  { key: "amount", label: "金额", value: "35" },
  { key: "note", label: "备注", value: "午饭" },
];

afterEach(() => {
  confirmForms.voidAll();
  vi.clearAllMocks();
});

describe("confirm_form 工具", () => {
  it("命名与 kind：confirm_form / read（卡本身即人工门，免审批触发）", () => {
    const tool = makeConfirmFormTool({
      ...(stubs as never),
      runWorkflow: vi.fn(),
    });
    expect(tool.name).toBe(CONFIRM_FORM_TOOL_NAME);
    expect(tool.kind).toBe("read");
  });

  it("确认：编辑值经声明键收口后直调 run_workflow 执行体（回执拼装）", async () => {
    const runWorkflow = vi.fn<
      Parameters<RunWorkflowExecutor>,
      ReturnType<RunWorkflowExecutor> extends Promise<infer R>
        ? Promise<R>
        : never
    >(async (_ctx, args) => `已启动试运行（id=${args.id}）`);
    const tool = makeConfirmFormTool({
      ...(stubs as never),
      runWorkflow,
    });
    const pending = tool.execute(CTX, {
      workflowId: 3,
      fields,
    });
    await vi.waitFor(() => expect(confirmForms.pendingCount).toBe(1));
    // 决议夹带未声明键 evil——收口丢弃；amount 用编辑值、note 缺失回退预填
    confirmForms.respond(42, {
      action: "confirm",
      values: { amount: "40", evil: "1" },
    });
    const result = await pending;
    expect(result).toContain("用户已在确认卡上确认");
    expect(result).toContain("已启动试运行");
    expect(runWorkflow).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        id: 3,
        inputs: { amount: "40", note: "午饭" },
      }),
    );
  });

  it("取消：不触发执行体，回执告知模型勿重试", async () => {
    const runWorkflow = vi.fn(async () => "不应到达");
    const tool = makeConfirmFormTool({
      ...(stubs as never),
      runWorkflow,
    });
    const pending = tool.execute(CTX, { workflowId: 3, fields });
    await vi.waitFor(() => expect(confirmForms.pendingCount).toBe(1));
    confirmForms.respond(42, { action: "cancel" });
    expect(await pending).toContain("用户已取消");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("前置校验：无会话上下文 / 工作流不存在结构化拒绝（不挂起）", async () => {
    const runWorkflow = vi.fn(async () => "");
    const tool = makeConfirmFormTool({
      ...(stubs as never),
      runWorkflow,
    });
    const noSession = await tool.execute(
      { ...CTX, sessionId: null },
      { workflowId: 3, fields },
    );
    expect(noSession).toContain("无会话上下文");
    stubs.graphDefinition.findFirst.mockResolvedValueOnce(null);
    const missing = await tool.execute(CTX, { workflowId: 99, fields });
    expect(missing).toContain("工作流不存在");
    expect(confirmForms.pendingCount).toBe(0);
  });

  it("参数 schema（切片 D4）：fields 带 type/enumValues 通过，type 越界拒绝", () => {
    const tool = makeConfirmFormTool({
      ...(stubs as never),
      runWorkflow: vi.fn(),
    });
    expect(
      tool.parameters.safeParse({
        workflowId: 3,
        fields: [
          {
            key: "category",
            label: "类别",
            value: "餐饮",
            type: "enum",
            enumValues: ["餐饮", "交通"],
          },
          { key: "amount", label: "金额", value: "35", type: "number" },
        ],
      }).success,
    ).toBe(true);
    expect(
      tool.parameters.safeParse({
        workflowId: 3,
        fields: [{ key: "a", label: "A", value: "1", type: "float" }],
      }).success,
    ).toBe(false);
  });

  it("参数 schema：fields 必填 1-12 项、workflowId 正整数", () => {
    const tool = makeConfirmFormTool({
      ...(stubs as never),
      runWorkflow: vi.fn(),
    });
    expect(tool.parameters.safeParse({ workflowId: 3, fields }).success).toBe(
      true,
    );
    expect(
      tool.parameters.safeParse({ workflowId: 3, fields: [] }).success,
    ).toBe(false);
    expect(tool.parameters.safeParse({ fields }).success).toBe(false);
    expect(tool.parameters.safeParse({ workflowId: 0, fields }).success).toBe(
      false,
    );
  });
});

describe("ConfirmFormCoordinator（挂起协调）", () => {
  it("同会话覆盖式单飞：新请求作废旧挂起（cancel 决议旧 promise）", async () => {
    const coordinator = new ConfirmFormCoordinator();
    const first = coordinator.request(1, {
      workflowId: 1,
      workflowName: "a",
      fields: [],
    });
    const second = coordinator.request(1, {
      workflowId: 2,
      workflowName: "b",
      fields: [],
    });
    await expect(first).resolves.toEqual({ action: "cancel" });
    expect(coordinator.pendingCount).toBe(1);
    coordinator.respond(1, { action: "cancel" });
    await expect(second).resolves.toEqual({ action: "cancel" });
  });

  it("respond 未命中返回 false；voidAll 全量作废", async () => {
    const coordinator = new ConfirmFormCoordinator();
    expect(coordinator.respond(9, { action: "cancel" })).toBe(false);
    const p = coordinator.request(2, {
      workflowId: 1,
      workflowName: "a",
      fields: [],
    });
    expect(coordinator.voidAll()).toBe(1);
    await expect(p).resolves.toEqual({ action: "cancel" });
    expect(coordinator.pendingCount).toBe(0);
  });

  it("超时自动取消（短超时注入验证）", async () => {
    const coordinator = new ConfirmFormCoordinator();
    const p = coordinator.request(
      3,
      { workflowId: 1, workflowName: "a", fields: [] },
      10,
    );
    await expect(p).resolves.toEqual({ action: "cancel" });
  });
});
