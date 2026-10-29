/**
 * 专家导入导出纯函数（A2 尾）——与 mirror
 * electron/domains/ai/chat/assistant.repo.ts 的 serializeExpert/
 * parseExpertJson/dedupeName 同语义本地实现（留档：专家 IO 纯函数未收编
 * @tianshu/core dist——mirror 版绑定 AssistantRecord/src-react 类型与
 * create-expert 工具链，下沉 core 属独立批；本文件逐行对齐其
 * expertExportSchema 形状，expert-io 测试钉死 kind/version 与成员规则）。
 * 成员校验规则与 mirror create-expert teamMemberSchema 同口径
 * （kebab-case id、name/profession ≤30、systemPrompt ≤20000、团 ≤13、
 * id 团内唯一）。
 */
import { z } from 'zod';

/** 专家团成员（与 mirror TeamMember 同形） */
export interface ExpertTeamMember {
  id: string;
  name: string;
  profession: string;
  systemPrompt: string;
}

const TEAM_MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TEAM_MEMBERS_MAX = 13;
/** 成员 id 长度上限：对齐 mirror create-expert.ts TEAM_MEMBER_ID_MAX 与
 *  dispatch 工具参数 member 的 max(64)（超长 id 可落库却无法调度） */
const TEAM_MEMBER_ID_MAX = 64;

const teamMemberSchema = z.object({
  id: z
    .string()
    .regex(TEAM_MEMBER_ID_RE, '成员 id 必须是 kebab-case（如 risk-officer）')
    .max(TEAM_MEMBER_ID_MAX, `成员 id 最长 ${TEAM_MEMBER_ID_MAX} 字符`),
  name: z.string().min(1).max(30),
  profession: z.string().min(1).max(30),
  systemPrompt: z.string().min(1).max(20000),
});

/** 团内成员集合校验（条数上限与 id 团内唯一）；通过返回 null */
export function validateTeamMembers(
  members: ExpertTeamMember[],
): string | null {
  if (members.length > TEAM_MEMBERS_MAX) {
    return `专家团成员最多 ${TEAM_MEMBERS_MAX} 名`;
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.id)) {
      return `成员 id 重复: ${member.id}`;
    }
    seen.add(member.id);
  }
  return null;
}

/** 专家导出 JSON 固定形状（zod）：kind/version 魔术标识 + 内容字段
 *  （成员集合级规则 superRefine 同 mirror 导入 schema） */
export const expertExportSchema = z
  .object({
    kind: z.literal('tianshu-expert'),
    version: z.literal(1),
    name: z.string().min(1),
    systemPrompt: z.string().min(1),
    icon: z.string().optional(),
    description: z.string().optional(),
    profession: z.string().optional(),
    categoryId: z.string().optional(),
    tags: z.array(z.string()).max(3).optional(),
    quickPrompts: z.array(z.string()).max(3).optional(),
    skillNames: z.array(z.string()).max(3).optional(),
    expertType: z.enum(['agent', 'team']).optional(),
    members: z.array(teamMemberSchema).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.members) {
      return;
    }
    const reason = validateTeamMembers(data.members);
    if (reason) {
      ctx.addIssue({ code: 'custom', message: reason, path: ['members'] });
    }
  });

export type ExpertExportJson = z.infer<typeof expertExportSchema>;

export type ExpertParseResult =
  { ok: true; data: ExpertExportJson } | { ok: false; reason: string };

/** JSON 数组字符串列解析（非数组/解析失败回退 null——与 mirror 导入面
 *  「空数组不落键」语义配套：null 即不随导出落键） */
function parseJsonStringArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : null;
  } catch {
    return null;
  }
}

/** 专家行结构子集（assistant 表行——service 查询 select 全列后传入） */
export interface ExpertRowLike {
  name: string;
  systemPrompt: string;
  icon: string | null;
  description: string | null;
  profession: string | null;
  categoryId: string | null;
  tags: string | null;
  quickPrompts: string | null;
  skillNames: string | null;
  expertType: string | null;
  members: string | null;
}

/** 序列化为导出 JSON：剔除 id/builtin/sourceSlug/时间戳（归属与内置标识
 *  不随文件走），空数组不落键；expertType 仅 "team" 透传（agent 归一
 *  缺省，导入回读不降级） */
export function serializeExpert(row: ExpertRowLike): ExpertExportJson {
  const tags = parseJsonStringArray(row.tags);
  const quickPrompts = parseJsonStringArray(row.quickPrompts);
  const skillNames = parseJsonStringArray(row.skillNames);
  let members: ExpertTeamMember[] | null = null;
  if (row.members) {
    try {
      const parsed: unknown = JSON.parse(row.members);
      if (Array.isArray(parsed)) {
        members = parsed as ExpertTeamMember[];
      }
    } catch {
      members = null;
    }
  }
  return {
    kind: 'tianshu-expert',
    version: 1,
    name: row.name,
    ...(row.icon !== null ? { icon: row.icon } : {}),
    systemPrompt: row.systemPrompt,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.profession !== null ? { profession: row.profession } : {}),
    ...(row.categoryId !== null ? { categoryId: row.categoryId } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(quickPrompts && quickPrompts.length > 0 ? { quickPrompts } : {}),
    ...(skillNames && skillNames.length > 0 ? { skillNames } : {}),
    ...(row.expertType === 'team' ? { expertType: 'team' as const } : {}),
    ...(members && members.length > 0 ? { members } : {}),
  };
}

/** 解析导出 JSON：坏 JSON / 结构不符（缺 name、kind 不符等）拒绝并给原因 */
export function parseExpertJson(raw: string): ExpertParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '不是合法的 JSON 文件' };
  }
  const parsed = expertExportSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `专家文件格式不正确: ${parsed.error.issues[0]?.message ?? '结构错误'}`,
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 重名后缀（纯函数）：命中 `${name}-2`、`-3` 递增至不冲突；
 * nameExists 为查重闭包（DB findFirst 封装由调用方注入）
 */
export async function dedupeName(
  name: string,
  nameExists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  let finalName = name;
  let suffix = 2;
  while (await nameExists(finalName)) {
    finalName = `${name}-${suffix}`;
    suffix += 1;
  }
  return finalName;
}
