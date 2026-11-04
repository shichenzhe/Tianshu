// A2 专家批（spec 2026-10-26 §1.2）：桌面被控面专家写面桥——detail/save/
// delete 走 AssistantRepository 单实例（Application 注入，严禁 face 侧二次
// 构造——构造函数注册全部 IPC handler）；市场两端点走 @tianshu/core 收编
// 静态数据（marketList 概要无 systemPrompt，marketDetail 按 slug 取全文）。
// systemPrompt/专家团是用户私有内容——归属校验后全量透出，不走掩码；
// 内置专家拒绝删除与改名（ASSISTANT_BUILTIN）。
// A2 尾：export/import 包 assistant.repo 纯函数（serializeExpert/
// parseExpertJson）与 importFromJson 内容面（重名 dedupeName/技能过滤/
// members 透传与桌面文件导入同语义）。
import {
  EXPERT_CATEGORIES,
  MARKET_EXPERTS,
  type ExpertMarketItem,
} from "@tianshu/core/expert-market";
import { parseExpertJson, serializeExpert } from "../ai/chat/assistant.repo";
import type {
  AssistantDetailResult,
  AssistantSavePayload,
  ExpertErrorCode,
  ExpertMarketDetail,
  ExpertMarketSummary,
  ExpertTeamMemberDto,
} from "@tianshu/protocol";
import type { AssistantRepository } from "../ai/chat/assistant.repo";
import type {
  AssistantCreateParams,
  AssistantRecord,
} from "../../../src-react/domains/ai/api/assistant.api";
import type { ServerFaceAssistants } from "./deps";

/** 专家面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FaceExpertError extends Error {
  readonly code: ExpertErrorCode;
  constructor(code: ExpertErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的仓储方法子集（AssistantRepository 满足） */
export type ExpertRepoSubset = Pick<
  AssistantRepository,
  "list" | "getOwned" | "create" | "update" | "delete" | "importFromJson"
>;

/** 仓储裸抛码/成员校验文案 → FaceExpertError 稳定码映射 */
function toFaceError(error: unknown): FaceExpertError {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "ASSISTANT_NOT_FOUND") {
    return new FaceExpertError("ASSISTANT_NOT_FOUND", "专家不存在");
  }
  if (message === "ASSISTANT_BUILTIN") {
    return new FaceExpertError("ASSISTANT_BUILTIN", "内置专家不支持此操作");
  }
  if (message.includes("专家团成员不合法")) {
    return new FaceExpertError("ASSISTANT_INVALID", message);
  }
  return new FaceExpertError("ASSISTANT_INVALID", message);
}

/** 仓储记录 → detail DTO（全量透出——用户自己的内容，无掩码） */
function toDetail(record: AssistantRecord): AssistantDetailResult {
  return {
    id: record.id,
    name: record.name,
    ...(record.icon !== undefined ? { icon: record.icon } : {}),
    systemPrompt: record.systemPrompt,
    ...(record.temperature !== undefined
      ? { temperature: record.temperature }
      : {}),
    ...(record.topP !== undefined ? { topP: record.topP } : {}),
    ...(record.maxTokens !== undefined ? { maxTokens: record.maxTokens } : {}),
    builtin: record.builtin,
    ...(record.description !== undefined
      ? { description: record.description }
      : {}),
    ...(record.tags !== undefined ? { tags: record.tags } : {}),
    ...(record.sourceSlug !== undefined
      ? { sourceSlug: record.sourceSlug }
      : {}),
    ...(record.profession !== undefined
      ? { profession: record.profession }
      : {}),
    ...(record.quickPrompts !== undefined
      ? { quickPrompts: record.quickPrompts }
      : {}),
    ...(record.categoryId !== undefined
      ? { categoryId: record.categoryId }
      : {}),
    ...(record.skillNames !== undefined
      ? { skillNames: record.skillNames }
      : {}),
    ...(record.expertType !== undefined
      ? { expertType: record.expertType }
      : {}),
    ...(record.members !== undefined
      ? { members: record.members as ExpertTeamMemberDto[] }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 市场条目 → 概要 DTO（不带 systemPrompt——不全量下发长 prompt）；
 *  排序三档字段（score/downloads/createdAt）直透，categoryTitleKey 经
 *  EXPERT_CATEGORIES 查表映射（未知分类缺省省略——导出纯函数供钉测） */
export function toMarketSummary(
  item: ExpertMarketItem,
  categories: ReadonlyArray<{
    key: string;
    labelKey: string;
  }> = EXPERT_CATEGORIES,
): ExpertMarketSummary {
  const category = categories.find((c) => c.key === item.category);
  return {
    slug: item.slug,
    name: item.name,
    description: item.description,
    profession: item.subtitle,
    tags: item.tags,
    categoryId: item.category,
    isTeam: item.type === "team",
    score: item.score,
    downloads: item.downloads,
    createdAt: item.createdAt,
    ...(category ? { categoryTitleKey: category.labelKey } : {}),
  };
}

/** 市场条目 → 单条全文 DTO（by slug；调参字段市场数据无此列，缺省省略） */
function toMarketDetail(item: ExpertMarketItem): ExpertMarketDetail {
  return {
    ...toMarketSummary(item),
    icon: item.icon,
    systemPrompt: item.systemPrompt,
    quickPrompts: item.quickPrompts,
    ...(item.skillNames !== undefined ? { skillNames: item.skillNames } : {}),
    ...(item.members !== undefined
      ? { members: item.members as ExpertTeamMemberDto[] }
      : {}),
  };
}

/** 归属校验读：不存在/他人所有同报 ASSISTANT_NOT_FOUND（不泄露存在性） */
async function mustOwned(
  repo: ExpertRepoSubset,
  id: number,
  userId: number,
): Promise<AssistantRecord> {
  const record = await repo.getOwned(id, userId);
  if (!record) {
    throw new FaceExpertError("ASSISTANT_NOT_FOUND", "专家不存在");
  }
  return record;
}

/** 新建载荷映射：team 透传 expertType/members，agent/null 归一缺省
 *  （repo 侧 "agent" 清 team 列语义仅对更新有意义，新建无列可清） */
function toCreateParams(payload: AssistantSavePayload): AssistantCreateParams {
  const base: AssistantCreateParams = {
    name: payload.name ?? "",
    systemPrompt: payload.systemPrompt ?? "",
    ...(payload.icon != null ? { icon: payload.icon } : {}),
    ...(payload.description != null
      ? { description: payload.description }
      : {}),
    ...(payload.tags != null ? { tags: payload.tags } : {}),
    ...(payload.profession != null ? { profession: payload.profession } : {}),
    ...(payload.quickPrompts != null
      ? { quickPrompts: payload.quickPrompts }
      : {}),
    ...(payload.categoryId != null ? { categoryId: payload.categoryId } : {}),
    ...(payload.skillNames != null ? { skillNames: payload.skillNames } : {}),
    ...(payload.sourceSlug != null ? { sourceSlug: payload.sourceSlug } : {}),
  };
  if (payload.expertType === "team") {
    return {
      ...base,
      expertType: "team",
      ...(payload.members ? { members: payload.members } : {}),
    };
  }
  return base;
}

export function createExpertsFace(
  repo: ExpertRepoSubset,
): ServerFaceAssistants {
  const save = async (
    userId: number,
    payload: AssistantSavePayload,
  ): Promise<AssistantDetailResult> => {
    try {
      if (payload.id != null) {
        const existing = await mustOwned(repo, payload.id, userId);
        // 内置专家拒绝改名（删除守卫在 repo.delete 同口径）
        if (
          existing.builtin &&
          payload.name !== undefined &&
          payload.name !== existing.name
        ) {
          throw new FaceExpertError("ASSISTANT_BUILTIN", "内置专家不支持改名");
        }
        const record = await repo.update(
          { ...payload, id: payload.id },
          userId,
        );
        return toDetail(record);
      }
      if (!payload.name || !payload.systemPrompt) {
        throw new FaceExpertError(
          "ASSISTANT_INVALID",
          "新建专家需要 name 与 systemPrompt",
        );
      }
      const record = await repo.create(toCreateParams(payload), userId);
      return toDetail(record);
    } catch (error) {
      if (error instanceof FaceExpertError) throw error;
      throw toFaceError(error);
    }
  };

  return {
    list: async (userId) =>
      (await repo.list(userId)).map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.description != null ? { description: a.description } : {}),
        ...(a.icon != null ? { icon: a.icon } : {}),
        ...(a.quickPrompts?.length ? { quickPrompts: a.quickPrompts } : {}),
      })),
    detail: async (userId, id) => toDetail(await mustOwned(repo, id, userId)),
    save,
    remove: async (userId, id) => {
      try {
        await repo.delete(id, userId);
      } catch (error) {
        throw toFaceError(error);
      }
    },
    // A2 尾：export 归属校验后序列化（builtin 同样可导——内容是用户可见的）；
    // 纯内容面零本机路径，JSON 文本直出（格式与桌面导出文件同构，2 空格缩进）
    export: async (userId, id) => {
      const record = await mustOwned(repo, id, userId);
      return { json: JSON.stringify(serializeExpert(record), null, 2) };
    },
    // A2 尾：import 服务端 parse 为权威（坏 JSON/缺 name/kind 不符 →
    // ASSISTANT_INVALID 带原因）；内容面走 repo.importFromJson——重名
    // dedupeName 后缀、skillNames 过滤已安装、members 随团 JSON 透传，
    // 与桌面文件导入同语义
    import: async (userId, payload) => {
      const parsed = parseExpertJson(payload.json);
      if (!parsed.ok) {
        throw new FaceExpertError("ASSISTANT_INVALID", parsed.reason);
      }
      try {
        const created = await repo.importFromJson(parsed.data, userId);
        return { id: created.id, name: created.name };
      } catch (error) {
        throw toFaceError(error);
      }
    },
    marketList: async () => MARKET_EXPERTS.map((e) => toMarketSummary(e)),
    marketDetail: async (slug) => {
      const item = MARKET_EXPERTS.find((e) => e.slug === slug);
      if (!item) {
        throw new FaceExpertError("EXPERT_MARKET_NOT_FOUND", "市场模板不存在");
      }
      return toMarketDetail(item);
    },
  };
}
