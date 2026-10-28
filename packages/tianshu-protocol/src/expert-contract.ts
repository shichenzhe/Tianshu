// packages/tianshu-protocol/src/expert-contract.ts
/** A2 批收编：专家完整记录/写面载荷/市场契约（单份权威源）。
 *  systemPrompt/专家团是用户私有内容——detail 面归属校验后全量透出，
 *  不走掩码编辑；内置专家删除/改名拒绝（ASSISTANT_BUILTIN）。 */

export interface ExpertTeamMemberDto {
  id: string;
  name: string;
  profession: string;
  systemPrompt: string;
}

/** 专家完整记录（assistant/detail 出参，镜像桌面 AssistantRecord） */
export interface AssistantDetailResult {
  id: number;
  name: string;
  icon?: string;
  systemPrompt: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  builtin: boolean;
  description?: string;
  tags?: string[];
  sourceSlug?: string;
  profession?: string;
  quickPrompts?: string[];
  categoryId?: string;
  skillNames?: string[];
  expertType?: "agent" | "team";
  members?: ExpertTeamMemberDto[];
  createdAt: string;
  updatedAt: string;
}

/** 单条 upsert：无 id 新建 / 有 id 更新；字段三态——undefined 保留、
 *  null 清空；不传 members/expertType 即保留原值（移动端无团编辑器，
 *  防丢保护）；expertType:"agent" 清 team 列语义由服务端沿用 */
export interface AssistantSavePayload {
  id?: number;
  name?: string;
  systemPrompt?: string;
  icon?: string | null;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  description?: string | null;
  tags?: string[] | null;
  profession?: string | null;
  quickPrompts?: string[] | null;
  categoryId?: string | null;
  skillNames?: string[] | null;
  /** 市场来源 slug：undefined 保留 / 值即设置（null 同 undefined——
   *  新建无来源可清，更新端如需清列走显式值覆盖） */
  sourceSlug?: string | null;
  expertType?: "agent" | "team" | null;
  members?: ExpertTeamMemberDto[] | null;
}

/** 市场概要项（assistant/marketList——不带 systemPrompt，不全量下发长 prompt） */
export interface ExpertMarketSummary {
  slug: string;
  name: string;
  description: string;
  profession: string;
  tags: string[];
  categoryId: string;
  /** 专家团模板标记（详情/添加时按团语义映射） */
  isTeam: boolean;
  /** 综合分（市场排序「综合」档，服务端直透） */
  score?: number;
  /** 下载量（市场排序「热门」档，服务端直透） */
  downloads?: number;
  /** 上架时间 ISO 字符串（市场排序「最新」档，服务端直透） */
  createdAt?: string;
  /** 分类名 i18n 键（经 EXPERT_CATEGORIES 查得，消费端本地化；
   *  未知分类缺省省略） */
  categoryTitleKey?: string;
}

/** 市场单条全文（assistant/marketDetail by slug——含 systemPrompt/调参） */
export interface ExpertMarketDetail extends ExpertMarketSummary {
  icon?: string;
  systemPrompt: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  quickPrompts?: string[];
  skillNames?: string[];
  members?: ExpertTeamMemberDto[];
}

/** assistant/export 出参：导出 JSON 文本（纯内容面——序列化剔除
 *  id/builtin/sourceSlug/时间戳，零本机路径） */
export interface ExpertExportResult {
  json: string;
}

/** assistant/import 入参：导出 JSON 文本透传（服务端 parseExpertJson
 *  校验——坏 JSON/缺 name/kind 不符 → ASSISTANT_INVALID；成员团 JSON
 *  含 members 时透传）；重名经 dedupeName 后缀 */
export interface ExpertImportPayload {
  json: string;
}

/** assistant/import 出参：新建记录概要（重名经 dedupeName 后缀后的
 *  实际落库名回传——控制端刷新列表/提示用） */
export interface ExpertImportResult {
  id: number;
  name: string;
}

export const EXPERT_ERROR_CODES = [
  "ASSISTANT_NOT_FOUND",
  "ASSISTANT_BUILTIN",
  "ASSISTANT_INVALID",
  "EXPERT_MARKET_NOT_FOUND",
] as const;
export type ExpertErrorCode = (typeof EXPERT_ERROR_CODES)[number];
