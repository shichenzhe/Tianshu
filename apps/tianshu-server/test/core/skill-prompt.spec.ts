// 移植自 mirror tests/ai/skill-prompt.test.ts（5526304，5 用例）——T5 移植
// skill-prompt.ts 时测试落下了，本批补齐。mirror 末例用 vitest
// toMatchInlineSnapshot，jest+ts-jest 下改为等值模板串断言（内容零改动）。
import {
  buildSystemPrompt,
  type SkillSummary,
} from 'src/core/skill-prompt';

/** 最小 SkillSummary 构造（本函数只消费 name/description 两字段） */
const skill = (name: string, description: string): SkillSummary => ({
  name,
  description,
});

describe('buildSystemPrompt', () => {
  it('无 skills 时原样返回 base', () => {
    expect(buildSystemPrompt('你是助手', [])).toBe('你是助手');
  });

  it('无 skills 且 base 为 undefined 时返回 undefined', () => {
    expect(buildSystemPrompt(undefined, [])).toBeUndefined();
  });

  it('base undefined + skills → 仅技能段（无前缀空行）', () => {
    expect(buildSystemPrompt(undefined, [skill('greeting', '问候')])).toBe(
      '你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引；指引中引用的技能包内文件（如 references/jira.md）以 path 参数读取）：\n- greeting: 问候',
    );
  });

  it('base 存在 → base + 空行 + 技能段，含全部 name: description 行', () => {
    expect(
      buildSystemPrompt('你是助手', [
        skill('greeting', '问候'),
        skill('web-search', '联网搜索'),
      ]),
    ).toBe(
      '你是助手\n\n' +
        '你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引；指引中引用的技能包内文件（如 references/jira.md）以 path 参数读取）：\n' +
        '- greeting: 问候\n' +
        '- web-search: 联网搜索',
    );
  });

  it('换行与空行拼接精确（快照锚定模板）', () => {
    expect(
      buildSystemPrompt('BASE', [skill('a', '描述 A'), skill('b', '描述 B')]),
    ).toBe(
      'BASE\n\n' +
        '你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引；指引中引用的技能包内文件（如 references/jira.md）以 path 参数读取）：\n' +
        '- a: 描述 A\n' +
        '- b: 描述 B',
    );
  });
});
