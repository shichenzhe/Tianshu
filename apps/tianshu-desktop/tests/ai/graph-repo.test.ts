/**
 * graph.repo 纯派生与保存期校验单测（IPC/DB 副作用走冒烟）。
 * repo 顶层 import prisma-client（模块加载即建 SQLite 连接）、Log、
 * electron ipcMain——vitest 里 import 即崩，沿用 automation-repo.test.ts
 * 的 mock 三件套隔离；graph-executor / automation-event-bus 重依赖链
 * （LangChain、chat.service）整体模块 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-repo-test-user-data-${process.pid}`),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    graphDefinition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    automationTask: { findMany: vi.fn() },
    automationRun: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    graphRunNode: { findMany: vi.fn(), deleteMany: vi.fn() },
    workspace: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../electron/domains/ai/orchestration/graph-executor", () => ({
  executeGraphRun: vi.fn(),
  // run_workflow 工具装配引用（repo 构造期消费）
  runGraphToResult: vi.fn(),
  polishNodePrompt: vi.fn(),
}));
vi.mock("../../electron/domains/ai/automation/automation-event-bus", () => ({
  publishAutomationEvent: vi.fn(),
}));
vi.mock("../../electron/domains/ai/orchestration/webhook-server", () => ({
  unregisterWebhook: vi.fn(),
  registerWebhook: vi.fn(),
  getWebhookRegistration: vi.fn(),
  stopWebhookServer: vi.fn(),
  ensureWebhookServer: vi.fn(async () => 27400),
  setWebhookDisabledTools: vi.fn(),
  parseBody: vi.fn(),
}));

import GraphRepository, {
  toGraphRecord,
} from "../../electron/domains/ai/orchestration/graph.repo";
import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";
import { app, dialog } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { graphTestInflight } from "../../electron/domains/ai/orchestration/graph-inflight";
import { unregisterWebhook } from "../../electron/domains/ai/orchestration/webhook-server";

/** 测试用户 id（graphDefinition 按 userId 隔离，repo 方法末位参数） */
const UID = 1;

// 导入/导出用例以 mock 的 userData 为落盘工作目录（pid 隔离路径每轮
// 新建）——真实 app 该目录必然存在，测试侧对齐前置（历史固定路径靠
// 残留目录「碰巧存在」是预存红的根因之一）
await fs.mkdir(app.getPath("userData"), { recursive: true });

/** 合法图（双节点串行，唯一入口 collect）——校验通过用例的基准 */
const validGraphJson = JSON.stringify({
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: "collect",
      name: "collect",
      kind: "llm",
      modelId: 3,
      prompt: "汇总要点",
      tools: false,
      outputMode: "text",
    },
    {
      id: "report",
      name: "report",
      kind: "llm",
      modelId: 3,
      prompt: "成文",
      tools: false,
      outputMode: "text",
    },
  ],
  edges: [
    { from: "collect", to: "report" },
    { from: "report", to: "END" },
  ],
});

const graphRow = {
  id: 5,
  name: "调研成文",
  description: null,
  graphJson: validGraphJson,
  version: 1,
  enabled: true,
  userId: UID,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

describe("toGraphRecord 派生", () => {
  it("nodeCount 由 graphJson.nodes 派生；description null → undefined", () => {
    const rec = toGraphRecord(graphRow);
    expect(rec.nodeCount).toBe(2);
    expect(rec.description).toBeUndefined();
    expect(rec.createdAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("历史脏行坏 JSON 容错 nodeCount=0，不炸列表", () => {
    expect(toGraphRecord({ ...graphRow, graphJson: "{oops" }).nodeCount).toBe(
      0,
    );
  });
});

describe("deleteGraph 删除引用检查", () => {
  it("被本人 graph 任务引用 → GRAPH_IN_USE:引用任务名清单，不进事务", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      { name: "早报图任务" },
      { name: "周报图任务" },
    ] as never);
    // 引用链扩展查询（eventJson 非空任务 / 其他图 graphJson）补空 mock
    vi.mocked(prisma.graphDefinition.findMany).mockResolvedValue([] as never);
    const repo = new GraphRepository();
    await expect(repo["deleteGraph"](5, UID)).rejects.toThrowError(
      "GRAPH_IN_USE:早报图任务,周报图任务",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("非本人图 → graph not found，不进事务（run 无 userId 列，防跨用户删运行史）", async () => {
    // mock 历史跨用例累积（文件无自动 reset，先例用 mockClear 清零）
    vi.mocked(prisma.automationTask.findMany).mockClear();
    vi.mocked(prisma.automationRun.deleteMany).mockClear();
    vi.mocked(prisma.$transaction).mockClear();
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(null);
    const repo = new GraphRepository();
    await expect(repo["deleteGraph"](9, UID)).rejects.toThrowError(
      "graph 9 not found",
    );
    expect(prisma.automationTask.findMany).not.toHaveBeenCalled();
    expect(prisma.automationRun.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("无引用 → 事务先删节点行(runId 集合连带，去会话化 2026-10-28)再删 run(graphId) 后删图(id+userId 限定)", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.graphDefinition.findMany).mockResolvedValue([] as never);
    // 图下两 run（节点行级联的 run id 集合来源）
    vi.mocked(prisma.automationRun.findMany).mockClear();
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      { id: 11 },
      { id: 12 },
    ] as never);
    vi.mocked(prisma.graphRunNode.deleteMany).mockClear();
    vi.mocked(prisma.automationRun.deleteMany).mockClear();
    const repo = new GraphRepository();
    await repo["deleteGraph"](5, UID);
    // 节点行先取 id 集合再同事务删除（graphRunNode 无 graphId 列）
    expect(prisma.automationRun.findMany).toHaveBeenCalledWith({
      where: { graphId: 5 },
      select: { id: true },
    });
    expect(prisma.graphRunNode.deleteMany).toHaveBeenCalledWith({
      where: { runId: { in: [11, 12] } },
    });
    expect(prisma.automationRun.deleteMany).toHaveBeenCalledWith({
      where: { graphId: 5 },
    });
    expect(prisma.graphDefinition.deleteMany).toHaveBeenCalledWith({
      where: { id: 5, userId: UID },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 级联顺序：节点行删除先于 run 删除（run 删后 id 集合即失效）
    expect(
      vi.mocked(prisma.graphRunNode.deleteMany).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(prisma.automationRun.deleteMany).mock.invocationCallOrder[0],
    );
  });

  it("被其他图 subflow/iterate 节点引用 → GRAPH_IN_USE 带图名清单", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    const callerGraph = (graphId: number) => ({
      id: 7,
      name: "父工作流",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: "call",
            name: "调用",
            kind: "subflow",
            graphId,
            inputs: [],
          },
        ],
        edges: [{ from: "call", to: "END" }],
      }),
    });
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.graphDefinition.findMany).mockResolvedValue([
      callerGraph(5),
    ] as never);
    vi.mocked(prisma.$transaction).mockClear();
    const repo = new GraphRepository();
    await expect(repo["deleteGraph"](5, UID)).rejects.toThrowError(
      /GRAPH_IN_USE:.*父工作流/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("被任务 eventJson（taskFinished→graph）引用 → GRAPH_IN_USE 带任务名", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    // 第一查（targetKind 引用）空；第二查（eventJson 非空行）命中
    vi.mocked(prisma.automationTask.findMany).mockImplementation((async (args: {
      where?: { targetKind?: string };
    }) =>
      args?.where?.targetKind === "graph"
        ? []
        : [
            {
              name: "链式任务",
              eventJson: JSON.stringify({
                source: "taskFinished",
                targetType: "graph",
                targetId: 5,
              }),
            },
          ]) as never);
    const repo = new GraphRepository();
    await expect(repo["deleteGraph"](5, UID)).rejects.toThrowError(
      /GRAPH_IN_USE:.*链式任务/,
    );
  });

  it("删除成功前清理 webhook 注册（option 行 + 内存路由不残留）", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.graphDefinition.findMany).mockResolvedValue([] as never);
    vi.mocked(unregisterWebhook).mockClear();
    const repo = new GraphRepository();
    await repo["deleteGraph"](5, UID);
    expect(unregisterWebhook).toHaveBeenCalledWith(5, UID);
  });
});

describe("updateGraph 乐观锁", () => {
  it("version 不符 updateMany count=0 → VERSION_CONFLICT，不回读", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    vi.mocked(prisma.graphDefinition.updateMany).mockResolvedValue({
      count: 0,
    });
    const repo = new GraphRepository();
    await expect(
      repo["updateGraph"](
        5,
        { name: "改名", graphJson: validGraphJson, version: 1 },
        UID,
      ),
    ).rejects.toThrowError("VERSION_CONFLICT");
    // 乐观锁 where 含 version；冲突即拒，不回读行
    expect(prisma.graphDefinition.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5, userId: UID, version: 1 },
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
    expect(prisma.graphDefinition.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("他人图 → graph not found，不进入乐观锁更新", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.graphDefinition.updateMany).mockClear();
    const repo = new GraphRepository();
    await expect(
      repo["updateGraph"](
        9,
        { name: "改名", graphJson: validGraphJson, version: 1 },
        UID,
      ),
    ).rejects.toThrowError("graph 9 not found");
    expect(prisma.graphDefinition.updateMany).not.toHaveBeenCalled();
  });
});

describe("createGraph 校验拒绝（保存期即拒）", () => {
  it("图无唯一入口 → 抛校验 issues，不落库", async () => {
    const bad = JSON.stringify({
      version: 1,
      inputSchema: {},
      nodes: [
        {
          id: "a",
          name: "a",
          kind: "llm",
          modelId: 1,
          prompt: "x",
          tools: false,
          outputMode: "text",
        },
        {
          id: "b",
          name: "b",
          kind: "llm",
          modelId: 1,
          prompt: "y",
          tools: false,
          outputMode: "text",
        },
      ],
      edges: [],
    });
    const repo = new GraphRepository();
    await expect(
      repo["createGraph"]({ name: "坏图", graphJson: bad }, UID),
    ).rejects.toThrowError("uniqueEntry");
    expect(prisma.graphDefinition.create).not.toHaveBeenCalled();
  });

  it("graphJson 非法 JSON → 抛可读错误；合法 → 规范化序列落库", async () => {
    const repo = new GraphRepository();
    await expect(
      repo["createGraph"]({ name: "坏图", graphJson: "{oops" }, UID),
    ).rejects.toThrowError("graphJson 不是合法 JSON");
    expect(prisma.graphDefinition.create).not.toHaveBeenCalled();
    vi.mocked(prisma.graphDefinition.create).mockResolvedValue(
      graphRow as never,
    );
    await repo["createGraph"](
      { name: "调研成文", description: "备注", graphJson: validGraphJson },
      UID,
    );
    expect(prisma.graphDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "调研成文",
        description: "备注",
        userId: UID,
      }),
    });
  });
});

describe("runTest 草稿试运行", () => {
  it("draftJson 覆盖库内版本执行（试改后的图），运行仍归属原图", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({
      id: 9,
      directoryPath: null,
    } as never);
    vi.mocked(executeGraphRun).mockClear();
    vi.mocked(executeGraphRun).mockResolvedValue("success");

    const draftJson = JSON.stringify({
      ...JSON.parse(validGraphJson),
      nodes: [
        {
          id: "collect",
          name: "collect",
          kind: "llm",
          modelId: 3,
          prompt: "草稿版提示词",
          tools: false,
          outputMode: "text",
        },
      ],
      edges: [{ from: "collect", to: "END" }],
    });
    const repo = new GraphRepository();
    await repo.runTest(5, {}, 9, UID, draftJson);

    expect(executeGraphRun).toHaveBeenCalledTimes(1);
    const params = vi.mocked(executeGraphRun).mock.calls[0][0];
    expect(params.graph.id).toBe(5);
    expect(params.graph.graphJson).toBe(draftJson);
  });

  it("不传/空串 draftJson 回退库内版本（兼容旧调用）", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({
      id: 9,
      directoryPath: null,
    } as never);
    vi.mocked(executeGraphRun).mockClear();
    vi.mocked(executeGraphRun).mockResolvedValue("success");

    const repo = new GraphRepository();
    await repo.runTest(5, {}, 9, UID);
    await repo.runTest(5, {}, 9, UID, "  ");
    for (const call of vi.mocked(executeGraphRun).mock.calls) {
      expect(call[0].graph.graphJson).toBe(validGraphJson);
    }
  });
});

describe("cancelTestRun 手工中断", () => {
  // inflight 为模块级共享 Map：用例间清零防串扰（生产清理由执行收尾
  // .finally 负责，测试里无执行链路）
  beforeEach(() => {
    graphTestInflight.clear();
  });

  it("有在途 → abort 触发且 inflight 清理由执行收尾负责（此处不删）", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    const abort = new AbortController();
    graphTestInflight.set(5, abort);
    const before = vi.fn();
    abort.signal.addEventListener("abort", before);
    const repo = new GraphRepository();
    await repo.cancelTestRun(5, UID);
    expect(before).toHaveBeenCalled();
    // reason 锚定：executor 靠 USER_CANCELLED 区分用户中断与超时/退出类 abort
    expect(abort.signal.reason).toBeInstanceOf(Error);
    expect((abort.signal.reason as Error).message).toBe("USER_CANCELLED");
    expect(graphTestInflight.has(5)).toBe(true);
  });

  it("无在途 → GRAPH_NOT_RUNNING", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      graphRow as never,
    );
    const repo = new GraphRepository();
    await expect(repo.cancelTestRun(5, UID)).rejects.toThrowError(
      "GRAPH_NOT_RUNNING",
    );
  });

  it("图不属于该用户 → GRAPH_NOT_FOUND（不触碰他人 inflight）", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(null);
    const others = new AbortController();
    graphTestInflight.set(404, others);
    const repo = new GraphRepository();
    await expect(repo.cancelTestRun(404, UID)).rejects.toThrowError(
      "GRAPH_NOT_FOUND",
    );
    expect(others.signal.aborted).toBe(false);
  });
});

describe("pickBinaryFile（binary 固化拷贝）", () => {
  it("选中文件 → 拷贝到 userData/workflow-assets 并返回拷贝路径（内容一致）", async () => {
    const source = path.join(
      path.dirname(app.getPath("userData")),
      `tianshu-pick-src-${Date.now()}.bin`,
    );
    await fs.writeFile(source, Buffer.from("snapshot-me"));
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [source],
    } as never);
    try {
      const repo = new GraphRepository();
      const stored = await repo.pickBinaryFile();
      expect(stored).toContain("workflow-assets");
      expect(stored).toContain("tianshu-pick-src");
      expect(await fs.readFile(stored!, "utf-8")).toBe("snapshot-me");
    } finally {
      await fs.rm(source, { force: true });
    }
  });

  it("取消 → null（不产生拷贝）", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as never);
    const repo = new GraphRepository();
    expect(await repo.pickBinaryFile()).toBeNull();
  });

  it("超过 10MB → 拒绝拷贝", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/whatever-big.bin"],
    } as never);
    const statMock = vi.spyOn(fs, "stat").mockResolvedValue({
      size: 11 * 1024 * 1024,
    } as never);
    const repo = new GraphRepository();
    await expect(repo.pickBinaryFile()).rejects.toThrow(
      "HTTP_BINARY_TOO_LARGE",
    );
    statMock.mockRestore();
  });
});

const VALID_EXPORT_GRAPH = JSON.stringify({
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: "only",
      name: "only",
      kind: "code",
      language: "bash",
      script: "echo hi",
    },
  ],
  edges: [{ from: "only", to: "END" }],
});

describe("exportWorkflow / importWorkflow（导入导出）", () => {
  it("导出：另存对话框 → 写自包含 JSON（kind 标识 + name + graphJson 对象）", async () => {
    const target = path.join(
      app.getPath("userData"),
      `export-${Date.now()}.json`,
    );
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: target,
    } as never);
    const repo = new GraphRepository();
    const saved = await repo.exportWorkflow({
      name: "我的流程",
      description: "导出说明",
      graphJson: VALID_EXPORT_GRAPH,
    });
    expect(saved).toBe(target);
    const doc = JSON.parse(await fs.readFile(target, "utf-8"));
    expect(doc.kind).toBe("tianshu-workflow");
    expect(doc.name).toBe("我的流程");
    expect(doc.graphJson.nodes[0].id).toBe("only");
    await fs.rm(target, { force: true });
  });

  it("导出取消 → null；导入取消 → null", async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: true,
      filePath: undefined,
    } as never);
    const repo = new GraphRepository();
    expect(
      await repo.exportWorkflow({
        name: "x",
        graphJson: VALID_EXPORT_GRAPH,
      }),
    ).toBeNull();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as never);
    expect(await repo.importWorkflow()).toBeNull();
  });

  it("导入：包裹格式与裸 graphJson 都可解析；非法 JSON → ok:false 原因", async () => {
    const repo = new GraphRepository();
    const wrapped = path.join(
      app.getPath("userData"),
      `wrapped-${Date.now()}.json`,
    );
    await fs.writeFile(
      wrapped,
      JSON.stringify({
        kind: "tianshu-workflow",
        version: 1,
        name: "外部流程",
        description: "",
        graphJson: JSON.parse(VALID_EXPORT_GRAPH),
      }),
      "utf-8",
    );
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [wrapped],
    } as never);
    const result = await repo.importWorkflow();
    expect(result).toMatchObject({
      ok: true,
      name: "外部流程",
    });
    expect((result as { graphJson: object }).graphJson).toBeTruthy();

    // 裸 graphJson：文件名兜底为 name
    const bare = wrapped.replace(".json", "-bare.json");
    await fs.writeFile(bare, VALID_EXPORT_GRAPH, "utf-8");
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [bare],
    } as never);
    const bareResult = await repo.importWorkflow();
    expect(bareResult).toMatchObject({ ok: true });
    expect((bareResult as { name: string }).name).toContain("bare");

    // 非法 JSON
    const broken = wrapped.replace(".json", "-broken.json");
    await fs.writeFile(broken, "{not-json", "utf-8");
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [broken],
    } as never);
    const bad = await repo.importWorkflow();
    expect(bad).toMatchObject({ ok: false });

    await fs.rm(wrapped, { force: true });
    await fs.rm(bare, { force: true });
    await fs.rm(broken, { force: true });
  });

  it("导入：非法图（校验不过）→ ok:false 带错误码", async () => {
    const invalid = path.join(
      app.getPath("userData"),
      `invalid-${Date.now()}.json`,
    );
    await fs.writeFile(
      invalid,
      JSON.stringify({
        kind: "tianshu-workflow",
        name: "坏图",
        graphJson: { version: 1, inputSchema: {}, nodes: [], edges: [] },
      }),
      "utf-8",
    );
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [invalid],
    } as never);
    const repo = new GraphRepository();
    const result = await repo.importWorkflow();
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("图校验未通过");
    await fs.rm(invalid, { force: true });
  });
});
