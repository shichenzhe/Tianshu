/**
 * plan-item 工具组单测（项目模块子系统 F T2）：deps 注入内存 stub（零 vi.mock，
 * create-skill 先例——工具直调 execute），错误断言统一为「错误: ...」字符串回喂。
 * 假时钟固定 2026-09-15（appendAiSummary 日期前缀无跨午夜脆弱性，Task 1 先例）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlanTools } from "../../electron/domains/ai/agent/plan-tools";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

/** 内存行（stub 状态；仅工具消费到的列） */
interface StubRow {
  id: number;
  projectId: number | null;
  title: string;
  status: string;
  aiSummary: string | null;
  sortOrder: number;
}

/** 工具执行 ctx：项目会话缺省 projectId=11（undefined 用 omitCtx 显式表达） */
const ctx = (projectId: number | null = 11): ToolContext => ({
  workspacePath: "",
  sessionId: 1,
  projectId,
});

/** projectId 字段缺席形态（与 undefined 等价；非项目会话兜底兜到的就是它） */
const omitCtx = (): ToolContext => ({ workspacePath: "", sessionId: 1 });

/** 内存 prisma stub：记录 create/update/project 查询载荷，findFirst 恒空列 */
function makeDeps(rows: StubRow[] = []) {
  let seq = 100;
  const calls = {
    create: [] as Array<Record<string, unknown>>,
    update: [] as Array<{
      where: { id: number };
      data: Record<string, unknown>;
    }>,
    projectFindUnique: [] as Array<{ where: { id: number } }>,
  };
  const deps = {
    prisma: {
      planItem: {
        findUnique: async ({ where }: { where: { id: number } }) =>
          rows.find((row) => row.id === where.id) ?? null,
        findFirst: async () => null,
        findMany: async () => rows.filter((row) => row.projectId === 11),
        create: async (args: { data: Record<string, unknown> }) => {
          calls.create.push(args.data);
          const row: StubRow = {
            id: ++seq,
            projectId: args.data.projectId as number,
            title: args.data.title as string,
            status: args.data.status as string,
            aiSummary: null,
            sortOrder: args.data.sortOrder as number,
          };
          rows.push(row);
          return row;
        },
        update: async (args: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          calls.update.push(args);
          const row = rows.find((item) => item.id === args.where.id);
          if (row) {
            Object.assign(row, args.data);
          }
          return row ?? null;
        },
      },
      project: {
        findUnique: async (args: { where: { id: number } }) => {
          calls.projectFindUnique.push(args);
          return args.where.id === 11 ? { ownerId: 5 } : null;
        },
      },
    },
  };
  return { deps, calls, rows };
}

/** 按名取工具（三工具断言共用） */
const toolOf = (deps: ReturnType<typeof makeDeps>["deps"], name: string) => {
  const tool = makePlanTools(deps).find((def) => def.name === name);
  if (!tool) {
    throw new Error(`工具未定义: ${name}`);
  }
  return tool;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T10:30:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("plan 工具组元信息", () => {
  it("四工具 name/kind（三写一读）/描述含 #<id> 引用与结构化清单锚点（建/流转含 plan_append_summary 教学）", () => {
    const tools = makePlanTools(makeDeps().deps);
    expect(tools.map((tool) => tool.name)).toEqual([
      "plan_create_item",
      "plan_update_status",
      "plan_append_summary",
      "plan_list_items",
    ]);
    for (const tool of tools.slice(0, 3)) {
      expect(tool.kind).toBe("write");
      expect(tool.description).toContain("#<id>");
    }
    expect(tools[3]?.kind).toBe("read");
    expect(tools[3]?.description).toContain("不要去文件系统寻找任务文件");
    expect(tools[0]?.description).toContain("plan_append_summary");
    expect(tools[1]?.description).toContain("plan_append_summary");
  });
});

describe("projectId 门槛（非项目会话三工具均拒绝）", () => {
  it.each([
    ["null", ctx(null)],
    ["字段缺席", omitCtx()],
  ])(
    "projectId=%s → 错误: 当前会话未关联项目（不触任何 prisma 写）",
    async (_label, testCtx) => {
      const { deps, calls } = makeDeps();
      for (const name of [
        "plan_create_item",
        "plan_update_status",
        "plan_append_summary",
      ]) {
        const args =
          name === "plan_create_item"
            ? { title: "t" }
            : name === "plan_update_status"
              ? { id: 1, status: "in_progress" }
              : { id: 1, text: "进展" };
        await expect(toolOf(deps, name).execute(testCtx, args)).resolves.toBe(
          "错误: 当前会话未关联项目",
        );
      }
      expect(calls.create).toEqual([]);
      expect(calls.update).toEqual([]);
    },
  );
});

describe("plan_create_item", () => {
  it("创建成功：source=ai/projectId=11/assigneeId=null/createdById=项目 owner，结果含新 id", async () => {
    const { deps, calls } = makeDeps();
    const out = await toolOf(deps, "plan_create_item").execute(ctx(), {
      title: "搭建登录页",
      dueDate: "2026-09-20",
      tags: ["前端", "v1"],
    });

    expect(out).toBe("已创建任务 #101《搭建登录页》");
    expect(calls.create[0]).toMatchObject({
      projectId: 11,
      title: "搭建登录页",
      status: "not_started",
      priority: "P1",
      assigneeId: null,
      description: null,
      startDate: null,
      source: "ai",
      createdById: 5,
      sortOrder: 1,
    });
    expect(calls.create[0].tags).toBe(JSON.stringify(["前端", "v1"]));
    expect(calls.create[0].dueDate).toEqual(
      new Date("2026-09-20T00:00:00.000Z"),
    );
  });

  it("可选参数缺省：priority 透传、未传 tags/dueDate 不写该列", async () => {
    const { deps, calls } = makeDeps();
    const out = await toolOf(deps, "plan_create_item").execute(ctx(), {
      title: "联调接口",
      priority: "P0",
    });

    expect(out).toBe("已创建任务 #101《联调接口》");
    expect(calls.create[0]).toMatchObject({ priority: "P0" });
    // 未传 tags：键值 undefined（prisma 不写该列，与 PlanItemRepository.stringifyColumn 同语义）
    expect(calls.create[0].tags).toBeUndefined();
    expect(calls.create[0].dueDate).toBeNull();
  });

  it("title 空串/纯空白 → 错误: 标题不能为空（execute 层校验，不触库）", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      toolOf(deps, "plan_create_item").execute(ctx(), { title: "" }),
    ).resolves.toBe("错误: 标题不能为空");
    await expect(
      toolOf(deps, "plan_create_item").execute(ctx(), { title: "   " }),
    ).resolves.toBe("错误: 标题不能为空");
    expect(calls.create).toEqual([]);
  });

  it("dueDate 非 yyyy-MM-dd → 错误文案，不建行", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      toolOf(deps, "plan_create_item").execute(ctx(), {
        title: "t",
        dueDate: "09-20-2026",
      }),
    ).resolves.toBe("错误: 无效的截止日期格式（应为 yyyy-MM-dd）");
    expect(calls.create).toEqual([]);
  });

  it("项目行缺失 → 错误: 项目不存在", async () => {
    const { deps } = makeDeps();
    await expect(
      toolOf(deps, "plan_create_item").execute(ctx(99), { title: "t" }),
    ).resolves.toBe("错误: 项目不存在");
  });
});

describe("plan_update_status", () => {
  const row = (): StubRow => ({
    id: 7,
    projectId: 11,
    title: "任务七",
    status: "not_started",
    aiSummary: null,
    sortOrder: 3,
  });

  it("本项目任务流转成功：status + 目标列尾 sortOrder，文案含中文态", async () => {
    const { deps, calls } = makeDeps([row()]);
    const out = await toolOf(deps, "plan_update_status").execute(ctx(), {
      id: 7,
      status: "in_progress",
    });

    expect(out).toBe("任务 #7 已流转为：进行中");
    expect(calls.update[0]).toEqual({
      where: { id: 7 },
      data: { status: "in_progress", sortOrder: 1 },
    });
  });

  it("同状态重推不重算列序（sortOrder 不在载荷）", async () => {
    const { deps, calls } = makeDeps([{ ...row(), status: "done" }]);
    await toolOf(deps, "plan_update_status").execute(ctx(), {
      id: 7,
      status: "done",
    });
    expect(calls.update[0]).toEqual({
      where: { id: 7 },
      data: { status: "done" },
    });
  });

  it.each([
    ["跨项目任务", { ...row(), projectId: 99 }],
    ["不存在任务", null],
  ])(
    "%s → 错误: 任务不存在或不属于当前项目（不写库）",
    async (_label, seed) => {
      const { deps, calls } = makeDeps(seed ? [seed] : []);
      await expect(
        toolOf(deps, "plan_update_status").execute(ctx(), {
          id: 7,
          status: "done",
        }),
      ).resolves.toBe("错误: 任务不存在或不属于当前项目");
      expect(calls.update).toEqual([]);
    },
  );
});

describe("plan_append_summary", () => {
  const row = (aiSummary: string | null): StubRow => ({
    id: 7,
    projectId: 11,
    title: "任务七",
    status: "in_progress",
    aiSummary,
    sortOrder: 1,
  });

  it("已有摘要追加一行（旧摘要 + [yyyy-MM-dd] text 两行回写），返回追加后末行", async () => {
    const { deps, calls } = makeDeps([row("[2026-09-14] 开始")]);
    const out = await toolOf(deps, "plan_append_summary").execute(ctx(), {
      id: 7,
      text: "完成接口联调",
    });

    expect(out).toBe("已记录进展 #7：[2026-09-15] 完成接口联调");
    expect(calls.update[0]).toEqual({
      where: { id: 7 },
      data: { aiSummary: "[2026-09-14] 开始\n[2026-09-15] 完成接口联调" },
    });
  });

  it("空摘要首行无前导换行", async () => {
    const { deps, calls } = makeDeps([row(null)]);
    await toolOf(deps, "plan_append_summary").execute(ctx(), {
      id: 7,
      text: "开始",
    });
    expect(calls.update[0].data.aiSummary).toBe("[2026-09-15] 开始");
  });

  it("text 纯空白 → 错误: 进展描述不能为空", async () => {
    const { deps, calls } = makeDeps([row(null)]);
    await expect(
      toolOf(deps, "plan_append_summary").execute(ctx(), { id: 7, text: "  " }),
    ).resolves.toBe("错误: 进展描述不能为空");
    expect(calls.update).toEqual([]);
  });

  it.each([
    ["跨项目任务", { ...row(null), projectId: 99 }],
    ["不存在任务", null],
  ])(
    "%s → 错误: 任务不存在或不属于当前项目（不写库）",
    async (_label, seed) => {
      const { deps, calls } = makeDeps(seed ? [seed] : []);
      await expect(
        toolOf(deps, "plan_append_summary").execute(ctx(), {
          id: 7,
          text: "进展",
        }),
      ).resolves.toBe("错误: 任务不存在或不属于当前项目");
      expect(calls.update).toEqual([]);
    },
  );
});

describe("plan_list_items（读工具：AI 查看全量清单）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T03:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("非项目会话 → 错误兜底（与其他工具同口径）", async () => {
    const { deps } = makeDeps();
    await expect(
      toolOf(deps, "plan_list_items").execute(omitCtx(), {}),
    ).resolves.toBe("错误: 当前会话未关联项目");
  });

  it("kind=read（免审批）且无参数 schema 消费", async () => {
    const { deps } = makeDeps();
    const tool = toolOf(deps, "plan_list_items");
    expect(tool?.kind).toBe("read");
    expect(tool?.name).toBe("plan_list_items");
  });

  it("返回项目内任务行（#id｜标题｜状态中文｜优先级｜截止｜来源｜末行进展），跨项目行排除", async () => {
    const { deps } = makeDeps([
      {
        id: 3,
        projectId: 11,
        title: "t2 联调",
        status: "not_started",
        aiSummary: "[2026-09-14] 启动\n[2026-09-15] 接口调研完成",
        sortOrder: 1,
      },
      {
        id: 4,
        projectId: 11,
        title: "无进展任务",
        status: "in_progress",
        aiSummary: null,
        sortOrder: 1,
      },
      {
        id: 9,
        projectId: 99,
        title: "他项目",
        status: "done",
        aiSummary: null,
        sortOrder: 1,
      },
    ]);
    const out = await toolOf(deps, "plan_list_items").execute(ctx(), {});
    expect(out).toContain("#3《t2 联调》｜待开始｜最近进展: 接口调研完成");
    expect(out).toContain("#4《无进展任务》｜进行中");
    expect(out).not.toContain("他项目");
    expect(out).toContain("共 2 项");
  });

  it("空清单 → 明确空态文本（AI 不再怀疑清单缺失）", async () => {
    const { deps } = makeDeps();
    const out = await toolOf(deps, "plan_list_items").execute(ctx(), {});
    expect(out).toContain("当前项目计划清单为空");
  });
});
