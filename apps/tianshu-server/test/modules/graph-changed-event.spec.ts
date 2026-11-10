// orchestration 路由化批（2026-11-10）server 侧新面：
// 1. graph.changed 协议事件——repository 四写点（create/update/delete/
//    toggle）成功后经注入钩子发布，失败路径不发（刷新信号语义，
//    automation.changed 同先例）
// 2. enabled 写面——GraphCreateParams/UpdateParams.enabled 缺省不动、
//    携带即写（GraphSaveDto.enabled 透传；控制端 toggle 另有轻量端点，
//    全量 save 携带为兼供）
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { createTestDb, type TestDb } from '../support/test-db';

const UID = COMPANION_USER_ID;

const validGraphJson = JSON.stringify({
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: 'collect',
      name: 'collect',
      kind: 'llm',
      modelId: 1,
      prompt: '汇总',
      tools: false,
      outputMode: 'text',
    },
  ],
  edges: [{ from: 'collect', to: 'END' }],
});

describe('graph.changed 事件与 enabled 写面（orchestration 路由化批）', () => {
  let db: TestDb;
  let events: { graphId: number }[];
  let graphs: GraphRepository;

  beforeAll(async () => {
    db = await createTestDb();
    events = [];
    graphs = new GraphRepository(
      db.prisma,
      async () => {},
      (payload) => events.push({ graphId: payload.graphId }),
    );
  });

  afterAll(async () => {
    await db.cleanup();
  });

  it('create/update/delete/toggle 四写点各发一次，graphId 正确', async () => {
    const created = await graphs.createGraph(
      { name: '事件图', graphJson: validGraphJson },
      UID,
    );
    expect(events).toEqual([{ graphId: created.id }]);

    const updated = await graphs.updateGraph(
      created.id,
      { name: '事件图改', graphJson: validGraphJson, version: created.version },
      UID,
    );
    expect(events).toEqual([
      { graphId: created.id },
      { graphId: created.id },
    ]);

    const toggled = await graphs.toggleGraph(created.id, false, UID);
    expect(toggled.enabled).toBe(false);
    expect(events).toHaveLength(3);

    await graphs.deleteGraph(created.id, UID);
    expect(events).toEqual([
      { graphId: created.id },
      { graphId: created.id },
      { graphId: created.id },
      { graphId: created.id },
    ]);
  });

  it('失败路径不发：VERSION_CONFLICT 与 GRAPH_NOT_FOUND 均无事件', async () => {
    const before = events.length;
    const row = await graphs.createGraph(
      { name: '冲突图', graphJson: validGraphJson },
      UID,
    );
    expect(events).toHaveLength(before + 1);

    await expect(
      graphs.updateGraph(
        row.id,
        { name: 'x', graphJson: validGraphJson, version: row.version + 99 },
        UID,
      ),
    ).rejects.toThrowError('VERSION_CONFLICT');
    await expect(
      graphs.deleteGraph(row.id + 999999, UID),
    ).rejects.toThrowError('GRAPH_NOT_FOUND');
    expect(events).toHaveLength(before + 1);
  });

  it('enabled：create 携带即写、update 携带翻转、缺席不动', async () => {
    // create 缺席走 schema 默认 true
    const a = await graphs.createGraph(
      { name: '默认启用', graphJson: validGraphJson },
      UID,
    );
    expect(a.enabled).toBe(true);
    // create 显式 false
    const b = await graphs.createGraph(
      { name: '建即停', graphJson: validGraphJson, enabled: false },
      UID,
    );
    expect(b.enabled).toBe(false);
    // update 携带翻转（全量 save 兼携 enabled 的写面）
    const c = await graphs.updateGraph(
      b.id,
      {
        name: '建即停',
        graphJson: validGraphJson,
        version: b.version,
        enabled: true,
      },
      UID,
    );
    expect(c.enabled).toBe(true);
    // update 缺席不动（enabled 停留 true）
    const d = await graphs.updateGraph(
      b.id,
      { name: '改名不带启停', graphJson: validGraphJson, version: c.version },
      UID,
    );
    expect(d.enabled).toBe(true);
    expect(d.name).toBe('改名不带启停');
  });
});
