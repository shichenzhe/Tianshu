/**
 * plan-item 工具组单测（项目模块子系统 F T2；2026-10-29 工具名精简批次
 * 五件坍缩为 todo_write/todo_read）：deps 注入内存 stub（零 vi.mock，
 * create-skill 先例——工具直调 execute），错误断言统一为「错误: ...」
 * 字符串回喂。假时钟固定 2026-09-15（appendAiSummary 日期前缀无跨午夜
 * 脆弱性，Task 1 先例）。
 * todo_write 为批量写（无 omission-delete：计划清单人机共享，漏项即删
 * 会误删人类任务；进展行只增不改）。todo_read 二合一（无参=清单，
 * id=详情）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlanTools } from "../../electron/domains/ai/agent/plan-tools";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

/** 内存行（stub 状态；仅工具消费到的列） */
interface StubRow {
  id: number;
  projectId: number | null;
  title: string;
  description?: string | null;
  status: string;
  priority?: string;
  dueDate?: Date | null;
  source?: string;
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

/** 按名取工具（两工具断言共用） */
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

describe("工具组元信息（五件坍缩二件）", () => {
  it("todo_write(write) + todo_read(read)；防呆锚点两工具保留", () => {
    const tools = makePlanTools(makeDeps().deps);
    expect(tools.map((tool) => tool.name)).toEqual(["todo_write", "todo_read"]);
    expect(tools[0]?.kind).toBe("write");
    expect(tools[1]?.kind).toBe("read");
    // 结构化清单锚点（防文件系统误寻）挂在写/读两工具
    expect(tools[0]?.description).toContain("清单不在文件系统");
    expect(tools[1]?.description).toContain("清单不在文件系统");
    // 「推进后记录进展」教学收进 progress 字段自述（zod shape 访问取 describe）
    const progressField = (
      tools[0]?.parameters as unknown as {
        shape: {
          items: { element: { shape: { progress: { description?: string } } } };
        };
      }
    ).shape.items.element.shape.progress;
    expect(progressField.description).toContain("推进任务后");
  });
});

describe("projectId 门槛（非项目会话两工具均拒绝）", () => {
  it.each([
    ["null", ctx(null)],
    ["字段缺席", omitCtx()],
  ])(
    "projectId=%s → 错误: 当前会话未关联项目（不触任何 prisma 写）",
    async (_label, testCtx) => {
      const { deps, calls } = makeDeps();
      await expect(
        toolOf(deps, "todo_write").execute(testCtx, {
          items: [{ title: "t" }],
        }),
      ).resolves.toBe("错误: 当前会话未关联项目");
      await expect(
        toolOf(deps, "todo_read").execute(testCtx, { id: 1 }),
      ).resolves.toBe("错误: 当前会话未关联项目");
      expect(calls.create).toEqual([]);
      expect(calls.update).toEqual([]);
    },
  );
});

describe("todo_write 新建（无 id 项）", () => {
  it("创建成功：source=ai/projectId=11/assigneeId=null/createdById=项目 owner，结果含新 id", async () => {
    const { deps, calls } = makeDeps();
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [
        {
          title: "搭建登录页",
          dueDate: "2026-09-20",
          tags: ["前端", "v1"],
        },
      ],
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

  it("批量新建：多项一次落库，逐项结果行", async () => {
    const { deps, calls } = makeDeps();
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ title: "任务甲" }, { title: "任务乙", priority: "P0" }],
    });
    expect(out).toBe("已创建任务 #101《任务甲》\n已创建任务 #102《任务乙》");
    expect(calls.create).toHaveLength(2);
    expect(calls.create[1]).toMatchObject({ priority: "P0" });
  });

  it("新建项 title 缺失/空白 → 该项错误行（批量其余项不受影响）", async () => {
    const { deps, calls } = makeDeps();
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ title: "  " }, { title: "有效任务" }],
    });
    expect(out).toBe("错误: 第 1 项标题不能为空\n已创建任务 #101《有效任务》");
    expect(calls.create).toHaveLength(1);
  });

  it("dueDate 非 yyyy-MM-dd → 该项错误行，不建行", async () => {
    const { deps, calls } = makeDeps();
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ title: "t", dueDate: "09-20-2026" }],
    });
    expect(out).toBe("错误: 第 1 项无效的截止日期格式（应为 yyyy-MM-dd）");
    expect(calls.create).toEqual([]);
  });

  it("项目行缺失 → 错误: 项目不存在", async () => {
    const { deps } = makeDeps();
    await expect(
      toolOf(deps, "todo_write").execute(ctx(99), {
        items: [{ title: "t" }],
      }),
    ).resolves.toBe("错误: 项目不存在");
  });
});

describe("todo_write 更新（有 id 项：状态流转 + 进展追加）", () => {
  const row = (): StubRow => ({
    id: 7,
    projectId: 11,
    title: "任务七",
    status: "not_started",
    aiSummary: null,
    sortOrder: 3,
  });

  it("状态流转：status + 目标列尾 sortOrder，文案含中文态", async () => {
    const { deps, calls } = makeDeps([row()]);
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, status: "in_progress" }],
    });

    expect(out).toBe("任务 #7 已流转为：进行中");
    expect(calls.update[0]).toEqual({
      where: { id: 7 },
      data: { status: "in_progress", sortOrder: 1 },
    });
  });

  it("同状态重推不重算列序（sortOrder 不在载荷）", async () => {
    const { deps, calls } = makeDeps([{ ...row(), status: "done" }]);
    await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, status: "done" }],
    });
    expect(calls.update[0]).toEqual({
      where: { id: 7 },
      data: { status: "done" },
    });
  });

  it("进展追加（已有摘要追加一行回写），返回追加后末行", async () => {
    const { deps, calls } = makeDeps([
      { ...row(), status: "in_progress", aiSummary: "[2026-09-14] 开始" },
    ]);
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, progress: "完成接口联调" }],
    });

    expect(out).toBe("已记录进展 #7：[2026-09-15] 完成接口联调");
    expect(calls.update[0]).toEqual({
      where: { id: 7 },
      data: { aiSummary: "[2026-09-14] 开始\n[2026-09-15] 完成接口联调" },
    });
  });

  it("空摘要首行无前导换行", async () => {
    const { deps, calls } = makeDeps([row()]);
    await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, progress: "开始" }],
    });
    expect(calls.update[0].data.aiSummary).toBe("[2026-09-15] 开始");
  });

  it("状态 + 进展同项一次提交：两结果行", async () => {
    const { deps, calls } = makeDeps([row()]);
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, status: "in_progress", progress: "开工" }],
    });
    expect(out).toBe(
      "任务 #7 已流转为：进行中\n已记录进展 #7：[2026-09-15] 开工",
    );
    expect(calls.update).toHaveLength(2);
  });

  it("progress 纯空白 → 该项错误行", async () => {
    const { deps, calls } = makeDeps([row()]);
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, progress: "  " }],
    });
    expect(out).toBe("错误: 第 1 项进展描述不能为空");
    expect(calls.update).toEqual([]);
  });

  it.each([
    ["跨项目任务", { ...row(), projectId: 99 }],
    ["不存在任务", null],
  ])("%s → 该项错误行（不写库）", async (_label, seed) => {
    const { deps, calls } = makeDeps(seed ? [seed] : []);
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, status: "done" }],
    });
    expect(out).toBe("错误: 第 1 项任务不存在或不属于当前项目");
    expect(calls.update).toEqual([]);
  });

  it("有 id 项带 title → 该项错误行（暂不支持改标题，显式拒绝防静默忽略）", async () => {
    const { deps } = makeDeps([row()]);
    const out = await toolOf(deps, "todo_write").execute(ctx(), {
      items: [{ id: 7, title: "新标题" }],
    });
    expect(out).toBe("错误: 第 1 项暂不支持修改标题");
  });
});

describe("todo_read（无参=全量清单；id=详情）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T03:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("清单态：返回项目内任务行（#id｜标题｜状态中文｜末行进展），跨项目行排除", async () => {
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
    const out = await toolOf(deps, "todo_read").execute(ctx(), {});
    expect(out).toContain("#3《t2 联调》｜待开始｜最近进展: 接口调研完成");
    expect(out).toContain("#4《无进展任务》｜进行中");
    expect(out).not.toContain("他项目");
    expect(out).toContain("共 2 项");
  });

  it("空清单 → 明确空态文本（AI 不再怀疑清单缺失）", async () => {
    const { deps } = makeDeps();
    const out = await toolOf(deps, "todo_read").execute(ctx(), {});
    expect(out).toContain("当前项目计划清单为空");
  });

  it("详情态：本项目任务返回完整详情（含 [描述] 与全文 [进展]）", async () => {
    const { deps } = makeDeps([
      {
        id: 3,
        projectId: 11,
        title: "t2 联调",
        description: "# 目标\n打通登录联调链路",
        status: "not_started",
        priority: "P1",
        dueDate: new Date("2026-09-16T00:00:00.000Z"),
        source: "manual",
        aiSummary: "[2026-09-14] 启动",
        sortOrder: 1,
      },
    ]);
    const out = await toolOf(deps, "todo_read").execute(ctx(), { id: 3 });
    expect(out).toContain("#3《t2 联调》");
    expect(out).toContain("状态: 待开始");
    expect(out).toContain("优先级: P1");
    expect(out).toContain("截止: 2026-09-16");
    expect(out).toContain("[描述]\n# 目标\n打通登录联调链路");
    expect(out).toContain("[进展]\n[2026-09-14] 启动");
  });

  it("无描述/无进展 → 两块不渲染；跨项目/不存在 → 错误", async () => {
    const { deps } = makeDeps([
      {
        id: 4,
        projectId: 11,
        title: "裸任务",
        status: "in_progress",
        aiSummary: null,
        sortOrder: 1,
      },
    ]);
    const out = await toolOf(deps, "todo_read").execute(ctx(), { id: 4 });
    expect(out).toContain("#4《裸任务》");
    expect(out).not.toContain("[描述]");
    expect(out).not.toContain("[进展]");

    await expect(
      toolOf(deps, "todo_read").execute(ctx(), { id: 99 }),
    ).resolves.toBe("错误: 任务不存在或不属于当前项目");
  });
});
