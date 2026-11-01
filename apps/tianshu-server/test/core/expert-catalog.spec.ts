import {
  mergeExpertSkills,
  parseJsonStringArray,
} from 'src/core/expert-catalog';
import type { SkillSummary } from 'src/core/skill-prompt';

// 移植自 mirror tests/ai/expert-catalog.test.ts（2084a7e）：
// mirror 版夹具引前端 MARKET_EXPERTS 与完整 SkillInfo——服务端无渲染层
// 数据，以同形状本地夹具代之。buildExpertCatalogPrompt 已删
// （2026-11-01 目录出 system 批，双端同删）。

const skill = (name: string): SkillSummary => ({
  name,
  description: `d-${name}`,
});

describe('mergeExpertSkills', () => {
  const skills = [skill('a'), skill('b')];

  it('专家技能并入去重', () => {
    expect(
      mergeExpertSkills(skills, ['b', 'c'], [skill('a'), skill('b')]).map(
        (s) => s.name,
      ),
    ).toEqual(['a', 'b']);
  });

  it('undefined/空数组原样返回', () => {
    expect(mergeExpertSkills(skills, undefined, [])).toBe(skills);
    expect(mergeExpertSkills(skills, [], [])).toBe(skills);
  });

  it('三情形：未启用但附带→从全集补入；既启用又附带→不重复；已卸载→静略', () => {
    // 启用集 [a, c]；全集 [a, b, c]（b 已安装未启用；gone 不在全集=已卸载）
    const enabled = [skill('a'), skill('c')];
    const all = [skill('a'), skill('b'), skill('c')];
    const merged = mergeExpertSkills(enabled, ['b', 'c', 'gone'], all);
    // enabled 原序保持，新增项（b）按 skillNames 序追加，c 不重复、gone 静略
    expect(merged.map((s) => s.name)).toEqual(['a', 'c', 'b']);
  });

  it('新增多项按 skillNames 序追加', () => {
    const enabled = [skill('a')];
    const all = [skill('x'), skill('y'), skill('z'), skill('a')];
    const merged = mergeExpertSkills(enabled, ['z', 'y', 'x'], all);
    expect(merged.map((s) => s.name)).toEqual(['a', 'z', 'y', 'x']);
  });
});

describe('parseJsonStringArray', () => {
  it('合法 JSON 字符串数组解析；非字符串项剔除', () => {
    expect(parseJsonStringArray('["a", "b"]')).toEqual(['a', 'b']);
    expect(parseJsonStringArray('["a", 1, null, "b"]')).toEqual(['a', 'b']);
  });

  it('null/坏 JSON/非数组 → 空数组不抛错（展示字段回退）', () => {
    expect(parseJsonStringArray(null)).toEqual([]);
    expect(parseJsonStringArray('not json')).toEqual([]);
    expect(parseJsonStringArray('{"a":1}')).toEqual([]);
  });
});
