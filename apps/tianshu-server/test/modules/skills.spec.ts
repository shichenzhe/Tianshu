import { SkillsService } from 'src/modules/skills/skills.service';

// A3 批：skills/query 契约增量（scenarios/source/builtin 可选段）两端同
// 实现——本用例钉无头端实现：skillRecord 行补扩展段、无行技能不受影响、
// builtin 判定取 source。磁盘扫描/数据根经 jest.mock 替身（纯服务级测试）。
jest.mock('src/core/tools/skill-loader', () => ({
  loadSkills: jest.fn(() => [
    { name: 'alpha', description: 'desc-a', bodyPath: '/x/a', dir: '/x' },
    { name: 'beta', description: null, bodyPath: '/x/b', dir: '/x' },
  ]),
}));

jest.mock('src/core/chat-runner.service', () => ({
  resolveDataRoot: () => '/tmp/tianshu-test-skills',
}));

/** PrismaService 结构子集替身（skillRecord.findMany 内存表） */
function makePrismaDouble(rows: Array<Record<string, unknown>>) {
  return {
    skillRecord: {
      findMany: jest.fn(async (args?: { where?: { enabled?: boolean } }) =>
        args?.where?.enabled === false
          ? rows.filter((row) => row.enabled === false)
          : rows,
      ),
    },
  } as unknown as ConstructorParameters<typeof SkillsService>[0];
}

describe('SkillsService（A3 批契约增量）', () => {
  it('有 skillRecord 行的技能补 scenarios/source/builtin 段', async () => {
    const service = new SkillsService(
      makePrismaDouble([
        {
          name: 'alpha',
          enabled: false,
          scenarios: '["daily","coding"]',
          source: 'market',
        },
      ]),
    );
    const list = await service.query();
    expect(list).toEqual([
      {
        name: 'alpha',
        description: 'desc-a',
        enabled: false,
        scenarios: ['daily', 'coding'],
        source: 'market',
        builtin: false,
      },
      {
        name: 'beta',
        description: null,
        enabled: true,
        builtin: false,
      },
    ]);
  });

  it('builtin 判定取 source；无 scenarios 列不落键', async () => {
    const service = new SkillsService(
      makePrismaDouble([
        { name: 'beta', enabled: true, scenarios: null, source: 'builtin' },
      ]),
    );
    const list = await service.query();
    expect(list[1]).toEqual({
      name: 'beta',
      description: null,
      enabled: true,
      source: 'builtin',
      builtin: true,
    });
    expect(list[1]).not.toHaveProperty('scenarios');
  });
});
