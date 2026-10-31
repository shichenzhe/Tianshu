// 查询下推批：graph/automation 列表查询下推直证。原路径（service 拉
// listGraphs/listTasks 全量 → 内存 includes 过滤 → 切片）每次查询全表
// 扫描——本批收口为 repo pageGraphs/pageTasks（session.repository.query
// 同款骨架；contains 经 containsFilter 引擎感知，SQLite LIKE 的 ASCII
// 大小写不敏感为有意语义——原内存 includes 为大小写敏感，双引擎统一
// 形状由 test/core/db-url-engine.spec.ts 的 containsFilter 用例守护）。
// 两层钉死：
// 1. stub prisma 委托：where（userId + name contains）/skip/take/orderBy
//    与 count 同 where——下推形状直证（替代全量 findMany 无分页形态）；
// 2. 真实临时库服务级：keyword 命中/total 同 where 计数/翻页切片/
//    keyword 空白 trim 不过滤/page<=0 收敛 1/hydrate 补位照常。
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { GraphService } from 'src/modules/graph/graph.service';
import { GraphQueryDto } from 'src/modules/graph/dto/graph-query.dto';
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { AutomationService } from 'src/modules/automation/automation.service';
import { AutomationQueryDto } from 'src/modules/automation/dto/automation-query.dto';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { PrismaService } from 'src/commons/database/prisma.service';
import { createTestDb, type TestDb } from '../support/test-db';

describe('graph/automation 列表查询下推（repo pageGraphs/pageTasks）', () => {
  describe('下推形状（stub prisma 委托）', () => {
    it('pageGraphs：keyword 命中时 where={userId, name contains} + skip/take + createdAt desc；count 同 where', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const count = jest.fn().mockResolvedValue(0);
      const prisma = {
        graphDefinition: { findMany, count },
      } as unknown as PrismaService;
      const repo = new GraphRepository(prisma);

      const res = await repo.pageGraphs(1, {
        keyword: 'kw',
        page: 3,
        pageSize: 10,
      });

      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 1, name: { contains: 'kw' } },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 10,
      });
      expect(count).toHaveBeenCalledWith({
        where: { userId: 1, name: { contains: 'kw' } },
      });
      expect(res).toMatchObject({ page: 3, pageSize: 10, total: 0 });
    });

    it('pageGraphs：keyword 缺席 where 仅 userId（无 contains 键）；page<=0 收敛 1（skip 0）', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const count = jest.fn().mockResolvedValue(0);
      const repo = new GraphRepository({
        graphDefinition: { findMany, count },
      } as unknown as PrismaService);

      const res = await repo.pageGraphs(1, { page: 0, pageSize: 5 });

      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 1 },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 5,
      });
      expect(count).toHaveBeenCalledWith({ where: { userId: 1 } });
      expect(res.page).toBe(1);
    });

    it('pageTasks：同款下推形状（任务表）', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const count = jest.fn().mockResolvedValue(0);
      const repo = new AutomationRepository({
        automationTask: { findMany, count },
        workspace: { findUnique: jest.fn() },
      } as unknown as PrismaService);

      const res = await repo.pageTasks(1, {
        keyword: '早报',
        page: 2,
        pageSize: 20,
      });

      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 1, name: { contains: '早报' } },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 20,
      });
      expect(count).toHaveBeenCalledWith({
        where: { userId: 1, name: { contains: '早报' } },
      });
      expect(res).toMatchObject({ page: 2, pageSize: 20, total: 0 });
    });
  });

  describe('服务级（真实临时库）', () => {
    let db: TestDb;
    let graphs: GraphService;
    let automations: AutomationService;
    /** 逆创建序断言用：desc 序 = [乙, 中, 甲]（createdAt 显式错秒） */
    const graphNames = ['甲图', 'Report 调研中图', '乙图调研'];

    const graphDto = (over: Partial<GraphQueryDto>): GraphQueryDto =>
      Object.assign(new GraphQueryDto(), over);
    const taskDto = (over: Partial<AutomationQueryDto>): AutomationQueryDto =>
      Object.assign(new AutomationQueryDto(), over);

    beforeAll(async () => {
      db = await createTestDb();
      graphs = new GraphService(db.prisma, new GraphRepository(db.prisma));
      automations = new AutomationService(
        db.prisma,
        new AutomationRepository(db.prisma),
        new EventBusService(),
      );
      const T0 = Date.now();
      const ws = await db.prisma.workspace.create({
        data: { name: 'pushdown-ws', userId: 1 },
      });
      for (const [i, name] of graphNames.entries()) {
        await db.prisma.graphDefinition.create({
          data: {
            name,
            graphJson: '{}',
            userId: 1,
            createdAt: new Date(T0 + i * 1000),
          },
        });
      }
      for (const [i, name] of ['甲任务', 'Report 任务', '乙任务早报'].entries()) {
        await db.prisma.automationTask.create({
          data: {
            name,
            prompt: 'p',
            workspaceId: ws.id,
            modelId: 0,
            scheduleJson: '{}',
            scheduleText: 's',
            userId: 1,
            createdAt: new Date(T0 + i * 1000),
          },
        });
      }
    }, 120_000);

    afterAll(async () => {
      await db.cleanup();
    });

    it('graph query：keyword 下推过滤 + total 同 where 计数 + createdAt desc', async () => {
      const res = await graphs.query(graphDto({ keyword: '调研' }));
      expect(res.total).toBe(2);
      expect(res.records.map((r) => r.name)).toEqual([
        '乙图调研',
        'Report 调研中图',
      ]);
    });

    it('graph query：ASCII 大小写不敏感（SQLite LIKE 语义——有意变更，原内存 includes 敏感）', async () => {
      const res = await graphs.query(graphDto({ keyword: 'report' }));
      expect(res.total).toBe(1);
      expect(res.records[0]?.name).toBe('Report 调研中图');
    });

    it('graph query：翻页 skip/take 切片；keyword 空白 trim 后不过滤', async () => {
      const page1 = await graphs.query(graphDto({ page: 1, pageSize: 2 }));
      expect(page1.total).toBe(3);
      expect(page1.records.map((r) => r.name)).toEqual([
        '乙图调研',
        'Report 调研中图',
      ]);
      const page2 = await graphs.query(graphDto({ page: 2, pageSize: 2 }));
      expect(page2.records.map((r) => r.name)).toEqual(['甲图']);

      const blank = await graphs.query(graphDto({ keyword: '   ' }));
      expect(blank.total).toBe(3);
    });

    it('graph query：page<=0 收敛 1（不产生负 skip）', async () => {
      const res = await graphs.query(graphDto({ page: 0, pageSize: 2 }));
      expect(res.page).toBe(1);
      expect(res.records.map((r) => r.name)).toEqual([
        '乙图调研',
        'Report 调研中图',
      ]);
    });

    it('automation query：keyword + 分页 + total 下推，hydrate 补位照常', async () => {
      const hit = await automations.query(taskDto({ keyword: '早报' }));
      expect(hit.total).toBe(1);
      expect(hit.records[0]?.name).toBe('乙任务早报');
      expect(hit.records[0]?.workspaceName).toBe('pushdown-ws');

      const page1 = await automations.query(taskDto({ page: 1, pageSize: 2 }));
      expect(page1.total).toBe(3);
      expect(page1.records.map((r) => r.name)).toEqual([
        '乙任务早报',
        'Report 任务',
      ]);
      const page2 = await automations.query(taskDto({ page: 2, pageSize: 2 }));
      expect(page2.records.map((r) => r.name)).toEqual(['甲任务']);

      const blank = await automations.query(taskDto({ keyword: ' ' }));
      expect(blank.total).toBe(3);
    });
  });
});
