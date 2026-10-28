import {
  dedupeName,
  parseExpertJson,
  serializeExpert,
  validateTeamMembers,
  type ExpertRowLike,
} from 'src/core/expert-io';

// A2 尾：专家导入导出纯函数——与 mirror assistant.repo serializeExpert/
// parseExpertJson/dedupeName 同语义（本仓本地实现，未收编 core 留档见
// 文件头）。钉死导出形状（kind/version/剔除字段/空数组不落键）、解析
// 拒绝面（坏 JSON/缺 name/kind 不符/成员规则）与 dedupeName 递增。

const ROW: ExpertRowLike = {
  name: '翻译专家',
  systemPrompt: '你是翻译',
  icon: '🌐',
  description: 'desc',
  profession: null,
  categoryId: null,
  tags: '["a","b"]',
  quickPrompts: null,
  skillNames: '["skill-a"]',
  expertType: null,
  members: null,
};

describe('expert-io（A2 尾）', () => {
  it('serializeExpert 产 kind/version 固定形状，剔除归属/内置/时间戳面', () => {
    const json = serializeExpert(ROW);
    expect(json).toEqual({
      kind: 'tianshu-expert',
      version: 1,
      name: '翻译专家',
      icon: '🌐',
      systemPrompt: '你是翻译',
      description: 'desc',
      tags: ['a', 'b'],
      skillNames: ['skill-a'],
    });
    expect(JSON.stringify(json)).not.toContain('builtin');
    expect(JSON.stringify(json)).not.toContain('createdAt');
    expect(JSON.stringify(json)).not.toContain('sourceSlug');
  });

  it('serializeExpert team 行透传 expertType/members；空数组不落键', () => {
    const team = serializeExpert({
      ...ROW,
      tags: '[]',
      expertType: 'team',
      members: '[{"id":"m1","name":"n","profession":"p","systemPrompt":"sp"}]',
    });
    expect(team).toMatchObject({
      expertType: 'team',
      members: [{ id: 'm1', name: 'n', profession: 'p', systemPrompt: 'sp' }],
    });
    expect('tags' in team).toBe(false);
    // agent 值归一缺省（列契约只存 team|NULL）
    expect(
      'expertType' in serializeExpert({ ...ROW, expertType: 'agent' }),
    ).toBe(false);
  });

  it('parseExpertJson 合法 JSON 通过；坏 JSON/kind 不符/缺 name 拒（带原因）', () => {
    const good = parseExpertJson(JSON.stringify(serializeExpert(ROW)));
    expect(good.ok).toBe(true);

    expect(parseExpertJson('not-json{').ok).toBe(false);
    const badKind = parseExpertJson(
      JSON.stringify({
        kind: 'other',
        version: 1,
        name: 'x',
        systemPrompt: 's',
      }),
    );
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.reason).toContain('格式不正确');
    const missingName = parseExpertJson(
      JSON.stringify({ kind: 'tianshu-expert', version: 1, systemPrompt: 's' }),
    );
    expect(missingName.ok).toBe(false);
  });

  it('parseExpertJson 成员规则：id 非 kebab/超 64 字符/超 13 名/id 重复拒', () => {
    const member = { id: 'm1', name: 'n', profession: 'p', systemPrompt: 's' };
    const base = {
      kind: 'tianshu-expert',
      version: 1,
      name: 'x',
      systemPrompt: 's',
    };
    for (const members of [
      [{ ...member, id: 'Bad Id' }],
      [{ ...member, id: 'a'.repeat(65) }],
      Array.from({ length: 14 }, (_, i) => ({ ...member, id: `m${i}` })),
      [member, { ...member }],
    ]) {
      expect(parseExpertJson(JSON.stringify({ ...base, members })).ok).toBe(
        false,
      );
    }
    expect(
      parseExpertJson(
        JSON.stringify({
          ...base,
          members: [{ ...member, id: 'a'.repeat(64) }],
        }),
      ).ok,
    ).toBe(true);
    expect(validateTeamMembers([member, { ...member, id: 'm2' }])).toBeNull();
  });

  it('dedupeName 命中递增至不冲突', async () => {
    const taken = new Set(['名', '名-2']);
    const name = await dedupeName('名', async (c) => taken.has(c));
    expect(name).toBe('名-3');
  });
});
