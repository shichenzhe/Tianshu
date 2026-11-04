/**
 * 专家团（Team Assistant）领域类型、解析与主理人 system 组装（纯函数，
 * 零依赖直测）。TeamMember 为全链路唯一类型源（repo/api/市场数据均从此
 * 导入）。
 */

/** 专家团成员：id 为成员稳定标识（调度引用键），其余为展示与系统提示词 */
export interface TeamMember {
  id: string;
  name: string;
  profession: string;
  systemPrompt: string;
}

/**
 * 专家团成员列解析（assistant.members JSON 字符串）：坏 JSON/非数组回退
 * 空数组不抛错，元素缺任一必填字段剔除——与 expert-catalog 的
 * parseJsonStringArray 同为「JSON 数组字符串列防御性解析」，但后者只管
 * 字符串数组（tags/quickPrompts/skillNames），本函数管对象数组（成员需
 * 逐字段校验形状），故独立实现而非复用。
 */
export function parseTeamMembers(raw: string | null): TeamMember[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isTeamMember);
}

/** TeamMember 形状守卫：四个必填字段均为 string 才算合法成员 */
function isTeamMember(value: unknown): value is TeamMember {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.profession === "string" &&
    typeof v.systemPrompt === "string"
  );
}

/**
 * 【协作铁律】段（二期 spec）：四条主理人行为红线。第 2 条承载受控并行
 * 指引（含 dispatch 字样）——withDispatch=false 时本段整体缺席，
 * 故不会与缺席的工具段矛盾，成员清单仍在（展示语义）
 */
const TEAM_LEAD_RULES_HINT = [
  "【协作铁律】",
  "1. 严禁主理人代写成员产出：必须真实调度成员取得分析，不得虚构、替代或改写成员观点。",
  "2. 分阶段推进，上一阶段成员产出原文完整传入下一阶段调度的 context；同一阶段内无数据依赖的成员，应在同一次回复中并行调用 dispatch（为每位成员写独立的任务简报），全部回传后再进入下一阶段。",
  "3. 成员只对主理人回传结论：主理人统筹汇总后再形成面向用户的回答。",
  "4. 面向用户的输出使用用户的语言。",
].join("\n");

/** 【工具说明】段：dispatch 参数一句话语义 */
const TEAM_LEAD_TOOL_HINT = [
  "【工具说明】",
  "dispatch(member, task, context?)：调度一名团队成员独立分析并回传结论——member 为成员 id，task 为本轮任务，context 为可选的前序阶段产出原文。",
].join("\n");

/** 【团队成员】段：每行「- id｜花名（职业头衔）」+ 调度传 id 说明 */
function buildMemberListSection(members: TeamMember[]): string {
  return [
    "【团队成员】",
    "调度成员时传成员 id：",
    ...members.map((m) => `- ${m.id}｜${m.name}（${m.profession}）`),
  ].join("\n");
}

/**
 * 主理人 system 组装（专家团二期：绑定专家团会话的 base）：四段以空行
 * 拼接——主理人 prompt 原文 →【团队成员】清单 →【协作铁律】→【工具
 * 说明】；空 leadPrompt 跳过首段（不产生开头空行），空 members 返回
 * null（调用方回退裸 prompt）。withDispatch=false（dispatch 被
 * 安全中心禁用）时铁律段与工具说明不组装——system 与工具集同缺席，
 * 对齐第一期目录段门控模式；成员清单保留（展示语义）。
 */
export function buildTeamLeadSystem(params: {
  leadPrompt: string;
  members: TeamMember[];
  withDispatch?: boolean;
}): string | null {
  const { leadPrompt, members } = params;
  if (members.length === 0) {
    return null;
  }
  const lead = leadPrompt.trim();
  const sections = [
    ...(lead ? [lead] : []),
    buildMemberListSection(members),
    ...(params.withDispatch === false
      ? []
      : [TEAM_LEAD_RULES_HINT, TEAM_LEAD_TOOL_HINT]),
  ];
  return sections.join("\n\n");
}
