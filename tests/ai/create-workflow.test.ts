// tests/ai/create-workflow.test.ts
/**
 * create_workflow / list_workflows 工具单测：graphJson 校验链（复用
 * validateGraph，结构化错误回传供模型自纠）+ session 反查 userId 落库 +
 * 重名冲突；list 返回 name/id 摘要。纯 Node 内存 stub prisma（先例
 * create-skill.test.ts）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
import {
  makeCreateWorkflowTool,
  makeGetWorkflowRunTool,
  makeGetWorkflowTool,
  makeListWorkflowsTool,
  makeRunWorkflowTool,
  makeUpdateWorkflowTool,
} from "../../electron/domains/ai/orchestration/create-workflow";
import { graphTestInflight } from "../../electron/domains/ai/orchestration/graph-inflight";

/** 合法双节点图（llm 起步串行） */
const VALID_GRAPH = {
  version: 1,
  inputSchema: { topic: "string" },
  nodes: [
    {
      id: "gen",
      name: "gen",
      kind: "code",
      language: "bash",
      script: 'echo "{{input.topic}}"',
    },
  ],
  edges: [{ from: "gen", to: "END" }],
};

interface GraphRow {
  id: number;
  name: string;
  description: string | null;
  graphJson: string;
  userId: number;
  version: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** prisma 结构子集 stub：graphDefinition.create/findMany + session 反查 */
function createStubs() {
  const graphs: GraphRow[] = [];
  let nextId = 1;
  const graphDefinition = {
    async create(args: {
      data: Omit<
        GraphRow,
        "id" | "version" | "enabled" | "createdAt" | "updatedAt"
      >;
    }) {
      if (graphs.some((row) => row.name === args.data.name)) {
        throw new Error("UNIQUE constraint failed: graphDefinition.name");
      }
      const row: GraphRow = {
        ...args.data,
        id: nextId++,
        version: 1,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      graphs.push(row);
      return row;
    },
    async findMany() {
      return [...graphs];
    },
    async findFirst(args: { where: { id: number; userId: number } }) {
      return (
        graphs.find(
          (row) => row.id === args.where.id && row.userId === args.where.userId,
        ) ?? null
      );
    },
    async updateMany(args: {
      where: { id: number; userId: number; version: number };
      data: Record<string, unknown>;
    }) {
      const row = graphs.find(
        (item) =>
          item.id === args.where.id &&
          item.userId === args.where.userId &&
          item.version === args.where.version,
      );
      if (!row) {
        return { count: 0 };
      }
      Object.assign(row, args.data);
      return { count: 1 };
    },
  };
  const session = {
    async findUnique(args: { where: { id: number } }) {
      return args.where.id === 42 ? { id: 42, userId: 7 } : null;
    },
  };
  const workspace = {
    async findFirst(args: { where: { directoryPath: string } }) {
      return args.where.directoryPath === "/ws"
        ? { id: 9, directoryPath: "/ws" }
        : null;
    },
  };
  return { graphDefinition, session, workspace, graphs };
}

const CTX = {
  workspacePath: "/ws",
  sessionId: 42,
} as Parameters<ReturnType<typeof makeCreateWorkflowTool>["execute"]>[0];

describe("create_workflow 工具", () => {
  it("合法图 → 落库（userId 经 session 反查）+ 成功回执含新图 id", async () => {
    const stubs = createStubs();
    const tool = makeCreateWorkflowTool(stubs as never);
    const result = await tool.execute(CTX, {
      name: "demo-flow",
      description: "示例",
      graphJson: VALID_GRAPH,
    });
    expect(result).toContain("成功");
    expect(result).toContain("1");
    expect(stubs.graphs).toHaveLength(1);
    expect(stubs.graphs[0].userId).toBe(7);
    // 无 start 图落库前自动补齐：start 打头 + start→入口边（存量语义）
    const saved = JSON.parse(stubs.graphs[0].graphJson);
    expect(saved.nodes[0].id).toBe("start");
    expect(saved.nodes.map((n: { id: string }) => n.id)).toContain("gen");
    expect(saved.edges).toContainEqual({ from: "start", to: "gen" });
  });

  it("无 start 的图（技能生成省略）→ 落库自动补 start 节点与入口边", async () => {
    const stubs = createStubs();
    const tool = makeCreateWorkflowTool(stubs as never);
    await tool.execute(CTX, { name: "no-start-flow", graphJson: VALID_GRAPH });
    const saved = JSON.parse(stubs.graphs[0].graphJson);
    expect(saved.nodes.some((n: { kind: string }) => n.kind === "start")).toBe(
      true,
    );
    expect(saved.edges).toContainEqual({ from: "start", to: "gen" });
  });

  it("非法图 → 回传结构化校验问题（供模型修正重试），不落库", async () => {
    const stubs = createStubs();
    const tool = makeCreateWorkflowTool(stubs as never);
    // 双入口 + 悬空边 + 空 prompt：多类问题一次暴露
    const result = await tool.execute(CTX, {
      name: "bad-flow",
      graphJson: {
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: "a",
            name: "a",
            kind: "code",
            language: "bash",
            script: "echo 1",
          },
          {
            id: "b",
            name: "b",
            kind: "code",
            language: "bash",
            script: "echo 2",
          },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
          { from: "ghost", to: "a" },
        ],
      },
    });
    expect(result).toContain("校验未通过");
    expect(result).toContain("uniqueEntry");
    expect(result).toContain("danglingEdge");
    expect(stubs.graphs).toHaveLength(0);
  });

  it("session 不存在 → 明确错误（不落库）", async () => {
    const stubs = createStubs();
    const tool = makeCreateWorkflowTool(stubs as never);
    const result = await tool.execute(
      { ...CTX, sessionId: 999 },
      { name: "x", graphJson: VALID_GRAPH },
    );
    expect(result).toContain("错误");
    expect(stubs.graphs).toHaveLength(0);
  });

  it("重名 → 冲突提示引导换名", async () => {
    const stubs = createStubs();
    const tool = makeCreateWorkflowTool(stubs as never);
    await tool.execute(CTX, {
      name: "dup",
      graphJson: VALID_GRAPH,
    });
    const second = await tool.execute(CTX, {
      name: "dup",
      graphJson: VALID_GRAPH,
    });
    expect(second).toContain("已存在");
    expect(stubs.graphs).toHaveLength(1);
  });

  it("创建成功 → notify 恰一次（渲染层列表失效）；失败路径不 notify", async () => {
    const stubs = createStubs();
    const notify = vi.fn();
    const tool = makeCreateWorkflowTool({ ...stubs, notify } as never);
    await tool.execute(CTX, { name: "n-flow", graphJson: VALID_GRAPH });
    expect(notify).toHaveBeenCalledTimes(1);
    // 校验失败（不落库）与重名冲突（不落库）都不通知
    await tool.execute(CTX, {
      name: "bad",
      graphJson: { version: 1, inputSchema: {}, nodes: [], edges: [] },
    });
    await tool.execute(CTX, { name: "n-flow", graphJson: VALID_GRAPH });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("list_workflows 工具", () => {
  it("返回用户已有图清单（id/name——iterate/subflow 引用 graphId 用）", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "flow-a", graphJson: VALID_GRAPH });
    await create.execute(CTX, { name: "flow-b", graphJson: VALID_GRAPH });
    const list = makeListWorkflowsTool(stubs as never);
    const result = await list.execute(CTX, {});
    expect(result).toContain("flow-a");
    expect(result).toContain("flow-b");
    // 每行带 id 供 graphId 引用
    expect(result).toMatch(/id[:= ]1/);
  });

  it("无图 → 空清单提示", async () => {
    const stubs = createStubs();
    const list = makeListWorkflowsTool(stubs as never);
    const result = await list.execute(CTX, {});
    expect(result).toContain("暂无");
  });
});

describe("get_workflow 工具", () => {
  it("按 id 返回 version + graphJson；name 定位同效", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "g-flow", graphJson: VALID_GRAPH });
    const get = makeGetWorkflowTool(stubs as never);
    const byId = await get.execute(CTX, { id: 1 });
    expect(byId).toContain("version=1");
    expect(byId).toContain('"gen"');
    const byName = await get.execute(CTX, { name: "g-flow" });
    expect(byName).toContain("graphJson");
  });

  it("不存在 / 缺参 → 明确错误", async () => {
    const stubs = createStubs();
    const get = makeGetWorkflowTool(stubs as never);
    expect(await get.execute(CTX, { id: 99 })).toContain("不存在");
    expect(await get.execute(CTX, {})).toContain("至少提供一个");
  });
});

describe("update_workflow 工具", () => {
  it("携正确 version → 更新成功且 version+1", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "u-flow", graphJson: VALID_GRAPH });
    const update = makeUpdateWorkflowTool(stubs as never);
    const result = await update.execute(CTX, {
      id: 1,
      version: 1,
      description: "改过的说明",
      graphJson: {
        ...VALID_GRAPH,
        nodes: [
          ...VALID_GRAPH.nodes,
          {
            id: "extra",
            name: "extra",
            kind: "notify",
            title: "done",
          },
        ],
        edges: [
          { from: "gen", to: "extra" },
          { from: "extra", to: "END" },
        ],
      },
    });
    expect(result).toContain("成功");
    expect(result).toContain("version=2");
    // update 路径同样补齐 start：gen+extra 2 业务节点 + start = 3
    const updated = JSON.parse(stubs.graphs[0].graphJson);
    expect(updated.nodes).toHaveLength(3);
    expect(updated.edges).toContainEqual({ from: "start", to: "gen" });
    expect(stubs.graphs[0].description).toBe("改过的说明");
  });

  it("版本冲突 → 回传当前 version 引导重取；非法图回传校验问题", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "c-flow", graphJson: VALID_GRAPH });
    const update = makeUpdateWorkflowTool(stubs as never);
    const conflict = await update.execute(CTX, {
      id: 1,
      version: 5,
      name: "x",
    });
    expect(conflict).toContain("版本冲突");
    expect(conflict).toContain("version=1");
    const invalid = await update.execute(CTX, {
      id: 1,
      version: 1,
      graphJson: { version: 1, inputSchema: {}, nodes: [], edges: [] },
    });
    expect(invalid).toContain("校验未通过");
  });

  it("更新成功 → notify 恰一次；版本冲突不 notify", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "un-flow", graphJson: VALID_GRAPH });
    const notify = vi.fn();
    const update = makeUpdateWorkflowTool({ ...stubs, notify } as never);
    const ok = await update.execute(CTX, {
      id: 1,
      version: 1,
      name: "改名",
    });
    expect(ok).toContain("成功");
    expect(notify).toHaveBeenCalledTimes(1);
    const conflict = await update.execute(CTX, {
      id: 1,
      version: 9,
      name: "x",
    });
    expect(conflict).toContain("版本冲突");
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("run_workflow 工具（异步触发）", () => {
  it("触发即返回「已启动」，launch 恰好一次且不等待结果", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "r-flow", graphJson: VALID_GRAPH });
    const launch = vi.fn();
    const run = makeRunWorkflowTool({ ...stubs, launch } as never);
    const result = await run.execute(CTX, { id: 1, inputs: { topic: "x" } });
    expect(result).toContain("已启动");
    expect(result).toContain("get_workflow_run");
    expect(launch).toHaveBeenCalledTimes(1);
    const params = launch.mock.calls[0][0];
    expect(params.inputs).toEqual({ topic: "x" });
    expect(params.workspace).toEqual({ id: 9, directoryPath: "/ws" });
  });

  it("在途互斥 GRAPH_ALREADY_RUNNING 前置拦截", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "m-flow", graphJson: VALID_GRAPH });
    graphTestInflight.set(1, new AbortController());
    try {
      const launch = vi.fn();
      const run = makeRunWorkflowTool({ ...stubs, launch } as never);
      const result = await run.execute(CTX, { id: 1 });
      expect(result).toContain("正在运行");
      expect(launch).not.toHaveBeenCalled();
    } finally {
      graphTestInflight.delete(1);
    }
  });

  it("图不存在 / 无 workspacePath / workspace 记录缺失 → 明确错误", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "w-flow", graphJson: VALID_GRAPH });
    const launch = vi.fn();
    const run = makeRunWorkflowTool({ ...stubs, launch } as never);
    expect(await run.execute(CTX, { id: 99 })).toContain("不存在");
    expect(
      await run.execute({ ...CTX, workspacePath: "" }, { id: 1 }),
    ).toContain("未绑定工作空间");
    expect(
      await run.execute({ ...CTX, workspacePath: "/other" }, { id: 1 }),
    ).toContain("工作空间记录");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("get_workflow_run 工具", () => {
  it("查最近一条 run：状态/耗时/终点输出预览", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "gr-flow", graphJson: VALID_GRAPH });
    const runs = {
      findFirst: vi.fn(async () => ({
        id: 9,
        status: "success",
        error: null,
        // graphTrace 真实形态（executor traceSuccess）：id/name/outputPreview，
        // 无 output 字段——get_workflow_run 须读 outputPreview
        graphTrace: JSON.stringify([
          { id: "a", name: "A", status: "success", outputPreview: "hello" },
          { id: "b", name: "B", status: "success", outputPreview: "world" },
        ]),
        startedAt: new Date("2026-10-08T10:00:00Z"),
        durationMs: 12300,
      })),
    };
    const tool = makeGetWorkflowRunTool({ ...stubs, runs } as never);
    const result = await tool.execute(CTX, { id: 1 });
    expect(result).toContain("success");
    expect(result).toContain("耗时: 12.3s");
    expect(result).toContain("world");
  });

  it("失败 run 带 error；无记录明示", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "gf-flow", graphJson: VALID_GRAPH });
    const runs = {
      findFirst: vi.fn(async () => ({
        id: 10,
        status: "failed",
        error: "llm_timeout: 模型调用超时",
        graphTrace: null,
        startedAt: new Date(),
        durationMs: null,
      })),
    };
    const tool = makeGetWorkflowRunTool({ ...stubs, runs } as never);
    const failed = await tool.execute(CTX, { id: 1 });
    expect(failed).toContain("llm_timeout");
    // 未结束（durationMs null）→ 耗时占位 -
    expect(failed).toContain("耗时: -");
    runs.findFirst.mockResolvedValue(null);
    expect(await tool.execute(CTX, { id: 1 })).toContain("暂无运行记录");
  });
});

describe("create_workflow 工具（末节点断头自愈）", () => {
  it("末节点不连 END → 落库补 start 入口边与叶子 END 边", async () => {
    const stubs = createStubs();
    const tool = makeCreateWorkflowTool(stubs as never);
    await tool.execute(CTX, {
      name: "dangling-tail-flow",
      graphJson: {
        ...VALID_GRAPH,
        edges: [], // 零边图：gen 冒充入口过校验（bug 同根因），且是断头叶子
      },
    });
    const saved = JSON.parse(stubs.graphs[0].graphJson);
    expect(saved.edges).toContainEqual({ from: "start", to: "gen" });
    expect(saved.edges).toContainEqual({ from: "gen", to: "END" });
  });
});
