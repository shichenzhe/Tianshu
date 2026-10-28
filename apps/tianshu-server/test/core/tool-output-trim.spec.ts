import type { MessageBlock, ToolCallBlock } from '@tianshu/protocol';
import {
  TRIM_HEAD_CHARS,
  TRIM_RECENT_ROUNDS,
  TRIM_TAIL_CHARS,
  TRIM_THRESHOLD_CHARS,
  trimHistoryToolOutputs,
  trimToolOutputs,
} from '@tianshu/core';

// 移植自 mirror tests/ai/tool-output-trim.test.ts（9e46f83，T31 整轮豁免版）

const toolCall = (
  id: string,
  output: ToolCallBlock['output'],
): ToolCallBlock => ({
  type: 'tool_call',
  toolCallId: id,
  toolName: 'read_file',
  args: { path: 'src/a.ts' },
  state: 'done',
  output,
});

/** 头/中/尾字符可辨的超限输出（长度 = 阈值 + extra） */
const oversized = (extra = 2000) =>
  'H'.repeat(TRIM_HEAD_CHARS) +
  'M'.repeat(TRIM_THRESHOLD_CHARS + extra - TRIM_HEAD_CHARS - TRIM_TAIL_CHARS) +
  'T'.repeat(TRIM_TAIL_CHARS);

/** 超限输出被移除的字符数（长度 - 头 - 尾） */
const removedChars = (extra = 2000) =>
  TRIM_THRESHOLD_CHARS + extra - TRIM_HEAD_CHARS - TRIM_TAIL_CHARS;

const annotation = (removed: number) => `[已截断 ${removed} 字符]`;

describe('trimToolOutputs 旧轮工具输出瘦身', () => {
  it('非最近轮超限截断：头 + 动态字符数标注 + 尾（轮内全部超限块）', () => {
    const output = oversized();
    const blocks: MessageBlock[] = [
      toolCall('a', output),
      toolCall('b', output),
    ];
    // 本消息之后已有 2 个工具轮 → 本消息非最近轮，块级超限全截
    const result = trimToolOutputs(blocks, { newerToolCallRounds: 2 });
    const expected =
      'H'.repeat(TRIM_HEAD_CHARS) +
      `\n\n${annotation(removedChars())}\n\n` +
      'T'.repeat(TRIM_TAIL_CHARS);
    expect(result[0]).toEqual({ ...toolCall('a', output), output: expected });
    expect(result[1]).toEqual({ ...toolCall('b', output), output: expected });
  });

  it('最近轮整条豁免：一轮 3 个超限 tool_call 全不截（引用不变）', () => {
    const blocks: MessageBlock[] = [
      toolCall('a', oversized()),
      toolCall('b', oversized()),
      toolCall('c', oversized()),
    ];
    // 缺省 newerToolCallRounds=0 → 本消息即最近工具轮
    const result = trimToolOutputs(blocks);
    expect(result[0]).toBe(blocks[0]);
    expect(result[1]).toBe(blocks[1]);
    expect(result[2]).toBe(blocks[2]);
    // 其后仅 1 个工具轮 → 本消息为倒数第 2 轮，仍整条豁免
    const stillRecent = trimToolOutputs(blocks, { newerToolCallRounds: 1 });
    expect(stillRecent[0]).toBe(blocks[0]);
    expect(stillRecent[2]).toBe(blocks[2]);
  });

  it('恰好阈值不截断', () => {
    const blocks: MessageBlock[] = [
      toolCall('old', 'x'.repeat(TRIM_THRESHOLD_CHARS)),
    ];
    const result = trimToolOutputs(blocks, { newerToolCallRounds: 2 });
    expect(result[0]).toBe(blocks[0]);
  });

  it('非字符串 output 不动', () => {
    const blocks: MessageBlock[] = [
      toolCall('a', oversized()),
      toolCall('b', undefined),
      toolCall('c', { raw: true }),
    ];
    const result = trimToolOutputs(blocks, { newerToolCallRounds: 2 });
    expect(result[1]).toBe(blocks[1]);
    expect(result[2]).toBe(blocks[2]);
    expect((result[0] as ToolCallBlock).output).toContain(
      annotation(removedChars()),
    );
  });

  it('入参不可变：返回新数组，原数组与块对象不被改动', () => {
    const blocks: MessageBlock[] = [
      { type: 'text', text: '前导' },
      toolCall('old', oversized()),
    ];
    const snapshot = JSON.stringify(blocks);
    Object.freeze(blocks);
    blocks.forEach((block) => Object.freeze(block));
    // 截断路径与豁免路径均不写原对象
    const trimmed = trimToolOutputs(blocks, { newerToolCallRounds: 2 });
    expect(trimmed).not.toBe(blocks);
    expect(JSON.stringify(blocks)).toBe(snapshot);
    // 非 tool_call 块浅拷贝保留原引用
    expect(trimmed[0]).toBe(blocks[0]);
    const exempt = trimToolOutputs(blocks);
    expect(exempt).not.toBe(blocks);
    expect(JSON.stringify(blocks)).toBe(snapshot);
  });

  it('无 tool_call 或未超限时原样返回（新数组）', () => {
    const blocks: MessageBlock[] = [
      { type: 'text', text: '纯文本' },
      { type: 'usage', input: 1, output: 2 },
    ];
    const result = trimToolOutputs(blocks, { newerToolCallRounds: 5 });
    expect(result).toEqual(blocks);
    expect(result).not.toBe(blocks);
  });
});

describe('trimHistoryToolOutputs 整段历史接线', () => {
  it('从尾数工具轮整条豁免：倒数第 3 个工具轮起截，入参 JSON 不动', () => {
    const history = [
      {
        role: 'assistant' as const,
        blocks: JSON.stringify([
          toolCall('old-a', oversized()),
          toolCall('old-b', oversized()),
        ]),
      },
      {
        role: 'user' as const,
        blocks: JSON.stringify([{ type: 'text', text: '继续' }]),
      },
      {
        role: 'assistant' as const,
        blocks: JSON.stringify([toolCall('mid-a', 'ok')]),
      },
      {
        role: 'user' as const,
        blocks: JSON.stringify([{ type: 'text', text: '再看' }]),
      },
      {
        role: 'assistant' as const,
        blocks: JSON.stringify([
          toolCall('new-a', oversized()),
          toolCall('new-b', oversized()),
        ]),
      },
      {
        role: 'user' as const,
        blocks: JSON.stringify([{ type: 'text', text: '总结' }]),
      },
    ];
    const snapshot = history.map((m) => m.blocks);
    const result = trimHistoryToolOutputs(history);
    // 工具轮从尾数：末条 assistant 为第 1 轮，mid 为第 2 轮（均整条
    // 豁免——末轮虽超限也全保），首条为第 3 轮 → 全截
    const oldMsg = result[0].blocks as ToolCallBlock[];
    expect(oldMsg[0].output).toContain(annotation(removedChars()));
    expect(oldMsg[1].output).toContain(annotation(removedChars()));
    expect((result[2].blocks as ToolCallBlock[])[0].output).toBe('ok');
    const newMsg = result[4].blocks as ToolCallBlock[];
    expect(newMsg[0].output).toHaveLength(TRIM_THRESHOLD_CHARS + 2000);
    expect(newMsg[1].output).toHaveLength(TRIM_THRESHOLD_CHARS + 2000);
    // 入参 JSON 字符串原样（DB 原文不动）
    expect(history.map((m) => m.blocks)).toEqual(snapshot);
    expect(history[0].blocks).toContain('MMM');
  });

  it('解析失败的畸形 blocks 容错为空数组', () => {
    const result = trimHistoryToolOutputs([
      { role: 'user' as const, blocks: 'not-json' },
    ]);
    expect(result[0].blocks).toEqual([]);
  });

  it('不含 tool_call 的消息不计轮：不打断「最近 N 轮」计数', () => {
    const history = [
      {
        role: 'assistant' as const,
        blocks: JSON.stringify([toolCall('old-a', oversized())]),
      },
      {
        // 纯文本 assistant：不含 tool_call，不占豁免名额
        role: 'assistant' as const,
        blocks: JSON.stringify([{ type: 'text', text: '文字回复' }]),
      },
      {
        role: 'assistant' as const,
        blocks: JSON.stringify([toolCall('new-a', 'ok')]),
      },
    ];
    const result = trimHistoryToolOutputs(history);
    // 从尾数工具轮：new-a 为第 1 轮，old-a 为第 2 轮 → 仍豁免
    // （若误按消息数计，old-a 会成第 3 轮被误截）
    expect((result[0].blocks as ToolCallBlock[])[0].output).toHaveLength(
      TRIM_THRESHOLD_CHARS + 2000,
    );
  });
});

describe('常量集中可调', () => {
  it('导出阈值/头尾/最近轮常量', () => {
    expect(TRIM_THRESHOLD_CHARS).toBe(6000);
    expect(TRIM_HEAD_CHARS).toBe(3000);
    expect(TRIM_TAIL_CHARS).toBe(1000);
    expect(TRIM_RECENT_ROUNDS).toBe(2);
  });
});
