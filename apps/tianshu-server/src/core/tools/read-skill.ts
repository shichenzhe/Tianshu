/**
 * read_skill 内置工具（自 mirror electron/domains/ai/agent/read-skill.ts
 * 逐字移植）：按名查扫描结果集读 SKILL.md 正文。execute 只按表内 name
 * 匹配，不拼接任何外部路径 → 表外路径天然不可达。
 * onRead（读取即意图信号，与 mirror 同构）：成功读取后以 (ctx, skill)
 * 触发，返回串以空行追加在正文尾（截断路径同样触发；查无/读败不触发）
 * ——本仓无工具门控（chat-runner 全量注入），钩子留同构空位供消费
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { SkillInfo } from './skill-loader';
import type { ToolContext, ToolDefinition } from './tool-definition';

/** 正文读取字节上限，超出截断并标注 */
const BODY_LIMIT = 256 * 1024;

/** 截断尾部标记 */
const TRUNCATED_SUFFIX = '\n…（已截断）';

/** 读 SKILL.md 正文（同步实现）：精确匹配表内 name，查不到不触任何磁盘读取 */
function readSkillBody(
  skills: SkillInfo[],
  name: string,
  ctx: ToolContext,
  onRead?: (ctx: ToolContext, skill: SkillInfo) => string | void,
): string {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return '错误: 技能不存在';
  let buf: Buffer;
  try {
    buf = readFileSync(skill.bodyPath);
  } catch {
    return '错误: 技能文件读取失败';
  }
  const body =
    buf.byteLength > BODY_LIMIT
      ? `${buf.subarray(0, BODY_LIMIT).toString('utf8')}${TRUNCATED_SUFFIX}`
      : buf.toString('utf8');
  const note = onRead?.(ctx, skill);
  return note ? `${body}\n\n${note}` : body;
}

export function makeReadSkillTool(
  skills: SkillInfo[],
  onRead?: (ctx: ToolContext, skill: SkillInfo) => string | void,
): ToolDefinition<{ name: string }> {
  return {
    name: 'read_skill',
    description: '读取指定技能的完整使用指引（SKILL.md 正文）',
    parameters: z.object({
      name: z.string().describe('技能名，来自系统提示中的技能清单'),
    }),
    kind: 'read',
    // 同步读 + Promise.resolve 包装（repo eslint 禁无 await 的 async）
    execute: (ctx, args) =>
      Promise.resolve(readSkillBody(skills, args.name, ctx, onRead)),
  };
}
