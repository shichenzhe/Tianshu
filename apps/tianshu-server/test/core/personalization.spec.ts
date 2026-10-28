// personalization 读侧单测（PL-1，spec §2.1）：
// - loadPersonalization 回退两态：option 空 → 全默认（D8：system 与现状
//   一致）；查询异常（reject/同步抛）→ 回退全默认 + 不炸（对话不断）
// - 正常行解析（KEYS/截断/bool 语义与 mirror fromAppOptions 对应段一致）
// - chat-runner system 组装含个性化段（fake model 断言 system 内容含
//   persona/【身份】/【用户画像记忆】标记）；无行时不含任何个性化段
//   （无头端 Profile 初始为空 = mirror 未配置时一致）
import type { BaseMessage } from '@langchain/core/messages';
import {
  defaultPersonalization,
  PERSONALIZATION_KEYS,
  type PersonalizationConfig,
} from '@tianshu/core';
import {
  fromAppOptions,
  loadPersonalization,
  type OptionPrismaLike,
} from 'src/core/personalization';
import { createTestDb, type TestDb } from '../support/test-db';
import {
  makeDirs,
  makeRunner,
  seedSession,
  type TestDirs,
} from '../support/chat-fixture';

/** 最小 stub（findMany 为独立 jest.fn，入参断言用——db-url.spec 同款手法） */
function stubOption(rows: Array<{ name: string; value: string }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  return { db: { findMany } as OptionPrismaLike, findMany };
}

describe('loadPersonalization（PL-1 读侧）', () => {
  it('option 空 → 全默认（D8：与 mirror 未配置一致）', async () => {
    const { db, findMany } = stubOption([]);
    const config = await loadPersonalization(db);
    expect(config).toEqual(defaultPersonalization());
    // 现查语义：按 KEYS 全集查 type="app" 行（不缓存）
    expect(findMany).toHaveBeenCalledWith({
      where: { type: 'app', name: { in: Object.values(PERSONALIZATION_KEYS) } },
      select: { name: true, value: true },
    });
  });

  it('非个性化行 → 全默认', async () => {
    const config = await loadPersonalization(
      stubOption([{ name: 'keepAwake', value: 'true' }]),
    );
    expect(config).toEqual(defaultPersonalization());
  });

  it('正常行逐字段解析（persona/昵称/画像/记忆开关）+ 超长截断', async () => {
    const config = await loadPersonalization(
      stubOption([
        { name: PERSONALIZATION_KEYS.persona, value: 'PERSONA-X' },
        { name: PERSONALIZATION_KEYS.userNickname, value: '黄先生' },
        {
          name: PERSONALIZATION_KEYS.memoryProfile,
          value: 'x'.repeat(9000),
        },
        { name: PERSONALIZATION_KEYS.memoryEnabled, value: 'false' },
        { name: PERSONALIZATION_KEYS.responseStyle, value: 'yolo' },
      ]),
    );
    expect(config.persona).toBe('PERSONA-X');
    expect(config.userNickname).toBe('黄先生');
    expect(config.memoryProfile).toHaveLength(8000);
    expect(config.memoryEnabled).toBe(false);
    // 未知风格回退 default（mirror parseStyle 同语义）
    expect(config.responseStyle).toBe('default');
  });

  it('查询 reject → 回退全默认（对话不中断）', async () => {
    const db = {
      findMany: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as OptionPrismaLike;
    await expect(loadPersonalization(db)).resolves.toEqual(
      defaultPersonalization(),
    );
  });

  it('查询同步抛错（delegate 缺失场景）→ 回退全默认', async () => {
    const db = {
      findMany: jest.fn().mockImplementation(() => {
        throw new TypeError('prisma.option is undefined');
      }),
    } as unknown as OptionPrismaLike;
    await expect(loadPersonalization(db)).resolves.toEqual(
      defaultPersonalization(),
    );
  });
});

describe('fromAppOptions（mirror config 解析段对应）', () => {
  it('空行数组 → 全默认', () => {
    expect(fromAppOptions([])).toEqual(defaultPersonalization());
  });

  it('畸形 bool 仅字面 true 为真', () => {
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: 'yes' },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: 'true' },
    ]);
    expect(config.welcomeLoading).toBe(false);
    expect(config.fileChangeDetails).toBe(true);
  });

  it('返回类型收敛 PersonalizationConfig（包类型 witness）', () => {
    const config: PersonalizationConfig = fromAppOptions([]);
    expect(config.aiName).toBe('天枢');
  });
});

describe('chat system 组装（PL-1 注入面）', () => {
  let db: TestDb;
  let dirs: TestDirs;

  beforeAll(async () => {
    db = await createTestDb();
    dirs = makeDirs('tianshu-pers-');
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
    dirs.cleanup();
  });

  const messageText = (m: BaseMessage): string =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

  /** 首次模型调用的 system 文本（seenInputs[0][0] = createReactAgent 注入的 SystemMessage） */
  const systemTextOf = (seen: BaseMessage[][]): string =>
    messageText(seen[0][0]);

  it('无个性化行 → system 不含任何个性化段（Profile 空 = mirror 未配置一致）', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'ok' }] },
    ]);
    await runner.run({ sessionId: session.id, content: 'hi' });
    const system = systemTextOf(model.seenInputs);
    expect(system).not.toContain('【身份】');
    expect(system).not.toContain('【用户画像记忆】');
    expect(system).not.toContain('【用户长期记忆】');
    expect(system).not.toContain('【回复风格】');
  });

  it('个性化行 + 场景会话 → system 含 persona 前置/身份段/画像段，且场景段居个性化段之后（段序断言）', async () => {
    for (const [name, value] of [
      [PERSONALIZATION_KEYS.persona, 'PERSONA-X'],
      [PERSONALIZATION_KEYS.userNickname, '黄先生'],
      [PERSONALIZATION_KEYS.memoryProfile, '## 工作背景\n画像'],
    ] as const) {
      await db.prisma.option.create({ data: { type: 'app', name, value } });
    }
    // 场景值确认非空（scenario=daily 为 SCENARIO_PROMPTS 已知键——空值时
    // buildScenarioSystem 原样透传，段序断言无从比较）
    const { session } = await seedSession(db, dirs, { scenario: 'daily' });
    const { runner, model } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'ok' }] },
    ]);
    await runner.run({ sessionId: session.id, content: 'hi' });
    const system = systemTextOf(model.seenInputs);
    expect(system).toContain('PERSONA-X');
    expect(system).toContain('【身份】');
    expect(system).toContain('称呼用户为「黄先生」');
    expect(system).toContain('【用户画像记忆】');
    expect(system).toContain(
      '以下是系统从对话中提炼的用户画像，请在对话中参考：',
    );
    // persona 前置：段序 persona 在身份段之前
    expect(system.indexOf('PERSONA-X')).toBeLessThan(
      system.indexOf('【身份】'),
    );
    // PL-T3（PL-T1 review 移交）：场景段在个性化段之后——mirror
    // chat.service assembleContext 段序同构（personalized 先包裹、
    // buildScenarioSystem(scenario, personalized) 后追加）
    const scenarioIndex = system.indexOf('当前处于日常办公场景');
    expect(scenarioIndex).toBeGreaterThanOrEqual(0);
    expect(scenarioIndex).toBeGreaterThan(system.indexOf('PERSONA-X'));
    expect(scenarioIndex).toBeGreaterThan(system.indexOf('【用户画像记忆】'));
  });
});
