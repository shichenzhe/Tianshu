// 专家团成员编辑纯逻辑（移动端编辑面批）：行管理 reducer、提交前校验、
// buildPayload 团队字段三态——口径对齐桌面 electron/domains/ai/agent/
// create-expert.ts（TEAM_MEMBER_ID_RE/TEAM_MEMBERS_MAX/kebab 正则/团内唯一/
// name·profession 1-30/systemPrompt 1-20000）+ id ≤64（对齐 dispatch
// 参数上限；服务端 repo 仍为权威，前端报错仅提前拦截）。RN 无关，vitest
// 直测；桌面 AssistantDialog 差量语义（team→agent 显式 members:null 清列）
// 同形落地 applyTeamFields。
import type {
  AssistantSavePayload,
  ExpertTeamMemberDto,
} from "@tianshu/protocol";

export type ExpertType = "agent" | "team";

/** 成员编辑行（四字段全 string，与 ExpertTeamMemberDto 同形） */
export interface TeamMemberRow {
  id: string;
  name: string;
  profession: string;
  systemPrompt: string;
}

/** 成员 id 规范（对齐 TEAM_MEMBER_ID_RE）：kebab-case——小写字母/数字开头，
 *  其后小写字母/数字/连字符（如 risk-officer） */
export const TEAM_MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 专家团成员数上限（1-13 名，对齐 TEAM_MEMBERS_MAX） */
export const TEAM_MEMBERS_MAX = 13;

/** 成员 id 长度上限：对齐 dispatch 参数 member max 64（超长 id
 *  可落库却无法调度——读面不回溯校验，写面提前拦截） */
export const TEAM_MEMBER_ID_MAX = 64;

const NAME_MAX = 30;
const PROFESSION_MAX = 30;
const PROMPT_MAX = 20000;

/** 校验失败原因码（组件层映射 experts:teamError.<code> i18n 文案） */
export type TeamErrorCode =
  | "empty"
  | "tooMany"
  | "idEmpty"
  | "idFormat"
  | "idTooLong"
  | "idDuplicate"
  | "nameInvalid"
  | "professionInvalid"
  | "promptInvalid";

export type TeamValidation =
  | { ok: true; members: ExpertTeamMemberDto[] }
  | { ok: false; code: TeamErrorCode };

/** 新增成员行占位（四字段空串，满足 TeamMemberRow 全 string 形状） */
export function emptyMemberRow(): TeamMemberRow {
  return { id: "", name: "", profession: "", systemPrompt: "" };
}

/** 成员行 → 提交载荷：四字段逐一 trim（id 为调度键） */
export function trimMemberRows(rows: TeamMemberRow[]): ExpertTeamMemberDto[] {
  return rows.map((row) => ({
    id: row.id.trim(),
    name: row.name.trim(),
    profession: row.profession.trim(),
    systemPrompt: row.systemPrompt.trim(),
  }));
}

/** 团队提交前校验：trim 后空团队拒 → 条数上限 → 逐成员字段（id 非空/长度/
 *  kebab、花名/头衔 1-30、人设 1-20000）→ 团内 id 唯一；通过返回 trim 后的
 *  完整成员数组（提交即整体覆盖语义） */
export function validateTeamRows(rows: TeamMemberRow[]): TeamValidation {
  const members = trimMemberRows(rows);
  if (members.length === 0) return { ok: false, code: "empty" };
  if (members.length > TEAM_MEMBERS_MAX) return { ok: false, code: "tooMany" };
  const seen = new Set<string>();
  for (const member of members) {
    if (member.id === "") return { ok: false, code: "idEmpty" };
    if (member.id.length > TEAM_MEMBER_ID_MAX) {
      return { ok: false, code: "idTooLong" };
    }
    if (!TEAM_MEMBER_ID_RE.test(member.id)) {
      return { ok: false, code: "idFormat" };
    }
    if (member.name.length < 1 || member.name.length > NAME_MAX) {
      return { ok: false, code: "nameInvalid" };
    }
    if (
      member.profession.length < 1 ||
      member.profession.length > PROFESSION_MAX
    ) {
      return { ok: false, code: "professionInvalid" };
    }
    if (
      member.systemPrompt.length < 1 ||
      member.systemPrompt.length > PROMPT_MAX
    ) {
      return { ok: false, code: "promptInvalid" };
    }
    if (seen.has(member.id)) return { ok: false, code: "idDuplicate" };
    seen.add(member.id);
  }
  return { ok: true, members };
}

export type MemberRowsAction =
  | { type: "add" }
  | { type: "remove"; index: number }
  | { type: "update"; index: number; patch: Partial<TeamMemberRow> };

/** 成员行 reducer（组件 useReducer 数据源）：add 满员（13）不追加；remove
 *  按 index 滤除；update index 定位浅合并 patch（越界原样返回）——均不改
 *  原数组（RN 重渲染靠新引用） */
export function memberRowsReducer(
  rows: TeamMemberRow[],
  action: MemberRowsAction,
): TeamMemberRow[] {
  switch (action.type) {
    case "add":
      return rows.length >= TEAM_MEMBERS_MAX
        ? rows
        : [...rows, emptyMemberRow()];
    case "remove":
      return rows.filter((_, index) => index !== action.index);
    case "update":
      if (action.index < 0 || action.index >= rows.length) return rows;
      return rows.map((row, index) =>
        index === action.index ? { ...row, ...action.patch } : row,
      );
  }
}

/** buildPayload 团队字段三态（对齐桌面 AssistantDialog 差量语义，
 *  members 整数组覆盖：漏传保留旧值 / null 清列 / 数组覆盖）：
 *  - team 态：expertType:"team" + 完整 members（新建与编辑同）；
 *  - agent 新建态：两键省略（默认单专家语义，不传即保留——新建无旧值）；
 *  - agent 编辑态：显式 expertType:"agent"（team→agent 通道），原团队转
 *    单专家时 members:null 清列，原即单专家则 members 省略不动列 */
export function applyTeamFields(
  payload: AssistantSavePayload,
  options: {
    expertType: ExpertType;
    members: ExpertTeamMemberDto[];
    isNew: boolean;
    hadMembers: boolean;
  },
): void {
  if (options.expertType === "team") {
    payload.expertType = "team";
    payload.members = options.members;
    return;
  }
  if (options.isNew) return;
  payload.expertType = "agent";
  if (options.hadMembers) payload.members = null; // team→agent 清列
}
