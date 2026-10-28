// PL-2（spec §2.2）：library 检索链——library_search 工具真检索（vector-store
// 余弦 topK + libraryItem 命中回联）+ library.repository 检索面摘取（search/
// getById/findFilesByNames）+ 注册面（chat bindTools 组装断言、registry 静态
// 注册、read kind 不触桥 write 豁免面）。embedding 经注入假体（真实链路
// embedTexts 走 provider /embeddings——graph-executor.spec 另行覆盖）；检索
// 底座 searchChunks 经 graphExecutorRuntime().db 读库，与本 spec 共用临时库。
import {
  makeLibrarySearchTool,
  LIBRARY_COLLECTION,
  LIBRARY_EMPTY_OUTPUT,
  type EmbedTexts,
} from 'src/core/library/library-tools';
import { LibraryRepository } from 'src/core/library/library.repository';
import { registry } from 'src/core/tools/tool-registry';
import { BRIDGE_TOOL_NAMES } from 'src/core/tools/bridge/browser-bridge-tools';
import {
  APPROVAL_AUTO_DENIED_OUTPUT,
  runToolCall,
  type AgentStreamOptions,
} from 'src/core/tools/tool-gate';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
} from 'src/core/graph/executor-runtime';
import { collectTools } from 'src/core/graph/graph-executor';
import type { ChatStreamChunk } from '@tianshu/protocol';
import { createTestDb, type TestDb } from '../support/test-db';
import {
  makeDirs,
  makeRunner,
  seedSession,
  type TestDirs,
} from '../support/chat-fixture';

/** 固定 embedding 模型标识（块 model 列——graph vectorize 节点存 String(modelId)） */
const EMBED_MODEL = '7';

/** 假 embedding：记录调用并返回与命中块 [1,0] 对齐的查询向量 */
function fakeEmbed(): { embed: EmbedTexts; calls: () => number } {
  let calls = 0;
  const embed: EmbedTexts = (modelId, texts) => {
    calls += 1;
    expect(modelId).toBe(7);
    return Promise.resolve(texts.map(() => [1, 0]));
  };
  return { embed, calls: () => calls };
}

describe('library 检索链（PL-2）', () => {
  let db: TestDb;
  let dirs: TestDirs;

  beforeAll(async () => {
    db = await createTestDb();
    dirs = makeDirs();
    // searchChunks（vector-store）经 graphExecutorRuntime().db 读库——
    // 本 spec 临时库装为进程级运行时（runs 原语 no-op，检索路径不消费）
    installGraphExecutorRuntime({
      db: db.prisma,
      runs: {
        createRun: () => Promise.resolve(0),
        finishRun: () => Promise.resolve(),
      },
    });
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await db.cleanup();
    dirs.cleanup();
  });

  it('检索命中：seed vectorChunk+libraryItem → 返回条目（名+条目号+相似度+片段），孤儿块回退纯 sourceName', async () => {
    const fileRow = await db.prisma.libraryItem.create({
      data: { name: '项目方案.md', kind: 'file', userId: 1 },
    });
    // 同名 folder：findFilesByNames 仅 file——回联必须排除
    await db.prisma.libraryItem.create({
      data: { name: '旧笔记.md', kind: 'folder', userId: 1 },
    });
    await db.prisma.vectorChunk.createMany({
      data: [
        {
          userId: 1,
          collection: LIBRARY_COLLECTION,
          sourceName: '项目方案.md',
          seq: 0,
          text: '下一代产品路线图：向量检索优先',
          vector: JSON.stringify([1, 0]),
          model: EMBED_MODEL,
        },
        {
          userId: 1,
          collection: LIBRARY_COLLECTION,
          sourceName: '旧笔记.md',
          seq: 0,
          text: '零散记录',
          vector: JSON.stringify([0, 1]),
          model: EMBED_MODEL,
        },
        // 他用户同集合块：用户隔离不得泄漏
        {
          userId: 2,
          collection: LIBRARY_COLLECTION,
          sourceName: '他人文档.md',
          seq: 0,
          text: '别人家的内容',
          vector: JSON.stringify([1, 0]),
          model: EMBED_MODEL,
        },
      ],
    });
    const { embed, calls } = fakeEmbed();
    const tool = makeLibrarySearchTool({ db: db.prisma, embed });
    const output = await tool.execute(
      { workspacePath: '', sessionId: 1, userId: 1 },
      { query: '产品路线图' },
    );
    expect(calls()).toBe(1);
    // 首位命中：条目回联（file 行 id）+ 相似度 1.00 + 原文片段
    expect(output).toContain(
      `【项目方案.md（条目 #${fileRow.id}）｜相似度 1.00】下一代产品路线图`,
    );
    // 次位孤儿块（同名 folder 不回联）：纯 sourceName 形态
    expect(output).toContain('【旧笔记.md｜相似度 0.00】零散记录');
    // 他用户块不出现
    expect(output).not.toContain('他人文档.md');
  });

  it('topK 生效：seed 三块取 topK=2 → 恰两段', async () => {
    await db.prisma.vectorChunk.createMany({
      data: [1, 2, 3].map((seq) => ({
        userId: 3,
        collection: LIBRARY_COLLECTION,
        sourceName: `批量-${seq}.md`,
        seq,
        text: `片段-${seq}`,
        vector: JSON.stringify([1, 0]),
        model: EMBED_MODEL,
      })),
    });
    const tool = makeLibrarySearchTool({
      db: db.prisma,
      embed: fakeEmbed().embed,
    });
    const output = await tool.execute(
      { workspacePath: '', sessionId: 1, userId: 3 },
      { query: '批量', topK: 2 },
    );
    expect(output.split('\n\n')).toHaveLength(2);
  });

  it('空库空结果：无资料库块（他集合/他用户块在场）→ 空结果文案，不向量化不炸不伪造', async () => {
    // user 9 只有非资料库集合的块 + 他用户资料库块——均不得触达
    await db.prisma.vectorChunk.createMany({
      data: [
        {
          userId: 9,
          collection: 'workflow-kb',
          sourceName: '工作流知识.md',
          seq: 0,
          text: '不该被资料库检索到',
          vector: JSON.stringify([1, 0]),
          model: EMBED_MODEL,
        },
      ],
    });
    const { embed, calls } = fakeEmbed();
    const tool = makeLibrarySearchTool({ db: db.prisma, embed });
    const output = await tool.execute(
      { workspacePath: '', sessionId: 1, userId: 9 },
      { query: '工作流' },
    );
    expect(output).toBe(LIBRARY_EMPTY_OUTPUT);
    expect(calls()).toBe(0); // 空库短路：不发起向量化
  });

  it('块模型标识非数值：fail 文案回喂（不静默）', async () => {
    await db.prisma.vectorChunk.create({
      data: {
        userId: 11,
        collection: LIBRARY_COLLECTION,
        sourceName: '坏块.md',
        seq: 0,
        text: 'x',
        vector: JSON.stringify([1, 0]),
        model: 'not-a-number',
      },
    });
    const { embed, calls } = fakeEmbed();
    const tool = makeLibrarySearchTool({ db: db.prisma, embed });
    const output = await tool.execute(
      { workspacePath: '', sessionId: 1, userId: 11 },
      { query: 'x' },
    );
    expect(output).toMatch(/^错误: /);
    expect(output).toContain('not-a-number');
    expect(calls()).toBe(0);
  });

  it('注册面（graph 自动）：registry 静态注册 library_search 且 kind=read', () => {
    const def = registry.find('library_search');
    expect(def).toBeDefined();
    expect(def?.kind).toBe('read');
    expect(registry.getDefinitions().map((d) => d.name)).toContain(
      'library_search',
    );
  });

  it('注册面（chat bindTools）：session/send 组装的工具表含 library_search', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'ok' }] },
    ]);
    await runner.run({ sessionId: session.id, content: 'hi' });
    expect(model.callsLog[0].toolNames).toContain('library_search');
  });

  it('注册面（graph 无 workspace 任务）：collectTools 工具表常驻含 library_search（PL-3 裁定）', async () => {
    // PL-T2 concern ① 裁定落地：资料库用户级无属地语义——graph/automation
    // 无工作空间会话与 chat 侧一致常驻注入（见 graph-executor 改造点 9）
    const tools = await collectTools(undefined, []);
    expect(tools.map((tool) => tool.name)).toContain('library_search');
  });

  it('read kind 不触审批豁免面：default 模式直执行（无 approval-request、非自动拒绝），且不在 BRIDGE_TOOL_NAMES', async () => {
    expect(BRIDGE_TOOL_NAMES.has('library_search')).toBe(false);
    const def = registry.find('library_search');
    if (!def) throw new Error('library_search 未注册');
    const agent: AgentStreamOptions = {
      sessionId: 7,
      fullAccess: () => false,
      isToolAllowed: () => Promise.resolve(false),
      requestApproval: () => Promise.resolve(false),
      autoDenyApprovals: true,
    };
    const chunks: ChatStreamChunk[] = [];
    const output = await runToolCall(
      def,
      agent,
      'tc-lib-1',
      { query: '测试' },
      undefined,
      (chunk) => chunks.push(chunk),
    );
    // read 工具不走 write 审批链：执行体真实返回（agent 无 userId → 空库
    // 短路文案），非自动拒绝文案
    expect(output).toBe(LIBRARY_EMPTY_OUTPUT);
    expect(output).not.toBe(APPROVAL_AUTO_DENIED_OUTPUT);
    expect(
      chunks.filter((chunk) => chunk.type === 'approval-request'),
    ).toHaveLength(0);
  });

  describe('library.repository 检索面（mirror library.repo 最小摘取）', () => {
    let repo: LibraryRepository;

    beforeAll(() => {
      repo = new LibraryRepository(db.prisma);
    });

    it('search：跨层文件名 contains（仅 file、限本用户、keyword 截 100、空白返空）', async () => {
      await db.prisma.libraryItem.createMany({
        data: [
          { name: '季度报告-A.md', kind: 'file', userId: 5 },
          { name: '季度报告-B.md', kind: 'file', userId: 5 },
          { name: '季度报告-文件夹', kind: 'folder', userId: 5 },
          { name: '季度报告-C.md', kind: 'file', userId: 6 },
        ],
      });
      const rows = await repo.search('季度报告', 5);
      expect(rows.map((row) => row.name).sort()).toEqual([
        '季度报告-A.md',
        '季度报告-B.md',
      ]);
      expect(await repo.search('   ', 5)).toEqual([]);
      // 超长 keyword 截断到 100 后仍 contains 命中（前缀同段）
      const long = '季度报告' + 'x'.repeat(200);
      expect(await repo.search(long, 5)).toEqual([]);
      const exact100 = '季度报告' + 'x'.repeat(96);
      expect((await repo.search(exact100, 5)).length).toBe(0);
    });

    it('getById：本用户命中返行；缺失/他人所有同报「条目不存在」（不泄露存在性）', async () => {
      const row = await db.prisma.libraryItem.create({
        data: { name: '按id读.md', kind: 'file', userId: 5 },
      });
      await expect(repo.getById(row.id, 5)).resolves.toMatchObject({
        id: row.id,
        name: '按id读.md',
      });
      await expect(repo.getById(row.id, 6)).rejects.toThrow('条目不存在');
      await expect(repo.getById(999_999, 5)).rejects.toThrow('条目不存在');
    });

    it('findFilesByNames：精确名匹配 file 行（folder/他用户排除；空名单直返）', async () => {
      const rows = await repo.findFilesByNames(
        ['项目方案.md', '旧笔记.md', '不存在.md'],
        1,
      );
      expect(rows.map((row) => row.name)).toEqual(['项目方案.md']);
      expect(await repo.findFilesByNames([], 1)).toEqual([]);
    });
  });
});
