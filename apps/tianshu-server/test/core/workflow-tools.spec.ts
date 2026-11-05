/**
 * 工作流六件 + 展示三件（F1/F2 2026-10-29）：server 侧移植面的单测——
 * 六件装配完整性/命名、typed 入口归一（run_workflow number 保型+缺参
 * 结构化回喂）、E1 字段级回喂形状、E3 软提示、run 经 GraphService.run
 * 闭包（runId 回执与错误映射）、展示三件 kind=read 与 chart 等长校验。
 */
import { makeWorkflowTools } from 'src/core/tools/workflow-tools';
import { makeDisplayTools } from 'src/core/tools/display-tools';

const CTX = { workspacePath: '/ws', sessionId: 7, userId: 1 } as never;

const TYPED_GRAPH = {
  version: 1,
  inputSchema: {
    amount: { type: 'number', required: true },
    category: { type: 'enum', enumValues: ['餐饮', '交通'], default: '餐饮' },
    note: { type: 'string', required: false, default: '' },
  },
  nodes: [
    { id: 'start', name: '开始', kind: 'start', variables: ['amount'] },
    {
      id: 'insert',
      name: '插入',
      kind: 'database',
      engine: 'sqlite',
      sqlitePath: 'demo.db',
      sql: 'INSERT INTO t (a) VALUES (?)',
      params: ['{{input.amount}}'],
    },
  ],
  edges: [
    { from: 'start', to: 'insert' },
    { from: 'insert', to: 'END' },
  ],
};

function makeDeps() {
  const runGraph = jest.fn(
    async (_dto: {
      graphId: number;
      inputs?: Record<string, string | number | boolean>;
      workspaceId?: number;
    }) => ({ runId: 33 }),
  );
  const rows: Array<Record<string, unknown>> = [
    {
      id: 1,
      name: '记账·记一笔',
      description: null,
      version: 1,
      graphJson: JSON.stringify(TYPED_GRAPH),
    },
  ];
  const prisma = {
    graphDefinition: {
      create: jest.fn(async ({ data }: { data: { name: string } }) => ({
        id: 9,
        name: data.name,
      })),
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(
        async ({ where }: { where: { id: number } }) =>
          (rows as never[]).find(
            (row) => (row as { id: number }).id === where.id,
          ) ?? null,
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    automationRun: {
      findFirst: jest.fn(async () => ({
        id: 33,
        status: 'success',
        error: null,
        graphTrace: JSON.stringify([
          { id: 'insert', status: 'success', outputPreview: '{"affectedRows"' },
        ]),
        startedAt: new Date('2026-10-29T08:00:00Z'),
        durationMs: 900,
      })),
    },
    graphRunNode: {
      findMany: jest.fn(async () => [
        {
          nodeId: 'insert',
          status: 'success',
          output: '{"affectedRows":1}',
        },
      ]),
    },
  };
  return { prisma, runGraph, rows };
}

function toolsOf(deps: ReturnType<typeof makeDeps>) {
  return makeWorkflowTools({
    prisma: deps.prisma as never,
    runGraph: deps.runGraph as never,
  });
}

describe('工作流四件（F1 六件坍缩对齐 mirror，2026-11-01 审查批）', () => {
  it('四件齐备且命名与 mirror 静态注册名一一对应', () => {
    const tools = toolsOf(makeDeps());
    expect(tools.map((tool) => tool.name)).toEqual([
      'workflow_write',
      'workflow_read',
      'run_workflow',
      'get_workflow_run',
    ]);
    expect(tools.find((t) => t.name === 'run_workflow')?.kind).toBe('write');
    expect(tools.find((t) => t.name === 'workflow_read')?.kind).toBe('read');
  });

  it('run_workflow：typed 归一（number 保型+default 填充+未声明键丢弃）经 runGraph 闭包返 runId', async () => {
    const deps = makeDeps();
    const run = toolsOf(deps).find((t) => t.name === 'run_workflow')!;
    const result = await run.execute(CTX, {
      id: 1,
      inputs: { amount: 35, evil: 'x' },
    });
    expect(result).toContain('runId=33');
    expect(deps.runGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: 1,
        inputs: { amount: 35, category: '餐饮', note: '' },
      }),
    );
    const inputs = deps.runGraph.mock.calls[0][0].inputs ?? {};
    expect(typeof inputs.amount).toBe('number');
  });

  it('run_workflow：required 缺参结构化回喂；运行中/无空间错误映射', async () => {
    const deps = makeDeps();
    const run = toolsOf(deps).find((t) => t.name === 'run_workflow')!;
    const missing = await run.execute(CTX, { id: 1, inputs: {} });
    expect(missing).toContain('缺少必填输入: amount');
    expect(deps.runGraph).not.toHaveBeenCalled();
    deps.runGraph.mockRejectedValueOnce(new Error('GRAPH_ALREADY_RUNNING'));
    const busy = await run.execute(CTX, { id: 1, inputs: { amount: 1 } });
    expect(busy).toContain('正在运行中');
    deps.runGraph.mockRejectedValueOnce(new Error('WORKSPACE_NOT_FOUND'));
    const noWs = await run.execute(CTX, { id: 1, inputs: { amount: 1 } });
    expect(noWs).toContain('工作空间');
  });

  it('E1 字段级回喂：缺 sql 定位到节点与字段并给期望形态（core union 展开共享）', async () => {
    const deps = makeDeps();
    const create = toolsOf(deps).find((t) => t.name === 'workflow_write')!;
    const result = await create.execute(CTX, {
      name: 'bad',
      graphJson: {
        version: 1,
        inputSchema: {},
        nodes: [
          { id: 'start', name: '开始', kind: 'start', variables: [] },
          {
            id: 'insert-expense',
            name: '插入',
            kind: 'database',
            engine: 'sqlite',
            sqlitePath: 'demo.db',
          },
        ],
        edges: [
          { from: 'start', to: 'insert-expense' },
          { from: 'insert-expense', to: 'END' },
        ],
      },
    });
    expect(result).toContain('校验未通过');
    expect(result).toContain('节点「insert-expense」sql：缺少必填字段');
    expect(result).toContain('期望：单条 SQL 文本');
  });

  it('create：E3 软提示（description/输入变量 description）；成功入集 userId 隔离', async () => {
    const deps = makeDeps();
    const create = toolsOf(deps).find((t) => t.name === 'workflow_write')!;
    const result = await create.execute(CTX, {
      name: '新图',
      graphJson: TYPED_GRAPH,
    });
    expect(result).toContain('成功');
    expect(result).toContain('未写 description');
    expect(result).toContain('输入变量 [amount、category、note]');
    expect(deps.prisma.graphDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 1 }),
    });
    // create 描述含 E2 cookbook（照猫画虎引导）
    expect(create.description).toContain('【照猫画虎】');
    expect(create.description).toContain('workflow_read');
  });

  it('list：行附 typed 输入摘要（enum 值域+缺省）', async () => {
    const deps = makeDeps();
    const list = toolsOf(deps).find((t) => t.name === 'workflow_read')!;
    const result = await list.execute(CTX, {});
    expect(result).toContain('id=1 记账·记一笔');
    expect(result).toContain('amount:number(必填)');
    expect(result).toContain('category:enum[餐饮|交通](必填，默认:餐饮)');
  });

  it('get_workflow_run：状态/耗时 + graphRunNode 终点完整输出（≤4000）', async () => {
    const deps = makeDeps();
    const getRun = toolsOf(deps).find((t) => t.name === 'get_workflow_run')!;
    const result = await getRun.execute(CTX, { id: 1 });
    expect(result).toContain('success');
    expect(result).toContain('耗时: 0.9s');
    expect(result).toContain('完整输出: {"affectedRows":1}');
  });
});

describe('展示三件（F2）', () => {
  it('三件齐备、kind=read、chart 系列等长校验（values 与 labels 不齐拒绝）', async () => {
    const tools = makeDisplayTools();
    expect(tools.map((t) => t.name)).toEqual([
      'show_table',
      'show_summary',
      'show_chart',
    ]);
    for (const tool of tools) {
      expect(tool.kind).toBe('read');
    }
    const chart = tools.find((t) => t.name === 'show_chart')!;
    expect(
      (
        chart.parameters as { safeParse: (v: unknown) => { success: boolean } }
      ).safeParse({
        chartType: 'line',
        labels: ['5月', '6月'],
        series: [{ name: '支出', values: [1] }],
      }).success,
    ).toBe(false);
    const table = tools.find((t) => t.name === 'show_table')!;
    const receipt = await table.execute(CTX, {
      columns: [{ key: 'a', label: 'A' }],
      rows: [{ a: 1 }, { a: 2 }],
    });
    expect(receipt).toContain('1 列 × 2 行');
  });
});

/** json 容器图 fixture（2026-11-05 json 类型）：payload 声明 json */
const JSON_GRAPH = {
  version: 1,
  inputSchema: {
    payload: { type: 'json', required: true },
  },
  nodes: [
    { id: 'start', name: '开始', kind: 'start', variables: ['payload'] },
    {
      id: 'insert',
      name: '插入',
      kind: 'database',
      engine: 'sqlite',
      sqlitePath: 'demo.db',
      sql: 'INSERT INTO t (a) VALUES (?)',
      params: ['{{input.payload}}'],
    },
  ],
  edges: [
    { from: 'start', to: 'insert' },
    { from: 'insert', to: 'END' },
  ],
};

describe('run_workflow json 输入（容器保型，2026-11-05）', () => {
  function makeJsonDeps() {
    const deps = makeDeps();
    deps.rows[0] = {
      id: 1,
      name: 'json-flow',
      description: null,
      version: 1,
      graphJson: JSON.stringify(JSON_GRAPH),
    };
    return deps;
  }

  it('工具参数 schema 收容器对象/数组（zod union 扩 json）', () => {
    const run = toolsOf(makeJsonDeps()).find(
      (t) => t.name === 'run_workflow',
    )!;
    const parameters = run.parameters as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      parameters.safeParse({ id: 1, inputs: { payload: { a: 1 } } }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({ id: 1, inputs: { payload: [1, 2] } }).success,
    ).toBe(true);
  });

  it('json 容器保型直达 runGraph；文本 parse 归一为容器', async () => {
    const deps = makeJsonDeps();
    const run = toolsOf(deps).find((t) => t.name === 'run_workflow')!;
    const result = await run.execute(CTX, {
      id: 1,
      inputs: { payload: { a: 1, list: [1, 2] } },
    });
    expect(result).toContain('runId=33');
    const inputs = (deps.runGraph.mock.calls[0][0].inputs ?? {}) as Record<
      string,
      unknown
    >;
    expect(inputs).toEqual({ payload: { a: 1, list: [1, 2] } });
    // 文本形态同归一（AI 传 JSON 字符串场景）
    await run.execute(CTX, { id: 1, inputs: { payload: '{"x":2}' } });
    const textInputs = (deps.runGraph.mock.calls[1][0].inputs ?? {}) as Record<
      string,
      unknown
    >;
    expect(textInputs).toEqual({ payload: { x: 2 } });
  });

  it('非法 JSON 文本结构化回喂（引导修正）', async () => {
    const deps = makeJsonDeps();
    const run = toolsOf(deps).find((t) => t.name === 'run_workflow')!;
    const result = await run.execute(CTX, {
      id: 1,
      inputs: { payload: '{a:1}' },
    });
    expect(result).toContain('输入参数无效');
    expect(result).toContain('JSON 对象/数组');
    expect(deps.runGraph).not.toHaveBeenCalled();
  });
});
