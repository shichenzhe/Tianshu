import os from 'node:os';
import path from 'node:path';
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

/** ConfigService 结构子集替身（get 返回缺省值——默认部署口径） */
function makeConfigDouble() {
  return {
    get: (_key: string, defaultValue: unknown) => defaultValue,
  } as never;
}

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
    const list = await new SkillsService(
      makePrismaDouble([
        {
          name: 'alpha',
          enabled: false,
          scenarios: '["daily","coding"]',
          source: 'market',
        },
      ]),
      makeConfigDouble(),
    ).query();
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
    const list = await new SkillsService(
      makePrismaDouble([
        { name: 'beta', enabled: true, scenarios: null, source: 'builtin' },
      ]),
      makeConfigDouble(),
    ).query();
    expect(list[1]).toEqual({
      name: 'beta',
      description: null,
      enabled: true,
      source: 'builtin',
      builtin: true,
    });
    expect(list[1]).not.toHaveProperty('scenarios');
  });

  it('skills 目录口径：默认部署（无 env + 缺省 config）解析为 home 绝对路径，非 CWD 相对——管理面与 chat 消费同目录的回归钉', async () => {
    const prevRoot = process.env.TIANSHU_DATA_ROOT;
    delete process.env.TIANSHU_DATA_ROOT;
    try {
      await new SkillsService(
        makePrismaDouble([]),
        makeConfigDouble(),
      ).query();
      const { loadSkills } = jest.requireMock('src/core/tools/skill-loader');
      const dir = (loadSkills as jest.Mock).mock.calls[0][0][0]
        .dir as string;
      // 曾为 resolveDataRoot('.') → './skills'（CWD 相对），默认部署下
      // query 恒空、install 落到 chat 永不加载的目录
      expect(dir).toBe(path.join(os.homedir(), '.tianshu-server', 'skills'));
      expect(path.isAbsolute(dir)).toBe(true);
    } finally {
      if (prevRoot !== undefined) {
        process.env.TIANSHU_DATA_ROOT = prevRoot;
      }
    }
  });
});
