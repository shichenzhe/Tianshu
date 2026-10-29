/**
 * create_expert / update_expert 内置工具（专家 2.0，WorkBuddy expert-manager
 * 移植）：AI 在对话中创建/修改专家（assistant 行，builtin:false），落库后
 * 即可在「专家·技能·连接器」页与会话中选用。kind:"write" → 走统一审批
 * （runToolCall 挂起，批准后才 execute）；错误一律转「错误: ...」字符串
 * 回喂模型，不抛出。纯 Node 实现（禁止 import electron），prisma 仓储子集
 * 与已安装技能名清单经 deps 注入可测（create-skill 先例）；userId 取自
 * 工具 ctx（会话归属用户，executeToolSafe 装配透传）。
 * 专家团二期：+expertType/members（team 主理人 + 1-13 名成员）；成员校验
 * 常量（TEAM_MEMBER_ID_RE/TEAM_MEMBERS_MAX/teamMemberSchema/
 * validateTeamMembers）导出供专家导入 schema 复用（DRY 单源）。
 */
import { z } from "zod";
import type { TeamMember } from "../chat/expert-team";
import type { ToolContext, ToolDefinition } from "./file-tools";

export const CREATE_EXPERT_TOOL_NAME = "create_expert";
export const UPDATE_EXPERT_TOOL_NAME = "update_expert";

/** emoji 宽松校验（UTS51）：表意符号或部件组合（含 ZWJ 序列、VS16、
 *  皮肤色修饰符），多码点 emoji 不误伤；且至少含一个表意符号——纯部件
 *  组合（裸数字 "123" 等键帽基字符）不构成 emoji，拒绝 */
const EMOJI_RE =
  /^(?=.*\p{Extended_Pictographic})(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;

/** 成员 id 规范（专家团二期）：kebab-case——小写字母/数字开头，
 *  其后小写字母/数字/连字符（如 risk-officer） */
export const TEAM_MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 专家团成员数上限（1-13 名，对齐 WorkBuddy 最大团规模）：工具校验链与
 *  导入 schema 共用（DRY 单源） */
export const TEAM_MEMBERS_MAX = 13;

/** 成员 id 长度上限：对齐 dispatch 工具参数 member 的 max(64)——
 *  超长 id 可落库却无法被调度，写面拒绝（读面不重校验，既有数据可读） */
export const TEAM_MEMBER_ID_MAX = 64;

/** 专家团成员 schema（TeamMember 同形，id 唯一性是集合级规则见
 *  validateTeamMembers）：id kebab-case 且 ≤64、name/profession 1..30、
 *  systemPrompt 1..20000——create/update 工具与专家导入 schema 共用
 *  （WorkBuddy 复刻成员人设最长约 1.8 万字符） */
export const teamMemberSchema = z.object({
  id: z
    .string()
    .regex(TEAM_MEMBER_ID_RE, "成员 id 必须是 kebab-case（如 risk-officer）")
    .max(TEAM_MEMBER_ID_MAX, `成员 id 最长 ${TEAM_MEMBER_ID_MAX} 字符`)
    .describe("成员 id（kebab-case、团内唯一、64 字符内）"),
  name: z
    .string()
    .min(1)
    .max(30)
    .describe("成员花名（30 字内，暗含职能巧思、不与头衔重复）"),
  profession: z
    .string()
    .min(1)
    .max(30)
    .describe("成员职业头衔（30 字内），如「风控官」"),
  systemPrompt: z
    .string()
    .min(1)
    .max(20000)
    .describe("成员系统提示词（五段式，同专家）"),
});

/** 团内成员集合校验（跨成员规则，工具校验链与导入 schema 共用）：
 *  条数上限与 id 团内唯一；通过返回 null，失败返回错误原因 */
export function validateTeamMembers(members: TeamMember[]): string | null {
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

/** 专家团字段跨字段校验：members 仅 team 可用（agent/缺省传即报错）；
 *  requireMembers=true（create）时 team 必须带 1-13 名成员，=false
 *  （update 差量）不强制（行可能已有成员，members 传即整体覆盖） */
function validateTeamFields(
  params: Pick<CreateExpertParams, "expertType" | "members">,
  requireMembers: boolean,
): string | null {
  if (params.expertType !== "team" && params.members !== undefined) {
    return "members 仅 expertType=team（专家团）可设置";
  }
  if (params.expertType === "team") {
    if (params.members === undefined || params.members.length === 0) {
      return requireMembers
        ? "expertType=team 必须提供 1-13 名成员（members）"
        : null;
    }
    return validateTeamMembers(params.members);
  }
  return null;
}

const createSchema = z.object({
  name: z.string().min(1).max(30).describe("专家名称（30 字内）"),
  profession: z
    .string()
    .max(30)
    .optional()
    .describe("职业头衔，如「软件架构师」"),
  systemPrompt: z
    .string()
    .min(1)
    .describe("系统提示词（五段式：角色/能力/流程/输出/注意事项）"),
  description: z.string().max(120).optional().describe("能力介绍（40-120 字）"),
  tags: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("擅长领域标签，最多 3 个"),
  icon: z
    .string()
    .max(8)
    .refine((value) => EMOJI_RE.test(value), "icon 必须是 emoji 字符")
    .optional()
    .describe("单个 emoji 头像"),
  quickPrompts: z
    .array(z.string().min(1).max(200))
    .max(3)
    .optional()
    .describe("推荐提示词，最多 3 条，口语化可直接发送"),
  skillNames: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("附带技能名（≤3，限已安装；新技能先 create_skill）"),
  expertType: z
    .enum(["agent", "team"])
    .optional()
    .describe("专家类型：agent（默认）/team（专家团，须配 members）"),
  members: z
    .array(teamMemberSchema)
    .optional()
    .describe("团队成员 1-13 名（仅 team 可用；传即整体覆盖）"),
});

/** 更新 schema：create 全字段 optional + name 必填（定位既有专家，不改名） */
const updateSchema = createSchema.partial().extend({
  name: z.string().min(1).max(30).describe("要修改的专家名称（精确匹配）"),
});

export type CreateExpertParams = z.infer<typeof createSchema>;
export type UpdateExpertParams = z.infer<typeof updateSchema>;

export type ExpertCheck<T> =
  { ok: true; data: T } | { ok: false; reason: string };

/** 校验链：zod 结构（含条数/长度上限）→ 失败取首条 issue 文案（create-skill 同款）；
 *  结构过后接专家团跨字段校验（team 必带成员 / agent 不可带成员 / 集合规则） */
export function validateCreateExpertParams(
  args: unknown,
): ExpertCheck<CreateExpertParams> {
  const parsed = createSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `参数不合法: ${parsed.error.issues[0]?.message ?? "结构错误"}`,
    };
  }
  const teamReason = validateTeamFields(parsed.data, true);
  if (teamReason) {
    return { ok: false, reason: `参数不合法: ${teamReason}` };
  }
  return { ok: true, data: parsed.data };
}

export function validateUpdateExpertParams(
  args: unknown,
): ExpertCheck<UpdateExpertParams> {
  const parsed = updateSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `参数不合法: ${parsed.error.issues[0]?.message ?? "结构错误"}`,
    };
  }
  // requireMembers=false：差量更新不强求 members（行可能已有），仅同载校验
  const teamReason = validateTeamFields(parsed.data, false);
  if (teamReason) {
    return { ok: false, reason: `参数不合法: ${teamReason}` };
  }
  return { ok: true, data: parsed.data };
}

/** assistant 行最小消费形状（定位到的既有专家） */
interface ExpertDbRow {
  id: number;
}

/** assistant.create 载荷（AssistantRepository.create 的工具子集口径；数组列已 JSON 序列化） */
interface ExpertCreateData {
  name: string;
  icon?: string;
  systemPrompt: string;
  description?: string;
  profession?: string;
  /** 恒 undefined：AI 不指定分类（spec §2），用户可在表单改 */
  categoryId: undefined;
  tags?: string;
  quickPrompts?: string;
  skillNames?: string;
  /** 仅 "team" 落列（"agent"/缺省归一 undefined=不写列，T1 toRecord 口径） */
  expertType?: "team";
  /** TeamMember[] JSON 序列化（team 必带，经校验链保证） */
  members?: string;
  builtin: boolean;
  userId: number;
}

/** assistant.update 差量载荷（仅传入字段出现；数组列已 JSON 序列化，null=清空） */
interface ExpertUpdateData {
  icon?: string;
  systemPrompt?: string;
  description?: string;
  profession?: string;
  tags?: string;
  quickPrompts?: string;
  skillNames?: string | null;
  /** "team" 落列；null=转回单专家清列（连带清成员） */
  expertType?: "team" | null;
  /** TeamMember[] JSON 序列化（传即整体覆盖）；null=清空 */
  members?: string | null;
}

/** assistant 仓储结构子集（prisma.assistant 满足；测试注入 mock，plan-tools 先例） */
export interface ExpertPrismaLike {
  findFirst(args: {
    where: { name: string; userId: number };
  }): Promise<ExpertDbRow | null>;
  create(args: { data: ExpertCreateData }): Promise<{ id: number }>;
  update(args: {
    where: { id: number };
    data: ExpertUpdateData;
  }): Promise<unknown>;
}

/** 工具失败的统一文案（回喂模型，不抛出；与 file-tools 同口径） */
function fail(message: string): string {
  return `错误: ${message}`;
}

/**
 * skillNames 过滤（spec §2/§3）：非已安装技能名静默剔除，返回保留集与
 * 剔除集（结果文案提示用）；已安装清单为必填依赖（update 与 create 对齐，
 * 缺席即无从过滤）
 */
async function filterInstalledSkillNames(
  names: string[],
  listInstalled: () => Promise<string[]>,
): Promise<{ kept: string[]; dropped: string[] }> {
  const installed = new Set(await listInstalled());
  return {
    kept: names.filter((name) => installed.has(name)),
    dropped: names.filter((name) => !installed.has(name)),
  };
}

/** 剔除未安装技能的结果文案（渐进披露位：新技能先 create_skill 的
 *  指引原在工具描述里，T35 挪到此处） */
function droppedSkillNote(dropped: string[]): string {
  return `已忽略未安装技能：${dropped.join("、")}（新技能先用 create_skill 创建）`;
}

export function makeCreateExpertTool(deps: {
  prisma: ExpertPrismaLike;
  /** 已安装技能名清单：skillNames 过滤依据（skill.repo 装配注入） */
  listInstalledSkillNames: () => Promise<string[]>;
}): ToolDefinition<CreateExpertParams> {
  return {
    name: CREATE_EXPERT_TOOL_NAME,
    description: "创建自定义专家（落库后可在会话中选用）；写操作需批准",
    parameters: createSchema,
    kind: "write",
    execute: async (ctx: ToolContext, args) => {
      const check = validateCreateExpertParams(args);
      if (!check.ok) return fail(check.reason);
      const userId = ctx.userId;
      if (userId === undefined) {
        return fail("会话缺少用户归属，无法落库");
      }
      let skillNames: string | undefined;
      const notes: string[] = [];
      if (check.data.skillNames) {
        const { kept, dropped } = await filterInstalledSkillNames(
          check.data.skillNames,
          deps.listInstalledSkillNames,
        );
        if (kept.length > 0) {
          skillNames = JSON.stringify(kept);
        }
        if (dropped.length > 0) {
          notes.push(droppedSkillNote(dropped));
        }
      }
      await deps.prisma.create({
        data: {
          name: check.data.name,
          icon: check.data.icon,
          systemPrompt: check.data.systemPrompt,
          description: check.data.description,
          profession: check.data.profession,
          categoryId: undefined,
          tags: check.data.tags ? JSON.stringify(check.data.tags) : undefined,
          quickPrompts: check.data.quickPrompts
            ? JSON.stringify(check.data.quickPrompts)
            : undefined,
          skillNames,
          // 专家团落库：expertType 仅 "team" 写列（"agent"/缺省归一
          // undefined，与 T1 toRecord 口径一致）；members 经校验链（team
          // 必带 1-13 名）序列化落列
          expertType: check.data.expertType === "team" ? "team" : undefined,
          members: check.data.members
            ? JSON.stringify(check.data.members)
            : undefined,
          builtin: false,
          userId,
        },
      });
      const suffix = notes.length > 0 ? `（${notes.join("；")}）` : "";
      return `已创建专家 ${check.data.name}，可在「专家·技能·连接器」页管理，会话中即可选用${suffix}`;
    },
  };
}

export function makeUpdateExpertTool(deps: {
  prisma: ExpertPrismaLike;
  /** 已安装技能名清单：skillNames 过滤依据（skill.repo 装配注入） */
  listInstalledSkillNames: () => Promise<string[]>;
}): ToolDefinition<UpdateExpertParams> {
  return {
    name: UPDATE_EXPERT_TOOL_NAME,
    description:
      "修改指定名称的自定义专家（传入即覆盖，不可改名）；写操作需批准",
    parameters: updateSchema,
    kind: "write",
    execute: async (ctx: ToolContext, args) => {
      const check = validateUpdateExpertParams(args);
      if (!check.ok) return fail(check.reason);
      const userId = ctx.userId;
      if (userId === undefined) {
        return fail("会话缺少用户归属，无法落库");
      }
      const row = await deps.prisma.findFirst({
        where: { name: check.data.name, userId },
      });
      if (!row) {
        return fail(`未找到名为「${check.data.name}」的专家`);
      }
      const data: ExpertUpdateData = {};
      const notes: string[] = [];
      const fields = check.data;
      if (fields.icon !== undefined) data.icon = fields.icon;
      if (fields.systemPrompt !== undefined) {
        data.systemPrompt = fields.systemPrompt;
      }
      if (fields.description !== undefined) {
        data.description = fields.description;
      }
      if (fields.profession !== undefined) {
        data.profession = fields.profession;
      }
      if (fields.tags !== undefined) {
        data.tags = JSON.stringify(fields.tags);
      }
      if (fields.quickPrompts !== undefined) {
        data.quickPrompts = JSON.stringify(fields.quickPrompts);
      }
      if (fields.skillNames !== undefined) {
        const { kept, dropped } = await filterInstalledSkillNames(
          fields.skillNames,
          deps.listInstalledSkillNames,
        );
        // 全被剔除 = 清空该列（与 create 的「无则不设」不同：行已存在）
        data.skillNames = kept.length > 0 ? JSON.stringify(kept) : null;
        if (dropped.length > 0) {
          notes.push(droppedSkillNote(dropped));
        }
      }
      if (fields.expertType !== undefined) {
        if (fields.expertType === "team") {
          data.expertType = "team";
        } else {
          // 转回单专家：清 expertType 列并连带清成员（agent 不持成员）
          data.expertType = null;
          data.members = null;
        }
      }
      if (fields.members !== undefined) {
        // 传即整体覆盖（校验链已保证仅 team 载荷可带）
        data.members = JSON.stringify(fields.members);
      }
      if (Object.keys(data).length === 0) {
        return fail("未提供任何修改字段（name 仅用于定位）");
      }
      await deps.prisma.update({ where: { id: row.id }, data });
      const suffix = notes.length > 0 ? `（${notes.join("；")}）` : "";
      return `已更新专家 ${check.data.name}${suffix}`;
    },
  };
}
