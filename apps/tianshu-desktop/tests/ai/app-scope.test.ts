// tests/ai/app-scope.test.ts
/**
 * 会话应用作用域（切片 C P1）单测：
 * - resolveSessionAppScope：未绑定 null / 绑定解析 graphIds 集合 / 悬空
 *   绑定 dangling / 非法 JSON 容错空集
 * - workflow_read 清单：作用域收窄 + 注记（LLM 感知）；悬空回退全量带提示；
 *   未绑定零行为变化
 * - run_workflow：集合外拒绝（作用域闸）、集合内放行
 * - workflow_write 新建：应用会话内自动入集（去重）、回执注记；悬空不入集
 * - AppRepository：CRUD 校验与删除时解绑引用会话（appId 置 null）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // 安全批：密封链引 safeStorage（降级形态——master-key 走 hex 路径）
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
    decryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
  }, ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    appDefinition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import {
  makeRunWorkflowTool,
  makeWorkflowReadTool,
  makeWorkflowWriteTool,
  resolveSessionAppScope,
  type AppDefinitionPrismaLike,
} from "../../electron/domains/ai/orchestration/create-workflow";
import { AppRepository } from "../../electron/domains/ai/apps/app.repo";
import prisma from "../../electron/commons/prisma-client";

const CTX = { workspacePath: "/ws", sessionId: 42 };

const VALID_GRAPH = {
  version: 1,
  inputSchema: {},
  nodes: [
    { id: "start", name: "开始", kind: "start", variables: [] },
    {
      id: "gen",
      name: "生成",
      kind: "llm",
      modelId: 1,
      prompt: "p",
      outputMode: "text",
    },
  ],
  edges: [
    { from: "start", to: "gen" },
    { from: "gen", to: "END" },
  ],
};

/** 装配：会话 userId=7、appId 可配；应用行可配 */
const makeStubs = (
  over: {
    sessionId?: number | null;
    appId?: number | null;
    appRow?: { id: number; name: string; graphIds: string } | null;
  } = {},
) => {
  const session = {
    findUnique: vi.fn(async () => ({
      userId: 7,
      appId: over.appId ?? null,
    })),
  };
  const app: AppDefinitionPrismaLike = {
    findFirst: vi.fn(async () => over.appRow ?? null),
    update: vi.fn(async () => ({})),
  };
  const graphs = [
    { id: 1, name: "记账·记一笔", description: null },
    { id: 2, name: "记账·查账明细", description: null },
    { id: 3, name: "无关图", description: null },
  ];
  const graphDefinition = {
    findMany: vi.fn(async () => graphs),
    findFirst: vi.fn(
      async ({ where }: { where: { id: number } }) =>
        graphs.find((g) => g.id === where.id) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: { name: string } }) => ({
      id: 9,
      name: data.name,
    })),
  };
  const workspace = {
    findFirst: vi.fn(async () => ({ id: 5, directoryPath: "/ws" })),
  };
  return { session, app, graphDefinition, workspace };
};

const appRow = (graphIds: string = "[1,2]") => ({
  id: 11,
  name: "记账应用",
  graphIds,
});

const appDelegate = prisma.appDefinition as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSessionAppScope（作用域解析）", () => {
  it("无会话上下文 / app delegate 缺席 / 未绑定 → null（零行为变化）", async () => {
    const { session, app } = makeStubs({ appId: 11 });
    expect(
      await resolveSessionAppScope({ sessionId: null }, session, app, 7),
    ).toBeNull();
    expect(
      await resolveSessionAppScope({ sessionId: 42 }, session, undefined, 7),
    ).toBeNull();
    const unbound = makeStubs({ appId: null });
    expect(
      await resolveSessionAppScope(
        { sessionId: 42 },
        unbound.session,
        unbound.app,
        7,
      ),
    ).toBeNull();
  });

  it("绑定命中：graphIds 解析为集合；悬空绑定 dangling=true", async () => {
    const bound = makeStubs({ appId: 11, appRow: appRow() });
    const scope = await resolveSessionAppScope(
      { sessionId: 42 },
      bound.session,
      bound.app,
      7,
    );
    expect(scope).toMatchObject({ appId: 11, name: "记账应用" });
    expect([...scope!.graphIds]).toEqual([1, 2]);
    expect(scope!.dangling).toBe(false);
    const dangling = makeStubs({ appId: 11, appRow: null });
    const scope2 = await resolveSessionAppScope(
      { sessionId: 42 },
      dangling.session,
      dangling.app,
      7,
    );
    expect(scope2).toMatchObject({ appId: 11, dangling: true });
    expect(scope2!.graphIds.size).toBe(0);
  });

  it("graphIds 非法 JSON / 非整数混入容错过滤", async () => {
    const broken = makeStubs({ appId: 11, appRow: appRow("{oops") });
    const scope = await resolveSessionAppScope(
      { sessionId: 42 },
      broken.session,
      broken.app,
      7,
    );
    expect(scope!.graphIds.size).toBe(0);
    const dirty = makeStubs({ appId: 11, appRow: appRow('[1,"a",2.5,3]') });
    const scope2 = await resolveSessionAppScope(
      { sessionId: 42 },
      dirty.session,
      dirty.app,
      7,
    );
    expect([...scope2!.graphIds]).toEqual([1, 3]);
  });
});

describe("workflow_read 清单作用域收窄", () => {
  it("应用会话仅列集合内工作流并注记", async () => {
    const stubs = makeStubs({ appId: 11, appRow: appRow("[1,2]") });
    const tool = makeWorkflowReadTool(stubs as never);
    const result = await tool.execute(CTX, {});
    expect(result).toContain("已绑定应用「记账应用」");
    expect(result).toContain("id=1 记账·记一笔");
    expect(result).toContain("id=2 记账·查账明细");
    expect(result).not.toContain("id=3");
  });

  it("集合空 → 明示应用内暂无；悬空绑定回退全量带提示；未绑定原样", async () => {
    const empty = makeStubs({ appId: 11, appRow: appRow("[]") });
    const toolEmpty = makeWorkflowReadTool(empty as never);
    expect(await toolEmpty.execute(CTX, {})).toContain("暂无工作流");
    const dangling = makeStubs({ appId: 11, appRow: null });
    const toolDangling = makeWorkflowReadTool(dangling as never);
    const result = await toolDangling.execute(CTX, {});
    expect(result).toContain("id=3 无关图");
    expect(result).toContain("应用已不存在");
    const plain = makeStubs({});
    const toolPlain = makeWorkflowReadTool(plain as never);
    const plainResult = await toolPlain.execute(CTX, {});
    expect(plainResult).toContain("id=3");
    expect(plainResult).not.toContain("绑定");
  });
});

describe("run_workflow 作用域闸", () => {
  const launch = vi.fn();

  it("集合外拒绝（不触发 launch）；集合内放行", async () => {
    const stubs = makeStubs({ appId: 11, appRow: appRow("[1]") });
    const tool = makeRunWorkflowTool({ ...stubs, launch } as never);
    const blocked = await tool.execute(CTX, { id: 3 });
    expect(blocked).toContain("不在当前应用「记账应用」的作用域内");
    expect(launch).not.toHaveBeenCalled();
    const ok = await tool.execute(CTX, { id: 1 });
    expect(ok).toContain("已启动");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("悬空绑定不拦（应用已删按未作用域处理）", async () => {
    const stubs = makeStubs({ appId: 11, appRow: null });
    const tool = makeRunWorkflowTool({ ...stubs, launch } as never);
    expect(await tool.execute(CTX, { id: 3 })).toContain("已启动");
  });
});

describe("workflow_write 新建应用会话自动入集", () => {
  it("绑定 → graphIds 追加新图（去重）且回执注记；悬空/未绑定不入集", async () => {
    const bound = makeStubs({ appId: 11, appRow: appRow("[1]") });
    const tool = makeWorkflowWriteTool(bound as never);
    const result = await tool.execute(CTX, {
      name: "新图",
      graphJson: VALID_GRAPH,
    });
    expect(result).toContain("已加入应用「记账应用」");
    expect(bound.app.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { graphIds: "[1,9]" },
    });
    const dangling = makeStubs({ appId: 11, appRow: null });
    const toolDangling = makeWorkflowWriteTool(dangling as never);
    const r2 = await toolDangling.execute(CTX, {
      name: "悬空图",
      graphJson: VALID_GRAPH,
    });
    expect(r2).not.toContain("已加入应用");
    expect(dangling.app.update).not.toHaveBeenCalled();
  });
});

describe("AppRepository（CRUD 与删除解绑）", () => {
  const repo = new AppRepository();
  const row = (graphIds = "[1,2]") => ({
    id: 11,
    name: "记账应用",
    description: null,
    graphIds,
    createdAt: new Date("2026-10-29T08:00:00Z"),
    updatedAt: new Date("2026-10-29T08:00:00Z"),
    userId: 7,
  });

  it("parseGraphIds：合法解析 / 非法 JSON / 非整数过滤", () => {
    expect(AppRepository.parseGraphIds("[3,4]")).toEqual([3, 4]);
    expect(AppRepository.parseGraphIds("oops")).toEqual([]);
    expect(AppRepository.parseGraphIds('[1,"x"]')).toEqual([1]);
  });

  it("create 名称空拒绝；graphIds 编码入库且回执解码", async () => {
    await expect(repo.create({ name: " " }, 7)).rejects.toThrow("名称不能为空");
    appDelegate.create.mockResolvedValue(row("[3]"));
    const record = await repo.create({ name: "应用", graphIds: "[3]" }, 7);
    expect(appDelegate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        graphIds: "[3]",
        userId: 7,
      }),
    });
    expect(record.graphIds).toEqual([3]);
    expect(record).not.toHaveProperty("password");
  });

  it("delete：先解绑引用会话（appId 置 null）再删行；他人应用 APP_NOT_FOUND", async () => {
    appDelegate.findFirst.mockResolvedValue(null);
    await expect(repo.delete(11, 7)).rejects.toThrow("APP_NOT_FOUND");
    appDelegate.findFirst.mockResolvedValue(row());
    await repo.delete(11, 7);
    const calls = [
      (prisma.session.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0],
      appDelegate.delete.mock.calls[0][0],
    ];
    expect(calls[0]).toEqual({
      where: { appId: 11 },
      data: { appId: null },
    });
    expect(calls[1]).toEqual({ where: { id: 11 } });
  });
});
